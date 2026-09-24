/**
 * 书目录面板（屏③）：这本书有哪些章、我从哪继续、每章多少词多少生词。
 * 从阅读页章节栏「目录」按钮打开；点章即跳。
 */

import { useEffect } from "react";
import type { BookMeta } from "../core/readerTypes";
import { bookOverallPercent } from "../core/readerTypes";

interface Props {
  book: BookMeta;
  currentChapterId: string | null;
  /** 每章已收藏生词数（按 source.articleId 现算）。 */
  vocabCountByChapter: Record<string, number>;
  onSelect: (chapterId: string) => void;
  onClose: () => void;
}

export function BookTocModal({
  book,
  currentChapterId,
  vocabCountByChapter,
  onSelect,
  onClose,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const percent = Math.round(bookOverallPercent(book));
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="book-toc-modal" role="dialog" aria-modal="true" aria-label={`《${book.title}》目录`}>
        <div className="book-toc-head">
          <div className="book-toc-cover" aria-hidden>
            {book.cover ? (
              <img src={book.cover} alt="" />
            ) : (
              <span>{book.title.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="grow">
            <h3 className="serif">{book.title}</h3>
            <p className="book-toc-meta">
              {book.author ? `${book.author} · ` : ""}
              {book.chapters.length} 章 · 总进度 {percent}%
            </p>
            <p className="book-toc-radar">
              考研词 {book.radar.kaoyan} · 四级词 {book.radar.cet4} · 六级词 {book.radar.cet6}
            </p>
          </div>
          <button className="reader-tb-btn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="book-toc-list">
          {book.chapters.map((c, i) => {
            const vocab = vocabCountByChapter[c.id] ?? 0;
            const current = c.id === currentChapterId;
            return (
              <div
                key={c.id}
                className={`book-toc-row${current ? " current" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(c.id);
                }}
              >
                <span className="no">{i + 1}</span>
                <span className="t serif" title={c.title}>
                  {c.title}
                </span>
                <span className="meta">
                  {c.wordCount.toLocaleString()} 词
                  {vocab > 0 ? ` · ${vocab} 生词` : ""}
                  {current ? " · 当前" : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
