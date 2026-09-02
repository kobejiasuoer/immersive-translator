import Foundation
import ProviderCore

// Keep the app-facing name stable while the implementation lives in the
// reusable, tested ProviderCore target.
enum DiagnosticLogger {
    static func log(_ message: String) {
        ProviderCore.DiagnosticLogger.log(message)
    }

    static func logFileURL() -> URL {
        ProviderCore.DiagnosticLogger.logFileURL()
    }
}
