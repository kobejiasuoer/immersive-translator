import Foundation
import ReaderCore

/// 公版书发现目录（升级计划 B2，计划书 §3/§6）：GET /v1/books 目录浏览 +
/// GET /v1/books/{id}/download 镜像下载，供阅读室「发现」页选书导入
/// （下载的 EPUB 字节喂给 parseEpub 走既有导入管线）。对齐 Windows
/// src-tauri/src/discover.rs 命令层（Tauri 两命令在 Mac 单进程里合并为本服务）。
///
/// - 鉴权口径（对 withAuth 的有意偏离）：两端点服务端匿名只读。withAuth 会先取票、
///   未登录零网络即 unauthorized，照抄等于把匿名端点变成强制登录。改用可选鉴权：
///   取到票就带 Bearer（token 仅限流配额加成），取不到走匿名；不做 401 刷新重放。
///   未登录 = 发现页完整可用（不隐藏/不置灰/不提示登录）。
/// - 非 2xx 是数据不是错误：目录复用 AuthHttpResponse（同构 Windows SyncHttpText）原样
///   透传；下载用 BooksDownloadResult——200 的 data 是 EPUB 字节，其余状态的 body 是
///   服务端 AppError 错误信封 JSON 文本（服务端先判 status 再分流，非 2xx 不回二进制）。
///   只有网络失败/沉浸云未开放才 throw（AuthError），由视图层给中文原因。
/// - 字节形态（Windows 案A 的 Mac 对应物）：同进程直接传 Data，无 base64 跨 IPC；
///   不落盘；完整性由 verifyEpubSha256 + parseEpub 损坏检测双保险。
/// - base URL：ServerAuthConfiguration.resolveBaseURL()（server_endpoint.json 两层机制，
///   与 Windows auth.rs resolve_base_url 同源契约）；Mac 无 platform_available 灭灯开关，
///   platform_unavailable 仅在请求构造失败时可达。

/// 下载进度（对齐 tauriBridge.ts BooksDownloadProgress；total=0 表示响应无 content-length）。
struct BooksDownloadProgress: Equatable {
    let bookId: String
    let received: Int64
    let total: Int64
}

/// 一次 /v1/books/{id}/download 请求的结果（字段语义对齐 Rust BooksDownloadResult，
/// 按 `status` 分叉：200 = data 为 EPUB 字节、body 空串；其余 = body 为服务端 AppError
/// 错误信封 JSON 文本、data 为空（本地预校验不合法时也是同款信封、status=400，不发网络）。
struct BooksDownloadResult: Equatable {
    let status: Int
    let retryAfterSeconds: Int?
    let data: Data
    let body: String
}

final class DiscoverService {
    /// 目录请求超时（小 JSON 应答，对齐 auth 传输层 30s）。
    static let listTimeoutSeconds: TimeInterval = 30
    /// 下载超时（单本最大 18.4MB 的慢网余量，对齐 ocr.rs 模型下载 300s）。
    static let downloadTimeoutSeconds: TimeInterval = 300

    /// 外部依赖（生产走 ServerAuthConfiguration + ServerAuthClient.manager；测试注入）。
    struct Dependencies {
        /// 书库 API base（不含尾斜杠）。
        var baseURL: () -> String
        /// 取登录令牌；未登录/取票瞬时失败 throw → 本服务静默走匿名。
        var accessToken: () async throws -> String

        /// 未接线（启动早期/单测）：匿名口径。
        static let anonymous = Dependencies(
            baseURL: { ServerAuthConfiguration.resolveBaseURL() },
            accessToken: { throw AuthError.local("unauthorized", "未登录") }
        )
    }

    static let shared = DiscoverService()

    private var deps: Dependencies
    private let listSession: URLSession
    private let downloadSession: URLSession

    /// 产品 UA（照 ocr.rs 模型下载——部分下载服务拒绝无 UA 请求）：
    /// `ImmersiveTranslator/{CFBundleShortVersionString}`。
    static let userAgent: String = {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        return "ImmersiveTranslator/\(version)"
    }()

    private static func makeSession(timeout: TimeInterval) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.httpAdditionalHeaders = ["User-Agent": userAgent]
        return URLSession(configuration: config)
    }

    init(dependencies: Dependencies = .anonymous) {
        deps = dependencies
        listSession = Self.makeSession(timeout: Self.listTimeoutSeconds)
        downloadSession = Self.makeSession(timeout: Self.downloadTimeoutSeconds)
    }

    /// 启动接线（AppDelegate.applicationDidFinishLaunching）：可选 Bearer 取自
    /// ServerAuthClient.manager.getAccessToken（未登录 throw → 匿名）。
    @MainActor
    func configure(serverAuth: ServerAuthClient) {
        let manager = serverAuth.manager
        deps = Dependencies(
            baseURL: { ServerAuthConfiguration.resolveBaseURL() },
            accessToken: { try await manager.getAccessToken() }
        )
    }

    /// 测试接线。
    func configure(_ dependencies: Dependencies) {
        deps = dependencies
    }

    // MARK: - 请求构造

    private func apiBase() -> String {
        deps.baseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// 可选鉴权：取到登录令牌就带 Bearer（限流配额加成），取不到（未登录/取票瞬时失败）
    /// 走匿名——端点匿名可读，绝不能因取票失败而拒绝请求。不做 401 刷新重放。
    private func withOptionalBearer(_ request: inout URLRequest) async {
        if let token = try? await deps.accessToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private static func retryAfter(of response: URLResponse) -> Int? {
        parseRetryAfter((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"))
    }

    // MARK: - GET /v1/books（公版书目录，匿名只读）

    /// 非 2xx 是数据不是错误：原样透传 `{status, body, retryAfterSeconds}`（400 参数非法 /
    /// 404 空结果等由视图按状态给中文文案）；只有网络失败/沉浸云未开放才 throw。
    func booksList(
        q: String? = nil,
        language: String? = nil,
        category: String? = nil,
        source: String? = nil,
        grade: String? = nil,
        page: Int? = nil,
        perPage: Int? = nil
    ) async throws -> AuthHttpResponse {
        guard var components = URLComponents(string: "\(apiBase())/v1/books") else {
            throw AuthError.local("platform_unavailable", "书库服务暂未开放")
        }
        components.queryItems = buildBooksQueryItems(
            q: q, language: language, category: category, source: source, grade: grade, page: page, perPage: perPage
        )
        guard let url = components.url else {
            throw AuthError.local("platform_unavailable", "书库服务暂未开放")
        }
        var request = URLRequest(url: url)
        await withOptionalBearer(&request)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await listSession.data(for: request)
        } catch {
            throw AuthError.local("network_error", "网络请求失败: \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return AuthHttpResponse(
            status: status,
            retryAfterSeconds: Self.retryAfter(of: response),
            body: String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        )
    }

    // MARK: - GET /v1/books/{id}/download（镜像 EPUB，匿名可读）

    /// 先判 status 再分流：200 流式收字节（每满 256KB 回调一次进度、收完补发终值）
    /// 后以 Data 返回；非 200 的 body 是 AppError 错误信封 JSON 文本，原样透传由视图
    /// 按状态给中文文案（404 统一口径「当前不可下载」）。id 本地预校验不合式时不发网络，
    /// 直接以同款信封返回 status=400（400 也是数据不是 throw）。
    func booksDownload(
        bookId: String,
        onProgress: @escaping (BooksDownloadProgress) -> Void
    ) async throws -> BooksDownloadResult {
        if !validateBookId(bookId) {
            return BooksDownloadResult(
                status: 400,
                retryAfterSeconds: nil,
                data: Data(),
                body: #"{"error":{"code":"validation_error","message":"书目 id 不合法"}}"#
            )
        }
        guard let url = URL(string: "\(apiBase())/v1/books/\(bookId)/download") else {
            throw AuthError.local("platform_unavailable", "书库服务暂未开放")
        }
        var request = URLRequest(url: url)
        await withOptionalBearer(&request)
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await downloadSession.bytes(for: request)
        } catch {
            throw AuthError.local("network_error", "下载失败: \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let retryAfterSeconds = Self.retryAfter(of: response)
        if status != 200 {
            // 服务端非 2xx 的 body 是 JSON 错误信封不是二进制，按文本透传
            var raw = Data()
            do {
                for try await byte in bytes { raw.append(byte) }
            } catch {
                throw AuthError.local("network_error", "下载失败: \(error.localizedDescription)")
            }
            return BooksDownloadResult(
                status: status,
                retryAfterSeconds: retryAfterSeconds,
                data: Data(),
                body: String(data: raw, encoding: .utf8) ?? String(decoding: raw, as: UTF8.self)
            )
        }

        // 200：流式收字节（total=0 表示响应无 content-length，视图按未知总量处理）
        let total: Int64 = max(0, response.expectedContentLength)
        var data = Data()
        if total > 0 { data.reserveCapacity(Int(total)) }
        var lastEmitted: Int64 = 0
        var received: Int64 = 0
        do {
            for try await byte in bytes {
                data.append(byte)
                received += 1
                if shouldEmitProgress(lastEmitted: lastEmitted, received: received) {
                    onProgress(BooksDownloadProgress(bookId: bookId, received: received, total: total))
                    lastEmitted = received
                }
            }
        } catch {
            throw AuthError.local("network_error", "下载失败: \(error.localizedDescription)")
        }
        // 收完补发终值：保证视图至少收到一次最终字节数（received==total 判完成）
        onProgress(BooksDownloadProgress(bookId: bookId, received: received, total: total))
        return BooksDownloadResult(status: 200, retryAfterSeconds: nil, data: data, body: "")
    }
}

/// 请求 throw（AuthError）文案（errorDesign 1/2/8，对齐 discoverCatalog.ts
/// discoverInvokeErrorText）：platform_unavailable 专属文案不进 authErrorText 全局表；
/// 其余（network_error/unknown 等）由 authErrorText 兜底（network_error →
/// 「网络连接失败，请检查网络后重试」）。非 AuthError 的异常按 unknown 归一。
func discoverInvokeErrorText(_ error: Error) -> String {
    if let auth = error as? AuthError {
        if auth.code == "platform_unavailable" { return discoverPlatformUnavailableText }
        return authErrorText(auth).text
    }
    return authErrorText(AuthError.local("unknown", error.localizedDescription)).text
}
