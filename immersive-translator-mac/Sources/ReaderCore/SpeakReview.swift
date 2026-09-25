import Foundation

/// 口语复盘 → 生词本：从跟读逐词评分里提取「这轮没掌握的词」。
/// 对齐 src/core/speakVocab.ts。
///
/// 只用已落盘的结构化数据（shadowAttempts → words 的 totalScore / dpMessage），
/// 规则全部确定性、无模型参与。规则编号对应 docs/speak-review-vocab-proposal.md：
/// R1 最新分 <3.5 · R2 最新 ≥4 已攻克剔除 · R3 功能词漏读不收 · R4 漏读+低分 ·
/// R5 漏读 ≥2 次 · R6 纯漏读 1 次默认不勾 · R7 临界 3.5~4 默认不勾 · R8 封顶 8 个折叠。
///
/// dpMessage（讯飞词级）：0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。

/// 候选的失败原因（跨 attempt 合并展示）。
public enum SpeakVocabReason: String, Equatable, CaseIterable, Sendable {
    case low
    case missed
    case substituted

    public var label: String {
        switch self {
        case .low: return "准确度低"
        case .missed: return "漏读"
        case .substituted: return "替换"
        }
    }
}

/// 单个候选词（已按会话内全部跟读聚合）。
public struct SpeakVocabCandidate: Equatable {
    /// 归一化唯一键（与生词本 id 同口径）。
    public var id: String
    /// 展示用词形（保留原文大小写）。
    public var word: String
    /// 最新一次「读到」的分数（漏读不算读，纯漏读为 nil）。
    public var latestScore: Double?
    public var reasons: [SpeakVocabReason]
    /// 漏读过的次数（跨 attempt 累加）。
    public var missedCount: Int
    /// 出现过的 attempt 数（跨轮去重）。
    public var occurrences: Int
    /// 首次出现处的 AI 原句 + 中文提示（复习卡语境）。
    public var example: VocabExample
    public var defaultChecked: Bool
    /// 首次出现序（内部：排序 tie-break / 展示稳定序）。
    public var order: Int
    /// 已在生词本（不重复添加；仅唤醒/补例句）。
    public var existing: VocabWord?
    /// 已有词且近期挣扎/已到期 → 复盘后提到今日复习队列最前。
    public var wake: Bool

    public init(
        id: String,
        word: String,
        latestScore: Double?,
        reasons: [SpeakVocabReason],
        missedCount: Int,
        occurrences: Int,
        example: VocabExample,
        defaultChecked: Bool,
        order: Int,
        existing: VocabWord? = nil,
        wake: Bool = false
    ) {
        self.id = id
        self.word = word
        self.latestScore = latestScore
        self.reasons = reasons
        self.missedCount = missedCount
        self.occurrences = occurrences
        self.example = example
        self.defaultChecked = defaultChecked
        self.order = order
        self.existing = existing
        self.wake = wake
    }
}

public struct SpeakVocabExtraction: Equatable {
    /// 排序后的前 N 个（R8）。
    public var candidates: [SpeakVocabCandidate]
    /// 封顶折叠掉的较弱词。
    public var folded: [SpeakVocabCandidate]

    public init(candidates: [SpeakVocabCandidate], folded: [SpeakVocabCandidate]) {
        self.candidates = candidates
        self.folded = folded
    }
}

/// R8：一次复盘最多展示的候选数，其余折叠。
public let speakMaxCandidates = 8
/// 跟读低分阈值（5 分制）。
public let speakLowScore = 3.5
/// R2：最新分达到该值视为已攻克。
public let speakMasteredScore = 4.0
/// 漏读护栏：整句完整度低于该值视为跟丢，漏读词不可信。
public let speakMinIntegrity = 2.5
/// 漏读护栏：单次跟读漏读词超过该数视为跟丢整句。
public let speakMaxMissedPerAttempt = 4

/// 功能词表（R3）：漏读功能词是弱读吞音的正常现象，不携带词汇缺口信号，
/// 一律不进候选。只收「漏读时」的过滤，功能词读得差（<3.5）仍会进列表。
public let speakFunctionWords: Set<String> = [
    // 冠词 / 限定词
    "a", "an", "the", "this", "that", "these", "those", "some", "any", "no", "every", "each",
    // 代词
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "mine", "ours", "yours", "theirs",
    "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves",
    // 介词
    "of", "to", "in", "on", "at", "by", "for", "with", "from", "about", "as", "into",
    "through", "after", "over", "between", "out", "against", "during", "without",
    "before", "under", "around", "among", "near", "off", "above", "below", "up", "down",
    // 连词 / 从句词
    "and", "or", "but", "if", "because", "so", "than", "that", "when", "while",
    "although", "though", "since", "until", "unless", "whether",
    // 助动词 / 系动词 / 情态
    "is", "am", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "done", "have", "has", "had",
    "will", "would", "can", "could", "shall", "should", "may", "might", "must",
    // 疑问词 / 常用虚副词
    "what", "which", "who", "whom", "whose", "how", "why", "where", "there", "here",
    "not", "very", "too", "also", "just", "only", "then", "again", "once", "well",
    "oh", "ok", "okay", "yeah", "yes", "er", "um", "uh", "hmm",
]

/// 归一化候选 id（与生词本 normalizeWordKey 同口径）；数字/空词返回 nil。
func speakCandidateId(_ content: String) -> String? {
    let id = normalizeWordKey(content)
    if id.isEmpty || id.range(of: #"^\d+([.,]\d+)?$"#, options: .regularExpression) != nil {
        return nil
    }
    return id
}

/// 从一次跟读 attempt 提取候选。返回 false 表示该 attempt 的漏读数据
/// 不可信（跟丢整句护栏：完整度太低 / 漏读词太多），只采有分数的词。
func attemptMissedUsable(_ attempt: ShadowAttempt) -> Bool {
    let missed = attempt.words.filter { $0.dpMessage == 16 }.count
    return attempt.integrity >= speakMinIntegrity && missed <= speakMaxMissedPerAttempt
}

private struct SpeakVocabDraft {
    var id: String
    var word: String
    var latestScore: Double?
    var reasons: [SpeakVocabReason]
    var missedCount: Int
    var occurrences: Int
    var everLow: Bool
    var example: VocabExample
    var order: Int
}

/// 从会话的全部跟读记录提取候选（R1~R7 分类、排序、R8 折叠）。
/// 传入当前生词本时同时标注「已在生词本 / 唤醒」，并排到列表末尾。
public func extractSpeakVocab(
    _ session: SpeakSession,
    vocabWords: [VocabWord] = [],
    now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
) -> SpeakVocabExtraction {
    var drafts: [String: SpeakVocabDraft] = [:]
    var order = 0

    for turn in session.turns {
        guard turn.role == .assistant, let attempts = turn.shadowAttempts else { continue }
        for attempt in attempts {
            let missedUsable = attemptMissedUsable(attempt)
            var seenInAttempt = Set<String>()
            // 同一 attempt 内重复出现的词：分数取最差的一次
            var scoresInAttempt: [String: Double] = [:]
            for w in attempt.words {
                // 增读（dp=32）：原文没有这个词，不参与
                if w.dpMessage == 32 { continue }
                guard let id = speakCandidateId(w.content) else { continue }
                seenInAttempt.insert(id)
                if w.dpMessage != 16 {
                    if let prev = scoresInAttempt[id] {
                        if w.totalScore < prev { scoresInAttempt[id] = w.totalScore }
                    } else {
                        scoresInAttempt[id] = w.totalScore
                    }
                }
            }
            for w in attempt.words {
                if w.dpMessage == 32 { continue }
                guard let id = speakCandidateId(w.content) else { continue }
                let missed = w.dpMessage == 16
                // R3：功能词的漏读直接不收
                if missed, speakFunctionWords.contains(id) { continue }
                // 跟丢整句护栏：这次 attempt 的漏读词不可信
                if missed, !missedUsable { continue }

                if drafts[id] == nil {
                    drafts[id] = SpeakVocabDraft(
                        id: id,
                        word: w.content,
                        latestScore: nil,
                        reasons: [],
                        missedCount: 0,
                        occurrences: 0,
                        everLow: false,
                        example: VocabExample(en: turn.text, zh: turn.hintZh),
                        order: order
                    )
                    order += 1
                }
                guard seenInAttempt.contains(id) else { continue }  // 理论不可达，防御
                var draft = drafts[id]!
                if missed {
                    draft.missedCount += 1
                    if !draft.reasons.contains(.missed) { draft.reasons.append(.missed) }
                } else {
                    let score = scoresInAttempt[id] ?? w.totalScore
                    draft.latestScore = score
                    if score < speakLowScore {
                        if !draft.reasons.contains(.low) { draft.reasons.append(.low) }
                        draft.everLow = true
                    }
                    if w.dpMessage == 128, !draft.reasons.contains(.substituted) {
                        draft.reasons.append(.substituted)
                    }
                }
                drafts[id] = draft
            }
            // occurrences 按 attempt 计数（同 attempt 内重复词只算一次）
            for id in seenInAttempt {
                if drafts[id] != nil { drafts[id]!.occurrences += 1 }
            }
        }
    }

    var all: [SpeakVocabCandidate] = []
    for d in drafts.values {
        // R2：最新一次已经读好（≥4）→ 已攻克，不再打扰
        if let latest = d.latestScore, latest >= speakMasteredScore { continue }
        let missedOnlyStruggle = d.reasons.contains(.missed) && (d.everLow || d.missedCount >= 2)
        var candidate = SpeakVocabCandidate(
            id: d.id,
            word: d.word,
            latestScore: d.latestScore,
            reasons: d.reasons,
            missedCount: d.missedCount,
            occurrences: d.occurrences,
            example: d.example,
            defaultChecked: (d.latestScore.map { $0 < speakLowScore } ?? false) || missedOnlyStruggle,
            order: d.order
        )
        // 已在生词本：不重复添加；近期挣扎/已到期 → 唤醒（复盘后提到今日最前）
        if let existing = vocabWords.first(where: { $0.id == d.id }) {
            candidate.existing = existing
            candidate.wake =
                (existing.recall?.total.wrong ?? 0) >= 1 ||
                existing.srs.lapses >= 1 ||
                existing.srs.dueAt <= now
        }
        all.append(candidate)
    }

    // 排序：已收藏排最后 → 证据强度（默认勾选的低分 > 勾选的其他证据 > 未勾选）
    // → 最新分升序 → 出现次数降序 → 首次出现序。
    all.sort { a, b in
        let wa = sortWeight(a), wb = sortWeight(b)
        if wa != wb { return wa < wb }
        let sa = scoreOf(a), sb = scoreOf(b)
        if sa != sb { return sa < sb }
        if a.occurrences != b.occurrences { return a.occurrences > b.occurrences }
        return a.order < b.order
    }
    return SpeakVocabExtraction(
        candidates: Array(all.prefix(speakMaxCandidates)),
        folded: all.count > speakMaxCandidates ? Array(all[speakMaxCandidates...]) : []
    )
}

/// 已收藏的排最后（不可勾，只展示唤醒），其余按证据强度。
private func sortWeight(_ c: SpeakVocabCandidate) -> Int {
    if c.existing != nil { return 100 }
    if c.defaultChecked { return (c.latestScore.map { $0 < speakLowScore } ?? false) ? 0 : 1 }
    return 2
}

private func scoreOf(_ c: SpeakVocabCandidate) -> Double {
    c.latestScore ?? 99
}

/// 词条 → 生词本记录（source 留空 = 无文章来源，例句用本轮 AI 原句）。
/// 词典查询失败传 entry=nil：按裸词收藏，不阻塞其余词（对齐 Windows 复盘弹层的降级）。
public func speakCandidateToVocab(
    _ candidate: SpeakVocabCandidate,
    entry: ReaderDictEntry?,
    now: Int64
) -> VocabWord {
    let display = entry?.word ?? candidate.word
    let isChunk = display
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }.count > 1
    return VocabWord(
        id: candidate.id,
        word: display,
        kind: isChunk ? .chunk : .word,
        phonetic: entry?.phonetic,
        senses: entry?.senses ?? [],
        forms: entry?.forms,
        collocations: entry?.collocations,
        chunkType: isChunk ? entry?.chunkType : nil,
        pattern: isChunk ? entry?.pattern : nil,
        trap: isChunk ? entry?.trap : nil,
        source: VocabSource(articleId: "", sentenceIdx: 0),
        srs: initialSrs(now: now),
        addedAt: now,
        example: candidate.example
    )
}
