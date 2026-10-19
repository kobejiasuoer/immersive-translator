//! 讯飞语音三链路（IAT 流式听写 / ISE 评测 / TTS 合成）共享层：
//! - 凭据结构 VoiceCfg（前端每次调用传入，Rust 不落盘）；
//! - 错误码 → 用户可读中文（表照 mac/Sources/XfyunCore/XfyunAuth.swift:179-204）；
//! - 单次 WS 会话公用骨架：connect → 首帧 → 音频帧 → 收流到 data.status==2，
//!   超时用 `tokio::select!` 收流 vs 定时器竞速（照 XfyunAuth.swift:141-176）；
//! - IAT 流式会话注册表（asr_push/asr_finish/asr_abort 按 sessionId 寻址）；
//! - 1280B（=40ms @16k/16bit）切帧器。
//! 只处理文本帧（二进制帧跳过）；PCM 由前端完成 Float→Int16，Rust 只收 base64 bytes。

pub mod auth;
pub mod edge_tts;
pub mod iat;
pub mod ise;
pub mod tts;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// 讯飞语音凭据（camelCase 嵌套，A2 从 settings 组装传入）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCfg {
    pub app_id: String,
    pub api_key: String,
    pub api_secret: String,
}

impl VoiceCfg {
    /// 三项齐全才放行（对齐 XfyunCredentials.isComplete，XfyunAuth.swift:21-24）。
    pub fn ensure(&self) -> Result<(), String> {
        if self.app_id.trim().is_empty()
            || self.api_key.trim().is_empty()
            || self.api_secret.trim().is_empty()
        {
            return Err("未配置讯飞凭据：请在设置中填写语音 AppID / API Key / API Secret".into());
        }
        Ok(())
    }
}

/// 三服务共用的业务错误码 → 中文（XfyunAuth.swift:179-204 逐条照抄）。
/// 讯飞原始 message **永远拼在后面**——10163 等「参数校验失败」的 message 会点名
/// 具体非法参数（如 `param validate error: /business 'sub'`），丢掉它等于丢掉病因。
pub fn err_text(code: i64, message: &str) -> String {
    let known = match code {
        10005 => Some("APPID 授权失败（检查讯飞凭据）"),
        10006 => Some("请求缺少必传参数"),
        10007 => Some("参数非法"),
        10109 => Some("文本长度超限"),
        10163 => Some("参数不合法（缺少必传参数或字段非法）"),
        10200 => Some("读取超时"),
        10221 => Some("服务器无可用连接，稍后再试"),
        10313 => Some("APPID 与 API Key 不匹配"),
        11200 => Some("讯飞该服务未授权（控制台确认已开通）"),
        11201 => Some("今日免费调用次数已用完"),
        11202 => Some("请求频率超限，稍后再试"),
        40007 => Some("音频解码失败（采样率应为 16k/16bit/单声道）"),
        48195 => Some("评测文本格式错误"),
        48205 => Some("没有评测到音频"),
        68675 => Some("语音数据异常"),
        68676 => Some("读的内容和句子差太远（乱读）"),
        10803 => Some("连接超时：检查网络后重试"),
        10105 => Some("授权失败：APPID 与 API Key 不匹配，或该应用未开通此服务"),
        10110 => Some("请求超时，请重试"),
        10160 => Some("请求数据非法"),
        10161 => Some("音频 base64 解码失败"),
        _ => None,
    };
    match (known, message.is_empty()) {
        (Some(text), true) => text.to_string(),
        (Some(text), false) => format!("{text}｜{message}"),
        (None, true) => format!("请求失败（{code}）"),
        (None, false) => format!("请求失败：{message}（{code}）"),
    }
}

/// ws close 401/403 专属文案（XfyunSessionError.closed，XfyunAuth.swift:78-83）。
pub fn close_err_text(code: u16, reason: &str) -> String {
    match code {
        401 => "鉴权失败：检查 API Key / API Secret".into(),
        403 => "被拒：IP 白名单或系统时间偏差超 5 分钟".into(),
        code => {
            if reason.is_empty() {
                format!("连接断开（{code}）")
            } else {
                format!("连接断开（{code} {reason}）")
            }
        }
    }
}

/// tungstenite 错误 → 中文（握手 HTTP 401/403 与 close 帧同文案）。
pub fn ws_err_text(e: tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error as WsErr;
    match &e {
        WsErr::Http(resp) => match resp.status().as_u16() {
            401 => "鉴权失败：检查 API Key / API Secret".into(),
            403 => "被拒：IP 白名单或系统时间偏差超 5 分钟".into(),
            code => format!("连接失败（HTTP {code}）"),
        },
        _ => format!("网络错误：{e}"),
    }
}

/// base64（标准字母表，容忍首尾空白）→ bytes。
pub fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|_| "音频 base64 解码失败".to_string())
}

pub fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 单次（非流式推送）WS 会话骨架：首帧 + 预置帧 → 收流到 data.status==2。
/// ISE / TTS 共用；超时与收流用 `tokio::select!` 竞速（XfyunAuth.swift:141-176）。
/// `on_message` 收每条业务消息（code==0 才会进来）；`finish` 在收满时计算结果。
pub async fn run_ws_once<R>(
    url: &str,
    first_frame: String,
    extra_frames: Vec<String>,
    timeout: Duration,
    mut on_message: impl FnMut(&serde_json::Value),
    mut finish: impl FnMut() -> Result<R, String>,
) -> Result<R, String> {
    /* 握手超时：connect_async 无内置超时，收流死线在握手成功后才起算（治 rust-tts-1） */
    let (ws, _) = tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(url.to_string()))
        .await
        .map_err(|_| "语音服务连接超时（10s 未完成握手，检查网络）".to_string())?
        .map_err(ws_err_text)?;
    let (mut sink, mut stream) = ws.split();
    /* 归因兜底（治 rust-ise-1）：此前先把全部帧发完才进收流循环——服务端在首帧校验
       阶段回错误并断连时，剩余帧的 send 先以「网络错误：Broken pipe」失败，真实错误码
       （48195/10163 等）永不被读取。发送失败时先抢救服务端已回的那条消息（≤2s），
       读得到错误 JSON 就以它为准；读不到再回落发送侧网络错误（丢 message 等于丢病因）。 */
    for frame in std::iter::once(first_frame).chain(extra_frames.into_iter()) {
        if let Err(send_err) = sink.send(Message::Text(frame)).await {
            if let Ok(Some(Ok(Message::Text(text)))) =
                tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await
            {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(code) = v["code"].as_i64() {
                        if code != 0 {
                            return Err(err_text(code, v["message"].as_str().unwrap_or("")));
                        }
                    }
                }
            }
            return Err(ws_err_text(send_err));
        }
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                        if let Some(code) = v["code"].as_i64() {
                            if code != 0 {
                                return Err(err_text(code, v["message"].as_str().unwrap_or("")));
                            }
                        }
                        on_message(&v);
                        if v["data"]["status"].as_i64() == Some(2) {
                            let result = finish()?;
                            let _ = sink.close().await;
                            return Ok(result);
                        }
                    }
                    Some(Ok(Message::Close(Some(frame)))) => {
                        return Err(close_err_text(u16::from(frame.code), frame.reason.as_ref()));
                    }
                    Some(Ok(Message::Close(None))) => return Err("连接断开".into()),
                    // 二进制帧跳过（只处理文本帧）
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(ws_err_text(e)),
                    None => return Err("连接断开".into()),
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(format!("{}s 无结果", timeout.as_secs()));
            }
        }
    }
}

/// 1280B 切帧器：任意长度字节流进、整帧出（不足一帧留在缓冲）。
/// IAT/ISE 音频 1280B/帧 = 40ms @16k/16bit/单声道。
pub struct FrameSlicer {
    frame_bytes: usize,
    buf: Vec<u8>,
}

impl FrameSlicer {
    pub fn new(frame_bytes: usize) -> Self {
        Self { frame_bytes, buf: Vec::new() }
    }

    /// 追加字节，弹出所有凑满整帧的切片。
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while self.buf.len() >= self.frame_bytes {
            let frame: Vec<u8> = self.buf.drain(..self.frame_bytes).collect();
            out.push(frame);
        }
        out
    }

    /// 取出剩余不足一帧的尾巴（结束前 flush 用；可能为空）。
    pub fn take_rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

// ---------- IAT 流式会话注册表（asr_push/asr_finish/asr_abort 寻址） ----------

/// 注册表里的一条 IAT 会话：往后台任务发指令的通道。
pub struct IatHandle {
    pub tx: mpsc::UnboundedSender<iat::IatCommand>,
}

fn registry() -> &'static Mutex<HashMap<String, IatHandle>> {
    static REG: OnceLock<Mutex<HashMap<String, IatHandle>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 会话死因登记：后台任务带错误退出时存原始错误（如讯飞 10105 授权失败），
/// 让后续 asr_push/asr_finish 报出真实原因，而不是笼统的「会话已失效」。
fn err_registry() -> &'static Mutex<HashMap<String, String>> {
    static ERRS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ERRS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn session_error_set(id: &str, msg: String) {
    err_registry().lock().unwrap().insert(id.to_string(), msg);
}

pub fn session_error_get(id: &str) -> Option<String> {
    err_registry().lock().unwrap().get(id).cloned()
}

/** 会话已不在时的错误文案：有死因报死因，没有才是泛化的「已失效」。 */
pub fn session_gone_err(id: &str) -> String {
    match session_error_get(id) {
        Some(e) => format!("会话已结束：{e}"),
        None => "会话已失效，请重试".to_string(),
    }
}

pub fn session_insert(id: String, handle: IatHandle) {
    err_registry().lock().unwrap().remove(&id);
    registry().lock().unwrap().insert(id, handle);
}

pub fn session_remove(id: &str) {
    registry().lock().unwrap().remove(id);
}

pub fn session_get(id: &str) -> Option<mpsc::UnboundedSender<iat::IatCommand>> {
    registry().lock().unwrap().get(id).map(|h| h.tx.clone())
}

pub fn session_exists(id: &str) -> bool {
    registry().lock().unwrap().contains_key(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn err_text_known_and_fallback() {
        assert_eq!(err_text(10005, ""), "APPID 授权失败（检查讯飞凭据）");
        // 已知码也必须拼上讯飞原始 message（10163 的 message 点名非法参数，丢不得）
        assert_eq!(err_text(11201, "daily limit"), "今日免费调用次数已用完｜daily limit");
        assert_eq!(
            err_text(10163, "param validate error: /business 'sub'"),
            "参数不合法（缺少必传参数或字段非法）｜param validate error: /business 'sub'"
        );
        assert_eq!(err_text(40007, ""), "音频解码失败（采样率应为 16k/16bit/单声道）");
        assert_eq!(err_text(99999, "boom"), "请求失败：boom（99999）");
        assert_eq!(err_text(99999, ""), "请求失败（99999）");
    }

    #[test]
    fn close_err_text_401_403() {
        assert_eq!(close_err_text(401, ""), "鉴权失败：检查 API Key / API Secret");
        assert_eq!(close_err_text(403, ""), "被拒：IP 白名单或系统时间偏差超 5 分钟");
        assert_eq!(close_err_text(1006, "gone"), "连接断开（1006 gone）");
    }

    /// 切帧：任意长度进 → 1280B 整帧出，尾巴保留；rest flush 后清空。
    #[test]
    fn frame_slicer_cuts_1280() {
        let mut slicer = FrameSlicer::new(1280);
        assert!(slicer.push(&[0u8; 100]).is_empty());
        // 1300 = 100(残留) + 1300 → 凑满 1 帧（1280），余 120
        let frames = slicer.push(&[1u8; 1300]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 1280);
        assert_eq!(frames[0][0], 0); // 前段来自第一次 push
        // 再进 2560-120=2440 → 恰好 2 帧，无残留
        let frames = slicer.push(&[2u8; 2440]);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), 1280);
        assert_eq!(frames[1].len(), 1280);
        let rest = slicer.take_rest();
        assert!(rest.is_empty());
        // 尾巴 flush：3000 → 2 帧 + 440 尾
        let frames = slicer.push(&[3u8; 3000]);
        assert_eq!(frames.len(), 2);
        let rest = slicer.take_rest();
        assert_eq!(rest.len(), 440);
        assert!(slicer.take_rest().is_empty());
    }
}
