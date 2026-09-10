/**
 * 阅读舞台（屏 A）：进度线 + 文章头 + 句对列表；内嵌屏 E 遮罩与
 * 屏 C 划选查词入口。视觉按 §5 句对主从版式，640px 列居中。
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  IconBookOpen,
  IconEdit,
  IconEyeOff,
  IconVolume,
} from "../ui/icons";
import type { Article, ReaderSettings } from "../core/readerTypes";
import { extractSelectionText } from "../core/readerDict";

interface Props {
  article: Article | null;
  settings: ReaderSettings;
  activeIdx: number;
  translating: { done: number; total: number } | null;
  /** 遮罩模式下按住 H 的临时全显（不改变已揭开状态）。 */
  peekAll: boolean;
  searchMatchIdx: number | null;
  onReveal: (idx: number) => void;
  onRevealAll: () => void;
  onSelection: (idx: number, text: string) => void;
  onWordClick: (idx: number, word: string) => void;
  onSpeakSentence: (idx: number) => void;
  onRetryParagraph: (paragraphIdx: number) => void;
  onEditTranslation: (idx: number, zh: string) => void;
  onJumpTo: (idx: number) => void;
  onImportPaste: (text: string) => void;
  onRetryTitle: () => void;
}

const WORD_CHARS = /[A-Za-z0-9'’-]/;

export function ReadingView(props: Props) {
  const { article, settings, activeIdx, translating, peekAll, searchMatchIdx } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pairRefs = useRef(new Map<number, HTMLDivElement>());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const sentences = article?.sentences ?? [];
  const maskOn = settings.maskTranslation;
  const revealedCount = maskOn
    ? sentences.filter((s) => s.zh && (s.revealed || peekAll)).length
    : 0;
  const maskableCount = maskOn ? sentences.filter((s) => s.zh).length : 0;

  // 当前句滚动跟随（播放或光标移动时）。
  useEffect(() => {
    const el = pairRefs.current.get(activeIdx);
    if (el) {
      const container = scrollRef.current;
      if (!container) return;
      const elTop = el.offsetTop;
      const viewTop = container.scrollTop;
      const viewH = container.clientHeight;
      if (elTop < viewTop + 40 || elTop + el.offsetHeight > viewTop + viewH - 80) {
        container.scrollTo({ top: Math.max(0, elTop - viewH / 3), behavior: "smooth" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, article?.id]);

  // 检索定位。
  useEffect(() => {
    if (searchMatchIdx === null) return;
    const el = pairRefs.current.get(searchMatchIdx);
    const container = scrollRef.current;
    if (el && container) {
      container.scrollTo({ top: Math.max(0, el.offsetTop - 80), behavior: "smooth" });
    }
  }, [searchMatchIdx]);

  function handleMouseUp(e: ReactMouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = extractSelectionText(sel.toString());
    if (!text) return;
    const pairEl = (e.target as HTMLElement).closest(".pair") as HTMLElement | null;
    if (!pairEl) return;
    const idx = Number(pairEl.dataset.idx);
    if (Number.isNaN(idx)) return;
    props.onSelection(idx, text);
  }

  function handleEnClick(e: ReactMouseEvent<HTMLParagraphElement>) {
    // 有划选时交给 mouseup 处理；单击单词走词定位。
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pairEl = e.currentTarget.closest(".pair") as HTMLElement | null;
    if (!pairEl) return;
    const idx = Number(pairEl.dataset.idx);
    if (Number.isNaN(idx)) return;
    const word = wordAtPoint(e.clientX, e.clientY, e.currentTarget);
    if (word) props.onWordClick(idx, word);
  }

  function startEdit(idx: number, current: string | null) {
    setEditingIdx(idx);
    setEditDraft(current ?? "");
  }

  function commitEdit(idx: number) {
    const text = editDraft.trim();
    setEditingIdx(null);
    if (text) props.onEditTranslation(idx, text);
  }

  if (!article) {
    return (
      <div className="reader-stage">
        <EmptyState onImportPaste={props.onImportPaste} />
      </div>
    );
  }

  const total = sentences.length;
  const resumeIdx = article.progress.sentenceIdx;
  const showResume = resumeIdx > 0 && resumeIdx < total;

  return (
    <div className="reader-stage">
      <div className="reader-scroll" ref={scrollRef}>
        {settings.showProgress && (
          <div className="reader-progressline" aria-hidden>
            <i style={{ width: `${Math.round(article.progress.percent)}%` }} />
          </div>
        )}

        {maskOn && (
          <div className="reader-maskbar">
            <span className="eye">
              <IconEyeOff size={14} />
            </span>
            <span className="title">译文遮罩 · 自测模式</span>
            <span className="count">
              {revealedCount} / {maskableCount} 已揭开
            </span>
            <span className="hint">点单句揭开 · 按住 H 临时显示全部 · 播放时只高亮英文</span>
            <button className="btn btn-secondary btn-sm" onClick={props.onRevealAll}>
              全部揭开
            </button>
          </div>
        )}

        <article className={`reader-article${maskOn ? " reader-mask-on" : ""}`}>
          <header className="reader-article-head">
            <h1 className="reader-article-title">{article.title}</h1>
            {article.titleCn ? (
              <p className="reader-article-subtitle">{article.titleCn}</p>
            ) : article.titleCnState === "failed" ? (
              <p className="reader-article-subtitle" style={{ color: "var(--err)", fontSize: 13 }}>
                标题翻译失败
                <button
                  style={{ marginLeft: 8, border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
                  onClick={props.onRetryTitle}
                >
                  重试
                </button>
              </p>
            ) : translating ? (
              <div style={{ maxWidth: 320, marginTop: 4 }}>
                <div className="reader-skeleton-line" style={{ width: "70%" }} />
              </div>
            ) : null}
            <div className="reader-article-meta">
              {article.level && <span className="chip chip-blue">{article.level}</span>}
              <span>{article.wordCount} 词</span>
              <span>· {total} 句</span>
              {translating && (
                <span className="chip chip-amber">
                  翻译中 {translating.done}/{translating.total} 段
                </span>
              )}
              {showResume && !translating && (
                <button
                  className="resume-link"
                  onClick={() => props.onJumpTo(resumeIdx)}
                  title="从上次读到的句子继续"
                >
                  上次读到第 {resumeIdx + 1} 句 · 点击继续
                </button>
              )}
            </div>
          </header>

          <div className="reader-pairs" onMouseUp={handleMouseUp}>
            {sentences.map((s) => {
              const prev = sentences[s.idx - 1];
              const isParaStart = !prev || prev.paragraphIdx !== s.paragraphIdx;
              const isActive = s.idx === activeIdx;
              const masked = maskOn && !!s.zh && !s.revealed && !peekAll;
              return (
                <div
                  key={s.idx}
                  data-idx={s.idx}
                  ref={(el) => {
                    if (el) pairRefs.current.set(s.idx, el);
                    else pairRefs.current.delete(s.idx);
                  }}
                  className={`pair${isParaStart ? " paragraph-start" : ""}${isActive ? " is-active" : ""}${
                    s.zhState === "failed" ? " failed" : ""
                  }`}
                >
                  <p className="pair-en" onClick={handleEnClick} title="单击查词，划选查短语">
                    {s.en}
                  </p>

                  {masked ? (
                    <button
                      className="cn-mask"
                      onClick={() => props.onReveal(s.idx)}
                      title="点按查看译文"
                    >
                      <IconEyeOff size={12} />
                      点按查看译文
                    </button>
                  ) : s.zhState === "pending" ? (
                    translating || s.zh ? (
                      s.zh ? (
                        // 流式增量先亮出来，done 后转正
                        <p className="pair-cn" style={{ opacity: 0.75 }}>
                          {s.zh}
                        </p>
                      ) : (
                        <span className="pair-cn-pending">
                          <span className="reader-skeleton-line" style={{ width: 140 }} />
                        </span>
                      )
                    ) : (
                      <span className="pair-cn-pending">译文待生成</span>
                    )
                  ) : s.zhState === "failed" ? (
                    <span className="pair-failed-row">
                      本段翻译失败
                      <button onClick={() => props.onRetryParagraph(s.paragraphIdx)}>重试本段</button>
                    </span>
                  ) : editingIdx === s.idx ? (
                    <textarea
                      className="pair-cn-edit"
                      value={editDraft}
                      autoFocus
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commitEdit(s.idx);
                        if (e.key === "Escape") setEditingIdx(null);
                      }}
                      rows={2}
                      aria-label="编辑译文（Ctrl+Enter 保存，Esc 取消）"
                    />
                  ) : (
                    <p className="pair-cn" onClick={() => props.onJumpTo(s.idx)} title="点中文定位到对应英文句">
                      {s.zh}
                    </p>
                  )}

                  <div className="pair-actions">
                    <button
                      className={`icon-btn${isActive ? " active" : ""}`}
                      onClick={() => props.onSpeakSentence(s.idx)}
                      title={isActive ? "朗读当前句" : "朗读这一句"}
                    >
                      <IconVolume size={13} />
                    </button>
                    {s.zh && s.zhState !== "pending" && editingIdx !== s.idx && (
                      <button
                        className="icon-btn"
                        onClick={() => startEdit(s.idx, s.zh)}
                        title="手改译文"
                      >
                        <IconEdit size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </div>
  );
}

/** 光标处的完整单词（阅读版式下 .pair-en 内单击查词）。 */
function wordAtPoint(x: number, y: number, container: HTMLElement): string | null {
  const doc = container.ownerDocument;
  const range = doc.caretRangeFromPoint(x, y);
  if (!range || !range.startContainer) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  let offset = range.startOffset;
  // 点击点落在词边界上时，向后包含一个字符
  if (offset < text.length && !WORD_CHARS.test(text[offset]) && offset > 0) {
    offset -= 1;
  }
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHARS.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHARS.test(text[end])) end++;
  const word = text.slice(start, end).trim();
  return word.length > 0 && word.length <= 40 ? word : null;
}

function EmptyState({ onImportPaste }: { onImportPaste: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="reader-scroll">
      <div className="reader-empty-state" style={{ height: "100%" }}>
        <span className="reader-logo" style={{ marginBottom: 6 }}>
          <IconBookOpen size={16} />
        </span>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>把文章搬进阅读室</div>
        <div style={{ maxWidth: 380, lineHeight: 1.8 }}>
          在任意应用选中文字 → 浮窗弹出 → 点「发送到阅读室」；或按
          <span className="kbd"> Ctrl</span>+<span className="kbd">Shift</span>+
          <span className="kbd">R</span>。也可以直接粘贴：
        </div>
        <textarea
          className="textarea"
          style={{ width: 460, maxWidth: "86%", height: 120, marginTop: 8 }}
          placeholder={"粘贴英文文章，空行分段。\n例：The Speed of Reading\n\nReading speed was the goal, and comprehension was the test."}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn btn-primary"
          style={{ marginTop: 10 }}
          disabled={!draft.trim()}
          onClick={() => {
            onImportPaste(draft);
            setDraft("");
          }}
        >
          导入并开始阅读
        </button>
      </div>
    </div>
  );
}
