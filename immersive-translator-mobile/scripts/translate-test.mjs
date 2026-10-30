import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'src/services/translate.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8').replaceAll('import.meta.env', '({DEV:false})'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const tests = [], test = (name, run) => tests.push([name, run]);

function runtime({ native = true, profile = 'u1', listenGate, invokeResult = async () => 'done', cloudResult = async () => 'done', ensureResult = async () => true } = {}) {
  let repository = { identity: profile };
  let cloud = { account: profile === 'guest' ? null : { id: profile }, generation: 1 };
  const state = { readingArticleId: null, settings: { apiKey: native ? 'key-u1' : '', baseUrl: '', model: '', provider: 'openai', dir: 'en-zh', style: 'faithful', stream: true }, glossary: [{ a: 'source', b: 'original' }] };
  const listeners = [], calls = [], cloudCalls = [], events = [];
  const handlers = { onFirst: () => events.push(['first']), onDelta: value => events.push(['delta', value]), onDone: value => events.push(['done', value]), onFail: value => events.push(['fail', value]) };
  const invoke = async (cmd, args) => { calls.push({ cmd, args }); return invokeResult(cmd, args); };
  const mod = new Module(sourceFile); mod.filename = sourceFile;
  mod.require = name => {
    if (name === './cloud') return { cloudState: () => cloud, cloudChat: async (...args) => { cloudCalls.push(args); return cloudResult(...args); } };
    if (name === './authGate') return { ensureAccount: args => ensureResult(args) };
    if (name === '../store') return { activeRepository: () => repository, getState: () => state };
    if (name === '../core/glossary') return { readGlossary: () => state.glossary };
    if (name === './device') return { isTauri: () => native, invokeRaw: invoke, invoke };
    if (name === '@tauri-apps/api/event') return { listen: async (name, handler) => {
      const listener = { name, handler, closed: false }; listeners.push(listener);
      if (listenGate) await listenGate.promise;
      return () => { listener.closed = true; };
    } };
    return require(name);
  };
  mod._compile(compiled, sourceFile);
  return {
    service: mod.exports, handlers, state, listeners, calls, cloudCalls, events,
    switchProfile(identity, changeAccount = true) { repository = { identity }; if (changeAccount) cloud = { account: identity === 'guest' ? null : { id: identity }, generation: cloud.generation + 1 }; },
    emit(name, reqId, text) { listeners.filter(item => item.name === name && !item.closed).forEach(item => item.handler({ payload: { reqId, text } })); },
  };
}

for (const kind of ['translate', 'chat']) {
  const begin = rt => kind === 'translate' ? rt.service.startTranslate('private text', rt.handlers) : rt.service.chatStream('system', [{ role: 'user', content: 'private text' }], rt.handlers);
  const command = kind === 'translate' ? 'translate_text' : 'llm_chat';
  const channel = kind === 'translate' ? 'translate-delta' : 'chat-delta';
  const abort = kind === 'translate' ? 'translate_abort' : 'llm_abort';
  test(kind + ': immediate stop prevents listener and native request', async () => {
    const rt = runtime(), handle = begin(rt); handle.stop(); await tick();
    assert.equal(rt.calls.length, 0); assert.equal(rt.listeners.length, 0); assert.deepEqual(rt.events, []);
  });
  test(kind + ': stopping while listen awaits closes late listener without invoking', async () => {
    const gate = deferred(), rt = runtime({ listenGate: gate }), handle = begin(rt); await tick();
    assert.equal(rt.listeners.length, 1); handle.stop(); gate.resolve(); await tick();
    assert.equal(rt.calls.length, 0); assert.equal(rt.listeners[0].closed, true); assert.deepEqual(rt.events, []);
  });
  test(kind + ': profile switch while listen awaits never sends old text with new key', async () => {
    const gate = deferred(), rt = runtime({ listenGate: gate }); begin(rt); await tick();
    rt.switchProfile('u2'); rt.state.settings.apiKey = 'key-u2'; gate.resolve(); await tick();
    assert.equal(rt.calls.length, 0); assert.equal(rt.listeners[0].closed, true); assert.deepEqual(rt.events, []);
  });
  test(kind + ': request keeps original config and suppresses late output after switch', async () => {
    const request = deferred(), rt = runtime({ invokeResult: () => request.promise }); const handle = begin(rt); await tick();
    const call = rt.calls.find(item => item.cmd === command); assert(call);
    rt.state.settings.apiKey = 'edited'; rt.state.glossary[0].b = 'edited';
    assert.equal(call.args.cfg.apiKey, 'key-u1'); assert.equal(call.args.cfg.glossary[0].b, 'original');
    rt.emit(channel, call.args.reqId, 'current'); assert(rt.events.some(event => event[0] === 'delta'));
    rt.events.length = 0; rt.switchProfile('u2'); rt.emit(channel, call.args.reqId, 'stale'); handle.stop();
    request.resolve('stale done'); await tick();
    assert.deepEqual(rt.events, []); assert.equal(rt.listeners[0].closed, true);
    assert.equal(rt.calls.find(item => item.cmd === abort)?.args.reqId, call.args.reqId);
  });
  test(kind + ': stop cancels active native request once and suppresses partial completion', async () => {
    const request = deferred(), rt = runtime({ invokeResult: cmd => cmd === command ? request.promise : null }); const handle = begin(rt); await tick();
    handle.stop(); handle.stop(); request.resolve('partial'); await tick();
    assert.equal(rt.calls.filter(item => item.cmd === abort).length, 1); assert.deepEqual(rt.events, []); assert(rt.listeners[0].closed);
    assert.equal(rt.calls.find(item => item.cmd === abort).args.reqId, rt.calls.find(item => item.cmd === command).args.reqId);
  });
  test(kind + ': completed handle cannot abort a later native request', async () => {
    const rt = runtime(), handle = begin(rt); await tick(); handle.stop(); await tick();
    assert(rt.events.some(event => event[0] === 'done')); assert.equal(rt.calls.filter(item => item.cmd === abort).length, 0);
  });
  test(kind + ': concurrent streams cancel using their own request IDs', async () => {
    const pending = new Map(), rt = runtime({ invokeResult: (cmd, args) => {
      if (cmd === command) { const wait = deferred(); pending.set(args.reqId, wait); return wait.promise; }
      if (cmd === abort) pending.get(args.reqId)?.resolve('cancelled partial');
      return null;
    } });
    const other = [], first = begin(rt);
    const secondHandlers = { onFirst() {}, onDelta: value => other.push(['delta', value]), onDone: value => other.push(['done', value]), onFail: value => other.push(['fail', value]) };
    const second = kind === 'translate' ? rt.service.startTranslate('second', secondHandlers) : rt.service.chatStream('system', [{ role: 'user', content: 'second' }], secondHandlers);
    await tick(); const calls = rt.calls.filter(item => item.cmd === command); assert.equal(calls.length, 2);
    first.stop(); await tick(); assert.deepEqual(rt.events, []); assert.equal(rt.calls.find(item => item.cmd === abort).args.reqId, calls[0].args.reqId);
    rt.emit(channel, calls[1].args.reqId, 'second delta'); pending.get(calls[1].args.reqId).resolve('second done'); await tick();
    assert(other.some(event => event[0] === 'done' && event[1] === 'second done')); second.stop();
    assert.equal(rt.calls.filter(item => item.cmd === abort).length, 1);
  });
}

test('official translate permits guest login then ignores later account switch', async () => {
  const login = deferred(), request = deferred(), rt = runtime({ native: false, profile: 'guest', ensureResult: () => login.promise, cloudResult: () => request.promise });
  rt.service.startTranslate('guest text', rt.handlers); assert.equal(rt.cloudCalls.length, 0);
  rt.switchProfile('u1'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls.length, 1);
  rt.switchProfile('u2'); request.resolve('old account translation'); await tick(); assert.deepEqual(rt.events, []);
});
test('official translate stop during login prevents chargeable request', async () => {
  const login = deferred(), rt = runtime({ native: false, profile: 'guest', ensureResult: () => login.promise });
  const handle = rt.service.startTranslate('guest text', rt.handlers); handle.stop(); rt.switchProfile('u1'); login.resolve(true); await tick();
  assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
});
test('official chat permits login, snapshots messages, and checks each completion callback', async () => {
  const login = deferred(), request = deferred(), rt = runtime({ native: false, profile: 'guest', ensureResult: () => login.promise, cloudResult: () => request.promise });
  const messages = [{ role: 'user', content: 'original' }];
  rt.handlers.onDelta = value => { rt.events.push(['delta', value]); rt.switchProfile('u2'); };
  rt.service.chatStream('system', messages, rt.handlers); messages[0].content = 'new profile text';
  rt.switchProfile('u1'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls[0][1][0].content, 'original');
  request.resolve('answer'); await tick(); assert.deepEqual(rt.events, [['delta', 'answer']]);
});
test('official chat rejects unrelated account switch while login promise resolves', async () => {
  const login = deferred(), rt = runtime({ native: false, ensureResult: () => login.promise });
  rt.service.chatStream('system', [{ role: 'user', content: 'u1 private' }], rt.handlers);
  rt.switchProfile('u2'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls.length, 0); assert.deepEqual(rt.events, []);
});
test('lookupWord rejects native dictionary result from an old repository', async () => {
  const request = deferred(), rt = runtime({ invokeResult: () => request.promise }); const flight = rt.service.lookupWord('private');
  rt.switchProfile('u2'); request.resolve({ defs: [{ pos: 'n', cn: '旧释义' }] }); await assert.rejects(flight, error => error.name === 'AbortError');
});
test('lookupWord permits guest login then rejects a late cloud dictionary result', async () => {
  const login = deferred(), request = deferred(), rt = runtime({ native: false, profile: 'guest', ensureResult: () => login.promise, cloudResult: () => request.promise });
  const flight = rt.service.lookupWord('private'); rt.switchProfile('u1'); login.resolve(true); await tick(); assert.equal(rt.cloudCalls.length, 1);
  rt.switchProfile('u2'); request.resolve('{"defs":[{"pos":"n","cn":"旧释义"}]}'); await assert.rejects(flight, error => error.name === 'AbortError');
});
test('lookupWord returns valid cloud dictionary for the same account', async () => {
  const rt = runtime({ native: false, cloudResult: async () => '{"defs":[{"pos":"n","cn":"释义"}],"ex":"An example."}' });
  assert.deepEqual(await rt.service.lookupWord('word'), { defs: [{ pos: 'n', cn: '释义' }], ex: 'An example.' });
});
test('lookupWord native cancellation uses its own request ID and never returns cancelled fallback', async () => {
  const request = deferred(), rt = runtime({ invokeResult: cmd => cmd === 'dict_lookup' ? request.promise : null }), controller = new AbortController();
  const flight = rt.service.lookupWord('word', controller.signal); controller.abort(); request.resolve(null);
  await assert.rejects(flight, error => error.name === 'AbortError');
  const lookup = rt.calls.find(item => item.cmd === 'dict_lookup'), abort = rt.calls.find(item => item.cmd === 'dict_abort');
  assert(lookup.args.reqId); assert.equal(abort.args.reqId, lookup.args.reqId);
});
test('lookupWord pre-aborted signal never invokes a dictionary service', async () => {
  const rt = runtime(), controller = new AbortController(); controller.abort();
  await assert.rejects(rt.service.lookupWord('word', controller.signal), error => error.name === 'AbortError'); assert.equal(rt.calls.length, 0);
});
test('lookupWord official cancellation during login never sends text to cloud', async () => {
  const login = deferred(), rt = runtime({ native: false, profile: 'guest', ensureResult: () => login.promise }), controller = new AbortController();
  const flight = rt.service.lookupWord('word', controller.signal); controller.abort(); rt.switchProfile('u1'); login.resolve(true);
  await assert.rejects(flight, error => error.name === 'AbortError'); assert.equal(rt.cloudCalls.length, 0);
});
test('switching away and back to the same account still invalidates native output', async () => {
  const request = deferred(), rt = runtime({ invokeResult: () => request.promise }); rt.service.startTranslate('private', rt.handlers); await tick();
  rt.switchProfile('u2', false); rt.switchProfile('u1', false); request.resolve('stale'); await tick(); assert.deepEqual(rt.events, []);
});

let passed = 0;
for (const [name, run] of tests) {
  try { await run(); console.log('PASS ' + name); passed++; }
  catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' translate lifecycle tests passed');
