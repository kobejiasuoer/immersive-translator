//! iOS Keychain 存取（契约 B6-9）：kSecClassGenericPassword，service="ita.secrets"，
//! key 即 account。三条命令：
//! · secret_put(key, value)              —— 写入（同 key 覆盖）
//! · secret_get(key) -> Option<String>   —— 读取，未命中 Ok(None)
//! · secret_delete(key)                  —— 删除，幂等（未存过也 Ok）
//!
//! 用途：LLM API Key 只存钥匙串（store.persistable 落盘时置空，localStorage 不再明文）。
//! 仅真机生效；浏览器/dev 无此链路（前端 localStorage 明文兜底 + 诊断上报，见 store.ts setApiKey）。
//! 参考 mac 端 KeychainStore（XfyunCredentialsStore.swift:81 同为 GenericPassword 条目）。

use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

const SERVICE: &str = "ita.secrets";
/// errSecItemNotFound：iOS/macOS Keychain「条目不存在」状态码（SecBase.h）。
const ITEM_NOT_FOUND: i32 = -25300;

#[tauri::command]
pub fn secret_put(key: String, value: String) -> Result<(), String> {
    set_generic_password(SERVICE, &key, value.as_bytes()).map_err(|e| format!("钥匙串写入失败：{e}"))
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match get_generic_password(SERVICE, &key) {
        Ok(data) => String::from_utf8(data)
            .map(Some)
            .map_err(|_| format!("钥匙串数据不是有效文本（key={key}）")),
        Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(format!("钥匙串读取失败：{e}")),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match delete_generic_password(SERVICE, &key) {
        Ok(()) => Ok(()),
        /* 幂等：删不存在的 key 视为成功（调用方无需关心是否存过） */
        Err(e) if e.code() == ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(format!("钥匙串删除失败：{e}")),
    }
}
