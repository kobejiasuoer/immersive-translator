// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings, type SettingsTab } from "./Settings";
import type { VoiceSettingsTabProps } from "./VoiceSettingsTab";
import { DEFAULT_SETTINGS, loadSettingsFullAsync, saveSettingsFullAsync } from "../lib/settingsStore";
import { listenSettingsNavigateTab, settingsTakePendingTab, reregisterHotkeys } from "../lib/tauriBridge";
import { writeVoicePrefs } from "../lib/voiceSettingsHub";
import { actAsync, createHarness, findButton, setInputValue, type Harness } from "./authTestHarness";

const { hideWindow } = vi.hoisted(() => ({ hideWindow: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.11.1") }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: hideWindow }) }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => Promise.resolve(false), enable: () => Promise.resolve(), disable: () => Promise.resolve(),
}));
vi.mock("../lib/settingsStore", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/settingsStore")>(),
  loadSettingsFullAsync: vi.fn(),
  saveSettingsFullAsync: vi.fn().mockResolvedValue(undefined),
  isOnboardingDismissed: () => true,
}));
vi.mock("../lib/tauriBridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/tauriBridge")>(),
  authServerBaseUrl: () => Promise.resolve(null),
  settingsTakePendingTab: vi.fn().mockResolvedValue("provider"),
  listenSettingsNavigateTab: vi.fn().mockResolvedValue(() => undefined),
  getActiveHotkeys: () => Promise.reject(new Error("invoke unavailable")),
  reregisterHotkeys: vi.fn().mockResolvedValue("ok"),
  ocrModelsReady: () => Promise.resolve(true),
  onDownloadProgress: () => Promise.resolve(() => undefined),
}));
vi.mock("../lib/voiceSettingsHub", () => ({ writeVoicePrefs: vi.fn() }));
vi.mock("./AccountSection", () => ({
  AccountSection: () => null,
  useAccountStatus: () => ({ status: { loggedIn: false, user: null, notice: null } }),
}));
vi.mock("./VoiceSettingsTab", () => ({
  VoiceSettingsTab: (props: VoiceSettingsTabProps) => (
    <div>
      <span>当前音色：{props.voiceGatewayVoice}</span>
      <button onClick={() => props.onSelectVoice("test-voice")}>选择新音色</button>
      <button onClick={props.onOpenRedeem}>兑换更多额度</button>
    </div>
  ),
}));

let harness: Harness | null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness = null;
  vi.mocked(loadSettingsFullAsync).mockResolvedValue({ settings: { ...DEFAULT_SETTINGS }, vault: {} });
});

afterEach(() => { harness?.unmount(); });

function readingContent(navigate: (tab: SettingsTab) => void) {
  return <button onClick={() => navigate("voice")}>配置朗读音色</button>;
}

async function mount(props: Parameters<typeof Settings>[0] = {}) {
  harness = createHarness();
  harness.render(<Settings renderReading={readingContent} onClose={() => undefined} {...props} />);
  await actAsync(() => undefined);
  return harness;
}

function press(key: string, modifiers: KeyboardEventInit = {}, target: EventTarget = harness!.container.querySelector("button")!) {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers })));
}

function modelInput(h: Harness) {
  const input = h.container.querySelector<HTMLInputElement>('input[placeholder="gpt-4o-mini"]');
  if (!input) throw new Error("model input not found");
  return input;
}

describe("阅读室内的统一设置", () => {
  it("配置和密钥读取完成前禁止编辑、保存和重置，保存使用真实配置与完整密钥库", async () => {
    let finish!: (value: Awaited<ReturnType<typeof loadSettingsFullAsync>>) => void;
    vi.mocked(loadSettingsFullAsync).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const h = await mount({ initialTab: "provider", onClose });
    expect(h.container.textContent).toContain("正在读取设置…");
    expect(h.container.querySelector("input")).toBeNull();
    expect(findButton(h.container, "保存设置").disabled).toBe(true);
    await actAsync(() => findButton(h.container, "保存设置").click());
    expect(saveSettingsFullAsync).not.toHaveBeenCalled();
    await actAsync(() => findButton(h.container, "关于").click());
    expect(h.container.textContent).not.toContain("恢复默认");
    await actAsync(() => findButton(h.container, "语音").click());
    expect(h.container.textContent).not.toContain("选择新音色");
    await actAsync(() => findButton(h.container, "关闭").click());
    expect(onClose).toHaveBeenCalledOnce();

    const persisted = { ...DEFAULT_SETTINGS, model: "stored-model", apiKey: "test-existing-key" };
    const vault = { [persisted.providerId!]: "test-existing-key", other: "test-other-key" };
    await actAsync(() => finish({ settings: persisted, vault }));
    await actAsync(() => findButton(h.container, "模型服务").click());
    expect(modelInput(h).value).toBe("stored-model");
    expect(findButton(h.container, "保存设置").disabled).toBe(false);
    await actAsync(() => findButton(h.container, "保存设置").click());
    expect(saveSettingsFullAsync).toHaveBeenCalledExactlyOnceWith(persisted, vault);
  });

  it("读取失败保持保存禁用，重试成功后才显示已保存的配置", async () => {
    vi.mocked(loadSettingsFullAsync).mockRejectedValueOnce(new Error("vault unavailable"));
    const h = await mount({ initialTab: "provider" });
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("设置读取失败");
    expect(h.container.querySelector("input")).toBeNull();
    expect(findButton(h.container, "保存设置").disabled).toBe(true);
    expect(saveSettingsFullAsync).not.toHaveBeenCalled();
    vi.mocked(loadSettingsFullAsync).mockResolvedValueOnce({ settings: { ...DEFAULT_SETTINGS, model: "reloaded-model" }, vault: {} });
    await actAsync(() => findButton(h.container, "重新读取").click());
    expect(modelInput(h).value).toBe("reloaded-model");
    expect(findButton(h.container, "保存设置").disabled).toBe(false);
    expect(loadSettingsFullAsync).toHaveBeenCalledTimes(2);
    expect(saveSettingsFullAsync).not.toHaveBeenCalled();
  });

  it("阅读和语音共用导航与底栏，不抢读 ReaderApp 管理的窗口导航", async () => {
    const onTabChange = vi.fn();
    const h = await mount({ onTabChange });
    expect(h.container.querySelectorAll('[aria-label="设置分类"]')).toHaveLength(1);
    expect(h.container.querySelectorAll(".save-bar")).toHaveLength(1);
    expect(h.container.textContent).toContain("阅读设置即时保存");
    expect(h.container.textContent).not.toContain("保存设置");
    expect(settingsTakePendingTab).not.toHaveBeenCalled();
    expect(listenSettingsNavigateTab).not.toHaveBeenCalled();

    await actAsync(() => findButton(h.container, "配置朗读音色").click());
    expect(h.container.textContent).toContain("当前音色");
    expect(onTabChange).toHaveBeenCalledWith("voice");
    await actAsync(() => findButton(h.container, "阅读与练习").click());
    expect(h.container.textContent).toContain("配置朗读音色");
  });

  it("外部指定页签时不会把旧页签回传覆盖新导航", async () => {
    const onTabChange = vi.fn();
    const h = await mount({ initialTab: "reading", onTabChange });
    h.render(<Settings renderReading={readingContent} initialTab="hotkeys" onClose={() => undefined} onTabChange={(tab) => onTabChange(tab)} />);
    expect(h.container.querySelector("#hotkey-translate")).not.toBeNull();
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("兑换和恢复默认的失败跳转都回传目标页签", async () => {
    const onTabChange = vi.fn();
    const h = await mount({ initialTab: "voice", onTabChange });
    await actAsync(() => findButton(h.container, "兑换更多额度").click());
    expect(onTabChange).toHaveBeenLastCalledWith("account");
    await actAsync(() => findButton(h.container, "关于").click());
    vi.mocked(reregisterHotkeys).mockRejectedValueOnce(new Error("hotkey unavailable"));
    await actAsync(() => findButton(h.container, "恢复默认").click());
    const dialog = h.container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    await actAsync(() => findButton(dialog, "恢复默认").click());
    expect(onTabChange).toHaveBeenLastCalledWith("hotkeys");
    expect(h.container.querySelector("#hotkey-translate")).not.toBeNull();
  });

  it("语音偏好保存后通知同窗消费者，仍不污染模型保存状态", async () => {
    const onVoicePrefsChanged = vi.fn();
    const h = await mount({ initialTab: "voice", onVoicePrefsChanged });
    await actAsync(() => findButton(h.container, "选择新音色").click());
    expect(writeVoicePrefs).toHaveBeenCalledExactlyOnceWith({ voiceGatewayVoice: "test-voice" });
    expect(onVoicePrefsChanged).toHaveBeenCalledOnce();
    expect(vi.mocked(writeVoicePrefs).mock.invocationCallOrder[0]).toBeLessThan(onVoicePrefsChanged.mock.invocationCallOrder[0]);
    expect(h.container.textContent).toContain("当前音色：test-voice");
    expect(h.container.textContent).not.toContain("有未保存的更改");
  });

  it("关闭和 Esc 只关闭设置面板，不隐藏阅读室窗口", async () => {
    const onClose = vi.fn();
    const h = await mount({ onClose });
    await actAsync(() => findButton(h.container, "关闭").click());
    expect(onClose).toHaveBeenCalledOnce();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("设置内按键不触发背景阅读和练习快捷键，Tab 保留浏览器焦点移动", async () => {
    const onDocumentKey = vi.fn();
    const onWindowKey = vi.fn();
    document.addEventListener("keydown", onDocumentKey);
    window.addEventListener("keydown", onWindowKey);
    window.addEventListener("keyup", onWindowKey);
    try {
      const onClose = vi.fn();
      const h = await mount({ onClose });
      const button = findButton(h.container, "阅读与练习");
      for (const key of ["e", " ", "j", "k", "Tab", "Enter", "1", "2", "3"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        act(() => button.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
        act(() => button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })));
      }
      press("Escape", {}, button);
      expect(onClose).toHaveBeenCalledOnce();
      expect(onDocumentKey).not.toHaveBeenCalled();
      expect(onWindowKey).not.toHaveBeenCalled();
      // 仅隔离设置内部；背景恢复焦点后继续使用原有按键监听。
      press("e", {}, document.body);
      expect(onDocumentKey).toHaveBeenCalledOnce();
      expect(onWindowKey).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("keydown", onDocumentKey);
      window.removeEventListener("keydown", onWindowKey);
      window.removeEventListener("keyup", onWindowKey);
    }
  });

  it("隐藏再打开保留模型草稿，隐藏时 Esc 不处理，阅读页仍可保存未提交的模型修改", async () => {
    const onClose = vi.fn();
    const h = await mount({ initialTab: "provider", onClose });
    act(() => setInputValue(modelInput(h), "my-unsaved-model"));
    h.render(<Settings renderReading={readingContent} initialTab="provider" onClose={onClose} visible={false} />);
    press("Escape", {}, window);
    expect(onClose).not.toHaveBeenCalled();
    h.render(<Settings renderReading={readingContent} initialTab="provider" onClose={onClose} visible />);
    expect(modelInput(h).value).toBe("my-unsaved-model");
    expect(h.container.textContent).toContain("有未保存的更改");
    await actAsync(() => findButton(h.container, "阅读与练习").click());
    expect(findButton(h.container, "保存设置").disabled).toBe(false);
    expect(loadSettingsFullAsync).toHaveBeenCalledOnce();
  });

  it("Esc 优先取消热键录制，隐藏面板会停止录制", async () => {
    const onClose = vi.fn();
    const h = await mount({ initialTab: "hotkeys", onClose });
    const firstCard = h.container.querySelector<HTMLElement>(".hotkey-card")!;
    await actAsync(() => findButton(firstCard, "录制组合键").click());
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(firstCard.textContent).not.toContain("取消录制");

    await actAsync(() => findButton(firstCard, "录制组合键").click());
    const before = h.container.querySelector<HTMLInputElement>("#hotkey-translate")!.value;
    h.render(<Settings renderReading={readingContent} initialTab="hotkeys" onClose={onClose} visible={false} />);
    press("t", { ctrlKey: true, shiftKey: true });
    h.render(<Settings renderReading={readingContent} initialTab="hotkeys" onClose={onClose} visible />);
    expect(h.container.querySelector<HTMLInputElement>("#hotkey-translate")!.value).toBe(before);
    expect(firstCard.textContent).not.toContain("取消录制");
  });

  it("恢复默认确认中的 Esc 只取消确认，不关闭统一设置", async () => {
    const onClose = vi.fn();
    const h = await mount({ initialTab: "about", onClose });
    await actAsync(() => findButton(h.container, "恢复默认").click());
    expect(h.container.querySelector('[role="alertdialog"]')).not.toBeNull();
    press("Escape");
    expect(h.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
