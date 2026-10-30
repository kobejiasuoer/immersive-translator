//! Bounded HTTP transport for the WKWebView. Authentication redirects are never followed.
use futures_util::StreamExt;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use futures_util::future::{AbortHandle, Abortable};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub request_id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    #[serde(default)]
    pub follow_redirects: bool,
    #[serde(default)]
    pub response_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    url: String,
    headers: BTreeMap<String, String>,
    body: String,
}

static REQUESTS: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
#[tauri::command]
pub fn mobile_http_cancel(request_id: String) -> Result<(), String> {
    if let Some(handle) = REQUESTS.get_or_init(Mutex::default).lock().map_err(|_| "请求状态锁异常")?.remove(&request_id) { handle.abort(); }
    Ok(())
}
#[tauri::command]
pub async fn mobile_http_request(request: HttpRequest) -> Result<HttpResponse, String> {
    if request.request_id.is_empty() || request.request_id.len() > 128 { return Err("请求标识无效".into()); }
    let id = request.request_id.clone();
    let (handle, registration) = AbortHandle::new_pair();
    { let mut requests = REQUESTS.get_or_init(Mutex::default).lock().map_err(|_| "请求状态锁异常")?;
      if requests.contains_key(&id) { return Err("请求标识重复".into()); }
      requests.insert(id.clone(), handle); }
    let result = Abortable::new(execute(request), registration).await.unwrap_or_else(|_| Err("操作已取消，服务端结果可能尚未确认".into()));
    if let Ok(mut requests) = REQUESTS.get_or_init(Mutex::default).lock() { requests.remove(&id); }
    result
}
async fn execute(request: HttpRequest) -> Result<HttpResponse, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|_| "请求地址无效".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() {
        return Err("仅支持不含账号密码的 HTTP(S) 地址".into());
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "请求方式无效".to_string())?;
    if !matches!(method, reqwest::Method::GET | reqwest::Method::POST | reqwest::Method::DELETE | reqwest::Method::PATCH) {
        return Err("不支持的请求方式".into());
    }
    if request.body.as_ref().is_some_and(|body| body.len() > 12 * 1024 * 1024) {
        return Err("请求内容超过 12 MiB".into());
    }
    // Only public GET extraction follows redirects; authorization never crosses origins.
    let redirects = request.follow_redirects && method == reqwest::Method::GET && request.headers.is_empty();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(65))
        .connect_timeout(Duration::from_secs(15))
        .redirect(if redirects { reqwest::redirect::Policy::limited(5) } else { reqwest::redirect::Policy::none() })
        .build().map_err(|err| format!("无法初始化网络请求：{err}"))?;
    let mut req = client.request(method, url);
    for (name, value) in request.headers {
        let key = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| "请求头名称无效".to_string())?;
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(|_| "请求头内容无效".to_string())?;
        req = req.header(key, value);
    }
    if let Some(body) = request.body { req = req.body(body); }
    let response = req.send().await.map_err(|err| {
        if err.is_timeout() { "请求超时，结果尚未确认；请检查记录后再决定重试".to_string() } else { "连接失败，请检查网络或服务地址".to_string() }
    })?;
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let headers = response.headers().iter().filter_map(|(k,v)| v.to_str().ok().map(|v| (k.to_string(),v.to_owned()))).collect();
    let binary = request.response_type == "base64";
    let limit = if binary { 32 * 1024 * 1024 } else if redirects { 4 * 1024 * 1024 } else { 12 * 1024 * 1024 };
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "响应中断，结果尚未确认".to_string())?;
        if bytes.len() + part.len() > limit { return Err("响应内容过大，请改为粘贴需要阅读的正文".into()); }
        bytes.extend_from_slice(&part);
    }
    let body = if binary { base64::engine::general_purpose::STANDARD.encode(bytes) } else { String::from_utf8(bytes).map_err(|_| "响应不是有效 UTF-8 文本".to_string())? };
    Ok(HttpResponse { status, url: final_url, headers, body })
}
