import XCTest
import XfyunCore
@testable import ImmersiveTranslator

/// 朗读失败归因分类（ttsError.test 的 Mac 对应物）：凭据 / 网络 / 系统 / 兜底。
final class TtsErrorTests: XCTestCase {
    /// 缺凭据：XfyunTtsEngine 的「讯飞合成凭据未配置（设置 → 语音）」业务错误
    /// 要归到凭据类并给「打开设置」入口（此前该错误被静默吞掉）。
    func testCredentialsMissingConfig() {
        let info = classifyTtsError(XfyunSessionError.business(code: -1, message: "讯飞合成凭据未配置（设置 → 语音）"))
        XCTAssertEqual(info.kind, .credentials)
        XCTAssertTrue(info.allowSettings)
        XCTAssertEqual(info.message, "缺少语音凭据：到 设置 → 语音 填一次即可（跟读/朗读/识别共用）")
    }

    /// 鉴权 401（XfyunSessionError.closed）→ 凭据类；文案在 errorDescription。
    func testCredentialsAuth401() {
        let info = classifyTtsError(XfyunSessionError.closed(code: 401, reason: ""))
        XCTAssertEqual(info.kind, .credentials)
        XCTAssertTrue(info.allowSettings)
    }

    /// 403 被拒：errorDescription（IP 白名单）里没有 401/403/鉴权字样，
    /// 依赖 String(describing:) 保留的关联值码值匹配。
    func testCredentialsAuth403ViaRawDescription() {
        let info = classifyTtsError(XfyunSessionError.closed(code: 403, reason: ""))
        XCTAssertEqual(info.kind, .credentials)
        XCTAssertTrue(info.allowSettings)
    }

    /// APPID 授权失败业务码 → 凭据类。
    func testCredentialsBusinessCode10005() {
        let info = classifyTtsError(XfyunSessionError.business(code: 10005, message: "APPID 授权失败（检查讯飞凭据）"))
        XCTAssertEqual(info.kind, .credentials)
        XCTAssertTrue(info.allowSettings)
    }

    /// 超时（文案「20s 无结果」不带超时字样，靠 case 名 timeout 匹配）→ 网络类。
    func testNetworkTimeout() {
        let info = classifyTtsError(XfyunSessionError.timeout("20s 无结果"))
        XCTAssertEqual(info.kind, .network)
        XCTAssertFalse(info.allowSettings)
    }

    /// 连接断开 → 网络类。
    func testNetworkClosed() {
        let info = classifyTtsError(XfyunSessionError.closed(code: -1, reason: "会话结束"))
        XCTAssertEqual(info.kind, .network)
        XCTAssertFalse(info.allowSettings)
    }

    /// URLSession 超时 → 网络类。
    func testNetworkURLError() {
        let info = classifyTtsError(URLError(.timedOut))
        XCTAssertEqual(info.kind, .network)
        XCTAssertFalse(info.allowSettings)
    }

    /// 云播放中断（无错误对象，直接给系统类）。
    func testSystemCloudPlaybackInterrupted() {
        let info = TtsErrorInfo.cloudPlaybackInterrupted()
        XCTAssertEqual(info.kind, .system)
        XCTAssertFalse(info.allowSettings)
    }

    /// 兜底：不认识的错误保留前 80 字，不给「打开设置」入口。
    func testUnknownFallbackTruncatesTo80Chars() {
        let long = String(repeating: "x", count: 200)
        let info = classifyTtsError(FileError(long))
        XCTAssertEqual(info.kind, .unknown)
        XCTAssertFalse(info.allowSettings)
        XCTAssertEqual(info.message, "朗读失败：\(String(repeating: "x", count: 80))")
    }

    private struct FileError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
