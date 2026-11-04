import Foundation

// MARK: - 「笔记与复习」三档评分带与 vault 表面派生（VaultPage.tsx:122-151 的 Mac 对应物）
//
// 三档：没记住→forgot / 有点模糊→hard / 记住了→good（一次写对的 easy 建议档
// 收敛为 good）。间隔副行从 gradeIntervalMs 派生（间隔定值若调整会自动跟随，
// 不写死矛盾间隔）；GRADE_COPY 四档契约（ReviewGrade.label/nextLabel）不动。

/// 一档评分带：档位 + 名称 + 快捷键（focus 态已判分后 1–3 直选）。
public struct VaultGradeBand: Equatable {
    public let grade: ReviewGrade
    public let name: String
    public let key: String

    public init(grade: ReviewGrade, name: String, key: String) {
        self.grade = grade
        self.name = name
        self.key = key
    }
}

/// vault 表面专用三档（ReviewView 四档带在听写卡继续用，判分链路零改动）。
public let vaultGradeBands: [VaultGradeBand] = [
    VaultGradeBand(grade: .forgot, name: "没记住", key: "1"),
    VaultGradeBand(grade: .hard, name: "有点模糊", key: "2"),
    VaultGradeBand(grade: .good, name: "记住了", key: "3"),
]

/// 评分带的间隔副行：forgot=10 分钟后再来 / hard=明天再看 / good=3 天后再看
///（Windows vaultNextLabel 同口径：分钟<60 → N 分钟后再来；天≤1 → 明天再看）。
public func vaultNextLabel(_ grade: ReviewGrade) -> String {
    let minutes = Int((Double(gradeIntervalMs(grade)) / 60_000).rounded())
    if minutes < 60 { return "\(minutes) 分钟后再来" }
    let days = Int((Double(minutes) / (24 * 60)).rounded())
    if days <= 1 { return "明天再看" }
    return "\(days) 天后再看"
}

/// 完形/听写判分的建议档收敛到 vault 三档：easy → good（Windows vaultSuggested）。
public func vaultSuggested(_ verdict: RecallVerdict) -> ReviewGrade {
    let g = verdictToSuggestedGrade(verdict)
    return g == .easy ? .good : g
}

/// 上一关 outcome 条的档名：vault 三档名优先；easy 不在三档里，回落
/// 四档 GRADE_COPY 的 label「很轻松」（Windows `VAULT_GRADE_BANDS.find… ?? GRADE_COPY[g].name`）。
public func vaultGradeName(_ grade: ReviewGrade) -> String {
    vaultGradeBands.first { $0.grade == grade }?.name ?? grade.label
}

/// 复习一分钟数：与 Hero / 看板共用同一口径（N=0 时为 1，避免出现「0 分钟」；
/// Windows vaultMinutes：max(1, ceil(n * 0.6))）。
public func vaultMinutes(_ n: Int) -> Int {
    max(1, Int(ceil(Double(n) * 0.6)))
}

// MARK: - 阅读页左缘进度轨（ReadingView.tsx:484 / :1021-1029 的纯逻辑）

/// 进度轨百分比：total>0 ? max(1, round((activeIdx+1)/total*100)) : 0
/// ——与 dock 同口径（光标句/总句，跟随播放与滚动阅读）。
public func readingRailPercent(activeIdx: Int, total: Int) -> Int {
    guard total > 0 else { return 0 }
    return max(1, Int(((Double(activeIdx) + 1) / Double(total) * 100).rounded()))
}

/// 进度轨 label：书章 `CHAPTER N`（N 从 1 起）；短文直接放文章标题。
public func readingRailLabel(chapterIdx: Int?, articleTitle: String) -> String {
    if let chapterIdx { return "CHAPTER \(chapterIdx + 1)" }
    return articleTitle
}
