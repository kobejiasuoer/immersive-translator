import Foundation
import ReaderCore

/// 沉浸阅读室本地存储。
///
/// - 文章（含句对、进度、按文章的设置覆盖）：
///   ~/Library/Application Support/ImmersiveTranslator/reader_articles.json
/// - 生词（SRS 状态）+ 复习打卡日志：同目录 reader_vocab.json
///
/// 数据结构与 ReaderCore（contracts/reading-room.schema.json v1）同构，
/// camelCase 序列化；写入一律走「临时文件 + rename」原子替换。
/// 对齐 Windows reader_store.rs 的命令语义。
final class ReaderStore {
    enum ReaderStoreError: LocalizedError {
        case schemaIncompatible(String)

        var errorDescription: String? {
            switch self {
            case let .schemaIncompatible(message): return message
            }
        }
    }

    static let shared = ReaderStore()

    private let queue = DispatchQueue(label: "local.immersive-translator.reader-store")
    private let fileManager = FileManager.default

    var directory: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
    }

    var articlesURL: URL { directory.appendingPathComponent("reader_articles.json") }
    var vocabURL: URL { directory.appendingPathComponent("reader_vocab.json") }

    private func ensureDirectory() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// 临时文件 + rename，落盘原子化。
    private func writeAtomically(_ data: Data, to url: URL) throws {
        try ensureDirectory()
        let tmp = url.deletingPathExtension().appendingPathExtension("json.tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try fileManager.replaceItemAt(url, withItemAt: tmp)
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
    func listArticles() throws -> [ArticleSummary] {
        try queue.sync {
            var file = try loadArticlesFile()
            file.articles.sort { $0.lastReadAt > $1.lastReadAt }
            return file.articles.map { ArticleSummary(article: $0) }
        }
    }

    func getArticle(id: String) throws -> Article? {
        try queue.sync {
            try loadArticlesFile().articles.first { $0.id == id }
        }
    }

    /// 新建或整体更新一篇文章（进度/译文/设置覆盖都通过它落盘）。
    func saveArticle(_ article: Article) throws -> ArticleSummary {
        try queue.sync {
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
