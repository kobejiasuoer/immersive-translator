import Carbon
import Foundation

enum HotKeyAction {
    case translateSelection
    case translateScreenshot
}

enum SelectionHotKeyPreset: String, CaseIterable, Identifiable {
    case optionSpace
    case controlOptionT

    var id: String { rawValue }

    var title: String {
        switch self {
        case .optionSpace:
            return "Option + Space"
        case .controlOptionT:
            return "Control + Option + T"
        }
    }

    var keyCode: UInt32 {
        switch self {
        case .optionSpace:
            return UInt32(kVK_Space)
        case .controlOptionT:
            return UInt32(kVK_ANSI_T)
        }
    }

    var modifiers: UInt32 {
        switch self {
        case .optionSpace:
            return UInt32(optionKey)
        case .controlOptionT:
            return UInt32(controlKey | optionKey)
        }
    }
}

enum OCRHotKeyPreset: String, CaseIterable, Identifiable {
    case controlOptionSpace
    case controlOptionO

    var id: String { rawValue }

    var title: String {
        switch self {
        case .controlOptionSpace:
            return "Control + Option + Space"
        case .controlOptionO:
            return "Control + Option + O"
        }
    }

    var keyCode: UInt32 {
        switch self {
        case .controlOptionSpace:
            return UInt32(kVK_Space)
        case .controlOptionO:
            return UInt32(kVK_ANSI_O)
        }
    }

    var modifiers: UInt32 {
        UInt32(controlKey | optionKey)
    }
}

final class HotKeyManager {
    private let handler: (HotKeyAction) -> Void
    private var eventHandler: EventHandlerRef?
    private var translateSelectionRef: EventHotKeyRef?
    private var translateScreenshotRef: EventHotKeyRef?
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
        if let eventHandler {
            RemoveEventHandler(eventHandler)
        }
    }

    func register(selectionPreset: SelectionHotKeyPreset = .optionSpace, ocrPreset: OCRHotKeyPreset = .controlOptionSpace) {
        unregisterHotKeys()

        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        if eventHandler == nil {
            InstallEventHandler(
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
        }

        let selectionID = EventHotKeyID(signature: signature, id: 1)
        RegisterEventHotKey(
            selectionPreset.keyCode,
            selectionPreset.modifiers,
            selectionID,
            GetApplicationEventTarget(),
            0,
            &translateSelectionRef
        )

        let screenshotID = EventHotKeyID(signature: signature, id: 2)
        RegisterEventHotKey(
            ocrPreset.keyCode,
            ocrPreset.modifiers,
            screenshotID,
            GetApplicationEventTarget(),
            0,
            &translateScreenshotRef
        )
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
    }
}

private func fourCharCode(_ text: String) -> OSType {
    var result: OSType = 0
    for scalar in text.unicodeScalars.prefix(4) {
        result = (result << 8) + OSType(scalar.value)
    }
    return result
}
