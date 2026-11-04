import XCTest
@testable import ImmersiveTranslator

/// discoverInvokeErrorText 的 code 分发（对齐 Windows src/lib/discoverCatalog.test.ts:196-207
/// 「platform_unavailable 专属文案，其余走 authErrorText 真实现兜底」四断言）：
/// platform_unavailable → 专属文案（不进 authErrorText 全局表）；network_error → 网络失败文案；
/// unknown → 兜底文案；非 AuthError 的 Error → 按 unknown 归一兜底。
/// Windows 第 4 断言是字符串 reject `discoverInvokeErrorText("network_error")`（Tauri invoke 可
/// reject 裸字符串）；Swift throw 恒为 Error，无裸字符串形态——非 AuthError 分支即其等价输入。
final class DiscoverInvokeErrorTextTests: XCTestCase {
    func testPlatformUnavailableGetsDedicatedCopy() {
        XCTAssertEqual(
            discoverInvokeErrorText(AuthError.local("platform_unavailable", "书库服务暂未开放")),
            "书库服务暂未开放，请稍后再试"
        )
    }

    func testNetworkErrorFallsThroughToAuthErrorText() {
        XCTAssertEqual(
            discoverInvokeErrorText(AuthError.local("network_error", "网络请求失败: boom")),
            "网络连接失败，请检查网络后重试"
        )
    }

    func testUnknownFallsThroughToAuthErrorText() {
        XCTAssertEqual(
            discoverInvokeErrorText(AuthError.local("unknown", "boom")),
            "服务响应异常，请稍后再试"
        )
    }

    func testNonAuthErrorNormalizesToUnknownFallback() {
        // 非 AuthError 的任意 Error → unknown 归一兜底：原始 message 不直显
        //（服务端/底层 message 永不进用户文案，与 authErrorText 同约束）。
        XCTAssertEqual(discoverInvokeErrorText(NSError(domain: "t", code: 1)), "服务响应异常，请稍后再试")
        XCTAssertEqual(discoverInvokeErrorText(NSError(domain: "t", code: -1009)), "服务响应异常，请稍后再试")
        // AuthError 但 code 为空 → 归一 unknown（authErrorText 同口径）。
        XCTAssertEqual(discoverInvokeErrorText(AuthError.local("", "whatever")), "服务响应异常，请稍后再试")
    }
}
