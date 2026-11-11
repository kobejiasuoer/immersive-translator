import XCTest
@testable import XfyunCore

/// 讯飞服务状态灯探测分类单测。网络路径（真实 GET / 超时）不做单测，需手动验证：
/// 设置 → 语音（讯飞）→ 检查全部连接 / 单卡「检查连接」。
/// 分类表对齐 Windows voice_probe_status（300247a）：错误 HTTP 状态不再判成功。
final class XfyunProbeTests: XCTestCase {
    /// 401/403/404/429/5xx 一律失败（Windows voice_probe_rejects_failed_http_responses 同款）。
    func testClassifyFailedHTTPStatusesDoNotPass() {
        for code in [401, 403, 404, 429, 500, 502, 503, 504] {
            let outcome = XfyunServiceProbe.classify(statusCode: code)
            XCTAssertFalse(outcome.ok, "HTTP \(code) 不能通过连接检查")
        }
    }

    /// 仅 2xx/400/426 通过，且文案明示「仍需实际……验证」（不谎报业务可用；
    /// Windows voice_probe_never_claims_business_success 同款断言）。
    func testClassifyPassStatusesNeverClaimBusinessSuccess() {
        for code in [200, 204, 400, 426] {
            let outcome = XfyunServiceProbe.classify(statusCode: code)
            XCTAssertTrue(outcome.ok, "HTTP \(code) 应视为连接通过")
            XCTAssertEqual(outcome.kind, .reachable)
            XCTAssertTrue(outcome.message.contains("仍需实际"))
        }
    }

    func testClassify401MessageNamesCredentials() {
        let outcome = XfyunServiceProbe.classify(statusCode: 401)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .rejected)
        XCTAssertTrue(outcome.message.contains("API Key"))
        XCTAssertTrue(outcome.message.contains("API Secret"))
    }

    func testClassify403MessageNamesWhitelist() {
        let outcome = XfyunServiceProbe.classify(statusCode: 403)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .rejected)
        XCTAssertTrue(outcome.message.contains("白名单"))
    }

    func testClassifyServerErrorMessages() {
        XCTAssertEqual(
            XfyunServiceProbe.classify(statusCode: 404).message,
            "服务地址不存在，请稍后重试"
        )
        XCTAssertEqual(
            XfyunServiceProbe.classify(statusCode: 429).message,
            "请求过于频繁，请稍后重试"
        )
        XCTAssertEqual(
            XfyunServiceProbe.classify(statusCode: 503).message,
            "语音服务器暂时不可用，请稍后重试"
        )
        XCTAssertEqual(
            XfyunServiceProbe.classify(statusCode: 418).message,
            "连接检查未通过，请稍后重试"
        )
    }

    func testProbeWithoutCredentialsDoesNoNetwork() async {
        let outcome = await XfyunServiceProbe.probe(host: XfyunIse.host, path: XfyunIse.path, creds: nil)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .missingCredentials)
        XCTAssertTrue(outcome.message.contains("凭据"))
    }

    func testProbeWithIncompleteCredentialsDoesNoNetwork() async {
        let incomplete = XfyunCredentials(appId: "appid", apiKey: "", apiSecret: "")
        let outcome = await XfyunServiceProbe.probe(host: XfyunIse.host, path: XfyunIse.path, creds: incomplete)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .missingCredentials)
    }
}
