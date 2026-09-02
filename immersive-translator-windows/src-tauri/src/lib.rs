mod clipboard;
mod history;
mod ocr;
mod screenshot;
mod secret_store;
mod translation;

use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 默认全局热键：Ctrl+Shift+Q —— 选中文字翻译；Ctrl+Shift+E —— 截图 OCR 翻译。
const DEFAULT_TRANSLATE_HOTKEY: &str = "Ctrl+Shift+Q";
const DEFAULT_OCR_HOTKEY: &str = "Ctrl+Shift+E";

/// 当前生效的（翻译热键, OCR 热键）对，用于热键切换时对比与回滚。
struct ActiveHotkeys(Mutex<(Shortcut, Shortcut)>);

impl Default for ActiveHotkeys {
    fn default() -> Self {
        Self(Mutex::new((
            Shortcut::from_str(DEFAULT_TRANSLATE_HOTKEY).expect("default translate hotkey valid"),
            Shortcut::from_str(DEFAULT_OCR_HOTKEY).expect("default ocr hotkey valid"),
        )))
    }
}

#[derive(Clone, serde::Serialize)]
struct PanelPayload {
    text: String,
    source: String,
}

#[derive(Default)]
struct PendingPanelPayload(Mutex<Option<PanelPayload>>);

fn show_panel_with_payload(app: &AppHandle, payload: PanelPayload) {
    let pending = app.state::<PendingPanelPayload>();
    *pending.0.lock().unwrap() = Some(payload.clone());

    let Some(panel) = app.get_webview_window("panel") else {
        eprintln!("[panel] panel window not found");
        return;
    };

    let _ = panel.show();
    let _ = panel.set_focus();
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
    let app_handle = app.clone();
    std::thread::spawn(move || {
        // 等热键释放，避免修饰键残留污染 Ctrl+C
        std::thread::sleep(std::time::Duration::from_millis(180));
        let selected = clipboard::read_selection_impl().unwrap_or_default();
        show_panel_with_payload(
            &app_handle,
            PanelPayload {
                text: selected,
                source: "selection".into(),
            },
        );
    });
}

/// 截图 OCR 热键按下后的处理：直接进入截图 OCR 模式（截全屏 → overlay 框选）。
/// 复用托盘「截图翻译(OCR)」的入口，下游识别/翻译链路不变。
fn trigger_ocr(app: &AppHandle) {
    open_ocr_overlay(app.clone());
}

/// 翻译热键的回调注册（事件去重：仅 Pressed 触发）。
fn register_translate_shortcut(
    app: &AppHandle,
    shortcut: Shortcut,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            trigger_panel(app);
        })
}

/// OCR 热键的回调注册。
fn register_ocr_shortcut(
    app: &AppHandle,
    shortcut: Shortcut,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            trigger_ocr(app);
        })
}

fn persist_hotkeys(app: &AppHandle, translate: Shortcut, ocr: Shortcut) -> Result<(), String> {
    let appdata = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&appdata).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    std::fs::write(appdata.join("hotkey.txt"), translate.into_string())
        .map_err(|error| format!("无法保存翻译热键: {error}"))?;
    std::fs::write(appdata.join("ocr_hotkey.txt"), ocr.into_string())
        .map_err(|error| format!("无法保存截图 OCR 热键: {error}"))?;
    Ok(())
}

/// 把（翻译热键, OCR 热键）从 current 切换到 replacement。
///
/// 安全语义（对齐远程单热键版的可回滚设计）：
/// 1. 有变化的键**先注册新值**；任何注册失败 → 撤销本次已注册的新键，旧键原样保留；
/// 2. 全部注册成功后**写持久化**；写失败 → 同样撤销已注册新键并报错；
/// 3. 最后才**注销不再使用的旧键**；注销失败 → 尝试整体回滚到旧配置。
///
/// 全程不出现「先注销清空、后注册失败导致没有任何热键可用」的空窗。
/// 返回 Ok(true) 表示真的切换过；Ok(false) 表示目标与当前一致（仅尝试持久化）。
fn switch_hotkeys(
    current: (Shortcut, Shortcut),
    replacement: (Shortcut, Shortcut),
    mut register_translate: impl FnMut(Shortcut) -> Result<(), String>,
    mut register_ocr: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
    mut persist: impl FnMut(Shortcut, Shortcut) -> Result<(), String>,
) -> Result<bool, String> {
    let (cur_t, cur_o) = current;
    let (new_t, new_o) = replacement;

    if cur_t == new_t && cur_o == new_o {
        persist(new_t, new_o).map_err(|error| format!("保存热键失败: {error}"))?;
        return Ok(false);
    }

    // —— 第 1 步：注册有变化的新键（逐个），记录成功项以便回滚 ——
    let mut registered: Vec<Shortcut> = Vec::new();
    if new_t != cur_t {
        register_translate(new_t)
            .map_err(|error| format!("注册翻译热键失败: {error}"))?;
        registered.push(new_t);
    }
    if new_o != cur_o {
        register_ocr(new_o).map_err(|error| {
            for s in &registered {
                let _ = unregister(*s);
            }
            format!("注册截图 OCR 热键失败: {error}")
        })?;
        registered.push(new_o);
    }

    // —— 第 2 步：持久化；失败则撤销刚注册的新键 ——
    if let Err(error) = persist(new_t, new_o) {
        for s in &registered {
            let _ = unregister(*s);
        }
        return Err(format!("保存热键失败: {error}"));
    }

    // —— 第 3 步：注销不再使用的旧键；失败则尽力回滚到旧配置 ——
    // 记录「已成功注销」的旧键：只有真正被移除的键才需要在回滚时恢复，
    // 未变化的键绝不重复注册，避免插件「已注册」误报污染回滚信息。
    let mut removed_old: Vec<Shortcut> = Vec::new();
    let mut unregister_failed = false;
    if new_t != cur_t {
        match unregister(cur_t) {
            Ok(()) => removed_old.push(cur_t),
            Err(_) => unregister_failed = true,
        }
    }
    if new_o != cur_o {
        match unregister(cur_o) {
            Ok(()) => removed_old.push(cur_o),
            Err(_) => unregister_failed = true,
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
            let result = if *old == cur_t {
                register_translate(*old)
            } else {
                register_ocr(*old)
            };
            if let Err(error) = result {
                messages.push(format!("恢复旧键失败: {error}"));
            }
        }
        let _ = persist(cur_t, cur_o);
        let mut msg = "注销旧热键失败，已尝试回滚".to_string();
        for m in messages {
            msg.push_str(&format!("；{m}"));
        }
        return Err(msg);
    }

    Ok(true)
}

/// 运行时切换两个全局热键。全程可回滚：任一失败都保证旧键仍生效，
/// 不会出现「新键被占用导致两个键全部失效、只能重启恢复」的情况。
/// 返回 Ok("ok") 或 Err(原因)。
#[tauri::command]
fn reregister_hotkeys(
    app: AppHandle,
    translate_hotkey: String,
    ocr_hotkey: String,
) -> Result<String, String> {
    let translate_trimmed = translate_hotkey.trim();
    let ocr_trimmed = ocr_hotkey.trim();
    if translate_trimmed.is_empty() || ocr_trimmed.is_empty() {
        return Err("热键为空".into());
    }
    if translate_trimmed.eq_ignore_ascii_case(ocr_trimmed) {
        return Err("翻译热键和截图 OCR 热键不能相同".into());
    }

    let translate_shortcut = Shortcut::from_str(translate_trimmed)
        .map_err(|e| format!("无法解析翻译热键「{translate_trimmed}」: {e}"))?;
    let ocr_shortcut = Shortcut::from_str(ocr_trimmed)
        .map_err(|e| format!("无法解析截图 OCR 热键「{ocr_trimmed}」: {e}"))?;

    let active = app.state::<ActiveHotkeys>();
    let mut current = active
        .0
        .lock()
        .map_err(|_| "热键状态不可用".to_string())?;
    let switched = switch_hotkeys(
        *current,
        (translate_shortcut, ocr_shortcut),
        |s| register_translate_shortcut(&app, s).map_err(|e| e.to_string()),
        |s| register_ocr_shortcut(&app, s).map_err(|e| e.to_string()),
        |s| {
            app.global_shortcut()
                .unregister(s)
                .map_err(|e| e.to_string())
        },
        |t, o| persist_hotkeys(&app, t, o),
    )
    .map_err(|error| {
        format!(
            "应用热键失败「{translate_trimmed} / {ocr_trimmed}」: {error}"
        )
    })?;
    if switched {
        *current = (translate_shortcut, ocr_shortcut);
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
        Persist(u32, u32),
    }

    fn shortcut(value: &str) -> Shortcut {
        Shortcut::from_str(value).unwrap()
    }

    fn make_fns() -> (
        Rc<RefCell<Vec<Call>>>,
        impl FnMut(Shortcut) -> Result<(), String>,
        impl FnMut(Shortcut) -> Result<(), String>,
        impl FnMut(Shortcut) -> Result<(), String>,
        impl FnMut(Shortcut, Shortcut) -> Result<(), String>,
    ) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let c1 = calls.clone();
        let c2 = calls.clone();
        let c3 = calls.clone();
        let c4 = calls.clone();
        (
            calls.clone(),
            move |s| {
                c1.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c2.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c3.borrow_mut().push(Call::Unregister(s.id()));
                Ok(())
            },
            move |t, o| {
                c4.borrow_mut().push(Call::Persist(t.id(), o.id()));
                Ok(())
            },
        )
    }

    #[test]
    fn registers_replacements_before_unregistering_current() {
        let (calls, rt, ro, un, ps) = make_fns();
        let switched = switch_hotkeys(
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            (shortcut("Alt+Shift+Q"), shortcut("Alt+Shift+E")),
            rt, ro, un, ps,
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
        let idx_ro = list
            .iter()
            .position(|c| *c == Call::Register(id_alt_o))
            .unwrap();
        let idx_un_t = list
            .iter()
            .position(|c| *c == Call::Unregister(id_cur_t))
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
        // 新键先注册、旧键后注销
        assert!(idx_rt < idx_un_t && idx_ro < idx_un_o);
    }

    #[test]
    fn noop_when_target_equals_current_only_persists() {
        let (calls, rt, ro, un, ps) = make_fns();
        let switched = switch_hotkeys(
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            rt, ro, un, ps,
        )
        .unwrap();
        assert!(!switched);
        assert_eq!(
            calls.borrow().clone(),
            vec![Call::Persist(
                shortcut("Ctrl+Shift+Q").id(),
                shortcut("Ctrl+Shift+E").id(),
            )]
        );
    }

    #[test]
    fn rolls_back_new_registrations_when_persist_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let c1 = calls.clone();
        let c2 = calls.clone();
        let c3 = calls.clone();
        let result = switch_hotkeys(
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            (shortcut("Alt+Shift+Q"), shortcut("Alt+Shift+E")),
            move |s| {
                c1.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c2.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c3.borrow_mut().push(Call::Unregister(s.id()));
                Ok(())
            },
            |_, _| Err("disk full".into()),
        );
        assert!(result.is_err());
        let id_alt_t = shortcut("Alt+Shift+Q").id();
        let id_alt_o = shortcut("Alt+Shift+E").id();
        assert_eq!(
            calls.borrow().clone(),
            vec![
                Call::Register(id_alt_t),
                Call::Register(id_alt_o),
                Call::Unregister(id_alt_t),
                Call::Unregister(id_alt_o),
            ]
        );
    }

    #[test]
    fn keeps_current_when_replacement_registration_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let c1 = calls.clone();
        let c2 = calls.clone();
        let result = switch_hotkeys(
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            (shortcut("Alt+Shift+Q"), shortcut("Ctrl+Shift+E")),
            move |s| {
                c1.borrow_mut().push(Call::Register(s.id()));
                if s.id() == shortcut("Alt+Shift+Q").id() {
                    Err("occupied".into())
                } else {
                    Ok(())
                }
            },
            move |s| {
                let _ = s;
                unreachable!("ocr unchanged, register must not be called")
            },
            |s| {
                let _ = s;
                Err("unregister must not be called".into())
            },
            |_, _| Err("persist must not be called".into()),
        );
        assert!(result.is_err());
        // OCR 键未变不会进入注册/回滚分支；翻译键注册失败直接返回，不回滚也不持久化
        assert_eq!(
            calls.borrow().clone(),
            vec![Call::Register(shortcut("Alt+Shift+Q").id())]
        );
        drop(c2);
    }

    #[test]
    fn rolls_back_when_unregistering_current_fails() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let c1 = calls.clone();
        let c2 = calls.clone();
        let c3 = calls.clone();
        let c4 = calls.clone();
        let result = switch_hotkeys(
            (shortcut("Ctrl+Shift+Q"), shortcut("Ctrl+Shift+E")),
            (shortcut("Alt+Shift+Q"), shortcut("Alt+Shift+E")),
            move |s| {
                c1.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c2.borrow_mut().push(Call::Register(s.id()));
                Ok(())
            },
            move |s| {
                c3.borrow_mut().push(Call::Unregister(s.id()));
                // 注销两个旧键都失败 → 触发回滚
                let old_q = shortcut("Ctrl+Shift+Q").id();
                let old_e = shortcut("Ctrl+Shift+E").id();
                if s.id() == old_q || s.id() == old_e {
                    Err("cannot unregister".into())
                } else {
                    Ok(())
                }
            },
            move |t, o| {
                c4.borrow_mut().push(Call::Persist(t.id(), o.id()));
                Ok(())
            },
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
                Call::Persist(id_alt_q, id_alt_e),
                // 第 3 步：尝试注销旧键（都失败 → 触发回滚）
                Call::Unregister(id_q),
                Call::Unregister(id_e),
                // 回滚：撤销刚注册的新键（旧键注销失败说明旧键仍在生效，无需重复注册）
                Call::Unregister(id_alt_q),
                Call::Unregister(id_alt_e),
                // 回滚：持久化恢复旧配置
                Call::Persist(id_q, id_e),
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
        .manage(PendingPanelPayload::default())
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
            history::history_add,
            history::history_list,
            history::history_toggle_favorite,
            history::history_delete,
            history::history_clear_non_favorites,
            history::history_export,
            open_settings,
            open_history,
            open_ocr_overlay,
            show_ocr_result,
            reregister_hotkeys,
        ])
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let history = MenuItem::with_id(app, "history", "翻译历史", true, None::<&str>)?;
            let ocr = MenuItem::with_id(app, "ocr", "截图翻译 (OCR)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&ocr, &history, &settings, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ImmersiveTranslator")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => show_window(app, "settings"),
                    "history" => show_window(app, "history"),
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
            // 热键按下后的实际逻辑见 trigger_panel / trigger_ocr。
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

            // 启动后用用户保存的热键覆盖默认（hotkey.txt / ocr_hotkey.txt 在 app_data_dir）。
            // 任一文件存在且非默认值，就用 reregister_hotkeys 把两个键一起重新注册。
            if let Ok(appdata) = app.path().app_data_dir() {
                let saved_translate = std::fs::read_to_string(appdata.join("hotkey.txt"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let saved_ocr = std::fs::read_to_string(appdata.join("ocr_hotkey.txt"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                if saved_translate.is_some() || saved_ocr.is_some() {
                    let t = saved_translate.unwrap_or_else(|| "Ctrl+Shift+Q".into());
                    let o = saved_ocr.unwrap_or_else(|| "Ctrl+Shift+E".into());
                    // 两键相同或某键非法时跳过恢复，保留默认键不破坏启动
                    if !t.eq_ignore_ascii_case(&o) {
                        let _ = reregister_hotkeys(app.handle().clone(), t, o);
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
