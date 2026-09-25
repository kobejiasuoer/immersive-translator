import XCTest
@testable import ReaderCore

/// 「加入生词本」的词条决策（VocabEntry.swift，对齐 src/core/vocabEntry.ts）。
final class VocabEntryTests: XCTestCase {
    // MARK: - looksLikeShortDefinition

    func testLooksLikeShortDefinitionAcceptsGlossShape() {
        XCTAssertTrue(looksLikeShortDefinition("有弹性的；恢复快的"))
        XCTAssertTrue(looksLikeShortDefinition("  resilience  "))
        XCTAssertTrue(looksLikeShortDefinition("n. 韧性"))
    }

    func testLooksLikeShortDefinitionRejectsSentenceShape() {
        // 整句翻译不能当释义：含句末终结符。
        XCTAssertFalse(looksLikeShortDefinition("这种材料非常有韧性。"))
        XCTAssertFalse(looksLikeShortDefinition("It keeps bouncing back!"))
        // 超长或空都不可用。
        XCTAssertFalse(looksLikeShortDefinition(String(repeating: "长", count: 41)))
        XCTAssertFalse(looksLikeShortDefinition("   "))
    }

    // MARK: - resolveVocabEntry

    func testResolveVocabEntryPrefersDictEntry() throws {
        let entry = ReaderDictEntry(
            word: "resilient",
            phonetic: "/rɪˈzɪliənt/",
            senses: [VocabSense(pos: "adj.", cn: "有弹性的；恢复快的")],
            collocations: nil,
            forms: nil,
            chunkType: nil,
            pattern: nil,
            trap: nil
        )
        let resolved = try resolveVocabEntry(
            queryText: "resilient",
            dictResult: .entry(entry),
            fallbackCn: "这种材料非常有韧性。"
        )
        XCTAssertEqual(resolved, entry)
    }

    func testResolveVocabEntryFallsBackToShortDefinition() throws {
        let resolved = try resolveVocabEntry(
            queryText: "resilient",
            dictResult: nil,
            fallbackCn: "有弹性的；恢复快的"
        )
        XCTAssertEqual(resolved.word, "resilient")
        XCTAssertEqual(resolved.senses, [VocabSense(pos: "", cn: "有弹性的；恢复快的")])
        XCTAssertNil(resolved.phonetic)
    }

    func testResolveVocabEntryRejectsSentenceFallback() {
        // 词典失败 + 兜底译文是整句翻译：抛错要求重试，而不是收一条整句释义。
        XCTAssertThrowsError(try resolveVocabEntry(
            queryText: "resilient",
            dictResult: .notAWord,
            fallbackCn: "这种材料非常有韧性，可以用很多年。"
        )) { error in
            XCTAssertTrue(error is VocabFallbackUnavailableError)
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, "词典查询失败，请稍后重试")
        }
    }

    // MARK: - readerDictEntry(fromCard:)

    func testReaderDictEntryFromCardUsesGlossAndKeepsFallbackTranslation() {
        let card = DictCardData(
            word: "resilient",
            phonetics: [DictPhonetic(label: "US", value: "rɪˈzɪliənt")],
            translation: "有弹性的；恢复快的",
            senses: [
                DictSense(pos: "adj.", gloss: "能快速恢复的", examples: []),
                DictSense(pos: "adj.", gloss: "", examples: [])
            ],
            inflections: "",
            etymology: ""
        )
        let entry = readerDictEntry(fromCard: card, query: "resilient")
        XCTAssertEqual(entry.word, "resilient")
        XCTAssertEqual(entry.phonetic, "rɪˈzɪliənt")
        XCTAssertEqual(entry.senses.count, 2)
        XCTAssertEqual(entry.senses[0].cn, "能快速恢复的")
        // 空 gloss 的义项用一行核心释义顶上（与原 addPanelVocab 的拼卡方式一致）。
        XCTAssertEqual(entry.senses[1].cn, "有弹性的；恢复快的")
    }

    func testReaderDictEntryFromCardWithoutSensesUsesTranslation() {
        let card = DictCardData(
            word: "",
            phonetics: [],
            translation: "韧性",
            senses: [],
            inflections: "",
            etymology: ""
        )
        let entry = readerDictEntry(fromCard: card, query: "resilience")
        // 卡片没给 word 时回退查询词；无义项时核心释义当单义项。
        XCTAssertEqual(entry.word, "resilience")
        XCTAssertEqual(entry.senses, [VocabSense(pos: "", cn: "韧性")])
    }
}
