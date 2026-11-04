import AppKit
import XCTest
@testable import ImmersiveTranslator

/// 墨绿品牌色对账（规格 docs/mac-ui-fix-specs-2026-11-02/settings.md §1.9 / §2.9 第 2 条）：
/// 设置域动态 accent 亮色 #1F6B57 / 暗色 #73C6AA（Windows styles.css:28-35/:76-83 的
/// --brand-accent）。设置窗根视图 .tint(Brand.accent)（SettingsWindowController）与
/// 散点 Brand.accent 替换共用此单一真源；登录窗主 palette 的暖橙 token 不在本域。
final class SettingsBrandColorTests: XCTestCase {
    func testAccentHexConstantsMatchWindowsBaseline() {
        XCTAssertEqual(Brand.accentLightHex, "#1F6B57")
        XCTAssertEqual(Brand.accentDarkHex, "#73C6AA")
    }

    func testAccentHexResolvesByAppearance() {
        XCTAssertEqual(
            Brand.accentHex(for: NSAppearance(named: .aqua)!),
            Brand.accentLightHex,
            "浅色（aqua）应解析为墨绿亮色"
        )
        XCTAssertEqual(
            Brand.accentHex(for: NSAppearance(named: .darkAqua)!),
            Brand.accentDarkHex,
            "深色（darkAqua）应解析为墨绿暗色"
        )
    }

    func testBaselineHexesParseToExactRGBComponents() {
        // 容差 0：逐分量断言（规格 §2.9 第 2 条）。Brand.nsColor(hex:) 是动态色
        // 与测试共用的唯一解析器，分量正确 = 动态色两态均正确。
        let light = componentsOf(Brand.nsColor(hex: Brand.accentLightHex))
        XCTAssertEqual(light.0, 0x1F)
        XCTAssertEqual(light.1, 0x6B)
        XCTAssertEqual(light.2, 0x57)

        let dark = componentsOf(Brand.nsColor(hex: Brand.accentDarkHex))
        XCTAssertEqual(dark.0, 0x73)
        XCTAssertEqual(dark.1, 0xC6)
        XCTAssertEqual(dark.2, 0xAA)
    }

    // MARK: 夹具

    private func componentsOf(_ color: NSColor) -> (UInt8, UInt8, UInt8) {
        let srgb = color.usingColorSpace(NSColorSpace.sRGB)!
        return (
            UInt8((srgb.redComponent * 255).rounded()),
            UInt8((srgb.greenComponent * 255).rounded()),
            UInt8((srgb.blueComponent * 255).rounded())
        )
    }
}
