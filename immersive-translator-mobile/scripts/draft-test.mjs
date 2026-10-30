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
let api, checks = 0, pops = 0;
const nav = { push() {}, replace() {}, pop() { pops++; }, popAll() { pops++; } };
function pass(label) { checks++; console.log('PASS ' + label); }
async function clearMount() { api.unmount(); await wait(20); await api.flushPersist(); api.hideToast(); }
async function profile(label) { await clearMount(); await api.switchProfile(label + '-' + crypto.randomUUID(), false); }

try {
  await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {useLocalDraft} from './core/useLocalDraft';import LearningImport from './screens/LearningImport';import {LearningNote} from './screens/LearningHome';import ReviewScreen from './screens/ReviewScreen';import {NavCtx} from './ui/nav';export * from './store';let root;export let probe;function Probe({id}){const [value,set,ready,clear]=useLocalDraft(id,'');probe={id,value,set,ready,clear};return <div data-ready={ready}>{value}</div>;}export function render(kind,props,nav){root??=createRoot(document.getElementById('root'));const C={hook:Probe,note:LearningNote,import:LearningImport,review:ReviewScreen}[kind];root.render(<NavCtx.Provider value={nav}><C {...props}/></NavCtx.Provider>);}export function unmount(){root?.unmount();root=null;probe=null;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'draft-tests.tsx', loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://draft-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') } });
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
  await clearMount(); const noteId = api.getState().notes[0].id; api.render('note', { id: noteId }, nav); await until(() => q('textarea'), 'edit note');
  type(q('textarea'), 'Unsubmitted edit retained'); await wait(25); await api.flushPersist(); await clearMount(); api.render('note', { id: noteId }, nav); await until(() => q('textarea'), 'restore edit note');
  assert.equal(q('textarea').value, 'Unsubmitted edit retained'); assert.equal(api.getState().notes[0].body, 'Saved body'); pass('returning to an edited note restores the draft without changing the saved note');

  await profile('import'); api.render('import', {}, nav); await until(() => q('textarea'), 'import');
  type(q('textarea'), 'Account scoped text. It must never appear in another account.'); await wait(20); click(button('预览内容')); await until(() => button('保存并开始阅读'), 'import preview'); await wait(20); await api.flushPersist();
  const importIdentity = api.profileIdentity(), digest = crypto.subtle.digest.bind(crypto.subtle), hashEntered = deferred(), hashRelease = deferred();
  crypto.subtle.digest = async (...args) => { hashEntered.resolve(); await hashRelease.promise; return digest(...args); };
  try { click(button('保存并开始阅读')); await hashEntered.promise; await api.switchProfile('import-other-' + crypto.randomUUID(), false); hashRelease.resolve(); await until(() => q('[role=alert]'), 'stale import rejection'); assert.match(text(q('[role=alert]')), /账号已切换/); assert.equal(api.getState().articles.filter(a => a.sourceType === 'paste').length, 0); } finally { crypto.subtle.digest = digest; }
  await clearMount(); await api.switchProfile(importIdentity, false); const importDraft = await api.activeRepository().get('local.drafts', 'reading-import'); assert.ok(importDraft.payload.content.includes('Account scoped text')); assert.equal(importDraft.deleted, false);
  pass('switching accounts while SHA-256 awaits never imports into the new account and preserves the source draft');

  await profile('review'); api.actions.saveWord({ word: 'durable', kind: 'word', senses: [{ pos: 'adj.', cn: '持久的' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const wordId = api.getState().vocab[0].id; api.render('review', { wordId }, nav); await until(() => button('点按翻面'), 'review card'); click(button('点按翻面')); await until(() => all('.grade').length === 4, 'review grades');
  click(all('.grade')[2]); await until(() => api.getState().reviewEvents.length === 1, 'grade event'); await api.flushPersist(); await clearMount();
  api.render('review', { wordId }, nav); await until(() => text(document.body).includes('复习完成'), 'durable grade recovery'); assert.equal(api.getState().reviewEvents.filter(e => e.kind === 'grade').length, 1); assert.equal(all('.grade').length, 0);
  pass('unmounting after durable grading restores completion and cannot score the card twice');

  await profile('undo'); api.actions.saveWord({ word: 'regrade', kind: 'word', senses: [{ pos: 'v.', cn: '重评' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const undoWord = api.getState().vocab[0].id; api.render('review', { wordId: undoWord }, nav); await until(() => button('点按翻面'), 'undo card'); click(button('点按翻面')); await until(() => all('.grade').length === 4, 'undo grades'); click(all('.grade')[2]); await until(() => button('撤销'), 'undo action');
  const firstEvent = api.getState().reviewEvents.find(e => e.kind === 'grade'); click(button('撤销')); await until(() => api.getState().reviewEvents.some(e => e.kind === 'undo'), 'undo event'); click(all('.grade')[1]); await until(() => api.getState().reviewEvents.filter(e => e.kind === 'grade').length === 2, 'regrade event'); await api.flushPersist();
  const grades = api.getState().reviewEvents.filter(e => e.kind === 'grade'); assert.notEqual(grades[0].id, grades[1].id); assert.equal(api.getState().reviewEvents.find(e => e.kind === 'undo').reversesEventId, firstEvent.id);
  pass('undo permits regrading with a new event ID and keeps an auditable reversal');

  await profile('invalid-review'); api.actions.saveWord({ word: 'fresh', kind: 'word', senses: [{ pos: 'adj.', cn: '新的' }] }, 'word'); await api.flushPersist(); api.hideToast();
  const freshWord = api.getState().vocab[0].id;
  for (const payload of [null, { queue: null, pos: 0, finished: true }, { queue: [{ id: 'deleted-word' }], pos: 0, finished: true }]) {
    await api.commitRepository({ records: [{ collection: 'local.review', id: freshWord, payload }] }); api.render('review', { wordId: freshWord }, nav); await until(() => button('点按翻面'), 'invalid review fallback'); assert.equal(text(document.body).includes('复习完成'), false); assert.equal(api.getState().reviewEvents.length, 0); await clearMount();
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
