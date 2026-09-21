/**
 * 讯飞在线语音合成客户端（wss://tts-api.xfyun.cn/v2/tts）。
 *
 * 协议要点（2026-09 官方文档核实）：
 * - 鉴权与 ISE 同构（见 xfyunAuth.ts）。
 * - 单帧请求：common{app_id} + business{aue:"lame", sfl:1, vcn, tte:"UTF8",
 *   speed/volume/pitch 0-100} + data{text: base64, status: 2}（文本一次性传，不分帧）。
 * - 响应：流式返回 data.audio（mp3 分片），累计到 data.status=2 拼完整音频。
 *   每帧是独立带 padding 的 base64，必须逐帧解码再按字节拼接（见函数内注释）。
 * - 单次文本 base64 前 < 8000 字节；创建应用默认每日 500 次免费调用。
 *
 * 语速策略：恒按 1× 合成（business.speed 固定 50），语速由播放端
 * audio.playbackRate 变速承担——切语速不重新合成、缓存跨语速命中，
 * 每日额度只为「文本 × 音色」付一次。
 *
 * 双层缓存：内存 LRU（L1，见下）+ IndexedDB 磁盘缓存（L2，ttsDiskCache.ts）。
 * 同「音色+文本」直接命中——重听、领读、预取下一句都不烧每日额度，
 * 且应用重启后仍命中。WebView 前端直连（与 ISE 同模式，无 Rust 依赖）。
 */

import { buildXfyunAuthUrl } from "./xfyunAuth";
import { diskCacheGet, diskCachePut } from "./ttsDiskCache";

export interface XfyunTtsCredentials {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export interface XfyunTtsOptions {
  /** 发音人：中文句用中文 vcn，英文句用英文 vcn（由引擎按句子语言选择）。 */
  vcn: string;
  /** 音量 0–100，默认 50。 */
  volume?: number;
}

export const XFYUN_TTS_HOST = "tts-api.xfyun.cn";
const TTS_PATH = "/v2/tts";
/** 官方限制：base64 编码前 < 8000 字节（约 2000 汉字）。 */
const MAX_TEXT_BYTES = 8000;
const REQUEST_TIMEOUT_MS = 20000;
/** 缓存上限（约一篇短文逐句 + 若干重听）。 */
const CACHE_LIMIT = 80;
/** vcn 缺省发音人（中文句）。 */
export const DEFAULT_TTS_VCN = "xiaoyan";
/** 英文句缺省发音人：英文句与中文句分音色，跟读示范不用中文音色读英文。 */
export const DEFAULT_TTS_VCN_EN = "catherine";

/** 设置抽屉「云音色」输入框的建议列表（完整列表以讯飞控制台为准）。 */
export const XFUYUN_TTS_VOICE_SUGGESTIONS: { vcn: string; label: string }[] = [
  { vcn: "catherine", label: "catherine · 英语女声" },
  { vcn: "xiaoyan", label: "xiaoyan · 小燕，中文女声（中英混合）" },
  { vcn: "x4_xiaoyan", label: "x4_xiaoyan · 新一代小燕" },
  { vcn: "aisjiuxu", label: "aisjiuxu · 许久，中文男声" },
  { vcn: "aisxping", label: "aisxping · 小萍，中文女声（方言）" },
  { vcn: "aisbabyxu", label: "aisbabyxu · 童声" },
];

const TTS_CODE_MESSAGES: Record<number, string> = {
  10005: "APPID 授权失败（检查讯飞合成凭据）",
  10006: "请求缺少必传参数",
  10007: "参数非法",
  10010: "引擎授权不足",
  10109: "文本长度超限（单次 < 8000 字节）",
  10163: "发起会话错误",
  10200: "读取超时",
  10221: "服务器无可用连接，稍后再试",
  10313: "APPID 与 API Key 不匹配",
  11200: "发音人未授权——去讯飞控制台「语音合成」添加该发音人",
  11201: "今日免费调用次数已用完（每日 500 次）",
  11202: "请求频率超限，稍后再试",
};

export function friendlyTtsError(code: number, message: string): string {
  const known = TTS_CODE_MESSAGES[code];
  return known ? `${known}（${code}）` : `语音合成失败：${message}（${code}）`;
}

/** 构造一次性请求帧（单测用，导出以便验证字段）。语速恒 1×，变速在播放端。 */
export function buildTtsRequestFrame(appId: string, text: string, opts: XfyunTtsOptions): string {
  return JSON.stringify({
    common: { app_id: appId },
    business: {
      aue: "lame", // mp3
      sfl: 1, // 流式返回
      auf: "audio/L16;rate=16000",
      vcn: opts.vcn || DEFAULT_TTS_VCN,
      tte: "UTF8",
      speed: 50,
      volume: Math.min(100, Math.max(0, Math.round(opts.volume ?? 50))),
      pitch: 50,
    },
    data: { status: 2, text: bytesToBase64(new TextEncoder().encode(text)) },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- LRU 缓存（key = vcn|volume|text；语速不入 key，变速在播放端） ----------

const blobCache = new Map<string, Blob>();

export function ttsCacheKey(text: string, opts: XfyunTtsOptions): string {
  return `${opts.vcn || DEFAULT_TTS_VCN}|${opts.volume ?? 50}|${text}`;
}

export function ttsCacheGet(key: string): Blob | undefined {
  const hit = blobCache.get(key);
  if (hit) {
    blobCache.delete(key);
    blobCache.set(key, hit); // 刷新 LRU 位置
  }
  return hit;
}

export function ttsCacheSet(key: string, blob: Blob): void {
  if (blobCache.has(key)) blobCache.delete(key);
  blobCache.set(key, blob);
  while (blobCache.size > CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value;
    if (oldest === undefined) break;
    blobCache.delete(oldest);
  }
}

export function ttsCacheSize(): number {
  return blobCache.size;
}

/** 合成一段文本，返回 mp3 Blob。命中缓存不产生网络请求。 */
export async function synthesizeXfyunTts(
  text: string,
  opts: XfyunTtsOptions,
  creds: XfyunTtsCredentials,
): Promise<Blob> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("合成文本为空");
  if (new TextEncoder().encode(trimmed).length >= MAX_TEXT_BYTES) {
    throw new Error("文本太长（单次 < 8000 字节，请按句朗读）");
  }
  const key = ttsCacheKey(trimmed, opts);
  const cached = ttsCacheGet(key);
  if (cached) return cached;
  // L1 未命中查磁盘（L2）：重启/换文章后的重听也不烧额度。命中回填 L1。
  const disk = await diskCacheGet(key);
  if (disk) {
    ttsCacheSet(key, disk);
    return disk;
  }

  const url = await buildXfyunAuthUrl(XFYUN_TTS_HOST, TTS_PATH, creds);
  return new Promise<Blob>((resolve, reject) => {
    const ws = new WebSocket(url);
    // 服务端每帧 data.audio 是一段独立带 padding 的 base64（实测帧尾含
    // "="），必须逐帧解码成字节再拼接——join 后整体 atob 会因串中 "=" 抛错。
    const audioChunks: Uint8Array<ArrayBuffer>[] = [];
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

    ws.onerror = () => {
      /* 具体 reason 在 onclose 给 */
    };
    ws.onclose = (ev) => {
      if (!settled) {
        const hint =
          ev.code === 401
            ? "鉴权失败：检查讯飞合成的 API Key / API Secret"
            : ev.code === 403
              ? "被拒：IP 白名单或系统时间偏差超 5 分钟"
              : `连接断开（${ev.code}${ev.reason ? " " + ev.reason : ""}）`;
        finish(() => reject(new Error(hint)));
      }
    };
    ws.onmessage = (ev) => {
      const payload = typeof ev.data === "string" ? ev.data : "";
      if (!payload) return;
      let msg: { code?: number; message?: string; sid?: string; data?: { status?: number; audio?: string } | null };
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof msg.code !== "number" || msg.code !== 0) {
        const code = msg.code ?? -1;
        finish(() => reject(new Error(friendlyTtsError(code, msg.message ?? ""))));
        return;
      }
      if (msg.data?.audio) {
        try {
          audioChunks.push(base64ToBytes(msg.data.audio));
        } catch {
          finish(() => reject(new Error("音频分片解码失败（base64 非法）")));
          return;
        }
      }
      if (msg.data?.status === 2) {
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
        ttsCacheSet(key, blob);
        void diskCachePut(key, blob); // 磁盘写入失败不影响本次播放
        finish(() => resolve(blob));
      }
    };
    ws.onopen = () => {
      ws.send(buildTtsRequestFrame(creds.appId, trimmed, opts));
    };
  });
}
