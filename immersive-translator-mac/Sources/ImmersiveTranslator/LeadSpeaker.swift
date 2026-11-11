import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 领读器：慢速示范朗读一句（跟读评测「领读」用，0.72×）；口语页播报/慢速示范共用。
/// 云引擎（讯飞 / Edge）可用时走云合成（AVAudioPlayer 变速；可选 nativeRate 原生慢速），
/// 否则系统语音。
@MainActor
final class LeadSpeaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var completion: (() -> Void)?
    private var cloudTask: Task<Void, Never>?
    /// 播报代数：每次 speak/stop 自增，迟到的合成/分发/播放回调按代数丢弃
    /// （PanelTtsSpeaker 同款机制）。playEdge/playXfyun 等腿新建的 unstructured
    /// Task 不继承外层 cloudTask 的取消，Task.isCancelled 拦不住「换句」，需代数兜底。
    private var generation = 0

    override init() {
        super.init()
        synth.delegate = self
    }

    /// - Parameters:
    ///   - rate: 播放端变速倍率（云合成走 AVAudioPlayer.rate；本地系统语音按此倍率）。
    ///   - nativeRate: 云引擎原生合成语速（SSML 百分比，如 "-25%"）；nil = 缺省 1× 合成，
    ///     缓存 key 不变。
    ///   - localRate: 回落本地系统语音时的倍率；nil = 与 rate 相同。慢速示范在云侧用
    ///     原生 -25% + 播放 1×，回落本地则需要 0.75×，两者不等。
    func speak(
        _ text: String,
        rate: Double,
        provider: TtsProvider = .xfyun,
        nativeRate: String? = nil,
        localRate: Double? = nil,
        completion: @escaping () -> Void
    ) {
        stop()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            completion()
            return
        }
        self.completion = completion
        let chinese = looksMostlyChinese(clean)
        let fallbackRate = localRate ?? rate
        generation += 1
        let gen = generation

        if provider == .edge {
            // Edge 免凭据恒尝试（isReady 恒 true）；失败静默回落本地（领读不弹归因 toast）。
            playEdge(clean, nativeRate: nativeRate, rate: rate, fallbackRate: fallbackRate, chinese: chinese, gen: gen)
        } else if provider == .xfyun, XfyunTtsEngine.shared.isReady {
            playXfyun(clean, nativeRate: nativeRate, rate: rate, fallbackRate: fallbackRate, chinese: chinese, gen: gen)
        } else if provider == .cloud {
            // 云音色档：跟随语音页 voiceProvider（裁决与阅读室主链路同源；
            // 外围消费点网关化属后续批次——守卫不过按裁决落 edge/本地，不弹回落提示）。
            cloudTask = Task { [weak self] in
                let engine = await CloudTtsRouter.route(xfyunReady: XfyunTtsEngine.shared.isReady)
                // 路由裁决首次调用/30s TTL 过期时是一次网络探测（HTTPS 往返），期间
                // stop()/新 speak 会推进代数：返回后先核代数再分发，被停/被换的句子
                // 不再进入任何出声腿（unstructured Task 不继承取消，代数是唯一门禁）。
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                switch engine {
                case .gateway:
                    do {
                        let data = try await CloudTtsRouter.gatewayAudioData(text: clean)
                        guard gen == self.generation, !Task.isCancelled else { return }
                        // 网关上行帧契约只有 text/voice/volume（VoiceTts.ttsSynthesisFrame），
                        // 没有语速字段：慢速示范（nativeRate 非空）在网关腿拿不到原生 -25%，
                        // 回落播放端变速（fallbackRate，与 catch 回落腿同源）；nativeRate
                        // 仍由 edge/xfyun 腿原生兑现。
                        try self.play(data: data, rate: nativeRate == nil ? rate : fallbackRate)
                    } catch {
                        guard gen == self.generation, !Task.isCancelled else { return }
                        self.speakLocal(clean, chinese: chinese, rate: fallbackRate)
                    }
                case .edge:
                    self.playEdge(clean, nativeRate: nativeRate, rate: rate, fallbackRate: fallbackRate, chinese: chinese, gen: gen)
                case .xfyun:
                    self.playXfyun(clean, nativeRate: nativeRate, rate: rate, fallbackRate: fallbackRate, chinese: chinese, gen: gen)
                case .local:
                    self.speakLocal(clean, chinese: chinese, rate: fallbackRate)
                }
            }
        } else {
            speakLocal(clean, chinese: chinese, rate: fallbackRate)
        }
    }

    /// Edge 云合成 + 失败静默回落本地（领读不弹归因 toast）。
    private func playEdge(_ clean: String, nativeRate: String?, rate: Double, fallbackRate: Double, chinese: Bool, gen: Int) {
        cloudTask = Task { [weak self] in
            do {
                let data = try await EdgeTtsEngine.shared.audioData(for: clean, nativeRate: nativeRate)
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                try self.play(data: data, rate: rate)
            } catch {
                // stop() 取消（cloudTask.cancel）也会以错误落到 catch：取消或代数已推进
                // （被新 speak 替换）都不得再回落本地出声，否则旧句会混进随后开始的评测录音。
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                self.speakLocal(clean, chinese: chinese, rate: fallbackRate)
            }
        }
    }

    /// 讯飞云合成 + 失败静默回落本地（调用方已确认 isReady）。
    private func playXfyun(_ clean: String, nativeRate: String?, rate: Double, fallbackRate: Double, chinese: Bool, gen: Int) {
        cloudTask = Task { [weak self] in
            do {
                let data = try await XfyunTtsEngine.shared.audioData(for: clean, nativeRate: nativeRate)
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                try self.play(data: data, rate: rate)
            } catch {
                // stop() 取消也会以错误落到 catch（讯飞 wss receive 抛取消类错误）：
                // 取消或代数已推进都不得再回落本地出声，否则旧句会混进随后开始的评测
                // 录音（与 playEdge 同一守卫，此前此处漏检查）。
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                self.speakLocal(clean, chinese: chinese, rate: fallbackRate)
            }
        }
    }

    /// 慢速示范（SPEAK-8）：云引擎以原生语速合成——Edge 走 SSML prosody "-25%"、
    /// 讯飞映射 business.speed 38（播放 1×，对齐 ReaderApp.tsx:1974 的
    /// `{ track: "word", rate: 1, nativeRate: "-25%" }`）；云不可用（无凭据）或合成
    /// 失败回落本地系统语音 0.75×，不报错。不进任何状态机（单词示范不配对完成回调）。
    func speakSlowNative(_ text: String, provider: TtsProvider = .xfyun) {
        speak(
            text,
            rate: 1,
            provider: provider,
            nativeRate: EdgeTts.slowDemoRatePercent,
            localRate: Self.slowLocalFallbackRate,
            completion: {}
        )
    }

    /// 慢速示范回落本地的倍率（Windows 本地 SAPI 无原生慢速，走 playbackRate 0.75）。
    static let slowLocalFallbackRate: Double = 0.75

    func stop() {
        generation += 1
        cloudTask?.cancel()
        cloudTask = nil
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        let done = completion
        completion = nil
        done?()
    }

    private func play(data: Data, rate: Double) throws {
        let player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.mp3.rawValue)
        player.enableRate = true
        player.rate = Float(rate)
        player.delegate = self
        self.player = player
        player.play()
    }

    private func speakLocal(_ text: String, chinese: Bool, rate: Double) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, Float(0.5 * rate)))
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let targetPrefix = chinese ? "zh" : "en"
        utterance.voice = voices.first { $0.language.hasPrefix(targetPrefix) }
            ?? AVSpeechSynthesisVoice(language: chinese ? "zh-CN" : "en-US")
        synth.speak(utterance)
    }

    private func finishIfNeeded() {
        let done = completion
        completion = nil
        done?()
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.finishIfNeeded()
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.finishIfNeeded()
        }
    }
}
