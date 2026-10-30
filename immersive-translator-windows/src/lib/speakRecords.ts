/**
 * 口语记录云同步记录层（2026-10-28 决策：记录跟账号走，语音偏好/音频不入云）。
 *
 * 两个新同步集合，复用既有 syncEngine/tauriBridge 管线（协议零新增，Rust
 * sync.rs 的 LOCAL_COLLECTIONS 白名单需含集合名）：
 * - speak-sessions：保留完整文字、提示、上下文、表达建议和发音报告，
 *   供另一设备按保存步骤续练；仅剥离音频字节和源设备私有路径。
 * - speak-assessments：跟读/发音评测记录。{id, source, lang, refText,
 *   total/accuracy/fluency/standard, words[{w,s}], sessionId?, at}；source：
 *   reader=阅读室跟读、review=复习、coach=口语陪练（含只练差词）；words 是
 *   逐词精简结果（可截断），**录音/base64 音频字段禁止出现在任何 push 载荷**。
 *
 * 体量护栏（与服务端 SYNC_COLLECTION_MAX_BYTES 对齐，见 docs/api.md M4）：
 * - 单条同步 ≤64KB：超限完整会话仍保留本机并明确提示，不裁真实尝试。
 *   旧独立评测列表继续采用64词/1000字摘要；练习attempt保留完整评测。
 * - 每用户每集合滚动保留最近 500 条：入队时超出部分本地转 tombstone（删除
 *   随同步传播到其他端；tombstone 计 0 字节并释放配额，服务端不拒收）。
 *
 * 游客（未登录）：入队/裁剪是纯本地 IPC（sync_store_put/list），零网络请求；
 * 触发同步前先查 auth_get_status，未登录直接跳过——记录仅本地，无任何登录墙。
 */

import type { PronunciationResult } from "../core/pronunciation";
import type { SpeakDifficulty, SpeakSession } from "../core/speakLogic";
import { syncNow, type SyncSummary } from "./syncEngine";
import { authGetStatus, syncStoreList, syncStorePut, type StoredSyncEntity } from "./tauriBridge";
import { withoutAudio, mergeRelayPayload } from "../../../packages/learning-core/src/relay";

/** 口语对话记录集合名（服务端 SYNC_COLLECTIONS / Rust LOCAL_COLLECTIONS 同名）。 */
export const SPEAK_SESSIONS_COLLECTION = "speak-sessions";
/** 跟读评测记录集合名。 */
export const SPEAK_ASSESSMENTS_COLLECTION = "speak-assessments";

/** 单条记录体积上限（字节）：与服务端 SYNC_COLLECTION_MAX_BYTES 一致。 */
export const SPEAK_RECORD_MAX_BYTES = 64 * 1024;
/** 每集合滚动保留条数（超出本地裁剪：最旧条目转 tombstone）。 */
export const SPEAK_RECORD_MAX_LIVE = 500;
/** 评测记录逐词精简结果的最大词数（超出丢尾）。 */
export const ASSESS_MAX_WORDS = 64;
/** 旧独立评测摘要参考文本上限；完整会话文字不适用。 */
export const TEXT_MAX_CHARS = 1000;

// ---------------------------------------------------------------------------
// speak-sessions：会话精简记录
// ---------------------------------------------------------------------------

/** 对话轮次的最小公共字段；实际载荷保留完整反馈和未知业务字段。 */
export interface SpeakSessionTurnRecord {
  role: "user" | "assistant";
  text: string;
  at: number;
}

/** 口语对话记录（SpeakSession 的同步投影）。startedAt=createdAt、endedAt=updatedAt。 */
export interface SpeakSessionRecord {
  [key:string]:unknown;
  id: string;
  scenario: string;
  difficulty: SpeakDifficulty;
  startedAt: number;
  endedAt: number;
  turns: SpeakSessionTurnRecord[];
}

const encoder = new TextEncoder();

function jsonBytes(v: unknown): number {
  return encoder.encode(JSON.stringify(v)).length;
}

/** Preserve feedback and source snapshots. Oversize records stay local; never discard attempts. */
export function sessionRecordFrom(s: SpeakSession): SpeakSessionRecord {
  const record = {
    ...(withoutAudio(s) as object),
    v:2,
    id: s.id,
    scenario: s.scenario,
    difficulty: s.difficulty,
    startedAt: s.createdAt,
    endedAt: s.updatedAt,
    turns:s.turns.map(t=>withoutAudio(t)),
  };
  if(jsonBytes(record)>SPEAK_RECORD_MAX_BYTES) throw new Error("口语记录超过 64KB 同步上限，完整记录仍保留在本机，请分段练习后再同步");
  return record as SpeakSessionRecord;
}

/** 云端记录恢复完整会话，兼容旧最小投影。 */
export function sessionFromRecord(r: SpeakSessionRecord): SpeakSession {
  return {
    ...r,
    id: r.id,
    scenario: r.scenario,
    difficulty: r.difficulty,
    turns: r.turns.map((t) => ({ ...t })),
    createdAt: r.startedAt,
    updatedAt: Math.max(r.startedAt, r.endedAt),
  };
}

/** 运行时形状守卫（同步数据进门校验，脏行整条丢弃——feedStore 范式）。 */
export function isSpeakSessionRecordLike(v: unknown): v is SpeakSessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    typeof r.scenario !== "string" ||
    (r.difficulty !== "easy" && r.difficulty !== "medium" && r.difficulty !== "hard") ||
    typeof r.startedAt !== "number" ||
    !Number.isFinite(r.startedAt) ||
    typeof r.endedAt !== "number" ||
    !Number.isFinite(r.endedAt) ||
    !Array.isArray(r.turns)
  ) {
    return false;
  }
  return r.turns.every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      ((t as Record<string, unknown>).role === "user" ||
        (t as Record<string, unknown>).role === "assistant") &&
      typeof (t as Record<string, unknown>).text === "string" &&
      typeof (t as Record<string, unknown>).at === "number",
  );
}

// ---------------------------------------------------------------------------
// speak-assessments：评测记录
// ---------------------------------------------------------------------------

export type SpeakAssessmentSource = "reader" | "review" | "coach";

/** 逐词精简结果：词面 + 得分（丢音节/音素明细，可截断）。 */
export interface SpeakAssessmentWord {
  w: string;
  s: number;
}

/** 跟读/发音评测记录（评分摘要 + 逐词精简；音频永不上云）。 */
export interface SpeakAssessmentRecord {
  id: string;
  source: SpeakAssessmentSource;
  lang: string;
  refText: string;
  total: number;
  accuracy: number;
  fluency: number;
  standard: number;
  words: SpeakAssessmentWord[];
  /** coach 来源关联的会话 id（reader/review 来源缺省）。 */
  sessionId?: string;
  at: number;
}

export interface AssessmentInput {
  result: PronunciationResult;
  source: SpeakAssessmentSource;
  refText: string;
  sessionId?: string;
  lang?: string;
  now?: number;
}

/** 评测结果 → 精简记录：四分摘要 + 逐词 {词面,得分}（截 64 个）、参考文本截 1000 字。 */
export function assessmentRecordFrom(input: AssessmentInput): SpeakAssessmentRecord {
  const { result, source, refText } = input;
  const at = input.now ?? Date.now();
  const words: SpeakAssessmentWord[] = result.words
    .map((w) => ({ w: w.content.slice(0, 64), s: w.totalScore }))
    .slice(0, ASSESS_MAX_WORDS);
  return {
    // 会话 id 同款风格：前缀 + 时间 36 进制 + 随机尾
    id: `sa${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    source,
    lang: input.lang ?? "en",
    refText: refText.slice(0, TEXT_MAX_CHARS),
    total: result.total,
    accuracy: result.accuracy,
    fluency: result.fluency,
    standard: result.standard,
    words,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    at,
  };
}

/** 运行时形状守卫（脏行整条丢弃）。 */
export function isSpeakAssessmentRecordLike(v: unknown): v is SpeakAssessmentRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    (r.source !== "reader" && r.source !== "review" && r.source !== "coach") ||
    typeof r.lang !== "string" ||
    typeof r.refText !== "string" ||
    ![r.total, r.accuracy, r.fluency, r.standard].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    ) ||
    !Array.isArray(r.words) ||
    typeof r.at !== "number"
  ) {
    return false;
  }
  return r.words.every(
    (w) =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as Record<string, unknown>).w === "string" &&
      typeof (w as Record<string, unknown>).s === "number",
  );
}

// ---------------------------------------------------------------------------
// 入队（本地写 + dirty）/ 滚动裁剪 / tombstone 删除
// ---------------------------------------------------------------------------

/** 活实体超出的最旧部分 → tombstone 批次（保留 baseVersion，payload 置空，
 *  updatedAt 取裁剪时刻——晚于被裁记录的逻辑时间，LWW 下删除可传播）。 */
export function overflowTombstones(
  live: StoredSyncEntity[],
  now: number,
): StoredSyncEntity[] {
  if (live.length < SPEAK_RECORD_MAX_LIVE) return [];
  const sorted = [...live].sort((a, b) => a.updatedAt - b.updatedAt); // 旧 → 新
  return sorted.slice(0, live.length - SPEAK_RECORD_MAX_LIVE + 1).map((e) => ({
    id: e.id,
    baseVersion: e.baseVersion,
    updatedAt: Math.max(now, e.updatedAt + 1),
    deleted: true,
    schemaVersion: e.schemaVersion,
    originDevice: e.originDevice,
    payload: undefined,
    dirty: true,
  }));
}

async function enqueueRecord(
  collection: string,
  item: { id: string; updatedAt: number; payload: unknown },
): Promise<void> {
  const stored = await syncStoreList(collection);
  const existing = stored.find((e) => e.id === item.id);
  const entity: StoredSyncEntity = {
    id: item.id,
    baseVersion: existing?.baseVersion ?? 0, // 已同步过则沿用，避免无谓 409
    updatedAt: item.updatedAt,
    deleted: false,
    schemaVersion: Math.max(2,existing?.schemaVersion??0),
    originDevice: "windows",
    payload: withoutAudio(mergeRelayPayload(existing?.payload,item.payload as Record<string,unknown>)),
    dirty: true,
  };
  // 滚动裁剪：入队后活实体数 ≤ 500（新实体自身不参与裁剪候选）
  const tombstones = overflowTombstones(
    stored.filter((e) => !e.deleted && e.id !== item.id),
    item.updatedAt,
  );
  await syncStorePut(collection, tombstones.length > 0 ? [entity, ...tombstones] : [entity]);
}

/** 会话记录入队（SpeakView.persist 漏斗调用；LWW 时钟 = 会话 updatedAt）。 */
export async function enqueueSessionRecord(session: SpeakSession): Promise<void> {
  const record = sessionRecordFrom(session);
  await enqueueRecord(SPEAK_SESSIONS_COLLECTION, {
    id: record.id,
    updatedAt: record.endedAt,
    payload: record,
  });
}

/** 评测记录入队（每次评测一条新实体，永不更新）。 */
export async function enqueueAssessment(input: AssessmentInput): Promise<void> {
  const record = assessmentRecordFrom(input);
  await enqueueRecord(SPEAK_ASSESSMENTS_COLLECTION, {
    id: record.id,
    updatedAt: record.at,
    payload: record,
  });
}

/** 组件侧 fire-and-forget 入口（静默；本地写失败不影响对话/评测流程）。 */
export function enqueueSessionRecordSilently(session: SpeakSession): void {
  void enqueueSessionRecord(session).catch(() => undefined);
}

/** 组件侧 fire-and-forget 入口（同上）。 */
export function recordAssessmentSilently(input: AssessmentInput): void {
  void enqueueAssessment(input).catch(() => undefined);
}

/** 删除走 tombstone（payload 置空、保留 baseVersion；删除随同步传播到其他端）。
 *  返回是否发生了状态变化（本就无实体/已是 tombstone 则 false）。 */
export async function deleteSessionRecord(id: string, now = Date.now()): Promise<boolean> {
  return tombstoneRecord(SPEAK_SESSIONS_COLLECTION, id, now);
}

export async function deleteAssessmentRecord(id: string, now = Date.now()): Promise<boolean> {
  return tombstoneRecord(SPEAK_ASSESSMENTS_COLLECTION, id, now);
}

async function tombstoneRecord(collection: string, id: string, now: number): Promise<boolean> {
  const stored = await syncStoreList(collection);
  const existing = stored.find((e) => e.id === id);
  if (!existing || existing.deleted) return false;
  await syncStorePut(collection, [
    {
      id,
      baseVersion: existing.baseVersion,
      updatedAt: Math.max(now, existing.updatedAt + 1),
      deleted: true,
      schemaVersion: existing.schemaVersion,
      originDevice: existing.originDevice,
      payload: undefined,
      dirty: true,
    },
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// 读取 / 展示合并 / 静默同步
// ---------------------------------------------------------------------------

/** 集合内全部记录（tombstone 与形状不符的脏行丢弃；updatedAt 倒序）。 */
export async function listSessionRecords(): Promise<SpeakSessionRecord[]> {
  const stored = await syncStoreList(SPEAK_SESSIONS_COLLECTION).catch(
    () => [] as StoredSyncEntity[],
  );
  return stored
    .filter((e) => !e.deleted && isSpeakSessionRecordLike(e.payload))
    .map((e) => e.payload as SpeakSessionRecord);
}

export async function listAssessmentRecords(): Promise<SpeakAssessmentRecord[]> {
  const stored = await syncStoreList(SPEAK_ASSESSMENTS_COLLECTION).catch(
    () => [] as StoredSyncEntity[],
  );
  return stored
    .filter((e) => !e.deleted && isSpeakAssessmentRecordLike(e.payload))
    .map((e) => e.payload as SpeakAssessmentRecord);
}

/** 会话列表展示合并：云端精简记录与本地富会话按 id 合并——本地 updatedAt
 *  较新或**相等**时保留本地富会话（同 id 的超集），云端较新（别端续聊过）
 *  则用云端精简版；返回 updatedAt 倒序。 */
export function mergeSessionsWithRecords(
  local: SpeakSession[],
  records: SpeakSessionRecord[],
): SpeakSession[] {
  const byId = new Map<string, SpeakSession>();
  for (const r of records) if(r.kind!=="practice-task") byId.set(r.id, sessionFromRecord(r));
  for (const s of local) {
    if((s as SpeakSession & {kind?:string}).kind==="practice-task")continue;
    const cloud = byId.get(s.id);
    if (!cloud || s.updatedAt >= cloud.updatedAt) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 静默双向同步两个记录集合（SpeakView 挂载时调用）：未登录直接跳过
 *  （零网络请求），失败只汇总不抛——同步静默，失败不打扰。 */
export async function syncSpeakRecordsSilently(): Promise<SyncSummary[]> {
  try {
    const status = await authGetStatus();
    if (!status.loggedIn) return [];
  } catch {
    return []; // 状态读取失败（桥不可用等）：宁可不同步也不出网
  }
  const summaries: SyncSummary[] = [];
  for (const collection of [SPEAK_SESSIONS_COLLECTION, SPEAK_ASSESSMENTS_COLLECTION]) {
    summaries.push(await syncNow(collection)); // syncNow 不抛，错误在 summary.error
  }
  return summaries;
}
