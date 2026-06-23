use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
pub struct TranslateRequest {
    pub text: String,
    pub endpoint: String, // OpenAI 兼容接口地址
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub stream: bool,
    pub window_label: String, // 发送事件的目标窗口 label，默认 "panel"
}

#[derive(Serialize, Clone)]
struct DeltaEvent {
    text: String,
    elapsed_ms: u128,
}

#[derive(Serialize, Clone)]
struct DoneEvent {
    text: String,
    elapsed_ms: u128,
    model: String,
}

#[derive(Serialize, Clone)]
struct ErrorEvent {
    kind: String, // "http" | "network" | "timeout" | "empty" | "invalid"
    status: Option<u16>,
    body: String,
}

/// 规范化接口地址：确保以 /chat/completions 结尾。对齐 Mac 版逻辑。
fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

fn build_body(req: &TranslateRequest, stream: bool) -> serde_json::Value {
    serde_json::json!({
        "model": req.model,
        "stream": stream,
        "messages": [
            { "role": "system", "content": req.system_prompt },
            { "role": "user", "content": format!("<text>{}</text>", req.text) }
        ]
    })
}

#[tauri::command]
pub async fn translate_stream(app: AppHandle, req: TranslateRequest) -> Result<(), String> {
    let target = normalize_endpoint(&req.endpoint);
    let window_label = req.window_label.clone();
    if target.is_empty() {
        let _ = app.emit_to(
            window_label.as_str(),
            "translation:error",
            ErrorEvent {
                kind: "invalid".into(),
                status: None,
                body: "接口地址为空".into(),
            },
        );
        return Err("接口地址为空".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request_builder = client.post(&target).header("Content-Type", "application/json");

    if !req.api_key.trim().is_empty() {
        request_builder =
            request_builder.header("Authorization", format!("Bearer {}", req.api_key));
    }

    let body = build_body(&req, req.stream);
    let response = request_builder.json(&body).send().await;

    let response = match response {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:error",
                ErrorEvent {
                    kind: "timeout".into(),
                    status: None,
                    body: e.to_string(),
                },
            );
            return Ok(());
        }
        Err(e) => {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:error",
                ErrorEvent {
                    kind: "network".into(),
                    status: None,
                    body: e.to_string(),
                },
            );
            return Ok(());
        }
    };

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let _ = app.emit_to(
            window_label.as_str(),
            "translation:error",
            ErrorEvent {
                kind: "http".into(),
                status: Some(status),
                body: body_text,
            },
        );
        return Ok(());
    }

    let start = Instant::now();

    if req.stream {
        // 流式：按行读取 SSE data: 行
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full_text = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    let _ = app.emit_to(
                        window_label.as_str(),
                        "translation:error",
                        ErrorEvent {
                            kind: "network".into(),
                            status: None,
                            body: e.to_string(),
                        },
                    );
                    return Ok(());
                }
            };
            buffer.push_str(std::str::from_utf8(&chunk).unwrap_or(""));
            // 按行处理
            while let Some(newline_idx) = buffer.find('\n') {
                let line: String = buffer.drain(..=newline_idx).collect();
                let trimmed = line.trim();
                if !trimmed.starts_with("data:") {
                    continue;
                }
                let data = trimmed.trim_start_matches("data:").trim();
                if data == "[DONE]" {
                    continue;
                }
                // 解析 JSON: choices[0].delta.content
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(delta);
                        let _ = app.emit_to(
                            window_label.as_str(),
                            "translation:delta",
                            DeltaEvent {
                                text: full_text.clone(),
                                elapsed_ms: start.elapsed().as_millis(),
                            },
                        );
                    }
                }
            }
        }

        if full_text.trim().is_empty() {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:error",
                ErrorEvent {
                    kind: "empty".into(),
                    status: None,
                    body: String::new(),
                },
            );
        } else {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:done",
                DoneEvent {
                    text: full_text,
                    elapsed_ms: start.elapsed().as_millis(),
                    model: req.model.clone(),
                },
            );
        }
    } else {
        // 非流式：直接解析完整 JSON
        let body_text = response.text().await.unwrap_or_default();
        let parsed: serde_json::Value = match serde_json::from_str(&body_text) {
            Ok(v) => v,
            Err(_) => {
                let _ = app.emit_to(
                    window_label.as_str(),
                    "translation:error",
                    ErrorEvent {
                        kind: "invalid".into(),
                        status: Some(200),
                        body: body_text,
                    },
                );
                return Ok(());
            }
        };
        let content = parsed["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();

        if content.is_empty() {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:error",
                ErrorEvent {
                    kind: "empty".into(),
                    status: None,
                    body: String::new(),
                },
            );
        } else {
            let _ = app.emit_to(
                window_label.as_str(),
                "translation:done",
                DoneEvent {
                    text: content,
                    elapsed_ms: start.elapsed().as_millis(),
                    model: req.model.clone(),
                },
            );
        }
    }

    Ok(())
}
