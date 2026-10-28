/**
 * 语音网关 HTTP/WS 公共工具:鉴权请求、错误信封解析、WSS URL 拼装。
 * 协议:错误信封 {error:{code,message,details?}}(server error-codes.ts §8);
 * 402 额外带 x-quota-<resource>-remaining 响应头(details 之外唯一可得字段)。
 */

import { VoiceError } from "./voiceErrors";
import { getVoiceRuntime, type VoiceHttpResponse } from "./voiceRuntime";

/** 走注入的鉴权通道发请求(401→单飞刷新→重放一次由 Rust 内部完成,这里只见终态)。 */
export async function voiceRequest(
  method: "GET" | "POST",
  path: string,
  bodyJson?: string,
): Promise<VoiceHttpResponse> {
  const http = getVoiceRuntime().http;
  if (!http) {
    // 编程错误(应用启动未接线),不是用户可操作错误,直接抛普通 Error。
    throw new Error("语音网关 HTTP 通道未接线(需在应用启动时 setVoiceRuntime)");
  }
  return http(method, path, bodyJson);
}

function looseRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** 解析 JSON body;非 JSON 返回 null(调用方按 parse_error/unknown 兜底)。 */
export function parseJsonBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 信封缺失/非 JSON 时的 HTTP 状态兜底(§二按场景列的 401/402/429/5xx)。 */
function fallbackCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "unknown";
}

/**
 * 非 2xx 应答 → VoiceError:读 {error:{code,message,details}} 信封;信封缺失时按
 * HTTP 状态兜底;402 时若 details 缺 remaining,用 x-quota-<resource>-remaining
 * 头补(契约:响应头只有 remaining)。
 */
export function errorFromHttpResponse(
  status: number,
  body: string,
  retryAfterSeconds: number | null,
  headers: Record<string, string> = {},
): VoiceError {
  const envelope = parseJsonBody(body);
  const err = looseRecord(envelope?.["error"]);
  const code =
    typeof err["code"] === "string" && err["code"] !== "" ? err["code"] : fallbackCode(status);
  const details = looseRecord(err["details"]);
  if (code === "quota_exceeded" && typeof details["remaining"] !== "number") {
    const resource = typeof details["resource"] === "string" ? (details["resource"] as string) : null;
    // 优先 <resource> 专属头,否则取任一 x-quota-* 头(服务端键形如 x-quota-tts_chars-remaining)。
    const specificKey = resource === null ? null : `x-quota-${resource}-remaining`;
    const fallbackKey = Object.keys(headers).find((k) => k.toLowerCase().startsWith("x-quota-"));
    const raw =
      (specificKey !== null ? headers[specificKey] : undefined) ??
      (fallbackKey !== undefined ? headers[fallbackKey] : undefined);
    const parsed = typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) details["remaining"] = parsed;
  }
  const message = typeof err["message"] === "string" ? err["message"] : undefined;
  return new VoiceError(code, { message, details, retryAfterSeconds });
}

/** 2xx JSON body 解析;失败抛 unknown(服务端响应异常)。 */
export function requireOkJson(res: VoiceHttpResponse): Record<string, unknown> {
  const body = parseJsonBody(res.body);
  if (res.status < 200 || res.status >= 300 || body === null) {
    throw errorFromHttpResponse(res.status, res.body, res.retryAfterSeconds, res.headers);
  }
  return body;
}

/** https(s) base → ws(s) + path + query;base 缺失(官方云未开放)抛 voice_not_configured。 */
export async function buildWsUrl(
  path: string,
  query: Record<string, string>,
): Promise<string> {
  const base = await getVoiceRuntime().baseUrlSource();
  if (!base) throw new VoiceError("voice_not_configured", { message: "沉浸云服务未配置" });
  const params = new URLSearchParams(query);
  return `${base.replace(/^http/, "ws")}${path}?${params.toString()}`;
}
