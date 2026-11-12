// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { GatewayVoiceSection, type GatewayVoiceSectionProps } from "./GatewayVoiceSection";
import { asrLanguagesFor, synthesize, transcribeBatch } from "../lib/voice";
import { reduceVoiceGatewayView } from "../lib/voice/gatewayViewState";
import { actAsync, createHarness, findButton, type Harness } from "./authTestHarness";

vi.mock("../lib/voice", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/voice")>();
  return { ...original, synthesize: vi.fn(), transcribeBatch: vi.fn(), evaluatePronunciation: vi.fn() };
});

const caps = {
  available: true,
  ttsVoices: [{ id: "first", label: "默认音色" }, { id: "selected", label: "选中音色" }],
  asrLanguages: ["en_us"],
  iseEnabled: true,
  quota: null,
};
const OriginalURL = URL;
let harness: Harness | null;
let audio: {
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
};
const createObjectURL = vi.fn(() => "blob:voice-test");
const revokeObjectURL = vi.fn();

function props(overrides: Partial<GatewayVoiceSectionProps> = {}): GatewayVoiceSectionProps {
  return {
    email: "test@example.com", loggedIn: true, openingLogin: false,
    caps, view: reduceVoiceGatewayView({ loading: false, errorCode: null, caps, quotaEvents: [] }),
    selectedVoice: "selected", iseEnabled: true,
    onLogin: vi.fn(), onManageAccount: vi.fn(), onRetryCaps: vi.fn(), onOpenRedeem: vi.fn(),
    onSelectVoice: vi.fn(), onToggleIse: vi.fn(), onQuotaEvent: vi.fn(), onUseXfyun: vi.fn(),
    ...overrides,
  };
}
async function mount(overrides: Partial<GatewayVoiceSectionProps> = {}): Promise<Harness> {
  harness = createHarness();
  harness.render(<GatewayVoiceSection {...props(overrides)} />);
  await actAsync(() => undefined);
  return harness;
}
beforeEach(() => {
  vi.clearAllMocks();
  harness = null;
  audio = {
    onended: null, onerror: null, play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(), removeAttribute: vi.fn(),
  };
  vi.stubGlobal("Audio", vi.fn(function () { return audio; }));
  vi.stubGlobal("URL", class extends OriginalURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});
function successfulSynthesis() {
  vi.mocked(synthesize).mockImplementation((_text, _voice, _volume, onChunk, onEnd) => {
    onChunk(new Uint8Array([1, 2, 3]).buffer);
    onEnd();
  });
}

describe("云语音设置真实测试和状态边界", () => {
  it("试听使用选中音色，播放结束后才显示测试通过", async () => {
    successfulSynthesis();
    const h = await mount();
    await actAsync(() => findButton(h.container, "试听").click());
    expect(vi.mocked(synthesize).mock.calls[0]?.[1]).toBe("selected");
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).not.toContain("测试通过");
    await actAsync(() => audio.onended?.());
    expect(h.container.textContent).toContain("测试通过");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("服务只返回结束帧而没有音频，不能当作试听成功", async () => {
    vi.mocked(synthesize).mockImplementation((_text, _voice, _volume, _onChunk, onEnd) => onEnd());
    const h = await mount();
    await actAsync(() => findButton(h.container, "试听").click());
    expect(h.container.textContent).toContain("服务未返回音频");
    expect(h.container.textContent).not.toContain("测试通过");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("合成成功但播放失败，显示失败并释放音频资源", async () => {
    successfulSynthesis();
    audio.play.mockRejectedValueOnce(new Error("output unavailable"));
    const h = await mount();
    await actAsync(() => findButton(h.container, "试听").click());
    expect(h.container.textContent).toContain("试听未完成");
    expect(h.container.textContent).toContain("测试失败");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("试听中退出设置会停止播放并释放音频", async () => {
    successfulSynthesis();
    const h = await mount();
    await actAsync(() => findButton(h.container, "试听").click());
    h.unmount();
    harness = null;
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("切换账号后丢弃尚未完成的旧合成，不播放旧账号测试音频", async () => {
    let onChunk: ((chunk: ArrayBuffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    vi.mocked(synthesize).mockImplementation((_text, _voice, _volume, chunk, end) => {
      onChunk = chunk;
      onEnd = end;
    });
    const h = await mount();
    await actAsync(() => findButton(h.container, "试听").click());
    h.render(<GatewayVoiceSection {...props({ email: "another@example.com" })} />);
    await actAsync(() => {
      onChunk?.(new Uint8Array([1, 2, 3]).buffer);
      onEnd?.();
    });
    expect(audio.play).not.toHaveBeenCalled();
    expect(h.container.textContent).not.toContain("测试通过");
  });

  it("失效登录、网络错误和未开放分别展示，不能都当作服务未开放", async () => {
    const h = await mount({ loggedIn: false });
    expect(h.container.querySelectorAll(".voice-feature-status")[0]?.textContent).toBe("待登录");
    const errorProps = props({
      view: reduceVoiceGatewayView({ loading: false, errorCode: "network_error", caps: null, quotaEvents: [] }),
    });
    h.render(<GatewayVoiceSection {...errorProps} />);
    expect(h.container.textContent).toContain("暂时无法检查云语音");
    expect(h.container.querySelectorAll(".voice-feature-status")[0]?.textContent).toBe("待检查");
    h.render(<GatewayVoiceSection {...props({
      view: reduceVoiceGatewayView({ loading: false, errorCode: "token_invalid", caps: null, quotaEvents: [] }),
    })} />);
    expect(findButton(h.container, "重新登录").disabled).toBe(false);
    expect(h.container.querySelectorAll(".voice-feature-status")[0]?.textContent).toBe("待重新登录");
  });

  it("只有中文批量识别或评分被用户关闭时，不触发英文识别和评分测试", async () => {
    const chineseOnly = { ...caps, asrBatchLanguages: ["zh_cn"], asrStreamingLanguages: ["en_us", "zh_cn"] };
    expect(asrLanguagesFor(chineseOnly)).toEqual(["zh_cn"]);
    const h = await mount({
      caps: chineseOnly,
      view: reduceVoiceGatewayView({ loading: false, errorCode: null, caps: chineseOnly, quotaEvents: [] }),
      iseEnabled: false,
    });
    expect(findButton(h.container, "测试识别").disabled).toBe(true);
    expect(findButton(h.container, "测试评分").disabled).toBe(true);
    expect(h.container.textContent).toContain("评分已关闭");
    act(() => findButton(h.container, "测试识别").click());
    expect(transcribeBatch).not.toHaveBeenCalled();
  });

  it("跟读评分行旁有阅读室联动只读投影（文案逐字，无第二写点控件）", async () => {
    const h = await mount();
    expect(h.container.textContent).toContain(
      "跟读评测可在 设置 → 阅读与练习 中开启；两处都开启才会打分",
    );
    // 投影行不带任何开关/按钮（只读，不开第二写点）
    const note = Array.from(h.container.querySelectorAll(".voice-feature-note")).find((p) =>
      p.textContent?.includes("跟读评测可在 设置 → 阅读与练习 中开启"),
    );
    expect(note).toBeDefined();
    expect(note!.querySelector("button, input, .switch")).toBeNull();
  });

  it("评分能力未开放（ise 行隐藏）时投影一并隐藏", async () => {
    const noIse = { ...caps, iseEnabled: false };
    const h = await mount({
      caps: noIse,
      view: reduceVoiceGatewayView({ loading: false, errorCode: null, caps: noIse, quotaEvents: [] }),
      iseEnabled: false,
    });
    expect(h.container.textContent).not.toContain("两处都开启才会打分");
  });
});
