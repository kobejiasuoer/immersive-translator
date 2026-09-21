//! Windows DPAPI 安全存储。
//!
//! 用 `CryptProtectData` 把 API Key 加密后写入应用数据目录下的 JSON 文件，
//! 只能由当前 Windows 用户解密。对齐 Mac 版 Keychain 的"不落盘明文"目标。
//!
//! 设计：
//! - 明文 key 永远不写入 settings JSON；settings JSON 里只保留一个布尔 `hasApiKey` 占位。
//! - 加密 blob 以 base64 存入 `app_data_dir/secrets.json`。
//! - DPAPI 绑定当前用户；换机 / 换用户会解密失败，并明确返回错误让用户处理。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{LocalFree, BOOL};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LPTR};

const SECRET_KEY: &str = "openai_api_key";

#[derive(Debug, Serialize, Deserialize, Default)]
struct SecretsFile {
    /// name -> base64(encrypted bytes)
    entries: HashMap<String, String>,
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("secrets.json"))
}

fn load_secrets(app: &AppHandle) -> Result<SecretsFile, String> {
    load_secrets_from_path(&secrets_path(app)?)
}

fn load_secrets_from_path(path: &Path) -> Result<SecretsFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SecretsFile::default());
        }
        Err(error) => return Err(format!("读取 secrets.json 失败: {error}")),
    };

    serde_json::from_str(&text).map_err(|error| format!("解析 secrets.json 失败: {error}"))
}

fn save_secrets(app: &AppHandle, secrets: &SecretsFile) -> Result<(), String> {
    let path = secrets_path(app)?;
    let text = serde_json::to_string_pretty(secrets)
        .map_err(|error| format!("序列化 secrets.json 失败: {error}"))?;
    atomic_write(&path, text.as_bytes())
}

/// tmp + rename 原子落盘。直接 write 时中途崩溃/断电会把 secrets.json 截断，
/// 所有凭据（翻译 Key、讯飞三段等）一起丢；同分区 rename 是原子替换，
/// 最坏情况丢本次写入，旧文件完好。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入 secrets 临时文件失败: {e}"))?;
    // std::fs::rename 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 语义覆盖已存在目标。
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 secrets.json 失败: {e}"))
}

fn encrypt(plain: &str) -> Result<String, String> {
    let bytes = plain.as_bytes();
    let len = bytes.len();

    unsafe {
        // 分配一块可写内存并拷贝明文（DPAPI 读这块内存）。
        // LPTR = LMEM_ZEROINIT|LMEM_FIXED，返回固定指针可直接当 *mut u8 用。
        let ptr = LocalAlloc(LPTR, len);
        if ptr.is_null() {
            return Err("LocalAlloc 失败".into());
        }
        if len > 0 {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, len);
        }

        let input = CRYPT_INTEGER_BLOB {
            cbData: len as u32,
            pbData: ptr as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        // dwFlags=0: 绑定当前用户 + 当前机器的 Master Key
        let ok: BOOL = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        );
        LocalFree(ptr);

        if ok == 0 {
            return Err("CryptProtectData 失败".into());
        }

        let cipher = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);

        Ok(B64.encode(cipher))
    }
}

fn decrypt(b64: &str) -> Result<String, String> {
    let cipher = B64
        .decode(b64.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let len = cipher.len();
    if len == 0 {
        return Err("空密文".into());
    }

    unsafe {
        let ptr = LocalAlloc(LPTR, len);
        if ptr.is_null() {
            return Err("LocalAlloc 失败".into());
        }
        std::ptr::copy_nonoverlapping(cipher.as_ptr(), ptr as *mut u8, len);

        let input = CRYPT_INTEGER_BLOB {
            cbData: len as u32,
            pbData: ptr as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let ok: BOOL = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        );
        LocalFree(ptr);

        if ok == 0 {
            return Err("CryptUnprotectData 失败（可能已换用户/换机）".into());
        }

        let plain_bytes =
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);

        String::from_utf8(plain_bytes).map_err(|e| format!("解密后非 UTF-8: {e}"))
    }
}

/// 命令实现已改为直查 entries；这个读取语义保留给单测校验。
#[cfg(test)]
fn read_secret_entry(
    secrets: &SecretsFile,
    decrypt_value: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    let Some(encrypted) = secrets.entries.get(SECRET_KEY) else {
        return Ok(String::new());
    };

    decrypt_value(encrypted).map_err(|error| format!("无法解密 API Key: {error}"))
}

/// secret 条目名：缺省 = 翻译 Key（openai_api_key）；自定义名限小写字母/数字/下划线。
fn normalize_name(name: Option<&str>) -> Result<String, String> {
    match name {
        None | Some("") => Ok(SECRET_KEY.to_string()),
        Some(n) => {
            if n.len() > 64
                || !n
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(format!("非法 secret 名称: {n}"));
            }
            Ok(n.to_string())
        }
    }
}

/// 读取 API Key 明文。凭据不存在返回空串，存储或解密失败返回错误。
/// name 缺省时读写翻译 Key；传名字读写命名凭据（如讯飞评测三段）。
#[tauri::command]
pub fn secret_get(app: AppHandle, name: Option<String>) -> Result<String, String> {
    let key = normalize_name(name.as_deref())?;
    let secrets = load_secrets(&app)?;
    let Some(encrypted) = secrets.entries.get(&key) else {
        return Ok(String::new());
    };
    decrypt(encrypted).map_err(|error| format!("无法解密 API Key: {error}"))
}

/// 保存 API Key 明文（加密落盘）。空串会删除条目。
#[tauri::command]
pub fn secret_set(app: AppHandle, name: Option<String>, value: String) -> Result<(), String> {
    let key = normalize_name(name.as_deref())?;
    let mut secrets = load_secrets(&app)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        secrets.entries.remove(&key);
    } else {
        let b64 = encrypt(trimmed)?;
        secrets.entries.insert(key, b64);
    }
    save_secrets(&app, &secrets)
}

/// 判断加密 API Key 条目是否存在；存储读取失败会明确返回错误。
#[tauri::command]
pub fn secret_exists(app: AppHandle, name: Option<String>) -> Result<bool, String> {
    let key = normalize_name(name.as_deref())?;
    Ok(load_secrets(&app)?.entries.contains_key(&key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temporary_path(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        std::env::temp_dir().join(format!(
            "immersive-translator-secret-store-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_secrets_file_is_an_empty_store() {
        let path = temporary_path("missing.json");
        let _ = std::fs::remove_file(&path);

        let secrets = load_secrets_from_path(&path).unwrap();

        assert!(secrets.entries.is_empty());
    }

    #[test]
    fn valid_secrets_file_is_loaded() {
        let path = temporary_path("valid.json");
        std::fs::write(&path, r#"{"entries":{"openai_api_key":"encrypted-value"}}"#).unwrap();

        let secrets = load_secrets_from_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(
            secrets.entries.get(SECRET_KEY).map(String::as_str),
            Some("encrypted-value")
        );
    }

    #[test]
    fn malformed_secrets_file_returns_a_parse_error() {
        let path = temporary_path("malformed.json");
        std::fs::write(&path, "{not-json").unwrap();

        let error = load_secrets_from_path(&path).unwrap_err();
        let _ = std::fs::remove_file(&path);

        assert!(error.starts_with("解析 secrets.json 失败:"));
    }

    #[test]
    fn unreadable_secrets_path_returns_a_read_error() {
        let path = temporary_path("directory");
        std::fs::create_dir(&path).unwrap();

        let error = load_secrets_from_path(&path).unwrap_err();
        let _ = std::fs::remove_dir(&path);

        assert!(error.starts_with("读取 secrets.json 失败:"));
    }

    #[test]
    fn missing_secret_entry_returns_an_empty_value_without_decrypting() {
        let secrets = SecretsFile::default();

        let value = read_secret_entry(&secrets, |_| panic!("decrypt should not be called"));

        assert_eq!(value.unwrap(), "");
    }

    #[test]
    fn decryption_failure_is_returned_instead_of_becoming_an_empty_value() {
        let mut secrets = SecretsFile::default();
        secrets
            .entries
            .insert(SECRET_KEY.to_string(), "broken".to_string());

        let error = read_secret_entry(&secrets, |_| Err("DPAPI failure".to_string())).unwrap_err();

        assert_eq!(error, "无法解密 API Key: DPAPI failure");
    }

    #[test]
    fn normalize_name_defaults_to_translation_key_for_missing_or_empty() {
        assert_eq!(normalize_name(None).unwrap(), SECRET_KEY);
        assert_eq!(normalize_name(Some("")).unwrap(), SECRET_KEY);
    }

    #[test]
    fn normalize_name_accepts_named_secrets_and_rejects_bad_ones() {
        assert_eq!(
            normalize_name(Some("xfyun_ise_app_id")).unwrap(),
            "xfyun_ise_app_id"
        );
        assert!(normalize_name(Some("OpenAI Key")).is_err());
        assert!(normalize_name(Some("../etc/passwd")).is_err());
        assert!(normalize_name(Some(&"x".repeat(65))).is_err());
    }
}
