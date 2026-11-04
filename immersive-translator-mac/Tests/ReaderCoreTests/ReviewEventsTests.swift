import XCTest
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 复习事件归并单测（对齐 Windows src/core/learningRelay.test.ts
// 「review event reconstruction」7 向量 + 规范 JSON 细义）。
// ---------------------------------------------------------------------------

final class ReviewEventsTests: XCTestCase {
    private func event(_ id: String, _ reviewedAt: Int64, _ extra: JSONObject = [:], dropping: [String] = []) -> JSONObject {
        var base: JSONObject = [
            "v": 2, "id": id, "wordId": "word", "deviceId": "phone", "reviewedAt": reviewedAt,
            "kind": "grade", "grade": "good", "mode": "cloze", "generation": "g", "recall": ["bucket": "pass"],
        ]
        for key in dropping { base.removeValue(forKey: key) }
        for (key, value) in extra { base[key] = value }
        return base
    }

    private func reduce(_ events: [JSONObject], generation: String?, baseline: VocabSrsState = initialSrs(now: 0), recall: RecallStat? = nil) throws -> ReviewReduction {
        try reduceReviewEvents(baseline: baseline, input: events, wordId: "word", generation: generation, baselineRecall: recall)
    }

    func testUnscopedOldEventsBelongOnlyToMigratedLegacyGeneration() throws {
        let old = event("old", 10, dropping: ["generation"])
        let undo = event("undo", 20, ["generation": "legacy-1", "kind": "undo", "reversesEventId": "old"], dropping: ["grade", "recall"])
        XCTAssertEqual(try reduce([old], generation: "legacy-1").srs.reps, 1)
        XCTAssertEqual(try reduce([old], generation: "new-generation").srs.reps, 0)
        XCTAssertEqual(try reduce([old, undo], generation: "legacy-1").srs.reps, 0)
        XCTAssertNil(old["generation"])  // 入参不被改写
    }

    func testReplaysOfflineEventsInDeterministicOrderOnce() throws {
        let a = event("a", 10)
        let b = event("b", 20, ["grade": "forgot", "recall": ["bucket": "wrong"]])
        let left = try reduce([b, a, a], generation: "g")
        let right = try reduce([a, b], generation: "g")
        XCTAssertEqual(left.srs, right.srs)
        XCTAssertEqual(left.recall, right.recall)
        XCTAssertTrue(LearningJSON.equal(left.activeEvents, right.activeEvents))
        XCTAssertEqual(try reduce([b, a], generation: "g").srs.reps, 2)
    }

    func testPreservesRealMigratedSrsAndRecallSnapshotWithoutFakeEvents() throws {
        var base = initialSrs(now: 1)
        base.reps = 5
        let recall = RecallStat(
            total: RecallModeStat(pass: 4, wrong: 3, trap: 1),
            byMode: ["cloze": RecallModeStat(pass: 4, wrong: 3, trap: 1)],
            lastAt: 1
        )
        let result = try reduce([event("a", 10)], generation: "g", baseline: base, recall: recall)
        XCTAssertEqual(result.srs.reps, 6)
        XCTAssertEqual(result.recall.total, RecallModeStat(pass: 5, wrong: 3, trap: 1))
        XCTAssertEqual(result.recall.lastAt, 10)
        XCTAssertEqual(recall.total.pass, 4)  // 真实快照不被改写
    }

    func testReplacementAndUndoRestorePriorRatingWithoutIncreasingCount() throws {
        let a = event("a", 10)
        let b = event("b", 20, ["grade": "easy", "supersedesEventId": "a"])
        XCTAssertEqual(try reduce([a, b], generation: "g").srs.reps, 1)
        let undo = event("u", 30, ["kind": "undo", "reversesEventId": "b"], dropping: ["grade", "recall"])
        let active = try reduce([a, b, undo], generation: "g").activeEvents
        XCTAssertEqual(active.count, 1)
        XCTAssertTrue(LearningJSON.equal(active.first, a))
    }

    func testConcurrentReplacementsOfTheSameReviewCountOnce() throws {
        let a = event("a", 10)
        let b = event("b", 20, ["supersedesEventId": "a"])
        let c = event("c", 20, ["grade": "easy", "supersedesEventId": "a"])
        let active = try reduce([c, a, b], generation: "g").activeEvents
        XCTAssertEqual(active.count, 1)
        XCTAssertTrue(LearningJSON.equal(active.first, c))
    }

    func testDeletedAndRecollectedWordGenerationsCannotInheritOldEvents() throws {
        XCTAssertEqual(try reduce([event("a", 10)], generation: "new").srs.reps, 0)
    }

    func testSameEventIDWithDifferentGradeFailsInsteadOfOverwritingHistory() {
        XCTAssertThrowsError(try reduce([event("a", 10), event("a", 10, ["grade": "easy"])], generation: "g")) { error in
            XCTAssertEqual(error as? ReviewEventError, .immutableConflict("a"))
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, "Immutable review event conflict: a")
        }
    }

    // MARK: isReviewEvent 形状守卫

    func testIsReviewEventShapeGuard() {
        XCTAssertTrue(isReviewEvent(event("a", 10)))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["v": 1])))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["reviewedAt": -1])))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["day": "2026/11/01"])))
        XCTAssertTrue(isReviewEvent(event("a", 10, ["day": "2026-11-01"])))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["kind": "undo", "reversesEventId": "a"])))  // 不能撤销自己
        XCTAssertFalse(isReviewEvent(event("a", 10, ["supersedesEventId": "a"])))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["recall": ["bucket": "maybe"]])))
        XCTAssertFalse(isReviewEvent(event("a", 10, ["grade": "perfect"])))
        XCTAssertFalse(isReviewEvent(["v": 2]))
    }

    // MARK: 规范 JSON 与 JS JSON.stringify 对齐

    func testCanonicalJSONMatchesJavaScriptStringify() {
        XCTAssertEqual(canonicalJSON(["b": 1, "a": "x"]), "{\"a\":\"x\",\"b\":1}")
        XCTAssertEqual(canonicalJSON(["zh": NSNull(), "en": "😀", "idx": 0]), "{\"en\":\"😀\",\"idx\":0,\"zh\":null}")
        XCTAssertEqual(canonicalJSON([1, 2.5, true, false, "a\"b\\c\n\u{01}"]), "[1,2.5,true,false,\"a\\\"b\\\\c\\n\\u0001\"]")
        XCTAssertEqual(LearningJSON.numberString(0.1), "0.1")
        XCTAssertEqual(LearningJSON.numberString(-0.0), "0")
        XCTAssertEqual(LearningJSON.numberString(1e21), "1e+21")
        XCTAssertEqual(LearningJSON.numberString(1e-7), "1e-7")
        XCTAssertEqual(LearningJSON.numberString(0.000001), "0.000001")
        XCTAssertEqual(LearningJSON.numberString(1_152_921_504_606_846_976), "1152921504606847000")
        XCTAssertEqual(LearningJSON.numberString(1.5), "1.5")
        XCTAssertEqual(LearningJSON.numberString(1_700_000_000_000), "1700000000000")
        // 中文 3 字节/字：{"title":"四字标题"} = 12 ASCII + 4×3
        XCTAssertEqual(LearningJSON.byteCount(["title": "四字标题"]), 24)
        // undefined 值的键省略；数组里的 undefined 写 null
        let optionalNone: String? = nil
        XCTAssertEqual(canonicalJSON(["a": optionalNone as Any, "b": 1]), "{\"b\":1}")
    }
}
