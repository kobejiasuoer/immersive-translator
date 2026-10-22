import Foundation

/// 「Markdown 笔记导出」的纯函数生成器（v0.8 Phase 4）。
/// 对齐 src/core/vaultExport.ts:112-164（buildVaultMarkdown）。
///
/// 把三路真实数据汇成一篇可直接粘进 Notion / Obsidian 的学习笔记：
/// 一、核心词块（词/音标/释义/三阶徽标/原句斜体强调/pattern/trap，数据 = 生词本）；
/// 二、口语表达升级 Before → After（数据 = 口语会话里带 coachDiff 的 user 轮）；
/// 三、发音重点复盘（数据 = user 轮发音评测里的低分词 + 舌位建议）。
///
/// 红线：所有内容来自入参（真实存储），本模块不包含任何示例句；
/// 某一段没有数据时整段省略，不产出空标题。

/// 发音复盘的低分线：与正文着色 mapWordsToText 的 bad 档（<3 分）一致。
public let vaultPronBadBelow: Double = 3

/// 发音复盘低分词条目（去重保留最低分 + 舌位建议）。
public struct VaultLowPronWord: Equatable {
    public let word: String
    /// 历史最低分（5 分制）。
    public let score: Double
    /// 最差音素的舌位建议；定位不到出错的音素时为空串。
    public let tip: String

    public init(word: String, score: Double, tip: String) {
        self.word = word
        self.score = score
        self.tip = tip
    }
}

/// user 轮里 coachDiff 的「地道改写」全文：keep + ins 片段按序拼回（del 剔除）。
func vaultBetterText(_ coach: CoachDiff) -> String {
    coach.segs.filter { $0.t != .del }.map(\.v).joined(separator: " ")
}

/// user 轮里 coachDiff 新加的词块（ins 片段）——「值得记下来的新说法」。
func vaultInsertedText(_ coach: CoachDiff) -> String {
    coach.segs.filter { $0.t == .ins }.map(\.v).joined(separator: " ")
}

/// UTF-16 子串（findChunkRange 的偏移是 UTF-16；越界收敛不崩）。
func vaultSubstring16(_ s: String, _ start: Int, _ end: Int) -> String {
    let units = Array(s.utf16)
    let a = min(max(0, start), units.count)
    let b = min(max(a, end), units.count)
    guard a < b else { return "" }
    return String(decoding: units[a..<b], as: UTF16.self)
}

/// 原句里把目标词标斜体（定位不到就原样返回，不伪造强调）。
func vaultEmphasize(_ sentence: String, _ target: String) -> String {
    guard let range = findChunkRange(sentence, target) else { return sentence }
    return vaultSubstring16(sentence, 0, range.start)
        + "*" + vaultSubstring16(sentence, range.start, range.end) + "*"
        + vaultSubstring16(sentence, range.end, Array(sentence.utf16).count)
}

/// ShadowWord（音节嵌套）→ ShadowDiagWord（拍平音素；worstPhoneOf 消费形状）。
private func diagWord(from word: ShadowWord) -> ShadowDiagWord {
    ShadowDiagWord(
        content: word.content,
        phones: word.sylls.flatMap { syll in
            syll.phones.map { ShadowDiagPhone(content: $0.content, gwpp: $0.gwpp) }
        }
    )
}

/// 发音低分词（跨会话去重保留最低分；漏读 16 / 增读 32 的词没有分数意义，
/// 不计；只收 <3 分）。取最低分 top 8，附最差一次评测的舌位建议。
/// 同分词按首见顺序排（对齐 Windows Map 的插入序语义：并列分恰在第 8 名
/// 边界时，结果不随运行漂移）。
public func vaultLowPronWords(_ sessions: [SpeakSession]) -> [VaultLowPronWord] {
    var worst: [String: (word: String, score: Double, source: ShadowWord)] = [:]
    var firstSeen: [String: Int] = [:]
    for session in sessions {
        for turn in session.turns where turn.role == .user {
            guard let pron = turn.pron else { continue }
            for w in pron.words {
                if w.dpMessage == 16 || w.dpMessage == 32 { continue }
                if w.totalScore >= vaultPronBadBelow { continue }
                let key = w.content.lowercased()
                if worst[key] == nil { firstSeen[key] = firstSeen.count }
                if let prev = worst[key], prev.score <= w.totalScore { continue }
                worst[key] = (w.content, w.totalScore, w)
            }
        }
    }
    return worst
        .sorted { lhs, rhs in
            if lhs.value.score != rhs.value.score {
                return lhs.value.score < rhs.value.score
            }
            return (firstSeen[lhs.key] ?? 0) < (firstSeen[rhs.key] ?? 0)
        }
        .prefix(8)
        .map { entry in
            let tip = worstPhoneOf(diagWord(from: entry.value.source)).map { phoneTip($0.content) } ?? ""
            return VaultLowPronWord(word: entry.value.word, score: entry.value.score, tip: tip)
        }
}

/// 音标去掉首尾斜杠（/rɪˈzɪliənt/ → rɪˈzɪliənt），已是裸音标则原样。
private func barePhonetic(_ phonetic: String) -> String {
    var value = phonetic
    if value.hasPrefix("/") { value.removeFirst() }
    if value.hasSuffix("/") { value.removeLast() }
    return value
}

/// 生成整篇 Markdown（标题 + 有数据的三段；数据为空时只余标题与来源行）。
/// 行序与措辞对齐 vaultExport.ts buildVaultMarkdown 逐行。
public func buildVaultMarkdown(
    words: [VocabWord],
    sourceSentence: (String, Int) -> (en: String, zh: String?)?,
    speakSessions: [SpeakSession],
    dateKey: String
) -> String {
    var lines: [String] = ["# \(dateKey) 英语精读与口语内化笔记", ""]

    // ---- 一、核心词块 ----
    if !words.isEmpty {
        lines.append("## 一、核心词块（带原句与用法提示）")
        lines.append("")
        for (i, w) in words.enumerated() {
            let phonetic = w.phonetic.map { " `\(barePhonetic($0))`" } ?? ""
            let gloss = w.senses.map { s in s.pos.isEmpty ? s.cn : "\(s.pos) \(s.cn)" }
                .joined(separator: "；")
            lines.append("\(i + 1). **\(w.word)**\(phonetic) — \(gloss) [\(masteryStage(w).badge)]")
            // 原句取回（vaultExport.ts:123-125 同款回退）：articleId 非空优先原文
            // 通道，取不到（文章被删等）回退词条自带例句；划词收藏直接用例句。
            let fromArticle: (en: String, zh: String?)? = w.source.articleId.isEmpty
                ? nil
                : sourceSentence(w.source.articleId, w.source.sentenceIdx)
            let src = fromArticle ?? w.example.map { (en: $0.en, zh: $0.zh) }
            if let src, !src.en.isEmpty {
                lines.append("   - **原句**：\(vaultEmphasize(src.en, w.word))")
            }
            if let pattern = w.pattern, !pattern.isEmpty {
                lines.append("   - **记法**：\(pattern)")
            }
            if let trap = w.trap, !trap.isEmpty {
                lines.append("   - **直译陷阱**：\(trap)")
            }
        }
        lines.append("")
    }

    // ---- 二、口语表达升级 Before → After ----
    var coached = 0
    for session in speakSessions {
        for turn in session.turns where turn.role == .user {
            guard let coach = turn.coachDiff else { continue }
            let better = vaultBetterText(coach).trimmingCharacters(in: .whitespaces)
            guard !better.isEmpty else { continue }
            if coached == 0 {
                lines.append("## 二、口语地道表达升级（Before → After）")
                lines.append("")
            }
            coached += 1
            lines.append("- ❌ **我的原话**：\(turn.text)")
            lines.append("- ✅ **地道改写**：**\(better)**")
            let ins = vaultInsertedText(coach).trimmingCharacters(in: .whitespaces)
            if !ins.isEmpty {
                lines.append("  - **值得记的新说法**：\(ins)")
            }
            if let note = coach.note, !note.isEmpty {
                lines.append("  - **点评**：\(note)")
            }
            lines.append("")
        }
    }

    // ---- 三、发音重点复盘 ----
    let lowWords = vaultLowPronWords(speakSessions)
    if !lowWords.isEmpty {
        lines.append("## 三、发音重点复盘")
        lines.append("")
        for w in lowWords {
            let tip = w.tip.isEmpty ? "" : "：\(w.tip)"
            lines.append("- **\(w.word)**（最低 \(String(format: "%.1f", w.score)) 分）\(tip)")
        }
        lines.append("")
    }

    lines.append("> 自动汇总自阅读查词、口语表达改进与发音诊断，可直接复制进 Notion / Obsidian。")
    while let last = lines.last, last.isEmpty { lines.removeLast() }
    return lines.joined(separator: "\n")
}
