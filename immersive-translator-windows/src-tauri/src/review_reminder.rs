//! 复习提醒（复习触点）：
//!
//! - 每日一次到点提醒：到期数 > 0 且到了配置时间（默认 20:00）→ 右下角弹
//!   应用自绘的提醒卡（免打扰时段内不弹）。
//! - 托盘角标：任务栏图标叠加红色到期数；托盘菜单「快速复习」直达迷你复习窗。
//!
//! 设计取舍（记录于 docs/reading-room-decisions.md）：用自绘提醒窗而非系统
//! toast，因为 WinRT toast 原生按钮/点击事件在本技术栈不可用，而「开始复习 /
//! 今天先不了」两个按钮是原型的核心交互；免打扰我们自己实现，不依赖系统专注助手。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;

use super::reader_store;
use super::tray_badge;

/// 提醒配置（camelCase 与前端一致），存 app_data_dir/review_reminder.json。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReminderConfig {
    pub enabled: bool,
    /// 每天的第几分钟（20:00 = 1200）。
    pub minute_of_day: u32,
    pub dnd_enabled: bool,
    /// 免打扰起止（分钟），跨零点用 start > end 表达。
    pub dnd_start_min: u32,
    pub dnd_end_min: u32,
    /// 每日阅读目标（分钟）。v1 只存展示，不追踪时长。
    pub read_goal_min: u32,
    /// 上次弹提醒的本地日期（YYYY-MM-DD），每天最多提醒一次。
    #[serde(default)]
    pub last_shown_day: String,
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            minute_of_day: 20 * 60,
            dnd_enabled: true,
            dnd_start_min: 23 * 60,
            dnd_end_min: 8 * 60,
            read_goal_min: 10,
            last_shown_day: String::new(),
        }
    }
}

/// 到点是否应弹提醒（纯函数，可测）。
pub fn should_show_now(cfg: &ReminderConfig, now_min: u32, due: u32, today: &str) -> bool {
    if !cfg.enabled || due == 0 || cfg.last_shown_day == today {
        return false;
    }
    if cfg.dnd_enabled && in_dnd_window(now_min, cfg.dnd_start_min, cfg.dnd_end_min) {
        return false;
    }
    within_remind_window(now_min, cfg.minute_of_day)
}

fn within_remind_window(now_min: u32, target_min: u32) -> bool {
    // 调度周期 30s，取 30 分钟宽窗口保证至少命中多个 tick
    now_min >= target_min && now_min < target_min.saturating_add(30)
}

/// 免打扰窗口判断，支持跨零点（start >= end，如 23:00–08:00）。
fn in_dnd_window(now_min: u32, start_min: u32, end_min: u32) -> bool {
    if start_min == end_min {
        return false;
    }
    if start_min < end_min {
        now_min >= start_min && now_min < end_min
    } else {
        now_min >= start_min || now_min < end_min
    }
}

/// 本地时间 → (当天第几分钟, YYYY-MM-DD)。
#[cfg(windows)]
fn local_now_parts() -> (u32, String) {
    unsafe {
        let mut st = SYSTEMTIME {
            wYear: 0,
            wMonth: 0,
            wDayOfWeek: 0,
            wDay: 0,
            wHour: 0,
            wMinute: 0,
            wSecond: 0,
            wMilliseconds: 0,
        };
        GetLocalTime(&mut st);
        (
            st.wHour as u32 * 60 + st.wMinute as u32,
            format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay),
        )
    }
}

#[cfg(not(windows))]
fn local_now_parts() -> (u32, String) {
    (0, String::new())
}

// ---------- 托盘句柄 ----------

/// 托盘图标与「快速复习」菜单项的运行时句柄（角标/文案动态更新）。
#[derive(Default)]
pub struct TrayHandles {
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
    pub quick_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

/// 读取到期数并刷新托盘角标 + 菜单文案。存取失败静默（下次 tick 重试）。
pub fn update_tray(app: &AppHandle) {
    let due = reader_store::due_count(app);
    let handles = app.state::<TrayHandles>();
    let tray_guard = handles.tray.lock().unwrap();
    if let Some(tray) = tray_guard.as_ref() {
        if let Some(base) = app.default_window_icon() {
            let icon = tray_badge::badge_icon(base, due);
            let _ = tray.set_icon(Some(icon));
        }
    }
    drop(tray_guard);
    let item_guard = handles.quick_item.lock().unwrap();
    if let Some(item) = item_guard.as_ref() {
        let text = if due > 0 {
            format!("快速复习（{due} 到期）")
        } else {
            "快速复习".to_string()
        };
        let _ = item.set_text(text);
    }
}

// ---------- 提醒卡 ----------

/// 待展示的提醒负载（窗口挂载时取走，与 PendingPanelPayload 同模式）。
#[derive(Default)]
pub struct PendingReminder(Mutex<Option<u32>>);

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("review_reminder.json"))
}

fn load_config(app: &AppHandle) -> ReminderConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &ReminderConfig) -> Result<(), String> {
    let path = config_path(app)?;
    write_atomic(&path, &serde_json::to_string(cfg).map_err(|e| e.to_string())?)
}

fn write_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入 {path:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

/// 弹提醒卡：右下角、置顶、不抢焦点。负载经 PendingReminder 送达前端。
fn show_reminder(app: &AppHandle, due: u32) {
    let win = match app.get_webview_window("reminder") {
        Some(w) => w,
        None => {
            let built = tauri::WebviewWindowBuilder::new(
                app,
                "reminder",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("")
            .inner_size(384.0, 200.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focusable(true)
            .visible(false)
            .build();
            match built {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[reminder] build failed: {e}");
                    return;
                }
            }
        }
    };
    // 摆到主屏右下角（任务栏上方留白）
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        let x = pos.x + size.width as i32 - 384 - 24;
        let y = pos.y + size.height as i32 - 200 - 76;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    *app.state::<PendingReminder>().0.lock().unwrap() = Some(due);
    // show 可能激活窗口，但提醒卡允许获得焦点后自然失焦；不主动 set_focus。
    let _ = win.show();
    let _ = win.emit("reminder:show", due);
}

/// 打开快速复习迷你窗（托盘菜单 / 提醒卡共用入口）。
pub fn open_quick_review_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("quick-review") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "quick-review",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("快速复习")
    .inner_size(440.0, 640.0)
    .min_inner_size(380.0, 520.0)
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .center()
    .build();
    match built {
        Ok(win) => {
            let _ = win.show();
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("[quick-review] build failed: {e}"),
    }
}

// ---------- 调度 ----------

/// 启动后台调度线程：每 30s 刷一次托盘角标，并判断是否到点弹提醒。
pub fn spawn_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let _ = tick(&app);
    });
}

fn tick(app: &AppHandle) -> Result<(), String> {
    update_tray(app);
    let cfg = load_config(app);
    let (now_min, today) = local_now_parts();
    if today.is_empty() {
        return Ok(());
    }
    let due = reader_store::due_count(app);
    if should_show_now(&cfg, now_min, due, &today) {
        let mut next = cfg.clone();
        next.last_shown_day = today;
        save_config(app, &next)?;
        show_reminder(app, due);
    }
    Ok(())
}

// ---------- 命令 ----------

#[tauri::command]
pub fn reminder_get_config(app: AppHandle) -> ReminderConfig {
    load_config(&app)
}

#[tauri::command]
pub fn reminder_set_config(app: AppHandle, config: ReminderConfig) -> Result<(), String> {
    save_config(&app, &config)?;
    update_tray(&app);
    Ok(())
}

/// 当前到期数（提醒卡/迷你窗展示用）。
#[tauri::command]
pub fn reminder_due_now(app: AppHandle) -> u32 {
    reader_store::due_count(&app)
}

/// 提醒卡挂载时取走到期数（与 take_pending_panel_payload 同模式）。
#[tauri::command]
pub fn take_pending_reminder(state: tauri::State<'_, PendingReminder>) -> Option<u32> {
    state.0.lock().unwrap().take()
}

/// 前端在生词变化（收藏/评分/导入）后调用：立即刷新托盘角标与菜单文案。
#[tauri::command]
pub fn tray_refresh_badge(app: AppHandle) {
    update_tray(&app);
}

/// 打开快速复习迷你窗（前端提醒卡按钮用）。
#[tauri::command]
pub fn open_quick_review(app: AppHandle) {
    open_quick_review_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ReminderConfig {
        ReminderConfig {
            enabled: true,
            minute_of_day: 20 * 60,
            dnd_enabled: true,
            dnd_start_min: 23 * 60,
            dnd_end_min: 8 * 60,
            read_goal_min: 10,
            last_shown_day: String::new(),
        }
    }

    #[test]
    fn fires_once_in_window_with_due() {
        let c = cfg();
        assert!(should_show_now(&c, 20 * 60, 6, "2026-09-13"));
        assert!(should_show_now(&c, 20 * 60 + 29, 1, "2026-09-13"));
        assert!(!should_show_now(&c, 20 * 60 + 30, 6, "2026-09-13"));
    }

    #[test]
    fn no_due_or_disabled_or_already_shown_never_fires() {
        let c = cfg();
        assert!(!should_show_now(&c, 20 * 60, 0, "2026-09-13"));
        let mut off = cfg();
        off.enabled = false;
        assert!(!should_show_now(&off, 20 * 60, 6, "2026-09-13"));
        let mut shown = cfg();
        shown.last_shown_day = "2026-09-13".into();
        assert!(!should_show_now(&shown, 20 * 60, 6, "2026-09-13"));
    }

    #[test]
    fn dnd_window_crosses_midnight() {
        let c = cfg();
        // 免打扰 23:00–08:00：23:30 / 02:00 不弹，08:00 之后正常
        assert!(!should_show_now(&c, 23 * 60 + 30, 6, "2026-09-13"));
        assert!(!should_show_now(&c, 2 * 60, 6, "2026-09-13"));
        let mut noon = cfg();
        noon.minute_of_day = 12 * 60;
        assert!(should_show_now(&noon, 12 * 60, 6, "2026-09-13"));
    }

    #[test]
    fn dnd_disabled_ignores_window() {
        let mut c = cfg();
        c.dnd_enabled = false;
        c.minute_of_day = 23 * 60 + 30;
        assert!(should_show_now(&c, 23 * 60 + 30, 6, "2026-09-13"));
    }

    #[test]
    fn config_roundtrip_defaults() {
        let json = serde_json::to_string(&cfg()).unwrap();
        let back: ReminderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.minute_of_day, 1200);
        // 老文件缺 last_shown_day 字段也能加载
        let legacy: ReminderConfig =
            serde_json::from_str(r#"{"enabled":true,"minuteOfDay":1200,"dndEnabled":true,"dndStartMin":1380,"dndEndMin":480,"readGoalMin":10}"#).unwrap();
        assert_eq!(legacy.last_shown_day, "");
    }
}
