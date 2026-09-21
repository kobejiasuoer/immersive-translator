//! 口语陪练会话存储（R3，沿用 reader_store.rs 的落盘模式）。
//!
//! - 会话（含对话轮与跟读分）：app_data_dir/reader_speak_sessions.json
//! - 与前端 src/core/speakLogic.ts、contracts/reading-room.schema.json 的
//!   speakSession 定义同构，camelCase 序列化。
//! - 只保留最近 50 个会话，防无限膨胀。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const SPEAK_SCHEMA_VERSION: u32 = 1;
const MAX_SESSIONS: usize = 50;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakRole {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakScenarioId {
    Ordering,
    Interview,
    Travel,
    Smalltalk,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakDifficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeakTurn {
    pub role: SpeakRole,
    pub text: String,
    /// assistant 轮的中文提示
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint_zh: Option<String>,
    /// assistant 轮的跟读分（5 分制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_score: Option<f64>,
    /// Unix 毫秒
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeakSession {
    pub id: String,
    pub scenario: SpeakScenarioId,
    pub difficulty: SpeakDifficulty,
    pub turns: Vec<SpeakTurn>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeakSessionsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub sessions: Vec<SpeakSession>,
}

fn sessions_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("reader_speak_sessions.json"))
}

/// 写盘串行锁（与 reader_store 同模式；会话文件独立于文章/生词文件）。
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_sessions(app: &AppHandle) -> Result<SpeakSessionsFile, String> {
    load_sessions_from_path(&sessions_path(app)?)
}

fn empty_sessions_file() -> SpeakSessionsFile {
    SpeakSessionsFile {
        schema_version: SPEAK_SCHEMA_VERSION,
        sessions: Vec::new(),
    }
}

/// 只豁免 NotFound：杀软/备份锁文件、双开实例等读错误必须报出来，
/// 否则下一次整存会话（每轮对话后自动保存）会把全部口语陪练记录静默清空。
fn load_sessions_from_path(path: &std::path::Path) -> Result<SpeakSessionsFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_sessions_file()),
        Err(e) => return Err(format!("读取口语陪练会话数据 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(empty_sessions_file());
    }
    let file: SpeakSessionsFile =
        serde_json::from_str(&text).map_err(|e| format!("口语陪练会话数据损坏: {e}"))?;
    if file.schema_version != SPEAK_SCHEMA_VERSION {
        return Err(format!(
            "口语陪练数据版本不兼容（文件 v{}，应用 v{SPEAK_SCHEMA_VERSION}）。请升级应用后再打开。",
            file.schema_version
        ));
    }
    Ok(file)
}

fn write_sessions(app: &AppHandle, file: &SpeakSessionsFile) -> Result<(), String> {
    let path = sessions_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(file).map_err(|e| format!("序列化会话失败: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写入 {path:?} 失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

/// 列出会话（updatedAt 倒序，最近在前）。
#[tauri::command]
pub fn speak_list_sessions(app: AppHandle) -> Result<Vec<SpeakSession>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_sessions(&app)?;
    file.sessions
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(file.sessions)
}

/// 新建或整体更新一个会话（前端每轮对话后自动保存）。
#[tauri::command]
pub fn speak_save_session(app: AppHandle, session: SpeakSession) -> Result<SpeakSession, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let id = session.id.clone();
    let mut file = load_sessions(&app)?;
    file.schema_version = SPEAK_SCHEMA_VERSION;
    match file.sessions.iter_mut().find(|s| s.id == id) {
        Some(existing) => *existing = session,
        None => file.sessions.push(session),
    }
    // 只留最近 50 个
    if file.sessions.len() > MAX_SESSIONS {
        file.sessions
            .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        file.sessions.truncate(MAX_SESSIONS);
    }
    write_sessions(&app, &file)?;
    // 截断只丢最旧会话；刚保存的 updatedAt 最新，但稳妥起见不 expect（panic 会带崩命令）。
    file.sessions
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "保存后会话丢失（可能被数量上限截断）".to_string())
}

#[tauri::command]
pub fn speak_delete_session(app: AppHandle, id: String) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_sessions(&app)?;
    let before = file.sessions.len();
    file.sessions.retain(|s| s.id != id);
    let removed = file.sessions.len() != before;
    if removed {
        write_sessions(&app, &file)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temporary_path(label: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "immersive-translator-speak-store-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_sessions_file_is_an_empty_library() {
        let path = temporary_path("missing.json");
        let _ = std::fs::remove_file(&path);

        let file = load_sessions_from_path(&path).unwrap();

        assert_eq!(file.schema_version, SPEAK_SCHEMA_VERSION);
        assert!(file.sessions.is_empty());
    }

    #[test]
    fn unreadable_sessions_file_is_an_error_not_an_empty_library() {
        let path = temporary_path("directory");
        std::fs::create_dir(&path).unwrap();

        let error = load_sessions_from_path(&path).unwrap_err();

        assert!(error.starts_with("读取口语陪练会话数据"), "{error}");
        let _ = std::fs::remove_dir(&path);
    }

    #[test]
    fn session_roundtrip_camel_case() {
        let json = r#"{
            "id": "s1", "scenario": "ordering", "difficulty": "easy",
            "turns": [
                { "role": "assistant", "text": "Hi!", "hintZh": "你好", "at": 1 },
                { "role": "user", "text": "A coffee please", "at": 2 },
                { "role": "assistant", "text": "Sure thing.", "hintZh": "好的", "shadowScore": 4.5, "at": 3 }
            ],
            "createdAt": 0, "updatedAt": 3
        }"#;
        let s: SpeakSession = serde_json::from_str(json).expect("会话反序列化");
        assert_eq!(s.scenario, SpeakScenarioId::Ordering);
        assert_eq!(s.difficulty, SpeakDifficulty::Easy);
        assert_eq!(s.turns.len(), 3);
        assert_eq!(s.turns[0].hint_zh.as_deref(), Some("你好"));
        assert_eq!(s.turns[2].shadow_score, Some(4.5));
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(out["turns"][0]["hintZh"], "你好");
        assert_eq!(out["turns"][2]["shadowScore"], 4.5);

        // 老数据（无 hint/score 字段）照常加载
        let legacy: SpeakTurn =
            serde_json::from_str(r#"{ "role": "user", "text": "hi", "at": 0 }"#)
                .expect("老轮次可加载");
        assert_eq!(legacy.hint_zh, None);
        assert_eq!(legacy.shadow_score, None);
    }
}
