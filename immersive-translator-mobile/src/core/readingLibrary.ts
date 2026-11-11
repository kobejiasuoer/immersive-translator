import type { Article } from "./types";
import { splitParagraphs } from "../../../immersive-translator-windows/src/core/sentenceSplit";

export function importedTitle(title: string, text: string): string {
  return title.trim() || text.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 100) || "我的阅读";
}

export function splitReadingText(text: string): Pick<Article, "sentences" | "paragraphStarts"> {
  const sentences: Article["sentences"] = [], paragraphStarts: number[] = [];
  for (const paragraph of splitParagraphs(text)) {
    paragraphStarts.push(sentences.length);
    for (const en of paragraph.sentences) sentences.push({ idx: sentences.length, paragraphIdx: paragraph.paragraphIdx, en, zh: null, zhState: "empty" });
  }
  return { sentences, paragraphStarts };
}

/** Ignore only recognizable site chrome, never arbitrary mentions of HTTPS in a story. */
const WEB_NOISE = [
  /^An official website of the United States government\.?$/i,
  /^Here(?:’|')s how you know\.?$/i,
  /^Official websites use \.gov\.?$/i,
  /^A \.gov website belongs to an official government organization in the United States\.?$/i,
  /^Secure \.gov websites use HTTPS\.?$/i,
  /^A lock\s*\([^)]*\)\s*or https:\/\/ means you(?:’|')ve safely connected to the \.gov website\.?$/i,
  /^Share sensitive information only on official, secure websites\.?$/i,
  /^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\s*)?Estimated\s*Read(?:ing)?\s*Time\s*:?\s*(?:\d+(?:\.\d+)?\s*)?(?:min(?:ute)?s?)?\.?$/i,
  /^(?:Estimated\s*)?(?:Read(?:ing)?\s*Time)\s*:?\s*\d+\s*(?:min(?:ute)?s?)?\.?$/i,
  /^\d+\s*(?:min(?:ute)?s?)\s*read\.?$/i,
  /^(?:Skip to (?:main )?content|Back to top|Print this page)\.?$/i,
  /^###$/, // A standalone press-release end marker; inline mentions remain prose.
];
function normalizedBlock(text: string): string { return text.replace(/\s+/g, " ").trim(); }
export function isWebNoise(text: string): boolean { return WEB_NOISE.some(pattern => pattern.test(normalizedBlock(text))); }
const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "LI", "BLOCKQUOTE", "SECTION", "ARTICLE", "MAIN", "FIGCAPTION", "TR"]);
function proseText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.tagName === "BR") return "\n";
  const text = Array.from(element.childNodes).map(proseText).join("");
  if (BLOCKS.has(element.tagName)) return isWebNoise(text) ? "\n\n" : `\n\n${text}\n\n`;
  return text;
}
export function extractReadingPage(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const originalHeading = doc.querySelector("article h1,main h1,[role=main] h1")?.textContent?.trim();
  const pageTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  // Some sites fill the minute count with JS, leaving "Estimated Read Time min" in HTML.
  // Remove its paired metadata date, while dates in normal paragraphs remain untouched.
  doc.querySelectorAll(".read-time").forEach(el => {
    if (!isWebNoise(el.textContent || "")) return;
    el.parentElement?.querySelector(".display-date")?.remove();
    el.remove();
  });
  doc.querySelectorAll("script,style,nav,header,footer,aside,form,noscript,template,svg,iframe,[hidden],[aria-hidden=true],.usa-banner,.usa-banner__inner,.primary-office,.press-release-buttons,.linked-topic-tags,[class*=cookie-banner],[class*=share-buttons]").forEach(el => el.remove());
  const candidates = Array.from(doc.querySelectorAll("article,main,[role=main]"));
  // Nested article beats a surrounding main containing a site banner or related cards.
  const root = candidates.filter(el => el.tagName === "ARTICLE").sort((a, b) => (b.textContent?.length || 0) - (a.textContent?.length || 0))[0] || candidates[0] || doc.body;
  const title = root.querySelector("h1")?.textContent?.trim() || pageTitle || originalHeading || doc.title.trim();
  root.querySelectorAll("h1").forEach(el => { if (normalizedBlock(el.textContent || "") === normalizedBlock(title)) el.remove(); });
  const text = proseText(root).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").split(/\n\s*\n/).map(block => block.trim()).filter(block => block && !isWebNoise(block)).join("\n\n");
  return { title, text };
}

/** Same text can arrive via pasted prose, RSS, or a desktop. Titles and URLs are not identities. */
export function readingContentKey(article: Pick<Article, "sentences">): string {
  return article.sentences.map(s => s.en.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
}
export function chapterIndexOf(article: Article): number {
  const value = Number(article.chapterIndex ?? article.chapterIdx ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
type Json = Record<string, unknown>;
function object(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
/** Older imports retained the original book heading in their chapter title after a rename. */
function legacyBookTitle(article: Article): string {
  const suffix = ` · ${text(article.chapterTitle)}`;
  return text(article.chapterTitle) && article.title.endsWith(suffix) ? article.title.slice(0, -suffix.length).trim() : "";
}
export function sourceBookTitleOf(article: Article): string {
  return text(article.sourceBookTitle) || legacyBookTitle(article) || text(article.bookTitle);
}
export function matchesCuratedBook(article: Article, item: { id: string; title: string }): boolean {
  if (!article.bookId) return false;
  if (article.curatedBookId) return article.curatedBookId === item.id;
  const title = item.title.trim().toLocaleLowerCase();
  return [article.sourceCatalogTitle, sourceBookTitleOf(article)].some(value => text(value).toLocaleLowerCase() === title);
}
export function hydrateBookMetadata(article: Article, books: readonly Json[]): Article {
  const book = books.find(b => b.id === article.bookId || Array.isArray(b.chapters) && b.chapters.some(c => object(c) && (c.articleId === article.id || c.id === article.id)));
  const chapter = book && Array.isArray(book.chapters) ? book.chapters.find(c => object(c) && (c.articleId === article.id || c.id === article.id)) as Json | undefined : undefined;
  const listedIndex = book && Array.isArray(book.chapters) ? book.chapters.findIndex(c => c === chapter) : -1;
  return {
    ...article,
    ...(book ? {
      bookId: String(book.id), bookTitle: article.bookTitle || book.title,
      sourceBookTitle: text(article.sourceBookTitle) || legacyBookTitle(article) || text(book.sourceBookTitle) || text(book.title),
      sourceCatalogTitle: article.sourceCatalogTitle || text(book.sourceCatalogTitle) || undefined,
      curatedBookId: article.curatedBookId || text(book.curatedBookId) || undefined,
      author: article.author || book.author, cover: article.cover || book.cover,
      totalChapters: Array.isArray(book.chapters) ? book.chapters.length : article.totalChapters,
    } : {}),
    ...(article.bookId || book ? { chapterIndex: article.chapterIndex ?? article.chapterIdx ?? (listedIndex >= 0 ? listedIndex : 0), chapterTitle: article.chapterTitle || chapter?.title || article.title } : {}),
  };
}

export interface ShelfItem { id: string; chapters: Article[]; article: Article; title: string; kind: "book" | "article"; at: number; createdAt: number }
/** Active books use the same chapters as the reader; fully archived books remain browsable for restoration. */
export function shelfVisibleChapters(item: ShelfItem): Article[] {
  const available = item.chapters.filter(article => !article.archived);
  return available.length ? available : item.chapters;
}
export function shelfItems(articles: Article[]): ShelfItem[] {
  const groups = new Map<string, Article[]>();
  for (const article of articles) { const key = article.bookId || article.id; groups.set(key, [...(groups.get(key) || []), article]); }
  return [...groups.entries()].map(([id, rows]) => {
    const chapters = [...rows].sort((a, b) => chapterIndexOf(a) - chapterIndexOf(b));
    const available = chapters.filter(a => !a.archived);
    const article = [...(available.length ? available : chapters)].sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
    return { id, chapters, article, title: String(article.bookTitle || article.title), kind: article.bookId ? "book" as const : "article" as const, at: Math.max(...chapters.map(a => Math.max(a.lastReadAt || 0, a.createdAt || 0))), createdAt: Math.min(...chapters.map(a => a.createdAt || 0)) };
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
export function coverOf(article: Article): string | undefined {
  const value = article.cover || article.coverDataUrl || article.coverUrl;
  if (typeof value !== "string") return undefined;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value)) return value;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? value : undefined; } catch { return undefined; }
}
export function coverTone(id: string): number { return Array.from(id).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 5; }
export function sourceOf(article: Article): string {
  if (article.catalogOrigin) { try { return new URL(String(article.catalogOrigin)).hostname; } catch { /* fall through */ } }
  if (article.sourceUrl) { try { return new URL(article.sourceUrl).hostname; } catch { /* fall through */ } }
  return article.sourceType === "sample" ? "精选短文" : article.sourceType === "paste" ? "粘贴导入" : article.sourceType === "relay" || String(article.sourceType) === "epub" ? "电脑导入" : article.bookId ? "电子书" : "我的导入";
}
