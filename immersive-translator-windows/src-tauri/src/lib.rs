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

/// 截图 OCR 热键按下后的处理：直接进入截图 OCR 模式（截全屏 → overlay 框选）。
/// 复用托盘「截图翻译(OCR)」的入口，下游识别/翻译链路不变。
fn trigger_ocr(app: &AppHandle) {
    open_ocr_overlay(app.clone());
}

/// 运行时切换全局热键。先注销全部，再原子地注册翻译键 + OCR 键，并分别持久化。
/// 任一解析/注册失败则整体报错（此时默认键已被 unregister_all 清掉，
/// 调用方应提示用户并建议重启以恢复默认）。返回 Ok("ok") 或 Err(原因)。
#[tauri::command]
fn reregister_hotkeys(
    app: AppHandle,
    translate_hotkey: String,
    ocr_hotkey: String,
) -> Result<String, String> {
    let gs = app.global_shortcut();
    // 先全注销，随后一次性把两个键都注册回来
    let _ = gs.unregister_all();

    let translate_trimmed = translate_hotkey.trim();
    let ocr_trimmed = ocr_hotkey.trim();
    if translate_trimmed.is_empty() || ocr_trimmed.is_empty() {
        return Err("热键为空".into());
    }
    if translate_trimmed.eq_ignore_ascii_case(ocr_trimmed) {
        return Err("翻译热键和截图 OCR 热键不能相同".into());
    }

    // 解析两个快捷键（任一失败立即报错回滚）
    let translate_shortcut = Shortcut::from_str(translate_trimmed)
        .map_err(|e| format!("无法解析翻译热键「{translate_trimmed}」: {e}"))?;
    let ocr_shortcut = Shortcut::from_str(ocr_trimmed)
        .map_err(|e| format!("无法解析截图 OCR 热键「{ocr_trimmed}」: {e}"))?;

    // 翻译键
    gs.on_shortcut(translate_shortcut, move |app, _shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        trigger_panel(app);
    })
    .map_err(|e| {
        format!("注册翻译热键失败「{translate_trimmed}」（可能已被系统或其它程序占用）: {e}")
    })?;

    // OCR 键
    gs.on_shortcut(ocr_shortcut, move |app, _shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        trigger_ocr(app);
    })
    .map_err(|e| {
        format!("注册截图 OCR 热键失败「{ocr_trimmed}」（可能已被系统或其它程序占用）: {e}")
    })?;

    // 分别持久化到 app_data_dir 下的 hotkey.txt / ocr_hotkey.txt
    if let Ok(appdata) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&appdata);
        let _ = std::fs::write(appdata.join("hotkey.txt"), translate_trimmed);
        let _ = std::fs::write(appdata.join("ocr_hotkey.txt"), ocr_trimmed);
    }

    Ok("ok".into())
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
