import XCTest
@testable import ImmersiveTranslator

/// 导入弹窗纯逻辑：① EpubTab 注入一次性消费（consumeEpubInjection，解析函数调用计数；
/// 规格 §2.4 第 7 条，对齐 ImportDialog.tsx:905-910 effect + injectedRef）；② 订阅 host
/// 兜底命名（feedHostLabel，对齐 FeedTab.tsx:91-97 `new URL(url).host`）。
final class ReaderIntakeSheetLogicTests: XCTestCase {
    // MARK: - consumeEpubInjection（注入只消费一次）

    private func makePayload(sourceBookId: String? = "alice") -> EpubTabInjected {
        EpubTabInjected(data: Data("epub-bytes".utf8), fileName: "the-book.epub", sourceBookId: sourceBookId)
    }

    func testNilInjectionDoesNothing() {
        var consumed = false
        var consumedCount = 0
        var parseCount = 0
        let did = consumeEpubInjection(
            nil, consumed: &consumed,
            onConsumed: { consumedCount += 1 },
            parse: { _ in parseCount += 1 }
        )
        XCTAssertFalse(did, "无注入不消费")
        XCTAssertEqual(parseCount, 0, "无注入不解析")
        XCTAssertEqual(consumedCount, 0, "无注入不清 pending")
        XCTAssertFalse(consumed)
    }

    func testInjectsExactlyOnceWithConsumedBeforeParse() {
        var consumed = false
        var events: [String] = []
        let payload = makePayload()
        // 挂载 + onChange 同帧双触发（StrictMode 双挂载的对应物）：只解析一次。
        let first = consumeEpubInjection(
            payload, consumed: &consumed,
            onConsumed: { events.append("consume") },
            parse: { p in events.append("parse:\(p.fileName)") }
        )
        let second = consumeEpubInjection(
            payload, consumed: &consumed,
            onConsumed: { events.append("consume") },
            parse: { _ in events.append("parse") }
        )
        // 同实例内注入值再变化也不重复解析（injectedRef 一次性语义）。
        let third = consumeEpubInjection(
            makePayload(), consumed: &consumed,
            onConsumed: { events.append("consume") },
            parse: { _ in events.append("parse") }
        )
        XCTAssertTrue(first)
        XCTAssertFalse(second)
        XCTAssertFalse(third)
        XCTAssertEqual(events, ["consume", "parse:the-book.epub"], "先回调清 pending 再解析")
        XCTAssertTrue(consumed)
    }

    func testPayloadCarriesDataAndSourceBookId() {
        var consumed = false
        var seen: (data: Data, fileName: String, sourceBookId: String?)?
        consumeEpubInjection(
            makePayload(sourceBookId: "alice-1"), consumed: &consumed,
            onConsumed: {},
            parse: { p in seen = (p.data, p.fileName, p.sourceBookId) }
        )
        XCTAssertEqual(seen?.fileName, "the-book.epub")
        XCTAssertEqual(seen?.sourceBookId, "alice-1")
        XCTAssertEqual(seen.map { String(decoding: $0.data, as: UTF8.self) }, "epub-bytes")
        // 本地重选路径：注入不带 sourceBookId（返回重选文件后走本地导入，不埋 discover_import）。
        var consumed2 = false
        var localSourceBookId: String? = "sentinel"
        consumeEpubInjection(
            makePayload(sourceBookId: nil), consumed: &consumed2,
            onConsumed: {},
            parse: { p in localSourceBookId = p.sourceBookId }
        )
        XCTAssertNil(localSourceBookId)
    }

    // MARK: - feedHostLabel（WHATWG URL.host：含非默认端口）

    func testFeedHostLabelIncludesNonDefaultPortAndOmitsDefault() {
        XCTAssertEqual(feedHostLabel("http://host:8080/feed"), "host:8080")
        XCTAssertEqual(feedHostLabel("https://h.example:8443/rss.xml"), "h.example:8443")
        // 默认端口（http 80 / https 443）省略——WHATWG URL.host 语义（URL 标准 §4.2）。
        XCTAssertEqual(feedHostLabel("http://host:80/feed"), "host")
        XCTAssertEqual(feedHostLabel("https://host:443/feed"), "host")
        XCTAssertEqual(feedHostLabel("https://www.nasa.gov/news-release/feed/"), "www.nasa.gov")
        // 解析失败 → 原样返回 url（hostLabelOf 的 catch 分支）。
        XCTAssertEqual(feedHostLabel("not a url"), "not a url")
        // IPv6 字面量带方括号（WHATWG 序列化形态）。
        XCTAssertEqual(feedHostLabel("http://[::1]:8080/feed"), "[::1]:8080")
    }
}
