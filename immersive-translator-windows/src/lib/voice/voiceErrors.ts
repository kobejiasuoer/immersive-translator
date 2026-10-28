/**
 * 语音网关错误码 → 用户文案的唯一映射(docs/voice-cloud-implementation-contract-2026-10-28.md §二)。
 *
 * 约束:
 * - 只按 `code` 字符串分支,绝不透传服务端 message(UI 层与 VoiceClient 共用本表,勿写两处);
 * - 文案不出现 HTTP 状态码、协议术语等实现说明;
 * - token_expired 由 Rust 侧单飞刷新+重放吞掉(auth.rs with_auth),正常不会到 UI,映射仅供兜底;
 * - token_reused 沿用 authErrorText.ts 的既有文案(契约注明「与 Rust auth.rs SessionKicked
 *   既有文案对齐」,既有用户可见文案在 authErrorText,不另造第二句)。
 */

/** 语音错误(REST 信封 / WSS error 帧归一后的形状;AuthError 形状兼容)。 */
export class VoiceError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: string,
    opts?: { message?: string; details?: Record<string, unknown>; retryAfterSeconds?: number | null },
  ) {
    super(opts?.message ?? code);
    this.name = "VoiceError";
    this.code = code;
    this.details = opts?.details ?? {};
    this.retryAfterSeconds = opts?.retryAfterSeconds ?? null;
  }
}

/** 建议动作(账号页兑换码入口 / 登录页 / 申诉入口等,由 UI 消费)。 */
export type VoiceErrorAction = "relogin" | "appeal" | "redeem" | "retry" | null;

export interface VoiceErrorInfo {
  /** 用户可见的简体中文文案(silent/internal 时为空串)。 */
  text: string;
  /** message=可提示;silent=用户不可见(自动处置);internal=客户端内部处置(如拆句重发)。 */
  kind: "message" | "silent" | "internal";
  action: VoiceErrorAction;
  /** 客户端/用户是否应再试(终局错误为 false)。 */
  retryable: boolean;
}

/** voiceErrorMessage 的宽松输入(VoiceError / AuthError / WSS error 帧裸形状均可)。 */
interface VoiceErrorLike {
  code?: unknown;
  details?: unknown;
}

function codeOf(input: string | VoiceErrorLike): string {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return "unknown";
  const code = (input as VoiceErrorLike).code;
  return typeof code === "string" && code !== "" ? code : "unknown";
}

function detailsOf(input: string | VoiceErrorLike): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  const details = (input as VoiceErrorLike).details;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

/** quota_exceeded 的重置时间 / 剩余额度(details 字段,402 details 或 WSS error 帧 details)。 */
export interface VoiceQuotaDetails {
  resource: string | null;
  remaining: number | null;
  allowance: number | null;
  /** ISO 时刻(UTC 自然月末);缺失返回 null(服务端配额字段上线前的 402 事件式兜底)。 */
  resetsAt: string | null;
}

/** 从错误 details 里读配额余量(只认有限数/非空串,防御透传异常)。 */
export function quotaDetailsOf(input: string | VoiceErrorLike): VoiceQuotaDetails {
  const d = detailsOf(input);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    resource: typeof d["resource"] === "string" ? (d["resource"] as string) : null,
    remaining: num(d["remaining"]),
    allowance: num(d["allowance"]),
    resetsAt: typeof d["resetsAt"] === "string" && d["resetsAt"] !== "" ? (d["resetsAt"] as string) : null,
  };
}

/** quota_exceeded 文案里的功能名(服务端 quota.constants QUOTA_RESOURCES 子集 + 兜底)。 */
export function quotaFeatureLabel(resource: string | null): string {
  switch (resource) {
    case "tts_chars":
      return "朗读";
    case "asr_seconds":
      return "口语识别";
    case "ise_calls":
      return "跟读打分";
    case "llm_tokens":
      return "对话";
    default:
      return "语音";
  }
}

const FINAL_RETRY_TEXT = "请稍后再试";

/**
 * 错误码 → 用户文案与动作(§二表逐行)。`final=true` 表示自动重试已用尽,
 * 「正在重试」类文案切换为终局文案。未知 code 安全落到通用兜底。
 */
export function voiceErrorMessage(
  input: string | VoiceErrorLike,
  opts?: { final?: boolean },
): VoiceErrorInfo {
  const code = codeOf(input);
  const final = opts?.final === true;
  // §二:token_invalid / unauthorized 同文案同动作(unauthorized 归一,口径同 authErrorText)。
  const normalized = code === "unauthorized" ? "token_invalid" : code;
  switch (normalized) {
    // 静默:Rust 单飞刷新后重放一次,用户不可见。
    case "token_expired":
      return { text: "", kind: "silent", action: "retry", retryable: true };
    case "token_invalid":
      return { text: "登录已失效，请重新登录", kind: "message", action: "relogin", retryable: false };
    case "token_reused":
      return {
        text: "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录",
        kind: "message",
        action: "relogin",
        retryable: false,
      };
    case "banned":
      return { text: "账号已被封禁", kind: "message", action: "appeal", retryable: false };
    case "voice_ticket_invalid":
      return final
        ? { text: FINAL_RETRY_TEXT, kind: "message", action: "retry", retryable: false }
        : { text: "连接不稳定，正在重试…", kind: "message", action: "retry", retryable: true };
    case "quota_exceeded": {
      const label = quotaFeatureLabel(quotaDetailsOf(input).resource);
      return { text: `本月${label}额度已用完`, kind: "message", action: "redeem", retryable: false };
    }
    case "rate_limited":
      return { text: "请求太频繁，请稍后再试", kind: "message", action: "retry", retryable: true };
    // 不提示:隐藏评测入口即可。
    case "ise_disabled":
      return { text: "", kind: "silent", action: null, retryable: false };
    case "voice_not_configured":
      return { text: "语音功能暂未开通", kind: "message", action: null, retryable: false };
    // 内部处理:客户端保证按句拆分后重发,正常不会到 UI。
    case "voice_text_too_long":
      return { text: "", kind: "internal", action: "retry", retryable: true };
    case "voice_invalid_state":
    case "voice_session_too_long":
      return { text: "单次最长 60 秒，请重新开始", kind: "message", action: "retry", retryable: true };
    case "upstream_error":
    case "upstream_timeout":
      return final
        ? { text: FINAL_RETRY_TEXT, kind: "message", action: "retry", retryable: false }
        : { text: "服务暂时不可用，正在重试", kind: "message", action: "retry", retryable: true };
    // 本地伪码:WSS 意外断开(1006 等),客户端指数退避重连中。
    case "voice_disconnected":
      return final
        ? { text: "网络连接不稳定，请稍后再试", kind: "message", action: "retry", retryable: false }
        : { text: "网络中断，正在重连…", kind: "message", action: "retry", retryable: true };
    case "network_error":
      return { text: "网络连接失败，请检查网络后重试", kind: "message", action: "retry", retryable: true };
    default:
      return { text: "服务暂时不可用，请稍后再试", kind: "message", action: "retry", retryable: false };
  }
}
