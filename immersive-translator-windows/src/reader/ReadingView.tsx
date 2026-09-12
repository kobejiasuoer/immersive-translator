/**
 * 阅读舞台（屏 A）：进度线 + 文章头 + 句对列表；内嵌屏 E 遮罩与
 * 屏 C 划选查词入口。视觉按 §5 句对主从版式，640px 列居中。
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  IconBookOpen,
  IconEdit,
  IconEyeOff,
  IconVolume,
} from "../ui/icons";
import type { Article, ReaderSettings, SentenceChunk } from "../core/readerTypes";
import { extractSelectionText } from "../core/readerDict";
import { buildSentenceSpans, splitBySpans, type ChunkSpan } from "../core/chunkAnnotate";

interface Props {
  article: Article | null;
  settings: ReaderSettings;
  activeIdx: number;
  translating: { done: number; total: number } | null;
  /** 词块标注进度（翻译完成后跑，与 translating 互斥显示）。 */
  chunking: { done: number; total: number } | null;
  /** 遮罩模式下按住 H 的临时全显（不改变已揭开状态）。 */
  peekAll: boolean;
  searchMatchIdx: number | null;
  /** 生词本归一化 id 集（生词再现标记用）。 */
  knownIds: ReadonlySet<string>;
  onReveal: (idx: number) => void;
  onMask: (idx: number) => void;
  onRevealAll: () => void;
  onMaskAll: () => void;
  onSelection: (idx: number, text: string) => void;
  onWordClick: (idx: number, word: string) => void;
  /** 点正文里的词块下划线 → 词典栏即时卡（无 LLM 调用）。 */
  onChunkClick: (idx: number, chunk: SentenceChunk) => void;
  onSpeakSentence: (idx: number) => void;
  onRetryParagraph: (paragraphIdx: number) => void;
  onEditTranslation: (idx: number, zh: string) => void;
  onJumpTo: (idx: number) => void;
  /** 滚动阅读时光标跟随视口（未播放时由 ReaderApp 决定是否采纳）。 */
  onViewportIdx: (idx: number) => void;
  onOpenImport: () => void;
  onRetryTitle: () => void;
}

const WORD_CHARS = /[A-Za-z0-9'’-]/;

const NO_SPANS: ChunkSpan[] = [];
const NO_IDS: ReadonlySet<string> = new Set<string>();

export function ReadingView(props: Props) {
  const { article, settings, activeIdx, translating, chunking, peekAll, searchMatchIdx } = props;
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

  // 词块/生词再现跨度（开关只影响参与合并的候选，en 不可变所以可安全 memo）。
  const spansBySentence = useMemo(() => {
    const map = new Map<number, ChunkSpan[]>();
    if (!article) return map;
    for (const s of article.sentences) {
      const spans = buildSentenceSpans(
        s.en,
        settings.chunkHighlight ? s.chunks : undefined,
        settings.showVocabMarks ? props.knownIds : NO_IDS,
      );
      if (spans.length > 0) map.set(s.idx, spans);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id, article?.sentences, settings.chunkHighlight, settings.showVocabMarks, props.knownIds]);

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

  // 滚动阅读：光标跟随视口（rAF 节流）。播放中的跟随滚动由 activeIdx 驱动，
  // 这里不回写，避免和播放跟随互相拉扯（ReaderApp 侧再按 playing 过滤）。
  const rafRef = useRef(0);
  const onViewportIdxRef = useRef(props.onViewportIdx);
  onViewportIdxRef.current = props.onViewportIdx;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let lastReported = -1;
    function computeViewportIdx(): number {
      const el = scrollRef.current;
      if (!el) return -1;
      // 取视口上三分之一高度处的那一句：滚到哪，读到哪。
      const line = el.scrollTop + el.clientHeight / 3;
      let best = -1;
      for (const [idx, pair] of pairRefs.current) {
        if (pair.offsetTop <= line && idx > best) best = idx;
      }
      if (best < 0) return pairRefs.current.size > 0 ? 0 : -1;
      return best;
    }
    function onScroll() {
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        const idx = computeViewportIdx();
        if (idx >= 0 && idx !== lastReported) {
          lastReported = idx;
          onViewportIdxRef.current(idx);
        }
      });
    }
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id]);

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
        <EmptyState onOpenImport={props.onOpenImport} />
      </div>
    );
  }

  const total = sentences.length;
  const resumeIdx = article.progress.sentenceIdx;
  const showResume = resumeIdx > 0 && resumeIdx < total;

  return (
    <div className="reader-stage">
      <div className="reader-scroll" ref={scrollRef}>
        {maskOn && (
          <div className="reader-maskbar">
            <span className="eye">
              <IconEyeOff size={14} />
            </span>
            <span className="title">译文遮罩</span>
            <span className="count">
              {revealedCount} / {maskableCount} 已揭开
            </span>
            <span className="hint">点单句揭开 / 再点遮住 · 按住 H 临时显示全部</span>
            {revealedCount < maskableCount && (
              <button className="btn btn-secondary btn-sm" onClick={props.onRevealAll}>
                全部揭开
              </button>
            )}
            {revealedCount > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={props.onMaskAll}>
                全部遮住
              </button>
            )}
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
              {!translating && chunking && (
                <span className="chip chip-amber">
                  词块标注中 {chunking.done}/{chunking.total} 批
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
              // 罩层挂点：有译文且非失败、非编辑中。揭开/暂显（H）只切换样式类。
              const maskSlot = maskOn && !!s.zh && s.zhState !== "failed" && editingIdx !== s.idx;
              const maskShown = maskSlot && (!!s.revealed || peekAll);
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
                  <button
                    className="pair-no"
                    onClick={() => props.onJumpTo(s.idx)}
                    title={`第 ${s.idx + 1} 句 · 点击定位`}
                    aria-label={`定位到第 ${s.idx + 1} 句`}
                  >
                    {s.idx + 1}
                  </button>
                  <div className="pair-body">
                  <p className="pair-en" onClick={handleEnClick} title="单击查词，划选查短语">
                    {(spansBySentence.get(s.idx) ?? NO_SPANS).length === 0
                      ? s.en
                      : splitBySpans(s.en, spansBySentence.get(s.idx)!).map((seg, i) =>
                          seg.span ? (
                            <span
                              key={i}
                              className={`chunk-hl${seg.span.kind === "known" ? " known" : ""}`}
                              title={seg.span.chunk ? "词块 · 点击查看" : "生词再现 · 点击查词典"}
                              onClick={(e) => {
                                // 词块 span 自接管点击，避免触发句级点词查词。
                                e.stopPropagation();
                                if (seg.span!.chunk) props.onChunkClick(s.idx, seg.span!.chunk);
                                else props.onSelection(s.idx, seg.text);
                              }}
                            >
                              {seg.text}
                            </span>
                          ) : (
                            seg.text
                          ),
                        )}
                  </p>

                  {maskSlot ? (
                    settings.maskStyle === "frost" ? (
                      // 方案 C · 毛玻璃：译文一直在，模糊盖住；点击「显影」，再点重新遮住
                      <p
                        className={`pair-cn cn-frost${maskShown ? " revealed" : ""}`}
                        onClick={() => (maskShown ? props.onMask(s.idx) : props.onReveal(s.idx))}
                        title={maskShown ? "点按重新遮住" : "点按显示译文"}
                      >
                        {s.zh}
                      </p>
                    ) : (
                      // 方案 A · 留白显影：隐藏时无痕占位，悬停浮现「显示译文」；揭开后再点重新遮住
                      <div
                        className={`cn-slot${maskShown ? " revealed" : ""}`}
                        role="button"
                        tabIndex={0}
                        aria-label={maskShown ? "点按重新遮住译文" : "显示译文"}
                        onClick={() => (maskShown ? props.onMask(s.idx) : props.onReveal(s.idx))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (maskShown) props.onMask(s.idx);
                            else props.onReveal(s.idx);
                          }
                        }}
                      >
                        <span className="zh-ghost" aria-hidden>
                          <IconEyeOff size={12} />
                          显示译文
                        </span>
                        <p className="pair-cn">{s.zh}</p>
                      </div>
                    )
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
                    <div className="pair-cn-editor">
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
                      <div className="pair-cn-editor-actions">
                        <span className="tip">Ctrl+Enter 保存 · Esc 取消</span>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditingIdx(null)}
                        >
                          取消
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!editDraft.trim()}
                          onClick={() => commitEdit(s.idx)}
                        >
                          保存
                        </button>
                      </div>
                    </div>
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
  // vite 文件监视在 Windows 上可能吞掉同秒内的连续编辑，改动本文件后
  // 若 HMR 行为与源码不符，优先怀疑转换缓存过期（2026-09 实际踩过）。
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

function EmptyState({ onOpenImport }: { onOpenImport: () => void }) {
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
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onOpenImport}>
          粘贴导入文章
        </button>
      </div>
    </div>
  );
}
