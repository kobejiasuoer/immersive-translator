import { useEffect, useRef, useState } from "react";
import { useLocalDraft } from "../core/useLocalDraft";
import { actions, activeRepository, flushPersist, getState, toast, useApp } from "../store";
import { httpRequest } from "../services/cloud";
import { invokeRaw } from "../services/device";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import { extractReadingPage, importedTitle, readingContentKey, splitReadingText } from "../core/readingLibrary";
export const splitImportedText = splitReadingText;
/** 预览时长（原型 minutes 口径：约 130 词/分钟）。 */
function previewMinutes(text: string): number {
  const words = (text.match(/[A-Za-z0-9'’-]+/g) || []).length;
  return Math.max(1, Math.ceil(words / 130));
}
export default function LearningImport({ shareQueueId }: { shareQueueId?: string } = {}) {
  const nav = useNav(); const scopeRepository = activeRepository(); const incoming = useApp(s => s.shareIn);
  const [draft, setDraft, ready, clearDraft] = useLocalDraft("reading-import", { mode: incoming?.text.startsWith("http") ? "url" as const : "paste" as const, input: incoming?.text.startsWith("http") ? "" : incoming?.text || "", url: incoming?.text.startsWith("http") ? incoming.text : "", title: "", content: "", sourceUrl: "", preview: false });
  const { mode, input, url, title, content, sourceUrl, preview } = draft;
  const setMode = (mode: "paste" | "url") => setDraft(d => ({ ...d, mode }));
  const setInput = (input: string) => setDraft(d => ({ ...d, input }));
  const setUrl = (url: string) => setDraft(d => ({ ...d, url }));
  const setTitle = (title: string) => setDraft(d => ({ ...d, title }));
  const setContent = (content: string) => setDraft(d => ({ ...d, content }));
  const setSourceUrl = (sourceUrl: string) => setDraft(d => ({ ...d, sourceUrl }));
  const setPreview = (preview: boolean) => setDraft(d => ({ ...d, preview }));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  /* ---------- Safari 入站分享队列接线（App.tsx 消费队列后把 shareQueueId 传入） ----------
     · 确认保存（save 成功落库）→ share_queue_ack 删除队列项（恰好一次）；
     · 未保存离开（返回/切走）→ share_queue_clear 删除 + toast「未保存」。
     清除排在 500ms 延迟定时器上：React StrictMode 开发期的 mount→cleanup→mount 会立即
     重挂载并在下个 effect 里取消定时器，真机生产构建无此行为、真实卸载后定时器生效。
     ack 失败时队列项保留（可恢复输入），下次启动重新进入预览；文章 id 是正文哈希，
     重复确认也不会保存出重复文章。 ---------- */
  const ackedRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (clearTimerRef.current !== null) { /* StrictMode 二次挂载：取消即将执行的清除 */
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    return () => {
      const id = shareQueueId;
      if (!id || ackedRef.current) return;
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null;
        void invokeRaw("share_queue_clear", { id })
          .then(() => toast("已取消，分享内容未保存"))
          .catch((e) => toast(`清除分享队列失败：${e}`));
      }, 500);
    };
  }, [shareQueueId]);
  /* 队列项进入时以分享内容重置导入草稿：旧草稿可能是上次未保存的输入，直接沿用
     会让分享内容进不了预览（深链 shareIn 同样受益）。相等时不重写避免循环。 */
  useEffect(() => {
    if ((!shareQueueId && incoming?.source !== "shelf-refresh") || !ready || !incoming) return;
    const mode = incoming.text.startsWith("http") ? "url" as const : "paste" as const;
    setDraft(d => (d.input === incoming.text && d.url === incoming.text && d.mode === mode && !d.preview) ? d : { ...d, mode, input: mode === "paste" ? incoming.text : "", url: mode === "url" ? incoming.text : "", title: "", content: "", sourceUrl: "", preview: false });
    // setDraft 每次渲染都是新引用，不进依赖（等值守卫已防重写循环）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareQueueId, ready, incoming]);

  async function prepare() {
    const target = scopeRepository; setBusy(true); setError("");
    try {
      if (target !== activeRepository()) throw new Error("账号已切换，请重新打开导入");
      if (mode === "paste") {
        if (!input.trim()) throw new Error("请先粘贴需要阅读的文字");
        setContent(input.trim()); setSourceUrl("");
      } else {
        let urlObj: URL;
        try { urlObj = new URL(url.trim()); } catch { throw new Error("请输入完整的 http 或 https 文章链接。"); }
        if (!["http:", "https:"].includes(urlObj.protocol) || urlObj.username || urlObj.password) throw new Error("请输入公开网页的 HTTP(S) 地址");
        let response;
        try { response = await httpRequest(urlObj.toString(), "GET", undefined, {}, undefined, true); }
        catch { throw new Error("这篇网页暂时无法提取正文。链接已保留，请复制英文正文后切换到粘贴。"); }
        if (target !== activeRepository()) throw new Error("账号已切换，已停止导入");
        if (response.status !== 200) throw new Error(`网页暂时无法读取（${response.status}），可以改为粘贴正文`);
        const page = extractReadingPage(response.body);
        if (page.text.length < 40) throw new Error("网页没有可读正文，可能需要登录或动态加载。请复制正文后粘贴");
        if (page.text.length > 300000) throw new Error("正文过长，请分章粘贴，未截断原文");
        setContent(page.text); setTitle(title.trim() || page.title || urlObj.hostname); setSourceUrl(response.url || urlObj.toString());
      }
      setPreview(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function save() {
    const target = scopeRepository; setBusy(true); setError("");
    try {
      if (target !== activeRepository()) throw new Error("账号已切换，请返回后重新打开导入");
      if (!content.trim()) throw new Error("正文不能为空");
      if (content.length > 300000) throw new Error("正文过长，请分章保存，未截断原文");
      const split = splitImportedText(content), contentKey = readingContentKey(split);
      if (!split.sentences.length) throw new Error("正文没有可阅读的句子，请检查内容");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentKey));
      if (target !== activeRepository()) throw new Error("账号已切换，请回原账号继续导入");
      const existing = getState().articles.find(a => !a.bookId && readingContentKey(a) === contentKey);
      const id = existing?.id || "import-" + Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
      if (existing) { if (existing.archived) actions.restoreArticle(existing.id); toast("这篇正文已保存，已打开原有阅读位置"); }
      else actions.addArticle({id, title: importedTitle(title, content), titleCn: "", ...split, sourceUrl, sourceType: mode, contentRevision: id, createdAt: Date.now()});
      await flushPersist();
      if (target !== activeRepository()) throw new Error("账号已切换，原文在原账号保留");
      if (shareQueueId && !ackedRef.current) { ackedRef.current = true; void invokeRaw("share_queue_ack", {id: shareQueueId}).catch(e => toast(`确认导入状态失败：${e}`)); }
      await clearDraft(); actions.setShareIn(null); nav.replace("reader", {articleId: id});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (!ready) return <div className="learning-body" role="status">正在恢复导入草稿…</div>;
  const previewSentences = splitImportedText(content).sentences;
  const previewTitle = importedTitle(title, content);
  return <>
    <header className="learning-head nhead">
      <button className="iconbtn" aria-label="返回" onClick={()=>preview?setPreview(false):nav.pop()}><Icon name="left" size={20}/></button>
      <div className="nt"><h1>{preview?"确认正文":"导入自己的内容"}</h1><small>{preview?"保存前可以核对和修改":"预览确认之后，再加入书架"}</small></div>
      <span/>
    </header>
    <main className="learning-body">
      {preview ? <>
        {/* 只读预览卡（原型 VIEWS.importPreview，html:2106-2109）：tag + 23px 衬线标题 + 分句正文 */}
        <section className="learning-card v2-import-preview">
          <span className="learning-tag">{previewSentences.length} 句 · 约 {previewMinutes(content)} 分钟</span>
          <h1>{previewTitle}</h1>
          <details className="reading-import-edit"><summary>修改标题或正文</summary><label htmlFor="preview-title">标题</label><input id="preview-title" className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} placeholder={previewTitle}/><label htmlFor="preview-content">完整正文</label><textarea id="preview-content" className="input" rows={12} value={content} maxLength={300000} onChange={e => setContent(e.target.value)}/></details>
          <div className="v2-preview-prose">
            {previewSentences.slice(0, 8).map(s => <p className="en" key={s.idx} lang="en">{s.en}</p>)}
            {previewSentences.length > 8 && <p className="v2-preview-more">还有 {previewSentences.length - 8} 句，保存后继续阅读。</p>}
          </div>
        </section>
        <p className="v2-inline-note">按自然段保存完整原文。网页内容请核对；可展开修改标题和正文。</p>
        <div className="v2-preview-actions">
          {error&&<div className="v2-form-error" role="alert"><Icon name="info" size={14}/><span>{error}</span></div>}
          <button className="btn" disabled={busy} onClick={()=>void save()}>保存并开始阅读</button>
          <button className="btn-ghost" style={{border:"1px solid var(--hairline-strong)"}} onClick={()=>setPreview(false)}>返回修改</button>
        </div>
      </> : <>
        <div className="learning-seg soft" role="tablist" aria-label="导入方式">
          <button className={mode==="paste"?"on":""} onClick={()=>setMode("paste")}>粘贴英文正文</button>
          <button className={mode==="url"?"on":""} onClick={()=>setMode("url")}>网页链接</button>
        </div>
        <section className="learning-card v2-import-form">
          <div className="v2-field">
            <label htmlFor="import-title">标题<span>可不填</span></label>
            <input id="import-title" className="input" value={title} onChange={e=>setTitle(e.target.value)} maxLength={160} placeholder="给这篇文章起个名字"/>
          </div>
          {mode==="paste" ? <>
            <div className="v2-field">
              <label htmlFor="import-text">英文正文<span>支持一段或多段</span></label>
              <textarea id="import-text" className="input" rows={7} value={input} onChange={e=>setInput(e.target.value)} maxLength={300000} placeholder="从邮件、文章或自己的笔记中复制英文…"/>
            </div>
            <p className="v2-import-caption">只保存你确认的正文，不会保存剪贴板上的其他内容。</p>
          </> : <>
            <div className="v2-field">
              <label htmlFor="import-url">文章链接</label>
              <input id="import-url" className="input" type="url" inputMode="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://..."/>
            </div>
            {/* 分享指引（原型 .v2-share-guide，html:633-635） */}
            <div className="v2-share-guide">
              <Icon name="share" size={15}/>
              <p>在浏览器找到文章后，点「分享」并选择沉浸口语；也可以直接把链接粘贴在这里。</p>
            </div>
          </>}
          {error&&<div className="v2-form-error" role="alert"><Icon name="info" size={14}/><span>{error}</span></div>}
          {busy&&<p className="v2-import-loading" role="status">正在准备正文预览…</p>}
          <button className="btn" disabled={busy} onClick={()=>void prepare()}>{busy?"准备预览中…":"预览正文"}</button>
          {mode==="url"&&<button className="tlink v2-full-link" style={{justifyContent:"center",fontSize:12.5}} onClick={()=>{setMode("paste");setError("");toast("链接已保留，粘贴正文后继续");}}>提取不成功？改为粘贴英文正文</button>}
        </section>
        <p className="v2-inline-note">手机上先从短文开始。EPUB / PDF 可在电脑端导入，登录同一账号后从书架接着读。</p>
      </>}
    </main>
  </>;
}
