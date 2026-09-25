import Foundation

/// 复习提醒配置与到点判定（纯逻辑，可测）。对齐 Windows review_reminder.rs：
/// 30s 调度 → 到点弹提醒卡 + 刷新菜单栏角标；每天最多提醒一次；
/// 免打扰窗口支持跨零点（23:00–08:00）。

public struct ReminderConfig: Codable, Equatable {
    public var enabled: Bool
    /// 每天的第几分钟（20:00 = 1200）。
    public var minuteOfDay: Int
    public var dndEnabled: Bool
    /// 免打扰起止（分钟），跨零点用 start > end 表达。
    public var dndStartMin: Int
    public var dndEndMin: Int
    /// 每日阅读目标（分钟）。v1 只存展示，不追踪时长。
    public var readGoalMin: Int
    /// 上次弹提醒的本地日期（YYYY-MM-DD），每天最多提醒一次。
    public var lastShownDay: String

    public init(
        enabled: Bool = true,
        minuteOfDay: Int = 20 * 60,
        dndEnabled: Bool = true,
        dndStartMin: Int = 23 * 60,
        dndEndMin: Int = 8 * 60,
        readGoalMin: Int = 10,
        lastShownDay: String = ""
    ) {
        self.enabled = enabled
        self.minuteOfDay = minuteOfDay
        self.dndEnabled = dndEnabled
        self.dndStartMin = dndStartMin
        self.dndEndMin = dndEndMin
        self.readGoalMin = readGoalMin
        self.lastShownDay = lastShownDay
    }

    enum CodingKeys: String, CodingKey {
        case enabled, minuteOfDay, dndEnabled, dndStartMin, dndEndMin, readGoalMin, lastShownDay
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        minuteOfDay = try c.decodeIfPresent(Int.self, forKey: .minuteOfDay) ?? 1200
        dndEnabled = try c.decodeIfPresent(Bool.self, forKey: .dndEnabled) ?? true
        dndStartMin = try c.decodeIfPresent(Int.self, forKey: .dndStartMin) ?? 1380
        dndEndMin = try c.decodeIfPresent(Int.self, forKey: .dndEndMin) ?? 480
        readGoalMin = try c.decodeIfPresent(Int.self, forKey: .readGoalMin) ?? 10
        lastShownDay = try c.decodeIfPresent(String.self, forKey: .lastShownDay) ?? ""
    }

    public static let `default` = ReminderConfig()
}

/// 到点是否应弹提醒（纯函数，可测）。双态（对齐 Windows should_show_now）：
/// - 到期词态：due > 0（原有行为）。
/// - 阅读目标态（每日阅读目标）：无到期词，但设了每日阅读目标、今天没读够、
///   且书架上有书可回 —— 「还差 M 分钟 · 继续读《书名》第 N 章」。
///   没书 / 没设目标 / 目标已达成的用户维持「无到期不弹」，不被打扰。
public func reminderShouldShowNow(
    _ cfg: ReminderConfig,
    nowMin: Int,
    due: Int,
    today: String,
    readSecondsToday: Double = 0,
    hasBooks: Bool = false
) -> Bool {
    if !cfg.enabled || cfg.lastShownDay == today {
        return false
    }
    if due == 0 {
        let goalMet = readSecondsToday >= Double(cfg.readGoalMin) * 60
        if cfg.readGoalMin == 0 || !hasBooks || goalMet {
            return false
        }
    }
    if cfg.dndEnabled && reminderInDndWindow(nowMin, startMin: cfg.dndStartMin, endMin: cfg.dndEndMin) {
        return false
    }
    return reminderWithinWindow(nowMin, targetMin: cfg.minuteOfDay)
}

/// 提醒时间起 30 分钟宽窗口（调度周期 30s，保证至少命中多个 tick）。
public func reminderWithinWindow(_ nowMin: Int, targetMin: Int) -> Bool {
    nowMin >= targetMin && nowMin < targetMin + 30
}

/// 免打扰窗口判断，支持跨零点（start >= end，如 23:00–08:00）。
public func reminderInDndWindow(_ nowMin: Int, startMin: Int, endMin: Int) -> Bool {
    if startMin == endMin {
        return false
    }
    if startMin < endMin {
        return nowMin >= startMin && nowMin < endMin
    }
    return nowMin >= startMin || nowMin < endMin
}

/// 本地时间 → (当天第几分钟, YYYY-MM-DD)。
public func reminderLocalNowParts(now: Date = Date()) -> (minuteOfDay: Int, dayKey: String) {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .current
    let comps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: now)
    let minute = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    let day = String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 0, comps.day ?? 0)
    return (minute, day)
}

/// 提醒时间的展示（"20:00"）。
public func reminderMinuteLabel(_ minuteOfDay: Int) -> String {
    String(format: "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60)
}

/// 提醒卡文案：N 个词约 M 分钟（按 6 词/分钟估读）。
public func reminderEstimateMinutes(due: Int) -> Int {
    max(1, Int((Double(due) / 6.0).rounded()))
}

/// 阅读目标态文案：离今日目标还差多少分钟（不足 1 分钟按 1 计；
/// 对齐 Windows ReminderApp 的 remainMin 口径）。
public func reminderReadingRemainMinutes(readGoalMin: Int, readSecondsToday: Double) -> Int {
    let remain = Double(readGoalMin) * 60 - readSecondsToday
    return max(1, Int((remain / 60).rounded(.up)))
}

public let reminderMinuteOfDayMin = 6 * 60
public let reminderMinuteOfDayMax = 23 * 60 + 30
public let reminderReadGoalMinRange = 5.0...60.0
