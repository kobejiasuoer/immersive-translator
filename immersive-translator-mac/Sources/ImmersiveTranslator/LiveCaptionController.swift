import Foundation
import ReaderCore
import XfyunCore

/// 录音直译控制器（R4）：麦克风流式分句 → 讯飞听写 → 句级流式翻译 → 双语字幕。
/// 对齐 Windows LiveCaptionApp：方向切换（录音中锁定）、最多显示 200 段、
/// 失败段保留原文、双语导出（.md / .txt 原生另存为）。

/// 录音句柄最小接口（生产 = MicRecorder；测试替身只需 cancel，不碰真实设备）。
protocol LiveCaptionMicHandle: AnyObject {
    func cancel()
}

extension MicRecorder: LiveCaptionMicHandle {}

@MainActor
final class LiveCaptionController: ObservableObject {
    @Published private(set) var segments: [CaptionSegment] = []
    @Published private(set) var direction: CaptionDirection = .zh2en
    @Published private(set) var recording = false
    @Published private(set) var level: Float = 0
    @Published private(set) var speaking = false
    @Published var errorMessage: String?

    static let displayLimit = 200

    private var recorder: LiveCaptionMicHandle?
    private var segmenter: LiveSegmenter?
    private var nextSegmentId = 0
    private var startedAt: Int64 = 0
    private var endedAt: Int64 = 0
    // 独立实例：configuration() 每次实时读当前 Provider/Keychain，无共享状态问题。
    // lazy：测试实例化控制器不触发 SettingsStore（Keychain ACL 会挂死 xctest）。
    private lazy var chat = ReaderChatClient(settingsStore: SettingsStore())
    /// 语音服务商路由决策：开麦那一刻定格（voiceRoute §三.5），整场录音共用。
    /// 停止录音后不清空（对齐 Windows routeRef：只在下次开麦时被重新定格覆盖；
    /// 缺失时由 transcribe 补一次 resolve）。
    var route: VoiceRouteDecision?

    // ---- 句级转写注入点（生产实现见默认值；测试替身覆盖，不碰网络/Keychain）----
    /// 麦克风流式启动（生产 MicRecorder，输出 16k Float32 分块；测试替身不碰真实设备/授权弹窗）。
    var micStarter: (@escaping ([Float], MicLevelEvent) -> Void) async throws -> LiveCaptionMicHandle = { onChunk in
        try await MicRecorder.start(onChunk: onChunk)
    }
    /// 句级翻译（nil = 生产 ReaderChatClient；测试替身覆盖，不碰 LLM 网络/Keychain）。
    var captionTranslator: ((_ systemPrompt: String, _ source: String) async throws -> String)?
    /// 路由决策来源（开麦定格 / flush 尾句补一次）。
    var routeResolver: (VoiceAsrLang?) async -> VoiceRouteDecision = { await VoiceRoute.resolve(.asr, asrLang: $0) }
    /// gateway 句级 REST 转写（MicRecorder 输出已 16k Float32，量化+base64）。
    var gatewayTranscriber: (VoiceAsrLang, [Float]) async throws -> String = { lang, samples in
        try await transcribeBatch(lang: lang, pcmBase64: pcm16kToBase64(samples).base64).text
    }
    /// 讯飞听写凭据（缺失走存量讯飞文案不开麦）。
    var xfyunAsrCredentials: () -> XfyunCredentials? = { XfyunCredentialsStore.shared.creds(for: .asr) }
    /// 讯飞流式听写（凭据由 dispatch 检查后传入）。
    var xfyunTranscriber: ([Float], AsrLanguage, XfyunCredentials) async throws -> String = { samples, language, creds in
        try await transcribeSpeech(pcm: floatToPcm16Bytes(samples), language: language, creds: creds)
    }

    var hasCredentials: Bool {
        XfyunCredentialsStore.shared.creds(for: .asr) != nil
    }

    /// 当前方向对应的识别语种（对齐 Windows asrLanguageOf：zh2en→zh_cn，en2zh→en_us）。
    var asrLanguage: VoiceAsrLang {
        Self.asrLanguageOf(direction)
    }

    /// 方向 → 识别语种（Windows core/liveCaption.ts asrLanguageOf 同口径）。
    static func asrLanguageOf(_ dir: CaptionDirection) -> VoiceAsrLang {
        dir == .zh2en ? .zh_cn : .en_us
    }

    // MARK: - 方向

    func toggleDirection() {
        guard !recording else { return }  // 录音中锁定
        direction = direction.swapped
    }

    // MARK: - 录音

    func toggleRecording() {
        if recording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    /// 开麦前的路由守卫进行中（异步 resolve 期间重复点「开始」不重复开麦）。
    private var startPending = false

    private func startRecording() {
        guard !startPending else { return }
        startPending = true
        // 前置检查：语音服务商路由先定（voiceRoute §三.5 守卫），整场录音共用；
        // 守卫不过给「登录沉浸云即用」等引导，讯飞分支再查凭据、缺凭据给既有讯飞
        // 文案。都不开麦。
        Task { [weak self] in
            guard let self else { return }
            let decision = await self.routeResolver(self.asrLanguage)
            self.startPending = false
            self.route = decision
            switch decision.engine {
            case .off:
                self.errorMessage = decision.hint ?? "语音识别暂不可用"
            case .xfyun:
                guard self.xfyunAsrCredentials() != nil else {
                    // 讯飞分支既有文案（零改动）。
                    self.errorMessage = "未配置听写凭据：设置 → 语音（可复用评测凭据）"
                    return
                }
                self.beginRecording()
            case .gateway:
                self.beginRecording()
            }
        }
        // 乐观置位在路由守卫之后（对齐 Windows：守卫不过不开麦、不进录音态）。
    }

    private func beginRecording() {
        errorMessage = nil
        segmenter = LiveSegmenter()
        startedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let starter = micStarter
        Task { [weak self] in
            do {
                let rec = try await starter { [weak self] samples, event in
                    Task { @MainActor [weak self] in
                        self?.handleChunk(samples, event: event)
                    }
                }
                await MainActor.run { [weak self] in
                    guard let self else {
                        rec.cancel()
                        return
                    }
                    // 授权等待期用户已点停止（recording 已复位）→ 录音器就绪后直接丢弃
                    //（对齐 Windows stopPendingRef）；否则接管录音器。原条件写反
                    //（recording == false 才接管）会把乐观置位后的录音器立刻 cancel。
                    if self.recording, self.recorder == nil {
                        self.recorder = rec
                    } else {
                        rec.cancel()
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                    // 麦克风打不开：退出录音态（对齐 Windows：失败不进录音态）。路由决策
                    // 不清空（Windows routeRef 同样保留，下次开麦重新定格覆盖）。
                    self.recording = false
                    self.segmenter = nil
                }
            }
        }
        // 乐观置位：让 UI 立即进入录音态（拿不到录音器会在回调里报错并复位）。
        recording = true
    }

    private func stopRecording() {
        guard recording else { return }
        recording = false
        endedAt = Int64(Date().timeIntervalSince1970 * 1000)
        // 攒着的半句交出来：方向与路由在 transcribe 入口这刻定格——尾句按本场录音
        // 方向识别/翻译（原先未传语种恒按 zh_cn），并复用开麦那一刻定格的路由
        //（对齐 LiveCaptionApp.tsx:254-256 handleUtterance(tail)）。
        if let half = segmenter?.flush(), !half.isEmpty {
            transcribe(samples: half)
        }
        recorder?.cancel()
        recorder = nil
        segmenter = nil
        speaking = false
        level = 0
        // 路由决策不清空（对齐 Windows：stopRecording 不动 routeRef，整场共用到下次
        // 开麦重新定格；尾句不重新 resolve）。
    }

    private func handleChunk(_ samples: [Float], event: MicLevelEvent) {
        guard recording, let segmenter else { return }
        level = event.level
        if let sentence = segmenter.push(chunk: samples, level: event.level) {
            speaking = false
            transcribe(samples: sentence)
        } else {
            speaking = segmenter.speaking
        }
    }

    // MARK: - 听写 + 翻译

    /// 一句收尾：ASR → 翻译 → 更新段。失败段给降级提示但不中断录音。
    /// 方向与路由在进函数这刻定格（对齐 handleUtterance 入口同步读取
    /// `directionRef.current` / `routeRef.current`）：停止录音后用户立刻切方向，
    /// 尾句（flush 出来的半句）不能按新方向识别/翻译。语音服务商路由（voiceRoute
    /// §三.5）开麦那一刻已定（route）；route 缺失的场景补一次 resolve 并定格
    ///（对齐 LiveCaptionApp.tsx:112-117）。守卫不过：给引导、不消耗任何额度、不产段。
    func transcribe(samples: [Float]) {
        let dir = direction
        let language: AsrLanguage = dir == .zh2en ? .zh_cn : .en_us
        let pinned = route
        Task { [weak self] in
            guard let self else { return }
            let decision: VoiceRouteDecision
            if let pinned {
                decision = pinned
            } else {
                decision = await self.routeResolver(Self.asrLanguageOf(dir))
                self.route = decision
            }
            let creds: XfyunCredentials?
            switch LiveCaptionAsrDispatch.precheck(decision: decision, xfyunCredentials: self.xfyunAsrCredentials) {
            case .blocked(let message):
                // 守卫不过 / 缺凭据：不产段、不消耗额度，仅提示。
                self.errorMessage = message
                return
            case .proceed(let xfyunCreds):
                creds = xfyunCreds
            }
            // 占位段（识别中）先上屏，再发识别请求（两分支同既有时序）。
            let id = self.nextSegmentId
            self.nextSegmentId += 1
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            self.appendSegment(CaptionSegment(id: id, source: "", state: .transcribing, at: now))

            let outcome = await LiveCaptionAsrDispatch.transcribe(
                samples: samples,
                language: language,
                decision: decision,
                xfyunCredentials: creds,
                deps: LiveCaptionAsrDispatch.Deps(
                    gateway: self.gatewayTranscriber,
                    xfyunCredentials: self.xfyunAsrCredentials,
                    xfyun: self.xfyunTranscriber
                )
            )
            switch outcome {
            case .failed(let segmentSource, let banner):
                self.updateSegment(id: id) { seg in
                    seg.source = seg.source.isEmpty ? segmentSource : seg.source
                    seg.state = .failed
                }
                if let banner {
                    self.errorMessage = banner
                }
            case .empty:
                // gateway 没识别出内容：移除占位段，不打断后续（LiveCaptionApp.tsx:156-159）。
                self.removeSegment(id: id)
            case .text(let text):
                // 讯飞分支存量行为（零改动）：空白句直接完成（杂音句）。gateway 分支按
                // Windows 只判空串（已由 .empty 收口），非空即进翻译。
                let blank = decision.engine == .xfyun
                    && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                self.updateSegment(id: id) { seg in
                    seg.source = text
                    if blank {
                        seg.state = .done
                        seg.target = nil
                    } else {
                        seg.state = .translating
                    }
                }
                if !blank {
                    self.translateSegment(id: id, source: text, direction: dir)
                }
            }
        }
    }

    /// 句级翻译：译向用该句入口定格的方向（对齐 `buildCaptionSystemPrompt(dir)`）。
    private func translateSegment(id: Int, source: String, direction dir: CaptionDirection) {
        let system = buildCaptionSystemPrompt(direction: dir)
        let translator = captionTranslator
        Task { [weak self] in
            guard let self else { return }
            do {
                let translated: String
                if let translator {
                    translated = try await translator(system, source)
                } else {
                    translated = try await self.chat.complete(systemPrompt: system, userText: source)
                }
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        guard seg.state == .translating || seg.state == .transcribing else { return }
                        seg.target = translated
                        seg.state = .done
                    }
                }
            } catch {
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        // 失败段保留原文
                        seg.state = .failed
                    }
                }
            }
        }
    }

    private func appendSegment(_ segment: CaptionSegment) {
        segments.append(segment)
        if segments.count > Self.displayLimit {
            segments.removeFirst(segments.count - Self.displayLimit)
        }
    }

    private func removeSegment(id: Int) {
        segments.removeAll { $0.id == id }
    }

    private func updateSegment(id: Int, mutate: (inout CaptionSegment) -> Void) {
        guard let idx = segments.firstIndex(where: { $0.id == id }) else { return }
        mutate(&segments[idx])
        segments = segments  // 触发 @Published
    }

    // MARK: - 导出 / 清空

    var exportMeta: CaptionExportMeta {
        CaptionExportMeta(
            direction: direction,
            startedAt: startedAt,
            endedAt: endedAt == 0 ? Int64(Date().timeIntervalSince1970 * 1000) : endedAt
        )
    }

    func exportMarkdown() -> String {
        buildCaptionMarkdown(segments, meta: exportMeta)
    }

    func exportPlainText() -> String {
        buildCaptionPlainText(segments, meta: exportMeta)
    }

    func clearSegments() {
        guard !recording else { return }
        segments = []
        // settings-ui-3：nextSegmentId 保持单调递增、不归零——停止录音 flush 出的
        // 尾句 Task 仍在网络等待中，归零会让新会话从 0 重新取号，旧 Task 完成后按
        // 旧 id 回写/删除会命中新会话同 id 的段（覆盖文字/译文、误删占位）。计数
        // 单调后旧 id 不再复用，回写自然落空成 no-op。
        startedAt = 0
        endedAt = 0
    }
}

// MARK: - 句级转写分派（对齐 LiveCaptionApp.handleUtterance 的引擎分支，可单测）

/// 录音直译一句的引擎分派：off→守卫 hint 不识别不产段；xfyun→凭据检查 + 原样
/// message（存量行为零改动：段内「（识别失败）」+ 顶部错误条）；gateway→REST 转写
/// + §二错误文案映射（额度类拼重置时间；非信封/静默错误落通用兜底），失败文案
/// 按 Windows 写进段内「〔识别失败：…〕」（LiveCaptionApp.tsx:143-154）。
enum LiveCaptionAsrDispatch {
    /// 识别前置检查结果。
    enum Precheck: Equatable {
        /// 放行（xfyun 分支带已检查的凭据；gateway 为 nil）。
        case proceed(XfyunCredentials?)
        /// 守卫不过 / 缺凭据：不开麦不识别不产段，仅提示。
        case blocked(String)
    }

    enum Outcome: Equatable {
        /// 识别成功（讯飞可为空白串：杂音句由调用方按存量 done 收尾；gateway 恒非空）。
        case text(String)
        /// gateway 没识别出内容（空串）：调用方移除占位段、不打断后续
        ///（对齐 LiveCaptionApp.tsx:156-159 的 `if (!text)`；讯飞分支不走这里，零改动）。
        case empty
        /// 识别失败：段落文本 + 可选顶部错误条（gateway 无错误条，文案在段内）。
        case failed(segmentSource: String, banner: String?)
    }

    struct Deps {
        var gateway: (VoiceAsrLang, [Float]) async throws -> String
        var xfyunCredentials: () -> XfyunCredentials?
        var xfyun: ([Float], AsrLanguage, XfyunCredentials) async throws -> String
    }

    /// 前置检查：off → 引导；xfyun 缺凭据 → 既有讯飞文案；其余放行。
    static func precheck(decision: VoiceRouteDecision, xfyunCredentials: () -> XfyunCredentials?) -> Precheck {
        switch decision.engine {
        case .off:
            return .blocked(decision.hint ?? "语音识别暂不可用")
        case .xfyun:
            guard let creds = xfyunCredentials() else {
                return .blocked("未配置听写凭据：设置 → 语音")
            }
            return .proceed(creds)
        case .gateway:
            return .proceed(nil)
        }
    }

    /// gateway 错误展示文案（§二映射；silent/internal 空串落通用兜底）。
    static func gatewayErrorText(_ error: Error) -> String {
        let display = voiceErrorDisplayText(error as? VoiceErrorLike ?? VoiceError(code: "unknown"))
        return display.isEmpty ? "服务暂时不可用，请稍后再试" : display
    }

    static func transcribe(
        samples: [Float],
        language: AsrLanguage,
        decision: VoiceRouteDecision,
        xfyunCredentials: XfyunCredentials? = nil,
        deps: Deps
    ) async -> Outcome {
        switch decision.engine {
        case .off:
            // 调用方应先过 precheck；防御：不识别。
            return .failed(segmentSource: "（识别失败）", banner: decision.hint ?? "语音识别暂不可用")
        case .xfyun:
            guard let creds = xfyunCredentials ?? deps.xfyunCredentials() else {
                return .failed(segmentSource: "（识别失败）", banner: "未配置听写凭据：设置 → 语音")
            }
            do {
                return .text(try await deps.xfyun(samples, language, creds))
            } catch {
                // 讯飞分支保留原始 message（既有行为，零改动）。
                return .failed(
                    segmentSource: "（识别失败）",
                    banner: (error as? LocalizedError)?.errorDescription ?? "\(error)"
                )
            }
        case .gateway:
            let text: String
            do {
                let lang = VoiceAsrLang(rawValue: language.rawValue) ?? .zh_cn
                text = try await deps.gateway(lang, samples)
            } catch {
                return .failed(segmentSource: "〔识别失败：\(gatewayErrorText(error))〕", banner: nil)
            }
            // Windows 只判空串（`!text`，不 trim）：空串移除占位段，其余照常进翻译。
            return text.isEmpty ? .empty : .text(text)
        }
    }
}
