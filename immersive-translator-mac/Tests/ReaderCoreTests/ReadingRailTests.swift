import XCTest
@testable import ReaderCore

/// 阅读页左缘进度轨口径（对齐 Windows ReadingView.tsx:484 / :1021-1029）：
/// railPct = total>0 ? max(1, round((activeIdx+1)/total*100)) : 0 —— 与 dock 同口径
/// （光标句/总句，跟随播放与滚动阅读）；label = 书章 CHAPTER N / 短文文章标题。
final class ReadingRailTests: XCTestCase {

    func testRailPercentZeroWhenNoSentences() {
        XCTAssertEqual(readingRailPercent(activeIdx: 0, total: 0), 0, "total=0 → 0（不出 NaN）")
    }

    func testRailPercentFollowsCursorOverTotal() {
        XCTAssertEqual(readingRailPercent(activeIdx: 0, total: 10), 10)
        XCTAssertEqual(readingRailPercent(activeIdx: 4, total: 7), 71, "5/7*100=71.4 → 71")
        XCTAssertEqual(readingRailPercent(activeIdx: 9, total: 10), 100)
    }

    func testRailPercentFloorsAtOne() {
        // max(1, …)：长文第一句也至少显示 1%。
        XCTAssertEqual(readingRailPercent(activeIdx: 0, total: 200), 1)
    }

    func testRailLabelChapterVsArticle() {
        XCTAssertEqual(readingRailLabel(chapterIdx: 0, articleTitle: "Whatever"), "CHAPTER 1")
        XCTAssertEqual(readingRailLabel(chapterIdx: 11, articleTitle: "Whatever"), "CHAPTER 12")
        XCTAssertEqual(readingRailLabel(chapterIdx: nil, articleTitle: "The Tide"), "The Tide", "短文直接放标题")
    }
}
