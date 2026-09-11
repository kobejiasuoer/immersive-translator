/**
 * 生词本 SRS（间隔重复）核心。
 *
 * 到期判定与所有计数共享同一份 `VocabWord.srs.dueAt` 状态（§9-3 的口径修正：
 * 不允许出现「计数用总数、词条写下次时间」的两套账）。
 *
 * 四档评分间隔为文档定值；ease / reps / lapses 同步演进，供后续算法升级用。
 */

import type { VocabSrsState, VocabWord } from "./readerTypes";

export type ReviewGrade = "forgot" | "hard" | "good" | "easy";

/** 四档评分的固定间隔（毫秒）与文案（屏 D 评分带）。 */
export const GRADE_INTERVALS: Record<ReviewGrade, { ms: number; label: string }> = {
  forgot: { ms: 10 * 60 * 1000, label: "10 分钟" },
  hard: { ms: 24 * 60 * 60 * 1000, label: "1 天" },
  good: { ms: 3 * 24 * 60 * 60 * 1000, label: "3 天" },
  easy: { ms: 7 * 24 * 60 * 60 * 1000, label: "7 天" },
};

const EASE_DELTA: Record<ReviewGrade, number> = {
  forgot: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

const EASE_MIN = 1.3;
const EASE_MAX = 2.8;

export function initialSrs(now: number): VocabSrsState {
  // 新词当天即可复习：dueAt = now。
  return { ease: 2.5, intervalDays: 0, reps: 0, dueAt: now, lapses: 0 };
}

/** 应用一档评分，返回新的 SRS 状态（不修改入参）。 */
export function gradeSrs(srs: VocabSrsState, grade: ReviewGrade, now = Date.now()): VocabSrsState {
  const ease = Math.min(EASE_MAX, Math.max(EASE_MIN, srs.ease + EASE_DELTA[grade]));
  const forgot = grade === "forgot";
  return {
    ease,
    // 忘记重置为 10 分钟（不足 1 天按 0 记）；其余按定值升档
    intervalDays: forgot ? 0 : Math.max(srs.intervalDays, gradeIntervalDays(grade)),
    reps: srs.reps + 1,
    dueAt: now + GRADE_INTERVALS[grade].ms,
    lapses: srs.lapses + (forgot ? 1 : 0),
  };
}

function gradeIntervalDays(grade: ReviewGrade): number {
  return { hard: 1, good: 3, easy: 7, forgot: 0 }[grade];
}

export function isDue(word: VocabWord, now = Date.now()): boolean {
  return word.srs.dueAt <= now;
}

/** 排序：最紧急的在前。 */
export function dueVocab(vocab: VocabWord[], now = Date.now()): VocabWord[] {
  return vocab.filter((w) => isDue(w, now)).sort((a, b) => a.srs.dueAt - b.srs.dueAt);
}

/** 本地日期键（打卡/今日计数用，按用户本地时区）。 */
export function dayKey(now = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function dayKeyOffset(now: number, offsetDays: number): string {
  return dayKey(now + offsetDays * 24 * 60 * 60 * 1000);
}

export interface ReviewStats {
  /** 到期待复习数（同一份 dueAt 判定）。 */
  dueNow: number;
  /** 今天已完成复习数（按评分时间落在本地今天）。 */
  reviewedToday: number;
  /** 全库生词数。 */
  total: number;
  /** 连续打卡天数（今天或昨天截止的连续复习日）。 */
  streak: number;
  /** 掌握度分布：按当前 intervalDays 分桶。 */
  distribution: { learning: number; familiar: number; mastered: number };
  /** 单词/词块分开计数（左栏统计；kind 缺省视为单词）。 */
  totalWords: number;
  totalChunks: number;
  dueWords: number;
  dueChunks: number;
}

/** 复习时间线：每次评分的 { 天键, 次数 }。由存储层持久化。 */
export interface ReviewLogDay {
  day: string;
  count: number;
}

export interface ReviewLogFile {
  schemaVersion: number;
  days: ReviewLogDay[];
}

/**
 * 由词汇表 + 复习日志推导统计。计数与到期判定同源。
 * now 可注入以便测试。
 */
export function reviewStats(
  vocab: VocabWord[],
  log: ReviewLogFile,
  now = Date.now(),
): ReviewStats {
  const today = dayKey(now);
  const yesterday = dayKeyOffset(now, -1);

  // streak：从今天（若今天没复习则从昨天）往回数连续有复习记录的天数。
  const daySet = new Set(log.days.map((d) => d.day));
  let streak = 0;
  let cursor = daySet.has(today) ? today : daySet.has(yesterday) ? yesterday : "";
  while (cursor && daySet.has(cursor)) {
    streak++;
    const [y, m, d] = cursor.split("-").map(Number);
    const prev = new Date(y, m - 1, d - 1);
    const pm = String(prev.getMonth() + 1).padStart(2, "0");
    const pd = String(prev.getDate()).padStart(2, "0");
    cursor = `${prev.getFullYear()}-${pm}-${pd}`;
  }

  const distribution = { learning: 0, familiar: 0, mastered: 0 };
  let totalWords = 0;
  let totalChunks = 0;
  let dueWords = 0;
  let dueChunks = 0;
  for (const w of vocab) {
    if (w.srs.intervalDays >= 7) distribution.mastered++;
    else if (w.srs.intervalDays >= 1) distribution.familiar++;
    else distribution.learning++;
    if (w.kind === "chunk") {
      totalChunks++;
      if (w.srs.dueAt <= now) dueChunks++;
    } else {
      totalWords++;
      if (w.srs.dueAt <= now) dueWords++;
    }
  }

  return {
    dueNow: dueVocab(vocab, now).length,
    reviewedToday: log.days.find((d) => d.day === today)?.count ?? 0,
    total: vocab.length,
    streak,
    distribution,
    totalWords,
    totalChunks,
    dueWords,
    dueChunks,
  };
}

/** 在复习日志上记一次评分（返回新日志，不改入参）。 */
export function recordReview(log: ReviewLogFile, now = Date.now()): ReviewLogFile {
  const day = dayKey(now);
  const days = [...log.days];
  const idx = days.findIndex((d) => d.day === day);
  if (idx >= 0) days[idx] = { ...days[idx], count: days[idx].count + 1 };
  else days.push({ day, count: 1 });
  // 只保留近 365 天，防无限膨胀。
  const cutoff = dayKeyOffset(now, -365);
  return { schemaVersion: log.schemaVersion, days: days.filter((d) => d.day >= cutoff) };
}
