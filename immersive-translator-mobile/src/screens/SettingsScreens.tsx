/** 移动端学习偏好与账号服务设置。 */
import { useEffect, useState } from "react";
import { actions, activeRepository, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav, Seg, Switch } from "../ui/kit";
import { useNav } from "../ui/nav";
import { enableStudyReminder, reconcileStudyNotifications, refreshNotificationStatus, testStudyNotification, useNotificationStatus } from "../services/studyNotifications";
import { openAppSettings } from "../services/device";
import { useCloud } from "../services/cloud";
import { ensureAccount } from "../services/authGate";
import { openAccountSheet } from "../components/account/accountGate";
import { VoicePreferences } from "../components/speaking/VoiceSettingsSheet";

export function SetModelScreen() {
  const nav = useNav();
  const { account } = useCloud();
  return <>
    <PNav title="账号服务" onBack={() => nav.pop()} />
    <div className="pbody">
      <div className="gcard" style={{ padding: 16 }}>
        <b>{account ? "已登录，可以使用翻译与查词" : "登录后使用翻译与查词"}</b>
        <p className="meta" style={{ marginTop: 8 }}>使用你的沉浸口语账号，当前内容与阅读位置会保留。</p>
        <button className="btn" style={{ marginTop: 14 }} onClick={() => account ? openAccountSheet() : void ensureAccount({ reason: "登录后使用翻译与查词，当前内容会保留。" })}>
          {account ? "查看账号与设置" : "登录账号"}
        </button>
      </div>
    </div>
  </>;
}

export function SetPrefScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  return (
    <>
      <PNav title="翻译偏好" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard" style={{ padding: "6px 14px" }}>
          <div className="aa-row" style={{ padding: "6px 0" }}>
            <span className="meta2" style={{ flex: "none" }}>
              方向
            </span>
            <Seg
              className="aa-seg"
              value={settings.dir}
              items={[
                ["e2c", "英 → 中"],
                ["c2e", "中 → 英"],
                ["auto", "自动"],
              ]}
              onChange={(dir) => actions.setSettings({ dir })}
            />
          </div>
          <div className="aa-row" style={{ padding: "6px 0" }}>
            <span className="meta2" style={{ flex: "none" }}>
              风格
            </span>
            <Seg
              className="aa-seg"
              value={settings.style}
              items={[
                ["plain", "简明"],
                ["faith", "忠实"],
                ["eleg", "信达雅"],
              ]}
              onChange={(style) => actions.setSettings({ style })}
            />
          </div>
        </div>

      </div>
    </>
  );
}

export function SetVoiceScreen() {
  const nav = useNav();
  return <>
    <PNav title="语音与朗读" onBack={() => nav.pop()} />
    <div className="pbody"><VoicePreferences /></div>
  </>;
}

export function SetRemindScreen() {
  const nav = useNav();
  const repository = activeRepository();
  const settings = useApp((s) => s.settings);
  const words = useApp((s) => s.vocab);
  const status = useNotificationStatus();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshNotificationStatus();
    const visible = () => { if (document.visibilityState === "visible") void refreshNotificationStatus(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  async function toggleReminder() {
    if (busy) return;
    setBusy(true);
    const isCurrent = () => activeRepository() === repository;
    try {
      if (settings.daily && status.permission === "granted") {
        const next = await reconcileStudyNotifications({ ...settings, daily: false }, words, isCurrent);
        if (!next.error && next.scheduled === 0 && isCurrent()) actions.setSettings({ daily: false });
      } else if (await enableStudyReminder(settings, words, isCurrent)) {
        actions.setSettings({ daily: true });
      }
    } finally { setBusy(false); }
  }
  const nextTime = status.nextAt ? new Date(status.nextAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const adjusted = settings.dnd && /^0[0-6]:/.test(settings.remindTime);
  const missingSchedule = settings.daily && status.permission === "granted" && words.some(word => !word.paused) && status.scheduled === 0;
  return (
    <>
      <PNav title="复习提醒" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard" aria-busy={busy}>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>每天提醒我复习</span>
              <span className="sub" style={{ display: "block" }}>每天在选好的时间，提醒你回顾收藏过的表达</span>
            </span>
            <Switch on={settings.daily && status.permission === "granted"} onToggle={() => void toggleReminder()} />
          </div>
          <div className="frow">
            <span className="grow">提醒时间</span>
            <input type="time" value={settings.remindTime}
              onChange={event => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) actions.setSettings({ remindTime: event.target.value }); }}
              style={{ fontSize: 17, fontFamily: "var(--font-mono)", background: "none", border: "none", textAlign: "right", color: "var(--ink)" }} aria-label="提醒时间" />
          </div>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>免打扰时段</span>
              <span className="sub" style={{ display: "block" }}>00:00 – 07:00 的提醒顺延至 07:00</span>
            </span>
            <Switch on={settings.dnd} onToggle={() => actions.setSettings({ dnd: !settings.dnd })} />
          </div>
        </div>
        <div role="status" className="meta" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {busy ? "正在更新系统提醒…" : status.error ? status.error : !status.supported ? "此预览环境不支持系统提醒，请在 iPhone 上设置。" : status.permission !== "granted" ? "系统通知尚未允许，提醒无法送达。" : !settings.daily ? "复习提醒已关闭。" : nextTime ? `下一次提醒：${nextTime}（手机当地时间）` : missingSchedule ? "每日提醒尚未保存，请重试。" : words.length ? "收藏的表达已暂停复习，恢复后会自动安排每日提醒。" : "还没有收藏的表达，收藏后会自动安排每日提醒。"}
          {adjusted && settings.daily && <div>免打扰已开启，实际提醒时间为 07:00。</div>}
        </div>
        {status.supported && status.permission === "prompt" && <button className="btn-ghost" disabled={busy} style={{ marginTop: 14 }} onClick={() => void toggleReminder()}>允许系统通知</button>}
        {status.supported && status.permission === "denied" && <button className="btn-ghost" style={{ marginTop: 14 }} onClick={() => void openAppSettings().then(ok => { if (!ok) toast("请在系统设置中允许沉浸口语发送通知"); })}>打开系统通知设置</button>}
        {(status.error || missingSchedule) && <button className="btn-ghost" disabled={busy} style={{ marginTop: 14 }} onClick={() => void reconcileStudyNotifications(settings, words, () => activeRepository() === repository)}>重试保存提醒</button>}
        <div className="meta" style={{ marginTop: 12, lineHeight: 1.7 }}>
          这是每日学习提醒，不是即时到期警报。关闭 App 也能持续收到；使用 App 时不会弹出复习提示。点系统通知即可开始复习。
        </div>
        <button className="btn-ghost" disabled={busy || status.permission !== "granted"} style={{ marginTop: 14 }} onClick={() => void testStudyNotification().then(ok => { if (ok) toast("请离开 App，10 秒后查看系统通知"); })}>测试系统通知</button>
      </div>
    </>
  );
}

export function SetLookScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  return (
    <>
      <PNav title="外观" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard" role="radiogroup" aria-label="主题">
          {(
            [
              ["system", "跟随系统"],
              ["light", "浅色 · 暖纸"],
              ["dark", "深色 · 暖炭"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="frow" role="radio" aria-checked={settings.themePref === v} onClick={() => actions.setThemePref(v)}>
              {/* U-28：对勾墨蓝（定稿 §3.18）+ aria-checked */}
              <span className="ico" style={{ width: 22, color: "var(--accent)" }}>
                {settings.themePref === v && <Icon name="check" size={17} />}
              </span>
              <span className="grow">{label}</span>
            </button>
          ))}
        </div>
        {/* U-15②（WCAG 1.4.4）：全局正文缩放档，写 --fs-scale 到 :root（store.applyFsDom）；
            与移除 viewport 缩放禁用同批落地，1.4.4 才闭合 */}
        <div className="gcard" style={{ marginTop: 14, padding: "6px 14px" }}>
          <div className="aa-row" style={{ padding: "8px 0" }}>
            <span className="meta2" style={{ flex: "none" }}>
              字号
            </span>
            <Seg
              className="aa-seg"
              ariaLabel="全局字号"
              value={String(settings.fsScale)}
              items={[
                ["1", "标准"],
                ["1.15", "大"],
                ["1.3", "特大"],
              ] as [string, string][]}
              onChange={(v) => actions.setSettings({ fsScale: Number(v) })}
            />
          </div>
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          字号影响正文与列表文字；阅读页里还有「纸色 / 暖黄 / 纯黑」三种阅读主题——阅读主题仅影响阅读器，不会改变应用的浅色或深色外观。
        </div>
      </div>
    </>
  );
}
