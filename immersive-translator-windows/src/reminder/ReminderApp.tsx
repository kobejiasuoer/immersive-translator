/**
 * 提醒卡（reminder 窗口）：每日到点由 Rust 调度弹出。
 * 右下角置顶小卡：「N 个词今天到期」+ 开始复习 / 今天先不了。
 * 60 秒无操作自动收起；「先不了」后今天不再弹（托盘角标保留）。
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  onReminderShow,
  openQuickReview,
  reminderDueNow,
  takePendingReminder,
} from "../lib/reminder";
import "./reminder.css";

export function ReminderApp() {
  const [due, setDue] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const pending = await takePendingReminder();
        if (!active) return;
        if (pending !== null && pending > 0) {
          setDue(pending);
        } else {
          const n = await reminderDueNow();
          if (active) setDue(n);
        }
      } catch {
        if (active) setDue(0);
      }
    })();
    const p = onReminderShow((n) => setDue(n));
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
        <button
          className="reminder-btn go"
          disabled={due === null || due === 0}
          onClick={() => {
            void openQuickReview();
            void getCurrentWindow().close();
          }}
        >
          开始复习
        </button>
      </div>
    </div>
  );
}
