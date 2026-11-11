import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// These tests render production components against real IndexedDB persistence.
const dir = await mkdtemp(join(tmpdir(), 'ita-draft-tests-'));
const outfile = join(dir, 'app.mjs');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:4199/', pretendToBeVisual: true });
const w = dom.window, originalError = console.error;
const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const timeouts = new Set(), intervals = new Set(), errors = [];
globalThis.setTimeout = (fn, ms, ...args) => { const id = originalTimers.setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; };
globalThis.clearTimeout = id => { timeouts.delete(id); originalTimers.clearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => { const id = originalTimers.setInterval(fn, ms, ...args); intervals.add(id); return id; };
globalThis.clearInterval = id => { intervals.delete(id); originalTimers.clearInterval(id); };
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.scrollTo = () => {};
for (const name of ['scrollIntoView', 'scrollTo', 'setPointerCapture', 'releasePointerCapture']) w.HTMLElement.prototype[name] = function() {};
w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
w.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [], speaking: false };
for (const name of ['document', 'localStorage', 'location', 'history', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'SpeechSynthesisUtterance', 'speechSynthesis']) globalThis[name] = w[name];
globalThis.window = w; globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.fetch = async () => { throw Error('No cloud response is manufactured by draft tests'); };
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const rejected = e => errors.push(e?.stack || String(e));
process.on('unhandledRejection', rejected);
const wait = ms => new Promise(r => originalTimers.setTimeout(r, ms));
const q = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)];
const text = e => e?.textContent?.replace(/\s+/g, ' ').trim() || '';
const button = label => all('button').find(e => text(e) === label || e.getAttribute('aria-label') === label);
function click(e) { assert.ok(e, 'Expected clickable element'); assert.notEqual(e.disabled, true); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }
function type(e, value) { assert.ok(e, 'Expected input'); Object.getOwnPropertyDescriptor(e.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new w.Event('input', { bubbles: true })); }
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (fn()) return; if (errors.length) throw Error(errors.join(' | ')); await wait(10); } throw Error(label + ' timed out: ' + text(document.body).slice(0, 700)); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
let api, checks = 0, pops = 0, popAlls = 0;
const routes = [];
const nav = { push(view, props) { routes.push({view,props}); }, replace(view, props) { routes.push({view,props,replace:true}); }, pop() { pops++; }, popAll() { pops++; popAlls++; } };
function pass(label) { checks++; console.log('PASS ' + label); }
async function clearMount() { api.unmount(); await wait(20); await api.flushPersist(); api.hideToast(); }
async function profile(label) { await clearMount(); await api.switchProfile(label + '-' + crypto.randomUUID(), false); }

try {
  await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {useLocalDraft} from './core/useLocalDraft';import LearningImport from './screens/LearningImport';import {LearningNote,ReadingHome} from './screens/LearningHome';import {LearningLibrary,LearningFeeds} from './screens/LearningDiscover';import ReviewScreen from './screens/ReviewScreen';import {NavCtx} from './ui/nav';export * from './store';export {articlesFromBook} from './services/discovery';let root;export let probe;function Probe({id}){const [value,set,ready,clear]=useLocalDraft(id,'');probe={id,value,set,ready,clear};return <div data-ready={ready}>{value}</div>;}export function render(kind,props,nav){root??=createRoot(document.getElementById('root'));const C={hook:Probe,note:LearningNote,import:LearningImport,review:ReviewScreen,shelf:ReadingHome,library:LearningLibrary,feeds:LearningFeeds}[kind];const page=kind==="importStack"?<><div className="push" inert={props?.stackDepth!==1}><LearningImport/></div>{props?.stackDepth!==1&&<div className="push"><LearningImport/></div>}</>:<C {...props}/>;const tree=<NavCtx.Provider value={nav}><div className="app">{page}</div></NavCtx.Provider>;root.render(props?.strictMode?<React.StrictMode>{tree}</React.StrictMode>:tree);}export function unmount(){root?.unmount();root=null;probe=null;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'draft-tests.tsx', loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://draft-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') } });
  api = await import(pathToFileURL(outfile).href);
  await api.initializeStore('draft-tests-' + crypto.randomUUID());

  api.render('hook', { id: 'a' }, nav); await until(() => api.probe?.ready, 'first draft');
  api.probe.set('only A'); await until(() => api.probe.value === 'only A', 'edit A'); await wait(20); await api.flushPersist();
  api.render('hook', { id: 'b' }, nav); await until(() => api.probe?.id === 'b' && api.probe.ready, 'switch draft id'); await api.flushPersist();
  assert.equal(api.probe.value, ''); assert.equal((await api.activeRepository().get('local.drafts', 'a')).payload, 'only A'); assert.equal((await api.activeRepository().get('local.drafts', 'b')).payload, '');
  pass('mounted hook ID change never writes old contents under the new ID');

  api.probe.set('account A'); await until(() => api.probe.value === 'account A', 'edit account draft'); await wait(20); await api.flushPersist();
  const oldIdentity = api.profileIdentity(), staleSet = api.probe.set, staleClear = api.probe.clear;
  await api.switchProfile('draft-other-' + crypto.randomUUID(), false);
  await until(() => api.probe?.ready && api.probe.value === '', 'new account draft');
  staleSet('must not leak'); await assert.rejects(staleClear(), /账号已切换/); await wait(20); await api.flushPersist();
  assert.equal((await api.activeRepository().get('local.drafts', 'b')).payload, '');
  await api.switchProfile(oldIdentity, false); await until(() => api.probe?.ready && api.probe.value === 'account A', 'return account draft');
  pass('account switch isolates drafts and rejects stale setters/clear closures');

  await clearMount(); const repo = api.activeRepository(), get = repo.get.bind(repo), entered = deferred(), release = deferred();
  repo.get = async (collection, id) => { if (collection === 'local.drafts' && id === 'delayed') { entered.resolve(); await release.promise; return { collection, id, payload: 'late old read', version: 1, deleted: false }; } return get(collection, id); };
  api.render('hook', { id: 'delayed' }, nav); await entered.promise; await api.switchProfile('draft-delay-' + crypto.randomUUID(), false); release.resolve();
  await until(() => api.probe?.ready, 'delayed profile load'); await wait(20); await api.flushPersist(); assert.equal(api.probe.value, ''); assert.equal((await api.activeRepository().get('local.drafts', 'delayed')).payload, '');
  pass('late old-account draft reads cannot populate or persist into the new account');

  await clearMount(); await api.commitRepository({ records: [{ collection: 'local.drafts', id: 'null-draft', payload: null }, { collection: 'local.drafts', id: 'deleted-draft', payload: 'discarded', deleted: true }] });
  for (const id of ['null-draft', 'deleted-draft']) { api.render('hook', { id }, nav); await until(() => api.probe?.ready && api.probe.id === id, 'empty persisted draft'); assert.equal(api.probe.value, ''); await clearMount(); }
  pass('null and tombstoned drafts restore the initial value rather than obsolete contents');

  await profile('note'); api.render('note', {}, nav); await until(() => q('textarea'), 'new note');
  type(q('input'), 'Saved title'); type(q('textarea'), 'Saved body'); await wait(25);
  const beforePops = pops; q('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await until(() => pops > beforePops, 'note save');
  assert.equal(api.getState().notes[0].body, 'Saved body'); await clearMount(); api.render('note', {}, nav); await until(() => q('textarea'), 'fresh note');
  assert.equal(q('input').value, ''); assert.equal(q('textarea').value, ''); pass('saving a new note clears its draft and the next new note is empty');
  /* 原型 learning-note（html:3005-3008）：已有笔记先读后改——阅读态页头「编辑笔记」圆钮进编辑抽屉。 */
  await clearMount(); const noteId = api.getState().notes[0].id; api.render('note', { id: noteId }, nav); await until(() => q('.v2-free-note'), 'note reading view'); click(button('编辑笔记'));
  await until(() => q('textarea'), 'edit note');
  type(q('textarea'), 'Unsubmitted edit retained'); await wait(25); await api.flushPersist(); await clearMount(); api.render('note', { id: noteId }, nav); await until(() => q('.v2-free-note'), 'restore note reading view'); click(button('编辑笔记')); await until(() => q('textarea'), 'restore edit note');
  assert.equal(q('textarea').value, 'Unsubmitted edit retained'); assert.equal(api.getState().notes[0].body, 'Saved body'); pass('returning to an edited note restores the draft without changing the saved note');

  await profile('import'); api.render('import', {}, nav); await until(() => q('textarea'), 'import');
  type(q('textarea'), 'Account scoped text. It must never appear in another account.'); await wait(20); click(button('预览正文')); await until(() => button('保存并开始阅读'), 'import preview'); await wait(20); await api.flushPersist();
  const importIdentity = api.profileIdentity(), digest = crypto.subtle.digest.bind(crypto.subtle), hashEntered = deferred(), hashRelease = deferred();
  crypto.subtle.digest = async (...args) => { hashEntered.resolve(); await hashRelease.promise; return digest(...args); };
  try { click(button('保存并开始阅读')); await hashEntered.promise; await api.switchProfile('import-other-' + crypto.randomUUID(), false); hashRelease.resolve(); await until(() => q('[role=alert]'), 'stale import rejection'); assert.match(text(q('[role=alert]')), /账号已切换/); assert.equal(api.getState().articles.filter(a => a.sourceType === 'paste').length, 0); } finally { crypto.subtle.digest = digest; }
  await clearMount(); await api.switchProfile(importIdentity, false); const importDraft = await api.activeRepository().get('local.drafts', 'reading-import'); assert.ok(importDraft.payload.content.includes('Account scoped text')); assert.equal(importDraft.deleted, false);
  pass('switching accounts while SHA-256 awaits never imports into the new account and preserves the source draft');

  await profile('invalid-import'); api.render('import', {}, nav); await until(() => button('网页链接'), 'URL import'); click(button('网页链接')); await until(() => q('#import-url'), 'URL input');
  type(q('#import-url'), 'https//invalid.example/article'); await wait(20); click(button('预览正文')); await until(() => q('[role=alert]'), 'invalid URL feedback');
  assert.match(text(q('[role=alert]')), /请输入完整的 http 或 https/); assert.equal(q('#import-url').value, 'https//invalid.example/article'); assert.equal(button('预览正文').disabled, false); assert(!q('.v2-import-preview'));
  await api.flushPersist(); api.actions.setSettings({goal:'unrelated state update'}); await wait(20); assert.match(text(q('[role=alert]')), /请输入完整的 http 或 https/);
  type(q('#import-url'), 'https://unreachable.example/article'); await wait(20); click(button('预览正文')); await until(() => text(q('[role=alert]')).includes('暂时无法提取正文'), 'network extraction feedback');
  assert.equal(q('#import-url').value, 'https://unreachable.example/article'); assert.equal(button('预览正文').disabled, false);
  pass('invalid URL and network import failures stay visible after draft persistence and unrelated state updates, retain the input and enable retry');

  for (const source of ['hash', 'safari']) {
    await profile('share-' + source);
    await api.commitRepository({records:[{collection:'local.drafts',id:'reading-import',payload:{mode:'url',input:'',url:'https://old.example/news',title:'Old webpage draft',content:'Old cached webpage contents.',sourceUrl:'https://old.example/news',preview:true}}]});
    const shared = `${source} shared article. A fresh paragraph must replace the old webpage draft.`;
    api.actions.setShareIn({text:shared,source}); api.render('import', {strictMode:true}, nav);
    await until(() => q('#import-text')?.value === shared, 'fresh ' + source + ' share'); assert.equal(q('#import-title').value,''); assert(!q('.v2-import-preview')); assert.equal(api.getState().shareIn,null);
    const edited = shared + ' My later edit.'; type(q('#import-text'),edited); await wait(20); await api.flushPersist(); await clearMount();
    api.render('import', {strictMode:true}, nav); await until(() => q('#import-text')?.value === edited, 'ordinary import restores edited share draft'); assert.equal(api.getState().shareIn,null);
    click(button('预览正文')); await until(() => button('保存并开始阅读'), 'shared preview'); click(button('保存并开始阅读')); await until(() => routes.at(-1)?.replace === true && api.getState().articles.some(a=>a.sourceType==='paste'), 'shared save');
    const saved=api.getState().articles.find(a=>a.sourceType==='paste'); assert.equal(saved.sentences.map(s=>s.en).join(' '),edited); await clearMount();
    api.render('import', {strictMode:true}, nav); await until(() => q('#import-text')?.value === '', 'saved share does not replay on reopening'); assert.equal(q('#import-title').value,''); assert(!q('.v2-import-preview')); assert.equal(api.getState().shareIn,null);
    pass(source + ' deep-link share replaces a persisted webpage draft once under StrictMode, preserves later edits, and cannot replay after saving');
  }
  await profile('share-stack');
  await api.commitRepository({records:[{collection:'local.drafts',id:'reading-import',payload:{mode:'paste',input:'Hidden old draft.',url:'',title:'Old draft',content:'',sourceUrl:'',preview:false}}]});
  api.actions.setShareIn({text:'New topmost shared text.',source:'safari'}); api.render('importStack', {strictMode:true}, nav);
  await until(() => all('.push').find(el=>!el.hasAttribute('inert'))?.querySelector('textarea')?.value === 'New topmost shared text.', 'topmost import receives share');
  assert.equal(all('.push').find(el=>el.hasAttribute('inert')).querySelector('textarea').value,'Hidden old draft.'); assert.equal(api.getState().shareIn,null); await wait(20); await api.flushPersist();
  assert.equal((await api.activeRepository().get('local.drafts','reading-import')).payload.input,'New topmost shared text.');
  pass('a hidden import page cannot consume or overwrite the new topmost deep-link share');

  await profile('share-during-request');
  await api.commitRepository({records:[{collection:'local.drafts',id:'reading-import',payload:{mode:'url',input:'',url:'https://old.example/slow',title:'Old pending request',content:'',sourceUrl:'',preview:false}}]});
  api.render('importStack', {strictMode:true,stackDepth:1}, nav); await until(() => q('#import-url'), 'pending request import');
  const oldFetch=globalThis.fetch, httpEntered=deferred(), httpRelease=deferred(); let oldRequestSignal;
  globalThis.fetch=async(_url,options)=>{oldRequestSignal=options.signal;httpEntered.resolve();await httpRelease.promise;return new Response('<article><h1>Late old webpage</h1><p>This is a late response to the old webpage request and must never overwrite a fresh share.</p></article>',{status:200});};
  try {
    click(button('预览正文')); await httpEntered.promise;
    api.actions.setShareIn({text:'The fresh share supersedes an old pending request.',source:'safari'});api.render('importStack',{strictMode:true,stackDepth:2},nav);
    await until(()=>all('.push').find(el=>!el.hasAttribute('inert'))?.querySelector('textarea')?.value==='The fresh share supersedes an old pending request.','share during extraction');
    assert.equal(oldRequestSignal.aborted,true);
    httpRelease.resolve();await wait(30);await api.flushPersist();
    const kept=(await api.activeRepository().get('local.drafts','reading-import')).payload;assert.equal(kept.input,'The fresh share supersedes an old pending request.');assert.equal(kept.content,'');assert.equal(kept.preview,false);assert(!text(all('.push').find(el=>el.hasAttribute('inert'))).includes('Late old webpage'));
    pass('a delayed extraction from a retained hidden page cannot overwrite the newer shared draft');
  } finally {httpRelease.resolve();globalThis.fetch=oldFetch;}

  await profile('share-during-digest');
  await api.commitRepository({records:[{collection:'local.drafts',id:'reading-import',payload:{mode:'paste',input:'Old pending save.',url:'',title:'Old save',content:'Old pending save.',sourceUrl:'',preview:true}}]});
  api.render('importStack',{strictMode:true,stackDepth:1},nav);await until(()=>button('保存并开始阅读'),'pending digest import');
  const realDigest=crypto.subtle.digest.bind(crypto.subtle),digestEntered=deferred(),digestRelease=deferred(),routesBefore=routes.length;
  crypto.subtle.digest=async(...args)=>{digestEntered.resolve();await digestRelease.promise;return realDigest(...args);};
  try {
    click(button('保存并开始阅读'));await digestEntered.promise;
    api.actions.setShareIn({text:'The new share supersedes an old pending save.',source:'hash'});api.render('importStack',{strictMode:true,stackDepth:2},nav);
    await until(()=>all('.push').find(el=>!el.hasAttribute('inert'))?.querySelector('textarea')?.value==='The new share supersedes an old pending save.','share during save digest');
    digestRelease.resolve();await wait(30);await api.flushPersist();
    assert.equal(routes.length,routesBefore);assert.equal(api.getState().articles.filter(a=>a.sourceType==='paste').length,0);const kept=(await api.activeRepository().get('local.drafts','reading-import'));assert.equal(kept.deleted,false);assert.equal(kept.payload.input,'The new share supersedes an old pending save.');
    pass('a delayed save from a retained hidden page cannot save, clear the newer draft or replace its navigation');
  } finally {digestRelease.resolve();crypto.subtle.digest=realDigest;}

  await profile('library-rename');
  const legacyChapters = ['First', 'Second'].map((chapterTitle, index) => ({ id: `legacy-book-${index}`, bookId: 'legacy-book', bookTitle: 'Classic Short Stories', chapterTitle, chapterIndex: index, title: `Classic Short Stories · ${chapterTitle}`, titleCn: '', sourceType: 'book', paragraphStarts: [0], createdAt: 10, sentences: [{idx:0,paragraphIdx:0,en:'A saved sentence.',zh:'保留的译文。'},{idx:1,paragraphIdx:0,en:'A second saved sentence.',zh:'第二句译文。'}] }));
  legacyChapters.forEach(a => api.actions.addArticle(a)); api.actions.setProgress('legacy-book-1', 1);
  api.render('shelf', {}, nav); await until(() => button('整理 Classic Short Stories'), 'legacy book management'); click(button('整理 Classic Short Stories'));
  await until(() => q('#reading-item-name'), 'rename drawer'); type(q('#reading-item-name'), '我的经典短篇'); await wait(20); click(button('保存名称'));
  await until(() => api.getState().articles.filter(a => a.bookId === 'legacy-book').every(a => a.bookTitle === '我的经典短篇'), 'rename persisted');
  assert(api.getState().articles.filter(a => a.bookId === 'legacy-book').every(a => a.sourceBookTitle === 'Classic Short Stories'));
  const renamedIdentity = api.profileIdentity(); await clearMount(); await api.switchProfile('library-empty-' + crypto.randomUUID(), false); await api.switchProfile(renamedIdentity, false);
  const rejectFetch = globalThis.fetch; let libraryNetworkCalls = 0;
  globalThis.fetch = async () => { libraryNetworkCalls++; throw new TypeError('Offline library test'); };
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: false });
  try {
    api.render('library', {}, nav); await until(() => q('.v2-book-card'), 'offline library');
    const card = () => all('.v2-book-card').find(el => text(el.querySelector('h2')) === 'Classic Short Stories');
    await until(() => text(card()).includes('继续阅读'), 'renamed book is still saved'); click([...card().querySelectorAll('button')].find(el => text(el) === '继续阅读'));
    await until(() => routes.at(-1)?.props?.articleId === 'legacy-book-1', 'offline renamed continuation'); assert.equal(api.getState().progress['legacy-book-1'], 1);
    api.actions.archiveBook('legacy-book'); await until(() => text(card()).includes('重新加入'), 'archived renamed edition'); click([...card().querySelectorAll('button')].find(el => text(el) === '重新加入'));
    await until(() => api.getState().articles.filter(a => a.bookId === 'legacy-book').every(a => !a.archived), 'offline restoration'); assert.equal(routes.at(-1).props.articleId, 'legacy-book-1'); assert.equal(libraryNetworkCalls, 0);
    assert.equal(api.getState().articles.filter(a => a.bookId === 'legacy-book').length, 2); assert.equal(api.getState().articles.find(a => a.id === 'legacy-book-1').sentences[0].zh, '保留的译文。');
    pass('renaming a legacy book through the real shelf preserves offline continuation, archived restoration and its saved position after reload');
    await clearMount();
    const projected = api.articlesFromBook({bookId:'catalog-edition',curatedBookId:'b2',sourceOrigin:'https://catalog.example',catalog:{id:'gift',title:'The Gift of the Magi & Other Stories',author:'O. Henry',sha256:'a'.repeat(64)},book:{title:'A Different EPUB Heading',author:'O. Henry',chapters:[{title:'First',text:'The saved text is complete.'}]}});
    projected.forEach(a => api.actions.addArticle(a)); api.actions.renameBook('catalog-edition', '我的礼物故事');
    api.render('library', {}, nav); await until(() => all('.v2-book-card').length === 3, 'catalogue identity library');
    const gift = all('.v2-book-card').find(el => text(el.querySelector('h2')) === 'The Gift of the Magi & Other Stories'); assert(text(gift).includes('已在书架'));
    click([...gift.querySelectorAll('button')].find(el => text(el) === '继续阅读')); await until(() => routes.at(-1)?.props?.articleId === 'catalog-edition-chapter-1', 'catalogue identity continuation'); assert.equal(libraryNetworkCalls, 0);
    pass('a curated identity opens the saved edition when catalogue title, EPUB title and user title all differ');
  } finally { globalThis.fetch = rejectFetch; Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: true }); }

  await profile('partly-archived-book');
  const mixedChapters = ['Available', 'Archived'].map((chapterTitle, index) => ({ ...legacyChapters[index], id: `mixed-${index}`, bookId: 'mixed-book', bookTitle: 'Partly Archived Book', chapterTitle, title: `Partly Archived Book · ${chapterTitle}` }));
  mixedChapters.forEach(a => api.actions.addArticle(a)); api.actions.setCompleted('mixed-0'); api.actions.setProgress('mixed-1', 1); api.actions.archiveArticle('mixed-1');
  const hiddenChapter = structuredClone(api.getState().articles.find(a => a.id === 'mixed-1'));
  api.render('shelf', {}, nav); await until(() => button('Partly Archived Book的目录'), 'mixed archive shelf');
  const mixedCard = () => q('.reading-shelf-item[aria-label="Partly Archived Book"]');
  assert.equal(text(mixedCard().querySelector('.library-item-state')), '已读完', 'An archived chapter must not keep the visible book in progress');
  assert.match(text(mixedCard().querySelector('.library-item-info')), /^1 章/);
  const selectStatus = async value => { const select = q('select[aria-label="筛选阅读状态"]'); select.value = value; select.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(20); };
  await selectStatus('done'); assert(mixedCard(), 'The same visible book must appear in the completed filter');
  click(button('Partly Archived Book的目录')); await until(() => q('.v2-toc-row'), 'mixed archive contents');
  assert.equal(all('.v2-toc-row').length, 1); assert.match(text(q('.v2-toc-row')), /Available/); click(q('.v2-toc-row'));
  await until(() => !q('.v2-toc-row'), 'close mixed archive contents'); assert.equal(routes.at(-1).props.articleId, 'mixed-0');
  assert.deepEqual(api.getState().articles.find(a => a.id === 'mixed-1'), hiddenChapter, 'Opening active chapters must not silently restore an archived chapter');
  click(button('整理 Partly Archived Book')); await until(() => button('恢复已移出的 1 章'), 'restore omitted chapters'); click(button('恢复已移出的 1 章'));
  await until(() => !api.getState().articles.find(a => a.id === 'mixed-1').archived, 'restored omitted chapter');
  assert.equal(mixedCard(), null, 'Restoring the unfinished chapter removes the book from the completed filter');
  await selectStatus('reading'); assert(mixedCard()); assert.match(text(mixedCard().querySelector('.library-item-info')), /^2 章/);
  assert.equal(api.getState().progress['mixed-1'], 1); assert.equal(api.getState().readingCompleted['mixed-0'], true); assert.deepEqual(api.getState().articles.find(a => a.id === 'mixed-1').sentences, hiddenChapter.sentences);
  api.actions.archiveBook('mixed-book'); await selectStatus('archived'); assert(mixedCard());
  click(button('Partly Archived Book的目录')); await until(() => all('.v2-toc-row').length === 2, 'fully archived contents remain restorable');
  click(all('.v2-toc-row')[1]); await until(() => api.getState().articles.filter(a => a.bookId === 'mixed-book').every(a => !a.archived), 'restore from archived contents');
  assert.equal(routes.at(-1).props.articleId, 'mixed-1'); assert.equal(api.getState().progress['mixed-1'], 1); assert.equal(api.getState().readingCompleted['mixed-0'], true);
  pass('partly archived books share visible chapters across status, filters and contents, and explicitly restore omitted chapters without losing learning records');

  await profile('curated-restore'); api.actions.subscribeCuratedFeed('f1'); api.actions.renameArticle('speed', '我的科研阅读'); api.actions.fillSentenceZh('speed', 0, '保存的机器译文'); api.actions.setSentenceZh('speed', 0, '我修改的译文'); api.actions.setProgress('speed', 2); api.actions.setCompleted('speed');
  api.actions.saveNote({id:'curated-note',title:'Reading note',body:'My original note',sub:'',insight:''}); api.actions.saveWord({word:'unfamiliar',kind:'word',senses:[{pos:'adj.',cn:'陌生的'}]}, 'word');
  const savedLearning = structuredClone({article:api.getState().articles.find(a => a.id === 'speed'),progress:api.getState().progress.speed,completed:api.getState().readingCompleted.speed,sentenceZh:api.getState().sentenceZh,vocab:api.getState().vocab,notes:api.getState().notes});
  api.actions.archiveArticle('speed'); api.actions.archiveArticle('sleep'); api.actions.unsubscribeCuratedFeed('f1'); api.hideToast(); api.render('feeds', {}, nav);
  await until(() => all('.v2-feed-row').length === 3, 'curated feeds'); const science = all('.v2-feed-row').find(el => text(el).includes('Science Daily Brief')); click(science.querySelector('button'));
  await until(() => button('加入这组短文并阅读'), 'curated sample'); click(button('加入这组短文并阅读')); await until(() => routes.at(-1)?.props?.articleId === 'speed', 'restored curated route');
  const restored = api.getState().articles.find(a => a.id === 'speed'); assert.equal(restored.archived, false); assert.equal(restored.title, savedLearning.article.title); assert.deepEqual(restored.sentences, savedLearning.article.sentences);
  assert.equal(api.getState().articles.filter(a => a.id === 'speed').length, 1); assert.equal(api.getState().articles.find(a => a.id === 'sleep').archived, false); assert.equal(api.getState().progress.speed, savedLearning.progress); assert.equal(api.getState().readingCompleted.speed, savedLearning.completed); assert.deepEqual(api.getState().sentenceZh,savedLearning.sentenceZh); assert.deepEqual(api.getState().vocab,savedLearning.vocab); assert.deepEqual(api.getState().notes,savedLearning.notes);
  const curatedIdentity = api.profileIdentity(); await clearMount(); await api.switchProfile('curated-empty-' + crypto.randomUUID(), false); await api.switchProfile(curatedIdentity, false); api.render('shelf', {}, nav);
  await until(() => all('.reading-shelf-item').some(el => text(el).includes('我的科研阅读')), 'restored curated shelf after reload'); assert.equal(api.getState().articles.find(a => a.id === 'speed').archived, false);
  pass('rejoining a curated group through its real sample restores archived prose without losing translations, edits, position, completion, vocabulary or notes');

  for (const reviewMode of ['cloze','dictation','spoken']) {
    await profile('review-back-' + reviewMode);
    api.actions.saveWord({word:'resume',kind:'word',senses:[{pos:'v.',cn:'继续'}]}, 'word'); await api.flushPersist(); api.hideToast();
    const id=api.getState().vocab[0].id, savedText='My unfinished ' + reviewMode + ' answer';
    const card={id,mode:reviewMode,word:'resume',kind:'word',answer:'resume',hint:'继续',sentIdx:0,pre:'We',post:'the lesson.'};
    const selector=reviewMode==='spoken'?'#v2-review-speaking-draft':reviewMode==='cloze'?'input[aria-label="填空回答（选填）"]':'input[aria-label="听音回答（选填）"]';
    api.render('review',{cards:[card]},nav);await until(()=>q(selector),'review answer input');type(q(selector),savedText);await wait(20);
    const beforeReturn=pops,beforePopAll=popAlls;click(q('[data-nav-back]'));assert.equal(pops,beforeReturn+1);assert.equal(popAlls,beforePopAll);assert.equal(api.getState().sheet,null);await clearMount();
    const persisted=await api.activeRepository().get('local.review','current');
    assert.equal(reviewMode==='spoken'?persisted.payload.cs.spoken.text:persisted.payload.input,savedText);
    api.render('review',{cards:[card]},nav);await until(()=>q(selector)?.value===savedText,'returned review draft');
    const bottom=all('.v2-review-switch button').find(el=>text(el)==='返回'),beforeBottom=pops;click(bottom);assert.equal(pops,beforeBottom+1);assert.equal(popAlls,beforePopAll);assert.equal(api.getState().sheet,null);
    assert.equal(api.getState().reviewEvents.length,0);pass(reviewMode + ' header and bottom return immediately without a dialog, preserve its unfinished answer, and never grade it');
  }

  await profile('review'); api.actions.saveWord({ word: 'durable', kind: 'word', senses: [{ pos: 'adj.', cn: '持久的' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const wordId = api.getState().vocab[0].id; api.render('review', { wordId }, nav); await until(() => button('点按翻面'), 'review card'); click(button('点按翻面')); await until(() => all('.grade').length === 3, 'review grades');
  click(all('.grade')[2]); await until(() => api.getState().reviewEvents.length === 1, 'grade event'); await api.flushPersist(); await clearMount();
  api.render('review', { wordId }, nav); await until(() => text(document.body).includes('本轮完成'), 'durable grade recovery'); assert.equal(api.getState().reviewEvents.filter(e => e.kind === 'grade').length, 1); assert.equal(all('.grade').length, 0);
  pass('unmounting after durable grading restores completion and cannot score the card twice');
  const completedDraft=structuredClone((await api.activeRepository().get('local.review',wordId)).payload);
  const completedPops=pops,completedPopAlls=popAlls;click(q('[data-nav-back]'));await until(()=>pops===completedPops+1,'completed review return');assert.equal(popAlls,completedPopAlls);
  assert.equal((await api.activeRepository().get('local.review',wordId)).deleted,true);assert.equal(api.getState().reviewEvents.filter(e=>e.kind==='grade').length,1);assert.equal(api.getState().sheet,null);
  pass('completed review returns after its atomic completion write without an exit dialog or duplicate grade');
  await clearMount();await api.commitRepository({records:[{collection:'local.review',id:wordId,payload:completedDraft,deleted:false}]});
  api.render('review',{wordId},nav);await until(()=>button('回今日复习，查看下一次安排'),'completed home destination');
  const homePopAlls=popAlls;click(button('回今日复习，查看下一次安排'));await until(()=>popAlls===homePopAlls+1,'explicit return to review home');
  assert.equal((await api.activeRepository().get('local.review',wordId)).deleted,true);assert.equal(api.getState().reviewEvents.filter(e=>e.kind==='grade').length,1);
  pass('the explicit completed-session home action still clears its navigation stack after atomic completion');

  await profile('undo'); api.actions.saveWord({ word: 'regrade', kind: 'word', senses: [{ pos: 'v.', cn: '重评' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const undoWord = api.getState().vocab[0].id; api.render('review', { wordId: undoWord }, nav); await until(() => button('点按翻面'), 'undo card'); click(button('点按翻面')); await until(() => all('.grade').length === 3, 'undo grades'); click(all('.grade')[2]); await until(() => button('撤销'), 'undo action');
  const firstEvent = api.getState().reviewEvents.find(e => e.kind === 'grade'); click(button('撤销')); await until(() => api.getState().reviewEvents.some(e => e.kind === 'undo'), 'undo event'); click(all('.grade')[1]); await until(() => api.getState().reviewEvents.filter(e => e.kind === 'grade').length === 2, 'regrade event'); await api.flushPersist();
  const grades = api.getState().reviewEvents.filter(e => e.kind === 'grade'); assert.notEqual(grades[0].id, grades[1].id); assert.equal(api.getState().reviewEvents.find(e => e.kind === 'undo').reversesEventId, firstEvent.id);
  pass('undo permits regrading with a new event ID and keeps an auditable reversal');

  await profile('invalid-review'); api.actions.saveWord({ word: 'fresh', kind: 'word', senses: [{ pos: 'adj.', cn: '新的' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const freshWord = api.getState().vocab[0].id;
  for (const payload of [null, { queue: null, pos: 0, finished: true }, { queue: [{ id: 'deleted-word' }], pos: 0, finished: true }]) {
    await api.commitRepository({ records: [{ collection: 'local.review', id: freshWord, payload }] }); api.render('review', { wordId: freshWord }, nav); await until(() => button('点按翻面'), 'invalid review fallback'); assert.equal(text(document.body).includes('本轮完成'), false); assert.equal(api.getState().reviewEvents.length, 0); await clearMount();
  }
  pass('null, invalid-schema, and stale-word review drafts cannot fabricate a completed session');

  await profile('complete'); await api.commitRepository({ records: [{ collection: 'local.review', id: 'one', payload: { pending: true } }, { collection: 'local.review', id: 'two', payload: { pending: true } }] });
  const completionRepo = api.activeRepository(), commit = completionRepo.commit.bind(completionRepo), calls = []; completionRepo.commit = async input => { calls.push(structuredClone(input)); return commit(input); };
  const initialStreak = api.getState().stats.streak; await api.actions.completeReviewSession('one', true); await api.actions.completeReviewSession('two', true); await api.flushPersist();
  assert.equal(api.getState().stats.streak, initialStreak + 1); assert.equal((await completionRepo.loadSnapshot()).state.stats.streak, initialStreak + 1);
  for (const id of ['one', 'two']) { assert.equal((await completionRepo.get('local.review', id)).deleted, true); assert.ok(calls.some(c => c.state?.stats && c.records?.some(r => r.collection === 'local.review' && r.id === id && r.deleted && r.payload === null))); }
  pass('two completions on the same day increment streak once and commit state with each draft tombstone atomically');

  await profile('complete-failure'); await api.commitRepository({ records: [{ collection: 'local.review', id: 'failed', payload: { pending: true } }] });
  const failedRepo = api.activeRepository(), previousSnapshot = await failedRepo.loadSnapshot(), previousStats = structuredClone(api.getState().stats), failureEntered = deferred(), failureRelease = deferred();
  failedRepo.commit = async () => { failureEntered.resolve(); await failureRelease.promise; throw Error('INJECTED_STORAGE_FAILURE'); };
  const failedCompletion = api.actions.completeReviewSession('failed', true); await failureEntered.promise;
  api.actions.setSettings({ goal: 'edit made during failing completion' }); api.actions.saveNote({ id: 'concurrent-note', title: 'Later edit', body: 'must survive', sub: '', insight: '' });
  failureRelease.resolve(); await assert.rejects(failedCompletion, /INJECTED_STORAGE_FAILURE/);
  assert.deepEqual(await failedRepo.loadSnapshot(), previousSnapshot); assert.equal((await failedRepo.get('local.review', 'failed')).deleted, false);
  assert.deepEqual(api.getState().stats, previousStats, 'failed completion must not publish an uncommitted streak');
  assert.equal(api.getState().settings.goal, 'edit made during failing completion'); assert.equal(api.getState().notes[0].id, 'concurrent-note');
  pass('failed completion rolls back streak, retains its durable draft, and preserves concurrent user edits');
  assert.equal(errors.length, 0, errors.join(' | ')); pass('no React or unhandled runtime errors');
  console.log('PASS: ' + checks + ' source-rendered draft/review regression scenarios');
} finally {
  api?.unmount(); api?.hideToast(); api?.stopSpeak();
  try { if (api) { await api.flushPersist(); api.activeRepository().close(); } } catch {}
  dom.window.close(); for (const id of timeouts) originalTimers.clearTimeout(id); for (const id of intervals) originalTimers.clearInterval(id);
  Object.assign(globalThis, originalTimers); console.error = originalError; process.removeListener('unhandledRejection', rejected);
  await rm(dir, { recursive: true, force: true });
}
