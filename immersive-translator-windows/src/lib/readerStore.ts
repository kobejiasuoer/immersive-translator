/**
 * 阅读室存储访问层：包一层 Rust reader_store 命令。
 * 类型与 src/core/readerTypes.ts 一致（contracts/reading-room.schema.json v1）。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  Article,
  ArticleSummary,
  BookMeta,
  LastBookProgress,
  NoteContent,
  NoteMeta,
  NoteReplay,
  RecallStat,
  VocabWord,
} from "../core/readerTypes";
import type { ReviewLogFile, ReviewStats } from "../core/readerSrs";
import { reduceReviewEvents, isReviewEvent, type ReviewGrade, type ReviewEvent, type SrsState } from "../../../packages/learning-core/src/index";
import { syncStoreList,learningNamespace } from "./tauriBridge";

export type {
  Article,
  ArticleSummary,
  BookMeta,
  LastBookProgress,
  NoteContent,
  NoteMeta,
  NoteReplay,
  RecallStat,
  ReviewLogFile,
  ReviewStats,
  VocabWord,
};

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
/** One immutable grade event and its derived vocabulary snapshot commit atomically. */
export async function readerGradeVocab(word: VocabWord, grade: ReviewGrade, mode = "recognition", recall?: ReviewEvent["recall"], supersedesEventId?: string): Promise<string> {
  const expectedNamespace=await learningNamespace();
  const [stored, events, deviceId] = await Promise.all([syncStoreList("reading-vocab",expectedNamespace), syncStoreList("review-events",expectedNamespace), invoke<string>("learning_device_id")]);
  const payload = stored.find(e=>e.id===word.id)?.payload as {baseline?:SrsState;baselineRecall?:RecallStat;generation?:string}|undefined;
  const baseline = payload?.baseline ?? word.srs, generation = payload?.generation ?? `legacy-${word.addedAt}`;
  const date=new Date(),day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const event:ReviewEvent={v:2,id:crypto.randomUUID(),wordId:word.id,deviceId,reviewedAt:date.getTime(),day,kind:"grade",grade,mode,generation,...(recall?{recall}:{}),...(supersedesEventId?{supersedesEventId}:{})};
  const existing=events.filter(e=>!e.deleted&&isReviewEvent(e.payload)).map(e=>e.payload as ReviewEvent);
  const baselineRecall=payload?.baselineRecall??word.recall;
  const reduced=reduceReviewEvents(baseline,[...existing,event],word.id,generation,baselineRecall);
  await invoke("learning_commit_review",{word:{...word,baseline,baselineRecall,generation,srs:reduced.srs,recall:reduced.recall},event,expectedNamespace}); return event.id;
}
export async function readerUndoReview(word:VocabWord,eventId:string):Promise<void>{
  const expectedNamespace=await learningNamespace();
  const [stored, events, deviceId]=await Promise.all([syncStoreList("reading-vocab",expectedNamespace),syncStoreList("review-events",expectedNamespace),invoke<string>("learning_device_id")]);
  const p=stored.find(e=>e.id===word.id)?.payload as {baseline?:SrsState;baselineRecall?:RecallStat;generation?:string}|undefined;if(!p?.baseline)throw new Error("No review baseline");
  const event:ReviewEvent={v:2,id:crypto.randomUUID(),wordId:word.id,deviceId,reviewedAt:Date.now(),kind:"undo",mode:"recognition",generation:p.generation,reversesEventId:eventId};
  const reduced=reduceReviewEvents(p.baseline,[...events.filter(e=>isReviewEvent(e.payload)).map(e=>e.payload as ReviewEvent),event],word.id,p.generation,p.baselineRecall);
  await invoke("learning_commit_review",{word:{...word,baseline:p.baseline,baselineRecall:p.baselineRecall,generation:p.generation,srs:reduced.srs,recall:reduced.recall},event,expectedNamespace});
}

/** 批量合并生词（口语复盘用）：新词追加，已有词保留 SRS 进度仅补例句。 */
export function readerMergeVocabWords(
  words: VocabWord[],
): Promise<{ added: string[]; merged: string[] }> {
  return invoke<{ added: string[]; merged: string[] }>("reader_merge_vocab_words", { words });
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

/** 记一次复习判分（bucket = "pass" | "wrong" | "trap"），返回该词更新后的错题记录。 */
export function readerRecordRecall(
  id: string,
  mode: string,
  bucket: string,
  nowMs: number,
): Promise<RecallStat> {
  return invoke<RecallStat>("reader_record_recall", { id, mode, bucket, nowMs });
}

/** 保存一篇新笔记（永不覆盖已有文件），返回带最终文件名的元数据。 */
export function noteSave(
  baseName: string,
  content: string,
  meta: Omit<NoteMeta, "file">,
): Promise<NoteMeta> {
  return invoke<NoteMeta>("note_save", { baseName, content, meta });
}

export function noteList(): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("note_list");
}

export function noteRead(file: string): Promise<NoteContent | null> {
  return invoke<NoteContent | null>("note_read", { file });
}

/** 写回 AI 复盘结果，返回更新后的元数据。 */
export function noteWriteReplay(
  file: string,
  replay: NoteReplay,
  rounds: number,
  nowMs: number,
): Promise<NoteMeta> {
  return invoke<NoteMeta>("note_write_replay", { file, replay, rounds, nowMs });
}

export function noteDelete(file: string): Promise<boolean> {
  return invoke<boolean>("note_delete", { file });
}

// ---------- 整本书阅读室（书级载体） ----------

/** 书架的书（按最近阅读倒序；索引与元信息，不含章正文）。 */
export function readerListBooks(): Promise<BookMeta[]> {
  return invoke<BookMeta[]>("reader_list_books");
}

/** 整本入库（导入向导确认时一次性调用），返回最新书列表。 */
export function readerSaveBook(meta: BookMeta, articles: Article[]): Promise<BookMeta[]> {
  return invoke<BookMeta[]>("reader_save_book", { meta, articles });
}

/** 只更新书元信息（进度/时长/最近阅读写回；不碰章正文）。 */
export function readerSaveBookMeta(meta: BookMeta): Promise<void> {
  return invoke<void>("reader_save_book_meta", { meta });
}

/** 删除一本书：删书卡与全部章文章（进度不可恢复），生词一律保留。 */
export function readerDeleteBook(bookId: string): Promise<boolean> {
  return invoke<boolean>("reader_delete_book", { bookId });
}

/** 最近在读的书（提醒卡「继续阅读」目标）。 */
export function readerLastBookProgress(): Promise<LastBookProgress | null> {
  return invoke<LastBookProgress | null>("reader_last_book_progress");
}

/** 累计今日阅读秒数（每 ~15s 批量上报），返回今日累计值。 */
export function readerRecordReading(day: string, seconds: number): Promise<number> {
  return invoke<number>("reader_record_reading", { day, seconds });
}

/** 今日累计阅读秒数。 */
export function readerReadSecondsToday(day: string): Promise<number> {
  return invoke<number>("reader_read_seconds_today", { day });
}
