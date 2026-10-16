/**
 * 弹出式书架浮层（v0.8 Phase 1，对齐原型 .floating-folio-sheet）：
 * 由顶部导航岛左上「书架 · 书名」触发，挂在 .reader-root 顶层。
 * 当前书卡（.folio-book-hero：书名 / 作者 · 第 N/M 章 · 进度条，点击继续读）
 * + 短文行（标题 + 百分比）。生词本 / 口语 / 笔记入口与今日卡已移交
 * 顶部导航岛与首页书架（ShelfPage）。
 * 删除契约不变：删书 = 章文章与进度全删、生词保留（confirm 文案原样）。
 */

import { IconTrash } from "../ui/icons";
import { useEscapeClose } from "./useEscapeClose";
import type { ArticleSummary, BookMeta } from "../core/readerTypes";
import { bookChapterIndexOf, bookOverallPercent } from "../core/readerTypes";

interface Props {
  articles: ArticleSummary[];
  /** 书架上的书（最近阅读倒序；当前书卡取 activeBookId 命中或最近一本）。 */
  books: BookMeta[];
  /** 当前打开文章所属书（书卡判定）。 */
  activeBookId: string | null;
  onSelect: (id: string) => void;
  /** 当前书卡点击 → 打开断点章。 */
  onContinueBook: (book: BookMeta) => void;
  onDelete: (id: string) => void;
  onDeleteBook: (bookId: string) => void;
  onOpenImport: () => void;
  /** 选中书目 / 打开导入后由本组件请求收起浮层（删除后保持打开）。 */
  onClose: () => void;
}

export function FolioSheet({
  articles,
  books,
  activeBookId,
  onSelect,
  onContinueBook,
  onDelete,
  onDeleteBook,
  onOpenImport,
  onClose,
}: Props) {
  const currentBook = books.find((b) => b.id === activeBookId) ?? books[0] ?? null;

  // Esc 关闭书架浮层（键盘用户不必先Tab 到关闭键）。
  useEscapeClose(onClose);

  return (
    <aside
      className="floating-folio-sheet open"
      role="dialog"
      aria-modal="true"
      aria-label="我的书架"
    >
      <div className="folio-sheet-head">
        <span className="folio-sheet-title">我的书架</span>
        <button
          type="button"
          className="folio-import-btn"
          onClick={() => {
            onOpenImport();
            onClose();
          }}
          title="导入文章 / 整本 EPUB"
        >
          ＋ 导入文件
        </button>
      </div>

      {currentBook && (() => {
        const b = currentBook;
        const chapterIdx = bookChapterIndexOf(b, b.progress.chapterId);
        const percent = Math.round(bookOverallPercent(b));
        return (
          <div
            className="folio-book-hero"
            role="button"
            tabIndex={0}
            onClick={() => {
              onContinueBook(b);
              onClose();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onContinueBook(b);
                onClose();
              }
            }}
            title="继续读：打开这本书的断点章"
          >
            <div className="folio-hero-title" title={b.title}>
              {b.title}
            </div>
            <div className="folio-hero-meta">
              {b.author ? `${b.author} · ` : ""}第 {Math.min(chapterIdx + 1, b.chapters.length)}/
              {b.chapters.length} 章 · 已读 {percent}%
            </div>
            <div className="folio-hero-bar">
              <i style={{ width: `${percent}%` }} />
            </div>
            <button
              type="button"
              className="folio-del"
              onClick={(e) => {
                e.stopPropagation();
                if (
                  window.confirm(
                    `删除《${b.title}》？将删除全部 ${b.chapters.length} 章内容与这本书的阅读进度，不可恢复；生词本不受影响。`,
                  )
                )
                  onDeleteBook(b.id);
              }}
              title="删除这本书（章文章与进度删除，生词保留）"
              aria-label={`删除《${b.title}》`}
            >
              <IconTrash size={11} />
            </button>
          </div>
        );
      })()}

      {articles.length > 0 && <div className="folio-section-label">短文</div>}
      {articles.map((a) => {
        const pct = Math.round(a.progress.percent);
        const done = pct >= 100;
        return (
          <div
            key={a.id}
            className="folio-article-row"
            onClick={() => {
              onSelect(a.id);
              onClose();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSelect(a.id);
                onClose();
              }
            }}
          >
            <span className="folio-row-title" title={a.title}>
              {a.title}
            </span>
            <span className={`folio-row-pct${done ? " done" : ""}`}>{done ? "读完" : `${pct}%`}</span>
            <button
              type="button"
              className="folio-del"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`删除《${a.title}》？生词本不受影响。`)) onDelete(a.id);
              }}
              title="删除文章"
              aria-label={`删除《${a.title}》`}
            >
              <IconTrash size={11} />
            </button>
          </div>
        );
      })}

      {articles.length === 0 && !currentBook && (
        <div className="folio-empty-hint">
          还没有书或短文。点「＋ 导入文件」，或在网页/文档里选中文字，按 Ctrl+Shift+R 送进阅读室。
        </div>
      )}
    </aside>
  );
}
