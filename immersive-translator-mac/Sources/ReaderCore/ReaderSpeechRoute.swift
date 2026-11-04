import Foundation

// ---------------------------------------------------------------------------
// 阅读室朗读路由 · 纯归约（对齐 Windows src/reader/readerSpeechRoute.ts 的
// routeReaderSpeech）：旧 xfyun 不经过新守卫；cloud 才跟随语音页 voiceProvider。
//
// 纯函数放 ReaderCore（无网关依赖——语音页守卫的裁决以 VoiceRouteOutcome
// 形状传入）；取数与回落文案拼装在应用层（VoiceGateway/ReaderSpeechRoute.swift）。
// ---------------------------------------------------------------------------

/// 语音页路由守卫的裁决形状（app 层 resolveVoiceRoute 的结果投影）。
public enum VoiceRouteOutcome: Equatable {
    /// 守卫放行 → 网关引擎。
    case gateway
    /// provider=xfyun → 存量讯飞路径（不经守卫）。
    case xfyun
    /// 守卫不过（off）：携带引导 hint 与配额信息（供 Edge 回落提示）。
    case off(hint: String?, quotaResetsAt: String?, quotaRemaining: Double?)
}

/// 阅读室朗读引擎去向。
public enum ReaderSpeechEngineChoice: Equatable {
    case edge
    case xfyun
    case sapi
    case gateway
}

/// Edge 回落提示载荷（app 层据此拼「已临时使用 Edge 朗读：…」）。
public struct ReaderEdgeFallbackPayload: Equatable {
    /// off 裁决的引导 hint（「登录沉浸云即用」等）。
    public var hint: String?
    /// 配额耗尽时的重置时刻（ISO）；非配额类回落为 nil。
    public var quotaResetsAt: String?
    public var quotaRemaining: Double?

    public init(hint: String?, quotaResetsAt: String? = nil, quotaRemaining: Double? = nil) {
        self.hint = hint
        self.quotaResetsAt = quotaResetsAt
        self.quotaRemaining = quotaRemaining
    }
}

public struct ReaderSpeechRouteResult: Equatable {
    public let engine: ReaderSpeechEngineChoice
    /// 仅 cloud + gateway 守卫不通过时非空：调用方据此展示 Edge 回落提示。
    public let fallback: ReaderEdgeFallbackPayload?

    init(engine: ReaderSpeechEngineChoice, fallback: ReaderEdgeFallbackPayload? = nil) {
        self.engine = engine
        self.fallback = fallback
    }
}

/// 朗读路由：edge/local 直达；旧 xfyun 有凭据走讯飞、无凭据回落本地（不经新
/// 守卫）；cloud 才消费语音页守卫——gateway 放行→网关流式引擎；守卫判
/// xfyun→存量讯飞/本地；off→静默 Edge 引擎并带回落决策（不弹登录墙、不中断阅读）。
public func routeReaderSpeech(
    provider: TtsProvider,
    xfyunReady: Bool,
    voiceRoute: VoiceRouteOutcome
) -> ReaderSpeechRouteResult {
    switch provider {
    case .edge:
        return ReaderSpeechRouteResult(engine: .edge)
    case .local:
        return ReaderSpeechRouteResult(engine: .sapi)
    case .xfyun:
        // 旧 xfyun：不经新守卫（零回归红线）。
        return ReaderSpeechRouteResult(engine: xfyunReady ? .xfyun : .sapi)
    case .cloud:
        switch voiceRoute {
        case .gateway:
            return ReaderSpeechRouteResult(engine: .gateway)
        case .xfyun:
            return ReaderSpeechRouteResult(engine: xfyunReady ? .xfyun : .sapi)
        case .off(let hint, let quotaResetsAt, let quotaRemaining):
            return ReaderSpeechRouteResult(
                engine: .edge,
                fallback: ReaderEdgeFallbackPayload(
                    hint: hint,
                    quotaResetsAt: quotaResetsAt,
                    quotaRemaining: quotaRemaining
                )
            )
        }
    }
}
