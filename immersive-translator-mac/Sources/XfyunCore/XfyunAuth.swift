import Foundation
import CryptoKit

/// 讯飞 WebAPI 共享鉴权（host/date/authorization HMAC-SHA256 签名）。
/// 对齐 src/core/xfyunAuth.ts：语音评测（ise-api.xfyun.cn /v2/open-ise）、
/// 在线合成（tts-api.xfyun.cn /v2/tts）、流式听写（iat-api.xfyun.cn /v2/iat）
/// 签名方式同构，只差 host 与 path。

public struct XfyunCredentials: Equatable, Codable, Sendable {
    public var appId: String
    public var apiKey: String
    public var apiSecret: String

    public init(appId: String = "", apiKey: String = "", apiSecret: String = "") {
        self.appId = appId
        self.apiKey = apiKey
        self.apiSecret = apiSecret
    }

    public var isComplete: Bool {
        !appId.trimmingCharacters(in: .whitespaces).isEmpty
            && !apiKey.trimmingCharacters(in: .whitespaces).isEmpty
            && !apiSecret.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

public enum XfyunAuth {
    /// RFC 1123 格式的 UTC 时间（与 JS toUTCString 同构，讯飞只认这个格式）。
    public static func utcDateString(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter.string(from: now)
    }

    static func hmacSha256Base64(key: String, message: String) -> String {
        let keyData = Data(key.utf8)
        let messageData = Data(message.utf8)
        let signature = HMAC<SHA256>.authenticationCode(for: messageData, using: SymmetricKey(data: keyData))
        return Data(signature).base64EncodedString()
    }

    /// 构造带签名的 wss 握手地址（host 为讯飞域名，path 形如 "/v2/tts"）。
    public static func buildAuthURL(
        host: String,
        path: String,
        creds: XfyunCredentials,
        now: Date = Date()
    ) -> String {
        let date = utcDateString(now: now)
        let signatureOrigin = "host: \(host)\ndate: \(date)\nGET \(path) HTTP/1.1"
        let signature = hmacSha256Base64(key: creds.apiSecret, message: signatureOrigin)
        let authorizationOrigin = "api_key=\"\(creds.apiKey)\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"\(signature)\""
        let authorization = Data(authorizationOrigin.utf8).base64EncodedString()
        var components = URLComponents()
        components.scheme = "wss"
        components.host = host
        components.path = path
        components.queryItems = [
            URLQueryItem(name: "authorization", value: authorization),
            URLQueryItem(name: "date", value: date),
            URLQueryItem(name: "host", value: host),
        ]
        return components.url?.absoluteString ?? "wss://\(host)\(path)"
    }
}

// MARK: - WebSocket 会话（URLSessionWebSocketTask 的 async 封装，三客户端共用）

public enum XfyunSessionError: Error, LocalizedError, Sendable {
    case closed(code: Int, reason: String)
    case timeout(String)
    case business(code: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .closed(let code, let reason):
            switch code {
            case 401: return "鉴权失败：检查 API Key / API Secret"
            case 403: return "被拒：IP 白名单或系统时间偏差超 5 分钟"
            default: return "连接断开（\(code)\(reason.isEmpty ? "" : " \(reason)")）"
            }
        case .timeout(let hint):
            return hint
        case .business(let code, let message):
            return "\(message)（\(code)）"
        }
    }
}

/// 一条讯飞 WebSocket 会话：connect → send 首帧 → 循环 receive，
/// 收满 data.status == 2 时交给 onDone 收尾。业务码非 0 抛 business 错误。
public final class XfyunWebSocketSession: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let queue = DispatchQueue(label: "local.immersive-translator.xfyun.session")

    public init(url: String) {
        self.task = URLSession.shared.webSocketTask(with: URL(string: url)!)
    }

    public func connect() {
        task.resume()
    }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    /// 接收一条文本消息（跳过非文本帧）。
    public func receiveText() async throws -> String {
        while true {
            let message = try await task.receive()
            switch message {
            case .string(let text):
                return text
            case .data:
                continue
            @unknown default:
                continue
            }
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    /// 通用收流循环：每条消息解析 JSON，code != 0 抛错；status == 2 收满。
    /// audioAccumulator 收 data.audio 分片（TTS），doneValue 用最后一条消息计算结果。
    public static func run<R>(
        url: String,
        firstFrame: String,
        extraFrames: [String] = [],
        timeout: TimeInterval,
        onFrame: @escaping ([String: Any]) -> Void,
        finish: @escaping ([[String: Any]]) throws -> R
    ) async throws -> R {
        let session = XfyunWebSocketSession(url: url)
        var frames: [[String: Any]] = []
        return try await withThrowingTaskGroup(of: R.self) { group in
            group.addTask {
                session.connect()
                try await session.send(firstFrame)
                for frame in extraFrames {
                    try await session.send(frame)
                }
                while true {
                    let text = try await session.receiveText()
                    guard let obj = XfyunJSON.parse(text) else { continue }
                    if let code = obj["code"] as? Int, code != 0 {
                        let message = obj["message"] as? String ?? ""
                        let known = Self.friendlyMessage(code: code) ?? "请求失败：\(message.isEmpty ? String(code) : message)"
                        throw XfyunSessionError.business(code: code, message: known)
                    }
                    onFrame(obj)
                    frames.append(obj)
                    if let data = obj["data"] as? [String: Any], (data["status"] as? Int) == 2 {
                        let result = try finish(frames)
                        session.close()
                        return result
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                session.close()
                throw XfyunSessionError.timeout("\(Int(timeout))s 无结果")
            }
            guard let first = try await group.next() else {
                throw XfyunSessionError.closed(code: -1, reason: "会话结束")
            }
            group.cancelAll()
            return first
        }
    }

    /// 三服务共用的常见错误码文案（缺失回 nil，由调用方兜底）。
    static func friendlyMessage(code: Int) -> String? {
        let known: [Int: String] = [
            10005: "APPID 授权失败（检查讯飞凭据）",
            10006: "请求缺少必传参数",
            10007: "参数非法",
            10109: "文本长度超限",
            10163: "发起会话错误 / 评测参数错误",
            10200: "读取超时",
            10221: "服务器无可用连接，稍后再试",
            10313: "APPID 与 API Key 不匹配",
            11200: "讯飞该服务未授权（控制台确认已开通）",
            11201: "今日免费调用次数已用完",
            11202: "请求频率超限，稍后再试",
            40007: "音频解码失败（采样率应为 16k/16bit/单声道）",
            48195: "评测文本格式错误",
            48205: "没有评测到音频",
            68675: "语音数据异常",
            68676: "读的内容和句子差太远（乱读）",
            10803: "连接超时：检查网络后重试",
            10105: "授权失败：APPID 与 API Key 不匹配，或该应用未开通此服务",
            10110: "请求超时，请重试",
            10160: "请求数据非法",
            10161: "音频 base64 解码失败",
        ]
        return known[code]
    }
}

enum XfyunJSON {
    static func parse(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}
