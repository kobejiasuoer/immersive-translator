#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PATH="$ROOT_DIR/Sources/ProviderCore/DiagnosticLogger.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-diagnostic-logger.XXXXXX")"
HARNESS_PATH="$TMP_DIR/DiagnosticLoggerCheck.swift"
BINARY_PATH="$TMP_DIR/check_diagnostic_logger"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$HARNESS_PATH" <<'SWIFT'
import Darwin
import Foundation

@main
private struct DiagnosticLoggerCheck {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DiagnosticLoggerCheck-\(UUID().uuidString)", isDirectory: true)
        let logURL = directory.appendingPathComponent("diagnostic.log")
        let symlinkURL = directory.appendingPathComponent("symlink.log")
        let fifoURL = directory.appendingPathComponent("fifo.log")
        let targetURL = directory.appendingPathComponent("target.txt")
        let oversizedURL = directory.appendingPathComponent("oversized.log")
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(repeating: 65, count: DiagnosticLogger.maxLogBytes + 128).write(to: logURL)
        try DiagnosticLogger.append(Data("new-entry\n".utf8), to: logURL)

        let current = try Data(contentsOf: logURL)
        let rotated = try Data(contentsOf: logURL.appendingPathExtension("1"))
        guard current == Data("new-entry\n".utf8),
              rotated == Data(repeating: 65, count: DiagnosticLogger.maxLogBytes) else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: "rotation/cap check failed"])
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: logURL.path)
        let rotatedAttributes = try FileManager.default.attributesOfItem(
            atPath: logURL.appendingPathExtension("1").path
        )
        guard (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (rotatedAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600 else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 2, userInfo: [NSLocalizedDescriptionKey: "permissions check failed"])
        }

        try Data("do-not-touch".utf8).write(to: targetURL)
        try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: targetURL)
        guard (try? DiagnosticLogger.append(Data("blocked".utf8), to: symlinkURL)) == nil,
              try Data(contentsOf: targetURL) == Data("do-not-touch".utf8) else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 3, userInfo: [NSLocalizedDescriptionKey: "symlink check failed"])
        }

        try FileManager.default.removeItem(at: logURL.appendingPathExtension("1"))
        let fullLog = Data(repeating: 65, count: DiagnosticLogger.maxLogBytes)
        try fullLog.write(to: logURL)
        try FileManager.default.linkItem(at: targetURL, to: logURL.appendingPathExtension("1"))
        guard (try? DiagnosticLogger.append(Data("rotate".utf8), to: logURL)) == nil,
              try Data(contentsOf: logURL) == fullLog,
              try Data(contentsOf: targetURL) == Data("do-not-touch".utf8) else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 4, userInfo: [NSLocalizedDescriptionKey: "rotated hard-link check failed"])
        }

        let oversized = Data(repeating: 65, count: 128)
            + Data(repeating: 66, count: DiagnosticLogger.maxLogBytes)
        try DiagnosticLogger.append(oversized, to: oversizedURL)
        guard try Data(contentsOf: oversizedURL) == Data(repeating: 66, count: DiagnosticLogger.maxLogBytes) else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 5, userInfo: [NSLocalizedDescriptionKey: "oversized entry tail check failed"])
        }

        guard mkfifo(fifoURL.path, 0o600) == 0 else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 6, userInfo: [NSLocalizedDescriptionKey: "failed to create FIFO"])
        }
        let fifoStartedAt = Date()
        guard (try? DiagnosticLogger.append(Data("blocked".utf8), to: fifoURL)) == nil,
              Date().timeIntervalSince(fifoStartedAt) < 1 else {
            throw NSError(domain: "DiagnosticLoggerCheck", code: 7, userInfo: [NSLocalizedDescriptionKey: "FIFO rejection check failed"])
        }

        print("ok: diagnostic logger cap, rotation, permissions, link, oversized-entry, and FIFO checks passed")
    }
}
SWIFT

swiftc "$SOURCE_PATH" "$HARNESS_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
