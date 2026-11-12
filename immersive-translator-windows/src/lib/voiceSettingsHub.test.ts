// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// 事件总线 mock：emit 广播给所有已注册监听器（含发送窗自己 → 真实 emit 的回声行为），
// listen 返回卸载函数。照 ReaderApp.navigation.test.tsx:9-20 的 hoisted 惯例。
const mocks = vi.hoisted(() => ({
  emits: [] as Array<{ event: string; payload: unknown }>,
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    mocks.emits.push({ event, payload });
    for (const handler of [...(mocks.listeners.get(event) ?? [])]) {
      handler({ payload });
    }
    return Promise.resolve();
  },
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    let set = mocks.listeners.get(event);
    if (!set) {
      set = new Set();
      mocks.listeners.set(event, set);
    }
    set.add(handler);
    return Promise.resolve(() => {
      set!.delete(handler);
    });
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "settings" }),
}));

// 只替换取数侧（resolveVoiceRoute / xfyunTtsCredsConfigured），保留真实纯归约与
// EDGE_FALLBACK_NOTICE / voiceErrorDisplayText 等被 readerSpeechRoute 依赖的绑定。
vi.mock("./voice/voiceRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voice/voiceRoute")>()),
  resolveVoiceRoute: vi.fn(),
}));

vi.mock("./iseCredentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iseCredentials")>()),
  xfyunTtsCredsConfigured: vi.fn(),
}));

import {
  VOICE_PREFS_CHANGED_EVENT,
  currentVoiceChain,
  effectiveShadowAssess,
  foldShadowAssess,
  foldVoiceChain,
  listenVoicePrefsChanged,
  writeReaderVoice,
  writeVoicePrefs,
} from "./voiceSettingsHub";
import { resolveVoiceRoute, type VoiceRouteDecision } from "./voice/voiceRoute";
import { xfyunTtsCredsConfigured } from "./iseCredentials";

const SETTINGS_KEY = "immersive-translator-settings";
const READER_SETTINGS_KEY = "immersive-translator-reader-settings";

function decision(overrides: Partial<VoiceRouteDecision> = {}): VoiceRouteDecision {
  return { engine: "gateway", reason: null, hint: null, ...overrides };
}

/** 直接向已注册监听器投递一条跨窗事件（模拟其他窗口 emit 到达本窗）。 */
function deliver(payload: unknown): void {
  for (const handler of mocks.listeners.get(VOICE_PREFS_CHANGED_EVENT) ?? []) {
    handler({ payload });
  }
}

beforeEach(() => {
  localStorage.clear();
  mocks.emits.length = 0;
  mocks.listeners.clear();
  vi.clearAllMocks();
});

describe("foldShadowAssess（打分链 AND 链投影，§5.2 A-3）", () => {
  it("跟读模式关 → 断在 mode，下游环未评估（null）", () => {
    const p = foldShadowAssess({
      shadowingMode: false,
      shadowingAssess: true,
      iseSwitchOn: true,
      iseRoute: decision(),
    });
    expect(p.effective).toBe(false);
    expect(p.broken).toBe("mode");
    expect(p.links).toEqual({ mode: false, assess: null, settings: null, server: null });
  });

  it("跟读评测关 → 断在 assess", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: false,
      iseSwitchOn: true,
      iseRoute: decision(),
    });
    expect(p.effective).toBe(false);
    expect(p.broken).toBe("assess");
    expect(p.links).toEqual({ mode: true, assess: false, settings: null, server: null });
  });

  it("iseRoute=null（未经沉浸云守卫）按讯飞直连同口径：抽屉两环全通即放行", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: false,
      iseRoute: null,
    });
    expect(p.effective).toBe(true);
    expect(p.broken).toBe(null);
    expect(p.links).toEqual({ mode: true, assess: true, settings: null, server: null });
  });

  it("engine=xfyun（讯飞直连）→ 评分开关与服务端环不适用，不提示（§5.2 A-3）", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: false,
      iseRoute: decision({ engine: "xfyun" }),
    });
    expect(p.effective).toBe(true);
    expect(p.broken).toBe(null);
    expect(p.links).toEqual({ mode: true, assess: true, settings: null, server: null });
  });

  it("沉浸云全链开（engine=gateway）→ 全通", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: true,
      iseRoute: decision(),
    });
    expect(p.effective).toBe(true);
    expect(p.broken).toBe(null);
    expect(p.links).toEqual({ mode: true, assess: true, settings: true, server: true });
  });

  it("评分开关关（ise_turned_off）→ 断在 settings，服务端环未评估", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: false,
      iseRoute: decision({ engine: "off", reason: "ise_turned_off", hint: "x" }),
    });
    expect(p.effective).toBe(false);
    expect(p.broken).toBe("settings");
    expect(p.links).toEqual({ mode: true, assess: true, settings: false, server: null });
  });

  it("配额耗尽且开关开 → 断在 server", () => {
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: true,
      iseRoute: decision({ engine: "off", reason: "quota_exhausted", hint: "x" }),
    });
    expect(p.broken).toBe("server");
    expect(p.links).toEqual({ mode: true, assess: true, settings: true, server: false });
  });

  it("配额耗尽且开关也关 → chips 顺序取第一条断环（settings 先于 server）", () => {
    // reduceVoiceRoute 里配额先于本地开关归约（voiceRoute.ts:120 → :128），
    // reason 不会是 ise_turned_off，但开关事实为关——归因按 UI 指引优先级。
    const p = foldShadowAssess({
      shadowingMode: true,
      shadowingAssess: true,
      iseSwitchOn: false,
      iseRoute: decision({ engine: "off", reason: "quota_exhausted", hint: "x" }),
    });
    expect(p.broken).toBe("settings");
    expect(p.links).toEqual({ mode: true, assess: true, settings: false, server: false });
  });
});

describe("effectiveShadowAssess（异步取数版：现查守卫 + 现读评分开关）", () => {
  it("守卫 off + 开关关（localStorage 显式 false）→ 断在 settings", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ voiceGatewayIseEnabled: false }));
    vi.mocked(resolveVoiceRoute).mockResolvedValue(
      decision({ engine: "off", reason: "ise_turned_off", hint: "x" }),
    );
    const p = await effectiveShadowAssess({ shadowingMode: true, shadowingAssess: true });
    expect(p.broken).toBe("settings");
    expect(resolveVoiceRoute).toHaveBeenCalledWith("ise");
  });

  it("开关未存过（undefined）视为开 + 守卫放行 → 全通", async () => {
    vi.mocked(resolveVoiceRoute).mockResolvedValue(decision());
    const p = await effectiveShadowAssess({ shadowingMode: true, shadowingAssess: true });
    expect(p.effective).toBe(true);
    expect(p.links.settings).toBe(true);
  });

  it("抽屉侧跟读模式关 → 不查守卫也要给出 mode 断环（守卫结果仍取回，归约兜底）", async () => {
    vi.mocked(resolveVoiceRoute).mockResolvedValue(decision());
    const p = await effectiveShadowAssess({ shadowingMode: false, shadowingAssess: false });
    expect(p.broken).toBe("mode");
    expect(p.links.assess).toBe(null);
  });
});

describe("foldVoiceChain（链路行投影，§5.2 A-1 口径）", () => {
  it("Edge 在线档", () => {
    expect(foldVoiceChain({ ttsProvider: "edge" })).toEqual({
      engine: "edge",
      label: "Edge 在线 · 免费直连",
      fallbackNotice: null,
      tone: "ok",
    });
  });

  it("系统语音档", () => {
    expect(foldVoiceChain({ ttsProvider: "local" })).toEqual({
      engine: "local",
      label: "系统语音 · 离线可用",
      fallbackNotice: null,
      tone: "ok",
    });
  });

  it("旧 xfyun 档 + TTS 凭据齐全 → 讯飞直连（不经守卫，readerSpeechRoute.ts:39-41）", () => {
    const p = foldVoiceChain({ ttsProvider: "xfyun", xfyunTtsReady: true });
    expect(p.engine).toBe("cloud-xfyun");
    expect(p.label).toBe("云音色 · 讯飞 · 合成凭据已配置 ✓");
    expect(p.fallbackNotice).toBe(null);
  });

  it("旧 xfyun 档缺 TTS 凭据 → 播放回落系统语音（readerSpeechRoute.ts:40）", () => {
    const p = foldVoiceChain({ ttsProvider: "xfyun", xfyunTtsReady: false });
    expect(p.engine).toBe("local");
    expect(p.label).toBe("云音色 · 讯飞 · 合成凭据未配置 · 播放回落系统语音");
    expect(p.tone).toBe("warn");
  });

  it("cloud + 守卫放行（engine=gateway）→ 沉浸云已登录", () => {
    const p = foldVoiceChain({
      ttsProvider: "cloud",
      ttsRoute: decision(),
      xfyunTtsReady: true,
    });
    expect(p.engine).toBe("cloud-gateway");
    expect(p.label).toBe("云音色 · 沉浸云 · 已登录");
    expect(p.fallbackNotice).toBe(null);
  });

  it("cloud + voiceProvider=讯飞（engine=xfyun）→ 复用讯飞直连档", () => {
    const p = foldVoiceChain({
      ttsProvider: "cloud",
      ttsRoute: decision({ engine: "xfyun" }),
      xfyunTtsReady: false,
    });
    expect(p.engine).toBe("local");
    expect(p.label).toBe("云音色 · 讯飞 · 合成凭据未配置 · 播放回落系统语音");
  });

  it("cloud + 守卫 off → 临时回落 Edge 并带回落决策（readerEdgeFallbackNotice 统一口径）", () => {
    const p = foldVoiceChain({
      ttsProvider: "cloud",
      ttsRoute: decision({
        engine: "off",
        reason: "not_logged_in",
        hint: "请先登录，再检查云语音是否开放；也可在「设置 → 语音」使用讯飞",
      }),
      xfyunTtsReady: true,
    });
    expect(p.engine).toBe("edge");
    expect(p.label).toBe("Edge 在线 · 免费直连");
    expect(p.tone).toBe("warn");
    expect(p.fallbackNotice).toBe(
      "已临时使用 Edge 朗读：请先登录，再检查云语音是否开放；也可在「设置 → 语音」使用讯飞",
    );
  });

  it("cloud + 配额耗尽 → 回落说明走配额文案（不在此处复写映射）", () => {
    const p = foldVoiceChain({
      ttsProvider: "cloud",
      ttsRoute: decision({ engine: "off", reason: "quota_exhausted", hint: "x" }),
      xfyunTtsReady: true,
    });
    expect(p.engine).toBe("edge");
    expect(p.fallbackNotice?.startsWith("已临时使用 Edge 朗读")).toBe(true);
  });
});

describe("currentVoiceChain（异步取数版）", () => {
  it("edge/local 档不查守卫、不查凭据", async () => {
    await currentVoiceChain({ ttsProvider: "edge" });
    await currentVoiceChain({ ttsProvider: "local" });
    expect(resolveVoiceRoute).not.toHaveBeenCalled();
    expect(xfyunTtsCredsConfigured).not.toHaveBeenCalled();
  });

  it("cloud 档现查守卫与讯飞 TTS 凭据（与播放侧同源，voiceRoute.ts:206）", async () => {
    vi.mocked(resolveVoiceRoute).mockResolvedValue(decision({ engine: "xfyun" }));
    vi.mocked(xfyunTtsCredsConfigured).mockResolvedValue(true);
    const p = await currentVoiceChain({ ttsProvider: "cloud" });
    expect(resolveVoiceRoute).toHaveBeenCalledWith("tts");
    expect(p.engine).toBe("cloud-xfyun");
    expect(p.label).toBe("云音色 · 讯飞 · 合成凭据已配置 ✓");
  });

  it("旧 xfyun 档只查 TTS 凭据（不经守卫，与 readerSpeechRoute:39 同语义）", async () => {
    vi.mocked(xfyunTtsCredsConfigured).mockResolvedValue(false);
    const p = await currentVoiceChain({ ttsProvider: "xfyun" });
    expect(resolveVoiceRoute).not.toHaveBeenCalled();
    expect(p.engine).toBe("local");
    expect(p.label).toBe("云音色 · 讯飞 · 合成凭据未配置 · 播放回落系统语音");
  });
});

describe("writeVoicePrefs / writeReaderVoice（写 API + 广播）", () => {
  it("writeVoicePrefs 落盘 L0 三字段合并 + 广播 voicePrefs scope", () => {
    writeVoicePrefs({ voiceProvider: "gateway", voiceGatewayVoice: "mock-male" });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      voiceProvider: "gateway",
      voiceGatewayVoice: "mock-male",
    });
    expect(mocks.emits[mocks.emits.length - 1]!.event).toBe(VOICE_PREFS_CHANGED_EVENT);
    expect(mocks.emits[mocks.emits.length - 1]!.payload).toMatchObject({
      scopes: ["voicePrefs"],
      from: "settings",
    });
  });

  it("payload 只带 { scopes, from, rev } 不带值；rev 单调递增防乱序", () => {
    writeVoicePrefs({ voiceProvider: "xfyun" });
    writeVoicePrefs({ voiceGatewayIseEnabled: false });
    expect(mocks.emits).toHaveLength(2);
    const first = mocks.emits[0].payload as Record<string, unknown>;
    const second = mocks.emits[1].payload as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["from", "rev", "scopes"]);
    expect(second.rev).toBe((first.rev as number) + 1);
    // 不带值：补丁里的具体字段不出现在 payload
    expect(JSON.stringify(first)).not.toContain("xfyun");
  });

  it("writeReaderVoice 读-合并-整包写 L1 全局键 + 广播 readerVoice scope", () => {
    writeReaderVoice({ ttsProvider: "local", rate: 1.5 });
    const raw = JSON.parse(localStorage.getItem(READER_SETTINGS_KEY)!);
    expect(raw.ttsProvider).toBe("local");
    expect(raw.rate).toBe(1.5);
    // 整包写：loadGlobalReaderSettings 的默认字段一并落盘（下次读回经 mergeReaderSettings）
    expect(raw.shadowingMode).toBe(false);
    expect(mocks.emits[mocks.emits.length - 1]!.payload).toMatchObject({
      scopes: ["readerVoice"],
    });
  });

  it("writeReaderVoice 二次写不丢先前的即时值（读-合并在同一 API 内完成）", () => {
    writeReaderVoice({ rate: 1.5 });
    writeReaderVoice({ ttsProvider: "edge" });
    const raw = JSON.parse(localStorage.getItem(READER_SETTINGS_KEY)!);
    expect(raw.rate).toBe(1.5);
    expect(raw.ttsProvider).toBe("edge");
  });
});

describe("listenVoicePrefsChanged（回声抑制 / 乱序 / scope 过滤 / 卸载）", () => {
  it("自己窗口的广播是回声：from===当前 label，不回执", async () => {
    const handler = vi.fn();
    await listenVoicePrefsChanged(handler);
    writeVoicePrefs({ voiceProvider: "gateway" }); // 本窗写盘 + emit → 总线回投给自己
    expect(handler).not.toHaveBeenCalled();
  });

  it("跨窗事件回执；回执方重读存储拿最新值（payload 不带值协议）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const unlisten = await listenVoicePrefsChanged(() => {
      seen.push(JSON.parse(localStorage.getItem(READER_SETTINGS_KEY)!));
    });
    writeReaderVoice({ rate: 2 }); // 阅读室收到的值要靠重读 localStorage 取得
    deliver({ scopes: ["readerVoice"], from: "reader", rev: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ rate: 2 });
    unlisten();
  });

  it("同一发送方 rev 乱序：旧事件（rev ≤ 已见值）忽略，新事件回执", async () => {
    const handler = vi.fn();
    await listenVoicePrefsChanged(handler);
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 3 });
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 2 }); // 乱序旧事件
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 3 }); // 重放
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 4 }); // 新事件
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map((c) => (c[0] as { rev: number }).rev)).toEqual([3, 4]);
  });

  it("不同发送方各自计数：B 的 rev1 不被 A 的 rev3 挡掉", async () => {
    const handler = vi.fn();
    await listenVoicePrefsChanged(handler);
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 3 });
    deliver({ scopes: ["voicePrefs"], from: "quick-review", rev: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("scope 过滤：订阅 readerVoice 时不回执 voicePrefs 事件", async () => {
    const handler = vi.fn();
    await listenVoicePrefsChanged(handler, { scopes: ["readerVoice"] });
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 1 });
    expect(handler).not.toHaveBeenCalled();
    deliver({ scopes: ["readerVoice"], from: "reader", rev: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unlisten 卸载后不再回执（消费方 active + unlisten 模式的另一半）", async () => {
    const handler = vi.fn();
    const unlisten = await listenVoicePrefsChanged(handler);
    unlisten();
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("畸形 payload（缺字段/非对象）不回执也不抛错", async () => {
    const handler = vi.fn();
    await listenVoicePrefsChanged(handler);
    deliver(null);
    deliver("junk");
    deliver({ from: "reader", rev: 1 }); // 缺 scopes
    deliver({ scopes: ["voicePrefs"], rev: 1 }); // 缺 from
    deliver({ scopes: ["voicePrefs"], from: "reader", rev: Number.NaN }); // rev 非有限数
    expect(handler).not.toHaveBeenCalled();
  });
});
