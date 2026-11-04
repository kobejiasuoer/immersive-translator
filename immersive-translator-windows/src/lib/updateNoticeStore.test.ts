// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "./updater";

const KEY = "immersive-translator-update-info";
const UPDATE: UpdateInfo = { hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0", releaseNotes: "阅读体验改进" };
let store: typeof import("./updateNoticeStore");
let unsubscribe: (() => void) | undefined;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  store = await import("./updateNoticeStore");
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
});

describe("更新提示元信息共享", () => {
  it("只持久化普通元信息并通知同窗口监听者", () => {
    const listener = vi.fn();
    unsubscribe = store.subscribeUpdateInfo(listener);
    store.publishUpdateInfo({ ...UPDATE, url: "https://example.com", signature: "sensitive", rid: 7 } as UpdateInfo);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(UPDATE);
    expect(listener).toHaveBeenCalledExactlyOnceWith(UPDATE);
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
    expect(store.readKnownUpdate("0.12.0")).toBeNull();
  });

  it("返回副本，监听者修改数据不会污染缓存", () => {
    unsubscribe = store.subscribeUpdateInfo((info) => { info.newVersion = "wrong"; });
    store.publishUpdateInfo(UPDATE);
    const info = store.readKnownUpdate("0.11.1")!;
    info.newVersion = "wrong";
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
  });

  it.each([
    "{broken",
    "null",
    JSON.stringify({ hasUpdate: "yes", currentVersion: "0.11.1", newVersion: "0.12.0" }),
    JSON.stringify({ hasUpdate: true, currentVersion: "0.11.1" }),
    JSON.stringify({ hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.11.1" }),
    JSON.stringify({ hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0", releaseNotes: 42 }),
    JSON.stringify({ hasUpdate: false, currentVersion: "" }),
  ])("忽略损坏缓存：%s", (raw) => {
    localStorage.setItem(KEY, raw);
    expect(store.readKnownUpdate("0.11.1")).toBeNull();
  });

  it("来自另一窗口的 storage 事件同步新版本与无更新状态", () => {
    const listener = vi.fn();
    unsubscribe = store.subscribeUpdateInfo(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(UPDATE) }));
    expect(listener).toHaveBeenCalledExactlyOnceWith(UPDATE);
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
    const noUpdate = { hasUpdate: false, currentVersion: "0.11.1" };
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(noUpdate) }));
    expect(listener).toHaveBeenLastCalledWith(noUpdate);
    expect(store.readKnownUpdate("0.11.1")).toEqual(noUpdate);
  });

  it("忽略其他 key 与无效 storage 事件，取消订阅后不再通知", () => {
    const listener = vi.fn();
    unsubscribe = store.subscribeUpdateInfo(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: JSON.stringify(UPDATE) }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "broken" }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    store.publishUpdateInfo(UPDATE);
    expect(listener).not.toHaveBeenCalled();
  });

  it("存储不可用时仍支持本次运行的读取与通知", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const listener = vi.fn();
    unsubscribe = store.subscribeUpdateInfo(listener);
    store.publishUpdateInfo(UPDATE);
    expect(listener).toHaveBeenCalledExactlyOnceWith(UPDATE);
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
  });

  it.each([
    { name: "新版本", previous: { hasUpdate: false, currentVersion: "0.11.1" }, next: UPDATE },
    { name: "无更新", previous: UPDATE, next: { hasUpdate: false, currentVersion: "0.11.1" } },
  ])("写入失败但读取正常时，$name 结果不退回旧缓存", ({ previous, next }) => {
    localStorage.setItem(KEY, JSON.stringify(previous));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const listener = vi.fn();
    unsubscribe = store.subscribeUpdateInfo(listener);

    store.publishUpdateInfo(next);
    expect(store.readKnownUpdate("0.11.1")).toEqual(next);
    expect(listener).toHaveBeenLastCalledWith(next);
  });

  it("写入恢复后，未订阅时也能读取另一窗口的新缓存", () => {
    localStorage.setItem(KEY, JSON.stringify({ hasUpdate: false, currentVersion: "0.11.1" }));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    store.publishUpdateInfo(UPDATE);
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
    write.mockRestore();

    store.publishUpdateInfo(UPDATE);
    const next = { ...UPDATE, newVersion: "0.13.0" };
    localStorage.setItem(KEY, JSON.stringify(next));
    expect(store.readKnownUpdate("0.11.1")).toEqual(next);
  });

  it("有效跨窗事件可以替换写入失败后保留的内存结果", () => {
    const noUpdate = { hasUpdate: false, currentVersion: "0.11.1" };
    localStorage.setItem(KEY, JSON.stringify(noUpdate));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    unsubscribe = store.subscribeUpdateInfo(vi.fn());
    store.publishUpdateInfo(UPDATE);
    expect(store.readKnownUpdate("0.11.1")).toEqual(UPDATE);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(noUpdate) }));
    expect(store.readKnownUpdate("0.11.1")).toEqual(noUpdate);
    write.mockRestore();
    localStorage.setItem(KEY, JSON.stringify({ ...UPDATE, newVersion: "0.13.0" }));
    expect(store.readKnownUpdate("0.11.1")?.newVersion).toBe("0.13.0");
  });

  it("无更新状态清空之前发现的更新，监听异常不影响发布", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    unsubscribe = store.subscribeUpdateInfo(() => { throw new Error("view unavailable"); });
    store.publishUpdateInfo(UPDATE);
    const noUpdate = { hasUpdate: false, currentVersion: "0.11.1" };
    expect(() => store.publishUpdateInfo(noUpdate)).not.toThrow();
    expect(store.readKnownUpdate("0.11.1")).toEqual(noUpdate);
  });
});
