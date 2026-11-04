import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 流式 TTS 单测（对齐 Windows voiceTts.test.ts 行为向量，假 WS + 假票）：
// 短文本 synthesis 帧（缺省 voice/volume 不上行）→ binary → end → onEnd 一次；
// voice/volume 随帧；超长按句拆分片序上行、onEnd 恰一次；quota error 不重试；
// upstream 重试 1 次（换票重建、已 end 片不重放）；重试仍败终局；看门狗超时；
// 排队按序；空文本不建连。
// ---------------------------------------------------------------------------

final class VoiceTtsTests: XCTestCase {
    private var factory: FakeVoiceWebSocketFactory!
    private var ticketCounter = 0

    override func setUp() {
        super.setUp()
        factory = FakeVoiceWebSocketFactory()
        // TTS 建连在 waitOpen 内完成握手：open() 即自动触发 onOpen。
        factory.makeDefault = { url in
            let ws = FakeVoiceWebSocket(url: url)
            ws.autoOpenOnRequest()
            return ws
        }
        ticketCounter = 0
        GatewayTts.resetForTests()
        VoiceGatewayRuntime.shared.install(
            http: nil,
            baseUrlSource: { "http://gw.test" }
        )
    }

    override func tearDown() {
        GatewayTts.resetForTests()
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    /// 看门狗 sleep 注入：挂起直到被取消（对齐「无 end 即超时」的确定性等待）。
    private var deps: TtsDeps {
        TtsDeps(
            wsFactory: factory.make(),
            acquireTicket: { [self] in
                ticketCounter += 1
                return "t\(ticketCounter)"
            },
            timeoutMs: 30_000,
            sleep: { _ in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
        )
    }

    private func framePayload(_ text: String) throws -> [String: Any] {
        let data = try XCTUnwrap(factory.sockets.first?.sentTexts.first?.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: 短文本：帧序 → binary → end → onEnd 一次

    func testShortTextSendsSynthesisFrameThenBinaryThenEnd() async throws {
        var chunks: [Data] = []
        var ended = 0
        var failures: [String] = []
        GatewayTts.synthesize(
            text: "你好。",
            voice: nil,
            volume: nil,
            onChunk: { chunks.append($0) },
            onEnd: { ended += 1 },
            onError: { failures.append($0.code) },
            deps: deps
        )
        await assertAsync { self.factory.createdCount >= 1 }
        XCTAssertEqual(factory.urls.first, "ws://gw.test/v1/voice/tts/stream?ticket=t1")
        await assertAsync { !self.factory.sockets[0].sentTexts.isEmpty }
        let payload = try framePayload("unused")
        XCTAssertEqual(payload["type"] as? String, "synthesis")
        XCTAssertEqual(payload["text"] as? String, "你好。")
        XCTAssertNil(payload["voice"], "缺省 voice 不上行")
        XCTAssertNil(payload["volume"], "缺省 volume 不上行")

        factory.sockets[0].fireData(Data([0x01, 0x02]))
        factory.sockets[0].fireData(Data([0x03]))
        factory.sockets[0].fireText("{\"type\":\"end\"}")
        await assertAsync { ended == 1 }
        XCTAssertEqual(chunks.count, 2, "binary 分片按序交给 onChunk")
        XCTAssertEqual(chunks[0], Data([0x01, 0x02]))
        XCTAssertEqual(chunks[1], Data([0x03]))
        XCTAssertTrue(failures.isEmpty)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(ended, 1, "onEnd 恰一次")
    }

    // MARK: voice / volume 随帧上行

    func testVoiceAndVolumeRideTheFrame() async throws {
        var ended = false
        GatewayTts.synthesize(
            text: "Hi.",
            voice: "v9",
            volume: 0.5,
            onChunk: { _ in },
            onEnd: { ended = true },
            onError: { _ in },
            deps: deps
        )
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        let data = try XCTUnwrap(factory.sockets[0].sentTexts.first?.data(using: .utf8))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(payload["voice"] as? String, "v9")
        XCTAssertEqual(payload["volume"] as? Double, 0.5)
        factory.sockets[0].fireText("{\"type\":\"end\"}")
        await assertAsync { ended }
    }

    // MARK: 超长按句拆分：片序上行、onEnd 恰一次

    func testLongTextSplitIntoOrderedPieces() async throws {
        // 长中文段落（26000+ 字节 > 7900 拆分上限）→ 必然多片。
        let sentence = String(repeating: "这是一句用来拆分的中文句子。", count: 2000) // 单片超限硬切
        let text = "第一段。\(sentence)第二段。"
        var ended = 0
        GatewayTts.synthesize(
            text: text,
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: { ended += 1 },
            onError: { _ in },
            deps: deps
        )
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        let socket = factory.sockets[0]
        let expectedPieces = splitTtsText(text)
        XCTAssertGreaterThan(expectedPieces.count, 1)
        // 逐片应答 end，观察下一片是否按序上行。
        for (index, piece) in expectedPieces.enumerated() {
            await assertAsync { socket.sentTexts.count >= index + 1 }
            let raw = try XCTUnwrap(socket.sentTexts[index].data(using: .utf8))
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
            XCTAssertEqual(payload["text"] as? String, piece, "第 \(index) 片按序上行")
            socket.fireText("{\"type\":\"end\"}")
        }
        await assertAsync { ended == 1 }
        XCTAssertEqual(ticketCounter, 1, "全部片共用同一连接（不换票）")
    }

    // MARK: quota error 不重试

    func testQuotaErrorDoesNotRetry() async {
        var failures: [String] = []
        var ended = false
        GatewayTts.synthesize(
            text: "你好。",
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: { ended = true },
            onError: { failures.append($0.code) },
            deps: deps
        )
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        factory.sockets[0].fireText("{\"type\":\"error\",\"code\":\"quota_exceeded\",\"details\":{\"resource\":\"tts_chars\"}}")
        await assertAsync { !failures.isEmpty }
        XCTAssertEqual(failures, ["quota_exceeded"])
        XCTAssertEqual(factory.createdCount, 1, "quota 不重试（不换票重建）")
        XCTAssertFalse(ended)
    }

    // MARK: upstream 重试 1 次：换票重建、已 end 片不重放

    func testUpstreamErrorRetriesOnceWithFreshConnection() async throws {
        let sentence = String(repeating: "长句内容。", count: 2000) // 保证拆两片以上
        let text = "第一句短。\(sentence)"
        var ended = 0
        var failures: [String] = []
        GatewayTts.synthesize(
            text: text,
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: { ended += 1 },
            onError: { failures.append($0.code) },
            deps: deps
        )
        await assertAsync { self.factory.createdCount >= 1 }
        let socket1 = factory.sockets[0]
        await assertAsync { !socket1.sentTexts.isEmpty }
        let pieces = splitTtsText(text)
        XCTAssertGreaterThanOrEqual(pieces.count, 2)
        // 第一片正常 end（已 end 片不重放）。
        socket1.fireText("{\"type\":\"end\"}")
        // 第二片 upstream_error → 丢弃连接换票重建重发当前片。
        _ = await waitUntilAsync { socket1.sentTexts.count >= 2 }
        socket1.fireText("{\"type\":\"error\",\"code\":\"upstream_error\"}")
        await assertAsync { self.factory.createdCount >= 2 }
        XCTAssertEqual(ticketCounter, 2, "重试换新票")
        let socket2 = factory.sockets[1]
        await assertAsync { !socket2.sentTexts.isEmpty }
        // 新连接只重发第二片起的内容，不含已 end 的第一片。
        let firstFrame = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(socket2.sentTexts.first?.data(using: .utf8))) as? [String: Any])
        XCTAssertEqual(firstFrame["text"] as? String, pieces[1])
        XCTAssertEqual(socket2.sentTexts.count, 1, "尚未继续第三片（等第二片 end）")
        // 剩余片在新连接上按序收尾（socket2 的第 j 帧对应 pieces[j+1]）。
        for j in 0..<(pieces.count - 1) {
            await assertAsync { socket2.sentTexts.count >= j + 1 }
            socket2.fireText("{\"type\":\"end\"}")
        }
        await assertAsync { ended == 1 }
        XCTAssertTrue(failures.isEmpty)
    }

    func testRetryStillFailingIsTerminal() async {
        var failures: [String] = []
        var ended = false
        GatewayTts.synthesize(
            text: "你好。",
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: { ended = true },
            onError: { failures.append($0.code) },
            deps: deps
        )
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        factory.sockets[0].fireText("{\"type\":\"error\",\"code\":\"upstream_timeout\"}")
        await assertAsync { self.factory.createdCount >= 2 }
        factory.sockets[1].fireText("{\"type\":\"error\",\"code\":\"upstream_timeout\"}")
        await assertAsync { !failures.isEmpty }
        XCTAssertEqual(failures, ["upstream_timeout"], "重试 1 次仍失败终局")
        XCTAssertEqual(factory.createdCount, 2)
        XCTAssertFalse(ended)
    }

    // MARK: 看门狗超时（注入短 timeout + 真实时钟）

    func testWatchdogTimeoutWhenNoEndArrives() async {
        var failures: [String] = []
        let shortDeps = TtsDeps(
            wsFactory: factory.make(),
            acquireTicket: { "t1" },
            timeoutMs: 40,
            sleep: { seconds in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
        )
        GatewayTts.synthesize(
            text: "你好。",
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: {},
            onError: { failures.append($0.code) },
            deps: shortDeps
        )
        await assertAsync(timeout: 3) { !failures.isEmpty }
        XCTAssertEqual(failures, ["upstream_timeout"], "30s 看门狗（测试缩短到 40ms）无 end 视为超时")
    }

    // MARK: 排队按序

    func testRequestsQueueInOrder() async throws {
        var order: [String] = []
        let queued = TtsDeps(
            wsFactory: factory.make(),
            acquireTicket: { "t1" },
            timeoutMs: 30_000,
            sleep: { _ in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
        )
        GatewayTts.synthesize(text: "甲。", voice: nil, volume: nil, onChunk: { _ in }, onEnd: { order.append("first") }, onError: { _ in }, deps: queued)
        GatewayTts.synthesize(text: "乙。", voice: nil, volume: nil, onChunk: { _ in }, onEnd: { order.append("second") }, onError: { _ in }, deps: queued)
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        // 第一个未结算前，第二个不建连不发送（模块级串行队列）。
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(factory.createdCount, 1)
        XCTAssertEqual(factory.sockets[0].sentTexts.count, 1)
        factory.sockets[0].fireText("{\"type\":\"end\"}")
        await assertAsync { self.factory.sockets[0].sentTexts.count >= 2 }
        XCTAssertEqual(factory.sockets[0].sentTexts.count, 2, "前一结束才发下一个（同连接复用）")
        factory.sockets[0].fireText("{\"type\":\"end\"}")
        await assertAsync { order == ["first", "second"] }
    }

    // MARK: 上行帧逐字（对齐 Windows JSON.stringify 断言）

    func testSynthesisFrameMatchesJsonStringifyExactly() {
        XCTAssertEqual(ttsSynthesisFrame(text: "Hello cloud", voice: nil, volume: nil), "{\"type\":\"synthesis\",\"text\":\"Hello cloud\"}")
        XCTAssertEqual(ttsSynthesisFrame(text: "Hi", voice: "alvin", volume: 80), "{\"type\":\"synthesis\",\"text\":\"Hi\",\"voice\":\"alvin\",\"volume\":80}")
        XCTAssertEqual(ttsSynthesisFrame(text: "a/b \"q\"\n", voice: "", volume: 0.5), "{\"type\":\"synthesis\",\"text\":\"a/b \\\"q\\\"\\n\",\"volume\":0.5}", "空音色不上行；/ 不转义")
        XCTAssertEqual(ttsSynthesisFrame(text: "x", voice: nil, volume: .nan), "{\"type\":\"synthesis\",\"text\":\"x\"}", "非有限音量不上行")
    }

    func testShortTextFrameIsExactJson() async {
        var ended = false
        GatewayTts.synthesize(text: "Hello cloud", voice: nil, volume: nil, onChunk: { _ in }, onEnd: { ended = true }, onError: { _ in }, deps: deps)
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        XCTAssertEqual(factory.sockets[0].sentTexts, ["{\"type\":\"synthesis\",\"text\":\"Hello cloud\"}"])
        XCTAssertTrue(factory.sockets[0].sentDatas.isEmpty, "TTS 上行绝不发 binary")
        factory.sockets[0].fireText("{\"type\":\"end\"}")
        await assertAsync { ended }
    }

    // MARK: 第二片断连 → 重试 1 次：已 end 的片不重放、已播分片不重复回调

    func testSecondPieceDisconnectRetriesWithoutReplayingEndedPiece() async throws {
        let sentence = String(repeating: "word ", count: 800) + ". " // 约 4002 字节
        let text = sentence + sentence
        var chunks: [Data] = []
        var ended = 0
        var failures: [String] = []
        GatewayTts.synthesize(
            text: text,
            voice: nil,
            volume: nil,
            onChunk: { chunks.append($0) },
            onEnd: { ended += 1 },
            onError: { failures.append($0.code) },
            deps: deps
        )
        await assertAsync { !self.factory.sockets.isEmpty && !self.factory.sockets[0].sentTexts.isEmpty }
        let first = factory.sockets[0]
        first.fireData(Data([1, 2, 3]))
        first.fireText("{\"type\":\"end\"}") // 第一片完成
        await assertAsync { first.sentTexts.count == 2 }
        XCTAssertEqual(factory.createdCount, 1)
        // 第二片进行中断连（1006）。
        first.serverClose(code: 1006)
        await assertAsync { self.factory.createdCount >= 2 }
        let second = factory.sockets[1]
        await assertAsync { !second.sentTexts.isEmpty }
        // 只重发第二片（第一片不重放），帧内容与断连前那一帧一致。
        XCTAssertEqual(second.sentTexts.count, 1)
        XCTAssertEqual(second.sentTexts[0], first.sentTexts.last)
        second.fireText("{\"type\":\"end\"}")
        await assertAsync { ended == 1 }
        XCTAssertEqual(chunks.count, 1, "已播分片不重复回调")
        XCTAssertTrue(failures.isEmpty)
        XCTAssertEqual(ticketCounter, 2, "重试换新票重建")
    }

    // MARK: 空文本不建连

    func testEmptyTextDoesNotConnect() async {
        var ended = false
        GatewayTts.synthesize(
            text: "   \n  ",
            voice: nil,
            volume: nil,
            onChunk: { _ in },
            onEnd: { ended = true },
            onError: { _ in },
            deps: deps
        )
        await assertAsync { ended }
        XCTAssertEqual(factory.createdCount, 0, "纯空白文本直接 onEnd，不建连")
    }
}
