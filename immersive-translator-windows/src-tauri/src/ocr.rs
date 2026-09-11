//! 截图 OCR 识别。对齐 Mac 版 OCRReader。
//!
//! 用 paddle-ocr-rs（PaddleOCR via ONNX Runtime）做本地离线识别。
//! 模型文件放 app_data_dir/models/，首次使用时从打包资源或网络下载。
//!
//! 三个模型文件：
//! - det：文本检测（DBNet）
//! - cls：方向分类（判断文字是否倒置）
//! - rec：文本识别（CRNN）
//!
//! 模型在进程内全局单例，首次调用懒加载，之后复用。

use paddle_ocr_rs::ocr_lite::OcrLite;
use paddle_ocr_rs::ocr_result::{OcrResult, Point};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 全局 OCR 引擎。模型加载较慢（~1-2s），加载后复用。
pub struct OcrEngine {
    inner: Mutex<Option<OcrLite>>,
    models_dir: Mutex<std::path::PathBuf>,
    fullscreen: Mutex<Option<crate::screenshot::CapturedImage>>,
}

impl Default for OcrEngine {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            models_dir: Mutex::new(std::path::PathBuf::new()),
            fullscreen: Mutex::new(None),
        }
    }
}

pub fn set_fullscreen_snapshot(
    engine: State<'_, OcrEngine>,
    image: crate::screenshot::CapturedImage,
) {
    *engine.fullscreen.lock().unwrap() = Some(image);
}

/// 识别出的单个文本块（含坐标 + 置信度），用于前端高亮 + 段落整理。
#[derive(serde::Serialize, Clone)]
pub struct OcrTextBlock {
    pub text: String,
    pub score: f32,
    /// 文本框四个角点的 x 坐标（用于排序）。
    pub x: u32,
    pub y: u32,
}

/// 识别结果：整理后的段落文本 + 各文本块明细。
#[derive(serde::Serialize)]
pub struct OcrOutput {
    /// 按阅读顺序（从上到下、从左到右）整理后的纯文本。
    pub text: String,
    /// 各文本块（含坐标/置信度），前端可用来高亮或修正。
    pub blocks: Vec<OcrTextBlock>,
}

/// 检查模型文件是否就绪（只需 det + rec；cls 可选）。
#[tauri::command]
pub fn ocr_models_ready(app: AppHandle) -> bool {
    match models_dir(&app) {
        Ok(dir) => {
            let det = dir.join("ch_PP-OCRv4_det_infer.onnx");
            let rec = dir.join("ch_PP-OCRv4_rec_infer.onnx");
            det.exists() && rec.exists()
        }
        Err(_) => false,
    }
}

/// 识别截图。
/// 入参：rgba（BGRA 字节，来自 BitBlt）、width、height。
#[tauri::command]
pub async fn ocr_recognize(
    app: AppHandle,
    engine: State<'_, OcrEngine>,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<OcrOutput, String> {
    if width == 0 || height == 0 {
        return Err("截图尺寸为 0".into());
    }
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() < expected {
        return Err(format!(
            "截图数据不完整：期望 {} 字节，实际 {}",
            expected,
            rgba.len()
        ));
    }

    // 确保 models_dir 已设置
    let dir = models_dir(&app)?;
    *engine.models_dir.lock().unwrap() = dir.clone();

    // 懒加载模型
    {
        let mut guard = engine.inner.lock().unwrap();
        if guard.is_none() {
            let det = dir.join("ch_PP-OCRv4_det_infer.onnx");
            let cls = dir.join("ch_ppocr_mobile_v2.0_cls_infer.onnx");
            let rec = dir.join("ch_PP-OCRv4_rec_infer.onnx");
            if !det.exists() || !rec.exists() {
                return Err(
                    "OCR 模型未就绪。请在设置里下载中文模型，或检查 app_data_dir/models/ 目录。"
                        .into(),
                );
            }
            // cls（方向分类）模型可选：缺失时用 det 文件占位。
            // 因为 detect 传 doAngle=false，cls 的 session 永远不会被实际调用
            // （AngleNet::get_angles 在 do_angle=false 时直接返回默认值）。
            // 这样用户只需下载 det + rec 两个模型即可使用 OCR。
            let cls_path = if cls.exists() {
                cls.to_str().unwrap().to_string()
            } else {
                eprintln!("[ocr] cls 模型缺失，用 det 占位（doAngle=false 下不影响识别）");
                det.to_str().unwrap().to_string()
            };
            let mut ocr = OcrLite::new();
            ocr.init_models(
                det.to_str().unwrap(),
                &cls_path,
                rec.to_str().unwrap(),
                2, // 线程数
            )
            .map_err(|e| format!("加载 OCR 模型失败: {e}"))?;
            *guard = Some(ocr);
        }
    }

    // BGRA → RGB（BitBlt 给的是 BGRA，paddle-ocr-rs 要 RGB）
    let rgb = bgra_to_rgb(&rgba);

    // 用 image crate 包装成 OcrLite 需要的 RgbImage
    let img = image::RgbImage::from_raw(width, height, rgb)
        .ok_or_else(|| "构造 RgbImage 失败（尺寸/数据不匹配）".to_string())?;
    let img = image::DynamicImage::ImageRgb8(img).to_rgb8();

    // 识别（参数对齐 Mac 的默认值：padding=50, maxSideLen=1024,
    //   boxScoreThresh=0.5, boxUnclipRatio=0.3, unclipRatio=1.6, doAngle=false, mostAngle=false）
    // doAngle=false：跳过方向分类模型（cls），因为大多数截图文字是正的，
    // 且 cls 模型获取困难。需要方向纠正时可在拿到 cls 模型后改为 true。
    let result = {
        let mut guard = engine.inner.lock().unwrap();
        let ocr = guard.as_mut().unwrap();
        ocr.detect(&img, 50, 1024, 0.5, 0.3, 1.6, false, false)
            .map_err(|e| format!("OCR 识别失败: {e}"))?
    };

    Ok(organize(result))
}

/// 从已缓存的全屏截图中识别指定区域。
///
/// 流程：
/// 1. open_ocr_overlay 在 overlay 显示前截取并缓存全屏
/// 2. 按选区裁剪（选区坐标是逻辑 CSS 像素，需乘 DPI 缩放转物理像素）
/// 3. OCR 识别
///
/// x/y/w/h：逻辑 CSS 像素坐标（来自前端 mouseEvent.clientX/Y）。
#[tauri::command]
pub async fn ocr_recognize_from_fullscreen(
    app: AppHandle,
    engine: State<'_, OcrEngine>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<OcrOutput, String> {
    if w <= 0 || h <= 0 {
        return Err("选区尺寸无效".into());
    }

    let full = {
        let guard = engine.fullscreen.lock().unwrap();
        guard
            .clone()
            .ok_or_else(|| "未找到截图缓存，请重新截图".to_string())?
    };

    // 计算 DPI 缩放：物理像素 / 逻辑像素
    // full.width 是物理像素宽度。前端传的 x/y/w/h 是逻辑 CSS 像素。
    // 我们需要知道屏幕的逻辑宽度来算缩放比。
    // 用主窗口（panel/settings）的 scale_factor 作为近似。
    let scale = app
        .get_webview_window("ocr-overlay")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.5); // 默认 150%（大多数 Windows 笔记本）
    eprintln!("[ocr] dpi scale factor: {scale}, logical rect: {x},{y} {w}x{h}");

    // 逻辑坐标 → 物理坐标
    let px = (x as f64 * scale).round() as i32;
    let py = (y as f64 * scale).round() as i32;
    let pw = (w as f64 * scale).round() as i32;
    let ph = (h as f64 * scale).round() as i32;

    // 裁剪边界保护
    let px = px.max(0).min(full.width as i32 - 1);
    let py = py.max(0).min(full.height as i32 - 1);
    let pw = pw.min(full.width as i32 - px);
    let ph = ph.min(full.height as i32 - py);
    eprintln!(
        "[ocr] physical rect: {px},{py} {pw}x{ph}, full: {}x{}",
        full.width, full.height
    );

    if pw < 2 || ph < 2 {
        return Err(format!("裁剪后选区太小: {pw}x{ph}"));
    }

    // 从全屏 BGRA 里抠出选区
    let region = crop_bgra(&full.bgra, full.width, full.height, px, py, pw, ph)?;
    eprintln!("[ocr] cropped region bytes: {}", region.len());

    // 4. OCR 识别（复用和 ocr_recognize 相同的逻辑）
    let rgb = bgra_to_rgb(&region);
    let img = image::RgbImage::from_raw(pw as u32, ph as u32, rgb)
        .ok_or_else(|| "构造选区 RgbImage 失败".to_string())?;

    // 确保模型已加载
    let dir = models_dir(&app)?;
    *engine.models_dir.lock().unwrap() = dir.clone();
    {
        let mut guard = engine.inner.lock().unwrap();
        if guard.is_none() {
            eprintln!("[ocr] loading models from {}", dir.display());
            let det = dir.join("ch_PP-OCRv4_det_infer.onnx");
            let rec = dir.join("ch_PP-OCRv4_rec_infer.onnx");
            if !det.exists() || !rec.exists() {
                return Err("OCR 模型未就绪".into());
            }
            let cls_path = det.to_str().unwrap().to_string();
            let mut ocr = OcrLite::new();
            ocr.init_models(det.to_str().unwrap(), &cls_path, rec.to_str().unwrap(), 2)
                .map_err(|e| format!("加载 OCR 模型失败: {e}"))?;
            *guard = Some(ocr);
            eprintln!("[ocr] models loaded");
        }
    }

    let result = {
        let mut guard = engine.inner.lock().unwrap();
        let ocr = guard.as_mut().unwrap();
        eprintln!("[ocr] detect start");
        ocr.detect(&img, 50, 1024, 0.5, 0.3, 1.6, false, false)
            .map_err(|e| format!("OCR 识别失败: {e}"))?
    };
    eprintln!("[ocr] detect done, blocks: {}", result.text_blocks.len());

    Ok(organize(result))
}

/// 从全屏 BGRA 缓冲里裁剪出指定区域。
fn crop_bgra(
    full: &[u8],
    full_w: u32,
    full_h: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for row in 0..h as u32 {
        let src_y = y as u32 + row;
        if src_y >= full_h {
            break;
        }
        for col in 0..w as u32 {
            let src_x = x as u32 + col;
            if src_x >= full_w {
                break;
            }
            let idx = ((src_y * full_w + src_x) * 4) as usize;
            if idx + 4 <= full.len() {
                out.extend_from_slice(&full[idx..idx + 4]);
            }
        }
    }
    Ok(out)
}

/// BGRA 字节 → RGB 字节（丢弃 alpha，交换 B/R 通道）。
fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    for chunk in bgra.chunks_exact(4) {
        // Windows BitBlt + 32bpp: 顺序是 B, G, R, A
        rgb.push(chunk[2]); // R
        rgb.push(chunk[1]); // G
        rgb.push(chunk[0]); // B
    }
    rgb
}

/// 把识别结果按阅读顺序整理（从上到下、从左到右）。
/// 对齐 Mac 的段落整理：同一行（y 接近）的文字合并成一行。
fn organize(result: OcrResult) -> OcrOutput {
    if result.text_blocks.is_empty() {
        return OcrOutput {
            text: String::new(),
            blocks: vec![],
        };
    }

    // 提取每个块的左上角坐标
    let mut blocks: Vec<OcrTextBlock> = result
        .text_blocks
        .into_iter()
        .map(|tb| {
            let (x, y) = top_left(&tb.box_points);
            OcrTextBlock {
                text: tb.text.clone(),
                score: tb.text_score,
                x,
                y,
            }
        })
        .collect();

    // 按 y 分组（同行），组内按 x 排序
    blocks.sort_by(|a, b| {
        // 行高容差：取平均字高的 0.6 倍，或固定 15px
        let line_tol = 15;
        if (a.y as i32 - b.y as i32).abs() <= line_tol {
            a.x.cmp(&b.x)
        } else {
            a.y.cmp(&b.y)
        }
    });

    // 拼成文本：同行用空格连，不同行换行
    let mut text = String::new();
    let mut last_y: Option<u32> = None;
    let mut line_buf = String::new();
    for b in &blocks {
        match last_y {
            Some(y) if (y as i32 - b.y as i32).abs() <= 15 => {
                // 同行
                if !line_buf.is_empty() {
                    line_buf.push(' ');
                }
                line_buf.push_str(&b.text);
            }
            _ => {
                // 新行
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&line_buf);
                line_buf.clear();
                line_buf.push_str(&b.text);
            }
        }
        last_y = Some(b.y);
    }
    if !line_buf.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line_buf);
    }

    OcrOutput { text, blocks }
}

/// 取多个点中最左上的点（用于排序基准）。
fn top_left(points: &[Point]) -> (u32, u32) {
    points
        .iter()
        .min_by_key(|p| (p.y, p.x))
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0))
}

fn models_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    let models = dir.join("models");
    std::fs::create_dir_all(&models).map_err(|e| format!("无法创建模型目录: {e}"))?;
    Ok(models)
}

/// 模型下载来源。modelscope 在国内较快且稳定。
/// 仓库：deadash/paddleocr（含 PaddleOCR v4 的 det + rec onnx）。
const MODEL_SOURCES: &[(&str, &str)] = &[
    (
        "ch_PP-OCRv4_det_infer.onnx",
        "https://modelscope.cn/api/v1/models/deadash/paddleocr/repo?Revision=master&FilePath=ch_PP-OCRv4_det_infer.onnx",
    ),
    (
        "ch_PP-OCRv4_rec_infer.onnx",
        "https://modelscope.cn/api/v1/models/deadash/paddleocr/repo?Revision=master&FilePath=ch_PP-OCRv4_rec_infer.onnx",
    ),
];

/// 下载 OCR 模型（det + rec）到 app_data_dir/models/。
/// 通过 emit("ocr:download:progress", { downloaded, total, file }) 报告进度。
#[tauri::command]
pub async fn ocr_download_models(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let dir = models_dir(&app)?;
    let client = reqwest::Client::builder()
        // ModelScope 下载服务会拒绝缺少 User-Agent 的请求（HTTP 403）。
        .user_agent(concat!("ImmersiveTranslator/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    for (filename, url) in MODEL_SOURCES {
        let dest = dir.join(filename);
        if dest.exists() {
            let _ = app.emit(
                "ocr:download:progress",
                serde_json::json!({ "file": filename, "status": "exists", "downloaded": 0, "total": 0 }),
            );
            continue;
        }

        let _ = app.emit(
            "ocr:download:progress",
            serde_json::json!({ "file": filename, "status": "downloading", "downloaded": 0, "total": 0 }),
        );

        let resp = client
            .get(*url)
            .send()
            .await
            .map_err(|e| format!("下载 {filename} 失败: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "下载 {filename} 失败: HTTP {}",
                resp.status().as_u16()
            ));
        }

        let total = resp.content_length().unwrap_or(0);
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取 {filename} 失败: {e}"))?;

        std::fs::write(&dest, &bytes).map_err(|e| format!("写入 {filename} 失败: {e}"))?;

        let _ = app.emit(
            "ocr:download:progress",
            serde_json::json!({ "file": filename, "status": "done", "downloaded": bytes.len(), "total": total }),
        );
    }

    let _ = app.emit(
        "ocr:download:progress",
        serde_json::json!({ "file": "*", "status": "complete" }),
    );
    Ok(())
}
