import Foundation

// MARK: - 复习首页列表与 rail 筛选（VaultPage.tsx:256-365 + VocabListPanel.tsx 的纯逻辑）
//
// 列表条目 = 到期队列（已按 dueAt 排序）+ 口语会话里带 coachDiff 的 user 轮；
// rail 两组筛选（内容来源 × 类型）联合驱动列表，计数口径与列表严格一致：
// 口语条目只挂在 全部×全部（非词非块，类型筛选时一并隐藏）。
// rail 本身不出现任何词面（防泄答案）——这里只产出计数，词面留在条目里。

/// 内容来源筛选：all 全部 / popup 划词收藏 / speak 口语纠偏 / article(id) 某篇文章。
public enum VaultSourceFilter: Equatable {
    case all
    case popup
    case speak
    case article(String)
}

/// 类型筛选：all 全部 / word 单词 / chunk 词块·短语。
public enum VaultTypeFilter: String, Equatable, CaseIterable {
    case all
    case word
    case chunk
}

/// 列表条目：词条（原句切 pre/blank/post，胶带遮 blank）或口语纠偏条目（无评分带）。
public struct VaultListEntry: Equatable, Identifiable {
    public enum Kind: Equatable {
        case word
        case speak
    }

    public let kind: Kind
    public let id: String
    // ---- 词条 ----
    public let word: VocabWord?
    /// 来源标签：`《{title}》` 或「划词收藏」。
    public let sourceLabel: String
    public let articleId: String
    public let pre: String
    public let blank: String
    public let post: String
    public let sentenceEn: String?
    public let sentenceZh: String?
    // ---- 口语纠偏 ----
    /// `{m}月{d}日`。
    public let dateLabel: String
    public let original: String
    public let segs: [CoachSeg]
    /// 地道说法全文（非 del 片段拼接）。
    public let better: String
    public let note: String?

    public init(
        kind: Kind, id: String,
        word: VocabWord? = nil, sourceLabel: String = "", articleId: String = "",
        pre: String = "", blank: String = "", post: String = "",
        sentenceEn: String? = nil, sentenceZh: String? = nil,
        dateLabel: String = "", original: String = "", segs: [CoachSeg] = [],
        better: String = "", note: String? = nil
    ) {
        self.kind = kind
        self.id = id
        self.word = word
        self.sourceLabel = sourceLabel
        self.articleId = articleId
        self.pre = pre
        self.blank = blank
        self.post = post
        self.sentenceEn = sentenceEn
        self.sentenceZh = sentenceZh
        self.dateLabel = dateLabel
        self.original = original
        self.segs = segs
        self.better = better
        self.note = note
    }
}

/// 词条原句取回（Windows buildListEntries:292-296 口径）：articleId 非空走原文通道，
/// 否则回退词条自带例句（划词收藏）。
public func vaultEntrySource(
    _ word: VocabWord,
    sourceSentence: (String, Int) -> (en: String, zh: String?)?
) -> (en: String, zh: String?)? {
    if !word.source.articleId.isEmpty {
        return sourceSentence(word.source.articleId, word.source.sentenceIdx)
    }
    return word.example.map { (en: $0.en, zh: $0.zh) }
}

/// UTF-16 子串（findChunkRange 的偏移是 UTF-16；越界收敛不崩）。
func vaultListSubstring16(_ s: String, _ start: Int, _ end: Int) -> String {
    let units = Array(s.utf16)
    let a = min(max(0, start), units.count)
    let b = min(max(a, end), units.count)
    guard a < b else { return "" }
    return String(decoding: units[a..<b], as: UTF16.self)
}

/// 列表条目构建：到期队列（已按 dueAt 排序）+ 口语改进轮（真实数据，无演示常量）。
public func buildVaultListEntries(
    due: [VocabWord],
    speakSessions: [SpeakSession],
    sourceSentence: (String, Int) -> (en: String, zh: String?)?,
    articleTitle: (String) -> String?,
    calendar: Calendar = .current
) -> [VaultListEntry] {
    var wordEntries: [VaultListEntry] = []
    for w in due {
        let src = vaultEntrySource(w, sourceSentence: sourceSentence)
        var pre = ""
        var blank = w.word
        var post = ""
        if let src, !src.en.isEmpty, let range = findChunkRange(src.en, w.word) {
            pre = vaultListSubstring16(src.en, 0, range.start)
            blank = vaultListSubstring16(src.en, range.start, range.end)
            post = vaultListSubstring16(src.en, range.end, Array(src.en.utf16).count)
        }
        let title = w.source.articleId.isEmpty ? nil : articleTitle(w.source.articleId)
        wordEntries.append(VaultListEntry(
            kind: .word,
            id: "w:\(w.id)",
            word: w,
            sourceLabel: title.map { "《\($0)》" } ?? "划词收藏",
            articleId: w.source.articleId,
            pre: pre,
            blank: blank,
            post: post,
            sentenceEn: src?.en,
            sentenceZh: src?.zh
        ))
    }

    var speakEntries: [VaultListEntry] = []
    for session in speakSessions {
        for (i, turn) in session.turns.enumerated() {
            guard turn.role == .user, let coach = turn.coachDiff else { continue }
            let better = coach.segs
                .filter { $0.t != .del }
                .map(\.v)
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            guard !better.isEmpty else { continue }
            let date = Date(timeIntervalSince1970: Double(turn.at) / 1000)
            let comps = calendar.dateComponents([.month, .day], from: date)
            speakEntries.append(VaultListEntry(
                kind: .speak,
                id: "s:\(session.id):\(i)",
                dateLabel: "\(comps.month ?? 1)月\(comps.day ?? 1)日",
                original: turn.text,
                segs: coach.segs,
                better: better,
                note: coach.note
            ))
        }
    }
    return wordEntries + speakEntries
}

/// rail 筛选联合过滤：来源（全部/文章/划词/口语纠偏）× 类型（单词/词块）。
/// 口语条目只挂在 全部×全部：它非词非块，类型筛选时一并隐藏——rail 计数与列表严格一致。
public func filterVaultListEntries(
    _ entries: [VaultListEntry],
    source: VaultSourceFilter,
    type: VaultTypeFilter
) -> [VaultListEntry] {
    entries.filter { e in
        if source == .speak { return e.kind == .speak }
        if e.kind == .speak { return source == .all && type == .all }
        if source == .popup, !e.articleId.isEmpty { return false }
        if case .article(let id) = source, e.articleId != id { return false }
        if type == .word, e.word?.kind == .chunk { return false }
        if type == .chunk, e.word?.kind != .chunk { return false }
        return true
    }
}

/// 口语纠偏轮数（带 coachDiff 的 user 轮，全部历史）——与列表的口语条目同口径。
public func vaultCoachedCount(_ sessions: [SpeakSession]) -> Int {
    sessions.reduce(0) { n, s in
        n + s.turns.filter { $0.role == .user && $0.coachDiff != nil }.count
    }
}

/// rail 两组筛选的计数（VocabListPanel.tsx:75-91）：
/// 「全部」= 到期词 + 口语轮；文章分组按到期队列首次出现排序，只列有到期词的文章。
public struct VaultRailCounts: Equatable {
    public struct ArticleGroup: Equatable {
        public let id: String
        public let count: Int
        /// 文章标题（取不到时 rail 显示「未命名文章」）。
        public let title: String?

        public init(id: String, count: Int, title: String?) {
            self.id = id
            self.count = count
            self.title = title
        }
    }

    public let total: Int
    public let articleGroups: [ArticleGroup]
    public let popupCount: Int
    public let speakCount: Int
    public let wordCount: Int
    public let chunkCount: Int

    public init(
        total: Int, articleGroups: [ArticleGroup], popupCount: Int,
        speakCount: Int, wordCount: Int, chunkCount: Int
    ) {
        self.total = total
        self.articleGroups = articleGroups
        self.popupCount = popupCount
        self.speakCount = speakCount
        self.wordCount = wordCount
        self.chunkCount = chunkCount
    }
}

public func vaultRailCounts(
    due: [VocabWord],
    speakSessions: [SpeakSession],
    articleTitle: (String) -> String?
) -> VaultRailCounts {
    var counts: [String: Int] = [:]
    var order: [String] = []
    for w in due {
        let id = w.source.articleId
        if id.isEmpty { continue }
        if counts[id] == nil { order.append(id) }
        counts[id, default: 0] += 1
    }
    let groups = order.map { id in
        VaultRailCounts.ArticleGroup(id: id, count: counts[id] ?? 0, title: articleTitle(id))
    }
    let popup = due.filter { $0.source.articleId.isEmpty }.count
    let coached = vaultCoachedCount(speakSessions)
    let words = due.filter { $0.kind != .chunk }.count
    return VaultRailCounts(
        total: due.count + coached,
        articleGroups: groups,
        popupCount: popup,
        speakCount: coached,
        wordCount: words,
        chunkCount: due.count - words
    )
}

/// Hero 的形态 chips（VaultPage.tsx:395-409）：由 due 队列逐词按同款降级规则派生——
/// 有原句 → 听音点亮；原句能定位到目标词 → 填空点亮；开口恒有词即点亮（由调用方按 total>0 判）。
public func vaultHeroModeChips(
    due: [VocabWord],
    sourceSentence: (String, Int) -> (en: String, zh: String?)?
) -> (cloze: Bool, dictation: Bool) {
    var cloze = false
    var dictation = false
    for w in due {
        guard let src = vaultEntrySource(w, sourceSentence: sourceSentence), !src.en.isEmpty else { continue }
        dictation = true
        if findChunkRange(src.en, w.word) != nil { cloze = true }
    }
    return (cloze, dictation)
}
