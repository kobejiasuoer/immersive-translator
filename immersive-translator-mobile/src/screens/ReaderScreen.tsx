/**
 * 阅读页（push）—— §3.6「从读到练」轴心。
 * 点句=单句朗读，再点=从该句连播（治 I4）；点词 → 词典卡、点词块 → 词块卡；
 * 已收藏词墨蓝 8% 底 / 词块点状下划线，同行只出现一种（治 V5，tokenize 保证）；
 * 遮罩按句揭底 + 长按 peek（#37）；Aa 面板（#36/#38/#48）；滚动即写进度（治 I5）；
 * 逐句 TTS 连播（#44，onend + 兜底双保险）；段级翻译重试（#35，导入文章 zh=null）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { actions, speak, stopSpeak, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav } from "../ui/kit";
import { useNav } from "../ui/nav";
import { tokenize, useSavedKeys } from "../tokenizer";
import { norm } from "../core/judge";
import { startTranslate } from "../services/translate";
import type { Article, SentenceChunk } from "../core/types";
import type { DictEntry } from "../store";

export default function ReaderScreen({ article }: { article: Article }) {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const prefs = useApp((s) => s.reader);
  const savedSent = useApp((s) => s.progress[article.id] ?? 0);
  const readerTarget = useApp((s) => s.readerTarget);

  const savedKeys = useSavedKeys(vocab.map((v) => v.word));
  const [sent, setSent] = useState(Math.min(savedSent, article.sentences.length - 1));
  const [playingIdx, setPlayingIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [translating, setTranslating] = useState<Set<number>>(new Set());
  /** 未配置模型时点过「翻译这句」的句子：skeleton 即撤、呈引导（治降级断头，不产出伪译文） */
  const [uncfg, setUncfg] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const play = useRef({ active: false, idx: -1 });
  /** 播放代际：每次 playFrom 自增，旧 utterance 的回调（onend/兜底）凭 gen 失效（治 P-23） */
  const playGen = useRef(0);
  /** 最近一次点播的句子：播完后再点同句仍判连播（治 P-23 路径②） */
  const lastPlayed = useRef(-1);
  /** 程序性滚动锁：scrollToSent 后 600ms 内不按「视口顶句」回写进度/计数（治 P-21） */
  const progLockUntil = useRef(0);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translated = useRef(false);

  const paras = useMemo(
    () => article.paragraphStarts.map((_, pi) => article.sentences.filter((s) => s.paragraphIdx === pi)),
    [article],
  );

  /* 打开即恢复断点 */
  useEffect(() => {
    actions.setReading(article.id);
    const t = setTimeout(() => scrollToSent(Math.min(savedSent, article.sentences.length - 1)), 60);
    return () => {
      clearTimeout(t);
      play.current.active = false;
      playGen.current++; /* 失效所有在途回调 */
      stopSpeak();
      /* 滚动防抖一并清（治 home-6）：退出前 300ms 内最后一次滚动的回调在卸载后触发，
         bodyRef 已被置空直接 return——最后一段滚动进度不落盘，断点回退到旧句 */
      if (peekTimer.current) clearTimeout(peekTimer.current);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id]);

  const scrollToSent = useCallback(
    (i: number) => {
      /* 程序性滚动（断点恢复/词典定位/播放跳句/上下句）：600ms 内 onScroll 不回写（治 P-21） */
      progLockUntil.current = Date.now() + 600;
      const el = bodyRef.current?.querySelector(`[data-si="${i}"]`);
      el?.scrollIntoView({ block: "center" });
    },
    [],
  );

  /* 词典卡「定位回读」 */
  useEffect(() => {
    if (readerTarget && readerTarget.articleId === article.id) {
      setSent(readerTarget.sent);
      setTimeout(() => scrollToSent(readerTarget.sent), 40);
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
    setSent(clamped);
    setPlayingIdx(clamped);
    scrollToSent(clamped);
    /* 连播推进期间滚动被 progLock 抑制，进度在这里显式落账，退出/重进不断档（治 P-21） */
    actions.setProgress(article.id, clamped);
    if (play.current.active) {
      speak(article.sentences[clamped].en, prefs.rate, () => {
        if (gen !== playGen.current || !play.current.active) return;
        if (clamped + 1 >= article.sentences.length) stopPlay();
        else {
          play.current.idx = clamped + 1;
          setSent(clamped + 1);
          stepTo(clamped + 1, gen);
        }
      });
    }
  }

  function playFrom(i: number, single: boolean) {
    const gen = ++playGen.current; /* 新播放使旧 utterance 的 onend/onerror/兜底全部失效（治 P-23） */
    play.current.active = true;
    play.current.idx = i;
    lastPlayed.current = i;
    setPlaying(true);
    setPlayingIdx(i);
    setSent(i);
    /* 单句试听不落进度（治 home-3）：此前点最后一句试听即 progress=len-1，文章被判
       「已读完」，今天页「继续阅读」卡与书架「继续读」钉标随之消失；连播才推进落账。 */
    if (!single) actions.setProgress(article.id, i);
    scrollToSent(i);
    speak(article.sentences[i].en, prefs.rate, () => {
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
    });
  }

  function stopPlay() {
    play.current.active = false;
    playGen.current++; /* 在途回调（兜底计时器）一并失效 */
    setPlaying(false);
    setPlayingIdx(-1);
    stopSpeak();
  }

  /* 滚动写进度（防抖，治 I5）；程序性滚动加锁期间跳过，不与断点恢复/定位/跳句打架（治 P-21） */
  function onScroll() {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      if (Date.now() < progLockUntil.current) return;
      const body = bodyRef.current;
      if (!body) return;
      const bodyTop = body.getBoundingClientRect().top;
      const nodes = body.querySelectorAll("[data-si]");
      let cur = 0;
      nodes.forEach((n) => {
        const el = n as HTMLElement;
        if (el.getBoundingClientRect().top - bodyTop <= 90) cur = Number(el.dataset.si);
      });
      setSent(cur);
      actions.setProgress(article.id, cur);
    }, 300);
  }

  /* 点词 → 词典卡（已收藏态 / 词块态 / 未收录态） */
  function openDict(surface: string, chunk: SentenceChunk | undefined, sentIdx: number) {
    const key = norm(surface);
    const keyBase = key.endsWith("s") ? key.slice(0, -1) : key;
    const saved = vocab.find((v) => norm(v.word) === key || norm(v.word) === keyBase);
    const sentEl = article.sentences[sentIdx];
    if (chunk) {
      const entry: DictEntry = {
        type: "chunk",
        word: chunk.word || chunk.text,
        chunkType: CHUNK_TYPE_LABEL[chunk.chunkType],
        senses: [{ pos: chunk.chunkType, cn: chunk.gloss }],
        pattern: chunk.pattern,
        trap: chunk.trap,
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
        pattern: saved.pattern,
        trap: saved.trap,
        sentence: sentEl?.en,
        articleId: article.id,
        sentIdx,
        saved: true,
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
    if (zh && prefs.mask) {
      const si = Number(zh.dataset.zh);
      setRevealed((prev) => new Set(prev).add(si));
      return;
    }
    const sentEl = (e.target as HTMLElement).closest("[data-si]") as HTMLElement | null;
    if (sentEl) {
      const si = Number(sentEl.dataset.si);
      /* 点句=单句朗读，同句再点=从该句连播（治 I4）；
         播放中判 play.current.idx，播完后凭 lastPlayed 兜住，两条路径都进连播（治 P-23）
         （playFrom 形参 single=true 是单句，所以这里取反） */
      const sameAgain =
        (playing && play.current.idx === si) || (!playing && lastPlayed.current === si);
      playFrom(si, !sameAgain);
    }
  }

  /* 长按 peek（380ms，§3.6） */
  function onBodyPointerDown(e: React.PointerEvent) {
    if (!prefs.mask) return;
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

  /* 段级翻译（导入文章 zh=null，#35）；未配置 → 清加载态呈引导，不产出伪译文 */
  function translateSentence(i: number) {
    const s = article.sentences[i];
    if (!s || s.zh) return;
    setUncfg((prev) => new Set([...prev].filter((x) => x !== i))); /* 重试路径先撤引导态 */
    setTranslating((prev) => new Set(prev).add(i));
    startTranslate(s.en, {
      onDelta: (out) => actions.fillSentenceZh(article.id, i, out),
      onDone: (out) => {
        actions.fillSentenceZh(article.id, i, out);
        setTranslating((prev) => {
          const nx = new Set(prev);
          nx.delete(i);
          return nx;
        });
      },
      onFail: () => setTranslating((prev) => new Set([...prev].filter((x) => x !== i))),
      /* 未配置模型：startTranslate 只回调此处（无 onDone/onFail），必须在这里撤
         translating，否则 skeleton 永挂；引导文案走组件态而非 fillSentenceZh——
         那会把文案持久化成正式译文，配置 Key 后这句就再也进不了真翻译（!s.zh 挡住） */
      onUnconfigured: () => {
        setTranslating((prev) => new Set([...prev].filter((x) => x !== i)));
        setUncfg((prev) => new Set(prev).add(i));
      },
    });
  }

  /* 读完庆祝（#49 P2：文案级） */
  useEffect(() => {
    if (!translated.current && sent >= article.sentences.length - 1) {
      translated.current = true;
    }
  }, [sent, article.sentences.length]);

  const total = article.sentences.length;

  return (
    <>
      <PNav
        title={article.title}
        onBack={() => {
          stopPlay();
          actions.setReading(null);
          nav.pop();
        }}
        right={
          <button className="iconbtn" aria-label="更多" onClick={() => actions.setSheet({ kind: "more" })}>
            <Icon name="dots" size={20} />
          </button>
        }
      />
      <div className="rd-prog">
        <i style={{ width: `${((sent + 1) / total) * 100}%` }} />
      </div>
      <div
        ref={bodyRef}
        className={`pbody rd-body ${prefs.mask ? "reader-mask" : ""}`}
        style={{ paddingLeft: 24, paddingRight: 24, paddingBottom: 140 }}
        onClick={onBodyClick}
        onPointerDown={onBodyPointerDown}
        onPointerUp={clearPeek}
        onPointerCancel={clearPeek}
        onPointerMove={clearPeek}
        onScroll={onScroll}
      >
        {paras.map((sents, pi) => (
          <div className="para" key={pi}>
            {sents.map((s) => (
              <span key={s.idx} data-si={s.idx} className={`sent ${playingIdx === s.idx ? "playing" : ""}`}>
                <SentEn s={s} savedKeys={savedKeys} prefs={prefs} />
                {prefs.mode !== "en" &&
                  (s.zh ? (
                    <span
                      className={`sent-zh ${revealed.has(s.idx) ? "reveal" : ""}`}
                      data-zh={s.idx}
                      style={{ fontSize: 14 }}
                    >
                      {s.zh}
                    </span>
                  ) : translating.has(s.idx) ? (
                    <span className="sent-zh" data-zh={s.idx}>
                      <span className="skel" style={{ width: "70%", margin: "4px 0", display: "inline-block" }} />
                      <span className="caret" style={{ height: 12 }} />
                    </span>
                  ) : uncfg.has(s.idx) ? (
                    /* 未配置引导：非译文，不用 .sent-zh（避免被遮罩 blur / 进揭示逻辑） */
                    <span style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, color: "var(--ink-4)" }}>未配置模型服务 · 无译文产出</span>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          nav.push("setModel");
                        }}
                      >
                        去配置
                      </button>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          translateSentence(s.idx);
                        }}
                      >
                        重试
                      </button>
                    </span>
                  ) : (
                    <span className="sent-zh" data-zh={s.idx}>
                      <button
                        className="tlink"
                        style={{ fontSize: 13 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          translateSentence(s.idx);
                        }}
                      >
                        翻译这句
                      </button>
                    </span>
                  ))}
              </span>
            ))}
          </div>
        ))}
        <div className="meta" style={{ textAlign: "center", padding: "6px 0 10px" }}>
          读完啦 · 把生词复习一遍吧
        </div>
      </div>
      <div className="rd-playbar">
        <button
          className="iconbtn"
          aria-label="上一句"
          onClick={() => {
            stopPlay();
            const nx = Math.max(0, sent - 1);
            setSent(nx);
            scrollToSent(nx);
          }}
        >
          <Icon name="prev" size={18} />
        </button>
        <button
          className="iconbtn"
          aria-label={playing ? "暂停" : "播放"}
          onClick={() => (playing ? stopPlay() : playFrom(sent, false))}
        >
          <Icon name={playing ? "pause" : "play"} size={20} />
        </button>
        <button
          className="iconbtn"
          aria-label="下一句"
          onClick={() => {
            stopPlay();
            const nx = Math.min(total - 1, sent + 1);
            setSent(nx);
            scrollToSent(nx);
          }}
        >
          <Icon name="next" size={18} />
        </button>
        <span className="cnt num">
          第 {sent + 1}/{total} 句
        </span>
        <span className="spacer" />
        <button
          className="iconbtn"
          aria-label="语速"
          onClick={() => actions.setSheet({ kind: "rate" })}
        >
          <Icon name="slow" size={18} />
        </button>
        <button className="iconbtn" aria-label="排版" onClick={() => actions.setSheet({ kind: "aa" })}>
          <Icon name="aa" size={18} />
        </button>
        <button
          className="iconbtn"
          aria-label="跟读此句"
          onClick={() => {
            stopPlay();
            nav.push("shadow", { fromArticle: article.title, sentIdx: sent });
          }}
        >
          <Icon name="mic" size={18} />
        </button>
      </div>
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
    <span className={`sent-en ${prefs.mode === "zh" ? "rd-hidden-en" : ""}`} style={{ fontSize: prefs.fs }}>
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
