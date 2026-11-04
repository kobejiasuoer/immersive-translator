import Foundation
import XCTest
@testable import ReaderCore

/// 订阅源抓取门禁（对齐 Windows src-tauri/src/feed.rs:98-179 七个测试的行为向量）：
/// URL 校验 trim/scheme 白名单三文案逐字；2MB 大小门禁边界含两侧；状态码文案
/// 401/403 专属、其余非 2xx 含码、2xx 放行。

final class FeedGatesTests: XCTestCase {
    // MARK: - feedURLError（URL 校验：trim / scheme 白名单）

    func testURLGateAcceptsValidHttpAndHttps() {
        // 首尾空白被 trim 后照常可用；回传解析后的 URL 供 scheme/host 断言。
        let url = try! feedURLError("  https://www.nasa.gov/news-release/feed/  ").get()
        XCTAssertEqual(url.scheme?.lowercased(), "https")
        XCTAssertEqual(url.host, "www.nasa.gov")
        let http = try! feedURLError("http://example.com/feed.xml").get()
        XCTAssertEqual(http.scheme?.lowercased(), "http")
    }

    func testURLGateRejectsNonURLString() {
        guard case .failure(let err) = feedURLError("not-a-url") else {
            return XCTFail("应被拒绝")
        }
        XCTAssertEqual(err.message, "这不是有效的订阅地址")
    }

    func testURLGateRejectsNonHTTPSchemes() {
        for bad in ["file:///etc/passwd", "javascript://alert(1)", "ftp://example.com/feed"] {
            guard case .failure(let err) = feedURLError(bad) else {
                return XCTFail("\(bad) 应被 scheme 白名单拒绝")
            }
            XCTAssertEqual(err.message, "只支持 http/https 订阅源", "\(bad) 应被 scheme 白名单拒绝")
        }
        // trim 先于 scheme 判定：带首尾空白的 file:// 仍按 scheme 拒绝。
        guard case .failure(let err) = feedURLError("  file:///etc/passwd  ") else {
            return XCTFail("带空白的 file:// 仍应拒绝")
        }
        XCTAssertEqual(err.message, "只支持 http/https 订阅源")
    }

    // MARK: - feedContentLengthGate（2MB 上限，边界含两侧）

    func testLengthGatePassesUnknownAndUnderLimit() {
        // 无头（nil，chunked）放行，读后由调用方复查。
        XCTAssertNil(feedContentLengthGate(nil))
        XCTAssertNil(feedContentLengthGate(1_999_999))
    }

    func testLengthGateRejectsOverLimitOnBothSides() {
        // 恰在 2MB 上限仍放行（> 才拒），超 1 拒。
        XCTAssertNil(feedContentLengthGate(2_000_000))
        XCTAssertEqual(feedContentLengthGate(2_000_001), "订阅内容超过 2MB，已取消")
        XCTAssertEqual(maxFeedBytes, 2_000_000)
    }

    // MARK: - feedStatusErrorText（状态码转中文文案）

    func testStatusTextGivesDedicatedCopyFor401And403() {
        let e401 = feedStatusErrorText(401)
        XCTAssertNotNil(e401)
        XCTAssertTrue(e401?.contains("需要登录或拒绝了访问") ?? false, e401 ?? "")
        XCTAssertTrue(e401?.contains("401") ?? false, e401 ?? "")
        let e403 = feedStatusErrorText(403)
        XCTAssertNotNil(e403)
        XCTAssertTrue(e403?.contains("需要登录或拒绝了访问") ?? false, e403 ?? "")
        XCTAssertTrue(e403?.contains("403") ?? false, e403 ?? "")
    }

    func testStatusTextIncludesCodeForOtherNon2xxAndPasses2xx() {
        let e404 = feedStatusErrorText(404)
        XCTAssertTrue(e404?.contains("404") ?? false, e404 ?? "")
        let e500 = feedStatusErrorText(500)
        XCTAssertTrue(e500?.contains("500") ?? false, e500 ?? "")
        // 2xx 放行。
        XCTAssertNil(feedStatusErrorText(200))
        XCTAssertNil(feedStatusErrorText(204))
    }

    func testStatusDisplayMatchesReqwestStatusCodeFormatting() {
        // reqwest StatusCode 的 Display = 「数字 + 标准原因短语」，Windows 用户所见含短语。
        XCTAssertEqual(httpStatusDisplay(401), "401 Unauthorized")
        XCTAssertEqual(httpStatusDisplay(403), "403 Forbidden")
        XCTAssertEqual(httpStatusDisplay(404), "404 Not Found")
        XCTAssertEqual(httpStatusDisplay(500), "500 Internal Server Error")
        XCTAssertEqual(httpStatusDisplay(599), "599 <unknown status code>")
        XCTAssertEqual(feedStatusErrorText(401), "这个订阅源需要登录或拒绝了访问（401 Unauthorized）")
        XCTAssertEqual(feedStatusErrorText(404), "订阅源返回了 404 Not Found")
    }

    // MARK: - decodeFeedBody（对齐 feed.rs:80-83 `resp.text()`：BOM 嗅探 → 响应头 charset → UTF-8 lossy）

    func testDecodeHonorsContentTypeCharset() {
        // ISO-8859-1 的 0xE9 = é；Windows reqwest 按响应头 charset 解码，Mac 之前只按 UTF-8 会得 U+FFFD。
        XCTAssertEqual(decodeFeedBody(Data([0x63, 0x61, 0x66, 0xE9]), charset: "iso-8859-1"), "café")
        // IANA 名大小写不敏感。
        XCTAssertEqual(decodeFeedBody(Data([0xE9]), charset: "ISO-8859-1"), "é")
        // GBK / GB2312 的「中文」。
        let gbk = Data([0xD6, 0xD0, 0xCE, 0xC4])
        XCTAssertEqual(decodeFeedBody(gbk, charset: "gbk"), "中文")
        XCTAssertEqual(decodeFeedBody(gbk, charset: "GB2312"), "中文")
        // windows-1252 的弯引号。
        XCTAssertEqual(decodeFeedBody(Data([0x93, 0x41, 0x94]), charset: "windows-1252"), "\u{201C}A\u{201D}")
        // 显式 utf-8。
        XCTAssertEqual(decodeFeedBody(Data("中文".utf8), charset: "utf-8"), "中文")
    }

    func testDecodeDefaultsToUtf8AndIsLossy() {
        // 无 charset → UTF-8。
        XCTAssertEqual(decodeFeedBody(Data("中文 <rss/>".utf8), charset: nil), "中文 <rss/>")
        XCTAssertEqual(decodeFeedBody(Data("ok".utf8), charset: ""), "ok")
        XCTAssertEqual(decodeFeedBody(Data("ok".utf8), charset: "   "), "ok")
        // 坏字节以 U+FFFD 替换（encoding_rs lossy 口径），不抛不丢整份。
        XCTAssertEqual(decodeFeedBody(Data([0x63, 0xE9]), charset: nil), "c\u{FFFD}")
        // IANA 名不识别 → 回落 UTF-8。
        XCTAssertEqual(decodeFeedBody(Data("ok".utf8), charset: "x-bogus-charset"), "ok")
        // 只看响应头、不嗅探 XML 声明：声明 gbk 但头无 charset 的 GBK 字节按 UTF-8 lossy（与 reqwest 一致）。
        let declaredOnly = Data("<?xml version=\"1.0\" encoding=\"gbk\"?>".utf8) + Data([0xD6, 0xD0])
        XCTAssertTrue(decodeFeedBody(declaredOnly, charset: nil).contains("\u{FFFD}"))
    }

    func testDecodeBomSniffingOverridesCharsetAndStripsBom() {
        // UTF-8 BOM：剥掉 BOM，首字符即 `<`。
        let utf8Bom = Data([0xEF, 0xBB, 0xBF]) + Data("<rss/>".utf8)
        XCTAssertEqual(decodeFeedBody(utf8Bom, charset: nil), "<rss/>")
        XCTAssertEqual(decodeFeedBody(utf8Bom, charset: "utf-8"), "<rss/>")
        // BOM 优先于响应头 charset（encoding_rs `decode` 规则）：UTF-8 BOM + 声明 iso-8859-1 仍按 UTF-8。
        XCTAssertEqual(decodeFeedBody(Data([0xEF, 0xBB, 0xBF]) + Data("中文".utf8), charset: "iso-8859-1"), "中文")
        // UTF-16LE / UTF-16BE BOM。
        let le = Data([0xFF, 0xFE]) + Data([0x3C, 0x00, 0x72, 0x00])  // "<r"
        XCTAssertEqual(decodeFeedBody(le, charset: nil), "<r")
        let be = Data([0xFE, 0xFF]) + Data([0x00, 0x3C, 0x00, 0x72])
        XCTAssertEqual(decodeFeedBody(be, charset: "iso-8859-1"), "<r", "UTF-16BE BOM 覆盖响应头 charset")
        // 空与极短输入不越界。
        XCTAssertEqual(decodeFeedBody(Data(), charset: nil), "")
        XCTAssertEqual(decodeFeedBody(Data([0xEF]), charset: nil), "\u{FFFD}")
        XCTAssertEqual(decodeFeedBody(Data([0x3C]), charset: nil), "<")
    }
}
