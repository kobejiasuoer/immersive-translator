import Foundation

/// 复习笔记解析：md 文件（JSON frontmatter + 固定标记正文）→ 结构化文档。
/// 对齐 src/core/noteParser.ts。
///
/// 正文格式由 NoteBuilder 的 prompt 严格约束（【记不住】/【记住了】/【记法】/
/// 【测】/ `> 例句` / `- 标签｜英文｜中文`），解析宁漏勿错：标记不认识的行
/// 按宽松规则兜底，绝不抛错——笔记是生成物，解析失败也要尽量渲染。

/// 一篇复习笔记的元数据。存在 .md 文件头部的 JSON frontmatter 里，
/// 与正文一起自包含导出；replay 是 AI 复盘结果（结构由视图层定义，此处透传）。
public struct NoteMeta: Codable, Equatable, Identifiable {
    /// 文件名即 id（学词笔记-YYYY-MM-DD.md）。
    public var file: String
    /// Unix 毫秒。
    public var createdAt: Int64
    public var words: Int
    /// 生成被取消时为 true（只保存了已完成部分）。
    public var partial: Bool
    public var wordIds: [String]
    /// AI 复盘结果：{verdict, weak[{w,why}], passed, stillWeak, rounds, lastAt}。
    public var replay: NoteReplay?
    /// 最近一次写回（生成时 = createdAt；复盘写回时刷新）。
    public var updatedAt: Int64

    public var id: String { file }

    public init(
        file: String = "",
        createdAt: Int64,
        words: Int,
        partial: Bool = false,
        wordIds: [String] = [],
        replay: NoteReplay? = nil,
        updatedAt: Int64 = 0
    ) {
        self.file = file
        self.createdAt = createdAt
        self.words = words
        self.partial = partial
        self.wordIds = wordIds
        self.replay = replay
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case file, createdAt, words, partial, wordIds, replay, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        file = try c.decodeIfPresent(String.self, forKey: .file) ?? ""
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        words = try c.decodeIfPresent(Int.self, forKey: .words) ?? 0
        partial = try c.decodeIfPresent(Bool.self, forKey: .partial) ?? false
        wordIds = try c.decodeIfPresent([String].self, forKey: .wordIds) ?? []
        replay = try c.decodeIfPresent(NoteReplay.self, forKey: .replay)
        updatedAt = try c.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? createdAt
    }
}

/// AI 复盘结果（写回 frontmatter.replay；rounds/lastAt 由存储层补）。
public struct NoteReplay: Codable, Equatable {
    public struct WeakItem: Codable, Equatable {
        public var w: String
        public var why: String

        public init(w: String, why: String) {
            self.w = w
            self.why = why
        }

        enum CodingKeys: String, CodingKey { case w, why }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let w = try c.decodeIfPresent(String.self, forKey: .w) {
                self.w = w
                self.why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
            } else {
                // 老结构 {word, reason}
                struct LegacyKeys: CodingKey {
                    var stringValue: String
                    var intValue: Int? { nil }
                    init?(stringValue: String) { self.stringValue = stringValue }
                    init?(intValue: Int) { nil }
                    static let word = LegacyKeys(stringValue: "word")!
                    static let reason = LegacyKeys(stringValue: "reason")!
                }
                let lc = try decoder.container(keyedBy: LegacyKeys.self)
                w = try lc.decodeIfPresent(String.self, forKey: .word) ?? ""
                why = try lc.decodeIfPresent(String.self, forKey: .reason) ?? ""
            }
        }
    }

    public var verdict: String
    public var weak: [WeakItem]
    /// 已过 / 仍错计数（生成复盘时由数据统计写入）。
    public var passed: Int
    public var stillWeak: Int
    /// 复盘时已完成的复习轮数。
    public var rounds: Int
    /// Unix 毫秒。
    public var lastAt: Int64

    public init(
        verdict: String = "",
        weak: [WeakItem] = [],
        passed: Int = 0,
        stillWeak: Int = 0,
        rounds: Int = 0,
        lastAt: Int64 = 0
    ) {
        self.verdict = verdict
        self.weak = weak
        self.passed = passed
        self.stillWeak = stillWeak
        self.rounds = rounds
        self.lastAt = lastAt
    }

    enum CodingKeys: String, CodingKey {
        case verdict, weak, passed, stillWeak, rounds, lastAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verdict = try c.decodeIfPresent(String.self, forKey: .verdict) ?? ""
        weak = try c.decodeIfPresent([WeakItem].self, forKey: .weak) ?? []
        passed = try c.decodeIfPresent(Int.self, forKey: .passed) ?? 0
        stillWeak = try c.decodeIfPresent(Int.self, forKey: .stillWeak) ?? 0
        rounds = try c.decodeIfPresent(Int.self, forKey: .rounds) ?? 0
        lastAt = try c.decodeIfPresent(Int64.self, forKey: .lastAt) ?? 0
    }
}

/// 一张词条卡（md 解析结果；音标/词性/错题记号由调用方用生词数据补齐）。
/// senses/collos 用带标签元组——解析产物，无需 Equatable。
public struct ParsedCard {
    public var word: String
    /// 【记不住】/【记住了】二选一；缺省 = 没写（渲染时用数据兜底）。
    public var diagnose: (ok: Bool, text: String)?
    /// 【记法】锚点。
    public var anchor: String?
    /// 释义行：pos 为空表示词块释义或未标注词性。
    public var senses: [(pos: String?, text: String)]
    /// `> ` 引用的例句（原样）。
    public var example: String?
    /// `- 标签｜英文｜中文` 行。
    public var collos: [(k: String, en: String, zh: String)]
    /// 【测】模式｜一句怎么测。
    public var nextTest: (mode: String, tip: String)?

    public init(word: String) {
        self.word = word
        self.senses = []
        self.collos = []
    }
}

public struct ParsedNote {
    public var glance: [String]
    public var sections: [(title: String, cards: [ParsedCard])]

    public init(glance: [String] = [], sections: [(title: String, cards: [ParsedCard])] = []) {
        self.glance = glance
        self.sections = sections
    }
}

/// 拆 JSON frontmatter：`---\n{...}\n---\n正文`（兼容 \r\n）。
public func splitNoteFrontmatter(_ raw: String) -> (meta: NoteMeta?, body: String) {
    let rest: Substring?
    if raw.hasPrefix("---\n") {
        rest = raw.dropFirst(4)
    } else if raw.hasPrefix("---\r\n") {
        rest = raw.dropFirst(5)
    } else {
        rest = nil
    }
    guard let rest else { return (nil, raw) }
    guard let endRange = rest.range(of: #"\r?\n---\r?\n"#, options: .regularExpression) else {
        return (nil, raw)
    }
    let jsonText = String(rest[rest.startIndex..<endRange.lowerBound])
    let body = String(rest[endRange.upperBound...])
    guard let data = jsonText.data(using: .utf8),
          let meta = try? JSONDecoder().decode(NoteMeta.self, from: data) else {
        return (nil, body)
    }
    return (meta, body)
}

/// 全角/半角竖线切分（LLM 两种都可能输出）。
private func splitBar(_ line: String) -> [String] {
    line.components(separatedBy: CharacterSet(charactersIn: "｜|"))
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

private func parseCardLine(_ card: inout ParsedCard, _ line: String) {
    let t = line.trimmingCharacters(in: .whitespaces)
    if t.isEmpty { return }

    if let m = firstMatch(t, pattern: #"^【(记不住|记住了)】\s*([\s\S]+)$"#) {
        card.diagnose = (ok: m[0] == "记住了", text: m[1])
        return
    }
    if let m = firstMatch(t, pattern: #"^【记法】\s*([\s\S]+)$"#) {
        card.anchor = m[0]
        return
    }
    if let m = firstMatch(t, pattern: #"^【测】\s*([\s\S]+)$"#) {
        let bars = splitBar(m[0])
        card.nextTest = (mode: bars.count > 0 ? bars[0] : "", tip: bars.count > 1 ? bars[1] : "")
        return
    }
    if t.hasPrefix(">") {
        let quote = t.replacingOccurrences(of: #"^>\s?"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if !quote.isEmpty {
            card.example = card.example.map { "\($0) \(quote)" } ?? quote
        }
        return
    }
    if t.hasPrefix("- ") {
        let item = String(t.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        let bars = splitBar(item)
        if bars.count >= 3, bars[0].count <= 6 {
            card.collos.append((k: bars[0], en: bars[1], zh: bars.dropFirst(2).joined(separator: "：")))
            return
        }
        if let m = firstMatch(item, pattern: #"^([a-z]{1,5}\.)\s+(.+)$"#) {
            card.senses.append((pos: m[0], text: m[1]))
        } else {
            card.senses.append((pos: nil, text: item))
        }
    }
}

private func firstMatch(_ text: String, pattern: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = text as NSString
    guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
          m.numberOfRanges > 1 else { return nil }
    var groups: [String] = []
    for i in 1..<m.numberOfRanges {
        if let r = Range(m.range(at: i), in: text) {
            groups.append(String(text[r]).trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
    return groups
}

/// 解析笔记正文；结构异常时尽量兜底，不抛错。
public func parseNoteMarkdown(_ body: String) -> ParsedNote {
    var note = ParsedNote()
    var inGlance = false
    var sectionIndex: Int? = nil
    var card: ParsedCard? = nil

    for rawLine in body.components(separatedBy: .newlines) {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if let h2 = headingTitle(line, level: 2) {
            card = nil
            if h2.contains("先看这里") || h2.contains("速览") {
                inGlance = true
                sectionIndex = nil
                continue
            }
            inGlance = false
            note.sections.append((title: h2, cards: []))
            sectionIndex = note.sections.count - 1
            continue
        }
        if let h3 = headingTitle(line, level: 3) {
            inGlance = false
            if sectionIndex == nil {
                note.sections.append((title: "词条", cards: []))
                sectionIndex = note.sections.count - 1
            }
            var c = ParsedCard(word: h3)
            c.word = h3
            card = c
            if let idx = sectionIndex {
                note.sections[idx].cards.append(c)
            }
            continue
        }
        if headingTitle(line, level: 1) != nil {
            continue  // 「# 复习笔记」标题行
        }
        if inGlance {
            if line.hasPrefix("- ") {
                let t = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { note.glance.append(t) }
            }
            continue
        }
        if var c = card {
            parseCardLine(&c, line)
            if let idx = sectionIndex {
                note.sections[idx].cards[note.sections[idx].cards.count - 1] = c
            }
            card = c
        }
    }
    return note
}

/// 行首 `#{level} 标题`；`##+ `（更多井号）不算。
private func headingTitle(_ line: String, level: Int) -> String? {
    let prefix = String(repeating: "#", count: level) + " "
    guard line.hasPrefix(prefix) else { return nil }
    let rest = String(line.dropFirst(prefix.count))
    // 更高层级（### 在 level=2 时）由调用方按 level 顺序先匹配；这里排除再多一井号
    if rest.hasPrefix("#") { return nil }
    return rest.trimmingCharacters(in: .whitespaces)
}
