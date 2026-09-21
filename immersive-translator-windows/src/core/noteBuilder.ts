/**
 * 学词笔记（R2→R3）：生词本 → LLM 复习笔记的纯逻辑层。
 *
 * 定位：生词本从「背诵」重定位为「复习笔记」—— 把用户手写的 GPT 整理流程
 * 产品化。R3 升级：笔记从「词典复读」改为「记忆诊断」——材料带上真实错题
 * 统计（VocabWord.recall），LLM 按固定【批注】格式产出可解析的诊断式笔记；
 * 另含 AI 复盘（复习一轮后「哪些过了 / 哪些仍错」）的 prompt 与解析。
 * 本模块全部纯函数、零 IO；SRS 调度（gradeSrs）不经过这里。
 */

import { dayKey } from "./readerSrs";
import type { ReviewGrade } from "./readerSrs";
import type { RecallVerdict } from "./recallJudge";
import type {
  Article,
  ChunkType,
  RecallMode,
  SentenceChunk,
  VocabCollocation,
  VocabKind,
  VocabSense,
  VocabWord,
} from "./readerTypes";

/** 与掌握度分桶同口径：intervalDays < 7 视为未掌握（默认勾选进笔记）。 */
export const NOTE_MASTERED_INTERVAL_DAYS = 7;

/** 复习判分的错题分桶。trap = 踩了直译陷阱（比 wrong 更具体的诊断信号）。 */
export type RecallBucket = "pass" | "wrong" | "trap";

/**
 * 判分结果 → 错题分桶。产出模式以判分结论为准（trap 优先）；
 * 识别卡无判分（judged=null），按最终评分归桶。
 */
export function recallBucket(
  _mode: RecallMode,
  judged: RecallVerdict | null,
  grade: ReviewGrade,
): RecallBucket {
  if (judged === "trap") return "trap";
  if (judged === "perfect" || judged === "close") return "pass";
  if (judged === "wrong") return "wrong";
  return grade === "forgot" ? "wrong" : "pass";
}

/** 送 LLM 的错题统计（VocabWord.recall + srs 的紧凑投影）。 */
export interface RecallSummary {
  reps: number;
  lapses: number;
  intervalDays: number;
  total: { pass: number; wrong: number; trap: number };
  /** 键 = RecallMode。 */
  byMode: Record<string, { pass: number; wrong: number; trap: number }>;
}

/** 有 recall 记录时给出统计投影；无记录返回 undefined（prompt 里「缺字段=没有」）。 */
export function recallSummary(word: VocabWord): RecallSummary | undefined {
  const r = word.recall;
  if (!r) return undefined;
  return {
    reps: word.srs.reps,
    lapses: word.srs.lapses,
    intervalDays: word.srs.intervalDays,
    total: { ...r.total },
    byMode: Object.fromEntries(Object.entries(r.byMode).map(([k, v]) => [k, { ...v }])),
  };
}

/** 实时仍错判定（笔记库角标与 AI 复盘选词的统一口径）：
 * 从没测过（错+过全为 0），或 错+陷阱 > 过。 */
export function isStillWeak(word: VocabWord): boolean {
  const bad = (word.recall?.total.wrong ?? 0) + (word.recall?.total.trap ?? 0);
  const pass = word.recall?.total.pass ?? 0;
  return bad + pass === 0 || bad > pass;
}

/** 默认选词：全部未掌握词条。返回 id 集合。 */
export function defaultNoteSelection(words: VocabWord[]): Set<string> {
  return new Set(
    words.filter((w) => w.srs.intervalDays < NOTE_MASTERED_INTERVAL_DAYS).map((w) => w.id),
  );
}

/** 送 LLM 的一条材料：词条 + 出处例句 + 同句词块 + 错题统计。 */
export interface NoteMaterial {
  id: string;
  word: string;
  kind?: VocabKind;
  phonetic?: string;
  senses: VocabSense[];
  collocations?: VocabCollocation[];
  chunkType?: ChunkType;
  pattern?: string;
  trap?: string;
  /** 出处例句：文章原句优先，划词收藏词退回 LLM 例句。 */
  example?: string;
  /** 例句所在句被 LLM 标注过的其他词块（整理「搭配/易混」用）。 */
  sentenceChunks?: SentenceChunk[];
  /** 真实错题统计；缺省 = 该词还没有复习记录。 */
  stats?: RecallSummary;
}

/**
 * 组装材料。articlesById 只需要含 sentences 的文章子集（调用方按需拉取），
 * 找不到出处文章时例句缺省，绝不去编。
 */
export function buildNoteMaterials(
  words: VocabWord[],
  articlesById: Map<string, Pick<Article, "sentences">>,
): NoteMaterial[] {
  return words.map((w) => {
    const st = articlesById.get(w.source.articleId)?.sentences[w.source.sentenceIdx];
    const example = st?.en ?? w.example?.en;
    return {
      id: w.id,
      word: w.word,
      ...(w.kind ? { kind: w.kind } : {}),
      ...(w.phonetic ? { phonetic: w.phonetic } : {}),
      senses: w.senses,
      ...(w.collocations && w.collocations.length ? { collocations: w.collocations } : {}),
      ...(w.chunkType ? { chunkType: w.chunkType } : {}),
      ...(w.pattern ? { pattern: w.pattern } : {}),
      ...(w.trap ? { trap: w.trap } : {}),
      ...(example ? { example } : {}),
      ...(st?.chunks && st.chunks.length ? { sentenceChunks: st.chunks } : {}),
      ...(recallSummary(w) ? { stats: recallSummary(w) } : {}),
    };
  });
}

/**
 * 用户消息 = 材料 JSON（无损、无格式歧义）。LLM 只被允许整理这份清单。
 * JSON 字段缺省即「没有」，prompt 里明确不得补全。
 */
export function buildNoteUserInput(materials: NoteMaterial[], now = Date.now()): string {
  const payload = {
    generatedHint: dayKey(now),
    words: materials,
  };
  return JSON.stringify(payload, null, 0);
}

export function buildNoteSystemPrompt(): string {
  return [
    "你是一位懂记忆规律的英语学习笔记编辑。用户给你一份来自生词本的词条清单（JSON），",
    "每条可能带 stats（真实错题统计）。请整理成一份「记忆诊断式」复习笔记——",
    "不是词典罗列，而是回答：这个词我为什么记不住 / 为什么记住了、怎么锚住它、下次怎么测。",
    "",
    "硬性规则（违反即失败）：",
    "- 只能使用清单里出现的词条与材料：不得新增单词、音标、释义、例句或搭配。",
    "- 清单里没有的字段（如 phonetic 缺省）直接省略，宁可留空也不得编造。",
    "- 例句必须原样引用清单中的 example，不得改写。",
    "- 诊断里的次数只能引用 stats 里的数字；没有 stats 就说明这个词还没测过，不得编数字。",
    "",
    "语言风格（同样是硬性规则）：",
    "- 全程说人话：笔记是写给学习者本人看的，正文里禁止出现 stats、chunk、JSON、mode、词条、清单、字段",
    "  这类程序术语——stats 说成「错题记录 / 复习记录」，chunk 说成「词块」。",
    "- 没有错题记录时直说「这几个词还没测过」，并自然补一句「下面的诊断是按各自标注的易错点推测的，测过一轮会更准」；",
    "  禁止「基于词条形态与陷阱设计推测」「不能当作真实错题结论」这类实验室口吻。",
    "",
    "输出格式（固定标记，必须严格遵守，供程序解析）：",
    "# 复习笔记",
    "",
    "## 先看这里",
    "- 2~3 条结论，每条一行：关于「这批词」的通病或最值得注意的点（来自 stats 的横向观察），",
    "  不是词条科普，也不得出现「stats」这类字眼。没有 stats 就写 1 条这批词的构成说明（几个单词、几个词块、有没有同族词）。",
    "",
    "## 单词（有单词才保留此节）",
    "### 词头（原样，不加音标/注释）",
    "【记不住】诊断 1~2 句：先说事实（错在哪、错几次、什么模式），再点破原因（如「认识但搭配调不出」「眼熟假熟」「同一个陷阱反复踩」），给出针对性记法方向。",
    "或【记住了】1~2 句：说明为什么这次记住了（间隔变长/连对），并给保持建议。两选一：total 里 wrong+trap > pass 用【记不住】，否则用【记住了】；无 stats 用【记不住】，直说这个词还没测过、诊断按它自带的易错点推测。",
    "【记法】一句锚点记法：整块记 / 出处场景 / 介词考点 / trap 对照（利用材料的 pattern、trap、出处例句）。",
    "- 释义最多 2 条，每条一行，沿用材料词性：`- n. 中文`（词块只写一条 `- 中文`）。",
    "> 例句原样（材料有 example 才写）。",
    "- 标签｜英文｜中文：搭配/相关词块最多 3 条，标签只能用「必记」「类推」「相关」；材料没有就不写。",
    "【测】模式｜一句怎么测：模式只能用「识别」「完形」「听写」；建议依据——错在介词/搭配→完形，只有识别记录→听写，已较熟→识别。每条词条必须有一行【测】。",
    "",
    "## 词块（有词块才保留此节，格式同上）",
    "",
    "直接输出 Markdown 正文，不要用代码块包裹，不要输出任何额外说明。",
  ].join("\n");
}

/** 笔记文件名基础名（不含扩展名）：学词笔记-YYYY-MM-DD。同日多份由存储层去重。 */
export function noteBaseName(now = Date.now()): string {
  return `学词笔记-${dayKey(now)}`;
}

/** 归一化标题词：小写 + 去非字母数字（与生词 id 归一化同思路，宽容空格）。 */
function normalizeHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

/**
 * 防幻觉校验：抽取笔记里的三级标题（词条），逐个确认能在所选词条里找到出处。
 * 返回无法溯源的标题（空数组 = 通过）。宽容匹配：标题去掉格式字符后包含
 * 某个词条（或反之），避免音标/类型后缀造成误报。
 */
export function verifyNoteWords(
  noteMarkdown: string,
  words: VocabWord[],
): { ok: boolean; unknownHeadings: string[] } {
  const known = words.map((w) => normalizeHeading(w.word)).filter(Boolean);
  const headings = [...noteMarkdown.matchAll(/^###\s+(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const unknownHeadings = headings.filter((h) => {
    const n = normalizeHeading(h);
    if (!n) return true;
    return !known.some((k) => n.includes(k) || k.includes(n));
  });
  return { ok: unknownHeadings.length === 0, unknownHeadings };
}

// ---------- AI 复盘（复习一轮后：哪些过了 / 哪些仍错 / 下一步） ----------

/** 复盘材料：笔记覆盖的词 + 最新错题统计；weakIds 由前端按数据判定（不靠 LLM 找）。 */
export function buildReplayInput(
  words: VocabWord[],
  weakIds: string[],
  noteDateHint: string,
): string {
  const payload = {
    noteDate: noteDateHint,
    weakIds,
    words: words.map((w) => ({
      id: w.id,
      word: w.word,
      kind: w.kind,
      trap: w.trap,
      pattern: w.pattern,
      stats: recallSummary(w),
    })),
  };
  return JSON.stringify(payload, null, 0);
}

export function buildReplaySystemPrompt(): string {
  return [
    "你是英语学习教练。用户刚复习完一轮生词，给你每个词的错题统计（JSON）。",
    "请写一份简短复盘——回答「哪些过了、哪些仍错、薄弱点是什么」，不是词条讲解。",
    "",
    "硬性规则：",
    "- 数字只能引用 stats 里的数字，不得编造或推算新数字。",
    "- 【仍错】的词头必须逐字来自 weakIds 对应的 word，不得新增。",
    "- 点破共性（如「认识但搭配调不出」「同一个陷阱反复踩」），少写套话。",
    "- 全程说人话：复盘是写给学习者本人看的，不得把 stats、weakIds、JSON 这类字段名写进正文——",
    "  说「错题记录」「这几个词」。",
    "",
    "输出格式（固定标记，供程序解析，不要代码块包裹）：",
    "【总结】2~3 句：整体结果 + 薄弱点判断。",
    "【仍错】词头｜为什么仍错 + 一句怎么补（每个 weak 词一行，没有就整节约省略）。",
    "",
    "直接输出，不要任何额外说明。",
  ].join("\n");
}

/** 解析复盘输出；宽容缺失（都解析不到返回 null，调用方提示重试）。 */
export function parseReplay(
  text: string,
): { verdict: string; weak: { w: string; why: string }[] } | null {
  const summaryMatch = text.match(/【总结】\s*([\s\S]*?)(?=\n【仍错】|$)/);
  const verdict = summaryMatch?.[1]?.trim() ?? "";
  const weak = [...text.matchAll(/【仍错】\s*(.+?)\s*｜\s*(.+)/g)].map((m) => ({
    w: m[1].trim(),
    why: m[2].trim(),
  }));
  if (!verdict && weak.length === 0) return null;
  return { verdict, weak };
}

/** 复盘「仍错」词头防幻觉：必须能在 weakIds 对应的词条里找到。 */
export function verifyReplayWords(
  replay: { weak: { w: string }[] },
  weakWords: VocabWord[],
): boolean {
  return replay.weak.every((item) => findWordByHeading(item.w, weakWords) !== undefined);
}

/**
 * 按宽容归一化找词条（与 verifyReplayWords / verifyNoteWords 同口径）：
 * 小写 + 去格式字符后相等优先，其次互相包含（LLM 给词头加后缀/改大小写时
 * 精确字符串相等会静默丢词）。
 */
export function findWordByHeading(heading: string, words: VocabWord[]): VocabWord | undefined {
  const n = normalizeHeading(heading);
  if (!n) return undefined;
  return (
    words.find((w) => normalizeHeading(w.word) === n) ??
    words.find((w) => {
      const k = normalizeHeading(w.word);
      return k !== "" && (n.includes(k) || k.includes(n));
    })
  );
}
