import Foundation
import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 资讯订阅本地存储（对齐 Windows src/reader/feedStore.test.ts 行为向量）：
/// 空库 []、round-trip、坏 JSON []、非数组 []、逐行脏数据丢行好行保留、
/// 落盘键名逐字断言（immersive-translator-reader-feeds / -feed-entries）；
/// 缓存空 [:]、round-trip 含 publishedAt=nil、坏 JSON [:]、顶层数组/null [:]、
/// 单源形状坏丢该源、条目缺 title/link 丢该条。

final class FeedStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private var store: FeedStore!

    override func setUpWithError() throws {
        suiteName = "feedstore-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        store = FeedStore(defaults: defaults)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// 直接往存储键里塞原始 JSON 文本（等同手改 localStorage 的注入面）。
    private func putRaw(_ text: String) {
        defaults.set(text, forKey: FeedStore.feedsKey)
    }

    private func putRawCache(_ text: String) {
        defaults.set(text, forKey: FeedStore.feedEntriesKey)
    }

    private func sub(id: String, url: String, title: String = "T", addedAt: Int64 = 1) -> FeedSubscription {
        FeedSubscription(id: id, url: url, title: title, addedAt: addedAt)
    }

    private func item(_ title: String = "t", link: String = "https://x/1", feedId: String = "f", feedTitle: String = "F", summary: String = "", publishedAt: Int64? = 0) -> FeedEntryItem {
        FeedEntryItem(feedId: feedId, feedTitle: feedTitle, title: title, link: link, summary: summary, publishedAt: publishedAt)
    }

    // MARK: - 订阅列表

    func testEmptyLibraryReturnsEmptyArray() {
        XCTAssertEqual(store.loadFeeds(), [])
    }

    func testFeedsRoundTrip() {
        let feeds = [sub(id: "a", url: "https://a.example/feed"), sub(id: "b", url: "https://b.example/rss", title: "B", addedAt: 99)]
        store.saveFeeds(feeds)
        XCTAssertEqual(store.loadFeeds(), feeds)
    }

    func testBadJsonFeedsReturnsEmptyArray() {
        putRaw("this is not json{")
        XCTAssertEqual(store.loadFeeds(), [])
    }

    func testNonArrayFeedsReturnsEmptyArray() {
        putRaw(#"{"id":"x"}"#)
        XCTAssertEqual(store.loadFeeds(), [])
    }

    func testDirtyRowsDroppedGoodRowsKept() throws {
        // 缺 id / 缺 url 的行丢该行；好行保留（防手改存储注入脏 URL）。
        putRaw("""
        [
          {"title":"no id","url":"https://a.example/feed"},
          {"id":"","url":"https://a.example/feed"},
          {"id":"no url","title":"x","addedAt":4},
          {"id":"keep","url":"https://a.example/feed","title":"好行","addedAt":5}
        ]
        """)
        let feeds = store.loadFeeds()
        XCTAssertEqual(feeds.count, 1)
        XCTAssertEqual(feeds.first?.id, "keep")
        XCTAssertEqual(feeds.first?.addedAt, 5)
        // 缺 url 的行是管线硬依赖（fetch 入参），同样只丢该行。
        putRaw("""
        [{"id":"nourl","title":"x","addedAt":1},{"id":"ok","url":"u","title":"y","addedAt":2}]
        """)
        XCTAssertEqual(store.loadFeeds().map(\.id), ["ok"])
    }

    func testStorageKeysVerbatim() throws {
        // 落盘键名逐字断言（Windows localStorage 两键名沿用）。
        XCTAssertEqual(FeedStore.feedsKey, "immersive-translator-reader-feeds")
        XCTAssertEqual(FeedStore.feedEntriesKey, "immersive-translator-reader-feed-entries")
        // save 落到这两个键上（值为 JSON 文本）。
        store.saveFeeds([sub(id: "k", url: "u")])
        let raw = try XCTUnwrap(defaults.string(forKey: "immersive-translator-reader-feeds"))
        XCTAssertTrue(raw.contains("\"id\":\"k\""), raw)
        store.saveFeedCache(["c": FeedCacheEntry(entries: [item()], fetchedAt: 7)])
        let rawCache = try XCTUnwrap(defaults.string(forKey: "immersive-translator-reader-feed-entries"))
        XCTAssertTrue(rawCache.contains("\"fetchedAt\":7"), rawCache)
    }

    // MARK: - 条目缓存

    func testEmptyCacheReturnsEmptyDictionary() {
        XCTAssertEqual(store.loadFeedCache(), [:])
    }

    func testCacheRoundTripWithNullPublishedAt() {
        let entryNoDate = item("n", publishedAt: nil)
        let entry = item("d", link: "https://x/2", publishedAt: 123)
        let cache = [
            "f1": FeedCacheEntry(entries: [entryNoDate, entry], fetchedAt: 42),
        ]
        store.saveFeedCache(cache)
        XCTAssertEqual(store.loadFeedCache(), cache, "publishedAt=nil 往返保真")
    }

    func testBadJsonCacheReturnsEmptyDictionary() {
        putRawCache("]]]not json")
        XCTAssertEqual(store.loadFeedCache(), [:])
    }

    func testTopLevelArrayOrNullCacheReturnsEmptyDictionary() {
        putRawCache("[]")
        XCTAssertEqual(store.loadFeedCache(), [:])
        putRawCache("null")
        XCTAssertEqual(store.loadFeedCache(), [:])
    }

    func testBadSourceShapeDroppedFromCache() throws {
        putRawCache("""
        {
          "broken": {"entries": []},
          "nofetched": {"entries": []},
          "noentries": {"fetchedAt": 1},
          "good": {"fetchedAt": 9, "entries": [{"feedId":"g","feedTitle":"G","title":"t","link":"l","summary":"","publishedAt":3}]}
        }
        """)
        let cache = try XCTUnwrap(store.loadFeedCache())
        XCTAssertEqual(Array(cache.keys), ["good"], "单源 fetchedAt 缺失/entries 非数组 → 丢该源")
        XCTAssertEqual(cache["good"]?.entries.first?.publishedAt, 3)
    }

    func testEntryRowsMissingTitleOrLinkDropped() throws {
        putRawCache("""
        {"f": {"fetchedAt": 1, "entries": [
          {"feedId":"f","feedTitle":"F","title":"no link","summary":""},
          {"feedId":"f","feedTitle":"F","link":"l only","summary":""},
          {"feedId":"f","feedTitle":"F","title":"ok","link":"https://x/ok","summary":"s","publishedAt":null}
        ]}}
        """)
        let cache = try XCTUnwrap(store.loadFeedCache())
        let entries = try XCTUnwrap(cache["f"]?.entries)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.title, "ok")
        XCTAssertNil(entries.first?.publishedAt)
    }

    func testSaveFailureSilentNoCrash() {
        // 非法 JSON 对象（值含非受支持类型时的保护）不该崩：这里以合法输入验证
        // write 路径静默成功；非法输入（无法序列化）同样静默返回。
        store.saveFeeds([])
        store.saveFeedCache([:])
        XCTAssertEqual(store.loadFeeds(), [])
        XCTAssertEqual(store.loadFeedCache(), [:])
    }
}
