import { useState } from "react";
import { useLocalDraft } from "../core/useLocalDraft";
import { actions, activeRepository, flushPersist, getState, useApp } from "../store";
import { httpRequest } from "../services/cloud";
import { readClipboard } from "../services/device";
import { useNav } from "../ui/nav";
import type { Article } from "../core/types";
export function splitImportedText(text: string) {
  const paragraphs = text.replace(/\r/g,"").split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
  const sentences: Article["sentences"] = []; const paragraphStarts:number[]=[];
  paragraphs.forEach((paragraph,paragraphIdx)=>{paragraphStarts.push(sentences.length);const parts=paragraph.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)]*|$)/g)||[paragraph];for(const part of parts)if(part.trim())sentences.push({idx:sentences.length,paragraphIdx,en:part.trim(),zh:null,zhState:"empty"});});
  return {sentences,paragraphStarts};
}
export default function LearningImport() {
  const nav = useNav(); const scopeRepository = activeRepository(); const incoming = useApp(s => s.shareIn);
  const [draft, setDraft, ready, clearDraft] = useLocalDraft("reading-import", { mode: incoming?.text.startsWith("http") ? "url" as const : "paste" as const, input: incoming?.text || "", title: "", content: "", sourceUrl: "", preview: false });
  const { mode, input, title, content, sourceUrl, preview } = draft;
  const setMode = (mode: "paste" | "url") => setDraft(d => ({ ...d, mode }));
  const setInput = (input: string) => setDraft(d => ({ ...d, input }));
  const setTitle = (title: string) => setDraft(d => ({ ...d, title }));
  const setContent = (content: string) => setDraft(d => ({ ...d, content }));
  const setSourceUrl = (sourceUrl: string) => setDraft(d => ({ ...d, sourceUrl }));
  const setPreview = (preview: boolean) => setDraft(d => ({ ...d, preview }));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  async function prepare(){const target=scopeRepository;setBusy(true);setError("");try{if(target!==activeRepository())throw new Error("账号已切换，请重新打开导入");if(mode==="paste"){if(!input.trim())throw new Error("请先粘贴需要阅读的文字");setContent(input.trim());setSourceUrl("");setTitle(input.trim().split(/\n/)[0].slice(0,80));}else{const url=new URL(input.trim());if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw new Error("请输入公开网页的 HTTP(S) 地址");const response=await httpRequest(url.toString(),"GET",undefined,{},undefined,true);if(target!==activeRepository())throw new Error("账号已切换，已停止导入");if(response.status!==200)throw new Error(`网页暂时无法读取（${response.status}），可以改为粘贴正文`);const doc=new DOMParser().parseFromString(response.body,"text/html");doc.querySelectorAll("script,style,nav,header,footer,aside,form,noscript").forEach(el=>el.remove());const root=doc.querySelector("article,main,[role=main]")||doc.body;root.querySelectorAll("p,h1,h2,h3,br,li").forEach(el=>el.insertAdjacentText("afterend","\n\n"));const text=root.textContent?.replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim()||"";if(text.length<40)throw new Error("网页没有可读正文，可能需要登录或动态加载。请复制正文后粘贴");if(text.length>300000)throw new Error("正文过长，请分章粘贴，未截断原文");setContent(text);setTitle(doc.title.trim()||url.hostname);setSourceUrl(response.url);}setPreview(true);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function save(){const target=scopeRepository;setBusy(true);setError("");try{if(target!==activeRepository())throw new Error("账号已切换，请返回后重新打开导入");if(!content.trim())throw new Error("正文不能为空");if(content.length>300000)throw new Error("正文过长，请分章保存，未截断原文");const bytes=new TextEncoder().encode(content.trim());const digest=await crypto.subtle.digest("SHA-256",bytes);if(target!==activeRepository())throw new Error("账号已切换，请回原账号继续导入");const id="import-"+Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,24);if(!getState().articles.some(a=>a.id===id))actions.addArticle({id,title:title.trim()||"我的阅读",titleCn:"",...splitImportedText(content),sourceUrl,sourceType:mode,contentRevision:id,createdAt:Date.now()});await flushPersist();if(target!==activeRepository())throw new Error("账号已切换，原文在原账号保留");await clearDraft();actions.setShareIn(null);nav.replace("reader",{articleId:id});}catch(e){setError(String(e));}finally{setBusy(false);}}
  if (!ready) return <div className="learning-body" role="status">正在恢复导入草稿…</div>;
  return <><header className="learning-head"><button className="tlink" onClick={()=>preview?setPreview(false):nav.pop()}>返回</button><h1>{preview?"确认阅读内容":"加入阅读"}</h1></header><main className="learning-body">{preview?<><label>标题<input className="input" value={title} onChange={e=>setTitle(e.target.value)} maxLength={160}/></label><label>正文（保存前可以编辑）<textarea className="input" rows={16} value={content} onChange={e=>setContent(e.target.value)}/></label><p className="meta">{splitImportedText(content).sentences.length} 句 · 英文原文完整保留。译文可稍后添加。</p><button className="btn" disabled={busy} onClick={()=>void save()}>保存并开始阅读</button></>:<><div className="learning-seg"><button className={mode==="paste"?"on":""} onClick={()=>setMode("paste")}>粘贴文本</button><button className={mode==="url"?"on":""} onClick={()=>setMode("url")}>网页链接</button></div><textarea className="input" value={input} rows={10} onChange={e=>setInput(e.target.value)} maxLength={300000} placeholder={mode==="paste"?"把想读的英文粘贴到这里":"https://…"}/><button className="btn-ghost" onClick={async()=>{const text=await readClipboard();if(text)setInput(text);else setError("未读取到文字，请长按输入框粘贴");}}>从剪贴板粘贴</button><p className="meta">只在你操作时读取剪贴板。网页在这台设备提取，保存前先预览。</p><button className="btn" disabled={busy} onClick={()=>void prepare()}>{busy?"正在提取正文…":"预览内容"}</button><p className="meta">EPUB / PDF 请在 Windows 导入后接力到手机。</p></>}{error&&<p className="learning-error" role="alert">{error}</p>}</main></>;
}
