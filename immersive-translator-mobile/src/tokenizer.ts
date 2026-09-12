import { useEffect, useMemo, useState } from "react";
import { norm } from "./core/judge";
import type { SentenceChunk } from "./core/types";

export interface Tok {
  text: string;
  isWord: boolean;
  chunkIdx: number; // -1 = 非词块
  saved: boolean;
}

/**
 * 句子分词 + 词块标记 + 已收藏高亮（含 -s 复数回落）。
 * 与桌面端 tokenize 语义一致；M1 迁 packages/reader-core。
 */
export function tokenize(
  text: string,
  chunks: SentenceChunk[] | undefined,
  savedKeys: Set<string>,
): Tok[] {
  const toks = text.match(/[A-Za-z0-9'’-]+|[^A-Za-z0-9'’-]+/g) || [];
  const isW = (t: string) => /^[A-Za-z0-9'’-]+$/.test(t);
  const marks = new Array<number>(toks.length).fill(-1);
  (chunks || []).forEach((ch, ci) => {
    const needle = norm(ch.text).split(" ").filter(Boolean);
    if (!needle.length) return;
    for (let i = 0; i < toks.length; i++) {
      if (!isW(toks[i])) continue;
      let k = i;
      let j = 0;
      while (j < needle.length && k < toks.length) {
        if (!isW(toks[k])) {
          k++;
          continue;
        }
        if (toks[k].toLowerCase().replace("’", "'") === needle[j]) {
          j++;
          k++;
        } else break;
      }
      if (j === needle.length) {
        for (let x = i; x < k; x++) if (isW(toks[x])) marks[x] = ci;
        break;
      }
    }
  });
  const has = (key: string) => {
    if (savedKeys.has(key)) return true;
    if (key.endsWith("s") && savedKeys.has(key.slice(0, -1))) return true;
    return false;
  };
  return toks.map((t, i) => {
    if (!isW(t)) return { text: t, isWord: false, chunkIdx: -1, saved: false };
    const key = norm(t);
    const chunkWord = marks[i] >= 0 ? chunks![marks[i]].word : undefined;
    return {
      text: t,
      isWord: true,
      chunkIdx: marks[i],
      saved: has(key) || (chunkWord ? has(norm(chunkWord)) : false),
    };
  });
}

/** 段落 → [{句子文本, 句 idx}]。 */
export function splitParagraph(en: string, startIdx: number): { text: string; idx: number }[] {
  const parts = en.match(/[^.!?]+[.!?]+["']?\s*|[^.!?]+$/g) || [en];
  const out: { text: string; idx: number }[] = [];
  parts.forEach((s) => {
    const t = s.trim();
    if (t) out.push({ text: t, idx: startIdx + out.length });
  });
  return out;
}

export interface ParaView {
  sentences: { text: string; idx: number }[];
}

export function useSavedKeys(vocabWords: string[]): Set<string> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Set(vocabWords.map(norm)), [vocabWords.join(",")]);
}

/** 渲染耗时测量（perf pill 用）。 */
export function useRenderMs(deps: unknown[]): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setMs(Math.round(performance.now() - t0)));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ms;
}
