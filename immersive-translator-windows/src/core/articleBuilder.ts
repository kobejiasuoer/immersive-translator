/**
 * 「发送到阅读室」/ 粘贴导入：原始文本 → Article（含句对）。
 *
 * 标题策略：首行若 ≤80 字符且不带句末终结符，直接当标题；
 * 否则取第一句截到 60 字符当标题。中文副标题在标题翻译完成后回填。
 */

import { splitParagraphs } from "./sentenceSplit";
import { READER_SCHEMA_VERSION } from "./readerTypes";
import type { Article, ArticleProgress, ArticleSourceType, SentencePair } from "./readerTypes";

const TITLE_MAX_FROM_FIRST_LINE = 80;
const TITLE_FALLBACK_MAX = 60;

export function countWords(text: string): number {
  // 英文按空白计词；混入的 CJK 字符每字记 0.6 词（约等于词密度），向下取整。
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const latinWords = text
    .replace(/[\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return latinWords + Math.floor(cjk * 0.6);
}

function emptyProgress(): ArticleProgress {
  return { sentenceIdx: 0, percent: 0, secondsListened: 0 };
}

/** 生成文章 id：时间戳 + 随机段，避免同毫秒导入冲突。 */
export function newArticleId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `a${now.toString(36)}${rand}`;
}

/** 规范化生词 id：小写、去首尾非字母数字（保留内部连字符/撇号）。 */
export function normalizeWordKey(word: string): string {
  return word.trim().toLowerCase().replace(/^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$/g, "");
}

function pickTitle(text: string, firstSentence: string | undefined): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine && firstLine.length <= TITLE_MAX_FROM_FIRST_LINE && !/[.!?…]$/.test(firstLine)) {
    return firstLine;
  }
  // 无独立标题行：用第一句（截断）当标题。
  const head = firstLine || text.trim();
  const base = firstSentence?.trim() || head;
  if (base.length <= TITLE_FALLBACK_MAX) return base;
  return `${base.slice(0, TITLE_FALLBACK_MAX).trimEnd()}…`;
}

/**
 * 从纯文本建文章。正文按段落切句；标题行（当被采用为首行时）不重复进正文。
 */
export function buildArticleFromText(
  text: string,
  options: { sourceType?: ArticleSourceType; sourceUrl?: string; now?: number } = {},
): Article | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const titleAsFirstLine =
    !!firstLine &&
    firstLine.length <= TITLE_MAX_FROM_FIRST_LINE &&
    !/[.!?…]$/.test(firstLine);
  const bodyText = titleAsFirstLine ? trimmed.slice(firstLine.length).trim() : trimmed;

  const paragraphs = splitParagraphs(bodyText);
  if (paragraphs.length === 0) return null;

  const sentences: SentencePair[] = [];
  for (const p of paragraphs) {
    for (const en of p.sentences) {
      sentences.push({
        idx: sentences.length,
        paragraphIdx: p.paragraphIdx,
        en,
        zh: null,
        zhState: "pending",
      });
    }
  }
  const title = pickTitle(titleAsFirstLine ? `${firstLine}\n${bodyText}` : trimmed, sentences[0]?.en);

  const now = options.now ?? Date.now();
  return {
    id: newArticleId(now),
    title,
    titleCnState: "pending",
    sourceType: options.sourceType ?? "paste",
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    wordCount: countWords(bodyText),
    createdAt: now,
    lastReadAt: now,
    progress: emptyProgress(),
    sentences,
  };
}

/** 存储文件（Rust reader_store.rs 同构）。 */
export interface ReaderArticlesFile {
  schemaVersion: number;
  articles: Article[];
}

export function emptyArticlesFile(): ReaderArticlesFile {
  return { schemaVersion: READER_SCHEMA_VERSION, articles: [] };
}
