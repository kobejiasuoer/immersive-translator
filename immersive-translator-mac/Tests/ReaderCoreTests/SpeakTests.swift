import XCTest
@testable import ReaderCore

/// 口语陪练：场景元数据 / prompt 构造 / 回复解析 / 会话构造 / 语境会话 /
/// 教练批改（SPEAK-1/3/6/10 的纯逻辑面）。

final class SpeakTests: XCTestCase {
    func testScenarioAndDifficultyLookup() {
        XCTAssertEqual(scenarioOf(.ordering).label, "点餐")
        XCTAssertEqual(scenarioOf(.travel).emoji, "✈️")
        XCTAssertEqual(difficultyOf(.hard).label, "进阶")
        XCTAssertEqual(difficultyOf(.easy).note.contains("简单"), true)
    }

    func testNewSpeakSessionOpensWithAssistantOpener() {
        let s = newSpeakSession(.interview, .medium, now: 1000)
        XCTAssertEqual(s.turns.count, 1)
        XCTAssertEqual(s.turns[0].role, .assistant)
        XCTAssertEqual(s.turns[0].text, scenarioOf(.interview).opener)
        XCTAssertEqual(s.turns[0].hintZh, scenarioOf(.interview).openerZh)
        XCTAssertTrue(s.id.hasPrefix("s"))
        XCTAssertEqual(s.createdAt, 1000)
        XCTAssertNil(s.context)
    }

    func testBuildSpeakSystemPromptContainsScenarioBrief() {
        let prompt = buildSpeakSystemPrompt(.ordering, .easy)
        XCTAssertTrue(prompt.contains("服务员"))
        XCTAssertTrue(prompt.contains("最简单"))
        XCTAssertTrue(prompt.contains("\"EN: \""))
        XCTAssertTrue(prompt.contains("\"ZH: \""))
        // v0.8 教练批改：四行格式（EN/ZH/BETTER/TIP）
        XCTAssertTrue(prompt.contains("\"BETTER: \""))
        XCTAssertTrue(prompt.contains("\"TIP: \""))
    }

    func testBuildSpeakUserInputRollsRecentTurns() {
        let turns = [
            SpeakTurn(role: .assistant, text: "Hello!", at: 1),
            SpeakTurn(role: .user, text: "Hi.", at: 2),
        ]
        let input = buildSpeakUserInput(turns, "I want coffee")
        XCTAssertTrue(input.contains("你: Hello!"))
        XCTAssertTrue(input.contains("我: Hi."))
        XCTAssertTrue(input.hasSuffix("请给出你的下一轮回复（EN: / ZH: / BETTER: / TIP: 四行）。"))
    }

    // MARK: SPEAK-10 - 末轮用户话在输入中只出现一次

    /// 对话环调用约定：turns 传「不含本轮 user 轮」的历史（调用方 dropLast），
    /// 本轮发言由 userText 单独拼入——末句在 LLM 输入里只出现一次。
    func testBuildSpeakUserInputFinalUserTextAppearsOnce() {
        let turns = [
            SpeakTurn(role: .assistant, text: "What would you like?", at: 1),
            SpeakTurn(role: .assistant, text: "Anything else?", at: 2),
            SpeakTurn(role: .user, text: "I want a large latte please", at: 3),
        ]
        let priorTurns = Array(turns.dropLast())
        let input = buildSpeakUserInput(priorTurns, "I want a large latte please")
        let occurrences = input.components(separatedBy: "I want a large latte please").count - 1
        XCTAssertEqual(occurrences, 1, "末轮用户话在 LLM 输入里必须只出现一次（当前输入快照）：\n\(input)")
        XCTAssertTrue(input.contains("你: Anything else?"))
    }

    // MARK: - 回复解析

    func testParseAssistantReplyStandardTwoLines() {
        let parsed = parseAssistantReply("EN: Sure, one latte coming up! Anything else?\nZH: 好的拿铁马上来，还要别的吗（可以说 That's all）")
        XCTAssertEqual(parsed.en, "Sure, one latte coming up! Anything else?")
        XCTAssertEqual(parsed.zh, "好的拿铁马上来，还要别的吗（可以说 That's all）")
        XCTAssertNil(parsed.better)
        XCTAssertNil(parsed.tip)
    }

    func testParseAssistantReplyFourLines() {
        let raw = """
        EN: Sure! One large latte coming right up.
        ZH: 好的，大杯拿铁马上来。还可以说 Anything else?
        BETTER: Could I get a large latte, please?
        TIP: Could I get 比 I want 更客气，加 please 更礼貌。
        """
        let parsed = parseAssistantReply(raw)
        XCTAssertEqual(parsed.en, "Sure! One large latte coming right up.")
        XCTAssertEqual(parsed.zh, "好的，大杯拿铁马上来。还可以说 Anything else?")
        XCTAssertEqual(parsed.better, "Could I get a large latte, please?")
        XCTAssertEqual(parsed.tip, "Could I get 比 I want 更客气，加 please 更礼貌。")
    }

    func testParseAssistantReplyTolerantForms() {
        // 全角冒号 + 代码块围栏
        let p1 = parseAssistantReply("```\nEN：Here you go.\nZH：给你。\n```")
        XCTAssertEqual(p1.en, "Here you go.")
        XCTAssertEqual(p1.zh, "给你。")
        // 只有 EN（ZH 缺省）
        let p2 = parseAssistantReply("EN: Just water, please.")
        XCTAssertEqual(p2.en, "Just water, please.")
        XCTAssertEqual(p2.zh, "")
        // 完全没有标记：全文当英文，不丢内容
        let p3 = parseAssistantReply("No markers at all here.")
        XCTAssertEqual(p3.en, "No markers at all here.")
        // 多余空白折叠（含 BETTER/TIP 行）
        let p4 = parseAssistantReply("EN:  multiple   spaces  \nBETTER:  tidy    version \nTIP:  提示 ")
        XCTAssertEqual(p4.en, "multiple spaces")
        XCTAssertEqual(p4.better, "tidy version")
        XCTAssertEqual(p4.tip, "提示")
        // EN 截到 BETTER 行为止（不吞进英文回复）
        let p5 = parseAssistantReply("EN: Hello there.\nBETTER: Hi there.")
        XCTAssertEqual(p5.en, "Hello there.")
        XCTAssertEqual(p5.better, "Hi there.")
        // BETTER 行存在但为空：不落 better
        let p6 = parseAssistantReply("EN: Hello.\nBETTER:  \nTIP: x")
        XCTAssertEqual(p6.en, "Hello.")
        XCTAssertNil(p6.better)
        XCTAssertEqual(p6.tip, "x")
    }

    // MARK: SPEAK-3 - 词级 LCS 对比

    func testComputeCoachDiffWordLevelEdits() {
        let segs = computeCoachDiff(original: "I want a large coffee", better: "Could I get a large coffee, please?")
        // LCS 对齐后的精确片段序（相邻同状态已合并；标点各算一个 token）
        XCTAssertEqual(segs, [
            CoachSeg(t: .ins, v: "Could"),
            CoachSeg(t: .keep, v: "I"),
            CoachSeg(t: .ins, v: "get"),
            CoachSeg(t: .del, v: "want"),
            CoachSeg(t: .keep, v: "a large coffee"),
            CoachSeg(t: .ins, v: ", please ?"),
        ])
        // 相邻同状态合并：任意相邻两段状态不同
        for (prev, next) in zip(segs, segs.dropFirst()) {
            XCTAssertNotEqual(prev.t, next.t, "相邻同状态片段应合并：\(segs)")
        }
    }

    func testComputeCoachDiffIdenticalTextIsAllKeep() {
        let segs = computeCoachDiff(original: "I am fine.", better: "I am fine.")
        XCTAssertEqual(segs, [CoachSeg(t: .keep, v: "I am fine .")])
    }

    func testComputeCoachDiffEmptyBetterIsAllDel() {
        let segs = computeCoachDiff(original: "Hello world", better: "")
        XCTAssertTrue(segs.allSatisfy { $0.t == .del })
        XCTAssertEqual(segs.map(\.v).joined(separator: " "), "Hello world")
    }

    func testComputeCoachDiffCaseInsensitiveKeep() {
        // 大小写不同也算 keep（对齐 ts 的 toLowerCase 比较）
        let segs = computeCoachDiff(original: "i LIKE it", better: "I like It")
        XCTAssertTrue(segs.allSatisfy { $0.t == .keep })
    }

    func testCoachDiffCodableRoundtrip() throws {
        let turn = SpeakTurn(
            role: .user, text: "I want coffee",
            coachDiff: CoachDiff(
                segs: [CoachSeg(t: .del, v: "want"), CoachSeg(t: .ins, v: "could get")],
                note: "更客气的说法"
            ),
            at: 7
        )
        let data = try JSONEncoder().encode(turn)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"coachDiff\""))
        XCTAssertTrue(json.contains("\"del\""))
        let back = try JSONDecoder().decode(SpeakTurn.self, from: data)
        XCTAssertEqual(back.coachDiff, turn.coachDiff)
    }

    // MARK: SPEAK-1 - 语境会话

    func testNewSpeakSessionWithContextKeepsContext() {
        let ctx = SpeakSessionContext.vocab(wordIds: ["w1", "w2"])
        let s = newSpeakSession(.smalltalk, .easy, now: 42, context: ctx)
        XCTAssertEqual(s.context, ctx)
        XCTAssertEqual(s.turns[0].text, scenarioOf(.smalltalk).opener)  // 静态开场白；插值版由调用方替换
    }

    func testSpeakContextOpenerBookAndVocab() {
        let bookOpener = speakContextOpener(.book(
            bookTitle: "The Old Man and the Sea", chapterArticleId: "a1", chapterIdx: 2,
            excerpt: ["He was an old man who fished alone."]
        ))
        XCTAssertTrue(bookOpener.text.contains("Chapter 3"))
        XCTAssertTrue(bookOpener.text.contains("The Old Man and the Sea"))
        XCTAssertTrue(bookOpener.text.contains("Starting from:"))
        XCTAssertTrue(bookOpener.hintZh.contains("第 3 章"))

        let vocabOpener = speakContextOpener(.vocab(wordIds: []))
        XCTAssertTrue(vocabOpener.text.contains("target words"))
        XCTAssertTrue(vocabOpener.hintZh.contains("生词造句闯关"))
    }

    func testBuildSpeakSystemPromptWithBookContext() {
        let prompt = buildSpeakSystemPrompt(
            .smalltalk, .medium,
            context: .book(bookTitle: "Dune", chapterArticleId: "a9", chapterIdx: 4, excerpt: ["The spice must flow.", "Fear is the mind-killer."]),
            targets: [SpeakContextTarget(word: "spice", zh: "香料"), SpeakContextTarget(word: "fear", zh: "恐惧")]
        )
        XCTAssertTrue(prompt.contains("《Dune》第 5 章"))
        XCTAssertTrue(prompt.contains("The spice must flow. Fear is the mind-killer."))
        XCTAssertTrue(prompt.contains("目标词块"))
        XCTAssertTrue(prompt.contains("spice（香料）"))
        XCTAssertTrue(prompt.contains("fear（恐惧）"))
    }

    func testBuildSpeakSystemPromptWithVocabContext() {
        let prompt = buildSpeakSystemPrompt(
            .smalltalk, .easy,
            context: .vocab(wordIds: ["x1"]),
            targets: [SpeakContextTarget(word: "resilient", zh: "有弹性的")]
        )
        XCTAssertTrue(prompt.contains("生词造句闯关"))
        XCTAssertTrue(prompt.contains("待复习词表：resilient（有弹性的）"))
        XCTAssertTrue(prompt.contains("过关"))
    }

    func testBuildSpeakSystemPromptWithoutContextHasNoContextLines() {
        let prompt = buildSpeakSystemPrompt(.ordering, .medium)
        XCTAssertFalse(prompt.contains("本次对话语境"))
        XCTAssertFalse(prompt.contains("目标词块"))
    }

    // MARK: SPEAK-6 - 语境目标词 / 命中

    private func makeVocab(_ id: String, _ word: String, articleId: String = "", cn: String? = nil, phonetic: String? = nil) -> VocabWord {
        VocabWord(
            id: id, word: word, kind: .word,
            phonetic: phonetic,
            senses: cn.map { [VocabSense(pos: "", cn: $0)] } ?? [],
            source: VocabSource(articleId: articleId, sentenceIdx: 0),
            srs: initialSrs(now: 1), addedAt: 1
        )
    }

    func testSpeakContextTargetsFiltersByContext() {
        let chapterWord = makeVocab("w-chapter", "unwind", articleId: "art-1", cn: "解开")
        let otherWord = makeVocab("w-other", "spice", articleId: "art-2", cn: "香料")
        let dueWord = makeVocab("w-due", "resilient", phonetic: "/rɪˈzɪliənt/")
        let vocab = [chapterWord, otherWord, dueWord]

        // book：只取本章生词；zh 取首个义项
        let bookTargets = speakContextTargets(
            context: .book(bookTitle: "B", chapterArticleId: "art-1", chapterIdx: 0, excerpt: []),
            vocabWords: vocab
        )
        XCTAssertEqual(bookTargets.map(\.word.id), ["w-chapter"])
        XCTAssertEqual(bookTargets[0].zh, "解开")

        // vocab：按会话记录的 id 取词；无义项回落音标
        let vocabTargets = speakContextTargets(context: .vocab(wordIds: ["w-due", "w-missing"]), vocabWords: vocab)
        XCTAssertEqual(vocabTargets.map(\.word.id), ["w-due"])
        XCTAssertEqual(vocabTargets[0].zh, "/rɪˈzɪliənt/")

        // 无语境：空
        XCTAssertTrue(speakContextTargets(context: nil, vocabWords: vocab).isEmpty)
    }

    func testSpeakHitTargetIdsScansUserTurns() {
        let targets = [
            (word: makeVocab("w1", "unwind", cn: "解开"), zh: "解开"),
            (word: makeVocab("w2", "spice", cn: "香料"), zh: "香料"),
        ]
        let turns = [
            SpeakTurn(role: .assistant, text: "Hi!", at: 1),
            SpeakTurn(role: .user, text: "I was unwinding after work", at: 2),  // 命中 w1（屈折）
            SpeakTurn(role: .assistant, text: "Nice.", at: 3),
            SpeakTurn(role: .user, text: "nothing relevant", at: 4),
        ]
        XCTAssertEqual(speakHitTargetIds(turns: turns, targets: targets), ["w1"])
        // 重开会话（同一 turns）打勾状态保真
        XCTAssertEqual(speakHitTargetIds(turns: turns, targets: targets), ["w1"])
    }

    // MARK: SPEAK-1 - 「聊刚读的章节」卡的数据派生

    func testSpeakBookContextDerivation() throws {
        let article = Article(
            id: "art-1", title: "Chapter 1", createdAt: 1, lastReadAt: 1,
            sentences: (0..<5).map { SentencePair(idx: $0, paragraphIdx: 0, en: "Sentence number \($0).") },
            bookId: "book-1", chapterIdx: 3
        )
        let book = BookMeta(
            id: "book-1", title: "Dune", createdAt: 1, lastReadAt: 1,
            chapters: (0..<6).map { BookChapterMeta(id: "c\($0)", title: "Ch\($0)", wordCount: 1, sentenceCount: 1) },
            progress: BookProgress(chapterId: "c3"), radar: BookRadar(kaoyan: 0, cet4: 0, cet6: 0)
        )
        let ctx = try XCTUnwrap(speakBookContext(article: article, book: book))
        guard case let .book(title, articleId, chapterIdx, excerpt) = ctx else {
            return XCTFail("应为 book 语境")
        }
        XCTAssertEqual(title, "Dune")
        XCTAssertEqual(articleId, "art-1")
        XCTAssertEqual(chapterIdx, 3)
        XCTAssertEqual(excerpt, ["Sentence number 0.", "Sentence number 1.", "Sentence number 2."])  // 前三句

        // 短文（无 bookId）：不给假上下文
        let plain = Article(id: "art-2", title: "T", createdAt: 1, lastReadAt: 1, sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: "s")])
        XCTAssertNil(speakBookContext(article: plain, book: book))
        XCTAssertNil(speakBookContext(article: nil, book: book))
    }

    func testSpeakBookContextFallsBackToTitleWhenNoSentences() throws {
        let article = Article(id: "art-1", title: "Only Title", createdAt: 1, lastReadAt: 1, bookId: "book-1", chapterIdx: 0)
        let book = BookMeta(
            id: "book-1", title: "B", createdAt: 1, lastReadAt: 1,
            chapters: [BookChapterMeta(id: "art-1", title: "c", wordCount: 1, sentenceCount: 1)],
            progress: BookProgress(chapterId: "art-1"), radar: BookRadar(kaoyan: 0, cet4: 0, cet6: 0)
        )
        let ctx = try XCTUnwrap(speakBookContext(article: article, book: book))
        guard case let .book(_, _, _, excerpt) = ctx else { return XCTFail() }
        XCTAssertEqual(excerpt, ["Only Title"])
    }

    func testSpeakSceneTitleContextAware() {
        let book = SpeakSession(
            id: "s1", scenario: .smalltalk, difficulty: .medium, turns: [], createdAt: 1, updatedAt: 1,
            context: .book(bookTitle: "Dune", chapterArticleId: "a", chapterIdx: 1, excerpt: [])
        )
        XCTAssertEqual(speakSceneTitle(book), "聊刚读的《Dune》第 2 章")
        let vocab = SpeakSession(id: "s2", scenario: .smalltalk, difficulty: .easy, turns: [], createdAt: 1, updatedAt: 1, context: .vocab(wordIds: []))
        XCTAssertEqual(speakSceneTitle(vocab), "今日生词造句闯关")
        let plain = SpeakSession(id: "s3", scenario: .interview, difficulty: .hard, turns: [], createdAt: 1, updatedAt: 1)
        XCTAssertEqual(speakSceneTitle(plain), "英文面试")
    }

    // MARK: - 落盘兼容

    func testLastAssistantText() {
        let turns = [
            SpeakTurn(role: .assistant, text: "First.", at: 1),
            SpeakTurn(role: .user, text: "ok", at: 2),
            SpeakTurn(role: .assistant, text: "Second.", at: 3),
        ]
        XCTAssertEqual(lastAssistantText(turns), "Second.")
        XCTAssertNil(lastAssistantText([SpeakTurn(role: .user, text: "x", at: 4)]))
    }

    func testSpeakSessionCodableRoundtrip() throws {
        var turn = SpeakTurn(role: .assistant, text: "Hello", hintZh: "你好", at: 42)
        turn.shadowScore = 4.3
        let session = SpeakSession(
            id: "s1", scenario: .smalltalk, difficulty: .hard,
            turns: [turn, SpeakTurn(role: .user, text: "hi", at: 43)],
            createdAt: 42, updatedAt: 43
        )
        let encoder = JSONEncoder()
        let data = try encoder.encode(session)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"hintZh\""))
        XCTAssertTrue(json.contains("\"shadowScore\""))
        XCTAssertTrue(json.contains("\"smalltalk\""))
        XCTAssertTrue(json.contains("\"createdAt\""))
        XCTAssertFalse(json.contains("\"context\""))  // 无语境不写 context 键
        XCTAssertFalse(json.contains("\"role\":\"assistant\",\"text\":\"hi\""))  // user 轮无 hint
        let back = try JSONDecoder().decode(SpeakSession.self, from: data)
        XCTAssertEqual(back, session)
    }

    /// 老会话 JSON（无 context / 无 pron / 无 coachDiff）必须原样可读。
    func testSpeakSessionDecodesLegacyJsonWithoutNewFields() throws {
        let json = """
        {"id":"s1","scenario":"smalltalk","difficulty":"hard",
         "turns":[{"role":"user","text":"hi","at":43},
                  {"role":"assistant","text":"Hello","hintZh":"你好","at":44,"shadowScore":4.0}],
         "createdAt":42,"updatedAt":43}
        """
        let session = try JSONDecoder().decode(SpeakSession.self, from: Data(json.utf8))
        XCTAssertNil(session.context)
        XCTAssertNil(session.turns[0].pron)
        XCTAssertNil(session.turns[0].coachDiff)
        XCTAssertEqual(session.turns[1].shadowScore, 4.0)
    }

    func testSpeakSessionContextCodableRoundtrip() throws {
        let book: SpeakSessionContext = .book(bookTitle: "Dune", chapterArticleId: "a", chapterIdx: 2, excerpt: ["x", "y"])
        let vocab: SpeakSessionContext = .vocab(wordIds: ["w1"])
        for ctx in [book, vocab] {
            let session = SpeakSession(id: "s", scenario: .smalltalk, difficulty: .easy, turns: [], createdAt: 1, updatedAt: 1, context: ctx)
            let data = try JSONEncoder().encode(session)
            let back = try JSONDecoder().decode(SpeakSession.self, from: data)
            XCTAssertEqual(back.context, ctx)
        }
        // kind 判别式落盘形状
        let data = try JSONEncoder().encode(book)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"kind\":\"book\""))
        XCTAssertTrue(json.contains("\"chapterArticleId\""))
    }

    /// SPEAK-4：user 轮 pron（ShadowAttempt 形状）落盘 + 老数据无 pron 可读。
    func testSpeakTurnPronCodableRoundtrip() throws {
        let attempt = ShadowAttempt(
            at: 99, total: 4.1, accuracy: 4.0, fluency: 4.2, integrity: 4.4,
            words: [ShadowWord(content: "hello", totalScore: 4.5, dpMessage: 0, sylls: [
                ShadowSyll(content: "hɛ", syllScore: 4.4, serrMsg: 0, phones: [ShadowPhone(content: "hh", dpMessage: 0, gwpp: -0.2)])
            ])]
        )
        let turn = SpeakTurn(role: .user, text: "hello there", pron: attempt, at: 7)
        let data = try JSONEncoder().encode(turn)
        XCTAssertTrue(String(data: data, encoding: .utf8)!.contains("\"pron\""))
        let back = try JSONDecoder().decode(SpeakTurn.self, from: data)
        XCTAssertEqual(back.pron, attempt)
    }

    func testSpeakSessionsFileToleratesMissingFields() throws {
        let json = #"{"schemaVersion":1,"sessions":[]}"#
        let file = try JSONDecoder().decode(SpeakSessionsFile.self, from: Data(json.utf8))
        XCTAssertEqual(file.schemaVersion, 1)
        XCTAssertTrue(file.sessions.isEmpty)
    }

    // MARK: SPEAK-4 - 逐词得分曲线

    func testWordScorePathGeometry() {
        let words = [
            ShadowWord(content: "a", totalScore: 5, dpMessage: 0),
            ShadowWord(content: "b", totalScore: 0, dpMessage: 0),
            ShadowWord(content: "c", totalScore: 2.5, dpMessage: 0),
        ]
        let path = wordScorePath(words)
        XCTAssertEqual(path.width, 272)
        XCTAssertEqual(path.height, 64)
        XCTAssertEqual(path.baselineY, 10)
        XCTAssertEqual(path.points.count, 3)
        // 等距横排 [12, 260]；分数越高 y 越小（5 分贴基准线，0 分贴底）
        XCTAssertEqual(path.points[0].x, 12, accuracy: 0.001)
        XCTAssertEqual(path.points[2].x, 260, accuracy: 0.001)
        XCTAssertEqual(path.points[1].x, 136, accuracy: 0.001)
        XCTAssertEqual(path.points[0].y, 10, accuracy: 0.001)
        XCTAssertEqual(path.points[1].y, 54, accuracy: 0.001)
        XCTAssertEqual(path.points[2].y, 32, accuracy: 0.001)
    }

    func testWordScorePathSingleWordCenteredAndClamped() {
        let path = wordScorePath([ShadowWord(content: "x", totalScore: 9, dpMessage: 0)])
        XCTAssertEqual(path.points.count, 1)
        XCTAssertEqual(path.points[0].x, 136, accuracy: 0.001)  // 居中
        XCTAssertEqual(path.points[0].y, 10, accuracy: 0.001)   // 超过 5 分按 5 封顶
        let empty = wordScorePath([])
        XCTAssertTrue(empty.points.isEmpty)
    }
}
