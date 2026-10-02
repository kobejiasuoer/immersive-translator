import XCTest
@testable import ReaderCore

/// 跟读报告诊断逻辑单测：徽章判定、短板维度点名、差词/漏词清单、音素提示。
/// 对齐 src/core/shadowDiagnose.test.ts（Windows 口语陪练报告卡）。

final class ShadowDiagnoseTests: XCTestCase {
    // MARK: - 构造辅助

    /// 诊断输入的一个词（对齐 mapWordsToText 的产出：quality + word 明细）。
    private func mark(_ content: String, quality: ShadowDiagQuality, score: Double) -> ShadowDiagMark {
        ShadowDiagMark(quality: quality, score: score, word: ShadowDiagWord(content: content, phones: []))
    }

    private func result(
        total: Double,
        accuracy: Double = 4.3,
        fluency: Double = 3.4,
        integrity: Double = 4.6,
        isRejected: Bool = false,
        exceptInfo: String? = nil
    ) -> ShadowDiagResult {
        ShadowDiagResult(
            total: total, accuracy: accuracy, fluency: fluency, integrity: integrity,
            isRejected: isRejected, exceptInfo: exceptInfo
        )
    }

    private func joined(_ d: ShadowDiagnosis) -> String {
        d.segments.map(\.text).joined()
    }

    // MARK: - 主场景

    func testMainScenarioAlmostBadgeWeakFluency() {
        // 词序 the(5)/quick(4.7)/brown(漏读)/fox(2.5 差词)/jumps(3.5 ok)/over/the/lazy/dog
        let marks = [
            mark("the", quality: .good, score: 5),
            mark("quick", quality: .good, score: 4.7),
            mark("brown", quality: .missed, score: 0),
            mark("fox", quality: .bad, score: 2.5),
            mark("jumps", quality: .ok, score: 3.5),
            mark("over", quality: .good, score: 5),
            mark("the", quality: .good, score: 5),
            mark("lazy", quality: .good, score: 4.9),
            mark("dog", quality: .good, score: 4.7),
        ]
        let d = diagnoseShadow(result(total: 4.1), marks)
        XCTAssertFalse(d.pass)
        XCTAssertEqual(d.badgeKind, .almost)
        XCTAssertEqual(d.badge, "差 0.1 过关")
        XCTAssertEqual(d.weakDim, .fluency)
        XCTAssertEqual(d.drillWords, ["fox", "brown"])
        XCTAssertEqual(d.badCount, 1)
        XCTAssertEqual(d.missedCount, 1)
        // 诊断句点名短板与差词/漏词
        let text = joined(d)
        XCTAssertTrue(text.contains("流畅度 3.4"))
        XCTAssertTrue(text.contains("fox"))
        XCTAssertTrue(text.contains("漏读了 brown"))
        // 短板维度片段是 warn 强调
        XCTAssertTrue(d.segments.contains { $0.kind == .warn && $0.text.contains("流畅度") })
    }

    // MARK: - 过关 / 明显不足

    func testPassBadgePositiveCopyNoProblemList() {
        let marks = [
            mark("the", quality: .good, score: 4.9),
            mark("quick", quality: .good, score: 4.6),
            mark("brown", quality: .good, score: 4.8),
            mark("fox", quality: .good, score: 4.4),
        ]
        let d = diagnoseShadow(result(total: 4.7, accuracy: 4.8, fluency: 4.6, integrity: 5), marks)
        XCTAssertTrue(d.pass)
        XCTAssertEqual(d.badgeKind, .pass)
        XCTAssertTrue(d.drillWords.isEmpty)
        let text = joined(d)
        XCTAssertFalse(text.contains("漏读"))
        XCTAssertFalse(text.contains("不准"))
    }

    func testFailBadgeWithoutWeakDimWhenGapsSmall() {
        // 三项都 ≥4.7（gap < 0.4）→ 不硬点名维度
        let marks = [
            mark("the", quality: .ok, score: 3.0),
            mark("end", quality: .bad, score: 2.9),
        ]
        let d = diagnoseShadow(result(total: 2.8, accuracy: 4.7, fluency: 4.75, integrity: 4.7), marks)
        XCTAssertEqual(d.badgeKind, .fail)
        XCTAssertEqual(d.badge, "再练练")
        XCTAssertNil(d.weakDim)
    }

    func testMoreThanFourDrillWordsFocusFirstFour() {
        // a,b,d,e 差词在前、c,f 漏词在后，按出现序聚焦前 4
        let marks = [
            mark("a", quality: .bad, score: 1),
            mark("b", quality: .bad, score: 1),
            mark("c", quality: .missed, score: 0),
            mark("d", quality: .bad, score: 1),
            mark("e", quality: .bad, score: 1),
            mark("f", quality: .missed, score: 0),
        ]
        let d = diagnoseShadow(result(total: 2.5), marks)
        XCTAssertEqual(d.drillWords, ["a", "b", "d", "e"])
        XCTAssertEqual(d.badCount, 4)
        XCTAssertEqual(d.missedCount, 2)
    }

    // MARK: - 音素

    func testWorstPhoneOfPicksHeaviestPenaltyAboveThreshold() {
        let word = ShadowDiagWord(content: "latte", phones: [
            ShadowDiagPhone(content: "l", gwpp: -0.01),
            ShadowDiagPhone(content: "aa", gwpp: -1.9),
            ShadowDiagPhone(content: "t", gwpp: -0.05),
            ShadowDiagPhone(content: "ey", gwpp: -0.1),
        ])
        XCTAssertEqual(worstPhoneOf(word)?.content, "aa")
        // 都很轻微 → 不点名
        let clean = ShadowDiagWord(
            content: "latte",
            phones: word.phones.map { ShadowDiagPhone(content: $0.content, gwpp: -0.05) }
        )
        XCTAssertNil(worstPhoneOf(clean))
        XCTAssertNil(worstPhoneOf(nil))
    }

    func testPhoneTipKnownPhonesAndFallback() {
        XCTAssertTrue(phoneTip("dh").contains("齿"))
        XCTAssertTrue(phoneTip("ih").contains("短"))
        XCTAssertTrue(phoneTip("xx").contains("领读"))  // 兜底
    }

    // MARK: - 拒绝 / 异常（isPass 语义的前两项）

    func testRejectedAndExceptResultsNeverPass() {
        XCTAssertFalse(diagnoseShadow(result(total: 5, isRejected: true), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28673"), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28680"), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28676"), []).pass)
    }
}
