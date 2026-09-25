import Foundation
import ReaderCore

/// 沉浸阅读室本地存储。
///
/// - 文章（含句对、进度、按文章的设置覆盖）：
///   ~/Library/Application Support/ImmersiveTranslator/reader_articles.json
/// - 生词（SRS 状态）+ 复习打卡日志：同目录 reader_vocab.json
/// - 书索引与元信息：同目录 reader_books.json；章正文：同目录 books/<bookId>.json
///
/// 数据结构与 ReaderCore（contracts/reading-room.schema.json v1）同构，
/// camelCase 序列化；写入一律走「临时文件 + rename」原子替换。
/// 对齐 Windows reader_store.rs 的命令语义：
/// - 短文照旧落 reader_articles.json；bookId 非空的书章路由到 books/<bookId>.json
///   （BookFile 整本书一个文件，流式翻译期间的防抖重写只落本书文件）；
/// - reader_articles（listArticles）永不返回书章；
/// - 生词一律与书无关，删书不删生词。
final class ReaderStore {
    enum ReaderStoreError: LocalizedError {
        case schemaIncompatible(String)
        case invalidBookId(String)

        var errorDescription: String? {
            switch self {
            case let .schemaIncompatible(message): return message
            case let .invalidBookId(id): return "无效的书籍 id：\(id)"
            }
        }
    }

    static let shared = ReaderStore()

    private let queue = DispatchQueue(label: "local.immersive-translator.reader-store")
    private let fileManager = FileManager.default

    /// 基目录（默认应用支持目录；与 NoteStore 同法，测试可注入临时目录）。
    let baseDirectory: URL

    init(baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            self.baseDirectory = base.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
    }

    var directory: URL { baseDirectory }

    var articlesURL: URL { directory.appendingPathComponent("reader_articles.json") }
    var vocabURL: URL { directory.appendingPathComponent("reader_vocab.json") }
    var booksIndexURL: URL { directory.appendingPathComponent("reader_books.json") }
    var booksDirectoryURL: URL { directory.appendingPathComponent("books", isDirectory: true) }

    private func ensureDirectory() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// 临时文件 + rename，落盘原子化。父目录（含 books/ 子目录）一并确保存在
    ///（对齐 Windows books_dir 的 create_dir_all，否则首本书落盘 ENOENT）。
    private func writeAtomically(_ data: Data, to url: URL) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingPathExtension().appendingPathExtension("json.tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try fileManager.replaceItemAt(url, withItemAt: tmp)
    }

    // MARK: - 路径（bookId 纯文件名判定，防路径穿越；与 reader_store.rs / NoteStore 同判法）

    /// book_id 只允许纯文件名（对齐 is_pure_file_name：非空且 lastPathComponent 等于自身）。
    static func isPureFileName(_ base: String) -> Bool {
        !base.isEmpty
            && base != "." && base != ".."
            && URL(fileURLWithPath: base).lastPathComponent == base
    }

    private func bookFileURL(bookId: String) throws -> URL {
        guard Self.isPureFileName(bookId) else {
            throw ReaderStoreError.invalidBookId(bookId)
        }
        return booksDirectoryURL.appendingPathComponent("\(bookId).json")
    }

    // MARK: - 文章

    private func loadArticlesFile() throws -> ArticlesFile {
        guard fileManager.fileExists(atPath: articlesURL.path) else { return .empty }
        let data = try Data(contentsOf: articlesURL)
        if data.isEmpty { return .empty }
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .empty
        }
        do {
            try ReaderFileCodec.checkSchemaVersion(topLevel: topLevel, file: "reader_articles.json")
        } catch {
            throw ReaderStoreError.schemaIncompatible((error as? LocalizedError)?.errorDescription ?? "数据版本不兼容")
        }
        return try ReaderFileCodec.decode(ArticlesFile.self, from: data)
    }

    /// 书架：文章去掉句对正文，按最近阅读排序。
    /// 书章不属于这里（防御：老版本误写进来的也过滤，书架只列短文）。
    func listArticles() throws -> [ArticleSummary] {
        try queue.sync {
            var file = try loadArticlesFile()
            file.articles = file.articles.filter { $0.bookId == nil }
            file.articles.sort { $0.lastReadAt > $1.lastReadAt }
            return file.articles.map { ArticleSummary(article: $0) }
        }
    }

    /// 短文库优先；没有则查书索引定位到书文件再取章（对齐 reader_get_article）。
    func getArticle(id: String) throws -> Article? {
        try queue.sync {
            if let short = try loadArticlesFile().articles.first(where: { $0.id == id }) {
                return short
            }
            let index = try loadBooksIndexFile()
            guard let meta = index.books.first(where: { book in
                book.chapters.contains { $0.id == id }
            }) else { return nil }
            return try loadBookFile(bookId: meta.id).articles.first { $0.id == id }
        }
    }

    /// 新建或整体更新一篇文章（进度/译文/设置覆盖都通过它落盘）。
    /// 书章（bookId 非空）路由到 books/<bookId>.json，短文照旧走 reader_articles.json。
    func saveArticle(_ article: Article) throws -> ArticleSummary {
        try queue.sync {
            if let bookId = article.bookId, !bookId.isEmpty {
                return try saveArticleIntoBookFile(article, bookId: bookId)
            }
            var file = try loadArticlesFile()
            file.schemaVersion = readerSchemaVersion
            if let idx = file.articles.firstIndex(where: { $0.id == article.id }) {
                file.articles[idx] = article
            } else {
                file.articles.append(article)
            }
            try writeAtomically(try ReaderFileCodec.encode(file), to: articlesURL)
            return ArticleSummary(article: article)
        }
    }

    @discardableResult
    func deleteArticle(id: String) throws -> Bool {
        try queue.sync {
            var file = try loadArticlesFile()
            let before = file.articles.count
            file.articles.removeAll { $0.id == id }
            guard file.articles.count != before else { return false }
            try writeAtomically(try ReaderFileCodec.encode(file), to: articlesURL)
            return true
        }
    }

    // MARK: - 书（书级载体）

    private func loadJSONFile<T: Decodable>(_ type: T.Type, url: URL, file: String, empty: T) throws -> T {
        guard fileManager.fileExists(atPath: url.path) else { return empty }
        let data = try Data(contentsOf: url)
        if data.isEmpty { return empty }
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return empty
        }
        do {
            try ReaderFileCodec.checkSchemaVersion(topLevel: topLevel, file: file)
        } catch {
            throw ReaderStoreError.schemaIncompatible((error as? LocalizedError)?.errorDescription ?? "数据版本不兼容")
        }
        return try ReaderFileCodec.decode(T.self, from: data)
    }

    private func loadBooksIndexFile() throws -> BooksFile {
        try loadJSONFile(
            BooksFile.self, url: booksIndexURL, file: "reader_books.json", empty: .empty
        )
    }

    private func loadBookFile(bookId: String) throws -> BookFile {
        try loadJSONFile(
            BookFile.self, url: try bookFileURL(bookId: bookId), file: "books/\(bookId).json", empty: .empty
        )
    }

    /// 书架的书（按最近阅读倒序）。只含索引与元信息，不含章正文。
    func listBooks() throws -> [BookMeta] {
        try queue.sync {
            let file = try loadBooksIndexFile()
            return file.books.sorted { $0.lastReadAt > $1.lastReadAt }
        }
    }

    /// 整本入库（导入向导确认时一次性调用）：写书文件 + upsert 索引，返回最新书列表。
    @discardableResult
    func saveBook(meta: BookMeta, articles: [Article]) throws -> [BookMeta] {
        try queue.sync {
            guard !meta.chapters.isEmpty else {
                throw FileImportError("书至少要有一章")
            }
            guard !articles.isEmpty else {
                throw FileImportError("书至少要有一章正文")
            }
            // 章文章的归属字段以 BookMeta 为准回填（导入方已填，这里兜底）。
            let bookId = meta.id
            let chapters = articles.map { article -> Article in
                var a = article
                a.bookId = bookId
                return a
            }
            let file = BookFile(schemaVersion: readerSchemaVersion, articles: chapters)
            try writeAtomically(try ReaderFileCodec.encode(file), to: try bookFileURL(bookId: bookId))

            var index = try loadBooksIndexFile()
            upsertBookIndex(&index, meta)
            try writeAtomically(try ReaderFileCodec.encode(index), to: booksIndexURL)
            return index.books.sorted { $0.lastReadAt > $1.lastReadAt }
        }
    }

    /// 只更新书元信息（进度/时长/最近阅读写回；不碰章正文）。
    func saveBookMeta(_ meta: BookMeta) throws {
        try queue.sync {
            var index = try loadBooksIndexFile()
            guard index.books.contains(where: { $0.id == meta.id }) else {
                throw FileImportError("书不存在: \(meta.id)")
            }
            upsertBookIndex(&index, meta)
            try writeAtomically(try ReaderFileCodec.encode(index), to: booksIndexURL)
        }
    }

    /// 删除一本书：删书卡与全部章文章（进度不可恢复），生词一律保留。
    @discardableResult
    func deleteBook(bookId: String) throws -> Bool {
        try queue.sync {
            var index = try loadBooksIndexFile()
            let before = index.books.count
            index.books.removeAll { $0.id == bookId }
            guard index.books.count != before else { return false }
            try writeAtomically(try ReaderFileCodec.encode(index), to: booksIndexURL)
            let url = try bookFileURL(bookId: bookId)
            if fileManager.fileExists(atPath: url.path) {
                try fileManager.removeItem(at: url)
            }
            return true
        }
    }

    /// 索引 upsert 一本书（按 id 替换/追加）。
    private func upsertBookIndex(_ file: inout BooksFile, _ meta: BookMeta) {
        file.schemaVersion = readerSchemaVersion
        if let idx = file.books.firstIndex(where: { $0.id == meta.id }) {
            file.books[idx] = meta
        } else {
            file.books.append(meta)
        }
    }

    /// 章文章写入单本书文件（按 id 替换/追加，整体原子重写）。
    private func saveArticleIntoBookFile(_ article: Article, bookId: String) throws -> ArticleSummary {
        let url = try bookFileURL(bookId: bookId)
        var file = try loadBookFile(bookId: bookId)
        file.schemaVersion = readerSchemaVersion
        if let idx = file.articles.firstIndex(where: { $0.id == article.id }) {
            file.articles[idx] = article
        } else {
            file.articles.append(article)
        }
        try writeAtomically(try ReaderFileCodec.encode(file), to: url)
        return ArticleSummary(article: article)
    }

    // MARK: - 生词 + 复习日志

    private func loadVocabFile() throws -> VocabFile {
        guard fileManager.fileExists(atPath: vocabURL.path) else { return .empty }
        let data = try Data(contentsOf: vocabURL)
        if data.isEmpty { return .empty }
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .empty
        }
        do {
            try ReaderFileCodec.checkSchemaVersion(topLevel: topLevel, file: "reader_vocab.json")
        } catch {
            throw ReaderStoreError.schemaIncompatible((error as? LocalizedError)?.errorDescription ?? "数据版本不兼容")
        }
        return try ReaderFileCodec.decode(VocabFile.self, from: data)
    }

    func getVocabFile() throws -> VocabFile {
        try queue.sync { try loadVocabFile() }
    }

    /// 新增或更新一个生词（SRS 评分走它整体覆盖）。
    func saveVocabWord(_ word: VocabWord) throws {
        try queue.sync {
            var file = try loadVocabFile()
            file.schemaVersion = readerSchemaVersion
            if let idx = file.words.firstIndex(where: { $0.id == word.id }) {
                file.words[idx] = word
            } else {
                file.words.append(word)
            }
            try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
        }
    }

    /// 合并生词（历史窗口/浮窗「加入生词本」共用；对齐 Windows reader_merge_vocab_words）：
    /// 按 normalizeWordKey 命中旧词时保留 srs/recall/addedAt/source，
    /// 仅补缺失的 senses/phonetic/example；未命中时新词入库。
    /// 返回是否新增（false = 合并进已有词，复习进度保持不变）。
    @discardableResult
    func mergeVocabWord(_ word: VocabWord) throws -> Bool {
        try queue.sync {
            var file = try loadVocabFile()
            file.schemaVersion = readerSchemaVersion
            let key = normalizeWordKey(word.word)
            if let idx = file.words.firstIndex(where: { $0.id == word.id || (!key.isEmpty && $0.id == key) }) {
                var merged = file.words[idx]
                if merged.senses.isEmpty { merged.senses = word.senses }
                if (merged.phonetic ?? "").isEmpty { merged.phonetic = word.phonetic }
                if merged.example == nil { merged.example = word.example }
                file.words[idx] = merged
                try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
                return false
            }
            file.words.append(word)
            try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
            return true
        }
    }

    @discardableResult
    func deleteVocabWord(id: String) throws -> Bool {
        try queue.sync {
            var file = try loadVocabFile()
            let before = file.words.count
            file.words.removeAll { $0.id == id }
            guard file.words.count != before else { return false }
            try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
            return true
        }
    }

    /// 记一次复习打卡（day = 本地时区 YYYY-MM-DD），返回打卡后的日志。
    func recordReview(day: String) throws -> ReviewLogFile {
        try queue.sync {
            var file = try loadVocabFile()
            file.schemaVersion = readerSchemaVersion
            if let idx = file.reviewLog.days.firstIndex(where: { $0.day == day }) {
                file.reviewLog.days[idx].count += 1
            } else {
                file.reviewLog.days.append(ReviewLogDay(day: day, count: 1))
            }
            file.reviewLog.schemaVersion = readerSchemaVersion
            try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
            return file.reviewLog
        }
    }

    // MARK: - 全局阅读设置（UserDefaults）

    private static let globalSettingsKey = "readerGlobalSettings"

    func loadGlobalReaderSettings() -> ReaderSettings {
        guard let data = UserDefaults.standard.data(forKey: Self.globalSettingsKey),
              let override = try? ReaderFileCodec.decode(ReaderSettingsOverride.self, from: data) else {
            return .default
        }
        // 设置文件允许只带部分字段：以 default 为底做一次合法化合并。
        return mergeReaderSettings(.default, override)
    }

    func saveGlobalReaderSettings(_ settings: ReaderSettings) {
        let data = (try? ReaderFileCodec.encode(settings)) ?? Data()
        UserDefaults.standard.set(data, forKey: Self.globalSettingsKey)
    }
}
