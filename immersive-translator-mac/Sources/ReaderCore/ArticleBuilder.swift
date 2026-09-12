import Foundation

/// 「发送到阅读室」/ 粘贴导入：原始文本 → Article（含句对）。
///
/// 标题策略：首行若 ≤80 字符且不带句末终结符，直接当标题；
/// 否则取第一句截到 60 字符当标题。对齐 src/core/articleBuilder.ts。

private let titleMaxFromFirstLine = 80
private let titleFallbackMax = 60

public func countWords(_ text: String) -> Int {
    // 英文按空白计词；混入的 CJK 字符每字记 0.6 词（约等于词密度），向下取整。
    var cjkCount = 0
    for scalar in text.unicodeScalars {
        switch scalar.value {
        case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
            cjkCount += 1
        default:
            break
        }
    }
    // ICU 认 \uXXXX 转义；把 CJK 字符替换成空格后按空白切词。
    let latinWords = text
        .replacingOccurrences(
            of: #"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]"#,
            with: " ",
            options: .regularExpression
        )
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .count
    return latinWords + Int(Double(cjkCount) * 0.6)
}

/// 生成文章 id：时间戳 + 随机段，避免同毫秒导入冲突。
public func newArticleId(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
    let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz".utf16)
    var value = UInt64(now)
    var timePart = [UInt16]()
    repeat {
        timePart.insert(digits[Int(value % 36)], at: 0)
        value /= 36
    } while value > 0
    let rand = String(format: "%06x", Int.random(in: 0..<0x1000000))
    return "a" + String(decoding: timePart, as: UTF16.self) + rand
}

/// 规范化生词 id：小写、去首尾非字母数字（保留内部连字符/撇号）。
public func normalizeWordKey(_ word: String) -> String {
    let trimmed = word.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return "" }
    // ICU 认 \uHHHH（4 位十六进制）
    let pattern = #"^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$"#
    return trimmed.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
}

private func firstLine(of text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let newlineIdx = trimmed.firstIndex(where: \.isNewline) else {
        return trimmed
    }
    return String(trimmed[trimmed.startIndex..<newlineIdx]).trimmingCharacters(in: .whitespaces)
}

private func endsWithSentenceTerminator(_ line: String) -> Bool {
    guard let last = line.last else { return false }
    return [".", "!", "?", "…"].contains(last)
}

private func pickTitle(text: String, firstSentence: String?) -> String {
    let line = firstLine(of: text)
    if !line.isEmpty, line.count <= titleMaxFromFirstLine, !endsWithSentenceTerminator(line) {
        return line
    }
    // 无独立标题行：用第一句（截断）当标题。
    let head = line.isEmpty ? text.trimmingCharacters(in: .whitespacesAndNewlines) : line
    let base = firstSentence?.trimmingCharacters(in: .whitespaces) ?? head
    if base.count <= titleFallbackMax { return base }
    let prefix = String(base.prefix(titleFallbackMax)).trimmingCharacters(in: .whitespaces)
    return "\(prefix)…"
}

/// 导入弹窗的首行标题预览：首行 ≤80 字符且不带句末终结符才可作标题。
public func detectTitleFromText(_ text: String) -> String? {
    let line = firstLine(of: text)
    if line.isEmpty || line.count > titleMaxFromFirstLine { return nil }
    if endsWithSentenceTerminator(line) { return nil }
    return line
}

public struct BuildArticleOptions {
    public var sourceType: ArticleSourceType = .paste
    public var sourceUrl: String?
    public var now: Int64
    public var title: String?

    public init(
        sourceType: ArticleSourceType = .paste,
        sourceUrl: String? = nil,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        title: String? = nil
    ) {
        self.sourceType = sourceType
        self.sourceUrl = sourceUrl
        self.now = now
        self.title = title
    }
}

/// 从纯文本建文章。正文按段落切句；标题行（当被采用为首行时）不重复进正文。
/// `options.title`：导入弹窗里用户显式给出的标题 —— 与识别出的首行相同时仍按
/// 首行规则摘出标题；不同时整段文本都进正文，标题原样采用。
public func buildArticleFromText(_ text: String, options: BuildArticleOptions = BuildArticleOptions()) -> Article? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let line = firstLine(of: trimmed)
    let titleAsFirstLine = !line.isEmpty && line.count <= titleMaxFromFirstLine && !endsWithSentenceTerminator(line)
    let explicitTitle = options.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let bodyText: String
    if titleAsFirstLine, explicitTitle.isEmpty || explicitTitle == line {
        bodyText = String(trimmed[trimmed.index(trimmed.startIndex, offsetBy: line.count)...]).trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
        bodyText = trimmed
    }

    let paragraphs = splitParagraphs(bodyText)
    guard !paragraphs.isEmpty else { return nil }

    var sentences: [SentencePair] = []
    for p in paragraphs {
        for en in p.sentences {
            sentences.append(SentencePair(idx: sentences.count, paragraphIdx: p.paragraphIdx, en: en))
        }
    }

    let title: String
    if !explicitTitle.isEmpty {
        title = explicitTitle
    } else {
        let combined = titleAsFirstLine ? "\(line)\n\(bodyText)" : trimmed
        title = pickTitle(text: combined, firstSentence: sentences.first?.en)
    }

    return Article(
        id: newArticleId(now: options.now),
        title: title,
        titleCnState: .pending,
        sourceUrl: options.sourceUrl,
        sourceType: options.sourceType,
        wordCount: countWords(bodyText),
        createdAt: options.now,
        lastReadAt: options.now,
        sentences: sentences
    )
}
