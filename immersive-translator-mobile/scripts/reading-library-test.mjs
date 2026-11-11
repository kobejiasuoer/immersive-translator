import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser; globalThis.window = dom.window; globalThis.Event = dom.window.Event;
const directory = await mkdtemp(join(tmpdir(), "ita-reading-library-"));
let state = { articles: [] }, response, networkCalls = 0;
const repository = { identity: "reader-test" };
globalThis.__readingLibraryTest = {
  activeRepository: () => repository, getState: () => state,
  replaceSyncedState: async mapper => { state = { ...state, ...mapper(state) }; },
  cloudState: () => ({ baseUrl: "https://catalog.example" }),
  httpRequest: async () => { networkCalls++; return response; },
};
try {
  const output = join(directory, "reading.mjs"), discoveryOutput = join(directory, "discovery.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/core/readingLibrary.ts", import.meta.url))], outfile: output, bundle: true, platform: "browser", format: "esm" });
  const api = await import(pathToFileURL(output).href);
  const page = api.extractReadingPage(`<html><head><title>Energy News | Department</title></head><body>
    <main><div class="usa-banner"><p>A .gov website belongs to an official government organization in the United States.</p></div>
    <article><h1>Grid Funding Announced</h1><p>EstimatedReadTime: 5 minutes</p><p>The department announced $230 million. Mr. Smith will lead the project.</p><p>Engineers discuss HTTPS as a useful technology.</p><p>A second paragraph contains real news.</p></article>
    <aside>Related stories</aside></main></body></html>`);
  assert.equal(page.title, "Grid Funding Announced");
  assert(!page.text.includes("A .gov website")); assert(!page.text.includes("EstimatedReadTime")); assert(!page.text.includes("Related stories"));
  assert(page.text.includes("Engineers discuss HTTPS"), "Mentions of security within actual prose must survive");
  const split = api.splitReadingText(page.text);
  assert.deepEqual(split.paragraphStarts, [0, 2, 3]);
  assert.equal(split.sentences[1].en, "Mr. Smith will lead the project.");
  assert.equal(split.sentences[2].paragraphIdx, 1);
  const fallback = api.extractReadingPage(`<main><div><p>Secure .gov websites use HTTPS</p><p>A lock ( ) or https:// means you’ve safely connected to the .gov website.</p><p>Share sensitive information only on official, secure websites.</p></div><p>Real article text with HTTPS in the middle must stay.</p></main>`);
  assert.equal(fallback.text, "Real article text with HTTPS in the middle must stay.");
  assert.equal(api.isWebNoise("October 30, 2026 Estimated Read Time min"), true);
  assert.equal(api.isWebNoise("Estimated Read Time min"), true);
  assert.equal(api.isWebNoise("October 30, 2026 Estimated Read Time 5 min"), true);
  assert.equal(api.isWebNoise("October 30, 2026 was the first day of work."), false);
  assert.equal(api.isWebNoise("October 30, 2026"), false);
  assert.equal(api.isWebNoise("The estimated read time depends on the reader."), false);
  const actualStructure = api.extractReadingPage(`<article><div class="beneath-title"><p class="summary">A useful article summary.</p><p class="primary-office">Energy.gov</p><span class="display-date">October 30, 2026</span><div class="read-time"><span>Estimated Read Time&nbsp;</span><span id="read-time"></span><span>&nbsp;min</span></div></div><p>October 30, 2026 was the first day of work. HTTPS remains useful.</p><div class="press-release-buttons"><div>View Next Press Release</div><p>A different unrelated story.</p></div></article>`);
  assert.equal(actualStructure.text, "A useful article summary.\n\nOctober 30, 2026 was the first day of work. HTTPS remains useful.");
  const footerStructure = api.extractReadingPage(`<article><p>The inline marker ### is part of this real sentence.</p><p>&nbsp; ### &nbsp;</p><div class="tags linked-topic-tags"><span>Explore more on these topics:</span><ul><li>Unrelated topic links</li></ul></div></article><footer>Contact the department</footer>`);
  assert.equal(footerStructure.text, "The inline marker ### is part of this real sentence.");
  assert.equal(api.isWebNoise("####"), false, "Only the exact standalone press-release marker is filtered");
  if (process.env.READING_PAGE_FIXTURE) {
    const official = api.extractReadingPage(await readFile(process.env.READING_PAGE_FIXTURE, "utf8"));
    assert(official.title.includes("Energy Department Announces"));
    assert(!official.text.includes("Estimated Read Time")); assert(!official.text.includes("A .gov website")); assert(!official.text.includes("View Next")); assert(!official.text.includes("View Previous"));
    assert(!official.text.includes("Explore more on these topics")); assert(!official.text.split(/\n\n/).includes("###"));
    assert(official.text.includes("Applicants must submit a concept paper by November 20, 2026"), "Real dates in the body must survive");
    assert(api.splitReadingText(official.text).paragraphStarts.length > 5, "Official story must preserve natural paragraphs");
    console.log("PASS: official Energy.gov HTML extraction (site chrome removed, real body dates and paragraphs preserved)");
  }
  assert.equal(api.importedTitle("", "A useful article worth reading. More content."), "A useful article worth reading. More content.");
  assert.equal(api.importedTitle("  My name  ", page.text), "My name");
  assert.equal(api.readingContentKey(api.splitReadingText("Hello world.\n\nNext paragraph.")), api.readingContentKey(api.splitReadingText("Hello  world. Next paragraph.")));
  assert.notEqual(api.readingContentKey(api.splitReadingText("Hello world.")), api.readingContentKey(api.splitReadingText("Hello changed world.")));

  const chapter = {id:"c2", title:"Chapter II", bookId:"b1", chapterIdx:1, sentences:[{idx:0,en:"Chapter two."}], paragraphStarts:[0]};
  const book = {id:"b1",kind:"book",title:"Alice in Wonderland",author:"Lewis Carroll",cover:"data:image/png;base64,AAA",chapters:[{articleId:"c1",title:"Chapter I"},{articleId:"c2",title:"Chapter II"}]};
  const hydrated = api.hydrateBookMetadata(chapter, [book]);
  assert.equal(hydrated.bookTitle, book.title); assert.equal(hydrated.author, book.author); assert.equal(hydrated.chapterIndex, 1); assert.equal(hydrated.chapterTitle, "Chapter II");
  assert.equal(hydrated.sourceBookTitle, book.title);
  assert.equal(api.hydrateBookMetadata({...hydrated,bookTitle:"My custom title"},[book]).bookTitle, "My custom title", "Local rename must not be replaced by old desktop metadata");
  assert(api.matchesCuratedBook({...hydrated,bookTitle:"My custom title"},{id:"alice",title:book.title}));
  assert(api.matchesCuratedBook({...chapter,title:"Alice in Wonderland · Chapter II",chapterTitle:"Chapter II",bookTitle:"Renamed before this upgrade"},{id:"alice",title:book.title}));
  assert(api.matchesCuratedBook({...chapter,bookTitle:"My custom title",curatedBookId:"alice"},{id:"alice",title:"A new catalogue title"}));
  assert(!api.matchesCuratedBook({...chapter,bookTitle:book.title,curatedBookId:"other"},{id:"alice",title:book.title}), "An explicit catalogue identity must not fall back to a coincidental heading");
  const items = api.shelfItems([{...hydrated,createdAt:10}, {id:"new-import",title:"New story",sentences:[],paragraphStarts:[0],createdAt:30}, {...hydrated,id:"c1",chapterIdx:0,chapterIndex:0,createdAt:10}]);
  assert.equal(items[0].id, "new-import", "Recently imported short prose must not be buried beneath all books");
  assert.deepEqual(items[1].chapters.map(a=>a.id), ["c1","c2"]);
  const mixedArchive = api.shelfItems([{...hydrated,id:"active",chapterIndex:0}, {...hydrated,id:"hidden",chapterIndex:1,archived:true,lastReadAt:40}])[0];
  assert.equal(mixedArchive.article.id, "active", "Continuation cannot choose a more recently read archived chapter");
  assert.deepEqual(api.shelfVisibleChapters(mixedArchive).map(a=>a.id), ["active"]);
  assert.deepEqual(mixedArchive.chapters.map(a=>a.id), ["active","hidden"], "Omitted chapters must remain available for explicit restoration");
  const fullyArchived = api.shelfItems(mixedArchive.chapters.map(a=>({...a,archived:true})))[0];
  assert.deepEqual(api.shelfVisibleChapters(fullyArchived).map(a=>a.id), ["active","hidden"], "The archived shelf still exposes the full book for restoration");
  assert.equal(api.coverOf({cover:"javascript:alert(1)"}), undefined);

  await build({ entryPoints: [fileURLToPath(new URL("../src/services/discovery.ts", import.meta.url))], outfile: discoveryOutput, bundle: true, platform: "browser", format: "esm", plugins: [{name:"reading-state-fixtures",setup(b) {
    b.onResolve({filter:/.*/},args => ["../store","./cloud"].includes(args.path) ? {path:args.path,namespace:"fixture"} : undefined);
    b.onLoad({filter:/.*/,namespace:"fixture"},args => ({contents: args.path.includes("store") ? "export const {activeRepository,getState,replaceSyncedState}=globalThis.__readingLibraryTest;" : "export const {cloudState,httpRequest}=globalThis.__readingLibraryTest;",loader:"js"}));
  }}] });
  const discovery = await import(pathToFileURL(discoveryOutput).href);
  const preview = {bookId:"b1",sourceOrigin:"https://catalog.example",catalog:{id:"fixture",sha256:"a".repeat(64),sourceUrl:"https://news.example/book",author:"Author"},book:{title:"Fixture",author:"Author",chapters:[{title:"One",text:"A complete readable first paragraph."}]}};
  await discovery.importBook(preview);
  state.articles[0] = {...state.articles[0],archived:true,sentences:state.articles[0].sentences.map(s=>({...s,zh:"已有译文"}))};
  await discovery.importBook(preview);
  assert.equal(state.articles[0].archived, false); assert.equal(state.articles[0].sentences[0].zh, "已有译文"); assert.equal(networkCalls, 0, "Restoring a saved book must not download it");
  const summary = {title:"A story",text:"This is a short summary.",sourceUrl:"https://news.example/story",feedTitle:"Feed",summaryOnly:true};
  const first = await discovery.importFeedEntry(summary);
  const full = await discovery.importFeedEntry({...summary,summaryOnly:false,text:"This is a short summary. The full story includes further paragraphs and details."});
  assert.notEqual(first.articleId, full.articleId, "Saved summary must not prevent importing the full story at the same URL");
  assert.equal((await discovery.importFeedEntry({...summary,text:"This  is a short summary."})).duplicate, true);
  state.articles = state.articles.map(a=>a.id===first.articleId?{...a,archived:true}:a);
  await discovery.importFeedEntry(summary);
  assert.equal(state.articles.find(a=>a.id===first.articleId).archived, false);
  console.log("PASS: reading library regression (web chrome removal, natural paragraphs, abbreviations, title fidelity, version-aware dedupe, desktop metadata, mixed shelf order and archive restoration)");
} finally { dom.window.close(); await rm(directory,{recursive:true,force:true}); delete globalThis.__readingLibraryTest; }
