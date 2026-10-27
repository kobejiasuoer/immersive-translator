/**
 * 阅读舞台（2026-10-26 阅读页重构，原型 prototypes/reader-room-redesign-2026-10-26.html）。
 *
 * 结构：白卡主栏（.reading-toolbar 控件收口：遮罩开关/已揭开计数/全部揭开遮住/
 * 目录 chip/阅读设置 chip 开浮层）+ .reading-scrollpane（左缘 .reading-rail 竖向
 * 进度轨 + 居中 640px .reading-col：续读胶囊、32px 标题刊头、按段落分组的英文流）。
 *
 * 译文浮层 .translation-pop 绝对定位在当前句末行下方（getClientRects 直测，
 * 脱离文档流不拆段落）：veil「点击显示译文」/译文（点按回遮）/失败行/编辑输入
 * 与操作条（朗读/练口语/编辑译文）都在浮层里；句子解析入口唯一在右侧面板。
 *
 * 词块/生词着色、跟读着色、遮罩（parallel 分支 cn-frost/cn-slot）、手改译文、
 * 单段重试、随读抽查挖空、滚动跟随（pairRefs/onViewportIdx）全部保留复用。
 * 键位切分线：本组件只监听 Esc（关自己的设置浮层）与 E（触发 onOpenXray，
 * 仅解析面板 idle 速览态，已解析句不重复发请求）；
 * Space/J/K/L/H 全在 ReaderApp，peekAll 为只读 prop（按住 H 时浮层临时全显）。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  IconBookOpen,
  IconClose,
  IconEdit,
  IconEyeOff,
  IconList,
  IconMic,
  IconSettings,
  IconVolume,
} from "../ui/icons";
import {
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  type Article,
  type ReaderSettings,
  type SentenceChunk,
  type SentencePair,
} from "../core/readerTypes";
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
  /** 导入入口（propContracts 契约：升级为可选 tab 直达；空态用缺省文库 tab）。 */
  onOpenImport: (tab?: "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed") => void;
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
  /** 控件收口后的持久设置通道（遮罩/排版/字号/短语虚线/专注/随读抽查）。 */
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  /** 快捷键 E / 右侧面板 CTA：请求当前句的结构解析。 */
  onOpenXray: (idx: number) => void;
  /**
   * 解析面板对当前句是否处于速览 idle 态（无 loading/ready/error 记录）：
   * E 快捷键仅此时触发解析（原型 L697 仅 idle 响应 E），避免对已解析句
   * 重复发 LLM 请求；CTA 本身只在 idle 分支渲染，无需此判断。
   */
  xrayIdle: boolean;
  /** 浮层操作条「用这句练口语」。 */
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

/** 续读胶囊 / 设置 chip 用的书签图标（原型 <symbol id="bookmark">，Feather 风格内联）。 */
function IconBookmark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />
    </svg>
  );
}

export function ReadingView(props: Props) {
  const { article, settings, activeIdx, translating, chunking, peekAll, searchMatchIdx } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const pairRefs = useRef(new Map<number, HTMLElement>());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // ---- 控件收口后的本地 UI 态（不落盘）----
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resumeHidden, setResumeHidden] = useState(false);
  /** 段落态下的本地句卡开关（原型「逐句」，无持久字段）。 */
  const [sentCards, setSentCards] = useState(false);

  const sentences = article?.sentences ?? [];
  const maskOn = settings.maskTranslation;
  const spotlight = settings.spotlightMode ?? false;
  const spread = settings.spreadLayout ?? "prose";
  const revealedCount = maskOn
    ? sentences.filter((s) => s.zh && (s.revealed || peekAll)).length
    : 0;
  const maskableCount = maskOn ? sentences.filter((s) => s.zh).length : 0;

  // 换文时续读胶囊复位（每篇都有自己的断点）。
  useEffect(() => setResumeHidden(false), [article?.id]);

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

  /** 正文按 paragraphIdx 分组（句间补空格 + 段落间距；parallel 分支仍逐行渲染）。 */
  const paragraphGroups = useMemo(() => {
    const groups: SentencePair[][] = [];
    for (const s of sentences) {
      const g = groups[groups.length - 1];
      if (g && g[g.length - 1].paragraphIdx === s.paragraphIdx) g.push(s);
      else groups.push([s]);
    }
    return groups;
  }, [sentences]);

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

  // ---- 译文浮层定位（原型 place() 的 React 版）----
  // 取当前句 getClientRects() 的最后一个 rect（末行），换算回 .reading-col 坐标：
  // top = 末行 bottom − col.top + 10（贴末行下方）；箭头 --ax = 末行 right − col.left
  // − 24(col padding) − 20(箭头半宽)，clamp 到 [16, col 宽 − 48 − 44] 不溢出。
  // 禁原型 fit() 的 k 缩放系数（真实窗口无整体 scale，getBoundingClientRect 直测）。
  const placeRafRef = useRef(0);
  const placePop = useCallback(() => {
    const pop = popRef.current;
    const col = colRef.current;
    if (!pop || !col) return;
    const s = pairRefs.current.get(activeIdx);
    if (!s) return;
    const colRect = col.getBoundingClientRect();
    const rects = s.getClientRects();
    const last = rects[rects.length - 1];
    if (!colRect || !last) return; // jsdom / 元素不可见（如仅中文模式句已隐藏）
    const top = last.bottom - colRect.top + 10;
    const ax = last.right - colRect.left - 24 - 20;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.setProperty("--ax", `${Math.round(Math.min(Math.max(ax, 16), Math.max(16, col.offsetWidth - 48 - 44)))}px`);
  }, [activeIdx]);

  const schedulePlace = useCallback(() => {
    if (placeRafRef.current) window.cancelAnimationFrame(placeRafRef.current);
    placeRafRef.current = window.requestAnimationFrame(placePop);
  }, [placePop]);

  // 重放时机对齐原型：换句/字号/排版/句卡/专注/续读关闭/译文状态变化 + resize + fonts.ready。
  useEffect(() => {
    schedulePlace();
    window.addEventListener("resize", schedulePlace);
    let alive = true;
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready
        .then(() => {
          if (alive) schedulePlace();
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      window.removeEventListener("resize", schedulePlace);
      if (placeRafRef.current) window.cancelAnimationFrame(placeRafRef.current);
    };
  }, [
    schedulePlace,
    article,
    spread,
    sentCards,
    spotlight,
    settings.fontSize,
    settings.lineHeight,
    settings.fontPair,
    settings.contrastMode,
    maskOn,
    peekAll,
    resumeHidden,
    editingIdx,
    settingsOpen,
    translating,
    chunking,
  ]);

  // ---- 专注模式语义合并：既有聚光降透明（.spotlight-active）+ 隐藏右栏 ----
  // 经 ref 在最近 .reader-root 写 data-side-hidden 与 --reading-side-w（dock 居中
  // 契约共用；卸载/关闭时清除，避免脏值带到其他视图）。
  useEffect(() => {
    // closest 返回 Element；.reader-root 恒为 div（ReaderApp.tsx 及各 preview 入口），
    // 收窄为 HTMLElement 才能写 style（CSS 变量 --reading-side-w）。
    const root = stageRef.current?.closest(".reader-root") as HTMLElement | null;
    if (!root) return;
    if (spotlight) {
      root.setAttribute("data-side-hidden", "");
      root.style.setProperty("--reading-side-w", "0px");
    } else {
      root.removeAttribute("data-side-hidden");
      root.style.removeProperty("--reading-side-w");
    }
    return () => {
      root.removeAttribute("data-side-hidden");
      root.style.removeProperty("--reading-side-w");
    };
  }, [spotlight]);

  // ---- 键位切分线：本组件只加 Esc（关自己的设置浮层）与 E（onOpenXray）----
  // Space/J/K/L/H 与 peekAll 的 H 全在 ReaderApp；输入框（挖空/译文编辑/检索）
  // 自接管按键，这里让路（e.target 过滤 + 挖空输入已 stopPropagation）。
  // E 仅在解析面板 idle（速览态）时触发，与原型 side[data-state=idle] 口径
  // 一致——已解析/解析中/解析失败的句子按 E 不再重复发请求（重试走面板内按钮）。
  useEffect(() => {
    function isTyping(el: EventTarget | null): boolean {
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        setSettingsOpen(false);
      } else if (k === "e" && article && props.xrayIdle) {
        props.onOpenXray(activeIdx);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, activeIdx, props.onOpenXray, props.xrayIdle]);

  // 设置浮层：点浮层外关闭（浮层内与触发 chip 自身的点击不吃）。
  useEffect(() => {
    if (!settingsOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".reading-settings-pop, .reading-settings-chip")) return;
      setSettingsOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [settingsOpen]);

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
      <div className="reader-stage reading-spread">
        <EmptyState onOpenImport={props.onOpenImport} />
      </div>
    );
  }

  const total = sentences.length;
  const resumeIdx = article.progress.sentenceIdx;
  const showResume = resumeIdx > 0 && resumeIdx < total && !translating && !resumeHidden;
  const readMinutes = Math.max(1, Math.round(article.wordCount / 200));
  /** 左轨与 dock 同口径：光标句 / 总句数（跟随播放与滚动阅读）。 */
  const railPct = total > 0 ? Math.max(1, Math.round(((activeIdx + 1) / total) * 100)) : 0;
  const themeLabel: Record<ReaderSettings["theme"], string> = {
    light: "纸书",
    dark: "深色",
    sepia: "护眼",
    oled: "纯黑",
  };

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

  /** 手改译文编辑器（沿用既有 pair-cn-editor 结构，浮层与对照行共用）。 */
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
          {s.zh && s.zhState !== "pending" && editingIdx !== s.idx && (
            <button className="icon-btn" onClick={() => startEdit(s.idx, s.zh)} title="手改译文">
              <IconEdit size={12} />
            </button>
          )}
        </div>
      </>
    );
  };

  /**
   * 译文浮层（prose 模式当前句，脱离文档流）：
   * veil → 译文（点按回遮）→ 操作行；失败行与编辑输入也迁入浮层。
   * 句子解析入口唯一化：只在右侧解析面板（CTA / 快捷键 E），浮层不再重复。
   */
  const renderTranslationPop = (s: SentencePair) => {
    const isActive = s.idx === activeIdx;
    const masked =
      maskOn && !!s.zh && s.zhState !== "failed" && editingIdx !== s.idx && !(!!s.revealed || peekAll);
    return (
      <div className="translation-pop" ref={popRef} onClick={(e) => e.stopPropagation()}>
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
        ) : masked ? (
          <button
            type="button"
            className="pop-veil"
            onClick={() => props.onReveal(s.idx)}
            title="点按显示这一句的译文"
          >
            <IconEyeOff size={14} />
            点击显示译文
          </button>
        ) : (
          <>
            <div
              className="pop-zh"
              onClick={() => {
                if (maskOn) props.onMask(s.idx);
              }}
              title={maskOn ? "点按重新遮住" : undefined}
              style={{ cursor: maskOn ? "pointer" : undefined }}
            >
              {s.zhState === "pending"
                ? translating || s.zh
                  ? s.zh ?? <span className="reader-skeleton-line" style={{ width: 160, display: "inline-block" }} />
                  : "译文待生成"
                : s.zh}
            </div>
            <div className="pop-actions">
              <button
                type="button"
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
                朗读本句
              </button>
              <button type="button" onClick={() => props.onPracticeSentence(s.idx)} title="带着这句去口语陪练">
                <IconMic size={12} />
                用这句练口语
              </button>
              {s.zh && s.zhState !== "pending" && editingIdx !== s.idx && (
                <button type="button" onClick={() => startEdit(s.idx, s.zh)} title="手改译文">
                  <IconEdit size={12} />
                  编辑译文
                </button>
              )}
              {maskOn && (
                <span className="sp">
                  按住 <span className="kbd">H</span> 看译文
                </span>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const registerPairRef = (idx: number) => (el: HTMLElement | null) => {
    if (el) pairRefs.current.set(idx, el);
    else pairRefs.current.delete(idx);
  };

  const currentSentence = spread === "prose" ? sentences[activeIdx] : undefined;

  return (
    <div className="reader-stage reading-spread" ref={stageRef}>
      {/* ---- 工具栏：控件收口（遮罩开关 + 计数/全部揭开遮住 + 目录 chip + 设置 chip）---- */}
      <div className="reading-toolbar">
        <span className="reading-toolbar-meta">
          {props.book ? `${props.book.title} · 第 ${props.book.chapterIdx + 1}/${props.book.chapterCount} 章` : ""}
          {props.book ? " · " : ""}
          {article.wordCount.toLocaleString()} 词 · 约 {readMinutes} 分钟
          {article.level && <span className="tag">{article.level}</span>}
          {translating && (
            <span className="reading-status-chip">
              翻译中 {translating.done}/{translating.total} 段
            </span>
          )}
          {!translating && chunking && (
            <span className="reading-status-chip">
              词块标注中 {chunking.done}/{chunking.total} 批
            </span>
          )}
        </span>
        <div className="reading-mask-ctl" title="遮住译文先读原文，需要时再点开；按住 H 临时全显">
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={maskOn}
            aria-label="译文遮罩"
            onClick={() => props.onPatchSettings({ maskTranslation: !maskOn })}
          />
          <span className="reading-mask-label">译文遮罩</span>
          <span className="reading-mask-count">
            {maskOn ? `已揭开 ${revealedCount} / ${maskableCount} 句` : "译文常显"}
          </span>
          {maskOn && revealedCount < maskableCount && (
            <button type="button" className="btn sm" onClick={props.onRevealAll}>
              全部揭开
            </button>
          )}
          {maskOn && revealedCount > 0 && (
            <button type="button" className="btn sm" onClick={props.onMaskAll}>
              全部遮住
            </button>
          )}
        </div>
        {quizOn && clozeSlots.size > 0 && (
          <span className="cloze-meter tabular" title="随读抽查战绩：命中 · 接近 · 陷阱 · 待答">
            抽查 {clozeTally.hit} 命中 · {clozeTally.close} 接近 · {clozeTally.trap} 陷阱 · 剩 {clozeTally.todo}
          </span>
        )}
        {props.onOpenToc && (
          <button type="button" className="chip" onClick={props.onOpenToc} title="章节目录">
            <IconList size={14} />
            目录
          </button>
        )}
        <button
          type="button"
          className={`chip reading-settings-chip${settingsOpen ? " on" : ""}`}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          title="排版 / 字号 / 专注 / 短语虚线 / 随读抽查都收在这里"
        >
          <IconSettings size={14} />
          阅读设置
        </button>
      </div>

      {/* ---- 阅读设置浮层（排版/句卡/字号/短语虚线/专注/随读抽查/主题只读）---- */}
      {settingsOpen && (
        <div className="reading-settings-pop" role="dialog" aria-label="阅读设置">
          <div className="reading-settings-opt">
            <span className="opt-label">排版</span>
            <div className="seg">
              <button
                type="button"
                className={spread === "prose" ? "active" : ""}
                onClick={() => props.onPatchSettings({ spreadLayout: "prose" })}
                title="段落 = 行内英文流 + 当前句译文浮层"
              >
                段落
              </button>
              <button
                type="button"
                className={spread === "parallel" ? "active" : ""}
                onClick={() => props.onPatchSettings({ spreadLayout: "parallel" })}
                title="双语对照 = 逐句双栏"
              >
                对照
              </button>
            </div>
          </div>
          <div className="reading-settings-opt" title="段落排版下把每句拆成独立句卡（只影响本窗口，不落盘）">
            <span className="opt-label">句卡</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={sentCards && spread === "prose"}
              aria-label="句卡"
              disabled={spread !== "prose"}
              onClick={() => setSentCards((v) => !v)}
            />
          </div>
          <div className="reading-settings-opt">
            <span className="opt-label">字号</span>
            <div className="drawer-stepper">
              <button
                type="button"
                onClick={() =>
                  props.onPatchSettings({ fontSize: Math.max(READER_FONT_SIZE_MIN, settings.fontSize - 1) })
                }
                disabled={settings.fontSize <= READER_FONT_SIZE_MIN}
                aria-label="减小字号"
              >
                −
              </button>
              <span className="val">{settings.fontSize}</span>
              <button
                type="button"
                onClick={() =>
                  props.onPatchSettings({ fontSize: Math.min(READER_FONT_SIZE_MAX, settings.fontSize + 1) })
                }
                disabled={settings.fontSize >= READER_FONT_SIZE_MAX}
                aria-label="增大字号"
              >
                +
              </button>
            </div>
          </div>
          <div className="reading-settings-opt" title="词块/生词在正文里用虚线标记，点击看释义并可收藏">
            <span className="opt-label">短语虚线</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={settings.chunkHighlight}
              aria-label="短语虚线"
              onClick={() => props.onPatchSettings({ chunkHighlight: !settings.chunkHighlight })}
            />
          </div>
          <div className="reading-settings-opt" title="非当前句变淡 + 收起右侧解析面板，注意力聚焦当前句">
            <span className="opt-label">专注模式</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={spotlight}
              aria-label="专注模式"
              onClick={() => props.onPatchSettings({ spotlightMode: !spotlight })}
            />
          </div>
          <div
            className="reading-settings-opt"
            title="已读句的词块/生词变行内填空：Enter 判分 · ? 首字母提示 · 按住 H 显影。只考读过的句子，本地判分不耗流量"
          >
            <span className="opt-label">随读抽查</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={quizOn}
              aria-label="随读抽查"
              onClick={() => props.onPatchSettings({ spotQuizMode: !quizOn })}
            />
          </div>
          <div className="reading-settings-opt">
            <span className="opt-label">主题</span>
            <span className="reading-settings-theme">{themeLabel[settings.theme]}</span>
          </div>
        </div>
      )}

      {/* ---- 正文滚动区：左缘进度轨 + 居中 640px 列 ---- */}
      <div
        className={[
          "reading-scrollpane",
          // 对照模式经 CSS 隐藏另一语种（reader-contrast-en / -zh），
          // 缺了这个 class 时视图菜单/设置抽屉怎么切都不生效。
          settings.contrastMode === "en" ? "reader-contrast-en" : "",
          settings.contrastMode === "zh" ? "reader-contrast-zh" : "",
          maskOn ? "reader-mask-on" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ref={scrollRef}
        onMouseUp={handleMouseUp}
      >
        <div className="reading-rail" aria-hidden>
          <span className="rail-pct tabular">{railPct}%</span>
          <div className="rail-track">
            <i style={{ height: `${railPct}%` } as CSSProperties} />
          </div>
          <span className="rail-label" title={props.book ? props.book.title : article.title}>
            {props.book ? `CHAPTER ${props.book.chapterIdx + 1}` : article.title}
          </span>
        </div>

        <div className="reading-col" ref={colRef}>
          {showResume && (
            <div className="resume-capsule" role="status">
              <IconBookmark size={14} />
              <span>
                上次读到 <b>第 {resumeIdx + 1} 句</b>
              </span>
              <button
                type="button"
                className="go"
                onClick={() => {
                  setResumeHidden(true);
                  props.onJumpTo(resumeIdx);
                }}
                title="回到上次读到的句子"
              >
                回到那里
              </button>
              <button
                type="button"
                className="x"
                onClick={() => setResumeHidden(true)}
                aria-label="关闭续读提示"
                title="只是隐藏提示，断点仍在"
              >
                <IconClose size={12} />
              </button>
            </div>
          )}

          <div className="reading-head">
            {props.book && (
              <div className="reading-eyebrow">
                CHAPTER {props.book.chapterIdx + 1} · {props.book.title.toUpperCase()}
              </div>
            )}
            <h1 className="reading-title">{article.title}</h1>
            <div className="reading-subtitle">
              {article.titleCn ? (
                <span className="reading-subtitle-cn">{article.titleCn}</span>
              ) : article.titleCnState === "failed" ? (
                <span className="reading-subtitle-cn" style={{ color: "var(--err)", fontSize: 13 }}>
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
                <span className="reading-subtitle-cn">
                  <span className="reader-skeleton-line" style={{ width: "70%", display: "inline-block" }} />
                </span>
              ) : (
                <span className="reading-subtitle-cn" />
              )}
              {props.onPracticeChapter && (
                <button
                  type="button"
                  className="btn sm reading-practice-btn"
                  onClick={props.onPracticeChapter}
                  title="带着本章内容去口语陪练"
                >
                  <IconMic size={12} />
                  围绕本章练口语
                </button>
              )}
            </div>
          </div>

          {spread === "prose" ? (
            <div className={`prose-body${spotlight ? " spotlight-active" : ""}${sentCards ? " sent-cards" : ""}`}>
              {paragraphGroups.map((group) => (
                <p key={group[0].idx} className="prose-paragraph">
                  {group.map((s, si) => (
                    <Fragment key={s.idx}>
                      {si > 0 ? " " : null}
                      <span
                        ref={registerPairRef(s.idx)}
                        data-idx={s.idx}
                        className={`prose-sentence pair-en${s.idx === activeIdx ? " is-current" : ""}${
                          s.zhState === "failed" ? " failed" : ""
                        }`}
                        onClick={handleProseClick}
                        title="点击定位到这一句"
                      >
                        {decorateEn(s, s.idx === 0)}
                      </span>
                    </Fragment>
                  ))}
                </p>
              ))}
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

          {/* 译文浮层：脱离文档流，锚在当前句末行下方（placePop 直测定位） */}
          {currentSentence && renderTranslationPop(currentSentence)}
        </div>
      </div>

      {/* 正文下方渐隐：给居中 dock 让出视觉过渡，不盖字 */}
      <div className="reading-fade" aria-hidden />

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

/** 导入弹窗直达 tab（与 ReaderApp 的 ImportOpenTab 同集合，本文件独立声明避免循环依赖）。 */
type ReadingImportTab = "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed";

function EmptyState({
  onOpenImport,
}: {
  /** 与 props.onOpenImport 同签名：带可选 tab。不能收窄成 () => void——
      那会让 onClick={onOpenImport} 直传通过编译，点击事件对象被当成 tab
      传下去后导入弹窗七个 tab 全不命中、主体不渲染（2026-10-26 回归）。 */
  onOpenImport: (tab?: ReadingImportTab) => void;
}) {
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
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => onOpenImport()}>
          添加阅读内容
        </button>
      </div>
    </div>
  );
}
