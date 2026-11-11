import XCTest
import ProviderCore
@testable import ImmersiveTranslator

/// QA BUG-010 防回归：学词笔记「取消生成」语义错误——
/// completeStreaming 的流消费在任务取消时按「流正常结束」收尾（不走 throw），
/// 首字前取消 accumulated 为空 → throw .empty 被上层渲染成「接口返回空内容」
/// 故障；流式后取消非空 → 截断稿被当完整结果返回、按 partial=false 存档。
/// 修复 = 循环退出后 `guard !Task.isCancelled else { throw CancellationError() }`。
/// 用例走真实 URLSession.bytes 管线（本地 BSD socket SSE 服务，不碰外网）：
/// 取消必须以 CancellationError 到达调用方，截断稿不得冒充完整结果。
final class ReaderChatCancellationSemanticsTests: XCTestCase {

    // MARK: - 本地 SSE 服务（与 ReaderChatStreamWatchdogTests 同构的最小实现）

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
                                try? await Task.sleep(nanoseconds: 120_000_000_000)
                                return
                            }
                        }
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

    // MARK: - 夹具

    /// 指向本地测试服务的 ReaderChatClient：active provider 切到内置 deepseek 槽
    ///（避开沉浸云平台分支——它无视存量 endpoint、按 resolveBaseURL 直连真实服务），
    /// 再把该槽 endpoint 指向本地服务。providers/activeProviderID 两个 UserDefaults
    /// 键在 makeClient 返回时原样还原（SettingsStore 在内存里持有改动供本用例使用）。
    @MainActor
    private func makeClient(endpoint: URL) throws -> ReaderChatClient {
        let defaults = UserDefaults.standard
        let savedProviders = defaults.object(forKey: "providers")
        let savedActiveID = defaults.object(forKey: "activeProviderID")
        defer {
            if let savedProviders {
                defaults.set(savedProviders, forKey: "providers")
            } else {
                defaults.removeObject(forKey: "providers")
            }
            if let savedActiveID {
                defaults.set(savedActiveID, forKey: "activeProviderID")
            } else {
                defaults.removeObject(forKey: "activeProviderID")
            }
        }

        let store = SettingsStore()
        store.activeProviderID = ProviderProfile.builtinPresets[0].id // deepseek（非平台分支）
        store.updateActiveProvider { profile in
            profile.endpoint = endpoint.absoluteString
        }
        return ReaderChatClient(settingsStore: store)
    }

    // MARK: - 用例

    /// 流式后取消：服务器先出增量、随后停摆；消费任务在收到首个增量后取消。
    /// 修复前：循环正常退出 → 截断稿被当完整结果 return（笔记按 partial=false 存档）。
    /// 修复后：必须抛 CancellationError，绝不能把截断稿当返回值。
    func testCancelAfterFirstDeltaThrowsCancellationNotTruncatedResult() async throws {
        let server = try SSETestServer(script: [
            .line(sseDataLine("部分"), sleepMs: 60),
            .line(sseDataLine("截断"), sleepMs: 60),
            .stall
        ])
        server.start()
        defer { server.stop() }

        let client = try await MainActor.run { try makeClient(endpoint: server.endpoint) }

        let firstDelta = DispatchSemaphore(value: 0)
        let runner = Task {
            try await client.completeStreaming(
                systemPrompt: "sys",
                userText: "user",
                onDelta: { _ in firstDelta.signal() }
            )
        }

        // 等首个增量到达（最多 3s），再取消——模拟「流式上屏后点取消生成」。
        XCTAssertEqual(firstDelta.wait(timeout: .now() + 3), .success, "测试前置：应先收到流式增量")
        runner.cancel()

        do {
            let text = try await runner.value
            XCTFail("取消后不得把截断稿当完整结果返回，实际返回：\(String(describing: text))")
        } catch is CancellationError {
            // 预期：取消语义。
        } catch {
            XCTFail("取消应抛 CancellationError，实际：\(String(describing: error))")
        }
    }

    /// 首字前取消：服务器从未产出任何增量即停摆；取消后必须抛 CancellationError，
    /// 而不是落 ReaderChatError.empty（被上层渲染成「接口返回空内容」接口故障）。
    func testCancelBeforeFirstDeltaThrowsCancellationNotEmptyError() async throws {
        let server = try SSETestServer(script: [
            .stall
        ])
        server.start()
        defer { server.stop() }

        let client = try await MainActor.run { try makeClient(endpoint: server.endpoint) }

        let runner = Task {
            try await client.completeStreaming(systemPrompt: "sys", userText: "user") { _ in }
        }
        // 100ms：请求已挂起在收流上、首字必然未到（服务器 0 产出），此时取消。
        try await Task.sleep(nanoseconds: 100_000_000)
        runner.cancel()

        do {
            let text = try await runner.value
            XCTFail("取消后不得返回任何结果，实际返回：\(String(describing: text))")
        } catch is CancellationError {
            // 预期：取消语义。
        } catch let error as ReaderChatClient.ReaderChatError {
            XCTFail("首字前取消不得报接口错误（如 .empty），实际：\(String(describing: error))")
        } catch {
            XCTFail("取消应抛 CancellationError，实际：\(String(describing: error))")
        }
    }
}

/// BSD socket 收发的最小封装（测试专用）。
private extension Int32 {
    func send(_ text: String) {
        text.withCString { pointer in
            _ = Darwin.send(self, pointer, strlen(pointer), 0)
        }
    }
}
