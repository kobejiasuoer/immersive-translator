// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { settingsOpenTab } from "../lib/tauriBridge";
import type { UpdateInfo } from "../lib/updater";
import { actAsync, createHarness, findButton, type Harness } from "../views/authTestHarness";
import { UpdateNotice } from "./UpdateNotice";

vi.mock("../lib/tauriBridge", () => ({ settingsOpenTab: vi.fn() }));

const SNOOZE_KEY = "immersive-translator-update-snooze";
const DAY = 24 * 60 * 60 * 1000;
const AVAILABLE: UpdateInfo = { hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0" };
let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T04:00:00Z"));
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(settingsOpenTab).mockResolvedValue(undefined);
  harness = createHarness();
});

afterEach(() => {
  harness.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function render(info: UpdateInfo | null = AVAILABLE) {
  harness.render(<StrictMode><UpdateNotice info={info} /></StrictMode>);
}

function trigger(): HTMLButtonElement {
  return harness.container.querySelector<HTMLButtonElement>(".update-notice-trigger")!;
}

function panel(): HTMLElement | null {
  return harness.container.querySelector(".update-notice-panel");
}

function click(label: string) {
  act(() => { findButton(harness.container, label).click(); });
}

describe("主动更新提示", () => {
  it("无更新或版本缺失时不占位；新版本自动展开但不抢焦点", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    try {
      render(null);
      expect(harness.container.children).toHaveLength(0);
      render({ hasUpdate: false, currentVersion: "0.11.1" });
      expect(harness.container.children).toHaveLength(0);
      render({ hasUpdate: true, currentVersion: "0.11.1" });
      expect(harness.container.children).toHaveLength(0);

      render();

      expect(panel()?.textContent).toContain("v0.12.0 已可更新");
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(trigger().getAttribute("aria-controls")).toBe(panel()?.id);
      expect(panel()?.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
      expect(document.activeElement).toBe(outside);
      expect(settingsOpenTab).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("稍后提醒收起提示保留入口，同版重新挂载不再展开，可手动查看", () => {
    render();
    click("稍后提醒");
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem(SNOOZE_KEY)!)).toEqual({ version: "0.12.0", until: Date.now() + DAY });

    render(null);
    render();
    expect(panel()).toBeNull();
    act(() => trigger().click());
    expect(panel()).not.toBeNull();
  });

  it("同版本刷新不重复展开，新版本不受旧版本稍后提醒影响", () => {
    render();
    click("稍后提醒");
    render({ ...AVAILABLE, releaseNotes: "新的说明" });
    expect(panel()).toBeNull();

    render({ ...AVAILABLE, newVersion: "0.13.0" });

    expect(panel()?.textContent).toContain("v0.13.0 已可更新");
  });

  it("稍后提醒满24小时后再次轻提示", async () => {
    render();
    click("稍后提醒");
    await actAsync(async () => { await vi.advanceTimersByTimeAsync(DAY - 1); });
    expect(panel()).toBeNull();

    await actAsync(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(panel()).not.toBeNull();
  });

  it.each(["not-json", '{"version":"0.12.0","until":"forever"}', '{"version":"0.12.0","until":99999999999999}'])(
    "损坏的稍后记录 %s 不阻止新版本提醒", (raw) => {
      localStorage.setItem(SNOOZE_KEY, raw);
      render();
      expect(panel()).not.toBeNull();
    },
  );

  it("查看更新只打开关于页，打开成功后才收起；请求中禁止重复点击", async () => {
    let resolve!: () => void;
    vi.mocked(settingsOpenTab).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    render();
    click("查看更新");
    expect(panel()).not.toBeNull();
    expect(findButton(harness.container, "正在打开…").disabled).toBe(true);
    click("正在打开…");
    expect(settingsOpenTab).toHaveBeenCalledExactlyOnceWith("about");
    expect(localStorage.getItem(SNOOZE_KEY)).toBeNull();
    // 打开独立设置窗口可能先让当前 WebView 失焦，不能提前当作操作成功。
    act(() => trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    expect(panel()).not.toBeNull();
    expect(localStorage.getItem(SNOOZE_KEY)).toBeNull();

    await actAsync(() => resolve());

    expect(panel()).toBeNull();
    expect(trigger()).not.toBeNull();
    expect(localStorage.getItem(SNOOZE_KEY)).not.toBeNull();
  });

  it("打开关于失败保留提示和重试入口，不记录稍后提醒", async () => {
    vi.mocked(settingsOpenTab).mockRejectedValueOnce(new Error("IPC failed"));
    render();
    await actAsync(() => findButton(harness.container, "查看更新").click());
    expect(panel()?.querySelector('[role="alert"]')?.textContent).toContain("暂时无法打开更新页面");
    expect(localStorage.getItem(SNOOZE_KEY)).toBeNull();
    expect(findButton(harness.container, "查看更新").disabled).toBe(false);

    await actAsync(() => findButton(harness.container, "查看更新").click());

    expect(panel()).toBeNull();
    expect(settingsOpenTab).toHaveBeenCalledTimes(2);
  });

  it("关闭按钮与Escape收起提示并恢复触发器焦点", () => {
    render();
    act(() => harness.container.querySelector<HTMLButtonElement>('button[aria-label="关闭更新提示"]')!.click());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    act(() => trigger().click());
    const action = findButton(harness.container, "查看更新");
    act(() => action.focus());

    act(() => action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("点击提示外部保留原操作焦点，取消提示后仍可从入口打开", () => {
    render();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      act(() => outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      act(() => outside.focus());
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(outside);
      act(() => trigger().click());
      expect(panel()).not.toBeNull();
    } finally {
      outside.remove();
    }
  });

  it.each([" ", "Enter", "j", "J", "k", "K", "l", "L"])("提示按钮的 %s 不触发全局播放按键", (key) => {
    render();
    const down = vi.fn();
    const up = vi.fn();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    try {
      const action = findButton(harness.container, "查看更新");
      act(() => {
        action.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        action.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      });
      expect(down).not.toHaveBeenCalled();
      expect(up).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    }
  });

  it.each(["h", "H"])("提示中释放 %s 仍通知阅读室清理临时译文", (key) => {
    render();
    const up = vi.fn();
    window.addEventListener("keyup", up);
    try {
      act(() => trigger().dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })));
      expect(up).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keyup", up);
    }
  });

  it("存储不可用时仍能查看和收起，写入失败使用当前会话内存去重", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const info = { ...AVAILABLE, newVersion: "0.15.0" };
    render(info);
    click("稍后提醒");
    expect(panel()).toBeNull();

    render(null);
    render(info);

    expect(panel()).toBeNull();
    act(() => trigger().click());
    expect(panel()).not.toBeNull();
  });

  it("写入失败但旧缓存仍可读取时，重新挂载采用内存中的最新延后记录", () => {
    const oldRecord = { version: "0.14.0", until: Date.now() + DAY };
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(oldRecord));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const info = { ...AVAILABLE, newVersion: "0.16.0" };
    render(info);
    click("稍后提醒");
    expect(panel()).toBeNull();
    expect(JSON.parse(localStorage.getItem(SNOOZE_KEY)!)).toEqual(oldRecord);

    render(null);
    render(info);

    expect(panel()).toBeNull();
    // 存储恢复并成功写入后，旧的内存兜底不再覆盖后续读取。
    write.mockRestore();
    act(() => trigger().click());
    click("稍后提醒");
    localStorage.removeItem(SNOOZE_KEY);
    render(null);
    render(info);
    expect(panel()).not.toBeNull();
  });
});
