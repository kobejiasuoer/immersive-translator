/**
 * syncEngine 协议引擎单测：mock ./tauriBridge（模块级 mock，先例
 * settingsStore.test.ts），用内存 Map 模拟 Rust 本地存储。覆盖：
 * 首次全量/分页/tombstone/LWW 合并（dirty 保留与采纳）、push accepted、
 * 409 三种冲突形态、429 退避、512KB 预检、413 兜底、批分片、错误汇总。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  syncPull,
  syncPush,
  syncStoreCursorGet,
  syncStoreCursorSet,
  syncStoreList,
  syncStorePut,
  type StoredSyncEntity,
  type SyncHttpText,
} from "./tauriBridge";
import { entityPayloadBytes, syncNow, type WireEntity } from "./syncEngine";

vi.mock("./tauriBridge", () => ({
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
const http = (status: number, body: unknown, retryAfterSeconds: number | null = null): SyncHttpText => ({
  status,
  body: JSON.stringify(body),
  retryAfterSeconds,
});

function wire(id: string, version: number, updatedAtMs: number, overrides: Partial<WireEntity> = {}): WireEntity {
  return {
    id,
    version,
    updatedAt: new Date(updatedAtMs).toISOString(),
    deleted: false,
    schemaVersion: 1,
    originDevice: "mac",
    payload: { title: `t-${id}` },
    ...overrides,
  };
}

function stored(id: string, updatedAtMs: number, overrides: Partial<StoredSyncEntity> = {}): StoredSyncEntity {
  return {
    id,
    baseVersion: 0,
    updatedAt: updatedAtMs,
    deleted: false,
    schemaVersion: 1,
    originDevice: "windows",
    payload: { title: `local-${id}` },
    dirty: true,
    ...overrides,
  };
}

/** 内存态测试台：entities=本地存储，pullPages=按序消费的拉取页，
 *  pushResponses=按序消费的推送应答（耗尽后用 defaultPush）。 */
let entities: Map<string, StoredSyncEntity>;
let cursor: number;
let pullQueue: Array<SyncHttpText | ((since: number) => SyncHttpText)>;
let pushQueue: Array<(batch: { entities: { id: string; baseVersion: number }[] }) => SyncHttpText>;
let pushCalls: { entities: { id: string; baseVersion: number; deleted: boolean; payload: unknown }[] }[];

function defaultPush(batch: { entities: { id: string; baseVersion: number }[] }): SyncHttpText {
  return ok({
    collection: "speak-scenarios",
    serverVersion: 100,
    results: batch.entities.map((e, i) => ({ id: e.id, status: "accepted", version: 50 + i })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  entities = new Map();
  cursor = 0;
  pullQueue = [];
  pushQueue = [];
  pushCalls = [];

  vi.mocked(syncStoreCursorGet).mockImplementation(async () => cursor);
  vi.mocked(syncStoreCursorSet).mockImplementation(async (_c, value) => {
    cursor = value;
  });
  vi.mocked(syncStoreList).mockImplementation(async () =>
    [...entities.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  vi.mocked(syncStorePut).mockImplementation(async (_c, list) => {
    for (const e of list) entities.set(e.id, e);
  });
  vi.mocked(syncPull).mockImplementation(async (_c, since) => {
    const next = pullQueue.shift();
    if (typeof next === "function") return next(since);
    if (next) return next;
    return ok({ collection: "speak-scenarios", serverVersion: 0, cursor: since, hasMore: false, entities: [] });
  });
  vi.mocked(syncPush).mockImplementation(async (_c, entitiesJson) => {
    const body = JSON.parse(entitiesJson) as { entities: { id: string; baseVersion: number }[] };
    pushCalls.push(body as never);
    const handler = pushQueue.shift() ?? defaultPush;
    return handler(body);
  });
});

describe("拉取", () => {
  it("首次空库：不动实体，游标原样落盘", async () => {
    pullQueue = [ok({ collection: "speak-scenarios", serverVersion: 7, cursor: 7, hasMore: false, entities: [] })];
    const summary = await syncNow("speak-scenarios");
    expect(summary.ok).toBe(true);
    expect(summary.pulled).toBe(0);
    expect(syncStoreCursorSet).toHaveBeenCalledWith("speak-scenarios", 7);
  });

  it("首次全量：实体落库 dirty=false、baseVersion=服务端版本", async () => {
    pullQueue = [
      ok({
        collection: "speak-scenarios",
        serverVersion: 5,
        cursor: 5,
        hasMore: false,
        entities: [wire("a", 3, 1000), wire("b", 5, 2000)],
      }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.pulled).toBe(2);
    expect(summary.appliedRemote).toBe(2);
    expect(entities.get("a")).toMatchObject({ baseVersion: 3, dirty: false, updatedAt: 1000 });
    expect(entities.get("b")).toMatchObject({ baseVersion: 5, dirty: false });
  });

  it("分页拉取直到 hasMore=false，游标推进", async () => {
    pullQueue = [
      ok({ collection: "speak-scenarios", serverVersion: 9, cursor: 5, hasMore: true, entities: [wire("a", 3, 1000)] }),
      ok({ collection: "speak-scenarios", serverVersion: 9, cursor: 9, hasMore: false, entities: [wire("b", 9, 2000)] }),
    ];
    await syncNow("speak-scenarios");
    expect(syncPull).toHaveBeenCalledTimes(2);
    expect(cursor).toBe(9);
    expect(entities.size).toBe(2);
  });

  it("tombstone：本地活实体被服务端删除覆盖（payload 清空）", async () => {
    entities.set("a", stored("a", 500, { dirty: false, baseVersion: 3 }));
    pullQueue = [
      ok({
        collection: "speak-scenarios",
        serverVersion: 8,
        cursor: 8,
        hasMore: false,
        entities: [wire("a", 8, 1000, { deleted: true, payload: null })],
      }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.appliedRemote).toBe(1);
    const a = entities.get("a");
    expect(a).toMatchObject({ deleted: true, dirty: false, baseVersion: 8 });
    expect(a?.payload).toBeUndefined();
  });

  it("LWW：本地 dirty 且较新 → 拉取不覆盖本地内容，随后的推送带本地 payload", async () => {
    entities.set("a", stored("a", 9000, { dirty: true, baseVersion: 2, payload: { title: "本地新稿" } }));
    pullQueue = [
      ok({
        collection: "speak-scenarios",
        serverVersion: 7,
        cursor: 7,
        hasMore: false,
        entities: [wire("a", 7, 1000, { payload: { title: "服务端旧稿" } })],
      }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.keptLocal).toBe(1);
    // 本地内容未被服务端旧稿覆盖，且同一轮被推送（accepted 清 dirty）
    expect(pushCalls.length).toBe(1);
    expect(pushCalls[0]?.entities[0]).toMatchObject({ id: "a", payload: { title: "本地新稿" } });
    expect(entities.get("a")).toMatchObject({ dirty: false, payload: { title: "本地新稿" } });
  });

  it("LWW：本地 dirty 但服务端较新 → 采纳服务端（相等也取服务端防乒乓）", async () => {
    entities.set("a", stored("a", 1000, { dirty: true, baseVersion: 2 }));
    pullQueue = [
      ok({
        collection: "speak-scenarios",
        serverVersion: 7,
        cursor: 7,
        hasMore: false,
        entities: [wire("a", 7, 9000, { payload: { title: "服务端新稿" } })],
      }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.appliedRemote).toBe(1);
    expect(entities.get("a")).toMatchObject({ dirty: false, baseVersion: 7, payload: { title: "服务端新稿" } });
    expect(pushCalls.length).toBe(0);
  });
});

describe("推送", () => {
  it("accepted：清 dirty 并记录服务端版本", async () => {
    entities.set("a", stored("a", 1000));
    entities.set("b", stored("b", 2000, { deleted: true, payload: undefined }));
    pushQueue = [
      () =>
        ok({
          collection: "speak-scenarios",
          serverVersion: 100,
          results: [
            { id: "a", status: "accepted", version: 50 },
            { id: "b", status: "accepted", version: 51 },
          ],
        }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.pushed).toBe(2);
    expect(entities.get("a")).toMatchObject({ dirty: false, baseVersion: 50 });
    expect(entities.get("b")).toMatchObject({ dirty: false, deleted: true, baseVersion: 51 });
    // tombstone 线路形态：payload null
    const tomb = pushCalls[0]?.entities.find((e) => e.id === "b");
    expect(tomb).toMatchObject({ deleted: true, payload: null });
  });

  it("409 幽灵实体（server=null）：baseVersion 0 重推成功", async () => {
    entities.set("a", stored("a", 1000, { baseVersion: 9 }));
    pushQueue = [
      () =>
        http(409, {
          error: { code: "sync_conflict", details: { conflicts: [{ id: "a", serverVersion: 0, server: null }] } },
        }),
      defaultPush,
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.conflicts).toBe(1);
    expect(summary.pushed).toBe(1);
    expect(pushCalls[1]?.entities[0]).toMatchObject({ id: "a", baseVersion: 0 });
    expect(entities.get("a")).toMatchObject({ dirty: false, baseVersion: 50 });
  });

  it("409 服务端较新：采纳快照，不再重推", async () => {
    entities.set("a", stored("a", 1000, { baseVersion: 9 }));
    pushQueue = [
      () =>
        http(409, {
          error: {
            code: "sync_conflict",
            details: {
              conflicts: [
                { id: "a", serverVersion: 12, server: wire("a", 12, 9000, { payload: { title: "服务端" } }) },
              ],
            },
          },
        }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.conflicts).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(summary.appliedRemote).toBe(1);
    expect(pushCalls.length).toBe(1);
    expect(entities.get("a")).toMatchObject({ dirty: false, baseVersion: 12, payload: { title: "服务端" } });
  });

  it("409 本地较新：携 serverVersion 重推成功", async () => {
    entities.set("a", stored("a", 9000, { baseVersion: 9, payload: { title: "本地" } }));
    pushQueue = [
      () =>
        http(409, {
          error: {
            code: "sync_conflict",
            details: {
              conflicts: [{ id: "a", serverVersion: 12, server: wire("a", 12, 1000) }],
            },
          },
        }),
      defaultPush,
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.pushed).toBe(1);
    expect(pushCalls[1]?.entities[0]).toMatchObject({ id: "a", baseVersion: 12 });
    expect(entities.get("a")).toMatchObject({ dirty: false, payload: { title: "本地" } });
  });

  it("409 三轮不收敛：记入 skipped 不抛错", async () => {
    entities.set("a", stored("a", 9000, { baseVersion: 9 }));
    const conflict = () =>
      http(409, {
        error: {
          code: "sync_conflict",
          details: { conflicts: [{ id: "a", serverVersion: 99, server: wire("a", 99, 1000) }] },
        },
      });
    pushQueue = [conflict, conflict, conflict];
    const summary = await syncNow("speak-scenarios");
    expect(summary.ok).toBe(true);
    expect(summary.skipped).toEqual([
      { id: "a", reason: "冲突 3 轮未收敛，留待下次同步" },
    ]);
    expect(pushCalls.length).toBe(3);
  });

  it("413 payload_too_large：剔除超限实体后其余照推", async () => {
    entities.set("big", stored("big", 1000));
    entities.set("ok1", stored("ok1", 2000));
    pushQueue = [
      () =>
        http(413, {
          error: { code: "payload_too_large", details: { entityId: "big", sizeBytes: 600000, maxBytes: 524288 } },
        }),
      defaultPush,
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.skipped).toEqual([{ id: "big", reason: "服务端判定 payload 超限" }]);
    expect(summary.pushed).toBe(1);
    expect(pushCalls[1]?.entities.map((e) => e.id)).toEqual(["ok1"]);
  });

  it("413 sync_quota_exceeded：整次同步失败带回错误", async () => {
    entities.set("a", stored("a", 1000));
    pushQueue = [
      () =>
        http(413, {
          error: { code: "sync_quota_exceeded", details: { usedBytes: 1, deltaBytes: 1, quotaBytes: 1 } },
        }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("sync_quota_exceeded");
  });

  it("客户端 512KB 预检：超限/缺 payload 的实体跳过，不发起推送", async () => {
    entities.set("big", stored("big", 1000, { payload: { blob: "x".repeat(520 * 1024) } }));
    entities.set("empty", stored("empty", 2000, { payload: undefined }));
    const summary = await syncNow("speak-scenarios");
    expect(pushCalls.length).toBe(0);
    expect(summary.skipped.map((s) => s.id).sort()).toEqual(["big", "empty"]);
    // 本地数据保留不清
    expect(entities.get("big")?.dirty).toBe(true);
  });

  it("超过 200 实体分批推送", async () => {
    for (let i = 0; i < 205; i += 1) {
      entities.set(`e${i}`, stored(`e${i}`, 1000 + i, { payload: { n: i } }));
    }
    const summary = await syncNow("speak-scenarios");
    expect(summary.pushed).toBe(205);
    expect(pushCalls.length).toBe(2);
    expect(pushCalls[0]?.entities.length).toBe(200);
    expect(pushCalls[1]?.entities.length).toBe(5);
  });
});

describe("限流与错误", () => {
  it("pull 429：退避后重试同页成功", async () => {
    let pulls = 0;
    pullQueue = [
      () => {
        pulls += 1;
        return http(429, { error: { code: "rate_limited", details: { retryAfterMs: 1 } } });
      },
      ok({ collection: "speak-scenarios", serverVersion: 3, cursor: 3, hasMore: false, entities: [] }),
    ];
    const summary = await syncNow("speak-scenarios");
    expect(summary.ok).toBe(true);
    expect(syncPull).toHaveBeenCalledTimes(2);
  });

  it("未知集合 404：失败汇总带回错误码", async () => {
    pullQueue = [() => http(404, { error: { code: "sync_collection_invalid", message: "集合不在白名单" } })];
    const summary = await syncNow("speak-scenarios");
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("sync_collection_invalid");
  });
});

describe("entityPayloadBytes", () => {
  it("tombstone 计 0；活实体按 JSON UTF-8 字节（中文 3 字节/字）", () => {
    const tomb = stored("t", 1, { deleted: true, payload: undefined });
    expect(entityPayloadBytes(tomb)).toBe(0);
    const cn = stored("c", 1, { payload: { title: "四字标题" } });
    // {"title":"四字标题"} = 12 个 ASCII（含引号与括号）+ 4×3 字节
    expect(entityPayloadBytes(cn)).toBe(12 + 12);
  });
});
