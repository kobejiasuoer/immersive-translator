import Foundation
import ReaderCore
import XfyunCore

/// 讯飞三服务凭据（ISE 评测 / TTS 合成 / ASR 听写），Keychain 持久化。
/// 对齐 Windows secret_store 的命名 secret（xfyun_ise_* / xfyun_tts_* / xfyun_asr_*）：
/// 这里每服务一个 Keychain 条目存 JSON（appId 不是机密但一起存省一对映射）。
/// 「听写」凭据留空自动回落「评测」凭据（Windows 同语义）。

enum XfyunService: String, CaseIterable, Identifiable {
    case ise
    case tts
    case asr

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ise: return "语音评测（跟读打分）"
        case .tts: return "在线合成（云朗读）"
        case .asr: return "流式听写（口语/录音直译）"
        }
    }

    var consoleHint: String {
        "在讯飞开放平台为该能力单独创建应用后，把 APPID / APIKey / APISecret 填到这里"
    }
}

/// 凭据来源（镜像 Windows xfyunTtsCredSource/asrCredSource，适配 mac 三卡独立 + asr 回落 ise 模型）。
enum XfyunCredSource: Equatable {
    /// 本服务自身已配置完整凭据。
    case own
    /// 本服务未配置，回落「语音评测」凭据（仅 asr）。
    case fallbackISE
    /// 没有可用凭据。
    case none
}

final class XfyunCredentialsStore: ObservableObject {
    static let shared = XfyunCredentialsStore()

    private static let keychainService = "local.immersive-translator.mvp"

    /// 三组凭据的应用层快照（设置页编辑中；保存后写 Keychain 并刷新引擎）。
    @Published private(set) var credentials: [XfyunService: XfyunCredentials] = [:]

    private init() {
        reload()
    }

    func reload() {
        var map: [XfyunService: XfyunCredentials] = [:]
        for service in XfyunService.allCases {
            map[service] = Self.read(service)
        }
        credentials = map
    }

    private static func account(for service: XfyunService) -> String {
        "xfyun.\(service.rawValue)"
    }

    private static func read(_ service: XfyunService) -> XfyunCredentials {
        guard let json = try? KeychainStore.string(service: keychainService, account: account(for: service)),
              let data = json.data(using: .utf8),
              let creds = try? JSONDecoder().decode(XfyunCredentials.self, from: data) else {
            return XfyunCredentials()
        }
        return creds
    }

    /// 部分更新语义（对齐 Windows XfyunVoiceSection：空串字段不覆盖已存值）。
    func update(_ service: XfyunService, appId: String, apiKey: String, apiSecret: String) -> Bool {
        var current = credentials[service] ?? XfyunCredentials()
        if !appId.trimmingCharacters(in: .whitespaces).isEmpty { current.appId = appId.trimmingCharacters(in: .whitespaces) }
        if !apiKey.trimmingCharacters(in: .whitespaces).isEmpty { current.apiKey = apiKey.trimmingCharacters(in: .whitespaces) }
        if !apiSecret.trimmingCharacters(in: .whitespaces).isEmpty { current.apiSecret = apiSecret.trimmingCharacters(in: .whitespaces) }
        do {
            let data = try JSONEncoder().encode(current)
            try KeychainStore.setString(
                String(data: data, encoding: .utf8) ?? "{}",
                service: Self.keychainService,
                account: Self.account(for: service)
            )
            credentials[service] = current
            XfyunTtsEngine.shared.invalidateCredentials()
            return true
        } catch {
            return false
        }
    }

    func isComplete(_ service: XfyunService) -> Bool {
        credentials[service]?.isComplete ?? false
    }

    /// 业务凭据：听写留空自动回落评测凭据（iat 与 ise 常共用一个应用）。
    func creds(for service: XfyunService) -> XfyunCredentials? {
        if let c = credentials[service], c.isComplete {
            return c
        }
        if service == .asr, let ise = credentials[.ise], ise.isComplete {
            return ise
        }
        return nil
    }

    /// 凭据来源查询（状态灯行文案用）：own→「本服务凭据」；fallbackISE→「回落评测凭据」；none→「未配置」。
    func source(for service: XfyunService) -> XfyunCredSource {
        if credentials[service]?.isComplete == true {
            return .own
        }
        if service == .asr, credentials[.ise]?.isComplete == true {
            return .fallbackISE
        }
        return .none
    }
}
