/**
 * 随读抽查（原位句内挖空微测）：选槽与判分限幅的纯逻辑。
 *
 * 设计要点（2026-10 原型 reading-room-cloze 验证过的口径）：
 * - 只挖「已读到」的句子：watermark 取 article.progress.sentenceIdx
 *   （ReaderApp 侧单调递增的读到哪水位线），读到才考、不剧透未读内容。
 * - 每段最多一槽：随机读抽查要的是轻量自检，不是满篇填空。
 * - 段内排序：生词再现（known，SRS 联动价值最高）> 带直译陷阱的词块
 *   > 其他词块（长词块优先——信息量与挑战度都更高）。
 * - 判分走 recallJudge.judgeCloze（本地毫秒级，零 LLM 消耗）；
 *   SRS 落档限幅：即时回忆不算「easy」，防止刚见过的词把间隔推太远。
 */

import type { ChunkSpan } from "./chunkAnnotate";
import { normalizeWordKey } from "./articleBuilder";
import type { RecallVerdict } from "./recallJudge";
import type { ReviewGrade } from "./readerSrs";

/** 一个挖空槽（渲染与判分的最小单元）。 */
export interface ClozeSlot {
  /** `${sentenceIdx}:${start}`——句号 + 跨度起点，重绘后保持稳定。 */
  id: string;
  sentenceIdx: number;
  start: number;
  end: number;
  /** 应填的原文（跨度文本）。 */
  answer: string;
  /** 中式直译陷阱候选（judgeCloze 的 trap 档）。 */
  trap?: string;
  /** 词块中文释义（答错时的朱批提示）。 */
  gloss?: string;
  /** 生词再现槽：判分联动 SRS（经 vocabId 定位生词本记录）。 */
  isKnown: boolean;
  vocabId?: string;
}

const MIN_ANSWER_CHARS = 3;
const MAX_ANSWER_WORDS = 4;
/** 只挖纯英文词/短语：混数字或符号的跨度打字体验差。 */
const ANSWER_SHAPE = /^[A-Za-z][A-Za-z'’ -]*$/;

function eligibleSpan(span: ChunkSpan, en: string): boolean {
  const answer = en.slice(span.start, span.end).trim();
  if (answer.length < MIN_ANSWER_CHARS) return false;
  if (answer.split(/\s+/).length > MAX_ANSWER_WORDS) return false;
  return ANSWER_SHAPE.test(answer);
}

/** 段内候选排序权重：known > 带陷阱词块 > 词块（同档长者优先）。 */
function spanWeight(span: ChunkSpan): number {
  const len = span.end - span.start;
  if (span.kind === "known") return 10_000 + len;
  if (span.chunk?.trap) return 5_000 + len;
  return len;
}

/**
 * 产出本文的挖空槽集合：Map<sentenceIdx, ClozeSlot>。
 * 每段选一个权重最高的可挖跨度；整段无可挖跨度则跳过。
 */
export function pickClozeSlots(
  spansBySentence: Map<number, ChunkSpan[]>,
  sentences: ReadonlyArray<{ idx: number; en: string; paragraphIdx: number }>,
  watermark: number,
): Map<number, ClozeSlot> {
  const picked = new Map<number, ClozeSlot>();
  // paragraphIdx -> 最优候选（跨句比较，段内唯一）
  const bestByPara = new Map<number, { slot: ClozeSlot; weight: number }>();
  for (const s of sentences) {
    if (s.idx > watermark) continue;
    const spans = spansBySentence.get(s.idx);
    if (!spans) continue;
    for (const span of spans) {
      if (!eligibleSpan(span, s.en)) continue;
      const weight = spanWeight(span);
      const prev = bestByPara.get(s.paragraphIdx);
      if (prev && prev.weight >= weight) continue;
      const answer = s.en.slice(span.start, span.end).trim();
      const trap = span.chunk?.trap?.trim();
      const gloss = span.chunk?.gloss?.trim();
      bestByPara.set(s.paragraphIdx, {
        weight,
        slot: {
          id: `${s.idx}:${span.start}`,
          sentenceIdx: s.idx,
          start: span.start,
          end: span.end,
          answer,
          ...(trap ? { trap } : {}),
          ...(gloss ? { gloss } : {}),
          isKnown: span.kind === "known",
          ...(span.kind === "known" ? { vocabId: normalizeWordKey(answer) } : {}),
        },
      });
    }
  }
  for (const { slot } of bestByPara.values()) picked.set(slot.sentenceIdx, slot);
  return picked;
}

/**
 * 原位抽查判分 → SRS 档位限幅：即时回忆最高只记 good。
 * perfect → good（不记 easy，防刚见过的词推高间隔）；
 * close → hard（差一点 = 提醒更早再见）；trap / wrong → forgot（进错题桶）。
 */
export function clozeVerdictToGrade(verdict: RecallVerdict): ReviewGrade {
  switch (verdict) {
    case "perfect":
      return "good";
    case "close":
      return "hard";
    default:
      return "forgot";
  }
}
