import Darwin
import Foundation
import XCTest
@testable import ProviderCore
@testable import ReaderCore

/// 本地埋点 JSONL sink 冒烟：只覆盖 EventTelemetry 自身的写入口与静默语义。
/// 轮转/0600/symlink/FIFO/硬链接等加固行为由 DiagnosticLoggerTests 七个用例
/// 全覆盖——sink 只是把行喂给同一个 DiagnosticLogger.append 写入口，不重复写。

final class EventTelemetryTests: XCTestCase {
    func testAppendLineWritesJSONL() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("EventTelemetryTests-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("reader-events.jsonl")
        defer { try? FileManager.default.removeItem(at: directory) }

        try EventTelemetry.appendLineSync("{\"ts\":1,\"name\":\"a\",\"props\":{}}", to: fileURL)
        try EventTelemetry.appendLineSync("{\"ts\":2,\"name\":\"b\",\"props\":{\"k\":1}}", to: fileURL)
        try EventTelemetry.appendLineSync("{\"ts\":3,\"name\":\"c\",\"props\":{}}", to: fileURL)

        let content = try String(contentsOf: fileURL, encoding: .utf8)
        let lines = content.split(separator: "\n")
        XCTAssertEqual(lines.count, 3)
        // 每行一个 JSON 对象：逐行 decodeLine 还原成功且 ts 保序。
        for (offset, line) in lines.enumerated() {
            let decoded = TelemetryEvent.decodeLine(String(line))
            XCTAssertNotNil(decoded)
            XCTAssertEqual(decoded?.ts, Int64(offset + 1))
        }
        XCTAssertEqual(try permissions(of: fileURL), 0o600)
    }

    func testAppendLineDropsSilentlyOnUnwritableTarget() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("EventTelemetryTests-\(UUID().uuidString)", isDirectory: true)
        let fifoURL = directory.appendingPathComponent("reader-events.jsonl")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        XCTAssertEqual(mkfifo(fifoURL.path, 0o600), 0)

        // 同步版显式抛错（FIFO 被 validateRegularFile 拒绝，不阻塞）。
        let startedAt = Date()
        XCTAssertThrowsError(try EventTelemetry.appendLineSync("{\"ts\":1,\"name\":\"a\",\"props\":{}}", to: fifoURL))
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 1)

        // 异步版静默吞错：不崩、不打 NSLog（失败语义 = 永不打断主流程）。
        let drained = expectation(description: "queue drained")
        EventTelemetry.appendLine("{\"ts\":2,\"name\":\"b\",\"props\":{}}", to: fifoURL)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { drained.fulfill() }
        wait(for: [drained], timeout: 2)
    }

    private func permissions(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap((attributes[.posixPermissions] as? NSNumber)?.intValue)
    }
}
