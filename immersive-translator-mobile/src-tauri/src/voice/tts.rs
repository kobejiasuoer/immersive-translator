//! 讯飞在线语音合成（wss://tts-api.xfyun.cn/v2/tts），逐行照
//! mac/Sources/XfyunCore/XfyunTts.swift（本文件以它为准）：
//! - 单帧请求：common{app_id} + business{aue:"lame"(mp3), sfl:1, auf,
//!   vcn, tte:"UTF8", speed/volume/pitch 0-100} + data{text: base64, status: 2}；
//! - 响应：流式返回 data.audio（mp3 分片，每帧独立带 padding 的 base64，
//!   必须逐帧解码再按字节拼接），累计到 data.status==2 拼完整音频；
//! - 单次文本 base64 前 < 8000 字节；返回整段 mp3 的 base64；
//! - 音色缺省（XfyunTts.swift:18-21,33-49）：中文句 xiaoyan、英文句 catherine
//!   （英文句与中文句分音色，跟读示范不用中文音色读英文）；
//! - 语速：Swift 端恒按 1× 合成（speed=50）、变速由播放端承担；本命令带
//!   speed:Option<f64>（1.0=常速），映射 speed100 = clamp(round(rate*50),0,100)，
//!   None → 50（Swift 默认，行为与 Mac 完全一致）。

use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::json;

use super::auth;
use super::{encode_b64, run_ws_once, VoiceCfg};

pub const HOST: &str = "tts-api.xfyun.cn";
pub const PATH: &str = "/v2/tts";
/// 官方限制：base64 编码前 < 8000 字节（约 2000 汉字，XfyunTts.swift:17）。
pub const MAX_TEXT_BYTES: usize = 8000;
pub const DEFAULT_VCN: &str = "xiaoyan";
pub const DEFAULT_VCN_EN: &str = "catherine";
const TIMEOUT: Duration = Duration::from_secs(20);
/// Swift 默认音量 0–100（XfyunTtsOptions init volume: 50）。
const VOLUME: i64 = 50;
/// Swift 默认语速（1×，播放端变速）。
const SPEED_1X: i64 = 50;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    pub audio_b64: String,
    pub format: String,
}

/// 语速（1.0=常速）→ 讯飞 0-100 整数（50=1×）。None → 50。
fn map_speed(speed: Option<f64>) -> i64 {
    match speed {
        None => SPEED_1X,
        Some(rate) => (rate * 50.0).round().clamp(0.0, 100.0) as i64,
    }
}

/// 合成文本的语言判定（选 cn/en 音色）：CJK 为主判中文（XfyunTts.swift:33-48）。
pub fn looks_chinese(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut latin = 0usize;
    for scalar in text.chars() {
        match scalar as u32 {
            0x4E00..=0x9FFF | 0x3400..=0x4DBF => cjk += 1,
            0x41..=0x5A | 0x61..=0x7A => latin += 1,
            _ => {}
        }
    }
    cjk * 2 >= latin
}

/// 音色选择：显式给定（空串视为缺省）→ 缺省按语言分音色。
fn resolve_vcn(voice_name: Option<&str>, text: &str) -> String {
    match voice_name.map(str::trim) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            if looks_chinese(text) {
                DEFAULT_VCN.to_string()
            } else {
                DEFAULT_VCN_EN.to_string()
            }
        }
    }
}

/// 构造一次性请求帧（单测可构造）。data.status=2：一帧发完整段文本。
pub fn build_request_frame(app_id: &str, text: &str, vcn: &str, speed100: i64) -> String {
    json!({
        "common": {"app_id": app_id},
        "business": {
            "aue": "lame",
            "sfl": 1,
            "auf": "audio/L16;rate=16000",
            "vcn": vcn,
            "tte": "UTF8",
            "speed": speed100,
            "volume": VOLUME,
            "pitch": 50,
        },
        "data": {
            "status": 2,
            "text": encode_b64(text.as_bytes()),
        },
    })
    .to_string()
}

/// 合成一段文本，返回整段 mp3 的 base64（mp3 帧逐帧解码再按字节拼接）。
#[tauri::command]
pub async fn xfyun_tts_speak(
    text: String,
    voice_name: Option<String>,
    speed: Option<f64>,
    voice: VoiceCfg,
) -> Result<TtsResult, String> {
    voice.ensure()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("合成文本为空".into());
    }
    if trimmed.len() >= MAX_TEXT_BYTES {
        return Err("文本太长（单次 < 8000 字节，请按句朗读）".into());
    }
    let url = auth::build_auth_url(&voice.api_key, &voice.api_secret, HOST, PATH);
    let vcn = resolve_vcn(voice_name.as_deref(), trimmed);
    let frame = build_request_frame(&voice.app_id, trimmed, &vcn, map_speed(speed));

    let mut audio: Vec<u8> = Vec::new();
    run_ws_once(
        &url,
        frame,
        Vec::new(),
        TIMEOUT,
        |v| {
            if let Some(chunk) = v["data"]["audio"].as_str() {
                // 每帧独立带 padding 的 base64，逐帧解码再按字节拼接
                if let Ok(piece) = base64::engine::general_purpose::STANDARD.decode(chunk) {
                    audio.extend_from_slice(&piece);
                }
            }
        },
        || Ok::<(), String>(()),
    )
    .await?;
    if audio.is_empty() {
        return Err("合成返回空音频".into());
    }
    Ok(TtsResult { audio_b64: encode_b64(&audio), format: "mp3".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_frame_shape() {
        let frame = build_request_frame("app1", "你好", "xiaoyan", 50);
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["common"]["app_id"], "app1");
        assert_eq!(v["business"]["aue"], "lame");
        assert_eq!(v["business"]["sfl"], 1);
        assert_eq!(v["business"]["auf"], "audio/L16;rate=16000");
        assert_eq!(v["business"]["vcn"], "xiaoyan");
        assert_eq!(v["business"]["tte"], "UTF8");
        assert_eq!(v["business"]["speed"], 50);
        assert_eq!(v["business"]["volume"], 50);
        assert_eq!(v["business"]["pitch"], 50);
        assert_eq!(v["data"]["status"], 2);
        assert_eq!(v["data"]["text"], encode_b64("你好".as_bytes()));
    }

    #[test]
    fn speed_mapping() {
        assert_eq!(map_speed(None), 50);
        assert_eq!(map_speed(Some(1.0)), 50);
        assert_eq!(map_speed(Some(0.5)), 25);
        assert_eq!(map_speed(Some(1.5)), 75);
        assert_eq!(map_speed(Some(2.0)), 100);
        assert_eq!(map_speed(Some(9.9)), 100, "封顶 100");
        assert_eq!(map_speed(Some(-1.0)), 0, "下限 0");
    }

    #[test]
    fn vcn_language_defaults() {
        assert_eq!(resolve_vcn(Some("aisjiuxu"), "hello"), "aisjiuxu");
        assert_eq!(resolve_vcn(Some("  "), "hello"), "catherine", "空白视为缺省");
        assert_eq!(resolve_vcn(None, "你好世界"), "xiaoyan");
        assert_eq!(resolve_vcn(None, "Hello world this is English"), "catherine");
        // 空文本：cjk*2 >= latin → 0>=0 → 判中文（与 Mac looksChinese 同构）
        assert_eq!(resolve_vcn(None, ""), "xiaoyan");
    }

    #[test]
    fn looks_chinese_port() {
        assert!(looks_chinese("今天天气不错"));
        assert!(looks_chinese("中英混合 ok 吗"));
        assert!(!looks_chinese("The quick brown fox"));
    }

    /// 活体探针（手动跑）：XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET 齐全时
    /// `cargo test --lib tts_probe_live -- --ignored --nocapture`。
    /// 真实凭据合成一句中文，验证单帧请求形状与 mp3 分片回包（Mac 链路从未真跑过）。
    #[test]
    #[ignore = "诊断探针：需真实讯飞凭据（环境变量注入）"]
    fn tts_probe_live() {
        use futures_util::{SinkExt, StreamExt};
        use std::time::Duration;
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        let app_id = std::env::var("XFYUN_APP_ID").expect("缺 XFYUN_APP_ID");
        let key = std::env::var("XFYUN_API_KEY").expect("缺 XFYUN_API_KEY");
        let secret = std::env::var("XFYUN_API_SECRET").expect("缺 XFYUN_API_SECRET");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let frame = build_request_frame(app_id.trim(), "你好，这是合成测试。", DEFAULT_VCN, SPEED_1X);
            println!("请求帧: {}", frame.replace(app_id.trim(), "***"));
            let url = auth::build_auth_url(&key, &secret, HOST, PATH);
            let (ws, _) = match connect_async(url).await {
                Ok(w) => w,
                Err(e) => return println!("握手失败: {e}"),
            };
            let (mut sink, mut stream) = ws.split();
            if let Err(e) = sink.send(Message::Text(frame)).await {
                return println!("请求帧发送失败: {e}");
            }
            let mut audio_bytes = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                tokio::select! {
                    msg = stream.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                                println!("非 JSON 回包: {t}");
                                continue;
                            };
                            let code = v["code"].as_i64().unwrap_or(-1);
                            let status = v["data"]["status"].as_i64().unwrap_or(-1);
                            let chunk = v["data"]["audio"].as_str().map(|a| crate::voice::decode_b64(a).map(|b| b.len()).unwrap_or(0)).unwrap_or(0);
                            audio_bytes += chunk;
                            println!("回包: code={code} status={status} 分片 {chunk}B / 累计 {audio_bytes}B");
                            if code != 0 {
                                return println!("→ TTS 失败: {}", v["message"].as_str().unwrap_or(""));
                            }
                            if status == 2 {
                                return println!("→ TTS 会话跑通（合计 mp3 {audio_bytes}B）");
                            }
                        }
                        Some(Ok(Message::Close(f))) => return println!(
                            "→ 服务端关闭: {:?}",
                            f.map(|fr| (u16::from(fr.code), fr.reason.to_string()))
                        ),
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => return println!("→ WS 错误: {e}"),
                        None => return println!("→ 流结束"),
                    },
                    _ = tokio::time::sleep_until(deadline) => return println!("→ 15s 无回包（累计 {audio_bytes}B）"),
                }
            }
        });
    }
}
