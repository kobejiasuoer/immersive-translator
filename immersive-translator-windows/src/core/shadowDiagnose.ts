/**
 * 跟读报告的诊断逻辑（纯函数，口语陪练与阅读室共用阈值语义）。
 *
 * 把 PronunciationResult + WordMark[] 变成「差的分差在哪、怎么补」：
 * - 短板维度：准确度/流畅度/完整度里缺口最大的那个
 * - 差词/漏词清单：直接来自词着色四档
 * - 徽章判定：过关 / 差一点（差 X 过关）/ 再练练
 * 文案由规则拼装，不调 LLM；展示层（SpeakView 报告卡）只管排版。
 */

import { isPass, type PronunciationResult, type WordMark } from "./pronunciation";

/** 过关阈值（5 分制）；与阅读室跟读评测的默认门槛一致。 */
export const SHADOW_PASS_SCORE = 4.2;

/** 徽章种类：过关 / 差一点（贴着阈值）/ 明显不足。 */
export type ShadowBadgeKind = "pass" | "almost" | "fail";

/** 诊断句的一个片段（kind 决定报告卡里的强调色）。 */
export interface DiagSegment {
  text: string;
  kind?: "strong" | "warn" | "err";
}

export interface ShadowDiagnosis {
  pass: boolean;
  badgeKind: ShadowBadgeKind;
  /** 徽章文案：「✓ 过关」「差 0.1 过关」「再练练」。 */
  badge: string;
  /** 诊断句片段序列（React 里按 kind 着色拼接）。 */
  segments: DiagSegment[];
  /** 缺口最大的维度（三项都够好时为 null）。 */
  weakDim: "accuracy" | "fluency" | "integrity" | null;
  /** 建议逐词练习的词（差词 + 漏词，按出现序，最多 4 个）。 */
  drillWords: string[];
  /** 差词（<3 分）数与漏读词数。 */
  badCount: number;
  missedCount: number;
}

export const DIM_LABELS: Record<"accuracy" | "fluency" | "integrity", string> = {
  accuracy: "准确度",
  fluency: "流畅度",
  integrity: "完整度",
};

/** 短板要显著到这个缺口才点名（避免三项都 4.5+ 还硬挑一个）。 */
const WEAK_GAP_MIN = 0.4;

/** 差词/漏词合并的最大数量（再多练不过来，先聚焦）。 */
const MAX_DRILL_WORDS = 4;

export function diagnoseShadow(
  result: PronunciationResult,
  marks: WordMark[],
  passScore = SHADOW_PASS_SCORE,
): ShadowDiagnosis {
  const pass = isPass(result, passScore);
  const gap = Math.max(0, passScore - result.total);

  const badWords: string[] = [];
  const missedWords: string[] = [];
  for (const m of marks) {
    const t = m.word?.content ?? "";
    if (!t) continue;
    if (m.quality === "bad") badWords.push(t);
    if (m.quality === "missed") missedWords.push(t);
  }
  const drillWords = [...badWords, ...missedWords].slice(0, MAX_DRILL_WORDS);

  const gapItems: Array<{ dim: "accuracy" | "fluency" | "integrity"; gap: number }> = [
    { dim: "accuracy", gap: 5 - result.accuracy },
    { dim: "fluency", gap: 5 - result.fluency },
    { dim: "integrity", gap: 5 - result.integrity },
  ];
  gapItems.sort((a, b) => b.gap - a.gap);
  const weakDim = gapItems[0].gap >= WEAK_GAP_MIN ? gapItems[0].dim : null;

  const badgeKind: ShadowBadgeKind = pass ? "pass" : gap <= 0.25 ? "almost" : "fail";
  const badge = pass ? "✓ 过关" : badgeKind === "almost" ? `差 ${gap.toFixed(1)} 过关` : "再练练";

  return {
    pass,
    badgeKind,
    badge,
    segments: pass
      ? passSegments(marks, badWords)
      : failSegments(result, weakDim, badWords, missedWords),
    weakDim,
    drillWords,
    badCount: badWords.length,
    missedCount: missedWords.length,
  };
}

// ---------- 内部 ----------

function textOfMark(m: WordMark): string {
  return m.word?.content ?? "";
}

function passSegments(marks: WordMark[], badWords: string[]): DiagSegment[] {
  // 过关：轻庆祝；如果有紧贴及格线的词（ok 档），顺手点一句
  const shaky = marks.filter((m) => m.quality === "ok").map((m) => textOfMark(m)).slice(0, 2);
  const out: DiagSegment[] = [{ text: "整句读得稳，节奏也顺", kind: "strong" }];
  if (badWords.length > 0) {
    out.push({ text: "；", kind: undefined }, { text: `留意一下 ${badWords.join("、")}`, kind: "warn" });
  } else if (shaky.length > 0) {
    out.push({ text: "；", kind: undefined }, { text: `${shaky.join("、")} 可以更清晰`, kind: "warn" });
  }
  out.push({ text: "。" });
  return out;
}

function failSegments(
  result: PronunciationResult,
  weakDim: "accuracy" | "fluency" | "integrity" | null,
  badWords: string[],
  missedWords: string[],
): DiagSegment[] {
  const out: DiagSegment[] = [];
  const lost = (5 - result.total).toFixed(1);
  if (weakDim) {
    const label = DIM_LABELS[weakDim];
    const score =
      weakDim === "accuracy" ? result.accuracy : weakDim === "fluency" ? result.fluency : result.integrity;
    const hint = weakDim === "fluency" ? "（语速与停顿）" : weakDim === "integrity" ? "（漏词/添词）" : "";
    out.push({ text: `差的 ${lost} 分大头在` }, { text: `${label} ${score.toFixed(1)}${hint}`, kind: "warn" });
  } else {
    out.push({ text: `离 5 分还差 ${lost}` });
  }
  const clauses: DiagSegment[] = [];
  if (badWords.length > 0) {
    clauses.push({ text: `${badWords.join("、")} 发音不准`, kind: "err" });
  }
  if (missedWords.length > 0) {
    clauses.push({ text: `漏读了 ${missedWords.join("、")}`, kind: "err" });
  }
  if (clauses.length > 0) {
    out.push({ text: "；" }, ...interleave(clauses, { text: "；" }));
  }
  out.push({ text: "。" });
  return out;
}

function interleave(items: DiagSegment[], sep: DiagSegment): DiagSegment[] {
  const out: DiagSegment[] = [];
  items.forEach((it, i) => {
    if (i > 0) out.push(sep);
    out.push(it);
  });
  return out;
}

// ---------- 音素纠音提示 ----------

/**
 * 常见问题音素的纠音提示（ARPAbet 码 → 人话）。
 * 只覆盖中国学习者的高频坑；没命中的音素由弹层兜底文案处理。
 */
const PHONE_TIPS: Record<string, string> = {
  th: "清音 th：舌尖轻放在上下齿之间送气，不是『斯』",
  dh: "浊音 th：舌尖轻放在上下齿之间、声带振动，不是『兹』",
  v: "上齿轻咬下唇出声，不要读成 w",
  w: "双唇拢圆发音，不要读成 v",
  ng: "舌后部抵住软腭，音从鼻腔出来收尾",
  l: "舌尖抵上齿龈；在词尾时也要抵到位，不要吞掉",
  r: "舌头卷起、不碰上颚；不要读成 l",
  ih: "短促的松元音，快快带过，不要拖长",
  iy: "长元音，嘴角向两侧拉开",
  ae: "嘴张大、舌位压低（『啊』和『哎』之间偏『啊』）",
  aa: "嘴张大、舌后压低，发长『啊』",
  eh: "短音『诶』，嘴半开",
  er: "卷舌音，舌头后卷",
  ay: "双元音『爱』，从 a 滑到 i",
  aw: "双元音『奥』，从 a 滑到 u",
  ow: "双元音『欧』，从 o 滑到 u",
  z: "声带振动的 s；词尾不要读成『斯』",
};

/** 没有针对性提示时的兜底。 */
export const PHONE_TIP_FALLBACK = "对照领读慢速跟两遍，注意口型";

export function phoneTip(phone: string): string {
  return PHONE_TIPS[phone] ?? PHONE_TIP_FALLBACK;
}

/**
 * 一个词里最值得点名的音素（gwpp 惩罚最重且超过阈值才算）。
 * 返回 null 表示这个词没有明显出错的音素。
 */
export function worstPhoneOf(
  word: { sylls: { phones: { content: string; gwpp: number }[] }[] } | undefined,
): { content: string; gwpp: number } | null {
  if (!word) return null;
  let worst: { content: string; gwpp: number } | null = null;
  for (const syl of word.sylls) {
    for (const p of syl.phones) {
      if (!worst || p.gwpp < worst.gwpp) worst = { content: p.content, gwpp: p.gwpp };
    }
  }
  return worst && worst.gwpp <= -0.4 ? worst : null;
}
