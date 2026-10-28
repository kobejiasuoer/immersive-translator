/**
 * 沉浸云语音卡的视图状态机（契约 §三.6 全部分支，纯函数可单测）。
 *
 * 输入是页面已有的原始信号（能力拉取中/失败码/me/config voice 段/402 事件），
 * 输出是卡片渲染所需的单一视图状态：caps 相位 + 缺失能力 + 配额视图。
 * 文案同样收敛在这里（状态行 / 能力卡徽标），UI 层不重复写分支。
 *
 * 配额两来源（§三.7 / 2026-10-28 决策 3）：me/config 下发 quota 字段 → 常驻余量条；
 * 未下发 → 402/WSS quota_exceeded 事件式兜底（quotaEvents 只记 resource 裸值）。
 */

import { quotaDetailsOf, quotaFeatureLabel, voiceErrorMessage } from "./voiceErrors";
import type {
  VoiceCapabilities,
  VoiceQuotaKey,
  VoiceQuotaMap,
} from "./voiceCapabilities";

/** 三项能力（与服务端资源一一对应；展示名见 CAPABILITY_LABELS）。 */
export type VoiceCapabilityKey = VoiceQuotaKey;

/** 能力卡相位（§三.6：能力下发中/可用/部分可用三种/未开通/网络失败/封禁）。 */
export type VoiceCapsPhase = "loading" | "full" | "partial" | "none" | "error" | "banned";

export interface VoiceGatewayView {
  caps: VoiceCapsPhase;
  /** partial 时缺失的能力（ttsVoices 空 / asrLanguages 空 / iseEnabled=false）。 */
  missing: VoiceCapabilityKey[];
  /** 常驻配额（me/config quota 字段；未下发为 null → 402 事件式兜底）。 */
  quota: VoiceQuotaMap | null;
  /** 配额耗尽（常驻 remaining===0，或兜底收到过 quota_exceeded 事件）。 */
  exhausted: boolean;
  /** 已耗尽功能的展示名（「本月朗读额度已用完」插值与明细行用）。 */
  exhaustedLabels: string[];
}

export interface VoiceGatewayInput {
  /** 能力拉取进行中（含登录后的首次下发）。 */
  loading: boolean;
  /** 能力拉取失败的错误码；网络类归 "network_error"，null = 无失败。 */
  errorCode: string | null;
  caps: VoiceCapabilities | null;
  /** quota_exceeded 事件里的 resource 裸值（tts_chars / asr_seconds / ise_calls）。 */
  quotaEvents: string[];
}

const ALL_CAPABILITIES: VoiceCapabilityKey[] = ["tts", "asr", "ise"];

export const CAPABILITY_LABELS: Record<VoiceCapabilityKey, string> = {
  tts: "云端朗读",
  asr: "口语识别",
  ise: "跟读打分",
};

/** 状态行 / 部分可用文案里的短名。 */
export const CAPABILITY_SHORT: Record<VoiceCapabilityKey, string> = {
  tts: "朗读",
  asr: "识别",
  ise: "跟读打分",
};

function emptyQuotaView(): Pick<VoiceGatewayView, "quota" | "exhausted" | "exhaustedLabels"> {
  return { quota: null, exhausted: false, exhaustedLabels: [] };
}

/**
 * 状态机归约：优先级 封禁 > 网络失败 > 下发中 > 未开通 > 部分/全可用；
 * 配额耗尽不改动 caps 相位（能力仍可用），只叠在视图上（原型状态 7 同口径）。
 */
export function reduceVoiceGatewayView(input: VoiceGatewayInput): VoiceGatewayView {
  if (input.errorCode === "banned") {
    return { caps: "banned", missing: [], ...emptyQuotaView() };
  }
  if (input.errorCode !== null) {
    return { caps: "error", missing: [], ...emptyQuotaView() };
  }
  if (input.loading || input.caps === null) {
    return { caps: "loading", missing: [], ...emptyQuotaView() };
  }
  const caps = input.caps;
  if (!caps.available) {
    // 已登录但 me/config 无 voice 段：服务端尚未为本账号开通语音（voice_not_configured）。
    return { caps: "none", missing: [], ...emptyQuotaView() };
  }
  const missing = ALL_CAPABILITIES.filter((key) => {
    if (key === "tts") return caps.ttsVoices.length === 0;
    if (key === "asr") return caps.asrLanguages.length === 0;
    return !caps.iseEnabled;
  });

  // 常驻来源：下发 quota 里 remaining===0 的资源；兜底来源：402/WSS 事件。
  const exhaustedLabels = new Set<string>();
  if (caps.quota !== null) {
    for (const key of ALL_CAPABILITIES) {
      const entry = caps.quota[key];
      if (entry !== undefined && entry.remaining === 0) exhaustedLabels.add(CAPABILITY_LABELS[key]);
    }
  }
  for (const resource of input.quotaEvents) {
    exhaustedLabels.add(quotaFeatureLabel(resource));
  }
  return {
    caps: missing.length > 0 ? "partial" : "full",
    missing,
    quota: caps.quota,
    exhausted: exhaustedLabels.size > 0,
    exhaustedLabels: [...exhaustedLabels],
  };
}

/** 沉浸云大卡状态行（§三.6 文案表；tone 对应 .platform-card-status 的 ok/off/err）。 */
export function voiceGatewayStatusLine(
  view: VoiceGatewayView,
  opts: { loggedIn: boolean; email: string },
): { tone: "ok" | "off" | "err"; text: string } {
  if (!opts.loggedIn) {
    return { tone: "off", text: "未登录——选中后到右侧登录即可使用" };
  }
  switch (view.caps) {
    case "banned":
      return { tone: "err", text: "账号已被封禁" };
    case "error":
      return { tone: "err", text: "连接沉浸云失败，请检查网络" };
    case "none":
      return { tone: "off", text: "语音功能暂未开通——账号正常，服务端尚未为本账号开通语音" };
    case "partial": {
      const present = ALL_CAPABILITIES.filter((k) => !view.missing.includes(k));
      return {
        tone: "off",
        text: `已登录 ${opts.email} · ${present.map((k) => CAPABILITY_SHORT[k]).join("、")}可用，${view.missing
          .map((k) => CAPABILITY_SHORT[k])
          .join("、")}未开放`,
      };
    }
    case "loading":
      return { tone: "ok", text: `已登录 ${opts.email} · 正在获取语音能力…` };
    case "full":
      if (view.exhausted) {
        return { tone: "off", text: `已登录 ${opts.email} · 本月额度已用完` };
      }
      return { tone: "ok", text: `已登录 ${opts.email} · 朗读、识别、跟读打分全部可用` };
  }
}

/** 本月额度明细（单位与 QuotaService 同源：tts=字符、asr=整秒、ise=次）。 */
export function quotaLine(quota: VoiceQuotaMap): string {
  const units: Record<VoiceCapabilityKey, [string, string]> = {
    tts: ["朗读", "字"],
    asr: ["识别", "秒"],
    ise: ["跟读", "次"],
  };
  const part = (key: VoiceCapabilityKey): string => {
    const [name, unit] = units[key];
    const entry = quota[key];
    const value = entry !== undefined && entry.remaining !== null ? entry.remaining : "—";
    return `${name} ${value} ${unit}`;
  };
  return `${part("tts")} · ${part("asr")} · ${part("ise")}`;
}

/** 重置时间（UTC 自然月末；ISO → 「11 月 1 日重置」，解析失败返回 null）。 */
export function quotaResetText(resetsAt: string | null | undefined): string | null {
  if (resetsAt === null || resetsAt === undefined || resetsAt === "") return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日重置`;
}

/**
 * 消费点错误展示文案（§二 quota_exceeded 动作列的唯一消费口）：voiceErrorMessage
 * 基础上，额度类错误（action="redeem"）把 402/WSS details 的 resetsAt 拼成
 * 「N 月 N 日重置」；服务端 resetsAt 未下发时给「设置 → 账号」兑换码入口指路
 * （与路由守卫的额度 hint 同措辞）。其余 code 原样透传；silent/internal（text 为
 * 空串）原样返回，调用方按各自兜底处理。SpeakView/ShadowDrill/useShadowAssess/
 * ReviewView/LiveCaptionApp 的云端错误分支统一走这里。
 */
export function voiceErrorDisplayText(
  input: string | { code?: unknown; details?: unknown },
): string {
  const info = voiceErrorMessage(input);
  if (info.text === "") return "";
  if (info.action === "redeem") {
    const reset = quotaResetText(quotaDetailsOf(input).resetsAt);
    return reset !== null
      ? `${info.text}，${reset}`
      : `${info.text}，可在「设置 → 账号」用兑换码补足`;
  }
  return info.text;
}
