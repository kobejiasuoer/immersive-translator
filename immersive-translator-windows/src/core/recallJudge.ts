/**
 * 产出式复习（Active Recall）判分内核。纯函数、零 IO，全部可测。
 *
 * 三种练习形态共用一套判定：
 * - 完形（cloze）：原句挖空，输入被挖的词/词块；命中 trap 字段给「直译陷阱」专门反馈。
 * - 听写（dictation）：听整句写整句；字符级判分外按词级命中率复核（≥85% 算 close）。
 * - 识别（recognition）：现状翻卡，无判分（judged = null）。
 *
 * 判分只产出「建议档」，用户仍可改选任意档评分；SRS 演进（gradeSrs）不经过这里。
 */

import type { ReviewGrade } from "./readerSrs";
import type { RecallMode, ReviewModeSetting, VocabWord } from "./readerTypes";

export type { RecallMode, ReviewModeSetting };

/** 一次产出判定的结论。 */
export type RecallVerdict = "perfect" | "close" | "trap" | "wrong";

// ---------- 归一化与距离 ----------

/**
 * 答案归一化：小写、剥撇号（city's→citys，dont==don't）、其余非字母数字折叠为
 * 单空格、去首尾。中文按空格处理（trap 字段常带中文注释，归一化后注释自然脱落）。
 */
export function normalizeAnswer(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘ʼ']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 经典编辑距离（滚动数组）。 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// ---------- 判定 ----------

export interface JudgeOptions {
  /** 直译陷阱（词块标注产出）；可含多个候选，用 / 或 ； 分隔。 */
  trap?: string;
  /** 除答案外同样判 perfect 的形式（如词条原形 vs 句中屈折形式）。 */
  accepted?: string[];
}

/** 拆开 trap 字段的多候选并归一化。 */
function trapCandidates(trap: string | undefined): string[] {
  if (!trap) return [];
  return trap
    .split(/[/；;|]|或者|而非/g)
    .map((p) => normalizeAnswer(p))
    .filter(Boolean);
}

function matchTrap(input: string, trap: string | undefined): boolean {
  const t = normalizeAnswer(input);
  if (!t) return false;
  return trapCandidates(trap).some(
    (c) => t === c || (c.length >= 6 && t.includes(c)),
  );
}

function stripArticles(s: string): string {
  return s.replace(/\b(a|an|the)\b/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 完形/短答案判定。顺序：perfect → trap → close → wrong。
 * close 的两条路径：去冠词相等，或编辑距离 ≤ max(1, ⌊答案长度/6⌋)。
 */
export function judgeCloze(input: string, answer: string, opts: JudgeOptions = {}): RecallVerdict {
  const i = normalizeAnswer(input);
  const a = normalizeAnswer(answer);
  if (!i) return "wrong";
  if (i === a || (opts.accepted ?? []).some((x) => normalizeAnswer(x) === i)) return "perfect";
  if (matchTrap(i, opts.trap)) return "trap";
  if (stripArticles(i) === stripArticles(a)) return "close";
  const d = levenshtein(i, a);
  if (d <= Math.max(1, Math.floor(a.length / 6))) return "close";
  return "wrong";
}

// ---------- 词级 diff（听写） ----------

export type DiffTokenStatus = "ok" | "miss" | "extra";

export interface DiffToken {
  /** ok/miss 用答案侧原文，extra 用用户输入侧原文。 */
  text: string;
  status: DiffTokenStatus;
}

function tokens(s: string): string[] {
  return normalizeAnswer(s).split(" ").filter(Boolean);
}

/**
 * 词级对齐（LCS）：ok = 写对；miss = 漏写（答案里有、没写出来）；extra = 多写/写错。
 * miss/extra 各保留答案侧/输入侧文本，供界面分别标注。
 */
export function wordDiff(input: string, sentence: string): DiffToken[] {
  const a = tokens(input);
  const b = tokens(sentence);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.unshift({ text: b[j - 1], status: "ok" });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.unshift({ text: a[i - 1], status: "extra" });
      i -= 1;
    } else {
      out.unshift({ text: b[j - 1], status: "miss" });
      j -= 1;
    }
  }
  while (i > 0) {
    out.unshift({ text: a[i - 1], status: "extra" });
    i -= 1;
  }
  while (j > 0) {
    out.unshift({ text: b[j - 1], status: "miss" });
    j -= 1;
  }
  return out;
}

/** 听写词级命中：写对词数 / 答案词数。 */
export function wordHitRate(input: string, sentence: string): number {
  const total = tokens(sentence).length;
  if (total === 0) return 0;
  const ok = wordDiff(input, sentence).filter((t) => t.status === "ok").length;
  return ok / total;
}

/** 听写判定：字符级 perfect/trap 优先，其余按词级命中率复核（≥85% 算 close）。 */
export function judgeDictation(input: string, sentence: string, opts: JudgeOptions = {}): RecallVerdict {
  const i = normalizeAnswer(input);
  if (!i) return "wrong";
  if (i === normalizeAnswer(sentence)) return "perfect";
  if (matchTrap(i, opts.trap)) return "trap";
  return wordHitRate(input, sentence) >= 0.85 ? "close" : "wrong";
}

// ---------- 路由与映射 ----------

/**
 * 智能路由：词块 → 完形（语境产出搭配）；熟词（间隔 ≥ 1 天）→ 听写（绑定听力拼写）；
 * 新词 → 识别（先认脸）。reviewMode 非 smart 时直接透传。
 */
export function routeRecallMode(word: VocabWord, reviewMode: ReviewModeSetting): RecallMode {
  if (reviewMode !== "smart") return reviewMode;
  if (word.kind === "chunk") return "cloze";
  return word.srs.intervalDays >= 1 ? "dictation" : "recognition";
}

const VERDICT_SUGGESTED_GRADE: Record<RecallVerdict, ReviewGrade> = {
  perfect: "easy",
  close: "good",
  trap: "forgot",
  wrong: "forgot",
};

/** 判定 → 建议评分档（界面描边提示，用户可改选）。 */
export function verdictToSuggestedGrade(verdict: RecallVerdict): ReviewGrade {
  return VERDICT_SUGGESTED_GRADE[verdict];
}

/** 提示阶梯第 2 级：首字母 + 词数（如 "t… r…（2 词）" 的字母部分）。 */
export function firstLetters(answer: string): string {
  return tokens(answer)
    .map((w) => `${w[0]}…`)
    .join(" ");
}
