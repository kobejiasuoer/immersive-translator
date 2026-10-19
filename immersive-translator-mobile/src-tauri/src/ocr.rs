//! 讯飞印刷文字识别（OCR）WebAPI。
//! POST https://webapi.xfyun.cn/v1/service/v1/ocr/general（鉴权口径本会话已从官方文档核实）：
//! - 表单字段 `image` = base64 图像（jpg/png/bmp，≤4M，前端已编码好传入）；
//! - 头 X-Appid / X-CurTime(UTC 秒) / X-Param=base64({"language":..,"location":"false"})
//!   / X-CheckSum=MD5(apiKey+curTime+param) 32 位小写（拼接顺序用单测锁定）；
//! - code=="0" → data.block[].line[].word[].content 按行拼接（行内空格连接、行间 \n）；
//!   code!="0" → Err（含 desc 与 code）。
//! 凭据同样经 voice: VoiceCfg 传入（本接口用 appId+apiKey；Rust 不落盘）。

use base64::Engine;
use md5::{Digest, Md5};
use serde::Serialize;

use crate::voice::VoiceCfg;

pub const URL: &str = "https://webapi.xfyun.cn/v1/service/v1/ocr/general";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub lines: Vec<String>,
}

/// X-Param：base64({"language":<lang>,"location":"false"})。
fn build_param(language: &str) -> String {
    let json = format!("{{\"language\":\"{language}\",\"location\":\"false\"}}");
    base64::engine::general_purpose::STANDARD.encode(json.as_bytes())
}

/// X-CheckSum：MD5(apiKey + curTime + param) → 32 位小写 hex。
fn build_check_sum(api_key: &str, cur_time: &str, param: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(api_key.as_bytes());
    hasher.update(cur_time.as_bytes());
    hasher.update(param.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn utc_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 从 code=="0" 的响应里拼行：data.block[].line[].word[].content，
/// 行内空格连接、行间 `\n`。
fn extract_lines(data: &serde_json::Value) -> Vec<String> {
    let mut lines = Vec::new();
    for block in data["data"]["block"].as_array().into_iter().flatten() {
        for line in block["line"].as_array().into_iter().flatten() {
            let mut words = Vec::new();
            for word in line["word"].as_array().into_iter().flatten() {
                if let Some(content) = word["content"].as_str() {
                    words.push(content.to_string());
                }
            }
            if !words.is_empty() {
                lines.push(words.join(" "));
            }
        }
    }
    lines
}

/// 图像 base64 → 识别文本。language ∈ "en" | "cn|en"。
#[tauri::command]
pub async fn ocr_image(
    image_b64: String,
    language: String,
    voice: VoiceCfg,
) -> Result<OcrResult, String> {
    voice.ensure()?;
    if language != "en" && language != "cn|en" {
        return Err(format!("不支持的语言 {language}（仅 en / cn|en）"));
    }
    let trimmed = image_b64.trim();
    if trimmed.is_empty() {
        return Err("图像数据为空".into());
    }
    let param = build_param(&language);
    let cur_time = utc_secs().to_string();
    let check_sum = build_check_sum(voice.api_key.trim(), &cur_time, &param);

    let client = reqwest::Client::new();
    let resp = client
        .post(URL)
        .header("X-Appid", voice.app_id.trim())
        .header("X-CurTime", &cur_time)
        .header("X-Param", &param)
        .header("X-CheckSum", &check_sum)
        .form(&[("image", trimmed)])
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("HTTP {} · {}", status.as_u16(), snippet));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "OCR 响应格式异常".to_string())?;
    let code = v["code"].as_str().unwrap_or("");
    if code != "0" {
        let desc = v["desc"].as_str().unwrap_or("");
        return Err(format!("OCR 失败（{code}）：{desc}"));
    }
    let lines = extract_lines(&v);
    let text = lines.join("\n");
    Ok(OcrResult { text, lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// X-Param 金标（独立 Python base64 计算，非自证）。
    #[test]
    fn param_golden() {
        assert_eq!(
            build_param("en"),
            "eyJsYW5ndWFnZSI6ImVuIiwibG9jYXRpb24iOiJmYWxzZSJ9"
        );
    }

    /// CheckSum 拼接顺序锁定：必须严格 apiKey → curTime → param。
    /// 期望值由独立 Python hashlib.md5("k11700000000cGFyYW0=") 计算。
    #[test]
    fn check_sum_concat_order() {
        assert_eq!(
            build_check_sum("k1", "1700000000", "cGFyYW0="),
            "e943003877154cf0e388d2c8032f33de"
        );
        assert_eq!(build_check_sum("abc", "", ""), "900150983cd24fb0d6963f7d28e17f72");
        // 顺序错了就对不上（apiKey/curTime 交换后哈希必变）
        assert_ne!(
            build_check_sum("1700000000", "k1", "cGFyYW0="),
            "e943003877154cf0e388d2c8032f33de"
        );
    }

    #[test]
    fn extract_lines_joins_words_and_rows() {
        let v: serde_json::Value = serde_json::from_str(r#"{
            "code": "0",
            "data": {"block": [
                {"line": [
                    {"word": [{"content": "Hello"}, {"content": "world"}]},
                    {"word": [{"content": "第二行"}]}
                ]},
                {"line": [
                    {"word": [{"content": "third"}]},
                    {"word": []}
                ]}
            ]}
        }"#)
        .unwrap();
        assert_eq!(extract_lines(&v), vec!["Hello world", "第二行", "third"]);
    }
}
