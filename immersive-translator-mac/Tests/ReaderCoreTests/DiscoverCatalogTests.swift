import Foundation
import XCTest
@testable import ReaderCore

/// 发现书库目录解析与文案（对齐 Windows src/lib/discoverCatalog.test.ts 行为向量）：
/// 15 键全字段解析；缺省键 nil；丢行不整页失败；坏信封 nil；SHA-256 真摘要 true /
/// 篡改一位 false / 非法 expected true 放行；epubFileNameOf；formatFileSize 边界
/// （524288→`0.5 MB`、300000→`293 KB`）；四个文案函数逐字（含 401 下载文案、
/// platform_unavailable 专属、429 秒数有无）。

final class DiscoverCatalogTests: XCTestCase {
    // MARK: - parseBooksPage

    private let fullBookJson = """
    {
      "id": "alice", "title": "Alice's Adventures in Wonderland", "author": "Lewis Carroll",
      "description": "A classic", "wordCount": 27000, "grade": "easy", "category": "fiction",
      "language": "en", "coverEmoji": "🐇", "source": "standard-ebooks", "sourceUrl": "https://standardebooks.org/1",
      "licenseName": "Public domain", "licenseUrl": "https://standardebooks.org/2",
      "fileSizeBytes": 812546, "sha256": "abc123"
    }
    """

    func testParseBooksPageAllFifteenKeys() throws {
        let page = try XCTUnwrap(parseBooksPage(
            #"{"data":[\#(fullBookJson)],"total":42,"page":1,"perPage":20}"#
        ))
        XCTAssertEqual(page.books.count, 1)
        let book = try XCTUnwrap(page.books.first)
        XCTAssertEqual(book.id, "alice")
        XCTAssertEqual(book.title, "Alice's Adventures in Wonderland")
        XCTAssertEqual(book.author, "Lewis Carroll")
        XCTAssertEqual(book.description, "A classic")
        XCTAssertEqual(book.wordCount, 27000)
        XCTAssertEqual(book.grade, "easy")
        XCTAssertEqual(book.category, "fiction")
        XCTAssertEqual(book.language, "en")
        XCTAssertEqual(book.coverEmoji, "🐇")
        XCTAssertEqual(book.source, "standard-ebooks")
        XCTAssertEqual(book.sourceUrl, "https://standardebooks.org/1")
        XCTAssertEqual(book.licenseName, "Public domain")
        XCTAssertEqual(book.licenseUrl, "https://standardebooks.org/2")
        XCTAssertEqual(book.fileSizeBytes, 812546)
        XCTAssertEqual(book.sha256, "abc123")
        XCTAssertEqual(page.total, 42)
        XCTAssertEqual(page.page, 1)
        XCTAssertEqual(page.perPage, 20)
    }

    func testParseBooksPageOptionalKeysAbsent() throws {
        let page = try XCTUnwrap(parseBooksPage(
            #"{"data":[{"id":"b1","title":"T","author":"","grade":"medium","category":"c","language":"en","coverEmoji":"","source":"s","sourceUrl":"u","licenseName":"l","licenseUrl":"lu","fileSizeBytes":0,"sha256":""}],"total":0,"page":1,"perPage":20}"#
        ))
        let book = try XCTUnwrap(page.books.first)
        XCTAssertNil(book.description, "description 空时整体省键 → nil")
        XCTAssertNil(book.wordCount, "wordCount 缺省 → nil")
    }

    func testParseBooksPageDropsBadRowsKeepsGoodOnes() throws {
        let page = try XCTUnwrap(parseBooksPage(
            #"{"data":[{"title":"no id"},{"id":"","title":""},{"id":"ok1","title":"Good","author":"a","grade":"hard","category":"c","language":"en","coverEmoji":"","source":"s","sourceUrl":"u","licenseName":"l","licenseUrl":"lu","fileSizeBytes":1,"sha256":""}],"total":1,"page":1,"perPage":20}"#
        ))
        XCTAssertEqual(page.books.count, 1, "缺 id/title 只丢该行不整页失败")
        XCTAssertEqual(page.books.first?.id, "ok1")
    }

    func testParseBooksPageBadEnvelopeReturnsNil() {
        XCTAssertNil(parseBooksPage("not json"))
        XCTAssertNil(parseBooksPage("[]"), "顶层数组不是信封")
        XCTAssertNil(parseBooksPage(#"{"total":1}"#), "缺 data")
        XCTAssertNil(parseBooksPage(#"{"data":{"id":"x"}}"#), "data 非数组")
        // total 非数字 → asNum 兜 0，不算坏信封（Windows asNum 容错口径）。
        let soft = parseBooksPage(#"{"data":[],"total":"many"}"#)
        XCTAssertEqual(soft?.total, 0)
    }

    // MARK: - verifyEpubSha256

    func testVerifyEpubSha256TrueForKnownDigest() {
        // SHA-256("") 的公开向量。
        let emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        XCTAssertTrue(verifyEpubSha256(Data(), expected: emptyDigest))
        // 大写 expected 同样命中（比较前统一小写）。
        XCTAssertTrue(verifyEpubSha256(Data(), expected: emptyDigest.uppercased()))
    }

    func testVerifyEpubSha256FalseForTamperedDigest() {
        let emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        var tampered = emptyDigest
        tampered = "0" + emptyDigest.dropFirst()
        XCTAssertFalse(verifyEpubSha256(Data(), expected: tampered), "篡改一位 → 摘要不匹配")
    }

    func testVerifyEpubSha256PassesOnIllegalExpected() {
        // expected 非法（非 64 位 hex / 缺省）→ 放行 true（旁路防线不构成硬门槛）。
        XCTAssertTrue(verifyEpubSha256(Data([1, 2, 3]), expected: "notahex"))
        XCTAssertTrue(verifyEpubSha256(Data([1, 2, 3]), expected: ""))
        XCTAssertTrue(verifyEpubSha256(Data([1, 2, 3]), expected: "a" * 63))
        XCTAssertTrue(verifyEpubSha256(Data([1, 2, 3]), expected: "a" * 65))
    }

    // MARK: - epubFileNameOf / formatFileSize

    func testEpubFileNameOf() {
        let book = DiscoverBook(
            id: "the-art-of-war-2", title: "T", author: "", grade: "easy", category: "",
            language: "", coverEmoji: "", source: "", sourceUrl: "", licenseName: "",
            licenseUrl: "", fileSizeBytes: 0, sha256: ""
        )
        XCTAssertEqual(epubFileNameOf(book), "the-art-of-war-2.epub")
    }

    func testFormatFileSizeBoundaries() {
        XCTAssertEqual(formatFileSize(524_288), "0.5 MB")
        XCTAssertEqual(formatFileSize(300_000), "293 KB")
        XCTAssertEqual(formatFileSize(786_432), "0.8 MB", "0.75 MB 的 toFixed(1) 同口径：平局向上")
        XCTAssertEqual(formatFileSize(1_048_576), "1.0 MB")
        XCTAssertEqual(formatFileSize(1_024), "1 KB")
        XCTAssertEqual(formatFileSize(0), "1 KB", "max(1, …) 兜底")
        XCTAssertEqual(formatFileSize(512), "1 KB")
    }

    // MARK: - 文案函数逐字

    func testDiscoverListErrorTextVerbatim() {
        XCTAssertEqual(discoverListErrorText(status: 400, retryAfterSeconds: nil), "请求参数异常，请更新应用后重试；若持续出现请反馈")
        XCTAssertEqual(discoverListErrorText(status: 404, retryAfterSeconds: nil), "书库暂时无法访问（404），请稍后再试")
        XCTAssertEqual(discoverListErrorText(status: 429, retryAfterSeconds: 37), "操作过于频繁，请 37 秒后再试")
        XCTAssertEqual(discoverListErrorText(status: 429, retryAfterSeconds: nil), "操作过于频繁，请稍后再试")
        XCTAssertEqual(discoverListErrorText(status: 429, retryAfterSeconds: 0), "操作过于频繁，请稍后再试", "秒数非正 → 通用文案")
        XCTAssertEqual(discoverListErrorText(status: 500, retryAfterSeconds: nil), "服务暂时不可用，请稍后再试")
        XCTAssertEqual(discoverListErrorText(status: 503, retryAfterSeconds: nil), "服务暂时不可用，请稍后再试")
    }

    func testDiscoverBodyErrorTextVerbatim() {
        XCTAssertEqual(discoverBodyErrorText, "书库数据异常，请稍后重试；若持续出现请更新应用")
    }

    func testDiscoverDownloadErrorTextVerbatim() {
        XCTAssertEqual(discoverDownloadErrorText(status: 404, retryAfterSeconds: nil), "这本书当前不可下载，请稍后再试或换一本")
        XCTAssertEqual(discoverDownloadErrorText(status: 400, retryAfterSeconds: nil), "请求参数异常，请更新应用后重试；若持续出现请反馈")
        XCTAssertEqual(discoverDownloadErrorText(status: 401, retryAfterSeconds: nil), "登录已失效，请重新登录")
        XCTAssertEqual(discoverDownloadErrorText(status: 429, retryAfterSeconds: 12), "操作过于频繁，请 12 秒后再试")
        XCTAssertEqual(discoverDownloadErrorText(status: 429, retryAfterSeconds: nil), "操作过于频繁，请稍后再试")
        XCTAssertEqual(discoverDownloadErrorText(status: 500, retryAfterSeconds: nil), "服务暂时不可用，请稍后再试")
    }

    func testDiscoverPlatformUnavailableTextVerbatim() {
        XCTAssertEqual(discoverPlatformUnavailableText, "书库服务暂未开放，请稍后再试")
    }

    func testGradeLabelsVerbatim() {
        XCTAssertEqual(gradeLabels["easy"], "入门")
        XCTAssertEqual(gradeLabels["medium"], "进阶")
        XCTAssertEqual(gradeLabels["hard"], "挑战")
    }

    // MARK: - 行内常量（下载断点语义）

    func testDownloadBreakpointCopyVerbatim() {
        XCTAssertEqual(discoverCorruptDataText, "下载的数据损坏，请重试")
        XCTAssertEqual(discoverChecksumMismatchText, "下载的文件校验失败，请重新下载")
    }
}

/// `"a" * 63`（重复字符串，XCTest 里没有 * 运算符，放扩展保持用例可读）。
private extension String {
    static func * (lhs: String, rhs: Int) -> String {
        String(repeating: lhs, count: rhs)
    }
}
