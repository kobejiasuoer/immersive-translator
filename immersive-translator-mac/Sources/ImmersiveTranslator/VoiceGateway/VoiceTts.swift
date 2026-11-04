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
private final class TtsConnection {
    private let deps: TtsDeps
    private var ws: VoiceWebSocket?
    private var opened = false

    init(deps: TtsDeps) {
        self.deps = deps
    }

    func acquire() async throws -> VoiceWebSocket {
        if let current = ws, current.readyState == 1 {
            return current
        }
        // 现调现用：拿票到建连之间不插长耗时操作（契约红线）。
        let ticket = try await deps.acquireTicket()
        let url = try buildWsUrl(path: "/v1/voice/tts/stream", query: [(key: "ticket", value: ticket)])
        let created = deps.wsFactory(url)
        try await waitOpen(created)
        opened = true
        ws = created
        return created
    }

    /// 等握手完成；握手被拒（票无效/已用）报 voice_ticket_invalid。
    private func waitOpen(_ ws: VoiceWebSocket) async throws {
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
    sleep: @escaping (Double) async -> Void
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

// MARK: - 模块级串行队列 + 消费口

/// 流式合成消费口：模块级串行（前一次未结束则排队）。mp3 分片经 onChunk 按序
/// 回调，全部片段完成回调 onEnd（一次）；失败回调 onError（一次），已播分片不回滚。
enum GatewayTts {
    /// 模块级单例状态（连接 + 串行链）可被多个消费点并发调用：锁保护挂链动作本身
    /// （链内合成仍严格按调用序串行）。
    private static let lock = NSLock()
    private static var connection: TtsConnection?
    private static var chain = Task {}

    static func synthesize(
        text: String,
        voice: String?,
        volume: Double?,
        onChunk: @escaping (Data) -> Void,
        onEnd: @escaping () -> Void,
        onError: @escaping (VoiceError) -> Void,
        deps: TtsDeps = TtsDeps()
    ) {
        // 连接是模块级单例；deps 仅在首次创建时生效（单测注入 wsFactory/timeoutMs）。
        lock.lock()
        defer { lock.unlock() }
        if connection == nil {
            connection = TtsConnection(deps: deps)
        }
        let conn = connection!
        let previous = chain
        chain = Task {
            _ = await previous.value
            do {
                try await runSynthesis(
                    conn: conn,
                    text: text,
                    voice: voice,
                    volume: volume,
                    onChunk: onChunk,
                    onEnd: onEnd,
                    deps: deps
                )
            } catch let error as VoiceError {
                onError(error)
            } catch {
                onError(VoiceError(code: "network_error", message: error.localizedDescription))
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
        deps: TtsDeps
    ) async throws {
        let pieces = splitTtsText(text)
        if pieces.isEmpty {
            onEnd()
            return
        }
        let timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : ttsPieceTimeoutMs
        var ws = try await conn.acquire()
        var retried = false
        var index = 0
        while index < pieces.count {
            let piece = pieces[index]
            do {
                try await runPiece(
                    ws: ws,
                    piece: piece,
                    voice: voice,
                    volume: volume,
                    onChunk: onChunk,
                    timeoutMs: timeoutMs,
                    sleep: deps.sleep
                )
                index += 1
            } catch {
                let code = (error as? VoiceError)?.code ?? "network_error"
                guard isRetryableTtsCode(code), !retried else { throw error }
                // 重试 1 次：丢弃连接换票重建，重发当前片；片内已收的分片不重放（防重复播放）。
                retried = true
                conn.drop()
                ws = try await conn.acquire()
            }
        }
        onEnd()
    }

    /// 单测隔离用。
    static func resetForTests() {
        lock.lock()
        defer { lock.unlock() }
        connection = nil
        chain = Task {}
    }
}
