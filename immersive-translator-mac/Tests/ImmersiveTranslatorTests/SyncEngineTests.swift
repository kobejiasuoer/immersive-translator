import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 云同步协议引擎单测（对齐 Windows src/lib/syncEngine.test.ts 的关键行为向量）：
// pull 分页游标推进 / stale_cursor 归零全量 / 429 退避 3 次上限（文案逐字）/
// 409 幽灵实体与 LWW 三形态 / 413 剔除单实体 / 双集合 64KB 预检 skip /
// push 200 后并发本地编辑不被旧应答清 dirty / 账号切换取消 / 汇总文案。
// 全部依赖注入：fake 传输（FIFO 回放 + 计数）+ 临时目录 SyncStore + 零等待 sleep。
// ---------------------------------------------------------------------------

final class SyncEngineTests: XCTestCase {
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
            .appendingPathComponent("sync-engine-tests-\(UUID().uuidString)-\(label)", isDirectory: true)
        tmpDirs.append(dir)
        return dir
    }

    // MARK: 假传输（FIFO 回放 + 调用记录 + 响应前异步挂钩）

    private final class FakeTransport {
        struct PullCall {
            let collection: String
            let since: Int64
            let limit: Int64
        }

        struct PushCall {
            let collection: String
            let body: String
        }

        private let lock = NSLock()
        private var pullResponses: [AuthHttpResponse] = []
        private var pushResponses: [AuthHttpResponse] = []
        private(set) var pullCalls: [PullCall] = []
        private(set) var pushCalls: [PushCall] = []
        /// 响应前异步挂钩（模拟网络挂起期间发生并发编辑/账号切换）。
        var pullBeforeRespond: (() async -> Void)?
        var pushBeforeRespond: ((_ body: String) async -> Void)?

        func queuePull(_ response: AuthHttpResponse) {
            lock.lock()
            defer { lock.unlock() }
            pullResponses.append(response)
        }

        func queuePush(_ response: AuthHttpResponse) {
            lock.lock()
            defer { lock.unlock() }
            pushResponses.append(response)
        }

        func pull(collection: String, since: Int64, limit: Int64) async throws -> AuthHttpResponse {
            if let hook = pullBeforeRespond { await hook() }
            return try takePull(collection: collection, since: since, limit: limit)
        }

        func push(collection: String, body: String) async throws -> AuthHttpResponse {
            if let hook = pushBeforeRespond { await hook(body) }
            return try takePush(collection: collection, body: body)
        }

        /// 同步取件（锁只在同步上下文里短暂持有，不跨挂起点）。
        private func takePull(collection: String, since: Int64, limit: Int64) throws -> AuthHttpResponse {
            lock.lock()
            defer { lock.unlock() }
            pullCalls.append(PullCall(collection: collection, since: since, limit: limit))
            guard !pullResponses.isEmpty else {
                throw SyncStoreError("测试未预期的 pull 请求")
            }
            return pullResponses.removeFirst()
        }

        private func takePush(collection: String, body: String) throws -> AuthHttpResponse {
            lock.lock()
            defer { lock.unlock() }
            pushCalls.append(PushCall(collection: collection, body: body))
            guard !pushResponses.isEmpty else {
                throw SyncStoreError("测试未预期的 push 请求")
            }
            return pushResponses.removeFirst()
        }
    }

    // MARK: 响应构造

    private func wire(
        _ id: String, version: Int64, updatedAtMs: Int64, deleted: Bool = false,
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

    private func pullResponse(
        cursor: Int64, hasMore: Bool, entities: [[String: Any]],
        collection: String = "speak-sessions"
    ) -> AuthHttpResponse {
        let body: [String: Any] = [
            "collection": collection,
            "serverVersion": cursor,
            "cursor": cursor,
            "hasMore": hasMore,
            "entities": entities,
        ]
        return AuthHttpResponse(
            status: 200, retryAfterSeconds: nil,
            body: syncJSONStringify(body) ?? "{}"
        )
    }

    private func pushOk(_ results: [[String: Any]]) -> AuthHttpResponse {
        AuthHttpResponse(
            status: 200, retryAfterSeconds: nil,
            body: syncJSONStringify([
                "collection": "speak-sessions", "serverVersion": 99, "results": results,
            ]) ?? "{}"
        )
    }

    private func errorResponse(
        status: Int, code: String, message: String = "m",
        details: [String: Any]? = nil
    ) -> AuthHttpResponse {
        var error: [String: Any] = ["code": code, "message": message]
        if let details { error["details"] = details }
        return AuthHttpResponse(
            status: status, retryAfterSeconds: nil,
            body: syncJSONStringify(["error": error]) ?? "{}"
        )
    }

    // MARK: 引擎装配

    private func makeEngine(
        store: SyncStore, transport: FakeTransport,
        namespace: @escaping () -> String = { "guest" }
    ) -> SyncEngine {
        SyncEngine(dependencies: SyncEngineDependencies(
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
            namespace: namespace,
            sleep: { _ in }  // 测试零等待
        ))
    }

    /// 推送类用例的公共前置：游标预置非零（增量拉取分支）+ 排一张空拉取页，
    /// 使 syncNow 直接进入 pushDirty 而不改写本地实体。
    private func primeIncrementalPull(_ transport: FakeTransport) {
        transport.queuePull(pullResponse(cursor: 1, hasMore: false, entities: []))
    }

    private func dirtyEntity(
        _ id: String, updatedAt: Int64, payload: Any? = ["v": 2, "text": "hi"],
        deleted: Bool = false, baseVersion: Int64 = 0
    ) -> StoredSyncEntity {
        StoredSyncEntity(
            id: id, baseVersion: baseVersion, updatedAt: updatedAt, deleted: deleted,
            schemaVersion: 2, originDevice: "mac", payload: payload, dirty: true
        )
    }

    /// push 请求体里的实体行（解析回来便于断言 baseVersion / payload）。
    private func pushedEntities(_ body: String) -> [[String: Any]] {
        guard let data = body.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rows = object["entities"] as? [[String: Any]] else { return [] }
        return rows
    }

    // MARK: 拉取

    func testFirstPullFullSnapshotLandsAcrossPages() async throws {
        let store = SyncStore(baseDirectory: tempDir("full"))
        let transport = FakeTransport()
        transport.queuePull(pullResponse(cursor: 5, hasMore: true, entities: [
            wire("a", version: 1, updatedAtMs: 100),
            wire("b", version: 2, updatedAtMs: 200),
        ]))
        transport.queuePull(pullResponse(cursor: 9, hasMore: false, entities: [
            wire("c", version: 3, updatedAtMs: 300),
        ]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pulled, 3)
        XCTAssertEqual(summary.appliedRemote, 3)
        XCTAssertEqual(transport.pullCalls.map(\.since), [0, 5])  // 游标逐页推进
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 9)
        let loaded = try store.list("speak-sessions")
        XCTAssertEqual(loaded.count, 3)
        for entity in loaded {
            XCTAssertFalse(entity.dirty)  // 快照实体干净落库
        }
        XCTAssertEqual(loaded.first { $0.id == "a" }?.baseVersion, 1)
        XCTAssertEqual(transport.pushCalls.count, 0)  // 无 dirty → 零推送
    }

    func testIncrementalPullUsesStoredCursorAndLWW() async throws {
        let store = SyncStore(baseDirectory: tempDir("incr"))
        try store.cursorSet("speak-sessions", 9)
        // 本地较新待推：保留本地只吸收版本号
        try store.put("speak-sessions", [dirtyEntity("local-new", updatedAt: 5000, baseVersion: 4)])
        // 本地较旧干净实体：被服务端版本覆盖
        try store.put("speak-sessions", [
            StoredSyncEntity(id: "stale", baseVersion: 1, updatedAt: 100, deleted: false,
                             schemaVersion: 2, originDevice: "mac", payload: ["v": 2, "old": 1], dirty: false),
        ])
        let transport = FakeTransport()
        transport.queuePull(pullResponse(cursor: 20, hasMore: false, entities: [
            wire("local-new", version: 5, updatedAtMs: 4000, payload: ["v": 2, "server": 1]),
            wire("stale", version: 6, updatedAtMs: 9000, payload: ["v": 2, "server": 2]),
        ]))
        // local-new 保留后仍 dirty，随推送清账（accepted version 7）
        transport.queuePush(pushOk([["id": "local-new", "status": "accepted", "version": 7]]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pushed, 1)
        XCTAssertEqual(transport.pullCalls.first?.since, 9)
        XCTAssertEqual(summary.keptLocal, 1)   // local-new 本地 5000 > 服务端 4000
        XCTAssertEqual(summary.appliedRemote, 1)  // stale 采纳服务端
        let loaded = try store.list("speak-sessions")
        let kept = try XCTUnwrap(loaded.first { $0.id == "local-new" })
        XCTAssertFalse(kept.dirty)  // push accepted 后清零
        XCTAssertEqual(kept.baseVersion, 7)  // 吸收应答版本号
        XCTAssertTrue(syncJSONEqual(kept.payload, ["v": 2, "text": "hi"]))  // 内容保留本地
        let adopted = try XCTUnwrap(loaded.first { $0.id == "stale" })
        XCTAssertEqual(adopted.baseVersion, 6)
        XCTAssertTrue(syncJSONEqual(adopted.payload, ["v": 2, "server": 2]))
    }

    func testStaleCursorResetsToFullSync() async throws {
        let store = SyncStore(baseDirectory: tempDir("stale"))
        try store.cursorSet("speak-sessions", 4)
        let transport = FakeTransport()
        transport.queuePull(errorResponse(status: 409, code: "stale_cursor"))
        transport.queuePull(pullResponse(cursor: 3, hasMore: false, entities: [
            wire("a", version: 1, updatedAtMs: 100),
        ]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        // 第二次 pull 从 0 全量重来
        XCTAssertEqual(transport.pullCalls.map(\.since), [4, 0])
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 3)
        XCTAssertEqual(summary.appliedRemote, 1)
    }

    func testStaleCursorDuringFullSnapshotFails() async throws {
        let store = SyncStore(baseDirectory: tempDir("stale-full"))
        let transport = FakeTransport()
        transport.queuePull(errorResponse(status: 409, code: "stale_cursor"))
        transport.queuePull(errorResponse(status: 409, code: "stale_cursor"))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "全量同步期间游标再次失效")
    }

    func testPullRateLimitedThreeWaitsThenFails() async throws {
        let store = SyncStore(baseDirectory: tempDir("429"))
        let transport = FakeTransport()
        let limited = AuthHttpResponse(
            status: 429, retryAfterSeconds: 1,
            body: syncJSONStringify(["error": [
                "code": "rate_limited",
                "details": ["retryAfterMs": 500],
            ]]) ?? "{}"
        )
        for _ in 0..<4 { transport.queuePull(limited) }
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试")
        XCTAssertEqual(transport.pullCalls.count, 4)  // 1 次首发 + 3 次退避重试
        XCTAssertEqual(transport.pushCalls.count, 0)  // 拉取失败不进推送
    }

    // MARK: 推送

    func testPushGhostEntityRetriesWithBaseVersionZero() async throws {
        let store = SyncStore(baseDirectory: tempDir("ghost"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", [
            dirtyEntity("ghost", updatedAt: 500, baseVersion: 5)  // 本地记忆错误
        ])
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(errorResponse(status: 409, code: "conflict", details: [
            "conflicts": [["id": "ghost", "serverVersion": 6, "server": NSNull()]],
        ]))
        transport.queuePush(pushOk([["id": "ghost", "status": "accepted", "version": 7]]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.conflicts, 1)
        XCTAssertEqual(summary.pushed, 1)
        // 第二次 push 携 baseVersion 0 重推
        let secondBody = try XCTUnwrap(transport.pushCalls.last?.body)
        XCTAssertEqual(syncJSONInt64(pushedEntities(secondBody).first?["baseVersion"]), 0)
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertEqual(landed.baseVersion, 7)
        XCTAssertFalse(landed.dirty)
    }

    func testPushConflictLocalNewerRepushesWithServerVersion() async throws {
        let store = SyncStore(baseDirectory: tempDir("local-new"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", [
            dirtyEntity("e1", updatedAt: 5000, payload: ["v": 2, "local": 1], baseVersion: 2)
        ])
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(errorResponse(status: 409, code: "conflict", details: [
            "conflicts": [[
                "id": "e1", "serverVersion": 5,
                "server": wire("e1", version: 5, updatedAtMs: 4000, payload: ["v": 2, "server": 1]),
            ]],
        ]))
        transport.queuePush(pushOk([["id": "e1", "status": "accepted", "version": 6]]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.conflicts, 1)
        XCTAssertEqual(summary.pushed, 1)
        let secondBody = try XCTUnwrap(transport.pushCalls.last?.body)
        XCTAssertEqual(syncJSONInt64(pushedEntities(secondBody).first?["baseVersion"]), 5)
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertFalse(landed.dirty)
        XCTAssertEqual(landed.baseVersion, 6)
        XCTAssertTrue(syncJSONEqual(landed.payload, ["v": 2, "local": 1]))  // 本地内容落库
    }

    func testPushConflictEqualTimestampsAdoptsServer() async throws {
        let store = SyncStore(baseDirectory: tempDir("equal"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", [
            dirtyEntity("e1", updatedAt: 5000, payload: ["v": 2, "local": 1], baseVersion: 2)
        ])
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(errorResponse(status: 409, code: "conflict", details: [
            "conflicts": [[
                "id": "e1", "serverVersion": 5,
                "server": wire("e1", version: 5, updatedAtMs: 5000, payload: ["v": 2, "server": 1]),
            ]],
        ]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        // 相等取服务端（防乒乓）：采纳服务端快照，无重推
        XCTAssertEqual(transport.pushCalls.count, 1)
        XCTAssertEqual(summary.appliedRemote, 1)
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertFalse(landed.dirty)
        XCTAssertEqual(landed.baseVersion, 5)
        XCTAssertTrue(syncJSONEqual(landed.payload, ["v": 2, "server": 1]))
    }

    func testPushPayloadTooLargeDropsEntityAndRetriesRest() async throws {
        let store = SyncStore(baseDirectory: tempDir("413"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", [
            dirtyEntity("big", updatedAt: 100),
            dirtyEntity("ok", updatedAt: 200),
        ])
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(errorResponse(status: 413, code: "payload_too_large", details: [
            "entityId": "big", "maxBytes": 65536,
        ]))
        transport.queuePush(pushOk([["id": "ok", "status": "accepted", "version": 9]]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.skipped.map(\.reason), ["服务端判定 payload 超限"])
        XCTAssertEqual(summary.skipped.map(\.id), ["big"])
        XCTAssertEqual(summary.pushed, 1)
        // 第二批不含被剔除实体
        let secondBody = try XCTUnwrap(transport.pushCalls.last?.body)
        XCTAssertEqual(pushedEntities(secondBody).map { $0["id"] as? String }, ["ok"])
    }

    func testOversizeSpeakEntitySkippedBeforePush() async throws {
        let store = SyncStore(baseDirectory: tempDir("64k"))
        var bigText = ""
        for _ in 0..<70_000 { bigText.append("x") }  // 70KB > 64KB（双集合特配）
        try store.put("speak-sessions", [
            dirtyEntity("big", updatedAt: 100, payload: ["v": 2, "text": bigText])
        ])
        let transport = FakeTransport()
        transport.queuePull(pullResponse(cursor: 1, hasMore: false, entities: []))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok)
        XCTAssertEqual(transport.pushCalls.count, 0)  // 预检拦截，零推送
        let skip = try XCTUnwrap(summary.skipped.first)
        XCTAssertEqual(skip.id, "big")
        XCTAssertTrue(skip.reason.hasPrefix("payload 超过 65536 字节上限（"), skip.reason)
        XCTAssertTrue(skip.reason.hasSuffix("字节），完整记录保留在本机"), skip.reason)
        // 实体保留本地且仍 dirty（下次同步续传口径不变）
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertTrue(landed.dirty)
    }

    func testMissingPayloadLiveEntitySkipped() async throws {
        let store = SyncStore(baseDirectory: tempDir("no-payload"))
        try store.put("speak-sessions", [dirtyEntity("empty", updatedAt: 10, payload: nil)])
        let transport = FakeTransport()
        transport.queuePull(pullResponse(cursor: 1, hasMore: false, entities: []))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok)
        XCTAssertEqual(summary.skipped.map(\.reason), ["活实体缺少 payload，无法推送"])
        XCTAssertEqual(transport.pushCalls.count, 0)
    }

    func testPushResponseNeverErasesConcurrentLocalEdit() async throws {
        let store = SyncStore(baseDirectory: tempDir("concurrent"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", [
            dirtyEntity("e1", updatedAt: 100, payload: ["v": 2, "p": 1])
        ])
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(pushOk([["id": "e1", "status": "accepted", "version": 8]]))
        // 推送在途时本地又编辑了同一实体（updatedAt/payload 都变了）
        transport.pushBeforeRespond = { [self] _ in
            try? store.put("speak-sessions", [
                self.dirtyEntity("e1", updatedAt: 200, payload: ["v": 2, "p": 2])
            ])
        }
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pushed, 1)
        let landed = try XCTUnwrap(try store.list("speak-sessions").first)
        XCTAssertEqual(landed.updatedAt, 200)  // 最新本地态保留
        XCTAssertTrue(syncJSONEqual(landed.payload, ["v": 2, "p": 2]))
        XCTAssertTrue(landed.dirty)  // 旧应答不清 dirty（下次同步续传）
        XCTAssertEqual(landed.baseVersion, 8)  // 版本号吸收
    }

    // MARK: 推送分批（Windows syncEngine.ts:322 `Math.min(PUSH_BATCH, positiveLimit(maxPushEntities, PUSH_BATCH))`）

    /// 服务端协商 maxPushEntities 只能收紧、不能放宽：>200 仍按 200 分批。
    func testPushBatchClampedToTwoHundredEvenWhenServerAllowsMore() async throws {
        let store = SyncStore(baseDirectory: tempDir("batch-clamp"))
        try store.cursorSet("speak-assessments", 1)
        let entities = (0..<201).map { dirtyEntity("a\($0)", updatedAt: Int64(1_000 + $0), payload: ["v": 2]) }
        try store.put("speak-assessments", entities)
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        transport.queuePush(pushOk([]))
        transport.queuePush(pushOk([]))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-assessments", options: SyncOptions(maxPushEntities: 1_000))
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.pushed, 201)
        XCTAssertEqual(transport.pushCalls.count, 2, "201 条按 200 上限拆成两批")
        XCTAssertEqual(pushedEntities(transport.pushCalls[0].body).count, 200)
        XCTAssertEqual(pushedEntities(transport.pushCalls[1].body).count, 1)
    }

    /// 协商值 <200 时按协商值收紧（positiveLimit 口径：非正数回退 200）。
    func testPushBatchHonoursSmallerNegotiatedLimit() async throws {
        let store = SyncStore(baseDirectory: tempDir("batch-small"))
        try store.cursorSet("speak-sessions", 1)
        try store.put("speak-sessions", (0..<5).map { dirtyEntity("s\($0)", updatedAt: Int64(10 + $0)) })
        let transport = FakeTransport()
        primeIncrementalPull(transport)
        for _ in 0..<3 { transport.queuePush(pushOk([])) }
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions", options: SyncOptions(maxPushEntities: 2))
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(transport.pushCalls.map { pushedEntities($0.body).count }, [2, 2, 1])
    }

    // MARK: 拉取信封解码（Windows syncEngine.ts:234 只校验 entities/cursor/hasMore）

    /// 信封缺 collection / serverVersion 不算「同步拉取响应无效」——与 Windows 同口径。
    func testPullPageDecodeToleratesMissingCollectionAndServerVersion() throws {
        let minimal = try XCTUnwrap(syncJSONStringify([
            "cursor": 7, "hasMore": false,
            "entities": [wire("a", version: 1, updatedAtMs: 100)],
        ]))
        let page = try XCTUnwrap(SyncPullPage(body: minimal), "缺 collection/serverVersion 仍可解码")
        XCTAssertNil(page.collection)
        XCTAssertNil(page.serverVersion)
        XCTAssertEqual(page.cursor, 7)
        XCTAssertFalse(page.hasMore)
        XCTAssertEqual(page.entities.map(\.id), ["a"])

        // 三个必要字段任一不齐 → nil（Windows 抛「同步拉取响应无效」的前置）
        XCTAssertNil(SyncPullPage(body: syncJSONStringify(["hasMore": false, "entities": []]) ?? ""), "缺 cursor")
        XCTAssertNil(SyncPullPage(body: syncJSONStringify(["cursor": 1, "entities": []]) ?? ""), "缺 hasMore")
        XCTAssertNil(SyncPullPage(body: syncJSONStringify(["cursor": 1, "hasMore": "no", "entities": []]) ?? ""), "hasMore 非布尔")
        XCTAssertNil(SyncPullPage(body: syncJSONStringify(["cursor": 1, "hasMore": true, "entities": "x"]) ?? ""), "entities 非数组")
        XCTAssertNil(SyncPullPage(body: syncJSONStringify(["cursor": 1.5, "hasMore": true, "entities": []]) ?? ""), "cursor 非整数")
        XCTAssertNil(SyncPullPage(body: "not json"))
    }

    /// 端到端：最小信封的拉取页照常落库推进游标。
    func testMinimalPullEnvelopeSyncsSuccessfully() async throws {
        let store = SyncStore(baseDirectory: tempDir("minimal-envelope"))
        let transport = FakeTransport()
        let body = try XCTUnwrap(syncJSONStringify([
            "cursor": 4, "hasMore": false,
            "entities": [wire("only", version: 4, updatedAtMs: 400, payload: ["v": 2])],
        ]))
        transport.queuePull(AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: body))
        let engine = makeEngine(store: store, transport: transport)

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertTrue(summary.ok, summary.error ?? "")
        XCTAssertEqual(summary.appliedRemote, 1)
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 4)
        XCTAssertEqual(try store.list("speak-sessions").map(\.id), ["only"])
    }

    // MARK: 账号切换（namespace 变化 → 本次同步取消）

    func testAccountSwitchCancelsInFlightSync() async throws {
        let store = SyncStore(baseDirectory: tempDir("switch"))
        store.setAccount(userId: "user-a")
        let transport = FakeTransport()
        transport.queuePull(pullResponse(cursor: 3, hasMore: false, entities: [
            wire("a", version: 1, updatedAtMs: 100),
        ]))
        // pull 应答送达前账号被切换（登录/登出）——落库时命名空间校验失败
        transport.pullBeforeRespond = {
            store.setAccount(userId: "user-b")
        }
        let engine = makeEngine(store: store, transport: transport, namespace: {
            store.currentNamespace()
        })

        let summary = await engine.syncNow("speak-sessions")
        XCTAssertFalse(summary.ok)
        XCTAssertEqual(summary.error, "账号已切换，本次操作已取消")
        // 新账号目录里没有串进旧账号的拉取结果
        XCTAssertEqual(try store.list("speak-sessions").count, 0)
    }

    // MARK: 汇总文案（Windows AccountSection.tsx:87-122 逐字）

    func testSyncSummaryTextFailurePrefix() {
        XCTAssertEqual(syncSummaryText(SyncSummary.failure("boom")), "同步失败：boom")
        var noReason = SyncSummary()
        noReason.ok = false
        XCTAssertEqual(syncSummaryText(noReason), "同步失败：未知错误")
    }

    func testSyncSummaryTextSuccessCountsAndConditionalParts() {
        var summary = SyncSummary()
        summary.pulled = 2
        summary.pushed = 1
        XCTAssertEqual(syncSummaryText(summary), "同步完成（拉取 2 项，推送 1 项）")
        summary.conflicts = 2
        summary.keptLocal = 1
        summary.skipped = [SyncEntitySkip(id: "x", reason: "r")]
        XCTAssertEqual(
            syncSummaryText(summary),
            "同步完成（拉取 2 项，推送 1 项，冲突处理 2 次，本地较新保留 1 项，跳过 1 项）"
        )
        // 0 值段不出现
        var zero = SyncSummary()
        zero.conflicts = 0
        zero.keptLocal = 0
        XCTAssertEqual(syncSummaryText(zero), "同步完成（拉取 0 项，推送 0 项）")
    }

    func testMergeSyncSummariesAggregatesAndKeepsFirstError() {
        var a = SyncSummary()
        a.pulled = 3
        a.pushed = 1
        a.conflicts = 1
        a.skipped = [SyncEntitySkip(id: "a1", reason: "r")]
        var b = SyncSummary()
        b.pulled = 2
        b.keptLocal = 1
        b.skipped = [SyncEntitySkip(id: "b1", reason: "r2")]
        let merged = mergeSyncSummaries([a, b])
        XCTAssertTrue(merged.ok)
        XCTAssertEqual(merged.pulled, 5)
        XCTAssertEqual(merged.pushed, 1)
        XCTAssertEqual(merged.keptLocal, 1)
        XCTAssertEqual(merged.conflicts, 1)
        XCTAssertEqual(merged.skipped.count, 2)
        XCTAssertEqual(merged.error, nil)

        var failing = SyncSummary.failure("网络错误")
        failing.pulled = 1
        var later = SyncSummary.failure("后来的错误")
        let mergedFailure = mergeSyncSummaries([failing, later])
        XCTAssertFalse(mergedFailure.ok)
        XCTAssertEqual(mergedFailure.error, "网络错误")  // 取首个
    }

    // MARK: ISO 时间换算

    func testISORoundTripMilliseconds() {
        let ms: Int64 = 1_762_000_000_123
        let iso = syncFormatISO(ms)
        XCTAssertTrue(iso.hasSuffix(".123Z"), iso)
        XCTAssertEqual(syncParseISOMilliseconds(iso), ms)
        // 兼容不带毫秒的 ISO
        XCTAssertEqual(syncParseISOMilliseconds("2026-11-01T00:00:00Z"), 1_793_491_200_000)
    }
}
