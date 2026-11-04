import { canonicalJson } from "../../../packages/learning-core/src/index";
import { DEMO_VOCAB } from "./data";

const seeds = new Map(DEMO_VOCAB.map(word => [word.id, word]));
const legacyFields = new Set([
  "v", "source", "addedAt", "createdAt", "updatedAt", "generation", "paused", "lastWrongAt", "spokenAt",
  "srs", "srsBaseline", "baseline", "recall", "baselineRecall", "note", "notes", "example",
  "sentence", "sourceSentence", "sourceExcerpt",
]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasProgress = (value: unknown): boolean => typeof value === "number" ? value > 0 :
  Array.isArray(value) ? value.some(hasProgress) : object(value) && Object.values(value).some(hasProgress);
const hasContent = (value: unknown): boolean => value !== undefined && value !== null && value !== "" &&
  !(Array.isArray(value) && value.length === 0) && !(object(value) && Object.keys(value).length === 0);

/** Old spike seeds have fixed IDs and no collection or learning activity. Never delete them implicitly. */
export function isUnmodifiedDemoVocab(value: unknown, reviews: readonly { wordId: string }[], notes: readonly unknown[]): boolean {
  if (!object(value) || typeof value.id !== "string") return false;
  const seed = seeds.get(value.id);
  if (!seed || reviews.some(event => event.wordId === value.id) || notes.some(note => object(note) &&
    [note.wordIds, object(note.meta) ? note.meta.wordIds : undefined].some(ids => Array.isArray(ids) && ids.includes(value.id)))) return false;
  for (const key of ["word", "kind", "chunkType", "phonetic", "pattern", "trap"] as const) {
    if (value[key] !== seed[key]) return false;
  }
  const source = object(value.source) ? value.source : {};
  // A desktop or newer client may add fields unknown to this client. Preserve those edits for sync.
  if (Object.keys(value).some(key => !Object.hasOwn(seed, key) && !legacyFields.has(key) && hasContent(value[key])) ||
      Object.keys(source).some(key => !["articleId", "sentenceIdx", "excerpt"].includes(key) && hasContent(source[key]))) return false;
  if ((value.sourceArticleId ?? source.articleId) !== seed.sourceArticleId ||
      (value.sourceSentenceIdx ?? source.sentenceIdx) !== seed.sourceSentenceIdx ||
      canonicalJson(value.senses) !== canonicalJson(seed.senses)) return false;
  if (["addedAt", "createdAt", "updatedAt", "lastWrongAt", "spokenAt"].some(key => value[key] !== undefined && value[key] !== 0) ||
      value.generation !== undefined && value.generation !== "legacy-0" || value.paused === true) return false;
  if (["note", "notes", "example", "sentence", "sourceSentence", "sourceExcerpt"].some(key => hasContent(value[key])) ||
      hasContent(source.excerpt) || hasProgress(value.recall) || hasProgress(value.baselineRecall)) return false;
  return ![value.srs, value.srsBaseline, value.baseline].some(srs => object(srs) &&
    ["reps", "repetitions", "intervalDays", "lapses"].some(key => hasProgress(srs[key])));
}
