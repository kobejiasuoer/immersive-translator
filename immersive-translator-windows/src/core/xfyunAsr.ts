/**
 * 讯飞流式听写（IAT）客户端：16k PCM → 文本。
 *
 * 协议要点（与语音评测同族，HMAC 鉴权走 xfyunAuth）：
 * - wss://iat-api.xfyun.cn/v2/iat，business.sub="iat"、domain="iat"。
 * - 首帧带 common/business + data(status=0)；音频帧 1280B/帧 base64(raw)；
 *   结束帧 data.status=2。
 * - 结果 JSON：data.result.ws[].cw[].w 逐词拼接；sn 是段序号（last-write-wins，
 *   按 sn 排序合并）；data.status=2 表示全部结束。
 * - 单次听写上限 60s（本模块调用方自行限制在 15s 内）。
 *
 * 本模块纯浏览器环境可用（crypto.subtle + WebSocket），不依赖 Tauri。
 * 凭据与语音评测同构；「说英语」用 en_us，「说中文」用 zh_cn。
 */

import { buildXfyunAuthUrl, explainXfyunClose } from "./xfyunAuth";
import { floatToPcm16, type IseCredentials } from "./pronunciation";

export type AsrCredentials = IseCredentials;
export type AsrLanguage = "en_us" | "zh_cn";

const IAT_HOST = "iat-api.xfyun.cn";

/** 讯飞听写业务错误码 → 用户能看懂的话。 */
const IAT_CODE_MESSAGES: Record<number, string> = {
  10105: "授权失败：APPID 与 API Key 不匹配，或该应用未开通「流式听写」服务",
  10106: "听写参数错误",
  10110: "请求超时，请重试",
  10163: "请求数据非法（请检查采样率：16k/16bit/单声道）",
  11200: "讯飞「流式听写」服务未授权（控制台确认已开通）",
  11201: "听写调用次数超限",
  10803: "连接超时：检查网络后重试",
};

function friendlyError(code: number, message: string): string {
  const known = IAT_CODE_MESSAGES[code];
  return known ? `${known}（${code}）` : `识别失败：${message || code}`;
}

// ---------- 结果解析（纯函数，单测覆盖） ----------

/** 从一条 IAT 结果消息里取一段转写；非结果消息返回 null。 */
export function extractIatSegment(payload: unknown): { sn: number; text: string } | null {
  if (typeof payload !== "string") return null;
  let msg: {
    code?: number;
    data?: { result?: { sn?: number; ws?: { cw?: { w?: string }[] }[] }; status?: number };
  };
  try {
    msg = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = msg.data?.result;
  if (!result || typeof result.sn !== "number" || !Array.isArray(result.ws)) return null;
  let text = "";
  for (const ws of result.ws) {
    // cw 是候选列表，第一个是最佳候选
    const best = ws.cw?.[0]?.w;
    if (best) text += best;
  }
  return { sn: result.sn, text };
}

/** 按 sn 归并各段（后到覆盖先到），返回完整转写。 */
export function mergeIatSegments(segments: Map<number, string>): string {
  return [...segments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join("")
    .trim();
}

// ---------- PCM ----------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- 听写主流程 ----------

/**
 * 整段语音 → 文本。
 * @param pcm16k 16k/16bit 单声道采样的 Float32 形式（[-1,1]，≤60s）
 * @param language en_us=英语（口语陪练），zh_cn=中文（录音直译）
 */
export async function transcribeSpeech(
  pcm16k: Float32Array,
  language: AsrLanguage,
  creds: AsrCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const url = await buildXfyunAuthUrl(IAT_HOST, "/v2/iat", creds);
  const pcm = floatToPcm16(pcm16k);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (bytes.length === 0) throw new Error("录音数据为空");

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url);
    const segments = new Map<number, string>();
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
      finish(() => reject(new Error(`识别超时（${(opts.timeoutMs ?? 30000) / 1000}s 未返回）`)));
    }, opts.timeoutMs ?? 30000);

    ws.onmessage = (ev) => {
      const payload = typeof ev.data === "string" ? ev.data : "";
      if (!payload) return;
      let msg: { code?: number; message?: string; data?: { status?: number } };
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof msg.code !== "number" || msg.code !== 0) {
        const code = msg.code ?? -1;
        finish(() => reject(new Error(friendlyError(code, msg.message ?? ""))));
        return;
      }
      const seg = extractIatSegment(payload);
      if (seg) segments.set(seg.sn, seg.text);
      if (msg.data?.status === 2) {
        const text = mergeIatSegments(segments);
        finish(() => resolve(text));
      }
    };
    ws.onclose = (ev) => {
      if (!settled) {
        finish(() => reject(new Error(explainXfyunClose(ev))));
      }
    };
    ws.onerror = () => {
      /* HTTP 层错误表现为 close，onclose 里补 */
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          common: { app_id: creds.appId },
          business: {
            sub: "iat",
            domain: "iat",
            language,
            accent: "mandarin",
            vad_eos: 1200,
            ptt: 1,
          },
          data: { status: 0, format: "audio/L16;rate=16000", encoding: "raw", audio: "" },
        }),
      );
      const FRAME_BYTES = 1280;
      const frames: Uint8Array[] = [];
      for (let off = 0; off < bytes.length; off += FRAME_BYTES) {
        frames.push(bytes.subarray(off, Math.min(off + FRAME_BYTES, bytes.length)));
      }
      frames.forEach((piece) => {
        ws.send(
          JSON.stringify({
            data: {
              status: 1,
              format: "audio/L16;rate=16000",
              encoding: "raw",
              audio: bytesToBase64(piece),
            },
          }),
        );
      });
      ws.send(
        JSON.stringify({
          data: { status: 2, format: "audio/L16;rate=16000", encoding: "raw", audio: "" },
        }),
      );
    };
  });
}
