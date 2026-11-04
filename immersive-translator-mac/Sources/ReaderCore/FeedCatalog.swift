import Foundation

/// 资讯订阅（升级计划 B3 §3/§6）：feed XML 解析 + 条目合并 + 重复检测
/// + 推荐源常量 + 中文错误文案。对齐 Windows src/lib/feedCatalog.ts 全文件。
///
/// - parseFeedXml：原始 feed XML（IntakeService.fetchFeed 取回）→ [FeedEntryItem]。
///   Foundation XMLDocument 严格解析；坏 XML 时降级「宽松重解析」一次（对应 Windows
///   DOMParser text/html 降级所容忍的两类真实世界坏 feed）：① CDATA 外的 HTML 命名实体
///   `&nbsp;` 等与裸 `&` 先消毒再严格重解析；② 仍失败（未闭合/错配标签、散落 `<`、缺根
///   闭合等结构性坏 XML）走 Foundation tidy XML 修复（`.documentTidyXML`：HTML 容错解析器
///   对结构性破损的等价恢复，保留 rss/channel/item 等标签；**不用** `.documentTidyHTML`——
///   它按 HTML 词表剥掉这些未知标签，与浏览器 HTMLUnknownElement 保留语义相反），
///   仍不是 feed 形状返回 nil；合法但 0 条目返回 []（两者语义不同：nil=不是订阅，
///   []=订阅暂无文章）。
/// - 省键容错照 discoverCatalog.parseBooksPage：缺 title 或 link 只丢该条不整份失败；
///   summary 一律取等价 textContent 纯文本（绝不取内层标记，XSS 防线）。
/// - 文案常量集中在此（对标 discoverBodyErrorText 落位 DiscoverCatalog），FeedTab 直接
///   引用；feedInvokeErrorText 对抓取层的中文 message 直显，绝不引入网关错误映射。

// MARK: - 类型

/// 文章列表的一条（合并后带订阅溯源：feedId/feedTitle 由 mergeFeedEntries
/// 或缓存写入方补齐，parseFeedXml 产物中为空串）。
public struct FeedEntryItem: Equatable {
    /// 所属订阅 id（删除订阅时过滤、埋点溯源）。
    public var feedId: String
    /// 所属订阅标题（列表小字前缀「源 · 标题」）。
    public var feedTitle: String
    /// 文章标题（可点开预览）。
    public var title: String
    /// 文章原文链接（fetchArticle 的入参）。
    public var link: String
    /// 摘要纯文本（展示截 120 字）。
    public var summary: String
    /// 发布时间戳（毫秒）；缺省/pubDate 不可解析为 nil（相对时间展示省略）。
    public var publishedAt: Int64?

    public init(feedId: String, feedTitle: String, title: String, link: String, summary: String, publishedAt: Int64?) {
        self.feedId = feedId
        self.feedTitle = feedTitle
        self.title = title
        self.link = link
        self.summary = summary
        self.publishedAt = publishedAt
    }
}

/// 推荐订阅源（静态常量不落存储，对标内置场景；均为实测可达的
/// 美国政府公有领域源，license 见各条注释）。
public struct RecommendedFeed: Equatable {
    public let title: String
    public let url: String
    /// 一句中文描述（推荐区展示）。
    public let note: String

    public init(title: String, url: String, note: String) {
        self.title = title
        self.url = url
        self.note = note
    }
}

/// mergeFeedEntries 的单源输入：一个订阅本轮渲染的条目 + 抓取时间。
public struct FeedEntriesBundle: Equatable {
    public let feedId: String
    public let feedTitle: String
    /// 该源条目的抓取时间（毫秒；publishedAt 缺省时的排序兜底）。
    public let fetchedAt: Int64
    public let entries: [FeedEntryItem]

    public init(feedId: String, feedTitle: String, fetchedAt: Int64, entries: [FeedEntryItem]) {
        self.feedId = feedId
        self.feedTitle = feedTitle
        self.fetchedAt = fetchedAt
        self.entries = entries
    }
}

/// 合并后保留的最大条数（蓝图定稿：截前 100 条）。
public let feedMergeLimit = 100

/// 无法按 feed 形状解析时的文案（覆盖「填错成普通网页」场景）。
public let feedParseErrorText = "无法解析这份订阅源，请确认地址指向 RSS/Atom 订阅（不是普通网页）"

/// 有订阅但条目全空。
public let feedEmptyText = "订阅源暂时没有文章"

/// 手添/勾选已订阅的源。
public let feedDuplicateText = "这个订阅已在列表中"

/// 抓取/解析失败文案：抓取层错误已是面向用户的中文 message，直接展示
/// （`err instanceof Error ? err.message : String(err)` 的 Swift 等价：LocalizedError
/// 的 errorDescription → Error 的 localizedDescription → 其余 String(describing:)），
/// 绝不引入 authErrorText 类网关错误映射（那是 AuthError 形状）。
public func feedInvokeErrorText(_ error: Any) -> String {
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
        return description
    }
    if let err = error as? Error {
        return err.localizedDescription
    }
    return String(describing: error)
}

// MARK: - 推荐订阅

/// 推荐订阅（均为实测可达的美国政府公有领域源，license 见各条注释；
/// 实测口径与剔除记录如下，实测不通过的源绝不收录、宁缺勿滥）。
///
/// 实测口径：应用真实请求 = feed.rs 只设 Chrome UA 与 20s 超时、不设 Accept 头、
/// reqwest 默认跟随重定向；故 curl 探测统一 -A "Chrome/126" 不加 Accept 头并带 -L，
/// WebFetch 交叉核对（WAF 挡 WebFetch 时以 curl 应用口径为准）。
///
/// 两轮实测记录：
/// - 2026-10-24/25 设计阶段（curl + Chrome UA、WebFetch）：NASA/CDC/NIST/LoC/DOE
///   两环境两日 200+RSS 逐字节一致；NOAA 带浏览器 Accept 头 200+RSS（101,851B）、
///   裸 UA 得 202+text/html+0B——边缘按 Accept 头区别对待且跨环境不稳定。
/// - 2026-10-25 施工复测：DOE 301→/rss/energygov/2193718 后 200+application/rss+xml
///   8,223B（WebFetch 核对 RSS 2.0「Energy News」）→ 收编。LoC 403 Cloudflare
///   「Just a moment」（curl 三连 + 改 Accept 头 + HTTP/1.1 共 5 次 + WebFetch 均
///   403，与设计阶段两环境结论相反——WAF 按 egress IP 区别对待）→ 按实测剔除。
///   NOAA 307→/rss.xml→200+RSS 两次后第三次 202+text/html+0B（6 分钟内
///   200/200/202，现场复现跨请求不稳定）→ 按「裸 UA 连续 3 次全 200+RSS 才收、
///   任一 202/403/HTML 即弃」剔除。JPL curl SSL 自签证书链（error 60）→ 剔除。
///
/// 剔除清单（实测不通过）：EPA newsreleases/search/rss 405 Human Verification（Akamai）；
/// USGS /rss 405 同款；FDA stay-informed/rss-feeds 302 bot 墙；CISA all.xml、
/// USDA /feed、congress.gov /rss、HHS /rss 403；blogs.nasa.gov/feed 与
/// new.nsf.gov/rss 200 但返回 HTML 非 feed；NPS /rss、DOI /rss、
/// federalregister.gov/documents/feed 404；justice.gov/news/rss 连接超时；
/// NIH 备选源 403（2026-10-24 既有记录）；LoC/NOAA/JPL 见 2026-10-25 施工复测。
public let recommendedFeeds: [RecommendedFeed] = [
    RecommendedFeed(
        title: "NASA News Releases",
        url: "https://www.nasa.gov/news-release/feed/",
        note: "NASA 官方新闻稿，航天任务报道，日更数条，英语难度适中"
        // license：NASA 材料为美国政府作品（17 U.S.C. §105），公有领域。
    ),
    RecommendedFeed(
        title: "CDC Online Newsroom",
        url: "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
        note: "美国疾控中心新闻稿，公共健康主题，句子规范适合泛读"
        // license：CDC 原创内容为美国政府作品，公有领域（第三方署名供稿除外）。
    ),
    RecommendedFeed(
        title: "NIST News",
        url: "https://www.nist.gov/news-events/news/rss.xml",
        note: "美国国家标准与技术研究院，科技/计量新闻，周更 2-4 条，适合精读"
        // license：商务部下属机构，美国政府作品，公有领域。
    ),
    RecommendedFeed(
        title: "Energy Department News",
        url: "https://www.energy.gov/rss",
        note: "美国能源部新闻，能源科技与科研进展，周更数条"
        // license：能源部作品为美国政府作品（17 U.S.C. §105）公有领域，第三方署名供稿除外。
    ),
]

// MARK: - 归一化与查重

/// 带 url 字段的订阅形状（FeedSubscription / RecommendedFeed 均适用；结构化协议
/// 避免 ReaderCore 依赖应用层的订阅存储类型）。
public protocol FeedUrlCarrying {
    var url: String { get }
}

extension RecommendedFeed: FeedUrlCarrying {}

/// 订阅地址归一化（重复检测口径）：trim + 去尾部 "/"。
public func normalizeFeedUrl(_ url: String) -> String {
    let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "" }
    var out = Substring(trimmed)
    while out.hasSuffix("/") { out = out.dropLast() }
    return String(out)
}

/// 在订阅列表里按归一化 URL 查重。命中返回该条，否则 nil。
public func findFeedByUrl<T: FeedUrlCarrying>(_ feeds: [T], url: String) -> T? {
    let target = normalizeFeedUrl(url)
    if target.isEmpty { return nil }
    return feeds.first { normalizeFeedUrl($0.url) == target }
}

// MARK: - XML 解析

/// 元素本地名（小写；XMLDocument 默认处理命名空间，`<content:encoded>` 的本地名是
/// encoded、默认命名空间的 Atom `<entry>` 是 entry——与 DOM getElementsByTagName 对
/// 限定名的匹配结果一致）。
private func feedLocalName(_ node: XMLNode) -> String {
    if let element = node as? XMLElement, let local = element.localName, !local.isEmpty {
        return local.lowercased()
    }
    let name = node.name ?? ""
    return name.split(separator: ":", maxSplits: 1).last.map { $0.lowercased() } ?? ""
}

/// 文档序（深度优先）收集本地名匹配的后代元素（DOM getElementsByTagName 等价）。
private func feedDescendants(_ root: XMLNode, named wanted: String) -> [XMLElement] {
    var out: [XMLElement] = []
    func walk(_ node: XMLNode) {
        for child in node.children ?? [] {
            if let element = child as? XMLElement, feedLocalName(element) == wanted {
                out.append(element)
            }
            walk(child)
        }
    }
    walk(root)
    return out
}

/// DOM textContent 等价：拼接全部后代文本节点（含 CDATA），不含任何标记。
private func feedTextContent(_ node: XMLNode) -> String {
    if node.kind == .text { return node.stringValue ?? "" }
    var out = ""
    for child in node.children ?? [] {
        out += feedTextContent(child)
    }
    return out
}

private func feedAttribute(_ element: XMLElement, _ name: String) -> String? {
    element.attribute(forName: name)?.stringValue
}

private func feedTrim(_ s: String) -> String {
    s.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func firstTagText(_ el: XMLNode, _ tags: [String]) -> String {
    for tag in tags {
        guard let found = feedDescendants(el, named: tag).first else { continue }
        let text = feedTrim(feedTextContent(found))
        if !text.isEmpty { return text }
    }
    return ""
}

/// 条目链接：RSS 的 <link> 是文本节点；Atom 的 <link rel=alternate> 是
/// href 属性（多链接时 alternate 优先，其次任一带 href 的，最后文本节点）。
/// 宽松降级路径下若 <link> 退化为空元素（URL 文本散落为条目直接子文本节点），
/// 末段扫直接子文本里的 http(s) 链接兜底（对齐 Windows text/html 降级路径）。
private func entryLink(_ el: XMLElement) -> String {
    let links = feedDescendants(el, named: "link")
    let withHref = links.filter { !feedTrim(feedAttribute($0, "href") ?? "").isEmpty }
    let alternate = withHref.first { feedAttribute($0, "rel") == "alternate" } ?? withHref.first
    if let alternate {
        return feedTrim(feedAttribute(alternate, "href") ?? "")
    }
    if let byText = links.first(where: { !feedTrim(feedTextContent($0)).isEmpty }) {
        return feedTrim(feedTextContent(byText))
    }
    for node in el.children ?? [] where node.kind == .text {
        let text = feedTrim(node.stringValue ?? "")
        if text.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return text
        }
    }
    return ""
}

/// 条目发布时间：RSS pubDate / Atom published|updated，解析失效返回 nil。
private func entryPublishedAt(_ el: XMLElement) -> Int64? {
    let raw = firstTagText(el, ["pubDate", "pubdate", "published", "updated"])
    if raw.isEmpty { return nil }
    return parseFeedDate(raw)
}

/// 是否 feed 形状：RSS 2.0 有 <rss>/<channel>（RSS 1.0/RDF 只有 <channel>），
/// Atom 有 <feed>。普通网页两种标记都没有（「重定向到 HTML 页」的门禁）。
private func isFeedShaped(_ doc: XMLDocument) -> Bool {
    !feedDescendants(doc, named: "channel").isEmpty
        || !feedDescendants(doc, named: "feed").isEmpty
        || !feedDescendants(doc, named: "rss").isEmpty
}

/// 从文档抽条目（RSS <item> + Atom <entry> 并取）。缺 title 或 link 只丢
/// 该条；溯源字段（feedId/feedTitle）留空，由缓存写入方或 mergeFeedEntries 补。
private func entriesFromDoc(_ doc: XMLDocument) -> [FeedEntryItem]? {
    if !isFeedShaped(doc) { return nil }
    let items = feedDescendants(doc, named: "item") + feedDescendants(doc, named: "entry")
    var out: [FeedEntryItem] = []
    for el in items {
        let title = firstTagText(el, ["title"])
        let link = entryLink(el)
        if title.isEmpty || link.isEmpty { continue }
        out.append(FeedEntryItem(
            feedId: "",
            feedTitle: "",
            title: title,
            link: link,
            summary: firstTagText(el, ["description", "summary", "content"]),
            publishedAt: entryPublishedAt(el)
        ))
    }
    return out
}

/// 严格 XML 解析（不加载外部实体：不发网络取 DTD，也堵 XXE）。
private func strictFeedDocument(_ xml: String) -> XMLDocument? {
    try? XMLDocument(xmlString: xml, options: [.nodeLoadExternalEntitiesNever])
}

/// 常见 HTML 命名实体 → 字符（宽松重解析前的消毒表；XML 只预定义 amp/lt/gt/quot/apos）。
private let feedHtmlNamedEntities: [String: String] = [
    "nbsp": "\u{00A0}", "mdash": "—", "ndash": "–", "hellip": "…",
    "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”",
    "copy": "©", "reg": "®", "trade": "™", "deg": "°", "middot": "·",
    "laquo": "«", "raquo": "»", "bull": "•", "euro": "€", "pound": "£",
    "yen": "¥", "cent": "¢", "sect": "§", "para": "¶", "times": "×", "divide": "÷",
    "eacute": "é", "egrave": "è", "agrave": "à", "ccedil": "ç", "uuml": "ü",
    "ouml": "ö", "auml": "ä", "iacute": "í", "oacute": "ó", "uacute": "ú", "ntilde": "ñ",
]

private let feedEntityRegex = try! NSRegularExpression(
    pattern: #"&(?:(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});)?"#
)
private let feedCdataRegex = try! NSRegularExpression(
    pattern: #"<!\[CDATA\[.*?\]\]>"#, options: [.dotMatchesLineSeparators]
)

/// CDATA 外的实体消毒：XML 预定义实体与数字实体原样保留；已知 HTML 命名实体换成
/// 对应字符；未知命名实体退化为字面文本（`&amp;name;`，与浏览器 HTML 解析器对未知
/// 实体的处理一致）；裸 `&` 转 `&amp;`。
private func sanitizeFeedEntities(_ segment: String) -> String {
    let ns = segment as NSString
    var out = ""
    var cursor = 0
    for match in feedEntityRegex.matches(in: segment, range: NSRange(location: 0, length: ns.length)) {
        out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
        cursor = match.range.location + match.range.length
        let nameRange = match.range(at: 1)
        guard nameRange.location != NSNotFound else {
            out += "&amp;"
            continue
        }
        let name = ns.substring(with: nameRange)
        if name.hasPrefix("#") || ["amp", "lt", "gt", "quot", "apos"].contains(name) {
            out += "&\(name);"
        } else if let decoded = feedHtmlNamedEntities[name] {
            out += decoded
        } else {
            out += "&amp;\(name);"
        }
    }
    out += ns.substring(from: cursor)
    return out
}

/// 实体消毒（宽松降级第一级）：CDATA 段原样保留，其余片段过 sanitizeFeedEntities。
private func sanitizeFeedEntitiesOutsideCdata(_ xml: String) -> String {
    let ns = xml as NSString
    var rebuilt = ""
    var cursor = 0
    for match in feedCdataRegex.matches(in: xml, range: NSRange(location: 0, length: ns.length)) {
        rebuilt += sanitizeFeedEntities(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
        rebuilt += ns.substring(with: match.range)
        cursor = match.range.location + match.range.length
    }
    rebuilt += sanitizeFeedEntities(ns.substring(from: cursor))
    return rebuilt
}

/// 结构性修复（宽松降级第二级）：Foundation tidy XML（`.documentTidyXML`）自动闭合未闭合/
/// 错配标签、把散落的 `<` 转义为 `&lt;`、补齐缺失的根闭合——对应 Windows DOMParser
/// text/html 容错解析器对结构性坏 XML 的恢复能力；保留 rss/channel/item/entry 等标签与
/// 命名空间（2026-11-02 实测：未闭合/错配/散落 `<`/缺根闭合/Atom xmlns/content:encoded/中文
/// 均恢复，纯文本与普通 HTML 页仍不成 feed 形状）。无根元素视为失败。
/// 与浏览器 HTML5 树构建算法并非逐节点等价（tag-soup 修复策略不同），这是无 DOM 解析器的
/// 平台必然差异；两端一致的是「结构性坏 feed 仍能抽出条目，而非整份报无法解析」。
private func tidyFeedDocument(_ xml: String) -> XMLDocument? {
    guard let doc = try? XMLDocument(xmlString: xml, options: [.documentTidyXML, .nodeLoadExternalEntitiesNever]),
          doc.rootElement() != nil else {
        return nil
    }
    return doc
}

/// 宽松重解析（两级，对应 Windows DOMParser text/html 降级）：① 实体消毒后严格重解析
/// （容忍 CDATA 外的 HTML 实体）；② 仍失败则对消毒后的文本做 tidy XML 结构性修复。
private func looseFeedDocument(_ xml: String) -> XMLDocument? {
    let sanitized = sanitizeFeedEntitiesOutsideCdata(xml)
    if let doc = strictFeedDocument(sanitized) { return doc }
    return tidyFeedDocument(sanitized)
}

/// 「严格 → 宽松」同一条降级链（parseFeedXml 与 feedTitleOf 共用，保证条目与频道名出自
/// 同一份文档形状）。
private func feedDocument(_ xml: String) -> XMLDocument? {
    strictFeedDocument(xml) ?? looseFeedDocument(xml)
}

/// 解析 feed 原始 XML：严格解析 → 失败时宽松重解析一次（实体消毒 → 结构性修复）→ 仍非
/// feed 形状返回 nil。合法 feed 0 条目返回 []（≠ nil）。空白输入返回 nil。
public func parseFeedXml(_ xml: String) -> [FeedEntryItem]? {
    if feedTrim(xml).isEmpty { return nil }
    guard let doc = feedDocument(xml) else { return nil }
    return entriesFromDoc(doc)
}

/// feed 自报频道名：RSS channel/title 或 Atom feed/title；取不到返回空串（调用方以 host 兜底）。
///
/// 解析口径：与 parseFeedXml 共用同一条「严格 → 宽松」降级链。Windows FeedTab.tsx:215 以
/// text/xml 解析后取标题——生产运行时 WebView2(Chromium) 对 XML 解析错误**保留已解析节点**并
/// 插入 `<parsererror>`，故 channel/title 位于错误点之前（实体/破损多在条目正文里，是真实世界
/// 坏 feed 的常态）时仍取到频道名；只有 jsdom（Windows 单测环境）才整份丢弃返回空串。Mac 沿用
/// 降级链即对齐生产行为的常态。残差：错误恰好落在频道 title 内部时，Chromium 得到截断前缀、
/// Mac 得到完整标题——需 Windows 端联调确认（Mac 侧无法运行 WebView2）。
public func feedTitleOf(xml: String) -> String {
    guard let doc = feedDocument(xml) else { return "" }
    if let channel = feedDescendants(doc, named: "channel").first,
       let title = feedDescendants(channel, named: "title").first {
        let text = feedTrim(feedTextContent(title))
        if !text.isEmpty { return text }
    }
    if let feed = feedDescendants(doc, named: "feed").first,
       let title = feedDescendants(feed, named: "title").first {
        return feedTrim(feedTextContent(title))
    }
    return ""
}

/// 合并多源条目为一张列表：每条盖上所属订阅的 feedId/feedTitle 溯源，
/// 按 publishedAt 降序（缺省回退该源 fetchedAt），截前 feedMergeLimit 条。
/// 输入条目的溯源字段会被本源的 bundle 值覆盖（幂等，缓存与现拉条目同构）。
/// 同时间戳保持输入顺序（JS Array.sort 稳定排序语义，显式以序号打平）。
public func mergeFeedEntries(_ perFeed: [FeedEntriesBundle]) -> [FeedEntryItem] {
    var stamped: [(item: FeedEntryItem, time: Int64, order: Int)] = []
    for bundle in perFeed {
        for entry in bundle.entries {
            var item = entry
            item.feedId = bundle.feedId
            item.feedTitle = bundle.feedTitle
            stamped.append((item, entry.publishedAt ?? bundle.fetchedAt, stamped.count))
        }
    }
    stamped.sort { a, b in
        if a.time != b.time { return a.time > b.time }
        return a.order < b.order
    }
    return stamped.prefix(feedMergeLimit).map(\.item)
}

// MARK: - 日期解析（JS Date.parse 等价：ISO 8601 + RFC 2822）

private let feedIsoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let feedIsoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private let feedIsoDateOnly: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withFullDate]
    f.timeZone = TimeZone(secondsFromGMT: 0)
    return f
}()

/// RFC 2822 及其常见变体（带/不带星期、单/双位日、时区缩写或数字偏移）；
/// 另含无时区的 ISO 本地时间（JS 对无时区的日期时间串按本地时间解释）。
private let feedLegacyFormatters: [DateFormatter] = {
    let patterns = [
        "EEE, dd MMM yyyy HH:mm:ss zzz",
        "EEE, dd MMM yyyy HH:mm:ss Z",
        "EEE, d MMM yyyy HH:mm:ss zzz",
        "EEE, d MMM yyyy HH:mm:ss Z",
        "dd MMM yyyy HH:mm:ss zzz",
        "dd MMM yyyy HH:mm:ss Z",
        "d MMM yyyy HH:mm:ss zzz",
        "d MMM yyyy HH:mm:ss Z",
        "EEE, dd MMM yyyy HH:mm zzz",
        "EEE, dd MMM yyyy HH:mm Z",
        "yyyy-MM-dd'T'HH:mm:ss",
        "yyyy-MM-dd HH:mm:ss",
    ]
    return patterns.map { pattern in
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = pattern
        return f
    }
}()

/// feed 里的日期串 → 毫秒时间戳；任何格式都解析不了返回 nil（Date.parse 的 NaN）。
public func parseFeedDate(_ raw: String) -> Int64? {
    let text = feedTrim(raw)
    if text.isEmpty { return nil }
    let candidates: [Date?] = [
        feedIsoFractional.date(from: text),
        feedIsoPlain.date(from: text),
        feedIsoDateOnly.date(from: text),
    ]
    if let hit = candidates.compactMap({ $0 }).first {
        return Int64((hit.timeIntervalSince1970 * 1000).rounded())
    }
    for formatter in feedLegacyFormatters {
        if let date = formatter.date(from: text) {
            return Int64((date.timeIntervalSince1970 * 1000).rounded())
        }
    }
    return nil
}
