/**
 * 生词本 SRS（间隔重复）核心。
 *
 * 到期判定与所有计数共享同一份 `VocabWord.srs.dueAt` 状态（§9-3 的口径修正：
 * 不允许出现「计数用总数、词条写下次时间」的两套账）。
 *
 * 四档评分间隔为文档定值；ease / reps / lapses 同步演进，供后续算法升级用。
 */

import type { VocabWord } from "./readerTypes";

export { GRADE_INTERVALS, initialSrs, gradeSrs } from "../../../packages/learning-core/src/srs";
export type { ReviewGrade } from "../../../packages/learning-core/src/srs";
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
  /** 今日累计阅读秒数（Rust compute_stats 从 reading_log 汇总；仅 readerStats 命令返回）。 */
  readSecondsToday?: number;
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

// ---------- v0.8 内化看板派生（Phase 4） ----------

/**
 * 词块内化三阶段（交接语义）：
 * - s1 刚收集（intervalDays < 1 且从未在口语中用出）
 * - s2 眼熟能认（intervalDays ≥ 1，阅读遇到能懂）
 * - s3 已变成口语表达（spokenAt 存在即升 s3——「在对话中说出」优先于间隔）
 *
 * 与 reviewStats.distribution 是两套口径：distribution 按纯间隔分桶（复习闭环
 * 用），masteryStage 把「口语中用出」视为最高阶。计数一律由本函数统一派生，
 * 不得另立口径。
 */
export type MasteryStage = "s1" | "s2" | "s3";

export function masteryStage(word: VocabWord): MasteryStage {
  if (word.spokenAt) return "s3";
  return word.srs.intervalDays >= 1 ? "s2" : "s1";
}

/** 热力格档位：0 无记录 / 1 少（<3 次）/ 2 中（3-6 次）/ 3 多（>6 次）。 */
export interface HeatBucket {
  /** 本地日期键（YYYY-MM-DD）。 */
  dayKey: string;
  level: 0 | 1 | 2 | 3;
  /** 当日复习次数（title 提示用）。 */
  count: number;
  /** 是否今天这一格。 */
  today: boolean;
}

/**
 * 近 28 天（含今天）每日复习次数分桶，旧 → 新排列（14 列 × 2 行矩阵）。
 * 数据源是复习日志 reviewLog.days（即交接说的 stats.days 口径）。
 */
export function heatBuckets(log: ReviewLogFile, now = Date.now()): HeatBucket[] {
  const byDay = new Map(log.days.map((d) => [d.day, d.count]));
  const today = dayKey(now);
  const out: HeatBucket[] = [];
  for (let offset = 27; offset >= 0; offset -= 1) {
    const key = dayKeyOffset(now, -offset);
    const count = byDay.get(key) ?? 0;
    const level: HeatBucket["level"] = count === 0 ? 0 : count < 3 ? 1 : count <= 6 ? 2 : 3;
    out.push({ dayKey: key, level, count, today: key === today });
  }
  return out;
}
