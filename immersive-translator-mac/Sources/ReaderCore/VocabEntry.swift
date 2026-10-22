import Foundation

/// 「加入生词本」的词条决策（纯函数）：词典查询成功用词条；失败时的兜底译文
/// 只在「短释义形状」时可用——历史译文/浮窗译文可能是整句翻译，
/// 不能无条件当作词典释义（否则复习卡会把整句话当释义展示）。
/// 对齐 src/core/vocabEntry.ts。

/// 兜底译文不是「短释义形状」，不能当作词典释义入库。
public struct VocabFallbackUnavailableError: LocalizedError {
    public init() {}

    public var errorDescription: String? { "词典查询失败，请稍后重试" }
}

/// 兜底译文可用性：非空、≤40 字、不含句末终结符。
/// 例：「有弹性的；恢复快的」可用；「这种材料非常有韧性。」不可用。
public func looksLikeShortDefinition(_ cn: String) -> Bool {
    let trimmed = cn.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.count > 40 { return false }
    return trimmed.range(of: "[。．！？!?…]", options: .regularExpression) == nil
}

/// 从词典查询结果与兜底译文里定出词条。
/// dictResult 为 nil（请求失败）或非 entry（not_a_word / 解析失败）时走兜底；
/// 兜底译文不是「短释义形状」则抛错，要求重试而不是收一条整句释义。
public func resolveVocabEntry(
    queryText: String,
    dictResult: ReaderDictResult?,
    fallbackCn: String
) throws -> ReaderDictEntry {
    if case .entry(let entry) = dictResult { return entry }
    let cn = fallbackCn.trimmingCharacters(in: .whitespacesAndNewlines)
    guard looksLikeShortDefinition(cn) else {
        throw VocabFallbackUnavailableError()
    }
    return ReaderDictEntry(
        word: queryText,
        phonetic: nil,
        senses: [VocabSense(pos: "", cn: cn)],
        collocations: nil,
        forms: nil,
        chunkType: nil,
        pattern: nil,
        trap: nil
    )
}

/// 浮窗词典卡（DictCardData）→ 阅读室词条（ReaderDictEntry）：
/// 义项 gloss 为空时用一行核心释义顶上；整卡无义项时核心释义当单义项。
/// 浮窗预取卡直接复用，避免「加入生词本」再发一次词典请求。
public func readerDictEntry(fromCard card: DictCardData, query: String) -> ReaderDictEntry {
    var senses = card.senses.map { VocabSense(pos: $0.pos, cn: $0.gloss.isEmpty ? card.translation : $0.gloss) }
    if senses.isEmpty, !card.translation.isEmpty {
        senses = [VocabSense(pos: "", cn: card.translation)]
    }
    return ReaderDictEntry(
        word: card.word.isEmpty ? query : card.word,
        phonetic: card.phonetics.first?.value,
        senses: senses,
        collocations: nil,
        forms: nil,
        chunkType: nil,
        pattern: nil,
        trap: nil
    )
}

// MARK: - 口语目标词命中（对齐 src/core/speakLogic.ts textHitsTarget）

/// 目标末词容忍的常见屈折后缀（unwind → unwinding/unwinds、rule → ruled 等）。
private let targetInflectionSuffixes = ["s", "es", "ed", "d", "ing", "ings"]

private func isInflectedForm(_ word: String, of base: String) -> Bool {
    if word == base { return true }
    for suffix in targetInflectionSuffixes where word == base + suffix {
        return true
    }
    // 去 e 加 ing（make → making）等
    if base.hasSuffix("e"), base.dropLast() + "ing" == word { return true }
    return false
}

/// 归一化（大小写不敏感、忽略标点；仅保留 ASCII 字母/数字/撇号/连字符/空白，
/// 其余字符含弯撇号一律折成空格——与 speakLogic.ts 的 [^a-z0-9'\-\s] → 空格同义）。
private func normalizeTargetText(_ s: String) -> [String] {
    let lowered = s.lowercased()
    var out = String()
    out.reserveCapacity(lowered.count)
    for scalar in lowered.unicodeScalars {
        let allowed = (scalar.value >= UnicodeScalar("a").value && scalar.value <= UnicodeScalar("z").value)
            || (scalar.value >= UnicodeScalar("0").value && scalar.value <= UnicodeScalar("9").value)
            || scalar == "'" || scalar == "-"
        out.unicodeScalars.append(allowed ? scalar : " ")
    }
    return out.split(separator: " ").map(String.init).filter { !$0.isEmpty }
}

/// 用户发言是否命中目标词/词块（归一化判定）：大小写不敏感、忽略标点；
/// 目标末词容忍常见屈折后缀（unwind → unwinding/unwinds、rule → ruled 等），
/// 中间的词须原样（大小写/标点已归一）。供 SRS 自动过关与目标 chips 打勾。
public func textHitsTarget(_ userText: String, _ targetWord: String) -> Bool {
    let textTokens = normalizeTargetText(userText)
    let targetTokens = normalizeTargetText(targetWord)
    guard !textTokens.isEmpty, !targetTokens.isEmpty else { return false }
    let n = targetTokens.count
    guard n <= textTokens.count else { return false }
    var i = 0
    while i + n <= textTokens.count {
        var ok = true
        for (j, base) in targetTokens.enumerated() {
            let word = textTokens[i + j]
            // 中间的词须原样；只有末词容忍屈折
            let matched = (j == n - 1) ? isInflectedForm(word, of: base) : (word == base)
            if !matched {
                ok = false
                break
            }
        }
        if ok { return true }
        i += 1
    }
    return false
}
