/**
 * 资讯预览抽屉（reading-parity · 原型 SHEETS.feedPreview，html:2065-2068）。
 * 头部 = UI 粗体源名 + 频次行（「每天一篇 · 约 3 分钟」口径）+ hairline；
 * 样例卡 = 独立 tag「样例 · 约 N 分钟」+ 衬线章题 + 前 2 句干净正文（精选源 docIds[0]）；
 * 底部按钮次序对齐原型：「完整读这篇」outline 在上、「订阅，并开始读这篇」primary 在下。
 * 样例来自产品随包精选目录（core/curated.ts，原型 docIds[0] 直出），订阅/取消走 store 精选动作。
 */
import { Icon } from "../../ui/icons";
import { ReadingDrawer } from "./Drawer";

export interface FeedSample {
  feedTitle: string;
  /** 精选源 id（订阅/取消订阅动作用）。 */
  feedId?: string;
  /** 样例文档 id（完整读这篇 / 订阅后打开用）。 */
  docId?: string;
  note: string;
  /** 频次元信息（如「每天一篇 · 约 3 分钟」）。 */
  frequency?: string;
  entryTitle: string;
  /** 样例预计阅读时长（分钟，随精选文档内容给出）。 */
  minutes?: number;
  sentences: string[];
}

export function FeedPreviewSheet({
  open,
  onClose,
  sample,
  subscribed,
  busy,
  onSubscribe,
  onUnsubscribe,
  onReadFull,
}: {
  open: boolean;
  onClose: () => void;
  sample: FeedSample | null;
  subscribed: boolean;
  /** 订阅/取消进行中（按钮禁用）。 */
  busy: boolean;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  /** 完整读这篇：走既有「查看文章」内联流程。 */
  onReadFull: () => void;
}) {
  if (!sample) return null;
  return (
    <ReadingDrawer open={open} onClose={onClose} label="资讯预览">
      <div className="sheet-title plain">{sample.feedTitle}</div>
      {sample.frequency && <p className="sheet-note" style={{ margin: "2px 0 10px" }}>{sample.frequency}</p>}
      <p className="v2-feed-description">{sample.note}</p>
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 12, padding: 14, margin: "0 0 12px" }}>
        <span className="learning-tag" style={{ fontSize: 10.5 }}>
          样例{sample.minutes ? ` · 约 ${sample.minutes} 分钟` : ""}
        </span>
        <p className="serif" style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.5, margin: "9px 0 0", overflowWrap: "anywhere" }}>
          {sample.entryTitle}
        </p>
        {sample.sentences.map((s, i) => (
          <p key={i} className="serif" style={{ fontSize: 15, lineHeight: 1.85, margin: "8px 0 0", overflowWrap: "anywhere" }} lang="en">
            {s}
          </p>
        ))}
        {!sample.sentences.length && <p className="meta" style={{ marginTop: 8 }}>这个来源暂没有可预览的摘要。</p>}
      </div>
      {sample.sentences.length > 0 && (
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={busy} onClick={onReadFull}>
          <Icon name="bookopen" size={15} />
          完整读这篇
        </button>
      )}
      {subscribed ? (
        <>
          <p className="meta" style={{ lineHeight: 1.8, margin: "10px 0" }}>
            这组精选短文已加入。取消收录后，已保存的文章仍会保留。
          </p>
          <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={busy} onClick={onUnsubscribe}>
            取消收录
          </button>
        </>
      ) : (
        <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={onSubscribe}>
          <Icon name="chat" size={15} />
          加入这组短文并阅读
        </button>
      )}
    </ReadingDrawer>
  );
}
