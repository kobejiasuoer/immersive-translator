// @vitest-environment jsdom
// 资讯订阅 tab（B3）组件测试：手添订阅全链（readerFetchFeed 成功 → feedStore
// 入库 → 订阅 chips 渲染）、重复/网络失败/解析失败中文文案、推荐勾选即添加
// 与已添加禁用、挂载节流自动刷新（过期才刷、TTL 内二次挂载零请求）、手动刷新、
// 单源失败聚合提示与重试、点开文章 readerFetchUrl 预览 → 「加入书架并开始阅读」
// onImport 参数 toEqual + feed_import 埋点、删除订阅、空态文案。
// mock 三件套：@tauri-apps/api/core（顶层拦 invoke，断言 telemetry_log_event
// 埋点）、../lib/tauriBridge（拦 readerFetchFeed）、../lib/webExtract（拦
// readerFetchUrl——漏它会在 jsdom 真发 invoke 悬挂）；feedCatalog/feedStore
// 用真实实现（DOMParser 解析与 localStorage 存取随组件一起被测到）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FeedTab } from "./FeedTab";
import { normalizeFeedUrl, RECOMMENDED_FEEDS, type FeedEntryItem } from "../lib/feedCatalog";
import {
  loadFeedCache,
  loadFeeds,
  saveFeedCache,
  saveFeeds,
  type FeedSubscription,
} from "./feedStore";

// vi.hoisted：mock 工厂与测试用同一组 vi.fn 实例（DiscoverTab.test.tsx 先例）
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readerFetchFeed: vi.fn(),
  readerFetchUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/tauriBridge", () => ({ readerFetchFeed: mocks.readerFetchFeed }));
vi.mock("../lib/webExtract", () => ({ readerFetchUrl: mocks.readerFetchUrl }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- fixture ----

/** 手添用源（带尾部斜杠：入库前应被 normalizeFeedUrl 归一化去掉）。 */
const FEED_URL = "https://example.nasa.gov/news-release/feed";
const FEED_URL_SLASH = `${FEED_URL}/`;

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>NASA News Releases</title>
    <link>https://www.nasa.gov/</link>
    <description>NASA news releases.</description>
    <item>
      <title>Artemis II Crew Named</title>
      <link>https://www.nasa.gov/artemis-ii</link>
      <description>Artemis II crew announcement detail.</description>
      <pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Webb Telescope Update</title>
      <link>https://www.nasa.gov/webb-update</link>
      <description>Webb telescope status.</description>
    </item>
  </channel>
</rss>`;

/** 推荐列表里实测可达的 NASA 源（RECOMMENDED_FEEDS 真实常量驱动，不硬编码顺序）。 */
const NASA_FEED =
  RECOMMENDED_FEEDS.find((r) => r.url.includes("nasa.gov")) ?? RECOMMENDED_FEEDS[0];
/** 添加链发起拉取时用的是归一化地址（去尾部斜杠）。 */
const NASA_FEED_NORM = normalizeFeedUrl(NASA_FEED.url);

function entry(overrides: Partial<FeedEntryItem> = {}): FeedEntryItem {
  return {
    // 溯源字段由 mergeFeedEntries 盖章；种子按 parseFeedXml 产物口径留空串。
    feedId: "",
    feedTitle: "",
    title: "Artemis II Crew Named",
    link: "https://www.nasa.gov/artemis-ii",
    summary: "Artemis II crew announcement detail.",
    publishedAt: Date.now() - 3 * 3_600_000,
    ...overrides,
  };
}

/** 种子一个已订阅源（含条目缓存；fetchedAt 缺省新鲜＝挂载不自动刷新）。
 *  追加语义：多次调用累计多个订阅（loadFeeds/loadFeedCache 真实读写）。 */
function seedFeed(
  sub: Partial<FeedSubscription> & Pick<FeedSubscription, "id">,
  fetchedAt = Date.now(),
  entries: FeedEntryItem[] | null = null,
) {
  const full: FeedSubscription = {
    id: sub.id,
    url: sub.url ?? FEED_URL,
    title: sub.title ?? "NASA News Releases",
    addedAt: sub.addedAt ?? Date.now() - 60_000,
  };
  saveFeeds([...loadFeeds().filter((f) => f.id !== full.id), full]);
  saveFeedCache({
    ...loadFeedCache(),
    [full.id]: {
      entries: entries ?? [entry()],
      fetchedAt,
    },
  });
  return full;
}

/** 定位推荐列表中标题匹配的行（NASA 等真实常量项，不依赖渲染顺序）。 */
function recoRow(m: Mount, title: string): HTMLElement {
  const row = [...m.container.querySelectorAll(".feed-reco-item")].find((el) =>
    textOf(el).includes(title),
  );
  if (!row) throw new Error(`reco row not found: ${title}`);
  return row as HTMLElement;
}

// ---- 挂载/交互帮手（DiscoverTab.test.tsx 同款手法） ----

/** onImport 测试桩：与 FeedTabProps.onImport 的 meta 形状做结构兼容（宽收窄传）。 */
type ImportMock = (
  (text: string, title?: string, meta?: { sourceType?: string; sourceUrl?: string; level?: string }) => void
) &
  ReturnType<typeof vi.fn>;

function importMock(): ImportMock {
  return vi.fn() as unknown as ImportMock;
}

interface Mount {
  root: Root;
  container: HTMLDivElement;
  unmount(): void;
}

function mountTab(onImport: ImportMock): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<FeedTab onImport={onImport} />));
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => {});
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function addButton(m: Mount): HTMLButtonElement {
  const btn = m.container.querySelector<HTMLButtonElement>(".feed-add-row button");
  if (!btn) throw new Error("add button not found");
  return btn;
}

function addInput(m: Mount): HTMLInputElement {
  const el = m.container.querySelector<HTMLInputElement>(".feed-add-input");
  if (!el) throw new Error("add input not found");
  return el;
}

/** jsdom 下改受控控件值（原生 setter + 事件，React 才会接收）。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 按文本找按钮（含子串匹配；推荐行/文章标题按钮用）。 */
function findButton(container: HTMLElement, includes: string, selector = "button"): HTMLButtonElement {
  const btn = [...container.querySelectorAll(selector)].find((b) => textOf(b).includes(includes));
  if (!btn) throw new Error(`button not found: ${includes}`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.readerFetchFeed.mockReset();
  mocks.readerFetchUrl.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FeedTab（资讯订阅 · 订阅管理）", () => {
  it("挂载即埋 feed_view（本地 telemetry_log_event）；无订阅显示空态与推荐区", async () => {
    const m = mountTab(importMock());
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("telemetry_log_event", {
      name: "feed_view",
      props: {},
    });
    const text = m.container.textContent ?? "";
    expect(text).toContain("先添加一个 RSS/Atom 订阅地址，或从下方推荐列表勾选几个");
    expect(text).toContain("推荐订阅 · 美国政府公开源");
    // 无订阅零网络。
    expect(mocks.readerFetchFeed).not.toHaveBeenCalled();
    m.unmount();
  });

  it("手添订阅：readerFetchFeed 成功 → feedStore 入库（URL 归一化）→ chips 与文章列表渲染", async () => {
    mocks.readerFetchFeed.mockResolvedValueOnce(RSS_XML);
    const m = mountTab(importMock());
    await flush();
    act(() => {
      setInputValue(addInput(m), FEED_URL_SLASH);
    });
    await act(async () => {
      addButton(m).click();
    });
    await flush();
    expect(mocks.readerFetchFeed).toHaveBeenCalledWith(FEED_URL);
    const text = m.container.textContent ?? "";
    // 频道名来自 feed 自报 channel title。
    expect(text).toContain("NASA News Releases");
    expect(m.container.querySelectorAll(".feed-sub-chip").length).toBe(1);
    expect(text).toContain("Artemis II Crew Named");
    expect(text).toContain("Webb Telescope Update");
    // 持久化：URL 已归一化（去尾部斜杠），条目缓存已写。
    const stored = loadFeeds();
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBe(FEED_URL);
    expect(stored[0].title).toBe("NASA News Releases");
    const cache = loadFeedCache();
    expect(cache[stored[0].id].entries.length).toBe(2);
    m.unmount();
  });

  it("手添失败（网络）：显示 Rust 中文 message + 重试按钮，不入库", async () => {
    mocks.readerFetchFeed.mockRejectedValueOnce(new Error("网络连接失败，请检查网络后重试"));
    const m = mountTab(importMock());
    await flush();
    act(() => {
      setInputValue(addInput(m), FEED_URL_SLASH);
    });
    await act(async () => {
      addButton(m).click();
    });
    await flush();
    expect(m.container.textContent).toContain("网络连接失败，请检查网络后重试");
    expect(findButton(m.container, "重试", ".feed-add-retry")).toBeTruthy();
    expect(loadFeeds()).toHaveLength(0);
    m.unmount();
  });

  it("手添解析失败（普通网页）：显示「无法解析这份订阅源」中文文案", async () => {
    mocks.readerFetchFeed.mockResolvedValueOnce(
      "<html><body><h1>Latest News</h1><p>Just a web page, not a feed.</p></body></html>",
    );
    const m = mountTab(importMock());
    await flush();
    act(() => {
      setInputValue(addInput(m), FEED_URL_SLASH);
    });
    await act(async () => {
      addButton(m).click();
    });
    await flush();
    expect(m.container.textContent).toContain("无法解析这份订阅源，请确认地址指向 RSS/Atom 订阅");
    expect(loadFeeds()).toHaveLength(0);
    m.unmount();
  });

  it("重复添加：FEED_DUPLICATE_TEXT，不再发 readerFetchFeed", async () => {
    seedFeed({ id: "feed-1" });
    const m = mountTab(importMock());
    await flush();
    act(() => {
      setInputValue(addInput(m), FEED_URL_SLASH);
    });
    await act(async () => {
      addButton(m).click();
    });
    await flush();
    expect(m.container.textContent).toContain("这个订阅已在列表中");
    expect(mocks.readerFetchFeed).not.toHaveBeenCalled();
    m.unmount();
  });

  it("推荐列表勾选即添加：点击 NASA「添加」→ 以推荐 URL 走同一添加链，按钮转「已添加」禁用", async () => {
    mocks.readerFetchFeed.mockResolvedValueOnce(RSS_XML);
    const m = mountTab(importMock());
    await flush();
    const recoBtn = recoRow(m, NASA_FEED.title).querySelector("button") as HTMLButtonElement;
    await act(async () => {
      recoBtn.click();
    });
    await flush();
    expect(mocks.readerFetchFeed).toHaveBeenCalledWith(NASA_FEED_NORM);
    // 添加后：订阅 chip 出现，同一推荐行变为已添加禁用。
    expect(m.container.querySelectorAll(".feed-sub-chip").length).toBe(1);
    const btn = recoRow(m, NASA_FEED.title).querySelector("button") as HTMLButtonElement;
    expect(textOf(btn)).toContain("已添加");
    expect(btn.disabled).toBe(true);
    m.unmount();
  });

  it("推荐列表已添加项：预置订阅后该行直接「已添加」禁用", async () => {
    seedFeed({ id: "feed-1", url: NASA_FEED.url });
    const m = mountTab(importMock());
    await flush();
    const btn = recoRow(m, NASA_FEED.title).querySelector("button") as HTMLButtonElement;
    expect(textOf(btn)).toContain("已添加");
    expect(btn.disabled).toBe(true);
    m.unmount();
  });

  it("删除订阅：点 chip ✕ → 订阅与缓存一起清掉，回到空态", async () => {
    seedFeed({ id: "feed-1" });
    const m = mountTab(importMock());
    await flush();
    expect(m.container.querySelectorAll(".feed-sub-chip").length).toBe(1);
    await act(async () => {
      (m.container.querySelector(".feed-sub-chip-x") as HTMLButtonElement).click();
    });
    await flush();
    expect(m.container.querySelectorAll(".feed-sub-chip").length).toBe(0);
    expect(loadFeeds()).toHaveLength(0);
    expect(loadFeedCache()["feed-1"]).toBeUndefined();
    expect(m.container.textContent).toContain("先添加一个 RSS/Atom 订阅地址");
    m.unmount();
  });
});

describe("FeedTab（资讯订阅 · 刷新策略）", () => {
  it("挂载对过期缓存自动刷新（fetchedAt 超 10 分钟），成功源写回新鲜缓存", async () => {
    const staleAt = Date.now() - 11 * 60_000;
    seedFeed({ id: "feed-1" }, staleAt);
    mocks.readerFetchFeed.mockResolvedValueOnce(RSS_XML);
    const m = mountTab(importMock());
    await flush();
    expect(mocks.readerFetchFeed).toHaveBeenCalledWith(FEED_URL);
    const cached = loadFeedCache()["feed-1"];
    expect(cached.fetchedAt).toBeGreaterThan(staleAt);
    expect(cached.entries.length).toBe(2);
    m.unmount();
  });

  it("TTL 内二次挂载不重复请求：新鲜缓存下两次挂载 readerFetchFeed 零调用；条目空显示 FEED_EMPTY_TEXT", async () => {
    // 种子：合法订阅但缓存条目为空（空态文案分支）。
    seedFeed({ id: "feed-1" }, Date.now(), []);
    const m = mountTab(importMock());
    await flush();
    expect(mocks.readerFetchFeed).not.toHaveBeenCalled();
    expect(m.container.textContent).toContain("订阅源暂时没有文章");
    m.unmount();
    const m2 = mountTab(importMock());
    await flush();
    expect(mocks.readerFetchFeed).not.toHaveBeenCalled();
    m2.unmount();
  });

  it("手动刷新按钮无条件全量：新鲜缓存下点「刷新」重新发起 readerFetchFeed", async () => {
    seedFeed({ id: "feed-1" }, Date.now());
    mocks.readerFetchFeed.mockResolvedValueOnce(RSS_XML);
    const m = mountTab(importMock());
    await flush();
    expect(mocks.readerFetchFeed).not.toHaveBeenCalled();
    await act(async () => {
      findButton(m.container, "刷新").click();
    });
    await flush();
    expect(mocks.readerFetchFeed).toHaveBeenCalledWith(FEED_URL);
    m.unmount();
  });

  it("单源失败不阻断其他源：成功源条目照常渲染 + 「1 个订阅刷新失败」+ 重试只补失败源", async () => {
    const staleAt = Date.now() - 11 * 60_000;
    const ok = seedFeed({ id: "feed-1", url: "https://ok.example.gov/rss" }, staleAt);
    seedFeed({ id: "feed-2", url: "https://bad.example.gov/rss", title: "Bad Feed" }, staleAt);
    mocks.readerFetchFeed.mockImplementation((u: string) =>
      u === ok.url ? Promise.resolve(RSS_XML) : Promise.reject(new Error("网络连接失败，请检查网络后重试")),
    );
    const m = mountTab(importMock());
    await flush();
    // 成功源条目仍在列表。
    expect(m.container.textContent).toContain("Artemis II Crew Named");
    // 失败聚合提示 + 重试入口。
    expect(m.container.textContent).toContain("1 个订阅刷新失败");
    await act(async () => {
      (m.container.querySelector(".feed-retry-failed") as HTMLButtonElement).click();
    });
    await flush();
    // 重试只针对失败源（第二次调用是 bad 源）。
    expect(mocks.readerFetchFeed).toHaveBeenCalledTimes(3);
    expect(mocks.readerFetchFeed).toHaveBeenLastCalledWith("https://bad.example.gov/rss");
    m.unmount();
  });
});

describe("FeedTab（资讯订阅 · 点开文章导入链）", () => {
  const FETCH_TEXT = "Artemis II will fly around the Moon. The crew of four is ready for the mission.";

  function fetchedArticle() {
    return {
      url: "https://www.nasa.gov/artemis-ii",
      host: "www.nasa.gov",
      title: "Artemis II Crew Named",
      text: FETCH_TEXT,
    };
  }

  it("全链：点文章标题 → readerFetchUrl → 预览卡渲染 → 「加入书架并开始阅读」→ onImport 参数与 feed_import 埋点", async () => {
    seedFeed({ id: "feed-1" });
    mocks.readerFetchUrl.mockResolvedValueOnce(fetchedArticle());
    const onImport = importMock();
    const m = mountTab(onImport);
    await flush();
    await act(async () => {
      findButton(m.container, "Artemis II Crew Named", "button.feed-item-title").click();
    });
    await flush();
    expect(mocks.readerFetchUrl).toHaveBeenCalledWith("https://www.nasa.gov/artemis-ii");
    const text = m.container.textContent ?? "";
    expect(text).toContain("www.nasa.gov");
    expect(text).toContain("Artemis II Crew Named");
    expect(text).toContain("词");
    // 确认导入：参数三件套（text/title/meta.sourceType=url+sourceUrl=文章 link+level）。
    await act(async () => {
      findButton(m.container, "加入书架并开始阅读").click();
    });
    await flush();
    expect(onImport).toHaveBeenCalledTimes(1);
    const [importedText, importedTitle, meta] = onImport.mock.calls[0] as [
      string,
      string,
      { sourceType?: string; sourceUrl?: string; level?: string },
    ];
    expect(importedText).toBe(FETCH_TEXT);
    expect(importedTitle).toBe("Artemis II Crew Named");
    expect(meta.sourceType).toBe("url");
    expect(meta.sourceUrl).toBe("https://www.nasa.gov/artemis-ii");
    expect(typeof meta.level).toBe("string");
    expect(meta.level).toBeTruthy();
    // 同帧埋 feed_import（本地轨，host 取自抓取结果）。
    expect(mocks.invoke).toHaveBeenCalledWith("telemetry_log_event", {
      name: "feed_import",
      props: { host: "www.nasa.gov" },
    });
    m.unmount();
  });

  it("正文截断：FetchedArticle.truncated=true → 预览卡显示「原文过长」；无标记不显示", async () => {
    seedFeed({ id: "feed-1" });
    mocks.readerFetchUrl.mockResolvedValueOnce({ ...fetchedArticle(), truncated: true });
    const m = mountTab(importMock());
    await flush();
    await act(async () => {
      findButton(m.container, "Artemis II Crew Named", "button.feed-item-title").click();
    });
    await flush();
    expect(mocks.readerFetchUrl).toHaveBeenCalledWith("https://www.nasa.gov/artemis-ii");
    expect(m.container.textContent ?? "").toContain("原文过长，仅导入前 50,000 字符");
    m.unmount();

    // 现状回归：Rust 未截断（无 truncated 字段）→ 不渲染提示。
    mocks.readerFetchUrl.mockResolvedValueOnce(fetchedArticle());
    const m2 = mountTab(importMock());
    await flush();
    await act(async () => {
      findButton(m2.container, "Artemis II Crew Named", "button.feed-item-title").click();
    });
    await flush();
    expect(m2.container.textContent ?? "").not.toContain("原文过长");
    m2.unmount();
  });

  it("文章抓取失败：intake-fail 显示 Rust 中文 message，「返回列表」可回到文章列表", async () => {
    seedFeed({ id: "feed-1" });
    mocks.readerFetchUrl.mockRejectedValueOnce(new Error("这个页面需要登录才能阅读"));
    const m = mountTab(importMock());
    await flush();
    await act(async () => {
      findButton(m.container, "Artemis II Crew Named", "button.feed-item-title").click();
    });
    await flush();
    const fail = m.container.querySelector(".intake-fail");
    expect(fail).not.toBeNull();
    expect(textOf(fail)).toContain("没能读取这篇文章");
    expect(textOf(fail)).toContain("这个页面需要登录才能阅读");
    await act(async () => {
      findButton(m.container, "返回列表").click();
    });
    await flush();
    expect(m.container.querySelector(".feed-list")).not.toBeNull();
    expect(m.container.textContent).toContain("Artemis II Crew Named");
    m.unmount();
  });
});
