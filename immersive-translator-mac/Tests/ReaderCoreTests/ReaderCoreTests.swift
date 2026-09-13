import XCTest
@testable import ReaderCore

/// UTF-16 偏移切片（词块范围一律是 UTF-16 偏移，与 NSRegularExpression 对齐）。
private func substring(_ s: String, _ range: ReaderCore.TextRange) -> String {
    let units = Array(s.utf16)
    let start = min(range.start, units.count)
    let end = min(range.end, units.count)
    guard start < end else { return "" }
    return String(decoding: units[start..<end], as: UTF16.self)
}

final class ReaderCoreTests: XCTestCase {
    // MARK: - 切句 / 切段

    func testSplitSentencesBasic() {
        XCTAssertEqual(
            splitSentences("Hello world. How are you? I'm fine!"),
            ["Hello world.", "How are you?", "I'm fine!"]
        )
    }

    func testSplitSentencesKeepsAbbreviations() {
        XCTAssertEqual(
            splitSentences("Mr. Smith went to Washington. He liked it."),
            ["Mr. Smith went to Washington.", "He liked it."]
        )
        XCTAssertEqual(
            splitSentences("See e.g. the paper by Dr. Lee et al. It works."),
            ["See e.g. the paper by Dr. Lee et al. It works."]
        )
    }

    func testSplitSentencesKeepsDecimalsAndUrls() {
        XCTAssertEqual(splitSentences("Pi is 3.14 enough."), ["Pi is 3.14 enough."])
        XCTAssertEqual(splitSentences("Visit https://a.b/c. Next one."), ["Visit https://a.b/c.", "Next one."])
    }

    func testSplitSentencesCollapsesWhitespace() {
        XCTAssertEqual(
            splitSentences("One   two.\n\tThree!  "),
            ["One two.", "Three!"]
        )
    }

    func testSplitParagraphs() {
        let text = "Para one. Two sentences here.\n\nSecond para!\nThird para continues."
        let paras = splitParagraphs(text)
        XCTAssertEqual(paras.count, 3)
        XCTAssertEqual(paras[0].paragraphIdx, 0)
        XCTAssertEqual(paras[0].sentences, ["Para one.", "Two sentences here."])
        XCTAssertEqual(paras[1].paragraphIdx, 1)
        XCTAssertEqual(paras[2].paragraphIdx, 2)
    }

    // MARK: - 文章构建

    func testBuildArticleUsesFirstLineAsTitle() {
        let text = "The Speed of Reading\n\nReading speed was the goal, and comprehension was the test. It worked."
        let article = buildArticleFromText(text, options: BuildArticleOptions(now: 1234))
        XCTAssertNotNil(article)
        XCTAssertEqual(article?.title, "The Speed of Reading")
        XCTAssertEqual(article?.sentences.count, 2)
        XCTAssertEqual(article?.sentences[0].paragraphIdx, 0)
        XCTAssertEqual(article?.sentences[1].paragraphIdx, 0) // 同一段落
        XCTAssertEqual(article?.titleCnState, .pending)
        XCTAssertEqual(article?.progress.sentenceIdx, 0)
    }

    func testBuildArticleFallsBackToFirstSentenceTitle() {
        // 首行 >60 字符：标题回落为第一句截断（对齐 TS pickTitle）
        let article = buildArticleFromText("This is a long opening sentence without any standalone title line. Second sentence here.")
        XCTAssertEqual(article?.title.hasSuffix("…"), true)
        let short = buildArticleFromText("This is a short opening sentence. Second sentence here.")
        XCTAssertEqual(short?.title, "This is a short opening sentence.")
    }

    func testBuildArticleTruncatesLongTitle() {
        let long = Array(repeating: "word", count: 30).joined(separator: " ") // 119 chars
        let article = buildArticleFromText("\(long). Another one.")
        XCTAssertEqual(article?.title.hasSuffix("…"), true)
        XCTAssertEqual(article?.title.count, 60) // 前 60 字符去尾空格 + 省略号
    }

    func testBuildArticleExplicitTitleDifferentFromFirstLineKeepsBody() {
        let text = "First line here\nBody continues."
        let article = buildArticleFromText(text, options: BuildArticleOptions(now: 1, title: "My Title"))
        XCTAssertEqual(article?.title, "My Title")
        XCTAssertEqual(article?.sentences.map(\.en).joined(separator: " ").contains("First line"), true)
    }

    func testBuildArticleEmptyReturnsNil() {
        XCTAssertNil(buildArticleFromText("   \n  "))
    }

    func testCountWords() {
        XCTAssertEqual(countWords("one two three"), 3)
        XCTAssertEqual(countWords("一二三四五"), 3) // 5 * 0.6 = 3
        XCTAssertEqual(countWords("mixed 一二 text"), 3) // 2 latin + floor(2*0.6)=1
    }

    func testNormalizeWordKey() {
        XCTAssertEqual(normalizeWordKey("  Take On! "), "take on")
        XCTAssertEqual(normalizeWordKey("“Hello,”"), "hello")
        XCTAssertEqual(normalizeWordKey("don't-stop"), "don't-stop")
        XCTAssertEqual(normalizeWordKey("形容词"), "形容词")
    }

    func testDetectTitleFromText() {
        XCTAssertEqual(detectTitleFromText("A Title\n\nBody"), "A Title")
        XCTAssertNil(detectTitleFromText("A title.\nBody")) // 首行以句末标点结尾
        XCTAssertNil(detectTitleFromText(String(repeating: "x", count: 81)))
    }

    // MARK: - SRS

    func testGradeSrsIntervals() {
        let now: Int64 = 1_000_000
        let initial = initialSrs(now: now)
        XCTAssertEqual(initial.dueAt, now)
        XCTAssertEqual(initial.ease, 2.5)

        let forgot = gradeSrs(initial, .forgot, now: now)
        XCTAssertEqual(forgot.intervalDays, 0)
        XCTAssertEqual(forgot.dueAt, now + 10 * 60 * 1000)
        XCTAssertEqual(forgot.lapses, 1)

        let good = gradeSrs(initial, .good, now: now)
        XCTAssertEqual(good.intervalDays, 3)
        XCTAssertEqual(good.dueAt, now + 3 * 24 * 60 * 60 * 1000)

        // ease 升降与钳制
        XCTAssertEqual(gradeSrs(initial, .easy, now: now).ease, 2.65, accuracy: 0.0001)
        XCTAssertEqual(gradeSrs(initial, .hard, now: now).ease, 2.35, accuracy: 0.0001)
        var floorSrs = initial
        floorSrs.ease = 1.3
        XCTAssertEqual(gradeSrs(floorSrs, .forgot, now: now).ease, 1.3, accuracy: 0.0001)
        var ceilSrs = initial
        ceilSrs.ease = 2.8
        XCTAssertEqual(gradeSrs(ceilSrs, .easy, now: now).ease, 2.8, accuracy: 0.0001)
        // 间隔只升不降（同档重复评分）
        var advanced = initial
        advanced.intervalDays = 7
        XCTAssertEqual(gradeSrs(advanced, .good, now: now).intervalDays, 7)
    }

    func testShiftDayKey() {
        XCTAssertEqual(shiftDayKey("2026-09-10", -1), "2026-09-09")
        XCTAssertEqual(shiftDayKey("2026-09-01", -1), "2026-08-31")
        XCTAssertEqual(shiftDayKey("2025-03-01", -1), "2025-02-28")
        XCTAssertEqual(shiftDayKey("2024-03-01", -1), "2024-02-29")
        XCTAssertEqual(shiftDayKey("bad", -1), "")
    }

    func testReviewStatsAndStreak() {
        let now: Int64 = 1_800_000_000_000
        func word(_ id: String, dueAt: Int64, interval: Double, kind: VocabKind = .word) -> VocabWord {
            VocabWord(
                id: id, word: id, kind: kind,
                source: VocabSource(articleId: "a", sentenceIdx: 0),
                srs: VocabSrsState(ease: 2.5, intervalDays: interval, reps: 0, dueAt: dueAt, lapses: 0),
                addedAt: 0
            )
        }
        let vocab = [
            word("alpha", dueAt: now - 1000, interval: 0),
            word("beta", dueAt: now + 60_000, interval: 0),
            word("gamma", dueAt: now + 3 * 86_400_000, interval: 3),
            word("delta", dueAt: now + 8 * 86_400_000, interval: 8),
            word("chunk1", dueAt: now - 1, interval: 0, kind: .chunk),
        ]
        let log = ReviewLogFile(days: [
            ReviewLogDay(day: shiftDayKey(dayKey(nowMs: now), 0), count: 2),
            ReviewLogDay(day: shiftDayKey(dayKey(nowMs: now), -1), count: 1),
        ])
        let stats = reviewStats(vocab, log, nowMs: now)
        XCTAssertEqual(stats.dueNow, 2) // alpha + chunk1
        XCTAssertEqual(stats.total, 5)
        XCTAssertEqual(stats.reviewedToday, 2)
        XCTAssertEqual(stats.distribution.learning, 3)
        XCTAssertEqual(stats.distribution.familiar, 1)
        XCTAssertEqual(stats.distribution.mastered, 1)
        XCTAssertEqual(stats.totalWords, 4)
        XCTAssertEqual(stats.totalChunks, 1)
        XCTAssertEqual(stats.dueWords, 1)
        XCTAssertEqual(stats.dueChunks, 1)
        XCTAssertEqual(stats.streak, 2)

        // 昨天断档 → streak 只算今天
        let brokenLog = ReviewLogFile(days: [
            ReviewLogDay(day: dayKey(nowMs: now), count: 1),
            ReviewLogDay(day: shiftDayKey(dayKey(nowMs: now), -3), count: 4),
        ])
        XCTAssertEqual(reviewStats(vocab, brokenLog, nowMs: now).streak, 1)
    }

    func testRecordReviewKeeps365Days() {
        var log = ReviewLogFile(days: [])
        let now: Int64 = 1_700_000_000_000
        log = recordReview(log, nowMs: now)
        log = recordReview(log, nowMs: now)
        XCTAssertEqual(log.days.first?.count, 2)
        // 366 天前的旧记录被清理
        let old = shiftDayKey(dayKey(nowMs: now), -366)
        log.days.append(ReviewLogDay(day: old, count: 9))
        log = recordReview(log, nowMs: now)
        XCTAssertFalse(log.days.contains { $0.day == old })
    }

    // MARK: - 编号行协议

    func testParagraphRequestInput() {
        XCTAssertEqual(buildParagraphRequestInput(["A.", "B."]), "[1] A.\n[2] B.")
    }

    func testParseParagraphResponseNumbered() {
        let raw = "```text\n[1] 甲。\n[2] 乙。\n```"
        XCTAssertEqual(parseParagraphResponse(raw, expectedCount: 2), ["甲。", "乙。"])
    }

    func testParseParagraphResponseFallbackUnnumbered() {
        XCTAssertEqual(parseParagraphResponse("甲。\n乙。", expectedCount: 2), ["甲。", "乙。"])
        XCTAssertNil(parseParagraphResponse("甲。\n乙。", expectedCount: 3))
        XCTAssertNil(parseParagraphResponse("[1] 甲。\n[3] 丙。", expectedCount: 2))
    }

    func testParsePartialNumbered() {
        let partial = parsePartialNumbered("[1] 甲。", expectedCount: 2)
        XCTAssertEqual(partial[0], "甲。")
        XCTAssertNil(partial[1])
    }

    // MARK: - 词典

    func testExtractSelectionText() {
        XCTAssertEqual(extractSelectionText("  take   on  "), "take on")
        XCTAssertEqual(extractSelectionText("“momentum,”"), "momentum")
        XCTAssertNil(extractSelectionText(String(repeating: "a", count: 81)))
        XCTAssertNil(extractSelectionText("   "))
    }

    func testParseReaderDictResponse() {
        let raw = """
        ```json
        {"word":"take on","phonetic":"ˈteɪk ɑn","senses":[{"pos":"v.","cn":"承担；呈现"}],
         "collocations":[{"en":"take on momentum","cn":"获得动能"}],
         "forms":["takes on","took on"],"chunkType":"phrasal","pattern":"take on sth","trap":"不是 take up"}
        ```
        """
        guard case let .entry(entry) = parseReaderDictResponse(raw) else {
            return XCTFail("expected entry")
        }
        XCTAssertEqual(entry.word, "take on")
        XCTAssertEqual(entry.phonetic, "ˈteɪk ɑn")
        XCTAssertEqual(entry.senses.first?.cn, "承担；呈现")
        XCTAssertEqual(entry.chunkType, .phrasal)
        XCTAssertEqual(entry.forms?.count, 2)

        guard case .notAWord = parseReaderDictResponse(#"{"error":"not_a_word"}"#) else {
            return XCTFail("expected notAWord")
        }
        guard case .invalid = parseReaderDictResponse("this is not json") else {
            return XCTFail("expected invalid")
        }
        guard case .invalid = parseReaderDictResponse(#"{"word":"x","senses":[]}"#) else {
            return XCTFail("expected invalid when senses empty")
        }
    }

    func testEntryToVocabChunkDetection() {
        let entry = ReaderDictEntry(
            word: "take on",
            senses: [VocabSense(pos: "v.", cn: "承担")],
            chunkType: .phrasal,
            pattern: "take on sth",
            trap: "tr"
        )
        let vocab = entryToVocab(entry, source: VocabSource(articleId: "a1", sentenceIdx: 2), now: 42)
        XCTAssertEqual(vocab.id, "take on")
        XCTAssertEqual(vocab.kind, .chunk)
        XCTAssertEqual(vocab.srs.dueAt, 42)
        XCTAssertEqual(vocab.source.sentenceIdx, 2)

        let single = ReaderDictEntry(word: "swift", senses: [VocabSense(pos: "adj.", cn: "迅速的")])
        let wordVocab = entryToVocab(single, source: VocabSource(articleId: "a1", sentenceIdx: 0), now: 42)
        XCTAssertEqual(wordVocab.kind, .word)
        XCTAssertNil(wordVocab.chunkType)
    }

    func testParseExampleResponse() {
        let ok = parseExampleResponse(#"{"en":"She had to take on the task.","zh":"她必须承担这个任务。"}"#, word: "take on")
        XCTAssertEqual(ok?.en, "She had to take on the task.")
        // 屈折形式不含词条原形 → 拒收（TS 同口径）
        XCTAssertNil(parseExampleResponse(#"{"en":"She took on the task."}"#, word: "take on"))
        XCTAssertNil(parseExampleResponse(#"{"en":"Nothing matches."}"#, word: "take on"))
        XCTAssertNil(parseExampleResponse("no json", word: "x"))
    }

    // MARK: - 词块

    func testFindChunkRangeThreeTiers() {
        let sentence = "It took on momentum quickly."
        XCTAssertEqual(findChunkRange(sentence, "took on momentum"), TextRange(start: 3, end: 19))
        // 忽略大小写
        XCTAssertEqual(findChunkRange(sentence, "Took On Momentum"), TextRange(start: 3, end: 19))
        // 空白弹性
        XCTAssertEqual(findChunkRange("settle   in", "settle in"), TextRange(start: 0, end: 11))
        XCTAssertNil(findChunkRange(sentence, "not present"))
    }

    func testParseChunkResponse() {
        let batch = [ChunkBatchItem(idx: 1, en: "It took on momentum quickly."),
                     ChunkBatchItem(idx: 2, en: "Rain fell hard.")]
        let raw = """
        {"items":[{"i":1,"chunks":[{"text":"took on momentum","type":"collocation","gloss":"获得动能","pattern":"take on sth","trap":"make momentum"},
        {"text":"fabricated phrase here","type":"idiom","gloss":"编造"},
        {"text":"took on momentum","type":"collocation","gloss":"重复"}]},
        {"i":9,"chunks":[{"text":"rain fell","type":"collocation","gloss":"不存在句号"}]},
        {"i":2,"chunks":[{"text":"Rain fell","type":"phrasal","gloss":"落雨"}]}]}
        """
        let byIdx = parseChunkResponse(raw, batch: batch)
        XCTAssertEqual(byIdx[1]?.count, 1) // 编造的（定位不到）与重复的都被丢弃
        XCTAssertEqual(byIdx[1]?.first?.chunkType, .collocation)
        XCTAssertEqual(byIdx[1]?.first?.pattern, "take on sth")
        XCTAssertNil(byIdx[9]) // 模型编造句号
        XCTAssertEqual(byIdx[2]?.first?.chunkType, .phrasal)
    }

    func testChunkBatches() {
        let items = (0..<23).map { ChunkBatchItem(idx: $0, en: "s\($0)") }
        let batches = chunkBatches(items)
        XCTAssertEqual(batches.map(\.count), [10, 10, 3])
        XCTAssertEqual(chunkBatches([]).count, 0)
    }

    func testBuildSentenceSpansMergeAndPriority() {
        let en = "She took on momentum again."
        let chunk = SentenceChunk(text: "took on momentum", chunkType: .collocation, gloss: "获得动能")
        // 词块在生词本里 → known
        let spans = buildSentenceSpans(en, [chunk], knownIds: ["took on momentum"])
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans[0].kind, .known)
        XCTAssertEqual(spans[0].start, 4)
        XCTAssertEqual(spans[0].end, 20)

        // 生词再现：单词条目出现在句中
        let marks = buildSentenceSpans(en, nil, knownIds: ["momentum"])
        XCTAssertEqual(marks.count, 1)
        XCTAssertEqual(marks[0].kind, .known)
        XCTAssertEqual(substring(en, TextRange(start: marks[0].start, end: marks[0].end)), "momentum")

        // 长跨度优先，重叠的短者出局
        let both = buildSentenceSpans(en, [chunk], knownIds: ["momentum"])
        XCTAssertEqual(both.count, 1)
        XCTAssertEqual(both[0].chunk?.text, "took on momentum")
    }

    func testSplitBySpansAndBlank() {
        let en = "She took on momentum again."
        let spans = [ChunkSpan(start: 4, end: 20, kind: .chunk, chunk: nil)]
        let segments = splitBySpans(en, spans)
        XCTAssertEqual(segments.map(\.text), ["She ", "took on momentum", " again."])
        XCTAssertEqual(segments[1].span != nil, true)

        XCTAssertEqual(blankChunkInSentence(en, "took on momentum"), "She ▁▁▁▁ again.")
        XCTAssertEqual(blankChunkInSentence(en, "missing"), en)
    }

    func testChunkToVocab() {
        let chunk = SentenceChunk(text: "took on momentum", chunkType: .collocation, gloss: "获得动能", pattern: "take on sth", trap: "make momentum")
        let vocab = chunkToVocab(chunk, source: VocabSource(articleId: "a1", sentenceIdx: 3), now: 7)
        XCTAssertEqual(vocab.kind, .chunk)
        XCTAssertEqual(vocab.senses.first?.pos, "搭配")
        XCTAssertEqual(vocab.srs.dueAt, 7)
        XCTAssertEqual(vocab.source.sentenceIdx, 3)
    }

    // MARK: - 判分

    func testNormalizeAnswer() {
        XCTAssertEqual(normalizeAnswer("Don't Stop!"), "dont stop")
        XCTAssertEqual(normalizeAnswer("  city's "), "citys")
        XCTAssertEqual(normalizeAnswer("a, b;  c"), "a b c")
    }

    func testLevenshtein() {
        XCTAssertEqual(levenshtein("kitten", "sitting"), 3)
        XCTAssertEqual(levenshtein("", "abc"), 3)
        XCTAssertEqual(levenshtein("same", "same"), 0)
    }

    func testJudgeCloze() {
        XCTAssertEqual(judgeCloze("Take ON", "take on"), .perfect)
        XCTAssertEqual(judgeCloze("the momentum", "momentum"), .close) // 去冠词
        XCTAssertEqual(judgeCloze("momentums", "momentum"), .close) // 距离 1
        XCTAssertEqual(judgeCloze("make momentum", "take on momentum", options: JudgeOptions(trap: "不是 make momentum")), .trap)
        XCTAssertEqual(judgeCloze("completely wrong", "take on momentum"), .wrong)
        XCTAssertEqual(judgeCloze("", "answer"), .wrong)
        XCTAssertEqual(judgeCloze("takes on", "take on", options: JudgeOptions(accepted: ["takes on"])), .perfect)
    }

    func testWordDiffAndDictation() {
        let diff = wordDiff("She took momemtum", "she took on momentum")
        XCTAssertEqual(diff.filter { $0.status == .ok }.map(\.text), ["she", "took"])
        XCTAssertEqual(diff.filter { $0.status == .miss }.map(\.text), ["on", "momentum"])
        XCTAssertEqual(diff.filter { $0.status == .extra }.map(\.text), ["momemtum"])

        XCTAssertEqual(judgeDictation("She took on momentum.", "She took on momentum"), .perfect)
        XCTAssertEqual(judgeDictation("she took on the momentum", "She took on momentum"), .close)
        XCTAssertEqual(judgeDictation("totally different words here", "She took on momentum"), .wrong)
        XCTAssertEqual(judgeDictation("", "sentence"), .wrong)
    }

    func testRouteRecallMode() {
        func word(_ kind: VocabKind?, interval: Double) -> VocabWord {
            VocabWord(
                id: "w", word: "w", kind: kind,
                source: VocabSource(articleId: "", sentenceIdx: 0),
                srs: VocabSrsState(ease: 2.5, intervalDays: interval, reps: 0, dueAt: 0, lapses: 0),
                addedAt: 0
            )
        }
        XCTAssertEqual(routeRecallMode(word(.chunk, interval: 0), .smart), .cloze)
        XCTAssertEqual(routeRecallMode(word(.word, interval: 3), .smart), .dictation)
        XCTAssertEqual(routeRecallMode(word(nil, interval: 0), .smart), .recognition)
        XCTAssertEqual(routeRecallMode(word(.chunk, interval: 0), .dictation), .dictation)
    }

    func testVerdictMappingAndFirstLetters() {
        XCTAssertEqual(verdictToSuggestedGrade(.perfect), .easy)
        XCTAssertEqual(verdictToSuggestedGrade(.close), .good)
        XCTAssertEqual(verdictToSuggestedGrade(.trap), .forgot)
        XCTAssertEqual(verdictToSuggestedGrade(.wrong), .forgot)
        XCTAssertEqual(firstLetters("take on momentum"), "t… o… m…")
    }

    // MARK: - 数据契约

    func testArticleCodableRoundTripAndNullTolerance() throws {
        let article = Article(
            id: "a1", title: "T", titleCn: "甲", titleCnState: .done, sourceType: .paste,
            wordCount: 10, createdAt: 0, lastReadAt: 0,
            sentences: [
                SentencePair(idx: 0, paragraphIdx: 0, en: "Hi.", zh: nil, zhState: .pending,
                             revealed: false,
                             chunks: [SentenceChunk(text: "Hi", chunkType: .collocation, gloss: "嗨", pattern: nil, trap: nil)])
            ],
            chunkState: .done
        )
        let data = try ReaderFileCodec.encode(ArticlesFile(articles: [article]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["schemaVersion"] as? Int, readerSchemaVersion)
        // 可选 nil 字段必须被跳过而不是写 null
        let sentence = try XCTUnwrap(((json["articles"] as? [[String: Any]])?.first?["sentences"] as? [[String: Any]])?.first)
        XCTAssertFalse(sentence.keys.contains("titleCn"))
        let chunk = try XCTUnwrap((sentence["chunks"] as? [[String: Any]])?.first)
        XCTAssertFalse(chunk.keys.contains("trap"))

        let decoded = try ReaderFileCodec.decode(ArticlesFile.self, from: data)
        XCTAssertEqual(decoded.articles, [article])
    }

    func testLegacyArticleWithoutOptionalFieldsLoads() throws {
        let legacyJSON = """
        {"schemaVersion":1,"articles":[{"id":"a2","title":"T","titleCnState":"done","sourceType":"paste",
        "wordCount":1,"createdAt":0,"lastReadAt":0,
        "progress":{"sentenceIdx":0,"percent":0,"secondsListened":0},
        "sentences":[{"idx":0,"paragraphIdx":0,"en":"Hi.","zh":null,"zhState":"pending"}]}]}
        """
        let file = try ReaderFileCodec.decode(ArticlesFile.self, from: Data(legacyJSON.utf8))
        XCTAssertEqual(file.articles.first?.chunkState, nil)
        XCTAssertEqual(file.articles.first?.sentences.first?.chunks, nil)
    }

    func testSchemaVersionMismatchThrowsFriendlyError() {
        XCTAssertThrowsError(try ReaderFileCodec.checkSchemaVersion(topLevel: ["schemaVersion": 99], file: "reader_articles.json")) { error in
            XCTAssertEqual((error as? ReaderFileCodec.ReaderFileError)?.errorDescription?.contains("版本不兼容"), true)
        }
        XCTAssertNoThrow(try ReaderFileCodec.checkSchemaVersion(topLevel: ["schemaVersion": 1], file: "x"))
    }

    func testVocabChunkFieldsRoundTrip() throws {
        let json = """
        {"id":"take on momentum","word":"take on momentum","kind":"chunk","senses":[{"pos":"搭配","cn":"获得动力"}],
        "chunkType":"collocation","pattern":"take on sth","trap":"不是 make momentum",
        "source":{"articleId":"a1","sentenceIdx":3},
        "srs":{"ease":2.5,"intervalDays":0,"reps":0,"dueAt":1,"lapses":0},"addedAt":0}
        """
        let word = try ReaderFileCodec.decode(VocabWord.self, from: Data(json.utf8))
        XCTAssertEqual(word.kind, .chunk)
        XCTAssertEqual(word.chunkType, .collocation)
        XCTAssertEqual(word.effectiveKind, .chunk)
        let out = try JSONSerialization.jsonObject(with: ReaderFileCodec.encode(word)) as? [String: Any]
        XCTAssertEqual(out?["kind"] as? String, "chunk")
        XCTAssertEqual(out?["chunkType"] as? String, "collocation")
        XCTAssertNil(out?["example"])
    }

    // MARK: - 设置合并

    func testMergeReaderSettingsValidatesAndClamps() {
        var base = ReaderSettings.default
        base.fontSize = 19
        var override = ReaderSettingsOverride()
        override.fontSize = 99 // 超界 → 收敛
        override.theme = "sepia"
        override.contrastMode = "zh"
        override.rate = 9.0
        override.maskTranslation = true
        override.fontSize = 99
        let merged = mergeReaderSettings(base, override)
        XCTAssertEqual(merged.fontSize, readerFontSizeMax)
        XCTAssertEqual(merged.theme, .sepia)
        XCTAssertEqual(merged.contrastMode, .zh)
        XCTAssertEqual(merged.rate, readerRateMax)
        XCTAssertEqual(merged.maskTranslation, true)

        // 非法值不打穿
        var bad = ReaderSettingsOverride()
        bad.theme = "hacker"
        bad.contrastMode = "weird"
        let merged2 = mergeReaderSettings(base, bad)
        XCTAssertEqual(merged2.theme, base.theme)
        XCTAssertEqual(merged2.contrastMode, base.contrastMode)

        // nil 覆盖 → 原样
        XCTAssertEqual(mergeReaderSettings(base, nil), base)
    }

    // MARK: - 面板词条判定 / 词典卡

    func testIsLookupText() {
        XCTAssertEqual(isLookupText("momentum"), true)
        XCTAssertEqual(isLookupText("in the wake of"), true)
        XCTAssertEqual(isLookupText("字符串"), true)
        XCTAssertEqual(isLookupText("don't"), true)
        XCTAssertEqual(isLookupText("This is a full sentence."), false)
        XCTAssertEqual(isLookupText("https://example.com/a"), false)
        XCTAssertEqual(isLookupText("user_name"), false)
        XCTAssertEqual(isLookupText("1234"), false) // 纯数字
        XCTAssertEqual(isLookupText("中英mixed"), false) // 中英混排
        XCTAssertEqual(isLookupText("一二三四五六七"), false) // CJK 超长
        XCTAssertEqual(isLookupText("one two three four five"), false) // 5 token
        XCTAssertEqual(isLookupText("line1\nline2"), false) // 多行
    }

    func testParseDictResponse() {
        let raw = """
        ```json
        {"word":"momentum","phonetics":[{"label":"UK","value":"/məˈmɛntəm/"}],
         "translation":"动量；势头","senses":[{"pos":"n.","gloss":"动力；势头",
         "examples":[{"s":"The campaign took on momentum.","t":"运动获得了势头。"}]}],
         "inflections":"momenta","etymology":"源自希腊语"}
        ```
        """
        guard case let .card(card) = parseDictResponse(raw, query: "momentum") else {
            return XCTFail("expected card")
        }
        XCTAssertEqual(card.word, "momentum")
        XCTAssertEqual(card.phonetics.first?.label, "UK")
        XCTAssertEqual(card.senses.first?.examples.first?.t, "运动获得了势头。")
        XCTAssertEqual(card.inflections, "momenta")

        // 尾逗号修复
        let trailing = #"{"word":"x","senses":[{"pos":"","gloss":"甲",}],}"#
        guard case .card = parseDictResponse(trailing, query: "x") else {
            return XCTFail("trailing comma should be repaired")
        }

        guard case .notAWord = parseDictResponse(#"{"error":"not a word"}"#, query: "x") else {
            return XCTFail("expected notAWord")
        }
        guard case .invalid = parseDictResponse("no braces", query: "x") else {
            return XCTFail("expected invalid")
        }
        guard case .invalid = parseDictResponse(#"{"word":"x"}"#, query: "x") else {
            return XCTFail("expected invalid when no content")
        }
    }

    func testDictCardToTextAndSplitByWord() {
        let card = DictCardData(
            word: "momentum",
            phonetics: [DictPhonetic(label: "UK", value: "məˈmɛntəm")],
            translation: "势头",
            senses: [DictSense(pos: "n.", gloss: "动力", examples: [DictExample(s: "gain momentum", t: "获得动力")])],
            inflections: "momenta",
            etymology: "希腊语"
        )
        let text = dictCardToText(card)
        XCTAssertEqual(text.hasPrefix("momentum UK /məˈmɛntəm/"), true)
        XCTAssertEqual(text.contains("[n.] 动力"), true)
        XCTAssertEqual(text.contains("词形: momenta"), true)

        let parts = splitByWord("The momentum of the moment matters.", "momentum")
        XCTAssertEqual(parts.filter(\.hit).map(\.text), ["momentum"])
        XCTAssertEqual(parts.filter { !$0.hit }.map(\.text).joined().contains("The "), true)
        // 词边界：moment 不会命中 momentum
        let miss = splitByWord("a moment ago", "momentum")
        XCTAssertEqual(miss.filter(\.hit).count, 0)
        // CJK 直接子串
        let cjk = splitByWord("这句话里有动力这个词", "动力")
        XCTAssertEqual(cjk.filter(\.hit).map(\.text), ["动力"])
    }

    func testActionPrompts() {
        let polish = buildActionSystemPrompt(action: .polish, targetLanguage: "简体中文", customStyle: "正式", glossaryText: "a -> 甲")
        XCTAssertEqual(polish.contains("draft_translation"), true)
        XCTAssertEqual(polish.contains("正式"), true)
        let grammar = buildActionSystemPrompt(action: .grammar, targetLanguage: "简体中文", customStyle: "正式", glossaryText: "a -> 甲")
        XCTAssertEqual(grammar.contains("正式"), false) // 语法解释不注入风格
        let rephrase = buildActionSystemPrompt(action: .rephrase, targetLanguage: "", customStyle: "", glossaryText: "a -> 甲")
        XCTAssertEqual(rephrase.contains("3 alternative"), true)
        let user = buildPolishUserText(source: "Hello", draftTranslation: "你好")
        XCTAssertEqual(user.contains("<source>"), true)
        XCTAssertEqual(user.contains("<draft_translation>"), true)
    }

    // MARK: - 语言判定

    func testLooksMostlyChineseAndResolve() {
        XCTAssertEqual(looksMostlyChinese("这是一段中文文本"), true)
        XCTAssertEqual(looksMostlyChinese("Mostly English words here"), false)
        XCTAssertEqual(resolveTargetLanguage("Hello world", TargetLanguageConfig(auto: true, fixed: "")), "简体中文")
        XCTAssertEqual(resolveTargetLanguage("这是一段中文", TargetLanguageConfig(auto: true, fixed: "")), "English")
        XCTAssertEqual(resolveTargetLanguage("Hello", TargetLanguageConfig(auto: false, fixed: "Deutsch")), "Deutsch")
        XCTAssertEqual(resolveTargetLanguage("Hello", TargetLanguageConfig(auto: false, fixed: "  ")), "简体中文")
    }
}
