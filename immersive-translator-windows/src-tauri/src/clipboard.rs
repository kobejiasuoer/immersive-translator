use arboard::Clipboard;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{fs, io::Write, path::PathBuf, sync::Mutex, sync::OnceLock};
use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, SetForegroundWindow,
};

use crate::uia;

/// 诊断日志：同时写 stderr 和 %APPDATA%/com.immersivetranslator.windows/selection.log。
/// GUI 子系统的 release 构建没有控制台，stderr 会丢，划词问题排查必须依赖文件日志。
pub fn diag_log(msg: &str) {
    static LOG: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();
    let file = LOG.get_or_init(|| {
        let path = std::env::var("APPDATA")
            .ok()
            .map(|d| {
                PathBuf::from(d)
                    .join("com.immersivetranslator.windows")
                    .join("selection.log")
            })
            .unwrap_or_else(|| PathBuf::from("selection.log"));
        let _ = fs::create_dir_all(path.parent().unwrap_or(&PathBuf::from(".")));
        let f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Mutex::new(f)
    });
    if let Ok(mut guard) = file.lock() {
        if let Some(f) = guard.as_mut() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
    eprintln!("[read_selection] {msg}");
}

/// 调用方语义：
/// - Ok(text)：选到了内容（已 trim），调用方直接使用
/// - Err(NoSelection)：用户没选中任何东西，前端提示"请先选中文本"
/// - Err(Other)：底层 API 不可用等系统问题，附带原因
#[derive(Debug)]
pub enum SelectionError {
    NoSelection,
    Other(String),
}

/// 主入口：Ctrl+C 模拟为主，UIA 直读兜底。
///
/// 不写哨兵，用序列号检测新复制；注入或剪贴板不可用时仍尝试 UIA。
pub fn read_selection_text(target_hwnd: isize) -> Result<String, SelectionError> {
    match read_selection_via_clipboard(target_hwnd) {
        Ok(text) => {
            diag_log(&format!("ctrl+c path hit, len={}", text.chars().count()));
            Ok(text)
        }
        Err(copy_error) => {
            // Ctrl+C 没拿到：可能确实没选中文本，也可能目标应用忽略合成按键。
            // UIA 再试一次（含 Chromium kick + 子树扫描）。
            diag_log(&format!("ctrl+c miss: {copy_error:?} → fallback to UIA"));
            match uia::read_selection_uia(target_hwnd) {
                Ok(text) => {
                    diag_log(&format!("uia fallback hit, len={}", text.chars().count()));
                    Ok(text)
                }
                Err(reason) => {
                    diag_log(&format!("uia fallback miss too: {reason}"));
                    Err(copy_error)
                }
            }
        }
    }
}

/// Ctrl+C 模拟路径（主路径）。
fn read_selection_via_clipboard(target_hwnd: isize) -> Result<String, SelectionError> {
    match read_selection_impl(target_hwnd) {
        Ok(s) if !s.is_empty() => Ok(s),
        Ok(_) => Err(SelectionError::NoSelection),
        Err(e) => Err(SelectionError::Other(e)),
    }
}

/// arboard 在 get_text 而非 new 时打开剪贴板；只重试实际的占用错误。
fn read_clipboard_patient(total: Duration) -> Option<String> {
    read_clipboard_with_retry(total, || Clipboard::new()?.get_text())
}

fn read_clipboard_with_retry(
    total: Duration,
    mut read: impl FnMut() -> Result<String, arboard::Error>,
) -> Option<String> {
    let start = Instant::now();
    let mut backoff = Duration::from_millis(50);
    while start.elapsed() < total {
        match read() {
            Ok(text) => return Some(text),
            Err(arboard::Error::ClipboardOccupied) => {}
            Err(error) => {
                diag_log(&format!("clipboard read failed: {error}"));
                return None;
            }
        }
        thread::sleep(backoff.min(total.saturating_sub(start.elapsed())));
        backoff = (backoff + Duration::from_millis(50)).min(Duration::from_millis(200));
    }
    None
}

const VK_C: u16 = 0x43;
const VK_Q: u16 = 0x51;

fn keyboard_input(vk: u16, up: bool) -> INPUT {
    let mut flags = 0u32;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
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
    }
}

unsafe fn send_key(vk: u16, up: bool) {
    let input = keyboard_input(vk, up);
    if SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) != 1 {
        diag_log("foreground activation key injection failed");
    }
}

fn is_key_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) & 0x8000u16 as i16) != 0 }
}

/// 当前仍被物理按住的修饰键（Ctrl/Shift/Alt/Win）。
/// 合成 Ctrl+C 前必须为空，否则会发出 Ctrl+Alt+C / Ctrl+Shift+C 之类的组合，
/// Chrome 收到这些组合不会复制（Ctrl+Shift+C 是 DevTools 快捷键）。
fn modifiers_down() -> Vec<&'static str> {
    let mut v = Vec::new();
    if is_key_down(VK_CONTROL as u16) {
        v.push("Ctrl");
    }
    if is_key_down(VK_SHIFT as u16) {
        v.push("Shift");
    }
    if is_key_down(VK_MENU as u16) {
        v.push("Alt");
    }
    if is_key_down(VK_LWIN as u16) || is_key_down(VK_RWIN as u16) {
        v.push("Win");
    }
    v
}

fn wait_for_hotkey_release(timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        let hotkey_up =
            !is_key_down(VK_CONTROL as u16) && !is_key_down(VK_SHIFT as u16) && !is_key_down(VK_Q);
        // 所有修饰键也必须松开（用户改键成 Alt/Win 系组合时同样不能残留）
        if hotkey_up && modifiers_down().is_empty() {
            thread::sleep(Duration::from_millis(80));
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "快捷键尚未松开，请松开后重试（修饰键：{:?}）",
        modifiers_down()
    ))
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
        diag_log(&format!(
            "foreground window: hwnd={hwnd:?}, title={title:?}"
        ));
    }
}

fn send_ctrl_c() -> Result<(), String> {
    send_ctrl_c_with(|inputs| unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    })
}

fn send_ctrl_c_with(mut send: impl FnMut(&[INPUT]) -> u32) -> Result<(), String> {
    // 一批提交，避免用户输入插入 Ctrl 按下与释放之间；数组存活到调用结束。
    let inputs = [
        keyboard_input(VK_CONTROL as u16, false),
        keyboard_input(VK_C, false),
        keyboard_input(VK_C, true),
        keyboard_input(VK_CONTROL as u16, true),
    ];
    let sent = send(&inputs);
    if sent != inputs.len() as u32 {
        // 部分注入后释放可能按下的键，避免 Ctrl 卡住。
        if sent > 0 {
            let releases = [
                keyboard_input(VK_C, true),
                keyboard_input(VK_CONTROL as u16, true),
            ];
            let _ = send(&releases);
        }
        return Err(format!(
            "Windows 未完整发送复制按键（{sent}/4），请检查目标应用是否以管理员权限运行"
        ));
    }
    Ok(())
}

/// 确保 target_hwnd 是前台窗口；不是则强制拉回。
///
/// SetForegroundWindow 有前台锁：后台进程直接调用通常被系统拒绝。
/// 经典解法是 AttachThreadInput 把本线程挂到目标窗口的输入队列上，
/// 再短按一次 ALT（让系统认为本线程收到过用户输入），即可解锁切换。
/// 返回调用结束时目标是否在前台。
fn ensure_foreground(target_hwnd: isize) -> bool {
    unsafe {
        let target = target_hwnd as windows_sys::Win32::Foundation::HWND;
        if target.is_null() {
            return false;
        }
        if GetForegroundWindow() == target {
            return true;
        }
        force_set_foreground(target);
        thread::sleep(Duration::from_millis(60));
        let ok = GetForegroundWindow() == target;
        diag_log(&format!(
            "foreground stolen → force activate {target_hwnd:#x}: {ok}"
        ));
        ok
    }
}

unsafe fn force_set_foreground(target: windows_sys::Win32::Foundation::HWND) {
    let this_tid = GetCurrentThreadId();
    let target_tid = GetWindowThreadProcessId(target, std::ptr::null_mut());
    let fg = GetForegroundWindow();
    let fg_tid = if fg.is_null() {
        0
    } else {
        GetWindowThreadProcessId(fg, std::ptr::null_mut())
    };

    let attached_target = target_tid != 0
        && target_tid != this_tid
        && AttachThreadInput(this_tid, target_tid, 1) != 0;
    let attached_fg = fg_tid != 0
        && fg_tid != this_tid
        && fg_tid != target_tid
        && AttachThreadInput(this_tid, fg_tid, 1) != 0;

    // 短按 ALT 解除前台锁，再切换
    send_key(VK_MENU as u16, false);
    thread::sleep(Duration::from_millis(30));
    send_key(VK_MENU as u16, true);
    let ok = SetForegroundWindow(target);
    eprintln!("[read_selection] SetForegroundWindow → {ok}");

    if attached_target {
        AttachThreadInput(this_tid, target_tid, 0);
    }
    if attached_fg {
        AttachThreadInput(this_tid, fg_tid, 0);
    }
}

/// Ctrl+C 复制整轮（激活 → 发送 → 轮询剪贴板）最多尝试次数。
/// 只有「期间前台被抢过」才会用第二次机会；目标一直在前台却没复制到，
/// 说明用户真的没有选中文本，不需要重试。
const CTRL_C_ATTEMPTS: usize = 2;

pub fn read_selection_impl(target_hwnd: isize) -> Result<String, String> {
    diag_log(&format!("ctrl+c path start, target_hwnd={target_hwnd:#x}"));

    wait_for_hotkey_release(Duration::from_millis(700))?;
    diag_log(&format!(
        "hotkey released, modifiers={:?}",
        modifiers_down()
    ));

    let poll_interval = Duration::from_millis(40);
    let max_wait = Duration::from_millis(1000);
    let mut selected = String::new();

    for attempt in 0..CTRL_C_ATTEMPTS {
        // 发送前把目标窗口拉回前台：等待期间前台可能被抢（微信等会周期性抢焦点），
        // Ctrl+C 发进别的窗口就什么都复制不到。
        if !ensure_foreground(target_hwnd) {
            return Err("无法激活原选区窗口，请返回原窗口后重试".into());
        }
        let mut stolen = false;

        // 合成按键前确认修饰键全部松开；还有残留就再等一小会，
        // 否则会发出 Ctrl+Alt+C / Ctrl+Shift+C，Chrome 不会复制。
        let settle_start = Instant::now();
        while !modifiers_down().is_empty() && settle_start.elapsed() < Duration::from_millis(400) {
            thread::sleep(Duration::from_millis(20));
        }
        let mods = modifiers_down();
        if !mods.is_empty() {
            return Err(format!("复制前仍有修饰键按下：{mods:?}，请松开后重试"));
        }

        if unsafe { GetForegroundWindow() } as isize != target_hwnd {
            return Err("原选区窗口已失去焦点，请返回原窗口后重试".into());
        }
        let seq_before = clipboard_sequence();
        log_foreground_window();
        diag_log(&format!(
            "sending Ctrl+C (attempt {}), seq_before={seq_before}",
            attempt + 1
        ));
        send_ctrl_c()?;
        // 目标应用完成复制需要一点时间；期间绝不打开剪贴板
        thread::sleep(Duration::from_millis(200));

        let poll_start = Instant::now();
        while poll_start.elapsed() < max_wait {
            thread::sleep(poll_interval);
            if !stolen
                && target_hwnd != 0
                && unsafe { GetForegroundWindow() } as isize != target_hwnd
            {
                stolen = true;
            }
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == seq_before {
                continue; // 剪贴板没有任何新写入
            }
            // 有新写入后再打开剪贴板，短暂占用时在限定时间内重试。
            if let Some(text) = read_clipboard_patient(Duration::from_millis(600)) {
                if !text.trim().is_empty() {
                    selected = text;
                    diag_log(&format!(
                        "clipboard updated seq {seq_before}→{seq}, read len={}",
                        selected.chars().count()
                    ));
                    break;
                }
            }
        }
        diag_log(&format!(
            "attempt {} done: polled {}ms, selected len={}, stolen={}",
            attempt + 1,
            poll_start.elapsed().as_millis(),
            selected.chars().count(),
            stolen
        ));

        if !selected.is_empty() {
            break;
        }
        // 前台稳定但没复制到：交给 UIA 判断，不把超时等同于没有选区。
        if !stolen && mods.is_empty() {
            break;
        }
        diag_log("retrying with re-activation");
    }

    let result = selected.trim().to_string();
    diag_log(&format!(
        "ctrl+c path done, returning len={}",
        result.chars().count()
    ));
    Ok(result)
}

/// 最终兜底：等待用户手动按 Ctrl+C。
///
/// 序列号在显示提示之前采样，避免漏掉用户看到提示后立即复制的内容。
/// 面板关闭或来源窗口改变时取消，不能把之后无关的复制当作选区。
pub fn clipboard_sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub fn read_selection_via_user_copy(
    seq0: u32,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Option<String>, String> {
    diag_log("await user copy: watching clipboard seq");
    let start = Instant::now();
    while start.elapsed() < timeout {
        thread::sleep(Duration::from_millis(100));
        if cancelled() {
            return Ok(None);
        }
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq != seq0 {
            if let Some(text) = read_clipboard_patient(Duration::from_millis(800)) {
                let t = text.trim().to_string();
                if !t.is_empty() {
                    diag_log(&format!("await user copy: got len={}", t.chars().count()));
                    return if cancelled() { Ok(None) } else { Ok(Some(t)) };
                }
            }
        }
    }
    diag_log("await user copy: timeout");
    Err("等待复制超时".into())
}

#[tauri::command]
pub fn read_selection() -> Result<String, String> {
    // 该命令由前端按需调用（当前无人使用）；以调用时刻的前台为目标
    let target = unsafe { GetForegroundWindow() } as isize;
    match read_selection_text(target) {
        Ok(t) => Ok(t),
        Err(SelectionError::NoSelection) => Ok(String::new()),
        Err(SelectionError::Other(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_actual_clipboard_occupation() {
        let mut attempts = 0;
        let text = read_clipboard_with_retry(Duration::from_secs(1), || {
            attempts += 1;
            if attempts == 1 {
                Err(arboard::Error::ClipboardOccupied)
            } else {
                Ok("selected text".into())
            }
        });
        assert_eq!(text.as_deref(), Some("selected text"));
        assert_eq!(attempts, 2);
    }

    #[test]
    fn non_text_clipboard_is_not_retried() {
        let mut attempts = 0;
        assert!(read_clipboard_with_retry(Duration::from_secs(1), || {
            attempts += 1;
            Err(arboard::Error::ContentNotAvailable)
        })
        .is_none());
        assert_eq!(attempts, 1);
    }

    #[test]
    fn occupied_clipboard_stops_at_deadline() {
        let start = Instant::now();
        assert!(read_clipboard_with_retry(Duration::from_millis(80), || {
            Err(arboard::Error::ClipboardOccupied)
        })
        .is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn copy_inputs_are_ordered_and_owned_during_submission() {
        let mut calls = 0;
        send_ctrl_c_with(|inputs| {
            calls += 1;
            let keys: Vec<_> = inputs
                .iter()
                .map(|input| unsafe {
                    assert_eq!(input.r#type, INPUT_KEYBOARD);
                    (input.Anonymous.ki.wVk, input.Anonymous.ki.dwFlags)
                })
                .collect();
            assert_eq!(
                keys,
                vec![
                    (VK_CONTROL, 0),
                    (VK_C, 0),
                    (VK_C, KEYEVENTF_KEYUP),
                    (VK_CONTROL, KEYEVENTF_KEYUP),
                ]
            );
            inputs.len() as u32
        })
        .unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn partial_copy_injection_releases_keys_and_reports_failure() {
        let mut calls = 0;
        let result = send_ctrl_c_with(|inputs| {
            calls += 1;
            if calls == 1 {
                return 2;
            }
            assert_eq!(inputs.len(), 2);
            for input in inputs {
                assert_eq!(unsafe { input.Anonymous.ki.dwFlags }, KEYEVENTF_KEYUP);
            }
            2
        });
        assert!(result.unwrap_err().contains("2/4"));
        assert_eq!(calls, 2);
    }

    #[test]
    fn blocked_copy_injection_is_not_treated_as_success() {
        assert!(send_ctrl_c_with(|_| 0).unwrap_err().contains("0/4"));
    }

    #[test]
    fn manual_copy_cancellation_does_not_read_unrelated_clipboard() {
        let result = read_selection_via_user_copy(
            clipboard_sequence().wrapping_sub(1),
            Duration::from_secs(1),
            || true,
        )
        .unwrap();
        assert!(result.is_none());
    }
}
