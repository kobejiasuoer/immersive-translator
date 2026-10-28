//! 兑换码核销传输通道（语音云契约 §三.10 / 决策 5）：POST /v1/redeem。
//!
//! - 认证零代码：复用 auth.rs 的 `with_auth` 样板——base URL 解析、Bearer 会话
//!   令牌附带、401 token_expired 单飞刷新后重放一次，与 LLM 网关
//!   （translation.rs）、云同步（sync.rs）同一条管线；令牌不跨 IPC（红线 D4/D5）。
//! - 非 2xx 是协议数据不是错误（sync.rs 同口径）：`redeem_code_not_found /
//!   expired / used` 等错误信封原样带回，文案映射在前端 RedeemCard.tsx；
//!   只有网络 / 致命鉴权错误才 reject。未登录时 with_auth 零网络即 unauthorized，
//!   前端落「兑换失败，请稍后再试」兜底（账号页只在已登录分支挂载本入口）。
//!
//! 传输应答复用 sync.rs 的 `SyncHttpText`（scenario_catalog.rs 同先例）。

use tauri::AppHandle;

use crate::auth::{emit_fatal_if_needed, AuthError, TokenManager};
use crate::sync::SyncHttpText;

/// POST /v1/redeem `{code}`（服务端 redeem.controller.ts，登录态必需）。
/// code 形状校验在服务端 RedeemDto（去空格 + 大写 + XXXX-XXXX-XXXX-XXXX），
/// Rust 不重复校验；429 限流时 retry_after_seconds 随应答透传。
#[tauri::command]
pub async fn redeem_code(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    code: String,
) -> Result<SyncHttpText, AuthError> {
    let body = serde_json::json!({ "code": code }).to_string();
    match manager
        .with_auth(reqwest::Method::POST, "/v1/redeem", Some(body))
        .await
    {
        Ok(resp) => Ok(SyncHttpText {
            status: resp.status,
            body: resp.body,
            retry_after_seconds: resp.retry_after_seconds,
        }),
        Err(e) => {
            emit_fatal_if_needed(&app, &e);
            Err(e)
        }
    }
}
