/** 移动端语音统一通过账号服务：短期凭证换票，音频经服务器收发。 */
import { activeRepository, getState, profileIdentity } from "../store";
import { invokeRaw, isTauri, reportDiag } from "./device";
import { CloudError, cloudRequest, cloudState, loadCloudConfig, subscribeCloud, type CloudConfig } from "./cloud";
import { isAudioRecordingActive, setWebAudioSessionType } from "./webAudioSession";

export type VoiceCapability = "tts" | "asr" | "ise";
interface VoiceIdentity { accountId: string; generation: number; repository: ReturnType<typeof activeRepository> }
function captureIdentity(): VoiceIdentity {
  const { account, generation } = cloudState();
  if (!account || profileIdentity() !== account.id) throw new CloudError("请完成登录后使用语音功能", 401, "login_required");
  return { accountId: account.id, generation, repository: activeRepository() };
}
function checkIdentity(identity: VoiceIdentity): void {
  if (cloudState().generation !== identity.generation || cloudState().account?.id !== identity.accountId || profileIdentity() !== identity.accountId || activeRepository() !== identity.repository) throw new DOMException("账号或资料已切换", "AbortError");
}
function checkRequest(identity: VoiceIdentity, signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
  checkIdentity(identity);
}
function withCancellation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("操作已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function voiceConfigured(kind?: VoiceCapability): boolean {
  const { account, config } = cloudState();
  if (!account || profileIdentity() !== account.id) return false;
  if (!kind) return true;
  if (!config?.voice) return false;
  return kind === "tts" ? config.voice.ttsVoices.length > 0 : kind === "asr" ? config.voice.asrLanguages.length > 0 : config.voice.iseEnabled;
}

export function voiceErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "操作已取消";
  const code = error instanceof CloudError ? error.code : "";
  const messages: Record<string, string> = {
    login_required: "登录后即可使用语音功能",
    token_expired: "登录已失效，请重新登录",
    token_invalid: "登录已失效，请重新登录",
    unauthorized: "登录已失效，请重新登录",
    token_reused: "登录已失效，请重新登录",
    banned: "账号暂时无法使用，请联系支持",
    quota_exceeded: "本月语音额度已用完，请稍后再试",
    rate_limited: "操作太频繁，请稍后再试",
    ise_disabled: "跟读评分暂未开放",
    voice_not_configured: "语音功能暂未开通，请稍后再试",
    voice_language_unavailable: "当前语言暂不支持语音识别",
    voice_ticket_invalid: "语音连接未成功，请稍后再试",
    upstream_error: "语音服务暂时不可用，请稍后再试",
    upstream_timeout: "语音服务响应超时，请稍后再试",
    voice_invalid_state: "语音识别已结束，请重新开始",
    voice_session_too_long: "单次录音最长 60 秒，请重新开始",
    voice_disconnected: "网络已断开，请重新开始",
    network_error: "网络连接失败，请稍后再试",
    unknown_result: "网络连接失败，请稍后再试",
  };
  if (code) return messages[code] ?? "语音服务暂时不可用，请稍后再试";
  if (error instanceof Error && error.message && !/undefined|\[object|https?:|wss?:/i.test(error.message)) return error.message;
  return "语音服务暂时不可用，请稍后再试";
}

export async function ensureVoiceCapability(kind: VoiceCapability): Promise<CloudConfig> {
  const identity = captureIdentity(), current = cloudState().config;
  const config = current ?? await loadCloudConfig();
  checkIdentity(identity);
  if (!voiceConfigured(kind)) throw new CloudError("语音功能暂未开放", 503, kind === "ise" ? "ise_disabled" : "voice_not_configured");
  return config;
}

const gatewayRequests = new Set<AbortController>();
const playbackStops = new Set<() => void>();
let voiceGeneration = cloudState().generation;
subscribeCloud(() => {
  if (cloudState().generation === voiceGeneration) return;
  voiceGeneration = cloudState().generation;
  gatewayRequests.forEach(controller => controller.abort());
  gatewayRequests.clear();
  playbackStops.forEach(stop => stop());
  ttsCache.clear(); ttsInflight.clear(); ttsPending.clear();
  currentCloud?.stop(); currentCloud = null;
});

async function gatewaySocket(path: string, ticketPath: string, signal: AbortSignal, params: Record<string, string> = {}): Promise<WebSocket> {
  const identity = captureIdentity();
  for (let attempt = 0; attempt < 2; attempt++) {
    checkRequest(identity, signal);
    const { baseUrl } = cloudState();
    const url = new URL(path, baseUrl), origin = new URL(baseUrl);
    if (url.origin !== origin.origin || (url.protocol !== "https:" && !(import.meta.env.DEV && url.protocol === "http:"))) throw new CloudError("服务地址不可用", 0, "voice_not_configured");
    const { ticket } = await withCancellation(cloudRequest<{ ticket: string }>(ticketPath, "POST", undefined, signal), signal);
    checkRequest(identity, signal);
    if (!ticket) throw new CloudError("连接未成功", 0, "voice_ticket_invalid");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = ""; url.hash = "";
    url.searchParams.set("ticket", ticket);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          ws.onopen = null; ws.onerror = null; ws.onclose = null;
          if (error) { ws.close(); reject(error); } else resolve();
        };
        const abort = () => finish(new DOMException("操作已取消", "AbortError"));
        const timeout = setTimeout(() => finish(new CloudError("连接超时", 0, "upstream_timeout")), 10000);
        signal.addEventListener("abort", abort, { once: true });
        ws.onopen = () => finish();
        ws.onclose = () => finish(new CloudError("连接未成功", 0, "voice_ticket_invalid"));
        ws.onerror = () => finish(new CloudError("连接未成功", 0, "voice_ticket_invalid"));
      });
      try { checkRequest(identity, signal); } catch (error) { ws.close(); throw error; }
      return ws;
    } catch (error) {
      checkRequest(identity, signal);
      if (signal.aborted || attempt > 0) throw error;
    }
  }
  throw new CloudError("连接未成功", 0, "voice_ticket_invalid");
}
function serverFrame(raw: string): { type?: string; code?: string; text?: string } {
  try { return JSON.parse(raw); } catch { throw new CloudError("服务响应无法识别", 0, "upstream_error"); }
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface AsrSession {
  push: (pcmB64: string) => void;
  finish: () => Promise<string>;
  abort: () => void;
}
export interface AsrSessionHandlers {
  onDelta: (text: string, final: boolean) => void;
  onError?: (error: unknown) => void;
}

/** Buffers only while opening; all recorded audio stays in memory. Upload errors require a new recording. */
export function createAsrSession(language: "en_us" | "zh_cn", handlers: AsrSessionHandlers): AsrSession {
  let identity: VoiceIdentity | null = null, identityError: unknown;
  try { identity = captureIdentity(); } catch (error) { identityError = error; }
  const controller = new AbortController(); gatewayRequests.add(controller);
  let socket: WebSocket | null = null, settled = false, stopWanted = false;
  let pending: Uint8Array<ArrayBuffer>[] = [], pendingBytes = 0, totalBytes = 0;
  let resolveFinal!: (text: string) => void, rejectFinal!: (error: unknown) => void;
  const final = new Promise<string>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  void final.catch(() => undefined);
  const finish = (text?: string, error?: unknown) => {
    if (settled) return;
    settled = true; pending = []; pendingBytes = 0; clearTimeout(watchdog);
    gatewayRequests.delete(controller); controller.signal.removeEventListener("abort", abort);
    socket?.close();
    if (error) { rejectFinal(error); if (!(error instanceof DOMException && error.name === "AbortError")) handlers.onError?.(error); }
    else resolveFinal(text ?? "");
  };
  const abort = () => finish(undefined, new DOMException("操作已取消", "AbortError"));
  controller.signal.addEventListener("abort", abort, { once: true });
  const watchdog = setTimeout(() => finish(undefined, new CloudError("识别超时", 0, "voice_session_too_long")), 75000);
  const send = (bytes: Uint8Array<ArrayBuffer>) => {
    if (!socket || settled) return;
    checkRequest(identity!, controller.signal);
    for (let offset = 0; offset < bytes.length; offset += 10240) socket.send(bytes.slice(offset, offset + 10240).buffer);
  };
  void (async () => {
    try {
      if (identityError) throw identityError;
      checkRequest(identity!, controller.signal);
      const config = await ensureVoiceCapability("asr");
      checkRequest(identity!, controller.signal);
      if (!config.voice.asrLanguages.includes(language)) throw new CloudError("当前语言暂未开放", 400, "voice_language_unavailable");
      if (settled) return;
      const ws = await gatewaySocket(config.gateway.voiceAsrStream, config.gateway.voiceTicket, controller.signal, { lang: language });
      socket = ws;
      checkRequest(identity!, controller.signal);
      if (settled) { ws.close(); return; }
      ws.onmessage = event => {
        if (settled || typeof event.data !== "string") return;
        try {
          checkRequest(identity!, controller.signal);
          const frame = serverFrame(event.data);
          if (frame.type === "error") finish(undefined, new CloudError("识别失败", 0, frame.code ?? "upstream_error"));
          else if ((frame.type === "interim" || frame.type === "final") && typeof frame.text === "string") {
            handlers.onDelta(frame.text, frame.type === "final");
            if (frame.type === "final") finish(frame.text);
          }
        } catch (error) { finish(undefined, error); }
      };
      ws.onclose = () => finish(undefined, new CloudError("连接已断开", 0, "voice_disconnected"));
      ws.onerror = () => finish(undefined, new CloudError("连接已断开", 0, "voice_disconnected"));
      ws.send(JSON.stringify({ type: "start" }));
      for (const bytes of pending) send(bytes);
      pending = []; pendingBytes = 0;
      if (stopWanted) ws.send(JSON.stringify({ type: "stop" }));
    } catch (error) { finish(undefined, error); }
  })();
  return {
    push: pcmB64 => {
      if (settled || stopWanted) return;
      try {
        if (identityError) throw identityError;
        checkRequest(identity!, controller.signal);
        const bytes = fromBase64(pcmB64); totalBytes += bytes.length;
        if (totalBytes > 1920000) throw new CloudError("录音过长", 0, "voice_session_too_long");
        if (socket?.readyState === WebSocket.OPEN) send(bytes);
        else {
          pendingBytes += bytes.length;
          if (pendingBytes > 64000) throw new CloudError("连接缓慢", 0, "upstream_timeout");
          pending.push(bytes);
        }
      } catch (error) { finish(undefined, error); }
    },
    finish: () => {
      if (!settled && !stopWanted) {
        stopWanted = true;
        try { checkRequest(identity!, controller.signal); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" })); }
        catch (error) { finish(undefined, error); }
      }
      return final;
    },
    abort: () => controller.abort(),
  };
}

export interface IsePhoneTS {
  content: string;
  dpMessage?: number | null;
  gwpp?: number | null;
}

export interface IseWordTS {
  content: string;
  totalScore?: number | null;
  /** 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。 */
  dpMessage: number;
  phones?: IsePhoneTS[] | null;
}

export interface IseResultTS {
  totalScore: number;
  accuracyScore: number;
  fluencyScore: number;
  standardScore: number;
  integrityScore: number;
  isRejected: boolean;
  exceptInfo?: string | null;
  /** 按文档序原样返回（着色在前端做）。 */
  words: IseWordTS[];
}

/** Server scores use the same five-point scale; flatten syllable phones for the mobile highlighter. */
export async function assessSentence(text: string, pcmB64: string): Promise<IseResultTS> {
  const identity = captureIdentity();
  await ensureVoiceCapability("ise");
  checkIdentity(identity);
  const result = await cloudRequest<{
    total: number; accuracy: number; fluency: number; standard: number; integrity?: number;
    isRejected: boolean; exceptInfo?: string | null;
    words?: { content: string; totalScore?: number; dpMessage?: number; phones?: IsePhoneTS[]; sylls?: { phones?: IsePhoneTS[] }[] }[];
  }>("/v1/voice/ise", "POST", { refText: text, lang: "en", audio: pcmB64 });
  checkIdentity(identity);
  return {
    totalScore: result.total, accuracyScore: result.accuracy, fluencyScore: result.fluency,
    standardScore: result.standard, integrityScore: result.integrity ?? 5,
    isRejected: result.isRejected, exceptInfo: result.exceptInfo,
    words: (result.words ?? []).map(word => ({ content: word.content, totalScore: word.totalScore,
      dpMessage: word.dpMessage ?? 0, phones: word.phones ?? word.sylls?.flatMap(syll => syll.phones ?? []) ?? [] })),
  };
}

export interface CloudSpeech {
  stop: () => void;
  done: Promise<void>;
}

/* ---------- 音频上下文（iOS 解锁语义） ----------
   播放：共享 AudioContext 单例；可能因在手势外创建而 suspended——audioCtx() 内
   尝试 resume，另挂一次性 pointerdown「解锁仪式」（手势外创建的 ctx WebKit 常拒绝
   后续 resume，需在手势内 start 一声静音强制激活音频管线）。
   解码：一律走 OfflineAudioContext——不依赖手势/运行态；suspended 的线上 ctx 在
   WebKit 上 decodeAudioData 会挂起不返回，预取路径会整个卡死。 */
let sharedCtx: AudioContext | null = null;
let decodeCtx: OfflineAudioContext | null = null;

function audioCtx(): AudioContext {
  setWebAudioSessionType("playback");
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume().catch(() => undefined);
  return sharedCtx;
}

/** 等共享 ctx 回 running（录音刚结束时 iOS 会把非录音 ctx 打成 interrupted，WebKit
 *  的自动恢复有竞态窗——此刻 start() 是静默排队、播放看门狗把 done「假落定」，表现为
 *  「合成成功、流程走完，但全程没声音」）。interrupted 只能等系统恢复；suspended 每轮
 *  经 audioCtx() 主动 resume；等待中解锁仪式可能重建 ctx——每轮重取当前实例。 */
async function awaitRunningCtx(maxMs: number): Promise<AudioContext> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const ctx = audioCtx();
    if (ctx.state === "running") return ctx;
    if (Date.now() >= deadline) throw new Error(`音频输出未恢复（${ctx.state}）`);
    await new Promise<void>((resolve) => {
      let settled = false;
      const fin = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ctx.removeEventListener("statechange", fin);
        } catch {
          /* 旧 WebView 无监听 API：纯轮询 */
        }
        resolve();
      };
      const timer = setTimeout(fin, 120);
      try {
        ctx.addEventListener("statechange", fin);
      } catch {
        /* 同上 */
      }
    });
  }
}

/** 解码（offline ctx，可在任意时刻调用；带超时兜底防挂死）。 */
function decode(buf: ArrayBuffer): Promise<AudioBuffer> {
  if (!decodeCtx) {
    try {
      // 长度给 4096：部分 WebKit 版本对过短的 offline 构造有兼容问题
      decodeCtx = new OfflineAudioContext(1, 4096, 48000);
    } catch {
      decodeCtx = null; // 旧 WebView 无 offline：回落共享 ctx（手势内调用才可靠）
    }
  }
  const ctx: BaseAudioContext = decodeCtx ?? audioCtx();
  return new Promise<AudioBuffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("音频解码超时")), 8000);
    ctx.decodeAudioData(buf).then(
      (audio) => {
        clearTimeout(timer);
        resolve(audio);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("音频解码失败"));
      },
    );
  });
}

/** iOS 解锁仪式（首次任意按下）：手势外创建的 AudioContext 在 iOS 上可能永远无法
   resume（v4 实测 resume 不生效仍挂起）——手势内**重建**新上下文替换之，
   并播一声静音激活管线。缓存的 AudioBuffer 与上下文无关，替换后照常可播。 */
function unlockAudioOnce(): void {
  try {
    if (!sharedCtx || sharedCtx.state === "suspended" || sharedCtx.state === "interrupted") {
      const fresh = new AudioContext();
      const dead = sharedCtx;
      sharedCtx = fresh;
      if (dead && dead.state !== "closed") void dead.close().catch(() => undefined);
      const src = fresh.createBufferSource();
      src.buffer = fresh.createBuffer(1, 1, fresh.sampleRate);
      src.connect(fresh.destination);
      src.start(0);
      if (fresh.state === "suspended") void fresh.resume().catch(() => undefined);
      return;
    }
  } catch {
    /* 仪式失败不影响后续播放路径（audioCtx() 还有 resume 兜底） */
  }
}
if (typeof window !== "undefined") {
  try {
    // 不用 once：来电/控制中心会把 ctx 打成 interrupted，任何一次点击都应能自愈重建
    window.addEventListener("pointerdown", unlockAudioOnce, true);
  } catch {
    /* 旧 WebView 无 addEventListener */
  }
}

/** Call synchronously from a user gesture before any storage/network awaits. */
export function prepareAudioPlayback(): void {
  setWebAudioSessionType("playback");
  if (typeof AudioContext === "undefined") return;
  unlockAudioOnce();
  void audioCtx();
}

export interface PlaybackSession {
  category: string;
  outputVolume: number;
  outputs: string[];
}

/** Reassert both WebKit and native playback after synthesis/storage or recording. */
export async function restorePlaybackSession(): Promise<PlaybackSession | null> {
  setWebAudioSessionType("playback");
  if (isAudioRecordingActive()) return null;
  if (!isTauri()) return null;
  const session = await invokeRaw<PlaybackSession | null>("restore_playback_audio");
  if (session) {
    reportDiag("tts", `输出会话 ${session.category} · 音量 ${session.outputVolume.toFixed(2)} · ${session.outputs.join(", ") || "无输出路由"}`);
  }
  return session;
}

/** Play a local audio buffer through the same iOS-unlocked WebAudio route as cloud TTS. */
export async function playAudioBufferData(data: ArrayBuffer): Promise<() => void> {
  prepareAudioPlayback();
  const audio = await decode(data.slice(0));
  await restorePlaybackSession();
  const ctx = await awaitRunningCtx(3000);
  if (ctx.state !== "running") throw new Error(`音频输出未恢复（${ctx.state}）`);
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  source.onended = () => source.disconnect();
  try {
    source.start();
  } catch (error) {
    source.disconnect();
    throw error;
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      source.stop();
    } catch {
      /* Already ended. */
    }
    source.disconnect();
  };
}

/** Availability reflects the signed-in account and server capabilities. */
export function cloudAvailable(): boolean { return voiceConfigured("tts"); }

const TTS_CACHE_MAX = 24;
const ttsCache = new Map<string, AudioBuffer>();
const ttsPending = new Set<string>();
interface TtsFlight { promise: Promise<AudioBuffer>; controller: AbortController; consumers: Set<symbol>; finished: boolean }
const ttsInflight = new Map<string, TtsFlight>();
const repositoryIds = new WeakMap<object, number>();
let nextRepositoryId = 0;
let synthesisQueue: Promise<unknown> = Promise.resolve();
function playbackRate(speed?: number): number { return typeof speed === "number" && Number.isFinite(speed) ? Math.max(0.5, Math.min(2, speed)) : 1; }
function cloudKey(text: string, voice?: string): string {
  const { generation, account } = cloudState();
  const repository = activeRepository();
  if (!repositoryIds.has(repository)) repositoryIds.set(repository, ++nextRepositoryId);
  return `${generation}|${account?.id ?? "guest"}|${repositoryIds.get(repository)}|${voice ?? getState().settings.ttsVoice}|${text}`;
}
function splitText(text: string): string[] {
  const encoder = new TextEncoder(), pieces: string[] = [];
  let piece = "", bytes = 0;
  for (const character of text.trim()) {
    const size = encoder.encode(character).length;
    if (bytes + size >= 8000) { pieces.push(piece); piece = ""; bytes = 0; }
    piece += character; bytes += size;
  }
  if (piece) pieces.push(piece);
  return pieces;
}
async function synthesizePiece(text: string, voice: string | undefined, config: CloudConfig, controller: AbortController): Promise<Uint8Array<ArrayBuffer>> {
  const identity = captureIdentity();
  const socket = await gatewaySocket(config.gateway.voiceTtsStream, config.gateway.voiceTicket, controller.signal);
  try { checkRequest(identity, controller.signal); } catch (error) { socket.close(); throw error; }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let byteLength = 0, settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); controller.signal.removeEventListener("abort", abort);
      socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close();
      if (error) { reject(error); return; }
      if (!byteLength) { reject(new CloudError("朗读未返回音频", 0, "upstream_error")); return; }
      const audio = new Uint8Array(byteLength); let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
      resolve(audio);
    };
    const abort = () => finish(new DOMException("操作已取消", "AbortError"));
    const timeout = setTimeout(() => finish(new CloudError("朗读超时", 0, "upstream_timeout")), 30000);
    controller.signal.addEventListener("abort", abort, { once: true });
    socket.onmessage = event => {
      if (settled) return;
      try {
        if (typeof event.data === "string") {
          const frame = serverFrame(event.data);
          if (frame.type === "end") finish();
          else if (frame.type === "error") finish(new CloudError("朗读失败", 0, frame.code ?? "upstream_error"));
        } else if (event.data instanceof ArrayBuffer) {
          byteLength += event.data.byteLength;
          if (byteLength > 32 * 1024 * 1024) finish(new CloudError("音频过大", 0, "upstream_error"));
          else chunks.push(new Uint8Array(event.data));
        }
      } catch (error) { finish(error); }
    };
    socket.onclose = () => finish(new CloudError("连接已断开", 0, "voice_disconnected"));
    socket.onerror = () => finish(new CloudError("连接已断开", 0, "voice_disconnected"));
    try { checkRequest(identity, controller.signal); socket.send(JSON.stringify({ type: "synthesis", text, ...(voice ? { voice } : {}) })); }
    catch (error) { finish(error); }
  });
}
async function synthAndDecode(text: string, requestedVoice?: string, _speed?: number, signal?: AbortSignal): Promise<AudioBuffer> {
  const identity = captureIdentity();
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  const selected = requestedVoice ?? getState().settings.ttsVoice;
  const key = cloudKey(text, selected), cached = ttsCache.get(key);
  if (cached) { ttsCache.delete(key); ttsCache.set(key, cached); return cached; }
  let flight = ttsInflight.get(key);
  if (!flight) {
    const controller = new AbortController(); gatewayRequests.add(controller);
    const current: TtsFlight = { controller, consumers: new Set(), finished: false, promise: Promise.resolve(null as unknown as AudioBuffer) };
    current.promise = synthesisQueue.catch(() => undefined).then(async () => {
      checkRequest(identity, controller.signal);
      const config = await withCancellation(ensureVoiceCapability("tts"), controller.signal);
      checkRequest(identity, controller.signal);
      const voice = config.voice.ttsVoices.some(item => item.id === selected) ? selected : undefined;
      const pieces: Uint8Array<ArrayBuffer>[] = [];
      let retried = false;
      for (const piece of splitText(text)) {
        checkRequest(identity, controller.signal);
        try { pieces.push(await synthesizePiece(piece, voice, config, controller)); }
        catch (error) {
          checkRequest(identity, controller.signal);
          if (retried || !(error instanceof CloudError) || !["upstream_error", "upstream_timeout", "voice_disconnected"].includes(error.code)) throw error;
          retried = true;
          pieces.push(await synthesizePiece(piece, voice, config, controller));
        }
        checkRequest(identity, controller.signal);
      }
      if (!pieces.length) throw new Error("请选择一段文字再试听");
      const buffers: AudioBuffer[] = [];
      for (const piece of pieces) {
        checkRequest(identity, controller.signal);
        buffers.push(await withCancellation(decode(piece.buffer), controller.signal));
        checkRequest(identity, controller.signal);
      }
      let audio = buffers[0];
      if (buffers.length > 1) {
        const ctx = decodeCtx ?? audioCtx(), channels = Math.max(...buffers.map(buffer => buffer.numberOfChannels));
        audio = ctx.createBuffer(channels, buffers.reduce((length, buffer) => length + buffer.length, 0), buffers[0].sampleRate);
        let offset = 0;
        for (const buffer of buffers) {
          for (let channel = 0; channel < channels; channel++) audio.getChannelData(channel).set(buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)), offset);
          offset += buffer.length;
        }
      }
      checkRequest(identity, controller.signal);
      ttsCache.set(key, audio);
      if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
      return audio;
    }).finally(() => {
      current.finished = true; gatewayRequests.delete(controller);
      if (ttsInflight.get(key) === current) ttsInflight.delete(key);
    });
    synthesisQueue = current.promise;
    ttsInflight.set(key, current); flight = current;
  }
  const shared = flight, consumer = Symbol(); shared.consumers.add(consumer);
  const release = () => {
    shared.consumers.delete(consumer);
    if (!shared.finished && shared.consumers.size === 0) shared.controller.abort();
  };
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { release(); reject(new DOMException("操作已取消", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal?.aborted) abort?.();
    const audio = await Promise.race([shared.promise, cancelled]);
    checkIdentity(identity);
    return audio;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    // A stopped preview must not leave work in the queue. Other active listeners
    // (including an intentional reader prefetch) may still need this synthesis.
    release();
  }
}
export function prefetchCloud(text: string, voiceName?: string, speed?: number): void {
  if (!cloudAvailable() || !text.trim()) return;
  const key = cloudKey(text, voiceName);
  if (ttsCache.has(key) || ttsPending.has(key)) return;
  ttsPending.add(key);
  void synthAndDecode(text, voiceName, speed).catch(error => reportDiag("tts", `预取失败：${voiceErrorText(error)}`)).finally(() => ttsPending.delete(key));
}

export function speakCloud(text: string, voiceName?: string, speed?: number): CloudSpeech {
  prepareAudioPlayback();
  let stopped = false;
  const controller = new AbortController();
  let src: AudioBufferSourceNode | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true; controller.abort();
    try { src?.stop(); } catch { /* Already stopped. */ }
  };
  playbackStops.add(stop);
  const done = (async () => {
    const identity = captureIdentity();
    let audio: AudioBuffer;
    try { audio = await synthAndDecode(text, voiceName, speed, controller.signal); }
    catch (error) { if (stopped) return; throw error; }
    if (stopped) return;
    checkIdentity(identity);
    await restorePlaybackSession();
    if (stopped) return;
    checkIdentity(identity);
    /* 合成是网络往返，期间共享 ctx 可能被解锁仪式重建/关闭：await 之后重取当前 ctx，
       别用合成前捕获的旧句柄——旧 ctx 挂起时 start() 静默排队、done 永不落定（治 rust-tts-2）。
       另：录音刚停就播（陪练句队）会撞上 WebKit 会话恢复竞态窗——等 ctx 回 running
       再 start，最多 3s（治「录完就播全无声」）；等待超 150ms 记诊断（头号判别信号）。 */
    const waitFrom = Date.now();
    const ctx = await awaitRunningCtx(3000);
    if (stopped) return;
    checkIdentity(identity);
    const waited = Date.now() - waitFrom;
    if (waited > 150) reportDiag("tts", `播放前等待音频上下文恢复 ${waited}ms（终态 ${ctx.state}）`);
    if (ctx.state !== "running") throw new Error(`音频输出未恢复（${ctx.state}）`);
    /* resume 是异步空窗：停止若落在这里，复查丢弃——被打断的旧朗读迟些照样出声会叠音（治 services-3） */
    if (stopped) return;
    await new Promise<void>((resolve, reject) => {
      const source = ctx.createBufferSource();
      src = source;
      source.buffer = audio;
      const rate = playbackRate(speed);
      if (source.playbackRate) source.playbackRate.value = rate;
      source.connect(ctx.destination);
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const fin = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        source.onended = null;
        if (error) reject(error);
        else resolve();
      };
      source.onended = () => fin();
      /* A lost ended event is safe to settle only while the output context stayed active. */
      timer = setTimeout(() => {
        if (ctx.state === "running") fin();
        else fin(new Error(`音频播放未结束（${ctx.state}）`));
      }, audio.duration / rate * 1000 + 2500);
      try {
        source.start();
      } catch (error) {
        fin(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!stopped) reportDiag("tts", `播放完成 · ${(audio.duration / playbackRate(speed)).toFixed(1)}s`);
  })();
  void done.then(() => playbackStops.delete(stop), () => playbackStops.delete(stop));
  return { stop, done };
}

/** Compatibility entry point: all speech uses the account gateway, with no device/provider fallback. */
let currentCloud: CloudSpeech | null = null;
export function speakWithFallback(text: string, rate = 1, onend?: () => void, _lang: "en" | "zh" = "en"): void {
  currentCloud?.stop();
  const speech = speakCloud(text, undefined, rate); currentCloud = speech;
  void speech.done.then(() => {
    if (currentCloud !== speech) return;
    currentCloud = null; onend?.();
  }).catch(error => {
    if (currentCloud !== speech) return;
    currentCloud = null; reportDiag("tts", voiceErrorText(error));
  });
}
