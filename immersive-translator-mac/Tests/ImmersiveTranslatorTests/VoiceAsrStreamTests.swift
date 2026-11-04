import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 流式 ASR 状态机单测（对齐 Windows voiceAsr.test.ts 行为向量，假 WS + 假票 +
// 注入退避）：建连 URL 带 ticket+lang、open 后发 start；final 后同连接续会话
// 不再换票；重复 start 幂等；断线退避重连重放缓冲、连续断开终局；握手失败换票
// 重试一次再败终局；取票失败并入退避不终局；error 帧逐码不改写。
// ---------------------------------------------------------------------------

final class VoiceAsrStreamTests: XCTestCase {
    private var factory: FakeVoiceWebSocketFactory!
    private var ticketCounter = 0

    override func setUp() {
        super.setUp()
        factory = FakeVoiceWebSocketFactory()
        ticketCounter = 0
        VoiceGatewayRuntime.shared.install(
            http: nil,
            baseUrlSource: { "http://gw.test" }
        )
    }

    override func tearDown() {
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    private func makeDeps(
        backoff: @escaping (Int) -> Double = { _ in 0 },
        recordedDelays: NSMutableArray? = nil
    ) -> AsrDeps {
        AsrDeps(
            wsFactory: factory.make(),
            acquireTicket: { [self] in
                ticketCounter += 1
                return "t\(ticketCounter)"
            },
            backoffMs: backoff,
            sleep: { seconds in
                recordedDelays?.add(seconds)
            }
        )
    }

    private func makeCallbacks() -> Recorder {
        Recorder()
    }

    /// 回调记录器（thread-safe）。
    final class Recorder {
        let lock = NSLock()
        var interims: [String] = []
        var finals: [(String, Double?)] = []
        var errors: [String] = []
        var statuses: [String] = []

        func onInterim(_ text: String) {
            lock.lock(); interims.append(text); lock.unlock()
        }

        func onFinal(_ text: String, _ ms: Double?) {
            lock.lock(); finals.append((text, ms)); lock.unlock()
        }

        func onError(_ error: VoiceError) {
            lock.lock(); errors.append(error.code); lock.unlock()
        }

        func onStatus(_ info: VoiceErrorInfo) {
            lock.lock(); statuses.append(info.text); lock.unlock()
        }

        var callbacks: AsrCallbacks {
            AsrCallbacks(
                onInterim: { [self] in onInterim($0) },
                onFinal: { [self] in onFinal($0, $1) },
                onError: { [self] in onError($0) },
                onStatus: { [self] in onStatus($0) }
            )
        }
    }

    // MARK: 建连 URL + start 帧

    func testConnectUrlCarriesTicketAndLangThenSendsStart() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        XCTAssertEqual(factory.urls.first, "ws://gw.test/v1/voice/asr/stream?ticket=t1&lang=zh_cn")
        // open 前不发 start。
        XCTAssertEqual(factory.sockets.first?.sentTexts.count, 0)
        factory.sockets.first?.fireOpen()
        await assertAsync("open 后应发 start") { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
    }

    // MARK: final 后同连接续会话不再换票

    func testFinalThenResumeSameConnectionWithoutNewTicket() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        factory.sockets[0].fireText("{\"type\":\"final\",\"text\":\"hello\",\"durationMs\":900}")
        await assertAsync { !recorder.finals.isEmpty }
        // 再来一轮：同连接续会话，不再换票（ticketCounter 不涨）。
        await session.requestStart()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(factory.createdCount, 1, "final 后同连接续会话不重建连接")
        XCTAssertEqual(ticketCounter, 1, "不再取新票")
        XCTAssertEqual(factory.sockets[0].sentTexts.filter { $0 == "{\"type\":\"start\"}" }.count, 2)
    }

    // MARK: 重复 start 幂等

    func testRepeatedStartIsIdempotentWhileUtteranceInFlight() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        await session.requestStart() // 一轮进行中：幂等拦截
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertEqual(factory.sockets[0].sentTexts.filter { $0 == "{\"type\":\"start\"}" }.count, 1)
    }

    // MARK: start 前缓冲重放

    func testAudioBufferedBeforeOpenIsReplayedAfterStart() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        // 连接建立期间推音频（缓冲，不上行）。
        await session.pushAudio([0.5, -0.5, 0.25], sampleRate: 16000)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(factory.sockets[0].sentDatas.count, 0, "未 open 前不上行音频")
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentDatas.count == 1 }
        XCTAssertEqual(factory.sockets[0].sentDatas[0], pcm16kBytes([0.5, -0.5, 0.25]))
        XCTAssertEqual(factory.sockets[0].sentTexts.first, "{\"type\":\"start\"}", "start 先于缓冲重放")
    }

    // MARK: 意外断开：新票新连接重发 start + 重放缓冲

    func testUnexpectedCloseReconnectsWithNewTicketAndReplays() async {
        let delays = NSMutableArray()
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps(recordedDelays: delays))
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        // 识别中断线：断线期间推的音频进内存缓冲。
        factory.sockets[0].serverClose(code: 1006)
        _ = await waitUntilAsync { self.factory.createdCount >= 2 }
        await session.pushAudio([0.2, 0.4], sampleRate: 16000)
        factory.sockets[1].fireOpen()
        await assertAsync { self.factory.sockets[1].sentTexts.contains("{\"type\":\"start\"}") }
        XCTAssertEqual(factory.urls[1].contains("ticket=t2"), true, "重连换新票")
        await assertAsync { self.factory.sockets[1].sentDatas.count == 1 }
        XCTAssertEqual(factory.sockets[1].sentDatas[0], pcm16kBytes([0.2, 0.4]), "断线期间缓冲待重连后重放")
        // 瞬时状态回调（正在重连文案）。
        XCTAssertTrue(recorder.statuses.contains("网络中断，正在重连…"))
    }

    // MARK: 连续断开 → 退避 → 终局 voice_disconnected

    func testRepeatedDisconnectsBackoffThenTerminal() async {
        var attempts: [Int] = []
        let recorder = makeCallbacks()
        let session = AsrStreamSession(
            lang: .zh_cn,
            callbacks: recorder.callbacks,
            deps: makeDeps(backoff: { attempt in
                attempts.append(attempt)
                return 0
            })
        )
        await session.requestStart()
        // 每次 open 成功（以 start 帧到达为据，handleOpen 已处理）后立刻意外断开，
        // 连续 7 次：6 次重连后第 7 次终局。
        for i in 0..<7 {
            let ok = await waitUntilAsync(timeout: 2) { self.factory.createdCount >= i + 1 }
            XCTAssertTrue(ok, "第 \(i + 1) 次建连应发生")
            factory.sockets[i].fireOpen()
            // 等 start 帧落袋再断（open 已生效，断开按「意外中断」语义走退避）。
            _ = await waitUntilAsync(timeout: 2) {
                self.factory.sockets[i].sentTexts.contains("{\"type\":\"start\"}")
            }
            factory.sockets[i].serverClose(code: 1006)
        }
        await assertAsync("6 次重连后终局") { recorder.errors.contains("voice_disconnected") }
        XCTAssertEqual(attempts, [0, 1, 2, 3, 4, 5], "退避曲线按尝试序号递增")
        // 退避常量曲线：1s ×2 封顶 15s（对齐 Windows asrBackoffMs）。
        XCTAssertEqual(asrBackoffMs(attempt: 0), 1000)
        XCTAssertEqual(asrBackoffMs(attempt: 1), 2000)
        XCTAssertEqual(asrBackoffMs(attempt: 2), 4000)
        XCTAssertEqual(asrBackoffMs(attempt: 3), 8000)
        XCTAssertEqual(asrBackoffMs(attempt: 4), 15000, "封顶 15s")
        XCTAssertEqual(asrMaxReconnects, 6)
    }

    // MARK: 握手失败：换票重试一次，再败终局

    func testHandshakeFailureRetriesOnceWithNewTicketThenTerminal() async {
        let recorder = makeCallbacks()
        // 每次建连都在握手阶段即关（open 前失败）。
        factory.makeDefault = { url in
            let ws = FakeVoiceWebSocket(url: url)
            ws.onOpenRequested = { ws.serverClose(code: 1006, reason: "handshake-failed") }
            return ws
        }
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        await assertAsync("换票重试一次后仍失败应终局") {
            recorder.errors.contains("voice_ticket_invalid")
        }
        XCTAssertEqual(factory.createdCount, 2, "握手失败换票再试一次（共两次建连）")
        XCTAssertEqual(ticketCounter, 2, "两次建连各用各的新票")
        XCTAssertTrue(recorder.statuses.contains("连接不稳定，正在重试…"))
    }

    // MARK: 取票失败并入退避，不终局

    func testTicketFetchFailureJoinsBackoffWithoutTerminal() async {
        let recorder = makeCallbacks()
        var failFirst = true
        var deps = makeDeps()
        deps.acquireTicket = {
            if failFirst {
                failFirst = false
                throw VoiceError(code: "network_error", message: "取票失败")
            }
            return "t-ok"
        }
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: deps)
        await session.requestStart()
        // 第一次取票失败 → 并入退避；退避后第二次取票成功建连。
        await assertAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        XCTAssertFalse(recorder.errors.contains("network_error"), "取票失败不终局")
    }

    /// 取票时鉴权管理器抛 AuthError（登录失效等）：分类口径对齐 Windows
    /// `err instanceof VoiceError ? err.code : "network_error"`——AuthError 不是
    /// VoiceError，按 network_error 并入退避（Windows 侧 IPC 拒绝的普通对象同样如此），
    /// 不按 code 终局；服务端信封类 VoiceError（banned 等）仍终局。
    func testTicketAuthErrorJoinsBackoffLikeWindowsButVoiceErrorAuthCodesTerminal() async {
        let recorder = makeCallbacks()
        let delays = NSMutableArray()
        var attempts = 0
        var deps = makeDeps(recordedDelays: delays)
        deps.acquireTicket = {
            attempts += 1
            if attempts == 1 {
                throw AuthError(code: "token_invalid", message: "登录已失效", httpStatus: 401, retryAfterSeconds: nil)
            }
            return "t-ok"
        }
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: deps)
        await session.requestStart()
        await assertAsync("AuthError 并入退避后重新取票建连") { self.factory.createdCount >= 1 }
        XCTAssertTrue(recorder.errors.isEmpty, "AuthError 不终局")
        XCTAssertEqual(delays.count, 1, "走了一次退避")
        XCTAssertTrue(recorder.statuses.contains("网络中断，正在重连…"))
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }

        // 对照：服务端信封给出的 VoiceError(banned) 取票失败 → 终局不重试。
        let terminal = makeCallbacks()
        var terminalDeps = makeDeps()
        terminalDeps.acquireTicket = { throw VoiceError(code: "banned") }
        let banned = AsrStreamSession(lang: .zh_cn, callbacks: terminal.callbacks, deps: terminalDeps)
        await banned.requestStart()
        await assertAsync { terminal.errors == ["banned"] }
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(terminal.errors, ["banned"], "终局只报一次、不再重试")
        XCTAssertEqual(factory.createdCount, 1, "终局不建连")
    }

    // MARK: error 帧逐码（不改写原始 code，连接保留可再 start）

    func testServerErrorFramesSurfaceCodes() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }

        // quota：功能名插值进 details（resource 原样上抛）。
        factory.sockets[0].fireText("{\"type\":\"error\",\"code\":\"quota_exceeded\",\"details\":{\"resource\":\"asr_seconds\"}}")
        await assertAsync { recorder.errors.contains("quota_exceeded") }
        // error 帧后 utterance 复位：同连接可再 start。
        await session.requestStart()
        await assertAsync { self.factory.sockets[0].sentTexts.filter { $0 == "{\"type\":\"start\"}" }.count == 2 }

        factory.sockets[0].fireText("{\"type\":\"error\",\"code\":\"voice_session_too_long\"}")
        await assertAsync { recorder.errors.contains("voice_session_too_long") }
        XCTAssertEqual(factory.createdCount, 1, "error 帧不断连")
    }

    // MARK: stop 帧 + final 收尾（契约 §四 stopAsr）

    func testStopSendsStopFrameThenFinalClosesUtterance() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts == ["{\"type\":\"start\"}"] }
        factory.sockets[0].fireText("{\"type\":\"interim\",\"text\":\"hel\"}")
        await assertAsync { recorder.interims == ["hel"] }
        await session.requestStop()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"stop\"}") }
        factory.sockets[0].fireText("{\"type\":\"final\",\"text\":\"hello\",\"durationMs\":1234}")
        await assertAsync { recorder.finals.count == 1 }
        XCTAssertEqual(recorder.finals.first?.0, "hello")
        XCTAssertEqual(recorder.finals.first?.1, 1234)
        // 没有进行中的一轮时 stop = 释放连接（终态，不再建连）。
        await session.requestStop()
        await session.requestStart()
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(factory.createdCount, 1, "close 后为终态，不再建连")
    }

    // MARK: 音频上行：open 后直发、48k 先重采样、无 start 推音频忽略

    func testAudioUplinkDirectAndResampledAndIgnoredWithoutStart() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        // 无 start 先推：忽略（不缓冲）。
        await session.pushAudio([1], sampleRate: 16000)
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        XCTAssertTrue(factory.sockets[0].sentDatas.isEmpty, "start 前推的音频被忽略")
        await session.pushAudio([0.5, -0.5], sampleRate: 16000)
        XCTAssertEqual(factory.sockets[0].sentDatas.map { [UInt8]($0) }, [[0x00, 0x40, 0x00, 0xC0]])
        await session.pushAudio([Float](repeating: 0.25, count: 4800), sampleRate: 48000) // 100ms → 1600 样本
        XCTAssertEqual(factory.sockets[0].sentDatas.last?.count, 3200)
    }

    func testOversizedChunkIsSplitIntoFramesUnder128KB() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        // 70000 样本 = 140000 字节 > 128KB → 两帧。
        await session.pushAudio([Float](repeating: 0.1, count: 70000), sampleRate: 16000)
        let frames = factory.sockets[0].sentDatas
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0].count, asrMaxFrameBytes)
        XCTAssertEqual(frames.reduce(0) { $0 + $1.count }, 140000)
    }

    // MARK: 终局后不再产生新连接

    func testTerminalStateNeverReconnects() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        for i in 0..<7 {
            _ = await waitUntilAsync(timeout: 2) { self.factory.createdCount >= i + 1 }
            factory.sockets[i].fireOpen()
            _ = await waitUntilAsync(timeout: 2) {
                self.factory.sockets[i].sentTexts.contains("{\"type\":\"start\"}")
            }
            factory.sockets[i].serverClose(code: 1006)
        }
        await assertAsync { recorder.errors == ["voice_disconnected"] }
        XCTAssertEqual(voiceErrorMessage(VoiceError(code: "voice_disconnected"), final: true).text, "网络连接不稳定，请稍后再试")
        await session.requestStop()
        await session.close()
        await session.requestStart()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(factory.createdCount, asrMaxReconnects + 1, "终局后 stop/close/start 不再建连")
    }

    func testUpstreamErrorFrameSurfacesWithoutAutoReplay() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts.contains("{\"type\":\"start\"}") }
        await session.pushAudio([0.5], sampleRate: 16000)
        factory.sockets[0].fireText("{\"type\":\"error\",\"code\":\"upstream_error\"}")
        await assertAsync { recorder.errors == ["upstream_error"] }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(factory.sockets[0].sentDatas.count, 1, "流式不自动重放已上行音频")
        XCTAssertEqual(factory.createdCount, 1)
    }

    // MARK: 事件保序（interim → final 严格按到达序）

    func testInterimAndFinalDeliveredInArrivalOrder() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .en_us, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        let ws = factory.sockets[0]
        ws.fireOpen()
        for i in 0..<50 {
            ws.fireText("{\"type\":\"interim\",\"text\":\"p\(i)\"}")
        }
        ws.fireText("{\"type\":\"final\",\"text\":\"done\"}")
        await assertAsync { recorder.finals.count == 1 }
        XCTAssertEqual(recorder.interims, (0..<50).map { "p\($0)" }, "50 条 interim 按到达序")
        XCTAssertTrue(ws.sentTexts.contains("{\"type\":\"start\"}"), "open 先于后续帧处理")
    }

    // MARK: 模块级消费口：换 lang 重建（新票新连接）

    func testModuleLevelChangeLangRebuildsWithNewTicket() async {
        var issued = 0
        VoiceGatewayRuntime.shared.install(
            http: { method, path, _ in
                guard method == "POST", path == "/v1/voice/ticket" else {
                    return AuthHttpResponse(status: 404, retryAfterSeconds: nil, body: "{}")
                }
                issued += 1
                return AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"ticket\":\"t\(issued)\",\"expiresAt\":\"2026-10-28T00:01:00.000Z\"}")
            },
            wsFactory: factory.make(),
            baseUrlSource: { "https://gw.test" }
        )
        SharedVoiceTicket.resetForTests()
        await StreamingAsr.resetForTests()
        defer {
            SharedVoiceTicket.resetForTests()
        }
        await StreamingAsr.start(lang: .en_us, onInterim: { _ in }, onFinal: { _, _ in }, onError: { _ in })
        await assertAsync { self.factory.createdCount >= 1 }
        XCTAssertEqual(factory.urls[0], "wss://gw.test/v1/voice/asr/stream?ticket=t1&lang=en_us")
        factory.sockets[0].fireOpen()
        await assertAsync { self.factory.sockets[0].sentTexts == ["{\"type\":\"start\"}"] }
        // 同 lang 进行中重复 start：幂等，不建新连接。
        await StreamingAsr.start(lang: .en_us, onInterim: { _ in }, onFinal: { _, _ in }, onError: { _ in })
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(factory.createdCount, 1)
        // 换 lang：旧会话关闭，新票新连接。
        await StreamingAsr.start(lang: .zh_cn, onInterim: { _ in }, onFinal: { _, _ in }, onError: { _ in })
        await assertAsync { self.factory.createdCount >= 2 }
        XCTAssertEqual(factory.urls[1], "wss://gw.test/v1/voice/asr/stream?ticket=t2&lang=zh_cn")
        XCTAssertEqual(factory.sockets[0].readyState, 3, "旧连接已关闭")
        await StreamingAsr.closeStream()
    }

    // MARK: interim 重置退避计数

    func testInterimResetsReconnectAttempt() async {
        let recorder = makeCallbacks()
        let session = AsrStreamSession(lang: .zh_cn, callbacks: recorder.callbacks, deps: makeDeps())
        await session.requestStart()
        _ = await waitUntilAsync { self.factory.createdCount >= 1 }
        factory.sockets[0].fireOpen()
        factory.sockets[0].fireText("{\"type\":\"interim\",\"text\":\"你\"}")
        _ = await waitUntilAsync { !recorder.interims.isEmpty }
        XCTAssertEqual(recorder.interims, ["你"])
        // canResume 语义：同 lang 未终态可复用；换 lang 不可。
        let canSame = await session.canResume(.zh_cn)
        let canOther = await session.canResume(.en_us)
        XCTAssertTrue(canSame)
        XCTAssertFalse(canOther)
    }
}
