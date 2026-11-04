// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { Settings } from "./Settings";
import { DEFAULT_SETTINGS, loadSettingsFullAsync } from "../lib/settingsStore";
import { reregisterHotkeys, getActiveHotkeys } from "../lib/tauriBridge";
import { actAsync, createHarness, findButton, setInputValue, type Harness } from "./authTestHarness";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("0.11.1"),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => Promise.resolve(false),
  enable: () => Promise.resolve(),
  disable: () => Promise.resolve(),
}));
vi.mock("../lib/settingsStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/settingsStore")>();
  return {
    ...original,
    loadSettingsFullAsync: vi.fn(),
    saveSettingsFullAsync: vi.fn().mockResolvedValue(undefined),
    isOnboardingDismissed: () => true,
  };
});
vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...original,
    reregisterHotkeys: vi.fn().mockResolvedValue("ok"),
    getActiveHotkeys: vi.fn(),
    authServerBaseUrl: () => Promise.resolve(null),
    settingsTakePendingTab: () => Promise.resolve("hotkeys"),
    listenSettingsNavigateTab: () => Promise.resolve(() => undefined),
    ocrModelsReady: () => Promise.resolve(true),
    onDownloadProgress: () => Promise.resolve(() => undefined),
  };
});
vi.mock("./AccountSection", () => ({
  AccountSection: () => null,
  useAccountStatus: () => ({ status: { loggedIn: false, user: null, notice: null } }),
}));
vi.mock("./VoiceSettingsTab", () => ({ VoiceSettingsTab: () => null }));

let harness: Harness | null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness = null;
  vi.mocked(loadSettingsFullAsync).mockResolvedValue({
    settings: { ...DEFAULT_SETTINGS },
    vault: {},
  });
  vi.mocked(reregisterHotkeys).mockResolvedValue("ok");
  // 默认让自愈读后端失败（等价单测环境无 invoke），个别用例自行 mockResolvedValue
  vi.mocked(getActiveHotkeys).mockRejectedValue(new Error("invoke unavailable"));
});

afterEach(() => {
  harness?.unmount();
  harness = null;
});

async function mount(): Promise<Harness> {
  harness = createHarness();
  harness.render(<Settings />);
  await actAsync(() => undefined);
  return harness;
}

function input(h: Harness, kind: "translate" | "ocr" | "reader"): HTMLInputElement {
  const field = h.container.querySelector<HTMLInputElement>(`#hotkey-${kind}`);
  if (!field) throw new Error(`hotkey input not found: ${kind}`);
  return field;
}

function row(h: Harness, kind: "translate" | "ocr" | "reader"): HTMLElement {
  const fieldRow = input(h, kind).closest<HTMLElement>(".hotkey-card");
  if (!fieldRow) throw new Error(`hotkey row not found: ${kind}`);
  return fieldRow;
}

function edit(h: Harness, kind: "translate" | "ocr" | "reader", value: string): void {
  act(() => setInputValue(input(h, kind), value));
}

function press(key: string, modifiers: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
  });
}

describe("快捷键设置", () => {
  it("一次提交规范化后的三组热键，注册中禁止重复提交", async () => {
    const h = await mount();
    edit(h, "translate", "shift + ctrl + t");
    edit(h, "ocr", "ctrl + alt + e");
    edit(h, "reader", "ctrl + shift + r");
    let finish!: (value: string) => void;
    vi.mocked(reregisterHotkeys).mockImplementationOnce(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));
    const apply = findButton(h.container, "立即生效");
    await actAsync(() => apply.click());
    expect(reregisterHotkeys).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+T", "Ctrl+Alt+E", "Ctrl+Shift+R");
    expect(apply.disabled).toBe(true);
    expect(findButton(h.container, "保存设置").disabled).toBe(true);
    await actAsync(() => apply.click());
    expect(reregisterHotkeys).toHaveBeenCalledTimes(1);
    await actAsync(() => finish("ok"));
    expect(apply.disabled).toBe(false);
  });

  it("修饰键顺序和大小写不同的重复组合仍不能注册", async () => {
    const h = await mount();
    edit(h, "translate", "shift + ctrl + e");
    await actAsync(() => findButton(h.container, "立即生效").click());
    expect(reregisterHotkeys).not.toHaveBeenCalled();
    expect(h.container.textContent).toContain("不能相同");
  });

  it("任一功能的组合无效时禁用统一应用，风险提示不阻止合法组合", async () => {
    const h = await mount();
    edit(h, "ocr", "E");
    expect(findButton(h.container, "立即生效").disabled).toBe(true);
    edit(h, "ocr", "Alt+E");
    expect(row(h, "ocr").textContent).toContain("菜单助记符冲突");
    expect(findButton(h.container, "立即生效").disabled).toBe(false);
    await actAsync(() => findButton(h.container, "立即生效").click());
    expect(reregisterHotkeys).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+Q", "Alt+E", "Ctrl+Shift+R");
  });

  it("切换录制功能后组合只写入当前行", async () => {
    const h = await mount();
    act(() => findButton(row(h, "translate"), "录制组合键").click());
    act(() => findButton(row(h, "ocr"), "录制组合键").click());
    press("t", { ctrlKey: true, shiftKey: true });
    expect(input(h, "translate").value).toBe("Ctrl+Shift+Q");
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+T");
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
    expect(row(h, "ocr").textContent).not.toContain("取消录制");
  });

  it("Esc 取消录制并清除提示，后续按键不再修改配置", async () => {
    const h = await mount();
    act(() => findButton(row(h, "reader"), "录制组合键").click());
    press("Escape");
    expect(row(h, "reader").textContent).not.toContain("取消录制");
    expect(row(h, "reader").textContent).not.toContain("请按下");
    press("t", { ctrlKey: true, shiftKey: true });
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
  });

  it("离开快捷键页后清除录制，返回时不恢复旧录制", async () => {
    const h = await mount();
    act(() => findButton(row(h, "reader"), "录制组合键").click());
    expect(findButton(h.container, "保存设置").disabled).toBe(true);
    act(() => findButton(h.container, "翻译").click());
    act(() => findButton(h.container, "快捷键").click());
    expect(row(h, "reader").textContent).not.toContain("取消录制");
    expect(row(h, "reader").textContent).not.toContain("请按下");
    press("t", { ctrlKey: true, shiftKey: true });
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
    expect(findButton(h.container, "保存设置").disabled).toBe(false);
  });

  it("窗口失焦取消录制并允许应用，后续按键不会写入配置", async () => {
    const h = await mount();
    act(() => findButton(row(h, "ocr"), "录制组合键").click());
    expect(findButton(h.container, "立即生效").disabled).toBe(true);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(row(h, "ocr").textContent).not.toContain("取消录制");
    expect(row(h, "ocr").textContent).not.toContain("请按下");
    press("t", { ctrlKey: true, shiftKey: true });
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+E");
    const apply = findButton(h.container, "立即生效");
    expect(apply.disabled).toBe(false);
    await actAsync(() => apply.click());
    expect(reregisterHotkeys).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+Q", "Ctrl+Shift+E", "Ctrl+Shift+R");
  });

  it("录到无修饰键或系统保留键时保持录制，直到获得可用组合", async () => {
    const h = await mount();
    act(() => findButton(row(h, "reader"), "录制组合键").click());
    press("t");
    expect(row(h, "reader").textContent).toContain("至少一个修饰键");
    expect(findButton(row(h, "reader"), "取消录制")).toBeTruthy();
    press("l", { metaKey: true });
    expect(row(h, "reader").textContent).toContain("Win+L");
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
    press("t", { ctrlKey: true, altKey: true });
    expect(input(h, "reader").value).toBe("Ctrl+Alt+T");
    expect(row(h, "reader").textContent).not.toContain("取消录制");
  });

  it("推荐项排除其他功能已用组合，选择时只修改当前功能", async () => {
    const h = await mount();
    edit(h, "translate", "shift + ctrl + q");
    const ocrRow = row(h, "ocr");
    const recommendations = ocrRow.querySelector<HTMLDetailsElement>("details");
    if (!recommendations) throw new Error("hotkey recommendations not found");
    act(() => {
      recommendations.open = true;
      recommendations.dispatchEvent(new Event("toggle"));
    });
    const occupied = findButton(ocrRow, "Ctrl+Shift+Q");
    expect(occupied.disabled).toBe(true);
    act(() => occupied.click());
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+E");
    act(() => findButton(ocrRow, "Ctrl+Shift+T").click());
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+T");
    expect(input(h, "translate").value).toBe("shift + ctrl + q");
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
    expect(reregisterHotkeys).not.toHaveBeenCalled();
  });
});

describe("热键自愈与持久化", () => {
  it("「立即生效」把规范化后的热键立即写进 localStorage，不等「保存设置」", async () => {
    const h = await mount();
    edit(h, "ocr", "ctrl + shift + j");
    await actAsync(() => findButton(h.container, "立即生效").click());
    expect(reregisterHotkeys).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+Q", "Ctrl+Shift+J", "Ctrl+Shift+R");
    const persisted = JSON.parse(localStorage.getItem("immersive-translator-settings") ?? "{}");
    expect(persisted).toMatchObject({
      hotkey: "Ctrl+Shift+Q",
      ocrHotkey: "Ctrl+Shift+J",
      readerHotkey: "Ctrl+Shift+R",
    });
  });

  it("UI 与后端脱节时进入快捷键页自愈显示真实生效键，且不触发重注册", async () => {
    // 模拟历史 bug 现场：localStorage/UI 显示默认 E，后端实际恢复 J
    vi.mocked(getActiveHotkeys).mockResolvedValue(["Ctrl+Shift+Q", "Ctrl+Shift+J", "Ctrl+Shift+R"]);
    const h = await mount();
    await actAsync(() => undefined);
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+J");
    expect(input(h, "translate").value).toBe("Ctrl+Shift+Q");
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
    // 表单与快照一致（无未保存修改）→ 点「保存设置」不应把已生效键再注册一遍
    await actAsync(() => findButton(h.container, "保存设置").click());
    expect(reregisterHotkeys).not.toHaveBeenCalled();
  });

  it("自愈不覆盖 fetch 返回前用户的未保存编辑", async () => {
    let resolveActive!: (value: [string, string, string]) => void;
    vi.mocked(getActiveHotkeys).mockImplementationOnce(
      () => new Promise((resolve) => { resolveActive = resolve; }),
    );
    const h = await mount();
    edit(h, "ocr", "Ctrl+Shift+T");
    await actAsync(() => resolveActive(["Ctrl+Shift+Q", "Ctrl+Shift+J", "Ctrl+Shift+R"]));
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+T");
    expect(input(h, "translate").value).toBe("Ctrl+Shift+Q");
    expect(input(h, "reader").value).toBe("Ctrl+Shift+R");
  });

  it("后端与 UI 一致时不做任何自愈动作", async () => {
    vi.mocked(getActiveHotkeys).mockResolvedValue(["Ctrl+Shift+Q", "Ctrl+Shift+E", "Ctrl+Shift+R"]);
    const h = await mount();
    await actAsync(() => undefined);
    expect(input(h, "ocr").value).toBe("Ctrl+Shift+E");
    // setSettings 未产生新渲染即无状态变化：热键 dirty 标记保持干净
    await actAsync(() => findButton(h.container, "保存设置").click());
    expect(reregisterHotkeys).not.toHaveBeenCalled();
  });

  it("「恢复默认」也重注册后端热键，不留下 UI/后端脱节", async () => {
    const h = await mount();
    act(() => findButton(h.container, "关于").click());
    act(() => findButton(h.container, "恢复默认").click());
    const dialog = h.container.querySelector('[role="alertdialog"]');
    if (!dialog) throw new Error("reset confirm dialog not found");
    await actAsync(() => findButton(dialog as HTMLElement, "恢复默认").click());
    expect(reregisterHotkeys).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+Q", "Ctrl+Shift+E", "Ctrl+Shift+R");
    const persisted = JSON.parse(localStorage.getItem("immersive-translator-settings") ?? "{}");
    expect(persisted).toMatchObject({
      hotkey: "Ctrl+Shift+Q",
      ocrHotkey: "Ctrl+Shift+E",
      readerHotkey: "Ctrl+Shift+R",
    });
  });
});
