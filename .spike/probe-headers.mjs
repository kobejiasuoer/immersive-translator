/** 头部矩阵实验：定位 Edge TTS WS 握手 403 的原因（UA？Origin？还是 token？）。 */
import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

async function secMsGec() {
  let s = Math.floor(Date.now() / 1000) + 11644473600;
  s -= s % 300;
  const ticks = s * 10_000_000;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function attempt(label, headers) {
  return new Promise(async (resolve) => {
    const gec = await secMsGec();
    const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    let ws;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(`${label}: 超时`); }, 15000);
    try {
      ws = new WebSocket(url, { headers });
    } catch (e) {
      clearTimeout(timer);
      return resolve(`${label}: 构造失败 ${e.message}`);
    }
    let bytes = 0;
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve(`${label}: 握手被拒 HTTP ${res.statusCode}`);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      resolve(`${label}: error ${e.message}`);
    });
    ws.on("open", () => {
      const ts = new Date().toString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } }));
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='en-US-AvaNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>Testing.</prosody></voice></speak>`;
      ws.send(`X-RequestId:${crypto.randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (text.includes("Path:turn.end")) {
          clearTimeout(timer);
          try { ws.close(1000, ""); } catch {}
          resolve(`${label}: ✅ 成功，收到 ${bytes} 字节音频`);
        }
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const headerLen = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLen).toString();
      if (header.includes("Path:audio")) bytes += buf.length - 2 - headerLen;
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve(`${label}: 提前关闭 code=${code} reason=${reason?.toString() || "-"}（已收音频 ${bytes}B）`);
    });
  });
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

console.log(await attempt("A 无自定义头", {}));
console.log(await attempt("B 仅UA", { "User-Agent": UA }));
console.log(await attempt("C UA+Origin", { "User-Agent": UA, Origin: "http://tauri.localhost" }));
