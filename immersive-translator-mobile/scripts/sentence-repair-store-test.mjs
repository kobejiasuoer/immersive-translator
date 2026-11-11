import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<html><body></body></html>', { url: 'https://reader.test' });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, { indexedDB, IDBKeyRange, window: w, document: w.document, localStorage: w.localStorage, Event: w.Event, CustomEvent: w.CustomEvent, requestAnimationFrame: callback => callback() });
const hooks = { failRepair: false }, cache = new Map(), commits = [];
const device = { isTauri: () => false, haptic() {}, reportDiag() {} };
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file); cache.set(file, mod); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod.require = name => {
    if (name === './services/device') return device;
    if (name === './services/voice') return { prepareAudioPlayback() {}, speakCloud() {}, voiceErrorText: String };
    if (name === './services/cloud') return { cloudState: () => ({ account: null, generation: 0 }) };
    if (name === './services/authGate') return { ensureAccount: async () => false };
    if (name === './core/persistence') return { createPersistence: async identity => {
      const repo = await persistence.createPersistence(identity), commit = repo.commit.bind(repo);
      repo.commit = async input => {
        if (input.records?.some(row => row.collection === 'reader.sentence-repairs')) {
          if (hooks.failRepair) throw new Error('injected atomic repair failure');
          commits.push(structuredClone(input));
        }
        return commit(input);
      };
      return repo;
    } };
    if (name.startsWith('.')) {
      let next = path.resolve(path.dirname(file), name);
      if (!path.extname(next)) next = fs.existsSync(next + '.ts') ? next + '.ts' : path.join(next, 'index.ts');
      return load(next);
    }
    return require(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports;
}
const persistence = load(path.join(root, 'src/core/persistence.ts'));
const store = load(path.join(root, 'src/store.ts'));
const prefix = 'sentence-repair-' + crypto.randomUUID();
const article = {
  id: 'news', title: 'News', titleCn: '', sourceType: 'paste', createdAt: 1, lastReadAt: 2, paragraphStarts: [0],
  sentences: ['The U.S.', 'Department approved the plan.', 'It starts tomorrow.'].map((en, idx) => ({ idx, paragraphIdx: 0, en, zh: ['美国', '部门批准该计划。', '明天开始。'][idx], zhState: 'machine' })),
};
let base;
function legacyState() {
  return { ...structuredClone(base), articles: [structuredClone(article)], progress: { news: 2 }, readingCompleted: { news: true },
    vocab: [{ id: 'saved', word: 'Department', sourceArticleId: 'news', sourceSentenceIdx: 1, senses: [{ pos: 'n.', cn: '部门' }], dueAt: 1, createdAt: 1, generation: 'same' }],
    notes: [{ id: 'note', title: 'Keep', body: 'My note', sub: '', insight: '', sourceArticleId: 'news', sourceSentenceIdx: 2 }],
    tasks: [{ id: 'practice', mode: 'follow', title: 'Keep', reference: article.sentences[0].en, steps: article.sentences.map(s => s.en), source: { articleId: 'news', sentenceIdx: 0 }, step: 1, status: 'paused', createdAt: 1, updatedAt: 1, draft: 'My draft', attempts: [{ id: 'recording', clipId: 'kept-audio', step: 1, reference: article.sentences[1].en, text: 'My words', status: 'recorded', createdAt: 1 }] }],
    sentenceZh: { news: { 0: '我的美国', 1: '部门译文。' } }, readLog: { ...base.readLog, count: 3, seen: { news: [0, 1, 2] } },
  };
}
async function seed(identity, state) { const repo = await persistence.createPersistence(identity); await repo.saveSnapshot(state, 0); repo.close(); }
async function inspect(identity) { const repo = await persistence.createPersistence(identity); try { return { snapshot: await repo.loadSnapshot(), records: await repo.list('reader.sentence-repairs') }; } finally { repo.close(); } }

try {
  await store.initializeStore(prefix + '-base');
  base = (await store.activeRepository().loadSnapshot()).state;
  const raw = legacyState();
  await seed(prefix + '-legacy', raw);
  await store.initializeStore(prefix + '-legacy');
  await store.flushPersist();
  const repaired = store.getState(), saved = await inspect(prefix + '-legacy');
  assert.equal(repaired.articles[0].sentences.length, 2);
  assert.equal(repaired.articles[0].sentences[0].en, 'The U.S. Department approved the plan.');
  assert.equal(repaired.progress.news, 1); assert.equal(repaired.vocab[0].sourceSentenceIdx, 0);
  assert.equal(repaired.notes[0].sourceSentenceIdx, 1); assert.equal(repaired.sentenceZh.news[0], '我的美国部门译文。');
  assert.deepEqual(repaired.tasks[0].source.sentenceIndices, [0, 0, 1]);
  assert.deepEqual(repaired.tasks[0].attempts, raw.tasks[0].attempts);
  assert.deepEqual(repaired.readingCompleted, raw.readingCompleted);
  assert.equal(saved.records.length, 1); assert.deepEqual(saved.records[0].payload.backup.article, raw.articles[0]);
  assert.deepEqual(saved.snapshot.state.articles, repaired.articles);
  assert.equal(commits.length, 1); assert.equal(commits[0].state.articles[0].sentences.length, 2);
  assert.equal(commits[0].records[0].payload.backup.article.sentences.length, 3);
  console.log('PASS startup commits repaired state and exact recovery records atomically');

  await store.initializeStore(prefix + '-base'); await store.initializeStore(prefix + '-legacy');
  await store.flushPersist();
  assert.equal(commits.length, 1); assert.equal((await inspect(prefix + '-legacy')).records.length, 1);
  assert.equal(store.getState().progress.news, 1);
  console.log('PASS repeated profile hydration does not remap or duplicate repair records');

  const localProgress = store.getState().progress.news;
  const localTranslation = structuredClone(store.getState().sentenceZh.news);
  const localReadLog = structuredClone(store.getState().readLog);
  await store.replaceSyncedState({ articles: [structuredClone(article)] });
  assert.equal(store.getState().progress.news, localProgress);
  assert.deepEqual(store.getState().sentenceZh.news, localTranslation);
  assert.deepEqual(store.getState().readLog, localReadLog);
  console.log('PASS a reappearing old article cannot remap already-repaired local overlays twice');

  await store.initializeStore(prefix + '-remote');
  await store.replaceSyncedState(legacyState());
  const remote = await inspect(prefix + '-remote');
  assert.equal(remote.snapshot.state.articles[0].sentences.length, 2);
  assert.equal(remote.records.length, 1); assert.equal(remote.snapshot.state.vocab[0].id, 'saved');
  console.log('PASS incoming old content repairs references and backup in the same store transaction');

  await seed(prefix + '-failed', legacyState());
  const before = store.getState(), identity = store.profileIdentity(); hooks.failRepair = true;
  await assert.rejects(store.initializeStore(prefix + '-failed'), /atomic repair failure/);
  assert.equal(store.profileIdentity(), identity); assert.equal(store.getState(), before);
  const failed = await inspect(prefix + '-failed');
  assert.equal(failed.snapshot.state.articles[0].sentences.length, 3); assert.equal(failed.records.length, 0);
  hooks.failRepair = false;
  console.log('PASS failed startup leaves original disk snapshot and active profile intact');

  await store.initializeStore(prefix + '-patch-failed');
  const previous = store.getState(); hooks.failRepair = true;
  await assert.rejects(store.replaceSyncedState(legacyState()), /atomic repair failure/);
  assert.deepEqual(store.getState().articles, previous.articles);
  const patchFailed = await inspect(prefix + '-patch-failed');
  assert.deepEqual(patchFailed.snapshot.state.articles, previous.articles); assert.equal(patchFailed.records.length, 0);
  console.log('PASS failed incoming repair rolls back display and persists no partial data');
  console.log('6/6 sentence repair store integration scenarios passed');
} finally { hooks.failRepair = false; dom.window.close(); }
