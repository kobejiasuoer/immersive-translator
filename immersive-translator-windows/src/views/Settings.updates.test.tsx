// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { DEFAULT_SETTINGS, loadSettingsFullAsync } from "../lib/settingsStore";
import { checkForUpdate, downloadAndInstall, isStorePackaged, type UpdateInfo } from "../lib/updater";
import { readKnownUpdate, subscribeUpdateInfo } from "../lib/updateNoticeStore";
import { actAsync, createHarness, findButton, type Harness } from "./authTestHarness";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.11.1") }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => Promise.resolve(false), enable: () => Promise.resolve(), disable: () => Promise.resolve(),
}));
vi.mock("../lib/settingsStore", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/settingsStore")>(),
  loadSettingsFullAsync: vi.fn(), isOnboardingDismissed: () => true,
}));
vi.mock("../lib/tauriBridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/tauriBridge")>(),
  authServerBaseUrl: () => Promise.resolve(null),
  settingsTakePendingTab: () => Promise.resolve("about"),
  listenSettingsNavigateTab: () => Promise.resolve(() => undefined),
  ocrModelsReady: () => Promise.resolve(true),
  onDownloadProgress: () => Promise.resolve(() => undefined),
}));
vi.mock("./AccountSection", () => ({
  AccountSection: () => null,
  useAccountStatus: () => ({ status: { loggedIn: false, user: null, notice: null } }),
}));
vi.mock("./VoiceSettingsTab", () => ({ VoiceSettingsTab: () => null }));
vi.mock("../lib/updater", () => ({
  checkForUpdate: vi.fn(), downloadAndInstall: vi.fn(), isStorePackaged: vi.fn(),
}));
vi.mock("../lib/updateNoticeStore", () => ({ readKnownUpdate: vi.fn(), subscribeUpdateInfo: vi.fn() }));

const INFO: UpdateInfo = { hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0" };
let harness: Harness | null;
let receive: ((info: UpdateInfo) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness = null;
  receive = null;
  vi.mocked(loadSettingsFullAsync).mockResolvedValue({ settings: { ...DEFAULT_SETTINGS }, vault: {} });
  vi.mocked(isStorePackaged).mockResolvedValue(false);
  vi.mocked(readKnownUpdate).mockReturnValue(INFO);
  vi.mocked(checkForUpdate).mockResolvedValue(INFO);
  vi.mocked(downloadAndInstall).mockResolvedValue(undefined);
  vi.mocked(subscribeUpdateInfo).mockImplementation((listener) => {
    receive = listener;
    return () => undefined;
  });
});

afterEach(() => { harness?.unmount(); });

async function mount() {
  harness = createHarness();
  harness.render(<Settings />);
  await actAsync(() => undefined);
  return harness;
}

describe("关于页与主动更新提示联动", () => {
  it("打开关于页直接呈现后台发现的版本，不需要再点击检查", async () => {
    const h = await mount();
    expect(findButton(h.container, "升级到 v0.12.0").disabled).toBe(false);
    expect(checkForUpdate).not.toHaveBeenCalled();
    await actAsync(() => receive?.({ ...INFO, newVersion: "0.13.0" }));
    expect(findButton(h.container, "升级到 v0.13.0").disabled).toBe(false);
    await actAsync(() => receive?.({ hasUpdate: false, currentVersion: "0.11.1" }));
    expect(h.container.textContent).not.toContain("升级到");
  });

  it("商店版和身份检测失败时不采用 EXE 更新缓存", async () => {
    vi.mocked(isStorePackaged).mockResolvedValue(true);
    const h = await mount();
    await actAsync(() => receive?.(INFO));
    expect(h.container.textContent).not.toContain("升级到");
    expect(readKnownUpdate).not.toHaveBeenCalled();
    h.unmount();
    harness = null;
    vi.mocked(isStorePackaged).mockRejectedValue(new Error("IPC unavailable"));
    const unavailable = await mount();
    expect(unavailable.container.textContent).not.toContain("升级到");
    expect(readKnownUpdate).not.toHaveBeenCalled();
  });

  it("下载中阻止重复操作，后台结果不能覆盖进度，失败后仍可重试", async () => {
    const h = await mount();
    let fail!: (error: Error) => void;
    vi.mocked(downloadAndInstall).mockImplementationOnce((onProgress) => {
      onProgress({ stage: "downloading", message: "正在下载… 1 MB / 2 MB", progress: 0.5 });
      return new Promise((_, reject) => { fail = reject; });
    });
    await actAsync(() => findButton(h.container, "升级到 v0.12.0").click());
    expect(findButton(h.container, "检查更新").disabled).toBe(true);
    await actAsync(() => receive?.({ ...INFO, newVersion: "0.13.0" }));
    expect(h.container.textContent).toContain("正在下载… 1 MB / 2 MB");
    await actAsync(() => findButton(h.container, "检查更新").click());
    expect(checkForUpdate).not.toHaveBeenCalled();
    await actAsync(() => fail(new Error("download failed")));
    expect(h.container.textContent).toContain("更新失败");
    expect(findButton(h.container, "升级到 v0.12.0").disabled).toBe(false);
    await actAsync(() => findButton(h.container, "升级到 v0.12.0").click());
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
  });
});
