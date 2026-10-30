import { gradeSrs, type ReviewGrade, type SrsState } from "./srs";
export interface RecallCounts { pass: number; wrong: number; trap: number }
export interface ReviewEvent {
  v: 2; id: string; wordId: string; deviceId: string; reviewedAt: number; kind: "grade" | "undo";
  generation?: string; grade?: ReviewGrade; mode: string; recall?: { bucket: keyof RecallCounts; answer?: string; expected?: string };
  supersedesEventId?: string; reversesEventId?: string;
  day?: string;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function isReviewEvent(v: unknown): v is ReviewEvent {
  if (!object(v) || v.v !== 2 || ![v.id, v.wordId, v.deviceId, v.mode].every(x => typeof x === "string" && x.length > 0) ||
      typeof v.reviewedAt !== "number" || !Number.isFinite(v.reviewedAt) || v.reviewedAt < 0) return false;
  if(v.generation!==undefined&&(typeof v.generation!=="string"||!v.generation.length))return false;
  if(v.day!==undefined&&(typeof v.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v.day)))return false;
  if (v.kind === "undo") return typeof v.reversesEventId === "string" && v.reversesEventId !== v.id && !v.grade && !v.supersedesEventId;
  if (v.kind !== "grade" || !["forgot", "hard", "good", "easy"].includes(String(v.grade)) || v.reversesEventId) return false;
  if (v.supersedesEventId !== undefined && (typeof v.supersedesEventId !== "string" || v.supersedesEventId === v.id)) return false;
  return v.recall === undefined || object(v.recall) && ["pass", "wrong", "trap"].includes(String(v.recall.bucket));
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Baseline is the real migrated snapshot, never reconstructed fictitious history. */
export function reduceReviewEvents(baseline: SrsState, input: readonly ReviewEvent[], wordId: string, generation?: string, baselineRecall?: {total:RecallCounts;byMode:Record<string,RecallCounts>;lastAt?:number}) {
  const unique = new Map<string, ReviewEvent>();
  for (const event of input) {
    if (!isReviewEvent(event)) throw new Error("Invalid review event");
    const existing = unique.get(event.id);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) throw new Error(`Immutable review event conflict: ${event.id}`);
    unique.set(event.id, event);
  }
  const events = [...unique.values()].filter(e => e.wordId === wordId && (e.generation === generation || e.generation === undefined && generation?.startsWith("legacy-"))).sort((a,b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id, "en"));
  const disabled = new Set<string>();
  // A later valid event wins deterministically; undoing a replacement restores its predecessor.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]; if (disabled.has(e.id)) continue;
    const target = e.kind === "undo" ? e.reversesEventId : e.supersedesEventId;
    if (target && events.slice(0, i).some(p => p.id === target && p.kind === "grade")) disabled.add(target);
  }
  const grades=events.filter(e=>e.kind==="grade");
  const roots=new Map<string,string>();
  for(const e of grades) roots.set(e.id,e.supersedesEventId && roots.has(e.supersedesEventId) ? roots.get(e.supersedesEventId)! : e.id);
  const winners=new Map<string,ReviewEvent>();
  for(const e of grades)if(!disabled.has(e.id))winners.set(roots.get(e.id)!,e);
  const activeEvents = [...winners.values()].sort((a,b)=>a.reviewedAt-b.reviewedAt||a.id.localeCompare(b.id,"en"));
  let srs = { ...baseline };
  const recall: { total: RecallCounts; byMode: Record<string, RecallCounts>; lastAt?: number } = baselineRecall ? {total:{...baselineRecall.total},byMode:Object.fromEntries(Object.entries(baselineRecall.byMode).map(([key,value])=>[key,{...value}])),...(baselineRecall.lastAt!==undefined?{lastAt:baselineRecall.lastAt}:{})} : { total: { pass:0,wrong:0,trap:0 }, byMode:{} };
  for (const e of activeEvents) {
    srs = gradeSrs(srs, e.grade!, e.reviewedAt);
    if (e.recall) { const counts = recall.byMode[e.mode] ??= {pass:0,wrong:0,trap:0}; counts[e.recall.bucket]++; recall.total[e.recall.bucket]++; recall.lastAt=e.reviewedAt; }
  }
  return { srs, activeEvents, recall };
}
