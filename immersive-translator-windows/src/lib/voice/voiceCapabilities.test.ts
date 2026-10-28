import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { getVoiceCapabilities, parseVoiceCapabilities } from "./voiceCapabilities";

const invokeMock = invoke as unknown as Mock;

beforeEach(() => {
  invokeMock.mockReset();
});

describe("parseVoiceCapabilities(me/config voice 段容错解析)", () => {
  it("完整 voice 段:ttsVoices/asrLanguages/iseEnabled 原样透传", () => {
    const caps = parseVoiceCapabilities({
      gateway: { llm: "/v1/gw/chat/completions" },
      models: ["gpt-x"],
      voice: {
        ttsVoices: [
          { id: "xiaoyan", label: "晓燕" },
          { id: "alvin", label: "艾尔文" },
        ],
        asrLanguages: ["en_us", "zh_cn"],
        iseEnabled: true,
      },
      features: { sync: true },
    });
    expect(caps.available).toBe(true);
    expect(caps.ttsVoices).toEqual([
      { id: "xiaoyan", label: "晓燕" },
      { id: "alvin", label: "艾尔文" },
    ]);
    expect(caps.asrLanguages).toEqual(["en_us", "zh_cn"]);
    expect(caps.iseEnabled).toBe(true);
    expect(caps.quota).toBeNull(); // 服务端配额字段未上线 → 402 事件式兜底
  });

  it("缺 voice 段(官方云未开通/旧服务端)→ available:false 空能力", () => {
    expect(parseVoiceCapabilities({ models: [] }).available).toBe(false);
    expect(parseVoiceCapabilities(null).available).toBe(false);
    expect(parseVoiceCapabilities("junk").ttsVoices).toEqual([]);
  });

  it("配额字段上线:voice.quota 按 tts/asr/ise 归一(tts_chars 等资源别名兼容)", () => {
    const caps = parseVoiceCapabilities({
      voice: {
        ttsVoices: [],
        asrLanguages: ["en_us"],
        iseEnabled: false,
        quota: {
          tts_chars: { remaining: 100, allowance: 500, resetsAt: "2026-11-01T00:00:00.000Z" },
          asr_seconds: { remaining: 0, resetsAt: "2026-11-01T00:00:00.000Z" },
          ise_calls: { remaining: 3 },
        },
      },
    });
    expect(caps.quota).toEqual({
      tts: { remaining: 100, allowance: 500, resetsAt: "2026-11-01T00:00:00.000Z" },
      asr: { remaining: 0, allowance: null, resetsAt: "2026-11-01T00:00:00.000Z" },
      ise: { remaining: 3, allowance: null, resetsAt: null },
    });
  });

  it("形状异常的条目逐条过滤(label 缺失回落 id;非串语种丢弃)", () => {
    const caps = parseVoiceCapabilities({
      voice: {
        ttsVoices: [{ id: "v1" }, { label: "no-id" }, 42],
        asrLanguages: ["en_us", 7, ""],
        iseEnabled: "yes",
      },
    });
    expect(caps.ttsVoices).toEqual([{ id: "v1", label: "v1" }]);
    expect(caps.asrLanguages).toEqual(["en_us"]);
    expect(caps.iseEnabled).toBe(false);
  });
});

describe("getVoiceCapabilities(复用 authFetchServerConfig 的 Rust 鉴权通道)", () => {
  it("invoke auth_fetch_server_config 一次并解析 voice 段", async () => {
    invokeMock.mockResolvedValue({
      voice: { ttsVoices: [{ id: "alvin", label: "艾尔文" }], asrLanguages: ["en_us"], iseEnabled: true },
    });
    const caps = await getVoiceCapabilities();
    expect(invokeMock).toHaveBeenCalledWith("auth_fetch_server_config");
    expect(caps.available).toBe(true);
    expect(caps.ttsVoices[0]).toEqual({ id: "alvin", label: "艾尔文" });
  });

  it("鉴权失败(AuthError)原样抛出,文案由 authErrorText 家族处置", async () => {
    invokeMock.mockRejectedValue({ code: "token_invalid", message: "登录已失效", httpStatus: 401, retryAfterSeconds: null });
    await expect(getVoiceCapabilities()).rejects.toMatchObject({ code: "token_invalid" });
  });
});
