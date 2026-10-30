/** Durable profile repository. No access/refresh tokens are stored here.
 * Native: SQLite + private WAV files. Browser preview: identity-isolated IndexedDB.
 * A revision conflict is surfaced; callers must reload and reapply the mutation.
 */
export interface Snapshot<T = unknown> { revision: number; state: T | null }
export interface PersistedRecord<T = unknown> { collection: string; id: string; payload: T | null; version: number; deleted: boolean }
export interface RecordWrite { collection: string; id: string; payload: unknown; expectedVersion?: number; deleted?: boolean }
export interface LedgerEvent { eventId: string; payload: unknown }
export interface OutboxItem { id: string; payload: unknown; createdAt?: number }
export interface CommitInput { expectedRevision: number; state?: unknown; records?: RecordWrite[]; events?: LedgerEvent[]; outbox?: OutboxItem[] }
export interface CommitResult { revision: number; alreadyApplied: boolean }
export interface MigrationInput { migrationId: string; entries: Record<string, string | null>; state: unknown; records?: RecordWrite[] }
export interface MigrationResult { revision: number; migrated: boolean }
export interface AudioManifest { clipId: string; status: "recording" | "interrupted" | "ready" | "missing"; byteLength: number; nextSequence: number; durationMs: number; sampleRate: number; channels: number; metadata: unknown }
export interface AudioRead { manifest: AudioManifest; wavB64: string }
export interface Repository {
  readonly identity: string;
  loadSnapshot<T = unknown>(): Promise<Snapshot<T>>;
  saveSnapshot(state: unknown, expectedRevision: number): Promise<CommitResult>;
  commit(input: CommitInput): Promise<CommitResult>;
  migrateLegacy(input: MigrationInput): Promise<MigrationResult>;
  get<T = unknown>(collection: string, id: string): Promise<PersistedRecord<T> | null>;
  list<T = unknown>(collection: string): Promise<PersistedRecord<T>[]>;
  set(collection: string, id: string, payload: unknown, expectedRevision: number, expectedVersion?: number): Promise<CommitResult>;
  remove(collection: string, id: string, expectedRevision: number, expectedVersion?: number): Promise<CommitResult>;
  listEvents(): Promise<LedgerEvent[]>;
  listOutbox(limit?: number): Promise<OutboxItem[]>;
  ackOutbox(ids: string[]): Promise<void>;
  audioBegin(clipId: string, metadata: unknown): Promise<AudioManifest>;
  audioAppend(clipId: string, sequence: number, pcmB64: string): Promise<AudioManifest>;
  audioFinalize(clipId: string): Promise<AudioManifest>;
  audioRead(clipId: string): Promise<AudioRead>;
  audioManifest(clipId: string): Promise<AudioManifest | null>;
  audioDelete(clipId: string): Promise<void>;
  close(): void;
}
function valid(value: string, kind: string): void { if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`INVALID_${kind}`); }
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("INDEXEDDB_REQUEST_FAILED")); }); }
const STORES = ["snapshot", "records", "events", "outbox", "migrations", "backups", "audio"] as const;
type StoreName = typeof STORES[number];
abstract class BaseRepository implements Repository {
  constructor(readonly identity: string) {}
  abstract loadSnapshot<T = unknown>(): Promise<Snapshot<T>>;
  abstract commit(input: CommitInput): Promise<CommitResult>;
  abstract migrateLegacy(input: MigrationInput): Promise<MigrationResult>;
  abstract get<T = unknown>(collection: string, id: string): Promise<PersistedRecord<T> | null>;
  abstract list<T = unknown>(collection: string): Promise<PersistedRecord<T>[]>;
  abstract listEvents(): Promise<LedgerEvent[]>;
  abstract listOutbox(limit?: number): Promise<OutboxItem[]>;
  abstract ackOutbox(ids: string[]): Promise<void>;
  abstract audioBegin(clipId: string, metadata: unknown): Promise<AudioManifest>;
  abstract audioAppend(clipId: string, sequence: number, pcmB64: string): Promise<AudioManifest>;
  abstract audioFinalize(clipId: string): Promise<AudioManifest>;
  abstract audioRead(clipId: string): Promise<AudioRead>;
  abstract audioManifest(clipId: string): Promise<AudioManifest | null>;
  abstract audioDelete(clipId: string): Promise<void>;
  abstract close(): void;
  saveSnapshot(state: unknown, expectedRevision: number): Promise<CommitResult> { return this.commit({ state, expectedRevision }); }
  set(collection: string, id: string, payload: unknown, expectedRevision: number, expectedVersion?: number): Promise<CommitResult> { return this.commit({ expectedRevision, records: [{ collection, id, payload, expectedVersion }] }); }
  remove(collection: string, id: string, expectedRevision: number, expectedVersion?: number): Promise<CommitResult> { return this.commit({ expectedRevision, records: [{ collection, id, payload: null, expectedVersion, deleted: true }] }); }
}
class NativeRepository extends BaseRepository {
  private closed = false;
  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("REPOSITORY_CLOSED");
    const { invoke } = await import("@tauri-apps/api/core");
    if (this.closed) throw new Error("REPOSITORY_CLOSED");
    return invoke<T>(command, { identity: this.identity, ...args });
  }
  loadSnapshot<T = unknown>(): Promise<Snapshot<T>> { return this.invoke("persistence_load"); }
  initialize(): Promise<Snapshot> { return this.invoke("persistence_initialize"); }
  commit(input: CommitInput): Promise<CommitResult> { return this.invoke("persistence_commit", { input }); }
  migrateLegacy(input: MigrationInput): Promise<MigrationResult> { return this.invoke("persistence_migrate", { input }); }
  get<T = unknown>(collection: string, id: string): Promise<PersistedRecord<T> | null> { return this.invoke("persistence_record", { collection, id }); }
  list<T = unknown>(collection: string): Promise<PersistedRecord<T>[]> { return this.invoke("persistence_records", { collection }); }
  listEvents(): Promise<LedgerEvent[]> { return this.invoke("persistence_events"); }
  listOutbox(limit = 100): Promise<OutboxItem[]> { return this.invoke("persistence_outbox", { limit }); }
  ackOutbox(ids: string[]): Promise<void> { return this.invoke("persistence_ack_outbox", { ids }); }
  audioBegin(clipId: string, metadata: unknown): Promise<AudioManifest> { return this.invoke("audio_clip_begin", { clipId, metadata }); }
  audioAppend(clipId: string, sequence: number, pcmB64: string): Promise<AudioManifest> { return this.invoke("audio_clip_append", { clipId, sequence, pcmB64 }); }
  audioFinalize(clipId: string): Promise<AudioManifest> { return this.invoke("audio_clip_finalize", { clipId }); }
  audioRead(clipId: string): Promise<AudioRead> { return this.invoke("audio_clip_read", { clipId }); }
  audioManifest(clipId: string): Promise<AudioManifest | null> { return this.invoke("audio_clip_manifest", { clipId }); }
  audioDelete(clipId: string): Promise<void> { return this.invoke("audio_clip_delete", { clipId }); }
  close(): void { this.closed = true; }
}
interface BrowserClip { manifest: AudioManifest; chunks: Uint8Array[]; digests: string[] }
const MAX_AUDIO = 20 * 1024 * 1024;
function fromB64(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, c => c.charCodeAt(0)); }
function toB64(bytes: Uint8Array): string { let result = ""; for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(result); }
function wav(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size + 44); const view = new DataView(result.buffer);
  result.set(new TextEncoder().encode("RIFF"), 0); view.setUint32(4, size + 36, true); result.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  result.set(new TextEncoder().encode("data"), 36); view.setUint32(40, size, true); let offset = 44; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
class BrowserRepository extends BaseRepository {
  constructor(identity: string, private readonly db: IDBDatabase) { super(identity); }
  private async transaction<T>(stores: StoreName[], mode: IDBTransactionMode, task: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("INDEXEDDB_TRANSACTION_ABORTED")); tx.onerror = () => {}; });
    // Observe an abort immediately; the caller still receives the original failure below.
    void done.catch(() => undefined);
    try { const result = await task(tx); await done; return result; } catch (error) { try { tx.abort(); } catch { /* already settled */ } await done.catch(() => undefined); throw error; }
  }
  loadSnapshot<T = unknown>(): Promise<Snapshot<T>> { return this.transaction(["snapshot"], "readonly", async tx => (await request<Snapshot<T> | undefined>(tx.objectStore("snapshot").get("main"))) ?? { revision: 0, state: null }); }
  commit(input: CommitInput): Promise<CommitResult> {
    return this.transaction(["snapshot", "records", "events", "outbox"], "readwrite", async tx => {
      const stateStore = tx.objectStore("snapshot"); const snapshot = (await request<Snapshot | undefined>(stateStore.get("main"))) ?? { revision: 0, state: null }; let duplicates = 0;
      for (const event of input.events ?? []) { valid(event.eventId, "EVENT_ID"); const old = await request<LedgerEvent | undefined>(tx.objectStore("events").get(event.eventId)); if (old) { if (canonical(old.payload) !== canonical(event.payload)) throw new Error("EVENT_ID_COLLISION"); duplicates++; } }
      if (duplicates) { if (duplicates !== input.events?.length) throw new Error("MIXED_EVENT_RETRY"); return { revision: snapshot.revision, alreadyApplied: true }; }
      if (input.expectedRevision !== snapshot.revision) throw new Error(`REVISION_CONFLICT:${snapshot.revision}`);
      for (const record of input.records ?? []) await this.writeRecord(tx, record);
      for (const event of input.events ?? []) await request(tx.objectStore("events").add(event, event.eventId));
      for (const item of input.outbox ?? []) { valid(item.id, "OUTBOX_ID"); const old = await request<OutboxItem | undefined>(tx.objectStore("outbox").get(item.id)); if (old && canonical(old.payload) !== canonical(item.payload)) throw new Error("OUTBOX_ID_COLLISION"); if (!old) await request(tx.objectStore("outbox").add({ ...item, createdAt: item.createdAt || Date.now() }, item.id)); }
      const revision = snapshot.revision + 1; await request(stateStore.put({ revision, state: input.state === undefined ? snapshot.state : input.state }, "main")); return { revision, alreadyApplied: false };
    });
  }
  private async writeRecord(tx: IDBTransaction, record: RecordWrite): Promise<void> {
    valid(record.collection, "COLLECTION"); valid(record.id, "RECORD_ID"); const store = tx.objectStore("records"); const key = [record.collection, record.id];
    const previous = await request<PersistedRecord | undefined>(store.get(key)); const version = previous?.version ?? 0;
    if (record.expectedVersion !== undefined && record.expectedVersion !== version) throw new Error(`RECORD_VERSION_CONFLICT:${version}`);
    await request(store.put({ collection: record.collection, id: record.id, payload: record.payload ?? null, version: version + 1, deleted: record.deleted ?? false }, key));
  }
  migrateLegacy(input: MigrationInput): Promise<MigrationResult> {
    valid(input.migrationId, "MIGRATION_ID");
    return this.transaction(["snapshot", "migrations", "backups", "records"], "readwrite", async tx => {
      const store = tx.objectStore("snapshot"); const previous = (await request<Snapshot | undefined>(store.get("main"))) ?? { revision: 0, state: null };
      if (await request(tx.objectStore("migrations").get(input.migrationId))) return { revision: previous.revision, migrated: false };
      if (previous.revision !== 0) throw new Error("MIGRATION_TARGET_NOT_EMPTY");
      for (const [key, value] of Object.entries(input.entries)) await request(tx.objectStore("backups").add(value, [input.migrationId, key]));
      for (const record of input.records ?? []) await this.writeRecord(tx, record);
      await request(store.put({ revision: 1, state: input.state }, "main")); await request(tx.objectStore("migrations").add({ completedAt: Date.now() }, input.migrationId)); return { revision: 1, migrated: true };
    });
  }
  get<T = unknown>(collection: string, id: string): Promise<PersistedRecord<T> | null> { return this.transaction(["records"], "readonly", async tx => (await request<PersistedRecord<T> | undefined>(tx.objectStore("records").get([collection, id]))) ?? null); }
  list<T = unknown>(collection: string): Promise<PersistedRecord<T>[]> { return this.transaction(["records"], "readonly", async tx => (await request<PersistedRecord<T>[]>(tx.objectStore("records").getAll())).filter(r => r.collection === collection).sort((a, b) => a.id.localeCompare(b.id))); }
  listEvents(): Promise<LedgerEvent[]> { return this.transaction(["events"], "readonly", tx => request(tx.objectStore("events").getAll())); }
  listOutbox(limit = 100): Promise<OutboxItem[]> { return this.transaction(["outbox"], "readonly", async tx => (await request<OutboxItem[]>(tx.objectStore("outbox").getAll())).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)).slice(0, Math.min(1000, Math.max(0, limit)))); }
  ackOutbox(ids: string[]): Promise<void> { return this.transaction(["outbox"], "readwrite", async tx => { for (const id of ids) await request(tx.objectStore("outbox").delete(id)); }); }
  audioBegin(clipId: string, metadata: unknown): Promise<AudioManifest> { valid(clipId, "CLIP_ID"); return this.transaction(["audio"], "readwrite", async tx => { const store = tx.objectStore("audio"); const prior = await request<BrowserClip | undefined>(store.get(clipId)); if (prior) { if (canonical(prior.manifest.metadata) !== canonical(metadata)) throw new Error("CLIP_ID_COLLISION"); return prior.manifest; } const manifest: AudioManifest = { clipId, status: "recording", byteLength: 0, nextSequence: 0, durationMs: 0, sampleRate: 16000, channels: 1, metadata }; await request(store.add({ manifest, chunks: [], digests: [] } satisfies BrowserClip, clipId)); return manifest; }); }
  async audioAppend(clipId: string, sequence: number, pcmB64: string): Promise<AudioManifest> {
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error("INVALID_AUDIO_SEQUENCE"); if (pcmB64.length > 1024 * 1024 * 4 / 3 + 8) throw new Error("AUDIO_CHUNK_TOO_LARGE");
    const bytes = fromB64(pcmB64); if (bytes.length > 1024 * 1024) throw new Error("AUDIO_CHUNK_TOO_LARGE"); if (!bytes.length || bytes.length % 2) throw new Error("INVALID_PCM16_LENGTH");
    const digest = toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)));
    return this.transaction(["audio"], "readwrite", async tx => {
      const store = tx.objectStore("audio"); const clip = await request<BrowserClip | undefined>(store.get(clipId)); if (!clip) throw new Error("CLIP_NOT_FOUND"); const m = clip.manifest;
      if (sequence < m.nextSequence) { if (clip.digests[sequence] !== digest) throw new Error("AUDIO_SEQUENCE_COLLISION"); return m; }
      if (m.status !== "recording") throw new Error("AUDIO_NOT_RECORDING"); if (sequence !== m.nextSequence) throw new Error(`AUDIO_SEQUENCE_CONFLICT:${m.nextSequence}`);
      if (m.byteLength + bytes.length > MAX_AUDIO) throw new Error("AUDIO_LENGTH_LIMIT"); m.byteLength += bytes.length; m.nextSequence++; m.durationMs = Math.round(m.byteLength * 1000 / 32000); clip.chunks.push(bytes); clip.digests.push(digest); await request(store.put(clip, clipId)); return m;
    });
  }
  audioFinalize(clipId: string): Promise<AudioManifest> { return this.transaction(["audio"], "readwrite", async tx => { const store = tx.objectStore("audio"); const clip = await request<BrowserClip | undefined>(store.get(clipId)); if (!clip) throw new Error("CLIP_NOT_FOUND"); if (!clip.manifest.byteLength) throw new Error("AUDIO_EMPTY"); clip.manifest.status = "ready"; await request(store.put(clip, clipId)); return clip.manifest; }); }
  audioRead(clipId: string): Promise<AudioRead> { return this.transaction(["audio"], "readonly", async tx => { const clip = await request<BrowserClip | undefined>(tx.objectStore("audio").get(clipId)); if (!clip) throw new Error("CLIP_NOT_FOUND"); if (clip.manifest.status !== "ready") throw new Error(`AUDIO_NOT_READY:${clip.manifest.status}`); return { manifest: clip.manifest, wavB64: toB64(wav(clip.chunks, clip.manifest.byteLength)) }; }); }
  audioManifest(clipId: string): Promise<AudioManifest | null> { return this.transaction(["audio"], "readonly", async tx => (await request<BrowserClip | undefined>(tx.objectStore("audio").get(clipId)))?.manifest ?? null); }
  audioDelete(clipId: string): Promise<void> { return this.transaction(["audio"], "readwrite", async tx => { await request(tx.objectStore("audio").delete(clipId)); }); }
  async recoverAudio(): Promise<void> { await this.transaction(["audio"], "readwrite", async tx => { const store = tx.objectStore("audio"); const clips = await request<BrowserClip[]>(store.getAll()); for (const clip of clips) if (clip.manifest.status === "recording") { clip.manifest.status = "interrupted"; await request(store.put(clip, clip.manifest.clipId)); } }); }
  close(): void { this.db.close(); }
}
const browserInitializations = new Map<string, Promise<void>>();
export async function createPersistence(identity: string): Promise<Repository> {
  valid(identity, "IDENTITY");
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) { const native = new NativeRepository(identity); await native.initialize(); return native; }
  if (typeof indexedDB === "undefined") throw new Error("DURABLE_STORAGE_UNAVAILABLE: IndexedDB is required");
  // Encoding is reversible but path safe; native uses SHA256. Identity is not a secret.
  const key = encodeURIComponent(identity);
  const opening = indexedDB.open(`ita.profile.v1.${key}`, 1);
  opening.onupgradeneeded = () => { for (const name of STORES) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name); };
  const db = await request(opening); db.onversionchange = () => db.close();
  const repo = new BrowserRepository(identity, db);
  let initialization = browserInitializations.get(key);
  if (!initialization) {
    initialization = repo.recoverAudio();
    browserInitializations.set(key, initialization);
  }
  try { await initialization; return repo; } catch (error) { browserInitializations.delete(key); repo.close(); throw error; }
}
