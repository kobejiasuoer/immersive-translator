import { openPractice } from "./LearningHome";
/**
 * 阅读页（push）—— §3.6「从读到练」轴心。
 * 点句 → 句子解析抽屉（朗读保留在抽屉动作行：听原句/跟读/改译文）；点词 → 词典卡、点词块 → 词块卡；
 * 已收藏词墨蓝 8% 底 / 词块点状下划线，同行只出现一种（治 V5，tokenize 保证）；
 * 遮罩按句揭底 + 长按 peek（#37）；阅读设置抽屉（字号/行距/语速档位 + 实时样例）；滚动即写进度（治 I5）；
 * 逐句 TTS 连播（#44，onend + 兜底双保险）；段级翻译重试（#35，导入文章 zh=null）；
 * 句级译文覆盖（本地 sentenceZh 表）+ 修改译文抽屉 + 阅读目录抽屉 + 手动查询表达 + 读后收尾卡。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { actions, activeRepository, effectiveSentenceZh, flushPersist, getState, speak, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { cloudState, useCloud } from "../services/cloud";
import { tokenize, useSavedKeys } from "../tokenizer";
import { norm } from "../core/judge";
import { startTranslate } from "../services/translate";
import type { Article, SentenceChunk, SentencePair } from "../core/types";
import type { DictEntry } from "../store";
import { SentenceSheet } from "../components/reading/SentenceSheet";
import { EditTranslationSheet } from "../components/reading/EditTranslationSheet";
import { ContentsSheet } from "../components/reading/ContentsSheet";
import { LookupSheet } from "../components/reading/LookupSheet";
import { SettingsSheet } from "../components/reading/SettingsSheet";
import { docMetaOf, sourceLabelOf } from "../components/reading/meta";
import { openAccountSheet } from "../components/account/accountGate";
import { clampSentence, readingParagraphs } from "../core/readerPresentation";

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
  const taskCount = useApp((s) => s.tasks.length);
  const zhOverrides = useApp((s) => s.sentenceZh[article.id]);
  const finished = useApp((s) => !!s.readingCompleted[article.id]);
  const fontScale = useApp((s) => s.settings.fsScale);
  const paragraphs = useMemo(() => readingParagraphs(article), [article.sentences, article.paragraphStarts]);
  const sourceKey = useMemo(() => article.sentences.map(s => s.en).join("\u001f"), [article.sentences]);
  const previousSource = useRef(sourceKey);
  const masked = prefs.mode === "bi" && prefs.mask;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /* 目录抽屉数据：书模式=同书各章（chapterIndex 排序）；非书=全部可读文档 */
  const tocArticles = useMemo(() => {
    if (article.bookId) {
      return allArticles
        .filter((a) => a.bookId === article.bookId && !a.archived)
        .sort((a, b) => Number(a.chapterIndex ?? 0) - Number(b.chapterIndex ?? 0));
    }
    return allArticles.filter((a) => !a.archived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allArticles, article.bookId]);

  const [drawer, setDrawer] = useState<ReadingDrawerState>(null);
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
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const batchCancelled = useRef(false);
  const mounted = useRef(true);
  const pendingRead = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const play = useRef({ active: false, idx: -1 });
  /** 播放代际：每次 playFrom 自增，旧 utterance 的回调（onend/兜底）凭 gen 失效（治 P-23） */
  const playGen = useRef(0);
  /** 程序性滚动锁：scrollToSent 后 600ms 内不按「视口顶句」回写进度/计数（治 P-21） */
  const progLockUntil = useRef(0);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translations = useRef(new Map<number, { stop(): void }>());
  const previousCloud = useRef({ id: account?.id ?? null, generation: cloudGeneration });
  const previousRepository = useRef(activeRepository());

  /* 打开即恢复断点 */
  useEffect(() => {
    mounted.current = true;
    batchCancelled.current = false;
    actions.setReading(article.id);
    const initial = clampSentence(savedSent, article.sentences.length);
    setSent(initial);
    setDrawer(null);
    setRevealed(new Set());
    setTranslationDrafts({});
    setTranslationErrors({});
    setTemporaryTranslations({});
    setTranslating(new Set());
    setBatch(null);
    pendingRead.current = null;
    if (article.sentences.length) {
      actions.setProgress(article.id, initial);
      actions.markRead(article.id, initial);
    }
    const t = setTimeout(() => scrollToSent(clampSentence(savedSent, article.sentences.length), true), 60);
    return () => {
      mounted.current = false;
      batchCancelled.current = true;
      if (pendingRead.current !== null) actions.setProgress(article.id, pendingRead.current);
      clearTimeout(t);
      play.current.active = false;
      playGen.current++; /* 失效所有在途回调 */
      stopSpeak();
      translations.current.forEach(engine => engine.stop());
      translations.current.clear();
      /* 滚动防抖一并清（治 home-6）：退出前 300ms 内最后一次滚动的回调在卸载后触发，
         bodyRef 已被置空直接 return——最后一段滚动进度不落盘，断点回退到旧句 */
      if (peekTimer.current) clearTimeout(peekTimer.current);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id]);

  useEffect(() => {
    if (previousSource.current !== sourceKey) {
      cancelTranslation();
      stopPlay();
      setDrawer(null);
      setRevealed(new Set());
      setTemporaryTranslations({});
      setTranslationErrors({});
      pendingRead.current = null;
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
      setRevealed(new Set());
    }
    previousCloud.current = { id, generation: cloudGeneration };
  }, [account?.id, cloudGeneration]);

  useEffect(() => {
    const changed = () => {
      const next = activeRepository();
      const guestLogin = previousRepository.current.identity === "guest" && next.identity === cloudState().account?.id;
      if (!guestLogin) {
        cancelTranslation(); stopPlay(); pendingRead.current = null; setDrawer(null); setRevealed(new Set());
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

  // Language and type changes can reflow the document; keep its logical place.
  useEffect(() => {
    progLockUntil.current = Date.now() + 600;
    const timer = setTimeout(() => scrollToSent(sent, true), 40);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, prefs.fs, prefs.lh, fontScale]);

  const scrollToSent = useCallback(
    (i: number, instant = false) => {
      /* 程序性滚动（断点恢复/词典定位/播放跳句/上下句）：600ms 内 onScroll 不回写（治 P-21） */
      progLockUntil.current = Date.now() + 600;
      const body = bodyRef.current;
      const el = body?.querySelector(`[data-si="${i}"]`);
      if (!body || !el) return;
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
    if (prefs.topic === "black") host.setAttribute("data-reader-dark", "1");
    else host.removeAttribute("data-reader-dark");
    return () => host.removeAttribute("data-reader-dark");
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

  /* 「重新遮住全部译文」：MoreSheet → remaskReader() → 此处清空已揭示句（治 P-25） */
  const remaskAt = useApp((s) => s.remaskAt);
  useEffect(() => {
    if (remaskAt > 0) setRevealed(new Set());
  }, [remaskAt]);

  /* 遮罩由关转开（Aa 面板/本篇菜单）：旧的揭示态一并清空（治 P-25） */
  const prevMask = useRef(prefs.mask);
  useEffect(() => {
    if (!prevMask.current && prefs.mask) setRevealed(new Set());
    prevMask.current = prefs.mask;
  }, [prefs.mask]);

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

  function onBodyClick(e: MouseEvent) {
    const tok = (e.target as HTMLElement).closest(".tok") as HTMLElement | null;
    if (tok && !tok.classList.contains("pu")) {
      stopPlay();
      const sentEl = tok.closest("[data-si]") as HTMLElement | null;
      const sentIdx = sentEl ? Number(sentEl.dataset.si) : sent;
      const chunkIdx = tok.dataset.ck !== undefined ? Number(tok.dataset.ck) : -1;
      const sentObj = article.sentences[sentIdx];
      openDict(tok.dataset.t || tok.textContent || "", chunkIdx >= 0 ? sentObj?.chunks?.[chunkIdx] : undefined, sentIdx);
      return;
    }
    const zh = (e.target as HTMLElement).closest(".sent-zh") as HTMLElement | null;
    if (zh && masked) {
      const si = Number(zh.dataset.zh);
      setRevealed((prev) => new Set(prev).add(si));
      return;
    }
    const sentEl = (e.target as HTMLElement).closest("[data-si]") as HTMLElement | null;
    if (sentEl) {
      const si = Number(sentEl.dataset.si);
      /* 点句=打开句子解析抽屉（reading-parity 对齐定稿原型）：朗读保留在抽屉动作行，
         连播入口仍在底部 playbar（点句连播旧路径由抽屉「听原句」+ playbar 承接） */
      stopPlay();
      setDrawer({ type: "sentence", idx: si });
    }
  }

  /* 长按 peek（380ms，§3.6） */
  function onBodyPointerDown(e: React.PointerEvent) {
    if (!masked) return;
    const zh = (e.target as HTMLElement).closest(".sent-zh") as HTMLElement | null;
    if (!zh) return;
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => zh.classList.add("peek"), 380);
  }
  function clearPeek() {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    bodyRef.current?.querySelectorAll(".sent-zh.peek").forEach((x) => x.classList.remove("peek"));
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
        if (mounted.current) setUncfg((prev) => new Set(prev).add(i));
        finish(false);
      },
    });
    if (!settled) translations.current.set(i, { stop() { engine.stop(); finish(false); } });
    });
  }

  async function translateMissing() {
    if (batch) return;
    const missing = article.sentences.filter(s => !(effectiveSentenceZh(zhOverrides, s.idx, s.zh) || temporaryTranslations[s.idx]));
    batchCancelled.current = false;
    setBatch({ done: 0, total: missing.length });
    for (let index = 0; index < missing.length; index++) {
      if (batchCancelled.current || !mounted.current) break;
      const success = await translateSentence(missing[index].idx);
      if (!success || batchCancelled.current || !mounted.current) break;
      setBatch({ done: index + 1, total: missing.length });
    }
    if (mounted.current) setBatch(null);
  }

  function cancelTranslation() {
    batchCancelled.current = true;
    translations.current.forEach(engine => engine.stop());
    if (mounted.current) setBatch(null);
  }

  const total = article.sentences.length;
  /** 「已读完」= 显式动作（先记为读完）之后的末句进度；被动滚动到末句只写断点（可恢复位置），
      不改收尾卡 tag——原型 progress.completed 仅由 read-finish-only 置位（html:1803）。
      state 而非 ref：点「先记为读完」时进度可能已是末句（快照值不变不触发重渲染），需要显式重渲染。 */
  const atLast = sent >= total - 1;
  /** 收尾卡练习词（原型 html:1800 practiceWord = collected[0]?.w || terms[0]?.w）：
      本篇已收藏的第一个表达优先，无收藏则回退本篇第一个预置词条。 */
  const collectedFromDoc = vocab.filter((v) => v.sourceArticleId === article.id);
  const practiceWord = collectedFromDoc[0]?.word || article.termMeta?.[0]?.w;
  /** 该词是否已在生词本（原型 findWord，html:1627）：决定主按钮是「用这个表达说一句」
      （mic，已收藏）还是「收藏并练一句」（star，未收藏的预置词，html:1803 分支文案）。 */
  const practiceSaved = !!practiceWord && vocab.some((v) => norm(v.word) === norm(practiceWord));
  const practiceTerm = practiceWord ? (article.termMeta || []).find((t) => norm(t.w) === norm(practiceWord)) : undefined;
  /** 新手引导条：未收起且还没开过口（原型 newUser 口径，html:1799） */
  const showCoach = !prefs.coachDismissed && taskCount === 0;
  const headTitle = article.bookId && typeof article.chapterTitle === "string" && article.chapterTitle ? article.chapterTitle : article.title;
  const missingCount = article.sentences.filter(s => !(effectiveSentenceZh(zhOverrides, s.idx, s.zh) || temporaryTranslations[s.idx])).length;

  function renderTranslation(s: SentencePair) {
    const translated = effectiveSentenceZh(zhOverrides, s.idx, s.zh) || temporaryTranslations[s.idx];
    const pending = translating.has(s.idx);
    const error = translationErrors[s.idx];
    if (pending) return <span className="sent-zh reveal rd-pending-translation" aria-live="polite">{translationDrafts[s.idx] || "正在翻译…"}</span>;
    if (translated) {
      if (masked && !revealed.has(s.idx)) return <button type="button" className="rd-translation-action" onClick={event => { event.stopPropagation(); setRevealed(prev => new Set(prev).add(s.idx)); }}><Icon name="eye" size={15} />显示第 {s.idx + 1} 句译文</button>;
      return <span className="sent-zh reveal" data-zh={s.idx}>{translated}{" "}</span>;
    }
    return <span className="rd-missing-translation">
      {error && <span className="rd-translation-error" role="status">{error}</span>}
      {uncfg.has(s.idx) && <span>尚未设置翻译服务</span>}
      <button type="button" className="rd-translation-action" onClick={event => { event.stopPropagation(); void translateSentence(s.idx); }}><Icon name="translate" size={15} />{error ? "重试" : `翻译第 ${s.idx + 1} 句`}</button>
    </span>;
  }

  if (!total) return <><header className="learning-head"><button className="iconbtn" aria-label="返回" onClick={() => nav.pop()}><Icon name="left" size={20}/></button><h1>阅读</h1></header><div className="learning-body learning-empty"><p>这篇内容还没有可读正文。</p><button className="btn-ghost" onClick={() => nav.pop()}>返回书架</button></div></>;

  return (
    <>
      {/* 页头（原型 .nhead）：返回 + 居中标题/衬线副标 + 目录(list 图标)/AA 两钮（html:1803） */}
      <header className="learning-head nhead rd-nhead">
        <button
          className="iconbtn"
          aria-label="返回"
          onClick={() => {
            stopPlay();
            setDrawer(null);
            actions.setReading(null);
            nav.pop();
          }}
        >
          <Icon name="left" size={20} />
        </button>
        <div className="nt">
          <h1 className="serif">{headTitle}</h1>
          <small>{docMetaOf(article)}</small>
        </div>
        <div className="rd-nhead-acts">
          <button className="iconbtn" aria-label="阅读目录" onClick={() => setDrawer({ type: "toc" })}>
            <Icon name="list" size={18} />
          </button>
          <button className="iconbtn" aria-label="阅读设置" onClick={() => setDrawer({ type: "settings" })}>
            <Icon name="aa" size={18} />
          </button>
        </div>
      </header>
      <div className="rd-prog">
        <i style={{ transform: `scaleX(${total ? (sent + 1) / total : 0})` }} />
      </div>
      <div className="rd-language-tools">
        <span className="rd-sentence-count">{total} 句</span>
        <div className="rd-language-mode" role="group" aria-label="正文语言">
          {([['en', '英文'], ['bi', '双语'], ['zh', '中文']] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={prefs.mode === mode}
              className={prefs.mode === mode ? "on" : ""}
              onClick={() => actions.setReaderPrefs({ mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={bodyRef}
        className={`pbody v2-reader-body rd-body rd-continuous rd-mode-${prefs.mode} ${masked ? "reader-mask" : ""}`}
        style={
          {
            paddingLeft: 24,
            paddingRight: 24,
            paddingBottom: 28,
            /* Aa 字号档注入正文容器；英文与译文都随阅读字号调整。 */
            "--rd-fs": `${prefs.fs * fontScale}px`,
            "--rd-lh": prefs.lh,
          } as CSSProperties
        }
        onClick={onBodyClick}
        onPointerDown={onBodyPointerDown}
        onPointerUp={clearPeek}
        onPointerCancel={clearPeek}
        onPointerMove={clearPeek}
        onScroll={onScroll}
      >
        {showCoach && (
          <div className="v2-reader-coach rd-reader-coach">
            <div>
              <span className="ico">
                <Icon name="bulb" size={16} />
              </span>
              <span>
                <b>点词查义，点底部句数查看本句</b>
              </span>
            </div>
            <button
              aria-label="收起提示"
              onClick={() => actions.setReaderPrefs({ coachDismissed: true })}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
        <div className="ch-kick">{sourceLabelOf(article)}</div>
        {(prefs.mode !== "zh" || !article.titleCn) && <h2 className="rd-article-title" lang="en">{headTitle}</h2>}
        {prefs.mode !== "en" && article.titleCn ? <h2 className="rd-title-translation" lang="zh">{article.titleCn}</h2> : null}
        {prefs.mode !== "en" && missingCount > 0 && <div className="rd-translate-all" role="status">
          <span>{batch ? `正在翻译 ${batch.done} / ${batch.total} 句` : `${missingCount} 句还没有译文`}</span>
          <button className="tlink" onClick={() => batch ? cancelTranslation() : void translateMissing()}>{batch ? "停止翻译" : "翻译剩余全文"}</button>
        </div>}
        <div className="v2-prose">
          {paragraphs.map((paragraph, index) => <section className="rd-paragraph" key={paragraph[0]?.idx ?? index}>
            {prefs.mode !== "zh" && <p className="rd-original" lang="en">{paragraph.map(s => <span key={s.idx} data-si={s.idx} className={`sent ${sent === s.idx ? "active" : ""} ${playingIdx === s.idx ? "playing" : ""}`}><SentEn s={s} savedKeys={savedKeys} prefs={prefs} /></span>)}</p>}
            {prefs.mode !== "en" && <p className="rd-translated" lang="zh">{paragraph.map(s => <span key={s.idx} data-si={prefs.mode === "zh" ? s.idx : undefined} className={`rd-translated-sentence ${sent === s.idx ? "active" : ""}`}>{renderTranslation(s)}</span>)}</p>}
          </section>)}
        </div>
        {/* 手动查询表达入口（原型 read-manual-lookup）：居中文字链形态 */}
        <button className="v2-word-select" onClick={() => setDrawer({ type: "lookup", idx: sent })}>
          <Icon name="search" size={15} />
          没标出的词也可以查
        </button>
        {!account && vocab.length > 0 && (
          <div className="v2-local-save">
            <span>
              <Icon name="lock" size={14} />
              记录已保存在这台手机
            </span>
            <button onClick={openAccountSheet}>登录同步</button>
          </div>
        )}
        {/* 读后收尾卡（最后一句 / 已读完时出现） */}
        {(atLast || finished) && (
          <section className="learning-card v2-reader-finish">
            <span className="learning-tag">{finished ? "这段已经读完" : "读到这一段的最后一句了"}</span>
            <h2 style={{ marginTop: 10 }}>把读到的表达，用一次。</h2>
            <p>{practiceWord ? `试着用 ${practiceWord} 说一句自己的话。` : "可以跟读当前句，模仿停顿与重音。"}</p>
            {practiceWord ? (
              <button
                className="btn"
                onClick={() => {
                  stopPlay();
                  /* 未收藏的练习词先收进生词本再开口（原型 ACT read-finish-practice，html:1865
                     先 collectWord 再 startPractice），词条释义用内容预置数据（有则带）。 */
                  if (!practiceSaved) {
                    actions.saveWord(
                      {
                        word: practiceWord,
                        kind: "word",
                        phonetic: practiceTerm?.ph,
                        senses: practiceTerm ? [{ pos: practiceTerm.pos, cn: practiceTerm.cn }] : [],
                      },
                      "word",
                      { articleId: article.id, sentIdx: sent },
                    );
                  }
                  void openPractice(nav, { mode: "word", title: practiceWord, word: practiceWord, reference: `用 ${practiceWord} 说一句自己的话。`, source: { articleId: article.id, sentenceIdx: sent } }).catch((error) => toast(String(error)));
                }}
              >
                <Icon name={practiceSaved ? "mic" : "star"} size={15} />
                {practiceSaved ? "用这个表达说一句" : "收藏并练一句"}
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => {
                  stopPlay();
                  void openPractice(nav, { mode: "follow", title: article.title, reference: article.sentences[sent]?.en || article.sentences[0]?.en || "", source: { articleId: article.id, sentenceIdx: sent } }).catch((error) => toast(String(error)));
                }}
              >
                <Icon name="mic" size={15} />
                跟读这一句
              </button>
            )}
            <button
              className="v2-text-link"
              onClick={() => {
                actions.setCompleted(article.id, true);
                toast("这一段已记为读完，下次可以从书架继续");
              }}
            >
              先记为读完，稍后再练
            </button>
          </section>
        )}
      </div>
      {/* 悬浮胶囊播放条（原型 .playbar.v2-reader-playbar）：黑圆播放钮 + N / M 计数 + 跟读 + 语速 pill */}
      <div className="rd-playbar">
        <button
          className="iconbtn"
          aria-label="上一句"
          onClick={() => {
            stopPlay();
            const nx = Math.max(0, sent - 1);
            setSent(nx);
            actions.setProgress(article.id, nx);
            actions.markRead(article.id, nx);
            scrollToSent(nx);
          }}
        >
          <Icon name="prev" size={18} />
        </button>
        <button
          className="pp"
          aria-label={playing ? "停止朗读" : "播放"}
          title={playing ? "停止朗读；再次播放会从本句开头开始" : "从当前句开始朗读"}
          onClick={() => (playing ? stopPlay() : playFrom(sent, false))}
        >
          <Icon name={playing ? "stop" : "play"} size={20} />
        </button>
        <button
          className="iconbtn"
          aria-label="下一句"
          onClick={() => {
            stopPlay();
            const nx = Math.min(total - 1, sent + 1);
            setSent(nx);
            actions.setProgress(article.id, nx);
            actions.markRead(article.id, nx);
            scrollToSent(nx);
          }}
        >
          <Icon name="next" size={18} />
        </button>
        <button className="cnt num rd-current-sentence" aria-label={`查看第 ${sent + 1} 句，共 ${total} 句`} onClick={() => { stopPlay(); setDrawer({ type: "sentence", idx: sent }); }}>
          <span>{sent + 1}/{total}</span><Icon name="list" size={14} />
        </button>
        <button
          className="follow"
          aria-label="跟读此句"
          onClick={() => {
            stopPlay();
            void openPractice(nav, { mode: "follow", title: article.title, reference: article.sentences.find(s => s.idx === sent)?.en || "", source: { articleId: article.id, sentenceIdx: sent } });
          }}
        >
          <Icon name="wave" size={15} />
          跟读
        </button>
        <button
          className="spd num"
          aria-label="切换语速"
          onClick={() => {
            const cur = RATE_TIERS.indexOf(nearestRate(prefs.rate));
            actions.setReaderPrefs({ rate: RATE_TIERS[(cur + 1) % RATE_TIERS.length] });
          }}
        >
          {nearestRate(prefs.rate)}×
        </button>
      </div>

      {/* ---------- 阅读域抽屉（本页局部；词典卡仍走全局 setSheet 叠在上层） ---------- */}
      <SentenceSheet
        open={drawer?.type === "sentence"}
        onClose={() => setDrawer(null)}
        article={article}
        sentIdx={drawer?.type === "sentence" ? drawer.idx : sent}
        mask={masked}
        revealed={revealed.has(drawer?.type === "sentence" ? drawer.idx : sent)}
        onReveal={() => setRevealed((prev) => new Set(prev).add(drawer?.type === "sentence" ? drawer.idx : sent))}
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
  prefs: { mode: "bi" | "en" | "zh"; chunkMark: boolean; fs: number };
}) {
  const toks = tokenize(s.en, s.chunks, savedKeys);
  return (
    <span className={`sent-en ${prefs.mode === "zh" ? "rd-hidden-en" : ""}`}>
      {toks.map((t, i) =>
        !t.isWord ? (
          <span key={i} className="tok pu">
            {t.text}
          </span>
        ) : (
          <span
            key={i}
            className={`tok ${t.chunkIdx >= 0 ? (prefs.chunkMark ? "ck" : "") : t.saved ? "known" : ""}`}
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
