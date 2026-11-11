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

    /// 401 → API Key 指引（Mac 阅读通道无登录态，登录修不了 401；Windows 登录话术的分叉点）。
    func test401MapsToAPIKeyGuidanceText() {
        XCTAssertEqual(
            ErrorMessageFormatter.readerParagraphErrorText(status: 401),
            "翻译接口返回 401：请到 设置 → 模型服务 检查 API Key 与接口地址，或切换服务商再试"
        )
    }

    /// 500/nil → 通用兜底桶（覆盖超时、断网、未配置等非结构化失败）。
    func testFallbackBucketCovers500AndNull() {
        let fallback = "翻译服务暂时不可用，请稍后点重试"
        XCTAssertEqual(ErrorMessageFormatter.readerParagraphErrorText(status: 500), fallback)
        XCTAssertEqual(ErrorMessageFormatter.readerParagraphErrorText(status: nil), fallback)
    }
}
