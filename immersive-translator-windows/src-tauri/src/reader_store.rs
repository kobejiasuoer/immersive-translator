//! 沉浸阅读室本地存储。
//!
//! - 文章（含句对、进度、按文章的设置覆盖）：app_data_dir/reader_articles.json
//! - 生词（SRS 状态）+ 复习打卡日志：app_data_dir/reader_vocab.json
//!
//! 数据结构与前端 src/core/readerTypes.ts（contracts/reading-room.schema.json v1）
//! 同构，camelCase 序列化。到期判定与计数都从同一份 srs.dueAt 推导。
//!
//! 日期键（打卡/今日计数）由前端按本地时区传入 YYYY-MM-DD；后端只做
//! 字符串日历算术（前一天 = civil(days - 1)），不引入时区依赖。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const READER_SCHEMA_VERSION: u32 = 1;

// ---------- 文章 ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArticleSourceType {
    Paste,
    Url,
    Epub,
    Pdf,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SentenceZhState {
    Pending,
    Done,
    Failed,
    Edited,
}

/// 词块类型：搭配 / 短语动词 / 习语 / 句式框架。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChunkType {
    Collocation,
    Phrasal,
    Idiom,
    Pattern,
}

/// 句内标注的一个词块。text 必须是 en 的连续子串（前端解析时强校验）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SentenceChunk {
    pub text: String,
    pub chunk_type: ChunkType,
    pub gloss: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trap: Option<String>,
}

/// 一篇文章的词块标注状态。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArticleChunkState {
    Pending,
    Done,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SentencePair {
    pub idx: u32,
    pub paragraph_idx: u32,
    pub en: String,
    /// null = 尚未翻译
    pub zh: Option<String>,
    pub zh_state: SentenceZhState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revealed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks: Option<Vec<SentenceChunk>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArticleProgress {
    pub sentence_idx: u32,
    /// 0–100
    pub percent: f64,
    pub seconds_listened: f64,
}

/// 阅读设置覆盖（字段与 ReaderSettings 对齐，全部可选）。
/// 只承载透传，不解释语义；合并逻辑在前端 mergeReaderSettings。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSettingsOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_translation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_progress: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zen_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_pair: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sentence_pause_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_highlight: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_vocab_marks: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_cn: Option<String>,
    pub title_cn_state: SentenceZhState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub source_type: ArticleSourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub word_count: u32,
    pub created_at: i64,
    pub last_read_at: i64,
    pub progress: ArticleProgress,
    pub sentences: Vec<SentencePair>,
    /// 词块标注进度；缺省 = 从未标注
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_state: Option<ArticleChunkState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ReaderSettingsOverride>,
}

/// 书架条目：文章去掉句对正文，加句数。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
    #[serde(flatten)]
    pub article: Article,
    pub sentence_count: u32,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArticlesFile {
    pub schema_version: u32,
    #[serde(default)]
    pub articles: Vec<Article>,
}

// ---------- 生词 ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabSrsState {
    pub ease: f64,
    pub interval_days: f64,
    pub reps: u32,
    /// Unix 毫秒；到期判定唯一依据
    pub due_at: i64,
    pub lapses: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabSense {
    pub pos: String,
    pub cn: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabCollocation {
    pub en: String,
    pub cn: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabSource {
    pub article_id: String,
    pub sentence_idx: u32,
}

/// 无文章来源的生词（如划词浮窗收藏）配的 LLM 例句。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabExample {
    pub en: String,
    pub zh: Option<String>,
}

/// 生词条目类别：单词 / 词块。缺省视为 word（老数据无需迁移）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VocabKind {
    Word,
    Chunk,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabWord {
    /// 归一化后的唯一键
    pub id: String,
    pub word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<VocabKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub senses: Vec<VocabSense>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forms: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collocations: Option<Vec<VocabCollocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_type: Option<ChunkType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trap: Option<String>,
    pub source: VocabSource,
    pub srs: VocabSrsState,
    pub added_at: i64,
    /// source.article_id 为空（划词收藏）时的 LLM 例句，复习卡用作出语境。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<VocabExample>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLogDay {
    /// 本地日期 YYYY-MM-DD
    pub day: String,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLogFile {
    pub schema_version: u32,
    #[serde(default)]
    pub days: Vec<ReviewLogDay>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabFile {
    pub schema_version: u32,
    #[serde(default)]
    pub words: Vec<VocabWord>,
    #[serde(default)]
    pub review_log: ReviewLogFile,
}

/// 屏 D 左栏统计（与前端 readerSrs.reviewStats 同口径、同结构）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStats {
    pub due_now: u32,
    pub reviewed_today: u32,
    pub total: u32,
    pub streak: u32,
    pub distribution: MasteryDistribution,
    pub total_words: u32,
    pub total_chunks: u32,
    pub due_words: u32,
    pub due_chunks: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MasteryDistribution {
    pub learning: u32,
    pub familiar: u32,
    pub mastered: u32,
}

// ---------- 存取 ----------

fn articles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("reader_articles.json"))
}

fn vocab_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("reader_vocab.json"))
}

/// 串行化读写，避免两个窗口并发保存互相覆盖。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入 {path:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

fn load_articles(app: &AppHandle) -> Result<ArticlesFile, String> {
    let path = articles_path(app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(empty_articles_file()),
    };
    if text.trim().is_empty() {
        return Ok(empty_articles_file());
    }
    let file: ArticlesFile =
        serde_json::from_str(&text).map_err(|e| format!("文章数据损坏: {e}"))?;
    check_schema(file.schema_version)?;
    Ok(file)
}

fn load_vocab(app: &AppHandle) -> Result<VocabFile, String> {
    let path = vocab_path(app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(empty_vocab_file()),
    };
    if text.trim().is_empty() {
        return Ok(empty_vocab_file());
    }
    let file: VocabFile = serde_json::from_str(&text).map_err(|e| format!("生词数据损坏: {e}"))?;
    check_schema(file.schema_version)?;
    Ok(file)
}

/// 缺文件/空文件返回的默认结构必须带当前版本号，
/// 否则首次保存会把 schemaVersion=0 写进盘，下次读取触发版本不兼容。
fn empty_articles_file() -> ArticlesFile {
    ArticlesFile {
        schema_version: READER_SCHEMA_VERSION,
        articles: Vec::new(),
    }
}

fn empty_vocab_file() -> VocabFile {
    VocabFile {
        schema_version: READER_SCHEMA_VERSION,
        words: Vec::new(),
        review_log: ReviewLogFile::default(),
    }
}

/// 主版本不同的数据要友好报错而不是静默清空（contracts/README.md 约定）。
fn check_schema(version: u32) -> Result<(), String> {
    if version != READER_SCHEMA_VERSION {
        return Err(format!(
            "阅读室数据版本不兼容（文件 v{version}，应用 v{READER_SCHEMA_VERSION}）。请升级应用后再打开。"
        ));
    }
    Ok(())
}

fn summary(article: Article) -> ArticleSummary {
    ArticleSummary {
        sentence_count: article.sentences.len() as u32,
        article,
    }
}

// ---------- 命令 ----------

#[tauri::command]
pub fn reader_list_articles(app: AppHandle) -> Result<Vec<ArticleSummary>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_articles(&app)?;
    file.articles
        .sort_by(|a, b| b.last_read_at.cmp(&a.last_read_at));
    Ok(file.articles.into_iter().map(summary).collect())
}

#[tauri::command]
pub fn reader_get_article(app: AppHandle, id: String) -> Result<Option<Article>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let file = load_articles(&app)?;
    Ok(file.articles.into_iter().find(|a| a.id == id))
}

/// 新建或整体更新一篇文章（进度/译文/设置覆盖都通过它落盘）。
#[tauri::command]
pub fn reader_save_article(app: AppHandle, article: Article) -> Result<ArticleSummary, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let id = article.id.clone();
    let mut file = load_articles(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    match file.articles.iter_mut().find(|a| a.id == id) {
        Some(existing) => *existing = article,
        None => file.articles.push(article),
    }
    let saved = file
        .articles
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or("保存后找不到文章")?;
    write_atomic(
        &articles_path(&app)?,
        &serde_json::to_string(&file).map_err(|e| format!("序列化文章失败: {e}"))?,
    )?;
    Ok(summary(saved))
}

#[tauri::command]
pub fn reader_delete_article(app: AppHandle, id: String) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_articles(&app)?;
    let before = file.articles.len();
    file.articles.retain(|a| a.id != id);
    let removed = file.articles.len() != before;
    if removed {
        write_atomic(
            &articles_path(&app)?,
            &serde_json::to_string(&file).map_err(|e| format!("序列化文章失败: {e}"))?,
        )?;
    }
    Ok(removed)
}

#[tauri::command]
pub fn reader_get_vocab(app: AppHandle) -> Result<VocabFile, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    load_vocab(&app)
}

/// 新增或更新一个生词（SRS 评分走它整体覆盖）。
#[tauri::command]
pub fn reader_save_vocab_word(app: AppHandle, word: VocabWord) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let id = word.id.clone();
    let mut file = load_vocab(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    match file.words.iter_mut().find(|w| w.id == id) {
        Some(existing) => *existing = word,
        None => file.words.push(word),
    }
    write_atomic(
        &vocab_path(&app)?,
        &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
    )?;
    Ok(())
}

#[tauri::command]
pub fn reader_delete_vocab_word(app: AppHandle, id: String) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_vocab(&app)?;
    let before = file.words.len();
    file.words.retain(|w| w.id != id);
    let removed = file.words.len() != before;
    if removed {
        write_atomic(
            &vocab_path(&app)?,
            &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
        )?;
    }
    Ok(removed)
}

/// 记一次复习打卡（day = 前端本地时区 YYYY-MM-DD），返回最新统计。
#[tauri::command]
pub fn reader_record_review(
    app: AppHandle,
    day: String,
    now_ms: i64,
) -> Result<ReviewStats, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_vocab(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    if let Some(entry) = file.review_log.days.iter_mut().find(|d| d.day == day) {
        entry.count += 1;
    } else {
        file.review_log.days.push(ReviewLogDay {
            day: day.clone(),
            count: 1,
        });
    }
    file.review_log.schema_version = READER_SCHEMA_VERSION;
    write_atomic(
        &vocab_path(&app)?,
        &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
    )?;
    Ok(compute_stats(&file, &day, now_ms))
}

/// 返回统计。today = 前端本地时区的 YYYY-MM-DD（打卡判定基准）。
#[tauri::command]
pub fn reader_stats(app: AppHandle, today: String, now_ms: i64) -> Result<ReviewStats, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let file = load_vocab(&app)?;
    Ok(compute_stats(&file, &today, now_ms))
}

/// 到期判定与计数同源：全部由 srs.dueAt <= now 推导。
fn compute_stats(file: &VocabFile, today: &str, now_ms: i64) -> ReviewStats {
    let due_now = file.words.iter().filter(|w| w.srs.due_at <= now_ms).count() as u32;
    let mut learning = 0u32;
    let mut familiar = 0u32;
    let mut mastered = 0u32;
    let mut total_words = 0u32;
    let mut total_chunks = 0u32;
    let mut due_words = 0u32;
    let mut due_chunks = 0u32;
    for w in &file.words {
        if w.srs.interval_days >= 7.0 {
            mastered += 1;
        } else if w.srs.interval_days >= 1.0 {
            familiar += 1;
        } else {
            learning += 1;
        }
        if w.kind.as_ref() == Some(&VocabKind::Chunk) {
            total_chunks += 1;
            if w.srs.due_at <= now_ms {
                due_chunks += 1;
            }
        } else {
            total_words += 1;
            if w.srs.due_at <= now_ms {
                due_words += 1;
            }
        }
    }
    // streak：今天（若今天没打卡则从昨天）起连续有打卡记录的天数。
    let days: std::collections::HashSet<&str> = file
        .review_log
        .days
        .iter()
        .map(|d| d.day.as_str())
        .collect();
    let yesterday = shift_day_key(today, -1);
    let mut streak = 0u32;
    let mut cursor: String = if days.contains(today) {
        today.to_string()
    } else if days.contains(yesterday.as_str()) {
        yesterday
    } else {
        String::new()
    };
    while !cursor.is_empty() && days.contains(cursor.as_str()) {
        streak += 1;
        cursor = shift_day_key(&cursor, -1);
    }
    let reviewed_today = file
        .review_log
        .days
        .iter()
        .find(|d| d.day == today)
        .map(|d| d.count)
        .unwrap_or(0);
    ReviewStats {
        due_now,
        reviewed_today,
        total: file.words.len() as u32,
        streak,
        distribution: MasteryDistribution {
            learning,
            familiar,
            mastered,
        },
        total_words,
        total_chunks,
        due_words,
        due_chunks,
    }
}

/// YYYY-MM-DD 偏移 n 天（n 可负）。纯公历算术，无时区依赖。
fn shift_day_key(day: &str, n: i64) -> String {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return String::new();
    }
    let y = day[0..4].parse::<i64>().unwrap_or(1970);
    let m = day[5..7].parse::<i64>().unwrap_or(1);
    let d = day[8..10].parse::<i64>().unwrap_or(1);
    let (ny, nm, nd) = civil_from_days(days_from_civil(y, m, d) + n);
    format!("{ny:04}-{nm:02}-{nd:02}")
}

/// Howard Hinnant 的 days_from_civil / civil_from_days（公历日历算术，公开算法）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_roundtrip_and_shift() {
        for &(y, m, d) in &[(1970, 1, 1), (2000, 2, 29), (2026, 9, 10), (1999, 12, 31)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d));
        }
        assert_eq!(shift_day_key("2026-09-10", -1), "2026-09-09");
        assert_eq!(shift_day_key("2026-09-01", -1), "2026-08-31");
        assert_eq!(shift_day_key("2025-03-01", -1), "2025-02-28");
        assert_eq!(shift_day_key("2024-03-01", -1), "2024-02-29"); // 闰年
    }

    #[test]
    fn schema_mismatch_is_friendly_error() {
        let err = check_schema(99).unwrap_err();
        assert!(err.contains("版本不兼容"));
        assert!(check_schema(READER_SCHEMA_VERSION).is_ok());
    }

    #[test]
    fn stats_are_derived_from_due_at() {
        let now: i64 = 1_800_000_000_000;
        let file = VocabFile {
            schema_version: READER_SCHEMA_VERSION,
            words: vec![
                vocab("alpha", now - 1_000, 0.0),
                vocab("beta", now + 60_000, 0.0),
                vocab("gamma", now + 3 * 86_400_000, 3.0),
                vocab("delta", now + 8 * 86_400_000, 8.0),
            ],
            review_log: ReviewLogFile {
                schema_version: READER_SCHEMA_VERSION,
                days: vec![
                    ReviewLogDay {
                        day: "2026-09-10".into(),
                        count: 2,
                    },
                    ReviewLogDay {
                        day: "2026-09-09".into(),
                        count: 1,
                    },
                ],
            },
        };
        let stats = compute_stats(&file, "2026-09-10", now);
        assert_eq!(stats.due_now, 1); // 只有 alpha 到期
        assert_eq!(stats.total, 4);
        assert_eq!(stats.reviewed_today, 2);
        assert_eq!(stats.distribution.learning, 2); // alpha, beta
        assert_eq!(stats.distribution.familiar, 1); // gamma (3 天)
        assert_eq!(stats.distribution.mastered, 1); // delta (8 天)
        assert_eq!(stats.streak, 2); // 今天 + 昨天
    }

    #[test]
    fn chunk_fields_roundtrip() {
        // 前端会整体覆盖 Article / VocabWord，新增可选字段必须完整往返。
        let json = r#"{
            "id": "take on momentum",
            "word": "take on momentum",
            "kind": "chunk",
            "phonetic": null,
            "senses": [{ "pos": "搭配", "cn": "获得动力" }],
            "chunkType": "collocation",
            "pattern": "take on sth",
            "trap": "不是 make momentum",
            "source": { "articleId": "a1", "sentenceIdx": 3 },
            "srs": { "ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 1, "lapses": 0 },
            "addedAt": 0
        }"#;
        let word: VocabWord = serde_json::from_str(json).expect("chunk vocab 反序列化");
        assert_eq!(word.kind.as_ref(), Some(&VocabKind::Chunk));
        assert_eq!(word.chunk_type.as_ref(), Some(&ChunkType::Collocation));
        assert_eq!(word.pattern.as_deref(), Some("take on sth"));
        assert_eq!(word.trap.as_deref(), Some("不是 make momentum"));
        let out = serde_json::to_value(&word).unwrap();
        assert_eq!(out["kind"], "chunk");
        assert_eq!(out["chunkType"], "collocation");

        let article_json = r#"{
            "id": "a1", "title": "T", "titleCnState": "done", "sourceType": "paste",
            "wordCount": 10, "createdAt": 0, "lastReadAt": 0,
            "progress": { "sentenceIdx": 0, "percent": 0, "secondsListened": 0 },
            "chunkState": "done",
            "sentences": [{
                "idx": 0, "paragraphIdx": 0, "en": "It took on momentum.", "zh": null,
                "zhState": "pending",
                "chunks": [{ "text": "took on momentum", "chunkType": "collocation",
                             "gloss": "获得动力", "pattern": "take on sth" }]
            }]
        }"#;
        let article: Article = serde_json::from_str(article_json).expect("chunk article 反序列化");
        assert_eq!(article.chunk_state.as_ref(), Some(&ArticleChunkState::Done));
        let chunks = article.sentences[0].chunks.as_deref().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_type, ChunkType::Collocation);
        assert_eq!(chunks[0].trap, None);
        let out = serde_json::to_value(&article).unwrap();
        assert_eq!(out["chunkState"], "done");
        assert_eq!(out["sentences"][0]["chunks"][0]["chunkType"], "collocation");

        // 老数据（无新字段）必须照常加载。
        let legacy: Article = serde_json::from_str(
            r#"{
                "id": "a2", "title": "T", "titleCnState": "done", "sourceType": "paste",
                "wordCount": 1, "createdAt": 0, "lastReadAt": 0,
                "progress": { "sentenceIdx": 0, "percent": 0, "secondsListened": 0 },
                "sentences": [{ "idx": 0, "paragraphIdx": 0, "en": "Hi.", "zh": null, "zhState": "pending" }]
            }"#,
        )
        .expect("老文章无 chunk 字段可加载");
        assert_eq!(legacy.chunk_state, None);
        assert_eq!(legacy.sentences[0].chunks, None);
    }

    fn vocab(id: &str, due_at: i64, interval_days: f64) -> VocabWord {
        VocabWord {
            id: id.into(),
            word: id.into(),
            kind: None,
            phonetic: None,
            senses: vec![],
            forms: None,
            collocations: None,
            chunk_type: None,
            pattern: None,
            trap: None,
            source: VocabSource {
                article_id: "a1".into(),
                sentence_idx: 0,
            },
            srs: VocabSrsState {
                ease: 2.5,
                interval_days,
                reps: 0,
                due_at,
                lapses: 0,
            },
            added_at: 0,
        }
    }
}
