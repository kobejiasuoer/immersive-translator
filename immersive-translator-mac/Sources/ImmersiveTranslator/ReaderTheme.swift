import SwiftUI
import ReaderCore

// MARK: - 颜色令牌 → SwiftUI Color

extension Color {
    /// 由 ReaderCore 的颜色令牌构造（非法 hex 回落黑色，不崩）。
    init(token: ReaderColorToken) {
        if let rgb = token.rgb {
            self.init(.sRGB, red: rgb.r, green: rgb.g, blue: rgb.b, opacity: token.alpha)
        } else {
            self.init(.sRGB, red: 0, green: 0, blue: 0, opacity: token.alpha)
        }
    }
}

/// 阅读室三套氛围皮肤的色板（v0.8：warm-archival / obsidian-sonic / nordic-mist）。
///
/// 单一真源是 ReaderCore.ReaderThemeTokens（与 Windows styles.css 令牌逐值对账）；
/// 这里只做 Color 转换 + 旧字段派生，阅读室既有组件（词典栏/复习卡/笔记纸）
/// 继续读 background/surface/text/accent… 即可自动换肤，不必改样式。
struct ReaderPalette {
    // —— 旧字段（既有组件在用，语义不变）——
    let background: Color
    let surface: Color
    let surfaceAlt: Color
    let text: Color
    let textSecondary: Color
    let textTertiary: Color
    let accent: Color
    let border: Color
    let ok: Color
    let warn: Color
    let err: Color
    let activeRow: Color
    let knownColor: Color
    let colorScheme: ColorScheme

    // —— v0.8 新令牌 ——
    /// 画布双极光晕（左上 aura1 / 右下 aura2）。
    let aura1: Color
    let aura2: Color
    /// 毛玻璃材质层：面板 / 浮起面板 / 胶囊。
    let glassSurface: Color
    let glassElevated: Color
    let glassPill: Color
    let glassBorder: Color
    let glassBorderStrong: Color
    let glassHighlight: Color
    /// 墨阶第四级（占位/最弱文字）。
    let ink4: Color
    /// 深色胶囊（ink-1 底）上的文字色 = 画布底色。
    let onInk: Color
    let accentHover: Color
    let accentSoft: Color
    let accentSofter: Color
    let accentGlow: Color
    let sonicTeal: Color
    let sonicTealSoft: Color
    let clauseIndigo: Color
    let clauseIndigoSoft: Color
    let tapeBg: Color
    let tapeBorder: Color
    let tapeInk: Color
    let warnSoft: Color
    let errSoft: Color
    let surface2: Color
    /// 投影参数（原型 --shadow-pill / --shadow-spatial 的主层近似）。
    let shadowPill: Color
    let shadowSpatial: Color
    let theme: ReaderTheme

    static func palette(for theme: ReaderTheme) -> ReaderPalette {
        let t = ReaderThemeTokens.tokens(for: theme)
        let dark = theme.isDark
        return ReaderPalette(
            background: Color(token: t.canvasBg),
            surface: Color(token: t.surface),
            surfaceAlt: Color(token: t.surface2),
            text: Color(token: t.ink1),
            textSecondary: Color(token: t.ink2),
            textTertiary: Color(token: t.ink3),
            accent: Color(token: t.accent),
            border: Color(token: t.glassBorder),
            ok: Color(token: t.sonicTeal),
            warn: Color(token: t.warn),
            err: Color(token: t.err),
            activeRow: Color(token: t.accentSoft),
            knownColor: Color(token: t.sonicTeal),
            colorScheme: dark ? .dark : .light,
            aura1: Color(token: t.aura1),
            aura2: Color(token: t.aura2),
            glassSurface: Color(token: t.glassSurface),
            glassElevated: Color(token: t.glassElevated),
            glassPill: Color(token: t.glassPill),
            glassBorder: Color(token: t.glassBorder),
            glassBorderStrong: Color(token: t.glassBorderStrong),
            glassHighlight: Color(token: t.glassHighlight),
            ink4: Color(token: t.ink4),
            onInk: Color(token: t.canvasBg),
            accentHover: Color(token: t.accentHover),
            accentSoft: Color(token: t.accentSoft),
            accentSofter: Color(token: t.accentSofter),
            accentGlow: Color(token: t.accentGlow),
            sonicTeal: Color(token: t.sonicTeal),
            sonicTealSoft: Color(token: t.sonicTealSoft),
            clauseIndigo: Color(token: t.clauseIndigo),
            clauseIndigoSoft: Color(token: t.clauseIndigoSoft),
            tapeBg: Color(token: t.tapeBg),
            tapeBorder: Color(token: t.tapeBorder),
            tapeInk: Color(token: t.tapeInk),
            warnSoft: Color(token: t.warnSoft),
            errSoft: Color(token: t.errSoft),
            surface2: Color(token: t.surface2),
            // 纸书/护眼：墨色 11%；深色：纯黑 60%（styles.css --shadow-pill 主层）。
            shadowPill: dark ? Color.black.opacity(0.6) : Color(token: t.ink1).opacity(0.11),
            shadowSpatial: dark ? Color.black.opacity(0.55) : Color(token: t.ink1).opacity(0.09),
            theme: theme
        )
    }
}

// MARK: - 动效（原型 --ease-spring: cubic-bezier(0.16, 1, 0.3, 1)）

enum ReaderMotion {
    /// 换肤：350ms 弹性曲线（styles.css `.reader-root { transition: background-color 350ms var(--ease-spring) }`）。
    static let skin: Animation = .timingCurve(
        ReaderThemeTokens.springCurve.c0x, ReaderThemeTokens.springCurve.c0y,
        ReaderThemeTokens.springCurve.c1x, ReaderThemeTokens.springCurve.c1y,
        duration: ReaderThemeTokens.skinTransitionDuration
    )
    /// 导航岛高亮胶囊滑移（.island-tab transition: all 200ms）。
    static let islandTab: Animation = .timingCurve(0.16, 1, 0.3, 1, duration: 0.2)
    /// 路由舞台切档（REVIEW-04，mac 反超项）：与 islandTab 同一条弹性曲线的
    /// 200ms 交叉淡入——胶囊在滑、正文同步淡入淡出而非瞬跳（apple-design §7
    /// 对称路径：进出走同一条 opacity 路径）。
    static let routeFade: Animation = .timingCurve(0.16, 1, 0.3, 1, duration: 0.2)
    /// 「减弱动态效果」下的切档：120ms 纯淡入（§14 退化规则——cross-fade 本就
    /// 是 reduced-motion 的等价反馈，去掉弹性曲线、缩短时长即可）。
    static let routeFadeReduced: Animation = .easeIn(duration: 0.12)
    /// 书架浮层出入（.floating-folio-sheet transition: all 220ms）。
    static let folio: Animation = .timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    /// 悬停/按压反馈（150ms）。
    static let hover: Animation = .easeOut(duration: 0.15)
}

// MARK: - 字体

/// 字体配对：衬线（宋体 + Source Serif 视觉）/ 无衬线（黑体 + Inter 视觉）。
/// 系统字体 design 向下兼容中英文。
func readerFont(_ size: CGFloat, _ weight: Font.Weight = .regular, pair: ReaderFontPair, mono: Bool = false) -> Font {
    if mono { return .system(size: size, weight: weight, design: .monospaced) }
    switch pair {
    case .serif: return .system(size: size, weight: weight, design: .serif)
    case .sans: return .system(size: size, weight: weight, design: .default)
    }
}

/// 展示字体（原型 --font-display：Instrument Serif 衬线）——书名 / 刊头 / monogram 用；
/// macOS 侧取系统衬线 design（New York），中英文混排都成立。
func readerDisplayFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .serif)
}

/// NSTextView 用的等价物。
func readerNSFont(_ size: CGFloat, pair: ReaderFontPair) -> NSFont {
    let design: NSFontDescriptor.SystemDesign = pair == .serif ? .serif : .default
    let base = NSFont.systemFont(ofSize: size, weight: .regular)
    guard let descriptor = base.fontDescriptor.withDesign(design) else { return base }
    return NSFont(descriptor: descriptor, size: size) ?? base
}

// MARK: - 图标

/// 阅读室图标（SF Symbols，风格与 Mac 版现有 SwiftUI 一致；全部为 macOS 13 可用名）。
enum ReaderIcons {
    static let plus = "plus"
    static let trash = "trash"
    static let search = "magnifyingglass"
    static let gear = "gearshape"
    static let book = "book"
    static let eyeOff = "eye.slash"
    static let edit = "pencil"
    static let speaker = "speaker.wave.2"
    static let close = "xmark"
    static let play = "play.fill"
    static let pause = "pause.fill"
    static let prev = "backward.end.fill"
    static let next = "forward.end.fill"
    static let star = "star"
    static let starFill = "star.fill"
    static let copy = "doc.on.doc"
    static let locate = "arrow.down.forward.square"
    // v0.8 导航岛 / 书架浮层
    /// 导航岛「阅读」。
    static let navReading = "book"
    /// 导航岛「口语」。
    static let navSpeak = "mic"
    /// 导航岛「笔记与复习」。
    static let navVault = "note.text"
    /// 书架触发器书卷图标。
    static let folio = "books.vertical"
    /// 触发器下拉箭头。
    static let caret = "chevron.down"
    /// 书架首页：目录 / 继续读。
    static let toc = "list.bullet"
    static let flame = "flame"
}
