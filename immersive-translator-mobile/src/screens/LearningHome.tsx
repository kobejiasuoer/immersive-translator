import { useMemo, useState, type ReactNode } from "react";
import { useLocalDraft } from "../core/useLocalDraft";
import { ContentsSheet } from "../components/reading/ContentsSheet";
import { ReadingDrawer } from "../components/reading/Drawer";
import { chapterIndexOf, coverOf, coverTone, shelfItems, sourceOf, type ShelfItem } from "../core/readingLibrary";
import { minutesOf, levelLabelOf, timeLabelOf } from "../components/reading/meta";
import { BUILTIN_SCENES, customSceneTaskInput, practiceStepTitle } from "../components/speaking/scenes";
import { CustomSceneSheet } from "../components/speaking/CustomSceneSheet";
import { ReplacePracticeSheet } from "../components/speaking/ReplacePracticeSheet";
import { VoiceSettingsSheet } from "../components/speaking/VoiceSettingsSheet";
import { VaultBody, WordbookBody } from "../components/vault/VaultBody";
import { requestVaultSection, type VaultSection } from "../components/vault/sectionGate";
import { ExportPanel } from "../components/vault/ExportPanel";
import { WordDetailPage, WordDetailSheet } from "../components/vault/WordDetailSheet";
import { AddLearningNoteSheet } from "../components/vault/AddLearningNoteSheet";
import { actions, activeRepository, effectiveSentenceZh, flushPersist, readTodayCount, reviewStats, toast, useApp } from "../store";
import { createPracticeTask, type PracticeTask } from "../services/practice";
import { useCloud } from "../services/cloud";
import { useSyncStatus } from "../services/sync";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import { openAccountSheet } from "../components/account/accountGate";
import type { Article } from "../core/types";
export async function openPractice(nav: ReturnType<typeof useNav>, input: Parameters<typeof createPracticeTask>[0], options: { replace?: boolean } = {}) {
  const target = activeRepository();
  try {
    const task = createPracticeTask(input);
    await actions.upsertTask(task);
    if (target !== activeRepository()) throw new Error("账号已切换，练习保存在原账号。");
    /* replace：复盘页「同一主题，再练一轮」顶替当前练习页，不叠栈（speaking-parity）。 */
    if (options.replace) nav.replace("learningPractice", { taskId: task.id });
    else nav.push("learningPractice", { taskId: task.id });
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
}
/* 根页页头（proto-parity · 原型 rhead）：左上 monogram 圆章（右下状态点 + 账号副标，
   点按开账号页）+ 大标题 + 右上圆形按钮组（extra 由各根页传入，原型口径：阅读=生词本/搜索、
   口语=语音设置、笔记与复习=导出）。状态点：绿=已同步 / 黄=本机·待同步 / 转圈=同步中。 */
function Heading({ title, extra }: { title: string; extra?: ReactNode }) {
  const {account}=useCloud(); const sync=useSyncStatus();
  const stalled=!account||sync.phase==="offline"||sync.phase==="error";
  const dot=!account?"off":sync.phase==="syncing"?"ing":stalled?"off":"";
  const label=!account?"本机试用":stalled?"待同步":"账号与设置";
  const letter=account?(account.nickname||account.email||"I").trim().slice(0,1).toUpperCase():"I";
  return <header className="rhead">
    {/* proto-parity-2026-11-01：账号入口改呼出底部抽屉（原型 SHEETS.account），不再推入整页 */}
    <button className="account-entry" aria-label="账号与设置" onClick={openAccountSheet}>
      <span className="seal">{letter}<i className={dot||undefined}/></span>
      <small>{label}</small>
    </button>
    <h1 className="rtitle">{title}</h1>
    <div className="rhead-acts">{extra}</div>
  </header>;
}
function readingStarted(article: Article, progress: Record<string, number>) {
  return progress[article.id] !== undefined && (!!article.lastReadAt || progress[article.id] > 0);
}
function readingState(item: ShelfItem, progress: Record<string, number>, completed: Record<string, boolean>) {
  if (item.chapters.every(a => completed[a.id])) return "已读完";
  if (!item.chapters.some(a => readingStarted(a, progress))) return "未开始";
  const p = Math.min(progress[item.article.id] ?? 0, Math.max(0, item.article.sentences.length - 1));
  return `${item.kind === "book" ? `第 ${chapterIndexOf(item.article) + 1} 章 · ` : ""}第 ${p + 1} / ${item.article.sentences.length} 句`;
}
function ShelfCover({ item }: { item: ShelfItem }) {
  const cover = coverOf(item.article);
  const [broken, setBroken] = useState("");
  return <span className="reading-item-cover serif" data-tone={coverTone(item.id)} aria-hidden="true">
    {cover && broken !== cover ? <img className="reading-cover-image" src={cover} alt="" loading="lazy" onError={() => setBroken(cover)}/> : <><Icon name={item.kind === "book" ? "book" : "note"} size={18}/><span>{item.title.split(/\s+/).slice(0, 4).join(" ")}</span></>}
  </span>;
}
function ShelfCard({ item, onToc, onManage, version }: { item: ShelfItem; onToc?: () => void; onManage: () => void; version?: string }) {
  const nav = useNav(), progress = useApp(s => s.progress), completed = useApp(s => s.readingCompleted);
  const archived = item.chapters.every(a => a.archived);
  const state = archived ? "已移出 · 进度已保留" : readingState(item, progress, completed);
  return <article className={`learning-card reading-shelf-item ${item.kind === "book" ? "v2-shelf-book" : "article-card"}`} aria-label={item.title}>
    <div className="reading-item-row">
    <button className="reading-item-main" onClick={() => { if (archived) { item.kind === "book" ? actions.restoreBook(item.id) : actions.restoreArticle(item.id); } nav.push("reader", {articleId: item.article.id}); }}>
      <ShelfCover item={item}/>
      <span className="reading-item-copy">
        <b className="serif">{item.title}</b>
        <small className="reading-item-meta">{[typeof item.article.author === "string" ? item.article.author : "", sourceOf(item.article)].filter(Boolean).join(" · ")}{version ? ` · ${version}` : ""}</small>
        <small className="reading-item-meta">{item.kind === "book" ? `${item.chapters.length} 章` : `${item.article.sentences.length} 句 · 约 ${minutesOf(item.article)} 分钟`} · {levelLabelOf(item.article)}</small>
        <span className="reading-item-state">{state}</span>
      </span>
    </button>
    <div className="reading-item-actions">
      {onToc && <button className="tlink" aria-label={`${item.title}的目录`} title="目录" onClick={onToc}><Icon name="list" size={18}/></button>}
      <button className="tlink" aria-label={`整理 ${item.title}`} title="整理" onClick={onManage}><Icon name="dots" size={19}/></button>
    </div>
    </div>
  </article>;
}
function ArticleCard({ item, onManage, version }: { item: ShelfItem; onManage: () => void; version?: string }) {
  return <ShelfCard item={item} onManage={onManage} version={version}/>;
}
function BookCard({ item, onToc, onManage, version }: { item: ShelfItem; onToc: () => void; onManage: () => void; version?: string }) {
  return <ShelfCard item={item} onToc={onToc} onManage={onManage} version={version}/>;
}
export function ReadingHome() {
  const nav = useNav(), allArticles = useApp(s => s.articles), progress = useApp(s => s.progress), completed = useApp(s => s.readingCompleted);
  const stats = useApp(reviewStats), readToday = useApp(readTodayCount), vocabCount = useApp(s => s.vocab.length);
  const {account} = useCloud();
  const [toc, setToc] = useState<ShelfItem | null>(null), [manage, setManage] = useState<ShelfItem | null>(null), [name, setName] = useState("");
  const [type, setType] = useState<"all" | "book" | "article">("all"), [status, setStatus] = useState<"all" | "unread" | "reading" | "done" | "archived">("all");
  const items = useMemo(() => shelfItems(allArticles.filter(a => a.bookId || (a.sourceType !== "sample" || a.id !== "starter") || readingStarted(a, progress) || a.archived)), [allArticles, progress]);
  const visible = items.filter(item => {
    const archived = item.chapters.every(a => a.archived), done = item.chapters.every(a => completed[a.id]), started = item.chapters.some(a => readingStarted(a, progress));
    return (type === "all" || item.kind === type) && (status === "archived" ? archived : !archived && (status === "all" || status === "done" && done || status === "unread" && !started && !done || status === "reading" && started && !done));
  });
  const recent = allArticles.filter(a => !a.archived && readingStarted(a, progress)).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  const current = recent[0];
  const openCurrent = () => { const target = current || visible[0]?.article || allArticles.find(a => !a.archived); if (target) nav.push("reader", {articleId: target.id}); };
  const openVault = (section: VaultSection) => { requestVaultSection(section); actions.setTab("vocab"); };
  const openManage = (item: ShelfItem) => { setManage(item); setName(item.title); };
  const saveName = () => { if (!manage) return; try { manage.kind === "book" ? actions.renameBook(manage.id, name) : actions.renameArticle(manage.id, name); setManage(null); toast("名称已保存"); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } };
  return <>
    <Heading title="书架" extra={<><button className="ibtn" aria-label="打开生词本" onClick={() => openVault("words")}><Icon name="star"/></button><button className="ibtn" aria-label="搜索学习内容" onClick={() => nav.push("learningSearch")}><Icon name="search"/></button></>}/>
    <main className="learning-body reading-shelf-body">
      {!navigator.onLine && <div className="v2-offline-banner" role="status"><Icon name="phone" size={15}/>离线 · 已保存的内容可以继续读</div>}
      {current ? <article className="learning-card reading-resume">
        <div className="reading-resume-meta"><Icon name="bookopen" size={15}/><span>上次读到这里{current.lastReadAt ? ` · ${timeLabelOf(current.lastReadAt)}` : ""}</span></div>
        <h2 className="reading-resume-title serif">{String(current.bookTitle || current.title)}</h2>
        <p className="reading-resume-quote serif" lang="en">{current.sentences[progress[current.id] ?? 0]?.en}</p>
        <div className="reading-resume-progress"><span>{completed[current.id] ? "已读完" : `${current.bookId ? `第 ${chapterIndexOf(current) + 1} 章 · ` : ""}第 ${(progress[current.id] ?? 0) + 1} / ${current.sentences.length} 句`}</span><span>{completed[current.id] ? "100%" : `${Math.min(99, Math.round((progress[current.id] ?? 0) / Math.max(1, current.sentences.length) * 100))}%`}</span></div>
        <div className="reading-resume-actions"><button className="btn" onClick={openCurrent}>{completed[current.id] ? "再读这篇" : "继续阅读"}<Icon name="right" size={15}/></button>{current.bookId && <button className="btn-ghost" onClick={() => setToc(items.find(item => item.id === current.bookId) || null)}>目录</button>}</div>
      </article> : <section className="learning-card reading-resume starter-card">
        <span className="learning-tag">从一篇短文开始</span><h2>读一小段，学一个表达。</h2><p>点词查释义，点句查看解析；想练口语时再跟读。</p>
        <button className="btn" onClick={() => { const starter = allArticles.find(a => !a.archived && a.id === "starter") || allArticles.find(a => !a.archived); if (starter) nav.push("reader", {articleId: starter.id}); }}>开始阅读<Icon name="right" size={15}/></button>
      </section>}
      {!account && (vocabCount > 0 || readToday > 0) && <div className="v2-local-save"><span><Icon name="lock" size={13}/>记录已保存在这台手机</span><button onClick={openAccountSheet}>登录保存</button></div>}
      <div className="v2-today-row"><button onClick={openCurrent}><span><Icon name="book"/></span><b className="num">{readToday} 句</b><small>今日已读</small></button><button onClick={() => openVault("today")}><span><Icon name="mark"/></span><b className="num">{stats.due} 个</b><small>{stats.due ? "现在可复习" : "查看复习安排"}</small></button></div>
      <div className="v2-sec-h"><b>我的内容</b><button className="tlink" onClick={() => nav.push("learningImport")}><Icon name="plus" size={15}/>导入</button></div>
      {items.length > 0 && <div className="reading-shelf-toolbar">
        <div className="reading-shelf-filters" aria-label="内容类型">{([["all", "全部"], ["book", "书籍"], ["article", "短文"]] as const).map(([id, label]) => <button key={id} className={`learning-chip${type === id ? " on" : ""}`} aria-pressed={type === id} onClick={() => setType(id)}>{label}</button>)}</div>
        <select aria-label="筛选阅读状态" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option value="all">全部状态</option><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读完</option><option value="archived">已移出</option>
        </select>
      </div>}
      <div className="reading-shelf-summary">{visible.length ? `${visible.length} 项 · 最近阅读或导入的排在前面` : items.length ? "这个筛选下没有内容" : "书架还是空的，导入文章或选一本书开始。"}</div>
      {visible.map(item => { const duplicates = items.filter(other => other.title === item.title).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); const version = duplicates.length > 1 ? `${item.createdAt ? `导入 ${timeLabelOf(item.createdAt)} · ` : ""}版本 ${duplicates.indexOf(item) + 1}` : undefined; return item.kind === "book" ? <BookCard key={item.id} item={item} version={version} onToc={() => setToc(item)} onManage={() => openManage(item)}/> : <ArticleCard key={item.id} item={item} version={version} onManage={() => openManage(item)}/>; })}
      <div className="v2-sec-h"><b>找下一篇想读的</b></div>
      <section className="learning-card v2-discovery-list">{([["book", "精选经典", "先试读，再加入书架", () => nav.push("learningLibrary")], ["rss", "英文短文与资讯", "精选练习短文，也可订阅真实 RSS", () => nav.push("learningFeeds")], ["plus", "导入自己的内容", "粘贴正文或分享链接", () => nav.push("learningImport")]] as [string, string, string, () => void][]).map(([icon, title, subtitle, go]) => <button className="learning-row" key={title} onClick={go}><span style={{display:"flex", alignItems:"center", gap:12, minWidth:0}}><Icon name={icon} size={18}/><span className="tx"><b style={{display:"block"}}>{title}</b><small>{subtitle}</small></span></span><Icon name="right" size={15}/></button>)}</section>
    </main>
    <ContentsSheet open={!!toc} onClose={() => setToc(null)} title={toc ? `${toc.title} · 目录` : ""} articles={toc?.chapters || []} onPick={a => { setToc(null); if(a.archived) a.bookId ? actions.restoreBook(a.bookId) : actions.restoreArticle(a.id); nav.push("reader", {articleId:a.id}); }}/>
    <ReadingDrawer open={!!manage} onClose={() => setManage(null)} label="整理阅读内容">
      {manage && <div className="reading-manage-sheet"><div className="sheet-title plain">整理内容</div><label htmlFor="reading-item-name">名称</label><input id="reading-item-name" className="input" value={name} maxLength={160} onChange={e => setName(e.target.value)}/><button className="btn" onClick={saveName}>保存名称</button>{manage.kind === "article" && manage.article.sourceUrl && <button className="btn-ghost" onClick={() => { actions.setShareIn({text:manage.article.sourceUrl!,source:"shelf-refresh"}); setManage(null); nav.push("learningImport"); }}>重新提取原网页</button>}<p className="meta">移出后，阅读位置、收藏和笔记都会保留。可从「已移出」重新加入。</p><button className="btn-ghost" onClick={() => { const archived = manage.chapters.every(a => a.archived); if (manage.kind === "book") archived ? actions.restoreBook(manage.id) : actions.archiveBook(manage.id); else archived ? actions.restoreArticle(manage.id) : actions.archiveArticle(manage.id); setManage(null); }}>{manage.chapters.every(a => a.archived) ? "重新加入书架" : "移出书架"}</button></div>}
    </ReadingDrawer>
  </>;
}
/* ---------- 口语首页（speaking-parity · 原型 VIEWS.speak，html:2611-2623） ----------
   续练卡（v2-sp-resume：accent-soft）+ 开始卡（v2-sp-start：一个表达一句就好）+
   四内置场景（级别 .lv 描边 chip）/我的场景/创建场景 + 跟读正在读的内容 +
   最近练习（3 条，「查看全部」整页：原型 VIEWS.sessionHistory）+ 页头「语音与口音」抽屉。 */
export function SpeakingHome() {
  const nav=useNav();
  const tasks=useApp(s=>s.tasks);
  const words=useApp(s=>s.vocab);
  const customScenes=useApp(s=>s.customScenes);
  const articles=useApp(s=>s.articles);
  const progress=useApp(s=>s.progress);
  const [pending,setPending]=useState<Parameters<typeof createPracticeTask>[0]|null>(null);
  const [sceneSheet,setSceneSheet]=useState(false);
  const [voiceSheet,setVoiceSheet]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false);
  const sorted=[...tasks].sort((a,b)=>b.updatedAt-a.updatedAt);
  const unfinished=sorted.find(t=>t.status!=="completed");
  const unfinishedAnswered=new Set((unfinished?.attempts??[]).filter(a=>a.feedback).map(a=>a.step)).size;
  const recent=sorted.slice(0,3);
  const readyWords=words.filter(w=>!w.paused).slice(0,3);
  /* 词专项任务：任务句用原型英文口径（html:2335 Try one short sentence using "…"），
     标题用「用 X 说一句」（最近练习/续练卡可读，原型 html:1693 seed 同款）。 */
  const wordInput=(word:string,origin?:{articleId:string;sentenceIdx:number}):Parameters<typeof createPracticeTask>[0]=>
    ({mode:"word",title:`用 ${word} 说一句`,word,reference:`Try one short sentence using "${word}".`,
      ...(origin?{source:origin}:{})});
  const vocabChoice=(w:typeof readyWords[number])=>wordInput(w.word,w.sourceArticleId?{articleId:w.sourceArticleId,sentenceIdx:w.sourceSentenceIdx??0}:undefined);
  /* 「跟读正在读的内容」：最近在读文档的当前句起，最多 3 句（复用 follow 模式）。 */
  const reading=[...articles].filter(a=>!a.archived&&progress[a.id]!==undefined).sort((a,b)=>(b.lastReadAt||0)-(a.lastReadAt||0))[0];
  const followLines=reading?[...reading.sentences].sort((x,y)=>x.idx-y.idx).filter(s=>s.idx>=(progress[reading.id]??0)).slice(0,3).map(s=>s.en):[];
  /* 无生词时的默认词（原型 html:2614 words[0] || doc.terms[0]；原型 doc 缺省即入门文 starter，html:1579，
     所以首次打开也有 take a break chip）：优先当前阅读文档的预置词条；当前文档没有词条（书目章节/导入文）
     或还没开始读时，回退到书架上带预置词条的文章（首启种子入门文「A Small Break」→ take a break），
     仍无则不渲染 chip、按钮 toast 引导。Article.terms 由内容源提供（types.ts 可选字段）。 */
  const hasTerms=(a:typeof articles[number]|undefined)=>Boolean(a?.terms?.some(w=>w?.trim()));
  const termDoc=hasTerms(reading)?reading:[...articles].filter(a=>!a.archived&&hasTerms(a)).sort((a,b)=>(b.lastReadAt||0)-(a.lastReadAt||0))[0];
  const defaultWord=readyWords[0]?.word??termDoc?.terms?.find(w=>w?.trim());
  /* 主按钮/续练卡「开始一轮新练习」的任务入参：有生词时与点第一枚 chip 同一口径（出处=该词的收藏句）；
     预置词回退时出处取该词所在句（看看中文/回到原句可回查），找不到含词句再沿用阅读进度所在句。 */
  const defaultWordInput=()=>{
    if(readyWords[0]) return vocabChoice(readyWords[0]);
    const word=defaultWord!;
    const origin=termDoc?{articleId:termDoc.id,sentenceIdx:termDoc.sentences.find(s=>s.en.toLowerCase().includes(word.toLowerCase()))?.idx??progress[termDoc.id]??0}:undefined;
    return wordInput(word,origin);
  };
  const startDefault=()=>{ if(defaultWord) void begin(defaultWordInput()); else toast("先从生词本挑一个表达，或从下面的场景开始。"); };
  /* 已有未完成练习时，先走「练习选择」三选抽屉再决定新旧去留。 */
  const begin=async(input:Parameters<typeof createPracticeTask>[0])=>{ if(unfinished){setPending(input);return;} await openPractice(nav,input); };
  /* 「开启麦克风」：抽屉里直接向系统请求权限（真实链路），结果以 toast 反馈。 */
  if(historyOpen) return <SpeakingHistory sorted={sorted} onBack={()=>setHistoryOpen(false)}/>;
  return <>
  <Heading title="口语" extra={<button className="ibtn" aria-label="语音与朗读" onClick={()=>setVoiceSheet(true)}><Icon name="wave"/></button>}/>
  <main className="learning-body">
    {unfinished&&<article className="learning-card v2-sp-resume">
      <div className="v2-sp-overline">上次练到这里</div>
      <h2>{unfinished.title}</h2>
      <p>{practiceStepTitle(unfinished)} · 已回答 {unfinishedAnswered} / {unfinished.steps?.length||1} 步</p>
      <button className="btn" onClick={()=>nav.push("learningPractice",{taskId:unfinished.id})}><Icon name="mic" size={15}/>继续上次练习</button>
      <button className="v2-sp-text-action" onClick={()=>{ if(defaultWord) void begin(defaultWordInput()); else toast("先从生词本挑一个表达，或从下面的场景开始。"); }}>开始一轮新练习</button>
    </article>}
    <article className="learning-card v2-sp-start">
      <div className="v2-sp-overline">先把读过的表达用起来</div>
      <h2>一个表达，一句就好</h2>
      <p>{readyWords.length?"从生词本选一个表达，试着说说自己的事。":"从刚读到的表达开始，可以先听、跟读，再换成自己的话。"}</p>
      {readyWords.length>0&&<div className="v2-sp-word-choices">{readyWords.map(w=><button key={w.id} className="v2-sp-word-choice" onClick={()=>void begin(vocabChoice(w))}><b lang="en">{w.word}</b><Icon name="mic" size={15}/></button>)}</div>}
      {readyWords.length===0&&defaultWord&&<div className="v2-sp-word-choices"><button className="v2-sp-word-choice" onClick={()=>void begin(defaultWordInput())}><b lang="en">{defaultWord}</b><Icon name="mic" size={15}/></button></div>}
      {/* 原型 html:2619：有进行中练习时主按钮让位为描边次按钮（btn 无 primary），无续练卡时才是实底主按钮 */}
      <button className={unfinished?"btn-ghost":"btn"} onClick={startDefault}><Icon name="mic" size={15}/>开始一句短练习</button>
      {words.length>0&&<button className="v2-sp-text-action" onClick={()=>nav.push("learningWordbook")}>去生词本挑一个</button>}
    </article>
    <div className="v2-sec-h"><b>在生活里练一练</b><span>按沟通任务练</span></div>
    <section className="learning-card" style={{padding:"4px 14px"}}>
      {BUILTIN_SCENES.map(scene=><button className="learning-row" style={{borderBottom:"1px solid var(--hairline)",minHeight:72}} key={scene.title} onClick={()=>void begin({mode:"scenario",title:`场景对话 · ${scene.title}`,reference:scene.steps[0].prompt,steps:scene.steps.map(s=>s.prompt)})}>
        <span style={{minWidth:0}}><b style={{display:"block"}}>{scene.title}</b><small>{scene.description}</small></span>
        <span style={{display:"flex",alignItems:"center",gap:8,flex:"none"}}><span className="lv">{scene.level}</span><Icon name="right" size={15}/></span>
      </button>)}
      {customScenes.map(scene=><button className="learning-row" style={{borderBottom:"1px solid var(--hairline)"}} key={scene.id} onClick={()=>void begin(customSceneTaskInput(scene))}>
        <span style={{minWidth:0}}><b style={{display:"block"}}>{scene.title}</b><small>{scene.goal}</small></span>
        <span style={{display:"flex",alignItems:"center",gap:8,flex:"none"}}><span className="learning-tag">我的场景</span><Icon name="right" size={15}/></span>
      </button>)}
      <button className="learning-row" style={{borderBottom:"none"}} onClick={()=>setSceneSheet(true)}>
        <span style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <span style={{color:"var(--accent)",flex:"none"}}><Icon name="plus" size={18}/></span>
          <span style={{minWidth:0}}><b style={{display:"block"}}>创建我的场景</b><small>给一个主题，分三步说清楚</small></span>
        </span>
        <Icon name="right" size={15}/>
      </button>
    </section>
    <div className="v2-sec-h"><b>跟读正在读的内容</b><span>同一篇，同一句</span></div>
    {reading&&followLines.length?<section className="learning-card">
      {/* follow 任务标题用原型口径「跟读原文」（html:2337；复盘 nhead 副标/最近练习列表同源） */}
      <button className="learning-row" style={{borderBottom:"none"}} onClick={()=>void begin({mode:"follow",title:"跟读原文",reference:followLines[0],steps:followLines,source:{articleId:reading.id,sentenceIdx:progress[reading.id]??0}})}>
        <span style={{minWidth:0}}><b style={{display:"block"}}>{reading.title}</b><small>从第 {(progress[reading.id]??0)+1} 句开始，最多练 {followLines.length} 句</small></span>
        <Icon name="right" size={15}/>
      </button>
    </section>:<p className="learning-empty">先打开一篇文章，读到哪句就跟读哪句。</p>}
    {/* 「最近练习」右端（原型 html:2621）：有记录即给「查看全部」整页入口（列表只列最近 3 条），无记录为引导副文 */}
    <div className="v2-sec-h"><b>最近练习</b>{sorted.length?<button className="tlink" style={{fontSize:12.5}} onClick={()=>setHistoryOpen(true)}>查看全部</button>:<span>从今天这一句开始</span>}</div>
    <section className="learning-card" style={{padding:"4px 14px"}}>
      {recent.length?recent.map(task=><button className="learning-row" style={{borderBottom:"1px solid var(--hairline)"}} key={task.id} onClick={()=>nav.push("learningPractice",{taskId:task.id})}>
        <span style={{minWidth:0}}><b style={{display:"block"}}>{task.title}</b><small>{when(task.updatedAt)} · {task.attempts.length} 次回答 · {task.status==="completed"?"本轮完成":"部分完成"}</small></span>
        <Icon name="right" size={15}/>
      </button>):<p className="learning-empty" style={{padding:"14px 4px"}}>还没有练习记录。第一句说完后，就能在这里回看。</p>}
    </section>
    <p className="learning-local">练习文字与反馈跟账号同步，原声留在录制的设备。</p>
  </main>
  <ReplacePracticeSheet open={!!pending} title={unfinished?.title??""} answered={unfinishedAnswered}
    onClose={()=>setPending(null)}
    onContinue={()=>{ const target=unfinished; setPending(null); if(target) nav.push("learningPractice",{taskId:target.id}); }}
    onReplace={()=>{ const target=unfinished; const input=pending; setPending(null);
      /* 结束旧的：已有作答先静默归档为复盘（无作答也一并结束，避免悬挂的「继续上次」），再开新练习。 */
      void (async()=>{ if(target) await actions.upsertTask({...target,status:"completed"}); if(input) await openPractice(nav,input); })().catch(e=>toast(String(e)));
    }}/>
  <CustomSceneSheet open={sceneSheet} onClose={()=>setSceneSheet(false)} onSave={scene=>{
    try { actions.saveCustomScene(scene); setSceneSheet(false); void begin(customSceneTaskInput(scene)); }
    catch(e){ toast(String(e)); }
  }}/>
  <VoiceSettingsSheet open={voiceSheet} onClose={()=>setVoiceSheet(false)}/>
  </>;
}
/* 时间标签（原型 timeLabel 口径）：今天/昨天带 HH:MM，更早 M/D HH:MM。练习记录详情页头副标同用（LearningPractice）。 */
export function when(at:number){ const d=new Date(at),now=new Date(); const hm=d.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}); if(d.toDateString()===now.toDateString()) return `今天 ${hm}`; const yesterday=new Date(now); yesterday.setDate(now.getDate()-1); if(d.toDateString()===yesterday.toDateString()) return `昨天 ${hm}`; return `${d.getMonth()+1}/${d.getDate()} ${hm}`; }
/* 练习记录整页（speaking-parity · 原型 VIEWS.sessionHistory，html:2649）：
   「查看全部」从口语首页进入，nhead 标题+副标，全部任务按行列出（本轮完成/部分完成）。 */
function SpeakingHistory({ sorted,onBack }:{ sorted:PracticeTask[]; onBack:()=>void }) {
  const nav=useNav();
  return <>
    <header className="learning-head nhead">
      <button className="tlink" aria-label="返回" onClick={onBack}><Icon name="left" size={18}/></button>
      <div className="nt"><h1>练习记录</h1><small>每次自己的回答，都能回看</small></div>
      <span />
    </header>
    <main className="learning-body" style={{ paddingTop: 0 }}>
      <section className="learning-card" style={{padding:"4px 14px",marginTop:0}}>
        {sorted.length?sorted.map(task=><button className="learning-row" style={{borderBottom:"1px solid var(--hairline)"}} key={task.id} onClick={()=>nav.push("learningPractice",{taskId:task.id})}>
          <span style={{minWidth:0}}><b style={{display:"block"}}>{task.title}</b><small>{when(task.updatedAt)} · {task.attempts.length} 次回答 · {task.status==="completed"?"本轮完成":"部分完成"}</small></span>
          <Icon name="right" size={15}/>
        </button>):<p className="learning-empty" style={{padding:"14px 4px"}}>还没有练习记录。</p>}
      </section>
    </main>
  </>;
}
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
      <button className="tlink" aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={18}/></button>
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
    return <><header className="learning-head"><button className="tlink" onClick={nav.pop}>返回</button><h1>写一条学习笔记</h1><span style={{width:44}}/></header>
      <form className="learning-body" onSubmit={e=>{e.preventDefault();if(target!==activeRepository()){toast("账号已切换，请重新打开笔记");return;}actions.saveNote({id:crypto.randomUUID(),title:title||"学习笔记",body,sub:"我的心得",insight:"",createdAt:Date.now()});void flushPersist().then(clearDraft).then(()=>{toast("笔记已保存");nav.pop();}).catch(e=>toast(String(e)));}}>
        <label>标题（选填）<input className="input" value={title} maxLength={100} placeholder="今天学到的小发现" onChange={e=>setTitle(e.target.value)}/></label>
        <label>内容<textarea className="input" rows={12} required value={body} maxLength={6000} onChange={e=>setBody(e.target.value)}/></label>
        <button className="btn">保存笔记</button>
      </form></>;
  }
  return <>
    <header className="learning-head nhead">
      <button className="tlink" aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={18}/></button>
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
  const words=state.vocab.filter(w=>w.word.toLowerCase().includes(q)||w.senses.some(s=>s.cn.toLowerCase().includes(q)));
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
    <header className="learning-head nhead"><button className="iconbtn" aria-label="返回" onClick={()=>nav.pop()}><Icon name="left" size={20}/></button><div className="nt"><h1>搜索</h1><small>文章、词条与笔记一起找</small></div><span/></header>
    <main className="learning-body">
      <div className="v2-search-toolbar">
        <label className="v2-search-field">
          <Icon name="search" size={17}/>
          <input className="input" type="search" value={query} maxLength={80} onChange={e=>setQuery(e.target.value)} placeholder="英文、中文或文章标题…" aria-label="搜索学习内容"/>
        </label>
        {query&&<button className="v2-search-clear" aria-label="清空关键词" onClick={()=>setQuery("")}><Icon name="close" size={16}/></button>}
      </div>
      <div className="v2-filter-row">
        {([["all","全部",total],["docs","原文",docs.length],["words","词条",words.length],["notes","笔记",notes.length]] as const).map(([id,label,count])=>
          <button key={id} className={`learning-chip${scope===id?" on":""}`} aria-pressed={scope===id} onClick={()=>setScope(id)}>{label}{q&&id!=="all"?` ${count}`:""}</button>)}
      </div>
      {!q&&<>
        <div className="v2-search-start">
          <p>搜文章标题、原句、收藏或纠偏，都能回到来源。</p>
          <div className="v2-search-suggestions">{["take a break","休息","quiet"].map(t=><button key={t} className="learning-chip" onClick={()=>setQuery(t)}>{t}</button>)}</div>
        </div>
        <div className="v2-sec-h"><b>最近读过 / 推荐开始</b></div>
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
              <small><Mark text={w.senses.map(s=>s.cn).join("；")} q={q}/></small>
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
