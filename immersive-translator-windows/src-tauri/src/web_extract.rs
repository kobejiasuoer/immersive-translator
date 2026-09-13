//! 网页正文抓取（内容进水口 · 网页链接导入）。
//!
//! 不引入 DOM 解析器依赖：正则剥噪声块（script/style/nav…），块级标签转段落，
//! 实体解码，短行过滤。对新闻/博客/维基类页面足够用；复杂页面宁可失败
//! （正文 < 150 词报「可能是付费墙/需要登录」），由前端引导走「粘贴文本」退路。

use regex::Regex;
use serde::Serialize;
use std::time::Duration;

const MAX_HTML_BYTES: usize = 5_000_000;
const MIN_ARTICLE_WORDS: usize = 150;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchedArticle {
    pub url: String,
    pub host: String,
    pub title: String,
    pub text: String,
}

/// 预览/导入共用的正文提取（纯函数，可测）。
pub fn extract_article(final_url: &str, html: &str) -> Result<FetchedArticle, String> {
    extract_article_with_min(final_url, html, MIN_ARTICLE_WORDS)
}

/// 同上，但正文词数门槛可注入（测试小夹具用小门槛）。
pub fn extract_article_with_min(
    final_url: &str,
    html: &str,
    min_words: usize,
) -> Result<FetchedArticle, String> {
    let host = host_of(final_url);
    let title = extract_title(html).unwrap_or_else(|| host.clone());
    let text = extract_text(html);
    let words = text.split_whitespace().count();
    if words < min_words {
        return Err(format!(
            "只抓到 {words} 个词的正文——这个页面可能是付费墙、需要登录或反爬限制。可以在网页里全选复制正文，用「粘贴文本」导入，内容是一样的。"
        ));
    }
    Ok(FetchedArticle {
        url: final_url.to_string(),
        host,
        title,
        text,
    })
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_else(|| url.to_string())
}

fn extract_title(html: &str) -> Option<String> {
    let raw = match Regex::new(
        r#"(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#,
    )
    .ok()
    .and_then(|re| re.captures(html))
    .map(|c| c[1].to_string())
    .filter(|t| !t.trim().is_empty())
    {
        Some(t) => t,
        None => {
            let title = Regex::new(r#"(?is)<title[^>]*>(.*?)</title>"#).ok()?;
            let caps = title.captures(html)?;
            caps[1].to_string()
        }
    };
    let t = decode_entities(&raw).trim().to_string();
    if t.is_empty() {
        return None;
    }
    // "文章标题 - 站点名" / "文章标题 | 站点名" 截掉站点尾巴
    let cut = Regex::new(r"\s+[|–—-]\s+[^|–—-]{1,30}$").ok()?;
    Some(cut.replace(&t, "").trim().to_string())
}

/// 正文提取：只留 <body>，剥噪声块与标签，块级边界转段落，短行过滤。
pub fn extract_text(html: &str) -> String {
    // 只留 body（无 body 的片段直接全量处理）
    let body = Regex::new(r"(?is)<body\b[^>]*>(.*)</body>")
        .ok()
        .and_then(|re| re.captures(html))
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| html.to_string());

    let mut s = body;
    // 注释与噪声块（Rust regex 不支持反引引用，逐标签点名）
    s = strip_comments(&s);
    for tag in [
        "script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "header",
        "footer", "aside", "figure", "button", "select",
    ] {
        s = strip_block(&s, tag);
    }
    // 块级边界 → 段落分隔
    let block_end =
        Regex::new(r"(?i)</(p|div|h[1-6]|li|blockquote|article|section|td|tr|pre)>").unwrap();
    s = block_end.replace_all(&s, "\n\n").to_string();
    let br = Regex::new(r"(?i)<br\s*/?>").unwrap();
    s = br.replace_all(&s, "\n").to_string();
    // 剩余标签全剥
    let any_tag = Regex::new(r"(?s)<[^>]+>").unwrap();
    s = any_tag.replace_all(&s, " ").to_string();
    let s = decode_entities(&s);

    // 段落清洗与过滤
    let mut paras: Vec<String> = Vec::new();
    for raw in s.split("\n\n") {
        let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() {
            continue;
        }
        if t.chars().count() < 30 {
            // 短行多为菜单/分页/署名；带句末标点的完整短句保留
            let sentenceish = t.chars().count() >= 15 && ends_sentence(&t);
            if !sentenceish {
                continue;
            }
        }
        // 全大写行基本是广告条/导航
        let letters = t.chars().filter(|c| c.is_ascii_alphabetic()).count();
        let upper = t.chars().filter(|c| c.is_ascii_uppercase()).count();
        if letters > 12 && upper * 100 / letters > 70 {
            continue;
        }
        // 常见站点口号/导航行（只对短行生效，避免误伤提到同词的正文联句）
        if t.chars().count() < 120 && looks_like_chrome(&t) {
            continue;
        }
        paras.push(t);
    }
    paras.join("\n\n")
}

const CHROME_PHRASES: &[&str] = &[
    "subscribe",
    "newsletter",
    "sign in",
    "sign up",
    "log in",
    "login",
    "follow us",
    "share this",
    "cookie",
    "advertisement",
    "all rights reserved",
    "privacy policy",
    "terms of service",
    "skip to content",
];

fn looks_like_chrome(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    CHROME_PHRASES.iter().any(|p| lower.contains(p))
}

fn ends_sentence(t: &str) -> bool {
    t.ends_with('.')
        || t.ends_with('!')
        || t.ends_with('?')
        || t.ends_with('。')
        || t.ends_with('”')
        || t.ends_with('"')
}

fn strip_comments(s: &str) -> String {
    let re = Regex::new(r"(?s)<!--.*?-->").unwrap();
    re.replace_all(s, "").to_string()
}

fn strip_block(s: &str, tag: &str) -> String {
    let pattern = format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>");
    match Regex::new(&pattern) {
        Ok(re) => re.replace_all(s, "").to_string(),
        Err(_) => s.to_string(),
    }
}

/// 常见命名实体 + 数字实体解码（不追求完整 HTML5 表，覆盖正文高频）。
pub fn decode_entities(s: &str) -> String {
    let named = [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
        ("&mdash;", "—"),
        ("&ndash;", "–"),
        ("&hellip;", "…"),
        ("&lsquo;", "‘"),
        ("&rsquo;", "’"),
        ("&ldquo;", "“"),
        ("&rdquo;", "”"),
        ("&deg;", "°"),
        ("&eacute;", "é"),
        ("&egrave;", "è"),
        ("&agrave;", "à"),
        ("&ccedil;", "ç"),
        ("&uuml;", "ü"),
        ("&ouml;", "ö"),
    ];
    let mut out = s.to_string();
    for (from, to) in named {
        out = out.replace(from, to);
    }
    // 数字实体（十进制 / 十六进制）
    let dec = Regex::new(r"&#(\d{1,7});").unwrap();
    out = dec
        .replace_all(&out, |c: &regex::Captures| {
            u32::from_str_radix(&c[1], 10)
                .ok()
                .and_then(char::from_u32)
                .map(String::from)
                .unwrap_or_default()
        })
        .to_string();
    let hex = Regex::new(r"(?i)&#x([0-9a-f]{1,6});").unwrap();
    hex.replace_all(&out, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16)
            .ok()
            .and_then(char::from_u32)
            .map(String::from)
            .unwrap_or_default()
    })
    .to_string()
}

#[tauri::command]
pub async fn reader_fetch_url(url: String) -> Result<FetchedArticle, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "这不是有效的网址".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("只支持 http/https 链接".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ",
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("网络初始化失败: {e}"))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("打不开这个链接（{e}）——检查网络或地址后重试"))?;
    let final_url = resp.url().to_string();
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(
            "这个页面需要登录或拒绝了程序访问。可以在网页里全选复制正文，用「粘贴文本」导入。"
                .into(),
        );
    }
    if !status.is_success() {
        return Err(format!("网站返回了 {status}，抓取失败"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("application/pdf") {
        return Err("这是一份 PDF——PDF 导入在计划里，暂时请先另存文本后用「粘贴文本」。".into());
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取页面失败: {e}"))?;
    if body.len() > MAX_HTML_BYTES {
        return Err("页面太大，超出处理范围".into());
    }
    let article = if content_type.contains("text/html") {
        extract_article(&final_url, &body)?
    } else {
        // text/plain 或其他：按纯文本处理，仍然做长度门禁
        let text = body
            .lines()
            .map(|l| l.trim())
            .collect::<Vec<_>>()
            .join("\n\n");
        let words = text.split_whitespace().count();
        if words < MIN_ARTICLE_WORDS {
            return Err("这个地址没有可读的文章正文。".into());
        }
        let host = host_of(&final_url);
        FetchedArticle {
            url: final_url,
            host,
            title: String::new(),
            text,
        }
    };
    Ok(article)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_paragraphs_and_strips_noise() {
        let long1 = "Reading is the process of taking in the sense or meaning of letters, symbols, or sentence structure, especially by the eye or by touch. For educators and researchers, reading is a multifaceted process involving such areas as word recognition, orthography, alphabetics, phonics, and phonemic awareness.";
        let long2 = "Reading is typically an individual activity done silently, although on occasion a person reads out loud for other listeners; the act of reading aloud for one's own use is known as subvocalization. Against this background, the reading comprehension of students is a major focus of modern schooling.";
        let html = format!(
            r#"<html><head><title>Reading - Wikipedia</title>
            <style>.nav{{display:none}}</style></head>
            <body>
            <nav><a>Home</a><a>Menu</a><a>About us</a></nav>
            <script>var x = 1;</script>
            <h1>Reading</h1>
            <p>{long1}</p>
            <p>{long2}</p>
            </body></html>"#
        );
        let article =
            extract_article_with_min("https://en.wikipedia.org/wiki/Reading", &html, 20).unwrap();
        assert_eq!(article.host, "en.wikipedia.org");
        assert_eq!(article.title, "Reading");
        assert!(article.text.contains("Reading is the process"));
        assert!(!article.text.contains("Home"));
        assert!(!article.text.contains("var x"));
        assert!(article.text.contains("subvocalization"));
    }

    #[test]
    fn og_title_wins_and_short_lines_are_dropped() {
        let long1 = "This first paragraph is long enough to be kept as the article body because real prose rarely comes in tiny fragments, and the paragraph filter is tuned to keep meaningful sentences.";
        let long2 = "Second paragraph also carries enough words to survive the paragraph filter that we apply here, so both of them should appear in the extracted plain text output.";
        let html = format!(
            r#"<html><head><meta property="og:title" content="真实标题 | 某站点"><title>wrong</title></head>
        <body><p>Share</p><p>Subscribe to our newsletter for updates</p>
        <p>{long1}</p>
        <p>{long2}</p></body></html>"#
        );
        let article = extract_article_with_min("https://example.com/a", &html, 20).unwrap();
        assert_eq!(article.title, "真实标题");
        assert!(!article.text.contains("Subscribe"));
        assert!(article.text.contains("first paragraph"));
    }

    #[test]
    fn tiny_body_is_rejected_as_paywall_like() {
        let html = "<html><body><p>Subscribe to continue reading.</p></body></html>";
        let err = extract_article("https://example.com/p", html).unwrap_err();
        assert!(err.contains("付费墙"));
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(
            decode_entities("A &amp; B &quot;q&quot; &#8212; &#x27;"),
            "A & B \"q\" — '"
        );
    }
}
