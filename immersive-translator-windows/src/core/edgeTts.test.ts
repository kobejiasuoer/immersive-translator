/**
 * edgeTts 单测：帧构造 / 二进制帧解析 / 签名 ticks 对齐 / mock WS 合成主链路。
 * 网络路径用保真 mock：文本帧（speech.config、ssml、turn.end）+ 二进制帧
 * （2 字节大端头长 + Path:audio 头 + mp3 净荷），与线上实测格式一致
 * （见 .spike/probe-headers.mjs）。fetch 一律 stub——时钟校准不得真发请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EdgeTtsModule from "./edgeTts";

/** 每个用例取全新模块实例：LRU 缓存与校准后的时钟偏差不跨用例泄漏。 */
async function freshModule(): Promise<typeof EdgeTtsModule> {
  const mod = await import("./edgeTts");
  return mod as typeof EdgeTtsModule;
}

/** 按线上格式组一条二进制音频帧。 */
function audioFrame(payload: Uint8Array, path = "Path:audio\r\n"): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(path);
  const out = new Uint8Array(2 + headerBytes.length + payload.length);
  out[0] = (headerBytes.length >> 8) & 0xff;
  out[1] = headerBytes.length & 0xff;
  out.set(headerBytes, 2);
  out.set(payload, 2 + headerBytes.length);
  return out.buffer;
}

type ScriptItem =
  | { data: string | ArrayBuffer }
  /** 注入一次 onclose（模拟握手 403 的 error→close）。 */
  | { close: { code: number; reason: string } };

class FakeEdgeSocket {
  static instances: FakeEdgeSocket[] = [];
  /** 每次 new 消费的一组服务端消息；重试用 [第一轮, 第二轮] 逐次 shift。 */
  static scripts: ScriptItem[][] = [];
  static nextScript(): ScriptItem[] {
    return FakeEdgeSocket.scripts.shift() ?? [];
  }
  binaryType = "";
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEdgeSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(payload: string): void {
    this.sent.push(payload);
    // 收到 ssml 帧（第二条）才开始回包，模拟真实时序。
    if (payload.includes("Path:ssml")) {
      const replies = FakeEdgeSocket.nextScript();
      setTimeout(() => {
        for (const reply of replies) {
          if ("close" in reply) this.onclose?.(reply.close);
          else this.onmessage?.({ data: reply.data });
        }
      }, 0);
    }
  }

  close(): void {
    /* noop */
  }
}

/** stub：FakeEdgeSocket + 最小 window 垫片 + 不出网的 fetch。 */
function stubEdgeSocket(fetchDateHeader: string | null = null) {
  FakeEdgeSocket.instances = [];
  FakeEdgeSocket.scripts = [];
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("WebSocket", FakeEdgeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ headers: { get: (_name: string) => fetchDateHeader } })),
  );
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("edgeTts 帧构造与解析", () => {
  it("speech.config 帧指定 mp3 输出与 Path", async () => {
    const mod = await freshModule();
    const msg = mod.buildSpeechConfigMessage("Mon Sep 22 2026");
    expect(msg).toContain("Path:speech.config\r\n");
    expect(msg).toContain("audio-24khz-48kbitrate-mono-mp3");
  });

  it("ssml 帧：voice 嵌入、文本转义、requestId 无横线", async () => {
    const mod = await freshModule();
    const msg = mod.buildSsmlMessage("en-US-AvaNeural", "a<b & c", "req123", "ts");
    expect(msg).toContain("Path:ssml\r\n");
    expect(msg).toContain("X-RequestId:req123\r\n");
    expect(msg).toContain("voice name='en-US-AvaNeural'");
    expect(msg).toContain("a&lt;b &amp; c");
    expect(msg).not.toContain("a<b");
  });

  it("二进制帧：取 Path:audio 净荷，非音频帧/坏帧返回 null", async () => {
    const mod = await freshModule();
    const payload = new Uint8Array([1, 2, 3, 4]);
    expect(Array.from(mod.parseEdgeBinaryFrame(audioFrame(payload))!)).toEqual([1, 2, 3, 4]);
    // 非 audio 头（如 turn.start 二进制形态）丢弃
    expect(mod.parseEdgeBinaryFrame(audioFrame(payload, "Path:turn.start\r\n"))).toBeNull();
    expect(mod.parseEdgeBinaryFrame(new ArrayBuffer(1))).toBeNull();
  });

  it("签名 ticks：对齐到 5 分钟窗口 + Windows 纪元偏移", async () => {
    const mod = await freshModule();
    // 11644473600 恰为 300 的整数倍：now=0 对齐后不变。
    expect(mod.edgeTokenTicks(0)).toBe(11644473600 * 10_000_000);
    // 100 秒偏移在窗口内向下取整；skew 参与对齐前的秒数。
    expect(mod.edgeTokenTicks(100_000, 0)).toBe(11644473600 * 10_000_000);
    expect(mod.edgeTokenTicks(100_000, 250)).toBe((11644473600 + 300) * 10_000_000);
  });
});

describe("synthesizeEdgeTts（mock WS）", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("拼装多帧二进制音频为完整 mp3，URL 带签名参数", async () => {
    const mod = await freshModule();
    stubEdgeSocket();
    const mp3 = new Uint8Array(1000);
    mp3[0] = 0xff;
    for (let i = 1; i < mp3.length; i += 1) mp3[i] = i & 0xff;
    FakeEdgeSocket.scripts = [
      [
        { data: audioFrame(mp3.subarray(0, 300)) },
        { data: audioFrame(mp3.subarray(300)) },
        { data: "X-RequestId:x\r\nPath:turn.end\r\n" },
      ],
    ];

    const blob = await mod.synthesizeEdgeTts("streaming decode", { voice: "en-US-AvaNeural" });
    expect(blob.type).toBe("audio/mpeg");
    expect(Array.from(await blobBytes(blob))).toEqual(Array.from(mp3));

    const url = FakeEdgeSocket.instances[0].url;
    expect(url).toContain("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    expect(url).toContain("Sec-MS-GEC=");
    expect(url).toContain("Sec-MS-GEC-Version=1-");
    // 两条发送帧：speech.config 与 ssml
    expect(FakeEdgeSocket.instances[0].sent).toHaveLength(2);
  });

  it("同参数二次合成命中内存缓存，不再建 WS", async () => {
    const mod = await freshModule();
    stubEdgeSocket();
    FakeEdgeSocket.scripts = [
      [
        { data: audioFrame(new Uint8Array(64).fill(7)) },
        { data: "Path:turn.end\r\n" },
      ],
    ];
    const text = "cache-hit-probe";
    await mod.synthesizeEdgeTts(text, { voice: "zh-CN-XiaoxiaoNeural" });
    expect(FakeEdgeSocket.instances).toHaveLength(1);
    await mod.synthesizeEdgeTts(text, { voice: "zh-CN-XiaoxiaoNeural" });
    expect(FakeEdgeSocket.instances).toHaveLength(1);
  });

  it("空文本拒绝；turn.end 无音频拒绝", async () => {
    const mod = await freshModule();
    stubEdgeSocket();
    await expect(mod.synthesizeEdgeTts("  ", { voice: "v" })).rejects.toThrow("合成文本为空");

    FakeEdgeSocket.scripts = [[{ data: "Path:turn.end\r\n" }]];
    await expect(mod.synthesizeEdgeTts("empty audio", { voice: "v" })).rejects.toThrow("空音频");
  });

  it("握手被拒：时钟校准不可用（无 Date 头）时上抛原始错误", async () => {
    const mod = await freshModule();
    stubEdgeSocket(null);
    FakeEdgeSocket.scripts = [[{ close: { code: 1006, reason: "" } }]];
    await expect(mod.synthesizeEdgeTts("rejected", { voice: "v" })).rejects.toThrow("连接被拒");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled(); // 尝试过校准
  });

  it("时钟偏差自愈：校准出偏移后带新签名重试成功", async () => {
    const mod = await freshModule();
    // 服务端时间比本机快 10 分钟（token 落在下一个 5 分钟窗口 → 首次握手被拒）
    stubEdgeSocket(new Date(Date.now() + 10 * 60_000).toUTCString());
    FakeEdgeSocket.scripts = [
      [{ close: { code: 1006, reason: "" } }], // 第一轮：握手被拒
      [
        { data: audioFrame(new Uint8Array([9, 9, 9])) },
        { data: "Path:turn.end\r\n" },
      ],
    ];
    const blob = await mod.synthesizeEdgeTts("skew retry", { voice: "v" });
    expect(Array.from(await blobBytes(blob))).toEqual([9, 9, 9]);
    expect(FakeEdgeSocket.instances).toHaveLength(2); // 重试建了第二条连接
  });
});
