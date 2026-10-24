// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadFeedCache,
  loadFeeds,
  saveFeedCache,
  saveFeeds,
  type FeedCacheEntry,
  type FeedSubscription,
} from "./feedStore";
import type { FeedEntryItem } from "../lib/feedCatalog";

// 蓝图定稿的存储键（与其他 immersive-translator-* 前缀一致）。
const FEEDS_KEY = "immersive-translator-reader-feeds";
const FEED_ENTRIES_KEY = "immersive-translator-reader-feed-entries";

const SUB: FeedSubscription = {
  id: "f-1",
  url: "https://www.nasa.gov/news-release/feed",
  title: "NASA",
  addedAt: 1_728_000_000_000,
};

const ENTRY: FeedEntryItem = {
  feedId: "f-1",
  feedTitle: "NASA",
  title: "Artemis Update",
  link: "https://www.nasa.gov/artemis-update",
  summary: "Latest progress.",
  publishedAt: 1_728_100_000_000,
};

function entryItem(over: Partial<FeedEntryItem>): FeedEntryItem {
  return { ...ENTRY, ...over };
}

beforeEach(() => {
  localStorage.clear();
});

describe("订阅列表 load/save（round-trip 与容错）", () => {
  it("空库返回 []", () => {
    expect(loadFeeds()).toEqual([]);
  });

  it("save → load round-trip", () => {
    saveFeeds([SUB]);
    expect(loadFeeds()).toEqual([SUB]);
  });

  it("坏 JSON 返回 []（不抛异常）", () => {
    localStorage.setItem(FEEDS_KEY, "{not json");
    expect(loadFeeds()).toEqual([]);
  });

  it("非数组形状返回 []", () => {
    localStorage.setItem(FEEDS_KEY, JSON.stringify({ id: "x", url: "https://x" }));
    expect(loadFeeds()).toEqual([]);
  });

  it("逐行脏数据只丢脏行（缺 id/url、非对象行），好行保留", () => {
    localStorage.setItem(
      FEEDS_KEY,
      JSON.stringify([
        SUB,
        { id: "no-url" }, // 缺 url：丢
        "just-a-string", // 非对象：丢
        null, // null：丢
        { id: "f-2", url: "https://www.nist.gov/news-events/news/rss.xml", addedAt: 5 }, // 缺 title：保留，title 回 ""
      ]),
    );
    const feeds = loadFeeds();
    expect(feeds).toHaveLength(2);
    expect(feeds[0]).toEqual(SUB);
    expect(feeds[1]).toEqual({
      id: "f-2",
      url: "https://www.nist.gov/news-events/news/rss.xml",
      title: "",
      addedAt: 5,
    });
  });

  it("落盘键名为 immersive-translator-reader-feeds", () => {
    saveFeeds([SUB]);
    expect(localStorage.getItem(FEEDS_KEY)).toBe(JSON.stringify([SUB]));
  });
});

describe("条目缓存 load/save（round-trip 与形状校验）", () => {
  it("空库返回 {}", () => {
    expect(loadFeedCache()).toEqual({});
  });

  it("save → load round-trip（条目字段全保真，含 publishedAt=null）", () => {
    const cache: Record<string, FeedCacheEntry> = {
      "f-1": {
        entries: [ENTRY, entryItem({ publishedAt: null, summary: "" })],
        fetchedAt: 1_728_200_000_000,
      },
    };
    saveFeedCache(cache);
    expect(loadFeedCache()).toEqual(cache);
  });

  it("坏 JSON 返回 {}", () => {
    localStorage.setItem(FEED_ENTRIES_KEY, "[oops");
    expect(loadFeedCache()).toEqual({});
  });

  it("顶层数组/null 形状返回 {}", () => {
    localStorage.setItem(FEED_ENTRIES_KEY, JSON.stringify([]));
    expect(loadFeedCache()).toEqual({});
    localStorage.setItem(FEED_ENTRIES_KEY, JSON.stringify(null));
    expect(loadFeedCache()).toEqual({});
  });

  it("单源形状坏（缺 fetchedAt / entries 非数组 / 值非对象）只丢该源", () => {
    localStorage.setItem(
      FEED_ENTRIES_KEY,
      JSON.stringify({
        "f-1": { entries: [], fetchedAt: 7 }, // 好
        "f-2": { entries: [] }, // 缺 fetchedAt：丢（TTL 判断的硬依赖）
        "f-3": { entries: "nope", fetchedAt: 8 }, // entries 非数组：丢
        "f-4": 42, // 值非对象：丢
        "f-5": { entries: [ENTRY], fetchedAt: "bad" }, // fetchedAt 非数：丢
      }),
    );
    const cache = loadFeedCache();
    expect(Object.keys(cache)).toEqual(["f-1"]);
    expect(cache["f-1"]).toEqual({ entries: [], fetchedAt: 7 });
  });

  it("条目行缺 title/link 只丢该条，同源好条目保留", () => {
    localStorage.setItem(
      FEED_ENTRIES_KEY,
      JSON.stringify({
        "f-1": {
          entries: [
            { ...ENTRY, link: "" }, // 缺 link：丢
            "garbage", // 非对象：丢
            ENTRY,
          ],
          fetchedAt: 9,
        },
      }),
    );
    const cache = loadFeedCache();
    expect(cache["f-1"]).toEqual({ entries: [ENTRY], fetchedAt: 9 });
  });

  it("落盘键名为 immersive-translator-reader-feed-entries", () => {
    const cache = { "f-1": { entries: [ENTRY], fetchedAt: 1 } };
    saveFeedCache(cache);
    // 以蓝图键名取回且值即所写内容（键名即持久化作用域契约）。
    expect(localStorage.getItem(FEED_ENTRIES_KEY)).toBe(JSON.stringify(cache));
  });
});
