import ApplicationServices
import XCTest
@testable import ImmersiveTranslator

/// 取词 ② AX 兜底的防御式类型转换（ClipboardReader.swift readSelectedTextViaAccessibility）：
/// 焦点元素属性值必须真是 AXUIElement 才往下读选区，否则返回 nil、由调用方走 `.copyFailed`，
/// 绝不崩溃也不把错类型喂给 AX API（行为基线：Windows uia.rs 逐步 `if let Ok` / `map_err` 降级）。
/// 只构造 AX 引用、不读取任何属性，不需要辅助功能授权。
final class ClipboardReaderAXFallbackTests: XCTestCase {

    func testMissingFocusedValueYieldsNil() {
        XCTAssertNil(SelectedTextReader.axUIElement(from: nil))
    }

    /// 旧写法（强制转型到 `AXUIElement?`）对 CF 类型不做运行时校验：
    /// 非 AXUIElement 的值会被原样当 AXUIElement 往下传。现在必须被拦成 nil。
    func testNonAXValueYieldsNilInsteadOfUncheckedCast() {
        XCTAssertNil(SelectedTextReader.axUIElement(from: "选中文本" as CFString))
        XCTAssertNil(SelectedTextReader.axUIElement(from: NSNumber(value: 42) as CFNumber))
        XCTAssertNil(SelectedTextReader.axUIElement(from: kCFBooleanTrue))
        XCTAssertNil(SelectedTextReader.axUIElement(from: [AnyObject]() as CFArray))
    }

    func testRealAXElementPassesThroughUnchanged() {
        let systemWide = AXUIElementCreateSystemWide()
        let converted = SelectedTextReader.axUIElement(from: systemWide)
        XCTAssertNotNil(converted)
        XCTAssertTrue(converted === systemWide, "同一个 AX 引用原样返回")

        let application = AXUIElementCreateApplication(getpid())
        XCTAssertTrue(SelectedTextReader.axUIElement(from: application) === application)
    }
}
