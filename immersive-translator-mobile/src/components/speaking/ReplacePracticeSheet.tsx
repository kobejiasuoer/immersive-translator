/**
 * 练习选择抽屉（speaking-parity · 原型 SHEETS.replacePractice，html:2662-2665）。
 * 已有未完成练习时再开新一轮的三选：继续上次 / 结束旧的开始新的（旧练习已有作答时
 * 由宿主页先静默归档为复盘再开新）/ 稍后再决定（绿色文字链）。
 */
import { ReadingDrawer } from "../reading/Drawer";

export function ReplacePracticeSheet({
  open,
  onClose,
  title,
  answered,
  onContinue,
  onReplace,
}: {
  open: boolean;
  onClose: () => void;
  /** 旧练习标题。 */
  title: string;
  /** 旧练习已回答步数（决定「结束旧的」的文案口径）。 */
  answered: number;
  onContinue: () => void;
  onReplace: () => void;
}) {
  return (
    <ReadingDrawer open={open} onClose={onClose} label="练习选择">
      <div className="sp-sheet-head">
        <h3>上次的练习还在</h3>
        <p className="sp-sheet-copy">{title}。已回答的内容和草稿都保留了。</p>
      </div>
      <div className="sp-sheet-body">
        <button className="btn" onClick={onContinue}>继续上次练习</button>
        <button className="btn-ghost" style={{ marginTop: 10 }} onClick={onReplace}>
          结束上次，开始新的练习
        </button>
        {answered ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.7, marginTop: 6 }}>
            旧练习已有作答，会先静默归档为复盘记录，再开始新的一轮。
          </p>
        ) : null}
        <button className="v2-sp-text-action" onClick={onClose}>稍后再决定</button>
      </div>
    </ReadingDrawer>
  );
}
