import CryptoKit
import Foundation

enum UpdateCheckError: LocalizedError {
    case missingUpdateSource
    case invalidUpdateSource
    case badResponse(Int)
    case invalidManifest
    case invalidManifestField(field: String, value: String, reason: String)
    case invalidManifestURL(field: String, value: String)
    case insecureManifestURL(field: String, value: String)

    var errorDescription: String? {
        switch self {
        case .missingUpdateSource:
            return "当前构建没有配置更新源。正式发布包需要在构建时设置 APP_UPDATE_MANIFEST_URL。"
        case .invalidUpdateSource:
            return "更新源地址不是有效 HTTP/HTTPS URL。请检查 APP_UPDATE_MANIFEST_URL。"
        case .badResponse(let statusCode):
            return "更新源返回 HTTP \(statusCode)。请稍后重试，或检查更新清单是否已发布。"
        case .invalidManifest:
            return "更新清单格式不正确。请检查 update-manifest.json。"
        case .invalidManifestField(let field, let value, let reason):
            return "更新清单里的 \(field) 不可用：\(value)。\(reason)"
        case .invalidManifestURL(let field, let value):
            return "更新清单里的 \(field) 不是有效 HTTP/HTTPS 地址或相对路径：\(value)。"
        case .insecureManifestURL(let field, let value):
            return "更新清单通过 HTTPS 加载，但 \(field) 指向了不安全的 HTTP 地址：\(value)。"
        }
    }
}

enum UpdateDownloadError: LocalizedError {
    case badResponse(Int)
    case invalidChecksum
    case packageSizeMismatch(expected: Int64, actual: Int64)
    case checksumMismatch(expected: String, actual: String)
    case cannotPrepareDestination
    case cannotExtractPackage(reason: String)
    case missingAppBundle
    case multipleAppBundles([String])
    case missingAppMetadata(field: String)
    case bundleIdentifierMismatch(expected: String, actual: String)
    case versionMismatch(expected: String, actual: String)
    case buildMismatch(expected: String, actual: String)
    case missingExecutable(String)
    case invalidCodeSignature(reason: String)

    var errorDescription: String? {
        switch self {
        case .badResponse(let statusCode):
            return "更新包下载返回 HTTP \(statusCode)。请稍后重试，或检查下载地址是否已发布。"
        case .invalidChecksum:
            return "更新清单里的 sha256 不是有效格式。请检查 update-manifest.json。"
        case .packageSizeMismatch(let expected, let actual):
            return "更新包大小校验失败。期望：\(expected) bytes，实际：\(actual) bytes。请不要安装这个文件。"
        case .checksumMismatch(let expected, let actual):
            return "更新包校验失败。期望 sha256：\(expected)，实际 sha256：\(actual)。请不要安装这个文件。"
        case .cannotPrepareDestination:
            return "无法准备下载目录。请检查 Downloads 目录权限。"
        case .cannotExtractPackage(let reason):
            return "更新包 sha256 已通过，但无法解压检查 zip 内容：\(reason)"
        case .missingAppBundle:
            return "更新包 sha256 已通过，但 zip 里没有找到可安装的 .app。"
        case .multipleAppBundles(let paths):
            return "更新包 sha256 已通过，但 zip 里发现多个 .app，无法安全判断要安装哪一个：\(paths.joined(separator: ", "))"
        case .missingAppMetadata(let field):
            return "更新包 sha256 已通过，但 zip 里的 App 缺少 \(field)。"
        case .bundleIdentifierMismatch(let expected, let actual):
            return "更新包 sha256 已通过，但 App Bundle ID 不匹配。期望：\(expected)，实际：\(actual)。"
        case .versionMismatch(let expected, let actual):
            return "更新包 sha256 已通过，但 App 版本号不匹配。期望：\(expected)，实际：\(actual)。"
        case .buildMismatch(let expected, let actual):
            return "更新包 sha256 已通过，但 App 构建号不匹配。期望：\(expected)，实际：\(actual)。"
        case .missingExecutable(let executable):
            return "更新包 sha256 已通过，但 zip 里的 App 缺少可执行文件：\(executable)。"
        case .invalidCodeSignature(let reason):
            return "更新包 sha256 已通过，但 zip 里的 App 代码签名不可验证：\(reason)"
        }
    }
}

enum UpdateInstallPreparationError: LocalizedError {
    case cannotPrepareStagingDirectory(reason: String)
    case cannotPrepareInstallerScript(reason: String)
    case invalidCurrentApplicationLocation(String)
    case cannotStartInstaller(reason: String)

    var errorDescription: String? {
        switch self {
        case .cannotPrepareStagingDirectory(let reason):
            return "更新包已校验，但无法准备临时安装目录：\(reason)"
        case .cannotPrepareInstallerScript(let reason):
            return "更新包已校验并解压，但无法准备替换安装脚本：\(reason)"
        case .invalidCurrentApplicationLocation(let path):
            return "更新包已校验并解压，但当前 App 位置不像可替换的 .app：\(path)。请改用手动安装。"
        case .cannotStartInstaller(let reason):
            return "更新包已校验并解压，但无法启动替换安装流程：\(reason)"
        }
    }
}

struct UpdatePackageVerification {
    let appName: String
    let bundleIdentifier: String
    let version: String
    let build: String
    let executableName: String
    let appRelativePath: String
    let codeSignatureSummary: String

    var displayName: String {
        "\(appName) \(version) (\(build))"
    }
}

struct UpdateDownloadResult {
    let fileURL: URL
    let sha256: String
    let byteCount: Int64
    let packageVerification: UpdatePackageVerification
}

struct PreparedUpdateInstallation {
    let stagedAppURL: URL
    let targetAppURL: URL
    let scriptURL: URL
    let logURL: URL
    let packageVerification: UpdatePackageVerification
}

struct UpdateCheckResult {
    let currentVersion: String
    let currentBuild: String
    let manifestURL: URL
    let manifest: UpdateManifest

    var hasUpdate: Bool {
        Self.isNewer(
            latestVersion: manifest.version,
            latestBuild: manifest.build,
            currentVersion: currentVersion,
            currentBuild: currentBuild
        )
    }

    var isSystemCompatible: Bool {
        guard let minimumSystemVersion = manifest.minimumSystemVersion?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !minimumSystemVersion.isEmpty else {
            return true
        }
        return Self.compareVersion(currentSystemVersion, minimumSystemVersion) != .orderedAscending
    }

    var latestDisplayVersion: String {
        "\(manifest.version) (\(manifest.build))"
    }

    var currentDisplayVersion: String {
        "\(currentVersion) (\(currentBuild))"
    }

    var currentSystemVersion: String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    var minimumSystemDisplayVersion: String {
        let minimumSystemVersion = manifest.minimumSystemVersion?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return minimumSystemVersion.isEmpty ? "未声明" : minimumSystemVersion
    }

    var downloadURL: URL {
        guard manifest.downloadURL.scheme == nil,
              let resolvedURL = URL(string: manifest.downloadURL.relativeString, relativeTo: manifestURL) else {
            return manifest.downloadURL
        }
        return resolvedURL.absoluteURL
    }

    var releaseNotesURL: URL? {
        guard let releaseNotesURL = manifest.releaseNotesURL else {
            return nil
        }
        guard releaseNotesURL.scheme == nil,
              let resolvedURL = URL(string: releaseNotesURL.relativeString, relativeTo: manifestURL) else {
            return releaseNotesURL
        }
        return resolvedURL.absoluteURL
    }

    private static func isNewer(
        latestVersion: String,
        latestBuild: String,
        currentVersion: String,
        currentBuild: String
    ) -> Bool {
        let versionComparison = compareVersion(latestVersion, currentVersion)
        if versionComparison != .orderedSame {
            return versionComparison == .orderedDescending
        }
        return compareBuild(latestBuild, currentBuild) == .orderedDescending
    }

    private static func compareVersion(_ left: String, _ right: String) -> ComparisonResult {
        let leftParts = numericVersionParts(left)
        let rightParts = numericVersionParts(right)
        let maxCount = max(leftParts.count, rightParts.count)

        for index in 0..<maxCount {
            let leftValue = index < leftParts.count ? leftParts[index] : 0
            let rightValue = index < rightParts.count ? rightParts[index] : 0
            if leftValue < rightValue {
                return .orderedAscending
            }
            if leftValue > rightValue {
                return .orderedDescending
            }
        }
        return .orderedSame
    }

    private static func compareBuild(_ left: String, _ right: String) -> ComparisonResult {
        if let leftInt = Int(left), let rightInt = Int(right) {
            if leftInt < rightInt { return .orderedAscending }
            if leftInt > rightInt { return .orderedDescending }
            return .orderedSame
        }
        return left.localizedStandardCompare(right)
    }

    private static func numericVersionParts(_ version: String) -> [Int] {
        version
            .split { !$0.isNumber }
            .map { Int($0) ?? 0 }
    }
}

struct UpdateManifest: Decodable {
    let version: String
    let build: String
    let minimumSystemVersion: String?
    let downloadURL: URL
    let sizeBytes: Int64?
    let sha256: String
    let releaseNotesURL: URL?
    let publishedAt: String?

    enum CodingKeys: String, CodingKey {
        case version
        case build
        case minimumSystemVersion = "minimum_system_version"
        case downloadURL = "download_url"
        case sizeBytes = "size_bytes"
        case sha256
        case releaseNotesURL = "release_notes_url"
        case publishedAt = "published_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        build = try container.decode(String.self, forKey: .build)
        minimumSystemVersion = try container.decodeIfPresent(String.self, forKey: .minimumSystemVersion)
        downloadURL = try container.decode(URL.self, forKey: .downloadURL)
        sizeBytes = try Self.decodeSizeBytes(from: container)
        sha256 = try container.decode(String.self, forKey: .sha256)
        releaseNotesURL = try container.decodeIfPresent(URL.self, forKey: .releaseNotesURL)
        publishedAt = try container.decodeIfPresent(String.self, forKey: .publishedAt)
    }

    private static func decodeSizeBytes(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> Int64? {
        guard container.contains(.sizeBytes),
              !(try container.decodeNil(forKey: .sizeBytes)) else {
            return nil
        }

        if let value = try? container.decode(Int64.self, forKey: .sizeBytes) {
            return value
        }
        if let value = try? container.decode(String.self, forKey: .sizeBytes) {
            throw UpdateCheckError.invalidManifestField(
                field: "size_bytes",
                value: value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "<empty>" : value,
                reason: "请填写 JSON 整数，例如 123456，不要加引号。"
            )
        }
        if let value = try? container.decode(Double.self, forKey: .sizeBytes) {
            throw UpdateCheckError.invalidManifestField(
                field: "size_bytes",
                value: "\(value)",
                reason: "请填写大于 0 的整数，不要使用小数。"
            )
        }
        throw UpdateCheckError.invalidManifestField(
            field: "size_bytes",
            value: "<unsupported>",
            reason: "请填写大于 0 的整数，表示 release zip 的字节数。"
        )
    }
}

enum UpdateChecker {
    static var hasConfiguredUpdateSource: Bool {
        validManifestURL() != nil
    }

    static func check() async throws -> UpdateCheckResult {
        let bundle = Bundle.main
        let currentVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let currentBuild = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"

        guard !manifestSource().isEmpty else {
            throw UpdateCheckError.missingUpdateSource
        }
        guard let url = validManifestURL() else {
            throw UpdateCheckError.invalidUpdateSource
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw UpdateCheckError.badResponse(httpResponse.statusCode)
        }

        let decoder = JSONDecoder()
        let manifest: UpdateManifest
        do {
            manifest = try decoder.decode(UpdateManifest.self, from: data)
        } catch let error as UpdateCheckError {
            throw error
        } catch {
            throw UpdateCheckError.invalidManifest
        }
        try validateManifest(manifest, manifestURL: url)

        return UpdateCheckResult(
            currentVersion: currentVersion,
            currentBuild: currentBuild,
            manifestURL: url,
            manifest: manifest
        )
    }

    /// 下载更新包并校验（大小 + sha256 + zip 内 App 元数据 + 签名结构）。
    ///
    /// - Parameter progress: 可选进度回调 `(已下载字节数, 预期总字节数)`。总字节数取
    ///   HTTP Content-Length，缺失时回落 manifest 的 size_bytes，两者都没有则回调
    ///   `nil`（UI 转不确定进度）。回调在下载任务线程发出、按 128KB 节流；不传时
    ///   走原 URLSession.download 路径（菜单栏更新流程，行为与签名逐字节不变）。
    static func downloadPackage(
        for result: UpdateCheckResult,
        progress: ((_ bytesDownloaded: Int64, _ expectedTotal: Int64?) -> Void)? = nil
    ) async throws -> UpdateDownloadResult {
        let temporaryURL: URL
        if let progress {
            temporaryURL = try await streamedDownload(withProgress: result, progress: progress)
        } else {
            var request = URLRequest(url: result.downloadURL)
            request.timeoutInterval = 90
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

            let (downloadedURL, response) = try await URLSession.shared.download(for: request)
            if let httpResponse = response as? HTTPURLResponse,
               !(200..<300).contains(httpResponse.statusCode) {
                throw UpdateDownloadError.badResponse(httpResponse.statusCode)
            }
            temporaryURL = downloadedURL
        }

        let integrity = try verifyPackageIntegrity(at: temporaryURL, result: result)
        let packageVerification = try verifyDownloadedPackage(at: temporaryURL, result: result)
        let destinationURL = try preparedDownloadURL(for: result.downloadURL)
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
        DiagnosticLogger.log("update.download.success file=\(destinationURL.path) bytes=\(integrity.byteCount) sha256=\(integrity.sha256) appBundleID=\(packageVerification.bundleIdentifier) appVersion=\(packageVerification.version) appBuild=\(packageVerification.build)")
        return UpdateDownloadResult(
            fileURL: destinationURL,
            sha256: integrity.sha256,
            byteCount: integrity.byteCount,
            packageVerification: packageVerification
        )
    }

    /// 带进度下载：URLSessionDownloadDelegate 的 didWriteData 回调驱动进度，
    /// 走系统级下载管线（不逐字节 await，也不把整包缓冲在内存），完成后与
    /// download 路径共用同一套校验流程。
    private static func streamedDownload(
        withProgress result: UpdateCheckResult,
        progress: @escaping (_ bytesDownloaded: Int64, _ expectedTotal: Int64?) -> Void
    ) async throws -> URL {
        let delegate = DownloadProgressDelegate(
            progress: progress,
            fallbackTotalBytes: result.manifest.sizeBytes
        )
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: result.downloadURL)
        // 下载任务的超时是「相邻两次数据之间的空闲超时」，取宽松值避免慢网误杀。
        request.timeoutInterval = 90
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let (downloadedURL, response) = try await session.download(for: request)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw UpdateDownloadError.badResponse(httpResponse.statusCode)
        }
        // session 持有的临时文件随会话失效被回收；趁会话仍存活先搬到自管临时路径，
        // 后续校验/落盘与文件生命周期解耦（defer 的 invalidate 不再影响它）。
        let stableURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("update-download-\(UUID().uuidString).zip")
        try FileManager.default.moveItem(at: downloadedURL, to: stableURL)
        return stableURL
    }

    /// 下载进度桥：didWriteData 在 URLSession 的 delegate 队列（串行）上回调，
    /// 按 128KB 节流后转发给 UI 回调；totalBytesExpectedToWrite ≤ 0（服务端未给
    /// Content-Length）时回落 manifest 的 size_bytes，两者都没有则报 nil。
    private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate {
        private let progress: (_ bytesDownloaded: Int64, _ expectedTotal: Int64?) -> Void
        private let fallbackTotalBytes: Int64?
        private let reportGranularity: Int64 = 128 * 1024
        private var lastReported: Int64 = 0

        init(
            progress: @escaping (_ bytesDownloaded: Int64, _ expectedTotal: Int64?) -> Void,
            fallbackTotalBytes: Int64? = nil
        ) {
            self.progress = progress
            self.fallbackTotalBytes = fallbackTotalBytes
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didWriteData bytesWritten: Int64,
            totalBytesWritten: Int64,
            totalBytesExpectedToWrite: Int64
        ) {
            guard totalBytesWritten - lastReported >= reportGranularity || totalBytesWritten == totalBytesExpectedToWrite else {
                return
            }
            lastReported = totalBytesWritten
            let expected: Int64?
            if totalBytesExpectedToWrite > 0 {
                expected = totalBytesExpectedToWrite
            } else if let fallbackTotalBytes, fallbackTotalBytes > 0 {
                expected = fallbackTotalBytes
            } else {
                expected = nil
            }
            progress(totalBytesWritten, expected)
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didFinishDownloadingTo location: URL
        ) {
            // async download(for:) 负责把文件交回调用方；这里只需满足协议。
        }
    }

    static func prepareInstallation(
        for download: UpdateDownloadResult,
        result: UpdateCheckResult
    ) throws -> PreparedUpdateInstallation {
        let integrity = try verifyPackageIntegrity(at: download.fileURL, result: result)
        guard integrity.sha256 == download.sha256 else {
            throw UpdateDownloadError.checksumMismatch(expected: download.sha256, actual: integrity.sha256)
        }
        guard integrity.byteCount == download.byteCount else {
            throw UpdateDownloadError.packageSizeMismatch(expected: download.byteCount, actual: integrity.byteCount)
        }
        _ = try verifyDownloadedPackage(at: download.fileURL, result: result)

        let fileManager = FileManager.default
        let stagingRootURL: URL
        do {
            stagingRootURL = try makeStagingDirectory()
        } catch {
            throw UpdateInstallPreparationError.cannotPrepareStagingDirectory(reason: error.localizedDescription)
        }

        do {
            try extractZip(download.fileURL, to: stagingRootURL)
        } catch {
            try? fileManager.removeItem(at: stagingRootURL)
            throw error
        }

        do {
            let packageVerification = try verifiedAppBundle(in: stagingRootURL, result: result)
            let stagedAppURL = stagingRootURL.appendingPathComponent(packageVerification.appRelativePath)
            let targetAppURL = try currentApplicationURL()
            let scriptURL = stagingRootURL.appendingPathComponent("install-update.command")
            let logURL = stagingRootURL.appendingPathComponent("install-update.log")
            try writeInstallerScript(
                to: scriptURL,
                logURL: logURL,
                sourceAppURL: stagedAppURL,
                targetAppURL: targetAppURL,
                expectedBundleIdentifier: packageVerification.bundleIdentifier,
                expectedVersion: packageVerification.version,
                expectedBuild: packageVerification.build,
                executableName: packageVerification.executableName
            )
            DiagnosticLogger.log("update.install.prepare.success stagedApp=\(stagedAppURL.path) targetApp=\(targetAppURL.path) script=\(scriptURL.path)")
            return PreparedUpdateInstallation(
                stagedAppURL: stagedAppURL,
                targetAppURL: targetAppURL,
                scriptURL: scriptURL,
                logURL: logURL,
                packageVerification: packageVerification
            )
        } catch {
            try? fileManager.removeItem(at: stagingRootURL)
            throw error
        }
    }

    static func startPreparedInstallation(_ preparedInstallation: PreparedUpdateInstallation) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [preparedInstallation.scriptURL.path]

        do {
            try process.run()
        } catch {
            throw UpdateInstallPreparationError.cannotStartInstaller(reason: error.localizedDescription)
        }

        DiagnosticLogger.log("update.install.script.started script=\(preparedInstallation.scriptURL.path)")
    }

    private static func verifyDownloadedPackage(at zipURL: URL, result: UpdateCheckResult) throws -> UpdatePackageVerification {
        let fileManager = FileManager.default
        let extractionURL = fileManager.temporaryDirectory
            .appendingPathComponent("ImmersiveTranslator-update-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: extractionURL, withIntermediateDirectories: true)
        defer {
            try? fileManager.removeItem(at: extractionURL)
        }

        try extractZip(zipURL, to: extractionURL)
        return try verifiedAppBundle(in: extractionURL, result: result)
    }

    private static func verifyPackageIntegrity(
        at zipURL: URL,
        result: UpdateCheckResult
    ) throws -> (sha256: String, byteCount: Int64) {
        let expectedSHA256 = result.manifest.sha256
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard expectedSHA256.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw UpdateDownloadError.invalidChecksum
        }

        let data = try Data(contentsOf: zipURL)
        let actualByteCount = Int64(data.count)
        if let expectedByteCount = result.manifest.sizeBytes,
           actualByteCount != expectedByteCount {
            throw UpdateDownloadError.packageSizeMismatch(expected: expectedByteCount, actual: actualByteCount)
        }

        let actualSHA256 = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
        guard actualSHA256 == expectedSHA256 else {
            throw UpdateDownloadError.checksumMismatch(expected: expectedSHA256, actual: actualSHA256)
        }

        return (sha256: actualSHA256, byteCount: actualByteCount)
    }

    private static func verifiedAppBundle(
        in extractionURL: URL,
        result: UpdateCheckResult
    ) throws -> UpdatePackageVerification {
        let appURLs = appBundles(in: extractionURL)
        guard !appURLs.isEmpty else {
            throw UpdateDownloadError.missingAppBundle
        }

        let expectedBundleID = try currentBundleIdentifier()
        let matchingAppURLs = appURLs.filter { appBundleIdentifier(at: $0) == expectedBundleID }
        let selectedAppURL: URL
        if appURLs.count == 1 {
            selectedAppURL = appURLs[0]
        } else if matchingAppURLs.count == 1 {
            selectedAppURL = matchingAppURLs[0]
        } else {
            throw UpdateDownloadError.multipleAppBundles(appURLs.map { relativePath(of: $0, from: extractionURL) })
        }

        return try verifyAppBundle(
            at: selectedAppURL,
            relativeTo: extractionURL,
            expectedBundleIdentifier: expectedBundleID,
            expectedVersion: result.manifest.version,
            expectedBuild: result.manifest.build
        )
    }

    private static func makeStagingDirectory() throws -> URL {
        let fileManager = FileManager.default
        let parentURL = fileManager.temporaryDirectory
            .appendingPathComponent("ImmersiveTranslator-installations", isDirectory: true)
        try fileManager.createDirectory(at: parentURL, withIntermediateDirectories: true)
        let directoryURL = parentURL
            .appendingPathComponent("update-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        return directoryURL
    }

    private static func extractZip(_ zipURL: URL, to destinationURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", zipURL.path, destinationURL.path]

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        do {
            try process.run()
        } catch {
            throw UpdateDownloadError.cannotExtractPackage(reason: error.localizedDescription)
        }
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
            let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = String(data: outputData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let reason = [detail, fallback]
                .compactMap { value -> String? in
                    guard let value, !value.isEmpty else { return nil }
                    return value
                }
                .first ?? "ditto 退出状态 \(process.terminationStatus)"
            throw UpdateDownloadError.cannotExtractPackage(reason: reason)
        }
    }

    private static func appBundles(in directoryURL: URL) -> [URL] {
        let fileManager = FileManager.default
        guard let enumerator = fileManager.enumerator(
            at: directoryURL,
            includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var appURLs: [URL] = []
        for case let url as URL in enumerator {
            if url.pathExtension.lowercased() == "app" {
                appURLs.append(url)
                enumerator.skipDescendants()
            }
        }
        return appURLs.sorted { $0.path < $1.path }
    }

    private static func verifyAppBundle(
        at appURL: URL,
        relativeTo extractionURL: URL,
        expectedBundleIdentifier: String,
        expectedVersion: String,
        expectedBuild: String
    ) throws -> UpdatePackageVerification {
        guard let bundle = Bundle(url: appURL) else {
            throw UpdateDownloadError.missingAppMetadata(field: "Info.plist")
        }

        let bundleIdentifier = cleanInfoValue(bundle.bundleIdentifier)
        guard !bundleIdentifier.isEmpty else {
            throw UpdateDownloadError.missingAppMetadata(field: "CFBundleIdentifier")
        }
        guard bundleIdentifier == expectedBundleIdentifier else {
            throw UpdateDownloadError.bundleIdentifierMismatch(expected: expectedBundleIdentifier, actual: bundleIdentifier)
        }

        let version = cleanInfoValue(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString"))
        guard !version.isEmpty else {
            throw UpdateDownloadError.missingAppMetadata(field: "CFBundleShortVersionString")
        }
        guard version == expectedVersion.trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw UpdateDownloadError.versionMismatch(expected: expectedVersion, actual: version)
        }

        let build = cleanInfoValue(bundle.object(forInfoDictionaryKey: "CFBundleVersion"))
        guard !build.isEmpty else {
            throw UpdateDownloadError.missingAppMetadata(field: "CFBundleVersion")
        }
        guard build == expectedBuild.trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw UpdateDownloadError.buildMismatch(expected: expectedBuild, actual: build)
        }

        let executableName = cleanInfoValue(bundle.object(forInfoDictionaryKey: "CFBundleExecutable"))
        guard !executableName.isEmpty else {
            throw UpdateDownloadError.missingAppMetadata(field: "CFBundleExecutable")
        }
        let executableURL = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(executableName)
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw UpdateDownloadError.missingExecutable(executableName)
        }

        let codeSignatureSummary = try verifyCodeSignature(at: appURL)
        let appName = cleanInfoValue(bundle.object(forInfoDictionaryKey: "CFBundleName"))
        let fallbackName = (appURL.lastPathComponent as NSString).deletingPathExtension
        return UpdatePackageVerification(
            appName: appName.isEmpty ? fallbackName : appName,
            bundleIdentifier: bundleIdentifier,
            version: version,
            build: build,
            executableName: executableName,
            appRelativePath: relativePath(of: appURL, from: extractionURL),
            codeSignatureSummary: codeSignatureSummary
        )
    }

    private static func verifyCodeSignature(at appURL: URL) throws -> String {
        let verification = runProcess(
            executable: "/usr/bin/codesign",
            arguments: ["--verify", "--deep", "--strict", "--verbose=2", appURL.path]
        )
        guard verification.status == 0 else {
            throw UpdateDownloadError.invalidCodeSignature(reason: verification.output)
        }

        let details = runProcess(
            executable: "/usr/bin/codesign",
            arguments: ["-dv", "--verbose=4", appURL.path]
        )
        return codeSignatureSummary(from: details.output)
    }

    private static func codeSignatureSummary(from output: String) -> String {
        let lines = output
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }

        if let developerID = lines.first(where: { $0.hasPrefix("Authority=Developer ID Application") }) {
            return developerID.replacingOccurrences(of: "Authority=", with: "")
        }
        if let authority = lines.first(where: { $0.hasPrefix("Authority=") }) {
            return authority.replacingOccurrences(of: "Authority=", with: "")
        }
        if lines.contains(where: { $0 == "Signature=adhoc" }) {
            return "ad-hoc 签名"
        }
        return "代码签名结构可验证"
    }

    private static func runProcess(executable: String, arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        do {
            try process.run()
        } catch {
            return (1, error.localizedDescription)
        }
        process.waitUntilExit()

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let output = [
            String(data: errorData, encoding: .utf8),
            String(data: outputData, encoding: .utf8)
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return (process.terminationStatus, output.isEmpty ? "codesign 退出状态 \(process.terminationStatus)" : output)
    }

    private static func currentBundleIdentifier() throws -> String {
        let bundleIdentifier = cleanInfoValue(Bundle.main.bundleIdentifier)
        guard !bundleIdentifier.isEmpty else {
            throw UpdateDownloadError.missingAppMetadata(field: "当前 App 的 Bundle ID")
        }
        return bundleIdentifier
    }

    private static func currentApplicationURL() throws -> URL {
        var appURL = Bundle.main.bundleURL.standardizedFileURL
        if appURL.pathExtension.lowercased() != "app" {
            appURL = Bundle.main.executableURL?
                .standardizedFileURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                ?? appURL
        }

        guard appURL.pathExtension.lowercased() == "app" else {
            throw UpdateInstallPreparationError.invalidCurrentApplicationLocation(appURL.path)
        }
        return appURL
    }

    private static func appBundleIdentifier(at appURL: URL) -> String {
        guard let bundle = Bundle(url: appURL) else { return "" }
        return cleanInfoValue(bundle.bundleIdentifier)
    }

    private static func cleanInfoValue(_ value: Any?) -> String {
        if let value = value as? String {
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let value else { return "" }
        return String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func relativePath(of url: URL, from directoryURL: URL) -> String {
        let basePath = directoryURL.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        let prefix = basePath + "/"
        guard path.hasPrefix(prefix) else {
            return url.lastPathComponent
        }
        return String(path.dropFirst(prefix.count))
    }

    private static func manifestSource() -> String {
        ((Bundle.main.object(forInfoDictionaryKey: "ITUpdateManifestURL") as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func validManifestURL() -> URL? {
        guard let url = URL(string: manifestSource()),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return nil
        }
        return url
    }

    private static func validateManifest(_ manifest: UpdateManifest, manifestURL: URL) throws {
        try validateVersion(manifest.version)
        try validateBuild(manifest.build)
        try validateChecksum(manifest.sha256)
        if let minimumSystemVersion = manifest.minimumSystemVersion {
            try validateMinimumSystemVersion(minimumSystemVersion)
        }
        if let sizeBytes = manifest.sizeBytes {
            try validatePackageSize(sizeBytes)
        }
        try validateManifestURL(manifest.downloadURL, field: "download_url", manifestURL: manifestURL)
        if let releaseNotesURL = manifest.releaseNotesURL {
            try validateManifestURL(releaseNotesURL, field: "release_notes_url", manifestURL: manifestURL)
        }
        if let publishedAt = manifest.publishedAt {
            try validatePublishedAt(publishedAt)
        }
    }

    private static func validateRequiredManifestString(_ value: String, field: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw UpdateCheckError.invalidManifestField(
                field: field,
                value: "<empty>",
                reason: "请在 update-manifest.json 中填写非空字符串。"
            )
        }
    }

    private static func validateVersion(_ value: String) throws {
        try validateRequiredManifestString(value, field: "version")
        let cleanValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanValue.range(of: #"^[0-9]+([.][0-9]+)*([-+._A-Za-z0-9]*)?$"#, options: .regularExpression) != nil else {
            throw UpdateCheckError.invalidManifestField(
                field: "version",
                value: cleanValue,
                reason: "请填写类似 1.2.3 的版本号；可以带短后缀，例如 1.2.3-beta.1。"
            )
        }
    }

    private static func validateBuild(_ value: String) throws {
        try validateRequiredManifestString(value, field: "build")
        let cleanValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanValue.range(of: #"^[0-9]+([.][0-9]+)*$"#, options: .regularExpression) != nil else {
            throw UpdateCheckError.invalidManifestField(
                field: "build",
                value: cleanValue,
                reason: "请填写数字构建号，例如 42 或 42.1。"
            )
        }
    }

    private static func validateChecksum(_ value: String) throws {
        let checksum = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard checksum.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw UpdateCheckError.invalidManifestField(
                field: "sha256",
                value: value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "<empty>" : value,
                reason: "sha256 必须是 64 位小写十六进制字符串。"
            )
        }
    }

    private static func validateMinimumSystemVersion(_ value: String) throws {
        let cleanValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanValue.range(of: #"^[0-9]+([.][0-9]+)*$"#, options: .regularExpression) != nil else {
            throw UpdateCheckError.invalidManifestField(
                field: "minimum_system_version",
                value: cleanValue.isEmpty ? "<empty>" : cleanValue,
                reason: "请填写类似 13.0 或 14.5.1 的 macOS 版本号。"
            )
        }
    }

    private static func validatePackageSize(_ value: Int64) throws {
        guard value > 0 else {
            throw UpdateCheckError.invalidManifestField(
                field: "size_bytes",
                value: "\(value)",
                reason: "请填写大于 0 的整数，表示 release zip 的字节数。"
            )
        }
    }

    private static func validatePublishedAt(_ value: String) throws {
        let cleanValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanValue.isEmpty else {
            throw UpdateCheckError.invalidManifestField(
                field: "published_at",
                value: "<empty>",
                reason: "请填写 ISO-8601 UTC 时间，例如 2026-06-10T12:34:56Z。"
            )
        }

        let formatter = ISO8601DateFormatter()
        guard formatter.date(from: cleanValue) != nil else {
            throw UpdateCheckError.invalidManifestField(
                field: "published_at",
                value: cleanValue,
                reason: "请填写 ISO-8601 UTC 时间，例如 2026-06-10T12:34:56Z。"
            )
        }
    }

    private static func validateManifestURL(_ url: URL, field: String, manifestURL: URL) throws {
        let rawValue = url.relativeString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawValue.isEmpty, !rawValue.hasPrefix("//") else {
            throw UpdateCheckError.invalidManifestURL(field: field, value: rawValue.isEmpty ? "<empty>" : rawValue)
        }

        let resolvedURL: URL
        if url.scheme == nil {
            guard let url = URL(string: rawValue, relativeTo: manifestURL)?.absoluteURL else {
                throw UpdateCheckError.invalidManifestURL(field: field, value: rawValue)
            }
            resolvedURL = url
        } else {
            resolvedURL = url
        }

        guard let scheme = resolvedURL.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            throw UpdateCheckError.invalidManifestURL(field: field, value: rawValue)
        }

        if manifestURL.scheme?.lowercased() == "https", scheme != "https" {
            throw UpdateCheckError.insecureManifestURL(field: field, value: rawValue)
        }
    }

    private static func preparedDownloadURL(for sourceURL: URL) throws -> URL {
        guard let downloadsURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            throw UpdateDownloadError.cannotPrepareDestination
        }

        let rawFilename = sourceURL.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        let filename = rawFilename.isEmpty ? "ImmersiveTranslator-update.zip" : rawFilename
        try FileManager.default.createDirectory(at: downloadsURL, withIntermediateDirectories: true)
        return uniqueURL(in: downloadsURL, filename: filename)
    }

    private static func uniqueURL(in directory: URL, filename: String) -> URL {
        let baseURL = directory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: baseURL.path) else {
            return baseURL
        }

        let nsFilename = filename as NSString
        let name = nsFilename.deletingPathExtension
        let pathExtension = nsFilename.pathExtension
        for index in 2...999 {
            let candidateFilename = pathExtension.isEmpty
                ? "\(name)-\(index)"
                : "\(name)-\(index).\(pathExtension)"
            let candidateURL = directory.appendingPathComponent(candidateFilename)
            if !FileManager.default.fileExists(atPath: candidateURL.path) {
                return candidateURL
            }
        }
        return directory.appendingPathComponent(UUID().uuidString + "-" + filename)
    }

    private static func writeInstallerScript(
        to scriptURL: URL,
        logURL: URL,
        sourceAppURL: URL,
        targetAppURL: URL,
        expectedBundleIdentifier: String,
        expectedVersion: String,
        expectedBuild: String,
        executableName: String
    ) throws {
        let script = """
        #!/bin/zsh
        set -u

        LOG_PATH=\(shellQuoted(logURL.path))
        SOURCE_APP=\(shellQuoted(sourceAppURL.path))
        TARGET_APP=\(shellQuoted(targetAppURL.path))
        BACKUP_APP="${TARGET_APP}.previous-update"
        EXPECTED_BUNDLE_ID=\(shellQuoted(expectedBundleIdentifier))
        EXPECTED_VERSION=\(shellQuoted(expectedVersion))
        EXPECTED_BUILD=\(shellQuoted(expectedBuild))
        EXECUTABLE_NAME=\(shellQuoted(executableName))
        TARGET_PARENT="$(dirname "$TARGET_APP")"
        RUNNING_NAME="$EXECUTABLE_NAME"

        log() {
          printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_PATH"
        }

        fail() {
          log "FAILED: $*"
          /usr/bin/open -R "$SOURCE_APP" >/dev/null 2>&1 || true
          /usr/bin/osascript -e 'display dialog "沉浸口语更新没有完成。已在 Finder 中显示已校验的新版本 App，请查看安装日志或手动拖入 Applications 替换。" buttons {"好"} default button "好" with icon caution' >/dev/null 2>&1 || true
          exit 1
        }

        plist_value() {
          /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null || true
        }

        verify_app_or_fail() {
          local app_path="$1"
          local context="$2"
          if ! verify_app "$app_path" "$context"; then
            fail "$context verification failed"
          fi
        }

        verify_app() {
          local app_path="$1"
          local context="$2"
          [[ -d "$app_path" ]] || { log "$context missing app: $app_path"; return 1; }
          [[ "$(plist_value CFBundleIdentifier "$app_path")" == "$EXPECTED_BUNDLE_ID" ]] || { log "$context bundle id mismatch"; return 1; }
          [[ "$(plist_value CFBundleShortVersionString "$app_path")" == "$EXPECTED_VERSION" ]] || { log "$context version mismatch"; return 1; }
          [[ "$(plist_value CFBundleVersion "$app_path")" == "$EXPECTED_BUILD" ]] || { log "$context build mismatch"; return 1; }
          [[ -x "$app_path/Contents/MacOS/$EXECUTABLE_NAME" ]] || { log "$context missing executable"; return 1; }
          /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path" >> "$LOG_PATH" 2>&1 || { log "$context codesign verify failed"; return 1; }
          return 0
        }

        verify_target_identity() {
          if [[ -e "$TARGET_APP" ]]; then
            [[ -d "$TARGET_APP" ]] || fail "target exists but is not an app directory"
            [[ "$(plist_value CFBundleIdentifier "$TARGET_APP")" == "$EXPECTED_BUNDLE_ID" ]] || fail "existing target bundle id mismatch"
          fi
        }

        log "installer started"
        log "source=$SOURCE_APP"
        log "target=$TARGET_APP"

        verify_app_or_fail "$SOURCE_APP" "source app"

        for _ in {1..60}; do
          if ! /usr/bin/pgrep -x "$RUNNING_NAME" >/dev/null 2>&1; then
            break
          fi
          /bin/sleep 1
        done

        if /usr/bin/pgrep -x "$RUNNING_NAME" >/dev/null 2>&1; then
          fail "current app is still running"
        fi

        [[ -d "$TARGET_PARENT" ]] || fail "target parent does not exist: $TARGET_PARENT"
        [[ -w "$TARGET_PARENT" ]] || fail "target parent is not writable: $TARGET_PARENT"
        verify_target_identity

        /bin/rm -rf "$BACKUP_APP" >> "$LOG_PATH" 2>&1 || fail "cannot remove old backup"
        if [[ -e "$TARGET_APP" ]]; then
          /bin/mv "$TARGET_APP" "$BACKUP_APP" >> "$LOG_PATH" 2>&1 || fail "cannot move existing app aside"
        fi

        if ! /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP" >> "$LOG_PATH" 2>&1; then
          log "copy failed, trying rollback"
          /bin/rm -rf "$TARGET_APP" >> "$LOG_PATH" 2>&1 || true
          if [[ -e "$BACKUP_APP" ]]; then
            /bin/mv "$BACKUP_APP" "$TARGET_APP" >> "$LOG_PATH" 2>&1 || true
          fi
          fail "ditto copy failed"
        fi

        if ! verify_app "$TARGET_APP" "installed app"; then
          log "verification failed, trying rollback"
          /bin/rm -rf "$TARGET_APP" >> "$LOG_PATH" 2>&1 || true
          if [[ -e "$BACKUP_APP" ]]; then
            /bin/mv "$BACKUP_APP" "$TARGET_APP" >> "$LOG_PATH" 2>&1 || true
          fi
          fail "installed app verification failed"
        fi

        /bin/rm -rf "$BACKUP_APP" >> "$LOG_PATH" 2>&1 || true
        log "installer completed"
        /usr/bin/open "$TARGET_APP" >/dev/null 2>&1 || /usr/bin/open -R "$TARGET_APP" >/dev/null 2>&1 || true
        """

        do {
            try script.data(using: .utf8)?.write(to: scriptURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)
        } catch {
            throw UpdateInstallPreparationError.cannotPrepareInstallerScript(reason: error.localizedDescription)
        }
    }

    private static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
