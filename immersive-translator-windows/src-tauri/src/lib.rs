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

const DEFAULT_HOTKEY: &str = "Ctrl+Shift+Q";

struct ActiveHotkey(Mutex<Shortcut>);

impl Default for ActiveHotkey {
    fn default() -> Self {
        Self(Mutex::new(
            Shortcut::from_str(DEFAULT_HOTKEY).expect("default hotkey must be valid"),
        ))
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

fn register_panel_hotkey(
    app: &AppHandle,
    shortcut: Shortcut,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            trigger_panel(app);
        })
}

fn persist_hotkey(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    let appdata = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&appdata).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    std::fs::write(appdata.join("hotkey.txt"), shortcut.into_string())
        .map_err(|error| format!("无法保存热键: {error}"))
}

/// Register and persist the replacement before removing the current shortcut.
/// If a later step fails, remove the replacement and restore the old persisted
/// value so callers keep the previous working configuration.
fn switch_registered_hotkey<FRegister, FUnregister, FPersist>(
    current: Shortcut,
    replacement: Shortcut,
    mut register: FRegister,
    mut unregister: FUnregister,
    mut persist: FPersist,
) -> Result<bool, String>
where
    FRegister: FnMut(Shortcut) -> Result<(), String>,
    FUnregister: FnMut(Shortcut) -> Result<(), String>,
    FPersist: FnMut(Shortcut) -> Result<(), String>,
{
    if current == replacement {
        persist(replacement).map_err(|error| format!("保存热键失败: {error}"))?;
        return Ok(false);
    }

    register(replacement).map_err(|error| format!("注册新热键失败: {error}"))?;
    if let Err(error) = persist(replacement) {
        let unregister_error = unregister(replacement).err();
        let restore_error = persist(current).err();
        return Err(format_rollback_error(
            format!("保存新热键失败: {error}"),
            unregister_error,
            restore_error,
        ));
    }
    if let Err(error) = unregister(current) {
        let unregister_error = unregister(replacement).err();
        let restore_error = persist(current).err();
        return Err(format_rollback_error(
            format!("注销旧热键失败: {error}"),
            unregister_error,
            restore_error,
        ));
    }

    Ok(true)
}

fn format_rollback_error(
    cause: String,
    unregister_error: Option<String>,
    restore_error: Option<String>,
) -> String {
    let mut message = cause;
    match unregister_error {
        Some(error) => message.push_str(&format!("；注销新热键失败: {error}")),
        None => message.push_str("；已注销新热键"),
    }
    match restore_error {
        Some(error) => message.push_str(&format!("；恢复旧配置失败: {error}")),
        None => message.push_str("；已恢复旧配置"),
    }
    message
}

/// 运行时切换全局热键。新键注册成功后才注销旧键，并持久化到 hotkey.txt。
/// 返回 Ok(normalized) 或 Err(原因)。
#[tauri::command]
fn reregister_hotkey(app: AppHandle, hotkey: String) -> Result<String, String> {
    let trimmed = hotkey.trim();
    if trimmed.is_empty() {
        return Err("热键为空".into());
    }
    let shortcut =
        Shortcut::from_str(trimmed).map_err(|e| format!("无法解析热键「{trimmed}」: {e}"))?;

    let active_state = app.state::<ActiveHotkey>();
    let mut active = active_state
        .0
        .lock()
        .map_err(|_| "热键状态不可用".to_string())?;
    let previous = *active;
    let switched = switch_registered_hotkey(
        previous,
        shortcut,
        |candidate| register_panel_hotkey(&app, candidate).map_err(|error| error.to_string()),
        |candidate| {
            app.global_shortcut()
                .unregister(candidate)
                .map_err(|error| error.to_string())
        },
        |candidate| persist_hotkey(&app, candidate),
    )
    .map_err(|error| format!("应用热键失败「{trimmed}」: {error}"))?;
    if switched {
        *active = shortcut;
    }
    drop(active);

    Ok(trimmed.to_string())
}

#[tauri::command]
fn get_active_hotkey(state: tauri::State<'_, ActiveHotkey>) -> Result<String, String> {
    let active = state.0.lock().map_err(|_| "热键状态不可用".to_string())?;
    Ok((*active).into_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ActiveHotkey::default())
        .manage(translation::CancelFlag::default())
        .manage(ocr::OcrEngine::default())
        .manage(PendingPanelPayload::default())
        .invoke_handler(tauri::generate_handler![
            greet,
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
            reregister_hotkey,
            get_active_hotkey,
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

            // 先注册默认键；用户保存的快捷键稍后通过事务式切换覆盖它。
            register_panel_hotkey(app.handle(), Shortcut::from_str(DEFAULT_HOTKEY)?)?;

            // 启动后用后端保存在 app_data_dir/hotkey.txt 的用户热键覆盖默认值。
            if let Ok(appdata) = app.path().app_data_dir() {
                let path = appdata.join("hotkey.txt");
                if let Ok(hk) = std::fs::read_to_string(&path) {
                    let hk = hk.trim();
                    if !hk.is_empty() && hk != DEFAULT_HOTKEY {
                        if let Err(error) = reregister_hotkey(app.handle().clone(), hk.to_string())
                        {
                            eprintln!("[hotkey] ignored saved shortcut: {error}");
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Debug, PartialEq, Eq)]
    enum Call {
        Register(u32),
        Persist(u32),
        Unregister(u32),
    }

    fn shortcut(value: &str) -> Shortcut {
        Shortcut::from_str(value).unwrap()
    }

    #[test]
    fn hotkey_switch_registers_replacement_before_removing_current() {
        let current = shortcut(DEFAULT_HOTKEY);
        let replacement = shortcut("Ctrl+Shift+T");
        let calls = RefCell::new(Vec::new());

        let switched = switch_registered_hotkey(
            current,
            replacement,
            |value| {
                calls.borrow_mut().push(Call::Register(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Unregister(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Persist(value.id()));
                Ok(())
            },
        )
        .unwrap();

        assert!(switched);
        assert_eq!(
            calls.into_inner(),
            vec![
                Call::Register(replacement.id()),
                Call::Persist(replacement.id()),
                Call::Unregister(current.id()),
            ]
        );
    }

    #[test]
    fn hotkey_switch_keeps_current_when_replacement_registration_fails() {
        let current = shortcut(DEFAULT_HOTKEY);
        let replacement = shortcut("Ctrl+Shift+T");
        let calls = RefCell::new(Vec::new());

        let result = switch_registered_hotkey(
            current,
            replacement,
            |value| {
                calls.borrow_mut().push(Call::Register(value.id()));
                Err("occupied".to_string())
            },
            |value| {
                calls.borrow_mut().push(Call::Unregister(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Persist(value.id()));
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(calls.into_inner(), vec![Call::Register(replacement.id())]);
    }

    #[test]
    fn hotkey_switch_rolls_back_replacement_when_current_removal_fails() {
        let current = shortcut(DEFAULT_HOTKEY);
        let replacement = shortcut("Ctrl+Shift+T");
        let calls = RefCell::new(Vec::new());

        let result = switch_registered_hotkey(
            current,
            replacement,
            |value| {
                calls.borrow_mut().push(Call::Register(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Unregister(value.id()));
                if value == current {
                    Err("cannot unregister current".to_string())
                } else {
                    Ok(())
                }
            },
            |value| {
                calls.borrow_mut().push(Call::Persist(value.id()));
                Ok(())
            },
        );

        let error = result.unwrap_err();
        assert!(error.contains("已注销新热键"));
        assert!(error.contains("已恢复旧配置"));
        assert_eq!(
            calls.into_inner(),
            vec![
                Call::Register(replacement.id()),
                Call::Persist(replacement.id()),
                Call::Unregister(current.id()),
                Call::Unregister(replacement.id()),
                Call::Persist(current.id()),
            ]
        );
    }

    #[test]
    fn hotkey_switch_rolls_back_replacement_when_persistence_fails() {
        let current = shortcut(DEFAULT_HOTKEY);
        let replacement = shortcut("Ctrl+Shift+T");
        let calls = RefCell::new(Vec::new());

        let result = switch_registered_hotkey(
            current,
            replacement,
            |value| {
                calls.borrow_mut().push(Call::Register(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Unregister(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Persist(value.id()));
                if value == replacement {
                    Err("disk full".to_string())
                } else {
                    Ok(())
                }
            },
        );

        let error = result.unwrap_err();
        assert!(error.contains("保存新热键失败: disk full"));
        assert!(error.contains("已注销新热键"));
        assert!(error.contains("已恢复旧配置"));
        assert_eq!(
            calls.into_inner(),
            vec![
                Call::Register(replacement.id()),
                Call::Persist(replacement.id()),
                Call::Unregister(replacement.id()),
                Call::Persist(current.id()),
            ]
        );
    }

    #[test]
    fn hotkey_switch_is_noop_for_same_shortcut() {
        let current = shortcut(DEFAULT_HOTKEY);
        let calls = RefCell::new(Vec::new());

        let switched = switch_registered_hotkey(
            current,
            current,
            |value| {
                calls.borrow_mut().push(Call::Register(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Unregister(value.id()));
                Ok(())
            },
            |value| {
                calls.borrow_mut().push(Call::Persist(value.id()));
                Ok(())
            },
        )
        .unwrap();

        assert!(!switched);
        assert_eq!(calls.into_inner(), vec![Call::Persist(current.id())]);
    }
}
