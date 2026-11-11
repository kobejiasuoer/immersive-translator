import { contentRevision, sentenceId } from "../../../packages/learning-core/src/relay";
import { splitSentences } from "../../../immersive-translator-windows/src/core/sentenceSplit";
import type { AppState } from "../store";
import type { Article, SentencePair, VocabWord } from "./types";
import { readingParagraphs } from "./readerPresentation";

export type SentenceRepairState = Pick<AppState,
  "articles" | "progress" | "vocab" | "notes" | "tasks" | "sentenceZh" | "readLog" | "sentenceParseCache">;

/** Boundary identity excludes translations and derived IDs, which can change independently. */
export function sentenceBoundaryKey(article: Pick<Article, "sentences" | "paragraphStarts">): string {
  return contentRevision(readingParagraphs(article).flatMap((paragraph, paragraphIdx) => paragraph.map(sentence => ({
    idx: sentence.idx, paragraphIdx, en: normalize(sentence.en), zh: null, zhState: "empty",
  }))));
}

export interface SentenceBoundaryMap {
  version: 1;
  articleId: string;
  fromBoundaryKey: string;
  toBoundaryKey: string;
  oldToNew: number[];
  groups: number[][];
  oldSentenceIds: string[];
  newSentenceIds: string[];
}

export interface SentenceBoundaryRepair extends SentenceBoundaryMap {
  /** Local rollback material. Keep outside the article/cloud manifest. */
  backup: {
    article: Article;
    progress?: number;
    sentenceZh: AppState["sentenceZh"][string];
    sentenceParseCache: AppState["sentenceParseCache"][string];
    readLog: { day: string; seen: number[] };
    vocab: AppState["vocab"];
    notes: AppState["notes"];
    tasks: AppState["tasks"];
  };
}

export interface SentenceBoundaryRepairResult {
  patch: Partial<AppState>;
  repairs: SentenceBoundaryRepair[];
  skipped: { articleId: string; reason: string }[];
}

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
function clone<T>(value: T): T { return structuredClone(value); }
const validIndex = (index: unknown, length: number): index is number => Number.isInteger(index) && Number(index) >= 0 && Number(index) < length;
const referencesArticle = (row: unknown, articleId: string): boolean => object(row) && (row.sourceArticleId === articleId || object(row.source) && row.source.articleId === articleId);

/** Existing practice recordings keep their original steps; only their reading locators move. */
export function practiceSourceSentenceIndex(source: unknown, step = 0): number | undefined {
  if (!object(source) || !Number.isInteger(step) || step < 0) return undefined;
  if (Array.isArray(source.sentenceIndices)) {
    const index = source.sentenceIndices[step];
    return Number.isInteger(index) && index >= 0 ? index : undefined;
  }
  return Number.isInteger(source.sentenceIdx) && Number(source.sentenceIdx) >= 0 ? Number(source.sentenceIdx) + step : undefined;
}

function candidate(article: Article): { article: Article; map: SentenceBoundaryMap } | string | null {
  if (article.sourceType === "sample" || article.id === "starter") return null;
  const old = article.sentences;
  if (!Array.isArray(old) || !old.length) return null;
  if (old.some((sentence, index) => !sentence || sentence.idx !== index || !nonempty(sentence.en) || !Number.isInteger(sentence.paragraphIdx) || sentence.paragraphIdx < 0)) return "invalid-sentence-indices";
  if (!Array.isArray(article.paragraphStarts) || !article.paragraphStarts.length || article.paragraphStarts[0] !== 0 || article.paragraphStarts.some((value, i, all) => !validIndex(value, old.length) || i > 0 && value <= all[i - 1])) return "invalid-paragraph-boundaries";

  const groups: number[][] = [], sentences: SentencePair[] = [], paragraphStarts: number[] = [];
  const oldToNew: number[] = [];
  for (const [paragraphIdx, paragraph] of readingParagraphs(article).entries()) {
    const source = normalize(paragraph.map(sentence => sentence.en).join(" "));
    const targets = splitSentences(source);
    if (normalize(targets.join(" ")) !== source) return "source-text-changed";
    paragraphStarts.push(sentences.length);
    let position = 0;
    for (const target of targets) {
      const parts: SentencePair[] = [];
      let combined = "";
      while (position < paragraph.length && combined !== target) {
        parts.push(paragraph[position++]);
        combined = normalize(parts.map(sentence => sentence.en).join(" "));
        if (!target.startsWith(combined)) return "would-split-existing-sentence";
      }
      if (!parts.length || combined !== target) return "unalignable-sentences";
      const idx = sentences.length;
      groups.push(parts.map(sentence => sentence.idx));
      parts.forEach(sentence => { oldToNew[sentence.idx] = idx; });
      if (parts.length === 1) {
        sentences.push({ ...parts[0], idx, paragraphIdx });
      } else {
        const { parse: _partialParse, ...first } = parts[0];
        const complete = parts.every(sentence => nonempty(sentence.zh));
        sentences.push({
          ...first, idx, paragraphIdx, en: target,
          zh: complete ? parts.map(sentence => sentence.zh!.trim()).join("") : null,
          zhState: complete ? parts.some(sentence => sentence.zhState === "edited") ? "edited" : "machine" : "empty",
          ...(parts.some(sentence => sentence.chunks) ? { chunks: parts.flatMap(sentence => sentence.chunks ?? []) } : {}),
        });
      }
    }
    if (position !== paragraph.length) return "unalignable-sentences";
  }
  if (!groups.some(group => group.length > 1)) return null;
  const fromBoundaryKey = sentenceBoundaryKey(article);
  // Keep surviving sentence IDs stable; removed fragment IDs are retained in the map.
  const oldSentenceIds = old.map(sentence => sentence.id || sentenceId(article.id, fromBoundaryKey, sentence.idx));
  if (new Set(oldSentenceIds).size !== oldSentenceIds.length) return "duplicate-sentence-ids";
  const newSentenceIds = groups.map(group => oldSentenceIds[group[0]]);
  const repaired: Article = { ...article, sentences: sentences.map((sentence, idx) => ({ ...sentence, id: newSentenceIds[idx] })), paragraphStarts };
  const map: SentenceBoundaryMap = { version: 1, articleId: article.id, fromBoundaryKey, toBoundaryKey: sentenceBoundaryKey(repaired), oldToNew, groups, oldSentenceIds, newSentenceIds };
  repaired.contentRevision = contentRevision(repaired.sentences.map(sentence => ({ ...sentence, zhState: sentence.zhState ?? (sentence.zh ? "machine" : "empty") })));
  repaired.sentenceBoundaryRepair = clone(map);
  if (object(article.progress) && validIndex(article.progress.sentenceIdx, old.length)) {
    const index = oldToNew[article.progress.sentenceIdx];
    repaired.progress = { ...article.progress, sentenceIdx: index, percent: Math.round((index + 1) * 100 / sentences.length) };
  }
  return { article: repaired, map };
}

/** Skip an entire article if a persisted locator cannot be mapped without guessing. */
function invalidReference(state: SentenceRepairState, article: Article, map: SentenceBoundaryMap): boolean {
  const id = article.id, size = article.sentences.length;
  if (state.progress[id] !== undefined && !validIndex(state.progress[id], size)) return true;
  for (const table of [state.sentenceZh[id], state.sentenceParseCache[id]]) {
    if (table && Object.keys(table).some(key => String(Number(key)) !== key || !validIndex(Number(key), size))) return true;
  }
  if ((state.readLog.seen[id] ?? []).some(index => !validIndex(index, size))) return true;
  for (const row of [...state.vocab, ...state.notes, ...state.tasks] as unknown as Row[]) {
    if (row.sourceArticleId === id && row.sourceSentenceIdx !== undefined && !validIndex(row.sourceSentenceIdx, size)) return true;
    if (row.sourceArticleId === id && typeof row.sourceBoundaryKey === "string" && ![map.fromBoundaryKey, map.toBoundaryKey].includes(row.sourceBoundaryKey)) return true;
    if (object(row.source) && row.source.articleId === id) {
      if (typeof row.source.boundaryKey === "string" && ![map.fromBoundaryKey, map.toBoundaryKey].includes(row.source.boundaryKey)) return true;
      if (!validIndex(row.source.sentenceIdx, size)) return true;
      if (Array.isArray(row.source.sentenceIndices) && row.source.sentenceIndices.some(index => !validIndex(index, size))) return true;
      if (row.mode === "follow" && Array.isArray(row.steps) && row.steps.some((_, step) => !validIndex(practiceSourceSentenceIndex(row.source, step), size))) return true;
    }
  }
  return false;
}

function remapFlatReference<T extends object>(row: T, maps: Map<string, SentenceBoundaryMap>): T {
  const source = row as Row;
  const flatMap = typeof source.sourceArticleId === "string" ? maps.get(source.sourceArticleId) : undefined;
  const nested = object(source.source) ? source.source : undefined;
  const nestedMap = nested && typeof nested.articleId === "string" ? maps.get(nested.articleId) : undefined;
  if (!flatMap && !nestedMap) return row;
  let next: Row = source;
  if (flatMap && source.sourceBoundaryKey !== flatMap.toBoundaryKey && validIndex(source.sourceSentenceIdx, flatMap.oldToNew.length)) {
    next = { ...next };
    next.sourceSentenceIdx = flatMap.oldToNew[source.sourceSentenceIdx];
    next.sourceBoundaryKey = flatMap.toBoundaryKey;
  }
  if (nestedMap && nested && nested.boundaryKey !== nestedMap.toBoundaryKey && validIndex(nested.sentenceIdx, nestedMap.oldToNew.length)) {
    next = { ...next };
    const idx = nestedMap.oldToNew[nested.sentenceIdx];
    next.source = { ...nested, sentenceIdx: idx, boundaryKey: nestedMap.toBoundaryKey,
      ...(typeof nested.sentenceId === "string" ? { sentenceId: nestedMap.newSentenceIds[idx] } : {}),
    };
  }
  return next as T;
}

/**
 * A collection may arrive after its repaired article. Explicit old boundary tags
 * are safe to map. Untagged rows are safe only when an existing, same-generation
 * word proves the original fragment is an alias of its already-repaired source.
 * New untagged word IDs stay untouched: a bare index cannot identify its revision.
 */
export function reconcileRepairedVocabReferences(previous: readonly VocabWord[], incoming: VocabWord[], articles: readonly Article[]): VocabWord[] {
  const oldWords = new Map(previous.map(word => [word.id, word]));
  const maps = new Map<string, SentenceBoundaryMap>();
  for (const article of articles) {
    const map = article.sentenceBoundaryRepair;
    if (!object(map) || map.version !== 1 || map.articleId !== article.id || map.toBoundaryKey !== sentenceBoundaryKey(article) || typeof map.fromBoundaryKey !== "string" || !Array.isArray(map.oldToNew) || !Array.isArray(map.newSentenceIds) || map.oldToNew.some(index => !validIndex(index, article.sentences.length))) continue;
    maps.set(article.id, map as unknown as SentenceBoundaryMap);
  }
  let changed = false;
  const result = incoming.map(word => {
    const map = maps.get(word.sourceArticleId);
    if (!map) return word;
    const nested = object(word.source) ? word.source : undefined;
    if (nested && (nested.articleId !== word.sourceArticleId || nested.sentenceIdx !== word.sourceSentenceIdx)) return word;
    const marker = typeof word.sourceBoundaryKey === "string" ? word.sourceBoundaryKey : nested?.boundaryKey;
    if (typeof word.sourceBoundaryKey === "string" && typeof nested?.boundaryKey === "string" && word.sourceBoundaryKey !== nested.boundaryKey) return word;
    if (marker === map.toBoundaryKey) return word;
    let index: number | undefined;
    if (marker === map.fromBoundaryKey && validIndex(word.sourceSentenceIdx, map.oldToNew.length)) index = map.oldToNew[word.sourceSentenceIdx];
    else if (marker === undefined) {
      const old = oldWords.get(word.id);
      if (!old || old.sourceArticleId !== word.sourceArticleId || old.generation !== word.generation || old.word !== word.word || old.sourceBoundaryKey !== map.toBoundaryKey) return word;
      if (word.sourceSentenceIdx === old.sourceSentenceIdx || map.oldToNew[word.sourceSentenceIdx] === old.sourceSentenceIdx) index = old.sourceSentenceIdx;
    }
    if (index === undefined) return word;
    changed = true;
    return { ...word, sourceSentenceIdx: index, sourceBoundaryKey: map.toBoundaryKey,
      ...(nested ? { source: { ...nested, sentenceIdx: index, boundaryKey: map.toBoundaryKey,
        ...(typeof nested.sentenceId === "string" ? { sentenceId: map.newSentenceIds[index] } : {}),
      } } : {}),
    };
  });
  return changed ? result : incoming;
}

/**
 * Pure, merge-only repair. Apply patch and persist repairs' backups in one repository
 * transaction before publishing state. The caller owns timestamps and sync field clocks.
 * Already repaired text produces an empty patch; an unversioned remote reference must
 * never be remapped a second time solely because it still has a small numeric index.
 */
export function repairSentenceBoundaries(state: SentenceRepairState): SentenceBoundaryRepairResult {
  const maps = new Map<string, SentenceBoundaryMap>();
  const repairs: SentenceBoundaryRepair[] = [], skipped: SentenceBoundaryRepairResult["skipped"] = [];
  const articles = state.articles.map(article => {
    const result = candidate(article);
    if (typeof result === "string") { skipped.push({ articleId: article.id, reason: result }); return article; }
    if (!result) return article;
    if (invalidReference(state, article, result.map)) { skipped.push({ articleId: article.id, reason: "unmappable-reference" }); return article; }
    maps.set(article.id, result.map);
    repairs.push({ ...clone(result.map), backup: clone({
      article, ...(state.progress[article.id] !== undefined ? { progress: state.progress[article.id] } : {}),
      sentenceZh: state.sentenceZh[article.id] ?? {}, sentenceParseCache: state.sentenceParseCache[article.id] ?? {},
      readLog: { day: state.readLog.day, seen: state.readLog.seen[article.id] ?? [] },
      vocab: state.vocab.filter(row => referencesArticle(row, article.id)),
      notes: state.notes.filter(row => referencesArticle(row, article.id)),
      tasks: state.tasks.filter(row => referencesArticle(row, article.id)),
    }) });
    return result.article;
  });
  if (!repairs.length) return { patch: {}, repairs, skipped };

  const progress = { ...state.progress }, sentenceZh = { ...state.sentenceZh }, sentenceParseCache = { ...state.sentenceParseCache }, seen = { ...state.readLog.seen };
  for (const repair of repairs) {
    const id = repair.articleId, old = repair.backup.article.sentences;
    if (progress[id] !== undefined) progress[id] = repair.oldToNew[progress[id]];
    if (seen[id]) seen[id] = [...new Set(seen[id].map(index => repair.oldToNew[index]))];
    if (sentenceZh[id]) {
      const translations: Record<string, string> = {};
      repair.groups.forEach((group, idx) => {
        if (group.length === 1) {
          const value = sentenceZh[id][group[0]];
          if (value !== undefined) translations[idx] = value;
        } else if (group.some(index => nonempty(sentenceZh[id][index]))) {
          const effective = group.map(index => nonempty(sentenceZh[id][index]) ? sentenceZh[id][index] : old[index].zh);
          if (effective.every(nonempty)) translations[idx] = effective.map(value => value!.trim()).join("");
        }
      });
      sentenceZh[id] = translations;
    }
    if (sentenceParseCache[id]) {
      const cache: AppState["sentenceParseCache"][string] = {};
      repair.groups.forEach((group, idx) => {
        const previous = sentenceParseCache[id][group[0]];
        if (group.length === 1 && previous?.en === old[group[0]].en) cache[idx] = previous;
      });
      sentenceParseCache[id] = cache;
    }
  }
  const vocab = state.vocab.map(row => remapFlatReference(row, maps));
  const notes = state.notes.map(row => remapFlatReference(row, maps));
  const tasks = state.tasks.map(task => {
    const map = task.source && maps.get(task.source.articleId);
    if (!map || !task.source || (task.source as unknown as Row).boundaryKey === map.toBoundaryKey) return task;
    const mapped = remapFlatReference(task, maps);
    const source: Row = { ...mapped.source };
    if (task.mode === "follow" && task.steps?.length) {
      source.sentenceIndices = task.steps.map((_, step) => map.oldToNew[practiceSourceSentenceIndex(task.source, step)!]);
    } else if (Array.isArray((task.source as unknown as Row).sentenceIndices)) {
      source.sentenceIndices = ((task.source as unknown as Row).sentenceIndices as number[]).map(index => map.oldToNew[index]);
    }
    return { ...mapped, source: source as unknown as typeof task.source };
  });
  return { patch: { articles, progress, vocab, notes, tasks, sentenceZh, sentenceParseCache,
    readLog: { ...state.readLog, seen, count: Object.values(seen).reduce((count, indices) => count + indices.length, 0) },
  }, repairs, skipped };
}
