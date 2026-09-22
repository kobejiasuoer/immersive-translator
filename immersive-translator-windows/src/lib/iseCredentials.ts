/**
 * 讯飞凭据（DPAPI 命名 secret）。
 *
 * 模型：一组「主凭据」（ISE 三件套）+ 两个可选的按服务覆盖（TTS / ASR）。
 * 讯飞开放平台的凭据按应用发放，同一个应用可同时开通多个服务
 * （语音评测 / 流式听写 / 在线合成），所以普通用户只填主凭据一组即可；
 * 只有当不同服务真的用了不同应用时，才需要在高级区单独覆盖。
 * - 主凭据（评测 ISE）：跟读打分直接用它；听写/合成在无覆盖时回落到它。
 * - 覆盖三元组只写自己的键，清空后自动回到主凭据。
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

/** 删除一组三元组的全部条目（secret_set 空串 = 删除）。 */
async function clearCredTriple(keys: SecretKeyTriple): Promise<void> {
  await Promise.all([
    secretSetNamed(keys.appId, ""),
    secretSetNamed(keys.apiKey, ""),
    secretSetNamed(keys.apiSecret, ""),
  ]);
}

// ---- 主凭据（语音评测 ISE，兼听写/合成的回落源） ----

/** 三项都配置好才返回凭据，否则返回 null。 */
export async function loadIseCredentials(): Promise<IseCredentials | null> {
  return loadCredTriple(XFYUN_ISE_SECRET_KEYS);
}

/** 设置页回显用：逐字段读取已保存的主凭据（未存过的字段为空串）。 */
export async function loadIseCredentialParts(): Promise<{
  appId: string;
  apiKey: string;
  apiSecret: string;
}> {
  const [appId, apiKey, apiSecret] = await Promise.all([
    secretGetNamed(XFYUN_ISE_SECRET_KEYS.appId).catch(() => ""),
    secretGetNamed(XFYUN_ISE_SECRET_KEYS.apiKey).catch(() => ""),
    secretGetNamed(XFYUN_ISE_SECRET_KEYS.apiSecret).catch(() => ""),
  ]);
  return { appId, apiKey, apiSecret };
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

// ---- 在线合成（TTS）：优先专用覆盖，缺省回落主凭据 ----

export async function loadXfyunTtsCredentials(): Promise<XfyunTtsCredentials | null> {
  const own = await loadCredTriple(XFYUN_TTS_SECRET_KEYS).catch(() => null);
  if (own) return own;
  // 讯飞同一应用可开通在线合成；主凭据没开该服务时由设置页「测试」给出指引。
  return loadCredTriple(XFYUN_ISE_SECRET_KEYS);
}

/** 只写覆盖三元组的非空字段（部分更新）。 */
export async function saveXfyunTtsCredentials(
  patch: { appId?: string; apiKey?: string; apiSecret?: string },
): Promise<boolean> {
  return saveCredTriple(XFYUN_TTS_SECRET_KEYS, patch);
}

/** 清除合成服务的单独覆盖，回到使用主凭据。 */
export async function clearXfyunTtsCredentials(): Promise<void> {
  await clearCredTriple(XFYUN_TTS_SECRET_KEYS);
}

/** 生效凭据来源：own = 单独覆盖，main = 主凭据，null = 什么都没配。 */
export async function xfyunTtsCredSource(): Promise<"own" | "main" | null> {
  const own = await loadCredTriple(XFYUN_TTS_SECRET_KEYS).catch(() => null);
  if (own) return "own";
  const main = await loadCredTriple(XFYUN_ISE_SECRET_KEYS).catch(() => null);
  return main ? "main" : null;
}

export async function xfyunTtsCredsConfigured(): Promise<boolean> {
  const creds = await loadXfyunTtsCredentials().catch(() => null);
  return creds !== null;
}

// ---- 流式听写（ASR，口语陪练 / 录音直译）：优先专用覆盖，缺省回落主凭据 ----

export async function loadAsrCredentials(): Promise<IseCredentials | null> {
  const own = await loadCredTriple(XFYUN_ASR_SECRET_KEYS).catch(() => null);
  if (own) return own;
  return loadCredTriple(XFYUN_ISE_SECRET_KEYS);
}

/** 只写 ASR 覆盖三元组的非空字段（部分更新）。 */
export async function saveAsrCredentials(
  patch: { appId?: string; apiKey?: string; apiSecret?: string },
): Promise<boolean> {
  return saveCredTriple(XFYUN_ASR_SECRET_KEYS, patch);
}

/** 清除听写服务的单独覆盖，回到使用主凭据。 */
export async function clearAsrCredentials(): Promise<void> {
  await clearCredTriple(XFYUN_ASR_SECRET_KEYS);
}

/** 生效凭据来源：own = 单独覆盖，main = 主凭据，null = 什么都没配。 */
export async function asrCredSource(): Promise<"own" | "main" | null> {
  const own = await loadCredTriple(XFYUN_ASR_SECRET_KEYS).catch(() => null);
  if (own) return "own";
  const main = await loadCredTriple(XFYUN_ISE_SECRET_KEYS).catch(() => null);
  return main ? "main" : null;
}
