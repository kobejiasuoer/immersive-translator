//! 朗读（TTS）：Windows SAPI ISpVoice，零第三方依赖。
//!
//! SAPI 是 COM 单元线程模型，不能在 tokio 异步命令里直接调用：
//! 这里用一条专用 STA 线程持有 ISpVoice，命令线程只往 channel 里投递
//! Speak 消息。打断（换一段朗读 / 主动停止）通过代数递增的 interrupt
//! 计数实现：轮询循环发现代数不匹配就截断音频，天然覆盖"连点两次"
//! 的竞态。朗读结束（自然播完或被打断）后向 panel 窗口发 tts:ended，
//! 附带本次的 gen，前端据此只处理最新一次朗读的结束事件。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpVoice, SpVoice, SPF_ASYNC, SPF_PURGEBEFORESPEAK, SPVOICESTATUS,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};

/// SPVOICESTATUS::dwRunningState 的"正在说话"位（sphelper.h 中定义，未进 windows 元数据）。
const SPVRS_IS_SPEAKING: u32 = 0x2;

/// 中文语音的 SAPI LCID（十六进制属性值）：zh-CN / zh-TW / zh-HK / zh-SG / zh-MO。
const CHINESE_LCIDS: [u32; 5] = [0x0804, 0x0404, 0x0C04, 0x1004, 0x1404];

/// 判断 SAPI 声音的 Language 属性（形如 "804" 或 "409;804"）是否包含中文 LCID。
fn lcid_is_chinese(lang: &str) -> bool {
    lang.split(';')
        .filter_map(|part| u32::from_str_radix(part.trim(), 16).ok())
        .any(|lcid| CHINESE_LCIDS.contains(&lcid))
}

enum TtsCommand {
    Speak {
        text: String,
        chinese: bool,
        gen: u64,
    },
}

/// TTS 全局状态：STA 工作线程的发送端 + 打断代数计数。
#[derive(Default)]
pub struct TtsState {
    tx: Mutex<Option<Sender<TtsCommand>>>,
    interrupt: Arc<AtomicU64>,
}

/// 惰性启动 STA 工作线程；通过 ready 通道同步拿回初始化结果，
/// 失败时不缓存发送端，下次调用可重试。
fn ensure_worker(state: &TtsState, app: &AppHandle) -> Result<(), String> {
    let mut guard = state.tx.lock().map_err(|_| "TTS 状态锁获取失败".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let (tx, rx) = channel::<TtsCommand>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let interrupt = state.interrupt.clone();
    let app = app.clone();
    std::thread::Builder::new()
        .name("tts-sapi".to_string())
        .spawn(move || tts_worker(app, rx, interrupt, ready_tx))
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
    // 声音枚举失败不致命：退回系统默认声音。
    let (zh_voice, other_voice) = enumerate_voices(&voice).unwrap_or((None, None));
    let _ = ready.send(Ok(()));

    while let Ok(cmd) = rx.recv() {
        match cmd {
            TtsCommand::Speak { text, chinese, gen } => {
                // 代数已被后续朗读/停止推进：本次直接跳过，但仍发结束事件保持前端配对。
                if interrupt.load(Ordering::SeqCst) == gen {
                    unsafe {
                        let token = if chinese { zh_voice.as_ref() } else { other_voice.as_ref() };
                        if let Some(t) = token {
                            let _ = voice.SetVoice(t);
                        }
                        let text_w = HSTRING::from(text.as_str());
                        let flags = (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0) as u32;
                        if voice.Speak(&text_w, flags, None).is_ok() {
                            wait_speech(&voice, &interrupt, gen);
                        }
                    }
                }
                let _ = app.emit_to("panel", "tts:ended", serde_json::json!({ "gen": gen }));
            }
        }
    }
    // 所有发送端 dropped（进程关闭路径）；保持 COM 初始化成对释放。
    unsafe { windows::Win32::System::Com::CoUninitialize() };
}

/// 轮询直到本次朗读结束或被打断（代数不匹配时截断音频）。
fn wait_speech(voice: &ISpVoice, interrupt: &AtomicU64, gen: u64) {
    // ASYNC 说话刚入队时状态位还没置起来，先等一小拍再开始轮询。
    std::thread::sleep(Duration::from_millis(50));
    loop {
        if interrupt.load(Ordering::SeqCst) != gen {
            cut_speech(voice);
            return;
        }
        let mut status = SPVOICESTATUS::default();
        if unsafe { voice.GetStatus(&mut status, std::ptr::null_mut()) }.is_err() {
            return;
        }
        if status.dwRunningState & SPVRS_IS_SPEAKING == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

/// 截断当前音频（空文本 + PURGEBEFORESPEAK 是 SAPI 标准的打断方式）。
fn cut_speech(voice: &ISpVoice) {
    unsafe {
        let _ = voice.Speak(&HSTRING::new(), SPF_PURGEBEFORESPEAK.0 as u32, None);
    }
}

/// 枚举系统声音，挑出首个中文声音和首个非中文声音（都不保证存在）。
/// 从默认声音的 token 拿到 Voices 分类再枚举，避免依赖 sphelper.h 的
/// SpEnumTokens 辅助函数（windows crate 未导出）。
fn enumerate_voices(
    voice: &ISpVoice,
) -> Result<(Option<ISpObjectToken>, Option<ISpObjectToken>), windows::core::Error> {
    unsafe {
        let category = voice.GetVoice()?.GetCategory()?;
        let tokens = category.EnumTokens(PCWSTR::null(), PCWSTR::null())?;
        let mut zh: Option<ISpObjectToken> = None;
        let mut other: Option<ISpObjectToken> = None;
        loop {
            let mut item: Option<ISpObjectToken> = None;
            let mut fetched: u32 = 0;
            if tokens.Next(1, &mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(token) = item else { break };
            let lang = token_language(&token).unwrap_or_default();
            if lcid_is_chinese(&lang) {
                if zh.is_none() {
                    zh = Some(token);
                }
            } else if other.is_none() && !lang.is_empty() {
                other = Some(token);
            }
            if zh.is_some() && other.is_some() {
                break;
            }
        }
        Ok((zh, other))
    }
}

/// 读取声音 token 的 Attributes\Language 属性（形如 "804"、"409;804"）。
fn token_language(token: &ISpObjectToken) -> Option<String> {
    unsafe {
        let key = token.OpenKey(&HSTRING::from("Attributes")).ok()?;
        let value = key.GetStringValue(&HSTRING::from("Language")).ok()?;
        if value.is_null() {
            return None;
        }
        let text = value.to_string().ok();
        CoTaskMemFree(Some(value.as_ptr() as *const core::ffi::c_void));
        text
    }
}

/// 朗读一段文本。chinese 决定优先选中文声音还是非中文声音。
/// 返回本次朗读的代数（gen）：tts:ended 事件会原样带上它，
/// 前端只处理与最新 gen 匹配的结束事件，丢弃被打断那次的过期事件。
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    state: State<'_, TtsState>,
    text: String,
    chinese: bool,
) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(0);
    }
    ensure_worker(&state, &app)?;
    let gen = state.interrupt.fetch_add(1, Ordering::SeqCst) + 1;
    let tx = state
        .tx
        .lock()
        .map_err(|_| "TTS 状态锁获取失败".to_string())?
        .clone()
        .ok_or_else(|| "TTS 未就绪".to_string())?;
    tx.send(TtsCommand::Speak { text, chinese, gen })
        .map_err(|_| "TTS 线程已退出".to_string())?;
    Ok(gen)
}

/// 停止当前朗读：推进打断代数即可，轮询循环会截断音频。
#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>) -> Result<(), String> {
    state.interrupt.fetch_add(1, Ordering::SeqCst);
    Ok(())
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
}
