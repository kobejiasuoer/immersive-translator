import Foundation
import ProviderCore
import ReaderCore

/// 阅读室本地埋点门面（对齐 Windows src/lib/telemetry.ts 的 trackEvent）：
/// 事件 → 一行 JSON（ts 在此时刻赋值）→ 追加 logs/reader-events.jsonl。
/// 纯本地、无网络、失败静默；调用方零等待（sink 内部串行队列异步落盘）。
enum ReaderTelemetry {
    static func track(_ event: TelemetryEvent) {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard let line = try? event.jsonLine(nowMs: nowMs) else { return }
        EventTelemetry.appendLine(line)
    }
}
