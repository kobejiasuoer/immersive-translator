import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Article, SentenceChunk } from "../core/types";
import { norm } from "../core/judge";
import { MINI_DICT } from "../core/data";
import { actions, speak, stopSpeak, useApp } from "../store";
import { tokenize, useSavedKeys, useRenderMs } from "../tokenizer";

/**
 * 阅读层 —— spike 的核心试验场：
 *  S2 性能：全量渲染（无虚拟化），perf pill 显示首屏渲染 ms + DOM 节点数；
 *  S3a TTS：Web Speech 逐句连播（onend + 兜底双保险）；
 *  tap 查词：词/词块/已收藏高亮（-s 回落）。
 */
export default function ReaderScreen({ article, onClose }: { article: Article; onClose: () => void }) {
  const vocab = useApp((s) => s.vocab);
  const savedKeys = useSavedKeys(vocab.map((v) => v.word));
  const [si, setSi] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [masked, setMasked] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const playRef = useRef(false);

  // 段落视图（切句规则与数据构建一致，句 idx 对齐）
  const paras = useMemo(() => {
    return article.paragraphStarts.map((start, pi) => {
      const src = article.sentences[start];
      // 段落原文 = 该段句子的拼接；直接按句子渲染，zh 取该段首句的 zh
      return {
        sentences: article.sentences.filter((s) => s.paragraphIdx === pi),
        zh: src?.zh || "",
      };
    });
  }, [article]);

  const nodeCount = useMemo(() => paras.reduce((n, p) => n + p.sentences.reduce((m, s) => m + tokenize(s.en, s.chunks, savedKeys).length, 0), 0), [paras, savedKeys]);
  const renderMs = useRenderMs([article.id, masked]);

  useEffect(() => {
    return () => {
      playRef.current = false;
      stopSpeak();
    };
  }, []);

  function stepTo(next: number, autoplay: boolean) {
    const clamped = Math.max(0, Math.min(article.sentences.length - 1, next));
    setSi(clamped);
    const el = bodyRef.current?.querySelector(`[data-si="${clamped}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (autoplay && playRef.current) {
      speak(article.sentences[clamped].en, rate, () => stepTo(clamped + 1, true));
    }
  }

  function togglePlay() {
    if (playing) {
      playRef.current = false;
      setPlaying(false);
      stopSpeak();
      return;
    }
    playRef.current = true;
    setPlaying(true);
    speak(article.sentences[si].en, rate, () => stepTo(si + 1, true));
  }

  function onBodyClick(e: MouseEvent) {
    const tok = (e.target as HTMLElement).closest(".tok") as HTMLElement | null;
    if (tok && !tok.classList.contains("pu")) {
      const sentEl = tok.closest("[data-si]") as HTMLElement | null;
      const sentIdx = sentEl ? Number(sentEl.dataset.si) : si;
      const sent = article.sentences[sentIdx];
      if (tok.dataset.ck !== undefined && sent?.chunks) {
        openChunk(sent.chunks[Number(tok.dataset.ck)], sent);
      } else {
        openWord(tok.dataset.t || tok.textContent || "", sent);
      }
      return;
    }
    const zh = (e.target as HTMLElement).closest(".zh") as HTMLElement | null;
    if (zh && masked) {
      const pi = Number(zh.dataset.pi);
      setRevealed((prev) => new Set(prev).add(pi));
      return;
    }
    const sentEl = (e.target as HTMLElement).closest("[data-si]") as HTMLElement | null;
    if (sentEl) {
      stopSpeak();
      playRef.current = true;
      setPlaying(true);
      stepTo(Number(sentEl.dataset.si), true);
    }
  }

  function openWord(surface: string, sent: { en: string }) {
    const key = norm(surface);
    const keyBase = key.endsWith("s") ? key.slice(0, -1) : key;
    const saved = vocab.find((v) => norm(v.word) === key || norm(v.word) === keyBase);
    if (saved) {
      actions.setSheet({ word: saved.word, kind: saved.kind || "word", chunkType: saved.chunkType, phonetic: saved.phonetic, senses: saved.senses, pattern: saved.pattern, trap: saved.trap, sentence: sent.en, saved: true });
      return;
    }
    const d = MINI_DICT[key] || MINI_DICT[keyBase];
    actions.setSheet({
      word: surface,
      kind: "word",
      senses: d?.senses || [{ pos: "", cn: "（spike：未接入词典）" }],
      trap: d?.trap,
      sentence: sent.en,
      saved: false,
    });
  }

  function openChunk(ch: SentenceChunk | undefined, sent: { en: string }) {
    if (!ch) return;
    const saved = vocab.find((v) => norm(v.word) === norm(ch.word || ""));
    if (saved) {
      actions.setSheet({ word: saved.word, kind: "chunk", chunkType: saved.chunkType, senses: saved.senses, pattern: saved.pattern, trap: saved.trap, sentence: sent.en, saved: true });
      return;
    }
    actions.setSheet({
      word: ch.word || ch.text,
      kind: "chunk",
      chunkType: CHUNK_TYPE_LABEL[ch.chunkType],
      senses: [{ pos: ch.chunkType, cn: ch.gloss }],
      pattern: ch.pattern,
      trap: ch.trap,
      sentence: sent.en,
      saved: false,
    });
  }

  return (
    <div className={`reader ${masked ? "masked" : ""}`}>
      <div className="perf-pill">
        {renderMs}ms · {article.sentences.length}句 · {nodeCount}节点
      </div>
      <div className="r-top">
        <button className="x" onClick={() => { playRef.current = false; stopSpeak(); onClose(); }}>
          ‹
        </button>
        <div className="tt">
          <div className="a serif-en">{article.title}</div>
          <div className="b">
            {si + 1} / {article.sentences.length}
          </div>
        </div>
        <button className={`rbtn ${masked ? "on" : ""}`} onClick={() => setMasked((m) => !m)} title="遮罩中文">
          目
        </button>
      </div>
      <div className="minibar">
        <button className="play-mini" onClick={togglePlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="m-info">
          第 <b>{si + 1}</b> 句 · 逐句朗读
        </span>
        <button style={{ border: "none", background: "transparent", color: "var(--text-3)", fontSize: 12, padding: "4px 6px" }} onClick={() => setRate((r) => (r === 1 ? 1.25 : r === 1.25 ? 0.85 : 1))}>
          {rate}×
        </button>
      </div>
      <div className="r-body" ref={bodyRef} onClick={onBodyClick}>
        {paras.map((p, pi) => (
          <div className="para" key={pi}>
            <div className="en">
              {p.sentences.map((s) => (
                <span key={s.idx} data-si={s.idx} className={`sent ${s.idx === si ? "cur" : ""}`}>
                  {tokenize(s.en, s.chunks, savedKeys).map((t, i) =>
                    !t.isWord ? (
                      <span key={i} className="tok pu">
                        {t.text}
                      </span>
                    ) : (
                      <span
                        key={i}
                        className={`tok ${t.chunkIdx >= 0 ? "ck" : ""} ${t.saved ? "sv" : ""}`}
                        data-ck={t.chunkIdx >= 0 ? t.chunkIdx : undefined}
                        data-t={t.text}
                      >
                        {t.text}
                      </span>
                    ),
                  )}
                 {" "}
                </span>
              ))}
            </div>
            <p className={`zh ${revealed.has(pi) ? "revealed" : ""}`} data-pi={pi} onClick={(e) => e.stopPropagation()}>
              {p.zh}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

const CHUNK_TYPE_LABEL: Record<string, string> = {
  collocation: "搭配",
  phrasal: "短语动词",
  idiom: "习语",
  pattern: "句式",
};
