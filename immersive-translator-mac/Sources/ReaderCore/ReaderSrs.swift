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
