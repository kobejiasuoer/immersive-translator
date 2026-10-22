import AppKit
import Foundation

// ---------------------------------------------------------------------------
// 服务端账号认证：全部认证 HTTP 与令牌生命周期收在本文件（对齐 Windows
// immersive-translator-windows/src-tauri/src/auth.rs 的设计 D4 与五条红线）。
//
// 红线落点（与 Windows auth.rs 模块头一一对应）：
// 1. 令牌只进 Keychain（KeychainStore server_auth 单槽，绝不落明文）；
// 2. 刷新单飞：同一时刻至多一个 /v1/auth/refresh 在途，并发 401 共享同一次
//    刷新（AuthTokenManager.inflight + 代数清槽 + 旧票比对搭车）；
// 3. 先持久化再重放（doRefresh 内 save 先于返回，重放用的是已落盘的新对）；
// 4. 401 分支：仅 token_expired 触发刷新重放一次；token_invalid /
//    token_reused / unauthorized 清凭据绝不再刷；
// 5. 登出：服务端吊销尽力 + 本地清空（失败重试一次，仍失败报 storage_error
//    并保持登录态，不广播登出）。
//
// token 永不跨层暴露：对外方法只返回 user / 登录态 / notice 失效原因，
// accessToken 只在管理器内部与传输层之间流转。
// ---------------------------------------------------------------------------

// MARK: - 错误与账号模型

/// 统一错误。`code` 为服务端 `error.code` 原样透传，或本地伪码
/// network_error / storage_error / parse_error / unknown。
struct AuthError: Error {
    let code: String
    let message: String
    var httpStatus: Int?
    var retryAfterSeconds: Int?

    /// 本地伪码构造（网络/存储/解析类失败，无 HTTP 状态）。
    static func local(_ code: String, _ message: String) -> AuthError {
        AuthError(code: code, message: message, httpStatus: nil, retryAfterSeconds: nil)
    }
}

extension AuthError: CustomStringConvertible {
    var description: String { "[\(code)] \(message)" }
}

/// 账号资料（登录响应里的 `user` 同款；`nickname` 服务端可为 null）。
struct AuthUser: Codable, Equatable {
    let id: String
    let email: String
    let nickname: String?
    let plan: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, email, nickname, plan
        case createdAt
    }
}

/// 失效原因（设计 D8）：持久渲染在账号区顶部状态条，登录成功即清除。
enum AuthNotice: String, Equatable {
    case sessionExpired = "session_expired"
    case sessionKicked = "session_kicked"
}

/// 登录态快照（登录判据全程序唯一：内存态优先，空则回读 Keychain 并预填）。
struct AuthStatus: Equatable {
    let loggedIn: Bool
    let user: AuthUser?
    let notice: AuthNotice?

    static let loggedOut = AuthStatus(loggedIn: false, user: nil, notice: nil)
}

/// 登出结果：服务端吊销尽力而为，网络失败时 serverRevoked=false。
struct LogoutOutcome: Equatable {
    let serverRevoked: Bool
}

// MARK: - 可注入的传输层（红线可测试性的落点，§4.1）

struct AuthHttpRequest {
    /// "GET" / "POST"（与 Windows AuthTransport 的 reqwest::Method 对应）。
    let method: String
    let path: String
    let body: String?
    let bearer: String?
}

struct AuthHttpResponse {
    let status: Int
    let retryAfterSeconds: Int?
    let body: String
}

protocol AuthTransport: AnyObject {
    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse
}

// MARK: - base_url 两层机制（§4.6）+ URLSession 传输

enum ServerAuthConfiguration {
    /// dev/联调缺省；生产由 `~/Library/Application Support/ImmersiveTranslator/
    /// server_endpoint.json`（`{"baseUrl":"https://..."}`，明文非敏感）覆盖。
    static let devBaseURL = "http://127.0.0.1:8090"
    static let endpointFileName = "server_endpoint.json"
    static let serverConfigFileName = "server_config.json"

    /// 与 ReaderStore/NoteStore 同法的应用数据目录。
    static func defaultAppSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
    }

    /// §4.6 base_url 两层机制：endpoint 覆盖文件存在且 baseUrl 非空则覆盖 dev 缺省。
    static func resolveBaseURL(appSupportDirectory: URL? = nil) -> String {
        let directory = appSupportDirectory ?? defaultAppSupportDirectory()
        let fileURL = directory.appendingPathComponent(endpointFileName)
        if let text = try? String(contentsOf: fileURL, encoding: .utf8),
           let data = text.data(using: .utf8),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let url = (object["baseUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !url.isEmpty {
            return url
        }
        return devBaseURL
    }
}

/// 生产传输层：URLSession + 30s 超时，retry-after 透传。
final class URLSessionAuthTransport: AuthTransport {
    private let baseURL: String
    private let session: URLSession

    init(baseURL: String) {
        self.baseURL = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    func send(_ request: AuthHttpRequest) async throws -> AuthHttpResponse {
        guard let url = URL(string: baseURL + request.path) else {
            throw AuthError.local("unknown", "无法构造请求地址: \(baseURL)\(request.path)")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body?.data(using: .utf8)
        if let bearer = request.bearer {
            urlRequest.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization")
        }
        if request.body != nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw AuthError.local("parse_error", "服务响应异常（非 HTTP）")
            }
            let retryAfter = http.value(forHTTPHeaderField: "retry-after")
                .flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            let body = String(data: data, encoding: .utf8) ?? ""
            return AuthHttpResponse(
                status: http.statusCode,
                retryAfterSeconds: retryAfter,
                body: body
            )
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)")
        }
    }
}

// MARK: - 可注入的持久层（Keychain 单槽，§5）

/// 双令牌单槽 JSON（设计 D5）：单次写入保证 accessToken / refreshToken /
/// user 配套。存 KeychainStore 的 server_auth 槽（既有 service 名不动）。
struct StoredAuth: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    /// unix 秒（唯一时间字段；主动刷新阈值只用它，D6/P7）。
    let accessExpiresAt: Int64
    let user: AuthUser

    enum CodingKeys: String, CodingKey {
        case accessToken, refreshToken
        case accessExpiresAt
        case user
    }
}

protocol AuthTokenStore: AnyObject {
    func save(_ auth: StoredAuth) throws
    func load() -> StoredAuth?
    /// 可失败（§5.3）：登出路径对其有明确定义（失败重试一次）。
    func clear() throws
}

/// Keychain 实现：经 KeychainStore 的 server_auth 槽（kSecClassGenericPassword，
/// 既有 service local.immersive-translator.mvp）。解析失败按无凭据处理并留日志。
final class KeychainAuthTokenStore: AuthTokenStore {
    func save(_ auth: StoredAuth) throws {
        do {
            let data = try JSONEncoder().encode(auth)
            guard let json = String(data: data, encoding: .utf8) else {
                throw AuthError.local("storage_error", "序列化凭据失败")
            }
            try KeychainStore.saveServerAuthTokenJSON(json)
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("storage_error", "写入本地凭据失败: \(error.localizedDescription)")
        }
    }

    func load() -> StoredAuth? {
        guard let json = KeychainStore.loadServerAuthTokenJSON() else { return nil }
        guard let data = json.data(using: .utf8), let stored = try? JSONDecoder().decode(StoredAuth.self, from: data) else {
            // 槽内数据解析失败（格式漂移等）：按无凭据处理并留日志。
            DiagnosticLogger.log("auth.keychain.decode.failed（视为未登录）")
            return nil
        }
        return stored
    }

    func clear() throws {
        do {
            try KeychainStore.clearServerAuthToken()
        } catch {
            throw AuthError.local("storage_error", "清除本地凭据失败: \(error.localizedDescription)")
        }
    }
}

// MARK: - 响应解析（服务端错误形状：{"error":{code,message}}）

private struct ErrorBody: Decodable {
    struct Inner: Decodable {
        let code: String
        let message: String
    }

    let error: Inner
}

private struct LoginResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int64
    let user: AuthUser
}

/// 非 2xx → AuthError（`error.code` 原样透传；解析失败映射本地伪码 parse_error）。
private func errorFromResponse(_ response: AuthHttpResponse) -> AuthError {
    if let data = response.body.data(using: .utf8),
       let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data) {
        return AuthError(
            code: parsed.error.code,
            message: parsed.error.message,
            httpStatus: response.status,
            retryAfterSeconds: response.retryAfterSeconds
        )
    }
    return AuthError(
        code: "parse_error",
        message: "服务响应异常(HTTP \(response.status))",
        httpStatus: response.status,
        retryAfterSeconds: response.retryAfterSeconds
    )
}

private func parseLoginResponse(_ body: String) throws -> LoginResponse {
    guard let data = body.data(using: .utf8) else {
        throw AuthError.local("parse_error", "解析登录响应失败")
    }
    do {
        return try JSONDecoder().decode(LoginResponse.self, from: data)
    } catch {
        throw AuthError.local("parse_error", "解析登录响应失败: \(error.localizedDescription)")
    }
}

/// 刷新上下文下的致命三码（凭据已被清除；§7 表「fatal 三码」）。
func isFatalAuthCode(_ code: String) -> Bool {
    code == "token_expired" || code == "token_invalid" || code == "token_reused"
}

/// 401 致命码 → notice（D8）：reused 全设备下线单列，其余归会话过期。
func noticeForAuthCode(_ code: String) -> AuthNotice? {
    switch code {
    case "token_reused": return .sessionKicked
    case "token_invalid", "token_expired": return .sessionExpired
    default: return nil
    }
}

// MARK: - AuthTokenManager：单飞刷新 + 401 分支 + 持久化时序 + 预填契约（§4）

/// 惰性主动刷新阈值（D6）：`now + 180 >= access_expires_at` 即刷。
/// Windows REFRESH_MARGIN_SECS 对应物。
let authRefreshMarginSeconds: Int64 = 180

/// 令牌管理器（actor 即权威内存态）。单飞刷新的 Swift 落法：`inflight` 槽
/// 持一个共享 `Task`（Task 是多消费者 future：任意多个调用者 await 同一个
/// 拿同一份缓存结果，无消费语义），完成后仅当槽内仍是本任务才清槽（代数
/// 清槽），新一轮刷新不受已完成旧句柄影响。
actor AuthTokenManager {
    private let transport: AuthTransport
    private let store: AuthTokenStore
    /// 内存权威态（启动预填，§4.4）。
    private var state: StoredAuth?
    /// 单飞槽：(代数, 共享任务句柄)。完成方按代数比对清槽（Windows
    /// `inflight: Option<(u64, SharedRefresh)>` 同构）。
    private var inflight: (generation: UInt64, task: Task<Result<StoredAuth, AuthError>, Never>)?
    private var nextGeneration: UInt64 = 0
    /// 最近一次致命失效原因（getStatus 携带；登录成功清除）。
    private var notice: AuthNotice?
    /// 可注入时钟与设备名（单测确定性；生产用真实时钟/Host 名）。
    private let now: () -> Int64
    private let deviceName: () -> String

    init(
        transport: AuthTransport,
        store: AuthTokenStore,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) },
        deviceName: @escaping () -> String = { Host.current().localizedName ?? "Mac" }
    ) {
        self.transport = transport
        self.store = store
        self.now = now
        self.deviceName = deviceName
    }

    // ------------------------------------------------------------------
    // 单飞刷新
    // ------------------------------------------------------------------

    /// 单飞入口：同一时刻至多一个 /v1/auth/refresh 在途；并发调用共享同一次
    /// 结果（§4.2）。两次串行 refresh 必须发起两次 HTTP（新代数）。
    func refresh() async throws -> StoredAuth {
        try await refreshInner(staleToken: nil).get()
    }

    /// 401(token_expired) 后的单飞刷新（§4.3 红线 2）。与 refresh 共用同一
    /// 在途槽，另做「旧票比对」：到达时若槽已空、且内存态 accessToken 已不是
    /// 发请求用的那张（并发刷新恰好完成并清了槽），直接复用新凭据——补上
    /// 「完成方清槽之后、迟到 401 处理者登记之前」的窗口，绝不因此多发第二
    /// 次刷新。新凭据必已落盘（doRefresh 先 save 再写内存态，红线 3）。
    func refreshAfter401(usedToken: String) async throws -> StoredAuth {
        try await refreshInner(staleToken: usedToken).get()
    }

    private func refreshInner(staleToken: String?) async -> Result<StoredAuth, AuthError> {
        let generation: UInt64
        let shared: Task<Result<StoredAuth, AuthError>, Never>
        if let existing = inflight {
            // ① 在途：共享同一句柄（不消费），等同一结果。
            generation = existing.generation
            shared = existing.task
        } else {
            // ② 空槽。401 路径先比票：票已换新说明刚有并发刷新完成，
            //    迟到的 401 搭车新凭据即可，绝不发第二次刷新。
            if let used = staleToken, let current = state, current.accessToken != used {
                return .success(current)
            }
            // ③ 空槽且票未换：本调用者发起。detached 任务经 actor 方法
            //    performRefresh 执行；调用方随即挂起在 shared.value 上，
            //    actor 让出，任务得以推进（actor 在挂起点可重入）。
            generation = nextGeneration
            nextGeneration &+= 1
            let task = Task.detached(priority: .userInitiated) {
                await self.performRefresh()
            }
            inflight = (generation, task)
            shared = task
        }
        let outcome = await shared.value
        // ④ 完成方清槽：仅当槽内仍是本代数（新一代刷新不受影响）。
        if let current = inflight, current.generation == generation {
            inflight = nil
        }
        return outcome
    }

    /// 真正的刷新（每个在途任务至多执行一次）。红线 3：先落盘再更新内存态。
    private func performRefresh() async -> Result<StoredAuth, AuthError> {
        let refreshToken: String?
        if let current = state {
            refreshToken = current.refreshToken
        } else {
            refreshToken = store.load()?.refreshToken
        }
        guard let refreshToken else {
            return .failure(AuthError.local("unauthorized", "未登录"))
        }
        let body = "{\"refreshToken\":\(escapeJSONString(refreshToken))}"
        do {
            let response = try await transport.send(
                AuthHttpRequest(method: "POST", path: "/v1/auth/refresh", body: body, bearer: nil)
            )
            if response.status == 200 {
                let pair: LoginResponse
                do {
                    pair = try parseLoginResponse(response.body)
                } catch let error as AuthError {
                    return .failure(error)
                } catch {
                    return .failure(AuthError.local("parse_error", "解析刷新响应失败"))
                }
                let stored = StoredAuth(
                    accessToken: pair.accessToken,
                    refreshToken: pair.refreshToken,
                    accessExpiresAt: now() + pair.expiresIn,
                    user: pair.user
                )
                // 红线 3：先落盘（Keychain），再更新内存态/供重放。
                do {
                    try store.save(stored)
                } catch let error as AuthError {
                    return .failure(error)
                } catch {
                    return .failure(AuthError.local("storage_error", "写入本地凭据失败: \(error.localizedDescription)"))
                }
                state = stored
                return .success(stored)
            } else if response.status == 401 {
                let error = errorFromResponse(response)
                // fatal 三码 → 清凭据（红线 4/5）；其余 401 原样透传。
                if isFatalAuthCode(error.code) {
                    await clearCredentials(notice: noticeForAuthCode(error.code))
                }
                return .failure(error)
            } else {
                return .failure(errorFromResponse(response))
            }
        } catch let error as AuthError {
            // 网络等瞬时错误：不清凭据（§4.4 离线契约）。
            return .failure(error)
        } catch {
            return .failure(AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)"))
        }
    }

    /// 清凭据：store.clear 尽力（失败仅日志——凭据已被服务端作废，残留无
    /// 增量风险）+ 内存态清空 + 记 notice。
    private func clearCredentials(notice newNotice: AuthNotice?) async {
        do {
            try store.clear()
        } catch {
            DiagnosticLogger.log("auth.clear.failed（凭据已被服务端作废）: \(error)")
        }
        state = nil
        notice = newNotice
    }

    // ------------------------------------------------------------------
    // 取票与带鉴权请求
    // ------------------------------------------------------------------

    /// 取可用 accessToken：无凭据报未登录；剩余寿命 ≤ 180s 时先走一次单飞刷新
    /// （D6 绝对阈值）。主动刷新失败时：致命码上抛（凭据已清），瞬时错误用旧
    /// 票继续——401 token_expired 兜底永在（R4）。
    func getAccessToken() async throws -> String {
        if state == nil {
            state = store.load()
        }
        guard let current = state else {
            throw AuthError.local("unauthorized", "未登录")
        }
        let token = current.accessToken
        let expiresAt = current.accessExpiresAt
        if now() + authRefreshMarginSeconds >= expiresAt {
            do {
                let fresh = try await refresh()
                return fresh.accessToken
            } catch let error as AuthError where isFatalAuthCode(error.code) {
                throw error
            } catch {
                // 瞬时错误：旧票继续
            }
        }
        return token
    }

    /// 带鉴权请求（§4.3，红线 4）：惰性主动刷新 → 发送 → 401 分支。
    func withAuth(method: String, path: String, body: String?) async throws -> AuthHttpResponse {
        let token = try await getAccessToken()
        func send(bearer: String) async throws -> AuthHttpResponse {
            try await transport.send(
                AuthHttpRequest(method: method, path: path, body: body, bearer: bearer)
            )
        }
        let first: AuthHttpResponse
        do {
            first = try await send(bearer: token)
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)")
        }
        if first.status != 401 {
            return first
        }
        let error = errorFromResponse(first)
        switch error.code {
        case "token_expired":
            // 仅 token_expired 触发刷新（红线 4）；带旧票进单飞，迟到 401
            // 若逢并发刷新已完成则直接复用新凭据（红线 2 单飞无窗口）。
            let stored: StoredAuth
            do {
                stored = try await refreshAfter401(usedToken: token)
            } catch let refreshError as AuthError {
                throw refreshError
            } catch {
                throw AuthError.local("unknown", "刷新失败")
            }
            let replay = try await send(bearer: stored.accessToken)
            if replay.status == 401 {
                // 重放仍 401：会话已死，清凭据并按新 code 处理
                let replayError = errorFromResponse(replay)
                await clearCredentials(notice: noticeForAuthCode(replayError.code))
                throw replayError
            }
            return replay
        case "token_invalid", "token_reused", "unauthorized":
            // invalid/reused/unauthorized：清凭据，绝不再刷（红线 4）
            await clearCredentials(notice: noticeForAuthCode(error.code))
            throw error
        default:
            // 未知 401 code：原样透传，不清凭据不刷新
            throw error
        }
    }

    // ------------------------------------------------------------------
    // 登录 / 登出 / 状态
    // ------------------------------------------------------------------

    /// POST /v1/auth/otp/request（§7-1）。服务端恒 200（防枚举），不据此判断账号存在。
    func sendOTP(email: String) async throws {
        let response: AuthHttpResponse
        do {
            response = try await transport.send(
                AuthHttpRequest(
                    method: "POST",
                    path: "/v1/auth/otp/request",
                    body: "{\"email\":\(escapeJSONString(email))}",
                    bearer: nil
                )
            )
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)")
        }
        if (200..<300).contains(response.status) {
            return
        }
        throw errorFromResponse(response)
    }

    /// POST /v1/auth/otp/verify（§7-2）。device 由原生层填，调用方不传。
    func verifyOTP(email: String, code: String) async throws -> AuthUser {
        let body = """
        {"email":\(escapeJSONString(email)),"code":\(escapeJSONString(code)),"device":\(devicePayloadJSON())}
        """
        return try await loginCommon(path: "/v1/auth/otp/verify", body: body)
    }

    /// POST /v1/auth/login（§7-3）。device 同上。
    func loginPassword(email: String, password: String) async throws -> AuthUser {
        let body = """
        {"email":\(escapeJSONString(email)),"password":\(escapeJSONString(password)),"device":\(devicePayloadJSON())}
        """
        return try await loginCommon(path: "/v1/auth/login", body: body)
    }

    /// 登录成功路径（两条登录命令共用）：先 store.save 落盘（红线 1/3，落不了
    /// 盘不允许「登录成功」，§3 storage_error）→ 更新内存态 → 清 notice。
    private func loginCommon(path: String, body: String) async throws -> AuthUser {
        let response: AuthHttpResponse
        do {
            response = try await transport.send(
                AuthHttpRequest(method: "POST", path: path, body: body, bearer: nil)
            )
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)")
        }
        guard (200..<300).contains(response.status) else {
            throw errorFromResponse(response)
        }
        let pair: LoginResponse
        do {
            pair = try parseLoginResponse(response.body)
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("parse_error", "解析登录响应失败")
        }
        let user = pair.user
        let stored = StoredAuth(
            accessToken: pair.accessToken,
            refreshToken: pair.refreshToken,
            accessExpiresAt: now() + pair.expiresIn,
            user: user
        )
        do {
            try store.save(stored)
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.local("storage_error", "写入本地凭据失败: \(error.localizedDescription)")
        }
        state = stored
        // 登录成功即清除 notice（D8）
        notice = nil
        return user
    }

    /// 登出（§7-4/§5.3）：服务端吊销尽力（失败吞为 serverRevoked:false）→
    /// store.clear() 失败重试一次，仍失败返回 storage_error 且保持登录态；
    /// clear 成功才清内存态。幂等可重入（未登录直接成功）。
    func logout() async throws -> LogoutOutcome {
        var access: String?
        if state == nil {
            state = store.load()
        }
        access = state?.accessToken
        guard let accessToken = access else {
            return LogoutOutcome(serverRevoked: false)
        }
        var revoked = false
        do {
            let response = try await transport.send(
                AuthHttpRequest(method: "POST", path: "/v1/auth/logout", body: nil, bearer: accessToken)
            )
            revoked = (200..<300).contains(response.status)
        } catch {
            // 服务端错误（含网络失败）尽力而为：本地照常清理
            revoked = false
        }
        do {
            try store.clear()
        } catch {
            do {
                try store.clear()
            } catch {
                throw AuthError.local("storage_error", "清除本地凭据失败（已重试）: \(error.localizedDescription)")
            }
        }
        state = nil
        notice = nil
        return LogoutOutcome(serverRevoked: revoked)
    }

    /// 登录态判据全程序唯一（§4.4）：内存态优先，空则回读 store 并预填。
    func getStatus() -> AuthStatus {
        if state == nil {
            state = store.load()
        }
        return AuthStatus(loggedIn: state != nil, user: state?.user, notice: notice)
    }

    /// 启动预填（§4.4 ①）：磁盘有 30 天 refresh 即视为已登录（离线也显示
    /// 已登录），返回 user 供调用方先广播、再异步校验存活。
    func prefillFromStore() -> AuthUser? {
        if state == nil {
            state = store.load()
        }
        return state?.user
    }

    // ------------------------------------------------------------------
    // 带鉴权的资料读取
    // ------------------------------------------------------------------

    /// GET /v1/me（§7-7，带鉴权请求样板：可触发单飞刷新与重放）。
    func fetchMe() async throws -> AuthUser {
        let response = try await withAuth(method: "GET", path: "/v1/me", body: nil)
        guard (200..<300).contains(response.status) else {
            throw errorFromResponse(response)
        }
        guard let data = response.body.data(using: .utf8),
              let user = try? JSONDecoder().decode(AuthUser.self, from: data) else {
            throw AuthError.local("parse_error", "解析用户资料失败")
        }
        return user
    }

    /// GET /v1/me/config（§7-8）：原样取回 JSON 对象，不在本层解析消费。
    func fetchServerConfig() async throws -> Any {
        let response = try await withAuth(method: "GET", path: "/v1/me/config", body: nil)
        guard (200..<300).contains(response.status) else {
            throw errorFromResponse(response)
        }
        guard let data = response.body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            throw AuthError.local("parse_error", "解析 me/config 失败")
        }
        return object
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    /// §7-2：device 由原生层填 `{platform:"macos", name: 设备名截 64 字符,
    /// fallback "Mac"}`，前端/调用方不传（对齐 Windows device_payload）。
    private func devicePayloadJSON() -> String {
        let raw = deviceName().trimmingCharacters(in: .whitespacesAndNewlines)
        let base = raw.isEmpty ? "Mac" : raw
        let name = String(base.prefix(64))
        return "{\"platform\":\"macos\",\"name\":\(escapeJSONString(name))}"
    }
}

/// 手写 JSON 字符串转义（构造小请求体时免整段 Encoder）。
/// 用单元素数组编码取掉方括号，保证转义与 JSONEncoder 完全一致。
func escapeJSONString(_ value: String) -> String {
    if let data = try? JSONEncoder().encode([value]),
       let text = String(data: data, encoding: .utf8) {
        return String(text.dropFirst().dropLast())
    }
    return "\"" + value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

// ---------------------------------------------------------------------------
// 错误码 → 用户文案的唯一映射
// （对齐 Windows src/lib/authErrorText.ts §3：只按 code 分支，绝不匹配服务端
// message；呈现 kind ∈ inline（表单内红条）/ statusbar（账号区顶部 warn 状态
// 条）/ silent（用户不可见，管理器自动处理）；无全局 toast（设计 D8）。）
// ---------------------------------------------------------------------------

enum AuthErrorTextKind {
    case inline
    case statusbar
    case silent
}

struct AuthErrorTextResult: Equatable {
    /// 用户可见的中文文案（Windows §3 表逐字）。
    let text: String
    /// 呈现位置。
    let kind: AuthErrorTextKind
    /// 归一化后的 code（未知 code 归为 "unknown"）。
    let code: String
}

/// 未知 / 解析失败等服务端或本地兜底文案。
private let authErrorFallbackText = "服务响应异常，请稍后再试"

/// §3 映射表：code → 固定文案与呈现（rate_limited 单独插值）。
private let authErrorTextTable: [String: (text: String, kind: AuthErrorTextKind)] = [
    "otp_invalid": ("验证码错误或已过期，请重新获取", .inline),
    "invalid_credentials": ("邮箱或密码不正确；若从未设置密码，请改用验证码登录", .inline),
    // MVP 无注册入口，映射预留（§3：email_taken 不可达）。
    "email_taken": ("该邮箱已注册，请直接登录", .inline),
    "banned": ("该账号已被封禁，如有疑问请联系支持", .inline),
    // silent：管理器单飞刷新后重放一次，用户不可见。
    "token_expired": ("登录已过期，正在自动续期", .silent),
    "token_invalid": ("登录已失效，请重新登录", .statusbar),
    "token_reused": ("检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录", .statusbar),
    "validation_error": ("请求参数异常，请更新应用后重试；若持续出现请反馈", .inline),
    "service_unavailable": ("邮件服务暂时不可用，请稍后再试", .inline),
    // 以下为原生层生成的本地伪码（§3 末三行）。
    "network_error": ("网络连接失败，请检查网络后重试", .inline),
    "storage_error": ("本地安全存储读写失败，请重试或反馈", .inline),
    "parse_error": (authErrorFallbackText, .inline),
    "unknown": (authErrorFallbackText, .inline),
]

/// 错误码 → { text, kind }。任何未知 code 都安全落到 unknown 文案（inline），
/// 服务端 message 永不进入返回值。
func authErrorText(_ error: AuthError) -> AuthErrorTextResult {
    var code = error.code.isEmpty ? "unknown" : error.code
    // §3 第77行：unauthorized 同 token_invalid 文案与动作——连同归一化后的
    // code 一并归一。
    if code == "unauthorized" { code = "token_invalid" }
    if code == "rate_limited" {
        let secs = error.retryAfterSeconds
        let text = (secs != nil && secs! > 0)
            ? "操作过于频繁，请 \(secs!) 秒后再试"
            : "操作过于频繁，请稍后再试"
        return AuthErrorTextResult(text: text, kind: .inline, code: code)
    }
    if let entry = authErrorTextTable[code] {
        return AuthErrorTextResult(text: entry.text, kind: entry.kind, code: code)
    }
    return AuthErrorTextResult(text: authErrorFallbackText, kind: .inline, code: "unknown")
}

/// 账号区顶部失效状态条文案（AuthStatus.notice，设计 D8）。
/// session_expired ← token_invalid；session_kicked ← token_reused（§3 表）。
func authNoticeText(_ notice: AuthNotice?) -> String? {
    switch notice {
    case .sessionExpired: return "登录已失效，请重新登录"
    case .sessionKicked: return "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录"
    case nil: return nil
    }
}

// ---------------------------------------------------------------------------
// 验证码重发 60s 倒计时（Windows src/lib/useResendCooldown.ts D3/D10/P14 的
// macOS 对应物：按邮箱持久化到 UserDefaults，关窗重开恢复剩余）。
// ---------------------------------------------------------------------------

/// 冷却时长（秒），与服务端同邮箱发信冷却对齐。
enum OtpCooldown {
    static let cooldownSeconds = 60
    static let storageKey = "immersive-auth-otp-last-sent"
    /// 每邮箱时间戳映射最多保留条数（防无限增长）。
    static let maxEmails = 10

    typealias LastSentMap = [String: Double]

    /// 宽松解析持久化映射：坏 JSON / 非法条目全部丢弃。
    static func parseMap(_ raw: String?) -> LastSentMap {
        guard let raw, let data = raw.data(using: .utf8) else { return [:] }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        var map: LastSentMap = [:]
        for (key, value) in object {
            if let number = value as? Double, number.isFinite, number > 0 {
                map[key] = number
            } else if let number = value as? Int, number > 0 {
                map[key] = Double(number)
            }
        }
        return map
    }

    /// 剩余冷却秒数（0...cooldownSeconds），向上取整保证 UI 显示不早归零。
    static func remainingSeconds(_ map: LastSentMap, email: String, nowMs: Double) -> Int {
        guard let sentAt = map[email] else { return 0 }
        let elapsedSec = (nowMs - sentAt) / 1000
        guard elapsedSec.isFinite, elapsedSec < Double(cooldownSeconds) else { return 0 }
        return min(cooldownSeconds, max(1, Int((Double(cooldownSeconds) - elapsedSec).rounded(.up))))
    }

    /// 记录一次发送并持久化（更新该邮箱时间戳，按最近使用截断）。
    /// 写失败静默忽略：倒计时退化为本次会话内有效。
    @discardableResult
    static func write(
        email: String,
        sentAtMs: Double,
        storage: OtpCooldownStorage
    ) -> LastSentMap {
        var next = parseMap(storage.readString(forKey: storageKey))
        next[email] = sentAtMs
        let trimmed = next
            .sorted { $0.value > $1.value }
            .prefix(maxEmails)
        if let data = try? JSONSerialization.data(withJSONObject: Dictionary(uniqueKeysWithValues: trimmed.map { ($0.key, $0.value) })),
           let text = String(data: data, encoding: .utf8) {
            storage.writeString(text, forKey: storageKey)
        }
        return Dictionary(uniqueKeysWithValues: trimmed.map { ($0.key, $0.value) })
    }
}

/// 可注入存储（生产 UserDefaults；单测内存字典）。方法名刻意避开
/// UserDefaults 自带的 set(_:forKey:)（其形参为 Any?，无法直接满足协议）。
protocol OtpCooldownStorage {
    func readString(forKey key: String) -> String?
    func writeString(_ value: String, forKey key: String)
}

extension UserDefaults: OtpCooldownStorage {
    func readString(forKey key: String) -> String? {
        string(forKey: key)
    }

    func writeString(_ value: String, forKey key: String) {
        set(value as Any?, forKey: key)
    }
}

/// 登录窗使用的冷却追踪器：读取剩余 / 记录发送。
struct OtpCooldownTracker {
    let storage: OtpCooldownStorage
    let nowMs: () -> Double

    init(storage: OtpCooldownStorage, nowMs: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.storage = storage
        self.nowMs = nowMs
    }

    /// 剩余秒数；>0 时「重新发送」应禁用并显示秒数。
    func remaining(email: String) -> Int {
        OtpCooldown.remainingSeconds(OtpCooldown.parseMap(storage.readString(forKey: OtpCooldown.storageKey)), email: email, nowMs: nowMs())
    }

    /// 发送成功后调用：记录时间戳（倒计时由下次 remaining 读取置满）。
    func markSent(email: String) {
        OtpCooldown.write(email: email, sentAtMs: nowMs(), storage: storage)
    }
}

// ---------------------------------------------------------------------------
// ServerAuthClient：应用层门面（Windows 命令层 lib.rs auth_* 的对应物）。
// 持有 AuthTokenManager，把登录/登出/失效转成 @Published 状态供设置 chip、
// 菜单分流、账号分区订阅（事件驱动更新，对齐 auth-state-changed）。
// 接线：AppDelegate.serverAuth 持有唯一实例，applicationDidFinishLaunching
// 调 bootstrap()（App.swift）；Settings.swift 的 SettingsView 以 @ObservedObject
// 订阅 status。
// ---------------------------------------------------------------------------

@MainActor
final class ServerAuthClient: ObservableObject {
    @Published private(set) var status = AuthStatus.loggedOut

    let manager: AuthTokenManager
    private let appSupportDirectory: URL

    /// 生产构造：URLSession 传输（base_url 支持 server_endpoint.json 覆盖）
    /// + Keychain 单槽存储。
    convenience init(appSupportDirectory: URL? = nil) {
        let directory = appSupportDirectory ?? ServerAuthConfiguration.defaultAppSupportDirectory()
        self.init(
            manager: AuthTokenManager(
                transport: URLSessionAuthTransport(baseURL: ServerAuthConfiguration.resolveBaseURL(appSupportDirectory: directory)),
                store: KeychainAuthTokenStore()
            ),
            appSupportDirectory: directory
        )
    }

    init(manager: AuthTokenManager, appSupportDirectory: URL? = nil) {
        self.manager = manager
        self.appSupportDirectory = appSupportDirectory ?? ServerAuthConfiguration.defaultAppSupportDirectory()
    }

    /// 启动静默续登录（§4.4，对应 Windows auth_bootstrap）：预填内存态 →
    /// 广播已登录（离线也显示已登录）→ 后台单飞刷新校验存活；fatal 才转
    /// 未登录；网络等瞬时错误保留预填态，不回退 UI（§4.4 ③）。
    func bootstrap() {
        Task { [weak self] in
            guard let self else { return }
            guard let user = await self.manager.prefillFromStore() else { return }
            self.publish(AuthStatus(loggedIn: true, user: user, notice: nil))
            do {
                let stored = try await self.manager.refresh()
                self.publish(AuthStatus(loggedIn: true, user: stored.user, notice: nil))
            } catch let error as AuthError where isFatalAuthCode(error.code) {
                // 凭据已清；广播失效态（D8 状态条载体）
                let snapshot = await self.manager.getStatus()
                self.publish(AuthStatus(
                    loggedIn: false,
                    user: nil,
                    notice: snapshot.notice ?? noticeForAuthCode(error.code)
                ))
            } catch {
                // 网络等瞬时错误：保留预填态
            }
        }
    }

    func sendOTP(email: String) async throws {
        try await manager.sendOTP(email: email)
    }

    /// 验证码登录：成功即广播登录态 + fire-and-forget 拉取 me/config（D7：
    /// 失败仅日志，账号区可手动重拉）。
    @discardableResult
    func verifyOTP(email: String, code: String) async throws -> AuthUser {
        let user = try await manager.verifyOTP(email: email, code: code)
        afterLoginSuccess(user)
        return user
    }

    /// 密码登录：同上收尾。
    @discardableResult
    func loginPassword(email: String, password: String) async throws -> AuthUser {
        let user = try await manager.loginPassword(email: email, password: password)
        afterLoginSuccess(user)
        return user
    }

    /// 登出：本地清理成功（走到这里 clear 必已成功，§5.3：失败路径直接抛
    /// storage_error，不广播登出）→ 广播未登录。
    @discardableResult
    func logout() async throws -> LogoutOutcome {
        let outcome = try await manager.logout()
        publish(.loggedOut)
        return outcome
    }

    /// 手动刷新（设置「账号」区重拉）：成功广播登录态；fatal 广播失效态。
    @discardableResult
    func refreshNow() async throws -> AuthUser {
        do {
            let stored = try await manager.refresh()
            publish(AuthStatus(loggedIn: true, user: stored.user, notice: nil))
            return stored.user
        } catch let error as AuthError {
            emitFatalIfNeeded(error)
            throw error
        } catch {
            throw AuthError.local("unknown", "刷新失败")
        }
    }

    /// GET /v1/me：fatal 时广播失效态（对应 Windows auth_fetch_me 收尾）。
    @discardableResult
    func fetchMe() async throws -> AuthUser {
        do {
            return try await manager.fetchMe()
        } catch let error as AuthError {
            emitFatalIfNeeded(error)
            throw error
        } catch {
            throw AuthError.local("unknown", "获取账号资料失败")
        }
    }

    /// GET /v1/me/config + 落盘 server_config.json（明文，非敏感；v0.9 账号
    /// 区「云端配置重拉」用）。fatal 时广播失效态。
    @discardableResult
    func fetchServerConfig() async throws -> Any {
        do {
            let value = try await manager.fetchServerConfig()
            persistServerConfig(value)
            return value
        } catch let error as AuthError {
            emitFatalIfNeeded(error)
            throw error
        } catch {
            throw AuthError.local("unknown", "获取云端配置失败")
        }
    }

    // ------------------------------------------------------------------

    private func publish(_ next: AuthStatus) {
        status = next
    }

    /// 登录成功命令的公共收尾：广播登录态 + fire-and-forget 拉取并落盘
    /// me/config（D7：失败仅日志，账号区可手动重拉）。
    private func afterLoginSuccess(_ user: AuthUser) {
        publish(AuthStatus(loggedIn: true, user: user, notice: nil))
        Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await self.manager.fetchServerConfig()
                self.persistServerConfig(value)
            } catch {
                DiagnosticLogger.log("auth.config.fetch.failed（不阻塞登录）: \(error)")
            }
        }
    }

    private func persistServerConfig(_ value: Any) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
            try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
            try data.write(to: appSupportDirectory.appendingPathComponent(ServerAuthConfiguration.serverConfigFileName), options: .atomic)
        } catch {
            DiagnosticLogger.log("auth.config.persist.failed: \(error)")
        }
    }

    /// 致命错误（凭据已清）时广播失效态，账号区状态条据此显示（D8）。
    private func emitFatalIfNeeded(_ error: AuthError) {
        if let notice = noticeForAuthCode(error.code) {
            publish(AuthStatus(loggedIn: false, user: nil, notice: notice))
        }
    }
}
