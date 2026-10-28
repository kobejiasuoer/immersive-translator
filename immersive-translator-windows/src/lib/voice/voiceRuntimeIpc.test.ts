// 接线冒烟（评审修复项：生产环境网关 REST 通道接线）：main.tsx 启动时安装的
// 生产传输必须把 voiceRequest 逐参转到 Rust `voice_http_request` 命令并原样带回
// 应答；未接线（默认 runtime）必须抛编程错误——防「命令/接线被删后语音静默瘫痪」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { voiceRequest } from "./voiceHttp";
import { getVoiceRuntime, resetVoiceRuntime } from "./voiceRuntime";
import { installVoiceHttpTransport } from "./voiceRuntimeIpc";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  resetVoiceRuntime();
});

afterEach(() => {
  // 不把生产实现漏进同文件后续用例（vitest 按文件隔离模块注册表，双保险）。
  resetVoiceRuntime();
});

describe("语音网关生产接线（main.tsx 启动调用）", () => {
  it("未接线：runtime.http 为 null，voiceRequest 抛编程错误、不发 IPC", async () => {
    expect(getVoiceRuntime().http).toBeNull();
    await expect(voiceRequest("POST", "/v1/voice/ticket")).rejects.toThrow(
      "语音网关 HTTP 通道未接线",
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("接线后：voiceRequest → invoke(voice_http_request) 逐参透传，应答（含 x-quota-* 头）原样带回", async () => {
    installVoiceHttpTransport();
    expect(getVoiceRuntime().http).not.toBeNull();
    // 402 是协议数据不是错误：信封与配额头必须原样可达前端 errorFromHttpResponse。
    const answer = {
      status: 402,
      body: '{"error":{"code":"quota_exceeded","details":{"resource":"tts_chars"}}}',
      retryAfterSeconds: null,
      headers: { "x-quota-tts_chars-remaining": "0" },
    };
    mockedInvoke.mockResolvedValueOnce(answer);
    const res = await voiceRequest("POST", "/v1/voice/asr", '{"lang":"en_us"}');
    expect(res).toEqual(answer);
    expect(mockedInvoke).toHaveBeenCalledWith("voice_http_request", {
      method: "POST",
      path: "/v1/voice/asr",
      bodyJson: '{"lang":"en_us"}',
    });
  });

  it("无 body 时 bodyJson 落 null（Rust Option<String>）", async () => {
    installVoiceHttpTransport();
    mockedInvoke.mockResolvedValueOnce({ status: 200, body: "{}", retryAfterSeconds: null, headers: {} });
    await voiceRequest("POST", "/v1/voice/ticket");
    expect(mockedInvoke).toHaveBeenCalledWith("voice_http_request", {
      method: "POST",
      path: "/v1/voice/ticket",
      bodyJson: null,
    });
  });
});
