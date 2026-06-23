use arboard::Clipboard;
use enigo::{Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;

/// 读取当前选中文本的内部实现（非命令，可被热键 handler 直接调用）。
/// 流程：保存原剪贴板 -> 模拟 Ctrl+C -> 读取新剪贴板 -> 恢复原剪贴板。
pub fn read_selection_impl() -> Result<String, String> {
    eprintln!("[read_selection] start");

    // 1. 保存原剪贴板文本（如果有的话）
    let mut clipboard = Clipboard::new().map_err(|e| {
        eprintln!("[read_selection] Clipboard::new failed: {e}");
        format!("无法访问剪贴板: {e}")
    })?;
    let original = clipboard.get_text().ok();
    eprintln!(
        "[read_selection] saved original clipboard, has_old={}",
        original.is_some()
    );

    // 2. 模拟 Ctrl+C
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        eprintln!("[read_selection] Enigo::new failed: {e}");
        format!("无法初始化键盘模拟: {e}")
    })?;
    eprintln!("[read_selection] enigo ready, sending Ctrl+C");

    enigo
        .key(Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("{e}"))?;
    enigo
        .key(Key::Unicode('c'), enigo::Direction::Click)
        .map_err(|e| format!("{e}"))?;
    enigo
        .key(Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("{e}"))?;
    eprintln!("[read_selection] Ctrl+C sent");

    // 3. 等待剪贴板更新（给系统/应用一点时间）
    thread::sleep(Duration::from_millis(150));
    eprintln!("[read_selection] waited 150ms");

    // 4. 读取新剪贴板
    let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    let selected = clipboard.get_text().unwrap_or_default();
    eprintln!(
        "[read_selection] read new clipboard, len={}",
        selected.chars().count()
    );

    // 5. 恢复原剪贴板
    if let Some(orig) = original {
        let _ = clipboard.set_text(orig);
        eprintln!("[read_selection] restored original clipboard");
    }

    let result = selected.trim().to_string();
    eprintln!(
        "[read_selection] done, returning len={}",
        result.chars().count()
    );
    Ok(result)
}

/// Tauri 命令版本（前端可通过 invoke 调用，保留兼容）。
#[tauri::command]
pub fn read_selection() -> Result<String, String> {
    read_selection_impl()
}
