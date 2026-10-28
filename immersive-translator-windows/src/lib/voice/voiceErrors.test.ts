import { describe, expect, it } from "vitest";
import {
  VoiceError,
  quotaDetailsOf,
  quotaFeatureLabel,
  voiceErrorMessage,
} from "./voiceErrors";

/** 构造 VoiceError(服务端信封归一后的形状)。 */
function voiceError(code: string, details?: Record<string, unknown>): VoiceError {
  return new VoiceError(code, { details });
}

describe("voiceErrorMessage(契约 §二 错误码→文案映射表)", () => {
  it("token_expired → silent(Rust 单飞刷新后重放,用户不可见)", () => {
    const r = voiceErrorMessage("token_expired");
    expect(r).toMatchObject({ text: "", kind: "silent", retryable: true });
  });

  it("token_invalid / unauthorized → 登录已失效 + 跳登录(unauthorized 归一)", () => {
    const invalid = voiceErrorMessage("token_invalid");
    expect(invalid).toMatchObject({
      text: "登录已失效，请重新登录",
      kind: "message",
      action: "relogin",
      retryable: false,
    });
    expect(voiceErrorMessage("unauthorized")).toEqual(invalid);
  });

  it("token_reused → 与既有 authErrorText 同文案(auth.rs SessionKicked 对齐),不重试", () => {
    const r = voiceErrorMessage("token_reused");
    expect(r.text).toBe("检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录");
    expect(r).toMatchObject({ kind: "message", action: "relogin", retryable: false });
  });

  it("banned → 账号已被封禁 + 前往申诉,不重试", () => {
    const r = voiceErrorMessage("banned");
    expect(r).toMatchObject({ text: "账号已被封禁", kind: "message", action: "appeal", retryable: false });
  });

  it("voice_ticket_invalid → 重试中文案;final 后切「请稍后再试」", () => {
    expect(voiceErrorMessage("voice_ticket_invalid").text).toBe("连接不稳定，正在重试…");
    const final = voiceErrorMessage("voice_ticket_invalid", { final: true });
    expect(final.text).toBe("请稍后再试");
    expect(final.retryable).toBe(false);
  });

  it("quota_exceeded → 按 details.resource 插值功能名 + 兑换动作", () => {
    expect(voiceErrorMessage(voiceError("quota_exceeded", { resource: "tts_chars" })).text).toBe(
      "本月朗读额度已用完",
    );
    expect(voiceErrorMessage(voiceError("quota_exceeded", { resource: "asr_seconds" })).text).toBe(
      "本月口语识别额度已用完",
    );
    expect(voiceErrorMessage(voiceError("quota_exceeded", { resource: "ise_calls" })).text).toBe(
      "本月跟读打分额度已用完",
    );
    const r = voiceErrorMessage(voiceError("quota_exceeded", { resource: "llm_tokens" }));
    expect(r.text).toBe("本月对话额度已用完");
    // 无 resource(旧服务端):兜底「语音」。
    expect(voiceErrorMessage("quota_exceeded").text).toBe("本月语音额度已用完");
    expect(r).toMatchObject({ action: "redeem", retryable: false });
  });

  it("rate_limited → 请求太频繁文案,可重试", () => {
    const r = voiceErrorMessage("rate_limited");
    expect(r).toMatchObject({ text: "请求太频繁，请稍后再试", kind: "message", action: "retry", retryable: true });
  });

  it("ise_disabled → silent(UI 据此隐藏评测入口)", () => {
    const r = voiceErrorMessage("ise_disabled");
    expect(r).toMatchObject({ text: "", kind: "silent", action: null, retryable: false });
  });

  it("voice_not_configured → 语音功能暂未开通", () => {
    expect(voiceErrorMessage("voice_not_configured").text).toBe("语音功能暂未开通");
  });

  it("voice_text_too_long → internal(客户端拆句重发,不提示)", () => {
    const r = voiceErrorMessage("voice_text_too_long");
    expect(r).toMatchObject({ text: "", kind: "internal", retryable: true });
  });

  it("voice_invalid_state / voice_session_too_long → 单次最长 60 秒文案(修状态机)", () => {
    for (const code of ["voice_invalid_state", "voice_session_too_long"]) {
      const r = voiceErrorMessage(code);
      expect(r.text).toBe("单次最长 60 秒，请重新开始");
      expect(r.retryable).toBe(true);
    }
  });

  it("upstream_error / upstream_timeout → 正在重试;final 后切「请稍后再试」", () => {
    for (const code of ["upstream_error", "upstream_timeout"]) {
      expect(voiceErrorMessage(code).text).toBe("服务暂时不可用，正在重试");
      expect(voiceErrorMessage(code, { final: true }).text).toBe("请稍后再试");
    }
  });

  it("WSS 意外断开(本地伪码 voice_disconnected)→ 网络中断重连;final 终局文案", () => {
    expect(voiceErrorMessage("voice_disconnected").text).toBe("网络中断，正在重连…");
    expect(voiceErrorMessage("voice_disconnected", { final: true }).text).toBe(
      "网络连接不稳定，请稍后再试",
    );
  });

  it("network_error(REST 本地伪码)与未知 code 兜底", () => {
    expect(voiceErrorMessage("network_error").text).toBe("网络连接失败，请检查网络后重试");
    const unknown = voiceErrorMessage("brand_new_code");
    expect(unknown.text).toBe("服务暂时不可用，请稍后再试");
    expect(voiceErrorMessage("unknown").text).toBe(unknown.text);
  });

  it("文案不泄漏服务端 message / HTTP 状态码", () => {
    const err = new VoiceError("upstream_error", { message: "upstream provider xf-yun 502 bad gateway" });
    const r = voiceErrorMessage(err);
    expect(r.text).not.toContain("xf-yun");
    expect(r.text).not.toContain("502");
  });

  it("非对象/空串输入安全兜底", () => {
    expect(voiceErrorMessage("").text).toBe("服务暂时不可用，请稍后再试");
    // @ts-expect-error 防御性输入(运行时可能收到任何东西)
    expect(voiceErrorMessage(null).text).toBe("服务暂时不可用，请稍后再试");
  });
});

describe("quotaDetailsOf / quotaFeatureLabel(402 details 或 WSS details)", () => {
  it("读 resource/remaining/allowance/resetsAt,非法字段归 null", () => {
    const d = quotaDetailsOf(
      voiceError("quota_exceeded", {
        resource: "tts_chars",
        remaining: 120,
        allowance: 500,
        resetsAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect(d).toEqual({
      resource: "tts_chars",
      remaining: 120,
      allowance: 500,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(quotaDetailsOf("quota_exceeded").remaining).toBeNull();
    expect(quotaDetailsOf(voiceError("quota_exceeded", { remaining: "3" })).remaining).toBeNull();
  });

  it("quotaFeatureLabel 覆盖服务端 QUOTA_RESOURCES 子集 + 未知兜底", () => {
    expect(quotaFeatureLabel("tts_chars")).toBe("朗读");
    expect(quotaFeatureLabel("asr_seconds")).toBe("口语识别");
    expect(quotaFeatureLabel("ise_calls")).toBe("跟读打分");
    expect(quotaFeatureLabel(null)).toBe("语音");
    expect(quotaFeatureLabel("mystery")).toBe("语音");
  });
});
