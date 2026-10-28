// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  inferVoiceProvider,
  loadSettingsFullAsync,
  persistVoicePrefsField,
  resolveInitialVoiceProvider,
  saveSettingsFullAsync,
  saveVoicePrefs,
  stripVoicePrefs,
  type AppSettings,
  type VoiceProvider,
} from "./settingsStore";
import { xfyunCredentialPresence } from "./iseCredentials";
import { authServerBaseUrl, secretGet, secretSet } from "./tauriBridge";

vi.mock("./tauriBridge", () => ({
  authServerBaseUrl: vi.fn(),
  secretGet: vi.fn(),
  secretSet: vi.fn(),
}));

vi.mock("./iseCredentials", () => ({
  xfyunCredentialPresence: vi.fn(),
}));

const STORAGE_KEY = "immersive-translator-settings";

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** mock(xfyunCredentialPresence).mockResolvedValue 的便捷封装。 */
function presence(p: { iseMain?: boolean; ttsOwn?: boolean; asrOwn?: boolean }) {
  vi.mocked(xfyunCredentialPresence).mockResolvedValue({
    iseMain: p.iseMain ?? false,
    ttsOwn: p.ttsOwn ?? false,
    asrOwn: p.asrOwn ?? false,
  });
}

describe("inferVoiceProvider（迁移推断谓词，契约 §三.3）", () => {
  it("任一讯飞凭据存在 → 保持 xfyun（零感知）", () => {
    expect(inferVoiceProvider({ iseMain: true, ttsOwn: false, asrOwn: false })).toBe("xfyun");
    expect(inferVoiceProvider({ iseMain: false, ttsOwn: true, asrOwn: false })).toBe("xfyun");
    expect(inferVoiceProvider({ iseMain: false, ttsOwn: false, asrOwn: true })).toBe("xfyun");
  });

  it("高级覆盖用户可以只配单独凭据不配主凭据（ASR-only 也算讯飞用户）", () => {
    expect(inferVoiceProvider({ iseMain: false, ttsOwn: true, asrOwn: true })).toBe("xfyun");
  });

  it("一个凭据都没有 → 默认 gateway", () => {
    expect(inferVoiceProvider({ iseMain: false, ttsOwn: false, asrOwn: false })).toBe("gateway");
  });
});

describe("resolveInitialVoiceProvider（已存值优先）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("已存 gateway / xfyun 时直接采用，不探测凭据", async () => {
    for (const stored of ["gateway", "xfyun"] as VoiceProvider[]) {
      expect(await resolveInitialVoiceProvider(stored)).toBe(stored);
    }
    expect(xfyunCredentialPresence).not.toHaveBeenCalled();
  });

  it("未存过：任一凭据存在 → xfyun；全空 → gateway", async () => {
    presence({ asrOwn: true });
    expect(await resolveInitialVoiceProvider(undefined)).toBe("xfyun");
    presence({});
    expect(await resolveInitialVoiceProvider(undefined)).toBe("gateway");
  });

  it("凭据探测失败（DPAPI 不可用）按未配置处理，落 gateway", async () => {
    vi.mocked(xfyunCredentialPresence).mockRejectedValue(new Error("DPAPI unavailable"));
    expect(await resolveInitialVoiceProvider(undefined)).toBe("gateway");
  });
});

describe("persistVoicePrefsField / saveVoicePrefs（即时保存，不经保存条）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(authServerBaseUrl).mockResolvedValue(null);
    vi.mocked(secretGet).mockResolvedValue("");
    vi.mocked(secretSet).mockResolvedValue(undefined);
  });

  it("只合并语音偏好字段，其余已保存字段原样保留", () => {
    const previous = { endpoint: "https://saved.example.com/v1", hotkey: "Ctrl+Shift+Q" };
    let written = "";
    persistVoicePrefsField(
      { voiceProvider: "gateway" },
      () => JSON.stringify(previous),
      (raw) => {
        written = raw;
      },
    );
    expect(JSON.parse(written)).toEqual({ ...previous, voiceProvider: "gateway" });
  });

  it("storage 为空时落默认值 + 补丁（不含 apiKey 明文）", () => {
    let written = "";
    persistVoicePrefsField(
      { voiceProvider: "xfyun", voiceGatewayVoice: "mock-male" },
      () => null,
      (raw) => {
        written = raw;
      },
    );
    const parsed = JSON.parse(written);
    expect(parsed.voiceProvider).toBe("xfyun");
    expect(parsed.voiceGatewayVoice).toBe("mock-male");
    expect(parsed.endpoint).toBe(DEFAULT_SETTINGS.endpoint);
    expect(parsed).not.toHaveProperty("apiKey");
  });

  it("已存设置里的旧版明文 apiKey 不被带出", () => {
    let written = "";
    persistVoicePrefsField(
      { voiceGatewayIseEnabled: false },
      () => JSON.stringify({ endpoint: "https://e.com", apiKey: "plaintext" }),
      (raw) => {
        written = raw;
      },
    );
    expect(JSON.parse(written)).toEqual({
      endpoint: "https://e.com",
      voiceGatewayIseEnabled: false,
    });
  });

  it("已保存设置格式无效时抛错且不写盘", () => {
    const writeRaw = vi.fn();
    expect(() => persistVoicePrefsField({ voiceProvider: "gateway" }, () => "not-json", writeRaw)).toThrow();
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it("保存即时性：saveVoicePrefs 立即写 localStorage，随后 loadSettingsFullAsync 读回", async () => {
    saveVoicePrefs({ voiceProvider: "gateway", voiceGatewayVoice: "mock-male" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      voiceProvider: "gateway",
      voiceGatewayVoice: "mock-male",
    });
    // 不经保存条的第二次写：只更新补丁字段，先前即时值不丢
    saveVoicePrefs({ voiceGatewayIseEnabled: false });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      voiceProvider: "gateway",
      voiceGatewayIseEnabled: false,
    });

    const { settings } = await loadSettingsFullAsync();
    expect(settings.voiceProvider).toBe("gateway");
    expect(settings.voiceGatewayVoice).toBe("mock-male");
    expect(settings.voiceGatewayIseEnabled).toBe(false);
  });

  it("「保存设置」整存（saveSettingsFullAsync）不吞掉已即时保存的语音偏好", async () => {
    saveVoicePrefs({ voiceProvider: "xfyun", voiceGatewayVoice: "mock-male" });
    const merged = makeSettings({ voiceProvider: "xfyun", voiceGatewayVoice: "mock-male" });
    await saveSettingsFullAsync(merged, {});
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.voiceProvider).toBe("xfyun");
    expect(raw.voiceGatewayVoice).toBe("mock-male");
    expect(await loadSettingsFullAsync().then((r) => r.settings.voiceProvider)).toBe("xfyun");
  });
});

describe("stripVoicePrefs（保存条 dirty 比较剔除即时保存字段，§三.2）", () => {
  it("仅语音偏好不同的两份设置剔除后相等（不点亮保存条）", () => {
    const a = makeSettings();
    const b = makeSettings({ voiceProvider: "xfyun", voiceGatewayVoice: "v", voiceGatewayIseEnabled: false });
    expect(JSON.stringify(stripVoicePrefs(a))).toBe(JSON.stringify(stripVoicePrefs(b)));
  });

  it("其余字段不同时剔除后仍不相等（dirty 语义不变）", () => {
    const a = makeSettings();
    const b = makeSettings({ model: "other-model" });
    expect(JSON.stringify(stripVoicePrefs(a))).not.toBe(JSON.stringify(stripVoicePrefs(b)));
  });

  it("剔除结果不含语音偏好键", () => {
    const stripped = stripVoicePrefs(
      makeSettings({ voiceProvider: "gateway", voiceGatewayVoice: "v", voiceGatewayIseEnabled: true }),
    );
    expect(stripped).not.toHaveProperty("voiceProvider");
    expect(stripped).not.toHaveProperty("voiceGatewayVoice");
    expect(stripped).not.toHaveProperty("voiceGatewayIseEnabled");
  });
});
