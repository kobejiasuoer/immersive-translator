/**
 * 讯飞凭据（DPAPI 命名 secret）。
 * - 语音评测（ISE）与在线合成（TTS）是讯飞控制台里两个独立应用，凭据分开存。
 * - 三段一组：APPID / API Key / API Secret，存储与翻译 Key 同一套 secret_store。
 */

import {
  secretExistsNamed,
  secretGetNamed,
  secretSetNamed,
} from "./tauriBridge";
import type { IseCredentials } from "../core/pronunciation";
import type { XfyunTtsCredentials } from "../core/xfyunTts";

export const XFYUN_ISE_SECRET_KEYS = {
  appId: "xfyun_ise_app_id",
  apiKey: "xfyun_ise_api_key",
  apiSecret: "xfyun_ise_api_secret",
} as const;

export const XFYUN_TTS_SECRET_KEYS = {
  appId: "xfyun_tts_app_id",
  apiKey: "xfyun_tts_api_key",
  apiSecret: "xfyun_tts_api_secret",
} as const;

export const XFYUN_ASR_SECRET_KEYS = {
  appId: "xfyun_asr_app_id",
  apiKey: "xfyun_asr_api_key",
  apiSecret: "xfyun_asr_api_secret",
} as const;

type SecretKeyTriple = { appId: string; apiKey: string; apiSecret: string };

async function loadCredTriple(keys: SecretKeyTriple): Promise<{ appId: string; apiKey: string; apiSecret: string } | null> {
  const [appId, apiKey, apiSecret] = await Promise.all([
    secretGetNamed(keys.appId),
    secretGetNamed(keys.apiKey).catch(() => ""),
    secretGetNamed(keys.apiSecret),
  ]).catch(() => ["", "", ""] as const);
  if (!appId || !apiKey || !apiSecret) return null;
  return { appId, apiKey, apiSecret };
}

async function saveCredTriple(keys: SecretKeyTriple, patch: Partial<SecretKeyTriple>): Promise<boolean> {
  const jobs: Promise<void>[] = [];
  if (patch.appId?.trim()) jobs.push(secretSetNamed(keys.appId, patch.appId.trim()));
  if (patch.apiKey?.trim()) jobs.push(secretSetNamed(keys.apiKey, patch.apiKey.trim()));
  if (patch.apiSecret?.trim()) jobs.push(secretSetNamed(keys.apiSecret, patch.apiSecret.trim()));
  await Promise.all(jobs);
  const [a, k, s] = await Promise.all([
    secretExistsNamed(keys.appId),
    secretExistsNamed(keys.apiKey),
    secretExistsNamed(keys.apiSecret),
  ]).catch(() => [false, false, false] as const);
  return a && k && s;
}

// ---- 语音评测（ISE）----

/** 三项都配置好才返回凭据，否则返回 null。 */
export async function loadIseCredentials(): Promise<IseCredentials | null> {
  return loadCredTriple(XFYUN_ISE_SECRET_KEYS);
}

/** 只写入非空字段（部分更新）；写入后重新校验是否齐全。 */
export async function saveIseCredentials(
  patch: { appId?: string; apiKey?: string; apiSecret?: string },
): Promise<boolean> {
  return saveCredTriple(XFYUN_ISE_SECRET_KEYS, patch);
}

export async function iseCredsConfigured(): Promise<boolean> {
  const creds = await loadIseCredentials().catch(() => null);
  return creds !== null;
}

// ---- 在线合成（TTS）----

export async function loadXfyunTtsCredentials(): Promise<XfyunTtsCredentials | null> {
  return loadCredTriple(XFYUN_TTS_SECRET_KEYS);
}

export async function saveXfyunTtsCredentials(
  patch: { appId?: string; apiKey?: string; apiSecret?: string },
): Promise<boolean> {
  return saveCredTriple(XFYUN_TTS_SECRET_KEYS, patch);
}

export async function xfyunTtsCredsConfigured(): Promise<boolean> {
  const creds = await loadXfyunTtsCredentials().catch(() => null);
  return creds !== null;
}

// ---- 流式听写（ASR，口语陪练 / 录音直译）----

/**
 * ASR 凭据：优先读专用三元组；没配则回落语音评测（ISE）那组 ——
 * 讯飞一个应用可同时开通「语音评测 + 流式听写」，多数用户只需要配一次。
 */
export async function loadAsrCredentials(): Promise<IseCredentials | null> {
  const own = await loadCredTriple(XFYUN_ASR_SECRET_KEYS).catch(() => null);
  if (own) return own;
  return loadCredTriple(XFYUN_ISE_SECRET_KEYS);
}

/** 只写 ASR 专用三元组的非空字段（部分更新）。 */
export async function saveAsrCredentials(
  patch: { appId?: string; apiKey?: string; apiSecret?: string },
): Promise<boolean> {
  return saveCredTriple(XFYUN_ASR_SECRET_KEYS, patch);
}
