import AVFoundation
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 网关朗读 mp3 分片流式播放单测（规格 §四差异 3 的 macOS 落法）：
// - 解码器：任意切分边界逐片喂入，与整文件解码的帧数一致（分片按序、不丢帧）；
// - 播放器：合成结束仍无音频 → 「云端合成返回空音频」（对齐 Windows fail 文案）；
//   stop 后不再回调。
// 样本取系统自带 mp3（不入库，缺失则跳过）；不在单测里真正出声。
// ---------------------------------------------------------------------------

final class GatewayStreamPlayerTests: XCTestCase {
    private let samplePaths = [
        "/System/Library/PrivateFrameworks/PersonalAudio.framework/Versions/A/Resources/Enrollment_1.mp3",
        "/System/Library/PrivateFrameworks/PersonalAudio.framework/Versions/A/Resources/Enrollment_1+15dB.mp3",
    ]

    private func sampleURL() throws -> URL {
        guard let path = samplePaths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("本机无系统 mp3 样本，跳过解码一致性用例")
        }
        return URL(fileURLWithPath: path)
    }

    private func decode(_ data: Data, chunkSize: Int) -> (frames: AVAudioFramePosition, buffers: [AVAudioPCMBuffer], failure: Error?) {
        let decoder = Mp3StreamDecoder()
        var buffers: [AVAudioPCMBuffer] = []
        decoder.onBuffer = { buffers.append($0) }
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            decoder.feed(data.subdata(in: offset..<end))
            offset = end
        }
        decoder.drain()
        return (decoder.producedFrames, buffers, decoder.failure)
    }

    func testChunkedDecodeMatchesWholeFileFrameCount() throws {
        let url = try sampleURL()
        let data = try Data(contentsOf: url)
        let file = try AVAudioFile(forReading: url)
        for chunkSize in [777, 4096, data.count] {
            let result = decode(data, chunkSize: chunkSize)
            XCTAssertNil(result.failure, "chunk=\(chunkSize)")
            XCTAssertGreaterThan(result.frames, 0)
            // 允许编解码器起始延迟/尾部填充差异（≤ 2 个 mp3 帧）。
            XCTAssertLessThanOrEqual(abs(result.frames - file.length), 2304, "chunk=\(chunkSize) frames=\(result.frames) file=\(file.length)")
            XCTAssertEqual(result.buffers.first?.format.sampleRate, file.processingFormat.sampleRate)
        }
        // 切分边界不影响结果：细切与整块解码帧数一致（分片按序、不丢帧）。
        XCTAssertEqual(decode(data, chunkSize: 333).frames, decode(data, chunkSize: data.count).frames)
    }

    func testGarbageBytesProduceNoAudio() {
        let result = decode(Data(repeating: 0x00, count: 2048), chunkSize: 512)
        XCTAssertEqual(result.frames, 0)
        XCTAssertTrue(result.buffers.isEmpty)
    }

    func testPlayerFinishWithoutAudioReportsEmptyAudio() async {
        let player = GatewayStreamPlayer(rate: 1)
        let expectation = expectation(description: "empty audio")
        var received: Error?
        var started = false
        var ended = false
        player.onStarted = { started = true }
        player.onEnded = { ended = true }
        player.onError = { error in
            received = error
            expectation.fulfill()
        }
        player.finish()
        await fulfillment(of: [expectation], timeout: 3)
        XCTAssertEqual(received as? GatewayStreamPlaybackError, .emptyAudio)
        XCTAssertEqual((received as? LocalizedError)?.errorDescription, "云端合成返回空音频")
        XCTAssertFalse(started)
        XCTAssertFalse(ended)
    }

    func testStoppedPlayerNeverCallsBack() async {
        let player = GatewayStreamPlayer(rate: 1)
        var callbacks = 0
        player.onStarted = { callbacks += 1 }
        player.onEnded = { callbacks += 1 }
        player.onError = { _ in callbacks += 1 }
        player.stop()
        player.append(Data(repeating: 0xFF, count: 64))
        player.finish()
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(callbacks, 0, "stop 后不再回调任何事件")
    }
}
