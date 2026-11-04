import Foundation

// ---------------------------------------------------------------------------
// TTS 超长文本按句拆分（对齐 Windows src/lib/voice/ttsTextSplit.ts）：
// 服务端红线是「单次合成文本 UTF-8 字节数 < 8000」。
//
// 服务端红线是「字节」而非字符——中文 3 字节、emoji 4 字节，按字符数切会超限，
// 按字节切又可能腰斩代理对。规则：
// 1. 先按句终结符（中英文句号/问叹号/省略号/换行）切成带标点的句子；
// 2. 贪心打包，每片 ≤ 上限；句子自带标点与原空白，join 后可还原原文；
// 3. 单句超限（无标点长文本）在码点边界硬切，绝不产生孤立代理对。
//
// Swift 落法：逐 Unicode 标量（码点）遍历，与 JS `for (const ch of text)` 的码点
// 迭代同口径——不按 Character（字素簇）走：否则「\r\n」整体成一个 Character
// 认不出换行句界，且超长字素簇（ZWJ 组合 emoji）可能让单片超出字节上限。
// ---------------------------------------------------------------------------

/// 服务端 VOICE_TTS_MAX_TEXT_BYTES（env 默认 8000，`>= 8000` 拒绝）。
let ttsMaxTextBytes = 8000
/// 客户端拆分上限：留 100 字节余量，吸收服务端后续收紧与服务端侧再 trim 的偏差。
let ttsSplitMaxBytes = ttsMaxTextBytes - 100

/// UTF-8 字节数（与服务端 Buffer.byteLength 同口径）。
func utf8ByteLength(_ text: String) -> Int {
    text.utf8.count
}

/// 句终结符（含收尾连续标点）。
private let terminators: Set<Unicode.Scalar> = ["。", "！", "？", "!", "?", "…", ".", "\n"]

/// JS `String.prototype.trim` 的空白集合（WhiteSpace + LineTerminator：Zs 类、
/// TAB/VT/FF/BOM、LF/CR/LS/PS）。与 Foundation `.whitespacesAndNewlines` 的差别在
/// U+FEFF（JS 去、Foundation 不去）与 U+0085（Foundation 去、JS 不去）。
private let jsTrimSet: CharacterSet = {
    var set = CharacterSet.whitespaces // Zs + TAB
    set.insert(charactersIn: "\u{000B}\u{000C}\u{FEFF}\u{000A}\u{000D}\u{2028}\u{2029}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

/// JS `trim()` 同口径的首尾空白裁剪。
func jsTrim(_ text: String) -> String {
    text.trimmingCharacters(in: jsTrimSet)
}

/// 按句切（标点附着在前句尾部；换行自成一句界；不改动任何字符）。
private func splitIntoSentences(_ text: String) -> [String] {
    var sentences: [String] = []
    var current = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
        current.append(scalar)
        if terminators.contains(scalar) {
            // 吞掉连续终结符（「?!」「...」归前一句）
            sentences.append(String(current))
            current = String.UnicodeScalarView()
        }
    }
    if !current.isEmpty { sentences.append(String(current)) }
    return sentences
}

/// 单个码点的 UTF-8 字节数。
private func codePointBytes(_ scalar: Unicode.Scalar) -> Int {
    let value = scalar.value
    if value < 0x80 { return 1 }
    if value < 0x800 { return 2 }
    if value < 0x10000 { return 3 }
    return 4
}

/// 单句超限时按码点边界硬切成 ≤maxBytes 的片（多字节字符/代理对不截断）。
private func hardSplit(_ sentence: String, maxBytes: Int) -> [String] {
    var pieces: [String] = []
    var piece = String.UnicodeScalarView()
    var pieceBytes = 0
    for scalar in sentence.unicodeScalars {
        let scalarBytes = codePointBytes(scalar)
        if pieceBytes + scalarBytes > maxBytes, !piece.isEmpty {
            pieces.append(String(piece))
            piece = String.UnicodeScalarView()
            pieceBytes = 0
        }
        piece.append(scalar)
        pieceBytes += scalarBytes
    }
    if !piece.isEmpty { pieces.append(String(piece)) }
    return pieces
}

/// 拆成每片 UTF-8 字节数 ≤ maxBytes（默认 ttsSplitMaxBytes）的有序片段；
/// 短文本原样单片段返回；纯空白返回 []。join("") 恒等于 trim 后的输入。
func splitTtsText(_ text: String, maxBytes: Int = ttsSplitMaxBytes) -> [String] {
    let trimmed = jsTrim(text)
    if trimmed.isEmpty { return [] }
    if utf8ByteLength(trimmed) <= maxBytes { return [trimmed] }

    var pieces: [String] = []
    var current = ""
    var currentBytes = 0
    for sentence in splitIntoSentences(trimmed) {
        let sentenceBytes = utf8ByteLength(sentence)
        if sentenceBytes > maxBytes {
            // 前面积攒的先落袋，再硬切超长句（句子间无空白丢失，直接推入）
            if !current.isEmpty {
                pieces.append(current)
                current = ""
                currentBytes = 0
            }
            pieces.append(contentsOf: hardSplit(sentence, maxBytes: maxBytes))
            continue
        }
        if currentBytes + sentenceBytes > maxBytes {
            if !current.isEmpty { pieces.append(current) }
            current = sentence
            currentBytes = sentenceBytes
        } else {
            current += sentence
            currentBytes += sentenceBytes
        }
    }
    if !current.isEmpty { pieces.append(current) }
    // 防御：任何一片超限（理论上不会）再硬切一遍，保证协议红线。
    let safe = pieces.flatMap { piece -> [String] in
        utf8ByteLength(piece) > maxBytes ? hardSplit(piece, maxBytes: maxBytes) : [piece]
    }
    // 全空白片段丢弃（trim 过的输入不会出现，防御硬切边界产生空白片）。
    return safe.filter { !jsTrim($0).isEmpty }
}
