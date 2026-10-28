/**
 * 能力下发(getVoiceCapabilities,契约 §一/§四):GET /v1/me/config 的 voice 段。
 *
 * 复用既有鉴权通道:直接走 tauriBridge.authFetchServerConfig(Rust with_auth——
 * 惰性刷新/401 单飞刷新重放全在 Rust,见 src-tauri/src/auth.rs),不自建第二套。
 * 配额余量字段:2026-10-28 服务端待补(须含 tts/asr/ise 各自 remaining 与 resetsAt,
 * UTC 自然月),解析按「voice.quota.{tts|tts_chars|asr|asr_seconds|ise|ise_calls}」
 * 容错匹配;字段未上线时 quota=null,UI 走 402 事件式兜底,字段上线自动点亮常驻余量条。
 * 鉴权类失败(AuthError)原样抛出,文案走既有 authErrorText(登录态错误与账号页同源)。
 */

import { authFetchServerConfig } from "../tauriBridge";

export interface VoiceTtsVoice {
  id: string;
  label: string;
}

export interface VoiceQuotaRemaining {
  remaining: number | null;
  allowance: number | null;
  /** ISO 时刻(UTC 自然月末);服务端字段未下发时为 null。 */
  resetsAt: string | null;
}

export type VoiceQuotaKey = "tts" | "asr" | "ise";

export type VoiceQuotaMap = Partial<Record<VoiceQuotaKey, VoiceQuotaRemaining>>;

export interface VoiceCapabilities {
  /** voice 段是否存在且形状合法(官方云未开通/旧服务端为 false)。 */
  available: boolean;
  /** 音色表(默认音色排第一,服务端已排序,原样透传)。 */
  ttsVoices: VoiceTtsVoice[];
  /** ASR 可用语种(消费点 lang 只能取其中)。 */
  asrLanguages: string[];
  iseEnabled: boolean;
  /** 配额余量(服务端字段上线前为 null)。 */
  quota: VoiceQuotaMap | null;
}

const EMPTY: VoiceCapabilities = {
  available: false,
  ttsVoices: [],
  asrLanguages: [],
  iseEnabled: false,
  quota: null,
};

function looseRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function parseVoices(raw: unknown): VoiceTtsVoice[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceTtsVoice[] = [];
  for (const item of raw) {
    const rec = looseRecord(item);
    if (rec === null || typeof rec["id"] !== "string" || rec["id"] === "") continue;
    out.push({
      id: rec["id"],
      label: typeof rec["label"] === "string" && rec["label"] !== "" ? rec["label"] : rec["id"],
    });
  }
  return out;
}

function parseLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v !== "");
}

const QUOTA_KEY_ALIASES: Record<string, VoiceQuotaKey> = {
  tts: "tts",
  tts_chars: "tts",
  asr: "asr",
  asr_seconds: "asr",
  ise: "ise",
  ise_calls: "ise",
};

/** 402/WSS 事件的 resource 裸值(tts_chars 等)归一成配额键;未知资源返回 null。 */
export function quotaResourceKey(resource: string): VoiceQuotaKey | null {
  return QUOTA_KEY_ALIASES[resource] ?? null;
}

function parseQuota(raw: unknown): VoiceQuotaMap | null {
  const rec = looseRecord(raw);
  if (rec === null) return null;
  const quota: VoiceQuotaMap = {};
  let matched = false;
  for (const [key, value] of Object.entries(rec)) {
    const normalized = QUOTA_KEY_ALIASES[key];
    if (normalized === undefined) continue;
    const entry = looseRecord(value);
    if (entry === null) continue;
    matched = true;
    quota[normalized] = {
      remaining: typeof entry["remaining"] === "number" && Number.isFinite(entry["remaining"])
        ? entry["remaining"]
        : null,
      allowance: typeof entry["allowance"] === "number" && Number.isFinite(entry["allowance"])
        ? entry["allowance"]
        : null,
      resetsAt: typeof entry["resetsAt"] === "string" && entry["resetsAt"] !== ""
        ? entry["resetsAt"]
        : null,
    };
  }
  return matched ? quota : null;
}

/** me/config 原始 JSON → 能力形状(纯函数,容错旧服务端/缺失字段)。 */
export function parseVoiceCapabilities(raw: unknown): VoiceCapabilities {
  const root = looseRecord(raw);
  const voice = root === null ? null : looseRecord(root["voice"]);
  if (voice === null) return { ...EMPTY };
  return {
    available: true,
    ttsVoices: parseVoices(voice["ttsVoices"]),
    asrLanguages: parseLanguages(voice["asrLanguages"]),
    iseEnabled: voice["iseEnabled"] === true,
    quota: parseQuota(voice["quota"]),
  };
}

/** 拉取能力(冷启动由 UI 拉一次并缓存展示;本模块不做缓存)。 */
export async function getVoiceCapabilities(): Promise<VoiceCapabilities> {
  return parseVoiceCapabilities(await authFetchServerConfig());
}
