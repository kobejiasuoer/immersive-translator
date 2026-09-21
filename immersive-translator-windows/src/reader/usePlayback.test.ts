import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndedEvent, SpeechEngine } from "./speechEngine";
import { usePlayback } from "./usePlayback";

// node 环境只模拟 Hook 存储与 effect 挂载，执行真实的播放回调和 Promise 链。
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cleanups: [] as Array<() => void>,
}));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.states.length;
    hooks.states.push(initial);
    return [initial, (value: unknown) => { hooks.states[index] = value; }];
  },
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));

function deferred() {
  let resolve!: (gen: number) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  let ended!: (event: EndedEvent) => void;
  const speak = vi.fn<SpeechEngine["speak"]>().mockResolvedValue(100);
  const stopTrack = vi.fn<SpeechEngine["stopTrack"]>().mockResolvedValue();
  const prefetch = vi.fn();
  const onError = vi.fn();
  const onFinish = vi.fn();
  const playback = usePlayback({
    target: "reader",
    textsRef: { current: ["First sentence.", "Second sentence."] },
    settingsRef: { current: { rate: 1, voice: "", sentencePauseMs: 0, shadowingMode: false } },
    engine: { speak, stopTrack, prefetch, onEnded: (handler) => { ended = handler; return () => undefined; } },
    onError, onFinish,
  });
  return { playback, speak, stopTrack, prefetch, onError, onFinish, ended: (gen: number) => ended({ gen, track: "sentence" }) };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("usePlayback 启动失败", () => {
  beforeEach(() => {
    hooks.states.length = 0;
    hooks.cleanups.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    hooks.cleanups.forEach((cleanup) => cleanup());
    vi.restoreAllMocks();
  });

  it("拒绝后停止、保留当前句、提示原始错误，用户可重试", async () => {
    const s = setup();
    const error = new Error("今日免费调用次数已用完（11201）");
    s.speak.mockRejectedValueOnce(error);
    s.playback.toggle();
    expect(hooks.states[0]).toBe(true);
    await flush();
    expect(hooks.states.slice(0, 3)).toEqual([false, 0, false]);
    expect(s.stopTrack).toHaveBeenCalledWith("sentence");
    expect(s.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(s.prefetch).not.toHaveBeenCalled();
    expect(s.onFinish).not.toHaveBeenCalled();
    s.playback.toggle();
    await flush();
    expect(hooks.states[0]).toBe(true);
    s.ended(100);
    expect(hooks.states[1]).toBe(1);
  });

  it("跳到新句后，旧请求的失败不会停止新播放或显示过期错误", async () => {
    const s = setup();
    const old = deferred();
    s.speak.mockReturnValueOnce(old.promise).mockResolvedValueOnce(200);
    s.playback.toggle();
    s.playback.jumpTo(1);
    await flush();
    old.reject(new Error("old failure"));
    await flush();
    expect(hooks.states[0]).toBe(true);
    expect(s.stopTrack).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
    s.ended(200);
    expect(s.onFinish).toHaveBeenCalledOnce();
  });

  it("跳句后旧请求成功不会覆盖当前代数", async () => {
    const s = setup();
    const old = deferred();
    s.speak.mockReturnValueOnce(old.promise).mockResolvedValueOnce(200);
    s.playback.toggle();
    s.playback.jumpTo(1);
    await flush();
    old.resolve(100);
    await flush();
    s.ended(100);
    expect(s.onFinish).not.toHaveBeenCalled();
    s.ended(200);
    expect(s.onFinish).toHaveBeenCalledOnce();
  });

  it("停止后到达的失败不重复停止或提示", async () => {
    const s = setup();
    const pending = deferred();
    s.speak.mockReturnValueOnce(pending.promise);
    s.playback.toggle();
    s.playback.stop();
    pending.reject(new Error("cancelled request"));
    await flush();
    expect(hooks.states[0]).toBe(false);
    expect(s.stopTrack).toHaveBeenCalledOnce();
    expect(s.onError).not.toHaveBeenCalled();
  });
});
