//! 通过 Windows UI Automation (UIAutomation) 直接读出目标窗口的选中文本。
//!
//! 这是"跨进程读取选区"的官方方案：UIA 是 Windows 系统级抽象，
//! 浏览器拦截 Ctrl+C、输入法抢占 Ctrl+C、Edge WebView2 等场景，
//! 只要控件实现 TextPattern 都能正确取到选区。Windows 8+ 可用。
//!
//! 关键坑（实测）：Chromium 系应用（Chrome/Edge/微信/Electron）默认
//! **不构建无障碍树**——首次 UIA 查询只能拿到一个不带 TextPattern 的
//! 壳元素，必须先发 WM_GETOBJECT(OBJID_CLIENT) 触发它建树，然后等
//! 500ms~2s（重页面更慢）再查才有结果。因此这里主动 kick + 较长重试。
//!
//! 失败时不抛错，只返回 Err —— 调用方应当回退到 Ctrl+C 模拟。

use std::thread;
use std::time::Duration;

use windows::core::BSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_DISABLE_OLE1DDE,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationElementArray, IUIAutomationTextPattern, IUIAutomationTextRangeArray,
    TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, SendMessageTimeoutW, OBJID_CLIENT, SMTO_ABORTIFHUNG, WM_GETOBJECT,
};

use crate::clipboard::diag_log;

/// 惰性构建 provider（Chromium 系）的重试间隔。
/// kick 之后树要异步构建，250ms 一轮、最多 5 轮 ≈ 1.3s，成功即提前返回。
/// （每轮含全量子树扫描，轮数多了总时延会失控。）
const UIA_RETRY_DELAY: Duration = Duration::from_millis(250);
const UIA_RETRY_MAX: usize = 5;

/// 单轮扫描子树 TextPattern 元素的上限。
/// Electron 应用（如聊天工具）会把整段对话拆成上百个小文本元素，
/// 必须逐个问选区；上限防止超大页面把时延拖爆。
/// （实测 ZCode 窗口有 210 个文本元素，120 会截断漏扫。）
const UIA_TEXT_SCAN_LIMIT: usize = 256;

/// 一次完整读取的扫描统计（用于失败诊断日志）。
#[derive(Default)]
struct ScanStats {
    text_elements: usize,
}

/// 从目标窗口读取 UI Automation 暴露的选区文本。
/// 多个不连续选区用换行拼接（UIA 的 TextPattern 在多选区时会返回多个 Range）。
///
/// target_hwnd 是热键按下瞬间的前台窗口；等待期间前台/焦点可能被抢走
/// （微信等会周期性抢焦点），所以不能只看系统焦点元素——
/// 焦点元素仅在它仍属于目标窗口时使用，否则直接在目标窗口子树里找文本控件。
pub fn read_selection_uia(target_hwnd: isize) -> Result<String, String> {
    // UIA 客户端运行在独立的 MTA 工作线程；每次成功初始化都要配对释放。
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .map_err(|e| format!("UIAutomation COM 初始化失败: {e}"))?;
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com = ComGuard;

    let hwnd = if target_hwnd != 0 {
        HWND(target_hwnd as *mut _)
    } else {
        unsafe { GetForegroundWindow() }
    };
    if hwnd.0.is_null() {
        return Err("目标窗口为空".into());
    }

    // 创建 UIAutomation 单例（每次热键重新创建一次，安全且廉价）
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("UIAutomation 初始化失败: {e}"))?
    };

    let mut last_err = String::from("未尝试读取");
    let mut stats = ScanStats::default();
    for attempt in 0..UIA_RETRY_MAX {
        // 每轮都 kick：首轮触发建树，后续轮次对已建树的应用是无害空操作
        kick_chromium_a11y(hwnd);
        match read_selection_once(&automation, hwnd, &mut stats) {
            Ok(text) => {
                log_foreground(hwnd);
                diag_log(&format!(
                    "uia ok on attempt {}, len={}",
                    attempt + 1,
                    text.chars().count()
                ));
                return Ok(text);
            }
            Err(reason) => {
                if attempt == 0 {
                    diag_log(&format!("uia attempt 1 failed: {reason}"));
                }
                last_err = reason;
                if attempt + 1 < UIA_RETRY_MAX {
                    thread::sleep(UIA_RETRY_DELAY);
                }
            }
        }
    }
    diag_log(&format!(
        "uia all {UIA_RETRY_MAX} attempts failed: {last_err} (text_elements_scanned={})",
        stats.text_elements
    ));
    Err(last_err)
}

/// 主动触发 Chromium 系应用构建无障碍树：对目标窗口及其全部直接子窗口
/// 发 WM_GETOBJECT(OBJID_CLIENT)。Chrome 的渲染控件是顶层窗口的直接
/// 子窗口（Chrome_RenderWidgetHostHWND），收到该消息即开始建树。
/// 对非 Chromium 应用是无害的标准无障碍查询。
/// 用 SendMessageTimeoutW + SMTO_ABORTIFHUNG：目标窗口若卡死，
/// 阻塞版 SendMessageW 会把读取线程一起拖死（表现为热键"毫无反应"）。
fn kick_chromium_a11y(hwnd: HWND) {
    unsafe {
        SendMessageTimeoutW(
            hwnd.0.cast(),
            WM_GETOBJECT,
            0,
            OBJID_CLIENT as isize,
            SMTO_ABORTIFHUNG,
            300,
            std::ptr::null_mut(),
        );
        let mut child = std::ptr::null_mut();
        loop {
            child = FindWindowExW(hwnd.0.cast(), child, std::ptr::null(), std::ptr::null());
            if child.is_null() {
                break;
            }
            SendMessageTimeoutW(
                child,
                WM_GETOBJECT,
                0,
                OBJID_CLIENT as isize,
                SMTO_ABORTIFHUNG,
                300,
                std::ptr::null_mut(),
            );
        }
    }
}

/// 单次读取：焦点元素（仍属于目标窗口时）→ 子树【所有】文本控件逐个问选区 → 顶层元素。
///
/// 为什么不能只看焦点元素：用户常用鼠标在聊天记录/文档正文里选中文字，
/// 键盘焦点却停在输入框上——选区挂在文档或其他文本控件上（实测 ZCode 窗口
/// 有 210 个文本控件，选中的内容不在焦点的输入框里）。
fn read_selection_once(
    automation: &IUIAutomation,
    hwnd: HWND,
    stats: &mut ScanStats,
) -> Result<String, String> {
    let fg_is_target = unsafe { GetForegroundWindow() } == hwnd;

    // 前台仍是目标窗口：焦点元素就是用户正在操作的控件（页面文档/地址栏/输入框）
    if fg_is_target {
        if let Ok(focused) = unsafe { automation.GetFocusedElement() } {
            if let Ok(text) = extract_selection(&focused) {
                return Ok(text);
            }
        }
    }

    let element = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|e| format!("UIAutomation 找不到目标窗口元素: {e}"))?;

    // 子树中所有支持 TextPattern 的元素逐个取选区，返回第一个非空的。
    // 文档控件通常排在首位（覆盖普通网页）；Electron 聊天类应用选区可能
    // 挂在任意一个文本片段元素上（覆盖文档 GetSelection 为空的场景）。
    if let Ok(array) = find_text_elements(automation, &element) {
        let len = unsafe { array.Length() }
            .unwrap_or(0)
            .min(UIA_TEXT_SCAN_LIMIT as i32);
        stats.text_elements = len as usize;
        for i in 0..len {
            if let Ok(el) = unsafe { array.GetElement(i) } {
                if let Ok(text) = extract_selection(&el) {
                    return Ok(text);
                }
            }
        }
    }

    // 兜底：顶层元素自身（个别老控件的 TextPattern 就挂在顶层）
    extract_selection(&element)
}

/// 在 root 子树中查找所有支持 TextPattern 的元素。
fn find_text_elements(
    automation: &IUIAutomation,
    root: &IUIAutomationElement,
) -> Result<IUIAutomationElementArray, String> {
    let condition = unsafe {
        automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
    }
    .map_err(|e| format!("构造查询条件失败: {e}"))?;
    let condition: IUIAutomationCondition = condition.into();
    unsafe { root.FindAll(TreeScope_Descendants, &condition) }
        .map_err(|e| format!("子树文本控件查询失败: {e}"))
}

/// 从给定 UIA 元素提取 TextPattern 下的当前选区文本。
fn extract_selection(element: &IUIAutomationElement) -> Result<String, String> {
    // TextPattern：查当前支持的 Pattern。
    // 浏览器/WPF/WinForms/UWP 大多支持；记事本、Cmd、PowerShell 等 Win32 老控件不支持。
    let pattern: IUIAutomationTextPattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
            .map_err(|e| format!("当前控件不支持 TextPattern: {e}"))?;

    // 选区：可能是 0、1 或多个 range（多选区）
    let ranges: IUIAutomationTextRangeArray =
        unsafe { pattern.GetSelection() }.map_err(|e| format!("读取选区失败: {e}"))?;
    let len = unsafe { ranges.Length() }.unwrap_or(0);

    if len == 0 {
        return Err("目标控件无选区（用户可能没有选中文字）".into());
    }

    // 拼接所有 range 的文本
    // GetText(maxLength): -1 表示整个选区，0 表示读取零个字符。
    let mut combined = String::new();
    for i in 0..len {
        let range =
            unsafe { ranges.GetElement(i) }.map_err(|e| format!("GetElement({i}) 失败: {e}"))?;
        let bstr: BSTR = unsafe { range.GetText(-1) }.map_err(|e| format!("GetText 失败: {e}"))?;
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
        eprintln!("[read_selection_uia] target window: title={title:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
    use windows_sys::Win32::UI::Controls::EM_SETSEL;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, SendMessageW,
        TranslateMessage, ES_MULTILINE, ES_NOHIDESEL, MSG, PM_REMOVE, WS_CHILD, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
    };

    // RichEdit 实现 TextPattern；测试窗口放在屏幕外、不激活、不触碰系统剪贴板。

    struct EditFixture {
        hwnd: isize,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl EditFixture {
        fn new(text: &str) -> Self {
            let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let (tx, rx) = mpsc::channel();
            let thread = std::thread::spawn(move || unsafe {
                let library: Vec<u16> = "Msftedit.dll\0".encode_utf16().collect();
                assert!(!LoadLibraryW(library.as_ptr()).is_null());
                let parent_class: Vec<u16> = "STATIC\0".encode_utf16().collect();
                let parent = CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    parent_class.as_ptr(),
                    std::ptr::null(),
                    WS_POPUP | WS_VISIBLE,
                    -30000,
                    -30000,
                    400,
                    200,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                assert!(!parent.is_null(), "failed to create fixture parent");
                let class: Vec<u16> = "RICHEDIT50W\0".encode_utf16().collect();
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    text.as_ptr(),
                    WS_CHILD | WS_VISIBLE | (ES_MULTILINE | ES_NOHIDESEL) as u32,
                    0,
                    0,
                    400,
                    200,
                    parent,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                assert!(!hwnd.is_null(), "failed to create EDIT fixture");
                SendMessageW(hwnd, EM_SETSEL, 0, -1);
                tx.send(hwnd as isize).unwrap();
                let mut msg: MSG = std::mem::zeroed();
                while !worker_stop.load(Ordering::Acquire) {
                    while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                DestroyWindow(parent);
            });
            let hwnd = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("EDIT fixture ready");
            Self {
                hwnd,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for EditFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    #[test]
    fn native_edit_selection_returns_complete_unicode_text_and_rejects_caret() {
        let expected =
            "Windows selection regression: 中文、emoji 🦀 and selected text beyond one short word.";
        let fixture = EditFixture::new(expected);
        assert_eq!(read_selection_uia(fixture.hwnd).unwrap(), expected);
        // 第二次读取同一内容，验证 COM 生命周期和重复划词。
        assert_eq!(read_selection_uia(fixture.hwnd).unwrap(), expected);
        unsafe { SendMessageW(fixture.hwnd as *mut _, EM_SETSEL, 0, 0) };
        assert!(
            read_selection_uia(fixture.hwnd).is_err(),
            "caret is not a selection"
        );
    }
}
