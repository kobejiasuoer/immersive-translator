import AppKit
import Combine
import SwiftUI

@main
enum ImmersiveTranslatorMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        AppDelegateHolder.delegate = delegate
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

private enum AppDelegateHolder {
    static var delegate: AppDelegate?
}

struct TranslationWaitStatusText {
    let translation: String
    let message: String

    static func formatSeconds(_ seconds: TimeInterval) -> String {
        String(format: "%.1fs", seconds)
    }

    private static func connectedWaitSummary(
        elapsed: TimeInterval,
        connectionElapsed: TimeInterval?
    ) -> (sentence: String, messageSuffix: String) {
        guard let connectionElapsed else {
            let elapsedText = formatSeconds(elapsed)
            return ("当前已等待 \(elapsedText)", elapsedText)
        }

        let connectedWaitElapsed = max(0, elapsed - connectionElapsed)
        let connectedWaitText = formatSeconds(connectedWaitElapsed)
        let elapsedText = formatSeconds(elapsed)
        return (
            "连接后已等待 \(connectedWaitText)，总计已等待 \(elapsedText)",
            "连接后 \(connectedWaitText) / 总计 \(elapsedText)"
        )
    }

    static func preConnection(elapsed: TimeInterval, waitsForFirstToken: Bool) -> TranslationWaitStatusText {
        let elapsedText = formatSeconds(elapsed)
        // 连接前长时间无响应（通常是代理/网络中断，或被服务商限流挂起）：升级为更明确的提示，
        // 让用户知道可以取消重试，而不是一直干等通用文案。
        if elapsed >= 8 {
            return TranslationWaitStatusText(
                translation: waitsForFirstToken
                    ? "请求已发出 \(elapsedText)，仍没有连上翻译服务。这通常是代理/VPN 不稳定、网络中断，或服务商限流把请求挂起。可以点“取消”后重试；若是国内接口，建议在代理软件里把该域名设为直连。"
                    : "请求已发出 \(elapsedText)，仍没有连上翻译服务。这通常是代理/VPN 不稳定、网络中断，或服务商限流把请求挂起。可以点“取消”后重试；若是国内接口，建议在代理软件里把该域名设为直连。",
                message: "连接响应很慢 · 已等待 \(elapsedText)，建议取消重试"
            )
        }
        return TranslationWaitStatusText(
            translation: waitsForFirstToken
                ? "请求已经发出 \(elapsedText)，正在连接翻译服务。若这里停留很久，通常是网络、代理、DNS 或服务商入口较慢。"
                : "请求已经发出 \(elapsedText)，正在连接翻译服务。非流式模式会在接口响应后继续等待完整译文。",
            message: "正在连接翻译服务 · 已等待 \(elapsedText)"
        )
    }

    static func connected(elapsed: TimeInterval, waitsForFirstToken: Bool) -> TranslationWaitStatusText {
        let elapsedText = formatSeconds(elapsed)
        if waitsForFirstToken {
            return TranslationWaitStatusText(
                translation: "接口已经响应，连接耗时 \(elapsedText)。正在等待服务商返回首个片段；如果这里继续变慢，通常是模型排队、代理缓冲或服务商生成慢。",
                message: "已连接接口，等待首字返回 · 连接 \(elapsedText)"
            )
        }

        return TranslationWaitStatusText(
            translation: "接口已经响应，连接耗时 \(elapsedText)。正在等待服务商生成完整译文；非流式模式会在内容完成后一次性显示结果。",
            message: "已连接接口，等待完整译文 · 连接 \(elapsedText)"
        )
    }

    static func streamActiveWithoutVisibleText(
        elapsed: TimeInterval,
        connectionElapsed: TimeInterval? = nil
    ) -> TranslationWaitStatusText {
        let waitSummary = connectedWaitSummary(elapsed: elapsed, connectionElapsed: connectionElapsed)
        return TranslationWaitStatusText(
            translation: "流式连接保持活跃，已经收到服务商或代理的事件，但还没有可见文字，\(waitSummary.sentence)。通常是 SSE 心跳、角色事件、空白片段、代理缓冲，或模型正在准备首个内容片段。",
            message: "流式连接活跃，等待首个可见文字 · \(waitSummary.messageSuffix)"
        )
    }

    static func waitingForVisibleText(
        elapsed: TimeInterval,
        connectionElapsed: TimeInterval? = nil
    ) -> TranslationWaitStatusText {
        let waitSummary = connectedWaitSummary(elapsed: elapsed, connectionElapsed: connectionElapsed)
        return TranslationWaitStatusText(
            translation: "服务商已经开始返回流式事件，但还没有可见文字，\(waitSummary.sentence)。通常是先返回角色信息、空白片段，或代理正在缓冲首个内容片段。",
            message: "已连接接口，等待首个可见文字 · \(waitSummary.messageSuffix)"
        )
    }

    static func postConnectionWait(
        elapsed: TimeInterval,
        waitsForFirstToken: Bool,
        receivedStreamEventsWithoutVisibleText: Bool = false,
        connectionElapsed: TimeInterval? = nil
    ) -> TranslationWaitStatusText {
        let waitSummary = connectedWaitSummary(elapsed: elapsed, connectionElapsed: connectionElapsed)
        if waitsForFirstToken {
            if receivedStreamEventsWithoutVisibleText {
                return TranslationWaitStatusText(
                    translation: "服务商持续返回流式事件，但仍没有可见文字，\(waitSummary.sentence)。通常是角色事件、空白片段、代理缓冲，或模型正在排队生成首个内容片段。",
                    message: "已收到流式事件，等待可见文字 · \(waitSummary.messageSuffix)"
                )
            }
            return TranslationWaitStatusText(
                translation: "接口已经响应，但首个片段还没回来，\(waitSummary.sentence)。通常是模型排队、服务商生成慢、代理缓冲，或当前模型不稳定。",
                message: "服务商已响应，仍在等待首字 · \(waitSummary.messageSuffix)"
            )
        }

        return TranslationWaitStatusText(
            translation: "接口已经响应，但完整译文还没返回，\(waitSummary.sentence)。非流式模式会等服务商生成完才一次性显示，长段落会更明显。",
            message: "服务商已响应，仍在等待完整译文 · \(waitSummary.messageSuffix)"
        )
    }

    static func streamingProgressMessage(
        isFinal: Bool,
        firstVisibleTokenElapsed: TimeInterval?
    ) -> String {
        if isFinal {
            if let firstVisibleTokenElapsed {
                return "译文已经准备好 · 首字 \(formatSeconds(firstVisibleTokenElapsed))"
            }
            return "译文已经准备好"
        }

        guard let firstVisibleTokenElapsed else {
            return "正在流式显示译文"
        }

        if firstVisibleTokenElapsed >= 4 {
            return "正在流式显示译文 · 首字 \(formatSeconds(firstVisibleTokenElapsed))，偏慢"
        }
        return "正在流式显示译文 · 首字 \(formatSeconds(firstVisibleTokenElapsed))"
    }

    static func successMessage(
        unchanged: Bool,
        includesOCRPreflight: Bool,
        translationElapsed: TimeInterval,
        preflightElapsed: TimeInterval,
        connectionElapsed: TimeInterval?,
        firstVisibleTokenElapsed: TimeInterval?,
        usedStreaming: Bool
    ) -> String {
        if unchanged {
            return "译文与原文相同，多半是专有名词、品牌名、代码或模型认为无需翻译。"
        }

        var parts: [String] = []
        if includesOCRPreflight {
            parts.append("OCR \(formatSeconds(preflightElapsed))")
        }
        if let connectionElapsed {
            parts.append("连接 \(formatSeconds(connectionElapsed))")
        }
        if usedStreaming, let firstVisibleTokenElapsed {
            if let connectionElapsed {
                let connectedWaitElapsed = max(0, firstVisibleTokenElapsed - connectionElapsed)
                parts.append(
                    "首字 \(formatSeconds(firstVisibleTokenElapsed)) (连接后 \(formatSeconds(connectedWaitElapsed)))"
                )
            } else {
                parts.append("首字 \(formatSeconds(firstVisibleTokenElapsed))")
            }
        }
        parts.append("翻译 \(formatSeconds(translationElapsed))")

        let slowHint: String
        if let firstVisibleTokenElapsed, firstVisibleTokenElapsed >= 4 {
            if let connectionElapsed {
                let connectedWaitElapsed = max(0, firstVisibleTokenElapsed - connectionElapsed)
                slowHint = "首字等待偏长，连接后仍等了 \(formatSeconds(connectedWaitElapsed))，通常是模型排队或代理缓冲。"
            } else {
                slowHint = "首字等待偏长，通常是模型排队或代理缓冲。"
            }
        } else if let connectionElapsed, connectionElapsed >= 3 {
            slowHint = "连接入口偏慢，建议检查网络、代理或服务商入口。"
        } else if !usedStreaming, translationElapsed >= 6 {
            slowHint = "非流式完整返回较慢，长段落会更明显。"
        } else {
            slowHint = ""
        }

        let summary = parts.joined(separator: " · ")
        return slowHint.isEmpty ? "\(summary)。" : "\(summary)。\(slowHint)"
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let settingsStore = SettingsStore()
    private let historyStore = TranslationHistoryStore()
    private lazy var translator = TranslationClient(settingsStore: settingsStore)
    private lazy var panelController = TranslationPanelController(
        settingsStore: settingsStore,
        historyStore: historyStore,
        onRetry: { [weak self] text in
            self?.startTranslation(text, source: .retry)
        },
        onShowHistory: { [weak self] in
            self?.historyController.show()
        },
        onOpenSettings: { [weak self] in
            self?.settingsController.show()
        },
        onCancelTranslation: { [weak self] in
            self?.cancelCurrentTranslation()
        },
        onOCRConfirm: { [weak self] text in
            Task { @MainActor in
                await self?.confirmOCRPreview(text)
            }
        },
        onOCRReselect: { [weak self] in
            self?.restartScreenSelectionFromPreview()
        }
    )
    private lazy var settingsController = SettingsWindowController(settingsStore: settingsStore)
    private lazy var historyController = TranslationHistoryWindowController(
        historyStore: historyStore,
        onRetranslate: { [weak self] record in
            self?.startTranslation(record.original, source: .retry)
        }
    )
    private lazy var onboardingController = OnboardingWindowController(
        settingsStore: settingsStore,
        onOpenSettings: { [weak self] in
            self?.settingsController.show()
        },
        onStartOCR: { [weak self] in
            self?.startScreenSelection()
        }
    )
    private var hotKeyManager: HotKeyManager?
    private var screenSelector: ScreenSelectionController?
    private var ocrSessionCounter = 0
    private var activeOCRSessionID = 0
    private var translationSessionCounter = 0
    private var activeTranslationSessionID = 0
    private var pendingOCRPreview: PendingOCRPreview?
    private var statusItem: NSStatusItem?
    private var automaticUpdateTask: Task<Void, Never>?
    private var activeTranslationTask: Task<Void, Never>?
    private var activeTranslationRequest: ActiveTranslationRequest?
    private var cancellables: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenuBar()
        hotKeyManager = HotKeyManager { [weak self] action in
            Task { @MainActor in
                switch action {
                case .translateSelection:
                    await self?.translateSelectedText()
                case .translateScreenshot:
                    self?.startScreenSelection()
                }
            }
        }
        registerHotKeys()
        observeSettings()
        showWelcomeIfNeeded()
        scheduleAutomaticUpdateCheck()
    }

    func applicationWillTerminate(_ notification: Notification) {
        automaticUpdateTask?.cancel()
        activeTranslationTask?.cancel()
    }

    private func configureMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "译"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "翻译选中文本  \(settingsStore.selectionHotKeyShortcut.title)", action: #selector(menuTranslateSelection), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "截图 OCR 翻译  \(settingsStore.ocrHotKeyShortcut.title)", action: #selector(menuTranslateScreenshot), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "翻译历史...", action: #selector(openHistory), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "检查更新...", action: #selector(menuCheckForUpdates), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "设置...", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "使用引导", action: #selector(showOnboarding), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "检查权限", action: #selector(checkPermissions), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        item.menu = menu
        statusItem = item
    }

    private func refreshMenu() {
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
        statusItem = nil
        configureMenuBar()
    }

    private func registerHotKeys() {
        guard let report = hotKeyManager?.register(
            selectionShortcut: settingsStore.selectionHotKeyShortcut,
            ocrShortcut: settingsStore.ocrHotKeyShortcut
        ), !report.warnings.isEmpty else {
            settingsStore.hotKeyRegistrationMessage = nil
            return
        }

        settingsStore.hotKeyRegistrationMessage = report.message
        panelController.show(
            original: "快捷键需要调整",
            translation: report.message,
            isLoading: false,
            source: nil,
            status: .warning,
            message: "快捷键注册提示"
        )
    }

    private func observeSettings() {
        settingsStore.$selectionHotKeyShortcut
            .dropFirst()
            .sink { [weak self] _ in
                self?.registerHotKeys()
                self?.refreshMenu()
            }
            .store(in: &cancellables)

        settingsStore.$ocrHotKeyShortcut
            .dropFirst()
            .sink { [weak self] _ in
                self?.registerHotKeys()
                self?.refreshMenu()
            }
            .store(in: &cancellables)
    }

    private func showWelcomeIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: "didShowOnboardingV2") else { return }
        UserDefaults.standard.set(true, forKey: "didShowOnboardingV2")
        onboardingController.show()
    }

    @objc private func menuTranslateSelection() {
        Task { @MainActor in await translateSelectedText() }
    }

    @objc private func menuTranslateScreenshot() {
        startScreenSelection()
    }

    @objc private func openSettings() {
        settingsController.show()
    }

    @objc private func openHistory() {
        historyController.show()
    }

    @objc private func menuCheckForUpdates() {
        Task { @MainActor in
            await checkForUpdates()
        }
    }

    @objc private func showOnboarding() {
        onboardingController.show()
    }

    @objc private func checkPermissions() {
        let accessibilityGranted = PermissionPrompter.requestAccessibilityIfNeeded()
        let screenCaptureGranted = PermissionPrompter.requestScreenCaptureIfNeeded()
        let status = permissionStatusDescription(
            accessibilityGranted: accessibilityGranted,
            screenCaptureGranted: screenCaptureGranted
        )
        panelController.show(
            original: "权限检查",
            translation: """
            如果系统弹出授权，请允许：
            - 辅助功能：用于读取当前选中的文字。
            - 屏幕录制：用于截图 OCR。

            当前状态：
            \(status)

            授权后如果热键没反应，重启一次这个工具即可。
            """,
            isLoading: false,
            source: nil,
            status: accessibilityGranted && screenCaptureGranted ? .success : .warning,
            message: accessibilityGranted && screenCaptureGranted ? "权限看起来都已允许" : "还有权限需要确认",
            allowsRetry: false,
            allowsFavorite: false,
            isTranslationOutput: false,
            allowsOpenSettings: true,
            openSettingsTitle: "打开权限设置",
            openSettingsAction: { [weak self] in
                self?.showPermissionSettingsChooser()
            }
        )
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }

    @MainActor
    private func checkForUpdates() async {
        panelController.show(
            original: "检查更新",
            translation: "正在读取更新清单。正式发布包会从构建时配置的更新源检查最新版本。",
            isLoading: true,
            source: nil,
            status: .loading,
            message: "正在检查更新"
        )

        do {
            let result = try await UpdateChecker.check()
            if result.hasUpdate {
                if result.isSystemCompatible {
                    showUpdateAvailable(result, isAutomatic: false)
                } else {
                    showUpdateUnavailable(result)
                }
            } else {
                panelController.show(
                    original: "检查更新",
                    translation: "当前已经是最新版本：\(result.currentDisplayVersion)。",
                    isLoading: false,
                    source: nil,
                    status: .success,
                    message: "已经是最新版本"
                )
            }
        } catch {
            panelController.show(
                original: "检查更新失败",
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: nil,
                status: .warning,
                message: "没有完成更新检查"
            )
        }
    }

    @MainActor
    private func scheduleAutomaticUpdateCheck() {
        automaticUpdateTask?.cancel()
        guard UpdateChecker.hasConfiguredUpdateSource else { return }

        let defaults = UserDefaults.standard
        if let lastCheck = defaults.object(forKey: UpdateDefaults.lastAutomaticCheckAt) as? Date,
           Date().timeIntervalSince(lastCheck) < UpdateDefaults.minimumAutomaticCheckInterval {
            return
        }

        automaticUpdateTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }

            await MainActor.run {
                UserDefaults.standard.set(Date(), forKey: UpdateDefaults.lastAutomaticCheckAt)
            }

            do {
                let result = try await UpdateChecker.check()
                await MainActor.run {
                    guard let self else { return }
                    guard result.hasUpdate,
                          result.isSystemCompatible,
                          self.shouldPromptAutomatically(for: result) else {
                        return
                    }
                    self.showUpdateAvailable(result, isAutomatic: true)
                }
            } catch {
                DiagnosticLogger.log("update.automatic_check.failed error=\(error.localizedDescription)")
            }
        }
    }

    private func shouldPromptAutomatically(for result: UpdateCheckResult) -> Bool {
        let identifier = "\(result.manifest.version)#\(result.manifest.build)"
        return UserDefaults.standard.string(forKey: UpdateDefaults.lastPromptedVersion) != identifier
    }

    private func recordUpdatePrompt(for result: UpdateCheckResult) {
        let identifier = "\(result.manifest.version)#\(result.manifest.build)"
        UserDefaults.standard.set(identifier, forKey: UpdateDefaults.lastPromptedVersion)
    }

    @MainActor
    private func showUpdateUnavailable(_ result: UpdateCheckResult) {
        panelController.show(
            original: "发现新版本 \(result.latestDisplayVersion)",
            translation: """
            找到了新版本，但它要求 macOS \(result.minimumSystemDisplayVersion) 或更高版本。

            当前系统：macOS \(result.currentSystemVersion)
            当前 App：\(result.currentDisplayVersion)

            我不会建议下载这个更新包，避免安装后无法运行。
            """,
            isLoading: false,
            source: nil,
            status: .warning,
            message: "新版本暂不兼容当前系统"
        )
    }

    @MainActor
    private func showUpdateAvailable(_ result: UpdateCheckResult, isAutomatic: Bool) {
        recordUpdatePrompt(for: result)
        let releaseNotesLine = result.releaseNotesURL.map { "\n\n发布说明：\n\($0.absoluteString)" } ?? ""
        panelController.show(
            original: "发现新版本 \(result.latestDisplayVersion)",
            translation: """
            当前版本：\(result.currentDisplayVersion)
            最低系统：macOS \(result.minimumSystemDisplayVersion)
            文件大小：\(manifestPackageSizeDescription(result.manifest.sizeBytes))
            下载地址：\(result.downloadURL.absoluteString)

            SHA256：
            \(result.manifest.sha256)\(releaseNotesLine)
            """,
            isLoading: false,
            source: nil,
            status: .warning,
            message: isAutomatic ? "自动检查发现新版本" : "发现可下载的新版本"
        )

        guard !isAutomatic else { return }

        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "发现新版本 \(result.latestDisplayVersion)"
        alert.informativeText = "当前版本：\(result.currentDisplayVersion)\n文件大小：\(manifestPackageSizeDescription(result.manifest.sizeBytes))\n\n可以直接下载到 Downloads，并自动核对 update-manifest.json 里的文件大小、sha256 和 zip 内 App 信息；校验通过后会协助替换安装。"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "下载并校验")
        alert.addButton(withTitle: "打开下载页")
        if result.releaseNotesURL != nil {
            alert.addButton(withTitle: "查看说明")
        }
        alert.addButton(withTitle: "稍后")

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            Task { @MainActor in
                await downloadUpdatePackage(result)
            }
        } else if response == .alertSecondButtonReturn {
            NSWorkspace.shared.open(result.downloadURL)
        } else if response == .alertThirdButtonReturn, let releaseNotesURL = result.releaseNotesURL {
            NSWorkspace.shared.open(releaseNotesURL)
        }
    }

    @MainActor
    private func downloadUpdatePackage(_ result: UpdateCheckResult) async {
        panelController.show(
            original: "下载更新 \(result.latestDisplayVersion)",
            translation: "正在下载更新包，并会自动核对 manifest 里的文件大小和 sha256。下载完成前请不要安装其它来源的文件。",
            isLoading: true,
            source: nil,
            status: .loading,
            message: "正在下载并校验更新包"
        )

        do {
            let download = try await UpdateChecker.downloadPackage(for: result)
            panelController.show(
                original: "更新包已下载",
                translation: updateDownloadCompletionMessage(download, result: result),
                isLoading: false,
                source: nil,
                status: .success,
                message: "下载完成，校验通过"
            )
            showDownloadedUpdateInstallOptions(download, result: result)
        } catch {
            panelController.show(
                original: "更新包下载失败",
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: nil,
                status: .error,
                message: "更新包没有通过下载或校验"
            )
        }
    }

    @MainActor
    private func showDownloadedUpdateInstallOptions(_ download: UpdateDownloadResult, result: UpdateCheckResult) {
        NSApplication.shared.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "更新包已下载并校验"
        alert.informativeText = updateInstallGuideMessage(download, result: result)
        alert.alertStyle = .informational
        alert.addButton(withTitle: "替换安装并退出")
        alert.addButton(withTitle: "在 Finder 中显示")
        alert.addButton(withTitle: "打开 Applications")
        alert.addButton(withTitle: "稍后")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            prepareAndConfirmUpdateInstallation(download, result: result)
        case .alertSecondButtonReturn:
            NSWorkspace.shared.activateFileViewerSelecting([download.fileURL])
        case .alertThirdButtonReturn:
            NSWorkspace.shared.open(applicationsFolderURL())
        default:
            break
        }
    }

    @MainActor
    private func prepareAndConfirmUpdateInstallation(_ download: UpdateDownloadResult, result: UpdateCheckResult) {
        do {
            let preparedInstallation = try UpdateChecker.prepareInstallation(for: download, result: result)
            panelController.show(
                original: "更新已准备安装",
                translation: preparedUpdateInstallationMessage(preparedInstallation, download: download, result: result),
                isLoading: false,
                source: nil,
                status: .success,
                message: "替换安装已准备好"
            )
            confirmAndStartPreparedInstallation(preparedInstallation, download: download, result: result)
        } catch {
            panelController.show(
                original: "更新安装准备失败",
                translation: "\(ErrorMessageFormatter.message(for: error))\n\n已保留通过校验的 zip，你仍可以在 Finder 中显示它，手动解压后拖入 Applications 替换。",
                isLoading: false,
                source: nil,
                status: .error,
                message: "无法准备替换安装"
            )
            showManualUpdateFallback(download, result: result)
        }
    }

    @MainActor
    private func confirmAndStartPreparedInstallation(
        _ preparedInstallation: PreparedUpdateInstallation,
        download: UpdateDownloadResult,
        result: UpdateCheckResult
    ) {
        let alert = NSAlert()
        alert.messageText = "准备替换安装 \(result.latestDisplayVersion)"
        alert.informativeText = preparedUpdateInstallationConfirmationMessage(
            preparedInstallation,
            download: download,
            result: result
        )
        alert.alertStyle = .informational
        alert.addButton(withTitle: "退出并替换安装")
        alert.addButton(withTitle: "显示已解压 App")
        alert.addButton(withTitle: "稍后")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            do {
                try UpdateChecker.startPreparedInstallation(preparedInstallation)
                NSApplication.shared.terminate(nil)
            } catch {
                panelController.show(
                    original: "更新安装启动失败",
                    translation: "\(ErrorMessageFormatter.message(for: error))\n\n已解压的新版本 App：\n\(preparedInstallation.stagedAppURL.path)",
                    isLoading: false,
                    source: nil,
                    status: .error,
                    message: "无法启动替换安装"
                )
                NSWorkspace.shared.activateFileViewerSelecting([preparedInstallation.stagedAppURL])
            }
        case .alertSecondButtonReturn:
            NSWorkspace.shared.activateFileViewerSelecting([preparedInstallation.stagedAppURL])
        default:
            break
        }
    }

    @MainActor
    private func showManualUpdateFallback(_ download: UpdateDownloadResult, result: UpdateCheckResult) {
        let alert = NSAlert()
        alert.messageText = "改用手动安装"
        alert.informativeText = """
        已校验的 zip 仍在：
        \(download.fileURL.path)

        你可以打开 Finder，手动解压这个 zip，再把其中的 App 拖入 Applications 替换旧版本。
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "在 Finder 中显示")
        alert.addButton(withTitle: "打开 Applications")
        alert.addButton(withTitle: "稍后")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            NSWorkspace.shared.activateFileViewerSelecting([download.fileURL])
        case .alertSecondButtonReturn:
            NSWorkspace.shared.open(applicationsFolderURL())
        default:
            break
        }
    }

    private func updateDownloadCompletionMessage(_ download: UpdateDownloadResult, result: UpdateCheckResult) -> String {
        let publishedAtLine = result.manifest.publishedAt.map { "\n发布时间：\($0)" } ?? ""
        let releaseNotesLine = result.releaseNotesURL.map { "\n发布说明：\($0.absoluteString)" } ?? ""
        return """
        已保存到：
        \(download.fileURL.path)

        版本：\(download.packageVerification.displayName)
        文件大小：\(Self.formatBytes(download.byteCount))
        manifest 大小：\(manifestPackageSizeDescription(result.manifest.sizeBytes))
        来源清单：\(result.manifestURL.absoluteString)
        下载地址：\(result.downloadURL.absoluteString)\(publishedAtLine)\(releaseNotesLine)

        已完成安全检查：
        \(updateVerificationChecklist(download, result: result))

        下一步可以由 App 准备临时解压目录，并在你确认后退出当前版本、替换当前 .app；如果系统权限不允许，会保留这个已校验 zip 供手动安装。
        """
    }

    private func updateInstallGuideMessage(_ download: UpdateDownloadResult, result: UpdateCheckResult) -> String {
        let verification = download.packageVerification
        return """
        版本：\(result.latestDisplayVersion)
        文件：\(download.fileURL.lastPathComponent)
        位置：\(download.fileURL.deletingLastPathComponent().path)
        zip 内 App：\(verification.appRelativePath)
        Bundle ID：\(verification.bundleIdentifier)
        代码签名：\(verification.codeSignatureSummary)

        下一步：
        1. 我会重新校验这个 zip，并解压到系统临时目录。
        2. 你确认后，App 会启动替换脚本并退出当前版本。
        3. 替换脚本会把新 App 复制到当前 App 所在位置，复制后再次核对 Bundle ID、版本、构建号、可执行文件和代码签名。
        4. 成功后会自动重新打开新版本；失败时会保留已校验的新 App 并在 Finder 中显示。

        这一步之前已核对文件大小、sha256、Bundle ID、版本号、构建号、可执行文件和代码签名结构；任何一项失败都不会给出安装指引。
        """
    }

    private func preparedUpdateInstallationMessage(
        _ preparedInstallation: PreparedUpdateInstallation,
        download: UpdateDownloadResult,
        result: UpdateCheckResult
    ) -> String {
        """
        已校验并解压新版本：
        \(preparedInstallation.stagedAppURL.path)

        将替换当前 App：
        \(preparedInstallation.targetAppURL.path)

        版本：\(preparedInstallation.packageVerification.displayName)
        来源 zip：\(download.fileURL.path)
        来源清单：\(result.manifestURL.absoluteString)
        安装日志：\(preparedInstallation.logURL.path)

        替换脚本会在当前 App 退出后执行；复制完成后仍会再次检查 Bundle ID、版本、构建号、可执行文件和代码签名。
        """
    }

    private func preparedUpdateInstallationConfirmationMessage(
        _ preparedInstallation: PreparedUpdateInstallation,
        download: UpdateDownloadResult,
        result: UpdateCheckResult
    ) -> String {
        """
        当前 App：
        \(preparedInstallation.targetAppURL.path)

        新版本 App：
        \(preparedInstallation.stagedAppURL.path)

        来源 zip：
        \(download.fileURL.path)

        版本：\(result.latestDisplayVersion)
        Bundle ID：\(preparedInstallation.packageVerification.bundleIdentifier)
        代码签名：\(preparedInstallation.packageVerification.codeSignatureSummary)

        点击“退出并替换安装”后，当前版本会退出。替换脚本只会把这个已校验的新 App 复制到当前 App 所在位置，不会跳过签名、Bundle ID、版本、构建号或 sha256 检查。
        """
    }

    private func updateVerificationChecklist(_ download: UpdateDownloadResult, result: UpdateCheckResult) -> String {
        let verification = download.packageVerification
        return """
        - 文件大小与 manifest 一致：\(packageSizeCheckDescription(download, result: result))
        - sha256 与 manifest 完全一致：\(download.sha256)
        - zip 可解包，并找到 App：\(verification.appRelativePath)
        - Bundle ID 与当前 App 一致：\(verification.bundleIdentifier)
        - 版本/构建号与 manifest 一致：\(verification.version) (\(verification.build))
        - 可执行文件存在：\(verification.executableName)
        - 代码签名结构可验证：\(verification.codeSignatureSummary)
        - 当前 macOS \(result.currentSystemVersion) 满足最低要求：\(result.minimumSystemDisplayVersion)
        """
    }

    private func manifestPackageSizeDescription(_ sizeBytes: Int64?) -> String {
        guard let sizeBytes else {
            return "旧版 manifest 未声明 size_bytes"
        }
        return "\(Self.formatBytes(sizeBytes)) (\(sizeBytes) bytes)"
    }

    private func packageSizeCheckDescription(_ download: UpdateDownloadResult, result: UpdateCheckResult) -> String {
        guard let expectedByteCount = result.manifest.sizeBytes else {
            return "\(Self.formatBytes(download.byteCount))；旧版 manifest 未声明 size_bytes，已记录实际下载大小"
        }
        return "实际 \(Self.formatBytes(download.byteCount))，manifest \(Self.formatBytes(expectedByteCount)) (\(expectedByteCount) bytes)"
    }

    private func applicationsFolderURL() -> URL {
        FileManager.default.urls(for: .applicationDirectory, in: .localDomainMask).first
            ?? URL(fileURLWithPath: "/Applications", isDirectory: true)
    }

    @MainActor
    private func showPermissionSettingsChooser() {
        NSApplication.shared.activate(ignoringOtherApps: true)

        let accessibilityGranted = PermissionPrompter.isAccessibilityTrusted()
        let screenCaptureGranted = PermissionPrompter.isScreenCaptureTrusted()
        let alert = NSAlert()
        alert.messageText = "打开哪个权限设置？"
        alert.informativeText = """
        辅助功能：\(accessibilityGranted ? "已允许" : "需要允许")
        屏幕录制：\(screenCaptureGranted ? "已允许" : "需要允许")
        """
        alert.alertStyle = accessibilityGranted && screenCaptureGranted ? .informational : .warning
        alert.addButton(withTitle: "辅助功能设置")
        alert.addButton(withTitle: "屏幕录制设置")
        alert.addButton(withTitle: "取消")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            PermissionPrompter.openPrivacyPane(kind: .accessibility)
        case .alertSecondButtonReturn:
            PermissionPrompter.openPrivacyPane(kind: .screenRecording)
        default:
            break
        }
    }

    private func permissionStatusDescription(accessibilityGranted: Bool, screenCaptureGranted: Bool) -> String {
        [
            "辅助功能：\(accessibilityGranted ? "已允许" : "需要在系统设置里允许")",
            "屏幕录制：\(screenCaptureGranted ? "已允许" : "需要在系统设置里允许")"
        ].joined(separator: "\n")
    }

    @MainActor
    private func translateSelectedText() async {
        guard ensureConfigured() else { return }
        guard PermissionPrompter.requestAccessibilityIfNeeded() else {
            panelController.show(
                original: "需要辅助功能权限",
                translation: ErrorMessageFormatter.message(for: SelectedTextReaderError.accessibilityNotTrusted),
                isLoading: false,
                source: .selection,
                status: .warning,
                message: "无法读取当前选中文本",
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: true,
                openSettingsTitle: "打开辅助功能设置",
                openSettingsAction: {
                    PermissionPrompter.openPrivacyPane(kind: .accessibility)
                }
            )
            return
        }

        let startedAt = Date()
        panelController.show(
            original: "正在读取选中文本...",
            translation: "我会临时触发 Command + C，读取后立刻恢复你的剪贴板。",
            isLoading: true,
            source: .selection,
            status: .loading,
            message: "正在读取当前选区"
        )

        do {
            let text = try await SelectedTextReader.readSelectedText()
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                panelController.show(
                    original: "没有读取到选中文本",
                    translation: "请先在当前 App 或网页里选中一段文字，再按 Option + Space。",
                    isLoading: false,
                    source: .selection,
                    status: .warning,
                    message: "当前没有可翻译的选区",
                    elapsed: Date().timeIntervalSince(startedAt)
                )
                return
            }

            startTranslation(text, source: .selection)
        } catch {
            panelController.show(
                original: "翻译失败",
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: .selection,
                status: .error,
                message: "读取选中文本失败",
                elapsed: Date().timeIntervalSince(startedAt),
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: error is SelectedTextReaderError,
                openSettingsTitle: "打开辅助功能设置",
                openSettingsAction: {
                    PermissionPrompter.openPrivacyPane(kind: .accessibility)
                }
            )
        }
    }

    @MainActor
    private func startScreenSelection() {
        guard PermissionPrompter.requestScreenCaptureIfNeeded() else {
            panelController.show(
                original: "需要屏幕录制权限",
                translation: "请在系统设置里允许本工具进行屏幕录制，然后重新尝试截图 OCR。",
                isLoading: false,
                source: .screenshotOCR,
                status: .warning,
                message: "截图 OCR 需要屏幕录制权限",
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: true,
                openSettingsTitle: "打开屏幕录制设置",
                openSettingsAction: {
                    PermissionPrompter.openPrivacyPane(kind: .screenRecording)
                }
            )
            return
        }

        let sessionID = beginOCRSession()
        pendingOCRPreview = nil
        panelController.dismiss()
        screenSelector = ScreenSelectionController { [weak self] image in
            Task { @MainActor in
                guard let self, self.isCurrentOCRSession(sessionID) else { return }
                self.screenSelector = nil
                await self.recognizeImageForPreview(image, sessionID: sessionID)
            }
        } onCancel: { [weak self] reason in
            guard let self, self.isCurrentOCRSession(sessionID) else { return }
            self.pendingOCRPreview = nil
            self.showScreenSelectionCancel(reason)
            self.screenSelector = nil
        }
        screenSelector?.begin()
    }

    @MainActor
    private func recognizeImageForPreview(_ image: CGImage, sessionID: Int) async {
        let startedAt = Date()
        let pixelSize = "\(image.width) x \(image.height) px"
        let configuredMode = settingsStore.ocrMode
        let configuredPreset = settingsStore.ocrLanguagePreset
        let effectiveRecognitionMode = OCRReader.effectiveMode(configuredMode, preset: configuredPreset)
        panelController.show(
            original: "截图区域：\(pixelSize)",
            translation: "正在用本机 Vision 识别文字。截图不会发送给翻译接口。",
            isLoading: true,
            source: .screenshotOCR,
            status: .loading,
            message: "OCR：\(effectiveRecognitionMode.title) · \(configuredPreset.title)"
        )
        do {
            let outcome = try await OCRReader.recognizeText(
                in: image,
                mode: configuredMode,
                languagePreset: configuredPreset
            )
            let elapsed = Date().timeIntervalSince(startedAt)
            guard isCurrentOCRSession(sessionID) else { return }

            DiagnosticLogger.log("ocr.recognition.complete session=\(sessionID) configuredMode=\(configuredMode.rawValue) configuredLanguages=\(configuredPreset.rawValue) usedMode=\(outcome.usedMode.rawValue) usedLanguages=\(outcome.usedPreset.rawValue) modeDowngraded=\(outcome.modeDowngraded) usedFallbackPreset=\(outcome.usedFallbackPreset) image=\(pixelSize) textLength=\(outcome.text.count)")
            pendingOCRPreview = PendingOCRPreview(sessionID: sessionID, preflightElapsed: elapsed)
            panelController.showOCRPreview(
                original: outcome.text,
                imageDescription: pixelSize,
                elapsed: elapsed,
                sessionID: sessionID,
                outcome: outcome
            )
        } catch {
            guard isCurrentOCRSession(sessionID) else { return }
            pendingOCRPreview = nil
            panelController.show(
                original: "OCR 或翻译失败",
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: .screenshotOCR,
                status: .error,
                message: "OCR 没有完成",
                elapsed: Date().timeIntervalSince(startedAt)
            )
        }
    }

    @MainActor
    private func confirmOCRPreview(_ text: String) async {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else { return }
        guard let preview = pendingOCRPreview, isCurrentOCRSession(preview.sessionID) else {
            panelController.show(
                original: "OCR 预览已过期",
                translation: "这次识别状态已经被新的框选替换。请重新框选后再确认翻译。",
                isLoading: false,
                source: .screenshotOCR,
                status: .warning,
                message: "请重新框选"
            )
            return
        }
        guard ensureConfigured() else { return }

        pendingOCRPreview = nil
        startTranslation(trimmedText, source: .screenshotOCR, preflightElapsed: preview.preflightElapsed)
    }

    @MainActor
    private func restartScreenSelectionFromPreview() {
        pendingOCRPreview = nil
        startScreenSelection()
    }

    @MainActor
    private func startTranslation(_ text: String, source: TranslationSource, preflightElapsed: TimeInterval = 0) {
        activeTranslationTask?.cancel()
        invalidateTranslationSession()
        activeTranslationRequest = ActiveTranslationRequest(
            text: text,
            source: source,
            preflightElapsed: preflightElapsed,
            targetLanguage: resolvedTargetLanguage(for: text)
        )
        activeTranslationTask = Task { @MainActor [weak self] in
            await self?.translateText(text, source: source, preflightElapsed: preflightElapsed)
        }
    }

    @MainActor
    private func cancelCurrentTranslation() {
        let request = activeTranslationRequest
        let partialTranslation = request?.partialTranslation.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hasPartialTranslation = !partialTranslation.isEmpty
        activeTranslationTask?.cancel()
        activeTranslationTask = nil
        activeTranslationRequest = nil
        invalidateTranslationSession()
        panelController.show(
            original: request?.text ?? "翻译已取消",
            translation: hasPartialTranslation
                ? partialTranslation
                : "已停止当前翻译请求。原文已保留，你可以直接重新翻译；如果是 OCR 文本，也不用重新框选。",
            isLoading: false,
            source: request?.source,
            status: .warning,
            message: hasPartialTranslation ? "已取消，保留已生成片段" : "已取消当前翻译",
            targetLanguage: request?.targetLanguage,
            allowsRetry: request?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
            allowsFavorite: false,
            isTranslationOutput: hasPartialTranslation,
            reposition: false
        )
        DiagnosticLogger.log("translation.request.cancelled_by_user")
    }

    @MainActor
    private func translateText(_ text: String, source: TranslationSource, preflightElapsed: TimeInterval = 0) async {
        let sessionID = beginTranslationSession()
        let startedAt = Date()
        let expectedTargetLanguage = resolvedTargetLanguage(for: text)
        panelController.show(
            original: text,
            translation: "正在翻译到 \(expectedTargetLanguage)，使用 \(settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines))。",
            isLoading: true,
            source: source,
            status: .loading,
            message: source == .screenshotOCR ? "OCR 文本已拿到，正在翻译" : "正在翻译选中文本",
            elapsed: preflightElapsed > 0 ? preflightElapsed : nil,
            targetLanguage: expectedTargetLanguage,
            allowsCancel: true
        )

        var preConnectionWaitStatusTask: Task<Void, Never>?
        var postConnectionWaitStatusTask: Task<Void, Never>?
        var connectionElapsed: TimeInterval?
        var firstVisibleTokenElapsed: TimeInterval?
        var hasInvisibleStreamEvent = false
        defer {
            preConnectionWaitStatusTask?.cancel()
            postConnectionWaitStatusTask?.cancel()
            if isCurrentTranslationSession(sessionID) {
                activeTranslationTask = nil
            }
        }

        do {
            let result: TranslationResult
            if settingsStore.enableStreamingTranslation {
                preConnectionWaitStatusTask = makePreConnectionWaitStatusTask(
                    sessionID: sessionID,
                    text: text,
                    source: source,
                    startedAt: startedAt,
                    preflightElapsed: preflightElapsed,
                    targetLanguage: expectedTargetLanguage,
                    waitsForFirstToken: true
                )
                result = try await translator.translateStreaming(text: text) { [weak self] progress in
                    guard let self else { return }
                    guard self.isCurrentTranslationSession(sessionID) else { return }
                    let hasVisibleText = !progress.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    if progress.phase == .connected {
                        connectionElapsed = progress.elapsed
                        preConnectionWaitStatusTask?.cancel()
                        preConnectionWaitStatusTask = nil
                    }
                    if hasVisibleText {
                        if firstVisibleTokenElapsed == nil {
                            firstVisibleTokenElapsed = progress.elapsed
                        }
                        activeTranslationRequest?.partialTranslation = progress.text
                        postConnectionWaitStatusTask?.cancel()
                        postConnectionWaitStatusTask = nil
                    }
                    if progress.phase == .connected {
                        postConnectionWaitStatusTask?.cancel()
                        postConnectionWaitStatusTask = self.makePostConnectionWaitStatusTask(
                            sessionID: sessionID,
                            text: text,
                            source: source,
                            startedAt: startedAt,
                            preflightElapsed: preflightElapsed,
                            targetLanguage: expectedTargetLanguage,
                            waitsForFirstToken: true,
                            connectionElapsed: progress.elapsed
                        )
                        let waitText = TranslationWaitStatusText.connected(
                            elapsed: progress.elapsed,
                            waitsForFirstToken: true
                        )
                        self.panelController.show(
                            original: text,
                            translation: waitText.translation,
                            isLoading: true,
                            source: source,
                            status: .loading,
                            message: waitText.message,
                            elapsed: progress.elapsed + preflightElapsed,
                            targetLanguage: expectedTargetLanguage,
                            allowsCancel: true,
                            reposition: false
                        )
                        return
                    }
                    if progress.phase == .streamActiveNoVisibleText {
                        if !hasInvisibleStreamEvent {
                            hasInvisibleStreamEvent = true
                            postConnectionWaitStatusTask?.cancel()
                            postConnectionWaitStatusTask = self.makePostConnectionWaitStatusTask(
                                sessionID: sessionID,
                                text: text,
                                source: source,
                                startedAt: startedAt,
                                preflightElapsed: preflightElapsed,
                                targetLanguage: expectedTargetLanguage,
                                waitsForFirstToken: true,
                                receivedStreamEventsWithoutVisibleText: true,
                                connectionElapsed: connectionElapsed
                            )
                        }
                        let waitText = TranslationWaitStatusText.streamActiveWithoutVisibleText(
                            elapsed: progress.elapsed,
                            connectionElapsed: connectionElapsed
                        )
                        self.panelController.show(
                            original: text,
                            translation: waitText.translation,
                            isLoading: true,
                            source: source,
                            status: .loading,
                            message: waitText.message,
                            elapsed: progress.elapsed + preflightElapsed,
                            targetLanguage: expectedTargetLanguage,
                            allowsCancel: true,
                            reposition: false
                        )
                        return
                    }
                    if progress.phase == .waitingForVisibleText {
                        if !hasInvisibleStreamEvent {
                            hasInvisibleStreamEvent = true
                            postConnectionWaitStatusTask?.cancel()
                            postConnectionWaitStatusTask = self.makePostConnectionWaitStatusTask(
                                sessionID: sessionID,
                                text: text,
                                source: source,
                                startedAt: startedAt,
                                preflightElapsed: preflightElapsed,
                                targetLanguage: expectedTargetLanguage,
                                waitsForFirstToken: true,
                                receivedStreamEventsWithoutVisibleText: true,
                                connectionElapsed: connectionElapsed
                            )
                        }
                        let waitText = TranslationWaitStatusText.waitingForVisibleText(
                            elapsed: progress.elapsed,
                            connectionElapsed: connectionElapsed
                        )
                        self.panelController.show(
                            original: text,
                            translation: waitText.translation,
                            isLoading: true,
                            source: source,
                            status: .loading,
                            message: waitText.message,
                            elapsed: progress.elapsed + preflightElapsed,
                            targetLanguage: expectedTargetLanguage,
                            allowsCancel: true,
                            reposition: false
                        )
                        return
                    }
                    let streamMessage = self.streamingProgressMessage(
                        progress: progress,
                        firstVisibleTokenElapsed: firstVisibleTokenElapsed
                    )
                    self.panelController.show(
                        original: text,
                        translation: progress.text,
                        isLoading: !progress.isFinal,
                        source: source,
                        status: progress.isFinal ? .success : .loading,
                        message: streamMessage,
                        elapsed: progress.elapsed + preflightElapsed,
                        targetLanguage: expectedTargetLanguage,
                        allowsCancel: !progress.isFinal,
                        reposition: false
                    )
                }
                preConnectionWaitStatusTask?.cancel()
                postConnectionWaitStatusTask?.cancel()
            } else {
                preConnectionWaitStatusTask = makePreConnectionWaitStatusTask(
                    sessionID: sessionID,
                    text: text,
                    source: source,
                    startedAt: startedAt,
                    preflightElapsed: preflightElapsed,
                    targetLanguage: expectedTargetLanguage,
                    waitsForFirstToken: false
                )
                result = try await translator.translateWithMetadata(text: text) { [weak self] progress in
                    guard let self, progress.phase == .connected else { return }
                    guard self.isCurrentTranslationSession(sessionID) else { return }
                    connectionElapsed = progress.elapsed
                    preConnectionWaitStatusTask?.cancel()
                    preConnectionWaitStatusTask = nil
                    postConnectionWaitStatusTask?.cancel()
                    postConnectionWaitStatusTask = self.makePostConnectionWaitStatusTask(
                        sessionID: sessionID,
                        text: text,
                        source: source,
                        startedAt: startedAt,
                        preflightElapsed: preflightElapsed,
                        targetLanguage: expectedTargetLanguage,
                        waitsForFirstToken: false,
                        connectionElapsed: progress.elapsed
                    )
                    let waitText = TranslationWaitStatusText.connected(
                        elapsed: progress.elapsed,
                        waitsForFirstToken: false
                    )
                    self.panelController.show(
                        original: text,
                        translation: waitText.translation,
                        isLoading: true,
                        source: source,
                        status: .loading,
                        message: waitText.message,
                        elapsed: progress.elapsed + preflightElapsed,
                        targetLanguage: expectedTargetLanguage,
                        allowsCancel: true,
                        reposition: false
                    )
                }
                preConnectionWaitStatusTask?.cancel()
                postConnectionWaitStatusTask?.cancel()
            }
            guard isCurrentTranslationSession(sessionID) else { return }
            activeTranslationRequest = nil
            let translation = result.text
            let totalElapsed = result.elapsed + preflightElapsed
            historyStore.add(
                original: text,
                translation: translation,
                targetLanguage: result.targetLanguage,
                source: source
            )
            let unchanged = normalized(text) == normalized(translation)
            let message = successMessage(
                unchanged: unchanged,
                source: source,
                translationElapsed: result.elapsed,
                preflightElapsed: preflightElapsed,
                connectionElapsed: connectionElapsed,
                firstVisibleTokenElapsed: firstVisibleTokenElapsed,
                usedStreaming: settingsStore.enableStreamingTranslation
            )
            panelController.show(
                original: text,
                translation: translation,
                isLoading: false,
                source: source,
                status: unchanged ? .unchanged : .success,
                message: message,
                elapsed: totalElapsed,
                targetLanguage: result.targetLanguage,
                reposition: false
            )
        } catch {
            guard isCurrentTranslationSession(sessionID) else { return }
            activeTranslationRequest = nil
            let recovery = TranslationErrorRecovery.make(for: error)
            panelController.show(
                original: text,
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: source,
                status: .error,
                message: recovery.statusMessage,
                elapsed: Date().timeIntervalSince(startedAt) + preflightElapsed,
                targetLanguage: expectedTargetLanguage,
                allowsRetry: recovery.allowsRetry,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: recovery.settingsTitle != nil,
                openSettingsTitle: recovery.settingsTitle ?? "打开设置",
                openSettingsAction: { [weak self] in
                    self?.openSettingsAndRunProviderDiagnostic()
                },
                reposition: false
            )
        }
    }

    @MainActor
    private func openSettingsAndRunProviderDiagnostic() {
        settingsController.show()
        settingsStore.providerDiagnosticRequestID = UUID()
    }

    @MainActor
    private func ensureConfigured() -> Bool {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty else {
            settingsController.show()
            panelController.show(
                original: "还没有配置接口地址",
                translation: "我已经打开设置窗口。请选择一个 Provider 预设，或填写完整的 Chat Completions 接口地址。",
                isLoading: false,
                status: .warning,
                message: "需要先配置翻译接口",
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: true
            )
            return false
        }

        guard let url = TranslationClient.chatCompletionsURL(from: endpoint) else {
            settingsController.show()
            panelController.show(
                original: "接口地址无效",
                translation: "我已经打开设置窗口。请检查接口地址是否包含 https:// 或本地 http://，并确认没有多余空格或中文标点。",
                isLoading: false,
                status: .warning,
                message: "接口地址需要修正",
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: true
            )
            return false
        }

        if TranslationClient.requiresAPIKey(for: url),
           ((KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "")).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            settingsController.show()
            panelController.show(
                original: "还没有配置 API Key",
                translation: "当前是云接口，需要填写对应服务商的 API Key 后才能翻译。我已经打开设置窗口；如果只是想先试用，也可以在设置里自己填一个 OpenAI 兼容的接口地址和 Key（本地服务如 Ollama 也可填 http://localhost:11434/v1/chat/completions 直接试）。",
                isLoading: false,
                status: .warning,
                message: "需要先配置翻译接口",
                allowsRetry: false,
                allowsFavorite: false,
                isTranslationOutput: false,
                allowsOpenSettings: true
            )
            return false
        }
        return true
    }

    @MainActor
    private func showScreenSelectionCancel(_ reason: ScreenSelectionCancelReason) {
        let message: String
        let translation: String
        switch reason {
        case .userCancelled:
            message = "已取消截图 OCR"
            translation = "你按下了 Esc 或取消了框选。"
        case .tooSmall:
            message = "框选区域太小"
            translation = "请拖出一个稍大的文字区域，至少覆盖完整的一行文字。框选时如果区域太小，我会尽量留在遮罩里让你直接重选。"
        case .captureFailed:
            message = "截图失败"
            translation = "没有拿到屏幕截图。请检查屏幕录制权限，或重新尝试一次。"
        }
        panelController.show(
            original: "截图 OCR",
            translation: translation,
            isLoading: false,
            source: .screenshotOCR,
            status: reason == .userCancelled ? .warning : .error,
            message: message
        )
    }

    private func normalized(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .lowercased()
    }

    private func successMessage(
        unchanged: Bool,
        source: TranslationSource,
        translationElapsed: TimeInterval,
        preflightElapsed: TimeInterval,
        connectionElapsed: TimeInterval?,
        firstVisibleTokenElapsed: TimeInterval?,
        usedStreaming: Bool
    ) -> String {
        TranslationWaitStatusText.successMessage(
            unchanged: unchanged,
            includesOCRPreflight: source == .screenshotOCR,
            translationElapsed: translationElapsed,
            preflightElapsed: preflightElapsed,
            connectionElapsed: connectionElapsed,
            firstVisibleTokenElapsed: firstVisibleTokenElapsed,
            usedStreaming: usedStreaming
        )
    }

    private func streamingProgressMessage(
        progress: TranslationProgress,
        firstVisibleTokenElapsed: TimeInterval?
    ) -> String {
        TranslationWaitStatusText.streamingProgressMessage(
            isFinal: progress.isFinal,
            firstVisibleTokenElapsed: firstVisibleTokenElapsed
        )
    }

    private func makePreConnectionWaitStatusTask(
        sessionID: Int,
        text: String,
        source: TranslationSource,
        startedAt: Date,
        preflightElapsed: TimeInterval,
        targetLanguage: String,
        waitsForFirstToken: Bool
    ) -> Task<Void, Never> {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            while !Task.isCancelled {
                let didUpdate = await MainActor.run { () -> Bool in
                    guard let self, self.isCurrentTranslationSession(sessionID) else { return false }
                    let elapsedNow = Date().timeIntervalSince(startedAt)
                    let waitText = TranslationWaitStatusText.preConnection(
                        elapsed: elapsedNow,
                        waitsForFirstToken: waitsForFirstToken
                    )
                    self.panelController.show(
                        original: text,
                        translation: waitText.translation,
                        isLoading: true,
                        source: source,
                        status: .loading,
                        message: waitText.message,
                        elapsed: elapsedNow + preflightElapsed,
                        targetLanguage: targetLanguage,
                        allowsCancel: true,
                        reposition: false
                    )
                    return true
                }
                guard didUpdate else { return }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func makePostConnectionWaitStatusTask(
        sessionID: Int,
        text: String,
        source: TranslationSource,
        startedAt: Date,
        preflightElapsed: TimeInterval,
        targetLanguage: String,
        waitsForFirstToken: Bool,
        receivedStreamEventsWithoutVisibleText: Bool = false,
        connectionElapsed: TimeInterval? = nil
    ) -> Task<Void, Never> {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            while !Task.isCancelled {
                let didUpdate = await MainActor.run { () -> Bool in
                    guard let self, self.isCurrentTranslationSession(sessionID) else { return false }
                    let elapsedNow = Date().timeIntervalSince(startedAt)
                    let waitText = TranslationWaitStatusText.postConnectionWait(
                        elapsed: elapsedNow,
                        waitsForFirstToken: waitsForFirstToken,
                        receivedStreamEventsWithoutVisibleText: receivedStreamEventsWithoutVisibleText,
                        connectionElapsed: connectionElapsed
                    )
                    self.panelController.show(
                        original: text,
                        translation: waitText.translation,
                        isLoading: true,
                        source: source,
                        status: .loading,
                        message: waitText.message,
                        elapsed: elapsedNow + preflightElapsed,
                        targetLanguage: targetLanguage,
                        allowsCancel: true,
                        reposition: false
                    )
                    return true
                }
                guard didUpdate else { return }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func formatSeconds(_ seconds: TimeInterval) -> String {
        TranslationWaitStatusText.formatSeconds(seconds)
    }

    private static func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func beginOCRSession() -> Int {
        ocrSessionCounter += 1
        activeOCRSessionID = ocrSessionCounter
        return activeOCRSessionID
    }

    private func isCurrentOCRSession(_ sessionID: Int) -> Bool {
        sessionID == activeOCRSessionID
    }

    private func beginTranslationSession() -> Int {
        translationSessionCounter += 1
        activeTranslationSessionID = translationSessionCounter
        return activeTranslationSessionID
    }

    private func invalidateTranslationSession() {
        translationSessionCounter += 1
        activeTranslationSessionID = translationSessionCounter
    }

    private func isCurrentTranslationSession(_ sessionID: Int) -> Bool {
        sessionID == activeTranslationSessionID
    }

    private func resolvedTargetLanguage(for text: String) -> String {
        switch settingsStore.translationDirection {
        case .fixedTarget:
            let target = settingsStore.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
            return target.isEmpty ? "简体中文" : target
        case .autoChineseEnglish:
            return looksMostlyChinese(text) ? "English" : "简体中文"
        }
    }

    private func looksMostlyChinese(_ text: String) -> Bool {
        var chineseCount = 0
        var letterCount = 0

        for scalar in text.unicodeScalars {
            if scalar.properties.isWhitespace || CharacterSet.punctuationCharacters.contains(scalar) {
                continue
            }

            switch scalar.value {
            case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
                chineseCount += 1
            case 0x0041...0x005A, 0x0061...0x007A:
                letterCount += 1
            default:
                continue
            }
        }

        guard chineseCount > 0 else { return false }
        return chineseCount >= 4 || chineseCount >= letterCount
    }
}

private struct PendingOCRPreview {
    let sessionID: Int
    let preflightElapsed: TimeInterval
}

private struct ActiveTranslationRequest {
    let text: String
    let source: TranslationSource
    let preflightElapsed: TimeInterval
    let targetLanguage: String
    var partialTranslation: String = ""
}

private struct TranslationErrorRecovery {
    let statusMessage: String
    let settingsTitle: String?
    let allowsRetry: Bool

    static func make(for error: Error) -> TranslationErrorRecovery {
        if let translationError = error as? TranslationClientError {
            return make(for: translationError)
        }

        if let urlError = error as? URLError {
            return make(for: urlError)
        }

        if error is DecodingError {
            return TranslationErrorRecovery(
                statusMessage: "接口格式不兼容",
                settingsTitle: "检查接口格式",
                allowsRetry: false
            )
        }

        return TranslationErrorRecovery(
            statusMessage: "翻译服务没有返回可用结果",
            settingsTitle: "检查翻译设置",
            allowsRetry: true
        )
    }

    private static func make(for error: TranslationClientError) -> TranslationErrorRecovery {
        switch error {
        case .missingAPIKey:
            return TranslationErrorRecovery(
                statusMessage: "缺少 API Key",
                settingsTitle: "检查 API Key",
                allowsRetry: false
            )
        case .invalidEndpoint:
            return TranslationErrorRecovery(
                statusMessage: "接口地址无效",
                settingsTitle: "检查接口地址",
                allowsRetry: false
            )
        case .badResponse(let statusCode, let message):
            if let issue = TranslationErrorIssue.classify(statusCode: statusCode, message: message) {
                return make(for: issue)
            }
            return make(forHTTPStatusCode: statusCode)
        case .emptyTranslation:
            return TranslationErrorRecovery(
                statusMessage: "接口返回空译文",
                settingsTitle: "检查模型/流式",
                allowsRetry: true
            )
        case .invalidResponse(let preview):
            return makeForInvalidResponse(preview: preview)
        }
    }

    private static func makeForInvalidResponse(preview: String?) -> TranslationErrorRecovery {
        let cleanPreview = preview?
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""

        if cleanPreview == "<non-utf8>" {
            return TranslationErrorRecovery(
                statusMessage: "接口返回非 JSON 内容",
                settingsTitle: "检查代理/网关",
                allowsRetry: false
            )
        }

        if cleanPreview.hasPrefix("<!doctype")
            || cleanPreview.hasPrefix("<html")
            || cleanPreview.contains("<body")
            || cleanPreview.contains("</html>")
            || cleanPreview.contains("cloudflare")
            || cleanPreview.contains("nginx")
            || cleanPreview.contains("captcha")
            || cleanPreview.contains("login")
            || cleanPreview.contains("sign in") {
            return TranslationErrorRecovery(
                statusMessage: "接口返回网页/网关页",
                settingsTitle: "检查接口地址",
                allowsRetry: false
            )
        }

        return TranslationErrorRecovery(
            statusMessage: "接口格式不兼容",
            settingsTitle: "检查接口格式",
            allowsRetry: false
        )
    }

    private static func make(for issue: TranslationErrorIssue) -> TranslationErrorRecovery {
        TranslationErrorRecovery(
            statusMessage: issue.statusMessage,
            settingsTitle: issue.settingsTitle,
            allowsRetry: issue.allowsRetry
        )
    }

    private static func make(forHTTPStatusCode statusCode: Int) -> TranslationErrorRecovery {
        switch statusCode {
        case 200:
            return TranslationErrorRecovery(
                statusMessage: "接口返回错误 JSON",
                settingsTitle: "检查服务商提示",
                allowsRetry: false
            )
        case 400:
            return TranslationErrorRecovery(
                statusMessage: "请求参数或模型不兼容",
                settingsTitle: "检查模型/接口",
                allowsRetry: false
            )
        case 401:
            return TranslationErrorRecovery(
                statusMessage: "API Key 未通过认证",
                settingsTitle: "检查 API Key",
                allowsRetry: false
            )
        case 402:
            return TranslationErrorRecovery(
                statusMessage: "余额或额度不足",
                settingsTitle: "检查余额/额度",
                allowsRetry: false
            )
        case 403:
            return TranslationErrorRecovery(
                statusMessage: "账号或模型权限不足",
                settingsTitle: "检查权限/区域",
                allowsRetry: false
            )
        case 404:
            return TranslationErrorRecovery(
                statusMessage: "接口路径或模型不存在",
                settingsTitle: "检查模型/接口",
                allowsRetry: false
            )
        case 408:
            return TranslationErrorRecovery(
                statusMessage: "翻译请求超时",
                settingsTitle: "检查网络/超时",
                allowsRetry: true
            )
        case 413:
            return TranslationErrorRecovery(
                statusMessage: "文本超过接口限制",
                settingsTitle: "调整文本长度",
                allowsRetry: false
            )
        case 415, 422:
            return TranslationErrorRecovery(
                statusMessage: "接口参数不兼容",
                settingsTitle: "检查模型/接口",
                allowsRetry: false
            )
        case 429:
            return TranslationErrorRecovery(
                statusMessage: "请求被限流",
                settingsTitle: "检查限流/额度",
                allowsRetry: true
            )
        case 451:
            return TranslationErrorRecovery(
                statusMessage: "区域或合规限制",
                settingsTitle: "检查权限/区域",
                allowsRetry: false
            )
        case 500...599:
            return TranslationErrorRecovery(
                statusMessage: "服务商暂时不可用",
                settingsTitle: "切换服务商预设",
                allowsRetry: true
            )
        default:
            return TranslationErrorRecovery(
                statusMessage: "翻译接口返回 HTTP \(statusCode)",
                settingsTitle: "检查翻译设置",
                allowsRetry: true
            )
        }
    }

    private static func make(for error: URLError) -> TranslationErrorRecovery {
        let failingURL = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL)
            ?? (error.userInfo["NSErrorFailingURLStringKey"] as? String).flatMap(URL.init(string:))
        let isLocalEndpoint = isLocalHost(failingURL?.host)

        switch error.code {
        case .badURL, .unsupportedURL:
            return TranslationErrorRecovery(
                statusMessage: "接口地址格式不正确",
                settingsTitle: "检查接口地址",
                allowsRetry: false
            )
        case .cannotFindHost, .dnsLookupFailed:
            if isLocalEndpoint {
                return TranslationErrorRecovery(
                    statusMessage: "本地接口地址异常",
                    settingsTitle: "检查本地服务",
                    allowsRetry: true
                )
            }
            return TranslationErrorRecovery(
                statusMessage: "接口域名无法解析",
                settingsTitle: "检查 DNS/代理",
                allowsRetry: true
            )
        case .cannotConnectToHost:
            if isLocalEndpoint {
                return TranslationErrorRecovery(
                    statusMessage: "本地接口未连接",
                    settingsTitle: "检查本地服务",
                    allowsRetry: true
                )
            }
            return TranslationErrorRecovery(
                statusMessage: "接口连接失败",
                settingsTitle: "检查网络/代理",
                allowsRetry: true
            )
        case .cannotParseResponse:
            return TranslationErrorRecovery(
                statusMessage: "接口响应无法解析",
                settingsTitle: "检查接口地址",
                allowsRetry: false
            )
        case .httpTooManyRedirects, .redirectToNonExistentLocation:
            return TranslationErrorRecovery(
                statusMessage: "接口跳转异常",
                settingsTitle: "检查接口地址",
                allowsRetry: false
            )
        case .timedOut:
            if isLocalEndpoint {
                return TranslationErrorRecovery(
                    statusMessage: "本地模型响应超时",
                    settingsTitle: "检查本地模型",
                    allowsRetry: true
                )
            }
            return TranslationErrorRecovery(
                statusMessage: "网络或服务商响应超时",
                settingsTitle: "检查网络/超时",
                allowsRetry: true
            )
        case .notConnectedToInternet:
            return TranslationErrorRecovery(
                statusMessage: "当前没有网络连接",
                settingsTitle: "检查网络",
                allowsRetry: true
            )
        case .networkConnectionLost:
            return TranslationErrorRecovery(
                statusMessage: "网络连接中断",
                settingsTitle: "检查网络/代理",
                allowsRetry: true
            )
        case .appTransportSecurityRequiresSecureConnection:
            return TranslationErrorRecovery(
                statusMessage: "接口需要 HTTPS",
                settingsTitle: "检查 HTTPS 地址",
                allowsRetry: false
            )
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return TranslationErrorRecovery(
                statusMessage: "HTTPS 或代理证书异常",
                settingsTitle: "检查 HTTPS/代理",
                allowsRetry: false
            )
        case .cannotLoadFromNetwork, .dataNotAllowed:
            return TranslationErrorRecovery(
                statusMessage: "系统网络策略拦截",
                settingsTitle: "检查网络权限",
                allowsRetry: false
            )
        case .badServerResponse:
            return TranslationErrorRecovery(
                statusMessage: "接口响应异常",
                settingsTitle: "检查接口格式",
                allowsRetry: true
            )
        case .clientCertificateRequired, .clientCertificateRejected:
            return TranslationErrorRecovery(
                statusMessage: "接口证书认证异常",
                settingsTitle: "检查证书/网关",
                allowsRetry: false
            )
        case .userAuthenticationRequired:
            return TranslationErrorRecovery(
                statusMessage: "服务商要求认证",
                settingsTitle: "检查 API Key",
                allowsRetry: false
            )
        default:
            return TranslationErrorRecovery(
                statusMessage: "网络请求失败",
                settingsTitle: "检查翻译设置",
                allowsRetry: true
            )
        }
    }

    private static func isLocalHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host == "0.0.0.0"
    }
}

private enum UpdateDefaults {
    static let lastAutomaticCheckAt = "lastAutomaticUpdateCheckAt"
    static let lastPromptedVersion = "lastPromptedUpdateVersion"
    static let minimumAutomaticCheckInterval: TimeInterval = 24 * 60 * 60
}
