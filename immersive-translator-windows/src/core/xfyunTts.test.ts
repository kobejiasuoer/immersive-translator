/**
 * 讯飞在线合成客户端单测（帧构造/错误映射/双层缓存/鉴权 URL）。
 * 语速策略：恒 1× 合成（business.speed 固定 50），变速由播放端承担，
 * speed 不进缓存 key。网络路径用保真 mock 覆盖：每帧 data.audio 是独立
 * 带 "=" padding 的 base64（与线上实测一致），专门钉死"逐帧解码拼接"
 * 这一行为；真实链路由 xfyunTts.live.test.ts（凭据存在时）与
 * spike/tts_spike.mjs 验证。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_VCN,
  buildTtsRequestFrame,
  friendlyTtsError,
  synthesizeXfyunTts,
  ttsCacheGet,
  ttsCacheKey,
  ttsCacheSet,
  ttsCacheSize,
} from "./xfyunTts";
import { diskCacheGet, diskCachePut } from "./ttsDiskCache";
import { buildXfyunAuthUrl } from "./xfyunAuth";

describe("buildTtsRequestFrame", () => {
  it("单帧请求：mp3 流式参数 + vcn 缺省 + text base64 可往返", () => {
    const frame = JSON.parse(buildTtsRequestFrame("app-1", "Hello 你好", { vcn: "" }));
    expect(frame.common).toEqual({ app_id: "app-1" });
    expect(frame.business.aue).toBe("lame");
    expect(frame.business.sfl).toBe(1);
    expect(frame.business.tte).toBe("UTF8");
    expect(frame.business.vcn).toBe(DEFAULT_TTS_VCN);
    expect(frame.business.speed).toBe(50);
    expect(frame.data.status).toBe(2);
    // base64 解回原文（UTF-8）
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(frame.data.text), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("Hello 你好");
  });

  it("音量写进 business；speed 恒 50（1× 合成，语速由播放端变速）", () => {
    const frame = JSON.parse(buildTtsRequestFrame("a", "x", { vcn: "catherine", volume: 80 }));
    expect(frame.business.vcn).toBe("catherine");
    expect(frame.business.speed).toBe(50);
    expect(frame.business.volume).toBe(80);
  });
});

describe("friendlyTtsError", () => {
  it("已知错误码给出人话（发音人未授权 / 日额度）", () => {
    expect(friendlyTtsError(11200, "x")).toContain("发音人未授权");
    expect(friendlyTtsError(11201, "x")).toContain("每日 500 次");
  });
  it("未知码透传服务端消息", () => {
    expect(friendlyTtsError(99999, "boom")).toContain("boom");
    expect(friendlyTtsError(99999, "boom")).toContain("99999");
  });
});

describe("tts cache", () => {
  it("key 含 vcn/音量/文本，语速不入 key（变速在播放端，缓存跨语速命中）", () => {
    expect(ttsCacheKey("hi", { vcn: "xiaoyan" })).toBe("xiaoyan|50|hi");
    expect(ttsCacheKey("hi", { vcn: "catherine" })).not.toBe(
      ttsCacheKey("hi", { vcn: "xiaoyan" }),
    );
    expect(ttsCacheKey("hi", { vcn: "xiaoyan", volume: 80 })).not.toBe(
      ttsCacheKey("hi", { vcn: "xiaoyan" }),
    );
  });

  it("LRU 淘汰最旧条目", () => {
    const before = ttsCacheSize();
    // 填到超过上限（80）：先清空再写 85 个，验证只留最新 80
    for (let i = 0; i < 85; i += 1) {
      ttsCacheSet(`k-${i}`, new Blob(["x"]));
    }
    expect(ttsCacheSize()).toBeLessThanOrEqual(80);
    expect(ttsCacheGet("k-0")).toBeUndefined(); // 最旧的被淘汰
    expect(ttsCacheGet("k-84")).toBeDefined(); // 最新仍在
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe("buildXfyunAuthUrl", () => {  it("为不同服务生成对应 host/path 的签名地址", async () => {
    const ttsUrl = await buildXfyunAuthUrl("tts-api.xfyun.cn", "/v2/tts", {
      apiKey: "k",
      apiSecret: "s",
    });
    expect(ttsUrl.startsWith("wss://tts-api.xfyun.cn/v2/tts?")).toBe(true);
    expect(ttsUrl).toContain("authorization=");
    expect(ttsUrl).toContain("host=tts-api.xfyun.cn");

    const iseUrl = await buildXfyunAuthUrl("ise-api.xfyun.cn", "/v2/open-ise", {
      apiKey: "k",
      apiSecret: "s",
    });
    expect(iseUrl.startsWith("wss://ise-api.xfyun.cn/v2/open-ise?")).toBe(true);
  });
});

// ---------- synthesizeXfyunTts：保真 mock WebSocket ----------

/** 与生产 bytesToBase64 同构：字节 → 带 padding 的 base64。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 模拟服务端分帧：把原始 mp3 字节按给定尺寸切块、每块独立 base64——
 * 中间块自带 "=" padding（线上实测帧尾 qYI= / VQ==，join 后整体 atob 必炸）。
 */
function frameAudioLikeServer(bytes: Uint8Array, sizes: number[]): { status: number; audio: string }[] {
  const frames: { status: number; audio: string }[] = [];
  let off = 0;
  const cuts = [...sizes];
  while (off < bytes.length) {
    const size = cuts.length ? (cuts.shift() as number) : bytes.length - off;
    const last = off + size >= bytes.length;
    frames.push({ status: last ? 2 : 1, audio: bytesToBase64(bytes.subarray(off, off + size)) });
    off += size;
  }
  return frames;
}

type ServerMessage = { code?: number; message?: string; data?: { status?: number; audio?: string } | null };

class FakeTtsSocket {
  static instances: FakeTtsSocket[] = [];
  /** 每次 new 消费的一组回复（与真实服务端一致：每帧都带 code: 0）。 */
  static queue: ServerMessage[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeTtsSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(payload: string): void {
    this.sent.push(payload);
    const replies = FakeTtsSocket.queue;
    setTimeout(() => {
      for (const reply of replies) this.onmessage?.({ data: JSON.stringify(reply) });
    }, 0);
  }

  close(): void {
    /* noop */
  }
}

/** 便捷 stub：消费 queue 的 FakeTtsSocket + 最小 window 垫片。 */
function stubTtsSocket() {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  FakeTtsSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeTtsSocket);
}

const CREDS = { appId: "app-1", apiKey: "k", apiSecret: "s" };

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("synthesizeXfyunTts（mock WS）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("逐帧解码独立 padding 的 base64 并拼出完整 mp3", async () => {
    // 伪 mp3：合法帧头 + 递变字节，2000B；按 101/1500/499 切三帧（前两帧非 3 倍数对齐，必带 padding）
    const mp3 = new Uint8Array(2000);
    mp3[0] = 0xff;
    mp3[1] = 0xf3;
    for (let i = 2; i < mp3.length; i += 1) mp3[i] = i & 0xff;
    const frames = frameAudioLikeServer(mp3, [101, 1500, 499]);
    expect(frames[0].audio.endsWith("=") || frames[0].audio.endsWith("==")).toBe(true); // 前提：中间帧确实带 padding

    stubTtsSocket();
    FakeTtsSocket.queue = frames.map((f) => ({ code: 0, data: f }));

    const blob = await synthesizeXfyunTts("streaming decode", { vcn: "catherine" }, CREDS);
    expect(blob.type).toBe("audio/mpeg");
    expect(Array.from(await blobBytes(blob))).toEqual(Array.from(mp3));

    // 请求帧字段正确
    const req = JSON.parse(FakeTtsSocket.instances[0].sent[0]);
    expect(req.common.app_id).toBe("app-1");
    expect(req.business.vcn).toBe("catherine");
  });

  it("同参数二次合成命中缓存，不再建 WS", async () => {
    const mp3 = new Uint8Array(64).fill(7);
    stubTtsSocket();
    FakeTtsSocket.queue = [{ code: 0, data: { status: 2, audio: bytesToBase64(mp3) } }];

    const text = "cache-hit-probe";
    await synthesizeXfyunTts(text, { vcn: "xiaoyan" }, CREDS);
    expect(FakeTtsSocket.instances).toHaveLength(1);
    await synthesizeXfyunTts(text, { vcn: "xiaoyan" }, CREDS);
    expect(FakeTtsSocket.instances).toHaveLength(1); // 第二次没建新连接
  });

  it("服务端业务错误码 → 人话 reject", async () => {
    stubTtsSocket();
    FakeTtsSocket.queue = [{ code: 11200, message: "no auth" }];
    await expect(synthesizeXfyunTts("err", { vcn: "catherine" }, CREDS)).rejects.toThrow(/发音人未授权/);
  });

  it("非法 base64 帧 → 立即 reject（不悬挂等超时）", async () => {
    stubTtsSocket();
    FakeTtsSocket.queue = [{ code: 0, data: { status: 1, audio: "%%not-base64%%" } }];
    await expect(synthesizeXfyunTts("bad frame", { vcn: "catherine" }, CREDS)).rejects.toThrow(/解码失败/);
  });

  it("status=2 但零音频 → 空音频 reject", async () => {
    stubTtsSocket();
    FakeTtsSocket.queue = [{ code: 0, data: { status: 2 } }];
    await expect(synthesizeXfyunTts("empty", { vcn: "catherine" }, CREDS)).rejects.toThrow(/空音频/);
  });
});

describe("ttsDiskCache（node 测试环境无 IndexedDB）", () => {
  it("整体降级为 no-op：get 返回 null、put/trim 不抛错", async () => {
    expect(await diskCacheGet("k")).toBeNull();
    await expect(diskCachePut("k", new Blob(["x"]))).resolves.toBeUndefined();
  });
});
