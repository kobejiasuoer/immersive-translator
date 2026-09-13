import AppKit
import ApplicationServices

enum SelectedTextReaderError: LocalizedError {
    case accessibilityNotTrusted
    case copyFailed

    var errorDescription: String? {
        switch self {
        case .accessibilityNotTrusted:
            return "还没有辅助功能权限，无法模拟 Command + C 读取当前选区。请在系统设置里允许本工具使用辅助功能，授权后重新触发翻译。"
        case .copyFailed:
            return "没有从当前 App 复制到文本。请确认当前窗口仍在前台、已经选中可复制文字；某些 App 的自定义文本区域可能不响应模拟 Command + C。"
        }
    }
}

/// 取词三级策略（对齐 Windows clipboard.rs / uia.rs）：
/// 1. 模拟 ⌘C 读剪贴板（主路径）；
/// 2. AXUIElement selectedText 直读兜底（目标 App 不理会合成按键时）；
/// 3. 等待用户手动 ⌘C（面板提示后监听剪贴板序列号，超时放弃）。
enum SelectedTextReader {
    @MainActor
    static func readSelectedText() async throws -> String {
        guard PermissionPrompter.isAccessibilityTrusted() else {
            throw SelectedTextReaderError.accessibilityNotTrusted
        }

        let pasteboard = NSPasteboard.general
        let snapshot = ClipboardSnapshot.capture(from: pasteboard)
        let originalChangeCount = pasteboard.changeCount

        pasteboard.clearContents()
        sendCopyShortcut()

        let deadline = Date().addingTimeInterval(0.8)
        var copiedText = ""
        while Date() < deadline {
            if pasteboard.changeCount != originalChangeCount,
               let text = pasteboard.string(forType: .string),
               !text.isEmpty {
                copiedText = text
                break
            }
            try? await Task.sleep(nanoseconds: 40_000_000)
        }

        if !copiedText.isEmpty {
            snapshot.restore(to: pasteboard)
            return copiedText
        }

        // ② AX 直读兜底：clearContents 之后剪贴板没有新内容，恢复快照再问 AX。
        snapshot.restore(to: pasteboard)
        if let axText = readSelectedTextViaAccessibility(), !axText.isEmpty {
            return axText
        }
        throw SelectedTextReaderError.copyFailed
    }

    /// ② AXUIElement 兜底：系统焦点元素的 kAXSelectedTextAttribute 直接读取。
    /// macOS 的 AX 覆盖比 Windows UIA 好（原生 App / Electron / Safari 均支持），
    /// 但终端、部分 Java/Electron 自绘区域可能拿不到 → 返回 nil。
    @MainActor
    static func readSelectedTextViaAccessibility() -> String? {
        guard PermissionPrompter.isAccessibilityTrusted() else { return nil }
        var focusedElement: CFTypeRef?
        let systemWide = AXUIElementCreateSystemWide()
        guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedElement) == .success,
              let element = focusedElement as! AXUIElement? else {
            return nil
        }
        var selectedText: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selectedText) == .success,
              let value = selectedText else {
            return nil
        }
        let text = value as? String ?? ""
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }

    /// ③ 等待用户手动 ⌘C：提示后监听剪贴板序列号，出现新文本即返回；
    /// 超时返回 nil（面板恢复原提示）。取消由 Task 取消实现。
    @MainActor
    static func waitForManualCopy(timeout: TimeInterval) async -> String? {
        let pasteboard = NSPasteboard.general
        let startChangeCount = pasteboard.changeCount
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Task.isCancelled { return nil }
            if pasteboard.changeCount != startChangeCount,
               let text = pasteboard.string(forType: .string),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return nil
    }

    private static func sendCopyShortcut() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyCode = CGKeyCode(8)

        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        keyDown?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)

        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        keyUp?.flags = .maskCommand
        keyUp?.post(tap: .cghidEventTap)
    }
}

private struct ClipboardSnapshot {
    private let items: [NSPasteboardItem]

    static func capture(from pasteboard: NSPasteboard) -> ClipboardSnapshot {
        let copiedItems = pasteboard.pasteboardItems?.map { item -> NSPasteboardItem in
            let clone = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    clone.setData(data, forType: type)
                } else if let string = item.string(forType: type) {
                    clone.setString(string, forType: type)
                }
            }
            return clone
        } ?? []
        return ClipboardSnapshot(items: copiedItems)
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        pasteboard.writeObjects(items)
    }
}
