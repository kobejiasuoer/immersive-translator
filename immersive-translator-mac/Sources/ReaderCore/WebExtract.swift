import Foundation

/// 网页正文提取（内容进水口 · 网页链接导入）。对齐 web_extract.rs：
/// 不引入 DOM 解析器依赖——正则剥噪声块（script/style/nav…），块级标签转段落，
/// 实体解码，短行过滤。对新闻/博客/维基类页面足够用；复杂页面宁可失败
/// （正文 < 150 词报「可能是付费墙/需要登录」），由导入弹窗引导走「粘贴文本」退路。

public struct FetchedArticle: Equatable {
    public var url: String
    public var host: String
    public var title: String
    public var text: String
    /// 正文超过 maxArticleChars 被整段截断时为 true（预览卡提示用户；对齐
    /// web_extract.rs FetchedArticle.truncated / webExtract.ts `truncated?: boolean`）。
    public var truncated: Bool

    public init(url: String, host: String, title: String, text: String, truncated: Bool = false) {
        self.url = url
        self.host = host
        self.title = title
        self.text = text
        self.truncated = truncated
    }
}

public let webExtractMinArticleWords = 150

/// 单篇正文长度上限（字符数，chars 口径，含段落间分隔符）：50_000 ≈ 1 万词/约 160 段；
/// 配合 llm 桶 60/min 与客户端 429 自动退避，最坏耗时分钟级可控（web_extract.rs:15）。
public let maxArticleChars = 50_000

/// 整段保留截断（对齐 web_extract.rs cap_text_chars）：段落间 "\n\n" 分隔符计入预算
/// （join 后总长严格 ≤ maxChars）；超限时在段落边界截断并标记 truncated；首段恒保留
/// （宁多勿空，单段超限也原样返回且不标 truncated）。字符数按 Unicode 标量计
/// （与 Rust `chars().count()` 同口径，而非 Swift 字素簇）。
public func capTextChars(_ text: String, maxChars: Int) -> (text: String, truncated: Bool) {
    let paras = text.components(separatedBy: "\n\n")
    var kept: [String] = []
    var total = 0
    for (i, p) in paras.enumerated() {
        let sep = i > 0 ? 2 : 0
        let len = p.unicodeScalars.count + sep
        if i > 0 && total + len > maxChars {
            return (kept.joined(separator: "\n\n"), true)
        }
        total += len
        kept.append(p)
    }
    return (kept.joined(separator: "\n\n"), false)
}

/// 预览/导入共用的正文提取（纯函数，可测）。正文词数门槛可注入（测试小夹具用小门槛）。
public func extractArticle(
    finalURL: String,
    html: String,
    minWords: Int = webExtractMinArticleWords
) -> Result<FetchedArticle, FileImportError> {
    let host = hostOf(finalURL)
    let title = extractTitle(html: html) ?? host
    let text = extractText(html: html)
    let words = text.split(whereSeparator: \.isWhitespace).count
    if words < minWords {
        return .failure(FileImportError(
            "只抓到 \(words) 个词的正文——这个页面可能是付费墙、需要登录或反爬限制。可以在网页里全选复制正文，用「粘贴文本」导入，内容是一样的。"
        ))
    }
    // 门槛检查按原文全量词数（截断不影响付费墙判定），之后再做长度截断。
    let capped = capTextChars(text, maxChars: maxArticleChars)
    return .success(FetchedArticle(
        url: finalURL, host: host, title: title, text: capped.text, truncated: capped.truncated
    ))
}

public func hostOf(_ url: String) -> String {
    if let parsed = URL(string: url), let host = parsed.host, !host.isEmpty {
        return host
    }
    return url
}

private func regex(_ pattern: String) -> NSRegularExpression? {
    try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators, .caseInsensitive])
}

private func firstCapture(_ html: String, pattern: String) -> String? {
    guard let re = regex(pattern),
          let m = re.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
          m.numberOfRanges > 1,
          let r = Range(m.range(at: 1), in: html) else { return nil }
    return String(html[r])
}

func extractTitle(html: String) -> String? {
    // og:title 优先，回落 <title>。
    let raw = firstCapture(html, pattern: #"<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#)
        ?? firstCapture(html, pattern: #"<title[^>]*>(.*?)</title>"#)
    guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    let t = decodeHTMLEntities(raw).trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    // 「文章标题 - 站点名」/「文章标题 | 站点名」截掉站点尾巴。
    if let cut = try? NSRegularExpression(pattern: #"\s+[|–—-]\s+[^|–—-]{1,30}$"#) {
        let ns = t as NSString
        let replaced = cut.stringByReplacingMatches(
            in: t, range: NSRange(location: 0, length: ns.length), withTemplate: ""
        )
        return replaced.trimmingCharacters(in: .whitespaces)
    }
    return t
}

/// 正文提取：只留 <body>，剥噪声块与标签，块级边界转段落，短行过滤。
public func extractText(html: String) -> String {
    // 只留 body（无 body 的片段直接全量处理）。
    var s = firstCapture(html, pattern: #"<body\b[^>]*>(.*)</body>"#) ?? html

    // 注释与噪声块
    if let re = regex(#"<!--.*?-->"#) {
        s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
    }
    for tag in ["script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "header",
                "footer", "aside", "figure", "button", "select"] {
        if let re = regex(#"<\#(tag)\b[^>]*>.*?</\#(tag)>"#) {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        }
    }
    // div/section 不在固定标签表里，按属性特征点名整块删除：美式政府站横幅
    // （<section class="usa-banner"> 展开文案在 div.usa-banner__guidance 里）、
    // 打印头部（p.nist-print-header__url）等 chrome 的容器都是 div/section/p；
    // 行内 display:none 的隐藏块（不解析样式表，只认行内样式）同样照抄会混进正文。
    for tag in ["section", "div", "p"] {
        if let re = regex(#"<\#(tag)\b[^>]*\bclass=["'][^"']*(?:banner|print-header|elastic-exclude)[^"']*["'][^>]*>.*?</\#(tag)>"#) {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        }
        if let re = regex(#"<\#(tag)\b[^>]*\bstyle=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>.*?</\#(tag)>"#) {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        }
    }
    // 块级边界 → 段落分隔
    if let re = regex(#"</(p|div|h[1-6]|li|blockquote|article|section|td|tr|pre)>"#) {
        s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "\n\n")
    }
    if let re = regex(#"<br\s*/?>"#) {
        s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "\n")
    }
    // 剩余标签全剥
    if let re = regex(#"<[^>]+>"#) {
        s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
    }
    let decoded = decodeHTMLEntities(s)

    // 段落清洗与过滤
    var paras: [String] = []
    for raw in decoded.components(separatedBy: "\n\n") {
        let t = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if t.isEmpty { continue }
        if t.count < 30 {
            // 短行多为菜单/分页/署名；带句末标点的完整短句保留
            let sentenceish = t.count >= 15 && endsSentence(t)
            if !sentenceish { continue }
        }
        // 全大写行基本是广告条/导航
        let letters = t.unicodeScalars.filter { ("a"..."z").contains($0) || ("A"..."Z").contains($0) }.count
        let upper = t.unicodeScalars.filter { ("A"..."Z").contains($0) }.count
        if letters > 12, upper * 100 / letters > 70 { continue }
        // 整段就是一个裸 URL（打印头部/引用残留），照抄进正文是杂物
        if looksLikeBareURL(t) { continue }
        // 常见站点口号/导航行（只对短行生效，避免误伤提到同词的正文联句）
        if t.count < 120, looksLikeChrome(t) { continue }
        // 联邦政府站横幅展开文案较长（可超 120），单独放宽门槛的特异词表
        if t.count < 200, looksLikeGovBanner(t) { continue }
        paras.append(t)
    }
    return paras.joined(separator: "\n\n")
}

let chromePhrases = [
    "subscribe", "newsletter", "sign in", "sign up", "log in", "login",
    "follow us", "share this", "cookie", "advertisement", "all rights reserved",
    "privacy policy", "terms of service", "skip to content",
]

func looksLikeChrome(_ t: String) -> Bool {
    let lower = t.lowercased()
    return chromePhrases.contains { lower.contains($0) }
}

/// 美式 .gov 站横幅样板句（usa-banner 展开文案 + lock 提示行）。词组足够特异，
/// 不会误伤正常正文；独立于 chromePhrases 以放宽 120 字符门槛（横幅长句 137 字符）。
let govBannerPhrases = [
    "official government organization",
    "secure .gov websites",
    "safely connected to the .gov website",
    "share sensitive information only on official, secure websites",
]

func looksLikeGovBanner(_ t: String) -> Bool {
    let lower = t.lowercased()
    return govBannerPhrases.contains { lower.contains($0) }
}

/// 整段是裸 URL（http(s):// 开头且中间无空白；t 已经过空白归一）。
func looksLikeBareURL(_ t: String) -> Bool {
    guard t.hasPrefix("http://") || t.hasPrefix("https://") else { return false }
    return !t.contains(" ")
}

func endsSentence(_ t: String) -> Bool {
    guard let last = t.last else { return false }
    return [".", "!", "?", "。", "”", "\""].contains(last)
}

/// 常见命名实体 + 数字实体解码（不追求完整 HTML5 表，覆盖正文高频）。
public func decodeHTMLEntities(_ s: String) -> String {
    let named: [(String, String)] = [
        ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""),
        ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " "), ("&mdash;", "—"),
        ("&ndash;", "–"), ("&hellip;", "…"), ("&lsquo;", "‘"), ("&rsquo;", "’"),
        ("&ldquo;", "“"), ("&rdquo;", "”"), ("&deg;", "°"), ("&eacute;", "é"),
        ("&egrave;", "è"), ("&agrave;", "à"), ("&ccedil;", "ç"), ("&uuml;", "ü"),
        ("&ouml;", "ö"),
    ]
    var out = s
    for (from, to) in named {
        out = out.replacingOccurrences(of: from, with: to)
    }
    // 数字实体（十进制 / 十六进制）
    func replaceNumeric(_ pattern: String, radix: Int) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return out }
        var result = ""
        var cursor = out.startIndex
        let ns = out as NSString
        for m in re.matches(in: out, range: NSRange(location: 0, length: ns.length)) {
            guard let mr = Range(m.range, in: out) else { continue }
            result += out[cursor..<mr.lowerBound]
            if m.numberOfRanges > 1,
               let digitsRange = Range(m.range(at: 1), in: out),
               let value = UInt32(out[digitsRange], radix: radix),
               let scalar = Unicode.Scalar(value) {
                result += String(Character(scalar))
            }
            cursor = mr.upperBound
        }
        result += out[cursor...]
        return result
    }
    out = replaceNumeric(#"&#(\d{1,7});"#, radix: 10)
    out = replaceNumeric(#"&#x([0-9a-fA-F]{1,6});"#, radix: 16)
    return out
}
