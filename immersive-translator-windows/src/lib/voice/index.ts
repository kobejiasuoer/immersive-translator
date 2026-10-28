/**
 * 沉浸云语音网关客户端(纯逻辑层,UI 不接触帧协议)。
 * 规格输入:docs/voice-cloud-implementation-contract-2026-10-28.md §一/§二/§四。
 *
 * 鉴权边界:令牌存取与串行单飞刷新在 Rust(auth.rs TokenManager),本层不碰令牌——
 * REST/me/config 走既有 IPC 通道,WSS 用一次性 ticket 握手(voiceTicket 单飞)。
 * 生产接线:应用启动时 setVoiceRuntime({ http: <Rust with_auth 通道命令> })。
 */

export {
  VoiceError,
  voiceErrorMessage,
  quotaDetailsOf,
  quotaFeatureLabel,
  type VoiceErrorAction,
  type VoiceErrorInfo,
  type VoiceQuotaDetails,
} from "./voiceErrors";

export {
  setVoiceRuntime,
  resetVoiceRuntime,
  getVoiceRuntime,
  type VoiceHttpResponse,
  type VoiceHttpTransport,
  type WsLike,
  type WsFactory,
  type WsFrame,
  type WsCloseEvent,
  type VoiceBaseUrlSource,
} from "./voiceRuntime";

export {
  voiceRequest,
  errorFromHttpResponse,
  buildWsUrl,
  parseJsonBody,
  requireOkJson,
} from "./voiceHttp";

export {
  float32ToInt16,
  bytesToBase64,
  pcm16kToBase64,
  pcm16kBytes,
  type Pcm16kPayload,
} from "./resample";

export {
  splitTtsText,
  utf8ByteLength,
  TTS_MAX_TEXT_BYTES,
  TTS_SPLIT_MAX_BYTES,
} from "./ttsTextSplit";

export {
  createTicketManager,
  fetchVoiceTicket,
  sharedTicketManager,
  resetSharedTicketManagerForTests,
  type TicketManager,
  type TicketFetcher,
  type VoiceTicketIssued,
} from "./voiceTicket";

export {
  getVoiceCapabilities,
  parseVoiceCapabilities,
  quotaResourceKey,
  type VoiceCapabilities,
  type VoiceTtsVoice,
  type VoiceQuotaRemaining,
  type VoiceQuotaMap,
  type VoiceQuotaKey,
} from "./voiceCapabilities";

export {
  startStreamingAsr,
  pushAudioChunk,
  stopAsr,
  closeAsrStream,
  AsrStreamSession,
  asrBackoffMs,
  ASR_RECONNECT_BASE_MS,
  ASR_RECONNECT_MAX_MS,
  ASR_MAX_RECONNECTS,
  resetAsrForTests,
  type VoiceAsrLang,
  type AsrCallbacks,
  type AsrDeps,
} from "./voiceAsr";

export {
  synthesize,
  resetTtsForTests,
  TTS_PIECE_TIMEOUT_MS,
  type TtsChunkHandler,
  type TtsDeps,
} from "./voiceTts";

export {
  transcribeBatch,
  evaluatePronunciation,
  type AsrBatchResult,
  type VoiceIseResult,
  type VoiceIseLang,
} from "./voiceRest";

export {
  reduceVoiceRoute,
  resolveVoiceRoute,
  resetVoiceRouteForTests,
  EDGE_FALLBACK_NOTICE,
  type VoiceRouteAbility,
  type VoiceRouteDecision,
  type VoiceRouteEngine,
  type VoiceRouteFallback,
  type VoiceRouteSignals,
} from "./voiceRoute";

export { voiceErrorDisplayText } from "./gatewayViewState";
