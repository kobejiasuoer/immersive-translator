//! 语音网关 REST 传输通道（语音云契约 §一/§四：/v1/voice/ticket|asr|ise）。
//!
//! 与 sync.rs/redeem.rs 同构的薄传输层：挂在 auth.rs `TokenManager::with_auth`
//! 上——base URL 解析、Bearer 会话令牌附带、401 token_expired 单飞刷新后重放
//! 一次全部继承既有管线，令牌不跨 IPC（红线 D4/D5）。协议口径与 sync 一致：
//! **非 2xx 是协议数据不是错误**，错误信封原样带回（文案映射在前端
//! errorFromHttpResponse，§二逐行）；只有网络/致命鉴权错误才 reject。
//!
//! 相对 sync 的两点增量（前端 VoiceHttpResponse 的字段依据）：
//! - 透传 402 的 `x-quota-<resource>-remaining` 配额余量响应头（auth.rs 白名单
//!   收集，details 之外唯一可得字段；前端用于补 remaining）；
//! - 429 的 retry-after 照常透传（SyncHttpText 同款字段）。
//!
//! 前端消费口在应用启动时经 setVoiceRuntime 接线（src/main.tsx 唯一调用点）。
//! 本命令是通用转发面，method/path 收敛白名单：method 仅 GET/POST（前端
//! VoiceHttpTransport 类型的全集），path 仅 /v1/voice/*（语音网关自己的路径空间，
//! 服务端扩路径时同步放宽）。

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::AppHandle;

use crate::auth::{emit_fatal_if_needed, AuthError, TokenManager};

/// 一次语音网关 REST 请求的原始应答（字段与前端 voiceRuntime.ts 的
/// VoiceHttpResponse 一字不差，camelCase）。
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHttpText {
    pub status: u16,
    pub body: String,
    pub retry_after_seconds: Option<u64>,
    /// x-quota-* 白名单响应头（auth.rs 收集，键小写；无则空对象）。
    pub headers: BTreeMap<String, String>,
}

/// 本地伪码：method/path 不在白名单（前端写死合法值，落到这里即接线/版本错位）。
fn invalid_request(message: String) -> AuthError {
    AuthError {
        code: "voice_request_invalid".to_string(),
        message,
        http_status: None,
        retry_after_seconds: None,
    }
}

/// method/path 白名单校验：通过返回解析后的 HTTP 方法。
fn validate_voice_request(method: &str, path: &str) -> Result<reqwest::Method, AuthError> {
    let parsed = match method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => {
            return Err(invalid_request(format!(
                "不支持的语音网关请求方法 {method}"
            )))
        }
    };
    // 路径空间收敛 + 穿越防御：段内不允许 ".."。
    if !path.starts_with("/v1/voice/") || path.contains("..") {
        return Err(invalid_request(format!("语音网关路径白名单外: {path}")));
    }
    Ok(parsed)
}

/// POST/GET /v1/voice/*：method+path+JSON body 进、原始应答出（401 单飞刷新/
/// 重放全在 with_auth 内部完成，前端只见终态）。path 带查询串原样透传。
#[tauri::command]
pub async fn voice_http_request(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    method: String,
    path: String,
    body_json: Option<String>,
) -> Result<VoiceHttpText, AuthError> {
    let parsed = validate_voice_request(&method, &path)?;
    match manager.with_auth(parsed, &path, body_json).await {
        Ok(resp) => Ok(VoiceHttpText {
            status: resp.status,
            body: resp.body,
            retry_after_seconds: resp.retry_after_seconds,
            headers: resp.headers.into_iter().collect(),
        }),
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_voice_paths_and_methods() {
        for (method, path) in [
            ("POST", "/v1/voice/ticket"),
            ("POST", "/v1/voice/asr"),
            ("POST", "/v1/voice/ise"),
            ("GET", "/v1/voice/quota"),
            ("get", "/v1/voice/asr"), // 大小写归一
        ] {
            assert!(
                validate_voice_request(method, path).is_ok(),
                "{method} {path} 应放行"
            );
        }
    }

    #[test]
    fn rejects_methods_outside_transport_type() {
        for method in ["DELETE", "PUT", "PATCH", ""] {
            let err = validate_voice_request(method, "/v1/voice/asr").unwrap_err();
            assert_eq!(err.code, "voice_request_invalid", "{method}");
        }
    }

    #[test]
    fn rejects_paths_outside_voice_namespace() {
        // 通用转发面不得外溢：非 /v1/voice/ 前缀、穿越形态、相对路径全拒。
        for path in [
            "/v1/me",
            "/v1/auth/refresh",
            "/v1/redeem",
            "/v1/voice/../auth/refresh",
            "v1/voice/asr",
            "",
        ] {
            let err = validate_voice_request("POST", path).unwrap_err();
            assert_eq!(err.code, "voice_request_invalid", "{path}");
        }
    }
}
