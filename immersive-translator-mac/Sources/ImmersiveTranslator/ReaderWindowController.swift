import AppKit
import SwiftUI

/// 沉浸阅读室窗口（1200×800，最小 960×620）。
/// 负责窗口生命周期与阅读器内的键盘快捷键（Space/J/K/L/H，
/// 输入框聚焦时不劫持）。
///
/// 关窗契约（对齐 Windows ReaderApp.tsx:1218-1235 onCloseRequested）：点标题栏 ✕
/// = 先停朗读 / 收麦 / 取消在途评测，再隐藏窗口；窗口 isReleasedWhenClosed=false
/// 不销毁，文章、进度、光标位置原样保留，重开是纯 show()。此前 Mac 没有任何
/// willClose 观察者，关窗后 TTS/评测继续——「看不见了声音还在播」。
@MainActor
final class ReaderWindowController: NSWindowController, NSWindowDelegate {
    let viewModel: ReaderViewModel
    private var didBootstrap = false
    private var keyDownMonitor: Any?
    private var keyUpMonitor: Any?

    /// store 可注入（默认共享实例）：单测用临时目录，不碰用户的真实阅读数据。
    init(settingsStore: SettingsStore, store: ReaderStore = .shared) {
        let viewModel = ReaderViewModel(settingsStore: settingsStore, store: store)
        self.viewModel = viewModel

        // 窗口 chrome 一体化（M-01，对齐原型 .spatial-universe 全幅画布与
        // TranslationPanel 的既有做法）：fullSizeContentView + 透明标题条让纸感
        // 画布延伸到窗口顶缘，三胶囊与交通灯同处一条顶带（顶栏舞台左端在
        // ReaderTopStageView 里留出 ~78pt 交通灯位）。标题保留给 Mission
        // Control / 辅助功能，仅不再显示；拖拽改由背景拖动承担。
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "沉浸阅读室"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.contentMinSize = NSSize(width: 960, height: 620)
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = NSHostingView(rootView: ReaderRootView(vm: viewModel))
        // 阅读计时活跃判定要用 isKeyWindow，把窗口挂给 VM。
        viewModel.attachedWindow = window
        super.init(window: window)

        // ✕ / ⌘W / 任何 close()：windowWillClose 同步先停播收麦再隐藏
        //（NSWindow.close 对 isReleasedWhenClosed=false 的窗口只是 orderOut，状态全留）。
        window.delegate = self
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

    // MARK: - NSWindowDelegate

    /// 窗口即将关闭（隐藏）：停播收麦 + 卸掉按键监听（重开时 show() 会重新装）。
    /// 同步执行——声音在窗口消失的同一帧停下，不会「看不见了声音还在播」。
    func windowWillClose(_ notification: Notification) {
        handleWindowWillClose()
    }

    /// 关窗反应的唯一出口（delegate 与单测共用）。
    func handleWindowWillClose() {
        viewModel.handleWindowWillClose()
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
