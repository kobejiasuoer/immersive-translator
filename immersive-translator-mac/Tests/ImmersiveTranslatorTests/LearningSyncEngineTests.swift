import Combine
import XCTest
@testable import ImmersiveTranslator
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 学习接力 v2 协议引擎单测（对齐 Windows syncEngine.test.ts「学习接力持久性」
// 全部 12 向量 + 集合级 schemaVersions 协商 + LearningRelaySync 入口文案）。
// 装配：LearningStore（SQLite，临时目录）+ fake 传输（FIFO 回放 + 计数）。
// ---------------------------------------------------------------------------

final class LearningSyncEngineTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    private func tempRoot(_ label: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("learning-sync-tests-\(UUID().uuidString)-\(label)", isDirectory: true)
        tmpDirs.append(dir)
        return dir
    }

    // MARK: fake 传输

    private final class FakeTransport {
        struct PushCall { let body: [String: Any] }
        private let lock = NSLock()
        private var pulls: [AuthHttpResponse] = []
        private var pushes: [AuthHttpResponse] = []
        private(set) var pullCalls = 0
        private(set) var pushBodies: [[String: Any]] = []
        /// 推送请求到达时的异步挂钩（模拟推送在途时的并发本地编辑）。
        var pushBeforeRespond: ((_ body: [String: Any]) -> Void)?

        func queuePull(_ response: AuthHttpResponse) { lock.lock(); defer { lock.unlock() }; pulls.append(response) }
        func queuePush(_ response: AuthHttpResponse) { lock.lock(); defer { lock.unlock() }; pushes.append(response) }

        func pull() throws -> AuthHttpResponse {
            lock.lock(); defer { lock.unlock() }
            pullCalls += 1
            return pulls.isEmpty ? Self.emptyPage : pulls.removeFirst()
        }

        func push(_ body: String) throws -> AuthHttpResponse {
            let parsed = ((try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any]) ?? [:]
            lock.lock(); defer { lock.unlock() }
            pushBodies.append(parsed)
            if let hook = pushBeforeRespond { hook(parsed) }
            return pushes.isEmpty ? Self.defaultPush(parsed) : pushes.removeFirst()
        }

        static let emptyPage = makeBody([
            "collection": "speak-sessions", "serverVersion": 0, "cursor": 0,
            "hasMore": false, "entities": [] as [Any],
        ])

        static func defaultPush(_ body: [String: Any]) -> AuthHttpResponse {
            let entities = (body["entities"] as? [[String: Any]]) ?? []
            return makeBody([
                "collection": "speak-sessions", "serverVersion": 100,
                "results": entities.enumerated().map { index, entity in
                    ["id": entity["id"] ?? "", "status": "accepted", "version": 50 + index]
                },
            ])
        }

        static func makeBody(_ body: [String: Any]) -> AuthHttpResponse {
            AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: syncJSONStringify(body) ?? "{}")
        }
    }

    private static func ok(_ body: [String: Any]) -> AuthHttpResponse {
        AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: syncJSONStringify(body) ?? "{}")
    }

    private static func http(_ status: Int, _ body: [String: Any]) -> AuthHttpResponse {
        AuthHttpResponse(status: status, retryAfterSeconds: nil, body: syncJSONStringify(body) ?? "{}")
    }

    // MARK: 装配

    private struct Rig {
        let store: LearningStore
        let engine: SyncEngine
        let transport: FakeTransport
        var namespace: String
    }

    private func makeRig(_ label: String, namespace: String = "account-test") -> Rig {
        let learning = LearningStore(rootDirectory: tempRoot(label), center: NotificationCenter())
        learning.setAccount(userId: "test")  // 命名空间 account-<hex(test)>
        let transport = FakeTransport()
        let engine = SyncEngine(dependencies: SyncEngineDependencies(
            pull: { _, since, limit, ns in
                _ = try learning.verifyNamespace(ns)
                return try await Task.detached { try transport.pull() }.value
            },
            push: { _, body, ns in
                _ = try learning.verifyNamespace(ns)
                return try await Task.detached { try transport.push(body) }.value
            },
            list: { collection, ns in try learning.list(collection, expectedNamespace: ns) },
            put: { collection, entities, ns in try learning.storePut(collection, entities, expectedNamespace: ns) },
            replace: { collection, entities, cursor, ns in
                try learning.storePut(collection, entities, replace: true, cursor: cursor, expectedNamespace: ns)
            },
            cursorGet: { collection, ns in try learning.cursorGet(collection, expectedNamespace: ns) },
            cursorSet: { collection, cursor, ns in
                try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: ns)
            },
            namespace: { learning.currentNamespace() },
            sleep: { _ in }
        ))
        return Rig(store: learning, engine: engine, transport: transport, namespace: learning.currentNamespace())
    }

    // MARK: 载荷

    private func wire(_ id: String, version: Int64, updatedAtMs: Int64, payload: Any? = nil, deleted: Bool = false, schemaVersion: Int64 = 2) -> [String: Any] {
        [
            "id": id, "version": version, "updatedAt": syncFormatISO(updatedAtMs),
            "deleted": deleted, "schemaVersion": schemaVersion, "originDevice": "phone",
            "payload": deleted ? NSNull() : (payload ?? NSNull()),
        ]
    }

    private func taskPayload(attemptID: String, at: Int64) -> JSONObject {
        [
            "v": 2, "id": "task", "kind": "practice-task", "updatedAt": at,
            "task": [
                "id": "task", "title": "Practice", "mode": "word", "reference": "Hello", "step": 0,
                "draft": "", "status": "active", "createdAt": 1, "updatedAt": at,
                "attempts": [["id": attemptID, "step": 0, "text": attemptID, "deviceId": attemptID, "status": "draft", "createdAt": at]],
            ] as JSONObject,
        ]
    }

    private func attemptIDs(_ payload: Any?) -> [String] {
        let attempts = LearningJSON.array(LearningJSON.object(LearningJSON.object(payload)?["task"])?["attempts"]) ?? []
        return attempts.compactMap { LearningJSON.object($0)?["id"] as? String }
    }

    private func pullPage(cursor: Int64, hasMore: Bool, entities: [[String: Any]], collection: String = "speak-sessions") -> AuthHttpResponse {
        Self.ok(["collection": collection, "serverVersion": cursor, "cursor": cursor, "hasMore": hasMore, "entities": entities])
    }

    private func stored(
        _ id: String, updatedAt: Int64, payload: Any? = ["v": 2], deleted: Bool = false,
        baseVersion: Int64 = 0, dirty: Bool = true, schemaVersionValue: Int64 = 2
    ) -> StoredSyncEntity {
        StoredSyncEntity(id: id, baseVersion: baseVersion, updatedAt: updatedAt, deleted: deleted, schemaVersion: schemaVersionValue, originDevice: "mac", payload: payload, dirty: dirty)
    }

    // MARK: 同 task 双端离线回答（游标 0 / 10）

    func testOfflineAnswersFromBothDevicesUnionAfterPullAndPush() async throws {
        for initial in [Int64(0), 10] {
            let rig = makeRig("union-\(initial)")
            try rig.store.storePut("speak-sessions", [stored("task", updatedAt: 20, payload: taskPayload(attemptID: "windows", at: 20))])
            if initial > 0 { try rig.store.storePut("speak-sessions", [], cursor: initial) }
            rig.transport.queuePull(pullPage(cursor: 30, hasMore: false, entities: [
                wire("task", version: 30, updatedAtMs: 30, payload: taskPayload(attemptID: "phone", at: 30)),
            ]))
            let summary = await rig.engine.syncNow("speak-sessions")
            XCTAssertTrue(summary.ok, summary.error ?? "")
            let entity = try XCTUnwrap(try rig.store.list("speak-sessions").first(where: { $0.id == "task" }))
            XCTAssertEqual(attemptIDs(entity.payload), ["windows", "phone"])
            // 合并结果随推送上行，baseVersion 吸收服务端版本
            let pushed = try XCTUnwrap(rig.transport.pushBodies.first?["entities"] as? [[String: Any]])
            XCTAssertEqual(pushed.first?["baseVersion"] as? Int64, 30)
            let pushedAttempts = attemptIDs(pushed.first?["payload"])
            XCTAssertEqual(pushedAttempts, ["windows", "phone"])
            XCTAssertFalse(entity.dirty)
        }
    }

    func test409MergesUnionAndRepushesWithServerVersion() async throws {
        let rig = makeRig("409-union")
        try rig.store.storePut("speak-sessions", [stored("task", updatedAt: 20, payload: taskPayload(attemptID: "windows", at: 20))])
        try rig.store.storePut("speak-sessions", [], cursor: 10)
        rig.transport.queuePull(pullPage(cursor: 10, hasMore: false, entities: []))
        let conflict = Self.http(409, [
            "error": ["code": "sync_conflict", "details": [
                "conflicts": [[
                    "id": "task", "serverVersion": 30,
                    "server": wire("task", version: 30, updatedAtMs: 30, payload: taskPayload(attemptID: "phone", at: 30)),
                ]],
            ]],
        ])
        rig.transport.queuePush(conflict)
        let summary = await rig.engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(rig.transport.pushBodies.count, 2)
        let entity = try XCTUnwrap(try rig.store.list("speak-sessions").first(where: { $0.id == "task" }))
        XCTAssertEqual(attemptIDs(entity.payload), ["windows", "phone"])
        let repushed = try XCTUnwrap(rig.transport.pushBodies.last?["entities"] as? [[String: Any]])
        XCTAssertEqual(repushed.first?["baseVersion"] as? Int64, 30)
    }

    func testRemoteDeletionIsNotResurrectedByNewerLocalDirtyAnswer() async throws {
        let rig = makeRig("remote-delete")
        try rig.store.storePut("speak-sessions", [stored("task", updatedAt: 100, payload: taskPayload(attemptID: "windows", at: 100))])
        rig.transport.queuePull(pullPage(cursor: 30, hasMore: false, entities: [
            wire("task", version: 30, updatedAtMs: 30, deleted: true, schemaVersion: 2),
        ]))
        _ = await rig.engine.syncNow("speak-sessions")
        let entity = try XCTUnwrap(try rig.store.list("speak-sessions").first(where: { $0.id == "task" }))
        XCTAssertTrue(entity.deleted)
        XCTAssertFalse(entity.dirty)
        XCTAssertEqual(rig.transport.pushBodies.count, 0)
    }

    func testLocalDeletionIsNotResurrectedByNewerRemotePractice() async throws {
        let rig = makeRig("local-delete")
        try rig.store.storePut("speak-sessions", [stored("task", updatedAt: 20, payload: nil, deleted: true)])
        try rig.store.storePut("speak-sessions", [], cursor: 10)
        rig.transport.queuePull(pullPage(cursor: 30, hasMore: false, entities: [
            wire("task", version: 30, updatedAtMs: 30, payload: taskPayload(attemptID: "phone", at: 30)),
        ]))
        _ = await rig.engine.syncNow("speak-sessions")
        let entity = try XCTUnwrap(try rig.store.list("speak-sessions").first(where: { $0.id == "task" }))
        XCTAssertTrue(entity.deleted)
        // tombstone 随推送上行，baseVersion 吸收远端版本
        let pushed = try XCTUnwrap(rig.transport.pushBodies.first?["entities"] as? [[String: Any]])
        XCTAssertEqual(pushed.first?["deleted"] as? Bool, true)
        XCTAssertEqual(pushed.first?["baseVersion"] as? Int64, 30)
    }

    func testFullSnapshotSecondPageFailureKeepsSnapshotAndCursor() async throws {
        let rig = makeRig("full-fail")
        try rig.store.storePut("reading-articles", [stored("old", updatedAt: 10, payload: ["v": 2], baseVersion: 2, dirty: false)])
        rig.transport.queuePull(pullPage(cursor: 5, hasMore: true, entities: [
            wire("new", version: 5, updatedAtMs: 50, payload: ["v": 2]),
        ]))
        rig.transport.queuePull(Self.http(500, ["error": ["code": "temporary"]]))
        let summary = await rig.engine.syncNow("reading-articles")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(try rig.store.cursorGet("reading-articles"), 0)
        let ids = try rig.store.list("reading-articles").map(\.id)
        XCTAssertTrue(ids.contains("old"))
        XCTAssertFalse(ids.contains("new"))
    }

    func testStaleCursorFullResyncRemovesCleanKeepsPending() async throws {
        let rig = makeRig("stale")
        try rig.store.storePut("reading-vocab", [stored("old", updatedAt: 10, dirty: false)])
        try rig.store.storePut("reading-vocab", [stored("pending", updatedAt: 200)])
        try rig.store.storePut("reading-vocab", [], cursor: 20)
        rig.transport.queuePull(Self.http(409, ["error": ["code": "staleCursor"]]))
        rig.transport.queuePull(pullPage(cursor: 30, hasMore: false, entities: [
            wire("remote", version: 30, updatedAtMs: 300, payload: ["v": 2]),
        ]), )
        let summary = await rig.engine.syncNow("reading-vocab")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        let ids = try rig.store.list("reading-vocab").map(\.id)
        XCTAssertFalse(ids.contains("old"))  // clean 旧记录被全量快照替换掉
        XCTAssertTrue(ids.contains("pending"))  // dirty 保留
        XCTAssertTrue(ids.contains("remote"))
        XCTAssertEqual(try rig.store.cursorGet("reading-vocab"), 30)
    }

    func testImmutableEventConflictFailsSyncAndKeepsLocalDirty() async throws {
        let rig = makeRig("immutable")
        try rig.store.storePut("review-events", [stored("event", updatedAt: 10)])
        rig.transport.queuePush(Self.http(409, [
            "error": ["code": "sync_conflict", "details": [
                "conflicts": [["id": "event", "reason": "immutable_entity", "serverVersion": 8, "server": wire("event", version: 8, updatedAtMs: 80)]],
            ]],
        ]))
        let summary = await rig.engine.syncNow("review-events")
        XCTAssertFalse(summary.ok)
        XCTAssertTrue(summary.error?.contains("不可变") ?? false, summary.error ?? "")
        let entity = try XCTUnwrap(try rig.store.list("review-events").first(where: { $0.id == "event" }))
        XCTAssertTrue(entity.dirty)
    }

    func testOversizedSessionKeptLocalAndNotSent() async throws {
        let rig = makeRig("oversize-64k")
        let payload: JSONObject = ["task": ["attempts": [["text": String(repeating: "x", count: 70000)]] as [Any]]]
        try rig.store.storePut("speak-sessions", [stored("large", updatedAt: 10, payload: payload)])
        let summary = await rig.engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.skipped.contains { $0.id == "large" })
        XCTAssertEqual(rig.transport.pushBodies.count, 0)
        let entity = try XCTUnwrap(try rig.store.list("speak-sessions").first(where: { $0.id == "large" }))
        XCTAssertTrue(LearningJSON.equal(entity.payload, payload))
    }

    func testBatchingByMaxPushEntitiesAndMaxBodyBytes() async throws {
        let rig = makeRig("batching")
        for index in 0..<5 {
            try rig.store.storePut("speak-scenarios", [
                stored(String(index), updatedAt: Int64(index), payload: ["text": String(repeating: "x", count: 500)]),
            ])
        }
        var options = SyncOptions()
        options.maxPushEntities = 2
        options.maxBodyBytes = 1800
        _ = await rig.engine.syncNow("speak-scenarios", options: options)
        XCTAssertEqual(rig.transport.pushBodies.count, 3)
        for body in rig.transport.pushBodies {
            let entities = (body["entities"] as? [[String: Any]]) ?? []
            XCTAssertLessThanOrEqual(entities.count, 2)
            XCTAssertLessThanOrEqual(LearningJSON.byteCount(body), 1800)
        }
    }

    func testCollectionSchemaVersionNegotiationSkipsEntity() async throws {
        let rig = makeRig("schema-skip")
        try rig.store.storePut("speak-scenarios", [stored("v1", updatedAt: 1, payload: ["v": 1], schemaVersionValue: 1)])
        try rig.store.storePut("speak-scenarios", [stored("v2", updatedAt: 2, payload: ["v": 2])])
        var options = SyncOptions()
        options.schemaVersions = [2]
        let summary = await rig.engine.syncNow("speak-scenarios", options: options)
        XCTAssertTrue(summary.skipped.contains { $0.id == "v1" })
        XCTAssertEqual(summary.skipped.first { $0.id == "v1" }?.reason, "服务端不支持 schemaVersion 1，完整记录保留在本机")
        XCTAssertEqual(rig.transport.pushBodies.count, 1)
        let pushed = try XCTUnwrap(rig.transport.pushBodies.first?["entities"] as? [[String: Any]])
        XCTAssertEqual(pushed.first?["id"] as? String, "v2")
    }

    func testNamespaceSwitchDuringQueueCancelsSync() async throws {
        let rig = makeRig("switch")
        var options = SyncOptions()
        options.namespace = "account-a"
        let summary = await rig.engine.syncNow("reading-vocab", options: options)
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "账号已切换，本次同步已取消")
        XCTAssertEqual(rig.transport.pullCalls, 0)  // 不出网
    }

    func testConcurrentEditDuringPushKeepsDirtyAndAbsorbsAckVersion() async throws {
        let rig = makeRig("inflight-edit")
        try rig.store.storePut("speak-scenarios", [stored("a", updatedAt: 10)])
        let inflightEdit = stored("a", updatedAt: 20, payload: ["text": "new"])
        rig.transport.pushBeforeRespond = { [store = rig.store] _ in
            // 推送在途时的并发本地编辑（Windows pushQueue 挂钩同手法）
            try? store.storePut("speak-scenarios", [inflightEdit])
        }
        _ = await rig.engine.syncNow("speak-scenarios")
        let entity = try XCTUnwrap(try rig.store.list("speak-scenarios").first(where: { $0.id == "a" }))
        XCTAssertTrue(entity.dirty)
        XCTAssertEqual(entity.updatedAt, 20)
        XCTAssertEqual(entity.baseVersion, 50)
        XCTAssertTrue(LearningJSON.equal(entity.payload, ["text": "new"]))
    }

    // MARK: LearningRelaySync 入口文案

    @MainActor
    func testRelayEntryGuards() async throws {
        // 未接线（serverAuth nil）→ 登录前置文案
        LearningRelaySync.shared.resetForTests()
        do {
            _ = try await LearningRelaySync.shared.syncLearningRecords()
            XCTFail("应抛登录前置错误")
        } catch {
            XCTAssertEqual((error as? SyncStoreError)?.message, "登录后才能同步学习资料")
        }
    }

    @MainActor
    func testRelayRejectsProtocolVersionMismatch() async throws {
        let root = tempRoot("relay-protocol")
        let learning = LearningStore(rootDirectory: root, center: NotificationCenter())
        learning.setAccount(userId: "test")
        let tokens = MemoryTokenStore()
        // 预置刷新令牌（StubTransport 回有效 refresh 响应），再手动刷新建立登录态
        tokens.stored = StoredAuth(
            accessToken: "a0", refreshToken: "r0", accessExpiresAt: 1_000_000 + 3600,
            user: AuthUser(id: "test", email: "t@example.test", nickname: nil, plan: "free", createdAt: "2026-01-01T00:00:00Z")
        )
        let manager = AuthTokenManager(transport: StubTransport(), store: tokens, now: { 1_000_000 })
        let serverAuth = ServerAuthClient(manager: manager, appSupportDirectory: root)
        _ = try? await serverAuth.refreshNow()
        XCTAssertTrue(serverAuth.status.loggedIn)
        let engine = SyncEngine(dependencies: SyncEngineDependencies(
            pull: { _, _, _, _ in AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{}") },
            push: { _, _, _ in AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{}") },
            list: { collection, ns in try learning.list(collection, expectedNamespace: ns) },
            put: { collection, entities, ns in try learning.storePut(collection, entities, expectedNamespace: ns) },
            replace: { collection, entities, cursor, ns in
                try learning.storePut(collection, entities, replace: true, cursor: cursor, expectedNamespace: ns)
            },
            cursorGet: { collection, ns in try learning.cursorGet(collection, expectedNamespace: ns) },
            cursorSet: { collection, cursor, ns in
                try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: ns)
            },
            namespace: { learning.currentNamespace() },
            sleep: { _ in }
        ))
        let relay = LearningRelaySync.makeForTests()
        relay.configureForTests(
            serverAuth: serverAuth, learning: learning, engine: engine,
            config: ["sync": ["protocolVersion": 1, "collections": [:] as [String: Any]]]
        )
        do {
            _ = try await relay.syncLearningRecords()
            XCTFail("应抛协议版本错误")
        } catch {
            XCTAssertEqual((error as? SyncStoreError)?.message, "服务端尚不支持学习接力协议 v2，请升级后同步")
        }
    }
}

// MARK: - withAuth 命名空间守卫（auth.rs with_auth_for_namespace :616-687）

extension LearningSyncEngineTests {
    @MainActor
    func testWithAuthNamespaceGuardCancelsLocallyWithoutNetwork() async throws {
        let root = tempRoot("auth-guard")
        let learning = LearningStore(rootDirectory: root, center: NotificationCenter())
        learning.setAccount(userId: "test")
        let tokens = MemoryTokenStore()
        tokens.stored = StoredAuth(
            accessToken: "a0", refreshToken: "r0", accessExpiresAt: 1_000_000 + 3600,
            user: AuthUser(id: "test", email: "t@example.test", nickname: nil, plan: "free", createdAt: "2026-01-01T00:00:00Z")
        )
        let transport = CountingTransport()
        let manager = AuthTokenManager(transport: transport, store: tokens, now: { 1_000_000 })
        await manager.attachLearningStore(learning)
        let expected = LearningStore.accountNamespace("test")
        // 命名空间匹配 → 正常出网
        _ = try await manager.withAuth(method: "GET", path: "/v1/sync/reading-vocab/pull?since=0&limit=500", body: nil, expectedNamespace: expected)
        XCTAssertEqual(transport.calls, 1)
        // LearningStore 命名空间已切换 → 本地伪码 account_changed，verify_namespace 文案透传，不出网
        learning.setAccount(userId: "other")
        do {
            _ = try await manager.withAuth(method: "GET", path: "/v1/sync/reading-vocab/pull?since=0&limit=500", body: nil, expectedNamespace: expected)
            XCTFail("应本地取消")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "account_changed")
            XCTAssertEqual(error.message, "账号已切换，本次操作已取消")
        }
        XCTAssertEqual(transport.calls, 1)
        // 命名空间对齐但内存用户不是该账号 → 同样本地取消（同步守卫文案）
        let otherNamespace = LearningStore.accountNamespace("other")
        do {
            _ = try await manager.withAuth(method: "GET", path: "/v1/sync/reading-vocab/pull?since=0&limit=500", body: nil, expectedNamespace: otherNamespace)
            XCTFail("应本地取消")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "account_changed")
            XCTAssertEqual(error.message, "账号已切换，本次同步已取消")
        }
        XCTAssertEqual(transport.calls, 1)
    }
}

private final class CountingTransport: AuthTransport {
    private(set) var calls = 0
    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse {
        calls += 1
        return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{}")
    }
}

// MARK: - 测试替身

/// LearningRelaySync 的可测入口（生产单例之外另起实例）。
extension LearningRelaySync {
    static func makeForTests() -> LearningRelaySync {
        LearningRelaySync(testing: ())
    }

    func configureForTests(serverAuth: ServerAuthClient, learning: LearningStore, engine: SyncEngine, config: JSONObject) {
        configure(serverAuth: serverAuth, learning: learning, engine: engine)
        stubbedConfig = config
    }

    func resetForTests() {
        stubbedConfig = nil
    }
}

private final class StubTransport: AuthTransport {
    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse {
        if request.path == "/v1/me/config" {
            return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"sync\":{\"protocolVersion\":1}}")
        }
        if request.path == "/v1/auth/refresh" {
            let body = "{\"accessToken\":\"a1\",\"refreshToken\":\"r1\",\"expiresIn\":3600,"
                + "\"user\":{\"id\":\"test\",\"email\":\"t@example.test\",\"nickname\":null,\"plan\":\"free\",\"createdAt\":\"2026-01-01T00:00:00Z\"}}"
            return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: body)
        }
        return AuthHttpResponse(status: 401, retryAfterSeconds: nil, body: "{\"error\":{\"code\":\"unauthorized\",\"message\":\"m\"}}")
    }
}

/// 内存令牌槽（测试不碰 Keychain）。
private final class MemoryTokenStore: AuthTokenStore {
    var stored: StoredAuth?
    func save(_ auth: StoredAuth) throws { stored = auth }
    func load() -> StoredAuth? { stored }
    func clear() throws { stored = nil }
}

// MARK: - 修订复核补测（syncEngine.test.ts 未落位向量 + §3-30 固定值字面量 +
// learning-sync-complete payload + withAuth 401 重放口径 + 登录触发管线）

extension LearningSyncEngineTests {
    // MARK: syncEngine.test.ts「首次空库：不动实体，游标原样落盘」

    func testFirstPullEmptyLibraryKeepsCursorVerbatim() async throws {
        let rig = makeRig("first-empty")
        rig.transport.queuePull(pullPage(cursor: 7, hasMore: false, entities: []))
        let summary = await rig.engine.syncNow("speak-scenarios")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pulled, 0)
        XCTAssertEqual(try rig.store.cursorGet("speak-scenarios"), 7)
        XCTAssertTrue(try rig.store.list("speak-scenarios").isEmpty)
    }

    // MARK: 「tombstone：本地活实体被服务端删除覆盖（payload 清空）」

    func testPullTombstoneOverwritesLocalLiveEntity() async throws {
        let rig = makeRig("tombstone-live")
        try rig.store.storePut("speak-scenarios", [stored("a", updatedAt: 500, payload: ["v": 2], baseVersion: 3, dirty: false)])
        rig.transport.queuePull(pullPage(cursor: 8, hasMore: false, entities: [
            wire("a", version: 8, updatedAtMs: 1000, deleted: true),
        ]))
        let summary = await rig.engine.syncNow("speak-scenarios")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.appliedRemote, 1)
        let row = try XCTUnwrap(try rig.store.list("speak-scenarios").first)
        XCTAssertTrue(row.deleted)
        XCTAssertFalse(row.dirty)
        XCTAssertNil(row.payload)
        XCTAssertEqual(row.baseVersion, 8)
    }

    // MARK: 「409 三轮不收敛：记入 skipped 不抛错」

    func test409ThreeUnconvergedRoundsAreSkippedNotFatal() async throws {
        let rig = makeRig("409-rounds")
        try rig.store.storePut("speak-scenarios", [stored("a", updatedAt: 9000, baseVersion: 9)])
        rig.transport.queuePull(pullPage(cursor: 10, hasMore: false, entities: []))
        let conflict = Self.http(409, [
            "error": ["code": "sync_conflict", "details": [
                "conflicts": [["id": "a", "serverVersion": 99, "server": wire("a", version: 99, updatedAtMs: 1000, payload: ["v": 2])]],
            ]],
        ])
        for _ in 0..<3 { rig.transport.queuePush(conflict) }
        let summary = await rig.engine.syncNow("speak-scenarios")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.skipped.map(\.id), ["a"])
        XCTAssertEqual(summary.skipped.map(\.reason), ["冲突 3 轮未收敛，留待下次同步"])
        XCTAssertEqual(rig.transport.pushBodies.count, 3)
        // 本地 dirty 保留（下次同步续传）
        let row = try XCTUnwrap(try rig.store.list("speak-scenarios").first)
        XCTAssertTrue(row.dirty)
    }

    // MARK: 「413 sync_quota_exceeded：整次同步失败带回错误」

    func test413SyncQuotaExceededFailsWholeSync() async throws {
        let rig = makeRig("413-quota")
        try rig.store.storePut("speak-scenarios", [stored("a", updatedAt: 1000)])
        rig.transport.queuePull(pullPage(cursor: 10, hasMore: false, entities: []))
        rig.transport.queuePush(Self.http(413, [
            "error": ["code": "sync_quota_exceeded", "message": "配额不足", "details": ["usedBytes": 1, "deltaBytes": 1, "quotaBytes": 1]],
        ]))
        let summary = await rig.engine.syncNow("speak-scenarios")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "同步推送超限（HTTP 413 sync_quota_exceeded）：配额不足")
    }

    // MARK: 「客户端 512KB 预检」非 speak 集合字面量（524288）

    func testNonSpeakCollectionOversizeSkipUses512KBLimit() async throws {
        let rig = makeRig("512k")
        try rig.store.storePut("history", [stored("big", updatedAt: 1000, payload: ["blob": String(repeating: "x", count: 520 * 1024)])])
        let summary = await rig.engine.syncNow("history")
        XCTAssertTrue(summary.ok)
        XCTAssertEqual(rig.transport.pushBodies.count, 0)
        let skip = try XCTUnwrap(summary.skipped.first)
        XCTAssertTrue(skip.reason.hasPrefix("payload 超过 524288 字节上限（"), skip.reason)
        XCTAssertTrue(skip.reason.hasSuffix("字节），完整记录保留在本机"), skip.reason)
        let row = try XCTUnwrap(try rig.store.list("history").first)
        XCTAssertTrue(row.dirty, "本地完整保留待推")
    }

    // MARK: 「超过 200 实体分批推送（200+5）」

    func test205EntitiesPushInBatchesOfTwoHundredAndFive() async throws {
        let rig = makeRig("batch-200")
        let entities = (0..<205).map { stored("e\($0)", updatedAt: Int64(1000 + $0), payload: ["n": $0]) }
        try rig.store.storePut("reading-vocab", entities)
        rig.transport.queuePull(pullPage(cursor: 10, hasMore: false, entities: []))
        let summary = await rig.engine.syncNow("reading-vocab")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pushed, 205)
        XCTAssertEqual(rig.transport.pushBodies.count, 2)
        XCTAssertEqual((rig.transport.pushBodies[0]["entities"] as? [Any])?.count, 200)
        XCTAssertEqual((rig.transport.pushBodies[1]["entities"] as? [Any])?.count, 5)
    }

    // MARK: 「pull 429：退避后重试同页成功」+ 15s 上限 / 1s 默认退避字面量

    func testPull429BackoffCapsAtFifteenSecondsAndDefaultsToOne() async throws {
        let rig = makeRig("429-backoff")
        var sleeps: [TimeInterval] = []
        let transport = rig.transport
        let learning = rig.store
        let engine = SyncEngine(dependencies: SyncEngineDependencies(
            pull: { _, _, _, _ in try await Task.detached { try transport.pull() }.value },
            push: { _, body, _ in try await Task.detached { try transport.push(body) }.value },
            list: { collection, ns in try learning.list(collection, expectedNamespace: ns) },
            put: { collection, entities, ns in try learning.storePut(collection, entities, expectedNamespace: ns) },
            replace: { collection, entities, cursor, ns in
                try learning.storePut(collection, entities, replace: true, cursor: cursor, expectedNamespace: ns)
            },
            cursorGet: { collection, ns in try learning.cursorGet(collection, expectedNamespace: ns) },
            cursorSet: { collection, cursor, ns in
                try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: ns)
            },
            namespace: { learning.currentNamespace() },
            sleep: { sleeps.append($0) }
        ))
        rig.transport.queuePull(AuthHttpResponse(
            status: 429, retryAfterSeconds: 30,  // 30s → 封顶 15s
            body: syncJSONStringify(["error": ["code": "rate_limited"]]) ?? "{}"
        ))
        rig.transport.queuePull(AuthHttpResponse(
            status: 429, retryAfterSeconds: nil,  // 无头无 details → 默认 1s
            body: syncJSONStringify(["error": ["code": "rate_limited"]]) ?? "{}"
        ))
        rig.transport.queuePull(pullPage(cursor: 3, hasMore: false, entities: []))
        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(rig.transport.pullCalls, 3, "1 次首发 + 2 次退避重试同页")
        XCTAssertEqual(sleeps, [15, 1])
        XCTAssertEqual(try rig.store.cursorGet("speak-sessions"), 3)
    }

    // MARK: 「未知集合 404：失败汇总带回错误码」

    func test404BringsErrorCodeBackInSummary() async throws {
        let rig = makeRig("404")
        rig.transport.queuePull(Self.http(404, ["error": ["code": "sync_collection_invalid", "message": "集合不在白名单"]]))
        let summary = await rig.engine.syncNow("speak-scenarios")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "同步拉取失败（HTTP 404 sync_collection_invalid）：集合不在白名单")
    }

    // MARK: 「entityPayloadBytes：tombstone 计 0；活实体按 JSON UTF-8 字节（中文 3 字节/字）」

    func testEntityPayloadBytesTombstoneZeroAndChineseThreeBytesPerChar() {
        let tomb = stored("t", updatedAt: 1, payload: nil, deleted: true)
        XCTAssertEqual(syncEntityPayloadBytes(tomb), 0)
        let cn = stored("c", updatedAt: 1, payload: ["title": "四字标题"])
        // {"title":"四字标题"} = 12 个 ASCII + 4×3 字节
        XCTAssertEqual(syncEntityPayloadBytes(cn), 24)
    }

    // MARK: §3-30 固定值字面量（常量逐值断言）

    func testProtocolConstantLiterals() {
        XCTAssertEqual(SyncEngineLimits.pullPageLimit, 500)
        XCTAssertEqual(SyncEngineLimits.pushBatch, 200)
        XCTAssertEqual(SyncEngineLimits.maxEntityBytes, 512 * 1024)
        XCTAssertEqual(SyncEngineLimits.maxPullPages, 400)
        XCTAssertEqual(SyncEngineLimits.maxConflictRounds, 3)
        XCTAssertEqual(SyncEngineLimits.maxRateLimitWaits, 3)
        XCTAssertEqual(SyncEngineLimits.pushBodyMaxBytes, 2 * 1024 * 1024)
        XCTAssertEqual(syncSpeakCollectionMaxBytes, 65_536)
        XCTAssertEqual(LearningStore.LearningAudio.chunkMaxBytes, 1_048_576)
        XCTAssertEqual(LearningStore.LearningAudio.totalMaxBytes, 20 * 1024 * 1024)
        XCTAssertEqual(SpeakStore.sessionLimit, 50)
        XCTAssertEqual(speakRecordMaxLive, 500)
        XCTAssertEqual(practiceRelayDraftMaxLength, 900)
        XCTAssertEqual(practiceRelayRecordingLimitNanoseconds, 45_000_000_000)
    }

    // MARK: 实体行缺字段：整页拒绝（不丢行推进游标）

    func testPullPageWithMalformedEntityRowIsRejectedWhole() throws {
        let broken = syncJSONStringify([
            "cursor": 7, "hasMore": false,
            "entities": [["id": "a"] as JSONObject],
        ]) ?? "{}"
        XCTAssertNil(SyncPullPage(body: broken), "缺 version/deleted/updatedAt 的行必须整页拒绝")
        // 全对齐的行照常解码
        let good = syncJSONStringify([
            "cursor": 7, "hasMore": false, "entities": [wire("a", version: 1, updatedAtMs: 100)],
        ]) ?? "{}"
        XCTAssertEqual(SyncPullPage(body: good)?.entities.map(\.id), ["a"])
    }

    // MARK: learning-sync-complete 的 payload（learningRelay.ts detail: results）

    @MainActor
    func testLearningSyncCompleteCarriesSummaries() async throws {
        let root = tempRoot("relay-complete")
        let learning = LearningStore(rootDirectory: root, center: NotificationCenter())
        learning.setAccount(userId: "test")
        let tokens = MemoryTokenStore()
        tokens.stored = StoredAuth(
            accessToken: "a0", refreshToken: "r0", accessExpiresAt: 1_000_000 + 3600,
            user: AuthUser(id: "test", email: "t@example.test", nickname: nil, plan: "free", createdAt: "2026-01-01T00:00:00Z")
        )
        let manager = AuthTokenManager(transport: StubTransport(), store: tokens, now: { 1_000_000 })
        let serverAuth = ServerAuthClient(manager: manager, appSupportDirectory: root)
        _ = try? await serverAuth.refreshNow()
        let engine = SyncEngine(dependencies: SyncEngineDependencies(
            // 合法空拉取页（`{}` 会被判「同步拉取响应无效」）
            pull: { _, _, _, _ in
                AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"cursor\":0,\"hasMore\":false,\"entities\":[]}")
            },
            push: { _, _, _ in AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{}") },
            list: { collection, ns in try learning.list(collection, expectedNamespace: ns) },
            put: { collection, entities, ns in try learning.storePut(collection, entities, expectedNamespace: ns) },
            replace: { collection, entities, cursor, ns in
                try learning.storePut(collection, entities, replace: true, cursor: cursor, expectedNamespace: ns)
            },
            cursorGet: { collection, ns in try learning.cursorGet(collection, expectedNamespace: ns) },
            cursorSet: { collection, cursor, ns in
                try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: ns)
            },
            namespace: { learning.currentNamespace() },
            sleep: { _ in }
        ))
        let relay = LearningRelaySync.makeForTests()
        relay.configureForTests(
            serverAuth: serverAuth, learning: learning, engine: engine,
            config: [
                "sync": [
                    "protocolVersion": 2,
                    "collections": [
                        "reading-vocab": ["schemaVersions": [2]] as JSONObject,
                        "notes": ["schemaVersions": [2]] as JSONObject,
                    ],
                ] as JSONObject,
            ] as JSONObject
        )
        let received = expectation(description: "learning-sync-complete")
        var payloads: [[SyncSummary]] = []
        let observer = NotificationCenter.default.addObserver(
            forName: .learningSyncComplete, object: nil, queue: nil
        ) { note in
            if let results = note.userInfo?[learningSyncCompleteResultsKey] as? [SyncSummary] {
                payloads.append(results)
                received.fulfill()
            }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        let summaries = try await relay.syncLearningRecords()
        await fulfillment(of: [received], timeout: 5)
        XCTAssertEqual(summaries.count, 2, "按协商门控只同步 2 个集合")
        XCTAssertTrue(summaries.allSatisfy(\.ok))
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads[0].count, 2, "通知 payload 同构：detail = results")
    }

    // MARK: 登录触发管线（ReaderApp.tsx:1899：账号变化且 loggedIn 才触发）

    func testLearningRelayLoginTriggersOnAccountChangeWhileLoggedIn() {
        let subject = PassthroughSubject<AuthStatus, Never>()
        final class Box {
            let lock = NSLock()
            var events: [LearningRelayLoginTrigger] = []
            func append(_ event: LearningRelayLoginTrigger) {
                lock.lock(); defer { lock.unlock() }
                events.append(event)
            }
            func snapshot() -> [LearningRelayLoginTrigger] {
                lock.lock(); defer { lock.unlock() }
                return events
            }
        }
        let box = Box()
        func user(_ id: String?) -> AuthUser? {
            id.map { AuthUser(id: $0, email: "e", nickname: nil, plan: "free", createdAt: "2026-01-01T00:00:00Z") }
        }
        var cancellable: AnyCancellable?
        cancellable = learningRelayLoginTriggers(subject).sink { box.append($0) }
        subject.send(AuthStatus(loggedIn: false, user: nil, notice: nil))                       // 基准，不触发
        subject.send(AuthStatus(loggedIn: true, user: user("a"), notice: nil))                  // guest→a ✓
        subject.send(AuthStatus(loggedIn: true, user: user("a"), notice: nil))                  // 同账号重复广播 ✗
        subject.send(AuthStatus(loggedIn: true, user: user("b"), notice: nil))                  // a→b 直切 ✓
        subject.send(AuthStatus(loggedIn: false, user: nil, notice: nil))                       // 登出 ✗
        subject.send(AuthStatus(loggedIn: true, user: user("a"), notice: nil))                  // b→a ✓
        cancellable = nil
        XCTAssertEqual(box.snapshot().count, 3)
        XCTAssertEqual(box.snapshot().map(\.account), ["a", "b", "a"])
    }

    // MARK: withAuth 401 重放前仅 verifyNamespace（auth.rs:661-663；并发刷新已完成时
    // 迟到 401 不得误报 account_changed）

    @MainActor
    func testWithAuthLate401AfterConcurrentRefreshStillReplays() async throws {
        let root = tempRoot("late-401")
        let learning = LearningStore(rootDirectory: root, center: NotificationCenter())
        learning.setAccount(userId: "test")
        let tokens = MemoryTokenStore()
        tokens.stored = StoredAuth(
            accessToken: "a0", refreshToken: "r0", accessExpiresAt: 1_000_000 + 3600,
            user: AuthUser(id: "test", email: "t@example.test", nickname: nil, plan: "free", createdAt: "2026-01-01T00:00:00Z")
        )
        let transport = Late401Transport()
        let manager = AuthTokenManager(transport: transport, store: tokens, now: { 1_000_000 })
        await manager.attachLearningStore(learning)
        // 首发在途时「并发刷新」钩子（把内存态换成 a2）
        transport.hook = { _ = try? await manager.refresh() }
        let expected = LearningStore.accountNamespace("test")
        // 首发用 a0 得 401；挂起期间并发刷新把内存态换成 a2；401 处理只复核
        // LearningStore 命名空间 → 复用新凭据 a2 重放成功（旧实现会误报 account_changed）
        let response = try await manager.withAuth(method: "GET", path: "/v1/sync/notes/pull", body: nil, expectedNamespace: expected)
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(transport.syncCalls, 2)
        XCTAssertEqual(transport.refreshCalls, 1, "迟到 401 搭车并发刷新的新凭据，不发第二次刷新")
    }
}

/// 401 重放向量用传输（sync 首呼触发并发刷新后回 401 token_expired，重放 200）。
private final class Late401Transport: AuthTransport {
    var hook: (() async -> Void)?
    private(set) var syncCalls = 0
    private(set) var refreshCalls = 0

    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse {
        if request.path == "/v1/auth/refresh" {
            refreshCalls += 1
            let body = "{\"accessToken\":\"a2\",\"refreshToken\":\"r2\",\"expiresIn\":3600,"
                + "\"user\":{\"id\":\"test\",\"email\":\"t@example.test\",\"nickname\":null,\"plan\":\"free\",\"createdAt\":\"2026-01-01T00:00:00Z\"}}"
            return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: body)
        }
        syncCalls += 1
        if syncCalls == 1, let hook {
            await hook()
            return AuthHttpResponse(
                status: 401, retryAfterSeconds: nil,
                body: "{\"error\":{\"code\":\"token_expired\",\"message\":\"late\"}}"
            )
        }
        return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{}")
    }
}

