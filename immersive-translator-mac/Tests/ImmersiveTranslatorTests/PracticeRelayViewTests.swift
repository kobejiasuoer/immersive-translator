import Combine
import XCTest
@testable import ImmersiveTranslator
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 练习接力状态机单测（对齐 Windows PracticeRelayView.test.tsx 的 7 向量）：
// 无任务零渲染 / 同步完成刷新 / 选中打开 / 游客登录恢复挂起动作 / 在途切号丢弃
// 旧响应 / 在途他端追加回答合并 / 远端删除拒绝写回。手法与 Windows jsdom+mock 桥
// 等价：fake 环境注入（内存行 + 可续期 translate + PassthroughSubject 登录流）。
// ---------------------------------------------------------------------------

@MainActor
final class PracticeRelayViewTests: XCTestCase {
    // MARK: fake 环境

    private final class Harness {
        var ns = "guest"
        var loggedIn = false
        var rows: [String: [StoredSyncEntity]] = [:]
        /// 列表读失败注入（list 单 toast / 面板 notice 向量）。
        var listFail = false
        /// 静默同步挂起点（busy 释放时机向量）与观测。
        var hangSync = false
        var releaseSync = false
        var syncStarted = false
        var toasts: [String] = []
        private let lock = NSLock()
        private var pendingResolve: ((PracticeRelayTranslateResult) -> Void)?
        let authSubject = PassthroughSubject<AuthStatus, Never>()
        private(set) var putCalls: [(collection: String, namespace: String?)] = []
        private(set) var translateCalls = 0
        private(set) var loginCalls = 0
        var notices: [String] = []

        var nsHex: String {
            ns == "guest" ? "guest" : LearningStore.accountNamespace(ns)
        }

        lazy var environment: PracticeRelayEnvironment = {
            let harness = self
            var env = PracticeRelayEnvironment.empty(onToast: { [harness] message in
                harness.toasts.append(message)
            })
            env.listEntities = { [harness] collection, expected in
                if harness.listFail {
                    throw SyncStoreError("账号已切换，本次操作已取消")
                }
                if let expected, expected != harness.nsHex {
                    throw SyncStoreError("账号已切换，本次操作已取消")
                }
                return harness.snapshot(harness.rows[harness.nsHex] ?? [])
            }
            env.putEntities = { [harness] collection, entities, expected in
                if let expected, expected != harness.nsHex {
                    throw SyncStoreError("账号已切换，本次操作已取消")
                }
                harness.lock.lock()
                harness.putCalls.append((collection, expected))
                harness.rows[harness.nsHex] = harness.snapshot(entities)
                harness.lock.unlock()
            }
            env.namespace = { [harness] in harness.nsHex }
            env.deviceId = { "windows-device" }
            env.authStatus = { [harness] in
                AuthStatus(loggedIn: harness.loggedIn, user: harness.loggedIn ? AuthUser(id: harness.ns, email: "a@example.test", nickname: nil, plan: "free", createdAt: "2026-10-30T00:00:00Z") : nil, notice: nil)
            }
            env.openLogin = { [harness] in harness.loginCalls += 1 }
            env.translate = { [harness] _, _, _ in
                harness.translateCalls += 1
                return await withCheckedContinuation { continuation in
                    harness.lock.lock()
                    harness.pendingResolve = { continuation.resume(returning: $0) }
                    harness.lock.unlock()
                }
            }
            env.audio = { [harness] action, clipId, _, _ in
                if action == "read" {
                    return ["clipId": clipId, "pcmB64": Data([1, 2, 3, 4]).base64EncodedString(), "wavB64": harness.wavB64]
                }
                return ["clipId": clipId, "nextSequence": 1, "status": "ready", "byteLength": 4]
            }
            env.assess = { _, _ in
                PracticeRelayAssessment(total: 4.5, accuracy: 90, fluency: 88, isRejected: false, exceptInfo: nil)
            }
            env.syncSilently = { [harness] in
                harness.syncStarted = true
                while !harness.releaseSync {
                    try? await Task.sleep(nanoseconds: 5_000_000)
                }
            }
            env.center = NotificationCenter()
            env.now = { 2_000 }
            return env
        }()

        /// 最小合法 WAV（回听播放用；44 字节头 + 8 个采样，16kHz/16bit/mono）。
        lazy var wavB64: String = {
            var wav = Data()
            func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
            func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
            wav.append(Data("RIFF".utf8)); le32(36 + 8)
            wav.append(Data("WAVEfmt ".utf8)); le32(16); le16(1); le16(1)
            le32(16_000); le32(32_000); le16(2); le16(16)
            wav.append(Data("data".utf8)); le32(8)
            wav.append(contentsOf: [UInt8](repeating: 0, count: 8))
            return wav.base64EncodedString()
        }()

        private func snapshot(_ rows: [StoredSyncEntity]) -> [StoredSyncEntity] {
            rows.map { entity in
                var copy = entity
                copy.payload = entity.payload.flatMap { value in
                    (try? JSONSerialization.jsonObject(with: syncJSONData(value) ?? Data())).flatMap { $0 }
                }
                return copy
            }
        }

        func authPublisher() -> AnyPublisher<AuthStatus, Never> {
            authSubject.eraseToAnyPublisher()
        }

        func resolveTranslate(_ result: PracticeRelayTranslateResult) {
            lock.lock()
            let resolve = pendingResolve
            pendingResolve = nil
            lock.unlock()
            resolve?(result)
        }

        func login(as account: String) {
            ns = account
            loggedIn = true
            authSubject.send(AuthStatus(
                loggedIn: true,
                user: AuthUser(id: account, email: "a@example.test", nickname: nil, plan: "free", createdAt: "2026-10-30T00:00:00Z"),
                notice: nil
            ))
        }
    }

    // MARK: 夹具（PracticeRelayView.test.tsx task / entity 同形）

    private let task: JSONObject = [
        "id": "task-1", "mode": "follow", "title": "手机保存的练习",
        "reference": "Hello from the phone",
        "steps": ["Hello from the phone", "Next sentence"] as [Any],
        "step": 0, "draft": "", "status": "active", "createdAt": 1, "updatedAt": 2,
        "attempts": [[
            "id": "attempt-1", "step": 0, "text": "Hello from Windows", "deviceId": "phone",
            "status": "draft", "createdAt": 1, "reference": "Hello from the phone",
        ]] as [Any],
    ]

    private func entity() -> StoredSyncEntity {
        StoredSyncEntity(
            id: "task-1", baseVersion: 3, updatedAt: 2, deleted: false, schemaVersion: 2,
            originDevice: nil,
            payload: [
                "v": 2, "id": "task-1", "kind": "practice-task", "scenario": "practice",
                "difficulty": "medium", "turns": [] as [Any], "startedAt": 1, "endedAt": 2,
                "task": task,
            ] as JSONObject,
            dirty: false
        )
    }

    private func doneTranslate() -> PracticeRelayTranslateResult {
        PracticeRelayTranslateResult(
            status: "done",
            text: "{\"message\":\"语义清楚\",\"improved\":\"Hello from Windows.\",\"explanation\":\"保留原意\",\"usedTarget\":true}"
        )
    }

    /// 等 save 队列/挂起任务落地。
    private func settle() async {
        for _ in 0..<24 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 8_000_000)
        }
    }

    // MARK: 向量

    func testNoTasksMeansNoPanel() async {
        let harness = Harness()
        harness.rows["guest"] = []
        let listModel = PracticeRelayListModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await listModel.refresh()
        XCTAssertTrue(listModel.tasks.isEmpty)
        // 面板无选中任务 → body 无内容（ViewModel task 为 nil）
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        XCTAssertNil(panel.task)
    }

    func testRowsShownAndRefreshedAfterBackgroundSync() async throws {
        let harness = Harness()
        harness.ns = "account-a"
        harness.rows[harness.nsHex] = [entity()]
        let listModel = PracticeRelayListModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await listModel.refresh()
        XCTAssertEqual(listModel.tasks.count, 1)
        XCTAssertEqual(LearningJSON.string(listModel.tasks[0]["title"]), "手机保存的练习")
        // 后台同步把任务推进到第 2 步 → learning-sync-complete 后列表刷新
        var updated = entity()
        var payload = LearningJSON.object(updated.payload) ?? [:]
        var taskUpdated = LearningJSON.object(payload["task"]) ?? [:]
        taskUpdated["step"] = 1
        payload["task"] = taskUpdated
        updated.payload = payload
        harness.rows[harness.nsHex] = [updated]
        harness.environment.center.post(name: .learningSyncComplete, object: nil)
        await settle()
        await listModel.refresh()
        XCTAssertEqual(LearningJSON.number(listModel.tasks.first?["step"]), 1)  // 「第 2 步」
    }

    func testSelectOpensTaskInContentFlow() async {
        let harness = Harness()
        harness.rows["guest"] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        XCTAssertEqual(panel.taskID, "task-1")
        XCTAssertEqual(panel.stepLine, "第 1 / 2 步 · 已从保存位置恢复")
    }

    func testGuestLoginRestoresTaskAndReplaysPendingAction() async throws {
        let harness = Harness()
        harness.rows["guest"] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        // 游客点「获取表达建议」→ 挂起 + 弹登录 + 不调翻译
        let attempt = try XCTUnwrap(LearningJSON.object(LearningJSON.array(task["attempts"])?.first ?? [:]))
        await panel.feedback(task, attempt)
        XCTAssertEqual(harness.loginCalls, 1)
        XCTAssertEqual(harness.translateCalls, 0)
        XCTAssertEqual(panel.notice, "登录后将继续刚才的操作，草稿和录音已保存在本机。")
        // 登录成功 → account-a（同名任务已随 adopt 迁入）→ 恢复任务并重放挂起动作
        harness.rows[LearningStore.accountNamespace("account-a")] = harness.rows["guest"]
        harness.login(as: "account-a")
        await settle()
        harness.resolveTranslate(doneTranslate())
        await settle()
        XCTAssertEqual(harness.translateCalls, 1)
        XCTAssertTrue(panel.notice.contains("建议已保存，可在另一台设备继续"), panel.notice)
        // 反馈写进 account-a 命名空间（put 的 expectedNamespace === account-a）
        let put = try XCTUnwrap(harness.putCalls.last)
        XCTAssertEqual(put.namespace, LearningStore.accountNamespace("account-a"))
        let saved = try XCTUnwrap(harness.rows[LearningStore.accountNamespace("account-a")]?.first)
        let savedTask = LearningJSON.object(LearningJSON.object(saved.payload)?["task"]) ?? [:]
        let savedAttempts = LearningJSON.array(savedTask["attempts"]) ?? []
        let feedback = LearningJSON.object(LearningJSON.object(savedAttempts.first ?? [:])?["feedback"])
        XCTAssertEqual(LearningJSON.string(feedback?["message"]), "语义清楚")
    }

    func testInFlightResponseDroppedAfterAccountSwitch() async throws {
        let harness = Harness()
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        let attempt = try XCTUnwrap(LearningJSON.object(LearningJSON.array(task["attempts"])?.first ?? [:]))
        Task { await panel.feedback(task, attempt) }  // 点击即返回，翻译在途
        await settle()
        XCTAssertEqual(harness.translateCalls, 1)
        // 切到 account-b（空库）→ 旧响应回来必须被丢弃
        harness.rows[LearningStore.accountNamespace("account-b")] = []
        harness.login(as: "account-b")
        await settle()
        harness.resolveTranslate(PracticeRelayTranslateResult(
            status: "done",
            text: "{\"message\":\"旧账号反馈\",\"improved\":\"x\",\"explanation\":\"x\",\"usedTarget\":true}"
        ))
        await settle()
        XCTAssertEqual(harness.putCalls.count, 0)  // 不写新账号
        XCTAssertFalse(panel.notice.contains("旧账号反馈"), panel.notice)
        XCTAssertEqual(harness.rows[LearningStore.accountNamespace("account-b")]?.count, 0)
    }

    func testInFlightFeedbackMergesRemoteAppendedAttempt() async throws {
        let harness = Harness()
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        let attempt = try XCTUnwrap(LearningJSON.object(LearningJSON.array(task["attempts"])?.first ?? [:]))
        Task { await panel.feedback(task, attempt) }
        await settle()
        XCTAssertEqual(harness.translateCalls, 1)
        // 翻译在途：另一设备追加了回答
        var remote = entity()
        var payload = LearningJSON.object(remote.payload) ?? [:]
        var remoteTask = LearningJSON.object(payload["task"]) ?? [:]
        remoteTask["attempts"] = (LearningJSON.array(remoteTask["attempts"]) ?? [])
            + [[
                "id": "phone-added", "step": 0, "text": "Another phone answer", "deviceId": "phone",
                "status": "draft", "createdAt": 3, "reference": "Hello from the phone",
            ] as JSONObject]
        remoteTask["updatedAt"] = 3
        payload["task"] = remoteTask
        remote.payload = payload
        remote.updatedAt = 3
        harness.rows[harness.nsHex] = [remote]
        harness.resolveTranslate(PracticeRelayTranslateResult(
            status: "done",
            text: "{\"message\":\"本机反馈\",\"improved\":\"Hello.\",\"explanation\":\"Saved\",\"usedTarget\":true}"
        ))
        await settle()
        // 旧 UI 保存后：面板显示双方记录（Windows 断言 textContent 含
        // "Another phone answer" 与 "本机反馈"），存储里 attempts 并集。
        let shownAttempts = LearningJSON.array(panel.task?["attempts"]) ?? []
        XCTAssertTrue(shownAttempts.contains { LearningJSON.string(LearningJSON.object($0)?["text"]) == "Another phone answer" })
        XCTAssertTrue(shownAttempts.contains {
            LearningJSON.string(LearningJSON.object(LearningJSON.object($0)?["feedback"])?["message"]) == "本机反馈"
        })
        let saved = try XCTUnwrap(harness.rows[harness.nsHex]?.first)
        XCTAssertEqual(attemptIDs(of: saved.payload), ["attempt-1", "phone-added"])
    }

    func testRemoteDeletedTaskIsNotWrittenBackByStaleUI() async throws {
        let harness = Harness()
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        let attempt = try XCTUnwrap(LearningJSON.object(LearningJSON.array(task["attempts"])?.first ?? [:]))
        Task { await panel.feedback(task, attempt) }
        await settle()
        XCTAssertEqual(harness.translateCalls, 1)
        // 远端删除（tombstone）
        var tombstone = entity()
        tombstone.deleted = true
        tombstone.payload = nil
        harness.rows[harness.nsHex] = [tombstone]
        harness.resolveTranslate(PracticeRelayTranslateResult(
            status: "done",
            text: "{\"message\":\"旧响应\",\"improved\":\"x\",\"explanation\":\"x\",\"usedTarget\":true}"
        ))
        await settle()
        XCTAssertEqual(harness.putCalls.count, 0)  // 不写回
        XCTAssertTrue(panel.notice.contains("这组练习已删除"), panel.notice)
        let stored = try XCTUnwrap(harness.rows[harness.nsHex]?.first)
        XCTAssertTrue(stored.deleted)
    }

    private func attemptIDs(of payload: Any?) -> [String] {
        let attempts = LearningJSON.array(LearningJSON.object(LearningJSON.object(payload)?["task"])?["attempts"]) ?? []
        return attempts.compactMap { LearningJSON.object($0)?["id"] as? String }
    }
}

// MARK: - 修订复核补测（busy 释放时机 / 播放持有 / trim 禁用 / 单 toast / notice / prompt 键序）

extension PracticeRelayViewTests {
    /// 16kHz/16bit/mono 的最小合法 WAV（44 字节头 + 8 个采样）——AVAudioPlayer 可解码。
    private func tinyWavBase64() -> String {
        var wav = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
        wav.append(Data("RIFF".utf8)); le32(36 + 8)
        wav.append(Data("WAVEfmt ".utf8)); le32(16); le16(1); le16(1)
        le32(16_000); le32(32_000); le16(2); le16(16)
        wav.append(Data("data".utf8)); le32(8)
        wav.append(contentsOf: [UInt8](repeating: 0, count: 8))
        return wav.base64EncodedString()
    }

    private func recordingHarness(listFails: Bool = false, hangSync: Bool = false) -> Harness {
        let harness = Harness()
        harness.listFail = listFails
        harness.hangSync = hangSync
        return harness
    }

    /// tsx:60/66 `void syncLearningRecordsSilently()`：busy 在静默同步完成前就释放。
    func testFeedbackAndAssessReleaseBusyBeforeSilentSyncFinishes() async throws {
        let harness = recordingHarness(hangSync: true)
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        let attempt = try XCTUnwrap(LearningJSON.object(LearningJSON.array(task["attempts"])?.first ?? [:]))
        // 翻译在途（挂起续接）——await feedback 本体只会把主线程吊死，与 Windows
        // 「点击即返回、响应在途」同语义。
        let run = Task { await panel.feedback(task, attempt) }
        await settle()
        harness.resolveTranslate(doneTranslate())
        await settle()
        XCTAssertEqual(harness.syncStarted, true, "反馈保存后应发起静默同步")
        XCTAssertFalse(panel.busy, "busy 不等整轮 7 集合同步")
        harness.releaseSync = true
        await settle()
        _ = await run.result
        panel.select(task)
        // assess：挂起同步同样不占 busy
        let recording = try XCTUnwrap(LearningJSON.object([
            "id": "attempt-rec", "step": 0, "text": "", "clipId": "clip-x", "deviceId": "phone",
            "status": "recorded", "createdAt": 1, "reference": "Hello from the phone",
        ] as JSONObject))
        var base = task
        base["attempts"] = [recording] as [Any]
        harness.rows[harness.nsHex] = [entity()]
        panel.select(base)
        await panel.assess(base, recording)
        await settle()
        XCTAssertEqual(harness.syncStarted, true)
        XCTAssertFalse(panel.busy)
        XCTAssertTrue(panel.notice.contains("真实发音评测结果已保存"), panel.notice)
        harness.releaseSync = true
        await settle()
    }

    /// tsx:67/40 回听播放句柄：新播放顶替旧、切号停止、句柄强持有。
    func testPlaybackHandleReplacedOnNewPlayAndStoppedOnAccountSwitch() async throws {
        let harness = recordingHarness()
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        var panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        panel.select(task)
        let clipA = try XCTUnwrap(LearningJSON.object([
            "id": "a1", "step": 0, "text": "", "clipId": "clip-a", "deviceId": "windows-device",
            "status": "recorded", "createdAt": 1,
        ] as JSONObject))
        let clipB = try XCTUnwrap(LearningJSON.object([
            "id": "a2", "step": 0, "text": "", "clipId": "clip-b", "deviceId": "windows-device",
            "status": "recorded", "createdAt": 1,
        ] as JSONObject))
        await panel.play(clipA)
        let first = try XCTUnwrap(panel.currentPlayback, "句柄强持有（局部变量会在函数返回后释放播放）")
        await panel.play(clipB)
        let second = try XCTUnwrap(panel.currentPlayback)
        XCTAssertNotEqual(first, second, "新播放先停旧再换新句柄")
        // 切号（auth-state-changed）：回听停止
        harness.rows[LearningStore.accountNamespace("account-b")] = []
        harness.login(as: "account-b")
        await settle()
        XCTAssertNil(panel.currentPlayback, "切号时回听停止")
        // 面板随作用域释放（卸载）时句柄随之释放
        _ = panel
    }

    /// tsx:71 步进/提交按钮禁用条件：纯空白草稿不拦步进（trim 口径）。
    func testAdvanceButtonUsesTrimNotRawIsEmpty() async throws {
        let harness = recordingHarness()
        harness.ns = "account-a"
        harness.loggedIn = true
        harness.rows[harness.nsHex] = [entity()]
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        var blank = task
        blank["draft"] = "   "
        panel.select(blank)
        XCTAssertFalse(panel.advanceButtonDisabled, "纯空白草稿可步进（!!task.draft.trim()）")
        XCTAssertTrue(panel.submitButtonDisabled, "提交仍禁用（!task.draft.trim()）")
        var filled = task
        filled["draft"] = "hello"
        panel.select(filled)
        XCTAssertTrue(panel.advanceButtonDisabled)
        XCTAssertFalse(panel.submitButtonDisabled)
    }

    /// tsx:21 列表读失败只 toast 固定文案（不透出原始错误）。
    func testListRefreshFailureToastsFixedMessageOnly() async throws {
        let harness = recordingHarness(listFails: true)
        let listModel = PracticeRelayListModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await listModel.refresh()
        XCTAssertEqual(harness.toasts, ["口语练习列表暂时无法读取，请稍后重试。"])
        XCTAssertTrue(listModel.tasks.isEmpty)
    }

    /// tsx:40 面板刷新读失败显示错误 notice（不再静默吞掉）。
    func testPanelRefreshQuietFailureShowsNotice() async throws {
        let harness = recordingHarness(listFails: true)
        harness.ns = "account-a"
        harness.loggedIn = true
        let panel = PracticeRelayViewModel(environment: harness.environment, authStatusPublisher: harness.authPublisher())
        await settle()
        XCTAssertEqual(panel.notice, "账号已切换，本次操作已取消")
    }

    /// tsx:60 prompt：task.word 缺失时 target 键整个省略（JSON.stringify undefined 口径），
    /// 键序与对象字面量一致。
    func testFeedbackPromptOmitsUndefinedTargetAndKeepsLiteralKeyOrder() {
        let withWord = practiceRelayFeedbackPrompt(task: ["mode": "word", "word": "apple", "reference": "Hi", "steps": ["Hi"] as [Any]], attempt: ["text": "I eat"])
        XCTAssertEqual(withWord, "{\"mode\":\"word\",\"target\":\"apple\",\"prompt\":\"Hi\",\"answer\":\"I eat\"}")
        let withoutWord = practiceRelayFeedbackPrompt(task: ["mode": "follow", "reference": "Hi"], attempt: ["text": ""])
        XCTAssertEqual(withoutWord, "{\"mode\":\"follow\",\"prompt\":\"Hi\",\"answer\":\"\"}")
    }

    /// 草稿 900 上限按 UTF-16 code unit 计（HTML maxLength 口径），不劈代理对。
    func testDraftClampCountsUTF16Units() {
        let ascii = String(repeating: "a", count: 901)
        XCTAssertEqual(practiceRelayClampDraft(ascii).count, 900)
        let emoji = String(repeating: "😀", count: 451)  // 902 units
        XCTAssertEqual(practiceRelayClampDraft(emoji).utf16.count, 900)
        XCTAssertEqual(practiceRelayClampDraft(emoji).count, 450)
        XCTAssertEqual(practiceRelayClampDraft("ok"), "ok")
    }

}

// MARK: - 「回到原文这句」落点（ReaderApp.tsx:1902：取到 null → 原文已删；抛错 → 错误原文）

@MainActor
final class ReaderRelaySourceTests: XCTestCase {
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

    private var dirs: [URL] = []

    override func tearDown() {
        for dir in dirs { try? FileManager.default.removeItem(at: dir) }
        dirs = []
        super.tearDown()
    }

    private func makeDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-source-\(UUID().uuidString)", isDirectory: true)
        dirs.append(dir)
        return dir
    }

    func testMissingArticleToastsDeletedNotice() {
        let vm = ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: makeDir()))
        vm.openRelaySource(articleId: "gone", sentenceIdx: 3)
        XCTAssertEqual(vm.toast, "原文已删除，练习仍保留完整参考句和反馈")
    }

    func testArticleReadErrorToastsErrorTextInsteadOfDeletedNotice() throws {
        let dir = makeDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // 版本不兼容的文章库：getArticle 抛错（不是「取到 null」）
        try "{\"schemaVersion\":999,\"articles\":[]}".write(
            to: dir.appendingPathComponent("reader_articles.json"), atomically: true, encoding: .utf8
        )
        let store = ReaderStore(baseDirectory: dir)
        var expected = ""
        XCTAssertThrowsError(try store.getArticle(id: "a")) { error in
            expected = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        }
        XCTAssertFalse(expected.isEmpty)
        let vm = ReaderViewModel(chat: StubChat(), store: store)
        vm.openRelaySource(articleId: "a", sentenceIdx: 0)
        XCTAssertEqual(vm.toast, expected, "取文章抛错 → toast 错误原文（不冒充原文已删除）")
        XCTAssertNotEqual(vm.toast, "原文已删除，练习仍保留完整参考句和反馈")
    }
}
