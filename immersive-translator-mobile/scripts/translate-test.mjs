import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = { translate: 'src/services/translate.ts', parse: 'src/components/reading/sentenceParse.ts' };
const compiled = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const tests = [], test = (name, run) => tests.push([name, run]);
function runtime({ profile = 'u1', cloudResult = async () => 'done', ensureResult = async () => true } = {}) {
  let repository = { identity: profile }, cloud = { account: profile === 'guest' ? null : { id: profile }, generation: 1 };
  // A saved credential must never open a supplier route, including for guests.
  const state = { readingArticleId: 'source-article', settings: { apiKey: 'legacy-secret', baseUrl: 'https://legacy-provider.invalid', model: 'legacy-model', provider: 'openai', dir: 'e2c', style: 'faith', stream: true }, glossary: [{ a: 'source', b: 'original' }] };
  const cloudCalls = [], loginCalls = [], events = [];
  const handlers = { onFirst: () => events.push(['first']), onDelta: value => events.push(['delta', value]), onDone: value => events.push(['done', value]), onFail: value => events.push(['fail', value]) };
  function load(name) {
    const file = path.join(root, files[name]), mod = new Module(file); mod.filename = file;
    mod.require = dependency => {
      if (dependency.endsWith('/cloud')) return { cloudState: () => cloud, cloudChat: async (...args) => { cloudCalls.push(args); return cloudResult(...args); } };
      if (dependency.endsWith('/authGate')) return { ensureAccount: args => { loginCalls.push(args); return ensureResult(args); } };
      if (dependency.endsWith('/store')) return { activeRepository: () => repository, getState: () => state };
      if (dependency.endsWith('/core/glossary')) return { readGlossary: () => state.glossary };
      if (dependency.endsWith('/device') || dependency.startsWith('@tauri-apps/')) throw Error('Mobile learning services must not import direct native/provider APIs');
      return require(dependency);
    };
    mod._compile(compiled[name], file); return mod.exports;
  }
  return {
    service: load('translate'), parser: load('parse'), handlers, state, cloudCalls, loginCalls, events,
    switchProfile(identity, changeAccount = true) { repository = { identity }; if (changeAccount) cloud = { account: identity === 'guest' ? null : { id: identity }, generation: cloud.generation + 1 }; },
    changeGeneration() { cloud = { ...cloud, generation: cloud.generation + 1 }; },
  };
}
for (const kind of ['translate', 'chat']) {
  const begin = rt => kind === 'translate' ? rt.service.startTranslate('private text', rt.handlers) : rt.service.chatStream('system', [{ role: 'user', content: 'private text' }], rt.handlers);
  test(kind + ': legacy credentials never bypass account server', async () => {
    const rt = runtime(); begin(rt); await tick(); assert.equal(rt.cloudCalls.length, 1); assert.equal(rt.loginCalls.length, 1);
    assert.equal(rt.cloudCalls[0][1][0].content, 'private text'); assert(!JSON.stringify(rt.cloudCalls).includes('legacy-secret')); assert(rt.events.some(e => e[0] === 'done'));
  });
  test(kind + ': immediate stop prevents request', async () => {
    const rt = runtime(), handle = begin(rt); handle.stop(); await tick(); assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
  });
  test(kind + ': guest with legacy key cannot submit before login', async () => {
    const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }); begin(rt); await tick(); assert.equal(rt.cloudCalls.length, 0);
    login.resolve(false); await tick(); assert.equal(rt.cloudCalls.length, 0); assert(rt.events.some(e => e[0] === 'fail' && e[1].includes('已取消登录')));
  });
  test(kind + ': completed guest login resumes original request once', async () => {
    const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }); begin(rt); assert.equal(rt.cloudCalls.length, 0);
    rt.switchProfile('u1'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls.length, 1); assert.equal(rt.cloudCalls[0][1][0].content, 'private text'); assert(rt.events.some(e => e[0] === 'done'));
  });
  test(kind + ': stop during login prevents chargeable request', async () => {
    const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }), handle = begin(rt); handle.stop(); rt.switchProfile('u1'); login.resolve(true); await tick();
    assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
  });
  test(kind + ': unrelated account switch during login never sends old text', async () => {
    const login = deferred(), rt = runtime({ ensureResult: () => login.promise }); begin(rt); rt.switchProfile('u2'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
  });
  test(kind + ': cloud account/profile mismatch blocks submission', async () => {
    const rt = runtime(); rt.switchProfile('other-profile', false); begin(rt); await tick(); assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
  });
  test(kind + ': stop aborts active signal and suppresses late answer', async () => {
    const request = deferred(), rt = runtime({ cloudResult: () => request.promise }), handle = begin(rt); await tick(); handle.stop(); handle.stop(); assert(rt.cloudCalls[0][2].aborted); request.resolve('partial'); await tick(); assert.deepEqual(rt.events, []);
  });
  test(kind + ': account switch suppresses late response', async () => {
    const request = deferred(), rt = runtime({ cloudResult: () => request.promise }); begin(rt); await tick(); rt.switchProfile('u2'); request.resolve('private old answer'); await tick(); assert.deepEqual(rt.events, []);
  });
  test(kind + ': switching away and back still invalidates output', async () => {
    const request = deferred(), rt = runtime({ cloudResult: () => request.promise }); begin(rt); await tick(); rt.switchProfile('u2', false); rt.switchProfile('u1', false); request.resolve('stale'); await tick(); assert.deepEqual(rt.events, []);
  });
  test(kind + ': session generation change invalidates output', async () => {
    const request = deferred(), rt = runtime({ cloudResult: () => request.promise }); begin(rt); await tick(); rt.changeGeneration(); request.resolve('stale'); await tick(); assert.deepEqual(rt.events, []);
  });
  test(kind + ': callback profile switch suppresses subsequent callbacks', async () => {
    const rt = runtime(); if (kind === 'translate') rt.handlers.onFirst = () => { rt.events.push(['first']); rt.switchProfile('u2'); }; else rt.handlers.onDelta = value => { rt.events.push(['delta', value]); rt.switchProfile('u2'); };
    begin(rt); await tick(); assert.equal(rt.events.length, 1); assert(!rt.events.some(e => e[0] === 'done'));
  });
  test(kind + ': concurrent requests cancel independently', async () => {
    const requests = [], rt = runtime({ cloudResult: () => { const wait = deferred(); requests.push(wait); return wait.promise; } }); const first = begin(rt), second = begin(rt); await tick();
    first.stop(); assert(rt.cloudCalls[0][2].aborted); assert(!rt.cloudCalls[1][2].aborted); requests[0].resolve('cancelled'); requests[1].resolve('second'); await tick(); assert.deepEqual(rt.events.filter(e => e[0] === 'done'), [['done', 'second']]); second.stop();
  });
}
test('translation preserves direction, style, glossary captured before login', async () => {
  const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }); rt.state.settings.dir = 'c2e'; rt.service.startTranslate('原文', rt.handlers);
  rt.state.settings.dir = 'auto'; rt.state.settings.style = 'eleg'; rt.state.glossary[0].b = 'edited'; rt.switchProfile('u1'); login.resolve(true); await tick();
  const system = rt.cloudCalls[0][0]; assert(system.includes('中文翻译成英文')); assert(system.includes('严格忠实原文')); assert(system.includes('source→original')); assert(!system.includes('source→edited')); assert.equal(rt.loginCalls[0].articleId, 'source-article');
});
test('chat snapshots messages and filters duplicate system entry', async () => {
  const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }), messages = [{ role: 'system', content: 'duplicate' }, { role: 'user', content: 'original' }];
  rt.service.chatStream('system', messages, rt.handlers); messages[1].content = 'edited'; rt.switchProfile('u1'); login.resolve(true); await tick(); assert.deepEqual(rt.cloudCalls[0][1], [{ role: 'user', content: 'original' }]);
});
test('llmConfigured requires matched account profile and ignores saved key', () => {
  const rt = runtime({ profile: 'guest' }); assert.equal(rt.service.llmConfigured(), false); rt.switchProfile('u1'); assert.equal(rt.service.llmConfigured(), true); rt.switchProfile('u2', false); assert.equal(rt.service.llmConfigured(), false);
});
const dictJson = '{"defs":[{"pos":"n","cn":"释义"}],"ex":"An example."}';
const parseJson = '{"zh":"我们学习英语。","trunk":"We learn English.","parts":[{"label":"主语","text":"We"},{"label":"谓语","text":"learn"}]}';
for (const kind of ['dictionary', 'sentence parse']) {
  const call = (rt, signal) => kind === 'dictionary' ? rt.service.lookupWord('word', signal) : rt.parser.parseSentence('We learn English.', signal), response = kind === 'dictionary' ? dictJson : parseJson;
  test(kind + ': saved credentials still use account server', async () => { const rt = runtime({ cloudResult: async () => response }); assert(await call(rt)); assert.equal(rt.cloudCalls.length, 1); assert.equal(rt.loginCalls.length, 1); assert(!JSON.stringify(rt.cloudCalls).includes('legacy-secret')); });
  test(kind + ': guest login resumes and accepts valid response', async () => { const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise, cloudResult: async () => response }), flight = call(rt); assert.equal(rt.cloudCalls.length, 0); rt.switchProfile('u1'); login.resolve(true); assert(await flight); assert.equal(rt.cloudCalls.length, 1); });
  test(kind + ': guest cancellation never submits text', async () => { const rt = runtime({ profile: 'guest', ensureResult: async () => false }); await assert.rejects(call(rt), /已取消登录/); assert.equal(rt.cloudCalls.length, 0); });
  test(kind + ': pre-aborted signal never requests login or server', async () => { const rt = runtime(), controller = new AbortController(); controller.abort(); await assert.rejects(call(rt, controller.signal), e => e.name === 'AbortError'); assert.equal(rt.cloudCalls.length, 0); assert.equal(rt.loginCalls.length, 0); });
  test(kind + ': cancel during login never submits text', async () => { const login = deferred(), rt = runtime({ profile: 'guest', ensureResult: () => login.promise }), controller = new AbortController(), flight = call(rt, controller.signal); controller.abort(); rt.switchProfile('u1'); login.resolve(true); await assert.rejects(flight, e => e.name === 'AbortError'); assert.equal(rt.cloudCalls.length, 0); });
  test(kind + ': old-account response discarded after profile switch', async () => { const request = deferred(), rt = runtime({ cloudResult: () => request.promise }), flight = call(rt); await tick(); rt.switchProfile('u2'); request.resolve(response); await assert.rejects(flight, e => e.name === 'AbortError'); });
  test(kind + ': malformed response never becomes learning data', async () => { const rt = runtime({ cloudResult: async () => 'not json' }); await assert.rejects(call(rt), /格式异常/); });
  test(kind + ': incomplete response is rejected', async () => { const rt = runtime({ cloudResult: async () => '{}' }); await assert.rejects(call(rt), /不完整/); });
}
let passed = 0;
for (const [name, run] of tests) { try { await run(); console.log('PASS ' + name); passed++; } catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; } }
console.log(passed + '/' + tests.length + ' account-server learning lifecycle tests passed');
