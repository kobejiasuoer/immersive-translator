import Foundation

/// 生词本 SRS（间隔重复）核心。对齐 src/core/readerSrs.ts。
///
/// 到期判定与所有计数共享同一份 `VocabWord.srs.dueAt` 状态：
/// 不允许出现「计数用总数、词条写下次时间」的两套账。
/// 四档评分间隔为定值；ease / reps / lapses 同步演进，供后续算法升级用。

public enum ReviewGrade: String, Codable, Equatable, CaseIterable {
    case forgot
    case hard
    case good
    case easy

    public var label: String {
        switch self {
        case .forgot: return "没想起"
        case .hard: return "很勉强"
        case .good: return "想起来了"
        case .easy: return "很轻松"
        }
    }

    /// 副行：下次什么时候见。
    public var nextLabel: String {
        switch self {
        case .forgot: return "10分钟后再来"
        case .hard: return "明天再来"
        case .good: return "3天后再来"
        case .easy: return "7天后再来"
        }
    }
}

/// 四档评分的固定间隔（毫秒）。
public func gradeIntervalMs(_ grade: ReviewGrade) -> Int64 {
    switch grade {
    case .forgot: return 10 * 60 * 1000
    case .hard: return 24 * 60 * 60 * 1000
    case .good: return 3 * 24 * 60 * 60 * 1000
    case .easy: return 7 * 24 * 60 * 60 * 1000
    }
}

private let easeDelta: [ReviewGrade: Double] = [
    .forgot: -0.2, .hard: -0.15, .good: 0, .easy: 0.15
]

private let easeMin = 1.3
private let easeMax = 2.8

private func gradeIntervalDays(_ grade: ReviewGrade) -> Double {
    switch grade {
    case .forgot: return 0
    case .hard: return 1
    case .good: return 3
    case .easy: return 7
    }
}

/// 新词当天即可复习：dueAt = now。
public func initialSrs(now: Int64) -> VocabSrsState {
    VocabSrsState(ease: 2.5, intervalDays: 0, reps: 0, dueAt: now, lapses: 0)
}

/// 应用一档评分，返回新的 SRS 状态（不修改入参）。
public func gradeSrs(_ srs: VocabSrsState, _ grade: ReviewGrade, now: Int64) -> VocabSrsState {
    let ease = min(easeMax, max(easeMin, srs.ease + (easeDelta[grade] ?? 0)))
    let forgot = grade == .forgot
    return VocabSrsState(
        ease: ease,
        // 忘记重置为 10 分钟（不足 1 天按 0 记）；其余按定值升档
        intervalDays: forgot ? 0 : max(srs.intervalDays, gradeIntervalDays(grade)),
        reps: srs.reps + 1,
        dueAt: now + gradeIntervalMs(grade),
        lapses: srs.lapses + (forgot ? 1 : 0)
    )
}

public func isDue(_ word: VocabWord, now: Int64) -> Bool {
    word.srs.dueAt <= now
}

/// 排序：最紧急的在前。
public func dueVocab(_ vocab: [VocabWord], now: Int64) -> [VocabWord] {
    vocab.filter { isDue($0, now: now) }.sorted { $0.srs.dueAt < $1.srs.dueAt }
}

// MARK: - 日期键（本地时区，打卡/今日计数用）

/// 本地时区 YYYY-MM-DD。
public func dayKey(nowMs: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(nowMs) / 1000)
    return dayKey(date: date)
}

public func dayKey(date: Date) -> String {
    let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return String(
        format: "%04ld-%02ld-%02ld",
        comps.year ?? 1970,
        comps.month ?? 1,
        comps.day ?? 1
    )
}

/// YYYY-MM-DD 偏移 n 天（n 可负）。纯公历算术，无时区依赖。
public func shiftDayKey(_ day: String, _ n: Int) -> String {
    let parts = day.split(separator: "-")
    guard parts.count == 3,
          let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
          m >= 1, m <= 12, d >= 1, d <= 31 else {
        return ""
    }
    var comps = DateComponents()
    comps.year = y
    comps.month = m
    comps.day = d
    guard let date = Calendar.current.date(from: comps) else { return "" }
    let shifted = Calendar.current.date(byAdding: .day, value: n, to: date) ?? date
    return dayKey(date: shifted)
}

// MARK: - 统计

public struct MasteryDistribution: Equatable {
    public var learning: Int
    public var familiar: Int
    public var mastered: Int

    public init(learning: Int = 0, familiar: Int = 0, mastered: Int = 0) {
        self.learning = learning
        self.familiar = familiar
        self.mastered = mastered
    }
}

public struct ReviewStats: Equatable {
    /// 到期待复习数（同一份 dueAt 判定）。
    public var dueNow: Int
    /// 今天已完成复习数（按评分时间落在本地今天）。
    public var reviewedToday: Int
    /// 全库生词数。
    public var total: Int
    /// 连续打卡天数（今天或昨天截止的连续复习日）。
    public var streak: Int
    /// 掌握度分布：按当前 intervalDays 分桶。
    public var distribution: MasteryDistribution
    /// 单词/词块分开计数；kind 缺省视为单词。
    public var totalWords: Int
    public var totalChunks: Int
    public var dueWords: Int
    public var dueChunks: Int

    public init(
        dueNow: Int = 0,
        reviewedToday: Int = 0,
        total: Int = 0,
        streak: Int = 0,
        distribution: MasteryDistribution = MasteryDistribution(),
        totalWords: Int = 0,
        totalChunks: Int = 0,
        dueWords: Int = 0,
        dueChunks: Int = 0
    ) {
        self.dueNow = dueNow
        self.reviewedToday = reviewedToday
        self.total = total
        self.streak = streak
        self.distribution = distribution
        self.totalWords = totalWords
        self.totalChunks = totalChunks
        self.dueWords = dueWords
        self.dueChunks = dueChunks
    }
}

/// 由词汇表 + 复习日志推导统计。计数与到期判定同源。nowMs 可注入以便测试。
public func reviewStats(_ vocab: [VocabWord], _ log: ReviewLogFile, nowMs: Int64) -> ReviewStats {
    let today = dayKey(nowMs: nowMs)
    let yesterday = shiftDayKey(today, -1)

    // streak：从今天（若今天没复习则从昨天）往回数连续有复习记录的天数。
    let daySet = Set(log.days.map(\.day))
    var streak = 0
    var cursor = daySet.contains(today) ? today : (daySet.contains(yesterday) ? yesterday : "")
    while !cursor.isEmpty, daySet.contains(cursor) {
        streak += 1
        cursor = shiftDayKey(cursor, -1)
    }

    var distribution = MasteryDistribution()
    var totalWords = 0
    var totalChunks = 0
    var dueWords = 0
    var dueChunks = 0
    for w in vocab {
        if w.srs.intervalDays >= 7 {
            distribution.mastered += 1
        } else if w.srs.intervalDays >= 1 {
            distribution.familiar += 1
        } else {
            distribution.learning += 1
        }
        if w.effectiveKind == .chunk {
            totalChunks += 1
            if w.srs.dueAt <= nowMs { dueChunks += 1 }
        } else {
            totalWords += 1
            if w.srs.dueAt <= nowMs { dueWords += 1 }
        }
    }

    return ReviewStats(
        dueNow: dueVocab(vocab, now: nowMs).count,
        reviewedToday: log.days.first { $0.day == today }?.count ?? 0,
        total: vocab.count,
        streak: streak,
        distribution: distribution,
        totalWords: totalWords,
        totalChunks: totalChunks,
        dueWords: dueWords,
        dueChunks: dueChunks
    )
}

/// 在复习日志上记一次评分（返回新日志，不改入参）。只保留近 365 天，防无限膨胀。
public func recordReview(_ log: ReviewLogFile, nowMs: Int64) -> ReviewLogFile {
    let day = dayKey(nowMs: nowMs)
    var days = log.days
    if let idx = days.firstIndex(where: { $0.day == day }) {
        days[idx].count += 1
    } else {
        days.append(ReviewLogDay(day: day, count: 1))
    }
    let cutoff = shiftDayKey(day, -365)
    return ReviewLogFile(schemaVersion: log.schemaVersion, days: days.filter { $0.day >= cutoff })
}

// MARK: - v0.8 内化看板派生（Phase 4；对齐 src/core/readerSrs.ts:175-220）

/// 词块内化三阶段（交接语义）：
/// - s1 刚收集（intervalDays < 1 且从未在口语中用出）
/// - s2 眼熟能认（intervalDays ≥ 1，阅读遇到能懂）
/// - s3 已变成口语表达（spokenAt 存在即升 s3——「在对话中说出」优先于间隔）
///
/// 与 reviewStats.distribution 是两套口径：distribution 按纯间隔分桶（复习闭环
/// 用），masteryStage 把「口语中用出」视为最高阶。计数一律由本函数统一派生，
/// 不得另立口径。
public enum MasteryStage: String, Equatable, CaseIterable {
    case s1
    case s2
    case s3

    /// Markdown 导出 / 看板行的三阶徽标（vaultExport.ts STAGE_BADGE 逐字）。
    public var badge: String {
        switch self {
        case .s1: return "🌱 刚收集"
        case .s2: return "👀 眼熟能认"
        case .s3: return "✨ 已变成口语表达"
        }
    }

    /// 手账行贴句子放的短标签（VaultPage.tsx TAPE_STAGE_LABELS 逐字）。
    public var tapeLabel: String {
        switch self {
        case .s1: return "刚收集 · 还没认熟"
        case .s2: return "眼熟能认 · 阅读遇到能懂"
        case .s3: return "已内化 · 在口语里用出过"
        }
    }

    /// 看板三阶行的整行文案（VaultPage.tsx STAGE_ROWS 逐字）。
    public var dashboardLabel: String {
        switch self {
        case .s1: return "🌱 刚收集（待认熟）"
        case .s2: return "👀 眼熟能认（阅读遇到能懂）"
        case .s3: return "✨ 已变成我的口语表达（在对话中说出）"
        }
    }
}

/// spokenAt 存在即 s3；否则 intervalDays ≥ 1 为 s2，不足 1 天为 s1。
public func masteryStage(_ word: VocabWord) -> MasteryStage {
    if word.spokenAt != nil { return .s3 }
    return word.srs.intervalDays >= 1 ? .s2 : .s1
}

/// 三阶计数（看板「词块内化三阶段」行；与 masteryStage 同源派生）。
public struct MasteryStageCounts: Equatable {
    public var s1: Int
    public var s2: Int
    public var s3: Int

    public init(s1: Int = 0, s2: Int = 0, s3: Int = 0) {
        self.s1 = s1
        self.s2 = s2
        self.s3 = s3
    }

    public subscript(stage: MasteryStage) -> Int {
        switch stage {
        case .s1: return s1
        case .s2: return s2
        case .s3: return s3
        }
    }
}

public func masteryStageCounts(_ vocab: [VocabWord]) -> MasteryStageCounts {
    var counts = MasteryStageCounts()
    for word in vocab {
        switch masteryStage(word) {
        case .s1: counts.s1 += 1
        case .s2: counts.s2 += 1
        case .s3: counts.s3 += 1
        }
    }
    return counts
}

/// 热力格档位：0 无记录 / 1 少（<3 次）/ 2 中（3-6 次）/ 3 多（>6 次）。
public struct HeatBucket: Equatable {
    /// 本地日期键（YYYY-MM-DD）。
    public let dayKey: String
    /// 0...3。
    public let level: Int
    /// 当日复习次数（悬浮提示用）。
    public let count: Int
    /// 是否今天这一格。
    public let isToday: Bool

    public init(dayKey: String, level: Int, count: Int, isToday: Bool) {
        self.dayKey = dayKey
        self.level = level
        self.count = count
        self.isToday = isToday
    }
}

/// 复习次数 → 档位（阈值 3 / 6，与 Windows heatBuckets 的 level 判定逐字）。
public func heatLevel(count: Int) -> Int {
    if count <= 0 { return 0 }
    if count < 3 { return 1 }
    if count <= 6 { return 2 }
    return 3
}

/// 近 28 天（含今天）每日复习次数分桶，旧 → 新排列（14 列 × 2 行矩阵）。
/// 数据源是复习日志 reviewLog.days（交接说的 stats.days 口径）。
/// 同一天重复出现时取**后写的一条**——对齐 Windows `new Map(log.days.map(...))`
/// 的后写覆盖语义（readerSrs.ts:210）；日志写入保证唯一，这里只是防御。
/// （REV-10 对照修正：此前 mac 取首条，与 Windows 口径相反。）
public func heatBuckets(_ log: ReviewLogFile, nowMs: Int64) -> [HeatBucket] {
    let byDay = Dictionary(log.days.map { ($0.day, $0.count) }, uniquingKeysWith: { _, last in last })
    let today = dayKey(nowMs: nowMs)
    var out: [HeatBucket] = []
    out.reserveCapacity(28)
    for offset in stride(from: 27, through: 0, by: -1) {
        let key = shiftDayKey(today, -offset)
        let count = byDay[key] ?? 0
        out.append(HeatBucket(dayKey: key, level: heatLevel(count: count), count: count, isToday: key == today))
    }
    return out
}

/// 易错词：错题（wrong + trap）最多的前 N 个，按错题数降序（看板「易错项靶向加练」）。
/// 同分保持入参顺序（稳定排序，与 Windows Array.prototype.sort 的稳定语义一致）。
public func weakVocab(_ vocab: [VocabWord], limit: Int = 3) -> [(word: VocabWord, bad: Int)] {
    struct Entry {
        let index: Int
        let word: VocabWord
        let bad: Int
    }
    var entries: [Entry] = []
    for (index, word) in vocab.enumerated() {
        let wrong = word.recall?.total.wrong ?? 0
        let trap = word.recall?.total.trap ?? 0
        let bad = wrong + trap
        if bad > 0 {
            entries.append(Entry(index: index, word: word, bad: bad))
        }
    }
    entries.sort { lhs, rhs in
        lhs.bad != rhs.bad ? lhs.bad > rhs.bad : lhs.index < rhs.index
    }
    return entries.prefix(max(0, limit)).map { (word: $0.word, bad: $0.bad) }
}

// MARK: - 智能混合派发小签（REV-11；对齐 src/reader/ReviewView.tsx:124-128 SMART_ROUTE_TIP）

/// 智能模式下卡片小签的派发说明：为什么这张卡练这个形态。
/// （词块→完形 · 熟词间隔≥1天→听写 · 其余→识别；与 routeRecallMode 的三条分支一一对应。）
/// 文案逐字对齐 Windows SMART_ROUTE_TIP，悬停小签即见。
public func smartRouteTip(_ mode: RecallMode) -> String {
    switch mode {
    case .cloze: return "智能混合：本卡是词块，练完形（放进原句默写）"
    case .dictation: return "智能混合：本卡已复习过（间隔≥1 天），练听写"
    case .recognition: return "智能混合：本卡是新词，先看词想义"
    }
}

/// 智能混合按卡路由时的小签文字：「智能 · 完形」——一眼可见是派发而非切错模式
///（ReviewView.tsx:525 `智能 · ${pill}`）；固定模式原样返回 pill。
public func smartPillLabel(_ pill: String, smart: Bool) -> String {
    smart ? "智能 · \(pill)" : pill
}
