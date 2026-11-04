/**
 * 试读抽屉（reading-parity · 原型 SHEETS.bookSample）。
 * 前 3 句来自真实下载解析的 EPUB 首章（splitParagraphs 切句），禁止静态预览数据；
 * 两条路径：加入书架并阅读（importBook 全章节入库）/ 只读这篇不加入书架（article 直传阅读页，不落书架）。
 * 已在书架时：开始阅读（回到既有章节）+ 移出书架（confirm 由调用方承接，archived 语义）。
 */
import { Icon } from "../../ui/icons";
import { splitParagraphs } from "../../../../immersive-translator-windows/src/core/sentenceSplit";
import type { Article } from "../../core/types";
import { articlesFromBook, type BookPreview } from "../../services/discovery";
import { ReadingDrawer } from "./Drawer";

export function firstSentences(text: string, count: number): string[] {
  const out: string[] = [];
  for (const paragraph of splitParagraphs(text)) {
    for (const sentence of paragraph.sentences) {
      if (sentence.trim()) out.push(sentence.trim());
      if (out.length >= count) return out;
    }
  }
  return out;
}

export function BookSampleSheet({
  open,
  onClose,
  preview,
  busy,
  added,
  onAdd,
  onReadOnly,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  preview: BookPreview | null;
  /** 加入/移出等操作进行中：按钮禁用（由调用方的 run 状态传入）。 */
  busy: boolean;
  /** 书架里已有这本书（同 bookId）。 */
  added: boolean;
  onAdd: () => void;
  onReadOnly: (article: Article) => void;
  onRemove: () => void;
}) {
  if (!preview) return null;
  const chapter = preview.book.chapters[0];
  const sentences = chapter ? firstSentences(chapter.text, 3) : [];
  return (
    <ReadingDrawer open={open} onClose={onClose} label="试读">
      <div className="sheet-title serif">{preview.book.title}</div>
      <p className="meta">
        {preview.book.author || preview.catalog.author} · {{ easy: "入门", medium: "进阶", hard: "挑战" }[preview.catalog.grade] || preview.catalog.grade} · 试读
      </p>
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 12, padding: 14, margin: "10px 0", background: "var(--surface-2)" }}>
        {chapter && <div className="overline">{chapter.title}</div>}
        {sentences.map((s, i) => (
          <p key={i} className="serif" style={{ fontSize: 16, lineHeight: 1.8, margin: "6px 0 0", overflowWrap: "anywhere" }} lang="en">
            {s}
          </p>
        ))}
        {!sentences.length && <p className="meta">这本书的首章没有可显示的句子。</p>}
        <p className="meta" style={{ marginTop: 10 }}>
          这里只展示开头 {sentences.length || 3} 句；{added ? "书架中已保存全部章节。" : "加入书架会保存全部章节的完整正文。"}
        </p>
      </div>
      <button className="btn" disabled={busy} onClick={onAdd}>
        <Icon name="book" size={15} />
        {added ? "补齐章节并继续阅读" : `加入书架，开始阅读（${preview.book.chapters.length} 章）`}
      </button>
      <button className="btn-ghost" style={{ marginTop: 8, border: "1px solid var(--hairline-strong)" }} disabled={busy} onClick={() => chapter && onReadOnly(chapterArticle(preview))}>
        只读这篇，不加入书架
      </button>
      {added && (
        <button className="btn-ghost" style={{ marginTop: 8, color: "var(--b4423a, #b4423a)" }} disabled={busy} onClick={onRemove}>
          移出书架
        </button>
      )}
    </ReadingDrawer>
  );
}

/** 只读路径用的首章 article（与 importBook 同构，但不入库）。 */
function chapterArticle(preview: BookPreview): Article {
  return articlesFromBook(preview)[0];
}
