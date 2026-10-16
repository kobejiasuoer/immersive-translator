// tauriBridge 账号段契约测试（docs §7 IPC 契约表 = generate_handler! 登记清单）：
// 命令名 / 参数名 camelCase / 返回形状逐条对齐；命令漏登记会以 unknown command 暴露（R1）。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  authFetchMe,
  authFetchServerConfig,
  authGetStatus,
  authLoginPassword,
  authLogout,
  authRefreshNow,
  authSendOtp,
  authVerifyOtp,
  listenAuthStateChanged,
  listenSettingsNavigateTab,
  openLoginWindow,
  settingsOpenTab,
  settingsTakePendingTab,
  ttsSpeakAdvanced,
} from "./tauriBridge";
import type { AuthStatus, AuthUser } from "./tauriBridge";

const mockedInvoke = invoke as unknown as Mock;
const mockedListen = listen as unknown as Mock;

const USER: AuthUser = {
  id: "u-1",
  email: "reader@example.com",
  nickname: "读译",
  plan: "FREE",
  createdAt: "2026-09-01T08:09:10.000Z",
};

const STATUS: AuthStatus = { loggedIn: true, user: USER, notice: null };

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedListen.mockReset();
});

describe("auth IPC 命令封装（§7 表 11 命令）", () => {
  it("1 auth_send_otp(email) → void", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await expect(authSendOtp("a@b.c")).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("auth_send_otp", { email: "a@b.c" });
  });

  it("2 auth_verify_otp(email, code) → AuthSession（device 由 Rust 填，前端不传）", async () => {
    mockedInvoke.mockResolvedValueOnce({ user: USER });
    await expect(authVerifyOtp("a@b.c", "123456")).resolves.toEqual({ user: USER });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_verify_otp", {
      email: "a@b.c",
      code: "123456",
    });
  });

  it("3 auth_login_password(email, password) → AuthSession", async () => {
    mockedInvoke.mockResolvedValueOnce({ user: USER });
    await expect(authLoginPassword("a@b.c", "secret")).resolves.toEqual({ user: USER });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_login_password", {
      email: "a@b.c",
      password: "secret",
    });
  });

  it("4 auth_logout() → LogoutOutcome", async () => {
    mockedInvoke.mockResolvedValueOnce({ serverRevoked: false });
    await expect(authLogout()).resolves.toEqual({ serverRevoked: false });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_logout");
  });

  it("5 auth_get_status() → AuthStatus（无 token 元数据）", async () => {
    mockedInvoke.mockResolvedValueOnce(STATUS);
    const status = await authGetStatus();
    expect(status).toEqual(STATUS);
    expect(Object.keys(status).sort()).toEqual(["loggedIn", "notice", "user"]);
    expect(mockedInvoke).toHaveBeenCalledWith("auth_get_status");
  });

  it("6 auth_refresh_now() → AuthSession", async () => {
    mockedInvoke.mockResolvedValueOnce({ user: USER });
    await expect(authRefreshNow()).resolves.toEqual({ user: USER });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_refresh_now");
  });

  it("7 auth_fetch_me() → AuthUser", async () => {
    mockedInvoke.mockResolvedValueOnce(USER);
    await expect(authFetchMe()).resolves.toEqual(USER);
    expect(mockedInvoke).toHaveBeenCalledWith("auth_fetch_me");
  });

  it("8 auth_fetch_server_config() → 原样透传（serde_json::Value）", async () => {
    const config = { gateway: { base: "x" }, models: [], voice: {}, features: {} };
    mockedInvoke.mockResolvedValueOnce(config);
    await expect(authFetchServerConfig()).resolves.toEqual(config);
    expect(mockedInvoke).toHaveBeenCalledWith("auth_fetch_server_config");
  });

  it("9 open_login_window() → void", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await expect(openLoginWindow()).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("open_login_window");
  });

  it("10 settings_open_tab(tab) → void", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await expect(settingsOpenTab("account")).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("settings_open_tab", { tab: "account" });
  });

  it("11 settings_take_pending_tab() → string | null", async () => {
    mockedInvoke.mockResolvedValueOnce("account");
    await expect(settingsTakePendingTab()).resolves.toBe("account");
    mockedInvoke.mockResolvedValueOnce(null);
    await expect(settingsTakePendingTab()).resolves.toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("settings_take_pending_tab");
  });
});

describe("auth 事件封装（§7 表 2 事件）", () => {
  it("listenAuthStateChanged 转发 auth-state-changed 载荷并透传 unlisten", async () => {
    const unlisten: UnlistenFn = () => undefined;
    mockedListen.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    const got = await listenAuthStateChanged(handler);

    expect(got).toBe(unlisten);
    expect(mockedListen).toHaveBeenCalledWith("auth-state-changed", expect.any(Function));
    // 捕获注册的监听器，模拟 Tauri 事件（Event<T> 只透传 payload）
    const registered = mockedListen.mock.calls[0][1] as EventCallback<AuthStatus>;
    registered({ event: "auth-state-changed", id: 1, payload: STATUS });
    expect(handler).toHaveBeenCalledWith(STATUS);
  });

  it("listenSettingsNavigateTab 转发 settings:navigate-tab 载荷", async () => {
    const unlisten: UnlistenFn = () => undefined;
    mockedListen.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    await listenSettingsNavigateTab(handler);

    expect(mockedListen).toHaveBeenCalledWith("settings:navigate-tab", expect.any(Function));
    const registered = mockedListen.mock.calls[0][1] as EventCallback<string>;
    registered({ event: "settings:navigate-tab", id: 2, payload: "account" });
    expect(handler).toHaveBeenCalledWith("account");
  });
});

describe("ttsSpeakAdvanced 载荷回归（v0.8 ReaderSpeakOptions 增可选 nativeRate 后）", () => {
  it("invoke 载荷只挑 track/rate/voice/target，nativeRate 不进 SAPI 载荷", async () => {
    mockedInvoke.mockResolvedValueOnce(7);
    await expect(
      ttsSpeakAdvanced("hello", false, { track: "word", rate: 1, voice: "Ava", target: "reader", nativeRate: "-25%" }),
    ).resolves.toBe(7);
    expect(mockedInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "hello",
      chinese: false,
      track: "word",
      rate: 1,
      voice: "Ava",
      target: "reader",
    });
  });

  it("缺省载荷与旧版一致（可选项落 null）", async () => {
    mockedInvoke.mockResolvedValueOnce(1);
    await ttsSpeakAdvanced("hi", true);
    expect(mockedInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "hi",
      chinese: true,
      track: null,
      rate: null,
      voice: null,
      target: null,
    });
  });
});
