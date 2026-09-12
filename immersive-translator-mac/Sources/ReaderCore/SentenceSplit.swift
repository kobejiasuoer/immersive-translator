import Foundation

/// 英文文章 → 段落 → 句对的切分。
///
/// 句对是朗读/高亮/遮罩的最小单元，切分错误会直接破坏对齐，规则保守：
/// 先按空行/换行切段，段内按「句子终结符 + 空白 + 大写/数字/引号」切句，
/// 常见缩写（Mr. / e.g. / U.S. 等）不作为切分点。对齐 src/core/sentenceSplit.ts。

/// 常见不可切分的缩写结尾（小写匹配）。
private let abbreviations: Set<String> = [
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    "e.g", "i.e", "cf", "al", "inc", "ltd", "co", "corp", "approx",
    "dept", "est", "fig", "gen", "gov", "sen", "rep", "no", "nos", "vol",
]

private let sentenceTerminators: Set<Character> = [".", "!", "?", "…"]

/// 句子终结符后必须跟的「新句开头」。
private func startsNewSentence(_ ch: Character) -> Bool {
    guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else {
        return false
    }
    if ("A"..."Z").contains(scalar) { return true }
    if ("0"..."9").contains(scalar) { return true }
    return "\"'“‘([" .contains(ch)
}

private func isWordCharForAbbrev(_ ch: Character) -> Bool {
    ch.isLetter || ch == "." || ("0"..."9").contains(ch)
}

/// 判断 "word." 形式的句点是否属于缩写（如 Mr. / e.g. / U.S.A.）。
private func endsWithAbbreviation(_ text: String, dotIndex: String.Index) -> Bool {
    var start = dotIndex
    while start > text.startIndex, isWordCharForAbbrev(text[text.index(before: start)]) {
        start = text.index(before: start)
    }
    let token = String(text[start..<dotIndex]).lowercased()
    if token.isEmpty { return false }
    // U.S.A. / e.g. 这类多段缩写：末段在缩写表即认为整体是缩写
    return abbreviations.contains(token)
}

/// 段内切句。返回的句子保留原文标点；空白折叠为单个空格。
public func splitSentences(_ paragraph: String) -> [String] {
    let text = paragraph
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return [] }

    var sentences: [String] = []
    var start = text.startIndex
    var i = start
    while i < text.endIndex {
        let ch = text[i]
        guard sentenceTerminators.contains(ch) else {
            i = text.index(after: i)
            continue
        }
        // 吞掉连续终结符（?!、...、!?）
        var end = i
        while true {
            let next = text.index(after: end)
            guard next < text.endIndex, sentenceTerminators.contains(text[next]) else { break }
            end = next
        }
        let afterEnd = text.index(after: end)
        if afterEnd < text.endIndex {
            // 句点且是缩写（如 "Mr."）→ 不切
            if ch == ".", endsWithAbbreviation(text, dotIndex: i) {
                i = text.index(after: i)
                continue
            }
            // 后面必须跟空白 + 新句开头才算句界（小数点 3.14、网址不切）
            guard text[afterEnd].isWhitespace else {
                i = text.index(after: i)
                continue
            }
            var next = afterEnd
            while next < text.endIndex, text[next].isWhitespace {
                next = text.index(after: next)
            }
            if next >= text.endIndex || !startsNewSentence(text[next]) {
                i = text.index(after: i)
                continue
            }
        }
        let sentence = String(text[start...end]).trimmingCharacters(in: .whitespaces)
        if !sentence.isEmpty { sentences.append(sentence) }
        start = afterEnd
        i = start
    }
    let tail = String(text[start...]).trimmingCharacters(in: .whitespaces)
    if !tail.isEmpty { sentences.append(tail) }
    return sentences
}

public struct SplitParagraph: Equatable {
    public var paragraphIdx: Int
    public var en: String
    public var sentences: [String]

    public init(paragraphIdx: Int, en: String, sentences: [String]) {
        self.paragraphIdx = paragraphIdx
        self.en = en
        self.sentences = sentences
    }
}

/// 全文切段：空行（或单换行）分隔段落（对齐 TS `split(/\n{2,}|\n/)`：
/// 空段被过滤，paragraphIdx 连续）。
public func splitParagraphs(_ text: String) -> [SplitParagraph] {
    let normalized = text
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
    var result: [SplitParagraph] = []
    for raw in normalized.components(separatedBy: "\n") {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        let sentences = splitSentences(trimmed)
        guard !sentences.isEmpty else { continue }
        result.append(SplitParagraph(
            paragraphIdx: result.count,
            en: sentences.joined(separator: " "),
            sentences: sentences
        ))
    }
    return result
}
