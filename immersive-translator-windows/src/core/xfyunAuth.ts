/**
 * 讯飞 WebAPI 共享鉴权（host/date/authorization HMAC-SHA256 签名）。
 * 语音评测（ise-api.xfyun.cn /v2/open-ise）与在线合成（tts-api.xfyun.cn /v2/tts）
 * 签名方式同构，只差 host 与 path，这里统一构造 wss 地址。
 */

export interface XfyunAuthKeyPair {
  apiKey: string;
  apiSecret: string;
}

async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 构造带签名的 wss 握手地址（host 为讯飞域名，path 形如 "/v2/tts"）。 */
export async function buildXfyunAuthUrl(
  host: string,
  path: string,
  creds: XfyunAuthKeyPair,
): Promise<string> {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = await hmacSha256Base64(creds.apiSecret, signatureOrigin);
  const authorizationOrigin = `api_key="${creds.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = btoa(authorizationOrigin);
  return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
}
