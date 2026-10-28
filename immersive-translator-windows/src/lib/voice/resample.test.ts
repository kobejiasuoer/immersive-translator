import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  float32ToInt16,
  pcm16kBytes,
  pcm16kToBase64,
} from "./resample";

describe("float32ToInt16(对称量化)", () => {
  it("典型值:0 → 0,+1 → 32767,-1 → -32768,四舍五入", () => {
    const out = float32ToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 0.25]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, -16384, 8192]);
  });

  it("越界钳制到 [-1,1]", () => {
    const out = float32ToInt16(new Float32Array([1.5, -2, 100]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767]);
  });
});

describe("bytesToBase64(纯查表编码,RFC 4648 向量)", () => {
  it("空 / 1 / 2 / 3 字节 padding 正确", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(bytesToBase64(new Uint8Array([0x00]))).toBe("AA==");
    expect(bytesToBase64(new Uint8Array([0xfb]))).toBe("+w==");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("+/+/");
    expect(bytesToBase64(new TextEncoder().encode("abc"))).toBe("YWJj");
    expect(bytesToBase64(new TextEncoder().encode("ab"))).toBe("YWI=");
  });

  it("跨 3 字节边界的大块:编码后解码逐字节还原", () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
    const decoded = atobLike(bytesToBase64(bytes));
    expect(Array.from(new Uint8Array(decoded.buffer))).toEqual(Array.from(bytes));
  });
});

describe("重采样数值(44.1k/48k → 16k mono)", () => {
  it("48k → 16k:整倍数线性插值取源点", () => {
    // 4800 样本 @48k(100ms)→ 1600 样本 @16k;ratio=3 时 out[i]=input[3i]
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) input[i] = i % 7 === 0 ? 1 : 0;
    const bytes = pcm16kBytes(input, 48000);
    expect(bytes.byteLength).toBe(1600 * 2);
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    expect(view[0]).toBe(32767);
    expect(view[1]).toBe(0);
  });

  it("44.1k → 16k:1 秒得到 16000 样本,durationMs=1000", () => {
    const input = new Float32Array(44100); // 1 秒 @44.1k
    input.fill(0.25);
    const payload = pcm16kToBase64(input, 44100);
    // 线性插值长度 floor(44100 / 2.75625) = 16000(服务端 pcmDurationMs 同口径)
    expect(payload.durationMs).toBe(1000);
    const decoded = atobLike(payload.base64);
    expect(decoded.byteLength).toBe(16000 * 2);
    const view = new Int16Array(decoded.buffer);
    expect(view[123]).toBe(Math.round(0.25 * 0x7fff));
  });

  it("16k 输入原样直通(不重复重采样)", () => {
    const input = new Float32Array([0.5, -0.5]);
    const payload = pcm16kToBase64(input, 16000);
    expect(payload.durationMs).toBe(Math.round((2 / 16000) * 1000));
    const view = new Int16Array(atobLike(payload.base64).buffer);
    expect(Array.from(view)).toEqual([16384, -16384]);
  });

  it("pcm16kBytes 输出 Int16 小端字节序(x86/ARM WebView2 均 LE)", () => {
    const bytes = pcm16kBytes(new Float32Array([0.5]), 16000);
    expect(Array.from(bytes)).toEqual([0x00, 0x40]); // 16384 = 0x4000 → LE [0x00, 0x40]
  });
});

/** 测试内 base64 解码(避免依赖环境 atob)。 */
function atobLike(b64: string): { buffer: ArrayBuffer; byteLength: number } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let idx = 0;
  for (const ch of clean) {
    acc = (acc << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[idx] = (acc >> bits) & 0xff;
      idx += 1;
    }
  }
  return { buffer: out.buffer, byteLength: out.byteLength };
}
