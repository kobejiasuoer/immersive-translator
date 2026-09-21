import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeXfyunTts } from "../core/xfyunTts";
import { createSpeechDispatcher, createXfyunEngine, type XfyunEngineConfig } from "./speechEngine";

vi.mock("../lib/tauriBridge", () => ({}));
vi.mock("../core/xfyunTts", () => ({
  DEFAULT_TTS_VCN: "xiaoyan",
  DEFAULT_TTS_VCN_EN: "catherine",
  synthesizeXfyunTts: vi.fn(),
}));

class FakeAudio {
  onended: (() => void) | null = null;
  preservesPitch = false;
  playbackRate = 1;
  src = "";
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  removeAttribute = vi.fn();
}

const cfg: XfyunEngineConfig = {
  vcnZh: "xiaoyan", vcnEn: "catherine", rate: 1,
  creds: { appId: "test", apiKey: "test", apiSecret: "test" },
};

describe("云朗读失败契约", () => {
  let audio: FakeAudio;
  beforeEach(() => {
    audio = new FakeAudio();
    vi.stubGlobal("Audio", vi.fn(function () { return audio; }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(synthesizeXfyunTts).mockReset().mockResolvedValue(new Blob(["mp3"]));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "连接断开（1006）",
    "今日免费调用次数已用完（每日 500 次）（11201）",
    "鉴权失败：检查讯飞合成的 API Key / API Secret",
    "合成返回空音频",
  ])("%s：拒绝原始错误，不登记 gen、不触发 ended", async (message) => {
    const error = new Error(message);
    vi.mocked(synthesizeXfyunTts).mockRejectedValueOnce(error);
    const cloud = createXfyunEngine(() => cfg);
    const engine = createSpeechDispatcher(() => cloud);
    const ended = vi.fn();
    const registerGen = vi.fn();
    engine.onEnded(ended);

    await expect(engine.speak("hello", false, { track: "sentence" }).then(registerGen)).rejects.toBe(error);
    expect(registerGen).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("缺少凭据时拒绝，不伪造完成事件", async () => {
    const engine = createXfyunEngine(() => ({ ...cfg, creds: null }));
    const ended = vi.fn();
    engine.onEnded(ended);
    await expect(engine.speak("hello", false, {})).rejects.toThrow("未配置讯飞合成凭据");
    expect(synthesizeXfyunTts).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("播放被拒时拒绝并释放资源，stop 不补发虚假的 ended", async () => {
    const error = new DOMException("播放被系统拒绝", "NotAllowedError");
    audio.play.mockRejectedValueOnce(error);
    const engine = createXfyunEngine(() => cfg);
    const ended = vi.fn();
    engine.onEnded(ended);
    await expect(engine.speak("hello", false, {})).rejects.toBe(error);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(audio.onended).toBeNull();
    await engine.stopTrack("sentence");
    expect(ended).not.toHaveBeenCalled();
  });

  it("旧播放请求延迟被拒，不清理已经启动的新音频", async () => {
    let rejectOld!: (error: Error) => void;
    audio.play.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
    const engine = createXfyunEngine(() => cfg);
    const old = engine.speak("old", false, {});
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    const newAudio = new FakeAudio();
    vi.stubGlobal("Audio", vi.fn(function () { return newAudio; }));
    const ended = vi.fn();
    engine.onEnded(ended);
    const gen = await engine.speak("new", false, {});
    const error = new Error("old play rejected");
    const rejected = expect(old).rejects.toBe(error);
    rejectOld(error);
    await rejected;
    expect(newAudio.pause).not.toHaveBeenCalled();
    newAudio.onended?.();
    expect(ended).toHaveBeenCalledExactlyOnceWith({ gen, track: "sentence" });
  });

  it("失败后可重新播放，成功时仅自然结束才发送匹配的 gen", async () => {
    vi.mocked(synthesizeXfyunTts).mockRejectedValueOnce(new Error("offline"));
    const engine = createXfyunEngine(() => cfg);
    const ended = vi.fn();
    engine.onEnded(ended);
    await expect(engine.speak("hello", false, {})).rejects.toThrow("offline");
    const gen = await engine.speak("hello", false, { rate: 1.5 });
    expect(ended).not.toHaveBeenCalled();
    expect(audio.playbackRate).toBe(1.5);
    audio.onended?.();
    expect(ended).toHaveBeenCalledExactlyOnceWith({ gen, track: "sentence" });
  });

  it("合成期间 stopTrack：迟到的合成结果不落地（停止后无幽灵播放）", async () => {
    let resolveSynth!: (b: Blob) => void;
    vi.mocked(synthesizeXfyunTts).mockImplementationOnce(
      () => new Promise((r) => { resolveSynth = r; }),
    );
    const engine = createXfyunEngine(() => cfg);
    const ended = vi.fn();
    engine.onEnded(ended);
    const pending = engine.speak("hello", false, {});

    await engine.stopTrack("sentence");
    resolveSynth(new Blob(["mp3"]));
    await expect(pending).resolves.toBeTypeOf("number"); // 不拒绝、不报错

    expect(audio.play).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("乱序完成：慢的旧合成不顶掉正在播的新句", async () => {
    let resolveOld!: (b: Blob) => void;
    vi.mocked(synthesizeXfyunTts)
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(new Blob(["new"]));
    const engine = createXfyunEngine(() => cfg);
    const ended = vi.fn();
    engine.onEnded(ended);
    const old = engine.speak("old", false, {});
    const gen = await engine.speak("new", false, {});
    expect(audio.play).toHaveBeenCalledOnce();

    resolveOld(new Blob(["old"]));
    await expect(old).resolves.toBeTypeOf("number");
    expect(audio.play).toHaveBeenCalledOnce(); // 旧音频被丢弃，不覆盖新句

    audio.onended?.();
    expect(ended).toHaveBeenCalledExactlyOnceWith({ gen, track: "sentence" });
  });
});
