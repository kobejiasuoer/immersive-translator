import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 服务端账号认证单元测试（对齐 Windows src-tauri/src/auth.rs tests §9.2：
// FakeTransport + FakeTokenStore，不起网络、不碰 Keychain）。
// 覆盖：单飞刷新（并发 401 / 新代数 / 先落盘再重放）、401 分支（fatal 三码、
// 未知码）、主动刷新阈值、429 透传、登录落盘时序、登出契约、启动预填离线
// 保留、错误文案映射、验证码冷却持久化、base_url 覆盖、单实例守卫。
// ---------------------------------------------------------------------------

// MARK: - 假件（共享全局序号，供「先落盘再重放」类时序断言）

private final class SequenceCounter {
    private let lock = NSLock()
    private var value: UInt64 = 0

    func next() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

private struct ReceivedRequest {
    let seq: UInt64
    let method: String
    let path: String
    let bearer: String?
    let body: String?
}

private final class FakeTransport: AuthTransport {
    typealias Responder = (AuthHttpRequest) throws -> AuthHttpResponse

    private let lock = NSLock()
    private var log: [ReceivedRequest] = []
    private let seq: SequenceCounter
    private let responder: Responder
    /// 响应前的异步挂钩（模拟真实网络挂起 / 并发闸门）。
    var beforeRespond: ((AuthHttpRequest) async -> Void)?

    init(seq: SequenceCounter, responder: @escaping Responder) {
        self.seq = seq
        self.responder = responder
    }

    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse {
        // 先让出一次：模拟真实网络挂起，保证并发任务都推进到同一挂起点
        //（对齐 Windows FakeTransport 的 yield_now）。
        await Task.yield()
        if let hook = beforeRespond {
            await hook(request)
        }
        record(request, seq: seq.next())
        return try responder(request)
    }

    private func record(_ request: AuthHttpRequest, seq current: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        log.append(ReceivedRequest(
            seq: current,
            method: request.method,
            path: request.path,
            bearer: request.bearer,
            body: request.body
        ))
    }

    func requests(_ path: String) -> [ReceivedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return log.filter { $0.path == path }
    }

    func count(_ path: String) -> Int {
        requests(path).count
    }

    func totalCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return log.count
    }

    func bearerCount(_ path: String, bearer: String) -> Int {
        requests(path).filter { $0.bearer == bearer }.count
    }
}

private final class FakeTokenStore: AuthTokenStore {
    struct SavedRecord {
        let seq: UInt64
        let auth: StoredAuth
    }

    private let lock = NSLock()
    private let seq: SequenceCounter
    private var current: StoredAuth?
    private var savedRecords: [SavedRecord] = []
    private var clearCallCount = 0
    private var clearFailFirstCount = 0

    init(seq: SequenceCounter) {
        self.seq = seq
    }

    /// 预置凭据（不走 save，不产生 saved 记录/序号）。
    func preload(_ auth: StoredAuth) {
        lock.lock()
        defer { lock.unlock() }
        current = auth
    }

    func saved() -> [SavedRecord] {
        lock.lock()
        defer { lock.unlock() }
        return savedRecords
    }

    func clearCalls() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return clearCallCount
    }

    /// 前 N 次 clear 调用注入失败（§5.3 登出路径用例）。
    func failClears(_ n: Int) {
        lock.lock()
        defer { lock.unlock() }
        clearFailFirstCount = n
    }

    func save(_ auth: StoredAuth) throws {
        let current = seq.next()
        lock.lock()
        defer { lock.unlock() }
        self.current = auth
        savedRecords.append(SavedRecord(seq: current, auth: auth))
    }

    func load() -> StoredAuth? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func clear() throws {
        _ = seq.next()
        lock.lock()
        defer { lock.unlock() }
        clearCallCount += 1
        if clearCallCount <= clearFailFirstCount {
            throw AuthError.local("storage_error", "注入的 clear 失败")
        }
        current = nil
    }
}

// MARK: - 固定件

private func fixtureUser() -> AuthUser {
    AuthUser(
        id: "u1",
        email: "u@test.local",
        nickname: "u",
        plan: "free",
        createdAt: "2026-09-26T00:00:00.000Z"
    )
}

private func fixtureStored(accessExpiresAt: Int64) -> StoredAuth {
    StoredAuth(
        accessToken: "old-access",
        refreshToken: "old-refresh",
        accessExpiresAt: accessExpiresAt,
        user: fixtureUser()
    )
}

private func okLoginBody(access: String, refresh: String) -> String {
    """
    {"accessToken":"\(access)","refreshToken":"\(refresh)","expiresIn":900,"user":{"id":"u1","email":"u@test.local","nickname":"u","plan":"free","createdAt":"2026-09-26T00:00:00.000Z"}}
    """
}

private func meBody() -> String {
    """
    {"id":"u1","email":"u@test.local","nickname":"u","plan":"free","createdAt":"2026-09-26T00:00:00.000Z"}
    """
}

private func errBody(_ code: String) -> String {
    "{\"error\":{\"code\":\"\(code)\",\"message\":\"stub\"}}"
}

private func resp(_ status: Int, _ body: String) -> AuthHttpResponse {
    AuthHttpResponse(status: status, retryAfterSeconds: nil, body: body)
}

private func nowUnix() -> Int64 {
    Int64(Date().timeIntervalSince1970)
}

private func makeManager(
    transport: FakeTransport,
    store: FakeTokenStore,
    now: (() -> Int64)? = nil,
    deviceName: String = "测试 Mac"
) -> AuthTokenManager {
    if let now {
        return AuthTokenManager(transport: transport, store: store, now: now, deviceName: { deviceName })
    }
    return AuthTokenManager(transport: transport, store: store, deviceName: { deviceName })
}

// MARK: - 令牌生命周期（对齐 Windows auth.rs tests）

final class ServerAuthTests: XCTestCase {
    /// 红线 2：3 个并发 with_auth 同收 401 token_expired → refresh 端点恰被调
    /// 1 次，3 个请求全部以新 accessToken 重放成功。
    func testRefreshSingleFlightConcurrent401() async throws {
        let seq = SequenceCounter()
        // 闸门：3 个旧票 /v1/me 请求都到齐前不回 401（确定性并发）。
        let gate = Gate(expected: 3)
        let transport = FakeTransport(seq: seq) { request in
            if request.path == "/v1/auth/refresh" {
                return resp(200, okLoginBody(access: "new-access", refresh: "new-refresh"))
            }
            if request.path == "/v1/me" {
                if request.bearer == "old-access" {
                    return resp(401, errBody("token_expired"))
                }
                return resp(200, meBody())
            }
            throw AuthError.local("unknown", "unexpected path")
        }
        transport.beforeRespond = { request in
            if request.path == "/v1/me", request.bearer == "old-access" {
                await gate.arriveAndAwait()
            }
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        async let a = manager.withAuth(method: "GET", path: "/v1/me", body: nil)
        async let b = manager.withAuth(method: "GET", path: "/v1/me", body: nil)
        async let c = manager.withAuth(method: "GET", path: "/v1/me", body: nil)
        let (r1, r2, r3) = try await (a, b, c)
        XCTAssertEqual(r1.status, 200, "t1 重放后应成功")
        XCTAssertEqual(r2.status, 200, "t2 重放后应成功")
        XCTAssertEqual(r3.status, 200, "t3 重放后应成功")
        XCTAssertEqual(transport.count("/v1/auth/refresh"), 1, "并发 401 必须单飞：refresh 只发一次")
        XCTAssertTrue(
            transport.requests("/v1/auth/refresh").allSatisfy { $0.method == "POST" },
            "refresh 应为 POST"
        )
        XCTAssertEqual(transport.bearerCount("/v1/me", bearer: "old-access"), 3, "3 个任务各发一次旧票请求")
        XCTAssertEqual(transport.bearerCount("/v1/me", bearer: "new-access"), 3, "3 个请求全部以新 accessToken 重放")
        // 单飞刷新共享同一份落盘：save 恰一次，携带新对。
        let saved = store.saved()
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved[0].auth.accessToken, "new-access")
        XCTAssertEqual(saved[0].auth.refreshToken, "new-refresh")
    }

    /// 两次串行 refresh 必须发起两次 HTTP（新代数；P1 回归）。
    func testRefreshNewGenerationAfterCompletion() async throws {
        let seq = SequenceCounter()
        let counter = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/auth/refresh")
            let n = counter.next()
            return resp(200, okLoginBody(access: "access-\(n)", refresh: "refresh-\(n)"))
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        let first = try await manager.refresh()
        let second = try await manager.refresh()
        XCTAssertEqual(transport.count("/v1/auth/refresh"), 2, "串行两次 refresh 必须两次 HTTP")
        XCTAssertEqual(first.accessToken, "access-1")
        XCTAssertEqual(second.accessToken, "access-2")
        XCTAssertNotEqual(first.refreshToken, second.refreshToken)
    }

    /// 红线 3：重放请求到达 transport 时，新令牌对的 save 已发生
    /// （共享全局序号：save_seq < 重放请求 seq）。
    func testRefreshPersistBeforeReplay() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            if request.path == "/v1/auth/refresh" {
                return resp(200, okLoginBody(access: "new-access", refresh: "new-refresh"))
            }
            if request.path == "/v1/me" {
                if request.bearer == "old-access" {
                    return resp(401, errBody("token_expired"))
                }
                return resp(200, meBody())
            }
            throw AuthError.local("unknown", "unexpected path")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        let result = try await manager.withAuth(method: "GET", path: "/v1/me", body: nil)
        XCTAssertEqual(result.status, 200)

        let save = store.saved().first { $0.auth.accessToken == "new-access" }
        XCTAssertNotNil(save, "新令牌对应已落盘")
        let replay = transport.requests("/v1/me").first { $0.bearer == "new-access" }
        XCTAssertNotNil(replay, "应存在新令牌重放请求")
        XCTAssertLessThan(save!.seq, replay!.seq, "先落盘再重放：save seq 应早于重放 seq")
    }

    /// 红线 4：401 token_invalid 不触发刷新；清凭据；notice=session_expired。
    func testOnlyTokenExpiredTriggersRefresh() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/me")
            return resp(401, errBody("token_invalid"))
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        do {
            _ = try await manager.withAuth(method: "GET", path: "/v1/me", body: nil)
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "token_invalid")
            XCTAssertEqual(error.httpStatus, 401)
        }
        XCTAssertEqual(transport.count("/v1/auth/refresh"), 0, "token_invalid 绝不触发刷新")
        XCTAssertGreaterThanOrEqual(store.clearCalls(), 1, "应清凭据")
        XCTAssertNil(store.load(), "凭据应已清空")
        let status = await manager.getStatus()
        XCTAssertFalse(status.loggedIn)
        XCTAssertEqual(status.notice, .sessionExpired)
    }

    /// 红线 4/5：refresh 回 401 token_reused → 清凭据；此后取票报未登录；
    /// notice=session_kicked（全设备下线单列）。
    func testTokenReusedClearsCredentials() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/auth/refresh")
            return resp(401, errBody("token_reused"))
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        do {
            _ = try await manager.refresh()
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "token_reused")
        }
        XCTAssertNil(store.load(), "凭据应已清空")
        do {
            _ = try await manager.getAccessToken()
            XCTFail("应报未登录")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "unauthorized", "此后取 token 报未登录")
        }
        let status = await manager.getStatus()
        XCTAssertFalse(status.loggedIn)
        XCTAssertEqual(status.notice, .sessionKicked)
    }

    /// 重放仍 401：会话已死，按新 code 清凭据处理。
    func testReplayStill401ClearsCredentials() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            if request.path == "/v1/auth/refresh" {
                return resp(200, okLoginBody(access: "new-access", refresh: "new-refresh"))
            }
            if request.path == "/v1/me" {
                if request.bearer == "old-access" {
                    return resp(401, errBody("token_expired"))
                }
                return resp(401, errBody("token_invalid"))
            }
            throw AuthError.local("unknown", "unexpected path")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        do {
            _ = try await manager.withAuth(method: "GET", path: "/v1/me", body: nil)
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "token_invalid")
        }
        XCTAssertNil(store.load(), "重放仍 401 应清凭据")
        let status = await manager.getStatus()
        XCTAssertFalse(status.loggedIn)
        XCTAssertEqual(status.notice, .sessionExpired)
    }

    /// 未知 401 code：原样透传，不清凭据不刷新。
    func testUnknown401PassesThroughWithoutClearing() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/me")
            return resp(401, errBody("mysterious_code"))
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        do {
            _ = try await manager.withAuth(method: "GET", path: "/v1/me", body: nil)
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "mysterious_code")
        }
        XCTAssertEqual(transport.count("/v1/auth/refresh"), 0)
        XCTAssertNotNil(store.load(), "未知 401 不清凭据")
        let status = await manager.getStatus()
        XCTAssertTrue(status.loggedIn)
    }

    /// D6/P7 绝对阈值：expires_at=now+100（<180）先触发一次刷新并返回新票；
    /// expires_at=now+400 不触发。
    func testProactiveRefreshAbsoluteMargin() async throws {
        let fixedNow: Int64 = 1_700_000_000
        // 第一档：now + 100 < 180 → 刷
        let seq1 = SequenceCounter()
        let transport1 = FakeTransport(seq: seq1) { request in
            XCTAssertEqual(request.path, "/v1/auth/refresh")
            return resp(200, okLoginBody(access: "proactive-access", refresh: "proactive-refresh"))
        }
        let store1 = FakeTokenStore(seq: seq1)
        store1.preload(fixtureStored(accessExpiresAt: fixedNow + 100))
        let manager1 = makeManager(transport: transport1, store: store1, now: { fixedNow })
        let token1 = try await manager1.getAccessToken()
        XCTAssertEqual(token1, "proactive-access", "应返回刷新后的新 access")
        XCTAssertEqual(transport1.count("/v1/auth/refresh"), 1, "惰性阈值内应刷新一次")

        // 第二档：now + 400 > 180 → 不刷，直接用旧票
        let seq2 = SequenceCounter()
        let transport2 = FakeTransport(seq: seq2) { _ in
            resp(200, okLoginBody(access: "should-not-happen", refresh: "should-not-happen"))
        }
        let store2 = FakeTokenStore(seq: seq2)
        store2.preload(fixtureStored(accessExpiresAt: fixedNow + 400))
        let manager2 = makeManager(transport: transport2, store: store2, now: { fixedNow })
        let token2 = try await manager2.getAccessToken()
        XCTAssertEqual(token2, "old-access", "阈值外不应刷新")
        XCTAssertEqual(transport2.count("/v1/auth/refresh"), 0, "阈值外不应发 refresh")
    }

    /// 429 + retry-after:37 → 透传 retryAfterSeconds=37；不自动重试。
    func testRateLimitedSurfacedNoRetry() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/auth/otp/request")
            return AuthHttpResponse(status: 429, retryAfterSeconds: 37, body: errBody("rate_limited"))
        }
        let store = FakeTokenStore(seq: seq)
        let manager = makeManager(transport: transport, store: store)

        do {
            try await manager.sendOTP(email: "someone@test.local")
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "rate_limited")
            XCTAssertEqual(error.httpStatus, 429)
            XCTAssertEqual(error.retryAfterSeconds, 37)
        }
        XCTAssertEqual(transport.count("/v1/auth/otp/request"), 1, "429 不自动重试")
    }

    /// §7-2：verify 成功 = 先落盘 → 内存态 → 返回 user；device 由原生层填
    /// （platform=macos，name 非空且 ≤64）。
    func testLoginSuccessPersistsBeforeReturn() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/auth/otp/verify")
            return resp(200, okLoginBody(access: "acc-1", refresh: "ref-1"))
        }
        let store = FakeTokenStore(seq: seq)
        let manager = makeManager(transport: transport, store: store)

        let user = try await manager.verifyOTP(email: "someone@test.local", code: "123456")
        XCTAssertEqual(user.id, "u1")

        // device 由原生层填：platform=macos，name 非空且 ≤64
        let verifyRequests = transport.requests("/v1/auth/otp/verify")
        let bodyText = verifyRequests[0].body
        XCTAssertNotNil(bodyText)
        let body = try JSONSerialization.jsonObject(with: bodyText!.data(using: .utf8)!) as? [String: Any]
        let device = body?["device"] as? [String: Any]
        XCTAssertEqual(device?["platform"] as? String, "macos")
        let name = device?["name"] as? String
        XCTAssertNotNil(name)
        XCTAssertFalse(name!.isEmpty)
        XCTAssertLessThanOrEqual(name!.count, 64)

        // 持久化先于返回：save 已发生（1 次、携带新对）
        let saved = store.saved()
        XCTAssertEqual(saved.count, 1, "恰一次落盘")
        XCTAssertEqual(saved[0].auth.accessToken, "acc-1")
        XCTAssertEqual(saved[0].auth.refreshToken, "ref-1")
        let afterReturn = seq.next()
        XCTAssertLessThan(saved[0].seq, afterReturn, "save 应发生在命令返回之前")

        let status = await manager.getStatus()
        XCTAssertTrue(status.loggedIn)
        XCTAssertEqual(status.user, fixtureUser())
        XCTAssertNil(status.notice, "登录成功清除 notice")
    }

    /// device.name 超 64 字符截到 64（对齐 Windows chars().take(64)）。
    func testDeviceNameTruncatedTo64() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { _ in
            resp(200, okLoginBody(access: "a", refresh: "r"))
        }
        let store = FakeTokenStore(seq: seq)
        let longName = String(repeating: "设备", count: 60) // 120 字符
        let manager = AuthTokenManager(transport: transport, store: store, deviceName: { longName })

        _ = try await manager.loginPassword(email: "u@test.local", password: "p")
        let body = transport.requests("/v1/auth/login")[0].body
        let object = try JSONSerialization.jsonObject(with: body!.data(using: .utf8)!) as? [String: Any]
        let name = (object?["device"] as? [String: Any])?["name"] as? String
        XCTAssertEqual(name?.count, 64, "name 应截断到 64 字符")
    }

    /// 服务端登出请求网络失败：本地照常清理，serverRevoked=false。
    func testLogoutAlwaysClearsLocal() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { _ in
            throw AuthError.local("network_error", "注入的网络失败")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        let outcome = try await manager.logout()
        XCTAssertFalse(outcome.serverRevoked, "网络失败时 serverRevoked=false")
        XCTAssertNil(store.load(), "本地凭据应清空")
        let status = await manager.getStatus()
        XCTAssertFalse(status.loggedIn)
    }

    /// §5.3：clear 注入失败（重试一次仍败）→ storage_error、内存态保留；
    /// clear 恢复后重试登出 → 正常登出。
    func testLogoutClearFailureKeepsState() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            XCTAssertEqual(request.path, "/v1/auth/logout")
            return resp(204, "")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        store.failClears(2) // 首次 clear + 重试一次都失败
        let manager = makeManager(transport: transport, store: store)

        do {
            _ = try await manager.logout()
            XCTFail("应抛 storage_error")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "storage_error")
        }
        XCTAssertEqual(store.clearCalls(), 2, "clear 应重试一次")
        XCTAssertNotNil(store.load(), "磁盘凭据保留")
        let keptStatus = await manager.getStatus()
        XCTAssertTrue(keptStatus.loggedIn, "登出失败保持登录态（不广播登出）")

        // clear 恢复（fail 配额已耗尽）→ 重试登出成功
        let outcome = try await manager.logout()
        XCTAssertTrue(outcome.serverRevoked)
        XCTAssertNil(store.load())
        let status = await manager.getStatus()
        XCTAssertFalse(status.loggedIn)
    }

    /// §4.4：store 有数据 + refresh 网络错 → 保留预填态，仍显示已登录。
    func testBootstrapOfflineKeepsLoggedIn() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { _ in
            throw AuthError.local("network_error", "注入的离线")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        let user = await manager.prefillFromStore()
        XCTAssertEqual(user, fixtureUser(), "启动预填内存态")
        do {
            _ = try await manager.refresh()
            XCTFail("应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error.code, "network_error")
        }
        let status = await manager.getStatus()
        XCTAssertTrue(status.loggedIn, "离线时保留预填态（不回退 UI）")
        XCTAssertNotNil(store.load(), "离线不清凭据")
    }

    /// §4.4：内存态空、store 有 → get_status 预填并返回 loggedIn:true。
    func testGetStatusPrefillsFromStore() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { _ in
            throw AuthError.local("unknown", "get_status 不应发请求")
        }
        let store = FakeTokenStore(seq: seq)
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))
        let manager = makeManager(transport: transport, store: store)

        let status = await manager.getStatus()
        XCTAssertTrue(status.loggedIn)
        XCTAssertEqual(status.user, fixtureUser())
        XCTAssertNil(status.notice)
        XCTAssertEqual(transport.totalCount(), 0, "get_status 不发任何请求")
    }

    /// 登录成功后取票：凭据已在内存态，不重读 store、不发 refresh。
    func testGetAccessTokenAfterLoginUsesMemoryState() async throws {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq) { request in
            if request.path == "/v1/auth/otp/verify" {
                return resp(200, okLoginBody(access: "acc-1", refresh: "ref-1"))
            }
            throw AuthError.local("unknown", "unexpected path")
        }
        let store = FakeTokenStore(seq: seq)
        let fixedNow: Int64 = 1_700_000_000
        let manager = makeManager(transport: transport, store: store, now: { fixedNow })
        _ = try await manager.verifyOTP(email: "u@test.local", code: "123456")

        let token = try await manager.getAccessToken()
        XCTAssertEqual(token, "acc-1")
        XCTAssertEqual(transport.count("/v1/auth/refresh"), 0, "expiresIn=900 未到阈值不应刷新")
    }
}

// MARK: - 错误文案映射（authErrorText.ts §3 表逐字）

final class AuthErrorTextTests: XCTestCase {
    func testKnownCodesUseExactCopy() {
        XCTAssertEqual(authErrorText(.local("otp_invalid", "x")).text, "验证码错误或已过期，请重新获取")
        XCTAssertEqual(authErrorText(.local("invalid_credentials", "x")).text, "邮箱或密码不正确；若从未设置密码，请改用验证码登录")
        XCTAssertEqual(authErrorText(.local("banned", "x")).text, "该账号已被封禁，如有疑问请联系支持")
        XCTAssertEqual(authErrorText(.local("token_expired", "x")).kind, AuthErrorTextKind.silent)
        XCTAssertEqual(authErrorText(.local("token_invalid", "x")).kind, AuthErrorTextKind.statusbar)
        XCTAssertEqual(authErrorText(.local("token_reused", "x")).text, "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录")
        XCTAssertEqual(authErrorText(.local("network_error", "x")).text, "网络连接失败，请检查网络后重试")
        XCTAssertEqual(authErrorText(.local("storage_error", "x")).text, "本地安全存储读写失败，请重试或反馈")
        XCTAssertEqual(authErrorText(.local("parse_error", "x")).text, "服务响应异常，请稍后再试")
        XCTAssertEqual(authErrorText(.local("unknown", "x")).text, "服务响应异常，请稍后再试")
    }

    func testServerMessageNeverEntersResult() {
        let result = authErrorText(AuthError(code: "otp_invalid", message: "内部服务端消息", httpStatus: 400, retryAfterSeconds: nil))
        XCTAssertEqual(result.text, "验证码错误或已过期，请重新获取")
        XCTAssertFalse(result.text.contains("内部服务端消息"))
    }

    func testUnauthorizedNormalizesToTokenInvalid() {
        let result = authErrorText(.local("unauthorized", "x"))
        XCTAssertEqual(result.code, "token_invalid")
        XCTAssertEqual(result.text, "登录已失效，请重新登录")
    }

    func testRateLimitedInterpolatesRetryAfter() {
        let withSeconds = authErrorText(AuthError(code: "rate_limited", message: "x", httpStatus: 429, retryAfterSeconds: 37))
        XCTAssertEqual(withSeconds.text, "操作过于频繁，请 37 秒后再试")
        let withoutSeconds = authErrorText(AuthError(code: "rate_limited", message: "x", httpStatus: 429, retryAfterSeconds: nil))
        XCTAssertEqual(withoutSeconds.text, "操作过于频繁，请稍后再试")
    }

    func testUnknownCodeFallsBack() {
        let result = authErrorText(.local("never_seen_code", "x"))
        XCTAssertEqual(result.code, "unknown")
        XCTAssertEqual(result.text, "服务响应异常，请稍后再试")
        let empty = authErrorText(.local("", "x"))
        XCTAssertEqual(empty.code, "unknown")
    }

    func testNoticeText() {
        XCTAssertEqual(authNoticeText(.sessionExpired), "登录已失效，请重新登录")
        XCTAssertEqual(authNoticeText(.sessionKicked), "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录")
        XCTAssertNil(authNoticeText(nil))
    }
}

// MARK: - 验证码冷却（useResendCooldown.ts D3/D10/P14）

private final class InMemoryCooldownStorage: OtpCooldownStorage {
    private var map: [String: String] = [:]

    func readString(forKey key: String) -> String? {
        map[key]
    }

    func writeString(_ value: String, forKey key: String) {
        map[key] = value
    }
}

final class OtpCooldownTests: XCTestCase {
    func testParseMapToleratesGarbage() {
        XCTAssertEqual(OtpCooldown.parseMap(nil).count, 0)
        XCTAssertEqual(OtpCooldown.parseMap("not json").count, 0)
        XCTAssertEqual(OtpCooldown.parseMap("[1,2]").count, 0)
        let mixed = #"{"a@x.com":1234567890,"bad":"nope","neg":-5,"zero":0}"#
        let parsed = OtpCooldown.parseMap(mixed)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed["a@x.com"], 1_234_567_890)
    }

    func testRemainingSecondsCeilSemantics() {
        let sentAt: Double = 1_000_000_000_000
        var map: [String: Double] = ["a@x.com": sentAt]
        // 刚发送 → 满 60
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "a@x.com", nowMs: sentAt), 60)
        // 30.5s → ceil(60-30.5)=30（Windows remainingSeconds 同式）
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "a@x.com", nowMs: sentAt + 30_500), 30)
        // 59.9s → 1（不早归零）
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "a@x.com", nowMs: sentAt + 59_900), 1)
        // 60s → 0
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "a@x.com", nowMs: sentAt + 60_000), 0)
        // 过期很久 → 0
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "a@x.com", nowMs: sentAt + 999_999), 0)
        // 未记录邮箱 → 0
        map["b@x.com"] = sentAt
        XCTAssertEqual(OtpCooldown.remainingSeconds(map, email: "c@x.com", nowMs: sentAt), 0)
    }

    func testWriteTrimsToTenMostRecent() {
        let storage = InMemoryCooldownStorage()
        var now: Double = 1_000_000_000_000
        for i in 0..<12 {
            OtpCooldown.write(email: "user\(i)@x.com", sentAtMs: now, storage: storage)
            now += 1000
        }
        let stored = OtpCooldown.parseMap(storage.readString(forKey: OtpCooldown.storageKey))
        XCTAssertEqual(stored.count, OtpCooldown.maxEmails, "按最近使用截断至 10 条")
        XCTAssertNil(stored["user0@x.com"], "最旧两条被淘汰")
        XCTAssertNil(stored["user1@x.com"])
        XCTAssertEqual(stored["user11@x.com"], now - 1000, "最新一条保留")
    }

    /// D10：关窗重开（新 tracker 实例、同存储、同邮箱）恢复剩余倒计时。
    func testTrackerRestoresRemainingAcrossInstances() {
        let storage = InMemoryCooldownStorage()
        var nowMs: Double = 1_000_000_000_000
        let first = OtpCooldownTracker(storage: storage, nowMs: { nowMs })
        first.markSent(email: "a@x.com")
        XCTAssertEqual(first.remaining(email: "a@x.com"), 60)

        // 模拟 25s 后新开登录窗
        nowMs += 25_000
        let reopened = OtpCooldownTracker(storage: storage, nowMs: { nowMs })
        let remaining = reopened.remaining(email: "a@x.com")
        XCTAssertEqual(remaining, 35)
        XCTAssertTrue(remaining <= 60, "恢复值不超 60")
    }
}

// MARK: - base_url 两层机制（§4.6）

final class ServerAuthConfigurationTests: XCTestCase {
    func testEndpointOverrideWins() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("auth-endpoint-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        XCTAssertEqual(
            ServerAuthConfiguration.resolveBaseURL(appSupportDirectory: dir),
            ServerAuthConfiguration.devBaseURL,
            "无覆盖文件 → dev 缺省"
        )

        let file = dir.appendingPathComponent(ServerAuthConfiguration.endpointFileName)
        try? "{\"baseUrl\":\"https://api.example.com/v1\"}".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(
            ServerAuthConfiguration.resolveBaseURL(appSupportDirectory: dir),
            "https://api.example.com/v1"
        )

        try "{\"baseUrl\":\"  \"}".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(
            ServerAuthConfiguration.resolveBaseURL(appSupportDirectory: dir),
            ServerAuthConfiguration.devBaseURL,
            "空 baseUrl → 回 dev 缺省"
        )

        try "{broken json".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(
            ServerAuthConfiguration.resolveBaseURL(appSupportDirectory: dir),
            ServerAuthConfiguration.devBaseURL,
            "坏 JSON → 回 dev 缺省"
        )
    }
}

// MARK: - JSON 转义

final class EscapeJSONStringTests: XCTestCase {
    func testEscapesQuotesBackslashAndKeepsUnicode() throws {
        let encoded = escapeJSONString("he said \"hi\" \\ 你好")
        let roundTrip = try JSONSerialization.jsonObject(with: Data("[\(encoded)]".utf8)) as? [String]
        XCTAssertEqual(roundTrip?.first, "he said \"hi\" \\ 你好")
    }
}

// MARK: - ServerAuthClient（门面：登录/登出/启动广播）

@MainActor
final class ServerAuthClientTests: XCTestCase {
    private func makeClient(
        responder: @escaping FakeTransport.Responder
    ) -> (ServerAuthClient, FakeTransport, FakeTokenStore, URL) {
        let seq = SequenceCounter()
        let transport = FakeTransport(seq: seq, responder: responder)
        let store = FakeTokenStore(seq: seq)
        let manager = AuthTokenManager(transport: transport, store: store)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("auth-client-tests-\(UUID().uuidString)", isDirectory: true)
        let client = ServerAuthClient(manager: manager, appSupportDirectory: dir)
        return (client, transport, store, dir)
    }

    /// 登录成功广播已登录；登出成功广播未登录（事件驱动更新）。
    func testVerifyOTPAndLogoutPublishStatus() async throws {
        let (client, _, store, dir) = makeClient { request in
            switch request.path {
            case "/v1/auth/otp/verify":
                return resp(200, okLoginBody(access: "a1", refresh: "r1"))
            case "/v1/me/config":
                return resp(200, "{\"theme\":\"warm\"}")
            case "/v1/auth/logout":
                return resp(204, "")
            default:
                throw AuthError.local("unknown", "unexpected \(request.path)")
            }
        }
        defer { try? FileManager.default.removeItem(at: dir) }

        XCTAssertFalse(client.status.loggedIn)
        let user = try await client.verifyOTP(email: "u@test.local", code: "123456")
        XCTAssertEqual(user.id, "u1")
        XCTAssertTrue(client.status.loggedIn, "登录成功广播已登录")
        XCTAssertEqual(client.status.user?.email, "u@test.local")
        XCTAssertNil(client.status.notice)

        // me/config 后台拉取 + 落盘（D7）
        try await waitUntil(timeout: 3) {
            FileManager.default.fileExists(atPath: dir.appendingPathComponent(ServerAuthConfiguration.serverConfigFileName).path)
        }

        _ = try await client.logout()
        XCTAssertFalse(client.status.loggedIn, "登出成功广播未登录")
        XCTAssertNil(store.load())
    }

    /// 启动预填→广播已登录；后台刷新网络失败保留预填态（§4.4 ③）。
    func testBootstrapOfflineKeepsPrefilledLoggedIn() async throws {
        let (client, _, store, dir) = makeClient { _ in
            throw AuthError.local("network_error", "注入的离线")
        }
        defer { try? FileManager.default.removeItem(at: dir) }
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))

        client.bootstrap()
        try await waitUntil(timeout: 3) { client.status.loggedIn }
        // 等待后台刷新完成（网络错 → 保留预填态）
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(client.status.loggedIn, "离线时保留预填态")
    }

    /// 启动刷新 fatal（token_reused）→ 广播未登录 + session_kicked。
    func testBootstrapFatalPublishesKicked() async throws {
        let (client, _, store, dir) = makeClient { request in
            XCTAssertEqual(request.path, "/v1/auth/refresh")
            return resp(401, errBody("token_reused"))
        }
        defer { try? FileManager.default.removeItem(at: dir) }
        store.preload(fixtureStored(accessExpiresAt: nowUnix() + 1000))

        client.bootstrap()
        // 初始态本就是未登录，须等到失效 notice 被广播（预填→已登录→fatal→未登录+notice）。
        try await waitUntil(timeout: 3) { client.status.notice != nil }
        XCTAssertFalse(client.status.loggedIn)
        XCTAssertEqual(client.status.notice, .sessionKicked)
        XCTAssertNil(store.load(), "fatal 已清凭据")
    }

    private func waitUntil(
        timeout: TimeInterval,
        condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("等待条件超时（\(timeout)s）")
    }
}

// MARK: - 设置窗「账号」分区展示工具（AccountSection.tsx:55-79 同式）

final class AccountSectionDisplayTests: XCTestCase {
    private func user(nickname: String?, email: String, createdAt: String = "2026-09-26T00:00:00.000Z") -> AuthUser {
        AuthUser(id: "u1", email: email, nickname: nickname, plan: "free", createdAt: createdAt)
    }

    /// 昵称优先；无昵称用邮箱 @ 前段；都没有则「未命名用户」。
    func testDisplayName() {
        XCTAssertEqual(AccountSectionView.displayName(user(nickname: " 小译 ", email: "a@x.com")), "小译")
        XCTAssertEqual(AccountSectionView.displayName(user(nickname: nil, email: "reader@x.com")), "reader")
        XCTAssertEqual(AccountSectionView.displayName(user(nickname: "   ", email: "reader@x.com")), "reader")
        XCTAssertEqual(AccountSectionView.displayName(user(nickname: nil, email: "@x.com")), "@x.com")
        XCTAssertEqual(AccountSectionView.displayName(user(nickname: nil, email: "   ")), "未命名用户")
    }

    /// 头像字符：昵称（或邮箱）首字符大写；空则「·」。
    func testAvatarGlyph() {
        XCTAssertEqual(AccountSectionView.avatarGlyph(user(nickname: "yang", email: "a@x.com")), "Y")
        XCTAssertEqual(AccountSectionView.avatarGlyph(user(nickname: nil, email: "reader@x.com")), "R")
        XCTAssertEqual(AccountSectionView.avatarGlyph(user(nickname: "译者", email: "a@x.com")), "译")
        XCTAssertEqual(AccountSectionView.avatarGlyph(user(nickname: "  ", email: "  ")), "·")
    }

    /// 注册时间 ISO → YYYY-MM-DD（带/不带毫秒都可；坏串原样回）。
    func testFormatDate() {
        // 用 UTC 正午避免时区把日期推到前后一天。
        XCTAssertEqual(AccountSectionView.formatDate("2026-09-26T12:00:00.000Z"), "2026-09-26")
        XCTAssertEqual(AccountSectionView.formatDate("2026-09-26T12:00:00Z"), "2026-09-26")
        XCTAssertEqual(AccountSectionView.formatDate("not-a-date"), "not-a-date")
    }

    /// 账号分区导航信号：每次请求递增一次（设置窗据此滚到账号锚点）。
    @MainActor
    func testAccountNavigationSignalIncrements() {
        let navigation = SettingsAccountNavigation()
        XCTAssertEqual(navigation.scrollRequestID, 0)
        navigation.requestScrollToAccount()
        navigation.requestScrollToAccount()
        XCTAssertEqual(navigation.scrollRequestID, 2)
    }
}

// MARK: - 单实例守卫

final class SingleInstanceGuardTests: XCTestCase {
    private func temporaryLockURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("single-instance-\(UUID().uuidString).lock")
    }

    /// 同一锁文件第二次 claim 失败，并触发首实例的激活回调（双开语义：
    /// flock 在同进程的两个不同 fd 之间同样互斥，与跨进程行为一致）。
    func testSecondClaimFailsAndActivatesFirst() async throws {
        let lockURL = temporaryLockURL()
        let notification = "local.immersive-translator.test.activate.\(UUID().uuidString)"
        let first = SingleInstanceGuard(lockFileURL: lockURL, activationNotificationName: notification)
        let second = SingleInstanceGuard(lockFileURL: lockURL, activationNotificationName: notification)
        defer {
            first.release()
            second.release()
            try? FileManager.default.removeItem(at: lockURL)
        }

        let activated = expectation(description: "首实例收到激活通知")
        first.observeActivation { activated.fulfill() }

        XCTAssertTrue(first.claim(), "首实例应成功持锁")
        XCTAssertFalse(second.claim(), "第二实例应失败并请求激活已有实例")

        await fulfillment(of: [activated], timeout: 5)
    }

    /// 首实例释放后可再次 claim（更新器先退出旧进程再拉起新版本的路径：
    /// 进程退出内核自动释放锁，不会误判双开）。
    func testClaimAfterReleaseSucceeds() {
        let lockURL = temporaryLockURL()
        defer { try? FileManager.default.removeItem(at: lockURL) }

        let first = SingleInstanceGuard(lockFileURL: lockURL)
        XCTAssertTrue(first.claim())
        first.release()

        let successor = SingleInstanceGuard(lockFileURL: lockURL)
        XCTAssertTrue(successor.claim(), "旧实例退出后新实例应可持锁")
        successor.release()
    }

    /// 幂等：同一守卫重复 claim 不自锁。
    func testClaimIsIdempotent() {
        let lockURL = temporaryLockURL()
        defer { try? FileManager.default.removeItem(at: lockURL) }
        let guardInstance = SingleInstanceGuard(lockFileURL: lockURL)
        XCTAssertTrue(guardInstance.claim())
        XCTAssertTrue(guardInstance.claim(), "本实例已持锁应直接返回 true")
        guardInstance.release()
    }

    /// 进程存活探测：自身 pid 活；子进程退出后死；非法 pid 死。
    func testIsProcessAlive() throws {
        XCTAssertTrue(SingleInstanceGuard.isProcessAlive(getpid()), "自身进程应存活")
        XCTAssertFalse(SingleInstanceGuard.isProcessAlive(0))
        XCTAssertFalse(SingleInstanceGuard.isProcessAlive(-1))

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["10"]
        try process.run()
        XCTAssertTrue(SingleInstanceGuard.isProcessAlive(process.processIdentifier), "运行中的子进程应存活")
        process.terminate()
        process.waitUntilExit()
        XCTAssertFalse(SingleInstanceGuard.isProcessAlive(process.processIdentifier), "退出的子进程应判死")
    }
}

// MARK: - 并发闸门（确定性等待 N 个到达者）

private final class Gate {
    private let lock = NSLock()
    private var arrived = 0
    private let expected: Int

    init(expected: Int) {
        self.expected = expected
    }

    private var isReady: Bool {
        lock.lock()
        defer { lock.unlock() }
        return arrived >= expected
    }

    private func arrive() {
        lock.lock()
        defer { lock.unlock() }
        arrived += 1
    }

    func arriveAndAwait() async {
        arrive()
        while !isReady {
            await Task.yield()
        }
    }
}
