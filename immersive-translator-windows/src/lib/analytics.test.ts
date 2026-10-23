// 云端埋点 track()（Phase 0 任务 1，计划书 §8）：
// 白名单外事件不发；payload 只含 { event, properties }（ts 由 Rust 打上）；
// 未登录（unauthorized reject）/失败一律静默吞掉——不抛错、不重试、无未处理拒绝。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { isAnalyticsEventName, track, type AnalyticsEventName } from "./analytics";

const mockedInvoke = invoke as unknown as Mock;

const AUTH_ERROR_UNAUTHORIZED = {
  code: "unauthorized",
  message: "未登录",
  httpStatus: null,
  retryAfterSeconds: null,
};

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("事件白名单", () => {
  it("Phase 0 全部 7 个事件名都放行", () => {
    const names: AnalyticsEventName[] = [
      "speak_session_start",
      "speak_session_end",
      "scenario_create",
      "scenario_generate_result",
      "discover_view",
      "discover_import",
      "book_open",
    ];
    expect(names).toHaveLength(7);
    for (const name of names) {
      expect(isAnalyticsEventName(name)).toBe(true);
    }
  });

  it("白名单外事件不发请求（静默丢弃）", () => {
    mockedInvoke.mockResolvedValue(undefined);
    // 运行时白名单是字符串比对；绕过编译期类型模拟未来调用方误用
    const trackAny = track as (event: string, props: Record<string, unknown>) => void;
    expect(() => trackAny("unknown_event", { foo: 1 })).not.toThrow();
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(isAnalyticsEventName("random_name")).toBe(false);
  });
});

describe("payload 形状", () => {
  it("invoke 载荷为 { event, properties }，ts 不在 JS 侧（Rust 发送时打上）", () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    track("speak_session_start", { scenarioId: "interview", scenarioSource: "builtin" });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("auth_track_event", {
      event: "speak_session_start",
      properties: { scenarioId: "interview", scenarioSource: "builtin" },
    });
  });

  it("speak_session_end 带轮次与时长", () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    track("speak_session_end", { scenarioId: "ordering", turns: 6, durationSeconds: 240 });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_track_event", {
      event: "speak_session_end",
      properties: { scenarioId: "ordering", turns: 6, durationSeconds: 240 },
    });
  });

  it("book_open 可不带 chapterIdx（契约可选字段）", () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    track("book_open", { bookId: "b-1" });
    expect(mockedInvoke).toHaveBeenCalledWith("auth_track_event", {
      event: "book_open",
      properties: { bookId: "b-1" },
    });
  });
});

describe("未登录 / 失败静默", () => {
  it("未登录（unauthorized reject）：不抛错、不重试、无未处理拒绝", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      mockedInvoke.mockRejectedValueOnce(AUTH_ERROR_UNAUTHORIZED);
      expect(() => track("book_open", { bookId: "b-1", chapterIdx: 0 })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedInvoke).toHaveBeenCalledTimes(1); // 不重试
      expect(unhandled).toEqual([]); // .catch 吞掉，不泄漏未处理拒绝
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("网络/服务端失败（非 2xx reject）同样吞掉", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      mockedInvoke.mockRejectedValueOnce(new Error("network down"));
      expect(() => track("discover_view", {})).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("invoke 同步抛错（桥接不可用）也不影响主流程", () => {
    mockedInvoke.mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });
    expect(() => track("speak_session_start", { scenarioId: "travel", scenarioSource: "builtin" })).not.toThrow();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});
