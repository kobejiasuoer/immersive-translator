import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

/// 整本书阅读室 · EPUB 导入解析（.epub = zip + OPF 元数据 + XHTML 章节）。
/// 对齐 Windows src/core/bookImport.ts（解析规则逐条同源）：
///
/// - 只抽正文纯文本与章序，不做排版还原（沿用 fileImport「句子流完整」的口径）。
/// - 分章规则（docs/reading-room-feature-proposal.md §5.3 流程一，写死）：
///   1) 以 toc.ncx / EPUB3 NAV 目录为准；一个 toc 条目可对应多个 spine XHTML
///      （「多 HTML 拼一章」），按 toc 条目把它们合并为一章；
///   2) 多级目录展平到叶子条目，卷名作章名前缀（「卷一 · 第 3 章」）；
///   3) 无 toc、或 toc 对 spine 实质内容的覆盖率异常（>20% 的实质 spine 文件
///      未被任何条目引用，判为可疑目录）时回退：按 spine 顺序每 ~3,000 词
///      自动分节，命名「第 N 节」，预览页明示。
/// - DRM：META-INF/encryption.xml 里加密了非字体资源 → 判受保护，失败退出，
///   不产出空书，也不提供任何解除技术保护的指引（版权红线）。
///   只混淆字体的 encryption.xml（合法做法）不算 DRM；zip 加密位由
///   ZipArchive 在读取时直接拒绝。
/// - txt/docx/pdf 长文：应用层抽文后走 fallbackSections(from:) 同法分节。
///
/// XML 解析用 Foundation 的 XMLDocument；不少 EPUB 的 XHTML 并不严格合法，
/// 解析失败回退宽松标签剥离（对齐 TS「严格 XML 失败 → HTML 再试一次」）。
/// 任何失败抛 FileImportError（中文可读、给出退路），绝不产出空书。

// MARK: - 结果结构

/// 单章（纯文本 + 词数；Article 由导入方按章调 buildArticleFromText 构建）。
public struct EpubChapter: Equatable {
    public var title: String
    public var text: String
    public var wordCount: Int

    public init(title: String, text: String, wordCount: Int) {
        self.title = title
        self.text = text
        self.wordCount = wordCount
    }
}

public struct EpubBook: Equatable {
    public var title: String
    public var author: String
    /// 原始封面 dataURL（可能较大，入库前由应用层缩小；无封面缺省）。
    public var coverDataUrl: String?
    public var chapters: [EpubChapter]
    /// 章节是否来自书目（toc）。false = 回退分节。
    public var tocUsed: Bool
    /// 回退时的明示文案（预览页展示）。
    public var fallbackNotice: String?
    public var totalWords: Int
    /// 估时（分钟，135 wpm，与 IntakePreviewStats 同口径）。
    public var minutes: Int

    public init(
        title: String,
        author: String,
        coverDataUrl: String? = nil,
        chapters: [EpubChapter],
        tocUsed: Bool,
        fallbackNotice: String? = nil,
        totalWords: Int,
        minutes: Int
    ) {
        self.title = title
        self.author = author
        self.coverDataUrl = coverDataUrl
        self.chapters = chapters
        self.tocUsed = tocUsed
        self.fallbackNotice = fallbackNotice
        self.totalWords = totalWords
        self.minutes = minutes
    }
}

// MARK: - 导入草稿（确认时交给应用层入库）

public struct BookImportChapter: Equatable {
    public var title: String
    public var text: String

    public init(title: String, text: String) {
        self.title = title
        self.text = text
    }
}

public struct BookImportDraft: Equatable {
    public var title: String
    public var author: String?
    /// 缩小后的封面 dataURL（无封面缺省）。
    public var cover: String?
    /// 用户勾选的章（按书序）。
    public var chapters: [BookImportChapter]
    /// 三个目标的大纲词命中数（按所选章文本实算，禁止写死）。
    public var radar: BookRadar
    public var totalWords: Int
    public var minutes: Int

    public init(
        title: String,
        author: String? = nil,
        cover: String? = nil,
        chapters: [BookImportChapter],
        radar: BookRadar,
        totalWords: Int,
        minutes: Int
    ) {
        self.title = title
        self.author = author
        self.cover = cover
        self.chapters = chapters
        self.radar = radar
        self.totalWords = totalWords
        self.minutes = minutes
    }
}

// MARK: - 常量（对齐 bookImport.ts 顶部）

let maxEpubBytes = 64 * 1024 * 1024
let maxTotalTextChars = 12_000_000
let maxBookChapters = 999
/// 回退分节的每节词数。
let fallbackSectionWords = 3000
/// 「实质内容」判定：纯文本少于此的 spine 文件（封面/扉页等）不计入覆盖率。
let substantialTextChars = 200
/// >20% 的实质 spine 文件未被 toc 引用 → 可疑目录 → 回退。
let maxUnreferencedRatio = 0.2
/// 封面 dataURL 上限（超过视为异常资源，丢弃封面不影响文本）。
let maxCoverDataUrlChars = 400_000

let bookWpm = 135

// MARK: - EPUB 主入口

/// 解析 .epub 字节流 → 章节文本数组。失败抛 FileImportError，绝不产出空书。
public func parseEpub(data: Data, fileName: String) throws -> EpubBook {
    let lower = fileName.lowercased()
    guard lower.hasSuffix(".epub") else {
        throw FileImportError("仅支持 .epub 文件；.mobi / .azw3 暂不支持，可先用 Calibre 转成 .epub")
    }
    if data.count > maxEpubBytes {
        throw FileImportError("文件超过 64MB 上限，请确认是文字版 EPUB")
    }
    let zip: ZipArchive
    do {
        zip = try ZipArchive(data)
    } catch {
        throw FileImportError("EPUB 解析失败：文件已损坏或不是有效的 .epub。请重新获取文件，或改走「粘贴文本」导入。")
    }
    if try looksDrmProtected(zip) {
        throw FileImportError(
            "该文件受 DRM（数字版权保护）加密，无法解析。请使用你已购买/无保护的正版文件，或改走「粘贴文本」导入。"
        )
    }
    guard let containerXml = zipEntry(zip, path: "META-INF/container.xml") else {
        throw FileImportError("不是有效的 EPUB（缺少 META-INF/container.xml）。请确认文件未损坏后重试。")
    }
    let rootfile = rootFilePath(String(data: containerXml, encoding: .utf8) ?? "")
    guard !rootfile.isEmpty, let opfData = zipEntry(zip, path: rootfile) else {
        throw FileImportError("不是有效的 EPUB（找不到 OPF 元数据）。请确认文件未损坏后重试。")
    }
    let fileTitle = fileTitleOf(fileName: fileName)
    guard let opf = parseOpf(opfPath: rootfile, xml: String(data: opfData, encoding: .utf8) ?? "", fileTitle: fileTitle),
          !opf.spine.isEmpty else {
        throw FileImportError("EPUB 缺少阅读顺序（spine）信息，无法分章。请确认是完整的电子书文件。")
    }

    // manifest idref → zip 路径；spine 顺序即阅读顺序。
    var spinePaths: [String] = []
    for idref in opf.spine {
        guard let item = opf.manifest[idref] else { continue }
        if !item.mediaType.isEmpty, item.mediaType.range(of: "xhtml|html|xml", options: .regularExpression) == nil {
            continue
        }
        spinePaths.append(resolveZipPath(opf.opfDir, item.href))
    }
    if spinePaths.isEmpty {
        throw FileImportError("EPUB 里没有可抽取正文的 XHTML 内容。")
    }
    var pathToSpineIdx: [String: Int] = [:]
    for (i, p) in spinePaths.enumerated() where pathToSpineIdx[p] == nil {
        pathToSpineIdx[p] = i
    }

    // 逐文件抽正文（一次抽取，分章与词数共用）。
    var texts: [String] = []
    var totalChars = 0
    for path in spinePaths {
        let text: String
        if let entryData = zipEntry(zip, path: path) {
            text = extractXhtmlText(String(data: entryData, encoding: .utf8) ?? "")
        } else {
            text = ""
        }
        totalChars += text.count
        texts.append(text)
        if totalChars > maxTotalTextChars {
            throw FileImportError("这本书太大了（正文超过上限），请拆分后分卷导入。")
        }
    }
    let hasText = texts.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    if !hasText {
        throw FileImportError(
            "这个 EPUB 里抽不到正文文字（可能整本都是图片扫描页）。\n请改用「粘贴文本」导入，或换文字版文件。"
        )
    }

    // ---- 目录（toc）解析与分章 ----
    var tocRoots: [FlatTocNode] = []
    // toc 条目的 href 相对「toc 文档所在目录」（可能与 OPF 不同级）。
    var tocBaseDir = opf.opfDir
    let navItem = opf.manifest.values.first { $0.properties.split(separator: " ").contains("nav") }
    if let navItem {
        let navPath = resolveZipPath(opf.opfDir, navItem.href)
        if let navData = zipEntry(zip, path: navPath) {
            tocRoots = parseNavDoc(String(data: navData, encoding: .utf8) ?? "")
            tocBaseDir = parentDir(navPath)
        }
    }
    if tocRoots.isEmpty {
        let ncxId = opf.ncxId ?? opf.manifest.first { $0.value.mediaType == "application/x-dtbncx+xml" }?.key
        if let ncxId, let ncxItem = opf.manifest[ncxId] {
            let ncxPath = resolveZipPath(opf.opfDir, ncxItem.href)
            if let ncxData = zipEntry(zip, path: ncxPath) {
                tocRoots = parseNcxDoc(String(data: ncxData, encoding: .utf8) ?? "")
                tocBaseDir = parentDir(ncxPath)
            }
        }
    }

    var tocUsed = true
    var fallbackNotice: String?
    let tocEntries = flattenToc(tocRoots, baseDir: tocBaseDir, pathToSpineIdx: pathToSpineIdx)


    var substantialIdx: [Int] = []
    for (i, t) in texts.enumerated() where t.count >= substantialTextChars {
        substantialIdx.append(i)
    }
    let referenced = Set(tocEntries.compactMap { pathToSpineIdx[$0.zipPath] })
    let unreferencedSubstantial = substantialIdx.filter { !referenced.contains($0) }.count
    let coverageSuspicious = !substantialIdx.isEmpty
        && Double(unreferencedSubstantial) / Double(substantialIdx.count) > maxUnreferencedRatio

    var chapters: [EpubChapter] = []
    if !tocEntries.isEmpty, !coverageSuspicious {
        // 按 toc 条目切：条目 k 覆盖 [起始 spine, 下一条目起始) 的全部文件。
        var bounds: [(title: String, start: Int)] = []
        for e in tocEntries {
            let start = pathToSpineIdx[e.zipPath] ?? 0
            if let last = bounds.last, start <= last.start { continue }
            bounds.append((e.title, start))
        }
        for k in 0..<bounds.count {
            let from = bounds[k].start
            let to = k + 1 < bounds.count ? bounds[k + 1].start : spinePaths.count
            let text = texts[from..<max(from, to)].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                .joined(separator: "\n\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            chapters.append(EpubChapter(title: bounds[k].title, text: text, wordCount: countWords(text)))
            if chapters.count >= maxBookChapters { break }
        }
    } else {
        // 回退：按 spine 顺序每 ~3,000 词分节（跳过空文件/封面页）。
        tocUsed = false
        fallbackNotice = tocEntries.isEmpty
            ? "未识别到目录，已按内容长度自动分节"
            : "这本书的目录不完整，已按内容长度自动分节"
        var buf: [String] = []
        var bufWords = 0
        for text in texts {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            buf.append(t)
            bufWords += countWords(t)
            if bufWords >= fallbackSectionWords {
                let joined = buf.joined(separator: "\n\n")
                chapters.append(EpubChapter(
                    title: "第 \(chapters.count + 1) 节",
                    text: joined,
                    wordCount: countWords(joined)
                ))
                buf = []
                bufWords = 0
                if chapters.count >= maxBookChapters { break }
            }
        }
        if !buf.isEmpty, chapters.count < maxBookChapters {
            let joined = buf.joined(separator: "\n\n")
            chapters.append(EpubChapter(
                title: "第 \(chapters.count + 1) 节",
                text: joined,
                wordCount: countWords(joined)
            ))
        }
    }

    chapters = chapters.filter { $0.wordCount > 0 }
    if chapters.isEmpty {
        throw FileImportError("没有解析到有效的章节内容，已放弃导入（不会产出空书）。请换一个文件或改走「粘贴文本」。")
    }
    // 章名去重/兜底。
    var seenTitles = Set<String>()
    for i in chapters.indices {
        var title = chapters[i].title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { title = "第 \(i + 1) 章" }
        if seenTitles.contains(title) { title = "\(title)（\(i + 1)）" }
        seenTitles.insert(title)
        chapters[i].title = title
    }

    // ---- 封面（可失败，不影响文本） ----
    var coverDataUrl: String?
    if let coverItemId = opf.coverItemId, let item = opf.manifest[coverItemId] {
        if let entryData = zipEntry(zip, path: resolveZipPath(opf.opfDir, item.href)) {
            let mime = item.mediaType.range(of: "png", options: .caseInsensitive) != nil ? "image/png" : "image/jpeg"
            let dataUrl = "data:\(mime);base64,\(entryData.base64EncodedString())"
            if dataUrl.count <= maxCoverDataUrlChars { coverDataUrl = dataUrl }
        }
    }

    let totalWords = chapters.reduce(0) { $0 + $1.wordCount }
    return EpubBook(
        title: opf.title.isEmpty ? fileTitle : opf.title,
        author: opf.author,
        coverDataUrl: coverDataUrl,
        chapters: chapters,
        tocUsed: tocUsed,
        fallbackNotice: fallbackNotice,
        totalWords: totalWords,
        minutes: max(1, Int((Double(totalWords) / Double(bookWpm)).rounded()))
    )
}

/// 长文（txt / docx / pdf 抽出的正文）回退分节：段落攒到 ~3,000 词切一节，
/// 命名「第 N 节」。预览页必须通过 tocUsed=false + fallbackNotice 明示。
public func fallbackSections(from text: String) -> [EpubChapter] {
    var chapters: [EpubChapter] = []
    var buf: [String] = []
    var bufWords = 0
    for paragraph in splitParagraphs(text) {
        let t = paragraph.en.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { continue }
        buf.append(t)
        bufWords += countWords(t)
        if bufWords >= fallbackSectionWords {
            let joined = buf.joined(separator: "\n\n")
            chapters.append(EpubChapter(
                title: "第 \(chapters.count + 1) 节",
                text: joined,
                wordCount: countWords(joined)
            ))
            buf = []
            bufWords = 0
            if chapters.count >= maxBookChapters { return chapters }
        }
    }
    if !buf.isEmpty, chapters.count < maxBookChapters {
        let joined = buf.joined(separator: "\n\n")
        chapters.append(EpubChapter(
            title: "第 \(chapters.count + 1) 节",
            text: joined,
            wordCount: countWords(joined)
        ))
    }
    return chapters
}

// MARK: - 导入草稿构建（雷达实算）

/// 三个目标的大纲词命中数：对同一份文本实算（去重），任何情况下不得用常量凑数。
public func radarForText(_ text: String, wordlists: ExamWordlists) -> BookRadar {
    BookRadar(
        kaoyan: coveredWords(in: text, goal: .kaoyan, wordlists: wordlists).count,
        cet4: coveredWords(in: text, goal: .cet4, wordlists: wordlists).count,
        cet6: coveredWords(in: text, goal: .cet6, wordlists: wordlists).count
    )
}

/// 导入向导确认时交给应用层的入库草稿。章文本为空时返回 nil（不产空书）。
public func buildBookImportDraft(
    title: String,
    author: String? = nil,
    cover: String? = nil,
    chapters: [BookImportChapter],
    wordlists: ExamWordlists
) -> BookImportDraft? {
    let chosen = chapters.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard !chosen.isEmpty else { return nil }
    let fullText = chosen.map(\.text).joined(separator: "\n\n")
    let totalWords = chosen.reduce(0) { $0 + countWords($1.text) }
    return BookImportDraft(
        title: title,
        author: author,
        cover: cover,
        chapters: chosen,
        radar: radarForText(fullText, wordlists: wordlists),
        totalWords: totalWords,
        minutes: max(1, Int((Double(totalWords) / Double(bookWpm)).rounded()))
    )
}

// MARK: - zip 内路径

/// zip 内路径定位：精确匹配优先，其次忽略大小写与 URL 编码差异。
func zipEntry(_ zip: ZipArchive, path: String) -> Data? {
    if let direct = try? zip.readFile(named: path) { return direct }
    let norm = zipNormalized(path)
    guard let names = try? zip.entries() else { return nil }
    for entry in names {
        if zipNormalized(entry.fileName) == norm {
            return try? zip.readFile(named: entry.fileName)
        }
    }
    return nil
}

private func zipNormalized(_ path: String) -> String {
    let removedPercent = path.removingPercentEncoding ?? path
    return removedPercent.lowercased()
}

/// OPF / toc 相对 href → zip 内绝对路径（处理 ../ 与 URL 编码；fragment 丢弃）。
public func resolveZipPath(_ baseDir: String, _ href: String) -> String {
    let raw = href.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    let clean = (String(raw).removingPercentEncoding ?? String(raw))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty { return "" }
    var out: [String] = []
    for part in "\(baseDir)\(clean)".split(separator: "/") {
        if part == "." { continue }
        if part == ".." {
            out.removeLast()
        } else {
            out.append(String(part))
        }
    }
    return out.joined(separator: "/")
}

func parentDir(_ path: String) -> String {
    guard let idx = path.lastIndex(of: "/") else { return "" }
    return String(path[path.startIndex...idx])
}

// MARK: - XHTML → 纯文本

let skipTags: Set<String> = ["script", "style", "head", "template", "svg", "iframe"]
let blockTags: Set<String> = [
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
    "td", "th", "dd", "dt", "pre", "section", "article", "header", "footer",
    "figure", "figcaption", "main", "aside", "table", "tr", "ul", "ol", "body", "html",
]

private func localName(of node: XMLNode?) -> String {
    guard let node else { return "" }
    if let element = node as? XMLElement, let local = element.localName, !local.isEmpty {
        return local.lowercased()
    }
    let name = node.name ?? ""
    return name.split(separator: ":", maxSplits: 1).last.map { $0.lowercased() } ?? ""
}

/// 块级结构 → 段落列表：块边界切段落，行内折叠空白。
private func blockParagraphs(_ node: XMLNode, out: inout [String], cur: inout String) {
    switch node.kind {
    case .text:
        cur += node.stringValue ?? ""
    case .element:
        let tag = localName(of: node)
        if skipTags.contains(tag) { return }
        if tag == "br" {
            cur += " "
            return
        }
        func flush() {
            let text = cur.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { out.append(text) }
            cur = ""
        }
        if blockTags.contains(tag) {
            flush()
            for child in node.children ?? [] {
                blockParagraphs(child, out: &out, cur: &cur)
            }
            flush()
        } else {
            for child in node.children ?? [] {
                blockParagraphs(child, out: &out, cur: &cur)
            }
        }
    default:
        break
    }
}

func paragraphsFromXMLDocument(_ doc: XMLDocument) -> String {
    var body: XMLNode? = doc.rootElement()
    if let root = body, localName(of: root) != "body" {
        func findBody(_ node: XMLNode) -> XMLNode? {
            if localName(of: node) == "body" { return node }
            for child in node.children ?? [] {
                if let hit = findBody(child) { return hit }
            }
            return nil
        }
        body = findBody(root)
    }
    guard let body else { return "" }
    var out: [String] = []
    var cur = ""
    for child in body.children ?? [] {
        blockParagraphs(child, out: &out, cur: &cur)
    }
    let tail = cur.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !tail.isEmpty { out.append(tail) }
    return out.joined(separator: "\n\n")
}

// ---- 宽松 HTML 回退（标签剥离 + 实体解码） ----

private func decodeBasicEntities(_ s: String) -> String {
    var text = s
    let named: [String: String] = [
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'",
        "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
    ]
    for (k, v) in named {
        text = text.replacingOccurrences(of: k, with: v)
    }
    guard text.contains("&#"), let regex = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);") else {
        return text
    }
    let ns = text as NSString
    let out = NSMutableString()
    var last = 0
    for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        out.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
        let hexFlag = m.range(at: 1).location != NSNotFound
            && ns.substring(with: m.range(at: 1)).lowercased() == "x"
        let digits = ns.substring(with: m.range(at: 2))
        let value = hexFlag ? UInt32(digits, radix: 16) : UInt32(digits)
        if let value, let scalar = Unicode.Scalar(value) {
            out.append(String(Character(scalar)))
        }
        last = m.range.upperBound
    }
    out.append(ns.substring(from: last))
    return out as String
}

func paragraphsFromLooseHTML(_ xml: String) -> String {
    var text = xml
    // 注释与脚本样式整体剥离。
    text = text.replacingOccurrences(
        of: #"(?s)<!--.*?-->"#,
        with: "", options: .regularExpression
    )
    text = text.replacingOccurrences(
        of: #"(?is)<(script|style|head|svg|iframe|template)\b.*?</\s*\1\s*>"#,
        with: "", options: .regularExpression
    )
    // 块级标签边界 → 段落分隔；br → 空格。
    text = text.replacingOccurrences(
        of: #"(?i)<br\s*/?\s*>"#,
        with: " ", options: .regularExpression
    )
    text = text.replacingOccurrences(
        of: #"(?i)</?\s*(p|div|h[1-6]|li|blockquote|td|th|dd|dt|pre|section|article|header|footer|figure|figcaption|main|aside|table|tr|ul|ol|body|html)\b[^>]*>"#,
        with: "\n\n", options: .regularExpression
    )
    // 剩余标签剥离。
    text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
    let decoded = decodeBasicEntities(text)
    var out: [String] = []
    for chunk in decoded.components(separatedBy: "\n\n") {
        let para = chunk.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !para.isEmpty { out.append(para) }
    }
    return out.joined(separator: "\n\n")
}

/// 单个 XHTML 文档 → 正文纯文本（段落间空行）。严格 XML 解析失败才回退宽松
/// HTML 剥离（对齐 TS：parsererror → text/html 再试；解析成功即按 XML 走）。
public func extractXhtmlText(_ xml: String) -> String {
    if let doc = try? XMLDocument(xmlString: xml, options: []) {
        return paragraphsFromXMLDocument(doc)
    }
    return paragraphsFromLooseHTML(xml)
}

// MARK: - DRM 识别

/// encryption.xml 里是否加密了非字体资源（= DRM；只混淆字体是合法做法）。
func looksDrmProtected(_ zip: ZipArchive) throws -> Bool {
    guard let data = zipEntry(zip, path: "META-INF/encryption.xml") else { return false }
    guard let xml = String(data: data, encoding: .utf8),
          let doc = try? XMLDocument(xmlString: xml, options: []) else { return false }
    let fontRegex = #"(?i)\.(ttf|otf|woff2?)(\?|$)"#
    func walk(_ node: XMLNode) -> Bool {
        // 返回 true = 已判定受保护（加密了非字体资源），提前终止。
        guard let element = node as? XMLElement else { return false }
        if localName(of: element).hasSuffix("cipherreference") {
            let uri = element.attribute(forName: "URI")?.stringValue ?? ""
            if uri.range(of: fontRegex, options: .regularExpression) == nil {
                return true
            }
        }
        for child in element.children ?? [] {
            if walk(child) { return true }
        }
        return false
    }
    if let root = doc.rootElement(), walk(root) { return true }
    return false
}

// MARK: - container / OPF

private func rootFilePath(_ containerXml: String) -> String {
    guard let doc = try? XMLDocument(xmlString: containerXml, options: []) else { return "" }
    return firstElementsByTagName(doc, "rootfile")?
        .attribute(forName: "full-path")?.stringValue ?? ""
}

/// 按局部名（大小写不敏感、忽略命名空间前缀）找第一个元素。
private func firstElementsByTagName(_ doc: XMLDocument, _ tag: String) -> XMLElement? {
    guard let root = doc.rootElement() else { return nil }
    let wanted = tag.lowercased()
    func walk(_ node: XMLNode) -> XMLElement? {
        guard let element = node as? XMLElement else { return nil }
        if localName(of: element) == wanted { return element }
        for child in element.children ?? [] {
            if let hit = walk(child) { return hit }
        }
        return nil
    }
    return walk(root)
}

private func textOfFirstTag(_ doc: XMLDocument, _ tag: String) -> String {
    firstElementsByTagName(doc, tag)?.stringValue?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

struct ManifestItem {
    var id: String
    var href: String
    var mediaType: String
    var properties: String
}

struct OpfInfo {
    var opfPath: String
    var opfDir: String
    var title: String
    var author: String
    var manifest: [String: ManifestItem]
    var spine: [String]
    var ncxId: String?
    var coverItemId: String?
}

func parseOpf(opfPath: String, xml: String, fileTitle: String) -> OpfInfo? {
    guard let doc = try? XMLDocument(xmlString: xml, options: []),
          let root = doc.rootElement() else { return nil }
    var manifest: [String: ManifestItem] = [:]
    var spine: [String] = []
    var ncxId: String?
    var coverItemId: String?
    func walk(_ node: XMLNode) {
        guard let element = node as? XMLElement else { return }
        let tag = localName(of: element)
        switch tag {
        case "item":
            if let id = element.attribute(forName: "id")?.stringValue,
               let href = element.attribute(forName: "href")?.stringValue {
                manifest[id] = ManifestItem(
                    id: id,
                    href: href,
                    mediaType: element.attribute(forName: "media-type")?.stringValue ?? "",
                    properties: element.attribute(forName: "properties")?.stringValue ?? ""
                )
            }
        case "itemref":
            if let idref = element.attribute(forName: "idref")?.stringValue {
                spine.append(idref)
            }
        case "spine":
            ncxId = element.attribute(forName: "toc")?.stringValue
        case "meta":
            // EPUB2 meta name="cover" content=id。
            if element.attribute(forName: "name")?.stringValue == "cover" {
                coverItemId = element.attribute(forName: "content")?.stringValue ?? coverItemId
            }
        default:
            break
        }
        for child in element.children ?? [] { walk(child) }
    }
    walk(root)
    // EPUB3 properties="cover-image"。
    for item in manifest.values where item.properties.split(separator: " ").contains("cover-image") {
        coverItemId = item.id
    }
    let title = dcMetadataText(doc, "title")
    let author = dcMetadataText(doc, "creator")
    return OpfInfo(
        opfPath: opfPath,
        opfDir: parentDir(opfPath),
        title: title.isEmpty ? fileTitle : title,
        author: author,
        manifest: manifest,
        spine: spine,
        ncxId: ncxId,
        coverItemId: coverItemId
    )
}

/// dc:title / dc:creator：认 dc 前缀或 DC 命名空间（TS 只认字面 "dc:title"，
/// 这里放宽到命名空间匹配，两口径对规范文件等价）。
private func dcMetadataText(_ doc: XMLDocument, _ tag: String) -> String {
    let dcNamespace = "http://purl.org/dc/elements/1.1/"
    guard let root = doc.rootElement() else { return "" }
    func walk(_ node: XMLNode) -> String {
        guard let element = node as? XMLElement else { return "" }
        if localName(of: element) == tag {
            let name = element.name ?? ""
            let uri = element.uri ?? ""
            if name == "dc:\(tag)" || uri == dcNamespace {
                return (element.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        for child in element.children ?? [] {
            let hit = walk(child)
            if !hit.isEmpty { return hit }
        }
        return ""
    }
    return walk(root)
}

// MARK: - toc（EPUB3 NAV / EPUB2 NCX）

struct FlatTocNode: Equatable {
    var label: String
    var href: String
    var children: [FlatTocNode]
}

struct TocEntry: Equatable {
    var title: String
    /// zip 内路径（去 fragment）。
    var zipPath: String
}

/// EPUB3 NAV 文档 → toc 树（a 的 href 为相对导航文件的路径）。
func parseNavDoc(_ xml: String) -> [FlatTocNode] {
    guard let doc = try? XMLDocument(xmlString: xml, options: []),
          let root = doc.rootElement() else { return [] }
    // 找 nav：epub:type="toc" 优先，否则第一个 nav。
    var navs: [XMLElement] = []
    func collect(_ node: XMLNode) {
        guard let element = node as? XMLElement else { return }
        if localName(of: element) == "nav" { navs.append(element) }
        for child in element.children ?? [] { collect(child) }
    }
    collect(root)
    func navType(_ element: XMLElement) -> String {
        if let v = element.attribute(forName: "epub:type")?.stringValue { return v }
        // 命名空间形式 {http://www.idpf.org/2007/ops}type。
        for attr in element.attributes ?? [] {
            if localName(of: attr) == "type", (attr.uri ?? "").contains("idpf.org/2007/ops") {
                return attr.stringValue ?? ""
            }
        }
        return ""
    }
    let tocNav = navs.first { navType($0) == "toc" } ?? navs.first
    guard let tocNav else { return [] }
    // nav 下第一个 ol（TS: tocNav.getElementsByTagName("ol")[0]，含嵌套，深度优先首个）。
    func firstDescendant(_ node: XMLNode, _ tag: String) -> XMLElement? {
        for child in node.children ?? [] {
            if let element = child as? XMLElement {
                if localName(of: element) == tag { return element }
                if let hit = firstDescendant(element, tag) { return hit }
            }
        }
        return nil
    }
    guard let rootOl = firstDescendant(tocNav, "ol") else { return [] }
    var result: [FlatTocNode] = []
    for child in rootOl.children ?? [] {
        guard let li = child as? XMLElement, localName(of: li) == "li" else { continue }
        if let node = walkNavLi(li) { result.append(node) }
    }
    return result
}

/// 只找本 li 的直接子级 a/span（嵌套 ol 里的 a 归子节点所有）。
private func walkNavLi(_ li: XMLElement) -> FlatTocNode? {
    var anchor: XMLElement?
    var childOl: XMLElement?
    for child in li.children ?? [] {
        guard let element = child as? XMLElement else { continue }
        let tag = localName(of: element)
        if anchor == nil, tag == "a" || tag == "span" { anchor = element }
        if childOl == nil, tag == "ol" { childOl = element }
    }
    guard let anchor else { return nil }
    var kids: [FlatTocNode] = []
    for child in childOl?.children ?? [] {
        guard let li = child as? XMLElement, localName(of: li) == "li" else { continue }
        if let node = walkNavLi(li) { kids.append(node) }
    }
    return FlatTocNode(
        label: (anchor.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
        href: anchor.attribute(forName: "href")?.stringValue ?? "",
        children: kids
    )
}

/// EPUB2 NCX → toc 树。content/navLabel 只认本 navPoint 的直接子级。
func parseNcxDoc(_ xml: String) -> [FlatTocNode] {
    guard let doc = try? XMLDocument(xmlString: xml, options: []),
          let root = doc.rootElement() else { return [] }
    func firstDirectChild(_ node: XMLNode, _ tag: String) -> XMLElement? {
        for child in node.children ?? [] {
            if let element = child as? XMLElement, localName(of: element) == tag { return element }
        }
        return nil
    }
    func walkNavPoint(_ navPoint: XMLElement) -> FlatTocNode? {
        let label = (firstDirectChild(navPoint, "navlabel")?.stringValue ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let href = firstDirectChild(navPoint, "content")?.attribute(forName: "src")?.stringValue ?? ""
        var kids: [FlatTocNode] = []
        for child in navPoint.children ?? [] {
            guard let np = child as? XMLElement, localName(of: np) == "navpoint" else { continue }
            if let node = walkNavPoint(np) { kids.append(node) }
        }
        return FlatTocNode(label: label, href: href, children: kids)
    }
    // navMap（深度优先首个）。
    func firstDescendant(_ node: XMLNode, _ tag: String) -> XMLElement? {
        for child in node.children ?? [] {
            if let element = child as? XMLElement {
                if localName(of: element) == tag { return element }
                if let hit = firstDescendant(element, tag) { return hit }
            }
        }
        return nil
    }
    guard let navMap = firstDescendant(root, "navmap") else { return [] }
    var result: [FlatTocNode] = []
    for child in navMap.children ?? [] {
        guard let np = child as? XMLElement, localName(of: np) == "navpoint" else { continue }
        if let node = walkNavPoint(np) { result.append(node) }
    }
    return result
}

/// toc 树 → 叶子条目（展平；卷名作章名前缀），并解析为 zip 路径。
func flattenToc(_ roots: [FlatTocNode], baseDir: String, pathToSpineIdx: [String: Int]) -> [TocEntry] {
    var entries: [TocEntry] = []
    func walk(_ nodes: [FlatTocNode], prefix: String) {
        for node in nodes {
            let title = [prefix, node.label].filter { !$0.isEmpty }.joined(separator: " · ")
            let zipPath = node.href.isEmpty ? "" : resolveZipPath(baseDir, node.href)
            let hasSpineTarget = !zipPath.isEmpty && pathToSpineIdx[zipPath] != nil
            if node.children.isEmpty {
                if !title.isEmpty, hasSpineTarget { entries.append(TocEntry(title: title, zipPath: zipPath)) }
            } else {
                // 有子节点且自身也指向内容 → 自身也算一章（卷首页常有正文）。
                if hasSpineTarget, !title.isEmpty { entries.append(TocEntry(title: title, zipPath: zipPath)) }
                walk(node.children, prefix: title)
            }
        }
    }
    walk(roots, prefix: "")
    // 同一 spine 文件被多个条目引用时保留首个（后续是重复目录）。
    var seen = Set<String>()
    return entries.filter { seen.insert($0.zipPath).inserted }
}
