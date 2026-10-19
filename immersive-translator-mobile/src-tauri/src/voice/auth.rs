//! 讯飞 WebAPI 共享鉴权（IAT/ISE/TTS 同构）。
//! 逐行对照 mac/Sources/XfyunCore/XfyunAuth.swift:29-85：
//! - RFC1123 GMT date **手拼英文星期/月份缩写**（禁本地化 strftime——iOS 设备
//!   区域设成中文时 strftime 会吐「星期四」，讯飞只认英文缩写）；
//! - 签名原文 `host: {host}\ndate: {date}\nGET {path} HTTP/1.1`；
//! - HMAC-SHA256(apiSecret) → base64 → authorizationOrigin → base64 → 握手 URL
//!   authorization/date/host 三参数（百分号编码对齐 Swift URLComponents）。

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// 天数 → 公历年月日（Howard Hinnant civil_from_days，1970-03-01 起算的算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Unix 秒 → RFC1123 GMT（如 `Thu, 01 Oct 2026 00:00:00 GMT`）。
/// 1970-01-01 是星期四；手拼英文缩写，与 Swift `DateFormatter(en_US_POSIX + GMT)` 同构。
pub fn rfc1123_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let weekday = WEEKDAYS[days.rem_euclid(7) as usize];
    format!(
        "{weekday}, {d:02} {mon} {y:04} {hh:02}:{mi:02}:{ss:02} GMT",
        mon = MONTHS[(m - 1) as usize],
        hh = rem / 3600,
        mi = (rem % 3600) / 60,
        ss = rem % 60,
    )
}

/// 当前时刻的 RFC1123 GMT（契约指定的导出面；Rust 内部走 build_auth_url，
/// 格式由下方单测锁定）。
#[allow(dead_code)]
pub fn rfc1123_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc1123_from_unix(secs)
}

/// 百分号编码（对齐 Swift URLComponents 的 queryItem 行为：空格 %20、base64 的 +/= 也编码）。
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 构造带签名的 wss 握手地址（固定时刻，便于对拍单测）。
/// 对照 XfyunAuth.swift:44-66：签名原文 → HMAC-SHA256 → base64 →
/// authorizationOrigin → base64 → query 三参数。
pub fn build_auth_url_at(api_key: &str, api_secret: &str, host: &str, path: &str, unix_secs: i64) -> String {
    let date = rfc1123_from_unix(unix_secs);
    let signature_origin = format!("host: {host}\ndate: {date}\nGET {path} HTTP/1.1");
    let mut mac = HmacSha256::new_from_slice(api_secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(signature_origin.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let authorization_origin = format!(
        "api_key=\"{api_key}\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"{signature}\""
    );
    let authorization = base64::engine::general_purpose::STANDARD.encode(authorization_origin.as_bytes());
    format!(
        "wss://{host}{path}?authorization={}&date={}&host={}",
        url_encode(&authorization),
        url_encode(&date),
        host
    )
}

/// 当前时刻的握手地址。
pub fn build_auth_url(api_key: &str, api_secret: &str, host: &str, path: &str) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    build_auth_url_at(api_key, api_secret, host, path, secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 固定时刻对拍（Swift 口径：en_US_POSIX + GMT 的 `EEE, dd MMM yyyy HH:mm:ss 'GMT'`）。
    /// 1790812800 = 2026-10-01T00:00:00Z = 星期四。
    #[test]
    fn rfc1123_fixed_epoch() {
        assert_eq!(rfc1123_from_unix(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(rfc1123_from_unix(1790812800), "Thu, 01 Oct 2026 00:00:00 GMT");
        assert_eq!(rfc1123_from_unix(951782400), "Tue, 29 Feb 2000 00:00:00 GMT");
        // 2 月→3 月滚月（epoch 值与期望串均经 Python datetime 独立核实）
        assert_eq!(rfc1123_from_unix(1740780799), "Fri, 28 Feb 2025 22:13:19 GMT");
        assert_eq!(rfc1123_from_unix(1740854400), "Sat, 01 Mar 2025 18:40:00 GMT");
    }

    /// 全链路金标：签名/authorization/URL 编码与 Swift（XfyunAuth.swift:52-65）一致。
    /// 期望值由独立 Python hmac/hashlib/base64 计算生成（见会话记录），非自证。
    #[test]
    fn auth_url_golden() {
        let url = build_auth_url_at("testKey", "testSecret", "iat-api.xfyun.cn", "/v2/iat", 1790812800);
        let expected = "wss://iat-api.xfyun.cn/v2/iat?authorization=YXBpX2tleT0idGVzdEtleSIsIGFsZ29yaXRobT0iaG1hYy1zaGEyNTYiLCBoZWFkZXJzPSJob3N0IGRhdGUgcmVxdWVzdC1saW5lIiwgc2lnbmF0dXJlPSJpV2hGSTJIK2FHUmJ0N1g4TStTUzVkb0JESHdpOVhqYi9HL2p5UGxHVVJzPSI%3D&date=Thu%2C%2001%20Oct%202026%2000%3A00%3A00%20GMT&host=iat-api.xfyun.cn";
        assert_eq!(url, expected);
    }

    /// rfc1123_now()：当前时刻也必须是严格的 RFC1123 GMT 形状（英文缩写 + GMT）。
    #[test]
    fn rfc1123_now_shape() {
        let now = rfc1123_now();
        let re = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        assert!(re.iter().any(|d| now.starts_with(&format!("{d}, "))), "{now}");
        assert!(now.ends_with(" GMT"), "{now}");
        assert_eq!(now.len(), "Thu, 01 Oct 2026 00:00:00 GMT".len(), "{now}");
    }

    /// 参数顺序敏感：签名原文必须严格 host/date/GET path。
    #[test]
    fn signature_origin_shape() {
        let url = build_auth_url_at("k", "s", "ise-api.xfyun.cn", "/v2/open-ise", 0);
        // authorization 是确定的（固定输入），URL 骨架三参数齐全
        assert!(url.starts_with("wss://ise-api.xfyun.cn/v2/open-ise?authorization="));
        assert!(url.contains("&date=Thu%2C%2001%20Jan%201970%2000%3A00%3A00%20GMT&host=ise-api.xfyun.cn"));
    }
}
