/**
 * 提醒卡（reminder 窗口）：每日到点由 Rust 调度弹出。双态（辅助增强二）：
 * - 到期词态：「N 个词今天到期」+ 开始复习 / 今天先不了。
 * - 阅读目标态：无到期词，但设了每日阅读目标、今天没读够、且书架上有书 →
 *   「还差 M 分钟 · 继续读《书名》第 N 章」+ 继续阅读（直达断点章）。
 * 60 秒无操作自动收起；「先不了」后今天不再弹（托盘角标保留）。
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  onReminderShow,
  openQuickReview,
  openReaderBook,
  reminderDueNow,
  takePendingReminder,
  type ReminderPayload,
} from "../lib/reminder";
import { trackEvent } from "../lib/telemetry";
import "./reminder.css";

const EMPTY_PAYLOAD: ReminderPayload = {
  due: 0,
  readGoalMin: 0,
  readSecondsToday: 0,
  book: null,
};

export function ReminderApp() {
  const [payload, setPayload] = useState<ReminderPayload | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const pending = await takePendingReminder();
        if (!active) return;
        if (pending) {
          setPayload(pending);
        } else {
          const n = await reminderDueNow();
          if (active) setPayload({ ...EMPTY_PAYLOAD, due: n });
        }
      } catch {
        if (active) setPayload(EMPTY_PAYLOAD);
      }
    })();
    const p = onReminderShow((due) =>
      setPayload((cur) => (cur ? { ...cur, due } : { ...EMPTY_PAYLOAD, due })),
    );
    return () => {
      active = false;
      void p.then((u) => u());
    };
  }, []);

  // 60 秒无操作自动收起（不打扰）
  useEffect(() => {
    const timer = window.setTimeout(() => void getCurrentWindow().close(), 60_000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void getCurrentWindow().close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const due = payload?.due ?? null;
  const book = payload?.book ?? null;
  const goalMin = payload?.readGoalMin ?? 0;
  const readSeconds = payload?.readSecondsToday ?? 0;
  // 阅读目标态：无到期词 + 设了目标 + 没读够 + 有书可回（调度端同口径筛选）。
  const goalState =
    due === 0 && goalMin > 0 && readSeconds < goalMin * 60 && book !== null
      ? {
          remainMin: Math.max(1, Math.ceil((goalMin * 60 - readSeconds) / 60)),
          book: book as NonNullable<typeof book>,
        }
      : null;
  const minutes = due !== null && due > 0 ? Math.max(1, Math.round((due * 50) / 60)) : 0;

  return (
    <div className="reminder-card" role="dialog" aria-label="复习提醒">
      <div className="reminder-head">
        <span className="reminder-logo" aria-hidden>
          读
        </span>
        <span className="reminder-app">沉浸阅读室</span>
        <button
          className="reminder-x"
          onClick={() => void getCurrentWindow().close()}
          title="关闭"
          aria-label="关闭提醒"
        >
          ✕
        </button>
      </div>
      <div className="reminder-msg">
        {due !== null && due > 0 ? (
          <>
            {due} 个词今天到期
            <small>大约 {minutes} 分钟 · 复习完托盘角标会消失</small>
          </>
        ) : goalState ? (
          <>
            还差 {goalState.remainMin} 分钟达成今日阅读目标
            <small>
              继续读《{goalState.book.bookTitle}》第 {goalState.book.chapterIdx + 1} 章
              （共 {goalState.book.chapterCount} 章）
            </small>
          </>
        ) : (
          <>
            今天没有到期的生词
            <small>去阅读里攒几个新词吧</small>
          </>
        )}
      </div>
      <div className="reminder-acts">
        <button className="reminder-btn" onClick={() => void getCurrentWindow().close()}>
          今天先不了
        </button>
        {due !== null && due > 0 ? (
          <button
            className="reminder-btn go"
            onClick={() => {
              void openQuickReview();
              void getCurrentWindow().close();
            }}
          >
            开始复习
          </button>
        ) : goalState ? (
          <button
            className="reminder-btn go"
            onClick={() => {
              trackEvent("reminder_continue_click", { bookId: goalState.book.bookId });
              void openReaderBook(goalState.book.bookId);
              void getCurrentWindow().close();
            }}
          >
            继续阅读
          </button>
        ) : (
          <button className="reminder-btn go" disabled onClick={() => void getCurrentWindow().close()}>
            开始复习
          </button>
        )}
      </div>
    </div>
  );
}
