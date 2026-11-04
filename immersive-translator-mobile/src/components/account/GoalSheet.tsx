/**
 * 学习方向页（proto-parity-2026-11-01，对照原型 VIEWS.goal html:1979-1984）：
 * 首启完成、新账号登录后与账号页「学习方向」入口统一为原型推入页——
 * nhead（返回 chevron + 居中「先选一个方向/随时可以在账号里调整」+ 右上「跳过」）
 * + 三张方向卡（34px 圆形图标，选中 accent-soft 底 + 绿色 check，未选中描边白卡 + chevron）
 * + inline-note 描边容器。原型主按钮按来源切换：goalOrigin 有值（账号页进入）→「保存方向」，
 * 引导流 →「开始读第一篇」（html:1983）。
 * · 「跳过」与主按钮行为一致——原型中二者同为 v2FinishGoal；这里同样都用当前所选方向收尾，
 *   不存在死路。返回 chevron 仅关页不落库（引导流落到今天页；账号来源关闭后回到其抽屉）。
 * · 文案与顺序按原型：日常表达 → 工作沟通 → 考试阅读；settings.goal 旧持久值
 *   （读外刊与原版书/职场沟通/日常交流）按描述对应映射到新方向，默认值随原型取「日常表达」。
 * · hint「第一篇从 5 个短句开始」按原型完整恢复（与 welcome 入门卡口径一致）。
 * · 账号来源：账号面板已改为底部抽屉（zIndex 118），本推入页抬到 126 盖过抽屉；
 *   关闭/保存后抽屉仍在原位（对齐原型「goal 视图压在账号抽屉上」的层级）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { actions, flushPersist, getState } from "../../store";
import { closeGoal, useGoalSource } from "./goalGate";
import { Icon } from "../../ui/icons";

const GOAL_OPTIONS: { label: string; desc: string; icon: string }[] = [
  { label: "日常表达", desc: "读生活短文，说清自己的想法", icon: "bookopen" },
  { label: "工作沟通", desc: "读资讯与邮件，练表达和讨论", icon: "win" },
  { label: "考试阅读", desc: "读原版篇章，积累词汇与长句", icon: "target" },
];
/* 旧持久值 → 新方向（按原型三方向的描述对应）；不在表内的未知值回退首项（原型默认 daily） */
const GOAL_LEGACY: Record<string, string> = { 读外刊与原版书: "考试阅读", 职场沟通: "工作沟通", 日常交流: "日常表达" };
function normalizeGoal(value: string): string {
  if (GOAL_LEGACY[value]) return GOAL_LEGACY[value];
  return GOAL_OPTIONS.some(option => option.label === value) ? value : GOAL_OPTIONS[0].label;
}

export default function GoalSheetHost() {
  const source = useGoalSource();
  const [pick, setPick] = useState(() => normalizeGoal(getState().settings.goal));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [entered, setEntered] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  /* 每次打开重取当前方向（来源快照恢复：关闭期间 settings.goal 可能已变化） */
  useEffect(() => {
    if (!source) { setEntered(false); return; }
    setPick(normalizeGoal(getState().settings.goal));
    setError("");
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(raf);
  }, [source]);
  useEffect(() => {
    if (!source) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      const title = root.current?.querySelector<HTMLElement>(".nt h1"); /* 推入页对位 App U-17：聚焦页标题 */
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
      else root.current?.querySelector<HTMLElement>("input,button")?.focus();
    }, 0);
    return () => { clearTimeout(timer); previous?.focus({ preventScroll: true }); };
  }, [source]);
  if (!source) return null;
  async function finish() {
    setBusy(true); setError("");
    try { actions.setSettings({ goal: pick }); await flushPersist(); closeGoal(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  function trap(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])];
    if (!items.length) return;
    if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
  }
  const cards = GOAL_OPTIONS.map(option => (
    <button type="button" key={option.label} className={`ob-goal-option${pick === option.label ? " on" : ""}`} aria-pressed={pick === option.label} onClick={() => setPick(option.label)}>
      <span className="ob-goal-icon"><Icon name={option.icon} size={18} /></span>
      <span><b>{option.label}</b><small>{option.desc}</small></span>
      <span className="ob-goal-state"><Icon name={pick === option.label ? "check" : "right"} size={18} /></span>
    </button>
  ));
  const note = <p className="ob-note">第一篇从 5 个短句开始。读得快慢，都没关系。</p>;
  return createPortal(
    <div
      className={`push${entered ? " in" : ""}`}
      data-view="goal"
      role="dialog"
      aria-modal="true"
      aria-label="学习方向"
      ref={root}
      onKeyDown={trap}
      /* 账号来源：盖过账号抽屉（zIndex 118）；其余来源沿用 push 默认层（40） */
      style={source === "account" ? { zIndex: 126 } : undefined}
    >
      <header className="learning-head nhead ob-nhead">
        <button className="tlink" aria-label="返回" onClick={closeGoal}><Icon name="left" size={20} /></button>
        <div className="nt"><h1>先选一个方向</h1><small>随时可以在账号里调整</small></div>
        <button className="tlink" disabled={busy} onClick={() => void finish()}>跳过</button>
      </header>
      <main className="ob-page-body ob-goal-body">
        <div className="ob-goal-intro">
          <span className="ob-eyebrow">让下一篇更适合你</span>
          <h2>你现在更想练什么？</h2>
          <p>先选一个就好，不影响体验其他内容。</p>
        </div>
        <div className="ob-goal-options">{cards}</div>
        {note}
        <button className="btn" disabled={busy} onClick={() => void finish()}>{source === "account" ? "保存方向" : "开始读第一篇"}</button>
        {error && <p role="alert" className="v2-form-error"><Icon name="info" size={14} />{error}</p>}
      </main>
    </div>,
    document.body,
  );
}
