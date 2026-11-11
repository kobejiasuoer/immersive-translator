import { GlassSwitch } from "../ui/GlassSwitch";
import { useEffect, useMemo, useState } from "react";
import { useLocalDraft } from "../core/useLocalDraft";
import { vocabMeaning, vocabSearchText } from "../core/vocabMeaning";
import { ContentsSheet } from "../components/reading/ContentsSheet";
import { ReadingDrawer } from "../components/reading/Drawer";
import { chapterIndexOf, coverOf, coverTone, shelfItems, shelfVisibleChapters, sourceOf, type ShelfItem } from "../core/readingLibrary";
import { minutesOf, levelLabelOf, timeLabelOf } from "../components/reading/meta";
import { VaultBody, WordbookBody } from "../components/vault/VaultBody";
import { requestVaultSection, type VaultSection } from "../components/vault/sectionGate";
import { ExportPanel } from "../components/vault/ExportPanel";
import { WordDetailPage, WordDetailSheet } from "../components/vault/WordDetailSheet";
import { AddLearningNoteSheet } from "../components/vault/AddLearningNoteSheet";
import { actions, activeRepository, effectiveSentenceZh, flushPersist, toast, useApp } from "../store";
export { openPractice } from "../services/openPractice";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import type { Article } from "../core/types";
import "./libraryExperience.css";
import { Heading } from "../ui/LearningHeading";
function readingStarted(article: Article, progress: Record<string, number>) {
  return progress[article.id] !== undefined && (!!article.lastReadAt || progress[article.id] > 0);
}
function readingState(item: ShelfItem, progress: Record<string, number>, completed: Record<string, boolean>) {
  const chapters = shelfVisibleChapters(item);
  if (chapters.every(a => completed[a.id])) return "已读完";
  if (!chapters.some(a => readingStarted(a, progress))) return "未开始";
  const p = Math.min(progress[item.article.id] ?? 0, Math.max(0, item.article.sentences.length - 1));
  return `${item.kind === "book" ? `第 ${chapterIndexOf(item.article) + 1} 章 · ` : ""}第 ${p + 1} / ${item.article.sentences.length} 句`;
}
function LibraryHeading() {
  const nav = useNav();
  return <Heading title="阅读" extra={<button className="ibtn" aria-label="导入阅读内容" onClick={() => nav.push("learningImport")}><Icon name="plus" size={23}/></button>}/>;
}
function ShelfCover({ item }: { item: ShelfItem }) {
  const cover = coverOf(item.article);
  const [broken, setBroken] = useState("");
  return <span className="library-cover" data-kind={item.kind} data-tone={coverTone(item.id)} aria-hidden="true">
    {cover && broken !== cover ? <img src={cover} alt="" loading="lazy" onError={() => setBroken(cover)}/> : <><Icon name={item.kind === "book" ? "bookopen" : "note"} size={14}/><span>{item.title.split(/\s+/).slice(0, 5).join(" ")}</span></>}
  </span>;
}
function ShelfCard({ item, onToc, onManage, version, resume = false }: { item: ShelfItem; onToc?: () => void; onManage: () => void; version?: string; resume?: boolean }) {
  const nav = useNav(), progress = useApp(s => s.progress), completed = useApp(s => s.readingCompleted);
  const archived = item.chapters.every(a => a.archived);
  const state = archived ? "已移出 · 进度已保留" : readingState(item, progress, completed);
  const author = typeof item.article.author === "string" ? item.article.author.trim() : "";
  const kindLabel = item.kind === "book" ? "书籍" : item.article.sourceType === "sample" ? "精选短文" : item.article.sourceType === "rss" ? "订阅文章" : "文章";
  const credit = author || sourceOf(item.article);
  const showCredit = credit !== kindLabel && !(item.kind === "book" && credit === "电子书");
  const position = Math.min(Math.max(0, progress[item.article.id] ?? 0), Math.max(0, item.article.sentences.length - 1));
  const percent = completed[item.article.id] ? 100 : Math.round(position / Math.max(1, item.article.sentences.length) * 100);
  return <article className={`reading-shelf-item library-item${resume ? " library-resume" : ""}`} data-kind={item.kind} aria-label={item.title}>
    <button className="library-item-main" aria-label={resume ? `${completed[item.article.id] ? "再读" : "继续阅读"} ${item.title}` : undefined} onClick={() => { if (archived) { item.kind === "book" ? actions.restoreBook(item.id) : actions.restoreArticle(item.id); } nav.push("reader", {articleId: item.article.id}); }}>
      <ShelfCover item={item}/>
      <span className="library-item-copy">
        {resume && <span className="library-resume-label">继续阅读</span>}
        <b>{item.title}</b>
        <span className="library-item-byline"><span>{kindLabel}</span>{showCredit && <span>{credit}</span>}</span>
        <span className="library-item-info"><span>{item.kind === "book" ? `${shelfVisibleChapters(item).length} 章` : `约 ${minutesOf(item.article)} 分钟`}</span><span className="library-item-state">{state}</span></span>
        {resume && <span className="library-resume-bottom"><span className="library-progress" aria-hidden="true"><i style={{ width: `${percent}%` }}/></span><span>{completed[item.article.id] ? "再读一遍" : "接着读"}<Icon name="right" size={13}/></span></span>}
        {version && <span className="library-item-version">{version}</span>}
      </span>
    </button>
    <div className="library-item-actions">
      {onToc && <button aria-label={`${item.title}的目录`} title="目录" onClick={onToc}><Icon name="list" size={18}/></button>}
      <button aria-label={`整理 ${item.title}`} title="整理" onClick={onManage}><Icon name="dots" size={19}/></button>
    </div>
  </article>;
}
export function ReadingHome() {
  const nav = useNav(), allArticles = useApp(s => s.articles), progress = useApp(s => s.progress), completed = useApp(s => s.readingCompleted);
  const [toc, setToc] = useState<ShelfItem | null>(null), [manage, setManage] = useState<ShelfItem | null>(null), [name, setName] = useState("");
  const [type, setType] = useState<"all" | "book" | "article">("all"), [status, setStatus] = useState<"all" | "unread" | "reading" | "done" | "archived">("all");
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const items = useMemo(() => shelfItems(allArticles.filter(a => a.bookId || (a.sourceType !== "sample" || a.id !== "starter") || readingStarted(a, progress) || a.archived)), [allArticles, progress]);
  const visible = items.filter(item => {
    const chapters = shelfVisibleChapters(item);
    const archived = item.chapters.every(a => a.archived), done = chapters.every(a => completed[a.id]), started = chapters.some(a => readingStarted(a, progress));
    return (type === "all" || item.kind === type) && (status === "archived" ? archived : !archived && (status === "all" || status === "done" && done || status === "unread" && !started && !done || status === "reading" && started && !done));
  });
  const recent = allArticles.filter(a => !a.archived && readingStarted(a, progress)).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  const current = recent[0];
  const currentItem = visible.find(item => item.chapters.some(a => a.id === current?.id));
  const ordered = currentItem ? [currentItem, ...visible.filter(item => item.id !== currentItem.id)] : visible;
  const starter = allArticles.find(a => !a.archived && a.id === "starter") || allArticles.find(a => !a.archived);
  const omittedChapters = manage?.kind === "book" && manage.chapters.some(a => !a.archived) ? manage.chapters.filter(a => a.archived).length : 0;
  const openVault = (section: VaultSection) => { requestVaultSection(section); actions.setTab("vocab"); };
  const openManage = (item: ShelfItem) => { setManage(item); setName(item.title); };
  const saveName = () => { if (!manage) return; try { manage.kind === "book" ? actions.renameBook(manage.id, name) : actions.renameArticle(manage.id, name); setManage(null); toast("名称已保存"); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } };
  return <>
    <div className="library-experience">
    <LibraryHeading/>
    <main className="learning-body reading-shelf-body library-body">
      <div className="library-heading-tools">
        <button className="library-search" aria-label="搜索学习内容" onClick={() => nav.push("learningSearch")}><Icon name="search" size={18}/><span>搜索书名、文章或表达</span></button>
      </div>
      {!online && <div className="library-offline" role="status"><Icon name="phone" size={15}/>离线时也能阅读已保存的内容</div>}
      <section className="library-discovery" aria-label="发现阅读内容">
        <button onClick={() => nav.push("learningLibrary")}><span className="library-discovery-icon"><Icon name="bookopen" size={23}/></span><span><b>经典书库</b><small>找一本慢慢读</small></span><Icon name="right" size={14}/></button>
        <button onClick={() => nav.push("learningFeeds")}><span className="library-discovery-icon"><Icon name="rss" size={21}/></span><span><b>短文与订阅</b><small>发现感兴趣的话题</small></span><Icon name="right" size={14}/></button>
      </section>
      <div className="library-section-heading"><div><h2>我的内容</h2>{items.length > 0 && <span className="reading-shelf-summary" role="status">{visible.length} 项</span>}</div><button className="library-wordbook" aria-label="打开生词本" onClick={() => openVault("words")}><Icon name="mark" size={16}/>生词本</button></div>
      {items.length > 0 && <div className="reading-shelf-toolbar">
        <GlassSwitch className="reading-shelf-filters" role="group" ariaLabel="内容类型" value={type} items={([ ["all", "全部"], ["book", "书籍"], ["article", "文章"] ] as const).map(([value,label]) => ({value,label}))} onChange={setType} />
        <select aria-label="筛选阅读状态" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option value="all">全部状态</option><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读完</option><option value="archived">已移出</option>
        </select>
      </div>}
      {!items.length && <section className="library-empty starter-card"><span className="library-empty-label"><Icon name="bookopen" size={18}/>从一篇短文开始</span><h3>{starter?.title || "留一点时间，读点英文"}</h3>{starter?.sentences[0] && <blockquote lang="en">{starter.sentences[0].en}</blockquote>}<p>读到有用的表达，收藏下来，再试着说一句。</p>{starter ? <button className="library-start" onClick={() => nav.push("reader", {articleId: starter.id})}>开始阅读<Icon name="right" size={15}/></button> : <button className="library-start" onClick={() => nav.push("learningImport")}>导入一篇文章<Icon name="plus" size={15}/></button>}</section>}
      {items.length > 0 && !visible.length && <section className="library-filter-empty"><Icon name="shelf" size={24}/><h3>暂时没有{status === "archived" ? "移出的" : status === "done" ? "读完的" : status === "reading" ? "正在读的" : status === "unread" ? "未读的" : "这类"}内容</h3><p>换个筛选，或导入一篇想读的文章。</p><button className="library-start" onClick={() => { setType("all"); setStatus("all"); }}>查看全部内容</button></section>}
      <div className="library-list">
      {ordered.map(item => { const duplicates = items.filter(other => other.title === item.title).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); const version = duplicates.length > 1 ? `${item.createdAt ? `导入 ${timeLabelOf(item.createdAt)} · ` : ""}版本 ${duplicates.indexOf(item) + 1}` : undefined; return <ShelfCard key={item.id} item={item} version={version} resume={item === currentItem} onToc={item.kind === "book" ? () => setToc(item) : undefined} onManage={() => openManage(item)}/>; })}
      </div>
    </main>
    </div>
    <ContentsSheet open={!!toc} onClose={() => setToc(null)} title={toc ? `${toc.title} · 目录` : ""} articles={toc ? shelfVisibleChapters(toc) : []} onPick={a => { setToc(null); if(a.archived) a.bookId ? actions.restoreBook(a.bookId) : actions.restoreArticle(a.id); nav.push("reader", {articleId:a.id}); }}/>
    <ReadingDrawer open={!!manage} onClose={() => setManage(null)} label="整理阅读内容">
      {manage && <div className="reading-manage-sheet"><div className="sheet-title plain">整理内容</div><label htmlFor="reading-item-name">名称</label><input id="reading-item-name" className="input" value={name} maxLength={160} onChange={e => setName(e.target.value)}/><button className="btn" onClick={saveName}>保存名称</button>{manage.kind === "article" && manage.article.sourceUrl && <button className="btn-ghost" onClick={() => { actions.setShareIn({text:manage.article.sourceUrl!,source:"shelf-refresh"}); setManage(null); nav.push("learningImport"); }}>重新提取原网页</button>}{omittedChapters > 0 && <button className="btn-ghost" onClick={() => { actions.restoreBook(manage.id); setManage(null); }}>恢复已移出的 {omittedChapters} 章</button>}<p className="meta">移出后，阅读位置、收藏和笔记都会保留。可从「已移出」重新加入。</p><button className="btn-ghost" onClick={() => { const archived = manage.chapters.every(a => a.archived); if (manage.kind === "book") archived ? actions.restoreBook(manage.id) : actions.archiveBook(manage.id); else archived ? actions.restoreArticle(manage.id) : actions.archiveArticle(manage.id); setManage(null); }}>{manage.chapters.every(a => a.archived) ? "重新加入书架" : "移出书架"}</button></div>}
    </ReadingDrawer>
  </>;
}
export { SpeakingHome, when } from "./SpeakingHome";
/* 笔记与复习域（vault-review-parity）：主体实现迁至 components/vault/VaultBody（due 卡/
   续学行/掌握阶段三格/生词本/我的笔记，proto-parity-2026-11-01）。
   这里保留页头（Heading），其余首页不动。 */
export function LearningVault() {
  /* 页头导出圆钮（proto-parity：vault 页头右上导出）：与生词本笔记区「导出学习资料」
     同一个 ExportPanel 实例口径，各自独立开合，不改动 vault 域内部状态。 */
  const [exportOpen,setExportOpen]=useState(false);
  return <><Heading title="笔记与复习" extra={<button className="ibtn" aria-label="导出学习资料" onClick={()=>setExportOpen(true)}><Icon name="share"/></button>}/><VaultBody/><ExportPanel open={exportOpen} onClose={()=>setExportOpen(false)}/></>;
}
/* 独立生词本 push 页（proto-parity · wordbook-page，html:2843）：nhead「生词本 / 共 N 条 ·
   随时回到原句」+ 右上导出圆钮；主体与 vault tab 的生词本共用 WordbookBody（tab 内 seg 保留）。 */
export function WordbookScreen() {
  const nav=useNav();
  const total=useApp(s=>s.vocab.length);
  const [exportOpen,setExportOpen]=useState(false);
  return <>
    <header className="learning-head nhead">
      <button className="tlink" data-nav-back aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={18}/></button>
      <div className="nt"><h1>生词本</h1><small>共 {total} 条 · 随时回到原句</small></div>
      <button className="v2-note-edit" aria-label="导出学习资料" onClick={()=>setExportOpen(true)}><Icon name="share" size={18}/></button>
    </header>
    <main className="learning-body" style={{ paddingTop: 0 }}>
      <WordbookBody/>
    </main>
    <ExportPanel open={exportOpen} onClose={()=>setExportOpen(false)}/>
  </>;
}
/* 词条详情：抽屉化后词典卡「查看词条」保留整页形态（同主体 WordDetailBody）。 */
export function WordDetail({id}:{id:string}) { return <WordDetailPage id={id}/>; }
/* 学习笔记（proto-parity · learning-note，html:3005-3008）：已有笔记先渲染阅读态——
   nhead 居中标题 + 时间副标 + 右上圆形编辑笔（✎ pen）按钮（进编辑抽屉），正文白卡 15px/1.9
   pre-wrap；编辑态为二级抽屉（SHEETS.addLearningNote 同款）。新建（无 id）保留整页表单
   （草稿键位不变，落库链路同前）。 */
export function LearningNote({id}:{id?:string}) {
  const nav=useNav();
  const note=useApp(s=>s.notes.find(n=>n.id===id));
  /* 复检 r1：关联原文的笔记显示「查看原文 ›」（原型 VIEWS.learningNote n.docId，html:3007 + v2-note-doc）。 */
  const sourceArticle=useApp(s=>note?.sourceArticleId?s.articles.find(a=>a.id===note.sourceArticleId):undefined);
  const [editOpen,setEditOpen]=useState(false);
  const target=activeRepository();
  const [draft,setDraft,ready,clearDraft]=useLocalDraft("note:"+(id||"new"),{title:note?.title||"",body:note?.body||""});
  const {title,body}=draft;const setTitle=(title:string)=>setDraft(d=>({...d,title}));const setBody=(body:string)=>setDraft(d=>({...d,body}));
  if(!id){
    if(!ready)return <div className="learning-body" role="status">正在恢复笔记草稿…</div>;
    return <><header className="learning-head"><button className="tlink" data-nav-back onClick={nav.pop}>返回</button><h1>写一条学习笔记</h1><span style={{width:44}}/></header>
      <form className="learning-body" onSubmit={e=>{e.preventDefault();if(target!==activeRepository()){toast("账号已切换，请重新打开笔记");return;}actions.saveNote({id:crypto.randomUUID(),title:title||"学习笔记",body,sub:"我的心得",insight:"",createdAt:Date.now()});void flushPersist().then(clearDraft).then(()=>{toast("笔记已保存");nav.pop();}).catch(e=>toast(String(e)));}}>
        <label>标题（选填）<input className="input" value={title} maxLength={100} placeholder="今天学到的小发现" onChange={e=>setTitle(e.target.value)}/></label>
        <label>内容<textarea className="input" rows={12} required value={body} maxLength={6000} onChange={e=>setBody(e.target.value)}/></label>
        <button className="btn">保存笔记</button>
      </form></>;
  }
  return <>
    <header className="learning-head nhead">
      <button className="tlink" data-nav-back aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={18}/></button>
      <div className="nt"><h1>{note?.title || "学习笔记"}</h1>{note?.createdAt?<small>{noteTimeLabel(note.createdAt)}</small>:null}</div>
      <button className="v2-note-edit" aria-label="编辑笔记" onClick={()=>setEditOpen(true)}><Icon name="pen" size={17}/></button>
    </header>
    <main className="learning-body" style={{ paddingTop: 0 }}>
      <article className="learning-card v2-free-note" style={{ marginTop: 0 }}>
        <p>{note?.body || ""}</p>
        {sourceArticle&&<button className="btn-ghost" style={{width:"100%",border:"1px solid var(--hairline-strong)"}} onClick={()=>{actions.locateReader(sourceArticle.id,note?.sourceSentenceIdx??0);nav.push("reader",{articleId:sourceArticle.id});}}>查看原文 <Icon name="right" size={14}/></button>}
      </article>
    </main>
    <AddLearningNoteSheet id={id} open={editOpen} onClose={()=>setEditOpen(false)}/>
  </>;
}
/* 笔记时间副标（derive.timeLabel 同口径：今天/昨天 HH:MM，更早 M月D日）。 */
function noteTimeLabel(at:number){const d=new Date(at),now=new Date();const hm=d.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});if(d.toDateString()===now.toDateString())return `今天 ${hm}`;const y=new Date(now);y.setDate(now.getDate()-1);if(d.toDateString()===y.toDateString())return `昨天 ${hm}`;return `${d.getMonth()+1}月${d.getDate()}日 ${hm}`;}
/* 全局搜索（proto-parity · 原型 VIEWS.search，html:2139-2153）：nhead 页头 + pill 搜索框 +
   范围 chips（全部/原文/词条/笔记，带命中计数与 accent 实底激活态）+「找到 N 个结果」计数行 +
   三段分组（原文与文章/收藏的词与表达/助记与口语纠偏，各带计数与「再显示」）+ 命中句卡片
   （mark 高亮 + 中文译文 + 来源行）+ 起始态（说明 + 建议 chips + 最近读过/推荐开始）+
   两种筛选空态。三源数据与跳转链路不变。 */
interface DocHit { article: Article; idx: number; en: string; zh: string | null }
/** 命中高亮：首个命中词 accent-soft mark，长文本按原型截 160 字符窗口（html:2126-2132）。 */
function Mark({ text, q }: { text: string; q: string }) {
  const source = text || "";
  if (!q) return <>{source.length > 160 ? source.slice(0, 160) + "…" : source}</>;
  const at = source.toLowerCase().indexOf(q);
  if (at < 0) return <>{source.length > 160 ? source.slice(0, 160) + "…" : source}</>;
  const start = source.length > 155 && at > 65 ? at - 45 : 0;
  const chunk = source.slice(start, start + 160);
  const index = chunk.toLowerCase().indexOf(q);
  if (index < 0) return <>{(start ? "…" : "") + chunk + (start + 160 < source.length ? "…" : "")}</>;
  return <>{(start ? "…" : "") + chunk.slice(0, index)}<mark className="v2-search-mark">{chunk.slice(index, index + q.length)}</mark>{chunk.slice(index + q.length) + (start + 160 < source.length ? "…" : "")}</>;
}
export function LearningSearch(){
  const nav=useNav();
  const state=useApp(s=>s);
  const [wordSheet,setWordSheet]=useState<string|null>(null);
  const [query,setQuery]=useState("");
  const [scope,setScope]=useState<"all"|"docs"|"words"|"notes">("all");
  const [limits,setLimits]=useState({docs:6,words:6,notes:6});
  const q=query.trim().toLowerCase();
  // Search the displayed translation, including user corrections, and real book metadata.
  const docs=useMemo<DocHit[]>(()=>{
    if(!q)return[];
    const out:DocHit[]=[], matchedBooks=new Set<string>();
    for(const a of state.articles.filter(a=>!a.archived)){
      for(const s of a.sentences){
        const zh=effectiveSentenceZh(state.sentenceZh[a.id],s.idx,s.zh);
        if(s.en.toLowerCase().includes(q)||(zh||"").toLowerCase().includes(q)) out.push({article:a,idx:s.idx,en:s.en,zh});
      }
      const fields=[a.title,a.bookTitle,a.chapterTitle,a.author,a.titleCn].filter((value):value is string=>typeof value==="string");
      if(fields.some(value=>value.toLowerCase().includes(q))&&(!a.bookId||!matchedBooks.has(a.bookId))){
        const label=[String(a.bookTitle||a.title),typeof a.author==="string"&&a.author.toLowerCase().includes(q)?a.author:"",typeof a.chapterTitle==="string"&&a.chapterTitle.toLowerCase().includes(q)?a.chapterTitle:""].filter(Boolean).join(" · ");
        if(!out.some(h=>h.article.id===a.id&&h.idx===0))out.unshift({article:a,idx:0,en:label,zh:a.titleCn||null});
        if(a.bookId)matchedBooks.add(a.bookId);
      }
    }
    return out;
  },[state.articles,state.sentenceZh,q]);
  const words=state.vocab.filter(w=>vocabSearchText(w).includes(q));
  const notes=state.notes.filter(n=>(n.title+n.body).toLowerCase().includes(q));
  const total=docs.length+words.length+notes.length;
  const inScope=(kind:"docs"|"words"|"notes")=>scope==="all"||scope===kind;
  const visibleCount=(inScope("docs")?docs.length:0)+(inScope("words")?words.length:0)+(inScope("notes")?notes.length:0);
  /* 起始态列表：最近读过（有进度，按 lastReadAt 排序），为空回退入门演示文（原型 html:2147
     recent 为空时 push getDoc('starter')，只列 A Small Break 一行） */
  const recentList=[...state.articles].filter(a=>!a.archived&&state.progress[a.id]!==undefined).sort((a,b)=>(b.lastReadAt||0)-(a.lastReadAt||0)).slice(0,3);
  const startList=recentList.length?recentList:state.articles.filter(a=>!a.archived&&a.id==="starter").slice(0,3);
  const more=(kind:"docs"|"words"|"notes")=>setLimits(l=>({...l,[kind]:l[kind]+6}));
  return <>
    <header className="learning-head nhead"><button className="iconbtn" data-nav-back aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={20}/></button><div className="nt"><h1>搜索</h1><small>文章、词条与笔记一起找</small></div><span/></header>
    <main className="learning-body reading-search-body">
      <div className="v2-search-toolbar">
        <label className="v2-search-field">
          <Icon name="search" size={17}/>
          <input className="input" type="search" autoFocus value={query} maxLength={80} onChange={e=>setQuery(e.target.value)} placeholder="英文、中文或文章标题…" aria-label="搜索学习内容"/>
        </label>
        {query&&<button className="v2-search-clear" aria-label="清空关键词" onClick={()=>setQuery("")}><Icon name="close" size={16}/></button>}
      </div>
      <GlassSwitch className="v2-filter-row" role="group" ariaLabel="搜索范围" value={scope} onChange={setScope}
        items={([["all","全部",total],["docs","原文",docs.length],["words","词条",words.length],["notes","笔记",notes.length]] as const).map(([value,label,count]) => ({value,label: label + (q && value!=="all" ? ` ${count}` : "")}))} />
      {!q&&<>
        <div className="v2-search-start">
          <p>搜文章标题、原句、收藏或纠偏，都能回到来源。</p>
          <div className="v2-search-suggestions">{["take a break","休息","quiet"].map(t=><button key={t} className="learning-chip" onClick={()=>setQuery(t)}>{t}</button>)}</div>
        </div>
        <div className="v2-sec-h"><b>{recentList.length ? "最近阅读" : "从这里开始"}</b></div>
        <section className="learning-card" style={{padding:"2px 14px"}}>
          {startList.map(a=><button className="learning-row" key={a.id} onClick={()=>nav.push("reader",{articleId:a.id})}>
            <span style={{minWidth:0}}><b className="serif" style={{display:"block",fontSize:15}}>{a.title}</b><small>{levelLabelOf(a)} · {minutesOf(a)} 分钟</small></span>
            <Icon name="chevr" size={15}/>
          </button>)}
        </section>
      </>}
      {q&&<p className="v2-search-total">找到 {total} 个结果</p>}
      {q&&inScope("docs")&&docs.length>0&&<>
        <div className="v2-sec-h"><b>原文与文章</b><span>{docs.length} 个结果</span></div>
        <section className="learning-card" style={{padding:"2px 14px"}}>
          {docs.slice(0,limits.docs).map((h,i)=><button className="learning-row v2-search-result" key={`${h.article.id}-${h.idx}-${i}`} onClick={()=>{actions.locateReader(h.article.id,h.idx);nav.push("reader",{articleId:h.article.id});}}>
            <span className="tx">
              <b className="serif" lang="en"><Mark text={h.en} q={q}/></b>
              {h.zh&&<small><Mark text={h.zh} q={q}/></small>}
              <small className="v2-result-source">{String(h.article.bookTitle || h.article.title)} · 第 {h.idx+1} 句</small>
            </span>
            <Icon name="chevr" size={15}/>
          </button>)}
        </section>
        {docs.length>limits.docs&&<button className="btn-ghost v2-more-results" style={{border:0}} onClick={()=>more("docs")}>再显示 {Math.min(6,docs.length-limits.docs)} 个结果</button>}
      </>}
      {q&&inScope("words")&&words.length>0&&<>
        <div className="v2-sec-h"><b>收藏的词与表达</b><span>{words.length} 个结果</span></div>
        <section className="learning-card" style={{padding:"2px 14px"}}>
          {words.slice(0,limits.words).map(w=><button className="learning-row v2-search-result" key={w.id} onClick={()=>setWordSheet(w.id)}>
            <span className="tx">
              <b className="serif" lang="en"><Mark text={w.word} q={q}/></b>
              <small><Mark text={vocabMeaning(w)} q={q}/></small>
              <small className="v2-result-source">生词本 · {w.senses[0]?.pos||"词条"}</small>
            </span>
            <Icon name="chevr" size={15}/>
          </button>)}
        </section>
        {words.length>limits.words&&<button className="btn-ghost v2-more-results" style={{border:0}} onClick={()=>more("words")}>再显示 {Math.min(6,words.length-limits.words)} 个结果</button>}
      </>}
      {q&&inScope("notes")&&notes.length>0&&<>
        <div className="v2-sec-h"><b>助记与口语纠偏</b><span>{notes.length} 个结果</span></div>
        <section className="learning-card" style={{padding:"2px 14px"}}>
          {notes.slice(0,limits.notes).map(n=><button className="learning-row v2-search-result" key={n.id} onClick={()=>nav.push("learningNote",{id:n.id})}>
            <span className="tx">
              <b><Mark text={n.title} q={q}/></b>
              <small><Mark text={n.body} q={q}/></small>
              <small className="v2-result-source">学习笔记{n.createdAt ? ` · ${new Date(n.createdAt).toLocaleDateString("zh-CN")}` : ""}</small>
            </span>
            <Icon name="chevr" size={15}/>
          </button>)}
        </section>
        {notes.length>limits.notes&&<button className="btn-ghost v2-more-results" style={{border:0}} onClick={()=>more("notes")}>再显示 {Math.min(6,notes.length-limits.notes)} 个结果</button>}
      </>}
      {q&&!visibleCount&&<section className="learning-card v2-empty-card">
        <h3>{total?"这个筛选中没有结果":"还没有找到匹配内容"}</h3>
        <p>{total?"保留关键词，看看其他类型的结果。":"试试更短的关键词，或换成英文 / 中文。"}</p>
        <button className="btn" style={{minWidth:160}} onClick={total?()=>setScope("all"):()=>setQuery("")}>{total?`查看全部 ${total} 个结果`:"清空后重新搜索"}</button>
        <button className="tlink" style={{display:"block",margin:"12px auto 0"}} onClick={()=>nav.push("learningImport")}>也可以导入自己的内容</button>
      </section>}
    </main>
    {wordSheet&&<WordDetailSheet wordId={wordSheet} onClose={()=>setWordSheet(null)}/>}
  </>;
}
