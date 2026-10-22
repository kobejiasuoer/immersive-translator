import AVFoundation
import Foundation
import ReaderCore
import XfyunCore

/// 口语陪练控制器（R3 + v0.8 场景中心）：语境/场景入口 + 点击开麦对话环。
/// 对齐 Windows SpeakView.tsx（v0.8）的会话流转：
/// 点击开麦（VAD 静音 1.5s 自动收 / 8s 无话提前收 / 15s 封顶；播报中点击 =
/// 打断插话；录音中再点 = 立即说完）→ ASR(en_us) → LLM 四行回复
/// （EN/ZH/BETTER/TIP，语境会话注入目标词表）→ 用户气泡下渲染词级增删对比；
/// 同一录音异步送 ISE 写入 user 轮 pron（凭据缺失/失败只降级不阻塞）；
/// 命中语境目标词自动按 easy 档完成 SRS（spokenAt 由供数方记录）。
/// 竞态防护：会话纪元（epoch）在换场景/重开/跳过/收麦时自增，一切异步回调
/// （ASR/LLM/ISE/开麦续体）先校验纪元再落盘，旧轮结果一律丢弃。
/// 每轮自动落盘（SpeakStore），可重开最近会话。
/// 跟读子流程（SPEAK-7/13）：收麦 → 评分前体检 → ISE → 干净结果回写 attempts（报告卡
/// 从落盘派生）/ 四类异常可行动卡（shadowFailure）；本次录音 PCM 留存供「听我的录音」；
/// 报告卡动作（听领读/听我的录音/再跟读/只练差词）先停播报且与主麦克风、差词抽屉互斥。

@MainActor
final class SpeakViewController: ObservableObject {
    enum Phase: Equatable {
        case entry
        case idleTurn       // 等用户点击开麦
        case recording      // 点击开麦后说话中（VAD 静音自动收）
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

    /// 外部依赖注入（ReaderViewModel 供数；SpeakView.onAppear 里接线，
    /// 第 2 波可上移到 ReaderViewModel 统一挂载）。
    struct Dependencies {
        /// 当前生词本（语境目标词 / 命中过关 / chips 用）。
        var vocabWords: () -> [VocabWord] = { [] }
        /// 用户发言命中目标词：按 easy 档记 SRS 并落 spokenAt。
        var gradeSpokenVocab: (VocabWord) -> Void = { _ in }
        /// 轻提示（mac 映射 ReaderViewModel.showToast）。
        var toast: (String) -> Void = { _ in }
        /// 报告卡「只练差词」/ 弹层「练这个词」：打开全局差词抽屉（vm.drill），
        /// preferring 非 nil 时该词置顶（SPEAK-7；SpeakView 接线，练完回 drillDone）。
        var openDrill: (_ entries: [ShadowDrillController.Entry], _ preferring: String?) -> Void = { _, _ in }
        /// 全局差词抽屉是否打开（与主麦克风/跟读互斥：抽屉占用麦克风时开麦/跟读一律忽略，
        /// 对齐 SpeakView.tsx:556,682 `if (drill) return`）。
        var drillActive: () -> Bool = { false }
        /// 当前生效的 TTS 引擎（设置 → 语音）：口语页整句播报 / 单词朗读 / 慢速示范一律跟随
        /// （对齐 Windows createSpeechDispatcher 路由到当前引擎，speechEngine.ts:253；
        /// ReaderApp.tsx:1974 慢速示范同一 dispatcher）。每次调用时解析，改设置即时生效。
        /// 缺省 `.xfyun` 为基线行为（SpeakView 接线为 vm.effectiveSettings.ttsProvider）。
        var ttsProvider: () -> TtsProvider = { .xfyun }
    }

    /// 播报通道：缺省 LeadSpeaker；测试注入 `.silent`，避免单测出声、不依赖合成引擎时序。
    /// provider 由控制器按当前设置逐次传入（引擎选择不在通道里缓存）。
    struct SpeechSink {
        var speak: @MainActor (_ text: String, _ rate: Double, _ provider: TtsProvider, _ completion: @escaping () -> Void) -> Void
        /// 慢速示范（SPEAK-8）：Edge 走 SSML prosody -25%、讯飞映射 speed 38、无云回落本地 0.75×；
        /// 不配对完成回调。
        var speakSlow: @MainActor (_ text: String, _ provider: TtsProvider) -> Void
        var stop: @MainActor () -> Void

        @MainActor static func lead(_ speaker: LeadSpeaker) -> SpeechSink {
            SpeechSink(
                speak: { text, rate, provider, done in
                    speaker.speak(text, rate: rate, provider: provider, completion: done)
                },
                speakSlow: { text, provider in speaker.speakSlowNative(text, provider: provider) },
                stop: { speaker.stop() }
            )
        }

        /// 静默通道：speak 立刻回调 completion（状态机照常 speaking → idle）。
        static let silent = SpeechSink(speak: { _, _, _, done in done() }, speakSlow: { _, _ in }, stop: {})
    }

    @Published private(set) var phase: Phase = .entry
    @Published private(set) var session: SpeakSession?
    @Published private(set) var recentSessions: [SpeakSession] = []
    @Published private(set) var level: Float = 0
    @Published private(set) var elapsedMs = 0
    /// LLM 流式上屏（thinking 阶段）。
    @Published private(set) var streaming = StreamingReply()
    /// 跟读异常可行动卡（SPEAK-13：novoice / rejected / noisy / except；nil = 无）。
    /// 替代原先一行 errorBanner；新一轮跟读、新 assistant 回复、换场景时清空
    ///（对齐 Windows setShadow(SHADOW_IDLE) 的各处）。
    @Published private(set) var shadowFailure: ShadowFailureCard?
    /// 最近一次跟读的录音 PCM（16k 单声道 Float32；报告卡「听我的录音」回放）。
    /// 非 @Published：与 ShadowAssessController.lastAttemptPcm 同理，不进相等比较。
    /// 留存发生在被拒检查之前（对齐 Windows shadowPcmRef，SpeakView.tsx:755-756）；
    /// 新跟读 / 新 assistant 回复 / 换场景时清空；只在内存、不落盘。
    private(set) var lastShadowPcm: [Float]?
    /// 「听我的录音」回放器（本次 PCM；与 LeadSpeaker 并行出声无冲突，但动作前先停播报）。
    let shadowRecordingPlayer = ShadowRecordingPlayer()

    let store: SpeakStore
    private let speech: SpeechSink
    private var recorder: MicRecorder?
    private var talkVad: VadDetector?
    private var replyTask: Task<Void, Never>?
    private var pronTask: Task<Void, Never>?
    /// 会话纪元：换场景/重开/跳过/收麦时自增，在途异步结果按纪元丢弃。
    private var epoch = 0
    /// 本轮对话环已收尾（finishUtterance 已取走录音器）：迟到的电平事件忽略。
    private var finishingUtterance = false
    /// getUserMedia 授权等待期又点了麦克风：录音器就绪后直接丢弃，不留悬空录音。
    private var releasePending = false
    /// VAD 是否判到过开口（noSpeech 提前收时用于区分提示文案）。
    private var vadEverStarted = false
    private var deps = Dependencies()

    var chatProvider: ((String, String, @escaping (String) -> Void) async throws -> String) = { _, _, _ in "" }

    /// ASR 转写通道（测试注入）；nil = 走讯飞听写（需 asr 凭据）。
    var transcribeProvider: (([Float]) async throws -> String)?

    /// ISE 评测通道（测试注入）；nil = 走讯飞评测（需 ise 凭据，缺省静默降级）。
    var assessProvider: (([Float], String) async throws -> PronunciationResult)?

    var onNeedCredentialsHint: (() -> Void)?

    /// - Parameters:
    ///   - store: 会话落盘（测试传临时目录的 SpeakStore）。
    ///   - speech: 播报通道（缺省 LeadSpeaker；测试传 `.silent`）。
    init(store: SpeakStore = SpeakStore(), speech: SpeechSink? = nil) {
        self.store = store
        self.speech = speech ?? .lead(LeadSpeaker())
    }

    /// 接线外部依赖（供数/过关/提示）。
    func attach(_ dependencies: Dependencies) {
        deps = dependencies
    }

    /// 当前会话纪元（只读；竞态回归测试断言用）。
    var currentEpoch: Int { epoch }

    // MARK: - 入口

    func refreshRecent() {
        recentSessions = (try? store.listSessions()) ?? []
    }

    /// 开新会话；context 非 nil 时是语境会话（book/vocab），开场白换插值版本。
    func start(scenario: SpeakScenarioId, difficulty: SpeakDifficulty, context: SpeakSessionContext? = nil) {
        epoch += 1
        cancelInFlight()
        resetShadowState()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var s = newSpeakSession(scenario, difficulty, now: now, context: context)
        if let context {
            let opener = speakContextOpener(context)
            s.turns[0] = SpeakTurn(role: .assistant, text: opener.text, hintZh: opener.hintZh, at: now)
        }
        session = s
        _ = try? store.saveSession(s)
        refreshRecent()
        phase = .idleTurn
        speakAssistant(text: s.turns[0].text)
    }

    func resume(_ s: SpeakSession) {
        epoch += 1
        cancelInFlight()
        resetShadowState()
        session = s
        phase = .idleTurn
    }

    /// pendingSpeak 消费端（SPEAK-14，对齐 SpeakView.tsx:617-638 的挂载消费）：
    /// 阅读室「用这句练口语」/ 手账「去口语里用一次」的语境自动开会。与手动点
    /// 语境卡同一条 start 链路；按意图 id 去重——同一 intent 只开会一次
    /// （Windows pendingConsumedRef 对应物；Mac 控制器跨路由存活，重进口语面
    /// 不重开会话，比 Windows 卸载重挂载的语义更稳）。返回 false = 该意图已消费。
    @discardableResult
    func start(pending intent: PendingSpeakIntent, context: SpeakSessionContext) -> Bool {
        if lastConsumedPendingIntentID == intent.id { return false }
        lastConsumedPendingIntentID = intent.id
        start(scenario: .smalltalk, difficulty: .medium, context: context)
        return true
    }

    /// 最近一次已消费的 pendingSpeak 意图（同一 intent 不重复开会）。
    private var lastConsumedPendingIntentID: UUID?

    func backToEntry() {
        epoch += 1
        cancelAll()
        resetShadowState()
        session = nil
        phase = .entry
        refreshRecent()
    }

    /// 跟读子状态清场（异常卡 / 录音留存 / 回放），对齐 Windows start/resume/backToHub
    /// 与新 assistant 回复处的 setShadow(SHADOW_IDLE) + setMineReady(false) + shadowPcmRef=null。
    private func resetShadowState() {
        shadowFailure = nil
        lastShadowPcm = nil
        shadowRecordingPlayer.stop()
    }

    var hasASR: Bool {
        XfyunCredentialsStore.shared.creds(for: .asr) != nil
    }

    var hasISE: Bool {
        XfyunCredentialsStore.shared.creds(for: .ise) != nil
    }

    // MARK: - 点击开麦（免长按）

    /// 免长按开麦：点击开始（播报中点击 = 打断插话），VAD 静音自动结束；
    /// 录音中再点 = 立即说完。识别中/回复生成中按钮禁用（由 UI 保证，这里也兜底）；
    /// 差词抽屉打开时占用麦克风，一律忽略（SpeakView.tsx:556）。
    func toggleMic() {
        if deps.drillActive() { return }
        switch phase {
        case .recording:
            if finishingUtterance { return }
            if recorder == nil {
                // 授权等待期用户已再点了一次：作废本次，不留悬空录音。
                releasePending = true
                phase = .idleTurn
                return
            }
            finishUtterance()
        case .idleTurn, .error, .speaking:
            // 三态统一：开麦前无条件停 TTS（对齐 SpeakView.tsx:571 的 stopSpeak()）——
            // 不只 speaking 态要打断插话；idleTurn 期间透镜卡的单词朗读、error 态下
            // 仍在播的整句播报，都不能混进录音。TTS 收尾回调见 phase != .speaking，不会覆盖新状态。
            beginTalkRecording()
        default:
            break
        }
    }

    private func beginTalkRecording() {
        stopSpeaking()
        shadowRecordingPlayer.stop()  // 「听我的录音」回放也不能混进主录音
        guard hasASR else {
            phase = .error("未配置听写凭据：设置 → 语音（可复用评测凭据）")
            return
        }
        releasePending = false
        finishingUtterance = false
        vadEverStarted = false
        level = 0
        elapsedMs = 0
        phase = .recording
        let myEpoch = epoch
        recordingAttempt += 1
        let myAttempt = recordingAttempt
        let vad = VadDetector(
            silenceMs: SpeakViewController.talkSilenceMs,
            onSpeechStart: { [weak self] in
                Task { @MainActor [weak self] in self?.vadEverStarted = true }
            },
            onAutoStop: { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.recordingAttempt == myAttempt,
                          self.phase == .recording, !self.finishingUtterance else { return }
                    self.finishUtterance()
                }
            }
        )
        talkVad = vad
        Task { [weak self] in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        self?.handleTalkLevel(event)
                    }
                }
                await MainActor.run { [weak self] in
                    guard let self else {
                        rec.cancel()
                        return
                    }
                    // 授权等待期又重开了一次麦：这个过期尝试的录音器直接丢弃，不动新尝试的状态
                    guard self.recordingAttempt == myAttempt else {
                        rec.cancel()
                        return
                    }
                    guard self.epoch == myEpoch, !self.releasePending, case .recording = self.phase else {
                        // 授权等待期用户已再点（作废）/ 场景已切走：不留悬空录音
                        self.releasePending = false
                        rec.cancel()
                        return
                    }
                    self.recorder?.cancel()  // 防御：绝不留两只活麦
                    self.recorder = rec
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.recordingAttempt == myAttempt,
                          self.epoch == myEpoch, case .recording = self.phase else { return }
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    /// 开麦尝试序号：授权等待期快速连点时，过期尝试的录音器就绪后直接丢弃。
    private var recordingAttempt = 0

    /// 对话环免长按的静音断句时长（说完停顿即自动发送）。
    static let talkSilenceMs: Double = 1500
    /// 对话环单次发言录音上限（VAD 封顶；对齐 MAX_UTTERANCE_MS）。
    static let maxUtteranceMs = 15_000
    /// 静音兜底的最短样本数（16k 单声道 0.5s，对齐 MIN_UTTERANCE_SAMPLES）。
    static let minUtteranceSamples = 16_000 / 2

    private func handleTalkLevel(_ event: MicLevelEvent) {
        guard phase == .recording, !finishingUtterance else { return }
        level = event.level
        elapsedMs = event.elapsedMs
        talkVad?.feed(event.level, elapsedMs: event.elapsedMs)
    }

    /// 结束录音并推进一轮：ASR →（并行）LLM 四行回复 + ISE 发音评测。
    private func finishUtterance() {
        guard case .recording = phase, !finishingUtterance else { return }
        let rec = recorder
        recorder = nil
        talkVad = nil
        finishingUtterance = true
        guard let rec else { return }
        let samples = rec.stop()
        processUtterance(samples: samples, everStarted: vadEverStarted)
    }

    /// 测试钩子：模拟一次「已收麦」的发言——跳过物理 MicRecorder/VAD，但走与生产
    /// 完全相同的样本处理路径（纪元自增 → 静音兜底 → ASR → 用户轮 → LLM/ISE）。
    /// 仅供竞态/时序回归测试使用；生产代码不调用。
    func simulateRecordedUtteranceForTesting(samples: [Float], everStarted: Bool = true) {
        guard session != nil else { return }
        recorder?.cancel()
        recorder = nil
        talkVad = nil
        finishingUtterance = true
        processUtterance(samples: samples, everStarted: everStarted)
    }

    /// 收麦后的样本处理（finishUtterance 与测试钩子共用）：
    /// 纪元自增（旧轮在途结果作废）→ 静音兜底（idle + toast，不进 error）→ ASR →
    /// 纪元校验后落用户轮。
    private func processUtterance(samples: [Float], everStarted: Bool) {
        epoch += 1
        let myEpoch = epoch
        phase = .transcribing
        // 静音兜底：没说到话不算一轮（回 idle + 提示，不进 error）
        var peak: Float = 0
        var i = 0
        while i < samples.count {
            peak = max(peak, abs(samples[i]))
            i += 16
        }
        if peak < 0.01 || samples.count < Self.minUtteranceSamples {
            phase = .idleTurn
            deps.toast(everStarted
                ? "没听到声音——离麦克风近一点再说一次"
                : "一直没听到你说话——检查一下麦克风再试")
            return
        }
        // ASR 通道：测试注入优先；缺省讯飞听写（无凭据 → error）
        let transcribe: ([Float]) async throws -> String
        if let provider = transcribeProvider {
            transcribe = provider
        } else {
            guard let creds = XfyunCredentialsStore.shared.creds(for: .asr) else {
                phase = .error("未配置听写凭据：设置 → 语音")
                return
            }
            transcribe = { try await transcribeSpeech(pcm: floatToPcm16Bytes($0), language: .en_us, creds: creds) }
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let text = try await transcribe(samples)
                await MainActor.run {
                    guard self.epoch == myEpoch else { return }  // 已换场景/重开/跳过：旧轮 ASR 结果丢弃
                    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.phase = .idleTurn
                        self.deps.toast("没识别出内容，再试一次（尽量用完整的英语句子）")
                    } else {
                        self.handleUserTurn(text: text, pcm: samples, myEpoch: myEpoch)
                    }
                }
            } catch {
                await MainActor.run {
                    guard self.epoch == myEpoch else { return }
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    // MARK: - 对话环

    /// 用户轮落盘 +（命中目标词过关）+（异步 ISE pron）+ 请求 LLM 回复。
    private func handleUserTurn(text: String, pcm: [Float], myEpoch: Int) {
        guard var s = session else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        s.turns.append(SpeakTurn(role: .user, text: text, at: now))
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
        refreshRecent()

        // 命中语境目标词 → 自动按 easy 档完成 SRS（同词只记一次）
        gradeNewTargetHits(userText: text, turnsBefore: Array(s.turns.dropLast()))

        // 发音评测：同一录音送 ISE（凭据缺失/失败仅降级：user 轮没有 pron，不阻塞对话）
        evaluatePronunciation(pcm: pcm, userText: text, sessionId: s.id, turnAt: now)

        requestReply(myEpoch: myEpoch)
    }

    /// 本轮新命中的目标词：此前未命中才算新（扫更早的 user 轮），过关 + toast。
    private func gradeNewTargetHits(userText: String, turnsBefore: [SpeakTurn]) {
        guard let context = session?.context else { return }
        let vocab = deps.vocabWords()
        let targets = speakContextTargets(context: context, vocabWords: vocab)
        guard !targets.isEmpty else { return }
        let prevHit = speakHitTargetIds(turns: turnsBefore, targets: targets)
        for target in targets where !prevHit.contains(target.word.id) {
            guard textHitsTarget(userText, target.word.word) else { continue }
            // 重新按 id 找最新词条（避免用到陈旧快照）
            if let fresh = vocab.first(where: { $0.id == target.word.id }) {
                deps.gradeSpokenVocab(fresh)
            }
            deps.toast("用上了「\(target.word.word)」——已记一次口语表达")
        }
    }

    /// 异步 ISE 发音评测：异常/被拒/凭据缺失不写 pron、不阻塞对话。
    /// 落盘守卫比纪元更精确：按「会话 id + 本轮 at」定位目标 user 轮——换场景后
    /// 旧结果绝不会写进新会话（纪元的目的），而同一会话里用户已接着说下一句时，
    /// 迟到的评测仍能落回它自己那一轮（Windows 按纪元丢弃会丢掉这次评分）。
    private func evaluatePronunciation(pcm: [Float], userText: String, sessionId: String, turnAt: Int64) {
        // 评测通道：测试注入优先；缺省讯飞评测（无 ise 凭据 → 静默降级不评）
        let assess: ([Float], String) async throws -> PronunciationResult
        if let provider = assessProvider {
            assess = provider
        } else {
            guard let creds = XfyunCredentialsStore.shared.creds(for: .ise) else { return }
            assess = { pcm, text in try await assessPronunciation(text: text, pcm: floatToPcm16Bytes(pcm), creds: creds) }
        }
        pronTask = Task { [weak self] in
            do {
                let result = try await assess(pcm, userText)
                await MainActor.run {
                    guard let self, self.session?.id == sessionId else { return }
                    guard !result.isRejected, result.exceptInfo == nil else { return }  // 异常不计入（同跟读语义）
                    self.applyPron(result, toUserTurnAt: turnAt)
                }
            } catch {
                // 降级：不写 pron
            }
        }
    }

    /// pron 回写指定的 user 轮（从最新会话态续写，可能晚于 coachDiff 落盘）。
    private func applyPron(_ result: PronunciationResult, toUserTurnAt turnAt: Int64) {
        guard var s = session,
              let idx = s.turns.lastIndex(where: { $0.role == .user && $0.at == turnAt }) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        s.turns[idx].pron = shadowAttemptFrom(result, at: now)
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
        refreshRecent()
    }

    private func requestReply(myEpoch: Int) {
        guard let s = session else { return }
        phase = .thinking
        streaming = StreamingReply()
        let targets = speakContextTargets(context: s.context, vocabWords: deps.vocabWords())
            .map { SpeakContextTarget(word: $0.word.word, zh: $0.zh) }
        let system = buildSpeakSystemPrompt(s.scenario, s.difficulty, context: s.context, targets: targets)
        // 输入排除本轮已入记录的 user 轮（末句由 userText 单独拼入，只出现一次）
        let priorTurns = s.turns.last?.role == .user ? Array(s.turns.dropLast()) : s.turns
        let input = buildSpeakUserInput(priorTurns, s.turns.last?.text ?? "")
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
                    guard self.epoch == myEpoch else { return }  // 已换场景/跳过：丢弃旧轮结果
                    guard !parsed.en.isEmpty else {
                        self.phase = .error("回复格式异常，重试一次")
                        return
                    }
                    // 表达改进建议（BETTER/TIP）回写 user 轮（pron 可能已先落盘，从最新态续写）
                    if let better = parsed.better {
                        self.patchLastUserTurnCoachDiff(original: s.turns.last?.text ?? "", better: better, tip: parsed.tip)
                    }
                    guard var cur = self.session,
                          cur.turns.last?.role == .user else { return }
                    let now = Int64(Date().timeIntervalSince1970 * 1000)
                    cur.turns.append(SpeakTurn(role: .assistant, text: parsed.en, hintZh: parsed.zh.isEmpty ? nil : parsed.zh, at: now))
                    cur.updatedAt = now
                    self.session = cur
                    _ = try? self.store.saveSession(cur)
                    self.refreshRecent()
                    self.streaming = StreamingReply()
                    self.phase = .idleTurn
                    // 新 assistant 轮 = 新跟读目标：旧报告卡/异常卡/录音清场
                    //（对齐 SpeakView.tsx:546-550）。
                    self.resetShadowState()
                    self.speakAssistant(text: parsed.en)
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    guard self.epoch == myEpoch else { return }
                    self.phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }

    /// coachDiff 回写最后一个 user 轮（读最新会话态再写，不覆盖已落的 pron）。
    private func patchLastUserTurnCoachDiff(original: String, better: String, tip: String?) {
        guard var s = session,
              let idx = s.turns.lastIndex(where: { $0.role == .user }) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        s.turns[idx].coachDiff = CoachDiff(
            segs: computeCoachDiff(original: original, better: better),
            note: tip
        )
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
    }

    /// 跳过回复：掐掉在途 LLM 请求（纪元自增使迟到结果作废），给可见反馈。
    func skipReply() {
        guard phase == .thinking else { return }
        epoch += 1
        replyTask?.cancel()
        replyTask = nil
        streaming = StreamingReply()
        phase = .idleTurn
        deps.toast("已跳过这次回复，接着说下一句")
    }

    /// 整句播报的代数：新播报顶掉旧播报时，旧 completion（LeadSpeaker.stop 同步触发、
    /// MainActor hop 后落地）按代数丢弃，不会把新一轮 speaking 误置回 idle
    ///（对齐 SpeakView.tsx:257-272 的 gen 配对）。
    private var speakGen = 0

    private func speakAssistant(text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        speakGen += 1
        let myGen = speakGen
        phase = .speaking
        speech.speak(text, 1, deps.ttsProvider()) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.speakGen == myGen else { return }
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

    /// 发音详情「慢速示范 0.75×」（SPEAK-8）：跟随当前 TTS 引擎——Edge 走 SSML prosody -25%、
    /// 讯飞走 speed 38、播放 1×；本地引擎或云失败回落系统语音 0.75×（LeadSpeaker.speakSlowNative）。
    /// 单词朗读不进主环状态机（对齐 Windows speakWordSlowly 走 word 轨独立通道）。
    func speakWordSlow(_ word: String) {
        guard !word.isEmpty else { return }
        speech.speakSlow(word, deps.ttsProvider())
    }

    /// 发音详情「重读这个词」：单词常速朗读（跟随当前 TTS 引擎）。
    func speakWord(_ word: String) {
        guard !word.isEmpty else { return }
        speech.speak(word, 1, deps.ttsProvider()) {}
    }

    /// 播报中插话（点击开麦可打断 TTS）。
    func stopSpeaking() {
        speech.stop()
    }

    // MARK: - 跟读打分（最近 assistant 轮）

    /// 跟读动作（报告卡/异常卡按钮）是否可执行：主环空闲（idle / 播报中可打断 / error）
    /// 且差词抽屉未占用麦克风；录音/识别/回复中/跟读中一律忽略（与主麦克风互斥）。
    var canRunShadowAction: Bool {
        guard !deps.drillActive() else { return false }
        switch phase {
        case .idleTurn, .speaking, .error: return true
        default: return false
        }
    }

    func beginShadowRecord() {
        // 主环空闲且抽屉未占用麦克风才开跟读（SpeakView.tsx:681-683：recording/evaluating
        // 中、drill 打开、主环忙时一律忽略）。
        guard canRunShadowAction else { return }
        // 先停播报/回放再判凭据：缺 ISE 凭据置 error 返回时也不能让整句 TTS 继续外放
        stopSpeaking()
        shadowRecordingPlayer.stop()
        guard hasISE, let s = session, let text = lastAssistantText(s.turns) else {
            if !hasISE {
                phase = .error("未配置评测凭据：设置 → 语音")
            }
            return
        }
        // 新一轮跟读：旧异常卡与录音留存作废（对齐 SpeakView.tsx:685 setShadow recording）
        shadowFailure = nil
        lastShadowPcm = nil
        phase = .shadowRecording
        level = 0
        elapsedMs = 0
        shadowText = text
        Task { [weak self] in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        guard let self, self.phase == .shadowRecording else { return }
                        self.level = event.level
                        self.elapsedMs = event.elapsedMs
                        if event.elapsedMs >= Self.maxUtteranceMs {
                            self.finishShadowRecord()
                        }
                    }
                }
                await MainActor.run {
                    guard let self, self.phase == .shadowRecording else {
                        rec.cancel()
                        return
                    }
                    self.recorder?.cancel()  // 防御：绝不留两只活麦
                    self.recorder = rec
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
            // 授权等待期就点了结束：这次跟读作废
            phase = .idleTurn
            return
        }
        let samples = rec.stop()
        processShadowSamples(samples: samples, text: shadowText)
    }

    /// 测试钩子：模拟一次「已收麦」的跟读——跳过物理 MicRecorder，但走与生产完全相同
    /// 的样本处理路径（评分前体检 → ISE → 四类分类 / 报告回写）。仅供回归测试；生产不调用。
    func simulateShadowRecordForTesting(samples: [Float]) {
        guard let s = session, let text = lastAssistantText(s.turns) else { return }
        recorder?.cancel()
        recorder = nil
        stopSpeaking()
        shadowFailure = nil
        lastShadowPcm = nil
        shadowText = text
        processShadowSamples(samples: samples, text: text)
    }

    /// 收麦后的跟读样本处理（finishShadowRecord 与测试钩子共用），对齐 Windows finishShadow
    /// （SpeakView.tsx:729-810）的分类次序：
    /// 1. 评分前体检：静音（峰值 < 0.01）/ 过短（< 0.5s）→ novoice 卡，不送评测、不留录音；
    /// 2. 凭据缺失 → 普通错误（设置 → 语音）；
    /// 3. ISE 评测：成功后无条件留存 PCM（「听我的录音」含被拒结果可放）；
    ///    is_rejected → rejected 卡；28673 → novoice；28680 → noisy；其他异常码 → except 卡——
    ///    四类都不计入 attempts（不污染趋势）；干净结果 → 回写 attempts、报告卡从落盘派生；
    /// 4. 评测请求抛错（网络/服务）→ except 卡带详情。
    /// 全程 phase 走 shadowAssessing → idleTurn；异常不再进 .error（替代一行 errorBanner）。
    private func processShadowSamples(samples: [Float], text: String) {
        phase = .shadowAssessing
        if let card = shadowPrecheckFailureCard(
            sampleCount: samples.count,
            peak: shadowRecordingPeak(samples),
            minSamples: Self.minUtteranceSamples,
            minPeak: shadowPrecheckMinPeak
        ) {
            shadowFailure = card
            phase = .idleTurn
            return
        }
        // 评测通道：测试注入优先；缺省讯飞评测（无 ise 凭据 → 普通错误）
        let assess: ([Float], String) async throws -> PronunciationResult
        if let provider = assessProvider {
            assess = provider
        } else {
            guard let creds = XfyunCredentialsStore.shared.creds(for: .ise) else {
                phase = .error("未配置评测凭据：设置 → 语音")
                return
            }
            assess = { pcm, text in try await assessPronunciation(text: text, pcm: floatToPcm16Bytes(pcm), creds: creds) }
        }
        let myEpoch = epoch
        let sessionId = session?.id
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await assess(samples, text)
                await MainActor.run {
                    // 换场景/重开：旧跟读结果一律丢弃（纪元 + 会话 id 双重守卫）
                    guard self.epoch == myEpoch, self.session?.id == sessionId else { return }
                    // 录音留在内存：报告卡「听我的录音」可回放对照（留存发生在被拒检查之前）
                    self.lastShadowPcm = samples
                    if let card = shadowResultFailureCard(isRejected: result.isRejected, exceptInfo: result.exceptInfo) {
                        // 乱读/无语音/环境差：给可行动的卡片，不计入 attempts
                        self.shadowFailure = card
                    } else {
                        self.shadowFailure = nil
                        self.applyShadowScore(result)
                    }
                    self.phase = .idleTurn
                }
            } catch {
                await MainActor.run {
                    guard self.epoch == myEpoch, self.session?.id == sessionId else { return }
                    self.shadowFailure = shadowExceptFailureCard(
                        detail: (error as? LocalizedError)?.errorDescription ?? "\(error)"
                    )
                    self.phase = .idleTurn
                }
            }
        }
    }

    // MARK: - 报告卡 / 异常卡动作（SPEAK-7：动作先停播报，与主麦克风互斥）

    /// 「🔊 听领读」：先停一切播报与回放，再整句播最新 assistant 句（走主 speaking 状态机，
    /// 播完自动回 idle；对齐 SpeakView.tsx:1327 onHearModel → speakRound(shadowTarget)）。
    func hearShadowModel() {
        guard canRunShadowAction, let s = session, let text = lastAssistantText(s.turns) else { return }
        shadowRecordingPlayer.stop()
        speakAssistant(text: text)
    }

    /// 「▶ 听我的录音」：回放本次跟读 PCM（先停播报；无录音时无操作，按钮由 UI 禁用）。
    func hearShadowMine() {
        guard canRunShadowAction, let pcm = lastShadowPcm else { return }
        stopSpeaking()
        if phase == .speaking { phase = .idleTurn }
        shadowRecordingPlayer.play(pcm)
    }

    /// 「🎤 再跟读整句」/ 异常卡「再跟读 / 重新跟读 / 再试一次」：重新开麦跟读。
    func retryShadow() {
        beginShadowRecord()
    }

    /// 「🎯 只练 N 个词」/ 弹层「练这个词」：先停播报与回放，再打开全局差词抽屉
    ///（对齐 SpeakView.tsx:849-856 openDrill：stopSpeak 后置 drill）。
    func openShadowDrill(entries: [ShadowDrillController.Entry], preferring word: String? = nil) {
        guard canRunShadowAction, !entries.isEmpty else { return }
        stopSpeaking()
        if phase == .speaking { phase = .idleTurn }
        shadowRecordingPlayer.stop()
        deps.openDrill(entries, word)
    }

    /// 差词抽屉练完（onDone）：回整句再跟读（对齐 SpeakView.tsx:864-868 drillDone → startShadow）。
    /// 抽屉此时已收起（ShadowDrillController 先 close 再 onDone），canRunShadowAction 放行。
    func shadowDrillDone() {
        stopSpeaking()
        beginShadowRecord()
    }

    /// 异常卡的按钮分发（UI 只认 ShadowFailureActionKind，不关心具体哪张卡）。
    func performShadowFailureAction(_ kind: ShadowFailureActionKind) {
        switch kind {
        case .hearModel: hearShadowModel()
        case .again: retryShadow()
        }
    }

    /// 收起异常卡（不改其他状态）。
    func dismissShadowFailure() {
        shadowFailure = nil
    }

    /// 跟读报告回写最近 assistant 轮：append 进 shadowAttempts（每轮最多留
    /// speakMaxShadowAttemptsPerTurn 条，对齐 Windows SpeakView.tsx:550 的 slice(-10)），
    /// 重复跟读不再互相覆盖（口语复盘的跨尝试规则 R2/R5 依赖完整历史）；
    /// shadowScore 字段保留为最新一次总分（兼容现有 UI SpeakView 的跟读分行）。
    private func applyShadowScore(_ result: PronunciationResult) {
        guard var s = session,
              let idx = s.turns.lastIndex(where: { $0.role == .assistant }) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var attempts = s.turns[idx].shadowAttempts ?? []
        attempts.append(shadowAttemptFrom(result, at: now))
        if attempts.count > speakMaxShadowAttemptsPerTurn {
            attempts = Array(attempts.suffix(speakMaxShadowAttemptsPerTurn))
        }
        s.turns[idx].shadowAttempts = attempts
        s.turns[idx].shadowScore = result.total
        s.updatedAt = now
        session = s
        _ = try? store.saveSession(s)
    }

    /// XfyunCore 评测结果 → 落盘 ShadowAttempt（pron 与跟读 attempts 共用）。
    private func shadowAttemptFrom(_ result: PronunciationResult, at now: Int64) -> ShadowAttempt {
        ShadowAttempt(
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
    }

    // MARK: - 退出

    /// 掐掉在途请求与录音（不动 session/phase，供 start/resume 前清场）。
    private func cancelInFlight() {
        replyTask?.cancel()
        replyTask = nil
        pronTask?.cancel()
        pronTask = nil
        recorder?.cancel()
        recorder = nil
        talkVad = nil
        finishingUtterance = false
        releasePending = false
        streaming = StreamingReply()  // 旧轮的流式残稿不带进新会话
        speech.stop()
    }

    func cancelAll() {
        cancelInFlight()
    }

    func clearError() {
        if case .error = phase {
            phase = .idleTurn
        }
    }
}
