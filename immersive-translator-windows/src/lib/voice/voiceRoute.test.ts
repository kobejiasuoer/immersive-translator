// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tauriBridge", () => ({
  authGetStatus: vi.fn(),
}));

vi.mock("../settingsStore", () => ({
  loadSettings: vi.fn(),
  resolveInitialVoiceProvider: vi.fn(),
}));

vi.mock("./voiceCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voiceCapabilities")>()),
  getVoiceCapabilities: vi.fn(),
}));

import { authGetStatus } from "../tauriBridge";
import { loadSettings, resolveInitialVoiceProvider } from "../settingsStore";
import { getVoiceCapabilities, type VoiceCapabilities } from "./voiceCapabilities";
import {
  EDGE_FALLBACK_NOTICE,
  reduceVoiceRoute,
  resolveVoiceRoute,
  resetVoiceRouteForTests,
} from "./voiceRoute";

function caps(overrides: Partial<VoiceCapabilities> = {}): VoiceCapabilities {
  return {
    available: true,
    ttsVoices: [{ id: "mock", label: "Mock" }],
    asrLanguages: ["en_us", "zh_cn"],
    iseEnabled: true,
    quota: null,
    ...overrides,
  };
}

describe("reduceVoiceRoute(守卫归约,契约 §三.5)", () => {
  it("未登录 → off + 「登录沉浸云即用」引导(即使能力已拉到)", () => {
    const d = reduceVoiceRoute({ loggedIn: false, caps: caps(), quotaEvents: [], ability: "asr" });
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("not_logged_in");
    expect(d.hint).toBe("登录沉浸云即用");
  });

  it("能力未拉到(null)→ off + caps_unavailable(网络类文案)", () => {
    const d = reduceVoiceRoute({ loggedIn: true, caps: null, quotaEvents: [], ability: "tts" });
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("caps_unavailable");
    expect(d.hint).toContain("沉浸云");
  });

  it("voice 段缺失(官方云未开通)→ off + voice_not_configured,不给重试类误导", () => {
    const d = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ available: false }),
      quotaEvents: [],
      ability: "ise",
    });
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("voice_not_configured");
    expect(d.hint).toBe("语音功能暂未开通");
  });

  it("能力拉取失败且错误码是 banned → off + banned(「账号已被封禁」,不暗示重试)", () => {
    const d = reduceVoiceRoute({
      loggedIn: true,
      caps: null,
      capsError: "banned",
      quotaEvents: [],
      ability: "asr",
    });
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("banned");
    expect(d.hint).toBe("账号已被封禁");
  });

  it("配额耗尽(常驻 remaining===0,按能力分开看)→ off + quota_exhausted", () => {
    const c = caps({ quota: { asr: { remaining: 0, allowance: 600, resetsAt: null } } });
    const blocked = reduceVoiceRoute({ loggedIn: true, caps: c, quotaEvents: [], ability: "asr" });
    expect(blocked.engine).toBe("off");
    expect(blocked.reason).toBe("quota_exhausted");
    expect(blocked.hint).toContain("本月识别额度已用完");
    // 其他能力不受影响(耗尽不整卡殃及)
    const ttsOk = reduceVoiceRoute({ loggedIn: true, caps: c, quotaEvents: [], ability: "tts" });
    expect(ttsOk.engine).toBe("gateway");
  });

  it("配额耗尽(402 事件别名兜底:tts_chars → tts)", () => {
    const d = reduceVoiceRoute({
      loggedIn: true,
      caps: caps(),
      quotaEvents: ["tts_chars"],
      ability: "tts",
    });
    expect(d.reason).toBe("quota_exhausted");
    expect(d.hint).toContain("本月朗读额度已用完");
    // 未知 resource 不误伤
    const d2 = reduceVoiceRoute({
      loggedIn: true,
      caps: caps(),
      quotaEvents: ["llm_tokens"],
      ability: "tts",
    });
    expect(d2.engine).toBe("gateway");
  });

  it("能力缺失:ttsVoices 空 / asrLanguages 空 / 语种未下发 / iseEnabled=false", () => {
    const noTts = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ ttsVoices: [] }),
      quotaEvents: [],
      ability: "tts",
    });
    expect(noTts.reason).toBe("capability_missing");

    const noAsr = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ asrLanguages: [] }),
      quotaEvents: [],
      ability: "asr",
    });
    expect(noAsr.reason).toBe("capability_missing");

    // 录音直译中→英要 zh_cn;未下发该语种时精确拦下
    const noZh = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ asrLanguages: ["en_us"] }),
      quotaEvents: [],
      ability: "asr",
      asrLang: "zh_cn",
    });
    expect(noZh.reason).toBe("capability_missing");
    const zhOk = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ asrLanguages: ["en_us", "zh_cn"] }),
      quotaEvents: [],
      ability: "asr",
      asrLang: "zh_cn",
    });
    expect(zhOk.engine).toBe("gateway");

    const noIse = reduceVoiceRoute({
      loggedIn: true,
      caps: caps({ iseEnabled: false }),
      quotaEvents: [],
      ability: "ise",
    });
    expect(noIse.reason).toBe("capability_missing");
  });

  it("本地跟读打分开关关闭 → off + ise_turned_off(服务端 iseEnabled 正常)", () => {
    const d = reduceVoiceRoute({
      loggedIn: true,
      caps: caps(),
      quotaEvents: [],
      ability: "ise",
      iseLocalOff: true,
    });
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("ise_turned_off");
    expect(d.hint).toContain("设置 → 语音");
    // 开关只作用于 ise
    const asr = reduceVoiceRoute({
      loggedIn: true,
      caps: caps(),
      quotaEvents: [],
      ability: "asr",
      iseLocalOff: true,
    });
    expect(asr.engine).toBe("gateway");
  });

  it("全部满足 → 放行 gateway(三项能力各验一次)", () => {
    for (const ability of ["tts", "asr", "ise"] as const) {
      const d = reduceVoiceRoute({ loggedIn: true, caps: caps(), quotaEvents: [], ability });
      expect(d).toEqual({ engine: "gateway", reason: null, hint: null });
    }
  });

  it("EDGE_FALLBACK_NOTICE 是契约 §三.5 的回落标注文案", () => {
    expect(EDGE_FALLBACK_NOTICE).toBe("已临时使用 Edge 朗读");
  });
});

describe("resolveVoiceRoute(取数侧:xfyun 直不经守卫,gateway 归约)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceRouteForTests();
    // 缺省:未存过语音偏好(loadSettings 只提供字段,freshness 测试单独覆盖)
    vi.mocked(loadSettings).mockReturnValue({} as ReturnType<typeof loadSettings>);
  });

  it("provider=xfyun(存量讯飞用户)→ 直接放行直连路径,不查登录态与能力", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("xfyun");
    const d = await resolveVoiceRoute("asr");
    expect(d).toEqual({ engine: "xfyun", reason: null, hint: null });
    expect(authGetStatus).not.toHaveBeenCalled();
    expect(getVoiceCapabilities).not.toHaveBeenCalled();
  });

  it("provider=gateway + 未登录 → off;登录态每次现查", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: false, user: null, notice: null });
    const d = await resolveVoiceRoute("tts");
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("not_logged_in");
    expect(getVoiceCapabilities).not.toHaveBeenCalled();
  });

  it("provider=gateway + 已登录 + 能力正常 → gateway;caps 走 TTL 缓存", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
    vi.mocked(authGetStatus).mockResolvedValue({
      loggedIn: true,
      user: null,
      notice: null,
    });
    vi.mocked(getVoiceCapabilities).mockResolvedValue(caps());
    const first = await resolveVoiceRoute("asr", { asrLang: "en_us" });
    expect(first.engine).toBe("gateway");
    const second = await resolveVoiceRoute("ise");
    expect(second.engine).toBe("gateway");
    expect(getVoiceCapabilities).toHaveBeenCalledTimes(1); // 第二次命中缓存
  });

  it("能力拉取失败 → off + caps_unavailable(不缓存失败态)", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    vi.mocked(getVoiceCapabilities).mockRejectedValue(new Error("network down"));
    const d = await resolveVoiceRoute("tts");
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("caps_unavailable");
    // 失败不缓存:恢复后下一次重拉成功
    vi.mocked(getVoiceCapabilities).mockResolvedValue(caps());
    const ok = await resolveVoiceRoute("tts");
    expect(ok.engine).toBe("gateway");
  });

  it("能力拉取失败(AuthError banned)→ off + banned:封禁与网络失败文案分开", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    vi.mocked(getVoiceCapabilities).mockRejectedValue({ code: "banned", message: "stub" });
    const d = await resolveVoiceRoute("ise");
    expect(d.engine).toBe("off");
    expect(d.reason).toBe("banned");
    expect(d.hint).toBe("账号已被封禁");
  });

  it("ise:本地开关关闭(voiceGatewayIseEnabled=false)→ off + ise_turned_off", async () => {
    vi.mocked(resolveInitialVoiceProvider).mockResolvedValue("gateway");
    vi.mocked(authGetStatus).mockResolvedValue({ loggedIn: true, user: null, notice: null });
    vi.mocked(getVoiceCapabilities).mockResolvedValue(caps());
    vi.mocked(loadSettings).mockReturnValue({
      voiceProvider: "gateway",
      voiceGatewayIseEnabled: false,
    } as ReturnType<typeof loadSettings>);
    const d = await resolveVoiceRoute("ise");
    expect(d.reason).toBe("ise_turned_off");
    // 开关缺省(未存过)视为开
    vi.mocked(loadSettings).mockReturnValue({
      voiceProvider: "gateway",
    } as ReturnType<typeof loadSettings>);
    const on = await resolveVoiceRoute("ise");
    expect(on.engine).toBe("gateway");
  });
});
