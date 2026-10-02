import XCTest
@testable import XfyunCore

/// Edge 在线合成协议层（edgeTts.test.ts 的对应物）：
/// 签名对齐 / 请求帧构造 / 二进制帧解析 / 合成主链路 / 校准重试编排。
/// transport 与 calibrate 全部注入桩，零真网络。

final class EdgeTtsTests: XCTestCase {
    // MARK: - Sec-MS-GEC 签名

    func testEdgeTokenTicksAlignsToWindow() {
        // 纪元差对齐：1970-01-01 的 filetime ticks（windows 纪元 1601-01-01）
        XCTAssertEqual(edgeTokenTicks(nowMs: 0, skewSeconds: 0), 116444736000000000)
        // 100s 不出 5 分钟窗口 → ticks 不变
        XCTAssertEqual(edgeTokenTicks(nowMs: 100_000, skewSeconds: 0), 116444736000000000)
        // skew 301s 跨过窗口边界 → 进位到下一窗口（+300s）
        XCTAssertEqual(edgeTokenTicks(nowMs: 0, skewSeconds: 301), 116444739000000000)
    }

    func testSecMsGecKnownVector() {
        // 与 `printf '1164447360000000006A5AA1D4EAFF4E9FB37E23D68491D6F4' | shasum -a 256` 交叉核对
        XCTAssertEqual(
            secMsGecToken(ticks: 116444736000000000),
            "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"
        )
    }

    func testBuildEdgeWssURLContainsSignedQuery() {
        let url = buildEdgeWssURL(nowMs: 0, skewSeconds: 0)
        XCTAssertTrue(url.hasPrefix("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?"))
        XCTAssertTrue(url.contains("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"))
        XCTAssertTrue(url.contains("Sec-MS-GEC=7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"))
        XCTAssertTrue(url.contains("Sec-MS-GEC-Version=1-143.0.3650.75"))
    }

    // MARK: - 请求帧构造

    func testBuildEdgeSsmlMessage() {
        let frame = buildEdgeSsmlMessage(
            voice: "zh-CN-XiaoxiaoNeural",
            text: "a & b<c>d>",
            requestId: "AB12CD34",
            timestamp: "Mon Sep 29 2026 10:00:00 GMT+0800"
        )
        XCTAssertTrue(frame.hasPrefix(
            "X-RequestId:AB12CD34\r\nContent-Type:application/ssml+xml\r\n" +
            "X-Timestamp:Mon Sep 29 2026 10:00:00 GMT+0800\r\nPath:ssml\r\n\r\n"
        ))
        XCTAssertTrue(frame.contains("xml:lang='zh-CN'"))
        XCTAssertTrue(frame.contains("<voice name='zh-CN-XiaoxiaoNeural'>"))
        XCTAssertTrue(frame.contains("<prosody pitch='+0Hz' rate='+0%' volume='+0%'>"))
        XCTAssertTrue(frame.contains("a &amp; b&lt;c&gt;d&gt;"))
        XCTAssertTrue(frame.hasSuffix("</prosody></voice></speak>"))
    }

    func testBuildEdgeSpeechConfigMessage() {
        let frame = buildEdgeSpeechConfigMessage(timestamp: "ts")
        XCTAssertTrue(frame.hasPrefix("X-Timestamp:ts\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"))
        XCTAssertTrue(frame.contains("\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\""))
        XCTAssertTrue(frame.contains("\"sentenceBoundaryEnabled\":\"false\""))
        XCTAssertTrue(frame.contains("\"wordBoundaryEnabled\":\"true\""))
    }

    func testJsDateTimestampShape() {
        let text = jsDateTimestamp(Date(timeIntervalSince1970: 0))
        XCTAssertTrue(text.contains("GMT"))
        XCTAssertTrue(text.hasSuffix(")"))
        XCTAssertTrue(text.contains("1970") || text.contains("1969"))
    }

    // MARK: - 二进制帧解析

    private func makeEdgeBinaryFrame(header: String, payload: Data) -> Data {
        let headerBytes = Array(header.utf8)
        var frame = Data([UInt8((headerBytes.count >> 8) & 0xFF), UInt8(headerBytes.count & 0xFF)])
        frame.append(Data(headerBytes))
        frame.append(payload)
        return frame
    }

    private let audioHeader = "X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"

    func testParseEdgeBinaryFrameAudioPayload() {
        let payload = Data([0xFF, 0xFB, 0x90, 0x00])
        let parsed = parseEdgeBinaryFrame(makeEdgeBinaryFrame(header: audioHeader, payload: payload))
        XCTAssertEqual(parsed, payload)
    }

    func testParseEdgeBinaryFrameNonAudioHeaderReturnsNil() {
        let frame = makeEdgeBinaryFrame(header: "Content-Type:application/json\r\nPath:turn.start\r\n", payload: Data([1, 2]))
        XCTAssertNil(parseEdgeBinaryFrame(frame))
    }

    func testParseEdgeBinaryFrameMalformedReturnsNil() {
        // 过短（不足 2 字节头）
        XCTAssertNil(parseEdgeBinaryFrame(Data([0x00])))
        XCTAssertNil(parseEdgeBinaryFrame(Data()))
        // 头长声明超过实际长度
        let truncated = Data([0x00, 0x10]) + Data([0x61])
        XCTAssertNil(parseEdgeBinaryFrame(truncated))
    }

    // MARK: - 缓存键

    func testEdgeCacheKey() {
        XCTAssertEqual(
            edgeCacheKey(text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural")),
            "edge:en-US-AvaNeural|hello"
        )
        // 空音色回落缺省音色
        XCTAssertEqual(
            edgeCacheKey(text: "hello", opts: EdgeTtsOptions(voice: "")),
            "edge:zh-CN-XiaoxiaoNeural|hello"
        )
        // 跨文本 / 跨音色不同
        let base = edgeCacheKey(text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"))
        XCTAssertNotEqual(base, edgeCacheKey(text: "world", opts: EdgeTtsOptions(voice: "en-US-AvaNeural")))
        XCTAssertNotEqual(base, edgeCacheKey(text: "hello", opts: EdgeTtsOptions(voice: "en-US-AndrewNeural")))
    }

    // MARK: - 合成主链路（脚本化传输，对齐 edgeTts.test.ts 的 scripts 回放语义）

    /// 脚本化传输：每轮合成（connect→send→receive…）按预排脚本回放；
    /// receive 依次弹出本轮脚本，.error 抛 URLError（模拟连接被拒/断连，与真传输同构），
    /// 脚本耗尽继续 receive 也抛 URLError（模拟未收 turn.end 就断线）。
    private final class ScriptedEdgeTransport: EdgeTtsTransport {
        enum Step {
            case text(String)
            case data(Data)
            case error
        }

        private let rounds: [[Step]]
        private var round = 0
        private var index = 0
        private(set) var connectCount = 0
        private(set) var sent: [String] = []
        private(set) var closeCount = 0

        init(rounds: [[Step]]) {
            self.rounds = rounds
        }

        func connect(url: String) throws {
            connectCount += 1
            if connectCount > 1 { round += 1 }
            index = 0
        }

        func send(_ text: String) async throws {
            sent.append(text)
        }

        func receive() async throws -> EdgeTtsMessage {
            let steps = round < rounds.count ? rounds[round] : []
            guard index < steps.count else { throw URLError(.notConnectedToInternet) }
            defer { index += 1 }
            switch steps[index] {
            case .text(let text): return .text(text)
            case .data(let data): return .data(data)
            case .error: throw URLError(.notConnectedToInternet)
            }
        }

        func close() {
            closeCount += 1
        }
    }

    /// 校准桩：记录调用并返回预定结果（nil = 校准不可用）。
    private final class CalibrateStub: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [Int] = []
        let result: Int?

        init(result: Int?) {
            self.result = result
        }

        private func record(_ previousSkew: Int) {
            lock.lock()
            defer { lock.unlock() }
            calls.append(previousSkew)
        }

        func calibrate(_ previousSkew: Int) async -> Int? {
            record(previousSkew)
            return result
        }

        var callCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return calls.count
        }
    }

    private let turnEnd = "X-RequestId:abc\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\n\r\n{}"

    func testSynthesizeOnceMergesAudioChunksUntilTurnEnd() async throws {
        let chunk1 = Data([0x01, 0x02])
        let chunk2 = Data([0x03, 0x04, 0x05])
        let transport = ScriptedEdgeTransport(rounds: [[
            .data(makeEdgeBinaryFrame(header: audioHeader, payload: chunk1)),
            .data(makeEdgeBinaryFrame(header: audioHeader, payload: chunk2)),
            .text(turnEnd),
        ]])
        let data = try await synthesizeEdgeTtsOnce(
            text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: transport
        )
        XCTAssertEqual(data, chunk1 + chunk2)
        // 连上后先发 speech.config 再发 ssml
        XCTAssertEqual(transport.sent.count, 2)
        XCTAssertTrue(transport.sent[0].contains("Path:speech.config"))
        XCTAssertTrue(transport.sent[1].contains("Path:ssml"))
        XCTAssertTrue(transport.sent[1].contains("<voice name='en-US-AvaNeural'>"))
    }

    func testSynthesizeOnceSkipsNonAudioBinaryFrames() async throws {
        let payload = Data([0x0A, 0x0B])
        let transport = ScriptedEdgeTransport(rounds: [[
            .data(makeEdgeBinaryFrame(header: "Path:response\r\n", payload: Data([0xEE]))),
            .data(makeEdgeBinaryFrame(header: audioHeader, payload: payload)),
            .text(turnEnd),
        ]])
        let data = try await synthesizeEdgeTtsOnce(
            text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: transport
        )
        XCTAssertEqual(data, payload)
    }

    func testSynthesizeOnceThrowsEmptyAudio() async {
        let transport = ScriptedEdgeTransport(rounds: [[.text(turnEnd)]])
        do {
            _ = try await synthesizeEdgeTtsOnce(
                text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: transport
            )
            XCTFail("应抛 emptyAudio")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .emptyAudio)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
    }

    func testSynthesizeOnceMapsTransportErrorToConnectionRejected() async {
        // 无音频 → 连接被拒
        let rejected = ScriptedEdgeTransport(rounds: [[.error]])
        do {
            _ = try await synthesizeEdgeTtsOnce(
                text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: rejected
            )
            XCTFail("应抛 connectionRejected")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .connectionRejected)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
        // 已收音频后断线 → 提前断开
        let partial = ScriptedEdgeTransport(rounds: [[
            .data(makeEdgeBinaryFrame(header: audioHeader, payload: Data([0x01]))),
            .error,
        ]])
        do {
            _ = try await synthesizeEdgeTtsOnce(
                text: "hello", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: partial
            )
            XCTFail("应抛 partialAudio")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .partialAudio)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
    }

    func testSynthesizeOnceThrowsEmptyText() async {
        let transport = ScriptedEdgeTransport(rounds: [])
        do {
            _ = try await synthesizeEdgeTtsOnce(
                text: "   ", opts: EdgeTtsOptions(voice: "en-US-AvaNeural"), skewSeconds: 0, transport: transport
            )
            XCTFail("应抛 emptyText")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .emptyText)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
        XCTAssertEqual(transport.connectCount, 0)
    }

    // MARK: - 校准重试编排（A–E 五场景）

    /// A：首试败 → calibrate 返回新 skew → 二轮成 → 返回 (data, 新skew) 且两轮会话。
    func testRetryAfterCalibrationSucceeds() async throws {
        let payload = Data([0x11, 0x22])
        let transport = ScriptedEdgeTransport(rounds: [
            [.error],
            [.data(makeEdgeBinaryFrame(header: audioHeader, payload: payload)), .text(turnEnd)],
        ])
        let stub = CalibrateStub(result: 301)
        let result = try await synthesizeEdgeTts(
            text: "hello",
            opts: EdgeTtsOptions(voice: "en-US-AvaNeural"),
            skewSeconds: 0,
            transport: transport,
            calibrate: { prev in await stub.calibrate(prev) }
        )
        XCTAssertEqual(result.data, payload)
        XCTAssertEqual(result.skewSeconds, 301)
        XCTAssertEqual(transport.connectCount, 2)
        XCTAssertEqual(stub.callCount, 1)
        XCTAssertEqual(transport.sent.count, 4)  // 两轮各两条文本帧
    }

    /// B：calibrate 返回与旧 skew 同值 → 不重试（仅一轮）→ 上抛首次错误。
    func testNoRetryWhenCalibrationReturnsSameSkew() async {
        let transport = ScriptedEdgeTransport(rounds: [[.error]])
        let stub = CalibrateStub(result: 0)
        do {
            _ = try await synthesizeEdgeTts(
                text: "hello",
                opts: EdgeTtsOptions(voice: "en-US-AvaNeural"),
                skewSeconds: 0,
                transport: transport,
                calibrate: { prev in await stub.calibrate(prev) }
            )
            XCTFail("应上抛首次错误")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .connectionRejected)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
        XCTAssertEqual(transport.connectCount, 1)
        XCTAssertEqual(stub.callCount, 1)
    }

    /// C：calibrate 返回 nil（离线/校准接口不可用）→ 不重试 → 上抛首次错误。
    func testNoRetryWhenCalibrationUnavailable() async {
        let transport = ScriptedEdgeTransport(rounds: [[.error]])
        let stub = CalibrateStub(result: nil)
        do {
            _ = try await synthesizeEdgeTts(
                text: "hello",
                opts: EdgeTtsOptions(voice: "en-US-AvaNeural"),
                skewSeconds: 0,
                transport: transport,
                calibrate: { prev in await stub.calibrate(prev) }
            )
            XCTFail("应上抛首次错误")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .connectionRejected)
        } catch {
            XCTFail("非预期错误：\(error)")
        }
        XCTAssertEqual(transport.connectCount, 1)
    }

    /// D：重试轮抛另一种错误 → 仍上抛**首次**错误（edgeTts.ts:303，更接近根因）。
    func testThrowsFirstErrorWhenRetryFailsDifferently() async {
        let transport = ScriptedEdgeTransport(rounds: [
            [.error],  // 首试：连接被拒
            [.text(turnEnd)],  // 重试：连上但空音频（另一种错误）
        ])
        let stub = CalibrateStub(result: 301)
        do {
            _ = try await synthesizeEdgeTts(
                text: "hello",
                opts: EdgeTtsOptions(voice: "en-US-AvaNeural"),
                skewSeconds: 0,
                transport: transport,
                calibrate: { prev in await stub.calibrate(prev) }
            )
            XCTFail("应上抛首次错误")
        } catch let error as EdgeTtsError {
            XCTAssertEqual(error, .connectionRejected)  // 不是 emptyAudio
        } catch {
            XCTFail("非预期错误：\(error)")
        }
        XCTAssertEqual(transport.connectCount, 2)
    }

    /// E：首试成功 → calibrate 零调用、skew 原样返回。
    func testFirstTrySuccessSkipsCalibration() async throws {
        let payload = Data([0xAA])
        let transport = ScriptedEdgeTransport(rounds: [[
            .data(makeEdgeBinaryFrame(header: audioHeader, payload: payload)),
            .text(turnEnd),
        ]])
        let stub = CalibrateStub(result: 301)
        let result = try await synthesizeEdgeTts(
            text: "hello",
            opts: EdgeTtsOptions(voice: "en-US-AvaNeural"),
            skewSeconds: 42,
            transport: transport,
            calibrate: { prev in await stub.calibrate(prev) }
        )
        XCTAssertEqual(result.data, payload)
        XCTAssertEqual(result.skewSeconds, 42)
        XCTAssertEqual(transport.connectCount, 1)
        XCTAssertEqual(stub.callCount, 0)
    }
}
