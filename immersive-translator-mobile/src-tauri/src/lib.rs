//! 移动端内核：真实 LLM 链路 + 讯飞语音三链路（IAT/ISE/TTS）+ OCR。
//! - OpenAI 兼容 /chat/completions（DeepSeek/OpenAI/智谱/Moonshot/硅基流动/自定义），
//!   翻译走 SSE 流式（`translate-delta` 事件推给 WebView，命令返回全量兜底），
//!   通用对话走 `llm_chat`（`chat-delta` 事件，载荷=累计全文，按 reqId 过滤）；
//! - 思考模式兼容（智谱 thinking.type=disabled、DeepSeek-R1/Qwen3/QwQ
//!   enable_thinking=false）与 `<think>` 噪声剥离（照 ReaderChatClient.swift:78-147）；
//! - BYOK：凭据由前端每次调用时传入，Rust 不落盘。

mod keychain;
mod ocr;
mod voice;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};

/// 代数中止：translate_abort 递增代数，流式循环发现代数变了就断流（保留已译部分）。
static ABORT_GEN: AtomicU64 = AtomicU64::new(0);

/// llm_chat 专用代数中止（治 services-6）：独立计数器，与翻译互不影响——
/// 陪练「跳过」/笔记页退出只掐自己的对话流，不误伤在途翻译（反之亦然）。
static CHAT_ABORT_GEN: AtomicU64 = AtomicU64::new(0);

/// BYOK 客户端超时：此前四处 Client::new() 无任何超时——端点挂起（captive portal / SYN 丢包）时
/// 命令永不返回、前端「连接中」永转且 translate_abort 都终止不了（无数据到达时中止检查不执行）。
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 一次性请求（probe / dict_lookup）的总超时。
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// SSE 流空闲超时：有数据流动就不掐，静默断流 30s 后放弃（治 services-4）。
const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// 流式客户端（translate_text / llm_chat）：只限连接时长；总时长由 SSE_IDLE_TIMEOUT 按空闲判定，
/// 不设总超时——长翻译/长对话只要还在产数据就不该被掐。
fn sse_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// 一次性请求客户端（translate_probe / dict_lookup）：连接 + 总超时。
fn once_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .unwrap_or_default()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmCfg {
    base_url: String,
    api_key: String,
    model: String,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    style: String,
    /// 术语对照（buildCfg 组装，Rust 不落盘）。
    #[serde(default)]
    glossary: Vec<GlossaryPair>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlossaryPair {
    a: String,
    b: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMsg {
    role: String,
    content: String,
}

/// chat-delta 事件载荷：text=累计全文（每 delta 重算）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatDeltaPayload {
    req_id: String,
    text: String,
}

/// translate-delta 事件载荷（治 rust-core-2）：text=本次增量（非累计）。
/// 前端按 reqId 过滤——阅读页逐句并发时两条流不再互收对方增量
/// （互收会让每句 UI 长出双句混排译文，并经 onDelta→fillSentenceZh 持久化错乱文本）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranslateDeltaPayload {
    req_id: String,
    text: String,
}

fn endpoint(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else {
        format!("{b}/chat/completions")
    }
}

fn system_prompt(cfg: &LlmCfg) -> String {
    let dir = match cfg.dir.as_str() {
        "c2e" => "把输入的中文翻译成英文",
        "auto" => "自动判断方向：中文译成英文，其他语言译成中文",
        _ => "把输入的英文翻译成中文",
    };
    let style = match cfg.style.as_str() {
        "faith" => "严格忠实原文，不增不减。",
        "eleg" => "在忠实原文的基础上追求译文流畅自然。",
        _ => "平实准确。",
    };
    let mut prompt = format!("你是翻译引擎。{dir}。{style}只输出译文本身：不要解释、不要引号、不要任何前后缀。");
    if !cfg.glossary.is_empty() {
        let pairs: Vec<String> = cfg.glossary.iter().map(|g| format!("{}→{}", g.a, g.b)).collect();
        prompt.push_str(&format!("术语对照（优先采用）：{}。", pairs.join("；")));
    }
    prompt
}

fn status_err(status: reqwest::StatusCode, body: String) -> String {
    let snippet: String = body.chars().take(200).collect();
    let hint = match status.as_u16() {
        401 => "（Key 无效或额度问题）",
        404 => "（接口地址或模型名不对）",
        429 => "（请求过频或额度不足）",
        _ => "",
    };
    format!("HTTP {}{hint} · {}", status.as_u16(), snippet)
}

async fn send(client: &reqwest::Client, cfg: &LlmCfg, body: serde_json::Value) -> Result<reqwest::Response, String> {
    client
        .post(endpoint(&cfg.base_url))
        .bearer_auth(cfg.api_key.trim())
        // SSE 逐字修复（⑨ 半边）：明确要事件流，禁中间层缓冲——部分网关/代理对
        // 缺 Accept 的流式响应会整段攒批后再转发，表现为「译文一次性整段出现」。
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))
}

/// 思考模式兼容（照 ReaderChatClient.swift:78-99 口径，按契约简化为模型键控）：
/// 智谱/GLM → thinking.type=disabled；deepseek-reasoner → enable_thinking=false；
/// qwen3/qwq → enable_thinking=false。translate_text 与 llm_chat 共用。
fn apply_thinking_mode(base_url: &str, model: &str, body: &mut serde_json::Value) {
    let ctx = format!("{base_url} {model}").to_lowercase();
    if ctx.contains("bigmodel") || ctx.contains("zhipu") || ctx.contains("glm") {
        body["thinking"] = json!({"type": "disabled"});
    } else if ctx.contains("deepseek") && ctx.contains("reasoner") {
        body["enable_thinking"] = json!(false);
    } else if ctx.contains("qwen3") || ctx.contains("qwq") {
        body["enable_thinking"] = json!(false);
    }
}

/// ASCII 大小写不敏感子串查找（返回字节偏移；标签是 ASCII，UTF-8 边界安全）。
fn find_ci(s: &str, needle: &str, from: usize) -> Option<usize> {
    let h = s.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    'outer: for i in from..=h.len() - n.len() {
        for (k, &nb) in n.iter().enumerate() {
            let hb = h[i + k];
            // 非 ASCII 字节 |=0x20 后仍 ≥0x80，不会误匹配 ASCII needle
            if hb != nb && (hb | 0x20) != nb {
                continue 'outer;
            }
        }
        if s.is_char_boundary(i) {
            return Some(i);
        }
    }
    None
}

/// 剥离 `<think>…</think>`（含未闭合：丢弃后续全部思考内容）。大小写不敏感。
/// 照 ReaderChatClient.swift:127-147（对齐 translation.rs strip_think_tags）。
fn strip_think_tags(input: &str) -> String {
    if find_ci(input, "<think", 0).is_none() {
        return input.to_string();
    }
    let mut out = String::new();
    let mut rest = input;
    loop {
        match find_ci(rest, "<think", 0) {
            None => {
                out.push_str(rest);
                break;
            }
            Some(start) => {
                out.push_str(&rest[..start]);
                let after = &rest[start + "<think".len()..];
                match find_ci(after, "</think>", 0) {
                    Some(end) => rest = &after[end + "</think>".len()..],
                    // 未闭合：丢弃后续全部思考内容
                    None => break,
                }
            }
        }
    }
    out
}

/// ASCII 忽略大小写比较（半截 think 标签探测用；strip_think_tags 的 find_ci 同口径）。
fn ci_eq_ascii(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
}

/// 可见文本的「稳定长度」：若尾部是 `<think` / `</think` 的半截前缀（标签可能跨 SSE delta 边界），
/// 这段先按住不发——否则标签碎片会被当译文发出、标签补全后被剥掉导致可见文本回缩，
/// 字节游标（emitted）落在多字节字符中间直接 panic（release panic=abort 即真机闪退）。
/// 按住的尾巴若最终不是标签（流结束），由调用方的全量返回兜底，不会丢字。
fn stable_visible_len(visible: &str) -> usize {
    let b = visible.as_bytes();
    let mut hold = 0usize;
    for tag in [b"<think".as_slice(), b"</think".as_slice()] {
        let max = tag.len().min(b.len());
        for k in (1..=max).rev() {
            if ci_eq_ascii(&b[b.len() - k..], &tag[..k]) {
                hold = hold.max(k);
                break;
            }
        }
    }
    let mut cut = b.len() - hold;
    // 标签均为 ASCII，切点必在字符边界；防御性回退对齐
    while cut > 0 && !visible.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// 从一条 SSE chunk JSON 里取可见文本；宽容 delta/message/content/text 等键位
/// （照 ReaderChatClient.swift:282-307；reasoning_content 不进可见文本）。
fn visible_chunk_text(v: &serde_json::Value) -> Option<String> {
    let mut out = String::new();
    if let Some(choices) = v["choices"].as_array() {
        for choice in choices {
            let content = &choice["delta"]["content"];
            if let Some(s) = content.as_str() {
                out.push_str(s);
            } else if let Some(parts) = content.as_array() {
                // content 可能是多模态 [{type:"text",text:"..."}] 数组
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        out.push_str(t);
                    }
                }
            }
            if let Some(s) = choice["message"]["content"].as_str() {
                out.push_str(s);
            }
            if let Some(s) = choice["text"].as_str() {
                out.push_str(s);
            }
        }
    }
    if out.is_empty() {
        if let Some(s) = v["content"].as_str() {
            out.push_str(s);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// SSE 收流公用骨架（translate_text / llm_chat 复用）：
/// 逐 `data:` 行解析 chunk，每个可见 delta 立即回调 `on_delta`（逐 delta 派发，
/// 不攒批），返回累计全文（未剥 think 的原始流）。`should_abort` 每轮收流前轮询。
async fn run_sse(
    client: &reqwest::Client,
    cfg: &LlmCfg,
    body: serde_json::Value,
    mut on_delta: impl FnMut(&str),
    should_abort: impl Fn() -> bool,
) -> Result<String, String> {
    let resp = send(client, cfg, body).await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(status_err(status, text));
    }
    let mut full = String::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    loop {
        let next = tokio::time::timeout(SSE_IDLE_TIMEOUT, stream.next())
            .await
            .map_err(|_| format!("流空闲超时（{}s 无数据）", SSE_IDLE_TIMEOUT.as_secs()))?;
        let chunk = match next {
            Some(c) => c,
            None => break,
        };
        if should_abort() {
            break;
        }
        let chunk = chunk.map_err(|e| format!("流中断：{e}"))?;
        /* 按字节累积、切出完整行后再解码：多字节字符（中文译文）跨 TCP chunk 被劈开时，
           逐 chunk from_utf8_lossy 会产 U+FFFD 乱码并进流式增量与最终译文（治 rust-core-3）。
           \n 不会出现在多字节序列内，按行切是安全的解码边界。 */
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line_str = String::from_utf8_lossy(&line_bytes);
            let line = line_str.trim();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line["data:".len()..].trim();
            if data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                // 错误帧不产文本（空结果由调用方兜底报错）
                if v["error"]["message"].as_str().map(|m| !m.is_empty()).unwrap_or(false) {
                    continue;
                }
                if let Some(delta) = visible_chunk_text(&v) {
                    if !delta.is_empty() {
                        full.push_str(&delta);
                        on_delta(&delta);
                    }
                }
            }
        }
    }
    Ok(full)
}

/// 真实连通性检查：max_tokens=1 的最小请求，返回「状态 · 延迟 · 模型」。
#[tauri::command]
async fn translate_probe(cfg: LlmCfg) -> Result<String, String> {
    let t0 = Instant::now();
    let client = once_client();
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": false,
    });
    let resp = send(&client, &cfg, body).await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(status_err(status, text));
    }
    Ok(format!(
        "{} OK · {}ms · {}",
        status.as_u16(),
        t0.elapsed().as_millis(),
        cfg.model
    ))
}

/// 流式翻译：每个 SSE delta 一次 `translate-delta` emit（载荷 {reqId, text:本次增量}，
/// 前端按 reqId 过滤，治 rust-core-2），返回全量译文。中止：translate_abort 改代数，
/// 循环察觉即停并返回已译部分。think 剥离：按「可见前缀增量」发——剥离后的可见文本
/// 每增长一段才 emit 一次，思考期内可见文本不增长就不发（真流式，禁止假打字机）。
/// 增量只取 stable_visible_len 的稳定前缀：尾部半截 think 标签按住不发，
/// 防止标签补全后被剥掉导致可见文本回缩、字节游标错位（多字节切片 panic）。
#[tauri::command]
async fn translate_text(
    app: tauri::AppHandle,
    text: String,
    cfg: LlmCfg,
    req_id: String,
) -> Result<String, String> {
    let gen = ABORT_GEN.load(Ordering::SeqCst);
    let client = sse_client();
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system_prompt(&cfg)},
            {"role": "user", "content": text},
        ],
        "stream": true,
    });
    apply_thinking_mode(&cfg.base_url, &cfg.model, &mut body);

    let t0 = Instant::now();
    let mut seq: u64 = 0;
    let mut acc = String::new();
    let mut emitted = 0usize;
    let full = run_sse(&client, &cfg, body, |delta| {
        acc.push_str(delta);
        let visible = strip_think_tags(&acc);
        // 只在「稳定前缀」内取增量：尾部半截 think 标签先按住（见 stable_visible_len），
        // 保证 emitted 永不越过后续可能被剥掉的字节，也不会切进多字节字符中间
        let stable = stable_visible_len(&visible);
        if stable > emitted {
            let inc: String = visible[emitted..stable].to_string();
            emitted = stable;
            seq += 1;
            // [td] 逐 delta 时间线（真机对拍：Rust 逐条 vs 前端整段到达 → 事件通道问题）
            eprintln!("[td] req={req_id} seq={seq} ms={} bytes={}", t0.elapsed().as_millis(), inc.len());
            // 备选分支：若 app.emit 广播不达 WebView（个别内核只收窗口定向事件），
            // 改用 app.get_webview_window("main") 定向发送：
            // if let Some(win) = app.get_webview_window("main") { let _ = win.emit("translate-delta", &payload); }
            let _ = app.emit("translate-delta", TranslateDeltaPayload { req_id: req_id.clone(), text: inc });
        }
    }, || ABORT_GEN.load(Ordering::SeqCst) != gen)
    .await?;
    Ok(strip_think_tags(&full).trim().to_string())
}

#[tauri::command]
fn translate_abort() {
    ABORT_GEN.fetch_add(1, Ordering::SeqCst);
}

/// 中止在途的 llm_chat 流（chatStream.stop() 调用；代数通道与 translate_text 同款，治 services-6）。
#[tauri::command]
fn llm_abort() {
    CHAT_ABORT_GEN.fetch_add(1, Ordering::SeqCst);
}

/// 通用对话补全：自定义 systemPrompt + 多轮 messages，事件 `chat-delta`
/// 载荷 {reqId, text:累计全文}（每 delta 重算、已剥 think），返回最终全文。
/// 前端契约：先 await listen("chat-delta") 再 invoke（按 reqId 过滤）。
#[tauri::command]
async fn llm_chat(
    app: tauri::AppHandle,
    cfg: LlmCfg,
    system_prompt: String,
    messages: Vec<ChatMsg>,
    req_id: String,
) -> Result<String, String> {
    let client = sse_client();
    let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + 1);
    if !system_prompt.trim().is_empty() {
        msgs.push(json!({"role": "system", "content": system_prompt}));
    }
    for m in &messages {
        match m.role.as_str() {
            "system" | "user" | "assistant" => {
                msgs.push(json!({"role": m.role, "content": m.content}));
            }
            other => return Err(format!("非法消息角色：{other}")),
        }
    }
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": msgs,
        "temperature": 0.2,
        "stream": true,
    });
    apply_thinking_mode(&cfg.base_url, &cfg.model, &mut body);

    let t0 = Instant::now();
    let mut seq: u64 = 0;
    let mut acc = String::new();
    /* 代数中止（治 services-6）：此前 `|| false` 完全不可中止——陪练「跳过」、笔记页
       退出后整段回复仍在后台拉完，BYOK token 照烧 */
    let gen = CHAT_ABORT_GEN.load(Ordering::SeqCst);
    let full = run_sse(&client, &cfg, body, |delta| {
        acc.push_str(delta);
        let visible = strip_think_tags(&acc);
        seq += 1;
        eprintln!("[cd] req={req_id} seq={seq} ms={} chars={}", t0.elapsed().as_millis(), visible.chars().count());
        let _ = app.emit("chat-delta", ChatDeltaPayload { req_id: req_id.clone(), text: visible });
    }, || CHAT_ABORT_GEN.load(Ordering::SeqCst) != gen)
    .await?;
    Ok(strip_think_tags(&full).trim().to_string())
}

/// AI 词典：非流式，提示词产出 JSON（defs + 例句），容错解析（剥代码围栏）。
#[tauri::command]
async fn dict_lookup(word: String, cfg: LlmCfg) -> Result<serde_json::Value, String> {
    let client = once_client();
    let sys = "你是词典引擎。对给定的英文单词或短语给出简明中文释义。只输出 JSON，格式：{\"defs\":[{\"pos\":\"词性缩写\",\"cn\":\"中文释义\"}],\"ex\":\"一句英文例句 + 中文翻译\"}。defs 给 2-4 条。不要输出 JSON 以外的任何文字。";
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": sys},
            {"role": "user", "content": word},
        ],
        "stream": false,
    });
    let resp = send(&client, &cfg, body).await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(status_err(status, text));
    }
    let content = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v["choices"][0]["message"]["content"].as_str().map(str::to_string))
        .ok_or_else(|| "响应格式异常".to_string())?;
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: serde_json::Value = serde_json::from_str(cleaned).map_err(|_| "释义解析失败".to_string())?;
    if parsed["defs"].is_null() {
        return Err("释义解析失败".to_string());
    }
    Ok(parsed)
}

/// iOS 音频会话：设为 playback 类别——默认 soloAmbient 受静音拨片控制（拨片一拨
/// WebAudio/系统朗读全哑，表现为「合成成功但没声音」）。playback 与音乐类 App 同类，
/// 朗读类学习 App 的预期行为；MixWithOthers(0x1) 不打断用户后台音乐。
/// 录音（getUserMedia）时 WebKit 会自行切 PlayAndRecord，结束后的自动恢复有竞态
/// （见 restore_playback_audio：采集 teardown 时前端会再重设一次）。
///
/// 实现走纯运行时 objc 消息（不引入绑定 crate）：AVFAudio.framework 按需 dlopen——
/// 绑定 crate 的 extern 常量（AVAudioSessionCategoryPlayback）需要 Xcode 工程链接
/// 框架，staticlib 的 -l flag 传不进去（实测 linker 报符号缺失）。返回值全用 raw
/// 指针接：sharedInstance/stringWithUTF8String 都不是 +1 语义，Retained 会过度释放。
/// 失败静默（不影响启动）。
#[cfg(target_os = "ios")]
fn enable_playback_audio_session() {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, NSObject};

    extern "C" {
        fn dlopen(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> *mut std::ffi::c_void;
    }

    // RTLD_NOW(0x2) | RTLD_GLOBAL(0x100)，darwin 值；进程未加载该框架时类查找会是 nil
    unsafe {
        dlopen(
            c"/System/Library/Frameworks/AVFAudio.framework/AVFAudio".as_ptr(),
            0x102,
        );
    }

    let classes =
        unsafe { (AnyClass::get(c"AVAudioSession"), AnyClass::get(c"NSString")) };
    let (Some(cls), Some(nsstring)) = classes else {
        return;
    };
    unsafe {
        let session: *mut NSObject = msg_send![cls, sharedInstance];
        if session.is_null() {
            return;
        }
        let category: *mut NSObject = msg_send![nsstring, stringWithUTF8String: c"playback".as_ptr()];
        if category.is_null() {
            return;
        }
        let (session, category) = (&*session, &*category);
        // setCategory:withOptions:error: 返回 BOOL；成功再激活
        let ok: bool = msg_send![
            session,
            setCategory: category,
            withOptions: 1u64, // AVAudioSessionCategoryOptionMixWithOthers
            error: std::ptr::null_mut::<*mut NSObject>()
        ];
        if ok {
            let _: bool = msg_send![session, setActive: true];
        }
    }
}

/// 录音结束后重设回 playback 会话。WebKit 录音时把会话切到 PlayAndRecord，停止后
/// 的自动恢复有竞态窗口——录制刚停就播的云 TTS 会掉进去（听筒路由/中断态），
/// 表现为「合成成功、流程走完，但全程没声音」。采集 teardown 时前端 fire-and-forget
/// 调用本命令；与启动时同款设置（幂等），非 iOS 平台无操作。
/// AVAudioSession 非线程安全：命令在 tokio 工作线程跑，必须派回主队列执行。
#[tauri::command]
fn restore_playback_audio() {
    #[cfg(target_os = "ios")]
    enable_playback_audio_session_on_main();
}

/// 把闭包派到主队列执行。dispatch 符号经 dlopen/dlsym 运行时取（同 AVFAudio 的
/// 原因：staticlib 的 -l flag 传不进 Xcode 工程，直接 extern 链接报符号缺失）。
#[cfg(target_os = "ios")]
fn enable_playback_audio_session_on_main() {
    use std::ffi::{c_char, c_int, c_void};

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    type GetMainQueueFn = unsafe extern "C" fn() -> *mut c_void;
    type AsyncFFn = unsafe extern "C" fn(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));

    extern "C" fn run_restore(ctx: *mut c_void) {
        /* context 是 *mut Box<dyn FnOnce()>（瘦指针）：from_raw 恢复后执行 */
        let boxed: Box<Box<dyn FnOnce()>> = unsafe { Box::from_raw(ctx as *mut Box<dyn FnOnce()>) };
        let job: Box<dyn FnOnce()> = *boxed;
        job();
    }

    // RTLD_NOW(0x2) | RTLD_GLOBAL(0x100)，darwin 值
    unsafe {
        let h = dlopen(c"/usr/lib/system/libdispatch.dylib".as_ptr(), 0x102);
        if h.is_null() {
            return; /* 主线程派发不可用：保持启动时已设的类别，不强求 */
        }
        let get_q = dlsym(h, c"dispatch_get_main_queue".as_ptr());
        let async_f = dlsym(h, c"dispatch_async_f".as_ptr());
        if get_q.is_null() || async_f.is_null() {
            return;
        }
        let queue = std::mem::transmute::<*mut c_void, GetMainQueueFn>(get_q)();
        let job: Box<dyn FnOnce()> = Box::new(enable_playback_audio_session);
        std::mem::transmute::<*mut c_void, AsyncFFn>(async_f)(
            queue,
            Box::into_raw(Box::new(job)) as *mut c_void,
            run_restore,
        );
    }
}

/// 打开本 App 的系统设置页（相机/麦克风权限被拒后的「去系统设置」引导，治 tools-3）。
/// 同款纯运行时 objc 消息：UIApplicationOpenSettingsURLString 是 UIKit 的 extern
/// NSString 常量——dlopen 拿句柄、dlsym 拿符号地址、再解一次引用才是 NSString 对象。
#[cfg(target_os = "ios")]
fn open_app_settings_ios() -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, NSObject};

    extern "C" {
        fn dlopen(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> *mut std::ffi::c_void;
        fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    }

    unsafe {
        let ui_kit = dlopen(c"/System/Library/Frameworks/UIKit.framework/UIKit".as_ptr(), 0x102);
        if ui_kit.is_null() {
            return Err("UIKit 加载失败".into());
        }
        let sym = dlsym(ui_kit, c"UIApplicationOpenSettingsURLString".as_ptr());
        if sym.is_null() {
            return Err("openSettingsURLString 符号缺失".into());
        }
        let url_str: *mut NSObject = *(sym as *mut *mut NSObject);
        if url_str.is_null() {
            return Err("openSettingsURLString 为空".into());
        }
        let Some(cls) = AnyClass::get(c"UIApplication") else {
            return Err("UIApplication 类缺失".into());
        };
        let app: *mut NSObject = msg_send![cls, sharedApplication];
        if app.is_null() {
            return Err("sharedApplication 为空".into());
        }
        let (app, url_str) = (&*app, &*url_str);
        let ok: bool = msg_send![app, openURL: url_str];
        if ok {
            Ok(())
        } else {
            Err("系统未响应打开设置".into())
        }
    }
}

/// 打开本 App 的系统设置页（前端 openAppSettings 消费；非 iOS 目标如实报不支持）。
#[tauri::command]
fn open_app_settings() -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        open_app_settings_ios()
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("仅 iOS 支持跳转系统设置".into())
    }
}

/* ---------- 真机 TTS 自检（诊断用；ITA_SELFTEST=1 环境变量或 --ita-selftest 参数门禁） ----------
   devicectl 以 DEVICECTL_CHILD_ITA_SELFTEST=1 拉起 App → 前端 boot 时查 selftest_active，
   自动跑「录音→停→立即云播放→对照播放」链路（services/selftest.ts），结果经
   selftest_report 逐行落盘 app 容器 tmp/ita-selftest.jsonl，devicectl copy from 取回判读。 */

static SELFTEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SELFTEST_TRUNCATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn selftest_enabled() -> bool {
    std::env::args().any(|a| a == "--ita-selftest")
        || std::env::var("ITA_SELFTEST").map(|v| v == "1").unwrap_or(false)
}

/// 自检模式是否激活（App 启动后前端轮询一次）。
#[tauri::command]
fn selftest_active() -> bool {
    SELFTEST.load(std::sync::atomic::Ordering::Relaxed)
}

/// 自检结果逐行落盘（每次进程首行先清档）；同时 println 一份供 lldb 直读。
#[tauri::command]
fn selftest_report(line: String) {
    use std::io::Write as _;
    println!("[ita-selftest] {line}");
    let path = std::env::temp_dir().join("ita-selftest.jsonl");
    let first = !SELFTEST_TRUNCATED.swap(true, std::sync::atomic::Ordering::Relaxed);
    let file = if first {
        std::fs::File::create(&path)
    } else {
        std::fs::OpenOptions::new().create(true).append(true).open(&path)
    };
    if let Ok(mut f) = file {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if selftest_enabled() {
        SELFTEST.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    #[cfg(target_os = "ios")]
    enable_playback_audio_session();
    tauri::Builder::default()
        // 设备能力插件（A2 经官方 JS 包消费；capabilities/default.json 已授权）
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_share::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            storage_probe,
            share_text,
            open_app_settings,
            restore_playback_audio,
            selftest_active,
            selftest_report,
            translate_probe,
            translate_text,
            translate_abort,
            llm_abort,
            dict_lookup,
            llm_chat,
            voice::iat::asr_start,
            voice::iat::asr_push,
            voice::iat::asr_finish,
            voice::iat::asr_abort,
            voice::ise::xfyun_ise_assess,
            voice::tts::xfyun_tts_speak,
            voice::edge_tts::edge_tts_speak,
            ocr::ocr_image,
            keychain::secret_put,
            keychain::secret_get,
            keychain::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 连通性检查：WebView → Rust command。
#[tauri::command]
fn ping() -> String {
    "pong".into()
}

/// 沙盒可写目录探针（保留 spike 观察点）。
#[tauri::command]
fn storage_probe(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let probe = dir.join("probe.txt");
    std::fs::write(&probe, b"spike").map_err(|e| format!("write: {e}"))?;
    let read_back = std::fs::read_to_string(&probe).map_err(|e| format!("read: {e}"))?;
    Ok(format!("{dir:?} read_back={read_back}"))
}

/// 系统分享文本（收尾实化）：tauri-plugin-share 2.0.5 原生侧只有文件分享命令
/// （Swift SharePlugin.shareFile → UIActivityViewController），没有文本命令——前端此前的
/// `plugin:share|share` 直调必失败。真实路径：文本写入临时 .txt，经插件 Rust 侧
/// ShareExt::share_file（run_mobile_plugin，不经 WebView ACL）调起真分享面板。
/// 非 iOS 无原生面板，返回错误由前端回退复制。
#[tauri::command]
async fn share_text(app: tauri::AppHandle, title: String, text: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_share::{ShareExt, ShareRequest};
        let safe = if title.trim().is_empty() {
            "分享".to_string()
        } else {
            title.trim().replace(['/', ':'], "-")
        };
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("{safe}-{millis}.txt"));
        std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写临时文件失败：{e}"))?;
        app.share_file()
            .share_file(ShareRequest {
                path: Some(path.to_string_lossy().into_owned()),
                mime: Some("text/plain".into()),
                group: None,
            })
            .map_err(|e| format!("系统分享失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, &title, &text);
        Err("系统分享面板仅 iOS 提供".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_think_closed_and_none() {
        assert_eq!(strip_think_tags("纯文本"), "纯文本");
        assert_eq!(strip_think_tags("<think>推理</think>答案"), "答案");
        assert_eq!(strip_think_tags("前<think>a</think>中<think>b</think>后"), "前中后");
    }

    #[test]
    fn strip_think_unclosed_discards_tail() {
        // 未闭合：丢弃后续全部思考内容（ReaderChatClient.swift:138-144）
        assert_eq!(strip_think_tags("可见<think>还在想"), "可见");
        assert_eq!(strip_think_tags("a<think>x"), "a");
    }

    #[test]
    fn strip_think_case_insensitive() {
        assert_eq!(strip_think_tags("<THINK>secret</THINK>ok"), "ok");
        assert_eq!(strip_think_tags("<Think>secret</think>ok"), "ok");
    }

    #[test]
    fn find_ci_byte_offsets() {
        assert_eq!(find_ci("hello World", "world", 0), Some(6));
        // 返回字节偏移：中文每字 3 字节，「中文 abc」里 abc 在字节 7
        assert_eq!(find_ci("中文 abc", "abc", 0), Some(7));
        assert_eq!(find_ci("abc", "abcd", 0), None);
        // 多字节字符不会撞上 ASCII needle
        assert_eq!(find_ci("你好", "<think", 0), None);
    }

    #[test]
    fn system_prompt_glossary_injection() {
        let mut cfg = LlmCfg {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            dir: "e2c".into(),
            style: String::new(),
            glossary: vec![],
        };
        let plain = system_prompt(&cfg);
        assert!(plain.contains("把输入的英文翻译成中文"));
        assert!(!plain.contains("术语对照"));
        cfg.glossary = vec![
            GlossaryPair { a: "woonerf".into(), b: "生活庭院".into() },
            GlossaryPair { a: "chat".into(), b: "闲聊".into() },
        ];
        let with = system_prompt(&cfg);
        assert!(with.contains("术语对照（优先采用）：woonerf→生活庭院；chat→闲聊。"), "{with}");
    }

    #[test]
    fn thinking_mode_matrix() {
        let mut b = json!({"model": "m"});
        apply_thinking_mode("https://open.bigmodel.cn/api/paas/v4", "glm-4.6", &mut b);
        assert_eq!(b["thinking"]["type"], "disabled");

        let mut b = json!({"model": "m"});
        apply_thinking_mode("https://api.deepseek.com", "deepseek-reasoner", &mut b);
        assert_eq!(b["enable_thinking"], false);

        let mut b = json!({"model": "m"});
        apply_thinking_mode("https://dashscope.aliyuncs.com", "qwen3-max", &mut b);
        assert_eq!(b["enable_thinking"], false);

        let mut b = json!({"model": "m"});
        apply_thinking_mode("https://api.deepseek.com", "deepseek-chat", &mut b);
        assert!(b.get("enable_thinking").is_none() && b.get("thinking").is_none());

        let mut b = json!({"model": "m"});
        apply_thinking_mode("https://api.openai.com/v1", "gpt-4o-mini", &mut b);
        assert!(b.get("enable_thinking").is_none() && b.get("thinking").is_none());
    }

    #[test]
    fn visible_chunk_text_key_tolerance() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).unwrap();
        assert_eq!(visible_chunk_text(&v).as_deref(), Some("hi"));
        let v: serde_json::Value =
            serde_json::from_str(r#"{"choices":[{"message":{"content":"full"}}]}"#).unwrap();
        assert_eq!(visible_chunk_text(&v).as_deref(), Some("full"));
        let v: serde_json::Value =
            serde_json::from_str(r#"{"choices":[{"delta":{"reasoning_content":"想"}}]}"#).unwrap();
        assert!(visible_chunk_text(&v).is_none(), "推理流不进可见文本");
        let v: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(visible_chunk_text(&v).as_deref(), Some("ab"));
    }

    #[test]
    fn translate_delta_payload_camel_case() {
        // 前端按 e.payload.reqId 过滤（治 rust-core-2）：序列化键必须是 camelCase
        let v = serde_json::to_value(TranslateDeltaPayload { req_id: "t1".into(), text: "你好".into() }).unwrap();
        assert_eq!(v["reqId"], "t1");
        assert_eq!(v["text"], "你好");
        assert!(v.get("req_id").is_none());
    }

    #[test]
    fn stable_visible_len_holds_partial_think_tag() {
        // 尾部半截 <think / </think 前缀按住不发（含大小写变体与多字节正文）
        assert_eq!(stable_visible_len("哈<thi"), "哈".len());
        assert_eq!(stable_visible_len("ab<Thi"), 2);
        assert_eq!(stable_visible_len("x</thin"), 1);
        // 无标签的普通文本不按（"< " 带空格不是标签前缀）
        assert_eq!(stable_visible_len("a < b"), "a < b".len());
        assert_eq!(stable_visible_len("你好"), "你好".len());
    }

    #[test]
    fn translate_delta_cursor_never_cuts_mid_char() {
        // 复现 rust-core-1：`<think` 跨 delta 补全后可见文本回缩，
        // 旧实现按裸字节游标切片会切进多字节字符中间 panic；现在只发稳定前缀
        let mut acc = String::new();
        let mut emitted = 0usize;
        let mut outs: Vec<String> = Vec::new();
        for delta in ["哈<thi", "nk>你好", "</think>", "世"] {
            acc.push_str(delta);
            let visible = strip_think_tags(&acc);
            let stable = stable_visible_len(&visible);
            if stable > emitted {
                outs.push(visible[emitted..stable].to_string());
                emitted = stable;
            }
        }
        // "哈" 先行发出；"<think>你好</think>" 整块被剥掉；闭块后的 "世" 正常续接
        assert_eq!(outs, vec!["哈".to_string(), "世".to_string()]);
    }
}
