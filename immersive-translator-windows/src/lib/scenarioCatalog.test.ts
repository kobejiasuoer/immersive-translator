/**
 * scenarioCatalog 装载器单测：mock ./tauriBridge（先例 syncEngine.test.ts），
 * 每例 vi.resetModules + 动态 import 重置模块级单飞状态。覆盖：
 * preload 装载/降级（缓存+同步用户场景）、refresh 200 写缓存/404 静默/断网
 * 静默/垃圾 body 不写盘、每次调用都发请求与 in-flight 并发、「有更新才替换」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSyncEntity, SyncHttpText } from "./tauriBridge";

// vi.hoisted：resetModules 后 mock 工厂即使重跑，也返回同一组 vi.fn 实例
// （否则 scenarioCatalog 内部拿到的与测试拿到的会是两个 mock，断言失真）。
const mocks = vi.hoisted(() => ({
  scenarioCacheRead: vi.fn(),
  scenarioCacheWrite: vi.fn(),
  scenarioFetchOfficial: vi.fn(),
  syncStoreList: vi.fn(),
}));

vi.mock("./tauriBridge", () => mocks);

/** 合法官方场景（cacheRead / fetch body 的 JSON 反序列化形状）。 */
function officialScenario(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    source: "official",
    title: `t-${id}`,
    category: "daily",
    aiRole: `role-${id}`,
    opener: `opener-${id}`,
    updatedAt: 1767225600000,
    ...overrides,
  };
}

/** 合法用户场景（A0 sync 实体 payload 形状）。 */
function userScenario(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    source: "user",
    title: `t-${id}`,
    category: "custom",
    aiRole: `role-${id}`,
    opener: `opener-${id}`,
    updatedAt: 1767225600000,
    ...overrides,
  };
}

/** 本地同步实体（payload 活实体 / tombstone）。 */
function storedEntity(payload: Record<string, unknown> | undefined, deleted = false): StoredSyncEntity {
  return {
    id: payload ? String(payload.id) : "usr_tombstone",
    baseVersion: 3,
    updatedAt: 1767225600000,
    deleted,
    schemaVersion: 1,
    originDevice: "windows",
    payload,
    dirty: false,
  };
}

const http = (status: number, body: string): SyncHttpText => ({ status, body, retryAfterSeconds: null });

/** 每例取一套新模块图（catalog 的单飞 + speakLogic 注册表同图重置）。 */
async function loadModules() {
  const catalog = await import("./scenarioCatalog");
  const logic = await import("../core/speakLogic");
  return { catalog, logic };
}

beforeEach(() => {
  mocks.scenarioCacheRead.mockReset().mockResolvedValue([]);
  mocks.scenarioCacheWrite.mockReset().mockResolvedValue(undefined);
  mocks.scenarioFetchOfficial.mockReset();
  mocks.syncStoreList.mockReset().mockResolvedValue([]);
  vi.resetModules();
});

describe("preloadScenarioCatalog：启动装载", () => {
  it("缓存里的官方场景进官方桶，scenarioOf 命中；单飞不重复读缓存", async () => {
    const offA = officialScenario("off_a");
    const offB = officialScenario("off_b");
    mocks.scenarioCacheRead.mockResolvedValue([offA, offB]);
    const { catalog, logic } = await loadModules();

    await catalog.preloadScenarioCatalog();

    expect(logic.listOfficialScenarios()).toHaveLength(2);
    expect(logic.scenarioOf("off_a").title).toBe("t-off_a");
    expect(logic.scenarioOf("off_b").source).toBe("official");
    // 单飞：第二次调用复用同一个 promise，不再触发 IO
    await catalog.preloadScenarioCatalog();
    expect(mocks.scenarioCacheRead).toHaveBeenCalledTimes(1);
  });

  it("同步来的用户场景进用户桶；tombstone（deleted:true）不进", async () => {
    const alive = userScenario("usr_uuid-1");
    mocks.syncStoreList.mockResolvedValue([storedEntity(alive), storedEntity(undefined, true)]);
    const { catalog, logic } = await loadModules();

    await catalog.preloadScenarioCatalog();

    expect(logic.listUserScenarios().map((s) => s.id)).toEqual(["usr_uuid-1"]);
    expect(logic.scenarioOf("usr_uuid-1").source).toBe("user");
    // 集合名对齐 A0 登记的 speak-scenarios
    expect(mocks.syncStoreList).toHaveBeenCalledWith("speak-scenarios");
  });

  it("缓存与同步双失败 → preload 不抛、注册表空、内置场景照常", async () => {
    mocks.scenarioCacheRead.mockRejectedValue(new Error("cache corrupt"));
    mocks.syncStoreList.mockRejectedValue(new Error("store err"));
    const { catalog, logic } = await loadModules();

    await expect(catalog.preloadScenarioCatalog()).resolves.toBeUndefined();

    expect(logic.listOfficialScenarios()).toEqual([]);
    expect(logic.listUserScenarios()).toEqual([]);
    expect(logic.scenarioOf("ordering").id).toBe("ordering");
  });
});

describe("refreshOfficialScenarioCatalog：后台拉取官方目录", () => {
  it("200 + { scenarios: [...] } 包装形状 → 过滤后写缓存并更新注册表", async () => {
    const offA = officialScenario("off_a");
    const offB = officialScenario("off_b");
    const junk = { id: "off_junk" }; // 缺必填，应被过滤
    mocks.scenarioFetchOfficial.mockResolvedValue(
      http(200, JSON.stringify({ scenarios: [offA, junk, offB] })),
    );
    const { catalog, logic } = await loadModules();

    await expect(catalog.refreshOfficialScenarioCatalog()).resolves.toBeUndefined();

    expect(mocks.scenarioCacheWrite).toHaveBeenCalledTimes(1);
    // 写盘参数 = 过滤后数组的 JSON 文本（对象键序与来料一致）
    expect(mocks.scenarioCacheWrite).toHaveBeenCalledWith(JSON.stringify([offA, offB]));
    expect(logic.listOfficialScenarios().map((s) => s.id)).toEqual(["off_a", "off_b"]);
  });

  it("200 + 裸数组形状同样被接受", async () => {
    const offA = officialScenario("off_a");
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify([offA])));
    const { catalog, logic } = await loadModules();

    await catalog.refreshOfficialScenarioCatalog();

    expect(mocks.scenarioCacheWrite).toHaveBeenCalledWith(JSON.stringify([offA]));
    expect(logic.scenarioOf("off_a").title).toBe("t-off_a");
  });

  it("404（服务端 A3 未上线）→ 不抛、零写盘、已装载缓存不变", async () => {
    const offA = officialScenario("off_a");
    mocks.scenarioCacheRead.mockResolvedValue([offA]);
    mocks.scenarioFetchOfficial.mockResolvedValue(http(404, "Not Found"));
    const { catalog, logic } = await loadModules();

    await expect(catalog.refreshOfficialScenarioCatalog()).resolves.toBeUndefined();

    expect(mocks.scenarioCacheWrite).not.toHaveBeenCalled();
    expect(logic.listOfficialScenarios().map((s) => s.id)).toEqual(["off_a"]);
  });

  it("fetch reject（断网/未登录）→ 不抛、零写盘", async () => {
    mocks.scenarioFetchOfficial.mockRejectedValue(new Error("network down"));
    const { catalog } = await loadModules();

    await expect(catalog.refreshOfficialScenarioCatalog()).resolves.toBeUndefined();

    expect(mocks.scenarioCacheWrite).not.toHaveBeenCalled();
  });

  it("垃圾 body（对象无数组字段）→ 静默不写盘", async () => {
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify({ items: [] })));
    const { catalog } = await loadModules();

    await expect(catalog.refreshOfficialScenarioCatalog()).resolves.toBeUndefined();

    expect(mocks.scenarioCacheWrite).not.toHaveBeenCalled();
  });

  it("「有更新才替换」：与已装载缓存内容相同 → 零写盘", async () => {
    const offA = officialScenario("off_a");
    mocks.scenarioCacheRead.mockResolvedValue([offA]); // 已装载的缓存
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify({ scenarios: [offA] })));
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    await catalog.refreshOfficialScenarioCatalog();

    expect(mocks.scenarioCacheWrite).not.toHaveBeenCalled();
  });

  it("无节流：每次调用都发起新拉取（进 tab 即可见云端上下架）", async () => {
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify([])));
    const { catalog } = await loadModules();

    await catalog.refreshOfficialScenarioCatalog();
    await catalog.refreshOfficialScenarioCatalog();

    expect(mocks.scenarioFetchOfficial).toHaveBeenCalledTimes(2);
  });

  it("in-flight 期并发调用共享同一次请求", async () => {
    let resolveFetch!: (v: SyncHttpText) => void;
    mocks.scenarioFetchOfficial.mockImplementation(
      () => new Promise<SyncHttpText>((r) => { resolveFetch = r; }),
    );
    const { catalog } = await loadModules();

    const p1 = catalog.refreshOfficialScenarioCatalog();
    const p2 = catalog.refreshOfficialScenarioCatalog();
    // refresh 先走 preload（mock 已 resolve，纯微任务链），flush 后请求已发出、
    // 仍未响应（pending promise），此时是真正的 in-flight 窗口
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(mocks.scenarioFetchOfficial).toHaveBeenCalledTimes(1);

    resolveFetch(http(404, "not yet"));
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });
});

describe("officialCatalogSource：官方目录来源三态（catalogBadge）", () => {
  it("空缓存（缓存读失败/首启）→ fallback", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([]);
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("fallback");
  });

  it("非空官方缓存装载 → cache", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([officialScenario("off_a"), officialScenario("off_b")]);
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("cache");
  });

  it("cache 态 refresh 404（端点未上线）→ 仍 cache", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([officialScenario("off_a")]);
    mocks.scenarioFetchOfficial.mockResolvedValue(http(404, "Not Found"));
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    await catalog.refreshOfficialScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("cache");
  });

  it("cache 态 refresh reject（断网/未登录）→ 仍 cache", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([officialScenario("off_a")]);
    mocks.scenarioFetchOfficial.mockRejectedValue(new Error("network down"));
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    await catalog.refreshOfficialScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("cache");
  });

  it("fallback 态 refresh 200 有列表 → server", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([]); // 空缓存 → fallback
    mocks.scenarioFetchOfficial.mockResolvedValue(
      http(200, JSON.stringify({ scenarios: [officialScenario("off_a")] })),
    );
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    expect(catalog.officialCatalogSource()).toBe("fallback");
    await catalog.refreshOfficialScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("server");
  });

  it("refresh 200 但目录为空 → 桶空 → fallback（不变式：fallback ⟺ 官方桶空）", async () => {
    mocks.scenarioCacheRead.mockResolvedValue([officialScenario("off_a")]); // 先 cache
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify({ scenarios: [] })));
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    expect(catalog.officialCatalogSource()).toBe("cache");
    await catalog.refreshOfficialScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("fallback");
  });

  it("refresh 200 且内容与已装载缓存相同 → 零写盘仍算 server（已同步）", async () => {
    const offA = officialScenario("off_a");
    mocks.scenarioCacheRead.mockResolvedValue([offA]);
    mocks.scenarioFetchOfficial.mockResolvedValue(http(200, JSON.stringify({ scenarios: [offA] })));
    const { catalog } = await loadModules();

    await catalog.preloadScenarioCatalog();
    await catalog.refreshOfficialScenarioCatalog();

    expect(catalog.officialCatalogSource()).toBe("server");
    expect(mocks.scenarioCacheWrite).not.toHaveBeenCalled();
  });

  it("OFFICIAL_CATALOG_BADGE 三态文案", async () => {
    const { catalog } = await loadModules();
    expect(catalog.OFFICIAL_CATALOG_BADGE).toEqual({
      server: "云端目录·已同步",
      cache: "云端目录·本地缓存",
      fallback: "内置场景",
    });
  });
});
