/**
 * 消费点路由守卫(契约 §三.5 硬性契约,防存量回归)。
 *
 * voiceProvider=gateway 仅在「已登录 && 能力可用 && 未配额耗尽」时对消费点生效;
 * 不满足时给出回落原因与引导文案:TTS 静默回落 edge/本地引擎(EDGE_FALLBACK_NOTICE),
 * ASR/ISE 入口按态禁用并给「登录沉浸云即用」引导。
 * provider=xfyun(存量讯飞用户)不经守卫、直接走原直连路径(契约 §四:零改动保留)。
 *
 * 纯归约(reduceVoiceRoute)与异步取数(resolveVoiceRoute)分开:归约穷举单测,
 * 取数侧 loggedIn 每次现查(Rust 内存态,IPC 毫秒级);caps 带 30s TTL 缓存
 * (me/config 是 HTTPS 往返,不能每句现拉;服务端配额字段未下发时的实时性
 * 由调用时的 402 错误文案兜底,不在这里追)。
 */

import { authGetStatus } from "../tauriBridge";
import { loadSettings, resolveInitialVoiceProvider } from "../settingsStore";
import {
  getVoiceCapabilities,
  type VoiceCapabilities,
  type VoiceQuotaRemaining,
} from "./voiceCapabilities";
import { quotaResourceKey } from "./voiceCapabilities";
import { CAPABILITY_LABELS, CAPABILITY_SHORT } from "./gatewayViewState";
import type { VoiceAsrLang } from "./voiceAsr";

/** 消费能力(tts/asr/ise,与服务端配额资源一一对应)。 */
export type VoiceRouteAbility = "tts" | "asr" | "ise";

/** 不走 gateway 的回落原因(provider=xfyun 是显式选择,reason 保持 null)。 */
export type VoiceRouteFallback =
  | "not_logged_in"
  | /** 能力拉取失败且错误码是 banned(封禁,不暗示重试)。 */ "banned"
  | /** 能力未拉到(null,网络/取数失败)。 */ "caps_unavailable"
  | /** 能力拉到了但服务端未为本账号开通语音(voice 段缺失)。 */ "voice_not_configured"
  | "quota_exhausted"
  | "capability_missing"
  | "ise_turned_off";

/** 消费点引擎去向:gateway=VoiceClient;xfyun=存量讯飞直连;off=入口禁用/回落。 */
export type VoiceRouteEngine = "gateway" | "xfyun" | "off";

export interface VoiceRouteDecision {
  engine: VoiceRouteEngine;
  reason: VoiceRouteFallback | null;
  /** 用户可见引导(简体中文);off 且 hint=null 时调用方静默处理。 */
  hint: string | null;
  /** 配额耗尽时携带常驻 resetsAt，供朗读回落提示复用统一错误映射。 */
  quota?: VoiceQuotaRemaining | null;
}

/** 守卫归约的输入信号(全部可从 UI 态/能力下发获得;纯函数可单测)。 */
export interface VoiceRouteSignals {
  loggedIn: boolean;
  /** null = 未拉到能力(网络失败/未接线/未登录拉取被拒等)。 */
  caps: VoiceCapabilities | null;
  /** 能力拉取失败的错误码(AuthError.code,banned 单列;其余归网络失败)。
   *  null/缺省 = 拉取成功。与 caps 不同时成立:失败侧 caps 恒 null。 */
  capsError?: string | null;
  /** 402/WSS quota_exceeded 事件的 resource 裸值(tts_chars 等;事件式兜底来源)。 */
  quotaEvents: string[];
  ability: VoiceRouteAbility;
  /** asr 要求的具体语种;不给则只看 asrLanguages 是否为空。 */
  asrLang?: VoiceAsrLang;
  /** 本地跟读打分开关(voiceGatewayIseEnabled)已关闭;仅 ability=ise 时消费。 */
  iseLocalOff?: boolean;
}

/** TTS 守卫不通过时的回落标注(契约 §三.5:「已临时使用 Edge 朗读」)。 */
export const EDGE_FALLBACK_NOTICE = "已临时使用 Edge 朗读";

/** 配额耗尽(常驻 remaining===0,或 402 事件按 resource 别名归并命中)。 */
function quotaExhausted(
  caps: VoiceCapabilities,
  quotaEvents: string[],
  ability: VoiceRouteAbility,
): boolean {
  const entry = caps.quota?.[ability];
  if (entry !== undefined && entry.remaining === 0) return true;
  return quotaEvents.some((resource) => quotaResourceKey(resource) === ability);
}

/**
 * 守卫归约:优先级 未登录 > 封禁 > 能力不可用(网络) > 未开通 > 配额耗尽 > 本地跟读
 * 开关 > 能力缺失 > 放行。封禁/未开通与网络失败分开给文案(契约 §二:banned→「账号
 * 已被封禁」不暗示重试;voice_not_configured→「语音功能暂未开通」),措辞取自
 * gatewayViewState 状态行 / voiceErrors 映射表的既有文案,不另写第三份。
 * 能力缺失语义与语音页部分可用同源(ttsVoices 空 / asrLanguages 空或不含所需语种 /
 * iseEnabled=false),文案直接复用 gatewayViewState 的能力名,两处不写两份。
 */
export function reduceVoiceRoute(s: VoiceRouteSignals): VoiceRouteDecision {
  if (!s.loggedIn) {
    return { engine: "off", reason: "not_logged_in", hint: "登录沉浸云即用" };
  }
  if (s.capsError === "banned") {
    return { engine: "off", reason: "banned", hint: "账号已被封禁" };
  }
  if (s.caps === null) {
    return {
      engine: "off",
      reason: "caps_unavailable",
      hint: "暂无法连接沉浸云语音，请检查网络后重试",
    };
  }
  if (!s.caps.available) {
    // 已登录但 me/config 无 voice 段:服务端尚未为本账号开通语音(voice_not_configured),
    // 不给「重试/查网络」类误导(gatewayViewState 的 none 态同口径)。
    return { engine: "off", reason: "voice_not_configured", hint: "语音功能暂未开通" };
  }
  if (quotaExhausted(s.caps, s.quotaEvents, s.ability)) {
    return {
      engine: "off",
      reason: "quota_exhausted",
      hint: `本月${CAPABILITY_SHORT[s.ability]}额度已用完，可在「设置 → 账号」用兑换码补足`,
      quota: s.caps.quota?.[s.ability] ?? null,
    };
  }
  if (s.ability === "ise" && s.iseLocalOff === true) {
    return {
      engine: "off",
      reason: "ise_turned_off",
      hint: "跟读打分已在设置里关闭，可在「设置 → 语音」重新开启",
    };
  }
  const missing =
    (s.ability === "tts" && s.caps.ttsVoices.length === 0) ||
    (s.ability === "asr" &&
      (s.caps.asrLanguages.length === 0 ||
        (s.asrLang !== undefined && !s.caps.asrLanguages.includes(s.asrLang)))) ||
    (s.ability === "ise" && !s.caps.iseEnabled);
  if (missing) {
    return {
      engine: "off",
      reason: "capability_missing",
      hint: `沉浸云${CAPABILITY_LABELS[s.ability]}暂未开放`,
    };
  }
  return { engine: "gateway", reason: null, hint: null };
}

// ---- 异步取数 ----

const CAPS_TTL_MS = 30_000;
let capsCache: { at: number; caps: VoiceCapabilities } | null = null;

/** 一次能力取数的结果:成功带 caps,失败带错误码(AuthError.code,网络类归
 *  network_error)。失败不缓存(下一次调用立即重试,网络恢复即恢复)。 */
interface CapsFetch {
  caps: VoiceCapabilities | null;
  errorCode: string | null;
}

/** me/config 带 TTL 缓存;失败不缓存且错误码原样带回(banned 由归约单列成封禁文案,
 *  不再与网络失败并成一句「查网络」)。 */
async function fetchCaps(): Promise<CapsFetch> {
  if (capsCache !== null && Date.now() - capsCache.at < CAPS_TTL_MS) {
    return { caps: capsCache.caps, errorCode: null };
  }
  try {
    const caps = await getVoiceCapabilities();
    capsCache = { at: Date.now(), caps };
    return { caps, errorCode: null };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return {
      caps: null,
      errorCode: typeof code === "string" && code !== "" ? code : "network_error",
    };
  }
}

/** 单测隔离/登出后强制重拉。 */
export function resetVoiceRouteForTests(): void {
  capsCache = null;
}

/**
 * 消费点入口:生效服务商(已存值优先,否则按讯飞凭据迁移推断)为 xfyun 时不经守卫
 * 直接放行存量路径;为 gateway 时现查登录态与能力归约。
 * 不抛错:登录态/能力取数失败都折算成保守的 off(带引导),不会挡住 xfyun 用户。
 */
export async function resolveVoiceRoute(
  ability: VoiceRouteAbility,
  opts?: { asrLang?: VoiceAsrLang },
): Promise<VoiceRouteDecision> {
  // 偏好读取/推断整体兜底：拿不到生效服务商时按存量讯飞路径处理（零回归优先，
  // 与「守卫只负责拦 gateway、不负责拦存量」的边界一致）。
  let provider: "gateway" | "xfyun";
  try {
    provider = await resolveInitialVoiceProvider(loadSettings().voiceProvider);
  } catch {
    provider = "xfyun";
  }
  if (provider !== "gateway") {
    return { engine: "xfyun", reason: null, hint: null };
  }
  const loggedIn = await authGetStatus()
    .then((s) => s.loggedIn)
    .catch(() => false);
  // 未登录时归约必然落到 not_logged_in,不必再拉能力(省一次 me/config 往返)。
  const fetched: CapsFetch = loggedIn ? await fetchCaps() : { caps: null, errorCode: null };
  return reduceVoiceRoute({
    loggedIn,
    caps: fetched.caps,
    capsError: fetched.errorCode,
    // 402 事件由调用点在错误文案里兜底(§二映射),守卫只看常驻配额。
    quotaEvents: [],
    ability,
    asrLang: opts?.asrLang,
    iseLocalOff: ability === "ise" && loadSettings().voiceGatewayIseEnabled === false,
  });
}
