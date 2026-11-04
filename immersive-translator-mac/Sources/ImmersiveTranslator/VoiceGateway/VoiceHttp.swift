import Foundation

// ---------------------------------------------------------------------------
// 语音网关 HTTP/WS 公共层（对齐 Windows src/lib/voice/voiceHttp.ts + voiceRuntime.ts
// + Rust src-tauri/src/voice.rs 的白名单校验）：
// - Mac 单进程无 IPC：传输在主进程内直接依赖鉴权管理器（AuthTokenManager.withAuth
//   的应用门面 ServerAuthClient.authorizedRequest），令牌不出进程（红线 D4/D5 的
//   Mac 等效物）；Rust 命令层的 method/path 白名单在本地同规则复刻。
// - 协议：错误信封 {error:{code,message,details?}}（契约 §一/§二）；
//   402 额外带 x-quota-<resource>-remaining 响应头（details 之外唯一可得字段，
//   传输层白名单只透传 x-quota-*，其余头一律不透传）。
// ---------------------------------------------------------------------------

/// 一次语音网关 REST 请求的原始应答（复用 ServerAuth 的应答形状：
/// status/body/retryAfterSeconds/headers，headers 只含 x-quota-* 白名单头）。
typealias VoiceHttpResponse = AuthHttpResponse

/// method+path+JSON body 进、原始应答出；401 单飞刷新/重放在鉴权管理器内完成。
typealias VoiceHttpTransport = (_ method: String, _ path: String, _ body: String?) async throws -> VoiceHttpResponse

/// WSS 一次性握手票来源（生产 = VoiceTicket.fetchVoiceTicket；测试注入）。
typealias VoiceTicketFetcher = () async throws -> String

// MARK: - WebSocket 最小接口（对齐 Windows WsLike；生产 URLSessionWebSocketTask，测试注入替身）

enum VoiceWsMessage {
    case text(String)
    case data(Data)
}

protocol VoiceWebSocket: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onMessage: ((VoiceWsMessage) -> Void)? { get set }
    /// (code, reason)；code 1006 语义 = 意外断开（未走 close 握手）。
    var onClose: ((_ code: Int, _ reason: String) -> Void)? { get set }
    var onError: (() -> Void)? { get set }
    /// 0=connecting 1=open 2=closing 3=closed（浏览器 readyState 同口径）。
    var readyState: Int { get }
    /// 开始建连（生产包装层在构造后调起；浏览器模型里构造即连）。
    func open()
    func sendText(_ text: String)
    func sendData(_ data: Data)
    func close(code: Int, reason: String)
}

// MARK: - 运行时依赖注入（对齐 Windows voiceRuntime.setVoiceRuntime）

/// 语音网关运行时依赖：生产由应用启动时接线（AppDelegate 唯一调用点）；
/// 未接线前 REST/换票/能力调用抛编程错误（对齐 Windows「未接线抛编程错误」）。
final class VoiceGatewayRuntime {
    static let shared = VoiceGatewayRuntime()

    private(set) var http: VoiceHttpTransport?
    private(set) var wsFactory: ((String) -> VoiceWebSocket)?
    /// 网关 base URL 来源（默认 ServerAuthConfiguration.resolveBaseURL；
    /// Mac 无「官方云未开放」null 态，见规格 §四差异 7）。
    private(set) var baseUrlSource: () -> String? = { ServerAuthConfiguration.resolveBaseURL() }
    /// me/config 能力下发通道（生产 = ServerAuthClient.fetchServerConfig）。
    private(set) var serverConfig: (() async throws -> Any)?

    private init() {}

    func install(
        http: VoiceHttpTransport?,
        wsFactory: ((String) -> VoiceWebSocket)? = nil,
        baseUrlSource: (() -> String?)? = nil,
        serverConfig: (() async throws -> Any)? = nil
    ) {
        self.http = http
        if let wsFactory { self.wsFactory = wsFactory }
        if let baseUrlSource { self.baseUrlSource = baseUrlSource }
        if let serverConfig { self.serverConfig = serverConfig }
    }

    /// 单测隔离用：恢复未接线默认态。
    func resetForTests() {
        http = nil
        wsFactory = nil
        baseUrlSource = { ServerAuthConfiguration.resolveBaseURL() }
        serverConfig = nil
    }

    func makeWebSocket(url: String) -> VoiceWebSocket {
        if let factory = wsFactory { return factory(url) }
        return URLSessionVoiceWebSocket(urlString: url)
    }
}

// MARK: - method/path 白名单（对齐 Rust voice.rs validate_voice_request）

/// 本地伪码：method/path 不在白名单（调用方写死合法值，落到这里即接线/版本错位）。
/// 校验规则与 voice.rs 逐字对齐：method 仅 GET/POST（大小写归一），path 仅
/// /v1/voice/*（语音网关自己的路径空间）且段内不允许 ".."（穿越防御）。
enum VoiceRequestValidator {
    static func validate(method: String, path: String) throws {
        let upper = method.uppercased()
        guard upper == "GET" || upper == "POST" else {
            throw VoiceError(code: "voice_request_invalid", message: "不支持的语音网关请求方法 \(method)")
        }
        guard path.hasPrefix("/v1/voice/"), !path.contains("..") else {
            throw VoiceError(code: "voice_request_invalid", message: "语音网关路径白名单外: \(path)")
        }
    }
}

/// 走注入的鉴权通道发请求（401→单飞刷新→重放一次由鉴权管理器内部完成，这里只见终态）。
func voiceRequest(method: String, path: String, bodyJson: String? = nil) async throws -> VoiceHttpResponse {
    try VoiceRequestValidator.validate(method: method, path: path)
    guard let http = VoiceGatewayRuntime.shared.http else {
        // 编程错误（应用启动未接线），不是用户可操作错误。
        throw VoiceError(code: "voice_request_invalid", message: "语音网关 HTTP 通道未接线(需在应用启动时 installVoiceGatewayRuntime)")
    }
    return try await http(method, path, bodyJson)
}

// MARK: - 信封解析

/// JSON 数值严格读取（对齐 JS `typeof v === "number" && Number.isFinite(v)`）：
/// JSONSerialization 下布尔也是 NSNumber（CFBoolean），必须排除，否则 true 会被
/// 当成 1。非有限值归 nil。
func voiceJsonNumber(_ value: Any?) -> Double? {
    guard let value, !(value is NSNull) else { return nil }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }
    return nil
}

/// JSON 布尔严格读取（对齐 JS `v === true`）：只认真布尔 true，数值 1 / 字符串不算。
func voiceJsonIsTrue(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID() && number.boolValue
}

/// JSON 字符串字面量（含引号），与 JS `JSON.stringify(string)` 同口径：不转义 `/`
/// （base64 音频/音色 id 原样上行），控制字符与引号/反斜杠按 JSON 规范转义。
func voiceJsonString(_ value: String) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode([value]),
       let text = String(data: data, encoding: .utf8) {
        return String(text.dropFirst().dropLast())
    }
    return escapeJSONString(value)
}

/// JSON 数值字面量（对齐 JS `JSON.stringify(number)`：整数值不带小数点）。
func voiceJsonNumberLiteral(_ value: Double) -> String {
    if value.rounded() == value, abs(value) < 1e15 {
        return String(Int64(value))
    }
    return String(value)
}

/// 解析 JSON body；非 JSON / 非对象返回 nil（调用方按状态兜底）。
func parseJsonObjectBody(_ body: String) -> [String: Any]? {
    guard let data = body.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return parsed
}

/// 信封缺失/非 JSON 时的 HTTP 状态兜底（§二按场景列的 401/402/429/5xx）。
private func fallbackCode(_ status: Int) -> String {
    if status == 401 { return "unauthorized" }
    if status == 402 { return "quota_exceeded" }
    if status == 429 { return "rate_limited" }
    if status >= 500 { return "upstream_error" }
    return "unknown"
}

/// 非 2xx 应答 → VoiceError：读 {error:{code,message,details}} 信封；信封缺失时按
/// HTTP 状态兜底；402 时若 details 缺 remaining，用 x-quota-<resource>-remaining
/// 头补（契约：响应头只有 remaining）。
func errorFromHttpResponse(
    _ status: Int,
    body: String,
    retryAfterSeconds: Int?,
    headers: [String: String] = [:]
) -> VoiceError {
    let envelope = parseJsonObjectBody(body)
    let err = (envelope?["error"] as? [String: Any]) ?? [:]
    let codeRaw = err["code"] as? String
    let code = (codeRaw?.isEmpty == false) ? codeRaw! : fallbackCode(status)
    var details = (err["details"] as? [String: Any]) ?? [:]
    // 对齐 JS `typeof details.remaining !== "number"`（布尔/字符串/缺失都要补）。
    let remainingIsNumber: Bool = {
        guard let number = details["remaining"] as? NSNumber else { return false }
        return CFGetTypeID(number) != CFBooleanGetTypeID()
    }()
    if code == "quota_exceeded", !remainingIsNumber {
        let resource = details["resource"] as? String
        // 优先 <resource> 专属头，否则取任一 x-quota-* 头（服务端键形如 x-quota-tts_chars-remaining）。
        let specificKey = resource.map { "x-quota-\($0)-remaining" }
        let fallbackKey = headers.keys.first { $0.lowercased().hasPrefix("x-quota-") }
        let raw = (specificKey.flatMap { headers[$0] }) ?? (fallbackKey.flatMap { headers[$0] })
        // JS Number(raw) 口径：两端空白忽略、空串为 0、非数字 NaN 不补。
        if let raw {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let parsed = trimmed.isEmpty ? 0 : Double(trimmed)
            if let parsed, parsed.isFinite {
                details["remaining"] = parsed
            }
        }
    }
    let message = err["message"] as? String
    return VoiceError(code: code, message: message, details: details, retryAfterSeconds: retryAfterSeconds)
}

/// 2xx JSON body 解析；失败抛 VoiceError（服务端响应异常按信封/状态兜底）。
func requireOkJson(_ response: VoiceHttpResponse) throws -> [String: Any] {
    guard let body = parseJsonObjectBody(response.body),
          (200..<300).contains(response.status) else {
        throw errorFromHttpResponse(
            response.status,
            body: response.body,
            retryAfterSeconds: response.retryAfterSeconds,
            headers: response.headers
        )
    }
    return body
}

/// https(s) base → ws(s) + path + query；base 缺失（官方云未开放）抛 voice_not_configured。
/// query 用有序对（对齐 URLSearchParams 的插入序；字典会乱序）。
func buildWsUrl(path: String, query: [(key: String, value: String)]) throws -> String {
    guard let base = VoiceGatewayRuntime.shared.baseUrlSource(), !base.isEmpty else {
        throw VoiceError(code: "voice_not_configured", message: "沉浸云服务未配置")
    }
    var components = URLComponents(string: base)
    components?.query = nil
    components?.fragment = nil
    var wsBase = base
    if let scheme = components?.scheme?.lowercased() {
        wsBase = (scheme == "https" ? "wss" : "ws") + String(base.dropFirst(scheme.count))
    }
    // base 带尾斜杠时去重（路径拼接唯一形态 base + path，无空段）。
    while wsBase.hasSuffix("/") {
        wsBase.removeLast()
    }
    // query 参数按 RFC 3986 非保留字符以外转义（与 URLSearchParams 同口径：
    // 字母数字与 -._~ 不转义，其余按百分号编码）。
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let params = query
        .map { pair in
            let key = pair.key.addingPercentEncoding(withAllowedCharacters: allowed) ?? pair.key
            let value = pair.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? pair.value
            return "\(key)=\(value)"
        }
        .joined(separator: "&")
    return "\(wsBase)\(path)?\(params)"
}

// MARK: - URLSession WebSocket 生产包装（URLSessionWebSocketTask，原生无第三方依赖）

/// URLSessionWebSocketTask 包装：ping 完成即「open」（didOpen 的等效信号），
/// receive 循环错误即「close」。标准 WS ping 自动 pong（契约「服务端 25s ping，
/// 标准 WS 自动 pong」由 URLSession 承担）。
final class URLSessionVoiceWebSocket: NSObject, VoiceWebSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((VoiceWsMessage) -> Void)?
    var onClose: ((Int, String) -> Void)?
    var onError: (() -> Void)?

    private(set) var readyState: Int = 0 // 0=connecting
    /// URL 非法（base 被改坏等）时为 nil：open() 直接按握手失败上抛，不崩溃。
    private let task: URLSessionWebSocketTask?
    private let queue = DispatchQueue(label: "local.immersive-translator.voice.ws")
    private var opened = false

    init(urlString: String, session: URLSession = .shared) {
        self.task = URL(string: urlString).map { session.webSocketTask(with: $0) }
        super.init()
    }

    func open() {
        queue.async { [weak self] in
            guard let self, self.readyState == 0 else { return }
            guard let task = self.task else {
                self.readyState = 3
                self.onClose?(1006, "invalid-url")
                return
            }
            task.resume()
            // ping 完成 = 连接可用（didOpenWithProtocol 等效信号；失败走意外断开）。
            task.sendPing { [weak self] error in
                self?.queue.async {
                    guard let self, self.readyState == 0 else { return }
                    if error == nil {
                        self.readyState = 1
                        self.opened = true
                        self.onOpen?()
                        self.receiveLoop()
                    } else {
                        self.readyState = 3
                        self.onClose?(1006, "handshake-failed")
                    }
                }
            }
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            self?.queue.async {
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.onMessage?(.text(text))
                    case .data(let data):
                        self.onMessage?(.data(data))
                    @unknown default:
                        break
                    }
                    self.receiveLoop()
                case .failure:
                    guard self.readyState != 3 else { return }
                    self.readyState = 3
                    // 正常 close 握手的 code 拿不到（URLSession 不透出）；统一按
                    // 1006「意外断开」语义上抛，由状态机按 closedByUs 区分处理。
                    self.onClose?(1006, "closed")
                }
            }
        }
    }

    func sendText(_ text: String) {
        queue.async { [weak self] in
            self?.task?.send(.string(text)) { [weak self] error in
                if error != nil { self?.onError?() }
            }
        }
    }

    func sendData(_ data: Data) {
        queue.async { [weak self] in
            self?.task?.send(.data(data)) { [weak self] error in
                if error != nil { self?.onError?() }
            }
        }
    }

    func close(code: Int, reason: String) {
        queue.async { [weak self] in
            guard let self, self.readyState != 3 else { return }
            self.readyState = 3
            // URLSession 不支持自定义 close code；normalClosure 即 1000 语义（协议
            // 形参 code 仅对测试替身有意义）。
            self.task?.cancel(with: .normalClosure, reason: reason.data(using: .utf8))
        }
    }
}
