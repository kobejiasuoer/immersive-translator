/**
 * 验证码重发 60s 倒计时（docs/windows-auth-design-2026-09-26.md D3/D10/P14）。
 *
 * - 倒计时按邮箱持久化到 localStorage（key immersive-auth-otp-last-sent，
 *   值 { [email]: unixMs }，容量截断至最近 10 条）：login 窗完成即 close，
 *   重开后恢复剩余倒计时，避免在服务端冷却期内重复点「获取验证码」却等不到邮件；
 * - 纯函数（parse/write/remaining）与 React hook 解耦，vitest fake timers 直测。
 */
import { useCallback, useEffect, useState } from "react";

/** 冷却时长（秒），与服务端同邮箱发信冷却对齐。 */
export const OTP_COOLDOWN_SECS = 60;

/** localStorage 键。 */
export const OTP_LAST_SENT_KEY = "immersive-auth-otp-last-sent";

/** 每邮箱时间戳映射最多保留条数（防无限增长）。 */
export const OTP_LAST_SENT_MAX_EMAILS = 10;

/** email → 上次发送 unix 毫秒。 */
export type OtpLastSentMap = Record<string, number>;

/** 宽松解析持久化映射：坏 JSON / 非法条目全部丢弃。 */
export function parseLastSentMap(raw: string | null): OtpLastSentMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: OtpLastSentMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) map[k] = v;
    }
    return map;
  } catch {
    return {};
  }
}

/** 剩余冷却秒数（0..OTP_COOLDOWN_SECS），向上取整保证 UI 显示不早归零。 */
export function remainingSeconds(map: OtpLastSentMap, email: string, nowMs: number): number {
  const sentAt = map[email];
  if (!sentAt) return 0;
  const elapsedSec = (nowMs - sentAt) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec >= OTP_COOLDOWN_SECS) return 0;
  return Math.min(OTP_COOLDOWN_SECS, Math.max(1, Math.ceil(OTP_COOLDOWN_SECS - elapsedSec)));
}

/**
 * 记录一次发送并持久化（更新该邮箱时间戳，按最近使用截断至 10 条）。
 * 写失败（隐私模式 / 配额）静默忽略：倒计时退化为本次会话内有效。
 */
export function writeLastSent(
  email: string,
  sentAtMs: number,
  storage: Pick<Storage, "getItem" | "setItem">,
): OtpLastSentMap {
  const next: OtpLastSentMap = {
    ...parseLastSentMap(storage.getItem(OTP_LAST_SENT_KEY)),
    [email]: sentAtMs,
  };
  const trimmed = Object.entries(next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, OTP_LAST_SENT_MAX_EMAILS);
  try {
    storage.setItem(OTP_LAST_SENT_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* ignore */
  }
  return Object.fromEntries(trimmed);
}

/** 挂载 / 邮箱变化时从 localStorage 读剩余（D10 恢复）。 */
function remainingFromStorage(email: string): number {
  try {
    return remainingSeconds(parseLastSentMap(localStorage.getItem(OTP_LAST_SENT_KEY)), email, Date.now());
  } catch {
    return 0;
  }
}

export interface UseResendCooldown {
  /** 剩余秒数；>0 时「重新发送」应禁用并显示秒数。 */
  remaining: number;
  /** 发送成功后调用：记录时间戳并把倒计时置满。 */
  start: () => void;
}

/** 60s 重发倒计时 hook（fake-timer 友好：每秒 -1，归零停表）。 */
export function useResendCooldown(email: string): UseResendCooldown {
  const [remaining, setRemaining] = useState(() => remainingFromStorage(email));

  // 换邮箱（「换一个邮箱」返回）时按新邮箱恢复剩余。
  useEffect(() => {
    setRemaining(remainingFromStorage(email));
  }, [email]);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remaining > 0]);

  const start = useCallback(() => {
    try {
      writeLastSent(email, Date.now(), localStorage);
    } catch {
      /* ignore */
    }
    setRemaining(OTP_COOLDOWN_SECS);
  }, [email]);

  return { remaining, start };
}
