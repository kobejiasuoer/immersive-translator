import XCTest
@testable import ReaderCore

/// 每日阅读目标进度：活跃判定（ReadingSession）与每日阅读时长的合并/读取，
/// 以及 reader_vocab.json 可选字段 readingLog 的新老数据兼容。

final class ReadingSessionTests: XCTestCase {
    func testPlaybackCountsUnconditionally() {
        let session = ReadingSession()
        // 播放中：无交互、窗口非 key 也算活跃（朗读播放与停留阅读均计入）。
        XCTAssertTrue(session.isCounting(playbackPlaying: true, windowIsKey: false, now: 1000))
    }

    func testStayReadingNeedsKeyWindowAndRecentInteraction() {
        var session = ReadingSession()
        // 无交互：窗口 key 也不算。
        XCTAssertFalse(session.isCounting(playbackPlaying: false, windowIsKey: true, now: 1000))
        session.noteInteraction(now: 1000)
        // 近 2 分钟内有交互 + 窗口 key → 算。
        XCTAssertTrue(session.isCounting(playbackPlaying: false, windowIsKey: true, now: 1000 + 120))
        // 超过 2 分钟未交互 → 停止累计（防挂机）。
        XCTAssertFalse(session.isCounting(playbackPlaying: false, windowIsKey: true, now: 1000 + 121))
        // 窗口非 key（切去别的窗口/应用）→ 不算。
        XCTAssertFalse(session.isCounting(playbackPlaying: false, windowIsKey: false, now: 1000 + 10))
    }

    func testInteractionRefreshesWindow() {
        var session = ReadingSession()
        session.noteInteraction(now: 1000)
        session.noteInteraction(now: 1100)
        XCTAssertTrue(session.isCounting(playbackPlaying: false, windowIsKey: true, now: 1100 + 120))
        XCTAssertFalse(session.isCounting(playbackPlaying: false, windowIsKey: true, now: 1100 + 121))
    }

    // MARK: - readingLog 合并/读取

    func testReadingLogRecordedAppendsNewDay() {
        let log = readingLogRecorded([], day: "2026-09-25", seconds: 15)
        XCTAssertEqual(log, [ReadingLogDay(day: "2026-09-25", seconds: 15)])
        XCTAssertEqual(readingSeconds(in: log, day: "2026-09-25"), 15)
    }

    func testReadingLogRecordedAccumulatesSameDay() {
        var log = readingLogRecorded([], day: "2026-09-25", seconds: 15)
        log = readingLogRecorded(log, day: "2026-09-25", seconds: 15)
        XCTAssertEqual(log.count, 1)
        XCTAssertEqual(log[0].seconds, 30)
        // 别的天互不影响；没有的天读 0。
        log = readingLogRecorded(log, day: "2026-09-24", seconds: 600)
        XCTAssertEqual(readingSeconds(in: log, day: "2026-09-24"), 600)
        XCTAssertEqual(readingSeconds(in: log, day: "2026-09-23"), 0)
    }

    // MARK: - VocabFile 的可选 readingLog（新老数据双向兼容）

    func testVocabFileDecodesWithoutReadingLog() throws {
        // 老数据没有 readingLog 字段 → nil，解码不报错（schemaVersion 维持 1）。
        let json = #"{"schemaVersion":1,"words":[],"reviewLog":{"days":[]}}"#
        let file = try JSONDecoder().decode(VocabFile.self, from: Data(json.utf8))
        XCTAssertNil(file.readingLog)
        XCTAssertNotNil(file.reviewLog)
    }

    func testVocabFileRoundtripsWithReadingLog() throws {
        let file = VocabFile(readingLog: [ReadingLogDay(day: "2026-09-25", seconds: 615)])
        let data = try JSONEncoder().encode(file)
        let back = try JSONDecoder().decode(VocabFile.self, from: data)
        XCTAssertEqual(back.readingLog, [ReadingLogDay(day: "2026-09-25", seconds: 615)])
        // camelCase 键与 Windows reader_store.rs（serde rename_all camelCase）同构。
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let log = try XCTUnwrap(object["readingLog"] as? [[String: Any]])
        XCTAssertEqual(log[0]["day"] as? String, "2026-09-25")
        XCTAssertEqual(log[0]["seconds"] as? Double, 615)
    }
}
