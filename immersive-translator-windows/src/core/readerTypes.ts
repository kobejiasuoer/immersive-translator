/**
 * 沉浸阅读室的数据契约（对齐 docs/reading-room-handoff.md §10 与
 * contracts/reading-room.schema.json 的 schemaVersion 1）。
 *
 * Article / SentencePair / VocabWord / ReaderSettings 同时是 Rust 侧
 * reader_store.rs 的存储格式（camelCase 序列化），改动任何字段必须同步
 * schema 与 Rust 结构体。
 */

export const READER_SCHEMA_VERSION = 1;

/** 一篇文章的来源。epub / pdf 本轮未实现，仅预留枚举。 */
export type ArticleSourceType = "paste" | "url" | "epub" | "pdf";

/** 单句译文的翻译状态。 */
export type SentenceZhState = "pending" | "done" | "failed" | "edited";

/** 词块类型：搭配 / 短语动词 / 习语 / 句式框架。 */
export type ChunkType = "collocation" | "phrasal" | "idiom" | "pattern";

export const CHUNK_TYPE_LABELS: Record<ChunkType, string> = {
  collocation: "搭配",
  phrasal: "短语动词",
  idiom: "习语",
  pattern: "句式",
};

/** 宽容解析词块类型字符串（LLM 返回）；非法值返回 null。 */
export function parseChunkType(v: unknown): ChunkType | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "collocation" || s === "phrasal" || s === "idiom" || s === "pattern" ? s : null;
}

/**
 * 句内标注的一个词块。en 不可变（只允许编辑译文），所以标注不过期；
 * text 必须是 en 的连续子串，解析时强校验，匹配不上就丢弃（宁漏勿错）。
 */
export interface SentenceChunk {
  text: string;
  chunkType: ChunkType;
  /** 中文释义（一句话）。 */
  gloss: string;
  /** 槽位记法，如 "take on sth" / "attribute X to Y"。 */
  pattern?: string;
  /** 直译陷阱，如 "不是 make momentum"。 */
  trap?: string;
}

/** 一篇文章的词块标注状态。 */
export type ArticleChunkState = "pending" | "done" | "failed";

/** 一个句对（最小朗读/高亮/遮罩单元）。 */
export interface SentencePair {
  /** 全文序号，从 0。 */
  idx: number;
  paragraphIdx: number;
  en: string;
  /** null = 尚未翻译。 */
  zh: string | null;
  zhState: SentenceZhState;
  /** 遮罩模式下是否已揭开（运行时状态，随文章持久化）。 */
  revealed?: boolean;
  /** LLM 标注的词块（en 定稿后写入）。 */
  chunks?: SentenceChunk[];
}

/** 阅读进度（持久化在文章记录里）。 */
export interface ArticleProgress {
  /** 上次朗读/阅读到达的句序号。 */
  sentenceIdx: number;
  /** 0–100。 */
  percent: number;
  secondsListened: number;
}

/** 一篇文章。 */
export interface Article {
  id: string;
  /** 英文标题。 */
  title: string;
  /** 中文副标题。 */
  titleCn?: string;
  titleCnState: SentenceZhState;
  sourceUrl?: string;
  sourceType: ArticleSourceType;
  /** 如 "B1 入门"，本轮不做分级判定，仅透传展示。 */
  level?: string;
  wordCount: number;
  createdAt: number;
  lastReadAt: number;
  progress: ArticleProgress;
  sentences: SentencePair[];
  /** 词块标注进度；缺省 = 从未标注。 */
  chunkState?: ArticleChunkState;
  /** 按文章覆盖的阅读设置；缺字段回落全局默认。 */
  settings?: Partial<ReaderSettings>;
}

/** 遮罩/复习等场景的生词来源定位。 */
export interface VocabSource {
  articleId: string;
  sentenceIdx: number;
}

export interface VocabSense {
  pos: string;
  cn: string;
}

export interface VocabCollocation {
  en: string;
  cn: string;
}

/** 生词条目类别：单词 / 词块。缺省视为 "word"（老数据无需迁移）。 */
export type VocabKind = "word" | "chunk";

/** 生词（SRS 状态与到期计数同源）。 */
export interface VocabWord {
  /** 归一化（小写、去首尾标点）后的唯一键。 */
  id: string;
  word: string;
  kind?: VocabKind;
  phonetic?: string;
  senses: VocabSense[];
  forms?: string[];
  collocations?: VocabCollocation[];
  /** kind=chunk 时的词块类型。 */
  chunkType?: ChunkType;
  /** 槽位记法。 */
  pattern?: string;
  /** 直译陷阱。 */
  trap?: string;
  source: VocabSource;
  srs: VocabSrsState;
  addedAt: number;
}

export interface VocabSrsState {
  ease: number;
  intervalDays: number;
  reps: number;
  /** Unix 毫秒；到期判定唯一依据。 */
  dueAt: number;
  lapses: number;
}

/** 对照模式：仅英文 / 对照 / 仅中文。 */
export type ContrastMode = "en" | "dual" | "zh";

/** 译文遮罩样式：blank = 留白显影（悬停出胶囊），frost = 毛玻璃（模糊→揭开）。 */
export type MaskStyle = "blank" | "frost";

export type ReaderTheme = "light" | "dark" | "sepia" | "oled";

/** 正文字体配对（屏 B 下拉）。 */
export type ReaderFontPair = "serif" | "sans";

/** 阅读设置。视图菜单管「显示什么」，这里管「怎么显示」。 */
export interface ReaderSettings {
  contrastMode: ContrastMode;
  maskTranslation: boolean;
  maskStyle: MaskStyle;
  showProgress: boolean;
  zenMode: boolean;
  theme: ReaderTheme;
  /** 14–24。 */
  fontSize: number;
  /** 行距倍数（作用于 --read-*-lh 的倍率）。 */
  lineHeight: number;
  fontPair: ReaderFontPair;
  /** 系统音色名；空串 = 引擎默认。 */
  voice: string;
  /** 0.5–2.0。 */
  rate: number;
  /** 每句停顿 0–2000ms。 */
  sentencePauseMs: number;
  shadowingMode: boolean;
  /** 词块高亮：文章翻译完成后自动跑 LLM 词块标注（会额外消耗 token）。 */
  chunkHighlight: boolean;
  /** 生词再现标记：正文中标记已收藏的词/词块（纯本地计算）。 */
  showVocabMarks: boolean;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  contrastMode: "dual",
  maskTranslation: false,
  maskStyle: "blank",
  showProgress: true,
  zenMode: false,
  theme: "light",
  fontSize: 19,
  lineHeight: 1,
  fontPair: "serif",
  voice: "",
  rate: 1,
  sentencePauseMs: 0,
  shadowingMode: false,
  chunkHighlight: true,
  showVocabMarks: true,
};

/** 屏 B 字号步进器范围。 */
export const READER_FONT_SIZE_MIN = 14;
export const READER_FONT_SIZE_MAX = 24;
export const READER_RATE_MIN = 0.5;
export const READER_RATE_MAX = 2;

/**
 * 合并全局默认与文章覆盖。只接受文章覆盖里类型合法的字段，
 * 防止旧版本/坏数据把设置打穿（例如 fontSize 为字符串）。
 */
export function mergeReaderSettings(
  globalSettings: ReaderSettings,
  override?: Partial<ReaderSettings> | null,
): ReaderSettings {
  if (!override || typeof override !== "object") return { ...globalSettings };
  const merged = { ...globalSettings };
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const bool = (v: unknown) => typeof v === "boolean" ? v : undefined;
  const str = (v: unknown) => typeof v === "string" ? v : undefined;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    str(v) !== undefined && (allowed as readonly string[]).includes(v as string)
      ? (v as T)
      : undefined;

  merged.contrastMode = oneOf(override.contrastMode, ["en", "dual", "zh"]) ?? merged.contrastMode;
  merged.maskTranslation = bool(override.maskTranslation) ?? merged.maskTranslation;
  merged.maskStyle = oneOf(override.maskStyle, ["blank", "frost"]) ?? merged.maskStyle;
  merged.showProgress = bool(override.showProgress) ?? merged.showProgress;
  merged.zenMode = bool(override.zenMode) ?? merged.zenMode;
  merged.theme = oneOf(override.theme, ["light", "dark", "sepia", "oled"]) ?? merged.theme;
  const fontSize = num(override.fontSize);
  if (fontSize !== undefined) {
    merged.fontSize = Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, Math.round(fontSize)));
  }
  const lineHeight = num(override.lineHeight);
  if (lineHeight !== undefined && lineHeight >= 1 && lineHeight <= 2.4) {
    merged.lineHeight = lineHeight;
  }
  merged.fontPair = oneOf(override.fontPair, ["serif", "sans"]) ?? merged.fontPair;
  merged.voice = str(override.voice) ?? merged.voice;
  const rate = num(override.rate);
  if (rate !== undefined) {
    merged.rate = Math.min(READER_RATE_MAX, Math.max(READER_RATE_MIN, rate));
  }
  const pause = num(override.sentencePauseMs);
  if (pause !== undefined) {
    merged.sentencePauseMs = Math.min(2000, Math.max(0, Math.round(pause)));
  }
  merged.shadowingMode = bool(override.shadowingMode) ?? merged.shadowingMode;
  merged.chunkHighlight = bool(override.chunkHighlight) ?? merged.chunkHighlight;
  merged.showVocabMarks = bool(override.showVocabMarks) ?? merged.showVocabMarks;
  return merged;
}

/** 文章列表条目（不含句对正文，书架用）。 */
export type ArticleSummary = Omit<Article, "sentences"> & { sentenceCount: number };
