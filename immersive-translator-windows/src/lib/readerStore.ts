/**
 * 阅读室存储访问层：包一层 Rust reader_store 命令。
 * 类型与 src/core/readerTypes.ts 一致（contracts/reading-room.schema.json v1）。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  Article,
  ArticleSummary,
  ReviewLogFile,
  VocabWord,
} from "../core/readerTypes";

export type {
  Article,
  ArticleSummary,
  ReviewLogFile,
  VocabWord,
};

export interface ReviewStats {
  dueNow: number;
  reviewedToday: number;
  total: number;
  streak: number;
  learning: number;
  familiar: number;
  mastered: number;
}

export function readerListArticles(): Promise<ArticleSummary[]> {
  return invoke<ArticleSummary[]>("reader_list_articles");
}

export function readerGetArticle(id: string): Promise<Article | null> {
  return invoke<Article | null>("reader_get_article", { id });
}

export function readerSaveArticle(article: Article): Promise<ArticleSummary> {
  return invoke<ArticleSummary>("reader_save_article", { article });
}

export function readerDeleteArticle(id: string): Promise<boolean> {
  return invoke<boolean>("reader_delete_article", { id });
}

export function readerGetVocab(): Promise<{ words: VocabWord[]; reviewLog: ReviewLogFile }> {
  return invoke<{ words: VocabWord[]; reviewLog: ReviewLogFile }>("reader_get_vocab");
}

export function readerSaveVocabWord(word: VocabWord): Promise<void> {
  return invoke<void>("reader_save_vocab_word", { word });
}

export function readerDeleteVocabWord(id: string): Promise<boolean> {
  return invoke<boolean>("reader_delete_vocab_word", { id });
}

export function readerRecordReview(day: string, nowMs: number): Promise<ReviewStats> {
  return invoke<ReviewStats>("reader_record_review", { day, nowMs });
}

export function readerStats(today: string, nowMs: number): Promise<ReviewStats> {
  return invoke<ReviewStats>("reader_stats", { today, nowMs });
}
