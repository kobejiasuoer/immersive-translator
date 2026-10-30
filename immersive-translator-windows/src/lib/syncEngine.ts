/**
 * 云同步协议引擎（升级计划 A0）：拉取游标推进、LWW 合并、409/429/413 处置。
 *
 * 与服务端 M4 协议（apps/api/src/modules/sync/sync-protocol.ts）对齐的关键语义：
 * - `since` 是版本号游标（非时间戳），版本号空间**跨集合共享**——每集合各存各的
 *   cursor；追平判据是 `hasMore === false`，不是 cursor === serverVersion。
 * - 首次全量（since=0）时 tombstone 也会下发，必须按 deleted:true 落地删除。
 * - push 409 整批原子拒绝：批次是重试单元；`server === null` 表示服务端从未
 *   见过该实体（baseVersion 0 重推）；有快照则 LWW——本地 updatedAt 更新则携
 *   serverVersion 重推，否则（含相等，server-wins 防乒乓）采纳服务端。
 * - updatedAt 是客户端逻辑时间，服务端只透传——LWW 完全依赖两端时钟可信。
 * - 单实体 payload ≤ 512KB，字节口径与服务端一致：JSON.stringify(payload) 的
 *   UTF-8 长度（tombstone 计 0）。
 * - pull/push 共用 per-user 120/min 限流桶：429 按 retryAfterSeconds 退避，最多等 3 次。
 *
 * 分层：传输与持久化经 lib/tauriBridge.ts（Rust 附带鉴权 + 本地存储原语），
 * 本文件只做协议决策——全部逻辑可用 mock 桥单测覆盖。
 */

import {
  syncPull,
  syncPush,
  syncStoreCursorGet,
  syncStoreCursorSet,
  syncStoreList,
  syncStorePut,
  syncStoreReplace,
  learningNamespace,
  type StoredSyncEntity,
  type SyncHttpText,
} from "./tauriBridge";
import { canonicalJson } from "../../../packages/learning-core/src/reviewEvents";
import { mergePracticePayload } from "../../../packages/learning-core/src/practiceMerge";

// ---------------------------------------------------------------------------
// 线路类型（服务端 sync-protocol.ts 的 TS 镜像）
// ---------------------------------------------------------------------------

/** 服务端下发的实体形态。updatedAt 是 ISO 字符串；payload 活实体非 null、
 *  tombstone 为 null。 */
export interface WireEntity {
  id: string;
  version: number;
  updatedAt: string;
  deleted: boolean;
  schemaVersion: number;
  originDevice: string | null;
  payload: unknown;
}

export interface PullPage {
  collection: string;
  serverVersion: number;
  cursor: number;
  hasMore: boolean;
  entities: WireEntity[];
}

export interface PushOk {
  collection: string;
  serverVersion: number;
  results: { id: string; status: "accepted"; version: number }[];
}

export interface SyncConflictEntry {
  reason?:string;
  id: string;
  serverVersion: number;
  server: WireEntity | null;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 常量（与服务端 SYNC_* 对齐）
// ---------------------------------------------------------------------------

const PULL_PAGE_LIMIT = 500;
const PUSH_BATCH = 200;
const MAX_ENTITY_BYTES = 512 * 1024;
/** 拉取页数上限（400 页 × 500 = 20 万实体，防异常服务端把客户端拖死）。 */
const MAX_PULL_PAGES = 400;
/** 409 冲突后整批重推的最大轮数。 */
const MAX_CONFLICT_ROUNDS = 3;
/** 429 退避等待的最大次数（超过则本次同步失败，下次再试）。 */
const MAX_RATE_LIMIT_WAITS = 3;
const ORIGIN_DEVICE = "windows";
export interface SyncOptions { namespace?:string; maxEntityBytes?:number; maxPushEntities?:number; maxPullLimit?:number; maxBodyBytes?:number; schemaVersions?:number[] }
let activeOptions:SyncOptions={};
const positiveLimit=(value:number|undefined,fallback:number)=>Number.isSafeInteger(value)&&Number(value)>0?Number(value):fallback;

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface SyncEntitySkip {
  id: string;
  reason: string;
}

export interface SyncSummary {
  ok: boolean;
  /** 拉取到的实体数（含 tombstone） */
  pulled: number;
  /** 采纳服务端版本的实体数 */
  appliedRemote: number;
  /** 本地较新而保留待推的实体数 */
  keptLocal: number;
  /** push accepted 的实体数 */
  pushed: number;
  /** 409 冲突处理次数 */
  conflicts: number;
  /** 无法推送被跳过的实体（超限/无 payload 等，保留本地） */
  skipped: SyncEntitySkip[];
  /** 失败原因（ok=false 时非空） */
  error: string | null;
}

function emptySummary(): SyncSummary {
  return {
    ok: true,
    pulled: 0,
    appliedRemote: 0,
    keptLocal: 0,
    pushed: 0,
    conflicts: 0,
    skipped: [],
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function parseBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorOf(res: SyncHttpText): { code: string; message: string; details: Record<string, unknown> } {
  const body = parseBody(res.body) as ErrorBody & Record<string, unknown>;
  const err = body.error ?? {};
  return {
    code: typeof err.code === "string" ? err.code : "unknown",
    message: typeof err.message === "string" ? err.message : `HTTP ${res.status}`,
    details: (err.details as Record<string, unknown>) ?? {},
  };
}

const encoder = new TextEncoder();

/** 单实体字节数（服务端口径：JSON.stringify(payload) 的 UTF-8 长度；tombstone 计 0）。 */
export function entityPayloadBytes(entity: StoredSyncEntity): number {
  if (entity.deleted) return 0;
  return encoder.encode(JSON.stringify(entity.payload ?? null)).length;
}

function wireToStored(wire: WireEntity): StoredSyncEntity {
  return {
    id: wire.id,
    baseVersion: wire.version,
    updatedAt: Date.parse(wire.updatedAt),
    deleted: wire.deleted,
    schemaVersion: wire.schemaVersion,
    originDevice: wire.originDevice ?? undefined,
    payload: wire.deleted ? undefined : wire.payload,
    dirty: false,
  };
}

function practiceEntity(local: StoredSyncEntity | undefined, incoming: StoredSyncEntity): StoredSyncEntity | null {
  if (!local) return null;
  const task = (value: unknown) => Boolean(value && typeof value === "object" && (value as Record<string, unknown>).kind === "practice-task");
  if (!task(local.payload) && !task(incoming.payload)) return null;
  // A task removal is terminal for its ID; creating a new task uses a new ID.
  if (incoming.deleted) return incoming;
  if (local.deleted) return { ...local, baseVersion: incoming.baseVersion, dirty: true };
  const payload = mergePracticePayload(local.payload, incoming.payload);
  if (!payload) return null;
  return { ...incoming, payload, updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    dirty: incoming.dirty || canonicalJson(payload) !== canonicalJson(incoming.payload) };
}

function storedToWire(entity: StoredSyncEntity): unknown {
  return {
    id: entity.id,
    baseVersion: entity.baseVersion,
    updatedAt: new Date(entity.updatedAt).toISOString(),
    deleted: entity.deleted,
    schemaVersion: entity.schemaVersion,
    originDevice: entity.originDevice ?? ORIGIN_DEVICE,
    payload: entity.deleted ? null : (entity.payload ?? null),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 退避时长：优先响应头换算（秒），其次 body details.retryAfterMs。 */
function waitMsFor(res: SyncHttpText): number {
  if (res.retryAfterSeconds !== null && res.retryAfterSeconds > 0) {
    return Math.min(res.retryAfterSeconds * 1000, 15_000);
  }
  const details = errorOf(res).details;
  const retryAfterMs = details["retryAfterMs"];
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 15_000);
  }
  return 1_000;
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

async function pullAll(collection: string, summary: SyncSummary): Promise<void> {
  let cursor = await syncStoreCursorGet(collection,activeNamespace);
  let fullSnapshot: StoredSyncEntity[] | null = cursor===0 ? [] : null;
  let rateLimitWaits = 0;
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const res = await syncPull(collection, cursor, Math.min(PULL_PAGE_LIMIT,positiveLimit(activeOptions.maxPullLimit,PULL_PAGE_LIMIT)),activeNamespace);
    if (res.status === 200) {
      const data = parseBody(res.body) as unknown as PullPage;
      if (!Array.isArray(data.entities) || !Number.isSafeInteger(data.cursor) || data.cursor < cursor || typeof data.hasMore !== "boolean") throw new Error("同步拉取响应无效");
      if (data.hasMore && data.cursor === cursor) throw new Error("同步游标未推进");
      if (fullSnapshot) {
        fullSnapshot.push(...data.entities.map(wireToStored));
        summary.pulled += data.entities.length;
        cursor = data.cursor;
        if (!data.hasMore) {
          const latest = new Map((await syncStoreList(collection, activeNamespace)).map(e => [e.id, e]));
          const snapshot = fullSnapshot.map(e => collection === "speak-sessions" ? practiceEntity(latest.get(e.id), e) ?? e : e);
          await syncStoreReplace(collection, snapshot, cursor,activeNamespace); summary.appliedRemote += snapshot.length; return;
        }
        continue;
      }
      const local = new Map(
        (await syncStoreList(collection,activeNamespace)).map((e) => [e.id, e] as const),
      );
      const updates: StoredSyncEntity[] = [];
      for (const wire of data.entities) {
        summary.pulled += 1;
        const existing = local.get(wire.id);
        const wireMs = Date.parse(wire.updatedAt);
        const merged = collection === "speak-sessions" ? practiceEntity(existing, wireToStored(wire)) : null;
        if (merged) {
          local.set(wire.id, merged);
          if (merged.dirty) summary.keptLocal += 1; else summary.appliedRemote += 1;
        } else if (existing && existing.dirty && existing.updatedAt > wireMs) {
          // 本地有未推送的更新且更新：保留本地内容，只吸收服务端版本号
          local.set(wire.id, { ...existing, baseVersion: wire.version });
          summary.keptLocal += 1;
        } else {
          local.set(wire.id, wireToStored(wire));
          summary.appliedRemote += 1;
        }
        updates.push(local.get(wire.id) as StoredSyncEntity);
      }
      if (updates.length > 0) {
        await syncStorePut(collection, updates,activeNamespace);
      }
      cursor = data.cursor;
      await syncStoreCursorSet(collection, cursor,activeNamespace);
      if (!data.hasMore) return;
      continue;
    }
    if (res.status === 429) {
      rateLimitWaits += 1;
      if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
        throw new Error("同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试");
      }
      await sleep(waitMsFor(res));
      page -= 1; // 退避后重试同一页
      continue;
    }
    const err = errorOf(res);
    if (err.code === "stale_cursor" || err.code === "staleCursor") {
      if (fullSnapshot && cursor===0) throw new Error("全量同步期间游标再次失效");
      fullSnapshot = []; cursor = 0; continue;
    }
    throw new Error(`同步拉取失败（HTTP ${res.status} ${err.code}）：${err.message}`);
  }
  throw new Error(`同步拉取页数超过 ${MAX_PULL_PAGES}，中止（服务端数据异常）`);
}

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------

async function pushDirty(collection: string, summary: SyncSummary): Promise<void> {
  const all = await syncStoreList(collection,activeNamespace);
  const pushable: StoredSyncEntity[] = [];
  for (const entity of all) {
    if (!entity.dirty) continue;
    if (!entity.deleted && (entity.payload === undefined || entity.payload === null)) {
      summary.skipped.push({ id: entity.id, reason: "活实体缺少 payload，无法推送" });
      continue;
    }
    if(activeOptions.schemaVersions&&!activeOptions.schemaVersions.includes(entity.schemaVersion)){summary.skipped.push({id:entity.id,reason:`服务端不支持 schemaVersion ${entity.schemaVersion}，完整记录保留在本机`});continue;}
    const maxBytes=positiveLimit(activeOptions.maxEntityBytes,collection==="speak-sessions"||collection==="speak-assessments"?65536:MAX_ENTITY_BYTES);
    if (entityPayloadBytes(entity) > maxBytes) {
      summary.skipped.push({
        id: entity.id,
        reason: `payload 超过 ${maxBytes} 字节上限（${entityPayloadBytes(entity)} 字节），完整记录保留在本机`,
      });
      continue;
    }
    pushable.push(entity);
  }
  if (pushable.length === 0) return;

  const batchLimit=Math.min(PUSH_BATCH,positiveLimit(activeOptions.maxPushEntities,PUSH_BATCH));
  const bodyLimit=positiveLimit(activeOptions.maxBodyBytes,2*1024*1024);let batch:StoredSyncEntity[]=[];
  for(const entity of pushable){
    const candidate=[...batch,entity];
    if(batch.length&&(candidate.length>batchLimit||encoder.encode(JSON.stringify({entities:candidate.map(storedToWire)})).length>bodyLimit)){await pushBatch(collection,batch,summary);batch=[];}
    if(encoder.encode(JSON.stringify({entities:[storedToWire(entity)]})).length>bodyLimit){summary.skipped.push({id:entity.id,reason:"实体连同同步信封超过请求容量，完整记录保留在本机"});continue;}
    batch.push(entity);
  }
  if(batch.length)await pushBatch(collection,batch,summary);
}

async function pushBatch(
  collection: string,
  batch: StoredSyncEntity[],
  summary: SyncSummary,
): Promise<void> {
  let pending = batch;
  let rateLimitWaits = 0;
  for (let round = 0; round < MAX_CONFLICT_ROUNDS; round += 1) {
    const res = await syncPush(
      collection,
      JSON.stringify({ entities: pending.map(storedToWire) }),activeNamespace,
    );
    if (res.status === 200) {
      const data = parseBody(res.body) as unknown as PushOk;
      const byVersion = new Map(data.results.map((r) => [r.id, r.version] as const));
      const current = new Map((await syncStoreList(collection,activeNamespace)).map(e=>[e.id,e]));
      const cleared = pending.map((e) => {
        const latest = current.get(e.id);
        // A response to an older push must never erase a concurrent local edit.
        const changed = latest && (latest.updatedAt !== e.updatedAt || JSON.stringify(latest.payload) !== JSON.stringify(e.payload) || latest.deleted !== e.deleted);
        return { ...(changed ? latest : e), baseVersion: byVersion.get(e.id) ?? e.baseVersion, dirty: !!changed };
      });
      await syncStorePut(collection, cleared,activeNamespace);
      summary.pushed += cleared.length;
      return;
    }
    if (res.status === 409) {
      summary.conflicts += 1;
      const details = errorOf(res).details;
      const conflicts = (details["conflicts"] as SyncConflictEntry[] | undefined) ?? [];
      if(conflicts.some(c=>c.reason==="immutable_entity"))throw new Error("不可变学习记录冲突，已保留本地待同步数据");
      const byId = new Map<string, StoredSyncEntity>(
        pending.map((e): [string, StoredSyncEntity] => [e.id, { ...e }]),
      );
      const latest = new Map((await syncStoreList(collection, activeNamespace)).map(e => [e.id, e]));
      const adopted: StoredSyncEntity[] = [];
      for (const conflict of conflicts) {
        const queued = byId.get(conflict.id);
        const local = latest.get(conflict.id) ?? queued;
        if (!local) continue;
        byId.set(conflict.id, { ...local });
        if (!conflict.server) {
          // 幽灵实体：服务端从未见过（本地 baseVersion 记忆错误）→ 0 重推
          byId.set(conflict.id, { ...local, baseVersion: 0 });
          continue;
        }
        const merged = collection === "speak-sessions" ? practiceEntity(local, wireToStored(conflict.server)) : null;
        if (merged) {
          merged.baseVersion = conflict.serverVersion;
          byId.set(conflict.id, merged); adopted.push(merged); continue;
        }
        const serverMs = Date.parse(conflict.server.updatedAt);
        if (local.updatedAt > serverMs) {
          // 本地较新：携新 baseVersion 重推
          byId.set(conflict.id, { ...local, baseVersion: conflict.serverVersion });
        } else {
          // 服务端较新或相等（相等取服务端，防乒乓）：采纳服务端快照
          const adoptedEntity = wireToStored(conflict.server);
          byId.set(conflict.id, adoptedEntity);
          adopted.push(adoptedEntity);
        }
      }
      if (adopted.length > 0) {
        await syncStorePut(collection, adopted,activeNamespace);
        summary.appliedRemote += adopted.length;
      }
      pending = [...byId.values()].filter((e) => e.dirty);
      if (pending.length === 0) return;
      continue; // 整批原子拒绝：携修正后的 baseVersion 重推
    }
    if (res.status === 429) {
      rateLimitWaits += 1;
      if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
        throw new Error("同步推送被限流（429），已等待 3 次仍未通过，请稍后再试");
      }
      await sleep(waitMsFor(res));
      round -= 1; // 退避后重试同批
      continue;
    }
    if (res.status === 413) {
      const err = errorOf(res);
      if (err.code === "payload_too_large") {
        // 该实体超限（预检口径与服务端有偏差时兜底）：剔除后重推其余
        const entityId = err.details["entityId"];
        if (typeof entityId === "string") {
          summary.skipped.push({ id: entityId, reason: "服务端判定 payload 超限" });
          pending = pending.filter((e) => e.id !== entityId);
          if (pending.length === 0) return;
          round -= 1;
          continue;
        }
      }
      throw new Error(`同步推送超限（HTTP 413 ${err.code}）：${err.message}`);
    }
    const err = errorOf(res);
    throw new Error(`同步推送失败（HTTP ${res.status} ${err.code}）：${err.message}`);
  }
  summary.skipped.push(
    ...pending.map((e) => ({ id: e.id, reason: `冲突 ${MAX_CONFLICT_ROUNDS} 轮未收敛，留待下次同步` })),
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 对一个集合做一次完整的双向同步：先拉取（应用服务端变更 + 推进游标），
 *  再推送本地 dirty 实体（含新建/修改/软删除）。失败不抛——汇总带回错误，
 *  调用方（UI）据此展示；已落地的部分保留，下次同步续传。 */
let activeNamespace:string|undefined;
let queue:Promise<unknown>=Promise.resolve();
export function syncNow(collection:string,options:SyncOptions={}):Promise<SyncSummary>{
  const run=queue.then(async()=>{activeNamespace=options.namespace??await learningNamespace();activeOptions=options;try{if(activeNamespace!==await learningNamespace())throw new Error("账号已切换，本次同步已取消");return await runSync(collection);}finally{activeNamespace=undefined;activeOptions={};}});
  queue=run.catch(()=>undefined);return run.catch(error=>({...emptySummary(),ok:false,error:error instanceof Error?error.message:String(error)}));
}
async function runSync(collection: string): Promise<SyncSummary> {
  const summary = emptySummary();
  try {
    await pullAll(collection, summary);
    await pushDirty(collection, summary);
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
  }
  return summary;
}
