import { useSyncExternalStore } from "react";
import { articleFromEntities, canonicalJson, entitiesFromArticle, initialSrs, isReviewEvent, mergePracticePayload, reduceReviewEvents, withoutAudio, type RelayArticle, type RelayEntity } from "../../../packages/learning-core/src/index";
import { activeRepository, commitRepository, deviceId, flushPersist, getState, profileIdentity, replaceSyncedState, type AppState, type NoteItem } from "../store";
import type { Article, VocabWord } from "../core/types";
import type { CommitInput, OutboxItem, RecordWrite, Repository } from "../core/persistence";
import { CloudError, cloudRequest, cloudState, loadCloudConfig, type CloudConfig } from "./cloud";

const COLLECTIONS = ["reading-articles", "reading-vocab", "review-events", "notes", "speak-sessions", "history", "glossary"] as const;
type Collection = typeof COLLECTIONS[number];
type Json = Record<string, unknown>;
interface LocalEntity { id: string; schemaVersion: number; updatedAt: number; deleted: boolean; payload: unknown }
interface Mirror extends LocalEntity { baseVersion: number; dirty: boolean; mutationId?: string }
interface Meta { cursor: number; shadow: Record<string, string> }
interface WireEntity extends Omit<LocalEntity, "updatedAt"> { version: number; updatedAt: string }
interface PullPage { collection: string; cursor: number; hasMore: boolean; staleCursor?: boolean; entities: WireEntity[] }
interface PushResponse { collection: string; results: { id: string; status: string; version: number }[] }
interface SyncIntent { type: "sync.v2"; collection: Collection; entityId: string; mutationId: string }
type Extra = Omit<CommitInput, "state" | "expectedRevision">;
export interface SyncStatus { phase: "idle" | "syncing" | "offline" | "error"; pending: number; lastSyncedAt: number | null; message: string | null }

/** Dependency boundary lets the same protocol run against native SQLite and browser IndexedDB. */
export interface SyncDependencies {
  repository(): Repository;
  identity(): string;
  deviceId(): string;
  state(): AppState;
  flush(): Promise<void>;
  commit(input: Omit<CommitInput, "expectedRevision">): Promise<void>;
  replace(mapper: (current: AppState) => Partial<AppState>, extra?: Extra): Promise<void>;
  cloud(): { account: { id: string } | null; generation: number; config: CloudConfig | null };
  config(): Promise<CloudConfig>;
  request<T>(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<T>;
}
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
const payloadBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const fingerprint = (e: LocalEntity): string => canonicalJson({ schemaVersion: e.schemaVersion, deleted: e.deleted, payload: e.payload });
const mirrorCollection = (collection: Collection) => `sync.v2.${collection}`;
const emptyMeta = (): Meta => ({ cursor: 0, shadow: {} });
const isIntent = (value: unknown): value is SyncIntent => object(value) && value.type === "sync.v2" && COLLECTIONS.includes(value.collection as Collection) && typeof value.entityId === "string" && typeof value.mutationId === "string";

/** Retain fields this app version does not understand, including fields nested in identified rows. */
function mergeUnknown(old: unknown, next: unknown): unknown {
  if (object(old) && object(next)) return Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(next)])].map(key => [key, key in next ? mergeUnknown(old[key], next[key]) : old[key]]));
  if (Array.isArray(old) && Array.isArray(next)) return next.map(row => {
    if (!object(row)) return row;
    const previous = old.find(item => object(item) && (typeof row.id === "string" ? item.id === row.id : typeof row.idx === "number" && item.idx === row.idx));
    return mergeUnknown(previous, row);
  });
  return next;
}
function entity(id: string, payload: unknown, updatedAt: number): LocalEntity { return { id, payload: withoutAudio(payload), updatedAt, deleted: false, schemaVersion: 2 }; }
function noteId(id: string): string { return id.endsWith(".md") ? id : `${id}.md`; }

/** Domain projection is shared with Windows for article/chunk/progress IDs and revision rules. */
function project(state: AppState, device: string, targetBytes: number): Map<Collection, Map<string, LocalEntity>> {
  const result = new Map<Collection, Map<string, LocalEntity>>(COLLECTIONS.map(name => [name, new Map()]));
  const add = (collection: Collection, item: LocalEntity) => {
    if (!item.id || item.id.length > 128) throw new Error(`同步实体 ID 超过协议范围：${item.id}`);
    result.get(collection)!.set(item.id, item);
  };
  for (const article of state.articles) {
    const idx = Math.min(Math.max(0, state.progress[article.id] ?? 0), Math.max(0, article.sentences.length - 1));
    const relay: RelayArticle = { ...article, createdAt: numeric(article.createdAt), lastReadAt: numeric(article.lastReadAt),
      sentences: article.sentences.map(s => ({ ...s, zhState: s.zhState ?? (s.zh ? "machine" : "empty") })),
      progress: { sentenceIdx: idx, percent: article.sentences.length ? Math.round((idx + 1) * 100 / article.sentences.length) : 0, secondsListened: numeric((article.progress as Json | undefined)?.secondsListened) },
    };
    for (const row of entitiesFromArticle(relay, device, targetBytes)) add("reading-articles", { ...row, deleted: !!row.deleted });
  }
  for (const word of state.vocab) {
    const baseline = word.srsBaseline ?? word.baseline ?? word.srs ?? initialSrs(word.dueAt);
    const baselineRecall = word.baselineRecall ?? (state.reviewEvents.some(e => e.wordId === word.id) ? undefined : word.recall) ?? {total:{pass:0,wrong:0,trap:0},byMode:{}};
    add("reading-vocab", entity(word.id, { ...word, v: 2, source: { ...(object(word.source) ? word.source : {}), articleId: word.sourceArticleId, sentenceIdx: word.sourceSentenceIdx }, srs: word.srs ?? initialSrs(word.dueAt), srsBaseline: baseline, baseline, baselineRecall, addedAt: numeric(word.addedAt, numeric(word.createdAt)) }, numeric(word.updatedAt, numeric(word.createdAt))));
  }
  for (const review of state.reviewEvents) { if (!isReviewEvent(review)) throw new Error("本地复习事件格式异常，已保留原始记录"); add("review-events", entity(review.id, review, review.reviewedAt)); }
  for (const note of state.notes) {
    const id = noteId(note.id), meta = object((note as unknown as Json).meta) ? (note as unknown as Json).meta as Json : {};
    add("notes", entity(id, { ...note, id, mobileId: note.id, v: 2, meta: { ...meta, file: id, createdAt: numeric(note.createdAt), updatedAt: numeric(note.updatedAt), words: numeric(meta.words), wordIds: Array.isArray(meta.wordIds) ? meta.wordIds : [], partial: !!meta.partial }, content: note.body }, numeric(note.updatedAt, numeric(note.createdAt))));
  }
  for (const session of state.sessions) {
    const original = session as unknown as Json;
    const { _syncTurns, ...fields } = original;
    const existingTurns = Array.isArray(_syncTurns) ? _syncTurns.filter(object) : Array.isArray(original.turns) ? original.turns.filter(object) : [];
    const turns = session.chat.map((t, index) => { const previous = existingTurns[index], role = t.who === "me" ? "user" : "assistant"; return { ...(previous?.role === role ? previous : {}), role, text: t.en, ...(t.zh ? { hintZh: t.zh } : {}), at: numeric(previous?.at, session.at + index) }; });
    add("speak-sessions", entity(session.id, { ...fields, v: 2, scenario: String(original.scenario ?? session.sceneId), difficulty: original.difficulty ?? state.speakDifficulty, createdAt: numeric(original.createdAt, session.at), updatedAt: numeric(original.updatedAt, session.at), startedAt: numeric(original.startedAt, session.at - session.secs * 1000), endedAt: numeric(original.endedAt, session.at), turns }, session.at));
  }
  for (const task of state.tasks) add("speak-sessions", entity(task.id, { v: 2, id: task.id, kind: "practice-task", scenario: "practice", difficulty: "medium", turns: [], createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.createdAt, endedAt: task.updatedAt, task }, task.updatedAt));
  for (const history of state.history) add("history", entity(history.id, history, numeric((history as unknown as Json).updatedAt)));
  for (const pair of state.glossary) add("glossary", entity(`term:${encodeURIComponent(pair.a)}`, { v: 2, ...pair }, 0));
  return result;
}

function restore(state: AppState, collection: Collection, rows: Map<string, Mirror>): Partial<AppState> {
  const live = [...rows.values()].filter(e => !e.deleted && object(e.payload));
  if (collection === "reading-articles") {
    const relay: RelayEntity[] = live.filter(e => e.schemaVersion === 2).map(e => ({ ...e, schemaVersion: 2, payload: e.payload as Json }));
    const articles: Article[] = []; const progress: Record<string, number> = {};
    for (const row of live) {
      const payload = row.payload as Json;
      if (payload.kind !== "article" && !Array.isArray(payload.sentences)) continue;
      const hydrated = row.schemaVersion === 2 ? articleFromEntities(row.id, relay) : payload;
      if (!hydrated || !Array.isArray(hydrated.sentences)) {
        const previous = state.articles.find(a => a.id === row.id);
        if (previous) { articles.push(previous); progress[row.id] = state.progress[row.id] ?? 0; }
        continue;
      }
      const sentences = hydrated.sentences.filter(s => object(s) && typeof s.en === "string").map((s, idx) => ({ ...s, idx: numeric(s.idx, idx), paragraphIdx: numeric(s.paragraphIdx), en: String(s.en), zh: typeof s.zh === "string" ? s.zh : null }));
      const article = { ...hydrated, id: row.id, title: String(hydrated.title ?? "未命名文章"), titleCn: String(hydrated.titleCn ?? ""), paragraphStarts: Array.isArray(hydrated.paragraphStarts) ? hydrated.paragraphStarts : [0], sentences, sourceType: hydrated.sourceType ?? "relay" } as Article;
      articles.push(article); progress[row.id] = numeric((hydrated.progress as Json | undefined)?.sentenceIdx);
    }
    // A manifest is only visible after every referenced chunk has arrived. Never fall back to a deleted local article.
    return { articles, progress };
  }
  if (collection === "reading-vocab") return { vocab: live.flatMap(row => {
    const p = row.payload as Json; if (typeof p.word !== "string") return [];
    const source = object(p.source) ? p.source : {}, srs = object(p.srs) ? p.srs : {};
    return [{ ...p, id: row.id, word: p.word, generation: typeof p.generation === "string" ? p.generation : `legacy-${numeric(p.addedAt, numeric(p.createdAt))}`, senses: Array.isArray(p.senses) ? p.senses : [], dueAt: numeric(srs.dueAt, numeric(p.dueAt)), srsBaseline: p.srsBaseline ?? p.baseline ?? p.srs, baselineRecall: p.baselineRecall ?? (state.reviewEvents.some(e => e.wordId === row.id) ? undefined : p.recall) ?? {total:{pass:0,wrong:0,trap:0},byMode:{}}, sourceArticleId: String(source.articleId ?? p.sourceArticleId ?? ""), sourceSentenceIdx: numeric(source.sentenceIdx, numeric(p.sourceSentenceIdx)) } as VocabWord];
  }) };
  if (collection === "review-events") {
    const reviewEvents = live.map(e => e.payload).filter(isReviewEvent);
    const vocab = state.vocab.map(word => {
      const baseline = word.srsBaseline ?? word.srs ?? initialSrs(word.dueAt);
      const baselineRecall = (word.baselineRecall ?? (state.reviewEvents.some(e => e.wordId === word.id) ? undefined : word.recall)) as ReturnType<typeof reduceReviewEvents>["recall"] | undefined;
      const reduced = reduceReviewEvents(baseline, reviewEvents, word.id, word.generation, baselineRecall);
      return { ...word, srsBaseline: baseline, baseline, baselineRecall: baselineRecall ?? {total:{pass:0,wrong:0,trap:0},byMode:{}}, srs: reduced.srs, dueAt: reduced.srs.dueAt, recall: reduced.recall };
    });
    return { reviewEvents, vocab };
  }
  if (collection === "notes") return { notes: live.flatMap(row => {
    const p = row.payload as Json; if (typeof p.content !== "string" && typeof p.body !== "string") return [];
    const meta = object(p.meta) ? p.meta : {};
    return [{ ...p, id: String(p.mobileId ?? row.id), title: String(p.title ?? row.id.replace(/\.md$/, "")), sub: String(p.sub ?? "云端笔记"), body: String(p.content ?? p.body), insight: String(p.insight ?? ""), createdAt: numeric(meta.createdAt), updatedAt: numeric(meta.updatedAt) } as NoteItem];
  }) };
  if (collection === "speak-sessions") return {
    tasks: live.flatMap(row => { const p = row.payload as Json; return p.kind === "practice-task" && object(p.task) && typeof p.task.id === "string" && Array.isArray(p.task.attempts) ? [p.task as unknown as AppState["tasks"][number]] : []; }),
    sessions: live.flatMap(row => {
      const p = row.payload as Json; if (p.kind === "practice-task" || !Array.isArray(p.chat) && !Array.isArray(p.turns)) return [];
      const chat: AppState["sessions"][number]["chat"] = Array.isArray(p.chat) ? p.chat as AppState["sessions"][number]["chat"] : (p.turns as unknown[]).filter(object).map(t => ({ who: t.role === "user" ? "me" : "ai", en: String(t.text ?? ""), zh: typeof t.hintZh === "string" ? t.hintZh : undefined }));
      return [{ ...p, id: row.id, sceneId: String(p.sceneId ?? p.scenarioId ?? p.scenario ?? ""), scene: String(p.scene ?? p.title ?? "云端练习"), chat, turns: chat.length, ...(Array.isArray(p.turns) ? { _syncTurns: p.turns } : {}), at: numeric(p.at, numeric(p.updatedAt, numeric(p.endedAt))), secs: numeric(p.secs), me: numeric(p.me, chat.filter(t => t.who === "me").length) } as AppState["sessions"][number]];
    }),
  };
  if (collection === "history") return { history: live.flatMap(row => { const p = row.payload as Json; return typeof p.en === "string" ? [{ ...p, id: row.id, src: String(p.src ?? "云端"), en: p.en, zh: String(p.zh ?? ""), time: String(p.time ?? ""), star: !!p.star }] : []; }) };
  if (collection === "glossary") return { glossary: live.flatMap(row => { const p = row.payload as Json; return typeof p.a === "string" && typeof p.b === "string" ? [{ a: p.a, b: p.b }] : []; }) };
  return {};
}

export class MobileSync {
  private flight: Promise<void> | null = null;
  private localQueue: Promise<void> = Promise.resolve();
  private status: SyncStatus = { phase: "idle", pending: 0, lastSyncedAt: null, message: null };
  private listeners = new Set<() => void>();
  constructor(private readonly deps: SyncDependencies) {}
  getStatus = (): SyncStatus => this.status;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<SyncStatus>) { this.status = { ...this.status, ...patch }; this.listeners.forEach(fn => fn()); }
  private context() {
    const cloud = this.deps.cloud(), repo = this.deps.repository();
    if (!cloud.account || this.deps.identity() !== cloud.account.id || repo.identity !== cloud.account.id) throw new CloudError("请先登录当前资料所属账号", 401, "login_required");
    const generation = cloud.generation, id = cloud.account.id;
    return { repo, check: () => { const now = this.deps.cloud(); if (now.generation !== generation || now.account?.id !== id || this.deps.identity() !== id || this.deps.repository() !== repo) throw new DOMException("账号已切换", "AbortError"); } };
  }
  private async metadata(repo: Repository, collection: Collection): Promise<Meta> { return (await repo.get<Meta>("sync.v2.meta", collection))?.payload ?? emptyMeta(); }
  private async mirrors(repo: Repository, collection: Collection): Promise<Map<string, Mirror>> { return new Map((await repo.list<Mirror>(mirrorCollection(collection))).filter(r => !r.deleted && r.payload).map(r => [r.id, r.payload!])); }
  private async limits(): Promise<NonNullable<CloudConfig["sync"]>> {
    const config = this.deps.cloud().config ?? await this.deps.config();
    if (!config.features.sync || !config.sync || config.sync.protocolVersion < 2) throw new Error("当前服务端尚未支持移动端学习同步协议，请先升级服务端");
    return config.sync;
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.localQueue.catch(() => undefined).then(work);
    this.localQueue = next; return next;
  }
  queueLocal(): Promise<void> {
    const next = this.serialize(async () => {
      const ctx = this.context(); await this.deps.flush(); ctx.check();
      const config = this.deps.cloud().config;
      const target = numeric((config?.sync as unknown as Json | undefined)?.contentChunkTargetBytes, 262144);
      const projection = project(this.deps.state(), this.deps.deviceId(), target);
      const records: RecordWrite[] = [], outbox: OutboxItem[] = [];
      for (const collection of COLLECTIONS) {
        const meta = await this.metadata(ctx.repo, collection), mirrors = await this.mirrors(ctx.repo, collection), projected = projection.get(collection)!;
        const shadow = { ...meta.shadow }; let changed = false;
        for (const [id, local] of projected) {
          const signature = fingerprint(local); if (shadow[id] === signature) continue;
          const previous = mirrors.get(id);
          if (previous && previous.schemaVersion > local.schemaVersion) throw new Error(`当前版本不能写回较新格式的数据：${id}`);
          const payload = withoutAudio(mergePracticePayload(previous?.payload, local.payload) ?? mergeUnknown(previous?.payload, local.payload));
          if (collection === "review-events" && previous && canonicalJson(previous.payload) !== canonicalJson(payload)) throw new Error(`复习事件 ID 内容冲突：${id}`);
          const mutationId = crypto.randomUUID();
          const next: Mirror = { ...local, payload, baseVersion: previous?.baseVersion ?? 0, dirty: true, mutationId, updatedAt: Math.max(Date.now(), local.updatedAt, (previous?.updatedAt ?? 0) + 1) };
          records.push({ collection: mirrorCollection(collection), id, payload: next });
          outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: id, mutationId } satisfies SyncIntent });
          shadow[id] = signature; changed = true;
        }
        for (const id of Object.keys(meta.shadow)) if (!projected.has(id)) {
          delete shadow[id]; changed = true;
          const previous = mirrors.get(id); if (!previous || previous.deleted || collection === "review-events") continue;
          const mutationId = crypto.randomUUID(), next: Mirror = { ...previous, payload: null, deleted: true, dirty: true, mutationId, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
          records.push({ collection: mirrorCollection(collection), id, payload: next });
          outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: id, mutationId } satisfies SyncIntent });
        }
        if (changed) records.push({ collection: "sync.v2.meta", id: collection, payload: { ...meta, shadow } });
      }
      ctx.check();
      if (records.length) await this.deps.replace(() => { ctx.check(); return {}; }, { records, outbox });
    });
    return next.catch(error => { this.emit({ phase: "error", message: error instanceof Error ? error.message : String(error) }); throw error; });
  }
  async sync(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.run().finally(() => { this.flight = null; }); return this.flight;
  }
  private async run() {
    try {
      const ctx = this.context(); this.emit({ phase: "syncing", message: null });
      const limits = await this.limits(); ctx.check(); await this.queueLocal();
      for (const collection of COLLECTIONS) {
        if (!limits.collections[collection]?.schemaVersions.includes(2)) continue;
        await this.pull(collection); await this.push(collection, limits); ctx.check();
      }
      let pending = 0; for (const collection of COLLECTIONS) pending += [...(await this.mirrors(ctx.repo, collection)).values()].filter(e => e.dirty).length;
      this.emit({ phase: "idle", pending, lastSyncedAt: Date.now(), message: pending ? "部分本机更改等待下次同步" : null });
    } catch (error) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      this.emit({ phase: offline ? "offline" : "error", message: error instanceof Error ? error.message : String(error) }); throw error;
    }
  }
  private async pull(collection: Collection, forceFull = false, preserveDirty = true): Promise<void> {
    const ctx = this.context(); const meta = await this.metadata(ctx.repo, collection);
    let cursor = forceFull ? 0 : meta.cursor, full = forceFull || meta.cursor === 0; const staged = new Map<string, Mirror>();
    for (let page = 0; page < 400; page++) {
      let data: PullPage;
      try { data = await this.deps.request<PullPage>(`/v1/sync/${collection}/pull?since=${cursor}&limit=500`); }
      catch (error) {
        if (error instanceof CloudError && ["stale_cursor", "staleCursor"].includes(error.code) && !full) { full = true; cursor = 0; staged.clear(); continue; }
        throw error;
      }
      ctx.check();
      if (data.staleCursor && !full) { full = true; cursor = 0; staged.clear(); continue; }
      if (data.collection !== collection || !Array.isArray(data.entities) || !Number.isSafeInteger(data.cursor) || data.cursor < cursor || typeof data.hasMore !== "boolean" || data.hasMore && data.cursor === cursor) throw new Error("同步响应游标无效，原资料与游标已保留");
      for (const wire of data.entities) {
        const updatedAt = Date.parse(wire.updatedAt);
        if (!wire.id || !Number.isSafeInteger(wire.version) || wire.version <= 0 || !Number.isFinite(updatedAt) || !Number.isInteger(wire.schemaVersion) || typeof wire.deleted !== "boolean" || !wire.deleted && !object(wire.payload)) throw new Error("同步实体格式无效，原资料已保留");
        staged.set(wire.id, { id: wire.id, payload: wire.deleted ? null : withoutAudio(wire.payload), schemaVersion: wire.schemaVersion, updatedAt, deleted: wire.deleted, dirty: false, baseVersion: wire.version });
      }
      cursor = data.cursor;
      if (!data.hasMore) { await this.applyRemote(collection, staged, cursor, full, preserveDirty); return; }
    }
    throw new Error("同步分页超出安全上限，原资料与游标已保留");
  }
  private async applyRemote(collection: Collection, incoming: Map<string, Mirror>, cursor: number, full: boolean, preserveDirty: boolean) {
    await this.queueLocal();
    await this.serialize(async () => {
    const ctx = this.context(), old = await this.mirrors(ctx.repo, collection), meta = await this.metadata(ctx.repo, collection);
    const merged = full ? new Map<string, Mirror>() : new Map(old);
    const records: RecordWrite[] = []; const outbox: OutboxItem[] = [];
    const practice = (row: Mirror) => object(row.payload) && row.payload.kind === "practice-task";
    const retainPractice = (local: Mirror | undefined, remote: Mirror): Mirror | null => {
      if (collection !== "speak-sessions" || !local) return null;
      // Whole-task deletion must not be undone by an older live copy.
      if ((local.deleted || remote.deleted) && (practice(local) || practice(remote))) {
        if (remote.deleted) return remote;
        const mutationId = crypto.randomUUID();
        outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: local.id, mutationId } satisfies SyncIntent });
        return { ...local, baseVersion: remote.baseVersion, updatedAt: Math.max(Date.now(), local.updatedAt, remote.updatedAt + 1), dirty: true, mutationId };
      }
      const payload = mergePracticePayload(local.payload, remote.payload);
      if (!payload) return null;
      if (canonicalJson(payload) === canonicalJson(remote.payload)) return remote;
      const mutationId = crypto.randomUUID();
      outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: local.id, mutationId } satisfies SyncIntent });
      return { ...remote, payload: withoutAudio(payload), updatedAt: Math.max(Date.now(), local.updatedAt, remote.updatedAt + 1), dirty: true, mutationId };
    };
    for (const [id, remote] of incoming) {
      const local = old.get(id), immutable = collection === "review-events" || object(remote.payload) && remote.payload.kind === "content-chunk";
      if (remote.schemaVersion > 2) throw new Error(`云端资料 ${id} 使用较新格式，请先升级应用`);
      if (local?.dirty && immutable && !local.deleted && !remote.deleted && canonicalJson(local.payload) !== canonicalJson(remote.payload)) throw new Error(`不可变同步数据内容冲突：${id}，本机记录已保留`);
      const combined = retainPractice(local, remote);
      if (combined) merged.set(id, combined);
      else if (local?.dirty && (full && preserveDirty || local.updatedAt > remote.updatedAt || local.schemaVersion > remote.schemaVersion)) merged.set(id, { ...local, baseVersion: remote.baseVersion });
      else merged.set(id, remote);
    }
    if (full) for (const [id, local] of old) if (local.dirty && !incoming.has(id)) merged.set(id, { ...local, baseVersion: 0 });
    ctx.check();
    await this.deps.replace(current => {
      ctx.check();
      // Capture edits made while the response or repository reads were in flight.
      const projection = project(current, this.deps.deviceId(), 262144).get(collection)!;
      for (const [id, local] of projection) if (meta.shadow[id] !== fingerprint(local)) {
        const previous = old.get(id), mutationId = crypto.randomUUID();
        const retained: Mirror = { ...local, payload: withoutAudio(mergePracticePayload(previous?.payload, local.payload) ?? mergeUnknown(previous?.payload, local.payload)), updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1), baseVersion: incoming.get(id)?.baseVersion ?? (full ? 0 : previous?.baseVersion ?? 0), dirty: true, mutationId };
        merged.set(id, retainPractice(retained, merged.get(id) ?? retained) ?? retained); outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: id, mutationId } satisfies SyncIntent });
      }
      for (const id of Object.keys(meta.shadow)) if (!projection.has(id) && collection !== "review-events") {
        const previous = old.get(id); if (!previous) continue;
        const mutationId = crypto.randomUUID(); merged.set(id, { ...previous, deleted: true, payload: null, dirty: true, mutationId, baseVersion: incoming.get(id)?.baseVersion ?? previous.baseVersion, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) });
        outbox.push({ id: `sync:${mutationId}`, payload: { type: "sync.v2", collection, entityId: id, mutationId } satisfies SyncIntent });
      }
      const patch = restore(current, collection, merged), next = { ...current, ...patch };
      const shadow = Object.fromEntries([...project(next, this.deps.deviceId(), 262144).get(collection)!].map(([id, value]) => [id, fingerprint(value)]));
      for (const [id, value] of merged) records.push({ collection: mirrorCollection(collection), id, payload: value });
      if (full) for (const id of old.keys()) if (!merged.has(id)) records.push({ collection: mirrorCollection(collection), id, payload: null, deleted: true });
      records.push({ collection: "sync.v2.meta", id: collection, payload: { cursor, shadow } satisfies Meta });
      return patch;
    }, { records, outbox });
    });
  }
  private async push(collection: Collection, limits: NonNullable<CloudConfig["sync"]>) {
    const ctx = this.context(); let conflicts = 0;
    for (let round = 0; round < 1000; round++) {
      await this.queueLocal(); ctx.check(); const current = await this.mirrors(ctx.repo, collection);
      const pending = [...current.values()].filter(e => e.dirty).sort((a, b) => { const rank = (e: Mirror) => object(e.payload) && e.payload.kind === "content-chunk" ? 0 : object(e.payload) && e.payload.kind === "progress" ? 2 : 1; return rank(a) - rank(b) || a.id.localeCompare(b.id); });
      if (!pending.length) { await this.cleanupOutbox(ctx.repo); return; }
      this.emit({ pending: pending.length });
      const batch: Mirror[] = [], entities: unknown[] = [];
      for (const local of pending) {
        const max = limits.collections[collection].maxEntityBytes;
        if (!local.deleted && payloadBytes(local.payload) > max) throw new Error(`同步条目超过 ${Math.floor(max / 1024)} KB：${local.id}；原资料已保留`);
        const wire = { id: local.id, baseVersion: local.baseVersion, updatedAt: new Date(local.updatedAt).toISOString(), deleted: local.deleted, schemaVersion: local.schemaVersion, originDevice: this.deps.deviceId(), payload: local.deleted ? null : local.payload };
        if (payloadBytes({ entities: [...entities, wire] }) > limits.maxBodyBytes) { if (!batch.length) throw new Error(`同步条目超过请求体上限：${local.id}`); break; }
        batch.push(local); entities.push(wire); if (batch.length >= Math.min(200, limits.maxPushEntities)) break;
      }
      let response: PushResponse;
      try { response = await this.deps.request<PushResponse>(`/v1/sync/${collection}/push`, "POST", { entities }); }
      catch (error) {
        ctx.check();
        if (error instanceof CloudError && error.status === 409 && conflicts++ < 3) { await this.pull(collection, true, false); continue; }
        throw error;
      }
      ctx.check();
      if (response.collection !== collection || !Array.isArray(response.results) || response.results.length !== batch.length) throw new Error("同步确认响应不完整，本机待同步记录已保留");
      const accepted = new Map(response.results.map(r => [r.id, r]));
      if (accepted.size !== batch.length || batch.some(e => { const ack = accepted.get(e.id); return !ack || ack.status !== "accepted" || !Number.isSafeInteger(ack.version) || ack.version <= 0; })) throw new Error("同步确认版本无效，本机待同步记录已保留");
      await this.queueLocal();
      await this.serialize(async () => {
      const latest = await this.mirrors(ctx.repo, collection); const records: RecordWrite[] = [];
      for (const sent of batch) {
        const now = latest.get(sent.id); if (!now) continue;
        records.push({ collection: mirrorCollection(collection), id: sent.id, payload: { ...now, baseVersion: accepted.get(sent.id)!.version, dirty: now.mutationId !== sent.mutationId } satisfies Mirror });
      }
      ctx.check(); await this.deps.replace(() => { ctx.check(); return {}; }, { records }); await this.cleanupOutbox(ctx.repo);
      });
    }
    throw new Error("本次同步量过大，剩余记录已保留供下次继续");
  }
  private async cleanupOutbox(repo: Repository) {
    const intents = (await repo.listOutbox(1000)).filter(item => isIntent(item.payload));
    const ids: string[] = []; const cache = new Map<Collection, Map<string, Mirror>>();
    for (const item of intents) { const intent = item.payload as SyncIntent; let mirrors = cache.get(intent.collection); if (!mirrors) { mirrors = await this.mirrors(repo, intent.collection); cache.set(intent.collection, mirrors); } const current = mirrors.get(intent.entityId); if (!current?.dirty || current.mutationId !== intent.mutationId) ids.push(item.id); }
    if (ids.length) await repo.ackOutbox(ids);
  }
}

const sync = new MobileSync({ repository: activeRepository, identity: profileIdentity, deviceId, state: getState, flush: flushPersist, commit: commitRepository, replace: replaceSyncedState, cloud: cloudState, config: loadCloudConfig, request: cloudRequest });
export function useSyncStatus(): SyncStatus { return useSyncExternalStore(sync.subscribe, sync.getStatus); }
export const syncStatus = sync.getStatus;
export const queueLocalSync = (): Promise<void> => sync.queueLocal();
export const syncNow = (): Promise<void> => sync.sync();
let stop: (() => void) | null = null;
/** Start after profile hydration; callers own startup/login barriers and display syncStatus errors. */
export function startSync(): () => void {
  if (stop) return stop; let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (timer) clearTimeout(timer); if (!cloudState().account) return; timer = setTimeout(() => { void syncNow().catch(() => undefined); }, 750); };
  const local = () => { if (!cloudState().account) return; void queueLocalSync().then(schedule).catch(() => undefined); };
  const visible = () => { if (document.visibilityState === "visible") schedule(); };
  window.addEventListener("mobile-state-change", local); window.addEventListener("mobile-profile-change", schedule); window.addEventListener("online", schedule); document.addEventListener("visibilitychange", visible); schedule();
  stop = () => { if (timer) clearTimeout(timer); window.removeEventListener("mobile-state-change", local); window.removeEventListener("mobile-profile-change", schedule); window.removeEventListener("online", schedule); document.removeEventListener("visibilitychange", visible); stop = null; };
  return stop;
}
