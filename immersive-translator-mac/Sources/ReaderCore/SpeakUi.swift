import Foundation

/// 口语陪练页的纯展示逻辑（无 SwiftUI / 无 IO，可单测）：目标词进度、「下一个该用
/// 的词」、句内目标词高亮、场景中心目录卡（摘要取值 + 分类筛选 + 截断）。
/// 对齐 Windows src/core/speakUi.ts 本领域子集（micTip/friendlyNotice/scorePct 等
/// 已有 Mac 对应物或归别的领域，不在此重复）。

// MARK: - 目标词进度 / 下一个该用的词

public struct SpeakTargetProgress: Equatable, Sendable {
    public var hit: Int
    public var total: Int
    /// 0–100 整数，进度条宽度。
    public var pct: Int
    public var label: String

    public init(hit: Int, total: Int, pct: Int, label: String) {
        self.hit = hit
        self.total = total
        self.pct = pct
        self.label = label
    }
}

/// 目标词进度；没有目标词（普通场景）返回 nil，场景条不画进度。
/// 命中数夹到 [0, total]；pct = round(hit/total*100)；label 逐字「已用上 {hit} / {total} 个词」。
public func targetProgress(hit: Int, total: Int) -> SpeakTargetProgress? {
    guard total > 0 else { return nil }
    let h = min(total, max(0, hit))
    let pct = Int((Double(h) / Double(total) * 100).rounded())
    return SpeakTargetProgress(hit: h, total: total, pct: pct, label: "已用上 \(h) / \(total) 个词")
}

/// 按传入顺序找第一个还没用上的词，用来高亮「这一题最贴合的词」；全部用上或为空返回 nil。
public func nextTargetKey(_ keys: [String], hit: Set<String>) -> String? {
    keys.first { !hit.contains($0) }
}

// MARK: - 句内目标词高亮

/// 目标词/词块在原文里的命中区间（半开 [start, end)，**UTF-16 单元下标**——与 JS
/// 字符下标同口径，可直接喂 NSRange）。
public struct TargetSpan: Equatable, Sendable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    public var nsRange: NSRange { NSRange(location: start, length: max(0, end - start)) }
}

/// 目标词的词数（与 textHitsTarget 同款归一：小写、非 [a-z0-9'-] 置空格、按空白切）。
private func targetWordCount(_ target: String) -> Int {
    let lowered = target.lowercased()
    var out = String()
    out.reserveCapacity(lowered.count)
    for scalar in lowered.unicodeScalars {
        let allowed = (scalar.value >= UnicodeScalar("a").value && scalar.value <= UnicodeScalar("z").value)
            || (scalar.value >= UnicodeScalar("0").value && scalar.value <= UnicodeScalar("9").value)
            || scalar == "'" || scalar == "-"
        out.unicodeScalars.append(allowed ? scalar : " ")
    }
    return out.split(separator: " ").filter { !$0.isEmpty }.count
}

private let speakWordTokenRegex = try! NSRegularExpression(pattern: #"[A-Za-z0-9'\-]+"#)

/// 目标词/词块在原文里的命中区间。判定不另写一套：把原文按 textHitsTarget 同款分词
/// 切成词，对每个「目标词数」大小的窗口直接调 textHitsTarget——高亮与芯片打勾口径
/// 由构造保证一致；区间互不重叠；末词屈折命中取实际说出的形式。
public func findTargetSpans(_ text: String, _ target: String) -> [TargetSpan] {
    let n = targetWordCount(target)
    guard n > 0, !text.isEmpty else { return [] }
    let ns = text as NSString
    let tokens = speakWordTokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
        (start: m.range.location, end: m.range.location + m.range.length, word: ns.substring(with: m.range))
    }
    var spans: [TargetSpan] = []
    var i = 0
    while i + n <= tokens.count {
        let window = tokens[i..<(i + n)].map(\.word).joined(separator: " ")
        if textHitsTarget(window, target) {
            spans.append(TargetSpan(start: tokens[i].start, end: tokens[i + n - 1].end))
            i += n  // 区间互不重叠
        } else {
            i += 1
        }
    }
    return spans
}

public struct AnnotatedSegment: Equatable, Sendable {
    public var start: Int
    public var end: Int
    /// 覆盖该段的发音标记在传入数组中的下标；-1 = 无。多个覆盖时取第一个。
    public var markIdx: Int
    /// 该段是否落在目标词命中区间内。
    public var target: Bool

    public init(start: Int, end: Int, markIdx: Int, target: Bool) {
        self.start = start
        self.end = end
        self.markIdx = markIdx
        self.target = target
    }
}

/// 把一句话按「发音标记」与「目标词区间」两层区间的边界切段，相邻且属性相同的段合并。
/// 用来在同一句里同时渲染词着色（发音）和目标词高亮；区间越界时夹到 [0, length]
/// （length 按 UTF-16 单元计）。空文本返回空数组。
public func annotateSegments(_ text: String, marks: [TargetSpan], targets: [TargetSpan]) -> [AnnotatedSegment] {
    let len = (text as NSString).length
    guard len > 0 else { return [] }
    let clamp = { (v: Int) in min(len, max(0, v)) }
    var bounds: Set<Int> = [0, len]
    for s in marks + targets {
        bounds.insert(clamp(s.start))
        bounds.insert(clamp(s.end))
    }
    let cuts = bounds.sorted()
    let covers = { (s: TargetSpan, at: Int) in clamp(s.start) <= at && clamp(s.end) > at }
    var out: [AnnotatedSegment] = []
    var i = 0
    while i + 1 < cuts.count {
        let a = cuts[i]
        let b = cuts[i + 1]
        let markIdx = marks.firstIndex { covers($0, a) } ?? -1
        let target = targets.contains { covers($0, a) }
        if let last = out.last, last.markIdx == markIdx, last.target == target {
            out[out.count - 1].end = b
        } else {
            out.append(AnnotatedSegment(start: a, end: b, markIdx: markIdx, target: target))
        }
        i += 1
    }
    return out
}

// MARK: - 场景中心目录卡（官方库/我的场景的紧凑卡：摘要取值 + 分类筛选 + 截断）

/// 官方库收起态默认渲染的卡片数（「展开全部 N 个」按钮的分界）。
public let scenarioPreviewLimit = 8

/// 紧凑卡摘要：优先练习目标 goal（一句话说清这局练什么），缺失/全空白时回退
/// aiRole——那是写给 LLM 的角色设定，仅在 goal 缺位时兜底。
public func scenarioSummary(goal: String?, aiRole: String) -> String {
    let trimmed = goal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? aiRole : trimmed
}

public func scenarioSummary(_ sc: SpeakScenario) -> String {
    scenarioSummary(goal: sc.goal, aiRole: sc.aiRole)
}

/// 分类筛选取值：全部 或 某个具体分类。
public enum ScenarioFilter: Equatable, Sendable {
    case all
    case category(SpeakScenarioCategory)
}

/// 分类的固定展示序（chips 顺序不随数据序漂移）。
public let scenarioCategoryDisplayOrder: [SpeakScenarioCategory] = [.daily, .travel, .workplace, .academic, .custom]

public struct ScenarioCategoryCount: Equatable, Sendable {
    public var category: SpeakScenarioCategory
    public var count: Int

    public init(category: SpeakScenarioCategory, count: Int) {
        self.category = category
        self.count = count
    }
}

/// 按固定展示序统计各分类数量，只保留实际有场景的分类。
public func scenarioCategoryCounts(_ list: [SpeakScenario]) -> [ScenarioCategoryCount] {
    var counts: [SpeakScenarioCategory: Int] = [:]
    for sc in list {
        counts[sc.category, default: 0] += 1
    }
    return scenarioCategoryDisplayOrder.compactMap { category in
        guard let count = counts[category], count > 0 else { return nil }
        return ScenarioCategoryCount(category: category, count: count)
    }
}

public struct ScenarioPreview: Equatable, Sendable {
    /// 当前应渲染的场景（收起且超限时为注册序前 limit 个）。
    public var visible: [SpeakScenario]
    /// 筛选后的总数（「展开全部 N 个」的 N）。
    public var total: Int
    /// 是否还有没显示的（收起态被截断时为 true，决定展开按钮是否渲染）。
    public var hasMore: Bool

    public init(visible: [SpeakScenario], total: Int, hasMore: Bool) {
        self.visible = visible
        self.total = total
        self.hasMore = hasMore
    }
}

/// 筛选 + 截断：收起且超过 limit 时只渲染前 limit 张（保持注册序 = 服务端目录序）；
/// 展开或数量不多（≤ limit）时全量显示，此时 hasMore=false 不出展开按钮。不修改传入列表。
public func filterScenarioPreview(
    _ list: [SpeakScenario], filter: ScenarioFilter, expanded: Bool, limit: Int = scenarioPreviewLimit
) -> ScenarioPreview {
    let filtered: [SpeakScenario]
    switch filter {
    case .all: filtered = list
    case .category(let category): filtered = list.filter { $0.category == category }
    }
    let visible = (expanded || filtered.count <= limit) ? filtered : Array(filtered.prefix(limit))
    return ScenarioPreview(visible: visible, total: filtered.count, hasMore: visible.count < filtered.count)
}
