/**
 * 口语复盘 → 生词本：从跟读逐词评分里提取「这轮没掌握的词」。
 *
 * 只用已落盘的结构化数据（shadowAttempts → words 的 totalScore / dpMessage），
 * 规则全部确定性、无模型参与。规则编号对应 docs/speak-review-vocab-proposal.md：
 * R1 最新分 <3.5 · R2 最新 ≥4 已攻克剔除 · R3 功能词漏读不收 · R4 漏读+低分 ·
 * R5 漏读 ≥2 次 · R6 纯漏读 1 次默认不勾 · R7 临界 3.5~4 默认不勾 · R8 封顶 8 个折叠。
 *
 * dpMessage（讯飞词级）：0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。
 */

import type { SpeakSession, SpeakTurn } from "./speakLogic";
import type { VocabExample, VocabWord } from "./readerTypes";
import type { ReaderDictEntry } from "./readerDict";
import { normalizeWordKey } from "./articleBuilder";
import { initialSrs } from "./readerSrs";

/** 候选的失败原因（跨 attempt 合并展示）。 */
export type SpeakVocabReason = "low" | "missed" | "substituted";

export const REASON_LABELS: Record<SpeakVocabReason, string> = {
  low: "准确度低",
  missed: "漏读",
  substituted: "替换",
};

/** 单个候选词（已按会话内全部跟读聚合）。 */
export interface SpeakVocabCandidate {
  /** 归一化唯一键（与生词本 id 同口径）。 */
  id: string;
  /** 展示用词形（保留原文大小写）。 */
  word: string;
  /** 最新一次「读到」的分数（漏读不算读，纯漏读为 null）。 */
  latestScore: number | null;
  reasons: SpeakVocabReason[];
  /** 漏读过的 attempt 数。 */
  missedCount: number;
  /** 出现过的 attempt 数（跨轮去重）。 */
  occurrences: number;
  /** 首次出现处的 AI 原句 + 中文提示（复习卡语境）。 */
  example: VocabExample;
  defaultChecked: boolean;
  /** 首次出现序（内部：排序 tie-break / 展示稳定序）。 */
  order: number;
  /** 已在生词本（不重复添加；仅补例句）。 */
  existing?: VocabWord;
  /** 已有词且近期挣扎/已到期 → 复盘后提到今日复习队列最前。 */
  wake?: boolean;
}

export interface SpeakVocabExtraction {
  /** 排序后的前 N 个（R8）。 */
  candidates: SpeakVocabCandidate[];
  /** 封顶折叠掉的较弱词。 */
  folded: SpeakVocabCandidate[];
}

/** R8：一次复盘最多展示的候选数，其余折叠。 */
export const MAX_SPEAK_CANDIDATES = 8;

/** 跟读低分阈值（5 分制）。 */
const LOW_SCORE = 3.5;
/** R2：最新分达到该值视为已攻克。 */
const MASTERED_SCORE = 4;
/** 漏读护栏：整句完整度低于该值视为跟丢，漏读词不可信。 */
const MIN_INTEGRITY = 2.5;
/** 漏读护栏：单次跟读漏读词超过该数视为跟丢整句。 */
const MAX_MISSED_PER_ATTEMPT = 4;

/**
 * 功能词表（R3）：漏读功能词是弱读吞音的正常现象，不携带词汇缺口信号，
 * 一律不进候选。只收「漏读时」的过滤，功能词读得差（<3.5）仍会进列表。
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // 冠词 / 限定词
  "a", "an", "the", "this", "that", "these", "those", "some", "any", "no", "every", "each",
  // 代词
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "ours", "yours", "theirs",
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves",
  // 介词
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "about", "as", "into",
  "through", "after", "over", "between", "out", "against", "during", "without",
  "before", "under", "around", "among", "near", "off", "above", "below", "up", "down",
  // 连词 / 从句词
  "and", "or", "but", "if", "because", "so", "than", "that", "when", "while",
  "although", "though", "since", "until", "unless", "whether",
  // 助动词 / 系动词 / 情态
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done", "have", "has", "had",
  "will", "would", "can", "could", "shall", "should", "may", "might", "must",
  // 疑问词 / 常用虚副词
  "what", "which", "who", "whom", "whose", "how", "why", "where", "there", "here",
  "not", "very", "too", "also", "just", "only", "then", "again", "once", "well",
  "oh", "ok", "okay", "yeah", "yes", "er", "um", "uh", "hmm",
]);

/** 归一化候选 id（与生词本 normalizeWordKey 同口径）；数字/空词返回 null。 */
function candidateId(content: string): string | null {
  const id = normalizeWordKey(content);
  if (!id || /^\d+([.,]\d+)?$/.test(id)) return null;
  return id;
}

interface Draft {
  id: string;
  word: string;
  latestScore: number | null;
  reasons: Set<SpeakVocabReason>;
  missedCount: number;
  occurrences: number;
  everLow: boolean;
  example: VocabExample;
  order: number;
}

function turnExample(turn: SpeakTurn): VocabExample {
  return { en: turn.text, zh: turn.hintZh ?? null };
}

/**
 * 从一次跟读 attempt 提取候选。返回 false 表示该 attempt 的漏读数据
 * 不可信（跟丢整句护栏：完整度太低 / 漏读词太多），只采有分数的词。
 */
function attemptMissedUsable(attempt: { integrity: number; words: { dpMessage: number }[] }): boolean {
  const missed = attempt.words.filter((w) => w.dpMessage === 16).length;
  return attempt.integrity >= MIN_INTEGRITY && missed <= MAX_MISSED_PER_ATTEMPT;
}

/**
 * 从会话的全部跟读记录提取候选（R1~R7 分类、排序、R8 折叠）。
 * 传入当前生词本时同时标注「已在生词本 / 唤醒」，并排到列表末尾。
 */
export function extractSpeakVocab(
  session: SpeakSession,
  vocabWords: VocabWord[] = [],
  now = Date.now(),
): SpeakVocabExtraction {
  const drafts = new Map<string, Draft>();
  let order = 0;

  for (const turn of session.turns) {
    if (turn.role !== "assistant" || !turn.shadowAttempts) continue;
    for (const attempt of turn.shadowAttempts) {
      const missedUsable = attemptMissedUsable(attempt);
      const seenInAttempt = new Set<string>();
      // 同一 attempt 内重复出现的词：分数取最差的一次
      const scoresInAttempt = new Map<string, number>();
      for (const w of attempt.words) {
        // 增读（dp=32）：原文没有这个词，不参与
        if (w.dpMessage === 32) continue;
        const id = candidateId(w.content);
        if (!id) continue;
        seenInAttempt.add(id);
        if (w.dpMessage !== 16) {
          const prev = scoresInAttempt.get(id);
          if (prev === undefined || w.totalScore < prev) scoresInAttempt.set(id, w.totalScore);
        }
      }
      for (const w of attempt.words) {
        if (w.dpMessage === 32) continue;
        const id = candidateId(w.content);
        if (!id) continue;
        const missed = w.dpMessage === 16;
        // R3：功能词的漏读直接不收
        if (missed && FUNCTION_WORDS.has(id)) continue;
        // 跟丢整句护栏：这次 attempt 的漏读词不可信
        if (missed && !missedUsable) continue;

        let draft = drafts.get(id);
        if (!draft) {
          draft = {
            id,
            word: w.content,
            latestScore: null,
            reasons: new Set(),
            missedCount: 0,
            occurrences: 0,
            everLow: false,
            example: turnExample(turn),
            order: order++,
          };
          drafts.set(id, draft);
        }
        if (!seenInAttempt.has(id)) continue; // 理论不可达，防御
        if (missed) {
          draft.missedCount += 1;
          draft.reasons.add("missed");
        } else {
          const score = scoresInAttempt.get(id) ?? w.totalScore;
          draft.latestScore = score;
          if (score < LOW_SCORE) {
            draft.reasons.add("low");
            draft.everLow = true;
          }
          if (w.dpMessage === 128) draft.reasons.add("substituted");
        }
      }
      // occurrences 按 attempt 计数（同 attempt 内重复词只算一次）
      for (const id of seenInAttempt) {
        const draft = drafts.get(id);
        if (draft) draft.occurrences += 1;
      }
    }
  }

  const all: SpeakVocabCandidate[] = [];
  for (const d of drafts.values()) {
    // R2：最新一次已经读好（≥4）→ 已攻克，不再打扰
    if (d.latestScore !== null && d.latestScore >= MASTERED_SCORE) continue;
    const missedOnlyStruggle = d.reasons.has("missed") && (d.everLow || d.missedCount >= 2);
    const candidate: SpeakVocabCandidate = {
      id: d.id,
      word: d.word,
      latestScore: d.latestScore,
      reasons: [...d.reasons],
      missedCount: d.missedCount,
      occurrences: d.occurrences,
      example: d.example,
      defaultChecked:
        (d.latestScore !== null && d.latestScore < LOW_SCORE) || missedOnlyStruggle,
      order: d.order,
    };
    // 已在生词本：不重复添加；近期挣扎/已到期 → 唤醒（复盘后提到今日最前）
    const existing = vocabWords.find((w) => w.id === d.id);
    if (existing) {
      candidate.existing = existing;
      candidate.wake =
        (existing.recall?.total.wrong ?? 0) >= 1 ||
        existing.srs.lapses >= 1 ||
        existing.srs.dueAt <= now;
    }
    all.push(candidate);
  }

  all.sort(
    (a, b) =>
      sortWeight(a) - sortWeight(b) ||
      scoreOf(a) - scoreOf(b) ||
      b.occurrences - a.occurrences ||
      a.order - b.order,
  );
  return {
    candidates: all.slice(0, MAX_SPEAK_CANDIDATES),
    folded: all.slice(MAX_SPEAK_CANDIDATES),
  };
}

/** 已收藏的排最后（不可勾，只展示唤醒），其余按证据强度。 */
function sortWeight(c: SpeakVocabCandidate): number {
  if (c.existing) return 100;
  if (c.defaultChecked) return c.latestScore !== null && c.latestScore < LOW_SCORE ? 0 : 1;
  return 2;
}

function scoreOf(c: SpeakVocabCandidate): number {
  return c.latestScore ?? 99;
}

/** 词条 → 生词本记录（source 留空 = 无文章来源，例句用本轮 AI 原句）。 */
export function speakCandidateToVocab(
  candidate: SpeakVocabCandidate,
  entry: ReaderDictEntry | null,
  now = Date.now(),
): VocabWord {
  return {
    id: candidate.id,
    word: entry?.word ?? candidate.word,
    kind: "word",
    ...(entry?.phonetic ? { phonetic: entry.phonetic } : {}),
    senses: entry?.senses ?? [],
    ...(entry?.forms ? { forms: entry.forms } : {}),
    ...(entry?.collocations ? { collocations: entry.collocations } : {}),
    source: { articleId: "", sentenceIdx: 0 },
    srs: initialSrs(now),
    addedAt: now,
    example: candidate.example,
  };
}
