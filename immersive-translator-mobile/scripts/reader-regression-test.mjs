import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url), ts = require('typescript');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const tests = [], test = (name, run) => tests.push([name, run]);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function runtime({ translated = true, mode = 'en' } = {}) {
  const dom = new JSDOM('<html><body><div class="push" data-view="reader"><div id="root"></div></div></body></html>', { url: 'https://reader.test' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollTo = function(options) { this.scrollTop = options.top; };
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event, CustomEvent: w.CustomEvent, requestAnimationFrame: callback => w.setTimeout(callback, 0) });
  const article = { id: 'reading-test', title: 'A complete English article heading that must remain available', titleCn: '中文文章标题', sourceType: 'paste', paragraphStarts: [0, 2], sentences: [
    { idx: 0, paragraphIdx: 0, en: 'The first sentence.', zh: translated ? '第一句译文。' : null },
    { idx: 1, paragraphIdx: 0, en: 'Another sentence in the same paragraph.', zh: translated ? '同段的第二句译文。' : null },
    { idx: 2, paragraphIdx: 1, en: 'A second paragraph.', zh: translated ? '第二段译文。' : null },
  ] };
  let state = { cloud: { account: { id: 'test' }, generation: 0 }, articles: [article], progress: {}, readingCompleted: {}, vocab: [], reader: { mode, mask: true, fs: 18, lh: 1.78, rate: .85, topic: 'paper', chunkMark: true, coachDismissed: true }, settings: { fsScale: 1 }, tasks: [], sentenceZh: {}, remaskAt: 0, readerTarget: null };
  const listeners = new Set(), calls = { progress: [], read: [], voices: [], translations: [], sheet: null, sentence: null };
  const update = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const actions = {
    setReading() {},
    setProgress(id, index) { calls.progress.push(index); update({ progress: { ...state.progress, [id]: index } }); },
    markRead(id, index) { calls.read.push(index); },
    setCompleted(id, completed = true) { update({ readingCompleted: { ...state.readingCompleted, [id]: completed } }); },
    setReaderPrefs(patch) { update({ reader: { ...state.reader, ...patch } }); },
    setSheet(sheet) { calls.sheet = sheet; },
    fillSentenceZh(id, index, translation) { update({ articles: state.articles.map(a => a.id === id ? { ...a, sentences: a.sentences.map(s => s.idx === index ? { ...s, zh: translation } : s) } : a) }); },
  };
  const repository = { identity: 'test' };
  const store = { actions, getState: () => state, flushPersist: async () => {}, activeRepository: () => repository, toast() {}, useApp(selector) { return React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => selector(state)); }, effectiveSentenceZh(overrides, index, fallback) { return overrides?.[index] || fallback; }, speak(text, rate, end) { calls.voices.push({ text, rate, end }); }, stopSpeak() {} };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = new Module(file); cache.set(file, mod); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod.require = name => {
      if (name === 'react') return React;
      if (name === '../store') return store;
      if (name === './LearningHome') return { openPractice: async () => {} };
      if (name === '../services/cloud') return { useCloud: () => store.useApp(s => s.cloud), cloudState: () => state.cloud };
      if (name === '../services/translate') return { startTranslate(text, handlers) { const request = { text, handlers, stopped: false }; calls.translations.push(request); return { stop() { request.stopped = true; } }; } };
      if (name === '../ui/nav') return { useNav: () => ({ pop() {}, push() {}, replace() {} }) };
      if (name === '../components/account/accountGate') return { openAccountSheet() {} };
      if (name.startsWith('../components/reading/') && !name.endsWith('/meta')) {
        const component = name.split('/').at(-1);
        return { [component](props) { if (component === 'SentenceSheet') { calls.sentence = props; return props.open ? React.createElement('div', { 'data-sentence-tools': props.sentIdx }, '本句操作') : null; } return null; } };
      }
      if (name.startsWith('.')) { let next = path.resolve(path.dirname(file), name); if (!path.extname(next)) next += fs.existsSync(next + '.ts') ? '.ts' : '.tsx'; return load(next); }
      return require(name);
    };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    mod._compile(code, file); return mod.exports;
  }
  const Reader = load(path.join(project, 'src/screens/ReaderScreen.tsx')).default;
  function Host() { const articles = store.useApp(s => s.articles); return React.createElement(Reader, { article: articles[0] }); }
  const { createRoot } = require('react-dom/client');
  let root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Host)); await tick(); });
  const click = async label => { await act(async () => { const button = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent.includes(label)); assert(button, 'Missing button: ' + label); button.click(); await tick(); }); };
  const change = async patch => { await act(async () => { actions.setReaderPrefs(patch); await tick(); }); };
  const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(document.getElementById('root')); await act(async () => { root.render(React.createElement(Host)); await tick(); }); };
  const close = async () => { await act(async () => { root.unmount(); }); dom.window.close(); };
  return { calls, actions, click, change, remount, close, store, load, state: () => state, update: async patch => { await act(async () => { update(patch); }); } };
}

test('Chinese mode always shows translations despite the bilingual mask preference', async () => { const r = await runtime(); try { await r.change({ mode: 'zh' }); assert(document.body.textContent.includes('第一句译文。')); assert(document.body.textContent.includes('第二段译文。')); assert(!document.body.textContent.includes('显示第')); assert(!document.querySelector('.reader-mask')); } finally { await r.close(); } });
test('English has its full heading, no Chinese heading, and original paragraph boundaries', async () => { const r = await runtime(); try { assert(document.querySelector('.rd-article-title').textContent.includes('must remain available')); assert(!document.querySelector('.rd-title-translation')); assert.equal(document.querySelectorAll('.rd-paragraph').length, 2); assert.equal(document.querySelector('.rd-original').querySelectorAll('[data-si]').length, 2); } finally { await r.close(); } });
test('Next sentence saves the breakpoint and survives remount', async () => { const r = await runtime(); try { await r.click('下一句'); assert.equal(r.state().progress['reading-test'], 1); await r.remount(); assert(document.querySelector('.rd-current-sentence').textContent.includes('2/3')); } finally { await r.close(); } });
test('Sentence tools have an explicit button independent of word hit targets', async () => { const r = await runtime(); try { await r.click('查看第 1 句，共 3 句'); assert.equal(r.calls.sentence.open, true); assert.equal(document.querySelector('[data-sentence-tools]').dataset.sentenceTools, '0'); } finally { await r.close(); } });
test('Continuous playback consumes the latest speed on its next sentence', async () => { const r = await runtime(); try { await r.click('播放'); assert.equal(r.calls.voices[0].rate, .85); await r.change({ rate: 1.15 }); await act(async () => { r.calls.voices[0].end(); await tick(); }); assert.equal(r.calls.voices[1].rate, 1.15); } finally { await r.close(); } });
test('Failed streaming drafts stay out of persistent translations and remain retryable', async () => { const r = await runtime({ translated: false, mode: 'zh' }); try { await r.click('翻译第 1 句'); const first = r.calls.translations[0]; await act(async () => { first.handlers.onDelta('半截'); }); assert.equal(r.state().articles[0].sentences[0].zh, null); await act(async () => { first.handlers.onFail('网络中断'); }); assert(document.body.textContent.includes('网络中断')); await r.click('重试'); await act(async () => { r.calls.translations[1].handlers.onDone('完整译文', 1); }); assert.equal(r.state().articles[0].sentences[0].zh, '完整译文'); } finally { await r.close(); } });
test('Leaving stops requests and ignores late translation results', async () => { const r = await runtime({ translated: false, mode: 'zh' }); await r.click('翻译第 1 句'); const first = r.calls.translations[0]; await r.close(); assert.equal(first.stopped, true); first.handlers.onDone('迟到的文本', 1); assert.equal(r.state().articles[0].sentences[0].zh, null); });
test('Full translation runs sequentially and can stop without saving a draft', async () => { const r = await runtime({ translated: false, mode: 'zh' }); try { await r.click('翻译剩余全文'); assert.equal(r.calls.translations.length, 1); await act(async () => { r.calls.translations[0].handlers.onDone('第一句', 1); await tick(); }); assert.equal(r.calls.translations.length, 2); await act(async () => { r.calls.translations[1].handlers.onDelta('未完成'); }); await r.click('停止翻译'); assert.equal(r.calls.translations[1].stopped, true); assert.equal(r.state().articles[0].sentences[1].zh, null); assert.equal(r.calls.translations.length, 2); } finally { await r.close(); } });
test('Explicit completion is retained when the reader is reopened', async () => { const r = await runtime(); try { await r.click('下一句'); await r.click('下一句'); await r.click('先记为读完'); assert.equal(r.state().readingCompleted['reading-test'], true); await r.remount(); assert(document.body.textContent.includes('这段已经读完')); } finally { await r.close(); } });
test('Reading type consumes global scaling and the actual line spacing preference', async () => { const r = await runtime(); try { await r.change({ fs: 22, lh: 2 }); await r.update({ settings: { fsScale: 1.3 } }); const style = document.querySelector('.rd-body').style; assert.equal(style.getPropertyValue('--rd-fs'), '28.6px'); assert.equal(style.getPropertyValue('--rd-lh'), '2'); const css = fs.readFileSync(path.join(project, 'src/ui/learning.css'), 'utf8'); assert(css.includes('.rd-continuous .sent-en{font-size:inherit;line-height:inherit}')); assert(css.includes('position:relative;flex:none;left:auto;right:auto;bottom:auto')); } finally { await r.close(); } });
test('Changing accounts terminates pending translation and its batch', async () => { const r = await runtime({ translated: false, mode: 'zh' }); try { await r.click('翻译剩余全文'); await r.update({ cloud: { account: { id: 'another-account' }, generation: 1 } }); assert.equal(r.calls.translations[0].stopped, true); assert(!document.body.textContent.includes('正在翻译')); assert.equal(r.calls.translations.length, 1); } finally { await r.close(); } });
test('An empty article offers a recovery path without playback or completion controls', async () => { const r = await runtime(); try { await r.update({ articles: [{ ...r.state().articles[0], sentences: [], paragraphStarts: [] }] }); assert(document.body.textContent.includes('还没有可读正文')); assert(!document.querySelector('.rd-playbar')); assert(!document.body.textContent.includes('1/0')); } finally { await r.close(); } });
test('Shortened content clamps both the current sentence and saved breakpoint', async () => { const r = await runtime(); try { await r.click('下一句'); await r.click('下一句'); await r.update({ articles: [{ ...r.state().articles[0], sentences: [r.state().articles[0].sentences[0]], paragraphStarts: [0] }] }); assert.equal(r.state().progress['reading-test'], 0); assert(document.querySelector('.rd-current-sentence').textContent.includes('1/1')); } finally { await r.close(); } });
test('Backgrounding saves a pending manual scroll before the debounce expires', async () => { const r = await runtime(); try { await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); }); const body = document.querySelector('.rd-body'); body.getBoundingClientRect = () => ({ top: 0 }); document.querySelectorAll('[data-si]').forEach((el, index) => { el.getBoundingClientRect = () => ({ top: index * 20 }); }); await act(async () => { body.dispatchEvent(new Event('scroll', { bubbles: true })); window.dispatchEvent(new Event('pagehide')); }); assert.equal(r.state().progress['reading-test'], 2); } finally { await r.close(); } });
test('Replacing source text cannot receive a stale translation from the old sentence', async () => { const r = await runtime({ translated: false, mode: 'zh' }); try { await r.click('翻译第 1 句'); const request = r.calls.translations[0], before = r.state().articles[0]; await r.update({ articles: [{ ...before, sentences: before.sentences.map(s => s.idx === 0 ? { ...s, en: 'Entirely changed source sentence.' } : s) }] }); assert.equal(request.stopped, true); await act(async () => { request.handlers.onDone('旧原句的译文', 1); }); assert.equal(r.state().articles[0].sentences[0].zh, null); } finally { await r.close(); } });

let passed = 0;
for (const [name, run] of tests) { try { await run(); console.log('PASS ' + name); passed++; } catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; } }
console.log(`${passed}/${tests.length} reader regression scenarios passed`);
