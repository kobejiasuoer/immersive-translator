//! 公版书发现目录（升级计划 B2，计划书 §3/§6）：GET /v1/books 目录浏览 +
//! GET /v1/books/{id}/download 镜像下载，供阅读室「发现」页选书导入
//! （下载的 EPUB 字节喂给前端 parseEpub 走既有导入管线）。
//!
//! - 鉴权口径（对 with_auth 的有意偏离）：两端点服务端匿名只读
//!   （books.controller.ts 明言「浏览目录不应强制注册」，无 JwtAuthGuard）。
//!   with_auth 会先取票、未登录零网络即 unauthorized（auth.rs），照抄等于
//!   把匿名端点变成强制登录。改用 translation.rs test_connectivity 同款
//!   可选鉴权：取到票就带 Bearer（token 仅限流配额加成），取不到走匿名；
//!   不做 401 刷新重放（token 与匿名协议无关）。未登录口径与 A1 取「未登录
//!   不崩、能力照常」之实：A1 场景目录端点需登录、未登录 reject 后前端静默
//!   降级到内置+用户场景；B1 端点明确匿名，故 B2 未登录 = 发现页完整可用
//!   （不隐藏/不置灰/不提示登录）。
//! - 非 2xx 是数据不是错误（sync.rs 同口径）：目录复用 SyncHttpText 原样
//!   透传；下载用 BooksDownloadResult——200 的 body 是 EPUB 字节 base64，
//!   其余状态的 body 是服务端 AppError 错误信封 JSON 文本（服务端先判
//!   status 再分流，非 2xx 不回二进制）。只有网络失败/沉浸云未开放才
//!   reject，由前端给中文原因。
//! - 下载落盘拍板（案A·base64 字节跨 IPC、不落盘、不做 Rust sha256）：
//!   base64 是本仓唯一生产验证的 Rust→前端大载荷形态（screenshot.rs 全屏
//!   PNG）；全仓缓存无清理先例、EPUB 导入后正文已进 readerStore，逐本落盘
//!   只会无限膨胀 app_data_dir；完整性由前端 SubtleCrypto SHA-256 +
//!   parseEpub JSZip 损坏检测双保险。
//! - base URL（auth.rs 禁改下的唯一通路）：resolve_base_url 全私有，唯一
//!   pub 口是 gateway_endpoint——返回 `{base}/v1/chat/completions` 且自带
//!   platform_available 门控（沉浸云未开放期返回 None，发现页随之关闭）。
//!   剥掉固定后缀还原 base；auth.rs 若改后缀，这里必须同步（见
//!   api_base_url 注释）。

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::auth::{emit_fatal_if_needed, AuthError, TokenManager};
use crate::sync::SyncHttpText;

/// 目录请求超时（小 JSON 应答，对齐 auth.rs 传输层 30s）。
const LIST_TIMEOUT_SECS: u64 = 30;
/// 下载超时（单本最大 18.4MB 的慢网余量，对齐 ocr.rs 模型下载 300s）。
const DOWNLOAD_TIMEOUT_SECS: u64 = 300;
/// 书目 id 限长（与服务端 BOOK_ID_MAX_LENGTH 对齐：books.constants.ts）。
const BOOK_ID_MAX_LENGTH: usize = 128;
/// 下载进度节流阈值：每满 256KB 报一次，防 IPC 洪泛。
const PROGRESS_CHUNK: u64 = 262_144;
/// 下载进度事件名（前端 tauriBridge onBooksDownloadProgress 监听）。
const DOWNLOAD_PROGRESS_EVENT: &str = "books:download:progress";

// ---------------------------------------------------------------------------
// IPC 可见类型（字段与前端 src/lib/tauriBridge.ts 导出类型一字不差）
// ---------------------------------------------------------------------------

/// 一次 /v1/books/{id}/download 请求的结果。`body` 语义按 `status` 分叉：
/// 200 = EPUB 字节 base64；其余 = 服务端 AppError 错误信封 JSON 文本
/// （本地预校验不合法时也是同款信封、status=400，不发网络）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BooksDownloadResult {
    pub status: u16,
    pub body: String,
    pub retry_after_seconds: Option<u64>,
}

// ---------------------------------------------------------------------------
// 纯函数（可测逻辑全部抽这里，免构造 AppHandle/网络）
// ---------------------------------------------------------------------------

/// 本地伪码构造（auth.rs 的 AuthError::local 为模块私有，照 sync.rs 直构）。
fn local_error(code: &str, message: impl Into<String>) -> AuthError {
    AuthError {
        code: code.to_string(),
        message: message.into(),
        http_status: None,
        retry_after_seconds: None,
    }
}

/// 书库 API base（auth.rs 禁改下的唯一通路）：resolve_base_url 与常量全
/// 私有，唯二 pub 口是 gateway_endpoint 与 get_access_token。gateway_endpoint
/// 返回 `{base}/v1/chat/completions`（自带 platform_available 门控——沉浸云
/// 未开放期返回 None），剥掉固定后缀 `/v1/chat/completions` 还原 base。
/// 后缀是 auth.rs 钉死的网关别名，若那边变更，这里必须同步修改。
fn api_base_url(manager: &std::sync::Arc<TokenManager>) -> Option<String> {
    manager
        .gateway_endpoint()
        .and_then(|g| g.strip_suffix("/v1/chat/completions").map(str::to_string))
}

/// 书目 id 本地预校验（防 URL 拼接穿越第一道）：与服务端
/// BOOK_ID_PATTERN（`^[a-z0-9]+(-[a-z0-9]+)*$`）+ 限长 128 对齐——白名单
/// 正则排除一切路径字符（/ \ . 与大小写变体）；服务端另有 zod +
/// resolve+startsWith 双保险，这里是客户端第一道，不合式直接不发网络。
fn validate_book_id(id: &str) -> Result<(), String> {
    let shape_ok = !id.is_empty()
        && id.len() <= BOOK_ID_MAX_LENGTH
        && id.split('-').all(|seg| {
            !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if shape_ok {
        Ok(())
    } else {
        Err(format!(
            "书目 id 不合法（只允许小写字母/数字/连字符，且不超过 {BOOK_ID_MAX_LENGTH} 字符）"
        ))
    }
}

/// 目录查询键值对（不手拼字符串：q 是用户输入有编码/注入坑，交给
/// reqwest 内置 serde_urlencoded 自动百分号编码）。规则：五筛选 trim 非空
/// 才进对（空串/纯空白过滤省一次 400 往返，服务端 zod 本就 trim+min(1)），
/// 值随 trim 后发送与服务端 trim 语义等价；长度越界不拦（服务端 400 有
/// 文案，原样透传）；分页对齐服务端默认 page=1 / perPage=20 上限 100。
fn build_query_pairs(
    q: &Option<String>,
    language: &Option<String>,
    category: &Option<String>,
    source: &Option<String>,
    grade: &Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (key, value) in [
        ("q", q),
        ("language", language),
        ("category", category),
        ("source", source),
        ("grade", grade),
    ] {
        if let Some(v) = value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            pairs.push((key.to_string(), v.to_string()));
        }
    }
    pairs.push(("page".to_string(), page.unwrap_or(1).max(1).to_string()));
    pairs.push((
        "perPage".to_string(),
        per_page.unwrap_or(20).clamp(1, 100).to_string(),
    ));
    pairs
}

/// 下载进度节流：距上次已上报字节数满 256KB 才再报（防 IPC 洪泛）。
fn should_emit_progress(last_emitted: u64, received: u64) -> bool {
    received - last_emitted >= PROGRESS_CHUNK
}

/// retry-after 头解析（照 auth.rs 传输层同款：取值→转 str→trim→u64，
/// 任何一步失败按无头处理，不报错）。
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// 自建 HTTP 客户端（不经 auth.rs transport：那边 30s 超时无 UA 且不可
/// 注入超时；UA 照 ocr.rs 模型下载——部分下载服务拒绝无 UA 请求）。
fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, AuthError> {
    reqwest::Client::builder()
        .user_agent(concat!("ImmersiveTranslator/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| local_error("unknown", format!("构建 HTTP 客户端失败: {e}")))
}

/// 可选鉴权（translation.rs test_connectivity 同款）：取到登录令牌就带
/// Bearer（限流配额加成），取不到（未登录/取票瞬时失败）走匿名——端点
/// 匿名可读，绝不能因取票失败而拒绝请求。不做 401 刷新重放。
async fn with_optional_bearer(
    mut req: reqwest::RequestBuilder,
    manager: &std::sync::Arc<TokenManager>,
) -> reqwest::RequestBuilder {
    match manager.get_access_token().await {
        Ok(token) => req = req.bearer_auth(token),
        Err(_) => {}
    }
    req
}

// ---------------------------------------------------------------------------
// 命令（薄封装：可选鉴权 + 非 2xx 透传；reject 前照 sync.rs 形态广播）
// ---------------------------------------------------------------------------

/// GET /v1/books（公版书目录，匿名只读）。非 2xx 是数据不是错误：原样
/// 透传 `{status, body, retryAfterSeconds}`（400 参数非法 / 404 空结果等由
/// 前端按状态给中文文案）；只有网络失败/沉浸云未开放才 reject。
#[tauri::command]
pub async fn books_list(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    q: Option<String>,
    language: Option<String>,
    category: Option<String>,
    source: Option<String>,
    grade: Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
) -> Result<SyncHttpText, AuthError> {
    match fetch_books_page(manager.inner(), &q, &language, &category, &source, &grade, page, per_page)
        .await
    {
        Ok(v) => Ok(v),
        // reject 前照 sync.rs 形态广播：本命令 reject 仅 network_error /
        // platform_unavailable / unknown 三码，均非致命三码、实为 no-op，
        // 保持形态一致（未来码集变化时不用补）。
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}

async fn fetch_books_page(
    manager: &std::sync::Arc<TokenManager>,
    q: &Option<String>,
    language: &Option<String>,
    category: &Option<String>,
    source: &Option<String>,
    grade: &Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
) -> Result<SyncHttpText, AuthError> {
    let Some(base) = api_base_url(manager) else {
        // 沉浸云未开放期：与 A1「入口随开关关闭」一致，前端给专属文案
        return Err(local_error("platform_unavailable", "书库服务暂未开放"));
    };
    let client = build_http_client(LIST_TIMEOUT_SECS)?;
    let pairs = build_query_pairs(q, language, category, source, grade, page, per_page);
    let req = with_optional_bearer(client.get(format!("{base}/v1/books")).query(&pairs), manager).await;
    let resp = req
        .send()
        .await
        .map_err(|e| local_error("network_error", format!("网络请求失败: {e}")))?;
    let status = resp.status().as_u16();
    let retry_after_seconds = parse_retry_after(resp.headers());
    let body = resp
        .text()
        .await
        .map_err(|e| local_error("network_error", format!("读取响应失败: {e}")))?;
    Ok(SyncHttpText {
        status,
        body,
        retry_after_seconds,
    })
}

/// GET /v1/books/{id}/download（镜像 EPUB，匿名可读）。先判 status 再分流：
/// 200 流式收字节（每满 256KB 经 `books:download:progress` 报进度、收完补发
/// 终值）后 base64 返回；非 200 的 body 是 AppError 错误信封 JSON 文本，
/// 原样透传由前端按状态给中文文案（404 统一口径「当前不可下载」）。
/// id 本地预校验不合式时不发网络，直接以同款信封返回 status=400。
#[tauri::command]
pub async fn books_download(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    book_id: String,
) -> Result<BooksDownloadResult, AuthError> {
    match download_book(&app, manager.inner(), &book_id).await {
        Ok(v) => Ok(v),
        // reject 仅 network/platform/unknown 三码均非致命、实为 no-op（同上）
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}

async fn download_book(
    app: &AppHandle,
    manager: &std::sync::Arc<TokenManager>,
    book_id: &str,
) -> Result<BooksDownloadResult, AuthError> {
    // 本地预校验不合式：不发网络，以服务端同款错误信封形态返回数据
    //（400 是数据不是 reject，与非 2xx 口径一致）
    if validate_book_id(book_id).is_err() {
        return Ok(BooksDownloadResult {
            status: 400,
            body: serde_json::json!({
                "error": { "code": "validation_error", "message": "书目 id 不合法" }
            })
            .to_string(),
            retry_after_seconds: None,
        });
    }
    let Some(base) = api_base_url(manager) else {
        return Err(local_error("platform_unavailable", "书库服务暂未开放"));
    };
    let client = build_http_client(DOWNLOAD_TIMEOUT_SECS)?;
    let req = with_optional_bearer(
        client.get(format!("{base}/v1/books/{book_id}/download")),
        manager,
    )
    .await;
    let mut resp = req
        .send()
        .await
        .map_err(|e| local_error("network_error", format!("下载失败: {e}")))?;
    let status = resp.status().as_u16();
    let retry_after_seconds = parse_retry_after(resp.headers());
    if status != 200 {
        // 服务端非 2xx 的 body 是 JSON 错误信封不是二进制，按文本透传
        let body = resp
            .text()
            .await
            .map_err(|e| local_error("network_error", format!("下载失败: {e}")))?;
        return Ok(BooksDownloadResult {
            status,
            body,
            retry_after_seconds,
        });
    }

    // 200：流式收字节（total=0 表示响应无 content-length，前端按未知总量处理）
    let total = resp.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut last_emitted: u64 = 0;
    let mut received: u64 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| local_error("network_error", format!("下载失败: {e}")))?
    {
        bytes.extend_from_slice(&chunk);
        received += chunk.len() as u64;
        if should_emit_progress(last_emitted, received) {
            // 进度事件失败不影响下载本身（UI 缺一帧无碍，照 ocr.rs 形态忽略）
            let _ = app.emit(
                DOWNLOAD_PROGRESS_EVENT,
                serde_json::json!({ "bookId": book_id, "received": received, "total": total }),
            );
            last_emitted = received;
        }
    }
    // 收完补发终值：保证 UI 至少收到一次最终字节数（received==total 判完成）
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        serde_json::json!({ "bookId": book_id, "received": received, "total": total }),
    );

    // base64 跨 IPC（案A：screenshot.rs 全屏 PNG 同款唯一生产验证形态）
    let body = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(BooksDownloadResult {
        status: 200,
        body,
        retry_after_seconds: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- validate_book_id（与服务端 BOOK_ID_PATTERN/限长 128 对齐）----

    #[test]
    fn book_id_accepts_slug_forms() {
        assert!(validate_book_id("alice").is_ok());
        assert!(validate_book_id("the-art-of-war-2").is_ok());
        // 限长边界：恰好 128 字符合法
        assert!(validate_book_id(&"a".repeat(128)).is_ok());
    }

    #[test]
    fn book_id_rejects_invalid_forms() {
        for bad in [
            "Alice",         // 大写
            "../etc/passwd", // 路径穿越
            "a b",           // 空格
            "",              // 空
            "a--b",          // 连续连字符（空段）
            "a.epub",        // 点号
        ] {
            assert!(validate_book_id(bad).is_err(), "{bad:?} 应判不合法");
        }
        // 129 字符超限
        assert!(validate_book_id(&"a".repeat(129)).is_err());
    }

    // ---- build_query_pairs（默认值/空串过滤/透传/clamp）----

    #[test]
    fn query_pairs_defaults_page_1_per_page_20() {
        let pairs = build_query_pairs(&None, &None, &None, &None, &None, None, None);
        assert_eq!(
            pairs,
            vec![
                ("page".to_string(), "1".to_string()),
                ("perPage".to_string(), "20".to_string()),
            ]
        );
    }

    #[test]
    fn query_pairs_blank_filters_dropped_and_values_kept() {
        // 空串/纯空白过滤；带空格的真实关键词原值保留（编码交给 reqwest）
        let pairs = build_query_pairs(
            &Some("po e".to_string()),
            &Some("  ".to_string()),
            &Some("".to_string()),
            &None,
            &None,
            None,
            None,
        );
        assert_eq!(
            pairs,
            vec![
                ("q".to_string(), "po e".to_string()),
                ("page".to_string(), "1".to_string()),
                ("perPage".to_string(), "20".to_string()),
            ]
        );
    }

    #[test]
    fn query_pairs_passthrough_and_clamp() {
        // grade 键名透传 + page=0→1 + perPage=500 超上限→100
        let pairs = build_query_pairs(
            &None,
            &None,
            &None,
            &None,
            &Some("easy".to_string()),
            Some(0),
            Some(500),
        );
        assert_eq!(
            pairs,
            vec![
                ("grade".to_string(), "easy".to_string()),
                ("page".to_string(), "1".to_string()),
                ("perPage".to_string(), "100".to_string()),
            ]
        );
        // perPage=0 → 下限 1；page 正常透传
        let pairs = build_query_pairs(&None, &None, &None, &None, &None, Some(3), Some(0));
        assert_eq!(
            pairs,
            vec![
                ("page".to_string(), "3".to_string()),
                ("perPage".to_string(), "1".to_string()),
            ]
        );
    }

    // ---- should_emit_progress（256KB=262144 节流阈值）----

    #[test]
    fn progress_emits_every_256kb() {
        // 不足一档不报、恰满一档报
        assert!(!should_emit_progress(0, 262_143));
        assert!(should_emit_progress(0, 262_144));
        // 上一报 262144、当前 400000：增量 137856（=400000-262144）不足
        // 256KB，不报。蓝图拍板公式为 received - last_emitted >= 262_144，
        // 施工计划的 (262144,400000)=true 与该公式算术矛盾，按公式实现。
        assert!(!should_emit_progress(262_144, 400_000));
        // 增量恰满 256KB（524288-262144=262144）才报
        assert!(should_emit_progress(262_144, 524_288));
        assert!(!should_emit_progress(400_000, 400_001));
    }

    // ---- parse_retry_after（照 auth.rs 头解析口径：宽松、失败按无头）----

    #[test]
    fn retry_after_header_parsed_leniently() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_str("37").unwrap(),
        );
        assert_eq!(parse_retry_after(&headers), Some(37));

        // 无头 / 非数字头 / 带空白头
        assert_eq!(parse_retry_after(&reqwest::header::HeaderMap::new()), None);
        let mut junk = reqwest::header::HeaderMap::new();
        junk.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_str("soon").unwrap(),
        );
        assert_eq!(parse_retry_after(&junk), None);
        let mut padded = reqwest::header::HeaderMap::new();
        padded.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_str(" 42 ").unwrap(),
        );
        assert_eq!(parse_retry_after(&padded), Some(42));
    }

    // ---- IPC 形状（与前端 tauriBridge.ts 导出类型一字不差）----

    #[test]
    fn download_result_serializes_camel_case() {
        let result = BooksDownloadResult {
            status: 404,
            body: "{}".to_string(),
            retry_after_seconds: None,
        };
        let text = serde_json::to_string(&result).unwrap();
        assert!(text.contains("\"status\":404"), "{text}");
        assert!(text.contains("\"retryAfterSeconds\""), "{text}");
        assert!(!text.contains("retry_after_seconds"), "{text}");
    }
}
