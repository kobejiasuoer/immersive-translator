//! Edge 在线语音合成（微软 Edge 浏览器「大声朗读」同源服务，免费无凭据）。
//! 对齐 windows/src/core/edgeTts.ts / edgeDrm.ts 与 rany2/edge-tts drm.py：
//! - 端点 wss + TrustedClientToken（公开常量）+ Sec-MS-GEC v2（CS64 + 定制 SHA-256，
//!   被签串仍是 "{ticks}{TOKEN}"，ticks 对齐 5 分钟的 Windows filetime）。
//!   旧 v1 普通 SHA-256 签名已被服务端拒绝，校准时钟无法修复协议不匹配。
//!   真实时钟偏差仍可用 voices 接口的 Date 头校准一次再重试。
//! - 握手必须显式带浏览器 User-Agent（tungstenite 不自动带，无 UA 直接被拒）。
//! - 帧序列：连上发 speech.config + ssml 两条文本帧；二进制帧 = 2 字节大端头长 +
//!   头文本（须含 Path:audio）+ mp3 净荷逐帧累加；文本帧含 Path:turn.end 收尾。
//! - 语速嵌 ssml prosody rate（服务器端变速，与讯飞 speed 语义对齐由命令层换算）。
//! 与讯飞 JSON 帧协议不同构，不复用 run_ws_once。

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::auth;
use super::tts::{looks_chinese, TtsResult};
use super::encode_b64;

/// 逆向自浏览器的公开客户端令牌（非机密）。
pub const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/// v2 签名必须使用 "2-" 前缀，不能只更新 Chromium 版本。
pub const SEC_MS_GEC_VERSION: &str = "2-143.0.3650.75";
pub const WSS_URL: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/// voices 列表接口：仅用来读响应 Date 头校准时钟。
pub const VOICES_URL: &str = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
pub const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
/// 握手 UA：主版本 143 与 SEC_MS_GEC_VERSION 对齐（服务端只认格式）。
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.75";
/// Windows filetime 纪元差（1601↔1970）与每秒 tick 数；签名 5 分钟窗口。
pub const WIN_EPOCH_SECONDS: i64 = 11_644_473_600;
pub const TICKS_PER_SECOND: i64 = 10_000_000;
pub const TOKEN_WINDOW_SECONDS: i64 = 300;
/// 中文句缺省音色：晓晓；英文句缺省音色：Ava。
pub const DEFAULT_VOICE: &str = "zh-CN-XiaoxiaoNeural";
pub const DEFAULT_VOICE_EN: &str = "en-US-AvaNeural";
/// 单次合成整体超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 进程内复用的校准时钟偏差（秒）。
static SKEW: AtomicI64 = AtomicI64::new(0);

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 签名用 filetime ticks：对齐到 5 分钟窗口（对齐 edge-tts 算法）。
pub fn token_ticks(now_secs: i64, skew_seconds: i64) -> i64 {
    let mut seconds = now_secs + skew_seconds + WIN_EPOCH_SECONDS;
    seconds -= seconds.rem_euclid(TOKEN_WINDOW_SECONDS);
    seconds * TICKS_PER_SECOND
}

/// Sec-MS-GEC v2：CS64（小端 16 hex）+ 定制 SHA-256（64 hex）。
pub fn sec_ms_gec_token(ticks: i64) -> String {
    drm_v2::token(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes())
}

/// 对齐仓库 Windows edgeDrm.ts；算法来源 rany2/edge-tts drm.py（LGPL-3.0）。
/// https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py
/// 首块常量、调度修正与 CS64 均属于 v2 协议，不能替换成标准库 SHA-256。
mod drm_v2 {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const STATE: [u32; 8] = [
        0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
        0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
    ];
    const SCHEDULE: [u32; 14] = [
        0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
        0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
        0xd258b060, 0x72766564,
    ];
    const ROUNDS: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const COEFFICIENTS: [(u32, u32); 14] = [
        (0xe82e91b1, 0xb32700d0), (0x44de24c6, 0x88dff51d),
        (0x3beb65bc, 0x29514038), (0xc89c5933, 0xb328cbdf),
        (0x8d1ec211, 0xd405b4d5), (0x314ef5d5, 0x26e55f3c),
        (0xe92491b1, 0x607801c6), (0xf0a5b9d5, 0x82b2c1fb),
        (0x06064cf3, 0xfa51a3da), (0xda79fa60, 0x207cc464),
        (0xbed20560, 0x3c3c74f3), (0x89f9c9f8, 0xd2d14b61),
        (0x35fa38c6, 0xbb04a2c1), (0xcb49e3c6, 0xc5626167),
    ];

    fn sigma0(v: u32) -> u32 {
        (v >> 7) ^ (v << 25) ^ (v >> 18) ^ (v << 14) ^ (v >> 3)
    }
    fn sigma1(v: u32) -> u32 {
        (v >> 17) ^ (v << 15) ^ (v >> 19) ^ (v << 13) ^ (v >> 10)
    }
    fn expand(words: &mut [u32; 64], first: usize) {
        for i in first..64 {
            words[i] = sigma1(words[i - 2]).wrapping_add(words[i - 7])
                .wrapping_add(sigma0(words[i - 15])).wrapping_add(words[i - 16]);
        }
    }
    fn rounds(state: [u32; 8], words: &[u32; 64], first: usize) -> [u32; 8] {
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in first..64 {
            let k = if first == 14 && i == 14 { 0xc9dc06a7 } else { ROUNDS[i] };
            let t1 = h.wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add(g ^ (e & (f ^ g))).wrapping_add(k).wrapping_add(words[i]);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) | (c & (a | b)));
            [a, b, c, d, e, f, g, h] = [t1.wrapping_add(t2), a, b, c, d.wrapping_add(t1), e, f, g];
        }
        [a, b, c, d, e, f, g, h]
    }
    fn modified_sha256(data: &[u8]) -> [u8; 32] {
        let mut words = [0u32; 64];
        words[14] = u32::from_be_bytes([0, data[0], data[1], data[2]]);
        words[15] = u32::from_be_bytes(data[3..7].try_into().unwrap());
        for i in 16..30 {
            let s1 = sigma1(words[i - 2]) ^ if i == 16 { 0x000b92c0 } else { 0 };
            let s0 = if i >= 29 { sigma0(words[i - 15]) ^ 0x059c0b80 } else { 0 };
            words[i] = SCHEDULE[i - 16].wrapping_add(s1)
                .wrapping_add(if i >= 21 { words[i - 7] } else { 0 }).wrapping_add(s0);
        }
        words[30] = sigma1(words[28]).wrapping_add(words[23]).wrapping_add(sigma0(words[15]))
            .wrapping_add(words[14]).wrapping_add(0xc9dc06a7).wrapping_sub(ROUNDS[14]);
        expand(&mut words, 31);
        let working = rounds(STATE, &words, 14);
        let mut state = std::array::from_fn(|i| INITIAL[i].wrapping_add(working[i]));
        let length = 57 + data.len();
        let mut padded = data[7..].to_vec();
        padded.push(0x80);
        padded.resize(padded.len() + (55i64 - length as i64).rem_euclid(64) as usize, 0);
        padded.extend_from_slice(&(length as u64 * 8).to_be_bytes());
        for block in padded.chunks_exact(64) {
            for (i, word) in block.chunks_exact(4).enumerate() {
                words[i] = u32::from_be_bytes(word.try_into().unwrap());
            }
            expand(&mut words, 16);
            let working = rounds(state, &words, 0);
            state = std::array::from_fn(|i| state[i].wrapping_add(working[i]));
        }
        let mut out = [0u8; 32];
        for (chunk, word) in out.chunks_exact_mut(4).zip(state) {
            chunk.copy_from_slice(&word.to_be_bytes());
        }
        out
    }
    fn cs64(data: &[u8], sha: &[u8; 32]) -> [u8; 8] {
        let keys = [u32::from_le_bytes(sha[..4].try_into().unwrap()) | 1,
            u32::from_le_bytes(sha[4..8].try_into().unwrap()) | 1];
        let factors = keys.map(|k| k.wrapping_mul(0x82893933));
        let mut terms: Vec<u32> = COEFFICIENTS.iter().enumerate()
            .map(|(i, (c, _))| c.wrapping_mul(factors[i % 2])).collect();
        let mut offsets: Vec<u32> = COEFFICIENTS.iter().map(|(_, o)| *o).collect();
        let mut padded = vec![0];
        padded.extend_from_slice(data);
        padded.resize(padded.len().div_ceil(8) * 8, 0);
        for (i, bytes) in padded.chunks_exact(4).enumerate() {
            let word = u32::from_le_bytes(bytes.try_into().unwrap());
            let mut term = word.wrapping_mul(keys[i % 2]);
            let mut offset = word.rotate_left(16).wrapping_mul(if i % 2 == 0 { 0xef0569fb } else { 0xc31713db });
            if i == 0 {
                term = term.wrapping_add(0xf2f90b1au32.wrapping_mul(factors[0]));
                offset = offset.wrapping_add(0x0b1a0000);
            }
            terms.push(term);
            offsets.push(offset);
        }
        let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
        for i in (0..terms.len()).step_by(2) {
            let (x, y) = (terms[i], terms[i + 1]);
            let q = offsets[i].wrapping_add(x).rotate_left(16).wrapping_mul(0x76f50f34);
            swap_acc = swap_acc.wrapping_add(q.rotate_left(16).wrapping_mul(0xc3efea97).wrapping_add(q));
            let q = offsets[i + 1].wrapping_add(y).rotate_left(16).wrapping_mul(0x1881ce3c);
            swap_last = q.rotate_left(16).wrapping_mul(0x35bd1ec9).wrapping_add(q);
            swap_acc = swap_acc.wrapping_add(swap_last);
            state = state.wrapping_mul(keys[0]).wrapping_add(x);
            for k in [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83] {
                state = state.rotate_left(16).wrapping_mul(k);
            }
            acc = acc.wrapping_add(state);
            state = state.wrapping_mul(keys[1]).wrapping_add(y);
            for k in [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69] {
                state = state.rotate_left(16).wrapping_mul(k);
            }
            acc = acc.wrapping_add(state);
        }
        let mut out = [0u8; 8];
        out[..4].copy_from_slice(&(swap_last ^ state).to_le_bytes());
        out[4..].copy_from_slice(&(swap_acc ^ acc).to_le_bytes());
        out
    }
    pub(super) fn token(data: &[u8]) -> String {
        let sha = modified_sha256(data);
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02X}")).collect::<String>();
        format!("{}-{}", hex(&cs64(data, &sha)), hex(&sha))
    }
}

/// 拼 wss 握手地址（query 三参数，值均 URL 安全字符，无需编码）。
pub fn build_wss_url(now_secs: i64, skew_seconds: i64) -> String {
    format!(
        "{WSS_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
        sec_ms_gec_token(token_ticks(now_secs, skew_seconds))
    )
}

/// X-Timestamp 头：JS `new Date().toString()` 形态（edge-tts python 固定 UTC 后缀，
/// 服务端不校验时区真实性）。复用 auth 的 RFC1123 分量切出：星期/日/月/年/时分秒。
pub fn js_date_timestamp(secs: i64) -> String {
    let rfc = auth::rfc1123_from_unix(secs); // "Thu, 01 Oct 2026 00:00:00 GMT"
    let weekday = &rfc[0..3];
    let day: i64 = rfc[5..7].trim().parse().unwrap_or(1); // JS 不带前导零
    let mon = &rfc[8..11];
    let year = &rfc[12..16];
    let hms = &rfc[17..25];
    format!("{weekday} {mon} {day} {year} {hms} GMT+0000 (Coordinated Universal Time)")
}

/// speech.config 文本帧：指定 mp3 输出（24kHz 48kbit 单声道）。
pub fn build_speech_config_message(timestamp: &str) -> String {
    let payload = serde_json::json!({
        "context": {"synthesis": {"audio": {
            "metadataoptions": {"sentenceBoundaryEnabled": "false", "wordBoundaryEnabled": "true"},
            "outputFormat": OUTPUT_FORMAT,
        }}},
    });
    format!("X-Timestamp:{timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{payload}")
}

/// ssml 文本帧：voice 嵌入 + prosody rate（+0% 常速；语速由命令层换算百分比）。
/// 文本做 &/</> 转义；locale 取音色前两段。
pub fn build_ssml_message(voice: &str, text: &str, request_id: &str, timestamp: &str, rate_percent: i64) -> String {
    let locale: String = voice.split('-').take(2).collect::<Vec<_>>().join("-");
    let locale = if locale.is_empty() { "en-US".to_string() } else { locale };
    let safe = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let rate = if rate_percent >= 0 { format!("+{rate_percent}%") } else { format!("{rate_percent}%") };
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{locale}'><voice name='{voice}'><prosody pitch='+0Hz' rate='{rate}' volume='+0%'>{safe}</prosody></voice></speak>"
    );
    format!("X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{timestamp}\r\nPath:ssml\r\n\r\n{ssml}")
}

/// 解析一条二进制帧：返回 mp3 净荷（非音频帧返回 None）。
/// 帧结构：2 字节大端头长 + 头文本（须含 Path:audio）+ 音频字节。
pub fn parse_binary_frame(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 2 {
        return None;
    }
    let header_len = ((data[0] as usize) << 8) | data[1] as usize;
    if 2 + header_len > data.len() {
        return None;
    }
    let header = std::str::from_utf8(&data[2..2 + header_len]).ok()?;
    if !header.contains("Path:audio") {
        return None;
    }
    Some(data[2 + header_len..].to_vec())
}

/// 32 位 hex 请求 ID（uuid4 形状；时间纳秒 + 计数器 xorshift 混合，唯一性足够）。
fn request_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed) as u64;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x2545_F491_4F6C_DD1D;
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push_str(&format!("{x:016x}"));
    }
    out
}

/// 年月日 → Unix 天（Howard Hinnant days_from_civil，auth::civil_from_days 的逆）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 解析 HTTP Date 头（"Thu, 01 Oct 2026 00:00:00 GMT"）→ Unix 秒。
fn parse_http_date(s: &str) -> Option<i64> {
    const MONTHS: [(&str, i64); 12] = [
        ("Jan", 1), ("Feb", 2), ("Mar", 3), ("Apr", 4), ("May", 5), ("Jun", 6),
        ("Jul", 7), ("Aug", 8), ("Sep", 9), ("Oct", 10), ("Nov", 11), ("Dec", 12),
    ];
    let p: Vec<&str> = s.split_whitespace().collect();
    if p.len() < 5 {
        return None;
    }
    let day: i64 = p[1].parse().ok()?;
    let mon = MONTHS.iter().find(|(n, _)| *n == p[2])?.1 as u32;
    let year: i64 = p[3].parse().ok()?;
    let t: Vec<i64> = p[4].split(':').map(|x| x.parse().unwrap_or(-1)).collect();
    if t.len() != 3 || t.iter().any(|&x| x < 0) {
        return None;
    }
    Some(days_from_civil(year, mon, day as u32) * 86_400 + t[0] * 3600 + t[1] * 60 + t[2])
}

/// 用 voices 接口响应的 Date 头校准时钟（任何状态码都带 Date 头，无需请求成功）。
async fn calibrate_skew() -> Option<i64> {
    let url = format!(
        "{VOICES_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
        sec_ms_gec_token(token_ticks(now_secs(), 0))
    );
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().ok()?;
    let date = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?
        .headers()
        .get(reqwest::header::DATE)?
        .to_str()
        .ok()?
        .to_string();
    Some(parse_http_date(&date)? - now_secs())
}

/// 单次合成尝试：connect（带 UA）→ 发 config/ssml 两帧 → 收流：
/// 二进制帧剥 Path:audio 净荷累加，文本帧含 Path:turn.end 收尾（全空报错）。
async fn synthesize_once(text: &str, voice: &str, rate_percent: i64, skew_seconds: i64) -> Result<Vec<u8>, String> {
    let mut request = build_wss_url(now_secs(), skew_seconds)
        .as_str()
        .into_client_request()
        .map_err(|e| format!("连接被拒：{e}"))?;
    request.headers_mut().insert("User-Agent", HeaderValue::from_str(USER_AGENT).unwrap());
    /* 握手超时：connect_async 无内置超时，REQUEST_TIMEOUT 死线在握手成功后才起算——
       网络不可达时（SYN 丢包）命令可挂数十秒，失败重试还会再挂一轮（治 rust-tts-1） */
    let connected = tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(request))
        .await
        .map_err(|_| "Edge 连接超时（10s 未完成握手，检查网络）".to_string())?;
    let (mut ws, _) = connected.map_err(|e| {
        use tokio_tungstenite::tungstenite::Error as WsErr;
        match &e {
            WsErr::Http(resp) => format!("Edge 服务拒绝连接（HTTP {}）", resp.status().as_u16()),
            _ => format!("连接被拒：{e}"),
        }
    })?;
    let timestamp = js_date_timestamp(now_secs());
    let cfg = build_speech_config_message(&timestamp);
    let ssml = build_ssml_message(voice, text, &request_id(), &timestamp, rate_percent);
    let (mut sink, mut stream) = ws.split();
    sink.send(Message::Text(cfg)).await.map_err(|e| format!("发送失败：{e}"))?;
    sink.send(Message::Text(ssml)).await.map_err(|e| format!("发送失败：{e}"))?;

    let mut audio: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(payload) = parse_binary_frame(&data) {
                        audio.extend_from_slice(&payload);
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if t.contains("Path:turn.end") {
                        if audio.is_empty() {
                            return Err("合成返回空音频".into());
                        }
                        let _ = sink.close().await;
                        return Ok(audio);
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(if audio.is_empty() {
                        "连接被拒：网络不可达或服务暂不可用".into()
                    } else {
                        "连接提前断开（音频不完整）".into()
                    });
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => {
                    return Err(if audio.is_empty() {
                        format!("连接被拒：网络不可达（{e}）")
                    } else {
                        format!("连接提前断开（音频不完整：{e}）")
                    });
                }
            },
            _ = tokio::time::sleep_until(deadline) => {
                return Err("语音合成超时（20s 无结果）".into());
            }
        }
    }
}

/// 合成一段文本 → 整段 mp3 base64（TtsResult 形状与讯飞 TTS 一致，前端同一播放路径）。
/// 首次失败后尝试校准时钟重试一次；校准无变化/重试仍失败上抛首次错误。
pub async fn synthesize(text: &str, voice_name: Option<&str>, speed: Option<f64>) -> Result<TtsResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("合成文本为空".into());
    }
    let voice = match voice_name.map(str::trim) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            if looks_chinese(trimmed) {
                DEFAULT_VOICE.to_string()
            } else {
                DEFAULT_VOICE_EN.to_string()
            }
        }
    };
    // speed 1.0 = 常速 → prosody rate +0%；夹取 [0.5, 2.0] → [-50%, +100%]
    let rate_percent = match speed {
        None => 0,
        Some(r) if !r.is_finite() => 0,
        Some(r) => ((r.clamp(0.5, 2.0) - 1.0) * 100.0).round() as i64,
    };

    let first_skew = SKEW.load(Ordering::Relaxed);
    match synthesize_once(trimmed, &voice, rate_percent, first_skew).await {
        Ok(audio) => Ok(TtsResult { audio_b64: encode_b64(&audio), format: "mp3".into() }),
        Err(first_err) => {
            let Some(new_skew) = calibrate_skew().await else {
                return Err(first_err);
            };
            if new_skew == first_skew {
                return Err(first_err);
            }
            SKEW.store(new_skew, Ordering::Relaxed);
            match synthesize_once(trimmed, &voice, rate_percent, new_skew).await {
                Ok(audio) => Ok(TtsResult { audio_b64: encode_b64(&audio), format: "mp3".into() }),
                Err(_) => Err(first_err), // 重试仍失败：上抛首次错误（更接近根因）
            }
        }
    }
}

/// 云朗读（Edge 在线合成，免费无凭据）；返回 mp3 base64，前端 decodeAudioData 播放。
#[tauri::command]
pub async fn edge_tts_speak(
    text: String,
    voice_name: Option<String>,
    speed: Option<f64>,
) -> Result<TtsResult, String> {
    synthesize(&text, voice_name.as_deref(), speed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 金标向量由上游 Python generate_sec_ms_gec_v2 独立生成，
    /// 同时覆盖 CS64 小端序、定制 SHA-256 与跨 5 分钟窗口的时钟校准。
    #[test]
    fn sec_ms_gec_golden() {
        assert_eq!(token_ticks(1_760_000_000, 0), 134_044_734_000_000_000);
        assert_eq!(
            sec_ms_gec_token(token_ticks(1_760_000_000, 0)),
            "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D"
        );
        // skew=200 跨到下一个 5 分钟窗口
        assert_eq!(token_ticks(1_760_000_000, 200), 134_044_737_000_000_000);
        assert_eq!(
            sec_ms_gec_token(token_ticks(1_760_000_000, 200)),
            "BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C"
        );
        assert_eq!(token_ticks(0, 0), 116_444_736_000_000_000);
        assert_eq!(
            sec_ms_gec_token(token_ticks(0, 0)),
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"
        );
    }

    /// wss URL 三参数齐全、token 大写 hex。
    #[test]
    fn wss_url_shape() {
        let url = build_wss_url(1_760_000_000, 0);
        assert!(url.starts_with(&format!("{WSS_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=")));
        assert!(url.ends_with(&format!("&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}")));
        let gec = url.split("&Sec-MS-GEC=").nth(1).unwrap().split('&').next().unwrap();
        let (cs64, sha) = gec.split_once('-').unwrap();
        assert_eq!(cs64.len(), 16);
        assert_eq!(sha.len(), 64);
        assert!(cs64.chars().chain(sha.chars()).all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
        assert_eq!(SEC_MS_GEC_VERSION, "2-143.0.3650.75");
    }

    /// JS Date.toString 形态：英文星期/月份缩写 + 无前导零日 + UTC 后缀。
    #[test]
    fn js_date_timestamp_shape() {
        assert_eq!(js_date_timestamp(0), "Thu Jan 1 1970 00:00:00 GMT+0000 (Coordinated Universal Time)");
        // 2026-09-09T01:02:03Z：日 09 → 无前导零 "9"（epoch 经 Python datetime 核实）
        assert_eq!(
            js_date_timestamp(1_788_915_723),
            "Wed Sep 9 2026 01:02:03 GMT+0000 (Coordinated Universal Time)"
        );
    }

    /// 二进制帧：Path:audio 剥净荷；非音频/短帧/截断 → None。
    #[test]
    fn binary_frame_parsing() {
        let header = "X-RequestId:ab\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n";
        let mut frame = vec![(header.len() >> 8) as u8, header.len() as u8];
        frame.extend_from_slice(header.as_bytes());
        frame.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        assert_eq!(parse_binary_frame(&frame), Some(vec![0xFF, 0xFB, 0x90, 0x00]));
        // Path:turn.start 之类的文本元数据帧（也是二进制帧承载）→ None
        let meta = "Path:turn.start\r\n";
        let mut m = vec![(meta.len() >> 8) as u8, meta.len() as u8];
        m.extend_from_slice(meta.as_bytes());
        assert_eq!(parse_binary_frame(&m), None);
        assert_eq!(parse_binary_frame(&[0x00]), None);
        // 声明头长超过实际数据 → None
        assert_eq!(parse_binary_frame(&[0x00, 0x10, b'a']), None);
    }

    /// ssml：voice/locale 嵌入、文本转义、rate 符号。
    #[test]
    fn ssml_message_shape() {
        let msg = build_ssml_message("en-US-AvaNeural", "a<b & c>", "req1", "Mon Sep 29 2026", 15);
        assert!(msg.starts_with("X-RequestId:req1\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:Mon Sep 29 2026\r\nPath:ssml\r\n\r\n"));
        assert!(msg.contains("xml:lang='en-US'"));
        assert!(msg.contains("<voice name='en-US-AvaNeural'>"));
        assert!(msg.contains("rate='+15%'"));
        assert!(msg.contains("a&lt;b &amp; c&gt;"));
        // 负语速带符号；空音色 → locale 回落 en-US（与 Swift prefix(2).joined 同语义）
        let neg = build_ssml_message("weird", "hi", "r", "t", -25);
        assert!(neg.contains("rate='-25%'"));
        assert!(neg.contains("xml:lang='weird'"));
        let empty = build_ssml_message("", "hi", "r", "t", 0);
        assert!(empty.contains("xml:lang='en-US'"));
    }

    /// HTTP Date 解析与 rfc1123_from_unix 互逆（含闰年二月末）。
    #[test]
    fn http_date_roundtrip() {
        for &secs in &[0i64, 1_790_812_800, 1_740_780_799, 1_740_854_400, 951_782_400] {
            let date = auth::rfc1123_from_unix(secs);
            assert_eq!(parse_http_date(&date), Some(secs), "roundtrip {date}");
        }
        assert_eq!(parse_http_date("garbage"), None);
        assert_eq!(parse_http_date("Thu, 01 Foo 2026 00:00:00 GMT"), None);
    }

    /// 活体探针（手动跑）：`cargo test --lib edge_probe_live -- --ignored --nocapture`。
    /// 真实连微软服务合成一句中英文，验证 UA/Sec-MS-GEC/帧序列/时钟校准全链路——
    /// 上真机前必须活体验过（教训同 IAT：离线单元测试证明不了服务端接受我们的帧）。
    #[test]
    #[ignore = "诊断探针：连真实微软服务，网络可用时手动跑"]
    fn edge_probe_live() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            for (label, voice) in [
                ("中文缺省(晓晓)", None),
                ("英文指定(Ava)", Some("en-US-AvaNeural")),
            ] {
                let r = synthesize(
                    if label.starts_with("中文") { "你好，这是 Edge 在线合成测试。" } else { "Hello! This is the Edge online voice test." },
                    voice,
                    None,
                )
                .await;
                let t = r.unwrap_or_else(|e| panic!("{label} 合成失败：{e}"));
                assert_eq!(t.format, "mp3");
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(t.audio_b64).unwrap();
                assert!(bytes.len() > 1024, "{label} 返回空或过短的音频");
                assert!(bytes.starts_with(b"ID3") || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0),
                    "{label} 返回数据不是 MP3");
                println!("→ {label} 成功：mp3 {}B", bytes.len());
            }
        });
    }
}
