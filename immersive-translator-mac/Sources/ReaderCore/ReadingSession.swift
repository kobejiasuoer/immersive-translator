import Foundation

/// 每日阅读时长的活跃判定（纯逻辑，可测）。对齐 Windows「每日阅读目标」追踪
///（ReaderApp 每 ~15s 批量上报 reader_record_reading）：朗读播放与停留阅读均计入。
/// 活跃 = 朗读播放中（playbackPlaying），或阅读窗为 key 且近 2 分钟内有
/// 按键/翻句交互——防挂机：暂停播放离开阅读窗后不再累计。
public struct ReadingSession: Equatable {
    /// 停留阅读的交互有效窗口（秒）。
    public static let interactionWindow: TimeInterval = 120

    /// 最近一次阅读交互的时刻（调用方注入的秒时钟，单调即可，不限基准）。
    public private(set) var lastInteraction: TimeInterval?

    public init() {}

    /// 按键 / 翻句 / 滚动等阅读交互时调用。
    public mutating func noteInteraction(now: TimeInterval) {
        lastInteraction = now
    }

    /// 本秒是否计入阅读时长：播放中无条件算；否则需窗口为 key 且近
    /// interactionWindow 内有交互。
    public func isCounting(playbackPlaying: Bool, windowIsKey: Bool, now: TimeInterval) -> Bool {
        if playbackPlaying {
            return true
        }
        guard windowIsKey, let last = lastInteraction else { return false }
        return now - last <= Self.interactionWindow
    }
}

// MARK: - 每日阅读时长（reader_vocab.json 的 readingLog 合并/读取，纯函数便于测试）

/// 读某天的累计阅读秒数（对齐 Windows reader_store.rs read_seconds_today）。
public func readingSeconds(in log: [ReadingLogDay], day: String) -> Double {
    log.first { $0.day == day }?.seconds ?? 0
}

/// 累计某天的阅读秒数，返回新日志（对齐 reader_record_reading 的合并语义：
/// 命中当天则累加，未命中则新增一天）。
public func readingLogRecorded(_ log: [ReadingLogDay], day: String, seconds: Double) -> [ReadingLogDay] {
    var log = log
    if let idx = log.firstIndex(where: { $0.day == day }) {
        log[idx].seconds += seconds
    } else {
        log.append(ReadingLogDay(day: day, seconds: seconds))
    }
    return log
}
