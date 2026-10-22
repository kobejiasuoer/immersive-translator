import XCTest
@testable import ReaderCore

/// v0.8 Phase 4「Markdown 笔记导出」纯函数向量（对齐
/// immersive-translator-windows/src/core/vaultExport.ts:112-164 与其测试语义）。
/// 红线复验：三段全部来自入参（真实存储形状），空段整段省略不产空标题。
final class VaultExportTests: XCTestCase {
    // Windows readerSrs.test 的同一时刻：2026-09-10 本地 10:00。
    private var nowMs: Int64 {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 9
        comps.day = 10
        comps.hour = 10
        let date = Calendar.current.date(from: comps) ?? Date()
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    private func makeWord(
        _ id: String,
        dueAt: Int64,
        interval: Double,
        spokenAt: Int64? = nil
    ) -> VocabWord {
        VocabWord(
            id: id,
            word: id,
            senses: [],
            source: VocabSource(articleId: "a1", sentenceIdx: 0),
            srs: VocabSrsState(intervalDays: interval, dueAt: dueAt),
            addedAt: 0,
            spokenAt: spokenAt
        )
    }

    private func speakSession(_ turns: [SpeakTurn]) -> SpeakSession {
        SpeakSession(
            id: "s-\(UUID().uuidString)",
            scenario: .smalltalk,
            difficulty: .medium,
            turns: turns,
            createdAt: nowMs,
            updatedAt: nowMs
        )
    }

    private func pronAttempt(_ words: [ShadowWord]) -> ShadowAttempt {
        ShadowAttempt(at: nowMs, total: 3, accuracy: 3, fluency: 3, integrity: 5, words: words)
    }

    private func shadowWord(
        _ content: String,
        score: Double,
        dpMessage: Int = 0,
        phones: [(String, Double)] = []
    ) -> ShadowWord {
        ShadowWord(
            content: content,
            totalScore: score,
            dpMessage: dpMessage,
            sylls: [ShadowSyll(
                content: content,
                syllScore: score,
                serrMsg: 0,
                phones: phones.map { ShadowPhone(content: $0.0, dpMessage: 0, gwpp: $0.1) }
            )]
        )
    }

    // MARK: 一、核心词块

    func testWordSectionCarriesPhoneticGlossBadgeItalicPatternTrap() {
        let word = VocabWord(
            id: "resilient",
            word: "resilient",
            phonetic: "/rɪˈzɪliənt/",
            senses: [VocabSense(pos: "adj.", cn: "有弹性的；恢复快的")],
            pattern: "re- 回 + sil 跳 + -ient 形",
            trap: "不是『顽固』",
            source: VocabSource(articleId: "art-1", sentenceIdx: 2),
            srs: VocabSrsState(intervalDays: 0, dueAt: nowMs),
            addedAt: nowMs
        )
        let markdown = buildVaultMarkdown(
            words: [word],
            sourceSentence: { articleId, idx in
                (articleId, idx) == ("art-1", 2)
                    ? (en: "This material shows remarkable resilience.", zh: nil)
                    : nil
            },
            speakSessions: [],
            dateKey: "2026-09-10"
        )
        // 词条行：词 + 去斜杠音标 + 义项 + 三阶徽标（intervalDays 0 → s1）。
        XCTAssertTrue(markdown.contains("1. **resilient** `rɪˈzɪliənt` — adj. 有弹性的；恢复快的 [🌱 刚收集]"))
        // 原句定位不到词块原文（resilience ≠ resilient 精确/弹性匹配都不中）→ 原样返回，不伪造斜体。
        XCTAssertTrue(markdown.contains("   - **原句**：This material shows remarkable resilience."))
        XCTAssertTrue(markdown.contains("   - **记法**：re- 回 + sil 跳 + -ient 形"))
        XCTAssertTrue(markdown.contains("   - **直译陷阱**：不是『顽固』"))
        // 只有词块一段有数据：其余两段整段省略。
        XCTAssertTrue(markdown.hasPrefix("# 2026-09-10 英语精读与口语内化笔记"))
        XCTAssertTrue(markdown.contains("## 一、核心词块（带原句与用法提示）"))
        XCTAssertFalse(markdown.contains("## 二、"))
        XCTAssertFalse(markdown.contains("## 三、"))
    }

    func testSourceSentenceItalicizesTargetAndSpokenWordUsesS3Badge() {
        let spoken = makeWord("unwind", dueAt: nowMs, interval: 0, spokenAt: nowMs - 1000)
        let markdown = buildVaultMarkdown(
            words: [spoken],
            sourceSentence: { _, _ in (en: "She wanted to unwind after work.", zh: nil) },
            speakSessions: [],
            dateKey: "2026-09-10"
        )
        // spokenAt 存在 → s3 徽标（「在对话中说出」优先于间隔）。
        XCTAssertTrue(markdown.contains("[✨ 已变成口语表达]"))
        // 原句中目标词以斜体强调（findChunkRange 命中 → *unwind*）。
        XCTAssertTrue(markdown.contains("**原句**：She wanted to *unwind* after work."))
    }

    func testPopupWordFallsBackToOwnExampleSentence() {
        let word = VocabWord(
            id: "spice",
            word: "spice",
            senses: [VocabSense(pos: "n.", cn: "香料")],
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(intervalDays: 1, dueAt: nowMs),
            addedAt: nowMs,
            example: VocabExample(en: "Add a little spice to the soup.", zh: "给汤加点香料。")
        )
        let markdown = buildVaultMarkdown(
            words: [word],
            sourceSentence: { _, _ in nil },
            speakSessions: [],
            dateKey: "2026-09-10"
        )
        XCTAssertTrue(markdown.contains("**原句**：Add a little *spice* to the soup."))
        XCTAssertTrue(markdown.contains("[👀 眼熟能认]"))
    }

    func testArticleWordFallsBackToExampleWhenSourceMissing() {
        // vaultExport.ts:123-125 输入契约：articleId 非空但原文通道取不到
        //（文章被删）→ 回退词条自带例句，不整行丢弃「原句」。
        let word = VocabWord(
            id: "unwind",
            word: "unwind",
            senses: [VocabSense(pos: "v.", cn: "放松")],
            source: VocabSource(articleId: "deleted-article", sentenceIdx: 3),
            srs: VocabSrsState(intervalDays: 0, dueAt: nowMs),
            addedAt: nowMs,
            example: VocabExample(en: "I unwind by reading.", zh: nil)
        )
        let markdown = buildVaultMarkdown(
            words: [word],
            sourceSentence: { _, _ in nil }, // 原文通道取不到（文章不存在）
            speakSessions: [],
            dateKey: "2026-09-10"
        )
        XCTAssertTrue(markdown.contains("**原句**：I *unwind* by reading."))
    }

    // MARK: 二、口语地道表达升级

    func testCoachDiffSectionBuildsBeforeAfterWithInsertionsAndNote() {
        let turn = SpeakTurn(
            role: .user,
            text: "I very like this movie",
            coachDiff: CoachDiff(
                segs: [
                    CoachSeg(t: .keep, v: "I"),
                    CoachSeg(t: .del, v: "very"),
                    CoachSeg(t: .ins, v: "really"),
                    CoachSeg(t: .keep, v: "like this movie"),
                ],
                note: "very 不能修饰动词，用 really。"
            ),
            at: nowMs
        )
        let markdown = buildVaultMarkdown(
            words: [],
            sourceSentence: { _, _ in nil },
            speakSessions: [speakSession([turn])],
            dateKey: "2026-09-10"
        )
        XCTAssertTrue(markdown.contains("## 二、口语地道表达升级（Before → After）"))
        XCTAssertTrue(markdown.contains("- ❌ **我的原话**：I very like this movie"))
        // better = keep + ins 按序拼回（del 剔除）。
        XCTAssertTrue(markdown.contains("- ✅ **地道改写**：**I really like this movie**"))
        // ins 片段单独成「值得记的新说法」。
        XCTAssertTrue(markdown.contains("  - **值得记的新说法**：really"))
        XCTAssertTrue(markdown.contains("  - **点评**：very 不能修饰动词，用 really。"))
        XCTAssertFalse(markdown.contains("## 一、"))
        XCTAssertFalse(markdown.contains("## 三、"))
    }

    func testCoachDiffWithoutBetterTextIsSkipped() {
        // 只有 del 片段 → 改写全文为空 → 整段省略（不产空标题）。
        let turn = SpeakTurn(
            role: .user,
            text: "umm",
            coachDiff: CoachDiff(segs: [CoachSeg(t: .del, v: "umm")]),
            at: nowMs
        )
        let markdown = buildVaultMarkdown(
            words: [],
            sourceSentence: { _, _ in nil },
            speakSessions: [speakSession([turn])],
            dateKey: "2026-09-10"
        )
        XCTAssertFalse(markdown.contains("## 二、"))
    }

    func testAssistantTurnsAndSessionsWithoutCoachDiffDoNotEmitSection() {
        let turns = [
            SpeakTurn(role: .assistant, text: "Hello!", at: nowMs),
            SpeakTurn(role: .user, text: "Hi there.", at: nowMs + 1),
        ]
        let markdown = buildVaultMarkdown(
            words: [],
            sourceSentence: { _, _ in nil },
            speakSessions: [speakSession(turns)],
            dateKey: "2026-09-10"
        )
        XCTAssertFalse(markdown.contains("## 二、"))
    }

    // MARK: 三、发音重点复盘

    func testLowPronWordsFilterMissedInsertedHighScoreAndDedupeKeepsLowest() {
        let sessions = [
            speakSession([
                SpeakTurn(
                    role: .user,
                    text: "I thought about it",
                    pron: pronAttempt([
                        shadowWord("thought", score: 2.4, phones: [("th", -1.1)]),
                        shadowWord("about", score: 0.9, dpMessage: 16),   // 漏读：不计
                        shadowWord("it", score: 0.8, dpMessage: 32),      // 增读：不计
                        shadowWord("I", score: 3.0),                       // 恰好 3 分：不计（<3 才收）
                    ]),
                    at: nowMs
                ),
            ]),
            speakSession([
                SpeakTurn(
                    role: .user,
                    text: "thought again",
                    pron: pronAttempt([
                        shadowWord("thought", score: 1.8, phones: [("th", -0.9)]), // 同词更低分：保留这条
                        shadowWord("again", score: 2.9),
                    ]),
                    at: nowMs + 1
                ),
            ]),
        ]
        let lows = vaultLowPronWords(sessions)
        XCTAssertEqual(lows.map(\.word), ["thought", "again"])
        XCTAssertEqual(lows[0].score, 1.8, accuracy: 0.001)
        // 舌位建议来自最低分那次评测的最差音素（gwpp -0.9 ≤ -0.4 → th）。
        XCTAssertEqual(lows[0].tip, "清音 th：舌尖轻放在上下齿之间送气，不是『斯』")
        // again 没有音素明细 → 无明显出错音素 → 空建议。
        XCTAssertEqual(lows[1].tip, "")
    }

    func testLowPronWordsCapAtEightAscendingByScore() {
        let words = (0..<10).map { index in
            shadowWord("w\(index)", score: 0.5 + Double(index) * 0.2)
        }
        let lows = vaultLowPronWords([speakSession([
            SpeakTurn(role: .user, text: "x", pron: pronAttempt(words), at: nowMs)
        ])])
        XCTAssertEqual(lows.count, 8)
        XCTAssertEqual(lows.map(\.word), ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"])
    }

    func testLowPronWordsTieBreaksByFirstSeenOrder() {
        // Windows Map 保持插入序：同分词按首见顺序排。9 个低分词中最后两个
        // 同分（1.2），恰在第 8 名边界——应取首见靠前的 wX，截掉 wY。
        let words = (0..<7).map { index in
            shadowWord("w\(index)", score: 0.5 + Double(index) * 0.1)
        } + [shadowWord("wX", score: 1.2), shadowWord("wY", score: 1.2)]
        let lows = vaultLowPronWords([speakSession([
            SpeakTurn(role: .user, text: "x", pron: pronAttempt(words), at: nowMs)
        ])])
        XCTAssertEqual(lows.count, 8)
        XCTAssertEqual(lows[7].word, "wX")
        XCTAssertFalse(lows.map(\.word).contains("wY"))
        // 两个同分词都进榜单时，顺序也按首见（wP 在 wQ 前）。
        let tied = [shadowWord("wP", score: 2.0), shadowWord("wQ", score: 2.0), shadowWord("wLow", score: 1.0)]
        let lows2 = vaultLowPronWords([speakSession([
            SpeakTurn(role: .user, text: "x", pron: pronAttempt(tied), at: nowMs)
        ])])
        XCTAssertEqual(lows2.map(\.word), ["wLow", "wP", "wQ"])
    }

    func testPronSectionLinesFormat() {
        let sessions = [speakSession([
            SpeakTurn(
                role: .user,
                text: "thought",
                pron: pronAttempt([shadowWord("thought", score: 1.75, phones: [("th", -1.0)])]),
                at: nowMs
            ),
        ])]
        let markdown = buildVaultMarkdown(
            words: [],
            sourceSentence: { _, _ in nil },
            speakSessions: sessions,
            dateKey: "2026-09-10"
        )
        XCTAssertTrue(markdown.contains("## 三、发音重点复盘"))
        XCTAssertTrue(markdown.contains("- **thought**（最低 1.8 分）：清音 th：舌尖轻放在上下齿之间送气，不是『斯』"))
    }

    // MARK: 空输入 + 整体形状

    func testEmptyInputsProduceTitleAndFooterOnly() {
        let markdown = buildVaultMarkdown(
            words: [],
            sourceSentence: { _, _ in nil },
            speakSessions: [],
            dateKey: "2026-09-10"
        )
        XCTAssertEqual(
            markdown,
            "# 2026-09-10 英语精读与口语内化笔记\n\n> 自动汇总自阅读查词、口语表达改进与发音诊断，可直接复制进 Notion / Obsidian。"
        )
    }

    func testAllSectionsTogetherKeepOrderAndFooter() {
        let word = makeWord("fresh", dueAt: nowMs, interval: 0)
        let coached = SpeakTurn(
            role: .user,
            text: "I very like it",
            coachDiff: CoachDiff(segs: [
                CoachSeg(t: .keep, v: "I"),
                CoachSeg(t: .ins, v: "really"),
                CoachSeg(t: .keep, v: "like it"),
            ]),
            at: nowMs
        )
        let pron = SpeakTurn(
            role: .user,
            text: "thought",
            pron: pronAttempt([shadowWord("thought", score: 1.2, phones: [("th", -1.2)])]),
            at: nowMs + 1
        )
        let markdown = buildVaultMarkdown(
            words: [word],
            sourceSentence: { _, _ in nil },
            speakSessions: [speakSession([coached, pron])],
            dateKey: "2026-09-10"
        )
        let titleRange = markdown.range(of: "# 2026-09-10")
        let section1 = markdown.range(of: "## 一、核心词块")
        let section2 = markdown.range(of: "## 二、口语地道表达升级")
        let section3 = markdown.range(of: "## 三、发音重点复盘")
        let footer = markdown.range(of: "> 自动汇总自")
        XCTAssertNotNil(titleRange)
        XCTAssertNotNil(section1)
        XCTAssertNotNil(section2)
        XCTAssertNotNil(section3)
        XCTAssertNotNil(footer)
        XCTAssertLessThan(titleRange!.lowerBound, section1!.lowerBound)
        XCTAssertLessThan(section1!.lowerBound, section2!.lowerBound)
        XCTAssertLessThan(section2!.lowerBound, section3!.lowerBound)
        XCTAssertLessThan(section3!.lowerBound, footer!.lowerBound)
        XCTAssertFalse(markdown.hasSuffix("\n"))
    }
}

/// v0.8 内化看板派生（masteryStage / masteryStageCounts / heatBuckets / weakVocab）。
/// 向量对齐 immersive-translator-windows/src/core/readerSrs.test.ts:163-213。
final class InternalizationDashboardTests: XCTestCase {
    /// 与 Windows 测试同一时刻：2026-09-10 本地 10:00（heatBuckets 首格应为 2026-08-14）。
    private var nowMs: Int64 {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 9
        comps.day = 10
        comps.hour = 10
        let date = Calendar.current.date(from: comps) ?? Date()
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    private func makeWord(_ id: String, interval: Double, spokenAt: Int64? = nil) -> VocabWord {
        VocabWord(
            id: id,
            word: id,
            senses: [],
            source: VocabSource(articleId: "a1", sentenceIdx: 0),
            srs: VocabSrsState(intervalDays: interval, dueAt: nowMs),
            addedAt: 0,
            spokenAt: spokenAt
        )
    }

    // MARK: masteryStage（readerSrs.test:163-177）

    func testMasteryStageS1S2ByInterval() {
        XCTAssertEqual(masteryStage(makeWord("fresh", interval: 0)), .s1)
        XCTAssertEqual(masteryStage(makeWord("familiar", interval: 1)), .s2)
        XCTAssertEqual(masteryStage(makeWord("mastered", interval: 7)), .s2)
    }

    func testMasteryStageSpokenAtWinsOverInterval() {
        // 新词当天就在口语里用出：s1 → s3，不被 intervalDays<1 压住。
        XCTAssertEqual(masteryStage(makeWord("spoken-fresh", interval: 0, spokenAt: nowMs - 1000)), .s3)
        // 熟词用出：s2 → s3。
        XCTAssertEqual(masteryStage(makeWord("spoken-fam", interval: 7, spokenAt: nowMs - 1000)), .s3)
    }

    func testMasteryStageCountsAggregateAllStages() {
        let counts = masteryStageCounts([
            makeWord("a", interval: 0),
            makeWord("b", interval: 0),
            makeWord("c", interval: 3),
            makeWord("d", interval: 7, spokenAt: nowMs),
        ])
        XCTAssertEqual(counts.s1, 2)
        XCTAssertEqual(counts.s2, 1)
        XCTAssertEqual(counts.s3, 1)
        XCTAssertEqual(counts[.s1], 2)
        XCTAssertEqual(counts[.s2], 1)
        XCTAssertEqual(counts[.s3], 1)
    }

    // MARK: heatBuckets（readerSrs.test:180-213）

    func testHeatBucketsWindow28DaysOldToNewTodayMarked() {
        let buckets = heatBuckets(ReviewLogFile(schemaVersion: 1, days: []), nowMs: nowMs)
        XCTAssertEqual(buckets.count, 28)
        XCTAssertEqual(buckets[27].dayKey, dayKey(nowMs: nowMs))
        XCTAssertTrue(buckets[27].isToday)
        XCTAssertEqual(buckets.filter(\.isToday).count, 1)
        // 首格 = 今天往前 27 天（跨月也按本地日期键推进）。
        XCTAssertEqual(buckets[0].dayKey, "2026-08-14")
        XCTAssertFalse(buckets[0].isToday)
    }

    func testHeatBucketsLevels0To3AndOutsideWindowIgnored() {
        let today = dayKey(nowMs: nowMs)
        let log = ReviewLogFile(schemaVersion: 1, days: [
            ReviewLogDay(day: today, count: 1),        // l1
            ReviewLogDay(day: "2026-09-09", count: 3), // l2
            ReviewLogDay(day: "2026-09-08", count: 6), // l2（6 次仍在 3-6 档）
            ReviewLogDay(day: "2026-09-07", count: 7), // l3
            ReviewLogDay(day: "2026-01-01", count: 9), // 窗口外不计
        ])
        let buckets = heatBuckets(log, nowMs: nowMs)
        let todayBucket = buckets.first { $0.dayKey == today }
        XCTAssertNotNil(todayBucket)
        XCTAssertEqual(todayBucket?.level, 1)
        XCTAssertEqual(todayBucket?.count, 1)
        XCTAssertEqual(buckets.first { $0.dayKey == "2026-09-09" }?.level, 2)
        XCTAssertEqual(buckets.first { $0.dayKey == "2026-09-08" }?.level, 2)
        let l3 = buckets.first { $0.dayKey == "2026-09-07" }
        XCTAssertEqual(l3?.level, 3)
        XCTAssertEqual(l3?.count, 7)
        // 没有记录的天是 level 0，窗口外的天不出现在窗口里。
        XCTAssertNil(buckets.first { $0.dayKey == "2026-01-01" })
        XCTAssertEqual(buckets.filter { $0.level == 0 }.count, 28 - 4)
        XCTAssertEqual(heatLevel(count: 0), 0)
        XCTAssertEqual(heatLevel(count: 2), 1)
        XCTAssertEqual(heatLevel(count: 3), 2)
        XCTAssertEqual(heatLevel(count: 6), 2)
        XCTAssertEqual(heatLevel(count: 7), 3)
    }

    // MARK: weakVocab（看板「易错项靶向加练」）

    private func wordWithMistakes(
        _ id: String,
        wrong: Int = 0,
        trap: Int = 0
    ) -> VocabWord {
        var word = makeWord(id, interval: 1)
        word.recall = RecallStat(total: RecallModeStat(wrong: wrong, trap: trap))
        return word
    }

    func testWeakVocabTop3ByWrongPlusTrapDescending() {
        let vocab = [
            wordWithMistakes("none"),
            wordWithMistakes("low", wrong: 1),
            wordWithMistakes("mid", wrong: 2, trap: 1),
            wordWithMistakes("high", wrong: 4),
            wordWithMistakes("tie-a", trap: 2),
            wordWithMistakes("tie-b", trap: 2),
        ]
        let weak = weakVocab(vocab, limit: 3)
        XCTAssertEqual(weak.map(\.word.word), ["high", "mid", "tie-a"])
        XCTAssertEqual(weak.map(\.bad), [4, 3, 2])
        // 无错题时给空数组（看板渲染空态）。
        XCTAssertTrue(weakVocab([wordWithMistakes("none")]).isEmpty)
    }

    // MARK: 老 JSON 无 spokenAt 可正常解码（契约：新增字段必须 Optional）

    func testLegacyVocabJSONWithoutSpokenAtDecodesToNil() throws {
        let legacy = """
        {
          "id": "legacy",
          "word": "legacy",
          "senses": [],
          "source": { "articleId": "a1", "sentenceIdx": 0 },
          "srs": { "ease": 2.5, "intervalDays": 2, "reps": 1, "dueAt": 1770000000000, "lapses": 0 },
          "addedAt": 1760000000000
        }
        """
        let word = try JSONDecoder().decode(VocabWord.self, from: Data(legacy.utf8))
        XCTAssertNil(word.spokenAt)
        XCTAssertEqual(masteryStage(word), .s2)
        // 写入 spokenAt 后往返仍在（重启仍在的编解码面）。
        var spoken = word
        spoken.spokenAt = 1770000001000
        let data = try JSONEncoder().encode(spoken)
        let round = try JSONDecoder().decode(VocabWord.self, from: data)
        XCTAssertEqual(round.spokenAt, 1770000001000)
        XCTAssertEqual(masteryStage(round), .s3)
    }
}
