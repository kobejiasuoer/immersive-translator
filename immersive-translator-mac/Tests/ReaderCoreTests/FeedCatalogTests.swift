import Foundation
import XCTest
@testable import ReaderCore

/// 资讯订阅解析与合并（对齐 Windows src/lib/feedCatalog.test.ts 行为向量）：
/// RSS 2.0 字段解析与丢行；Atom href/published、无日期 nil；坏 XML→nil、HTML 页→nil、
/// 空串→nil、实体 feed 宽松降级成功、结构性坏 XML（未闭合/错配/散落 `<`/缺根闭合）宽松
/// 降级仍抽出条目、合法 0 条目→[]（nil 与 [] 语义分离）；feedTitleOf 三态 + 沿同一降级链取
/// 频道名；merge 降序/溯源/截 100/空输入；normalize/findFeedByUrl；推荐源四条 URL 逐字 +
/// host 全 .gov 后缀 + https 唯一；三文案常量逐字；invoke 文案三分支。

final class FeedCatalogTests: XCTestCase {
    // MARK: - RSS 2.0

    func testRssParsesFieldsAndDropsIncompleteItems() {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Channel A</title>
        <item><title>T1</title><link>https://a.example/1</link><description>d1</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
        <item><link>https://a.example/2</link></item>
        <item><title>T3</title><description>d3</description></item>
        </channel></rss>
        """
        guard let entries = parseFeedXml(xml) else { return XCTFail("应解析成功") }
        // 缺 title / 缺 link 各丢一条，不整份失败。
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].feedId, "")
        XCTAssertEqual(entries[0].feedTitle, "")
        XCTAssertEqual(entries[0].title, "T1")
        XCTAssertEqual(entries[0].link, "https://a.example/1")
        XCTAssertEqual(entries[0].summary, "d1")
        // Mon, 01 Jan 2024 00:00:00 GMT
        XCTAssertEqual(entries[0].publishedAt, 1_704_067_200_000)
    }

    func testRssTrimsTagTextAndEmptyTagTextSkipped() {
        // firstTagText 每个标签只看首个元素（空则尝试下一个标签，不回退第二个同名标签，
        // feedCatalog.ts:142-149）；title/link 首尾空白被 trim。
        let xml = """
        <rss version="2.0"><channel><title>C</title>
        <item><title>  Trimmed  </title><link> https://a.example/9 </link><description></description></item>
        </channel></rss>
        """
        guard let entries = parseFeedXml(xml) else { return XCTFail("应解析成功") }
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].title, "Trimmed")
        XCTAssertEqual(entries[0].link, "https://a.example/9")
        XCTAssertEqual(entries[0].summary, "")
        XCTAssertEqual(entries[0].publishedAt, nil)
    }

    // MARK: - Atom

    func testAtomHrefAlternatePreferredAndPublishedUpdated() {
        let xml = """
        <feed xmlns="http://www.w3.org/2005/Atom"><title>AT</title>
        <entry><title>E1</title><link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/e1"/><published>2024-01-02T03:04:05Z</published><summary>s1</summary></entry>
        <entry><title>E2</title><link href="https://x.example/e2"/><updated>2024-02-03T00:00:00Z</updated></entry>
        <entry><title>E3</title><link href="https://x.example/e3"/></entry>
        </feed>
        """
        guard let entries = parseFeedXml(xml) else { return XCTFail("应解析成功") }
        XCTAssertEqual(entries.count, 3)
        // 多链接时 alternate 优先（self 在前也不夺位）。
        XCTAssertEqual(entries[0].link, "https://x.example/e1")
        XCTAssertEqual(entries[0].publishedAt, 1_704_164_645_000)  // 2024-01-02T03:04:05Z
        XCTAssertEqual(entries[1].link, "https://x.example/e2")
        XCTAssertEqual(entries[1].publishedAt, 1_706_918_400_000)  // updated
        XCTAssertEqual(entries[2].publishedAt, nil)
    }

    // MARK: - 形状门禁与降级（nil vs [] 语义分离）

    func testBadXmlReturnsNil() {
        XCTAssertNil(parseFeedXml("<<<not xml"))
    }

    func testHtmlPageReturnsNil() {
        // 合法 XML 但无 channel/feed/rss 标记（重定向到普通网页的门禁）。
        let xml = "<html><body><p>hello</p></body></html>"
        XCTAssertNil(parseFeedXml(xml))
    }

    func testBlankInputReturnsNil() {
        XCTAssertNil(parseFeedXml(""))
        XCTAssertNil(parseFeedXml("   \n  "))
    }

    func testEntityFeedFallsBackToLooseParse() {
        // CDATA 外的 HTML 实体：严格解析失败 → 宽松降级一次成功（feedCatalog.test.ts 同向量）。
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Tab&nbsp;C</title>
        <item><title>A&nbsp;1</title><link>https://a.example/1</link><description>d&nbsp;1 &amp; more</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
        </channel></rss>
        """
        guard let entries = parseFeedXml(xml) else { return XCTFail("宽松降级应解析成功") }
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].title, "A\u{00A0}1")
        XCTAssertEqual(entries[0].link, "https://a.example/1")
        XCTAssertEqual(entries[0].summary, "d\u{00A0}1 & more")
        XCTAssertEqual(entries[0].publishedAt, 1_704_067_200_000)
        // feedTitleOf 与 parseFeedXml 共用降级链：实体 feed 取到完整频道名（Windows 生产 WebView2
        // 对 parsererror 保留已解析节点，频道名在错误点之前时同样取到；jsdom 才整份丢弃为空串）。
        XCTAssertEqual(feedTitleOf(xml: xml), "Tab\u{00A0}C")
    }

    func testStructurallyBrokenXmlFallsBackToLooseParse() {
        // Windows DOMParser text/html 对结构性坏 XML 仍能抽 rss/channel/item；Mac 走 tidy XML 修复等价恢复。
        // ① 未闭合的 <description>（直接遇到 </item>）。
        let unclosed = """
        <rss version="2.0"><channel><title>Chan</title>
        <item><title>T1</title><link>https://a.example/1</link><description>d1</item>
        </channel></rss>
        """
        guard let e1 = parseFeedXml(unclosed) else { return XCTFail("未闭合标签应宽松恢复") }
        XCTAssertEqual(e1.count, 1)
        XCTAssertEqual(e1[0].title, "T1")
        XCTAssertEqual(e1[0].link, "https://a.example/1")
        XCTAssertEqual(e1[0].summary, "d1")
        // ② 错配的闭合标签 </desc>。
        let mismatched = "<rss version=\"2.0\"><channel><title>Chan</title><item><title>T1</title><link>https://a.example/1</link><description>d1</desc></item></channel></rss>"
        guard let e2 = parseFeedXml(mismatched) else { return XCTFail("错配闭合标签应宽松恢复") }
        XCTAssertEqual(e2.map(\.title), ["T1"])
        XCTAssertEqual(e2[0].summary, "d1")
        // ③ 缺根闭合（传输被截断的常见形态）。
        let truncated = "<rss version=\"2.0\"><channel><title>Chan</title><item><title>T1</title><link>https://a.example/1</link></item>"
        guard let e3 = parseFeedXml(truncated) else { return XCTFail("缺根闭合应宽松恢复") }
        XCTAssertEqual(e3.map(\.link), ["https://a.example/1"])
        // ④ 散落的 `<`（HTML 解析器把「< 空格」当文本，tidy 转义为 &lt;）。
        let stray = "<rss version=\"2.0\"><channel><title>T1 < T2</title><item><title>x < y</title><link>https://a.example/1</link></item></channel></rss>"
        guard let e4 = parseFeedXml(stray) else { return XCTFail("散落 < 应宽松恢复") }
        XCTAssertEqual(e4[0].title, "x < y")
        // 宽松链取频道名：结构性坏 feed 以自报频道名命名而非 host 兜底。
        XCTAssertEqual(feedTitleOf(xml: unclosed), "Chan")
        XCTAssertEqual(feedTitleOf(xml: stray), "T1 < T2")
    }

    func testLooseParseStillRejectsNonFeedShapes() {
        // 宽松降级不放宽形状门禁：纯文本 / 普通 HTML 页（含未闭合标签）/ 结构性坏但无 channel|feed|rss 的 XML 仍 nil。
        XCTAssertNil(parseFeedXml("这不是订阅源，只是一段普通文本"))
        XCTAssertNil(parseFeedXml("<html><body><p>hello<br>there</body></html>"))
        XCTAssertNil(parseFeedXml("<root><item><title>T</title><link>https://a/1</link></item>"))
    }

    func testValidFeedWithZeroEntriesReturnsEmptyArray() {
        let xml = "<rss version=\"2.0\"><channel><title>Empty</title></channel></rss>"
        let entries = parseFeedXml(xml)
        XCTAssertNotNil(entries, "合法 feed 0 条目返回 []（≠ nil）")
        XCTAssertEqual(entries, [])
    }

    func testCdataSummaryKeptVerbatim() {
        // CDATA 段内容原样保留（宽松重解析不触碰 CDATA）。
        let xml = "<rss version=\"2.0\"><channel><title>C</title><item><title>T</title><link>https://a.example/1</link>"
            + "<description><![CDATA[raw <b>html</b> & stuff]]></description></item></channel></rss>"
        guard let entries = parseFeedXml(xml) else { return XCTFail("应解析成功") }
        XCTAssertEqual(entries[0].summary, "raw <b>html</b> & stuff")
    }

    // MARK: - feedTitleOf 三态

    func testFeedTitleOfThreeStates() {
        XCTAssertEqual(feedTitleOf(xml: "<rss><channel><title>  Ch T  </title></channel></rss>"), "Ch T")
        XCTAssertEqual(
            feedTitleOf(xml: "<feed xmlns=\"http://www.w3.org/2005/Atom\"><title>Feed T</title></feed>"),
            "Feed T"
        )
        // 都取不到 / 坏到不成 feed 形状 → 空串（调用方以 host 兜底）。
        XCTAssertEqual(feedTitleOf(xml: "<rss><channel></channel></rss>"), "")
        XCTAssertEqual(feedTitleOf(xml: "<<<not xml"), "")
        XCTAssertEqual(feedTitleOf(xml: "这不是订阅源"), "")
    }

    // MARK: - mergeFeedEntries

    private func entry(_ title: String, publishedAt: Int64?, feedId: String = "stale", feedTitle: String = "stale") -> FeedEntryItem {
        FeedEntryItem(feedId: feedId, feedTitle: feedTitle, title: title, link: "https://x/\(title)", summary: "", publishedAt: publishedAt)
    }

    func testMergeSortsDescendingAndStampsSource() {
        let a = FeedEntriesBundle(feedId: "f1", feedTitle: "A", fetchedAt: 1_000, entries: [
            entry("old", publishedAt: 100),
            entry("new", publishedAt: 2_000),
        ])
        let b = FeedEntriesBundle(feedId: "f2", feedTitle: "B", fetchedAt: 5_000, entries: [
            entry("b", publishedAt: nil),
        ])
        let merged = mergeFeedEntries([a, b])
        // 无日期条目按该源 fetchedAt（5000）排序兜底 → 最大，排最前。
        XCTAssertEqual(merged.map(\.title), ["b", "new", "old"])
        // 溯源字段被本源 bundle 值覆盖（幂等，缓存与现拉条目同构）。
        XCTAssertEqual(merged[0].feedId, "f2")
        XCTAssertEqual(merged[0].feedTitle, "B")
        XCTAssertEqual(merged[1].feedId, "f1")
        XCTAssertEqual(merged[1].feedTitle, "A")
        XCTAssertEqual(merged[0].publishedAt, nil, "publishedAt 保持 nil（展示省略相对时间）")
    }

    func testMergeCapsAtLimitKeepingNewest() {
        let entries = (1...150).map { entry("e\($0)", publishedAt: Int64($0)) }
        let merged = mergeFeedEntries([FeedEntriesBundle(feedId: "f", feedTitle: "F", fetchedAt: 0, entries: entries)])
        XCTAssertEqual(merged.count, feedMergeLimit)
        XCTAssertEqual(feedMergeLimit, 100)
        // 截前 100 条留最新（150…51）。
        XCTAssertEqual(merged.first?.title, "e150")
        XCTAssertEqual(merged.last?.title, "e51")
    }

    func testMergeStableForEqualTimesAndEmptyInput() {
        let entries = [
            entry("first", publishedAt: 10),
            entry("second", publishedAt: 10),
            entry("third", publishedAt: 10),
        ]
        let merged = mergeFeedEntries([FeedEntriesBundle(feedId: "f", feedTitle: "F", fetchedAt: 0, entries: entries)])
        XCTAssertEqual(merged.map(\.title), ["first", "second", "third"], "同时间戳保持输入顺序（JS 稳定排序语义）")
        XCTAssertEqual(mergeFeedEntries([]), [])
    }

    // MARK: - 归一化与查重

    func testNormalizeFeedUrl() {
        XCTAssertEqual(normalizeFeedUrl("  https://a.example/feed/  "), "https://a.example/feed")
        XCTAssertEqual(normalizeFeedUrl("https://a.example/feed///"), "https://a.example/feed")
        XCTAssertEqual(normalizeFeedUrl("   "), "")
        XCTAssertEqual(normalizeFeedUrl(""), "")
    }

    func testFindFeedByUrlMatchesAfterTrailingSlashNormalization() {
        struct Row: FeedUrlCarrying { let url: String }
        let feeds = [Row(url: "https://a.example/feed")]
        XCTAssertNotNil(findFeedByUrl(feeds, url: "  https://a.example/feed/  "))
        XCTAssertNil(findFeedByUrl(feeds, url: "https://other.example/feed"))
        XCTAssertNil(findFeedByUrl(feeds, url: "   "))
    }

    // MARK: - 日期解析（Date.parse 等价）

    func testParseFeedDateFormats() {
        XCTAssertEqual(parseFeedDate("Mon, 01 Jan 2024 00:00:00 GMT"), 1_704_067_200_000)
        XCTAssertEqual(parseFeedDate("2024-01-02T03:04:05Z"), 1_704_164_645_000)
        XCTAssertEqual(parseFeedDate("2024-02-03T00:00:00Z"), 1_706_918_400_000)
        XCTAssertEqual(parseFeedDate("2024-02-03T00:00:00.500Z"), 1_706_918_400_500)
        XCTAssertEqual(parseFeedDate("2024-01-02T03:04:05+08:00"), 1_704_135_845_000)  // = 01-01T19:04:05Z
        // 带空白的输入先 trim；垃圾输入 nil。
        XCTAssertEqual(parseFeedDate("  Mon, 01 Jan 2024 00:00:00 GMT  "), 1_704_067_200_000)
        XCTAssertNil(parseFeedDate("not a date"))
        XCTAssertNil(parseFeedDate(""))
    }

    // MARK: - 推荐源常量

    func testRecommendedFeedsFourEntriesLockedVerbatim() {
        XCTAssertEqual(recommendedFeeds.count, 4)
        let expected: [(String, String, String)] = [
            ("NASA News Releases", "https://www.nasa.gov/news-release/feed/",
             "NASA 官方新闻稿，航天任务报道，日更数条，英语难度适中"),
            ("CDC Online Newsroom", "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
             "美国疾控中心新闻稿，公共健康主题，句子规范适合泛读"),
            ("NIST News", "https://www.nist.gov/news-events/news/rss.xml",
             "美国国家标准与技术研究院，科技/计量新闻，周更 2-4 条，适合精读"),
            ("Energy Department News", "https://www.energy.gov/rss",
             "美国能源部新闻，能源科技与科研进展，周更数条"),
        ]
        for (index, item) in recommendedFeeds.enumerated() {
            XCTAssertEqual(item.title, expected[index].0)
            XCTAssertEqual(item.url, expected[index].1)
            XCTAssertEqual(item.note, expected[index].2)
        }
    }

    func testRecommendedFeedsAllGovHttpsAndUnique() {
        XCTAssertTrue(recommendedFeeds.count >= 2, "至少两条（宁缺勿滥）")
        var urls = Set<String>()
        for feed in recommendedFeeds {
            XCTAssertTrue(feed.url.hasPrefix("https://"), "推荐源一律 https：\(feed.url)")
            // feedCatalog.test.ts:278 同向量：`new URL(url).hostname.endsWith(".gov")`（host 后缀，
            // 不是子串——`https://evil.com/.gov` 不得误过）。
            XCTAssertEqual(URL(string: feed.url)?.host?.hasSuffix(".gov"), true, "推荐源 host 全为 .gov：\(feed.url)")
            XCTAssertTrue(urls.insert(feed.url).inserted, "推荐源 URL 唯一：\(feed.url)")
        }
    }

    // MARK: - 文案常量与 invoke 文案

    func testCopyConstantsVerbatim() {
        XCTAssertEqual(feedParseErrorText, "无法解析这份订阅源，请确认地址指向 RSS/Atom 订阅（不是普通网页）")
        XCTAssertEqual(feedEmptyText, "订阅源暂时没有文章")
        XCTAssertEqual(feedDuplicateText, "这个订阅已在列表中")
    }

    func testFeedInvokeErrorTextThreeBranches() {
        // LocalizedError（FileImportError 同款）→ errorDescription 直显。
        XCTAssertEqual(feedInvokeErrorText(FileImportError("订阅源返回了 404 Not Found")), "订阅源返回了 404 Not Found")
        // 非 LocalizedError 的 Error → localizedDescription（err.message 对应物），非空。
        XCTAssertFalse(feedInvokeErrorText(NSError(domain: "t", code: 1)).isEmpty)
        // 非 Error 值 → String(describing:)（String(err) 分支）。
        XCTAssertEqual(feedInvokeErrorText("plain text"), "plain text")
    }
}
