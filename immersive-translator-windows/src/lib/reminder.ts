/**
 * 复习提醒（复习触点）前端桥接：配置读写、到期数、提醒卡负载、托盘角标刷新。
 * 对应 Rust review_reminder.rs 的命令面。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ReminderConfig {
  enabled: boolean;
  /** 每天的第几分钟（20:00 = 1200）。 */
  minuteOfDay: number;
  dndEnabled: boolean;
  /** 免打扰起止（分钟），跨零点用 start > end 表达。 */
  dndStartMin: number;
  dndEndMin: number;
  /** 每日阅读目标（分钟）。 */
  readGoalMin: number;
  lastShownDay: string;
}

export function reminderGetConfig(): Promise<ReminderConfig> {
  return invoke<ReminderConfig>("reminder_get_config");
}

export function reminderSetConfig(config: ReminderConfig): Promise<void> {
  return invoke<void>("reminder_set_config", { config });
}

/** 当前到期数（托盘角标同源）。 */
export function reminderDueNow(): Promise<number> {
  return invoke<number>("reminder_due_now");
}

/** 提醒窗口挂载时取走到期数（与 takePendingPanelPayload 同模式）。 */
export function takePendingReminder(): Promise<number | null> {
  return invoke<number | null>("take_pending_reminder");
}

/** 生词变化后调用：立即刷新托盘角标与「快速复习（N 到期）」菜单文案。 */
export function trayRefreshBadge(): void {
  void invoke("tray_refresh_badge").catch(() => undefined);
}

/** 打开快速复习迷你窗。 */
export function openQuickReview(): Promise<void> {
  return invoke<void>("open_quick_review");
}

export function onReminderShow(handler: (due: number) => void): Promise<UnlistenFn> {
  return listen<number>("reminder:show", (event) => handler(event.payload));
}
