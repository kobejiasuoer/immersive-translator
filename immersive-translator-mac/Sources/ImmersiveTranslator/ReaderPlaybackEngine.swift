import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 阅读室播放引擎（usePlayback.ts + tts.rs 的 Mac 对应物）。
///
/// 高亮推进由真实 TTS 事件驱动：逐句投递 AVSpeechUtterance，
/// didFinish 回调才推进下一句；句级高亮不依赖估算时长，变速不影响同步。
///
/// 平台映射（Windows SAPI → AVSpeechSynthesizer）：
/// - 双音轨：sentence（句子朗读）与 word（单词发音）各自独立 synthesizer 实例，
///   查词发音不打断句子朗读（§9-2）。
/// - 打断代数：stop/换句递增 epoch，过期 delegate 回调直接忽略。
/// - 语速 0.5–2.0 → AVSpeech rate（0.5 为默认语速）线性映射。
/// - 句间停顿 → postUtteranceDelay（didFinish 在停顿后触发，天然衔接推进）。
/// - willSpeakRangeOfSpeechString 事件用于调试锚点（句级高亮不依赖它）。
@MainActor
final class ReaderPlaybackEngine: NSObject, ObservableObject {
    enum Event {
        /// 光标移动/推进到某句（UI 高亮跟随）。
        case activeIdx(Int)
        /// 自然播完最后一句。
        case finished
        /// 朗读失败（播放已停止）：携带归因信息（对齐 Windows onError → classifyTtsError）。
        case failed(TtsErrorInfo)
        /// 云合成失败但已回落本地合成（朗读未断流）：携带归因信息，
        /// 让用户知道云音色为什么没响。
        case cloudFallback(TtsErrorInfo)
    }

    struct Settings {
        var rate: Double = 1
        var voice: String = ""
        var sentencePauseMs: Double = 0
        var shadowingMode: Bool = false
        /// 朗读引擎：edge = Edge 在线（默认，免费无凭据，恒尝试）；
        /// xfyun = 讯飞在线合成（凭据缺失自动回落本地）；local = 系统语音。
        var ttsProvider: TtsProvider = .edge
        var cloudVoice: String = ""
        var cloudVoiceEn: String = "catherine"

        static let `default` = Settings()
    }

    @Published private(set) var playing = false
    @Published private(set) var shadowingWait = false

    /// 引擎内部光标（与 VM.activeSentenceIdx 双向同步，单向驱动避免回环）。
    private(set) var cursor = 0

    var onEvent: ((Event) -> Void)?

    private var texts: [String] = []
    private var settings: Settings = .default
    private var epoch = 0
    private var currentUtterance: AVSpeechUtterance?
    /// 云播放（讯飞合成）：AVAudioPlayer 变速播放 mp3。
    private var cloudPlayer: AVAudioPlayer?
    private var cloudTask: Task<Void, Never>?
    /// 句间停顿的延迟推进（云播放用；本地走 postUtteranceDelay）。
    private var pauseWorkItem: DispatchWorkItem?

    /// 云播放器引用（delegate 回调身份比较用）。
    var currentCloudPlayer: AVAudioPlayer? { cloudPlayer }

    /// 双音轨各自独立 synthesizer。
    private let sentenceSynth = AVSpeechSynthesizer()
    private let wordSynth = AVSpeechSynthesizer()

    override init() {
        super.init()
        sentenceSynth.delegate = self
        wordSynth.delegate = self
    }

    // MARK: - 上下文注入

    func updateContext(texts: [String], settings: Settings) {
        let textsChanged = self.texts != texts
        self.texts = texts
        self.settings = settings
        if textsChanged, cursor >= texts.count {
            cursor = max(0, texts.count - 1)
        }
    }

    // MARK: - 状态查询

    var sentenceCount: Int { texts.count }

    // MARK: - 操作

    func setActiveCursor(_ idx: Int) {
        cursor = max(0, idx)
    }

    func toggle() {
        if playing {
            stop()
            return
        }
        if shadowingWait {
            continueAfterShadowing()
            return
        }
        playing = true
        speak(cursor)
    }

    /// 播放中跳读；未播放时只移动光标（§9-7），autoplay 强制开始播放。
    func jumpTo(_ idx: Int, autoplay: Bool = false) {
        guard !texts.isEmpty else { return }
        let clamped = min(texts.count - 1, max(0, idx))
        if playing || autoplay {
            epoch += 1
            shadowingWait = false
            playing = true
            cursor = clamped
            publish(.activeIdx(clamped))
            speak(clamped)
        } else {
            cursor = clamped
            publish(.activeIdx(clamped))
        }
    }

    func step(_ delta: Int) {
        jumpTo(cursor + delta)
    }

    func stop() {
        epoch += 1
        playing = false
        shadowingWait = false
        sentenceSynth.stopSpeaking(at: .immediate)
        stopCloudPlayback()
    }

    /// 跟读确认：读完本句后继续下一句。
    func continueAfterShadowing() {
        guard shadowingWait else { return }
        shadowingWait = false
        let next = cursor + 1
        if next >= texts.count {
            playing = false
            publish(.finished)
            return
        }
        cursor = next
        publish(.activeIdx(next))
        speak(next)
    }

    /// 文章切换后复位。
    func reset(startIdx: Int) {
        epoch += 1
        playing = false
        shadowingWait = false
        sentenceSynth.stopSpeaking(at: .immediate)
        stopCloudPlayback()
        cursor = max(0, startIdx)
    }

    /// 单词发音（word 音轨，不打断句子朗读）。rate 可调（听写整句稍慢 0.92）。
    func speakWord(_ text: String, rate: Double = 1.0) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        wordSynth.stopSpeaking(at: .immediate)
        let utterance = makeUtterance(clean, chinese: looksMostlyChinese(clean), rate: rate, pauseMs: 0)
        wordSynth.speak(utterance)
    }

    // MARK: - 内部

    private func speak(_ idx: Int) {
        guard idx >= 0, idx < texts.count else {
            playing = false
            return
        }
        cursor = idx
        publish(.activeIdx(idx))
        let text = texts[idx]
        switch settings.ttsProvider {
        case .xfyun where XfyunTtsEngine.shared.isReady:
            speakCloud(idx, text: text, engine: .xfyun)
            return
        case .edge:
            // Edge 免凭据，恒尝试；失败在 speakCloud 的 catch 回落本地。
            speakCloud(idx, text: text, engine: .edge)
            return
        default:
            break
        }
        let utterance = makeUtterance(
            text,
            chinese: looksMostlyChinese(text),
            rate: settings.rate,
            pauseMs: settings.sentencePauseMs
        )
        currentUtterance = utterance
        sentenceSynth.speak(utterance)
    }

    /// speakCloud 的云引擎选择（.edge 免凭据恒尝试；.xfyun 需 isReady 才路由进来）。
    private enum CloudEngine {
        case xfyun
        case edge
    }

    /// 云播放（云合成 → AVAudioPlayer 变速播放；讯飞 / Edge 同一回落语义）。
    private func speakCloud(_ idx: Int, text: String, engine: CloudEngine) {
        stopCloudPlayback()
        let myEpoch = epoch
        cloudTask = Task { [weak self] in
            do {
                let data: Data
                switch engine {
                case .xfyun:
                    data = try await XfyunTtsEngine.shared.audioData(for: text)
                case .edge:
                    data = try await EdgeTtsEngine.shared.audioData(for: text)
                }
                guard !Task.isCancelled, let self, self.epoch == myEpoch, self.playing else { return }
                try self.playCloud(data: data)
                // 预取下一句（命中缓存则无网络请求）
                if idx + 1 < self.texts.count {
                    let next = self.texts[idx + 1]
                    switch engine {
                    case .xfyun: XfyunTtsEngine.shared.prefetch(next)
                    case .edge: EdgeTtsEngine.shared.prefetch(next)
                    }
                }
            } catch is CancellationError {
                // 掐掉即可
            } catch {
                guard let self, self.epoch == myEpoch else { return }
                // 云失败回落本地合成，保证朗读不断流；归因上浮（凭据/网络/系统），
                // 让用户知道云音色为什么没响（对齐 Windows P1 归因）。
                let info = classifyTtsError(error)
                DiagnosticLogger.log("reader.tts.cloud-fallback kind=\(info.kind) error=\(error)")
                let utterance = self.makeUtterance(
                    text,
                    chinese: looksMostlyChinese(text),
                    rate: self.settings.rate,
                    pauseMs: self.settings.sentencePauseMs
                )
                self.currentUtterance = utterance
                self.sentenceSynth.speak(utterance)
                self.publish(.cloudFallback(info))
            }
        }
    }

    private func playCloud(data: Data) throws {
        let player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.mp3.rawValue)
        player.enableRate = true
        player.rate = Float(min(readerRateMax, max(readerRateMin, settings.rate)))
        player.delegate = self
        cloudPlayer = player
        player.play()
    }

    private func stopCloudPlayback() {
        cloudTask?.cancel()
        cloudTask = nil
        pauseWorkItem?.cancel()
        pauseWorkItem = nil
        cloudPlayer?.stop()
        cloudPlayer = nil
    }

    /// 云播放完成（AVAudioPlayerDelegate）：停顿后推进。
    @MainActor
    private func handleCloudFinished() {
        guard playing, !shadowingWait else { return }
        cloudPlayer = nil
        let pauseMs = settings.sentencePauseMs
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor [weak self] in
                self?.advanceAfterSentenceFinish()
            }
        }
        pauseWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + pauseMs / 1000, execute: work)
    }

    /// 一句播完后的推进（云/本地共用；shadowingMode 在此拦截）。
    @MainActor
    private func advanceAfterSentenceFinish() {
        guard playing, !shadowingWait else { return }
        let next = cursor + 1
        if next >= texts.count {
            playing = false
            publish(.finished)
            return
        }
        if settings.shadowingMode {
            shadowingWait = true
            return
        }
        cursor = next
        publish(.activeIdx(next))
        speak(next)
    }

    private func makeUtterance(_ text: String, chinese: Bool, rate: Double, pauseMs: Double) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        // AVSpeech rate：0.5 = 默认语速；阅读语速 0.5–2.0 线性映射。
        let avRate = 0.5 * rate
        utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, Float(avRate)))
        utterance.postUtteranceDelay = pauseMs / 1000
        utterance.preUtteranceDelay = 0
        if let voice = Self.pickVoice(named: settings.voice, chinese: chinese) {
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: chinese ? "zh-CN" : "en-US")
        }
        return utterance
    }

    private static func pickVoice(named name: String, chinese: Bool) -> AVSpeechSynthesisVoice? {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !clean.isEmpty {
            let voices = AVSpeechSynthesisVoice.speechVoices()
            if let exact = voices.first(where: { $0.name.caseInsensitiveCompare(clean) == .orderedSame }) {
                return exact
            }
            if let identifier = voices.first(where: { $0.identifier == clean }) {
                return identifier
            }
        }
        // 未指定音色：按语言挑一个系统语音，避免默认英文声读中文。
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let targetPrefix = chinese ? "zh" : "en"
        return voices.first { $0.language.hasPrefix(targetPrefix) }
    }

    private func publish(_ event: Event) {
        onEvent?(event)
    }

    /// 当前正在朗读的 synthesizer 是否属于句子音轨。
    private func isSentenceUtterance(_ utterance: AVSpeechUtterance) -> Bool {
        utterance === currentUtterance
    }
}

extension ReaderPlaybackEngine: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.handleDidFinish(synthesizer: synthesizer, utterance: utterance)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // stop 后无推进；epoch 已由 stop() 递增。
    }

    /// 调试锚点：word/sentence boundary 事件（句级高亮不依赖）。
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance,
        speechSynthesisVoice: AVSpeechSynthesisVoice?
    ) {
        DiagnosticLogger.log("reader.tts.boundary start=\(characterRange.location) len=\(characterRange.length)")
    }

    @MainActor
    private func handleDidFinish(synthesizer: AVSpeechSynthesizer, utterance: AVSpeechUtterance) {
        // word 音轨结束不影响推进。
        guard synthesizer === sentenceSynth else { return }
        guard playing, !shadowingWait, utterance === currentUtterance else { return }
        currentUtterance = nil
        advanceAfterSentenceFinish()
    }
}

/// 系统音色列表（阅读设置的音色下拉）。
struct ReaderVoiceInfo: Equatable {
    let name: String
    let language: String
    let chinese: Bool
}

enum ReaderVoiceCatalog {
    static func voices() -> [ReaderVoiceInfo] {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        return voices
            .filter { !$0.name.isEmpty }
            .map { ReaderVoiceInfo(name: $0.name, language: $0.language, chinese: $0.language.hasPrefix("zh")) }
            .sorted { ($0.chinese == $1.chinese) ? $0.name < $1.name : $0.chinese && !$1.chinese }
    }
}

extension ReaderPlaybackEngine: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, player === self.currentCloudPlayer else { return }
            if flag {
                self.handleCloudFinished()
            } else {
                self.stopCloudPlayback()
                self.publish(.failed(.cloudPlaybackInterrupted()))
            }
        }
    }
}
