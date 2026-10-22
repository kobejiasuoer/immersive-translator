import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 浮窗正在朗读的位置（Windows TranslationPanel 的 SpeakTarget）。
/// 再点同一处即停止；浮窗隐藏或新翻译开始时整体停止。
enum PanelSpeakTarget: Equatable {
    /// 原文（含 done 态编辑框里的最新文本）。
    case original
    /// 译文。
    case translated
    /// 快捷动作结果（动作区独立文本）。
    case actionResult
    /// 词典词条（卡片头部词条词形）。
    case dictEntry
}

/// 浮窗四位置朗读器（Windows speakText / ttsStop / tts:ended 的 Mac 对应物）。
///
/// 行为契约（PANEL-3）：
/// - 同一位置再点一次即停止；切换到另一位置时先停旧朗读；
/// - 中文文本自动选中文声音（云引擎内部按 `looksMostlyChinese` 挑音色；
///   系统合成在这里按同一判定挑 zh/en 语音）；
/// - 引擎沿用全局阅读设置的 ttsProvider：讯飞（凭据就绪才用，未配置直接给
///   「缺凭据」归因，不静默换引擎）/ Edge（免费无凭据）/ 系统语音（离线）；
/// - 失败不做本地兜底回落——通过 `onNotice` 给归因文案
///   （classifyTtsError：缺凭据 / 网络 / 系统组件），对齐 Windows 浮窗语义；
/// - 代数（generation）守卫：被停止/被替换的旧朗读，其迟到回调一律丢弃。
@MainActor
final class PanelTtsSpeaker: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    /// 正在朗读的位置；nil 表示未在朗读。
    @Published private(set) var speaking: PanelSpeakTarget?
    /// 失败归因文案出口（接浮窗 notice，由控制器注入）。
    var onNotice: ((String) -> Void)?
    /// 引擎解析：默认读全局阅读设置；可注入以便测试。
    private let resolveProvider: () -> TtsProvider

    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var cloudTask: Task<Void, Never>?
    /// 朗读代数：每次开始/停止递增，迟到的完成/失败回调按代数丢弃。
    private var generation = 0
    /// 当前正在出声的代数（用于自然播完时清 speaking）。
    private var playingGeneration = 0

    init(
        resolveProvider: @escaping () -> TtsProvider = {
            ReaderStore.shared.loadGlobalReaderSettings().ttsProvider
        }
    ) {
        self.resolveProvider = resolveProvider
        super.init()
        synth.delegate = self
    }

    /// 点按一个朗读位：再点同一处即停止，否则停旧起新。
    func toggle(_ target: PanelSpeakTarget, text: String) {
        if speaking == target {
            stop()
            return
        }
        stop()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }

        generation += 1
        let gen = generation
        let chinese = looksMostlyChinese(clean)
        speaking = target

        switch resolveProvider() {
        case .local:
            speakLocal(clean, chinese: chinese, gen: gen)
        case .xfyun:
            // 讯飞未配置凭据：直接归因「缺凭据」，不静默换引擎（可重试口径一致）。
            guard XfyunTtsEngine.shared.isReady else {
                failSpeaking(
                    gen: gen,
                    error: XfyunSessionError.business(code: -1, message: "讯飞合成凭据未配置（设置 → 语音）")
                )
                return
            }
            speakCloud(gen: gen) { try await XfyunTtsEngine.shared.audioData(for: clean) }
        case .edge:
            speakCloud(gen: gen) { try await EdgeTtsEngine.shared.audioData(for: clean) }
        }
    }

    /// 停止朗读并复位状态（面板隐藏、新翻译开始、切换朗读位时调用）。
    func stop() {
        generation += 1
        cloudTask?.cancel()
        cloudTask = nil
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        speaking = nil
    }

    // MARK: - 播放

    private func speakCloud(gen: Int, fetch: @escaping () async throws -> Data) {
        cloudTask = Task { [weak self] in
            do {
                let data = try await fetch()
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                try self.play(data: data, gen: gen)
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch {
                guard let self, gen == self.generation else { return }
                self.failSpeaking(gen: gen, error: error)
            }
        }
    }

    private func play(data: Data, gen: Int) throws {
        let player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.mp3.rawValue)
        player.delegate = self
        self.player = player
        playingGeneration = gen
        player.play()
    }

    private func speakLocal(_ text: String, chinese: Bool, gen: Int) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let targetPrefix = chinese ? "zh" : "en"
        utterance.voice = voices.first { $0.language.hasPrefix(targetPrefix) }
            ?? AVSpeechSynthesisVoice(language: chinese ? "zh-CN" : "en-US")
        playingGeneration = gen
        synth.speak(utterance)
    }

    /// 朗读失败：清状态并把归因文案交给浮窗 notice（不回落本地出声）。
    private func failSpeaking(gen: Int, error: Error) {
        guard gen == generation else { return }
        speaking = nil
        playingGeneration = 0
        onNotice?("朗读失败：\(classifyTtsError(error).message)")
    }

    // MARK: - AVAudioPlayerDelegate / AVSpeechSynthesizerDelegate
    // 回调线程不定：先回主线程，再按代数校验是否仍是当前朗读。

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.handleCloudPlaybackFinished(successfully: flag)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.handleLocalPlaybackFinished()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // 主动 stop() 触发的取消：状态已由 stop() 清理，这里不重复处理。
    }

    private func handleCloudPlaybackFinished(successfully flag: Bool) {
        guard playingGeneration != 0, playingGeneration == generation else { return }
        speaking = nil
        playingGeneration = 0
    }

    private func handleLocalPlaybackFinished() {
        guard playingGeneration != 0, playingGeneration == generation else { return }
        speaking = nil
        playingGeneration = 0
    }
}
