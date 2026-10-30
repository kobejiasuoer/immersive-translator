export type ReviewGrade = "forgot" | "hard" | "good" | "easy";
export interface SrsState { ease: number; intervalDays: number; reps: number; dueAt: number; lapses: number }
export const GRADE_INTERVALS: Record<ReviewGrade, { ms: number; label: string }> = {
  forgot: { ms: 600000, label: "10 分钟" }, hard: { ms: 86400000, label: "1 天" },
  good: { ms: 259200000, label: "3 天" }, easy: { ms: 604800000, label: "7 天" },
};
export function initialSrs(now: number): SrsState { return { ease: 2.5, intervalDays: 0, reps: 0, dueAt: now, lapses: 0 }; }
export function gradeSrs(srs: SrsState, grade: ReviewGrade, now = Date.now()): SrsState {
  const delta = { forgot: -.2, hard: -.15, good: 0, easy: .15 }[grade];
  return { ease: Math.min(2.8, Math.max(1.3, srs.ease + delta)),
    intervalDays: grade === "forgot" ? 0 : Math.max(srs.intervalDays, { forgot: 0, hard: 1, good: 3, easy: 7 }[grade]),
    reps: srs.reps + 1, dueAt: now + GRADE_INTERVALS[grade].ms, lapses: srs.lapses + (grade === "forgot" ? 1 : 0) };
}
