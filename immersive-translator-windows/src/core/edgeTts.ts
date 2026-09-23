/**
 * Edge 在线语音合成客户端（微软 Edge 浏览器「大声朗读」同源服务，逆向接口）。
 *
 * 协议要点（2026-09 对照 rany2/edge-tts 实测验证，样例见 .spike/probe-headers.mjs）：
 * - 端点：wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 *   + 查询参数 TrustedClientToken（公开常量）、Sec-MS-GEC（防滥用签名）、Sec-MS-GEC-Version。
 * - Sec-MS-GEC = SHA-256 大写十六进制(`${ticks}${TOKEN}`)；ticks 为对齐到 5 分钟的
 *   Windows filetime——本机时钟偏差 >5 分钟即 403，失败后用 voices 接口的 Date 头
 *   校准一次再重试（对齐 edge-tts 的 clock skew 处理）。
 * - 握手要求 User-Agent：浏览器 WS 不能自设，但 WebView2 自动携带真实 Edge UA，
 *   实测可通过；Node 原生 WS（无 UA）会被拒——单测须 mock WebSocket。
 * - 帧序列：连上发两条文本帧（speech.config 指定 mp3 输出；ssml 带 voice/prosody），
 *   语速恒 +0%（变速由播放端 audio.playbackRate 承担，与讯飞引擎同一策略）。
 * - 响应：二进制帧 = 2 字节大端头长 + 头文本 + mp3 净荷，Path:audio 帧累加，
 *   文本帧 Path:turn.end 收尾。产物 mp3 Blob，缓存/播放层与讯飞引擎共用同一套。
 *
 * 免费无凭据，但属非官方接口：微软可能收紧（历史上多次），引擎链里必须有
 * 本地 SAPI 兜底（见 speechEngine.ts / ReaderApp.tsx）。
 */

import { diskCacheGet, diskCachePut } from "./ttsDiskCache";

export interface EdgeTtsOptions {
  /** Edge 音色 ShortName，如 en-US-AvaNeural / zh-CN-XiaoxiaoNeural。 */
  voice: string;
}

const WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** 公开的 Edge 客户端令牌（逆向自浏览器，非机密）。 */
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** 随 Chromium 主版本走；服务端只校验格式，过大版本号无副作用（edge-tts 同款策略）。 */
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
/** voices 列表接口：校准时钟用（只读响应 Date 头，不解析列表）。 */
const VOICES_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const REQUEST_TIMEOUT_MS = 20000;
/** 缓存上限（与讯飞引擎同量级：一篇短文逐句 + 若干重听）。 */
const CACHE_LIMIT = 80;
/** Windows filetime 纪元差（1601-01-01 与 1970-01-01 之间）与每秒 tick 数。 */
const WIN_EPOCH_SECONDS = 11644473600;
const TICKS_PER_SECOND = 10_000_000;
/** 签名对齐窗口：token 在每个 5 分钟窗口内有效。 */
const TOKEN_WINDOW_SECONDS = 300;

/** 中文句缺省音色：晓晓。 */
export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
/** 英文句缺省音色：Ava（试听样例 .spike/sample-ava-en.mp3）。 */
export const DEFAULT_EDGE_VOICE_EN = "en-US-AvaNeural";

/** 设置抽屉「Edge 音色」输入框的建议列表（2026-09 实测在列）。 */
export const EDGE_TTS_VOICE_SUGGESTIONS: { voice: string; label: string }[] = [
  { voice: "en-US-AvaNeural", label: "Ava · 英语女声，自然（默认）" },
  { voice: "en-US-AndrewNeural", label: "Andrew · 英语男声，自然" },
  { voice: "en-US-EmmaNeural", label: "Emma · 英语女声，温和" },
  { voice: "en-US-BrianNeural", label: "Brian · 英语男声，沉稳" },
  { voice: "en-US-JennyNeural", label: "Jenny · 英语女声，亲切" },
  { voice: "en-US-GuyNeural", label: "Guy · 英语男声，新闻" },
  { voice: "en-US-AvaMultilingualNeural", label: "Ava · 多语种女声" },
  { voice: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 中文女声（默认）" },
  { voice: "zh-CN-YunxiNeural", label: "云希 · 中文男声，阳光" },
  { voice: "zh-CN-YunyangNeural", label: "云扬 · 中文男声，新闻" },
  { voice: "zh-CN-XiaoyiNeural", label: "晓伊 · 中文女声，活泼" },
  { voice: "zh-CN-YunjianNeural", label: "云健 · 中文男声，有力" },
];

/** 服务端要求单 voice 单 prosody；文本转义后嵌入。 */
export function buildSsmlMessage(voice: string, text: string, requestId: string, timestamp: string): string {
  const locale = voice.split("-").slice(0, 2).join("-") || "en-US";
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${safe}</prosody></voice></speak>`;
  return (
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`
  );
}

export function buildSpeechConfigMessage(timestamp: string): string {
  return (
    `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" },
            outputFormat: OUTPUT_FORMAT,
          },
        },
      },
    })
  );
}

/**
 * 解析一条二进制帧：返回 mp3 净荷（非音频帧返回 null）。
 * 帧结构：2 字节大端头长 + 头文本（含 `Path:audio` 等）+ 音频字节。
 */
export function parseEdgeBinaryFrame(data: ArrayBuffer): Uint8Array | null {
  const buf = new Uint8Array(data);
  if (buf.length < 2) return null;
  const headerLen = (buf[0] << 8) | buf[1];
  if (2 + headerLen > buf.length) return null;
  const header = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
  if (!header.includes("Path:audio")) return null;
  return buf.subarray(2 + headerLen);
}

/** 计算签名用的 filetime ticks：对齐到 5 分钟窗口（对齐 edge-tts 算法，导出供单测）。 */
export function edgeTokenTicks(nowMs: number, skewSeconds = 0): number {
  let seconds = Math.floor(nowMs / 1000) + skewSeconds + WIN_EPOCH_SECONDS;
  seconds -= seconds % TOKEN_WINDOW_SECONDS;
  return seconds * TICKS_PER_SECOND;
}

/** Sec-MS-GEC 签名：SHA-256(`${ticks}${TOKEN}`) 大写十六进制。 */
async function secMsGec(skewSeconds: number): Promise<string> {
  const ticks = edgeTokenTicks(Date.now(), skewSeconds);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** 校准后的时钟偏差（秒），跨调用复用；null = 未知。 */
let calibratedSkewSeconds: number | null = null;

/**
 * 用 voices 接口响应的 Date 头校准时钟（浏览器可读 date 响应头）。
 * 失败返回 null——离线/接口不可用时保持原样重试或直接报错。
 */
async function calibrateClockSkew(): Promise<number | null> {
  try {
    const res = await fetch(`${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`, {
      cache: "no-store",
    });
    const dateHeader = res.headers.get("date");
    if (!dateHeader) return null;
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) return null;
    const skew = Math.round((serverMs - Date.now()) / 1000);
    calibratedSkewSeconds = skew;
    return skew;
  } catch {
    return null;
  }
}

// ---------- LRU 缓存（key = edge|voice|text；语速不入 key，变速在播放端） ----------

const blobCache = new Map<string, Blob>();

export function edgeTtsCacheKey(text: string, opts: EdgeTtsOptions): string {
  return `edge:${opts.voice || DEFAULT_EDGE_VOICE}|${text}`;
}

function cacheGet(key: string): Blob | undefined {
  const hit = blobCache.get(key);
  if (hit) {
    blobCache.delete(key);
    blobCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, blob: Blob): void {
  if (blobCache.has(key)) blobCache.delete(key);
  blobCache.set(key, blob);
  while (blobCache.size > CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value;
    if (oldest === undefined) break;
    blobCache.delete(oldest);
  }
}

/** 单次合成尝试（不含校准重试）。 */
function synthesizeOnce(trimmed: string, voice: string, skewSeconds: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    void secMsGec(skewSeconds).then(
      (gec) => {
        const url =
          `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
          `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        const audioChunks: Uint8Array[] = [];
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          try {
            ws.close(1000, "");
          } catch {
            /* 已关闭 */
          }
          fn();
        };
        const timer = window.setTimeout(() => {
          finish(() => reject(new Error("语音合成超时（20s 无结果）")));
        }, REQUEST_TIMEOUT_MS);

        // 浏览器 WS 拿不到握手 HTTP 状态码：403/断网统一表现为 error→close。
        ws.onerror = () => {
          /* 具体 reason 在 onclose 给 */
        };
        ws.onclose = (ev) => {
          if (!settled) {
            finish(() =>
              reject(
                new Error(
                  ev.reason ||
                    (audioChunks.length
                      ? "连接提前中断（音频不完整）"
                      : "连接被拒：网络不可达或服务暂不可用"),
                ),
              ),
            );
          }
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            if (ev.data.includes("Path:turn.end")) {
              let total = 0;
              for (const chunk of audioChunks) total += chunk.length;
              if (!total) {
                finish(() => reject(new Error("合成返回空音频")));
                return;
              }
              const merged = new Uint8Array(new ArrayBuffer(total));
              let offset = 0;
              for (const chunk of audioChunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
              }
              const blob = new Blob([merged], { type: "audio/mpeg" });
              finish(() => resolve(blob));
            }
            return;
          }
          const payload = parseEdgeBinaryFrame(ev.data as ArrayBuffer);
          if (payload) audioChunks.push(payload);
        };
        ws.onopen = () => {
          const ts = new Date().toString();
          ws.send(buildSpeechConfigMessage(ts));
          ws.send(
            buildSsmlMessage(
              voice,
              trimmed,
              crypto.randomUUID().replace(/-/g, ""),
              ts,
            ),
          );
        };
      },
      (err) => reject(err instanceof Error ? err : new Error("签名计算失败")),
    );
  });
}

/**
 * 合成一段文本，返回 mp3 Blob。命中缓存不产生网络请求。
 * 首次失败（多为时钟偏差导致的握手 403）时校准时钟重试一次。
 */
export async function synthesizeEdgeTts(text: string, opts: EdgeTtsOptions): Promise<Blob> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("合成文本为空");
  const voice = opts.voice || DEFAULT_EDGE_VOICE;
  const key = edgeTtsCacheKey(trimmed, { voice });
  const cached = cacheGet(key);
  if (cached) return cached;
  const disk = await diskCacheGet(key);
  if (disk) {
    cacheSet(key, disk);
    return disk;
  }

  try {
    const blob = await synthesizeOnce(trimmed, voice, calibratedSkewSeconds ?? 0);
    cacheSet(key, blob);
    void diskCachePut(key, blob);
    return blob;
  } catch (err) {
    // 时钟偏差是最常见可自愈原因：校准后带着新签名重试一次。
    const prevSkew = calibratedSkewSeconds ?? 0;
    const skew = await calibrateClockSkew();
    if (skew === null || skew === prevSkew) throw err;
    try {
      const blob = await synthesizeOnce(trimmed, voice, skew);
      cacheSet(key, blob);
      void diskCachePut(key, blob);
      return blob;
    } catch {
      throw err; // 重试仍失败：上抛首次错误（更接近根因）
    }
  }
}
