// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderSettingsContent, SettingsDrawer, type ReaderSettingsContentProps } from "./SettingsDrawer";
import { actAsync, createHarness, findButton, type Harness } from "../views/authTestHarness";
import { DEFAULT_READER_SETTINGS, type ReaderSettings } from "../core/readerTypes";
import {
  currentVoiceChain,
  effectiveShadowAssess,
  type ShadowAssessProjection,
  type VoiceChainProjection,
} from "../lib/voiceSettingsHub";
import { iseCredsConfigured, xfyunTtsCredsConfigured } from "../lib/iseCredentials";
import { authGetStatus, listenAuthStateChanged, openSettings, settingsOpenTab, ttsVoices } from "../lib/tauriBridge";
import { resolveInitialVoiceProvider } from "../lib/settingsStore";
import { reminderGetConfig } from "../lib/reminder";
import { listMicDevices } from "../core/micRecorder";

// 跨窗事件 mock：捕获注册的监听器，测试里手动投递（照 ReaderApp.navigation.test.tsx 惯例）。
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  voicePrefsHandler: null as
    | ((payload: { scopes: string[]; from: string; rev: number }) => void)
    | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return Promise.resolve(() => mocks.listeners.delete(event));
  },
}));

// hub 整体替换：链路/打分链投影与订阅注册都可控（投影归约本身已在 hub 单测覆盖）。
vi.mock("../lib/voiceSettingsHub", () => ({
  currentVoiceChain: vi.fn(),
  effectiveShadowAssess: vi.fn(),
  listenVoicePrefsChanged: (
    handler: (payload: { scopes: string[]; from: string; rev: number }) => void,
  ) => {
    mocks.voicePrefsHandler = handler;
    return Promise.resolve(() => {
      mocks.voicePrefsHandler = null;
    });
  },
}));

vi.mock("../lib/tauriBridge", () => ({
  ttsVoices: vi.fn(),
  authGetStatus: vi.fn(),
  listenAuthStateChanged: vi.fn(),
  settingsOpenTab: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("../lib/iseCredentials", () => ({
  iseCredsConfigured: vi.fn(),
  xfyunTtsCredsConfigured: vi.fn(),
}));

vi.mock("../lib/settingsStore", () => ({
  loadSettings: vi.fn(() => ({
    voiceProvider: "gateway",
    voiceGatewayVoice: "mock-male",
    voiceGatewayIseEnabled: true,
  })),
  resolveInitialVoiceProvider: vi.fn(),
}));

vi.mock("../lib/reminder", () => ({
  reminderGetConfig: vi.fn(),
  reminderSetConfig: vi.fn(),
}));

vi.mock("../core/micRecorder", () => ({
  listMicDevices: vi.fn(),
}));

function makeSettings(overrides: Partial<ReaderSettings> = {}): ReaderSettings {
  return { ...DEFAULT_READER_SETTINGS, ...overrides };
}

function props(overrides: { settings?: ReaderSettings } = {}) {
  return {
    settings: overrides.settings ?? makeSettings(),
    onPatch: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
    micDeviceId: "",
    onMicDevice: vi.fn(),
  };
}

function chainFixture(overrides: Partial<VoiceChainProjection> = {}): VoiceChainProjection {
  return {
    engine: "cloud-gateway",
    label: "云音色 · 沉浸云 · 已登录",
    fallbackNotice: null,
    tone: "ok",
    ...overrides,
  };
}

function assessFixture(overrides: Partial<ShadowAssessProjection> = {}): ShadowAssessProjection {
  return {
    effective: true,
    broken: null,
    links: { mode: true, assess: true, settings: true, server: true },
    ...overrides,
  };
}

/** 投递一条跨窗 voice:prefs-changed（模拟设置窗写盘后的广播）。 */
function deliverVoicePrefs(rev = 1): void {
  mocks.voicePrefsHandler?.({ scopes: ["voicePrefs"], from: "settings", rev });
}

/** 投递一条既有凭据事件（设置窗保存讯飞凭据后广播）。 */
function deliverCredsUpdated(): void {
  mocks.listeners.get("xfyun:creds-updated")?.({ payload: { kind: "main" } });
}

let harness: Harness | null;

async function mount(overrides: { settings?: ReaderSettings } = {}): Promise<Harness> {
  harness = createHarness();
  harness.render(<SettingsDrawer {...props(overrides)} />);
  await actAsync(() => undefined);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.voicePrefsHandler = null;
  vi.mocked(currentVoiceChain).mockResolvedValue(chainFixture());
  vi.mocked(effectiveShadowAssess).mockResolvedValue(assessFixture());
  vi.mocked(iseCredsConfigured).mockResolvedValue(false);
  vi.mocked(xfyunTtsCredsConfigured).mockResolvedValue(false);
  vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
  vi.mocked(ttsVoices).mockResolvedValue([]);
  vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true } as Awaited<ReturnType<typeof authGetStatus>>);
  vi.mocked(listenAuthStateChanged).mockResolvedValue(() => undefined);
  vi.mocked(settingsOpenTab).mockResolvedValue(undefined);
  vi.mocked(openSettings).mockResolvedValue(undefined);
  vi.mocked(reminderGetConfig).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof reminderGetConfig>>,
  );
  vi.mocked(listMicDevices).mockResolvedValue([]);
});

afterEach(() => {
  harness?.unmount();
  harness = null;
});

describe("当前链路行（A-1：hub 订阅实时刷新，替代挂载快照）", () => {
  it("投影未返回时沿用「读取中…」口径，返回后显示归约文案", async () => {
    let resolveChain!: (value: ReturnType<typeof chainFixture>) => void;
    vi.mocked(currentVoiceChain).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChain = resolve;
        }),
    );
    const h = await mount({ settings: makeSettings({ ttsProvider: "cloud" }) });
    expect(h.container.textContent).toContain("当前链路");
    expect(h.container.textContent).toContain("读取中…");
    expect(h.container.textContent).not.toContain("云音色 · 沉浸云 · 已登录");
    await actAsync(() => {
      resolveChain(chainFixture());
      return Promise.resolve();
    });
    expect(h.container.textContent).toContain("云音色 · 沉浸云 · 已登录");
    expect(h.container.textContent).not.toContain("读取中…");
  });

  it("引擎档位变化立即重投影（换 Edge → Edge 文案）", async () => {
    const h = await mount({ settings: makeSettings({ ttsProvider: "cloud" }) });
    expect(h.container.textContent).toContain("云音色 · 沉浸云 · 已登录");
    vi.mocked(currentVoiceChain).mockResolvedValue(
      chainFixture({ engine: "edge", label: "Edge 在线 · 免费直连" }),
    );
    await actAsync(() => {
      harness!.render(<SettingsDrawer {...props({ settings: makeSettings({ ttsProvider: "edge" }) })} />);
    });
    expect(vi.mocked(currentVoiceChain)).toHaveBeenLastCalledWith({ ttsProvider: "edge" });
    expect(h.container.textContent).toContain("Edge 在线 · 免费直连");
  });

  it("voice:prefs-changed / xfyun:creds-updated 都触发链路行重投影", async () => {
    const h = await mount({ settings: makeSettings({ ttsProvider: "cloud" }) });
    const callsAfterMount = vi.mocked(currentVoiceChain).mock.calls.length;
    vi.mocked(currentVoiceChain).mockResolvedValue(
      chainFixture({ label: "云音色 · 讯飞 · 合成凭据已配置 ✓", engine: "cloud-xfyun" }),
    );
    await actAsync(() => {
      deliverVoicePrefs(2);
      return Promise.resolve();
    });
    expect(vi.mocked(currentVoiceChain).mock.calls.length).toBeGreaterThan(callsAfterMount);
    expect(h.container.textContent).toContain("云音色 · 讯飞 · 合成凭据已配置 ✓");
    await actAsync(() => {
      deliverCredsUpdated();
      return Promise.resolve();
    });
    expect(vi.mocked(currentVoiceChain).mock.calls.length).toBeGreaterThan(callsAfterMount + 1);
  });
});

describe("凭据徽标三触发重查（A-2：挂载 + voice:prefs-changed + xfyun:creds-updated）", () => {
  it("评测凭据徽标收到事件后重查存储并刷新（未配置 → 已配置 ✓）", async () => {
    const h = await mount({ settings: makeSettings({ shadowingMode: true }) });
    expect(h.container.textContent).toContain("未配置");
    vi.mocked(iseCredsConfigured).mockResolvedValue(true);
    await actAsync(() => {
      deliverVoicePrefs(1);
      return Promise.resolve();
    });
    expect(iseCredsConfigured).toHaveBeenCalledTimes(2); // 挂载 1 次 + 事件重查 1 次
    expect(h.container.textContent).toContain("已配置 ✓");
  });

  it("既有 xfyun:creds-updated 同样触发徽标重查（hub 不另造凭据事件）", async () => {
    const h = await mount({ settings: makeSettings({ shadowingMode: true }) });
    vi.mocked(iseCredsConfigured).mockResolvedValue(true);
    await actAsync(() => {
      deliverCredsUpdated();
      return Promise.resolve();
    });
    expect(h.container.textContent).toContain("已配置 ✓");
  });
});

describe("跟读打分提示行与打分链 chips（A-3）", () => {
  it("抽屉两开关开 × 沉浸云 × 评分开关关 → 提示行出现，去开启走 settingsOpenTab(\"voice\")", async () => {
    vi.mocked(effectiveShadowAssess).mockResolvedValue(
      assessFixture({
        effective: false,
        broken: "settings",
        links: { mode: true, assess: true, settings: false, server: null },
      }),
    );
    const h = await mount({
      settings: makeSettings({ shadowingMode: true, shadowingAssess: true }),
    });
    expect(h.container.textContent).toContain("跟读打分已在");
    expect(h.container.textContent).toContain("这里开着也不会打分");
    await actAsync(() => findButton(h.container, "去开启").click());
    expect(settingsOpenTab).toHaveBeenCalledWith("voice");
  });

  it("全链开（broken=null）不显示提示行；chips 常驻且全环显 ✓", async () => {
    const h = await mount({
      settings: makeSettings({ shadowingMode: true, shadowingAssess: true }),
    });
    expect(h.container.textContent).not.toContain("跟读打分已在");
    expect(h.container.textContent).toContain("打分链");
    expect(h.container.textContent).toContain("跟读模式");
    expect(h.container.textContent).toContain("评分开关");
    expect(h.container.textContent).toContain("✓");
    expect(h.container.textContent).not.toContain("✗");
  });

  it("跟读模式关 → mode 环显 ✗、下游环显 —（未评估）", async () => {
    vi.mocked(effectiveShadowAssess).mockResolvedValue(
      assessFixture({
        effective: false,
        broken: "mode",
        links: { mode: false, assess: null, settings: null, server: null },
      }),
    );
    const h = await mount({ settings: makeSettings({ shadowingMode: false, shadowingAssess: false }) });
    expect(h.container.textContent).toContain("✗");
    expect(h.container.textContent).toContain("—");
    expect(h.container.textContent).not.toContain("跟读打分已在");
  });

  it("讯飞直连：第四环显示「讯飞评测凭据」而非服务端环，并随凭据重查刷新", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("xfyun");
    vi.mocked(effectiveShadowAssess).mockResolvedValue(
      assessFixture({ links: { mode: true, assess: true, settings: null, server: null } }),
    );
    const h = await mount({ settings: makeSettings({ shadowingMode: true }) });
    expect(h.container.textContent).toContain("讯飞评测凭据");
    expect(h.container.textContent).toContain("—"); // 凭据未配置
    vi.mocked(iseCredsConfigured).mockResolvedValue(true);
    await actAsync(() => {
      deliverCredsUpdated();
      return Promise.resolve();
    });
    expect(h.container.textContent).toContain("✓");
  });
});

describe("抽屉底部总设置入口（2026-11-12）", () => {
  it("主题区之后常驻「打开设置」入口，点击调用 openSettings", async () => {
    const h = await mount();
    expect(h.container.textContent).toContain("模型服务、语音、快捷键和账号在「设置」里调整。");
    // 入口位于主题 grid 之后、抽屉 body 末尾（页脚是 body 的兄弟节点）
    const themeGrid = h.container.querySelector(".theme-grid")!;
    const hint = themeGrid.nextElementSibling!;
    expect(hint.classList.contains("drawer-settings-hint")).toBe(true);
    // 不复用跟读打分警示行的 warn 语义（类名独立，样式改动互不牵连）
    expect(hint.classList.contains("drawer-assess-hint")).toBe(false);
    expect(hint.parentElement?.lastElementChild).toBe(hint);
    expect(h.container.querySelector(".reader-drawer-footer")).not.toBeNull();
    await actAsync(() => findButton(h.container, "打开设置").click());
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe("统一设置中的阅读内容", () => {
  async function mountContent(overrides: Partial<ReaderSettingsContentProps> = {}) {
    const contentProps = { ...props(), ...overrides };
    harness = createHarness();
    harness.render(<ReaderSettingsContent {...contentProps} />);
    await actAsync(() => undefined);
    return { h: harness, contentProps };
  }

  it("不创建第二层抽屉，阅读与复习修改仍交给原作用域回调", async () => {
    const onPatchReview = vi.fn();
    const onReannotate = vi.fn();
    const { h, contentProps } = await mountContent({
      onPatchReview,
      chunkState: "done",
      onReannotate,
    });
    expect(h.container.querySelector('[role="dialog"]')).toBeNull();
    expect(h.container.querySelector(".reader-drawer-overlay, .reader-drawer-header, .reader-drawer-footer")).toBeNull();
    expect(h.container.textContent).not.toContain("恢复默认");
    await actAsync(() => {
      h.container.querySelector<HTMLButtonElement>('[aria-label="增大字号"]')!.click();
      findButton(h.container, "听写").click();
      findButton(h.container, "重新标注").click();
    });
    expect(contentProps.onPatch).toHaveBeenCalledExactlyOnceWith({ fontSize: 20 });
    expect(onPatchReview).toHaveBeenCalledExactlyOnceWith({ reviewMode: "dictation" });
    expect(onReannotate).toHaveBeenCalledOnce();
  });

  it("语音、评分与模型入口在统一设置内切换，不打开其他窗口", async () => {
    vi.mocked(effectiveShadowAssess).mockResolvedValue(assessFixture({
      effective: false,
      broken: "settings",
      links: { mode: true, assess: true, settings: false, server: null },
    }));
    const onOpenSettingsTab = vi.fn();
    const { h } = await mountContent({
      settings: makeSettings({ ttsProvider: "cloud", shadowingMode: true, shadowingAssess: true }),
      onOpenSettingsTab,
    });
    await actAsync(() => {
      findButton(h.container, "去语音页配置").click();
      findButton(h.container, "去开启").click();
      findButton(h.container, "模型服务").click();
    });
    expect(onOpenSettingsTab.mock.calls).toEqual([["voice"], ["voice"], ["provider"]]);
    expect(h.container.textContent).not.toContain("打开设置");
    expect(openSettings).not.toHaveBeenCalled();
    expect(settingsOpenTab).not.toHaveBeenCalled();
  });

  it("讯飞合成与评测凭据入口都切换到同一语音页", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("xfyun");
    const onOpenSettingsTab = vi.fn();
    const { h } = await mountContent({
      settings: makeSettings({ ttsProvider: "cloud", shadowingMode: true }),
      onOpenSettingsTab,
    });
    const credentialButtons = Array.from(h.container.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "配置凭据");
    expect(credentialButtons).toHaveLength(2);
    await actAsync(() => credentialButtons.forEach((button) => button.click()));
    expect(onOpenSettingsTab.mock.calls).toEqual([["voice"], ["voice"]]);
    expect(openSettings).not.toHaveBeenCalled();
    expect(settingsOpenTab).not.toHaveBeenCalled();
  });

  it("同窗语音修订号变化后重查服务商、链路、评分与凭据", async () => {
    const { h, contentProps } = await mountContent({
      settings: makeSettings({ ttsProvider: "cloud", shadowingMode: true }),
      voicePrefsRevision: 0,
    });
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("xfyun");
    vi.mocked(xfyunTtsCredsConfigured).mockResolvedValue(true);
    vi.mocked(iseCredsConfigured).mockResolvedValue(true);
    vi.mocked(currentVoiceChain).mockResolvedValue(chainFixture({
      engine: "cloud-xfyun",
      label: "云音色 · 讯飞 · 合成凭据已配置 ✓",
    }));
    await actAsync(() => {
      h.render(<ReaderSettingsContent {...contentProps} voicePrefsRevision={1} />);
    });
    expect(resolveInitialVoiceProvider).toHaveBeenCalledTimes(2);
    expect(currentVoiceChain).toHaveBeenCalledTimes(2);
    expect(effectiveShadowAssess).toHaveBeenCalledTimes(2);
    expect(xfyunTtsCredsConfigured).toHaveBeenCalledTimes(2);
    expect(iseCredsConfigured).toHaveBeenCalledTimes(2);
    expect(h.container.textContent).toContain("云音色 · 讯飞 · 合成凭据已配置 ✓");
  });
});
