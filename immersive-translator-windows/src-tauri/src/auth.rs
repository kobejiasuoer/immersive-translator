//! 服务端账号认证：全部认证 HTTP 与令牌生命周期收在本模块（设计 D4）。
//!
//! 契约依据：
//! - `docs/windows-auth-design-2026-09-26.md` §7（IPC 契约表，命令名/字段唯一依据）
//! - `immersive-translator-server/docs/client-auth-integration.md` §4/§6/§7（红线）
//!
//! 红线落点：
//! 1. 令牌只进 DPAPI（secret_store.rs 单槽 `server_auth`，绝不落明文）；
//! 2. 刷新单飞：`futures_util::future::Shared` + 代数清槽（§4.2），并发 401 共享同一次刷新；
//! 3. 先持久化再重放（do_refresh 内 save 先于返回，重放用的是已落盘的新对）；
//! 4. 401 分支：仅 `token_expired` 触发刷新重放一次；`token_invalid`/`token_reused`/
//!    `unauthorized` 清凭据绝不再刷；
//! 5. 登出：服务端吊销尽力 + 本地清空；`store.clear()` 失败保持登录态并报
//!    `storage_error`（§5.3）。
//!
//! token 永不跨 IPC：命令只返回 `user`/登录态布尔/`notice` 失效原因。

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

// ---------------------------------------------------------------------------
// IPC 可见类型（§7；字段与前端 tauriBridge.ts 导出类型一字不差）
// ---------------------------------------------------------------------------

/// 统一错误。`code` 为服务端 `error.code` 原样透传，或本地伪码
/// `network_error` / `storage_error` / `parse_error` / `unknown`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthError {
    pub code: String,
    pub message: String,
    pub http_status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl AuthError {
    /// 本地伪码构造（网络/存储/解析类失败，无 HTTP 状态）。
    fn local(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            http_status: None,
            retry_after_seconds: None,
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AuthError {}

/// 账号资料（登录响应里的 `user` 同款；`nickname` 服务端可为 null）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub nickname: Option<String>,
    pub plan: String,
    pub created_at: String,
}

/// 登录/刷新成功只回 user，不含任何令牌（D4）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub user: AuthUser,
}

/// 失效原因（D8）：持久渲染在账号 tab 顶部状态条，登录成功即清除。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthNotice {
    SessionExpired,
    SessionKicked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user: Option<AuthUser>,
    pub notice: Option<AuthNotice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutOutcome {
    pub server_revoked: bool,
}

// ---------------------------------------------------------------------------
// 可注入的传输层（红线可测试性的落点，§4.1）
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct AuthHttpRequest {
    pub method: reqwest::Method,
    pub path: String,
    pub body: Option<String>,
    pub bearer: Option<String>,
}

#[derive(Debug)]
pub struct AuthHttpResponse {
    pub status: u16,
    pub retry_after_seconds: Option<u64>,
    pub body: String,
}

/// 返回 `BoxFuture<'static>`（而非 trait 内 `async fn`）：单飞刷新要求 future
/// 满足 `'static`（§4.2），且 `Box<dyn AuthTransport>` 需要_dyn 兼容_签名；
/// 实现方把所需状态（reqwest Client / 测试桩的 Arc）克隆进 future。
pub trait AuthTransport: Send + Sync {
    fn send(&self, req: AuthHttpRequest)
        -> BoxFuture<'static, Result<AuthHttpResponse, AuthError>>;
    /// 服务端 base URL（§4.6 两层机制解析结果）；沉浸云 gateway endpoint 由它派生。
    /// 测试桩等不关心 base 的实现用缺省 None。
    fn base_url(&self) -> Option<String> {
        None
    }
}

/// dev/联调缺省（§4.6 第 2 层）；生产由 `app_data_dir/server_endpoint.json` 覆盖。
const DEV_BASE_URL: &str = "http://127.0.0.1:8090";

struct ReqwestTransport {
    base_url: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointOverride {
    base_url: String,
}

impl ReqwestTransport {
    fn new(base_url: String) -> Result<Self, AuthError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AuthError::local("unknown", format!("构建 HTTP 客户端失败: {e}")))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
        })
    }

    /// §4.6 base_url 两层机制：`app_data_dir/server_endpoint.json`
    /// （`{"baseUrl":"https://..."}`，明文非敏感）存在则覆盖 dev 缺省。
    fn resolve_base_url(app: &AppHandle) -> String {
        let from_file = app.path().app_data_dir().ok().and_then(|dir| {
            std::fs::read_to_string(dir.join("server_endpoint.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<EndpointOverride>(&text).ok())
                .map(|e| e.base_url)
        });
        from_file
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| DEV_BASE_URL.to_string())
    }
}

impl AuthTransport for ReqwestTransport {
    fn base_url(&self) -> Option<String> {
        Some(self.base_url.clone())
    }

    fn send(
        &self,
        req: AuthHttpRequest,
    ) -> BoxFuture<'static, Result<AuthHttpResponse, AuthError>> {
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        async move {
            let mut builder = client.request(req.method, format!("{base_url}{}", req.path));
            if let Some(token) = req.bearer {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            if let Some(body) = req.body {
                builder = builder
                    .header("content-type", "application/json")
                    .body(body);
            }
            let response = builder
                .send()
                .await
                .map_err(|e| AuthError::local("network_error", format!("网络请求失败: {e}")))?;
            let status = response.status().as_u16();
            let retry_after_seconds = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let body = response
                .text()
                .await
                .map_err(|e| AuthError::local("network_error", format!("读取响应失败: {e}")))?;
            Ok(AuthHttpResponse {
                status,
                retry_after_seconds,
                body,
            })
        }
        .boxed()
    }
}

// ---------------------------------------------------------------------------
// 可注入的持久层（DPAPI 单槽，§5）
// ---------------------------------------------------------------------------

pub trait TokenStore: Send + Sync {
    /// DPAPI 槽 `server_auth`（经 SECRETS_IO_MUTEX 串行化）。
    fn save(&self, auth: &StoredAuth) -> Result<(), AuthError>;
    fn load(&self) -> Option<StoredAuth>;
    /// 可失败（§5.3）：登出路径对其有明确定义。
    fn clear(&self) -> Result<(), AuthError>;
}

/// 双令牌单槽 JSON（D5）：单次写入保证 accessToken/refreshToken/user 配套。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAuth {
    pub access_token: String,
    pub refresh_token: String,
    /// unix 秒（唯一时间字段；主动刷新阈值只用它，D6/P7）。
    pub access_expires_at: i64,
    pub user: AuthUser,
}

/// DPAPI 槽名（保留名，经 secret_store::AUTH_SLOT 与通用命令隔离，见其注释）。
const AUTH_SLOT: &str = crate::secret_store::AUTH_SLOT;

/// DPAPI 存储：复用 secret_store.rs 的加密与文件格式（raw 入口 + 写锁）。
struct DpapiTokenStore {
    app: AppHandle,
}

impl DpapiTokenStore {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn slot_path(&self) -> Result<std::path::PathBuf, AuthError> {
        crate::secret_store::secrets_path(&self.app)
            .map_err(|e| AuthError::local("storage_error", e))
    }
}

impl TokenStore for DpapiTokenStore {
    fn save(&self, auth: &StoredAuth) -> Result<(), AuthError> {
        let path = self.slot_path()?;
        let json = serde_json::to_string(auth)
            .map_err(|e| AuthError::local("storage_error", format!("序列化凭据失败: {e}")))?;
        crate::secret_store::secrets_set_raw(&path, AUTH_SLOT, &json)
            .map_err(|e| AuthError::local("storage_error", e))
    }

    fn load(&self) -> Option<StoredAuth> {
        let path = match self.slot_path() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[auth] 定位 secrets.json 失败: {e}");
                return None;
            }
        };
        match crate::secret_store::secrets_get_raw(&path, AUTH_SLOT) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_else(|e| {
                // 槽内数据解析失败（格式漂移等）：按无凭据处理并留日志。
                eprintln!("[auth] 解析 server_auth 槽失败（视为未登录）: {e}");
                None
            }),
            Ok(None) => None,
            Err(e) => {
                eprintln!("[auth] 读取 server_auth 槽失败（视为未登录）: {e}");
                None
            }
        }
    }

    fn clear(&self) -> Result<(), AuthError> {
        let path = self.slot_path()?;
        crate::secret_store::secrets_clear_raw(&path, AUTH_SLOT)
            .map_err(|e| AuthError::local("storage_error", e))
    }
}

// ---------------------------------------------------------------------------
// 响应解析（服务端错误形状：{"error":{code,message,details?}}）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: ErrorBodyInner,
}

#[derive(Debug, Deserialize)]
struct ErrorBodyInner {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: AuthUser,
}

/// 非 2xx → AuthError（`error.code` 原样透传；解析失败映射本地伪码 parse_error）。
fn error_from_response(resp: &AuthHttpResponse) -> AuthError {
    match serde_json::from_str::<ErrorBody>(&resp.body) {
        Ok(parsed) => AuthError {
            code: parsed.error.code,
            message: parsed.error.message,
            http_status: Some(resp.status),
            retry_after_seconds: resp.retry_after_seconds,
        },
        Err(e) => AuthError {
            code: "parse_error".to_string(),
            message: format!("服务响应异常(HTTP {}): {e}", resp.status),
            http_status: Some(resp.status),
            retry_after_seconds: resp.retry_after_seconds,
        },
    }
}

fn parse_login_response(body: &str) -> Result<LoginResponse, AuthError> {
    serde_json::from_str(body)
        .map_err(|e| AuthError::local("parse_error", format!("解析登录响应失败: {e}")))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 刷新上下文下的致命三码（凭据已被清除；§7 表「fatal 三码」）。
fn is_fatal_code(code: &str) -> bool {
    matches!(code, "token_expired" | "token_invalid" | "token_reused")
}

/// 401 致命码 → notice（D8）：reused 全设备下线单列，其余归会话过期。
fn notice_for_code(code: &str) -> Option<AuthNotice> {
    match code {
        "token_reused" => Some(AuthNotice::SessionKicked),
        "token_invalid" | "token_expired" => Some(AuthNotice::SessionExpired),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// TokenManager：单飞刷新 + 401 分支 + 持久化时序 + 预填契约（§4）
// ---------------------------------------------------------------------------

/// 惰性主动刷新阈值（D6）：`now + 180 >= access_expires_at` 即刷。
pub const REFRESH_MARGIN_SECS: i64 = 180;

type RefreshOutcome = Result<Arc<StoredAuth>, Arc<AuthError>>;
/// Shared future 是多消费者句柄：任意多个调用者 clone 后各自 await，
/// 拿到同一份缓存结果，无消费语义、无 RecvError（§4.2 / P1）。
type SharedRefresh = Shared<BoxFuture<'static, RefreshOutcome>>;

pub struct TokenManager {
    transport: Arc<dyn AuthTransport>,
    store: Arc<dyn TokenStore>,
    /// 内存权威态（启动预填，§4.4）。
    state: AsyncMutex<Option<StoredAuth>>,
    /// 单飞槽：(代数, 共享 future)。
    inflight: AsyncMutex<Option<(u64, SharedRefresh)>>,
    next_gen: AtomicU64,
    /// 最近一次致命失效原因（get_status/事件携带；登录成功清除）。
    notice: StdMutex<Option<AuthNotice>>,
}

impl TokenManager {
    pub fn new(transport: Arc<dyn AuthTransport>, store: Arc<dyn TokenStore>) -> Self {
        Self {
            transport,
            store,
            state: AsyncMutex::new(None),
            inflight: AsyncMutex::new(None),
            next_gen: AtomicU64::new(0),
            notice: StdMutex::new(None),
        }
    }

    /// 单飞入口：同一时刻至多一个 `/v1/auth/refresh` 在途；
    /// 并发调用共享同一次结果（§4.2）。
    pub async fn refresh(self: &Arc<Self>) -> RefreshOutcome {
        self.refresh_inner(None).await
    }

    /// 401(token_expired)后的单飞刷新（§4.3 红线 2）。与 `refresh` 共用同一
    /// 在途槽，另做「旧票比对」：到达时若槽已空、且内存态 accessToken 已不是
    /// 发请求用的那张（并发刷新恰好完成并清了槽），直接复用新凭据——补上
    /// 「完成方清槽之后、迟到 401 处理者登记之前」的窗口，绝不因此多发
    /// 第二次刷新。新凭据必已落盘（do_refresh 先 save 再写内存态，红线 3）。
    pub async fn refresh_after_401(self: &Arc<Self>, used_token: &str) -> RefreshOutcome {
        self.refresh_inner(Some(used_token)).await
    }

    async fn refresh_inner(self: &Arc<Self>, stale_token: Option<&str>) -> RefreshOutcome {
        let (gen, shared) = {
            let mut slot = self.inflight.lock().await;
            if let Some((gen, existing)) = slot.as_ref() {
                // ① 在途：clone 共享句柄（不消费），等同一结果
                (*gen, existing.clone())
            } else {
                // ② 空槽。401 路径先比票：票已换新说明刚有并发刷新完成，
                //    迟到的 401 搭车新凭据即可。锁序恒为 inflight → state
                //    （do_refresh 仅短暂持 state，无反向嵌套，不会死锁）。
                if let Some(used) = stale_token {
                    let state = self.state.lock().await;
                    if let Some(s) = state.as_ref() {
                        if s.access_token != used {
                            return Ok(Arc::new(s.clone()));
                        }
                    }
                }
                // ③ 空槽且票未换：本调用者发起。do_refresh 以 Arc 克隆捕获（'static 注记）。
                let gen = self.next_gen.fetch_add(1, Ordering::Relaxed);
                let this = Arc::clone(self);
                let fut: SharedRefresh = async move { this.do_refresh().await }.boxed().shared();
                *slot = Some((gen, fut.clone()));
                (gen, fut)
            }
        };
        // ④ 所有调用者 await 各自 clone → 同一结果
        let outcome = shared.await;
        // ⑤ 完成方清槽：仅当槽内仍是本代数（新一代刷新不受影响）
        let mut slot = self.inflight.lock().await;
        if matches!(*slot, Some((cur, _)) if cur == gen) {
            *slot = None;
        }
        outcome
    }

    /// 真正的刷新（每个代数至多执行一次）。
    async fn do_refresh(self: Arc<Self>) -> RefreshOutcome {
        let refresh_token = {
            let state = self.state.lock().await;
            match state.as_ref() {
                Some(s) => Some(s.refresh_token.clone()),
                None => self.store.load().map(|s| s.refresh_token),
            }
        };
        let Some(refresh_token) = refresh_token else {
            return Err(Arc::new(AuthError::local("unauthorized", "未登录")));
        };
        let body = serde_json::json!({ "refreshToken": refresh_token }).to_string();
        let resp = match self
            .transport
            .send(AuthHttpRequest {
                method: reqwest::Method::POST,
                path: "/v1/auth/refresh".into(),
                body: Some(body),
                bearer: None,
            })
            .await
        {
            Ok(r) => r,
            // 网络等瞬时错误：不清凭据（§4.4 离线契约）
            Err(e) => return Err(Arc::new(e)),
        };
        if resp.status == 200 {
            let pair = match parse_login_response(&resp.body) {
                Ok(p) => p,
                Err(e) => return Err(Arc::new(e)),
            };
            let stored = StoredAuth {
                access_token: pair.access_token,
                refresh_token: pair.refresh_token,
                access_expires_at: now_unix() + pair.expires_in,
                user: pair.user,
            };
            // 红线 3：先落盘（经 §5.2 写锁），再更新内存态/供重放。
            if let Err(e) = self.store.save(&stored) {
                return Err(Arc::new(e));
            }
            *self.state.lock().await = Some(stored.clone());
            Ok(Arc::new(stored))
        } else if resp.status == 401 {
            let err = error_from_response(&resp);
            // fatal 三码 → 清凭据（红线 4/5）；其余 401 原样透传。
            if is_fatal_code(&err.code) {
                self.clear_credentials(notice_for_code(&err.code)).await;
            }
            Err(Arc::new(err))
        } else {
            Err(Arc::new(error_from_response(&resp)))
        }
    }

    /// 清凭据：store.clear 尽力（失败仅日志——凭据已被服务端作废，残留无
    /// 增量风险）+ 内存态清空 + 记 notice。
    async fn clear_credentials(&self, notice: Option<AuthNotice>) {
        if let Err(e) = self.store.clear() {
            eprintln!("[auth] 清除本地凭据失败（凭据已被服务端作废）: {e}");
        }
        *self.state.lock().await = None;
        *self.notice.lock().unwrap() = notice;
    }

    /// 取可用 accessToken：无凭据报未登录；剩余寿命 ≤ REFRESH_MARGIN_SECS
    /// 时先走一次单飞刷新（D6 绝对阈值）。主动刷新失败时：致命码上抛
    /// （凭据已清），瞬时错误用旧票继续——401 token_expired 兜底永在（R4）。
    /// pub：沉浸云翻译/连通性探测共用同一取票口（单飞语义不旁路）。
    pub async fn get_access_token(self: &Arc<Self>) -> Result<String, AuthError> {
        let (token, expires_at) = {
            let mut state = self.state.lock().await;
            if state.is_none() {
                if let Some(stored) = self.store.load() {
                    *state = Some(stored);
                }
            }
            match state.as_ref() {
                Some(s) => (s.access_token.clone(), s.access_expires_at),
                None => return Err(AuthError::local("unauthorized", "未登录")),
            }
        };
        if now_unix() + REFRESH_MARGIN_SECS >= expires_at {
            match self.refresh().await {
                Ok(stored) => return Ok(stored.access_token.clone()),
                Err(e) if is_fatal_code(&e.code) => return Err((*e).clone()),
                Err(_) => {}
            }
        }
        Ok(token)
    }

    /// 带鉴权请求（§4.3，红线 4）：惰性主动刷新 → 发送 → 401 分支。
    pub async fn with_auth(
        self: &Arc<Self>,
        method: reqwest::Method,
        path: &str,
        body: Option<String>,
    ) -> Result<AuthHttpResponse, AuthError> {
        let token = self.get_access_token().await?;
        let send = |token: String| {
            self.transport.send(AuthHttpRequest {
                method: method.clone(),
                path: path.to_string(),
                body: body.clone(),
                bearer: Some(token),
            })
        };
        let first = send(token.clone()).await?;
        if first.status != 401 {
            return Ok(first);
        }
        let err = error_from_response(&first);
        match err.code.as_str() {
            // 仅 token_expired 触发刷新（红线 4）；带旧票进单飞，迟到 401
            // 若逢并发刷新已完成则直接复用新凭据（红线 2 单飞无窗口）。
            "token_expired" => {
                let stored = self
                    .refresh_after_401(&token)
                    .await
                    .map_err(|e| (*e).clone())?;
                let replay = send(stored.access_token.clone()).await?;
                if replay.status == 401 {
                    // 重放仍 401：会话已死，清凭据并按新 code 处理
                    let replay_err = error_from_response(&replay);
                    self.clear_credentials(notice_for_code(&replay_err.code))
                        .await;
                    return Err(replay_err);
                }
                Ok(replay)
            }
            // invalid/reused/unauthorized：清凭据，绝不再刷（红线 4）
            "token_invalid" | "token_reused" | "unauthorized" => {
                self.clear_credentials(notice_for_code(&err.code)).await;
                Err(err)
            }
            // 未知 401 code：原样透传，不清凭据不刷新
            _ => Err(err),
        }
    }

    /// POST /v1/auth/otp/request（§7-1）。服务端恒 200（防枚举），不据此判断账号存在。
    pub async fn send_otp(&self, email: &str) -> Result<(), AuthError> {
        let resp = self
            .transport
            .send(AuthHttpRequest {
                method: reqwest::Method::POST,
                path: "/v1/auth/otp/request".into(),
                body: Some(serde_json::json!({ "email": email }).to_string()),
                bearer: None,
            })
            .await?;
        if (200..300).contains(&resp.status) {
            Ok(())
        } else {
            Err(error_from_response(&resp))
        }
    }

    /// POST /v1/auth/otp/verify（§7-2）。device 由 Rust 填，前端不传。
    pub async fn verify_otp(
        self: &Arc<Self>,
        email: &str,
        code: &str,
    ) -> Result<AuthSession, AuthError> {
        let body = serde_json::json!({
            "email": email,
            "code": code,
            "device": device_payload(),
        });
        self.login_common("/v1/auth/otp/verify", body).await
    }

    /// POST /v1/auth/login（§7-3）。device 同上。
    pub async fn login_password(
        self: &Arc<Self>,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, AuthError> {
        let body = serde_json::json!({
            "email": email,
            "password": password,
            "device": device_payload(),
        });
        self.login_common("/v1/auth/login", body).await
    }

    /// 登录成功路径（两条登录命令共用）：先 store.save 落盘（红线 1/3，
    /// 落不了盘不允许「登录成功」，§3 storage_error）→ 更新内存态 → 清 notice。
    async fn login_common(
        self: &Arc<Self>,
        path: &str,
        body: serde_json::Value,
    ) -> Result<AuthSession, AuthError> {
        let resp = self
            .transport
            .send(AuthHttpRequest {
                method: reqwest::Method::POST,
                path: path.into(),
                body: Some(body.to_string()),
                bearer: None,
            })
            .await?;
        if !(200..300).contains(&resp.status) {
            return Err(error_from_response(&resp));
        }
        let pair = parse_login_response(&resp.body)?;
        let stored = StoredAuth {
            access_token: pair.access_token,
            refresh_token: pair.refresh_token,
            access_expires_at: now_unix() + pair.expires_in,
            user: pair.user,
        };
        self.store.save(&stored)?;
        *self.state.lock().await = Some(stored.clone());
        // 登录成功即清除 notice（D8）
        *self.notice.lock().unwrap() = None;
        Ok(AuthSession {
            user: stored.user.clone(),
        })
    }

    /// 登出（§7-4/§5.3）：服务端吊销尽力（失败吞为 serverRevoked:false）→
    /// `store.clear()` 失败重试一次，仍失败返回 storage_error 且保持登录态、
    /// 不广播登出；clear 成功才清内存态。幂等可重入（未登录直接成功）。
    pub async fn logout(self: &Arc<Self>) -> Result<LogoutOutcome, AuthError> {
        let access = {
            let mut state = self.state.lock().await;
            if state.is_none() {
                if let Some(stored) = self.store.load() {
                    *state = Some(stored);
                }
            }
            state.as_ref().map(|s| s.access_token.clone())
        };
        let Some(access) = access else {
            return Ok(LogoutOutcome {
                server_revoked: false,
            });
        };
        let revoked = match self
            .transport
            .send(AuthHttpRequest {
                method: reqwest::Method::POST,
                path: "/v1/auth/logout".into(),
                body: None,
                bearer: Some(access),
            })
            .await
        {
            Ok(resp) if (200..300).contains(&resp.status) => true,
            // 服务端错误（含网络失败）尽力而为：本地照常清理
            Ok(_) | Err(_) => false,
        };
        if let Err(first) = self.store.clear() {
            if let Err(second) = self.store.clear() {
                return Err(AuthError::local(
                    "storage_error",
                    format!("清除本地凭据失败（已重试）: {first}; {second}"),
                ));
            }
        }
        *self.state.lock().await = None;
        *self.notice.lock().unwrap() = None;
        Ok(LogoutOutcome {
            server_revoked: revoked,
        })
    }

    /// 登录态判据全程序唯一（§4.4）：内存态优先，空则回读 store 并预填。
    pub async fn get_status(&self) -> AuthStatus {
        let mut state = self.state.lock().await;
        if state.is_none() {
            if let Some(stored) = self.store.load() {
                *state = Some(stored);
            }
        }
        AuthStatus {
            logged_in: state.is_some(),
            user: state.as_ref().map(|s| s.user.clone()),
            notice: self.notice.lock().unwrap().clone(),
        }
    }

    /// 启动预填（§4.4 ①）：磁盘有 30 天 refresh 即视为已登录（离线也显示
    /// 已登录），返回 user 供调用方先广播、再异步校验存活。
    pub async fn prefill_from_store(&self) -> Option<AuthUser> {
        let mut state = self.state.lock().await;
        if state.is_none() {
            *state = self.store.load();
        }
        state.as_ref().map(|s| s.user.clone())
    }

    /// GET /v1/me（§7-7，带鉴权请求样板：可触发单飞刷新与重放）。
    pub async fn fetch_me(self: &Arc<Self>) -> Result<AuthUser, AuthError> {
        let resp = self.with_auth(reqwest::Method::GET, "/v1/me", None).await?;
        if !(200..300).contains(&resp.status) {
            return Err(error_from_response(&resp));
        }
        serde_json::from_str(&resp.body)
            .map_err(|e| AuthError::local("parse_error", format!("解析用户资料失败: {e}")))
    }

    /// GET /v1/me/config（§7-8）：原样取回，不解析消费（M2 再用）。
    pub async fn fetch_server_config(self: &Arc<Self>) -> Result<serde_json::Value, AuthError> {
        let resp = self
            .with_auth(reqwest::Method::GET, "/v1/me/config", None)
            .await?;
        if !(200..300).contains(&resp.status) {
            return Err(error_from_response(&resp));
        }
        serde_json::from_str(&resp.body)
            .map_err(|e| AuthError::local("parse_error", format!("解析 me/config 失败: {e}")))
    }

    /// 沉浸云 gateway endpoint（OpenAI 兼容别名 `/v1/chat/completions`）。
    /// 由 transport 的 base_url 派生；测试桩等无 base 实现返回 None。
    pub fn gateway_endpoint(&self) -> Option<String> {
        self.transport
            .base_url()
            .map(|b| format!("{}/v1/chat/completions", b.trim_end_matches('/')))
    }
}

/// §7-2：device 由 Rust 填 `{platform:"windows", name: COMPUTERNAME 截 64
/// 字符, fallback "Windows-PC"}`，前端不传。
fn device_payload() -> serde_json::Value {
    let name = std::env::var("COMPUTERNAME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Windows-PC".to_string());
    let name: String = name.chars().take(64).collect();
    serde_json::json!({ "platform": "windows", "name": name })
}

// ---------------------------------------------------------------------------
// 命令层（§7 表 1-8；事件广播在此完成，TokenManager 不持有 AppHandle）
// ---------------------------------------------------------------------------

/// 构造生产用 TokenManager（ReqwestTransport + DpapiTokenStore）。
/// base_url 经 §4.6 两层机制解析。需在 setup（有 AppHandle）里 manage。
pub(crate) fn build_token_manager(app: &AppHandle) -> Result<Arc<TokenManager>, AuthError> {
    let transport = ReqwestTransport::new(ReqwestTransport::resolve_base_url(app))?;
    let store = DpapiTokenStore::new(app.clone());
    Ok(Arc::new(TokenManager::new(
        Arc::new(transport),
        Arc::new(store),
    )))
}

fn emit_auth_state(app: &AppHandle, status: &AuthStatus) {
    if let Err(e) = app.emit("auth-state-changed", status) {
        eprintln!("[auth] 广播登录态失败: {e}");
    }
}

/// 命令层公共收尾：致命错误（凭据已清）时广播失效态，前端状态条据此显示。
fn emit_fatal_if_needed(app: &AppHandle, err: &AuthError) {
    if let Some(notice) = notice_for_code(&err.code) {
        emit_auth_state(
            app,
            &AuthStatus {
                logged_in: false,
                user: None,
                notice: Some(notice),
            },
        );
    }
}

/// 登录成功命令的公共收尾：广播登录态 + fire-and-forget 拉取 me/config
/// （D7：失败仅 log，账号区可手动重拉）。
fn after_login_success(app: &AppHandle, manager: &Arc<TokenManager>, user: &AuthUser) {
    emit_auth_state(
        app,
        &AuthStatus {
            logged_in: true,
            user: Some(user.clone()),
            notice: None,
        },
    );
    let app = app.clone();
    let manager = Arc::clone(manager);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = fetch_server_config_and_persist(&app, &manager).await {
            eprintln!("[auth] 拉取 me/config 失败（不阻塞登录）: {e}");
        }
    });
}

/// GET /v1/me/config + 落盘 `app_data_dir/server_config.json`（明文，非敏感）。
async fn fetch_server_config_and_persist(
    app: &AppHandle,
    manager: &Arc<TokenManager>,
) -> Result<serde_json::Value, AuthError> {
    let value = manager.fetch_server_config().await?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AuthError::local("storage_error", format!("无法获取应用数据目录: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AuthError::local("storage_error", format!("无法创建数据目录: {e}")))?;
    let text = serde_json::to_string_pretty(&value)
        .map_err(|e| AuthError::local("storage_error", format!("序列化 me/config 失败: {e}")))?;
    std::fs::write(dir.join("server_config.json"), text).map_err(|e| {
        AuthError::local(
            "storage_error",
            format!("写入 server_config.json 失败: {e}"),
        )
    })?;
    Ok(value)
}

#[tauri::command]
pub async fn auth_send_otp(
    manager: tauri::State<'_, Arc<TokenManager>>,
    email: String,
) -> Result<(), AuthError> {
    manager.send_otp(email.trim()).await
}

#[tauri::command]
pub async fn auth_verify_otp(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
    email: String,
    code: String,
) -> Result<AuthSession, AuthError> {
    let session = manager.verify_otp(email.trim(), code.trim()).await?;
    after_login_success(&app, manager.inner(), &session.user);
    Ok(session)
}

#[tauri::command]
pub async fn auth_login_password(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
    email: String,
    password: String,
) -> Result<AuthSession, AuthError> {
    let session = manager.login_password(email.trim(), &password).await?;
    after_login_success(&app, manager.inner(), &session.user);
    Ok(session)
}

#[tauri::command]
pub async fn auth_logout(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
) -> Result<LogoutOutcome, AuthError> {
    let outcome = manager.logout().await?;
    // 走到这里 clear 必已成功（§5.3：失败路径直接 Err，不广播）。
    emit_auth_state(
        &app,
        &AuthStatus {
            logged_in: false,
            user: None,
            notice: None,
        },
    );
    Ok(outcome)
}

/// 契约：不会 Err（返回 Result 仅为满足 Tauri 对带引用入参的 async 命令
/// 的要求；Err 分支不可达）。
#[tauri::command]
pub async fn auth_get_status(
    manager: tauri::State<'_, Arc<TokenManager>>,
) -> Result<AuthStatus, AuthError> {
    Ok(manager.get_status().await)
}

#[tauri::command]
pub async fn auth_refresh_now(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
) -> Result<AuthSession, AuthError> {
    match manager.refresh().await {
        Ok(stored) => {
            emit_auth_state(
                &app,
                &AuthStatus {
                    logged_in: true,
                    user: Some(stored.user.clone()),
                    notice: None,
                },
            );
            Ok(AuthSession {
                user: stored.user.clone(),
            })
        }
        Err(e) => {
            let err = (*e).clone();
            emit_fatal_if_needed(&app, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn auth_fetch_me(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
) -> Result<AuthUser, AuthError> {
    match manager.fetch_me().await {
        Ok(user) => Ok(user),
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn auth_fetch_server_config(
    app: AppHandle,
    manager: tauri::State<'_, Arc<TokenManager>>,
) -> Result<serde_json::Value, AuthError> {
    match fetch_server_config_and_persist(&app, manager.inner()).await {
        Ok(value) => Ok(value),
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}

/// 服务端 base URL（§4.6 两层机制：server_endpoint.json 覆盖 dev 缺省）。
/// 前端设置页用它拼沉浸云 gateway endpoint（展示 + 预设匹配），只读非敏感。
#[tauri::command]
pub fn auth_server_base_url(app: AppHandle) -> String {
    ReqwestTransport::resolve_base_url(&app)
}

/// 启动静默续登录（§4.4）：预填内存态 → emit 已登录（离线也显示已登录）
/// → 后台单飞刷新校验存活；fatal 才转未登录。由 lib.rs setup 末尾 spawn。
pub(crate) async fn auth_bootstrap(app: AppHandle, manager: Arc<TokenManager>) {
    // 无凭据：无事发生
    let Some(user) = manager.prefill_from_store().await else {
        return;
    };
    emit_auth_state(
        &app,
        &AuthStatus {
            logged_in: true,
            user: Some(user),
            notice: None,
        },
    );
    match manager.refresh().await {
        Ok(stored) => {
            emit_auth_state(
                &app,
                &AuthStatus {
                    logged_in: true,
                    user: Some(stored.user.clone()),
                    notice: None,
                },
            );
        }
        Err(e) if is_fatal_code(&e.code) => {
            // 凭据已在 §4.2 清除；广播失效态（D8 状态条载体）
            emit_auth_state(
                &app,
                &AuthStatus {
                    logged_in: false,
                    user: None,
                    notice: notice_for_code(&e.code),
                },
            );
        }
        // 网络等瞬时错误：保留预填态，不回退 UI（§4.4 ③）
        Err(_) => {}
    }
}

// ---------------------------------------------------------------------------
// 单元测试（§9.2；FakeTransport + FakeTokenStore，不起网络/不碰 DPAPI）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 一次到达 transport 的请求（带全局序号，供「先落盘再重放」类时序断言）。
    /// 序号由 FakeTransport 与 FakeTokenStore 共享同一计数器分配。
    #[derive(Debug, Clone)]
    struct ReceivedRequest {
        seq: u64,
        method: String,
        path: String,
        bearer: Option<String>,
        body: Option<String>,
    }

    type Responder =
        Box<dyn Fn(&AuthHttpRequest) -> Result<AuthHttpResponse, AuthError> + Send + Sync>;

    #[derive(Clone)]
    struct FakeTransport {
        log: Arc<StdMutex<Vec<ReceivedRequest>>>,
        responder: Arc<Responder>,
        seq: Arc<AtomicU64>,
    }

    impl FakeTransport {
        fn new(
            seq: Arc<AtomicU64>,
            responder: impl Fn(&AuthHttpRequest) -> Result<AuthHttpResponse, AuthError>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            Self {
                log: Arc::new(StdMutex::new(Vec::new())),
                responder: Arc::new(Box::new(responder)),
                seq,
            }
        }

        fn requests(&self, path: &str) -> Vec<ReceivedRequest> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.path == path)
                .cloned()
                .collect()
        }

        fn count(&self, path: &str) -> usize {
            self.requests(path).len()
        }

        fn bearer_count(&self, path: &str, bearer: &str) -> usize {
            self.requests(path)
                .iter()
                .filter(|r| r.bearer.as_deref() == Some(bearer))
                .count()
        }
    }

    impl AuthTransport for FakeTransport {
        fn send(
            &self,
            req: AuthHttpRequest,
        ) -> BoxFuture<'static, Result<AuthHttpResponse, AuthError>> {
            let log = self.log.clone();
            let responder = self.responder.clone();
            let seq = self.seq.clone();
            async move {
                // 先让出一次：模拟真实网络挂起，保证并发任务都推进到同一
                // 挂起点（单飞用例依赖 3 个请求都先收到 401 再进刷新）。
                tokio::task::yield_now().await;
                let current = seq.fetch_add(1, Ordering::Relaxed) + 1;
                log.lock().unwrap().push(ReceivedRequest {
                    seq: current,
                    method: req.method.as_str().to_string(),
                    path: req.path.clone(),
                    bearer: req.bearer.clone(),
                    body: req.body.clone(),
                });
                responder(&req)
            }
            .boxed()
        }
    }

    #[derive(Debug, Clone)]
    struct SavedRecord {
        seq: u64,
        auth: StoredAuth,
    }

    #[derive(Default)]
    struct FakeStoreState {
        current: Option<StoredAuth>,
        saved: Vec<SavedRecord>,
        clear_calls: usize,
        /// 前 N 次 clear 调用注入失败（§5.3 登出路径用例）。
        clear_fail_first: usize,
    }

    #[derive(Clone)]
    struct FakeTokenStore {
        seq: Arc<AtomicU64>,
        state: Arc<StdMutex<FakeStoreState>>,
    }

    impl FakeTokenStore {
        fn new(seq: Arc<AtomicU64>) -> Self {
            Self {
                seq,
                state: Arc::new(StdMutex::new(FakeStoreState::default())),
            }
        }

        /// 预置凭据（不走 save，不产生 saved 记录/序号）。
        fn preload(&self, auth: StoredAuth) {
            self.state.lock().unwrap().current = Some(auth);
        }

        fn saved(&self) -> Vec<SavedRecord> {
            self.state.lock().unwrap().saved.clone()
        }

        fn clear_calls(&self) -> usize {
            self.state.lock().unwrap().clear_calls
        }

        fn fail_clears(&self, n: usize) {
            self.state.lock().unwrap().clear_fail_first = n;
        }
    }

    impl TokenStore for FakeTokenStore {
        fn save(&self, auth: &StoredAuth) -> Result<(), AuthError> {
            let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
            let mut state = self.state.lock().unwrap();
            state.current = Some(auth.clone());
            state.saved.push(SavedRecord {
                seq,
                auth: auth.clone(),
            });
            Ok(())
        }

        fn load(&self) -> Option<StoredAuth> {
            self.state.lock().unwrap().current.clone()
        }

        fn clear(&self) -> Result<(), AuthError> {
            self.seq.fetch_add(1, Ordering::Relaxed);
            let mut state = self.state.lock().unwrap();
            state.clear_calls += 1;
            if state.clear_calls <= state.clear_fail_first {
                return Err(AuthError::local("storage_error", "注入的 clear 失败"));
            }
            state.current = None;
            Ok(())
        }
    }

    fn fixture_user() -> AuthUser {
        AuthUser {
            id: "u1".into(),
            email: "u@test.local".into(),
            nickname: Some("u".into()),
            plan: "free".into(),
            created_at: "2026-09-26T00:00:00.000Z".into(),
        }
    }

    fn fixture_stored(access_expires_at: i64) -> StoredAuth {
        StoredAuth {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            access_expires_at,
            user: fixture_user(),
        }
    }

    fn ok_login_body(access: &str, refresh: &str) -> String {
        serde_json::json!({
            "accessToken": access,
            "refreshToken": refresh,
            "expiresIn": 900,
            "user": {
                "id": "u1",
                "email": "u@test.local",
                "nickname": "u",
                "plan": "free",
                "createdAt": "2026-09-26T00:00:00.000Z"
            }
        })
        .to_string()
    }

    fn me_body() -> String {
        serde_json::json!({
            "id": "u1",
            "email": "u@test.local",
            "nickname": "u",
            "plan": "free",
            "createdAt": "2026-09-26T00:00:00.000Z"
        })
        .to_string()
    }

    fn err_body(code: &str) -> String {
        serde_json::json!({ "error": { "code": code, "message": "stub" } }).to_string()
    }

    fn resp(status: u16, body: &str) -> AuthHttpResponse {
        AuthHttpResponse {
            status,
            retry_after_seconds: None,
            body: body.to_string(),
        }
    }

    fn make_manager(transport: FakeTransport, store: FakeTokenStore) -> Arc<TokenManager> {
        Arc::new(TokenManager::new(Arc::new(transport), Arc::new(store)))
    }

    /// 3 个并发 with_auth 同收 401 token_expired：refresh 端点恰被调 1 次，
    /// 3 个请求全部以新 accessToken 重放成功（红线 2）。
    #[tokio::test]
    async fn refresh_single_flight_concurrent_401() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            if req.path == "/v1/auth/refresh" {
                return Ok(resp(200, &ok_login_body("new-access", "new-refresh")));
            }
            if req.path == "/v1/me" {
                if req.bearer.as_deref() == Some("old-access") {
                    return Ok(resp(401, &err_body("token_expired")));
                }
                return Ok(resp(200, &me_body()));
            }
            Err(AuthError::local("unknown", "unexpected path"))
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport.clone(), store.clone());

        let (r1, r2, r3) = tokio::join!(
            manager.with_auth(reqwest::Method::GET, "/v1/me", None),
            manager.with_auth(reqwest::Method::GET, "/v1/me", None),
            manager.with_auth(reqwest::Method::GET, "/v1/me", None),
        );
        for (label, result) in [("t1", r1), ("t2", r2), ("t3", r3)] {
            assert_eq!(result.unwrap().status, 200, "{label} 重放后应成功");
        }
        assert_eq!(
            transport.count("/v1/auth/refresh"),
            1,
            "并发 401 必须单飞：refresh 只发一次"
        );
        assert!(
            transport
                .requests("/v1/auth/refresh")
                .iter()
                .all(|r| r.method == "POST"),
            "refresh 应为 POST"
        );
        assert_eq!(
            transport.bearer_count("/v1/me", "old-access"),
            3,
            "3 个任务各发一次旧票请求"
        );
        assert_eq!(
            transport.bearer_count("/v1/me", "new-access"),
            3,
            "3 个请求全部以新 accessToken 重放"
        );
        // 单飞刷新共享同一份落盘：save 恰一次，携带新对。
        assert_eq!(store.saved().len(), 1);
        assert_eq!(store.saved()[0].auth.access_token, "new-access");
        assert_eq!(store.saved()[0].auth.refresh_token, "new-refresh");
    }

    /// 两次串行 refresh 必须发起两次 HTTP：第二次不被已完成的旧共享句柄
    /// 吞掉（P1 回归：换 Shared 前的 oneshot 方案会栽在这里）。
    #[tokio::test]
    async fn refresh_new_generation_after_completion() {
        let seq = Arc::new(AtomicU64::new(0));
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let transport = FakeTransport::new(seq.clone(), {
            let counter = counter.clone();
            move |req| {
                assert_eq!(req.path, "/v1/auth/refresh");
                let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
                Ok(resp(
                    200,
                    &ok_login_body(&format!("access-{n}"), &format!("refresh-{n}")),
                ))
            }
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport.clone(), store);

        let first = manager.refresh().await.unwrap();
        let second = manager.refresh().await.unwrap();
        assert_eq!(
            transport.count("/v1/auth/refresh"),
            2,
            "串行两次 refresh 必须两次 HTTP"
        );
        assert_eq!(first.access_token, "access-1");
        assert_eq!(second.access_token, "access-2");
        assert_ne!(first.refresh_token, second.refresh_token);
    }

    /// 红线 3：重放请求到达 transport 时，新令牌对的 save 已发生
    /// （共享全局序号：save_seq < 重放请求 receipt_seq）。
    #[tokio::test]
    async fn refresh_persist_before_replay() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            if req.path == "/v1/auth/refresh" {
                return Ok(resp(200, &ok_login_body("new-access", "new-refresh")));
            }
            if req.path == "/v1/me" {
                if req.bearer.as_deref() == Some("old-access") {
                    return Ok(resp(401, &err_body("token_expired")));
                }
                return Ok(resp(200, &me_body()));
            }
            Err(AuthError::local("unknown", "unexpected path"))
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport.clone(), store.clone());

        let result = manager
            .with_auth(reqwest::Method::GET, "/v1/me", None)
            .await
            .unwrap();
        assert_eq!(result.status, 200);

        let saved = store.saved();
        let save = saved
            .iter()
            .find(|r| r.auth.access_token == "new-access")
            .expect("新令牌对应已落盘");
        let me_requests = transport.requests("/v1/me");
        let replay = me_requests
            .iter()
            .find(|r| r.bearer.as_deref() == Some("new-access"))
            .expect("应存在新令牌重放请求");
        assert!(
            save.seq < replay.seq,
            "先落盘再重放：save seq={} 不小于重放 seq={}",
            save.seq,
            replay.seq
        );
    }

    /// 红线 4：401 token_invalid 不触发刷新；清凭据；返回会话失效。
    #[tokio::test]
    async fn only_token_expired_triggers_refresh() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            assert_eq!(req.path, "/v1/me");
            Ok(resp(401, &err_body("token_invalid")))
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport.clone(), store.clone());

        let err = manager
            .with_auth(reqwest::Method::GET, "/v1/me", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "token_invalid");
        assert_eq!(err.http_status, Some(401));
        assert_eq!(
            transport.count("/v1/auth/refresh"),
            0,
            "token_invalid 绝不触发刷新"
        );
        assert!(store.clear_calls() >= 1, "应清凭据");
        assert!(store.load().is_none(), "凭据应已清空");
        let status = manager.get_status().await;
        assert!(!status.logged_in);
        assert_eq!(status.notice, Some(AuthNotice::SessionExpired));
    }

    /// refresh 回 401 token_reused：store 清空；此后取 token 报未登录。
    #[tokio::test]
    async fn token_reused_clears_credentials() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            assert_eq!(req.path, "/v1/auth/refresh");
            Ok(resp(401, &err_body("token_reused")))
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport.clone(), store.clone());

        let err = manager.refresh().await.unwrap_err();
        assert_eq!(err.code, "token_reused");
        assert!(store.load().is_none(), "凭据应已清空");
        let again = manager.get_access_token().await.unwrap_err();
        assert_eq!(again.code, "unauthorized", "此后取 token 报未登录");
        let status = manager.get_status().await;
        assert!(!status.logged_in);
        assert_eq!(status.notice, Some(AuthNotice::SessionKicked));
    }

    /// D6/P7 绝对阈值：expires_at=now+100（<180）先触发一次刷新并返回新票；
    /// expires_at=now+400 不触发。
    #[tokio::test]
    async fn proactive_refresh_absolute_margin() {
        // 第一档：now + 100 < REFRESH_MARGIN_SECS(180) → 刷
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            assert_eq!(req.path, "/v1/auth/refresh");
            Ok(resp(
                200,
                &ok_login_body("proactive-access", "proactive-refresh"),
            ))
        });
        let store = FakeTokenStore::new(seq);
        store.preload(fixture_stored(now_unix() + 100));
        let manager = make_manager(transport.clone(), store);
        let token = manager.get_access_token().await.unwrap();
        assert_eq!(token, "proactive-access", "应返回刷新后的新 access");
        assert_eq!(
            transport.count("/v1/auth/refresh"),
            1,
            "惰性阈值内应刷新一次"
        );

        // 第二档：now + 400 > 180 → 不刷，直接用旧票
        let seq2 = Arc::new(AtomicU64::new(0));
        let transport2 = FakeTransport::new(seq2.clone(), |req| {
            assert_eq!(req.path, "/v1/auth/refresh");
            Ok(resp(
                200,
                &ok_login_body("should-not-happen", "should-not-happen"),
            ))
        });
        let store2 = FakeTokenStore::new(seq2);
        store2.preload(fixture_stored(now_unix() + 400));
        let manager2 = make_manager(transport2.clone(), store2);
        let token2 = manager2.get_access_token().await.unwrap();
        assert_eq!(token2, "old-access", "阈值外不应刷新");
        assert_eq!(
            transport2.count("/v1/auth/refresh"),
            0,
            "阈值外不应发 refresh"
        );
    }

    /// 429 + retry-after:37 → Err 透传 retryAfterSeconds=37；不自动重试。
    #[tokio::test]
    async fn rate_limited_surfaced_no_retry() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            assert_eq!(req.path, "/v1/auth/otp/request");
            Ok(AuthHttpResponse {
                status: 429,
                retry_after_seconds: Some(37),
                body: err_body("rate_limited"),
            })
        });
        let store = FakeTokenStore::new(seq);
        let manager = make_manager(transport.clone(), store);

        let err = manager.send_otp("someone@test.local").await.unwrap_err();
        assert_eq!(err.code, "rate_limited");
        assert_eq!(err.http_status, Some(429));
        assert_eq!(err.retry_after_seconds, Some(37));
        assert_eq!(transport.count("/v1/auth/otp/request"), 1, "429 不自动重试");
    }

    /// §7-2：verify_otp 成功 = 先落盘（save 序号先于命令返回）→ 内存态；
    /// device 由 Rust 填。
    #[tokio::test]
    async fn login_success_persists_before_return() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq.clone(), |req| {
            assert_eq!(req.path, "/v1/auth/otp/verify");
            Ok(resp(200, &ok_login_body("acc-1", "ref-1")))
        });
        let store = FakeTokenStore::new(seq.clone());
        let manager = make_manager(transport.clone(), store.clone());

        let session = manager
            .verify_otp("someone@test.local", "123456")
            .await
            .unwrap();
        assert_eq!(session.user.id, "u1");

        // device 由 Rust 填：platform=windows，name 非空且 ≤64
        let verify_requests = transport.requests("/v1/auth/otp/verify");
        let body_text = verify_requests[0].body.as_ref().unwrap();
        let body: serde_json::Value = serde_json::from_str(body_text).unwrap();
        assert_eq!(body["device"]["platform"], "windows");
        let name = body["device"]["name"].as_str().unwrap();
        assert!(!name.is_empty() && name.chars().count() <= 64);

        // 持久化先于返回：save 已发生（1 次、携带新对），序号早于返回后取的序号
        let saved = store.saved();
        assert_eq!(saved.len(), 1, "恰一次落盘");
        assert_eq!(saved[0].auth.access_token, "acc-1");
        assert_eq!(saved[0].auth.refresh_token, "ref-1");
        let after_return = seq.fetch_add(1, Ordering::Relaxed) + 1;
        assert!(saved[0].seq < after_return, "save 应发生在命令返回之前");

        let status = manager.get_status().await;
        assert!(status.logged_in);
        assert_eq!(status.user, Some(fixture_user()));
        assert_eq!(status.notice, None, "登录成功清除 notice");
    }

    /// 服务端登出请求网络失败：本地照常清理，serverRevoked:false。
    #[tokio::test]
    async fn logout_always_clears_local() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq, |req| {
            assert_eq!(req.path, "/v1/auth/logout");
            Err(AuthError::local("network_error", "注入的网络失败"))
        });
        let store = FakeTokenStore::new(Arc::new(AtomicU64::new(0)));
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport, store.clone());

        let outcome = manager.logout().await.unwrap();
        assert!(!outcome.server_revoked, "网络失败时 serverRevoked=false");
        assert!(store.load().is_none(), "本地凭据应清空");
        assert!(!manager.get_status().await.logged_in);
    }

    /// §5.3：clear 注入失败（重试一次仍败）→ Err(storage_error)、内存态保留；
    /// clear 恢复后重试登出 → 正常登出。
    #[tokio::test]
    async fn logout_clear_failure_keeps_state() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq, |req| {
            assert_eq!(req.path, "/v1/auth/logout");
            Ok(resp(204, ""))
        });
        let store = FakeTokenStore::new(Arc::new(AtomicU64::new(0)));
        store.preload(fixture_stored(now_unix() + 1000));
        store.fail_clears(2); // 首次 clear + 重试一次都失败
        let manager = make_manager(transport, store.clone());

        let err = manager.logout().await.unwrap_err();
        assert_eq!(err.code, "storage_error");
        assert_eq!(store.clear_calls(), 2, "clear 应重试一次");
        assert!(store.load().is_some(), "磁盘凭据保留");
        assert!(
            manager.get_status().await.logged_in,
            "登出失败保持登录态（不广播登出）"
        );

        // clear 恢复（fail 配额已耗尽）→ 重试登出成功
        let outcome = manager.logout().await.unwrap();
        assert!(outcome.server_revoked);
        assert!(store.load().is_none());
        assert!(!manager.get_status().await.logged_in);
    }

    /// §4.4：store 有数据 + refresh 网络错 → 保留预填态，仍显示已登录。
    #[tokio::test]
    async fn bootstrap_offline_keeps_logged_in() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq, |req| {
            assert_eq!(req.path, "/v1/auth/refresh");
            Err(AuthError::local("network_error", "注入的离线"))
        });
        let store = FakeTokenStore::new(Arc::new(AtomicU64::new(0)));
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport, store.clone());

        let user = manager.prefill_from_store().await;
        assert_eq!(user, Some(fixture_user()), "启动预填内存态");
        let err = manager.refresh().await.unwrap_err();
        assert_eq!(err.code, "network_error");

        let status = manager.get_status().await;
        assert!(status.logged_in, "离线时保留预填态（不回退 UI）");
        assert!(store.load().is_some(), "离线不清凭据");
    }

    /// §4.4：内存态空、store 有 → get_status 预填并返回 loggedIn:true。
    #[tokio::test]
    async fn get_status_prefills_from_store() {
        let seq = Arc::new(AtomicU64::new(0));
        let transport = FakeTransport::new(seq, |_req| {
            Err(AuthError::local("unknown", "get_status 不应发请求"))
        });
        let store = FakeTokenStore::new(Arc::new(AtomicU64::new(0)));
        store.preload(fixture_stored(now_unix() + 1000));
        let manager = make_manager(transport, store);

        let status = manager.get_status().await;
        assert!(status.logged_in);
        assert_eq!(status.user, Some(fixture_user()));
        assert_eq!(status.notice, None);
    }
}

// ---------------------------------------------------------------------------
// 联调测试（§9.3；#[ignore]，需本地真服务端 http://127.0.0.1:8090 存活，
// 跑法：cargo test -- --ignored）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod integration_tests {
    use super::*;

    async fn send(
        transport: &ReqwestTransport,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        bearer: Option<String>,
    ) -> AuthHttpResponse {
        AuthTransport::send(
            transport,
            AuthHttpRequest {
                method,
                path: path.to_string(),
                body: body.map(|v| v.to_string()),
                bearer,
            },
        )
        .await
        .expect("transport send 失败（服务端未启动？）")
    }

    fn error_code(resp: &AuthHttpResponse) -> String {
        serde_json::from_str::<ErrorBody>(&resp.body)
            .expect("错误响应应为 {error:{code}} 形状")
            .error
            .code
    }

    /// 全链（§9.3-1）：register → login → me → refresh 轮换（旧票立即作废）
    /// → 旧票复用 401 token_reused → logout 204 → 会话吊销得 401 token_invalid。
    ///
    /// 对设计 §9.3 的两处字面修正（均经服务端源码核实）：
    /// - 「旧 accessToken GET me → 401」不可断言：JwtAuthGuard 是无状态 JWT
    ///   校验（不查 Session 表），轮换/登出后旧 access 在 TTL（默认 900s）内
    ///   访问 /v1/me 仍是 200；
    /// - 登出后的「me 得 token_invalid」改为对 `/v1/auth/refresh` 断言：refresh
    ///   会查 Session.revokedAt，吊销后必得 401 token_invalid（观测点等价）。
    #[tokio::test]
    #[ignore = "需本地真服务端 http://127.0.0.1:8090 存活（cargo test -- --ignored）"]
    async fn full_chain_register_login_me_refresh_reuse_logout() {
        let transport = ReqwestTransport::new(DEV_BASE_URL.to_string()).unwrap();
        let email = format!("auth_probe_{}@test.local", now_unix());
        let password = "probe-pass-123456";
        let device = serde_json::json!({ "platform": "windows", "name": "cargo-it" });

        // 1. 密码注册 → 201
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/register",
            Some(serde_json::json!({
                "email": email, "password": password, "nickname": "probe"
            })),
            None,
        )
        .await;
        assert_eq!(resp.status, 201, "register: {}", resp.body);
        let registered: serde_json::Value = serde_json::from_str(&resp.body).unwrap();

        // 2. 密码登录 → 200 双令牌
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/login",
            Some(serde_json::json!({
                "email": email, "password": password, "device": device
            })),
            None,
        )
        .await;
        assert_eq!(resp.status, 200, "login: {}", resp.body);
        let pair1: LoginResponse = serde_json::from_str(&resp.body).unwrap();
        assert_eq!(pair1.user.id, registered["id"].as_str().unwrap());

        // 3. 带令牌访问 → 200
        let resp = send(
            &transport,
            reqwest::Method::GET,
            "/v1/me",
            None,
            Some(pair1.access_token.clone()),
        )
        .await;
        assert_eq!(resp.status, 200, "me: {}", resp.body);

        // 4. 刷新：新对落盘，旧 refreshToken 立即作废
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/refresh",
            Some(serde_json::json!({ "refreshToken": pair1.refresh_token })),
            None,
        )
        .await;
        assert_eq!(resp.status, 200, "refresh: {}", resp.body);
        let pair2: LoginResponse = serde_json::from_str(&resp.body).unwrap();
        assert_ne!(pair2.refresh_token, pair1.refresh_token, "refresh 应轮换");
        // 新 accessToken 必须可用（设计 §9.3「refresh 200 新对落盘」的契约验证）。
        // 不断言新旧 access 字符串必不同：服务端是确定性签发（HS256、claims
        // {sid,plan,iat,exp,iss,sub} 无 jti、iat 秒级），login 与 refresh 落在
        // 同一 Unix 秒时两次签发逐字节相同（实测 iat 同值），「必不同」无服务
        // 端保证支撑；轮换语义由 refreshToken 必变 + 旧 refreshToken 即作废
        // （下步 token_reused）承载。
        let resp = send(
            &transport,
            reqwest::Method::GET,
            "/v1/me",
            None,
            Some(pair2.access_token.clone()),
        )
        .await;
        assert_eq!(resp.status, 200, "me with new access: {}", resp.body);

        // 5. 旧票复用 → 401 token_reused（全设备已下线）
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/refresh",
            Some(serde_json::json!({ "refreshToken": pair1.refresh_token })),
            None,
        )
        .await;
        assert_eq!(resp.status, 401, "reuse: {}", resp.body);
        assert_eq!(error_code(&resp), "token_reused");

        // 6. logout（新 accessToken，尽力）→ 204
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/logout",
            None,
            Some(pair2.access_token.clone()),
        )
        .await;
        assert_eq!(resp.status, 204, "logout: {}", resp.body);

        // 7. 会话吊销的观测点（见函数注释）：新 refresh 再刷 → 401 token_invalid
        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/refresh",
            Some(serde_json::json!({ "refreshToken": pair2.refresh_token })),
            None,
        )
        .await;
        assert_eq!(resp.status, 401, "refresh-after-logout: {}", resp.body);
        assert_eq!(error_code(&resp), "token_invalid");
    }

    /// §9.3-2：otp/request（不存在邮箱）→ 200 {ok:true}（防枚举）；
    /// 错码 verify → 400 otp_invalid。
    #[tokio::test]
    #[ignore = "需本地真服务端 http://127.0.0.1:8090 存活（cargo test -- --ignored）"]
    async fn otp_request_then_wrong_code_is_otp_invalid() {
        let transport = ReqwestTransport::new(DEV_BASE_URL.to_string()).unwrap();
        let email = format!("auth_probe_otp_{}@test.local", now_unix());

        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/otp/request",
            Some(serde_json::json!({ "email": email })),
            None,
        )
        .await;
        assert_eq!(resp.status, 200, "otp/request: {}", resp.body);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&resp.body).unwrap()["ok"],
            serde_json::json!(true),
            "防枚举：恒 {{ok:true}}"
        );

        let resp = send(
            &transport,
            reqwest::Method::POST,
            "/v1/auth/otp/verify",
            Some(serde_json::json!({
                "email": email,
                "code": "000000",
                "device": { "platform": "windows", "name": "cargo-it" }
            })),
            None,
        )
        .await;
        assert_eq!(resp.status, 400, "otp/verify: {}", resp.body);
        assert_eq!(error_code(&resp), "otp_invalid");
    }
}
