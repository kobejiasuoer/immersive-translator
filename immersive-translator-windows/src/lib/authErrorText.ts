/**
 * 账号登录错误码 → 用户文案的唯一映射（docs/windows-auth-design-2026-09-26.md §3）。
 *
 * 约束：
 * - 只按 `code` 字符串分支，绝不匹配服务端 message（message 仅日志兜底）；
 * - 呈现方式 kind ∈ inline（表单内红条）/ statusbar（账号 tab 顶部 warn 状态条）/
 *   silent（用户不可见，Rust 侧自动处理）；无全局 toast（设计 D8）；
 * - rate_limited 文案由 retryAfterSeconds 插值，秒数读取见 retryAfterSecondsOf。
 */

/** §3 表「呈现」列。 */
export type AuthErrorTextKind = "inline" | "statusbar" | "silent";

export interface AuthErrorTextResult {
  /** 用户可见的中文文案（§3 表逐字）。 */
  text: string;
  /** 呈现位置。 */
  kind: AuthErrorTextKind;
  /** 归一化后的 code（未知 code 归为 "unknown"）。 */
  code: string;
}

/** tauriBridge 的 AuthError 形状（宽松匹配，兼容测试与异常透传）。 */
interface AuthErrorLike {
  code?: unknown;
  message?: unknown;
  httpStatus?: unknown;
  retryAfterSeconds?: unknown;
}

/** 未知 / 解析失败等服务端或本地兜底文案。 */
const FALLBACK_TEXT = "服务响应异常，请稍后再试";

/** §3 映射表：code → 固定文案与呈现（rate_limited 单独插值）。 */
const CODE_TABLE: Record<string, { text: string; kind: AuthErrorTextKind }> = {
  otp_invalid: { text: "验证码错误或已过期，请重新获取", kind: "inline" },
  invalid_credentials: {
    text: "邮箱或密码不正确；若从未设置密码，请改用验证码登录",
    kind: "inline",
  },
  // MVP 无注册入口，映射预留（§3：email_taken 不可达）。
  email_taken: { text: "该邮箱已注册，请直接登录", kind: "inline" },
  banned: { text: "该账号已被封禁，如有疑问请联系支持", kind: "inline" },
  // silent：Rust 单飞刷新后重放一次，用户不可见。
  token_expired: { text: "登录已过期，正在自动续期", kind: "silent" },
  token_invalid: { text: "登录已失效，请重新登录", kind: "statusbar" },
  token_reused: {
    text: "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录",
    kind: "statusbar",
  },
  validation_error: {
    text: "请求参数异常，请更新应用后重试；若持续出现请反馈",
    kind: "inline",
  },
  service_unavailable: { text: "邮件服务暂时不可用，请稍后再试", kind: "inline" },
  // 以下为 Rust 生成的本地伪码（§3 末三行）。
  network_error: { text: "网络连接失败，请检查网络后重试", kind: "inline" },
  storage_error: { text: "本地安全存储读写失败，请重试或反馈", kind: "inline" },
  parse_error: { text: FALLBACK_TEXT, kind: "inline" },
  unknown: { text: FALLBACK_TEXT, kind: "inline" },
};

/** 读取 429 限流的 retry-after 秒数（AuthError.retryAfterSeconds 透传，§4.5）。 */
export function retryAfterSecondsOf(err: unknown): number | null {
  const like = toErrorLike(err);
  const secs = like?.retryAfterSeconds;
  return typeof secs === "number" && Number.isFinite(secs) && secs > 0
    ? Math.floor(secs)
    : null;
}

function toErrorLike(err: unknown): AuthErrorLike | null {
  if (err !== null && typeof err === "object") return err as AuthErrorLike;
  return null;
}

function toCode(err: unknown): string {
  const like = toErrorLike(err);
  if (like && typeof like.code === "string" && like.code !== "") return like.code;
  // 兜底：invoke 异常可能直接是字符串（旧路径/测试注入），按 code 解析。
  if (typeof err === "string" && err.trim() !== "") return err.trim();
  return "unknown";
}

/**
 * 错误码 → { text, kind }。任何未知 code 都安全落到 unknown 文案（inline），
 * 服务端 message 永不进入返回值。
 */
export function authErrorText(err: unknown): AuthErrorTextResult {
  let code = toCode(err);
  // §3 第77行：unauthorized 同 token_invalid 文案与动作——连同归一化后的 code 一并归一。
  if (code === "unauthorized") code = "token_invalid";
  if (code === "rate_limited") {
    const secs = retryAfterSecondsOf(err);
    return {
      text: secs !== null ? `操作过于频繁，请 ${secs} 秒后再试` : "操作过于频繁，请稍后再试",
      kind: "inline",
      code,
    };
  }
  const entry = CODE_TABLE[code];
  if (entry) return { text: entry.text, kind: entry.kind, code };
  return { text: FALLBACK_TEXT, kind: "inline", code: "unknown" };
}

/**
 * 账号 tab 顶部失效状态条文案（AuthStatus.notice，设计 D8）。
 * session_expired ← token_invalid；session_kicked ← token_reused（§3 表）。
 */
export function authNoticeText(notice: "session_expired" | "session_kicked" | null): string | null {
  if (notice === "session_expired") return "登录已失效，请重新登录";
  if (notice === "session_kicked")
    return "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录";
  return null;
}
