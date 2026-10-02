import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 口语陪练控制器（R3）：场景入口 + 对话环。
/// 对齐 Windows SpeakView.tsx 的会话流转：
/// 按住说话 → ASR(en_us) → LLM 场景回复（EN:/ZH: 两行）→ TTS 播报英文 →
/// 最近 assistant 轮可跟读打分（ISE，回写 turn.shadowScore）。
/// 每轮自动落盘（SpeakStore），可重开最近会话。
@MainActor
final class SpeakViewController: ObservableObject {
    enum Phase: Equatable {
        case entry
        case idleTurn       // 等用户按住说话
        case holding        // 按住说话中（录音）
        case transcribing
        case thinking       // LLM 回复生成中
        case speaking       // TTS 播报 assistant 英文
        case shadowRecording
        case shadowAssessing
        case error(String)
    }

    struct StreamingReply: Equatable {
        var en = ""
        var zh = ""
    }

    @Published private(set) var phase: Phase = .entry
    @Published private(set) var session: SpeakSession?
    @Published private(set) var recentSessions: [SpeakSession] = []
    @Published private(set) var level: Float = 0
    @Published private(set) var elapsedMs = 0
    /// LLM 流式上屏（thinking 阶段）。
    @Published private(set) var streaming = StreamingReply()

    let store = SpeakStore()
    private let speaker = LeadSpeaker()
    private var recorder: MicRecorder?
    private var replyTask: Task<Void, Never>?
    private var holdStartMonotonic: DispatchTime?
    /// 授权等待期松手作废（对齐 micRecorder 语义）。
    private var holdCancelled = false

    var chatProvider: ((String, String, @escaping (String) -> Void) async throws -> String) = { _, _, _ in "" }

    var onNeedCredentialsHint: (() -> Void)?

    // MARK: - 入口

    func refreshRecent() {
        recentSessions = (try? store.listSessions()) ?? []
    }

    func start(scenario: SpeakScenarioId, difficulty: SpeakDifficulty) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let s = newSpeakSession(scenario, difficulty, now: now)
        session = s
        _ = try? store.saveSession(s)
        refreshRecent()
        phase = .idleTurn
        speakAssistant(text: scenarioOf(scenario).opener)
    }

    func resume(_ s: SpeakSession) {
        session = s
        phase = .idleTurn
        speakAssistant(text: lastAssistantText(s.turns) ?? scenarioOf(s.scenario).opener)
    }

    func backToEntry() {
        cancelAll()
        session = nil
        phase = .entry
        refreshRecent()
    }

    var hasASR: Bool {
        XfyunCredentialsStore.shared.creds(for: .asr) != nil
    }

    var hasISE: Bool {
        XfyunCredentialsStore.shared.creds(for: .ise) != nil
    }

    // MARK: - 按住说话

    func beginHold() {
        // idleTurn 或错误提示态都可重新按住说话
        switch phase {
        case .idleTurn, .error:
            break
        default:
            return
        }
        guard hasASR else {
            phase = .error("未配置听写凭据：设置 → 语音（可复用评测凭据）")
            return
        }
        holdCancelled = false
        phase = .holding
        level = 0
        elapsedMs = 0
        Task { [weak self] in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        guard let self, self.phase == .holding else { return }
                        self.level = event.level
                        self.elapsedMs = event.elapsedMs
                        if event.elapsedMs >= 15_000 {
                            self.endHold()
                        }
                    }
                }
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if self.holdCancelled {
                        rec.cancel()
                        return
                    }
                    if case .holding = self.phase {
                        self.recorder = rec
                    } else {
                        rec.cancel()
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.phase == .holding else { return }
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    func endHold() {
        guard case .holding = phase else { return }
        let rec = recorder
        recorder = nil
        guard let rec else {
            // 授权等待期松手：作废本次（还没拿到录音器）。
            holdCancelled = true
            phase = .idleTurn
            return
        }
        let samples = rec.stop()
        // 几乎无信号：提示而不是烧识别次数。
        var peak: Float = 0
        var i = 0
        while i < samples.count {
            peak = max(peak, abs(samples[i]))
            i += 16
        }
        if peak < 0.01 || samples.count < 16_000 / 4 {
            phase = .error("没听到声音——检查麦克风后重试")
            return
        }
        phase = .transcribing
        Task { [weak self] in
            guard let self else { return }
            do {
                guard let creds = XfyunCredentialsStore.shared.creds(for: .asr) else {
                    await MainActor.run { self.phase = .error("未配置听写凭据：设置 → 语音") }
                    return
                }
                let text = try await transcribeSpeech(pcm: floatToPcm16Bytes(samples), language: .en_us, creds: creds)
                await MainActor.run {
                    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.phase = .error("没识别到内容，再按住说一次")
                    } else {
                        self.appendUserTurn(text: text)
                    }
                }
            } catch {
                await MainActor.run {
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    // MARK: - 对话环

    private func appendUserTurn(text: String) {
        guard var s = session else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        s.turns.append(SpeakTurn(role: .user, text: text, at: now))
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
        requestReply()
    }

    private func requestReply() {
        guard var s = session else { return }
        phase = .thinking
        streaming = StreamingReply()
        let system = buildSpeakSystemPrompt(s.scenario, s.difficulty)
        let input = buildSpeakUserInput(s.turns, s.turns.last?.text ?? "")
        replyTask = Task { [weak self] in
            guard let self else { return }
            do {
                let raw = try await self.chatProvider(system, input) { delta in
                    Task { @MainActor [weak self] in
                        guard let self, self.phase == .thinking else { return }
                        let parsed = parseAssistantReply(delta)
                        self.streaming = StreamingReply(en: parsed.en, zh: parsed.zh)
                    }
                }
                let parsed = parseAssistantReply(raw)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    let now = Int64(Date().timeIntervalSince1970 * 1000)
                    s.turns.append(SpeakTurn(role: .assistant, text: parsed.en, hintZh: parsed.zh.isEmpty ? nil : parsed.zh, at: now))
                    s.updatedAt = now
                    self.session = s
                    _ = try? self.store.saveSession(s)
                    self.refreshRecent()
                    self.streaming = StreamingReply()
                    self.phase = .idleTurn
                    self.speakAssistant(text: parsed.en)
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    /// 跳过回复：掐掉在途 LLM 请求。
    func skipReply() {
        guard phase == .thinking else { return }
        replyTask?.cancel()
        phase = .idleTurn
    }

    private func speakAssistant(text: String) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        phase = .speaking
        speaker.speak(text, rate: 1) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.phase == .speaking {
                    self.phase = .idleTurn
                }
            }
        }
    }

    /// 重听最近一句 assistant 英文。
    func replayLast() {
        guard let s = session, let text = lastAssistantText(s.turns) else { return }
        speakAssistant(text: text)
    }

    /// 播报中插话（按住说话可打断 TTS）。
    func stopSpeaking() {
        speaker.stop()
    }

    // MARK: - 跟读打分（最近 assistant 轮）

    func beginShadowRecord() {
        guard hasISE, let s = session, let text = lastAssistantText(s.turns) else {
            if !hasISE {
                phase = .error("未配置评测凭据：设置 → 语音")
            }
            return
        }
        stopSpeaking()
        phase = .shadowRecording
        level = 0
        elapsedMs = 0
        Task { [weak self] in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        guard let self, self.phase == .shadowRecording else { return }
                        self.level = event.level
                        self.elapsedMs = event.elapsedMs
                        if event.elapsedMs >= 15_000 {
                            self.finishShadowRecord()
                        }
                    }
                }
                await MainActor.run {
                    guard let self, self.phase == .shadowRecording else {
                        rec.cancel()
                        return
                    }
                    self.recorder = rec
                    self.shadowText = text
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.phase == .shadowRecording else { return }
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    private var shadowText: String = ""

    func finishShadowRecord() {
        guard case .shadowRecording = phase else { return }
        let rec = recorder
        recorder = nil
        guard let rec else {
            phase = .idleTurn
            return
        }
        let samples = rec.stop()
        phase = .shadowAssessing
        Task { [weak self] in
            guard let self else { return }
            do {
                guard let creds = XfyunCredentialsStore.shared.creds(for: .ise) else {
                    await MainActor.run { self.phase = .error("未配置评测凭据：设置 → 语音") }
                    return
                }
                let result = try await assessPronunciation(text: self.shadowText, pcm: floatToPcm16Bytes(samples), creds: creds)
                await MainActor.run {
                    self.applyShadowScore(result)
                    self.phase = .idleTurn
                }
            } catch {
                await MainActor.run {
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    /// 跟读报告回写最近 assistant 轮：append 进 shadowAttempts（每轮最多留
    /// speakMaxShadowAttemptsPerTurn 条，对齐 Windows SpeakView.tsx:550 的 slice(-10)），
    /// 重复跟读不再互相覆盖（口语复盘的跨尝试规则 R2/R5 依赖完整历史）；
    /// shadowScore 字段保留为最新一次总分（兼容现有 UI SpeakView 的跟读分行）。
    private func applyShadowScore(_ result: PronunciationResult) {
        guard var s = session,
              let idx = s.turns.lastIndex(where: { $0.role == .assistant }) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let attempt = ShadowAttempt(
            at: now,
            total: result.total,
            accuracy: result.accuracy,
            fluency: result.fluency,
            integrity: result.integrity,
            words: result.words.map { w in
                ShadowWord(
                    content: w.content,
                    totalScore: w.totalScore,
                    dpMessage: w.dpMessage,
                    sylls: w.sylls.map { syll in
                        ShadowSyll(
                            content: syll.content,
                            syllScore: syll.syllScore,
                            serrMsg: syll.serrMsg,
                            phones: syll.phones.map { ShadowPhone(content: $0.content, dpMessage: $0.dpMessage, gwpp: $0.gwpp) }
                        )
                    }
                )
            }
        )
        var attempts = s.turns[idx].shadowAttempts ?? []
        attempts.append(attempt)
        if attempts.count > speakMaxShadowAttemptsPerTurn {
            attempts = Array(attempts.suffix(speakMaxShadowAttemptsPerTurn))
        }
        s.turns[idx].shadowAttempts = attempts
        s.turns[idx].shadowScore = result.total
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
    }

    // MARK: - 退出

    func cancelAll() {
        replyTask?.cancel()
        replyTask = nil
        recorder?.cancel()
        recorder = nil
        speaker.stop()
    }

    func clearError() {
        if case .error = phase {
            phase = .idleTurn
        }
    }
}
