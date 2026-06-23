use arboard::Clipboard;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_CONTROL, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

const VK_C: u16 = 0x43;
const VK_Q: u16 = 0x51;

unsafe fn send_key(vk: u16, up: bool) {
    let mut flags = 0u32;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let ptr = [input].as_ptr();
    SendInput(1, ptr, std::mem::size_of::<INPUT>() as i32);
}

fn is_key_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) & 0x8000u16 as i16) != 0 }
}

fn wait_for_hotkey_release(timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !is_key_down(VK_CONTROL as u16)
            && !is_key_down(VK_SHIFT as u16)
            && !is_key_down(VK_Q)
        {
            thread::sleep(Duration::from_millis(80));
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    eprintln!("[read_selection] hotkey release wait timed out");
}

fn log_foreground_window() {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            eprintln!("[read_selection] foreground window: (none)");
            return;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            "(no title)".to_string()
        };
        eprintln!("[read_selection] foreground window: hwnd={hwnd:?}, title={title:?}");
    }
}

fn send_ctrl_c() {
    unsafe {
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(VK_C, false);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_C, true);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
}

fn clipboard_sentinel() -> String {
    format!(
        "__IMMERSIVE_TRANSLATOR_SELECTION_SENTINEL_{}_{}__",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub fn read_selection_impl() -> Result<String, String> {
    eprintln!("[read_selection] start");

    wait_for_hotkey_release(Duration::from_millis(700));

    let mut clipboard = Clipboard::new().map_err(|e| {
        eprintln!("[read_selection] Clipboard::new failed: {e}");
        format!("无法访问剪贴板: {e}")
    })?;
    let original = clipboard.get_text().ok();
    eprintln!(
        "[read_selection] saved original clipboard, has_old={}",
        original.is_some()
    );

    let sentinel = clipboard_sentinel();
    clipboard.set_text(sentinel.clone()).map_err(|e| {
        eprintln!("[read_selection] prepare clipboard sentinel failed: {e}");
        format!("无法准备剪贴板读取: {e}")
    })?;
    eprintln!("[read_selection] prepared clipboard sentinel");

    log_foreground_window();
    eprintln!("[read_selection] sending Ctrl+C via SendInput");
    send_ctrl_c();
    eprintln!("[read_selection] Ctrl+C sent");

    let poll_start = Instant::now();
    let mut selected = String::new();
    let poll_interval = Duration::from_millis(40);
    let max_wait = Duration::from_millis(1400);

    loop {
        thread::sleep(poll_interval);
        let mut cb = match Clipboard::new() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Ok(text) = cb.get_text() {
            if text != sentinel && !text.trim().is_empty() {
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

    let mut cb = Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    if let Some(orig) = original {
        let _ = cb.set_text(orig);
    } else {
        let _ = cb.set_text(String::new());
    }
    eprintln!("[read_selection] restored original clipboard");

    let result = selected.trim().to_string();
    eprintln!(
        "[read_selection] done, returning len={}",
        result.chars().count()
    );
    Ok(result)
}

#[tauri::command]
pub fn read_selection() -> Result<String, String> {
    read_selection_impl()
}
