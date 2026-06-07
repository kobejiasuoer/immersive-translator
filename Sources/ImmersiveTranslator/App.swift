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

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let settingsStore = SettingsStore()
    private let historyStore = TranslationHistoryStore()
    private lazy var translator = TranslationClient(settingsStore: settingsStore)
    private lazy var panelController = TranslationPanelController(
        settingsStore: settingsStore,
        historyStore: historyStore,
        onRetry: { [weak self] text in
            Task { @MainActor in
                await self?.translateText(text, source: .retry)
            }
        },
        onShowHistory: { [weak self] in
            self?.historyController.show()
        }
    )
    private lazy var settingsController = SettingsWindowController(settingsStore: settingsStore)
    private lazy var historyController = TranslationHistoryWindowController(historyStore: historyStore)
    private lazy var onboardingController = OnboardingWindowController(settingsStore: settingsStore) { [weak self] in
        self?.settingsController.show()
    }
    private var hotKeyManager: HotKeyManager?
    private var screenSelector: ScreenSelectionController?
    private var statusItem: NSStatusItem?
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
    }

    private func configureMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "译"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "翻译选中文本  \(settingsStore.selectionHotKeyPreset.title)", action: #selector(menuTranslateSelection), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "截图 OCR 翻译  \(settingsStore.ocrHotKeyPreset.title)", action: #selector(menuTranslateScreenshot), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "翻译历史...", action: #selector(openHistory), keyEquivalent: ""))
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
        hotKeyManager?.register(
            selectionPreset: settingsStore.selectionHotKeyPreset,
            ocrPreset: settingsStore.ocrHotKeyPreset
        )
    }

    private func observeSettings() {
        settingsStore.$selectionHotKeyPreset
            .dropFirst()
            .sink { [weak self] _ in
                self?.registerHotKeys()
                self?.refreshMenu()
            }
            .store(in: &cancellables)

        settingsStore.$ocrHotKeyPreset
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

    @objc private func showOnboarding() {
        onboardingController.show()
    }

    @objc private func checkPermissions() {
        PermissionPrompter.requestAccessibilityIfNeeded()
        PermissionPrompter.requestScreenCaptureIfNeeded()
        panelController.show(
            original: "权限检查",
            translation: """
            如果系统弹出授权，请允许：
            - 辅助功能：用于读取当前选中的文字。
            - 屏幕录制：用于截图 OCR。

            授权后如果热键没反应，重启一次这个工具即可。
            """,
            isLoading: false,
            source: nil,
            status: .warning,
            message: "权限用途说明"
        )
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }

    @MainActor
    private func translateSelectedText() async {
        guard ensureConfigured() else { return }
        PermissionPrompter.requestAccessibilityIfNeeded()

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

            await translateText(text, source: .selection)
        } catch {
            panelController.show(
                original: "翻译失败",
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: .selection,
                status: .error,
                message: "读取选中文本失败",
                elapsed: Date().timeIntervalSince(startedAt)
            )
        }
    }

    @MainActor
    private func startScreenSelection() {
        guard ensureConfigured() else { return }
        guard PermissionPrompter.requestScreenCaptureIfNeeded() else {
            panelController.show(
                original: "需要屏幕录制权限",
                translation: "请在系统设置里允许本工具进行屏幕录制，然后重新尝试截图 OCR。",
                isLoading: false,
                source: .screenshotOCR,
                status: .warning,
                message: "截图 OCR 需要屏幕录制权限"
            )
            return
        }

        screenSelector = ScreenSelectionController { [weak self] image in
            Task { @MainActor in
                await self?.translateImage(image)
                self?.screenSelector = nil
            }
        } onCancel: { [weak self] reason in
            self?.showScreenSelectionCancel(reason)
            self?.screenSelector = nil
        }
        screenSelector?.begin()
    }

    @MainActor
    private func translateImage(_ image: CGImage) async {
        let startedAt = Date()
        let pixelSize = "\(image.width) x \(image.height) px"
        panelController.show(
            original: "截图区域：\(pixelSize)",
            translation: "正在用本机 Vision 识别文字。截图不会发送给翻译接口。",
            isLoading: true,
            source: .screenshotOCR,
            status: .loading,
            message: "OCR：\(settingsStore.ocrMode.title) · \(settingsStore.ocrLanguagePreset.title)"
        )
        do {
            let text = try await OCRReader.recognizeText(
                in: image,
                mode: settingsStore.ocrMode,
                languagePreset: settingsStore.ocrLanguagePreset
            )
            DiagnosticLogger.log("ocr.recognition.complete mode=\(settingsStore.ocrMode.rawValue) languages=\(settingsStore.ocrLanguagePreset.rawValue) image=\(pixelSize) textLength=\(text.count)")
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                panelController.show(
                    original: "截图区域：\(pixelSize)",
                    translation: "没有识别到可翻译文字。建议把内容放大后再框选，只框文字主体；如果是英文/中文截图，可以在设置里把 OCR 语言改成“英文”或“中英”。",
                    isLoading: false,
                    source: .screenshotOCR,
                    status: .warning,
                    message: "OCR 没有识别到文字",
                    elapsed: Date().timeIntervalSince(startedAt)
                )
                return
            }

            panelController.show(
                original: text,
                translation: "已识别 \(text.count) 个字符，正在翻译。若原文识别不准，可以在设置里切换 OCR 语言或模式。",
                isLoading: true,
                source: .screenshotOCR,
                status: .loading,
                message: "OCR 完成，正在翻译",
                elapsed: Date().timeIntervalSince(startedAt)
            )
            await translateText(text, source: .screenshotOCR, preflightElapsed: Date().timeIntervalSince(startedAt))
        } catch {
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
    private func translateText(_ text: String, source: TranslationSource, preflightElapsed: TimeInterval = 0) async {
        let startedAt = Date()
        let expectedTargetLanguage = resolvedTargetLanguage(for: text)
        panelController.show(
            original: text,
            translation: "正在翻译到 \(expectedTargetLanguage)，使用 \(settingsStore.model.trimmingCharacters(in: .whitespacesAndNewlines))。",
            isLoading: true,
            source: source,
            status: .loading,
            message: source == .screenshotOCR ? "OCR 文本已拿到，正在翻译" : "正在翻译选中文本",
            elapsed: preflightElapsed > 0 ? preflightElapsed : nil,
            targetLanguage: expectedTargetLanguage
        )

        do {
            let result: TranslationResult
            if settingsStore.enableStreamingTranslation {
                result = try await translator.translateStreaming(text: text) { [weak self] progress in
                    guard let self else { return }
                    self.panelController.show(
                        original: text,
                        translation: progress.text,
                        isLoading: !progress.isFinal,
                        source: source,
                        status: progress.isFinal ? .success : .loading,
                        message: progress.isFinal ? "译文已经准备好" : "正在流式显示译文",
                        elapsed: progress.elapsed + preflightElapsed,
                        targetLanguage: expectedTargetLanguage
                    )
                }
            } else {
                result = try await translator.translateWithMetadata(text: text)
            }
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
                preflightElapsed: preflightElapsed
            )
            panelController.show(
                original: text,
                translation: translation,
                isLoading: false,
                source: source,
                status: unchanged ? .unchanged : .success,
                message: message,
                elapsed: totalElapsed,
                targetLanguage: result.targetLanguage
            )
        } catch {
            panelController.show(
                original: text,
                translation: ErrorMessageFormatter.message(for: error),
                isLoading: false,
                source: source,
                status: .error,
                message: "翻译服务没有返回可用结果",
                elapsed: Date().timeIntervalSince(startedAt) + preflightElapsed
            )
        }
    }

    @MainActor
    private func ensureConfigured() -> Bool {
        if settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            settingsController.show()
            panelController.show(
                original: "还没有配置 API Key",
                translation: "我已经打开设置窗口。填入 OpenAI 或兼容服务的 API Key 后，就可以开始翻译。",
                isLoading: false,
                status: .warning,
                message: "需要先配置翻译接口"
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
            translation = "请拖出一个稍大的文字区域，至少覆盖完整的一行文字。"
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
        preflightElapsed: TimeInterval
    ) -> String {
        if unchanged {
            return "译文与原文相同，多半是专有名词、品牌名、代码或模型认为无需翻译。"
        }
        if source == .screenshotOCR {
            return "OCR \(formatSeconds(preflightElapsed))，翻译 \(formatSeconds(translationElapsed))。"
        }
        return "翻译耗时 \(formatSeconds(translationElapsed))。"
    }

    private func formatSeconds(_ seconds: TimeInterval) -> String {
        String(format: "%.1fs", seconds)
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
