/**
 * ISE 识别词 → 原文词对齐（着色用）—— 移植 mac XfyunIse.swift:230-325 的
 * mapWordsToText（保序最大匹配 DP），批次二跟读评测的词级标红数据源。
 *
 * 背景：ISE 返回的 word 只有音频帧位置、没有字符位置；read_sentence 的强制
 * 对齐保持词序，但识别词序列与原文 token 序并非逐一同名（增读/漏读/连字符
 * 切分），直接按下标配对会整体错位。
 *
 * 严禁贪心：贪心向前扫在重复词（the/to/that）上会把后出现的识别词抢先配给
 * 前面的原文词，着色整体错位——这里用小规模 DP 记忆化求保序最大匹配。
 */
import type { IseWordTS } from "../services/voice";

/** 原文词质量档位（着色口径照 XfyunIse.swift:310-320）。 */
export type WordQuality = "missed" | "good" | "ok" | "bad";

/** 原文一个词的着色标记（字符区间为原文偏移）。 */
export interface WordMark {
  start: number;
  end: number;
  /** 归一化词（lowercase + 去弯直引号）。 */
  word: string;
  quality: WordQuality;
  /** ISE 词分（0-5；missed 时无意义，保留供展示）。 */
  score: number;
}

/** 归一化：lowercase → 弯引号归直 → 去引号（XfyunIse.swift:232-236）。 */
export function normalizeIseWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'/g, "");
}

/** 原文 token：正则与 Swift 同源 [A-Za-z0-9'‘’-]+（字符类含 '-'，连字符词为单一 token）。 */
const TOKEN_RE = /[A-Za-z0-9'‘’-]+/g;

/** ISE 词分缺失/null 视为 0（照 Swift `?? 0` 口径）。 */
function scoreOf(word: IseWordTS): number {
  return typeof word.totalScore === "number" ? word.totalScore : 0;
}

interface Token {
  start: number;
  end: number;
  norm: string;
}

/**
 * 把 ISE 返回的词序列映射到原文的字符区间（保序最大匹配）。
 * · dp=32（增读）原文没有位置，不参与对齐；
 * · dp=16（漏读）→ missed；其余按词分 ≥4 good / ≥3 ok / 否则 bad；
 * · 未被任何识别词配上的原文 token 不产生 mark（不着色）。
 */
export function alignWords(text: string, words: IseWordTS[]): WordMark[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const idx = m.index;
    if (idx == null) continue;
    tokens.push({ start: idx, end: idx + raw.length, norm: normalizeIseWord(raw) });
  }

  const usable = words
    .filter((w) => w && w.dpMessage !== 32)
    .map((w) => ({ word: w, norm: normalizeIseWord(w.content || "") }))
    .filter((u) => u.norm.length > 0);

  const n = usable.length;
  const t = tokens.length;
  if (n === 0 || t === 0) return [];

  interface Choice {
    count: number;
    take: boolean;
    match: number;
  }
  const memo = new Map<number, Choice>();

  /** best(i, p)：usable[i..] 与 tokens[p..] 的保序最大匹配数（记忆化）。 */
  function best(i: number, p: number): Choice {
    if (i >= n || p >= t) return { count: 0, take: false, match: -1 };
    const key = i * (t + 1) + p;
    const hit = memo.get(key);
    if (hit) return hit;
    // 选项 A：识别词 i 对不上（放弃着色）
    let count = best(i + 1, p).count;
    let take = false;
    let match = -1;
    // 选项 B：配到 p 之后第一处同名词
    let k = p;
    while (k < t && tokens[k].norm !== usable[i].norm) k += 1;
    if (k < t) {
      const via = best(i + 1, k + 1).count + 1;
      if (via > count) {
        count = via;
        take = true;
        match = k;
      }
    }
    const result: Choice = { count, take, match };
    memo.set(key, result);
    return result;
  }

  const marks: WordMark[] = [];
  let p = 0;
  for (let i = 0; i < n; i++) {
    const choice = best(i, p);
    if (!choice.take) continue;
    const word = usable[i].word;
    const token = tokens[choice.match];
    // dp=16 漏读 → missed；dp=128（读成别的词）读是读了但读错 → 按分数着色
    let quality: WordQuality;
    if (word.dpMessage === 16) {
      quality = "missed";
    } else {
      const s = scoreOf(word);
      quality = s >= 4 ? "good" : s >= 3 ? "ok" : "bad";
    }
    marks.push({
      start: token.start,
      end: token.end,
      word: token.norm,
      quality,
      score: scoreOf(word),
    });
    p = choice.match + 1;
  }
  return marks;
}

/* ===================== 自测（重复 the 不错位等用例） ===================== */

export interface AlignSelfCase {
  name: string;
  ok: boolean;
  detail: string;
}

function w(content: string, totalScore: number, dpMessage = 0): IseWordTS {
  return { content, totalScore, dpMessage };
}

/** 跑对齐自测：全部通过返回 true；Playwright / 控制台消费。 */
export function runAlignSelfTest(): AlignSelfCase[] {
  const cases: Array<{ name: string; text: string; words: IseWordTS[]; expect: Array<[string, WordQuality]> }> = [
    {
      // 重复 the：第二个 the 漏读（dp=16）必须落在第二个 the 的区间，不能抢配第一个
      name: "重复 the 漏读不错位",
      text: "The dog chased the cat.",
      words: [w("the", 4.9), w("dog", 4.7), w("chased", 4.5), w("the", 0, 16), w("cat", 2.0)],
      expect: [
        ["the", "good"],
        ["dog", "good"],
        ["chased", "good"],
        ["the", "missed"],
        ["cat", "bad"],
      ],
    },
    {
      // 识别序列混入增读词（dp=32）：不参与对齐，其余按序配
      name: "增读词(dp=32)不参与对齐",
      text: "to be or not to be",
      words: [w("um", 0, 32), w("to", 4.8), w("be", 4.6), w("or", 4.9), w("not", 4.4), w("to", 4.5), w("be", 4.7), w("yeah", 0, 32)],
      expect: [
        ["to", "good"],
        ["be", "good"],
        ["or", "good"],
        ["not", "good"],
        ["to", "good"],
        ["be", "good"],
      ],
    },
    {
      // 三个 the 全 ok：各自配自己的区间（保序，不交叉）
      name: "三处 the 保序各配其位",
      text: "the end of the day and the night",
      words: [w("the", 4.8), w("end", 4.5), w("of", 4.6), w("the", 4.4), w("day", 4.7), w("and", 4.3), w("the", 4.5), w("night", 4.6)],
      expect: [
        ["the", "good"],
        ["end", "good"],
        ["of", "good"],
        ["the", "good"],
        ["day", "good"],
        ["and", "good"],
        ["the", "good"],
        ["night", "good"],
      ],
    },
    {
      // 连字符词是单一 token（字符类含 '-'，"car-free" 不切分，Swift 同口径）：
      // ISE 识别侧常切成 car + free 两词，与整体 token "car-free" 不同名配不上 →
      // 跳过不着色（而非错位挤占后续词位），其余词按序各配其位
      name: "连字符词不切开·识别切开时不错位",
      text: "The idea of car-free streets took root.",
      words: [w("the", 4.9), w("idea", 4.8), w("of", 4.6), w("car", 4.2), w("free", 3.2), w("streets", 2.2), w("took", 4.4), w("root", 4.5)],
      expect: [
        ["the", "good"],
        ["idea", "good"],
        ["of", "good"],
        ["streets", "bad"],
        ["took", "good"],
        ["root", "good"],
      ],
    },
    {
      // 漏读中间词：后续词跳过空洞配对，不错位
      name: "漏读中间词后不错位",
      text: "the more the merrier",
      words: [w("the", 0, 16), w("more", 4.5), w("merrier", 4.4)],
      expect: [
        ["the", "missed"],
        ["more", "good"],
        ["merrier", "good"],
      ],
    },
  ];

  return cases.map((c) => {
    const marks = alignWords(c.text, c.words).map((m) => [m.word, m.quality] as [string, WordQuality]);
    const got = JSON.stringify(marks);
    const want = JSON.stringify(c.expect);
    return { name: c.name, ok: got === want, detail: `got ${got}` };
  });
}
