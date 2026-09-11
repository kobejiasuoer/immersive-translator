//! 划词读取诊断探针（不进入产品构建）。
//!
//! 用法：
//!   selection_probe uia [秒数]      —— 循环打印前台窗口 + UIA 选区读取结果
//!   selection_probe ctrlc [次数]    —— 单次完整走一遍 Ctrl+C 模拟读取（会临时动剪贴板并恢复）
//!
//! 仅用于本机诊断：在目标应用里选中文字后观察两条路径各自的失败原因。

use std::env;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_CONTROL,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    SetForegroundWindow,
};

use windows::core::BSTR;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, UIA_TextPatternId,
};

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn window_info() -> (isize, String, String, u32) {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return (0, "(none)".into(), String::new(), 0);
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let title = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        let mut cls = [0u16; 256];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
        let cls = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        (hwnd as isize, title, cls, pid)
    }
}

/// 对单个元素做详尽诊断：控件类型/类名/框架名/是否支持 TextPattern/选区文本。
fn inspect_element(tag: &str, element: &IUIAutomationElement) {
    unsafe {
        let ct = element.CurrentControlType().map(|v| v.0).unwrap_or(-1);
        let name: BSTR = element.CurrentName().unwrap_or_default();
        let cls: BSTR = element.CurrentClassName().unwrap_or_default();
        let fw: BSTR = element.CurrentFrameworkId().unwrap_or_default();
        let name_s = String::from_utf16_lossy(&*name);
        let name_short = if name_s.chars().count() > 40 {
            format!("{}…", name_s.chars().take(40).collect::<String>())
        } else {
            name_s
        };
        println!(
            "[{tag}] controltype={} class={:?} framework={:?} name={:?}",
            ct,
            String::from_utf16_lossy(&*cls),
            String::from_utf16_lossy(&*fw),
            name_short,
        );

        let pattern: Result<IUIAutomationTextPattern, _> =
            element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId);
        match pattern {
            Err(e) => println!("[{tag}] TextPattern: 不支持 ({e})"),
            Ok(p) => {
                println!("[{tag}] TextPattern: 支持");
                match p.GetSelection() {
                    Err(e) => println!("[{tag}] GetSelection 失败: {e}"),
                    Ok(ranges) => {
                        let len = ranges.Length().unwrap_or(0);
                        println!("[{tag}] GetSelection: {len} 个 range");
                        for i in 0..len.min(5) {
                            match ranges.GetElement(i) {
                                Err(e) => println!("[{tag}]   range[{i}] 获取失败: {e}"),
                                Ok(r) => match r.GetText(0) {
                                    Err(e) => println!("[{tag}]   range[{i}] GetText 失败: {e}"),
                                    Ok(t) => {
                                        let s = String::from_utf16_lossy(&*t);
                                        let short = if s.chars().count() > 80 {
                                            format!("{}…", s.chars().take(80).collect::<String>())
                                        } else {
                                            s.clone()
                                        };
                                        println!(
                                            "[{tag}]   range[{i}] len={} {short:?}",
                                            s.chars().count()
                                        );
                                    }
                                },
                            }
                        }
                    }
                }
            }
        }
    }
}

fn probe_uia_once(automation: &IUIAutomation, hwnd_ptr: isize) {
    let (hwnd, title, cls, pid) = window_info();
    println!(
        "[fg {}] hwnd={hwnd} pid={pid} class={cls:?} title={title:?}",
        now_ms() % 100000
    );
    let _ = hwnd_ptr;

    match unsafe { automation.GetFocusedElement() } {
        Err(e) => println!("[fg] GetFocusedElement 失败: {e}"),
        Ok(focused) => inspect_element("focused", &focused),
    }

    if hwnd != 0 {
        match unsafe {
            automation.ElementFromHandle(windows::Win32::Foundation::HWND(hwnd as *mut _))
        } {
            Err(e) => println!("[fg] ElementFromHandle 失败: {e}"),
            Ok(el) => inspect_element("toplevel", &el),
        }
    }
}

fn run_uia(seconds: u64) {
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).expect("UIAutomation")
    };
    println!("=== UIA 探针：每 1 秒采样一次，共 {seconds}s。请切到目标应用并选中文本 ===");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        probe_uia_once(&automation, 0);
        thread::sleep(Duration::from_millis(1000));
    }
}

// ---------- Ctrl+C 模拟路径（对齐 clipboard.rs 的 read_selection_impl） ----------

const VK_C: u16 = 0x43;

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
    SendInput(1, [input].as_ptr(), std::mem::size_of::<INPUT>() as i32);
}

fn run_ctrlc_once() {
    use arboard::Clipboard;
    println!("=== Ctrl+C 探针：2 秒后开始，请确保目标应用在前台且有选中文本 ===");
    thread::sleep(Duration::from_millis(2000));

    let (hwnd, title, cls, pid) = window_info();
    println!("[ctrlc] 前台: hwnd={hwnd} pid={pid} class={cls:?} title={title:?}");

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            println!("[ctrlc] Clipboard::new 失败: {e}");
            return;
        }
    };
    let original = clipboard.get_text().ok();
    println!("[ctrlc] 已保存原剪贴板 has_old={}", original.is_some());

    let sentinel = format!("__PROBE_SENTINEL_{}__", now_ms());
    if let Err(e) = clipboard.set_text(sentinel.clone()) {
        println!("[ctrlc] 写哨兵失败: {e}");
        return;
    }

    unsafe {
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(VK_C, false);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_C, true);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
    println!("[ctrlc] Ctrl+C 已发送");

    let start = Instant::now();
    let mut selected = String::new();
    while start.elapsed() < Duration::from_millis(1400) {
        thread::sleep(Duration::from_millis(40));
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
    }
    println!(
        "[ctrlc] 轮询 {}ms，结果 len={}",
        start.elapsed().as_millis(),
        selected.chars().count()
    );
    if !selected.is_empty() {
        let short: String = selected.chars().take(80).collect();
        println!("[ctrlc] 内容前 80 字: {short:?}");
    }

    let mut cb = Clipboard::new().expect("clipboard");
    if let Some(orig) = original {
        let _ = cb.set_text(orig);
    } else {
        let _ = cb.set_text(String::new());
    }
    println!("[ctrlc] 原剪贴板已恢复");
}

/// 一步到位复现应用的完整读取链路：
/// 激活目标窗口 → Escape 关查找栏 → Ctrl+A 全选 → UIA 读取 → Ctrl+C 回退读取。
/// 中途每步都打印前台窗口，用来暴露「读的过程中前台被抢走」的情况。
fn run_auto(hwnd_target: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

    unsafe {
        let ok = SetForegroundWindow(hwnd_target as *mut _);
        println!("[auto] SetForegroundWindow({hwnd_target}) → {ok}");
    }
    thread::sleep(Duration::from_millis(300));

    // Escape：如果 Chrome 查找栏开着，关掉并把焦点还给页面
    unsafe {
        send_key(0x1B, false); // Esc down
        thread::sleep(Duration::from_millis(30));
        send_key(0x1B, true); // Esc up
    }
    thread::sleep(Duration::from_millis(150));

    // Ctrl+A 全选页面文本（模拟"有选中文本"状态）
    unsafe {
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(0x41, false); // A down
        thread::sleep(Duration::from_millis(40));
        send_key(0x41, true); // A up
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
    println!("[auto] Ctrl+A 已发送");

    let (hwnd, title, cls, pid) = window_info();
    println!("[auto] Ctrl+A 后前台: hwnd={hwnd} pid={pid} class={cls:?} title={title:?}");

    // ---- 路径 1：UIA（对齐 uia.rs：focused → toplevel，重试 3 次 × 150ms）----
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[auto] UIA 初始化失败: {e}");
                return;
            }
        };
    let mut uia_result: Option<String> = None;
    for attempt in 0..3 {
        let (hwnd_now, _, _, pid_now) = window_info();
        println!(
            "[auto] UIA 第{}次尝试，当前前台 hwnd={hwnd_now} pid={pid_now}",
            attempt + 1
        );
        match unsafe { automation.GetFocusedElement() } {
            Err(e) => println!("[auto] GetFocusedElement 失败: {e}"),
            Ok(focused) => {
                inspect_element("auto-focused", &focused);
                if let Ok(text) = extract_selection_text(&focused) {
                    uia_result = Some(text);
                    break;
                }
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    match uia_result {
        Some(t) => println!(
            "[auto] ★ UIA 路径成功: len={} 前60字={:?}",
            t.chars().count(),
            t.chars().take(60).collect::<String>()
        ),
        None => println!("[auto] ✗ UIA 路径失败（3 次尝试）"),
    }
    let _ = hwnd; // suppress unused warning if UIA succeeded
    let _ = title;

    // ---- 路径 2：Ctrl+C 模拟（对齐 clipboard.rs）----
    println!("[auto] ---- Ctrl+C 回退路径 ----");
    run_ctrlc_once();
}

/// 从 UIA 元素提取选区文本（与 uia.rs 的 extract_selection 相同逻辑）。
fn extract_selection_text(element: &IUIAutomationElement) -> Result<String, String> {
    let pattern: IUIAutomationTextPattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
            .map_err(|e| format!("不支持 TextPattern: {e}"))?;
    let ranges =
        unsafe { pattern.GetSelection() }.map_err(|e| format!("GetSelection 失败: {e}"))?;
    let len = unsafe { ranges.Length() }.unwrap_or(0);
    if len == 0 {
        return Err("无选区 range".into());
    }
    let mut combined = String::new();
    for i in 0..len {
        let range =
            unsafe { ranges.GetElement(i) }.map_err(|e| format!("GetElement({i}) 失败: {e}"))?;
        let bstr: BSTR = unsafe { range.GetText(0) }.map_err(|e| format!("GetText 失败: {e}"))?;
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

/// 强制把目标窗口拉回前台（绕过 SetForegroundWindow 的限制）。
/// 配方：AttachThreadInput 到目标/前台线程 + 短按 ALT 解除前台锁。
unsafe fn force_activate(hwnd: isize) -> bool {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, VK_MENU};

    let hwnd = hwnd as *mut _;
    let fg = GetForegroundWindow();
    if fg == hwnd {
        return true;
    }
    let this_tid = GetCurrentThreadId();
    let target_tid = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
    let fg_tid = if fg.is_null() {
        0
    } else {
        GetWindowThreadProcessId(fg, std::ptr::null_mut())
    };

    let mut attached_target = false;
    if target_tid != 0 && target_tid != this_tid {
        attached_target = AttachThreadInput(this_tid, target_tid, 1) != 0;
    }
    let mut attached_fg = false;
    if fg_tid != 0 && fg_tid != this_tid && fg_tid != target_tid {
        attached_fg = AttachThreadInput(this_tid, fg_tid, 1) != 0;
    }
    keybd_event(VK_MENU as u8, 0, 0, 0);
    let ok = SetForegroundWindow(hwnd);
    keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
    if attached_target {
        AttachThreadInput(this_tid, target_tid, 0);
    }
    if attached_fg {
        AttachThreadInput(this_tid, fg_tid, 0);
    }
    ok != 0
}

/// 模拟"前台被抢"场景并验证两个修复手段：
/// 1. SPI_SETSCREENREADER 让 Chromium 开完整无障碍 → UIA GetSelection 是否能拿到文本；
/// 2. 前台被抢后 force_activate 拉回 → Ctrl+C 是否能正常复制。
fn run_fix(chrome_hwnd: isize, thief_hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPI_SETSCREENREADER,
    };

    unsafe {
        SetForegroundWindow(chrome_hwnd as *mut _);
    }
    thread::sleep(Duration::from_millis(300));
    unsafe {
        send_key(0x1B, false);
        thread::sleep(Duration::from_millis(30));
        send_key(0x1B, true);
    }
    thread::sleep(Duration::from_millis(150));
    unsafe {
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(0x41, false);
        thread::sleep(Duration::from_millis(40));
        send_key(0x41, true);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
    println!("[fix] Ctrl+A 已发送");

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).expect("UIAutomation")
    };

    // ---- 基线：不开 screen reader 标志 ----
    println!("[fix] ---- UIA 基线（不开 SPI_SETSCREENREADER）----");
    uia_read_print(&automation);

    // ---- 打开 screen reader 标志再试 ----
    println!("[fix] ---- SPI_SETSCREENREADER=TRUE 后 ----");
    let mut old_flag = 0u32;
    unsafe {
        SystemParametersInfoW(
            SPI_SETSCREENREADER,
            1,
            std::ptr::null_mut(),
            SPIF_SENDCHANGE,
        );
        let _ = old_flag; // SPI_GETSCREENREADER 读取可选，简化处理
    }
    thread::sleep(Duration::from_millis(400));
    uia_read_print(&automation);
    unsafe {
        SystemParametersInfoW(
            SPI_SETSCREENREADER,
            0,
            std::ptr::null_mut(),
            SPIF_SENDCHANGE,
        );
    }
    println!("[fix] SPI_SETSCREENREADER 已恢复为 FALSE");

    // ---- 模拟前台被抢 ----
    if thief_hwnd != 0 {
        println!("[fix] ---- 模拟前台被抢 ----");
        unsafe {
            let ok = SetForegroundWindow(thief_hwnd as *mut _);
            println!("[fix] 抢占 SetForegroundWindow(thief) → {ok}");
        }
        thread::sleep(Duration::from_millis(500));
        let (hwnd, title, _, _) = window_info();
        println!("[fix] 被抢后前台: hwnd={hwnd} title={title:?}");

        println!("[fix] ---- force_activate 拉回 Chrome ----");
        let ok = unsafe { force_activate(chrome_hwnd) };
        thread::sleep(Duration::from_millis(200));
        let (hwnd, title, _, _) = window_info();
        println!("[fix] 拉回(force_activate={ok})后前台: hwnd={hwnd} title={title:?}");
    }

    // ---- Ctrl+C 流程验证 ----
    println!("[fix] ---- Ctrl+C 流程 ----");
    run_ctrlc_once();
}

fn uia_read_print(automation: &IUIAutomation) {
    match unsafe { automation.GetFocusedElement() } {
        Err(e) => println!("[fix-uia] GetFocusedElement 失败: {e}"),
        Ok(el) => match extract_selection_text(&el) {
            Ok(t) => println!(
                "[fix-uia] ★ 成功: len={} 前60字={:?}",
                t.chars().count(),
                t.chars().take(60).collect::<String>()
            ),
            Err(reason) => println!("[fix-uia] ✗ 失败: {reason}"),
        },
    }
}

/// 安全的端到端选区测试：
/// 1. force_activate 目标窗口（失败则中止，绝不向别的窗口发键）
/// 2. Ctrl+A 在目标页面建立选区
/// 3. 完整跑 UIA 读取（focused → toplevel）
/// 4. WM_GETOBJECT kick 实验：AccessibleObjectFromWindow 前后对比
/// 5. Ctrl+C 模拟读取（对齐 clipboard.rs）
fn run_seltest(hwnd_target: isize) {
    println!("=== seltest: hwnd={hwnd_target} ===");
    unsafe {
        let ok = force_activate(hwnd_target);
        thread::sleep(Duration::from_millis(300));
        let fg = GetForegroundWindow() as isize;
        println!(
            "[seltest] force_activate={ok} fg_now={fg} match={}",
            fg == hwnd_target
        );
        if fg != hwnd_target {
            println!("[seltest] ✗ 前台不是目标窗口，中止（避免向其他窗口发键）");
            return;
        }
        // Ctrl+A 建立选区
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(0x41, false);
        thread::sleep(Duration::from_millis(40));
        send_key(0x41, true);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
    thread::sleep(Duration::from_millis(200));
    let (hwnd, title, _, _) = window_info();
    println!("[seltest] Ctrl+A 后前台: hwnd={hwnd} title={title:?}");

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[seltest] UIA 初始化失败: {e}");
                return;
            }
        };

    println!("[seltest] ---- UIA 读取（有选区状态）----");
    let mut uia_ok = false;
    for attempt in 0..4 {
        let (fg_now, ..) = window_info();
        if fg_now != hwnd_target {
            println!(
                "[seltest] 前台已丢失 fg={fg_now}，第{}次尝试跳过",
                attempt + 1
            );
        }
        match unsafe { automation.GetFocusedElement() } {
            Err(e) => println!("[seltest] GetFocusedElement 失败: {e}"),
            Ok(el) => match extract_selection_text(&el) {
                Ok(t) => {
                    println!(
                        "[seltest] ★ UIA 成功(第{}次): len={} 前60字={:?}",
                        attempt + 1,
                        t.chars().count(),
                        t.chars().take(60).collect::<String>()
                    );
                    uia_ok = true;
                    break;
                }
                Err(r) => println!("[seltest] ✗ UIA 失败(第{}次): {}", attempt + 1, r),
            },
        }
        if attempt + 1 < 4 {
            thread::sleep(Duration::from_millis(400));
        }
    }
    let _ = uia_ok;

    println!("[seltest] ---- Ctrl+C 模拟路径 ----");
    run_ctrlc_once();
    println!("[seltest] 完成");
}

/// 只读扫描：列出目标窗口子树中【所有】支持 TextPattern 的元素，
/// 以及每个元素当前的 GetSelection —— 用于验证"选区在文档里而不在焦点控件里"。
fn run_scan(hwnd_target: isize) {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationCondition, TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId,
    };

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[scan] UIA 初始化失败: {e}");
                return;
            }
        };

    println!("[scan] 目标 hwnd={hwnd_target}");
    match unsafe { automation.GetFocusedElement() } {
        Err(e) => println!("[scan] GetFocusedElement 失败: {e}"),
        Ok(f) => unsafe {
            let ct = f.CurrentControlType().map(|v| v.0).unwrap_or(-1);
            let name: BSTR = f.CurrentName().unwrap_or_default();
            let n = String::from_utf16_lossy(&*name);
            let short: String = n.chars().take(30).collect();
            println!("[scan] focused: controltype={ct} name={short:?}");
            match extract_selection_text(&f) {
                Ok(t) => println!(
                    "[scan] focused 选区: len={} {:?}",
                    t.chars().count(),
                    t.chars().take(40).collect::<String>()
                ),
                Err(r) => println!("[scan] focused 选区: ✗ {r}"),
            }
        },
    }

    let element = match unsafe {
        automation.ElementFromHandle(windows::Win32::Foundation::HWND(hwnd_target as *mut _))
    } {
        Ok(e) => e,
        Err(e) => {
            println!("[scan] ElementFromHandle 失败: {e}");
            return;
        }
    };

    let cond = unsafe {
        automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
    }
    .expect("cond");
    let cond: IUIAutomationCondition = cond.into();
    let arr = unsafe { element.FindAll(TreeScope_Descendants, &cond) };
    match arr {
        Err(e) => println!("[scan] FindAll 失败: {e}"),
        Ok(arr) => {
            let len = unsafe { arr.Length() }.unwrap_or(0);
            println!("[scan] 子树共 {len} 个 TextPattern 元素：");
            for i in 0..len {
                match unsafe { arr.GetElement(i) } {
                    Err(e) => println!("[scan]   [{i}] GetElement 失败: {e}"),
                    Ok(el) => unsafe {
                        let ct = el.CurrentControlType().map(|v| v.0).unwrap_or(-1);
                        let name: BSTR = el.CurrentName().unwrap_or_default();
                        let n = String::from_utf16_lossy(&*name);
                        let short: String = n.chars().take(30).collect();
                        let focused = el
                            .CurrentHasKeyboardFocus()
                            .map(|v| v.as_bool())
                            .unwrap_or(false);
                        print!(
                            "[scan]   [{i}] controltype={ct} hasFocus={focused} name={short:?} → "
                        );
                        match extract_selection_text(&el) {
                            Ok(t) => println!(
                                "★选区 len={} {:?}",
                                t.chars().count(),
                                t.chars().take(40).collect::<String>()
                            ),
                            Err(r) => println!("✗ {r}"),
                        }
                    },
                }
            }
        }
    }
}

/// 全链路自测（只用于自己开的测试窗口，例如 example.com）：
/// 1. UIA kick + 找到文档控件
/// 2. 用 TextRange.Select() 程序化选中第一段可见文本（不使用合成按键）
/// 3. 读回 GetSelection —— 验证 UIA 读取链路
/// 4. 再走 Ctrl+C 模拟 + 序列号轮询 —— 验证合成按键链路是否被系统/安全软件拦截
fn run_selftest(hwnd_target: isize) {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationCondition, TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId,
    };
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

    println!("=== selftest hwnd={hwnd_target} ===");
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[selftest] UIA 初始化失败: {e}");
                return;
            }
        };

    let element = match unsafe {
        automation.ElementFromHandle(windows::Win32::Foundation::HWND(hwnd_target as *mut _))
    } {
        Ok(e) => e,
        Err(e) => {
            println!("[selftest] ElementFromHandle 失败: {e}");
            return;
        }
    };

    let cond = unsafe {
        automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
    }
    .expect("cond");
    let cond: IUIAutomationCondition = cond.into();
    let arr = unsafe { element.FindAll(TreeScope_Descendants, &cond) }.expect("findall");
    let len = unsafe { arr.Length() }.unwrap_or(0);
    println!("[selftest] 文本控件数: {len}");
    if len == 0 {
        println!("[selftest] ✗ 无文本控件（a11y 树未建？）");
        return;
    }

    // 取第一个文本控件（Chrome 里就是文档），程序化选中第一段可见文本
    let doc = unsafe { arr.GetElement(0) }.expect("doc");
    let pattern: IUIAutomationTextPattern =
        unsafe { doc.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
            .expect("textpattern");
    let visible = unsafe { pattern.GetVisibleRanges() }.expect("visible ranges");
    let vlen = unsafe { visible.Length() }.unwrap_or(0);
    println!("[selftest] 可见文本行数: {vlen}（0 不影响：改用 DocumentRange 造选区）");
    // 用文档整域收缩出前 40 个字符的选区（不依赖窗口可见性）
    use windows::Win32::UI::Accessibility::{TextPatternRangeEndpoint_End, TextUnit_Character};
    let range = unsafe { pattern.DocumentRange() }.expect("doc range");
    // 先把 End 收回到 Start（收一个大数即可），再放出 40 字符
    let _ = unsafe {
        range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, -1000000)
    };
    let _ =
        unsafe { range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 40) };
    unsafe { range.Select() }.expect("select");
    println!("[selftest] 已通过 UIA Select() 选中文档前 40 字");
    thread::sleep(Duration::from_millis(400));

    // ---- 验证 1：UIA GetSelection 读回 ----
    match extract_selection_text(&doc) {
        Ok(t) => println!(
            "[selftest] ★ UIA 读取成功: len={} {:?}",
            t.chars().count(),
            t.chars().take(50).collect::<String>()
        ),
        Err(r) => println!("[selftest] ✗ UIA 读取失败: {r}"),
    }

    // ---- 验证 2：合成 Ctrl+C 是否真的能产生剪贴板写入 ----
    use arboard::Clipboard;
    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            println!("[selftest] Clipboard::new 失败: {e}");
            return;
        }
    };
    let original = clipboard.get_text().ok();
    let sentinel = format!("__SELFTEST_{}__", now_ms());
    match clipboard.set_text(sentinel.clone()) {
        Ok(()) => println!("[selftest] 哨兵写入成功"),
        Err(e) => println!("[selftest] 哨兵写入失败: {e}"),
    }
    drop(clipboard);

    // ---- 陷阱：哨兵写入后蹲守 1.5s，看是谁来抢剪贴板 ----
    use windows_sys::Win32::System::DataExchange::GetOpenClipboardWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut busy_points = 0u32;
    let mut holders: Vec<(isize, u32)> = Vec::new();
    while Instant::now() < deadline {
        let h = unsafe { GetOpenClipboardWindow() };
        if h as isize != 0 {
            busy_points += 1;
            if !holders.iter().any(|(x, _)| *x == h as isize) {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(h, &mut pid) };
                holders.push((h as isize, pid));
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    if busy_points == 0 {
        println!("[selftest] 哨兵写入后 1.5s：剪贴板一直空闲（未抓到占用者）");
    } else {
        println!(
            "[selftest] ★ 哨兵写入后 1.5s：剪贴板被占用 {} 个采样点，占用者 (hwnd,pid)={:?}",
            busy_points, holders
        );
    }

    // ---- 验证 2：合成 Ctrl+C 是否真的能产生剪贴板写入 ----
    // 注意：这里不再写哨兵（哨兵写入本身可能触发剪贴板管理器抢占），
    // 直接记录当前序列号，发 Ctrl+C，等序列号变化。
    let seq_before = unsafe { GetClipboardSequenceNumber() };
    println!("[selftest] seq_before={seq_before}，发送合成 Ctrl+C ...");
    unsafe {
        send_key(VK_CONTROL as u16, false);
        thread::sleep(Duration::from_millis(50));
        send_key(VK_C, false);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_C, true);
        thread::sleep(Duration::from_millis(40));
        send_key(VK_CONTROL as u16, true);
    }
    thread::sleep(Duration::from_millis(200));
    let deadline = Instant::now() + Duration::from_millis(1000);
    let mut copied = String::new();
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(40));
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq == seq_before {
            continue;
        }
        if let Ok(mut cb) = Clipboard::new() {
            if let Ok(t) = cb.get_text() {
                if !t.trim().is_empty() {
                    copied = t;
                    break;
                }
            }
        }
    }
    if copied.is_empty() {
        println!("[selftest] ✗ 合成 Ctrl+C 无剪贴板写入（按键疑似被系统/安全软件拦截，或目标应用忽略合成输入）");
    } else {
        println!(
            "[selftest] ★ 合成 Ctrl+C 成功: {:?}",
            copied.chars().take(50).collect::<String>()
        );
    }
    // 恢复剪贴板
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(original.unwrap_or_default());
    }
    println!("[selftest] 完成（剪贴板已恢复）");
}

/// 剪贴板反应测试：验证"是读剪贴板还是写剪贴板触发外部占用"。
/// 阶段A：纯 open/close 读探测 3 秒 —— 若失败聚集 → 有进程对所有剪贴板活动抢锁；
/// 阶段B：写一次文本后立即探测 3 秒 —— 若失败聚集 → 有进程对剪贴板【写入】抢锁
///        （如 Windows 剪贴板历史服务 cbdhsvc / 剪贴板管理类软件），
///        这正是哨兵写入毁掉 Ctrl+C 复制的原因。
fn run_cbrt() {
    use arboard::Clipboard;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetOpenClipboardWindow, OpenClipboard,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    fn probe(seconds: f64, tag: &str) -> (u32, Vec<(isize, u32)>) {
        let deadline = Instant::now() + Duration::from_millis((seconds * 1000.0) as u64);
        let mut fails = 0u32;
        let mut holders: Vec<(isize, u32)> = Vec::new();
        while Instant::now() < deadline {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                unsafe { CloseClipboard() };
            } else {
                fails += 1;
                let h = unsafe { GetOpenClipboardWindow() };
                if h as isize != 0 && !holders.iter().any(|(x, _)| *x == h as isize) {
                    let mut pid = 0u32;
                    unsafe { GetWindowThreadProcessId(h, &mut pid) };
                    holders.push((h as isize, pid));
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        println!("[cbrt] {tag}: 3s 内 open 失败 {fails} 次，占用者 (hwnd,pid)={holders:?}");
        (fails, holders)
    }

    println!("=== 剪贴板反应测试 ===");
    probe(3.0, "阶段A·纯读探测(无写入)");

    println!("[cbrt] 写入一段文本 ...");
    let mut cb = Clipboard::new().expect("cb");
    match cb.set_text("__CBRT_WRITE_TEST__") {
        Ok(()) => println!("[cbrt] 写入成功"),
        Err(e) => println!("[cbrt] 写入失败: {e}"),
    }
    drop(cb);
    probe(3.0, "阶段B·写入后探测");

    println!("[cbrt] 再写入一次后高频探测（1ms 采样，抓短占用）...");
    let mut cb = Clipboard::new().expect("cb");
    let _ = cb.set_text("__CBRT_WRITE_TEST_2__");
    drop(cb);
    let deadline = Instant::now() + Duration::from_millis(2000);
    let mut fails = 0u32;
    let mut holders: Vec<(isize, u32)> = Vec::new();
    while Instant::now() < deadline {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            unsafe { CloseClipboard() };
        } else {
            fails += 1;
            let h = unsafe { GetOpenClipboardWindow() };
            if h as isize != 0 && !holders.iter().any(|(x, _)| *x == h as isize) {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(h, &mut pid) };
                holders.push((h as isize, pid));
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    println!("[cbrt] 写入后 2s 高频探测: open 失败 {fails} 次，占用者={holders:?}");
}

/// 前台 UIA 验证（不用合成方向键，纯 UIA）：
/// force_activate 目标窗口 → UIA TextRange.Select() 造选区 → GetSelection 读回。
/// 用于最终验证"UIA 主路径在真实选区下能取到文本"。
fn run_fgself(hwnd_target: isize) {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationCondition, TextPatternRangeEndpoint_End, TextUnit_Character,
        TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId,
    };

    println!("=== fgself hwnd={hwnd_target} ===");
    unsafe {
        let ok = force_activate(hwnd_target);
        thread::sleep(Duration::from_millis(400));
        let fg = GetForegroundWindow() as isize;
        println!(
            "[fgself] force_activate={ok} fg_now={fg} match={}",
            fg == hwnd_target
        );
        if fg != hwnd_target {
            println!("[fgself] 前台不是目标，中止");
            return;
        }
    }

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).expect("uia") };
    let element = unsafe {
        automation.ElementFromHandle(windows::Win32::Foundation::HWND(hwnd_target as *mut _))
    }
    .expect("element");
    let cond = unsafe {
        automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
    }
    .expect("cond");
    let cond: IUIAutomationCondition = cond.into();
    let arr = unsafe { element.FindAll(TreeScope_Descendants, &cond) }.expect("findall");
    let len = unsafe { arr.Length() }.unwrap_or(0);
    println!("[fgself] 文本控件数 {len}");
    let doc = unsafe { arr.GetElement(0) }.expect("doc");
    let pattern: IUIAutomationTextPattern =
        unsafe { doc.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
            .expect("pattern");

    let range = unsafe { pattern.DocumentRange() }.expect("docrange");
    let _ = unsafe {
        range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, -1000000)
    };
    let _ =
        unsafe { range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 40) };
    unsafe { range.Select() }.expect("select");
    thread::sleep(Duration::from_millis(400));

    match extract_selection_text(&doc) {
        Ok(t) => println!(
            "[fgself] ★★ UIA 选区读取成功: len={} {:?}",
            t.chars().count(),
            t.chars().take(50).collect::<String>()
        ),
        Err(r) => println!("[fgself] ✗ UIA 选区读取失败: {r}"),
    }
}

/// bisect：对照「发 Ctrl+C 前跑不跑 UIA 子树扫描」对复制结果的影响。
/// 两组都用 UIA TextPattern.Select() 建立同样的选区（纯 API，不按键），
/// 唯一差别是发 Ctrl+C 前是否执行 uia.rs 的 kick+扫描（现版应用的 UIA 阶段）。
///   P1 纯净组：Select → sleep → Ctrl+C → 看 seq
///   P2 污染组：Select → kick+扫描×5轮(对齐应用) → Ctrl+C → 看 seq
/// 若 P1 成功 P2 失败 ⇒ UIA 阶段破坏了后续复制（v0.2.0 划词失效根因）。
fn run_bisect(hwnd_target: isize) {
    use windows::Win32::Foundation::HWND;
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

    println!("=== bisect hwnd={hwnd_target} ===");
    unsafe { force_activate(hwnd_target) };
    thread::sleep(Duration::from_millis(400));

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[bisect] UIA 初始化失败: {e}");
                return;
            }
        };
    let hwnd = HWND(hwnd_target as *mut _);

    for (name, poison) in [("P1_纯净", false), ("P2_污染", true)] {
        println!("---- {name} ----");
        if !uia_select_minimal(&automation, hwnd) {
            println!("[{name}] 建立选区失败，跳过");
            continue;
        }
        if poison {
            for round in 0..5 {
                kick_chromium(hwnd);
                uia_scan_quiet(&automation, hwnd);
                println!("    [P2] 第{}轮 kick+扫描完成", round + 1);
                thread::sleep(Duration::from_millis(250));
            }
        } else {
            thread::sleep(Duration::from_millis(1500)); // 与污染组 UIA 阶段等时的静默等待
        }

        let seq_before = unsafe { GetClipboardSequenceNumber() };
        send_ctrl_c_seq();
        thread::sleep(Duration::from_millis(200));

        let mut changed = false;
        let mut len = 0usize;
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1200) {
            thread::sleep(Duration::from_millis(50));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq != seq_before {
                changed = true;
                if let Some(t) = read_clipboard_text() {
                    len = t.trim().chars().count();
                }
                break;
            }
        }
        println!(
            "[{name}] seq {seq_before}→{} changed={changed} text_len={len} {}",
            unsafe { GetClipboardSequenceNumber() },
            if changed && len > 0 {
                "★复制成功"
            } else {
                "✗没有复制"
            }
        );
        thread::sleep(Duration::from_millis(600));
    }
    println!("[bisect] 完成");
}

/// 最小化 UIA 建区：ElementFromHandle → 第一个 TextPattern 元素 → 前 40 字选区。
/// （run_selftest 用的同款手法；此处绝不触碰子树其他元素。）
fn uia_select_minimal(automation: &IUIAutomation, hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationCondition, TextPatternRangeEndpoint_End, TreeScope_Children,
        TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
    };
    unsafe {
        let element = match automation.ElementFromHandle(hwnd) {
            Ok(e) => e,
            Err(e) => {
                println!("    [select] ElementFromHandle 失败: {e}");
                return false;
            }
        };
        // 文档元素 = 子树中第一个支持 TextPattern 的元素
        let cond = match automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
        {
            Ok(c) => c,
            Err(_) => {
                println!("    [select] CreatePropertyCondition 失败");
                return false;
            }
        };
        let cond: IUIAutomationCondition = cond.into();
        let arr = match element.FindAll(TreeScope_Descendants, &cond) {
            Ok(a) => a,
            Err(e) => {
                println!("    [select] FindAll 失败: {e}");
                return false;
            }
        };
        let n = arr.Length().unwrap_or(0);
        if n == 0 {
            println!("    [select] 找不到 TextPattern 元素");
            return false;
        }
        let doc = match arr.GetElement(0) {
            Ok(d) => d,
            Err(e) => {
                println!("    [select] GetElement 失败: {e}");
                return false;
            }
        };
        let pattern: IUIAutomationTextPattern = match doc.GetCurrentPatternAs(UIA_TextPatternId) {
            Ok(p) => p,
            Err(e) => {
                println!("    [select] GetTextPattern 失败: {e}");
                return false;
            }
        };
        let range = match pattern.DocumentRange() {
            Ok(r) => r,
            Err(e) => {
                println!("    [select] DocumentRange 失败: {e}");
                return false;
            }
        };
        let _ = range.MoveEndpointByUnit(
            TextPatternRangeEndpoint_End,
            TextUnit_Character_placeholder(),
            -1_000_000,
        );
        let _ = range.MoveEndpointByUnit(
            TextPatternRangeEndpoint_End,
            TextUnit_Character_placeholder(),
            40,
        );
        match range.Select() {
            Ok(()) => {
                println!("    [select] 已选中文档前 40 字");
                true
            }
            Err(e) => {
                println!("    [select] Select 失败: {e}");
                false
            }
        }
    }
}

// TextUnit_Character 通过全路径引用，避免函数内 use 冲突
fn TextUnit_Character_placeholder() -> windows::Win32::UI::Accessibility::TextUnit {
    windows::Win32::UI::Accessibility::TextUnit_Character
}

/// 对齐 uia.rs 的 kick（WM_GETOBJECT → 窗口 + 全部直接子窗口）
fn kick_chromium(hwnd: windows::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, SendMessageTimeoutW, OBJID_CLIENT, SMTO_ABORTIFHUNG, WM_GETOBJECT,
    };
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

/// 对齐 uia.rs 的子树扫描：FindAll(TextPatternAvailable) + 逐元素 GetSelection
fn uia_scan_quiet(automation: &IUIAutomation, hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationCondition, TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId,
        UIA_TextPatternId,
    };
    unsafe {
        let Ok(element) = automation.ElementFromHandle(hwnd) else {
            return;
        };
        let Ok(condition) = automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
        else {
            return;
        };
        let condition: IUIAutomationCondition = condition.into();
        let Ok(array) = element.FindAll(TreeScope_Descendants, &condition) else {
            return;
        };
        let len = array.Length().unwrap_or(0).min(256);
        for i in 0..len {
            if let Ok(el) = array.GetElement(i) {
                if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    if let Ok(ranges) = p.GetSelection() {
                        let _ = ranges.Length();
                    }
                }
            }
        }
    }
}

fn send_ctrl_c_seq() {
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

fn read_clipboard_text() -> Option<String> {
    for _ in 0..5 {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            if let Ok(t) = cb.get_text() {
                return Some(t);
            }
            return None;
        }
        thread::sleep(Duration::from_millis(60));
    }
    None
}

/// bisect2：判别「合成 Ctrl+C 是否被机器级拦截」。
/// T1 记事本：EM_SETSEL 建 Win32 真实选区 → 合成 Ctrl+C → 看 seq。
///    （记事本是全新进程、无 a11y 参与；失败 ⇒ 合成按键被全局拦截）
/// T2 Chrome：复刻昨天成功过的 Ctrl+A(真实选区) → 合成 Ctrl+C → 看 seq。
///    （昨天 13:5x 此序列成功复制 69936 字符；今天若失败 ⇒ 期间环境变了）
fn run_bisect2(hwnd_target: isize) {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, SendMessageW, WM_SETTEXT};
    const EM_SETSEL: u32 = 177;

    println!("=== bisect2 ===");

    // ---- T1 记事本 ----
    println!("---- T1 记事本 (EM_SETSEL 真实选区) ----");
    let mut child = std::process::Command::new("notepad.exe")
        .spawn()
        .expect("启动记事本失败");
    thread::sleep(Duration::from_millis(1200));
    unsafe {
        let np_class = wstr("Notepad");
        let np = FindWindowExW(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            np_class.as_ptr(),
            std::ptr::null(),
        );
        if np.is_null() {
            println!("[T1] 找不到记事本窗口");
        } else {
            let edit_class = wstr("Edit");
            let edit = FindWindowExW(
                np,
                std::ptr::null_mut(),
                edit_class.as_ptr(),
                std::ptr::null(),
            );
            if edit.is_null() {
                println!("[T1] 找不到 Edit 控件");
            } else {
                let text = wstr("PROBE_SELECTION_TEST_1234567890");
                SendMessageW(edit, WM_SETTEXT, 0, text.as_ptr() as isize);
                thread::sleep(Duration::from_millis(200));
                // 选中 5..25（真实 Win32 选区）
                SendMessageW(edit, EM_SETSEL, 5, 25);
                force_activate(np as isize);
                thread::sleep(Duration::from_millis(400));
                let seq0 = GetClipboardSequenceNumber();
                send_ctrl_c_seq();
                thread::sleep(Duration::from_millis(200));
                let mut ok = false;
                let start = Instant::now();
                while start.elapsed() < Duration::from_millis(1000) {
                    thread::sleep(Duration::from_millis(50));
                    if GetClipboardSequenceNumber() != seq0 {
                        ok = true;
                        break;
                    }
                }
                let content = read_clipboard_text().unwrap_or_default();
                println!(
                    "[T1] 记事本复制: changed={ok} content={:?} {}",
                    content,
                    if ok && content.contains("ELECTION_TEST") {
                        "★成功"
                    } else {
                        "✗失败"
                    }
                );
            }
        }
    }
    let _ = child.kill();

    // ---- T2 Chrome Ctrl+A ----
    if hwnd_target != 0 {
        println!("---- T2 Chrome (Ctrl+A 真实选区，昨天成功过的序列) ----");
        unsafe {
            force_activate(hwnd_target);
            thread::sleep(Duration::from_millis(400));
            // Ctrl+A
            send_key(VK_CONTROL as u16, false);
            thread::sleep(Duration::from_millis(50));
            send_key(0x41, false);
            thread::sleep(Duration::from_millis(40));
            send_key(0x41, true);
            thread::sleep(Duration::from_millis(40));
            send_key(VK_CONTROL as u16, true);
            thread::sleep(Duration::from_millis(300));
            let seq0 = GetClipboardSequenceNumber();
            send_ctrl_c_seq();
            thread::sleep(Duration::from_millis(200));
            let mut ok = false;
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(1200) {
                thread::sleep(Duration::from_millis(50));
                if GetClipboardSequenceNumber() != seq0 {
                    ok = true;
                    break;
                }
            }
            let len = read_clipboard_text()
                .map(|t| t.trim().chars().count())
                .unwrap_or(0);
            println!(
                "[T2] Chrome复制: changed={ok} text_len={len} {}",
                if ok && len > 0 {
                    "★成功"
                } else {
                    "✗失败"
                }
            );
        }
    }
    println!("[bisect2] 完成");
}

fn wstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// bisect3：严格验证「合成 Ctrl+C」各变体 + Chrome 子窗口 UIA。
/// 每次发送前打印并校验前台窗口（修补 bisect2 没验证前台的漏洞）。
/// T1 记事本：EM_SETSEL 真实选区，依次测三种注入方式：
///    a) wVk 方式（现版应用同款）
///    b) KEYEVENTF_SCANCODE + 扫描码（有道等软件常用，过滤规则常放行带扫描码的事件）
///    c) keybd_event 老 API
/// T2 Chrome：对可用的注入方式复测；另测挂在 Chrome_RenderWidgetHostHWND
///    子窗口上的 UIA GetSelection（Chromium 的 a11y 树实际在渲染子窗口）。
fn run_bisect3(hwnd_target: isize) {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, SendMessageW, WM_SETTEXT};
    const EM_SETSEL: u32 = 177;

    println!("=== bisect3 ===");
    // ---- T1 记事本 × 3 种注入方式 ----
    println!("---- T1 记事本: 三种注入方式 ----");
    let mut child = std::process::Command::new("notepad.exe")
        .spawn()
        .expect("notepad");
    thread::sleep(Duration::from_millis(1200));
    unsafe {
        let np_class = wstr("Notepad");
        let np = FindWindowExW(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            np_class.as_ptr(),
            std::ptr::null(),
        );
        if np.is_null() {
            println!("[T1] 找不到记事本窗口");
        } else {
            let edit_class = wstr("Edit");
            let edit = FindWindowExW(
                np,
                std::ptr::null_mut(),
                edit_class.as_ptr(),
                std::ptr::null(),
            );
            if edit.is_null() {
                println!("[T1] 找不到 Edit 控件");
            } else {
                let text = wstr("PROBE_SELECTION_TEST_1234567890");
                SendMessageW(edit, WM_SETTEXT, 0, text.as_ptr() as isize);
                for (name, variant) in [("a_wVk", 0u8), ("b_scancode", 1), ("c_keybd_event", 2)] {
                    SendMessageW(edit, EM_SETSEL, 5, 25); // 重建选区
                    force_activate(np as isize);
                    thread::sleep(Duration::from_millis(300));
                    let fg = GetForegroundWindow() as isize;
                    if fg != np as isize {
                        println!("[T1.{name}] ✗ 前台激活失败 fg={fg}（结果无效，跳过）");
                        continue;
                    }
                    let seq0 = GetClipboardSequenceNumber();
                    match variant {
                        1 => send_ctrl_c_scancode(),
                        2 => send_ctrl_c_keybd_event(),
                        _ => send_ctrl_c_seq(),
                    }
                    thread::sleep(Duration::from_millis(250));
                    let mut ok = false;
                    let start = Instant::now();
                    while start.elapsed() < Duration::from_millis(800) {
                        thread::sleep(Duration::from_millis(50));
                        if GetClipboardSequenceNumber() != seq0 {
                            ok = true;
                            break;
                        }
                    }
                    let content = read_clipboard_text().unwrap_or_default();
                    println!(
                        "[T1.{name}] fg=ok 复制={ok} content={:?} {}",
                        content,
                        if ok && content.contains("ELECTION_TEST") {
                            "★成功"
                        } else {
                            "✗失败"
                        }
                    );
                }
            }
        }
    }
    let _ = child.kill();

    // ---- T2 Chrome ----
    if hwnd_target != 0 {
        println!("---- T2 Chrome ----");
        unsafe {
            force_activate(hwnd_target);
            thread::sleep(Duration::from_millis(400));
            let fg = GetForegroundWindow() as isize;
            println!("[T2] 前台校验 fg={fg} match={}", fg == hwnd_target);
            if fg == hwnd_target {
                // Ctrl+A 建立真实选区
                send_key(VK_CONTROL as u16, false);
                thread::sleep(Duration::from_millis(50));
                send_key(0x41, false);
                thread::sleep(Duration::from_millis(40));
                send_key(0x41, true);
                thread::sleep(Duration::from_millis(40));
                send_key(VK_CONTROL as u16, true);
                thread::sleep(Duration::from_millis(300));

                // 2a: 扫描码方式 Ctrl+C
                let seq0 = GetClipboardSequenceNumber();
                send_ctrl_c_scancode();
                thread::sleep(Duration::from_millis(250));
                let mut ok = false;
                let start = Instant::now();
                while start.elapsed() < Duration::from_millis(1000) {
                    thread::sleep(Duration::from_millis(50));
                    if GetClipboardSequenceNumber() != seq0 {
                        ok = true;
                        break;
                    }
                }
                let len = read_clipboard_text()
                    .map(|t| t.trim().chars().count())
                    .unwrap_or(0);
                println!(
                    "[T2a] 扫描码Ctrl+C: copied={ok} len={len} {}",
                    if ok && len > 0 {
                        "★成功"
                    } else {
                        "✗失败"
                    }
                );

                // 2b: 子窗口 UIA（Chrome_RenderWidgetHostHWND）
                uia_child_read(hwnd_target);
            }
        }
    }
    println!("[bisect3] 完成");
}

/// 挂 Chrome 渲染子窗口读 UIA 选区（区别于顶层窗口方式）。
fn uia_child_read(hwnd_target: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                println!("[T2b] UIA 初始化失败: {e}");
                return;
            }
        };
    unsafe {
        let class = wstr("Chrome_RenderWidgetHostHWND");
        // 遍历顶层窗口的直接子窗口找渲染控件（可能在下一层）
        let mut found: *mut core::ffi::c_void = std::ptr::null_mut();
        // 先试直接子窗口
        let direct = FindWindowExW(
            hwnd_target as *mut _,
            std::ptr::null_mut(),
            class.as_ptr(),
            std::ptr::null(),
        );
        if !direct.is_null() {
            found = direct;
        } else {
            let mut cur: *mut core::ffi::c_void = std::ptr::null_mut();
            loop {
                cur = FindWindowExW(
                    hwnd_target as *mut _,
                    cur,
                    std::ptr::null(),
                    std::ptr::null(),
                );
                if cur.is_null() {
                    break;
                }
                let c1 = FindWindowExW(cur, std::ptr::null_mut(), class.as_ptr(), std::ptr::null());
                if !c1.is_null() {
                    found = c1;
                    break;
                }
            }
        }
        if found.is_null() {
            println!("[T2b] 找不到 Chrome_RenderWidgetHostHWND");
            return;
        }
        println!("[T2b] 找到渲染子窗口 hwnd={:p}", found);
        let el = match automation.ElementFromHandle(windows::Win32::Foundation::HWND(found.cast()))
        {
            Ok(e) => e,
            Err(e) => {
                println!("[T2b] ElementFromHandle 失败: {e}");
                return;
            }
        };
        match extract_selection_text(&el) {
            Ok(t) => println!(
                "[T2b] ★ 子窗口UIA读到选区: len={} {:?}",
                t.chars().count(),
                t.chars().take(60).collect::<String>()
            ),
            Err(r) => println!("[T2b] ✗ 子窗口UIA: {r}"),
        }
    }
}

/// KEYEVENTF_SCANCODE 版 Ctrl+C：很多输入过滤只拦"无扫描码"的注入事件，
/// 带扫描码的事件与真实键盘几乎无法区分（有道等划词软件常用）。
fn send_ctrl_c_scancode() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_VSC};
    unsafe {
        let ctrl_scan = MapVirtualKeyW(VK_CONTROL as u32, MAPVK_VK_TO_VSC) as u16;
        let c_scan = MapVirtualKeyW(VK_C as u32, MAPVK_VK_TO_VSC) as u16;
        send_key_scancode(ctrl_scan, false);
        thread::sleep(Duration::from_millis(50));
        send_key_scancode(c_scan, false);
        thread::sleep(Duration::from_millis(40));
        send_key_scancode(c_scan, true);
        thread::sleep(Duration::from_millis(40));
        send_key_scancode(ctrl_scan, true);
    }
}

unsafe fn send_key_scancode(scan: u16, up: bool) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE};
    let mut flags = KEYEVENTF_SCANCODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    SendInput(1, [input].as_ptr(), std::mem::size_of::<INPUT>() as i32);
}

/// keybd_event 老 API 版 Ctrl+C。
fn send_ctrl_c_keybd_event() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::keybd_event;
    unsafe {
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        thread::sleep(Duration::from_millis(50));
        keybd_event(VK_C as u8, 0, 0, 0);
        thread::sleep(Duration::from_millis(40));
        keybd_event(VK_C as u8, 0, KEYEVENTF_KEYUP, 0);
        thread::sleep(Duration::from_millis(40));
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).cloned().unwrap_or_else(|| "uia".into());
    match mode.as_str() {
        "fgself" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe fgself <目标窗口hwnd>");
            run_fgself(hwnd);
        }
        "cbrt" => run_cbrt(),
        "bisect" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe bisect <目标窗口hwnd>");
            run_bisect(hwnd);
        }
        "bisect2" => {
            let hwnd: isize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            run_bisect2(hwnd);
        }
        "bisect3" => {
            let hwnd: isize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            run_bisect3(hwnd);
        }
        "selftest" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe selftest <目标窗口hwnd>");
            run_selftest(hwnd);
        }
        "scan" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe scan <目标窗口hwnd>");
            run_scan(hwnd);
        }
        "seltest" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe seltest <目标窗口hwnd>");
            run_seltest(hwnd);
        }
        "uia" => {
            let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);
            run_uia(secs);
        }
        "ctrlc" => {
            let times: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
            for i in 0..times {
                if i > 0 {
                    thread::sleep(Duration::from_secs(4));
                }
                run_ctrlc_once();
            }
        }
        "auto" => {
            let hwnd: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe auto <目标窗口hwnd>");
            run_auto(hwnd);
        }
        "fix" => {
            let chrome: isize = args
                .get(2)
                .and_then(|s| s.parse().ok())
                .expect("用法: selection_probe fix <chrome hwnd> <thief hwnd>");
            let thief: isize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            run_fix(chrome, thief);
        }
        other => {
            eprintln!("未知模式: {other}（可用: uia / ctrlc）");
        }
    }
}
