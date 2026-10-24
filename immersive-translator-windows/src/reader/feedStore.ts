/**
 * 资讯订阅（升级计划 B3）：订阅列表 + 条目缓存（localStorage，模式 B）。
 *
 * 极小 {url,title} 数组、作用域只在阅读室——刻意不用 sync_store_*（那是
 * A0 云同步实体会推服务端，违背 B3「不经服务端」）。结构照同目录
 * readerSettingsStore.ts：坏 JSON/坏形状回默认（[] / {}），逐行 asStr
 * 类型守卫丢脏行（防手改 localStorage 注入脏 URL——URL 进 Rust 命令前
 * 还有 scheme 门禁双保险），save 一律 try/catch ignore（配额满不崩）。
 */

import type { FeedEntryItem } from "../lib/feedCatalog";

const FEEDS_KEY = "immersive-translator-reader-feeds";
const FEED_ENTRIES_KEY = "immersive-translator-reader-feed-entries";

/** 一条订阅。 */
export interface FeedSubscription {
  /** crypto.randomUUID()。 */
  id: string;
  /** 归一化（trim+去尾部"/"）后的 feed XML 地址。 */
  url: string;
  /** 添加时自动取 feed channel title，用户可改。 */
  title: string;
  addedAt: number;
}

/** 单个订阅的条目缓存（避免每次挂载重拉；TTL 节流判断在 FeedTab）。 */
export interface FeedCacheEntry {
  entries: FeedEntryItem[];
  fetchedAt: number;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** id/url 是管线硬依赖（缓存键 / fetch 入参），缺任一只丢该行。 */
function asSubscription(row: unknown): FeedSubscription | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = asStr(r.id);
  const url = asStr(r.url);
  if (!id || !url) return null;
  return { id, url, title: asStr(r.title), addedAt: asNum(r.addedAt) };
}

/** title/link 是展示与点开链路的硬依赖，缺任一只丢该条。 */
function asEntryItem(row: unknown): FeedEntryItem | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const title = asStr(r.title);
  const link = asStr(r.link);
  if (!title || !link) return null;
  return {
    feedId: asStr(r.feedId),
    feedTitle: asStr(r.feedTitle),
    title,
    link,
    summary: asStr(r.summary),
    publishedAt:
      typeof r.publishedAt === "number" && Number.isFinite(r.publishedAt)
        ? r.publishedAt
        : null,
  };
}

/** 读取订阅列表；坏 JSON/非数组/逐行脏数据 → 丢脏行，整体坏回 []。 */
export function loadFeeds(): FeedSubscription[] {
  try {
    const raw = localStorage.getItem(FEEDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(asSubscription).filter((f): f is FeedSubscription => f !== null);
  } catch {
    return [];
  }
}

/** 整体写回订阅列表（写失败静默——下次读取回 [] 由用户重添，不崩主流程）。 */
export function saveFeeds(feeds: FeedSubscription[]): void {
  try {
    localStorage.setItem(FEEDS_KEY, JSON.stringify(feeds));
  } catch {
    /* ignore */
  }
}

/** 读取全部条目缓存（Record<feedId, FeedCacheEntry>）；坏 JSON/坏形状回 {}
 *  （= 全部源视为无缓存，挂载时自动重拉）。 */
export function loadFeedCache(): Record<string, FeedCacheEntry> {
  try {
    const raw = localStorage.getItem(FEED_ENTRIES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const src = parsed as Record<string, unknown>;
    const out: Record<string, FeedCacheEntry> = {};
    for (const [feedId, value] of Object.entries(src)) {
      if (!feedId || value === null || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (typeof v.fetchedAt !== "number" || !Number.isFinite(v.fetchedAt)) continue;
      if (!Array.isArray(v.entries)) continue;
      const entries = v.entries
        .map(asEntryItem)
        .filter((e): e is FeedEntryItem => e !== null);
      out[feedId] = { entries, fetchedAt: v.fetchedAt };
    }
    return out;
  } catch {
    return {};
  }
}

/** 整体写回条目缓存（Record<feedId, FeedCacheEntry>）。 */
export function saveFeedCache(cache: Record<string, FeedCacheEntry>): void {
  try {
    localStorage.setItem(FEED_ENTRIES_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}
