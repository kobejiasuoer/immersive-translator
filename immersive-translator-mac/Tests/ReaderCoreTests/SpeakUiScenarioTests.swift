import XCTest
@testable import ReaderCore

/// speakUi 本领域子集：目标词进度 / 下一个该用的词 / 句内目标词高亮（findTargetSpans 与
/// textHitsTarget 口径一致、annotateSegments 两层区间切段）/ 场景中心目录卡（摘要取值、
/// 分类计数固定序、筛选 + 收起截断）。行为向量对齐 Windows src/core/speakUi.test.ts。
final class SpeakUiScenarioTests: XCTestCase {
    // MARK: - targetProgress

    func testTargetProgressNilWithoutTargets() {
        XCTAssertNil(targetProgress(hit: 0, total: 0))
        XCTAssertNil(targetProgress(hit: 3, total: -1))
    }

    func testTargetProgressLabelAndPct() {
        XCTAssertEqual(
            targetProgress(hit: 2, total: 5),
            SpeakTargetProgress(hit: 2, total: 5, pct: 40, label: "已用上 2 / 5 个词")
        )
        XCTAssertEqual(targetProgress(hit: 0, total: 5)?.pct, 0)
        XCTAssertEqual(targetProgress(hit: 5, total: 5)?.pct, 100)
    }

    func testTargetProgressClampsHit() {
        XCTAssertEqual(targetProgress(hit: 9, total: 5)?.hit, 5)
        XCTAssertEqual(targetProgress(hit: -2, total: 5)?.hit, 0)
    }

    // MARK: - nextTargetKey

    func testNextTargetKeyFirstUnhit() {
        XCTAssertEqual(nextTargetKey(["a", "b", "c"], hit: ["a"]), "b")
        XCTAssertEqual(nextTargetKey(["a", "b", "c"], hit: []), "a")
    }

    func testNextTargetKeyNilWhenAllHitOrEmpty() {
        XCTAssertNil(nextTargetKey(["a", "b"], hit: ["a", "b"]))
        XCTAssertNil(nextTargetKey([], hit: []))
    }

    func testNextTargetKeyFollowsInputOrder() {
        XCTAssertEqual(nextTargetKey(["x", "y", "z"], hit: ["y", "x"]), "z")
    }

    // MARK: - findTargetSpans

    private func cut(_ text: String, _ target: String) -> [String] {
        let ns = text as NSString
        return findTargetSpans(text, target).map { ns.substring(with: $0.nsRange) }
    }

    func testFindTargetSpansReturnsHitRanges() {
        XCTAssertEqual(cut("I would give all the volunteers the same guide", "volunteers"), ["volunteers"])
    }

    func testFindTargetSpansMultiWordChunk() {
        XCTAssertEqual(cut("so their answers are not inconsistent with each other", "inconsistent with"), ["inconsistent with"])
    }

    func testFindTargetSpansLastWordInflectionTakesActualForm() {
        XCTAssertEqual(cut("He standardizes it, then standardized again", "standardize"), ["standardizes", "standardized"])
    }

    func testFindTargetSpansPunctuationAndCase() {
        XCTAssertEqual(cut("Volunteers, please wait.", "volunteers"), ["Volunteers"])
    }

    func testFindTargetSpansMiddleWordNoInflection() {
        XCTAssertEqual(cut("fixing the command", "fix the command"), [])
    }

    func testFindTargetSpansEmptyTargetOrNoHit() {
        XCTAssertEqual(findTargetSpans("hello world", ""), [])
        XCTAssertEqual(findTargetSpans("hello world", "volunteers"), [])
        XCTAssertEqual(findTargetSpans("", "volunteers"), [])
    }

    func testFindTargetSpansAgreesWithTextHitsTarget() {
        let cases: [(String, String)] = [
            ("I would give all the volunteers the same guide", "volunteers"),
            ("so their answers are not inconsistent with each other", "inconsistent with"),
            ("He standardizes it", "standardize"),
            ("making a rule", "make"),
            ("fixing the command", "fix the command"),
            ("It's well-known that", "well-known"),
            ("I like volunteer work", "volunteers"),
            ("Inconsistencies are bad", "inconsistency"),
            ("", "x"),
            ("hello", ""),
        ]
        for (text, target) in cases {
            XCTAssertEqual(!findTargetSpans(text, target).isEmpty, textHitsTarget(text, target), "\(text) / \(target)")
        }
    }

    // MARK: - annotateSegments

    func testAnnotateSegmentsCutsOnBothLayersAndMerges() {
        // "I love cats"：love=[2,6) 是发音标记，[2,11) 是目标词块
        XCTAssertEqual(
            annotateSegments("I love cats", marks: [TargetSpan(start: 2, end: 6)], targets: [TargetSpan(start: 2, end: 11)]),
            [
                AnnotatedSegment(start: 0, end: 2, markIdx: -1, target: false),
                AnnotatedSegment(start: 2, end: 6, markIdx: 0, target: true),
                AnnotatedSegment(start: 6, end: 11, markIdx: -1, target: true),
            ]
        )
    }

    func testAnnotateSegmentsNoRangesWholeText() {
        XCTAssertEqual(annotateSegments("hello", marks: [], targets: []), [AnnotatedSegment(start: 0, end: 5, markIdx: -1, target: false)])
    }

    func testAnnotateSegmentsEmptyText() {
        XCTAssertEqual(annotateSegments("", marks: [TargetSpan(start: 0, end: 3)], targets: []), [])
    }

    func testAnnotateSegmentsClampsOutOfRange() {
        XCTAssertEqual(
            annotateSegments("abc", marks: [TargetSpan(start: -5, end: 99)], targets: []),
            [AnnotatedSegment(start: 0, end: 3, markIdx: 0, target: false)]
        )
    }

    func testAnnotateSegmentsMarkIdxPointsToInputIndex() {
        let segs = annotateSegments("one two", marks: [TargetSpan(start: 0, end: 3), TargetSpan(start: 4, end: 7)], targets: [])
        XCTAssertEqual(segs.filter { $0.markIdx >= 0 }.map(\.markIdx), [0, 1])
    }

    // MARK: - 场景中心目录卡

    private func makeScenario(_ id: String, _ category: SpeakScenarioCategory = .daily) -> SpeakScenario {
        SpeakScenario(
            id: id, source: .official, title: "title-\(id)", category: category,
            aiRole: "你扮演……（\(id)）", opener: "opener-\(id)", updatedAt: 1
        )
    }

    func testScenarioSummaryPrefersGoal() {
        XCTAssertEqual(scenarioSummary(goal: "说清症状、听懂追问", aiRole: "你扮演全科医生……"), "说清症状、听懂追问")
    }

    func testScenarioSummaryFallsBackToAiRoleWhenGoalMissingOrBlank() {
        XCTAssertEqual(scenarioSummary(goal: nil, aiRole: "你扮演发型师……"), "你扮演发型师……")
        XCTAssertEqual(scenarioSummary(goal: "  ", aiRole: "你扮演发型师……"), "你扮演发型师……")
        var sc = makeScenario("x")
        sc.goal = "  "
        XCTAssertEqual(scenarioSummary(sc), sc.aiRole)
    }

    func testScenarioCategoryCountsEmpty() {
        XCTAssertEqual(scenarioCategoryCounts([]), [])
    }

    func testScenarioCategoryCountsFixedOrderOnlyPresent() {
        let list = [
            makeScenario("a", .academic),
            makeScenario("b", .workplace),
            makeScenario("c", .daily),
            makeScenario("d", .daily),
        ]
        XCTAssertEqual(scenarioCategoryCounts(list), [
            ScenarioCategoryCount(category: .daily, count: 2),
            ScenarioCategoryCount(category: .workplace, count: 1),
            ScenarioCategoryCount(category: .academic, count: 1),
        ])
    }

    private var previewList: [SpeakScenario] {
        (0..<3).map { makeScenario("d\($0)", .daily) } + (0..<5).map { makeScenario("t\($0)", .travel) }
    }

    func testFilterPreviewEmptyCategory() {
        let r = filterScenarioPreview(previewList, filter: .category(.academic), expanded: false, limit: 3)
        XCTAssertEqual(r.visible, [])
        XCTAssertEqual(r.total, 0)
        XCTAssertFalse(r.hasMore)
    }

    func testFilterPreviewSingleShowsAll() {
        let r = filterScenarioPreview(Array(previewList.prefix(1)), filter: .category(.daily), expanded: false, limit: 3)
        XCTAssertEqual(r.visible.map(\.id), ["d0"])
        XCTAssertFalse(r.hasMore)
    }

    func testFilterPreviewAllOverLimitCollapsed() {
        let r = filterScenarioPreview(previewList, filter: .all, expanded: false, limit: 3)
        XCTAssertEqual(r.visible.map(\.id), ["d0", "d1", "d2"])
        XCTAssertEqual(r.total, 8)
        XCTAssertTrue(r.hasMore)
    }

    func testFilterPreviewSpecificCategory() {
        let r = filterScenarioPreview(previewList, filter: .category(.travel), expanded: false, limit: 3)
        XCTAssertEqual(r.visible.map(\.id), ["t0", "t1", "t2"])
        XCTAssertEqual(r.total, 5)
        XCTAssertTrue(r.hasMore)
    }

    func testFilterPreviewExpandThenCollapse() {
        let expanded = filterScenarioPreview(previewList, filter: .all, expanded: true, limit: 3)
        XCTAssertEqual(expanded.visible.count, 8)
        XCTAssertFalse(expanded.hasMore)
        let collapsed = filterScenarioPreview(previewList, filter: .all, expanded: false, limit: 3)
        XCTAssertEqual(collapsed.visible.count, 3)
        XCTAssertTrue(collapsed.hasMore)
    }

    func testFilterPreviewDefaultLimitIsEight() {
        XCTAssertEqual(scenarioPreviewLimit, 8)
        let nine = (0..<9).map { makeScenario("n\($0)") }
        let r = filterScenarioPreview(nine, filter: .all, expanded: false)
        XCTAssertEqual(r.visible.count, 8)
        XCTAssertEqual(r.total, 9)
        XCTAssertTrue(r.hasMore)
    }

    func testFilterPreviewDoesNotMutateInput() {
        let frozen = [makeScenario("x"), makeScenario("y")]
        _ = filterScenarioPreview(frozen, filter: .all, expanded: true, limit: 1)
        XCTAssertEqual(frozen.count, 2)
        XCTAssertEqual(frozen.map(\.id), ["x", "y"])
    }
}
