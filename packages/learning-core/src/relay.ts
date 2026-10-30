/** Version 2 payloads use existing reading-articles collection; no media bytes. */
export interface RelaySentence { id?: string; idx: number; paragraphIdx: number; en: string; zh: string | null; zhState: string; [key: string]: unknown }
export interface RelayArticle { id: string; title: string; sentences: RelaySentence[]; createdAt: number; lastReadAt: number; progress: { sentenceIdx: number; percent: number; secondsListened: number }; [key: string]: unknown }
export interface RelayEntity { id: string; schemaVersion: 2; payload: Record<string, unknown>; updatedAt: number; deleted?: boolean }
import { canonicalJson } from "./reviewEvents";
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
function revisionOf(value: unknown): string {
  const text = canonicalJson(value); let h = 2166136261;
  // Iterate UTF-16 code units, identical to Rust str::encode_utf16 (including emoji).
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export function contentRevision(sentences: readonly RelaySentence[]): string {
  return revisionOf(sentences.map(({ id: _derivedId, ...content }) => withoutAudio(content)));
}
export function sentenceId(articleId: string, _revision: string, idx: number): string { return `${articleId}:s${idx}`; }
export function entitiesFromArticle(article: RelayArticle, deviceId: string, targetBytes = 262144): RelayEntity[] {
  if (!deviceId || targetBytes < 1024) throw new Error("Invalid relay options");
  const revision = contentRevision(article.sentences), updatedAt = Math.max(article.lastReadAt, article.createdAt);
  const chunks: RelayEntity[] = []; let batch: RelaySentence[] = [];
  const flush = () => { if (!batch.length) return; const id = `chunk:${article.id}:${revision}:${revisionOf(batch)}`;
    chunks.push({id,schemaVersion:2,updatedAt,payload:{v:2,kind:"content-chunk",articleId:article.id,contentRevision:revision,sentences:batch}}); batch=[]; };
  for (const s of article.sentences) { const row = {...(withoutAudio(s) as RelaySentence),id:s.id || sentenceId(article.id,revision,s.idx)};
    if (batch.length && bytes([...batch,row]) > targetBytes) flush();
    if (bytes(row) > targetBytes) throw new Error(`Sentence exceeds content chunk limit: ${s.idx}`); batch.push(row); } flush();
  const {sentences: _sentences, progress: _progress, ...meta} = withoutAudio(article) as RelayArticle;
  const manifest: RelayEntity = {id:article.id,schemaVersion:2,updatedAt,payload:{...meta,v:2,kind:"article",contentRevision:revision,chunkIds:chunks.map(c=>c.id)}};
  const idx = article.progress.sentenceIdx;
  const progress: RelayEntity = {id:`progress:${article.id}:${deviceId}`,schemaVersion:2,updatedAt:article.lastReadAt,payload:{v:2,kind:"progress",articleId:article.id,deviceId,contentRevision:revision,locator:{sentenceId:article.sentences[idx]?.id || sentenceId(article.id,revision,idx)},lastReadAt:article.lastReadAt,...article.progress}};
  return [...chunks,manifest,progress];
}
export function articleFromEntities(id: string, entities: readonly RelayEntity[]): RelayArticle | null {
  const live = entities.filter(e=>!e.deleted); const manifest=live.find(e=>e.id===id && e.payload.kind==="article"); if(!manifest) return null;
  const p=manifest.payload; if(!Array.isArray(p.chunkIds)) return null; const sentences:RelaySentence[]=[];
  for(const cid of p.chunkIds) { const chunk=live.find(e=>e.id===cid); if(!chunk || chunk.payload.kind!=="content-chunk" || chunk.payload.articleId!==id || chunk.payload.contentRevision!==p.contentRevision || !Array.isArray(chunk.payload.sentences)) return null; sentences.push(...chunk.payload.sentences as RelaySentence[]); }
  const positions=live.filter(e=>e.payload.kind==="progress" && e.payload.articleId===id && e.payload.contentRevision===p.contentRevision).sort((a,b)=>Number(b.payload.lastReadAt)-Number(a.payload.lastReadAt)||a.id.localeCompare(b.id));
  const position=positions[0]?.payload, loc=position?.locator as {sentenceId?:string}|undefined;
  const sentenceIdx=Math.max(0,sentences.findIndex(s=>s.id===loc?.sentenceId));
  return {...p,id,title:String(p.title||""),sentences,createdAt:Number(p.createdAt||manifest.updatedAt),lastReadAt:Number(position?.lastReadAt||p.lastReadAt||0),progress:{sentenceIdx,percent:Number(position?.percent||0),secondsListened:Number(position?.secondsListened||0)}};
}
export function mergeRelayPayload(existing: unknown, incoming: Record<string,unknown>): Record<string,unknown> {
  const result = {...(existing && typeof existing==="object"&&!Array.isArray(existing)?existing as Record<string,unknown>:{}),...incoming};
  for (const [key,value] of Object.entries(incoming)) {
    const old = existing && typeof existing === "object" ? (existing as Record<string,unknown>)[key] : undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) result[key] = mergeRelayPayload(old,value as Record<string,unknown>);
    else if (Array.isArray(value) && Array.isArray(old)) result[key] = value.map(item => {
      if (!item || typeof item !== "object") return item;
      const row = item as Record<string,unknown>; const previous = old.find(p => p && typeof p === "object" && ((row.id !== undefined && p.id === row.id) || (row.idx !== undefined && p.idx === row.idx)));
      return mergeRelayPayload(previous,row);
    });
  }
  return result;
}
const PRIVATE_AUDIO_KEYS = new Set(["audio","audiob64","audiobase64","audio_base64","pcmb64","pcm","pcm_base64","wavb64","wav","blob","audiofile","audiopath","localpath"]);
const privateAudioKey = (key:string) => PRIVATE_AUDIO_KEYS.has(key.toLowerCase()) || key.startsWith("/") && key.slice(1).split("/").some(part=>PRIVATE_AUDIO_KEYS.has(part.replace(/~1/g,"/").replace(/~0/g,"~").toLowerCase()));
export function withoutAudio(value: unknown): unknown {
  if(Array.isArray(value)) return value.map(withoutAudio); if(!value || typeof value!=="object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!privateAudioKey(k)).map(([k,v])=>[k,withoutAudio(v)]));
}
