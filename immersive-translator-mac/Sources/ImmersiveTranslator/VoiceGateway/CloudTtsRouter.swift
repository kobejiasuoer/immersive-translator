import Foundation
import ReaderCore

// ---------------------------------------------------------------------------
// 云音色档（ttsProvider=cloud）外围消费点共用路由（领读 LeadSpeaker / 翻译浮窗
// PanelTtsSpeaker / 快速复习 QuickReviewSpeaker）。裁决与阅读室主链路同源
// （resolveReaderSpeechRoute→routeReaderSpeech）；网关分片收齐成段（Windows
// buffered 模式同构）。本批次这些消费点不接网关回落 toast（规格 §2.2：口语/
// 跟读外围消费点网关化留待同构后续批次），守卫不过时按路由裁决落到
// edge/本地，不出声不弹窗的语义与 Windows 外围批次前的过渡行为一致。
// ---------------------------------------------------------------------------

enum CloudTtsRouter {
    enum Engine {
        case gateway
        case xfyun
        case edge
        case local
    }

    /// 现查路由（cloud → 语音页 voiceProvider）。
    static func route(xfyunReady: Bool) async -> Engine {
        let routed = await resolveReaderSpeechRoute(provider: .cloud, xfyunReady: xfyunReady)
        switch routed.engine {
        case .gateway: return .gateway
        case .xfyun: return .xfyun
        case .edge: return .edge
        case .sapi: return .local
        }
    }

    /// 网关整段合成（mp3 Data；音色取语音页即时保存的 voiceGatewayVoice，
    /// 空值由服务端用默认音色）。
    static func gatewayAudioData(text: String) async throws -> Data {
        let voice = VoicePrefsStore.loadGatewayVoice()
        var audio = Data()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            GatewayTts.synthesize(
                text: text,
                voice: voice,
                volume: nil,
                onChunk: { chunk in
                    audio.append(chunk)
                },
                onEnd: { continuation.resume() },
                onError: { error in
                    continuation.resume(throwing: error)
                }
            )
        }
        return audio
    }
}
