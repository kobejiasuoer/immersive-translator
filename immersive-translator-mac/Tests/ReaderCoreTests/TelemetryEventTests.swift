import Foundation
import XCTest
@testable import ReaderCore

/// 本地埋点事件编码：行结构与字段名逐字对齐 Windows（ReaderApp.tsx 的
/// book_open/chapter_complete/article_finish、ImportDialog.tsx 的
/// book_import_* / epub_import_intent、ReminderApp.tsx 的 reminder_continue_click）。

final class TelemetryEventTests: XCTestCase {
    private let nowMs: Int64 = 1_800_000_000_000

    /// 解析一行 JSONL 为字典（行结构断言用）。
    private func lineDict(_ line: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
        return try XCTUnwrap(object as? [String: Any])
    }

    private func number(_ dict: [String: Any], _ key: String) throws -> Int {
        let value = try XCTUnwrap(dict[key] as? NSNumber)
        return value.intValue
    }

    // MARK: - 行结构

    func testBookOpenLineShape() throws {
        let line = try TelemetryEvent.bookOpen(bookId: "b1", chapterIdx: 2, sentenceIdx: 7)
            .jsonLine(nowMs: nowMs)
        let dict = try lineDict(line)
        XCTAssertEqual(try strictTs(dict["ts"]), nowMs)
        XCTAssertEqual(dict["name"] as? String, "book_open")
        let props = try XCTUnwrap(dict["props"] as? [String: Any])
        XCTAssertEqual(props["bookId"] as? String, "b1")
        XCTAssertEqual(try number(props, "chapterIdx"), 2)
        XCTAssertEqual(try number(props, "sentenceIdx"), 7)
        XCTAssertEqual(Set(props.keys), ["bookId", "chapterIdx", "sentenceIdx"])
    }

    func testChapterCompleteLineShape() throws {
        let line = try TelemetryEvent.chapterComplete(
            bookId: "b1", chapterIdx: 0, lookedUpCount: 3,
            collectedCount: 2, dueCount: 1, secondsRead: 95
        ).jsonLine(nowMs: nowMs)
        let props = try XCTUnwrap(try lineDict(line)["props"] as? [String: Any])
        XCTAssertEqual(props["bookId"] as? String, "b1")
        XCTAssertEqual(try number(props, "chapterIdx"), 0)
        XCTAssertEqual(try number(props, "lookedUpCount"), 3)
        XCTAssertEqual(try number(props, "collectedCount"), 2)
        XCTAssertEqual(try number(props, "dueCount"), 1)
        XCTAssertEqual(try number(props, "secondsRead"), 95)
        XCTAssertEqual(Set(props.keys), ["bookId", "chapterIdx", "lookedUpCount", "collectedCount", "dueCount", "secondsRead"])
    }

    func testBookImportResultSuccessAndFailure() throws {
        // 成功：ok/chapterCount/wordCount/tocUsed 四键，无 failReason。
        let ok = try TelemetryEvent.bookImportResult(ok: true, chapterCount: 12, wordCount: 3400, tocUsed: true)
            .jsonLine(nowMs: nowMs)
        let okProps = try XCTUnwrap(try lineDict(ok)["props"] as? [String: Any])
        XCTAssertEqual(okProps["ok"] as? Bool, true)
        XCTAssertEqual(try number(okProps, "chapterCount"), 12)
        XCTAssertEqual(try number(okProps, "wordCount"), 3400)
        XCTAssertEqual(okProps["tocUsed"] as? Bool, true)
        XCTAssertEqual(Set(okProps.keys), ["ok", "chapterCount", "wordCount", "tocUsed"])

        // 失败：仅 ok/failReason 两键，无可选键。
        let failed = try TelemetryEvent.bookImportResult(ok: false, failReason: "解析失败")
            .jsonLine(nowMs: nowMs)
        let failedProps = try XCTUnwrap(try lineDict(failed)["props"] as? [String: Any])
        XCTAssertEqual(failedProps["ok"] as? Bool, false)
        XCTAssertEqual(failedProps["failReason"] as? String, "解析失败")
        XCTAssertEqual(Set(failedProps.keys), ["ok", "failReason"])
    }

    func testFailReasonTruncatedTo60() throws {
        let message = String(repeating: "汉", count: 61)
        let line = try TelemetryEvent.bookImportResult(ok: false, failReason: message).jsonLine(nowMs: nowMs)
        let props = try XCTUnwrap(try lineDict(line)["props"] as? [String: Any])
        let failReason = try XCTUnwrap(props["failReason"] as? String)
        XCTAssertEqual(failReason.count, 60)
    }

    func testNilPropsKeysOmitted() throws {
        // fileSizeBytes 读不到 → 整键省略，不发 null、不发 0。
        let line = try TelemetryEvent.bookImportAttempt(fileSizeBytes: nil).jsonLine(nowMs: nowMs)
        let props = try XCTUnwrap(try lineDict(line)["props"] as? [String: Any])
        XCTAssertTrue(props.isEmpty)
        XCTAssertFalse(line.contains("fileSizeBytes"))
        XCTAssertFalse(line.contains("null"))

        let sized = try TelemetryEvent.bookImportAttempt(fileSizeBytes: 123_456).jsonLine(nowMs: nowMs)
        let sizedProps = try XCTUnwrap(try lineDict(sized)["props"] as? [String: Any])
        XCTAssertEqual(try number(sizedProps, "fileSizeBytes"), 123_456)
    }

    func testReadingMinutesShape() throws {
        let line = try TelemetryEvent.readingMinutes(seconds: 15).jsonLine(nowMs: nowMs)
        let dict = try lineDict(line)
        XCTAssertEqual(dict["name"] as? String, "reading_minutes")
        let props = try XCTUnwrap(dict["props"] as? [String: Any])
        XCTAssertEqual(try number(props, "seconds"), 15)
    }

    // MARK: - 确定性与往返

    func testLineDeterministicAndRoundTrip() throws {
        let event = TelemetryEvent.bookImportResult(ok: true, chapterCount: 3, wordCount: 900, tocUsed: false)
        let first = try event.jsonLine(nowMs: nowMs)
        let second = try event.jsonLine(nowMs: nowMs)
        // .sortedKeys：同一事件两次编码字节一致。
        XCTAssertEqual(first, second)

        // decodeLine 还原行记录三元组：ts == 注入值，event 与原事件逐字段相等（不含 ts）。
        let decoded = try XCTUnwrap(TelemetryEvent.decodeLine(first))
        XCTAssertEqual(decoded.ts, nowMs)
        XCTAssertEqual(decoded.event, event)

        // 非 JSON 对象 / 缺键 / props 非对象 → nil。
        XCTAssertNil(TelemetryEvent.decodeLine("not a json"))
        XCTAssertNil(TelemetryEvent.decodeLine("[1,2,3]"))
        XCTAssertNil(TelemetryEvent.decodeLine("{\"ts\":1,\"name\":\"x\"}"))
        XCTAssertNil(TelemetryEvent.decodeLine("{\"name\":\"x\",\"props\":{}}"))
        XCTAssertNil(TelemetryEvent.decodeLine("{\"ts\":1,\"props\":{}}"))
        XCTAssertNil(TelemetryEvent.decodeLine("{\"ts\":1,\"name\":\"x\",\"props\":\"oops\"}"))
    }

    // MARK: - 口语场景体系三事件（名/字段逐字对齐 Windows analytics.ts:24-32 白名单）

    func testSpeakSessionStartLineShape() throws {
        let line = try TelemetryEvent.speakSessionStart(scenarioId: "usr_abc", scenarioSource: .user)
            .jsonLine(nowMs: nowMs)
        let dict = try lineDict(line)
        XCTAssertEqual(dict["name"] as? String, "speak_session_start")
        let props = try XCTUnwrap(dict["props"] as? [String: Any])
        XCTAssertEqual(props["scenarioId"] as? String, "usr_abc")
        XCTAssertEqual(props["scenarioSource"] as? String, "user")
        XCTAssertEqual(Set(props.keys), ["scenarioId", "scenarioSource"])
        for source in SpeakScenarioSource.allCases {
            let event = TelemetryEvent.speakSessionStart(scenarioId: "x", scenarioSource: source)
            XCTAssertEqual(event.props["scenarioSource"], .string(source.rawValue))
        }
    }

    func testScenarioCreateLineShape() throws {
        for via in ["generate", "manual"] {
            let line = try TelemetryEvent.scenarioCreate(via: via).jsonLine(nowMs: nowMs)
            let dict = try lineDict(line)
            XCTAssertEqual(dict["name"] as? String, "scenario_create")
            let props = try XCTUnwrap(dict["props"] as? [String: Any])
            XCTAssertEqual(props["via"] as? String, via)
            XCTAssertEqual(Set(props.keys), ["via"])
        }
    }

    func testScenarioGenerateResultOmitsParseErrorKeyWhenAbsent() throws {
        let ok = try lineDict(try TelemetryEvent.scenarioGenerateResult(ok: true).jsonLine(nowMs: nowMs))
        XCTAssertEqual(ok["name"] as? String, "scenario_generate_result")
        let okProps = try XCTUnwrap(ok["props"] as? [String: Any])
        XCTAssertEqual(okProps["ok"] as? Bool, true)
        XCTAssertEqual(Set(okProps.keys), ["ok"])

        // 接口失败/取消：只 {ok:false}，不带 parseError 键
        let failed = try lineDict(try TelemetryEvent.scenarioGenerateResult(ok: false).jsonLine(nowMs: nowMs))
        let failedProps = try XCTUnwrap(failed["props"] as? [String: Any])
        XCTAssertEqual(failedProps["ok"] as? Bool, false)
        XCTAssertEqual(Set(failedProps.keys), ["ok"])

        // 解析失败：四类口径
        for code in ["empty", "no_json", "bad_json", "missing_required"] {
            let parsed = try lineDict(try TelemetryEvent.scenarioGenerateResult(ok: false, parseError: code).jsonLine(nowMs: nowMs))
            let props = try XCTUnwrap(parsed["props"] as? [String: Any])
            XCTAssertEqual(props["ok"] as? Bool, false)
            XCTAssertEqual(props["parseError"] as? String, code)
            XCTAssertEqual(Set(props.keys), ["ok", "parseError"])
        }
        XCTAssertEqual(ScenarioGenParseError.allCodes, ["empty", "no_json", "bad_json", "missing_required"])
    }

    // MARK: - 资讯订阅 / 发现书库（feed_view / feed_import / discover_view / discover_import）

    func testFeedAndDiscoverLineShapes() throws {
        // feed_view：空 props。
        let feedView = try lineDict(try TelemetryEvent.feedView().jsonLine(nowMs: nowMs))
        XCTAssertEqual(feedView["name"] as? String, "feed_view")
        XCTAssertTrue(try XCTUnwrap(feedView["props"] as? [String: Any]).isEmpty)

        // feed_import：props { host }（发起导入意图口径）。
        let feedImport = try lineDict(try TelemetryEvent.feedImport(host: "www.nasa.gov").jsonLine(nowMs: nowMs))
        XCTAssertEqual(feedImport["name"] as? String, "feed_import")
        let feedImportProps = try XCTUnwrap(feedImport["props"] as? [String: Any])
        XCTAssertEqual(feedImportProps["host"] as? String, "www.nasa.gov")
        XCTAssertEqual(Set(feedImportProps.keys), ["host"])

        // discover_view：空 props。
        let discoverView = try lineDict(try TelemetryEvent.discoverView().jsonLine(nowMs: nowMs))
        XCTAssertEqual(discoverView["name"] as? String, "discover_view")
        XCTAssertTrue(try XCTUnwrap(discoverView["props"] as? [String: Any]).isEmpty)

        // discover_import：props { bookId }（入库成功后）。
        let discoverImport = try lineDict(try TelemetryEvent.discoverImport(bookId: "alice").jsonLine(nowMs: nowMs))
        XCTAssertEqual(discoverImport["name"] as? String, "discover_import")
        let discoverImportProps = try XCTUnwrap(discoverImport["props"] as? [String: Any])
        XCTAssertEqual(discoverImportProps["bookId"] as? String, "alice")
        XCTAssertEqual(Set(discoverImportProps.keys), ["bookId"])
    }

    private func strictTs(_ value: Any?) throws -> Int64 {
        let number = try XCTUnwrap(value as? NSNumber)
        return number.int64Value
    }
}

private extension ScenarioGenParseError {
    static let allCodes: [String] = [
        ScenarioGenParseError.empty.rawValue, ScenarioGenParseError.noJson.rawValue,
        ScenarioGenParseError.badJson.rawValue, ScenarioGenParseError.missingRequired.rawValue,
    ]
}
