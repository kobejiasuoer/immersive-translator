/**
 * 判分内核（完形/听写）——与 reading-room-recall brief §3 及桌面端规划的
 * recallJudge.ts 同源。纯函数，M1 时迁入 packages/reader-core。
 */

export function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export type Verdict = "perfect" | "close" | "trap" | "wrong";

import type { ReviewGrade } from "./srs";

export function judge(input: string, answer: string, trap?: string, accepted: string[] = []): Verdict {
  const i = norm(input);
  const a = norm(answer);
  if (!i) return "wrong";
  if (i === a || accepted.some((x) => norm(x) === i)) return "perfect";
  const t = norm(trap || "");
  if (t && (i === t || (t.length > 6 && i.includes(t)))) return "trap";
  const strip = (x: string) => x.replace(/\b(a|an|the)\b/g, "").replace(/\s+/g, " ").trim();
  if (strip(i) === strip(a)) return "close";
  if (levenshtein(i, a) <= Math.max(1, Math.floor(a.length / 6))) return "close";
  return "wrong";
}

export interface DiffToken {
  w: string;
  s: "ok" | "miss" | "extra";
}

/** 词级 diff（听写）：LCS 对齐。 */
export function wordDiff(input: string, answer: string): DiffToken[] {
  const tk = (s: string) => norm(s).split(" ").filter(Boolean);
  const A = tk(input);
  const B = tk(answer);
  const m = A.length;
  const n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const out: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      out.unshift({ w: B[j - 1], s: "ok" });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.unshift({ w: A[i - 1], s: "extra" });
      i--;
    } else {
      out.unshift({ w: B[j - 1], s: "miss" });
      j--;
    }
  }
  while (i > 0) {
    out.unshift({ w: A[i - 1], s: "extra" });
    i--;
  }
  while (j > 0) {
    out.unshift({ w: B[j - 1], s: "miss" });
    j--;
  }
  return out;
}

export const JUDGE_SUGGEST: Record<Verdict, ReviewGrade> = {
  perfect: "easy",
  close: "good",
  trap: "forgot",
  wrong: "forgot",
};
