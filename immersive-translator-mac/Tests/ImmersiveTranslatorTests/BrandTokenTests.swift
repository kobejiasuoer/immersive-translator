import AppKit
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 品牌统一 token 测试（对账 Windows v0.12 墨绿品牌色系 styles.css:28-35 浅 /
// :76-83 深）：hex 常量逐字对账、动态 accent 浅/深外观解析、到期角标纯函数。
// LoginTheme（private struct）不直测：其 accent 三元组已改为引用 Brand 常量，
// 本文件的常量对账即覆盖登录窗取值。
// ---------------------------------------------------------------------------

final class BrandTokenTests: XCTestCase {
    func testBrandHexConstants() {
        // styles.css:28-29（浅色 --brand-accent / --brand-hover）
        XCTAssertEqual(Brand.accentLightHex, "#1F6B57")
        XCTAssertEqual(Brand.accentLightHoverHex, "#185646")
        // styles.css:76-77（深色 --brand-accent / --brand-hover）
        XCTAssertEqual(Brand.accentDarkHex, "#73C6AA")
        XCTAssertEqual(Brand.accentDarkHoverHex, "#86D3BA")
        // styles.css:80（深色 --brand-foreground）
        XCTAssertEqual(Brand.accentForegroundDarkHex, "#112A20")
    }

    func testDynamicAccentResolvesByAppearance() throws {
        // AppKit NSColor 没有 UIColor 式 resolvedColor(with:)，动态解析拆成
        // 两层验证：① 外观→hex 派发（动态 provider 的唯一逻辑）；
        // ② hex→RGB 换算；③ NSAppearance.current 下动态色端到端解析。
        let aqua = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAqua = try XCTUnwrap(NSAppearance(named: .darkAqua))
        // ① 派发：浅 #1f6b57 / 深 #73c6aa（styles.css:28/:76）
        XCTAssertEqual(Brand.accentHex(for: aqua), Brand.accentLightHex)
        XCTAssertEqual(Brand.accentHex(for: darkAqua), Brand.accentDarkHex)

        // ② hex → sRGB 分量：浅 (31,107,87)、深 (115,198,170)
        let lightHex = Brand.nsColor(hex: Brand.accentLightHex).usingColorSpace(.sRGB)
        XCTAssertEqual(Int(round((lightHex?.redComponent ?? -1) * 255)), 31)
        XCTAssertEqual(Int(round((lightHex?.greenComponent ?? -1) * 255)), 107)
        XCTAssertEqual(Int(round((lightHex?.blueComponent ?? -1) * 255)), 87)
        let darkHex = Brand.nsColor(hex: Brand.accentDarkHex).usingColorSpace(.sRGB)
        XCTAssertEqual(Int(round((darkHex?.redComponent ?? -1) * 255)), 115)
        XCTAssertEqual(Int(round((darkHex?.greenComponent ?? -1) * 255)), 198)
        XCTAssertEqual(Int(round((darkHex?.blueComponent ?? -1) * 255)), 170)

        // ③ 动态色端到端：把 current appearance 切到深色后转换解析出深色分量，
        //    结束恢复（AppKit 动态 NSColor 转换色空间时按 current appearance 解析）。
        NSAppearance.current = darkAqua
        defer { NSAppearance.current = nil }
        let resolvedDark = Brand.accentNSColor.usingColorSpace(.sRGB)
        XCTAssertEqual(Int(round((resolvedDark?.redComponent ?? -1) * 255)), 115)
        XCTAssertEqual(Int(round((resolvedDark?.greenComponent ?? -1) * 255)), 198)
        XCTAssertEqual(Int(round((resolvedDark?.blueComponent ?? -1) * 255)), 170)
    }

    func testStatusBadgeText() {
        // 到期 > 0：纯数字（图标由 button.image 常驻，前缀不再写「译 」）。
        XCTAssertEqual(Brand.statusBadgeText(due: 3), "3")
        // 归零：nil → 调用方清 attributedTitle 恢复纯图标。
        XCTAssertNil(Brand.statusBadgeText(due: 0))
    }
}
