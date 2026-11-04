import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// Production React screens, account guard, practice service and real IndexedDB.
// Only microphone hardware and HTTP responses are controlled fixtures.
const directory = await mkdtemp(join(tmpdir(), 'ita-recording-regression-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'https://recording-tests.invalid/', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
w.scrollTo = () => {};
for (const name of ['scrollIntoView', 'scrollTo', 'setPointerCapture', 'releasePointerCapture']) w.HTMLElement.prototype[name] = function() {};
for (const name of ['document', 'localStorage', 'location', 'history', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) globalThis[name] = w[name];
globalThis.window = w;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
const warnings = [], originalWarn = console.warn, originalError = console.error, errors = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const unhandled = error => errors.push(error?.stack || String(error));
process.on('unhandledRejection', unhandled);
let asrCalls = 0, asrFailure = false;
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/v1/auth/login')) return response(200, { user: { id: 'recording-fixture', email: 'fixture@test.invalid', nickname: null, plan: 'free' }, accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresIn: 900 });
  if (url.endsWith('/v1/voice/asr')) {
    asrCalls++;
    assert.ok(JSON.parse(options.body).audio.length > 0);
    return asrFailure ? response(503, { error: { message: 'VOICE_SERVICE_UNAVAILABLE' } }) : response(200, { text: 'I would like the pasta, please.', durationMs: 1000 });
  }
  throw Error('Unexpected fixture request: ' + url);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bodyText = () => document.body.textContent.replace(/\s+/g, ' ').trim();
const button = label => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === label || el.getAttribute('aria-label') === label);
function click(el) { assert.ok(el, 'Expected button'); assert.equal(el.disabled, false); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }
async function until(check, label) { for (let i = 0; i < 300; i++) { if (check()) return; if (errors.length) throw Error(errors.join('\n')); await wait(10); } throw Error(label + ': ' + bodyText()); }
const rawProtectionError = 'AUDIO_STORAGE: FILE_PROTECTION: 文件属性读取失败： /private/var/mobile/Containers/Data/Application/example/Library/Application Support/profiles/account/audio/clip.wav';
let api, checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };

try {
  const outfile = join(directory, 'screens.mjs');
  await build({
    stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LearningPractice} from './screens/LearningPractice';import {SpokenReviewCard} from './components/vault/SpokenReviewCard';import {NavCtx} from './ui/nav';export * from './store';export * from './services/practice';export {login} from './services/cloud';let root;export let reviewState;function Review({initial}){const [state,setState]=useState(initial);reviewState=state;return <SpokenReviewCard card={{id:'test-word',mode:'spoken',word:'take a break',kind:'chunk',answer:'take a break',hint:'休息一下',sentIdx:0}} state={state} patch={patch=>setState(s=>({...s,...patch}))} articles={[]} onGrade={()=>{}} grading={false}/>;}export function render(kind,props){root??=createRoot(document.getElementById('root'));root.render(<NavCtx.Provider value={{push(){},pop(){},replace(){},popAll(){}}}><div className="app">{kind==='practice'?<LearningPractice {...props}/>:<Review {...props}/>}</div></NavCtx.Provider>);}export function unmount(){root?.unmount();root=null;reviewState=null;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'recording-regression.tsx', loader: 'tsx' },
    outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://recording-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') },
    plugins: [{ name: 'microphone-hardware-fixture', setup(builder) {
      builder.onLoad({ filter: /services\/audio\.ts$/ }, () => ({ loader: 'js', contents: `export async function startPcmCapture(options){window.captureStarts=(window.captureStarts||0)+1;const samples=new Uint8Array(32000).fill(1);const pcm=btoa(String.fromCharCode(...samples));let stopped=false;return {async stop(){if(!stopped){stopped=true;options.onChunk?.(pcm);}return {pcmB64:pcm,peak:.5,ms:1000};},cancel(){stopped=true;}};}` }));
    } }],
  });
  api = await import(pathToFileURL(outfile).href);
  await api.initializeStore('recording-fixture');
  await api.login('fixture@test.invalid', 'fixture-password', 'password');

  const safe = api.practiceError(new Error(rawProtectionError));
  assert.ok(safe.length < 100); assert.equal(safe.includes('/private/'), false); assert.equal(safe.includes('FILE_PROTECTION'), false);
  assert.ok(warnings.some(warning => warning.includes(rawProtectionError)));
  assert.equal(api.practiceError(new Error('请先填写回答。')), '请先填写回答。');
  pass('native storage paths stay in diagnostics while the learner sees concise recovery guidance');

  const repo = api.activeRepository();
  const begin = repo.audioBegin.bind(repo);
  repo.audioBegin = async () => { throw new Error(rawProtectionError); };
  const task = api.createPracticeTask({ mode: 'scenario', title: '场景对话 · 点餐', reference: 'What would you like to order?' });
  task.draft = 'Keep this existing answer.';
  await api.actions.upsertTask(task);
  api.render('practice', { taskId: task.id }); await until(() => button('开始回答录音'), 'practice');
  click(button('开始回答录音')); await until(() => button('允许，并开始录音'), 'permission'); click(button('允许，并开始录音'));
  await until(() => document.querySelector('[role=alert]'), 'storage preparation error');
  const failed = api.getState().tasks.find(t => t.id === task.id);
  assert.equal(failed.attempts.at(-1).clipId, undefined);
  assert.equal(failed.draft, 'Keep this existing answer.'); assert.equal(w.captureStarts || 0, 0);
  assert.equal(button('重新识别已保存的原声'), undefined); assert.equal(bodyText().includes('/private/'), false);
  pass('failed recording preparation retains text and never manufactures a saved original');
  repo.audioBegin = begin;
  click(button('开始回答录音')); click(button('允许，并开始录音')); await until(() => button('结束录音'), 'retry capture'); click(button('结束录音'));
  await until(() => api.getState().tasks.find(t => t.id === task.id).attempts.at(-1).status === 'draft', 'retry transcript');
  assert.equal(api.getState().tasks.find(t => t.id === task.id).draft, 'I would like the pasta, please.');
  assert.equal(asrCalls, 1);
  pass('recording can be retried after storage recovery and reaches the real transcription flow once');
  api.unmount(); await wait(20);

  const legacy = api.createPracticeTask({ mode: 'scenario', title: 'Legacy failed preparation', reference: 'Say one sentence.' });
  legacy.attempts.push({ id: 'legacy-attempt', step: 0, text: '', deviceId: api.deviceId(), clipId: 'never-created', status: 'failed', error: rawProtectionError, createdAt: Date.now() });
  await api.actions.upsertTask(legacy); api.render('practice', { taskId: legacy.id }); await until(() => button('开始回答录音'), 'legacy practice'); await wait(30);
  assert.equal(button('重新识别已保存的原声'), undefined);
  pass('existing failed attempts with stale clip identifiers cannot claim a saved original');
  api.unmount(); await wait(20);

  api.render('review', { initial: { stage: 'ask', text: 'Keep my review draft.' } }); await until(() => button('录音试说'), 'spoken review');
  click(button('录音试说')); click(button('允许并开始')); await until(() => button('结束录音'), 'review recording'); click(button('结束录音'));
  await until(() => api.reviewState?.text === 'I would like the pasta, please.', 'review transcription');
  assert.equal(asrCalls, 2); assert.equal(api.reviewState.stage, 'confirm');
  const originalClip = api.reviewState.clipId;
  assert.equal((await repo.audioManifest(originalClip)).status, 'ready');
  pass('spoken review transcribes immediately after saving rather than being blocked by its own busy guard');

  await until(() => button('重新录一次'), 'saved review recording');
  const finalize = repo.audioFinalize.bind(repo);
  repo.audioFinalize = async () => { throw new Error(rawProtectionError); };
  click(button('重新录一次')); click(button('允许并开始')); await until(() => button('结束录音'), 'replacement review recording'); click(button('结束录音'));
  await until(() => document.querySelector('[role=alert]'), 'review save failure');
  assert.equal(api.reviewState.clipId, originalClip); assert.equal(api.reviewState.text, 'I would like the pasta, please.');
  assert.equal((await repo.audioManifest(originalClip)).status, 'ready'); assert.equal(asrCalls, 2);
  assert.equal(bodyText().includes('/private/'), false);
  repo.audioFinalize = finalize;
  pass('a failed replacement recording preserves the previous playable original and confirmed text');
  api.unmount(); await wait(20);

  asrFailure = true;
  api.render('review', { initial: { stage: 'ask', text: '' } }); await until(() => button('录音试说'), 'review ASR failure');
  click(button('录音试说')); click(button('允许并开始')); await until(() => button('结束录音'), 'failure recording'); click(button('结束录音'));
  await until(() => document.querySelector('[role=alert]') && api.reviewState.stage === 'confirm', 'ASR failure recovery');
  assert.ok(api.reviewState.clipId); assert.equal((await repo.audioManifest(api.reviewState.clipId)).status, 'ready');
  await until(() => button('重新识别原声'), 'explicit recognition retry'); assert.equal(asrCalls, 3);
  asrFailure = false; click(button('重新识别原声'));
  await until(() => api.reviewState.text === 'I would like the pasta, please.', 'explicit ASR retry'); assert.equal(asrCalls, 4);
  pass('ASR failure retains the saved original and retries only after an explicit tap');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: ' + checks + ' recording failure/recovery regressions');
} finally {
  api?.unmount(); api?.hideToast(); api?.stopSpeak();
  try { await api?.flushPersist(); api?.activeRepository().close(); } catch {}
  dom.window.close(); console.warn = originalWarn; console.error = originalError; process.removeListener('unhandledRejection', unhandled);
  await rm(directory, { recursive: true, force: true });
}
