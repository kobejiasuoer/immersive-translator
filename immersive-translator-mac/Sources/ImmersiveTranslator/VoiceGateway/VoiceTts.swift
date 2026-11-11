import Combine
import Foundation

// ---------------------------------------------------------------------------
// 流式 TTS 客户端（WSS /v1/voice/tts/stream，契约 §一/§四）：
// 对齐 Windows src/lib/voice/voiceTts.ts：
// - 上行只有 text 帧 {"type":"synthesis","text","voice"?,"volume"?}（绝不发 binary）；
// - 下行 binary mp3 分片（按序交给 onChunk）+ {"type":"end"} / error 帧；
// - 文本 UTF-8 字节超限自动按句拆分（splitTtsText），片内逐片顺序合成；
// - 同连接多次 synthesis 按序不并发（模块级串行队列）；error 帧后连接不断可继续；
// - 上游类失败（upstream_error/upstream_timeout/断连）重试 1 次，仍失败终局（§二）；
//   REST 录音上传则相反——失败不自动重试（VoiceRest，录音是隐私）。
// - ticket 现调现用；连接空闲由服务端心跳回收，下次合成 readyState 检测后自动
//   换票重连。
// - 生产路径按账号隔离（Windows 300247a ProductionContext）：入队时捕获登录账号
//   生成取消句柄，切号/登出广播中止全部在途请求并丢弃模块级连接（ticket 归属在
//   服务端握手时固定，旧连接不能给新账号复用）；acquire / 每片合成前 / onEnd 前
//   核对身份，不符抛 token_invalid。deps 注入的协议单测路径跳过身份核验
//  （Windows 同口径：deps === undefined 才走生产上下文）。
// ---------------------------------------------------------------------------

/// 单片合成看门狗：服务端上游超时约在数十秒量级，客户端 30s 无 end 视为 upstream_timeout。
let ttsPieceTimeoutMs = 30_000.0

struct TtsDeps {
    var wsFactory: (String) -> VoiceWebSocket = { VoiceGatewayRuntime.shared.makeWebSocket(url: $0) }
    var acquireTicket: () async throws -> String = { try await SharedVoiceTicket.shared().acquire() }
    /// 看门狗时长（秒；单测缩短用）。
    var timeoutMs: Double = ttsPieceTimeoutMs
    /// 看门狗等待（生产 Task.sleep；单测注入即时返回）。
    var sleep: (Double) async -> Void = { seconds in
        if seconds > 0 {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    }
}

/// 可重试一次的上游类失败（§二：重试 1 次，仍失败「请稍后再试」）。
private func isRetryableTtsCode(_ code: String) -> Bool {
    code == "upstream_error" || code == "upstream_timeout" || code == "voice_disconnected"
        || code == "voice_ticket_invalid" || code == "network_error"
}

// MARK: - 连接管理（健康复用 / 换票新建）

/// 取可用连接：健康则复用（多次 synthesis 按序），否则换票新建（并发建连单飞）。
/// 生产路径带身份核对（verifyAuth 在拿票/建连/握手各异步边界调用）与中止句柄
/// （切号广播时在途握手立即失败）。
private final class TtsConnection {
    private let deps: TtsDeps
    private var ws: VoiceWebSocket?
    private var opened = false

    init(deps: TtsDeps) {
        self.deps = deps
    }

    func acquire(
        verifyAuth: (() async throws -> Void)? = nil,
        abortFlag: TtsAbortFlag? = nil
    ) async throws -> VoiceWebSocket {
        try await verifyAuth?()
        if let current = ws, current.readyState == 1 {
            return current
        }
        // 现调现用：拿票到建连之间不插长耗时操作（契约红线）。
        let ticket = try await deps.acquireTicket()
        try await verifyAuth?()
        let url = try buildWsUrl(path: "/v1/voice/tts/stream", query: [(key: "ticket", value: ticket)])
        try await verifyAuth?()
        let created = deps.wsFactory(url)
        // 握手尚未完成时也要能在账号变化后关闭这个连接。
        ws = created
        try await waitOpen(created, abortFlag: abortFlag)
        try await verifyAuth?()
        opened = true
        return created
    }

    /// 等握手完成；握手被拒（票无效/已用）报 voice_ticket_invalid；
    /// 中止句柄触发（切号）报 token_invalid。
    private func waitOpen(_ ws: VoiceWebSocket, abortFlag: TtsAbortFlag?) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            let resumeOnce: (Error?) -> Void = { error in
                guard !resumed else { return }
                resumed = true
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            let abort = {
                resumeOnce(VoiceError(code: "token_invalid"))
            }
            if let abortFlag, abortFlag.aborted {
                abort()
                return
            }
            abortFlag?.setOnAbort(abort)
            ws.onOpen = { resumeOnce(nil) }
            ws.onClose = { _, _ in
                resumeOnce(VoiceError(code: "voice_ticket_invalid"))
            }
            ws.onError = { /* 原因在 onClose */ }
            ws.open()
        }
    }

    /// 丢弃当前连接（重试前调用；下次 acquire 自动换票重建）。
    func drop() {
        ws?.close(code: 1000, reason: "retry")
        ws = nil
        opened = false
    }
}

// MARK: - 单片合成

/// 上行 synthesis 帧（唯一上行形态，绝不发 binary）：与 JS
/// `JSON.stringify({type, text, voice?, volume?})` 逐字同形——键序固定、`/` 不转义；
/// voice/volume 缺省不发（服务端回落管理台配置）。
func ttsSynthesisFrame(text: String, voice: String?, volume: Double?) -> String {
    var frame = "{\"type\":\"synthesis\",\"text\":\(voiceJsonString(text))"
    if let voice, !voice.isEmpty {
        frame += ",\"voice\":\(voiceJsonString(voice))"
    }
    if let volume, volume.isFinite {
        frame += ",\"volume\":\(voiceJsonNumberLiteral(volume))"
    }
    return frame + "}"
}

/// 一片合成：发 synthesis 帧 → 收 binary 交给 onChunk → end 结算。
/// error 帧 / 断连 / 看门狗超时都 reject（VoiceError）。上行帧 voice/volume
/// 缺省不发（服务端回落管理台配置）。
private func runPiece(
    ws: VoiceWebSocket,
    piece: String,
    voice: String?,
    volume: Double?,
    onChunk: @escaping (Data) -> Void,
    timeoutMs: Double,
    sleep: @escaping (Double) async -> Void,
    abortFlag: TtsAbortFlag? = nil
) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let state = PieceState(ws: ws, continuation: continuation, onChunk: onChunk)
        let watchdog = Task {
            await sleep(timeoutMs / 1000.0)
            state.finish(VoiceError(code: "upstream_timeout"))
        }
        state.watchdog = watchdog
        let text = ttsSynthesisFrame(text: piece, voice: voice, volume: volume)
        ws.onMessage = { message in
            guard case .text(let raw) = message else {
                if case .data(let data) = message { onChunk(data) }
                return
            }
            guard let data = raw.data(using: .utf8),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return // 非 JSON，防御性忽略
            }
            let type = frame["type"] as? String
            if type == "end" {
                state.finish(nil)
            } else if type == "error", let code = frame["code"] as? String {
                let details = frame["details"] as? [String: Any] ?? [:]
                state.finish(VoiceError(code: code, details: details))
            }
        }
        ws.onClose = { _, _ in
            state.finish(VoiceError(code: "voice_disconnected"))
        }
        // 切号广播：当前片立即以 token_invalid 结算（看门狗/回调一并清场）。
        if let abortFlag {
            if abortFlag.aborted {
                state.finish(VoiceError(code: "token_invalid"))
                return
            }
            abortFlag.setOnAbort {
                state.finish(VoiceError(code: "token_invalid"))
            }
        }
        ws.sendText(text)
    }
}

/// 一片合成的结算状态（防多重 resume：end/error/断连/看门狗竞态）。
private final class PieceState {
    let ws: VoiceWebSocket
    private let continuation: CheckedContinuation<Void, Error>
    private let onChunk: (Data) -> Void
    var watchdog: Task<Void, Never>?
    private var settled = false
    private let lock = NSLock()

    init(ws: VoiceWebSocket, continuation: CheckedContinuation<Void, Error>, onChunk: @escaping (Data) -> Void) {
        self.ws = ws
        self.continuation = continuation
        self.onChunk = onChunk
    }

    func finish(_ error: Error?) {
        lock.lock()
        guard !settled else {
            lock.unlock()
            return
        }
        settled = true
        lock.unlock()
        watchdog?.cancel()
        ws.onMessage = nil
        ws.onClose = nil
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }
}

// MARK: - 生产身份上下文（切号隔离，对齐 Windows voiceTts.ts ProductionContext）

/// 在途生产合成的中止句柄（Windows AbortController.signal 的同构物）：账号变化
/// 广播时置位，各异步边界（握手 / 每片合成）检查后抛 token_invalid。
final class TtsAbortFlag {
    private let lock = NSLock()
    private var _aborted = false
    /// 中止回调（挂起的握手 continuation 恢复用；置位后设置也立即触发）。
    private var _onAbort: (() -> Void)?

    var aborted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _aborted
    }

    func abort() {
        lock.lock()
        _aborted = true
        let handler = _onAbort
        _onAbort = nil
        lock.unlock()
        handler?()
    }

    /// 注册中止回调；已置位则立即调用。
    func setOnAbort(_ handler: @escaping () -> Void) {
        lock.lock()
        if _aborted {
            lock.unlock()
            handler()
            return
        }
        _onAbort = handler
        lock.unlock()
    }
}

/// 一次生产合成的身份上下文：入队时捕获的账号 + 中止句柄。
private struct TtsProductionContext {
    var identity: String
    var epoch: Int
    var abortFlag: TtsAbortFlag
}

/// 生产合成身份簿记（MainActor 单例）：订阅 AppAuthStatusCenter 广播，
/// 身份变化时中止全部在途请求并丢弃模块级连接。
@MainActor
private final class TtsAuthIdentityMonitor {
    static let shared = TtsAuthIdentityMonitor()

    /// 已广播状态里的账号 id（未登录 nil）。
    private(set) var identity: String?
    private var installed = false
    private var cancellable: AnyCancellable?

    static func identityOf(_ status: AuthStatus) -> String? {
        guard status.loggedIn, let id = status.user?.id, !id.isEmpty else { return nil }
        return id
    }

    /// 首次生产合成时安装订阅（惰性：协议单测/未接线时不依赖登录态广播）。
    func installIfNeeded() {
        guard !installed else { return }
        installed = true
        if let status = AppAuthStatusCenter.shared.status {
            identity = Self.identityOf(status)
        }
        cancellable = AppAuthStatusCenter.shared.$status.sink { status in
            guard let status else { return }
            Task { @MainActor in
                TtsAuthIdentityMonitor.shared.apply(Self.identityOf(status))
            }
        }
    }

    /// 身份变化：中止全部在途 controller + 丢弃模块级连接
    ///（ticket 归属在握手时固定，切号后旧连接/旧排队任务都不能再用）。
    func apply(_ next: String?) {
        guard identity != next else { return }
        identity = next
        epoch += 1
        for flag in inFlightFlags {
            flag.abort()
        }
        inFlightFlags.removeAll()
        GatewayTts.dropConnectionForIdentityChange()
    }

    var epoch = 0
    private var inFlightFlags: [TtsAbortFlag] = []

    func register(_ flag: TtsAbortFlag) {
        inFlightFlags.append(flag)
    }

    func unregister(_ flag: TtsAbortFlag) {
        inFlightFlags.removeAll { $0 === flag }
    }

    /// 单测隔离：切断订阅与身份记忆（重置后下一次 capture 重新安装）。
    func resetForTests() {
        epoch += 1
        for flag in inFlightFlags {
            flag.abort()
        }
        inFlightFlags.removeAll()
        identity = nil
        cancellable?.cancel()
        cancellable = nil
        installed = false
    }
}

/// 当前登录身份（MainActor 现查 AppAuthStatusCenter；未接线/未广播按未登录）。
private func currentTtsAuthIdentity() async -> String? {
    await MainActor.run {
        TtsAuthIdentityMonitor.shared.installIfNeeded()
        return TtsAuthIdentityMonitor.shared.identity
    }
}

/// 入队时捕获身份并生成中止句柄；未登录/广播中身份已变化抛 token_invalid
/// （Windows captureProductionContext 同语义）。
private func captureTtsProductionContext() async throws -> TtsProductionContext {
    let capturedEpoch = await MainActor.run { () -> Int in
        TtsAuthIdentityMonitor.shared.installIfNeeded()
        return TtsAuthIdentityMonitor.shared.epoch
    }
    let identity = await currentTtsAuthIdentity()
    let currentEpoch = await MainActor.run { TtsAuthIdentityMonitor.shared.epoch }
    if currentEpoch != capturedEpoch {
        throw VoiceError(code: "token_invalid")
    }
    guard let identity else {
        throw VoiceError(code: "token_invalid")
    }
    let flag = TtsAbortFlag()
    await MainActor.run { TtsAuthIdentityMonitor.shared.register(flag) }
    return TtsProductionContext(identity: identity, epoch: currentEpoch, abortFlag: flag)
}

/// 各异步边界核对身份：句柄已中止（切号广播）或现查身份与入队时不符 → token_invalid。
private func verifyTtsProductionContext(_ context: TtsProductionContext) async throws {
    if context.abortFlag.aborted {
        throw VoiceError(code: "token_invalid")
    }
    let identity = await currentTtsAuthIdentity()
    // await 期间广播可能已到：先复查句柄再比身份。
    if context.abortFlag.aborted {
        throw VoiceError(code: "token_invalid")
    }
    if identity != context.identity {
        throw VoiceError(code: "token_invalid")
    }
}

// MARK: - 模块级串行队列 + 消费口

/// 流式合成消费口：模块级串行（前一次未结束则排队）。mp3 分片经 onChunk 按序
/// 回调，全部片段完成回调 onEnd（一次）；失败回调 onError（一次），已播分片不回滚。
enum GatewayTts {
    /// 模块级单例状态（连接 + 串行链）可被多个消费点并发调用：锁保护挂链动作本身
    /// （链内合成仍严格按调用序串行）。
    private static let lock = NSLock()
    private static var connection: TtsConnection?
    private static var chain = Task {}

    /// 账号变化广播时丢弃连接（下次 acquire 自动换票重建；锁保护）。
    static func dropConnectionForIdentityChange() {
        lock.lock()
        defer { lock.unlock() }
        connection?.drop()
        connection = nil
    }

    /// 取（或建）模块级连接；同步方法避免在异步上下文里持锁。
    private static func connectionForDeps(_ deps: TtsDeps) -> TtsConnection {
        lock.lock()
        defer { lock.unlock() }
        if connection == nil {
            connection = TtsConnection(deps: deps)
        }
        return connection!
    }

    static func synthesize(
        text: String,
        voice: String?,
        volume: Double?,
        onChunk: @escaping (Data) -> Void,
        onEnd: @escaping () -> Void,
        onError: @escaping (VoiceError) -> Void,
        deps: TtsDeps? = nil
    ) {
        let resolvedDeps = deps ?? TtsDeps()
        // 在入队时捕获账号，避免 A 账号提交的排队文本在 B 账号下发送。
        // 注入 deps 的协议测试不依赖应用登录；生产默认路径（deps=nil）始终核对身份。
        let needsContext = deps == nil && !splitTtsText(text).isEmpty
        let previous = chain
        chain = Task {
            _ = await previous.value
            var context: TtsProductionContext?
            do {
                if needsContext {
                    context = try await captureTtsProductionContext()
                    try await verifyTtsProductionContext(context!)
                }
                // 连接是模块级单例；deps 仅在首次创建时生效（单测注入 wsFactory/timeoutMs）。
                let conn = connectionForDeps(resolvedDeps)
                try await runSynthesis(
                    conn: conn,
                    text: text,
                    voice: voice,
                    volume: volume,
                    onChunk: onChunk,
                    onEnd: onEnd,
                    deps: resolvedDeps,
                    context: context
                )
            } catch let error as VoiceError {
                onError(error)
            } catch {
                onError(VoiceError(code: "network_error", message: error.localizedDescription))
            }
            if let context {
                await MainActor.run { TtsAuthIdentityMonitor.shared.unregister(context.abortFlag) }
            }
        }
    }

    private static func runSynthesis(
        conn: TtsConnection,
        text: String,
        voice: String?,
        volume: Double?,
        onChunk: @escaping (Data) -> Void,
        onEnd: @escaping () -> Void,
        deps: TtsDeps,
        context: TtsProductionContext?
    ) async throws {
        let pieces = splitTtsText(text)
        if pieces.isEmpty {
            onEnd()
            return
        }
        let verifyAuth: (() async throws -> Void)? = context.map { ctx in
            { try await verifyTtsProductionContext(ctx) }
        }
        let abortFlag = context?.abortFlag
        let timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : ttsPieceTimeoutMs
        var ws = try await conn.acquire(verifyAuth: verifyAuth, abortFlag: abortFlag)
        var retried = false
        var index = 0
        while index < pieces.count {
            let piece = pieces[index]
            do {
                try await verifyAuth?()
                try await runPiece(
                    ws: ws,
                    piece: piece,
                    voice: voice,
                    volume: volume,
                    onChunk: onChunk,
                    timeoutMs: timeoutMs,
                    sleep: deps.sleep,
                    abortFlag: abortFlag
                )
                index += 1
            } catch {
                let code = (error as? VoiceError)?.code ?? "network_error"
                guard isRetryableTtsCode(code), !retried else { throw error }
                // 重试 1 次：丢弃连接换票重建，重发当前片；片内已收的分片不重放（防重复播放）。
                retried = true
                conn.drop()
                ws = try await conn.acquire(verifyAuth: verifyAuth, abortFlag: abortFlag)
            }
        }
        try await verifyAuth?()
        onEnd()
    }

    /// 单测隔离用。
    static func resetForTests() {
        lock.lock()
        defer { lock.unlock() }
        connection = nil
        chain = Task {}
        Task { @MainActor in
            TtsAuthIdentityMonitor.shared.resetForTests()
        }
    }
}
