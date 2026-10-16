// @vitest-environment jsdom
// 设置页账号 tab 状态机（docs §9.1 AccountSection 用例点）：mock tauriBridge。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { AccountSection } from "./AccountSection";
import { actAsync, createHarness, findButton, type Harness } from "./authTestHarness";
import {
  authFetchServerConfig,
  authGetStatus,
  authLogout,
  listenAuthStateChanged,
  openLoginWindow,
} from "../lib/tauriBridge";
import type { AuthStatus, AuthUser } from "../lib/tauriBridge";

vi.mock("../lib/tauriBridge", () => ({
  authGetStatus: vi.fn(),
  authLogout: vi.fn(),
  authRefreshNow: vi.fn(),
  authFetchMe: vi.fn(),
  authFetchServerConfig: vi.fn(),
  openLoginWindow: vi.fn(),
  settingsOpenTab: vi.fn(),
  settingsTakePendingTab: vi.fn(),
  listenAuthStateChanged: vi.fn(),
  listenSettingsNavigateTab: vi.fn(),
}));

const mockedGetStatus = vi.mocked(authGetStatus);
const mockedLogout = vi.mocked(authLogout);
const mockedOpenLogin = vi.mocked(openLoginWindow);
const mockedListenAuth = vi.mocked(listenAuthStateChanged);
const mockedFetchConfig = vi.mocked(authFetchServerConfig);

function makeUser(partial: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u-1",
    email: "reader@example.com",
    nickname: "读译",
    plan: "FREE",
    createdAt: "2026-09-01T08:09:10.000Z",
    ...partial,
  };
}

const ANON: AuthStatus = { loggedIn: false, user: null, notice: null };
const LOGGED_IN: AuthStatus = { loggedIn: true, user: makeUser(), notice: null };

/** auth-state-changed 的当前监听器（事件驱动自刷新的测试钩子）。 */
let authListener: ((s: AuthStatus) => void) | null = null;
/** 可变状态源：authGetStatus 每次读取最新值（模拟 Rust 侧权威态变化）。 */
let statusNow: AuthStatus = ANON;

beforeEach(() => {
  vi.resetAllMocks();
  statusNow = ANON;
  authListener = null;
  mockedGetStatus.mockImplementation(async () => statusNow);
  mockedLogout.mockResolvedValue({ serverRevoked: true });
  mockedOpenLogin.mockResolvedValue(undefined);
  mockedListenAuth.mockImplementation((cb) => {
    authListener = cb;
    return Promise.resolve(() => undefined);
  });
});

/** 挂载 + 冲刷挂载期 authGetStatus 微任务。 */
async function mountAccount(): Promise<Harness> {
  const h = createHarness();
  h.render(<AccountSection />);
  await actAsync(() => undefined);
  return h;
}

describe("AccountSection 状态机", () => {
  it("未登录 → 空态卡 + 「登录」按钮调 open_login_window", async () => {
    statusNow = ANON;
    const h = await mountAccount();

    expect(h.container.querySelector(".acct-empty")?.textContent).toContain("未登录");
    expect(h.container.querySelector(".avatar")).toBeNull();

    await actAsync(() => findButton(h.container, "登 录").click());
    expect(mockedOpenLogin).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("已登录 → 头像/昵称/邮箱/plan 徽标/登出按钮", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();

    expect(h.container.querySelector(".avatar")?.textContent).toBe("读");
    expect(h.container.querySelector(".acct-nickname")?.textContent).toBe("读译");
    expect(h.container.querySelector(".acct-email")?.textContent).toBe("reader@example.com");
    expect(h.container.querySelector(".plan-badge")?.textContent).toBe("FREE");
    expect(findButton(h.container, "登出")).toBeTruthy();
    expect(h.container.querySelector(".acct-empty")).toBeNull();
    h.unmount();
  });

  it("notice=session_expired → warn 状态条（token_invalid 落点）", async () => {
    statusNow = { loggedIn: false, user: null, notice: "session_expired" };
    const h = await mountAccount();
    expect(h.container.querySelector(".acct-notice")?.textContent).toContain("登录已失效，请重新登录");
    h.unmount();
  });

  it("notice=session_kicked → 全设备下线文案（token_reused 落点）", async () => {
    statusNow = { loggedIn: false, user: null, notice: "session_kicked" };
    const h = await mountAccount();
    expect(h.container.querySelector(".acct-notice")?.textContent).toContain(
      "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录",
    );
    h.unmount();
  });

  it("已登录且无 notice → 不渲染状态条", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();
    expect(h.container.querySelector(".acct-notice")).toBeNull();
    h.unmount();
  });

  it("auth-state-changed 广播登出 → 自刷新为空态（登录窗完成登录的同一通路）", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();
    expect(h.container.querySelector(".acct-nickname")?.textContent).toBe("读译");

    act(() => authListener?.(ANON));
    expect(h.container.querySelector(".acct-empty")?.textContent).toContain("未登录");
    h.unmount();
  });

  it("登出成功 → auth_logout + 主动刷新回空态", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();
    // Rust 侧登出即清凭据：auth_logout 成功后的下一次 get_status 返回未登录。
    statusNow = ANON;
    await actAsync(() => findButton(h.container, "登出").click());

    expect(mockedLogout).toHaveBeenCalledTimes(1);
    expect(mockedGetStatus.mock.calls.length).toBeGreaterThanOrEqual(2); // 挂载一次 + 登出后刷新一次
    expect(h.container.querySelector(".acct-empty")?.textContent).toContain("未登录");
    h.unmount();
  });

  it("登出 auth_logout Err(storage_error) → 保持已登录态 + 红条（P13）", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();
    mockedLogout.mockRejectedValueOnce({
      code: "storage_error",
      message: "dpapi clear failed",
      httpStatus: null,
      retryAfterSeconds: null,
    });

    await actAsync(() => findButton(h.container, "登出").click());

    // 登录态保持（昵称仍在），红条给出 storage_error 文案
    expect(h.container.querySelector(".acct-nickname")?.textContent).toBe("读译");
    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain(
      "登出失败：本地安全存储读写失败，请重试或反馈",
    );
    expect(h.container.querySelector(".acct-empty")).toBeNull();
    h.unmount();
  });

  it("云端配置手动重拉：成功/失败文案（D7 登录后自动拉取的兜底入口）", async () => {
    statusNow = LOGGED_IN;
    const h = await mountAccount();

    mockedFetchConfig.mockResolvedValueOnce({ gateway: {}, models: [] });
    await actAsync(() => findButton(h.container, "重新拉取").click());
    expect(h.container.querySelector(".msg-bar.ok")?.textContent).toContain("云端配置已拉取并保存");

    mockedFetchConfig.mockRejectedValueOnce({
      code: "network_error",
      message: "",
      httpStatus: null,
      retryAfterSeconds: null,
    });
    await actAsync(() => findButton(h.container, "重新拉取").click());
    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain(
      "网络连接失败，请检查网络后重试",
    );
    h.unmount();
  });
});
