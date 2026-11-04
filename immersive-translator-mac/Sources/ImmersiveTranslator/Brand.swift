import AppKit
import SwiftUI

// ---------------------------------------------------------------------------
// 品牌统一 token（v0.12 品牌统一，对齐 Windows 墨绿品牌色系；权威值
// immersive-translator-windows/src/styles.css:28-35 浅色 / :76-83 深色）。
// 单一真源：登录窗 LoginTheme 与设置窗 .tint 均从此取值，后续其余窗的
// 散点 accentColor 统一时也引用这里。
// 色值对账（浅 / 深）：
//   brand-accent     #1f6b57 / #73c6aa
//   brand-hover      #185646 / #86d3ba
//   brand-foreground #ffffff / #112a20（accentForeground：墨绿底上的前景字色）
// ---------------------------------------------------------------------------

enum Brand {
    // MARK: 十六进制真源（大写规范形式，测试对账用）

    static let accentLightHex = "#1F6B57"
    static let accentLightHoverHex = "#185646"
    static let accentDarkHex = "#73C6AA"
    static let accentDarkHoverHex = "#86D3BA"
    static let accentForegroundDarkHex = "#112A20"

    // MARK: 构建

    /// #RRGGBB → NSColor（sRGB）。非法输入按黑色兜底（调用方只传内部常量）。
    static func nsColor(hex: String) -> NSColor {
        var value: UInt64 = 0
        var digits = hex
        if digits.hasPrefix("#") { digits.removeFirst() }
        Scanner(string: digits).scanHexInt64(&value)
        return NSColor(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// hex → SwiftUI Color（LoginTheme 等 SwiftUI 消费点用）。
    static func color(_ hex: String) -> Color {
        Color(nsColor: nsColor(hex: hex))
    }

    /// 按外观解析品牌 accent hex（浅/深派发的唯一逻辑，动态色与测试共用）。
    static func accentHex(for appearance: NSAppearance) -> String {
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? accentDarkHex
            : accentLightHex
    }

    /// 动态 accent：浅色 #1F6B57 / 深色 #73C6AA。写法同窗背景动态色的既有模式
    /// （LoginWindowController.swift:102 `NSColor(name: nil) { appearance in ... }`）。
    static let accentNSColor = NSColor(name: nil) { appearance in
        nsColor(hex: accentHex(for: appearance))
    }

    /// SwiftUI 侧动态 accent（设置窗根视图 .tint 用：该层级内 Color.accentColor
    /// 解析为它，品牌徽记/导航选中条/强调按钮随之全部墨绿）。
    static let accent = Color(nsColor: accentNSColor)

    // MARK: 菜单栏 status item（对齐 Windows 托盘 lib.rs:1518-1520）

    /// 托盘图标原件：Windows tray-icon.png（32×32 彩色「书页对话」，非模板图）。
    private static let trayIconBase: NSImage? = {
        guard
            let url = Bundle.module.url(forResource: "tray-icon", withExtension: "png"),
            let image = NSImage(contentsOf: url)
        else { return nil }
        return image
    }()

    /// status item 图标：18pt 彩色「书页对话」。每次返回副本设置 size，
    /// 避免污染缓存原件；加载失败由调用方兜底（App.swift 退回「译」文字）。
    static func trayIconImage() -> NSImage? {
        guard let base = trayIconBase, let copy = base.copy() as? NSImage else { return nil }
        copy.size = NSSize(width: 18, height: 18)
        copy.isTemplate = false
        return copy
    }

    // MARK: 到期角标

    /// 复习到期角标数字：due > 0 返回纯数字字符串（前缀不再写「译 」——
    /// 图标由 button.image 常驻承担，角标只叠加红数字）；due == 0 返回 nil，
    /// 调用方清 attributedTitle 恢复纯图标。
    static func statusBadgeText(due: Int) -> String? {
        due > 0 ? String(due) : nil
    }
}
