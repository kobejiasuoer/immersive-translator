/**
 * 左栏 240px（屏 A）：书架（带进度）＋ 生词本/口语/笔记库入口 ＋ 今日复习卡。
 */

import { IconBookOpen, IconMic, IconNotebook, IconPlus, IconTrash } from "../ui/icons";
import type { ArticleSummary } from "../core/readerTypes";
import { TodayCard } from "./TodayCard";

interface Props {
  articles: ArticleSummary[];
  activeId: string | null;
  dueNow: number;
  reviewedToday: number;
  streak: number;
  /** 还没整理进任何笔记的生词数（笔记库入口角标：该整理了）。 */
  newToNote: number;
  onSelect: (id: string) => void;
  onOpenReview: () => void;
  onOpenSpeak: () => void;
  onOpenNotes: () => void;
  onDelete: (id: string) => void;
  onOpenImport: () => void;
}

export function ReaderShelf({
  articles,
  activeId,
  dueNow,
  reviewedToday,
  streak,
  newToNote,
  onSelect,
  onOpenReview,
  onOpenSpeak,
  onOpenNotes,
  onDelete,
  onOpenImport,
}: Props) {
  return (
    <aside className="reader-shelf">
      <div className="reader-shelf-header">
        书架
        <button
          className="reader-tb-btn"
          style={{ width: 22, height: 22 }}
          onClick={onOpenImport}
          title="导入文章（粘贴 / 打开 .txt）"
        >
          <IconPlus size={13} />
        </button>
      </div>
      <div className="reader-shelf-list">
        {articles.length === 0 && (
          <div className="reader-empty-shelf">
            还没有文章。
            <br />
            在网页或文档里选中文字，点浮窗上的「发送到阅读室」，或按
            <span className="kbd">Ctrl</span>+<span className="kbd">Shift</span>+
            <span className="kbd">R</span>。
          </div>
        )}
        {articles.map((a) => (
          <div
            key={a.id}
            className={`reader-shelf-item${a.id === activeId ? " active" : ""}`}
            onClick={() => onSelect(a.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(a.id);
            }}
          >
            <span className="t">{a.title}</span>
            <span className="dots" aria-hidden />
            <span className="pct">{Math.round(a.progress.percent)}%</span>
            <button
              className="del"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`删除《${a.title}》？生词本不受影响。`)) onDelete(a.id);
              }}
              title="删除文章"
            >
              <IconTrash size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="reader-shelf-footer">
        <div
          className="reader-shelf-nav"
          onClick={onOpenReview}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenReview();
          }}
        >
          <IconBookOpen size={15} />
          生词本复习
          {dueNow > 0 && <span className="badge">{dueNow}</span>}
        </div>
        <div
          className="reader-shelf-nav"
          onClick={onOpenSpeak}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenSpeak();
          }}
          title="选个场景开口说：你说话，AI 用英语接"
        >
          <IconMic size={15} />
          口语陪练
        </div>
        <div
          className="reader-shelf-nav"
          onClick={onOpenNotes}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenNotes();
          }}
          title="复习笔记自动存在这里，可回看与 AI 复盘"
        >
          <IconNotebook size={15} />
          笔记库
          {newToNote > 0 && <span className="badge soft">{newToNote}</span>}
        </div>
        <TodayCard reviewedToday={reviewedToday} dueNow={dueNow} streak={streak} onGoReview={onOpenReview} />
      </div>
    </aside>
  );
}
