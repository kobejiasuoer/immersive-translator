import { useSyncExternalStore } from "react";
import { invokeRaw, isTauri, reportDiag } from "./device";
import { buildReminderPlan, type ReminderSettings, type ReminderWord } from "./reminderPlan";

export interface NotificationStatus {
  supported: boolean;
  permission: "granted" | "denied" | "prompt" | "unavailable";
  scheduled: number;
  nextAt?: string;
  error?: string;
}
export interface NotificationAction { id: string; at: number }
let status: NotificationStatus = { supported: false, permission: "unavailable", scheduled: 0 };
const listeners = new Set<() => void>();
function publish(next: NotificationStatus) { status = next; listeners.forEach(fn => fn()); }
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useNotificationStatus() { return useSyncExternalStore(subscribe, () => status); }
async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeRaw<T>(`plugin:study-notifications|${command}`, args);
}
function unavailable(): NotificationStatus { return { supported: false, permission: "unavailable", scheduled: 0 }; }
export async function refreshNotificationStatus(): Promise<NotificationStatus> {
  if (!isTauri()) { const next = unavailable(); publish(next); return next; }
  try { const next = { ...(await native<NotificationStatus>("status")), ...(status.error ? { error: status.error } : {}) }; publish(next); return next; }
  catch (error) { const next = { ...status, error: String(error) }; publish(next); return next; }
}
/** Called only by the user's reminder switch, never by startup/reconciliation. */
export async function requestStudyNotifications(): Promise<boolean> {
  if (!isTauri()) { publish(unavailable()); return false; }
  try {
    const available = await refreshNotificationStatus();
    if (!available.supported) return false;
    const next = await native<NotificationStatus>("request"); publish(next); return next.permission === "granted";
  }
  catch (error) { publish({ ...status, error: String(error) }); return false; }
}

// Serialize replacements, discarding requests superseded while another replacement is in flight.
let generation = 0, queue: Promise<void> = Promise.resolve(), appliedPlan: string | null = null;
export function reconcileStudyNotifications(settings: ReminderSettings, words: readonly ReminderWord[], isCurrent: () => boolean = () => true): Promise<NotificationStatus> {
  if (!isCurrent()) return Promise.resolve(status);
  const revision = ++generation;
  let plan: ReturnType<typeof buildReminderPlan>;
  try { plan = buildReminderPlan(settings, words); }
  catch (error) { publish({ ...status, error: String(error) }); return Promise.resolve(status); }
  const key = JSON.stringify(plan);
  const run = queue.then(async () => {
    if (revision !== generation || !isCurrent()) return status;
    if (!isTauri()) { publish(unavailable()); return status; }
    try {
      const available = await native<NotificationStatus>("status");
      if (revision !== generation || !isCurrent()) return status;
      if (!available.supported) { publish(available); return status; }
      if (appliedPlan === key && available.scheduled === plan.length && (available.permission === "granted" || !plan.length)) {
        if (revision === generation) publish(available);
        return status;
      }
      const next = await native<NotificationStatus>("replace", { notifications: plan });
      if (next.scheduled === plan.length && (next.permission === "granted" || !plan.length)) appliedPlan = key;
      if (revision === generation && isCurrent()) publish(next);
    } catch (error) {
      reportDiag("notification", `系统提醒排程失败：${String(error)}`);
      if (revision === generation && isCurrent()) publish({ ...status, error: "系统提醒未能保存，请重试" });
    }
    return status;
  });
  queue = run.then(() => {}, () => {});
  return run;
}
/** Every reminder entry follows the same explicit authorization and verified-save path. */
export async function enableStudyReminder(settings: ReminderSettings, words: readonly ReminderWord[], isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent() || !(await requestStudyNotifications()) || !isCurrent()) return false;
  const next = await reconcileStudyNotifications({ ...settings, daily: true }, words, isCurrent);
  if (!isCurrent()) return false;
  if (next.error || next.permission !== "granted") return false;
  if (words.some(word => !word.paused) && next.scheduled === 0) {
    publish({ ...next, error: "每日提醒未能保存，请重试" });
    return false;
  }
  return true;
}
export async function takeNotificationAction(): Promise<NotificationAction | null> {
  if (!isTauri()) return null;
  try {
    const available = await native<NotificationStatus>("status");
    if (!available.supported) return null;
    return (await native<NotificationAction | null>("take_action")) || null;
  }
  catch (error) { reportDiag("notification", `读取通知入口失败：${String(error)}`); return null; }
}
export async function acknowledgeNotificationAction(action: NotificationAction): Promise<void> {
  try { await native("ack_action", { id: action.id, at: action.at }); }
  catch (error) { reportDiag("notification", `确认通知入口失败：${String(error)}`); }
}
export async function testStudyNotification(): Promise<boolean> {
  if (!isTauri()) return false;
  try { await native("test"); return true; }
  catch (error) { publish({ ...status, error: String(error) }); return false; }
}
