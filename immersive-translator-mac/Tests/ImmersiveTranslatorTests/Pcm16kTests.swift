import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// PCM 量化/base64 单测（对齐 Windows resample.test.ts 行为向量：量化典型值与
// 钳制（含 JS Math.round 的负半数口径）、base64 RFC 4648 向量、跨 3 字节边界
// 还原、16k Float32 直通时长、Int16 小端字节序）。Mac 采集已 16k（MicRecorder
// targetFormat 16_000），无 44.1k/48k 线性插值分支（规格 §四差异 5）。
// 另断言打包测试样本资产（54240 字节，字节级复用 Windows 文件）。
// ---------------------------------------------------------------------------

final class Pcm16kTests: XCTestCase {
    func testQuantizationTypicalValues() {
        let out = float32ToInt16([0, 1, -1, 0.5, -0.5, 0.25])
        XCTAssertEqual(out, [0, 32767, -32768, 16384, -16384, 8192])
    }

    func testQuantizationClampsOutOfRange() {
        XCTAssertEqual(float32ToInt16([1.5, -2, 100]), [32767, -32768, 32767])
    }

    func testQuantizationMatchesJsMathRoundOnNegativeHalves() {
        // JS Math.round(-x.5) 向上取整（-0.5 → 0）：scaled=-0.5 → 0；scaled=-1.5 → -1。
        let out = float32ToInt16([-0.5 / 32768, -1.5 / 32768])
        XCTAssertEqual(out[0], 0)
        XCTAssertEqual(out[1], -1)
    }

    func testBase64Rfc4648Vectors() {
        XCTAssertEqual(bytesToBase64(Data()), "")
        XCTAssertEqual(bytesToBase64(Data([0x00])), "AA==")
        XCTAssertEqual(bytesToBase64(Data([0xfb])), "+w==")
        XCTAssertEqual(bytesToBase64(Data([0xfb, 0xff])), "+/8=")
        XCTAssertEqual(bytesToBase64(Data([0xfb, 0xff, 0xbf])), "+/+/")
        XCTAssertEqual(bytesToBase64(Data("abc".utf8)), "YWJj")
        XCTAssertEqual(bytesToBase64(Data("ab".utf8)), "YWI=")
        XCTAssertEqual(bytesToBase64(Data("a".utf8)), "YQ==")
    }

    func testBase64RoundTripAcrossTripleBoundary() {
        var bytes = Data()
        for i in 0..<1000 {
            bytes.append(UInt8((i * 37 + 11) & 0xff))
        }
        let encoded = bytesToBase64(bytes)
        let decoded = Data(base64Encoded: encoded)
        XCTAssertEqual(decoded, bytes)
    }

    func testInt16LittleEndianByteOrder() {
        let data = int16LEBytes([0, 1, -1])
        XCTAssertEqual(data.count, 6)
        XCTAssertEqual([UInt8](data), [0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF])
    }

    func testPcm16kPassthroughDurationAndBase64() {
        // 16000 样本 @16k → 1000ms；payload base64 可还原 32000 字节小端 PCM。
        let samples = [Float](repeating: 0.25, count: 16000)
        let payload = pcm16kToBase64(samples, inputRate: 16000)
        XCTAssertEqual(payload.durationMs, 1000)
        let decoded = Data(base64Encoded: payload.base64)!
        XCTAssertEqual(decoded.count, 32000)
        // 0.25 → 0.25*32767 = 8191.75 → 8192 → 小端 0x2000。
        XCTAssertEqual([UInt8](decoded.prefix(2)), [0x00, 0x20])
    }

    // MARK: Windows resample.test.ts 逐条

    func testSixteenKInputPassesThroughUnresampled() {
        // 对齐「16k 输入原样直通（不重复重采样）」。
        let payload = pcm16kToBase64([0.5, -0.5], inputRate: 16000)
        XCTAssertEqual(payload.durationMs, Int((2.0 / 16000.0 * 1000.0).rounded()))
        let decoded = [UInt8](Data(base64Encoded: payload.base64)!)
        XCTAssertEqual(decoded, [0x00, 0x40, 0x00, 0xC0], "[16384, -16384] 小端")
    }

    func testPcm16kBytesLittleEndian() {
        // 对齐「pcm16kBytes 输出 Int16 小端字节序」：16384 = 0x4000 → LE [0x00, 0x40]。
        XCTAssertEqual([UInt8](pcm16kBytes([0.5], inputRate: 16000)), [0x00, 0x40])
    }

    func testResample48kTo16kPicksSourcePoints() {
        // 4800 样本 @48k（100ms）→ 1600 样本 @16k；ratio=3 时 out[i]=input[3i]。
        var input = [Float](repeating: 0, count: 4800)
        for i in 0..<input.count where i % 7 == 0 { input[i] = 1 }
        let bytes = pcm16kBytes(input, inputRate: 48000)
        XCTAssertEqual(bytes.count, 1600 * 2)
        let view = bytes.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Int16(littleEndian: $0) }
        XCTAssertEqual(view[0], 32767)
        XCTAssertEqual(view[1], 0)
    }

    func testResample44k1To16kOneSecondIs16000Samples() {
        let input = [Float](repeating: 0.25, count: 44100) // 1 秒 @44.1k
        let payload = pcm16kToBase64(input, inputRate: 44100)
        // 线性插值长度 floor(44100 / 2.75625) = 16000（服务端 pcmDurationMs 同口径）。
        XCTAssertEqual(payload.durationMs, 1000)
        let decoded = Data(base64Encoded: payload.base64)!
        XCTAssertEqual(decoded.count, 16000 * 2)
        let view = decoded.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Int16(littleEndian: $0) }
        XCTAssertEqual(view[123], Int16((0.25 * 32767.0).rounded()))
    }

    func testNaNQuantizesToZeroLikeJsInt16Array() {
        XCTAssertEqual(float32ToInt16([Float.nan, 1]), [0, 32767])
    }

    func testBundledIseTestSampleAssetMatchesWindowsBytes() throws {
        // 经产品侧加载器取资源（测试 target 的 Bundle.module 指向测试包）。
        let data = try GatewayIseSample.assetData()
        XCTAssertEqual(data.count, 54240, "16k/16bit/mono 1695ms 固定样本（Windows 同文件字节级复用）")
        // base64 载荷可往返还原（语音页一键测试的 audio 字段同源）。
        XCTAssertEqual(Data(base64Encoded: try GatewayIseSample.loadBase64()), data)
    }
}
