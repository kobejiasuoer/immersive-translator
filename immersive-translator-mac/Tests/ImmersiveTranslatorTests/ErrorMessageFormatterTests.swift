import XCTest
@testable import ImmersiveTranslator

/// readerParagraphErrorText 三桶文案——对齐 Windows errorMessageFormatter.test.ts:434-447
/// （按 HTTP 状态码定稿，绝不透传上游 message 文本）。
final class ErrorMessageFormatterTests: XCTestCase {
    /// 429 → 限流定稿文案。
    func test429MapsToRateLimitText() {
        XCTAssertEqual(
            ErrorMessageFormatter.readerParagraphErrorText(status: 429),
            "翻译请求太频繁，已重试仍被限流，稍后点重试"
        )
    }

    /// 401 → 登录失效文案（上游真 401 落同一桶）。
    func test401MapsToAuthExpiredText() {
        XCTAssertEqual(
            ErrorMessageFormatter.readerParagraphErrorText(status: 401),
            "登录状态已失效，请到 设置 → 账号 重新登录"
        )
    }

    /// 500/nil → 通用兜底桶（覆盖超时、断网、未配置等非结构化失败）。
    func testFallbackBucketCovers500AndNull() {
        let fallback = "翻译服务暂时不可用，请稍后点重试"
        XCTAssertEqual(ErrorMessageFormatter.readerParagraphErrorText(status: 500), fallback)
        XCTAssertEqual(ErrorMessageFormatter.readerParagraphErrorText(status: nil), fallback)
    }
}
