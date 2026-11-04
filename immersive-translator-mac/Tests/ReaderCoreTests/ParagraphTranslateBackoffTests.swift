import XCTest
@testable import ReaderCore

/// planTranslateRetry 行为向量——对齐 Windows paragraphTranslate.test.ts:78-111
/// （429 自动退避的判定只认结构化 HTTP 状态码，双配额：每段 ≤1 次、整篇 ≤6 次）。
final class ParagraphTranslateBackoffTests: XCTestCase {
    /// 429 且两重配额未满 → 等待 20s（常量=20_000）。
    func test429WithQuotaLeftWaits20Seconds() {
        XCTAssertEqual(
            planTranslateRetry(httpStatus: 429, groupRetries: 0, runBackoffs: 0),
            translateBackoffWaitMs
        )
        XCTAssertEqual(translateBackoffWaitMs, 20_000)
    }

    /// 每段自动重试最多 1 次：groupRetries 已满 → 不再重试。
    func testGroupRetriesExhaustedReturnsNil() {
        XCTAssertNil(planTranslateRetry(httpStatus: 429, groupRetries: 1, runBackoffs: 0))
    }

    /// 整篇退避总次数上限 6：runBackoffs 已满 → 不再重试（常量=1/6）。
    func testRunBackoffsCappedAtSixReturnsNil() {
        XCTAssertNil(planTranslateRetry(httpStatus: 429, groupRetries: 0, runBackoffs: 6))
        XCTAssertEqual(translateMaxGroupRetries, 1)
        XCTAssertEqual(translateMaxRunBackoffs, 6)
    }

    /// 非 429（结构化状态码判定，如 500）→ 不重试。
    func testNon429StatusReturnsNil() {
        XCTAssertNil(planTranslateRetry(httpStatus: 500, groupRetries: 0, runBackoffs: 0))
    }

    /// 状态码未知（nil：超时/未配置等非 HTTP 失败）→ 不重试。
    func testNullStatusReturnsNil() {
        XCTAssertNil(planTranslateRetry(httpStatus: nil, groupRetries: 0, runBackoffs: 0))
    }
}
