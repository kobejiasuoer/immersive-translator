/**
 * 笔记与复习域派生（vault-review-parity）：掌握阶段 / 待强化 / 学习记录 / 到期时间文案。
 * 全部由既有数据只读推导——阶段用 vocab.srs（由 reviewEvents 经 reduceReviewEvents 归约维护，
 * 不新增同步字段）；「待强化」= 最近一次有效评分为 forgot 且尚未到期（原型 grade=0 未到期档，
 * forgot 固定 10 分钟回流）。计数口径：查词 = 非 spoken 的复习评分事件（每次复习即一次接触）；
 * 开口 = spoken 复习事件 + 口语练习里该表达已确认文字的回答（attempts）。不伪造任何数值。
 */
import type { ReviewGrade, ReviewEvent } from "../../../../packages/learning-core/src/index";
import type { VocabWord } from "../../core/types";
import type { AppState } from "../../store";
import type { PracticeAttempt, PracticeTask } from "../../services/practice";

export type Stage = "new" | "early" | "solid" | "mastered";
/* 阶段命名对齐原型口径（mobile-accepted-2026-10-29.html：刚收集/眼熟/能说出口三档，
   html:2838/2853）：间隔推导的 early/solid 在展示层同归「眼熟」，mastered=能说出口。 */
export const STAGE_LABEL: Record<Stage, string> = { new: "刚收集", early: "眼熟", solid: "眼熟", mastered: "能说出口" };
export const STAGE_ORDER: Stage[] = ["new", "early", "solid", "mastered"];

/** 原型三档展示桶（筛选/统计用）：刚收集 / 眼熟（初识+巩固）/ 能说出口；「已暂停」由 paused 字段承担。 */
export type StageBucket = "fresh" | "familiar" | "spoken";
export const STAGE_BUCKET_LABEL: Record<StageBucket, string> = { fresh: "刚收集", familiar: "眼熟", spoken: "能说出口" };

/** 「我对这个词的感觉」自评（设备本地 local.vocabFeel，键沿用 forgot/hard/easy，不进同步载荷）。 */
export type Feel = "forgot" | "hard" | "easy";
export const FEEL_KEYS: Feel[] = ["forgot", "hard", "easy"];
const FEEL_BUCKET: Record<Feel, StageBucket> = { forgot: "fresh", hard: "familiar", easy: "spoken" };
export const BUCKET_FEEL: Record<StageBucket, Feel> = { fresh: "forgot", familiar: "hard", spoken: "easy" };

/** 掌握阶段（复检 r1 · 原型 w.stage 口径，html:2838/2853/2863/3081-3085）：原型的阶段就是
 *  学习者的自评（「掌握阶段是你的学习感受」「“能说出口”表示你自评能主动使用，可随时调整」），
 *  统计三格 / 阶段筛选 / 列表 tag / 详情 chips 读同一个值——有自评时以自评为准，
 *  未自评时回退由 srs 间隔推导的桶（reps=0 刚收集，<7 天眼熟，≥7 天能说出口）。 */
export function stageBucketOf(word: VocabWord, feel?: Feel | null): StageBucket {
  if (feel) return FEEL_BUCKET[feel];
  const stage = stageOf(word);
  return stage === "new" ? "fresh" : stage === "mastered" ? "spoken" : "familiar";
}

/** 音标展示口径（原型 /ˌvɒlənˈtɪəz/）：去掉来源自带的 / 或 [ ] 包裹后统一包成 /…/；无音标返回空串。 */
export function phoneticLabel(phonetic?: string): string {
  const core = (phonetic || "").trim().replace(/^[/[\s]+|[/\]\s]+$/g, "");
  return core ? `/${core}/` : "";
}

/** 掌握阶段：reps=0 新收；intervalDays<3 初识；<7 巩固；≥7 掌握（间隔档与 GRADE_INTERVALS 对应：hard=1/good=3/easy=7 天）。 */
export function stageOf(word: VocabWord): Stage {
  const reps = word.srs?.reps ?? 0;
  const interval = word.srs?.intervalDays ?? 0;
  if (reps <= 0) return "new";
  if (interval < 3) return "early";
  if (interval < 7) return "solid";
  return "mastered";
}

/** 该词的有效评分事件（undo 已回滚、被 supersede 的旧评分已剔除；与 reduceReviewEvents 的
   常规路径同语义的轻量只读版——srs 真值仍由 gradeVocab 内的完整归约维护）。 */
export function activeGradeEvents(events: ReviewEvent[], wordId: string): ReviewEvent[] {
  const mine = events.filter((e) => e.wordId === wordId);
  const reversed = new Set(mine.filter((e) => e.kind === "undo").map((e) => e.reversesEventId));
  const grades = mine.filter((e) => e.kind === "grade" && !reversed.has(e.id));
  const superseded = new Set(grades.filter((e) => e.supersedesEventId).map((e) => e.supersedesEventId!));
  return grades.filter((e) => !superseded.has(e.id)).sort((a, b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id, "en"));
}

export interface PendingReinforcement { word: VocabWord; dueAt: number; gradedAt: number }

/** 待强化：最近一次评分为 forgot 且未到期（10 分钟回流窗内），按 dueAt 升序。 */
export function pendingReinforcements(s: Pick<AppState, "vocab" | "reviewEvents">, now = Date.now()): PendingReinforcement[] {
  const out: PendingReinforcement[] = [];
  for (const word of s.vocab) {
    if (word.paused || word.dueAt <= now) continue;
    const grades = activeGradeEvents(s.reviewEvents, word.id);
    const last = grades[grades.length - 1];
    if (last?.grade === "forgot") out.push({ word, dueAt: word.dueAt, gradedAt: last.reviewedAt });
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

/** 到期时刻标签（原型 timeLabel 口径，html:1598-1605）：同日「今天 HH:MM」，前一日「昨天 HH:MM」，
 *  其余「M/D HH:MM」（如 11/5 02:24）。 */
export function clockLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${hm}`;
}

/** 到期时间文案（复检 r1 · 原型 v2LearningTime 口径，html:2783-2786）：已到期「现在可以开始」；
 *  一小时内「10 分钟后 · 今天 02:34」（相对 + 绝对时刻）；更远只给绝对时刻「11/5 02:24」。 */
export function formatDueAt(dueAt: number, now = Date.now()): string {
  if (dueAt <= now) return "现在可以开始";
  const left = Math.max(1, Math.ceil((dueAt - now) / 60000));
  return left < 60 ? `${left} 分钟后 · ${clockLabel(dueAt, now)}` : clockLabel(dueAt, now);
}

export const MODE_LABEL: Record<string, string> = { recognition: "识别", cloze: "完形", dictation: "听写", spoken: "开口" };
export const GRADE_LABEL: Record<ReviewGrade, string> = { forgot: "没记住", hard: "有点模糊", good: "想起来了", easy: "记住了" };

/* 原型 timeLabel 口径（html:1598-1605）：今天/昨天带 HH:MM，更早 M月D日 HH:MM。 */
export function timeLabel(at: number): string {
  const d = new Date(at), now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export interface VocabDerived {
  /** 有效评分事件（升序）。 */
  events: ReviewEvent[];
  /** 查词/复习接触次数（非 spoken 评分事件）。 */
  lookups: number;
  /** 开口次数（spoken 复习 + 练习中已确认文字的回答）。 */
  spoken: number;
  lastGrade?: ReviewGrade;
  lastReviewedAt?: number;
}

/** 一次遍历聚合全库词条派生（列表页/词条页共用；避免每词全量扫描）。 */
export function vocabDerived(s: Pick<AppState, "vocab" | "reviewEvents" | "tasks">): Map<string, VocabDerived> {
  const map = new Map<string, VocabDerived>();
  const ensure = (id: string): VocabDerived => {
    const hit = map.get(id);
    if (hit) return hit;
    const fresh: VocabDerived = { events: [], lookups: 0, spoken: 0 };
    map.set(id, fresh);
    return fresh;
  };
  for (const word of s.vocab) ensure(word.id);
  const reversed = new Set(s.reviewEvents.filter((e) => e.kind === "undo").map((e) => e.reversesEventId));
  for (const event of s.reviewEvents) {
    if (event.kind !== "grade") continue;
    const row = ensure(event.wordId);
    row.events.push(event);
    if (event.mode === "spoken") row.spoken += 1;
    else row.lookups += 1;
  }
  for (const row of map.values()) {
    const grades = row.events.filter((e) => !reversed.has(e.id));
    const superseded = new Set(grades.filter((e) => e.supersedesEventId).map((e) => e.supersedesEventId!));
    row.events = grades.filter((e) => !superseded.has(e.id)).sort((a, b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id, "en"));
    if (row.events.length) {
      const last = row.events[row.events.length - 1];
      row.lastGrade = last.grade;
      row.lastReviewedAt = last.reviewedAt;
    }
  }
  /* 练习开口：task.word 匹配的表达，已确认文字的回答计一次开口。 */
  for (const task of s.tasks as PracticeTask[]) {
    const target = task.word?.trim().toLowerCase();
    if (!target) continue;
    const word = s.vocab.find((w) => w.word.toLowerCase() === target);
    if (!word) continue;
    const spoken = (task.attempts as PracticeAttempt[]).filter((a) => a.text.trim().length > 0).length;
    if (spoken) ensure(word.id).spoken += spoken;
  }
  return map;
}

export interface SavedCorrection { task: PracticeTask; attempt: PracticeAttempt }

/** 已保存的口语纠偏（attempts.feedback.savedAt 落账的），按保存时间倒序。 */
export function savedCorrections(s: Pick<AppState, "tasks">): SavedCorrection[] {
  const out: SavedCorrection[] = [];
  for (const task of s.tasks as PracticeTask[]) {
    for (const attempt of task.attempts as PracticeAttempt[]) {
      if (attempt.feedback?.savedAt) out.push({ task, attempt });
    }
  }
  return out.sort((a, b) => (b.attempt.feedback!.savedAt ?? 0) - (a.attempt.feedback!.savedAt ?? 0));
}
