/**
 * 左栏 240px（屏 A）：书架（书/短文两区）＋ 生词本/口语/笔记库入口 ＋ 今日卡。
 * 书区（整本书阅读室）：书卡 = 封面 + 书名 + 进度 + 章节推进；删除书契约 =
 * 「删书卡与全部章文章（进度不可恢复），生词一律保留」。
 */

import { IconBookOpen, IconMic, IconNotebook, IconPlus, IconTrash } from "../ui/icons";
import type { ArticleSummary, BookMeta } from "../core/readerTypes";
import { bookChapterIndexOf, bookOverallPercent } from "../core/readerTypes";
import { TodayCard } from "./TodayCard";

interface Props {
  articles: ArticleSummary[];
  /** 书架上的书（最近阅读倒序）。 */
  books: BookMeta[];
  activeId: string | null;
  /** 当前打开文章所属书（书卡高亮）。 */
  activeBookId: string | null;
  dueNow: number;
  reviewedToday: number;
  streak: number;
  /** 还没整理进任何笔记的生词数（笔记库入口角标：该整理了）。 */
  newToNote: number;
  /** 今日已读分钟数（阅读目标追踪，goalMin>0 时显示）。 */
  readMinutesToday?: number;
  readGoalMin?: number;
  onSelect: (id: string) => void;
  /** 书卡「继续读」→ 打开断点章。 */
  onContinueBook: (book: BookMeta) => void;
  onOpenReview: () => void;
  onOpenSpeak: () => void;
  onOpenNotes: () => void;
  onDelete: (id: string) => void;
  onDeleteBook: (bookId: string) => void;
  onOpenImport: () => void;
}

export function ReaderShelf({
  articles,
  books,
  activeId,
  activeBookId,
  dueNow,
  reviewedToday,
  streak,
  newToNote,
  readMinutesToday,
  readGoalMin,
  onSelect,
  onContinueBook,
  onOpenReview,
  onOpenSpeak,
  onOpenNotes,
  onDelete,
  onDeleteBook,
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
          title="导入文章 / 整本 EPUB"
        >
          <IconPlus size={13} />
        </button>
      </div>
      <div className="reader-shelf-list">
        {books.length > 0 && (
          <div className="reader-books">
            {books.map((b) => {
              const chapterIdx = bookChapterIndexOf(b, b.progress.chapterId);
              const percent = Math.round(bookOverallPercent(b));
              return (
                <div
                  key={b.id}
                  className={`reader-book-card${b.id === activeBookId ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onContinueBook(b)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onContinueBook(b);
                  }}
                >
                  <div className="reader-book-cover" aria-hidden>
                    {b.cover ? (
                      <img src={b.cover} alt="" />
                    ) : (
                      <span>{b.title.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="reader-book-main">
                    <span className="t serif" title={b.title}>
                      {b.title}
                    </span>
                    <span className="reader-book-meta">
                      {b.author ? `${b.author} · ` : ""}
                      第 {Math.min(chapterIdx + 1, b.chapters.length)}/{b.chapters.length} 章
                    </span>
                    <div className="reader-book-bar">
                      <i style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                  <span className="pct">{percent}%</span>
                  <button
                    className="del"
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
                  >
                    <IconTrash size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {books.length > 0 && articles.length > 0 && (
          <div className="reader-shelf-divider">短文</div>
        )}
        {articles.length === 0 && books.length === 0 && (
          <div className="reader-empty-shelf">
            还没有文章。
            <br />
            点右上角 ＋ 导入整本 EPUB，或在网页/文档里选中文字，点浮窗上的「发送到阅读室」，或按
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
        <TodayCard
          reviewedToday={reviewedToday}
          dueNow={dueNow}
          streak={streak}
          onGoReview={onOpenReview}
          readMinutesToday={readMinutesToday}
          readGoalMin={readGoalMin}
        />
      </div>
    </aside>
  );
}
