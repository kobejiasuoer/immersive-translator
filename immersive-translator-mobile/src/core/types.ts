/**
 * M0 spike 用数据模型（对齐 contracts/reading-room.schema.json v1 的最小子集）。
 * M1 抽包后由 packages/reader-core 替代——本文件只服务 spike，勿扩展。
 */

export type ChunkType = "collocation" | "phrasal" | "idiom" | "pattern";

export interface SentenceChunk {
  text: string;
  /** 词块类别；原型术语（如 quiet adj.）没有类别，可省——词典卡/收藏改用下方 pos 展示。 */
  chunkType?: ChunkType;
  gloss: string;
  pattern?: string;
  trap?: string;
  /** 词条形式（收藏用），如句中 "took root" → 词条 "take root"。 */
  word?: string;
  /** 查词卡/生词行展示的词性前缀（原型 doc.terms pos，如 "phr." / "adj."）。 */
  pos?: string;
  /** 音标（原型 doc.terms ph，词典卡音标行直接展示）。 */
  phonetic?: string;
}

/** 预置词条元数据（原型 doc.terms：w 词 + ph 音标 + pos 词性释义）。 */
export interface ArticleTerm {
  w: string;
  ph?: string;
  pos: string;
  cn: string;
}

/** 句子成分条（内容预置解析，原型 doc.sents[i][3] / doc.parse，html:1222-1297）：
 *  label=成分名（主语/谓语…，绿底白字标签），text=对应英文片段，note=一句中文说明，
 *  level=缩进层级（0 顶层；1/2 子成分，原型 .part.sub 同级缩进）。 */
export interface SentencePart {
  label: string;
  text: string;
  note?: string;
  level?: number;
}

/** 句子结构解析（内容源给出，原型 doc.parse）：trunk=句子主干；parts=成分表。 */
export interface SentenceParseContent {
  zh?: string;
  trunk: string;
  parts: SentencePart[];
}

export interface SentencePair {
  id?: string;
  zhState?: "empty" | "machine" | "edited";
  idx: number;
  paragraphIdx: number;
  en: string;
  zh: string | null;
  chunks?: SentenceChunk[];
  /** 内容预置解析（原型 doc.parse）：句子抽屉「句子解析」页签优先展示；
   *  缺省句仍走真实 LLM 解析（sentenceParse.ts），失败降级为引导，不造假。 */
  parse?: SentenceParseContent;
}

export interface Article {
  createdAt?: number;
  updatedAt?: number;
  lastReadAt?: number;
  contentRevision?: string;
  sourceUrl?: string;
  sourceType?: "sample" | "paste" | "url" | "book" | "rss" | "relay";
  bookId?: string;
  /** 导入来源身份独立于可修改的书名，供精选书库离线恢复已有版本。 */
  curatedBookId?: string;
  sourceCatalogTitle?: string;
  sourceBookTitle?: string;
  archived?: boolean;
  [key: string]: unknown;
  id: string;
  title: string;
  titleCn: string;
  sentences: SentencePair[];
  /** 段落边界：段落起始句 idx 列表（渲染分段用）。 */
  paragraphStarts: number[];
  /** 这篇内容的预置词条（内容源给出，如入门文的 take a break）；口语首页开始卡
      在生词本为空时回退取第一个词当默认词（原型 html:2614 doc.terms[0] 口径）。 */
  terms?: string[];
  /** 预置词条的释义元数据（原型 doc.terms）：句子抽屉「本句生词/本篇词汇」页签与
      点词词典卡的音标/词性行消费；未收藏的预置词也据此给出「+ 未收藏」态。 */
  termMeta?: ArticleTerm[]
  /** 阅读时长（分钟）。内容源给出时直接采用（原型 doc.minutes，如入门文 2 分钟）；
      缺省按正文词数 ÷130 词/分钟向上取整估算。 */
  minutes?: number;
  /** 内容源给出的来源展示名（原型 doc.source，如「粘贴导入」「英文资讯订阅」「精选经典」）；
      缺省按 sourceType 推导（meta.ts sourceLabelOf）。 */
  sourceLabel?: string;
  /** 内容源给出的难度档（原型 doc.difficulty，如「日常」「职场」）；缺省按 sourceType 推导。 */
  level?: string;
}

export type VocabKind = "word" | "chunk";

export interface VocabSense {
  pos: string;
  cn: string;
}

export interface ContextExplanation {
  sentence: string;
  meaning: string;
  example?: string;
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
  /** 主动查询后收藏的英语解释，只有原句相同时才能复用。 */
  contextExplanation?: ContextExplanation;
  pattern?: string;
  trap?: string;
  sourceArticleId: string;
  sourceSentenceIdx: number;
  dueAt: number;
  /** 最近一次判错（forgot / 陷阱）时间戳（治 ux-cross-1）：gradeVocab 落账、undoGrade 撤销；
   *  「近期」口径由读取侧按窗口过滤（免迁移、免跨天遍历改写），单字段留存无膨胀风险。 */
  lastWrongAt?: number;
}
