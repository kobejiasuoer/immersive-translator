// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_READER_SETTINGS, type ReaderTheme } from "../core/readerTypes";
import { ReaderTopBar } from "./ReaderTopBar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof ReaderTopBar>[0];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<Props> = {}): Props {
  const complete: Props = {
    articleName: "The Nightingale and the Rose",
    settings: { ...DEFAULT_READER_SETTINGS },
    view: "reading",
    dueNow: 2,
    unnotedCount: 1,
    onPatchSettings: vi.fn(),
    onOpenDrawer: vi.fn(),
    onSearch: vi.fn(),
    onHome: vi.fn(),
    onNavigate: vi.fn(),
    onToggleFolio: vi.fn(),
    ...props,
  };
  act(() => root.render(<ReaderTopBar {...complete} />));
  return complete;
}

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("button[data-theme-trigger]")!;
}

function option(theme: ReaderTheme): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[data-theme-option="${theme}"]`)!;
}

function menu(): HTMLElement | null {
  return container.querySelector('[role="menu"]');
}

function click(element: HTMLElement) {
  act(() => {
    element.focus();
    element.click();
  });
}

function key(element: HTMLElement, value: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  act(() => { element.dispatchEvent(event); });
  return event;
}

describe("ReaderTopBar 主题选择", () => {
  it.each<{ initial: ReaderTheme; selected: ReaderTheme; label: string }>([
    { initial: "dark", selected: "light", label: "纸书" },
    { initial: "light", selected: "dark", label: "深色" },
    { initial: "light", selected: "sepia", label: "护眼" },
    { initial: "light", selected: "oled", label: "纯黑" },
  ])("选择 $label 发出原 theme 回调，关闭菜单并回到触发器", ({ initial, selected, label }) => {
    const onPatchSettings = vi.fn();
    const props = render({ settings: { ...DEFAULT_READER_SETTINGS, theme: initial }, onPatchSettings });

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.id).toBe(trigger().getAttribute("aria-controls"));
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'), (item) => item.dataset.themeOption))
      .toEqual(["light", "dark", "sepia", "oled"]);
    expect(option(initial).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(option(initial));

    click(option(selected));

    expect(onPatchSettings).toHaveBeenCalledExactlyOnceWith({ theme: selected });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    render({ ...props, settings: { ...props.settings, theme: selected } });
    expect(trigger().getAttribute("aria-label")).toBe(`阅读主题：${label}`);
  });

  it("Escape 关闭菜单并恢复触发器焦点，不修改主题", () => {
    const onPatchSettings = vi.fn();
    render({ onPatchSettings });
    click(trigger());

    key(option("light"), "Escape");

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onPatchSettings).not.toHaveBeenCalled();
  });

  it("外部点击关闭菜单，保留外部操作的焦点", () => {
    render();
    click(trigger());
    const outside = document.createElement("button");
    outside.textContent = "外部操作";
    container.appendChild(outside);
    const triggerFocus = vi.spyOn(trigger(), "focus");

    act(() => { outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    act(() => { outside.focus(); });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(triggerFocus).not.toHaveBeenCalled();
  });

  it("Tab 保留默认焦点移动，离开菜单后关闭且不抢回焦点", () => {
    render();
    click(trigger());
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="阅读设置"]')!;
    const triggerFocus = vi.spyOn(trigger(), "focus");

    expect(key(option("light"), "Tab").defaultPrevented).toBe(false);
    // jsdom 不执行浏览器的 Tab 默认动作，模拟下一控件收到焦点。
    act(() => { next.focus(); });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(next);
    expect(triggerFocus).not.toHaveBeenCalled();
  });

  it("Shift+Tab 可以回到触发器并关闭菜单", () => {
    render();
    click(trigger());

    expect(key(option("light"), "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    act(() => { trigger().focus(); });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("方向键、Home、End 导航，Enter 选择当前聚焦项", () => {
    const onPatchSettings = vi.fn();
    render({ settings: { ...DEFAULT_READER_SETTINGS, theme: "dark" }, onPatchSettings });

    key(trigger(), "ArrowDown");
    expect(document.activeElement).toBe(option("dark"));
    key(option("dark"), "Home");
    expect(document.activeElement).toBe(option("light"));
    key(option("light"), "End");
    expect(document.activeElement).toBe(option("oled"));
    key(option("oled"), "ArrowDown");
    expect(document.activeElement).toBe(option("light"));
    key(option("light"), "ArrowUp");
    expect(document.activeElement).toBe(option("oled"));
    key(option("oled"), "Enter");

    expect(onPatchSettings).toHaveBeenCalledExactlyOnceWith({ theme: "oled" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("空格打开菜单并选择聚焦项，专注复习下同样有效", () => {
    const onPatchSettings = vi.fn();
    render({ view: "vault", focusMode: true, onPatchSettings });

    key(trigger(), " ");
    key(option("light"), "ArrowDown");
    key(option("dark"), " ");

    expect(onPatchSettings).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it.each(["h", "H"])("正文按住 %s 后进入主题菜单，释放仍清理临时译文揭示", (value) => {
    render();
    const reading = document.createElement("p");
    reading.textContent = "阅读正文";
    container.appendChild(reading);
    let peekAll = false;
    const beginPeek = (event: KeyboardEvent) => { if (event.key === value) peekAll = true; };
    const endPeek = (event: KeyboardEvent) => { if (event.key === value) peekAll = false; };
    window.addEventListener("keydown", beginPeek);
    window.addEventListener("keyup", endPeek);
    try {
      key(reading, value);
      expect(peekAll).toBe(true);
      click(trigger());
      act(() => { option("light").dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true })); });

      expect(peekAll).toBe(false);
    } finally {
      window.removeEventListener("keydown", beginPeek);
      window.removeEventListener("keyup", endPeek);
    }
  });

  it.each([" ", "j", "J", "k", "K", "l", "L"])("主题控件的 %s 不冒泡给父级或全局播放快捷键", (value) => {
    render();
    const playbackHotkey = vi.fn();
    const playbackKeyUp = vi.fn();
    const parentHotkey = vi.fn();
    window.addEventListener("keydown", playbackHotkey);
    window.addEventListener("keyup", playbackKeyUp);
    document.body.addEventListener("keydown", parentHotkey);
    try {
      key(trigger(), value);
      if (!menu()) click(trigger());
      key(option("light"), value);
      act(() => { (menu() ? option("light") : trigger()).dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true })); });

      expect(playbackHotkey).not.toHaveBeenCalled();
      expect(parentHotkey).not.toHaveBeenCalled();
      expect(playbackKeyUp).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", playbackHotkey);
      window.removeEventListener("keyup", playbackKeyUp);
      document.body.removeEventListener("keydown", parentHotkey);
    }
  });
});
