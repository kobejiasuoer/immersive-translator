/**
 * 资讯订阅（升级计划 B3 §3/§6）：feed XML 解析 + 条目合并 + 重复检测
 * + 推荐源常量 + 中文错误文案。
 *
 * - parseFeedXml：原始 feed XML（readerFetchFeed 取回）→ FeedEntryItem[]。
 *   DOMParser 以 "text/xml" 严格解析（MIME 必须固定 text/xml——jsdom 对
 *   "application/rss+xml" 直接 throw，bookImport.ts:208 同款口径）；坏 XML
 *   不抛异常而出 <parsererror>（bookImport.ts:209 同款判定），此时降级
 *   "text/html" 宽松重解析一次（bookImport.ts:206-219 extractXhtmlText
 *   先例，容忍真实世界 feed 里 CDATA 外的 HTML 实体），仍不是 feed 形状
 *   返回 null；合法但 0 条目返回 []（两者语义不同：null=不是订阅，
 *   []=订阅暂无文章）。
 * - 省键容错照 discoverCatalog.parseBooksPage：缺 title 或 link 只丢该条
 *   不整份失败；summary 一律取 textContent 纯文本（绝不 innerHTML，XSS 防线）。
 * - 文案常量集中在此（对标 DISCOVER_BODY_ERROR_TEXT 落位 discoverCatalog），
 *   FeedTab 直接引用；feedInvokeErrorText 对 Rust reject 的中文 message
 *   直显，绝不引入网关错误映射（feed reject 是纯 String，非 AuthError 形状）。
 */

/** 文章列表的一条（合并后带订阅溯源：feedId/feedTitle 由 mergeFeedEntries
 *  或缓存写入方补齐，parseFeedXml 产物中为空串）。 */
export interface FeedEntryItem {
  /** 所属订阅 id（删除订阅时过滤、埋点溯源）。 */
  feedId: string;
  /** 所属订阅标题（列表小字前缀「源 · 标题」）。 */
  feedTitle: string;
  /** 文章标题（可点开预览）。 */
  title: string;
  /** 文章原文链接（readerFetchUrl 的入参）。 */
  link: string;
  /** 摘要纯文本（展示截 120 字）。 */
  summary: string;
  /** 发布时间戳；缺省/pubDate 不可解析为 null（相对时间展示省略）。 */
  publishedAt: number | null;
}

/** 推荐订阅源（静态常量不落存储，对标内置场景；均为实测可达的
 *  美国政府公有领域源，license 见各条注释）。 */
export interface RecommendedFeed {
  title: string;
  url: string;
  /** 一句中文描述（推荐区展示）。 */
  note: string;
}

/** mergeFeedEntries 的单源输入：一个订阅本轮渲染的条目 + 抓取时间。 */
export interface FeedEntriesBundle {
  feedId: string;
  feedTitle: string;
  /** 该源条目的抓取时间（publishedAt 缺省时的排序兜底）。 */
  fetchedAt: number;
  entries: FeedEntryItem[];
}

/** 合并后保留的最大条数（蓝图定稿：截前 100 条）。 */
export const FEED_MERGE_LIMIT = 100;

/** 无法按 feed 形状解析时的文案（覆盖「填错成普通网页」场景）。 */
export const FEED_PARSE_ERROR_TEXT =
  "无法解析这份订阅源，请确认地址指向 RSS/Atom 订阅（不是普通网页）";

/** 有订阅但条目全空。 */
export const FEED_EMPTY_TEXT = "订阅源暂时没有文章";

/** 手添/勾选已订阅的源。 */
export const FEED_DUPLICATE_TEXT = "这个订阅已在列表中";

/** invoke reject 文案：Rust 侧错误已是面向用户的中文 message，直接展示
 *  （e instanceof Error ? e.message : String(e)，UrlTab 同款口径），
 *  绝不引入 authErrorText 类网关错误映射（那是 AuthError 形状）。 */
export function feedInvokeErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 推荐订阅（2026-10-24 WebFetch 逐一实测可达且为 RSS 2.0；NIH 备选源
 *  实测 403 已剔除）。 */
export const RECOMMENDED_FEEDS: RecommendedFeed[] = [
  {
    title: "NASA News Releases",
    url: "https://www.nasa.gov/news-release/feed/",
    note: "NASA 官方新闻稿，航天任务报道，日更数条，英语难度适中",
    // license：NASA 材料为美国政府作品（17 U.S.C. §105），公有领域。
  },
  {
    title: "CDC Online Newsroom",
    url: "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
    note: "美国疾控中心新闻稿，公共健康主题，句子规范适合泛读",
    // license：CDC 原创内容为美国政府作品，公有领域（第三方署名供稿除外）。
  },
  {
    title: "NIST News",
    url: "https://www.nist.gov/news-events/news/rss.xml",
    note: "美国国家标准与技术研究院，科技/计量新闻，周更 2-4 条，适合精读",
    // license：商务部下属机构，美国政府作品，公有领域。
  },
];

/** 订阅地址归一化（重复检测口径）：trim + 去尾部 "/"。 */
export function normalizeFeedUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

/** 在订阅列表里按归一化 URL 查重（T 为 FeedSubscription 或其子集形状，
 *  结构化泛型避免与 reader/feedStore 形成循环依赖）。命中返回该条，否则 null。 */
export function findFeedByUrl<T extends { url: string }>(feeds: T[], url: string): T | null {
  const target = normalizeFeedUrl(url);
  if (!target) return null;
  return feeds.find((f) => normalizeFeedUrl(f.url) === target) ?? null;
}

function firstTagText(el: Element, tags: string[]): string {
  for (const tag of tags) {
    const found = el.getElementsByTagName(tag)[0];
    const text = found?.textContent?.trim() ?? "";
    if (text) return text;
  }
  return "";
}

/** 条目链接：RSS 的 <link> 是文本节点；Atom 的 <link rel=alternate> 是
 *  href 属性（多链接时 alternate 优先，其次任一带 href 的，最后文本节点）。
 *  text/html 降级路径下 <link> 是 void 元素（URL 文本散落为条目直接子
 *  文本节点），末段扫直接子文本里的 http(s) 链接兜底。 */
function entryLink(el: Element): string {
  const links = Array.from(el.getElementsByTagName("link"));
  const withHref = links.filter((l) => (l.getAttribute("href") ?? "").trim() !== "");
  const alternate =
    withHref.find((l) => l.getAttribute("rel") === "alternate") ?? withHref[0];
  if (alternate) return (alternate.getAttribute("href") ?? "").trim();
  const byText = links.find((l) => (l.textContent ?? "").trim() !== "");
  if (byText) return (byText.textContent ?? "").trim();
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== 3 /* Node.TEXT_NODE */) continue;
    const text = (node.textContent ?? "").trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
}

/** 条目发布时间：RSS pubDate / Atom published|updated，Date.parse 失效返回 null。 */
function entryPublishedAt(el: Element): number | null {
  const raw = firstTagText(el, ["pubDate", "pubdate", "published", "updated"]);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** 是否 feed 形状：RSS 2.0 有 <rss>/<channel>（RSS 1.0/RDF 只有 <channel>），
 *  Atom 有 <feed>。普通网页两种标记都没有（「重定向到 HTML 页」的门禁）。 */
function isFeedShaped(doc: Document): boolean {
  return (
    doc.getElementsByTagName("channel").length > 0 ||
    doc.getElementsByTagName("feed").length > 0 ||
    doc.getElementsByTagName("rss").length > 0
  );
}

/** 从文档抽条目（RSS <item> + Atom <entry> 并取）。缺 title 或 link 只丢
 *  该条；溯源字段（feedId/feedTitle）留空，由缓存写入方或 mergeFeedEntries 补。 */
function entriesFromDoc(doc: Document): FeedEntryItem[] | null {
  if (!isFeedShaped(doc)) return null;
  const items = [
    ...Array.from(doc.getElementsByTagName("item")),
    ...Array.from(doc.getElementsByTagName("entry")),
  ];
  const out: FeedEntryItem[] = [];
  for (const el of items) {
    const title = firstTagText(el, ["title"]);
    const link = entryLink(el);
    if (!title || !link) continue;
    out.push({
      feedId: "",
      feedTitle: "",
      title,
      link,
      summary: firstTagText(el, ["description", "summary", "content"]),
      publishedAt: entryPublishedAt(el),
    });
  }
  return out;
}

/**
 * 解析 feed 原始 XML：text/xml 严格解析 → <parsererror> 时降级 text/html
 * 宽松重解析一次（容忍 CDATA 外的 HTML 实体）→ 仍非 feed 形状返回 null。
 * 合法 feed 0 条目返回 []（≠ null）。非字符串/空白输入返回 null。
 */
export function parseFeedXml(xml: string): FeedEntryItem[] | null {
  if (typeof xml !== "string" || !xml.trim()) return null;
  const strict = new DOMParser().parseFromString(xml, "text/xml");
  if (strict.getElementsByTagName("parsererror").length === 0) {
    return entriesFromDoc(strict);
  }
  const loose = new DOMParser().parseFromString(xml, "text/html");
  return entriesFromDoc(loose);
}

/** feed 自报频道名：RSS channel/title 或 Atom feed/title；取不到返回空串
 *  （调用方以 host 等兜底命名）。 */
export function feedTitleOf(doc: Document): string {
  const channel = doc.getElementsByTagName("channel")[0];
  const channelTitle = channel?.getElementsByTagName("title")[0]?.textContent?.trim() ?? "";
  if (channelTitle) return channelTitle;
  const feed = doc.getElementsByTagName("feed")[0];
  return feed?.getElementsByTagName("title")[0]?.textContent?.trim() ?? "";
}

/**
 * 合并多源条目为一张列表：每条盖上所属订阅的 feedId/feedTitle 溯源，
 * 按 publishedAt 降序（缺省回退该源 fetchedAt），截前 FEED_MERGE_LIMIT 条。
 * 输入条目的溯源字段会被本源的 bundle 值覆盖（幂等，缓存与现拉条目同构）。
 */
export function mergeFeedEntries(perFeed: FeedEntriesBundle[]): FeedEntryItem[] {
  const stamped: Array<{ item: FeedEntryItem; time: number }> = [];
  for (const bundle of perFeed) {
    for (const entry of bundle.entries) {
      stamped.push({
        item: { ...entry, feedId: bundle.feedId, feedTitle: bundle.feedTitle },
        time: entry.publishedAt ?? bundle.fetchedAt,
      });
    }
  }
  stamped.sort((a, b) => b.time - a.time);
  return stamped.slice(0, FEED_MERGE_LIMIT).map((s) => s.item);
}
