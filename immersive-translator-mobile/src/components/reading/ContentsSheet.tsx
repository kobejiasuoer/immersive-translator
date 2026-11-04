/**
 * 阅读目录抽屉（reading-parity · 原型 SHEETS.contents，html:1821-1823）。
 * 书模式列同书章节（27px 圆底数字徽标 + hairline 分隔）、非书模式列全部可读文档（文档图标徽标）；
 * 每篇各自保留阅读位置（progress 同源）。
 */
import { useApp } from "../../store";
import { Icon } from "../../ui/icons";
import type { Article } from "../../core/types";
import { ReadingDrawer } from "./Drawer";

export function ContentsSheet({
  open,
  onClose,
  title,
  articles,
  currentId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** 抽屉标题（原型 SHEETS.contents html:1821）：书模式=「书名 · 目录」，非书模式=「我的可读内容」。 */
  title: string;
  articles: Article[];
  currentId?: string;
  onPick: (article: Article) => void;
}) {
  const progress = useApp((s) => s.progress);
  const completed = useApp((s) => s.readingCompleted);
  return (
    <ReadingDrawer open={open} onClose={onClose} label="阅读目录">
      <div className="sheet-title plain">{title}</div>
      <p className="sheet-note">每篇内容都会保留自己的阅读位置。</p>
      {articles.length ? (
        articles.map((a, index) => {
          const p = progress[a.id];
          const total = a.sentences.length;
          const done = !!completed[a.id];
          const chapterNo = Number(a.chapterIndex ?? index) + 1;
          return (
            <button
              key={a.id}
              className="v2-toc-row"
              onClick={() => onPick(a)}
              aria-current={a.id === currentId ? "true" : undefined}
            >
              <span className="v2-toc-number num">
                {a.bookId ? chapterNo : <Icon name="note" size={13} />}
              </span>
              <span>
                <b className="serif" style={{ fontWeight: 600 }}>
                  {typeof a.chapterTitle === "string" && a.chapterTitle ? a.chapterTitle : a.title}
                </b>
                <small>
                  {done ? "已读完" : p !== undefined ? `读到第 ${p + 1} 句` : "未开始"} · {total} 句
                </small>
              </span>
              <Icon name="chevr" size={15} />
            </button>
          );
        })
      ) : (
        <p className="sheet-note" style={{ margin: 0 }}>
          还没有可读内容，可以从推荐短文开始。
        </p>
      )}
    </ReadingDrawer>
  );
}
