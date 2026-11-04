import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 听力模式（先听后看，22743ac）与场景体系在控制器层的接线：start 清空 revealed、resume 全揭、
/// 答完自动揭上一条、revealTurn 幂等、listenMode 偏好读写（UserDefaults key / "1"/"0" / 默认 false）、
/// 听力模式下不喂流式原文、用户场景 keyPhrases 注入系统提示、speak_session_start 埋点真实来源。
/// 不碰物理麦克风/合成引擎：ASR 走 transcribeProvider、播报走 SpeechSink.silent、落盘走临时目录。
final class SpeakViewControllerListenModeTests: XCTestCase {
    private final class Probe {
        var toasts: [String] = []
        var events: [TelemetryEvent] = []
        var systems: [String] = []
        var deltas: [String] = []
    }

    private var tmpDirs: [URL] = []
    private var suites: [String] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
        suites = []
        registerUserScenarios([])
        registerOfficialScenarios([])
        super.tearDown()
    }

    private let loud = [Float](repeating: 0.2, count: 16_000)

    private func makeDefaults() -> UserDefaults {
        let suite = "speak-listen-tests-\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @MainActor
    private func makeController(defaults: UserDefaults? = nil) -> (SpeakViewController, Probe) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("speak-listen-\(UUID().uuidString)", isDirectory: true)
        tmpDirs.append(dir)
        let controller = SpeakViewController(
            store: SpeakStore(baseDirectory: dir), speech: .silent, defaults: defaults ?? makeDefaults()
        )
        let probe = Probe()
        controller.attach(SpeakViewController.Dependencies(
            vocabWords: { [] },
            gradeSpokenVocab: { _ in },
            toast: { probe.toasts.append($0) },
            track: { probe.events.append($0) }
        ))
        controller.transcribeProvider = { _ in "Let's close the deal today." }
        return (controller, probe)
    }

    @MainActor
    private func waitUntil(_ what: String, timeoutMs: Int = 2_000, _ cond: @escaping @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while !cond(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(cond(), "等待超时：\(what)")
    }

    // MARK: - 偏好

    func testListenModePreferenceKeyAndValues() {
        let defaults = makeDefaults()
        XCTAssertEqual(SpeakListenModePreference.key, "immersive-translator-speak-listen-mode")
        XCTAssertFalse(SpeakListenModePreference.load(defaults), "缺省 false")
        SpeakListenModePreference.save(true, defaults)
        XCTAssertEqual(defaults.string(forKey: SpeakListenModePreference.key), "1")
        XCTAssertTrue(SpeakListenModePreference.load(defaults))
        SpeakListenModePreference.save(false, defaults)
        XCTAssertEqual(defaults.string(forKey: SpeakListenModePreference.key), "0")
        XCTAssertFalse(SpeakListenModePreference.load(defaults))
        // 读取失败/脏值 → false
        defaults.set("yes", forKey: SpeakListenModePreference.key)
        XCTAssertFalse(SpeakListenModePreference.load(defaults))
    }

    @MainActor
    func testToggleListenModePersistsAcrossControllers() {
        let defaults = makeDefaults()
        let (c1, _) = makeController(defaults: defaults)
        XCTAssertFalse(c1.listenMode)
        c1.toggleListenMode()
        XCTAssertTrue(c1.listenMode)
        XCTAssertEqual(defaults.string(forKey: SpeakListenModePreference.key), "1")
        let (c2, _) = makeController(defaults: defaults)
        XCTAssertTrue(c2.listenMode, "跨会话保留")
    }

    // MARK: - 遮罩状态机

    @MainActor
    func testStartClearsRevealedSoOpenerIsVeiled() {
        let (c, _) = makeController()
        c.toggleListenMode()
        c.start(scenario: "ordering", difficulty: .medium)
        XCTAssertEqual(c.revealedTurnIndices, [])
        XCTAssertTrue(c.isTurnVeiled(0), "开场白先只听")
        c.revealTurn(0)
        XCTAssertFalse(c.isTurnVeiled(0))
        // 新开局从开场白重新遮起
        c.start(scenario: "travel", difficulty: .easy)
        XCTAssertEqual(c.revealedTurnIndices, [])
        XCTAssertTrue(c.isTurnVeiled(0))
    }

    @MainActor
    func testResumeRevealsAllAssistantTurns() {
        let (c, _) = makeController()
        c.toggleListenMode()
        let session = SpeakSession(
            id: "old", scenario: "smalltalk", difficulty: .medium,
            turns: [
                SpeakTurn(role: .assistant, text: "Hey!", at: 1),
                SpeakTurn(role: .user, text: "Hi.", at: 2),
                SpeakTurn(role: .assistant, text: "How are you?", at: 3),
            ],
            createdAt: 1, updatedAt: 3
        )
        c.resume(session)
        XCTAssertEqual(c.revealedTurnIndices, [0, 2], "历史原文全部可见")
        XCTAssertFalse(c.isTurnVeiled(0))
        XCTAssertFalse(c.isTurnVeiled(2))
    }

    @MainActor
    func testRevealTurnIsIdempotentAndToggleKeepsRevealed() {
        let (c, _) = makeController()
        c.start(scenario: "ordering", difficulty: .medium)
        c.revealTurn(0)
        c.revealTurn(0)
        XCTAssertEqual(c.revealedTurnIndices, [0])
        c.toggleListenMode()
        XCTAssertTrue(c.listenMode)
        XCTAssertFalse(c.isTurnVeiled(0), "开关切换即时生效但已揭开的保持不动")
        c.toggleListenMode()
        XCTAssertFalse(c.listenMode)
        XCTAssertFalse(c.isTurnVeiled(5), "关掉听力模式一律不遮")
    }

    @MainActor
    func testUserTurnAutoRevealsPreviousAssistantAndNoStreamingInListenMode() async {
        let (c, probe) = makeController()
        c.toggleListenMode()
        let gate = Gate()
        c.chatProvider = { system, _, onDelta in
            probe.systems.append(system)
            onDelta("EN: partial reply")
            probe.deltas.append("sent")
            return try await gate.wait()
        }
        c.start(scenario: "ordering", difficulty: .medium)
        XCTAssertTrue(c.isTurnVeiled(0))
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("进入回复中") { c.phase == .thinking && !probe.deltas.isEmpty }
        // 听力模式下流式占位不喂原文（thinking 期间 streaming 保持空）
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(c.streaming.en, "", "听力模式下不流式上屏回复原文")
        // 答完一句：最近的上一条 assistant 轮（开场白）自动揭开
        XCTAssertTrue(c.revealedTurnIndices.contains(0))
        XCTAssertFalse(c.isTurnVeiled(0))
        await gate.open("EN: Great, let's begin.\nZH: 好，开始吧\nBETTER: Let's close the deal today.\nTIP: 很好")
        await waitUntil("回复落盘") { c.session?.turns.count == 3 }
        XCTAssertTrue(c.isTurnVeiled(2), "新到的 AI 回复先只听")
        await waitUntil("回 idle") { c.phase == .idleTurn }
    }

    @MainActor
    func testStreamingStillFlowsWhenListenModeOff() async {
        let (c, _) = makeController()
        let gate = Gate()
        c.chatProvider = { _, _, onDelta in
            onDelta("EN: partial")
            return try await gate.wait()
        }
        c.start(scenario: "ordering", difficulty: .medium)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("流式上屏") { c.streaming.en == "partial" }
        await gate.open("EN: done\nZH: 完")
        await waitUntil("回 idle") { c.phase == .idleTurn }
    }

    private actor Gate {
        private var waiters: [CheckedContinuation<String, Error>] = []
        func wait() async throws -> String {
            try await withCheckedThrowingContinuation { waiters.append($0) }
        }
        func open(_ value: String) {
            let all = waiters
            waiters = []
            all.forEach { $0.resume(returning: value) }
        }
    }

    // MARK: - 场景体系接线：keyPhrases 注入 / 埋点

    @MainActor
    func testUserScenarioKeyPhrasesAppendedToSystemPrompt() async {
        registerUserScenarios([
            SpeakScenario(
                id: "usr_deal", source: .user, title: "谈判", category: .workplace, aiRole: "你扮演采购经理",
                keyPhrases: ["close the deal", "meet halfway"], opener: "Shall we start?", updatedAt: 1
            ),
        ])
        let (c, probe) = makeController()
        c.chatProvider = { system, _, _ in
            probe.systems.append(system)
            return "EN: ok\nZH: 好"
        }
        c.start(scenario: "usr_deal", difficulty: .medium)
        XCTAssertEqual(c.session?.turns[0].text, "Shall we start?")
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("LLM 调用") { !probe.systems.isEmpty }
        let system = probe.systems[0]
        let base = buildSpeakSystemPrompt("usr_deal", .medium)
        XCTAssertTrue(system.hasPrefix(base))
        XCTAssertTrue(system.hasSuffix("\n本场景的目标表达（诱导用户在回答中自然用出）：close the deal、meet halfway。"))
        await waitUntil("回 idle") { c.phase == .idleTurn }
    }

    @MainActor
    func testBuiltinScenarioSystemPromptUnchanged() async {
        let (c, probe) = makeController()
        c.chatProvider = { system, _, _ in
            probe.systems.append(system)
            return "EN: ok\nZH: 好"
        }
        c.start(scenario: "ordering", difficulty: .easy)
        c.simulateRecordedUtteranceForTesting(samples: loud)
        await waitUntil("LLM 调用") { !probe.systems.isEmpty }
        XCTAssertEqual(probe.systems[0], buildSpeakSystemPrompt("ordering", .easy), "内置场景 prompt 逐字不变")
        await waitUntil("回 idle") { c.phase == .idleTurn }
    }

    @MainActor
    func testSpeakSessionStartTracksRealScenarioSource() {
        registerOfficialScenarios([
            SpeakScenario(id: "off_cafe", source: .official, title: "点咖啡", category: .daily, aiRole: "r", opener: "o", updatedAt: 1),
        ])
        registerUserScenarios([
            SpeakScenario(id: "usr_x", source: .user, title: "x", category: .custom, aiRole: "r", opener: "o", updatedAt: 1),
        ])
        let (c, probe) = makeController()
        c.start(scenario: "ordering", difficulty: .medium)
        c.start(scenario: "off_cafe", difficulty: .medium)
        c.start(scenario: "usr_x", difficulty: .medium)
        c.start(scenario: "usr_ghost", difficulty: .medium)
        let starts = probe.events.filter { $0.name == "speak_session_start" }
        XCTAssertEqual(starts.count, 4)
        XCTAssertEqual(starts[0].props, ["scenarioId": .string("ordering"), "scenarioSource": .string("builtin")])
        XCTAssertEqual(starts[1].props, ["scenarioId": .string("off_cafe"), "scenarioSource": .string("official")])
        XCTAssertEqual(starts[2].props, ["scenarioId": .string("usr_x"), "scenarioSource": .string("user")])
        // 查不到的场景回退内置，source 天然是 builtin；scenarioId 仍报真实 id
        XCTAssertEqual(starts[3].props, ["scenarioId": .string("usr_ghost"), "scenarioSource": .string("builtin")])
    }

    @MainActor
    func testUnknownScenarioSessionPersistsAndResumes() throws {
        let (c, _) = makeController()
        c.start(scenario: "usr_6f1c2b2e-0d3b-4e4a-9a1c-2c3d4e5f6a7b", difficulty: .hard)
        let id = try XCTUnwrap(c.session?.id)
        let listed = try c.store.listSessions()
        XCTAssertEqual(listed.first?.id, id)
        XCTAssertEqual(listed.first?.scenario, "usr_6f1c2b2e-0d3b-4e4a-9a1c-2c3d4e5f6a7b")
        XCTAssertEqual(speakSceneTitle(listed[0]), "自定义场景", "目录未装载时显示兜底标题，不崩")
    }
}
