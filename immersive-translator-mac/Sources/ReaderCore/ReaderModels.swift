import Foundation

/// 沉浸阅读室数据契约（contracts/reading-room.schema.json，schemaVersion 1）。
///
/// Article / SentencePair / VocabWord / ReaderSettings 同时是 Windows 侧
/// reader_store.rs 的存储格式（camelCase 序列化）。改动任何字段必须同步
/// schema、readerTypes.ts 与 reader_store.rs。可选字段编码时跳过（对齐
/// serde skip_serializing_if），不给盘上文件引入 null 噪声。
///
/// 整本书（BookMeta / BookChapterMeta / BookProgress / BookRadar / BooksFile /
/// BookFile）与 Article.bookId/chapterIdx 对齐 schema 1.1.0 的书级可选增量。

public let readerSchemaVersion = 1

// MARK: - 枚举

/// 一篇文章的来源。epub 预留。
public enum ArticleSourceType: String, Codable, Equatable {
    case paste
    case url
    case epub
    case pdf
    case docx
}

/// 单句译文的翻译状态。
public enum SentenceZhState: String, Codable, Equatable {
    case pending
    case done
    case failed
    case edited
}

/// 词块类型：搭配 / 短语动词 / 习语 / 句式框架。
public enum ChunkType: String, Codable, Equatable, CaseIterable {
    case collocation
    case phrasal
    case idiom
    case pattern

    public var label: String {
        switch self {
        case .collocation: return "搭配"
        case .phrasal: return "短语动词"
        case .idiom: return "习语"
        case .pattern: return "句式"
        }
    }

    /// 宽容解析 LLM 返回的词块类型字符串；非法值返回 nil。
    public static func parse(_ value: Any?) -> ChunkType? {
        guard let raw = value as? String else { return nil }
        return ChunkType(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

/// 一篇文章的词块标注状态。
public enum ArticleChunkState: String, Codable, Equatable {
    case pending
    case done
    case failed
}

/// 生词条目类别：单词 / 词块。缺省视为 word（老数据无需迁移）。
public enum VocabKind: String, Codable, Equatable {
    case word
    case chunk
}

// MARK: - 句对

/// 句内标注的一个词块。text 必须是所在句 en 的连续子串（解析时强校验）。
public struct SentenceChunk: Codable, Equatable {
    public var text: String
    public var chunkType: ChunkType
    /// 中文释义（一句话）。
    public var gloss: String
    /// 槽位记法，如 "take on sth"。
    public var pattern: String?
    /// 直译陷阱，如 "不是 make momentum"。
    public var trap: String?

    public init(text: String, chunkType: ChunkType, gloss: String, pattern: String? = nil, trap: String? = nil) {
        self.text = text
        self.chunkType = chunkType
        self.gloss = gloss
        self.pattern = pattern
        self.trap = trap
    }

    enum CodingKeys: String, CodingKey {
        case text
        case chunkType
        case gloss
        case pattern
        case trap
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        chunkType = try c.decode(ChunkType.self, forKey: .chunkType)
        gloss = try c.decode(String.self, forKey: .gloss)
        pattern = try c.decodeIfPresent(String.self, forKey: .pattern)
        trap = try c.decodeIfPresent(String.self, forKey: .trap)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encode(chunkType, forKey: .chunkType)
        try c.encode(gloss, forKey: .gloss)
        try c.encodeIfPresent(pattern, forKey: .pattern)
        try c.encodeIfPresent(trap, forKey: .trap)
    }
}

/// 一个句对（最小朗读/高亮/遮罩单元）。
public struct SentencePair: Codable, Equatable {
    /// 全文序号，从 0。
    public var idx: Int
    public var paragraphIdx: Int
    public var en: String
    /// nil = 尚未翻译。
    public var zh: String?
    public var zhState: SentenceZhState
    /// 遮罩模式下是否已揭开（运行时状态，随文章持久化）。
    public var revealed: Bool?
    /// LLM 标注的词块（en 定稿后写入）。
    public var chunks: [SentenceChunk]?

    public init(
        idx: Int,
        paragraphIdx: Int,
        en: String,
        zh: String? = nil,
        zhState: SentenceZhState = .pending,
        revealed: Bool? = nil,
        chunks: [SentenceChunk]? = nil
    ) {
        self.idx = idx
        self.paragraphIdx = paragraphIdx
        self.en = en
        self.zh = zh
        self.zhState = zhState
        self.revealed = revealed
        self.chunks = chunks
    }

    enum CodingKeys: String, CodingKey {
        case idx
        case paragraphIdx
        case en
        case zh
        case zhState
        case revealed
        case chunks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        idx = try c.decode(Int.self, forKey: .idx)
        paragraphIdx = try c.decodeIfPresent(Int.self, forKey: .paragraphIdx) ?? 0
        en = try c.decode(String.self, forKey: .en)
        zh = try c.decodeIfPresent(String.self, forKey: .zh)
        zhState = try c.decodeIfPresent(SentenceZhState.self, forKey: .zhState) ?? .pending
        revealed = try c.decodeIfPresent(Bool.self, forKey: .revealed)
        chunks = try c.decodeIfPresent([SentenceChunk].self, forKey: .chunks)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(idx, forKey: .idx)
        try c.encode(paragraphIdx, forKey: .paragraphIdx)
        try c.encode(en, forKey: .en)
        // zh 允许 null（schema 声明 string|null）。
        try c.encode(zh, forKey: .zh)
        try c.encode(zhState, forKey: .zhState)
        try c.encodeIfPresent(revealed, forKey: .revealed)
        try c.encodeIfPresent(chunks, forKey: .chunks)
    }
}

// MARK: - 文章

/// 阅读进度（持久化在文章记录里）。
public struct ArticleProgress: Codable, Equatable {
    /// 上次朗读/阅读到达的句序号。
    public var sentenceIdx: Int
    /// 0–100。
    public var percent: Double
    public var secondsListened: Double

    public init(sentenceIdx: Int = 0, percent: Double = 0, secondsListened: Double = 0) {
        self.sentenceIdx = sentenceIdx
        self.percent = percent
        self.secondsListened = secondsListened
    }
}

/// 一篇文章。
public struct Article: Codable, Equatable, Identifiable {
    public var id: String
    /// 英文标题。
    public var title: String
    /// 中文副标题。
    public var titleCn: String?
    public var titleCnState: SentenceZhState
    public var sourceUrl: String?
    public var sourceType: ArticleSourceType
    /// 如 "B1 入门"，透传展示。
    public var level: String?
    public var wordCount: Int
    /// Unix 毫秒。
    public var createdAt: Int64
    /// Unix 毫秒。
    public var lastReadAt: Int64
    public var progress: ArticleProgress
    public var sentences: [SentencePair]
    /// 词块标注进度；nil = 从未标注。
    public var chunkState: ArticleChunkState?
    /// 按文章覆盖的阅读设置；缺字段回落全局默认。
    public var settings: ReaderSettingsOverride?
    /// 所属书 id（书章文章才有；存储据此路由到 books/<bookId>.json）。
    public var bookId: String?
    /// 书内章序号，从 0（与 BookMeta.chapters 下标一致）。
    public var chapterIdx: Int?

    public init(
        id: String,
        title: String,
        titleCn: String? = nil,
        titleCnState: SentenceZhState = .pending,
        sourceUrl: String? = nil,
        sourceType: ArticleSourceType = .paste,
        level: String? = nil,
        wordCount: Int = 0,
        createdAt: Int64,
        lastReadAt: Int64,
        progress: ArticleProgress = ArticleProgress(),
        sentences: [SentencePair] = [],
        chunkState: ArticleChunkState? = nil,
        settings: ReaderSettingsOverride? = nil,
        bookId: String? = nil,
        chapterIdx: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.titleCn = titleCn
        self.titleCnState = titleCnState
        self.sourceUrl = sourceUrl
        self.sourceType = sourceType
        self.level = level
        self.wordCount = wordCount
        self.createdAt = createdAt
        self.lastReadAt = lastReadAt
        self.progress = progress
        self.sentences = sentences
        self.chunkState = chunkState
        self.settings = settings
        self.bookId = bookId
        self.chapterIdx = chapterIdx
    }

    enum CodingKeys: String, CodingKey {
        case id, title, titleCn, titleCnState, sourceUrl, sourceType, level
        case wordCount, createdAt, lastReadAt, progress, sentences, chunkState, settings
        case bookId, chapterIdx
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        titleCn = try c.decodeIfPresent(String.self, forKey: .titleCn)
        titleCnState = try c.decodeIfPresent(SentenceZhState.self, forKey: .titleCnState) ?? .pending
        sourceUrl = try c.decodeIfPresent(String.self, forKey: .sourceUrl)
        sourceType = try c.decodeIfPresent(ArticleSourceType.self, forKey: .sourceType) ?? .paste
        level = try c.decodeIfPresent(String.self, forKey: .level)
        wordCount = try c.decodeIfPresent(Int.self, forKey: .wordCount) ?? 0
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastReadAt = try c.decodeIfPresent(Int64.self, forKey: .lastReadAt) ?? 0
        progress = try c.decodeIfPresent(ArticleProgress.self, forKey: .progress) ?? ArticleProgress()
        sentences = try c.decodeIfPresent([SentencePair].self, forKey: .sentences) ?? []
        chunkState = try c.decodeIfPresent(ArticleChunkState.self, forKey: .chunkState)
        settings = try c.decodeIfPresent(ReaderSettingsOverride.self, forKey: .settings)
        bookId = try c.decodeIfPresent(String.self, forKey: .bookId)
        chapterIdx = try c.decodeIfPresent(Int.self, forKey: .chapterIdx)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(titleCn, forKey: .titleCn)
        try c.encode(titleCnState, forKey: .titleCnState)
        try c.encodeIfPresent(sourceUrl, forKey: .sourceUrl)
        try c.encode(sourceType, forKey: .sourceType)
        try c.encodeIfPresent(level, forKey: .level)
        try c.encode(wordCount, forKey: .wordCount)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(lastReadAt, forKey: .lastReadAt)
        try c.encode(progress, forKey: .progress)
        try c.encode(sentences, forKey: .sentences)
        try c.encodeIfPresent(chunkState, forKey: .chunkState)
        try c.encodeIfPresent(settings, forKey: .settings)
        try c.encodeIfPresent(bookId, forKey: .bookId)
        try c.encodeIfPresent(chapterIdx, forKey: .chapterIdx)
    }
}

/// 书架条目：文章去掉句对正文，加句数。
public struct ArticleSummary: Codable, Equatable, Identifiable {
    public var id: String { article.id }
    public var article: Article
    public var sentenceCount: Int

    public init(article: Article, sentenceCount: Int? = nil) {
        self.article = article
        self.sentenceCount = sentenceCount ?? article.sentences.count
    }
}

// MARK: - 整本书（书级载体）
//
// 存储布局对齐 Windows reader_store.rs「存储改造方案 a」：短文照旧落
// reader_articles.json；每本书的全部章文章整体落 books/<bookId>.json（BookFile），
// reader_books.json 只存索引与书元信息（BookMeta，不含章正文）。流式翻译期间
// 700ms 防抖的整文件重写只落在单本书自己的文件（0.5–1MB 量级）。

/// 书目录里的一章（索引信息，不含正文）。
public struct BookChapterMeta: Codable, Equatable {
    /// 章文章 id（= Article.id，生词 source.articleId 即它）。
    public var id: String
    public var title: String
    public var wordCount: Int
    public var sentenceCount: Int

    public init(id: String, title: String, wordCount: Int, sentenceCount: Int) {
        self.id = id
        self.title = title
        self.wordCount = wordCount
        self.sentenceCount = sentenceCount
    }
}

/// 书级断点：进书直达。
public struct BookProgress: Codable, Equatable {
    public var chapterId: String
    /// 章内句序号，从 0。
    public var sentenceIdx: Int
    /// 0–100，章内句序百分比。
    public var percent: Double

    public init(chapterId: String, sentenceIdx: Int = 0, percent: Double = 0) {
        self.chapterId = chapterId
        self.sentenceIdx = sentenceIdx
        self.percent = percent
    }
}

/// 选书雷达缓存：导入时按全书文本实算的大纲词命中数（去重）。键 = ExamGoal。
/// schema 明文禁止写死——必须是导入时对所选章文本实算的结果。
public struct BookRadar: Codable, Equatable {
    public var kaoyan: Int
    public var cet4: Int
    public var cet6: Int

    public init(kaoyan: Int, cet4: Int, cet6: Int) {
        self.kaoyan = kaoyan
        self.cet4 = cet4
        self.cet6 = cet6
    }
}

/// 一本书的索引与元信息（不含章正文）。
public struct BookMeta: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var author: String?
    /// 缩小后的封面 dataURL（JPEG，≤160px 宽；无封面缺省）。
    public var cover: String?
    /// Unix 毫秒。
    public var createdAt: Int64
    /// Unix 毫秒。
    public var lastReadAt: Int64
    /// 章的有序表；下标即 chapterIdx。
    public var chapters: [BookChapterMeta]
    /// 书级断点（书卡/进书直达的数据源）。
    public var progress: BookProgress
    /// 全书累计阅读秒数（章 Article.progress.secondsListened 的冗余汇总）。
    public var secondsListened: Double
    public var radar: BookRadar

    public init(
        id: String,
        title: String,
        author: String? = nil,
        cover: String? = nil,
        createdAt: Int64,
        lastReadAt: Int64,
        chapters: [BookChapterMeta],
        progress: BookProgress,
        secondsListened: Double = 0,
        radar: BookRadar
    ) {
        self.id = id
        self.title = title
        self.author = author
        self.cover = cover
        self.createdAt = createdAt
        self.lastReadAt = lastReadAt
        self.chapters = chapters
        self.progress = progress
        self.secondsListened = secondsListened
        self.radar = radar
    }

    enum CodingKeys: String, CodingKey {
        case id, title, author, cover, createdAt, lastReadAt, chapters
        case progress, secondsListened, radar
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        cover = try c.decodeIfPresent(String.self, forKey: .cover)
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastReadAt = try c.decodeIfPresent(Int64.self, forKey: .lastReadAt) ?? 0
        chapters = try c.decodeIfPresent([BookChapterMeta].self, forKey: .chapters) ?? []
        progress = try c.decodeIfPresent(BookProgress.self, forKey: .progress)
            ?? BookProgress(chapterId: chapters.first?.id ?? "")
        secondsListened = try c.decodeIfPresent(Double.self, forKey: .secondsListened) ?? 0
        radar = try c.decodeIfPresent(BookRadar.self, forKey: .radar) ?? BookRadar(kaoyan: 0, cet4: 0, cet6: 0)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(author, forKey: .author)
        try c.encodeIfPresent(cover, forKey: .cover)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(lastReadAt, forKey: .lastReadAt)
        try c.encode(chapters, forKey: .chapters)
        try c.encode(progress, forKey: .progress)
        try c.encode(secondsListened, forKey: .secondsListened)
        try c.encode(radar, forKey: .radar)
    }
}

/// reader_books.json 顶层结构（书索引）。
public struct BooksFile: Codable, Equatable {
    public var schemaVersion: Int
    public var books: [BookMeta]

    public init(schemaVersion: Int = readerSchemaVersion, books: [BookMeta] = []) {
        self.schemaVersion = schemaVersion
        self.books = books
    }

    public static let empty = BooksFile()
}

/// books/<bookId>.json 顶层结构（整本书一个文件）。
public struct BookFile: Codable, Equatable {
    public var schemaVersion: Int
    public var articles: [Article]

    public init(schemaVersion: Int = readerSchemaVersion, articles: [Article] = []) {
        self.schemaVersion = schemaVersion
        self.articles = articles
    }

    public static let empty = BookFile()

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case articles
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? readerSchemaVersion
        articles = try c.decodeIfPresent([Article].self, forKey: .articles) ?? []
    }
}

/// 书卡/进书用的派生量（对齐 Windows readerTypes.ts bookChapterIndexOf / bookOverallPercent）。
public func bookChapterIndexOf(book: BookMeta, chapterId: String?) -> Int {
    guard let chapterId, !chapterId.isEmpty,
          let idx = book.chapters.firstIndex(where: { $0.id == chapterId }) else { return 0 }
    return idx
}

/// 全书进度百分比：断点章内进度 + 之前的章数，除以总章数。
public func bookOverallPercent(book: BookMeta) -> Double {
    let total = book.chapters.count
    guard total > 0 else { return 0 }
    let idx = bookChapterIndexOf(book: book, chapterId: book.progress.chapterId)
    let clamped = min(100.0, max(0.0, book.progress.percent))
    let pct = ((Double(idx) + clamped / 100.0) / Double(total)) * 100
    return min(100, max(0, pct))
}

// MARK: - 生词（SRS）

/// 遮罩/复习等场景的生词来源定位。
public struct VocabSource: Codable, Equatable {
    public var articleId: String
    public var sentenceIdx: Int

    public init(articleId: String, sentenceIdx: Int) {
        self.articleId = articleId
        self.sentenceIdx = sentenceIdx
    }
}

/// 复习错题的单模式计数（识别 / 完形 / 听写共用结构）。
public struct RecallModeStat: Codable, Equatable {
    public var pass: Int
    public var wrong: Int
    public var trap: Int

    public init(pass: Int = 0, wrong: Int = 0, trap: Int = 0) {
        self.pass = pass
        self.wrong = wrong
        self.trap = trap
    }
}

/// 累计错题记录（每次复习判分后累加；老数据缺省 = 无记录）。
/// byMode 键 = "recognition" | "cloze" | "dictation"。对齐 Windows RecallStat。
public struct RecallStat: Codable, Equatable {
    public var total: RecallModeStat
    public var byMode: [String: RecallModeStat]
    /// Unix 毫秒。
    public var lastAt: Int64?

    public init(total: RecallModeStat = RecallModeStat(), byMode: [String: RecallModeStat] = [:], lastAt: Int64? = nil) {
        self.total = total
        self.byMode = byMode
        self.lastAt = lastAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decodeIfPresent(RecallModeStat.self, forKey: .total) ?? RecallModeStat()
        byMode = try c.decodeIfPresent([String: RecallModeStat].self, forKey: .byMode) ?? [:]
        lastAt = try c.decodeIfPresent(Int64.self, forKey: .lastAt)
    }
}

/// 无文章来源的生词（划词收藏）配的 LLM 例句。
public struct VocabExample: Codable, Equatable {
    public var en: String
    public var zh: String?

    public init(en: String, zh: String? = nil) {
        self.en = en
        self.zh = zh
    }
}

public struct VocabSense: Codable, Equatable {
    public var pos: String
    public var cn: String

    public init(pos: String, cn: String) {
        self.pos = pos
        self.cn = cn
    }
}

public struct VocabCollocation: Codable, Equatable {
    public var en: String
    public var cn: String

    public init(en: String, cn: String) {
        self.en = en
        self.cn = cn
    }
}

/// 生词 SRS 状态。到期判定唯一依据是 dueAt。
public struct VocabSrsState: Codable, Equatable {
    public var ease: Double
    public var intervalDays: Double
    public var reps: Int
    /// Unix 毫秒。
    public var dueAt: Int64
    public var lapses: Int

    public init(ease: Double = 2.5, intervalDays: Double = 0, reps: Int = 0, dueAt: Int64, lapses: Int = 0) {
        self.ease = ease
        self.intervalDays = intervalDays
        self.reps = reps
        self.dueAt = dueAt
        self.lapses = lapses
    }
}

/// 生词（SRS 状态与到期计数同源）。
public struct VocabWord: Codable, Equatable, Identifiable {
    /// 归一化（小写、去首尾标点）后的唯一键。
    public var id: String
    public var word: String
    public var kind: VocabKind?
    public var phonetic: String?
    public var senses: [VocabSense]
    public var forms: [String]?
    public var collocations: [VocabCollocation]?
    /// kind=chunk 时的词块类型。
    public var chunkType: ChunkType?
    /// 槽位记法。
    public var pattern: String?
    /// 直译陷阱。
    public var trap: String?
    public var source: VocabSource
    public var srs: VocabSrsState
    /// Unix 毫秒。
    public var addedAt: Int64
    /// source.articleId 为空（划词收藏）时的 LLM 例句。
    public var example: VocabExample?
    /// 累计错题记录（每次复习判分后累加；老数据缺省 = 无记录）。
    public var recall: RecallStat?

    public init(
        id: String,
        word: String,
        kind: VocabKind? = nil,
        phonetic: String? = nil,
        senses: [VocabSense] = [],
        forms: [String]? = nil,
        collocations: [VocabCollocation]? = nil,
        chunkType: ChunkType? = nil,
        pattern: String? = nil,
        trap: String? = nil,
        source: VocabSource,
        srs: VocabSrsState,
        addedAt: Int64,
        example: VocabExample? = nil,
        recall: RecallStat? = nil
    ) {
        self.id = id
        self.word = word
        self.kind = kind
        self.phonetic = phonetic
        self.senses = senses
        self.forms = forms
        self.collocations = collocations
        self.chunkType = chunkType
        self.pattern = pattern
        self.trap = trap
        self.source = source
        self.srs = srs
        self.addedAt = addedAt
        self.example = example
        self.recall = recall
    }

    /// kind 缺省视为单词。
    public var effectiveKind: VocabKind { kind ?? .word }

    enum CodingKeys: String, CodingKey {
        case id, word, kind, phonetic, senses, forms, collocations
        case chunkType, pattern, trap, source, srs, addedAt, example, recall
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        word = try c.decode(String.self, forKey: .word)
        kind = try c.decodeIfPresent(VocabKind.self, forKey: .kind)
        phonetic = try c.decodeIfPresent(String.self, forKey: .phonetic)
        senses = try c.decodeIfPresent([VocabSense].self, forKey: .senses) ?? []
        forms = try c.decodeIfPresent([String].self, forKey: .forms)
        collocations = try c.decodeIfPresent([VocabCollocation].self, forKey: .collocations)
        chunkType = try c.decodeIfPresent(ChunkType.self, forKey: .chunkType)
        pattern = try c.decodeIfPresent(String.self, forKey: .pattern)
        trap = try c.decodeIfPresent(String.self, forKey: .trap)
        source = try c.decodeIfPresent(VocabSource.self, forKey: .source) ?? VocabSource(articleId: "", sentenceIdx: 0)
        srs = try c.decode(VocabSrsState.self, forKey: .srs)
        addedAt = try c.decodeIfPresent(Int64.self, forKey: .addedAt) ?? 0
        example = try c.decodeIfPresent(VocabExample.self, forKey: .example)
        recall = try c.decodeIfPresent(RecallStat.self, forKey: .recall)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(word, forKey: .word)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encodeIfPresent(phonetic, forKey: .phonetic)
        try c.encode(senses, forKey: .senses)
        try c.encodeIfPresent(forms, forKey: .forms)
        try c.encodeIfPresent(collocations, forKey: .collocations)
        try c.encodeIfPresent(chunkType, forKey: .chunkType)
        try c.encodeIfPresent(pattern, forKey: .pattern)
        try c.encodeIfPresent(trap, forKey: .trap)
        try c.encode(source, forKey: .source)
        try c.encode(srs, forKey: .srs)
        try c.encode(addedAt, forKey: .addedAt)
        try c.encodeIfPresent(example, forKey: .example)
        try c.encodeIfPresent(recall, forKey: .recall)
    }
}

// MARK: - 复习日志 / 每日阅读时长

public struct ReviewLogDay: Codable, Equatable {
    /// 本地日期 YYYY-MM-DD。
    public var day: String
    public var count: Int

    public init(day: String, count: Int) {
        self.day = day
        self.count = count
    }
}

/// 一天的累计阅读秒数（每日阅读目标追踪的数据源；对齐 Windows reader_store.rs
/// ReadingLogDay，camelCase 键 readingLog 同构）。
public struct ReadingLogDay: Codable, Equatable {
    /// 本地日期 YYYY-MM-DD。
    public var day: String
    public var seconds: Double

    public init(day: String, seconds: Double) {
        self.day = day
        self.seconds = seconds
    }
}

public struct ReviewLogFile: Codable, Equatable {
    public var schemaVersion: Int
    public var days: [ReviewLogDay]

    public init(schemaVersion: Int = readerSchemaVersion, days: [ReviewLogDay] = []) {
        self.schemaVersion = schemaVersion
        self.days = days
    }

    public static let empty = ReviewLogFile()

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case days
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? readerSchemaVersion
        days = try c.decodeIfPresent([ReviewLogDay].self, forKey: .days) ?? []
    }
}

// MARK: - 落盘文件（顶层）

/// reader_articles.json 顶层结构。
public struct ArticlesFile: Codable, Equatable {
    public var schemaVersion: Int
    public var articles: [Article]

    public init(schemaVersion: Int = readerSchemaVersion, articles: [Article] = []) {
        self.schemaVersion = schemaVersion
        self.articles = articles
    }

    public static let empty = ArticlesFile()
}

/// reader_vocab.json 顶层结构。
public struct VocabFile: Codable, Equatable {
    public var schemaVersion: Int
    public var words: [VocabWord]
    public var reviewLog: ReviewLogFile
    /// 每日阅读时长（可选字段：老数据/老应用双向兼容，schemaVersion 维持 1；
    /// 与 Windows reader_store.rs 的 reading_log 同构）。
    public var readingLog: [ReadingLogDay]?

    public init(
        schemaVersion: Int = readerSchemaVersion,
        words: [VocabWord] = [],
        reviewLog: ReviewLogFile = .empty,
        readingLog: [ReadingLogDay]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.words = words
        self.reviewLog = reviewLog
        self.readingLog = readingLog
    }

    public static let empty = VocabFile()
}

// MARK: - 编解码助手

public enum ReaderFileCodec {
    public enum ReaderFileError: Error, LocalizedError {
        case incompatibleSchema(file: String, found: Int, expected: Int)

        public var errorDescription: String? {
            switch self {
            case let .incompatibleSchema(file, found, expected):
                return "阅读室数据版本不兼容（\(file) v\(found)，应用 v\(expected)）。请升级应用后再打开。"
            }
        }
    }

    /// 文件顶层 JSON（{ schemaVersion, ... }）。schemaVersion 缺失视为 0 → 不兼容。
    public static func checkSchemaVersion(topLevel: [String: Any], file: String) throws {
        let version = (topLevel["schemaVersion"] as? Int) ?? 0
        guard version == readerSchemaVersion else {
            throw ReaderFileError.incompatibleSchema(file: file, found: version, expected: readerSchemaVersion)
        }
    }

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        return try decoder.decode(type, from: data)
    }
}
