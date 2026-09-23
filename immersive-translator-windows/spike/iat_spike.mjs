#!/usr/bin/env node
/**
 * [SPIKE] 讯飞流式听写 wss://iat-api.xfyun.cn/v2/iat 实调验证。
 * 背景：口语陪练报 10163（请求数据非法/采样率）。评测(ISE)一次性连发全部帧
 * 正常，听写(IAT)照抄同款连发即报 10163——验证「音频帧发送节奏」是否为因。
 *
 * 实测（2026-09-22）：
 * - business 带 sub:"iat"（照抄 ISE 写法）→ 10163 param validate error:
 *   '$.business.sub' unknown field。评测要求 sub，听写 v2 不认，删掉即好。
 * - 删掉 sub 后连发/节奏发均成功（见各 mode 日志）。
 *
 * 用法（零依赖，Node >= 22，用原生 WebSocket）：
 *   node spike/iat_spike.mjs blast       # 删 sub，连发全部帧
 *   node spike/iat_spike.mjs pace        # 删 sub，每 40ms 发一帧 1280B
 *   node spike/iat_spike.mjs pace2x      # 删 sub，每 20ms 发一帧（2 倍速）
 *   node spike/iat_spike.mjs blast:sub   # 保留 sub（复刻线上行为，预期 10163）
 * 凭据：spike/credentials.json（APPID/API_KEY/API_SECRET）。
 */

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const creds = JSON.parse(readFileSync(new URL("./credentials.json", import.meta.url), "utf8"));
const [modeRaw, flag] = (process.argv[2] ?? "blast").split(":");
const mode = modeRaw;
const withSub = flag === "sub";

// ---------- 鉴权 URL（与 src/core/xfyunAuth.ts 同构） ----------
const host = "iat-api.xfyun.cn";
const path = "/v2/iat";
const date = new Date().toUTCString();
const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
const signature = createHmac("sha256", creds.API_SECRET).update(signatureOrigin).digest("base64");
const authorizationOrigin = `api_key="${creds.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
const authorization = Buffer.from(authorizationOrigin).toString("base64");
const url = `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;

// ---------- 合成 4s「像人声」的 16k/16bit 单声道音频 ----------
// 用幅度调制的多频噪声段模拟说话（0.3s 说 / 0.2s 停交替）。听写对内容不敏感，
// 这里只验证「数据是否被判非法」，code=0 即数据合法（文本可以为空）。
const RATE = 16000;
const SECONDS = 4;
const samples = new Int16Array(RATE * SECONDS);
let phase = 0;
for (let i = 0; i < samples.length; i += 1) {
  const t = i / RATE;
  const speaking = t % 0.5 < 0.3;
  if (speaking) {
    // 三个共振峰频率叠加 + 缓慢幅度起伏，能量近似语音
    const v =
      0.3 * Math.sin(2 * Math.PI * 220 * t + Math.sin(t * 7)) +
      0.25 * Math.sin(2 * Math.PI * 780 * t) +
      0.15 * Math.sin(2 * Math.PI * 2400 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    samples[i] = Math.max(-1, Math.min(1, v * 0.6)) * 0x7fff;
  }
  phase = t;
}
const bytes = new Uint8Array(samples.buffer);
console.log(`mode=${mode}  audio=${bytes.length}B (${SECONDS}s @16k/16bit/mono)  frames=${Math.ceil(bytes.length / 1280)}`);

// ---------- WebSocket 会话 ----------
const ws = new WebSocket(url);
const t0 = Date.now();
let sentDone = false;
let firstResultAt = 0;

ws.onopen = () => {
  console.log(`[open] +${Date.now() - t0}ms`);
  ws.send(
    JSON.stringify({
      common: { app_id: creds.APPID },
      business: {
        ...(withSub ? { sub: "iat" } : {}),
        domain: "iat",
        language: "en_us",
        accent: "mandarin",
        vad_eos: 1200,
        ptt: 1,
      },
      data: { status: 0, format: "audio/L16;rate=16000", encoding: "raw", audio: "" },
    }),
  );
  const FRAME = 1280;
  const interval = mode === "blast" ? 0 : mode === "pace2x" ? 20 : 40;
  const frames = [];
  for (let off = 0; off < bytes.length; off += FRAME) {
    frames.push(bytes.subarray(off, Math.min(off + FRAME, bytes.length)));
  }
  let i = 0;
  const sendNext = () => {
    if (i >= frames.length) {
      if (sentDone) return;
      sentDone = true;
      ws.send(
        JSON.stringify({
          data: { status: 2, format: "audio/L16;rate=16000", encoding: "raw", audio: "" },
        }),
      );
      console.log(`[sent-end] +${Date.now() - t0}ms（结束帧，全部音频发完）`);
      return;
    }
    const b64 = Buffer.from(frames[i]).toString("base64");
    ws.send(
      JSON.stringify({
        data: { status: 1, format: "audio/L16;rate=16000", encoding: "raw", audio: b64 },
      }),
    );
    i += 1;
    if (interval === 0) sendNext();
    else setTimeout(sendNext, interval);
  };
  sendNext();
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (!firstResultAt) firstResultAt = Date.now();
  if (typeof msg.code === "number" && msg.code !== 0) {
    console.log(`[error] +${Date.now() - t0}ms code=${msg.code} message=${msg.message}`);
    ws.close();
    process.exitCode = 1;
    return;
  }
  if (msg.data?.result) {
    const text = msg.data.result.ws?.map((w) => w.cw?.[0]?.w ?? "").join("") ?? "";
    console.log(`[seg] sn=${msg.data.result.sn} "${text}"`);
  }
  if (msg.data?.status === 2) {
    console.log(`[done] +${Date.now() - t0}ms 全部结束`);
    ws.close();
  }
};

ws.onclose = (ev) => {
  console.log(`[close] +${Date.now() - t0}ms code=${ev.code} reason=${ev.reason || "-"}`);
  if (!process.exitCode) process.exitCode = 0;
};
ws.onerror = () => {};
