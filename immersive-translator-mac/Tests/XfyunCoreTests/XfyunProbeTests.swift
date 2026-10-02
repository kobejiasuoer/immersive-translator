import XCTest
@testable import XfyunCore

/// 讯飞服务状态灯探测分类单测。网络路径（真实 GET / 超时）不做单测，需手动验证：
/// 设置 → 语音（讯飞）→ 一键测试三个服务 / 单卡「测试」。
final class XfyunProbeTests: XCTestCase {
    func testClassify401IsRejectedAuth() {
        let outcome = XfyunServiceProbe.classify(statusCode: 401)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .rejected)
        XCTAssertTrue(outcome.message.contains("鉴权"))
        XCTAssertTrue(outcome.message.contains("401"))
    }

    func testClassify403IsRejectedWhitelist() {
        let outcome = XfyunServiceProbe.classify(statusCode: 403)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.kind, .rejected)
        XCTAssertTrue(outcome.message.contains("白名单"))
    }

    func testClassifyOtherHTTPStatusIsReachable() {
        for code in [200, 400, 404, 426, 500] {
            let outcome = XfyunServiceProbe.classify(statusCode: code)
            XCTAssertTrue(outcome.ok, "HTTP \(code) 应视为可达")
            XCTAssertEqual(outcome.kind, .reachable)
            XCTAssertTrue(outcome.message.contains("HTTP \(code)"))
        }
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
