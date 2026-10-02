import Foundation

/// 本地埋点 JSONL sink：~/Library/Application Support/ImmersiveTranslator/logs/reader-events.jsonl
/// （与阅读室数据同根，logs/ 子目录命名对齐 Windows telemetry.rs）。
///
/// 复用同模块 DiagnosticLogger.append 的加固写路径（追加、1 MiB 上限 + tail 轮转、
/// 0600、防 symlink/FIFO/硬链接、flock），不改动 DiagnosticLogger 一行；
/// 注意不能走 DiagnosticLogger.log——它给每行加 [ISO8601] 前缀，破坏
/// 「每行一个 JSON 对象」契约。失败一律静默（不弹 UI、不打 NSLog），
/// 与 Windows `let _ = append_event(...)` 一致，永不打断主流程。
public enum EventTelemetry {
    private static let queue = DispatchQueue(label: "local.immersive-translator.event-telemetry")

    /// 默认落盘路径（测试可注入自定义 URL）。
    public static func eventsFileURL() -> URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return baseURL
            .appendingPathComponent("ImmersiveTranslator", isDirectory: true)
            .appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent("reader-events.jsonl")
    }

    /// 追加一行 JSONL（同步版，internal 供测试与异步版内部复用）。行尾补 \n。
    static func appendLineSync(_ line: String, to url: URL) throws {
        try DiagnosticLogger.append(Data(line.utf8) + Data("\n".utf8), to: url)
    }

    /// 追加一行 JSONL（专用串行队列异步执行）：调用方零等待，
    /// 失败静默吞掉（对齐 Windows invoke 异步 + catch 全吞）。
    public static func appendLine(_ line: String, to url: URL? = nil) {
        let target = url ?? eventsFileURL()
        queue.async {
            try? appendLineSync(line, to: target)
        }
    }
}
