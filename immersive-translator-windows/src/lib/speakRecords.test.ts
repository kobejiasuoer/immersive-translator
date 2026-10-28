/**
 * speakRecords 记录层单测（mock ./tauriBridge，先例 syncEngine.test.ts）：
 * 覆盖 schema 往返与形状守卫、64KB 截断、500 条滚动裁剪（tombstone）、
 * tombstone 删除、多端展示合并（最后写入胜出）、B 端首拉、游客零网络请求。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authGetStatus,
  syncPull,
  syncPush,
  syncStoreList,
  syncStorePut,
  type StoredSyncEntity,
  type SyncHttpText,
} from "./tauriBridge";
import {
  ASSESS_MAX_WORDS,
  SPEAK_ASSESSMENTS_COLLECTION,
  SPEAK_RECORD_MAX_BYTES,
  SPEAK_RECORD_MAX_LIVE,
  SPEAK_SESSIONS_COLLECTION,
  TEXT_MAX_CHARS,
  assessmentRecordFrom,
  deleteSessionRecord,
  enqueueAssessment,
  enqueueSessionRecord,
  isSpeakAssessmentRecordLike,
  isSpeakSessionRecordLike,
  listAssessmentRecords,
  listSessionRecords,
  mergeSessionsWithRecords,
  sessionFromRecord,
  sessionRecordFrom,
  syncSpeakRecordsSilently,
} from "./speakRecords";
import type { SpeakSession } from "../core/speakLogic";
import type { PronunciationResult } from "../core/pronunciation";
import type { WireEntity } from "./syncEngine";

vi.mock("./tauriBridge", () => ({
  authGetStatus: vi.fn(),
  syncPull: vi.fn(),
  syncPush: vi.fn(),
  syncStoreCursorGet: vi.fn(),
  syncStoreCursorSet: vi.fn(),
  syncStoreList: vi.fn(),
  syncStorePut: vi.fn(),
}));

const ok = (body: unknown): SyncHttpText => ({
  status: 200,
  body: JSON.stringify(body),
  retryAfterSeconds: null,
});

function wire(
  id: string,
  version: number,
  updatedAtMs: number,
  payload: unknown,
): WireEntity {
  return {
    id,
    version,
    updatedAt: new Date(updatedAtMs).toISOString(),
    deleted: false,
    schemaVersion: 1,
    originDevice: "mac",
    payload,
  };
}

/** 内存态测试台：按集合分桶模拟 Rust sync_store_*。 */
let store: Map<string, Map<string, StoredSyncEntity>>;
let pullQueue: Array<(args: { collection: string; since: number }) => SyncHttpText>;
let pushQueue: Array<(batch: { entities: { id: string; baseVersion: number }[] }) => SyncHttpText>;
let pushCalls: { entities: { id: string; baseVersion: number; deleted: boolean; payload: unknown }[] }[];

function bucket(collection: string): Map<string, StoredSyncEntity> {
  let b = store.get(collection);
  if (!b) {
    b = new Map();
    store.set(collection, b);
  }
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  pullQueue = [];
  pushQueue = [];
  pushCalls = [];

  vi.mocked(syncStoreList).mockImplementation(async (collection) =>
    [...bucket(collection).values()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  vi.mocked(syncStorePut).mockImplementation(async (collection, entities) => {
    for (const e of entities) bucket(collection).set(e.id, e);
  });
  vi.mocked(syncPull).mockImplementation(async (collection, since) => {
    const next = pullQueue.shift();
    return next ? next({ collection, since }) : ok({ collection, serverVersion: 0, cursor: since, hasMore: false, entities: [] });
  });
  vi.mocked(syncPush).mockImplementation(async (_c, entitiesJson) => {
    const body = JSON.parse(entitiesJson) as { entities: { id: string; baseVersion: number }[] };
    pushCalls.push(body as never);
    const handler =
      pushQueue.shift() ??
      ((batch) =>
        ok({
          collection: _c,
          serverVersion: 100,
          results: batch.entities.map((e, i) => ({ id: e.id, status: "accepted", version: 50 + i })),
        }));
    return handler(body);
  });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SpeakSession> = {}): SpeakSession {
  return {
    id: "s1",
    scenario: "ordering",
    difficulty: "easy",
    turns: [
      { role: "assistant", text: "Hi there!", hintZh: "你好！", at: 1000 },
      {
        role: "user",
        text: "I'd like a coffee.",
        pron: { at: 1100, total: 4, accuracy: 3.8, fluency: 4.2, integrity: 4.5, words: [] },
        coachDiff: { segs: [{ t: "keep", v: "coffee" }] },
        at: 1100,
      },
      {
        role: "assistant",
        text: "Great choice!",
        shadowAttempts: [{ at: 1200, total: 4.6, accuracy: 4.5, fluency: 4.7, integrity: 4.8, words: [] }],
        at: 1200,
      },
    ],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeResult(overrides: Partial<PronunciationResult> = {}): PronunciationResult {
  return {
    total: 4.2,
    accuracy: 4.0,
    fluency: 4.5,
    standard: 4.1,
    integrity: 4.8,
    isRejected: false,
    exceptInfo: null,
    words: [
      { content: "the", totalScore: 5, dpMessage: 0, sylls: [] },
      { content: "quick", totalScore: 3.6, dpMessage: 0, sylls: [] },
    ],
    ...overrides,
  };
}

function liveEntity(collection: string, id: string, updatedAt: number): StoredSyncEntity {
  const e: StoredSyncEntity = {
    id,
    baseVersion: 1,
    updatedAt,
    deleted: false,
    schemaVersion: 1,
    originDevice: "windows",
    payload: sessionRecordFrom(makeSession({ id, createdAt: updatedAt, updatedAt })),
    dirty: false,
  };
  bucket(collection).set(id, e);
  return e;
}

// ---------------------------------------------------------------------------
// schema：投影/往返/截断/守卫
// ---------------------------------------------------------------------------

describe("speak-sessions schema", () => {
  it("富会话 → 精简投影：只留 role/text/at，hintZh/pron/shadowAttempts/coachDiff/context 不上云", () => {
    const record = sessionRecordFrom(makeSession({ context: { kind: "vocab", wordIds: ["w1"] } }));
    expect(record).toEqual({
      id: "s1",
      scenario: "ordering",
      difficulty: "easy",
      startedAt: 1000,
      endedAt: 2000,
      turns: [
        { role: "assistant", text: "Hi there!", at: 1000 },
        { role: "user", text: "I'd like a coffee.", at: 1100 },
        { role: "assistant", text: "Great choice!", at: 1200 },
      ],
    });
    expect(JSON.stringify(record)).not.toContain("pron");
    expect(JSON.stringify(record)).not.toContain("shadowAttempts");
    expect(JSON.stringify(record)).not.toContain("coachDiff");
    expect(JSON.stringify(record)).not.toContain("wordIds");
  });

  it("云端记录 → 富会话往返（resume 形态），updatedAt 取 started/ended 较大者", () => {
    const record = sessionRecordFrom(makeSession());
    const session = sessionFromRecord(record);
    expect(session.id).toBe("s1");
    expect(session.scenario).toBe("ordering");
    expect(session.difficulty).toBe("easy");
    expect(session.turns).toHaveLength(3);
    expect(session.createdAt).toBe(1000);
    expect(session.updatedAt).toBe(2000);
  });

  it("64KB 护栏：超大会话从最旧轮次开始丢弃，至少留 1 轮，结果 ≤64KB", () => {
    // 200 轮 × 每轮 ~800B 文本 ≈ 160KB，必超
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      text: `${i}: ${"w".repeat(700)}`,
      at: 1000 + i,
    }));
    const record = sessionRecordFrom(makeSession({ turns, updatedAt: 9999 }));
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    expect(bytes).toBeLessThanOrEqual(SPEAK_RECORD_MAX_BYTES);
    expect(record.turns.length).toBeGreaterThan(0);
    expect(record.turns.length).toBeLessThan(200);
    // 丢的是最旧轮次：保留的都靠后
    expect(record.turns[record.turns.length - 1].at).toBe(1199);
  });

  it("单轮文本截断到 1000 字符", () => {
    const record = sessionRecordFrom(makeSession({ turns: [{ role: "user", text: "a".repeat(3000), at: 1 }] }));
    expect(record.turns[0].text).toHaveLength(TEXT_MAX_CHARS);
  });

  it("形状守卫：合法记录通过；缺字段/坏轮次/非对象拒绝", () => {
    const record = sessionRecordFrom(makeSession());
    expect(isSpeakSessionRecordLike(record)).toBe(true);
    expect(isSpeakSessionRecordLike({ ...record, id: "" })).toBe(false);
    expect(isSpeakSessionRecordLike({ ...record, difficulty: "harder" })).toBe(false);
    expect(isSpeakSessionRecordLike({ ...record, turns: [{ role: "bot", text: "x", at: 1 }] })).toBe(false);
    expect(isSpeakSessionRecordLike({ ...record, endedAt: "2000" })).toBe(false);
    expect(isSpeakSessionRecordLike(null)).toBe(false);
    expect(isSpeakSessionRecordLike("s1")).toBe(false);
  });
});

describe("speak-assessments schema", () => {
  it("评测结果 → 精简记录：四分摘要 + 逐词 {w,s}（丢音节/音素），sessionId 可选", () => {
    const record = assessmentRecordFrom({
      result: makeResult(),
      source: "coach",
      refText: "I'd like a coffee.",
      sessionId: "s1",
      now: 1690000000000,
    });
    expect(record).toMatchObject({
      source: "coach",
      lang: "en",
      refText: "I'd like a coffee.",
      total: 4.2,
      accuracy: 4.0,
      fluency: 4.5,
      standard: 4.1,
      words: [
        { w: "the", s: 5 },
        { w: "quick", s: 3.6 },
      ],
      sessionId: "s1",
      at: 1690000000000,
    });
    expect(JSON.stringify(record)).not.toContain("sylls");
    expect(record.id).toMatch(/^sa/);

    const bare = assessmentRecordFrom({ result: makeResult(), source: "reader", refText: "x", now: 1 });
    expect(bare.sessionId).toBeUndefined();
  });

  it("逐词截断到 64 个、参考文本截断到 1000 字符", () => {
    const words = Array.from({ length: 100 }, (_, i) => ({
      content: `word${i}`,
      totalScore: 4,
      dpMessage: 0,
      sylls: [],
    }));
    const record = assessmentRecordFrom({
      result: makeResult({ words }),
      source: "reader",
      refText: "r".repeat(3000),
      now: 2,
    });
    expect(record.words).toHaveLength(ASSESS_MAX_WORDS);
    expect(record.words[63]).toEqual({ w: "word63", s: 4 });
    expect(record.refText).toHaveLength(TEXT_MAX_CHARS);
  });

  it("形状守卫：坏 source/非数值分数/坏 words 拒绝", () => {
    const record = assessmentRecordFrom({ result: makeResult(), source: "review", refText: "x", now: 3 });
    expect(isSpeakAssessmentRecordLike(record)).toBe(true);
    expect(isSpeakAssessmentRecordLike({ ...record, source: "drill" })).toBe(false);
    expect(isSpeakAssessmentRecordLike({ ...record, total: "4.2" })).toBe(false);
    expect(isSpeakAssessmentRecordLike({ ...record, words: [{ w: "x" }] })).toBe(false);
    expect(isSpeakAssessmentRecordLike(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 入队 / 滚动裁剪 / tombstone
// ---------------------------------------------------------------------------

describe("入队与滚动裁剪", () => {
  it("会话入队：写 dirty 实体、payload=精简记录；已同步过则沿用 baseVersion", async () => {
    const first = await enqueueSessionRecord(makeSession({ updatedAt: 2000 }));
    expect(first).toBeUndefined();
    const stored = bucket(SPEAK_SESSIONS_COLLECTION).get("s1");
    expect(stored).toMatchObject({
      id: "s1",
      baseVersion: 0,
      updatedAt: 2000,
      deleted: false,
      dirty: true,
      originDevice: "windows",
    });
    expect(isSpeakSessionRecordLike(stored?.payload)).toBe(true);

    // 模拟已同步（baseVersion 7、dirty 清零）后再改会话
    bucket(SPEAK_SESSIONS_COLLECTION).set("s1", { ...stored!, baseVersion: 7, dirty: false });
    await enqueueSessionRecord(makeSession({ updatedAt: 3000 }));
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("s1")).toMatchObject({
      baseVersion: 7,
      updatedAt: 3000,
      dirty: true,
    });
  });

  it("入队全程零网络请求（游客同样可用：本地写 + dirty 入队）", async () => {
    await enqueueSessionRecord(makeSession());
    await enqueueAssessment({ result: makeResult(), source: "reader", refText: "x", now: 5 });
    expect(syncPull).not.toHaveBeenCalled();
    expect(syncPush).not.toHaveBeenCalled();
    expect(bucket(SPEAK_SESSIONS_COLLECTION).size).toBe(1);
    expect(bucket(SPEAK_ASSESSMENTS_COLLECTION).size).toBe(1);
  });

  it("500 条护栏：满 500 活实体时再入队，最旧 1 条转 tombstone（保留 baseVersion，删除可传播）", async () => {
    for (let i = 1; i <= SPEAK_RECORD_MAX_LIVE; i += 1) {
      liveEntity(SPEAK_SESSIONS_COLLECTION, `old${i}`, i * 100);
    }
    await enqueueSessionRecord(makeSession({ id: "fresh", updatedAt: 999999 }));
    const all = [...bucket(SPEAK_SESSIONS_COLLECTION).values()];
    const live = all.filter((e) => !e.deleted);
    const dead = all.filter((e) => e.deleted);
    expect(live).toHaveLength(SPEAK_RECORD_MAX_LIVE);
    expect(dead.map((e) => e.id)).toEqual(["old1"]);
    expect(dead[0]).toMatchObject({
      deleted: true,
      dirty: true,
      baseVersion: 1,
    });
    expect(dead[0].payload).toBeUndefined();
    expect(dead[0].updatedAt).toBeGreaterThan(100); // 裁剪时刻晚于被裁记录逻辑时间
    expect(live.some((e) => e.id === "fresh")).toBe(true);
  });

  it("不满 500 不产生 tombstone", async () => {
    for (let i = 1; i <= 499; i += 1) liveEntity(SPEAK_SESSIONS_COLLECTION, `old${i}`, i);
    await enqueueSessionRecord(makeSession({ id: "fresh", updatedAt: 999999 }));
    const all = [...bucket(SPEAK_SESSIONS_COLLECTION).values()];
    expect(all).toHaveLength(500);
    expect(all.every((e) => !e.deleted)).toBe(true);
  });

  it("删除走 tombstone：deleted/payload 空/dirty、保留 baseVersion；重复删返回 false", async () => {
    const e = liveEntity(SPEAK_SESSIONS_COLLECTION, "s1", 1000);
    bucket(SPEAK_SESSIONS_COLLECTION).set("s1", { ...e, baseVersion: 9 });
    const changed = await deleteSessionRecord("s1", 5000);
    expect(changed).toBe(true);
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("s1")).toMatchObject({
      deleted: true,
      dirty: true,
      baseVersion: 9,
      updatedAt: 5000,
    });
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("s1")?.payload).toBeUndefined();
    expect(await deleteSessionRecord("s1", 6000)).toBe(false);
    expect(await deleteSessionRecord("ghost", 6000)).toBe(false);
  });

  it("push 载荷红线：tombstone 线路形态 payload 为 null，活实体不含音频类字段", async () => {
    liveEntity(SPEAK_SESSIONS_COLLECTION, "s1", 1000);
    await deleteSessionRecord("s1", 5000);
    // 走一次真实 syncNow 让 push 发生
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    pullQueue.push(({ since }) => ok({ collection: SPEAK_SESSIONS_COLLECTION, serverVersion: 0, cursor: since, hasMore: false, entities: [] }));
    await syncSpeakRecordsSilently();
    const tombstoneOnWire = pushCalls[0].entities.find((e) => e.id === "s1");
    expect(tombstoneOnWire).toMatchObject({ id: "s1", deleted: true, payload: null });
    // 活实体（评测）载荷没有任何 base64/音频形态字段
    await enqueueAssessment({ result: makeResult(), source: "reader", refText: "hello", now: 7 });
    pushCalls.length = 0;
    pullQueue.push(({ since }) => ok({ collection: SPEAK_ASSESSMENTS_COLLECTION, serverVersion: 0, cursor: since, hasMore: false, entities: [] }));
    await syncSpeakRecordsSilently();
    const wireText = JSON.stringify(pushCalls.flatMap((c) => c.entities));
    expect(wireText).not.toMatch(/audio|base64|pcm|blob|data:audio/i);
  });
});

// ---------------------------------------------------------------------------
// 读取 / 展示合并（多端冲突：最后写入胜出）
// ---------------------------------------------------------------------------

describe("读取与展示合并", () => {
  it("list*：tombstone 与形状不符的脏行丢弃", async () => {
    liveEntity(SPEAK_SESSIONS_COLLECTION, "ok1", 1000);
    bucket(SPEAK_SESSIONS_COLLECTION).set("dead1", {
      ...liveEntity(SPEAK_SESSIONS_COLLECTION, "dead1", 2000),
      deleted: true,
    });
    bucket(SPEAK_SESSIONS_COLLECTION).set("dirty1", {
      ...liveEntity(SPEAK_SESSIONS_COLLECTION, "dirty1", 3000),
      payload: { nonsense: true },
    });
    const records = await listSessionRecords();
    expect(records.map((r) => r.id)).toEqual(["ok1"]);

    const a = bucket(SPEAK_ASSESSMENTS_COLLECTION);
    const good = assessmentRecordFrom({ result: makeResult(), source: "reader", refText: "x", now: 1 });
    a.set(good.id, { id: good.id, baseVersion: 0, updatedAt: 1, deleted: false, schemaVersion: 1, originDevice: "windows", payload: good, dirty: false });
    a.set("a2", { id: "a2", baseVersion: 0, updatedAt: 2, deleted: false, schemaVersion: 1, originDevice: "windows", payload: { junk: 1 }, dirty: false });
    expect((await listAssessmentRecords()).map((r) => r.id)).toEqual([good.id]);
  });

  it("合并：本地较新/相等保留本地富会话（超集），云端较新用云端精简版；并集按 updatedAt 倒序", () => {
    const localRich = makeSession({ id: "both", updatedAt: 2000 });
    const olderCloud = sessionRecordFrom(makeSession({ id: "both", updatedAt: 1000 }));
    const merged1 = mergeSessionsWithRecords([localRich], [olderCloud]);
    expect(merged1[0].turns[2].shadowAttempts).toBeDefined(); // 本地富会话胜出

    // 云端较新（别端续聊过）→ 云端精简版胜出
    const newerCloud = sessionRecordFrom(makeSession({ id: "both", updatedAt: 3000, turns: [...localRich.turns, { role: "assistant", text: "See you!", at: 3000 }] }));
    const merged2 = mergeSessionsWithRecords([localRich], [newerCloud]);
    expect(merged2[0].updatedAt).toBe(3000);
    expect(merged2[0].turns[merged2[0].turns.length - 1].text).toBe("See you!");
    expect(merged2[0].turns[2].shadowAttempts).toBeUndefined(); // 精简版无报告

    // 相等 → 本地（超集）；不相交 id → 并集；倒序
    const other = makeSession({ id: "cloudonly", createdAt: 500, updatedAt: 500 });
    const merged3 = mergeSessionsWithRecords([localRich], [
      sessionRecordFrom(makeSession({ id: "both", updatedAt: 2000 })),
      sessionRecordFrom(other),
    ]);
    expect(merged3.map((s) => s.id)).toEqual(["both", "cloudonly"]);
    expect(merged3[0].turns[2].shadowAttempts).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 同步：B 端首拉 / 双端冲突 / 游客零请求
// ---------------------------------------------------------------------------

describe("同步场景", () => {
  it("B 端首拉全量：A 端 3 条记录 → pull 落库 → listSessionRecords 可读 3 条", async () => {
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    const payloads = ["a", "b", "c"].map((id, i) =>
      sessionRecordFrom(makeSession({ id, createdAt: 100 * (i + 1), updatedAt: 100 * (i + 1) })),
    );
    pullQueue.push(() =>
      ok({
        collection: SPEAK_SESSIONS_COLLECTION,
        serverVersion: 3,
        cursor: 3,
        hasMore: false,
        entities: payloads.map((p, i) => wire(p.id, i + 1, p.endedAt, p)),
      }),
    );
    const summaries = await syncSpeakRecordsSilently();
    expect(summaries[0].pulled).toBe(3);
    expect(summaries[0].ok).toBe(true);
    expect((await listSessionRecords()).map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    // 落库实体带服务端版本号且非 dirty
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("a")).toMatchObject({ baseVersion: 1, dirty: false });
  });

  it("双端改同一条 → 最后写入胜出：本地较新时 409 后携 serverVersion 重推，accepted 后 dirty 清零", async () => {
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    // 本地已同步过（baseVersion 5）后又改过（dirty、updatedAt 更晚）
    const localRecord = sessionRecordFrom(makeSession({ id: "s1", updatedAt: 5000 }));
    bucket(SPEAK_SESSIONS_COLLECTION).set("s1", {
      id: "s1",
      baseVersion: 5,
      updatedAt: 5000,
      deleted: false,
      schemaVersion: 1,
      originDevice: "windows",
      payload: localRecord,
      dirty: true,
    });
    // 第一轮 push：409，服务端快照较旧（updatedAt 4000）
    pushQueue.push(() => ({
      status: 409,
      body: JSON.stringify({
        error: {
          code: "sync_conflict",
          message: "conflict",
          details: {
            conflicts: [
              {
                id: "s1",
                serverVersion: 5,
                server: { ...wire("s1", 5, 4000, sessionRecordFrom(makeSession({ id: "s1", updatedAt: 4000 }))), id: undefined },
              },
            ],
          },
        },
      }),
      retryAfterSeconds: null,
    }));
    pullQueue.push(({ since }) => ok({ collection: SPEAK_SESSIONS_COLLECTION, serverVersion: 5, cursor: since, hasMore: false, entities: [] }));
    const summaries = await syncSpeakRecordsSilently();
    expect(summaries[0].conflicts).toBe(1);
    expect(summaries[0].pushed).toBe(1);
    // 第二轮以修正后的 baseVersion=serverVersion 重推成功
    expect(pushCalls[1].entities[0]).toMatchObject({ id: "s1", baseVersion: 5 });
    // 本地较新的内容胜出落库，dirty 清零
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("s1")).toMatchObject({
      dirty: false,
      baseVersion: 50,
      updatedAt: 5000,
    });
    expect(bucket(SPEAK_SESSIONS_COLLECTION).get("s1")?.payload).toEqual(localRecord);
  });

  it("A 端删 1 条 → B 端拉到 tombstone 生效：实体 deleted 落库、list 不再返回", async () => {
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    liveEntity(SPEAK_SESSIONS_COLLECTION, "s1", 1000);
    const tombstone = wire("s1", 9, 9000, null);
    pullQueue.push(() =>
      ok({
        collection: SPEAK_SESSIONS_COLLECTION,
        serverVersion: 9,
        cursor: 9,
        hasMore: false,
        entities: [{ ...tombstone, deleted: true }],
      }),
    );
    await syncSpeakRecordsSilently();
    const stored = bucket(SPEAK_SESSIONS_COLLECTION).get("s1");
    expect(stored).toMatchObject({ deleted: true, dirty: false, baseVersion: 9 });
    expect(stored?.payload).toBeUndefined();
    expect(await listSessionRecords()).toEqual([]);
  });

  it("游客（未登录）：syncSpeakRecordsSilently 直接跳过，零网络请求", async () => {
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: false, user: null, notice: null });
    const summaries = await syncSpeakRecordsSilently();
    expect(summaries).toEqual([]);
    expect(syncPull).not.toHaveBeenCalled();
    expect(syncPush).not.toHaveBeenCalled();
  });

  it("登录态读取失败：不同步不出网（宁可跳过）", async () => {
    vi.mocked(authGetStatus).mockRejectedValue(new Error("bridge unavailable"));
    await syncSpeakRecordsSilently();
    expect(syncPull).not.toHaveBeenCalled();
  });
});
