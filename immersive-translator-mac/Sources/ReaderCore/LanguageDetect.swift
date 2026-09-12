import Foundation

/// 文本语言判定与目标语言解析（阅读室各管线共用）。
/// 对齐 src/core/languageDetect.ts 与 Mac 版 TranslationClient.looksMostlyChinese。

/// 判断文本是否主要是中文。规则：忽略空白和标点；统计汉字与字母；
/// 汉字数 >= 4 或 汉字数 >= 字母数 即视为中文。
public func looksMostlyChinese(_ text: String) -> Bool {
    var chineseCount = 0
    var letterCount = 0

    for scalar in text.unicodeScalars {
        if scalar.properties.isWhitespace {
            continue
        }
        // 通用 Unicode 标点
        if scalar.properties.generalCategory == .otherPunctuation
            || scalar.properties.generalCategory == .openPunctuation
            || scalar.properties.generalCategory == .closePunctuation
            || scalar.properties.generalCategory == .initialPunctuation
            || scalar.properties.generalCategory == .finalPunctuation
            || scalar.properties.generalCategory == .connectorPunctuation
            || scalar.properties.generalCategory == .dashPunctuation {
            continue
        }

        switch scalar.value {
        case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
            chineseCount += 1
        case 0x0041...0x005A, 0x0061...0x007A:
            letterCount += 1
        default:
            continue
        }
    }

    guard chineseCount > 0 else { return false }
    return chineseCount >= 4 || chineseCount >= letterCount
}

public struct TargetLanguageConfig {
    /// true = auto（中文→English，非中文→简体中文）；false = 用 fixed。
    public var auto: Bool
    public var fixed: String

    public init(auto: Bool, fixed: String) {
        self.auto = auto
        self.fixed = fixed
    }
}

/// 决定目标语言。
/// - auto：中文 → English，非中文 → 简体中文。
/// - fixed：用 fixed 值，为空则回退简体中文。
public func resolveTargetLanguage(_ text: String, _ config: TargetLanguageConfig) -> String {
    if !config.auto {
        let trimmed = config.fixed.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "简体中文" : trimmed
    }
    return looksMostlyChinese(text) ? "English" : "简体中文"
}
