import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const auth = vi.hoisted(() => ({ status: vi.fn(), listen: vi.fn() }));
vi.mock("../tauriBridge", () => ({ authGetStatus: auth.status, listenAuthStateChanged: auth.listen, authServerBaseUrl: vi.fn() }));

import { VoiceError, voiceErrorMessage } from "./voiceErrors";
import { resetTtsForTests, synthesize, TTS_PIECE_TIMEOUT_MS, type TtsDeps } from "./voiceTts";
import { resetSharedTicketManagerForTests } from "./voiceTicket";
import { resetVoiceRuntime, setVoiceRuntime, type WsLike, type VoiceHttpResponse } from "./voiceRuntime";
import type { AuthStatus } from "../tauriBridge";

class FakeWs {
  static instances: FakeWs[] = [];
  static reset(): void {
    FakeWs.instances = [];
  }

  url: string;
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: (string | ArrayBuffer)[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverText(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  serverBinary(bytes: Uint8Array): void {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.onmessage?.({ data: buffer });
  }

  textFrames(): string[] {
    return this.sent.filter((d): d is string => typeof d === "string");
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const lastOf = <T>(items: T[]): T => items[items.length - 1]!;
let account: string | null;
let authListener: ((status: AuthStatus) => void) | null;
function statusOf(identity: string | null): AuthStatus {
  return { loggedIn: identity !== null, user: identity === null ? null : {
    id: identity, email: `${identity}@example.test`, nickname: null, plan: "free", createdAt: "2026-11-03T00:00:00Z",
  }, notice: null };
}

function queueProduction(text: string, h: Harness): void {
  synthesize(text, undefined, undefined, chunk => h.chunks.push(chunk), () => { h.ended += 1; }, error => h.errors.push(error));
}

async function beginProduction(text: string, h: Harness): Promise<FakeWs> {
  queueProduction(text, h);
  await settle();
  const ws = lastOf(FakeWs.instances);
  ws.open();
  await settle();
  return ws;
}

interface Harness {
  tickets: string[];
  chunks: ArrayBuffer[];
  ended: number;
  errors: VoiceError[];
}

function harness(): Harness {
  const h: Harness = { tickets: [], chunks: [], ended: 0, errors: [] };
  let nextTicket = 1;
  setVoiceRuntime({
    wsFactory: (url) => new FakeWs(url) as unknown as WsLike,
    baseUrlSource: async () => "https://gw.test",
    http: async (method, path): Promise<VoiceHttpResponse> => {
      if (method === "POST" && path === "/v1/voice/ticket") {
        const ticket = `t${nextTicket}`;
        nextTicket += 1;
        h.tickets.push(ticket);
        return { status: 200, body: JSON.stringify({ ticket, expiresAt: "2026-10-28T00:01:00.000Z" }), retryAfterSeconds: null, headers: {} };
      }
      return { status: 404, body: "{}", retryAfterSeconds: null, headers: {} };
    },
  });
  return h;
}

/** 发起合成 → 连接建立并 open → 等首片 synthesis 帧发出。 */
async function beginSynth(text: string, h: Harness, deps: TtsDeps = { timeoutMs: 200 }): Promise<FakeWs> {
  synthesize(
    text,
    undefined,
    undefined,
    (chunk) => h.chunks.push(chunk),
    () => {
      h.ended += 1;
    },
    (err) => h.errors.push(err),
    deps,
  );
  await settle();
  const ws = lastOf(FakeWs.instances);
  ws.open();
  await settle();
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeWs.reset();
  resetTtsForTests();
  resetSharedTicketManagerForTests();
  resetVoiceRuntime();
  account = "account-a";
  authListener = null;
  auth.status.mockImplementation(async () => statusOf(account));
  auth.listen.mockImplementation(async (handler: (status: AuthStatus) => void) => {
    authListener = handler;
    return () => undefined;
  });
});
afterEach(() => resetTtsForTests());

describe("synthesize(契约 §四:mp3 分片回调、>8000 字节自动按句拆分)", () => {
  it("短文本:换票建连 → synthesis 帧(缺省 voice/volume 不上行)→ binary 回调 → end → onEnd 一次", async () => {
    const h = harness();
    const ws = await beginSynth("Hello cloud", h);
    expect(h.tickets).toEqual(["t1"]);
    expect(ws.url).toBe("wss://gw.test/v1/voice/tts/stream?ticket=t1");
    expect(ws.textFrames()).toEqual([JSON.stringify({ type: "synthesis", text: "Hello cloud" })]);
    ws.serverBinary(new Uint8Array([0xff, 0xf3, 0x40, 0x00]));
    ws.serverText({ type: "end" });
    await settle();
    expect(h.chunks).toHaveLength(1);
    expect(new Uint8Array(h.chunks[0]!)).toEqual(new Uint8Array([0xff, 0xf3, 0x40, 0x00]));
    expect(h.ended).toBe(1);
    expect(h.errors).toHaveLength(0);
  });

  it("voice/volume 提供时随帧上行", async () => {
    const h = harness();
    synthesize("Hi", "alvin", 80, () => undefined, () => {
      h.ended += 1;
    }, () => undefined, { timeoutMs: 200 });
    await settle();
    const ws = lastOf(FakeWs.instances);
    ws.open();
    await settle();
    expect(ws.textFrames()).toEqual([JSON.stringify({ type: "synthesis", text: "Hi", voice: "alvin", volume: 80 })]);
    // 收尾:让串行链干净结束,不留跨用例的看门狗定时器。
    ws.serverText({ type: "end" });
    await settle();
  });

  it("超长文本按句拆分:片序上行,前片 end 后才发下一片,onEnd 恰一次", async () => {
    const h = harness();
    const sentenceA = `${"a".repeat(4000)}. `; // 4002 字节
    const sentenceB = `${"b".repeat(4000)}.`; // 4001 字节
    const ws = await beginSynth(sentenceA + sentenceB, h);
    expect(ws.textFrames()).toHaveLength(1); // 只发了第一片
    ws.serverText({ type: "end" });
    await settle();
    expect(ws.textFrames()).toHaveLength(2); // 第二片同连接按序发出
    expect(ws.textFrames()[1]).toContain("b");
    ws.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(1);
    expect(h.errors).toHaveLength(0);
    expect(FakeWs.instances).toHaveLength(1); // 全程同一连接
  });

  it("error 帧 quota_exceeded(tts_chars)→ onError 带功能名文案,不重试", async () => {
    const h = harness();
    const ws = await beginSynth("你好", h);
    ws.serverText({ type: "error", code: "quota_exceeded", details: { resource: "tts_chars" } });
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(voiceErrorMessage(h.errors[0]!).text).toBe("本月朗读额度已用完");
    expect(h.ended).toBe(0);
    expect(ws.textFrames()).toHaveLength(1); // 未重发
  });

  it("upstream_error 重试 1 次:换票重建连接重发;第二次成功则 onEnd", async () => {
    const h = harness();
    const ws = await beginSynth("Hello", h);
    ws.serverText({ type: "error", code: "upstream_error" });
    await settle();
    expect(FakeWs.instances).toHaveLength(2); // 旧连接已丢弃,新连接建立
    expect(h.tickets).toEqual(["t1", "t2"]);
    const second = lastOf(FakeWs.instances);
    second.open();
    await settle();
    expect(second.textFrames()).toEqual([JSON.stringify({ type: "synthesis", text: "Hello" })]);
    second.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(1);
    expect(h.errors).toHaveLength(0);
  });

  it("upstream_error 重试后仍失败:onError 终局「请稍后再试」", async () => {
    const h = harness();
    const ws = await beginSynth("Hello", h);
    ws.serverText({ type: "error", code: "upstream_timeout" });
    await settle();
    const second = lastOf(FakeWs.instances);
    second.open();
    await settle();
    second.serverText({ type: "error", code: "upstream_timeout" });
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(voiceErrorMessage(h.errors[0]!, { final: true }).text).toBe("请稍后再试");
    expect(h.ended).toBe(0);
  });

  it("第二片断连 → 重试 1 次:已 end 的片不重放,剩余片在新连接重发", async () => {
    const h = harness();
    const sentence = `${"word ".repeat(800)}. `; // 4005 字节
    const ws = await beginSynth(sentence + sentence, h);
    ws.serverBinary(new Uint8Array([1, 2, 3]));
    ws.serverText({ type: "end" }); // 第一片完成
    await settle();
    expect(FakeWs.instances).toHaveLength(1);
    // 第二片进行中断连
    FakeWs.instances[0]!.onclose?.({ code: 1006, reason: "" });
    await settle();
    const second = lastOf(FakeWs.instances);
    second.open();
    await settle();
    // 只重发第二片(第一片不重放)
    expect(second.textFrames()).toHaveLength(1);
    expect(second.textFrames()[0]).toBe(lastOf(ws.textFrames()));
    second.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(1);
    expect(h.chunks).toHaveLength(1); // 已播分片不重复回调
  });

  it(`看门狗:单片 ${TTS_PIECE_TIMEOUT_MS}ms 注入 200ms 无 end → upstream_timeout 并重试一次`, async () => {
    const h = harness();
    await beginSynth("Hello", h);
    await new Promise((r) => setTimeout(r, 260)); // 第一片看门狗到点
    expect(FakeWs.instances).toHaveLength(2); // 已换票重试
    lastOf(FakeWs.instances).open();
    await new Promise((r) => setTimeout(r, 300)); // 第二片看门狗到点
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe("upstream_timeout");
    expect(h.ended).toBe(0);
  });

  it("排队:前一次合成未结束,下一次在同一连接按序执行", async () => {
    const h = harness();
    const ws = await beginSynth("first", h);
    synthesize(
      "second",
      undefined,
      undefined,
      (chunk) => h.chunks.push(chunk),
      () => {
        h.ended += 1;
      },
      (err) => h.errors.push(err),
      { timeoutMs: 200 },
    );
    await settle();
    expect(ws.textFrames()).toEqual([JSON.stringify({ type: "synthesis", text: "first" })]);
    ws.serverText({ type: "end" });
    await settle();
    expect(ws.textFrames()).toEqual([
      JSON.stringify({ type: "synthesis", text: "first" }),
      JSON.stringify({ type: "synthesis", text: "second" }),
    ]);
    ws.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(2);
    expect(FakeWs.instances).toHaveLength(1); // 连接复用,不再换票
    expect(h.tickets).toEqual(["t1"]);
  });

  it("空/纯空白文本:直接 onEnd,不建连不换票", async () => {
    const h = harness();
    synthesize("   ", undefined, undefined, () => undefined, () => {
      h.ended += 1;
    }, () => undefined);
    await settle();
    expect(h.ended).toBe(1);
    expect(FakeWs.instances).toHaveLength(0);
    expect(h.tickets).toEqual([]);
  });
});

describe("生产TTS账号与连接隔离", () => {
  it("未登录时不取票或创建连接", async () => {
    const h = harness();
    account = null;
    queueProduction("private text", h);
    await settle();
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid"]);
    expect(h.tickets).toEqual([]);
    expect(FakeWs.instances).toHaveLength(0);
  });

  it("读取登录态失败时不能绕过身份校验", async () => {
    const h = harness();
    auth.status.mockRejectedValue(null);
    queueProduction("private text", h);
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.tickets).toEqual([]);
    expect(FakeWs.instances).toHaveLength(0);
  });

  it("同账号连续合成仍在一个连接按顺序执行", async () => {
    const h = harness();
    const ws = await beginProduction("first", h);
    queueProduction("second", h);
    await settle();
    expect(ws.textFrames()).toHaveLength(1);
    ws.serverText({ type: "end" });
    await settle();
    expect(ws.textFrames()).toEqual([
      JSON.stringify({ type: "synthesis", text: "first" }),
      JSON.stringify({ type: "synthesis", text: "second" }),
    ]);
    ws.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(2);
    expect(h.errors).toEqual([]);
    expect(h.tickets).toEqual(["t1"]);
    expect(auth.listen).toHaveBeenCalledTimes(1);
  });

  it("切账号时关闭旧连接并取消旧账号在途和排队文本", async () => {
    const h = harness();
    const oldWs = await beginProduction("account A current", h);
    queueProduction("account A queued", h);
    await settle();
    account = "account-b";
    authListener!(statusOf(account));
    await settle();
    expect(oldWs.closed).toBe(true);
    expect(oldWs.textFrames()).toHaveLength(1);
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid", "token_invalid"]);
    expect(h.ended).toBe(0);
    // 关闭后旧服务端帧不能继续送音频给播放器。
    oldWs.serverBinary(new Uint8Array([1, 2]));
    expect(h.chunks).toHaveLength(0);
    const newWs = await beginProduction("account B current", h);
    expect(newWs).not.toBe(oldWs);
    expect(h.tickets).toEqual(["t1", "t2"]);
    expect(newWs.textFrames()).toEqual([JSON.stringify({ type: "synthesis", text: "account B current" })]);
    newWs.serverText({ type: "end" });
    await settle();
    expect(h.ended).toBe(1);
  });

  it("登出时立即释放空闲连接，后续请求不复用已登录socket", async () => {
    const h = harness();
    const ws = await beginProduction("before logout", h);
    ws.serverText({ type: "end" });
    await settle();
    account = null;
    authListener!(statusOf(account));
    expect(ws.closed).toBe(true);
    queueProduction("after logout", h);
    await settle();
    expect(h.tickets).toEqual(["t1"]);
    expect(ws.textFrames()).toHaveLength(1);
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid"]);
  });

  it("取票在途切账号时，返回的旧账号票不会用于握手", async () => {
    const h = harness();
    let resolveTicket!: (response: VoiceHttpResponse) => void;
    const ticket = vi.fn(() => new Promise<VoiceHttpResponse>(resolve => { resolveTicket = resolve; }));
    setVoiceRuntime({ http: ticket });
    queueProduction("account A text", h);
    await settle();
    expect(ticket).toHaveBeenCalledTimes(1);
    account = "account-b";
    authListener!(statusOf(account));
    resolveTicket({ status: 200, body: JSON.stringify({ ticket: "account-a-ticket" }), retryAfterSeconds: null, headers: {} });
    await settle();
    expect(FakeWs.instances).toHaveLength(0);
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid"]);
  });

  it("握手在途切账号会关闭连接，迟到的open不会发送旧文本", async () => {
    const h = harness();
    queueProduction("account A handshake", h);
    await settle();
    const ws = lastOf(FakeWs.instances);
    expect(ws.readyState).toBe(0);
    account = "account-b";
    authListener!(statusOf(account));
    await settle();
    ws.open();
    await settle();
    expect(ws.closed).toBe(true);
    expect(ws.textFrames()).toEqual([]);
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid"]);
  });

  it("监听注册失败时仍在取票后核对真实账号", async () => {
    const h = harness();
    auth.listen.mockRejectedValue(new Error("event unavailable"));
    let resolveTicket!: (response: VoiceHttpResponse) => void;
    setVoiceRuntime({ http: () => new Promise<VoiceHttpResponse>(resolve => { resolveTicket = resolve; }) });
    queueProduction("account A text", h);
    await settle();
    account = "account-b";
    resolveTicket({ status: 200, body: JSON.stringify({ ticket: "account-a-ticket" }), retryAfterSeconds: null, headers: {} });
    await settle();
    expect(FakeWs.instances).toHaveLength(0);
    expect(h.errors.map(error => error.code)).toEqual(["token_invalid"]);
  });
});
