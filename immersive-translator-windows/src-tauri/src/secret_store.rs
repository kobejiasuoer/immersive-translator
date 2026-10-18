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

pub(crate) fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("secrets.json"))
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

fn save_secrets_to_path(path: &Path, secrets: &SecretsFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(secrets)
        .map_err(|error| format!("序列化 secrets.json 失败: {error}"))?;
    atomic_write(path, text.as_bytes())
}

/// secrets.json 全部「load → 修改 → save」读-改-写序列的进程级互斥锁。
/// 背景：auth 模块后台落盘令牌（登录成功/单飞刷新/启动续登录）与设置页
/// `secret_set` 命令都是对同一文件的全量读改写，交错会丢掉一方写入；
/// 若丢的是新 refreshToken（磁盘留旧票而服务端已轮换），下次启动刷新
/// 即 `token_reused` → 该账号全设备强制下线。锁粒度是整个读-改-写序列，
/// 临界区为本地文件读写 + DPAPI（微秒~毫秒级），`std::sync::Mutex` 足够。
pub(crate) static SECRETS_IO_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 读取并解密命名条目（内部经 SECRETS_IO_MUTEX 串行化）。
/// 条目不存在返回 Ok(None)。path 版便于 cargo 单测注入临时文件。
pub(crate) fn secrets_get_raw(path: &Path, key: &str) -> Result<Option<String>, String> {
    let _guard = SECRETS_IO_MUTEX
        .lock()
        .map_err(|_| "secrets IO 锁不可用".to_string())?;
    let secrets = load_secrets_from_path(path)?;
    match secrets.entries.get(key) {
        Some(encrypted) => decrypt(encrypted)
            .map(Some)
            .map_err(|error| format!("无法解密 API Key: {error}")),
        None => Ok(None),
    }
}

/// 加密并写入命名条目（内部经 SECRETS_IO_MUTEX 串行化）。
/// 空串不允许：条目删除走 secrets_clear_raw（对齐既有命令语义）。
pub(crate) fn secrets_set_raw(path: &Path, key: &str, plaintext: &str) -> Result<(), String> {
    let _guard = SECRETS_IO_MUTEX
        .lock()
        .map_err(|_| "secrets IO 锁不可用".to_string())?;
    let mut secrets = load_secrets_from_path(path)?;
    let b64 = encrypt(plaintext)?;
    secrets.entries.insert(key.to_string(), b64);
    save_secrets_to_path(path, &secrets)
}

/// 删除命名条目（内部经 SECRETS_IO_MUTEX 串行化；条目不存在也成功）。
pub(crate) fn secrets_clear_raw(path: &Path, key: &str) -> Result<(), String> {
    let _guard = SECRETS_IO_MUTEX
        .lock()
        .map_err(|_| "secrets IO 锁不可用".to_string())?;
    let mut secrets = load_secrets_from_path(path)?;
    secrets.entries.remove(key);
    save_secrets_to_path(path, &secrets)
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
/// `server_auth` 是 auth 模块双令牌槽的保留名：通用命令（secret_get/set/exists）
/// 一律拒绝——否则任一 WebView 脚本可 invoke('secret_get',{name:'server_auth'})
/// 读出含 30 天 refreshToken 的明文 JSON，击穿「令牌永不跨 IPC」（auth.rs 模块头）。
/// auth 模块自身经 secrets_*_raw 内部入口读写，不受此拦截影响。
pub(crate) const AUTH_SLOT: &str = "server_auth";

fn normalize_name(name: Option<&str>) -> Result<String, String> {
    match name {
        None | Some("") => Ok(SECRET_KEY.to_string()),
        Some(n) => {
            if n == AUTH_SLOT {
                return Err(format!("保留槽名不可经通用命令读写: {n}"));
            }
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
    let path = secrets_path(&app)?;
    Ok(secrets_get_raw(&path, &key)?.unwrap_or_default())
}

/// 保存 API Key 明文（加密落盘）。空串会删除条目。
#[tauri::command]
pub fn secret_set(app: AppHandle, name: Option<String>, value: String) -> Result<(), String> {
    let key = normalize_name(name.as_deref())?;
    let path = secrets_path(&app)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        secrets_clear_raw(&path, &key)
    } else {
        secrets_set_raw(&path, &key, trimmed)
    }
}

/// 判断加密 API Key 条目是否存在；存储读取失败会明确返回错误。
#[tauri::command]
pub fn secret_exists(app: AppHandle, name: Option<String>) -> Result<bool, String> {
    let key = normalize_name(name.as_deref())?;
    let path = secrets_path(&app)?;
    let _guard = SECRETS_IO_MUTEX
        .lock()
        .map_err(|_| "secrets IO 锁不可用".to_string())?;
    Ok(load_secrets_from_path(&path)?.entries.contains_key(&key))
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
        // 保留槽：auth 双令牌绝不可经通用命令读/写/探测（令牌不跨 IPC）。
        assert!(normalize_name(Some(AUTH_SLOT)).is_err());
    }

    /// SECRETS_IO_MUTEX 的回归信号：auth 落盘形状（server_auth 槽）与设置页
    /// secret_set 形状（命名槽）两线程交替写同一 secrets.json，最终两槽都在盘上。
    /// 锁的正确性主要由代码审查保证（所有读-改-写序列都经同一把锁），此测试
    /// 防的是有人绕开 raw 入手直接 load/save 造成丢更新的回归。
    #[test]
    fn secrets_concurrent_writes_no_lost_update() {
        let path = temporary_path("concurrent.json");
        let _ = std::fs::remove_file(&path);
        let rounds = 25;

        let path_a = path.clone();
        let writer_auth = std::thread::spawn(move || {
            for i in 0..rounds {
                secrets_set_raw(&path_a, "server_auth", &format!("auth-pair-{i}")).unwrap();
            }
        });
        let path_b = path.clone();
        let writer_settings = std::thread::spawn(move || {
            for i in 0..rounds {
                secrets_set_raw(&path_b, "openai_api_key", &format!("key-{i}")).unwrap();
            }
        });
        writer_auth.join().unwrap();
        writer_settings.join().unwrap();

        let secrets = load_secrets_from_path(&path).unwrap();
        assert!(
            secrets.entries.contains_key("server_auth"),
            "auth 槽丢失（读-改-写丢更新）: {:?}",
            secrets.entries.keys().collect::<Vec<_>>()
        );
        assert!(
            secrets.entries.contains_key("openai_api_key"),
            "设置页槽丢失（读-改-写丢更新）: {:?}",
            secrets.entries.keys().collect::<Vec<_>>()
        );
        // 写入的是密文，明文令牌绝不落盘。
        let raw_text = std::fs::read_to_string(&path).unwrap();
        assert!(!raw_text.contains("auth-pair-"), "secrets.json 不得含明文");
        let _ = std::fs::remove_file(&path);
    }
}
