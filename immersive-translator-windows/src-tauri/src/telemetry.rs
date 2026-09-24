//! 最小本地埋点（UX-6 落地的第一块基石）：
//! 事件以 JSONL 追加到 app_data_dir/logs/reader-events.jsonl，纯本地、无网络。
//! 结构：{ ts, name, props }。只服务产品成功指标的度量（方案 §8），
//! 失败一律静默（埋点永远不能打断主流程）。

use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static TELEMETRY_LOCK: Mutex<()> = Mutex::new(());

fn events_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录: {e}"))?;
    Ok(dir.join("reader-events.jsonl"))
}

/// 追加一条事件（读侧只假定每行一个 JSON 对象；props 任意 JSON）。
pub fn append_event(
    app: &AppHandle,
    name: &str,
    props: serde_json::Value,
    now_ms: i64,
) -> Result<(), String> {
    let _guard = TELEMETRY_LOCK
        .lock()
        .map_err(|_| "埋点锁不可用".to_string())?;
    let path = events_path(app)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开埋点文件失败: {e}"))?;
    let record = serde_json::json!({ "ts": now_ms, "name": name, "props": props });
    writeln!(file, "{record}").map_err(|e| format!("写入埋点失败: {e}"))
}

/// 埋点命令：失败静默（前端 catch 掉），绝不上抛打断主流程。
#[tauri::command]
pub fn telemetry_log_event(app: AppHandle, name: String, props: Option<serde_json::Value>) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let _ = append_event(&app, &name, props.unwrap_or(serde_json::json!({})), now_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_record_shape_roundtrip() {
        let now: i64 = 1_800_000_000_000;
        let record = serde_json::json!({
            "ts": now,
            "name": "book_import_result",
            "props": { "ok": true, "chapterCount": 7 }
        });
        let line = format!("{record}");
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["name"], "book_import_result");
        assert_eq!(parsed["props"]["chapterCount"], 7);
        assert_eq!(parsed["ts"], now);
    }
}
