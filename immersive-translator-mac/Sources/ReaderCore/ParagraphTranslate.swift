import Foundation

/// 段级翻译协议：一段（若干句）一次请求，编号行保序换回。
///
/// 选段而不是逐句请求，是为了流式渲染有段级颗粒度（「翻译中 N/M 段」），
/// 同时请求数可控；选编号行而不是让模型自由分段，是为了句对对齐不漂移。
/// 对齐 src/core/paragraphTranslate.ts。

/// `^\s*[\[(【]?\s*(\d{1,3})\s*[\])】]?\s*[.、:：]?\s*(.+)$`
/// （ICU 字符类内 `[` 必须转义，否则被当作嵌套集合）
private let numberedLineRegex = try! NSRegularExpression(
    pattern: #"^\s*[\[\(【]?\s*(\d{1,3})\s*[\]\)】]?\s*[.、:：]?\s*(.+)$"#
)

/// 返回 (序号, 行文)；不匹配返回 nil。
private func matchNumberedLine(_ line: String) -> (index: Int, text: String)? {
    let range = NSRange(line.startIndex..., in: line)
    guard let m = numberedLineRegex.firstMatch(in: line, range: range),
          m.numberOfRanges >= 3,
          let idxRange = Range(m.range(at: 1), in: line),
          let textRange = Range(m.range(at: 2), in: line),
          let idx = Int(line[idxRange]) else {
        return nil
    }
    return (idx, String(line[textRange]).trimmingCharacters(in: .whitespaces))
}

/// 段内编号行的输入格式：`[1] Sentence one.`
public func buildParagraphRequestInput(_ sentences: [String]) -> String {
    sentences.enumerated().map { "[\($0.offset + 1)] \($0.element)" }.joined(separator: "\n")
}

/// 解析编号行响应。返回按输入序号对齐的译文数组；行数与序号
/// 无法和输入一一对应时返回 nil（上层把该段标为 failed，可重试）。
public func parseParagraphResponse(_ raw: String, expectedCount: Int) -> [String]? {
    let lines = raw
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    if lines.isEmpty { return nil }

    var byIndex: [Int: String] = [:]
    var numbered = 0
    for line in lines {
        if line.hasPrefix("```") { continue }
        guard let (idx, text) = matchNumberedLine(line) else { continue }
        guard !text.isEmpty, idx >= 1, idx <= expectedCount else { continue }
        if byIndex[idx] == nil {
            byIndex[idx] = text
            numbered += 1
        }
    }

    if numbered != expectedCount {
        // 降级：完全没有编号时，按「非空行数 == 句数」对齐（模型偶尔丢前缀）
        if numbered == 0, lines.count == expectedCount {
            return lines.map {
                $0.replacingOccurrences(of: #"^`{3,}|`{3,}$"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }
    return (1...expectedCount).compactMap { byIndex[$0] }
}

/// 流式过程中的部分解析：只取已完整的编号行，未到的句子返回 nil。
/// 与 parseParagraphResponse 不同，这允许行数不足（流还在写）。
public func parsePartialNumbered(_ raw: String, expectedCount: Int) -> [String?] {
    var out: [String?] = Array(repeating: nil, count: expectedCount)
    let lines = raw
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
    for line in lines {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("```") else { continue }
        guard let (idx, text) = matchNumberedLine(trimmed) else { continue }
        guard !text.isEmpty, idx >= 1, idx <= expectedCount else { continue }
        if out[idx - 1] == nil { out[idx - 1] = text }
    }
    return out
}

/// 中文句子之间不加空格。
public func joinChineseLines(_ lines: [String]) -> String {
    lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined()
}

/// 段落翻译的系统提示词：保序、编号、只输出译文行。
public func buildParagraphTranslateSystemPrompt(
    targetLanguage: String,
    customStyle: String,
    glossaryText: String
) -> String {
    let target = targetLanguage.isEmpty ? "中文" : targetLanguage
    var lines: [String] = [
        "你是专业的英译\(target)译者。输入是若干行带 [N] 编号的英文句子（属于同一段落）。",
        "要求：",
        "1. 逐行翻译成自然的\(target)，保持编号前缀，输出恰好与输入相同数量的行；",
        "2. 输出格式严格为 `[N] 译文`，每行一句，不要合并、不要拆分、不要加任何解释或前后缀；",
        "3. 保留专有名词与数字的准确性；不要输出 Markdown 代码块围栏。"
    ]
    let cleanStyle = customStyle.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cleanStyle.isEmpty {
        lines.append("风格要求：\(cleanStyle)")
    }
    let cleanGlossary = glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cleanGlossary.isEmpty {
        lines.append("术语表（优先遵守）：\n\(cleanGlossary)")
    }
    return lines.filter { !$0.isEmpty }.joined(separator: "\n")
}

/// 标题（单行）翻译的系统提示词。
public func buildTitleTranslateSystemPrompt(target: String) -> String {
    [
        "你是专业的英译\(target)译者。把输入的文章标题翻译成简洁自然的\(target)。",
        "只输出译文本身，不要解释、不要引号、不要保留原文。"
    ].joined(separator: "\n")
}
