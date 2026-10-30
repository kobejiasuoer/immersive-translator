import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
// Source rendering exercises real React/hooks/store; cloud is deliberately unavailable.
const dir=await mkdtemp(join(tmpdir(),'ita-smoke-')),outfile=join(dir,'app.mjs');
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:4199/',pretendToBeVisual:true}),w=dom.window;
const errors=[],network=[],oldError=console.error;let api,root,checks=0;
const originalTimers={setTimeout,clearTimeout,setInterval,clearInterval},timeouts=new Set(),intervals=new Set();
globalThis.setTimeout=(fn,ms,...args)=>{const id=originalTimers.setTimeout(()=>{timeouts.delete(id);fn(...args);},ms);timeouts.add(id);return id;};
globalThis.clearTimeout=id=>{timeouts.delete(id);originalTimers.clearTimeout(id);};
globalThis.setInterval=(fn,ms,...args)=>{const id=originalTimers.setInterval(fn,ms,...args);intervals.add(id);return id;};
globalThis.clearInterval=id=>{intervals.delete(id);originalTimers.clearInterval(id);};
w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){}});
w.scrollTo=()=>{};
for(const name of ['scrollIntoView','scrollTo','setPointerCapture','releasePointerCapture'])w.HTMLElement.prototype[name]=function(){};
class Observer{observe(){}unobserve(){}disconnect(){}}
w.ResizeObserver=Observer;w.IntersectionObserver=Observer;
w.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
w.speechSynthesis={cancel(){},speak(){},getVoices:()=>[],speaking:false};
for(const name of ['document','localStorage','location','history','CustomEvent','Node','Element','HTMLElement','SVGElement','DOMParser','Event','MouseEvent','KeyboardEvent','MutationObserver','ResizeObserver','IntersectionObserver','SpeechSynthesisUtterance','speechSynthesis'])globalThis[name]=w[name];
globalThis.window=w;globalThis.getComputedStyle=w.getComputedStyle.bind(w);globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);globalThis.matchMedia=w.matchMedia;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:w.navigator});globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
globalThis.fetch=async url=>{network.push(String(url));throw Error('Smoke network unavailable');};
console.error=(...args)=>{errors.push(args.map(String).join(' '));oldError(...args);};
w.addEventListener('error',e=>errors.push(e.error?.stack||e.message));
const rejected=e=>errors.push(e?.stack||String(e));process.on('unhandledRejection',rejected);
const wait=ms=>new Promise(r=>setTimeout(r,ms)),q=(s,p=document)=>p?.querySelector(s),all=(s,p=document)=>[...(p?.querySelectorAll(s)||[])];
const text=e=>e?.textContent?.replace(/\s+/g,' ').trim()||'',top=()=>all('.push:not(.out)').at(-1),pane=()=>q('.pane.on');
const button=(label,p=document)=>all('button',p).find(e=>text(e)===label||e.getAttribute('aria-label')===label);
function click(e){assert.ok(e,'Expected clickable element');assert.notEqual(e.disabled,true);e.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));}
function type(e,value){assert.ok(e,'Expected input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new w.Event('input',{bubbles:true}));}
async function until(fn,label){for(let i=0;i<175;i++){if(fn())return;if(errors.length)throw Error(errors.join(' | '));await wait(20);}throw Error(label+' timed out: '+text(top()||pane()).slice(0,800));}
function ok(value,label){assert.ok(value,label);checks++;console.log('PASS '+label);}
async function back(){click(button('返回',top()));await wait(380);}
async function importPreview(value){click(all('button',pane()).find(e=>text(e).startsWith('加入阅读')));await until(()=>top()?.getAttribute('aria-label')==='加入阅读'&&q('textarea',top()),'Import');if(!q('textarea[rows="10"]',top())){click(button('返回',top()));await wait(40);}type(q('textarea',top()),value);await wait(40);click(button('预览内容',top()));await until(()=>button('保存并开始阅读',top()),'Preview');}
try{
 await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import App from './App';export{actions,initializeStore,activeRepository,getState,flushPersist}from'./store';export function mount(){let r=createRoot(document.getElementById('root'));r.render(React.createElement(React.StrictMode,null,React.createElement(App)));return r;}",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),sourcefile:'smoke.tsx',loader:'tsx'},outfile,bundle:true,platform:'browser',format:'esm',jsx:'automatic',define:{'import.meta.env.DEV':'true','import.meta.env.VITE_API_BASE_URL':JSON.stringify('https://smoke.invalid'),'process.env.NODE_ENV':JSON.stringify('development')}});
 api=await import(pathToFileURL(outfile).href);await api.initializeStore('smoke-'+crypto.randomUUID());root=api.mount();
 await until(()=>q('.learning-onboarding'),'Onboarding');ok(all('.glass-nav .tab').length===3,'three primary tabs');ok(api.getState().vocab.length===0&&api.getState().tasks.length===0,'no fake history');
 click(button('开始我的第一篇阅读',q('.learning-onboarding')));await until(()=>!q('.learning-onboarding'),'Onboarding complete');
 for(const [i,key]of [[1,'practice'],[2,'vocab'],[0,'today']]){click(all('.glass-nav .tab')[i]);await until(()=>api.getState().tab===key,'Tab');await wait(40);}ok(all('.glass-nav .tab[aria-current="page"]').length===1,'single selected tab');
 click(all('.article-card',pane())[0]);await until(()=>q('.tok.ck',top()),'Sample reader');const sampleId=api.getState().readingArticleId;
 click(q('.tok.ck',top()));await until(()=>q('.sheet.on'),'Dictionary');ok(text(q('.sheet.on')).includes('来自《'),'dictionary source sentence');
 click(button('收藏并用它说一句',q('.sheet.on')));await until(()=>q('#practice-answer',top()),'Practice');await api.flushPersist();
 ok(api.getState().vocab.length===1,'dictionary collection persisted');const task=api.getState().tasks[0],draft='This idea can take root in my own work.';ok(task.source?.articleId===sampleId&&task.word,'practice source expression');
 await wait(80);type(q('#practice-answer',top()),draft);await until(()=>api.getState().tasks[0].draft===draft,'Draft');await api.flushPersist();await until(()=>!button('确认文字，发送回答',top())?.disabled,'Send enabled');
 click(button('确认文字，发送回答',top()));await until(()=>q('.account-overlay'),'Login');click(button('先继续本地体验',q('.account-overlay')));await until(()=>!q('.account-overlay'),'Cancel login');
 ok(q('#practice-answer',top()).value===draft&&api.getState().tasks[0].draft===draft,'cancel login preserves draft');ok(api.getState().tasks[0].attempts.length===0,'cancel makes no fake score');
 click(button('返回',top()));await until(()=>button('保留进度，返回',top()),'Practice exit');click(button('保留进度，返回',top()));await wait(400);await back();
 click(all('.glass-nav .tab')[2]);await until(()=>api.getState().tab==='vocab','Review tab');await wait(40);click(button('开始这一轮',pane()));await until(()=>q('.rv-card',top()),'Review');
 click(button('直接看答案',top())||button('点按翻面',top()));await until(()=>all('.grade',top()).length===4,'Grades');const due=api.getState().vocab[0].dueAt,n=api.getState().reviewEvents.length;
 click(all('.grade',top())[2]);await until(()=>api.getState().reviewEvents.length>n,'Grade');ok(api.getState().vocab[0].dueAt>due,'review schedule advances');await until(()=>button('撤销'),'Undo toast');click(button('撤销'));await until(()=>api.getState().vocab[0].dueAt===due,'Undo');ok(api.getState().reviewEvents.length>n+1,'undo appends audit event');await api.flushPersist();
 click(button('退出',top()));await until(()=>q('.sheet.on'),'Exit review');click(button('退出',q('.sheet.on')));await wait(400);click(all('.glass-nav .tab')[0]);await wait(80);
 const pasted='A complete imported story.\n\nThe final paragraph is preserved. FINAL_SENTENCE_END.',count=api.getState().articles.length;
 await importPreview(pasted);ok(api.getState().articles.length===count,'preview writes no article');ok(q('textarea',top()).value.endsWith('FINAL_SENTENCE_END.'),'preview final sentence');click(button('保存并开始阅读',top()));await until(()=>api.getState().articles.length===count+1,'Save import');await until(()=>q('.rd-playbar',top()),'Imported reader');
 const imported=api.getState().articles.find(a=>a.sourceType==='paste');ok(imported.sentences.at(-1).en.endsWith('FINAL_SENTENCE_END.'),'saved final sentence');await back();await importPreview(pasted);click(button('保存并开始阅读',top()));await wait(450);await api.flushPersist();ok(api.getState().articles.length===count+1,'duplicate import deduped');
 root.unmount();root=null;await api.flushPersist();const snapshot=await api.activeRepository().loadSnapshot();ok(snapshot.state.tasks.some(t=>t.id===task.id&&t.draft===draft),'durable practice draft');ok(snapshot.state.articles.some(a=>a.id===imported.id),'durable imported article');ok(network.length===0,'local guest flow sends no network');ok(errors.length===0,'no React hook or runtime errors');console.log('PASS: '+checks+' source-rendered mobile smoke assertions');
}finally{root?.unmount();try{if(api){await api.flushPersist();api.activeRepository().close();}}catch{}console.error=oldError;process.removeListener('unhandledRejection',rejected);dom.window.close();for(const id of timeouts)originalTimers.clearTimeout(id);for(const id of intervals)originalTimers.clearInterval(id);Object.assign(globalThis,originalTimers);await rm(dir,{recursive:true,force:true});}
