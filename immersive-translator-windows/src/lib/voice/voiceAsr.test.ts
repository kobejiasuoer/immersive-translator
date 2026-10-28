import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { VoiceError, voiceErrorMessage, type VoiceErrorInfo } from "./voiceErrors";
import {
  ASR_MAX_RECONNECTS,
  asrBackoffMs,
  closeAsrStream,
  pushAudioChunk,
  resetAsrForTests,
  setAsrBackoffForTests,
  startStreamingAsr,
  stopAsr,
  type VoiceAsrLang,
} from "./voiceAsr";
import { resetSharedTicketManagerForTests } from "./voiceTicket";
import { resetVoiceRuntime, setVoiceRuntime, type WsLike, type VoiceHttpResponse } from "./voiceRuntime";

/** 测试用 WS 替身(记录 URL/发送帧;open/drop/serverText 由用例驱动)。 */
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

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  serverText(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  textFrames(): string[] {
    return this.sent.filter((d): d is string => typeof d === "string");
  }

  binaryFrames(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

const lastOf = <T>(items: T[]): T => items[items.length - 1]!;
const lastIndex = (): number => FakeWs.instances.length - 1;
/** 等待微任务与 0ms 定时器(换票/建连是 async 链)。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  /** 已发出的票(经 /v1/voice/ticket 通道)。 */
  tickets: string[];
  ticketCalls: number;
  statuses: VoiceErrorInfo[];
  errors: VoiceError[];
  interim: string[];
  finals: { text: string; durationMs: number | null }[];
}

function harness(lang: VoiceAsrLang = "en_us"): Harness {
  const h: Harness = { tickets: [], ticketCalls: 0, statuses: [], errors: [], interim: [], finals: [] };
  setVoiceRuntime({
    wsFactory: (url) => new FakeWs(url) as unknown as WsLike,
    baseUrlSource: async () => "https://gw.test",
    http: async (method, path): Promise<VoiceHttpResponse> => {
      if (method === "POST" && path === "/v1/voice/ticket") {
        h.ticketCalls += 1;
        const ticket = `t${h.ticketCalls}`;
        h.tickets.push(ticket);
        return {
          status: 200,
          body: JSON.stringify({ ticket, expiresAt: "2026-10-28T00:01:00.000Z" }),
          retryAfterSeconds: null,
          headers: {},
        };
      }
      return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no route" } }), retryAfterSeconds: null, headers: {} };
    },
  });
  startStreamingAsr(
    lang,
    (text) => h.interim.push(text),
    (text, durationMs) => h.finals.push({ text, durationMs }),
    (err) => h.errors.push(err),
    (info) => h.statuses.push(info),
  );
  return h;
}

beforeEach(() => {
  FakeWs.reset();
  resetAsrForTests();
  resetSharedTicketManagerForTests();
  resetVoiceRuntime();
  setAsrBackoffForTests(() => 5);
});

describe("asrBackoffMs(指数退避曲线)", () => {
  it("1s 起步 ×2,封顶 15s", () => {
    expect(asrBackoffMs(0)).toBe(1000);
    expect(asrBackoffMs(1)).toBe(2000);
    expect(asrBackoffMs(3)).toBe(8000);
    expect(asrBackoffMs(10)).toBe(15000);
  });
});

describe("startStreamingAsr/pushAudioChunk/stopAsr(契约 §四)", () => {
  it("建连:现换票→立即握手,URL 带 ticket 与 lang;open 后发 start", async () => {
    const h = harness();
    await settle();
    expect(h.tickets).toEqual(["t1"]);
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe("wss://gw.test/v1/voice/asr/stream?ticket=t1&lang=en_us");
    FakeWs.instances[0]!.open();
    expect(FakeWs.instances[0]!.textFrames()).toEqual(['{"type":"start"}']);
  });

  it("音频上行:16k Float32 → Int16 binary;48k 输入先重采样", async () => {
    harness();
    await settle();
    const ws = FakeWs.instances[0]!;
    ws.open();
    pushAudioChunk(new Float32Array([0.5, -0.5]), 16000);
    const frames = ws.binaryFrames();
    expect(frames).toHaveLength(1);
    expect(Array.from(new Uint8Array(frames[0]!))).toEqual([0x00, 0x40, 0x00, 0xc0]);
    pushAudioChunk(new Float32Array(4800).fill(0.25), 48000); // 100ms → 1600 样本
    expect(ws.binaryFrames()[1]!.byteLength).toBe(3200);
  });

  it("interim/final 回调;final 后同连接续会话(不重连、不再换票)", async () => {
    const h = harness();
    await settle();
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.serverText({ type: "interim", text: "hel" });
    expect(h.interim).toEqual(["hel"]);
    stopAsr();
    expect(ws.textFrames()).toContain('{"type":"stop"}');
    ws.serverText({ type: "final", text: "hello", durationMs: 1234 });
    expect(h.finals).toEqual([{ text: "hello", durationMs: 1234 }]);
    // 同连接再来一轮:不建新连接、不取新票
    startStreamingAsr("en_us", () => undefined, () => undefined, () => undefined);
    expect(FakeWs.instances).toHaveLength(1);
    expect(h.tickets).toEqual(["t1"]);
    expect(lastOf(ws.textFrames())).toBe('{"type":"start"}');
  });

  it("识别中重复 start 幂等拦截(服务端 voice_invalid_state 不会触发)", async () => {
    harness();
    await settle();
    const ws = FakeWs.instances[0]!;
    ws.open();
    startStreamingAsr("en_us", () => undefined, () => undefined, () => undefined);
    expect(ws.textFrames().filter((f) => f === '{"type":"start"}')).toHaveLength(1);
  });

  it("换 lang 重建连接(新票新连接)", async () => {
    harness();
    await settle();
    FakeWs.instances[0]!.open();
    startStreamingAsr("zh_cn", () => undefined, () => undefined, () => undefined);
    await settle();
    expect(FakeWs.instances).toHaveLength(2);
    expect(FakeWs.instances[1]!.url).toBe("wss://gw.test/v1/voice/asr/stream?ticket=t2&lang=zh_cn");
  });

  it("start 前 push 的音频缓冲,start 后按序重放;无会话时一切为安全 no-op", async () => {
    pushAudioChunk(new Float32Array([1]), 16000);
    stopAsr();
    closeAsrStream();
    harness();
    await settle();
    const ws = FakeWs.instances[0]!;
    pushAudioChunk(new Float32Array([0.5]), 16000); // start 未发:缓冲
    expect(ws.binaryFrames()).toHaveLength(0);
    ws.open();
    expect(ws.binaryFrames()).toHaveLength(1); // start 后重放
  });
});

describe("断线重连(§二:指数退避,重换票→新连接,ASR 重连后重新 start)", () => {
  it("1006 断开:状态文案 + 新票新连接 + 重发 start + 缓冲音频重放", async () => {
    const h = harness();
    await settle();
    const first = FakeWs.instances[0]!;
    first.open();
    first.serverText({ type: "interim", text: "par" });
    first.drop(1006);
    expect(lastOf(h.statuses)?.text).toBe(voiceErrorMessage("voice_disconnected").text);
    pushAudioChunk(new Float32Array([0.25]), 16000); // 断线期间推的音频进缓冲
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(2);
    expect(h.tickets).toEqual(["t1", "t2"]);
    const second = FakeWs.instances[1]!;
    second.open();
    expect(second.textFrames()).toEqual(['{"type":"start"}']);
    expect(second.binaryFrames()).toHaveLength(1); // 缓冲重放
    pushAudioChunk(new Float32Array([0.5]), 16000);
    expect(second.binaryFrames()).toHaveLength(2); // 新音频直发
  });

  it(`连续断开 ${ASR_MAX_RECONNECTS + 1} 次后终局:onError(voice_disconnected)`, async () => {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.open();
    for (let round = 0; round < ASR_MAX_RECONNECTS; round += 1) {
      FakeWs.instances[lastIndex()]!.drop(1006);
      await new Promise((r) => setTimeout(r, 30));
      FakeWs.instances[lastIndex()]!.open();
    }
    // 第 7 次断开不再重连,直接终局
    FakeWs.instances[lastIndex()]!.drop(1006);
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe("voice_disconnected");
    expect(voiceErrorMessage(h.errors[0]!, { final: true }).text).toBe("网络连接不稳定，请稍后再试");
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(ASR_MAX_RECONNECTS + 1);
  });

  it("终局后 stopAsr/closeAsrStream 不再产生新连接", async () => {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.open();
    for (let round = 0; round < ASR_MAX_RECONNECTS; round += 1) {
      FakeWs.instances[lastIndex()]!.drop(1006);
      await new Promise((r) => setTimeout(r, 30));
      FakeWs.instances[lastIndex()]!.open();
    }
    FakeWs.instances[lastIndex()]!.drop(1006);
    await settle();
    expect(h.errors).toHaveLength(1);
    stopAsr();
    closeAsrStream();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(ASR_MAX_RECONNECTS + 1);
  });

  it("取票失败(网络类):并入退避重连,不终局", async () => {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.open();
    // 本用例退避拉长到 200ms:断言窗口 40ms 内数学上不可能耗尽 6 次重试
    // (全局 5ms 快退避下 6×5ms≈30ms<40ms,套件满载时会偶发跑完而终局)。
    setAsrBackoffForTests(() => 200);
    // 换票通道断掉:下一次重连取票失败
    setVoiceRuntime({ http: async () => { throw new Error("offline"); } });
    FakeWs.instances[0]!.drop(1006);
    await new Promise((r) => setTimeout(r, 40));
    expect(h.errors).toHaveLength(0); // 未终局
    // 通道恢复后,下一次退避重连成功(挂起的 200ms 退避到点触发)
    setVoiceRuntime({
      http: async (_method, path): Promise<VoiceHttpResponse> => {
        if (path === "/v1/voice/ticket") {
          h.ticketCalls += 1;
          const ticket = `t${h.ticketCalls}`;
          h.tickets.push(ticket);
          return { status: 200, body: JSON.stringify({ ticket, expiresAt: "2026-10-28T00:01:00.000Z" }), retryAfterSeconds: null, headers: {} };
        }
        return { status: 404, body: "{}", retryAfterSeconds: null, headers: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(FakeWs.instances.length).toBeGreaterThan(1);
    FakeWs.instances[lastIndex()]!.open();
    expect(lastOf(FakeWs.instances[lastIndex()]!.textFrames())).toBe('{"type":"start"}');
  });
});

describe("握手失败(§二 voice_ticket_invalid:换票重试一次)", () => {
  it("open 前即关:立即换票重试;新连接 open 后正常开始", async () => {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.drop(1006); // 握手被拒(401 → 浏览器报 1006)
    await settle();
    expect(lastOf(h.statuses)?.text).toBe(voiceErrorMessage("voice_ticket_invalid").text);
    expect(FakeWs.instances).toHaveLength(2);
    expect(h.tickets).toEqual(["t1", "t2"]);
    FakeWs.instances[1]!.open();
    expect(FakeWs.instances[1]!.textFrames()).toEqual(['{"type":"start"}']);
  });

  it("重试仍握手失败:onError 终局「请稍后再试」,不再建连", async () => {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.drop(1006);
    await settle();
    FakeWs.instances[1]!.drop(1006);
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe("voice_ticket_invalid");
    expect(voiceErrorMessage(h.errors[0]!, { final: true }).text).toBe("请稍后再试");
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(2);
  });
});

describe("error 帧(§二 逐码路由)", () => {
  async function started(): Promise<Harness> {
    const h = harness();
    await settle();
    FakeWs.instances[0]!.open();
    return h;
  }

  it("quota_exceeded(asr_seconds)→ onError,文案带功能名", async () => {
    const h = await started();
    FakeWs.instances[0]!.serverText({
      type: "error",
      code: "quota_exceeded",
      details: { resource: "asr_seconds", remaining: 0 },
    });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe("quota_exceeded");
    expect(voiceErrorMessage(h.errors[0]!).text).toBe("本月口语识别额度已用完");
  });

  it("voice_session_too_long → 60 秒提示;连接保留可重新 start", async () => {
    const h = await started();
    FakeWs.instances[0]!.serverText({ type: "error", code: "voice_session_too_long" });
    expect(voiceErrorMessage(h.errors[0]!).text).toBe("单次最长 60 秒，请重新开始");
    startStreamingAsr("en_us", () => undefined, () => undefined, () => undefined);
    expect(FakeWs.instances).toHaveLength(1);
    expect(lastOf(FakeWs.instances[0]!.textFrames())).toBe('{"type":"start"}');
  });

  it("upstream_error → onError(流式不自动重放已上行音频)", async () => {
    const h = await started();
    FakeWs.instances[0]!.serverText({ type: "error", code: "upstream_error" });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe("upstream_error");
  });
});
