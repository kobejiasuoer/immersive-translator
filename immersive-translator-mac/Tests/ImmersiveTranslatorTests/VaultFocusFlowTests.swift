import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 专注复习（focus 态）流程向量（§2.4 测试组 4；对齐 Windows VaultPage.test.tsx「focus」组）：
/// - 轮转顺序 cloze → dictation → speak；原句缺失降级开口卡；
/// - 完形判分 → 建议档（一次写对收敛 good，不是 easy）→ Enter 采纳 → 落盘 good；
/// - 「我不会」→ wrong，数字 2 → hard；放弃不评分且 pos 绕回；队列耗尽 pos=0；
/// - 开口命中 → easy + spokenAt（gradeSpoken）；gradedRef 防重入同卡只评一次。
final class VaultFocusFlowTests: XCTestCase {
    private final class StubChat: ReaderChatChannel {
        var glossaryText: String { "" }
        var customStyle: String { "" }
        func configuration() throws -> ReaderChatClient.Configuration {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
        func resolveTarget(for sample: String) -> String { "简体中文" }
        func complete(systemPrompt: String, userText: String) async throws -> String { "" }
        func completeStreaming(
            systemPrompt: String,
            userText: String,
            onDelta: @escaping (String) -> Void
        ) async throws -> String {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
    }

    private let nowMs = Int64(Date().timeIntervalSince1970 * 1000)

    @MainActor
    private func makeVM() -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vault-focus-flow-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: dir))
    }

    /// 带原句的到期词（articleId → sourceCache 里的文章）。
    @MainActor
    private func seed(_ vm: ReaderViewModel, words: [(id: String, word: String, articleId: String)], sentence: String) throws {
        for (i, w) in words.enumerated() {
            let v = VocabWord(
                id: w.id,
                word: w.word,
                kind: .word,
                senses: [VocabSense(pos: "v.", cn: "放松")],
                source: VocabSource(articleId: w.articleId, sentenceIdx: 0),
                srs: VocabSrsState(dueAt: nowMs - 10_000 - Int64(i)),
                addedAt: nowMs
            )
            try vm.store.saveVocabWord(v)
        }
        for w in words where !w.articleId.isEmpty {
            vm.sourceCache[w.articleId] = Article(
                id: w.articleId,
                title: "Focus Article",
                createdAt: 0,
                lastReadAt: 0,
                sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: sentence, zh: "译文一句", zhState: .done)]
            )
        }
        vm.refreshVocab()
    }

    private func keyDown(_ keyCode: UInt16, _ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode
        )!
    }

    private var enter: NSEvent { keyDown(36, "\r") }
    private var tab: NSEvent { keyDown(48, "\t") }
    private var two: NSEvent { keyDown(19, "2") }

    // MARK: - 轮转与降级（纯逻辑）

    func testRotationOrderClozeDictationSpeak() {
        XCTAssertEqual(vaultFocusRotation, [.cloze, .dictation, .speak])
        XCTAssertEqual(vaultFocusDesiredKind(step: 0), .cloze)
        XCTAssertEqual(vaultFocusDesiredKind(step: 1), .dictation)
        XCTAssertEqual(vaultFocusDesiredKind(step: 2), .speak)
        XCTAssertEqual(vaultFocusDesiredKind(step: 3), .cloze, "按 step 轮转")
    }

    func testEffectiveKindDowngradesToSpeakWithoutSentence() {
        // 原句缺失：完形/听写降级为开口卡；原句定位不到目标词：完形降级开口，听写照旧。
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .cloze, hasSentence: false, blankFound: false), .speak)
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .dictation, hasSentence: false, blankFound: false), .speak)
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .cloze, hasSentence: true, blankFound: false), .speak)
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .cloze, hasSentence: true, blankFound: true), .cloze)
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .dictation, hasSentence: true, blankFound: false), .dictation)
        XCTAssertEqual(vaultFocusEffectiveKind(desired: .speak, hasSentence: true, blankFound: true), .speak)
    }

    func testSessionGradeIsIdempotentPerCardAndAdvancesStep() {
        var session = VaultFocusSession()
        XCTAssertTrue(session.grade(wordId: "w1", word: "unwind", grade: .good))
        XCTAssertEqual(session.outcome?.text, "已按「记住了」完成")
        XCTAssertEqual(session.step, 1)
        // 防重入：同一卡第二次评分被忽略。
        XCTAssertFalse(session.grade(wordId: "w1", word: "unwind", grade: .forgot))
        XCTAssertEqual(session.step, 1)
        XCTAssertEqual(session.outcome?.text, "已按「记住了」完成")
    }

    func testSessionSkipKeepsWordAndWrapsPos() {
        var session = VaultFocusSession()
        XCTAssertEqual(session.skip(word: "unwind", pos: 0, total: 3), 1, "放弃推进游标")
        XCTAssertEqual(session.outcome, VaultFocusSession.Outcome(word: "unwind", text: "跳过（未评分）"))
        XCTAssertEqual(session.skip(word: "calm", pos: 2, total: 3), 0, "末尾回绕到 0")
        XCTAssertEqual(session.step, 2)
        XCTAssertEqual(VaultFocusSession.settledPos(3, total: 3), 0, "队列耗尽收拢 pos=0")
        XCTAssertEqual(VaultFocusSession.settledPos(1, total: 3), 1)
    }

    func testFocusTopProgressAndCounterText() {
        XCTAssertEqual(VaultFocusSession.progressPercent(pos: 0, total: 4), 25)
        XCTAssertEqual(VaultFocusSession.progressPercent(pos: 9, total: 4), 100)
        XCTAssertEqual(VaultFocusSession.progressPercent(pos: 0, total: 0), 0)
        XCTAssertEqual(VaultFocusSession.counterText(pos: 0, total: 4), "1 / 4")
        XCTAssertEqual(VaultFocusSession.counterText(pos: 0, total: 0), "1 / 0")
    }

    // MARK: - 模型 + vm 集成：完形判分 → 建议档 → Enter 采纳（good，不是 easy）

    @MainActor
    func testClozeSubmitThenEnterAdoptsGoodNotEasy() throws {
        let vm = makeVM()
        try seed(vm, words: [("unwind", "unwind", "art-1")], sentence: "Time will unwind slowly in the mountains.")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.queue.map(\.id), ["unwind"])
        XCTAssertEqual(model.effectiveKind(vm: vm), .cloze, "第一关期望完形且原句能定位 → 完形卡")
        let spec = try XCTUnwrap(model.spec(vm: vm))
        XCTAssertEqual(spec.blank, "unwind")

        // 输入挖空并提交：一次写对。
        model.input = "unwind"
        model.submitCloze(vm: vm)
        XCTAssertEqual(model.verdict, .perfect)
        XCTAssertEqual(vaultSuggested(.perfect), .good, "建议档「记住了」+ 3 天（不是 easy）")

        // 全局 Enter 采纳建议档。
        XCTAssertTrue(model.handleKey(enter, vm: vm, typing: false))
        XCTAssertEqual(model.session.outcome?.text, "已按「记住了」完成")
        let graded = try XCTUnwrap(vm.vocabWords.first { $0.id == "unwind" })
        XCTAssertEqual(graded.srs.intervalDays, 3, "onGrade(word, good) 落盘：good = 3 天")
        XCTAssertNil(graded.spokenAt, "普通评分不记口语表达")
        // onRecall("unwind","cloze","perfect","good")：错题桶按 cloze 模式记一次 pass。
        XCTAssertEqual(graded.recall?.total.pass ?? 0, 1)
        XCTAssertEqual(graded.recall?.byMode["cloze"]?.pass ?? 0, 1)
        // 评分即出队：队列空 → 完成态，pos 收拢 0。
        XCTAssertTrue(model.queue.isEmpty)
        XCTAssertEqual(model.pos, 0)
        XCTAssertNil(model.current)
    }

    @MainActor
    func testGiveUpThenDigitTwoGradesHard() throws {
        let vm = makeVM()
        try seed(vm, words: [("unwind", "unwind", "art-1")], sentence: "Time will unwind slowly in the mountains.")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        // 「我不会」→ verdict wrong → 建议「没记住」。
        model.verdict = .wrong
        XCTAssertEqual(vaultSuggested(.wrong), .forgot)
        // 数字 2 直选「有点模糊」= hard。
        XCTAssertTrue(model.handleKey(two, vm: vm, typing: false))
        let graded = try XCTUnwrap(vm.vocabWords.first { $0.id == "unwind" })
        XCTAssertEqual(graded.srs.intervalDays, 1, "hard = 1 天")
        XCTAssertEqual(model.session.outcome?.text, "已按「有点模糊」完成")
    }

    @MainActor
    func testTabRevealsTwoHintLevelsOnlyWhileCloze() throws {
        let vm = makeVM()
        try seed(vm, words: [("unwind", "unwind", "art-1")], sentence: "Time will unwind slowly in the mountains.")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        // Tab 不受 typing 守卫（输入框里打字时也是「下一级提示」）。
        XCTAssertTrue(model.handleKey(tab, vm: vm, typing: true))
        XCTAssertEqual(model.hints, 1)
        XCTAssertTrue(model.handleKey(tab, vm: vm, typing: true))
        XCTAssertEqual(model.hints, 2)
        XCTAssertFalse(model.handleKey(tab, vm: vm, typing: false), "两级提示到顶不再消费")
        // 提示 2 = 首字母与长度（不露答案）。
        let spec = try XCTUnwrap(model.spec(vm: vm))
        XCTAssertEqual(firstLetters(spec.blank), "u…")
        XCTAssertFalse(firstLetters(spec.blank).contains("unwind"))
    }

    @MainActor
    func testSpeakCardPassGradesEasyWithSpokenAt() throws {
        let vm = makeVM()
        // 无原句、无例句 → 第一关降级开口卡。
        try seed(vm, words: [("unwind", "unwind", "")], sentence: "")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.effectiveKind(vm: vm), .speak, "原句缺失词第一关落开口卡")
        XCTAssertTrue(model.passSpeak(vm: vm))
        XCTAssertEqual(model.session.outcome?.text, "开口命中 · 已按「很轻松」完成并记一次口语表达")
        let graded = try XCTUnwrap(vm.vocabWords.first { $0.id == "unwind" })
        XCTAssertEqual(graded.srs.intervalDays, 7, "onSpokenGrade(word, easy) = 7 天")
        XCTAssertNotNil(graded.spokenAt, "记一次口语表达")
        // 防重入：同卡不再评。
        XCTAssertFalse(model.passSpeak(vm: vm))
    }

    @MainActor
    func testSkipDoesNotGradeAndWrapsToQueueHead() throws {
        let vm = makeVM()
        try seed(vm, words: [("w1", "unwind", ""), ("w2", "calm", "")], sentence: "")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.queue.count, 2)
        let before = vm.vocabWords.map { $0.srs.intervalDays }
        model.skip(vm: vm)
        XCTAssertEqual(model.pos, 1, "放弃推进到下一关")
        XCTAssertEqual(model.session.outcome?.text, "跳过（未评分）")
        XCTAssertEqual(vm.vocabWords.map { $0.srs.intervalDays }, before, "放弃不评分、不落盘")
        XCTAssertEqual(model.queue.count, 2, "词不离队")
        model.skip(vm: vm)
        XCTAssertEqual(model.pos, 0, "末尾放弃 onSetPos(0) 绕回队首")
    }

    @MainActor
    func testGradeDrainsFocusIdsBatch() throws {
        let vm = makeVM()
        try seed(vm, words: [("w1", "unwind", ""), ("w2", "calm", "")], sentence: "")
        vm.startFocusReview(ids: ["w1", "w2"])
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.queue.map(\.id), ["w1", "w2"], "focusIds 非空时队列 = 该批词（无视到期）")
        XCTAssertTrue(model.grade(.good, vm: vm))
        XCTAssertEqual(vm.focusReviewIds, ["w2"], "评分即出加练批次（gradeAndDrainFocus）")
        XCTAssertEqual(model.queue.map(\.id), ["w2"])
        XCTAssertEqual(model.pos, 0)
    }
}
