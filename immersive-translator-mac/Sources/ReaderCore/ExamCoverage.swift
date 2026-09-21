import Foundation

/// 考试大纲词表覆盖计算（内容进水口：文库 / 文件 / URL 预览的「覆盖 N 词 · M 个未掌握」）。
/// 对齐 src/core/examCoverage.ts：
/// - 「未掌握」口径与复习流掌握度分布一致：已在生词本且 srs.intervalDays < 7。
/// - 词表数据（exam-wordlists.json）由应用层加载注入，ReaderCore 不持盘上 IO。

public enum ExamGoal: String, CaseIterable, Equatable {
    case kaoyan
    case cet4
    case cet6

    public var label: String {
        switch self {
        case .kaoyan: return "考研"
        case .cet4: return "四级"
        case .cet6: return "六级"
        }
    }
}

/// 三个目标的词表集合；词形均为小写原形。
public struct ExamWordlists {
    public var kaoyan: Set<String>
    public var cet4: Set<String>
    public var cet6: Set<String>

    public init(kaoyan: Set<String>, cet4: Set<String>, cet6: Set<String>) {
        self.kaoyan = kaoyan
        self.cet4 = cet4
        self.cet6 = cet6
    }

    /// 从 exam-wordlists.json 的原始结构构建：{kaoyan: [...], cet4: [...], cet6: [...]}。
    public init?(rawJSON data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String]] else { return nil }
        self.init(
            kaoyan: Set((obj["kaoyan"] ?? []).map { $0.lowercased() }),
            cet4: Set((obj["cet4"] ?? []).map { $0.lowercased() }),
            cet6: Set((obj["cet6"] ?? []).map { $0.lowercased() })
        )
    }

    public func set(for goal: ExamGoal) -> Set<String> {
        switch goal {
        case .kaoyan: return kaoyan
        case .cet4: return cet4
        case .cet6: return cet6
        }
    }
}

/// 常见不规则过去式/分词 → 原形（覆盖主要屈折形式，避免词表命中率明显偏低）。
/// 键值与 examCoverage.ts 的 IRREGULAR_LEMMA 逐条一致。
let irregularLemma: [String: String] = [
    "was": "be", "were": "be", "been": "be", "am": "be", "is": "be", "are": "be",
    "had": "have", "has": "have", "having": "have",
    "did": "do", "does": "do", "done": "do",
    "went": "go", "gone": "go", "goes": "go",
    "made": "make", "makes": "make",
    "said": "say", "says": "say",
    "got": "get", "gotten": "get", "gets": "get",
    "knew": "know", "known": "know", "knows": "know",
    "took": "take", "taken": "take", "takes": "take",
    "came": "come", "comes": "come",
    "saw": "see", "seen": "see", "sees": "see",
    "gave": "give", "given": "give", "gives": "give",
    "found": "find", "finds": "find",
    "told": "tell", "tells": "tell",
    "felt": "feel", "feels": "feel",
    "left": "leave", "leaves": "leave",
    "kept": "keep", "keeps": "keep",
    "held": "hold", "holds": "hold",
    "brought": "bring", "brings": "bring",
    "thought": "think", "thinks": "think",
    "stood": "stand", "stands": "stand",
    "heard": "hear", "hears": "hear",
    "ran": "run", "runs": "run",
    "wrote": "write", "written": "write", "writes": "write",
    "read": "read", "reads": "read",
    "sat": "sit", "sits": "sit",
    "spoke": "speak", "spoken": "speak", "speaks": "speak",
    "lay": "lie", "laid": "lay", "lain": "lie", "lies": "lie",
    "grew": "grow", "grown": "grow", "grows": "grow",
    "flew": "fly", "flown": "fly", "flies": "fly",
    "fell": "fall", "fallen": "fall", "falls": "fall",
    "began": "begin", "begun": "begin", "begins": "begin",
    "sang": "sing", "sung": "sing", "sings": "sing",
    "swam": "swim", "swum": "swim",
    "ate": "eat", "eaten": "eat", "eats": "eat",
    "drank": "drink", "drunk": "drink",
    "slept": "sleep", "sleeps": "sleep",
    "woke": "wake", "woken": "wake", "wakes": "wake",
    "chose": "choose", "chosen": "choose", "chooses": "choose",
    "drove": "drive", "driven": "drive", "drives": "drive",
    "wore": "wear", "worn": "wear", "wears": "wear",
    "won": "win", "wins": "win",
    "sent": "send", "sends": "send",
    "built": "build", "builds": "build",
    "sold": "sell", "sells": "sell",
    "spent": "spend", "spends": "spend",
    "met": "meet", "meets": "meet",
    "paid": "pay", "pays": "pay",
    "lost": "lose", "loses": "lose",
    "rose": "rise", "risen": "rise", "rises": "rise",
    "broke": "break", "broken": "break", "breaks": "break",
    "hid": "hide", "hidden": "hide", "hides": "hide",
    "children": "child", "men": "man", "women": "woman", "feet": "foot",
    "teeth": "tooth", "mice": "mouse", "better": "good", "best": "good",
    "worse": "bad", "worst": "bad", "less": "little", "least": "little",
    "more": "much", "most": "much",
]

private let vowelishForDoubling = Set("aeiouwxy".unicodeScalars)

/// 规则屈折回落：复数/动词三单/-ed/-ing → 原形候选。
public func lemmaCandidates(of token: String) -> [String] {
    var out = [token]
    if let irregular = irregularLemma[token] {
        out.append(irregular)
    }
    func push(_ w: String) {
        if w.count >= 3 && !out.contains(w) { out.append(w) }
    }
    func doubledStem(_ stem: String) -> Bool {
        // 末两位相同且末位不是元音类（a e i o u w x y）—— TS 版 !/[aeiouwxy]/。
        guard stem.count >= 3,
              let last = stem.unicodeScalars.last,
              stem.unicodeScalars.dropLast().last == last else { return false }
        return !vowelishForDoubling.contains(last)
    }
    if token.hasSuffix("ies"), token.count > 4 {
        push(String(token.dropLast(3)) + "y")
    } else if token.hasSuffix("es") {
        push(String(token.dropLast(2)))
        if token.hasSuffix("ses") || token.hasSuffix("xes") || token.hasSuffix("ches") || token.hasSuffix("shes") {
            push(String(token.dropLast(1)))
        }
    } else if token.hasSuffix("s"), !token.hasSuffix("ss") {
        push(String(token.dropLast(1)))
    }
    if token.hasSuffix("ing") {
        let stem = String(token.dropLast(3))
        push(stem)
        push(stem + "e")
        if doubledStem(stem) {
            push(String(stem.dropLast()))
        }
    } else if token.hasSuffix("ied"), token.count > 4 {
        push(String(token.dropLast(3)) + "y")
    } else if token.hasSuffix("ed") {
        let stem = String(token.dropLast(2))
        push(stem)
        push(String(token.dropLast(1)))
        if doubledStem(stem) {
            push(String(stem.dropLast()))
        }
    }
    return out
}

/// 分词：小写字母串（撇号保留），供词表命中统计。
public func examTokenize(_ text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: "[a-z]+(?:['’][a-z]+)*") else { return [] }
    let lowered = text.lowercased() as NSString
    let matches = regex.matches(in: lowered as String, range: NSRange(location: 0, length: lowered.length))
    return matches.compactMap { m in
        guard let range = Range(m.range, in: lowered as String) else { return nil }
        return (lowered as String)[range].replacingOccurrences(of: "’", with: "'")
    }
}

/// 文本命中某目标词表的不重复词数（含屈折回落）。
public func coveredWords(in text: String, goal: ExamGoal, wordlists: ExamWordlists) -> Set<String> {
    let set = wordlists.set(for: goal)
    var hit = Set<String>()
    for token in examTokenize(text) {
        for cand in lemmaCandidates(of: token) {
            if set.contains(cand) {
                hit.insert(cand)
                break
            }
        }
    }
    return hit
}

public struct CoverageStats: Equatable {
    /// 篇内命中的大纲词个数（去重）。
    public var total: Int
    /// 其中在生词本里且尚未掌握（intervalDays < 7）的个数。
    public var unmastered: Int

    public init(total: Int, unmastered: Int) {
        self.total = total
        self.unmastered = unmastered
    }
}

/// 覆盖统计：命中目标词表 + 与生词本求交集。
public func coverageForText(
    _ text: String,
    goal: ExamGoal,
    vocab: [VocabWord],
    wordlists: ExamWordlists
) -> CoverageStats {
    let hit = coveredWords(in: text, goal: goal, wordlists: wordlists)
    var unmastered = 0
    for w in vocab {
        if hit.contains(w.id), w.srs.intervalDays < 7 {
            unmastered += 1
        }
    }
    return CoverageStats(total: hit.count, unmastered: unmastered)
}

/// 全库词表命中（词是否在目标词表内）。
public func wordInGoalList(_ word: String, goal: ExamGoal, wordlists: ExamWordlists) -> Bool {
    wordlists.set(for: goal).contains(word.lowercased())
}
