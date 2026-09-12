//! M0 spike 的 Rust 侧：最小可跑即可。
//! M1 起移植桌面端 reader_store.rs（contracts v1 同一套 Tauri command）。

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![ping, storage_probe])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 连通性检查：WebView → Rust command。
#[tauri::command]
fn ping() -> String {
    "pong".into()
}

/// S1 观察点：移动端沙盒里可写的应用数据目录（打印到 Xcode console）。
#[tauri::command]
fn storage_probe(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let probe = dir.join("probe.txt");
    std::fs::write(&probe, b"spike").map_err(|e| format!("write: {e}"))?;
    let read_back = std::fs::read_to_string(&probe).map_err(|e| format!("read: {e}"))?;
    Ok(format!("{dir:?} read_back={read_back}"))
}
