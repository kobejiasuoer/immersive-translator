import Foundation

/// 讯飞服务状态灯探测结果（对齐 Windows XfyunVoiceSection 的 probeService）。
/// ok 只在「确认可用」时为 true；失败文案靠 kind 区分成因，而非仅靠颜色。
public struct XfyunProbeOutcome: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// 还没有可用凭据（本服务未配置，asr 也无 ise 可回落）。
        case missingCredentials
        /// 网络层失败：超时（网络不通或被代理/防火墙拦截）或无法连接。
        case network
        /// 服务器可达但拒绝：401 鉴权被拒 / 403 IP 白名单或系统时间偏差超 5 分钟。
        case rejected
        /// 服务器侧问题：404 服务地址 / 429 限频 / 5xx 不可用（连接层正常）。
        case serverIssue
        /// 服务器响应且签名通过（仅 2xx/400/426；仍需实际业务调用验证）。
        case reachable
    }

    public var ok: Bool
    public var kind: Kind
    public var message: String

    public init(ok: Bool, kind: Kind, message: String) {
        self.ok = ok
        self.kind = kind
        self.message = message
    }
}

/// 讯飞三服务（ISE/TTS/ASR）状态灯探测。
/// 用与真实调用同一套 HMAC 签名（XfyunAuth.buildAuthURL）构 wss 地址，
/// 降级为 https GET：不带 Upgrade 头的 GET 不会升级成 WebSocket、不触发
/// 业务调用、不耗额度。注意（300247a 同口径）：普通 GET 只能检查连接，
/// 不能证明 APPID 匹配或语音业务可用——错误 HTTP 状态一律不算通过。
public enum XfyunServiceProbe {
    /// 纯分类（单测覆盖点）：statusCode 无网络语义，只按 HTTP 状态归因。
    /// 对齐 Windows voice_probe_status：仅 2xx/400/426 通过（文案明示「仍需实际
    /// 朗读、识别或评分验证」），401/403/404/429/5xx 一律失败并给对应成因文案。
    public static func classify(statusCode: Int) -> XfyunProbeOutcome {
        switch statusCode {
        case 200...299, 400, 426:
            return XfyunProbeOutcome(
                ok: true,
                kind: .reachable,
                message: "已收到服务器响应；仍需实际朗读、识别或评分验证服务是否可用"
            )
        case 401:
            return XfyunProbeOutcome(
                ok: false,
                kind: .rejected,
                message: "签名验证失败，请检查 API Key、API Secret 和系统时间"
            )
        case 403:
            return XfyunProbeOutcome(
                ok: false,
                kind: .rejected,
                message: "服务器拒绝连接，请检查访问权限、IP 白名单和系统时间"
            )
        case 404:
            return XfyunProbeOutcome(
                ok: false,
                kind: .serverIssue,
                message: "服务地址不存在，请稍后重试"
            )
        case 429:
            return XfyunProbeOutcome(
                ok: false,
                kind: .serverIssue,
                message: "请求过于频繁，请稍后重试"
            )
        case 500...599:
            return XfyunProbeOutcome(
                ok: false,
                kind: .serverIssue,
                message: "语音服务器暂时不可用，请稍后重试"
            )
        default:
            return XfyunProbeOutcome(
                ok: false,
                kind: .serverIssue,
                message: "连接检查未通过，请稍后重试"
            )
        }
    }

    /// 真实探测：缺凭据不发网络；否则签名构 wss 地址 → 换 https GET（默认 15s 超时）。
    public static func probe(
        host: String,
        path: String,
        creds: XfyunCredentials?,
        timeout: TimeInterval = 15,
        session: URLSession = .shared
    ) async -> XfyunProbeOutcome {
        guard let creds, creds.isComplete else {
            return XfyunProbeOutcome(
                ok: false,
                kind: .missingCredentials,
                message: "还没有可用的凭据——先保存该服务的 APPID / APIKey / APISecret"
            )
        }
        let signedWSS = XfyunAuth.buildAuthURL(host: host, path: path, creds: creds)
        let httpsURLString = signedWSS.replacingOccurrences(of: "wss://", with: "https://")
        guard let url = URL(string: httpsURLString) else {
            return XfyunProbeOutcome(ok: false, kind: .network, message: "无法构造探测地址：\(httpsURLString)")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        do {
            let (_, response) = try await session.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            return classify(statusCode: statusCode)
        } catch {
            if let urlError = error as? URLError, urlError.code == .timedOut {
                return XfyunProbeOutcome(
                    ok: false,
                    kind: .network,
                    message: "连接超时（\(Int(timeout))s）：网络不通或被代理/防火墙拦截"
                )
            }
            return XfyunProbeOutcome(
                ok: false,
                kind: .network,
                message: "无法连接：\(error.localizedDescription)"
            )
        }
    }
}
