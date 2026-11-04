// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, isStorePackaged, type UpdateInfo } from "./updater";
import { readKnownUpdate, subscribeUpdateInfo } from "./updateNoticeStore";
import { useProactiveUpdate } from "./useProactiveUpdate";
import { actAsync, createHarness, type Harness } from "../views/authTestHarness";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("./updater", () => ({ checkForUpdate: vi.fn(), isStorePackaged: vi.fn() }));
vi.mock("./updateNoticeStore", () => ({ readKnownUpdate: vi.fn(), subscribeUpdateInfo: vi.fn() }));

const INTERVAL = 2 * 60 * 60 * 1000;
const NEW_VERSION: UpdateInfo = { hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0" };
let harness: Harness | null;
let receive: ((info: UpdateInfo) => void) | null;
const unsubscribe = vi.fn<() => void>();

function Probe() {
  const info = useProactiveUpdate();
  return <span>{info?.newVersion ?? ""}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T08:00:00Z"));
  vi.clearAllMocks();
  harness = null;
  receive = null;
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.mocked(getVersion).mockResolvedValue("0.11.1");
  vi.mocked(isStorePackaged).mockResolvedValue(false);
  vi.mocked(checkForUpdate).mockResolvedValue(NEW_VERSION);
  vi.mocked(readKnownUpdate).mockReturnValue(null);
  vi.mocked(subscribeUpdateInfo).mockImplementation((listener) => {
    receive = listener;
    return unsubscribe;
  });
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  harness?.unmount();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(strict = false) {
  harness = createHarness();
  harness.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />);
  return harness;
}

async function advance(ms: number) {
  await actAsync(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("主窗口主动检查更新", () => {
  it("StrictMode 启动延迟后只检查一次，卸载清除周期与监听", async () => {
    const h = mount(true);
    await advance(9_999);
    expect(checkForUpdate).not.toHaveBeenCalled();
    await advance(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).toBe("0.12.0");
    h.unmount();
    harness = null;
    await advance(INTERVAL * 2);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("浏览器预览和商店版都不访问更新器或展示缓存", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const h = mount();
    await advance(INTERVAL);
    expect(isStorePackaged).not.toHaveBeenCalled();
    h.unmount();
    harness = null;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.mocked(isStorePackaged).mockResolvedValue(true);
    vi.mocked(readKnownUpdate).mockReturnValue(NEW_VERSION);
    const store = mount();
    await advance(INTERVAL * 2);
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(readKnownUpdate).not.toHaveBeenCalled();
    expect(store.container.textContent).toBe("");
  });

  it("频繁聚焦不重复请求，到期且检查未结束时仍只保留一个请求", async () => {
    mount();
    await advance(10_000);
    await actAsync(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    let finish!: (info: UpdateInfo) => void;
    vi.mocked(checkForUpdate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await advance(INTERVAL);
    await actAsync(() => { window.dispatchEvent(new Event("focus")); });
    await advance(INTERVAL);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
    await actAsync(() => finish(NEW_VERSION));
  });

  it("断网启动不发请求，恢复网络后补查", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const h = mount();
    await advance(10_000);
    expect(checkForUpdate).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    await actAsync(() => { window.dispatchEvent(new Event("online")); });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).toBe("0.12.0");
  });

  it("身份检测和网络异常保持静默，到下一周期可恢复", async () => {
    vi.mocked(isStorePackaged).mockRejectedValueOnce(new Error("IPC unavailable"));
    const h = mount();
    await advance(10_000);
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(h.container.textContent).toBe("");
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("offline"));
    await advance(INTERVAL);
    expect(h.container.textContent).toBe("");
    await advance(INTERVAL);
    expect(h.container.textContent).toBe("0.12.0");
  });

  it("网络失败后恢复联网会立即补查，不必等下一个两小时周期", async () => {
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("network unavailable"));
    const h = mount();
    await advance(10_000);
    expect(h.container.textContent).toBe("");
    await actAsync(() => { window.dispatchEvent(new Event("online")); });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
    expect(h.container.textContent).toBe("0.12.0");
    await actAsync(() => { window.dispatchEvent(new Event("online")); });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("接收同版本应用的跨窗结果，无更新时清除提示，网络失败保留已知版本", async () => {
    const h = mount();
    await advance(10_000);
    await actAsync(() => receive?.({ ...NEW_VERSION, currentVersion: "0.10.0", newVersion: "0.13.0" }));
    expect(h.container.textContent).toBe("0.12.0");
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("offline"));
    await advance(INTERVAL);
    expect(h.container.textContent).toBe("0.12.0");
    await actAsync(() => receive?.({ hasUpdate: false, currentVersion: "0.11.1" }));
    expect(h.container.textContent).toBe("");
  });

  it("卸载后结束的身份检测不会继续发请求", async () => {
    let finish!: (store: boolean) => void;
    vi.mocked(isStorePackaged).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const h = mount();
    await advance(10_000);
    h.unmount();
    harness = null;
    await actAsync(() => finish(false));
    expect(getVersion).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});
