import Foundation
import ReaderCore

// MARK: - 跨窗刷新广播（对齐 Windows collectActions.ts:5-10 的 emit 语义）

extension Notification.Name {
    /// 生词本有词新增/合并（userInfo["wordId"] = 归一化词 id）。
    /// 阅读室各窗订阅后 refreshVocab + 刷复习角标。
    static let readerVocabAdded = Notification.Name("readerVocabAdded")

    /// 阅读室有新文章落库（userInfo["articleId"] = 文章 id）。
    /// 阅读室各窗订阅后刷新书架列表。
    static let readerArticleAdded = Notification.Name("readerArticleAdded")
}

/// 「加入生词本」的结果。
struct CollectVocabOutcome {
    enum Status {
        /// 新词入库。
        case added
        /// 已在生词本（SRS 进度保持不变）。
        case merged
    }

    let status: Status
    let word: VocabWord
    /// 例句是否生成成功（旧词仅在原本没有例句时才会真正补上）。
    let withExample: Bool
}

/// 「加入生词本 / 送到阅读室」的失败原因。
enum CollectActionError: LocalizedError {
    /// 没有可加入生词本的文本。
    case emptyVocabText
    /// 没有可送到阅读室的内容。
    case emptySendText
    /// 应用实例已不可用（正在退出）。
    case appUnavailable

    var errorDescription: String? {
        switch self {
        case .emptyVocabText: return "没有可加入的文本"
        case .emptySendText: return "没有可发送的内容"
        case .appUnavailable: return "应用正在退出，请稍后重试"
        }
    }
}

/// 「加入生词本」与「送到阅读室」的公共实现：历史窗口与浮窗共用。
///
/// 设计约束（2026-09-24 历史→生词本/阅读室串联，对齐 src/lib/collectActions.ts）：
/// - 生词落库走 ReaderStore.mergeVocabWord：已有同名词保留 SRS/recall 进度，
///   仅补缺失的 senses/phonetic/example；不用会整体覆盖旧词的 saveVocabWord。
/// - 词典查询失败时的兜底译文（历史记录译文 / 浮窗当前译文）只在
///   「短释义形状」时才可采用——它可能是整句翻译，不能无条件当作词典释义。
/// - 送到阅读室只做可导入性校验 + 打开阅读室（pendingImportText）：
///   阅读室两条导入分支最终都会走 ReaderViewModel.importText→store.saveArticle，
///   公共层再前置 saveArticle 会把同一文本存成两篇。
@MainActor
enum CollectActions {
    // MARK: - 加入生词本

    /// 加入生词本：词典查词条 + LLM 造例句（并行）→ entryToVocab 生成词条 →
    /// mergeVocabWord 合并落库（保留已有词的 SRS 进度）→ 广播阅读室刷新。
    /// - Parameters:
    ///   - rawText: 要收藏的原文（历史记录原文 / 浮窗原文）。
    ///   - fallbackCn: 词典失败时的参考译文（历史记录译文 / 浮窗当前译文），
    ///     仅在「短释义形状」时采用（resolveVocabEntry 把关）。
    ///   - prefetchedCard: 浮窗已预取的词典卡；非空时跳过词典请求直接拼词条。
    static func addTextToVocab(
        chat: ReaderChatClient,
        rawText: String,
        fallbackCn: String = "",
        prefetchedCard: DictCardData? = nil
    ) async throws -> CollectVocabOutcome {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw CollectActionError.emptyVocabText }
        // 未配置接口时在这里给出明确错误（ReaderChatError.invalidEndpoint / .missingAPIKey）。
        _ = try chat.configuration()
        let target = chat.resolveTarget(for: text)

        // 词典查词条 + 例句生成并行；任一失败不炸整体（词典失败走 fallbackCn 兜底，
        // 例句失败只是没例句）——对应 Windows collectActions 的 Promise.allSettled。
        async let dictRaw = requestDictRaw(
            chat: chat,
            text: text,
            target: target,
            skipped: prefetchedCard != nil
        )
        async let exampleRaw = requestExampleRaw(chat: chat, text: text, target: target)

        let dictResponse = await dictRaw
        let exampleResponse = await exampleRaw

        let dictResult: ReaderDictResult?
        if let card = prefetchedCard {
            dictResult = .entry(readerDictEntry(fromCard: card, query: text))
        } else {
            dictResult = dictResponse.flatMap { parseDictResult(fromRaw: $0, query: text) }
        }

        let entry = try resolveVocabEntry(queryText: text, dictResult: dictResult, fallbackCn: fallbackCn)
        var word = entryToVocab(
            entry,
            source: VocabSource(articleId: "", sentenceIdx: 0),
            now: Int64(Date().timeIntervalSince1970 * 1000)
        )
        var withExample = false
        if let exampleResponse, let example = parseExampleResponse(exampleResponse, word: entry.word) {
            word.example = VocabExample(en: example.en, zh: example.zh)
            withExample = true
        }

        let added = try ReaderStore.shared.mergeVocabWord(word)
        NotificationCenter.default.post(
            name: .readerVocabAdded,
            object: nil,
            userInfo: ["wordId": word.id]
        )
        return CollectVocabOutcome(status: added ? .added : .merged, word: word, withExample: withExample)
    }

    /// 加入生词本的结果提示（历史窗口状态条与浮窗 notice 共用）。
    static func vocabResultMessage(_ outcome: CollectVocabOutcome) -> String {
        switch outcome.status {
        case .merged:
            return "「\(outcome.word.word)」已在生词本，复习进度保持不变"
        case .added:
            return "已加入生词本：\(outcome.word.word)\(outcome.withExample ? "（含例句）" : "")"
        }
    }

    /// 词典请求：失败返回 nil（走兜底，不中断流程）；skipped=true 时直接不出网
    /// （浮窗已预取词典卡，无需重复请求）。
    private static func requestDictRaw(
        chat: ReaderChatClient,
        text: String,
        target: String,
        skipped: Bool
    ) async -> String? {
        guard !skipped else { return nil }
        return try? await chat.complete(
            systemPrompt: buildDictionaryPrompt(targetLanguage: target, glossaryText: chat.glossaryText),
            userText: text
        )
    }

    /// 例句请求：失败返回 nil（只是没例句）。
    private static func requestExampleRaw(chat: ReaderChatClient, text: String, target: String) async -> String? {
        try? await chat.complete(
            systemPrompt: buildExamplePrompt(word: text, target: target),
            userText: text
        )
    }

    /// 浮窗词典响应 → ReaderDictResult：card 转词条；not_a_word/解析失败 → nil（走兜底）。
    private static func parseDictResult(fromRaw raw: String, query: String) -> ReaderDictResult? {
        switch parseDictResponse(raw, query: query) {
        case .card(let card):
            return .entry(readerDictEntry(fromCard: card, query: query))
        case .notAWord, .invalid:
            return nil
        }
    }

    // MARK: - 送到阅读室

    /// 送到阅读室：只做可导入性校验 + 打开阅读室（pendingImportText）。
    /// 建文交给阅读室导入管线（ReaderViewModel.importText→store.saveArticle），
    /// 这里不 saveArticle——见模块头注释。
    static func sendTextToReader(_ rawText: String, readerController: ReaderWindowController) throws {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, buildArticleFromText(text) != nil else {
            throw CollectActionError.emptySendText
        }
        readerController.show(pendingImportText: text)
    }
}
