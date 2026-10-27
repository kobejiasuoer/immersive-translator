//! 云同步（升级计划 A0，计划书 §2.3/§6）：/v1/sync 传输命令 + 通用同步实体本地存储。
//!
//! 分层约定：
//! - 传输命令（sync_pull/sync_push）挂在 `TokenManager::with_auth` 上——
//!   base URL 解析、token 附带、401 单飞刷新全部继承 auth.rs；token 永不跨 IPC
//!   （红线 D4/D5）。与埋点不同：**非 2xx 是协议数据不是错误**（404 白名单外、
//!   409 冲突、413 超限、429 限流都由前端引擎按协议处置），命令原样带回
//!   `{status, body, retryAfterSeconds}`；只有网络/致命鉴权错误才 reject。
//! - 协议逻辑（游标推进、LWW 合并、409/429 处理、512KB 预检）在前端
//!   `src/lib/syncEngine.ts`——本模块只提供存储原语（列表 / 按 id 整体替换 /
//!   每集合游标），沿用 reader_store.rs 的落盘模式（串行锁 + 原子重写 +
//!   schema_version + 只豁免 NotFound）。
//!
//! 文件布局：`app_data_dir/sync/<collection>.json` + `app_data_dir/sync/cursors.json`。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::auth::{emit_fatal_if_needed, AuthError, TokenManager};

pub const SYNC_STORE_SCHEMA_VERSION: u32 = 1;

/// 本地允许持久化的集合（与服务端 SYNC_COLLECTIONS 白名单对齐；
/// 集合名进文件路径，白名单即路径校验，防任意文件名读写）。
const LOCAL_COLLECTIONS: &[&str] = &["speak-scenarios"];

// ---------------------------------------------------------------------------
// IPC 可见类型（字段与前端 src/lib/tauriBridge.ts 导出类型一字不差）
// ---------------------------------------------------------------------------

/// 一次 /v1/sync 请求的原始应答。非 2xx 也是正常返回（协议数据）。
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncHttpText {
    pub status: u16,
    pub body: String,
    pub retry_after_seconds: Option<u64>,
}

/// 本地同步实体（与服务端 WireEntity 的差集：多 `baseVersion`/`dirty`，
/// 少 `version`——服务端版本即 baseVersion 的同步值）。
///
/// - `base_version`：上次同步到的服务端版本；0 = 本地新建从未推送。
/// - `updated_at`：客户端逻辑时间（毫秒）——LWW 由前端比较，服务端只透传。
/// - `dirty`：本地新建/修改/软删除置 true；push accepted 后由前端清零。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSyncEntity {
    pub id: String,
    pub base_version: i64,
    pub updated_at: i64,
    pub deleted: bool,
    pub schema_version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_device: Option<String>,
    /// 活实体业务数据；tombstone 为 None（服务端要求 payload:null）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default)]
    pub dirty: bool,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncCollectionFile {
    schema_version: u32,
    #[serde(default)]
    entities: Vec<StoredSyncEntity>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncCursorsFile {
    schema_version: u32,
    #[serde(default)]
    cursors: std::collections::HashMap<String, i64>,
}

// ---------------------------------------------------------------------------
// 传输命令（薄封装：with_auth + 非 2xx 透传）
// ---------------------------------------------------------------------------

fn local_collection_error(collection: &str) -> AuthError {
    AuthError {
        code: "sync_collection_invalid".to_string(),
        message: format!("未知同步集合 {collection}（本地白名单外）"),
        http_status: None,
        retry_after_seconds: None,
    }
}

/// GET /v1/sync/{collection}/pull?since=&limit=。since 是版本号游标（非时间戳），
/// limit 收敛到 1..=500（服务端 SYNC_PULL_MAX_LIMIT）。
#[tauri::command]
pub async fn sync_pull(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    collection: String,
    since: i64,
    limit: i64,
) -> Result<SyncHttpText, AuthError> {
    if validate_collection(&collection).is_err() {
        return Err(local_collection_error(&collection));
    }
    let since = since.max(0);
    let limit = limit.clamp(1, 500);
    let path = format!("/v1/sync/{collection}/pull?since={since}&limit={limit}");
    match manager.with_auth(reqwest::Method::GET, &path, None).await {
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

/// POST /v1/sync/{collection}/push。entities_json 由前端序列化完整请求体
/// `{ entities: [...] }`（服务端 zod 校验为准，Rust 不重复形状校验）。
#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    manager: tauri::State<'_, std::sync::Arc<TokenManager>>,
    collection: String,
    entities_json: String,
) -> Result<SyncHttpText, AuthError> {
    if validate_collection(&collection).is_err() {
        return Err(local_collection_error(&collection));
    }
    let path = format!("/v1/sync/{collection}/push");
    match manager
        .with_auth(reqwest::Method::POST, &path, Some(entities_json))
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

// ---------------------------------------------------------------------------
// 本地存储（reader_store.rs 同模式：串行锁 + 原子重写 + 只豁免 NotFound）
// ---------------------------------------------------------------------------

fn sync_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("sync");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建同步数据目录: {e}"))?;
    Ok(dir)
}

/// 集合名直接进文件路径，白名单即路径校验（防任意文件名读写/穿越）。
fn validate_collection(collection: &str) -> Result<(), String> {
    if LOCAL_COLLECTIONS.contains(&collection) {
        Ok(())
    } else {
        Err(format!("未知同步集合 {collection}（本地白名单外）"))
    }
}

fn collection_path(app: &AppHandle, collection: &str) -> Result<PathBuf, String> {
    validate_collection(collection)?;
    Ok(sync_dir(app)?.join(format!("{collection}.json")))
}

fn cursors_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sync_dir(app)?.join("cursors.json"))
}

/// 写盘串行锁（独立于其他存储文件）。
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_collection_from_path(path: &std::path::Path) -> Result<SyncCollectionFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncCollectionFile {
                schema_version: SYNC_STORE_SCHEMA_VERSION,
                entities: Vec::new(),
            })
        }
        Err(e) => return Err(format!("读取同步数据 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(SyncCollectionFile {
            schema_version: SYNC_STORE_SCHEMA_VERSION,
            entities: Vec::new(),
        });
    }
    let file: SyncCollectionFile =
        serde_json::from_str(&text).map_err(|e| format!("同步数据损坏（{path:?}）: {e}"))?;
    if file.schema_version != SYNC_STORE_SCHEMA_VERSION {
        return Err(format!(
            "同步数据版本不兼容（文件 v{}，应用 v{SYNC_STORE_SCHEMA_VERSION}）。请升级应用后再打开。",
            file.schema_version
        ));
    }
    Ok(file)
}

fn write_collection_to_path(
    path: &std::path::Path,
    file: &SyncCollectionFile,
) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(file).map_err(|e| format!("序列化同步数据失败: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写入 {tmp:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

fn load_cursors_from_path(path: &std::path::Path) -> Result<SyncCursorsFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncCursorsFile {
                schema_version: SYNC_STORE_SCHEMA_VERSION,
                cursors: std::collections::HashMap::new(),
            })
        }
        Err(e) => return Err(format!("读取同步游标 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(SyncCursorsFile {
            schema_version: SYNC_STORE_SCHEMA_VERSION,
            cursors: std::collections::HashMap::new(),
        });
    }
    let file: SyncCursorsFile =
        serde_json::from_str(&text).map_err(|e| format!("同步游标损坏（{path:?}）: {e}"))?;
    if file.schema_version != SYNC_STORE_SCHEMA_VERSION {
        return Err(format!(
            "同步游标版本不兼容（文件 v{}，应用 v{SYNC_STORE_SCHEMA_VERSION}）。",
            file.schema_version
        ));
    }
    Ok(file)
}

fn write_cursors_to_path(path: &std::path::Path, file: &SyncCursorsFile) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(file).map_err(|e| format!("序列化同步游标失败: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写入 {tmp:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

/// 列出集合的全部本地实体（含 tombstone 与 dirty；updatedAt 倒序）。
/// 合并/过滤决策在前端 syncEngine.ts，这里只负责持久化。
#[tauri::command]
pub fn sync_store_list(
    app: AppHandle,
    collection: String,
) -> Result<Vec<StoredSyncEntity>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let path = collection_path(&app, &collection)?;
    let mut file = load_collection_from_path(&path)?;
    file.entities
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(file.entities)
}

/// 按 id 整体替换（存在即覆盖、不存在即追加）。不做新旧比较——
/// LWW 与 dirty 语义由前端决定后写入最终状态。
#[tauri::command]
pub fn sync_store_put(
    app: AppHandle,
    collection: String,
    entities: Vec<StoredSyncEntity>,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let path = collection_path(&app, &collection)?;
    let mut file = load_collection_from_path(&path)?;
    file.schema_version = SYNC_STORE_SCHEMA_VERSION;
    for entity in entities {
        match file.entities.iter().position(|e| e.id == entity.id) {
            Some(idx) => file.entities[idx] = entity,
            None => file.entities.push(entity),
        }
    }
    write_collection_to_path(&path, &file)
}

/// 读取集合游标（版本号；无记录默认 0 = 首次全量拉取）。
#[tauri::command]
pub fn sync_store_cursor_get(app: AppHandle, collection: String) -> Result<i64, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    if !LOCAL_COLLECTIONS.contains(&collection.as_str()) {
        return Err(format!("未知同步集合 {collection}（本地白名单外）"));
    }
    let path = cursors_path(&app)?;
    let file = load_cursors_from_path(&path)?;
    Ok(file.cursors.get(&collection).copied().unwrap_or(0))
}

/// 写入集合游标。每个集合必须各存各的（版本号空间跨集合共享，
/// 混用会漏拉低版本实体）。
#[tauri::command]
pub fn sync_store_cursor_set(
    app: AppHandle,
    collection: String,
    cursor: i64,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    if !LOCAL_COLLECTIONS.contains(&collection.as_str()) {
        return Err(format!("未知同步集合 {collection}（本地白名单外）"));
    }
    let path = cursors_path(&app)?;
    let mut file = load_cursors_from_path(&path)?;
    file.schema_version = SYNC_STORE_SCHEMA_VERSION;
    file.cursors.insert(collection, cursor.max(0));
    write_cursors_to_path(&path, &file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temporary_path(label: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "immersive-translator-sync-store-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn entity(id: &str, updated_at: i64, dirty: bool) -> StoredSyncEntity {
        StoredSyncEntity {
            id: id.to_string(),
            base_version: 0,
            updated_at,
            deleted: false,
            schema_version: 1,
            origin_device: Some("windows".to_string()),
            payload: Some(serde_json::json!({ "title": "t" })),
            dirty,
        }
    }

    #[test]
    fn missing_files_are_empty() {
        let col = temporary_path("missing-col.json");
        let cur = temporary_path("missing-cur.json");
        let _ = std::fs::remove_file(&col);
        let _ = std::fs::remove_file(&cur);

        let col_file = load_collection_from_path(&col).unwrap();
        assert_eq!(col_file.schema_version, SYNC_STORE_SCHEMA_VERSION);
        assert!(col_file.entities.is_empty());

        let cur_file = load_cursors_from_path(&cur).unwrap();
        assert!(cur_file.cursors.is_empty());
    }

    #[test]
    fn put_upserts_by_id_and_roundtrips() {
        let path = temporary_path("upsert.json");
        let _ = std::fs::remove_file(&path);

        let mut file = SyncCollectionFile {
            schema_version: SYNC_STORE_SCHEMA_VERSION,
            entities: vec![entity("a", 100, true), entity("b", 200, false)],
        };
        write_collection_to_path(&path, &file).unwrap();

        // 同 id 覆盖（dirty 更新后的最终状态），新 id 追加
        file.entities[0] = entity("a", 300, false);
        file.entities.push(entity("c", 50, true));
        for e in file.entities.clone() {
            let mut merged = load_collection_from_path(&path).unwrap();
            match merged.entities.iter().position(|x| x.id == e.id) {
                Some(idx) => merged.entities[idx] = e,
                None => merged.entities.push(e),
            }
            write_collection_to_path(&path, &merged).unwrap();
        }

        let loaded = load_collection_from_path(&path).unwrap();
        assert_eq!(loaded.entities.len(), 3);
        let a = loaded.entities.iter().find(|e| e.id == "a").unwrap();
        assert_eq!(a.updated_at, 300);
        assert!(!a.dirty);
        assert!(loaded.entities.iter().any(|e| e.id == "c"));
    }

    #[test]
    fn tombstone_payload_is_none_and_survives_roundtrip() {
        let path = temporary_path("tombstone.json");
        let _ = std::fs::remove_file(&path);
        let mut tombstone = entity("gone", 500, true);
        tombstone.deleted = true;
        tombstone.payload = None;
        let file = SyncCollectionFile {
            schema_version: SYNC_STORE_SCHEMA_VERSION,
            entities: vec![tombstone],
        };
        write_collection_to_path(&path, &file).unwrap();
        let loaded = load_collection_from_path(&path).unwrap();
        assert!(loaded.entities[0].deleted);
        assert!(loaded.entities[0].payload.is_none());
    }

    #[test]
    fn cursors_roundtrip_per_collection() {
        let path = temporary_path("cursors.json");
        let _ = std::fs::remove_file(&path);
        let mut file = load_cursors_from_path(&path).unwrap();
        file.cursors.insert("speak-scenarios".to_string(), 42);
        write_cursors_to_path(&path, &file).unwrap();
        let loaded = load_cursors_from_path(&path).unwrap();
        assert_eq!(loaded.cursors.get("speak-scenarios"), Some(&42));
    }

    #[test]
    fn corrupted_file_errors_instead_of_clearing() {
        let path = temporary_path("corrupt.json");
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_collection_from_path(&path).is_err());
    }

    #[test]
    fn future_schema_version_is_rejected() {
        let path = temporary_path("future.json");
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, format!(r#"{{"schemaVersion":99,"entities":[]}}"#)).unwrap();
        assert!(load_collection_from_path(&path)
            .unwrap_err()
            .contains("版本不兼容"));
    }

    #[test]
    fn local_collection_whitelist_guards_paths() {
        // LOCAL_COLLECTIONS 同时是文件名白名单：集合名直接进路径，
        // 白名单外（含路径穿越形态）必须拒绝。
        assert!(validate_collection("speak-scenarios").is_ok());
        for bad in ["../../etc/passwd", "history", "settings", ""] {
            assert!(validate_collection(bad).is_err(), "{bad}");
        }
    }
}
