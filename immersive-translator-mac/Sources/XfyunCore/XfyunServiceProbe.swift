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
        /// 已连上服务器且签名通过（非 401/403 的任何 HTTP 状态）。
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
/// 业务调用、不耗额度；服务端按签名结果回 401/403，其余状态即视为可达。
public enum XfyunServiceProbe {
    /// 纯分类（单测覆盖点）：statusCode 无网络语义，只按 HTTP 状态归因。
    public static func classify(statusCode: Int) -> XfyunProbeOutcome {
        switch statusCode {
        case 401:
            return XfyunProbeOutcome(
                ok: false,
                kind: .rejected,
                message: "鉴权被拒（HTTP 401）：凭据可能抄错，或该应用未开通此服务。"
            )
        case 403:
            return XfyunProbeOutcome(
                ok: false,
                kind: .rejected,
                message: "请求被拒（HTTP 403）：检查讯飞控制台的 IP 白名单，或系统时间偏差是否超过 5 分钟。"
            )
        default:
            return XfyunProbeOutcome(
                ok: true,
                kind: .reachable,
                message: "已连上服务器且签名通过（HTTP \(statusCode)，非 WebSocket 升级请求被正常回绝）。若语音仍失败，请确认应用已开通对应服务。"
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
