// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountMenu } from "./AccountMenu";
import type { AuthStatus } from "../lib/tauriBridge";

// tauriBridge/reminder/settingsStore 全 mock（照 SettingsDrawer.test.tsx 惯例）；
// authErrorText 是纯函数，走真实实现校验失效文案唯一出口。
const mocks = vi.hoisted(() => ({
  openLoginWindow: vi.fn(),
  openHistory: vi.fn(),
  openOcrOverlay: vi.fn(),
  openLiveCaption: vi.fn(),
  openQuickReview: vi.fn(),
  settingsOpenTab: vi.fn(),
  authLogout: vi.fn(),
}));

vi.mock("../lib/tauriBridge", () => ({
  authLogout: mocks.authLogout,
  openHistory: mocks.openHistory,
  openLiveCaption: mocks.openLiveCaption,
  openLoginWindow: mocks.openLoginWindow,
  openOcrOverlay: mocks.openOcrOverlay,
  settingsOpenTab: mocks.settingsOpenTab,
}));

vi.mock("../lib/reminder", () => ({
  openQuickReview: mocks.openQuickReview,
}));

vi.mock("../lib/settingsStore", () => ({
  loadSettings: vi.fn(() => ({ ocrHotkey: "Ctrl+Shift+X" })),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof AccountMenu>[0];

const MEMBER: AuthStatus = {
  loggedIn: true,
  user: { id: "u1", email: "yang@example.com", nickname: null, plan: "FREE", createdAt: "2026-01-01" },
  notice: null,
};
const GUEST: AuthStatus = { loggedIn: false, user: null, notice: null };
const EXPIRED: AuthStatus = { loggedIn: false, user: null, notice: "session_expired" };
const KICKED: AuthStatus = { loggedIn: false, user: null, notice: "session_kicked" };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  // runAction 统一 .catch，动作 mock 必须返回 Promise（否则 undefined.catch 抛错）。
  mocks.openLoginWindow.mockResolvedValue(undefined);
  mocks.openHistory.mockResolvedValue(undefined);
  mocks.openOcrOverlay.mockResolvedValue(undefined);
  mocks.openLiveCaption.mockResolvedValue(undefined);
  mocks.openQuickReview.mockResolvedValue(undefined);
  mocks.settingsOpenTab.mockResolvedValue(undefined);
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
    authStatus: GUEST,
    dueNow: 0,
    onToast: vi.fn(),
    ...props,
  };
  act(() => root.render(<AccountMenu {...complete} />));
  return complete;
}

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(".acct-trigger")!;
}

function menu(): HTMLElement | null {
  return container.querySelector(".acct-menu");
}

function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function item(label: string): HTMLButtonElement {
  const found = items().find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`menu item not found: ${label}`);
  return found;
}

function click(element: HTMLElement) {
  act(() => {
    element.focus();
    element.click();
  });
}

/** 带微任务冲刷的点击（登出 Promise 链路用）。 */
async function clickAsync(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function key(element: HTMLElement, value: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  act(() => { element.dispatchEvent(event); });
  return event;
}

describe("AccountMenu 三态触发器", () => {
  it("游客态：「登录」pill，aria 与 title 照原型", () => {
    render({ authStatus: GUEST });
    const t = trigger();
    expect(t.classList.contains("is-guest")).toBe(true);
    expect(t.textContent).toContain("登录");
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.title).toBe("登录与工具");
  });

  it("失效态：「重新登录」警示 pill，title 复用 authNoticeText 唯一口径", () => {
    render({ authStatus: EXPIRED });
    const t = trigger();
    expect(t.classList.contains("is-expired")).toBe(true);
    expect(t.textContent).toContain("重新登录");
    expect(t.title).toBe("登录已失效，请重新登录");
  });

  it("失效态（被顶号）：title 用设备下线文案", () => {
    render({ authStatus: KICKED });
    expect(trigger().title).toBe("检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录");
  });

  it("成员态：圆形头像取昵称/邮箱首字母，aria-label 与 title 带邮箱", () => {
    render({ authStatus: MEMBER });
    const t = trigger();
    expect(t.classList.contains("is-member")).toBe(true);
    expect(t.getAttribute("aria-label")).toBe("账号：yang@example.com");
    expect(t.title).toBe("yang@example.com");
    expect(t.querySelector(".acct-avatar")?.textContent).toBe("Y");
  });

  it("成员态昵称优先于邮箱前缀取首字母", () => {
    render({
      authStatus: { ...MEMBER, user: { ...MEMBER.user!, nickname: "阿岳" } },
    });
    expect(trigger().querySelector(".acct-avatar")?.textContent).toBe("阿");
  });

  it("读取中（authStatus=null）：触发器用中性读取中态，不按游客「登录」渲染", () => {
    render({ authStatus: null });
    const t = trigger();
    expect(t).not.toBeNull();
    expect(t.classList.contains("is-loading")).toBe(true);
    expect(t.classList.contains("is-guest")).toBe(false);
    expect(t.getAttribute("aria-label")).toBe("正在读取登录状态…");
    expect(t.title).toBe("正在读取登录状态…");
    expect(t.textContent).not.toContain("登录");
  });
});

describe("AccountMenu 菜单内容按登录态", () => {
  it("游客菜单：登录头部 + 工具项，无账号与额度/退出登录", () => {
    render({ authStatus: GUEST });
    click(trigger());
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".acct-menu")?.id).toBe(trigger().getAttribute("aria-controls"));
    expect(container.querySelector(".acct-head")?.textContent).toContain("登录沉浸云");
    expect(container.querySelector(".acct-head")?.textContent).toContain("不登录也能使用全部本地功能");
    const labels = items().map((b) => b.textContent);
    expect(labels.some((text) => text?.includes("账号与额度"))).toBe(false);
    expect(labels.some((text) => text?.includes("退出登录"))).toBe(false);
    expect(labels).toHaveLength(5);
    expect(labels.some((text) => text?.includes("设置"))).toBe(false);
    for (const expected of ["登录 / 注册", "翻译历史", "截图翻译", "录音直译", "快速复习"]) {
      expect(labels.some((text) => text?.includes(expected))).toBe(true);
    }
  });

  it("成员菜单：账号与额度 + 退出登录，头部带 plan 徽标与邮箱", () => {
    render({ authStatus: MEMBER });
    click(trigger());
    const labels = items().map((b) => b.textContent);
    expect(labels).toHaveLength(6);
    expect(labels.some((text) => text?.includes("设置"))).toBe(false);
    for (const expected of ["账号与额度", "翻译历史", "截图翻译", "录音直译", "快速复习", "退出登录"]) {
      expect(labels.some((text) => text?.includes(expected))).toBe(true);
    }
    expect(container.querySelector(".acct-plan")?.textContent).toBe("FREE");
    expect(container.querySelector(".acct-mail")?.textContent).toBe("yang@example.com");
  });

  it("失效菜单：失效说明头部 + 重新登录按钮，无成员项", () => {
    render({ authStatus: EXPIRED });
    click(trigger());
    const head = container.querySelector(".acct-head")!;
    expect(head.textContent).toContain("登录已失效，请重新登录");
    expect(head.textContent).toContain("书架已切回这台电脑上未登录时的内容");
    expect(items().map((b) => b.textContent).some((text) => text?.includes("账号与额度"))).toBe(false);
  });

  it("读取中菜单：头部用「正在读取登录状态…」口径，不臆造登录态", () => {
    render({ authStatus: null });
    click(trigger());
    expect(container.querySelector(".acct-head")?.textContent).toContain("正在读取登录状态…");
    expect(container.querySelector(".acct-head")?.querySelector("button")).toBeNull();
    expect(items()).toHaveLength(4);
    expect(items().map((b) => b.textContent).some((text) => text?.includes("设置"))).toBe(false);
  });

  it("快速复习徽标：dueNow>0 才显示（与笔记与复习 island-counter 同源）", () => {
    const first = render({ authStatus: MEMBER, dueNow: 0 });
    click(trigger());
    expect(container.querySelector(".acct-mi-due")).toBeNull();

    key(trigger(), "Escape");
    render({ ...first, authStatus: MEMBER, dueNow: 3 });
    click(trigger());
    expect(container.querySelector(".acct-mi-due")?.textContent).toBe("3");
  });

  it("截图翻译 kbd 读取设置里的实时热键，改键后不显示过时键位", () => {
    render({ authStatus: GUEST });
    click(trigger());
    expect(container.querySelector(".acct-mi kbd")?.textContent).toBe("Ctrl+Shift+X");
  });
});

describe("AccountMenu 菜单动作", () => {
  it("游客「登录 / 注册」走现有登录窗（不新建登录窗），并关闭菜单", () => {
    render({ authStatus: GUEST });
    click(trigger());
    click(item("登录 / 注册"));
    expect(mocks.openLoginWindow).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("失效「重新登录」同样走现有登录窗", () => {
    render({ authStatus: EXPIRED });
    click(trigger());
    click(item("重新登录"));
    expect(mocks.openLoginWindow).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("账号与额度定位统一设置的账号页，翻译历史保留独立入口", () => {
    const onToast = vi.fn();
    render({ authStatus: MEMBER, onToast });
    click(trigger());
    click(item("账号与额度"));
    expect(mocks.settingsOpenTab).toHaveBeenCalledWith("account");
    expect(onToast).toHaveBeenCalledWith("已打开设置 · 账号");
    expect(menu()).toBeNull();

    click(trigger());
    click(item("翻译历史"));
    expect(mocks.openHistory).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("已打开翻译历史");
  });

  it("截图翻译与 Ctrl+Shift+E 同路径，录音直译/快速复习各调对应命令", () => {
    const onToast = vi.fn();
    render({ authStatus: MEMBER, onToast });
    click(trigger());
    click(item("截图翻译"));
    expect(mocks.openOcrOverlay).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("进入截图框选");

    click(trigger());
    click(item("录音直译"));
    expect(mocks.openLiveCaption).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("已打开录音直译");

    click(trigger());
    click(item("快速复习"));
    expect(mocks.openQuickReview).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("已打开快速复习");
  });
});

describe("AccountMenu 键盘与外点", () => {
  it("ArrowDown 打开菜单并聚焦首个菜单项；Enter 与空格同样打开", () => {
    const first = render({ authStatus: GUEST });
    key(trigger(), "ArrowDown");
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(item("登录 / 注册"));

    // Escape 复位后验证 Enter 路径（React 19 同一 root 卸载后不可再 render）
    key(trigger(), "Escape");
    render({ ...first, authStatus: GUEST });
    key(trigger(), "Enter");
    expect(document.activeElement).toBe(item("登录 / 注册"));

    key(trigger(), "Escape");
    render({ ...first, authStatus: GUEST });
    key(trigger(), " ");
    expect(document.activeElement).toBe(item("登录 / 注册"));
  });

  it("鼠标点击打开时不抢焦点（键盘打开才落焦菜单项）", () => {
    render({ authStatus: GUEST });
    // jsdom 的 element.click() detail=0 会被判为键盘打开，显式带 detail=1 模拟鼠标。
    act(() => {
      trigger().focus();
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape 关闭菜单并恢复触发器焦点", () => {
    render({ authStatus: MEMBER });
    click(trigger());
    key(item("翻译历史"), "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("方向键、Home、End 在菜单项间循环（成员菜单 6 项）", () => {
    render({ authStatus: MEMBER });
    key(trigger(), "ArrowDown");
    const all = items();
    expect(all).toHaveLength(6);
    expect(document.activeElement).toBe(all[0]);
    key(all[0], "ArrowDown");
    expect(document.activeElement).toBe(all[1]);
    key(all[1], "End");
    expect(document.activeElement).toBe(all[5]);
    key(all[5], "ArrowDown");
    expect(document.activeElement).toBe(all[0]);
    key(all[0], "ArrowUp");
    expect(document.activeElement).toBe(all[5]);
    key(all[5], "Home");
    expect(document.activeElement).toBe(all[0]);
  });

  it("外部 pointerdown 关闭菜单，不抢外部焦点", () => {
    const { onToast } = render({ authStatus: GUEST });
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
    expect(onToast).not.toHaveBeenCalled();
  });

  it("Tab 保留默认焦点移动，离开菜单后关闭且不抢回焦点", () => {
    render({ authStatus: GUEST });
    act(() => {
      trigger().focus();
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(document.activeElement).toBe(trigger());
    const outside = document.createElement("button");
    outside.textContent = "下一个控件";
    container.appendChild(outside);
    const triggerFocus = vi.spyOn(trigger(), "focus");

    expect(key(item("翻译历史"), "Tab").defaultPrevented).toBe(false);
    // jsdom 不执行浏览器的 Tab 默认动作，模拟下一控件收到焦点。
    act(() => { outside.focus(); });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(triggerFocus).not.toHaveBeenCalled();
  });
});

describe("AccountMenu 退出登录两步确认", () => {
  it("点退出登录先出确认面板，不直接登出", () => {
    render({ authStatus: MEMBER });
    click(trigger());
    click(item("退出登录"));
    expect(mocks.authLogout).not.toHaveBeenCalled();
    const confirm = container.querySelector(".acct-note")!;
    expect(confirm.querySelector("h3")?.textContent).toBe("退出登录？");
    expect(confirm.textContent).toContain("账号里的书、生词和笔记不会删除，重新登录即可回来");
    expect(confirm.querySelector(".btn-danger")?.textContent).toBe("退出登录");
  });

  it("确认后调 authLogout，成功关菜单并 toast 本机书架口径", async () => {
    mocks.authLogout.mockResolvedValue({ serverRevoked: true });
    const onToast = vi.fn();
    render({ authStatus: MEMBER, onToast });
    click(trigger());
    click(item("退出登录"));
    await clickAsync(container.querySelector<HTMLButtonElement>(".acct-note .btn-danger")!);
    expect(mocks.authLogout).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(onToast).toHaveBeenCalledWith("已退出登录，当前是本机书架");
  });

  it("确认面板「取消」回到菜单且不登出，落焦回菜单项", () => {
    render({ authStatus: MEMBER });
    click(trigger());
    click(item("退出登录"));
    click(container.querySelector<HTMLButtonElement>(".acct-note .btn")!);
    expect(mocks.authLogout).not.toHaveBeenCalled();
    expect(container.querySelector(".acct-note")).toBeNull();
    expect(items().length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("登出失败（storage_error）保持登录态口径：只 toast 登出失败文案", async () => {
    mocks.authLogout.mockRejectedValue({ code: "storage_error", message: "存储失败", httpStatus: null, retryAfterSeconds: null });
    const onToast = vi.fn();
    render({ authStatus: MEMBER, onToast });
    click(trigger());
    click(item("退出登录"));
    await clickAsync(container.querySelector<HTMLButtonElement>(".acct-note .btn-danger")!);
    expect(mocks.authLogout).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    // 文案走 authErrorText 唯一出口（AccountSection.tsx:149-151 口径）
    expect(onToast).toHaveBeenCalledWith("登出失败：本地安全存储读写失败，请重试或反馈");
  });
});
