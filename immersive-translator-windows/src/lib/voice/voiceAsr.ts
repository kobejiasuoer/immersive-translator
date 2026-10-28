/**
 * 流式 ASR 客户端(WSS /v1/voice/asr/stream,契约 §一/§二):
 * - 上行:binary 16k/16bit/mono PCM(单帧 ≤128KB)+ text 帧 {"type":"start"|"stop"};
 * - 下行:{"type":"interim"|"final"|"error"};final 后同连接可再 start(不必重连);
 * - ticket 现调现用绝不缓存;意外断开指数退避重连——重换票→新连接→重新 start,
 *   断线期间音频内存缓冲(隐私红线:不落盘)待重连后重放;
 * - 握手失败(拿不到 open 即关)按 voice_ticket_invalid 处理:重新换票再试一次,
 *   仍失败给终局文案;error 帧按 §二 映射,不改写原始 code。
 *
 * 模块级单例:startStreamingAsr/pushAudioChunk/stopAsr 即契约 §四 的消费口,
 * 语音页同一时刻至多一路识别;closeAsrStream 供离开页面时释放连接。
 */

import { pcm16kBytes } from "./resample";
import { VoiceError, voiceErrorMessage, type VoiceErrorInfo } from "./voiceErrors";
import { buildWsUrl } from "./voiceHttp";
import {
  getVoiceRuntime,
  type WsCloseEvent,
  type WsLike,
} from "./voiceRuntime";
import { sharedTicketManager } from "./voiceTicket";

/** 协议硬上限:单帧 ≤128KB(32KB/s 口径下约 4 秒,正常分帧远低于此)。 */
const MAX_FRAME_BYTES = 128 * 1024;
/** 意外断开重连:1s 起步 ×2,封顶 15s;重试 6 次(累计约 45s)后给终局文案。 */
export const ASR_RECONNECT_BASE_MS = 1000;
export const ASR_RECONNECT_MAX_MS = 15000;
export const ASR_MAX_RECONNECTS = 6;
/** 断线期间音频缓冲上限:60s 会话的 PCM(32KB/s),超出丢最旧的(内存上限防呆)。 */
const MAX_PENDING_BYTES = 60 * 32_000;

export function asrBackoffMs(attempt: number): number {
  return Math.min(ASR_RECONNECT_BASE_MS * 2 ** attempt, ASR_RECONNECT_MAX_MS);
}

/** 单测注入口:替换退避曲线(缺省 asrBackoffMs)。 */
let testBackoffMs: ((attempt: number) => number) | null = null;

export function setAsrBackoffForTests(fn: ((attempt: number) => number) | null): void {
  testBackoffMs = fn;
}

export type VoiceAsrLang = "en_us" | "zh_cn";

export interface AsrCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string, durationMs: number | null) => void;
  onError: (err: VoiceError) => void;
  /** 瞬时状态(换票重试/断线重连中),UI 展示 voiceErrorMessage 的「正在重试」文案。 */
  onStatus?: (info: VoiceErrorInfo) => void;
}

/** 测试注入口(缺省走运行时依赖)。 */
export interface AsrDeps {
  wsFactory?: (url: string) => WsLike;
  acquireTicket?: () => Promise<string>;
  backoffMs?: (attempt: number) => number;
}

type AsrState = "idle" | "connecting" | "open" | "closed";

interface AsrServerFrame {
  type?: unknown;
  text?: unknown;
  durationMs?: unknown;
  code?: unknown;
}

export class AsrStreamSession {
  private readonly lang: VoiceAsrLang;
  private readonly cb: AsrCallbacks;
  private readonly deps: Required<AsrDeps>;
  private ws: WsLike | null = null;
  private state: AsrState = "idle";
  /** 本次连接是否完成过 open(区分握手失败与中途断开)。 */
  private wsOpenedOnce = false;
  /** start 已发、未收 final/error。 */
  private utterance = false;
  /** 开连后要发 start(连接建立期间的 start 请求挂起)。 */
  private startWanted = false;
  /** stop 已请求但 start 还没落地(开连后 start→立即 stop,服务端排队语义)。 */
  private stopWanted = false;
  /** 断线/未开连期间缓冲的音频(仅内存)。 */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** 握手失败已换票重试过一次(契约:再试一次,仍失败终局)。 */
  private ticketRetried = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  constructor(lang: VoiceAsrLang, cb: AsrCallbacks, deps: AsrDeps = {}) {
    this.lang = lang;
    this.cb = cb;
    const runtime = getVoiceRuntime();
    this.deps = {
      wsFactory: deps.wsFactory ?? runtime.wsFactory,
      acquireTicket: deps.acquireTicket ?? (() => sharedTicketManager().acquire()),
      backoffMs: deps.backoffMs ?? testBackoffMs ?? asrBackoffMs,
    };
  }

  // ---------- 对外:开始/推音频/停止/释放 ----------

  /** 供模块单例判断:同 lang 且会话未终态时可复用现有连接续会话。 */
  canResume(lang: VoiceAsrLang): boolean {
    return this.lang === lang && this.state !== "closed";
  }

  /** 开始一轮识别:已有健康连接则同连接再 start(final 后续会话),否则换票建连。 */
  requestStart(): void {
    if (this.state === "closed") return;
    if (this.utterance) return; // 一轮进行中:幂等拦截(服务端对重复 start 回 voice_invalid_state)
    this.startWanted = true;
    if (this.state === "idle") void this.connect();
    else if (this.state === "open") this.beginUtterance();
    // connecting:开连(onopen)后统一 beginUtterance
  }

  /** 推一段设备音频(Float32 + 采样率),内部重采样 16k/16bit 再上行。 */
  pushAudio(pcm: Float32Array, sampleRate: number): void {
    if (this.state === "closed" || pcm.length === 0 || !(sampleRate > 0)) return;
    const bytes = pcm16kBytes(pcm, sampleRate);
    if (this.utterance && this.ws !== null && this.ws.readyState === 1) {
      this.sendAudioFrames(bytes);
      return;
    }
    if (this.utterance || this.startWanted) this.bufferAudio(bytes);
    // 无 start 请求却推音频:忽略(消费方契约是先 start 后推)。
  }

  /** 结束当前一轮:发 stop 等 final;没有进行中的一轮则直接释放连接。 */
  requestStop(): void {
    if (this.state === "closed") return;
    if (this.utterance) {
      this.stopWanted = true;
      if (this.ws !== null && this.ws.readyState === 1) this.sendStop();
      return;
    }
    this.close();
  }

  /** 释放会话与连接(离开语音页时调用;终态,不可复用)。 */
  close(): void {
    if (this.state === "closed") return;
    this.closedByUs = true;
    this.state = "closed";
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.ws?.close(1000, "client-close");
    } catch {
      /* 已关闭 */
    }
    this.ws = null;
  }

  // ---------- 内部:建连 / 帧收发 / 重连 ----------

  /** 异步边界后的终态检查(state 在闭包/await 间可被回调改写,不能靠字面量窄化)。 */
  private isClosed(): boolean {
    return this.state === "closed";
  }

  private async connect(): Promise<void> {
    if (this.isClosed()) return;
    this.state = "connecting";
    this.wsOpenedOnce = false;
    let ws: WsLike;
    try {
      // 现调现用:拿票到建连之间只有 URL 拼装(契约红线)。
      const ticket = await this.deps.acquireTicket();
      if (this.isClosed()) return;
      const url = await buildWsUrl("/v1/voice/asr/stream", { ticket, lang: this.lang });
      ws = this.deps.wsFactory(url);
    } catch (err) {
      this.onConnectFailure(err);
      return;
    }
    this.attach(ws);
  }

  private attach(ws: WsLike): void {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.state === "closed") {
        try {
          ws.close(1000, "");
        } catch {
          /* 已关闭 */
        }
        return;
      }
      this.wsOpenedOnce = true;
      this.ticketRetried = false;
      this.state = "open";
      // 全新 start 请求,或断线重连后正在进行的会话(重新 start + 重放缓冲)。
      if (this.startWanted || this.utterance) this.beginUtterance();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onServerFrame(ev.data);
      // ASR 下行无 binary 帧,防御性忽略。
    };
    ws.onclose = (ev) => this.onWsClose(ev);
    ws.onerror = () => {
      /* 原因在随后的 onclose,不在 onError 里给 */
    };
  }

  private beginUtterance(): void {
    const ws = this.ws;
    if (ws === null || this.state !== "open") return;
    this.startWanted = false;
    this.utterance = true;
    ws.send(JSON.stringify({ type: "start" }));
    const buffered = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const bytes of buffered) this.sendAudioFrames(bytes);
    if (this.stopWanted) this.sendStop();
  }

  /** 发 stop 帧;stopWanted 保持到 final/error 才清,断线重连后据此补发。 */
  private sendStop(): void {
    const ws = this.ws;
    if (ws === null) return;
    ws.send(JSON.stringify({ type: "stop" }));
  }

  private sendAudioFrames(bytes: Uint8Array): void {
    const ws = this.ws;
    if (ws === null) return;
    if (bytes.byteLength <= MAX_FRAME_BYTES) {
      ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return;
    }
    // 超过硬上限的外部大块:切帧(正常 4096 样本块远低于此,防御外部调用)。
    for (let off = 0; off < bytes.byteLength; off += MAX_FRAME_BYTES) {
      const end = Math.min(off + MAX_FRAME_BYTES, bytes.byteLength);
      ws.send(bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + end) as ArrayBuffer);
    }
  }

  private bufferAudio(bytes: Uint8Array): void {
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped?.byteLength ?? 0;
    }
  }

  private onServerFrame(raw: string): void {
    let frame: AsrServerFrame;
    try {
      frame = JSON.parse(raw) as AsrServerFrame;
    } catch {
      return; // 非 JSON 文本帧,防御性忽略
    }
    if (frame.type === "interim" && typeof frame.text === "string") {
      // 服务端真实出结果:链路是工作的,重连退避清零。
      this.reconnectAttempt = 0;
      this.cb.onInterim(frame.text);
      return;
    }
    if (frame.type === "final" && typeof frame.text === "string") {
      this.reconnectAttempt = 0;
      this.utterance = false;
      this.stopWanted = false;
      const durationMs = typeof frame.durationMs === "number" ? frame.durationMs : null;
      this.cb.onFinal(frame.text, durationMs);
      return;
    }
    if (frame.type === "error" && typeof frame.code === "string") {
      this.onServerErrorFrame(frame.code, frame);
    }
  }

  /** error 帧:会话终结(utterance 复位),连接一般仍可用(服务端不断开)。 */
  private onServerErrorFrame(code: string, frame: AsrServerFrame): void {
    this.utterance = false;
    this.stopWanted = false;
    const details =
      typeof frame === "object" && (frame as { details?: unknown }).details !== undefined
        ? ((frame as { details?: unknown }).details as Record<string, unknown>)
        : {};
    this.cb.onError(new VoiceError(code, { details }));
  }

  private onWsClose(_ev: WsCloseEvent): void {
    this.ws = null;
    if (this.state === "closed" || this.closedByUs) return;
    if (!this.wsOpenedOnce) {
      // 握手失败(票无效/过期/被用):换票立即再试一次,仍失败终局(§二)。
      if (this.ticketRetried) {
        this.failTerminal("voice_ticket_invalid");
        return;
      }
      this.ticketRetried = true;
      this.cb.onStatus?.(voiceErrorMessage("voice_ticket_invalid"));
      void this.connect();
      return;
    }
    // 意外断开(1006 等):指数退避,重换票→新连接→重新 start(§二)。
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === "closed") return;
    this.state = "idle";
    if (this.reconnectAttempt >= ASR_MAX_RECONNECTS) {
      this.failTerminal("voice_disconnected");
      return;
    }
    const delay = this.deps.backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.cb.onStatus?.(voiceErrorMessage("voice_disconnected"));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** 建连/取票失败:鉴权类终局,其余(网络/限流)并入退避重连。 */
  private onConnectFailure(err: unknown): void {
    if (this.state === "closed") return;
    const code = err instanceof VoiceError ? err.code : "network_error";
    if (code === "token_invalid" || code === "token_reused" || code === "unauthorized" || code === "banned" || code === "quota_exceeded" || code === "voice_not_configured") {
      this.state = "closed";
      this.closedByUs = true;
      this.cb.onError(err instanceof VoiceError ? err : new VoiceError(code));
      return;
    }
    this.state = "idle";
    this.scheduleReconnect();
  }

  /** 终局:给错误并进入 closed(调用方需重新 startStreamingAsr)。 */
  private failTerminal(code: string): void {
    this.state = "closed";
    this.closedByUs = true;
    this.cb.onError(new VoiceError(code));
  }
}

// ---------------------------------------------------------------------------
// 模块级消费口(契约 §四:startStreamingAsr / pushAudioChunk / stopAsr)
// ---------------------------------------------------------------------------

let session: AsrStreamSession | null = null;

/**
 * 开始(或续)一轮流式识别。同一 lang 且连接健康时复用现有连接(final 后续会话);
 * 换 lang 或连接已死时重建。识别进行中重复调用为幂等 no-op(服务端对重复 start
 * 回 voice_invalid_state,客户端状态机先行拦下)。
 */
export function startStreamingAsr(
  lang: VoiceAsrLang,
  onInterim: (text: string) => void,
  onFinal: (text: string, durationMs: number | null) => void,
  onError: (err: VoiceError) => void,
  onStatus?: (info: VoiceErrorInfo) => void,
): void {
  if (session !== null && session.canResume(lang)) {
    session.requestStart();
    return;
  }
  session?.close();
  session = new AsrStreamSession(lang, { onInterim, onFinal, onError, onStatus });
  session.requestStart();
}

/** 推送设备音频(Float32 + 设备采样率,如 44100/48000)。未在识别中则忽略。 */
export function pushAudioChunk(pcm: Float32Array, sampleRate = 16000): void {
  session?.pushAudio(pcm, sampleRate);
}

/** 结束当前一轮(等 final);没有进行中的一轮则释放连接。 */
export function stopAsr(): void {
  session?.requestStop();
}

/** 释放连接与单例(离开语音页)。 */
export function closeAsrStream(): void {
  session?.close();
  session = null;
}

/** 单测隔离用。 */
export function resetAsrForTests(): void {
  session?.close();
  session = null;
}
