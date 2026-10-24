/**
 * 阅读舞台（屏 A）：v0.8 画报排版（原型「模块 1：阅读」1:1 还原）。
 *
 * 结构：左侧 .editorial-spine-col 书脊列（超大句码/竖排书名/进度）+
 * .literary-spread-scroll 正文画布（.masthead 刊头：display 标题、中文副题、
 * 行内三开关）+ .prose-body 行内英文流（专注模式聚光）或
 * .parallel-spread-row 双语对照双栏。
 *
 * 词块/生词着色、跟读着色、遮罩（cn-frost/cn-slot）、手改译文、单段重试、
 * 滚动跟随（pairRefs/onViewportIdx）全部保留复用；prose 模式下译文展示位
 * 由当前句的 .interlinear-fold 行间折叠卡承担（朗读/句子解析/练口语/编辑
 * 译文都在 fold-actions 里）。
 */

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  IconBookOpen,
  IconEdit,
  IconEyeOff,
  IconMic,
  IconVolume,
} from "../ui/icons";
import type { Article, ReaderSettings, SentenceChunk, SentencePair } from "../core/readerTypes";
import type { WordMark } from "../core/pronunciation";
import { extractSelectionText } from "../core/readerDict";
import { buildSentenceSpans, findChunkRange, splitBySpans, type ChunkSpan, type SpanSegment } from "../core/chunkAnnotate";
import { firstLetters, judgeCloze, type RecallVerdict } from "../core/recallJudge";
import { pickClozeSlots, type ClozeSlot } from "../core/clozeSlots";

interface Props {
  article: Article | null;
  settings: ReaderSettings;
  activeIdx: number;
  /** 播放引擎是否正在朗读（句旁按钮据此切换「朗读这一句 / 停止朗读」）。 */
  playing: boolean;
  translating: { done: number; total: number } | null;
  /** 词块标注进度（翻译完成后跑，与 translating 互斥显示）。 */
  chunking: { done: number; total: number } | null;
  /** 遮罩模式下按住 H 的临时全显（不改变已揭开状态）。 */
  peekAll: boolean;
  searchMatchIdx: number | null;
  /** 生词本归一化 id 集（生词再现标记用）。 */
  knownIds: ReadonlySet<string>;
  /** 跟读评测词着色（最近一次评测的句子；下一次评测前保持显示）。 */
  assessMarks: { sentenceIdx: number; marks: WordMark[] } | null;
  onReveal: (idx: number) => void;
  onMask: (idx: number) => void;
  onRevealAll: () => void;
  onMaskAll: () => void;
  onSelection: (idx: number, text: string) => void;
  onWordClick: (idx: number, word: string) => void;
  /** 点正文里的词块下划线 → 词典栏即时卡（无 LLM 调用）。 */
  onChunkClick: (idx: number, chunk: SentenceChunk) => void;
  /** 句旁朗读按钮：只读这一句，读完自动停。 */
  onSpeakSentence: (idx: number) => void;
  /** 播放中（含连续播放）时点当前句的朗读按钮 = 停止。 */
  onStopSpeaking: () => void;
  onRetryParagraph: (paragraphIdx: number) => void;
  onEditTranslation: (idx: number, zh: string) => void;
  onJumpTo: (idx: number) => void;
  /** 滚动阅读时光标跟随视口（未播放时由 ReaderApp 决定是否采纳）。 */
  onViewportIdx: (idx: number) => void;
  onOpenImport: () => void;
  onRetryTitle: () => void;
  /** 标题失败原因小字（瞬态；缺省 = 无原因，与旧行为一致）。 */
  titleCnError?: string;
  /** 光标已到末句且未确认读完：正文末尾显示「读完本篇/本章」按钮（纯手动阅读路径）。 */
  showFinishAction: boolean;
  finishLabel: string;
  onFinishRead: () => void;
  /** 书章模式：章节栏数据（短文缺省不渲染）。 */
  book?: { title: string; chapterIdx: number; chapterCount: number } | null;
  onOpenToc?: () => void;
  // ---- v0.8 画报排版新增 ----
  /** 刊头行内三开关（专注模式/排版/译文显隐）走设置补丁。 */
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  /** 行间折叠卡「句子解析」：请求当前句的结构解析（右栏透镜卡）。 */
  onOpenXray: (idx: number) => void;
  /** 行间折叠卡/刊头「用这句（本章）练口语」。 */
  onPracticeSentence: (idx: number) => void;
  /** 刊头中文副题行「围绕本章练口语 →」。 */
  onPracticeChapter?: () => void;
  /** 透镜卡结构拆解悬停中的片段（优先级高于词块着色，回标原文）。 */
  hoveredClause: string | null;
  /** 随读抽查：读到哪的水位线（progress.sentenceIdx，单调递增）——只挖已读句。 */
  readWatermark: number;
  /** 随读抽查判分回调：known 槽联动 SRS 与错题桶（ReaderApp 侧限幅）。 */
  onClozeVerdict?: (slot: ClozeSlot, verdict: RecallVerdict) => void;
}

const WORD_CHARS = /[A-Za-z0-9'’-]/;

const NO_SPANS: ChunkSpan[] = [];
const NO_IDS: ReadonlySet<string> = new Set<string>();

/** 随读抽查印章文案（judgeCloze 四档）。 */
const VERDICT_LABEL: Record<RecallVerdict, string> = {
  perfect: "命中",
  close: "接近",
  trap: "陷阱",
  wrong: "未中",
};

export function ReadingView(props: Props) {
  const { article, settings, activeIdx, translating, chunking, peekAll, searchMatchIdx } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pairRefs = useRef(new Map<number, HTMLElement>());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const sentences = article?.sentences ?? [];
  const maskOn = settings.maskTranslation;
  const spotlight = settings.spotlightMode ?? false;
  const spread = settings.spreadLayout ?? "prose";
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

  // ---- 随读抽查（原位挖空微测）----
  const quizOn = settings.spotQuizMode ?? false;
  /** 已读句的挖空槽（每段一槽；开关关闭时恒为空集，正文零残留）。 */
  const clozeSlots = useMemo(() => {
    if (!quizOn || !article) return new Map<number, ClozeSlot>();
    return pickClozeSlots(spansBySentence, article.sentences, props.readWatermark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizOn, article, spansBySentence, props.readWatermark]);

  /** 槽位作答状态（usedHint 在判分前就要记，verdict 判分后写入）。 */
  const [clozeState, setClozeState] = useState<Record<string, { usedHint: boolean; verdict?: RecallVerdict; input?: string }>>({});
  const [clozeToasts, setClozeToasts] = useState<{ key: number; word: string; label: string; tone: RecallVerdict }[]>([]);
  const clozeToastSeq = useRef(0);

  const clozeTally = useMemo(() => {
    let hit = 0;
    let close = 0;
    let trap = 0;
    let done = 0;
    for (const slot of clozeSlots.values()) {
      const v = clozeState[slot.id]?.verdict;
      if (!v) continue;
      done += 1;
      if (v === "perfect") hit += 1;
      else if (v === "close") close += 1;
      else if (v === "trap") trap += 1;
    }
    return { hit, close, trap, done, todo: clozeSlots.size - done };
  }, [clozeSlots, clozeState]);

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
    // 挖空输入框内的选词不是划选查词，先让路。
    if ((e.target as HTMLElement).closest("input, textarea, .cloze")) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = extractSelectionText(sel.toString());
    if (!text) return;
    const pairEl = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement | null;
    if (!pairEl) return;
    const idx = Number(pairEl.dataset.idx);
    if (Number.isNaN(idx)) return;
    props.onSelection(idx, text);
  }

  function idxFromTarget(target: EventTarget | null): number | null {
    const pairEl = (target as HTMLElement | null)?.closest("[data-idx]") as HTMLElement | null;
    if (!pairEl) return null;
    const idx = Number(pairEl.dataset.idx);
    return Number.isNaN(idx) ? null : idx;
  }

  /** 双语对照行英文列：单击查词、划选交 mouseup。 */
  function handleEnClick(e: ReactMouseEvent<HTMLElement>) {
    // 有划选时交给 mouseup 处理；单击单词走词定位。
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const idx = idxFromTarget(e.target);
    if (idx === null) return;
    const word = wordAtPoint(e.clientX, e.clientY, e.currentTarget);
    if (word) props.onWordClick(idx, word);
  }

  /** 画报英文流：点句定位为当前句；点在单词上再顺带查词（查词通道不变）。 */
  function handleProseClick(e: ReactMouseEvent<HTMLSpanElement>) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const idx = idxFromTarget(e.target);
    if (idx === null) return;
    props.onJumpTo(idx);
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
  const readMinutes = Math.max(1, Math.round(article.wordCount / 200));

  /** 随读抽查：提交判分（judgeCloze 本地判；用过提示的 perfect 降档为 close）。 */
  function commitCloze(slot: ClozeSlot, raw: string) {
    const verdict0 = judgeCloze(raw, slot.answer, slot.trap ? { trap: slot.trap } : undefined);
    if (!verdict0) return;
    const usedHint = !!clozeState[slot.id]?.usedHint;
    const verdict: RecallVerdict = usedHint && verdict0 === "perfect" ? "close" : verdict0;
    setClozeState((prev) => ({ ...prev, [slot.id]: { usedHint, verdict, input: raw.trim() } }));
    pushClozeToast(slot, verdict);
    props.onClozeVerdict?.(slot, verdict);
  }

  /** 判分后的胶带小条（左下角，最多 3 条，3.2s 自动退场）。 */
  function pushClozeToast(slot: ClozeSlot, verdict: RecallVerdict) {
    const key = ++clozeToastSeq.current;
    const label = slot.isKnown
      ? verdict === "perfect" || verdict === "close"
        ? "已记入复习 · 良好"
        : "已记入复习 · 需复习"
      : "抽查完成";
    setClozeToasts((t) => [...t.slice(-2), { key, word: slot.answer, label, tone: verdict }]);
    window.setTimeout(() => setClozeToasts((t) => t.filter((x) => x.key !== key)), 3200);
  }

  /**
   * 词块/生词跨度段的渲染：随读抽查开启且该段命中本句槽位时，
   * 渲染行内挖空输入（未答）或印章结果（已答）；其余照旧 chunk-hl。
   * 输入为非受控（defaultValue 不设、Enter 时现读 value），避免重绘打断打字。
   */
  const renderSpanSeg = (s: SentencePair, seg: SpanSegment, i: number): ReactNode => {
    if (!seg.span) return seg.text;
    const slot = quizOn ? clozeSlots.get(s.idx) : undefined;
    if (slot && slot.start === seg.span.start && slot.end === seg.span.end) {
      const st = clozeState[slot.id];
      if (st?.verdict) {
        const bad = st.verdict === "trap" || st.verdict === "wrong";
        return (
          <span className="cloze" key={i}>
            <span className={`cloze-done verdict-${st.verdict}`}>
              {bad && st.input ? <span className="cloze-wrong">{st.input}</span> : null}
              {seg.text}
            </span>
            <span className={`cloze-stamp s-${st.verdict}`}>{VERDICT_LABEL[st.verdict]}</span>
            {bad && (slot.trap || slot.gloss) ? (
              <span className="cloze-note">{slot.trap ? `陷阱 · ${slot.trap}` : `释义 · ${slot.gloss}`}</span>
            ) : null}
          </span>
        );
      }
      return (
        <span className={`cloze${props.peekAll ? " peeked" : ""}`} key={i} data-answer={slot.answer}>
          <input
            className="cloze-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={`补全挖空的${slot.isKnown ? "生词" : "词块"}：${firstLetters(slot.answer)}`}
            style={{ width: `calc(${Math.max(slot.answer.length, 5)}ch * 0.62 + 18px)` }}
            onKeyDown={(e) => {
              // 输入槽自接管按键：空格打字不触发全局连播，Enter 判分。
              e.stopPropagation();
              if (e.key === "Enter") commitCloze(slot, e.currentTarget.value);
              else if (e.key === "Escape") e.currentTarget.blur();
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="cloze-hint-btn"
            type="button"
            title="首字母提示（命中会降档为「接近」）"
            aria-label="首字母提示"
            onClick={(e) => {
              e.stopPropagation();
              const wrap = e.currentTarget.closest(".cloze");
              const inp = wrap?.querySelector("input") as HTMLInputElement | null;
              if (inp) {
                inp.value = firstLetters(slot.answer);
                inp.focus();
              }
              setClozeState((prev) => ({ ...prev, [slot.id]: { usedHint: true } }));
            }}
          >
            ?
          </button>
        </span>
      );
    }
    return (
      <span
        key={i}
        className={`chunk-hl${seg.span.kind === "known" ? " known" : ""}`}
        title={seg.span.chunk ? "词块 · 点击查看" : "生词再现 · 点击查词典"}
        onClick={(e) => {
          // 词块 span 自接管点击，避免触发句级点词查词/定位。
          e.stopPropagation();
          if (seg.span!.chunk) props.onChunkClick(s.idx, seg.span!.chunk);
          else props.onSelection(s.idx, seg.text);
        }}
      >
        {seg.text}
      </span>
    );
  };

  /** 正文英文的装饰渲染（悬停意群 > 跟读着色 > 词块/生词跨度 > 纯文本）。 */
  const decorateEn = (s: SentencePair, withDropCap: boolean): ReactNode[] => {
    const hovered = props.hoveredClause;
    if (hovered && findChunkRange(s.en, hovered)) {
      // 悬停意群回标：整句只渲染这一个标记（优先级高于词块着色）。
      const range = findChunkRange(s.en, hovered)!;
      const nodes: ReactNode[] = [];
      if (range.start > 0) nodes.push(s.en.slice(0, range.start));
      nodes.push(
        <mark key="clause" className="spatial-clause-mark">
          {s.en.slice(range.start, range.end)}
        </mark>,
      );
      if (range.end < s.en.length) nodes.push(s.en.slice(range.end));
      return nodes;
    }
    let nodes: ReactNode[];
    if (props.assessMarks && props.assessMarks.sentenceIdx === s.idx) {
      nodes = renderMarkedEn(s.en, props.assessMarks.marks);
    } else {
      const spans = spansBySentence.get(s.idx) ?? NO_SPANS;
      nodes =
        spans.length === 0 ? [s.en] : splitBySpans(s.en, spans).map((seg, i) => renderSpanSeg(s, seg, i));
    }
    return withDropCap ? applyDropCap(nodes) : nodes;
  };

  /** 朗读/停止切换（行间折叠卡与对照行共用一套语义与提示文案）。 */
  const speakButton = (s: SentencePair, isActive: boolean) => (
    <button
      className={`icon-btn${isActive ? " active" : ""}`}
      onClick={() => {
        if (props.playing && isActive) props.onStopSpeaking();
        else props.onSpeakSentence(s.idx);
      }}
      title={
        props.playing && isActive
          ? "停止朗读（Space / 播放条的 ⏸ 也可以）"
          : "朗读这一句（读完自动停，不会连读下去）"
      }
    >
      <IconVolume size={13} />
    </button>
  );

  /** 手改译文编辑器（沿用既有 pair-cn-editor 结构，行间折叠卡与对照行共用）。 */
  const editorNode = (s: SentencePair) => (
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
        <button className="btn btn-secondary btn-sm" onClick={() => setEditingIdx(null)}>
          取消
        </button>
        <button className="btn btn-primary btn-sm" disabled={!editDraft.trim()} onClick={() => commitEdit(s.idx)}>
          保存
        </button>
      </div>
    </div>
  );

  /** 双语对照行的译文列：遮罩（毛玻璃/留白显影）、待生成、失败重试、编辑、定位。 */
  const renderZhSide = (s: SentencePair, isActive: boolean) => {
    const maskSlot = maskOn && !!s.zh && s.zhState !== "failed" && editingIdx !== s.idx;
    const maskShown = maskSlot && (!!s.revealed || peekAll);
    return (
      <>
        {maskSlot ? (
          settings.maskStyle === "frost" ? (
            <p
              className={`pair-cn cn-frost${maskShown ? " revealed" : ""}`}
              onClick={() => (maskShown ? props.onMask(s.idx) : props.onReveal(s.idx))}
              title={maskShown ? "点按重新遮住" : "点按显示译文"}
            >
              {s.zh}
            </p>
          ) : (
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
            {s.zhError ? (
              <span style={{ fontSize: 11, opacity: 0.8 }}>{s.zhError}</span>
            ) : null}
            <button onClick={() => props.onRetryParagraph(s.paragraphIdx)}>重试本段</button>
          </span>
        ) : editingIdx === s.idx ? (
          editorNode(s)
        ) : (
          <p className="pair-cn" onClick={() => props.onJumpTo(s.idx)} title="点中文定位到对应英文句">
            {s.zh}
          </p>
        )}
        <div className="spread-row-actions">
          {speakButton(s, isActive)}
          {s.zh && s.zhState !== "pending" && editingIdx !== s.idx && (
            <button className="icon-btn" onClick={() => startEdit(s.idx, s.zh)} title="手改译文">
              <IconEdit size={12} />
            </button>
          )}
        </div>
      </>
    );
  };

  /** 行间折叠卡（prose 模式当前句的译文 + 操作条）。 */
  const renderFold = (s: SentencePair, isActive: boolean) => {
    const foldMasked = maskOn && !!s.zh && s.zhState !== "failed" && editingIdx !== s.idx && !(!!s.revealed || peekAll);
    return (
      <span className={`interlinear-fold${foldMasked ? " masked" : ""}`} onClick={(e) => e.stopPropagation()}>
        {editingIdx === s.idx ? (
          editorNode(s)
        ) : s.zhState === "failed" ? (
          <span className="pair-failed-row">
            本段翻译失败
            {s.zhError ? (
              <span style={{ fontSize: 11, opacity: 0.8 }}>{s.zhError}</span>
            ) : null}
            <button onClick={() => props.onRetryParagraph(s.paragraphIdx)}>重试本段</button>
          </span>
        ) : (
          <div
            className="fold-zh pair-cn"
            onClick={() => {
              if (!maskOn) return;
              if (foldMasked) props.onReveal(s.idx);
              else props.onMask(s.idx);
            }}
            title={maskOn ? (foldMasked ? "点按显示译文" : "点按重新遮住") : undefined}
          >
            {s.zhState === "pending"
              ? translating || s.zh
                ? s.zh ?? <span className="reader-skeleton-line" style={{ width: 160, display: "inline-block" }} />
                : "译文待生成"
              : s.zh}
          </div>
        )}
        <div className="fold-actions">
          <button
            className="text-action-btn"
            onClick={() => {
              if (props.playing && isActive) props.onStopSpeaking();
              else props.onSpeakSentence(s.idx);
            }}
            title={
              props.playing && isActive
                ? "停止朗读（Space / 播放条的 ⏸ 也可以）"
                : "朗读这一句（读完自动停，不会连读下去）"
            }
          >
            <IconVolume size={13} style={{ verticalAlign: -1 }} />
            朗读本句
          </button>
          <button className="text-action-btn" onClick={() => props.onOpenXray(s.idx)} title="在右侧解析这句的主干与结构">
            句子解析
          </button>
          <button className="text-action-btn" onClick={() => props.onPracticeSentence(s.idx)} title="带着这句去口语陪练">
            <IconMic size={12} style={{ verticalAlign: -1 }} />
            用这句练口语 →
          </button>
          {s.zh && s.zhState !== "pending" && editingIdx !== s.idx && (
            <button className="text-action-btn" onClick={() => startEdit(s.idx, s.zh)} title="手改译文">
              <IconEdit size={12} />
              编辑译文
            </button>
          )}
        </div>
      </span>
    );
  };

  const registerPairRef = (idx: number) => (el: HTMLElement | null) => {
    if (el) pairRefs.current.set(idx, el);
    else pairRefs.current.delete(idx);
  };

  const spineLabel = props.book
    ? `${props.book.title} · CHAPTER ${props.book.chapterIdx + 1}`
    : article.title;

  return (
    <div className="reader-stage reading-spread">
      <div className="editorial-spine-col" aria-hidden>
        <div>
          <div className="oversized-folio-num tabular">
            {String(Math.min(activeIdx + 1, 99)).padStart(2, "0")}
          </div>
          <div className="spine-col-cap tabular">当前句</div>
        </div>
        <div className="spine-vertical-label" title={spineLabel}>
          {spineLabel}
        </div>
        <div className="spine-col-pct tabular">{Math.round(article.progress.percent)}%</div>
      </div>

      <div className="literary-spread-scroll" ref={scrollRef} onMouseUp={handleMouseUp}>
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

        <article
          className={[
            "literary-sheet",
            // 对照模式经 CSS 隐藏另一语种（reader-contrast-en / -zh），
            // 缺了这个 class 时视图菜单/设置抽屉怎么切都不生效。
            settings.contrastMode === "en" ? "reader-contrast-en" : "",
            settings.contrastMode === "zh" ? "reader-contrast-zh" : "",
            maskOn ? "reader-mask-on" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="masthead-top-meta tabular">
            <span className="masthead-meta-line">
              {props.book ? `CHAPTER ${props.book.chapterIdx + 1} · ` : ""}
              {article.wordCount} 词 · 约 {readMinutes} 分钟读完
              {article.level && <span className="chip chip-blue">{article.level}</span>}
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
              {props.onOpenToc && (
                <button className="pill-Ghost-btn" onClick={props.onOpenToc} title="章节目录">
                  目录
                </button>
              )}
            </span>
            <div className="masthead-switches">
              <button
                className="text-action-btn"
                onClick={() => props.onPatchSettings({ spotlightMode: !spotlight })}
                title="开启后非当前句变淡，注意力聚焦当前句"
              >
                专注模式：{spotlight ? "开" : "关"}
              </button>
              <button
                className="text-action-btn"
                onClick={() => props.onPatchSettings({ spreadLayout: spread === "prose" ? "parallel" : "prose" })}
                title="段落 = 行内英文流 + 当前句行间译文；双语对照 = 逐句双栏"
              >
                排版：{spread === "prose" ? "段落" : "双语对照"}
              </button>
              <button
                className="text-action-btn"
                onClick={() => props.onPatchSettings({ maskTranslation: !maskOn })}
                title="遮住译文先读原文，需要时再点开"
              >
                译文：{maskOn ? "隐藏" : "显示"}
              </button>
              <button
                className={`text-action-btn${quizOn ? " cloze-switch-on" : ""}`}
                onClick={() => props.onPatchSettings({ spotQuizMode: !quizOn })}
                title="已读句的词块/生词变行内填空：Enter 判分 · ? 首字母提示 · 按住 H 显影。只考读过的句子，本地判分不耗流量"
              >
                随读抽查：{quizOn ? "开" : "关"}
              </button>
            </div>
          </div>

          <h1 className="masthead-display-title">{article.title}</h1>
          <div className="masthead-cn-sub">
            {article.titleCn ? (
              <span className="masthead-cn-text">{article.titleCn}</span>
            ) : article.titleCnState === "failed" ? (
              <span className="masthead-cn-text" style={{ color: "var(--err)", fontSize: 13 }}>
                标题翻译失败
                {props.titleCnError ? <span style={{ opacity: 0.85 }}>（{props.titleCnError}）</span> : null}
                <button
                  style={{ marginLeft: 8, border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
                  onClick={props.onRetryTitle}
                >
                  重试
                </button>
              </span>
            ) : translating ? (
              <div style={{ maxWidth: 320 }}>
                <div className="reader-skeleton-line" style={{ width: "70%" }} />
              </div>
            ) : (
              <span className="masthead-cn-text" />
            )}
            {quizOn && clozeSlots.size > 0 && (
              <span
                className="cloze-meter tabular"
                title="随读抽查战绩：命中 · 接近 · 陷阱 · 待答"
              >
                抽查 {clozeTally.hit} 命中 · {clozeTally.close} 接近 · {clozeTally.trap} 陷阱 · 剩 {clozeTally.todo}
              </span>
            )}
            {props.onPracticeChapter && (
              <button className="pill-Ghost-btn active-lens" onClick={props.onPracticeChapter} title="带着本章内容去口语陪练">
                围绕本章练口语 →
              </button>
            )}
          </div>

          {spread === "prose" ? (
            <div className={`prose-body${spotlight ? " spotlight-active" : ""}`}>
              {sentences.map((s) => {
                const isActive = s.idx === activeIdx;
                return (
                  <Fragment key={s.idx}>
                    <span
                      ref={registerPairRef(s.idx)}
                      data-idx={s.idx}
                      className={`prose-sentence pair-en${isActive ? " is-current" : ""}${
                        s.zhState === "failed" ? " failed" : ""
                      }`}
                      onClick={handleProseClick}
                      title="点击定位到这一句"
                    >
                      {decorateEn(s, s.idx === 0)}
                    </span>
                    {isActive && renderFold(s, isActive)}
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <div className="parallel-spread-body">
              {sentences.map((s) => {
                const prev = sentences[s.idx - 1];
                const isParaStart = !prev || prev.paragraphIdx !== s.paragraphIdx;
                const isActive = s.idx === activeIdx;
                return (
                  <div
                    key={s.idx}
                    ref={registerPairRef(s.idx)}
                    data-idx={s.idx}
                    className={`parallel-spread-row${isParaStart ? " paragraph-start" : ""}${isActive ? " is-current" : ""}${
                      s.zhState === "failed" ? " failed" : ""
                    }`}
                    onClick={() => props.onJumpTo(s.idx)}
                    title="点击定位到这一句"
                  >
                    <div className="parallel-en pair-en" onClick={handleEnClick} title="单击查词，划选查短语">
                      {decorateEn(s, s.idx === 0)}
                    </div>
                    <div className="parallel-zh">{renderZhSide(s, isActive)}</div>
                  </div>
                );
              })}
            </div>
          )}

          {props.showFinishAction && (
            <div className="reader-finish-action">
              <button className="btn btn-primary" onClick={props.onFinishRead}>
                {props.finishLabel}
              </button>
              <span className="hint">已到文章末尾：确认读完，整理本篇收获或稍后复习。</span>
            </div>
          )}
        </article>
      </div>

      <div className="cloze-toast-layer" aria-live="polite">
        {clozeToasts.map((t) => (
          <span key={t.key} className={`cloze-toast tone-${t.tone}`}>
            <i className="t-dot" aria-hidden />
            {t.word} · {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 首字母下沉：首段是纯文本才拆（被高亮跨度占据时放弃下沉，不破坏标注）。 */
function applyDropCap(nodes: ReactNode[]): ReactNode[] {
  if (nodes.length === 0) return nodes;
  const first = nodes[0];
  if (typeof first !== "string" || first.length === 0) return nodes;
  return [
    <span key="drop-cap" className="drop-cap">
      {first.charAt(0)}
    </span>,
    first.slice(1),
    ...nodes.slice(1),
  ];
}

/** 跟读评测词着色：按字符区间给原文词上色（绿/黄/红，漏读加底纹）。 */
function renderMarkedEn(en: string, marks: WordMark[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let pos = 0;
  marks.forEach((mk, i) => {
    if (mk.start > pos) parts.push(en.slice(pos, mk.start));
    parts.push(
      <span key={i} className={`assess-w ${mk.quality}`} title={`${Math.round(mk.score * 20)} 分`}>
        {en.slice(mk.start, mk.end)}
      </span>,
    );
    pos = mk.end;
  });
  if (pos < en.length) parts.push(en.slice(pos));
  return parts;
}

/** 光标处的完整单词（阅读版式下正文内单击查词）。 */
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
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>从一篇短文开始</div>
        <div style={{ maxWidth: 400, lineHeight: 1.8 }}>
          挑一篇感兴趣的英文读进来——逐句精读，查过的词自动进生词本，隔天到期复习。
          内置分级文库不需要自己找材料。也可以在任意应用里选中文字，点浮窗上的「发送到阅读室」，或按
          <span className="kbd"> Ctrl</span>+<span className="kbd">Shift</span>+
          <span className="kbd">R</span>。
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onOpenImport}>
          添加阅读内容
        </button>
      </div>
    </div>
  );
}
