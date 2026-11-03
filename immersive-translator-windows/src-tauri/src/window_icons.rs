//! Windows 标题栏与任务栏图标同步。
//!
//! Tauri/tao 的窗口图标只设置 ICON_SMALL；未设置 ICON_BIG 时，任务栏会
//! 回退到 Explorer 缓存的 EXE 图标，同一路径升级后可能继续显示旧品牌。

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("window-icons")
        // Tauri 在主线程调用此回调，覆盖配置预建和运行中重新创建的窗口。
        .on_window_ready(|window| {
            #[cfg(windows)]
            synchronize_taskbar_icon(&window);
            #[cfg(not(windows))]
            let _ = window;
        })
        .build()
}

#[cfg(windows)]
fn synchronize_taskbar_icon<R: tauri::Runtime>(window: &tauri::Window<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageW, ICON_BIG, ICON_SMALL, WM_GETICON, WM_SETICON,
    };

    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as _,
        Err(error) => {
            eprintln!(
                "[window_icons] {}: 读取窗口句柄失败: {error}",
                window.label()
            );
            return;
        }
    };

    // 当前正式 ICO 的首帧为 32px，Tauri 将它解码后交给 tao 持有，足够用于
    // 标准任务栏。只借用该 HICON，不创建或销毁句柄；tao 保持它到窗口销毁。
    // 若将来增加运行中 set_icon，须同时同步 ICON_BIG，避免借用旧句柄。
    let icon = unsafe { SendMessageW(hwnd, WM_GETICON, ICON_SMALL as _, 0) };
    if icon == 0 {
        eprintln!("[window_icons] {}: 窗口图标尚未设置", window.label());
        return;
    }
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as _, icon);
    }
}
