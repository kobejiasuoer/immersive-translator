import XCTest
@testable import ReaderCore

/// SHELL-CHROME 批次（壳导航 / 三主题皮肤 / 启动接线）的可测核心：
/// 对照模式循环（SHELL-8）、三套氛围主题令牌与循环（SHELL-4）、导航岛三档归并与
/// 角标口径（SHELL-2）、书架触发器文案、老 theme 数据免迁移。
/// 令牌值逐项对账 immersive-translator-windows/src/styles.css:2817-2997。
final class ShellChromeTests: XCTestCase {
    // MARK: - SHELL-8：对照模式循环

    func testContrastModeNextCyclesThroughAllThreeModes() {
        // 仅英文 → 对照 → 仅中文 → 仅英文（Windows ReaderTopBar.tsx:224 同序）。
        XCTAssertEqual(ContrastMode.en.next, .dual)
        XCTAssertEqual(ContrastMode.dual.next, .zh)
        XCTAssertEqual(ContrastMode.zh.next, .en)
    }

    func testContrastModeNextNeverReturnsSelf() {
        // 旧 bug 的直接断言：`firstIndex(of:) ?? 0 + 1` 优先级错误会让 next == self。
        for mode in ContrastMode.allCases {
            XCTAssertNotEqual(mode.next, mode, "\(mode) 的下一档不应是它自己")
        }
    }

    func testContrastModeFourCyclesReturnToStart() {
        var mode = ContrastMode.en
        for _ in 0..<3 { mode = mode.next }
        XCTAssertEqual(mode, .en)
    }

    // MARK: - SHELL-4：主题四档文案 + 循环

    func testThemeLabelsMatchWindowsCopy() {
        // Windows ReaderTopBar.tsx:68-73：纸书 / 深色 / 护眼 / 纯黑。
        XCTAssertEqual(ReaderTheme.light.label, "纸书")
        XCTAssertEqual(ReaderTheme.dark.label, "深色")
        XCTAssertEqual(ReaderTheme.sepia.label, "护眼")
        XCTAssertEqual(ReaderTheme.oled.label, "纯黑")
    }

    func testThemeNextCyclesPaperBookFirst() {
        XCTAssertEqual(ReaderTheme.light.next, .dark)
        XCTAssertEqual(ReaderTheme.dark.next, .sepia)
        XCTAssertEqual(ReaderTheme.sepia.next, .oled)
        XCTAssertEqual(ReaderTheme.oled.next, .light)
    }

    func testLegacyThemeRawValuesStillDecode() throws {
        // 老数据 theme 字段免迁移：四个旧枚举值原样解码生效。
        let json = #"{"theme":"sepia"}"#
        let override = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: Data(json.utf8))
        XCTAssertEqual(override.theme, "sepia")
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.theme, .sepia)
    }

    // MARK: - SHELL-4：三套氛围主题令牌（对账 styles.css）

    func testWarmArchivalTokensMatchStylesCSS() {
        let t = ReaderThemeTokens.tokens(for: .light)
        XCTAssertEqual(t.canvasBg.hex, "#F6F3EC")
        XCTAssertEqual(t.accent.hex, "#C84B31")
        XCTAssertEqual(t.ink1.hex, "#171614")
        XCTAssertEqual(t.sonicTeal.hex, "#1B6B58")
        XCTAssertEqual(t.tapeBg.hex, "#E9DEC8")
        XCTAssertEqual(t.warn.hex, "#B45309")
        XCTAssertEqual(t.err.hex, "#B91C1C")
        // 透明令牌：rgba(200, 75, 49, 0.11) → #C84B31 @ 0.11
        XCTAssertEqual(t.accentSoft, ReaderColorToken("#C84B31", alpha: 0.11))
        XCTAssertEqual(t.glassBorder, ReaderColorToken("#1C1B18", alpha: 0.09))
        XCTAssertEqual(t.glassBorderStrong, ReaderColorToken("#1C1B18", alpha: 0.16))
    }

    func testObsidianSonicTokensMatchStylesCSS() {
        let t = ReaderThemeTokens.tokens(for: .dark)
        XCTAssertEqual(t.canvasBg.hex, "#0E1014")
        XCTAssertEqual(t.accent.hex, "#E26D52")
        XCTAssertEqual(t.accentHover.hex, "#EC8268")
        XCTAssertEqual(t.ink1.hex, "#F4F2ED")
        XCTAssertEqual(t.sonicTeal.hex, "#38B296")
        XCTAssertEqual(t.clauseIndigo.hex, "#8093FF")
        XCTAssertEqual(t.warn.hex, "#E59A3C")
        XCTAssertEqual(t.err.hex, "#F06868")
        XCTAssertEqual(t.aura1, ReaderColorToken("#E06D53", alpha: 0.11))
        XCTAssertEqual(t.glassElevated, ReaderColorToken("#1D2028", alpha: 0.88))
    }

    func testNordicMistTokensMatchStylesCSS() {
        let t = ReaderThemeTokens.tokens(for: .sepia)
        XCTAssertEqual(t.canvasBg.hex, "#EEF1EF")
        XCTAssertEqual(t.accent.hex, "#1B6B58")
        XCTAssertEqual(t.accentHover.hex, "#14574A")
        XCTAssertEqual(t.ink1.hex, "#131B18")
        // nordic-mist 的 sonic-teal 是反转的赤陶（styles.css:2960）。
        XCTAssertEqual(t.sonicTeal.hex, "#C84B31")
        // 从句回标色是墨绿系（AA 4.81:1），不继承全局靛蓝。
        XCTAssertEqual(t.clauseIndigo.hex, "#1F6E5E")
        // warn/err 未在 sepia 块重定义 → 继承基值（纸书同值）。
        XCTAssertEqual(t.warn.hex, "#B45309")
        XCTAssertEqual(t.err.hex, "#B91C1C")
    }

    func testOledSharesObsidianValues() {
        // styles.css:2900 `[data-theme="dark"], [data-theme="oled"]` 同值：
        // 除 theme 身份字段外，全部颜色令牌逐一相等。
        let dark = ReaderThemeTokens.tokens(for: .dark)
        let oled = ReaderThemeTokens.tokens(for: .oled)
        let darkColors = Mirror(reflecting: dark).children.compactMap { child -> (String, ReaderColorToken)? in
            guard let label = child.label, let token = child.value as? ReaderColorToken else { return nil }
            return (label, token)
        }
        let oledColors = Dictionary(uniqueKeysWithValues: Mirror(reflecting: oled).children.compactMap { child -> (String, ReaderColorToken)? in
            guard let label = child.label, let token = child.value as? ReaderColorToken else { return nil }
            return (label, token)
        })
        XCTAssertGreaterThan(darkColors.count, 25)
        for (label, token) in darkColors {
            XCTAssertEqual(oledColors[label], token, "oled.\(label) 应与 dark 同值")
        }
        // 但枚举身份保留（label/循环各自成立）。
        XCTAssertEqual(dark.theme, .dark)
        XCTAssertEqual(oled.theme, .oled)
        XCTAssertTrue(ReaderTheme.oled.isDark)
        XCTAssertFalse(ReaderTheme.sepia.isDark)
    }

    func testEveryTokenHexParses() {
        // 逐主题逐令牌：hex 必须能解析成 RGB（防手滑写错格式，UI 层不至于回落纯黑）。
        for theme in ReaderTheme.allCases {
            let t = ReaderThemeTokens.tokens(for: theme)
            let mirrors = Mirror(reflecting: t).children.compactMap { $0.value as? ReaderColorToken }
            XCTAssertGreaterThan(mirrors.count, 25, "\(theme) 应有完整令牌集")
            for token in mirrors {
                XCTAssertNotNil(token.rgb, "\(theme) 令牌 \(token.hex) 无法解析")
            }
        }
    }

    func testReaderColorTokenRGBComponents() {
        let token = ReaderColorToken("#C84B31")
        let rgb = token.rgb
        XCTAssertNotNil(rgb)
        XCTAssertEqual(rgb!.r, 200.0 / 255, accuracy: 0.001)
        XCTAssertEqual(rgb!.g, 75.0 / 255, accuracy: 0.001)
        XCTAssertEqual(rgb!.b, 49.0 / 255, accuracy: 0.001)
        XCTAssertNil(ReaderColorToken("#XYZ").rgb)
        XCTAssertNil(ReaderColorToken("C84B3").rgb)
    }

    // MARK: - SHELL-2：导航岛三档归并 + 角标口径

    func testIslandSurfaceFoldsInternalRoutes() {
        // shelf/reading → 阅读、speak → 口语、review/notes → 笔记与复习。
        XCTAssertEqual(IslandSurface(folding: .shelf), .reading)
        XCTAssertEqual(IslandSurface(folding: .reading), .reading)
        XCTAssertEqual(IslandSurface(folding: .speak), .speak)
        XCTAssertEqual(IslandSurface(folding: .review), .vault)
        XCTAssertEqual(IslandSurface(folding: .notes), .vault)
    }

    func testIslandSurfaceLabelsMatchWindowsCopy() {
        XCTAssertEqual(IslandSurface.reading.label, "阅读")
        XCTAssertEqual(IslandSurface.speak.label, "口语")
        XCTAssertEqual(IslandSurface.vault.label, "笔记与复习")
    }

    func testVaultBadgeCountSumsDueAndUnnoted() {
        // 角标 = 到期数 + 未整理数（ReaderTopBar.tsx:85）。
        XCTAssertEqual(vaultBadgeCount(dueNow: 3, unnotedCount: 4), 7)
        XCTAssertEqual(vaultBadgeCount(dueNow: 0, unnotedCount: 0), 0)
        // 坏数据不产生负角标。
        XCTAssertEqual(vaultBadgeCount(dueNow: -2, unnotedCount: 5), 5)
        XCTAssertEqual(vaultBadgeCount(dueNow: 2, unnotedCount: -9), 2)
    }

    func testFolioTriggerLabelCompositions() {
        // 阅读档带文章名：「书架 · The Call of the Wild」。
        XCTAssertEqual(
            ReaderRouteKind.reading.folioTriggerLabel(articleTitle: "The Call of the Wild"),
            "书架 · The Call of the Wild"
        )
        // 书架页 / 阅读档没有文章：只写「书架」（Windows 会显示「书架 · 书架」，Mac 去重）。
        XCTAssertEqual(ReaderRouteKind.shelf.folioTriggerLabel(articleTitle: nil), "书架")
        XCTAssertEqual(ReaderRouteKind.shelf.folioTriggerLabel(articleTitle: "Any"), "书架")
        XCTAssertEqual(ReaderRouteKind.reading.folioTriggerLabel(articleTitle: nil), "书架")
        XCTAssertEqual(ReaderRouteKind.reading.folioTriggerLabel(articleTitle: "  "), "书架")
        // 其他档带面名。
        XCTAssertEqual(ReaderRouteKind.speak.folioTriggerLabel(articleTitle: nil), "书架 · 口语陪练")
        XCTAssertEqual(ReaderRouteKind.notes.folioTriggerLabel(articleTitle: nil), "书架 · 笔记与复习")
        XCTAssertEqual(ReaderRouteKind.review.folioTriggerLabel(articleTitle: nil), "书架 · 笔记与复习")
    }

    func testSurfaceTitleForRoutes() {
        XCTAssertEqual(ReaderRouteKind.shelf.surfaceTitle(articleTitle: "X"), "书架")
        XCTAssertEqual(ReaderRouteKind.reading.surfaceTitle(articleTitle: "X"), "X")
        XCTAssertNil(ReaderRouteKind.reading.surfaceTitle(articleTitle: nil))
        XCTAssertEqual(ReaderRouteKind.speak.surfaceTitle(articleTitle: nil), "口语陪练")
    }
}
