import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actions, useApp } from "../store";
import { useCloud } from "../services/cloud";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import {
  discoveryError, importBook, importFeedEntry, listBooks, listSubscriptions,
  previewBook, previewFeed, previewFeedEntry, removeSubscription, saveSubscription,
  articlesFromBook, type BookPreview, type EntryPreview,
  type FeedEntryItem, type FeedPreview, type FeedSubscription,
} from "../services/discovery";
import { BookSampleSheet } from "../components/reading/BookSampleSheet";
import { FeedPreviewSheet, type FeedSample } from "../components/reading/FeedPreviewSheet";
import { ReadingDrawer } from "../components/reading/Drawer";
import { minutesOf, levelLabelOf, sourceLabelOf } from "../components/reading/meta";
import { CURATED_BOOKS, CURATED_DOCS, CURATED_FEEDS, curatedFeed, curatedFeedDocs, type CuratedBook } from "../core/curated";

/** 书库/资讯难度筛选（原型 VIEWS.library，html:2040-2042）：全部 / 入门·中级 / 进阶；
    入门·中级=level 命中 /入门|日常|四六级/（原型 f==='easy' 的正则口径）。 */
type GradeFilter = "all" | "easy" | "advanced";
function levelIn(level: string, filter: GradeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "easy") return /A1|A2|B1|入门|日常|四六级/.test(level);
  return !/A1|A2|B1|入门|日常|四六级/.test(level);
}

/** 抽屉/页面共享的加载通道（沿用原 LearningDiscover 的 run：abort + 代际 + busy 文案）。 */
function useRun() {
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState("");
  useEffect(() => () => { generation.current++; pending.current?.abort(); }, []);
  async function run(label: string, work: (signal: AbortSignal, valid: () => boolean) => Promise<void>) {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const version = generation.current;
    const valid = () => version === generation.current && !controller.signal.aborted;
    setBusy(label);
    try { await work(controller.signal, valid); }
    catch (cause) { if (valid()) throw cause; }
    finally { if (pending.current === controller) { pending.current = null; if (version === generation.current) setBusy(""); } }
  }
  return { busy, setBusy, run, pending, generation };
}

function PushHead({ title, subtitle, onBack, right }: { title: string; subtitle: string; onBack: () => void; right?: ReactNode }) {
  return <header className="learning-head nhead">
    <button className="iconbtn" aria-label="返回" onClick={onBack}><Icon name="left" size={20}/></button>
    <div className="nt"><h1>{title}</h1><small>{subtitle}</small></div>
    <span>{right}</span>
  </header>;
}

/* ============================================================
   精选经典书库（proto-parity · 原型 VIEWS.library，html:2039-2043）：
   独立推入页 = nhead（精选经典书库 / 先试读，找到适合自己的篇章）+ 散排 44px 筛选 chips
   （激活 accent 实底白字）+ 书卡（绿/蓝/棕渐变封面 + 衬线书名 + 作者 + 级别·章数 +
   试读 outline / 加入书架 primary）。目录 = 产品随包精选目录（core/curated.ts CURATED_BOOKS，
   原型 BOOKS b1/b2/b3 同款三本）；试读/加入书架点击后按书名查服务端目录并走既有
   「下载校验 → 试读抽屉 → 确认加入」真实链路，目录尚未上架时如实提示。
   ============================================================ */
export function LearningLibrary() {
  const nav = useNav(), articles = useApp(state => state.articles);
  const [grade, setGrade] = useState<GradeFilter>("all");
  const [book, setBook] = useState<BookPreview | null>(null), [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const { busy, setBusy, run, pending } = useRun();

  /* 精选书卡动作 → 真实下载导入链路：按书名查服务端目录，命中后 previewBook（下载 + sha256 校验）；
     目录尚未上架该书时如实提示，不伪造下载。 */
  async function openBook(item: CuratedBook) {
    setError("");
    try {
      await run("正在查找电子书…", async (signal, valid) => {
        const page = await listBooks(item.title, 1, signal);
        if (!valid()) return;
        const found = page.books.find(b => b.title.toLowerCase() === item.title.toLowerCase());
        if (!found) throw new Error("这本书的电子书还没有上架，上架后即可试读与加入书架。");
        const preview = await previewBook(found, signal);
        if (valid()) setBook(preview);
      });
    } catch (cause) { setError(discoveryError(cause)); }
  }
  async function confirmBook() {
    if (!book) return;
    try { await run("正在完整保存章节…", async (_signal, valid) => { const result = await importBook(book); if (valid()) { setBook(null); nav.push("reader", { articleId: result.firstArticleId }); } }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  const importedBook = !!book && articles.some(article => article.bookId === book.bookId && !article.archived);
  const shownBooks = CURATED_BOOKS.filter(item => levelIn(item.level, grade));
  const onShelf = (item: CuratedBook) => articles.some(article => !article.archived && article.bookTitle === item.title);
  const saving = busy.includes("保存");
  function readExisting(item: CuratedBook) {
    const matches = articles.filter(article => article.bookTitle === item.title);
    const active = matches.filter(article => !article.archived);
    const target = [...(active.length ? active : matches)].sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || Number(a.chapterIndex ?? a.chapterIdx ?? 0) - Number(b.chapterIndex ?? b.chapterIdx ?? 0))[0];
    if (target) { if (target.bookId) actions.restoreBook(target.bookId); nav.push("reader", {articleId: target.id}); }
    else void openBook(item);
  }
  return <>
    <PushHead title="精选经典书库" subtitle="先试读，找到适合自己的篇章" onBack={nav.pop} />
    <main className="learning-body">
      {busy && <div className="learning-notice" role="status">{busy}{!saving && <button className="tlink" onClick={() => { pending.current?.abort(); setBusy(""); }}>取消</button>}</div>}
      {error && <div className="learning-error" role="alert">{error}</div>}
      {/* 难度筛选 chips（原型 .v2-filter-row .chip.on：散排胶囊 + accent 实底白字激活态） */}
      <div className="v2-filter-row">
        {([["all", "全部"], ["easy", "入门 / 中级"], ["advanced", "进阶"]] as [GradeFilter, string][]).map(([id, label]) =>
          <button key={id} className={`learning-chip${grade === id ? " on" : ""}`} aria-pressed={grade === id} onClick={() => setGrade(id)}>{label}</button>)}
      </div>
      {/* 书卡（原型 html:2041）：封面 = .cover/.c2/.c3 三色渐变；元信息 = 级别 + 章数 */}
      {shownBooks.map(item => {
        const added = onShelf(item);
        return <article className="learning-card v2-book-card" key={item.id}>
          <div className="v2-book-summary">
            <span className={`v2-cover serif${item.coverClass ? ` ${item.coverClass}` : ""}`} aria-hidden="true">{item.title.split(" ").slice(0, 4).join(" ")}</span>
            <div>
              <h2 className="serif">{item.title}</h2>
              <p>{item.author}</p>
              <div className="v2-book-meta">
                <span>{item.level}</span>
                <span>{item.chapterCount} 章</span>
                {added && <span className="learning-tag">已在书架</span>}
              </div>
            </div>
          </div>
          <div className="v2-book-actions">
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={!!busy} onClick={() => void openBook(item)}>试读</button>
            <button className="btn" disabled={!!busy} onClick={() => readExisting(item)}>{added ? "继续阅读" : articles.some(a => a.bookTitle === item.title) ? "重新加入" : "加入书架"}</button>
          </div>
        </article>;
      })}
    </main>
    {/* 试读抽屉：前 3 句 + 加入/只读两路径；已在书架时提供移出（archived 语义 + 进度保留） */}
    <BookSampleSheet open={!!book} onClose={() => { setBook(null); setConfirmRemove(false); }} preview={book} busy={saving} added={importedBook}
      onAdd={() => void confirmBook()} onReadOnly={() => { if (!book) return; const article = articlesFromBook(book)[0]; setBook(null); if (article) nav.push("reader", { article }); }} onRemove={() => setConfirmRemove(true)} />
    <ReadingDrawer open={confirmRemove && !!book} onClose={() => setConfirmRemove(false)} label="移出书架">
      <div className="sheet-title plain">移出书架？</div>
      {book && <h3 className="serif" style={{ margin: "4px 0 8px" }}>{book.book.title}</h3>}
      <p className="meta" style={{ lineHeight: 1.8 }}>只移出书架，阅读位置、收藏与笔记会保留。以后可以重新加入，接着读。</p>
      <button className="btn-ghost" style={{ color: "#b4423a", width: "100%", border: "1px solid var(--hairline-strong)" }} disabled={saving} onClick={() => { if (!book) return; actions.archiveBook(book.bookId); setConfirmRemove(false); setBook(null); }}>移出书架</button>
      <button className="tlink" style={{ width: "100%", minHeight: 44, justifyContent: "center" }} onClick={() => setConfirmRemove(false)}>留在书架</button>
    </ReadingDrawer>
  </>;
}

/* ============================================================
   英文资讯订阅（proto-parity · 原型 VIEWS.feeds，html:2060-2063）：
   独立推入页 = nhead（英文资讯订阅 / 先看样例，再决定每天读什么）+ 订阅源行
   （rss 圆图标 + 名称/描述/频次 + 右侧 44px「看样例」pill）+
   「订阅之后，在这里读」小节 + 空态卡。目录 = 产品随包精选资讯源（core/curated.ts，
   原型 FEEDS 三源）；看样例直出首个文档的题 + 前 2 句（原型 html:2068），
   「订阅，并开始读这篇」把源内文档入库并打开第一篇（原型 ACT subscribe-feed）。
   自定义 RSS 地址与内联文章预览/保存流程原样保留（我的订阅区）。
   ============================================================ */
export function LearningFeeds() {
  const nav = useNav(), cloud = useCloud(), articles = useApp(state => state.articles).filter(a => !a.archived);
  const curatedSubscribed = useApp(state => state.curatedFeeds);
  const [subscriptions, setSubscriptions] = useState<FeedSubscription[]>([]);
  const [feed, setFeed] = useState<FeedPreview | null>(null), [entry, setEntry] = useState<EntryPreview | null>(null), [failedEntry, setFailedEntry] = useState<FeedEntryItem | null>(null);
  const [sample, setSample] = useState<FeedSample | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const { busy, setBusy, run, pending } = useRun();
  const generation = useRef(0);

  /* 订阅列表随资料切换（登录认领/移除）重取；迟到结果按代际丢弃（旧 LearningDiscover 同口径） */
  useEffect(() => {
    const version = ++generation.current;
    pending.current?.abort();
    setBusy(""); setFeed(null); setEntry(null); setError(""); setNotice(""); setSample(null);
    void listSubscriptions().then(value => { if (generation.current === version) setSubscriptions(value); }).catch(cause => { if (generation.current === version) setError(discoveryError(cause)); });
    return () => { generation.current++; pending.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.generation]);

  async function openFeed(url: string) {
    setError(""); setNotice("");
    try { await run("正在读取订阅源…", async (signal, valid) => { const result = await previewFeed(url, signal); if (valid()) { setFeed(result); setEntry(null); setFailedEntry(null); } }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  async function subscribeInline() {
    if (!feed) return;
    try { await run("正在保存订阅…", async (_signal, valid) => { await saveSubscription(feed); const result = await listSubscriptions(); if (valid()) { setSubscriptions(result); setNotice("订阅已保存在这台设备，文章需预览后单独加入书架"); } }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  async function removeInline(id: string) {
    try { await run("正在移除订阅…", async (_signal, valid) => { await removeSubscription(id); const result = await listSubscriptions(); if (valid()) { setSubscriptions(result); setNotice("已移除订阅，已加入书架的文章仍保留"); } }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  /* 精选源样例（原型 SHEETS.feedPreview，html:2068）：docIds[0] 的章题 + 前 2 句，直出不发网络 */
  function openCuratedSample(id: string) {
    setError(""); setNotice("");
    const feedMeta = curatedFeed(id), doc = curatedFeedDocs(id)[0];
    if (!feedMeta || !doc) return;
    setSample({
      feedTitle: feedMeta.name, feedId: feedMeta.id, docId: doc.id, note: feedMeta.description,
      frequency: feedMeta.frequency, entryTitle: doc.title, minutes: doc.minutes,
      sentences: doc.sentences.slice(0, 2).map(s => s.en),
    });
  }
  /* 完整读这篇（原型 ACT feed-read-sample）：先读后订，不落订阅关系直接打开样例文档 */
  function readSampleDoc() {
    if (!sample?.docId) return;
    const doc = CURATED_DOCS.find(d => d.id === sample.docId);
    setSample(null);
    if (doc) nav.push("reader", { article: doc });
  }
  /* 订阅，并开始读这篇（原型 ACT subscribe-feed）：源文档全部入库 → 打开第一篇（动作内 toast） */
  function subscribeSample() {
    if (!sample?.feedId || !sample?.docId) return;
    const { feedId, docId } = sample;
    setSample(null);
    actions.subscribeCuratedFeed(feedId);
    nav.push("reader", { articleId: docId });
  }
  /* 取消订阅（原型 ACT unsubscribe-feed）：只移除订阅关系，已入库文档保留 */
  function unsubscribeSample() {
    if (!sample?.feedId) return;
    const id = sample.feedId;
    setSample(null);
    actions.unsubscribeCuratedFeed(id);
  }
  async function openEntry(item: FeedEntryItem, summaryOnly = false) {
    setFailedEntry(null);
    try { await run(summaryOnly ? "正在预览摘要…" : "正在提取网页正文…", async (signal, valid) => {
      try { const result = await previewFeedEntry(item, summaryOnly, signal); if (valid()) setEntry(result); }
      catch (cause) { if (valid() && !summaryOnly) setFailedEntry(item); throw cause; }
    }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  async function confirmEntry() {
    if (!entry) return;
    try { await run("正在保存文章…", async (_signal, valid) => { const result = await importFeedEntry(entry); if (valid()) { setNotice(result.duplicate ? "这篇文章已在书架，已打开原有内容" : "文章已完整保存"); nav.push("reader", { articleId: result.articleId }); } }); }
    catch (cause) { setError(discoveryError(cause)); }
  }
  const isSubscribed = !!feed && subscriptions.some(subscription => subscription.id === feed.subscription.id);
  const sampleSubscribed = !!sample?.feedId && curatedSubscribed.includes(sample.feedId);
  /* 已读内容 = 已订阅精选源的文档 + 自定义 RSS 保存的文章 →「订阅之后，在这里读」列表 */
  const delivered = useMemo(() => {
    const curatedIds = new Set(curatedSubscribed.flatMap(id => curatedFeedDocs(id).map(d => d.id)));
    return articles.filter(a => curatedIds.has(a.id) || a.sourceType === "rss").sort((a, b) => (b.lastReadAt || b.createdAt || 0) - (a.lastReadAt || a.createdAt || 0));
  }, [articles, curatedSubscribed]);
  const saving = busy.includes("保存") || busy.includes("移除");
  return <>
    <PushHead title="英文短文与资讯" subtitle="练习精选短文，或订阅自己的 RSS" onBack={nav.pop} />
    <main className="learning-body">
      {busy && <div className="learning-notice" role="status">{busy}{!saving && <button className="tlink" onClick={() => { pending.current?.abort(); setBusy(""); }}>取消</button>}</div>}
      {error && <div className="learning-error" role="alert">{error}{failedEntry?.summary && <button className="btn-ghost" disabled={!!busy} onClick={() => void openEntry(failedEntry, true)}>改为预览订阅摘要</button>}</div>}
      {notice && <p className="learning-notice" role="status">{notice}</p>}
      {/* 条目保存视图优先于订阅列表（回归修复：feed 打开时 openEntry 的 setEntry 曾被
          `feed ? 列表 : entry` 遮蔽，保存按钮永不出现）；「返回文章列表」仅退回列表不清订阅 */}
      {entry ? <section className="learning-card">
        <button className="tlink" disabled={!!busy} onClick={() => setEntry(null)}>返回文章列表</button>
        <h2 style={{ margin: "6px 0" }}>{entry.title}</h2>
        <span className="learning-tag">{entry.summaryOnly ? "仅订阅摘要" : "网页提取正文 · 请核对"}</span>
        <p className="meta" style={{ margin: "8px 0" }}>{entry.feedTitle} · {entry.sourceUrl}</p>
        <label>保存前可以核对和编辑<textarea className="input" rows={14} value={entry.text} onChange={event => setEntry({ ...entry, text: event.target.value })} /></label>
        <p className="meta">{entry.summaryOnly ? "当前仅保存订阅提供的摘要，不代表原文全文。" : "部分网站可能混入导航或缺少动态内容，请确认正文完整后保存。"}</p>
        <button className="btn" disabled={!!busy || !entry.text.trim()} onClick={() => void confirmEntry()}>{entry.summaryOnly ? "保存摘要并阅读" : "加入书架并阅读"}</button>
      </section> : feed ? <section className="learning-card">
        <button className="tlink" disabled={!!busy} onClick={() => { setFeed(null); setFailedEntry(null); setError(""); }}>返回订阅</button>
        <h2 style={{ margin: "6px 0" }}>{feed.subscription.title}</h2>
        <p className="meta">{feed.subscription.url}</p>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 10 }} disabled={!!busy || isSubscribed} onClick={() => void subscribeInline()}>{isSubscribed ? "已订阅" : "确认订阅"}</button>
        <button className="tlink" disabled={!!busy} onClick={() => void openFeed(feed.subscription.url)}>刷新文章</button>
        {!feed.entries.length && <p className="learning-notice">这个订阅源暂时没有可读文章，可以先订阅，稍后再刷新。</p>}
        {feed.entries.map(item => <article className="learning-card" key={item.link} style={{ margin: "10px 0 0" }}>
          <h3 style={{ fontSize: 15 }}>{item.title}</h3>
          {item.publishedAt && <p className="meta">{new Date(item.publishedAt).toLocaleDateString("zh-CN")}</p>}
          <p style={{ fontSize: 13, lineHeight: 1.75, color: "var(--ink-2)" }}>{item.summary.slice(0, 180)}</p>
          <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={!!busy} onClick={() => void openEntry(item)}>预览网页正文</button>
          {item.summary && <button className="tlink" disabled={!!busy} onClick={() => void openEntry(item, true)}>只看订阅摘要</button>}
        </article>)}
      </section> : <>
        {/* 订阅源行（原型 .v2-feed-row，html:2063）：rss 圆图标 + 名称/描述/频次 + 右侧「看样例/管理」pill */}
        <p className="meta">以下为应用内精选练习短文，不会自动发布新文章。真实资讯可在下方添加 RSS，并刷新文章列表。</p>
        <section className="learning-card" style={{ padding: "2px 13px" }}>
          {CURATED_FEEDS.map(item => {
            const on = curatedSubscribed.includes(item.id);
            return <div className="v2-feed-row" key={item.id}>
              <span className="ic"><Icon name="rss" size={15} /></span>
              <span className="tx">
                <b>{item.name}</b>
                <small>{item.description}</small>
                <small>{item.frequency}{on ? " · 已加入" : ""}</small>
              </span>
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", background: "var(--surface)" }} onClick={() => openCuratedSample(item.id)}>{on ? "管理" : "看样例"}</button>
            </div>;
          })}
        </section>
        <div className="v2-sec-h"><b>{delivered.length ? "已加入的短文" : "加入之后，在这里读"}</b>{delivered.length > 0 && <span>{delivered.length} 篇可读</span>}</div>
        <section className="learning-card" style={{ padding: "2px 13px" }}>
          {delivered.map(d => <button className="learning-row" key={d.id} onClick={() => nav.push("reader", { articleId: d.id })}>
            <span style={{ minWidth: 0 }}><b className="serif" style={{ display: "block", fontSize: 15 }}>{d.title}</b><small>{sourceLabelOf(d)} · {levelLabelOf(d)} · {minutesOf(d)} 分钟</small></span>
            <Icon name="chevr" size={15} />
          </button>)}
          {!delivered.length && <div className="v2-empty-card" style={{ padding: "22px 12px" }}>
            <p style={{ marginBottom: 0 }}>先看看样例，喜欢再加入这组练习。<br />已加入的短文可以离线阅读。</p>
          </div>}
        </section>
        {/* 我的订阅（自定义 RSS：真实订阅记录的查看/移除）；「添加订阅源」粘贴框不在原型 VIEWS.feeds（html:2063）内 */}
        {subscriptions.length > 0 && <>
          <div className="v2-sec-h"><b>我的订阅</b></div>
          <section className="learning-card" style={{ padding: "2px 13px" }}>
            {subscriptions.map(item => <div className="v2-feed-row" key={item.id}>
              <span className="ic"><Icon name="rss" size={15} /></span>
              <span className="tx"><b>{item.title}</b><small>{item.url}</small></span>
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", background: "var(--surface)" }} disabled={!!busy} onClick={() => void openFeed(item.url)}>查看文章</button>
              <button className="tlink" style={{ fontSize: 12, minHeight: 44 }} disabled={!!busy} onClick={() => void removeInline(item.id)}>移除</button>
            </div>)}
          </section>
        </>}
      </>}

      <FeedPreviewSheet open={!!sample} onClose={() => setSample(null)} sample={sample} subscribed={sampleSubscribed} busy={saving}
        onSubscribe={() => subscribeSample()} onUnsubscribe={() => unsubscribeSample()} onReadFull={() => readSampleDoc()} />
    </main>
  </>;
}

export default LearningFeeds;
