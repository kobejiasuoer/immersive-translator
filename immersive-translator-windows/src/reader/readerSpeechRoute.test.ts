import { describe, expect, it, vi } from "vitest";
import { EDGE_FALLBACK_NOTICE, type VoiceRouteDecision } from "../lib/voice";
import type { SpeechEngine } from "./speechEngine";
import { readerEdgeFallbackNotice, routeReaderSpeech } from "./readerSpeechRoute";

function engine(name: string): SpeechEngine {
  return { name } as unknown as SpeechEngine;
}

const engines = {
  edge: engine("edge"),
  xfyun: engine("xfyun"),
  gateway: engine("gateway"),
  sapi: engine("sapi"),
};

const gateway: VoiceRouteDecision = { engine: "gateway", reason: null, hint: null };
const xfyun: VoiceRouteDecision = { engine: "xfyun", reason: null, hint: null };

describe("routeReaderSpeech（阅读室朗读路由：cloud 跟随 voiceProvider）", () => {
  it("edge / local 不经过守卫，直达本地引擎", async () => {
    const resolve = vi.fn().mockResolvedValue(gateway);
    await expect(routeReaderSpeech({ provider: "edge", xfyunReady: false, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.edge, fallback: null },
    );
    await expect(routeReaderSpeech({ provider: "local", xfyunReady: false, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.sapi, fallback: null },
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("旧 xfyun（未迁移）不经新守卫：有凭据走讯飞，无凭据回落本地", async () => {
    const resolve = vi.fn().mockResolvedValue(gateway);
    await expect(routeReaderSpeech({ provider: "xfyun", xfyunReady: true, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.xfyun, fallback: null },
    );
    await expect(routeReaderSpeech({ provider: "xfyun", xfyunReady: false, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.sapi, fallback: null },
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cloud + voiceProvider=gateway（守卫通过）→ 网关流式引擎", async () => {
    const resolve = vi.fn().mockResolvedValue(gateway);
    await expect(routeReaderSpeech({ provider: "cloud", xfyunReady: false, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.gateway, fallback: null },
    );
    expect(resolve).toHaveBeenCalledWith("tts");
  });

  it("cloud + voiceProvider=xfyun（存量讯飞直连）→ 讯飞或本地，零改动", async () => {
    const resolve = vi.fn().mockResolvedValue(xfyun);
    await expect(routeReaderSpeech({ provider: "cloud", xfyunReady: true, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.xfyun, fallback: null },
    );
    await expect(routeReaderSpeech({ provider: "cloud", xfyunReady: false, engines, resolveRoute: resolve })).resolves.toEqual(
      { engine: engines.sapi, fallback: null },
    );
  });

  it("cloud + 守卫不通过 → 静默转 Edge 并带回落决策（不弹登录墙）", async () => {
    const decision: VoiceRouteDecision = { engine: "off", reason: "not_logged_in", hint: "登录沉浸云即用" };
    await expect(
      routeReaderSpeech({ provider: "cloud", xfyunReady: false, engines, resolveRoute: vi.fn().mockResolvedValue(decision) }),
    ).resolves.toEqual({ engine: engines.edge, fallback: decision });
  });
});

describe("readerEdgeFallbackNotice（EDGE_FALLBACK_NOTICE 的消费方）", () => {
  it("非配额回落：前缀 EDGE_FALLBACK_NOTICE + 决策引导，无动作位", () => {
    const notice = readerEdgeFallbackNotice({ engine: "off", reason: "not_logged_in", hint: "登录沉浸云即用" });
    expect(notice.message).toBe(`${EDGE_FALLBACK_NOTICE}：登录沉浸云即用`);
    expect(notice.action).toBeNull();
  });

  it("配额耗尽：带重置时间与兑换动作（复用统一错误映射）", () => {
    const notice = readerEdgeFallbackNotice({
      engine: "off",
      reason: "quota_exhausted",
      hint: "本月朗读额度已用完",
      quota: { remaining: 0, allowance: 1000, resetsAt: "2026-10-31T23:59:59Z" },
    });
    expect(notice.message).toContain(EDGE_FALLBACK_NOTICE);
    expect(notice.message).toContain("本月朗读额度已用完");
    expect(notice.message).toContain("重置");
    expect(notice.action).toBe("redeem");
  });
});
