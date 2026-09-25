import XCTest
@testable import ReaderCore

/// 口语复盘 → 生词本（R1~R8 规则、跟丢护栏、落盘结构兼容）。对齐 src/core/speakVocab.ts。

final class SpeakReviewTests: XCTestCase {
    // MARK: - 构造辅助

    private func shadowWord(_ content: String, score: Double = 5, dp: Int = 0) -> ShadowWord {
        ShadowWord(content: content, totalScore: score, dpMessage: dp)
    }

    private func attempt(
        integrity: Double = 5,
        words: [ShadowWord],
        at: Int64 = 0
    ) -> ShadowAttempt {
        ShadowAttempt(at: at, total: 4, accuracy: 4, fluency: 4, integrity: integrity, words: words)
    }

    private func assistant(
        _ text: String,
        hint: String? = nil,
        attempts: [ShadowAttempt] = [],
        at: Int64 = 0
    ) -> SpeakTurn {
        SpeakTurn(
            role: .assistant, text: text, hintZh: hint,
            shadowScore: attempts.last?.total,
            shadowAttempts: attempts.isEmpty ? nil : attempts, at: at
        )
    }

    private func session(_ turns: [SpeakTurn]) -> SpeakSession {
        SpeakSession(
            id: "s1", scenario: .ordering, difficulty: .medium,
            turns: turns, createdAt: 0, updatedAt: 0
        )
    }

    // MARK: - R1 / R2

    func testR1LowLatestScoreIsCheckedCandidate() {
        let s = session([assistant("Try the latte.", hint: "尝尝拿铁", attempts: [
            attempt(words: [shadowWord("latte", score: 2.4)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.count, 1)
        let c = ex.candidates[0]
        XCTAssertEqual(c.id, "latte")
        XCTAssertEqual(c.latestScore ?? -1, 2.4, accuracy: 0.001)
        XCTAssertEqual(c.reasons, [.low])
        XCTAssertTrue(c.defaultChecked)
        XCTAssertEqual(c.example.en, "Try the latte.")
        XCTAssertEqual(c.example.zh, "尝尝拿铁")
    }

    func testR2MasteredLatestScoreExcluded() {
        // 最新一次 ≥4 → 已攻克，不再打扰（历史低分不翻旧账）
        let s = session([assistant("Try the latte.", attempts: [
            attempt(words: [shadowWord("latte", score: 2.4)]),
            attempt(words: [shadowWord("latte", score: 4.2)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertTrue(ex.candidates.isEmpty)
        XCTAssertTrue(ex.folded.isEmpty)
    }

    // MARK: - R3 功能词

    func testR3FunctionWordMissedNotCollected() {
        let s = session([assistant("I want the latte.", attempts: [attempt(words: [
            shadowWord("the", dp: 16),
            shadowWord("latte", score: 2.0),
        ])])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.map(\.id), ["latte"])
    }

    func testR3FunctionWordLowScoreStillCollected() {
        // 功能词只过滤「漏读」；读得差（<3.5）仍进列表
        let s = session([assistant("I want the latte.", attempts: [attempt(words: [
            shadowWord("the", score: 2.0),
        ])])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.map(\.id), ["the"])
        XCTAssertTrue(ex.candidates[0].defaultChecked)
    }

    // MARK: - R4 / R5 / R6 / R7

    func testR4MissedPlusLowIsChecked() {
        let s = session([assistant("Try the croissant.", attempts: [
            attempt(words: [shadowWord("croissant", score: 2.0)]),
            attempt(words: [shadowWord("croissant", dp: 16)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.count, 1)
        let c = ex.candidates[0]
        XCTAssertEqual(c.reasons, [.low, .missed])
        XCTAssertEqual(c.missedCount, 1)
        XCTAssertEqual(c.occurrences, 2)
        XCTAssertTrue(c.defaultChecked)
    }

    func testR5MissedTwiceIsChecked() {
        let s = session([assistant("Try the croissant.", attempts: [
            attempt(words: [shadowWord("croissant", dp: 16)]),
            attempt(words: [shadowWord("croissant", dp: 16)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        let c = ex.candidates[0]
        XCTAssertNil(c.latestScore)  // 纯漏读：没有「读到」的分数
        XCTAssertEqual(c.missedCount, 2)
        XCTAssertTrue(c.defaultChecked)
    }

    func testR6PureMissedOnceUnchecked() {
        let s = session([assistant("Try the croissant.", attempts: [
            attempt(words: [shadowWord("croissant", dp: 16)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        let c = ex.candidates[0]
        XCTAssertNil(c.latestScore)
        XCTAssertEqual(c.reasons, [.missed])
        XCTAssertFalse(c.defaultChecked)  // 仍展示，由用户决定
    }

    func testR7BorderlineScoreUnchecked() {
        let s = session([assistant("Try the croissant.", attempts: [
            attempt(words: [shadowWord("croissant", score: 3.6)]),
        ])])
        let ex = extractSpeakVocab(s, now: 1000)
        let c = ex.candidates[0]
        XCTAssertEqual(c.latestScore ?? -1, 3.6, accuracy: 0.001)
        XCTAssertFalse(c.defaultChecked)
    }

    // MARK: - R8 封顶折叠

    func testR8CapsAtEightAndFoldsRest() {
        let words = (0..<11).map { shadowWord("w\($0)", score: 2.0) }
        let s = session([assistant("Many words.", attempts: [attempt(words: words)])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.count, 8)
        XCTAssertEqual(ex.folded.count, 3)
        // 折叠的是排序更靠后的
        XCTAssertTrue(Set(ex.candidates.map(\.id)).isDisjoint(with: ex.folded.map(\.id)))
    }

    // MARK: - 跟丢护栏

    func testMissedGuardLowIntegrity() {
        // 完整度 2.0 < 2.5：整句跟丢，漏读词不可信；读到低分的词照收
        let s = session([assistant("Try the croissant.", attempts: [attempt(integrity: 2.0, words: [
            shadowWord("croissant", dp: 16),
            shadowWord("latte", score: 2.0),
        ])])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.map(\.id), ["latte"])
    }

    func testMissedGuardTooManyMissedInOneAttempt() {
        // 单次跟读漏读词 > 4：视为跟丢整句
        let words = (0..<5).map { shadowWord("w\($0)", dp: 16) }
        let s = session([assistant("Missed many.", attempts: [attempt(integrity: 4.5, words: words)])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertTrue(ex.candidates.isEmpty)
    }

    func testAttemptMissedUsableBoundaries() {
        XCTAssertTrue(attemptMissedUsable(attempt(integrity: 2.5, words: [shadowWord("a", dp: 16)])))
        XCTAssertFalse(attemptMissedUsable(attempt(integrity: 2.4, words: [shadowWord("a", dp: 16)])))
        XCTAssertFalse(attemptMissedUsable(
            attempt(integrity: 5, words: (0..<5).map { shadowWord("w\($0)", dp: 16) })
        ))
        XCTAssertTrue(attemptMissedUsable(attempt(integrity: 5, words: [])))
    }

    // MARK: - dpMessage 语义

    func testInsertedWordSkippedAndSubstitutedTagged() {
        let s = session([assistant("I like espresso.", attempts: [attempt(words: [
            shadowWord("espresso", score: 2.2, dp: 128),   // 读成别的词：替换
            shadowWord("americano", score: 5, dp: 32),     // 增读：原文没有，不参与
        ])])])
        let ex = extractSpeakVocab(s, now: 1000)
        XCTAssertEqual(ex.candidates.map(\.id), ["espresso"])
        let c = ex.candidates[0]
        XCTAssertEqual(c.reasons, [.low, .substituted])
        XCTAssertTrue(c.defaultChecked)
    }

    func testDuplicateInOneAttemptTakesWorstScore() {
        let s = session([assistant("That that works.", attempts: [attempt(words: [
            shadowWord("that", score: 3.0),
            shadowWord("that", score: 4.0),
        ])])])
        let ex = extractSpeakVocab(s, now: 1000)
        let c = ex.candidates[0]
        XCTAssertEqual(c.latestScore ?? -1, 3.0, accuracy: 0.001)  // 同 attempt 取最差
        XCTAssertEqual(c.occurrences, 1)                            // occurrences 按 attempt 去重
    }

    func testNumericWordsFiltered() {
        let s = session([assistant("Two coffees.", attempts: [attempt(words: [
            shadowWord("2", score: 1.0),
            shadowWord("coffees", score: 2.0),
        ])])])
        XCTAssertEqual(extractSpeakVocab(s, now: 1000).candidates.map(\.id), ["coffees"])
    }

    // MARK: - 已在生词本 / 唤醒

    func testExistingWordSortedLastAndWakeOnDue() {
        let now: Int64 = 1_000_000_000
        let s = session([assistant("Latte or mocha?", attempts: [attempt(words: [
            shadowWord("latte", score: 2.0),
            shadowWord("mocha", score: 2.0),
        ])])])
        let existing = VocabWord(
            id: "latte", word: "latte",
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(ease: 2.5, intervalDays: 3, reps: 2, dueAt: now - 100, lapses: 0),
            addedAt: now - 5 * 86_400_000
        )
        let ex = extractSpeakVocab(s, vocabWords: [existing], now: now)
        XCTAssertEqual(ex.candidates.count, 2)
        XCTAssertEqual(ex.candidates.first?.id, "mocha")   // 新词排前
        let latte = ex.candidates[1]
        XCTAssertEqual(latte.id, "latte")                  // 已收藏排最后
        XCTAssertNotNil(latte.existing)
        XCTAssertTrue(latte.wake)                          // 已到期该复习
        XCTAssertNil(ex.candidates[0].existing)
    }

    func testWakeOnRecentWrongRecallEvenIfNotDue() {
        let now: Int64 = 1_000_000_000
        let s = session([assistant("Try the mocha.", attempts: [attempt(words: [
            shadowWord("mocha", score: 2.0),
        ])])])
        let existing = VocabWord(
            id: "mocha", word: "mocha",
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(ease: 2.5, intervalDays: 3, reps: 2, dueAt: now + 86_400_000, lapses: 0),
            addedAt: now - 10 * 86_400_000,
            recall: RecallStat(total: RecallModeStat(pass: 1, wrong: 2, trap: 0))
        )
        let ex = extractSpeakVocab(s, vocabWords: [existing], now: now)
        XCTAssertTrue(ex.candidates[0].wake)  // 复习 2 次未过
        XCTAssertEqual(ex.candidates[0].reasons, [.low])
    }

    // MARK: - 词条转换

    func testSpeakCandidateToVocabBareWord() {
        let c = SpeakVocabCandidate(
            id: "latte", word: "latte", latestScore: 2.4, reasons: [.low],
            missedCount: 0, occurrences: 1,
            example: VocabExample(en: "Try the latte.", zh: "尝尝拿铁"),
            defaultChecked: true, order: 0
        )
        let now: Int64 = 5_000
        let w = speakCandidateToVocab(c, entry: nil, now: now)
        XCTAssertEqual(w.id, "latte")
        XCTAssertEqual(w.word, "latte")
        XCTAssertEqual(w.effectiveKind, .word)
        XCTAssertEqual(w.source.articleId, "")  // 无文章来源
        XCTAssertEqual(w.srs.dueAt, now)        // 当天可复习
        XCTAssertEqual(w.addedAt, now)
        XCTAssertEqual(w.example?.en, "Try the latte.")
        XCTAssertTrue(w.senses.isEmpty)
    }

    func testSpeakCandidateToVocabWithDictEntry() {
        let c = SpeakVocabCandidate(
            id: "latte", word: "latte", latestScore: 2.4, reasons: [.low],
            missedCount: 0, occurrences: 1,
            example: VocabExample(en: "Try the latte."),
            defaultChecked: true, order: 0
        )
        let entry = ReaderDictEntry(
            word: "latte", phonetic: "/ˈlɑːteɪ/",
            senses: [VocabSense(pos: "n.", cn: "拿铁咖啡")],
            collocations: nil, forms: nil, chunkType: nil, pattern: nil, trap: nil
        )
        let w = speakCandidateToVocab(c, entry: entry, now: 5_000)
        XCTAssertEqual(w.word, "latte")
        XCTAssertEqual(w.phonetic, "/ˈlɑːteɪ/")
        XCTAssertEqual(w.senses, [VocabSense(pos: "n.", cn: "拿铁咖啡")])
    }

    // MARK: - 落盘结构（对齐 contracts speakShadowAttempt / Windows speak_store.rs）

    func testShadowAttemptCodableRoundtripCamelCase() throws {
        let turn = SpeakTurn(
            role: .assistant, text: "Sure thing.", hintZh: "好的",
            shadowScore: 4.1,
            shadowAttempts: [ShadowAttempt(
                at: 4, total: 4.1, accuracy: 4.3, fluency: 3.4, integrity: 4.6,
                words: [
                    ShadowWord(content: "latte", totalScore: 2.4, dpMessage: 0, sylls: [
                        ShadowSyll(content: "l aa t ey", syllScore: 2.1, serrMsg: 0, phones: [
                            ShadowPhone(content: "l", dpMessage: 0, gwpp: -0.01),
                            ShadowPhone(content: "aa", dpMessage: 0, gwpp: -1.9),
                        ]),
                    ]),
                    ShadowWord(content: "else", totalScore: 0, dpMessage: 16),
                ]
            )],
            at: 3
        )
        let data = try JSONEncoder().encode(turn)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"shadowAttempts\""))
        XCTAssertTrue(json.contains("\"totalScore\""))
        XCTAssertTrue(json.contains("\"dpMessage\""))
        XCTAssertTrue(json.contains("\"integrity\""))
        XCTAssertTrue(json.contains("\"gwpp\""))
        let back = try JSONDecoder().decode(SpeakTurn.self, from: data)
        XCTAssertEqual(back, turn)
    }

    func testLegacyTurnAndWindowsShapedJsonDecode() throws {
        // 旧数据（无 shadowAttempts / shadowScore / hintZh）照常加载
        let legacy = try JSONDecoder().decode(
            SpeakTurn.self, from: Data(#"{"role":"user","text":"hi","at":0}"#.utf8)
        )
        XCTAssertNil(legacy.shadowAttempts)
        XCTAssertNil(legacy.shadowScore)
        XCTAssertNil(legacy.hintZh)

        // Windows 侧同构 JSON（camelCase；serde default 缺省字段）可互相加载
        let win = #"{"role":"assistant","text":"Sure.","at":3,"shadowAttempts":[{"at":4,"total":4.1,"accuracy":4.3,"fluency":3.4,"integrity":4.6,"words":[{"content":"latte","totalScore":2.4,"dpMessage":0,"sylls":[]}]}]}"#
        let t = try JSONDecoder().decode(SpeakTurn.self, from: Data(win.utf8))
        XCTAssertEqual(t.shadowAttempts?.first?.words.first?.content, "latte")
        XCTAssertEqual(t.shadowAttempts?.first?.integrity ?? 0, 4.6, accuracy: 0.001)
        // 缺省字段（dp/gwpp/sylls）解码为默认值
        XCTAssertEqual(t.shadowAttempts?.first?.words.first?.dpMessage, 0)
    }

    func testSessionFileSchemaVersionStaysOne() throws {
        // 会话落盘 schemaVersion 维持 1：新字段走可选解码，老文件不需要升级
        let file = SpeakSessionsFile(sessions: [session([
            assistant("Hi.", attempts: [attempt(words: [shadowWord("hi", score: 2)])]),
        ])])
        let data = try JSONEncoder().encode(file)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"schemaVersion\":1"))
        let back = try JSONDecoder().decode(SpeakSessionsFile.self, from: data)
        XCTAssertEqual(back, file)
    }
}
