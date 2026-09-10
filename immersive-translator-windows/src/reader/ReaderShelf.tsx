/**
 * 左栏 240px（屏 A）：书架（带进度）＋ 生词本入口 ＋ 今日复习卡。
 */

import { IconBookOpen, IconPlus, IconTrash } from "../ui/icons";
import type { ArticleSummary } from "../core/readerTypes";

interface Props {
  articles: ArticleSummary[];
  activeId: string | null;
  dueNow: number;
  reviewedToday: number;
  streak: number;
  onSelect: (id: string) => void;
  onOpenReview: () => void;
  onDelete: (id: string) => void;
  onImportPaste: (text: string) => void;
}

export function ReaderShelf({
  articles,
  activeId,
  dueNow,
  reviewedToday,
  streak,
  onSelect,
  onOpenReview,
  onDelete,
  onImportPaste,
}: Props) {
  const todayTotal = reviewedToday + dueNow;

  function handleImport() {
    const text = window.prompt("粘贴英文文章（空行分段）：");
    if (text && text.trim()) onImportPaste(text);
  }

  return (
    <aside className="reader-shelf">
      <div className="reader-shelf-header">
        书架
        <button
          className="reader-tb-btn"
          style={{ width: 22, height: 22 }}
          onClick={handleImport}
          title="粘贴导入文章"
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
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div className="t" style={{ flex: 1 }}>
                {a.title}
              </div>
              <button
                className="reader-tb-btn"
                style={{ width: 20, height: 20, opacity: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`删除《${a.title}》？生词本不受影响。`)) onDelete(a.id);
                }}
                onMouseOver={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseOut={(e) => (e.currentTarget.style.opacity = "0")}
                title="删除文章"
              >
                <IconTrash size={11} />
              </button>
            </div>
            <div className="m">
              <span className="bar">
                <i style={{ width: `${Math.round(a.progress.percent)}%` }} />
              </span>
              <span>{Math.round(a.progress.percent)}%</span>
            </div>
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
        {todayTotal > 0 ? (
          <div className="reader-review-card">
            今日复习 <strong>{reviewedToday}</strong> / {todayTotal} · 连续打卡{" "}
            <strong>{streak}</strong> 天
          </div>
        ) : (
          <div className="reader-review-card">今日没有到期生词，去阅读里攒几个吧。</div>
        )}
      </div>
    </aside>
  );
}
