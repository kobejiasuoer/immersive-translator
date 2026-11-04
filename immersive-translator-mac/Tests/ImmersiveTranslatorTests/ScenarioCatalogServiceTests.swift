import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 场景目录装载器单测（对齐 Windows src/lib/scenarioCatalog.test.ts 18 例）：mock
/// 缓存读写 / 拉取 / 同步集合，每例取一个新服务实例（单飞状态随实例重置）+ 清空注册表。
/// 覆盖 preload 装载/降级、refresh 200 写缓存/404 静默/断网静默/垃圾 body 不写盘、
/// 每次调用都发请求与 in-flight 并发共享、「有更新才替换」、三态徽标。
@MainActor
final class ScenarioCatalogServiceTests: XCTestCase {
    private struct TestError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// 旁路观察 + 可编程应答的依赖替身。
    private final class Mocks {
        var cacheRead: () throws -> [Any] = { [] }
        var cacheReadCalls = 0
        var cacheWrites: [String] = []
        var cacheWriteError: Error?
        var fetch: () async throws -> AuthHttpResponse = { throw TestError(message: "unset") }
        var fetchCalls = 0
        var syncList: () throws -> [StoredSyncEntity] = { [] }
        var syncListCalls = 0
    }

    private func makeService(_ m: Mocks) -> ScenarioCatalogService {
        ScenarioCatalogService(dependencies: .init(
            cacheRead: { m.cacheReadCalls += 1; return try m.cacheRead() },
            cacheWrite: { json in
                if let error = m.cacheWriteError { throw error }
                m.cacheWrites.append(json)
            },
            fetchOfficial: { m.fetchCalls += 1; return try await m.fetch() },
            syncStoreList: { m.syncListCalls += 1; return try m.syncList() }
        ))
    }

    override func setUp() {
        super.setUp()
        registerOfficialScenarios([])
        registerUserScenarios([])
    }

    /// 合法官方场景（cacheRead / fetch body 的 JSON 反序列化形状）。
    private func officialScenario(_ id: String) -> [String: Any] {
        [
            "id": id, "source": "official", "title": "t-\(id)", "category": "daily",
            "aiRole": "role-\(id)", "opener": "opener-\(id)", "updatedAt": 1_767_225_600_000,
        ]
    }

    private func userScenario(_ id: String) -> [String: Any] {
        [
            "id": id, "source": "user", "title": "t-\(id)", "category": "custom",
            "aiRole": "role-\(id)", "opener": "opener-\(id)", "updatedAt": 1_767_225_600_000,
        ]
    }

    private func storedEntity(_ payload: [String: Any]?, deleted: Bool = false) -> StoredSyncEntity {
        StoredSyncEntity(
            id: payload.flatMap { $0["id"] as? String } ?? "usr_tombstone",
            baseVersion: 3, updatedAt: 1_767_225_600_000, deleted: deleted, schemaVersion: 1,
            originDevice: "windows", payload: payload, dirty: false
        )
    }

    private func http(_ status: Int, _ body: String) -> AuthHttpResponse {
        AuthHttpResponse(status: status, retryAfterSeconds: nil, body: body)
    }

    private func json(_ value: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    // MARK: - preloadScenarioCatalog：启动装载

    func testPreloadLoadsCacheIntoOfficialBucketAndIsSingleFlight() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a"), self.officialScenario("off_b")] }
        let service = makeService(m)

        await service.preloadScenarioCatalog()

        XCTAssertEqual(listOfficialScenarios().count, 2)
        XCTAssertEqual(scenarioOf("off_a").title, "t-off_a")
        XCTAssertEqual(scenarioOf("off_b").source, .official)
        // 单飞：第二次调用复用同一次装载，不再触发 IO
        await service.preloadScenarioCatalog()
        XCTAssertEqual(m.cacheReadCalls, 1)
        XCTAssertEqual(m.syncListCalls, 1)
    }

    func testPreloadLoadsUserScenariosSkippingTombstones() async {
        let m = Mocks()
        m.syncList = { [self.storedEntity(self.userScenario("usr_uuid-1")), self.storedEntity(nil, deleted: true)] }
        let service = makeService(m)

        await service.preloadScenarioCatalog()

        XCTAssertEqual(listUserScenarios().map(\.id), ["usr_uuid-1"])
        XCTAssertEqual(scenarioOf("usr_uuid-1").source, .user)
        // 集合名对齐 A0 登记的 speak-scenarios
        XCTAssertEqual(userScenarioCollection, "speak-scenarios")
        XCTAssertTrue(syncLocalCollections.contains(userScenarioCollection))
    }

    func testPreloadBothSourcesFailingLeavesRegistryEmptyWithoutThrowing() async {
        let m = Mocks()
        m.cacheRead = { throw TestError(message: "cache corrupt") }
        m.syncList = { throw TestError(message: "store err") }
        let service = makeService(m)

        await service.preloadScenarioCatalog()

        XCTAssertEqual(listOfficialScenarios(), [])
        XCTAssertEqual(listUserScenarios(), [])
        XCTAssertEqual(scenarioOf("ordering").id, "ordering")
        XCTAssertEqual(service.officialSource, .fallback)
    }

    // MARK: - refreshOfficialScenarioCatalog：后台拉取官方目录

    func testRefresh200WrappedShapeWritesCacheAndUpdatesRegistry() async {
        let m = Mocks()
        let offA = officialScenario("off_a")
        let offB = officialScenario("off_b")
        let junk: [String: Any] = ["id": "off_junk"]  // 缺必填，应被过滤
        m.fetch = { self.http(200, self.json(["scenarios": [offA, junk, offB]])) }
        let service = makeService(m)

        await service.refreshOfficialScenarioCatalog()

        XCTAssertEqual(m.cacheWrites.count, 1)
        // 写盘参数 = 过滤后数组的规范化 JSON 文本
        XCTAssertEqual(m.cacheWrites.first, officialScenariosJSON([offA, offB]))
        XCTAssertEqual(listOfficialScenarios().map(\.id), ["off_a", "off_b"])
        XCTAssertEqual(service.officialSource, .server)
    }

    func testRefresh200BareArrayAccepted() async {
        let m = Mocks()
        let offA = officialScenario("off_a")
        m.fetch = { self.http(200, self.json([offA])) }
        let service = makeService(m)

        await service.refreshOfficialScenarioCatalog()

        XCTAssertEqual(m.cacheWrites, [officialScenariosJSON([offA])])
        XCTAssertEqual(scenarioOf("off_a").title, "t-off_a")
    }

    func testRefresh404IsSilentZeroWriteCacheUnchanged() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a")] }
        m.fetch = { self.http(404, "Not Found") }
        let service = makeService(m)

        await service.refreshOfficialScenarioCatalog()

        XCTAssertTrue(m.cacheWrites.isEmpty)
        XCTAssertEqual(listOfficialScenarios().map(\.id), ["off_a"])
    }

    func testRefreshFetchThrowIsSilentZeroWrite() async {
        let m = Mocks()
        m.fetch = { throw TestError(message: "network down") }
        let service = makeService(m)

        await service.refreshOfficialScenarioCatalog()

        XCTAssertTrue(m.cacheWrites.isEmpty)
        XCTAssertEqual(m.fetchCalls, 1)
    }

    func testRefreshGarbageBodyNotWritten() async {
        let m = Mocks()
        m.fetch = { self.http(200, self.json(["items": []])) }
        let service = makeService(m)
        await service.refreshOfficialScenarioCatalog()
        XCTAssertTrue(m.cacheWrites.isEmpty)

        // 非法 JSON 同样不写盘
        let m2 = Mocks()
        m2.fetch = { self.http(200, "{not json") }
        let service2 = makeService(m2)
        await service2.refreshOfficialScenarioCatalog()
        XCTAssertTrue(m2.cacheWrites.isEmpty)
    }

    func testRefreshIdenticalContentZeroWrite() async {
        let m = Mocks()
        let offA = officialScenario("off_a")
        m.cacheRead = { [offA] }  // 已装载的缓存
        m.fetch = { self.http(200, self.json(["scenarios": [offA]])) }
        let service = makeService(m)

        await service.preloadScenarioCatalog()
        await service.refreshOfficialScenarioCatalog()

        XCTAssertTrue(m.cacheWrites.isEmpty)
    }

    func testRefreshHasNoThrottleEveryCallFetches() async {
        let m = Mocks()
        m.fetch = { self.http(200, "[]") }
        let service = makeService(m)

        await service.refreshOfficialScenarioCatalog()
        await service.refreshOfficialScenarioCatalog()

        XCTAssertEqual(m.fetchCalls, 2)
    }

    func testRefreshInFlightConcurrentCallsShareOneRequest() async {
        let m = Mocks()
        let gate = Gate()
        m.fetch = { try await gate.wait() }
        let service = makeService(m)

        async let p1: Void = service.refreshOfficialScenarioCatalog()
        async let p2: Void = service.refreshOfficialScenarioCatalog()
        // refresh 先走 preload（mock 同步返回），随后请求发出且挂起——真正的 in-flight 窗口
        var polls = 0
        while await gate.waiting == 0, polls < 200 {
            polls += 1
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let waiting = await gate.waiting
        XCTAssertEqual(waiting, 1)
        XCTAssertEqual(m.fetchCalls, 1)

        await gate.open(http(404, "not yet"))
        _ = await (p1, p2)
        XCTAssertEqual(m.fetchCalls, 1)
    }

    /// 在途请求闸门：fetch 在 wait() 处悬停，测试用 open(_:) 放行。
    private actor Gate {
        private var waiters: [CheckedContinuation<AuthHttpResponse, Error>] = []

        func wait() async throws -> AuthHttpResponse {
            try await withCheckedThrowingContinuation { waiters.append($0) }
        }

        func open(_ value: AuthHttpResponse) {
            let all = waiters
            waiters = []
            all.forEach { $0.resume(returning: value) }
        }

        var waiting: Int { waiters.count }
    }

    // MARK: - officialSource：官方目录来源三态（catalogBadge）

    func testSourceFallbackOnEmptyCache() async {
        let m = Mocks()
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        XCTAssertEqual(service.officialSource, .fallback)
    }

    func testSourceCacheOnNonEmptyCache() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a"), self.officialScenario("off_b")] }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        XCTAssertEqual(service.officialSource, .cache)
    }

    func testSourceStaysCacheOn404() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a")] }
        m.fetch = { self.http(404, "Not Found") }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        await service.refreshOfficialScenarioCatalog()
        XCTAssertEqual(service.officialSource, .cache)
    }

    func testSourceStaysCacheOnFetchThrow() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a")] }
        m.fetch = { throw TestError(message: "network down") }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        await service.refreshOfficialScenarioCatalog()
        XCTAssertEqual(service.officialSource, .cache)
    }

    func testSourceFallbackThen200BecomesServer() async {
        let m = Mocks()
        m.fetch = { self.http(200, self.json(["scenarios": [self.officialScenario("off_a")]])) }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        XCTAssertEqual(service.officialSource, .fallback)
        await service.refreshOfficialScenarioCatalog()
        XCTAssertEqual(service.officialSource, .server)
    }

    func testSource200EmptyCatalogBecomesFallbackInvariant() async {
        let m = Mocks()
        m.cacheRead = { [self.officialScenario("off_a")] }  // 先 cache
        m.fetch = { self.http(200, self.json(["scenarios": []])) }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        XCTAssertEqual(service.officialSource, .cache)
        await service.refreshOfficialScenarioCatalog()
        XCTAssertEqual(service.officialSource, .fallback)
        XCTAssertEqual(listOfficialScenarios(), [], "不变式：fallback ⟺ 官方桶空")
        XCTAssertEqual(m.cacheWrites, ["[]"], "空目录与已装载缓存不同 → 写盘替换")
    }

    func testSource200SameContentZeroWriteStillServer() async {
        let m = Mocks()
        let offA = officialScenario("off_a")
        m.cacheRead = { [offA] }
        m.fetch = { self.http(200, self.json(["scenarios": [offA]])) }
        let service = makeService(m)
        await service.preloadScenarioCatalog()
        await service.refreshOfficialScenarioCatalog()
        XCTAssertEqual(service.officialSource, .server)
        XCTAssertTrue(m.cacheWrites.isEmpty)
    }

    func testBadgeTextsVerbatim() {
        XCTAssertEqual(officialCatalogBadge(.server), "云端目录·已同步")
        XCTAssertEqual(officialCatalogBadge(.cache), "云端目录·本地缓存")
        XCTAssertEqual(officialCatalogBadge(.fallback), "内置场景")
    }

    // MARK: - parseOfficialScenariosBody（纯函数）

    func testParseBodyShapes() {
        let offA = officialScenario("off_a")
        XCTAssertEqual(parseOfficialScenariosBody(json([offA]))?.count, 1)
        XCTAssertEqual(parseOfficialScenariosBody(json(["scenarios": [offA, ["id": "junk"]]]))?.count, 1)
        XCTAssertNil(parseOfficialScenariosBody(json(["items": []])))
        XCTAssertNil(parseOfficialScenariosBody("not json"))
        XCTAssertNil(parseOfficialScenariosBody("42"))
        XCTAssertEqual(parseOfficialScenariosBody("[]")?.count, 0)
    }
}
