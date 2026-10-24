//! 订阅源抓取（内容进水口 · 资讯订阅）。
//!
//! 匿名直连用户提供的源站，取回原始 feed XML 文本——resolve 是未解析的
//! XML 字符串，解析（RSS/Atom）全在 TS 侧（lib/feedCatalog.ts）。
//! 刻意不抄 B2 discover.rs 的网关挂法：本模块直连源站 URL，不拼接任何
//! 网关地址、不带任何登录令牌、不做致命错误广播——用户自添的订阅源与
//! 沉浸云无关，「不经服务端」正是本任务的验收点（见 decisions/验收）。
//! 错误是面向用户的中文 String，TS invoke Promise.reject 后直显
//!（形态照 web_extract.rs reader_fetch_url）。

use std::time::Duration;

/// feed XML 大小上限（订阅源是小文本，远低于 reader_fetch_url 的 5MB 网页上限）。
const MAX_FEED_BYTES: usize = 2_000_000;

/// 大小门禁两级共用的错误文案。
const FEED_TOO_LARGE_TEXT: &str = "订阅内容超过 2MB，已取消";

/// 订阅地址校验（纯函数）：trim 首尾空白后解析，解析失败或 scheme 不是
/// http/https（file/javascript/ftp…）以中文文案拒绝。
fn feed_url_error(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "这不是有效的订阅地址".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("只支持 http/https 订阅源".to_string());
    }
    Ok(parsed)
}

/// 状态码转中文文案（纯函数）：401/403 专属文案（含状态码）；其余非 2xx
/// 通用文案含状态码；2xx 返回 None 放行。
fn status_error_text(status: reqwest::StatusCode) -> Option<String> {
    let code = status.as_u16();
    if code == 401 || code == 403 {
        return Some(format!("这个订阅源需要登录或拒绝了访问（{status}）"));
    }
    if !status.is_success() {
        return Some(format!("订阅源返回了 {status}"));
    }
    None
}

/// 大小门禁（纯函数）：content-length 头已知且超上限直接拒绝（不读
/// body）；头未知（None，chunked）先放行，读出文本后由调用方以
/// Some(文本长度) 复查同一上限。
fn content_length_gate(content_length: Option<u64>) -> Option<&'static str> {
    match content_length {
        Some(len) if len > MAX_FEED_BYTES as u64 => Some(FEED_TOO_LARGE_TEXT),
        _ => None,
    }
}

/// 抓取原始 feed XML 文本。浏览器 UA（用户自添源站常有 Cloudflare 等 403
/// 非浏览器 UA，刻意不用 discover.rs 的产品 UA）+ 20s 超时。无
/// AppHandle/无 State/无 token。无 content-type 拒绝门禁——RSS 源响应头
/// 五花八门（含 text/html），「重定向到 HTML 页」的形状门禁在 TS 解析层做
///（parsererror/0 条目给中文文案）。
#[tauri::command]
pub async fn reader_fetch_feed(url: String) -> Result<String, String> {
    let parsed = feed_url_error(&url)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ",
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("网络初始化失败: {e}"))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("打不开这个订阅源（{e}）——检查网络或地址后重试"))?;
    if let Some(text) = status_error_text(resp.status()) {
        return Err(text);
    }
    // 大小门禁第一级：content-length 头已知先查头，超上限不读 body 直接拒。
    if let Some(err) = content_length_gate(resp.content_length()) {
        return Err(err.to_string());
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取订阅内容失败: {e}"))?;
    // 大小门禁第二级：无头（chunked）响应读满后按文本长度复查同一上限
    //（web_extract.rs reader_fetch_url 的 post-hoc 同款）。
    if let Some(err) = content_length_gate(Some(body.len() as u64)) {
        return Err(err.to_string());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- feed_url_error（URL 校验：trim / scheme 白名单）----

    #[test]
    fn url_gate_accepts_valid_http_and_https() {
        // 首尾空白被 trim 后照常可用；回传解析后的 Url 供 scheme/host 断言
        let url = feed_url_error("  https://www.nasa.gov/news-release/feed/  ").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("www.nasa.gov"));
        assert_eq!(
            feed_url_error("http://example.com/feed.xml").unwrap().scheme(),
            "http"
        );
    }

    #[test]
    fn url_gate_rejects_non_url_string() {
        let err = feed_url_error("not-a-url").unwrap_err();
        assert_eq!(err, "这不是有效的订阅地址");
    }

    #[test]
    fn url_gate_rejects_non_http_schemes() {
        for bad in ["file:///etc/passwd", "javascript://alert(1)", "ftp://example.com/feed"] {
            let err = feed_url_error(bad).unwrap_err();
            assert_eq!(
                err, "只支持 http/https 订阅源",
                "{bad:?} 应被 scheme 白名单拒绝",
            );
        }
        // trim 先于 scheme 判定：带首尾空白的 file:// 仍按 scheme 拒绝
        assert_eq!(
            feed_url_error("  file:///etc/passwd  ").unwrap_err(),
            "只支持 http/https 订阅源"
        );
    }

    // ---- content_length_gate（2MB 上限，边界含两侧）----

    #[test]
    fn length_gate_passes_unknown_and_under_limit() {
        // 无头（None，chunked）放行，读后由调用方复查
        assert!(content_length_gate(None).is_none());
        assert!(content_length_gate(Some(1_999_999)).is_none());
    }

    #[test]
    fn length_gate_rejects_over_limit_on_both_sides() {
        // 恰在 2MB 上限仍放行（> 才拒），超 1 拒
        assert!(content_length_gate(Some(2_000_000)).is_none());
        let err = content_length_gate(Some(2_000_001)).unwrap();
        assert_eq!(err, "订阅内容超过 2MB，已取消");
    }

    // ---- status_error_text（状态码转中文文案）----

    #[test]
    fn status_text_gives_dedicated_copy_for_401_and_403() {
        let e401 = status_error_text(reqwest::StatusCode::from_u16(401).unwrap()).unwrap();
        assert!(e401.contains("需要登录或拒绝了访问"), "{e401}");
        assert!(e401.contains("401"), "{e401}");
        let e403 = status_error_text(reqwest::StatusCode::from_u16(403).unwrap()).unwrap();
        assert!(e403.contains("需要登录或拒绝了访问"), "{e403}");
        assert!(e403.contains("403"), "{e403}");
    }

    #[test]
    fn status_text_includes_code_for_other_non_2xx() {
        let e404 = status_error_text(reqwest::StatusCode::from_u16(404).unwrap()).unwrap();
        assert!(e404.contains("404"), "{e404}");
        let e500 = status_error_text(reqwest::StatusCode::from_u16(500).unwrap()).unwrap();
        assert!(e500.contains("500"), "{e500}");
    }

    #[test]
    fn status_text_passes_2xx_through() {
        assert!(status_error_text(reqwest::StatusCode::from_u16(200).unwrap()).is_none());
        assert!(status_error_text(reqwest::StatusCode::from_u16(204).unwrap()).is_none());
    }
}
