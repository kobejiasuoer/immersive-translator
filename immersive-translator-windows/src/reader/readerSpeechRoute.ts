import type { ReaderSettings } from "../core/readerTypes";
import {
  EDGE_FALLBACK_NOTICE,
  resolveVoiceRoute,
  voiceErrorDisplayText,
  type VoiceRouteDecision,
} from "../lib/voice";
import type { SpeechEngine } from "./speechEngine";

export interface ReaderSpeechEngines {
  edge: SpeechEngine;
  xfyun: SpeechEngine;
  gateway: SpeechEngine;
  sapi: SpeechEngine;
}

export interface ReaderSpeechRouteResult {
  engine: SpeechEngine;
  /** 仅 cloud + gateway 守卫不通过时非空；调用方据此展示 Edge 回落提示。 */
  fallback: VoiceRouteDecision | null;
}

interface RouteOptions {
  provider: ReaderSettings["ttsProvider"];
  xfyunReady: boolean;
  engines: ReaderSpeechEngines;
  resolveRoute?: typeof resolveVoiceRoute;
}

/** 阅读室朗读路由：旧 xfyun 不经过新守卫；cloud 才跟随语音页 voiceProvider。 */
export async function routeReaderSpeech({
  provider,
  xfyunReady,
  engines,
  resolveRoute = resolveVoiceRoute,
}: RouteOptions): Promise<ReaderSpeechRouteResult> {
  if (provider === "edge") return { engine: engines.edge, fallback: null };
  if (provider === "local") return { engine: engines.sapi, fallback: null };
  if (provider === "xfyun") {
    return { engine: xfyunReady ? engines.xfyun : engines.sapi, fallback: null };
  }

  const decision = await resolveRoute("tts");
  if (decision.engine === "gateway") return { engine: engines.gateway, fallback: null };
  if (decision.engine === "xfyun") {
    return { engine: xfyunReady ? engines.xfyun : engines.sapi, fallback: null };
  }
  return { engine: engines.edge, fallback: decision };
}

export interface ReaderFallbackNotice {
  message: string;
  action: "redeem" | null;
}

/** 守卫回落文案与配额动作：统一消费 voiceErrors / gatewayViewState 的既有映射。 */
export function readerEdgeFallbackNotice(decision: VoiceRouteDecision): ReaderFallbackNotice {
  const quota = decision.reason === "quota_exhausted";
  const detail = quota
    ? voiceErrorDisplayText({
        code: "quota_exceeded",
        details: { resource: "tts_chars", ...(decision.quota ?? {}) },
      })
    : decision.hint;
  return {
    message: `${EDGE_FALLBACK_NOTICE}${detail ? `：${detail}` : ""}`,
    action: quota ? "redeem" : null,
  };
}
