import { openPractice } from "./LearningHome";
/** Continuous English reading, with help requested only after selecting text. */
import { useCallback, useEffect, useMemo, useRef, useState, useId, type CSSProperties } from "react";
import { actions, activeRepository, effectiveSentenceZh, flushPersist, getState, speak, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { cloudState, useCloud } from "../services/cloud";
import { tokenize, useSavedKeys } from "../tokenizer";
import { norm } from "../core/judge";
import { startTranslate } from "../services/translate";
import type { Article, SentenceChunk } from "../core/types";
import type { DictEntry } from "../store";
import { SentenceSheet } from "../components/reading/SentenceSheet";
import { EditTranslationSheet } from "../components/reading/EditTranslationSheet";
import { ContentsSheet } from "../components/reading/ContentsSheet";
import { LookupSheet } from "../components/reading/LookupSheet";
import { SettingsSheet } from "../components/reading/SettingsSheet";
import { minutesOf, sourceLabelOf } from "../components/reading/meta";
import { clampSentence, readingParagraphs } from "../core/readerPresentation";
import { chapterIndexOf } from "../core/readingLibrary";
import "../ui/readerExperience.css";

/* 语速档（与阅读设置抽屉同一档位；播放条 pill 循环切换，原型 read-cycle-speed 口径） */
const RATE_TIERS = [0.65, 0.85, 1, 1.15];
function nearestRate(value: number): number {
  return RATE_TIERS.reduce((best, t) => (Math.abs(t - value) < Math.abs(best - value) ? t : best), RATE_TIERS[0]);
}

/** 阅读域抽屉（本页局部状态；词典卡仍走全局 setSheet，保证叠层与复用）。 */
type ReadingDrawerState =
  | { type: "sentence"; idx: number }
  | { type: "edit"; idx: number }
  | { type: "toc" }
  | { type: "lookup"; idx: number }
  | { type: "settings" }
  | null;

export default function ReaderScreen({ article }: { article: Article }) {
  const nav = useNav();
  const { account, generation: cloudGeneration } = useCloud();
  const vocab = useApp((s) => s.vocab);
  const prefs = useApp((s) => s.reader);
  const savedSent = useApp((s) => s.progress[article.id] ?? 0);
  const readerTarget = useApp((s) => s.readerTarget);
  const allArticles = useApp((s) => s.articles);
  const zhOverrides = useApp((s) => s.sentenceZh[article.id]);
  const finished = useApp((s) => !!s.readingCompleted[article.id]);
  const fontScale = useApp((s) => s.settings.fsScale);
  const paragraphs = useMemo(() => readingParagraphs(article), [article.sentences, article.paragraphStarts]);
  const sourceKey = useMemo(() => article.sentences.map(s => s.en).join("\u001f"), [article.sentences]);
  const previousSource = useRef(sourceKey);
  const masked = true;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /* 目录抽屉数据：书模式=同书各章（chapterIndex 排序）；非书=全部可读文档 */
  const tocArticles = useMemo(() => {
    if (article.bookId) {
      return allArticles
        .filter((a) => a.bookId === article.bookId && !a.archived)
        .sort((a, b) => chapterIndexOf(a) - chapterIndexOf(b));
    }
    return allArticles.filter((a) => !a.archived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allArticles, article.bookId]);

  const [drawer, setDrawer] = useState<ReadingDrawerState>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsId = useId();
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  const dismissedSelection = useRef("");
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const globalSheet = useApp(s => s.sheet);

  const savedKeys = useSavedKeys(vocab.map((v) => v.word));
  const [sent, setSent] = useState(clampSentence(savedSent, article.sentences.length));
  const [playingIdx, setPlayingIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [translating, setTranslating] = useState<Set<number>>(new Set());
  /** 未配置模型时点过「翻译这句」的句子：skeleton 即撤、呈引导（治降级断头，不产出伪译文） */
  const [uncfg, setUncfg] = useState<Set<number>>(new Set());
  const [translationDrafts, setTranslationDrafts] = useState<Record<number, string>>({});
  const [translationErrors, setTranslationErrors] = useState<Record<number, string>>({});
  const [temporaryTranslations, setTemporaryTranslations] = useState<Record<number, string>>({});
  const presentedArticle = useMemo(() => Object.keys(temporaryTranslations).length ? {
    ...article,
    sentences: article.sentences.map(sentence => ({ ...sentence, zh: temporaryTranslations[sentence.idx] || sentence.zh })),
  } : article, [article, temporaryTranslations]);
  const mounted = useRef(true);
  const pendingRead = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const play = useRef({ active: false, idx: -1 });
  /** 播放代际：每次 playFrom 自增，旧 utterance 的回调（onend/兜底）凭 gen 失效（治 P-23） */
  const playGen = useRef(0);
  /** 程序性滚动锁：scrollToSent 后 600ms 内不按「视口顶句」回写进度/计数（治 P-21） */
  const progLockUntil = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translations = useRef(new Map<number, { stop(): void }>());
  const previousCloud = useRef({ id: account?.id ?? null, generation: cloudGeneration });
  const previousRepository = useRef(activeRepository());

  /* 打开即恢复断点 */
  useEffect(() => {
    mounted.current = true;
    actions.setReading(article.id);
    const initial = clampSentence(savedSent, article.sentences.length);
    setSent(initial);
    setDrawer(null);
    setControlsOpen(false);
    clearSelection();
    setRevealed(new Set());
    setTranslationDrafts({});
    setTranslationErrors({});
    setTemporaryTranslations({});
    setTranslating(new Set());
    pendingRead.current = null;
    if (article.sentences.length) {
      actions.setProgress(article.id, initial);
      actions.markRead(article.id, initial);
    }
    const t = setTimeout(() => scrollToSent(clampSentence(savedSent, article.sentences.length), true), 60);
    return () => {
      mounted.current = false;
      if (pendingRead.current !== null) actions.setProgress(article.id, pendingRead.current);
      clearTimeout(t);
      play.current.active = false;
      playGen.current++; /* 失效所有在途回调 */
      stopSpeak();
      translations.current.forEach(engine => engine.stop());
      translations.current.clear();
      /* 滚动防抖一并清（治 home-6）：退出前 300ms 内最后一次滚动的回调在卸载后触发，
         bodyRef 已被置空直接 return——最后一段滚动进度不落盘，断点回退到旧句 */
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id]);

  useEffect(() => {
    if (previousSource.current !== sourceKey) {
      cancelTranslation();
      stopPlay();
      setDrawer(null);
      clearSelection();
      setRevealed(new Set());
      setTemporaryTranslations({});
      setTranslationErrors({});
      pendingRead.current = null;
      const restored = clampSentence(savedSent, article.sentences.length);
      setSent(restored);
      scrollToSent(restored, true);
    }
    previousSource.current = sourceKey;
  }, [sourceKey]);

  useEffect(() => {
    const previous = previousCloud.current;
    const id = account?.id ?? null;
    const guestLogin = previous.id === null && id !== null;
    if (!guestLogin && (previous.id !== id || previous.generation !== cloudGeneration)) {
      cancelTranslation();
      stopPlay();
      pendingRead.current = null;
      setDrawer(null);
      clearSelection();
      setRevealed(new Set());
    }
    previousCloud.current = { id, generation: cloudGeneration };
  }, [account?.id, cloudGeneration]);

  useEffect(() => {
    const changed = () => {
      const next = activeRepository();
      const guestLogin = previousRepository.current.identity === "guest" && next.identity === cloudState().account?.id;
      if (!guestLogin) {
        cancelTranslation(); stopPlay(); pendingRead.current = null; setDrawer(null); clearSelection(); setRevealed(new Set());
        const current = getState().articles.find(a => a.id === article.id);
        if (current) setSent(clampSentence(getState().progress[article.id] ?? 0, current.sentences.length));
      }
      previousRepository.current = next;
    };
    window.addEventListener("mobile-profile-change", changed);
    return () => window.removeEventListener("mobile-profile-change", changed);
  }, []);

  useEffect(() => {
    const flushReading = () => {
      if (pendingRead.current !== null) {
        actions.setProgress(article.id, pendingRead.current);
        actions.markRead(article.id, pendingRead.current);
        pendingRead.current = null;
      }
      void flushPersist().catch(error => console.warn("阅读断点保存失败", error));
    };
    const hidden = () => { if (document.visibilityState === "hidden") flushReading(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flushReading);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", flushReading); };
  }, [article.id]);

  useEffect(() => {
    const current = clampSentence(sent, article.sentences.length);
    if (current !== sent) {
      cancelTranslation();
      stopPlay();
      setSent(current);
      if (article.sentences.length) actions.setProgress(article.id, current);
      scrollToSent(current, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.sentences.length]);

  // Type changes can reflow the document; keep its logical place.
  useEffect(() => {
    clearSelection();
    const target = pendingRead.current ?? sent;
    if (pendingRead.current !== null) {
      setSent(target);
      actions.setProgress(article.id, target);
      actions.markRead(article.id, target);
    }
    progLockUntil.current = Date.now() + 600;
    const timer = setTimeout(() => scrollToSent(target, true), 40);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.fs, prefs.lh, fontScale]);

  const scrollToSent = useCallback(
    (i: number, instant = false) => {
      // An explicit jump supersedes older manual scrolling, including its delayed save.
      if (scrollTimer.current) { clearTimeout(scrollTimer.current); scrollTimer.current = null; }
      pendingRead.current = null;
      /* 程序性滚动（断点恢复/词典定位/播放跳句/上下句）：600ms 内 onScroll 不回写（治 P-21） */
      progLockUntil.current = Date.now() + 600;
      const body = bodyRef.current;
      const el = body?.querySelector(`[data-si="${i}"]`);
      if (!body || !el) return;
      if (i === 0 && instant) {
        body.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      /* U-06：连播推进时目标句在视口 25%–65% 舒适带内不滚，带外才动；
         断点恢复（instant）不做带判定，直接定位到视口 30% 处（proto-parity：reader-classic5）。 */
      const rect = el.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const rel = bodyRect.height > 0 ? (rect.top - bodyRect.top) / bodyRect.height : 0;
      if (!instant && rel >= 0.25 && rel <= 0.65) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      const delta = rect.top - bodyRect.top - body.clientHeight * 0.3;
      body.scrollTo({ top: body.scrollTop + delta, behavior: instant || reduce ? "auto" : "smooth" });
    },
    [],
  );

  /* 夜间深色主题作用域（reader-starter-dark）：topic=black 时把 dark 令牌挂到 push 根，
     页头/工具行/正文/播放条同源换肤；退出或换主题时摘除。 */
  useEffect(() => {
    const host = bodyRef.current?.closest(".push");
    if (!host) return;
    host.setAttribute("data-reader-topic", prefs.topic);
    if (prefs.topic === "black") host.setAttribute("data-reader-dark", "1");
    else host.removeAttribute("data-reader-dark");
    return () => { host.removeAttribute("data-reader-dark"); host.removeAttribute("data-reader-topic"); };
  }, [prefs.topic]);

  /* 词典卡「定位回读」 */
  useEffect(() => {
    if (readerTarget && readerTarget.articleId === article.id) {
      setSent(readerTarget.sent);
      actions.setProgress(article.id, readerTarget.sent);
      actions.markRead(article.id, readerTarget.sent);
      setTimeout(() => scrollToSent(readerTarget.sent, true), 40);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerTarget?.nonce]);

  function stepTo(next: number, gen: number) {
    const clamped = Math.max(0, Math.min(article.sentences.length - 1, next));
    if (!article.sentences[clamped]) { stopPlay(); return; }
    setSent(clamped);
    setPlayingIdx(clamped);
    scrollToSent(clamped);
    /* 连播推进期间滚动被 progLock 抑制，进度在这里显式落账，退出/重进不断档（治 P-21） */
    actions.setProgress(article.id, clamped);
    actions.markRead(article.id, clamped);
    if (play.current.active) {
      speak(article.sentences[clamped].en, prefsRef.current.rate, () => {
        if (gen !== playGen.current || !play.current.active) return;
        if (clamped + 1 >= article.sentences.length) stopPlay();
        else {
          play.current.idx = clamped + 1;
          setSent(clamped + 1);
          stepTo(clamped + 1, gen);
        }
      }, "en", stopPlay);
    }
  }

  function playFrom(i: number, single: boolean) {
    if (!article.sentences[i]) return;
    const gen = ++playGen.current; /* 新播放使旧 utterance 的 onend/onerror/兜底全部失效（治 P-23） */
    play.current.active = true;
    play.current.idx = i;
    setPlaying(true);
    setPlayingIdx(i);
    setSent(i);
    /* 单句试听不落进度（治 home-3）：此前点最后一句试听即 progress=len-1，文章被判
       「已读完」，今天页「继续阅读」卡与书架「继续读」钉标随之消失；连播才推进落账。 */
    if (!single) actions.setProgress(article.id, i);
    actions.markRead(article.id, i);
    scrollToSent(i);
    speak(article.sentences[i].en, prefsRef.current.rate, () => {
      if (gen !== playGen.current || !play.current.active) return;
      if (single) {
        stopPlay();
        return;
      }
      if (i + 1 >= article.sentences.length) {
        stopPlay();
        return;
      }
      play.current.idx = i + 1;
      setSent(i + 1);
      stepTo(i + 1, gen);
    }, "en", stopPlay);
  }

  function stopPlay() {
    play.current.active = false;
    playGen.current++; /* 在途回调（兜底计时器）一并失效 */
    setPlaying(false);
    setPlayingIdx(-1);
    stopSpeak();
  }

  /* 滚动写进度（防抖，治 I5）；程序性滚动加锁期间跳过，不与断点恢复/定位/跳句打架（治 P-21）。
     「当前句」取视口 30% 阅读线上方最近的句子——与 scrollToSent 的断点定位（视口 30%）同一线，
     恢复断点后高亮句与停留位置一致（proto-parity reader-classic5）。 */
  function onScroll() {
    clearSelection();
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (Date.now() < progLockUntil.current) return;
    pendingRead.current = currentViewportSentence();
    scrollTimer.current = setTimeout(() => {
      if (Date.now() < progLockUntil.current) return;
      const cur = currentViewportSentence();
      setSent(cur);
      actions.setProgress(article.id, cur);
      actions.markRead(article.id, cur);
      pendingRead.current = null;
    }, 300);
  }

  function currentViewportSentence() {
    const body = bodyRef.current;
    if (!body) return sent;
    const bodyTop = body.getBoundingClientRect().top;
    const line = Math.max(60, body.clientHeight * 0.3);
    let current = 0;
    body.querySelectorAll<HTMLElement>("[data-si]").forEach(el => {
      if (el.getBoundingClientRect().top - bodyTop <= line) current = Number(el.dataset.si);
    });
    return clampSentence(current, article.sentences.length);
  }

  /* 点词 → 词典卡（词块态 / 已收藏态 / 内容预置词条态 / 未收录态）。
     预置词条（article.termMeta，原型 doc.terms）优先于未收录兜底：入门文的 quiet 等
     未收藏预置词也能给出音标/词性释义卡（proto-parity sheet-lookup 口径）。 */
  function openDict(surface: string, chunk: SentenceChunk | undefined, sentIdx: number) {
    const key = norm(surface);
    const keyBase = key.endsWith("s") ? key.slice(0, -1) : key;
    const saved = vocab.find((v) => norm(v.word) === key || norm(v.word) === keyBase);
    const sentEl = article.sentences[sentIdx];
    if (chunk) {
      const entry: DictEntry = {
        type: "chunk",
        word: chunk.word || chunk.text,
        chunkType: chunk.chunkType ? CHUNK_TYPE_LABEL[chunk.chunkType] : undefined,
        phonetic: chunk.phonetic,
        senses: [{ pos: chunk.pos || (chunk.chunkType ? CHUNK_TYPE_LABEL[chunk.chunkType] : ""), cn: chunk.gloss }],
        sentence: sentEl?.en,
        articleId: article.id,
        sentIdx,
        saved: !!saved,
      };
      actions.setSheet({ kind: "dict", entry });
      return;
    }
    if (saved) {
      const entry: DictEntry = {
        type: saved.kind === "chunk" ? "chunk" : "word",
        word: saved.word,
        chunkType: saved.chunkType,
        phonetic: saved.phonetic,
        senses: saved.senses,
        sentence: sentEl?.en,
        articleId: article.id,
        sentIdx,
        saved: true,
      };
      actions.setSheet({ kind: "dict", entry });
      return;
    }
    const term = (article.termMeta || []).find((t) => norm(t.w) === key || norm(t.w) === keyBase);
    if (term) {
      const entry: DictEntry = {
        type: "word",
        word: term.w,
        phonetic: term.ph,
        senses: [{ pos: term.pos, cn: term.cn }],
        sentence: sentEl?.en,
        articleId: article.id,
        sentIdx,
        saved: false,
      };
      actions.setSheet({ kind: "dict", entry });
      return;
    }
    const entry: DictEntry = {
      type: "missing",
      word: surface,
      senses: [],
      sentence: sentEl?.en,
      articleId: article.id,
      sentIdx,
      saved: false,
    };
    actions.setSheet({ kind: "dict", entry });
  }

  function clearSelection() {
    const current = window.getSelection()?.toString().trim().replace(/\s+/g, " ") || "";
    if (current) dismissedSelection.current = current;
    setSelection(null);
  }

  useEffect(() => {
    const update = () => {
      const chosen = window.getSelection();
      if (!chosen || chosen.isCollapsed || !chosen.rangeCount) {
        dismissedSelection.current = "";
        // iOS can collapse its native selection before the toolbar receives
        // pointerup/click. Keep the confirmed text as an action snapshot so
        // that collapse does not unmount the button the user is pressing.
        return;
      }
      const text = chosen.toString().trim().replace(/\s+/g, " ");
      if (!text || text === dismissedSelection.current || !/[A-Za-z]/.test(text)) { setSelection(null); return; }
      const range = chosen.getRangeAt(0);
      const start = selectionSentence(range.startContainer, range.startOffset, false);
      const end = selectionSentence(range.endContainer, range.endOffset, true);
      const body = bodyRef.current;
      if (!start || !end || !body?.contains(start) || !body.contains(end)) { setSelection(null); return; }
      const idx = Number(start.dataset.si);
      const sentence = article.sentences[idx];
      if (!sentence) { setSelection(null); return; }
      const crossSentence = start !== end;
      const wholeSentence = normalizeSelection(text) === normalizeSelection(sentence.en);
      setSelection({ text, idx, kind: crossSentence ? "invalid" : wholeSentence || text.length > 80 ? "sentence" : "word" });
    };
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") clearSelection(); };
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !selectionBarRef.current?.contains(event.target)) clearSelection();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("pointerup", update);
    document.addEventListener("keydown", dismiss);
    window.addEventListener("resize", clearSelection);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("pointerup", update);
      document.removeEventListener("keydown", dismiss);
      window.removeEventListener("resize", clearSelection);
    };
    // The English source, not translation writes, defines a selection's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, sourceKey]);

  useEffect(() => { if (drawer || globalSheet) clearSelection(); }, [drawer, globalSheet]);

  function explainSelection() {
    if (!selection || selection.kind === "invalid") return;
    const chosen = selection;
    clearSelection();
    stopPlay();
    // The selection action disappears on open. Give modal focus a surviving
    // return point next to reading assistance rather than the top navigation.
    helpButtonRef.current?.focus({ preventScroll: true });
    if (chosen.kind === "sentence") {
      setDrawer({ type: "sentence", idx: chosen.idx });
      return;
    }
    const chunk = article.sentences[chosen.idx]?.chunks?.find(value =>
      normalizeSelection(value.text) === normalizeSelection(chosen.text) || normalizeSelection(value.word || "") === normalizeSelection(chosen.text),
    );
    openDict(chosen.text, chunk, chosen.idx);
  }

  function openSentenceHelp() {
    clearSelection();
    stopPlay();
    setDrawer({ type: "sentence", idx: sent });
  }

  function jumpSentence(next: number) {
    clearSelection();
    stopPlay();
    const idx = clampSentence(next, article.sentences.length);
    setSent(idx);
    actions.setProgress(article.id, idx);
    actions.markRead(article.id, idx);
    scrollToSent(idx);
  }

  /* 段级翻译（导入文章 zh=null，#35）；未配置 → 清加载态呈引导，不产出伪译文；
     已有本地覆盖译文（sentenceZh）的句子不再发起机器翻译 */
  function translateSentence(i: number, force = false): Promise<boolean> {
    const s = article.sentences[i];
    if (!s || translations.current.has(i)) return Promise.resolve(false);
    if (!force && (effectiveSentenceZh(zhOverrides, i, s.zh) || temporaryTranslations[i])) return Promise.resolve(true);
    setUncfg((prev) => new Set([...prev].filter((x) => x !== i))); /* 重试路径先撤引导态 */
    setTranslating((prev) => new Set(prev).add(i));
    setTranslationErrors(prev => { const next = { ...prev }; delete next[i]; return next; });
    return new Promise(resolve => {
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      translations.current.delete(i);
      if (mounted.current) {
        setTranslating(prev => { const next = new Set(prev); next.delete(i); return next; });
        setTranslationDrafts(prev => { const next = { ...prev }; delete next[i]; return next; });
      }
      resolve(success);
    };
    const engine = startTranslate(s.en, {
      // A stream is provisional until onDone. Failed/cancelled drafts never enter storage.
      onDelta: (out) => { if (mounted.current && !settled) setTranslationDrafts(prev => ({ ...prev, [i]: out })); },
      onDone: (out) => {
        if (!mounted.current || settled) return;
        const current = getState().articles.find(a => a.id === article.id);
        if (current && current.sentences[i]?.en !== s.en) { finish(false); return; }
        if (out.trim()) {
          if (current) actions.fillSentenceZh(article.id, i, out.trim());
          else setTemporaryTranslations(previous => ({ ...previous, [i]: out.trim() }));
          setRevealed(prev => new Set(prev).add(i));
          finish(true);
        } else { setTranslationErrors(prev => ({ ...prev, [i]: "未取得译文，请重试" })); finish(false); }
      },
      onFail: (message) => { if (mounted.current && !settled) setTranslationErrors(prev => ({ ...prev, [i]: message })); finish(false); },
      /* 未配置模型：startTranslate 只回调此处（无 onDone/onFail），必须在这里撤
         translating，否则 skeleton 永挂；引导文案走组件态而非 fillSentenceZh——
         那会把文案持久化成正式译文，配置 Key 后这句就再也进不了真翻译（!s.zh 挡住） */
      onUnconfigured: () => {
        if (mounted.current && !settled) setUncfg((prev) => new Set(prev).add(i));
        finish(false);
      },
    }, { direction: "e2c" });
    if (!settled) translations.current.set(i, { stop() { engine.stop(); finish(false); } });
    });
  }

  function cancelTranslation() {
    translations.current.forEach(engine => engine.stop());
  }

  const translationHelpIdx = drawer?.type === "sentence" ? drawer.idx : null;
  useEffect(() => () => cancelTranslation(), [article.id, translationHelpIdx]);

  const total = article.sentences.length;
  const nextChapter = article.bookId ? tocArticles.find(a => chapterIndexOf(a) > chapterIndexOf(article) && a.sentences.length > 0) : undefined;
  const showCoach = !prefs.coachDismissed;
  const headTitle = article.bookId && typeof article.chapterTitle === "string" && article.chapterTitle ? article.chapterTitle : article.title;
  const author = typeof article.author === "string" ? article.author : "";
  const bookTitle = article.bookId ? String(article.bookTitle || article.title) : "";
  const currentHelpIdx = drawer?.type === "sentence" ? drawer.idx : sent;

  if (!total) return <><header className="learning-head"><button className="iconbtn" data-nav-back aria-label="返回" onClick={() => nav.pop()}><Icon name="left" size={20}/></button><h1>阅读</h1></header><div className="learning-body learning-empty"><p>这篇内容还没有可读正文。</p><button className="btn-ghost" onClick={() => nav.pop()}>返回书架</button></div></>;

  return (
    <>
      <header className="reader-toolbar">
        <button className="reader-back reader-icon-button" data-nav-back aria-label="返回书架" onClick={() => {
          stopPlay(); clearSelection(); setDrawer(null); actions.setReading(null); nav.pop();
        }}><Icon name="left" size={21}/><span>书架</span></button>
        <span className="reader-running-title" title={bookTitle || headTitle}>{bookTitle || headTitle}</span>
        <div className="reader-toolbar-actions">
          <button className="reader-icon-button" aria-label="阅读目录" onClick={() => setDrawer({ type: "toc" })}><Icon name="list" size={20}/></button>
          <button className="reader-icon-button" aria-label="阅读设置" onClick={() => setDrawer({ type: "settings" })}><Icon name="aa" size={21}/></button>
        </div>
      </header>
      <main ref={bodyRef} className="pbody rd-body rd-continuous reader-flow" style={{
        "--rd-fs": `${prefs.fs * fontScale}px`, "--rd-lh": prefs.lh,
      } as CSSProperties} onScroll={onScroll}>
        <article className="reader-document">
          <header className="reader-document-heading">
            {author && <p className="reader-author">{author}</p>}
            <h1 className="rd-article-title" lang="en">{headTitle}</h1>
            <p className="reader-document-meta">
              <span>{article.bookId ? `第 ${chapterIndexOf(article) + 1} 章` : sourceLabelOf(article)}</span>
              <span>约 {minutesOf(article)} 分钟</span>
            </p>
          </header>
          {showCoach && <div className="reader-first-hint">
            <span>选中不懂的词句，再点「解释」。</span>
            <button className="reader-icon-button" aria-label="收起提示" onClick={() => actions.setReaderPrefs({ coachDismissed: true })}><Icon name="close" size={15}/></button>
          </div>}
          <div className="v2-prose reader-prose">
            {paragraphs.map((paragraph, index) => <p className="rd-original reader-paragraph" key={paragraph[0]?.idx ?? index} lang="en">{paragraph.map(sentence =>
              <span key={sentence.idx} data-si={sentence.idx} className={`sent ${sent === sentence.idx ? "active" : ""} ${playingIdx === sentence.idx ? "playing" : ""}`}><SentEn s={sentence} savedKeys={savedKeys} prefs={prefs}/></span>,
            )}</p>)}
          </div>
          <footer className="reader-document-end">
            <div className="reader-end-mark" aria-hidden="true"><Icon name="bookopen" size={22}/></div>
            <p>{finished ? "已读完" : article.bookId ? "本章结束" : "正文结束"}</p>
            <div className="reader-end-actions">
              {!finished && <button className="reader-text-button" onClick={() => { actions.setCompleted(article.id, true); toast("已标记读完"); }}><Icon name="check" size={17}/>标记读完</button>}
              {nextChapter && <button className="reader-next-chapter" onClick={() => {
                stopPlay(); cancelTranslation(); clearSelection(); pendingRead.current = null;
                actions.setProgress(article.id, total - 1); actions.markRead(article.id, total - 1); actions.setCompleted(article.id, true);
                nav.replace("reader", { articleId: nextChapter.id });
              }}>继续下一章<Icon name="right" size={16}/></button>}
            </div>
          </footer>
        </article>
      </main>
      {selection && <div ref={selectionBarRef} className="reader-selection" role={selection.kind === "invalid" ? "status" : "toolbar"} aria-label="选文帮助">
        <span className="reader-selection-text" title={selection.text}>{selection.kind === "invalid" ? "请选一个词组或单句" : selection.text}</span>
        {selection.kind !== "invalid" && <button className="reader-explain" onClick={explainSelection}><Icon name="bulb" size={16}/>{selection.kind === "sentence" ? "理解这句" : "解释"}</button>}
        <button className="reader-icon-button" aria-label="收起选文帮助" onClick={clearSelection}><Icon name="close" size={16}/></button>
      </div>}
      <div className={`reader-listen${controlsOpen ? " expanded" : ""}`}>
        <div className="reader-position-track" role="progressbar" aria-label="当前阅读位置" aria-valuemin={1} aria-valuemax={total} aria-valuenow={sent + 1} aria-valuetext={`第 ${sent + 1} 句，共 ${total} 句`}><span style={{ width: `${((sent + 1) / total) * 100}%` }}/></div>
        <div className="reader-listen-main">
          <button className="reader-play-button" aria-label={playing ? "暂停朗读" : "播放"} title={playing ? "暂停；再次播放从本句开头继续" : "从当前句开始朗读"} onClick={() => { clearSelection(); playing ? stopPlay() : playFrom(sent, false); }}><Icon name={playing ? "pause" : "play"} size={21}/></button>
          <div className="reader-listen-label"><span>{playing ? "正在朗读" : "听这篇英文"}</span><small>第 {sent + 1} / {total} 句</small></div>
          <button ref={helpButtonRef} className="reader-icon-button reader-help-button" aria-label="阅读帮助" onClick={openSentenceHelp}><Icon name="bulb" size={20}/></button>
          <button className="reader-icon-button reader-expand-button" aria-label={controlsOpen ? "收起朗读控制" : "展开朗读控制"} aria-expanded={controlsOpen} aria-controls={controlsId} onClick={() => { clearSelection(); setControlsOpen(value => !value); }}><Icon name="right" size={18}/></button>
        </div>
        {controlsOpen && <div className="reader-listen-controls" id={controlsId}>
          <div className="reader-transport">
            <button className="reader-icon-button" aria-label="上一句" disabled={sent === 0} onClick={() => jumpSentence(sent - 1)}><Icon name="prev" size={19}/></button>
            <button className="reader-current-sentence" aria-label={`查看第 ${sent + 1} 句，共 ${total} 句`} onClick={openSentenceHelp}>这句的意思<Icon name="chat" size={16}/></button>
            <button className="reader-icon-button" aria-label="下一句" disabled={sent >= total - 1} onClick={() => jumpSentence(sent + 1)}><Icon name="next" size={19}/></button>
            <button className="reader-rate" aria-label="切换语速" onClick={() => { const current = RATE_TIERS.indexOf(nearestRate(prefs.rate)); actions.setReaderPrefs({ rate: RATE_TIERS[(current + 1) % RATE_TIERS.length] }); }}>{nearestRate(prefs.rate)}×</button>
          </div>
          <div className="reader-extra-tools">
            <button className="reader-text-button" onClick={() => { clearSelection(); stopPlay(); setDrawer({ type: "lookup", idx: sent }); }}><Icon name="search" size={17}/>查一个词或表达</button>
            <button className="reader-text-button" aria-label="跟读此句" onClick={() => { clearSelection(); stopPlay(); void openPractice(nav, { mode: "follow", title: article.title, reference: article.sentences[sent]?.en || "", source: { articleId: article.id, sentenceIdx: sent } }).catch(error => toast(String(error))); }}><Icon name="wave" size={17}/>跟读</button>
          </div>
        </div>}
      </div>

      {/* ---------- 阅读域抽屉（本页局部；词典卡仍走全局 setSheet 叠在上层） ---------- */}
      <SentenceSheet
        open={drawer?.type === "sentence"}
        onClose={() => { stopPlay(); setDrawer(null); }}
        article={presentedArticle}
        sentIdx={drawer?.type === "sentence" ? drawer.idx : sent}
        mask={masked}
        revealed={revealed.has(drawer?.type === "sentence" ? drawer.idx : sent)}
        onReveal={() => setRevealed(prev => { const next = new Set(prev); next.has(currentHelpIdx) ? next.delete(currentHelpIdx) : next.add(currentHelpIdx); return next; })}
        onHear={() => playFrom(drawer?.type === "sentence" ? drawer.idx : sent, true)}
        onFollow={() => {
          const idx = drawer?.type === "sentence" ? drawer.idx : sent;
          stopPlay();
          void openPractice(nav, { mode: "follow", title: article.title, reference: article.sentences[idx]?.en || "", source: { articleId: article.id, sentenceIdx: idx } });
        }}
        onEdit={() => setDrawer({ type: "edit", idx: drawer?.type === "sentence" ? drawer.idx : sent })}
        onManualLookup={() => setDrawer({ type: "lookup", idx: drawer?.type === "sentence" ? drawer.idx : sent })}
        onTranslate={drawer?.type === "sentence" ? () => { void translateSentence(drawer.idx, true); } : undefined}
        translating={drawer?.type === "sentence" ? translating.has(drawer.idx) : false}
        translationError={translationErrors[currentHelpIdx]}
        translationDraft={translationDrafts[currentHelpIdx]}
        translationUnconfigured={uncfg.has(currentHelpIdx)}
      />
      <EditTranslationSheet
        open={drawer?.type === "edit"}
        onClose={() => setDrawer(null)}
        article={article}
        sentIdx={drawer?.type === "edit" ? drawer.idx : sent}
        onSaved={(i) => setRevealed((prev) => new Set(prev).add(i))}
      />
      <ContentsSheet
        open={drawer?.type === "toc"}
        onClose={() => setDrawer(null)}
        title={article.bookId ? `${String(article.bookTitle || article.title)} · 目录` : "我的可读内容"}
        articles={tocArticles}
        currentId={article.id}
        onPick={(target) => {
          setDrawer(null);
          if (target.id === article.id) return;
          /* 目录切换：书内换章/换文档顶替当前阅读页，各自进度由 progress 表保留 */
          nav.replace("reader", { articleId: target.id });
        }}
      />
      <LookupSheet
        open={drawer?.type === "lookup"}
        onClose={() => setDrawer(null)}
        article={article}
        sentIdx={drawer?.type === "lookup" ? drawer.idx : sent}
      />
      <SettingsSheet open={drawer?.type === "settings"} onClose={() => setDrawer(null)} />
    </>
  );
}

function SentEn({
  s,
  savedKeys,
  prefs,
}: {
  s: { idx: number; en: string; chunks?: SentenceChunk[] };
  savedKeys: Set<string>;
  prefs: { chunkMark: boolean };
}) {
  const toks = tokenize(s.en, s.chunks, savedKeys);
  return (
    <span className="sent-en">
      {toks.map((t, i) =>
        !t.isWord ? (
          <span key={i} className="tok pu">
            {t.text}
          </span>
        ) : (
          <span
            key={i}
            className={`tok ${t.saved ? "known" : t.chunkIdx >= 0 && prefs.chunkMark ? "ck" : ""}`}
            data-t={t.text}
            data-ck={t.chunkIdx >= 0 ? t.chunkIdx : undefined}
          >
            {t.text}
          </span>
        ),
      )}{" "}
    </span>
  );
}

const CHUNK_TYPE_LABEL: Record<string, string> = {
  collocation: "搭配",
  phrasal: "短语动词",
  idiom: "习语",
  pattern: "句式",
};

interface ReaderSelection { text: string; idx: number; kind: "word" | "sentence" | "invalid" }

function normalizeSelection(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[’‘]/g, "'").toLocaleLowerCase();
}

/** Native ranges may terminate on a paragraph child boundary rather than a text node. */
function selectionSentence(node: Node, offset: number, end: boolean): HTMLElement | null {
  let endpoint: Node | null = node;
  if (node.nodeType === Node.ELEMENT_NODE && node.childNodes.length) {
    endpoint = node.childNodes[end ? Math.max(0, offset - 1) : offset] || node;
  }
  const element = endpoint instanceof HTMLElement ? endpoint : endpoint?.parentElement;
  return element?.closest<HTMLElement>("[data-si]") || null;
}
