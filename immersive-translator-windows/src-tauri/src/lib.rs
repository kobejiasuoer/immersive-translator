mod clipboard;
mod translation;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            clipboard::read_selection,
            translation::translate_stream,
            open_settings,
        ])
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(win) = app.get_webview_window("settings") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // 注册全局热键 Alt+Space，按下时切换 panel 窗口显示。
            // 若 Alt+Space 被系统占用（Windows 窗口菜单热键），换成 Alt+Q。
            app.global_shortcut().on_shortcut("Alt+Space", move |app, _shortcut, event| {
                use tauri::Manager;
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let panel = match app.get_webview_window("panel") {
                    Some(p) => p,
                    None => return,
                };
                // 已显示则隐藏（切换）
                if panel.is_visible().unwrap_or(false) {
                    let _ = panel.hide();
                    return;
                }

                // 关键：enigo 的按键模拟在 Tauri 全局热键回调线程里会阻塞死锁，
                // 必须 spawn 独立线程执行。同时：
                // 1. 线程里先 sleep，让 Alt+Space 热键物理释放（避免 Alt 残留污染 Ctrl+C）
                // 2. 复制时焦点仍在原应用（panel 还没 show）
                // 3. 复制完成后再 show panel + emit 文本
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    // 等热键释放，避免 Alt 等修饰键残留
                    std::thread::sleep(std::time::Duration::from_millis(180));

                    let selected = clipboard::read_selection_impl().unwrap_or_default();

                    // 切回主线程上下文操作窗口
                    let panel = match app_handle.get_webview_window("panel") {
                        Some(p) => p,
                        None => return,
                    };
                    let _ = panel.show();
                    let _ = panel.set_focus();
                    let _ = panel.emit("panel:shown", selected);
                });
            })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
