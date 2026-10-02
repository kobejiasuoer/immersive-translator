import Foundation

/// 本地产品埋点事件（对齐 Windows src/lib/telemetry.ts 最小事件集）：
/// 纯本地 JSONL、无网络、失败静默。
///
/// 事件与文件行记录是两个概念：
/// - 事件（event）=「发生了什么」= name + 类型化 props，`TelemetryEvent` 只有这两个
///   存储属性，不含 ts——ts 在 `ReaderTelemetry.track` 时刻才赋给文件行；
/// - 文件行记录 = ts + 事件，由 `jsonLine(nowMs:)` 把 ts 作为参数注入（测试确定性接缝），
///   `decodeLine` 把行记录三键（ts/name/props）完整还原。
///
/// 事件内容只含 id 与计数，无正文/句子文本/URL，隐私面与 Windows 一致。
public struct TelemetryEvent: Equatable {
    /// props 的取值：与 Windows 各调用点字面量一致，只有 string/int/bool 三种。
    /// 编码为对应的基本类型值（不打包成 {type,value} 之类的包装结构）。
    public enum PropValue: Equatable, Encodable {
        case string(String)
        case int(Int)
        case bool(Bool)

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .string(let value): try container.encode(value)
            case .int(let value): try container.encode(value)
            case .bool(let value): try container.encode(value)
            }
        }
    }

    public let name: String
    public let props: [String: PropValue]

    public init(name: String, props: [String: PropValue]) {
        self.name = name
        self.props = props
    }

    /// 编码为一行 JSON（{"ts":nowMs,"name":…,"props":…}），.sortedKeys 确定性输出。
    /// ts 是文件行属性、在 track 时刻赋值，故作参数注入；事件本身不含 ts。
    public func jsonLine(nowMs: Int64) throws -> String {
        struct LineRecord: Encodable {
            let ts: Int64
            let name: String
            let props: [String: PropValue]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(LineRecord(ts: nowMs, name: name, props: props))
        return String(decoding: data, as: UTF8.self)
    }

    /// 读侧解析（测试往返/未来分析脚本用）：把一行 JSON 还原为行记录二元组。
    /// 非合法 JSON 对象 / 缺 ts、name 键 / props 非对象 / props 含不支持类型的值 → 返回 nil。
    public static func decodeLine(_ line: String) -> (ts: Int64, event: TelemetryEvent)? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else { return nil }
        guard let ts = strictInt64(dict["ts"]),
              let name = dict["name"] as? String,
              let rawProps = dict["props"] as? [String: Any] else { return nil }
        var props: [String: PropValue] = [:]
        for (key, value) in rawProps {
            guard let prop = propValue(from: value) else { return nil }
            props[key] = prop
        }
        return (ts: ts, event: TelemetryEvent(name: name, props: props))
    }

    /// JSON 值 → PropValue：JSON true/false 经 JSONSerialization 装成 CFBoolean，
    /// 据此与数值区分；非整数值/其他类型视为非法。
    private static func propValue(from json: Any) -> PropValue? {
        if let string = json as? String { return .string(string) }
        guard let number = json as? NSNumber else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
        guard let int64 = strictInt64(number), let int = Int(exactly: int64) else { return nil }
        return .int(int)
    }

    /// 严格整数转换：非整数（含小数/NaN）或超出 Int64 范围 → nil。
    private static func strictInt64(_ json: Any?) -> Int64? {
        guard let number = json as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value == value.rounded(.towardZero) else { return nil }
        // 范围用 NSNumber 精确比较，避免 double 边界换算（2^63 处）溢出崩溃。
        guard number.compare(NSNumber(value: Int64.max)) != .orderedDescending,
              number.compare(NSNumber(value: Int64.min)) != .orderedAscending else { return nil }
        return number.int64Value
    }
}

public extension TelemetryEvent {
    /// 事件名与字段名逐字对齐 Windows ReaderApp.tsx:881/904/940、
    /// ImportDialog.tsx:180/836/852/897、ReminderApp.tsx:140（Windows 用裸字符串，mac 用工厂收口）。

    /// 打开书章文章（短文不埋）。
    static func bookOpen(bookId: String, chapterIdx: Int, sentenceIdx: Int) -> TelemetryEvent {
        TelemetryEvent(name: "book_open", props: [
            "bookId": .string(bookId),
            "chapterIdx": .int(chapterIdx),
            "sentenceIdx": .int(sentenceIdx)
        ])
    }

    /// 章末小结卡弹出（自然播完末句 / 手动「读完本章」统一落点）。
    static func chapterComplete(bookId: String, chapterIdx: Int, lookedUpCount: Int,
                                collectedCount: Int, dueCount: Int, secondsRead: Int) -> TelemetryEvent {
        TelemetryEvent(name: "chapter_complete", props: [
            "bookId": .string(bookId),
            "chapterIdx": .int(chapterIdx),
            "lookedUpCount": .int(lookedUpCount),
            "collectedCount": .int(collectedCount),
            "dueCount": .int(dueCount),
            "secondsRead": .int(secondsRead)
        ])
    }

    /// 短文结课条弹出。
    static func articleFinish(articleId: String, lookedUpCount: Int,
                              collectedCount: Int, dueCount: Int) -> TelemetryEvent {
        TelemetryEvent(name: "article_finish", props: [
            "articleId": .string(articleId),
            "lookedUpCount": .int(lookedUpCount),
            "collectedCount": .int(collectedCount),
            "dueCount": .int(dueCount)
        ])
    }

    /// 「EPUB / 长书」tab 选中文件开始解析。fileSizeBytes 读不到时省略该键（不发 0）。
    static func bookImportAttempt(fileSizeBytes: Int?) -> TelemetryEvent {
        var props: [String: PropValue] = [:]
        if let fileSizeBytes = fileSizeBytes { props["fileSizeBytes"] = .int(fileSizeBytes) }
        return TelemetryEvent(name: "book_import_attempt", props: props)
    }

    /// 「EPUB / 长书」导入结果：成功给 chapterCount/wordCount/tocUsed，失败只给
    /// failReason（工厂内 prefix(60) 截断，保证所有调用点一致，中文按字符截断安全）。
    static func bookImportResult(ok: Bool, chapterCount: Int? = nil, wordCount: Int? = nil,
                                 tocUsed: Bool? = nil, failReason: String? = nil) -> TelemetryEvent {
        var props: [String: PropValue] = ["ok": .bool(ok)]
        if let chapterCount = chapterCount { props["chapterCount"] = .int(chapterCount) }
        if let wordCount = wordCount { props["wordCount"] = .int(wordCount) }
        if let tocUsed = tocUsed { props["tocUsed"] = .bool(tocUsed) }
        if let failReason = failReason { props["failReason"] = .string(String(failReason.prefix(60))) }
        return TelemetryEvent(name: "book_import_result", props: props)
    }

    /// 导水口弹层切到「EPUB / 长书」tab。
    static func epubImportIntent(entry: String) -> TelemetryEvent {
        TelemetryEvent(name: "epub_import_intent", props: ["entry": .string(entry)])
    }

    /// 提醒卡「继续阅读」按钮点击（「开始复习」不埋，对齐 Windows）。
    static func reminderContinueClick(bookId: String) -> TelemetryEvent {
        TelemetryEvent(name: "reminder_continue_click", props: ["bookId": .string(bookId)])
    }

    /// 阅读时长（Windows telemetry.ts 注释声明但未实现；mac 在 15s 批量落盘点补齐）。
    static func readingMinutes(seconds: Int) -> TelemetryEvent {
        TelemetryEvent(name: "reading_minutes", props: ["seconds": .int(seconds)])
    }
}
