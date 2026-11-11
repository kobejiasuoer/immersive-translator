import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// QA BUG-006 防回归：正文段翻译请求 hang——无超时、无反馈、无恢复入口。
/// 修复 = ReaderChatClient.streamDeltas 活动看门狗（自上次流增量静默
/// translateWatchdogTimeoutSeconds 即抛 URLError(.timedOut)）+ completeStreaming 接线。
/// 本组用例用短超时走真实 streamDeltas 管线（本地 TestServer 发 SSE，不碰外网）：
/// 停摆的流必须在超时后抛出、停摆前已产出的增量仍可用；正常流与喂狗流不受影响。
final class ReaderChatStreamWatchdogTests: XCTestCase {

    // MARK: - 本地 SSE 服务（真 URLSession.bytes 路径）

    /// 极简 HTTP 服务：返回响应头后按脚本节奏写 SSE 行；`stall` 帧 = 永不写也不断开。
    private final class SSETestServer: @unchecked Sendable {
        let port: UInt16
        private let serverSocket: Int32
        private var handler: Task<Void, Never>?
        private let script: [ScriptItem]

        enum ScriptItem: Sendable {
            case line(String, sleepMs: UInt64)
            case stall
        }

        init(script: [ScriptItem]) throws {
            self.script = script
            serverSocket = socket(AF_INET, SOCK_STREAM, 0)
            guard serverSocket >= 0 else { throw NSError(domain: "socket", code: 1) }
            var yes: Int32 = 1
            setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
            // 绑定随机可用端口
            var bindAddr = sockaddr_in()
            bindAddr.sin_family = sa_family_t(AF_INET)
            bindAddr.sin_port = 0
            bindAddr.sin_addr = in_addr(s_addr: INADDR_ANY)
            let fd = serverSocket
            let bindResult = withUnsafePointer(to: bindAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bindResult == 0 else { throw NSError(domain: "bind", code: 2) }
            var boundAddr = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            getsockname(serverSocket, withUnsafeMutablePointer(to: &boundAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { $0 }
            }, &len)
            port = boundAddr.sin_port.bigEndian
            guard listen(serverSocket, 4) == 0 else { throw NSError(domain: "listen", code: 3) }
        }

        func start() {
            handler = Task { [serverSocket, script] in
                while !Task.isCancelled {
                    let client = accept(serverSocket, nil, nil)
                    guard client >= 0 else { break }
                    let item = script
                    let task = Task.detached {
                        defer { close(client) }
                        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                        client.send(header)
                        for step in item {
                            switch step {
                            case let .line(text, sleepMs):
                                try? await Task.sleep(nanoseconds: sleepMs * 1_000_000)
                                client.send(text + "\n")
                            case .stall:
                                try? await Task.sleep(nanoseconds: 120_000_000_000) // 120s：远超用例超时
                                return
                            }
                        }
                        // 脚本走完即关流（对齐真实 Chat Completions 服务端 [DONE] 后断开）。
                    }
                    _ = task
                }
            }
        }

        func stop() {
            handler?.cancel()
            close(serverSocket)
        }

        var endpoint: URL { URL(string: "http://127.0.0.1:\(port)/v1/chat/completions")! }
    }

    private func sseDataLine(_ text: String) -> String {
        let payload = #"{"choices":[{"delta":{"content":"\#(text)"}}]}"#
        return "data: \(payload)"
    }

    private func request(to url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = Data(#"{"stream":true}"#.utf8)
        return request
    }

    // MARK: - 用例

    /// 停摆的流：先出两段增量、随后服务器既不写也不断开 → 看门狗必须在超时后
    /// 结束收流；停摆前已产出的增量完整可用。
    func testStalledStreamTimesOutAfterIdleWindowAndKeepsDeltas() async throws {
        let server = try SSETestServer(script: [
            .line(sseDataLine("第一"), sleepMs: 50),
            .line(sseDataLine("第二"), sleepMs: 50),
            .stall
        ])
        server.start()
        defer { server.stop() }

        var deltas: [String] = []
        var caught: Error?
        do {
            let stream = await MainActor.run {
                ReaderChatClient.streamDeltas(
                    request: request(to: server.endpoint),
                    apiKey: "test-key",
                    watchdogTimeout: 1.0
                )
            }
            for try await delta in stream {
                deltas.append(delta)
            }
        } catch {
            caught = error
        }

        XCTAssertEqual(deltas.count, 2, "停摆前的增量必须保留，实际：\(deltas)")
        guard let timedOut = caught as? URLError else {
            return XCTFail("停摆流应抛 URLError，实际：\(String(describing: caught))")
        }
        XCTAssertEqual(timedOut.code, .timedOut, "应按静默超时收流，实际：\(String(describing: caught))")
    }

    /// 喂狗的流（每行间隔远小于超时）：整条流正常走完（服务端写完关流）、不抛错；
    /// 两段文本按序产出。
    func testHealthyStreamWithShortGapsCompletesWithoutWatchdogTrip() async throws {
        let server = try SSETestServer(script: [
            .line(sseDataLine("你"), sleepMs: 150),
            .line(sseDataLine("好"), sleepMs: 150),
            .line("data: [DONE]", sleepMs: 50)
        ])
        server.start()
        defer { server.stop() }

        var deltas: [String] = []
        var caught: Error?
        do {
            let stream = await MainActor.run {
                ReaderChatClient.streamDeltas(
                    request: request(to: server.endpoint),
                    apiKey: "test-key",
                    watchdogTimeout: 1.0
                )
            }
            for try await delta in stream {
                deltas.append(delta)
            }
        } catch {
            caught = error
        }

        XCTAssertNil(caught, "短间隔流不应触发看门狗，实际：\(String(describing: caught))")
        XCTAssertEqual(deltas, ["你", "好"], "streamDeltas 逐行产出可见文本（不含 [DONE]）")
    }

    /// 未配置头（watchdogTimeout=nil）维持原行为：慢流不抛错（等服务器写完静默段）。
    /// 锁定「看门狗只在阅读室通道启用」这一接线语义。
    func testNilWatchdogKeepsLegacyNoTimeoutBehavior() async throws {
        let server = try SSETestServer(script: [
            .line(sseDataLine("慢"), sleepMs: 100),
            .line(sseDataLine("流"), sleepMs: 100),
            .stall
        ])
        server.start()
        defer { server.stop() }

        let stream = await MainActor.run {
            ReaderChatClient.streamDeltas(
                request: request(to: server.endpoint),
                apiKey: "test-key",
                watchdogTimeout: nil
            )
        }
        // nil 头 = 无看门狗：1.5s 处流必然仍挂起（脚本 stall 120s），已写入的
        // 两行增量照常产出，之后没有更多产出也不报错——旧行为（永不超时）。
        let done = DeferredFlag()
        var deltas: [String] = []
        let collector = Task { () -> [String] in
            var acc: [String] = []
            for try await delta in stream {
                acc.append(delta)
            }
            await done.set()
            return acc
        }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let stillRunning = await done.isSet == false
        XCTAssertTrue(stillRunning, "未配置看门狗时应维持旧行为（不因停摆结束/超时）")
        collector.cancel()
        let collected = (try? await collector.value) ?? deltas
        XCTAssertEqual(collected, ["慢", "流"], "停摆前已写入的两行增量应正常产出")
    }
}

/// 简单的完成标记（actor）：替代 Task.isCompleted 的可等待判据。
private actor DeferredFlag {
    private var value = false
    func set() { value = true }
    var isSet: Bool { value }
}

/// BSD socket 收发的最小封装（测试专用）。
private extension Int32 {
    func send(_ text: String) {
        text.withCString { pointer in
            _ = Darwin.send(self, pointer, strlen(pointer), 0)
        }
    }
}
