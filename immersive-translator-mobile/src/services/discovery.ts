import type { Article } from "../core/types";
import { activeRepository, getState, replaceSyncedState } from "../store";
import { cloudState, httpRequest } from "./cloud";
import { parseBooksPage, formatFileSize, type DiscoverBook, type DiscoverPage } from "../../../immersive-translator-windows/src/lib/discoverCatalog";
import { feedTitleOf, parseFeedXml, RECOMMENDED_FEEDS, type FeedEntryItem } from "../../../immersive-translator-windows/src/lib/feedCatalog";
import { splitParagraphs } from "../../../immersive-translator-windows/src/core/sentenceSplit";
import type { EpubBook } from "../../../immersive-translator-windows/src/core/bookImport";

export { formatFileSize, RECOMMENDED_FEEDS };
export type { DiscoverBook, DiscoverPage, FeedEntryItem };
export interface BookPreview { catalog: DiscoverBook; book: EpubBook; sourceOrigin: string; bookId: string }
export interface FeedSubscription { id: string; url: string; title: string; addedAt: number }
export interface FeedPreview { subscription: FeedSubscription; entries: FeedEntryItem[]; fetchedAt: number }
export interface EntryPreview { title: string; text: string; sourceUrl: string; feedTitle: string; summaryOnly: boolean }
const FEEDS = "mobile.feed-subscriptions";
const MAX_EPUB_BYTES = 32 * 1024 * 1024;
const MAX_FEED_CHARS = 4 * 1024 * 1024;

export function discoveryError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "操作已取消，未加入书架";
  return error instanceof Error ? error.message : String(error);
}
function context() {
  const repository = activeRepository();
  return { repository, check() { if (activeRepository() !== repository) throw new DOMException("账号资料已切换", "AbortError"); } };
}
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("操作已取消", "AbortError"); }
function responseError(status: number, operation: string): Error {
  if (status === 429) return new Error("请求过于频繁，请稍后再试");
  if (status === 404) return new Error(`${operation}暂时不可用（404）`);
  return new Error(`${operation}失败（${status}），请稍后重试`);
}
async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
export function canonicalContentUrl(raw: string, base?: string): string {
  const url = new URL(raw.trim(), base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("请输入不含账号密码的公开 HTTP(S) 地址");
  url.hash = "";
  return url.toString();
}
export async function listBooks(query: string, page = 1, signal?: AbortSignal): Promise<DiscoverPage> {
  const url = new URL("/v1/books", cloudState().baseUrl);
  url.search = new URLSearchParams({ q: query.trim(), page: String(page), perPage: "12" }).toString();
  const response = await httpRequest(url.toString(), "GET", undefined, {}, signal);
  if (response.status !== 200) throw responseError(response.status, "书库加载");
  const result = parseBooksPage(response.body);
  if (!result || result.page < 1 || result.perPage < 1 || result.total < 0) throw new Error("书库响应格式异常，请稍后重试");
  return result;
}
export async function previewBook(catalog: DiscoverBook, signal?: AbortSignal): Promise<BookPreview> {
  const ctx = context(), sourceOrigin = new URL(cloudState().baseUrl).origin;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(catalog.id)) throw new Error("书目编号异常");
  if (!Number.isSafeInteger(catalog.fileSizeBytes) || catalog.fileSizeBytes <= 0 || catalog.fileSizeBytes > MAX_EPUB_BYTES) throw new Error("这本书超出手机 32MB 导入上限，请在 Windows 导入后接力");
  if (!/^[a-f0-9]{64}$/i.test(catalog.sha256)) throw new Error("书目缺少有效的文件校验信息，暂不导入");
  const response = await httpRequest(new URL(`/v1/books/${catalog.id}/download`, sourceOrigin).toString(), "GET", undefined, {}, signal, false, "base64");
  if (response.status !== 200) throw responseError(response.status, "电子书下载");
  ctx.check(); checkSignal(signal);
  if (response.body.length > Math.ceil(MAX_EPUB_BYTES / 3) * 4 + 4) throw new Error("下载文件超过手机导入上限");
  const raw = atob(response.body), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (bytes.byteLength !== catalog.fileSizeBytes) throw new Error("下载文件长度与书目不一致，请重新下载");
  if (await hash(bytes) !== catalog.sha256.toLowerCase()) throw new Error("下载校验未通过，未导入损坏内容，请重新下载");
  const { parseEpub } = await import("../../../immersive-translator-windows/src/core/bookImport");
  const book = await parseEpub(new File([bytes], `${catalog.id}.epub`, { type: "application/epub+zip" }));
  ctx.check(); checkSignal(signal);
  const bookId = `book-${(await hash(`${sourceOrigin}/${catalog.id}`)).slice(0, 24)}`;
  return { catalog, book, sourceOrigin, bookId };
}
function sentenceContent(text: string): Pick<Article, "sentences" | "paragraphStarts"> {
  const sentences: Article["sentences"] = [], paragraphStarts: number[] = [];
  for (const paragraph of splitParagraphs(text)) {
    paragraphStarts.push(sentences.length);
    for (const en of paragraph.sentences) sentences.push({ idx: sentences.length, paragraphIdx: paragraph.paragraphIdx, en, zh: null, zhState: "empty" });
  }
  if (!sentences.length) throw new Error("没有可保存的正文，未创建空文章");
  return { sentences, paragraphStarts };
}
export function articlesFromBook(preview: BookPreview, now = Date.now()): Article[] {
  return preview.book.chapters.map((chapter, index) => ({
    id: `${preview.bookId}-chapter-${index + 1}`, bookId: preview.bookId, title: `${preview.book.title} · ${chapter.title}`, titleCn: "",
    ...sentenceContent(chapter.text), sourceType: "book", sourceUrl: preview.catalog.sourceUrl,
    bookTitle: preview.book.title, chapterTitle: chapter.title, chapterIndex: index, totalChapters: preview.book.chapters.length,
    author: preview.book.author || preview.catalog.author, sourceCatalogId: preview.catalog.id, catalogOrigin: preview.sourceOrigin,
    licenseName: preview.catalog.licenseName, licenseUrl: preview.catalog.licenseUrl,
    contentRevision: preview.catalog.sha256, createdAt: now, updatedAt: now,
  }));
}
export async function importBook(preview: BookPreview): Promise<{ firstArticleId: string; added: number }> {
  const ctx = context(), articles = articlesFromBook(preview); let added = 0;
  await replaceSyncedState(current => {
    ctx.check();
    const prior = current.articles.filter(article => article.bookId === preview.bookId);
    if (prior.some(article => article.contentRevision !== preview.catalog.sha256)) throw new Error("书架里已有这本书的其他版本，请先保留或移除旧版本后再导入；未混合章节");
    const existing = new Set(current.articles.map(article => article.id)), incoming = articles.filter(article => !existing.has(article.id));
    added = incoming.length; return { articles: [...incoming, ...current.articles] };
  });
  ctx.check(); window.dispatchEvent(new Event("mobile-state-change"));
  return { firstArticleId: articles[0].id, added };
}
export async function listSubscriptions(): Promise<FeedSubscription[]> {
  const ctx = context(), records = await ctx.repository.list<FeedSubscription>(FEEDS); ctx.check();
  return records.filter(record => !record.deleted && record.payload).map(record => record.payload!).sort((a, b) => a.addedAt - b.addedAt);
}
export async function previewFeed(rawUrl: string, signal?: AbortSignal): Promise<FeedPreview> {
  const url = canonicalContentUrl(rawUrl), response = await httpRequest(url, "GET", undefined, {}, signal, true);
  if (response.status !== 200) throw responseError(response.status, "订阅源读取");
  if (response.body.length > MAX_FEED_CHARS) throw new Error("订阅源过大，请使用更精简的 RSS 地址");
  const entries = parseFeedXml(response.body); if (!entries) throw new Error("这不是可识别的 RSS / Atom 订阅，请检查地址");
  const finalUrl = canonicalContentUrl(response.url || url);
  const doc = new DOMParser().parseFromString(response.body, "text/xml");
  const title = feedTitleOf(doc) || new URL(finalUrl).hostname, id = `feed-${(await hash(finalUrl.replace(/\/+$/, ""))).slice(0, 24)}`;
  const seen = new Set<string>();
  const safe = entries.flatMap(entry => {
    try {
      const link = canonicalContentUrl(entry.link, finalUrl); if (seen.has(link)) return []; seen.add(link);
      return [{ ...entry, link, title: plainText(entry.title), summary: plainText(entry.summary), feedId: id, feedTitle: title }];
    } catch { return []; }
  }).slice(0, 100);
  checkSignal(signal);
  return { subscription: { id, url: finalUrl, title, addedAt: Date.now() }, entries: safe, fetchedAt: Date.now() };
}
export async function saveSubscription(preview: FeedPreview): Promise<void> {
  const ctx = context(), records = await ctx.repository.list<FeedSubscription>(FEEDS); ctx.check();
  const existing = records.find(record => !record.deleted && record.payload?.url.replace(/\/+$/, "") === preview.subscription.url.replace(/\/+$/, ""));
  if (existing) return;
  const previous = records.find(record => record.id === preview.subscription.id);
  await replaceSyncedState(() => { ctx.check(); return {}; }, { records: [{ collection: FEEDS, id: preview.subscription.id, payload: preview.subscription, expectedVersion: previous?.version ?? 0 }] }); ctx.check();
}
export async function removeSubscription(id: string): Promise<void> {
  const ctx = context(), record = await ctx.repository.get<FeedSubscription>(FEEDS, id); ctx.check();
  if (!record || record.deleted) return;
  await replaceSyncedState(() => { ctx.check(); return {}; }, { records: [{ collection: FEEDS, id, payload: null, deleted: true, expectedVersion: record.version }] }); ctx.check();
}
function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript").forEach(el => el.remove());
  return doc.body.textContent?.replace(/[ \t]+/g, " ").trim() || "";
}
export async function previewFeedEntry(entry: FeedEntryItem, summaryOnly = false, signal?: AbortSignal): Promise<EntryPreview> {
  if (summaryOnly) {
    if (!entry.summary.trim()) throw new Error("这篇文章没有可用摘要");
    return { title: entry.title, text: entry.summary, sourceUrl: canonicalContentUrl(entry.link), feedTitle: entry.feedTitle, summaryOnly: true };
  }
  const response = await httpRequest(canonicalContentUrl(entry.link), "GET", undefined, {}, signal, true);
  if (response.status !== 200) throw responseError(response.status, "文章读取");
  const doc = new DOMParser().parseFromString(response.body, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer,aside,form,noscript").forEach(el => el.remove());
  const root = doc.querySelector("article,main,[role=main]") || doc.body;
  root.querySelectorAll("p,h1,h2,h3,br,li").forEach(el => el.insertAdjacentText("afterend", "\n\n"));
  const text = root.textContent?.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() || "";
  if (text.length < 80) throw new Error("网页没有足够正文，可能需要登录或动态加载；可以选择只保存订阅摘要");
  if (text.length > 300000) throw new Error("文章超过手机单篇上限，未截断原文；请复制所需内容分段导入");
  checkSignal(signal);
  return { title: entry.title, text, sourceUrl: canonicalContentUrl(response.url || entry.link), feedTitle: entry.feedTitle, summaryOnly: false };
}
export async function importFeedEntry(preview: EntryPreview): Promise<{ articleId: string; duplicate: boolean }> {
  const ctx = context(), sourceUrl = canonicalContentUrl(preview.sourceUrl), id = `rss-${(await hash(sourceUrl)).slice(0, 24)}`, now = Date.now();
  ctx.check(); let duplicate = false, articleId = id;
  const article: Article = { id, title: preview.title, titleCn: "", ...sentenceContent(preview.text), sourceType: "rss", sourceUrl, feedTitle: preview.feedTitle, summaryOnly: preview.summaryOnly, contentRevision: await hash(preview.text), createdAt: now, updatedAt: now };
  await replaceSyncedState(current => {
    ctx.check();
    const existing = current.articles.find(item => { try { return item.id === id || !!item.sourceUrl && canonicalContentUrl(item.sourceUrl) === sourceUrl; } catch { return false; } });
    if (existing) { duplicate = true; articleId = existing.id; return {}; }
    return { articles: [article, ...current.articles] };
  });
  ctx.check(); window.dispatchEvent(new Event("mobile-state-change"));
  return { articleId, duplicate };
}
export function savedBook(preview: BookPreview): boolean { return getState().articles.some(article => article.bookId === preview.bookId); }
