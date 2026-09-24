//! 沉浸阅读室本地存储。
//!
//! - 文章（含句对、进度、按文章的设置覆盖）：app_data_dir/reader_articles.json
//! - 生词（SRS 状态）+ 复习打卡日志 + 每日阅读时长：app_data_dir/reader_vocab.json
//! - 书索引与元信息：app_data_dir/reader_books.json；章正文：app_data_dir/books/<bookId>.json
//!
//! 数据结构与前端 src/core/readerTypes.ts（contracts/reading-room.schema.json，
//! 1.1.0：书级载体为可选字段的增量）同构，camelCase 序列化。
//! 到期判定与计数都从同一份 srs.dueAt 推导。
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
    Docx,
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
    pub tts_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_voice_en: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sentence_pause_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_assess: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_pass_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_auto_mic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowing_silence_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_highlight: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_vocab_marks: Option<bool>,
    /// 复习模式（smart/recognition/cloze/dictation）。前端约定只入全局默认，
    /// 这里透传只为契约对齐，不解释语义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_mode: Option<String>,
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
    /// 所属书 id（书章文章才有；存储据此路由到 books/<bookId>.json）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_id: Option<String>,
    /// 书内章序号，从 0（与 BookMeta.chapters 下标一致）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_idx: Option<u32>,
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

// ---------- 整本书阅读室（书级载体） ----------
//
// 存储布局（存储改造方案 a）：短文照旧落 reader_articles.json；每本书的全部
// 章文章整体落 books/<bookId>.json（BookFile），reader_books.json 只存索引与
// 书元信息（BookMeta，不含章正文）。流式翻译期间 700ms 防抖的整文件重写只落
// 在单本书自己的文件（0.5–1MB 量级），不再随书架膨胀；reader_list_articles
// 永不返回书章。

/// 书目录里的一章（索引信息，不含正文）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookChapterMeta {
    /// 章文章 id（= Article.id，生词 source.articleId 即它）。
    pub id: String,
    pub title: String,
    pub word_count: u32,
    pub sentence_count: u32,
}

/// 书级断点：进书直达。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookProgress {
    pub chapter_id: String,
    pub sentence_idx: u32,
    /// 0–100，章内句序百分比。
    pub percent: f64,
}

/// 选书雷达缓存：导入时按全书文本实算的大纲词命中数（去重）。键 = ExamGoal。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookRadar {
    pub kaoyan: u32,
    pub cet4: u32,
    pub cet6: u32,
}

/// 一本书的索引与元信息（不含章正文）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 缩小后的封面 dataURL（JPEG，≤160px 宽；无封面缺省）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub created_at: i64,
    pub last_read_at: i64,
    /// 章的有序表；下标即 chapterIdx。
    pub chapters: Vec<BookChapterMeta>,
    pub progress: BookProgress,
    /// 全书累计阅读秒数（章 Article.progress.secondsListened 的冗余汇总）。
    pub seconds_listened: f64,
    pub radar: BookRadar,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BooksFile {
    pub schema_version: u32,
    #[serde(default)]
    pub books: Vec<BookMeta>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BookFile {
    pub schema_version: u32,
    #[serde(default)]
    pub articles: Vec<Article>,
}

/// 提醒卡「继续阅读」用的书级断点快照。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastBookProgress {
    pub book_id: String,
    pub book_title: String,
    pub chapter_idx: u32,
    pub chapter_title: String,
    pub chapter_count: u32,
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

/// 单个复习模式下的错题计数（pass=通过 wrong=答错 trap=踩直译陷阱）。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecallModeStat {
    #[serde(default)]
    pub pass: u32,
    #[serde(default)]
    pub wrong: u32,
    #[serde(default)]
    pub trap: u32,
}

/// 一个生词累计的错题记录（复习笔记「为什么记不住」诊断的数据源）。
/// mode 键 = "recognition" | "cloze" | "dictation"。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecallStat {
    #[serde(default)]
    pub total: RecallModeStat,
    #[serde(default)]
    pub by_mode: std::collections::BTreeMap<String, RecallModeStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
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
    /// 累计错题记录（每次复习判分后累加；老数据缺省 = 无记录）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recall: Option<RecallStat>,
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

/// 一天的累计阅读秒数（辅助增强二：每日阅读目标追踪的数据源）。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingLogDay {
    /// 本地日期 YYYY-MM-DD
    pub day: String,
    pub seconds: f64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VocabFile {
    pub schema_version: u32,
    #[serde(default)]
    pub words: Vec<VocabWord>,
    #[serde(default)]
    pub review_log: ReviewLogFile,
    /// 每日阅读时长（serde default：老数据/老应用双向兼容）。
    #[serde(default)]
    pub reading_log: Vec<ReadingLogDay>,
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
    /// 今日累计阅读秒数（每日阅读目标追踪）。
    pub read_seconds_today: f64,
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

fn books_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("reader_books.json"))
}

fn books_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("books");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建书籍目录: {e}"))?;
    Ok(dir)
}

/// 单本书文件路径。book_id 只允许纯文件名（防路径穿越），与 notes 同判法。
fn book_file_path(app: &AppHandle, book_id: &str) -> Result<PathBuf, String> {
    if !is_pure_file_name(book_id) {
        return Err("无效的书籍 id".into());
    }
    Ok(books_dir(app)?.join(format!("{book_id}.json")))
}

/// 串行化读写，避免两个窗口并发保存互相覆盖。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入 {path:?} 失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {path:?} 失败: {e}"))
}

fn load_articles(app: &AppHandle) -> Result<ArticlesFile, String> {
    load_articles_from_path(&articles_path(app)?)
}

/// 只豁免 NotFound：杀软/备份短暂锁文件、双开实例等读错误必须报出来，
/// 否则调用方拿到空库，下一次保存（复习打卡就会触发）会整体覆盖清空数据。
fn load_articles_from_path(path: &std::path::Path) -> Result<ArticlesFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_articles_file()),
        Err(e) => return Err(format!("读取文章数据 {path:?} 失败: {e}")),
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
    load_vocab_from_path(&vocab_path(app)?)
}

/// 只豁免 NotFound（理由同 load_articles_from_path）。与 secret_store 的读法一致。
fn load_vocab_from_path(path: &std::path::Path) -> Result<VocabFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_vocab_file()),
        Err(e) => return Err(format!("读取生词数据 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(empty_vocab_file());
    }
    let file: VocabFile = serde_json::from_str(&text).map_err(|e| format!("生词数据损坏: {e}"))?;
    check_schema(file.schema_version)?;
    Ok(file)
}

fn load_books_from_path(path: &std::path::Path) -> Result<BooksFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_books_file()),
        Err(e) => return Err(format!("读取书籍索引 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(empty_books_file());
    }
    let file: BooksFile = serde_json::from_str(&text).map_err(|e| format!("书籍索引损坏: {e}"))?;
    check_schema(file.schema_version)?;
    Ok(file)
}

fn load_book_file_from_path(path: &std::path::Path) -> Result<BookFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_book_file()),
        Err(e) => return Err(format!("读取书籍 {path:?} 失败: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(empty_book_file());
    }
    let file: BookFile = serde_json::from_str(&text).map_err(|e| format!("书籍数据损坏: {e}"))?;
    check_schema(file.schema_version)?;
    Ok(file)
}

/// 索引 upsert 一本书（按 id 替换/追加）。
fn upsert_book_index(file: &mut BooksFile, meta: BookMeta) {
    file.schema_version = READER_SCHEMA_VERSION;
    match file.books.iter_mut().find(|b| b.id == meta.id) {
        Some(existing) => *existing = meta,
        None => file.books.push(meta),
    }
}

/// 章文章写入单本书文件（按 id 替换/追加，整体原子重写）。
fn save_article_into_book_file(
    path: &std::path::Path,
    article: Article,
) -> Result<ArticleSummary, String> {
    let mut file = load_book_file_from_path(path)?;
    file.schema_version = READER_SCHEMA_VERSION;
    let id = article.id.clone();
    match file.articles.iter_mut().find(|a| a.id == id) {
        Some(existing) => *existing = article,
        None => file.articles.push(article),
    }
    let saved = file
        .articles
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or("保存后找不到章文章")?;
    write_atomic(
        &path.to_path_buf(),
        &serde_json::to_string(&file).map_err(|e| format!("序列化书籍失败: {e}"))?,
    )?;
    Ok(summary(saved))
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
        reading_log: Vec::new(),
    }
}

fn empty_books_file() -> BooksFile {
    BooksFile {
        schema_version: READER_SCHEMA_VERSION,
        books: Vec::new(),
    }
}

fn empty_book_file() -> BookFile {
    BookFile {
        schema_version: READER_SCHEMA_VERSION,
        articles: Vec::new(),
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
    // 书章不属于这里（防御：老版本误写进来的也过滤，书架只列短文）。
    file.articles.retain(|a| a.book_id.is_none());
    file.articles
        .sort_by(|a, b| b.last_read_at.cmp(&a.last_read_at));
    Ok(file.articles.into_iter().map(summary).collect())
}

#[tauri::command]
pub fn reader_get_article(app: AppHandle, id: String) -> Result<Option<Article>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let file = load_articles(&app)?;
    if let Some(a) = file.articles.into_iter().find(|a| a.id == id) {
        return Ok(Some(a));
    }
    // 短文库里没有 → 查书索引定位到书文件再取章。
    let index = load_books_from_path(&books_index_path(&app)?)?;
    let Some(meta) = index
        .books
        .iter()
        .find(|b| b.chapters.iter().any(|c| c.id == id))
    else {
        return Ok(None);
    };
    let book = load_book_file_from_path(&book_file_path(&app, &meta.id)?)?;
    Ok(book.articles.into_iter().find(|a| a.id == id))
}

/// 新建或整体更新一篇文章（进度/译文/设置覆盖都通过它落盘）。
/// 书章（bookId 非空）路由到 books/<bookId>.json，短文照旧走 reader_articles.json。
#[tauri::command]
pub fn reader_save_article(app: AppHandle, article: Article) -> Result<ArticleSummary, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    if let Some(book_id) = article.book_id.clone() {
        return save_article_into_book_file(&book_file_path(&app, &book_id)?, article);
    }
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

// ---------- 书（书级载体）命令 ----------

/// 书架的书（按最近阅读倒序）。只含索引与元信息，不含章正文。
#[tauri::command]
pub fn reader_list_books(app: AppHandle) -> Result<Vec<BookMeta>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_books_from_path(&books_index_path(&app)?)?;
    file.books
        .sort_by(|a, b| b.last_read_at.cmp(&a.last_read_at));
    Ok(file.books)
}

/// 整本入库（导入向导确认时一次性调用）：写书文件 + upsert 索引，返回最新书列表。
#[tauri::command]
pub fn reader_save_book(
    app: AppHandle,
    meta: BookMeta,
    articles: Vec<Article>,
) -> Result<Vec<BookMeta>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    if meta.chapters.is_empty() {
        return Err("书至少要有一章".into());
    }
    if articles.is_empty() {
        return Err("书至少要有一章正文".into());
    }
    // 章文章的归属字段以 BookMeta 为准回填（前端已填，这里兜底）。
    let mut articles = articles;
    for article in articles.iter_mut() {
        article.book_id = Some(meta.id.clone());
    }
    let path = book_file_path(&app, &meta.id)?;
    let mut file = load_book_file_from_path(&path)?;
    file.schema_version = READER_SCHEMA_VERSION;
    file.articles = articles;
    write_atomic(
        &path,
        &serde_json::to_string(&file).map_err(|e| format!("序列化书籍失败: {e}"))?,
    )?;
    let mut index = load_books_from_path(&books_index_path(&app)?)?;
    upsert_book_index(&mut index, meta);
    write_atomic(
        &books_index_path(&app)?,
        &serde_json::to_string(&index).map_err(|e| format!("序列化书籍索引失败: {e}"))?,
    )?;
    let mut books = index.books;
    books.sort_by(|a, b| b.last_read_at.cmp(&a.last_read_at));
    Ok(books)
}

/// 只更新书元信息（进度/时长/最近阅读写回；不碰章正文）。
#[tauri::command]
pub fn reader_save_book_meta(app: AppHandle, meta: BookMeta) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut index = load_books_from_path(&books_index_path(&app)?)?;
    let exists = index.books.iter().any(|b| b.id == meta.id);
    if !exists {
        return Err(format!("书不存在: {}", meta.id));
    }
    upsert_book_index(&mut index, meta);
    write_atomic(
        &books_index_path(&app)?,
        &serde_json::to_string(&index).map_err(|e| format!("序列化书籍索引失败: {e}"))?,
    )?;
    Ok(())
}

/// 删除一本书：删书卡与全部章文章（进度不可恢复），生词一律保留。
#[tauri::command]
pub fn reader_delete_book(app: AppHandle, book_id: String) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut index = load_books_from_path(&books_index_path(&app)?)?;
    let before = index.books.len();
    index.books.retain(|b| b.id != book_id);
    let removed = index.books.len() != before;
    if removed {
        write_atomic(
            &books_index_path(&app)?,
            &serde_json::to_string(&index).map_err(|e| format!("序列化书籍索引失败: {e}"))?,
        )?;
        let path = book_file_path(&app, &book_id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("删除书籍文件失败: {e}"))?;
        }
    }
    Ok(removed)
}

/// 最近在读的书（提醒卡「继续阅读」用）：lastReadAt 最大且有章的书，返回其断点章。
pub fn last_book_progress_from_index(index: &BooksFile) -> Option<LastBookProgress> {
    let mut books: Vec<&BookMeta> = index.books.iter().collect();
    books.sort_by(|a, b| b.last_read_at.cmp(&a.last_read_at));
    let meta = books.into_iter().find(|b| !b.chapters.is_empty())?;
    let chapter_idx = meta
        .chapters
        .iter()
        .position(|c| c.id == meta.progress.chapter_id)
        .unwrap_or(0) as u32;
    let chapter = meta.chapters.get(chapter_idx as usize)?;
    Some(LastBookProgress {
        book_id: meta.id.clone(),
        book_title: meta.title.clone(),
        chapter_idx,
        chapter_title: chapter.title.clone(),
        chapter_count: meta.chapters.len() as u32,
    })
}

#[tauri::command]
pub fn reader_last_book_progress(app: AppHandle) -> Result<Option<LastBookProgress>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let index = load_books_from_path(&books_index_path(&app)?)?;
    Ok(last_book_progress_from_index(&index))
}

// ---------- 每日阅读时长 ----------

/// 累计今日阅读秒数，返回今日累计值（每 ~15s 由阅读页批量上报）。
#[tauri::command]
pub fn reader_record_reading(app: AppHandle, day: String, seconds: f64) -> Result<f64, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_vocab(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    let entry = file
        .reading_log
        .iter_mut()
        .find(|d| d.day == day)
        .map(|d| {
            d.seconds += seconds;
            d.seconds
        })
        .unwrap_or_else(|| {
            file.reading_log.push(ReadingLogDay {
                day: day.clone(),
                seconds,
            });
            seconds
        });
    write_atomic(
        &vocab_path(&app)?,
        &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
    )?;
    Ok(entry)
}

/// 今日累计阅读秒数（提醒卡/TodayCard 展示用）。
#[tauri::command]
pub fn reader_read_seconds_today(app: AppHandle, day: String) -> Result<f64, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let file = load_vocab(&app)?;
    Ok(file
        .reading_log
        .iter()
        .find(|d| d.day == day)
        .map(|d| d.seconds)
        .unwrap_or(0.0))
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

/// 批量合并结果：added = 新追加的词 id；merged = 已存在、仅补例句的词 id。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeVocabResult {
    pub added: Vec<String>,
    pub merged: Vec<String>,
}

/// 批量合并生词（口语复盘用）：一次加锁、逐个判重、一次原子写入。
/// 已有的词保留 SRS/recall 进度，仅在原本没有例句时补充口语例句。
#[tauri::command]
pub fn reader_merge_vocab_words(
    app: AppHandle,
    words: Vec<VocabWord>,
) -> Result<MergeVocabResult, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_vocab(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    let result = merge_vocab_into_file(&mut file, words);
    if !result.added.is_empty() || !result.merged.is_empty() {
        write_atomic(
            &vocab_path(&app)?,
            &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
        )?;
    }
    Ok(result)
}

/// 合并核心（纯函数，便于单测）：新词追加；已有词不动 SRS/recall，
/// 仅在原本没有例句时补入口语例句。
fn merge_vocab_into_file(file: &mut VocabFile, words: Vec<VocabWord>) -> MergeVocabResult {
    let mut result = MergeVocabResult {
        added: Vec::new(),
        merged: Vec::new(),
    };
    for word in words {
        match file.words.iter_mut().find(|w| w.id == word.id) {
            Some(existing) => {
                if existing.example.is_none() {
                    existing.example = word.example;
                }
                result.merged.push(existing.id.clone());
            }
            None => {
                result.added.push(word.id.clone());
                file.words.push(word);
            }
        }
    }
    result
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

/// 记一次复习判分（bucket = "pass" | "wrong" | "trap"，由前端按 mode/judged/grade 归桶）。
/// 返回该词更新后的累计错题记录。
#[tauri::command]
pub fn reader_record_recall(
    app: AppHandle,
    id: String,
    mode: String,
    bucket: String,
    now_ms: i64,
) -> Result<RecallStat, String> {
    let bucket = match bucket.as_str() {
        "pass" | "wrong" | "trap" => bucket,
        other => return Err(format!("未知的错题分桶: {other}")),
    };
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let mut file = load_vocab(&app)?;
    file.schema_version = READER_SCHEMA_VERSION;
    let word = file
        .words
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("生词不存在: {id}"))?;
    let stat = word.recall.get_or_insert_with(RecallStat::default);
    let entry = stat.by_mode.entry(mode).or_default();
    match bucket.as_str() {
        "pass" => {
            stat.total.pass += 1;
            entry.pass += 1;
        }
        "wrong" => {
            stat.total.wrong += 1;
            entry.wrong += 1;
        }
        _ => {
            stat.total.trap += 1;
            entry.trap += 1;
        }
    }
    stat.last_at = Some(now_ms);
    let updated = stat.clone();
    write_atomic(
        &vocab_path(&app)?,
        &serde_json::to_string(&file).map_err(|e| format!("序列化生词失败: {e}"))?,
    )?;
    Ok(updated)
}

/// 今日累计阅读秒数（Rust 内部用：提醒调度判定阅读目标态）。
pub fn read_seconds_today(app: &AppHandle, day: &str) -> f64 {
    let _guard = match STORE_LOCK.lock() {
        Ok(g) => g,
        Err(_) => return 0.0,
    };
    let file = match load_vocab(app) {
        Ok(f) => f,
        Err(_) => return 0.0,
    };
    file.reading_log
        .iter()
        .find(|d| d.day == day)
        .map(|d| d.seconds)
        .unwrap_or(0.0)
}

/// 书架上是否有书（提醒调度：阅读目标态只在有书可回时出现）。
pub fn has_books(app: &AppHandle) -> bool {
    let _guard = match STORE_LOCK.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    load_books_from_path(&match books_index_path(app) {
        Ok(p) => p,
        Err(_) => return false,
    })
    .map(|i| !i.books.is_empty())
    .unwrap_or(false)
}

/// 最近在读的书（内部用，与 reader_last_book_progress 命令同实现）。
pub fn last_book_progress(app: &AppHandle) -> Option<LastBookProgress> {
    let _guard = match STORE_LOCK.lock() {
        Ok(g) => g,
        Err(_) => return None,
    };
    let index = load_books_from_path(&books_index_path(app).ok()?).ok()?;
    last_book_progress_from_index(&index)
}

/// 到期生词数（托盘角标/提醒调度用；与 compute_stats 的 dueNow 同口径）。
pub fn due_count(app: &AppHandle) -> u32 {
    let _guard = match STORE_LOCK.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let file = match load_vocab(app) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    file.words.iter().filter(|w| w.srs.due_at <= now).count() as u32
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
    let read_seconds_today = file
        .reading_log
        .iter()
        .find(|d| d.day == today)
        .map(|d| d.seconds)
        .unwrap_or(0.0);
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
        read_seconds_today,
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
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temporary_path(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "immersive-translator-reader-store-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_store_file_is_an_empty_library() {
        let path = temporary_path("missing.json");
        let _ = std::fs::remove_file(&path);

        let articles = load_articles_from_path(&path).unwrap();
        assert_eq!(articles.schema_version, READER_SCHEMA_VERSION);
        assert!(articles.articles.is_empty());

        let vocab = load_vocab_from_path(&path).unwrap();
        assert_eq!(vocab.schema_version, READER_SCHEMA_VERSION);
        assert!(vocab.words.is_empty());
    }

    #[test]
    fn unreadable_store_file_is_an_error_not_an_empty_library() {
        // 目录路径：read_to_string 必然失败（权限/共享冲突等的替身）。
        // 这里锁死「读错误 ≠ 空库」，否则任何保存都会静默清空全部数据。
        let path = temporary_path("directory");
        std::fs::create_dir(&path).unwrap();

        let err = load_articles_from_path(&path).unwrap_err();
        assert!(err.starts_with("读取文章数据"), "{err}");
        let err = load_vocab_from_path(&path).unwrap_err();
        assert!(err.starts_with("读取生词数据"), "{err}");

        let _ = std::fs::remove_dir(&path);
    }

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

    /// 口语复盘批量合并的核心约定：新词追加；已有词的 SRS 进度原样保留，
    /// 只在原本没有例句时补入口语例句。
    fn vocab_word_fixture(id: &str, due_at: i64, example: Option<VocabExample>) -> VocabWord {
        VocabWord {
            id: id.to_string(),
            word: id.to_string(),
            kind: None,
            phonetic: None,
            senses: Vec::new(),
            forms: None,
            collocations: None,
            chunk_type: None,
            pattern: None,
            trap: None,
            source: VocabSource {
                article_id: String::new(),
                sentence_idx: 0,
            },
            srs: VocabSrsState {
                ease: 2.5,
                interval_days: 0.0,
                reps: 0,
                due_at,
                lapses: 0,
            },
            added_at: 1000,
            example,
            recall: None,
        }
    }

    #[test]
    fn merge_vocab_appends_new_and_preserves_existing_srs() {
        let mut file = empty_vocab_file();
        // 已有词：有复习进度、没有例句
        let mut existing = vocab_word_fixture("old", 111, None);
        existing.srs.reps = 4;
        existing.srs.interval_days = 10.0;
        file.words.push(existing);

        let spoken_example = VocabExample {
            en: "I'd like to make a reservation.".to_string(),
            zh: Some("我想预订。".to_string()),
        };
        let result = merge_vocab_into_file(
            &mut file,
            vec![
                // 已有词的新版本：SRS 不同、带口语例句 → 保留旧 SRS，例句补入
                vocab_word_fixture("old", 999, Some(spoken_example.clone())),
                // 新词 → 追加
                vocab_word_fixture("new", 42, None),
            ],
        );

        assert_eq!(result.added, vec!["new".to_string()]);
        assert_eq!(result.merged, vec!["old".to_string()]);
        assert_eq!(file.words.len(), 2);

        let old = file.words.iter().find(|w| w.id == "old").unwrap();
        assert_eq!(old.srs.due_at, 111);
        assert_eq!(old.srs.reps, 4);
        assert_eq!(old.srs.interval_days, 10.0);
        assert_eq!(old.example.as_ref().unwrap().en, spoken_example.en);

        let new = file.words.iter().find(|w| w.id == "new").unwrap();
        assert_eq!(new.srs.due_at, 42);
        assert!(new.example.is_none());
    }

    #[test]
    fn merge_vocab_keeps_existing_example_and_noop_writes_nothing() {
        let mut file = empty_vocab_file();
        let kept = VocabExample {
            en: "kept".to_string(),
            zh: None,
        };
        let mut existing = vocab_word_fixture("old", 111, Some(kept));
        existing.recall = Some(RecallStat::default());
        file.words.push(existing);

        let result = merge_vocab_into_file(
            &mut file,
            vec![vocab_word_fixture(
                "old",
                111,
                Some(VocabExample {
                    en: "spoken".to_string(),
                    zh: None,
                }),
            )],
        );

        assert!(result.added.is_empty());
        let old = file.words.iter().find(|w| w.id == "old").unwrap();
        assert_eq!(old.example.as_ref().unwrap().en, "kept"); // 已有例句不被覆盖
        assert!(old.recall.is_some());
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
            reading_log: vec![
                ReadingLogDay {
                    day: "2026-09-10".into(),
                    seconds: 600.0,
                },
                ReadingLogDay {
                    day: "2026-09-08".into(),
                    seconds: 120.0,
                },
            ],
        };
        let stats = compute_stats(&file, "2026-09-10", now);
        assert_eq!(stats.due_now, 1); // 只有 alpha 到期
        assert_eq!(stats.total, 4);
        assert_eq!(stats.reviewed_today, 2);
        assert_eq!(stats.read_seconds_today, 600.0); // 今日已读 10 分钟
        assert_eq!(stats.distribution.learning, 2); // alpha, beta
        assert_eq!(stats.distribution.familiar, 1); // gamma (3 天)
        assert_eq!(stats.distribution.mastered, 1); // delta (8 天)
        assert_eq!(stats.streak, 2); // 今天 + 昨天
    }

    #[test]
    fn book_index_upsert_and_last_progress() {
        let chapter = |id: &str| BookChapterMeta {
            id: id.into(),
            title: format!("Chapter {id}"),
            word_count: 100,
            sentence_count: 10,
        };
        let mut index = empty_books_file();
        let meta = BookMeta {
            id: "b1".into(),
            title: "The Call of the Wild".into(),
            author: Some("Jack London".into()),
            cover: None,
            created_at: 1,
            last_read_at: 100,
            chapters: vec![chapter("c1"), chapter("c2")],
            progress: BookProgress {
                chapter_id: "c2".into(),
                sentence_idx: 3,
                percent: 30.0,
            },
            seconds_listened: 60.0,
            radar: BookRadar {
                kaoyan: 12,
                cet4: 20,
                cet6: 25,
            },
        };
        upsert_book_index(&mut index, meta.clone());
        upsert_book_index(&mut index, meta); // 同 id 再次入库 = 替换不重复
        assert_eq!(index.books.len(), 1);

        let last = last_book_progress_from_index(&index).unwrap();
        assert_eq!(last.book_id, "b1");
        assert_eq!(last.chapter_idx, 1); // 断点在第二章
        assert_eq!(last.chapter_count, 2);
    }

    #[test]
    fn book_file_roundtrip_and_legacy_articles_without_book_fields() {
        // 章文章（带 bookId/chapterIdx）完整往返。
        let json = r#"{
            "id": "c1", "title": "Into the Primitive", "titleCnState": "pending",
            "sourceType": "epub", "wordCount": 100, "createdAt": 0, "lastReadAt": 0,
            "bookId": "b1", "chapterIdx": 0,
            "progress": { "sentenceIdx": 0, "percent": 0, "secondsListened": 0 },
            "sentences": [{ "idx": 0, "paragraphIdx": 0, "en": "Hi.", "zh": null, "zhState": "pending" }]
        }"#;
        let article: Article = serde_json::from_str(json).expect("书章反序列化");
        assert_eq!(article.book_id.as_deref(), Some("b1"));
        assert_eq!(article.chapter_idx, Some(0));
        let out = serde_json::to_value(&article).unwrap();
        assert_eq!(out["bookId"], "b1");
        assert_eq!(out["chapterIdx"], 0);

        // 短文序列化不携带空字段。
        let legacy: Article = serde_json::from_str(
            r#"{
                "id": "a2", "title": "T", "titleCnState": "done", "sourceType": "paste",
                "wordCount": 1, "createdAt": 0, "lastReadAt": 0,
                "progress": { "sentenceIdx": 0, "percent": 0, "secondsListened": 0 },
                "sentences": []
            }"#,
        )
        .expect("老文章可加载");
        let out = serde_json::to_value(&legacy).unwrap();
        assert!(out.get("bookId").is_none());
        assert!(out.get("chapterIdx").is_none());
    }

    #[test]
    fn save_article_into_book_file_replaces_and_persists() {
        let path = temporary_path("book-b1.json");
        let _ = std::fs::remove_file(&path);
        let chapter = |idx: u32| Article {
            id: format!("c{idx}"),
            title: format!("Chapter {idx}"),
            title_cn: None,
            title_cn_state: SentenceZhState::Pending,
            source_url: None,
            source_type: ArticleSourceType::Epub,
            level: None,
            word_count: 10,
            created_at: 1,
            last_read_at: 1,
            progress: ArticleProgress {
                sentence_idx: 0,
                percent: 0.0,
                seconds_listened: 0.0,
            },
            sentences: vec![],
            chunk_state: None,
            settings: None,
            book_id: Some("b1".into()),
            chapter_idx: Some(idx),
        };
        let saved = save_article_into_book_file(&path, chapter(0)).unwrap();
        assert_eq!(saved.sentence_count, 0);
        save_article_into_book_file(&path, chapter(1)).unwrap();
        // 同 id 重存 = 替换。
        save_article_into_book_file(&path, chapter(0)).unwrap();
        let file = load_book_file_from_path(&path).unwrap();
        assert_eq!(file.articles.len(), 2);
        assert_eq!(file.articles[0].id, "c0");
        let _ = std::fs::remove_file(&path);
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
            example: None,
            recall: None,
        }
    }
}

// ---------- 复习笔记（notes/） ----------

/// 一篇复习笔记的元数据。存在 .md 文件头部的 JSON frontmatter 里，
/// 与正文一起自包含导出；replay 是 AI 复盘结果（结构由前端定义，此处透传）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteFileMeta {
    /// 文件名即 id（学词笔记-YYYY-MM-DD.md）。保存时前端可不传（note_save
    /// 会做防覆盖去重后回填），故反序列化允许缺省。
    #[serde(default)]
    pub file: String,
    pub created_at: i64,
    pub words: u32,
    /// 生成被取消时为 true（只保存了已完成部分）。
    #[serde(default)]
    pub partial: bool,
    #[serde(default)]
    pub word_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<serde_json::Value>,
    /// 最近一次写回（生成时 = created_at；复盘写回时刷新）。
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub meta: NoteFileMeta,
    /// 正文（不含 frontmatter）。
    pub content: String,
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("notes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建笔记目录: {e}"))?;
    Ok(dir)
}

/// frontmatter = 首行 `---` 到下一个 `---` 行之间的单行 JSON。
fn note_with_frontmatter(meta: &NoteFileMeta, body: &str) -> String {
    let json = serde_json::to_string(meta).unwrap_or_else(|_| "{}".into());
    format!("---\n{json}\n---\n{body}")
}

/// 拆 frontmatter；无 frontmatter（外部拷入的 md）返回 None meta 与原文。
fn split_note_frontmatter(raw: &str) -> (Option<NoteFileMeta>, String) {
    let rest = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"));
    let Some(rest) = rest else {
        return (None, raw.to_string());
    };
    // 结束定界符：行首 "---"（兼容 \r\n）。正文从定界符之后取。
    let end = match rest.find("\n---\n").or_else(|| rest.find("\n---\r\n")) {
        Some(end) => end,
        None => return (None, raw.to_string()),
    };
    let meta: Option<NoteFileMeta> = serde_json::from_str(rest[..end].trim()).ok();
    let after = &rest[end..];
    let body = after
        .strip_prefix("\n---\n")
        .or_else(|| after.strip_prefix("\n---\r\n"))
        .unwrap_or(after);
    (meta, body.to_string())
}

/// 同名不覆盖：base.md 存在则依次尝试 base-2.md、base-3.md……
fn dedup_note_path(dir: &std::path::Path, base: &str) -> PathBuf {
    let candidate = |n: usize| {
        if n == 1 {
            dir.join(format!("{base}.md"))
        } else {
            dir.join(format!("{base}-{n}.md"))
        }
    };
    let mut n = 1;
    while candidate(n).exists() {
        n += 1;
    }
    candidate(n)
}

/// 笔记基名（不含 .md）只允许纯文件名：拒绝 ../、子目录、盘符、"." 等路径成分。
fn is_pure_file_name(base: &str) -> bool {
    !base.is_empty()
        && std::path::Path::new(base)
            .file_name()
            .and_then(|n| n.to_str())
            == Some(base)
}

/// 保存一篇新笔记（永不覆盖已有文件），返回带最终文件名的元数据。
#[tauri::command]
pub fn note_save(
    app: AppHandle,
    base_name: String,
    content: String,
    meta: NoteFileMeta,
) -> Result<NoteFileMeta, String> {
    let base = base_name.trim().trim_end_matches(".md");
    // 防路径穿越：与 note_read/note_delete 的读删入口同一判法，否则越界写出的
    // 笔记不会出现在 note_list 里，从界面上“消失”。
    if !is_pure_file_name(base) {
        return Err("无效的笔记文件名".into());
    }
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let dir = notes_dir(&app)?;
    let path = dedup_note_path(&dir, base);
    let file = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效的笔记文件名")?
        .to_string();
    let mut meta = meta;
    meta.file = file;
    meta.updated_at = if meta.updated_at > 0 {
        meta.updated_at
    } else {
        meta.created_at
    };
    std::fs::write(&path, note_with_frontmatter(&meta, &content))
        .map_err(|e| format!("写入笔记失败: {e}"))?;
    Ok(meta)
}

/// 列出全部笔记（按创建时间倒序；损坏的 frontmatter 跳过）。
#[tauri::command]
pub fn note_list(app: AppHandle) -> Result<Vec<NoteFileMeta>, String> {
    let dir = notes_dir(&app)?;
    let mut metas = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取笔记目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let (meta, _) = split_note_frontmatter(&text);
        if let Some(mut meta) = meta {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                meta.file = name.to_string();
            }
            metas.push(meta);
        }
    }
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(metas)
}

/// 读取一篇笔记；file 不存在返回 None。
#[tauri::command]
pub fn note_read(app: AppHandle, file: String) -> Result<Option<NoteContent>, String> {
    let dir = notes_dir(&app)?;
    let path = dir.join(&file);
    // 只允许纯文件名，防路径穿越。
    if path.file_name().and_then(|n| n.to_str()) != Some(file.as_str()) {
        return Err("无效的笔记文件名".into());
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let (meta, body) = split_note_frontmatter(&text);
    let Some(mut meta) = meta else {
        return Ok(None);
    };
    meta.file = file;
    Ok(Some(NoteContent {
        meta,
        content: body,
    }))
}

/// 写回 AI 复盘结果（只改 meta.replay / updated_at，正文不动）。
#[tauri::command]
pub fn note_write_replay(
    app: AppHandle,
    file: String,
    replay: serde_json::Value,
    rounds: u32,
    now_ms: i64,
) -> Result<NoteFileMeta, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let dir = notes_dir(&app)?;
    let path = dir.join(&file);
    if path.file_name().and_then(|n| n.to_str()) != Some(file.as_str()) {
        return Err("无效的笔记文件名".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取笔记失败: {e}"))?;
    let (meta, body) = split_note_frontmatter(&text);
    let mut meta = meta.ok_or("笔记缺少元数据")?;
    meta.replay = Some(replay);
    meta.updated_at = now_ms;
    meta.replay.as_mut().and_then(|r| {
        r.as_object_mut()
            .map(|o| o.insert("rounds".into(), serde_json::Value::from(rounds)))
    });
    std::fs::write(&path, note_with_frontmatter(&meta, &body))
        .map_err(|e| format!("写入笔记失败: {e}"))?;
    Ok(meta)
}

/// 删除一篇笔记。
#[tauri::command]
pub fn note_delete(app: AppHandle, file: String) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "存储锁不可用".to_string())?;
    let dir = notes_dir(&app)?;
    let path = dir.join(&file);
    if path.file_name().and_then(|n| n.to_str()) != Some(file.as_str()) {
        return Err("无效的笔记文件名".into());
    }
    Ok(std::fs::remove_file(&path).is_ok())
}

#[cfg(test)]
mod note_tests {
    use super::*;

    #[test]
    fn note_frontmatter_roundtrip() {
        let meta = NoteFileMeta {
            file: "学词笔记-2026-09-16.md".into(),
            created_at: 1_700_000_000_000,
            words: 6,
            partial: false,
            word_ids: vec!["inconsistencies".into(), "sourcing from".into()],
            replay: Some(serde_json::json!({ "verdict": "过了大半", "stillWeak": 2 })),
            updated_at: 1_700_000_100_000,
        };
        let raw = note_with_frontmatter(&meta, "# 复习笔记\n\n正文");
        let (parsed, body) = split_note_frontmatter(&raw);
        assert_eq!(parsed.as_ref(), Some(&meta));
        assert_eq!(body, "# 复习笔记\n\n正文");
    }

    #[test]
    fn note_without_frontmatter_parses_to_none() {
        let (meta, body) = split_note_frontmatter("# 复习笔记\n普通导出的 md");
        assert!(meta.is_none());
        assert_eq!(body, "# 复习笔记\n普通导出的 md");
    }

    #[test]
    fn note_base_name_rejects_path_components() {
        // 正常基名（含中文/日期/空格）可用。
        assert!(is_pure_file_name("学词笔记-2026-09-16"));
        assert!(is_pure_file_name("my note (2)"));
        // 路径穿越 / 子目录 / 盘符 / 特殊目录项全部拒绝。
        assert!(!is_pure_file_name("../secrets"));
        assert!(!is_pure_file_name("..\\..\\secrets"));
        assert!(!is_pure_file_name("notes/sub"));
        assert!(!is_pure_file_name(r"C:\Users\x"));
        assert!(!is_pure_file_name(".."));
        assert!(!is_pure_file_name("."));
        assert!(!is_pure_file_name(""));
        assert!(!is_pure_file_name("trailing/"));
    }

    #[test]
    fn note_frontmatter_tolerates_crlf() {
        let meta = NoteFileMeta {
            file: "a.md".into(),
            created_at: 1,
            words: 1,
            partial: true,
            word_ids: vec![],
            replay: None,
            updated_at: 1,
        };
        let raw = format!(
            "---\r\n{}\r\n---\r\n正文",
            serde_json::to_string(&meta).unwrap()
        );
        let (parsed, body) = split_note_frontmatter(&raw);
        assert_eq!(parsed.as_ref(), Some(&meta));
        assert_eq!(body, "正文");
    }
}
