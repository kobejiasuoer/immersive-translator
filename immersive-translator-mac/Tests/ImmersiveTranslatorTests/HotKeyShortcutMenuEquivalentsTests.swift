import AppKit
import Carbon
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 热键 → 菜单原生 keyEquivalent 映射测试（规格 tray.md §2.3-5/6/7）：
// 三个默认热键落原生渲染、不可映射 label 兜底 nil、Carbon 位 ↔ NSEvent 掩码
// 双向往返一致。全局热键注册不受影响（HotKeyManager Carbon 路径独立）。
// ---------------------------------------------------------------------------

final class HotKeyShortcutMenuEquivalentsTests: XCTestCase {
    /// §2.3-5：默认热键 ⌥Space / ⌃⌥Space / ⌃⌥R 的字符与修饰键掩码（HotKeyManager
    /// 三个 static 默认值，字母落小写避免 AppKit 隐式补 ⇧）。
    func test_defaultShortcutsMapToNativeKeyEquivalents() {
        let selection = HotKeyShortcut.optionSpace.menuKeyEquivalent()
        XCTAssertEqual(selection?.character, " ")
        XCTAssertEqual(selection?.modifiers, [.option])

        let ocr = HotKeyShortcut.controlOptionSpace.menuKeyEquivalent()
        XCTAssertEqual(ocr?.character, " ")
        XCTAssertEqual(ocr?.modifiers, [.control, .option])

        let reader = HotKeyShortcut.controlOptionR.menuKeyEquivalent()
        XCTAssertEqual(reader?.character, "r")
        XCTAssertEqual(reader?.modifiers, [.control, .option])
    }

    /// §2.3-6：不可映射的 keyLabel 返回 nil（回落「标题内嵌 hint」的路径存在）。
    func test_unmappableLabelReturnsNil() {
        XCTAssertNil(
            HotKeyShortcut(keyCode: 0, modifiers: UInt32(optionKey), keyLabel: "Unknown").menuKeyEquivalent()
        )
        // 多词非功能键 label（映射表白名单之外）同样 nil。
        XCTAssertNil(
            HotKeyShortcut(keyCode: 0, modifiers: UInt32(optionKey), keyLabel: "Page Up").menuKeyEquivalent()
        )
    }

    /// §2.3-7：修饰键双向映射——Carbon 位 → NSEvent 掩码 → 回写 Carbon 位往返一致
    /// （单修饰键逐一 + 四键全组合）。
    func test_modifierRoundTrip() {
        let pairs: [(UInt32, NSEvent.ModifierFlags, String)] = [
            (UInt32(cmdKey), .command, "cmdKey"),
            (UInt32(shiftKey), .shift, "shiftKey"),
            (UInt32(optionKey), .option, "optionKey"),
            (UInt32(controlKey), .control, "controlKey"),
        ]
        for (bit, flag, name) in pairs {
            let equivalent = HotKeyShortcut(keyCode: UInt32(kVK_ANSI_R), modifiers: bit, keyLabel: "R").menuKeyEquivalent()
            XCTAssertEqual(equivalent?.modifiers, flag, "\(name) 应只映射 \(flag)")
            XCTAssertEqual(Self.carbonBits(from: equivalent?.modifiers ?? []), bit, "\(flag) 应回写 \(name)")
        }

        let allBits = UInt32(cmdKey | shiftKey | optionKey | controlKey)
        let combined = HotKeyShortcut(keyCode: UInt32(kVK_ANSI_R), modifiers: allBits, keyLabel: "R").menuKeyEquivalent()
        XCTAssertEqual(combined?.modifiers, [.command, .shift, .option, .control])
        XCTAssertEqual(Self.carbonBits(from: combined?.modifiers ?? []), allBits)
    }

    /// 命名键映射抽查（规格 tray.md §2.1-3 映射表）：F 键标量、退格 0x7F、
    /// 方向键、Forward Delete 0xF728、单数字。
    func test_namedKeyLabelMapping() {
        func character(label: String, keyCode: UInt32) -> String? {
            HotKeyShortcut(keyCode: keyCode, modifiers: UInt32(controlKey), keyLabel: label)
                .menuKeyEquivalent()?.character
        }
        XCTAssertEqual(character(label: "F12", keyCode: UInt32(kVK_F12)), Self.functionKey(NSF12FunctionKey))
        XCTAssertEqual(character(label: "F1", keyCode: UInt32(kVK_F1)), Self.functionKey(NSF1FunctionKey))
        XCTAssertEqual(character(label: "Delete", keyCode: UInt32(kVK_Delete)), "\u{7F}")
        XCTAssertEqual(character(label: "Forward Delete", keyCode: UInt32(kVK_ForwardDelete)), Self.functionKey(NSDeleteFunctionKey))
        XCTAssertEqual(character(label: "Left Arrow", keyCode: UInt32(kVK_LeftArrow)), Self.functionKey(NSLeftArrowFunctionKey))
        XCTAssertEqual(character(label: "Up Arrow", keyCode: UInt32(kVK_UpArrow)), Self.functionKey(NSUpArrowFunctionKey))
        XCTAssertEqual(character(label: "Return", keyCode: UInt32(kVK_Return)), "\r")
        XCTAssertEqual(character(label: "Tab", keyCode: UInt32(kVK_Tab)), "\t")
        XCTAssertEqual(character(label: "5", keyCode: UInt32(kVK_ANSI_5)), "5")
        // 小写容错：录制侧已 uppercased，这里验证大小写不敏感仍落 "r"。
        XCTAssertEqual(character(label: "r", keyCode: UInt32(kVK_ANSI_R)), "r")
    }

    /// AppKit 功能键 Int 常量 → 字符（UnicodeScalar(Int) 是可失败初始化器；
    /// 测试只传已知 BMP 常量，越界返回空串使断言失败可见）。
    private static func functionKey(_ code: Int) -> String {
        guard let scalar = UnicodeScalar(code) else { return "" }
        return String(scalar)
    }

    /// Carbon 位 → NSEvent 掩码的回写方向（与 HotKeyShortcut.menuKeyEquivalent
    /// 的正向映射互为逆，位表 HotKeyManager.swift modifierLabels/carbonModifiers 同源）。
    private static func carbonBits(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var bits: UInt32 = 0
        if flags.contains(.command) { bits |= UInt32(cmdKey) }
        if flags.contains(.shift) { bits |= UInt32(shiftKey) }
        if flags.contains(.option) { bits |= UInt32(optionKey) }
        if flags.contains(.control) { bits |= UInt32(controlKey) }
        return bits
    }
}
