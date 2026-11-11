import XCTest
@testable import ReaderCore

/// planTranslateRetry 行为向量。Mac 先行版（2026-11-05 Happy Prince 批量判死复盘）：
/// 等待时长优先服务端 `Retry-After`（clamp 5~60s，无头回退 20s）、连续 429 熔断、
/// 整篇预算按段数比例（每段摊 2 次、下限 12）——与 Windows paragraphTranslate.test.ts
///（每段 ≤1 次 + 固定 20s + 封顶 6 次）语义分叉，Windows 待跟进对齐。
final class ParagraphTranslateBackoffTests: XCTestCase {
    /// 429 且无 Retry-After 头 → 回退等待 20s（常量=20_000）。
    func test429WithoutHeaderFallsBackTo20Seconds() {
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: nil,
                runBackoffs: 0, consecutive429s: 1, totalGroups: 1
            ),
            .wait(ms: translateBackoffWaitMs)
        )
        XCTAssertEqual(translateBackoffWaitMs, 20_000)
    }

    /// Retry-After 接线：等待时长取服务端给的秒数（毫秒换算）。
    func testRetryAfterHeaderDrivesWaitDuration() {
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 6,
                runBackoffs: 0, consecutive429s: 1, totalGroups: 1
            ),
            .wait(ms: 6_000)
        )
    }

    /// Retry-After clamp：异常小值抬到 5s、异常大值压到 60s。
    func testRetryAfterClampedTo5To60Seconds() {
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 0,
                runBackoffs: 0, consecutive429s: 1, totalGroups: 1
            ),
            .wait(ms: 5_000)
        )
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 3600,
                runBackoffs: 0, consecutive429s: 1, totalGroups: 1
            ),
            .wait(ms: 60_000)
        )
        XCTAssertEqual(translateBackoffWaitMinSec, 5)
        XCTAssertEqual(translateBackoffWaitMaxSec, 60)
    }

    /// 连续 429 熔断（阈值=10）：连续 10 次 429 且无成功 → 整篇暂停（保持 pending）。
    func testConsecutive429CircuitBreaksToPauseRun() {
        XCTAssertEqual(translateMaxConsecutive429, 10)
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 6,
                runBackoffs: 0, consecutive429s: translateMaxConsecutive429 - 1, totalGroups: 1
            ),
            .wait(ms: 6_000),
            "熔断线下继续退避"
        )
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 6,
                runBackoffs: 0, consecutive429s: translateMaxConsecutive429, totalGroups: 1
            ),
            .pauseRun
        )
    }

    /// 整篇预算按段数比例（每段摊 2 次、下限 12）：85 段 = 170 次预算。
    func testRunBackoffBudgetScalesWithTotalGroups() {
        XCTAssertEqual(translateRunBackoffBudget(totalGroups: 1), 12)
        XCTAssertEqual(translateRunBackoffBudget(totalGroups: 6), 12, "下限兜底")
        XCTAssertEqual(translateRunBackoffBudget(totalGroups: 85), 170)
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 6,
                runBackoffs: translateRunBackoffBudget(totalGroups: 85) - 1,
                consecutive429s: 1, totalGroups: 85
            ),
            .wait(ms: 6_000),
            "预算内继续退避"
        )
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 429, retryAfterSeconds: 6,
                runBackoffs: translateRunBackoffBudget(totalGroups: 85),
                consecutive429s: 1, totalGroups: 85
            ),
            .pauseRun,
            "总预算耗尽 → 整篇暂停"
        )
    }

    /// 非 429（结构化状态码判定，如 500）→ 立即判死（维持原语义）。
    func testNon429StatusFailsNow() {
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: 500, retryAfterSeconds: nil,
                runBackoffs: 0, consecutive429s: 0, totalGroups: 1
            ),
            .failNow
        )
    }

    /// 状态码未知（nil：超时/未配置等非 HTTP 失败）→ 立即判死。
    func testNullStatusFailsNow() {
        XCTAssertEqual(
            planTranslateRetry(
                httpStatus: nil, retryAfterSeconds: nil,
                runBackoffs: 0, consecutive429s: 0, totalGroups: 1
            ),
            .failNow
        )
    }
}
