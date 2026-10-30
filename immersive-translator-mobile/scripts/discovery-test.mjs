import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import JSZip from "jszip";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.window = dom.window;
globalThis.Event = dom.window.Event;
const directory = await mkdtemp(join(tmpdir(), "ita-discovery-tests-"));
const output = join(directory, "discovery.mjs");
let state = { articles: [] }, records = new Map(), revision = 0, tests = 0, calls = [];
let repository = { identity: "guest", async list(collection) { return [...records.values()].filter(row => row.collection === collection); }, async get(collection, id) { return records.get(`${collection}:${id}`) ?? null; } };
let response = () => { throw new Error("No mocked response"); };
globalThis.__discoveryTest = {
  activeRepository: () => repository, getState: () => state, cloudState: () => ({ baseUrl: "https://catalog.example" }),
  async replaceSyncedState(patch, extra = {}) {
    const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    for (const row of extra.records ?? []) {
      const key = `${row.collection}:${row.id}`, previous = records.get(key);
      assert.equal(row.expectedVersion, previous?.version ?? 0);
      records.set(key, { ...row, version: (previous?.version ?? 0) + 1 });
    }
    state = next; revision++;
  },
  async httpRequest(...args) { calls.push(args); return response(...args); },
};
try {
  await build({
    entryPoints: [fileURLToPath(new URL("../src/services/discovery.ts", import.meta.url))], outfile: output, bundle: true, platform: "browser", format: "esm",
    plugins: [{ name: "discovery-contract-fixtures", setup(api) {
      api.onResolve({ filter: /.*/ }, args => ["../store", "./cloud"].includes(args.path) ? { path: args.path, namespace: "test-contract" } : undefined);
      api.onLoad({ filter: /.*/, namespace: "test-contract" }, args => ({ contents: args.path.includes("store") ? "export const {activeRepository,getState,replaceSyncedState}=globalThis.__discoveryTest;" : "export const {cloudState,httpRequest}=globalThis.__discoveryTest;", loader: "js" }));
    } }],
  });
  const api = await import(pathToFileURL(output).href);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Fixture Book</dc:title><dc:creator>Fixture Author</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file("OEBPS/nav.xhtml", '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml">First</a></li><li><a href="two.xhtml">Second</a></li></ol></nav></body></html>');
  const first = "Mr. Smith reads carefully. A complete first chapter sentence. ".repeat(80) + "FIRST_END.";
  const second = "Another full chapter is preserved. ".repeat(90) + "SECOND_END.";
  zip.file("OEBPS/one.xhtml", `<html><body><p>${first}</p></body></html>`);
  zip.file("OEBPS/two.xhtml", `<html><body><p>${second}</p></body></html>`);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const catalog = { id: "fixture-book", title: "Catalog title", author: "Author", language: "en", grade: "easy", category: "fiction", source: "fixture", sourceUrl: "https://source.example/book", licenseName: "Fixture license", licenseUrl: "https://source.example/license", fileSizeBytes: bytes.length, sha256 };
  response = () => ({ status: 200, body: Buffer.from(bytes).toString("base64"), headers: {}, url: "https://catalog.example/v1/books/fixture-book/download" });
  const preview = await api.previewBook(catalog);
  assert.equal(state.articles.length, 0, "Preview must not import");
  assert.equal(preview.book.chapters.length, 2); assert.equal(preview.book.tocUsed, true);
  assert.equal(calls.at(-1)[6], "base64"); tests++;
  const projected = api.articlesFromBook(preview);
  assert.ok(projected[0].sentences.at(-1).en.includes("FIRST_END"));
  assert.ok(projected[1].sentences.at(-1).en.includes("SECOND_END"));
  assert.equal(projected[1].chapterIndex, 1); assert.equal(projected[1].totalChapters, 2);
  assert.equal(projected[0].sentences[0].en, "Mr. Smith reads carefully."); tests++;
  const imported = await api.importBook(preview); assert.equal(imported.added, 2); assert.equal(revision, 1);
  state.articles[0].sentences[0].zh = "已有译文";
  assert.equal((await api.importBook(preview)).added, 0); assert.equal(state.articles[0].sentences[0].zh, "已有译文"); tests++;
  await assert.rejects(api.importBook({ ...preview, catalog: { ...preview.catalog, sha256: "f".repeat(64) } }), /未混合章节/); tests++;
  await assert.rejects(api.previewBook({ ...catalog, sha256: "0".repeat(64) }), /校验未通过/);
  await assert.rejects(api.previewBook({ ...catalog, fileSizeBytes: bytes.length + 1 }), /长度/);
  await assert.rejects(api.previewBook({ ...catalog, sha256: "" }), /校验信息/); tests++;
  response = () => ({ status: 200, body: JSON.stringify({ data: [catalog], total: 1, page: 1, perPage: 12 }), headers: {}, url: "https://catalog.example/v1/books" });
  assert.equal((await api.listBooks("fixture")).books[0].id, catalog.id);
  response = () => ({ status: 200, body: "{}", headers: {}, url: "https://catalog.example/v1/books" });
  await assert.rejects(api.listBooks(""), /格式异常/); tests++;
  const rss = '<rss><channel><title>Fixture Feed</title><item><title>A story</title><link>https://news.example/story#section</link><description><![CDATA[<p>A safe summary.</p><script>unsafe()</script>]]></description></item><item><title>Duplicate</title><link>https://news.example/story</link></item><item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>';
  response = () => ({ status: 200, body: rss, headers: {}, url: "https://news.example/feed/" });
  const feed = await api.previewFeed("https://news.example/feed");
  assert.equal(feed.entries.length, 1); assert.equal(feed.entries[0].summary, "A safe summary.");
  assert.equal(feed.entries[0].link, "https://news.example/story"); assert.equal(records.size, 0); tests++;
  await api.saveSubscription(feed); await api.saveSubscription(feed); assert.equal((await api.listSubscriptions()).length, 1);
  await api.removeSubscription(feed.subscription.id); assert.equal((await api.listSubscriptions()).length, 0);
  await api.saveSubscription(feed); assert.equal((await api.listSubscriptions()).length, 1); tests++;
  const summary = await api.previewFeedEntry(feed.entries[0], true); assert.equal(summary.summaryOnly, true);
  const saved = await api.importFeedEntry(summary); const original = state.articles.find(article => article.id === saved.articleId);
  assert.equal(original.summaryOnly, true);
  assert.equal((await api.importFeedEntry({ ...summary, sourceUrl: summary.sourceUrl + "#other" })).duplicate, true);
  assert.equal(state.articles.filter(article => article.sourceType === "rss").length, 1); tests++;
  response = () => ({ status: 200, body: '<html><body><nav>Ignore</nav><article><p>' + "Actual article content. ".repeat(20) + '</p></article></body></html>', headers: {}, url: feed.entries[0].link });
  const full = await api.previewFeedEntry(feed.entries[0]); assert.equal(full.summaryOnly, false); assert.ok(!full.text.includes("Ignore"));
  response = () => ({ status: 200, body: "<html><body>Dynamic site</body></html>", headers: {}, url: feed.entries[0].link });
  await assert.rejects(api.previewFeedEntry(feed.entries[0]), /没有足够正文/); tests++;
  const prior = repository; response = () => { repository = { ...prior, identity: "changed" }; return { status: 200, body: Buffer.from(bytes).toString("base64"), headers: {}, url: "https://catalog.example/file" }; };
  await assert.rejects(api.previewBook(catalog), /账号资料已切换/); tests++;
  console.log(`PASS: ${tests} discovery scenarios (EPUB integrity, complete chapters, confirmation, RSS parsing, deduplication and profile switch)`);
} finally { dom.window.close(); await rm(directory, { recursive: true, force: true }); delete globalThis.__discoveryTest; }
