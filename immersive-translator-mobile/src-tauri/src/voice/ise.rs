//! 讯飞语音评测（ISE）：整段跟读音频 → 分数/词级明细。照 XfyunIse.swift。
//! - wss://ise-api.xfyun.cn/v2/open-ise，HMAC 鉴权同构（voice/auth.rs）。
//! - 首帧 ssb：business.text 明文 UTF-8，以 U+FEFF 开头 + 字面 `[content]\n` + 评测文本
//!   （XfyunIse.swift:334-360——Swift 侧因 JSONSerialization 吞 BOM 被迫手拼 JSON；
//!   serde_json 不剥字符串内字符，但用字节级单测锁定 \u{feff} 不丢）。
//! - 音频帧 1280B/帧（首帧 aus=1、其余 aus=2）；结束帧 aus=4/status=2（XfyunIse.swift:363-381）。
//! - 结果 XML 为 base64 分片，收满 data.status==2 后 join 解码；手写扫描器解析
//!   （不新增 XML 依赖）：sentence 层 total/accuracy/fluency/standard、read_chapter 层
//!   is_rejected/except_info/integrity（缺省句层兜底、再缺省 5）；word/syll/phone 的
//!   成对与自闭合两种标签都收、按文档序（漏读词常为自闭合，XfyunIse.swift:187-228）。

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use super::auth;
use super::{decode_b64, encode_b64, run_ws_once, VoiceCfg};

pub const HOST: &str = "ise-api.xfyun.cn";
pub const PATH: &str = "/v2/open-ise";
const TIMEOUT: Duration = Duration::from_secs(45);
const FRAME_BYTES: usize = super::iat::FRAME_BYTES;

/// 评测结果（分数均 5 分制；words 按文档序原样返回，对齐着色在前端做）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IseResult {
    pub total_score: f64,
    pub accuracy_score: f64,
    pub fluency_score: f64,
    pub standard_score: f64,
    pub integrity_score: f64,
    pub is_rejected: bool,
    pub except_info: Option<String>,
    pub words: Vec<IseWord>,
}

/// 词级结果。dpMessage：0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IseWord {
    pub content: String,
    pub total_score: Option<f64>,
    pub dp_message: i64,
    pub phones: Option<Vec<IsePhone>>,
}

/// 音素级结果（gwpp 是 GOP 逐音素惩罚值，绝对值越大问题越大）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsePhone {
    pub content: String,
    pub dp_message: Option<i64>,
    pub gwpp: Option<f64>,
}

/// except_info 错误码 → 用户能看懂的话（契约指定三码）。
fn except_info_text(code: &str) -> String {
    match code {
        "28673" => "没听到足够的声音——离麦克风近一点".into(),
        "28676" => "读的内容和句子差太远（乱读）".into(),
        "28680" => "背景噪音太大（信噪比低）".into(),
        other => other.to_string(),
    }
}

/// 首帧 ssb（评测文本明文 UTF-8，非 base64；以 U+FEFF 开头）。
pub fn build_first_frame(app_id: &str, text: &str) -> String {
    json!({
        "business": {
            "aue": "raw",
            "auf": "audio/L16;rate=16000",
            "category": "read_sentence",
            "cmd": "ssb",
            "ent": "en_vip",
            "sub": "ise",
            "ttp_skip": true,
            "tte": "utf-8",
            "text": format!("\u{FEFF}[content]\n{text}"),
        },
        "common": {"app_id": app_id},
        "data": {"data": "", "status": 0},
    })
    .to_string()
}

/// 音频帧（首帧 aus=1、其余 aus=2）。
pub fn build_audio_frame(piece: &[u8], first: bool) -> String {
    json!({
        "business": {"cmd": "auw", "aus": if first { 1 } else { 2 }, "aue": "raw"},
        "data": {"status": 1, "data": encode_b64(piece), "data_type": 1, "encoding": "raw"},
    })
    .to_string()
}

/// 结束帧（aus=4 / status=2）。
pub fn build_end_frame() -> String {
    json!({
        "business": {"cmd": "auw", "aus": 4, "aue": "raw"},
        "data": {"status": 2, "data": "", "data_type": 1, "encoding": "raw"},
    })
    .to_string()
}

// ---------- 手写 XML 扫描器（不新增 XML 依赖） ----------

/// 一次标签命中：自闭合标签 inner=None。
struct TagHit {
    attrs: String,
    inner: Option<String>,
}

/// 按文档序扫描 `<name attrs>…</name>` 与 `<name attrs />`（同名标签不嵌套）。
/// 成对与自闭合两种形式都收、保持出现顺序（漏读词常是自闭合）。
fn scan_tags(xml: &str, name: &str) -> Vec<TagHit> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut hits = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = xml[cursor..].find(&open) {
        let start = cursor + rel;
        cursor = start + open.len();
        // 标签名边界：后面必须是空白、'/' 或 '>'（避免 <wordx> 误命中）
        match xml[cursor..].chars().next() {
            Some(' ') | Some('\t') | Some('\r') | Some('\n') | Some('/') | Some('>') => {}
            _ => continue,
        }
        let Some(gt_rel) = xml[cursor..].find('>') else { break };
        let gt = cursor + gt_rel;
        let attrs_raw = xml[cursor..gt].to_string();
        cursor = gt + 1;
        let trimmed = attrs_raw.trim_end();
        if trimmed.ends_with('/') {
            hits.push(TagHit { attrs: trimmed[..trimmed.len() - 1].to_string(), inner: None });
        } else if let Some(close_rel) = xml[cursor..].find(&close) {
            let inner_end = cursor + close_rel;
            hits.push(TagHit {
                attrs: attrs_raw,
                inner: Some(xml[cursor..inner_end].to_string()),
            });
            cursor = inner_end + close.len();
        } else {
            // 无闭合：按自闭合兜底（attrs 照收）
            hits.push(TagHit { attrs: attrs_raw, inner: None });
        }
    }
    hits
}

/// 属性表解析：`name="value"`（值内无裸引号，XML 转义实体不还原——分数/码无需）。
fn attr_map(attrs: &str) -> HashMap<String, String> {
    let b = attrs.as_bytes();
    let mut map = HashMap::new();
    let mut i = 0usize;
    while i < b.len() {
        while i < b.len() && !(b[i].is_ascii_alphabetic() || b[i] == b'_') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let name_start = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
        }
        let name = attrs[name_start..i].to_string();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'"' {
            continue;
        }
        i += 1;
        let val_start = i;
        while i < b.len() && b[i] != b'"' {
            i += 1;
        }
        let value = attrs[val_start..i].to_string();
        if i < b.len() {
            i += 1;
        }
        map.insert(name, value);
    }
    map
}

fn fnum(map: &HashMap<String, String>, key: &str) -> f64 {
    map.get(key).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
}

fn fopt(map: &HashMap<String, String>, key: &str) -> Option<f64> {
    map.get(key).and_then(|v| v.parse::<f64>().ok())
}

fn inum(map: &HashMap<String, String>, key: &str) -> i64 {
    map.get(key).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)
}

/// 解析评测结果 XML（sentence 层四分 + read_chapter 层 is_rejected/except_info/integrity）。
pub fn parse_ise_xml(xml: &str) -> IseResult {
    let sentence_attrs = scan_tags(xml, "sentence")
        .first()
        .map(|h| attr_map(&h.attrs))
        .unwrap_or_default();
    // 篇章层缺省时句层兜底（对齐 pronunciation.ts:149/:193 口径）
    let chapter_attrs = scan_tags(xml, "read_chapter")
        .first()
        .map(|h| attr_map(&h.attrs))
        .unwrap_or_else(|| sentence_attrs.clone());

    // 词层：成对 + 自闭合按文档序合并（漏读词常为自闭合）
    let words = scan_tags(xml, "word")
        .into_iter()
        .map(|hit| {
            let attrs = attr_map(&hit.attrs);
            let phones = hit.inner.map(|inner| {
                // flat_map 已按音节展平音素（syll → phone，两种标签形式都收）
                scan_tags(&inner, "syll")
                    .into_iter()
                    .flat_map(|syll| {
                        let syll_inner = syll.inner.unwrap_or_default();
                        scan_tags(&syll_inner, "phone")
                            .into_iter()
                            .map(|ph| {
                                let a = attr_map(&ph.attrs);
                                IsePhone {
                                    content: a.get("content").cloned().unwrap_or_default(),
                                    dp_message: a.get("dp_message").and_then(|v| v.parse::<i64>().ok()),
                                    gwpp: a.get("gwpp").and_then(|v| v.parse::<f64>().ok()),
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            });
            IseWord {
                content: attrs.get("content").cloned().unwrap_or_default(),
                total_score: fopt(&attrs, "total_score"),
                dp_message: inum(&attrs, "dp_message"),
                phones,
            }
        })
        .collect();

    // except_info："0" 或缺失视为正常；错误码映射为中文
    let except_info = chapter_attrs
        .get("except_info")
        .filter(|v| !v.is_empty() && v.as_str() != "0")
        .map(|v| except_info_text(v));
    // 完整度：篇章层 integrity_score，缺了句层兜底，再缺省 5（漏读/增读会拉低它）
    let integrity_score = chapter_attrs
        .get("integrity_score")
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| sentence_attrs.get("integrity_score").and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(5.0);

    IseResult {
        total_score: fnum(&sentence_attrs, "total_score"),
        accuracy_score: fnum(&sentence_attrs, "accuracy_score"),
        fluency_score: fnum(&sentence_attrs, "fluency_score"),
        standard_score: fnum(&sentence_attrs, "standard_score"),
        integrity_score,
        is_rejected: chapter_attrs.get("is_rejected").map(String::as_str) == Some("true"),
        except_info,
        words,
    }
}

/// 整段跟读音频（16k/16bit/单声道 PCM base64）→ 评测结果。
#[tauri::command]
pub async fn xfyun_ise_assess(
    text: String,
    pcm_b64: String,
    voice: VoiceCfg,
) -> Result<IseResult, String> {
    voice.ensure()?;
    if text.trim().is_empty() {
        return Err("评测文本为空".into());
    }
    let pcm = decode_b64(&pcm_b64)?;
    if pcm.is_empty() {
        return Err("录音数据为空".into());
    }
    let url = auth::build_auth_url(&voice.api_key, &voice.api_secret, HOST, PATH);

    let mut frames: Vec<String> = Vec::new();
    let mut first = true;
    for chunk in pcm.chunks(FRAME_BYTES) {
        frames.push(build_audio_frame(chunk, first));
        first = false;
    }
    frames.push(build_end_frame());

    let mut xml_b64 = String::new();
    run_ws_once(
        &url,
        build_first_frame(&voice.app_id, &text),
        frames,
        TIMEOUT,
        |v| {
            if let Some(chunk) = v["data"]["data"].as_str() {
                xml_b64.push_str(chunk);
            }
        },
        || Ok::<(), String>(()),
    )
    .await?;
    let xml_bytes = decode_b64(&xml_b64).map_err(|_| "评测结果解码失败".to_string())?;
    let xml = String::from_utf8_lossy(&xml_bytes).into_owned();
    Ok(parse_ise_xml(&xml))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 字节级锁定：首帧序列化后必须含 U+FEFF 原始字节（EF BB BF），
    /// 后面紧跟 [content] 与转义换行 `\n`（serde_json 理论不剥 BOM，用单测钉死）。
    #[test]
    fn first_frame_keeps_bom_bytes() {
        let frame = build_first_frame("app123", "the cat sat");
        let needle = "\u{feff}[content]\\nthe cat sat".to_string();
        assert!(
            frame.contains(&needle),
            "首帧必须含 U+FEFF + [content] + 换行 + 明文文本：{frame}"
        );
        // 字节级二次确认：EF BB BF 确实在序列化输出里
        let bytes = frame.as_bytes();
        assert!(bytes.windows(3).any(|w| w == [0xEF, 0xBB, 0xBF]));
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["business"]["cmd"], "ssb");
        assert_eq!(v["business"]["ent"], "en_vip");
        assert_eq!(v["business"]["category"], "read_sentence");
        assert_eq!(v["business"]["ttp_skip"], true);
        assert_eq!(v["business"]["tte"], "utf-8");
        assert_eq!(v["common"]["app_id"], "app123");
        assert_eq!(v["data"]["status"], 0);
        // 回读还原：U+FEFF 开头
        let text = v["business"]["text"].as_str().unwrap();
        assert!(text.starts_with('\u{feff}'));
        assert_eq!(text, "\u{feff}[content]\nthe cat sat");
    }

    #[test]
    fn audio_frames_aus_sequence() {
        let f1 = build_audio_frame(&[0u8; 1280], true);
        let v: serde_json::Value = serde_json::from_str(&f1).unwrap();
        assert_eq!(v["business"]["aus"], 1);
        assert_eq!(v["business"]["cmd"], "auw");
        assert_eq!(v["data"]["status"], 1);
        assert_eq!(v["data"]["data_type"], 1);
        let f2 = build_audio_frame(&[0u8; 1280], false);
        let v: serde_json::Value = serde_json::from_str(&f2).unwrap();
        assert_eq!(v["business"]["aus"], 2);
        let end = build_end_frame();
        let v: serde_json::Value = serde_json::from_str(&end).unwrap();
        assert_eq!(v["business"]["aus"], 4);
        assert_eq!(v["data"]["status"], 2);
    }

    const SAMPLE: &str = r#"<xml_result>
  <read_chapter except_info="0" is_rejected="false" integrity_score="4.8">
    <rec_paper>
      <sentence content="the cat sat" total_score="4.2" accuracy_score="4.0" fluency_score="4.3" standard_score="4.1">
        <word content="the" total_score="4.5" dp_message="0">
          <syll content="dh ax">
            <phone content="dh" dp_message="0" gwpp="1.2"/>
            <phone content="ax" dp_message="0" gwpp="0.8"></phone>
          </syll>
        </word>
        <word content="cat" total_score="0" dp_message="16"/>
        <word content="sat" total_score="3.2" dp_message="0"><syll content="s ae t"/></word>
      </sentence>
    </rec_paper>
  </read_chapter>
</xml_result>"#;

    #[test]
    fn parse_full_sample() {
        let r = parse_ise_xml(SAMPLE);
        assert_eq!(r.total_score, 4.2);
        assert_eq!(r.accuracy_score, 4.0);
        assert_eq!(r.fluency_score, 4.3);
        assert_eq!(r.standard_score, 4.1);
        assert_eq!(r.integrity_score, 4.8);
        assert!(!r.is_rejected);
        assert!(r.except_info.is_none());
        // 按文档序：the（成对）→ cat（自闭合漏读）→ sat（成对、syll 自闭合）
        assert_eq!(r.words.len(), 3);
        assert_eq!(r.words[0].content, "the");
        assert_eq!(r.words[0].dp_message, 0);
        assert_eq!(r.words[0].total_score, Some(4.5));
        let phones = r.words[0].phones.as_ref().unwrap();
        assert_eq!(phones.len(), 2);
        assert_eq!(phones[0].content, "dh");
        assert_eq!(phones[0].gwpp, Some(1.2));
        assert_eq!(phones[1].content, "ax");
        assert_eq!(phones[1].dp_message, Some(0));
        assert_eq!(r.words[1].content, "cat");
        assert_eq!(r.words[1].dp_message, 16);
        assert!(r.words[1].phones.is_none(), "自闭合 word 无音素");
        assert_eq!(r.words[2].content, "sat");
        assert_eq!(r.words[2].phones.as_ref().unwrap().len(), 0);
    }

    #[test]
    fn parse_rejected_and_fallbacks() {
        // 无 read_chapter：句层兜底 integrity、is_rejected=false；except_info 映射中文
        let xml = r#"<xml_result><rec_paper>
          <sentence total_score="0" accuracy_score="0" fluency_score="0" standard_score="0" integrity_score="4.9">
            <word content="hello" total_score="2.0" dp_message="128"><syll content="hh ah l ow"></syll></word>
          </sentence>
        </rec_paper></xml_result>"#;
        let r = parse_ise_xml(xml);
        assert_eq!(r.integrity_score, 4.9);
        assert!(!r.is_rejected);
        assert_eq!(r.words[0].dp_message, 128);

        // 篇章层异常：is_rejected + except_info 28673 → 中文文案
        let xml2 = r#"<xml_result><read_chapter except_info="28673" is_rejected="true">
          <rec_paper><sentence total_score="0" accuracy_score="0" fluency_score="0" standard_score="0">
            <word content="hello" dp_message="32"/>
          </sentence></rec_paper>
        </read_chapter></xml_result>"#;
        let r2 = parse_ise_xml(xml2);
        assert!(r2.is_rejected);
        assert_eq!(r2.except_info.as_deref(), Some("没听到足够的声音——离麦克风近一点"));
        // 篇章/句层都无 integrity → 兜 5
        assert_eq!(r2.integrity_score, 5.0);
        // 漏读词无 total_score 属性 → None
        assert_eq!(r2.words[0].total_score, None);
        assert_eq!(r2.words[0].dp_message, 32);
    }

    #[test]
    fn attr_parser_handles_spacing() {
        let m = attr_map(" content = \"wör x\" dp_message='16' total_score=\"3.5\" ");
        // 单引号属性不认（ISE 输出全双引号），双引号带空格值要完整收
        assert_eq!(m.get("content").map(String::as_str), Some("wör x"));
        assert_eq!(m.get("total_score").map(String::as_str), Some("3.5"));
        assert!(!m.contains_key("dp_message"));
    }

    #[test]
    fn scan_tags_skips_longer_names() {
        let xml = r#"<word content="a"/><wordpad content="x"/><word content="b"></word>"#;
        let hits = scan_tags(xml, "word");
        assert_eq!(hits.len(), 2);
        assert_eq!(attr_map(&hits[0].attrs).get("content").unwrap(), "a");
        assert_eq!(attr_map(&hits[1].attrs).get("content").unwrap(), "b");
        assert!(hits[0].inner.is_none());
        assert_eq!(hits[1].inner.as_deref(), Some(""));
    }

    /// 活体探针（手动跑）：XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET 齐全时
    /// `cargo test --lib ise_probe_live -- --ignored --nocapture`。
    /// 用真实凭据跑一次「静音评测」验证首帧参数合法性——ISE 帧自 Windows→Mac→Rust
    /// 两级移植，本机 keychain 无凭据证明 Mac 从未真跑过，上真机前必须活体验一遍。
    #[test]
    #[ignore = "诊断探针：需真实讯飞凭据（环境变量注入）"]
    fn ise_probe_live() {
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
            let text = "Today is a good day.";
            println!("首帧: {}", build_first_frame(app_id.trim(), text).replace(app_id.trim(), "***"));
            let url = auth::build_auth_url(&key, &secret, HOST, PATH);
            let (ws, _) = match connect_async(url).await {
                Ok(w) => w,
                Err(e) => return println!("握手失败: {e}"),
            };
            let (mut sink, mut stream) = ws.split();
            if let Err(e) = sink.send(Message::Text(build_first_frame(app_id.trim(), text))).await {
                return println!("首帧发送失败: {e}");
            }
            // 2 秒静音（50 帧 × 40ms；首帧 aus=1，其余 aus=2）
            let silence = vec![0u8; FRAME_BYTES];
            for i in 0..50 {
                if sink.send(Message::Text(build_audio_frame(&silence, i == 0))).await.is_err() {
                    return println!("音频帧发送失败（第 {} 帧）", i + 1);
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            if sink.send(Message::Text(build_end_frame())).await.is_err() {
                return println!("结束帧发送失败");
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                tokio::select! {
                    msg = stream.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            let head: String = t.chars().take(300).collect();
                            println!("讯飞回包: {head}");
                            if t.contains("\"status\":2") {
                                return println!("→ ISE 会话跑通（帧参数合法；静音评测出低分/except_info 属预期）");
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
                    _ = tokio::time::sleep_until(deadline) => return println!("→ 15s 无回包"),
                }
            }
        });
    }
}
