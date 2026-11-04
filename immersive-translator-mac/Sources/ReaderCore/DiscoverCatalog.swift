import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// 发现书库（升级计划 B2 §3/§6）：目录信封解析 + 下载字节校验 + 错误文案。
/// 对齐 Windows src/lib/discoverCatalog.ts：
///
/// - parseBooksPage：GET /v1/books 应答 body → DiscoverPage；行缺 id/title 只丢该行
///   （不整页失败），信封形状不对返回 nil（调用方给「书库数据异常」文案）。
/// - verifyEpubSha256：下载的 EPUB 字节 CryptoKit SHA-256 与目录 sha256 比对；
///   Mac 同进程直接传 Data，无 base64 跨 IPC 步骤（Windows bytesFromBase64 无对应物）。
/// - 文案函数：失败路径中文口径的唯一出口（列表级 / 下载级），与 authErrorText 的
///   「只按 code/状态分支、绝不匹配服务端 message」同约束；invoke reject 级文案依赖
///   应用层 AuthError，落在 DiscoverService.discoverInvokeErrorText。

// MARK: - 类型

/// 目录行（服务端 BookView 的 15 键形状；description/wordCount 空时整体省键 → nil）。
public struct DiscoverBook: Equatable {
    public var id: String
    public var title: String
    public var author: String
    public var description: String?
    public var wordCount: Int?
    public var grade: String
    public var category: String
    public var language: String
    public var coverEmoji: String
    public var source: String
    public var sourceUrl: String
    public var licenseName: String
    public var licenseUrl: String
    public var fileSizeBytes: Int
    public var sha256: String

    public init(
        id: String, title: String, author: String, description: String? = nil, wordCount: Int? = nil,
        grade: String, category: String, language: String, coverEmoji: String, source: String,
        sourceUrl: String, licenseName: String, licenseUrl: String, fileSizeBytes: Int, sha256: String
    ) {
        self.id = id
        self.title = title
        self.author = author
        self.description = description
        self.wordCount = wordCount
        self.grade = grade
        self.category = category
        self.language = language
        self.coverEmoji = coverEmoji
        self.source = source
        self.sourceUrl = sourceUrl
        self.licenseName = licenseName
        self.licenseUrl = licenseUrl
        self.fileSizeBytes = fileSizeBytes
        self.sha256 = sha256
    }
}

/// 一页目录的解析结果（books 为累计前的当页行）。
public struct DiscoverPage: Equatable {
    public var books: [DiscoverBook]
    public var total: Int
    public var page: Int
    public var perPage: Int

    public init(books: [DiscoverBook], total: Int, page: Int, perPage: Int) {
        self.books = books
        self.total = total
        self.page = page
        self.perPage = perPage
    }
}

/// 难度 → 中文标签（服务端 grade 取值 easy/medium/hard）。
public let gradeLabels: [String: String] = [
    "easy": "入门",
    "medium": "进阶",
    "hard": "挑战",
]

// MARK: - 信封解析

/// `typeof v === "string" ? v : ""`。
func discoverAsStr(_ v: Any?) -> String {
    (v as? String) ?? ""
}

/// `typeof v === "number" && Number.isFinite(v)`：JSON 布尔经 JSONSerialization 装成
/// CFBoolean 也是 NSNumber，据此排除；非有限数视为非法。
func discoverAsNumber(_ v: Any?) -> NSNumber? {
    guard let number = v as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    guard number.doubleValue.isFinite else { return nil }
    return number
}

/// `asNum`：非数字 → 0。
func discoverAsNum(_ v: Any?) -> Int {
    discoverAsNumber(v)?.intValue ?? 0
}

func discoverAsBook(_ row: Any) -> DiscoverBook? {
    guard let r = row as? [String: Any] else { return nil }
    // id/title 是管线的硬依赖（文件名 / 埋点 bookId），缺任一只丢该行不整页失败。
    let id = discoverAsStr(r["id"])
    let title = discoverAsStr(r["title"])
    if id.isEmpty || title.isEmpty { return nil }
    let description: String? = {
        guard let text = r["description"] as? String, !text.isEmpty else { return nil }
        return text
    }()
    return DiscoverBook(
        id: id,
        title: title,
        author: discoverAsStr(r["author"]),
        description: description,
        wordCount: discoverAsNumber(r["wordCount"])?.intValue,
        grade: discoverAsStr(r["grade"]),
        category: discoverAsStr(r["category"]),
        language: discoverAsStr(r["language"]),
        coverEmoji: discoverAsStr(r["coverEmoji"]),
        source: discoverAsStr(r["source"]),
        sourceUrl: discoverAsStr(r["sourceUrl"]),
        licenseName: discoverAsStr(r["licenseName"]),
        licenseUrl: discoverAsStr(r["licenseUrl"]),
        fileSizeBytes: discoverAsNum(r["fileSizeBytes"]),
        sha256: discoverAsStr(r["sha256"])
    )
}

/// 解析目录应答 body：信封 { data: BookView[], total, page, perPage }。
/// body 非 JSON、非对象、data 非数组 → nil（信封坏，调用方走「书库数据异常」文案）。
public func parseBooksPage(_ body: String) -> DiscoverPage? {
    guard let data = body.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let env = parsed as? [String: Any],
          let rows = env["data"] as? [Any] else { return nil }
    return DiscoverPage(
        books: rows.compactMap(discoverAsBook),
        total: discoverAsNum(env["total"]),
        page: discoverAsNum(env["page"]),
        perPage: discoverAsNum(env["perPage"])
    )
}

// MARK: - 完整性校验与文件名

/// SHA-256（hex 小写）与目录 sha256 比对。expected 非法（缺省/非 64 位 hex）或摘要
/// 能力不可用时返回 true 放行——校验是传输损坏的旁路防线，不构成硬门槛；
/// 不匹配返回 false（下载损坏，要求重下）。
public func verifyEpubSha256(_ bytes: Data, expected: String) -> Bool {
    guard expected.range(of: #"^[0-9a-f]{64}$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
        return true
    }
    #if canImport(CryptoKit)
    let digest = SHA256.hash(data: bytes)
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return hex == expected.lowercased()
    #else
    return true
    #endif
}

/// 交给 parseEpub 的文件名：bookId 满足 ^[a-z0-9]+(-[a-z0-9]+)*$（BOOK_ID_PATTERN），
/// 天然带 .epub 后缀过扩展名校验且零非法字符，无需按书名清洗
/// （Windows epubFileOf 构造 File 的 Mac 对应物：Data + 文件名直接喂 parseEpub(data:fileName:)）。
public func epubFileNameOf(_ book: DiscoverBook) -> String {
    "\(book.id).epub"
}

/// 字节数 → 展示大小（≥0.5MB 走 MB 一位小数，否则 KB 取整）。
/// 与 JS `toFixed(1)` / `Math.round` 同舍入口径（整数算术精确：恰好半数向上取）。
public func formatFileSize(_ bytes: Int) -> String {
    if bytes >= 524_288 {
        let scaled = bytes * 10
        var tenths = scaled / 1_048_576
        if (scaled % 1_048_576) * 2 >= 1_048_576 { tenths += 1 }
        return "\(tenths / 10).\(tenths % 10) MB"
    }
    let kb = max(1, (bytes + 512) / 1024)
    return "\(kb) KB"
}

// MARK: - 中文文案

/// 429 插值口径（与 authErrorText.rate_limited 一致：秒数缺失/非正 → 通用文案）。
public func discoverRateLimitedText(retryAfterSeconds: Int?) -> String {
    if let secs = retryAfterSeconds, secs > 0 {
        return "操作过于频繁，请 \(secs) 秒后再试"
    }
    return "操作过于频繁，请稍后再试"
}

/// 列表/加载更多失败文案（errorDesign 3/4/5/6）：400 参数异常、404 书库不可访问、
/// 429 限流插值、其余（5xx/未知）服务暂不可用。信封坏文案见 discoverBodyErrorText。
public func discoverListErrorText(status: Int, retryAfterSeconds: Int?) -> String {
    if status == 400 { return "请求参数异常，请更新应用后重试；若持续出现请反馈" }
    if status == 404 { return "书库暂时无法访问（404），请稍后再试" }
    if status == 429 { return discoverRateLimitedText(retryAfterSeconds: retryAfterSeconds) }
    return "服务暂时不可用，请稍后再试"
}

/// 200 但信封解析失败的专属文案（errorDesign 7，发现 tab 直接引用）。
public let discoverBodyErrorText = "书库数据异常，请稍后重试；若持续出现请更新应用"

/// 下载失败文案（errorDesign 9/10/11/12/15）：404 行不存在/文件缺失统一为
/// 「当前不可下载」，401 理论不可达（匿名可用）仍给归一化口径。
public func discoverDownloadErrorText(status: Int, retryAfterSeconds: Int?) -> String {
    if status == 404 { return "这本书当前不可下载，请稍后再试或换一本" }
    if status == 400 { return "请求参数异常，请更新应用后重试；若持续出现请反馈" }
    if status == 401 { return "登录已失效，请重新登录" }
    if status == 429 { return discoverRateLimitedText(retryAfterSeconds: retryAfterSeconds) }
    return "服务暂时不可用，请稍后再试"
}

/// 沉浸云未开放（platform_unavailable）专属文案，不进 authErrorText 全局表。
public let discoverPlatformUnavailableText = "书库服务暂未开放，请稍后再试"

/// 下载态行内文案（DiscoverTab.tsx:183/188）。
public let discoverCorruptDataText = "下载的数据损坏，请重试"
public let discoverChecksumMismatchText = "下载的文件校验失败，请重新下载"
