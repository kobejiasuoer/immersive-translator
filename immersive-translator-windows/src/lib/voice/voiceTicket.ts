/**
 * WSS 一次性 ticket 管理器(契约 §一):
 * - ticket 60 秒有效、只能用一次、限流 30/分钟;
 * - 每次建连(含重连)前现调现用,绝不缓存复用——一张票只发给一个建连方;
 * - 单飞变体:同一时刻至多一张票的 HTTP 请求在途,并发建连排队各领各的新票。
 *   (经典 single-flight 是「共享同一结果」,对一次性票据是错的——两个连接共用
 *   一张票必有一个握手 401;这里保住「防请求风暴」的内核,结果不共享。)
 * - 拿票到握手之间不插长耗时操作:acquire 返回即用,不做预取/续期。
 */

import { VoiceError } from "./voiceErrors";
import { requireOkJson, voiceRequest } from "./voiceHttp";

export interface VoiceTicketIssued {
  ticket: string;
  /** 过期时刻(毫秒);仅信息展示,本管理器不缓存所以不据此调度。 */
  expiresAtMs: number;
}

export type TicketFetcher = () => Promise<VoiceTicketIssued>;

export interface TicketManager {
  /** 取一张未用过的新票;并发调用串行取票,失败向各调用方各自抛出。 */
  acquire(): Promise<string>;
}

export function createTicketManager(fetcher: TicketFetcher): TicketManager {
  // 串行链:每次 acquire 排在前一张票请求完成之后(成功失败都放行后续,不毒化队列)。
  let chain: Promise<unknown> = Promise.resolve();
  return {
    acquire(): Promise<string> {
      const run = chain.then(
        () => fetcher().then((issued) => issued.ticket),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** POST /v1/voice/ticket(鉴权 HTTP;401 刷新/重放在 Rust 通道内完成)。 */
export async function fetchVoiceTicket(): Promise<VoiceTicketIssued> {
  const res = await voiceRequest("POST", "/v1/voice/ticket");
  const body = requireOkJson(res);
  const ticket = body["ticket"];
  if (typeof ticket !== "string" || ticket === "") {
    throw new VoiceError("unknown", { message: "换票响应缺少 ticket" });
  }
  const expiresAtRaw = body["expiresAt"];
  const expiresAtMs =
    typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : NaN;
  return { ticket, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
}

let shared: TicketManager | null = null;

/** 生产用共享管理器(ASR/TTS 建连共用,单飞排队全局生效)。 */
export function sharedTicketManager(): TicketManager {
  if (shared === null) shared = createTicketManager(fetchVoiceTicket);
  return shared;
}

/** 单测隔离用。 */
export function resetSharedTicketManagerForTests(): void {
  shared = null;
}
