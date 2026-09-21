#!/usr/bin/env node
/**
 * [SPIKE-B] 讯飞语音评测（流式版）wss://ise-api.xfyun.cn/v2/open-ise 实调验证。
 * 目的：确认返回分数粒度（句级 total/accuracy/fluency/integrity + 词级 total_score/
 * dp_message）是否满足"读对过关、读错卡住 + 词着色"的产品需求。
 *
 * 用法（零依赖，Node >= 22，用原生 WebSocket）：
 *   node spike/ise_spike.mjs --selftest                       离线自检（不联网）
 *   node spike/ise_spike.mjs spike/spike_tts.wav "The quick brown fox jumps over the lazy dog."
 *
 * 凭据：spike/credentials.json（已 gitignore），格式见 credentials.example.json。
 * 音频要求：16k/16bit/单声道 PCM；本脚本自动解析 WAV 头，非 16k 会线性重采样。
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "ise-api.xfyun.cn";
const TARGET_RATE = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 凭据 ----------
function loadCredentials() {
  const file = join(HERE, "credentials.json");
  if (!existsSync(file)) {
    console.error(`缺少 ${file}\n请复制 credentials.example.json 为 credentials.json，填入讯飞控制台「语音评测」应用的 APPID / API_KEY / API_SECRET`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["APPID", "API_KEY", "API_SECRET"]) {
    if (!raw[key]) {
      console.error(`credentials.json 缺字段 ${key}`);
      process.exit(1);
    }
  }
  return raw;
}

// ---------- 鉴权 URL（讯飞标准 HMAC-SHA256 签名） ----------
function buildUrl({ APPID, API_KEY, API_SECRET }) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET /v2/open-ise HTTP/1.1`;
  const signature = createHmac("sha256", API_SECRET).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf8").toString("base64");
  return `wss://${HOST}/v2/open-ise?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${HOST}`;
}

// ---------- WAV 解析（RIFF，遍历 chunk 找 fmt/data，转单声道 Float32） ----------
function parseWavBuffer(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 RIFF/WAVE 文件");
  }
  let pos = 12;
  let fmt = null;
  let dataPos = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        rate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    }
    if (id === "data") {
      dataPos = pos + 8;
      dataLen = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataPos < 0) throw new Error("WAV 里找不到 fmt/data 块");
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) {
    throw new Error(`仅支持 16bit PCM，实际 format=${fmt.audioFormat} bits=${fmt.bits}`);
  }
  const frames = Math.floor(dataLen / (2 * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch += 1) {
      sum += buf.readInt16LE(dataPos + (i * fmt.channels + ch) * 2) / 32768;
    }
    out[i] = sum / fmt.channels;
  }
  return { samples: out, rate: fmt.rate };
}

function resampleTo16k(input, rate) {
  if (rate === TARGET_RATE) return input;
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToPcm16Buffer(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return pcm;
}

// ---------- 结果 XML 解析（regex 级，够 Spike 用） ----------
function attrMap(attrString) {
  const map = {};
  for (const m of attrString.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) map[m[1]] = m[2];
  return map;
}

function parseResultXml(xml) {
  const sentence = [...xml.matchAll(/<sentence\b([^>]*)>/g)].map((m) => attrMap(m[1]));
  const words = [];
  for (const m of xml.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
    const attrs = attrMap(m[1]);
    // 只取第一个子标签（<syll> 等）之前的直接文本，避免把音节文本拼进词
    const innerText = m[2].split("<")[0].trim();
    if (!attrs.content && innerText) attrs.content = innerText;
    words.push(attrs);
  }
  for (const m of xml.matchAll(/<word\b([^>]*?)\/>/g)) words.push(attrMap(m[1]));
  const sylls = [];
  for (const m of xml.matchAll(/<syll\b([^>]*)>([\s\S]*?)<\/syll>/g)) {
    const attrs = attrMap(m[1]);
    const innerText = m[2].split("<")[0].trim();
    if (!attrs.content && innerText) attrs.content = innerText;
    sylls.push(attrs);
  }
  const root = [...xml.matchAll(/<(?:rec_paper|read_sentence)\b([^>]*)>/g)].map((m) => attrMap(m[1]));
  return { sentence, words, sylls, root };
}

function report(xml) {
  console.log("\n===== 原始 XML（截断到 6000 字）=====");
  console.log(xml.length > 6000 ? `${xml.slice(0, 6000)}\n…（截断）` : xml);

  const p = parseResultXml(xml);
  console.log("\n===== 句级分数 =====");
  for (const s of p.sentence) console.log(JSON.stringify(s));
  console.log(`\n===== 词级（共 ${p.words.length} 词，展示前 30）=====`);
  for (const w of p.words.slice(0, 30)) {
    console.log(
      `  ${(w.content ?? w.symbol ?? "?").padEnd(18)} total=${(w.total_score ?? "?").padEnd(8)} dp_message=${(w.dp_message ?? "?").padEnd(4)}${w.werr_msg ? ` werr_msg=${w.werr_msg}` : ""}`,
    );
  }
  if (p.sylls.length) {
    console.log(`\n===== 音节级（共 ${p.sylls.length}，展示前 20）=====`);
    for (const s of p.sylls.slice(0, 20)) {
      console.log(`  ${(s.content ?? "?").padEnd(12)} syll_score=${(s.syll_score ?? "?").padEnd(8)}${s.serr_msg ? ` serr_msg=${s.serr_msg}` : ""}`);
    }
  }

  console.log("\n===== Spike-B 判定 =====");
  const s0 = p.sentence[0] ?? {};
  const total = Number(s0.total_score ?? 0);
  if (total > 0 && s0.is_rejected !== "true") {
    console.log(
      `粒度验证 ✅  total=${s0.total_score} accuracy=${s0.accuracy_score ?? "-"} fluency=${s0.fluency_score ?? "-"} integrity=${s0.integrity_score ?? "-"} standard=${s0.standard_score ?? "-"}`,
    );
    console.log(`词级分数 ${p.words.length} 个 / 音节级 ${p.sylls.length} 个 —— 满足「句级过/不过 + 词级着色」需求`);
  } else {
    console.log(`⚠️ 无有效句分：is_rejected=${s0.is_rejected ?? "-"} except_info=${s0.except_info ?? "-"}，检查上面 XML（无语音/音量小=28673，乱说=28676，信噪比低=28680）`);
  }
}

// ---------- 主流程 ----------
async function evaluate({ wavPath, text, creds }) {
  const { samples, rate } = parseWavBuffer(readFileSync(wavPath));
  const pcm16k = resampleTo16k(samples, rate);
  const pcm = floatToPcm16Buffer(pcm16k);
  console.log(`音频: ${wavPath} ${rate}Hz ${(samples.length / rate).toFixed(2)}s → 16k ${(pcm16k.length / TARGET_RATE).toFixed(2)}s（${pcm.length}B）`);
  console.log(`评测文本: ${text}`);

  const ws = new WebSocket(buildUrl(creds));
  const base64Chunks = [];
  let finished = false;
  let failCode = null;

  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    try {
      ws.close(1000, "");
    } catch {}
    process.exit(exitCode);
  };

  const timer = setTimeout(() => {
    console.error("超时：60s 未收到最终结果");
    finish(1);
  }, 60000);

  ws.onerror = (ev) => {
    console.error("WebSocket 错误:", ev?.message ?? ev?.error ?? "(无详情)");
  };

  ws.onclose = (ev) => {
    clearTimeout(timer);
    if (!finished) {
      console.error(`连接关闭 code=${ev.code} reason=${ev.reason}${failCode === null ? "（未收到结果）" : ""}`);
      process.exit(1);
    }
  };

  ws.onmessage = async (ev) => {
    let payload = ev.data;
    if (payload instanceof Blob) payload = await payload.text();
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      console.error("非 JSON 响应:", String(payload).slice(0, 500));
      return;
    }
    if (msg.code !== 0) {
      failCode = msg.code;
      console.error(`\n服务端错误 code=${msg.code} message=${msg.message} sid=${msg.sid ?? "-"}`);
      console.error("(10163=参数错 10313=app_id 不匹配 11201=超量 11200=未授权 401/403=签名或时钟)");
      finish(1);
      return;
    }
    if (msg.data?.data) base64Chunks.push(msg.data.data);
    if (msg.data?.status === 2) {
      clearTimeout(timer);
      const xml = Buffer.from(base64Chunks.join(""), "base64").toString("utf8");
      report(xml);
      finish(0);
    }
  };

  ws.onopen = async () => {
    console.log(`已连接 ${HOST}，发送 ssb（ent=en_vip, category=read_sentence）…`);
    const ssb = {
      common: { app_id: creds.APPID },
      business: {
        sub: "ise",
        cmd: "ssb",
        ent: "en_vip",
        category: "read_sentence",
        tte: "utf-8",
        ttp_skip: true,
        auf: "audio/L16;rate=16000",
        aue: "raw",
        text: `\uFEFF[content]\n${text}`,
      },
      data: { status: 0, data: "" },
    };
    ws.send(JSON.stringify(ssb));

    // 音频帧：首帧 aus=1、中间 aus=2（1280B≈40ms），最后补空结束帧 aus=4/status=2
    const CHUNK = 1280;
    const frames = [];
    for (let off = 0; off < pcm.length; off += CHUNK) frames.push(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
    console.log(`开始上传音频：${frames.length} 帧（每 40ms 一帧）…`);
    frames.forEach((piece, i) => {
      const aus = i === 0 ? 1 : 2;
      ws.send(
        JSON.stringify({
          business: { cmd: "auw", aus, aue: "raw" },
          data: { status: 1, data: piece.toString("base64"), data_type: 1, encoding: "raw" },
        }),
      );
    });
    ws.send(
      JSON.stringify({
        business: { cmd: "auw", aus: 4, aue: "raw" },
        data: { status: 2, data: "", data_type: 1, encoding: "raw" },
      }),
    );
    console.log("音频已全部送出，等待评测结果…");
    // 发送节奏：一次性发出所有帧对 WebSocket 没问题（服务端按帧解析），
    // 但为贴近官方 demo 的 40ms 间隔、避免 10163，这里按帧数补一个总限速。
    await sleep(Math.min(frames.length * 40, 3000));
  };
}

// ---------- 离线自检 ----------
function selftest() {
  // 1) WAV 编码/解析/重采样往返
  const rate = 8000;
  const samples = new Float32Array(rate); // 1 秒 440Hz 正弦
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
  const pcm = floatToPcm16Buffer(samples);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  const parsed = parseWavBuffer(wav);
  if (parsed.rate !== rate || parsed.samples.length !== rate) throw new Error("WAV 往返解析失败");
  const resampled = resampleTo16k(parsed.samples, parsed.rate);
  if (Math.abs(resampled.length - 16000) > 1) throw new Error(`重采样长度异常: ${resampled.length}`);

  // 2) 结果 XML 解析
  const mockXml = `<xml_result><read_sentence rec_type="en_vip"><rec_paper><sentence accuracy_score="85.2" fluency_score="78.1" integrity_score="100" standard_score="80.0" total_score="84.5" is_rejected="false"><word dp_message="0" total_score="90.1" property="0">the</word><word dp_message="16" total_score="0" property="0">fox<syll syll_score="70" serr_msg="1">fox</syll></word></sentence></rec_paper></read_sentence></xml_result>`;
  const p = parseResultXml(mockXml);
  if (p.sentence.length !== 1 || p.sentence[0].total_score !== "84.5") throw new Error("句级解析失败");
  if (p.words.length !== 2) throw new Error(`词级解析失败: ${p.words.length}`);
  if (p.words[1].content !== "fox" || p.words[1].dp_message !== "16") throw new Error("词级字段解析失败");
  if (p.sylls.length !== 1 || p.sylls[0].syll_score !== "70") throw new Error("音节级解析失败");

  console.log("selftest ✅  WAV 往返/重采样 + 结果 XML（句/词/音节）解析全部通过");
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
  process.exit(0);
}
if (args[0] === "--info") {
  // 只解析 WAV 头并重采样，不联网：验证样本文件格式可被评测链路接受
  for (const file of args.slice(1)) {
    try {
      const { samples, rate } = parseWavBuffer(readFileSync(file));
      const pcm16k = resampleTo16k(samples, rate);
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
      console.log(`${file}: ${rate}Hz ${(samples.length / rate).toFixed(2)}s → 16k ${pcm16k.length} 样本, peak=${peak.toFixed(3)}`);
    } catch (err) {
      console.error(`${file}: 解析失败 —— ${err.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
}
if (args.length < 2) {
  console.error("用法: node spike/ise_spike.mjs <wav 文件> \"<评测文本>\"  （或 --selftest）");
  process.exit(1);
}
evaluate({ wavPath: args[0], text: args[1], creds: loadCredentials() });
