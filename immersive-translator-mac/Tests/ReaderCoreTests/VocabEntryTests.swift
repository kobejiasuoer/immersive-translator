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

    // MARK: - 口语目标词命中（SPEAK-6，对齐 speakLogic.ts textHitsTarget）

    func testTextHitsTargetExactAndCaseInsensitive() {
        XCTAssertTrue(textHitsTarget("I want to unwind after work", "unwind"))
        XCTAssertTrue(textHitsTarget("Let me UNWIND it", "unwind"))
        XCTAssertFalse(textHitsTarget("I want to rewind the tape", "unwind"))
    }

    func testTextHitsTargetIgnoresPunctuation() {
        XCTAssertTrue(textHitsTarget("Unwind! Now.", "unwind"))
        XCTAssertTrue(textHitsTarget("\"unwind\", he said.", "unwind"))
    }

    func testTextHitsTargetInflectionTolerance() {
        // 末词屈折后缀容忍（spec 的验收例子：unwinding 命中 unwind）
        XCTAssertTrue(textHitsTarget("I was unwinding after work", "unwind"))
        XCTAssertTrue(textHitsTarget("She unwinds every evening", "unwind"))
        XCTAssertTrue(textHitsTarget("They ruled it out", "rule"))
        XCTAssertTrue(textHitsTarget("We are making progress", "make"))   // 去 e 加 ing
        XCTAssertTrue(textHitsTarget("The findings are clear", "finding"))
        // 屈折不匹配仍不命中（er 不在容忍后缀表）
        XCTAssertFalse(textHitsTarget("unwinder", "unwind"))
        XCTAssertFalse(textHitsTarget("unwindingly", "unwind"))
    }

    func testTextHitsTargetMultiWordChunk() {
        // 词块整体匹配（大小写/标点已归一）
        XCTAssertTrue(textHitsTarget("Take on the challenge!", "take on"))
        XCTAssertTrue(textHitsTarget("I'll take on more responsibility", "take on"))
        // 首/中词被屈折：不命中（ts 语义：中间词须原样，只有末词容忍屈折）
        XCTAssertFalse(textHitsTarget("She takes on more work", "take on"))
        XCTAssertFalse(textHitsTarget("He is taking on the task", "take on"))
        // 词块中间插了别的词：不命中（连续窗口匹配）
        XCTAssertFalse(textHitsTarget("take easily on the task", "take on"))
    }

    func testTextHitsTargetEmptyInputs() {
        XCTAssertFalse(textHitsTarget("", "word"))
        XCTAssertFalse(textHitsTarget("some text", ""))
        XCTAssertFalse(textHitsTarget("...", "word"))   // 归一后无 token
    }

    // MARK: - VocabWord.spokenAt（SPEAK-6，对齐 readerTypes.ts:155）

    private func makeWord(id: String, word: String, spokenAt: Int64? = nil) -> VocabWord {
        VocabWord(
            id: id, word: word,
            senses: [VocabSense(pos: "v.", cn: "解开")],
            source: VocabSource(articleId: "a", sentenceIdx: 0),
            srs: initialSrs(now: 1), addedAt: 1,
            spokenAt: spokenAt
        )
    }

    func testVocabWordSpokenAtCodableRoundtrip() throws {
        let w = makeWord(id: "unwind", word: "unwind", spokenAt: 1_728_000_000_000)
        let data = try JSONEncoder().encode(w)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"spokenAt\":1728000000000"))
        let back = try JSONDecoder().decode(VocabWord.self, from: data)
        XCTAssertEqual(back.spokenAt, 1_728_000_000_000)
    }

    func testVocabWordSpokenAtOmittedWhenNil() throws {
        let w = makeWord(id: "unwind", word: "unwind")
        let json = String(data: try JSONEncoder().encode(w), encoding: .utf8) ?? ""
        XCTAssertFalse(json.contains("\"spokenAt\""), "缺省不写键，不给老盘上文件加噪声")
    }

    /// 老数据（无 spokenAt）零迁移可读，缺省 = 从未用出。
    func testVocabWordDecodesLegacyJsonWithoutSpokenAt() throws {
        let json = """
        {"id":"unwind","word":"unwind","senses":[{"pos":"v.","cn":"解开"}],
         "source":{"articleId":"a","sentenceIdx":0},
         "srs":{"ease":2.5,"intervalDays":0,"reps":0,"dueAt":1,"lapses":0},"addedAt":1}
        """
        let w = try JSONDecoder().decode(VocabWord.self, from: Data(json.utf8))
        XCTAssertNil(w.spokenAt)
        XCTAssertEqual(w.senses.first?.cn, "解开")
    }
}
