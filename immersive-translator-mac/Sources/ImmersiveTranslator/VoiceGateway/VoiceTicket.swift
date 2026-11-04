import Foundation

// ---------------------------------------------------------------------------
// WSS 一次性 ticket 管理器（对齐 Windows src/lib/voice/voiceTicket.ts，契约 §一）：
// - ticket 60 秒有效、只能用一次、限流 30/分钟；
// - 每次建连（含重连）前现调现用，绝不缓存复用——一张票只发给一个建连方；
// - 单飞变体：同一时刻至多一张票的 HTTP 请求在途，并发建连排队各领各的新票。
//   （经典 single-flight 是「共享同一结果」，对一次性票据是错的——两个连接共用
//   一张票必有一个握手 401；这里保住「防请求风暴」的内核，结果不共享。）
// - 拿票到握手之间不插长耗时操作：acquire 返回即用，不做预取/续期。
// ---------------------------------------------------------------------------

struct VoiceTicketIssued {
    let ticket: String
    /// 过期时刻（毫秒）；仅信息展示，本管理器不缓存所以不据此调度。
    let expiresAtMs: Int64
}

/// 串行链 TicketManager：并发 acquire 排队逐个取票，失败不毒化队列。
/// Swift 落法：actor 内一条链式 Task（每次 acquire 挂在前一张票 settle 之后，
/// 成功失败都放行后续——对齐 Windows createTicketManager 的 promise 链；
/// 链尾吞错，各 acquire 拿各自的票、各自的失败）。
actor VoiceTicketManager {
    private let fetcher: () async throws -> VoiceTicketIssued
    /// 链尾：settle 即放行下一个排队者（错误吞掉，不毒化队列）。
    private var tail: Task<Void, Never> = Task {}

    init(fetcher: @escaping () async throws -> VoiceTicketIssued) {
        self.fetcher = fetcher
    }

    /// 取一张未用过的新票；同一时刻至多一张票的 HTTP 请求在途，并发调用
    /// 串行排队各领各的新票，失败向各调用方各自抛出。
    func acquire() async throws -> String {
        let previous = tail
        let run = Task<VoiceTicketIssued, Error> { [fetcher] in
            _ = await previous.value
            return try await fetcher()
        }
        tail = Task { _ = try? await run.value }
        let issued = try await run.value
        return issued.ticket
    }
}

/// POST /v1/voice/ticket（鉴权 HTTP；401 刷新/重放在鉴权管理器通道内完成）。
func fetchVoiceTicket() async throws -> VoiceTicketIssued {
    let response = try await voiceRequest(method: "POST", path: "/v1/voice/ticket")
    let body = try requireOkJson(response)
    guard let ticket = body["ticket"] as? String, !ticket.isEmpty else {
        throw VoiceError(code: "unknown", message: "换票响应缺少 ticket")
    }
    let expiresAtRaw = body["expiresAt"] as? String
    let expiresAtMs = expiresAtRaw
        .flatMap { ISO8601DateFormatter().date(from: $0)?.timeIntervalSince1970 }
        .map { Int64($0 * 1000) } ?? 0
    return VoiceTicketIssued(ticket: ticket, expiresAtMs: expiresAtMs)
}

/// 生产用共享管理器（ASR/TTS 建连共用，单飞排队全局生效）。
enum SharedVoiceTicket {
    private static let lock = NSLock()
    private static var manager: VoiceTicketManager?

    static func shared() -> VoiceTicketManager {
        lock.lock()
        defer { lock.unlock() }
        if let manager { return manager }
        let created = VoiceTicketManager(fetcher: fetchVoiceTicket)
        manager = created
        return created
    }

    /// 单测隔离用。
    static func resetForTests() {
        lock.lock()
        defer { lock.unlock() }
        manager = nil
    }
}
