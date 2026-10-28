/**
 * 流式 TTS 客户端(WSS /v1/voice/tts/stream,契约 §一/§四):
 * - 上行只有 text 帧 {"type":"synthesis","text","voice"?,"volume"?}(绝不发 binary);
 * - 下行 binary mp3 分片(按序交给 onChunk)+ {"type":"end"} / error 帧;
 * - 文本 UTF-8 字节超限自动按句拆分(ttsTextSplit),片内逐片顺序合成;
 * - 同连接多次 synthesis 按序不并发(模块级串行队列);error 帧后连接不断可继续;
 * - 上游类失败(upstream_error/upstream_timeout/断连)重试 1 次,仍失败终局(§二);
 *   REST 录音上传则相反——失败不自动重试(voiceRest.ts,录音是隐私)。
 * - ticket 现调现用;连接空闲由服务端心跳回收,下次合成 readyState 检测后自动换票重连。
 */

import { splitTtsText } from "./ttsTextSplit";
import { VoiceError } from "./voiceErrors";
import { buildWsUrl } from "./voiceHttp";
import { getVoiceRuntime, type WsLike, type WsFactory } from "./voiceRuntime";
import { sharedTicketManager } from "./voiceTicket";

/** 单片合成看门狗:服务端上游超时约在数十秒量级,客户端 30s 无 end 视为 upstream_timeout。 */
export const TTS_PIECE_TIMEOUT_MS = 30_000;

export type TtsChunkHandler = (chunk: ArrayBuffer) => void;

/** 测试注入口(缺省走运行时依赖;timeoutMs 供单测缩短看门狗)。 */
export interface TtsDeps {
  wsFactory?: (url: string) => WsLike;
  acquireTicket?: () => Promise<string>;
  timeoutMs?: number;
}

interface TtsServerFrame {
  type?: unknown;
  code?: unknown;
  details?: unknown;
}

/** 等握手完成;握手被拒(票无效/已用)报 voice_ticket_invalid。 */
function waitOpen(ws: WsLike): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onclose = () => reject(new VoiceError("voice_ticket_invalid"));
    ws.onerror = () => {
      /* 原因在 onclose */
    };
  });
}

class TtsConnection {
  private ws: WsLike | null = null;
  private opening: Promise<WsLike> | null = null;
  private readonly wsFactory: WsFactory;
  private readonly acquireTicket: () => Promise<string>;

  constructor(deps: TtsDeps = {}) {
    const runtime = getVoiceRuntime();
    this.wsFactory = deps.wsFactory ?? runtime.wsFactory;
    this.acquireTicket = deps.acquireTicket ?? (() => sharedTicketManager().acquire());
  }

  /** 取可用连接:健康则复用(多次 synthesis 按序),否则换票新建(并发建连单飞)。 */
  async acquire(): Promise<WsLike> {
    if (this.ws !== null && this.ws.readyState === 1) return this.ws;
    if (this.opening !== null) return this.opening;
    this.opening = (async () => {
      // 现调现用:拿票到建连之间不插长耗时操作(契约红线)。
      const ticket = await this.acquireTicket();
      const url = await buildWsUrl("/v1/voice/tts/stream", { ticket });
      const ws = this.wsFactory(url);
      ws.binaryType = "arraybuffer";
      await waitOpen(ws);
      this.ws = ws;
      return ws;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** 丢弃当前连接(重试前调用;下次 acquire 自动换票重建)。 */
  drop(): void {
    try {
      this.ws?.close(1000, "retry");
    } catch {
      /* 已关闭 */
    }
    this.ws = null;
  }
}

/**
 * 一片合成:发 synthesis 帧 → 收 binary 交给 onChunk → end 结算。
 * error 帧 / 断连 / 看门狗超时都 reject(VoiceError)。
 */
function runPiece(
  ws: WsLike,
  piece: string,
  voice: string | undefined,
  volume: number | undefined,
  onChunk: TtsChunkHandler,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: VoiceError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      ws.onmessage = null;
      ws.onclose = null;
      if (err !== undefined) reject(err);
      else resolve();
    };
    const watchdog = setTimeout(() => finish(new VoiceError("upstream_timeout")), timeoutMs);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let frame: TtsServerFrame;
        try {
          frame = JSON.parse(ev.data) as TtsServerFrame;
        } catch {
          return; // 非 JSON,防御性忽略
        }
        if (frame.type === "end") {
          finish();
        } else if (frame.type === "error" && typeof frame.code === "string") {
          const details =
            typeof frame.details === "object" && frame.details !== null
              ? (frame.details as Record<string, unknown>)
              : {};
          finish(new VoiceError(frame.code, { details }));
        }
        return;
      }
      if (ev.data instanceof ArrayBuffer) onChunk(ev.data);
    };
    ws.onclose = () => finish(new VoiceError("voice_disconnected"));
    // 上行帧:voice/volume 缺省不发(服务端回落管理台配置)。
    const payload: Record<string, unknown> = { type: "synthesis", text: piece };
    if (typeof voice === "string" && voice !== "") payload["voice"] = voice;
    if (typeof volume === "number" && Number.isFinite(volume)) payload["volume"] = volume;
    ws.send(JSON.stringify(payload));
  });
}

/** 可重试一次的上游类失败(§二:重试 1 次,仍失败「请稍后再试」)。 */
function isRetryableTtsCode(code: string): boolean {
  return (
    code === "upstream_error" ||
    code === "upstream_timeout" ||
    code === "voice_disconnected" ||
    code === "voice_ticket_invalid" ||
    code === "network_error"
  );
}

let connection: TtsConnection | null = null;
let chain: Promise<void> = Promise.resolve();

/**
 * 合成一段文本(模块级串行:前一次未结束则排队)。mp3 分片经 onChunk 按序回调,
 * 全部片段完成回调 onEnd(一次);失败回调 onError(一次),已播分片不回滚。
 */
export function synthesize(
  text: string,
  voice: string | undefined,
  volume: number | undefined,
  onChunk: TtsChunkHandler,
  onEnd: () => void,
  onError: (err: VoiceError) => void,
  deps?: TtsDeps,
): void {
  // 连接是模块级单例;deps 仅在首次创建时生效(单测注入 wsFactory/timeoutMs)。
  connection ??= new TtsConnection(deps);
  const conn = connection;
  chain = chain
    .then(() => runSynthesis(conn, text, voice, volume, onChunk, onEnd, deps?.timeoutMs))
    .catch((err: unknown) => {
      onError(
        err instanceof VoiceError
          ? err
          : new VoiceError("network_error", { message: err instanceof Error ? err.message : String(err) }),
      );
    });
}

async function runSynthesis(
  conn: TtsConnection,
  text: string,
  voice: string | undefined,
  volume: number | undefined,
  onChunk: TtsChunkHandler,
  onEnd: () => void,
  depsTimeoutMs?: number,
): Promise<void> {
  const pieces = splitTtsText(text);
  if (pieces.length === 0) {
    onEnd();
    return;
  }
  const timeoutMs = typeof depsTimeoutMs === "number" && depsTimeoutMs > 0 ? depsTimeoutMs : TTS_PIECE_TIMEOUT_MS;
  let ws = await conn.acquire();
  let retried = false;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]!;
    try {
      await runPiece(ws, piece, voice, volume, onChunk, timeoutMs);
    } catch (err) {
      const code = err instanceof VoiceError ? err.code : "network_error";
      if (!isRetryableTtsCode(code) || retried) throw err;
      // 重试 1 次:丢弃连接换票重建,重发当前片;片内已收的分片不重放(防重复播放)。
      retried = true;
      conn.drop();
      ws = await conn.acquire();
      i -= 1;
    }
  }
  onEnd();
}

/** 单测隔离用。 */
export function resetTtsForTests(): void {
  connection = null;
  chain = Promise.resolve();
}
