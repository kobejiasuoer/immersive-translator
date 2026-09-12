import Foundation

/// 产出式复习（Active Recall）判分内核。纯函数、零 IO，全部可测。
/// 对齐 src/core/recallJudge.ts。
///
/// 三种练习形态共用一套判定：
/// - 完形（cloze）：原句挖空，输入被挖的词/词块；命中 trap 字段给「直译陷阱」专门反馈。
/// - 听写（dictation）：听整句写整句；字符级判分外按词级命中率复核（≥85% 算 close）。
/// - 识别（recognition）：翻卡，无判分（judged = nil）。
///
/// 判分只产出「建议档」，用户仍可改选任意档评分；SRS 演进（gradeSrs）不经过这里。

/// 一次产出判定的结论。
public enum RecallVerdict: String, Equatable, CaseIterable {
    case perfect
    case close
    case trap
    case wrong

    public var headline: String {
        switch self {
        case .perfect: return "✓ 一次写对"
        case .close: return "≈ 很接近，差一点"
        case .trap: return "⚠ 命中直译陷阱"
        case .wrong: return "✗ 没想起来"
        }
    }
}

// MARK: - 归一化与距离

/// 答案归一化：小写、剥撇号（city's→citys，dont==don't）、其余非字母数字折叠为
/// 单空格、去首尾。中文按空格处理（trap 字段常带中文注释，归一化后注释自然脱落）。
public func normalizeAnswer(_ s: String) -> String {
    let apostrophes = CharacterSet(charactersIn: "’‘ʼ'")
    let lowered = s.lowercased().unicodeScalars.filter { !apostrophes.contains($0) }
    let stripped = String(String.UnicodeScalarView(lowered))
        .replacingOccurrences(of: #"[^a-z0-9\s]"#, with: " ", options: .regularExpression)
    return stripped
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 经典编辑距离（滚动数组）。
public func levenshtein(_ a: String, _ b: String) -> Int {
    let aChars = Array(a.unicodeScalars)
    let bChars = Array(b.unicodeScalars)
    let m = aChars.count
    let n = bChars.count
    if m == 0 { return n }
    if n == 0 { return m }
    var prev = Array(0...n)
    for i in 1...m {
        var cur = [i] + Array(repeating: 0, count: n)
        for j in 1...n {
            cur[j] = min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (aChars[i - 1] == bChars[j - 1] ? 0 : 1)
            )
        }
        prev = cur
    }
    return prev[n]
}

// MARK: - 判定

public struct JudgeOptions {
    /// 直译陷阱（词块标注产出）；可含多个候选，用 / 或 ； 分隔。
    public var trap: String?
    /// 除答案外同样判 perfect 的形式（如词条原形 vs 句中屈折形式）。
    public var accepted: [String]?

    public init(trap: String? = nil, accepted: [String]? = nil) {
        self.trap = trap
        self.accepted = accepted
    }
}

/// 拆开 trap 字段的多候选并归一化。
private func trapCandidates(_ trap: String?) -> [String] {
    guard let trap, !trap.isEmpty else { return [] }
    let raw = trap.replacingOccurrences(
        of: #"[/；;|]|或者|而非"#,
        with: "\u{1}",
        options: .regularExpression
    )
    return raw
        .components(separatedBy: "\u{1}")
        .map { normalizeAnswer($0) }
        .filter { !$0.isEmpty }
}

private func matchTrap(_ input: String, _ trap: String?) -> Bool {
    let t = normalizeAnswer(input)
    if t.isEmpty { return false }
    return trapCandidates(trap).contains { c in
        t == c || (c.count >= 6 && t.contains(c))
    }
}

private func stripArticles(_ s: String) -> String {
    s.replacingOccurrences(of: #"\b(a|an|the)\b"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 完形/短答案判定。顺序：perfect → trap → close → wrong。
/// close 的两条路径：去冠词相等，或编辑距离 ≤ max(1, ⌊答案长度/6⌋)。
public func judgeCloze(_ input: String, _ answer: String, options: JudgeOptions = JudgeOptions()) -> RecallVerdict {
    let i = normalizeAnswer(input)
    let a = normalizeAnswer(answer)
    if i.isEmpty { return .wrong }
    if i == a || (options.accepted ?? []).contains(where: { normalizeAnswer($0) == i }) {
        return .perfect
    }
    if matchTrap(i, options.trap) { return .trap }
    if stripArticles(i) == stripArticles(a) { return .close }
    let d = levenshtein(i, a)
    if d <= max(1, a.count / 6) { return .close }
    return .wrong
}

// MARK: - 词级 diff（听写）

public enum DiffTokenStatus: Equatable {
    case ok
    case miss
    case extra
}

public struct DiffToken: Equatable {
    /// ok/miss 用答案侧原文，extra 用用户输入侧原文。
    public var text: String
    public var status: DiffTokenStatus

    public init(text: String, status: DiffTokenStatus) {
        self.text = text
        self.status = status
    }
}

private func tokens(_ s: String) -> [String] {
    normalizeAnswer(s).split(separator: " ", omittingEmptySubsequences: true).map(String.init)
}

/// 词级对齐（LCS）：ok = 写对；miss = 漏写；extra = 多写/写错。
public func wordDiff(_ input: String, _ sentence: String) -> [DiffToken] {
    let a = tokens(input)
    let b = tokens(sentence)
    let m = a.count
    let n = b.count
    var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
    for i in 1...m {
        for j in 1...n {
            dp[i][j] = a[i - 1] == b[j - 1]
                ? dp[i - 1][j - 1] + 1
                : max(dp[i - 1][j], dp[i][j - 1])
        }
    }
    var out: [DiffToken] = []
    var i = m
    var j = n
    while i > 0, j > 0 {
        if a[i - 1] == b[j - 1] {
            out.insert(DiffToken(text: b[j - 1], status: .ok), at: 0)
            i -= 1
            j -= 1
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            out.insert(DiffToken(text: a[i - 1], status: .extra), at: 0)
            i -= 1
        } else {
            out.insert(DiffToken(text: b[j - 1], status: .miss), at: 0)
            j -= 1
        }
    }
    while i > 0 {
        out.insert(DiffToken(text: a[i - 1], status: .extra), at: 0)
        i -= 1
    }
    while j > 0 {
        out.insert(DiffToken(text: b[j - 1], status: .miss), at: 0)
        j -= 1
    }
    return out
}

/// 听写词级命中：写对词数 / 答案词数。
public func wordHitRate(_ input: String, _ sentence: String) -> Double {
    let total = tokens(sentence).count
    if total == 0 { return 0 }
    let ok = wordDiff(input, sentence).filter { $0.status == .ok }.count
    return Double(ok) / Double(total)
}

/// 听写判定：字符级 perfect/trap 优先，其余按词级命中率复核（≥85% 算 close）。
public func judgeDictation(_ input: String, _ sentence: String, options: JudgeOptions = JudgeOptions()) -> RecallVerdict {
    let i = normalizeAnswer(input)
    if i.isEmpty { return .wrong }
    if i == normalizeAnswer(sentence) { return .perfect }
    if matchTrap(i, options.trap) { return .trap }
    return wordHitRate(input, sentence) >= 0.85 ? .close : .wrong
}

// MARK: - 路由与映射

/// 智能路由：词块 → 完形（语境产出搭配）；熟词（间隔 ≥ 1 天）→ 听写（绑定听力拼写）；
/// 新词 → 识别（先认脸）。reviewMode 非 smart 时直接透传。
public func routeRecallMode(_ word: VocabWord, _ reviewMode: ReviewModeSetting) -> RecallMode {
    if reviewMode != .smart { return RecallMode(rawValue: reviewMode.rawValue) ?? .recognition }
    if word.effectiveKind == .chunk { return .cloze }
    return word.srs.intervalDays >= 1 ? .dictation : .recognition
}

/// 判定 → 建议评分档（界面描边提示，用户可改选）。
public func verdictToSuggestedGrade(_ verdict: RecallVerdict) -> ReviewGrade {
    switch verdict {
    case .perfect: return .easy
    case .close: return .good
    case .trap: return .forgot
    case .wrong: return .forgot
    }
}

/// 提示阶梯第 2 级：首字母 + 词数（如 "t… r…" 的字母部分）。
public func firstLetters(_ answer: String) -> String {
    tokens(answer).map { w in
        guard let first = w.first else { return "" }
        return "\(first)…"
    }.joined(separator: " ")
}
