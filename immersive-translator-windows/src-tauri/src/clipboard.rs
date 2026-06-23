use arboard::Clipboard;
use enigo::{Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;

/// 读取当前选中文本：保存原剪贴板 -> 模拟 Ctrl+C -> 读取新剪贴板 -> 恢复原剪贴板。
/// 对齐 Mac 版 ClipboardReader 行为。
#[tauri::command]
pub fn read_selection() -> Result<String, String> {
    // 1. 保存原剪贴板文本（如果有的话）
    let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    let original = clipboard.get_text().ok();

    // 2. 模拟 Ctrl+C
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("无法初始化键盘模拟: {e}"))?;
    enigo
        .key(Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("{e}"))?;
    enigo
        .key(Key::Unicode('c'), enigo::Direction::Click)
        .map_err(|e| format!("{e}"))?;
    enigo
        .key(Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("{e}"))?;

    // 3. 等待剪贴板更新（给系统/应用一点时间）
    thread::sleep(Duration::from_millis(120));

    // 4. 读取新剪贴板
    let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    let selected = clipboard.get_text().unwrap_or_default();

    // 5. 恢复原剪贴板
    if let Some(orig) = original {
        let _ = clipboard.set_text(orig);
    }

    Ok(selected.trim().to_string())
}
