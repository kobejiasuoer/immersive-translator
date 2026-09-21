/**
 * 讯飞在线合成 · 真实链路验证（不启动 GUI）。
 *
 * 走生产同款 synthesizeXfyunTts——真实 WebSocket 鉴权、流式音频帧拼接、
 * 双层缓存——确认凭据可用、发音人已授权、产出的 Blob 可直接播放。
 *
 * 未设置环境变量时自动跳过，不影响 npm test：
 *   Git Bash（凭据见 spike/tts_credentials.json，勿入仓库）：
 *     XFYUN_TTS_APP_ID=... XFYUN_TTS_API_KEY=... XFYUN_TTS_API_SECRET=... \
 *       npx vitest run xfyunTts.live
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { synthesizeXfyunTts } from "./xfyunTts";

const appId = process.env.XFYUN_TTS_APP_ID?.trim() ?? "";
const apiKey = process.env.XFYUN_TTS_API_KEY?.trim() ?? "";
const apiSecret = process.env.XFYUN_TTS_API_SECRET?.trim() ?? "";

describe.skipIf(!appId || !apiKey || !apiSecret)("讯飞在线合成 · 真实链路", () => {
  beforeAll(() => {
    // 生产代码跑在 WebView，定时器挂在 window 上；Node 环境补最小垫片。
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });

  it(
    "catherine 合成英文句 → audio/mpeg Blob",
    async () => {
      const blob = await synthesizeXfyunTts(
        "The quick brown fox jumps over the lazy dog.",
        { vcn: "catherine" },
        { appId, apiKey, apiSecret },
      );
      expect(blob.type).toBe("audio/mpeg");
      expect(blob.size).toBeGreaterThan(5000);
    },
    30_000,
  );

  it(
    "xiaoyan 合成中文句 → audio/mpeg Blob",
    async () => {
      const blob = await synthesizeXfyunTts(
        "你好，这是沉浸阅读室的语音合成测试。",
        { vcn: "xiaoyan" },
        { appId, apiKey, apiSecret },
      );
      expect(blob.type).toBe("audio/mpeg");
      expect(blob.size).toBeGreaterThan(5000);
    },
    30_000,
  );
});
