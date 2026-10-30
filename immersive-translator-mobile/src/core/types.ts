/**
 * M0 spike 用数据模型（对齐 contracts/reading-room.schema.json v1 的最小子集）。
 * M1 抽包后由 packages/reader-core 替代——本文件只服务 spike，勿扩展。
 */

export type ChunkType = "collocation" | "phrasal" | "idiom" | "pattern";

export interface SentenceChunk {
  text: string;
  chunkType: ChunkType;
  gloss: string;
  pattern?: string;
  trap?: string;
  /** 词条形式（收藏用），如句中 "took root" → 词条 "take root"。 */
  word?: string;
}

export interface SentencePair {
  id?: string;
  zhState?: "empty" | "machine" | "edited";
  idx: number;
  paragraphIdx: number;
  en: string;
  zh: string | null;
  chunks?: SentenceChunk[];
}

export interface Article {
  createdAt?: number;
  updatedAt?: number;
  lastReadAt?: number;
  contentRevision?: string;
  sourceUrl?: string;
  sourceType?: "sample" | "paste" | "url" | "book" | "rss" | "relay";
  bookId?: string;
  archived?: boolean;
  [key: string]: unknown;
  id: string;
  title: string;
  titleCn: string;
  sentences: SentencePair[];
  /** 段落边界：段落起始句 idx 列表（渲染分段用）。 */
  paragraphStarts: number[];
}

export type VocabKind = "word" | "chunk";

export interface VocabSense {
  pos: string;
  cn: string;
}

export interface VocabWord {
  createdAt?: number;
  updatedAt?: number;
  generation?: string;
  srs?: import("../../../packages/learning-core/src/index").SrsState;
  srsBaseline?: import("../../../packages/learning-core/src/index").SrsState;
  paused?: boolean;
  note?: string;
  [key: string]: unknown;
  id: string;
  word: string;
  kind?: VocabKind;
  chunkType?: string;
  phonetic?: string;
  senses: VocabSense[];
  pattern?: string;
  trap?: string;
  sourceArticleId: string;
  sourceSentenceIdx: number;
  dueAt: number;
  /** 最近一次判错（forgot / 陷阱）时间戳（治 ux-cross-1）：gradeVocab 落账、undoGrade 撤销；
   *  「近期」口径由读取侧按窗口过滤（免迁移、免跨天遍历改写），单字段留存无膨胀风险。 */
  lastWrongAt?: number;
}
