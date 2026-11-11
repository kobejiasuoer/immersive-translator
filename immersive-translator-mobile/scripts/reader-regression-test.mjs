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

async function runtime({ translated = true, mode = 'en', preview = false } = {}) {
  const dom = new JSDOM('<html><body><div class="app"><div class="push in" data-view="reader"><div id="root"></div></div></div></body></html>', { url: 'https://reader.test' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollTo = function(options) { this.scrollTop = options.top; };
  Object.assign(globalThis, { window: w, document: w.document, Node: w.Node, Element: w.Element, HTMLElement: w.HTMLElement, Event: w.Event, MouseEvent: w.MouseEvent, CustomEvent: w.CustomEvent, getComputedStyle: w.getComputedStyle.bind(w), requestAnimationFrame: callback => w.setTimeout(callback, 0) });
  const article = { id: 'reading-test', title: 'A complete English article heading that must remain available', titleCn: '中文文章标题', sourceType: 'paste', paragraphStarts: [0, 2], sentences: [
    { idx: 0, paragraphIdx: 0, en: 'The first sentence.', zh: translated ? '第一句译文。' : null },
    { idx: 1, paragraphIdx: 0, en: 'Another sentence in the same paragraph.', zh: translated ? '同段的第二句译文。' : null },
    { idx: 2, paragraphIdx: 1, en: 'A second paragraph.', zh: translated ? '第二段译文。' : null },
  ] };
  let state = { cloud: { account: { id: 'test' }, generation: 0 }, articles: preview ? [] : [article], progress: {}, readingCompleted: {}, vocab: [], reader: { mode, mask: true, fs: 18, lh: 1.78, rate: .85, topic: 'paper', chunkMark: true, coachDismissed: true }, settings: { fsScale: 1 }, tasks: [], sentenceZh: {}, sentenceParseCache: {}, sheet: null, remaskAt: 0, readerTarget: null };
  const listeners = new Set(), calls = { progress: [], read: [], voices: [], translations: [], analyses: [], navigation: [], sheet: null, sentence: null };
  const update = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const actions = {
    setReading() {},
    setProgress(id, index) { calls.progress.push(index); update({ progress: { ...state.progress, [id]: index } }); },
    markRead(id, index) { calls.read.push(index); },
    setCompleted(id, completed = true) { update({ readingCompleted: { ...state.readingCompleted, [id]: completed } }); },
    setReaderPrefs(patch) { update({ reader: { ...state.reader, ...patch } }); },
    setSheet(sheet) { calls.sheet = sheet; update({ sheet }); },
    cacheSentenceParse() {},
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
      // Layout is checked in the real browser; this harness executes component behavior.
      if (name.endsWith('.css')) return {};
      if (name === 'react') return React;
      if (name === '../store' || name === '../../store') return store;
      if (name === './LearningHome') return { openPractice: async () => {} };
      if (['../services/cloud', '../../services/cloud', './cloud'].includes(name)) return {
        useCloud: () => store.useApp(s => s.cloud), cloudState: () => state.cloud,
        subscribeCloud(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async cloudChat() { throw new Error('Reader regression must not unexpectedly request English help'); },
      };
      if (name === './authGate' && file.endsWith('/services/readingHelp.ts')) return { async ensureAccount() { return true; } };
      if (name === '../services/translate') return { startTranslate(text, handlers, options) { const request = { text, handlers, options, stopped: false }; calls.translations.push(request); return { stop() { request.stopped = true; } }; } };
      if (name === '../ui/nav') return { useNav: () => ({ pop() {}, push() {}, replace(name, props) { calls.navigation.push({ name, props }); } }) };
      if (name === '../components/account/accountGate') return { openAccountSheet() {} };
      if (name === './sentenceParse') return { async parseSentence(text) { calls.analyses.push(text); return { zh: '分析译文', trunk: text, parts: [] }; } };
      if (name === '../components/reading/SentenceSheet') {
        const { SentenceSheet } = load(path.join(project, 'src/components/reading/SentenceSheet.tsx'));
        return { SentenceSheet(props) { calls.sentence = props; return React.createElement(SentenceSheet, props); } };
      }
      if (name.startsWith('../components/reading/') && !name.endsWith('/meta')) {
        const component = name.split('/').at(-1);
        return { [component]() { return null; } };
      }
      if (name.startsWith('.')) { let next = path.resolve(path.dirname(file), name); if (!path.extname(next)) next += fs.existsSync(next + '.ts') ? '.ts' : '.tsx'; return load(next); }
      return require(name);
    };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    mod._compile(code, file); return mod.exports;
  }
  const Reader = load(path.join(project, 'src/screens/ReaderScreen.tsx')).default;
  function Host() { const articles = store.useApp(s => s.articles); return React.createElement(Reader, { article: preview ? article : articles[0] }); }
  const { createRoot } = require('react-dom/client');
  let root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Host)); await tick(); });
  const click = async label => { await act(async () => { const available = [...document.querySelectorAll('button')].filter(el => !el.disabled && !el.closest('[inert]')); const button = available.find(el => el.getAttribute('aria-label') === label) || available.find(el => el.textContent.includes(label)); assert(button, 'Missing available button: ' + label); button.click(); await tick(); }); };
  const change = async patch => { await act(async () => { actions.setReaderPrefs(patch); await tick(); }); };
  const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(document.getElementById('root')); await act(async () => { root.render(React.createElement(Host)); await tick(); }); };
  const close = async () => { await act(async () => { root.unmount(); }); dom.window.close(); };
  const expand = async () => { if (!document.querySelector('.reader-listen-controls')) await click('展开朗读控制'); };
  const help = async () => { await click('阅读帮助'); };
  const choose = async (startIdx, startOffset, endIdx, endOffset) => {
    const point = (idx, offset) => {
      const el = document.querySelector(`[data-si="${idx}"] .sent-en`);
      assert(el, 'Missing source sentence: ' + idx);
      const walker = document.createTreeWalker(el, w.NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) { if (offset <= node.textContent.length) return [node, offset]; offset -= node.textContent.length; }
      assert.fail('Selection offset outside source sentence');
    };
    await act(async () => {
      const selection = w.getSelection(); selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      const range = document.createRange(); range.setStart(...point(startIdx, startOffset)); range.setEnd(...point(endIdx, endOffset));
      selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); await tick();
    });
  };
  const select = async (idx, text) => { const source = document.querySelector(`[data-si="${idx}"] .sent-en`).textContent; const start = source.indexOf(text); assert(start >= 0); await choose(idx, start, idx, start + text.length); };
  return { calls, actions, click, change, remount, close, expand, help, select, choose, store, load, state: () => state, update: async patch => { await act(async () => { update(patch); }); } };
}

const prose = () => document.querySelector('.reader-prose');
const sentenceLabel = () => document.querySelector('.reader-listen-label small').textContent;
const activeHelp = () => document.querySelector('.sheet.on[aria-label="阅读帮助"]');

for (const mode of ['en', 'bi', 'zh']) test('Continuous English remains visible with historical ' + mode + ' preferences', async () => {
  const r = await runtime({ mode });
  try {
    assert.equal(prose().textContent.replace(/\s+/g, ' ').trim(), 'The first sentence. Another sentence in the same paragraph. A second paragraph.');
    assert.equal(document.querySelectorAll('.reader-paragraph').length, 2);
    assert.equal(document.querySelector('.rd-original').querySelectorAll('[data-si]').length, 2);
    assert(document.querySelector('.rd-article-title').textContent.includes('must remain available'));
    assert(!document.querySelector('.rd-language-mode'));
    assert(!document.querySelector('.rd-translated'));
    assert(!document.querySelector('.reader-mask'));
    assert(!prose().textContent.includes('第一句译文'));
    assert.equal(r.state().reader.mode, mode, 'The reader must not destroy historical preferences');
    assert.equal(r.state().articles[0].sentences[0].zh, '第一句译文。');
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
  } finally { await r.close(); }
});

test('Playback is compact by default and its expanded controls can be collapsed again', async () => {
  const r = await runtime();
  try {
    assert(!document.querySelector('.reader-listen-controls'));
    assert(document.querySelector('[aria-label="播放"]'));
    assert(document.querySelector('[aria-label="阅读帮助"]'));
    const expand = document.querySelector('[aria-label="展开朗读控制"]');
    assert.equal(expand.getAttribute('aria-expanded'), 'false');
    await r.expand();
    assert(document.querySelector('.reader-listen-controls'));
    assert.equal(document.querySelector('[aria-label="收起朗读控制"]').getAttribute('aria-expanded'), 'true');
    await r.click('收起朗读控制');
    assert(!document.querySelector('[aria-label="下一句"]'));
    assert.equal(r.calls.voices.length, 0);
  } finally { await r.close(); }
});

test('Ordinary source clicks retain native selection without opening dictionary or sentence tools', async () => {
  const r = await runtime();
  try {
    await act(async () => { document.querySelector('[data-t="first"]').click(); });
    assert.equal(r.calls.sheet, null);
    assert.equal(r.calls.sentence.open, false);
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
    await r.select(0, 'first sentence');
    assert.equal(window.getSelection().toString(), 'first sentence');
    assert.equal(r.calls.sheet, null);
    assert.equal(r.calls.sentence.open, false);
    assert(document.querySelector('.reader-explain'));
  } finally { await r.close(); }
});

test('Explaining a selected phrase keeps the exact text and its source sentence identity', async () => {
  const r = await runtime();
  try {
    await r.select(1, 'same paragraph');
    assert.equal(document.querySelector('.reader-selection-text').textContent, 'same paragraph');
    assert.equal(r.calls.sheet, null);
    await r.click('解释');
    assert.equal(r.calls.sheet.kind, 'dict');
    assert.equal(r.calls.sheet.entry.word, 'same paragraph');
    assert.equal(r.calls.sheet.entry.articleId, 'reading-test');
    assert.equal(r.calls.sheet.entry.sentIdx, 1);
    assert.equal(r.calls.sheet.entry.sentence, 'Another sentence in the same paragraph.');
    assert.equal(document.activeElement, document.querySelector('[aria-label="阅读帮助"]'), 'A disappearing selection trigger hands focus to a surviving help control');
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
    assert(!document.querySelector('.reader-selection'));
  } finally { await r.close(); }
});

for (const [idx, text, expectedKind] of [[1, 'same paragraph', 'word'], [2, 'A second paragraph.', 'sentence']]) {
  test('Native selection collapse before a touch click preserves the selected ' + expectedKind + ' action', async () => {
    const r = await runtime();
    try {
      await r.select(idx, text);
      const button = document.querySelector('.reader-explain');
      // iOS may dismiss its native selection before pointerup/click reaches the
      // custom action. Flush each phase so React can actually unmount a lost target.
      await act(async () => {
        button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
        window.getSelection().removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
        await tick();
      });
      assert(button.isConnected, 'The explicit action must survive native selection collapse');
      assert.equal(r.calls.sheet, null);
      assert.equal(r.calls.sentence.open, false);
      await act(async () => { button.dispatchEvent(new Event('pointerup', { bubbles: true })); await tick(); });
      assert(button.isConnected, 'The pointerup refresh must not remove the click target');
      await act(async () => { button.click(); await tick(); });
      if (expectedKind === 'word') {
        assert.equal(r.calls.sheet.kind, 'dict');
        assert.equal(r.calls.sheet.entry.word, text);
        assert.equal(r.calls.sheet.entry.sentIdx, idx);
      } else {
        assert.equal(r.calls.sentence.open, true);
        assert.equal(r.calls.sentence.sentIdx, idx);
      }
      assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
      assert(!document.querySelector('.reader-selection'));
    } finally { await r.close(); }
  });
}

test('Cancelled selection-action touch never queries and a subsequent outside touch dismisses its snapshot', async () => {
  const r = await runtime();
  try {
    await r.select(0, 'first');
    const button = document.querySelector('.reader-explain');
    await act(async () => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      window.getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      button.dispatchEvent(new Event('pointercancel', { bubbles: true }));
      await tick();
    });
    assert(button.isConnected, 'Cancelling a touch must not consume the selected text');
    assert.equal(r.calls.sheet, null);
    assert.equal(r.calls.sentence.open, false);
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
    await act(async () => {
      prose().dispatchEvent(new Event('pointerdown', { bubbles: true }));
      prose().dispatchEvent(new Event('pointerup', { bubbles: true }));
      await tick();
    });
    assert(!document.querySelector('.reader-selection'));
    assert.equal(r.calls.sheet, null);
  } finally { await r.close(); }
});

test('A whole source sentence opens help only after the explicit selection action', async () => {
  const r = await runtime();
  try {
    await r.select(2, 'A second paragraph.');
    assert.equal(r.calls.sentence.open, false);
    await r.click('理解这句');
    assert.equal(r.calls.sentence.sentIdx, 2);
    assert.equal(r.calls.sentence.article.id, 'reading-test');
    assert.equal(activeHelp().querySelector('.reader-help-sentence').textContent, 'A second paragraph.');
    assert.equal(r.calls.sheet, null);
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
    await r.click('关闭当前面板');
    assert.equal(document.activeElement, document.querySelector('[aria-label="阅读帮助"]'), 'Closing selected-sentence help returns to its stable help control');
  } finally { await r.close(); }
});

test('Cross-sentence selection never attributes the selected text to only the first sentence', async () => {
  const r = await runtime();
  try {
    await r.choose(0, 4, 1, 7);
    assert(document.querySelector('.reader-selection[role="status"]').textContent.includes('请选一个词组或单句'));
    assert(!document.querySelector('.reader-explain'));
    assert.equal(r.calls.sheet, null);
    assert.equal(r.calls.sentence.open, false);
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
    await r.click('收起选文帮助');
    assert(!document.querySelector('.reader-selection'));
  } finally { await r.close(); }
});

test('A native range ending at a paragraph child boundary retains its sentence identity', async () => {
  const r = await runtime();
  try {
    await act(async () => {
      const paragraph = document.querySelector('.reader-paragraph');
      const range = document.createRange(); range.setStart(paragraph, 0); range.setEnd(paragraph, 1);
      window.getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); await tick();
    });
    await r.click('理解这句');
    assert.equal(r.calls.sentence.sentIdx, 0);
    assert.equal(activeHelp().querySelector('.reader-help-sentence').textContent, 'The first sentence.');
    assert.equal(r.calls.sheet, null);
  } finally { await r.close(); }
});

test('Saved translations, overrides and vocabulary remain available through deliberate help', async () => {
  const r = await runtime({ mode: 'zh' });
  try {
    const saved = { id: 'saved-first', word: 'first', kind: 'word', senses: [{ pos: 'adj.', cn: '原收藏释义' }], sourceArticleId: 'reading-test' };
    await r.update({ vocab: [saved], sentenceZh: { 'reading-test': { 0: '用户自己的译文' } } });
    await r.help();
    assert(!activeHelp().querySelector('.reader-help-translation'));
    await r.click('查看中文意思');
    assert.equal(activeHelp().querySelector('.reader-help-translation p').textContent, '用户自己的译文');
    await r.click('收起中文意思');
    assert(!activeHelp().querySelector('.reader-help-translation'));
    await r.click('关闭当前面板');
    await r.select(0, 'first');
    await r.click('解释');
    assert.equal(r.calls.sheet.entry.saved, true);
    assert.deepEqual(r.calls.sheet.entry.senses, saved.senses);
    assert.deepEqual(r.state().vocab, [saved]);
    assert.equal(r.state().articles[0].sentences[0].zh, '第一句译文。');
    assert.equal(r.state().sentenceZh['reading-test'][0], '用户自己的译文');
    assert.equal(r.calls.translations.length + r.calls.analyses.length, 0);
  } finally { await r.close(); }
});

test('Next sentence saves the breakpoint and survives remount with collapsed controls', async () => {
  const r = await runtime();
  try { await r.expand(); await r.click('下一句'); assert.equal(r.state().progress['reading-test'], 1); await r.remount(); assert(sentenceLabel().includes('2 / 3')); assert(!document.querySelector('.reader-listen-controls')); }
  finally { await r.close(); }
});

test('Current-sentence help has an explicit expanded control independent of source hit targets', async () => {
  const r = await runtime();
  try { await r.expand(); await r.click('查看第 1 句，共 3 句'); assert.equal(r.calls.sentence.open, true); assert.equal(r.calls.sentence.sentIdx, 0); assert(activeHelp()); assert.equal(r.calls.translations.length + r.calls.analyses.length, 0); }
  finally { await r.close(); }
});

test('Continuous playback consumes the latest speed on its next sentence', async () => {
  const r = await runtime();
  try { await r.click('播放'); assert.equal(r.calls.voices[0].rate, .85); await r.change({ rate: 1.15 }); await act(async () => { r.calls.voices[0].end(); await tick(); }); assert.equal(r.calls.voices[1].rate, 1.15); assert(document.querySelector('[aria-label="暂停朗读"]')); }
  finally { await r.close(); }
});

test('Failed on-demand drafts stay out of storage and the actual help panel offers retry', async () => {
  const r = await runtime({ translated: false, mode: 'zh' });
  try {
    await r.help(); await r.click('翻译这句'); const first = r.calls.translations[0];
    await act(async () => { first.handlers.onDelta('半截'); });
    assert.equal(activeHelp().querySelector('.reader-translation-draft').textContent, '半截');
    assert.equal(r.state().articles[0].sentences[0].zh, null);
    assert(!prose().textContent.includes('半截'));
    await act(async () => { first.handlers.onFail('网络中断'); });
    assert.equal(activeHelp().querySelector('[role="alert"]').textContent, '网络中断');
    await r.click('重试翻译');
    await act(async () => { r.calls.translations[1].handlers.onDone('完整译文', 1); });
    assert.equal(r.state().articles[0].sentences[0].zh, '完整译文');
    assert.equal(activeHelp().querySelector('.reader-help-translation p').textContent, '完整译文');
    assert(!prose().textContent.includes('完整译文'));
  } finally { await r.close(); }
});

test('Leaving stops the active request and ignores its late translation result', async () => {
  const r = await runtime({ translated: false });
  await r.help(); await r.click('翻译这句'); const first = r.calls.translations[0];
  await r.close(); assert.equal(first.stopped, true); first.handlers.onDone('迟到的文本', 1); assert.equal(r.state().articles[0].sentences[0].zh, null);
});

test('Closing real sentence help cancels its draft and a new request rejects the old result', async () => {
  const r = await runtime({ translated: false });
  try {
    await r.help(); await r.click('翻译这句'); const old = r.calls.translations[0];
    await act(async () => { old.handlers.onDelta('未完成草稿'); });
    await r.click('关闭当前面板');
    assert.equal(old.stopped, true);
    assert.equal(r.state().articles[0].sentences[0].zh, null);
    await r.help(); await r.click('翻译这句');
    await act(async () => { old.handlers.onDelta('旧草稿'); old.handlers.onDone('旧结果', 1); });
    assert.equal(r.state().articles[0].sentences[0].zh, null);
    assert(!activeHelp().textContent.includes('旧草稿'));
    await act(async () => { r.calls.translations[1].handlers.onDone('新请求完整译文', 1); });
    assert.equal(r.state().articles[0].sentences[0].zh, '新请求完整译文');
  } finally { await r.close(); }
});

test('Unconfigured translation displays actionable feedback without persisting guidance', async () => {
  const r = await runtime({ translated: false });
  try {
    await r.help(); await r.click('翻译这句');
    await act(async () => { r.calls.translations[0].handlers.onUnconfigured(); });
    assert(activeHelp().querySelector('[role="status"]').textContent.includes('尚未设置翻译服务'));
    assert.equal(r.state().articles[0].sentences[0].zh, null);
    await r.click('重试翻译');
    await act(async () => { r.calls.translations[1].handlers.onDone('配置后的完整译文', 1); });
    assert.equal(r.state().articles[0].sentences[0].zh, '配置后的完整译文');
  } finally { await r.close(); }
});

test('On-demand translation does not automatically request the remaining article', async () => {
  const r = await runtime({ translated: false });
  try {
    assert(!document.querySelector('[aria-label="正文语言"]'));
    await r.help(); await r.click('翻译这句');
    assert.equal(r.calls.translations.length, 1);
    await act(async () => { r.calls.translations[0].handlers.onDone('第一句', 1); await tick(); });
    assert.equal(r.calls.translations.length, 1);
    assert.equal(r.state().articles[0].sentences[1].zh, null);
    await r.click('关闭当前面板'); await r.expand(); await r.click('下一句'); await r.help(); await r.click('翻译这句');
    assert.equal(r.calls.translations.length, 2);
    assert.equal(r.calls.translations[1].text, 'Another sentence in the same paragraph.');
  } finally { await r.close(); }
});

test('Reading help requests English-to-Chinese regardless of the general direction', async () => {
  const r = await runtime({ translated: false });
  try { await r.update({ settings: { fsScale: 1, dir: 'c2e' } }); await r.help(); await r.click('翻译这句'); assert.equal(r.calls.translations[0].options.direction, 'e2c'); assert.equal(r.state().settings.dir, 'c2e'); }
  finally { await r.close(); }
});

test('Preview translations appear in actual sentence help without persisting the sample', async () => {
  const r = await runtime({ translated: false, preview: true });
  try { await r.help(); await r.click('翻译这句'); await act(async () => { r.calls.translations[0].handlers.onDone('预览中文译文', 1); }); assert.equal(activeHelp().querySelector('.reader-help-translation p').textContent, '预览中文译文'); assert.equal(r.calls.sentence.article.sentences[0].zh, '预览中文译文'); assert.equal(r.state().articles.length, 0); assert(!prose().textContent.includes('预览中文译文')); }
  finally { await r.close(); }
});

test('Chapter footer skips archived and empty chapters, completes the current chapter and never starts audio', async () => {
  const r = await runtime();
  try { const current = { ...r.state().articles[0], bookId: 'book-test', chapterIdx: 0 }; const sibling = (id, chapterIdx, patch = {}) => ({ ...current, id, chapterIdx, ...patch }); await r.update({ articles: [current, sibling('other-book', 1, { bookId: 'other' }), sibling('chapter-3', 3), sibling('empty-chapter', 1, { sentences: [] }), sibling('hidden-chapter', 2, { archived: true })] }); await r.click('继续下一章'); assert.deepEqual(r.calls.navigation, [{ name: 'reader', props: { articleId: 'chapter-3' } }]); assert.equal(r.state().readingCompleted[current.id], true); assert.equal(r.state().progress[current.id], 2); assert.equal(r.calls.voices.length, 0); }
  finally { await r.close(); }
});

test('Final chapters and standalone articles do not offer a next-chapter action', async () => {
  const r = await runtime();
  try { assert(!document.querySelector('.reader-next-chapter')); await r.update({ articles: [{ ...r.state().articles[0], bookId: 'final-book', chapterIndex: 1 }] }); assert(!document.querySelector('.reader-next-chapter')); }
  finally { await r.close(); }
});

test('Cancelled output cannot overwrite a fresh on-demand translation after remount', async () => {
  const r = await runtime({ translated: false });
  try { await r.help(); await r.click('翻译这句'); const cancelled = r.calls.translations[0]; await r.remount(); assert.equal(cancelled.stopped, true); await r.help(); await r.click('翻译这句'); const resumed = r.calls.translations[1]; await act(async () => { cancelled.handlers.onDelta('过期片段'); cancelled.handlers.onDone('过期结果', 1); }); assert.equal(r.state().articles[0].sentences[0].zh, null); await act(async () => { resumed.handlers.onDone('重试完整译文', 1); await tick(); }); assert.equal(r.state().articles[0].sentences[0].zh, '重试完整译文'); assert.equal(r.calls.translations.length, 2); }
  finally { await r.close(); }
});

test('Manual sentence navigation invalidates previous playback callbacks', async () => {
  const r = await runtime();
  try { await r.click('播放'); const original = r.calls.voices[0]; await r.expand(); await r.click('下一句'); await act(async () => { original.end(); await tick(); }); assert.equal(r.calls.voices.length, 1); assert.equal(r.state().progress['reading-test'], 1); await r.click('播放'); assert.equal(r.calls.voices[1].text, 'Another sentence in the same paragraph.'); }
  finally { await r.close(); }
});

test('Explicit completion survives reopening without mutating saved translations', async () => {
  const r = await runtime();
  try { await r.click('标记读完'); assert.equal(r.state().readingCompleted['reading-test'], true); await r.remount(); assert(document.querySelector('.reader-document-end').textContent.includes('已读完')); assert.equal(r.state().articles[0].sentences[0].zh, '第一句译文。'); }
  finally { await r.close(); }
});

test('Reading type consumes global scaling and the actual line spacing preference', async () => {
  const r = await runtime();
  try { await r.change({ fs: 22, lh: 2 }); await r.update({ settings: { fsScale: 1.3 } }); const style = document.querySelector('.rd-body').style; assert.equal(style.getPropertyValue('--rd-fs'), '28.6px'); assert.equal(style.getPropertyValue('--rd-lh'), '2'); }
  finally { await r.close(); }
});

test('Changing accounts cancels on-demand translation, ignores late output and closes old help', async () => {
  const r = await runtime({ translated: false });
  try { await r.help(); await r.click('翻译这句'); const request = r.calls.translations[0]; await r.update({ cloud: { account: { id: 'another-account' }, generation: 1 } }); assert.equal(request.stopped, true); assert(!activeHelp()); await act(async () => { request.handlers.onDone('旧账号译文', 1); }); assert.equal(r.state().articles[0].sentences[0].zh, null); assert.equal(r.calls.translations.length, 1); }
  finally { await r.close(); }
});

test('An empty article offers recovery without playback or completion controls', async () => {
  const r = await runtime();
  try { await r.update({ articles: [{ ...r.state().articles[0], sentences: [], paragraphStarts: [] }] }); assert(document.body.textContent.includes('还没有可读正文')); assert(!document.querySelector('.reader-listen')); assert(!document.querySelector('.reader-document-end')); assert(!document.body.textContent.includes('1 / 0')); }
  finally { await r.close(); }
});

test('Shortened content clamps both the current sentence and saved breakpoint', async () => {
  const r = await runtime();
  try { await r.expand(); await r.click('下一句'); await r.click('下一句'); await r.update({ articles: [{ ...r.state().articles[0], sentences: [r.state().articles[0].sentences[0]], paragraphStarts: [0] }] }); assert.equal(r.state().progress['reading-test'], 0); assert(sentenceLabel().includes('1 / 1')); }
  finally { await r.close(); }
});

test('Backgrounding saves a pending manual scroll before its debounce expires', async () => {
  const r = await runtime();
  try { await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); }); const body = document.querySelector('.rd-body'); body.getBoundingClientRect = () => ({ top: 0 }); document.querySelectorAll('[data-si]').forEach((el, index) => { el.getBoundingClientRect = () => ({ top: index * 20 }); }); await act(async () => { body.dispatchEvent(new Event('scroll', { bubbles: true })); window.dispatchEvent(new Event('pagehide')); }); assert.equal(r.state().progress['reading-test'], 2); }
  finally { await r.close(); }
});

test('Explicit navigation supersedes a pending manual scroll on exit', async () => {
  const r = await runtime(); await r.expand(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
  const body = document.querySelector('.rd-body'); body.getBoundingClientRect = () => ({ top: 0 }); document.querySelectorAll('[data-si]').forEach((el, index) => { el.getBoundingClientRect = () => ({ top: index * 20 }); });
  await act(async () => { body.dispatchEvent(new Event('scroll', { bubbles: true })); }); await r.click('下一句'); await r.close(); assert.equal(r.state().progress['reading-test'], 1);
});

test('Replacing source text cancels its request and cannot receive a stale translation', async () => {
  const r = await runtime({ translated: false });
  try { await r.help(); await r.click('翻译这句'); const request = r.calls.translations[0], before = r.state().articles[0]; await r.update({ articles: [{ ...before, sentences: before.sentences.map(s => s.idx === 0 ? { ...s, en: 'Entirely changed source sentence.' } : s) }] }); assert.equal(request.stopped, true); assert(!activeHelp()); await act(async () => { request.handlers.onDone('旧原句的译文', 1); }); assert.equal(r.state().articles[0].sentences[0].zh, null); }
  finally { await r.close(); }
});

test('An active reader follows the remapped breakpoint when sentence boundaries change', async () => {
  const r = await runtime();
  try {
    await r.expand(); await r.click('下一句');
    const before = r.state().articles[0];
    const sentences = [{ ...before.sentences[0], en: before.sentences[0].en + ' ' + before.sentences[1].en }, { ...before.sentences[2], idx: 1 }];
    await r.update({ articles: [{ ...before, sentences, paragraphStarts: [0, 1] }], progress: { [before.id]: 0 } });
    assert.equal(sentenceLabel(), '第 1 / 2 句');
    await r.help();
    assert.equal(activeHelp().querySelector('.reader-help-sentence').textContent, sentences[0].en);
  } finally { await r.close(); }
});

let passed = 0;
for (const [name, run] of tests) { try { await run(); console.log('PASS ' + name); passed++; } catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; } }
console.log(`${passed}/${tests.length} reader regression scenarios passed`);
