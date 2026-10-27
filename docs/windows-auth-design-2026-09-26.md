# Windows 端账号登录 · 功能设计（windows-auth）

- 日期：2026-09-26 · 第 2 轮修订 2026-09-27 · **第 3 轮复核 2026-09-27**：本轮收到的评审意见与第 2 轮**逐字相同**（含复核声明「git status 同两个未跟踪文件、HEAD 9283c48」）——第 2 轮修订已全部落盘，本轮完成残留自查（补 §4.2 `'static` 实现注记）并在 §12 附逐条修订位置索引；文件名沿用任务指定日期
- 作者：桌面端架构（方案设计师）
- 输入：`immersive-translator-server/docs/client-auth-integration.md`（对接契约，以它为准）、`immersive-translator-server/docs/api.md`、客户端现状调研（v0.7.0；测试基线为调研已执行结果：npm test 483 通过、cargo 76 通过、build 通过）、`docs/server-architecture-plan-2026-09-22.md`（M1/M2 分期）、第 1 轮评审意见（15 条，本轮全部修订）
- 结论先行：**登录是可选增强，不阻断本地功能**。验证码登录为主入口（自动建号）+ 密码登录页签；**全部认证 HTTP 与令牌生命周期收在 Rust 侧**单一模块（trait transport 可注入做 cargo 单测），token 永不跨 IPC；双令牌单槽 JSON 存 DPAPI；**单飞刷新以 `futures_util` Shared future + 代数清槽实现**（多消费者安全，§4.2）；**secrets.json 全部写入经进程级互斥锁串行化**（§5.2）；前端新增 login 窗（系统装饰规格，与重建路径零分叉）+ 设置页「账号」tab（账号态/登出/失效状态条）；启动静默续登录（**先预填内存态再异步校验**，离线也显示已登录）。设备管理/改密/忘记密码/注册页签/`me/config` 深度消费后置。

---

## 1. 需求整理与范围

### 1.1 MVP 必做

| # | 需求 | 验收来源 |
|---|---|---|
| 1 | 验证码登录（含未注册邮箱自动建号） | 服务端文档 §10 六项判定之一 |
| 2 | 密码登录（页签并存） | 六项判定之一 |
| 3 | 单飞刷新（并发共享同一次刷新，多消费者安全原语） | §7 红线 2 |
| 4 | 401 分支处理：`token_expired` 刷、`token_invalid`/`token_reused` 清凭据 | §7 红线 4 |
| 5 | 429 限流提示（读 `retry-after` 头，不自动重试） | §5 |
| 6 | 登出清凭据（服务端吊销尽力 + 本地清空，含 clear 失败路径定义） | §7 红线 5 |
| 7 | 登录入口：独立 login 窗 + 托盘菜单项 + 设置页「账号」tab 内按钮 | 任务书 |
| 8 | 启动静默续登录：**预填内存态**（离线也显示已登录）→ 后台刷新校验存活；fatal 才转未登录 | 服务端文档 §8 |
| 9 | 登录成功后拉取并存储 `GET /v1/me/config`（落 `app_data_dir/server_config.json`，MVP 只存不深度消费） | 任务书；M2 消费 |

### 1.2 后续迭代（本期不做，见 §11）

| 项 | 后置理由 |
|---|---|
| 设备管理（`GET /v1/auth/devices`、踢设备） | 非六项判定；依赖账号区 UI 二期 |
| 修改/设置密码（`password-change`） | 验证码建号用户可用验证码永续登录，设密非闭环必需 |
| 忘记密码入口（`password-reset/request`） | 主入口是验证码，密码丢失可走验证码登录 |
| 密码注册页签（`register`） | 验证码登录已覆盖自动建号（服务端文档 §8：「只做验证码登录也能覆盖全部用户生命周期」） |
| `/v1/me/config` 深度消费（官方服务预设、gateway/models 接入 providerPresets） | 服务端 M2 范围；MVP 只拉取落盘 |
| 昵称编辑（`PATCH /v1/me`）、头像 | 账号资料只读已满足 MVP 账号区 |
| 全局 toast 组件 | 本期用账号区状态条承载全部账号类提示（D8）；共享 toast 若立项归 UX 系统层，不随登录功能夹带 |

---

## 2. 产品决策（逐条理由）

**D1 登录不阻断使用。** 现有客户端全部核心能力（翻译/OCR/阅读室/生词本/复习/口语）基于本地存储 + 用户自配 API Key 独立工作（调研 storage 节：设置走 localStorage+DPAPI，数据全在 `app_data_dir`），账号体系在服务端定位是 M1「登录即可用（官方服务）」的可选增强，尚无任何功能以登录为前置。强制阻断等于把存量用户的可用性押在新增依赖上，且与服务端分期（M2 才有官方服务消费）不匹配。落地形态：未登录 = 全功能可用，设置页账号区显示未登录空态；登录 = 额外获得 `/v1/me/config` 与未来的云能力。首启不弹登录窗（与 onboarding 只弹一次的克制原则一致）。

**D2 登录入口 = 独立 login 窗口（登录流） + 设置页「账号」tab（账号态）。** 登录是**一次性引导流程**（邮箱→验证码→完成即关窗），对齐 onboarding 先例（`tauri.conf.json` 预建 `visible:false` + `App.tsx` 按 label 分支 + `lib.rs` `show_window` 258 行）；账号态展示/登出是**常驻管理**，对齐 voice tab 先例（`Settings.tsx` TABS + 拆 `views/AccountSection.tsx`）。两端共享 Rust 侧同一份凭据状态（`auth-state-changed` 事件驱动），不引入第二份前端账号存储。托盘菜单加「账号登录」项：未登录 → 开 login 窗；已登录 → 打开 settings 并定位「账号」tab（**双路径**：窗口已存在走 `emit_to` 事件即时切换，不存在才写 pending——完全照 `open_reader_book` 先例 lib.rs:601-619，其 603 行注释明确「窗口存在时不写 pending，避免陈旧请求」；settings 窗预建且关闭即 hide（Settings.tsx `handleClose` → `getCurrentWindow().hide()`，实测核对），挂载一生只发生一次，pending 只覆盖启动早期窗口尚未挂载的窗口窄缝）。

**D3 验证码为主入口 + 密码页签。** 服务端文档 §2/§8 明确推荐：验证码登录注册登录一体（自动建号），客户端无需区分登录/注册；密码页签服务已有密码的账号（多端用户）。login 窗默认停在验证码流，顶部页签可切「密码登录」。不设注册页签（§1.2）。验证码页「重新发送」60 秒倒计时：**本地状态 + 按邮箱持久化上次发送时间戳（localStorage），关窗重开可恢复剩余倒计时**（D10）。

**D4 认证 HTTP 与令牌生命周期全部在 Rust 侧。** ① 全仓无前端 fetch 先例，CSP/无 http 插件下 WebView 内 fetch 有 CORS 风险（服务端文档 §9 同提示）；② 「先落盘再重放」要求与 DPAPI 存储同进程强一致，跨 IPC 编排会把红线逻辑摊到两层；③ token 永不跨 IPC——前端只拿 `user`、登录态布尔与失效通知，WebView/DevTools 里看不到令牌本体。Rust 侧以 `trait AuthTransport` 收口全部认证 HTTP，令牌管理器面向 trait 编程，cargo 单测注入假 transport 假存储（§9）。

**D5 双令牌单槽 JSON（`server_auth`）存 DPAPI。** 不用双命名槽。① 单槽一次写入保证 accessToken/refreshToken/user 配套（双槽两次写入中途崩溃会留新旧混合态）；② KeyVault 单槽 JSON 先例（settingsStore.ts:126-142）；③ 槽名满足 `normalize_name`（仅 `[a-z0-9_]` ≤64，secret_store.rs:181-195）。**单槽只保证单次写不撕裂；跨调用方（auth 落盘 vs 设置页 `secret_set`）的并发丢更新由 §5.2 的进程级写锁解决**——这是 D5 成立的另一半前提。

**D6 主动刷新 = 启动即刷 + 惰性阈值；被动刷新 = 401 `token_expired` 兜底。** 惰性阈值采用**绝对剩余秒数**：`const REFRESH_MARGIN_SECS: i64 = 180`——`now + 180 >= access_expires_at` 即刷。不采用「80% 寿命」相对比例：`StoredAuth` 只存绝对到期时间（§4.1），比例的分母（签发时刻或 expiresIn）需新增字段，且服务端 expiresIn 变更时绝对阈值自适应。180s 对默认 900s 寿命即「720s/80% 处刷新」，语义等价（P7 修订）。不做常驻定时器：桌面端认证请求低频，「启动 + 惰性 + 401 兜底」覆盖全部路径。时间敏感逻辑以服务端 401 为权威信号（文档 §9）。

**D7 `me/config` 拉取不阻塞登录体验。** 登录命令成功返回即落盘令牌并广播登录态；`auth_fetch_server_config` 由 Rust 在登录成功后 fire-and-forget spawn（失败仅 log，账号区可手动重拉）。

**D8 账号类提示不做全局 toast，宿主 = 设置页「账号」tab 状态条 + 侧栏 conn-chip。** 全仓无共享 toast 组件（`src/ui/` 仅 ConfirmDialog 与 icons，已核实；reader 内的 toast 是阅读室局部实现，不跨窗）。而令牌失效（token_invalid/token_reused/启动续登录 fatal）常发生在无可见窗口时（settings 隐藏、login 未开），任何「立即弹出」的设计都要新建跨窗口通知机制，成本与打扰度都高。方案：`AuthStatus.notice` 字段携带失效原因（`session_expired`/`session_kicked`），**持久渲染在账号 tab 顶部的状态条**（warn 色，用户下次打开设置必见），conn-chip 账号点反映登录态；登录成功即清除 notice。不打扰、不丢失、零新组件（P10 修订）。

**D9 login 窗规格与通用重建路径零分叉。** `show_window` 重建分支的公共 builder 固定 `.resizable(true)`、系统装饰、不带 transparent（lib.rs:283-295 实测核对），spec match 只按 label 给标题+尺寸（lib.rs:266-271）。因此 login 窗在 `tauri.conf.json` 定义为**系统装饰 + `resizable:true` + `minimizable:true` + `maximizable:false`**（与 settings 完全同形态，仅尺寸 420×560），重建 spec match 加 `("账号登录", 420.0, 560.0)` 一行即与原窗行为一致。放弃「无边框透明/不可调」的 onboarding 形态——那只对一次性首启引导合理，且会造成重建窗与原窗外观分叉（P9 修订）。登录窗 420×560 可调大无任何危害。

**D10 重发倒计时持久化。** 验证码 60s 倒计时若仅是窗内 React 状态，关窗（login 窗完成即 close）重开后立即可再点「获取验证码」，而服务端冷却期内静默不发、恒回 `{ok:true}`（文档 §4.1 防枚举），用户会以为已重发却永远等不到邮件。方案：前端按邮箱记上次发送时间戳于 localStorage（key `immersive-auth-otp-last-sent`，值为 `{ [email]: unixMs }` 映射，容量截断至最近 10 条），LoginView 进入验证码页/挂载时读取：`剩余 = 60 - (now - ts)`，>0 则恢复禁用倒计时（P14 修订）。

---

## 3. 错误码映射表（按 `code` 分支，绝不匹配文案）

前端唯一出口：`src/lib/authErrorText.ts` 的 `authErrorText(err): { text, kind }`，`kind ∈ 'inline' | 'statusbar' | 'silent'`（第 1 轮的 `toast` kind 全部取消，见 D8）。服务端 `message` 仅作日志兜底，不展示。

| code | HTTP | 用户看到的中文文案 | 呈现 | 客户端动作 |
|---|---|---|---|---|
| `otp_invalid` | 400 | 验证码错误或已过期，请重新获取 | inline | 停验证码页，清空码输入并聚焦，保留重发按钮 |
| `invalid_credentials` | 401 | 邮箱或密码不正确；若从未设置密码，请改用验证码登录 | inline | 停密码页签，选中密码框 |
| `email_taken` | 409 | （MVP 无注册入口，预留）该邮箱已注册，请直接登录 | inline | 预留映射，MVP 不可达 |
| `banned` | 403 | 该账号已被封禁，如有疑问请联系支持 | inline | **阻断**：禁用「获取验证码/登录」提交，仅保留「返回修改邮箱」（回到邮箱页清空错误态） |
| `token_expired` | 401 | （用户不可见）登录已过期，正在自动续期 | silent | Rust 单飞刷新后重放一次；刷新失败再按其 code 走 |
| `token_invalid` | 401 | 登录已失效，请重新登录 | statusbar | 清凭据 → `notice:'session_expired'` → 账号 tab 顶部 warn 状态条；不自动弹登录窗 |
| `token_reused` | 401 | 检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录 | statusbar | 清凭据 → `notice:'session_kicked'` → 账号 tab 状态条；**绝不再刷** |
| `unauthorized` | 401 | 同 `token_invalid` 文案 | statusbar | 同 `token_invalid`（有 refresh 先走一次刷新，失败即清） |
| `rate_limited` | 429 | 操作过于频繁，请 {N} 秒后再试（N=retry-after 秒） | inline | 提交按钮禁用并显示 N 秒倒计时，到 0 自动恢复；不自动重试 |
| `validation_error` | 400 | 请求参数异常，请更新应用后重试；若持续出现请反馈 | inline + 前端日志记录 `details` | 属客户端 bug，开发期断言不可达 |
| `service_unavailable` | 503 | 邮件服务暂时不可用，请稍后再试 | inline | 停邮箱页，保留「获取验证码」可重试 |
| `network_error`（本地伪码） | — | 网络连接失败，请检查网络后重试 | inline | 保留当前页与输入，按钮恢复可点 |
| `storage_error`（本地伪码） | — | 本地安全存储读写失败，请重试或反馈 | inline | 登录流程中止（令牌无法安全落盘时不允许「登录成功」）；登出场景见 §7 `auth_logout` |
| `parse_error` / `unknown`（本地伪码） | — | 服务响应异常，请稍后再试 | inline | 保留当前页可重试 |

实现约束：Rust 侧把非 2xx 的 `error.code` 原样透传进 `AuthError.code`（§7），网络/序列化失败映射为本地伪码。code 分支逻辑收敛在 Rust `TokenManager` + 前端 `authErrorText` 两处，均以 `code` 字符串匹配。

---

## 4. 令牌管理设计（`auth.rs` 核心）

### 4.1 组件与数据结构

```rust
// —— 可注入的 HTTP 传输层（红线可测试性的落点）——
pub trait AuthTransport: Send + Sync {
    async fn send(&self, req: AuthHttpRequest) -> Result<AuthHttpResponse, AuthError>;
}
pub struct AuthHttpRequest  { method: Method, path: String, body: Option<String>, bearer: Option<String> }
pub struct AuthHttpResponse { status: u16, retry_after_seconds: Option<u64>, body: String }
// 生产实现 ReqwestTransport { base_url }（一次性 client，照 translation.rs:359 形状；
// base_url 解析见 §4.6——dev 常量缺省 + server_endpoint.json 覆盖）

// —— 可注入的持久层（测试「先落盘再重放」的时序断言落点）——
pub trait TokenStore: Send + Sync {
    fn save(&self, auth: &StoredAuth) -> Result<(), AuthError>;   // DPAPI 槽 server_auth（经 §5.2 写锁）
    fn load(&self) -> Option<StoredAuth>;
    fn clear(&self) -> Result<(), AuthError>;                      // P13：clear 可失败，见 §7 auth_logout
}
pub struct StoredAuth {   // 单槽 JSON（D5），serde camelCase
    access_token: String, refresh_token: String,
    access_expires_at: i64,        // unix 秒（唯一时间字段；主动刷新阈值只用它，见 D6/P7）
    user: AuthUser,
}

pub const REFRESH_MARGIN_SECS: i64 = 180;   // 惰性主动刷新阈值：剩余 ≤180s 即刷（D6）

pub struct TokenManager {
    transport: Box<dyn AuthTransport>,
    store: Arc<dyn TokenStore>,
    state: tokio::sync::Mutex<Option<StoredAuth>>,   // 内存权威态（启动预填，见 §4.4）
    inflight: tokio::sync::Mutex<Option<(u64, SharedRefresh)>>,  // 单飞槽：(代数, 共享 future)
    next_gen: std::sync::atomic::AtomicU64,
}
```

`TokenManager` 由 `lib.rs` `.manage(Arc<TokenManager>)` 注入（Arc 持有是 §4.2 `'static` 注记的前提；现状 10 处 manage，lib.rs:1313-1322 实数；新增第 11 处），generate_handler! 同文件登记。事件广播通过 `AppHandle` 在命令层完成（单测构造 `TokenManager` 时不带 AppHandle）。

### 4.2 单飞刷新（红线 2；P1 重写：多消费者共享原语）

**原语选择：`futures_util::future::Shared`（依赖已在：`futures-util = "0.3"`，Cargo.toml:43，translation.rs SSE 已在用）。** 第 1 轮的 `Option<oneshot::Receiver>` 不可用——oneshot Receiver 是单消费者的，首调用者 await 后后来者只能拿到已消费的 receiver（RecvError）。`Shared` future 的 clone 是多消费者句柄：任意多个调用者 clone 后各自 await，拿到**同一份缓存结果**，无消费语义、无 RecvError。

```rust
use futures_util::future::{BoxFuture, FutureExt, Shared};
use std::sync::Arc;

type RefreshOutcome = Result<Arc<StoredAuth>, Arc<AuthError>>;
type SharedRefresh  = Shared<BoxFuture<'static, RefreshOutcome>>;   // Output 全 Arc → 满足 Clone
// 实现注记（第 3 轮补）：'static 要求 do_refresh 的 future 不借用 &self——
// TokenManager 一律以 Arc<TokenManager> 持有（lib.rs .manage(Arc<TokenManager>)，命令层 State<'_, Arc<TokenManager>>），
// do_refresh 写成 async move 块捕获 Arc 克隆（let this = self.clone() 进闭包），
// 使 boxed() 后满足 'static；直接 self.do_refresh().boxed() 借用 self 不可编译，此处伪代码以 Arc 克隆为前提。

impl TokenManager {
    /// 单飞入口：同一时刻至多一个 /v1/auth/refresh 在途；并发调用共享同一次结果。
    async fn refresh(&self) -> RefreshOutcome {
        let (gen, shared) = {
            let mut slot = self.inflight.lock().await;
            if let Some((gen, existing)) = slot.as_ref() {
                (*gen, existing.clone())            // ① 在途：clone 共享句柄（不消费），等同一结果
            } else {
                let gen = self.next_gen.fetch_add(1, Ordering::Relaxed);
                let fut: SharedRefresh = self.do_refresh().boxed().shared();
                *slot = Some((gen, fut.clone()));   // ② 空槽：本调用者发起，句柄入槽
                (gen, fut)
            }
        };
        let outcome = shared.await;                  // ③ 所有调用者 await 各自 clone → 同一结果
        let mut slot = self.inflight.lock().await;   // ④ 完成方清槽：仅当槽内仍是本代数
        if matches!(*slot, Some((cur, _)) if cur == gen) { *slot = None; }
        outcome
    }

    /// 真正的刷新（每个代数至多执行一次）。
    async fn do_refresh(&self) -> RefreshOutcome {
        let rt = self.state.lock().await.as_ref().map(|s| s.refresh_token.clone())
            .or_else(|| self.store.load().map(|s| s.refresh_token))
            else { return Err(Arc::new(AuthError::local("unauthorized", "未登录"))) };
        match self.transport.send(POST "/v1/auth/refresh" {refreshToken: rt}).await {
            Ok(200 对) => {
                let stored = StoredAuth::from(resp);
                self.store.save(&stored)?;           // 先落盘（红线 3；经 §5.2 写锁）
                *self.state.lock().await = Some(stored.clone());
                Ok(Arc::new(stored))
            }
            Ok(401 code∈{token_expired|token_invalid|token_reused}) => {
                self.store.clear()；*self.state.lock().await = None;  // fatal 三码 → 清凭据（红线 4/5）
                Err(Arc::new(code))
            }
            other => Err(other),                     // 网络等瞬时错误：不清凭据（§4.4 离线契约）
        }
    }
}
```

**并发语义逐条说明（两名开发者按此对齐）：**

1. **并发 401**：N 个并发 `with_auth` 同时进 `refresh()` → 全部在 ① 拿到同一 clone → 共享同一次 HTTP 刷新与同一份落盘 → 各自拿到新 accessToken 重放。transport 只见 1 次 `/v1/auth/refresh`。
2. **完成后清槽（④ 的代数校验）**：清槽由「完成路径」执行而非 spawn 内部；多个等待者都走到 ④，但 `cur == gen` 校验保证只有槽内仍是本代时才清——第一个到达者清掉，其余 no-op；期间若有**新一代**刷新入槽（本代结果已在途极久后超时重入的场景），校验失败不动新槽，新一代照常发起自己的 HTTP 刷新。
3. **极窄窗口共享已完成结果**：④ 清槽前到来的调用者会 clone 到「刚完成的这一代」并立即拿到其缓存结果——那是**最新一次成功结果**（新令牌对）而非陈旧旧票，语义安全；新一代刷新在清槽后创建。若该代结果是错误（网络错），共享者拿到同一错误可稍后重试；若 fatal，共享者走同一清凭据路径（幂等）。
4. **绝无第二条在途刷新**：任何时刻入槽的代数唯一；不存在「两个线程各拿同一旧 refreshToken 各自刷新」的路径——这正是 `token_reused` 全设备下线的成因（服务端 §7 红线 2，不会放宽）。

### 4.3 带鉴权请求 `with_auth`（401 分支，红线 4）

```
fn with_auth(req):
    token = state.access_token
    if now + REFRESH_MARGIN_SECS >= access_expires_at:  await refresh()   # D6 惰性主动（绝对阈值）
    resp = transport.send(req + Bearer token)
    if resp == 401 && code == "token_expired":
        stored = await refresh()            # 单飞（§4.2）
        resp = transport.send(req + Bearer stored.access_token)  # 重放一次（先落盘已完成）
        if resp == 401: 清凭据（store.clear + state=None）并按新 code 处理
    if resp == 401 && code in {token_invalid, token_reused, unauthorized}:
        清凭据；返回会话失效（不刷新）      # 红线：invalid/reused/unauthorized 绝不再刷
    return resp
```

### 4.4 启动静默续登录（需求 8；P4 重写：内存态契约写死）

**登录态判据全程序唯一**：`logged_in(state, store) = state 有 StoredAuth || store.load() 有 StoredAuth`（refresh_token 非空即算）。`auth_bootstrap` 与 `auth_get_status` 共用这一判据，杜绝两端行为分叉：

```
auth_bootstrap(app)（lib.rs setup 末尾 tokio::spawn，不阻塞任何窗口显示）:
  stored = store.load()
  if stored.is_none(): return                                 # 无凭据：无事发生
  *state = Some(stored)                                       # ① 先预填内存态
  emit("auth-state-changed", {loggedIn:true, user, notice:null})
        # 契约：磁盘有 30 天 refresh 即视为已登录——离线启动也显示已登录（合理），
        # 不允许「磁盘有凭据却显示未登录、联网后又自动恢复」的抖动
  match refresh().await:                                      # ② 再后台校验存活
    Ok(new)  => state 更新；emit(loggedIn:true)               #    静默续期成功
    Err(code∈fatal 三码) => 凭据已清（§4.2）；emit(loggedIn:false, notice:session_expired|session_kicked)
    Err(网络等瞬时) => 保留预填态，不回退 UI                   # ③ 离线不清凭据不清状态
```

`auth_get_status`：读内存态；为空时回读 store 并预填后返回（同一判据的懒执行）。启动早期（bootstrap 尚未跑完）UI 调用也得到一致结果。

### 4.5 429（红线之一）

`ReqwestTransport` 解析 `retry-after` 头（秒）进 `AuthHttpResponse.retry_after_seconds`，`AuthError.retry_after_seconds` 透传前端；前端按 §3 映射禁用按钮倒计时，**不做自动重试**（服务端文档 §5）。

### 4.6 base_url 配置机制（P6 重写；2026-10-23 修订缺省规则）

分两层，不再依赖「发布前记得改」的口头约定：

1. **运行时覆盖**：`ReqwestTransport` 构造时读 `app_data_dir/server_endpoint.json`（格式 `{"baseUrl":"https://auth.example.com"}`，明文非敏感，不存在则跳过）。生产部署方/发版流程写入该文件即可切换，无需重新编译。该文件同时是发布检查项（§10 清单第 1 条）。
2. **编译期缺省（按构建类型，2026-10-23 起）**：`resolve_base_url` 用 `cfg!(debug_assertions)` 区分——调试构建（`tauri dev`）缺省 `DEV_BASE_URL = "http://127.0.0.1:8090"` 联调本地服务端；正式构建（`tauri build`，GitHub Releases 包）在 `PLATFORM_PUBLIC = true` 时直连 `PROD_BASE_URL = "https://www.prismspace.online"`（沉浸云未开放期仍回退 DEV 缺省）。同一份代码本地开发与正式发版各得其所，内测机可用 endpoint 文件把正式包指回本地。

---

## 5. 安全存储（红线 1）

### 5.1 槽设计与扩展方式

双令牌 + user + expiresAt 以单槽 JSON 存 DPAPI（D5）：槽名 `server_auth`，经 `secret_store.rs` 的 `CryptProtectData` 加密（绑当前用户+机器，secret_store.rs:72-165），密文落 `app_data_dir/secrets.json` entries map。**任何路径不落明文文件/注册表**。token 不进 localStorage、不进 IPC 返回值、不进任何前端日志。前端可见的只有 `AuthUser`、登录态布尔与 `notice` 失效原因（D4/D8；第 1 轮 `AuthStatus.accessTokenExpiresAt` 字段取消——无消费者且与「前端不可见令牌元数据」矛盾，P8）。

`secret_store.rs` 的扩展（**两处微改，命令行为与文件格式零改动**）：
1. 把命令实现内部的 entries 读/写/删抽为 `pub(crate) fn secrets_get_raw / secrets_set_raw / secrets_clear_raw`，供 `DpapiTokenStore` 调用（复用同一 DPAPI 加密与文件格式）；
2. **新增进程级互斥锁 `pub(crate) static SECRETS_IO_MUTEX: std::sync::Mutex<()>`**（见 5.2），所有 secrets.json 读-改-写路径（含既有 `secret_get`/`secret_set` 命令）都经它串行化。

### 5.2 secrets.json 并发写保护（P2 新增）

secrets.json 是全文件读-改-写（load entries → 改 → save，secret_store.rs:199-229 命令路径与 auth 的 save/clear 同构）。若无互斥，auth 后台落盘（登录成功/单飞刷新/启动续登录，§4.2）与设置页 `secret_set`（saveSettingsFullAsync → secretSet）交错会**丢掉一方写入**；若丢的是新 refreshToken 写入，磁盘留旧票而服务端已轮换，下次启动 `auth_bootstrap` 刷新即 `token_reused` → 全设备强制下线。

**方案：单进程内一把全局锁**（跨进程不防护——本应用单实例场景，secrets.json 仅本进程与设置页 WebView 经本进程命令写入，均过同一把锁）：

```rust
// secret_store.rs
pub(crate) static SECRETS_IO_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
// 规则：任何「load_secrets → 修改 → save_secrets」序列必须持有 _guard = SECRETS_IO_MUTEX.lock()
// 覆盖：secret_get / secret_set / secret_exists 命令内部路径 + DpapiTokenStore::{save,load,clear}
```

锁粒度是整个读-改-写序列（不是仅 write）；持有时间短（本地文件读写+DPAPI，微秒~毫秒级），且命令本身 async 但锁段是同步短临界区（`std::sync::Mutex` 在 async 上下文短临界区可用，`parking_lot` 无必要）。cargo 回归测试见 §9.2（`secrets_concurrent_writes_no_lost_update`）。

### 5.3 登出与 clear 失败路径（P13 新增）

`auth_logout` 顺序与失败语义见 §7 表；要点：**`store.clear()` 失败（重试一次仍失败）时，不清内存态、不广播登出、返回 `storage_error`**。理由：若广播「已登出」而磁盘残留 refreshToken，用户预期（已登出）与下次启动实际行为（`auth_bootstrap` 读到凭据→预填已登录→刷新被服务端以 token_invalid 拒绝→又变未登录）直接矛盾，且中间态还多冒一次注定失败的刷新；宁可让用户看到「登出失败，请重试」保持登录态。服务端会话此时已被吊销（logout 请求尽力发出），磁盘残留票对安全无增量风险（30 天内 refresh 也已被服务端作废）。

---

## 6. 模块划分与文件归属

### Rust 侧（唯一认证事实源）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/auth.rs` | 新增 | `AuthTransport`/`TokenStore` trait + `ReqwestTransport`（§4.6 base_url 机制）/`DpapiTokenStore` + `TokenManager`（Shared 单飞/401 分支/持久化时序/预填契约）+ 全部 `auth_*` 命令 + `AuthError/AuthUser/AuthStatus` 类型 + cargo 单测（FakeTransport/FakeTokenStore）+ `#[ignore]` 集成测试 |
| `src-tauri/src/secret_store.rs` | 两处微改（§5.1） | ① 抽 `pub(crate)` 原始读写；② 新增 `SECRETS_IO_MUTEX` 并让既有命令过锁。命令签名/行为、文件格式零改动 |
| `src-tauri/src/lib.rs` | 修改 | `mod auth;`；`.manage(TokenManager)`（现状 10 处 manage 实数，lib.rs:1313-1322；新增第 11 处）；generate_handler!（1323-1396 行）登记 §7 全部 **11** 个命令；`show_window` spec match（266-271 行）加 `("账号登录", 420.0, 560.0)`；`open_login_window`/`settings_open_tab`/`settings_take_pending_tab` 命令 + `PendingSettingsTab`（照 `PendingOpenBook` lib.rs:610-619 模式，**窗口存在走 emit_to 不写 pending**，lib.rs:603 注释）；setup 加 `auth_bootstrap` spawn 与托盘菜单项（1406-1454 行）；login 窗重建走既有 `std::thread::spawn` 铁律（lib.rs:278-279） |
| `src-tauri/tauri.conf.json` | 修改 | `app.windows` 加 `login`：**系统装饰、420×560、resizable:true、minimizable:true、maximizable:false、visible:false、center**（照 settings 形态抄 additionalBrowserArgs；放弃无边框透明，理由 D9） |

**跨界文件（tauri.conf.json / capabilities / 窗口注册/托盘）归 Rust 侧开发者**——全是 `lib.rs`/构建期伴生物。capabilities 现状 `windows:[*]` 宽松，**MVP 不动**；未来收紧按 label 列名时必须包含 `login`（§10 清单第 4 条）。

### 前端侧

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/App.tsx` | 修改 | `label === 'login'` 分支渲染 `LoginView`（分发惯例） |
| `src/views/LoginView.tsx` | 新增 | 登录状态机：邮箱页→验证码页（倒计时+持久化恢复）/密码页签→成功→关窗；banned 阻断态（§3）；已登录兜底卡片 |
| `src/views/AccountSection.tsx` | 新增 | 设置页账号 tab：未登录空态+「登录」按钮；已登录头像/昵称/邮箱/plan+「登出」（含 storage_error 红条，§5.3）；**notice 状态条**（session_expired/session_kicked，D8）；监听 `auth-state-changed` 自刷新 |
| `src/views/Settings.tsx` | 修改 | `SettingsTab` 联合类型 + TABS 加 `{id:'account', label:'账号'}` + 条件渲染块；**双入口定位账号 tab**：挂载时 `settings_take_pending_tab()` + 运行中 `listen('settings:navigate-tab')`（P3）；conn-chip 账号状态点 |
| `src/lib/tauriBridge.ts` | 修改 | §7 命令的 invoke 封装 + `listenAuthStateChanged`/`listenSettingsNavigateTab` + 类型 |
| `src/lib/authErrorText.ts` | 新增 | §3 映射表唯一实现（纯函数，vitest 直测） |
| `src/lib/useResendCooldown.ts` | 新增（P11 补归属） | 60s 重发倒计时 hook：fake-timer 友好；**按邮箱读/写 localStorage `immersive-auth-otp-last-sent`，挂载恢复剩余**（D10）；与 LoginView 解耦便于单测 |
| `src/styles.css` | 修改 | 登录窗/账号区/notice 状态条样式（复用既有令牌与 .btn/.field 组件类） |

不建 `accountStore.ts`：令牌与登录态唯一权威在 Rust，前端账号态由事件 + `auth_get_status` 驱动（D4）。

---

## 7. IPC 契约表（两名开发者的唯一对齐依据；**本表即 generate_handler! 登记清单，共 11 命令 + 2 事件**）

通用约定：命令均 async；参数名前端 camelCase ↔ Rust snake_case 自动映射（tauriBridge.ts:151 先例）；Rust 返回/错误结构体一律 `#[serde(rename_all = "camelCase")]`。错误统一为 `AuthError`（Result 的 Err 侧；Tauri 2 将实现了 Serialize 的 Err 序列化，前端 `invoke().catch(e => e)` 拿到对象）：

```ts
// tauriBridge.ts 导出类型（与 Rust 结构体字段一字不差）
interface AuthError   { code: string; message: string; httpStatus: number | null; retryAfterSeconds: number | null }
interface AuthUser    { id: string; email: string; nickname: string; plan: string; createdAt: string }
interface AuthSession { user: AuthUser }                    // 登录/刷新成功只回 user，不含任何令牌（D4）
type AuthNotice = 'session_expired' | 'session_kicked' | null
interface AuthStatus  { loggedIn: boolean; user: AuthUser | null; notice: AuthNotice }  // 无 token 元数据（P8）
interface LogoutOutcome { serverRevoked: boolean }
```

本地伪码（Rust 生成，非服务端）：`network_error` / `storage_error` / `parse_error` / `unknown`。

| # | 命令 | 参数（前端侧名） | 成功返回 | 错误（AuthError.code 可能值） | 语义要点 |
|---|---|---|---|---|---|
| 1 | `auth_send_otp` | `email: string` | `void`（服务端恒 `{ok:true}`） | `rate_limited`(429, retryAfterSeconds=服务端值)、`service_unavailable`(503)、`validation_error`、`network_error`、`parse_error` | POST `/v1/auth/otp/request`；成功前端进验证码页并启动 60s 倒计时（持久化时间戳，D10）；不据 200 判断账号存在 |
| 2 | `auth_verify_otp` | `email: string`, `code: string`（6 位数字） | `AuthSession` | `otp_invalid`(400)、`banned`(403)、`rate_limited`(429)、`validation_error`、`network_error`、`storage_error` | POST `/v1/auth/otp/verify`；**device 由 Rust 填** `{platform:"windows", name: COMPUTERNAME 截 64 字符, fallback "Windows-PC"}`，前端不传；成功 = 先 `store.save`（经 §5.2 锁）落盘 → 更新内存态 → emit `auth-state-changed` → 返回；随后 fire-and-forget spawn `auth_fetch_server_config`（失败仅 log，D7） |
| 3 | `auth_login_password` | `email: string`, `password: string` | `AuthSession` | `invalid_credentials`(401)、`banned`(403)、`rate_limited`(429)、`validation_error`、`network_error`、`storage_error` | POST `/v1/auth/login`，device 同上；成功路径同上（落盘→emit→返回） |
| 4 | `auth_logout` | 无 | `LogoutOutcome` | `storage_error`（**且此时未清内存/未广播**，§5.3）；服务端错误被吞为 `serverRevoked:false` | POST `/v1/auth/logout`(Bearer，尽力) → `store.clear()` 失败重试一次 → 仍失败：返回 Err(storage_error)，保持登录态；clear 成功：清内存态 + emit(loggedIn:false, notice:null)。幂等可重入 |
| 5 | `auth_get_status` | 无 | `AuthStatus` | 无（不会 Err） | 内存态优先，空则回读 store 并预填（§4.4 唯一判据）；启动早期可反复调用 |
| 6 | `auth_refresh_now` | 无 | `AuthSession` | fatal 三码（此时凭据已清）、`network_error` 等 | 走单飞 `refresh()`（§4.2）；启动 bootstrap 与账号区「刷新」共用 |
| 7 | `auth_fetch_me` | 无 | `AuthUser` | fatal 三码（invalid/reused→已清凭据+notice）、`network_error` 等 | GET `/v1/me` 经 `with_auth`（可触发单飞刷新与重放，§4.3）——带鉴权请求样板 |
| 8 | `auth_fetch_server_config` | 无 | `serde_json::Value`（`{gateway, models, voice, features}` 原样） | fatal 三码、`network_error` 等 | GET `/v1/me/config` 经 `with_auth`；成功原样落盘 `app_data_dir/server_config.json`（明文，非敏感）并返回；MVP 不解析消费 |
| 9 | `open_login_window` | 无 | `void` | 不会 Err（失败 log） | `show_window("login")` 既有路径（含后台线程重建 + REBUILD_BROWSER_ARGS，lib.rs:258/37） |
| 10 | `settings_open_tab` | `tab: string`（"account"） | `void` | 不会 Err | **双路径**（P3，照 open_reader_book lib.rs:604-613）：settings 窗已存在 → `emit_to("settings", "settings:navigate-tab", tab)`；不存在 → 写 `PendingSettingsTab` 再 show 窗口 |
| 11 | `settings_take_pending_tab` | 无 | `string \| null`（取走后清空） | 不会 Err | Settings 挂载时调用**恰好一次**；take 后清空防陈旧（lib.rs:603 同理） |

事件（tauriBridge 封装，返回 UnlistenFn 供 useEffect 清理）：

| 事件名 | 载荷 | 广播方式 | 触发时机 | 前端封装 |
|---|---|---|---|---|
| `auth-state-changed` | `AuthStatus` | `app.emit` 全窗广播（有意：账号态影响任意窗口） | 登录成功、登出成功、bootstrap 预填/续期/失效、`with_auth` 清凭据后 | `listenAuthStateChanged(cb)` |
| `settings:navigate-tab` | `string`（tab id） | `emit_to("settings")` | `settings_open_tab` 在 settings 窗已存在时 | `listenSettingsNavigateTab(cb)`（Settings.tsx 运行中监听，P3） |

---

## 8. 界面与流程

### 8.1 登录主流程（验证码；服务端文档 §8 对齐）

```
[设置页账号tab/托盘「账号登录」] ──> open_login_window ──> login 窗（label=login）
[邮箱输入页] ──「获取验证码」──> auth_send_otp ──200──> [验证码页：6位输入 + 重发60s倒计时(持久化恢复)]
                │                                      │
                ├─503 service_unavailable → inline 稍后再试    ├─「登录」→ auth_verify_otp
                ├─429 → 按钮倒计时禁用                       ├─400 otp_invalid → inline 清码重输/重发
                └─network_error → inline 可重试               ├─403 banned → 阻断+「返回修改邮箱」
                                                          └─200 → 落盘+emit → 「登录成功」→ 自动关窗
[密码页签] email+password ──「登录」──> auth_login_password（401 invalid_credentials → inline；403 banned → 阻断）
[启动] auth_bootstrap: load → 预填+emit已登录 → 单飞 refresh → 成功 emit / fatal 清+emit(loggedIn:false, notice) / 网络错保留
[账号 tab 顶部状态条] notice=session_expired|session_kicked → warn 条「登录已失效/凭据异常复用…请重新登录」（D8）
```

### 8.2 界面清单（原型必须呈现 → 见 `prototypes/windows-login-2026-09-26.html`，第 2 轮补齐 P10/P12 项）

| # | 界面/状态 | 要素 |
|---|---|---|
| 1 | 邮箱输入页 | 页签（验证码登录/密码登录）、邮箱输入+校验、「获取验证码」主按钮、副文案 |
| 2 | 验证码页 | 「验证码已发送至 {email}」、6 位分格输入、「登录」、重发 60s 倒计时、「换邮箱」返回 |
| 3 | 密码页签 | 邮箱+密码、「登录」；无忘记密码链接（§1.2 后置） |
| 4 | 错误态 ×4（服务端） | otp_invalid / invalid_credentials / rate_limited(N 秒倒计时) / service_unavailable，文案见 §3 |
| 5 | **错误态 ×3（P12 补）** | banned（红条+提交禁用+「返回修改邮箱」）、network_error（红条+按钮恢复可重试）、storage_error（红条+流程中止） |
| 6 | 登录成功态 | 短暂成功反馈 → 自动关窗提示 |
| 7 | 设置页账号区·未登录 | 空态卡+「登录」按钮 |
| 8 | **设置页账号区·未登录+失效状态条（P10 补）** | warn 色状态条（notice=session_expired/session_kicked 两文案）+ 空态卡 |
| 9 | 设置页账号区·已登录 | 头像圆、昵称、邮箱、plan 徽标、当前设备行（只读）、「登出」btn-danger |

### 8.3 与现有代码衔接点（file:line 为本轮/调研核实）

| 衔接点 | 位置 | 接法 |
|---|---|---|
| 多窗口分发 | `src/App.tsx` label 分支 | 加 `label === 'login'` 一个分支 |
| 设置 tab 体系 | `src/views/Settings.tsx`（TABS/handleClose=hide 实测核对） | TABS 加 account；挂载 take + 运行中 listen 双入口（P3） |
| 命令桥 | `src/lib/tauriBridge.ts` | 加 §7 封装；不暴露 secret_get/set 给登录 UI（D4） |
| 命令登记 | `src-tauri/src/lib.rs:1323-1396` generate_handler! | §7 表 11 命令全列（P5 已补 take_pending_tab） |
| 窗口显示/重建 | `lib.rs:258-301`（spec match 266-271、builder 固定 resizable(true) 290、spawn 铁律 278-279、REBUILD_BROWSER_ARGS 37） | login 窗规格对齐重建 builder（D9），spec match 加一行即零分叉 |
| 窗口存在时即时导航 | `lib.rs:601-619`（open_reader_book 双路径 + 603 行注释） | `settings_open_tab` 照抄双路径（P3） |
| HTTP 先例 | `translation.rs:359-371`、`web_extract.rs:237-242` | auth.rs 形状照此 |
| DPAPI | `secret_store.rs`（entries 22-28、原子写 65-70、槽名规则 181-195、命令 199-229） | 单槽 server_auth + §5.2 写锁两处微改 |
| 托盘菜单 | `lib.rs:1406-1454` | 「账号登录」项 |

---

## 9. 测试计划

### 9.1 vitest（前端，mock tauriBridge；跑法 `npm --prefix immersive-translator-windows test`）

| 文件 | 用例点 |
|---|---|
| `src/lib/authErrorText.test.ts` | §3 表逐 code 断言文案与 kind（inline/statusbar/silent）；rate_limited 用 retryAfterSeconds 插值；本地伪码四条 |
| `src/lib/useResendCooldown.test.ts` | fake timers：60→0 递减、归零恢复、重发重置；**持久化恢复：预置 localStorage 时间戳 now-20s → 挂载剩余 40s；now-70s → 无倒计时**（P14） |
| `src/views/LoginView.test.tsx` | 状态机：邮箱非法→按钮禁用；send_otp ok→验证码页+倒计时；otp_invalid→停+清码；invalid_credentials→停密码页；**banned→提交禁用+「返回修改邮箱」回邮箱页且错误清除（P12）**；**network_error→按钮恢复（P12）**；**storage_error→红条且不进成功页（P12）**；rate_limited→按钮倒数到 0 恢复；成功→成功态+关窗 mock |
| `src/views/AccountSection.test.tsx` | 未登录→空态+按钮调 open_login_window；已登录→昵称/邮箱/plan；**notice=session_expired/session_kicked→渲染对应 warn 状态条（P10）**；mock `auth-state-changed` 登出→自刷新；登出 auth_logout Err(storage_error)→**保持已登录态+红条（P13）** |
| `src/views/Settings.test.tsx`（增量） | **挂载调 settings_take_pending_tab 返回 "account"→定位账号 tab；listen('settings:navigate-tab') 收 "account"→切 tab（P3）** |
| `src/lib/tauriBridge.test.ts` | 契约测试：mock invoke 断言 11 命令参数名 camelCase、返回形状与 §7 一致 |

### 9.2 cargo 单测（`auth.rs`/`secret_store.rs` tests 模块，FakeTransport + FakeTokenStore；跑法 `cargo test --manifest-path immersive-translator-windows/src-tauri/Cargo.toml`）

| 用例 | 断言 |
|---|---|
| `refresh_single_flight_concurrent_401` | 3 个并发 `with_auth` 同收 401 token_expired：FakeTransport 记录 `/v1/auth/refresh` 恰 **1 次**；3 个请求全部以新 accessToken 重放成功 |
| `refresh_new_generation_after_completion`（P1 回归） | 两次**串行** refresh → transport 收到 **2 次** refresh 调用（第二次不被已完成的旧共享句柄吞掉——防「共享已消费 receiver」类回归） |
| `refresh_persist_before_replay` | FakeTokenStore/FakeTransport 各记全局序号：重放请求到达 transport 时 `save(新对)` 已发生（序号比较，红线 3） |
| `only_token_expired_triggers_refresh` | 401 token_invalid：refresh 端点 **0 次**调用；FakeTokenStore 收到 clear；返回会话失效 |
| `token_reused_clears_credentials` | refresh 回 401 token_reused：store 清空；`get_access_token` 此后报未登录 |
| `proactive_refresh_absolute_margin` | 构造 `expires_at = now + 100`（< REFRESH_MARGIN_SECS=180）：`get_access_token` 先触发 1 次 refresh；`expires_at = now + 400`：不触发（P7 绝对阈值） |
| `rate_limited_surfaced_no_retry` | 429 + retry-after:37：Err 带 retryAfterSeconds=37；transport 无第二次请求 |
| `login_success_persists_before_return` | `auth_verify_otp` 路径：save 序号先于命令返回 |
| `logout_always_clears_local` | transport 抛 network_error：logout 仍 clear，返回 serverRevoked:false |
| `logout_clear_failure_keeps_state`（P13） | FakeTokenStore.clear 注入失败（重试一次仍败）：logout 返回 Err(storage_error)；内存态仍 Some；**无登出事件**；clear 恢复成功后重试 logout → 正常登出 |
| `bootstrap_offline_keeps_logged_in`（P4） | store 有数据 + transport 网络错：refresh 失败但 state 仍 Some；`auth_get_status` → loggedIn:true |
| `get_status_prefills_from_store`（P4） | state 空、store 有：get_status 预填并返回 loggedIn:true |
| `secrets_concurrent_writes_no_lost_update`（P2，secret_store.rs） | 两线程交替对 secrets.json 各写不同槽（auth 形状 save 与 set 形状各一）若干轮，最终两槽都在盘上（锁的正确性主由代码审查保证，此为回归信号） |

### 9.3 `#[ignore]` 本地联调（需 `http://127.0.0.1:8090` 存活——服务端调研 liveProbe 已确认；唯一时间戳邮箱 `auth_probe_{unix_ts}@test.local`；跑法 `cargo test -- --ignored`）

1. `register → login → me → refresh 轮换 → 复用 → logout` 全链：register 201 → login 200 → GET me 200 → refresh 200（新对落盘）→ **旧 refreshToken 再 refresh → 401 token_reused** → 旧 accessToken GET me → 401 → logout（新 accessToken）204 → 再 GET me → 401。
2. `otp_flow`：`otp/request`（不存在邮箱）→ 200 `{ok:true}`（防枚举）→ `otp/verify` 错码 `000000` → 400 otp_invalid。
3. 可选（会真实触发限流，独立函数标注）：同邮箱连发 `otp/request` ≥4 → 429 且带 retry-after。

### 9.4 六项完成判定对照表

| 判定（服务端文档 §10） | 实现载体 | 证明 |
|---|---|---|
| 验证码登录（含自动建号） | `auth_send_otp`/`auth_verify_otp` + LoginView 验证码页 | 9.3-2 联调 + 9.1 LoginView 用例 + 演示步骤 A |
| 密码登录 | `auth_login_password` + 密码页签 | 9.3-1 前两步 + 9.1 |
| 单飞刷新 | `TokenManager::refresh`（Shared+代数，§4.2） | 9.2 `refresh_single_flight_concurrent_401` + `refresh_new_generation_after_completion` |
| 401 分支（expired 刷 / invalid·reused 清） | `with_auth` code 分支 | 9.2 `only_token_expired_triggers_refresh` / `token_reused_clears_credentials` |
| 429 提示 | retry-after 透传 + 前端倒计时 | 9.2 `rate_limited_surfaced_no_retry` + 9.1 authErrorText/LoginView |
| 登出清凭据 | `auth_logout`（clear 失败保态，§5.3） | 9.2 `logout_always_clears_local` / `logout_clear_failure_keeps_state` + 9.3-1 尾段 |

演示步骤 A（验收脚本）：托盘「账号登录」→ 新邮箱收码 → 登录 → 设置页账号区出现昵称/plan →「登出」→ 回空态；**断网重启应用 → 账号区仍显示已登录（P4 契约）→ 联网后自动续期**；重启应用 → 静默续登录。

---

## 10. 风险、开放问题与发布检查清单

| # | 风险/问题 | 缓解 |
|---|---|---|
| R1 | 新命令漏登记 generate_handler! | **§7 表 11 命令即登记清单**（P5 后表与清单严格一致）；tauriBridge 契约测试会以 unknown command 失败暴露 |
| R2 | login 窗重建分叉 | D9：login 窗规格与通用 builder 对齐（系统装饰+resizable:true），spec match 只加尺寸一行，零分叉 |
| R3 | capabilities 未来收紧漏 login | §10 清单第 4 条；本期不动 |
| R4 | 本机时钟漂移使惰性阈值时点不准 | 权威信号是服务端 401 token_expired（文档 §9），主动刷新只是优化；被动兜底永在 |
| O1 | 生产 baseUrl 具体值未定 | §4.6 机制已落（endpoint.json 覆盖+dev 缺省），值待服务端部署方提供（开放问题保留，机制不再是口头约定） |
| O2 | `me/config` 消费契约属 M2 | MVP 只落盘 |
| O3 | 无密码账号在密码页签必然 invalid_credentials | 文案已引导验证码；「设置密码」入口随改密后置项评估 |

**发布检查清单**（真实发布链路已存在：updater endpoints + createUpdaterArtifacts + signCommand，tauri.conf.json 实测核对；本清单与登录功能一起进入发布流程）：
1. `server_endpoint.json` 写入生产 `baseUrl`（或确认随安装包分发的缺省值已切换）——漏掉则真实用户登录/刷新全部 network_error（P6）；
2. `cargo build --release --features custom-protocol`（Cargo.toml:17-22 注释，不发 custom-protocol 的 exe 会连 devUrl）；
3. updater 签名链不误改（signCommand + latest.json）；
4. capabilities 若从 `windows:[*]` 收紧，逐 label 列名必须含 `login`；
5. 发布前人工过一遍演示步骤 A（§9.4）在**生产 baseUrl** 下可走通。

---

## 11. 后续迭代章节（设备管理 / 改密 / 忘记密码）

- **设备管理**：账号区加「登录设备」卡片，`GET /v1/auth/devices` 列表，行内「下线」调 `DELETE /v1/auth/devices/{id}`（踢自己 = 登出路径复用）。
- **修改/设置密码**：`POST /v1/auth/password-change`（验证码建号不传 currentPassword）；成功后全会话吊销 → 清凭据引导重新登录（复用 token_invalid 通路）。
- **忘记密码**：密码页签加链接 → `POST /v1/auth/password-reset/request`（恒 200）→ 提示查收；不做 confirm 页。
- 三者复用本期 transport/令牌管理与账号区壳。

---

## 12. 评审回应（第 1 轮 15 条意见逐条；第 3 轮位置索引见本节末）

### 第 3 轮说明

第 3 轮收到的评审意见与第 2 轮**逐字相同**（15 条 problems 与 restatement 完全一致，restatement 末尾复核声明「git status 确认工作区与评审时一致（同两个未跟踪文件，HEAD 9283c48）」）。第 2 轮修订已全部落盘为本版（两个未跟踪文件即本设计与配套原型），下表为**逐条意见 → 本版修订位置**索引，供评审直接定位；本轮仅新增 §4.2 `'static` 实现注记（自查发现 `self.do_refresh().boxed()` 按字面不满足 `BoxFuture<'static>`，已补 Arc 持有前提，与 P1 同类的「按字面不可实现」问题在此堵死）。

| 意见 | 修订位置（本版） | 对应测试/原型 |
|---|---|---|
| P1 单飞原语不可实现 | §4.1 inflight 类型 `(u64, SharedRefresh)` + §4.2 全节（Shared + 代数清槽 + 并发语义 4 条 + 'static 注记） | cargo：`refresh_single_flight_concurrent_401`、`refresh_new_generation_after_completion`（§9.2） |
| P2 secrets 丢更新 | §5.2（SECRETS_IO_MUTEX，锁整段读-改-写，覆盖既有命令）+ §5.1 微改清单第 2 项 | cargo：`secrets_concurrent_writes_no_lost_update`（§9.2，已声明为回归信号） |
| P3 settings 定位不工作 | D2/§6 Settings.tsx 行（挂载 take + 运行中 listen 双入口）+ §7 命令 10（emit_to 双路径，引 lib.rs:604-613/603 先例） | vitest：Settings.test.tsx 增量两用例（§9.1） |
| P4 启动内存态契约 | §4.4（预填→emit→异步刷新；网络错保留；get_status 同判据懒预填） | cargo：`bootstrap_offline_keeps_logged_in`、`get_status_prefills_from_store`（§9.2）；演示步骤 A 补断网步骤（§9.4） |
| P5 take 命令漏出契约表 | §7 表第 11 条 + 标题明示「11 命令 + 2 事件即登记清单」 | tauriBridge 契约测试覆盖 11 命令（§9.1） |
| P6 base_url 无机制 | §4.6（server_endpoint.json 运行时覆盖 + dev 缺省）+ §10 发布检查清单第 1/5 条 | 清单第 5 条要求生产 baseUrl 下人工过验收脚本 |
| P7 80% 算不出 | D6/§4.1 常量 `REFRESH_MARGIN_SECS=180`（绝对阈值，二选一已写死） | cargo：`proactive_refresh_absolute_margin` 两档断言（§9.2） |
| P8 expiresAt 自相矛盾 | §7 `AuthStatus={loggedIn,user,notice}`（字段已删，notice 是 P10 载体） | §3 表 statusbar 呈现 |
| P9 重建路径分叉 | D9（login 窗=系统装饰+resizable:true 的 settings 同形态；已核对 builder lib.rs:283-295）+ §6 tauri.conf.json 行 | spec match 只加 `("账号登录", 420.0, 560.0)` 一行 |
| P10 toast 无宿主 | D8（notice 状态条方案，kind=inline/statusbar/silent）+ §3 呈现列全改 | vitest：AccountSection notice 两文案用例（§9.1）；原型场景 13 |
| P11 useResendCooldown 无归属 | §6 前端表 `src/lib/useResendCooldown.ts` 行（含 D10 持久化职责） | §9.1 专项测试文件 |
| P12 原型只覆盖 4 错误态 | §8.2 表第 5/8 项 + 原型场景 9（banned 可点「返回修改邮箱」）/10（network_error）/11（storage_error）/13（失效状态条，可切换两文案） | 原型 rail「错误 · 封禁与本地伪码」组 |
| P13 登出 clear 失败 | §5.3 + §7 命令 4（clear 重试一次仍败→保态/不广播/storage_error） | cargo：`logout_clear_failure_keeps_state`；vitest：登出失败保持登录态用例 |
| P14 倒计时丢失 | D10（localStorage 按邮箱时间戳，cap 10，挂载恢复） | vitest：useResendCooldown 两档恢复断言（§9.1） |
| P15 基数错误 | §6「10 处，新增第 11 处」+ 附录 B 核对清单（grep 实测留痕） | 附录 B 前两行 |

无被驳回的意见：15 条全部经第 2 轮代码核对属实并已修订；第 3 轮无新增意见。

### 第 1 轮 15 条逐条回应（第 2 轮交付，内容不变）

| # | 意见 | 回应 |
|---|---|---|
| P1 (high) 单飞 oneshot 单消费者不可实现 | **采纳，§4.2 重写。** 改用 `futures_util::future::Shared`（依赖已在 Cargo.toml:43）+ 代数计数清槽：clone 是多消费者句柄、无 RecvError；完成方按代数校验清槽，新一代刷新不会被旧句柄吞掉；并新增回归测试 `refresh_new_generation_after_completion`（两次串行 refresh 必须 2 次 HTTP）。极窄窗口内共享到「刚完成的同一代结果」是最新令牌对而非旧票，语义安全（§4.2 逐条说明）。 |
| P2 (medium) secrets.json 读-改-写丢更新 | **采纳，§5.2 新增。** `secret_store.rs` 增 `pub(crate) SECRETS_IO_MUTEX`，auth 落盘与既有 secret_get/secret_set 命令全部过锁（锁住整个读-改-写序列）；新增 `secrets_concurrent_writes_no_lost_update` 回归测试；并诚实声明锁正确性主由审查保证、测试是回归信号。 |
| P3 (medium) PendingSettingsTab 在 hide 不销毁的 settings 窗上失效 | **采纳。** `settings_open_tab` 改双路径（窗口存在 → `emit_to("settings","settings:navigate-tab")`；不存在 → pending），照 `open_reader_book`（lib.rs:604-613）与其 603 行注释；Settings.tsx 改动清单补「挂载 take + 运行中 listen 双入口」，vitest 增对应用例。已实测核对 Settings handleClose=hide。 |
| P4 (medium) 启动续登录内存态契约未定义 | **采纳，§4.4 重写。** 契约写死：load 成功即预填内存态并 emit 已登录（磁盘有 30 天 refresh 即视为已登录，离线也显示已登录）；refresh 网络错保留预填态；`auth_get_status` 用同一判据懒预填。新增 `bootstrap_offline_keeps_logged_in` / `get_status_prefills_from_store` 两个 cargo 用例，演示步骤 A 补「断网重启仍已登录」步骤。 |
| P5 (medium) settings_take_pending_tab 漏出契约表 | **采纳。** 补入 §7 表（第 11 条）与 settings:navigate-tab 事件行；§7 标题明示「本表即登记清单，共 11 命令 + 2 事件」。 |
| P6 (medium) base_url 无机制保障 | **采纳，§4.6 重写 + §10 发布清单。** 机制：`app_data_dir/server_endpoint.json` 运行时覆盖 + dev 常量缺省；流程：发布检查清单第 1 条（与 updater 签名/custom-protocol 并列）+ 清单第 5 条要求生产 baseUrl 下人工过验收脚本。具体生产域名仍开放（O1），但不再是口头约定。 |
| P7 (medium) 80% 寿命从 StoredAuth 算不出 | **采纳，选绝对阈值。** `REFRESH_MARGIN_SECS = 180`（常量进契约 §4.1），`now+180 >= expires_at` 即刷；不新增 issued_at 字段，900s 寿命下等价于 80% 处刷新。测试改为两档断言（100s 触发/400s 不触发）。 |
| P8 (low) AuthStatus.accessTokenExpiresAt 与 §5 矛盾 | **采纳。** 删除该字段，AuthStatus={loggedIn, user, notice}；notice 是失效提示（session_expired/session_kicked）的载体（配合 P10）。 |
| P9 (low) 重建路径 resizable(true) 与 login 窗 resizable:false 分叉 | **采纳，D9。** 已实测核对公共 builder 固定 `.resizable(true)`、无 decorations/transparent（lib.rs:283-295）；login 窗改为系统装饰+resizable:true 的 settings 同形态（420×560），spec match 加一行即与原窗一致。放弃 onboarding 无边框形态（那只对一次性首启引导合理）。 |
| P10 (low) toast 无宿主 | **采纳，D8。** 已核实 `src/ui/` 仅 ConfirmDialog/icons，reader 的 toast 是阅读室局部实现。方案：不做全局 toast；失效提示由 `AuthStatus.notice` 携带，**持久渲染在账号 tab 顶部 warn 状态条**（打开设置必见、无窗口时不打扰、登录成功清除），conn-chip 账号点反映登录态。§3 表的呈现列全部改为 inline/statusbar/silent。原型补状态条场景（§8.2-8）。 |
| P11 (low) useResendCooldown 有测试无源文件 | **采纳。** §6 前端表补 `src/lib/useResendCooldown.ts` 行（含 D10 持久化职责）。 |
| P12 (low) 原型/界面清单只覆盖 4 错误态 | **采纳。** §8.2 补第 5 项（banned/network_error/storage_error）与第 8 项（失效状态条）；原型加场景 9-11 与场景 13（见原型 rail），banned 交互（禁用+返回修改邮箱）在原型中可点。 |
| P13 (low) 登出 clear 失败路径未定义 | **采纳，§5.3 + §7-4。** 规格：clear 重试一次仍失败 → 返回 Err(storage_error)、**不清内存、不广播登出**，账号区红条「登出失败请重试」；安全性论证（服务端会话已吊销，磁盘残留票无增量风险）；新增 cargo 用例 `logout_clear_failure_keeps_state`。 |
| P14 (low) 60s 倒计时关窗丢失 | **采纳，D10。** 按邮箱记发送时间戳于 localStorage（`immersive-auth-otp-last-sent`，cap 10 条），挂载恢复剩余倒计时；useResendCooldown 单测补两档恢复断言。 |
| P15 (low) 基数错误 | **采纳。** 已实数核对：manage 10 处（lib.rs:1313-1322）、secret_store 内嵌测试 8 个（grep `#[test]`）。§6 更正为「10 处，新增第 11 处」；调研输入的 13/9 系口误，附录代码核对清单留痕。 |

无被驳回的意见：15 条全部经本轮代码核对属实并已修订。

---

## 附录 A：输入材料引用

- 服务端契约：`client-auth-integration.md` §2/§4/§5/§6/§7/§8/§10——本文 §3/§4/§7/§9 直接对齐
- 服务端 API 参考：`api.md`；服务端方案：`docs/server-architecture-plan-2026-09-22.md`（M1/M2）
- 客户端现状：调研输入 + 本轮实测核对（见附录 B）；测试基线（npm test 483/cargo 76/build 通过）为调研已执行结果，本轮未复跑
- 设计语言：`styles.css:7-51`（视觉令牌，原型 1:1 拷贝）；原型范本 onboarding-ux1 / speak-score-report

## 附录 B：代码核对（2026-09-27 实际执行，修订轮新增）

| 核对项 | 命令/方式 | 结果 |
|---|---|---|
| `.manage(` 处数 | `grep -c "\.manage(" lib.rs` | **10**（lib.rs:1313-1322；调研称 13 系口误） |
| secret_store 内嵌测试数 | `grep -c "#\[test\]" secret_store.rs` | **8**（调研称 9 系口误） |
| show_window 重建 builder | 读 lib.rs:258-301 | spec match 仅 settings/history/reader 三项；公共 builder 固定 `.resizable(true)`(290)、`.maximizable(false)`、系统装饰、无 transparent 参数 → P9 属实 |
| 窗口存在时事件导航先例 | 读 lib.rs:601-619 | `open_reader_book`：存在→`emit_to("reader","reader:open-book")`；不存在→`PendingOpenBook`+挂载 take；603 行注释「窗口存在时不写 pending，避免陈旧请求」→ P3 属实 |
| Settings 关闭行为 | 读 Settings.tsx handleClose | `await getCurrentWindow().hide()`（hide 不销毁，挂载一次）→ P3 前提属实 |
| settings 窗预建 | 读 tauri.conf.json windows 段 | settings `visible:false` 预建 + `resizable:true` 系统装饰（login 规格照此，D9） |
| ui 共享组件 | `ls src/ui/` | 仅 ConfirmDialog.tsx、icons.tsx（无共享 toast）→ P10 属实 |
| toast 现存实现 | `grep -ri toast src/ -l` | 仅 reader 5 个文件（阅读室局部），无跨窗共享实现 |
| futures-util 依赖 | `grep futures Cargo.toml` | `futures-util = "0.3"`（Cargo.toml:43）→ Shared 单飞方案无需新增依赖 |
| updater 发布链路 | 读 tauri.conf.json plugins.updater/bundle | endpoints×3 + createUpdaterArtifacts + signCommand 属实 → P6 发布清单成立 |
