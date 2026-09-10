//! 朗读（TTS）：Windows SAPI ISpVoice，零第三方依赖。
//!
//! SAPI 是 COM 单元线程模型，不能在 tokio 异步命令里直接调用：
//! 这里用专用 STA 线程持有 ISpVoice，命令线程只往 channel 里投递
//! Speak 消息。打断（换一段朗读 / 主动停止）通过代数递增的 interrupt
//! 计数实现：轮询循环发现代数不匹配就截断音频，天然覆盖"连点两次"
//! 的竞态。朗读结束（自然播完或被打断）后向目标窗口发 tts:ended，
//! 附带本次的 gen，前端据此只处理最新一次朗读的结束事件。
//!
//! 沉浸阅读室扩展（contracts 见 tauriBridge.ts）：
//! - 双音轨：sentence（句子朗读，浮窗/阅读室共用语义）与 word（单词发音，
//!   独立引擎实例——查词发音不打断句子朗读，§9-2）。
//! - boundary 事件：SetInterest 后在轮询循环里 GetEvents 排空
//!   SPEI_WORD_BOUNDARY / SPEI_SENTENCE_BOUNDARY，向目标窗口发
//!   tts:boundary { gen, track, charStart, charLength, kind }（§9-1）。
//! - 语速：rate(0.5–2.0) 对数映射到 SAPI SetRate(-10..10)。
//! - 音色：voice 传 Attributes\Name 精确匹配；缺省按中/外文启发式。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::Speech::{
    ISpEventSource, ISpObjectToken, ISpVoice, SpVoice, SPEI_SENTENCE_BOUNDARY, SPEI_WORD_BOUNDARY,
    SPVOICESTATUS, SPF_ASYNC, SPF_PURGEBEFORESPEAK, SPEVENT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};

/// SPVOICESTATUS::dwRunningState 的"正在说话"位（sphelper.h 中定义，未进 windows 元数据）。
const SPVRS_IS_SPEAKING: u32 = 0x2;

/// 中文语音的 SAPI LCID（十六进制属性值）：zh-CN / zh-TW / zh-HK / zh-SG / zh-MO。
const CHINESE_LCIDS: [u32; 5] = [0x0804, 0x0404, 0x0C04, 0x1004, 0x1404];

/// 事件音轨：句子朗读与单词发音各自独立（独立线程 + 独立打断代数）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsTrack {
    Sentence,
    Word,
}

impl TtsTrack {
    fn parse(value: Option<&str>) -> TtsTrack {
        match value {
            Some("word") => TtsTrack::Word,
            _ => TtsTrack::Sentence,
        }
    }
    fn as_str(&self) -> &'static str {
        match self {
            TtsTrack::Sentence => "sentence",
            TtsTrack::Word => "word",
        }
    }
}

/// 判断 SAPI 声音的 Language 属性（形如 "804" 或 "409;804"）是否包含中文 LCID。
fn lcid_is_chinese(lang: &str) -> bool {
    lang.split(';')
        .filter_map(|part| u32::from_str_radix(part.trim(), 16).ok())
        .any(|lcid| CHINESE_LCIDS.contains(&lcid))
}

/// 语速 0.5–2.0 → SAPI Rate -10..10（对数映射：0.5→-10、1→0、2→10）。
fn map_rate(rate: f64) -> i32 {
    if rate <= 0.0 || !rate.is_finite() {
        return 0;
    }
    ((rate.ln() / std::f64::consts::LN_2) * 10.0).round().clamp(-10.0, 10.0) as i32
}

struct VoiceEntry {
    name: String,
    lang: String,
    token: ISpObjectToken,
}

enum TtsCommand {
    Speak {
        text: String,
        chinese: bool,
        gen: u64,
        target: String,
        rate: f64,
        voice: Option<String>,
    },
}

/// 单条音轨的状态：STA 工作线程的发送端 + 打断代数计数。
#[derive(Default)]
struct TrackState {
    tx: Mutex<Option<Sender<TtsCommand>>>,
    interrupt: Arc<AtomicU64>,
}

/// TTS 全局状态：两条音轨各自的 worker。
#[derive(Default)]
pub struct TtsState {
    sentence: TrackState,
    word: TrackState,
}

impl TtsState {
    fn track(&self, track: TtsTrack) -> &TrackState {
        match track {
            TtsTrack::Sentence => &self.sentence,
            TtsTrack::Word => &self.word,
        }
    }
}

/// 惰性启动 STA 工作线程；通过 ready 通道同步拿回初始化结果，
/// 失败时不缓存发送端，下次调用可重试。
fn ensure_worker(state: &TtsState, track: TtsTrack, app: &AppHandle) -> Result<(), String> {
    let track_state = state.track(track);
    let mut guard = track_state
        .tx
        .lock()
        .map_err(|_| "TTS 状态锁获取失败".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let (tx, rx) = channel::<TtsCommand>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let interrupt = track_state.interrupt.clone();
    let app = app.clone();
    let thread_name = format!("tts-sapi-{}", track.as_str());
    std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || tts_worker(app, rx, interrupt, ready_tx, track))
        .map_err(|e| format!("TTS 线程创建失败：{e}"))?;
    match ready_rx.recv() {
        Ok(Ok(())) => {
            *guard = Some(tx);
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("TTS 线程初始化无响应".to_string()),
    }
}

fn tts_worker(
    app: AppHandle,
    rx: Receiver<TtsCommand>,
    interrupt: Arc<AtomicU64>,
    ready: Sender<Result<(), String>>,
    track: TtsTrack,
) {
    // SAPI 要求 STA；线程生命周期内只初始化一次（重复初始化返回 S_FALSE 也算成功）。
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() {
        let _ = ready.send(Err(format!("TTS COM 初始化失败：{hr}")));
        return;
    }
    let voice: ISpVoice = match unsafe { CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER) } {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(format!("创建 SpVoice 失败：{e}")));
            return;
        }
    };
    // 订阅全部事件（含 word/sentence boundary），轮询循环里用 GetEvents 排空。
    unsafe {
        let _ = voice.SetInterest(u64::MAX, u64::MAX);
    }
    // 声音枚举失败不致命：退回系统默认声音。
    let voices = enumerate_voices(&voice).unwrap_or_default();
    let _ = ready.send(Ok(()));

    while let Ok(cmd) = rx.recv() {
        match cmd {
            TtsCommand::Speak { text, chinese, gen, target, rate, voice: voice_name } => {
                // 代数已被后续朗读/停止推进：本次直接跳过，但仍发结束事件保持前端配对。
                if interrupt.load(Ordering::SeqCst) == gen {
                    unsafe {
                        let token = pick_voice(&voices, voice_name.as_deref(), chinese);
                        if let Some(t) = token {
                            let _ = voice.SetVoice(t);
                        }
                        let _ = voice.SetRate(map_rate(rate));
                        let text_w = HSTRING::from(text.as_str());
                        let flags = (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0) as u32;
                        if voice.Speak(&text_w, flags, None).is_ok() {
                            wait_speech(&voice, &app, &interrupt, gen, track, &target, text.len());
                        }
                    }
                }
                let _ = app.emit_to(
                    target.as_str(),
                    "tts:ended",
                    serde_json::json!({ "gen": gen, "track": track.as_str() }),
                );
            }
        }
    }
    // 所有发送端 dropped（进程关闭路径）；保持 COM 初始化成对释放。
    unsafe { windows::Win32::System::Com::CoUninitialize() };
}

/// 按 voice 名（Attributes\Name）精确挑音色；miss 时按中/外文启发式兜底。
fn pick_voice<'a>(
    voices: &'a [VoiceEntry],
    voice_name: Option<&str>,
    chinese: bool,
) -> Option<&'a ISpObjectToken> {
    if let Some(name) = voice_name {
        if let Some(entry) = voices.iter().find(|v| v.name.eq_ignore_ascii_case(name)) {
            return Some(&entry.token);
        }
    }
    let mut fallback: Option<&VoiceEntry> = None;
    for v in voices {
        let is_zh = lcid_is_chinese(&v.lang);
        if is_zh == chinese {
            return Some(&v.token);
        }
        if fallback.is_none() {
            fallback = Some(v);
        }
    }
    fallback.map(|v| &v.token)
}

/// 轮询直到本次朗读结束或被打断（代数不匹配时截断音频），
/// 期间持续排空 SAPI 事件队列并转发 word/sentence boundary。
fn wait_speech(
    voice: &ISpVoice,
    app: &AppHandle,
    interrupt: &AtomicU64,
    gen: u64,
    track: TtsTrack,
    target: &str,
    text_len: usize,
) {
    // ASYNC 说话刚入队时状态位还没置起来，先等一小拍再开始轮询。
    std::thread::sleep(Duration::from_millis(50));
    loop {
        if interrupt.load(Ordering::SeqCst) != gen {
            cut_speech(voice);
            return;
        }
        drain_boundary_events(voice, app, gen, track, target, text_len);
        let mut status = SPVOICESTATUS::default();
        if unsafe { voice.GetStatus(&mut status, std::ptr::null_mut()) }.is_err() {
            return;
        }
        if status.dwRunningState & SPVRS_IS_SPEAKING == 0 {
            // 收尾再排一次，保证最后几个 boundary 不丢。
            drain_boundary_events(voice, app, gen, track, target, text_len);
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// 排空事件队列，把 word/sentence boundary 转成 tts:boundary 事件。
/// SAPI 约定（SPEVENT）：wParam = 该词/句的字符长度，lParam = 起始字符位置。
fn drain_boundary_events(
    voice: &ISpVoice,
    app: &AppHandle,
    gen: u64,
    track: TtsTrack,
    target: &str,
    text_len: usize,
) {
    let events: &ISpEventSource = voice;
    loop {
        let mut event = SPEVENT::default();
        let mut fetched: u32 = 0;
        unsafe {
            if events.GetEvents(1, &mut event, &mut fetched).is_err() || fetched == 0 {
                return;
            }
        }
        // windows crate 把 eEventId/elParamType 打包进 _bitfield（低 16 位是事件 id）。
        let event_id = event._bitfield & 0xFFFF;
        let kind = if event_id == SPEI_WORD_BOUNDARY.0 {
            "word"
        } else if event_id == SPEI_SENTENCE_BOUNDARY.0 {
            "sentence"
        } else {
            continue;
        };
        // SAPI 用 wParam 存长度、lParam 存起点；防御性钳制到文本范围内。
        let raw_start = event.lParam.0 as i64;
        let raw_len = event.wParam.0 as i64;
        let char_start = if raw_start < 0 { 0 } else { raw_start.min(text_len as i64) };
        let char_length = raw_len.clamp(0, text_len as i64 - char_start);
        let _ = app.emit_to(
            target,
            "tts:boundary",
            serde_json::json!({
                "gen": gen,
                "track": track.as_str(),
                "kind": kind,
                "charStart": char_start,
                "charLength": char_length,
            }),
        );
    }
}

/// 截断当前音频（空文本 + PURGEBEFORESPEAK 是 SAPI 标准的打断方式）。
fn cut_speech(voice: &ISpVoice) {
    unsafe {
        let _ = voice.Speak(&HSTRING::new(), SPF_PURGEBEFORESPEAK.0 as u32, None);
    }
}

/// 枚举系统全部声音（名字 + 语言 + token）。
/// 从默认声音的 token 拿到 Voices 分类再枚举，避免依赖 sphelper.h 的
/// SpEnumTokens 辅助函数（windows crate 未导出）。
fn enumerate_voices(voice: &ISpVoice) -> Result<Vec<VoiceEntry>, windows::core::Error> {
    unsafe {
        let category = voice.GetVoice()?.GetCategory()?;
        let tokens = category.EnumTokens(PCWSTR::null(), PCWSTR::null())?;
        let mut entries = Vec::new();
        loop {
            let mut item: Option<ISpObjectToken> = None;
            let mut fetched: u32 = 0;
            if tokens.Next(1, &mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(token) = item else { break };
            let lang = token_language(&token, "Language").unwrap_or_default();
            let name = token_language(&token, "Name").unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            entries.push(VoiceEntry { name, lang, token });
        }
        Ok(entries)
    }
}

/// 读取声音 token 的 Attributes\<key\> 属性（如 Language="804;409"、Name="Microsoft Zira…"）。
fn token_language(token: &ISpObjectToken, key: &str) -> Option<String> {
    unsafe {
        let key_handle = token.OpenKey(&HSTRING::from("Attributes")).ok()?;
        let value = key_handle.GetStringValue(&HSTRING::from(key)).ok()?;
        if value.is_null() {
            return None;
        }
        let text = value.to_string().ok();
        CoTaskMemFree(Some(value.as_ptr() as *const core::ffi::c_void));
        text
    }
}

/// 朗读一段文本。chinese 决定缺省选中文声音还是非中文声音。
/// 返回本次朗读的代数（gen）：tts:ended 事件会原样带上它，
/// 前端只处理与最新 gen 匹配的结束事件，丢弃被打断那次的过期事件。
///
/// 阅读室扩展参数（全部可选，浮窗沿用默认即可）：
/// - track："sentence"（默认，与浮窗同语义）| "word"（独立音轨，不打断句子朗读）
/// - rate：语速 0.5–2.0，默认 1.0
/// - voice：系统音色名（Attributes\Name），None 用缺省启发式
/// - target：事件目标窗口 label，默认 "panel"
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    state: State<'_, TtsState>,
    text: String,
    chinese: bool,
    track: Option<String>,
    rate: Option<f64>,
    voice: Option<String>,
    target: Option<String>,
) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(0);
    }
    let track = TtsTrack::parse(track.as_deref());
    ensure_worker(&state, track, &app)?;
    let track_state = state.track(track);
    let gen = track_state.interrupt.fetch_add(1, Ordering::SeqCst) + 1;
    let tx = track_state
        .tx
        .lock()
        .map_err(|_| "TTS 状态锁获取失败".to_string())?
        .clone()
        .ok_or_else(|| "TTS 未就绪".to_string())?;
    tx.send(TtsCommand::Speak {
        text,
        chinese,
        gen,
        target: target.unwrap_or_else(|| "panel".into()),
        rate: rate.unwrap_or(1.0),
        voice,
    })
    .map_err(|_| "TTS 线程已退出".to_string())?;
    Ok(gen)
}

/// 停止指定音轨的朗读：推进打断代数即可，轮询循环会截断音频。
#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>, track: Option<String>) -> Result<(), String> {
    let track = TtsTrack::parse(track.as_deref());
    state.track(track).interrupt.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// 系统音色列表（阅读室设置面板的音色下拉）。
/// 在临时 STA 线程上枚举，结束后释放 COM。
#[tauri::command]
pub fn tts_voices() -> Result<Vec<TtsVoiceInfo>, String> {
    let (tx, rx) = channel::<Result<Vec<TtsVoiceInfo>, String>>();
    std::thread::Builder::new()
        .name("tts-enum".to_string())
        .spawn(move || {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                if hr.is_err() {
                    let _ = tx.send(Err(format!("TTS COM 初始化失败：{hr}")));
                    return;
                }
                let result = (|| -> Result<Vec<TtsVoiceInfo>, String> {
                    let voice: ISpVoice =
                        CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER)
                            .map_err(|e| format!("创建 SpVoice 失败：{e}"))?;
                    Ok(enumerate_voices(&voice)
                        .map_err(|e| format!("枚举音色失败：{e}"))?
                        .into_iter()
                        .map(|v| TtsVoiceInfo {
                            name: v.name,
                            chinese: lcid_is_chinese(&v.lang),
                        })
                        .collect())
                })();
                let _ = tx.send(result);
                windows::Win32::System::Com::CoUninitialize();
            }
        })
        .map_err(|e| format!("枚举线程创建失败：{e}"))?;
    rx.recv().map_err(|_| "枚举线程无响应".to_string())?
}

#[derive(Clone, serde::Serialize)]
pub struct TtsVoiceInfo {
    /// Attributes\Name，可直接作为 tts_speak 的 voice 参数。
    pub name: String,
    pub chinese: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_lcid_variants() {
        assert!(lcid_is_chinese("804")); // zh-CN
        assert!(lcid_is_chinese("404")); // zh-TW
        assert!(lcid_is_chinese("409;804")); // 多语言声音
        assert!(lcid_is_chinese(" C04 ")); // 大小写与空白
    }

    #[test]
    fn non_chinese_lcid() {
        assert!(!lcid_is_chinese("409")); // en-US
        assert!(!lcid_is_chinese("411")); // ja-JP
        assert!(!lcid_is_chinese(""));
        assert!(!lcid_is_chinese("garbage"));
    }

    #[test]
    fn rate_maps_logarithmically_and_clamps() {
        assert_eq!(map_rate(1.0), 0);
        assert_eq!(map_rate(2.0), 10);
        assert_eq!(map_rate(0.5), -10);
        assert_eq!(map_rate(0.0), 0);
        assert_eq!(map_rate(9.0), 10); // 越界收紧
        assert_eq!(map_rate(f64::INFINITY), 0);
    }

    #[test]
    fn track_parsing() {
        assert_eq!(TtsTrack::parse(None), TtsTrack::Sentence);
        assert_eq!(TtsTrack::parse(Some("sentence")), TtsTrack::Sentence);
        assert_eq!(TtsTrack::parse(Some("word")), TtsTrack::Word);
        assert_eq!(TtsTrack::parse(Some("bogus")), TtsTrack::Sentence);
    }
}
