import Foundation

// MARK: - 书架页纯逻辑（ShelfPage.tsx:35,:104-153,:239-309 + ReaderApp.tsx:211-222,:376-379）

/// 导入弹窗直达 tab（Windows ShelfImportTab / ImportOpenTab 同集合：七值）。
public enum ReaderImportTab: String, Equatable, CaseIterable {
    case lib
    case epub
    case file
    case url
    case paste
    case discover
    case feed
}

/// openImport 的运行时白名单（ReaderApp.tsx:214-222 IMPORT_OPEN_TABS）：
/// 拦下 onClick 直传泄漏进来的事件对象等非 tab 值——非白名单一律回落 `lib`。
/// Mac 侧「事件对象等效输入」= 任意不在集合里的字符串 / nil。
public func resolveImportOpenTab(_ raw: String?) -> ReaderImportTab {
    guard let raw, let tab = ReaderImportTab(rawValue: raw) else { return .lib }
    return tab
}

/// 阅读时长格式：分钟 < 60 → 「N 分钟」，否则「X.Y 小时」（去尾 .0；≥10 小时取整）。
public func shelfFormatDuration(minutes: Int) -> String {
    if minutes < 60 { return "\(minutes) 分钟" }
    let h = Double(minutes) / 60
    if h >= 10 { return "\(Int(h.rounded())) 小时" }
    var text = String(format: "%.1f", h)
    if text.hasSuffix(".0") { text.removeLast(2) }
    return "\(text) 小时"
}

/// 词数 → 分钟（按 135 wpm 估，至少 1）。
public func shelfEstimateMinutes(wordCount: Int) -> Int {
    max(1, Int((Double(wordCount) / 135).rounded()))
}

/// 短文中文行的来源落款（ShelfPage.tsx:122-153）：书章给「来自《书名》第 N 章」
///（书已不在书架时回落日期落款），网页给域名（去 www.），本地/粘贴给类型 + 日期。
public func shelfSourceLabel(article a: Article, books: [BookMeta], calendar: Calendar = .current) -> String {
    if a.sourceType == .epub, let book = books.first(where: { $0.id == a.bookId }) {
        if let chapterIdx = a.chapterIdx {
            return "来自《\(book.title)》第 \(chapterIdx + 1) 章"
        }
        return "来自《\(book.title)》"
    }
    if let sourceUrl = a.sourceUrl, let url = URL(string: sourceUrl), var host = url.host, !host.isEmpty {
        if host.hasPrefix("www.") { host.removeFirst(4) }
        if !host.isEmpty { return "网页 · \(host)" }
    }
    let date = Date(timeIntervalSince1970: Double(a.createdAt) / 1000)
    let comps = calendar.dateComponents([.month, .day], from: date)
    let dateText = "\(comps.month ?? 1) 月 \(comps.day ?? 1) 日"
    switch a.sourceType {
    case .url: return "网页 · \(dateText)"
    case .paste: return "粘贴文本 · \(dateText)"
    case .pdf: return "本地 PDF · \(dateText)"
    case .docx: return "本地 Word · \(dateText)"
    case .epub: return "导入于 \(dateText)"
    }
}

/// 短文 tab 状态筛选：全部 / 未读完（percent<100）/ 已读完（≥100）。
public enum ShelfArticleFilter: String, Equatable, CaseIterable {
    case all
    case reading
    case done

    public var label: String {
        switch self {
        case .all: return "全部"
        case .reading: return "未读完"
        case .done: return "已读完"
        }
    }
}

/// 短文管线输出：搜索 → 筛选 → 排序（最近阅读）→ 同 sourceUrl 合并 → 状态分组。
public struct ShelfShorts: Equatable {
    public let reading: [ArticleSummary]
    public let done: [ArticleSummary]
    /// 分组内被合并隐藏的重复条数（合并提示归到代表条目所在分组）。
    public let mergedReadingCount: Int
    public let mergedDoneCount: Int
    /// 分组内被合并的 sourceUrl（「撤销」按分组一次展开）。
    public let mergedReadingUrls: [String]
    public let mergedDoneUrls: [String]
    public let searching: Bool

    public init(
        reading: [ArticleSummary], done: [ArticleSummary],
        mergedReadingCount: Int, mergedDoneCount: Int,
        mergedReadingUrls: [String], mergedDoneUrls: [String], searching: Bool
    ) {
        self.reading = reading
        self.done = done
        self.mergedReadingCount = mergedReadingCount
        self.mergedDoneCount = mergedDoneCount
        self.mergedReadingUrls = mergedReadingUrls
        self.mergedDoneUrls = mergedDoneUrls
        self.searching = searching
    }
}

/// 短文管线（ShelfPage.tsx:240-301）：搜索匹配 title 或 titleCn（不区分大小写）；
/// 排序唯一口径 lastReadAt desc；同 sourceUrl 视为重复——保留最近读的一条，其余收进
/// 合并提示（unmergedUrls 里的 URL 不合并）；按进度分组 继续阅读 / 已读完。
public func buildShelfShorts(
    articles: [ArticleSummary],
    query: String,
    filter: ShelfArticleFilter,
    unmergedUrls: Set<String>
) -> ShelfShorts {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var list = articles
    if !q.isEmpty {
        list = list.filter { s in
            s.article.title.lowercased().contains(q)
                || (s.article.titleCn ?? "").lowercased().contains(q)
        }
    }
    switch filter {
    case .reading: list = list.filter { $0.article.progress.percent < 100 }
    case .done: list = list.filter { $0.article.progress.percent >= 100 }
    case .all: break
    }
    let sorted = list.sorted { $0.article.lastReadAt > $1.article.lastReadAt }

    // 同 sourceUrl 视为重复：保留最近读的一条，其余收进合并提示（可撤销）。
    var byUrl: [String: [ArticleSummary]] = [:]
    var urlOrder: [String] = []
    for s in sorted {
        guard let url = s.article.sourceUrl, !url.isEmpty else { continue }
        if byUrl[url] == nil { urlOrder.append(url) }
        byUrl[url, default: []].append(s)
    }
    var hidden = Set<String>()
    var repByUrl: [(url: String, rep: ArticleSummary, hiddenCount: Int)] = []
    for url in urlOrder {
        guard let arr = byUrl[url], arr.count >= 2, !unmergedUrls.contains(url) else { continue }
        let rep = arr.reduce(arr[0]) { $1.article.lastReadAt > $0.article.lastReadAt ? $1 : $0 }
        for s in arr where s.id != rep.id { hidden.insert(s.id) }
        repByUrl.append((url, rep, arr.count - 1))
    }

    var reading: [ArticleSummary] = []
    var done: [ArticleSummary] = []
    for s in sorted where !hidden.contains(s.id) {
        if s.article.progress.percent >= 100 { done.append(s) } else { reading.append(s) }
    }
    var mergedReadingCount = 0
    var mergedDoneCount = 0
    var mergedReadingUrls: [String] = []
    var mergedDoneUrls: [String] = []
    for entry in repByUrl {
        if entry.rep.article.progress.percent >= 100 {
            mergedDoneCount += entry.hiddenCount
            mergedDoneUrls.append(entry.url)
        } else {
            mergedReadingCount += entry.hiddenCount
            mergedReadingUrls.append(entry.url)
        }
    }
    return ShelfShorts(
        reading: reading,
        done: done,
        mergedReadingCount: mergedReadingCount,
        mergedDoneCount: mergedDoneCount,
        mergedReadingUrls: mergedReadingUrls,
        mergedDoneUrls: mergedDoneUrls,
        searching: !q.isEmpty
    )
}

/// 一本书在书架上的派生量（ShelfPage.tsx:160-167 bookFacts）。
public struct ShelfBookFacts: Equatable {
    public let chapterIdx: Int
    public let percent: Int
    public let started: Bool
    public let words: Int
    public let minutes: Int

    public init(chapterIdx: Int, percent: Int, started: Bool, words: Int, minutes: Int) {
        self.chapterIdx = chapterIdx
        self.percent = percent
        self.started = started
        self.words = words
        self.minutes = minutes
    }
}

public func shelfBookFacts(_ book: BookMeta) -> ShelfBookFacts {
    let idx = bookChapterIndexOf(book: book, chapterId: book.progress.chapterId)
    let percent = Int(bookOverallPercent(book: book).rounded())
    let started = book.progress.percent > 0 || idx > 0
    let words = book.chapters.reduce(0) { $0 + $1.wordCount }
    return ShelfBookFacts(
        chapterIdx: idx,
        percent: percent,
        started: started,
        words: words,
        minutes: shelfEstimateMinutes(wordCount: words)
    )
}

/// 书 tab 排序：lastReadAt desc，再 createdAt desc（最近阅读的书为主卡）。
public func shelfSortedBooks(_ books: [BookMeta]) -> [BookMeta] {
    books.sorted { a, b in
        if a.lastReadAt != b.lastReadAt { return a.lastReadAt > b.lastReadAt }
        return a.createdAt > b.createdAt
    }
}
