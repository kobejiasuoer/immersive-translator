import XCTest
import ReaderCore
import XfyunCore
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 口语记录云同步记录层单测（对齐 Windows src/lib/speakRecords.test.ts 全部
// 行为向量）：投影保留富字段且无音频键 / 云端记录→富会话往返 / 64KB 护栏
// 明确报错绝不裁剪轮次 / 单轮完整文字原样保留 / 两形状守卫全集 / 评测精简
// 投影与截断 / 入队 baseVersion 沿用与未知字段深合并 / 入队零网络 / 500 条
// 滚动裁剪 / 删除走 tombstone / push 载荷音频红线 / list 过滤脏行 / 展示合并 /
// B 端首拉 / 双端 409 收敛 / tombstone 传播 / 游客与登录态读取失败零网络。
// ---------------------------------------------------------------------------

final class SpeakRecordsTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    private func tempDir(_ label: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("speak-records-tests-\(UUID().uuidString)-\(label)", isDirectory: true)
        tmpDirs.append(dir)
        return dir
    }

    // MARK: 假传输（计数器 + push 请求体记录）

    private final class FakeTransport {
        private let lock = NSLock()
        private var responses: [AuthHttpResponse] = []
        private(set) var calls = 0
        private(set) var pushBodies: [String] = []

        func queue(_ response: AuthHttpResponse) {
            lock.lock()
            defer { lock.unlock() }
            responses.append(response)
        }

        func pull(collection: String, since: Int64, limit: Int64) async throws -> AuthHttpResponse {
            try take(push: false, body: nil)
        }

        func push(collection: String, body: String) async throws -> AuthHttpResponse {
            try take(push: true, body: body)
        }

        /// 同步取件（锁只在同步上下文里短暂持有，不跨挂起点）。
        private func take(push: Bool, body: String?) throws -> AuthHttpResponse {
            lock.lock()
            defer { lock.unlock() }
            calls += 1
            if push, let body { pushBodies.append(body) }
            guard !responses.isEmpty else { throw SyncStoreError("测试未预期的请求") }
            return responses.removeFirst()
        }
    }

    private func makeSyncer(
        _ label: String,
        loginStatus: @escaping () -> AuthStatus? = { AuthStatus.loggedOut }
    ) -> (syncer: SpeakRecordsSyncer, store: SyncStore, transport: FakeTransport) {
        let store = SyncStore(baseDirectory: tempDir(label))
        let transport = FakeTransport()
        let engine = SyncEngine(dependencies: SyncEngineDependencies(
            pull: { collection, since, limit, _ in
                try await transport.pull(collection: collection, since: since, limit: limit)
            },
            push: { collection, body, _ in
                try await transport.push(collection: collection, body: body)
            },
            list: { collection, ns in try store.list(collection, expectedNamespace: ns) },
            put: { collection, entities, ns in try store.put(collection, entities, expectedNamespace: ns) },
            replace: { collection, entities, cursor, ns in
                try store.replace(collection, entities, cursor: cursor, expectedNamespace: ns)
            },
            cursorGet: { collection, ns in try store.cursorGet(collection, expectedNamespace: ns) },
            cursorSet: { collection, cursor, ns in try store.cursorSet(collection, cursor, expectedNamespace: ns) },
            namespace: { store.currentNamespace() },
            sleep: { _ in }
        ))
        let syncer = SpeakRecordsSyncer(store: store, engine: engine, loginStatus: loginStatus)
        return (syncer, store, transport)
    }

    // MARK: 会话/线路构造

    private func session(
        id: String = "s1", scenario: SpeakScenarioId = "interview",
        difficulty: SpeakDifficulty = .hard, turns: [SpeakTurn],
        createdAt: Int64 = 1000, updatedAt: Int64 = 2000,
        context: SpeakSessionContext? = nil
    ) -> SpeakSession {
        SpeakSession(
            id: id, scenario: scenario, difficulty: difficulty, turns: turns,
            createdAt: createdAt, updatedAt: updatedAt, context: context
        )
    }

    private func attempt(_ total: Double) -> ShadowAttempt {
        ShadowAttempt(
            at: 1234, total: total, accuracy: 4.0, fluency: 4.5, integrity: 5,
            words: [ShadowWord(content: "hi", totalScore: 4.5, dpMessage: 0, sylls: [
                ShadowSyll(content: "h", syllScore: 4.5, serrMsg: 0, phones: [
                    ShadowPhone(content: "h", dpMessage: 0, gwpp: 0.5)
                ])
            ])]
        )
    }

    private func richSession() -> SpeakSession {
        session(
            turns: [
                SpeakTurn(role: .assistant, text: "Hello!", hintZh: "打招呼", shadowAttempts: [attempt(4.2)], at: 1000),
                SpeakTurn(
                    role: .user, text: "Hi there.", pron: attempt(3.9),
                    coachDiff: CoachDiff(segs: [CoachSeg(t: .del, v: "Hi"), CoachSeg(t: .ins, v: "Hello")], note: "更自然"),
                    at: 1100
                ),
            ],
            updatedAt: 2000,
            context: .vocab(wordIds: ["w1"])
        )
    }

    /// 最小合法云端记录（不带跟读历史——模拟别端精简投影）。
    private func minimalRecord(
        id: String = "s1", startedAt: Int64 = 1000, endedAt: Int64 = 2000,
        turns: [[String: Any]] = [["role": "user", "text": "hi", "at": 1500]]
    ) -> [String: Any] {
        [
            "id": id, "scenario": "travel", "difficulty": "easy", "v": 2,
            "startedAt": startedAt, "endedAt": endedAt, "turns": turns,
        ]
    }

    private func wireObject(
        id: String, version: Int64, updatedAtMs: Int64, deleted: Bool = false,
        payload: Any? = nil
    ) -> [String: Any] {
        [
            "id": id,
            "version": version,
            "updatedAt": syncFormatISO(updatedAtMs),
            "deleted": deleted,
            "schemaVersion": 2,
            "originDevice": "windows",
            "payload": deleted ? NSNull() : (payload ?? NSNull()),
        ]
    }

    private func pullResponse(_ entities: [[String: Any]], cursor: Int64) -> AuthHttpResponse {
        AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: syncJSONStringify([
            "collection": "speak-sessions", "serverVersion": cursor, "cursor": cursor,
            "hasMore": false, "entities": entities,
        ]) ?? "{}")
    }

    private func pushOk(_ id: String, version: Int64) -> AuthHttpResponse {
        AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: syncJSONStringify([
            "collection": "speak-sessions", "serverVersion": version,
            "results": [["id": id, "status": "accepted", "version": version]],
        ]) ?? "{}")
    }

    private func conflictResponse(id: String, serverVersion: Int64, server: Any?) -> AuthHttpResponse {
        AuthHttpResponse(status: 409, retryAfterSeconds: nil, body: syncJSONStringify([
            "error": ["code": "conflict", "details": [
                "conflicts": [["id": id, "serverVersion": serverVersion, "server": server ?? NSNull()]],
            ]],
        ]) ?? "{}")
    }

    private func pushedRows(_ body: String) -> [[String: Any]] {
        guard let data = body.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rows = object["entities"] as? [[String: Any]] else { return [] }
        return rows
    }

    // MARK: 投影（speak-sessions）

    func testProjectionKeepsRichFieldsAndStripsAudio() throws {
        let record = try speakSessionRecordFrom(richSession())
        // 富字段保留（跨设备续练所需的提示、发音报告和上下文）
        XCTAssertEqual(record["v"] as? Int, 2)
        XCTAssertEqual(record["id"] as? String, "s1")
        XCTAssertEqual(record["scenario"] as? String, "interview")
        XCTAssertEqual(record["difficulty"] as? String, "hard")
        XCTAssertEqual(syncJSONInt64(record["startedAt"]), 1000)  // = createdAt
        XCTAssertEqual(syncJSONInt64(record["endedAt"]), 2000)  // = updatedAt
        XCTAssertEqual(syncJSONInt64(record["createdAt"]), 1000)  // 原字段随展开保留
        let turns = try XCTUnwrap(record["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.count, 2)
        XCTAssertEqual(turns[0]["hintZh"] as? String, "打招呼")
        XCTAssertFalse((turns[0]["shadowAttempts"] as? [Any])?.isEmpty ?? true)
        XCTAssertNotNil(turns[1]["pron"])
        XCTAssertNotNil(turns[1]["coachDiff"])
        XCTAssertNotNil(record["context"])

        // 音频红线：记录 JSON 不含音频形态键
        let json = try XCTUnwrap(syncJSONStringify(record))
        XCTAssertNil(json.range(of: "audioB64|pcmB64|wavB64", options: .regularExpression))
    }

    func testWithoutAudioStripsBlacklistAndPathFormKeys() throws {
        let dirty: [String: Any] = [
            "audio": 1, "audioB64": "zzz", "pcmb64": "zzz", "wav": "zzz", "blob": "zzz",
            "localpath": "/tmp/x", "keep": "yes",
            "nested": ["audioBase64": "zzz", "pcm": "zzz", "ok": 2],
            "rows": [["audiofile": "zzz", "idx": 1], ["idx": 2]],
            "/cache/pcm/voice": "zzz",
        ]
        let cleaned = try XCTUnwrap(syncWithoutAudio(dirty) as? [String: Any])
        XCTAssertNil(cleaned["audio"])
        XCTAssertNil(cleaned["audioB64"])
        XCTAssertNil(cleaned["blob"])
        XCTAssertNil(cleaned["localpath"])
        XCTAssertEqual(cleaned["keep"] as? String, "yes")
        let nested = try XCTUnwrap(cleaned["nested"] as? [String: Any])
        XCTAssertNil(nested["audioBase64"])
        XCTAssertNil(nested["pcm"])
        XCTAssertEqual(nested["ok"] as? Int, 2)
        let rows = try XCTUnwrap(cleaned["rows"] as? [[String: Any]])
        XCTAssertNil(rows[0]["audiofile"])
        XCTAssertEqual(rows[1]["idx"] as? Int, 2)
        XCTAssertNil(cleaned["/cache/pcm/voice"])  // 路径形态键任一段命中黑名单
    }

    func testRecordRoundTripRestoresSession() throws {
        let record = try speakSessionRecordFrom(richSession())
        let restored = try XCTUnwrap(speakSessionFromRecord(record))
        XCTAssertEqual(restored.id, "s1")
        XCTAssertEqual(restored.scenario, "interview")
        XCTAssertEqual(restored.difficulty, .hard)
        XCTAssertEqual(restored.turns.count, 2)
        XCTAssertEqual(restored.createdAt, 1000)  // createdAt = startedAt
        XCTAssertEqual(restored.updatedAt, 2000)  // max(startedAt, endedAt)
        // endedAt 比 startedAt 旧（异常数据）也钳回 startedAt
        var swapped = record
        swapped["endedAt"] = 500
        let clamped = try XCTUnwrap(speakSessionFromRecord(swapped))
        XCTAssertEqual(clamped.updatedAt, 1000)
    }

    /// 非内置场景 id（官方 off_ / 用户 usr_，A1 起 SpeakScenarioId 为裸 String）
    /// 的云端记录照常还原——他端自定义场景的会话在 Mac 口语列表不丢行。
    func testRecordRoundTripKeepsNonBuiltinScenarioIds() throws {
        for scenario in ["off_business_call", "usr_7f3c2a10-1b2e-4c3d-9e8f-0a1b2c3d4e5f"] {
            var record = try speakSessionRecordFrom(richSession())
            record["scenario"] = scenario
            XCTAssertTrue(isSpeakSessionRecordLike(record), "形状守卫只查 scenario 是 String")
            let restored = try XCTUnwrap(speakSessionFromRecord(record), "非内置场景 id 不得还原成 nil")
            XCTAssertEqual(restored.scenario, scenario)
        }
    }

    func testOversizeThrowsAndNeverTrimsTurns() {
        var turns: [SpeakTurn] = []
        for i in 0..<200 {
            turns.append(SpeakTurn(role: .assistant, text: String(repeating: "a", count: 380), at: Int64(1000 + i)))
        }
        let big = session(turns: turns, updatedAt: 9999)
        XCTAssertThrowsError(try speakSessionRecordFrom(big)) { error in
            XCTAssertEqual(
                (error as? SyncStoreError)?.message,
                "口语记录超过 64KB 同步上限，完整记录仍保留在本机，请分段练习后再同步"
            )
        }
        // 完整记录保留本机，绝不裁剪真实练习轮次
        XCTAssertEqual(big.turns.count, 200)
        XCTAssertEqual(big.turns.last?.text.count, 380)
    }

    func testSingleLongTurnTextPreservedInFull() throws {
        let long = String(repeating: "词", count: 3000)  // 3000 字（9KB UTF-8）在容量内
        let s = session(turns: [SpeakTurn(role: .user, text: long, at: 1000)])
        let record = try speakSessionRecordFrom(s)
        let turns = try XCTUnwrap(record["turns"] as? [[String: Any]])
        XCTAssertEqual((turns[0]["text"] as? String)?.count, 3000)  // 不截断
    }

    // MARK: 会话形状守卫

    func testSessionShapeGuardFullMatrix() {
        let legal = minimalRecord()
        XCTAssertTrue(isSpeakSessionRecordLike(legal))
        func with(_ patch: [String: Any]) -> [String: Any] {
            var copy = legal
            for (key, value) in patch { copy[key] = value }
            return copy
        }
        XCTAssertTrue(isSpeakSessionRecordLike(with(["scenario": "未来场景id"])))  // scenario 只要是 string
        XCTAssertFalse(isSpeakSessionRecordLike(with(["id": ""])))  // 空 id
        XCTAssertFalse(isSpeakSessionRecordLike(with(["difficulty": "harder"])))  // 非法难度
        XCTAssertFalse(isSpeakSessionRecordLike(with(["turns": [["role": "bot", "text": "x", "at": 1]]])))  // 非法 role
        XCTAssertFalse(isSpeakSessionRecordLike(with(["turns": [["role": "user", "text": "x", "at": "1"]]])))
        XCTAssertFalse(isSpeakSessionRecordLike(with(["endedAt": "2000"])))  // 字符串时间
        XCTAssertFalse(isSpeakSessionRecordLike(with(["startedAt": true])))  // 布尔不是数字
        XCTAssertFalse(isSpeakSessionRecordLike(NSNull()))  // 非对象
        XCTAssertFalse(isSpeakSessionRecordLike("s1"))  // 裸字符串
        XCTAssertFalse(isSpeakSessionRecordLike(with(["turns": NSNull()])))  // turns 非数组
    }

    // MARK: 评测投影（speak-assessments）

    private func assessmentInput(
        sessionId: String? = nil, now: Int64 = 5_000_000, wordCount: Int = 3,
        refText: String = "Hello world"
    ) -> SpeakAssessmentInput {
        let words = (0..<wordCount).map { i in
            WordScore(
                content: "w\(i)", totalScore: Double(i) + 3, dpMessage: 0,
                sylls: [SyllScore(content: "s", syllScore: 4, serrMsg: 0, phones: [
                    PhoneScore(content: "p", dpMessage: 0, gwpp: 0.5)
                ])]
            )
        }
        let result = PronunciationResult(
            total: 4.1, accuracy: 4.2, fluency: 4.3, standard: 4.4,
            integrity: 4.9, isRejected: false, exceptInfo: nil, words: words
        )
        return SpeakAssessmentInput(
            result: result, source: sessionId == nil ? .reader : .coach,
            refText: refText, sessionId: sessionId, now: now
        )
    }

    func testAssessmentProjectionKeepsScoresAndDropsSyllables() throws {
        let record = speakAssessmentRecordFrom(assessmentInput())
        XCTAssertTrue(record.id.hasPrefix("sa\(String(5_000_000, radix: 36))"), record.id)  // 前缀+时间 36 进制
        XCTAssertEqual(record.source, .reader)
        XCTAssertEqual(record.lang, "en")  // 缺省 en
        XCTAssertEqual(record.total, 4.1, accuracy: 0.0001)
        XCTAssertEqual(record.accuracy, 4.2, accuracy: 0.0001)
        XCTAssertEqual(record.fluency, 4.3, accuracy: 0.0001)
        XCTAssertEqual(record.standard, 4.4, accuracy: 0.0001)
        XCTAssertEqual(record.at, 5_000_000)
        // sessionId 缺省不出现（Windows 展开语义）
        let payloadJSON = try XCTUnwrap(syncJSONStringify(record.payload))
        XCTAssertFalse(payloadJSON.contains("sessionId"))
        // 丢音节/音素明细：words 只有 {w, s}
        let words = try XCTUnwrap(record.payload["words"] as? [[String: Any]])
        XCTAssertEqual(words.count, 3)
        XCTAssertEqual(words[0]["w"] as? String, "w0")
        XCTAssertEqual(syncJSONNumber(words[0]["s"]), 3.0)
        XCTAssertNil(words[0]["sylls"])
        XCTAssertNil(words[0]["phones"])
        XCTAssertNil(words[0]["dpMessage"])
        XCTAssertFalse(payloadJSON.contains("syll"))
        XCTAssertFalse(payloadJSON.contains("phone"))
    }

    func testAssessmentTruncationLimits() {
        let record = speakAssessmentRecordFrom(assessmentInput(wordCount: 70))
        XCTAssertEqual(record.words.count, 64)  // 逐词截 64（丢尾）
        let longText = String(repeating: "x", count: 1200)
        XCTAssertEqual(
            speakAssessmentRecordFrom(assessmentInput(refText: longText)).refText.count,
            1000  // 参考文本截 1000
        )
        let longWord = speakAssessmentRecordFrom(SpeakAssessmentInput(
            result: PronunciationResult(
                total: 4, accuracy: 4, fluency: 4, standard: 4, integrity: 5,
                isRejected: false, exceptInfo: nil,
                words: [WordScore(content: String(repeating: "w", count: 80), totalScore: 4, dpMessage: 0)]
            ),
            source: .coach, refText: "x", now: 1
        ))
        XCTAssertEqual(longWord.words[0].w.count, 64)  // 词面截 64 字符
        // coach 来源关联会话 id
        let coach = speakAssessmentRecordFrom(assessmentInput(sessionId: "s9"))
        XCTAssertEqual(coach.sessionId, "s9")
        XCTAssertEqual(coach.payload["sessionId"] as? String, "s9")
        // 载荷还原往返
        let restored = SpeakAssessmentRecord(payload: coach.payload)
        XCTAssertEqual(restored?.id, coach.id)
        XCTAssertEqual(restored?.words.map(\.w), coach.words.map(\.w))
    }

    func testAssessmentShapeGuardFullMatrix() {
        let legal: [String: Any] = [
            "id": "sa1", "source": "reader", "lang": "en", "refText": "hi",
            "total": 4, "accuracy": 4, "fluency": 4, "standard": 4,
            "words": [["w": "hi", "s": 4]], "at": 1,
        ]
        XCTAssertTrue(isSpeakAssessmentRecordLike(legal))
        func with(_ patch: [String: Any]) -> [String: Any] {
            var copy = legal
            for (key, value) in patch { copy[key] = value }
            return copy
        }
        XCTAssertTrue(isSpeakAssessmentRecordLike(with(["source": "review"])))
        XCTAssertTrue(isSpeakAssessmentRecordLike(with(["source": "coach"])))
        XCTAssertTrue(isSpeakAssessmentRecordLike(with(["sessionId": "s1"])))  // 可选字段不影响
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["source": "elsewhere"])))  // 坏 source
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["total": "4"])))  // 非数值分数
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["total": true])))  // 布尔不是数字
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["fluency": NSNull()])))
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["words": [["w": "hi", "s": "4"]]])))  // 坏 words
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["words": [["w": 4, "s": 4]]])))
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["words": NSNull()])))
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["at": NSNull()])))
        XCTAssertFalse(isSpeakAssessmentRecordLike(["id": "sa1"]))  // 缺字段
        XCTAssertFalse(isSpeakAssessmentRecordLike(with(["id": ""])))
    }

    // MARK: 入队

    func testEnqueueKeepsSyncedBaseVersionAndMarksDirty() throws {
        let (syncer, store, _) = makeSyncer("enqueue")
        // 已同步过的实体：baseVersion 7、干净
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "s1", baseVersion: 7, updatedAt: 1000, deleted: false,
                schemaVersion: 2, originDevice: "windows", payload: ["id": "s1", "v": 2], dirty: false
            )
        ])
        try syncer.enqueueSessionRecord(richSession())
        let landed = try XCTUnwrap(try store.list("speak-sessions").first { $0.id == "s1" })
        XCTAssertEqual(landed.baseVersion, 7)  // 沿用已同步值，避免无谓 409
        XCTAssertTrue(landed.dirty)
        XCTAssertEqual(landed.originDevice, "mac")  // Mac 报真实平台
        XCTAssertEqual(landed.schemaVersion, 2)
        let payload = try XCTUnwrap(landed.payload as? [String: Any])
        XCTAssertEqual(payload["v"] as? Int, 2)
        XCTAssertEqual(syncJSONInt64(payload["endedAt"]), 2000)  // LWW 时钟 = 会话 updatedAt

        // 新实体：baseVersion 0
        try syncer.enqueueSessionRecord(session(id: "s2", turns: [], updatedAt: 3000))
        let fresh = try XCTUnwrap(try store.list("speak-sessions").first { $0.id == "s2" })
        XCTAssertEqual(fresh.baseVersion, 0)
        XCTAssertTrue(fresh.dirty)
    }

    func testEnqueueMergesUnknownFieldsFromExistingPayload() throws {
        let (syncer, store, _) = makeSyncer("merge")
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "s1", baseVersion: 3, updatedAt: 1000, deleted: false,
                schemaVersion: 2, originDevice: nil,
                payload: ["id": "s1", "v": 2, "futureField": ["a": 1], "audioB64": "should-drop"], dirty: false
            )
        ])
        try syncer.enqueueSessionRecord(richSession())
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        let payload = try XCTUnwrap(landed.payload as? [String: Any])
        // 深合并保留未知业务字段（mergeRelayPayload 语义）+ 音频键剥离（withoutAudio）
        XCTAssertEqual((payload["futureField"] as? [String: Any])?["a"] as? Int, 1)
        XCTAssertNil(payload["audioB64"])
    }

    func testEnqueueMakesZeroNetworkRequests() throws {
        // 游客（未登录）同样可用：入队/裁剪是纯本地文件操作
        let (syncer, _, transport) = makeSyncer("zero-net")
        try syncer.enqueueSessionRecord(richSession())
        try syncer.enqueueAssessment(assessmentInput())
        XCTAssertEqual(transport.calls, 0)
    }

    // MARK: 500 条滚动裁剪

    func testOverflowTombstonesOldestBeyond500() throws {
        let (syncer, store, _) = makeSyncer("500")
        var seeds: [StoredSyncEntity] = []
        for i in 0..<500 {
            seeds.append(StoredSyncEntity(
                id: "e\(i)", baseVersion: Int64(i), updatedAt: Int64(1000 + i), deleted: false,
                schemaVersion: 2, originDevice: "mac",
                payload: ["id": "e\(i)", "v": 2, "scenario": "interview", "difficulty": "easy",
                          "startedAt": 1, "endedAt": Int64(1000 + i), "turns": []],
                dirty: false
            ))
        }
        try store.put("speak-sessions", seeds)
        try syncer.enqueueSessionRecord(session(id: "brand-new", turns: [], updatedAt: 999_999))

        let landed = try store.list("speak-sessions")
        XCTAssertEqual(landed.filter { !$0.deleted }.count, 500)  // 499 旧活 + 1 新
        // 最旧 1 条转 tombstone：保留 baseVersion / payload 空 / dirty，updatedAt 晚于被裁记录
        let tombstoned = try XCTUnwrap(landed.first { $0.id == "e0" })
        XCTAssertTrue(tombstoned.deleted)
        XCTAssertNil(tombstoned.payload)
        XCTAssertTrue(tombstoned.dirty)
        XCTAssertEqual(tombstoned.baseVersion, 0)
        XCTAssertEqual(tombstoned.updatedAt, 999_999)  // max(now, 原+1)
        // 次旧的不动
        let second = try XCTUnwrap(landed.first { $0.id == "e1" })
        XCTAssertFalse(second.deleted)
    }

    func testNoTombstoneUnder500() throws {
        let (syncer, store, _) = makeSyncer("499")
        var seeds: [StoredSyncEntity] = []
        for i in 0..<499 {
            seeds.append(StoredSyncEntity(
                id: "e\(i)", baseVersion: 0, updatedAt: Int64(1000 + i), deleted: false,
                schemaVersion: 2, originDevice: "mac", payload: ["v": 2], dirty: false
            ))
        }
        try store.put("speak-sessions", seeds)
        try syncer.enqueueSessionRecord(session(id: "new", turns: [], updatedAt: 999_999))
        let landed = try store.list("speak-sessions")
        XCTAssertEqual(landed.count, 500)
        XCTAssertFalse(landed.contains { $0.deleted })  // 不满 500 不产生 tombstone
    }

    // MARK: 删除（tombstone）

    func testDeleteUsesTombstoneAndReturnsFalseWhenAlreadyGone() throws {
        let (syncer, store, _) = makeSyncer("delete")
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "s1", baseVersion: 4, updatedAt: 2000, deleted: false,
                schemaVersion: 2, originDevice: "mac", payload: ["v": 2], dirty: false
            )
        ])
        XCTAssertTrue(try syncer.deleteSessionRecord(id: "s1", now: 3000))
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertTrue(landed.deleted)
        XCTAssertNil(landed.payload)
        XCTAssertTrue(landed.dirty)
        XCTAssertEqual(landed.baseVersion, 4)  // 保留 baseVersion
        XCTAssertEqual(landed.updatedAt, 3000)  // max(now=3000, 原 2000+1)：晚于原值保证删除可传播
        // 重复删返回 false（无状态变化）
        XCTAssertFalse(try syncer.deleteSessionRecord(id: "s1", now: 4000))
        // 本就不存在的 id 返回 false
        XCTAssertFalse(try syncer.deleteSessionRecord(id: "ghost", now: 4000))
    }

    // MARK: push 载荷红线（端到端经引擎发出的请求体）

    func testPushWirePayloadAudioRedline() async throws {
        let (syncer, store, transport) = makeSyncer("redline")
        // 活实体：富会话精简记录；tombstone：已删实体
        try syncer.enqueueSessionRecord(richSession())
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "gone", baseVersion: 2, updatedAt: 1500, deleted: true,
                schemaVersion: 2, originDevice: "mac", payload: nil, dirty: true
            )
        ])
        transport.queue(pullResponse([], cursor: 1))
        transport.queue(pushOk("s1", version: 3))

        _ = await syncer.engine.syncNow("speak-sessions")
        XCTAssertEqual(transport.pushBodies.count, 1)
        let body = try XCTUnwrap(transport.pushBodies.first)
        // 活实体载荷 JSON 不含音频形态键（红线正则，与 Windows speakRecords.test.ts:385-406 同款）
        XCTAssertNil(body.range(
            of: "audio|base64|pcm|blob|data:audio",
            options: [.regularExpression, .caseInsensitive]
        ), body)
        // tombstone 线路 payload 必须为 null
        let rows = pushedRows(body)
        let tombstone = try XCTUnwrap(rows.first { ($0["id"] as? String) == "gone" })
        XCTAssertEqual(tombstone["deleted"] as? Bool, true)
        XCTAssertTrue(tombstone["payload"] is NSNull)
        // originDevice 报真实平台
        let live = try XCTUnwrap(rows.first { ($0["id"] as? String) == "s1" })
        XCTAssertEqual(live["originDevice"] as? String, "mac")
    }

    // MARK: list 过滤脏行

    func testListFiltersTombstonesAndMalformedRows() throws {
        let (syncer, store, _) = makeSyncer("list")
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "ok", baseVersion: 0, updatedAt: 1, deleted: false,
                schemaVersion: 2, originDevice: nil, payload: minimalRecord(id: "ok"), dirty: false
            ),
            StoredSyncEntity(
                id: "gone", baseVersion: 0, updatedAt: 2, deleted: true,
                schemaVersion: 2, originDevice: nil, payload: nil, dirty: false
            ),
            StoredSyncEntity(
                id: "dirty-row", baseVersion: 0, updatedAt: 3, deleted: false,
                schemaVersion: 2, originDevice: nil, payload: ["nonsense": true], dirty: false
            ),
        ])
        let records = syncer.listSessionRecords()
        XCTAssertEqual(records.count, 1)  // tombstone 与形状不符的脏行整条丢弃
        XCTAssertEqual(records.first?["id"] as? String, "ok")
    }

    // MARK: 展示合并

    func testMergeKeepsLocalSupersetOnEqualOrNewer() throws {
        let local = richSession()  // updatedAt 2000，assistant 轮带 shadowAttempts
        // 云端较旧（1500）：保留本地富会话超集
        var cloudOlder = minimalRecord(endedAt: 1500)
        cloudOlder["id"] = "s1"
        var merged = speakMergeSessionsWithRecords(local: [local], records: [cloudOlder])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].updatedAt, 2000)
        XCTAssertFalse(merged[0].turns[0].shadowAttempts?.isEmpty ?? true)

        // 相等也保留本地（Windows：本地 ≥ 云端保留本地）
        let cloudEqual = minimalRecord(endedAt: 2000)
        merged = speakMergeSessionsWithRecords(local: [local], records: [cloudEqual])
        XCTAssertFalse(merged[0].turns[0].shadowAttempts?.isEmpty ?? true)

        // 云端严格较新（别端续聊过）→ 用云端精简版（无跟读历史）
        let cloudNewer = minimalRecord(endedAt: 3000)
        merged = speakMergeSessionsWithRecords(local: [local], records: [cloudNewer])
        XCTAssertEqual(merged[0].updatedAt, 3000)
        XCTAssertNil(merged[0].turns[0].shadowAttempts)

        // 不相交 id 并集，updatedAt 倒序
        let cloudOther = minimalRecord(id: "s-other", startedAt: 2400, endedAt: 2500)
        let other = speakMergeSessionsWithRecords(local: [local], records: [cloudOther])
        XCTAssertEqual(other.map(\.id), ["s-other", "s1"])

        // practice-task 行跳过（他端练习任务不在口语列表露头）
        var task = minimalRecord()
        task["kind"] = "practice-task"
        XCTAssertTrue(speakMergeSessionsWithRecords(local: [], records: [task]).isEmpty)
    }

    // MARK: B 端首拉（云端记录 → 本地落库 → list 读到）

    func testFirstPullLandsCloudRecords() async throws {
        let (syncer, store, transport) = makeSyncer("first-pull")
        transport.queue(pullResponse([
            wireObject(id: "c1", version: 2, updatedAtMs: 1000, payload: minimalRecord(id: "c1", endedAt: 1000)),
            wireObject(id: "c2", version: 3, updatedAtMs: 2000, payload: minimalRecord(id: "c2", endedAt: 2000)),
            wireObject(id: "c3", version: 4, updatedAtMs: 3000, payload: minimalRecord(id: "c3", endedAt: 3000)),
        ], cursor: 9))

        let summary = await syncer.engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.appliedRemote, 3)
        let landed = try store.list("speak-sessions")
        XCTAssertEqual(landed.count, 3)
        let expectedVersions: [String: Int64] = ["c1": 2, "c2": 3, "c3": 4]
        for entity in landed {
            XCTAssertFalse(entity.dirty)  // wire.version → baseVersion、干净落库
            XCTAssertEqual(entity.baseVersion, expectedVersions[entity.id])
        }
        XCTAssertEqual(syncer.listSessionRecords().count, 3)
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 9)
    }

    // MARK: 双端改同一条 → 409 后携 serverVersion 重推

    func testConflictingEditsResolveBy409AndRepush() async throws {
        let (syncer, store, transport) = makeSyncer("conflict")
        // 本地 dirty updatedAt 5000 vs 服务端 version 5 updatedAt 4000（增量拉取：
        // 游标预置 3，走逐实体 LWW 合并分支）
        try store.cursorSet("speak-sessions", 3)
        try syncer.enqueueSessionRecord(session(id: "s1", turns: [], updatedAt: 5000))
        transport.queue(pullResponse([
            wireObject(id: "s1", version: 5, updatedAtMs: 4000, payload: minimalRecord(id: "s1", endedAt: 4000)),
        ], cursor: 5))
        transport.queue(conflictResponse(
            id: "s1", serverVersion: 5,
            server: wireObject(id: "s1", version: 5, updatedAtMs: 4000, payload: minimalRecord(id: "s1", endedAt: 4000))
        ))
        transport.queue(pushOk("s1", version: 6))

        let summary = await syncer.engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.keptLocal, 1)  // 拉取阶段本地较新保留
        XCTAssertEqual(summary.conflicts, 1)
        XCTAssertEqual(summary.pushed, 1)
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertEqual(landed.baseVersion, 6)  // 重推 accepted → 新版本落库
        XCTAssertFalse(landed.dirty)
        XCTAssertEqual(landed.updatedAt, 5000)  // 本地内容（LWW 本地胜）
    }

    // MARK: tombstone 传播（A 端删 1 条 → B 端拉到 deleted 落库）

    func testTombstonePropagatesViaPull() async throws {
        let (syncer, store, transport) = makeSyncer("tombstone")
        // B 端此前已同步干净（无待推编辑），A 端删除后服务端下发 tombstone
        try store.put("speak-sessions", [
            StoredSyncEntity(
                id: "s1", baseVersion: 1, updatedAt: 1000, deleted: false,
                schemaVersion: 2, originDevice: "mac", payload: minimalRecord(), dirty: false
            )
        ])
        transport.queue(pullResponse([
            wireObject(id: "s1", version: 2, updatedAtMs: 5000, deleted: true),
        ], cursor: 2))

        let summary = await syncer.engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertTrue(landed.deleted)
        XCTAssertNil(landed.payload)
        XCTAssertFalse(landed.dirty)
        XCTAssertTrue(syncer.listSessionRecords().isEmpty)  // list 不再返回
    }

    // MARK: 游客 / 登录态读取失败（零网络）

    @MainActor
    func testGuestSkipsSyncEntirely() async throws {
        let (syncer, _, transport) = makeSyncer("guest")
        // loginStatus 缺省返回 loggedOut
        let summaries = await syncer.syncSpeakRecordsSilently()
        XCTAssertTrue(summaries.isEmpty)
        XCTAssertEqual(transport.calls, 0)  // 零网络
    }

    @MainActor
    func testLoginStatusFailureSkipsSync() async throws {
        let (base, _, transport) = makeSyncer("status-fail")
        // 登录态读取失败（nil）：宁可不同步也不出网
        let syncer = SpeakRecordsSyncer(store: base.store, engine: base.engine, loginStatus: { nil })
        let summaries = await syncer.syncSpeakRecordsSilently()
        XCTAssertTrue(summaries.isEmpty)
        XCTAssertEqual(transport.calls, 0)
    }
}
