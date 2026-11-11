/**
 * 学习提醒底部抽屉（proto-parity · SHEETS.reminder，html:3014-3017 + .v2-reminder-time）：
 * 标题「给学习留一个小时间」+ 副文「每天一次，按自己的节奏来。」+ 学习时间 56px 大号时间输入
 * （22px 衬线）+ 状态说明行 + 三动作：「保存时间并开启提醒」primary /「只保存时间」outline /
 * （已开启时）「关闭学习提醒」。显式开启时请求系统权限并验证日程，成功才关闭抽屉。
 * 今日复习卡与完成页的提醒行共用本抽屉；既有 push 设置页（setRemind）不动。
 */
import { useEffect, useState } from "react";
import { actions, activeRepository, toast, useApp } from "../../store";
import { ReadingDrawer } from "../reading/Drawer";
import { enableStudyReminder, reconcileStudyNotifications, refreshNotificationStatus, useNotificationStatus } from "../../services/studyNotifications";
import { openAppSettings } from "../../services/device";
import { reminderTime } from "../../services/reminderPlan";

export function ReminderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const repository = activeRepository();
  const settings = useApp((s) => s.settings);
  const words = useApp((s) => s.vocab);
  const status = useNotificationStatus();
  const [time, setTime] = useState(settings.remindTime);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTime(settings.remindTime);
    void refreshNotificationStatus();
    const visible = () => { if (document.visibilityState === "visible") void refreshNotificationStatus(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [open, settings.remindTime]);

  async function saveDaily() {
    if (busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    setBusy(true);
    try {
      const next = { ...settings, remindTime: time, daily: true };
      if (!(await enableStudyReminder(next, words, () => activeRepository() === repository))) return;
      actions.setSettings({ remindTime: time, daily: true });
      const actual = reminderTime(next).map(value => String(value).padStart(2, "0")).join(":");
      toast(words.some(word => !word.paused) ? `每日 ${actual} 的系统提醒已开启` : "提醒已开启，收藏表达后会自动安排");
      onClose();
    } finally { setBusy(false); }
  }
  async function saveTimeOnly() {
    if (busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    setBusy(true);
    try {
      const result = await reconcileStudyNotifications({ ...settings, remindTime: time }, words, () => activeRepository() === repository);
      if (result.error || activeRepository() !== repository) return;
      actions.setSettings({ remindTime: time });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <ReadingDrawer open={open} onClose={onClose} label="学习提醒">
      <div className="sheet-title">给学习留一个小时间</div>
      <p className="v2-learning-caption">每天一次，按自己的节奏来。</p>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-reminder-time" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          学习时间
        </label>
        <input
          id="v2-reminder-time"
          className="input v2-reminder-time"
          type="time"
          value={time}
          onChange={(e) => {
            const v = e.target.value;
            if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) setTime(v);
          }}
          aria-label="学习时间"
        />
      </div>
      <p className="v2-learning-copy" role="status">{busy ? "正在保存系统提醒…" : status.error ? status.error : !status.supported ? "请在 iPhone 上设置系统提醒。" : status.permission !== "granted" ? "系统通知尚未允许，提醒无法送达。" : settings.daily ? "每日学习提醒已开启；使用 App 时不会弹出提醒。" : "暂未开启提醒，随时可以调整。"}</p>
      {status.permission === "denied" && <button className="btn-ghost" onClick={() => void openAppSettings().then(ok => { if (!ok) toast("请在系统设置中允许沉浸口语发送通知"); })}>打开系统通知设置</button>}
      <button className="btn" disabled={busy} style={{ width: "100%" }} onClick={() => void saveDaily()}>
        {status.permission === "prompt" ? "允许系统通知并保存时间" : "保存时间并开启提醒"}
      </button>
      <button className="btn-ghost v2-learning-secondary" disabled={busy} style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => void saveTimeOnly()}>
        只保存时间
      </button>
      {settings.daily && (
        <button
          className="btn-ghost v2-learning-secondary"
          disabled={busy}
          style={{ border: "1px solid var(--hairline-strong)" }}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            const result = await reconcileStudyNotifications({ ...settings, daily: false }, words, () => activeRepository() === repository);
            setBusy(false);
            if (!result.error && result.scheduled === 0 && activeRepository() === repository) {
              actions.setSettings({ daily: false });
              onClose();
            }
          }}
        >
          关闭学习提醒
        </button>
      )}
    </ReadingDrawer>
  );
}
