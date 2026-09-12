import SwiftUI
import ReaderCore

/// 阅读室四套主题的色板与字体配对。
struct ReaderPalette {
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

    static func palette(for theme: ReaderTheme) -> ReaderPalette {
        switch theme {
        case .light:
            return ReaderPalette(
                background: Color(red: 0.957, green: 0.961, blue: 0.976),
                surface: .white,
                surfaceAlt: Color(red: 0.973, green: 0.976, blue: 0.984),
                text: Color(red: 0.11, green: 0.125, blue: 0.16),
                textSecondary: Color(red: 0.36, green: 0.39, blue: 0.45),
                textTertiary: Color(red: 0.58, green: 0.61, blue: 0.67),
                accent: Color(red: 0.23, green: 0.51, blue: 0.96),
                border: Color.black.opacity(0.1),
                ok: Color(red: 0.13, green: 0.62, blue: 0.35),
                warn: Color(red: 0.72, green: 0.51, blue: 0.05),
                err: Color(red: 0.8, green: 0.25, blue: 0.2),
                activeRow: Color(red: 0.23, green: 0.51, blue: 0.96).opacity(0.08),
                knownColor: Color(red: 0.05, green: 0.55, blue: 0.32),
                colorScheme: .light
            )
        case .dark:
            return ReaderPalette(
                background: Color(red: 0.114, green: 0.122, blue: 0.149),
                surface: Color(red: 0.153, green: 0.163, blue: 0.2),
                surfaceAlt: Color(red: 0.18, green: 0.19, blue: 0.235),
                text: Color(red: 0.93, green: 0.935, blue: 0.957),
                textSecondary: Color(red: 0.68, green: 0.7, blue: 0.75),
                textTertiary: Color(red: 0.5, green: 0.52, blue: 0.58),
                accent: Color(red: 0.38, green: 0.6, blue: 0.98),
                border: Color.white.opacity(0.12),
                ok: Color(red: 0.3, green: 0.75, blue: 0.45),
                warn: Color(red: 0.9, green: 0.68, blue: 0.25),
                err: Color(red: 0.92, green: 0.42, blue: 0.36),
                activeRow: Color(red: 0.38, green: 0.6, blue: 0.98).opacity(0.12),
                knownColor: Color(red: 0.32, green: 0.8, blue: 0.5),
                colorScheme: .dark
            )
        case .sepia:
            return ReaderPalette(
                background: Color(red: 0.96, green: 0.937, blue: 0.875),
                surface: Color(red: 0.98, green: 0.965, blue: 0.92),
                surfaceAlt: Color(red: 0.94, green: 0.91, blue: 0.84),
                text: Color(red: 0.353, green: 0.318, blue: 0.22),
                textSecondary: Color(red: 0.46, green: 0.42, blue: 0.31),
                textTertiary: Color(red: 0.58, green: 0.53, blue: 0.42),
                accent: Color(red: 0.55, green: 0.41, blue: 0.13),
                border: Color(red: 0.353, green: 0.318, blue: 0.22).opacity(0.16),
                ok: Color(red: 0.35, green: 0.5, blue: 0.2),
                warn: Color(red: 0.65, green: 0.45, blue: 0.1),
                err: Color(red: 0.7, green: 0.28, blue: 0.2),
                activeRow: Color(red: 0.55, green: 0.41, blue: 0.13).opacity(0.1),
                knownColor: Color(red: 0.35, green: 0.5, blue: 0.2),
                colorScheme: .light
            )
        case .oled:
            return ReaderPalette(
                background: Color(red: 0.04, green: 0.04, blue: 0.045),
                surface: Color(red: 0.08, green: 0.08, blue: 0.09),
                surfaceAlt: Color(red: 0.12, green: 0.12, blue: 0.135),
                text: Color(red: 0.725, green: 0.74, blue: 0.79),
                textSecondary: Color(red: 0.55, green: 0.57, blue: 0.62),
                textTertiary: Color(red: 0.42, green: 0.44, blue: 0.49),
                accent: Color(red: 0.4, green: 0.62, blue: 1.0),
                border: Color.white.opacity(0.1),
                ok: Color(red: 0.3, green: 0.75, blue: 0.45),
                warn: Color(red: 0.9, green: 0.68, blue: 0.25),
                err: Color(red: 0.92, green: 0.42, blue: 0.36),
                activeRow: Color(red: 0.4, green: 0.62, blue: 1.0).opacity(0.12),
                knownColor: Color(red: 0.32, green: 0.8, blue: 0.5),
                colorScheme: .dark
            )
        }
    }
}

/// 字体配对：衬线（宋体 + Source Serif 视觉）/ 无衬线（黑体 + Inter 视觉）。
/// 系统字体 design 向下兼容中英文。
func readerFont(_ size: CGFloat, _ weight: Font.Weight = .regular, pair: ReaderFontPair, mono: Bool = false) -> Font {
    if mono { return .system(size: size, weight: weight, design: .monospaced) }
    switch pair {
    case .serif: return .system(size: size, weight: weight, design: .serif)
    case .sans: return .system(size: size, weight: weight, design: .default)
    }
}

/// NSTextView 用的等价物。
func readerNSFont(_ size: CGFloat, pair: ReaderFontPair) -> NSFont {
    let design: NSFontDescriptor.SystemDesign = pair == .serif ? .serif : .default
    let base = NSFont.systemFont(ofSize: size, weight: .regular)
    guard let descriptor = base.fontDescriptor.withDesign(design) else { return base }
    return NSFont(descriptor: descriptor, size: size) ?? base
}

/// 阅读室图标（SF Symbols，风格与 Mac 版现有 SwiftUI 一致）。
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
}
