/** Future reminders are handed to the OS, never driven by an app timer. */
export interface ReminderSettings { daily: boolean; remindTime: string; dnd: boolean }
export interface ReminderWord { dueAt: number; paused?: boolean }
export interface StudyNotification {
  id: string;
  hour: number;
  minute: number;
  repeats: true;
  title: string;
  body: string;
}

export function reminderTime(settings: ReminderSettings): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(settings.remindTime);
  if (!match) throw new Error("提醒时间无效，请重新选择时间");
  const hour = Number(match[1]), minute = Number(match[2]);
  return settings.dnd && hour < 7 ? [7, 0] : [hour, minute];
}

export function buildReminderPlan(settings: ReminderSettings, words: readonly ReminderWord[]): StudyNotification[] {
  if (!settings.daily) return [];
  if (!words.some(word => !word.paused)) return [];
  const [hour, minute] = reminderTime(settings);
  // A calendar trigger with only hour/minute repeats indefinitely in local time.
  // Generic copy stays accurate even when reviews change while the app is closed.
  return [{ id: "ita-study-daily", hour, minute, repeats: true,
    title: "该复习一下了", body: "花几分钟回顾学过的表达，保持练习的节奏。" }];
}
