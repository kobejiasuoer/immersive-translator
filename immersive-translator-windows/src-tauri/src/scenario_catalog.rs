//! 官方口语场景目录（升级计划 A1，计划书 §2.1/§2.2/§6）：
//! GET /v1/scenarios 只读通道 + 本地全量缓存。
//!
//! - 与 A0 sync.rs 的用户场景双向同步是两条独立通道：本模块不碰 sync/ 目录
//!   与 LOCAL_COLLECTIONS 白名单（那是 StoredSyncEntity + 游标协议；官方目录
//!   是全量只读快照，混放会污染 A0 协议并绕开「白名单即路径校验」先例）。
//! - 字段解释权在契约 contracts/speak-scenario.schema.json 与前端（形状过滤、
//!   是否写盘都由 TS 决定）；Rust 只做存储原语与传输透传，scenarios 以
//!   `Vec<serde_json::Value>` 原样存取、不解释业务字段。
//! - 传输应答复用 sync.rs 的 `SyncHttpText`：同为「传输命令非 2xx 即数据」
//!   性质——服务端 A3 落地前该端点必然 404，客户端必须安静失败（Ok 原样
//!   透传 `{status, body, retryAfterSeconds}`，由前端静默降级）；只有网络/
//!   致命鉴权错误才 reject（未登录/断网由前端 catch 静默降级到内置+用户场景）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::auth::{emit_fatal_if_needed, AuthError, TokenManager};
use crate::sync::SyncHttpText;

pub const SCENARIO_CACHE_SCHEMA_VERSION: u32 = 1;

/// 缓存文件顶层结构（app_data_dir/official_speak_scenarios.json）。
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct OfficialScenarioCacheFile {
    schema_version: u32,
    #[serde(default)]
    scenarios: Vec<serde_json::Value>,
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("official_speak_scenarios.json"))
}

/// 写盘串行锁（与 reader_store/speak_store 同模式；目录缓存独立文件）。
static CACHE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 只豁免 NotFound 与空文件（首启/从未拉取过）。缓存报错由上层降级为只用
/// 内置+用户场景，且缓存本就是全量替换物、下一次成功拉取整体重写，
/// 不存在 speak_store 那种静默清空用户数据的风险，故无需静默吞 IO。
fn read_from_path(path: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取官方口语场景缓存 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: OfficialScenarioCacheFile =
        serde_json::from_str(&text).map_err(|e| format!("官方口语场景缓存损坏: {e}"))?;
    if file.schema_version != SCENARIO_CACHE_SCHEMA_VERSION {
        return Err(format!(
            "官方口语场景缓存版本不兼容（文件 v{}，应用 v{SCENARIO_CACHE_SCHEMA_VERSION}）。请升级应用后再打开。",
            file.schema_version
        ));
    }
    Ok(file.scenarios)
}

fn write_to_path(path: &std::path::Path, file: &OfficialScenarioCacheFile) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let body =
        serde_json::to_string(file).map_err(|e| format!("序列化官方口语场景缓存失败: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写入 {tmp:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

/// scenario_cache_write 的载荷校验（纯逻辑，便于函数级直测）：
/// 前端传来的必须是 JSON 数组；数组内每项的形状由前端按契约过滤。
fn parse_scenarios_payload(scenarios_json: &str) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str::<Vec<serde_json::Value>>(scenarios_json)
        .map_err(|_| "场景目录载荷必须是 JSON 数组".to_string())
}

/// GET /v1/scenarios（官方目录，A3 前必然 404）。非 2xx 是数据不是错误：
/// 原样透传，前端按状态静默降级；未登录（unauthorized 零网络）/断网走
/// Err，且均不触发致命三码全局广播，前端 catch 即静默。
#[tauri::command]
pub async fn scenario_fetch_official(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
) -> Result<SyncHttpText, AuthError> {
    match manager
        .with_auth(reqwest::Method::GET, "/v1/scenarios", None)
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

/// 读本地官方目录缓存（首启/从未拉取返回空数组；损坏/版本不符报 Err，
/// 由前端 catch 降级为只用内置+用户场景）。
#[tauri::command]
pub fn scenario_cache_read(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let _guard = CACHE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    read_from_path(&cache_path(&app)?)
}

/// 整体替换本地官方目录缓存（前端校验形状后调用；全量快照，无合并逻辑）。
#[tauri::command]
pub fn scenario_cache_write(app: AppHandle, scenarios_json: String) -> Result<(), String> {
    let _guard = CACHE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let scenarios = parse_scenarios_payload(&scenarios_json)?;
    write_to_path(
        &cache_path(&app)?,
        &OfficialScenarioCacheFile {
            schema_version: SCENARIO_CACHE_SCHEMA_VERSION,
            scenarios,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_path(label: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "immersive-translator-scenario-catalog-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_cache_file_is_empty() {
        let path = temporary_path("missing.json");
        let _ = std::fs::remove_file(&path);

        let scenarios = read_from_path(&path).unwrap();

        assert!(scenarios.is_empty());
    }

    #[test]
    fn cache_roundtrip_camel_case() {
        let path = temporary_path("roundtrip.json");
        let _ = std::fs::remove_file(&path);
        let first: serde_json::Value =
            serde_json::from_str(r#"{ "id": "off_demo", "title": "点咖啡" }"#).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(r#"{ "id": "off_travel", "source": "official" }"#).unwrap();
        write_to_path(
            &path,
            &OfficialScenarioCacheFile {
                schema_version: SCENARIO_CACHE_SCHEMA_VERSION,
                scenarios: vec![first.clone(), second.clone()],
            },
        )
        .unwrap();

        let back = read_from_path(&path).unwrap();

        assert_eq!(back.len(), 2);
        assert_eq!(back[0], first);
        assert_eq!(back[1], second);
        // 顶层 schemaVersion 序列化为 camelCase（与前端 tauriBridge 同口径）
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schemaVersion\":1"), "{text}");
        assert!(!text.contains("schema_version"), "{text}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_cache_is_error() {
        let path = temporary_path("corrupt.json");
        std::fs::write(&path, "不是 JSON").unwrap();

        let error = read_from_path(&path).unwrap_err();

        assert!(error.contains("损坏"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn version_mismatch_is_error() {
        let path = temporary_path("version.json");
        std::fs::write(&path, r#"{"schemaVersion":99,"scenarios":[]}"#).unwrap();

        let error = read_from_path(&path).unwrap_err();

        assert!(error.contains("版本不兼容"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_rejects_non_array() {
        // scenario_cache_write 的载荷校验抽成纯函数直测（免构造 AppHandle）
        let error = parse_scenarios_payload(r#"{"a":1}"#).unwrap_err();
        assert!(error.contains("JSON 数组"), "{error}");

        let ok = parse_scenarios_payload(r#"[{"id":"off_demo"}]"#).unwrap();
        assert_eq!(ok.len(), 1);
        assert!(parse_scenarios_payload("[]").unwrap().is_empty());
    }

    #[test]
    fn write_atomic_no_tmp_leftover() {
        let path = temporary_path("atomic.json");
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&tmp);
        write_to_path(
            &path,
            &OfficialScenarioCacheFile {
                schema_version: SCENARIO_CACHE_SCHEMA_VERSION,
                scenarios: Vec::new(),
            },
        )
        .unwrap();

        // 落盘完成且同目录无 .tmp 残留（rename 原子替换成功）
        assert!(path.exists());
        assert!(!tmp.exists(), "写盘后不应残留 {tmp:?}");
        let _ = std::fs::remove_file(&path);
    }
}
