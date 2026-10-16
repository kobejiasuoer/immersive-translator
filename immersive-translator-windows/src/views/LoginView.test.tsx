// @vitest-environment jsdom
// 登录窗状态机（docs §9.1 LoginView 用例点）：mock tauriBridge + 窗口 close。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LoginView } from "./LoginView";
import { actAsync, createHarness, findButton, setInputValue, type Harness } from "./authTestHarness";
import { OTP_LAST_SENT_KEY } from "../lib/useResendCooldown";
import {
  authGetStatus,
  authLoginPassword,
  authSendOtp,
  authVerifyOtp,
  settingsOpenTab,
} from "../lib/tauriBridge";
import type { AuthError, AuthStatus, AuthUser } from "../lib/tauriBridge";

// 关窗 mock：close() 必须返回 Promise（closeSelf 会 .catch 兜底）。
// getCurrentWindow 用普通函数（不是 vi.fn）：vi.resetAllMocks 不会清掉它的实现。
const closeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: closeMock }),
}));

vi.mock("../lib/tauriBridge", () => ({
  authGetStatus: vi.fn(),
  authLoginPassword: vi.fn(),
  authSendOtp: vi.fn(),
  authVerifyOtp: vi.fn(),
  settingsOpenTab: vi.fn(),
  authLogout: vi.fn(),
  authRefreshNow: vi.fn(),
  authFetchMe: vi.fn(),
  authFetchServerConfig: vi.fn(),
  openLoginWindow: vi.fn(),
  settingsTakePendingTab: vi.fn(),
  listenAuthStateChanged: vi.fn(),
  listenSettingsNavigateTab: vi.fn(),
}));

const mockedGetStatus = vi.mocked(authGetStatus);
const mockedSendOtp = vi.mocked(authSendOtp);
const mockedVerifyOtp = vi.mocked(authVerifyOtp);
const mockedLoginPassword = vi.mocked(authLoginPassword);

const ANON: AuthStatus = { loggedIn: false, user: null, notice: null };

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

function err(code: string, extra: Partial<AuthError> = {}): AuthError {
  return { code, message: `server-${code}`, httpStatus: null, retryAfterSeconds: null, ...extra };
}

/** 填邮箱并发码成功 → 验证码页，返回 6 格输入。 */
async function gotoCodeView(h: Harness, email = "reader@example.com"): Promise<HTMLInputElement[]> {
  const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
  act(() => setInputValue(emailInput, email));
  await actAsync(() => findButton(h.container, "获取验证码").click());
  const cells = Array.from(h.container.querySelectorAll(".code-cells input")) as HTMLInputElement[];
  expect(cells).toHaveLength(6);
  return cells;
}

/** 在 6 格验证码里逐格填数字。 */
function fillCode(cells: HTMLInputElement[], digits: string): void {
  for (let i = 0; i < cells.length; i++) {
    act(() => setInputValue(cells[i], digits[i] ?? "0"));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.resetAllMocks();
  // 用例隔离：清掉持久化重发冷却记录——邮箱页现在尊重 D10 冷却（关窗重开
  // 也禁发），不清会让上一用例的 lastSent 泄漏到下一用例的邮箱页按钮。
  localStorage.removeItem(OTP_LAST_SENT_KEY);
  // resetAllMocks 会清掉 hoisted closeMock 的实现，这里补回。
  closeMock.mockImplementation(() => Promise.resolve());
  mockedGetStatus.mockResolvedValue(ANON);
  mockedSendOtp.mockResolvedValue(undefined);
  mockedVerifyOtp.mockResolvedValue({ user: makeUser() });
  mockedLoginPassword.mockResolvedValue({ user: makeUser() });
  vi.mocked(settingsOpenTab).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LoginView 状态机", () => {
  it("邮箱非法 → 「获取验证码」禁用；合法 → 可点", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    await actAsync(() => undefined);
    expect(findButton(h.container, "获取验证码").disabled).toBe(true);

    const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
    act(() => setInputValue(emailInput, "not-an-email"));
    expect(findButton(h.container, "获取验证码").disabled).toBe(true);

    act(() => setInputValue(emailInput, "reader@example.com"));
    expect(findButton(h.container, "获取验证码").disabled).toBe(false);
    h.unmount();
  });

  it("send_otp 成功 → 验证码页 + 60s 倒计时禁用重发", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    await gotoCodeView(h);
    expect(mockedSendOtp).toHaveBeenCalledWith("reader@example.com");
    expect(h.container.querySelector(".code-target")?.textContent).toContain("reader@example.com");

    expect(findButton(h.container, "重新发送（60s）").disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(findButton(h.container, "重新发送（50s）").disabled).toBe(true);
    h.unmount();
  });

  it("D10 关窗重开回邮箱页：持久化冷却内禁发，到期恢复可发", async () => {
    // 预置 10 秒前的发送记录（关窗前已发过一次），重开落回邮箱页。
    localStorage.setItem(
      OTP_LAST_SENT_KEY,
      JSON.stringify({ "reader@example.com": Date.now() - 10_000 }),
    );
    const h = createHarness();
    h.render(<LoginView />);
    await actAsync(() => undefined);
    const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
    act(() => setInputValue(emailInput, "reader@example.com"));
    const sendBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("获取验证码"),
    ) as HTMLButtonElement;
    // 冷却内：禁用 + 文案带剩余秒数，点击不触达 authSendOtp。
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.textContent).toContain("获取验证码（");
    sendBtn.click();
    await actAsync(() => undefined);
    expect(mockedSendOtp).not.toHaveBeenCalled();
    // 剩余耗尽后按钮恢复，此时才真正发码。
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await actAsync(() => findButton(h.container, "获取验证码").click());
    expect(mockedSendOtp).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("otp_invalid → 停验证码页、清空码输入、保留重发", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    const cells = await gotoCodeView(h);
    mockedVerifyOtp.mockRejectedValueOnce(err("otp_invalid", { httpStatus: 400 }));
    fillCode(cells, "123456");
    await actAsync(() => findButton(h.container, "登 录").click());

    expect(mockedVerifyOtp).toHaveBeenCalledWith("reader@example.com", "123456");
    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "验证码错误或已过期，请重新获取",
    );
    // 清码：六格全部归零，仍停留在验证码页（重发按钮在），不进成功页
    for (const c of Array.from(h.container.querySelectorAll(".code-cells input"))) {
      expect((c as HTMLInputElement).value).toBe("");
    }
    expect(findButton(h.container, "重新发送（60s）")).toBeTruthy();
    expect(h.container.querySelector(".success-pane")).toBeNull();
    h.unmount();
  });

  it("invalid_credentials → 停密码页签并清空密码", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    await actAsync(() => undefined);
    act(() => findButton(h.container, "密码登录").click());

    act(() => setInputValue(h.container.querySelector("#login-email2") as HTMLInputElement, "reader@example.com"));
    act(() => setInputValue(h.container.querySelector("#login-pwd") as HTMLInputElement, "wrong-pass"));
    mockedLoginPassword.mockRejectedValueOnce(err("invalid_credentials", { httpStatus: 401 }));
    await actAsync(() => findButton(h.container, "登 录").click());

    expect(mockedLoginPassword).toHaveBeenCalledWith("reader@example.com", "wrong-pass");
    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "邮箱或密码不正确；若从未设置密码，请改用验证码登录",
    );
    expect((h.container.querySelector("#login-pwd") as HTMLInputElement).value).toBe("");
    // 仍停在密码页签
    expect(h.container.querySelector("#login-pwd")).toBeTruthy();
    h.unmount();
  });

  it("banned → 提交禁用，「返回修改邮箱」回邮箱页并清错误态", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    const cells = await gotoCodeView(h);
    mockedVerifyOtp.mockRejectedValueOnce(err("banned", { httpStatus: 403 }));
    fillCode(cells, "111111");
    await actAsync(() => findButton(h.container, "登 录").click());

    // 阻断：回到邮箱页，红条常驻，提交禁用（banned + 刚发码的 60s 冷却双重
    // 禁用，按钮文案带剩余秒数），仅「返回修改邮箱」可用
    expect(h.container.querySelector("#login-email")).toBeTruthy();
    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "该账号已被封禁，如有疑问请联系支持",
    );
    const bannedBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("获取验证码"),
    ) as HTMLButtonElement;
    expect(bannedBtn.disabled).toBe(true);

    act(() => findButton(h.container, "返回修改邮箱").click());
    expect(h.container.querySelector(".login-banner")).toBeNull();
    const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
    act(() => setInputValue(emailInput, "other@example.com"));
    expect(findButton(h.container, "获取验证码").disabled).toBe(false);
    h.unmount();
  });

  it("network_error → 红条提示且按钮恢复可重试", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    await actAsync(() => undefined);
    const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
    act(() => setInputValue(emailInput, "reader@example.com"));
    mockedSendOtp.mockRejectedValueOnce(err("network_error"));
    await actAsync(() => findButton(h.container, "获取验证码").click());

    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "网络连接失败，请检查网络后重试",
    );
    expect(findButton(h.container, "获取验证码").disabled).toBe(false);
    expect(h.container.querySelector(".code-cells")).toBeNull();
    h.unmount();
  });

  it("storage_error → 红条且流程中止（不进成功页）", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    const cells = await gotoCodeView(h);
    mockedVerifyOtp.mockRejectedValueOnce(err("storage_error"));
    fillCode(cells, "123456");
    await actAsync(() => findButton(h.container, "登 录").click());

    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "本地安全存储读写失败，请重试或反馈",
    );
    expect(h.container.querySelector(".success-pane")).toBeNull();
    expect(h.container.querySelector(".code-cells")).toBeTruthy();
    h.unmount();
  });

  it("rate_limited → 按钮倒计时禁用，到 0 自动恢复（不自动重试）", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    await actAsync(() => undefined);
    const emailInput = h.container.querySelector("#login-email") as HTMLInputElement;
    act(() => setInputValue(emailInput, "reader@example.com"));
    mockedSendOtp.mockRejectedValueOnce(err("rate_limited", { httpStatus: 429, retryAfterSeconds: 3 }));
    await actAsync(() => findButton(h.container, "获取验证码").click());

    expect(h.container.querySelector(".login-banner")?.textContent).toContain(
      "操作过于频繁，请 3 秒后再试",
    );
    expect(findButton(h.container, "请 3 秒后再试").disabled).toBe(true);
    expect(mockedSendOtp).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(findButton(h.container, "获取验证码").disabled).toBe(false);
    expect(mockedSendOtp).toHaveBeenCalledTimes(1); // 到点只恢复，不自动重发
    h.unmount();
  });

  it("登录成功 → 成功态 + 自动关窗", async () => {
    const h = createHarness();
    h.render(<LoginView />);
    const cells = await gotoCodeView(h);
    fillCode(cells, "364882");
    await actAsync(() => findButton(h.container, "登 录").click());

    expect(h.container.querySelector(".success-pane")?.textContent).toContain("登录成功");
    expect(closeMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("已登录时打开登录窗 → 兜底卡片（不直接进表单）", async () => {
    const h = createHarness();
    mockedGetStatus.mockResolvedValue({ loggedIn: true, user: makeUser(), notice: null });
    h.render(<LoginView />);
    await actAsync(() => undefined);

    expect(h.container.querySelector(".login-existing")?.textContent).toContain("已登录");
    expect(h.container.querySelector(".login-tabs")).toBeNull();
    // 「使用其他账号登录」dismiss 兜底卡片后进入正常流程
    act(() => findButton(h.container, "使用其他账号登录").click());
    expect(h.container.querySelector(".login-tabs")).toBeTruthy();
    h.unmount();
  });
});
