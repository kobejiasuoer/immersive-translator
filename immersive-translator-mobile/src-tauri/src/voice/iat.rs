//! 讯飞流式听写（IAT）：16k/16bit/单声道 PCM → 文本。
//! 照 mac/Sources/XfyunCore/XfyunAsr.swift:33-57（首帧/音频帧/结束帧）、
//! :59-101（business 参数）、:151-166（sn last-write-wins 合并）。
//! - 首帧 business{sub:iat,domain:iat,language,accent:mandarin,vad_eos:1200,ptt:1}+data，无 common；
//! - 音频帧 1280B/帧（=40ms）base64(raw)，Rust 内部缓冲切帧（asr_push 收任意长度）；
//! - 结果 data.result.ws[].cw[].w 逐词拼接，sn 是段序号（后到覆盖先到，按 sn 排序合并）；
//! - data.status==2 全部结束；每条结果消息 emit("asr-delta",{sessionId,text:累计,final})；
//! - 会话 30s 超时：tokio::select! 收流 vs 定时器竞速（XfyunAuth.swift:141-176）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::auth;
use super::{
    close_err_text, decode_b64, encode_b64, err_text, session_exists, session_get,
    session_gone_err, session_insert, session_remove, FrameSlicer, VoiceCfg, ws_err_text,
};

pub const HOST: &str = "iat-api.xfyun.cn";
pub const PATH: &str = "/v2/iat";
/// 会话整体超时（秒）。IAT 单次听写上限 60s，前端 VAD 段落在 15s 内，30s 兜底。
const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
/// IAT/ISE 音频帧尺寸：1280B = 40ms @16k/16bit/单声道。
pub const FRAME_BYTES: usize = 1280;

/// 直连 wss（native-tls）的 WS 流与半边别名。
pub type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
pub type WsSink = futures_util::stream::SplitSink<WsStream, Message>;
pub type WsSource = futures_util::stream::SplitStream<WsStream>;

/// 后台会话任务收的指令。
pub enum IatCommand {
    Audio(Vec<u8>),
    Finish(oneshot::Sender<Result<String, String>>),
    Abort,
}

/// asr-delta 事件载荷（camelCase；`final` 是 JS 关键字，重命名后序列化为 "final"）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AsrDeltaPayload {
    session_id: String,
    text: String,
    #[serde(rename = "final")]
    is_final: bool,
}

/// 从一条 IAT 结果消息里取一段转写（sn + 逐词拼接），非结果消息返回 None。
/// 照 extractIatSegment（XfyunAsr.swift:34-48）。
pub fn extract_segment(payload: &serde_json::Value) -> Option<(i64, String)> {
    let result = payload.get("data")?.get("result")?;
    let sn = result.get("sn")?.as_i64()?;
    let ws = result.get("ws")?.as_array()?;
    let mut text = String::new();
    for word in ws {
        // cw 是候选列表，第一个是最佳候选
        if let Some(best) = word.get("cw").and_then(|cw| cw.as_array()).and_then(|cw| cw.first()) {
            if let Some(w) = best.get("w").and_then(|w| w.as_str()) {
                text.push_str(w);
            }
        }
    }
    Some((sn, text))
}

/// 按 sn 归并各段（后到覆盖先到），返回完整转写。照 mergeIatSegments（XfyunAsr.swift:51-57）。
pub fn merge_segments(segments: &HashMap<i64, String>) -> String {
    let mut keys: Vec<i64> = segments.keys().copied().collect();
    keys.sort_unstable();
    let joined: String = keys.iter().filter_map(|k| segments.get(k).map(String::as_str)).collect();
    joined.trim().to_string()
}

/// 首帧（common + business + data.status=0）。字段严格照 IAT 文档参数表
/// （xfyun.cn/doc/asr/voicedictation/API.html）：business 只认 language/domain/accent
/// 必填 + eos 等可选参数——**不能**带 sub / vad_eos / ptt（sub 是 ISE 的参数，
/// 静音后端点叫 eos 不叫 vad_eos），多带会被服务端直接断连（10163 参数不合法，
/// 已用真实会话探针验证：文档帧 code:0 success，带 sub/vad_eos 帧秒断）。
pub fn build_first_frame(app_id: &str, language: &str) -> String {
    json!({
        "common": {"app_id": app_id},
        "business": {
            "language": language,
            "domain": "iat",
            "accent": "mandarin",
            "eos": 1200,
        },
        "data": {
            "status": 0,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": "",
        },
    })
    .to_string()
}

/// 音频帧（1280B/帧 base64(raw)，status=1）。
pub fn build_audio_frame(piece: &[u8]) -> String {
    json!({
        "data": {
            "status": 1,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": encode_b64(piece),
        },
    })
    .to_string()
}

/// 结束帧（status=2）。
pub fn build_end_frame() -> String {
    json!({
        "data": {
            "status": 2,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": "",
        },
    })
    .to_string()
}

/// 开听写会话：鉴权 → 握手 → 发首帧（错误在命令返回值里如实上抛）→
/// 后台任务收流。每条结果 emit("asr-delta", {sessionId, text:累计, final})。
#[tauri::command]
pub async fn asr_start(
    app: tauri::AppHandle,
    language: String,
    session_id: String,
    voice: VoiceCfg,
) -> Result<(), String> {
    if language != "en_us" && language != "zh_cn" {
        return Err(format!("不支持的语言 {language}（仅 en_us / zh_cn）"));
    }
    voice.ensure()?;
    if session_exists(&session_id) {
        return Err(format!("会话 {session_id} 已存在"));
    }
    let url = auth::build_auth_url(&voice.api_key, &voice.api_secret, HOST, PATH);
    /* 握手超时：connect_async 无内置超时，30s 会话死线在握手成功后才起算——
       网络不可达时命令可挂数十秒到分钟级（治 rust-tts-1，三处握手同修） */
    let (ws, _) = tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(url))
        .await
        .map_err(|_| "听写连接超时（10s 未完成握手，检查网络）".to_string())?
        .map_err(ws_err_text)?;
    let (mut sink, stream) = ws.split();
    sink.send(Message::Text(build_first_frame(voice.app_id.trim(), &language)))
        .await
        .map_err(ws_err_text)?;

    let (tx, rx) = mpsc::unbounded_channel::<IatCommand>();
    session_insert(session_id.clone(), super::IatHandle { tx });

    let sid = Arc::new(session_id);
    let app = Arc::new(app);
    tokio::spawn(run_session(app, sid, rx, sink, stream));
    Ok(())
}

/// 收尾清理：先摘注册表再关 WS（幂等）。err=Some 时登记死因并向前端发
/// `asr-error` 事件（把讯飞原始错误码/文案带出去，toast 里能看到真实原因）。
async fn close_and_cleanup(app: &tauri::AppHandle, sink: &mut WsSink, sid: &str, err: Option<String>) {
    if let Some(msg) = err {
        let _ = app.emit(
            "asr-error",
            serde_json::json!({ "sessionId": sid, "message": msg }),
        );
        super::session_error_set(sid, msg);
    }
    session_remove(sid);
    let _ = sink.close().await;
}

/// 后台收流循环：指令 vs WS 消息 vs 30s 定时器三方竞速。
async fn run_session(
    app: Arc<tauri::AppHandle>,
    sid: Arc<String>,
    mut rx: mpsc::UnboundedReceiver<IatCommand>,
    mut sink: WsSink,
    mut stream: WsSource,
) {
    let mut slicer = FrameSlicer::new(FRAME_BYTES);
    let mut segments: HashMap<i64, String> = HashMap::new();
    let mut pending_finish: Option<oneshot::Sender<Result<String, String>>> = None;
    let deadline = tokio::time::Instant::now() + SESSION_TIMEOUT;

    loop {
        tokio::select! {
            cmd = rx.recv() => {
                match cmd {
                    Some(IatCommand::Audio(bytes)) => {
                        for frame in slicer.push(&bytes) {
                            if sink.send(Message::Text(build_audio_frame(&frame))).await.is_err() {
                                close_and_cleanup(&app, &mut sink, &sid, Some("连接已断开（发送失败）".into())).await;
                                return;
                            }
                        }
                    }
                    Some(IatCommand::Finish(tx)) => {
                        // flush 尾巴（可为短帧）→ 结束帧 → 继续收最终结果
                        let rest = slicer.take_rest();
                        if !rest.is_empty()
                            && sink.send(Message::Text(build_audio_frame(&rest))).await.is_err() {
                            let _ = tx.send(Err("连接已断开".into()));
                            close_and_cleanup(&app, &mut sink, &sid, Some("连接已断开（发送失败）".into())).await;
                            return;
                        }
                        if sink.send(Message::Text(build_end_frame())).await.is_err() {
                            let _ = tx.send(Err("连接已断开".into()));
                            close_and_cleanup(&app, &mut sink, &sid, Some("连接已断开（发送失败）".into())).await;
                            return;
                        }
                        pending_finish = Some(tx);
                    }
                    // Abort：直接关 WS，不等结果，静默清理
                    Some(IatCommand::Abort) | None => {
                        if let Some(tx) = pending_finish.take() {
                            let _ = tx.send(Err("已中止".into()));
                        }
                        close_and_cleanup(&app, &mut sink, &sid, None).await;
                        return;
                    }
                }
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                        if let Some(code) = v["code"].as_i64() {
                            if code != 0 {
                                let msg = err_text(code, v["message"].as_str().unwrap_or(""));
                                if let Some(tx) = pending_finish.take() {
                                    let _ = tx.send(Err(msg.clone()));
                                }
                                close_and_cleanup(&app, &mut sink, &sid, Some(msg)).await;
                                return;
                            }
                        }
                        if let Some((sn, seg)) = extract_segment(&v) {
                            segments.insert(sn, seg);
                        }
                        let accumulated = merge_segments(&segments);
                        let is_final = v["data"]["status"].as_i64() == Some(2);
                        let _ = app.emit(
                            "asr-delta",
                            AsrDeltaPayload {
                                session_id: sid.to_string(),
                                text: accumulated.clone(),
                                is_final,
                            },
                        );
                        if is_final {
                            if let Some(tx) = pending_finish.take() {
                                let _ = tx.send(Ok(accumulated));
                            }
                            close_and_cleanup(&app, &mut sink, &sid, None).await;
                            return;
                        }
                    }
                    Some(Ok(Message::Close(Some(frame)))) => {
                        let msg = close_err_text(u16::from(frame.code), frame.reason.as_ref());
                        if let Some(tx) = pending_finish.take() {
                            let _ = tx.send(Err(msg.clone()));
                        }
                        close_and_cleanup(&app, &mut sink, &sid, Some(msg)).await;
                        return;
                    }
                    Some(Ok(Message::Close(None))) | None => {
                        if let Some(tx) = pending_finish.take() {
                            let _ = tx.send(Err("连接断开".into()));
                        }
                        close_and_cleanup(&app, &mut sink, &sid, Some("连接断开".into())).await;
                        return;
                    }
                    // 二进制帧跳过（只处理文本帧）
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        let msg = ws_err_text(e);
                        if let Some(tx) = pending_finish.take() {
                            let _ = tx.send(Err(msg.clone()));
                        }
                        close_and_cleanup(&app, &mut sink, &sid, Some(msg)).await;
                        return;
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                // 30s 超时：尽力把已识别的部分交出去（有文本→成功返回，无文本→超时报错）
                let accumulated = merge_segments(&segments);
                let _ = app.emit(
                    "asr-delta",
                    AsrDeltaPayload {
                        session_id: sid.to_string(),
                        text: accumulated.clone(),
                        is_final: true,
                    },
                );
                if let Some(tx) = pending_finish.take() {
                    if accumulated.is_empty() {
                        let _ = tx.send(Err(format!("识别超时（{}s 无结果）", SESSION_TIMEOUT.as_secs())));
                    } else {
                        let _ = tx.send(Ok(accumulated));
                    }
                }
                close_and_cleanup(
                    &app,
                    &mut sink,
                    &sid,
                    Some(format!("识别超时（{}s 无结果）", SESSION_TIMEOUT.as_secs())),
                )
                .await;
                return;
            }
        }
    }
}

/// 推音频：任意长度 base64(PCM16LE/16k/单声道)，内部缓冲并切 1280B 帧。
#[tauri::command]
pub async fn asr_push(session_id: String, pcm_b64: String) -> Result<(), String> {
    let tx = session_get(&session_id).ok_or_else(|| session_gone_err(&session_id))?;
    let bytes = decode_b64(&pcm_b64)?;
    tx.send(IatCommand::Audio(bytes))
        .map_err(|_| session_gone_err(&session_id))
}

/// 收尾：发 status=2 结束帧 → 收满(data.status==2)或超时 → 返回最终文本并清理会话。
#[tauri::command]
pub async fn asr_finish(session_id: String) -> Result<String, String> {
    let tx = session_get(&session_id).ok_or_else(|| session_gone_err(&session_id))?;
    let (resp_tx, resp_rx) = oneshot::channel();
    tx.send(IatCommand::Finish(resp_tx))
        .map_err(|_| session_gone_err(&session_id))?;
    match resp_rx.await {
        Ok(result) => result,
        Err(_) => Err("会话已结束".to_string()),
    }
}

/// 异常收尾：直接关 WS，不等结果，静默清理。
#[tauri::command]
pub async fn asr_abort(session_id: String) {
    if let Some(tx) = session_get(&session_id) {
        let _ = tx.send(IatCommand::Abort);
    }
    session_remove(&session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_frame_shape() {
        let frame = build_first_frame("app1", "en_us");
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["common"]["app_id"], "app1", "IAT 首帧必须带 common.app_id（缺则 10163）");
        assert_eq!(v["business"]["domain"], "iat");
        assert_eq!(v["business"]["language"], "en_us");
        assert_eq!(v["business"]["accent"], "mandarin");
        assert_eq!(v["business"]["eos"], 1200);
        assert_eq!(
            v["data"]["status"], 0,
            "business 里不得出现 sub / vad_eos / ptt（IAT 文档参数表没有它们，带上服务端秒断）"
        );
        assert!(v["business"].get("sub").is_none());
        assert!(v["business"].get("vad_eos").is_none());
        assert!(v["business"].get("ptt").is_none());
        assert_eq!(v["data"]["status"], 0);
        assert_eq!(v["data"]["format"], "audio/L16;rate=16000");
        assert_eq!(v["data"]["encoding"], "raw");
    }

    #[test]
    fn audio_and_end_frame_shape() {
        let frame = build_audio_frame(&[1u8, 2, 3, 4]);
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["data"]["status"], 1);
        assert_eq!(v["data"]["encoding"], "raw");
        assert_eq!(v["data"]["audio"], encode_b64(&[1, 2, 3, 4]));
        let end = build_end_frame();
        let v: serde_json::Value = serde_json::from_str(&end).unwrap();
        assert_eq!(v["data"]["status"], 2);
    }

    /// 活体探针（手动跑）：XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET 齐全时
    /// `cargo test --lib iat_probe_live -- --ignored --nocapture`。
    /// 把「现状帧」与「文档帧」各开一条真实会话，服务端每条回包原样打印——
    /// 10163 的 message 会点名非法参数（如 sub / vad_eos 不在 IAT 文档参数表里）。
    #[test]
    #[ignore = "诊断探针：需真实讯飞凭据（环境变量注入）"]
    fn iat_probe_live() {
        use futures_util::{SinkExt, StreamExt};
        use std::time::Duration;
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        async fn probe_once(
            key: &str,
            secret: &str,
            app_id: &str,
            label: &str,
            first_frame: String,
        ) {
            println!("===== {label} =====");
            println!("首帧: {}", first_frame.replace(app_id, "***"));
            let url = auth::build_auth_url(key, secret, HOST, PATH);
            let (ws, _) = match connect_async(url).await {
                Ok(w) => w,
                Err(e) => return println!("握手失败: {e}"),
            };
            let (mut sink, mut stream) = ws.split();
            if let Err(e) = sink.send(Message::Text(first_frame)).await {
                return println!("首帧发送失败: {e}");
            }
            // 1 秒静音（25 帧 × 40ms）→ 结束帧，模拟一次最短听写
            let silence = vec![0u8; FRAME_BYTES];
            for _ in 0..25 {
                if sink.send(Message::Text(build_audio_frame(&silence))).await.is_err() {
                    return println!("音频帧发送失败");
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            if sink.send(Message::Text(build_end_frame())).await.is_err() {
                return println!("结束帧发送失败");
            }
            let mut count = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                tokio::select! {
                    msg = stream.next() => match msg {
                        Some(Ok(Message::Text(text))) => {
                            count += 1;
                            println!("  讯飞回包[{count}]: {text}");
                            if text.contains("\"status\":2") {
                                return println!("→ {label} 会话跑通（{} 条回包）", count);
                            }
                        }
                        Some(Ok(Message::Close(f))) => return println!(
                            "→ {label} 服务端关闭: {:?}",
                            f.map(|fr| (u16::from(fr.code), fr.reason.to_string()))
                        ),
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => return println!("→ {label} WS 错误: {e}"),
                        None => return println!("→ {label} 流结束"),
                    },
                    _ = tokio::time::sleep_until(deadline) => return println!("→ {label} 10s 无回包"),
                }
            }
        }

        let app_id = std::env::var("XFYUN_APP_ID").expect("缺 XFYUN_APP_ID");
        let key = std::env::var("XFYUN_API_KEY").expect("缺 XFYUN_API_KEY");
        let secret = std::env::var("XFYUN_API_SECRET").expect("缺 XFYUN_API_SECRET");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // V1 现状：sub + vad_eos + ptt（IAT 文档参数表中不存在 sub / vad_eos）
            let v1 = build_first_frame(app_id.trim(), "en_us");
            // V2 文档形状：只留必填三件 + eos（文档里的静音后端点参数）
            let v2 = json!({
                "common": {"app_id": app_id.trim()},
                "business": {"language": "en_us", "domain": "iat", "accent": "mandarin", "eos": 1200},
                "data": {"status": 0, "format": "audio/L16;rate=16000", "encoding": "raw", "audio": ""},
            })
            .to_string();
            probe_once(&key, &secret, app_id.trim(), "V1-现状帧", v1).await;
            tokio::time::sleep(Duration::from_secs(1)).await;
            probe_once(&key, &secret, app_id.trim(), "V2-文档帧", v2).await;
        });
    }

    #[test]
    fn extract_and_merge_last_write_wins() {
        let m1 = json!({
            "code": 0,
            "data": {"status": 1, "result": {"sn": 1, "ws": [
                {"cw": [{"w": "hello ", "sc": 0}]},
                {"cw": [{"w": "world", "sc": 0}]},
            ]}},
        });
        let m2 = json!({
            "code": 0,
            "data": {"status": 1, "result": {"sn": 2, "ws": [{"cw": [{"w": "today", "sc": 0}]}]}},
        });
        // sn=1 重发（后到覆盖先到，取最后一次）
        let m1b = json!({
            "code": 0,
            "data": {"status": 2, "result": {"sn": 1, "ws": [{"cw": [{"w": "hello,", "sc": 0}]}]}},
        });
        let mut segs = HashMap::new();
        for m in [&m1, &m2, &m1b] {
            let (sn, text) = extract_segment(m).unwrap();
            segs.insert(sn, text);
        }
        assert_eq!(merge_segments(&segs), "hello,today");
        // 非结果消息 → None
        assert!(extract_segment(&json!({"code": 0, "data": {"status": 2}})).is_none());
    }
}
