import AppKit
import SwiftUI

enum TranslationPanelStatus {
    case loading
    case ocrPreview
    case success
    case unchanged
    case warning
    case error

    var title: String {
        switch self {
        case .loading:
            return "正在处理"
        case .ocrPreview:
            return "确认原文"
        case .success:
            return "翻译完成"
        case .unchanged:
            return "原文已保留"
        case .warning:
            return "需要你看一下"
        case .error:
            return "没有完成"
        }
    }

    var systemImage: String {
        switch self {
        case .loading:
            return "sparkle.magnifyingglass"
        case .ocrPreview:
            return "text.viewfinder"
        case .success:
            return "checkmark.circle.fill"
        case .unchanged:
            return "equal.circle.fill"
        case .warning:
            return "exclamationmark.triangle.fill"
        case .error:
            return "xmark.octagon.fill"
        }
    }

    var color: Color {
        switch self {
        case .loading:
            return .blue
        case .ocrPreview:
            return .teal
        case .success:
            return .green
        case .unchanged:
            return .teal
        case .warning:
            return .orange
        case .error:
            return .red
        }
    }
}

enum TranslationPanelMode {
    case translation
    case ocrPreview
}

@MainActor
final class TranslationPanelController {
    private let model = TranslationPanelModel()
    private let settingsStore: SettingsStore
    private let historyStore: TranslationHistoryStore
    private let onRetry: (String) -> Void
    private let onShowHistory: () -> Void
    private let onOpenSettings: () -> Void
    private let onCancelTranslation: () -> Void
    private let onOCRConfirm: (String) -> Void
    private let onOCRReselect: () -> Void
    private var panel: NSPanel?
    private var autoHideTask: Task<Void, Never>?
    private var elapsedTask: Task<Void, Never>?
    private var loadingStartedAt: Date?
    private var openSettingsActionOverride: (() -> Void)?

    init(
        settingsStore: SettingsStore,
        historyStore: TranslationHistoryStore,
        onRetry: @escaping (String) -> Void,
        onShowHistory: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onCancelTranslation: @escaping () -> Void,
        onOCRConfirm: @escaping (String) -> Void,
        onOCRReselect: @escaping () -> Void
    ) {
        self.settingsStore = settingsStore
        self.historyStore = historyStore
        self.onRetry = onRetry
        self.onShowHistory = onShowHistory
        self.onOpenSettings = onOpenSettings
        self.onCancelTranslation = onCancelTranslation
        self.onOCRConfirm = onOCRConfirm
        self.onOCRReselect = onOCRReselect
    }

    deinit {
        autoHideTask?.cancel()
        elapsedTask?.cancel()
    }

    func show(
        original: String,
        translation: String,
        isLoading: Bool,
        source: TranslationSource? = nil,
        status: TranslationPanelStatus? = nil,
        message: String? = nil,
        elapsed: TimeInterval? = nil,
        targetLanguage: String? = nil,
        allowsRetry: Bool? = nil,
        allowsFavorite: Bool? = nil,
        isTranslationOutput: Bool? = nil,
        allowsOpenSettings: Bool = false,
        openSettingsTitle: String = "打开设置",
        openSettingsAction: (() -> Void)? = nil,
        allowsCancel: Bool = false,
        reposition: Bool = true
    ) {
        let panel = panel ?? makePanel()
        self.panel = panel
        let wasVisible = panel.isVisible

        let wasOCRPreview = model.mode == .ocrPreview
        let cleanOriginal = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTranslation = translation.trimmingCharacters(in: .whitespacesAndNewlines)
        model.mode = .translation
        model.original = original
        model.ocrInitialOriginal = ""
        model.ocrRecognitionFallbackHint = nil
        model.translation = translation
        model.isLoading = isLoading
        model.sourceLabel = source?.displayName ?? "系统提示"
        model.modelLabel = settingsStore.model.trimmingCharacters(in: .whitespacesAndNewlines)
        model.targetLanguage = targetLanguage ?? settingsStore.displayTargetLanguage
        model.status = resolvedStatus(
            explicitStatus: status,
            isLoading: isLoading,
            original: original,
            translation: translation
        )
        model.statusMessage = message ?? defaultMessage(for: model.status, isLoading: isLoading)
        let defaultIsTranslationOutput = source != nil
            && !isLoading
            && (model.status == .success || model.status == .unchanged)
            && !cleanOriginal.isEmpty
            && !cleanTranslation.isEmpty
        model.isTranslationOutput = isTranslationOutput ?? defaultIsTranslationOutput
        model.allowsRetry = allowsRetry ?? (
            source != nil
                && !cleanOriginal.isEmpty
                && !isLoading
                && (model.status == .success || model.status == .unchanged)
        )
        model.allowsFavorite = allowsFavorite ?? (
            model.isTranslationOutput
                && source != nil
                && !cleanOriginal.isEmpty
                && !cleanTranslation.isEmpty
        )
        model.allowsOpenSettings = allowsOpenSettings
        model.openSettingsTitle = openSettingsTitle
        model.allowsCancel = allowsCancel && isLoading
        openSettingsActionOverride = openSettingsAction
        model.isFavorite = historyStore.isFavorite(original: original, translation: translation)
        if isLoading {
            model.notice = ""
        }
        if wasOCRPreview {
            model.showOriginal = false
        }

        DiagnosticLogger.log("translation.panel.show status=\(model.status.title) isLoading=\(isLoading) originalLength=\(original.count) translationLength=\(translation.count)")

        updateElapsedState(isLoading: isLoading, elapsed: elapsed)
        if reposition || !wasVisible {
            position(panel)
        }
        panel.orderFrontRegardless()
        scheduleAutoHideIfNeeded()
    }

    func showOCRPreview(
        original: String,
        imageDescription: String,
        elapsed: TimeInterval,
        sessionID: Int,
        outcome: OCRRecognitionOutcome
    ) {
        let panel = panel ?? makePanel()
        self.panel = panel

        let trimmedOriginal = original.trimmingCharacters(in: .whitespacesAndNewlines)
        model.mode = .ocrPreview
        model.ocrFocusToken += 1
        model.original = original
        model.ocrInitialOriginal = original
        model.translation = ""
        model.isLoading = false
        model.sourceLabel = TranslationSource.screenshotOCR.displayName
        model.modelLabel = "\(outcome.usedMode.title) · \(outcome.usedPreset.title) · \(imageDescription)"
        model.ocrRecognitionFallbackHint = OCRRecognitionFallbackHint.make(from: outcome)
        model.targetLanguage = settingsStore.displayTargetLanguage
        model.status = trimmedOriginal.isEmpty ? .warning : .ocrPreview
        model.statusMessage = trimmedOriginal.isEmpty
            ? "没有识别到可用文字。可以输入/粘贴、重新框选，或打开 OCR 设置调整识别语言和模式；日文请选“日文”或“混合”。"
            : "请确认识别文本，必要时可直接修正。"
        model.isFavorite = false
        model.isTranslationOutput = false
        model.allowsRetry = false
        model.allowsFavorite = false
        model.allowsOpenSettings = true
        model.openSettingsTitle = "OCR 设置"
        model.allowsCancel = false
        openSettingsActionOverride = nil
        model.notice = ""
        model.showOriginal = false

        DiagnosticLogger.log("ocr.preview.show textLength=\(original.count) image=\(imageDescription)")

        updateElapsedState(isLoading: false, elapsed: elapsed)
        position(panel)
        NSApplication.shared.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        scheduleAutoHideIfNeeded()
    }

    func dismiss() {
        autoHideTask?.cancel()
        panel?.orderOut(nil)
    }

    private func resolvedStatus(
        explicitStatus: TranslationPanelStatus?,
        isLoading: Bool,
        original: String,
        translation: String
    ) -> TranslationPanelStatus {
        if let explicitStatus {
            return explicitStatus
        }
        if isLoading {
            return .loading
        }
        let cleanOriginal = normalized(original)
        let cleanTranslation = normalized(translation)
        if !cleanOriginal.isEmpty, cleanOriginal == cleanTranslation {
            return .unchanged
        }
        return .success
    }

    private func defaultMessage(for status: TranslationPanelStatus, isLoading: Bool) -> String {
        switch status {
        case .loading:
            return isLoading ? "我正在处理这段内容。" : "正在处理。"
        case .ocrPreview:
            return "请确认识别文本，必要时可直接修正。"
        case .success:
            return "译文已经准备好。"
        case .unchanged:
            return "模型认为这段内容不需要翻译，通常是品牌名、代码或专有名词。"
        case .warning:
            return "这次没有拿到可用结果。"
        case .error:
            return "这次请求没有完成。"
        }
    }

    private func updateElapsedState(isLoading: Bool, elapsed: TimeInterval?) {
        elapsedTask?.cancel()
        if isLoading {
            let startedAt = Date()
            let elapsedOffset = elapsed ?? 0
            loadingStartedAt = startedAt
            model.elapsedText = Self.formatElapsed(elapsedOffset)
            elapsedTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 120_000_000)
                    await MainActor.run {
                        guard let self, self.model.isLoading else { return }
                        self.model.elapsedText = Self.formatElapsed(elapsedOffset + Date().timeIntervalSince(startedAt))
                    }
                }
            }
        } else if let elapsed {
            loadingStartedAt = nil
            model.elapsedText = Self.formatElapsed(elapsed)
        } else {
            loadingStartedAt = nil
        }
    }

    private func makeRootView() -> TranslationPanelView {
        TranslationPanelView(
            model: model,
            settingsStore: settingsStore,
            onRetry: { [weak self] in
                guard let self else { return }
                self.autoHideTask?.cancel()
                self.onRetry(self.model.original)
            },
            onPinChanged: { [weak self] in
                self?.scheduleAutoHideIfNeeded()
            },
            onAutoHideChanged: { [weak self] in
                self?.scheduleAutoHideIfNeeded()
            },
            onToggleFavorite: { [weak self] in
                self?.toggleFavorite()
            },
            onShowHistory: { [weak self] in
                self?.onShowHistory()
            },
            onOpenSettings: { [weak self] in
                self?.performOpenSettingsAction()
            },
            onCancelTranslation: { [weak self] in
                self?.autoHideTask?.cancel()
                self?.onCancelTranslation()
            },
            onOCRConfirm: { [weak self] text in
                self?.autoHideTask?.cancel()
                self?.onOCRConfirm(text)
            },
            onOCRReselect: { [weak self] in
                self?.autoHideTask?.cancel()
                self?.onOCRReselect()
            },
            onClose: { [weak self] in
                self?.panel?.orderOut(nil)
            }
        )
    }

    private func makePanel() -> NSPanel {
        let rootView = makeRootView()
        let hosting = NSHostingController(rootView: rootView)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 360),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "沉浸式翻译"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentViewController = hosting
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 420, height: 280)
        panel.maxSize = NSSize(width: 720, height: 640)
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        return panel
    }

    private func position(_ panel: NSPanel) {
        let mouse = NSEvent.mouseLocation
        let currentScreen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visibleFrame = currentScreen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        var origin = NSPoint(x: mouse.x + 18, y: mouse.y - panel.frame.height - 18)

        if origin.x + panel.frame.width > visibleFrame.maxX {
            origin.x = visibleFrame.maxX - panel.frame.width - 14
        }
        if origin.y < visibleFrame.minY {
            origin.y = mouse.y + 26
        }
        if origin.y + panel.frame.height > visibleFrame.maxY {
            origin.y = visibleFrame.maxY - panel.frame.height - 14
        }
        if origin.x < visibleFrame.minX {
            origin.x = visibleFrame.minX + 14
        }

        panel.setFrameOrigin(origin)
    }

    private func toggleFavorite() {
        guard !model.isLoading, model.allowsFavorite else { return }
        let isFavorite = historyStore.toggleFavorite(
            original: model.original,
            translation: model.translation,
            targetLanguage: settingsStore.targetLanguage,
            source: .panel
        )
        model.isFavorite = isFavorite
        model.notice = isFavorite ? "已收藏" : "已取消收藏"
        scheduleAutoHideIfNeeded()
    }

    private func performOpenSettingsAction() {
        autoHideTask?.cancel()
        if let openSettingsActionOverride {
            openSettingsActionOverride()
        } else {
            onOpenSettings()
        }
    }

    private func scheduleAutoHideIfNeeded() {
        autoHideTask?.cancel()
        guard model.autoHideEnabled,
              !model.isPinned,
              !model.isLoading,
              model.canAutoHideTranslation,
              !model.translationTrimmed.isEmpty else {
            return
        }

        autoHideTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000_000)
            await MainActor.run {
                guard let self,
                      self.model.autoHideEnabled,
                      !self.model.isPinned,
                      !self.model.isLoading,
                      self.model.canAutoHideTranslation else {
                    return
                }
                self.panel?.orderOut(nil)
            }
        }
    }

    private static func formatElapsed(_ elapsed: TimeInterval) -> String {
        String(format: "%.1fs", elapsed)
    }

    private func normalized(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .lowercased()
    }
}

@MainActor
final class TranslationPanelModel: ObservableObject {
    @Published var mode: TranslationPanelMode = .translation
    @Published var ocrFocusToken = 0
    @Published var original = ""
    @Published var ocrInitialOriginal = ""
    @Published var translation = ""
    @Published var isLoading = false
    @Published var isPinned = false
    @Published var autoHideEnabled = false
    @Published var isFavorite = false
    @Published var notice = ""
    @Published var status: TranslationPanelStatus = .loading
    @Published var statusMessage = "我正在处理这段内容。"
    @Published var sourceLabel = "选中文本"
    @Published var modelLabel = ""
    @Published var ocrRecognitionFallbackHint: OCRRecognitionFallbackHint?
    @Published var targetLanguage = ""
    @Published var elapsedText = ""
    @Published var showOriginal = false
    @Published var isTranslationOutput = false
    @Published var allowsRetry = false
    @Published var allowsFavorite = false
    @Published var allowsOpenSettings = false
    @Published var openSettingsTitle = "打开设置"
    @Published var allowsCancel = false
}

struct TranslationPanelView: View {
    @ObservedObject var model: TranslationPanelModel
    @ObservedObject var settingsStore: SettingsStore
    let onRetry: () -> Void
    let onPinChanged: () -> Void
    let onAutoHideChanged: () -> Void
    let onToggleFavorite: () -> Void
    let onShowHistory: () -> Void
    let onOpenSettings: () -> Void
    let onCancelTranslation: () -> Void
    let onOCRConfirm: (String) -> Void
    let onOCRReselect: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            primaryContent
            actions
        }
        .padding(16)
        .frame(minWidth: 420, idealWidth: 540, minHeight: 280, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(0.12), lineWidth: 1)
        )
        .onExitCommand(perform: handleExitCommand)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: model.displayStatus.systemImage)
                    .symbolRenderingMode(.hierarchical)
                Text(model.displayStatus.title)
                    .fontWeight(.semibold)
                if model.isLoading {
                    ProgressView()
                        .scaleEffect(0.58)
                        .frame(width: 14, height: 14)
                }
            }
            .font(.caption)
            .foregroundStyle(model.displayStatus.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(model.displayStatus.color.opacity(0.13), in: Capsule())

            Text(metadataText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer(minLength: 8)

            if !model.notice.isEmpty {
                Text(model.notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            compactButton(
                systemName: model.autoHideEnabled ? "timer" : "timer.circle",
                help: model.autoHideEnabled ? "自动隐藏已开启" : "自动隐藏已关闭"
            ) {
                model.autoHideEnabled.toggle()
                if model.autoHideEnabled {
                    model.notice = model.canAutoHideTranslation ? "16 秒后自动隐藏" : "完整译文会自动隐藏"
                } else {
                    model.notice = "已关闭自动隐藏"
                }
                onAutoHideChanged()
            }

            compactButton(
                systemName: model.isPinned ? "pin.fill" : "pin",
                help: model.isPinned ? "取消固定" : "固定浮窗"
            ) {
                model.isPinned.toggle()
                model.notice = model.isPinned ? "浮窗已固定" : "已取消固定"
                onPinChanged()
            }

            compactButton(systemName: "xmark", help: "关闭浮窗", action: onClose)
        }
    }

    @ViewBuilder
    private var primaryContent: some View {
        if model.mode == .ocrPreview {
            ocrPreviewContent
        } else {
            translationContent
        }
    }

    private var translationContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(model.displayStatusMessage)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if !model.targetLanguage.isEmpty {
                    Text("目标：\(model.targetLanguage)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    Text(model.primaryText)
                        .textSelection(.enabled)
                        .font(.system(size: model.isLoading ? 15 : 17, weight: model.isLoading ? .regular : .medium))
                        .foregroundStyle(model.isLoading ? .secondary : .primary)
                        .lineSpacing(model.isLoading ? 4 : 6)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if model.status == .unchanged {
                        hintLine(
                            systemName: "info.circle",
                            text: "如果你希望把品牌名也解释成中文含义，可以选中更完整的一句话再翻译。"
                        )
                    }

                    Divider()
                        .opacity(model.originalTrimmed.isEmpty ? 0 : 1)

                    DisclosureGroup(isExpanded: $model.showOriginal) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.originalTrimmed.isEmpty ? "没有原文。" : model.originalTrimmed)
                                .textSelection(.enabled)
                                .font(.system(size: 13))
                                .foregroundStyle(.secondary)
                                .lineSpacing(4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.top, 6)
                    } label: {
                        HStack(spacing: 6) {
                            Text("原文")
                                .font(.caption.weight(.semibold))
                            Text("\(model.originalTrimmed.count) 字符")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(model.originalTrimmed.isEmpty)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 4)
            }
            .frame(minHeight: 136)
        }
    }

    private var ocrPreviewContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(model.displayStatusMessage)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if !model.targetLanguage.isEmpty {
                    Text("目标：\(model.targetLanguage)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.05))

                OCRPreviewTextEditor(
                    text: $model.original,
                    focusToken: model.ocrFocusToken,
                    onConfirm: confirmOCRPreviewIfPossible,
                    onEscape: handleExitCommand,
                    onCopyAll: copyOCRPreviewOriginal,
                    onPolish: polishOCRPreviewParagraphs,
                    onPolishConfirm: polishConfirmOCRPreviewParagraphs,
                    onCopyPolished: copyPolishedOCRPreviewParagraphs,
                    onPasteReplace: pasteReplaceOCRPreviewOriginal,
                    onPasteConfirm: pasteConfirmOCRPreviewOriginal,
                    onRestoreOriginal: restoreOCRPreviewOriginal,
                    onOpenSettings: onOpenSettings
                )
                .padding(8)

                if model.originalTrimmed.isEmpty {
                    Text(ocrPlaceholderText)
                        .font(.system(size: 14))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .allowsHitTesting(false)
                }
            }
            .frame(minHeight: 154)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.primary.opacity(0.12), lineWidth: 1)
            )

            HStack(spacing: 8) {
                Label(model.ocrPreviewSummary, systemImage: model.originalTrimmed.isEmpty ? "exclamationmark.triangle" : "text.alignleft")
                    .foregroundStyle(model.originalTrimmed.isEmpty ? .orange : .secondary)
                Spacer()
                Text(model.ocrPreviewEditStateText)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)

            if let fallbackHint = model.ocrRecognitionFallbackHint {
                hintLine(
                    systemName: fallbackHint.systemImage,
                    text: fallbackHint.text,
                    color: fallbackHint.color
                )
            }

            hintLine(
                systemName: "keyboard",
                text: ocrKeyboardHintText
            )

            if let changeHint = model.ocrPreviewChangeHint {
                hintLine(
                    systemName: changeHint.systemImage,
                    text: changeHint.text,
                    color: changeHint.color
                )
            }

            if let qualityHint = model.ocrPreviewQualityHint {
                hintLine(
                    systemName: qualityHint.systemImage,
                    text: qualityHint.text,
                    color: qualityHint.color
                )
            }

            hintLine(
                systemName: "lock.shield",
                text: ocrHintText
            )
        }
    }

    @ViewBuilder
    private var actions: some View {
        if model.mode == .ocrPreview {
            ocrPreviewActions
        } else {
            translationActions
        }
    }

    private var translationActions: some View {
        HStack(spacing: 8) {
            if model.isTranslationOutput {
                actionButton("复制译文", systemName: "doc.on.doc", prominent: true, disabled: model.translationTrimmed.isEmpty || model.isLoading) {
                    copyToPasteboard(model.translationTrimmed, notice: "已复制译文")
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .help("⌘⇧C 复制译文")
                actionButton("复制双语", systemName: "doc.text.below.ecg", disabled: model.translationTrimmed.isEmpty || model.originalTrimmed.isEmpty || model.isLoading) {
                    copyToPasteboard(combinedTranslationText(), notice: "已复制原文和译文")
                }
                .keyboardShortcut("c", modifiers: [.command, .option, .shift])
                .help("⌘⌥⇧C 复制原文和译文")
                actionButton("重新翻译", systemName: "arrow.clockwise", disabled: model.isLoading || !model.allowsRetry) {
                    onRetry()
                }
                .keyboardShortcut("r", modifiers: .command)
                .help("⌘R 重新翻译当前原文")
                actionButton(model.isFavorite ? "已收藏" : "收藏", systemName: model.isFavorite ? "star.fill" : "star", disabled: model.isLoading || !model.allowsFavorite) {
                    onToggleFavorite()
                }
                .keyboardShortcut("s", modifiers: [.command, .option])
                .help("⌘⌥S 收藏/取消收藏当前译文")
            } else {
                if model.allowsRetry {
                    actionButton("重新翻译", systemName: "arrow.clockwise", prominent: true, disabled: model.isLoading) {
                        onRetry()
                    }
                    .keyboardShortcut("r", modifiers: .command)
                    .help("⌘R 重新翻译当前原文")
                }
                if model.allowsOpenSettings {
                    actionButton(model.openSettingsTitle, systemName: "slider.horizontal.3", disabled: model.isLoading) {
                        onOpenSettings()
                    }
                }
                actionButton(model.status == .error ? "复制错误" : "复制提示", systemName: "doc.on.doc", disabled: model.translationTrimmed.isEmpty || model.isLoading) {
                    copyToPasteboard(model.translationTrimmed, notice: model.status == .error ? "已复制错误提示" : "已复制提示")
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .help(model.status == .error ? "⌘⇧C 复制错误提示" : "⌘⇧C 复制提示")
            }
            if model.allowsCancel {
                actionButton("取消", systemName: "xmark.circle", disabled: !model.isLoading) {
                    onCancelTranslation()
                }
                .keyboardShortcut(.cancelAction)
                .help("取消当前翻译请求")
            }
            actionButton("历史", systemName: "clock") {
                onShowHistory()
            }
            Spacer(minLength: 0)
            Button {
                copyToPasteboard(model.originalTrimmed, notice: "已复制原文")
            } label: {
                Image(systemName: "doc.text")
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("c", modifiers: [.command, .option])
            .help("⌘⌥C 复制原文")
            .disabled(model.originalTrimmed.isEmpty)
        }
    }

    private var ocrPreviewActions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(action: confirmOCRPreviewIfPossible) {
                    Label(model.originalTrimmed.isEmpty ? "输入后翻译" : "确认翻译", systemImage: "checkmark.circle")
                        .lineLimit(1)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(model.originalTrimmed.isEmpty)
                .keyboardShortcut(.defaultAction)
                .help("Enter 或 ⌘Enter 确认翻译；Shift+Enter 在文本中换行")

                actionButton("整理并翻译", systemName: "paperplane.circle", disabled: model.originalTrimmed.isEmpty) {
                    polishConfirmOCRPreviewParagraphs()
                }
                .keyboardShortcut(.return, modifiers: [.command, .shift])
                .help("⌘⇧Enter 先整理段落，再确认翻译")

                actionButton("粘贴替换", systemName: "doc.on.clipboard") {
                    pasteReplaceOCRPreviewOriginal()
                }
                .keyboardShortcut("v", modifiers: [.command, .option])
                .help("⌘⌥V 用剪贴板文本替换整段 OCR 原文")

                actionButton("粘贴并翻译", systemName: "paperplane", prominent: model.originalTrimmed.isEmpty) {
                    pasteConfirmOCRPreviewOriginal()
                }
                .keyboardShortcut(.return, modifiers: [.command, .option])
                .help("⌘⌥Enter 用剪贴板文本替换 OCR 原文并立即翻译")

                actionButton("重新框选", systemName: "viewfinder") {
                    onOCRReselect()
                }
                .keyboardShortcut("r", modifiers: .command)
                .help("Esc 或 ⌘R 重新框选")

                Spacer(minLength: 0)
            }

            HStack(spacing: 8) {
                actionButton("整理段落", systemName: "text.alignleft", disabled: model.originalTrimmed.isEmpty) {
                    polishOCRPreviewParagraphs()
                }
                .keyboardShortcut("j", modifiers: .command)
                .help("⌘J 合并段内硬换行，并尽量保留空行、列表和键值结构")

                actionButton("复制整理版", systemName: "doc.on.doc", disabled: model.originalTrimmed.isEmpty) {
                    copyPolishedOCRPreviewParagraphs()
                }
                .keyboardShortcut("j", modifiers: [.command, .option])
                .help("⌘⌥J 复制整理后的文本，不改动当前 OCR 原文")

                actionButton("恢复识别", systemName: "arrow.uturn.backward", disabled: !model.canRestoreOCRPreviewOriginal) {
                    restoreOCRPreviewOriginal()
                }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .help("⌘⌥R 恢复到最初 OCR 识别文本")

                actionButton("复制原文", systemName: "doc.on.doc", disabled: model.originalTrimmed.isEmpty) {
                    copyOCRPreviewOriginal()
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .help("⌘⇧C 复制整段 OCR 原文")

                if model.allowsOpenSettings {
                    actionButton(model.openSettingsTitle, systemName: "slider.horizontal.3") {
                        onOpenSettings()
                    }
                    .keyboardShortcut(",", modifiers: .command)
                    .help("⌘, 打开截图 OCR 设置，调整识别模式和识别语言")
                }

                actionButton("历史", systemName: "clock") {
                    onShowHistory()
                }

                Spacer(minLength: 0)
            }
        }
    }

    private var metadataText: String {
        var parts = [model.sourceLabel]
        if !model.modelLabel.isEmpty {
            parts.append(model.modelLabel)
        }
        if !model.elapsedText.isEmpty {
            parts.append(model.elapsedText)
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func actionButton(
        _ title: String,
        systemName: String,
        prominent: Bool = false,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        if prominent {
            Button(action: action) {
                Label(title, systemImage: systemName)
                    .lineLimit(1)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(disabled)
        } else {
            Button(action: action) {
                Label(title, systemImage: systemName)
                    .lineLimit(1)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(disabled)
        }
    }

    private func compactButton(systemName: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: 16, height: 16)
        }
        .buttonStyle(.borderless)
        .help(help)
    }

    private func hintLine(systemName: String, text: String, color: Color = .secondary) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: systemName)
                .foregroundStyle(color)
            Text(text)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
    }

    private var ocrPlaceholderText: String {
        "没有识别到文字。\n可以直接输入，或按 ⌘⌥V 粘贴替换；⌘, 可调整 OCR 语言/模式。"
    }

    private var ocrKeyboardHintText: String {
        if model.originalTrimmed.isEmpty {
            return "快捷键：⌘⌥V 粘贴替换，⌘⌥Enter 粘贴并翻译，⌘, 打开 OCR 设置，Esc/⌘R 重新框选。"
        }
        if model.ocrPreviewQualityHint != nil || model.ocrPreviewChangeHint != nil {
            return "快捷键：Enter 翻译，⌘⇧Enter 整理并翻译，⌘J 整理段落，Esc/⌘R 重新框选。"
        }
        return "快捷键：Enter 翻译，Shift+Enter 换行，⌘J 整理段落，⌘⇧C 复制原文，Esc/⌘R 重新框选。"
    }

    private var ocrHintText: String {
        if let configurationIssue = ocrTranslationConfigurationIssue {
            return "截图只用于本机 OCR；\(configurationIssue)"
        }
        if model.originalTrimmed.isEmpty {
            return "截图只用于本机 OCR；只有你输入或粘贴并确认后的文本才会发送给翻译接口。"
        }
        return "截图只用于本机 OCR；确认后才会把上面的文本发送给翻译接口。更多快捷键可以看下方按钮提示。"
    }

    private var ocrTranslationConfigurationIssue: String? {
        let endpoint = settingsStore.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty else {
            return "OCR 已经可用；请先在设置里选择本地接口，或填写云接口地址和 API Key 后再翻译。"
        }

        guard let url = TranslationClient.chatCompletionsURL(from: endpoint) else {
            return "OCR 已经可用；接口地址需要修正后才能翻译。"
        }

        if TranslationClient.requiresAPIKey(for: url),
           settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "OCR 已经可用；当前云接口需要 API Key，也可以在设置里自己填一个 OpenAI 兼容接口地址和 Key 后再翻译。"
        }

        return nil
    }

    private func confirmOCRPreviewIfPossible() {
        let text = model.originalTrimmed
        guard !text.isEmpty else {
            model.notice = "先输入原文，或按 ⌘⌥V 粘贴替换后再翻译"
            model.ocrFocusToken += 1
            return
        }
        confirmOCRTextOrOpenTranslationSettings(text)
    }

    private func confirmOCRTextOrOpenTranslationSettings(
        _ text: String,
        readyNotice: String? = nil,
        blockedNotice: String? = nil
    ) {
        if let configurationIssue = ocrTranslationConfigurationIssue {
            model.notice = [blockedNotice, configurationIssue]
                .compactMap { $0 }
                .joined(separator: "；")
            onOpenSettings()
            return
        }

        if let readyNotice {
            model.notice = readyNotice
        }
        onOCRConfirm(text)
    }

    private func handleExitCommand() {
        if model.mode == .ocrPreview {
            onOCRReselect()
        } else if model.allowsCancel, model.isLoading {
            onCancelTranslation()
        } else {
            onClose()
        }
    }

    private func copyOCRPreviewOriginal() {
        let text = model.originalTrimmed
        guard !text.isEmpty else {
            model.notice = "没有可复制的原文"
            return
        }
        copyToPasteboard(text, notice: "已复制原文")
    }

    private func polishOCRPreviewParagraphs() {
        let source = model.originalTrimmed
        guard !source.isEmpty else {
            model.notice = "没有可整理的原文"
            return
        }

        let beforeStats = OCRPreviewTextStats.make(from: source)
        let polished = OCRPreviewParagraphPolisher.polish(source)
        guard !polished.isEmpty else {
            model.notice = "没有可整理的原文"
            return
        }

        if polished == source {
            model.notice = noticeWithOCRChange(beforeStats.structurePreservationNotice ?? "段落已经很整齐")
        } else {
            let afterStats = OCRPreviewTextStats.make(from: polished)
            model.original = polished
            model.ocrFocusToken += 1
            model.notice = noticeWithOCRChange(beforeStats.polishNotice(after: afterStats))
        }
    }

    private func polishConfirmOCRPreviewParagraphs() {
        let source = model.originalTrimmed
        guard !source.isEmpty else {
            model.notice = "没有可翻译的原文"
            return
        }

        let polished = OCRPreviewParagraphPolisher.polish(source)
        guard !polished.isEmpty else {
            model.notice = "没有可翻译的整理文本"
            return
        }

        if polished != source {
            model.original = polished
            model.ocrFocusToken += 1
        }
        confirmOCRTextOrOpenTranslationSettings(
            polished,
            readyNotice: polished == source ? nil : noticeWithOCRChange("已整理，正在翻译"),
            blockedNotice: polished == source ? nil : noticeWithOCRChange("已整理")
        )
    }

    private func copyPolishedOCRPreviewParagraphs() {
        let source = model.originalTrimmed
        guard !source.isEmpty else {
            model.notice = "没有可复制的原文"
            return
        }

        let polished = OCRPreviewParagraphPolisher.polish(source)
        guard !polished.isEmpty else {
            model.notice = "没有可复制的整理文本"
            return
        }

        let notice = polished == source ? "已复制原文（无需整理）" : "已复制整理版"
        copyToPasteboard(polished, notice: notice)
    }

    private func pasteReplaceOCRPreviewOriginal() {
        let text = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            model.notice = "剪贴板没有可用文本"
            return
        }

        model.original = text
        model.ocrFocusToken += 1
        model.notice = noticeWithOCRChange("已用剪贴板替换原文")
    }

    private func pasteConfirmOCRPreviewOriginal() {
        let text = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            model.notice = "剪贴板没有可用文本"
            return
        }

        model.original = text
        model.ocrFocusToken += 1
        confirmOCRTextOrOpenTranslationSettings(
            text,
            readyNotice: noticeWithOCRChange("已粘贴，正在翻译"),
            blockedNotice: noticeWithOCRChange("已粘贴")
        )
    }

    private func restoreOCRPreviewOriginal() {
        guard model.canRestoreOCRPreviewOriginal else {
            model.notice = model.ocrInitialOriginalTrimmed.isEmpty ? "没有可恢复的识别文本" : "已经是最初识别文本"
            return
        }

        model.original = model.ocrInitialOriginal
        model.ocrFocusToken += 1
        model.notice = "已恢复最初识别文本"
    }

    private func noticeWithOCRChange(_ notice: String) -> String {
        guard let compactText = model.ocrPreviewChangeHint?.compactText else {
            return notice
        }
        return "\(notice) · \(compactText)"
    }

    private func combinedTranslationText() -> String {
        """
        原文：
        \(model.originalTrimmed)

        译文：
        \(model.translationTrimmed)
        """
    }

    private func copyToPasteboard(_ text: String, notice: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        model.notice = notice
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            if model.notice == notice {
                model.notice = ""
            }
        }
    }
}

private extension TranslationPanelModel {
    var originalTrimmed: String {
        original.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var ocrInitialOriginalTrimmed: String {
        ocrInitialOriginal.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isOCRPreviewEdited: Bool {
        !ocrInitialOriginalTrimmed.isEmpty && originalTrimmed != ocrInitialOriginalTrimmed
    }

    var canRestoreOCRPreviewOriginal: Bool {
        isOCRPreviewEdited
    }

    var ocrPreviewEditStateText: String {
        if originalTrimmed.isEmpty {
            return "可手动输入"
        }
        if ocrInitialOriginalTrimmed.isEmpty {
            return "手动输入"
        }
        return isOCRPreviewEdited ? "已修改 · 可恢复" : "原始识别"
    }

    var translationTrimmed: String {
        translation.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canAutoHideTranslation: Bool {
        isTranslationOutput && (status == .success || status == .unchanged)
    }

    var displayStatus: TranslationPanelStatus {
        guard mode == .ocrPreview else {
            return status
        }
        let stats = OCRPreviewTextStats.make(from: originalTrimmed)
        return stats.needsAttentionBeforeOCRConfirmation ? .warning : .ocrPreview
    }

    var displayStatusMessage: String {
        guard mode == .ocrPreview else {
            return statusMessage
        }
        let stats = OCRPreviewTextStats.make(from: originalTrimmed)
        if stats.characterCount == 0 {
            return "没有识别到可用文字。可以直接输入或粘贴原文，也可以重新框选。"
        }
        if stats.looksLikeNonTextNoise {
            return "识别结果像符号或噪声。建议重新框选文字区域，或粘贴原文。"
        }
        if stats.characterCount <= 8 {
            return "识别结果很短。请确认是否只框到局部文字，必要时补全或重新框选。"
        }
        if stats.looksPossiblyClipped {
            return "识别结果可能只截到一部分。请确认上下文是否完整，必要时重新框选。"
        }
        return "请确认识别文本，必要时可直接修正。"
    }

    var primaryText: String {
        if isLoading {
            return translationTrimmed.isEmpty ? statusMessage : translationTrimmed
        }
        return translationTrimmed.isEmpty ? statusMessage : translationTrimmed
    }

    var ocrPreviewSummary: String {
        let stats = OCRPreviewTextStats.make(from: originalTrimmed)
        guard stats.characterCount > 0 else {
            return "未识别到文字"
        }

        return stats.compactSummary
    }

    var ocrPreviewChangeHint: OCRPreviewChangeHint? {
        OCRPreviewChangeHint.make(current: originalTrimmed, initial: ocrInitialOriginalTrimmed)
    }

    var ocrPreviewQualityHint: OCRPreviewQualityHint? {
        OCRPreviewQualityHint.make(from: OCRPreviewTextStats.make(from: originalTrimmed))
    }
}

struct OCRRecognitionFallbackHint {
    let systemImage: String
    let text: String
    let color: Color

    static func make(from outcome: OCRRecognitionOutcome) -> OCRRecognitionFallbackHint? {
        guard outcome.hasFallback else { return nil }

        let configuredMode = outcome.configuredMode.title
        let configuredPreset = outcome.configuredPreset.title
        let usedPreset = outcome.usedPreset.title

        if outcome.modeDowngraded && outcome.usedFallbackPreset {
            return OCRRecognitionFallbackHint(
                systemImage: "arrow.triangle.swap",
                text: "你选了\(configuredMode)模式 + “\(configuredPreset)”，但该语言在\(configuredMode)模式不可用，且\(configuredPreset)下没识别到文字，已自动用准确模式并回退到“\(usedPreset)”重新识别，可能稍慢。",
                color: .orange
            )
        }

        if outcome.modeDowngraded {
            return OCRRecognitionFallbackHint(
                systemImage: "speedometer",
                text: "你选了\(configuredMode)模式，但“\(configuredPreset)”在\(configuredMode)模式下不可用，已自动改用准确模式识别，可能稍慢。",
                color: .orange
            )
        }

        return OCRRecognitionFallbackHint(
            systemImage: "arrow.triangle.2.circlepath",
            text: "本次在“\(configuredPreset)”下没识别到文字，已自动回退到“\(usedPreset)”重新识别。",
            color: .orange
        )
    }
}

private struct OCRPreviewChangeHint {
    let systemImage: String
    let text: String
    let compactText: String
    let color: Color

    static func make(current: String, initial: String) -> OCRPreviewChangeHint? {
        let currentStats = OCRPreviewTextStats.make(from: current)
        let initialStats = OCRPreviewTextStats.make(from: initial)

        if initialStats.characterCount == 0 {
            guard currentStats.characterCount > 0 else { return nil }
            return OCRPreviewChangeHint(
                systemImage: "pencil.and.outline",
                text: "已从空 OCR 结果补入 \(currentStats.compactSummary)，确认后将发送这段文本。",
                compactText: "已补入 \(currentStats.characterCount) 字符",
                color: .teal
            )
        }

        if currentStats.characterCount == 0 {
            return OCRPreviewChangeHint(
                systemImage: "arrow.uturn.backward.circle",
                text: "当前文本已清空；可以继续输入/粘贴，或按 ⌘⌥R 恢复最初 \(initialStats.compactSummary)。",
                compactText: "已清空，可恢复",
                color: .orange
            )
        }

        guard current != initial else { return nil }

        let deltaText = currentStats.deltaDescription(from: initialStats)
        let onlyWhitespaceChanged = normalizedForComparison(current) == normalizedForComparison(initial)
        let text = onlyWhitespaceChanged
            ? "只调整了空白或换行；可按 ⌘⌥R 恢复最初识别。"
            : "\(deltaText)；可按 ⌘⌥R 恢复最初识别。"
        let compactText = onlyWhitespaceChanged ? "仅格式变化" : deltaText

        return OCRPreviewChangeHint(
            systemImage: "arrow.triangle.2.circlepath",
            text: text,
            compactText: compactText,
            color: .secondary
        )
    }

    private static func normalizedForComparison(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }
}

private struct OCRPreviewQualityHint {
    let systemImage: String
    let text: String
    let color: Color

    static func make(from stats: OCRPreviewTextStats) -> OCRPreviewQualityHint? {
        if stats.characterCount == 0 {
            return OCRPreviewQualityHint(
                systemImage: "wand.and.rays",
                text: "可以直接输入原文，或按 ⌘⌥V 用剪贴板替换；如果是日文，按 ⌘, 打开 OCR 设置选择“日文”或“混合”；如果是误框选，按 Esc/⌘R 重新框选。",
                color: .orange
            )
        }

        if stats.looksLikeNonTextNoise {
            return OCRPreviewQualityHint(
                systemImage: "exclamationmark.magnifyingglass",
                text: "识别结果几乎都是符号、分隔线或 OCR 噪声，可能框到了图标、表格边框或背景纹理；建议重新框选只包含文字的区域，或按 ⌘⌥V 粘贴文本。",
                color: .orange
            )
        }

        if stats.characterCount <= 8 {
            return OCRPreviewQualityHint(
                systemImage: "scope",
                text: "识别结果很短，可能只框到边缘、图标或局部文字；确认前可以补全，或重新框选更完整的一行。",
                color: .orange
            )
        }

        if stats.lineCount == 1, stats.longestLineLength >= 120 {
            return OCRPreviewQualityHint(
                systemImage: "text.line.first.and.arrowtriangle.forward",
                text: "识别结果是一整条很长的单行。确认前建议扫一眼开头和结尾是否被截断；如果这是自然段，翻译通常没问题，也可用 Shift+Enter 手动补换行。",
                color: .secondary
            )
        }

        if stats.looksPossiblyClipped {
            return OCRPreviewQualityHint(
                systemImage: "crop",
                text: "这段文字末尾不像完整句子，可能只框到段落的一部分；如果译文容易断章取义，建议按 Esc/⌘R 重新框选更完整的上下文。",
                color: .orange
            )
        }

        if let structureNotice = stats.structurePreservationNotice {
            return OCRPreviewQualityHint(
                systemImage: "tablecells",
                text: "\(structureNotice)。如果这是目录、索引、表格、列表或键值内容，建议保留换行后再翻译。",
                color: .secondary
            )
        }

        if stats.looksLikeMultiColumnOrRegion {
            return OCRPreviewQualityHint(
                systemImage: "rectangle.split.2x1",
                text: "行长呈现左右交替或多组短行，可能是双列/多区域内容；不要先用 ⌘J 盲目合并，建议扫一眼是否跨栏混入了不相关文字，必要时重新框选单列。",
                color: .secondary
            )
        }

        if stats.lineCount >= 4,
           stats.paragraphCount <= 1,
           stats.averageLineLength <= 34,
           stats.shortLineRatio < 0.60 {
            return OCRPreviewQualityHint(
                systemImage: "text.alignleft",
                text: "看起来像被 OCR 拆成多行的自然段；按 ⌘J 可以先合并段内硬换行，减少翻译时的断句感。",
                color: .secondary
            )
        }

        if stats.lineCount >= 8, stats.shortLineRatio >= 0.70 {
            return OCRPreviewQualityHint(
                systemImage: "rectangle.split.3x1",
                text: "检测到很多短行，可能是菜单、列表或多列界面；如果是自然段可先按 ⌘J 整理，如果是菜单/多列内容则保留换行或重新框选单列。",
                color: .secondary
            )
        }

        return nil
    }
}

private struct OCRPreviewTextStats {
    let characterCount: Int
    let lineCount: Int
    let paragraphCount: Int
    let averageLineLength: Double
    let shortLineRatio: Double
    let structuredLineCount: Int
    let keyValueLineCount: Int
    let danglingFieldLabelCount: Int
    let tabularLineCount: Int
    let tableOfContentsLineCount: Int
    let compactFieldBoundaryCount: Int
    let alternatingLineLengthCount: Int
    let looksLikeCompactStructuredBlock: Bool
    let longestLineLength: Int
    let endsWithSentenceTerminator: Bool
    let startsWithLowercaseLatin: Bool
    let nonWhitespaceCharacterCount: Int
    let textLikeCharacterCount: Int

    static func make(from text: String) -> OCRPreviewTextStats {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let paragraphs = trimmed
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let lineLengths = lines.map(meaningfulLength)
        let lineCount = lines.count
        let shortLineCount = lines.filter(looksLikeShortLine).count
        let nonWhitespaceCharacterCount = nonWhitespaceScalarCount(in: trimmed)

        return OCRPreviewTextStats(
            characterCount: trimmed.count,
            lineCount: lineCount,
            paragraphCount: max(paragraphs.count, trimmed.isEmpty ? 0 : 1),
            averageLineLength: lineCount == 0 ? 0 : Double(lineLengths.reduce(0, +)) / Double(lineCount),
            shortLineRatio: lineCount == 0 ? 0 : Double(shortLineCount) / Double(lineCount),
            structuredLineCount: lines.filter(startsStructuredLine).count,
            keyValueLineCount: lines.filter(looksLikeKeyValueLine).count,
            danglingFieldLabelCount: lines.filter(OCRPreviewParagraphPolisher.looksLikeDanglingFieldLabelLine).count,
            tabularLineCount: lines.filter(looksLikeTabularLine).count,
            tableOfContentsLineCount: lines.filter(looksLikeTableOfContentsLine).count,
            compactFieldBoundaryCount: OCRPreviewParagraphPolisher.compactFieldBoundaryCount(in: lines),
            alternatingLineLengthCount: alternatingLineLengthCount(in: lines),
            looksLikeCompactStructuredBlock: OCRPreviewParagraphPolisher.looksLikeCompactStructuredBlock(lines),
            longestLineLength: lineLengths.max() ?? 0,
            endsWithSentenceTerminator: endsWithSentenceTerminator(trimmed),
            startsWithLowercaseLatin: startsWithLowercaseLatin(trimmed),
            nonWhitespaceCharacterCount: nonWhitespaceCharacterCount,
            textLikeCharacterCount: textLikeScalarCount(in: trimmed)
        )
    }

    var compactSummary: String {
        "\(characterCount) 字符 · \(lineCount) 行 · \(paragraphCount) 段"
    }

    var structurePreservationNotice: String? {
        if tableOfContentsLineCount >= 2 {
            return "检测到目录或页码结构，已倾向保留换行"
        }
        if tabularLineCount >= 2 {
            return "检测到表格或多列结构，已倾向保留换行"
        }
        if structuredLineCount >= 2 {
            return "检测到列表结构，已倾向保留换行"
        }
        if keyValueLineCount >= 2 {
            return "检测到键值结构，已倾向保留换行"
        }
        if danglingFieldLabelCount >= 1 {
            return "检测到字段标签独占行，已倾向保留标签与内容换行"
        }
        if compactFieldBoundaryCount >= 1 {
            return "检测到字段、状态、数值或模型名结构，已倾向保留换行"
        }
        if looksLikeCompactStructuredBlock {
            return "检测到卡片、指标或小型多区域结构，已倾向保留换行"
        }
        return nil
    }

    var looksLikeMultiColumnOrRegion: Bool {
        guard lineCount >= 6, paragraphCount <= 2 else { return false }
        if shortLineRatio >= 0.72 {
            return true
        }
        return alternatingLineLengthCount >= 3 && averageLineLength <= 46
    }

    var looksLikeNonTextNoise: Bool {
        guard nonWhitespaceCharacterCount >= 3 else { return false }
        if textLikeCharacterCount == 0 {
            return true
        }
        guard characterCount >= 9 else { return false }
        let textLikeRatio = Double(textLikeCharacterCount) / Double(nonWhitespaceCharacterCount)
        return textLikeRatio < 0.28
    }

    var needsAttentionBeforeOCRConfirmation: Bool {
        characterCount == 0
            || looksLikeNonTextNoise
            || characterCount <= 8
            || looksPossiblyClipped
    }

    var looksPossiblyClipped: Bool {
        guard characterCount >= 60,
              structuredLineCount == 0,
              keyValueLineCount == 0,
              tabularLineCount == 0 else {
            return false
        }
        if startsWithLowercaseLatin && lineCount <= 2 {
            return true
        }
        return lineCount <= 3 && !endsWithSentenceTerminator
    }

    func polishNotice(after: OCRPreviewTextStats) -> String {
        if let structurePreservationNotice, lineCount == after.lineCount {
            return structurePreservationNotice
        }
        if lineCount > after.lineCount {
            return "已整理：\(lineCount) 行 -> \(after.lineCount) 行 / \(after.paragraphCount) 段"
        }
        if paragraphCount != after.paragraphCount {
            return "已整理为 \(after.paragraphCount) 段"
        }
        return "已整理段落"
    }

    func deltaDescription(from previous: OCRPreviewTextStats) -> String {
        var parts: [String] = []
        appendDelta(current: characterCount, previous: previous.characterCount, label: "字符", into: &parts)
        appendDelta(current: lineCount, previous: previous.lineCount, label: "行", into: &parts)
        appendDelta(current: paragraphCount, previous: previous.paragraphCount, label: "段", into: &parts)
        return parts.isEmpty ? "内容已修改" : "变化：\(parts.joined(separator: " / "))"
    }

    private func appendDelta(current: Int, previous: Int, label: String, into parts: inout [String]) {
        let delta = current - previous
        guard delta != 0 else { return }
        let prefix = delta > 0 ? "+" : ""
        parts.append("\(label) \(prefix)\(delta)")
    }

    static func startsStructuredLine(_ text: String) -> Bool {
        OCRPreviewParagraphPolisher.startsStructuredLine(text)
    }

    static func looksLikeKeyValueLine(_ text: String) -> Bool {
        OCRPreviewParagraphPolisher.looksLikeKeyValueLine(text)
    }

    static func looksLikeTabularLine(_ text: String) -> Bool {
        OCRPreviewParagraphPolisher.looksLikeTabularLine(text)
    }

    static func looksLikeTableOfContentsLine(_ text: String) -> Bool {
        OCRPreviewParagraphPolisher.looksLikeTableOfContentsLine(text)
    }

    static func looksLikeShortLine(_ text: String) -> Bool {
        OCRPreviewParagraphPolisher.looksLikeShortLine(text)
    }

    static func meaningfulLength(_ text: String) -> Int {
        OCRPreviewParagraphPolisher.meaningfulLength(text)
    }

    private static func endsWithSentenceTerminator(_ text: String) -> Bool {
        guard let scalar = text.unicodeScalars.reversed().first(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) else {
            return false
        }
        return CharacterSet(charactersIn: ".!?。！？…」』”’)]}）】》").contains(scalar)
    }

    private static func startsWithLowercaseLatin(_ text: String) -> Bool {
        guard let scalar = text.unicodeScalars.first(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) else {
            return false
        }
        return CharacterSet.lowercaseLetters.contains(scalar)
    }

    private static func nonWhitespaceScalarCount(in text: String) -> Int {
        text.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.count
    }

    private static func textLikeScalarCount(in text: String) -> Int {
        text.unicodeScalars.filter { scalar in
            CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
        }.count
    }

    private static func alternatingLineLengthCount(in lines: [String]) -> Int {
        let lengths = lines.map(meaningfulLength)
        guard lengths.count >= 3 else { return 0 }

        var count = 0
        for index in 1..<(lengths.count - 1) {
            let previous = lengths[index - 1]
            let current = lengths[index]
            let next = lengths[index + 1]
            let isValley = previous - current >= 12 && next - current >= 12
            let isPeak = current - previous >= 12 && current - next >= 12
            if isValley || isPeak {
                count += 1
            }
        }
        return count
    }
}

private struct OCRPreviewTextEditor: NSViewRepresentable {
    @Binding var text: String
    let focusToken: Int
    let onConfirm: () -> Void
    let onEscape: () -> Void
    let onCopyAll: () -> Void
    let onPolish: () -> Void
    let onPolishConfirm: () -> Void
    let onCopyPolished: () -> Void
    let onPasteReplace: () -> Void
    let onPasteConfirm: () -> Void
    let onRestoreOriginal: () -> Void
    let onOpenSettings: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let textView = OCRPreviewNSTextView()
        textView.delegate = context.coordinator
        textView.string = text
        textView.drawsBackground = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.allowsUndo = true
        textView.font = .systemFont(ofSize: 14)
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 0, height: 2)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.onConfirm = onConfirm
        textView.onEscape = onEscape
        textView.onCopyAll = onCopyAll
        textView.onPolish = onPolish
        textView.onPolishConfirm = onPolishConfirm
        textView.onCopyPolished = onCopyPolished
        textView.onPasteReplace = onPasteReplace
        textView.onPasteConfirm = onPasteConfirm
        textView.onRestoreOriginal = onRestoreOriginal
        textView.onOpenSettings = onOpenSettings

        scrollView.documentView = textView
        context.coordinator.textView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }
        if textView.string != text {
            textView.string = text
        }
        textView.onConfirm = onConfirm
        textView.onEscape = onEscape
        textView.onCopyAll = onCopyAll
        textView.onPolish = onPolish
        textView.onPolishConfirm = onPolishConfirm
        textView.onCopyPolished = onCopyPolished
        textView.onPasteReplace = onPasteReplace
        textView.onPasteConfirm = onPasteConfirm
        textView.onRestoreOriginal = onRestoreOriginal
        textView.onOpenSettings = onOpenSettings

        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async {
                guard textView.window != nil else { return }
                textView.window?.makeFirstResponder(textView)
                let cursorLocation = textView.string.utf16.count
                textView.setSelectedRange(NSRange(location: cursorLocation, length: 0))
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: OCRPreviewNSTextView?
        var lastFocusToken = -1

        init(text: Binding<String>) {
            _text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            text = textView.string
        }
    }
}

private final class OCRPreviewNSTextView: NSTextView {
    var onConfirm: (() -> Void)?
    var onEscape: (() -> Void)?
    var onCopyAll: (() -> Void)?
    var onPolish: (() -> Void)?
    var onPolishConfirm: (() -> Void)?
    var onCopyPolished: (() -> Void)?
    var onPasteReplace: (() -> Void)?
    var onPasteConfirm: (() -> Void)?
    var onRestoreOriginal: (() -> Void)?
    var onOpenSettings: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }

        let flags = event.modifierFlags
            .intersection(.deviceIndependentFlagsMask)
            .subtracting(.numericPad)
        switch event.keyCode {
        case 36, 76:
            if flags == [.command, .shift] {
                onPolishConfirm?()
                return
            }
            if flags == [.command, .option] {
                onPasteConfirm?()
                return
            }
            if flags.isEmpty || flags == [.command] {
                onConfirm?()
                return
            }
        case 53:
            if flags.isEmpty {
                onEscape?()
                return
            }
        case 15:
            if flags == [.command, .option] {
                onRestoreOriginal?()
                return
            }
            if flags == [.command] {
                onEscape?()
                return
            }
        case 8:
            if flags == [.command, .shift] {
                onCopyAll?()
                return
            }
        case 38:
            if flags == [.command, .option] {
                onCopyPolished?()
                return
            }
            if flags == [.command] {
                onPolish?()
                return
            }
        case 9:
            if flags == [.command, .option] {
                onPasteReplace?()
                return
            }
        case 43:
            if flags == [.command] {
                onOpenSettings?()
                return
            }
        default:
            break
        }

        super.keyDown(with: event)
    }
}

private enum OCRPreviewParagraphPolisher {
    private enum Boundary {
        case join
        case line
        case paragraph
    }

    static func polish(_ text: String) -> String {
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var groups: [[String]] = []
        var current: [String] = []

        for rawLine in normalized.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty {
                if !current.isEmpty {
                    groups.append(current)
                    current = []
                }
            } else {
                current.append(line)
            }
        }

        if !current.isEmpty {
            groups.append(current)
        }

        return groups
            .map(polishGroup)
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    private static func polishGroup(_ lines: [String]) -> String {
        guard var output = lines.first else { return "" }
        guard lines.count > 1 else { return output }

        if shouldPreserveLineBreaks(lines) {
            return renderPreservedLines(lines)
        }

        var previous = output
        for line in lines.dropFirst() {
            switch boundaryBetween(previous: previous, next: line) {
            case .join:
                output = joinParagraphLine(output, line)
            case .line:
                output += "\n\(line)"
            case .paragraph:
                output += "\n\n\(line)"
            }
            previous = line
        }
        return output
    }

    private static func boundaryBetween(previous: String, next: String) -> Boundary {
        if looksLikeTableOfContentsLine(previous) || looksLikeTableOfContentsLine(next) {
            return .line
        }
        if shouldJoinTechnicalTokenWithoutSpace(left: previous, right: next) {
            return .join
        }
        if shouldJoinStructuredListContinuation(previous: previous, next: next) {
            return .join
        }
        if startsStructuredLine(previous) || startsStructuredLine(next) {
            return .line
        }
        if looksLikeKeyValueLine(previous) || looksLikeKeyValueLine(next) {
            return .line
        }
        if looksLikeDanglingFieldBoundary(previous: previous, next: next) {
            return .line
        }
        if looksLikeCodeOrQuoteLine(previous) || looksLikeCodeOrQuoteLine(next) {
            return .line
        }
        if looksLikeCompactFieldBoundary(previous: previous, next: next) {
            return .line
        }
        if looksLikeStandaloneHeading(previous: previous, next: next) {
            return .paragraph
        }
        return .join
    }

    private static func shouldPreserveLineBreaks(_ lines: [String]) -> Bool {
        let structuredCount = lines.filter(startsStructuredLine).count
        if structuredCount >= 2 {
            return true
        }

        let tableOfContentsCount = lines.filter(looksLikeTableOfContentsLine).count
        if tableOfContentsCount >= 2 {
            return true
        }

        let keyValueCount = lines.filter(looksLikeKeyValueLine).count
        if keyValueCount >= 2 {
            return true
        }

        let tabularCount = lines.filter(looksLikeTabularLine).count
        if tabularCount >= 2 {
            return true
        }

        if lines.contains(where: looksLikeDanglingFieldLabelLine) {
            return false
        }

        if looksLikeCompactStructuredBlock(lines) {
            return true
        }

        if looksLikeSeparatedAnchorBlock(lines) {
            return true
        }

        if looksLikeMultiColumnOrRegion(lines) {
            return true
        }

        let shortCount = lines.filter(looksLikeShortLine).count
        let shortRatio = Double(shortCount) / Double(lines.count)
        let averageLength = Double(lines.map(meaningfulLength).reduce(0, +)) / Double(lines.count)
        return lines.count >= 3 && shortRatio >= 0.66 && averageLength <= 28
    }

    static func looksLikeCompactStructuredBlock(_ lines: [String]) -> Bool {
        guard lines.count >= 3, lines.count <= 7 else { return false }

        let lengths = lines.map(meaningfulLength)
        let averageLength = Double(lengths.reduce(0, +)) / Double(max(lengths.count, 1))
        let shortCount = lines.filter(looksLikeShortLine).count
        let shortRatio = Double(shortCount) / Double(lines.count)

        if looksLikeCompactMetricOrStatusBlock(lines, shortRatio: shortRatio, averageLength: averageLength) {
            return true
        }

        return looksLikeCompactMultiRegionBlock(lines, lengths: lengths, shortCount: shortCount, averageLength: averageLength)
    }

    static func compactFieldBoundaryCount(in lines: [String]) -> Int {
        guard lines.count >= 2 else { return 0 }

        var count = 0
        for index in 1..<lines.count where looksLikeCompactFieldBoundary(previous: lines[index - 1], next: lines[index]) {
            count += 1
        }
        return count
    }

    private static func looksLikeCompactMetricOrStatusBlock(
        _ lines: [String],
        shortRatio: Double,
        averageLength: Double
    ) -> Bool {
        guard shortRatio >= 0.55, averageLength <= 34 else { return false }

        let valueCount = lines.filter(looksLikeStandaloneValueLine).count
        let statusCount = lines.filter(looksLikeStandaloneStatusLine).count
        let labelCount = lines.filter(looksLikeCompactLabelLine).count

        if valueCount + statusCount >= 2 {
            return true
        }
        return valueCount + statusCount >= 1 && labelCount >= 2
    }

    private static func looksLikeCompactMultiRegionBlock(
        _ lines: [String],
        lengths: [Int],
        shortCount: Int,
        averageLength: Double
    ) -> Bool {
        guard lines.count >= 4, lines.count <= 5 else { return false }
        guard shortCount >= 2, averageLength <= 52 else { return false }
        return alternatingLineLengthCount(in: lengths, threshold: 10) >= 2
    }

    private static func looksLikeMultiColumnOrRegion(_ lines: [String]) -> Bool {
        guard lines.count >= 6 else { return false }

        let lengths = lines.map(meaningfulLength)
        let shortCount = lines.filter(looksLikeShortLine).count
        let shortRatio = Double(shortCount) / Double(lines.count)
        if shortRatio >= 0.72 {
            return true
        }

        return alternatingLineLengthCount(in: lengths, threshold: 12) >= 3
            && Double(lengths.reduce(0, +)) / Double(lengths.count) <= 46
    }

    private static func renderPreservedLines(_ lines: [String]) -> String {
        guard looksLikeSeparatedAnchorBlock(lines) else {
            var renderedLines: [String] = []
            var current = lines[0]
            for line in lines.dropFirst() {
                if shouldJoinStructuredListContinuation(previous: current, next: line) {
                    current = joinParagraphLine(current, line)
                } else {
                    renderedLines.append(current)
                    current = line
                }
            }
            renderedLines.append(current)
            return renderedLines.joined(separator: "\n")
        }

        var output = lines[0]
        for index in 1..<lines.count {
            let previous = lines[index - 1]
            let line = lines[index]
            let separator = shouldStartNewPreservedSection(previous: previous, current: line) ? "\n\n" : "\n"
            output += "\(separator)\(line)"
        }
        return output
    }

    static func looksLikeSeparatedAnchorBlock(_ lines: [String]) -> Bool {
        guard lines.count >= 3 else { return false }

        let anchorIndices = lines.indices.filter { looksLikeStandaloneAnchorLine(lines[$0]) }
        guard anchorIndices.count >= 2 else { return false }

        for pairIndex in 1..<anchorIndices.count {
            let previousAnchor = anchorIndices[pairIndex - 1]
            let nextAnchor = anchorIndices[pairIndex]
            guard nextAnchor - previousAnchor >= 2 else { continue }

            let between = lines[(previousAnchor + 1)..<nextAnchor]
            if between.contains(where: { meaningfulLength($0) >= 24 }) {
                return true
            }
        }
        return false
    }

    private static func shouldStartNewPreservedSection(previous: String, current: String) -> Bool {
        looksLikeStandaloneAnchorLine(current)
            && !looksLikeStandaloneAnchorLine(previous)
            && meaningfulLength(previous) >= 24
    }

    private static func alternatingLineLengthCount(in lengths: [Int], threshold: Int) -> Int {
        guard lengths.count >= 3 else { return 0 }

        var alternatingCount = 0
        for index in 1..<(lengths.count - 1) {
            let previous = lengths[index - 1]
            let current = lengths[index]
            let next = lengths[index + 1]
            let isValley = previous - current >= threshold && next - current >= threshold
            let isPeak = current - previous >= threshold && current - next >= threshold
            if isValley || isPeak {
                alternatingCount += 1
            }
        }

        return alternatingCount
    }

    private static func joinParagraphLine(_ left: String, _ right: String) -> String {
        let left = left.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = right.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty else { return right }
        guard !right.isEmpty else { return left }

        if let dehyphenated = dehyphenatedLineBreakJoin(left: left, right: right) {
            return dehyphenated
        }
        if shouldJoinTechnicalTokenWithoutSpace(left: left, right: right) {
            return left + right
        }
        return left + (needsSpaceBetween(left, right) ? " " : "") + right
    }

    private static func shouldJoinStructuredListContinuation(previous: String, next: String) -> Bool {
        guard startsListItemLine(previous),
              !endsListItemContinuation(previous),
              looksLikeListContinuationLine(next) else {
            return false
        }
        return true
    }

    private static func looksLikeListContinuationLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(trimmed) >= 4,
              !startsStructuredLine(trimmed),
              !looksLikeTableOfContentsLine(trimmed),
              !looksLikeKeyValueLine(trimmed),
              !looksLikeTabularLine(trimmed),
              !looksLikeDanglingFieldLabelLine(trimmed),
              !looksLikeCodeOrQuoteLine(trimmed),
              !looksLikeStandaloneFieldValueLine(trimmed) else {
            return false
        }

        if startsWithLowercaseLatin(trimmed) {
            return true
        }
        if let first = firstMeaningfulScalar(in: trimmed), isCJK(first) {
            return true
        }
        return meaningfulLength(trimmed) >= 12 && !looksLikeShortLine(trimmed)
    }

    private static func endsListItemContinuation(_ text: String) -> Bool {
        guard let last = lastMeaningfulScalar(in: text) else {
            return true
        }
        return CharacterSet(charactersIn: ".!?:。！？：").contains(last)
    }

    private static func dehyphenatedLineBreakJoin(left: String, right: String) -> String? {
        guard startsWithLowercaseLatin(right),
              let trailing = lastMeaningfulScalar(in: left),
              isLineBreakHyphen(trailing) else {
            return nil
        }

        let leftBeforeHyphen = String(left.dropLast())
        guard let previous = lastMeaningfulScalar(in: leftBeforeHyphen),
              isLatinLetter(previous) else {
            return nil
        }

        if shouldPreserveHyphenatedCompoundLineBreak(
            leftBeforeHyphen: leftBeforeHyphen,
            right: right,
            hyphen: trailing
        ) {
            return left + right
        }

        return leftBeforeHyphen + right
    }

    private static func shouldPreserveHyphenatedCompoundLineBreak(
        leftBeforeHyphen: String,
        right: String,
        hyphen: Unicode.Scalar
    ) -> Bool {
        guard hyphen.value != 0x00AD,
              let leftFragment = trailingLatinHyphenFragment(in: leftBeforeHyphen),
              let rightFragment = leadingLatinFragment(in: right),
              rightFragment.count >= 2 else {
            return false
        }

        if leftFragment.contains("-") {
            return true
        }

        return commonHyphenatedLineBreakPrefixes.contains(leftFragment.lowercased())
    }

    private static func shouldJoinTechnicalTokenWithoutSpace(left: String, right: String) -> Bool {
        guard let trailing = trailingTechnicalTokenFragment(in: left),
              let leading = leadingTechnicalTokenFragment(in: right) else {
            return false
        }

        let joined = trailing + leading
        guard joined.range(of: #"[A-Za-z0-9]"#, options: .regularExpression) != nil else {
            return false
        }

        if trailing.hasSuffix("@") || leading.hasPrefix("@") {
            return joined.range(of: #"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.-]+"#, options: .regularExpression) != nil
        }
        if trailing.range(of: #"https?://"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        if trailing.hasSuffix("/") || leading.hasPrefix("/") {
            return joined.range(of: #"^~?/|/[A-Za-z0-9._~%+\-]"#, options: .regularExpression) != nil
        }
        if trailing.hasSuffix(".") || leading.hasPrefix(".") {
            return isLikelyDotSeparatedTechnicalJoin(trailing: trailing, leading: leading, joined: joined)
        }
        if trailing.hasSuffix("-") || leading.hasPrefix("-") || trailing.hasSuffix("_") || leading.hasPrefix("_") {
            return joined.range(of: #"[A-Za-z0-9][-_][A-Za-z0-9]"#, options: .regularExpression) != nil
        }
        if trailing.hasSuffix(":") || leading.hasPrefix(":") {
            return joined.range(
                of: #"^(?:https?|file|ftp|s3|gs|ssh):[/A-Za-z0-9]"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
                || joined.range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil
        }
        return false
    }

    private static func isLikelyDotSeparatedTechnicalJoin(trailing: String, leading: String, joined: String) -> Bool {
        if joined.range(of: #"\d+\.\d+"#, options: .regularExpression) != nil {
            return true
        }

        let trailingPrefix = trailing.hasSuffix(".") ? String(trailing.dropLast()) : trailing
        let separatorScalars = CharacterSet(charactersIn: "/:@._~%+-")
        if trailingPrefix.unicodeScalars.contains(where: { separatorScalars.contains($0) }) {
            return true
        }

        let leadingSuffix = leading.hasPrefix(".") ? String(leading.dropFirst()) : leading
        let leadingHead = leadingSuffix
            .split(whereSeparator: { "/:?#".contains($0) })
            .first
            .map(String.init) ?? ""
        return commonTechnicalTopLevelDomains.contains(leadingHead.lowercased())
    }

    private static func trailingTechnicalTokenFragment(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"[A-Za-z0-9][A-Za-z0-9._~%+\-/:@]*[._~%+\-/:@]$"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return String(trimmed[range])
    }

    private static func leadingTechnicalTokenFragment(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"^[._~%+\-/:@]?[A-Za-z0-9][A-Za-z0-9._~%+\-/:@]*"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return String(trimmed[range])
    }

    private static func trailingLatinHyphenFragment(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"[A-Za-z][A-Za-z-]*$"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return String(trimmed[range])
    }

    private static func leadingLatinFragment(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"^[a-z]{2,}"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return String(trimmed[range])
    }

    private static func startsListItemLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.range(of: #"^[-*•·●○]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^\[[ xX✓✔-]\]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[☐☑☒✓✔]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^\d{1,3}[\.)、]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[A-Za-z][\.)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[（(]\s*(\d{1,3}|[A-Za-z]|[IVXLCDMivxlcdm]{1,8}|[一二三四五六七八九十百千万]+)\s*[）)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑❶❷❸❹❺❻❼❽❾❿]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[IVXLCDMivxlcdm]{1,8}[\.)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[一二三四五六七八九十百千万]+[、\.)．]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    static func startsStructuredLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.range(of: #"^[-*•·●○]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^\[[ xX✓✔-]\]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[☐☑☒✓✔]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^\d{1,3}[\.)、]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[A-Za-z][\.)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[（(]\s*(\d{1,3}|[A-Za-z]|[IVXLCDMivxlcdm]{1,8}|[一二三四五六七八九十百千万]+)\s*[）)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑❶❷❸❹❺❻❼❽❾❿]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[IVXLCDMivxlcdm]{1,8}[\.)]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[一二三四五六七八九十百千万]+[、\.)．]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^第[一二三四五六七八九十百千万]+[章节条项]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^#{1,6}\s+\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^>{1,3}\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    static func looksLikeKeyValueLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(trimmed) >= 3 else { return false }
        if looksLikeTableOfContentsLine(trimmed) {
            return true
        }
        if looksLikeTabularLine(trimmed) {
            return true
        }
        if trimmed.range(of: #"^[^:：]{1,24}[:：]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[^=＝]{1,24}[=＝]\s*\S"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    static func looksLikeDanglingFieldLabelLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let length = meaningfulLength(trimmed)
        guard length >= 2, length <= 32 else { return false }
        guard let last = lastMeaningfulScalar(in: trimmed),
              CharacterSet(charactersIn: ":：").contains(last) else {
            return false
        }
        guard trimmed.range(of: #"[.!?。！？]$"#, options: .regularExpression) == nil,
              !looksLikeTableOfContentsLine(trimmed),
              !looksLikeTabularLine(trimmed) else {
            return false
        }

        let label = String(trimmed.dropLast())
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(label) >= 1 else { return false }

        if label.unicodeScalars.contains(where: isCJK) {
            return meaningfulLength(label) <= 18
        }
        return wordCount(label) <= 5
    }

    static func looksLikeTableOfContentsLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(trimmed) >= 6 else { return false }

        if trimmed.range(
            of: #".{2,}\s*[.·•‧⋯…]{2,}\s*(?:[A-Za-z]?\d{1,4}|[IVXLCDMivxlcdm]{1,8})\s*$"#,
            options: .regularExpression
        ) != nil {
            return true
        }

        return trimmed.range(
            of: #"^(?:\d{1,2}(?:[\.)]\d{1,2})*|[IVXLCDMivxlcdm]{1,8}|第[一二三四五六七八九十百千万]+[章节篇])\s+.{2,}\s{2,}(?:\d{1,4}|[IVXLCDMivxlcdm]{1,8})$"#,
            options: .regularExpression
        ) != nil
    }

    static func looksLikeTabularLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.range(of: #"\S(?:\t+|\s{2,})\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.filter({ $0 == "|" }).count >= 2 {
            return true
        }
        return trimmed.range(
            of: #"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$"#,
            options: .regularExpression
        ) != nil
    }

    static func looksLikeShortLine(_ text: String) -> Bool {
        let length = meaningfulLength(text)
        guard length > 0 else { return false }
        if containsSentencePunctuation(text), length > 10 {
            return false
        }
        if length <= 18 {
            return true
        }
        return wordCount(text) <= 3 && length <= 28
    }

    private static func looksLikeCompactLabelLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let length = meaningfulLength(trimmed)
        guard length >= 2, length <= 34 else { return false }
        guard !looksLikeStandaloneValueLine(trimmed),
              !looksLikeStandaloneStatusLine(trimmed),
              !containsSentencePunctuation(trimmed),
              !startsStructuredLine(trimmed),
              !looksLikeTableOfContentsLine(trimmed),
              !looksLikeTabularLine(trimmed) else {
            return false
        }

        if trimmed.unicodeScalars.contains(where: isCJK) {
            return length <= 18
        }
        return wordCount(trimmed) <= 5
    }

    private static func looksLikeStandaloneAnchorLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let length = meaningfulLength(trimmed)
        guard length >= 2, length <= 34,
              !containsSentencePunctuation(trimmed),
              !startsWithLowercaseLatin(trimmed),
              !startsStructuredLine(trimmed),
              !looksLikeKeyValueLine(trimmed),
              !looksLikeTabularLine(trimmed),
              !looksLikeCodeOrQuoteLine(trimmed),
              !looksLikeStandaloneFieldValueLine(trimmed) else {
            return false
        }

        guard let first = firstMeaningfulScalar(in: trimmed), !isCJK(first) else {
            return false
        }
        return wordCount(trimmed) <= 5
    }

    private static func looksLikeCompactFieldBoundary(previous: String, next: String) -> Bool {
        if looksLikeCompactLabelLine(previous),
           looksLikeStandaloneFieldValueLine(next) {
            return true
        }
        if looksLikeStandaloneFieldValueLine(previous),
           looksLikeCompactLabelLine(next) {
            return true
        }
        return false
    }

    private static func looksLikeDanglingFieldBoundary(previous: String, next: String) -> Bool {
        if looksLikeDanglingFieldLabelLine(previous) {
            return true
        }
        if looksLikeDanglingFieldLabelLine(next) {
            return true
        }
        return false
    }

    private static func looksLikeStandaloneFieldValueLine(_ text: String) -> Bool {
        looksLikeStandaloneValueLine(text)
            || looksLikeStandaloneStatusLine(text)
            || looksLikeStandaloneIdentifierValueLine(text)
    }

    private static func looksLikeStandaloneValueLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(trimmed) >= 1, meaningfulLength(trimmed) <= 30 else { return false }

        if trimmed.range(
            of: #"^[+\-−]?\s*(?:[$€¥£]\s*)?\d[\d,.\s]*(?:%|[A-Za-z]{1,6}|[万亿年月日天时分秒]+|[mMkKgGtTpP]?[bB]/s?)?$"#,
            options: .regularExpression
        ) != nil {
            return true
        }

        return trimmed.range(
            of: #"^[+\-−]?\s*(?:[$€¥£]\s*)?\d[\d,.\s]*\s*(?:/|of)\s*\d[\d,.\s]*(?:%|[A-Za-z]{1,6})?$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func looksLikeStandaloneIdentifierValueLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let length = meaningfulLength(trimmed)
        guard length >= 3, length <= 80,
              !containsSentencePunctuation(trimmed),
              !trimmed.contains(where: \.isWhitespace) else {
            return false
        }

        if trimmed.range(of: #"^https?://\S+$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        if trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*[0-9][A-Za-z0-9._:/@+-]*$"#, options: .regularExpression) != nil {
            return true
        }
        return trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*[-_/:@][A-Za-z0-9._:/@+-]*$"#, options: .regularExpression) != nil
    }

    private static func looksLikeStandaloneStatusLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard meaningfulLength(trimmed) >= 2, meaningfulLength(trimmed) <= 20 else { return false }

        return trimmed.range(
            of: #"^(?:ok|done|failed|error|pending|active|inactive|enabled|disabled|online|offline|on|off|yes|no|成功|失败|完成|待处理|进行中|启用|停用|开启|关闭|正常|异常|在线|离线|通过|未通过)$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    static func meaningfulLength(_ text: String) -> Int {
        text.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.count
    }

    private static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace }).count
    }

    private static func containsSentencePunctuation(_ text: String) -> Bool {
        text.range(of: #"[.!?。！？]"#, options: .regularExpression) != nil
    }

    private static func looksLikeCodeOrQuoteLine(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            return true
        }
        if trimmed.range(of: #"^(`{1,3}|'{3})\S"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[{}\[\]().]\s*$"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^</?[A-Za-z][A-Za-z0-9:-]*(\s|>|/>)"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^(func|let|var|class|struct|enum|import|return|guard|throw|try|await|const|function|def|public|private|protected|static)\b"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^(if|else|for|while)\b.*(?:[;:{}]|\))\s*$"#, options: .regularExpression) != nil {
            return true
        }
        if trimmed.range(of: #"^[A-Za-z_][A-Za-z0-9_\.]*\s*\([^)]*\)\s*[;{]?$"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    private static func looksLikeStandaloneHeading(previous: String, next: String) -> Bool {
        let previousLength = meaningfulLength(previous)
        let nextLength = meaningfulLength(next)
        guard previousLength >= 3,
              previousLength <= 34,
              nextLength >= max(previousLength + 8, 24),
              !containsSentencePunctuation(previous),
              !looksLikeKeyValueLine(previous),
              !looksLikeTabularLine(previous) else {
            return false
        }

        guard let first = firstMeaningfulScalar(in: previous) else {
            return false
        }
        if isCJK(first) {
            return previousLength <= 18
        }
        return looksLikeTitleCaseHeading(previous)
    }

    private static func looksLikeTitleCaseHeading(_ text: String) -> Bool {
        let words = text
            .split(whereSeparator: { $0.isWhitespace })
            .compactMap { word -> Unicode.Scalar? in
                word.unicodeScalars.first { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }
            }
        guard !words.isEmpty, words.count <= 6 else { return false }

        let letterScalars = text.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        if !letterScalars.isEmpty,
           letterScalars.allSatisfy({ !CharacterSet.lowercaseLetters.contains($0) }) {
            return true
        }

        let titleInitialCount = words.filter {
            CharacterSet.uppercaseLetters.contains($0) || CharacterSet.decimalDigits.contains($0)
        }.count
        let lowerInitialCount = words.filter { CharacterSet.lowercaseLetters.contains($0) }.count
        if words.count == 1 {
            return titleInitialCount == 1
        }
        return titleInitialCount >= 2 && lowerInitialCount <= 2
    }

    private static func needsSpaceBetween(_ left: String, _ right: String) -> Bool {
        guard let last = lastMeaningfulScalar(in: left),
              let first = firstMeaningfulScalar(in: right) else {
            return false
        }

        if isClosingPunctuation(first) || isOpeningPunctuation(last) {
            return false
        }
        if isCJK(last), isCJK(first) {
            return false
        }
        if isCJK(last), isCJKPunctuation(first) {
            return false
        }
        if isCJKPunctuation(last), isCJK(first) {
            return false
        }
        return true
    }

    private static func startsWithLowercaseLatin(_ text: String) -> Bool {
        guard let scalar = firstMeaningfulScalar(in: text) else { return false }
        return (0x0061...0x007A).contains(scalar.value)
    }

    private static func firstMeaningfulScalar(in text: String) -> Unicode.Scalar? {
        text.unicodeScalars.first { !CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    private static func lastMeaningfulScalar(in text: String) -> Unicode.Scalar? {
        text.unicodeScalars.reversed().first { !CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3400...0x9FFF, 0xF900...0xFAFF, 0x20000...0x2FA1F:
            return true
        default:
            return false
        }
    }

    private static func isCJKPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3000...0x303F, 0xFF00...0xFFEF:
            return true
        default:
            return false
        }
    }

    private static func isLatinLetter(_ scalar: Unicode.Scalar) -> Bool {
        (0x0041...0x005A).contains(scalar.value) || (0x0061...0x007A).contains(scalar.value)
    }

    private static func isLineBreakHyphen(_ scalar: Unicode.Scalar) -> Bool {
        CharacterSet(charactersIn: "-\u{00AD}\u{2010}\u{2011}").contains(scalar)
    }

    private static func isClosingPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        closingPunctuation.contains(scalar)
    }

    private static func isOpeningPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        openingPunctuation.contains(scalar)
    }

    private static let closingPunctuation = CharacterSet(charactersIn: ".,;:!?)]}，。？！；：、）】》」』”’")
    private static let openingPunctuation = CharacterSet(charactersIn: "([{（【《「『“‘")
    private static let commonHyphenatedLineBreakPrefixes: Set<String> = [
        "anti", "cross", "end", "full", "high", "long", "low", "multi", "non",
        "open", "post", "pre", "real", "self", "short", "well", "zero"
    ]
    private static let commonTechnicalTopLevelDomains: Set<String> = [
        "app", "ai", "au", "ca", "cloud", "cn", "co", "com", "de", "dev", "edu", "fr",
        "gov", "io", "jp", "me", "net", "online", "org", "site", "tech", "top", "uk",
        "us", "xyz"
    ]
}
