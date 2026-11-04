import Foundation
import ReaderCore

/// 资讯订阅（升级计划 B3）：订阅列表 + 条目缓存（UserDefaults，模式 B）。
/// 对齐 Windows src/reader/feedStore.ts：
///
/// 极小 {url,title} 数组、作用域只在阅读室——刻意不接任何云同步链路（那是
/// A0 云同步实体会推服务端，违背 B3「不经服务端」）。两个键名逐字沿用 Windows
/// localStorage 键（Mac 无 localStorage 的既定替代：IntakeService.examGoalKey 先例），
/// 值与 localStorage 同为 JSON 文本。坏 JSON/坏形状回默认（[] / [:]），逐行类型守卫
/// 丢脏行（防手改存储注入脏 URL——URL 进 fetchFeed 前还有 scheme 门禁双保险），
/// save 一律失败静默（不崩主流程）。

/// 一条订阅。
struct FeedSubscription: Equatable, FeedUrlCarrying {
    /// UUID().uuidString（Windows crypto.randomUUID 的 Foundation 等价物）。
    var id: String
    /// 归一化（trim+去尾部"/"）后的 feed XML 地址。
    var url: String
    /// 添加时自动取 feed channel title，用户可改。
    var title: String
    var addedAt: Int64
}

/// 单个订阅的条目缓存（避免每次挂载重拉；TTL 节流判断在 FeedTab）。
struct FeedCacheEntry: Equatable {
    var entries: [FeedEntryItem]
    var fetchedAt: Int64
}

final class FeedStore {
    static let feedsKey = "immersive-translator-reader-feeds"
    static let feedEntriesKey = "immersive-translator-reader-feed-entries"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - 逐行类型守卫

    private static func asStr(_ v: Any?) -> String {
        (v as? String) ?? ""
    }

    /// `typeof v === "number" && Number.isFinite(v)`（排除 JSON 布尔装成的 CFBoolean）。
    private static func asFiniteNumber(_ v: Any?) -> NSNumber? {
        guard let number = v as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return nil }
        return number
    }

    private static func asNum(_ v: Any?) -> Int64 {
        asFiniteNumber(v)?.int64Value ?? 0
    }

    /// id/url 是管线硬依赖（缓存键 / fetch 入参），缺任一只丢该行。
    private static func asSubscription(_ row: Any) -> FeedSubscription? {
        guard let r = row as? [String: Any] else { return nil }
        let id = asStr(r["id"])
        let url = asStr(r["url"])
        if id.isEmpty || url.isEmpty { return nil }
        return FeedSubscription(id: id, url: url, title: asStr(r["title"]), addedAt: asNum(r["addedAt"]))
    }

    /// title/link 是展示与点开链路的硬依赖，缺任一只丢该条。
    private static func asEntryItem(_ row: Any) -> FeedEntryItem? {
        guard let r = row as? [String: Any] else { return nil }
        let title = asStr(r["title"])
        let link = asStr(r["link"])
        if title.isEmpty || link.isEmpty { return nil }
        return FeedEntryItem(
            feedId: asStr(r["feedId"]),
            feedTitle: asStr(r["feedTitle"]),
            title: title,
            link: link,
            summary: asStr(r["summary"]),
            publishedAt: asFiniteNumber(r["publishedAt"])?.int64Value
        )
    }

    private func jsonObject(forKey key: String) -> Any? {
        guard let raw = defaults.string(forKey: key), !raw.isEmpty,
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private func write(_ object: Any, forKey key: String) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        defaults.set(text, forKey: key)
    }

    // MARK: - 订阅列表

    /// 读取订阅列表；坏 JSON/非数组/逐行脏数据 → 丢脏行，整体坏回 []。
    func loadFeeds() -> [FeedSubscription] {
        guard let parsed = jsonObject(forKey: Self.feedsKey) as? [Any] else { return [] }
        return parsed.compactMap(Self.asSubscription)
    }

    /// 整体写回订阅列表（写失败静默——下次读取回 [] 由用户重添，不崩主流程）。
    func saveFeeds(_ feeds: [FeedSubscription]) {
        let rows: [[String: Any]] = feeds.map {
            ["id": $0.id, "url": $0.url, "title": $0.title, "addedAt": $0.addedAt]
        }
        write(rows, forKey: Self.feedsKey)
    }

    // MARK: - 条目缓存

    /// 读取全部条目缓存（[feedId: FeedCacheEntry]）；坏 JSON/坏形状回 [:]
    /// （= 全部源视为无缓存，挂载时自动重拉）；单源形状坏丢该源。
    func loadFeedCache() -> [String: FeedCacheEntry] {
        guard let src = jsonObject(forKey: Self.feedEntriesKey) as? [String: Any] else { return [:] }
        var out: [String: FeedCacheEntry] = [:]
        for (feedId, value) in src {
            guard !feedId.isEmpty, let v = value as? [String: Any] else { continue }
            guard let fetchedAt = Self.asFiniteNumber(v["fetchedAt"]) else { continue }
            guard let rows = v["entries"] as? [Any] else { continue }
            out[feedId] = FeedCacheEntry(entries: rows.compactMap(Self.asEntryItem), fetchedAt: fetchedAt.int64Value)
        }
        return out
    }

    /// 整体写回条目缓存。
    func saveFeedCache(_ cache: [String: FeedCacheEntry]) {
        var object: [String: Any] = [:]
        for (feedId, entry) in cache {
            object[feedId] = [
                "fetchedAt": entry.fetchedAt,
                "entries": entry.entries.map { item -> [String: Any] in
                    [
                        "feedId": item.feedId,
                        "feedTitle": item.feedTitle,
                        "title": item.title,
                        "link": item.link,
                        "summary": item.summary,
                        "publishedAt": item.publishedAt.map { $0 as Any } ?? NSNull(),
                    ]
                },
            ]
        }
        write(object, forKey: Self.feedEntriesKey)
    }
}
