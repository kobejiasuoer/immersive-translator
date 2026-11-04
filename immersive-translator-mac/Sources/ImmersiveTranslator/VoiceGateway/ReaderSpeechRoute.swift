import Foundation
import ReaderCore

// ---------------------------------------------------------------------------
// 阅读室朗读路由 · 应用层取数与回落文案（对齐 Windows src/reader/
// readerSpeechRoute.ts 的 resolveRoute 参数注入与 readerEdgeFallbackNotice）：
// - cloud → 现查语音页守卫（VoiceRoute.resolve），裁决投影成 VoiceRouteOutcome
//   交给 ReaderCore 的纯归约 routeReaderSpeech；
// - 守卫不过 → 静默 Edge 引擎并带回落决策（「已临时使用 Edge 朗读：…」），
//   不弹登录墙、不中断阅读；配额类回落带重置时间与「兑换更多额度」动作位。
// ---------------------------------------------------------------------------

/// 守卫回落文案与配额动作（统一消费 voiceErrors / gatewayViewState 的既有映射）。
struct ReaderFallbackNotice: Equatable {
    let message: String
    let redeemAction: Bool
}

/// 语音页守卫裁决 → ReaderCore 纯路由的投影形状。
func voiceRouteOutcome(of decision: VoiceRouteDecision) -> VoiceRouteOutcome {
    switch decision.engine {
    case .gateway:
        return .gateway
    case .xfyun:
        return .xfyun
    case .off:
        return .off(
            hint: decision.hint,
            quotaResetsAt: decision.quota?.resetsAt,
            quotaRemaining: decision.quota?.remaining
        )
    }
}

/// 阅读室朗读路由（Windows routeReaderSpeech 对应物）：cloud 档跟随语音页
/// voiceProvider；旧 xfyun 不经新守卫；edge/local 直达。
func resolveReaderSpeechRoute(
    provider: TtsProvider,
    xfyunReady: Bool
) async -> (engine: ReaderSpeechEngineChoice, fallback: ReaderFallbackNotice?) {
    switch provider {
    case .edge:
        return (.edge, nil)
    case .local:
        return (.sapi, nil)
    case .xfyun:
        return (xfyunReady ? .xfyun : .sapi, nil)
    case .cloud:
        let decision = await VoiceRoute.resolve(.tts)
        let routed = routeReaderSpeech(
            provider: provider,
            xfyunReady: xfyunReady,
            voiceRoute: voiceRouteOutcome(of: decision)
        )
        if let fallback = routed.fallback {
            return (routed.engine, readerEdgeFallbackNotice(decision: decision, fallback: fallback))
        }
        return (routed.engine, nil)
    }
}

/// 守卫回落文案：非配额回落无动作位、配额带重置+redeem（对齐
/// readerSpeechRoute.ts readerEdgeFallbackNotice）。
func readerEdgeFallbackNotice(decision: VoiceRouteDecision, fallback: ReaderEdgeFallbackPayload) -> ReaderFallbackNotice {
    let quota = decision.reason == .quotaExhausted
    let detail: String?
    if quota {
        var details: [String: Any] = ["resource": "tts_chars"]
        if let quotaEntry = decision.quota {
            if let remaining = quotaEntry.remaining { details["remaining"] = remaining }
            if let allowance = quotaEntry.allowance { details["allowance"] = allowance }
            if let resetsAt = quotaEntry.resetsAt { details["resetsAt"] = resetsAt }
        }
        detail = voiceErrorDisplayText(VoiceError(code: "quota_exceeded", details: details))
    } else {
        detail = fallback.hint
    }
    let message: String
    if let detail, !detail.isEmpty {
        message = "\(edgeFallbackNotice)：\(detail)"
    } else {
        message = edgeFallbackNotice
    }
    return ReaderFallbackNotice(message: message, redeemAction: quota)
}

/// 把运行时 quota_exceeded 错误归一成守卫同形的回落决策，供提示与「下一句转
/// Edge」共用（对齐 ReaderApp.tsx quotaFallbackDecision）。
func quotaFallbackDecision(error: VoiceError) -> VoiceRouteDecision {
    let details = quotaDetailsOf(error)
    return VoiceRouteDecision(
        engine: .off,
        reason: .quotaExhausted,
        hint: voiceErrorDisplayText(error),
        quota: VoiceQuotaRemaining(
            remaining: details.remaining,
            allowance: details.allowance,
            resetsAt: details.resetsAt
        )
    )
}

/// 运行时 quota_exceeded 的 Edge 回落提示（守卫同形决策 → 统一文案出口）。
func readerEdgeFallbackNoticeForQuota(_ error: VoiceError) -> ReaderFallbackNotice {
    let decision = quotaFallbackDecision(error: error)
    return readerEdgeFallbackNotice(
        decision: decision,
        fallback: ReaderEdgeFallbackPayload(
            hint: decision.hint,
            quotaResetsAt: decision.quota?.resetsAt,
            quotaRemaining: decision.quota?.remaining
        )
    )
}

/// 网关朗读失败（已停止）的 toast：完整文案 + 是否附「兑换更多额度」动作位。
struct ReaderSpeechFailureToast: Equatable {
    let message: String
    let redeemAction: Bool
}

/// 网关朗读失败 toast（对齐 Windows ReaderApp.tsx handleSpeechError，474-480）：
/// - 带非空 code 的网关错误（Windows voiceErrorCodeOf 同口径）：
///   「朗读失败，已停止：{voiceErrorDisplayText}」，silent/internal 空串落通用兜底，
///   不透传服务端原文；quota_exceeded 附「兑换更多额度」动作位；
/// - 其余（解码 / 音频设备 / 云端合成返回空音频）：classifyTtsError 归因 +
///   「（点播放键重试[，或到 设置 → 语音 检查]）」后缀，无动作位。
func readerSpeechFailureToast(_ error: Error) -> ReaderSpeechFailureToast {
    if let like = error as? VoiceErrorLike, let code = like.voiceErrorCode, !code.isEmpty {
        let display = voiceErrorDisplayText(like)
        let text = display.isEmpty ? "服务暂时不可用，请稍后再试" : display
        return ReaderSpeechFailureToast(message: "朗读失败，已停止：\(text)", redeemAction: code == "quota_exceeded")
    }
    let info = classifyTtsError(error)
    let settingsHint = info.allowSettings ? "，或到 设置 → 语音 检查" : ""
    return ReaderSpeechFailureToast(
        message: "朗读失败，已停止：\(info.message)（点播放键重试\(settingsHint)）",
        redeemAction: false
    )
}
