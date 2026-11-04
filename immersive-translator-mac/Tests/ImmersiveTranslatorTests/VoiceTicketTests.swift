import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// WSS 一次性 ticket 管理器单测（对齐 Windows voiceTicket.test.ts 行为向量）：
// 并发 acquire 至多一张在途、各得新票（结果不共享）；串行每次新票；失败不毒化队列。
// ---------------------------------------------------------------------------

final class VoiceTicketTests: XCTestCase {
    /// 挂起取票的门闩式 fetcher：同时跟踪在途数量。
    private final class CountingFetcher {
        let lock = NSLock()
        var inFlight = 0
        var peakInFlight = 0
        var issued: [String] = []
        var failNext = false

        func make() -> () async throws -> VoiceTicketIssued {
            { [self] in
                self.lock.lock()
                self.inFlight += 1
                self.peakInFlight = max(self.peakInFlight, self.inFlight)
                // 一次性开关：读即复位（failNext 只影响下一次取票）。
                let shouldFail = self.failNext
                self.failNext = false
                self.lock.unlock()
                // 给并发窗口留时间（对齐 Windows 假 fetcher 的异步边界）。
                try? await Task.sleep(nanoseconds: 20_000_000)
                self.lock.lock()
                self.inFlight -= 1
                if shouldFail {
                    self.lock.unlock()
                    throw VoiceError(code: "network_error", message: "取票失败")
                }
                let ticket = "ticket-\(self.issued.count)"
                self.issued.append(ticket)
                self.lock.unlock()
                return VoiceTicketIssued(ticket: ticket, expiresAtMs: 0)
            }
        }
    }

    func testConcurrentAcquiresSerializeAndEachGetsNewTicket() async throws {
        let counter = CountingFetcher()
        let manager = VoiceTicketManager(fetcher: counter.make())
        async let a = manager.acquire()
        async let b = manager.acquire()
        async let c = manager.acquire()
        let tickets = try await [a, b, c]
        XCTAssertEqual(counter.peakInFlight, 1, "同一时刻至多一张票的请求在途（串行链）")
        XCTAssertEqual(Set(tickets).count, 3, "并发建连排队各领各的新票，结果不共享")
        XCTAssertEqual(counter.issued.count, 3)
    }

    func testSequentialAcquiresGetFreshTickets() async throws {
        let counter = CountingFetcher()
        let manager = VoiceTicketManager(fetcher: counter.make())
        let first = try await manager.acquire()
        let second = try await manager.acquire()
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(counter.issued, [first, second])
    }

    func testConcurrentMixedSuccessAndFailureEachCallerGetsOwnResult() async {
        // 对齐 Windows「并发混合成功失败：每个调用方各得结果，底层仍不并发」：
        // 第 1、3 次取票失败、第 2 次成功（按底层调用序；调用方入队序不定，按结果多重集断言）。
        let lock = NSLock()
        var call = 0
        var inFlight = 0
        var peak = 0
        let manager = VoiceTicketManager(fetcher: {
            lock.lock()
            call += 1
            let step = call
            inFlight += 1
            peak = max(peak, inFlight)
            lock.unlock()
            try? await Task.sleep(nanoseconds: 15_000_000)
            lock.lock()
            inFlight -= 1
            lock.unlock()
            if step == 2 {
                return VoiceTicketIssued(ticket: "ok-1", expiresAtMs: 0)
            }
            throw VoiceError(code: "rate_limited")
        })
        let results = await withTaskGroup(of: Result<String, Error>.self) { group -> [Result<String, Error>] in
            for _ in 0..<3 {
                group.addTask {
                    do {
                        return .success(try await manager.acquire())
                    } catch {
                        return .failure(error)
                    }
                }
            }
            var collected: [Result<String, Error>] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }
        let successes = results.compactMap { try? $0.get() }
        XCTAssertEqual(successes, ["ok-1"], "恰一张票成功，结果不共享")
        XCTAssertEqual(results.count - successes.count, 2, "其余两个调用方各自拿到失败")
        XCTAssertEqual(peak, 1, "底层仍不并发")
    }

    func testFailureDoesNotPoisonQueue() async throws {
        let counter = CountingFetcher()
        let manager = VoiceTicketManager(fetcher: counter.make())
        // 第一次失败。
        counter.lock.lock()
        counter.failNext = true
        counter.lock.unlock()
        do {
            _ = try await manager.acquire()
            XCTFail("应抛出取票失败")
        } catch {
            XCTAssertEqual((error as? VoiceError)?.code, "network_error")
        }
        // 后续调用照常取到新票（失败不毒化队列）。
        let ticket = try await manager.acquire()
        XCTAssertEqual(ticket, "ticket-0")
    }
}
