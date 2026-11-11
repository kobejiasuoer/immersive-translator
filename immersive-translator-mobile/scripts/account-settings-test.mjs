import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const dir = await mkdtemp(join(tmpdir(), 'ita-account-settings-'));
const OriginalMessageChannel = globalThis.MessageChannel, channels = [];
globalThis.MessageChannel = class extends OriginalMessageChannel { constructor() { super(); channels.push(this); } };
const timers = { setTimeout, clearTimeout, setInterval, clearInterval }, timeouts = new Set(), intervals = new Set();
globalThis.setTimeout = (fn, ms, ...args) => { const id = timers.setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; };
globalThis.clearTimeout = id => { timeouts.delete(id); timers.clearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => { const id = timers.setInterval(fn, ms, ...args); intervals.add(id); return id; };
globalThis.clearInterval = id => { intervals.delete(id); timers.clearInterval(id); };
const dom = new JSDOM('<div id="root" class="app"></div>', { url: 'https://preview.local', pretendToBeVisual: true });
const w = dom.window;
for (const key of ['window', 'document', 'localStorage', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element', 'HTMLElement', 'DOMParser']) globalThis[key] = key === 'window' ? w : w[key];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
w.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Account settings regression must not request the network'); };
let api, root;
const wait = () => new Promise(resolve => setTimeout(resolve, 25));
function button(text, scope = document) { return [...scope.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.querySelector('b')?.textContent === text); }
async function click(node) { assert.ok(node, 'button exists'); await api.act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(); }); }
try {
  const outfile = join(dir, 'probe.mjs');
  await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import AccountScreen,{LoginHost} from './screens/AccountScreen'; import {NavCtx} from './ui/nav';
    export {act} from 'react'; export {actions,getState,initializeStore,switchProfile,activeRepository,flushPersist,hideToast} from './store';
    export {login,logout} from './services/cloud';
    export {openAccountSheet,closeAccount} from './components/account/accountGate';
    export {ensureAccount,cancelLogin} from './services/authGate';
    const pushes=[]; export {pushes};
    export function mount(){const root=createRoot(document.getElementById('root')); root.render(<NavCtx.Provider value={{push:(...args)=>pushes.push(args),pop(){},popAll(){},replace(){}}}><AccountScreen/><LoginHost/></NavCtx.Provider>); return root;}
  `, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://account-tests.invalid'), 'import.meta.hot': 'undefined', 'process.env.NODE_ENV': JSON.stringify('development') } });
  api = await import(pathToFileURL(outfile).href);
  await api.initializeStore('guest');
  const initialReadCount = api.getState().articles.filter(article => !article.archived && (article.lastReadAt || api.getState().progress[article.id] !== undefined)).length;
  api.actions.addArticle({ id: 'single-sentence', title: 'One sentence', titleCn: '', sentences: [{ idx: 0, paragraphIdx: 0, en: 'One sentence.', zh: '一句话。' }], paragraphStarts: [0] });
  api.actions.setProgress('single-sentence', 0);
  await api.actions.upsertTask({ id: 'one-task', mode: 'word', title: 'one', reference: 'one', step: 0, draft: '', status: 'active', createdAt: 1, updatedAt: 1, attempts: [
    { id: 'complete', step: 0, text: 'done', deviceId: 'test', status: 'feedback', createdAt: 1 },
    { id: 'draft', step: 0, text: 'draft', deviceId: 'test', status: 'draft', createdAt: 1 },
    { id: 'recorded', step: 0, text: 'recorded', deviceId: 'test', status: 'recorded', createdAt: 1 },
  ] });
  await api.act(async () => { root = api.mount(); api.openAccountSheet(); await wait(); });
  const account = document.querySelector('[aria-label="账号与设置"]'); assert.ok(account);
  assert.match(account.querySelector('.v2-account-counts').textContent, /1 次作答/);
  assert.equal(Number(account.querySelectorAll('.v2-account-counts b')[2].textContent), initialReadCount + 1);
  console.log('PASS account statistics count completed answers, excluding drafts and recordings');

  await click(button('阅读设置', account));
  let child = document.querySelector('.sheet.on[aria-label="阅读设置"]'); assert.ok(child);
  assert.equal(child.parentElement, document.body); assert.equal(child.style.zIndex, '131'); assert.equal(account.hasAttribute('inert'), true);
  assert.equal(api.pushes.length, 0);
  await click(button('20', child)); assert.equal(api.getState().reader.fs, 20);
  child.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await click(button('完成设置', child));
  assert.match(button('阅读设置', account).textContent, /20px/); assert.equal(account.hasAttribute('inert'), false);
  console.log('PASS reading settings open the real reader preferences above the account and return in place');

  await click(button('语音与朗读', account));
  child = document.querySelector('.sheet.on[aria-label="语音与朗读"]'); assert.ok(child);
  assert.equal(child.parentElement, document.body); assert.equal(child.style.zIndex, '131'); assert.equal(account.hasAttribute('inert'), true);
  assert.doesNotMatch(child.textContent, /APP ID|API Key|API Secret|讯飞开放平台/);
  await api.act(async () => { child.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); });
  assert.equal(document.querySelector('.sheet.on[aria-label="语音与朗读"]'), null); assert.equal(account.hasAttribute('inert'), false);
  console.log('PASS voice settings use the same account child layer and Escape returns to the account');

  let pending;
  await api.act(async () => { api.closeAccount(); pending = api.ensureAccount({ reason: 'test' }); await wait(); });
  const login = document.querySelector('[data-view="login"]'); assert.ok(login);
  assert.equal(login.querySelector('#login-account').type, 'email'); assert.doesNotMatch(login.textContent, /手机号|电脑快登/);
  await click(button('密码', login)); await click(button('忘记密码？', login));
  const codeLogin = document.querySelector('[aria-label="验证码登录"]'); assert.ok(codeLogin);
  assert.equal(codeLogin.querySelector('input[type="password"]'), null); assert.ok(button('验证并登录', codeLogin));
  assert.doesNotMatch(codeLogin.textContent, /新密码|使用新密码/);
  console.log('PASS login accepts email and password recovery offers real code login without a fake reset');
  await click(button('返回登录', codeLogin));
  await api.act(async () => { await api.cancelLogin(); await wait(); }); assert.equal(await pending, false);
  globalThis.fetch = async url => {
    assert.match(String(url), /\/v1\/auth\/login$/);
    return new Response(JSON.stringify({ user: { id: 'account-test', email: 'learner@test.local', nickname: null, plan: 'free' }, accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await api.act(async () => { await api.login('learner@test.local', 'test-password', 'password'); await api.switchProfile('account-test', false); api.openAccountSheet(); await wait(); });
  const signed = document.querySelector('[aria-label="账号与设置"]');
  assert.equal(signed.querySelector('.v2-account-head b').textContent, 'learner');
  assert.equal(signed.querySelector('.v2-account-head small').textContent, 'learner@test.local');
  assert.equal(signed.querySelector('.v2-account-sync b').textContent, '准备同步');
  assert.equal(signed.querySelector('.v2-account-sync button').textContent, '立即同步');
  assert.equal(signed.querySelector('.acct-body > .btn-ghost'), null);
  console.log('PASS signed-in identity avoids duplicate email and first sync uses a compact inline action');
  await api.flushPersist();
  console.log('5 account settings regression checks passed');
} finally {
  if (root && api) await api.act(async () => root.unmount());
  api?.activeRepository()?.close(); api?.hideToast(); globalThis.fetch = originalFetch;
  dom.window.close(); for (const id of timeouts) timers.clearTimeout(id); for (const id of intervals) timers.clearInterval(id);
  channels.forEach(channel => { channel.port1.close(); channel.port2.close(); }); globalThis.MessageChannel = OriginalMessageChannel;
  Object.assign(globalThis, timers); await rm(dir, { recursive: true, force: true });
}
