import XCTest
import ReaderCore
import XfyunCore
@testable import ImmersiveTranslator

/// 口语对话环的会话纪元（epoch）竞态回归（SPEAK-10）：模拟「开会 → 在途 ASR/LLM/ISE
/// → backToEntry/start/resume/skipReply 自增纪元 → 旧结果被丢弃」的时序；以及静音
/// 兜底回 idle+toast（不进 error）、跳过回复的可见反馈、末轮用户话在 LLM 输入里只出现
/// 一次（控制器级快照）。
///
/// 不碰物理麦克风 / 合成引擎 / Keychain：ASR 走 transcribeProvider、ISE 走 assessProvider、
/// 播报走 SpeechSink.silent、落盘走临时目录 SpeakStore；录音收尾走
/// simulateRecordedUtteranceForTesting（与生产 finishUtterance 共用 processUtterance 路径：
/// 纪元自增 → 静音兜底 → ASR → 纪元校验 → 用户轮 → LLM/ISE）。
final class SpeakViewControllerRaceTests: XCTestCase {
    /// FIFO 闸门：异步通道在 wait() 处悬停，测试用 open(_:) 按序放行一个等待者——
    /// 这就是「在途请求」的可控替身。
    private actor Gate<Value> {
        private var waiters: [CheckedContinuation<Value, Error>] = []
        private var backlog: [Value] = []

        func wait() async throws -> Value {
            if !backlog.isEmpty { return backlog.removeFirst() }
            return try await withCheckedThrowingContinuation { waiters.append($0) }
        }

        func open(_ value: Value) {
            if waiters.isEmpty {
                backlog.append(value)
            } else {
                waiters.removeFirst().resume(returning: value)
            }
        }

        var waiting: Int { waiters.count }
    }

    /// 旁路观察：toast 文案、送 LLM 的 system/input。
    private final class Probe {
        var toasts: [String] = []
        var chatSystems: [String] = []
        var chatInputs: [String] = []
    }

    private final class Counter {
        var n = 0
    }

    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    /// 1s 有声样本（峰值 0.2 ≥ 0.01，长度 ≥ 0.5s）。
    private let loud = [Float](repeating: 0.2, count: 16_000)
    /// 1s 全静音样本。
    private let silence = [Float](repeating: 0, count: 16_000)

    private func iseFixture(total: Double) -> PronunciationResult {
        PronunciationResult(
            total: total, accuracy: total, fluency: total, standard: total, integrity: 5,
            isRejected: false, exceptInfo: nil,
            words: [WordScore(content: "hello", totalScore: total, dpMessage: 0)]
        )
    }

    @MainActor
    private func makeController() -> (SpeakViewController, Probe) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("speak-race-\(UUID().uuidString)", isDirectory: true)
        tmpDirs.append(dir)
        let controller = SpeakViewController(store: SpeakStore(baseDirectory: dir), speech: .silent)
        let probe = Probe()
        controller.attach(SpeakViewController.Dependencies(
            vocabWords: { [] },
            gradeSpokenVocab: { _ in },
            toast: { probe.toasts.append($0) }
        ))
        return (controller, probe)
    }

    /// 轮询等待主线程条件成立（最多 timeoutMs），超时记失败。
    @MainActor
    private func waitUntil(_ what: String, timeoutMs: Int = 2_000, _ cond: @escaping @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while !cond(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(cond(), "等待超时：\(what)")
    }

    /// 等闸门上挂到 n 个等待者（保证注册顺序 = 放行顺序）。
    private func waitWaiters<V>(_ gate: Gate<V>, _ n: Int, _ what: String) async {
        for _ in 0..<400 {
            if await gate.waiting >= n { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let count = await gate.waiting
        XCTAssertEqual(count, n, "等待超时：\(what)")
    }

    /// 让在途任务跑完（续体恢复 → MainActor hop → 落盘）。
    private func settle() async {
        try? await Task.sleep(nanoseconds: 80_000_000)
    }

    // MARK: - 在途 ASR × 切场景

    /// 开会 A → 收麦（ASR 在途）→ backToEntry → start B → 旧 ASR 才返回：
    /// 旧结果既不进 B（纪元不符被丢弃），也不改 phase。
    @MainActor
    func testStaleAsrAfterBackToEntryAndStartIsDropped() async throws {
        let (c, probe) = makeController()
        let asr = Gate<String>()
        let chatCalls = Counter()
        c.transcribeProvider = { _ in try await asr.wait() }
        c.chatProvider = { _, _, _ in chatCalls.n += 1; return "EN: never\nZH: 不应到达" }

        c.start(scenario: .ordering, difficulty: .medium)
        let sessionA = try XCTUnwrap(c.session?.id)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        XCTAssertEqual(c.phase, .transcribing)
        let epochDuringAsr = c.currentEpoch
        await waitWaiters(asr, 1, "旧轮 ASR 挂起")

        // 在途 ASR 期间切场景并开新会话
        c.backToEntry()
        XCTAssertNil(c.session)
        XCTAssertEqual(c.phase, .entry)
        c.start(scenario: .travel, difficulty: .easy)
        let sessionB = try XCTUnwrap(c.session?.id)
        XCTAssertNotEqual(sessionA, sessionB)
        XCTAssertGreaterThan(c.currentEpoch, epochDuringAsr, "backToEntry/start 都应自增纪元")

        // 旧轮 ASR 这才返回
        await asr.open("I would like a table for two")
        await settle()

        XCTAssertEqual(c.session?.id, sessionB)
        XCTAssertEqual(c.session?.turns.count, 1, "新会话只有开场白：旧 ASR 的 user 轮没有写进来")
        XCTAssertFalse(c.session?.turns.contains { $0.role == .user } ?? true)
        XCTAssertEqual(chatCalls.n, 0, "旧 ASR 被丢弃后不应再请求 LLM")
        XCTAssertEqual(c.phase, .idleTurn, "旧轮结果不得把新会话的状态拖回 transcribing/thinking")
        // 落盘同样干净
        let storedB = try c.store.listSessions().first { $0.id == sessionB }
        XCTAssertEqual(storedB?.turns.count, 1)
        XCTAssertTrue(probe.toasts.isEmpty)
    }

    /// 开会 A → 收麦（ASR 在途）→ backToEntry → resume(其他会话) → 旧 ASR 返回：重开的会话不受影响。
    @MainActor
    func testStaleAsrAfterResumeOtherSessionIsDropped() async throws {
        let (c, _) = makeController()
        let asr = Gate<String>()
        c.transcribeProvider = { _ in try await asr.wait() }

        c.start(scenario: .smalltalk, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitWaiters(asr, 1, "旧轮 ASR 挂起")

        let other = SpeakSession(
            id: "other-session", scenario: .interview, difficulty: .hard,
            turns: [
                SpeakTurn(role: .assistant, text: "Tell me about yourself.", at: 1),
                SpeakTurn(role: .user, text: "I am a developer.", at: 2),
                SpeakTurn(role: .assistant, text: "Great.", at: 3),
            ],
            createdAt: 1, updatedAt: 3
        )
        c.backToEntry()
        c.resume(other)
        XCTAssertEqual(c.phase, .idleTurn)

        await asr.open("stale words")
        await settle()

        XCTAssertEqual(c.session?.id, "other-session")
        XCTAssertEqual(c.session?.turns.map(\.text), ["Tell me about yourself.", "I am a developer.", "Great."])
        XCTAssertEqual(c.phase, .idleTurn)
    }

    // MARK: - 在途 LLM × 切场景 / 跳过

    /// 开会 A → 用户轮落盘、LLM 在途（thinking）→ backToEntry → start B → 旧回复才到：
    /// B 里不出现旧 assistant 轮。顺带断言送 LLM 的输入里末轮用户话只出现一次、系统提示为四行格式。
    @MainActor
    func testStaleLlmReplyAfterSceneSwitchIsNotAppended() async throws {
        let (c, probe) = makeController()
        let chat = Gate<String>()
        c.transcribeProvider = { _ in "I want coffee" }
        c.chatProvider = { system, input, _ in
            probe.chatSystems.append(system)
            probe.chatInputs.append(input)
            return try await chat.wait()
        }

        c.start(scenario: .ordering, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("进入 thinking") { c.phase == .thinking }
        XCTAssertEqual(c.session?.turns.count, 2, "开场白 + 用户轮")
        XCTAssertEqual(c.session?.turns.last?.role, .user)
        XCTAssertEqual(c.session?.turns.last?.text, "I want coffee")

        // SPEAK-10 #2：末轮用户话在 LLM 输入里只出现一次（控制器级快照）
        let input = try XCTUnwrap(probe.chatInputs.first)
        XCTAssertEqual(input.components(separatedBy: "I want coffee").count - 1, 1, "末轮用户话重复：\n\(input)")
        XCTAssertTrue(input.hasSuffix("请给出你的下一轮回复（EN: / ZH: / BETTER: / TIP: 四行）。"))
        XCTAssertTrue(probe.chatSystems.first?.contains("\"BETTER: \"") ?? false)
        await waitWaiters(chat, 1, "旧轮 LLM 挂起")

        // 切场景 + 开新会话，旧 LLM 仍在途
        c.backToEntry()
        c.start(scenario: .travel, difficulty: .easy)
        let sessionB = try XCTUnwrap(c.session?.id)

        await chat.open("EN: Stale reply from the old scene.\nZH: 旧\nBETTER: x\nTIP: y")
        await settle()

        XCTAssertEqual(c.session?.id, sessionB)
        XCTAssertEqual(c.session?.turns.count, 1)
        XCTAssertFalse(c.session?.turns.contains { $0.text.contains("Stale") } ?? true)
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(c.streaming, SpeakViewController.StreamingReply())
    }

    /// 纪元守卫的独立层（不靠 Task 取消）：A 在 thinking（回复 1 在途、未被取消）时又收了一轮
    /// 发言——processUtterance 自增纪元但不取消 replyTask——回复 1 迟到时被纪元丢弃，
    /// 回复 2 正常落盘。
    @MainActor
    func testEpochGuardDropsStaleLlmReplyEvenWithoutCancellation() async throws {
        let (c, probe) = makeController()
        let chat = Gate<String>()
        let asrTexts = ["I want coffee", "Make it two"]
        let asrIdx = Counter()
        c.transcribeProvider = { _ in
            defer { asrIdx.n += 1 }
            return asrTexts[min(asrIdx.n, asrTexts.count - 1)]
        }
        c.chatProvider = { _, input, _ in
            probe.chatInputs.append(input)
            return try await chat.wait()
        }

        c.start(scenario: .smalltalk, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("回复 1 在途") { c.phase == .thinking && probe.chatInputs.count == 1 }
        await waitWaiters(chat, 1, "回复 1 挂起")
        let epochOfReply1 = c.currentEpoch

        try? await Task.sleep(nanoseconds: 5_000_000)  // 两轮 user.at 必不同
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("回复 2 在途") { probe.chatInputs.count == 2 }
        await waitWaiters(chat, 2, "回复 2 挂起")
        XCTAssertGreaterThan(c.currentEpoch, epochOfReply1, "新一轮发言自增纪元")
        XCTAssertEqual(Array(c.session?.turns.dropFirst().map(\.text) ?? []), ["I want coffee", "Make it two"])

        // 回复 1（旧纪元）先到 → 丢弃；回复 2 后到 → 落盘
        await chat.open("EN: Stale reply.\nZH: 旧")
        await settle()
        XCTAssertEqual(c.session?.turns.count, 3, "旧纪元回复不得追加 assistant 轮")
        XCTAssertEqual(c.phase, .thinking, "仍在等回复 2")

        await chat.open("EN: Fresh reply.\nZH: 新\nBETTER: Could I have two, please?\nTIP: 更客气")
        await settle()
        XCTAssertEqual(c.session?.turns.count, 4)
        XCTAssertEqual(c.session?.turns.last?.role, .assistant)
        XCTAssertEqual(c.session?.turns.last?.text, "Fresh reply.")
        XCTAssertFalse(c.session?.turns.contains { $0.text.contains("Stale") } ?? true)
        // BETTER/TIP 回写到了末轮 user（第 2 轮）而不是第 1 轮
        XCTAssertNotNil(c.session?.turns[2].coachDiff)
        XCTAssertNil(c.session?.turns[1].coachDiff)
        XCTAssertEqual(c.phase, .idleTurn)
    }

    /// thinking 中 skipReply：掐掉在途回复、回 idle、给可见反馈；迟到的回复不追加。
    @MainActor
    func testSkipReplyDropsInFlightReplyAndToasts() async throws {
        let (c, probe) = makeController()
        let chat = Gate<String>()
        c.transcribeProvider = { _ in "Hello there" }
        c.chatProvider = { _, _, _ in try await chat.wait() }

        c.start(scenario: .travel, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("进入 thinking") { c.phase == .thinking }
        await waitWaiters(chat, 1, "LLM 挂起")
        let epochBeforeSkip = c.currentEpoch

        c.skipReply()
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertGreaterThan(c.currentEpoch, epochBeforeSkip)
        XCTAssertEqual(probe.toasts, ["已跳过这次回复，接着说下一句"])
        XCTAssertEqual(c.streaming, SpeakViewController.StreamingReply())

        await chat.open("EN: Too late.\nZH: 迟到")
        await settle()
        XCTAssertEqual(c.session?.turns.count, 2, "跳过后迟到的回复不追加")
        XCTAssertEqual(c.phase, .idleTurn)
        // 非 thinking 态再点跳过：无副作用
        c.skipReply()
        XCTAssertEqual(probe.toasts.count, 1)
    }

    // MARK: - 静音兜底 / 空识别（SPEAK-10 #3）

    /// 没说到话 / 太短：回 idle + toast，不进 error；不请求 ASR。
    @MainActor
    func testSilenceFallbackReturnsIdleWithToastNotError() async throws {
        let (c, probe) = makeController()
        let asrCalls = Counter()
        c.transcribeProvider = { _ in asrCalls.n += 1; return "should not be called" }
        c.start(scenario: .smalltalk, difficulty: .medium)
        await waitUntil("开场白播完回 idle") { c.phase == .idleTurn }

        // 开过口但静音
        c.simulateRecordedUtteranceForTesting(samples: silence, everStarted: true)
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(probe.toasts.last, "没听到声音——离麦克风近一点再说一次")
        // 一直没开口（VAD 8s 提前收）
        c.simulateRecordedUtteranceForTesting(samples: silence, everStarted: false)
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(probe.toasts.last, "一直没听到你说话——检查一下麦克风再试")
        // 有声但太短（< 0.5s）
        c.simulateRecordedUtteranceForTesting(samples: [Float](repeating: 0.3, count: 2_000), everStarted: true)
        XCTAssertEqual(c.phase, .idleTurn)

        await settle()
        XCTAssertEqual(asrCalls.n, 0, "静音兜底不应烧识别次数")
        XCTAssertEqual(c.session?.turns.count, 1, "静音不算一轮")
        if case .error = c.phase { XCTFail("静音兜底不得进 error") }
    }

    /// ASR 返回空白：回 idle + toast，不进 error，不请求 LLM。
    @MainActor
    func testEmptyAsrResultReturnsIdleWithToast() async throws {
        let (c, probe) = makeController()
        let chatCalls = Counter()
        c.transcribeProvider = { _ in "   " }
        c.chatProvider = { _, _, _ in chatCalls.n += 1; return "" }
        c.start(scenario: .ordering, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("空识别回 idle") { c.phase == .idleTurn && !probe.toasts.isEmpty }
        XCTAssertEqual(probe.toasts.last, "没识别出内容，再试一次（尽量用完整的英语句子）")
        XCTAssertEqual(c.session?.turns.count, 1)
        XCTAssertEqual(chatCalls.n, 0)
    }

    // MARK: - 在途 ISE × 切场景 / 同会话迟到

    /// A 的 pron 评测在途时切到 B：旧评测返回后不写进 B，也不写回落盘的 A。
    @MainActor
    func testStaleIseResultAfterSceneSwitchIsNotWritten() async throws {
        let (c, _) = makeController()
        let ise = Gate<PronunciationResult>()
        c.transcribeProvider = { _ in "Hello there" }
        c.chatProvider = { _, _, _ in "EN: Hi!\nZH: 嗨" }
        c.assessProvider = { _, _ in try await ise.wait() }

        c.start(scenario: .smalltalk, difficulty: .medium)
        let sessionA = try XCTUnwrap(c.session?.id)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("A 完成一轮") { c.session?.turns.count == 3 }
        await waitWaiters(ise, 1, "ISE 挂起")

        c.backToEntry()
        c.start(scenario: .travel, difficulty: .easy)
        let sessionB = try XCTUnwrap(c.session?.id)

        await ise.open(iseFixture(total: 4.4))
        await settle()

        XCTAssertEqual(c.session?.id, sessionB)
        XCTAssertEqual(c.session?.turns.count, 1)
        XCTAssertTrue(c.session?.turns.allSatisfy { $0.pron == nil } ?? false)
        let storedA = try c.store.listSessions().first { $0.id == sessionA }
        XCTAssertNotNil(storedA)
        XCTAssertTrue(storedA?.turns.allSatisfy { $0.pron == nil } ?? false, "旧评测不得越过会话切换写回 A")
    }

    /// 同一会话里用户已接着说第二句：迟到的第一句评测仍落回第一句自己的 user 轮
    /// （按 会话 id + 轮次 at 定位，而不是「最后一个 user 轮」）。
    @MainActor
    func testLateIseResultLandsOnItsOwnTurnWithinSameSession() async throws {
        let (c, _) = makeController()
        let ise = Gate<PronunciationResult>()
        let asrTexts = ["First sentence", "Second sentence"]
        let asrIdx = Counter()
        c.transcribeProvider = { _ in
            defer { asrIdx.n += 1 }
            return asrTexts[min(asrIdx.n, asrTexts.count - 1)]
        }
        c.chatProvider = { _, _, _ in "EN: Go on.\nZH: 继续" }
        c.assessProvider = { _, _ in try await ise.wait() }

        c.start(scenario: .smalltalk, difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("第一轮完成") { c.session?.turns.count == 3 }
        await waitWaiters(ise, 1, "ISE 1 挂起")
        try? await Task.sleep(nanoseconds: 5_000_000)  // 两轮 user.at 必不同
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("第二轮完成") { c.session?.turns.count == 5 }
        await waitWaiters(ise, 2, "ISE 2 挂起")

        await ise.open(iseFixture(total: 3.3))  // 第一句的评测迟到
        await settle()
        XCTAssertEqual(c.session?.turns[1].text, "First sentence")
        XCTAssertEqual(c.session?.turns[1].pron?.total, 3.3)
        XCTAssertNil(c.session?.turns[3].pron, "第一句的评测不得落到第二句上")

        await ise.open(iseFixture(total: 4.4))
        await settle()
        XCTAssertEqual(c.session?.turns[3].text, "Second sentence")
        XCTAssertEqual(c.session?.turns[3].pron?.total, 4.4)
        XCTAssertEqual(c.session?.turns[1].pron?.total, 3.3)
    }

    // MARK: - 语境会话开场白（SPEAK-1 控制器级）

    @MainActor
    func testStartWithContextUsesInterpolatedOpener() async throws {
        let (c, _) = makeController()
        let ctx: SpeakSessionContext = .book(bookTitle: "Dune", chapterArticleId: "a1", chapterIdx: 2, excerpt: ["The spice must flow."])
        c.start(scenario: .smalltalk, difficulty: .easy, context: ctx)
        XCTAssertEqual(c.session?.context, ctx)
        let opener = speakContextOpener(ctx)
        XCTAssertEqual(c.session?.turns.first?.text, opener.text)
        XCTAssertEqual(c.session?.turns.first?.hintZh, opener.hintZh)
        // 落盘带 context，老读取方可忽略
        let stored = try c.store.listSessions().first
        XCTAssertEqual(stored?.context, ctx)
    }

    // MARK: - 跟读报告态（SPEAK-7/13）：评分前体检 → 四类卡 / 干净结果回写 attempts

    /// 播报通道探针：记录 speak/speakSlow/stop 与每次传入的 provider；speak 的完成回调由测试
    /// 手动放行（模拟真实 LeadSpeaker：stop() 会同步触发在途 completion）。
    @MainActor
    private final class SpeechProbe {
        var spoken: [String] = []
        var spokenProviders: [TtsProvider] = []
        var slow: [String] = []
        var slowProviders: [TtsProvider] = []
        var stops = 0
        var pending: [() -> Void] = []

        func sink() -> SpeakViewController.SpeechSink {
            SpeakViewController.SpeechSink(
                speak: { [weak self] text, _, provider, done in
                    self?.spoken.append(text)
                    self?.spokenProviders.append(provider)
                    self?.pending.append(done)
                },
                speakSlow: { [weak self] text, provider in
                    self?.slow.append(text)
                    self?.slowProviders.append(provider)
                },
                stop: { [weak self] in
                    guard let self else { return }
                    self.stops += 1
                    let fired = self.pending
                    self.pending = []
                    fired.forEach { $0() }
                }
            )
        }
    }

    /// 带播报探针的控制器（其余与 makeController 相同）。
    @MainActor
    private func makeProbedController() -> (SpeakViewController, Probe, SpeechProbe) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("speak-race-\(UUID().uuidString)", isDirectory: true)
        tmpDirs.append(dir)
        let speech = SpeechProbe()
        let controller = SpeakViewController(store: SpeakStore(baseDirectory: dir), speech: speech.sink())
        let probe = Probe()
        controller.attach(SpeakViewController.Dependencies(
            vocabWords: { [] },
            gradeSpokenVocab: { _ in },
            toast: { probe.toasts.append($0) }
        ))
        return (controller, probe, speech)
    }

    private func iseResult(
        total: Double,
        isRejected: Bool = false,
        exceptInfo: String? = nil,
        words: [WordScore] = [WordScore(content: "hello", totalScore: 4.4, dpMessage: 0)]
    ) -> PronunciationResult {
        PronunciationResult(
            total: total, accuracy: total, fluency: total, standard: total, integrity: 5,
            isRejected: isRejected, exceptInfo: exceptInfo, words: words
        )
    }

    /// 静音跟读：评分前体检命中 → novoice 卡（「没听到你的声音」+ 重新跟读），不烧评测、
    /// 不留录音、不进 attempts、不进 error 相位。
    @MainActor
    func testShadowSilentRecordingShowsNovoiceCardWithoutAssessing() async throws {
        let (c, _) = makeController()
        let assessCalls = Counter()
        c.assessProvider = { _, _ in assessCalls.n += 1; return self.iseResult(total: 5) }
        c.start(scenario: .smalltalk, difficulty: .medium)
        await waitUntil("开场白播完回 idle") { c.phase == .idleTurn }

        c.simulateShadowRecordForTesting(samples: silence)
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(c.shadowFailure?.kind, .novoice)
        XCTAssertEqual(c.shadowFailure?.title, "· 没听到你的声音")
        XCTAssertEqual(c.shadowFailure?.actions.map(\.title), ["🎤 重新跟读"])
        XCTAssertNil(c.lastShadowPcm, "体检未过不留录音")
        // 有声但过短（< 0.5s）同样 novoice
        c.simulateShadowRecordForTesting(samples: [Float](repeating: 0.3, count: 2_000))
        XCTAssertEqual(c.shadowFailure?.kind, .novoice)
        await settle()
        XCTAssertEqual(assessCalls.n, 0, "静音/过短不应送评测")
        XCTAssertNil(c.session?.turns.last?.shadowAttempts)
        if case .error = c.phase { XCTFail("跟读异常不得进 error 相位（由卡片承接）") }
    }

    /// 乱读：ISE is_rejected → rejected 卡（听领读 / 再跟读），录音留存可放，不进 attempts。
    @MainActor
    func testShadowRejectedResultShowsRejectedCardAndKeepsPcm() async throws {
        let (c, _) = makeController()
        c.assessProvider = { _, _ in self.iseResult(total: 1.2, isRejected: true) }
        c.start(scenario: .ordering, difficulty: .medium)
        await waitUntil("回 idle") { c.phase == .idleTurn }

        c.simulateShadowRecordForTesting(samples: loud)
        XCTAssertEqual(c.phase, .shadowAssessing)
        await waitUntil("出卡") { c.shadowFailure != nil }
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(c.shadowFailure?.kind, .rejected)
        XCTAssertEqual(c.shadowFailure?.title, "✗ 读的好像不是这句话")
        XCTAssertEqual(c.shadowFailure?.actions.map(\.title), ["🔊 听领读", "🎤 再跟读"])
        XCTAssertEqual(c.shadowFailure?.actions.map(\.primary), [true, false])
        XCTAssertEqual(c.lastShadowPcm, loud, "留存发生在被拒检查之前（Windows shadowPcmRef）")
        XCTAssertNil(c.session?.turns.last?.shadowAttempts, "被拒不计入 attempts（不污染趋势）")
        XCTAssertNil(c.session?.turns.last?.shadowScore)
        // 落盘同样没有 attempts
        let stored = try c.store.listSessions().first
        XCTAssertNil(stored?.turns.last?.shadowAttempts)
    }

    /// 异常码：28680 → 环境有点吵；其他码 → 这次没评上（正文带码）。
    @MainActor
    func testShadowExceptCodesClassifyNoisyAndExcept() async throws {
        let (c, _) = makeController()
        let codes = ["28680", "28676"]
        let idx = Counter()
        c.assessProvider = { _, _ in
            defer { idx.n += 1 }
            return self.iseResult(total: 2, exceptInfo: codes[min(idx.n, codes.count - 1)])
        }
        c.start(scenario: .travel, difficulty: .easy)
        await waitUntil("回 idle") { c.phase == .idleTurn }

        c.simulateShadowRecordForTesting(samples: loud)
        await waitUntil("noisy 卡") { c.shadowFailure?.kind == .noisy }
        XCTAssertEqual(c.shadowFailure?.title, "· 环境有点吵")

        c.simulateShadowRecordForTesting(samples: loud)
        XCTAssertNil(c.shadowFailure, "新一轮跟读开始即清旧卡")
        await waitUntil("except 卡") { c.shadowFailure?.kind == .except }
        XCTAssertEqual(c.shadowFailure?.title, "· 这次没评上")
        XCTAssertEqual(c.shadowFailure?.body, "评测异常（28676），再试一次")
        XCTAssertEqual(c.shadowFailure?.actions.map(\.title), ["🎤 再试一次"])
        XCTAssertNil(c.session?.turns.last?.shadowAttempts)
    }

    /// 服务异常（评测请求抛错）→ except 卡带错误详情 + 再试一次；不进 error 相位。
    @MainActor
    func testShadowAssessThrowShowsExceptCardWithDetail() async throws {
        struct Boom: LocalizedError { var errorDescription: String? { "语音评测超时（20s 无结果）" } }
        let (c, _) = makeController()
        c.assessProvider = { _, _ in throw Boom() }
        c.start(scenario: .interview, difficulty: .hard)
        await waitUntil("回 idle") { c.phase == .idleTurn }

        c.simulateShadowRecordForTesting(samples: loud)
        await waitUntil("except 卡") { c.shadowFailure != nil }
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(c.shadowFailure?.kind, .except)
        XCTAssertEqual(c.shadowFailure?.body, "语音评测超时（20s 无结果）")
        XCTAssertEqual(c.shadowFailure?.actions.map(\.title), ["🎤 再试一次"])
        XCTAssertNil(c.lastShadowPcm, "评测没返回就不算留存")
    }

    /// 干净结果：回写最近 assistant 轮 attempts（最多 10）、shadowScore 取最新；报告卡数据
    /// 从落盘派生（totals 累加）；录音留存可放；异常卡清空。
    @MainActor
    func testShadowCleanResultAppendsAttemptsAndReportDerives() async throws {
        let (c, _) = makeController()
        let totals = [3.6, 4.4]
        let idx = Counter()
        c.assessProvider = { _, _ in
            defer { idx.n += 1 }
            return self.iseResult(total: totals[min(idx.n, totals.count - 1)])
        }
        c.start(scenario: .smalltalk, difficulty: .medium)
        await waitUntil("回 idle") { c.phase == .idleTurn }
        let target = try XCTUnwrap(lastAssistantText(c.session!.turns))

        c.simulateShadowRecordForTesting(samples: loud)
        await waitUntil("第一次评完") { c.session?.turns.last?.shadowAttempts?.count == 1 }
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertNil(c.shadowFailure)
        XCTAssertEqual(c.lastShadowPcm, loud)
        XCTAssertEqual(c.session?.turns.last?.shadowScore, 3.6)

        try? await Task.sleep(nanoseconds: 5_000_000)  // 两次 attempt.at 必不同
        c.simulateShadowRecordForTesting(samples: loud)
        XCTAssertNil(c.lastShadowPcm, "新一轮跟读作废旧留存")
        await waitUntil("第二次评完") { c.session?.turns.last?.shadowAttempts?.count == 2 }
        XCTAssertEqual(c.session?.turns.last?.shadowScore, 4.4)
        XCTAssertEqual(c.lastShadowPcm, loud)

        // 报告卡数据从落盘 attempts 派生（Windows lastReport 同源）
        let attempts = try XCTUnwrap(c.session?.turns.last?.shadowAttempts)
        let report = try XCTUnwrap(shadowAttemptReport(target: target, attempts: attempts))
        XCTAssertEqual(report.totals, [3.6, 4.4])
        XCTAssertEqual(report.result.total, 4.4)
        XCTAssertEqual(report.attemptAt, attempts.last?.at)
        // 落盘一致
        let stored = try c.store.listSessions().first { $0.id == c.session?.id }
        XCTAssertEqual(stored?.turns.last?.shadowAttempts?.map(\.total), [3.6, 4.4])
    }

    /// 「听我的录音」：无录音时无操作；有录音时先停播报（播报中 → 回 idle）再回放。
    @MainActor
    func testHearShadowMineStopsSpeechAndNeedsPcm() async throws {
        let (c, _, speech) = makeProbedController()
        c.assessProvider = { _, _ in self.iseResult(total: 4.5) }
        c.start(scenario: .smalltalk, difficulty: .medium)
        // 开场白在播（探针不自动完成）；start → cancelInFlight 本身会 stop 一次，取其后为基线
        XCTAssertEqual(c.phase, .speaking)
        XCTAssertEqual(speech.spoken.count, 1)
        let stopsAfterStart = speech.stops

        c.hearShadowMine()
        XCTAssertEqual(speech.stops, stopsAfterStart, "没有录音：无操作、不打断播报")
        XCTAssertEqual(c.phase, .speaking)

        c.simulateShadowRecordForTesting(samples: loud)  // 开录即停播报
        let stopsAtRecord = speech.stops
        XCTAssertGreaterThan(stopsAtRecord, stopsAfterStart)
        await waitUntil("评完") { c.session?.turns.last?.shadowAttempts?.count == 1 }
        XCTAssertEqual(c.lastShadowPcm, loud)

        c.hearShadowModel()  // 听领读：重新播报
        XCTAssertEqual(c.phase, .speaking)
        c.hearShadowMine()   // 听我的录音：先停播报，与播报互斥
        XCTAssertGreaterThan(speech.stops, stopsAtRecord)
        XCTAssertEqual(c.phase, .idleTurn)
    }

    /// 「听领读」重播整句走主 speaking 状态机；快速连点时旧 completion 按代数丢弃，
    /// 不会把新一轮播报误置回 idle（gen 配对，对齐 SpeakView.tsx:257-272）。
    @MainActor
    func testHearShadowModelReplaysWithGenerationGuard() async throws {
        let (c, _, speech) = makeProbedController()
        c.start(scenario: .ordering, difficulty: .medium)
        let opener = try XCTUnwrap(c.session?.turns.first?.text)
        // 放行开场白
        speech.pending.removeFirst()()
        await waitUntil("开场白播完") { c.phase == .idleTurn }

        c.hearShadowModel()
        XCTAssertEqual(c.phase, .speaking)
        XCTAssertEqual(speech.spoken.last, opener)
        let firstDone = try XCTUnwrap(speech.pending.first)
        speech.pending = []
        c.hearShadowModel()  // 第二次重播（真实 LeadSpeaker 会先 stop 触发旧 completion）
        XCTAssertEqual(speech.spoken.count, 3)
        firstDone()          // 旧代数的 completion 迟到
        await settle()
        XCTAssertEqual(c.phase, .speaking, "旧代数 completion 不得把新播报置回 idle")
        try XCTUnwrap(speech.pending.last)()
        await waitUntil("新播报播完回 idle") { c.phase == .idleTurn }
    }

    /// 差词抽屉占用麦克风：开麦 / 跟读 / 报告卡动作一律忽略（与 Windows `if (drill) return` 同义）。
    @MainActor
    func testShadowActionsBlockedWhileDrillActive() async throws {
        let (c, _, speech) = makeProbedController()
        var drillShown = false
        var opened: [([ShadowDrillController.Entry], String?)] = []
        c.attach(SpeakViewController.Dependencies(
            openDrill: { entries, preferring in opened.append((entries, preferring)) },
            drillActive: { drillShown }
        ))
        c.assessProvider = { _, _ in self.iseResult(total: 4.5) }
        c.start(scenario: .smalltalk, difficulty: .medium)
        speech.pending.removeFirst()()
        await waitUntil("回 idle") { c.phase == .idleTurn }
        c.simulateShadowRecordForTesting(samples: loud)
        await waitUntil("评完") { c.session?.turns.last?.shadowAttempts?.count == 1 }
        XCTAssertTrue(c.canRunShadowAction)

        drillShown = true
        XCTAssertFalse(c.canRunShadowAction)
        let stopsBefore = speech.stops
        c.toggleMic()
        XCTAssertEqual(c.phase, .idleTurn, "抽屉打开时开麦被忽略")
        c.hearShadowMine()
        c.hearShadowModel()
        XCTAssertEqual(c.phase, .idleTurn)
        XCTAssertEqual(speech.stops, stopsBefore, "被忽略的动作不应触碰播报通道")
        let entry = ShadowDrillController.Entry(text: "hello", mark: WordMark(start: 0, end: 5, quality: .bad, score: 2))
        c.openShadowDrill(entries: [entry])
        XCTAssertTrue(opened.isEmpty, "抽屉已打开时不重复开")

        drillShown = false
        c.openShadowDrill(entries: [entry], preferring: "hello")
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(opened.first?.0.map(\.text), ["hello"])
        XCTAssertEqual(opened.first?.1, "hello")
        XCTAssertGreaterThan(speech.stops, stopsBefore, "只练差词先停播报")
        // 空清单不开抽屉
        c.openShadowDrill(entries: [])
        XCTAssertEqual(opened.count, 1)
    }

    /// 新 assistant 回复 = 新跟读目标：旧异常卡 / 录音留存清场；换场景同样清场。
    @MainActor
    func testNewReplyAndSceneSwitchClearShadowState() async throws {
        let (c, _) = makeController()
        c.transcribeProvider = { _ in "Hello there" }
        c.chatProvider = { _, _, _ in "EN: Hi!\nZH: 嗨" }
        c.assessProvider = { _, _ in self.iseResult(total: 1, isRejected: true) }
        c.start(scenario: .smalltalk, difficulty: .medium)
        await waitUntil("回 idle") { c.phase == .idleTurn }

        c.simulateShadowRecordForTesting(samples: loud)
        await waitUntil("rejected 卡") { c.shadowFailure?.kind == .rejected }
        XCTAssertNotNil(c.lastShadowPcm)

        // 说一句 → 新 assistant 轮到达 → 清场
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("新回复落盘") { c.session?.turns.count == 3 }
        XCTAssertNil(c.shadowFailure)
        XCTAssertNil(c.lastShadowPcm)

        // 再出一张卡，然后换场景
        c.simulateShadowRecordForTesting(samples: silence)
        XCTAssertEqual(c.shadowFailure?.kind, .novoice)
        c.backToEntry()
        XCTAssertNil(c.shadowFailure)
        XCTAssertNil(c.lastShadowPcm)
        c.start(scenario: .travel, difficulty: .easy)
        XCTAssertNil(c.shadowFailure)
    }

    /// 跟读评测在途时切场景并开新会话：旧结果既不写进新会话、也不弹卡。
    @MainActor
    func testStaleShadowResultAfterSceneSwitchIsDropped() async throws {
        let (c, _) = makeController()
        let ise = Gate<PronunciationResult>()
        c.assessProvider = { _, _ in try await ise.wait() }
        c.start(scenario: .smalltalk, difficulty: .medium)
        await waitUntil("回 idle") { c.phase == .idleTurn }
        c.simulateShadowRecordForTesting(samples: loud)
        XCTAssertEqual(c.phase, .shadowAssessing)
        await waitWaiters(ise, 1, "跟读评测挂起")

        c.backToEntry()
        c.start(scenario: .ordering, difficulty: .medium)
        let sessionB = try XCTUnwrap(c.session?.id)

        await ise.open(iseResult(total: 4.6))
        await settle()
        XCTAssertEqual(c.session?.id, sessionB)
        XCTAssertNil(c.session?.turns.last?.shadowAttempts, "旧跟读结果不得写进新会话")
        XCTAssertNil(c.shadowFailure)
        XCTAssertNil(c.lastShadowPcm)
        XCTAssertNotEqual(c.phase, .shadowAssessing)
    }

    /// 慢速示范走独立慢速通道（云原生 -25% / 本地 0.75× 由 LeadSpeaker 决定），不进主环状态机。
    @MainActor
    func testSpeakWordSlowUsesSlowChannelOutsideStateMachine() async throws {
        let (c, _, speech) = makeProbedController()
        c.start(scenario: .smalltalk, difficulty: .medium)
        speech.pending.removeFirst()()
        await waitUntil("回 idle") { c.phase == .idleTurn }
        c.speakWordSlow("thought")
        XCTAssertEqual(speech.slow, ["thought"])
        XCTAssertEqual(speech.spoken.count, 1, "慢速示范不走整句播报通道")
        XCTAssertEqual(c.phase, .idleTurn, "单词示范不改主环相位")
        c.speakWordSlow("")
        XCTAssertEqual(speech.slow, ["thought"])
    }

    /// SPEAK-8 验收缺口修复：口语页整句播报 / 单词朗读 / 慢速示范一律跟随设置里的 TTS 引擎
    ///（Windows createSpeechDispatcher 路由到当前引擎，speechEngine.ts:253）；provider 每次
    /// 调用时解析（改设置即时生效，不缓存）；未接线时为基线缺省 .xfyun。
    @MainActor
    func testSpeechFollowsConfiguredTtsProviderPerCall() async throws {
        let (c, _, speech) = makeProbedController()
        // 未接线 ttsProvider：缺省 .xfyun（HEAD 基线行为）
        c.start(scenario: .smalltalk, difficulty: .medium)
        XCTAssertEqual(speech.spokenProviders, [.xfyun])
        speech.pending.removeFirst()()
        await waitUntil("回 idle") { c.phase == .idleTurn }

        // 接线为 Edge：三条通道都走 Edge（慢速示范才能到达 SSML prosody -25% 路径）
        var provider: TtsProvider = .edge
        c.attach(SpeakViewController.Dependencies(ttsProvider: { provider }))
        c.speakWordSlow("thought")
        XCTAssertEqual(speech.slowProviders, [.edge])
        c.speakWord("thought")
        XCTAssertEqual(speech.spokenProviders.last, .edge)
        c.replayLast()
        XCTAssertEqual(speech.spokenProviders.last, .edge)
        XCTAssertEqual(c.phase, .speaking)
        speech.pending.forEach { $0() }
        speech.pending = []
        await waitUntil("回 idle") { c.phase == .idleTurn }

        // 改设置为本地：下一次调用即生效（逐次解析，不缓存）
        provider = .local
        c.speakWordSlow("late")
        XCTAssertEqual(speech.slowProviders, [.edge, .local])
        c.hearShadowModel()
        XCTAssertEqual(speech.spokenProviders.last, .local)
    }
}
