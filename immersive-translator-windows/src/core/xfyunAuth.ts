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

/**
 * WS 关闭事件 → 用户能行动的中文提示（听写/评测/合成三处 onclose 共用）。
 *
 * 关键事实：浏览器从不把 HTTP 握手层的状态码（讯飞拒签返回的 401/403）
 * 报给 JS——握手失败一律表现为 onclose code=1006。所以按 1006 直接给排查
 * 清单，而不是永远走不到的 401/403 分支。
 */
export function explainXfyunClose(ev: { code: number; reason?: string }): string {
  if (ev.code === 1006) {
    return (
      "连接被服务器拒绝（握手失败）——多数是凭据问题：请到 设置 → 语音 核对并点「测试」。" +
      "排查顺序：① 三段凭据（APPID / API Key / API Secret）是否抄对、是否属于同一个应用，" +
      "且该应用已开通对应服务（听写/评测/合成要分别开通）；② 电脑系统时间是否准确（偏差超 5 分钟会被拒）；" +
      "③ 公司网络/代理是否拦截了讯飞的连接"
    );
  }
  if (ev.code === 401 || ev.code === 403) {
    return ev.code === 401
      ? "鉴权失败：检查 API Key / API Secret 是否抄对"
      : "被拒：IP 白名单或系统时间偏差超 5 分钟";
  }
  return `连接断开（${ev.code}${ev.reason ? " " + ev.reason : ""}）`;
}
