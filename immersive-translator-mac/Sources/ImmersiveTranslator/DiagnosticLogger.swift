import Foundation

enum DiagnosticLogger {
    private static let queue = DispatchQueue(label: "local.immersive-translator.diagnostic-logger")
    // Keep diagnostics useful without allowing an unattended app to grow the log forever.
    private static let maxLogBytes = 1_048_576
    private static let privateLogPermissions: NSNumber = 0o600

    static func log(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(message)\n"

        queue.async {
            do {
                let url = logFileURL()
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )

                if let data = line.data(using: .utf8) {
                    let fileManager = FileManager.default
                    let dataToWrite = data.count > maxLogBytes
                        ? Data(data.suffix(maxLogBytes))
                        : data

                    if fileManager.fileExists(atPath: url.path),
                       let attributes = try? fileManager.attributesOfItem(atPath: url.path),
                       let existingBytes = (attributes[.size] as? NSNumber)?.intValue,
                       existingBytes + dataToWrite.count > maxLogBytes {
                        let rotatedURL = url.appendingPathExtension("1")
                        try? fileManager.removeItem(at: rotatedURL)
                        try fileManager.moveItem(at: url, to: rotatedURL)
                        try fileManager.setAttributes(
                            [.posixPermissions: privateLogPermissions],
                            ofItemAtPath: rotatedURL.path
                        )
                    }

                    if fileManager.fileExists(atPath: url.path) {
                        let handle = try FileHandle(forWritingTo: url)
                        try handle.seekToEnd()
                        try handle.write(contentsOf: dataToWrite)
                        try handle.close()
                    } else {
                        try dataToWrite.write(to: url, options: [.atomic])
                    }

                    // Diagnostic output can include endpoint metadata; keep it private to the app user.
                    try fileManager.setAttributes(
                        [.posixPermissions: privateLogPermissions],
                        ofItemAtPath: url.path
                    )
                }
            } catch {
                NSLog("Failed to write diagnostic log: \(error.localizedDescription)")
            }
        }
    }

    static func logFileURL() -> URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return baseURL
            .appendingPathComponent("ImmersiveTranslator", isDirectory: true)
            .appendingPathComponent("diagnostic.log")
    }
}
