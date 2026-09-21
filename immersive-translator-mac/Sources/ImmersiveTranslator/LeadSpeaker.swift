import AVFoundation
import Foundation
import ReaderCore

/// 领读器：慢速示范朗读一句（跟读评测「领读」用，0.72×）。
/// 云引擎可用时走讯飞合成（AVAudioPlayer 变速），否则系统语音。
@MainActor
final class LeadSpeaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var completion: (() -> Void)?
    private var cloudTask: Task<Void, Never>?

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ text: String, rate: Double, completion: @escaping () -> Void) {
        stop()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            completion()
            return
        }
        self.completion = completion
        let chinese = looksMostlyChinese(clean)

        if XfyunTtsEngine.shared.isReady {
            cloudTask = Task { [weak self] in
                do {
                    let data = try await XfyunTtsEngine.shared.audioData(for: clean)
                    guard !Task.isCancelled else { return }
                    guard let self else { return }
                    try self.play(data: data, rate: rate)
                } catch {
                    guard let self else { return }
                    self.speakLocal(clean, chinese: chinese, rate: rate)
                }
            }
        } else {
            speakLocal(clean, chinese: chinese, rate: rate)
        }
    }

    func stop() {
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
