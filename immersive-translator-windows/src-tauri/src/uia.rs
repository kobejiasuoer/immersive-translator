//! 通过 Windows UI Automation (UIAutomation) 直接读出前台窗口的选中文本。
//!
//! 这是"跨进程读取选区"的官方方案：UIA 是 Windows 系统级抽象，
//! 浏览器拦截 Ctrl+C、输入法抢占 Ctrl+C、Edge WebView2 等场景，
//! 只要控件实现 TextPattern 都能正确取到选区。Windows 8+ 可用。
//!
//! 失败时不抛错，只返回 Err —— 调用方应当回退到 Ctrl+C 模拟。

use std::thread;
use std::time::Duration;

use windows::core::BSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTextRangeArray, UIA_TextPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

/// 惰性构建 provider（如 Chrome / Edge / Electron）的重试间隔。
/// Chromium 收到首个 UIA 请求后才开始构建 accessibility tree，
/// 首次查询常常是空/不支持 TextPattern，稍后重试通常成功。
const UIA_RETRY_DELAY: Duration = Duration::from_millis(150);
const UIA_RETRY_MAX: usize = 3;

/// 从前台窗口读取 UI Automation 暴露的选区文本。
/// 多个不连续选区用换行拼接（UIA 的 TextPattern 在多选区时会返回多个 Range）。
///
/// 策略：
/// 1. 先尝试「焦点元素」（输入框/浏览器内部文本控件在此暴露 TextPattern）；
/// 2. 失败再退回「前台窗口顶层元素」；
/// 3. 浏览器/现代控件首次请求会惰性构建 tree，因此整体失败会重试 N 次。
pub fn read_selection_uia() -> Result<String, String> {
    // COM 初始化（STA 模式，UIA TextPattern 必须）。同一线程二次调用返回 RPC_E_CHANGED_MODE 时忽略。
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err("前台窗口为空".into());
    }

    // 创建 UIAutomation 单例（每次热键重新创建一次，安全且廉价）
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("UIAutomation 初始化失败: {e}"))?
    };

    let mut last_err = String::from("未尝试读取");
    for attempt in 0..UIA_RETRY_MAX {
        match read_selection_once(&automation, hwnd) {
            Ok(text) => {
                log_foreground(hwnd);
                if attempt > 0 {
                    eprintln!("[read_selection_uia] hit on retry #{attempt}");
                }
                return Ok(text);
            }
            Err(reason) => {
                last_err = reason;
                if attempt + 1 < UIA_RETRY_MAX {
                    thread::sleep(UIA_RETRY_DELAY);
                }
            }
        }
    }

    Err(last_err)
}

/// 单次读取：focused → 顶层元素。任一拿到文本即返回。
fn read_selection_once(automation: &IUIAutomation, hwnd: HWND) -> Result<String, String> {
    // 第一优先：焦点元素
    if let Ok(focused) = unsafe { automation.GetFocusedElement() } {
        if let Ok(text) = extract_selection(&focused) {
            return Ok(text);
        }
    }

    // 第二优先：前台窗口顶层元素
    let element = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|e| format!("UIAutomation 找不到前台元素: {e}"))?;
    extract_selection(&element)
}

/// 从给定 UIA 元素提取 TextPattern 下的当前选区文本。
fn extract_selection(element: &IUIAutomationElement) -> Result<String, String> {
    // TextPattern：查当前支持的 Pattern。
    // 浏览器/WPF/WinForms/UWP 大多支持；记事本、Cmd、PowerShell 等 Win32 老控件不支持。
    let pattern: IUIAutomationTextPattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
    }
    .map_err(|e| format!("当前控件不支持 TextPattern: {e}"))?;

    // 选区：可能是 0、1 或多个 range（多选区）
    let ranges: IUIAutomationTextRangeArray = unsafe { pattern.GetSelection() }
        .map_err(|e| format!("读取选区失败: {e}"))?;
    let len = unsafe { ranges.Length() }.unwrap_or(0);

    if len == 0 {
        return Err("前台控件无选区（用户可能没有选中文字）".into());
    }

    // 拼接所有 range 的文本
    // GetText(maxLength): maxLength=0 表示无限制，符合 UIA 标准。
    let mut combined = String::new();
    for i in 0..len {
        let range = unsafe { ranges.GetElement(i) }
            .map_err(|e| format!("GetElement({i}) 失败: {e}"))?;
        let bstr: BSTR = unsafe { range.GetText(0) }
            .map_err(|e| format!("GetText 失败: {e}"))?;
        // BSTR 实现了 Deref<Target=[u16]>，可直接转 String
        let text = String::from_utf16_lossy(&*bstr);
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(trimmed);
        }
    }

    if combined.is_empty() {
        return Err("选区内容为空".into());
    }

    Ok(combined)
}

fn log_foreground(hwnd: HWND) {
    unsafe {
        let mut buf = [0u16; 512];
        let _ = GetWindowTextW(hwnd, &mut buf);
        let len = buf.iter().position(|w| *w == 0).unwrap_or(buf.len());
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len])
        } else {
            "(no title)".to_string()
        };
        eprintln!("[read_selection_uia] foreground: title={title:?}");
    }
}