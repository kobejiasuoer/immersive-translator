import { describe, expect, it } from "vitest";
import { authErrorText, authNoticeText, retryAfterSecondsOf } from "./authErrorText";
import type { AuthError } from "./tauriBridge";

/** 构造契约形状的 AuthError（§7：Rust serde camelCase 透传）。 */
function authError(partial: Partial<AuthError> & Pick<AuthError, "code">): AuthError {
  return {
    message: "server message（仅日志，不展示）",
    httpStatus: null,
    retryAfterSeconds: null,
    ...partial,
  };
}

describe("authErrorText（§3 错误码映射表）", () => {
  it("otp_invalid → inline，文案逐字", () => {
    const r = authErrorText(authError({ code: "otp_invalid", httpStatus: 400 }));
    expect(r).toEqual({ text: "验证码错误或已过期，请重新获取", kind: "inline", code: "otp_invalid" });
  });

  it("invalid_credentials → inline", () => {
    const r = authErrorText(authError({ code: "invalid_credentials", httpStatus: 401 }));
    expect(r.text).toBe("邮箱或密码不正确；若从未设置密码，请改用验证码登录");
    expect(r.kind).toBe("inline");
  });

  it("email_taken → inline（MVP 预留映射）", () => {
    const r = authErrorText(authError({ code: "email_taken", httpStatus: 409 }));
    expect(r.text).toBe("该邮箱已注册，请直接登录");
    expect(r.kind).toBe("inline");
  });

  it("banned → inline（阻断）", () => {
    const r = authErrorText(authError({ code: "banned", httpStatus: 403 }));
    expect(r.text).toBe("该账号已被封禁，如有疑问请联系支持");
    expect(r.kind).toBe("inline");
  });

  it("token_expired → silent（用户不可见，Rust 自动续期）", () => {
    const r = authErrorText(authError({ code: "token_expired", httpStatus: 401 }));
    expect(r.text).toBe("登录已过期，正在自动续期");
    expect(r.kind).toBe("silent");
  });

  it("token_invalid / unauthorized → statusbar 且文案相同", () => {
    const invalid = authErrorText(authError({ code: "token_invalid", httpStatus: 401 }));
    const unauthorized = authErrorText(authError({ code: "unauthorized", httpStatus: 401 }));
    expect(invalid.text).toBe("登录已失效，请重新登录");
    expect(invalid.kind).toBe("statusbar");
    expect(unauthorized).toEqual(invalid);
  });

  it("token_reused → statusbar 全设备下线文案", () => {
    const r = authErrorText(authError({ code: "token_reused", httpStatus: 401 }));
    expect(r.text).toBe("检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录");
    expect(r.kind).toBe("statusbar");
  });

  it("rate_limited 用 retryAfterSeconds 插值", () => {
    const r = authErrorText(
      authError({ code: "rate_limited", httpStatus: 429, retryAfterSeconds: 37 }),
    );
    expect(r.text).toBe("操作过于频繁，请 37 秒后再试");
    expect(r.kind).toBe("inline");
  });

  it("rate_limited 无秒数时退化为通用文案", () => {
    const r = authErrorText(authError({ code: "rate_limited", httpStatus: 429 }));
    expect(r.text).toBe("操作过于频繁，请稍后再试");
  });

  it("validation_error → inline", () => {
    const r = authErrorText(authError({ code: "validation_error", httpStatus: 400 }));
    expect(r.text).toBe("请求参数异常，请更新应用后重试；若持续出现请反馈");
    expect(r.kind).toBe("inline");
  });

  it("service_unavailable → inline", () => {
    const r = authErrorText(authError({ code: "service_unavailable", httpStatus: 503 }));
    expect(r.text).toBe("邮件服务暂时不可用，请稍后再试");
    expect(r.kind).toBe("inline");
  });

  it("本地伪码四条：network_error / storage_error / parse_error / unknown", () => {
    expect(authErrorText(authError({ code: "network_error" })).text).toBe(
      "网络连接失败，请检查网络后重试",
    );
    expect(authErrorText(authError({ code: "storage_error" })).text).toBe(
      "本地安全存储读写失败，请重试或反馈",
    );
    expect(authErrorText(authError({ code: "parse_error" })).text).toBe("服务响应异常，请稍后再试");
    expect(authErrorText(authError({ code: "unknown" })).text).toBe("服务响应异常，请稍后再试");
  });

  it("未知 code 安全落到 unknown 文案，服务端 message 永不进入返回值", () => {
    const r = authErrorText(
      authError({ code: "brand_new_code", message: "内部信息不应外泄", httpStatus: 418 }),
    );
    expect(r).toEqual({ text: "服务响应异常，请稍后再试", kind: "inline", code: "unknown" });
    expect(r.text).not.toContain("内部信息");
  });

  it("非对象输入（字符串按 code 解析、其余兜底）", () => {
    expect(authErrorText("banned").code).toBe("banned");
    expect(authErrorText(42).code).toBe("unknown");
    expect(authErrorText(null).code).toBe("unknown");
  });
});

describe("retryAfterSecondsOf", () => {
  it("读取 AuthError.retryAfterSeconds（>0 的有限数）", () => {
    expect(retryAfterSecondsOf(authError({ code: "rate_limited", retryAfterSeconds: 27 }))).toBe(27);
    expect(retryAfterSecondsOf(authError({ code: "rate_limited", retryAfterSeconds: 2.9 }))).toBe(2);
  });

  it("缺失 / 非法 / 非正数返回 null", () => {
    expect(retryAfterSecondsOf(authError({ code: "rate_limited" }))).toBeNull();
    expect(retryAfterSecondsOf(authError({ code: "rate_limited", retryAfterSeconds: 0 }))).toBeNull();
    expect(retryAfterSecondsOf(authError({ code: "rate_limited", retryAfterSeconds: -5 }))).toBeNull();
    // 非法类型（透传异常时的防御分支）：字符串秒数不认
    expect(
      retryAfterSecondsOf(
        authError({ code: "rate_limited", retryAfterSeconds: "37" as unknown as number }),
      ),
    ).toBeNull();
    expect(retryAfterSecondsOf(undefined)).toBeNull();
  });
});

describe("authNoticeText（D8 失效状态条文案）", () => {
  it("session_expired → 登录已失效", () => {
    expect(authNoticeText("session_expired")).toBe("登录已失效，请重新登录");
  });

  it("session_kicked → 凭据异常复用 / 全设备下线", () => {
    expect(authNoticeText("session_kicked")).toBe(
      "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录",
    );
  });

  it("null → null（无状态条）", () => {
    expect(authNoticeText(null)).toBeNull();
  });
});
