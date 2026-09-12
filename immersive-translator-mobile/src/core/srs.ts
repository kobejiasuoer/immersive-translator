/**
 * SRS 调度（与桌面端 readerSrs.ts 同一套口径：四档定值间隔）。
 * M1 时由 packages/reader-core 替代。
 */

export type ReviewGrade = "forgot" | "hard" | "good" | "easy";

export const GRADE_INTERVALS: Record<ReviewGrade, { ms: number; label: string }> = {
  forgot: { ms: 10 * 60 * 1000, label: "10 分钟" },
  hard: { ms: 24 * 60 * 60 * 1000, label: "1 天" },
  good: { ms: 3 * 24 * 60 * 60 * 1000, label: "3 天" },
  easy: { ms: 7 * 24 * 60 * 60 * 1000, label: "7 天" },
};

export interface SrsState {
  ease: number;
  intervalDays: number;
  reps: number;
  dueAt: number;
  lapses: number;
}

const EASE_DELTA: Record<ReviewGrade, number> = { forgot: -0.2, hard: -0.15, good: 0, easy: 0.15 };

export function initialSrs(now: number): SrsState {
  return { ease: 2.5, intervalDays: 0, reps: 0, dueAt: now, lapses: 0 };
}

export function gradeSrs(srs: SrsState, grade: ReviewGrade, now = Date.now()): SrsState {
  const ease = Math.min(2.8, Math.max(1.3, srs.ease + EASE_DELTA[grade]));
  const forgot = grade === "forgot";
  const stepDays = { hard: 1, good: 3, easy: 7, forgot: 0 }[grade];
  return {
    ease,
    intervalDays: forgot ? 0 : Math.max(srs.intervalDays, stepDays),
    reps: srs.reps + 1,
    dueAt: now + GRADE_INTERVALS[grade].ms,
    lapses: srs.lapses + (forgot ? 1 : 0),
  };
}
