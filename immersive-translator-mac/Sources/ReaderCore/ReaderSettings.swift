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

public enum ReaderTheme: String, Codable, Equatable, CaseIterable {
    case light
    case dark
    case sepia
    case oled

    public var label: String {
        switch self {
        case .light: return "浅色"
        case .dark: return "深色"
        case .sepia: return "护眼"
        case .oled: return "纯黑"
        }
    }
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
    /// 词块高亮：文章翻译完成后自动跑 LLM 词块标注。
    public var chunkHighlight: Bool
    /// 生词再现标记：正文中标记已收藏的词/词块。
    public var showVocabMarks: Bool
    /// 复习模式（全局，不入文章覆盖）。
    public var reviewMode: ReviewModeSetting

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
        chunkHighlight: Bool = true,
        showVocabMarks: Bool = true,
        reviewMode: ReviewModeSetting = .smart
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
        self.chunkHighlight = chunkHighlight
        self.showVocabMarks = showVocabMarks
        self.reviewMode = reviewMode
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
    public var chunkHighlight: Bool?
    public var showVocabMarks: Bool?
    /// reviewMode 只进全局默认，文章覆盖不承载（Windows 同口径）。
    public var reviewMode: String?

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
    }

    enum CodingKeys: String, CodingKey {
        case contrastMode, maskTranslation, maskStyle, showProgress, zenMode, theme
        case fontSize, lineHeight, fontPair, voice, rate, sentencePauseMs
        case shadowingMode, chunkHighlight, showVocabMarks, reviewMode
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
        chunkHighlight = try c.decodeIfPresent(Bool.self, forKey: .chunkHighlight)
        showVocabMarks = try c.decodeIfPresent(Bool.self, forKey: .showVocabMarks)
        reviewMode = try c.decodeIfPresent(String.self, forKey: .reviewMode)
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
        try c.encodeIfPresent(chunkHighlight, forKey: .chunkHighlight)
        try c.encodeIfPresent(showVocabMarks, forKey: .showVocabMarks)
        try c.encodeIfPresent(reviewMode, forKey: .reviewMode)
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
        if let v = patch["chunkHighlight"] as? Bool { chunkHighlight = v }
        if let v = patch["showVocabMarks"] as? Bool { showVocabMarks = v }
        if let v = patch["reviewMode"] as? String { reviewMode = v }
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
    if let v = o.chunkHighlight { merged.chunkHighlight = v }
    if let v = o.showVocabMarks { merged.showVocabMarks = v }
    if let v = o.reviewMode, let parsed = ReviewModeSetting(rawValue: v) { merged.reviewMode = parsed }
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
    if old.chunkHighlight != new.chunkHighlight { patch["chunkHighlight"] = new.chunkHighlight }
    if old.showVocabMarks != new.showVocabMarks { patch["showVocabMarks"] = new.showVocabMarks }
    return patch
}

/// 把默认设置收敛到合法范围（供全局默认保存前兜底）。
public func clampReaderSettings(_ settings: inout ReaderSettings) {
    settings.fontSize = min(readerFontSizeMax, max(readerFontSizeMin, settings.fontSize))
    settings.lineHeight = min(2.4, max(1, settings.lineHeight))
    settings.rate = min(readerRateMax, max(readerRateMin, settings.rate))
    settings.sentencePauseMs = min(2000, max(0, settings.sentencePauseMs))
}
