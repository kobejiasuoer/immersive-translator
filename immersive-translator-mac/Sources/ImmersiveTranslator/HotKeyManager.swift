import Carbon
import AppKit
import Foundation

enum HotKeyAction {
    case translateSelection
    case translateScreenshot
    case openReader
}

struct HotKeyShortcut: Equatable, Hashable, RawRepresentable {
    enum AdvisorySeverity: Int, Comparable {
        case caution = 1
        case highRisk = 2

        static func < (lhs: AdvisorySeverity, rhs: AdvisorySeverity) -> Bool {
            lhs.rawValue < rhs.rawValue
        }
    }

    private enum AdvisoryKind {
        case commandControlSpace
        case commandSpace
        case controlSpace
        case controlOptionSpace
        case appSwitcher
        case windowSwitcher
        case screenshot
        case commandClipboardOrEdit
        case commandWindowOrAppLifecycle
        case commandDocumentOrBrowser
        case controlArrowNavigation
        case controlF2
        case commandOnly
        case controlOnly

        var severity: AdvisorySeverity {
            switch self {
            case .commandControlSpace,
                 .commandSpace,
                 .appSwitcher,
                 .windowSwitcher,
                 .screenshot,
                 .commandClipboardOrEdit,
                 .commandWindowOrAppLifecycle,
                 .commandDocumentOrBrowser,
                 .controlArrowNavigation:
                return .highRisk
            case .controlSpace,
                 .controlOptionSpace,
                 .controlF2,
                 .commandOnly,
                 .controlOnly:
                return .caution
            }
        }
    }

    let keyCode: UInt32
    let modifiers: UInt32
    let keyLabel: String

    init(keyCode: UInt32, modifiers: UInt32, keyLabel: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.keyLabel = keyLabel
    }

    init?(rawValue: String) {
        let parts = rawValue.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let keyCode = UInt32(parts[0]),
              let modifiers = UInt32(parts[1]),
              !parts[2].isEmpty else {
            return nil
        }
        guard Self.isUsableGlobalShortcut(keyCode: keyCode, modifiers: modifiers) else {
            return nil
        }
        self.keyCode = keyCode
        self.modifiers = modifiers
        keyLabel = String(parts[2]).removingPercentEncoding ?? String(parts[2])
    }

    init?(event: NSEvent) {
        guard event.keyCode != UInt16(kVK_Escape) else { return nil }
        let modifiers = Self.carbonModifiers(from: event.modifierFlags)
        guard Self.isUsableGlobalShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers) else { return nil }

        let label = Self.keyLabel(
            keyCode: UInt32(event.keyCode),
            fallback: event.charactersIgnoringModifiers
        )
        guard !label.isEmpty else { return nil }
        self.init(keyCode: UInt32(event.keyCode), modifiers: modifiers, keyLabel: label)
    }

    var rawValue: String {
        let escapedLabel = keyLabel.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? keyLabel
        return "\(keyCode)|\(modifiers)|\(escapedLabel)"
    }

    var title: String {
        (modifierLabels + [keyLabel]).joined(separator: " + ")
    }

    /// 菜单原生快捷键显示：keyEquivalent 字符 + 修饰键掩码（NSMenuItem.keyEquivalent /
    /// keyEquivalentModifierMask 直填，右对齐、菜单等宽字形渲染）。不可映射的 keyLabel
    /// 返回 nil，调用方回落「标题内嵌 hint」。
    /// 仅作菜单内显示/触发；全局热键仍由 Carbon RegisterEventHotKey 负责，二者互不替代。
    func menuKeyEquivalent() -> (character: String, modifiers: NSEvent.ModifierFlags)? {
        guard let character = Self.menuKeyCharacter(for: keyLabel) else { return nil }
        var flags: NSEvent.ModifierFlags = []
        // Carbon 修饰键位（与 modifierLabels 的读取位一致）→ NSEvent 掩码。
        if modifiers & UInt32(cmdKey) != 0 {
            flags.insert(.command)
        }
        if modifiers & UInt32(controlKey) != 0 {
            flags.insert(.control)
        }
        if modifiers & UInt32(optionKey) != 0 {
            flags.insert(.option)
        }
        if modifiers & UInt32(shiftKey) != 0 {
            flags.insert(.shift)
        }
        return (character, flags)
    }

    /// keyLabel → NSMenuItem.keyEquivalent 字符：
    /// - 单字母/数字（大小写不敏感；录制时已 uppercased，见 keyLabel(keyCode:fallback:)）
    ///   → 小写字符（大写会让 AppKit 隐式补 ⇧ 渲染）；
    /// - 命名键 → AppKit 功能键 Unicode 标量（NSF1FunctionKey 0xF704 起、方向键 0xF700-0xF703、
    ///   Forward Delete 0xF728 等，与规格 tray.md §2.1-3 映射表一致）；
    /// - 其余（多词非功能键 label 等）→ nil。
    private static func menuKeyCharacter(for keyLabel: String) -> String? {
        switch keyLabel {
        case "Space":
            return " "
        case "Return":
            return "\r"
        case "Tab":
            return "\t"
        // kVK_Delete 是退格键；菜单 keyEquivalent 惯例用 0x7F（NSDeleteCharacter）。
        case "Delete":
            return "\u{7F}"
        case "Forward Delete":
            return Self.functionKeyCharacter(NSDeleteFunctionKey)
        case "Left Arrow":
            return Self.functionKeyCharacter(NSLeftArrowFunctionKey)
        case "Right Arrow":
            return Self.functionKeyCharacter(NSRightArrowFunctionKey)
        case "Up Arrow":
            return Self.functionKeyCharacter(NSUpArrowFunctionKey)
        case "Down Arrow":
            return Self.functionKeyCharacter(NSDownArrowFunctionKey)
        default:
            // F1~F12（含两位数的 F10-F12）→ NSF1FunctionKey(0xF704) + n-1 的连续功能键标量。
            if keyLabel.hasPrefix("F"),
               let index = Int(keyLabel.dropFirst()), (1...12).contains(index) {
                return Self.functionKeyCharacter(NSF1FunctionKey + index - 1)
            }
            guard keyLabel.count == 1 else { return nil }
            let lowered = keyLabel.lowercased()
            guard let scalar = lowered.unicodeScalars.first, scalar.isASCII,
                  (48...57).contains(scalar.value) || (97...122).contains(scalar.value) else {
                return nil
            }
            return lowered
        }
    }

    /// AppKit 功能键 Int 常量 → 单字符字符串（常量恒在 Unicode BMP 内，越界只可能
    /// 来自调用方传错，返回 nil 兜底）。
    private static func functionKeyCharacter(_ code: Int) -> String? {
        guard let scalar = UnicodeScalar(code) else { return nil }
        return String(scalar)
    }

    static let optionSpace = HotKeyShortcut(
        keyCode: UInt32(kVK_Space),
        modifiers: UInt32(optionKey),
        keyLabel: "Space"
    )

    static let controlOptionSpace = HotKeyShortcut(
        keyCode: UInt32(kVK_Space),
        modifiers: UInt32(controlKey | optionKey),
        keyLabel: "Space"
    )

    /// 阅读室热键默认：⌃⌥R（对齐 Windows Ctrl+Shift+R 的语义，用 Mac 惯用修饰键）。
    static let controlOptionR = HotKeyShortcut(
        keyCode: UInt32(kVK_ANSI_R),
        modifiers: UInt32(controlKey | optionKey),
        keyLabel: "R"
    )

    static let recommendedAlternatives: [HotKeyShortcut] = [
        .optionSpace,
        .controlOptionSpace,
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(controlKey | optionKey), keyLabel: "T"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_O), modifiers: UInt32(controlKey | optionKey), keyLabel: "O"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_G), modifiers: UInt32(controlKey | optionKey), keyLabel: "G"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_E), modifiers: UInt32(controlKey | optionKey), keyLabel: "E"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_R), modifiers: UInt32(controlKey | optionKey), keyLabel: "R"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(controlKey | optionKey | shiftKey), keyLabel: "T"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_O), modifiers: UInt32(controlKey | optionKey | shiftKey), keyLabel: "O"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(cmdKey | optionKey), keyLabel: "T"),
        HotKeyShortcut(keyCode: UInt32(kVK_ANSI_O), modifiers: UInt32(cmdKey | optionKey), keyLabel: "O"),
        HotKeyShortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | optionKey), keyLabel: "Space")
    ]

    static func suggestionText(excluding shortcuts: [HotKeyShortcut], limit: Int = 2) -> String {
        let excludedShortcuts = Set(shortcuts)
        let candidates = recommendationCandidates(excluding: excludedShortcuts)
        let suggestions = candidates
            .map(\.title)
            .prefix(limit)

        let text = suggestions.joined(separator: " 或 ")
        return text.isEmpty ? "其它带 Control/Option 的字母键" : text
    }

    var advisorySeverity: AdvisorySeverity? {
        advisoryKind?.severity
    }

    func advisoryMessage(suggestion: String) -> String? {
        guard let advisoryKind else { return nil }

        switch advisoryKind {
        case .commandControlSpace:
            return "\(title) 常被表情与符号面板或输入法增强功能占用；如果录制后没反应，建议换成 \(suggestion)。"
        case .commandSpace:
            return "\(title) 常被 Spotlight、Finder 搜索或输入法占用；如果注册失败，建议换成 \(suggestion)。"
        case .controlSpace:
            return "\(title) 常被输入法/切换输入源占用；如果按下后没有反应，建议换成 \(suggestion)。"
        case .controlOptionSpace:
            return "\(title) 可能被 macOS 输入源“选择下一个输入源”占用；如果 OCR 快捷键偶尔没反应，建议换成 \(suggestion)。"
        case .appSwitcher:
            return "\(title) 是 macOS App 切换器的常用组合，通常不适合作为全局翻译快捷键。建议换成 \(suggestion)。"
        case .windowSwitcher:
            return "\(title) 常用于同一 App 内窗口切换，容易和浏览器、终端或编辑器冲突。建议换成 \(suggestion)。"
        case .screenshot:
            return "\(title) 接近 macOS 截图快捷键，容易和系统截图或截图 OCR 习惯混淆。建议换成 \(suggestion)。"
        case .commandClipboardOrEdit:
            return "\(title) 是复制、粘贴、撤销、全选等常见编辑快捷键，作为全局热键容易抢走当前 App 的文本操作。建议换成 \(suggestion)。"
        case .commandWindowOrAppLifecycle:
            return "\(title) 常用于关闭窗口、退出、隐藏或最小化 App，作为全局热键很容易误触发系统级操作。建议换成 \(suggestion)。"
        case .commandDocumentOrBrowser:
            return "\(title) 常用于设置、取消、帮助、保存、搜索、地址栏/定位栏、刷新、打印、新建或打开文件/页面、新建标签页、书签、前进/后退、查找下一项、链接、文字格式或缩放，容易和浏览器、编辑器、文档 App 冲突。建议换成 \(suggestion)。"
        case .controlArrowNavigation:
            return "\(title) 常被 Mission Control、调度中心或桌面空间切换占用；录制后可能保存成功但后台触发不稳定。建议换成 \(suggestion)。"
        case .controlF2:
            return "\(title) 可能和键盘导航菜单栏冲突；如果按下后没有反应，建议换成 \(suggestion)。"
        case .commandOnly:
            return "只使用 Command 的全局快捷键更容易和 App 菜单快捷键冲突；建议换成 \(suggestion)。"
        case .controlOnly:
            return "只使用 Control 的组合可能被输入法、终端或系统功能占用；如果注册失败，建议换成 \(suggestion)。"
        }
    }

    private static func recommendationCandidates(excluding excludedShortcuts: Set<HotKeyShortcut>) -> [HotKeyShortcut] {
        let available = recommendedAlternatives.filter { candidate in
            !excludedShortcuts.contains(candidate)
        }
        let lowRisk = available.filter { $0.advisorySeverity == nil }
        if !lowRisk.isEmpty {
            return lowRisk
        }

        let cautionOnly = available.filter { $0.advisorySeverity != .highRisk }
        return cautionOnly.isEmpty ? available : cautionOnly
    }

    private var modifierLabels: [String] {
        var labels: [String] = []
        if modifiers & UInt32(cmdKey) != 0 {
            labels.append("Command")
        }
        if modifiers & UInt32(controlKey) != 0 {
            labels.append("Control")
        }
        if modifiers & UInt32(optionKey) != 0 {
            labels.append("Option")
        }
        if modifiers & UInt32(shiftKey) != 0 {
            labels.append("Shift")
        }
        return labels
    }

    private static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        let flags = flags.intersection(.deviceIndependentFlagsMask)
        var modifiers: UInt32 = 0
        if flags.contains(.command) {
            modifiers |= UInt32(cmdKey)
        }
        if flags.contains(.control) {
            modifiers |= UInt32(controlKey)
        }
        if flags.contains(.option) {
            modifiers |= UInt32(optionKey)
        }
        if flags.contains(.shift) {
            modifiers |= UInt32(shiftKey)
        }
        return modifiers
    }

    private static func isUsableGlobalShortcut(keyCode: UInt32, modifiers: UInt32) -> Bool {
        guard keyCode != UInt32(kVK_Escape) else { return false }
        let supportedModifiers = UInt32(cmdKey | controlKey | optionKey | shiftKey)
        guard modifiers & ~supportedModifiers == 0 else { return false }
        return modifiers & UInt32(cmdKey | controlKey | optionKey) != 0
    }

    private var advisoryKind: AdvisoryKind? {
        let usesCommand = modifiers & UInt32(cmdKey) != 0
        let usesControl = modifiers & UInt32(controlKey) != 0
        let usesOption = modifiers & UInt32(optionKey) != 0
        let usesShift = modifiers & UInt32(shiftKey) != 0
        let coreModifierCount = [usesCommand, usesControl, usesOption].filter(\.self).count
        let isScreenshotKey = [
            UInt32(kVK_ANSI_3),
            UInt32(kVK_ANSI_4),
            UInt32(kVK_ANSI_5)
        ].contains(keyCode)
        let isCommandClipboardOrEditKey = [
            UInt32(kVK_ANSI_C),
            UInt32(kVK_ANSI_V),
            UInt32(kVK_ANSI_X),
            UInt32(kVK_ANSI_A),
            UInt32(kVK_ANSI_Z)
        ].contains(keyCode)
        let isCommandWindowOrAppLifecycleKey = [
            UInt32(kVK_ANSI_W),
            UInt32(kVK_ANSI_Q),
            UInt32(kVK_ANSI_H),
            UInt32(kVK_ANSI_M)
        ].contains(keyCode)
        let isCommandDocumentOrBrowserKey = [
            UInt32(kVK_ANSI_F),
            UInt32(kVK_ANSI_E),
            UInt32(kVK_ANSI_L),
            UInt32(kVK_ANSI_S),
            UInt32(kVK_ANSI_R),
            UInt32(kVK_ANSI_P),
            UInt32(kVK_ANSI_N),
            UInt32(kVK_ANSI_O),
            UInt32(kVK_ANSI_T),
            UInt32(kVK_ANSI_D),
            UInt32(kVK_ANSI_G),
            UInt32(kVK_ANSI_K),
            UInt32(kVK_ANSI_B),
            UInt32(kVK_ANSI_I),
            UInt32(kVK_ANSI_U),
            UInt32(kVK_ANSI_Y),
            UInt32(kVK_ANSI_Comma),
            UInt32(kVK_ANSI_Period),
            UInt32(kVK_ANSI_Slash),
            UInt32(kVK_ANSI_LeftBracket),
            UInt32(kVK_ANSI_RightBracket),
            UInt32(kVK_ANSI_Minus),
            UInt32(kVK_ANSI_Equal),
            UInt32(kVK_ANSI_0)
        ].contains(keyCode)
        let isArrowKey = [
            UInt32(kVK_LeftArrow),
            UInt32(kVK_RightArrow),
            UInt32(kVK_UpArrow),
            UInt32(kVK_DownArrow)
        ].contains(keyCode)

        if usesCommand, usesControl, keyCode == UInt32(kVK_Space) {
            return .commandControlSpace
        }

        if keyCode == UInt32(kVK_Space) {
            if usesCommand {
                return .commandSpace
            }
            if usesControl, !usesOption {
                return .controlSpace
            }
            if usesControl, usesOption {
                return .controlOptionSpace
            }
        }

        if usesCommand, keyCode == UInt32(kVK_Tab) {
            return .appSwitcher
        }

        if usesCommand, keyCode == UInt32(kVK_ANSI_Grave) {
            return .windowSwitcher
        }

        if usesCommand, usesShift, isScreenshotKey {
            return .screenshot
        }

        if usesCommand, isCommandClipboardOrEditKey {
            return .commandClipboardOrEdit
        }

        if usesCommand, isCommandWindowOrAppLifecycleKey {
            return .commandWindowOrAppLifecycle
        }

        if usesCommand, isCommandDocumentOrBrowserKey {
            return .commandDocumentOrBrowser
        }

        if usesControl, !usesCommand, !usesOption, isArrowKey {
            return .controlArrowNavigation
        }

        if usesControl, keyCode == UInt32(kVK_F2) {
            return .controlF2
        }

        if coreModifierCount == 1, usesCommand {
            return .commandOnly
        }

        if coreModifierCount == 1, usesControl, !usesShift {
            return .controlOnly
        }

        return nil
    }

    private static func keyLabel(keyCode: UInt32, fallback: String?) -> String {
        if let known = knownKeyLabels[keyCode] {
            return known
        }
        let cleanFallback = fallback?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased() ?? ""
        return cleanFallback
    }

    private static let knownKeyLabels: [UInt32: String] = [
        UInt32(kVK_Space): "Space",
        UInt32(kVK_Return): "Return",
        UInt32(kVK_Tab): "Tab",
        UInt32(kVK_Delete): "Delete",
        UInt32(kVK_ForwardDelete): "Forward Delete",
        UInt32(kVK_Home): "Home",
        UInt32(kVK_End): "End",
        UInt32(kVK_PageUp): "Page Up",
        UInt32(kVK_PageDown): "Page Down",
        UInt32(kVK_LeftArrow): "Left Arrow",
        UInt32(kVK_RightArrow): "Right Arrow",
        UInt32(kVK_UpArrow): "Up Arrow",
        UInt32(kVK_DownArrow): "Down Arrow",
        UInt32(kVK_F1): "F1",
        UInt32(kVK_F2): "F2",
        UInt32(kVK_F3): "F3",
        UInt32(kVK_F4): "F4",
        UInt32(kVK_F5): "F5",
        UInt32(kVK_F6): "F6",
        UInt32(kVK_F7): "F7",
        UInt32(kVK_F8): "F8",
        UInt32(kVK_F9): "F9",
        UInt32(kVK_F10): "F10",
        UInt32(kVK_F11): "F11",
        UInt32(kVK_F12): "F12"
    ]
}

struct HotKeyRegistrationReport {
    let warnings: [String]

    var message: String {
        warnings.joined(separator: "\n")
    }
}

final class HotKeyManager {
    private let handler: (HotKeyAction) -> Void
    private var eventHandler: EventHandlerRef?
    private var translateSelectionRef: EventHotKeyRef?
    private var translateScreenshotRef: EventHotKeyRef?
    private var openReaderRef: EventHotKeyRef?
    private let signature = fourCharCode("imtr")

    init(handler: @escaping (HotKeyAction) -> Void) {
        self.handler = handler
    }

    deinit {
        if let translateSelectionRef {
            UnregisterEventHotKey(translateSelectionRef)
        }
        if let translateScreenshotRef {
            UnregisterEventHotKey(translateScreenshotRef)
        }
        if let openReaderRef {
            UnregisterEventHotKey(openReaderRef)
        }
        if let eventHandler {
            RemoveEventHandler(eventHandler)
        }
    }

    /// 录制态挂起（settings-ui-1）：临时注销全部全局热键，把组合键还给普通
    /// keyDown 链——RegisterEventHotKey 的组合会被系统在 NSResponder keyDown
    /// 之前消费并回调 handler，录制中的 HotKeyRecorderView 永远收不到这些键，
    /// 对应功能反而被真实触发。事件监听器保留（重注册无需重装）；恢复统一走
    /// register() 按当前设置整组重注册。
    func suspendForRecording() {
        unregisterHotKeys()
    }

    func register(
        selectionShortcut: HotKeyShortcut = .optionSpace,
        ocrShortcut: HotKeyShortcut = .controlOptionSpace,
        readerShortcut: HotKeyShortcut? = nil
    ) -> HotKeyRegistrationReport {
        unregisterHotKeys()
        var warnings: [String] = []

        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        if eventHandler == nil {
            let status = InstallEventHandler(
                GetApplicationEventTarget(),
                { _, event, userData in
                    guard let event, let userData else { return noErr }
                    let manager = Unmanaged<HotKeyManager>.fromOpaque(userData).takeUnretainedValue()

                    var hotKeyID = EventHotKeyID()
                    GetEventParameter(
                        event,
                        EventParamName(kEventParamDirectObject),
                        EventParamType(typeEventHotKeyID),
                        nil,
                        MemoryLayout<EventHotKeyID>.size,
                        nil,
                        &hotKeyID
                    )

                    switch hotKeyID.id {
                    case 1:
                        manager.handler(.translateSelection)
                    case 2:
                        manager.handler(.translateScreenshot)
                    case 3:
                        manager.handler(.openReader)
                    default:
                        break
                    }
                    return noErr
                },
                1,
                &spec,
                Unmanaged.passUnretained(self).toOpaque(),
                &eventHandler
            )
            if status != noErr {
                warnings.append("快捷键监听器安装失败（状态 \(status)）。请重启 App 后再试。")
                return HotKeyRegistrationReport(warnings: warnings)
            }
        }

        // 三键查重前移到任何 RegisterEventHotKey 之前（settings-ui-2）：原实现先
        // 注册翻译键、查重不过即整体早退，OCR↔阅读室重复时该组合一个都注册不上
        //（与设置页「只会有一个功能能注册」文案相反），无冲突键也被一并跳过。
        // 现按真实冲突范围处置：重复组合整组跳过、其余键照常注册并如实回报。
        let candidates: [(shortcut: HotKeyShortcut, title: String)] = [
            (selectionShortcut, "选中文本翻译"),
            (ocrShortcut, "截图 OCR 翻译"),
            (readerShortcut ?? .controlOptionR, "沉浸阅读室")
        ]
        let duplicatedShortcuts = Set(candidates.map { $0.shortcut }.filter { shortcut in
            candidates.filter { $0.shortcut == shortcut }.count > 1
        })
        if !duplicatedShortcuts.isEmpty {
            let skipped = candidates.filter { duplicatedShortcuts.contains($0.shortcut) }
            warnings.append(Self.duplicateRegistrationMessage(skipped: skipped))
        }

        if !duplicatedShortcuts.contains(selectionShortcut) {
            let selectionID = EventHotKeyID(signature: signature, id: 1)
            let selectionStatus = RegisterEventHotKey(
                selectionShortcut.keyCode,
                selectionShortcut.modifiers,
                selectionID,
                GetApplicationEventTarget(),
                0,
                &translateSelectionRef
            )
            if selectionStatus != noErr {
                warnings.append(
                    registrationFailureMessage(
                        actionTitle: "选中文本翻译",
                        shortcut: selectionShortcut,
                        status: selectionStatus,
                        otherShortcut: ocrShortcut
                    )
                )
            }
        }

        if !duplicatedShortcuts.contains(ocrShortcut) {
            let screenshotID = EventHotKeyID(signature: signature, id: 2)
            let screenshotStatus = RegisterEventHotKey(
                ocrShortcut.keyCode,
                ocrShortcut.modifiers,
                screenshotID,
                GetApplicationEventTarget(),
                0,
                &translateScreenshotRef
            )
            if screenshotStatus != noErr {
                warnings.append(
                    registrationFailureMessage(
                        actionTitle: "截图 OCR 翻译",
                        shortcut: ocrShortcut,
                        status: screenshotStatus,
                        otherShortcut: selectionShortcut
                    )
                )
            }
        }

        if let readerShortcut, !duplicatedShortcuts.contains(readerShortcut) {
            let readerID = EventHotKeyID(signature: signature, id: 3)
            let readerStatus = RegisterEventHotKey(
                readerShortcut.keyCode,
                readerShortcut.modifiers,
                readerID,
                GetApplicationEventTarget(),
                0,
                &openReaderRef
            )
            if readerStatus != noErr {
                warnings.append(
                    registrationFailureMessage(
                        actionTitle: "沉浸阅读室",
                        shortcut: readerShortcut,
                        status: readerStatus,
                        otherShortcut: selectionShortcut
                    )
                )
            }
        }

        return HotKeyRegistrationReport(warnings: warnings)
    }

    /// 重复组合的如实提示（settings-ui-2）：重复的键本次都不注册，不再声称
    /// 「只会有一个功能能注册成全局热键」。
    private static func duplicateRegistrationMessage(skipped: [(shortcut: HotKeyShortcut, title: String)]) -> String {
        let titles = skipped.map { $0.title }
        let names: String
        switch titles.count {
        case 2:
            names = "\(titles[0])和\(titles[1])"
        case 3:
            names = "\(titles[0])、\(titles[1])和\(titles[2])"
        default:
            names = titles.joined(separator: "、")
        }
        let suggestion = HotKeyShortcut.suggestionText(excluding: skipped.map(\.shortcut))
        return "\(names)使用了同一个快捷键 \(skipped[0].shortcut.title)，本次都未注册为全局热键。请为其中一个功能录制不同组合，建议试试 \(suggestion)。"
    }

    private func registrationFailureMessage(
        actionTitle: String,
        shortcut: HotKeyShortcut,
        status: OSStatus,
        otherShortcut: HotKeyShortcut
    ) -> String {
        let suggestions = HotKeyShortcut.suggestionText(excluding: [shortcut, otherShortcut])
        let reason = registrationFailureReason(for: status)
        return "\(actionTitle)快捷键 \(shortcut.title) 已录制，但没有注册成全局热键（\(reason)，状态 \(status)）。录制成功只表示组合已保存；要能在后台触发，需要 macOS 全局注册成功。建议试试 \(suggestions)。"
    }

    private func registrationFailureReason(for status: OSStatus) -> String {
        switch status {
        case OSStatus(eventHotKeyExistsErr):
            return "这个组合已被系统、输入法或其它 App 占用"
        case OSStatus(eventHotKeyInvalidErr):
            return "这个组合被系统判定为不可用"
        default:
            return "系统返回错误"
        }
    }

    private func unregisterHotKeys() {
        if let translateSelectionRef {
            UnregisterEventHotKey(translateSelectionRef)
            self.translateSelectionRef = nil
        }
        if let translateScreenshotRef {
            UnregisterEventHotKey(translateScreenshotRef)
            self.translateScreenshotRef = nil
        }
        if let openReaderRef {
            UnregisterEventHotKey(openReaderRef)
            self.openReaderRef = nil
        }
    }
}

private func fourCharCode(_ text: String) -> OSType {
    var result: OSType = 0
    for scalar in text.unicodeScalars.prefix(4) {
        result = (result << 8) + OSType(scalar.value)
    }
    return result
}
