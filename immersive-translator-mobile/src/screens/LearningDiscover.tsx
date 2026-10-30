import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { useCloud } from "../services/cloud";
import { useNav } from "../ui/nav";
import { discoveryError, formatFileSize, importBook, importFeedEntry, listBooks, listSubscriptions, previewBook, previewFeed, previewFeedEntry, RECOMMENDED_FEEDS, removeSubscription, saveSubscription, type BookPreview, type DiscoverBook, type EntryPreview, type FeedEntryItem, type FeedPreview, type FeedSubscription } from "../services/discovery";

/** Embedded in the reading tab. Import happens only after an explicit preview confirmation. */
export function LearningDiscover() {
  const nav = useNav(), cloud = useCloud(), articles = useApp(state => state.articles);
  const [section, setSection] = useState<"books" | "rss">("books");
  const [query, setQuery] = useState(""), [searched, setSearched] = useState(""), [books, setBooks] = useState<DiscoverBook[]>([]);
  const [page, setPage] = useState(0), [total, setTotal] = useState(0), [catalogLoaded, setCatalogLoaded] = useState(false);
  const [book, setBook] = useState<BookPreview | null>(null), [chapter, setChapter] = useState(0);
  const [subscriptions, setSubscriptions] = useState<FeedSubscription[]>([]), [feedUrl, setFeedUrl] = useState(""), [feed, setFeed] = useState<FeedPreview | null>(null);
  const [entry, setEntry] = useState<EntryPreview | null>(null), [failedEntry, setFailedEntry] = useState<FeedEntryItem | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    pending.current?.abort(); setBusy(""); setBook(null); setFeed(null); setEntry(null); setError(""); setNotice("");
    void listSubscriptions().then(value => { if (generation.current === version) setSubscriptions(value); }).catch(cause => { if (generation.current === version) setError(discoveryError(cause)); });
    return () => { generation.current++; pending.current?.abort(); };
  }, [cloud.generation]);
  useEffect(() => { if (section === "books" && !catalogLoaded && !busy) void loadBooks(false); }, [section, catalogLoaded]);

  async function run(label: string, work: (signal: AbortSignal, valid: () => boolean) => Promise<void>) {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    const version = generation.current;
    const valid = () => version === generation.current && !controller.signal.aborted;
    setBusy(label); setError(""); setNotice("");
    try { await work(controller.signal, valid); }
    catch (cause) { if (valid()) setError(discoveryError(cause)); }
    finally { if (pending.current === controller) { pending.current = null; if (version === generation.current) setBusy(""); } }
  }
  async function loadBooks(more: boolean) {
    const search = more ? searched : query, next = more ? page + 1 : 1;
    await run("正在加载书库…", async (signal, valid) => {
      const result = await listBooks(search, next, signal); if (!valid()) return;
      setBooks(previous => more ? [...previous, ...result.books.filter(item => !previous.some(old => old.id === item.id))] : result.books);
      setSearched(search); setPage(result.page); setTotal(result.total); setCatalogLoaded(true);
    });
  }
  async function openBook(item: DiscoverBook) {
    await run("正在下载并校验电子书…", async (signal, valid) => { const result = await previewBook(item, signal); if (valid()) { setBook(result); setChapter(0); } });
  }
  async function confirmBook() {
    if (!book) return;
    await run("正在完整保存章节…", async (_signal, valid) => { const result = await importBook(book); if (valid()) { setNotice(result.added ? `已保存 ${result.added} 个完整章节` : "这些章节已在书架，阅读进度已保留"); nav.push("reader", { articleId: result.firstArticleId }); } });
  }
  async function openFeed(url: string) {
    await run("正在读取订阅源…", async (signal, valid) => { const result = await previewFeed(url, signal); if (valid()) { setFeed(result); setEntry(null); setFailedEntry(null); } });
  }
  async function subscribe() {
    if (!feed) return;
    await run("正在保存订阅…", async (_signal, valid) => { await saveSubscription(feed); const result = await listSubscriptions(); if (valid()) { setSubscriptions(result); setNotice("订阅已保存在这台设备，文章需预览后单独加入书架"); } });
  }
  async function unsubscribe(id: string) {
    await run("正在移除订阅…", async (_signal, valid) => { await removeSubscription(id); const result = await listSubscriptions(); if (valid()) { setSubscriptions(result); setNotice("已移除订阅，已加入书架的文章仍保留"); } });
  }
  async function openEntry(item: FeedEntryItem, summaryOnly = false) {
    setFailedEntry(null);
    await run(summaryOnly ? "正在预览摘要…" : "正在提取网页正文…", async (signal, valid) => {
      try { const result = await previewFeedEntry(item, summaryOnly, signal); if (valid()) setEntry(result); }
      catch (cause) { if (valid() && !summaryOnly) setFailedEntry(item); throw cause; }
    });
  }
  async function confirmEntry() {
    if (!entry) return;
    await run("正在保存文章…", async (_signal, valid) => { const result = await importFeedEntry(entry); if (valid()) { setNotice(result.duplicate ? "这篇文章已在书架，已打开原有内容" : "文章已完整保存"); nav.push("reader", { articleId: result.articleId }); } });
  }
  const importedBook = !!book && articles.some(article => article.bookId === book.bookId);
  const isSubscribed = !!feed && subscriptions.some(subscription => subscription.id === feed.subscription.id);
  return <section className="discover-flow" aria-label="发现阅读内容">
    <div className="learning-seg" aria-label="内容来源">
      <button className={section === "books" ? "on" : ""} disabled={!!busy} onClick={() => { setSection("books"); setError(""); }}>原版书库</button>
      <button className={section === "rss" ? "on" : ""} disabled={!!busy} onClick={() => { setSection("rss"); setError(""); }}>RSS 订阅</button>
    </div>
    <p className="meta">游客也能浏览和保存。内容先在这台设备预览，确认后再加入书架。</p>
    {busy && <div className="learning-notice" role="status">{busy}{!busy.includes("保存") && !busy.includes("移除") && <button className="tlink" onClick={() => { pending.current?.abort(); setBusy(""); }}>取消</button>}</div>}
    {error && <div className="learning-error" role="alert">{error}{failedEntry?.summary && <button className="btn-ghost" disabled={!!busy} onClick={() => void openEntry(failedEntry, true)}>改为预览订阅摘要</button>}</div>}
    {notice && <p className="learning-notice" role="status">{notice}</p>}
    {section === "books" && (book ? <section className="learning-card">
      <button className="tlink" disabled={!!busy} onClick={() => setBook(null)}>返回书库</button>
      <h2>{book.book.title}</h2><p>{book.book.author || book.catalog.author}</p>
      <p className="meta">{book.book.chapters.length} 章 · {book.book.totalWords.toLocaleString()} 词 · 约 {book.book.minutes} 分钟</p>
      <p className="meta">来源：{book.catalog.source} · 授权：{book.catalog.licenseName || "见原始来源"}</p>
      {book.book.fallbackNotice && <p className="learning-notice">{book.book.fallbackNotice}</p>}
      <label>章节目录<select className="input" value={chapter} onChange={event => setChapter(Number(event.target.value))}>{book.book.chapters.map((item, index) => <option key={index} value={index}>{index + 1}. {item.title}（{item.wordCount.toLocaleString()} 词）</option>)}</select></label>
      <h3>{book.book.chapters[chapter]?.title}</h3>
      <p className="discover-excerpt serif">{book.book.chapters[chapter]?.text.slice(0, 2400)}</p>
      <p className="meta">这里展示当前章节开头的节选；加入书架会保存全部章节的完整正文。</p>
      <button className="btn" disabled={!!busy} onClick={() => void confirmBook()}>{importedBook ? "补齐缺少章节并开始阅读" : `加入全部 ${book.book.chapters.length} 章并阅读`}</button>
    </section> : <>
      <form className="discover-search" onSubmit={event => { event.preventDefault(); void loadBooks(false); }}><input className="input" value={query} onChange={event => setQuery(event.target.value)} maxLength={100} placeholder="搜索书名、作者" aria-label="搜索书库"/><button className="btn-ghost" disabled={!!busy} type="submit">搜索</button></form>
      {catalogLoaded && !books.length && <p className="learning-notice">没有找到匹配书目，试试其他书名或作者。</p>}
      {!catalogLoaded && !busy && <button className="btn-ghost" onClick={() => void loadBooks(false)}>重新加载书库</button>}
      <div className="discover-books">{books.map(item => <article className="learning-card" key={item.id}>
        <span className="learning-tag">{{ easy: "入门", medium: "进阶", hard: "挑战" }[item.grade] || item.language}</span>
        <h3>{item.title}</h3><p className="meta">{item.author} · {formatFileSize(item.fileSizeBytes)}</p>
        {item.description && <p>{item.description}</p>}<p className="meta">{item.licenseName}</p>
        <button className="btn-ghost" disabled={!!busy} onClick={() => void openBook(item)}>下载并预览章节</button>
      </article>)}</div>
      {books.length < total && <button className="btn-ghost" disabled={!!busy} onClick={() => void loadBooks(true)}>加载更多（{books.length} / {total}）</button>}
    </>)}
    {section === "rss" && (entry ? <section className="learning-card">
      <button className="tlink" disabled={!!busy} onClick={() => setEntry(null)}>返回文章列表</button><h2>{entry.title}</h2>
      <p className="learning-tag">{entry.summaryOnly ? "仅订阅摘要" : "网页提取正文 · 请核对"}</p>
      <p className="meta">{entry.feedTitle} · {entry.sourceUrl}</p>
      <label>保存前可以核对和编辑<textarea className="input" rows={14} value={entry.text} onChange={event => setEntry({ ...entry, text: event.target.value })}/></label>
      <p className="meta">{entry.summaryOnly ? "当前仅保存订阅提供的摘要，不代表原文全文。" : "部分网站可能混入导航或缺少动态内容，请确认正文完整后保存。"}</p>
      <button className="btn" disabled={!!busy || !entry.text.trim()} onClick={() => void confirmEntry()}>{entry.summaryOnly ? "保存摘要并阅读" : "加入书架并阅读"}</button>
    </section> : feed ? <section>
      <button className="tlink" disabled={!!busy} onClick={() => { setFeed(null); setFailedEntry(null); setError(""); }}>返回订阅</button>
      <h2>{feed.subscription.title}</h2><p className="meta">{feed.subscription.url}</p>
      <button className="btn-ghost" disabled={!!busy || isSubscribed} onClick={() => void subscribe()}>{isSubscribed ? "已订阅" : "确认订阅"}</button>
      <button className="tlink" disabled={!!busy} onClick={() => void openFeed(feed.subscription.url)}>刷新文章</button>
      {!feed.entries.length && <p className="learning-notice">这个订阅源暂时没有可读文章，可以先订阅，稍后再刷新。</p>}
      {feed.entries.map(item => <article className="learning-card" key={item.link}><h3>{item.title}</h3>{item.publishedAt && <p className="meta">{new Date(item.publishedAt).toLocaleDateString()}</p>}<p>{item.summary.slice(0, 180)}</p><button className="btn-ghost" disabled={!!busy} onClick={() => void openEntry(item)}>预览网页正文</button>{item.summary && <button className="tlink" disabled={!!busy} onClick={() => void openEntry(item, true)}>只看订阅摘要</button>}</article>)}
    </section> : <>
      <form className="discover-search" onSubmit={event => { event.preventDefault(); void openFeed(feedUrl); }}><input className="input" type="url" value={feedUrl} onChange={event => setFeedUrl(event.target.value)} placeholder="粘贴 RSS / Atom 地址" aria-label="订阅源地址" required/><button className="btn-ghost" disabled={!!busy} type="submit">预览</button></form>
      <h3>我的订阅</h3>{!subscriptions.length && <p className="meta">还没有订阅。先预览一个来源，确认后再订阅。</p>}
      {subscriptions.map(item => <article className="learning-card" key={item.id}><h3>{item.title}</h3><p className="meta">{item.url}</p><button className="btn-ghost" disabled={!!busy} onClick={() => void openFeed(item.url)}>查看文章</button><button className="tlink" disabled={!!busy} onClick={() => void unsubscribe(item.id)}>移除订阅</button></article>)}
      <h3>试试这些来源</h3><p className="meta">来源的当前可用性以实际读取结果为准。</p>
      {RECOMMENDED_FEEDS.map(item => <article className="learning-card" key={item.url}><h3>{item.title}</h3><p>{item.note}</p><button className="btn-ghost" disabled={!!busy} onClick={() => void openFeed(item.url)}>预览订阅</button></article>)}
      <p className="meta">订阅列表保存在当前设备；已加入书架的文章可以随账号同步。浏览器预览可能受网站跨域限制，读取失败时会明确提示。</p>
    </>)}
    <style>{`.discover-search{display:flex;gap:8px;margin:16px 0}.discover-search .input{flex:1;min-width:0}.discover-search button{flex:none}.discover-flow .learning-card{margin:12px 0}.discover-flow .learning-card p{overflow-wrap:anywhere}.discover-flow select{margin-top:8px;width:100%}.discover-flow .tlink{padding:12px 8px;min-height:44px}.discover-excerpt{white-space:pre-wrap;max-height:340px;overflow:auto;font-size:17px;line-height:1.8}.discover-flow textarea{width:100%;margin-top:8px}.discover-flow .learning-error .btn-ghost{margin-top:10px}`}</style>
  </section>;
}

export default LearningDiscover;
