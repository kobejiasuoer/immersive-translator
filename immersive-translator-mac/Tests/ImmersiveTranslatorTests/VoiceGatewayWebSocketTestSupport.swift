import Foundation
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 语音网关 WS/TTS/ASR 单测共用的假 WebSocket 与等待工具。
// ---------------------------------------------------------------------------

/// 可编程假 WebSocket：记录上行帧，测试手动触发 open/message/close。
final class FakeVoiceWebSocket: VoiceWebSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((VoiceWsMessage) -> Void)?
    var onClose: ((Int, String) -> Void)?
    var onError: (() -> Void)?

    private let lock = NSLock()
    private var _readyState = 0
    private var _sentTexts: [String] = []
    private var _sentDatas: [Data] = []
    /// open() 的行为（缺省不自动握手——测试手动 fireOpen 控制时序；可换成
    /// 「立即 close」模拟握手失败）。
    var onOpenRequested: (() -> Void)?

    let url: String

    init(url: String) {
        self.url = url
    }

    var readyState: Int {
        lock.lock()
        defer { lock.unlock() }
        return _readyState
    }

    /// 测试便利：等待 open 触发后自动完成握手（缺省 onOpenRequested 为空时用）。
    func autoOpenOnRequest() {
        onOpenRequested = { [weak self] in self?.fireOpen() }
    }

    var sentTexts: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _sentTexts
    }

    var sentDatas: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return _sentDatas
    }

    func open() {
        onOpenRequested?()
    }

    func sendText(_ text: String) {
        lock.lock()
        _sentTexts.append(text)
        lock.unlock()
    }

    func sendData(_ data: Data) {
        lock.lock()
        _sentDatas.append(data)
        lock.unlock()
    }

    func close(code: Int, reason: String) {
        lock.lock()
        _readyState = 3
        lock.unlock()
    }

    // ---- 测试触发 ----

    func fireOpen() {
        lock.lock()
        _readyState = 1
        lock.unlock()
        onOpen?()
    }

    /// 让服务端主动关连接（readyState → closed 再回调）。
    func serverClose(code: Int = 1006, reason: String = "closed") {
        lock.lock()
        _readyState = 3
        lock.unlock()
        onClose?(code, reason)
    }

    func fireText(_ raw: String) {
        onMessage?(.text(raw))
    }

    func fireData(_ data: Data) {
        onMessage?(.data(data))
    }
}

/// 假 WS 工厂：按建连顺序回放预置实例，并记录每次建连 URL。
final class FakeVoiceWebSocketFactory {
    private let lock = NSLock()
    private var _sockets: [FakeVoiceWebSocket] = []
    private var _urls: [String] = []
    private var nextIndex = 0
    /// 无预置时自动新建（行为可配置）。
    var makeDefault: (String) -> FakeVoiceWebSocket = { FakeVoiceWebSocket(url: $0) }

    func queue(_ socket: FakeVoiceWebSocket) {
        lock.lock()
        _sockets.append(socket)
        lock.unlock()
    }

    var urls: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _urls
    }

    var sockets: [FakeVoiceWebSocket] {
        lock.lock()
        defer { lock.unlock() }
        return _sockets
    }

    var createdCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _urls.count
    }

    func make() -> (String) -> VoiceWebSocket {
        { [weak self] url in
            guard let self else { return FakeVoiceWebSocket(url: url) }
            self.lock.lock()
            self._urls.append(url)
            let index = self.nextIndex
            self.nextIndex += 1
            if index < self._sockets.count {
                let queued = self._sockets[index]
                self.lock.unlock()
                return queued
            }
            self.lock.unlock()
            let created = self.makeDefault(url)
            self.lock.lock()
            self._sockets.append(created)
            self.lock.unlock()
            return created
        }
    }
}

/// 轮询等待异步条件成立（假 WS 回调经 Task 进 actor，测试需同步化）。
func waitUntilAsync(
    timeout: TimeInterval = 3,
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await condition()
}

extension XCTestCase {
    func assertAsync(
        _ message: @autoclosure () -> String = "",
        timeout: TimeInterval = 3,
        _ condition: @escaping () async -> Bool
    ) async {
        let ok = await waitUntilAsync(timeout: timeout, condition)
        XCTAssertTrue(ok, message())
    }
}
