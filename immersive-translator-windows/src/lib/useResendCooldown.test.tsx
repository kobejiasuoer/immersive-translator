// @vitest-environment jsdom
// useResendCooldown 依赖 localStorage 与定时器（docs §9.1 用例点：60→0 递减、
// 归零恢复、重发重置、按邮箱持久化恢复两档断言 P14/D10）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  OTP_COOLDOWN_SECS,
  OTP_LAST_SENT_KEY,
  OTP_LAST_SENT_MAX_EMAILS,
  parseLastSentMap,
  remainingSeconds,
  useResendCooldown,
  writeLastSent,
} from "./useResendCooldown";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** 记录 hook 最新返回值的宿主（renderHook 的最小替代）。 */
let latest: { remaining: number; start: () => void };

function Host({ email }: { email: string }) {
  latest = useResendCooldown(email);
  return null;
}

function mountHost(email: string): { root: Root; container: HTMLDivElement; rerender(next: string): void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Host email={email} />));
  return {
    root,
    container,
    rerender(next: string) {
      act(() => root.render(<Host email={next} />));
    },
  };
}

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> & { raw: string | null } {
  const s = { raw: null as string | null };
  return {
    get raw() {
      return s.raw;
    },
    getItem: () => s.raw,
    setItem: (_k: string, v: string) => {
      s.raw = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("parseLastSentMap", () => {
  it("丢弃非法条目（非数字 / 非正 / 非对象 / 坏 JSON）", () => {
    expect(parseLastSentMap(null)).toEqual({});
    expect(parseLastSentMap("")).toEqual({});
    expect(parseLastSentMap("not-json")).toEqual({});
    expect(parseLastSentMap('["a"]')).toEqual({});
    expect(parseLastSentMap('{"a":123,"b":"x","c":-1,"d":456.5,"e":null}')).toEqual({
      a: 123,
      d: 456.5,
    });
  });
});

describe("remainingSeconds", () => {
  const now = 1_800_000_000_000;

  it("刚发送 → 满 60；20s 前 → 40；59.5s 前 → 1（向上取整）", () => {
    expect(remainingSeconds({ "a@b.c": now }, "a@b.c", now)).toBe(OTP_COOLDOWN_SECS);
    expect(remainingSeconds({ "a@b.c": now - 20_000 }, "a@b.c", now)).toBe(40);
    expect(remainingSeconds({ "a@b.c": now - 59_500 }, "a@b.c", now)).toBe(1);
  });

  it("70s 前 / 无记录 → 0（无倒计时）", () => {
    expect(remainingSeconds({ "a@b.c": now - 70_000 }, "a@b.c", now)).toBe(0);
    expect(remainingSeconds({}, "a@b.c", now)).toBe(0);
    // 其他邮箱的记录不影响本邮箱
    expect(remainingSeconds({ "x@y.z": now }, "a@b.c", now)).toBe(0);
  });
});

describe("writeLastSent", () => {
  it("写入时间戳并可读回剩余", () => {
    const storage = fakeStorage();
    const map = writeLastSent("a@b.c", 1000, storage);
    expect(map).toEqual({ "a@b.c": 1000 });
    expect(JSON.parse(storage.raw as string)).toEqual({ "a@b.c": 1000 });
  });

  it("容量截断至最近 10 条（最旧的被挤掉）", () => {
    const storage = fakeStorage();
    const base = 1_000_000;
    // 预置 10 个更旧的邮箱
    const pre: Record<string, number> = {};
    for (let i = 0; i < OTP_LAST_SENT_MAX_EMAILS; i++) pre[`old${i}@x.y`] = base + i;
    storage.setItem(OTP_LAST_SENT_KEY, JSON.stringify(pre));
    writeLastSent("new@x.y", base + 9999, storage);
    const persisted = parseLastSentMap(storage.getItem(OTP_LAST_SENT_KEY));
    expect(Object.keys(persisted)).toHaveLength(OTP_LAST_SENT_MAX_EMAILS);
    expect(persisted["new@x.y"]).toBe(base + 9999);
    expect(persisted["old0@x.y"]).toBeUndefined();
    expect(persisted["old9@x.y"]).toBe(base + 9); // 较新的旧记录保留
  });

  it("同一邮箱重发只更新自己的时间戳", () => {
    const storage = fakeStorage();
    writeLastSent("a@b.c", 1000, storage);
    writeLastSent("a@b.c", 5000, storage);
    expect(parseLastSentMap(storage.getItem(OTP_LAST_SENT_KEY))).toEqual({ "a@b.c": 5000 });
  });
});

describe("useResendCooldown hook", () => {
  it("60 → 0 递减、归零停表", () => {
    const { container } = mountHost("a@b.c");
    expect(latest.remaining).toBe(0);
    act(() => latest.start());
    expect(latest.remaining).toBe(60);
    expect(localStorage.getItem(OTP_LAST_SENT_KEY)).toContain("a@b.c");
    for (let i = 1; i <= 60; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(latest.remaining).toBe(60 - i);
    }
    // 归零后不再触发（多走 5 秒仍为 0）
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(latest.remaining).toBe(0);
    container.remove();
  });

  it("重发重置为 60", () => {
    const { container } = mountHost("a@b.c");
    act(() => latest.start());
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(latest.remaining).toBe(50);
    act(() => latest.start());
    expect(latest.remaining).toBe(60);
    container.remove();
  });

  it("持久化恢复：预置 now-20s → 挂载剩余 40（P14 两档之一）", () => {
    const sentAt = Date.now() - 20_000;
    localStorage.setItem(OTP_LAST_SENT_KEY, JSON.stringify({ "a@b.c": sentAt }));
    const { container } = mountHost("a@b.c");
    expect(latest.remaining).toBe(40);
    container.remove();
  });

  it("持久化恢复：预置 now-70s → 无倒计时（P14 两档之二）", () => {
    localStorage.setItem(OTP_LAST_SENT_KEY, JSON.stringify({ "a@b.c": Date.now() - 70_000 }));
    const { container } = mountHost("a@b.c");
    expect(latest.remaining).toBe(0);
    container.remove();
  });

  it("换邮箱时按新邮箱恢复剩余（「换一个邮箱」返回场景）", () => {
    localStorage.setItem(
      OTP_LAST_SENT_KEY,
      JSON.stringify({ "a@b.c": Date.now() - 10_000, "x@y.z": Date.now() - 70_000 }),
    );
    const h = mountHost("a@b.c");
    expect(latest.remaining).toBe(50);
    h.rerender("x@y.z");
    expect(latest.remaining).toBe(0);
    h.container.remove();
  });
});
