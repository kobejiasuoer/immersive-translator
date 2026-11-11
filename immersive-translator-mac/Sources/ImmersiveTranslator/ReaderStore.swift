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

    /// 学习接力：接线后域文件读写全部经 LearningStore（SQLite files 表优先、
    /// commit 派生 outbox 单事务、兼容文件导出）；nil（既有测试）= 纯文件 IO。
    let learning: LearningStore?

    static let shared = ReaderStore(learning: LearningStore.shared)

    private let queue = DispatchQueue(label: "local.immersive-translator.reader-store")
    private let fileManager = FileManager.default

    /// 基目录（默认应用支持目录；与 NoteStore 同法，测试可注入临时目录）。
    let baseDirectory: URL

    init(baseDirectory: URL? = nil, learning: LearningStore? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            self.baseDirectory = base.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
        self.learning = learning
    }

    /// 域数据目录：接线 LearningStore 后命名空间感知（guest=根，账号=learning/<ns>）。
    var directory: URL {
        if let learning, let dir = try? learning.dataDirectory() {
            return dir
        }
        return baseDirectory
    }

    /// 读域文件文本（接线后 files 表优先、磁盘兼容兜底）。
    /// NotFound（文件不存在）→ nil = 空库；其余读错误（无权限 / 非 UTF-8 等）
    /// 必须抛出（BUG-029：吞成 nil 会让消费方当空库、下一次保存整体清库，
    /// 对齐 LearningStore.readFileDB 只豁免 NotFound 的既定策略）。
    private func readText(_ url: URL) throws -> String? {
        if let learning {
            do {
                return try learning.readPath(url)
            } catch is LearningFileNotFoundError {
                return nil
            }
        }
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch let error as NSError {
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
            throw error
        }
    }

    /// 删除域文件（接线后走 commit(nil)：outbox 记 tombstone + files 置 NULL +
    /// 磁盘删除）。
    private func removeDomainFile(_ url: URL) {
        if let learning {
            try? learning.commit(url, nil)
            return
        }
        try? fileManager.removeItem(at: url)
    }

    /// 域文件「读 → 改 → 写」临界区（BUG-027）：串行队列内再持 LearningStore 锁跨越整段。
    /// queue 只串行化 ReaderStore 自己，管不住 SyncEngine 的 storePut（事务内 hydrate 重写
    /// 域文件快照）；读与写之间一旦插进一轮 pull，commit 就以拉取前的旧稿覆盖刚拉下的进度
    ///（mergeUnknown 旧标量胜出）并由 derive 以 now() 重新入队外推。加锁顺序恒为
    /// queue → learning 锁（LearningStore 从不回调 ReaderStore）。未接线（纯文件 IO）时
    /// 只有队列串行，行为不变。只读入口不需要：单次 readPath 本身在锁内完成。
    private func readModifyWrite<T>(_ body: () throws -> T) throws -> T {
        try queue.sync {
            guard let learning else { return try body() }
            return try learning.withExclusiveAccess(body)
        }
    }

    var articlesURL: URL { directory.appendingPathComponent("reader_articles.json") }
    var vocabURL: URL { directory.appendingPathComponent("reader_vocab.json") }
    var booksIndexURL: URL { directory.appendingPathComponent("reader_books.json") }
    var booksDirectoryURL: URL { directory.appendingPathComponent("books", isDirectory: true) }

    private func ensureDirectory() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// 临时文件 + rename，落盘原子化。父目录（含 books/ 子目录）一并确保存在
    ///（对齐 Windows books_dir 的 create_dir_all，否则首本书落盘 ENOENT）。
    /// 接线 LearningStore 后走 commit：派生 outbox 单事务 + 事务外导出兼容文件
    ///（导出失败只发 learning-export-warning，数据不回滚）。
    private func writeAtomically(_ data: Data, to url: URL) throws {
        if let learning {
            guard let text = String(data: data, encoding: .utf8) else {
                throw ReaderStoreError.schemaIncompatible("非 UTF-8 数据无法落域文件")
            }
            try learning.commit(url, text)
            return
        }
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
        guard let raw = try readText(articlesURL) else { return .empty }
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
        let data = Data(raw.utf8)
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // JSON 顶层解析失败：报错保护数据，绝不静默清空（对齐 Windows
            // load_articles_from_path「JSON 本身损坏仍报错」契约；旧实现 return .empty
            // 会让损坏文件在下一次 saveArticle 时被空库覆盖，与生词库同策略）。
            throw ReaderStoreError.schemaIncompatible("文章数据损坏：reader_articles.json 不是合法 JSON")
        }
        do {
            try ReaderFileCodec.checkSchemaVersion(topLevel: topLevel, file: "reader_articles.json")
        } catch {
            throw ReaderStoreError.schemaIncompatible((error as? LocalizedError)?.errorDescription ?? "数据版本不兼容")
        }
        do {
            return try ReaderFileCodec.decode(ArticlesFile.self, from: data)
        } catch {
            // JSON 合法但有条目解码失败（事故：v2 同步 hydrate 把缺 id 的 content-chunk
            // 分块写进了文章数组 → 整库读不出 → 书架空、导入与打开文章必失败）：
            // 抢救全部合法条目并回写自愈，只有坏条目被剔除（对齐 Windows
            // salvage_articles_file，2026-10-30 同类事故同策略；接线 LearningStore
            // 时 writeAtomically 走 commit，回写派生 outbox）。
            let salvaged = salvageArticlesFile(topLevel: topLevel)
            if let clean = try? ReaderFileCodec.encode(salvaged) {
                try? writeAtomically(clean, to: articlesURL)
            }
            return salvaged
        }
    }

    /// 从「JSON 合法但部分条目损坏」的文章文件里抢救（对齐 Windows salvage_articles_file）：
    /// 只保留能完整解码为 Article 的条目。schemaVersion 已由调用方校验，恒等于
    /// readerSchemaVersion；JSON 本身损坏由调用方报错，不走这里。
    private func salvageArticlesFile(topLevel: [String: Any]) -> ArticlesFile {
        let rows = (topLevel["articles"] as? [Any]) ?? []
        let kept: [Article] = rows.compactMap { row in
            guard let dict = row as? [String: Any],
                  JSONSerialization.isValidJSONObject(dict),
                  let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? ReaderFileCodec.decode(Article.self, from: data)
        }
        return ArticlesFile(schemaVersion: readerSchemaVersion, articles: kept)
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
        try readModifyWrite {
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
        try readModifyWrite {
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
        guard let raw = try readText(url) else { return empty }
        let data = Data(raw.utf8)
        if data.isEmpty { return empty }
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // JSON 顶层解析失败：报错保护数据，绝不静默清空（对齐 loadArticlesFile /
            // loadVocabFile 同策略）。旧实现 return empty 会让损坏的 reader_books.json
            // / books/<id>.json 在下一次 saveBook/saveBookMeta/saveArticleIntoBookFile
            // 时被空库整体覆盖——书索引整本丢失、单章重写抹掉整本书其余章节。
            throw ReaderStoreError.schemaIncompatible("数据损坏：\(file) 不是合法 JSON")
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
        try readModifyWrite {
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
        try readModifyWrite {
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
        try readModifyWrite {
            var index = try loadBooksIndexFile()
            let before = index.books.count
            index.books.removeAll { $0.id == bookId }
            guard index.books.count != before else { return false }
            try writeAtomically(try ReaderFileCodec.encode(index), to: booksIndexURL)
            let url = try bookFileURL(bookId: bookId)
            removeDomainFile(url)
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
        guard let raw = try readText(vocabURL) else { return .empty }
        let data = Data(raw.utf8)
        if data.isEmpty { return .empty }
        guard let topLevel = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // JSON 顶层解析失败：报错保护数据，绝不静默清空（对齐 Windows 564b6c1
            // 「JSON 本身损坏仍报错」契约；旧实现 return .empty 会让损坏文件在下一
            // 次 saveVocabWord 时被空库覆盖）。
            throw ReaderStoreError.schemaIncompatible("生词数据损坏：reader_vocab.json 不是合法 JSON")
        }
        do {
            try ReaderFileCodec.checkSchemaVersion(topLevel: topLevel, file: "reader_vocab.json")
        } catch {
            throw ReaderStoreError.schemaIncompatible((error as? LocalizedError)?.errorDescription ?? "数据版本不兼容")
        }
        do {
            return try ReaderFileCodec.decode(VocabFile.self, from: data)
        } catch {
            // JSON 合法但有条目反序列化失败（事故：v2 同步曾把前端词块标签的中文
            // 展示名「搭配/短语动词/习语/句式」当 chunkType 传上云端，回灌后整库
            // 读不出 → 加词必失败、生词列表空白且到期数不显示）：修复标签后逐词
            // 抢救并回写自愈（与文章库 2026-10-30 同类事故同策略；接线 LearningStore
            // 时 writeAtomically 走 commit，回写派生 outbox，下次推送顺带修正云端）。
            let salvaged = try salvageVocabFile(topLevel: topLevel)
            if let clean = try? ReaderFileCodec.encode(salvaged) {
                try? writeAtomically(clean, to: vocabURL)
            }
            return salvaged
        }
    }

    /// 中文词块标签 → 枚举值（前端 CHUNK_TYPE_LABELS 的展示名；对齐 Windows
    /// 564b6c1 repair_chunk_type_label）。
    static func repairChunkTypeLabel(_ label: String) -> String? {
        switch label {
        case "搭配": return "collocation"
        case "短语动词": return "phrasal"
        case "习语": return "idiom"
        case "句式": return "pattern"
        default: return nil
        }
    }

    /// 从「JSON 合法但部分条目损坏」的生词文件里抢救（对齐 Windows salvage_vocab_file）：
    /// 先把中文词块标签修回枚举值（词不丢），再剔除仍无法解码的词（只有坏条目出局）；
    /// reviewLog / readingLog 整体解码，失败即抛（结构性损坏不静默，让调用方报错
    /// 保护数据）。schemaVersion 已由调用方校验，恒等于 readerSchemaVersion。
    private func salvageVocabFile(topLevel: [String: Any]) throws -> VocabFile {
        var words = (topLevel["words"] as? [[String: Any]]) ?? []
        for index in words.indices {
            if let label = words[index]["chunkType"] as? String,
               let fixed = Self.repairChunkTypeLabel(label) {
                words[index]["chunkType"] = fixed
            }
        }
        let kept: [VocabWord] = words.compactMap { dict in
            guard JSONSerialization.isValidJSONObject(dict),
                  let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? ReaderFileCodec.decode(VocabWord.self, from: data)
        }
        guard let rawReviewLog = topLevel["reviewLog"],
              JSONSerialization.isValidJSONObject(rawReviewLog),
              let reviewLogData = try? JSONSerialization.data(withJSONObject: rawReviewLog),
              let reviewLog = try? ReaderFileCodec.decode(ReviewLogFile.self, from: reviewLogData) else {
            throw ReaderStoreError.schemaIncompatible("生词数据损坏：reader_vocab.json 复习日志不可解码")
        }
        var readingLog: [ReadingLogDay]?
        if let raw = topLevel["readingLog"] {
            guard JSONSerialization.isValidJSONObject(raw),
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let decoded = try? ReaderFileCodec.decode([ReadingLogDay].self, from: data) else {
                throw ReaderStoreError.schemaIncompatible("生词数据损坏：reader_vocab.json 阅读日志不可解码")
            }
            readingLog = decoded
        }
        return VocabFile(
            schemaVersion: readerSchemaVersion,
            words: kept,
            reviewLog: reviewLog,
            readingLog: readingLog
        )
    }

    func getVocabFile() throws -> VocabFile {
        try queue.sync { try loadVocabFile() }
    }

    /// 新增或更新一个生词（SRS 评分走它整体覆盖）。
    func saveVocabWord(_ word: VocabWord) throws {
        try readModifyWrite {
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
        try readModifyWrite {
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
        try readModifyWrite {
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
        try readModifyWrite {
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

    // MARK: - 每日阅读时长（reader_vocab.json 的 readingLog；对齐 reader_store.rs）

    /// 累计某天阅读秒数，返回该天累计值（每 ~15s 由阅读计时批量上报；
    /// 对齐 Windows reader_record_reading）。
    @discardableResult
    func recordReading(day: String, seconds: Double) throws -> Double {
        try readModifyWrite {
            var file = try loadVocabFile()
            file.schemaVersion = readerSchemaVersion
            let log = readingLogRecorded(file.readingLog ?? [], day: day, seconds: seconds)
            file.readingLog = log
            try writeAtomically(try ReaderFileCodec.encode(file), to: vocabURL)
            return readingSeconds(in: log, day: day)
        }
    }

    /// 某天累计阅读秒数（提醒卡 / 今日卡展示用；对齐 reader_read_seconds_today）。
    func readSeconds(day: String) throws -> Double {
        try queue.sync {
            let file = try loadVocabFile()
            return readingSeconds(in: file.readingLog ?? [], day: day)
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

    // MARK: - 学习接力复习提交（readerStore.ts readerGradeVocab / readerUndoReview 对应物）

    /// JS 空值合并 `??` 的左值判定：undefined 与 null 都算「空」（返回 nil 以便回退）。
    static func nonNullish(_ value: Any?) -> Any? {
        guard let unwrapped = LearningJSON.unwrap(value), !(unwrapped is NSNull) else { return nil }
        return unwrapped
    }

    /// 一次不可变评分事件 + 由事件归并出的词条快照原子提交；返回事件 id 与
    /// 归并后的词条 JSON。事件带 day / generation / recall；改评带
    /// supersedesEventId（Windows gradeEventIds 模式）。learning 未接线时抛错，
    /// 调用方回退旧链路（gradeSrs + saveVocabWord）。
    func gradeVocabWord(
        _ word: VocabWord,
        grade: ReviewGrade,
        mode: RecallMode,
        bucket: RecallBucket?,
        now: Int64,
        supersedesEventId: String? = nil,
        expectedNamespace: String? = nil
    ) throws -> (eventId: String, word: JSONObject) {
        guard let learning else { throw LearningStoreError("学习存储未接线") }
        let wordDict = (try? JSONSerialization.jsonObject(with: ReaderFileCodec.encode(word))) as? JSONObject ?? [:]
        let namespace = expectedNamespace ?? learning.currentNamespace()
        let stored = try learning.list("reading-vocab", expectedNamespace: namespace)
        let payload = stored.first { $0.id == word.id }?.payload as? JSONObject
        // `payload?.baseline ?? word.srs` / `payload?.baselineRecall ?? word.recall`：
        // JS `??` 对 null 与 undefined 都回退；两者都缺时 baselineRecall 为 undefined
        //（序列化省略，由 commitReview 的 ensureBaseline 补齐），绝不写 null。
        let baseline: Any = Self.nonNullish(payload?["baseline"]) ?? word.srs.jsonObject
        let baselineRecall: Any? = Self.nonNullish(payload?["baselineRecall"]) ?? word.recall?.jsonObject
        let generation = LearningJSON.string(payload?["generation"]) ?? "legacy-\(word.addedAt)"
        let deviceId = try learning.deviceId()
        var event: JSONObject = [
            "v": 2,
            "id": UUID().uuidString.lowercased(),
            "wordId": word.id,
            "deviceId": deviceId,
            "reviewedAt": now,
            "day": dayKey(nowMs: now),
            "kind": "grade",
            "grade": grade.rawValue,
            "mode": mode.rawValue,
            "generation": generation,
        ]
        if let bucket {
            event["recall"] = ["bucket": bucket.rawValue]
        }
        if let supersedesEventId {
            event["supersedesEventId"] = supersedesEventId
        }
        // 客户端先归并一遍（Rust 端 learning_commit_review 内部同样归并，双保险；
        // srs/recall 结果以落库为准）。归并输入只收形状合法的事件（readerStore.ts:67
        // `!e.deleted && isReviewEvent(e.payload)`）——库里一条畸形事件不得让评分整体失败。
        let events = try learning.list("review-events", expectedNamespace: namespace)
            .filter { !$0.deleted && isReviewEvent($0.payload) }
            .compactMap { LearningJSON.object($0.payload) }
        let reduced = try reduceReviewEvents(
            baseline: VocabSrsState(json: baseline),
            input: events + [event],
            wordId: word.id,
            generation: generation,
            baselineRecall: baselineRecall.map { RecallStat(json: $0) }
        )
        var committed = wordDict
        committed["baseline"] = baseline
        if let baselineRecall {
            committed["baselineRecall"] = baselineRecall
        } else {
            committed.removeValue(forKey: "baselineRecall")
        }
        committed["generation"] = generation
        committed["srs"] = reduced.srs.jsonObject
        committed["recall"] = reduced.recall.jsonObject
        let finalWord = try learning.commitReview(word: committed, event: event, expectedNamespace: namespace)
        return (event["id"] as! String, finalWord)
    }

    /// 撤销一次评分：生成 undo 事件并归并（无 baseline 抛 "No review baseline"）。
    func undoReviewWord(
        _ word: VocabWord, eventId: String, now: Int64, expectedNamespace: String? = nil
    ) throws -> JSONObject {
        guard let learning else { throw LearningStoreError("学习存储未接线") }
        let namespace = expectedNamespace ?? learning.currentNamespace()
        let stored = try learning.list("reading-vocab", expectedNamespace: namespace)
        // readerStore.ts:75 `if(!p?.baseline) throw`——假值（缺失/null）一律视为无基线。
        guard let payload = stored.first(where: { $0.id == word.id })?.payload as? JSONObject,
              LearningJSON.truthy(payload["baseline"]), let baseline = LearningJSON.unwrap(payload["baseline"]) else {
            throw LearningStoreError("No review baseline")
        }
        let generation = LearningJSON.string(payload["generation"])
        let deviceId = try learning.deviceId()
        // readerStore.ts:76 `generation:p.generation`——实体无 generation 时该键为
        // undefined，序列化即省略（合法事件只归 legacy- 代）；绝不能写 null
        //（isReviewEvent 判非法 → 撤销整体失败）。
        var event: JSONObject = [
            "v": 2,
            "id": UUID().uuidString.lowercased(),
            "wordId": word.id,
            "deviceId": deviceId,
            "reviewedAt": now,
            "kind": "undo",
            "mode": "recognition",
            "reversesEventId": eventId,
        ]
        if let generation {
            event["generation"] = generation
        }
        // readerStore.ts:77 撤销路径只按 isReviewEvent 过滤（不看 deleted）。
        let events = try learning.list("review-events", expectedNamespace: namespace)
            .filter { isReviewEvent($0.payload) }
            .compactMap { LearningJSON.object($0.payload) }
        let baselineRecall: Any = payload["baselineRecall"] ?? NSNull()
        let reduced = try reduceReviewEvents(
            baseline: VocabSrsState(json: baseline),
            input: events + [event],
            wordId: word.id,
            generation: generation,
            baselineRecall: LearningJSON.isNull(baselineRecall) ? nil : RecallStat(json: baselineRecall)
        )
        var wordDict = (try? JSONSerialization.jsonObject(with: ReaderFileCodec.encode(word))) as? JSONObject ?? [:]
        wordDict["baseline"] = baseline
        // baselineRecall / generation 缺省时同样省略键（JSON.stringify 丢 undefined），
        // 由 commitReview 内 ensureBaseline 按 Rust 口径补齐。
        if LearningJSON.isUndefined(payload["baselineRecall"]) {
            wordDict.removeValue(forKey: "baselineRecall")
        } else {
            wordDict["baselineRecall"] = baselineRecall
        }
        if let generation {
            wordDict["generation"] = generation
        } else {
            wordDict.removeValue(forKey: "generation")
        }
        wordDict["srs"] = reduced.srs.jsonObject
        wordDict["recall"] = reduced.recall.jsonObject
        return try learning.commitReview(word: wordDict, event: event, expectedNamespace: namespace)
    }
}
