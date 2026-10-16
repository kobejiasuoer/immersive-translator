/**
 * Edge 真实合成链路：显式设置 EDGE_TTS_LIVE=1 才联网，普通 npm test 跳过。
 * Node 22+ 的 WebSocketInit 支持 headers；这里只补 WebView2 自动携带的 Edge UA，
 * 签名、请求帧、音频拼接和缓存仍走生产 synthesizeEdgeTts。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { synthesizeEdgeTts } from "./edgeTts";

const EDGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

type NodeSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

describe.skipIf(process.env.EDGE_TTS_LIVE !== "1")("Edge 在线合成 · 真实链路", () => {
  beforeAll(() => {
    const NodeSocket = globalThis.WebSocket as unknown as NodeSocketConstructor;
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", function EdgeSocket(url: string) {
      return new NodeSocket(url, { headers: { "User-Agent": EDGE_USER_AGENT } });
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  it.each([
    { voice: "en-US-AvaNeural", text: "The devoted friend. This is a Windows speech test." },
    { voice: "zh-CN-XiaoxiaoNeural", text: "你好，这是 Windows 版朗读测试。" },
    { voice: "en-US-AvaNeural", text: "This is a slow speech example.", ratePercent: "-25%" },
  ])("$voice / $ratePercent：返回 MP3 音频", async ({ voice, text, ratePercent }) => {
    const blob = await synthesizeEdgeTts(text, { voice, ratePercent });
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBeGreaterThan(5000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // MP3 可以从 ID3 标签或 MPEG 同步帧开始，避免把任意大响应当成音频。
    const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const hasMpegFrame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    expect(hasId3 || hasMpegFrame).toBe(true);
  }, 45_000);
});
