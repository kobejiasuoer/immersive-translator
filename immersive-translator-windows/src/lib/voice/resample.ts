/**
 * 录音 PCM → 网关要求的 16k/16bit/单声道(base64)。
 *
 * 采集链路里 Float32 [-1,1] 是 AudioContext 的原生形状;设备采样率 44.1k/48k
 * (AudioContext 不支持 16k 时)先线性插值降采样——复用 core/micRecorder 的
 * resamplePcmTo16k(同一实现,句级/块级调用无跨块相位问题),再量化为 Int16。
 * 隐私红线:只在内存转换,绝不落盘缓存。
 */

import { resamplePcmTo16k } from "../../core/micRecorder";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Float32 [-1,1] → Int16(对称量化:+1 顶格 32767,-1 顶格 -32768)。 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

/** 纯 JS base64(不依赖 btoa,Node/WebView2 一致;3 字节 → 4 字符查表)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    let chunk =
      BASE64_ALPHABET[(triple >> 18) & 0x3f] +
      BASE64_ALPHABET[(triple >> 12) & 0x3f] +
      BASE64_ALPHABET[(triple >> 6) & 0x3f] +
      BASE64_ALPHABET[triple & 0x3f];
    if (i + 1 >= bytes.length) chunk = `${chunk.slice(0, 2)}==`;
    else if (i + 2 >= bytes.length) chunk = `${chunk.slice(0, 3)}=`;
    parts.push(chunk);
  }
  return parts.join("");
}

export interface Pcm16kPayload {
  /** 16k/16bit/单声道 PCM 的 base64(REST asr/ise 的 audio 字段)。 */
  base64: string;
  /** 重采样后时长(毫秒,16000 样本/秒口径,与服务端 pcmDurationMs 一致)。 */
  durationMs: number;
}

/** Float32 任意采样率 → 16k/16bit base64 载荷(REST 上传一步到位)。 */
export function pcm16kToBase64(input: Float32Array, inputRate: number): Pcm16kPayload {
  const resampled = inputRate === 16000 ? input : resamplePcmTo16k(input, inputRate);
  const pcm = float32ToInt16(resampled);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return {
    base64: bytesToBase64(bytes),
    durationMs: Math.round((resampled.length / 16000) * 1000),
  };
}

/** Float32 任意采样率 → 16k Int16 的原始字节(流式 ASR 的 binary 帧载荷)。 */
export function pcm16kBytes(input: Float32Array, inputRate: number): Uint8Array {
  const resampled = inputRate === 16000 ? input : resamplePcmTo16k(input, inputRate);
  const pcm = float32ToInt16(resampled);
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
