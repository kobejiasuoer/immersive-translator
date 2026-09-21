#!/usr/bin/env node
/**
 * [TTS Spike] 讯飞在线语音合成实调验证（与 app 内 src/core/xfyunTts.ts 同协议）。
 * 产出 spike/tts_out.mp3，用播放器试听音色效果。
 *
 * 用法（零依赖，Node >= 22）：
 *   1) 复制 spike/tts_credentials.example.json 为 spike/tts_credentials.json，
 *      填讯飞控制台「语音合成」应用的 APPID / API_KEY / API_SECRET（已 gitignore）
 *   2) node spike/tts_spike.mjs                       默认读 catherine 读英文句
 *      node spike/tts_spike.mjs "自定义文本" xiaoyan   指定文本与发音人
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "tts-api.xfyun.cn";
const PATH_ = "/v2/tts";

function loadCreds() {
  const file = join(HERE, "tts_credentials.json");
  if (!existsSync(file)) {
    console.error(`缺少 ${file} —— 复制 tts_credentials.example.json 填入讯飞「语音合成」应用凭据`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["APPID", "API_KEY", "API_SECRET"]) {
    if (!raw[key]) {
      console.error(`tts_credentials.json 缺字段 ${key}`);
      process.exit(1);
    }
  }
  return raw;
}

function buildUrl({ APPID, API_KEY, API_SECRET }) {
  void APPID;
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH_} HTTP/1.1`;
  const signature = createHmac("sha256", API_SECRET).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf8").toString("base64");
  return `wss://${HOST}${PATH_}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${HOST}`;
}

function textToBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

const CODE_MESSAGES = {
  10005: "APPID 授权失败（检查凭据）",
  10313: "APPID 与 API Key 不匹配",
  11200: "发音人未授权——去控制台「语音合成」添加该发音人",
  11201: "今日免费次数用完（每日 500 次）",
  11202: "请求频率超限",
};

async function main() {
  const text = process.argv[2] ?? "The quick brown fox jumps over the lazy dog. 你好，世界。";
  const vcn = process.argv[3] ?? "catherine";
  const creds = loadCreds();
  console.log(`文本: ${text}`);
  console.log(`音色: ${vcn}`);

  const ws = new WebSocket(buildUrl(creds));
  const chunks = [];
  let settled = false;
  const finish = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { ws.close(1000, ""); } catch {}
    fn();
  };
  const timer = setTimeout(() => finish(() => { console.error("超时 20s"); process.exit(1); }), 20000);

  ws.onclose = (ev) => {
    if (!settled) {
      console.error(`连接关闭 code=${ev.code} reason=${ev.reason}`);
      process.exit(1);
    }
  };
  ws.onmessage = (ev) => {
    let payload = ev.data;
    if (payload instanceof Blob) {
      // 文本帧不会是 Blob；防御
      return;
    }
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    if (msg.code !== 0) {
      const known = CODE_MESSAGES[msg.code] ?? msg.message;
      finish(() => {
        console.error(`服务端错误 code=${msg.code}: ${known} sid=${msg.sid ?? "-"}`);
        process.exit(1);
      });
      return;
    }
    if (msg.data?.audio) chunks.push(Buffer.from(msg.data.audio, "base64"));
    if (msg.data?.status === 2) {
      finish(() => {
        const mp3 = Buffer.concat(chunks);
        const out = join(HERE, "tts_out.mp3");
        writeFileSync(out, mp3);
        console.log(`✅ 合成成功：${mp3.length}B → ${out}（播放器打开试听）`);
      });
    }
  };
  ws.onopen = () => {
    console.log("已连接，发送合成请求…");
    ws.send(JSON.stringify({
      common: { app_id: creds.APPID },
      business: { aue: "lame", sfl: 1, auf: "audio/L16;rate=16000", vcn, tte: "UTF8", speed: 50, volume: 50, pitch: 50 },
      data: { status: 2, text: textToBase64(text) },
    }));
  };
}

main();
