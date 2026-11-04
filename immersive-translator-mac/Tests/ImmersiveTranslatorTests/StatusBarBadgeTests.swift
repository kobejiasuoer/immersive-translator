import AppKit
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 菜单栏复习角标测试（规格 tray.md §2.3，对齐 tray_badge.rs 既有测试语义）：
// due=0 无角标、正数出图、上限 999、跨端同色锚定；另覆盖托盘图标+胶囊合成。
// ---------------------------------------------------------------------------

final class StatusBarBadgeTests: XCTestCase {
    /// §2.3-1（对应 tray_badge.rs `due_zero_keeps_base`）：due = 0 → nil 无角标。
    func test_zeroDueReturnsNil() {
        XCTAssertNil(StatusBarBadge.badgeImage(due: 0))
        // 负数同归零态（防御性）。
        XCTAssertNil(StatusBarBadge.badgeImage(due: -3))
    }

    /// §2.3-2（对应 tray_badge.rs `due_draws_red_pixels`）：正数出非空位图。
    func test_positiveDueReturnsImage() throws {
        let image = try XCTUnwrap(StatusBarBadge.badgeImage(due: 6))
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertGreaterThan(image.size.height, 0)
        // 红底白字不随深浅色翻转（规格 §2.2：isTemplate = false）。
        XCTAssertFalse(image.isTemplate)
    }

    /// §2.3-3（tray_badge.rs:66-71）：>999 显示 999，正常数原样。
    func test_displayTextCapsAt999() {
        XCTAssertEqual(StatusBarBadge.displayText(due: 1500), "999")
        XCTAssertEqual(StatusBarBadge.displayText(due: 999), "999")
        XCTAssertEqual(StatusBarBadge.displayText(due: 42), "42")
    }

    /// §2.3-4（tray_badge.rs:22 BADGE_RGB [224,67,64]）：跨端同色锚定。
    func test_badgeRedMatchesWindowsConstant() throws {
        let red = try XCTUnwrap(StatusBarBadge.badgeRed.usingColorSpace(.sRGB))
        XCTAssertEqual(red.redComponent, 224 / 255, accuracy: 0.0001)
        XCTAssertEqual(red.greenComponent, 67 / 255, accuracy: 0.0001)
        XCTAssertEqual(red.blueComponent, 64 / 255, accuracy: 0.0001)
        XCTAssertEqual(red.alphaComponent, 1, accuracy: 0.0001)
    }

    /// 托盘合成（App.swift onDueCountChange 消费路径）：due=0 尺寸=原图；
    /// due>0 宽度增加（图标+间距+胶囊）；base 缺失 → nil（调用方走「译」兜底）。
    func test_trayIconWithBadgeComposition() throws {
        let base = NSImage(size: NSSize(width: 18, height: 18))
        let plain = try XCTUnwrap(StatusBarBadge.trayIconWithBadge(base: base, due: 0))
        XCTAssertEqual(plain.size.width, 18, accuracy: 0.01)
        XCTAssertEqual(plain.size.height, 18, accuracy: 0.01)

        let composed = try XCTUnwrap(StatusBarBadge.trayIconWithBadge(base: base, due: 6))
        let badge = try XCTUnwrap(StatusBarBadge.badgeImage(due: 6))
        XCTAssertEqual(composed.size.width, 18 + 3 + badge.size.width, accuracy: 0.01)
        XCTAssertEqual(composed.size.height, max(18, badge.size.height), accuracy: 0.01)

        XCTAssertNil(StatusBarBadge.trayIconWithBadge(base: nil, due: 6))
        XCTAssertNil(StatusBarBadge.trayIconWithBadge(base: nil, due: 0))
    }
}
