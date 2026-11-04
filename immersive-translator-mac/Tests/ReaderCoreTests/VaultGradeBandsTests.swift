import XCTest
@testable import ReaderCore

/// 「笔记与复习」三档评分带契约（2026-10-26 改版，对齐 Windows VaultPage.test.tsx
/// 「三档评分映射」向量与 VaultPage.tsx:122-176）：
/// - 三档名称/档位/快捷键：没记住/forgot/1、有点模糊/hard/2、记住了/good/3；
/// - vaultNextLabel 从 gradeIntervalMs 间隔定值派生：10 分钟后再来 / 明天再看 / 3 天后再看；
/// - vaultSuggested：一次写对（perfect→easy）的建议档收敛为 good（3 天）；
/// - GRADE_COPY 四档契约不动（ReviewView.tsx:111-116 的 Mac 对应 ReviewGrade.label/nextLabel）。
final class VaultGradeBandsTests: XCTestCase {

    // MARK: - 三档映射

    func testVaultGradeBandsNameGradeKeyContract() {
        XCTAssertEqual(vaultGradeBands.count, 3, "vault 表面只有三档（easy 不在带里）")
        XCTAssertEqual(vaultGradeBands[0].grade, .forgot)
        XCTAssertEqual(vaultGradeBands[0].name, "没记住")
        XCTAssertEqual(vaultGradeBands[0].key, "1")
        XCTAssertEqual(vaultGradeBands[1].grade, .hard)
        XCTAssertEqual(vaultGradeBands[1].name, "有点模糊")
        XCTAssertEqual(vaultGradeBands[1].key, "2")
        XCTAssertEqual(vaultGradeBands[2].grade, .good)
        XCTAssertEqual(vaultGradeBands[2].name, "记住了")
        XCTAssertEqual(vaultGradeBands[2].key, "3")
    }

    // MARK: - 间隔副行（从间隔定值派生）

    func testVaultNextLabelDerivedFromIntervals() {
        XCTAssertEqual(vaultNextLabel(.forgot), "10 分钟后再来")
        XCTAssertEqual(vaultNextLabel(.hard), "明天再看")
        XCTAssertEqual(vaultNextLabel(.good), "3 天后再看")
    }

    func testVaultNextLabelFollowsIntervalConstants() {
        // 派生口径：分钟<60 → N 分钟后再来；天≤1 → 明天再看；否则 N 天后再看。
        XCTAssertEqual(gradeIntervalMs(.forgot), 10 * 60 * 1000)
        XCTAssertEqual(gradeIntervalMs(.hard), 24 * 60 * 60 * 1000)
        XCTAssertEqual(gradeIntervalMs(.good), 3 * 24 * 60 * 60 * 1000)
        // easy 的间隔常量本身不被 vault 带使用，但派生函数仍应对齐四档语义。
        XCTAssertEqual(vaultNextLabel(.easy), "7 天后再看")
    }

    // MARK: - 建议档收敛（easy → good）

    func testVaultSuggestedCollapsesEasyToGood() {
        // 一次写对 perfect 的四档建议是 easy；vault 三档带收敛为 good（Windows vaultSuggested）。
        XCTAssertEqual(verdictToSuggestedGrade(.perfect), .easy, "前置：四档建议 perfect→easy")
        XCTAssertEqual(vaultSuggested(.perfect), .good)
        XCTAssertEqual(vaultNextLabel(vaultSuggested(.perfect)), "3 天后再看")
        // 其余判分档保持原样。
        XCTAssertEqual(vaultSuggested(.close), .good)
        XCTAssertEqual(vaultSuggested(.trap), .forgot)
        XCTAssertEqual(vaultSuggested(.wrong), .forgot)
    }

    // MARK: - GRADE_COPY 四档契约不动

    func testGradeCopyFourBandContractUnchanged() {
        XCTAssertEqual(ReviewGrade.forgot.label, "没想起")
        XCTAssertEqual(ReviewGrade.forgot.nextLabel, "10分钟后再来")
        XCTAssertEqual(ReviewGrade.hard.label, "很勉强")
        XCTAssertEqual(ReviewGrade.hard.nextLabel, "明天再来")
        XCTAssertEqual(ReviewGrade.good.label, "想起来了")
        XCTAssertEqual(ReviewGrade.good.nextLabel, "3天后再来")
        XCTAssertEqual(ReviewGrade.easy.label, "很轻松")
        XCTAssertEqual(ReviewGrade.easy.nextLabel, "7天后再来")
    }

    // MARK: - outcome 文案（easy 回落 GRADE_COPY「很轻松」）

    func testVaultGradeNameFallsBackToGradeCopyForEasy() {
        XCTAssertEqual(vaultGradeName(.good), "记住了")
        XCTAssertEqual(vaultGradeName(.hard), "有点模糊")
        XCTAssertEqual(vaultGradeName(.forgot), "没记住")
        // 听写卡四档带评了 easy：outcome 不落进「没记住」，回落「很轻松」。
        XCTAssertEqual(vaultGradeName(.easy), "很轻松")
        XCTAssertEqual(VaultFocusOutcomeText.graded(.easy), "已按「很轻松」完成")
        XCTAssertEqual(VaultFocusOutcomeText.graded(.good), "已按「记住了」完成")
    }

    // MARK: - vaultMinutes（Hero/看板共用口径）

    func testVaultMinutesCeilSixPerMinute() {
        XCTAssertEqual(vaultMinutes(0), 1, "N=0 时为 1，避免出现「0 分钟」")
        XCTAssertEqual(vaultMinutes(1), 1)
        XCTAssertEqual(vaultMinutes(5), 3)   // ceil(3.0)
        XCTAssertEqual(vaultMinutes(6), 4)   // ceil(3.6)
    }
}
