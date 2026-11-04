import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// TTS 按句拆分单测（对齐 Windows ttsTextSplit.test.ts 行为向量：短文本单片；
// 纯空白空数组；句界贪心打包 join 还原；中文 3 字节不超限；无标点码点硬切不
// 腰斩代理对（emoji）；换行句界、连续终结符归前句；自定义上限）。
// ---------------------------------------------------------------------------

final class TtsTextSplitTests: XCTestCase {
    /// 每片都是合法 UTF-8（Swift String 恒合法；再按 UTF-8 往返核对一遍字节级还原），
    /// 且不超上限。
    private func assertPiecesValid(_ pieces: [String], maxBytes: Int, file: StaticString = #filePath, line: UInt = #line) {
        for piece in pieces {
            XCTAssertLessThanOrEqual(utf8ByteLength(piece), maxBytes, file: file, line: line)
            XCTAssertEqual(String(decoding: Array(piece.utf8), as: UTF8.self), piece, file: file, line: line)
        }
    }

    // MARK: Windows 向量逐条

    func testShortTextSinglePieceAndWhitespaceEmpty() {
        XCTAssertEqual(splitTtsText("Hello world."), ["Hello world."])
        XCTAssertEqual(splitTtsText("   \n\t "), [])
        XCTAssertLessThan(ttsSplitMaxBytes, ttsMaxTextBytes)
        XCTAssertEqual(ttsSplitMaxBytes, 7900, "8000 − 100 余量")
    }

    func testGreedyPackingAtSentenceBoundariesRestoresOriginal() {
        let sentence = "The quick brown fox jumps over the lazy dog. "
        let text = String(repeating: sentence, count: 300) // 46 字节/句 ×300 ≈ 13.8KB
        let pieces = splitTtsText(text)
        XCTAssertGreaterThan(pieces.count, 1)
        assertPiecesValid(pieces, maxBytes: ttsSplitMaxBytes)
        XCTAssertEqual(pieces.joined(), jsTrim(text))
    }

    func testChineseThreeBytesPerCharSplitWithinByteLimit() {
        let text = String(repeating: "沉浸式翻译是一款双语对照翻译工具。它支持网页翻译与文档翻译。语音功能正在内测中。", count: 200)
        let pieces = splitTtsText(text)
        XCTAssertGreaterThan(pieces.count, 1)
        assertPiecesValid(pieces, maxBytes: ttsSplitMaxBytes)
        XCTAssertEqual(pieces.joined(), text)
    }

    func testNoPunctuationHardSplitKeepsMultibyteAndEmojiIntact() {
        // 中文 3 字节：2700 字 ≈ 8100 字节，单句超限；尾部放 emoji（4 字节）踩边界。
        let text = String(repeating: "译", count: 2700) + "\u{1F600}"
        let pieces = splitTtsText(text)
        XCTAssertGreaterThan(pieces.count, 1)
        assertPiecesValid(pieces, maxBytes: ttsSplitMaxBytes)
        XCTAssertEqual(pieces.joined(), text)
    }

    func testEmojiAtSplitBoundaryEveryPieceValid() {
        let text = String(repeating: "\u{1F600}", count: 2100) // 8400 字节，无标点单句
        let pieces = splitTtsText(text)
        XCTAssertGreaterThan(pieces.count, 1)
        assertPiecesValid(pieces, maxBytes: ttsSplitMaxBytes)
        for piece in pieces {
            XCTAssertTrue(piece.unicodeScalars.allSatisfy { $0 == "\u{1F600}" }, "片内只含完整 emoji 码点")
        }
        XCTAssertEqual(pieces.joined(), text)
    }

    func testTerminatorRunsBelongToPreviousSentence() {
        let text = String(repeating: "a", count: 4000) + "?!" + String(repeating: "b", count: 4000) + "…"
        let pieces = splitTtsText(text)
        XCTAssertEqual(pieces.count, 2)
        XCTAssertTrue(pieces[0].hasSuffix("?!"))
        XCTAssertTrue(pieces[1].hasSuffix("…"))
    }

    func testCustomLimitSplitsFiner() {
        let text = "first sentence. second sentence. third sentence."
        let pieces = splitTtsText(text, maxBytes: 20)
        for piece in pieces {
            XCTAssertLessThanOrEqual(utf8ByteLength(piece), 20)
        }
        XCTAssertEqual(pieces.joined(), text)
    }

    // MARK: 补充向量（同一算法的边界）

    func testCustomLimitHardSplitsOversizedSentence() {
        // 「 bbb.」5 字节 > 上限 4 → 码点硬切（与 Windows 算法同一路径）。
        XCTAssertEqual(splitTtsText("aaa. bbb.", maxBytes: 4), ["aaa.", " bbb", "."])
        // 4 + 5 = 9 > 8 → 两句分片（各自不超限，不硬切）。
        XCTAssertEqual(splitTtsText("aaa. bbb.", maxBytes: 8), ["aaa.", " bbb."])
        XCTAssertEqual(splitTtsText("aaa. bbb.", maxBytes: 9), ["aaa. bbb."])
    }

    func testNewlineIsSentenceBoundaryIncludingCRLF() {
        XCTAssertEqual(splitTtsText("line one\nline two\nline three", maxBytes: 10), ["line one\n", "line two\n", "line three"])
        // CRLF：按码点迭代，LF 照样是句界（Swift Character 会把 \r\n 合成一个字素）。
        XCTAssertEqual(splitTtsText("aaaa\r\nbbbb", maxBytes: 8), ["aaaa\r\n", "bbbb"])
    }

    func testConsecutiveTerminatorsAttachToPreviousSentence() {
        // 「?」「!」各自成句界，贪心打包后连续终结符落在同一片尾（不被拆到下一片开头）。
        XCTAssertEqual(splitTtsText("What?! Really... Yes.", maxBytes: 10), ["What?!", " Really...", " Yes."])
    }

    func testGraphemeClusterLongerThanLimitStillRespectsBytes() {
        // ZWJ 组合 emoji（家庭）单个字素簇 25 字节 > 上限 12：按码点硬切仍不超限、join 还原。
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"
        let pieces = splitTtsText(family, maxBytes: 12)
        assertPiecesValid(pieces, maxBytes: 12)
        XCTAssertEqual(pieces.joined(), family)
    }

    func testJsTrimSemantics() {
        // JS trim 去 BOM（U+FEFF），不去 U+0085。
        XCTAssertEqual(splitTtsText("\u{FEFF}Hi.\u{FEFF}"), ["Hi."])
        XCTAssertEqual(jsTrim("\u{0085}x"), "\u{0085}x")
        XCTAssertEqual(jsTrim("\u{3000}x\u{2028}"), "x")
    }

    func testDefaultsWithinServerRedline() {
        let long = String(repeating: "这是一个比较长的中文句子。", count: 2000)
        let pieces = splitTtsText(long)
        assertPiecesValid(pieces, maxBytes: ttsSplitMaxBytes)
        XCTAssertEqual(pieces.joined(), long)
    }
}
