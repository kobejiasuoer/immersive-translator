import Foundation

// ---------------------------------------------------------------------------
// 流式 ASR 客户端（WSS /v1/voice/asr/stream，契约 §一/§二）：
// 对齐 Windows src/lib/voice/voiceAsr.ts：
// - 上行：binary 16k/16bit/mono PCM（单帧 ≤128KB）+ text 帧 {"type":"start"|"stop"}；
// - 下行：{"type":"interim"|"final"|"error"}；final 后同连接可再 start（不必重连）；
// - ticket 现调现用绝不缓存；意外断开指数退避重连——重换票→新连接→重新 start，
//   断线期间音频内存缓冲（隐私红线：不落盘）待重连后重放；
// - 握手失败（拿不到 open 即关）按 voice_ticket_invalid 处理：重新换票再试一次，
//   仍失败给终局文案；error 帧按 §二 映射，不改写原始 code。
//
// Swift 落法：actor 隔离状态机（Windows 单线程 JS 的并发等价物）；WebSocket
// 回调先进一条 AsyncStream 事件管道、由单一泵任务按到达序逐个交给 actor——
// 保住 JS 事件循环的「open → interim → final → close」严格先后（每个回调各起一个
// Task 进 actor 不保证顺序，interim/final 可能倒置）。退避等待注入 sleep（单测缩到即时）。
// ---------------------------------------------------------------------------

/// 协议硬上限：单帧 ≤128KB（32KB/s 口径下约 4 秒，正常分帧远低于此）。
let asrMaxFrameBytes = 128 * 1024
/// 意外断开重连：1s 起步 ×2，封顶 15s；重试 6 次（累计约 45s）后给终局文案。
let asrReconnectBaseMs = 1000.0
let asrReconnectMaxMs = 15000.0
let asrMaxReconnects = 6
/// 断线期间音频缓冲上限：60s 会话的 PCM（32KB/s），超出丢最旧的（内存上限防呆）。
private let asrMaxPendingBytes = 60 * 32_000

func asrBackoffMs(attempt: Int) -> Double {
    min(asrReconnectBaseMs * pow(2, Double(attempt)), asrReconnectMaxMs)
}

struct AsrCallbacks {
    var onInterim: (String) -> Void
    var onFinal: (String, Double?) -> Void
    var onError: (VoiceError) -> Void
    /// 瞬时状态（换票重试/断线重连中），UI 展示「正在重试」文案。
    var onStatus: ((VoiceErrorInfo) -> Void)?
}

struct AsrDeps {
    var wsFactory: (String) -> VoiceWebSocket = { VoiceGatewayRuntime.shared.makeWebSocket(url: $0) }
    var acquireTicket: () async throws -> String = { try await SharedVoiceTicket.shared().acquire() }
    var backoffMs: (Int) -> Double = asrBackoffMs
    /// 退避等待（生产 Task.sleep；单测注入即时返回并记录延迟）。
    var sleep: (Double) async -> Void = { seconds in
        if seconds > 0 {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    }
}

actor AsrStreamSession {
    private enum State {
        case idle
        case connecting
        case open
        case closed
    }

    /// WebSocket 回调事件（携带来源连接，处理时按身份丢弃过期连接的迟到事件）。
    private enum WsEvent {
        case open(VoiceWebSocket)
        case message(VoiceWebSocket, String)
        case close(VoiceWebSocket, Int, String)
    }

    private let lang: VoiceAsrLang
    private let callbacks: AsrCallbacks
    private let deps: AsrDeps
    /// 事件管道（FIFO，单消费者）：保证回调处理顺序 = 到达顺序。
    private let events: AsyncStream<WsEvent>
    private let eventSink: AsyncStream<WsEvent>.Continuation
    private var eventPump: Task<Void, Never>?
    private var ws: VoiceWebSocket?
    private var state: State = .idle
    /// 本次连接是否完成过 open（区分握手失败与中途断开）。
    private var wsOpenedOnce = false
    /// start 已发、未收 final/error。
    private var utterance = false
    /// 开连后要发 start（连接建立期间的 start 请求挂起）。
    private var startWanted = false
    /// stop 已请求但 start 还没落地（开连后 start→立即 stop，服务端排队语义）。
    private var stopWanted = false
    /// 断线/未开连期间缓冲的音频（仅内存）。
    private var pending: [Data] = []
    private var pendingBytes = 0
    /// 握手失败已换票重试过一次（契约：再试一次，仍失败终局）。
    private var ticketRetried = false
    private var reconnectAttempt = 0
    private var closedByUs = false

    init(lang: VoiceAsrLang, callbacks: AsrCallbacks, deps: AsrDeps = AsrDeps()) {
        self.lang = lang
        self.callbacks = callbacks
        self.deps = deps
        var sink: AsyncStream<WsEvent>.Continuation?
        self.events = AsyncStream(bufferingPolicy: .unbounded) { sink = $0 }
        self.eventSink = sink!
    }

    deinit {
        eventSink.finish()
    }

    // ---------- 对外：开始/推音频/停止/释放 ----------

    /// 供模块单例判断：同 lang 且会话未终态时可复用现有连接续会话。
    func canResume(_ lang: VoiceAsrLang) -> Bool {
        self.lang == lang && state != .closed
    }

    /// 开始一轮识别：已有健康连接则同连接再 start（final 后续会话），否则换票建连。
    func requestStart() {
        guard state != .closed else { return }
        guard !utterance else { return } // 一轮进行中：幂等拦截（服务端对重复 start 回 voice_invalid_state）
        startWanted = true
        if state == .idle {
            // 状态先同步跃迁（JS 版 connect() 首行同步置 connecting 的等价物）：
            // 连续 requestStart 不会派生第二次建连。
            state = .connecting
            wsOpenedOnce = false
            Task { await self.connect() }
        } else if state == .open {
            beginUtterance()
        }
        // connecting：开连（onOpen）后统一 beginUtterance
    }

    /// 推一段设备音频（Float32 + 采样率），量化 16k/16bit 再上行。
    func pushAudio(_ pcm: [Float], sampleRate: Int) {
        guard state != .closed, !pcm.isEmpty, sampleRate > 0 else { return }
        let bytes = pcm16kBytes(pcm, inputRate: sampleRate)
        if utterance, let ws, ws.readyState == 1 {
            sendAudioFrames(bytes)
            return
        }
        if utterance || startWanted {
            bufferAudio(bytes)
        }
        // 无 start 请求却推音频：忽略（消费方契约是先 start 后推）。
    }

    /// 结束当前一轮：发 stop 等 final；没有进行中的一轮则直接释放连接。
    func requestStop() {
        guard state != .closed else { return }
        if utterance {
            stopWanted = true
            if let ws, ws.readyState == 1 {
                sendStop()
            }
            return
        }
        close()
    }

    /// 释放会话与连接（离开语音页时调用；终态，不可复用）。
    func close() {
        guard state != .closed else { return }
        closedByUs = true
        state = .closed
        pending = []
        pendingBytes = 0
        ws?.close(code: 1000, reason: "client-close")
        ws = nil
        eventSink.finish()
    }

    // ---------- 内部：建连 / 帧收发 / 重连 ----------

    private func connect() async {
        guard state != .closed else { return }
        state = .connecting
        wsOpenedOnce = false
        // 现调现用：拿票到建连之间只有 URL 拼装（契约红线）。
        let ws: VoiceWebSocket
        do {
            let ticket = try await deps.acquireTicket()
            guard state != .closed else { return }
            let url = try buildWsUrl(path: "/v1/voice/asr/stream", query: [(key: "ticket", value: ticket), (key: "lang", value: lang.rawValue)])
            ws = deps.wsFactory(url)
        } catch {
            await onConnectFailure(error)
            return
        }
        attach(ws)
    }

    private func attach(_ ws: VoiceWebSocket) {
        self.ws = ws
        startEventPumpIfNeeded()
        let sink = eventSink
        ws.onOpen = { [weak ws] in
            guard let ws else { return }
            sink.yield(.open(ws))
        }
        ws.onMessage = { [weak ws] message in
            guard let ws, case .text(let text) = message else { return } // ASR 下行无 binary 帧，防御性忽略
            sink.yield(.message(ws, text))
        }
        ws.onClose = { [weak ws] code, reason in
            guard let ws else { return }
            sink.yield(.close(ws, code, reason))
        }
        ws.onError = { /* 原因在随后的 onClose，不在 onError 里给 */ }
        ws.open()
    }

    /// 单一泵任务：按到达序把 WebSocket 事件逐个交给 actor（处理完一个再取下一个）。
    private func startEventPumpIfNeeded() {
        guard eventPump == nil else { return }
        let stream = events
        eventPump = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                await self.handle(event)
            }
        }
    }

    private func handle(_ event: WsEvent) {
        switch event {
        case .open(let source):
            handleOpen(ws: source)
        case .message(let source, let text):
            // 只认当前连接（过期连接的迟到帧丢弃；JS 版每条连接各挂各的处理器，同效）。
            guard let current = ws, current === source else { return }
            onServerFrame(raw: text)
        case .close(let source, let code, let reason):
            // 过期连接（已被换掉/主动关掉）的 close 不再影响当前状态机。
            guard let current = ws, current === source else { return }
            onWsClose(code: code, reason: reason)
        }
    }

    private func handleOpen(ws opened: VoiceWebSocket) {
        guard state != .closed else {
            opened.close(code: 1000, reason: "")
            return
        }
        // 过期连接迟到的 open：关掉，不改写当前状态。
        guard let current = ws, current === opened else {
            opened.close(code: 1000, reason: "")
            return
        }
        wsOpenedOnce = true
        ticketRetried = false
        state = .open
        // 全新 start 请求，或断线重连后正在进行的会话（重新 start + 重放缓冲）。
        if startWanted || utterance {
            beginUtterance()
        }
    }

    private func beginUtterance() {
        guard let ws, state == .open else { return }
        startWanted = false
        utterance = true
        ws.sendText("{\"type\":\"start\"}")
        let buffered = pending
        pending = []
        pendingBytes = 0
        for bytes in buffered {
            sendAudioFrames(bytes)
        }
        if stopWanted {
            sendStop()
        }
    }

    /// 发 stop 帧；stopWanted 保持到 final/error 才清，断线重连后据此补发。
    private func sendStop() {
        guard let ws else { return }
        ws.sendText("{\"type\":\"stop\"}")
    }

    private func sendAudioFrames(_ bytes: Data) {
        guard let ws else { return }
        if bytes.count <= asrMaxFrameBytes {
            ws.sendData(bytes)
            return
        }
        // 超过硬上限的外部大块：切帧（正常 4096 样本块远低于此，防御外部调用）。
        var offset = 0
        while offset < bytes.count {
            let end = min(offset + asrMaxFrameBytes, bytes.count)
            ws.sendData(bytes.subdata(in: offset..<end))
            offset = end
        }
    }

    private func bufferAudio(_ bytes: Data) {
        pending.append(bytes)
        pendingBytes += bytes.count
        while pendingBytes > asrMaxPendingBytes, !pending.isEmpty {
            let dropped = pending.removeFirst()
            pendingBytes -= dropped.count
        }
    }

    private func onServerFrame(raw: String) {
        guard let data = raw.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return // 非 JSON 文本帧，防御性忽略
        }
        let type = frame["type"] as? String
        if type == "interim", let text = frame["text"] as? String {
            // 服务端真实出结果：链路是工作的，重连退避清零。
            reconnectAttempt = 0
            callbacks.onInterim(text)
            return
        }
        if type == "final", let text = frame["text"] as? String {
            reconnectAttempt = 0
            utterance = false
            stopWanted = false
            callbacks.onFinal(text, voiceJsonNumber(frame["durationMs"]))
            return
        }
        if type == "error", let code = frame["code"] as? String {
            onServerErrorFrame(code: code, frame: frame)
        }
    }

    /// error 帧：会话终结（utterance 复位），连接一般仍可用（服务端不断开）。
    private func onServerErrorFrame(code: String, frame: [String: Any]) {
        utterance = false
        stopWanted = false
        let details = frame["details"] as? [String: Any] ?? [:]
        callbacks.onError(VoiceError(code: code, details: details))
    }

    private func onWsClose(code: Int, reason: String) {
        ws = nil
        guard state != .closed, !closedByUs else { return }
        if !wsOpenedOnce {
            // 握手失败（票无效/过期/被用）：换票立即再试一次，仍失败终局（§二）。
            if ticketRetried {
                failTerminal("voice_ticket_invalid")
                return
            }
            ticketRetried = true
            if let onStatus = callbacks.onStatus {
                onStatus(voiceErrorMessage(VoiceError(code: "voice_ticket_invalid")))
            }
            Task { await self.connect() }
            return
        }
        // 意外断开（1006 等）：指数退避，重换票→新连接→重新 start（§二）。
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard state != .closed else { return }
        state = .idle
        guard reconnectAttempt < asrMaxReconnects else {
            failTerminal("voice_disconnected")
            return
        }
        let delayMs = deps.backoffMs(reconnectAttempt)
        reconnectAttempt += 1
        if let onStatus = callbacks.onStatus {
            onStatus(voiceErrorMessage(VoiceError(code: "voice_disconnected")))
        }
        Task {
            await deps.sleep(delayMs / 1000.0)
            await self.connect()
        }
    }

    /// 建连/取票失败：鉴权类终局，其余（网络/限流）并入退避重连。
    /// 分类口径与 Windows `err instanceof VoiceError ? err.code : "network_error"`
    /// 逐字对齐（voiceAsr.ts:331-342，Mac VoiceTts 同款）：只认 VoiceError 自带的
    /// code（服务端信封 banned/quota_exceeded/voice_not_configured 等）；传输层抛出的
    /// 其它错误——含鉴权管理器的 AuthError（Windows 侧为 IPC 拒绝的普通对象，同样
    /// 不是 VoiceError 实例）——一律按 network_error 并入退避，退避耗尽终局
    /// voice_disconnected。登录失效本身由鉴权管理器清凭据并经账号态呈现。
    private func onConnectFailure(_ error: Error) async {
        guard state != .closed else { return }
        let code = (error as? VoiceError)?.code ?? "network_error"
        switch code {
        case "token_invalid", "token_reused", "unauthorized", "banned", "quota_exceeded", "voice_not_configured":
            state = .closed
            closedByUs = true
            eventSink.finish()
            callbacks.onError(error as? VoiceError ?? VoiceError(code: code))
        default:
            state = .idle
            scheduleReconnect()
        }
    }

    /// 终局：给错误并进入 closed（调用方需重新 startStreamingAsr）。
    private func failTerminal(_ code: String) {
        state = .closed
        closedByUs = true
        eventSink.finish()
        callbacks.onError(VoiceError(code: code))
    }
}

// ---------------------------------------------------------------------------
// 模块级消费口（契约 §四：startStreamingAsr / pushAudioChunk / stopAsr）
// ---------------------------------------------------------------------------

enum StreamingAsr {
    /// 模块级单例：语音页同一时刻至多一路识别。
    private static var session: AsrStreamSession?

    /// 开始（或续）一轮流式识别。同一 lang 且连接健康时复用现有连接（final 后续
    /// 会话）；换 lang 或连接已死时重建。识别进行中重复调用为幂等 no-op（服务端
    /// 对重复 start 回 voice_invalid_state，客户端状态机先行拦下）。
    static func start(
        lang: VoiceAsrLang,
        onInterim: @escaping (String) -> Void,
        onFinal: @escaping (String, Double?) -> Void,
        onError: @escaping (VoiceError) -> Void,
        onStatus: ((VoiceErrorInfo) -> Void)? = nil
    ) async {
        if let existing = session, await existing.canResume(lang) {
            await existing.requestStart()
            return
        }
        await session?.close()
        let created = AsrStreamSession(
            lang: lang,
            callbacks: AsrCallbacks(onInterim: onInterim, onFinal: onFinal, onError: onError, onStatus: onStatus)
        )
        session = created
        await created.requestStart()
    }

    /// 推送设备音频（Float32 + 设备采样率；Mac MicRecorder 输出已 16k）。未在识别中则忽略。
    static func push(_ pcm: [Float], sampleRate: Int = 16000) async {
        await session?.pushAudio(pcm, sampleRate: sampleRate)
    }

    /// 结束当前一轮（等 final）；没有进行中的一轮则释放连接。
    static func stop() async {
        await session?.requestStop()
    }

    /// 释放连接与单例（离开语音页）。
    static func closeStream() async {
        await session?.close()
        session = nil
    }

    /// 单测隔离用。
    static func resetForTests() async {
        await session?.close()
        session = nil
    }
}
