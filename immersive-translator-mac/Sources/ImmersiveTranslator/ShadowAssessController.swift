import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 跟读评测状态机（shadowingMode + shadowingAssess 时挂到 playback.shadowingWait 上）。
/// 对齐 useShadowAssess.ts：
///
///   本句 TTS 读完 → 自动开麦录音 → 静音 VAD/手动结束 → 送讯飞评测
///     ├─ 达标 → 短暂展示 ✅ → continueAfterShadowing 进下一句
///     └─ 不达标 → 词着色 + [再试] [领读(慢速 TTS，读完自动重新开麦)] [跳过]
///
/// 评测失败的兜底原则：永不卡死播放——任何错误都给「跳过」逃生门。

@MainActor
final class ShadowAssessController: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle          // 非跟读等待（或尚未开始）
        case ready         // 手动开麦模式：等用户点「开口跟读」
        case recording
        case evaluating
        case leading       // 领读慢速 TTS 播放中，播完按开麦方式分流
        case passed
        case failed
        case error
    }

    struct State: Equatable {
        var phase: Phase = .idle
        var level: Float = 0
        var elapsedMs: Int = 0
        var result: PronunciationResult?
        var marks: [WordMark] = []
        var error: String?
        var sentenceIdx: Int?
    }

    @Published private(set) var state = State()

    /// 本句已完成的跟读总分（含本次，最新在末尾；报告卡「第 n 次跟读」/ 历次 chips 用）。
    /// 只有干净结果（!isRejected && exceptInfo == nil）才追加——被拒/无语音/信噪比差
    /// 不进历史，对齐 Windows「不计入 attempts（不污染趋势）」（SpeakView.tsx:508-527）。
    @Published private(set) var attemptTotals: [Double] = []
    /// 报告卡是否已被 ✕ 收起（干净 failed 结果到达时重新弹卡）。
    @Published private(set) var reportDismissed = true
    /// 最近一次跟读的录音 PCM（16k 单声道 Float32）。非 @Published：State 的相等比较
    /// 每秒电平事件都在跑，把 ~24 万 Float 塞进去是白烧；读取方直观察控制器。
    /// 无条件留存（含被拒结果，对齐 Windows shadowPcmRef 在被拒检查之前赋值），
    /// 只在内存、不落盘；上限 15s×16k×4B≈960KB。
    private(set) var lastAttemptPcm: [Float]?

    // VAD 参数（经验值，对齐 useShadowAssess.ts）：
    // 开说/静音阈值按「运行时估计的底噪 × 信噪比倍率」自适应，
    // 绝对下限兜住极安静房间，封顶保证开口即说话时阈值不被顶飞。
    static let speechLevelMin: Float = 0.006
    static let speechLevelCeiling: Float = 0.05
    static let silenceLevelMin: Float = 0.003
    static let speechFloorRatio: Float = 2.8
    static let silenceFloorRatio: Float = 1.6
    /// 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口。
    static let rescueAfterMs = 3500
    static let rescueFloorRatio: Float = 1.8
    /// 一直没听到开说 → 提前收，提示检查麦克风。
    static let noSpeechTimeoutMs = 8000
    static let minRecordMs = 700
    static let maxRecordMs = 15_000
    /// 过关后停留展示的时长，再自动进下一句。
    static let passLingerMs = 650
    /// 领读语速（比正常朗读慢，示范用）。
    static let leadRate = 0.72

    /// 外部依赖注入（由 ReaderViewModel 提供）。
    var textsProvider: () -> [String] = { [] }
    var configProvider: () -> (passScore: Double, autoMic: Bool, silenceMs: Double) = { (4.2, true, 1500) }
    var leadProvider: (String, @escaping () -> Void) -> Void = { _, done in done() }
    var stopLead: () -> Void = {}
    var onAdvance: () -> Void = {}

    private var recorder: MicRecorder?
    private var vadStarted = false
    private var vadLastVoiceAt = 0
    private var vadFloor: Float?
    private var activeSilenceMs: Double = 1500
    private var epoch = 0
    private var passWorkItem: DispatchWorkItem?

    // MARK: - 入口

    /// 本句进入跟读等待：自动开麦直接录，手动模式停在 ready 等「开口跟读」。
    func begin(idx: Int) {
        if state.phase == .recording || state.phase == .evaluating {
            if state.sentenceIdx == idx { return }  // 同句重复触发
            dropRecorder()  // 句子变了，弃掉旧录音
        }
        clearPassTimer()
        stopLead()
        epoch += 1
        // 换句（或从无到有）：本句的尝试历史清零；retry 不经过这里，历史保留
        if state.sentenceIdx != idx {
            attemptTotals = []
        }
        lastAttemptPcm = nil
        state = State(phase: .idle, sentenceIdx: idx)
        if configProvider().autoMic {
            startRecording()
        } else {
            state.phase = .ready
        }
    }

    /// 手动开麦模式：ready 状态下的「开口跟读」按钮。
    func openMic() {
        guard state.phase == .ready else { return }
        startRecording()
    }

    /// 手动「说完」：结束录音送评测。
    func finishManually() {
        guard state.phase == .recording else { return }
        finishRecording()
    }

    /// 再试：failed/error/ready 里点都立即开录。
    func retry() {
        guard state.sentenceIdx != nil else { return }
        dropRecorder()
        clearPassTimer()
        stopLead()
        epoch += 1
        startRecording()
    }

    /// 领读：慢速 TTS 播原句，播完按开麦方式分流。
    func lead() {
        guard let idx = state.sentenceIdx, let text = textsProvider()[safe: idx] else { return }
        dropRecorder()
        clearPassTimer()
        stopLead()
        epoch += 1
        state.phase = .leading
        let myEpoch = epoch
        leadProvider(text) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.epoch == myEpoch, self.state.phase == .leading else { return }
                if self.configProvider().autoMic {
                    self.startRecording()
                } else {
                    self.state.phase = .ready
                }
            }
        }
    }

    /// 跳过本句（放行到下一句）。
    func skip() {
        cancelAssess()
        onAdvance()
    }

    /// 取消评测（退出跟读等待/切句）：弃录音、掐领读、回 idle。
    /// 报告卡与尝试历史一并清场（跳过/放行/换句都不留旧句的分数轨迹）。
    func cancelAssess() {
        epoch += 1
        dropRecorder()
        clearPassTimer()
        stopLead()
        lastAttemptPcm = nil
        attemptTotals = []
        reportDismissed = true
        state = State()
    }

    /// 报告卡 ✕：收起只留评测条；下次干净 failed 结果再弹。
    func dismissReport() {
        reportDismissed = true
    }

    // MARK: - 录音

    private func startRecording() {
        guard let idx = state.sentenceIdx else { return }
        let myEpoch = epoch
        vadStarted = false
        vadLastVoiceAt = 0
        vadFloor = nil
        lastAttemptPcm = nil       // 新一轮录音作废旧留存（retry/begin 自动开麦共用此路径）
        reportDismissed = true     // 开录即视为收卡；下个干净 failed 结果再弹
        state = State(phase: .recording, sentenceIdx: idx)
        let config = configProvider()
        activeSilenceMs = config.silenceMs

        Task { [weak self] in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        self?.handleLevel(event)
                    }
                }
                await MainActor.run {
                    guard let self else { return }
                    guard self.epoch == myEpoch else {
                        rec.cancel()
                        return
                    }
                    self.dropRecorder()
                    self.recorder = rec
                }
            } catch {
                await MainActor.run {
                    guard let self, self.epoch == myEpoch else { return }
                    self.state.phase = .error
                    self.state.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                }
            }
        }
    }

    private func handleLevel(_ event: MicLevelEvent) {
        guard state.phase == .recording else { return }
        state.level = event.level
        state.elapsedMs = event.elapsedMs

        let speechLevel = min(Self.speechLevelCeiling, max(Self.speechLevelMin, (vadFloor ?? 0) * Self.speechFloorRatio))
        if event.level < speechLevel {
            // 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
            vadFloor = vadFloor == nil ? event.level : min(event.level, vadFloor! * 1.05)
        }
        let silenceLevel = max(Self.silenceLevelMin, (vadFloor ?? 0) * Self.silenceFloorRatio)
        if event.level >= speechLevel {
            vadStarted = true
            vadLastVoiceAt = event.elapsedMs
        } else if !vadStarted,
                  event.elapsedMs >= Self.rescueAfterMs,
                  event.level >= (vadFloor ?? 0) * Self.rescueFloorRatio {
            // 超低电平麦克风：绝对阈值够不到，但持续高于底噪也算开口。
            vadStarted = true
            vadLastVoiceAt = event.elapsedMs
        }
        if !vadStarted, event.elapsedMs >= Self.noSpeechTimeoutMs {
            finishRecording()
            return
        }
        if vadStarted,
           event.level < silenceLevel,
           Double(event.elapsedMs - vadLastVoiceAt) >= activeSilenceMs,
           event.elapsedMs >= Self.minRecordMs {
            finishRecording()
        } else if event.elapsedMs >= Self.maxRecordMs {
            finishRecording()
        }
    }

    private func finishRecording() {
        guard let rec = recorder else { return }
        recorder = nil
        let idx = state.sentenceIdx
        let myEpoch = epoch
        guard idx != nil else { return }
        state.phase = .evaluating
        Task { [weak self] in
            guard let self else { return }
            let pcm = rec.stop()
            await MainActor.run {
                guard self.epoch == myEpoch else { return }
                // 无条件留存录音（含被拒结果）：报告卡「听我的录音」回放用。
                // 对齐 Windows shadowPcmRef——留存发生在被拒检查之前；干净门槛
                // 只管报告卡与尝试历史，不管录音。不落盘（Windows 也只在内存）。
                self.lastAttemptPcm = pcm
                self.evaluate(pcm: pcm, idx: idx!, myEpoch: myEpoch)
            }
        }
    }

    private func dropRecorder() {
        recorder?.cancel()
        recorder = nil
    }

    private func clearPassTimer() {
        passWorkItem?.cancel()
        passWorkItem = nil
    }

    // MARK: - 评测

    private func evaluate(pcm: [Float], idx: Int, myEpoch: Int) {
        guard idx >= 0, idx < textsProvider().count else {
            state.phase = .error
            state.error = "句子不存在"
            return
        }
        let text = textsProvider()[idx]
        guard let creds = XfyunCredentialsStore.shared.creds(for: .ise) else {
            state.phase = .error
            state.error = "未配置讯飞评测凭据：设置 → 语音"
            return
        }
        let pcmData = floatToPcm16Bytes(pcm)
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await assessPronunciation(text: text, pcm: pcmData, creds: creds)
                await MainActor.run {
                    guard self.epoch == myEpoch else { return }
                    self.handleResult(result, idx: idx, text: text)
                }
            } catch {
                await MainActor.run {
                    guard self.epoch == myEpoch else { return }
                    self.state.phase = .error
                    self.state.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                }
            }
        }
    }

    private func handleResult(_ result: PronunciationResult, idx: Int, text: String) {
        state.result = result
        state.marks = mapWordsToText(text: text, words: result.words)
        let passScore = configProvider().passScore
        if isIsePass(result, passScore: passScore) {
            state.phase = .passed
            state.error = nil
            // pass 必然满足干净门槛（isIsePass 前两项同语义）→ 进趋势
            attemptTotals.append(result.total)
            let work = DispatchWorkItem { [weak self] in
                Task { @MainActor [weak self] in
                    self?.onAdvance()
                }
            }
            passWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(Self.passLingerMs) / 1000, execute: work)
        } else {
            state.phase = .failed
            state.error = result.isRejected || result.exceptInfo == "28673"
                ? "没听到足够的声音——离麦克风近一点，或在设置里换个麦克风"
                : String(format: "%.1f / %.1f 分，差一点", result.total, passScore)
            // 干净结果门槛：被拒/无语音（28673）/信噪比差（28680）/其他异常的
            // 结果不弹报告卡、不进尝试历史（error 文案照旧上评测条），对齐
            // Windows「不计入 attempts（不污染趋势）」（SpeakView.tsx:508-527）。
            if isCleanIseResult(result) {
                attemptTotals.append(result.total)
                reportDismissed = false
            }
        }
    }
}
