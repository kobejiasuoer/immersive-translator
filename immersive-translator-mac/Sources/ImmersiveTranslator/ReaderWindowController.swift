import AppKit
import SwiftUI

/// 沉浸阅读室窗口（1200×800，最小 960×620）。
/// 负责窗口生命周期与阅读器内的键盘快捷键（Space/J/K/L/H，
/// 输入框聚焦时不劫持）。
@MainActor
final class ReaderWindowController: NSWindowController {
    private let viewModel: ReaderViewModel
    private var didBootstrap = false
    private var keyDownMonitor: Any?
    private var keyUpMonitor: Any?

    init(settingsStore: SettingsStore) {
        let viewModel = ReaderViewModel(settingsStore: settingsStore)
        self.viewModel = viewModel

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "沉浸阅读室"
        window.contentMinSize = NSSize(width: 960, height: 620)
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = NSHostingView(rootView: ReaderRootView(vm: viewModel))
        // 阅读计时活跃判定要用 isKeyWindow，把窗口挂给 VM。
        viewModel.attachedWindow = window
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// 打开/聚焦阅读室。pendingImportText 非空时导入该文本（热键路径）；
    /// openBookId 非空时直达书级断点章（提醒卡「继续阅读」路径）。
    func show(pendingImportText: String? = nil, openReview: Bool = false, openBookId: String? = nil) {
        guard let window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if !didBootstrap || pendingImportText != nil || openReview || openBookId != nil {
            if !didBootstrap {
                didBootstrap = true
                viewModel.bootstrap(pendingImportText: pendingImportText, openReview: openReview, openBookId: openBookId)
            } else if let text = pendingImportText {
                viewModel.importPaste(text)
            } else if openReview {
                viewModel.openReview()
            } else if let bookId = openBookId {
                viewModel.openBookAt(bookId: bookId)
            }
        }
        installKeyMonitors()
    }

    func applicationWillClose(_ notification: Notification) {
        removeKeyMonitors()
    }

    // MARK: - 键盘快捷键（仅窗口为 key window 时）

    private func installKeyMonitors() {
        guard keyDownMonitor == nil else { return }
        keyDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window else { return event }
            // 输入框/文本编辑区聚焦时不劫持按键
            if let responder = self.window?.firstResponder, responder is NSTextView || responder is NSTextField {
                return event
            }
            let handled = self.viewModel.handleKeyDown(event)
            return handled ? nil : event
        }
        keyUpMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyUp) { [weak self] event in
            guard let self, event.window === self.window else { return event }
            self.viewModel.handleKeyUp(event)
            return event
        }
    }

    private func removeKeyMonitors() {
        if let keyDownMonitor {
            NSEvent.removeMonitor(keyDownMonitor)
            self.keyDownMonitor = nil
        }
        if let keyUpMonitor {
            NSEvent.removeMonitor(keyUpMonitor)
            self.keyUpMonitor = nil
        }
    }
}
