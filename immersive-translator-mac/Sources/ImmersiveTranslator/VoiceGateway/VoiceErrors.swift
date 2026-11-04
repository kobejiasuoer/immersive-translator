import Foundation

// ---------------------------------------------------------------------------
// 语音网关错误码 → 用户文案的唯一映射（对齐 Windows src/lib/voice/voiceErrors.ts，
// 契约 docs/voice-cloud-implementation-contract-2026-10-28.md §二）。
//
// 约束：
// - 只按 `code` 字符串分支，绝不透传服务端 message（UI 层与客户端共用本表，
//   勿写两处）；
// - 文案不出现 HTTP 状态码、协议术语等实现说明；
// - token_expired 由鉴权传输层单飞刷新+重放吞掉（AuthTokenManager.withAuth），
//   正常不会到 UI，映射仅供兜底；
// - token_reused 沿用 authErrorText 表的既有文案（ServerAuth.swift:766，
//   与 Windows authErrorText.ts 同源），不另造第二句。
// ---------------------------------------------------------------------------

/// 语音错误（REST 信封 / WSS error 帧归一后的形状；AuthError 形状兼容）。
struct VoiceError: Error {
    let code: String
    /// 服务端 message（仅诊断用，绝不进入用户文案）。
    let message: String?
    /// 错误信封 details（402 配额余量 / 重置时刻等）。
    let details: [String: Any]
    /// 429 的 retry-after 秒数（服务端透传），无则 nil。
    let retryAfterSeconds: Int?

    init(
        code: String,
        message: String? = nil,
        details: [String: Any] = [:],
        retryAfterSeconds: Int? = nil
    ) {
        self.code = code
        self.message = message
        self.details = details
        self.retryAfterSeconds = retryAfterSeconds
    }
}

extension VoiceError: CustomStringConvertible {
    var description: String { "[\(code)] \(message ?? "")" }
}

/// 建议动作（账号页兑换码入口 / 登录页 / 申诉入口等，由 UI 消费）。
enum VoiceErrorAction: Equatable {
    case relogin
    case appeal
    case redeem
    case retry
}

struct VoiceErrorInfo: Equatable {
    /// 用户可见的简体中文文案（silent/internal 时为空串）。
    let text: String
    /// message=可提示；silent=用户不可见（自动处置）；internal=客户端内部处置（如拆句重发）。
    let kind: Kind
    let action: VoiceErrorAction?
    /// 客户端/用户是否应再试（终局错误为 false）。
    let retryable: Bool

    enum Kind: Equatable {
        case message
        case silent
        case internalCase
    }
}

/// voiceErrorMessage 的宽松输入（VoiceError / AuthError / WSS error 帧裸形状均可）。
protocol VoiceErrorLike {
    var voiceErrorCode: String? { get }
    var voiceErrorDetails: [String: Any]? { get }
}

extension VoiceError: VoiceErrorLike {
    var voiceErrorCode: String? { code }
    var voiceErrorDetails: [String: Any]? { details }
}

extension AuthError: VoiceErrorLike {
    var voiceErrorCode: String? { code.isEmpty ? nil : code }
    var voiceErrorDetails: [String: Any]? { nil }
}

private func codeOf(_ input: VoiceErrorLike) -> String {
    input.voiceErrorCode ?? "unknown"
}

private func detailsOf(_ input: VoiceErrorLike) -> [String: Any] {
    input.voiceErrorDetails ?? [:]
}

/// quota_exceeded 的重置时间 / 剩余额度（details 字段，402 details 或 WSS error 帧 details）。
struct VoiceQuotaDetails: Equatable {
    var resource: String?
    var remaining: Double?
    var allowance: Double?
    /// ISO 时刻（UTC 自然月末）；缺失为 nil（服务端配额字段上线前的 402 事件式兜底）。
    var resetsAt: String?

    static let empty = VoiceQuotaDetails()
}

/// 从错误 details 里读配额余量（只认有限数/非空串，防御透传异常；布尔不算数）。
func quotaDetailsOf(_ input: VoiceErrorLike) -> VoiceQuotaDetails {
    let d = detailsOf(input)
    let resource = d["resource"] as? String
    let resetsAtRaw = d["resetsAt"] as? String
    return VoiceQuotaDetails(
        resource: resource,
        remaining: voiceJsonNumber(d["remaining"]),
        allowance: voiceJsonNumber(d["allowance"]),
        resetsAt: (resetsAtRaw != nil && resetsAtRaw != "") ? resetsAtRaw : nil
    )
}

/// quota_exceeded 文案里的功能名（服务端 quota.constants QUOTA_RESOURCES 子集 + 兜底）。
func quotaFeatureLabel(_ resource: String?) -> String {
    switch resource {
    case "tts_chars": return "朗读"
    case "asr_seconds": return "口语识别"
    case "ise_calls": return "跟读打分"
    case "llm_tokens": return "对话"
    default: return "语音"
    }
}

private let finalRetryText = "请稍后再试"

/// 错误码 → 用户文案与动作（§二表逐行）。`final: true` 表示自动重试已用尽，
/// 「正在重试」类文案切换为终局文案。未知 code 安全落到通用兜底。
func voiceErrorMessage(_ input: VoiceErrorLike, final: Bool = false) -> VoiceErrorInfo {
    let code = codeOf(input)
    // §二：token_invalid / unauthorized 同文案同动作（unauthorized 归一，口径同 authErrorText）。
    let normalized = code == "unauthorized" ? "token_invalid" : code
    switch normalized {
    // 静默：传输层单飞刷新后重放一次，用户不可见。
    case "token_expired":
        return VoiceErrorInfo(text: "", kind: .silent, action: .retry, retryable: true)
    case "token_invalid":
        return VoiceErrorInfo(text: "登录已失效，请重新登录", kind: .message, action: .relogin, retryable: false)
    case "token_reused":
        return VoiceErrorInfo(
            text: "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录",
            kind: .message,
            action: .relogin,
            retryable: false
        )
    case "banned":
        return VoiceErrorInfo(text: "账号已被封禁", kind: .message, action: .appeal, retryable: false)
    case "voice_ticket_invalid":
        return final
            ? VoiceErrorInfo(text: finalRetryText, kind: .message, action: .retry, retryable: false)
            : VoiceErrorInfo(text: "连接不稳定，正在重试…", kind: .message, action: .retry, retryable: true)
    case "quota_exceeded":
        let label = quotaFeatureLabel(quotaDetailsOf(input).resource)
        return VoiceErrorInfo(text: "本月\(label)额度已用完", kind: .message, action: .redeem, retryable: false)
    case "rate_limited":
        return VoiceErrorInfo(text: "请求太频繁，请稍后再试", kind: .message, action: .retry, retryable: true)
    // 不提示：隐藏评测入口即可。
    case "ise_disabled":
        return VoiceErrorInfo(text: "", kind: .silent, action: nil, retryable: false)
    case "voice_not_configured":
        return VoiceErrorInfo(text: "语音功能暂未开通", kind: .message, action: nil, retryable: false)
    // 内部处理：客户端保证按句拆分后重发，正常不会到 UI。
    case "voice_text_too_long":
        return VoiceErrorInfo(text: "", kind: .internalCase, action: .retry, retryable: true)
    case "voice_invalid_state", "voice_session_too_long":
        return VoiceErrorInfo(text: "单次最长 60 秒，请重新开始", kind: .message, action: .retry, retryable: true)
    case "upstream_error", "upstream_timeout":
        return final
            ? VoiceErrorInfo(text: finalRetryText, kind: .message, action: .retry, retryable: false)
            : VoiceErrorInfo(text: "服务暂时不可用，正在重试", kind: .message, action: .retry, retryable: true)
    // 本地伪码：WSS 意外断开（1006 等），客户端指数退避重连中。
    case "voice_disconnected":
        return final
            ? VoiceErrorInfo(text: "网络连接不稳定，请稍后再试", kind: .message, action: .retry, retryable: false)
            : VoiceErrorInfo(text: "网络中断，正在重连…", kind: .message, action: .retry, retryable: true)
    case "network_error":
        return VoiceErrorInfo(text: "网络连接失败，请检查网络后重试", kind: .message, action: .retry, retryable: true)
    default:
        return VoiceErrorInfo(text: "服务暂时不可用，请稍后再试", kind: .message, action: .retry, retryable: false)
    }
}

/// 消费点错误展示文案（§二 quota_exceeded 动作列的唯一消费口）：voiceErrorMessage
/// 基础上，额度类错误（action=redeem）把 402/WSS details 的 resetsAt 拼成
/// 「N 月 N 日重置」；服务端 resetsAt 未下发时给「设置 → 账号」兑换码入口指路
/// （与路由守卫的额度 hint 同措辞）。其余 code 原样透传；silent/internal（text 为
/// 空串）原样返回空串，调用方按各自兜底处理。实时字幕 / 朗读 / 一键测试的云端
/// 错误分支统一走这里（对齐 Windows gatewayViewState.ts voiceErrorDisplayText）。
func voiceErrorDisplayText(_ input: VoiceErrorLike) -> String {
    let info = voiceErrorMessage(input)
    if info.text.isEmpty { return "" }
    if info.action == .redeem {
        if let reset = quotaResetText(quotaDetailsOf(input).resetsAt) {
            return "\(info.text)，\(reset)"
        }
        return "\(info.text)，可在「设置 → 账号」用兑换码补足"
    }
    return info.text
}
