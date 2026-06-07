import AppKit
import SwiftUI

enum TranslationPanelStatus {
    case loading
    case success
    case unchanged
    case warning
    case error

    var title: String {
        switch self {
        case .loading:
            return "正在处理"
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

@MainActor
final class TranslationPanelController {
    private let model = TranslationPanelModel()
    private let settingsStore: SettingsStore
    private let historyStore: TranslationHistoryStore
    private let onRetry: (String) -> Void
    private let onShowHistory: () -> Void
    private var panel: NSPanel?
    private var autoHideTask: Task<Void, Never>?
    private var elapsedTask: Task<Void, Never>?
    private var loadingStartedAt: Date?

    init(
        settingsStore: SettingsStore,
        historyStore: TranslationHistoryStore,
        onRetry: @escaping (String) -> Void,
        onShowHistory: @escaping () -> Void
    ) {
        self.settingsStore = settingsStore
        self.historyStore = historyStore
        self.onRetry = onRetry
        self.onShowHistory = onShowHistory
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
        targetLanguage: String? = nil
    ) {
        let panel = panel ?? makePanel()
        self.panel = panel

        model.original = original
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
        model.isFavorite = historyStore.isFavorite(original: original, translation: translation)
        if isLoading {
            model.notice = ""
        }

        DiagnosticLogger.log("translation.panel.show status=\(model.status.title) isLoading=\(isLoading) originalLength=\(original.count) translationLength=\(translation.count)")

        updateElapsedState(isLoading: isLoading, elapsed: elapsed)
        position(panel)
        panel.orderFrontRegardless()
        scheduleAutoHideIfNeeded()
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
            loadingStartedAt = startedAt
            model.elapsedText = "0.0s"
            elapsedTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 120_000_000)
                    await MainActor.run {
                        guard let self, self.model.isLoading else { return }
                        self.model.elapsedText = Self.formatElapsed(Date().timeIntervalSince(startedAt))
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
        guard !model.isLoading else { return }
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

    private func scheduleAutoHideIfNeeded() {
        autoHideTask?.cancel()
        guard model.autoHideEnabled,
              !model.isPinned,
              !model.isLoading,
              !model.translationTrimmed.isEmpty else {
            return
        }

        autoHideTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000_000)
            await MainActor.run {
                guard let self,
                      self.model.autoHideEnabled,
                      !self.model.isPinned,
                      !self.model.isLoading else {
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
    @Published var original = ""
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
    @Published var targetLanguage = ""
    @Published var elapsedText = ""
    @Published var showOriginal = false
}

struct TranslationPanelView: View {
    @ObservedObject var model: TranslationPanelModel
    let onRetry: () -> Void
    let onPinChanged: () -> Void
    let onAutoHideChanged: () -> Void
    let onToggleFavorite: () -> Void
    let onShowHistory: () -> Void
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
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: model.status.systemImage)
                    .symbolRenderingMode(.hierarchical)
                Text(model.status.title)
                    .fontWeight(.semibold)
                if model.isLoading {
                    ProgressView()
                        .scaleEffect(0.58)
                        .frame(width: 14, height: 14)
                }
            }
            .font(.caption)
            .foregroundStyle(model.status.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(model.status.color.opacity(0.13), in: Capsule())

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
                model.notice = model.autoHideEnabled ? "16 秒后自动隐藏" : "已关闭自动隐藏"
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

    private var primaryContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(model.statusMessage)
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

    private var actions: some View {
        HStack(spacing: 8) {
            actionButton("复制译文", systemName: "doc.on.doc", prominent: true, disabled: model.translationTrimmed.isEmpty || model.isLoading) {
                copyToPasteboard(model.translationTrimmed, notice: "已复制译文")
            }
            actionButton("重新翻译", systemName: "arrow.clockwise", disabled: model.isLoading || model.originalTrimmed.isEmpty) {
                onRetry()
            }
            actionButton(model.isFavorite ? "已收藏" : "收藏", systemName: model.isFavorite ? "star.fill" : "star", disabled: model.isLoading || model.translationTrimmed.isEmpty) {
                onToggleFavorite()
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
            .help("复制原文")
            .disabled(model.originalTrimmed.isEmpty)
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

    private func hintLine(systemName: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: systemName)
                .foregroundStyle(.secondary)
            Text(text)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
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

    var translationTrimmed: String {
        translation.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var primaryText: String {
        if isLoading {
            return translationTrimmed.isEmpty ? statusMessage : translationTrimmed
        }
        return translationTrimmed.isEmpty ? statusMessage : translationTrimmed
    }
}
