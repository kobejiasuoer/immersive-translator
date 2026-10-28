import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { voiceErrorMessage } from "./voiceErrors";
import { evaluatePronunciation, transcribeBatch } from "./voiceRest";
import { resetSharedTicketManagerForTests } from "./voiceTicket";
import { resetVoiceRuntime, setVoiceRuntime, type VoiceHttpResponse } from "./voiceRuntime";

const transport = vi.fn<(method: "GET" | "POST", path: string, bodyJson: string | undefined) => Promise<VoiceHttpResponse>>();

function reply(status: number, body: unknown, headers: Record<string, string> = {}): VoiceHttpResponse {
  return {
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
    retryAfterSeconds: null,
    headers,
  };
}

function envelope(code: string, message: string, details?: Record<string, unknown>): unknown {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

beforeEach(() => {
  transport.mockReset();
  resetVoiceRuntime();
  resetSharedTicketManagerForTests();
  setVoiceRuntime({ http: transport });
});

describe("transcribeBatch(POST /v1/voice/asr)", () => {
  it("请求体 {lang, audio};2xx → {text, durationMs}", async () => {
    transport.mockResolvedValue(reply(200, { text: "hello world", durationMs: 3210 }));
    const result = await transcribeBatch("en_us", "QUJD");
    expect(transport).toHaveBeenCalledWith("POST", "/v1/voice/asr", JSON.stringify({ lang: "en_us", audio: "QUJD" }));
    expect(result).toEqual({ text: "hello world", durationMs: 3210 });
  });

  it("402 quota_exceeded:details.resource 进文案,x-quota 头补 remaining", async () => {
    transport.mockResolvedValue(
      reply(402, envelope("quota_exceeded", "免费额度已用尽", { resource: "asr_seconds", resetsAt: "2026-11-01T00:00:00.000Z" }), {
        "x-quota-asr_seconds-remaining": "7",
      }),
    );
    const err = await transcribeBatch("en_us", "QUJD").catch((e: unknown) => e) as { code: string; details: Record<string, unknown> };
    expect(err.code).toBe("quota_exceeded");
    expect(err.details["remaining"]).toBe(7); // 响应头只有 remaining
    expect(voiceErrorMessage(err).text).toBe("本月口语识别额度已用完");
  });

  it("401 token_invalid → 文案「登录已失效,请重新登录」(Rust 刷新重放后的终态)", async () => {
    transport.mockResolvedValue(reply(401, envelope("token_invalid", "invalid token")));
    const err = await transcribeBatch("zh_cn", "QUJD").catch((e: unknown) => e) as { code: string };
    expect(voiceErrorMessage(err).text).toBe("登录已失效，请重新登录");
  });

  it("429 rate_limited:retryAfterSeconds 透传到错误对象", async () => {
    transport.mockResolvedValue({ ...reply(429, envelope("rate_limited", "slow down")), retryAfterSeconds: 9 });
    const err = await transcribeBatch("en_us", "QUJD").catch((e: unknown) => e) as { code: string; retryAfterSeconds: number | null };
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(9);
  });

  it("非 JSON 应答按 HTTP 状态兜底:5xx → upstream_error,4xx → unknown;不透传原始 body", async () => {
    transport.mockResolvedValue(reply(502, "<html>bad gateway</html>"));
    const err502 = await transcribeBatch("en_us", "QUJD").catch((e: unknown) => e) as { code: string };
    expect(err502.code).toBe("upstream_error");
    expect(voiceErrorMessage(err502).text).toBe("服务暂时不可用，正在重试");
    expect(voiceErrorMessage(err502).text).not.toContain("bad gateway");

    transport.mockResolvedValue(reply(400, "<html>bad request</html>"));
    const err400 = await transcribeBatch("en_us", "QUJD").catch((e: unknown) => e) as { code: string };
    expect(err400.code).toBe("unknown");
    expect(voiceErrorMessage(err400).text).toBe("服务暂时不可用，请稍后再试");
  });
});

describe("evaluatePronunciation(POST /v1/voice/ise)", () => {
  it("请求体 {refText, lang, audio};评分 JSON 原形状返回(5 分制)", async () => {
    transport.mockResolvedValue(
      reply(200, {
        total: 4.5,
        accuracy: 4.6,
        fluency: 4.2,
        standard: 4.4,
        integrity: 4.8,
        isRejected: false,
        exceptInfo: null,
        words: [
          {
            content: "hello",
            totalScore: 92,
            dpMessage: 0,
            sylls: [{ content: "hh", syllScore: 90, serrMsg: 0, phones: [{ content: "hh", dpMessage: -1, gwpp: 2 }] }],
          },
          { content: "hi", totalScore: 88 },
        ],
      }),
    );
    const result = await evaluatePronunciation("hello hi", "en", "QUJD");
    expect(transport).toHaveBeenCalledWith("POST", "/v1/voice/ise", JSON.stringify({ refText: "hello hi", lang: "en", audio: "QUJD" }));
    expect(result.total).toBe(4.5);
    expect(result.isRejected).toBe(false);
    expect(result.words).toHaveLength(2);
    expect(result.words[0]!.sylls[0]!.phones[0]!.content).toBe("hh");
    expect(result.words[1]!.sylls).toEqual([]);
  });

  it("403 ise_disabled → silent(隐藏评测入口),banned → 前往申诉", async () => {
    transport.mockResolvedValue(reply(403, envelope("ise_disabled", "发音评测暂未开放")));
    const err = await evaluatePronunciation("hi", "en", "QUJD").catch((e: unknown) => e) as { code: string };
    const mapped = voiceErrorMessage(err);
    expect(mapped.kind).toBe("silent");
    expect(mapped.text).toBe("");

    transport.mockResolvedValue(reply(403, envelope("banned", "账号已被封禁")));
    const banned = await evaluatePronunciation("hi", "en", "QUJD").catch((e: unknown) => e) as { code: string };
    expect(voiceErrorMessage(banned).action).toBe("appeal");
  });

  it("形状异常的 words 条目被过滤,不抛错", async () => {
    transport.mockResolvedValue(reply(200, { total: 3, words: [{ content: "ok", totalScore: 80 }, "junk", null, {}] }));
    const result = await evaluatePronunciation("hi", "en", "QUJD");
    expect(result.words).toHaveLength(1);
    expect(result.words[0]!.content).toBe("ok");
  });
});
