/**
 * 影子跟读当轮差词（模块导出态，P-44）——评估失败时由 ShadowScreen 写入，
 * 报告页与「只练差词」抽屉同源消费，不再各自写死词表。会话级，不落盘。
 */

/** 单轮跟读句数上限（ShadowScreen 取句与练一练页句数展示共用同一口径）。 */
export const SHADOW_MAX_SENTS = 6;

export interface ShadowDiffWord {
  word: string;
  /** 当轮被标红次数（跨句去重计数） */
  count: number;
}

let diffWords: ShadowDiffWord[] = [];

/** 写入当轮真实差词（传各句 miss 的平铺数组，内部去重计数）。 */
export function setShadowDiffWords(words: string[]): void {
  const counts = new Map<string, number>();
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  diffWords = Array.from(counts, ([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
}

export function getShadowDiffWords(): ShadowDiffWord[] {
  return diffWords;
}
