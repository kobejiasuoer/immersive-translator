import Foundation

/// TTS 失败分类（ttsError.ts 的 Mac 对应物）：把云引擎/播放器抛出的错误串归因到
/// 凭据 / 网络 / 系统 三类，给出用户能执行的建议文案，并标注是否值得提供
/// 「打开设置」入口（缺凭据时 true）。
///
/// 覆盖的错误源：
/// - XfyunTtsEngine：「讯飞合成凭据未配置（设置 → 语音）」
/// - XfyunCore（讯飞在线合成）：XfyunSessionError（closed 401/403/timeout/business）、
///   XfyunTtsError（空文本/超长/解码失败/空音频）
/// - Foundation/AVFoundation：URLError（超时、断连、代理）、云音频播放中断
struct TtsErrorInfo: Equatable {
    enum Kind: Equatable {
        case credentials
        case network
        case system
        case unknown
    }

    let kind: Kind
    /// 面向用户的一句话归因（不含原错误串细节）。
    let message: String
    /// 是否值得提供「打开设置」入口（缺凭据时 true）。
    let allowSettings: Bool

    /// 云播放器播完但 unsuccessful（AVAudioPlayerDelegate flag=false）：没有错误对象，
    /// 直接给系统类归因。
    static func cloudPlaybackInterrupted() -> TtsErrorInfo {
        TtsErrorInfo(
            kind: .system,
            message: "云音频播放中断，点播放键重试或换用系统朗读",
            allowSettings: false
        )
    }
}

/// 归一化任意 throw 出来的东西为可分类文本：LocalizedError 优先取
/// errorDescription（XfyunCore 全部错误的用户文案都放在这里），再拼
/// String(describing:) 兜底——保留 case 名与关联值里的码值（如 closed(401)），
/// 让 401/403 这类数字码也能参与匹配。
private func ttsErrorText(_ raw: Error) -> String {
    var parts: [String] = []
    if let localized = raw as? LocalizedError, let desc = localized.errorDescription, !desc.isEmpty {
        parts.append(desc)
    }
    parts.append(String(describing: raw))
    return parts.joined(separator: " | ")
}

func classifyTtsError(_ raw: Error) -> TtsErrorInfo {
    let text = ttsErrorText(raw)
    let s = text.lowercased()

    // 1) 凭据/鉴权：讯飞三元组未配置、Key 无效、握手被拒
    if s.range(of: "凭据|未配置|api[_ ]?key|app[_ ]?id|api[_ ]?secret|鉴权|授权|401|403|handshake|unauthorized|forbidden", options: .regularExpression) != nil {
        return TtsErrorInfo(
            kind: .credentials,
            message: "缺少语音凭据：到 设置 → 语音 填一次即可（跟读/朗读/识别共用）",
            allowSettings: true
        )
    }

    // 2) 网络：在线合成（讯飞）超时、断连、代理问题。
    //    URLError 不带 LocalizedError 文案，String(describing:) 里恒有
    //    URLError/NSURLErrorDomain 字样，靠它兜住（TTS 路径的 URLError 全是网络层）。
    if s.range(of: "网络|超时|timeout|timed out|connect|websocket|fetch|dns|econn|代理|proxy|offline|tls|ssl|断开|closed|interrupted|urlerror|nsurlerrordomain", options: .regularExpression) != nil {
        return TtsErrorInfo(
            kind: .network,
            message: "网络失败：检查网络或代理后重试（离线可换用系统朗读）",
            allowSettings: false
        )
    }

    // 3) 系统：无可用音色、语音组件异常、播放被中断/阻止
    if s.range(of: "音色|voice|speech|synth|播放|audio|play|blocked|notallowed|notsupported|系统|线程", options: .regularExpression) != nil {
        return TtsErrorInfo(
            kind: .system,
            message: "系统朗读不可用：macOS 语音组件异常或播放被中断",
            allowSettings: false
        )
    }

    // 4) 兜底：保留原始信息前 80 字，方便报障定位
    return TtsErrorInfo(
        kind: .unknown,
        message: "朗读失败：\(text.prefix(80))",
        allowSettings: false
    )
}
