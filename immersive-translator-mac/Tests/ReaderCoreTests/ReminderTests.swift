import XCTest
@testable import ReaderCore

/// 复习触点（P7）：到点判定 / 免打扰跨零点 / 宽窗口 / 文案。

final class ReminderTests: XCTestCase {
    func testShouldShowNowHappyPath() {
        var cfg = ReminderConfig.default  // 20:00，免打扰 23:00–08:00
        XCTAssertTrue(reminderShouldShowNow(cfg, nowMin: 1205, due: 5, today: "2026-09-21"))
        XCTAssertTrue(reminderShouldShowNow(cfg, nowMin: 1229, due: 1, today: "2026-09-21"))  // 窗口内
    }

    func testShouldShowNowDisabledOrNoDueOrAlreadyShown() {
        var cfg = ReminderConfig.default
        cfg.enabled = false
        XCTAssertFalse(reminderShouldShowNow(cfg, nowMin: 1205, due: 5, today: "2026-09-21"))
        cfg.enabled = true
        XCTAssertFalse(reminderShouldShowNow(cfg, nowMin: 1205, due: 0, today: "2026-09-21"))
        cfg.lastShownDay = "2026-09-21"
        XCTAssertFalse(reminderShouldShowNow(cfg, nowMin: 1205, due: 5, today: "2026-09-21"))
    }

    func testShouldShowNowOutsideWindow() {
        let cfg = ReminderConfig.default  // 20:00 = 1200
        XCTAssertFalse(reminderShouldShowNow(cfg, nowMin: 1100, due: 5, today: "2026-09-21"))  // 还没到
        XCTAssertFalse(reminderShouldShowNow(cfg, nowMin: 1230, due: 5, today: "2026-09-21"))  // 窗口尾之外
    }

    func testDndWindowAcrossMidnight() {
        // 23:00–08:00 跨零点
        XCTAssertTrue(reminderInDndWindow(23 * 60 + 30, startMin: 23 * 60, endMin: 8 * 60))
        XCTAssertTrue(reminderInDndWindow(2 * 60, startMin: 23 * 60, endMin: 8 * 60))
        XCTAssertFalse(reminderInDndWindow(12 * 60, startMin: 23 * 60, endMin: 8 * 60))
        // 同天窗口
        XCTAssertTrue(reminderInDndWindow(14 * 60, startMin: 13 * 60, endMin: 15 * 60))
        XCTAssertFalse(reminderInDndWindow(16 * 60, startMin: 13 * 60, endMin: 15 * 60))
        // start == end 视为无窗口
        XCTAssertFalse(reminderInDndWindow(600, startMin: 480, endMin: 480))
    }

    func testReminderWithinWindow() {
        XCTAssertTrue(reminderWithinWindow(1200, targetMin: 1200))
        XCTAssertTrue(reminderWithinWindow(1229, targetMin: 1200))
        XCTAssertFalse(reminderWithinWindow(1230, targetMin: 1200))
        XCTAssertFalse(reminderWithinWindow(1199, targetMin: 1200))
    }

    func testLocalNowParts() {
        // 用当前时区构造固定时刻，避免测试依赖机器时区
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        var comps = DateComponents()
        comps.year = 2026; comps.month = 9; comps.day = 16
        comps.hour = 11; comps.minute = 20
        let local = cal.date(from: comps)!
        let (minute, day) = reminderLocalNowParts(now: local)
        XCTAssertEqual(minute, 11 * 60 + 20)
        XCTAssertEqual(day, "2026-09-16")
    }

    func testMinuteLabelAndEstimate() {
        XCTAssertEqual(reminderMinuteLabel(1200), "20:00")
        XCTAssertEqual(reminderMinuteLabel(8 * 60 + 5), "08:05")
        XCTAssertEqual(reminderEstimateMinutes(due: 6), 1)
        XCTAssertEqual(reminderEstimateMinutes(due: 30), 5)
        XCTAssertEqual(reminderEstimateMinutes(due: 1), 1)
    }

    func testConfigDecodesPartial() throws {
        let json = #"{"enabled":false}"#
        let cfg = try JSONDecoder().decode(ReminderConfig.self, from: Data(json.utf8))
        XCTAssertFalse(cfg.enabled)
        XCTAssertEqual(cfg.minuteOfDay, 1200)  // 缺省默认
        XCTAssertEqual(cfg.dndStartMin, 23 * 60)
    }
}
