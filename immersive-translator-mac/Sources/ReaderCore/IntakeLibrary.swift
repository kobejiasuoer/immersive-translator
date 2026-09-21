import Foundation

/// 内置分级文库（内容进水口）：公版书全文 + 元信息。对齐 src/core/library.ts。
/// 数据（library.json，6 篇 Standard Ebooks 公版书）由应用层从 bundle 加载注入；
/// ReaderCore 只持模型与「今日一篇」轮换逻辑。

public struct IntakeLibraryItem: Codable, Equatable, Identifiable {
    public var id: String
    /// 英文标题。
    public var en: String
    /// 中文标题。
    public var cn: String
    public var author: String
    /// 难度标签（A2 / B1 / B2），文库分级是人工标注的。
    public var level: String
    public var words: Int
    /// 估时（分钟，按 135 wpm）。
    public var minutes: Int
    /// 开篇摘句（文库卡展示）。
    public var quote: String
    /// 文本来源（Standard Ebooks 仓库）。
    public var sourceUrl: String
    /// 全文，段落以空行分隔。
    public var text: String
}

/// 本地日期序（用于「今日一篇」轮换，跨天换篇且全设备同序）。
/// floor((UTC 秒 + 本时区东偏秒) / 86400)，与 TS 版
/// Math.floor((t - getTimezoneOffset()*60000) / 86_400_000) 逐点一致（含夏令时）。
public func localDayNumber(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> Int {
    let date = Date(timeIntervalSince1970: Double(now) / 1000.0)
    let offsetEast = Double(TimeZone.current.secondsFromGMT(for: date))
    return Int(floor((Double(now) / 1000.0 + offsetEast) / 86_400))
}

/// 今日一篇：按日期在文库中轮换。
public func todayLibraryItem(_ library: [IntakeLibraryItem], now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> IntakeLibraryItem? {
    guard !library.isEmpty else { return nil }
    return library[abs(localDayNumber(now: now)) % library.count]
}
