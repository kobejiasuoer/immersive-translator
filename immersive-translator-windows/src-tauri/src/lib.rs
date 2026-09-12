mod clipboard;
mod history;
mod ocr;
mod reader_store;
mod screenshot;
mod secret_store;
mod translation;
mod tts;
mod uia;

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// 默认全局热键：Ctrl+Shift+Q —— 选中文字翻译；Ctrl+Shift+E —— 截图 OCR 翻译；
/// Ctrl+Shift+R —— 送进沉浸阅读室（§8.3）。
const DEFAULT_TRANSLATE_HOTKEY: &str = "Ctrl+Shift+Q";
const DEFAULT_OCR_HOTKEY: &str = "Ctrl+Shift+E";
const DEFAULT_READER_HOTKEY: &str = "Ctrl+Shift+R";

/// 当前生效的（翻译热键, OCR 热键, 阅读室热键），用于热键切换时对比与回滚。
struct ActiveHotkeys(Mutex<[Shortcut; 3]>);

impl Default for ActiveHotkeys {
    fn default() -> Self {
        Self(Mutex::new([
            Shortcut::from_str(DEFAULT_TRANSLATE_HOTKEY).expect("default translate hotkey valid"),
            Shortcut::from_str(DEFAULT_OCR_HOTKEY).expect("default ocr hotkey valid"),
            Shortcut::from_str(DEFAULT_READER_HOTKEY).expect("default reader hotkey valid"),
        ]))
    }
}

#[derive(Clone, serde::Serialize)]
struct PanelPayload {
    text: String,
    source: String,
}

#[derive(Default)]
struct PendingPanelPayload(Mutex<Option<PanelPayload>>);

/// 阅读室热键送进来的待导入文本（阅读室窗口挂载时取走，或经
/// reader:import 事件送达；nonce 去重两条路径）。
#[derive(Clone, serde::Serialize)]
struct ReaderImportPayload {
    text: String,
    nonce: String,
}

#[derive(Default)]
struct PendingReaderImport(Mutex<Option<ReaderImportPayload>>);

/// 托盘「生词本」要求阅读室打开复习页：窗口已存在时走事件即时切换；
/// 窗口不存在时先记下标记，等窗口挂载后取走（同 PendingReaderImport 模式）。
#[derive(Default)]
struct PendingOpenReview(Mutex<Option<()>>);

// 自动读取和手动复制等待共用一次会话，避免热键连按启动多个剪贴板监听。
static SELECTION_RUNNING: AtomicBool = AtomicBool::new(false);

struct SelectionGuard;

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        SELECTION_RUNNING.store(false, Ordering::Release);
    }
}

fn show_panel_with_payload(app: &AppHandle, payload: PanelPayload) {
    // awaitCopy 是等待态：面板不能抢焦点，否则用户的 Ctrl+C 会发进面板
    // 而不是目标应用（其余场景照常聚焦）。
    let take_focus = payload.source != "awaitCopy";
    let pending = app.state::<PendingPanelPayload>();
    *pending.0.lock().unwrap() = Some(payload.clone());

    let panel = match app.get_webview_window("panel") {
        Some(p) => p,
        None => {
            // 启动瞬间 WebView2 数据目录被上一实例占用时个别窗口创建会失败
            // （settings/history 出过同样问题）。panel 缺失时热键表现为
            // "毫无反应"，这里按 tauri.conf.json 的原配置现场重建。
            // 重建后前端挂载时会通过 take_pending_panel_payload 拿到本次负载。
            eprintln!("[panel] panel window missing → rebuilding");
            clipboard::diag_log("panel window missing → rebuilding");
            let built = tauri::WebviewWindowBuilder::new(
                app,
                "panel",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("")
            .inner_size(460.0, 360.0)
            .min_inner_size(320.0, 220.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .center()
            .build();
            match built {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[panel] rebuild failed: {e}");
                    clipboard::diag_log(&format!("panel rebuild failed: {e}"));
                    return;
                }
            }
        }
    };

    // Windows 的 show 本身可能激活窗口，只跳过 set_focus 不足以保留来源焦点。
    let _ = panel.set_focusable(take_focus);
    let _ = panel.show();
    if take_focus {
        let _ = panel.set_focus();
    }
    let _ = panel.emit("panel:shown", payload);
}

#[tauri::command]
fn take_pending_panel_payload(
    state: tauri::State<'_, PendingPanelPayload>,
) -> Option<PanelPayload> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn clear_pending_panel_payload(state: tauri::State<'_, PendingPanelPayload>) {
    *state.0.lock().unwrap() = None;
}

/// 打开设置窗口（前端可调用）。对齐托盘「设置」菜单的行为。
#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 打开历史记录窗口（前端可调用）。
#[tauri::command]
async fn open_history(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("history") {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, "history", tauri::WebviewUrl::App("index.html".into()))
        .title("翻译历史")
        .inner_size(720.0, 560.0)
        .resizable(true)
        .minimizable(true)
        .maximizable(false)
        .center()
        .build()
        .map_err(|e| format!("打开历史窗口失败: {e}"))?;
    Ok(())
}

/// 打开沉浸阅读室窗口（前端可调用）。对齐托盘「沉浸阅读室」菜单的行为。
#[tauri::command]
fn open_reader(app: tauri::AppHandle) {
    show_window(&app, "reader");
}

/// 进入截图 OCR 模式：显示全屏框选覆盖层。对齐 Mac 的 begin()。
/// 进入截图 OCR 模式：
/// 1. 确保 overlay 窗口隐藏
/// 2. 截取全屏（此时 overlay 不可见，不会出现在截图里）
/// 3. 把截图 base64 发给 overlay 窗口
/// 4. 显示 overlay（用户在截图上拖框）
#[tauri::command]
fn open_ocr_overlay(app: AppHandle) {
    use tauri::Manager;
    // 先确保 overlay 隐藏（否则它会出现在截图里）
    if let Some(win) = app.get_webview_window("ocr-overlay") {
        let _ = win.hide();
    }
    // 截全屏，并缓存原始 BGRA。OCR 识别时直接裁剪这张冻结截图。
    let snapshot = match screenshot::capture_fullscreen() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[ocr_overlay] 截图失败: {e}");
            return;
        }
    };
    let png = match screenshot::encode_png_data_url(&snapshot) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[ocr_overlay] PNG 编码失败: {e}");
            return;
        }
    };
    let engine = app.state::<ocr::OcrEngine>();
    ocr::set_fullscreen_snapshot(engine, snapshot);
    // 发给 overlay 窗口
    let _ = app.emit("ocr:fullscreen", png);
    // 显示 overlay
    if let Some(win) = app.get_webview_window("ocr-overlay") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn show_ocr_result(app: AppHandle, text: String) {
    if let Some(overlay) = app.get_webview_window("ocr-overlay") {
        let _ = overlay.hide();
    }
    show_panel_with_payload(
        &app,
        PanelPayload {
            text,
            source: "ocr".into(),
        },
    );
}

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // 窗口缺失（如启动瞬间 WebView2 数据目录被上一实例占用，个别窗口创建失败）。
    // 原先这里静默返回，表现为点托盘菜单"没有反应"；现在现场重建。
    let spec = match label {
        "settings" => Some(("ImmersiveTranslator 设置", 720.0, 660.0)),
        "history" => Some(("翻译历史", 780.0, 620.0)),
        "reader" => Some(("沉浸阅读室", 1200.0, 800.0)),
        _ => None,
    };
    let Some((title, w, h)) = spec else {
        eprintln!("[show_window] window {label} missing and no rebuild spec");
        return;
    };
    eprintln!("[show_window] window {label} missing → rebuilding");
    clipboard::diag_log(&format!("window {label} missing → rebuilding"));
    let built =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
            .title(title)
            .inner_size(w, h)
            .resizable(true)
            .minimizable(true)
            .maximizable(false)
            .center()
            .build();
    if let Err(e) = built {
        eprintln!("[show_window] rebuild {label} failed: {e}");
        clipboard::diag_log(&format!("rebuild {label} failed: {e}"));
    }
}

/// 热键按下后的统一处理：隐藏已显示的 panel，否则模拟 Ctrl+C 读选区再 show。
fn trigger_panel(app: &AppHandle) {
    let panel = match app.get_webview_window("panel") {
        Some(p) => p,
        None => return,
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    if SELECTION_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app_handle = app.clone();
    // 热键按下瞬间的前台窗口就是用户想翻译的目标应用。
    // 后续读取流程有 1~2 秒延迟，期间前台可能被其他应用抢走
    // （实测微信等会周期性抢焦点），必须现在把句柄记下来，
    // Ctrl+C 兜底路径用它把目标窗口强制拉回前台再复制。
    let target_hwnd = unsafe { GetForegroundWindow() } as isize;
    clipboard::diag_log(&format!("hotkey fired, target_hwnd={target_hwnd:#x}"));
    std::thread::spawn(move || {
        let _guard = SelectionGuard;
        // 先模拟复制，失败再读取 UIA；两条都未取得选区时等待真实复制。
        match clipboard::read_selection_text(target_hwnd) {
            Ok(text) => {
                show_panel_with_payload(
                    &app_handle,
                    PanelPayload {
                        text,
                        source: "selection".into(),
                    },
                );
            }
            Err(clipboard::SelectionError::NoSelection) => {
                // 立即弹面板提示（而不是干等），后台监听 8 秒
                let seq_before_prompt = clipboard::clipboard_sequence();
                show_panel_with_payload(
                    &app_handle,
                    PanelPayload {
                        text: String::new(),
                        source: "awaitCopy".into(),
                    },
                );
                let cancelled = || {
                    !panel.is_visible().unwrap_or(false)
                        || unsafe { GetForegroundWindow() } as isize != target_hwnd
                };
                let result = clipboard::read_selection_via_user_copy(
                    seq_before_prompt,
                    std::time::Duration::from_secs(8),
                    cancelled,
                );
                match result {
                    Ok(Some(text)) => {
                        show_panel_with_payload(
                            &app_handle,
                            PanelPayload {
                                text,
                                source: "selection".into(),
                            },
                        );
                    }
                    outcome => {
                        // 不重新显示或聚焦已关闭的窗口，也不留下永久的“等待复制”。
                        let _ = panel.set_focusable(true);
                        if panel.is_visible().unwrap_or(false) {
                            let payload = PanelPayload {
                                text: if outcome.is_err() {
                                    "等待复制超时，请在原窗口重新选中文字后按翻译快捷键；也可使用截图翻译。".into()
                                } else {
                                    "来源窗口已切换，本次划词已取消。请在目标窗口重新触发翻译。"
                                        .into()
                                },
                                source: "error".into(),
                            };
                            *app_handle.state::<PendingPanelPayload>().0.lock().unwrap() =
                                Some(payload.clone());
                            let _ = panel.emit("panel:shown", payload);
                        }
                    }
                }
            }
            Err(clipboard::SelectionError::Other(e)) => {
                show_panel_with_payload(
                    &app_handle,
                    PanelPayload {
                        text: format!("划词读取失败: {e}"),
                        source: "error".into(),
                    },
                );
            }
        }
    });
}

/// 截图 OCR 热键按下后的处理：直接进入截图 OCR 模式（截全屏 → overlay 框选）。
/// 复用托盘「截图翻译(OCR)」的入口，下游识别/翻译链路不变。
fn trigger_ocr(app: &AppHandle) {
    open_ocr_overlay(app.clone());
}

/// 阅读室热键按下后的处理（§8.3）：读取当前选中文本送进阅读室并聚焦窗口；
/// 没有选区时只打开/聚焦阅读室窗口（抓取范围见 docs/reading-room-decisions.md #2）。
/// 读取期间不能抢焦点（否则模拟 Ctrl+C 会落进阅读室自己），
/// 所以与 trigger_panel 一样：先读，成功后再显示窗口。
fn trigger_reader(app: &AppHandle) {
    if SELECTION_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app_handle = app.clone();
    let target_hwnd = unsafe { GetForegroundWindow() } as isize;
    std::thread::spawn(move || {
        let _guard = SelectionGuard;
        let text = clipboard::read_selection_text(target_hwnd)
            .ok()
            .filter(|t| !t.trim().is_empty());
        match text {
            Some(text) => {
                let nonce = format!(
                    "{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                );
                let payload = ReaderImportPayload {
                    text,
                    nonce: nonce.clone(),
                };
                *app_handle.state::<PendingReaderImport>().0.lock().unwrap() =
                    Some(payload.clone());
                show_reader_window(&app_handle);
                // 窗口已存在时不会重新挂载，事件路径负责送达；nonce 去重。
                let _ = app_handle.emit_to("reader", "reader:import", payload);
            }
            None => {
                // 没有选区：仅打开/聚焦阅读室（用户可能想手动粘贴或继续上次阅读）。
                show_reader_window(&app_handle);
            }
        }
    });
}

fn show_reader_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("reader") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // 窗口缺失（启动瞬间 WebView2 数据目录被占）时现场重建，规格同 tauri.conf.json。
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "reader",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("沉浸阅读室")
    .inner_size(1200.0, 800.0)
    .min_inner_size(960.0, 620.0)
    .resizable(true)
    .minimizable(true)
    .maximizable(true)
    .center()
    .build();
    if let Err(e) = built {
        eprintln!("[reader] rebuild failed: {e}");
        clipboard::diag_log(&format!("reader rebuild failed: {e}"));
    }
}

/// 阅读室窗口挂载时取走待导入文本（与 panel 的 take_pending_panel_payload 同模式）。
#[tauri::command]
fn take_pending_reader_import(
    state: tauri::State<'_, PendingReaderImport>,
) -> Option<ReaderImportPayload> {
    state.0.lock().unwrap().take()
}

/// 阅读室窗口挂载时取走「打开复习页」请求（托盘「生词本」入口）。
#[tauri::command]
fn take_pending_open_review(state: tauri::State<'_, PendingOpenReview>) -> bool {
    state.0.lock().unwrap().take().is_some()
}

fn persist_hotkeys(
    app: &AppHandle,
    translate: Shortcut,
    ocr: Shortcut,
    reader: Shortcut,
) -> Result<(), String> {
    let appdata = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&appdata).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    std::fs::write(appdata.join("hotkey.txt"), translate.into_string())
        .map_err(|error| format!("无法保存翻译热键: {error}"))?;
    std::fs::write(appdata.join("ocr_hotkey.txt"), ocr.into_string())
        .map_err(|error| format!("无法保存截图 OCR 热键: {error}"))?;
    std::fs::write(appdata.join("reader_hotkey.txt"), reader.into_string())
        .map_err(|error| format!("无法保存阅读室热键: {error}"))?;
    Ok(())
}

/// 一次热键切换里单个键位的变化描述。
struct HotkeySlot {
    /// 错误信息里的名字（如「翻译热键」）。
    name: &'static str,
    current: Shortcut,
    replacement: Shortcut,
    register: Box<dyn FnMut(Shortcut) -> Result<(), String>>,
}

/// 把一组热键从 current 切换到 replacement（数量不限，浮窗 2 键 + 阅读室 1 键）。
///
/// 安全语义（对齐远程单热键版的可回滚设计）：
/// 1. 有变化的键**先注册新值**；任何注册失败 → 撤销本次已注册的新键，旧键原样保留；
/// 2. 全部注册成功后**写持久化**；写失败 → 同样撤销已注册新键并报错；
/// 3. 最后才**注销不再使用的旧键**；注销失败 → 尝试整体回滚到旧配置。
///
/// 全程不出现「先注销清空、后注册失败导致没有任何热键可用」的空窗。
/// 返回 Ok(true) 表示真的切换过；Ok(false) 表示目标与当前一致（仅尝试持久化）。
fn switch_hotkeys(
    slots: &mut [HotkeySlot],
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
    mut persist: impl FnMut(&[Shortcut]) -> Result<(), String>,
) -> Result<bool, String> {
    let currents: Vec<Shortcut> = slots.iter().map(|s| s.current).collect();
    if slots.iter().all(|s| s.current == s.replacement) {
        persist(&currents).map_err(|error| format!("保存热键失败: {error}"))?;
        return Ok(false);
    }

    // —— 第 1 步：注册有变化的新键（逐个），记录成功项以便回滚 ——
    let mut registered: Vec<Shortcut> = Vec::new();
    for slot in slots.iter_mut() {
        if slot.replacement != slot.current {
            (slot.register)(slot.replacement).map_err(|error| {
                for s in &registered {
                    let _ = unregister(*s);
                }
                format!("注册{}失败: {error}", slot.name)
            })?;
            registered.push(slot.replacement);
        }
    }

    // —— 第 2 步：持久化；失败则撤销刚注册的新键 ——
    let replacements: Vec<Shortcut> = slots.iter().map(|s| s.replacement).collect();
    if let Err(error) = persist(&replacements) {
        for s in &registered {
            let _ = unregister(*s);
        }
        return Err(format!("保存热键失败: {error}"));
    }

    // —— 第 3 步：注销不再使用的旧键；失败则尽力回滚到旧配置 ——
    let mut removed_old: Vec<Shortcut> = Vec::new();
    let mut unregister_failed = false;
    for slot in slots.iter() {
        if slot.replacement != slot.current {
            match unregister(slot.current) {
                Ok(()) => removed_old.push(slot.current),
                Err(_) => unregister_failed = true,
            }
        }
    }
    if unregister_failed {
        let mut messages: Vec<String> = Vec::new();
        for s in &registered {
            if let Err(error) = unregister(*s) {
                messages.push(format!("注销新键失败: {error}"));
            }
        }
        for old in &removed_old {
            if let Some(slot) = slots.iter_mut().find(|s| s.current == *old) {
                if let Err(error) = (slot.register)(*old) {
                    messages.push(format!("恢复旧键失败: {error}"));
                }
            }
        }
        let _ = persist(&currents);
        let mut msg = "注销旧热键失败，已尝试回滚".to_string();
        for m in messages {
            msg.push_str(&format!("；{m}"));
        }
        return Err(msg);
    }

    Ok(true)
}

/// 热键的回调注册（事件去重：仅 Pressed 触发）。
fn register_fn(
    app: &AppHandle,
    kind: HotkeyKind,
) -> Box<dyn FnMut(Shortcut) -> Result<(), String>> {
    let app = app.clone();
    match kind {
        HotkeyKind::Translate => Box::new(move |s: Shortcut| {
            app.global_shortcut()
                .on_shortcut(s, |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_panel(app);
                })
                .map_err(|e| e.to_string())
        }),
        HotkeyKind::Ocr => Box::new(move |s: Shortcut| {
            app.global_shortcut()
                .on_shortcut(s, |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_ocr(app);
                })
                .map_err(|e| e.to_string())
        }),
        HotkeyKind::Reader => Box::new(move |s: Shortcut| {
            app.global_shortcut()
                .on_shortcut(s, |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_reader(app);
                })
                .map_err(|e| e.to_string())
        }),
    }
}

#[derive(Clone, Copy)]
enum HotkeyKind {
    Translate,
    Ocr,
    Reader,
}

/// 运行时切换三个全局热键。全程可回滚：任一失败都保证旧键仍生效，
/// 不会出现「新键被占用导致全部失效、只能重启恢复」的情况。
#[tauri::command]
fn reregister_hotkeys(
    app: AppHandle,
    translate_hotkey: String,
    ocr_hotkey: String,
    reader_hotkey: String,
) -> Result<String, String> {
    let t = translate_hotkey.trim();
    let o = ocr_hotkey.trim();
    let r = reader_hotkey.trim();
    if t.is_empty() || o.is_empty() || r.is_empty() {
        return Err("热键为空".into());
    }
    if t.eq_ignore_ascii_case(o) || t.eq_ignore_ascii_case(r) || o.eq_ignore_ascii_case(r) {
        return Err("翻译、截图 OCR、阅读室热键两两不能相同".into());
    }

    let parse = |(value, name): (&str, &'static str)| -> Result<Shortcut, String> {
        Shortcut::from_str(value).map_err(|e| format!("无法解析{name}「{value}」: {e}"))
    };
    let t_shortcut = parse((t, "翻译热键"))?;
    let o_shortcut = parse((o, "截图 OCR 热键"))?;
    let r_shortcut = parse((r, "阅读室热键"))?;

    let active = app.state::<ActiveHotkeys>();
    let mut current = active.0.lock().map_err(|_| "热键状态不可用".to_string())?;
    let mut slots = vec![
        HotkeySlot {
            name: "翻译热键",
            current: current[0],
            replacement: t_shortcut,
            register: register_fn(&app, HotkeyKind::Translate),
        },
        HotkeySlot {
            name: "截图 OCR 热键",
            current: current[1],
            replacement: o_shortcut,
            register: register_fn(&app, HotkeyKind::Ocr),
        },
        HotkeySlot {
            name: "阅读室热键",
            current: current[2],
            replacement: r_shortcut,
            register: register_fn(&app, HotkeyKind::Reader),
        },
    ];
    let switched = switch_hotkeys(
        &mut slots,
        |s| {
            app.global_shortcut()
                .unregister(s)
                .map_err(|e| e.to_string())
        },
        |all| persist_hotkeys(&app, all[0], all[1], all[2]),
    )
    .map_err(|error| format!("应用热键失败「{t} / {o} / {r}」: {error}"))?;
    if switched {
        *current = [t_shortcut, o_shortcut, r_shortcut];
    }
    Ok("ok".into())
}

#[cfg(test)]
mod hotkey_switch_tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Debug, PartialEq, Eq, Clone)]
    enum Call {
        Register(u32),
        Unregister(u32),
        Persist(Vec<u32>),
    }

    fn shortcut(value: &str) -> Shortcut {
        Shortcut::from_str(value).unwrap()
    }

    /// 生成一组槽位（name/current/replacement + 打桩 register）。
    /// fail_register：这些字符串的「新键」注册会失败；fail_unregister：这些键注销会失败。
    fn make_slots(
        calls: &Rc<RefCell<Vec<Call>>>,
        specs: &[(&'static str, &str, &str)],
        fail_register: &[&str],
    ) -> Vec<HotkeySlot> {
        specs
            .iter()
            .map(|(name, current, replacement)| {
                let calls = calls.clone();
                let fail_register: Vec<u32> =
                    fail_register.iter().map(|s| shortcut(s).id()).collect();
                let current_id = shortcut(current).id();
                HotkeySlot {
                    name,
                    current: shortcut(current),
                    replacement: shortcut(replacement),
                    register: Box::new(move |s: Shortcut| {
                        if fail_register.contains(&s.id()) && s.id() != current_id {
                            return Err("occupied".into());
                        }
                        calls.borrow_mut().push(Call::Register(s.id()));
                        Ok(())
                    }),
                }
            })
            .collect()
    }

    fn make_unregister(
        calls: &Rc<RefCell<Vec<Call>>>,
        fail_unregister: &[&str],
    ) -> impl FnMut(Shortcut) -> Result<(), String> {
        let calls = calls.clone();
        let failing: Vec<u32> = fail_unregister.iter().map(|s| shortcut(s).id()).collect();
        move |s: Shortcut| {
            calls.borrow_mut().push(Call::Unregister(s.id()));
            if failing.contains(&s.id()) {
                Err("cannot unregister".into())
            } else {
                Ok(())
            }
        }
    }

    fn make_persist(
        calls: &Rc<RefCell<Vec<Call>>>,
    ) -> impl FnMut(&[Shortcut]) -> Result<(), String> {
        let calls = calls.clone();
        move |all: &[Shortcut]| {
            calls
                .borrow_mut()
                .push(Call::Persist(all.iter().map(|s| s.id()).collect()));
            Ok(())
        }
    }

    #[test]
    fn registers_replacements_before_unregistering_current() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Alt+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Alt+Shift+E"),
            ],
            &[],
        );
        let switched = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            make_persist(&calls),
        )
        .unwrap();
        assert!(switched);
        let list = calls.borrow().clone();
        let id_alt_t = shortcut("Alt+Shift+Q").id();
        let id_alt_o = shortcut("Alt+Shift+E").id();
        let id_cur_t = shortcut("Ctrl+Shift+Q").id();
        let id_cur_o = shortcut("Ctrl+Shift+E").id();
        let idx_rt = list
            .iter()
            .position(|c| *c == Call::Register(id_alt_t))
            .unwrap();
        let idx_un_t = list
            .iter()
            .position(|c| *c == Call::Unregister(id_cur_t))
            .unwrap();
        let idx_ro = list
            .iter()
            .position(|c| *c == Call::Register(id_alt_o))
            .unwrap();
        let idx_un_o = list
            .iter()
            .position(|c| *c == Call::Unregister(id_cur_o))
            .unwrap();
        // 注册必须发生在注销之前
        assert!(
            idx_rt < idx_un_t && idx_ro < idx_un_o,
            "register must precede unregister: {list:?}"
        );
    }

    #[test]
    fn noop_when_target_equals_current_only_persists() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Ctrl+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Ctrl+Shift+E"),
            ],
            &[],
        );
        let switched = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            make_persist(&calls),
        )
        .unwrap();
        assert!(!switched);
        assert_eq!(
            calls.borrow().clone(),
            vec![Call::Persist(vec![
                shortcut("Ctrl+Shift+Q").id(),
                shortcut("Ctrl+Shift+E").id(),
            ])]
        );
    }

    #[test]
    fn rolls_back_new_registrations_when_persist_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Alt+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Alt+Shift+E"),
            ],
            &[],
        );
        let calls2 = calls.clone();
        let result = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            move |_all: &[Shortcut]| {
                calls2.borrow_mut().push(Call::Persist(vec![]));
                Err("disk full".into())
            },
        );
        assert!(result.is_err());
        let id_alt_t = shortcut("Alt+Shift+Q").id();
        let id_alt_o = shortcut("Alt+Shift+E").id();
        assert_eq!(
            calls.borrow().clone(),
            vec![
                Call::Register(id_alt_t),
                Call::Register(id_alt_o),
                Call::Persist(vec![]), // 失败的持久化尝试也留痕
                Call::Unregister(id_alt_t),
                Call::Unregister(id_alt_o),
            ]
        );
    }

    #[test]
    fn keeps_current_when_replacement_registration_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Alt+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Ctrl+Shift+E"),
            ],
            &["Alt+Shift+Q"],
        );
        let result = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            make_persist(&calls),
        );
        assert!(result.is_err());
        // OCR 键未变化不进入注册/回滚分支；翻译键注册失败直接返回，不回滚也不持久化
        assert_eq!(calls.borrow().clone(), vec![]);
    }

    #[test]
    fn rolls_back_when_unregistering_current_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Alt+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Alt+Shift+E"),
            ],
            &[],
        );
        let result = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &["Ctrl+Shift+Q", "Ctrl+Shift+E"]),
            make_persist(&calls),
        );
        assert!(result.is_err());
        let id_q = shortcut("Ctrl+Shift+Q").id();
        let id_e = shortcut("Ctrl+Shift+E").id();
        let id_alt_q = shortcut("Alt+Shift+Q").id();
        let id_alt_e = shortcut("Alt+Shift+E").id();
        assert_eq!(
            calls.borrow().clone(),
            vec![
                // 第 1 步：先注册两个新键
                Call::Register(id_alt_q),
                Call::Register(id_alt_e),
                // 第 2 步：持久化新键
                Call::Persist(vec![id_alt_q, id_alt_e]),
                // 第 3 步：尝试注销旧键（都失败 → 触发回滚）
                Call::Unregister(id_q),
                Call::Unregister(id_e),
                // 回滚：撤销刚注册的新键（旧键注销失败说明旧键仍在生效，无需重复注册）
                Call::Unregister(id_alt_q),
                Call::Unregister(id_alt_e),
                // 回滚：持久化恢复旧配置
                Call::Persist(vec![id_q, id_e]),
            ]
        );
    }

    #[test]
    fn three_keys_switch_with_mixed_changes() {
        // 三键场景：只有阅读室键变化；其余键保持不动、不重复注册。
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Ctrl+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Ctrl+Shift+E"),
                ("阅读室热键", "Ctrl+Shift+R", "Ctrl+Alt+R"),
            ],
            &[],
        );
        let switched = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            make_persist(&calls),
        )
        .unwrap();
        assert!(switched);
        let id_old_r = shortcut("Ctrl+Shift+R").id();
        let id_new_r = shortcut("Ctrl+Alt+R").id();
        assert_eq!(
            calls.borrow().clone(),
            vec![
                Call::Register(id_new_r),
                Call::Persist(vec![
                    shortcut("Ctrl+Shift+Q").id(),
                    shortcut("Ctrl+Shift+E").id(),
                    id_new_r,
                ]),
                Call::Unregister(id_old_r),
            ]
        );
    }

    #[test]
    fn three_keys_all_changed_registers_in_order() {
        // 三键全变：三个新键都注册、三个旧键都注销，持久化包含三键新值。
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut slots = make_slots(
            &calls,
            &[
                ("翻译热键", "Ctrl+Shift+Q", "Alt+Shift+Q"),
                ("截图 OCR 热键", "Ctrl+Shift+E", "Alt+Shift+E"),
                ("阅读室热键", "Ctrl+Shift+R", "Alt+Shift+R"),
            ],
            &[],
        );
        let switched = switch_hotkeys(
            &mut slots,
            make_unregister(&calls, &[]),
            make_persist(&calls),
        )
        .unwrap();
        assert!(switched);
        let list = calls.borrow().clone();
        assert_eq!(
            list.iter()
                .filter(|c| matches!(c, Call::Register(_)))
                .count(),
            3
        );
        assert_eq!(
            list.iter()
                .filter(|c| matches!(c, Call::Unregister(_)))
                .count(),
            3
        );
        let persist = list
            .iter()
            .find_map(|c| match c {
                Call::Persist(ids) if ids.len() == 3 => Some(ids.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            persist,
            vec![
                shortcut("Alt+Shift+Q").id(),
                shortcut("Alt+Shift+E").id(),
                shortcut("Alt+Shift+R").id(),
            ]
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(translation::CancelFlag::default())
        .manage(ocr::OcrEngine::default())
        .manage(tts::TtsState::default())
        .manage(PendingPanelPayload::default())
        .manage(PendingReaderImport::default())
        .manage(PendingOpenReview::default())
        .manage(ActiveHotkeys::default())
        .invoke_handler(tauri::generate_handler![
            take_pending_panel_payload,
            clear_pending_panel_payload,
            clipboard::read_selection,
            translation::translate_stream,
            translation::cancel_translation,
            translation::test_connectivity,
            ocr::ocr_models_ready,
            ocr::ocr_recognize,
            ocr::ocr_recognize_from_fullscreen,
            ocr::ocr_download_models,
            screenshot::capture_screenshot,
            screenshot::capture_fullscreen_png,
            secret_store::secret_get,
            secret_store::secret_set,
            secret_store::secret_exists,
            tts::tts_speak,
            tts::tts_stop,
            tts::tts_voices,
            history::history_add,
            history::history_list,
            history::history_toggle_favorite,
            history::history_delete,
            history::history_clear_non_favorites,
            history::history_export,
            open_settings,
            open_history,
            open_ocr_overlay,
            open_reader,
            show_ocr_result,
            reregister_hotkeys,
            take_pending_reader_import,
            take_pending_open_review,
            reader_store::reader_list_articles,
            reader_store::reader_get_article,
            reader_store::reader_save_article,
            reader_store::reader_delete_article,
            reader_store::reader_get_vocab,
            reader_store::reader_save_vocab_word,
            reader_store::reader_delete_vocab_word,
            reader_store::reader_record_review,
            reader_store::reader_stats,
        ])
        .setup(|app| {
            // 托盘菜单（§8.1）：上组是「动作」（对你当前的内容做点什么），
            // 下组是「窗口/应用」（打开某个界面）。
            let ocr = MenuItem::with_id(app, "ocr", "截图翻译 (OCR)", true, None::<&str>)?;
            let reader = MenuItem::with_id(app, "reader", "沉浸阅读室", true, None::<&str>)?;
            let vocab = MenuItem::with_id(app, "vocab", "生词本", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let history = MenuItem::with_id(app, "history", "翻译历史", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&ocr, &reader, &vocab, &sep, &history, &settings, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ImmersiveTranslator")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => show_window(app, "settings"),
                    "history" => show_window(app, "history"),
                    "reader" => show_reader_window(app),
                    "vocab" => {
                        // 生词本：打开阅读室并切到复习页。窗口已存在 → 事件即时切换；
                        // 不存在 → 记下标记，窗口挂载后由 take_pending_open_review 消费。
                        if app.get_webview_window("reader").is_some() {
                            show_reader_window(app);
                            let _ = app.emit_to("reader", "reader:open-review", ());
                        } else {
                            *app.state::<PendingOpenReview>().0.lock().unwrap() = Some(());
                            show_reader_window(app);
                        }
                    }
                    "ocr" => {
                        // 截图 OCR：截全屏 → 发给 overlay → 显示 overlay
                        open_ocr_overlay(app.clone());
                    }
                    _ => {}
                })
                .build(app)?;

            // 注册默认全局热键（启动占位；用户改键后由 reregister_hotkeys 覆盖）：
            //   Ctrl+Shift+Q —— 选中文字翻译
            //   Ctrl+Shift+E —— 截图 OCR 翻译
            //   Ctrl+Shift+R —— 送进沉浸阅读室
            // 热键按下后的实际逻辑见 trigger_panel / trigger_ocr / trigger_reader。
            app.global_shortcut()
                .on_shortcut("Ctrl+Shift+Q", |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_panel(app);
                })?;
            app.global_shortcut()
                .on_shortcut("Ctrl+Shift+E", |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_ocr(app);
                })?;
            app.global_shortcut()
                .on_shortcut("Ctrl+Shift+R", |app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    trigger_reader(app);
                })?;

            // 启动后用用户保存的热键覆盖默认（hotkey.txt / ocr_hotkey.txt /
            // reader_hotkey.txt 在 app_data_dir）。
            // 任一文件存在且非默认值，就用 reregister_hotkeys 把三个键一起重新注册。
            if let Ok(appdata) = app.path().app_data_dir() {
                let read_saved = |file: &str, default: &str| -> String {
                    std::fs::read_to_string(appdata.join(file))
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| default.to_string())
                };
                let saved_translate = read_saved("hotkey.txt", DEFAULT_TRANSLATE_HOTKEY);
                let saved_ocr = read_saved("ocr_hotkey.txt", DEFAULT_OCR_HOTKEY);
                let saved_reader = read_saved("reader_hotkey.txt", DEFAULT_READER_HOTKEY);
                let has_custom = saved_translate != DEFAULT_TRANSLATE_HOTKEY
                    || saved_ocr != DEFAULT_OCR_HOTKEY
                    || saved_reader != DEFAULT_READER_HOTKEY;
                // 任意两键相同或某键非法时跳过恢复，保留默认键不破坏启动（三键互斥校验）。
                let distinct = !saved_translate.eq_ignore_ascii_case(&saved_ocr)
                    && !saved_translate.eq_ignore_ascii_case(&saved_reader)
                    && !saved_ocr.eq_ignore_ascii_case(&saved_reader);
                if has_custom && distinct {
                    let _ = reregister_hotkeys(
                        app.handle().clone(),
                        saved_translate,
                        saved_ocr,
                        saved_reader,
                    );
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
