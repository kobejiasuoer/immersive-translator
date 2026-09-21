import XCTest
@testable import ReaderCore

/// 学词笔记（P2）：recall 统计 / 材料组装 / 防幻觉校验 / 笔记解析 / frontmatter。

final class NoteTests: XCTestCase {
    private func makeWord(
        _ word: String,
        kind: VocabKind? = nil,
        intervalDays: Double = 0,
        articleId: String = "a1",
        sentenceIdx: Int = 0,
        example: VocabExample? = nil,
        recall: RecallStat? = nil,
        trap: String? = nil
    ) -> VocabWord {
        VocabWord(
            id: normalizeWordKey(word),
            word: word,
            kind: kind,
            senses: [VocabSense(pos: "n.", cn: "测试")],
            trap: trap,
            source: VocabSource(articleId: articleId, sentenceIdx: sentenceIdx),
            srs: VocabSrsState(ease: 2.5, intervalDays: intervalDays, reps: 2, dueAt: 0, lapses: 1),
            addedAt: 1,
            example: example,
            recall: recall
        )
    }

    // MARK: - 错题分桶与累计

    func testRecallBucket() {
        XCTAssertEqual(recallBucket(mode: .cloze, judged: .trap, grade: .hard), .trap)
        XCTAssertEqual(recallBucket(mode: .cloze, judged: .perfect, grade: .forgot), .pass)
        XCTAssertEqual(recallBucket(mode: .dictation, judged: .close, grade: .good), .pass)
        XCTAssertEqual(recallBucket(mode: .dictation, judged: .wrong, grade: .good), .wrong)
        // 识别卡无判分：按评分归桶
        XCTAssertEqual(recallBucket(mode: .recognition, judged: nil, grade: .forgot), .wrong)
        XCTAssertEqual(recallBucket(mode: .recognition, judged: nil, grade: .easy), .pass)
    }

    func testRecordRecallStatAccumulates() {
        var stat = recordRecallStat(nil, mode: .cloze, bucket: .wrong, nowMs: 100)
        stat = recordRecallStat(stat, mode: .cloze, bucket: .trap, nowMs: 200)
        stat = recordRecallStat(stat, mode: .dictation, bucket: .pass, nowMs: 300)
        XCTAssertEqual(stat.total, RecallModeStat(pass: 1, wrong: 1, trap: 1))
        XCTAssertEqual(stat.byMode["cloze"], RecallModeStat(pass: 0, wrong: 1, trap: 1))
        XCTAssertEqual(stat.byMode["dictation"], RecallModeStat(pass: 1, wrong: 0, trap: 0))
        XCTAssertEqual(stat.lastAt, 300)
    }

    func testIsStillWeak() {
        // 从没测过 → 仍错
        XCTAssertTrue(isStillWeak(makeWord("alpha")))
        // 错+陷阱 > 过 → 仍错
        var w = makeWord("beta")
        w.recall = RecallStat(total: RecallModeStat(pass: 1, wrong: 2, trap: 0), byMode: [:], lastAt: 1)
        XCTAssertTrue(isStillWeak(w))
        // 错+陷阱 ≤ 过 → 不算
        w.recall = RecallStat(total: RecallModeStat(pass: 3, wrong: 1, trap: 1), byMode: [:], lastAt: 1)
        XCTAssertFalse(isStillWeak(w))
    }

    func testDefaultNoteSelectionOnlyUnmastered() {
        let words = [
            makeWord("a", intervalDays: 1),
            makeWord("b", intervalDays: 7),
            makeWord("c", intervalDays: 30),
        ]
        XCTAssertEqual(defaultNoteSelection(words), [normalizeWordKey("a")])
    }

    // MARK: - 材料组装

    func testBuildNoteMaterialsPrefersArticleSentence() {
        var sentence = SentencePair(idx: 0, paragraphIdx: 0, en: "Article origin sentence.")
        sentence.chunks = [SentenceChunk(text: "look up", chunkType: .phrasal, gloss: "查阅")]
        let article = Article(
            id: "a1", title: "T", wordCount: 10, createdAt: 1, lastReadAt: 1,
            sentences: [sentence]
        )
        var word = makeWord("alpha", example: VocabExample(en: "LLM example.", zh: "例句"))
        word.recall = RecallStat(total: RecallModeStat(pass: 1, wrong: 0, trap: 0), byMode: ["recognition": RecallModeStat(pass: 1)], lastAt: 5)

        let materials = buildNoteMaterials([word], articlesById: ["a1": article.sentences])
        XCTAssertEqual(materials.count, 1)
        XCTAssertEqual(materials[0].example, "Article origin sentence.")
        XCTAssertEqual(materials[0].sentenceChunks?.first?.text, "look up")
        XCTAssertEqual(materials[0].stats?.total.pass, 1)
    }

    func testBuildNoteMaterialsFallsBackToLLMExample() {
        let word = makeWord("orphan", articleId: "", example: VocabExample(en: "Collected example.", zh: nil))
        let materials = buildNoteMaterials([word], articlesById: [:])
        XCTAssertEqual(materials[0].example, "Collected example.")
        XCTAssertNil(materials[0].sentenceChunks)
        XCTAssertNil(materials[0].stats)
    }

    func testBuildNoteUserInputContainsFields() {
        let input = buildNoteUserInput([buildNoteMaterials([makeWord("alpha")], articlesById: [:])[0]], now: 1_700_000_000_000)
        XCTAssertTrue(input.contains(#""generatedHint""#))
        XCTAssertTrue(input.contains("alpha"))
        XCTAssertTrue(input.contains(#""senses""#))
    }

    // MARK: - 防幻觉校验

    func testVerifyNoteWordsPassesAndFlags() {
        let words = [makeWord("inconsistencies"), makeWord("source from", kind: .chunk)]
        let good = "# 复习笔记\n## 单词\n### inconsistencies\n【记法】整块记\n### source from\n【测】完形｜看介词"
        let ok = verifyNoteWords(good, words: words)
        XCTAssertTrue(ok.ok)

        let bad = "# 复习笔记\n### hallucinated"
        let flagged = verifyNoteWords(bad, words: words)
        XCTAssertFalse(flagged.ok)
        XCTAssertEqual(flagged.unknownHeadings, ["hallucinated"])
    }

    // MARK: - 复盘

    func testParseReplayAndVerify() {
        let text = """
        【总结】这轮过了大半，薄弱点是介词搭配。
        【仍错】source from｜介词调不出，回到原句再记一次
        【仍错】alpha｜眼熟假熟，下次用听写
        """
        guard let replay = parseReplay(text) else { return XCTFail("应解析出") }
        XCTAssertTrue(replay.verdict.contains("过了大半"))
        XCTAssertEqual(replay.weak.count, 2)
        XCTAssertEqual(replay.weak[0].w, "source from")

        let weakWords = [makeWord("source from", kind: .chunk), makeWord("alpha")]
        XCTAssertTrue(verifyReplayWords(replay, weakWords: weakWords))

        let strict = ParsedReplay(verdict: "v", weak: [.init(w: "ghost", why: "x")])
        XCTAssertFalse(verifyReplayWords(strict, weakWords: weakWords))
    }

    func testParseReplayReturnsNilWhenNothingMatches() {
        XCTAssertNil(parseReplay("毫无格式的文本"))
    }

    func testFindWordByHeadingToleratesCaseAndSuffix() {
        let words = [makeWord("Source From", kind: .chunk)]
        XCTAssertNotNil(findWordByHeading("source from", in: words))
        XCTAssertNotNil(findWordByHeading("source from （词块）", in: words))
        XCTAssertNil(findWordByHeading("", in: words))
    }

    // MARK: - 笔记解析（noteParser 对齐）

    private let sampleNote = """
    ---
    {"file":"学词笔记-2026-09-16.md","createdAt":1789500000000,"words":2,"partial":false,"wordIds":["alpha","look up"],"updatedAt":1789500000000}
    ---
    # 复习笔记

    ## 先看这里
    - 这批词的通病是**介词搭配**调不出。
    - 两个词都还没测过。

    ## 单词
    ### alpha
    【记不住】这个词还没测过，诊断按易错点推测。
    【记法】整块记，出处场景锁定。
    - n. 阿尔法
    - adj. 最初的
    > The alpha value controls blending.
    - 必记｜alpha channel｜透明通道
    【测】听写｜只有识别记录

    ## 词块
    ### look up
    【记住了】间隔变长，连对两轮。
    - 查阅；抬头看
    > Look up the word in a dictionary.
    【测】完形｜看介词
    """

    func testSplitNoteFrontmatterRoundtrip() {
        let (meta, body) = splitNoteFrontmatter(sampleNote)
        XCTAssertEqual(meta?.file, "学词笔记-2026-09-16.md")
        XCTAssertEqual(meta?.wordIds, ["alpha", "look up"])
        XCTAssertEqual(meta?.updatedAt, 1_789_500_000_000)
        XCTAssertFalse(body.hasPrefix("---"))
        XCTAssertTrue(body.contains("# 复习笔记"))
        // 无 frontmatter
        let (m2, b2) = splitNoteFrontmatter("plain text")
        XCTAssertNil(m2)
        XCTAssertEqual(b2, "plain text")
    }

    func testParseNoteMarkdownStructure() {
        let (_, body) = splitNoteFrontmatter(sampleNote)
        let parsed = parseNoteMarkdown(body)
        XCTAssertEqual(parsed.glance.count, 2)
        XCTAssertTrue(parsed.glance[0].contains("介词搭配"))
        XCTAssertEqual(parsed.sections.count, 2)
        XCTAssertEqual(parsed.sections[0].title, "单词")
        XCTAssertEqual(parsed.sections[0].cards.count, 1)

        let card = parsed.sections[0].cards[0]
        XCTAssertEqual(card.word, "alpha")
        XCTAssertEqual(card.diagnose?.ok, false)
        XCTAssertTrue(card.diagnose!.text.contains("还没测过"))
        XCTAssertEqual(card.anchor, "整块记，出处场景锁定。")
        XCTAssertEqual(card.senses.count, 2)
        XCTAssertEqual(card.senses[0].pos, "n.")
        XCTAssertEqual(card.senses[0].text, "阿尔法")
        XCTAssertEqual(card.example, "The alpha value controls blending.")
        XCTAssertEqual(card.collos.count, 1)
        XCTAssertEqual(card.collos[0].en, "alpha channel")
        XCTAssertEqual(card.nextTest?.mode, "听写")

        let chunk = parsed.sections[1].cards[0]
        XCTAssertEqual(chunk.word, "look up")
        XCTAssertEqual(chunk.diagnose?.ok, true)
    }

    func testParseNoteMarkdownToleratesUnknownLines() {
        let parsed = parseNoteMarkdown("### word\n随机一行不认识\n- 普通释义")
        XCTAssertEqual(parsed.sections.count, 1)
        XCTAssertEqual(parsed.sections[0].cards[0].senses.count, 1)
        XCTAssertEqual(parsed.sections[0].cards[0].senses[0].pos, nil)
    }

    func testFullWidthBarSplit() {
        let parsed = parseNoteMarkdown("### w\n- 必记｜look up｜查阅")
        XCTAssertEqual(parsed.sections[0].cards[0].collos[0].k, "必记")
    }

    // MARK: - Codable 兼容

    func testVocabWordRecallCodableRoundtrip() throws {
        var w = makeWord("alpha")
        w.recall = recordRecallStat(w.recall, mode: .cloze, bucket: .trap, nowMs: 42)
        let data = try JSONEncoder().encode(w)
        let back = try JSONDecoder().decode(VocabWord.self, from: data)
        XCTAssertEqual(back.recall, w.recall)
        XCTAssertEqual(back.recall?.byMode["cloze"]?.trap, 1)
        // recall 缺省时不编码（老数据兼容）
        let plain = try JSONEncoder().encode(makeWord("beta"))
        let obj = try JSONSerialization.jsonObject(with: plain) as? [String: Any]
        XCTAssertNil(obj?["recall"])
        let backPlain = try JSONDecoder().decode(VocabWord.self, from: plain)
        XCTAssertNil(backPlain.recall)
    }

    func testNoteMetaDecodesWithDefaults() throws {
        let json = #"{"createdAt":100,"words":3}"#
        let meta = try JSONDecoder().decode(NoteMeta.self, from: Data(json.utf8))
        XCTAssertEqual(meta.createdAt, 100)
        XCTAssertEqual(meta.updatedAt, 100)
        XCTAssertFalse(meta.partial)
        XCTAssertTrue(meta.wordIds.isEmpty)
        XCTAssertNil(meta.replay)
    }
}

