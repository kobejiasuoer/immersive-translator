/**
 * 语音网关运行时依赖(可注入):鉴权 HTTP 通道 / WebSocket 工厂 / 网关 base URL。
 *
 * 鉴权边界(硬约束):本应用的 access/refresh 令牌永不跨 IPC,存取与「串行单飞
 * 刷新 + 401 重放」全部在 Rust(auth.rs TokenManager.with_auth)。语音 REST 因此
 * 不自行 fetch+Bearer,而是挂在 VoiceHttpTransport 之后——生产实现是随语音批次
 * 新增的 Rust 命令(与 sync_pull/discover 同构,复用同一 with_auth 通道),由
 * 应用启动时 setVoiceRuntime 接线;客户端 JS 侧绝不另写刷新逻辑。
 *
 * WSS 无自定义头,握手用一次性 ticket(voiceTicket.ts),连接本身用浏览器原生
 * WebSocket——wsFactory 可注入供单测替换。
 */

import { authServerBaseUrl } from "../tauriBridge";

/** 一次鉴权 HTTP 的原始应答(形状同 SyncHttpText + 响应头白名单)。 */
export interface VoiceHttpResponse {
  status: number;
  body: string;
  /** 429 的 retry-after 秒数(Rust 透传),无则 null。 */
  retryAfterSeconds: number | null;
  /** 需要透传的响应头(如 402 的 x-quota-<resource>-remaining);缺失为空对象。 */
  headers: Record<string, string>;
}

/** method+path+JSON body 进、原始应答出;401 刷新/重放在 Rust 通道内完成。 */
export type VoiceHttpTransport = (
  method: "GET" | "POST",
  path: string,
  bodyJson: string | undefined,
) => Promise<VoiceHttpResponse>;

/** 结构化最小 WS 接口(真实 WebSocket 结构兼容;测试注入替身)。 */
export interface WsFrame {
  data: unknown;
}

export interface WsCloseEvent {
  code: number;
  reason: string;
}

export interface WsLike {
  binaryType: "blob" | "arraybuffer";
  onopen: (() => void) | null;
  onmessage: ((ev: WsFrame) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export type WsFactory = (url: string) => WsLike;

/** 网关 base URL 来源(默认 authServerBaseUrl;官方云未开放返回 null)。 */
export type VoiceBaseUrlSource = () => Promise<string | null>;

interface VoiceRuntime {
  http: VoiceHttpTransport | null;
  wsFactory: WsFactory;
  baseUrlSource: VoiceBaseUrlSource;
}

const defaultRuntime: VoiceRuntime = {
  http: null,
  // 事件 handler 参数形状与最小接口不同(真实 WS 带 Event/MessageEvent),运行时无差。
  wsFactory: (url) => new WebSocket(url) as unknown as WsLike,
  baseUrlSource: () => authServerBaseUrl(),
};

let runtime: VoiceRuntime = { ...defaultRuntime };

/** 应用启动时接线生产实现(未接线前 REST/换票调用会抛编程错误)。 */
export function setVoiceRuntime(patch: Partial<VoiceRuntime>): void {
  runtime = { ...runtime, ...patch };
}

/** 恢复默认(单测隔离 / 窗口重建)。 */
export function resetVoiceRuntime(): void {
  runtime = { ...defaultRuntime };
}

export function getVoiceRuntime(): VoiceRuntime {
  return runtime;
}
