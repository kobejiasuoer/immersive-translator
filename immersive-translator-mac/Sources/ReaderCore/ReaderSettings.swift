import Foundation

// MARK: - 阅读设置（视图菜单管「显示什么」，这里管「怎么显示」）

/// 对照模式：仅英文 / 对照 / 仅中文。
public enum ContrastMode: String, Codable, Equatable, CaseIterable {
    case en
    case dual
    case zh

    public var label: String {
        switch self {
        case .en: return "仅英文"
        case .dual: return "对照"
        case .zh: return "仅中文"
        }
    }

    /// 视图菜单「对照模式」的下一档（仅英文 → 对照 → 仅中文 → 仅英文）。
    /// 对齐 Windows ReaderTopBar.tsx:224 `(indexOf + 1) % length`；
    /// 旧 Mac 写法 `firstIndex(of:) ?? 0 + 1` 因 `+` 优先级高于 `??` 取到当前档自身，
    /// 菜单点了等于没点——这里把循环收进枚举，UI 不再手算下标。
    public var next: ContrastMode {
        let all = ContrastMode.allCases
        let idx = all.firstIndex(of: self) ?? 0
        return all[(idx + 1) % all.count]
    }
}

/// 画报排版（v0.8）：prose = 段落英文流 + 当前句行间折叠卡；
/// parallel = 逐句双栏对照（≈旧句对行）。
public enum SpreadLayout: String, Codable, Equatable, CaseIterable {
    case prose
    case parallel

    /// 刊头「排版」开关文案（ReadingView.tsx:585：段落 / 双语对照）。
    public var label: String {
        switch self {
        case .prose: return "段落"
        case .parallel: return "双语对照"
        }
    }

    public var next: SpreadLayout {
        self == .prose ? .parallel : .prose
    }
}

/// 产出式复习的练习形态：识别翻卡 / 完形填空 / 听写。
public enum RecallMode: String, Codable, Equatable, CaseIterable {
    case recognition
    case cloze
    case dictation
}

/// 复习模式设置：smart = 按卡智能路由（词块→完形 · 熟词→听写 · 新词→识别）。
public enum ReviewModeSetting: String, Codable, Equatable, CaseIterable {
    case smart
    case recognition
    case cloze
    case dictation

    public var label: String {
        switch self {
        case .smart: return "智能混合"
        case .recognition: return "识别"
        case .cloze: return "完形"
        case .dictation: return "听写"
        }
    }

    public var description: String {
        switch self {
        case .smart: return "智能混合：词块→完形 · 熟词→听写 · 新词→识别"
        case .recognition: return "识别：看词想义"
        case .cloze: return "完形：原句挖空 · 打字产出"
        case .dictation: return "听写：听整句 · 写整句"
        }
    }
}

/// 译文遮罩样式：blank = 留白显影，frost = 毛玻璃。
public enum MaskStyle: String, Codable, Equatable, CaseIterable {
    case blank
    case frost

    public var label: String {
        switch self {
        case .blank: return "留白显影"
        case .frost: return "毛玻璃"
        }
    }
}

/// 阅读室主题枚举（四值不删，老数据 theme 字段原样生效）。v0.8 起三套氛围皮肤折进四枚举：
/// light ↔ warm-archival（纸书）· dark/oled ↔ obsidian-sonic（深色/纯黑同值）·
/// sepia ↔ nordic-mist（护眼）。令牌见 ReaderThemeTokens。
public enum ReaderTheme: String, Codable, Equatable, CaseIterable {
    case light
    case dark
    case sepia
    case oled

    /// 顶栏主题按钮四档文案（对齐 Windows ReaderTopBar.tsx:68-73 themeLabel）。
    public var label: String {
        switch self {
        case .light: return "纸书"
        case .dark: return "深色"
        case .sepia: return "护眼"
        case .oled: return "纯黑"
        }
    }

    /// 主题按钮循环：纸书 → 深色 → 护眼 → 纯黑 → 纸书（Windows THEME_CYCLE 同序）。
    public var next: ReaderTheme {
        let all = ReaderTheme.allCases
        let idx = all.firstIndex(of: self) ?? 0
        return all[(idx + 1) % all.count]
    }

    /// 深色皮肤（控件走系统 dark 外观）。
    public var isDark: Bool {
        switch self {
        case .dark, .oled: return true
        case .light, .sepia: return false
        }
    }
}

// MARK: - v0.8 氛围主题令牌（对齐 Windows src/styles.css:2817-2997 .reader-root 主题层）

/// 一枚颜色令牌：#RRGGBB + 不透明度（CSS rgba(…) 折成 hex + alpha，便于单测逐值对账）。
public struct ReaderColorToken: Equatable {
    public let hex: String
    public let alpha: Double

    public init(_ hex: String, alpha: Double = 1) {
        self.hex = hex
        self.alpha = alpha
    }

    /// 解析为 0–1 的 RGB 分量；非法 hex 返回 nil（UI 层回落黑/白，不崩）。
    public var rgb: (r: Double, g: Double, b: Double)? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xFF) / 255,
            Double((value >> 8) & 0xFF) / 255,
            Double(value & 0xFF) / 255
        )
    }
}

/// 三套氛围主题的全部令牌（单一真源：ReaderPalette 从这里取色，单测对账 styles.css）。
public struct ReaderThemeTokens: Equatable {
    public let theme: ReaderTheme
    /// 画布底色 + 双极柔和径向光晕（原型 .spatial-universe）。
    public let canvasBg: ReaderColorToken
    public let aura1: ReaderColorToken
    public let aura2: ReaderColorToken
    /// 毛玻璃材质层。
    public let glassSurface: ReaderColorToken
    public let glassElevated: ReaderColorToken
    public let glassPill: ReaderColorToken
    public let glassBorder: ReaderColorToken
    public let glassBorderStrong: ReaderColorToken
    public let glassHighlight: ReaderColorToken
    /// 墨阶四级。
    public let ink1: ReaderColorToken
    public let ink2: ReaderColorToken
    public let ink3: ReaderColorToken
    public let ink4: ReaderColorToken
    /// 主色与衍生。
    public let accent: ReaderColorToken
    public let accentHover: ReaderColorToken
    public let accentSoft: ReaderColorToken
    public let accentSofter: ReaderColorToken
    public let accentGlow: ReaderColorToken
    /// 声波青（读完/成功态）与从句靛蓝。
    public let sonicTeal: ReaderColorToken
    public let sonicTealSoft: ReaderColorToken
    public let clauseIndigo: ReaderColorToken
    public let clauseIndigoSoft: ReaderColorToken
    /// 胶带（级别 chip / 标签）。
    public let tapeBg: ReaderColorToken
    public let tapeBorder: ReaderColorToken
    public let tapeInk: ReaderColorToken
    /// 语义状态色。
    public let warn: ReaderColorToken
    public let warnSoft: ReaderColorToken
    public let err: ReaderColorToken
    public let errSoft: ReaderColorToken
    /// 旧令牌派生（阅读室既有组件直接换肤）。
    public let surface: ReaderColorToken
    public let surface2: ReaderColorToken

    /// 换肤过渡时长（秒）与弹性曲线控制点（原型 350ms var(--ease-spring)）。
    public static let skinTransitionDuration: Double = 0.35
    public static let springCurve: (c0x: Double, c0y: Double, c1x: Double, c1y: Double) = (0.16, 1, 0.3, 1)

    public static func tokens(for theme: ReaderTheme) -> ReaderThemeTokens {
        switch theme {
        case .light:
            return warmArchival
        case .dark, .oled:
            // oled 与 dark 同值（Windows styles.css:2900 `[data-theme="dark"], [data-theme="oled"]`）。
            return ReaderThemeTokens(copying: obsidianSonic, theme: theme)
        case .sepia:
            return nordicMist
        }
    }

    /// warm-archival（纸书）。
    public static let warmArchival = ReaderThemeTokens(
        theme: .light,
        canvasBg: .init("#F6F3EC"),
        aura1: .init("#D05A3F", alpha: 0.07),
        aura2: .init("#1F6E5C", alpha: 0.06),
        glassSurface: .init("#FCFAF5", alpha: 0.78),
        glassElevated: .init("#FFFFFF", alpha: 0.90),
        glassPill: .init("#F7F4EC", alpha: 0.86),
        glassBorder: .init("#1C1B18", alpha: 0.09),
        glassBorderStrong: .init("#1C1B18", alpha: 0.16),
        glassHighlight: .init("#FFFFFF", alpha: 0.7),
        ink1: .init("#171614"),
        ink2: .init("#4A4740"),
        ink3: .init("#7A756C"),
        ink4: .init("#ACA69B"),
        accent: .init("#C84B31"),
        accentHover: .init("#B03E26"),
        accentSoft: .init("#C84B31", alpha: 0.11),
        accentSofter: .init("#C84B31", alpha: 0.06),
        accentGlow: .init("#C84B31", alpha: 0.22),
        sonicTeal: .init("#1B6B58"),
        sonicTealSoft: .init("#1B6B58", alpha: 0.11),
        clauseIndigo: .init("#3649C4"),
        clauseIndigoSoft: .init("#3649C4", alpha: 0.11),
        tapeBg: .init("#E9DEC8"),
        tapeBorder: .init("#D5C5A5"),
        tapeInk: .init("#6E5D43"),
        warn: .init("#B45309"),
        warnSoft: .init("#B45309", alpha: 0.11),
        err: .init("#B91C1C"),
        errSoft: .init("#B91C1C", alpha: 0.10),
        surface: .init("#FCFAF5"),
        surface2: .init("#1C1B18", alpha: 0.045)
    )

    /// obsidian-sonic（深色 / 纯黑同值）。
    public static let obsidianSonic = ReaderThemeTokens(
        theme: .dark,
        canvasBg: .init("#0E1014"),
        aura1: .init("#E06D53", alpha: 0.11),
        aura2: .init("#34A88E", alpha: 0.09),
        glassSurface: .init("#16181E", alpha: 0.76),
        glassElevated: .init("#1D2028", alpha: 0.88),
        glassPill: .init("#181B22", alpha: 0.84),
        glassBorder: .init("#FFFFFF", alpha: 0.09),
        glassBorderStrong: .init("#FFFFFF", alpha: 0.17),
        glassHighlight: .init("#FFFFFF", alpha: 0.06),
        ink1: .init("#F4F2ED"),
        ink2: .init("#B9B5AC"),
        ink3: .init("#7E7B73"),
        ink4: .init("#4D4B45"),
        accent: .init("#E26D52"),
        accentHover: .init("#EC8268"),
        accentSoft: .init("#E26D52", alpha: 0.16),
        accentSofter: .init("#E26D52", alpha: 0.09),
        accentGlow: .init("#E26D52", alpha: 0.30),
        sonicTeal: .init("#38B296"),
        sonicTealSoft: .init("#38B296", alpha: 0.16),
        clauseIndigo: .init("#8093FF"),
        clauseIndigoSoft: .init("#8093FF", alpha: 0.16),
        tapeBg: .init("#2B2824"),
        tapeBorder: .init("#4A4339"),
        tapeInk: .init("#C8B9A2"),
        warn: .init("#E59A3C"),
        warnSoft: .init("#E59A3C", alpha: 0.16),
        err: .init("#F06868"),
        errSoft: .init("#F06868", alpha: 0.16),
        surface: .init("#171A20"),
        surface2: .init("#FFFFFF", alpha: 0.05)
    )

    /// nordic-mist（护眼）。warn/err 未在 sepia 块重定义，继承 .reader-root 基值（纸书同值）。
    public static let nordicMist = ReaderThemeTokens(
        theme: .sepia,
        canvasBg: .init("#EEF1EF"),
        aura1: .init("#1F6E5C", alpha: 0.08),
        aura2: .init("#3649C4", alpha: 0.06),
        glassSurface: .init("#F7F9F8", alpha: 0.80),
        glassElevated: .init("#FFFFFF", alpha: 0.92),
        glassPill: .init("#F4F7F5", alpha: 0.88),
        glassBorder: .init("#141E1A", alpha: 0.09),
        glassBorderStrong: .init("#141E1A", alpha: 0.16),
        glassHighlight: .init("#FFFFFF", alpha: 0.75),
        ink1: .init("#131B18"),
        ink2: .init("#3D4A45"),
        ink3: .init("#6C7A74"),
        ink4: .init("#9CA9A3"),
        accent: .init("#1B6B58"),
        accentHover: .init("#14574A"),
        accentSoft: .init("#1B6B58", alpha: 0.12),
        accentSofter: .init("#1B6B58", alpha: 0.07),
        accentGlow: .init("#1B6B58", alpha: 0.24),
        sonicTeal: .init("#C84B31"),
        sonicTealSoft: .init("#C84B31", alpha: 0.11),
        clauseIndigo: .init("#1F6E5E"),
        clauseIndigoSoft: .init("#1F6E5E", alpha: 0.12),
        tapeBg: .init("#D7E2DC"),
        tapeBorder: .init("#B6C8BE"),
        tapeInk: .init("#385247"),
        warn: .init("#B45309"),
        warnSoft: .init("#B45309", alpha: 0.11),
        err: .init("#B91C1C"),
        errSoft: .init("#B91C1C", alpha: 0.10),
        surface: .init("#F7F9F8"),
        surface2: .init("#141E1A", alpha: 0.045)
    )

    /// 同值换标签（oled 复用 obsidian 令牌但 theme 字段仍为 .oled）。
    private init(copying other: ReaderThemeTokens, theme: ReaderTheme) {
        self.init(
            theme: theme,
            canvasBg: other.canvasBg, aura1: other.aura1, aura2: other.aura2,
            glassSurface: other.glassSurface, glassElevated: other.glassElevated, glassPill: other.glassPill,
            glassBorder: other.glassBorder, glassBorderStrong: other.glassBorderStrong, glassHighlight: other.glassHighlight,
            ink1: other.ink1, ink2: other.ink2, ink3: other.ink3, ink4: other.ink4,
            accent: other.accent, accentHover: other.accentHover, accentSoft: other.accentSoft,
            accentSofter: other.accentSofter, accentGlow: other.accentGlow,
            sonicTeal: other.sonicTeal, sonicTealSoft: other.sonicTealSoft,
            clauseIndigo: other.clauseIndigo, clauseIndigoSoft: other.clauseIndigoSoft,
            tapeBg: other.tapeBg, tapeBorder: other.tapeBorder, tapeInk: other.tapeInk,
            warn: other.warn, warnSoft: other.warnSoft, err: other.err, errSoft: other.errSoft,
            surface: other.surface, surface2: other.surface2
        )
    }

    public init(
        theme: ReaderTheme,
        canvasBg: ReaderColorToken, aura1: ReaderColorToken, aura2: ReaderColorToken,
        glassSurface: ReaderColorToken, glassElevated: ReaderColorToken, glassPill: ReaderColorToken,
        glassBorder: ReaderColorToken, glassBorderStrong: ReaderColorToken, glassHighlight: ReaderColorToken,
        ink1: ReaderColorToken, ink2: ReaderColorToken, ink3: ReaderColorToken, ink4: ReaderColorToken,
        accent: ReaderColorToken, accentHover: ReaderColorToken, accentSoft: ReaderColorToken,
        accentSofter: ReaderColorToken, accentGlow: ReaderColorToken,
        sonicTeal: ReaderColorToken, sonicTealSoft: ReaderColorToken,
        clauseIndigo: ReaderColorToken, clauseIndigoSoft: ReaderColorToken,
        tapeBg: ReaderColorToken, tapeBorder: ReaderColorToken, tapeInk: ReaderColorToken,
        warn: ReaderColorToken, warnSoft: ReaderColorToken, err: ReaderColorToken, errSoft: ReaderColorToken,
        surface: ReaderColorToken, surface2: ReaderColorToken
    ) {
        self.theme = theme
        self.canvasBg = canvasBg
        self.aura1 = aura1
        self.aura2 = aura2
        self.glassSurface = glassSurface
        self.glassElevated = glassElevated
        self.glassPill = glassPill
        self.glassBorder = glassBorder
        self.glassBorderStrong = glassBorderStrong
        self.glassHighlight = glassHighlight
        self.ink1 = ink1
        self.ink2 = ink2
        self.ink3 = ink3
        self.ink4 = ink4
        self.accent = accent
        self.accentHover = accentHover
        self.accentSoft = accentSoft
        self.accentSofter = accentSofter
        self.accentGlow = accentGlow
        self.sonicTeal = sonicTeal
        self.sonicTealSoft = sonicTealSoft
        self.clauseIndigo = clauseIndigo
        self.clauseIndigoSoft = clauseIndigoSoft
        self.tapeBg = tapeBg
        self.tapeBorder = tapeBorder
        self.tapeInk = tapeInk
        self.warn = warn
        self.warnSoft = warnSoft
        self.err = err
        self.errSoft = errSoft
        self.surface = surface
        self.surface2 = surface2
    }
}

// MARK: - 顶部导航岛三档（对齐 Windows ReaderTopBar.tsx IslandSurface）

/// 导航岛三档：阅读 / 口语 / 笔记与复习。阅读室内部路由（shelf/reading/review/notes/speak）
/// 由 `IslandSurface(folding:)` 归并到这三档高亮。
public enum IslandSurface: String, Equatable, CaseIterable {
    case reading
    case speak
    case vault

    public var label: String {
        switch self {
        case .reading: return "阅读"
        case .speak: return "口语"
        case .vault: return "笔记与复习"
        }
    }

    /// 内部路由归并：shelf/reading → 阅读、speak → 口语、review/notes → 笔记与复习
    /// （对齐 ReaderApp.tsx:1660 islandSurface）。
    public init(folding route: ReaderRouteKind) {
        switch route {
        case .shelf, .reading: self = .reading
        case .speak: self = .speak
        case .review, .notes: self = .vault
        }
    }
}

/// 阅读室内部路由种类（视图模型 Route 的纯数据镜像；书架是首页落点）。
public enum ReaderRouteKind: String, Equatable, CaseIterable {
    case shelf
    case reading
    case review
    case notes
    case speak

    /// 顶栏「书架 · X」触发器与窗口标题用的当前面名（阅读档回落文章名，由调用方传入）。
    public func surfaceTitle(articleTitle: String?) -> String? {
        switch self {
        case .shelf: return "书架"
        case .reading: return articleTitle
        case .review, .notes: return "笔记与复习"
        case .speak: return "口语陪练"
        }
    }

    /// 左上书卷胶囊的完整文案：「书架 · 当前面名」；书架页自身只写「书架」
    /// （Windows 这里会显示成「书架 · 书架」，Mac 去重）；阅读档没有文章时也只写「书架」。
    public func folioTriggerLabel(articleTitle: String?) -> String {
        guard let title = surfaceTitle(articleTitle: articleTitle), title != "书架",
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "书架"
        }
        return "书架 · \(title)"
    }
}

/// 「笔记与复习」档角标 = 待复习词数 + 未整理进笔记的生词数（ReaderTopBar.tsx:85 vaultCount）。
/// 负值按 0 计，不让坏数据把角标算成负数。
public func vaultBadgeCount(dueNow: Int, unnotedCount: Int) -> Int {
    max(0, dueNow) + max(0, unnotedCount)
}

/// 正文字体配对。
public enum ReaderFontPair: String, Codable, Equatable, CaseIterable {
    case serif
    case sans

    public var label: String {
        switch self {
        case .serif: return "衬线（宋体 + Source Serif）"
        case .sans: return "无衬线（黑体 + Inter）"
        }
    }
}

/// 朗读引擎：local = 系统 AVSpeechSynthesizer（离线），xfyun = 讯飞在线合成，
/// edge = 微软 Edge 在线合成（免费无凭据，对齐 Windows 默认引擎）。
public enum TtsProvider: String, Codable, Equatable, CaseIterable {
    case local
    case xfyun
    case edge

    public var label: String {
        switch self {
        case .local: return "系统语音（离线）"
        case .xfyun: return "讯飞在线合成"
        case .edge: return "Edge 在线"
        }
    }
}

/// 跟读评测过关阈值范围（5 分制，默认 4.2 ≈ 84 分）。
public let readerAssessPassMin = 3.0
public let readerAssessPassMax = 5.0
/// 跟读评测静音断句范围（ms）。
public let readerAssessSilenceMin = 800.0
public let readerAssessSilenceMax = 3000.0

public struct ReaderSettings: Codable, Equatable {
    public var contrastMode: ContrastMode
    public var maskTranslation: Bool
    public var maskStyle: MaskStyle
    public var showProgress: Bool
    public var zenMode: Bool
    public var theme: ReaderTheme
    /// 14–24。
    public var fontSize: Int
    /// 行距倍数 1–2.4。
    public var lineHeight: Double
    public var fontPair: ReaderFontPair
    /// 系统音色名；空串 = 引擎默认。
    public var voice: String
    /// 0.5–2.0。
    public var rate: Double
    /// 每句停顿 0–2000ms。
    public var sentencePauseMs: Double
    public var shadowingMode: Bool
    /// 朗读引擎：edge = Edge 在线（默认，免费无凭据），xfyun = 讯飞在线合成
    /// （凭据在设置），local = 系统语音（离线）。
    public var ttsProvider: TtsProvider
    /// 讯飞合成发音人（vcn），中文句用它；空串 = xiaoyan。
    public var cloudVoice: String
    /// 讯飞合成英文句发音人（vcn）；空串 = 回退 cloudVoice（再缺省 catherine）。
    public var cloudVoiceEn: String
    /// Edge 合成中文句音色（ShortName）；空串 = 晓晓（zh-CN-XiaoxiaoNeural）。
    public var edgeVoiceZh: String
    /// Edge 合成英文句音色；空串 = Ava（en-US-AvaNeural）。
    public var edgeVoiceEn: String
    /// 跟读评测：跟读句送讯飞语音评测，达到阈值才放行（凭据在设置配置）。
    public var shadowingAssess: Bool
    /// 跟读过关阈值（5 分制），默认 4.2 ≈ 84 分。
    public var shadowingPassScore: Double
    /// 跟读评测开麦方式：true = 本句读完自动开麦；false = 出「开口跟读」按钮手动开。
    public var shadowingAutoMic: Bool
    /// 跟读评测静音断句：说话停顿超过该毫秒数视为读完，默认 1500。
    public var shadowingSilenceMs: Double
    /// 词块高亮：文章翻译完成后自动跑 LLM 词块标注。
    public var chunkHighlight: Bool
    /// 生词再现标记：正文中标记已收藏的词/词块。
    public var showVocabMarks: Bool
    /// 复习模式（全局，不入文章覆盖）。
    public var reviewMode: ReviewModeSetting
    /// 专注模式（v0.8）：非当前句降透明度聚光，仅影响画报正文流。
    /// 可选字段：老 JSON 缺省读 false（schema:265 缺省 false，免迁移）。
    public var spotlightMode: Bool?
    /// 画报排版（v0.8）：prose 段落英文流 / parallel 双语对照。
    /// 可选字段：老 JSON 缺省回落 .prose（schema:269，免迁移）。
    public var spreadLayout: SpreadLayout?

    /// 生效值：缺省 false（ReadingView.tsx:97 `settings.spotlightMode ?? false` 同口径）。
    public var spotlightEnabled: Bool { spotlightMode ?? false }

    /// 生效值：缺省 prose（ReadingView.tsx:98 `settings.spreadLayout ?? "prose"` 同口径）。
    public var effectiveSpreadLayout: SpreadLayout { spreadLayout ?? .prose }

    public init(
        contrastMode: ContrastMode = .dual,
        maskTranslation: Bool = false,
        maskStyle: MaskStyle = .blank,
        showProgress: Bool = true,
        zenMode: Bool = false,
        theme: ReaderTheme = .light,
        fontSize: Int = 19,
        lineHeight: Double = 1,
        fontPair: ReaderFontPair = .serif,
        voice: String = "",
        rate: Double = 1,
        sentencePauseMs: Double = 0,
        shadowingMode: Bool = false,
        ttsProvider: TtsProvider = .edge,
        cloudVoice: String = "",
        cloudVoiceEn: String = "catherine",
        edgeVoiceZh: String = "",
        edgeVoiceEn: String = "",
        shadowingAssess: Bool = false,
        shadowingPassScore: Double = 4.2,
        shadowingAutoMic: Bool = true,
        shadowingSilenceMs: Double = 1500,
        chunkHighlight: Bool = true,
        showVocabMarks: Bool = true,
        reviewMode: ReviewModeSetting = .smart,
        spotlightMode: Bool? = nil,
        spreadLayout: SpreadLayout? = nil
    ) {
        self.contrastMode = contrastMode
        self.maskTranslation = maskTranslation
        self.maskStyle = maskStyle
        self.showProgress = showProgress
        self.zenMode = zenMode
        self.theme = theme
        self.fontSize = fontSize
        self.lineHeight = lineHeight
        self.fontPair = fontPair
        self.voice = voice
        self.rate = rate
        self.sentencePauseMs = sentencePauseMs
        self.shadowingMode = shadowingMode
        self.ttsProvider = ttsProvider
        self.cloudVoice = cloudVoice
        self.cloudVoiceEn = cloudVoiceEn
        self.edgeVoiceZh = edgeVoiceZh
        self.edgeVoiceEn = edgeVoiceEn
        self.shadowingAssess = shadowingAssess
        self.shadowingPassScore = shadowingPassScore
        self.shadowingAutoMic = shadowingAutoMic
        self.shadowingSilenceMs = shadowingSilenceMs
        self.chunkHighlight = chunkHighlight
        self.showVocabMarks = showVocabMarks
        self.reviewMode = reviewMode
        self.spotlightMode = spotlightMode
        self.spreadLayout = spreadLayout
    }

    public static let `default` = ReaderSettings()
}

public let readerFontSizeMin = 14
public let readerFontSizeMax = 24
public let readerRateMin = 0.5
public let readerRateMax = 2.0

/// 阅读设置覆盖（文章记录里允许只带部分字段）。全部可选、透传；
/// 语义解释在 mergeReaderSettings。schema: contracts reading-room readerSettings。
public struct ReaderSettingsOverride: Codable, Equatable {
    public var contrastMode: String?
    public var maskTranslation: Bool?
    public var maskStyle: String?
    public var showProgress: Bool?
    public var zenMode: Bool?
    public var theme: String?
    public var fontSize: Double?
    public var lineHeight: Double?
    public var fontPair: String?
    public var voice: String?
    public var rate: Double?
    public var sentencePauseMs: Double?
    public var shadowingMode: Bool?
    public var ttsProvider: String?
    public var cloudVoice: String?
    public var cloudVoiceEn: String?
    public var edgeVoiceZh: String?
    public var edgeVoiceEn: String?
    public var shadowingAssess: Bool?
    public var shadowingPassScore: Double?
    public var shadowingAutoMic: Bool?
    public var shadowingSilenceMs: Double?
    public var chunkHighlight: Bool?
    public var showVocabMarks: Bool?
    /// reviewMode 只进全局默认，文章覆盖不承载（Windows 同口径）。
    public var reviewMode: String?
    /// 专注模式（v0.8，可选透传）。
    public var spotlightMode: Bool?
    /// 画报排版（v0.8，可选透传；非法值 merge 时忽略）。
    public var spreadLayout: String?

    public init() {}

    public init(patch: [String: Any]) {
        self.contrastMode = patch["contrastMode"] as? String
        self.maskTranslation = patch["maskTranslation"] as? Bool
        self.maskStyle = patch["maskStyle"] as? String
        self.showProgress = patch["showProgress"] as? Bool
        self.zenMode = patch["zenMode"] as? Bool
        self.theme = patch["theme"] as? String
        self.fontSize = patch["fontSize"] as? Double
        self.lineHeight = patch["lineHeight"] as? Double
        self.fontPair = patch["fontPair"] as? String
        self.voice = patch["voice"] as? String
        self.rate = patch["rate"] as? Double
        self.sentencePauseMs = patch["sentencePauseMs"] as? Double
        self.shadowingMode = patch["shadowingMode"] as? Bool
        self.chunkHighlight = patch["chunkHighlight"] as? Bool
        self.showVocabMarks = patch["showVocabMarks"] as? Bool
        self.reviewMode = patch["reviewMode"] as? String
        self.spotlightMode = patch["spotlightMode"] as? Bool
        self.spreadLayout = patch["spreadLayout"] as? String
    }

    enum CodingKeys: String, CodingKey {
        case contrastMode, maskTranslation, maskStyle, showProgress, zenMode, theme
        case fontSize, lineHeight, fontPair, voice, rate, sentencePauseMs
        case shadowingMode, ttsProvider, cloudVoice, cloudVoiceEn
        case edgeVoiceZh, edgeVoiceEn
        case shadowingAssess, shadowingPassScore, shadowingAutoMic, shadowingSilenceMs
        case chunkHighlight, showVocabMarks, reviewMode
        case spotlightMode, spreadLayout
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        contrastMode = try c.decodeIfPresent(String.self, forKey: .contrastMode)
        maskTranslation = try c.decodeIfPresent(Bool.self, forKey: .maskTranslation)
        maskStyle = try c.decodeIfPresent(String.self, forKey: .maskStyle)
        showProgress = try c.decodeIfPresent(Bool.self, forKey: .showProgress)
        zenMode = try c.decodeIfPresent(Bool.self, forKey: .zenMode)
        theme = try c.decodeIfPresent(String.self, forKey: .theme)
        fontSize = try c.decodeIfPresent(Double.self, forKey: .fontSize)
        lineHeight = try c.decodeIfPresent(Double.self, forKey: .lineHeight)
        fontPair = try c.decodeIfPresent(String.self, forKey: .fontPair)
        voice = try c.decodeIfPresent(String.self, forKey: .voice)
        rate = try c.decodeIfPresent(Double.self, forKey: .rate)
        sentencePauseMs = try c.decodeIfPresent(Double.self, forKey: .sentencePauseMs)
        shadowingMode = try c.decodeIfPresent(Bool.self, forKey: .shadowingMode)
        ttsProvider = try c.decodeIfPresent(String.self, forKey: .ttsProvider)
        cloudVoice = try c.decodeIfPresent(String.self, forKey: .cloudVoice)
        cloudVoiceEn = try c.decodeIfPresent(String.self, forKey: .cloudVoiceEn)
        edgeVoiceZh = try c.decodeIfPresent(String.self, forKey: .edgeVoiceZh)
        edgeVoiceEn = try c.decodeIfPresent(String.self, forKey: .edgeVoiceEn)
        shadowingAssess = try c.decodeIfPresent(Bool.self, forKey: .shadowingAssess)
        shadowingPassScore = try c.decodeIfPresent(Double.self, forKey: .shadowingPassScore)
        shadowingAutoMic = try c.decodeIfPresent(Bool.self, forKey: .shadowingAutoMic)
        shadowingSilenceMs = try c.decodeIfPresent(Double.self, forKey: .shadowingSilenceMs)
        chunkHighlight = try c.decodeIfPresent(Bool.self, forKey: .chunkHighlight)
        showVocabMarks = try c.decodeIfPresent(Bool.self, forKey: .showVocabMarks)
        reviewMode = try c.decodeIfPresent(String.self, forKey: .reviewMode)
        // v0.8 字段宽松解码：类型不符（如字符串塞进布尔位）按缺省处理，
        // 不让坏数据打穿整份覆盖（merge 侧再挡非法枚举值）。
        spotlightMode = try? c.decodeIfPresent(Bool.self, forKey: .spotlightMode)
        spreadLayout = try? c.decodeIfPresent(String.self, forKey: .spreadLayout)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(contrastMode, forKey: .contrastMode)
        try c.encodeIfPresent(maskTranslation, forKey: .maskTranslation)
        try c.encodeIfPresent(maskStyle, forKey: .maskStyle)
        try c.encodeIfPresent(showProgress, forKey: .showProgress)
        try c.encodeIfPresent(zenMode, forKey: .zenMode)
        try c.encodeIfPresent(theme, forKey: .theme)
        try c.encodeIfPresent(fontSize, forKey: .fontSize)
        try c.encodeIfPresent(lineHeight, forKey: .lineHeight)
        try c.encodeIfPresent(fontPair, forKey: .fontPair)
        try c.encodeIfPresent(voice, forKey: .voice)
        try c.encodeIfPresent(rate, forKey: .rate)
        try c.encodeIfPresent(sentencePauseMs, forKey: .sentencePauseMs)
        try c.encodeIfPresent(shadowingMode, forKey: .shadowingMode)
        try c.encodeIfPresent(ttsProvider, forKey: .ttsProvider)
        try c.encodeIfPresent(cloudVoice, forKey: .cloudVoice)
        try c.encodeIfPresent(cloudVoiceEn, forKey: .cloudVoiceEn)
        try c.encodeIfPresent(edgeVoiceZh, forKey: .edgeVoiceZh)
        try c.encodeIfPresent(edgeVoiceEn, forKey: .edgeVoiceEn)
        try c.encodeIfPresent(shadowingAssess, forKey: .shadowingAssess)
        try c.encodeIfPresent(shadowingPassScore, forKey: .shadowingPassScore)
        try c.encodeIfPresent(shadowingAutoMic, forKey: .shadowingAutoMic)
        try c.encodeIfPresent(shadowingSilenceMs, forKey: .shadowingSilenceMs)
        try c.encodeIfPresent(chunkHighlight, forKey: .chunkHighlight)
        try c.encodeIfPresent(showVocabMarks, forKey: .showVocabMarks)
        try c.encodeIfPresent(reviewMode, forKey: .reviewMode)
        try c.encodeIfPresent(spotlightMode, forKey: .spotlightMode)
        try c.encodeIfPresent(spreadLayout, forKey: .spreadLayout)
    }

    /// 用一个合法设置 patch 覆盖（只写入 patch 里出现的字段）。
    public mutating func apply(patch: [String: Any]) {
        if let v = patch["contrastMode"] as? String { contrastMode = v }
        if let v = patch["maskTranslation"] as? Bool { maskTranslation = v }
        if let v = patch["maskStyle"] as? String { maskStyle = v }
        if let v = patch["showProgress"] as? Bool { showProgress = v }
        if let v = patch["zenMode"] as? Bool { zenMode = v }
        if let v = patch["theme"] as? String { theme = v }
        if let v = patch["fontSize"] as? Double { fontSize = v }
        if let v = patch["lineHeight"] as? Double { lineHeight = v }
        if let v = patch["fontPair"] as? String { fontPair = v }
        if let v = patch["voice"] as? String { voice = v }
        if let v = patch["rate"] as? Double { rate = v }
        if let v = patch["sentencePauseMs"] as? Double { sentencePauseMs = v }
        if let v = patch["shadowingMode"] as? Bool { shadowingMode = v }
        if let v = patch["ttsProvider"] as? String { ttsProvider = v }
        if let v = patch["cloudVoice"] as? String { cloudVoice = v }
        if let v = patch["cloudVoiceEn"] as? String { cloudVoiceEn = v }
        if let v = patch["edgeVoiceZh"] as? String { edgeVoiceZh = v }
        if let v = patch["edgeVoiceEn"] as? String { edgeVoiceEn = v }
        if let v = patch["shadowingAssess"] as? Bool { shadowingAssess = v }
        if let v = patch["shadowingPassScore"] as? Double { shadowingPassScore = v }
        if let v = patch["shadowingAutoMic"] as? Bool { shadowingAutoMic = v }
        if let v = patch["shadowingSilenceMs"] as? Double { shadowingSilenceMs = v }
        if let v = patch["chunkHighlight"] as? Bool { chunkHighlight = v }
        if let v = patch["showVocabMarks"] as? Bool { showVocabMarks = v }
        if let v = patch["reviewMode"] as? String { reviewMode = v }
        if let v = patch["spotlightMode"] as? Bool { spotlightMode = v }
        if let v = patch["spreadLayout"] as? String { spreadLayout = v }
    }
}

/// 合并全局默认与文章覆盖。只接受覆盖里类型合法的字段，
/// 防止旧版本/坏数据把设置打穿（例如 fontSize 为字符串）。对齐 readerTypes.mergeReaderSettings。
public func mergeReaderSettings(_ global: ReaderSettings, _ override: ReaderSettingsOverride?) -> ReaderSettings {
    var merged = global
    guard let o = override else { return merged }

    if let v = o.contrastMode, let parsed = ContrastMode(rawValue: v) { merged.contrastMode = parsed }
    if let v = o.maskTranslation { merged.maskTranslation = v }
    if let v = o.maskStyle, let parsed = MaskStyle(rawValue: v) { merged.maskStyle = parsed }
    if let v = o.showProgress { merged.showProgress = v }
    if let v = o.zenMode { merged.zenMode = v }
    if let v = o.theme, let parsed = ReaderTheme(rawValue: v) { merged.theme = parsed }
    if let v = o.fontSize, v.isFinite {
        merged.fontSize = min(readerFontSizeMax, max(readerFontSizeMin, Int(v.rounded())))
    }
    if let v = o.lineHeight, v.isFinite, v >= 1, v <= 2.4 { merged.lineHeight = v }
    if let v = o.fontPair, let parsed = ReaderFontPair(rawValue: v) { merged.fontPair = parsed }
    if let v = o.voice { merged.voice = v }
    if let v = o.rate, v.isFinite {
        merged.rate = min(readerRateMax, max(readerRateMin, v))
    }
    if let v = o.sentencePauseMs, v.isFinite {
        merged.sentencePauseMs = min(2000, max(0, v.rounded()))
    }
    if let v = o.shadowingMode { merged.shadowingMode = v }
    if let v = o.ttsProvider, let parsed = TtsProvider(rawValue: v) { merged.ttsProvider = parsed }
    if let v = o.cloudVoice { merged.cloudVoice = v }
    if let v = o.cloudVoiceEn { merged.cloudVoiceEn = v }
    if let v = o.edgeVoiceZh { merged.edgeVoiceZh = v }
    if let v = o.edgeVoiceEn { merged.edgeVoiceEn = v }
    if let v = o.shadowingAssess { merged.shadowingAssess = v }
    if let v = o.shadowingPassScore, v.isFinite {
        merged.shadowingPassScore = min(readerAssessPassMax, max(readerAssessPassMin, v))
    }
    if let v = o.shadowingAutoMic { merged.shadowingAutoMic = v }
    if let v = o.shadowingSilenceMs, v.isFinite {
        merged.shadowingSilenceMs = min(readerAssessSilenceMax, max(readerAssessSilenceMin, v.rounded()))
    }
    if let v = o.chunkHighlight { merged.chunkHighlight = v }
    if let v = o.showVocabMarks { merged.showVocabMarks = v }
    if let v = o.reviewMode, let parsed = ReviewModeSetting(rawValue: v) { merged.reviewMode = parsed }
    // v0.8 画报字段：spotlight 布尔透传；spreadLayout 非法值忽略回落缺省
    //（ReadingView.tsx:97-98 的 `?? false` / `?? "prose"` 同口径）。
    if let v = o.spotlightMode { merged.spotlightMode = v }
    if let v = o.spreadLayout, let parsed = SpreadLayout(rawValue: v) { merged.spreadLayout = parsed }
    return merged
}

/// 计算两次设置之间的字段差异，产出可写进文章覆盖的 patch（只含变化的字段）。
/// reviewMode 只进全局默认，不产 patch（Windows 同口径：复习设置不随文章变化）。
public func readerSettingsPatch(from old: ReaderSettings, to new: ReaderSettings) -> [String: Any] {
    var patch: [String: Any] = [:]
    if old.contrastMode != new.contrastMode { patch["contrastMode"] = new.contrastMode.rawValue }
    if old.maskTranslation != new.maskTranslation { patch["maskTranslation"] = new.maskTranslation }
    if old.maskStyle != new.maskStyle { patch["maskStyle"] = new.maskStyle.rawValue }
    if old.showProgress != new.showProgress { patch["showProgress"] = new.showProgress }
    if old.zenMode != new.zenMode { patch["zenMode"] = new.zenMode }
    if old.theme != new.theme { patch["theme"] = new.theme.rawValue }
    if old.fontSize != new.fontSize { patch["fontSize"] = Double(new.fontSize) }
    if old.lineHeight != new.lineHeight { patch["lineHeight"] = new.lineHeight }
    if old.fontPair != new.fontPair { patch["fontPair"] = new.fontPair.rawValue }
    if old.voice != new.voice { patch["voice"] = new.voice }
    if old.rate != new.rate { patch["rate"] = new.rate }
    if old.sentencePauseMs != new.sentencePauseMs { patch["sentencePauseMs"] = new.sentencePauseMs }
    if old.shadowingMode != new.shadowingMode { patch["shadowingMode"] = new.shadowingMode }
    if old.ttsProvider != new.ttsProvider { patch["ttsProvider"] = new.ttsProvider.rawValue }
    if old.cloudVoice != new.cloudVoice { patch["cloudVoice"] = new.cloudVoice }
    if old.cloudVoiceEn != new.cloudVoiceEn { patch["cloudVoiceEn"] = new.cloudVoiceEn }
    if old.edgeVoiceZh != new.edgeVoiceZh { patch["edgeVoiceZh"] = new.edgeVoiceZh }
    if old.edgeVoiceEn != new.edgeVoiceEn { patch["edgeVoiceEn"] = new.edgeVoiceEn }
    if old.shadowingAssess != new.shadowingAssess { patch["shadowingAssess"] = new.shadowingAssess }
    if old.shadowingPassScore != new.shadowingPassScore { patch["shadowingPassScore"] = new.shadowingPassScore }
    if old.shadowingAutoMic != new.shadowingAutoMic { patch["shadowingAutoMic"] = new.shadowingAutoMic }
    if old.shadowingSilenceMs != new.shadowingSilenceMs { patch["shadowingSilenceMs"] = new.shadowingSilenceMs }
    if old.chunkHighlight != new.chunkHighlight { patch["chunkHighlight"] = new.chunkHighlight }
    if old.showVocabMarks != new.showVocabMarks { patch["showVocabMarks"] = new.showVocabMarks }
    // v0.8 画报字段：写出具体生效值（nil 归位 = 默认值），老覆盖缺字段不受影响。
    if old.spotlightMode != new.spotlightMode { patch["spotlightMode"] = new.spotlightMode ?? false }
    if old.spreadLayout != new.spreadLayout { patch["spreadLayout"] = (new.spreadLayout ?? .prose).rawValue }
    return patch
}

/// 把默认设置收敛到合法范围（供全局默认保存前兜底）。
public func clampReaderSettings(_ settings: inout ReaderSettings) {
    settings.fontSize = min(readerFontSizeMax, max(readerFontSizeMin, settings.fontSize))
    settings.lineHeight = min(2.4, max(1, settings.lineHeight))
    settings.rate = min(readerRateMax, max(readerRateMin, settings.rate))
    settings.sentencePauseMs = min(2000, max(0, settings.sentencePauseMs))
    settings.shadowingPassScore = min(readerAssessPassMax, max(readerAssessPassMin, settings.shadowingPassScore))
    settings.shadowingSilenceMs = min(readerAssessSilenceMax, max(readerAssessSilenceMin, settings.shadowingSilenceMs))
}
