import Foundation

// MARK: - 专注复习（focus 态）会话纯状态机（VaultPage.tsx:690-854 FocusStage 的逻辑层）
//
// 队列语义与 ReaderApp 完全一致：due = focusIds 或全局到期、评分即出队（由评分落盘后
// 刷新队列实现，这里不持有队列）、pos 受控游标、Esc 退出只切档不清 focusIds。
// 本文件只承载可单测的纯逻辑：轮转三卡、原句缺失降级、评分防重入、放弃回绕、
// 队列耗尽收拢、上一关 outcome 文案。SwiftUI 侧（ReaderVaultView）消费。

/// 轮转三卡形态。
public enum VaultFocusCardKind: Equatable {
    case cloze
    case dictation
    case speak
}

/// 轮转顺序：完形 → 听写 → 开口（每评/跳一关 step+1；Windows CHALLENGE_ROTATION）。
public let vaultFocusRotation: [VaultFocusCardKind] = [.cloze, .dictation, .speak]

/// 按步数取期望形态。
public func vaultFocusDesiredKind(step: Int) -> VaultFocusCardKind {
    vaultFocusRotation[((step % vaultFocusRotation.count) + vaultFocusRotation.count) % vaultFocusRotation.count]
}

/// 当前卡的实际形态（VaultPage.tsx:724-750）：期望开口 → 开口；原句缺失 → 完形/听写
/// 降级为开口；期望听写有句即听写；期望完形还要能在原句里定位到目标词（blankFound），
/// 否则同样降级为开口卡。
public func vaultFocusEffectiveKind(
    desired: VaultFocusCardKind,
    hasSentence: Bool,
    blankFound: Bool
) -> VaultFocusCardKind {
    if desired == .speak || !hasSentence { return .speak }
    if desired == .dictation { return .dictation }
    return blankFound ? .cloze : .speak
}

/// 上一关 outcome 条文案（VaultPage.tsx:771-774 / :786 / :794）。
public enum VaultFocusOutcomeText {
    /// 评分：`已按「{档名}」完成`——三档带用 vault 文案；听写卡四档带的 easy
    /// 回落 GRADE_COPY「很轻松」，否则 easy 会落进「没记住」。
    public static func graded(_ grade: ReviewGrade) -> String {
        "已按「\(vaultGradeName(grade))」完成"
    }

    /// 开口卡命中目标词。
    public static let spoken = "开口命中 · 已按「很轻松」完成并记一次口语表达"

    /// 放弃（跳过不评分）。
    public static let skipped = "跳过（未评分）"
}

/// 生词来源统一判别（Windows ad2ad68 VaultPage/VocabListPanel 的三态判据）：
/// articleId 为空 → 划词收藏；articleId 非空且标题解析得到 → 文章来源；
/// articleId 非空但文章已删（标题解析不到）→ 原文不可用。
public enum VaultSourceOrigin: Equatable {
    case popup
    case article(title: String)
    case unavailable
}

public func vaultSourceOrigin(articleId: String, articleTitle: String?) -> VaultSourceOrigin {
    guard !articleId.isEmpty else { return .popup }
    if let articleTitle, !articleTitle.isEmpty { return .article(title: articleTitle) }
    return .unavailable
}

/// 原文不可用标签（来源为已删文章的生词统一文案，供 focus 卡/复习卡/列表/rail 复用）。
public let vaultSourceUnavailableLabel = "原文不可用"

/// focus 卡 q-meta 的来源（VaultPage.tsx:853-860，ad2ad68 后三态）：`来自《{title}》` /
/// `原文不可用`（articleId 非空但文章已删）/ `来自划词收藏`。
public func vaultFocusSourceLabel(articleId: String, articleTitle: String?) -> String {
    switch vaultSourceOrigin(articleId: articleId, articleTitle: articleTitle) {
    case .popup: return "来自划词收藏"
    case .article(let title): return "来自《\(title)》"
    case .unavailable: return vaultSourceUnavailableLabel
    }
}

/// 专注会话（不含队列本体——队列由 vm.reviewQueue / focusIds 驱动，评分落盘后自然出队）。
public struct VaultFocusSession: Equatable {
    public struct Outcome: Equatable {
        public let word: String
        public let text: String

        public init(word: String, text: String) {
            self.word = word
            self.text = text
        }
    }

    /// 轮转步（每评/跳一关 +1）。
    public private(set) var step = 0
    /// 上一关结果条。
    public private(set) var outcome: Outcome?
    /// 防重入：评分后到队列刷新的间隙里同一张卡只允许评一次（Windows gradedRef）。
    public private(set) var gradedIds: Set<String> = []

    public init() {}

    /// 当前期望形态。
    public var desiredKind: VaultFocusCardKind { vaultFocusDesiredKind(step: step) }

    /// 普通评分（三档带 / 听写四档带）。返回 false = 该卡已评过，本次忽略。
    @discardableResult
    public mutating func grade(wordId: String, word: String, grade: ReviewGrade) -> Bool {
        guard !gradedIds.contains(wordId) else { return false }
        gradedIds.insert(wordId)
        outcome = Outcome(word: word, text: VaultFocusOutcomeText.graded(grade))
        step += 1
        return true
    }

    /// 开口卡命中目标词（easy 档 + spokenAt 由调用方落盘）。返回 false = 已评过。
    @discardableResult
    public mutating func passSpeak(wordId: String, word: String) -> Bool {
        guard !gradedIds.contains(wordId) else { return false }
        gradedIds.insert(wordId)
        outcome = Outcome(word: word, text: VaultFocusOutcomeText.spoken)
        step += 1
        return true
    }

    /// 放弃（跳过不评分）：词不离队，游标手动推进；末尾回绕到 0
    ///（Windows `onSetPos(due.length > pos + 1 ? pos + 1 : 0)`）。返回新游标。
    public mutating func skip(word: String, pos: Int, total: Int) -> Int {
        outcome = Outcome(word: word, text: VaultFocusOutcomeText.skipped)
        step += 1
        return total > pos + 1 ? pos + 1 : 0
    }

    /// 队列耗尽（评完最后一张）时收拢游标，保证计数显示正确（Windows :711-713）。
    public static func settledPos(_ pos: Int, total: Int) -> Int {
        pos >= total ? 0 : pos
    }

    /// 进度条宽度百分比：due.length>0 ? min(pos+1, due.length)/due.length*100 : 0。
    public static func progressPercent(pos: Int, total: Int) -> Double {
        guard total > 0 else { return 0 }
        return Double(min(pos + 1, total)) / Double(total) * 100
    }

    /// 计数文案 `{min(pos+1, max(total,1))} / {total}`。
    public static func counterText(pos: Int, total: Int) -> String {
        "\(min(pos + 1, max(total, 1))) / \(total)"
    }
}
