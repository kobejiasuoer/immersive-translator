use arboard::Clipboard;
use enigo::{Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::{Duration, Instant};

/// 读取当前选中文本的内部实现（非命令，可被热键 handler 直接调用）。
/// 流程：保存原剪贴板 -> 模拟 Ctrl+C -> 等待新剪贴板 -> 恢复原剪贴板。
///
/// 关键可靠性处理：
/// 1. 模拟 Ctrl+C 前先释放所有可能残留的修饰键（Alt/Win/Shift）——
///    全局热键 Alt+Space 触发后，Alt 键状态可能未被系统清除，
///    若不释放，实际发出去的是 Ctrl+Alt+C，复制会失败。
/// 2. 按键之间留 40ms 间隔，给目标应用响应时间。
/// 3. 复制后轮询剪贴板变化（最多 800ms），比固定 sleep 更可靠。
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

    // 先释放所有可能残留的修饰键，避免组合键污染
    let _ = enigo.key(Key::Alt, enigo::Direction::Release);
    let _ = enigo.key(Key::Meta, enigo::Direction::Release);
    let _ = enigo.key(Key::Shift, enigo::Direction::Release);
    let _ = enigo.key(Key::Control, enigo::Direction::Release);
    thread::sleep(Duration::from_millis(40));

    eprintln!("[read_selection] released modifier keys, sending Ctrl+C");
    enigo
        .key(Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("{e}"))?;
    thread::sleep(Duration::from_millis(40));
    enigo
        .key(Key::Unicode('c'), enigo::Direction::Click)
        .map_err(|e| format!("{e}"))?;
    thread::sleep(Duration::from_millis(40));
    enigo
        .key(Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("{e}"))?;
    eprintln!("[read_selection] Ctrl+C sent");

    // 3. 轮询等待剪贴板变化（最多 800ms）
    let poll_start = Instant::now();
    let mut selected = String::new();
    let poll_interval = Duration::from_millis(40);
    let max_wait = Duration::from_millis(800);

    loop {
        thread::sleep(poll_interval);
        let mut cb = match Clipboard::new() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Ok(text) = cb.get_text() {
            if text != original.clone().unwrap_or_default() && !text.trim().is_empty() {
                selected = text;
                break;
            }
        }
        if poll_start.elapsed() >= max_wait {
            break;
        }
    }
    eprintln!(
        "[read_selection] polled {}ms, selected len={}",
        poll_start.elapsed().as_millis(),
        selected.chars().count()
    );

    // 4. 恢复原剪贴板
    if let Some(orig) = original {
        let mut cb = Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
        let _ = cb.set_text(orig);
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
