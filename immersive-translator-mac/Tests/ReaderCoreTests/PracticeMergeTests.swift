import XCTest
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 练习任务离线合并单测（对齐 Windows src/core/practiceMerge.test.ts 全部 20 向量 +
// Rust learning_store.rs practice_* 向量）。断言一律走 LearningJSON.equal（JS toEqual 口径）。
// ---------------------------------------------------------------------------

final class PracticeMergeTests: XCTestCase {
    private func attempt(_ id: String, _ extra: JSONObject = [:]) -> JSONObject {
        var row: JSONObject = ["id": id, "step": 0, "text": id, "deviceId": "phone", "status": "draft", "createdAt": 1]
        for (key, value) in extra { row[key] = value }
        return row
    }

    private func task(_ extra: JSONObject = [:]) -> JSONObject {
        var row: JSONObject = [
            "id": "practice-a", "mode": "word", "title": "Test", "reference": "Hello", "step": 0, "draft": "",
            "status": "active", "createdAt": 1, "updatedAt": 10, "attempts": [attempt("old")],
        ]
        for (key, value) in extra { row[key] = value }
        return row
    }

    private func envelope(_ value: JSONObject) -> JSONObject {
        ["v": 2, "kind": "practice-task", "id": value["id"]!, "updatedAt": value["updatedAt"]!, "task": value]
    }

    private func merge(_ a: JSONObject, _ b: JSONObject) -> JSONObject {
        try! mergePracticeTask(existing: a, incoming: b)
    }

    private func attempts(_ row: JSONObject) -> [JSONObject] {
        (row["attempts"] as? [JSONObject]) ?? []
    }

    private func assertJSONEqual(_ lhs: Any?, _ rhs: Any?, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(LearningJSON.equal(lhs, rhs), "\n左：\(lhs ?? "nil")\n右：\(rhs ?? "nil")", file: file, line: line)
    }

    /// JS `toMatchObject`：期望里的每个键在实际值里深度匹配（对象递归子集、数组逐项、其余相等）。
    private func matches(_ actual: Any?, _ expected: Any?) -> Bool {
        if let expectedDict = LearningJSON.object(expected) {
            guard let actualDict = LearningJSON.object(actual) else { return false }
            return expectedDict.allSatisfy { key, value in matches(actualDict[key], value) }
        }
        if let expectedArray = LearningJSON.array(expected) {
            guard let actualArray = LearningJSON.array(actual), actualArray.count == expectedArray.count else { return false }
            return zip(actualArray, expectedArray).allSatisfy { matches($0, $1) }
        }
        return LearningJSON.equal(actual, expected)
    }

    private func assertMatches(_ actual: Any?, _ expected: JSONObject, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(matches(actual, expected), "\n实际：\(actual ?? "nil")\n期望子集：\(expected)", file: file, line: line)
    }

    // MARK: practiceMerge.test.ts

    func testKeepsEachDeviceAppendedAttemptAndDeterministicOrdering() {
        let a = task(["attempts": [attempt("old"), attempt("phone", ["createdAt": 20])], "updatedAt": 20])
        let b = task(["attempts": [attempt("old"), attempt("windows", ["createdAt": 30])], "updatedAt": 30])
        XCTAssertEqual(attempts(merge(a, b)).map { $0["id"] as? String }, ["old", "phone", "windows"])
        assertJSONEqual(merge(a, b), merge(b, a))
    }

    func testPreservesIndependentExpressionFeedbackAndAcousticAssessmentForOneAttempt() {
        let original = stampPracticeTask(previous: nil, next: task(), at: 10)
        let a = stampPracticeTask(previous: original, next: task(["attempts": [attempt("old", ["feedback": ["message": "Good", "extension": true]])]]), at: 20)
        let b = stampPracticeTask(previous: original, next: task(["attempts": [attempt("old", ["pronunciation": ["total": 4.5]])]]), at: 30)
        let merged = merge(a, b)
        assertMatches(attempts(merged)[0], ["feedback": ["message": "Good", "extension": true], "pronunciation": ["total": 4.5]])
        assertJSONEqual(merge(b, a), merged)
    }

    func testAdvancesOnlyFieldsActuallyEditedPreservingOldScalarClocks() {
        let original = stampPracticeTask(previous: nil, next: task(), at: 10)
        var draftEdit = original
        draftEdit["draft"] = "phone draft"
        var stepEdit = original
        stepEdit["step"] = 1
        let a = stampPracticeTask(previous: original, next: draftEdit, at: 20)
        let b = stampPracticeTask(previous: original, next: stepEdit, at: 30)
        assertMatches(merge(a, b), ["draft": "phone draft", "step": 1])
        XCTAssertEqual(LearningJSON.number((b["fieldUpdatedAt"] as? JSONObject)?["/draft"]), 10)
    }

    func testResolvesEqualTimestampsWithStableScalarTieBreak() {
        let a = task(["draft": "a"]), b = task(["draft": "z"])
        XCTAssertEqual(merge(a, b)["draft"] as? String, "z")
        assertJSONEqual(merge(a, b), merge(b, a))
    }

    func testKeepsExplicitFieldClearsAcrossStaleSaves() {
        let original = stampPracticeTask(previous: nil, next: task(["attempts": [attempt("old", ["error": "old failure"])]]), at: 10)
        let cleared = stampPracticeTask(previous: original, next: task(["attempts": [attempt("old")]]), at: 20)
        let merged = merge(original, cleared)
        XCTAssertNil(attempts(merged)[0]["error"])
        assertJSONEqual(merge(merged, original), merged)
    }

    func testNeverResurrectsCanceledRecordingIDsFromAStaleDevice() {
        let canceled = task(["attempts": [] as [JSONObject], "removedAttemptIds": ["old"], "updatedAt": 20])
        let stale = task(["attempts": [attempt("old", ["clipId": "clip"])], "updatedAt": 30])
        let merged = merge(canceled, stale)
        XCTAssertEqual(attempts(merged).count, 0)
        assertMatches(merged, ["removedAttemptIds": ["old"]])
        assertJSONEqual(merge(stale, canceled), merged)
    }

    func testIsAssociativeAndIdempotentForThreeIndependentOfflineEdits() {
        let original = stampPracticeTask(previous: nil, next: task(), at: 10)
        var draftEdit = original
        draftEdit["draft"] = "A"
        var stepEdit = original
        stepEdit["step"] = 1
        var attemptEdit = original
        attemptEdit["attempts"] = attempts(original) + [attempt("new")]
        let a = stampPracticeTask(previous: original, next: draftEdit, at: 20)
        let b = stampPracticeTask(previous: original, next: stepEdit, at: 25)
        let c = stampPracticeTask(previous: original, next: attemptEdit, at: 30)
        let merged = merge(merge(a, b), c)
        assertJSONEqual(merge(a, merge(b, c)), merged)
        assertJSONEqual(merge(merged, merged), merged)
    }

    func testRetainsUnknownNestedFieldsWhenTheUpdatedResultChanges() {
        let a = task(["attempts": [attempt("old", ["feedback": ["message": "a", "future": ["format": 2]]])]])
        let b = task(["attempts": [attempt("old", ["feedback": ["message": "b"]])], "updatedAt": 20])
        assertMatches(attempts(merge(a, b))[0], ["feedback": ["message": "b", "future": ["format": 2]]])
    }

    func testConvergesForThreeEqualClockNestedObjectsInEveryMergeOrder() {
        let a = task(["future": ["x": "A", "z": 0]]), b = task(["future": ["x": "B", "y": 0]]), c = task(["future": ["x": "C", "a": 0]])
        let left = merge(merge(a, b), c), right = merge(a, merge(b, c))
        assertJSONEqual(left, right)
        assertMatches(left, ["future": ["x": "C", "z": 0, "y": 0, "a": 0]])
    }

    func testRetainsIndependentNestedFeedbackClocksAcrossDifferentEditTimes() {
        let a = stampPracticeTask(previous: nil, next: task(["attempts": [attempt("old", ["feedback": ["message": "newer"]])]]), at: 20)
        let b = stampPracticeTask(previous: nil, next: task(["attempts": [attempt("old", ["feedback": ["future": ["version": 2]]])]]), at: 30)
        let c = stampPracticeTask(previous: nil, next: task(["attempts": [attempt("old", ["feedback": ["message": "older"]])]]), at: 10)
        let left = merge(merge(a, b), c), right = merge(a, merge(b, c))
        assertJSONEqual(left, right)
        assertMatches(attempts(left)[0], ["feedback": ["message": "newer", "future": ["version": 2]]])
    }

    func testConvergesWhenAnUnknownFieldChangesBetweenObjectAndScalar() {
        let a = task(["future": ["x": 1], "updatedAt": 10]), b = task(["future": 0, "updatedAt": 20]), c = task(["future": ["y": 2], "updatedAt": 30])
        let left = merge(merge(a, b), c), right = merge(a, merge(b, c))
        assertJSONEqual(left, right)
        assertMatches(left, ["future": ["y": 2]])
        assertJSONEqual(merge(left, left), left)
    }

    func testMergesOnlyMatchingTaskEnvelopesAndRetainsEnvelopeExtensions() {
        var a = envelope(task())
        a["future"] = ["level": 2]
        let b = envelope(task(["attempts": [attempt("new")], "updatedAt": 20]))
        let merged = mergePracticePayload(existing: a, incoming: b)
        assertMatches(merged, ["future": ["level": 2]])
        let ids = attempts(merged?["task"] as? JSONObject ?? [:]).map { $0["id"] as? String }
        XCTAssertEqual(ids, ["new", "old"])  // createdAt 相等 → id 稳定序
        var other = b
        var otherTask = task(["attempts": [attempt("new")], "updatedAt": 20])
        otherTask["id"] = "other"
        other["task"] = otherTask
        XCTAssertNil(mergePracticePayload(existing: a, incoming: other))
        XCTAssertNil(mergePracticePayload(existing: a, incoming: NSNull()))
        XCTAssertNil(mergePracticePayload(existing: a, incoming: nil))
    }

    func testConvergesAcrossEveryMergeOrderForNestedEnvelopeFields() {
        var a = envelope(task()), b = envelope(task()), c = envelope(task())
        a["future"] = ["x": "A", "z": 0]
        b["future"] = ["x": "B", "y": 0]
        c["future"] = ["x": "C", "a": 0]
        let left = mergePracticePayload(existing: mergePracticePayload(existing: a, incoming: b), incoming: c)
        let right = mergePracticePayload(existing: a, incoming: mergePracticePayload(existing: b, incoming: c))
        assertJSONEqual(left, right)
    }

    func testNormalizesDerivedEnvelopeFieldsOnceIncludingLegacyMissingEndedAt() {
        let value = envelope(task())
        let merged = mergePracticePayload(existing: value, incoming: value)!
        assertJSONEqual(mergePracticePayload(existing: merged, incoming: merged), merged)
        XCTAssertEqual(LearningJSON.number(merged["endedAt"]), LearningJSON.number(merged["updatedAt"]))
    }

    func testKeepsRegisterAlgebraForObjectScalarArrayAndClearTransitions() {
        let values: [Any?] = [nil, NSNull(), 0, "z", [] as [Any], [1], ["x": 1], ["x": 2, "y": 0], ["z": ["a": 2]]]
        func withFuture(_ value: Any?) -> JSONObject {
            var row = task()
            if let value { row["future"] = value } else { row.removeValue(forKey: "future") }
            return row
        }
        for i in values.indices {
            for j in values.indices {
                for k in values.indices {
                    let a = stampPracticeTask(previous: nil, next: withFuture(values[i]), at: 10)
                    let b = stampPracticeTask(previous: a, next: withFuture(values[j]), at: 20)
                    let c = stampPracticeTask(previous: a, next: withFuture(values[k]), at: 30)
                    XCTAssertTrue(
                        LearningJSON.equal(merge(merge(a, b), c), merge(a, merge(b, c))),
                        "结合律失败 i=\(i) j=\(j) k=\(k)"
                    )
                }
            }
        }
    }

    func testRendersAnObjectAfterAStampedScalarOrArrayRoundTrip() {
        for value in [0 as Any, NSNull(), [] as [Any], "text"] {
            var base = task()
            base["future"] = ["x": 1]
            let old = stampPracticeTask(previous: nil, next: base, at: 10)
            var scalarEdit = old
            scalarEdit["future"] = value
            let scalar = stampPracticeTask(previous: old, next: scalarEdit, at: 20)
            var restoredEdit = scalar
            restoredEdit["future"] = ["y": 2]
            let restored = stampPracticeTask(previous: scalar, next: restoredEdit, at: 30)
            assertMatches(restored, ["future": ["y": 2]])
            XCTAssertFalse(matches(restored, ["future": ["x": 1]]))
            assertJSONEqual(merge(merge(old, scalar), restored), merge(old, merge(scalar, restored)))
            assertJSONEqual(merge(restored, restored), restored)
        }
    }

    // MARK: Rust learning_store.rs practice_* 向量

    private func practiceFixture(_ at: Int64, _ attempts: [JSONObject]) -> JSONObject {
        ["kind": "practice-task", "id": "task", "updatedAt": at, "task": ["id": "task", "updatedAt": at, "draft": "", "attempts": attempts]]
    }

    func testPracticeMergeKeepsOfflineAttemptsFeedbackAndISE() {
        let a = practiceFixture(20, [["id": "same", "text": "a", "createdAt": 1, "feedback": ["message": "Good", "future": true]], ["id": "windows", "createdAt": 2]])
        let b = practiceFixture(30, [["id": "same", "text": "b", "createdAt": 1, "pronunciation": ["total": 4.5]], ["id": "phone", "createdAt": 3]])
        let merged = mergePracticePayload(existing: a, incoming: b)!
        assertJSONEqual(merged, mergePracticePayload(existing: b, incoming: a))
        assertJSONEqual(merged, mergePracticePayload(existing: merged, incoming: merged))
        let rows = attempts(merged["task"] as! JSONObject)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(LearningJSON.string((rows[0]["feedback"] as? JSONObject)?["message"]), "Good")
        XCTAssertEqual(LearningJSON.number((rows[0]["pronunciation"] as? JSONObject)?["total"]), 4.5)
        XCTAssertEqual(rows[0]["text"] as? String, "b")
    }

    func testPracticeRemovalIDsPreventResurrection() {
        let live = practiceFixture(30, [["id": "cancelled", "clipId": "local"]])
        var canceled = practiceFixture(20, [])
        var canceledTask = canceled["task"] as! JSONObject
        canceledTask["removedAttemptIds"] = ["cancelled"]
        canceled["task"] = canceledTask
        let merged = mergePracticePayload(existing: live, incoming: canceled)!
        let mergedTask = merged["task"] as! JSONObject
        XCTAssertEqual(attempts(mergedTask).count, 0)
        assertJSONEqual(mergedTask["removedAttemptIds"], ["cancelled"])
    }

    func testPracticeClocksPreserveIndependentFieldsAndExplicitClears() {
        let a: JSONObject = ["updatedAt": 20, "draft": "phone", "step": 0, "fieldUpdatedAt": ["draft": 20, "step": 10, "error": 20]]
        let b: JSONObject = ["updatedAt": 30, "draft": "", "step": 1, "error": "old", "fieldUpdatedAt": ["draft": 10, "step": 30, "error": 10]]
        let merged = mergePracticeFields(a, b, fallbackA: 20, fallbackB: 30)
        XCTAssertEqual(merged["draft"] as? String, "phone")
        XCTAssertEqual(LearningJSON.number(merged["step"]), 1)
        XCTAssertNil(merged["error"])
        assertJSONEqual(merged, mergePracticeFields(b, a, fallbackA: 30, fallbackB: 20))
    }

    func testPracticeNestedLeafRegistersAreAssociative() {
        var a: JSONObject = ["future": ["x": "A", "z": 0], "updatedAt": 10]
        var b: JSONObject = ["future": ["x": "B", "y": 0], "updatedAt": 10]
        var c: JSONObject = ["future": ["x": "C", "a": 0], "updatedAt": 10]
        var left = mergePracticeFields(mergePracticeFields(a, b, fallbackA: 10, fallbackB: 10), c, fallbackA: 10, fallbackB: 10)
        var right = mergePracticeFields(a, mergePracticeFields(b, c, fallbackA: 10, fallbackB: 10), fallbackA: 10, fallbackB: 10)
        assertJSONEqual(left, right)
        XCTAssertEqual(LearningJSON.string((left["future"] as? JSONObject)?["x"]), "C")
        a = ["feedback": ["message": "newer"], "updatedAt": 20]
        b = ["feedback": ["future": ["version": 2]], "updatedAt": 30]
        c = ["feedback": ["message": "older"], "updatedAt": 10]
        left = mergePracticeFields(mergePracticeFields(a, b, fallbackA: 20, fallbackB: 30), c, fallbackA: 30, fallbackB: 10)
        right = mergePracticeFields(a, mergePracticeFields(b, c, fallbackA: 30, fallbackB: 10), fallbackA: 20, fallbackB: 30)
        assertJSONEqual(left, right)
        assertMatches(left, ["feedback": ["message": "newer", "future": ["version": 2]]])
    }

    func testPracticeTypeChangesRetainShadowRegistersToConverge() {
        let a: JSONObject = ["future": ["x": 1], "updatedAt": 10]
        let b: JSONObject = ["future": 0, "updatedAt": 20]
        let c: JSONObject = ["future": ["y": 2], "updatedAt": 30]
        let left = mergePracticeFields(mergePracticeFields(a, b, fallbackA: 10, fallbackB: 20), c, fallbackA: 20, fallbackB: 30)
        let right = mergePracticeFields(a, mergePracticeFields(b, c, fallbackA: 20, fallbackB: 30), fallbackA: 10, fallbackB: 30)
        assertJSONEqual(left, right)
        assertJSONEqual(left["future"], ["y": 2])
        assertJSONEqual(left, mergePracticeFields(left, left, fallbackA: 30, fallbackB: 30))
    }

    func testStampedTaskCarriesClockMetadata() {
        let stamped = stampPracticeTask(previous: nil, next: task(["updatedAt": 42]), at: 50)
        XCTAssertEqual(LearningJSON.number(stamped["updatedAt"]), 50)
        let clocks = stamped["fieldUpdatedAt"] as? JSONObject
        XCTAssertNotNil(clocks?["/draft"])
        XCTAssertNotNil(clocks?["/title"])
        XCTAssertNil(clocks?["/attempts"])  // 集合字段不进寄存器
        XCTAssertNotNil(attempts(stamped)[0]["fieldUpdatedAt"])
    }
}
