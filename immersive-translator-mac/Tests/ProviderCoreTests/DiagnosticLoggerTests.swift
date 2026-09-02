import Darwin
import Foundation
import XCTest
@testable import ProviderCore

final class DiagnosticLoggerTests: XCTestCase {
    func testAppendRotatesAndCapsLegacyLog() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(repeating: 65, count: DiagnosticLogger.maxLogBytes + 128).write(to: logURL)

        try DiagnosticLogger.append(Data("new-entry\n".utf8), to: logURL)

        let current = try Data(contentsOf: logURL)
        let rotated = try Data(contentsOf: logURL.appendingPathExtension("1"))
        XCTAssertEqual(current, Data("new-entry\n".utf8))
        XCTAssertEqual(rotated, Data(repeating: 65, count: DiagnosticLogger.maxLogBytes))

        XCTAssertEqual(try permissions(of: logURL), 0o600)
        XCTAssertEqual(try permissions(of: logURL.appendingPathExtension("1")), 0o600)
    }

    func testAppendRejectsLogSymlinkWithoutTouchingTarget() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        let symlinkURL = directory.appendingPathComponent("symlink.log")
        let targetURL = directory.appendingPathComponent("target.txt")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("do-not-touch".utf8).write(to: targetURL)
        try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: targetURL)

        XCTAssertThrowsError(try DiagnosticLogger.append(Data("blocked".utf8), to: symlinkURL))
        XCTAssertEqual(try Data(contentsOf: targetURL), Data("do-not-touch".utf8))
    }

    func testAppendRejectsFifoWithoutBlocking() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let fifoURL = directory.appendingPathComponent("diagnostic.log")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        XCTAssertEqual(mkfifo(fifoURL.path, 0o600), 0)

        let startedAt = Date()
        XCTAssertThrowsError(try DiagnosticLogger.append(Data("blocked".utf8), to: fifoURL))
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 1)
    }

    func testAppendRejectsHardLinkedLog() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        let linkURL = directory.appendingPathComponent("other.log")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("original".utf8).write(to: logURL)
        try FileManager.default.linkItem(at: logURL, to: linkURL)

        XCTAssertThrowsError(try DiagnosticLogger.append(Data("blocked".utf8), to: logURL))
        XCTAssertEqual(try Data(contentsOf: linkURL), Data("original".utf8))
    }

    func testAppendRejectsRotatedSymlinkWithoutTruncatingTarget() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        let rotatedURL = logURL.appendingPathExtension("1")
        let targetURL = directory.appendingPathComponent("target.txt")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let original = Data(repeating: 65, count: DiagnosticLogger.maxLogBytes)
        try original.write(to: logURL)
        try Data("do-not-touch".utf8).write(to: targetURL)
        try FileManager.default.createSymbolicLink(at: rotatedURL, withDestinationURL: targetURL)

        XCTAssertThrowsError(try DiagnosticLogger.append(Data("rotate".utf8), to: logURL))
        XCTAssertEqual(try Data(contentsOf: logURL), original)
        XCTAssertEqual(try Data(contentsOf: targetURL), Data("do-not-touch".utf8))
    }

    func testAppendRejectsRotatedHardLinkWithoutTruncatingTarget() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        let rotatedURL = logURL.appendingPathExtension("1")
        let targetURL = directory.appendingPathComponent("target.txt")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let original = Data(repeating: 65, count: DiagnosticLogger.maxLogBytes)
        try original.write(to: logURL)
        try Data("do-not-touch".utf8).write(to: targetURL)
        try FileManager.default.linkItem(at: targetURL, to: rotatedURL)

        XCTAssertThrowsError(try DiagnosticLogger.append(Data("rotate".utf8), to: logURL))
        XCTAssertEqual(try Data(contentsOf: logURL), original)
        XCTAssertEqual(try Data(contentsOf: targetURL), Data("do-not-touch".utf8))
    }

    func testOversizedEntryKeepsOnlyTheNewestTail() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerTests-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        defer { try? FileManager.default.removeItem(at: directory) }

        let oversized = Data(repeating: 65, count: 128)
            + Data(repeating: 66, count: DiagnosticLogger.maxLogBytes)
        try DiagnosticLogger.append(oversized, to: logURL)

        XCTAssertEqual(
            try Data(contentsOf: logURL),
            Data(repeating: 66, count: DiagnosticLogger.maxLogBytes)
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: logURL.appendingPathExtension("1").path))
    }

    private func permissions(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap((attributes[.posixPermissions] as? NSNumber)?.intValue)
    }
}
