// @vitest-environment jsdom（DOMParser 需要）
import { describe, expect, it } from "vitest";
import {
  FEED_DUPLICATE_TEXT,
  FEED_EMPTY_TEXT,
  FEED_MERGE_LIMIT,
  FEED_PARSE_ERROR_TEXT,
  RECOMMENDED_FEEDS,
  feedInvokeErrorText,
  feedTitleOf,
  findFeedByUrl,
  mergeFeedEntries,
  normalizeFeedUrl,
  parseFeedXml,
  type FeedEntryItem,
} from "./feedCatalog";

// ---------- 内嵌 fixture ----------

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>NASA</title>
  <description>Official NASA Website</description>
  <item>
    <title>Artemis Moon Mission Update</title>
    <link>https://www.nasa.gov/artemis-update</link>
    <description>Latest progress on Artemis.</description>
    <pubDate>Fri, 23 Oct 2026 13:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Webb Telescope Sees a Star</title>
    <link>https://www.nasa.gov/webb-star</link>
    <pubDate>Thu, 22 Oct 2026 09:30:00 GMT</pubDate>
  </item>
  <item>
    <title>No Link In This Item</title>
    <pubDate>Wed, 21 Oct 2026 08:00:00 GMT</pubDate>
  </item>
  <item>
    <link>https://www.nasa.gov/untitled-item</link>
    <pubDate>Tue, 20 Oct 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>NIST News</title>
  <entry>
    <title>New Measurement Standard Published</title>
    <link rel="alternate" href="https://www.nist.gov/news/standard" />
    <summary>A new SI-traceable standard.</summary>
    <published>2026-10-20T10:00:00Z</published>
    <updated>2026-10-21T08:00:00Z</updated>
  </entry>
  <entry>
    <title>Chip-Scale Clock Demo</title>
    <link href="https://www.nist.gov/news/clock" />
    <id>urn:nist:clock</id>
  </entry>
</feed>`;

// &nbsp; 在严格 XML 里是未定义实体 → parsererror → 走 text/html 降级路径。
const ENTITY_FEED = `<rss version="2.0"><channel><title>Agency&nbsp;News</title>
<item><title>Recall&nbsp;Notice</title><link>https://example.gov/recall</link>
<description>Checklist&nbsp;updated.</description>
<pubDate>Fri, 23 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

const HTML_PAGE = `<!DOCTYPE html><html><head><title>Some News Site</title></head>
<body><h1>Today</h1><p>A plain webpage, not a feed.</p></body></html>`;

// ---------- parseFeedXml ----------

describe("parseFeedXml：RSS 2.0", () => {
  it("解析出条目字段（title/link/summary/pubDate→publishedAt）", () => {
    const entries = parseFeedXml(RSS_XML);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(2);
    const [first, second] = entries as FeedEntryItem[];
    expect(first.title).toBe("Artemis Moon Mission Update");
    expect(first.link).toBe("https://www.nasa.gov/artemis-update");
    expect(first.summary).toBe("Latest progress on Artemis.");
    expect(first.publishedAt).toBe(Date.parse("Fri, 23 Oct 2026 13:00:00 GMT"));
    // 溯源字段留空，由缓存写入方/mergeFeedEntries 补。
    expect(first.feedId).toBe("");
    expect(first.feedTitle).toBe("");
    expect(second.title).toBe("Webb Telescope Sees a Star");
    expect(second.summary).toBe(""); // 无 description 的条目省键不失败
    expect(second.publishedAt).toBe(Date.parse("Thu, 22 Oct 2026 09:30:00 GMT"));
  });

  it("缺 title 或 link 的条目只丢该行（不整份失败）", () => {
    const entries = parseFeedXml(RSS_XML) as FeedEntryItem[];
    const links = entries.map((e) => e.link);
    expect(links).not.toContain("https://www.nasa.gov/untitled-item");
    expect(entries.map((e) => e.title)).not.toContain("No Link In This Item");
  });
});

describe("parseFeedXml：Atom", () => {
  it("entry 取 href 链接与 published/updated，无日期条目 publishedAt=null", () => {
    const entries = parseFeedXml(ATOM_XML);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(2);
    const [first, second] = entries as FeedEntryItem[];
    expect(first.title).toBe("New Measurement Standard Published");
    expect(first.link).toBe("https://www.nist.gov/news/standard");
    expect(first.summary).toBe("A new SI-traceable standard.");
    expect(first.publishedAt).toBe(Date.parse("2026-10-20T10:00:00Z"));
    expect(second.link).toBe("https://www.nist.gov/news/clock");
    expect(second.publishedAt).toBeNull();
  });
});

describe("parseFeedXml：容错路径", () => {
  it("坏 XML（普通文本）→ null（覆盖「填错成普通网页」场景）", () => {
    expect(parseFeedXml("这不是订阅源，只是一段普通文本")).toBeNull();
  });

  it("合法 HTML 页面（无 channel/feed 标记）→ null", () => {
    expect(parseFeedXml(HTML_PAGE)).toBeNull();
  });

  it("空串/空白 → null", () => {
    expect(parseFeedXml("")).toBeNull();
    expect(parseFeedXml("   ")).toBeNull();
  });

  it("text/html 降级：&nbsp; 实体 feed 严格解析失败后仍能解析成功", () => {
    const entries = parseFeedXml(ENTITY_FEED);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    const [item] = entries as FeedEntryItem[];
    // &nbsp; 在 HTML 语义下是 U+00A0，条目内容不因实体丢失。
    expect(item.title).toContain("Recall");
    expect(item.title).toContain("\u00A0");
    expect(item.link).toBe("https://example.gov/recall");
  });

  it("合法 feed 0 条目 → []（≠ null：订阅可用但暂无文章）", () => {
    expect(parseFeedXml(`<rss version="2.0"><channel><title>Quiet</title></channel></rss>`)).toEqual([]);
    expect(parseFeedXml(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Quiet</title></feed>`)).toEqual([]);
  });
});

// ---------- feedTitleOf ----------

describe("feedTitleOf：feed 自报频道名", () => {
  it("RSS 取 channel/title", () => {
    const doc = new DOMParser().parseFromString(RSS_XML, "text/xml");
    expect(feedTitleOf(doc)).toBe("NASA");
  });

  it("Atom 取 feed/title", () => {
    const doc = new DOMParser().parseFromString(ATOM_XML, "text/xml");
    expect(feedTitleOf(doc)).toBe("NIST News");
  });

  it("取不到返回空串（调用方兜底命名）", () => {
    const doc = new DOMParser().parseFromString(`<rss version="2.0"><channel></channel></rss>`, "text/xml");
    expect(feedTitleOf(doc)).toBe("");
  });
});

// ---------- mergeFeedEntries ----------

function bareEntry(over: Partial<FeedEntryItem>): FeedEntryItem {
  return {
    feedId: "",
    feedTitle: "",
    title: "t",
    link: "https://example.gov/x",
    summary: "",
    publishedAt: null,
    ...over,
  };
}

describe("mergeFeedEntries：合并排序与溯源", () => {
  it("按 publishedAt 降序；缺省回退该源 fetchedAt；条目盖 feedId/feedTitle 溯源", () => {
    const merged = mergeFeedEntries([
      {
        feedId: "a",
        feedTitle: "NASA",
        fetchedAt: 1_000,
        entries: [
          bareEntry({ title: "dated-old", publishedAt: 500 }),
          bareEntry({ title: "no-date", publishedAt: null }), // 排序回退 fetchedAt=1000
        ],
      },
      {
        feedId: "b",
        feedTitle: "NIST",
        fetchedAt: 300,
        entries: [bareEntry({ title: "dated-mid", publishedAt: 900 })],
      },
    ]);
    expect(merged.map((e) => e.title)).toEqual(["no-date", "dated-mid", "dated-old"]);
    expect(merged[0]).toMatchObject({ feedId: "a", feedTitle: "NASA", publishedAt: null });
    expect(merged[1]).toMatchObject({ feedId: "b", feedTitle: "NIST" });
  });

  it("截前 FEED_MERGE_LIMIT（100）条且留下的是最新的", () => {
    const entries = Array.from({ length: 120 }, (_, i) =>
      bareEntry({ title: `a-${i}`, publishedAt: 2_000 + i }),
    );
    const entries2 = Array.from({ length: 120 }, (_, i) =>
      bareEntry({ title: `b-${i}`, publishedAt: 2_000 + i }),
    );
    const merged = mergeFeedEntries([
      { feedId: "a", feedTitle: "A", fetchedAt: 1, entries },
      { feedId: "b", feedTitle: "B", fetchedAt: 1, entries: entries2 },
    ]);
    expect(merged).toHaveLength(FEED_MERGE_LIMIT);
    expect(FEED_MERGE_LIMIT).toBe(100);
    // 最新的 100 条：时间 2_100..2_139（a/b 各半，两条同时间稳定排序）。
    const times = merged.map((e) => e.publishedAt);
    expect(Math.max(...(times as number[]))).toBe(2_000 + 119);
    expect(Math.min(...(times as number[]))).toBe(2_000 + 70);
  });

  it("空输入返回空数组", () => {
    expect(mergeFeedEntries([])).toEqual([]);
    expect(mergeFeedEntries([{ feedId: "a", feedTitle: "A", fetchedAt: 1, entries: [] }])).toEqual([]);
  });
});

// ---------- 重复检测 ----------

describe("订阅地址归一化与查重", () => {
  it("normalizeFeedUrl：trim + 去尾部斜杠", () => {
    expect(normalizeFeedUrl("  https://www.nasa.gov/news-release/feed/  ")).toBe(
      "https://www.nasa.gov/news-release/feed",
    );
    expect(normalizeFeedUrl("https://www.nist.gov/news-events/news/rss.xml")).toBe(
      "https://www.nist.gov/news-events/news/rss.xml",
    );
    expect(normalizeFeedUrl("")).toBe("");
    expect(normalizeFeedUrl("   ")).toBe("");
  });

  it("findFeedByUrl：尾斜杠/空白不同的同一地址命中，不同地址 null", () => {
    const feeds = [{ id: "1", url: "https://www.nasa.gov/news-release/feed" }];
    expect(findFeedByUrl(feeds, "https://www.nasa.gov/news-release/feed/")).toBe(feeds[0]);
    expect(findFeedByUrl(feeds, "  https://www.nasa.gov/news-release/feed ")).toBe(feeds[0]);
    expect(findFeedByUrl(feeds, "https://www.nist.gov/news-events/news/rss.xml")).toBeNull();
    expect(findFeedByUrl(feeds, "")).toBeNull();
  });
});

// ---------- 推荐源 ----------

describe("RECOMMENDED_FEEDS：推荐源清单", () => {
  it("至少 2 项、URL 全 https 且唯一、标题与中文描述非空", () => {
    expect(RECOMMENDED_FEEDS.length).toBeGreaterThanOrEqual(2);
    const urls = RECOMMENDED_FEEDS.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const f of RECOMMENDED_FEEDS) {
      expect(f.url.startsWith("https://")).toBe(true);
      expect(f.title.trim()).not.toBe("");
      expect(f.note.trim()).not.toBe("");
    }
  });
});

// ---------- 中文文案 ----------

describe("feed 错误文案（集中常量 + reject 直显）", () => {
  it("三个文案常量内容（可直接展示）", () => {
    expect(FEED_PARSE_ERROR_TEXT).toContain("无法解析这份订阅源");
    expect(FEED_PARSE_ERROR_TEXT).toContain("不是普通网页");
    expect(FEED_EMPTY_TEXT).toBe("订阅源暂时没有文章");
    expect(FEED_DUPLICATE_TEXT).toContain("这个订阅已在列表中");
  });

  it("feedInvokeErrorText：Error 取 message、裸字符串原样、其余 String 化", () => {
    expect(feedInvokeErrorText(new Error("订阅源返回了 404"))).toBe("订阅源返回了 404");
    expect(feedInvokeErrorText("这个订阅源需要登录或拒绝了访问（403）")).toBe(
      "这个订阅源需要登录或拒绝了访问（403）",
    );
    expect(feedInvokeErrorText({})).toBe("[object Object]");
    expect(feedInvokeErrorText(null)).toBe("null");
  });
});
