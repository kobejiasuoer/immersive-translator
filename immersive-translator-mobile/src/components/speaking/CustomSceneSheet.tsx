/**
 * 自定义场景抽屉（speaking-parity · 原型 SHEETS.customScene，html:2671-2674）。
 * 名称 ≤32 + 想说清楚什么 ≤120；校验通过后由宿主页存 customScenes 并按
 * 「目标 / 细节 / 问题」三步开练习（回答 ≥4 词的校验在练习发送时执行）。
 * 草稿只在本组件打开期间保留，取消即弃。
 * 视觉对齐原型：17px 粗体标题 + 说明 + hairline 分隔 + 白底描边 .inp 输入（html:166-170）。
 */
import { useEffect, useState } from "react";
import { ReadingDrawer } from "../reading/Drawer";

export function CustomSceneSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** 校验通过后回调；持久化与开练习由宿主页完成。 */
  onSave: (scene: { title: string; goal: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setTitle(""); setGoal(""); setError(""); } }, [open]);
  const submit = () => {
    const name = title.trim(), wish = goal.trim();
    if (!name || !wish) { setError("给场景起个名字，再写一句想说清楚的内容。"); return; }
    if (name.length > 32 || wish.length > 120) { setError("场景名称不超过 32 字，想说清楚的内容不超过 120 字。"); return; }
    setError("");
    onSave({ title: name, goal: wish });
  };
  return (
    <ReadingDrawer open={open} onClose={onClose} label="创建我的场景">
      <div className="sp-sheet-head">
        <h3>创建我的场景</h3>
        <p className="sp-sheet-copy">写一个你想开口的场合，练习会按“目标、细节、问题”分三步进行。</p>
      </div>
      <div className="sp-sheet-body">
        <label htmlFor="custom-scene-title" style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>场景名称</label>
        <input id="custom-scene-title" className="input v2-inp" value={title} maxLength={32} placeholder="例如：向同事介绍一个方案" onChange={e => setTitle(e.target.value)} />
        <label htmlFor="custom-scene-goal" style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>我想说清楚什么</label>
        <textarea id="custom-scene-goal" className="input v2-inp" rows={3} maxLength={120} value={goal} placeholder="例如：方案解决什么问题，下一步怎么做" onChange={e => setGoal(e.target.value)} />
        {error && <p role="alert" style={{ color: "var(--bad,#b4423a)", fontSize: 12, lineHeight: 1.55, margin: "7px 0" }}>{error}</p>}
        <button className="btn" style={{ marginTop: 6 }} onClick={submit}>保存场景，开始练</button>
      </div>
    </ReadingDrawer>
  );
}
