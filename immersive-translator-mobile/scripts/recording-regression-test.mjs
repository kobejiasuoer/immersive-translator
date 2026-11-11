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
let asrCalls = 0, asrFailure = false, feedbackCalls = 0, feedbackFailure = false, blankTranscript = false, asrGate = null, lastAsrSignal = null, feedbackGate = null, lastFeedbackSignal = null;
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/v1/auth/login')) return response(200, { user: { id: 'recording-fixture', email: 'fixture@test.invalid', nickname: null, plan: 'free' }, accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresIn: 900 });
  if (url.endsWith('/v1/me/config')) return response(200, {models:['fixture-model'],gateway:{llm:'/v1/gateway/llm'}});
  if (url.endsWith('/v1/gateway/llm')) { feedbackCalls++; lastFeedbackSignal=options.signal; if(feedbackGate)await feedbackGate.promise; const answer=JSON.parse(JSON.parse(options.body).messages.at(-1).content).answer; return feedbackFailure ? response(503,{error:{message:'TEMPORARY_FAILURE'}}) : response(200,{choices:[{message:{content:JSON.stringify({message:'回答已记录',improved:answer,explanation:'表达清楚',usedTarget:true})},finish_reason:'stop'}]}); }
  if (url.endsWith('/v1/voice/asr')) {
    asrCalls++; lastAsrSignal=options.signal; if(asrGate) await asrGate.promise;
    assert.ok(JSON.parse(options.body).audio.length > 0);
    return asrFailure ? response(503, { error: { message: 'VOICE_SERVICE_UNAVAILABLE' } }) : response(200, { text: blankTranscript ? '' : 'I would like the pasta, please.', durationMs: 1000 });
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
    stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LearningPractice} from './screens/LearningPractice';import {SpokenReviewCard} from './components/vault/SpokenReviewCard';import {NavCtx} from './ui/nav';export * from './store';export * from './services/practice';export {practiceStepTitle} from './components/speaking/scenes';export const routes=[];export let popCount=0;export let popAllCount=0;export {login} from './services/cloud';let root;export let reviewState;function Review({initial}){const [state,setState]=useState(initial);reviewState=state;return <SpokenReviewCard card={{id:'test-word',mode:'spoken',word:'take a break',kind:'chunk',answer:'take a break',hint:'休息一下',sentIdx:0}} state={state} patch={patch=>setState(s=>({...s,...patch}))} articles={[]} onGrade={()=>{}} grading={false}/>;}export function render(kind,props){root??=createRoot(document.getElementById('root'));root.render(<NavCtx.Provider value={{push(view,props){routes.push({view,props});},pop(){popCount++;},replace(view,props){routes.push({view,props});},popAll(){popAllCount++;}}}><div className="app">{kind==='practice'?<LearningPractice {...props}/>:<Review {...props}/>}</div></NavCtx.Provider>);}export function unmount(){root?.unmount();root=null;reviewState=null;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'recording-regression.tsx', loader: 'tsx' },
    outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://recording-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') },
    plugins: [{ name: 'microphone-hardware-fixture', setup(builder) {
      builder.onLoad({ filter: /services\/audio\.ts$/ }, () => ({ loader: 'js', contents: `export async function startPcmCapture(options){window.captureStarts=(window.captureStarts||0)+1;window.captureOptions=options;if(window.captureDenied)return null;const samples=new Uint8Array(32000).fill(1);const pcm=btoa(String.fromCharCode(...samples));let stopped=false;return {async stop(){const content=window.captureResult?.pcmB64??pcm;if(!stopped){stopped=true;for(const chunk of window.captureChunks??(content?[content]:[]))options.onChunk?.(chunk);}return {pcmB64:content,peak:window.captureResult?.peak??.5,ms:window.captureResult?.ms??1000};},cancel(){stopped=true;}};}` }));
    } }],
  });
  api = await import(pathToFileURL(outfile).href);
  await api.initializeStore('recording-fixture');
  await api.login('fixture@test.invalid', 'fixture-password', 'password');

  const sourceArticle = { id: 'mapped-source', title: 'Mapped article', titleCn: '', sourceType: 'paste', paragraphStarts: [0], sentences: [{idx:0,paragraphIdx:0,en:'The U.S. Department announced funding.',zh:'映射后的第一句译文。'},{idx:1,paragraphIdx:0,en:'Next news sentence.',zh:'另一句译文。'}] };
  api.actions.addArticle(sourceArticle);
  const mapped = api.createPracticeTask({ mode: 'follow', title: 'Mapped follow practice', reference: 'The U.S.', steps: ['The U.S.', 'Department announced funding.', 'Next news sentence.'], source: {articleId:'mapped-source',sentenceIdx:0,sentenceIndices:[0,0,1],boundaryKey:'fixture-boundary'} });
  mapped.step=1; mapped.attempts=[{id:'preserved-attempt',step:0,text:'My recorded old answer.',deviceId:api.deviceId(),status:'draft',createdAt:1,reference:'The U.S.'}];
  const practiceContent = task => ({reference:task.reference,steps:task.steps,attempts:task.attempts.map(({updatedAt,fieldUpdatedAt,fieldShadow,...content})=>content)});
  const frozenPractice=structuredClone(practiceContent(mapped));
  assert.deepEqual([0,1,2].map(step=>api.taskSentenceIndex(mapped,step)),[0,0,1]);
  assert.equal(api.taskSentenceIndex({source:{articleId:'legacy',sentenceIdx:4},step:2}),6);
  assert.equal(api.taskSentenceIndex({source:{articleId:'partial',sentenceIdx:4,sentenceIndices:[3]},step:2}),6);
  await api.actions.upsertTask(mapped); api.render('practice',{taskId:mapped.id}); await until(()=>document.querySelector('.v2-sp-prompt'),'mapped practice');
  assert.equal(document.querySelector('.v2-sp-prompt .v2-sp-overline').textContent,'原文第 1 句','A migrated step must use its mapped source sentence, not the original start plus step');
  assert.equal(document.querySelector('.v2-sp-question').textContent,'Department announced funding.');
  assert.equal(document.querySelector('.v2-sp-cn').textContent,'映射后的第一句译文。');
  assert.equal(api.practiceStepTitle(mapped),'原文第 1 句');
  await api.actions.upsertTask({...mapped,status:'completed'}); await until(()=>button('回到原文第 1 句'),'mapped recap');
  assert.deepEqual([...document.querySelectorAll('.v2-sp-results .tx b')].map(el=>el.textContent),['原文第 1 句','原文第 1 句','原文第 2 句']);
  click(button('回到原文第 1 句')); assert.equal(api.getState().readerTarget.sent,0); assert.deepEqual(api.routes.at(-1),{view:'reader',props:{articleId:'mapped-source'}});
  const preserved=api.getState().tasks.find(t=>t.id===mapped.id); assert.deepEqual(practiceContent(preserved),frozenPractice);
  pass('migrated practice steps keep their frozen prompts and attempts while source labels, Chinese context and reader return use each mapped sentence');
  await api.actions.upsertTask({...preserved,step:2}); await until(()=>button('回到原文第 2 句'),'last mapped step recap');
  click(button('看这一步的发音要点')); await until(()=>button('跟读这个表达'),'mapped pronunciation'); click(button('跟读这个表达'));
  await until(()=>api.routes.at(-1)?.view==='learningPractice','single-expression practice');
  const expressionTask=api.getState().tasks.find(t=>t.id===api.routes.at(-1).props.taskId);
  assert.equal(expressionTask.reference,'Next news sentence.'); assert.equal(expressionTask.step,0);
  assert.deepEqual(expressionTask.source,{articleId:'mapped-source',sentenceIdx:1,sentenceIndices:[1],boundaryKey:'fixture-boundary'});
  assert.deepEqual(practiceContent(api.getState().tasks.find(t=>t.id===mapped.id)),frozenPractice);
  pass('a new single-expression practice starts at the current mapped sentence without rewriting the original recording prompts or attempts');
  api.unmount(); await wait(20);

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
  click(button('开始回答录音')); assert.equal(button('允许，并开始录音'),undefined);
  await until(() => document.querySelector('[role=alert]'), 'storage preparation error');
  const failed = api.getState().tasks.find(t => t.id === task.id);
  assert.equal(failed.attempts.at(-1).clipId, undefined);
  assert.equal(failed.draft, 'Keep this existing answer.'); assert.equal(w.captureStarts || 0, 0);
  assert.equal(button('重新识别已保存的原声'), undefined); assert.equal(bodyText().includes('/private/'), false);
  pass('failed recording preparation retains text and never manufactures a saved original');
  repo.audioBegin = begin;
  click(button('重新录一句')); await until(() => button('结束录音'), 'retry capture'); click(button('结束录音'));
  await until(() => api.getState().tasks.find(t => t.id === task.id).attempts.at(-1).status === 'feedback', 'automatic scenario submission');
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

  w.captureDenied=true;
  api.render('review', { initial: { stage: 'ask', text: 'Keep my typed review.' } }); await until(() => button('录音试说'), 'review permission denial');
  const reviewDeniedStarts=w.captureStarts,reviewDeniedAsr=asrCalls,reviewDeniedFeedback=feedbackCalls;
  click(button('录音试说')); assert.equal(button('允许并开始'),undefined);
  await until(()=>document.querySelector('[role=alert]'),'review denial text guidance');
  assert.equal(w.captureStarts,reviewDeniedStarts+1);assert.equal(asrCalls,reviewDeniedAsr);assert.equal(feedbackCalls,reviewDeniedFeedback);
  assert.equal(api.reviewState.clipId,undefined);assert.equal(api.reviewState.text,'Keep my typed review.');assert.equal(api.reviewState.stage,'ask');
  await until(()=>button('用文字回答')&&!button('用文字回答').disabled,'review text recovery');click(button('用文字回答'));
  assert.equal(document.activeElement,document.querySelector('#v2-review-speaking-draft'));assert.equal(document.activeElement.disabled,false);assert.equal(document.querySelectorAll('.grade').length,0);
  pass('spoken-review permission denial makes one capture request, preserves the draft and offers focused text recovery without an app permission sheet');
  api.unmount();await wait(20);w.captureDenied=false;

  api.render('review', { initial: { stage: 'ask', text: 'Keep my review draft.' } }); await until(() => button('录音试说'), 'spoken review');
  click(button('录音试说')); assert.equal(button('允许并开始'),undefined); await until(() => button('结束录音'), 'review recording'); click(button('结束录音'));
  await until(() => api.reviewState?.text === 'I would like the pasta, please.', 'review transcription');
  assert.equal(asrCalls, 2); assert.equal(api.reviewState.stage, 'confirm');
  const originalClip = api.reviewState.clipId;
  assert.equal((await repo.audioManifest(originalClip)).status, 'ready');
  pass('spoken review transcribes immediately after saving rather than being blocked by its own busy guard');
  assert.equal(document.querySelectorAll('.grade').length,0);
  await until(()=>button('确认回答，核对用法')&&!button('确认回答，核对用法').disabled,'review manual confirmation');click(button('确认回答，核对用法'));
  await until(()=>document.querySelectorAll('.grade').length===3,'review manual grades');assert.equal(api.reviewState.stage,'check');
  assert.deepEqual([...document.querySelectorAll('.grade .g1')].map(el=>el.textContent),['没记住','有点模糊','记住了']);
  pass('spoken review still requires explicit answer confirmation before displaying its unchanged three manual grades');

  await until(() => button('重新录一次'), 'saved review recording');
  const finalize = repo.audioFinalize.bind(repo);
  repo.audioFinalize = async () => { throw new Error(rawProtectionError); };
  click(button('重新录一次')); await until(() => button('结束录音'), 'replacement review recording'); click(button('结束录音'));
  await until(() => document.querySelector('[role=alert]'), 'review save failure');
  assert.equal(api.reviewState.clipId, originalClip); assert.equal(api.reviewState.text, 'I would like the pasta, please.');
  assert.equal((await repo.audioManifest(originalClip)).status, 'ready'); assert.equal(asrCalls, 2);
  assert.equal(bodyText().includes('/private/'), false);
  repo.audioFinalize = finalize;
  pass('a failed replacement recording preserves the previous playable original and confirmed text');
  api.unmount(); await wait(20);

  asrFailure = true;
  api.render('review', { initial: { stage: 'ask', text: '' } }); await until(() => button('录音试说'), 'review ASR failure');
  click(button('录音试说')); await until(() => button('结束录音'), 'failure recording'); click(button('结束录音'));
  await until(() => document.querySelector('[role=alert]') && api.reviewState.stage === 'confirm', 'ASR failure recovery');
  assert.ok(api.reviewState.clipId); assert.equal((await repo.audioManifest(api.reviewState.clipId)).status, 'ready');
  await until(() => button('重新识别原声'), 'explicit recognition retry'); assert.equal(asrCalls, 3);
  asrFailure = false; click(button('重新识别原声'));
  await until(() => api.reviewState.text === 'I would like the pasta, please.', 'explicit ASR retry'); assert.equal(asrCalls, 4);
  pass('ASR failure retains the saved original and retries only after an explicit tap');
  const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
  const scenarioState = id => api.getState().tasks.find(t=>t.id===id);
  async function newScenario(label) {
    api.unmount(); await wait(20); api.hideToast();
    w.captureDenied=false; w.captureResult=undefined; w.captureChunks=undefined; blankTranscript=false; asrFailure=false; feedbackFailure=false; asrGate=null; feedbackGate=null;
    const next=api.createPracticeTask({mode:'scenario',title:label,reference:'What would you like to order?'});
    await api.actions.upsertTask(next);api.render('practice',{taskId:next.id});await until(()=>button('开始回答录音'),label);return next;
  }
  async function beginScenario(next) { click(button('开始回答录音'));assert.equal(button('允许，并开始录音'),undefined);await until(()=>button('结束录音'),'one tap starts recording');assert.equal(button('发音要点').disabled,true);return scenarioState(next.id).attempts.at(-1); }

  const direct=await newScenario('Automatic scenario'); const directFeedback=feedbackCalls, directAsr=asrCalls;
  await beginScenario(direct);const endButton=button('结束录音');click(endButton);click(endButton);
  await until(()=>scenarioState(direct.id).attempts.at(-1).status==='feedback','automatic answer');
  assert.equal(asrCalls,directAsr+1);assert.equal(feedbackCalls,directFeedback+1);assert.equal(scenarioState(direct.id).attempts.length,1);assert.equal(button('发送回答'),undefined);
  await until(()=>button('修改这句文字'),'editable recognized answer');click(button('修改这句文字'));await until(()=>document.querySelector('textarea'),'edit recognized answer');
  const originalAttempt=structuredClone(scenarioState(direct.id).attempts[0]);const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(textarea,'I would like soup instead.');textarea.dispatchEvent(new w.Event('input',{bubbles:true}));await wait(20);click(button('发送回答'));
  await until(()=>scenarioState(direct.id).attempts.at(-1).feedback?.improved==='I would like soup instead.','corrected answer');
  assert.equal(scenarioState(direct.id).attempts[0].clipId,originalAttempt.clipId);assert.equal(scenarioState(direct.id).attempts[0].text,originalAttempt.text);assert.equal((await repo.audioManifest(originalAttempt.clipId)).status,'ready');
  pass('one microphone tap and one manual stop automatically transcribe and send once; correcting text retains the earlier answer and recording');

  const twoQuestions=await newScenario('Two question conversation');
  await api.actions.upsertTask({...twoQuestions,steps:['What would you like to order?','What would you like to drink?']});
  const twoStarts=w.captureStarts;await beginScenario(twoQuestions);click(button('结束录音'));
  await until(()=>scenarioState(twoQuestions.id).attempts.at(-1).status==='feedback'&&button('回答下一问'),'first question feedback');
  await wait(20);assert.equal(w.captureStarts,twoStarts+1,'Feedback must not start listening before the learner chooses the next question');
  click(button('回答下一问'));await until(()=>scenarioState(twoQuestions.id).step===1&&button('结束录音'),'one tap answers next question');
  assert.equal(w.captureStarts,twoStarts+2);assert.equal(button('允许，并开始录音'),undefined);click(button('结束录音'));
  await until(()=>scenarioState(twoQuestions.id).attempts.at(-1).status==='feedback'&&button('查看本轮回顾'),'second question feedback');
  click(button('查看本轮回顾'));await until(()=>scenarioState(twoQuestions.id).status==='completed','one tap opens final recap');
  assert.equal(w.captureStarts,twoStarts+2);assert.deepEqual(scenarioState(twoQuestions.id).attempts.map(a=>a.step),[0,1]);
  pass('two-question conversations wait after feedback, start the next recording with one explicit tap, and finish directly into the recap');

  const endpoint=await newScenario('Pause to finish');const endpointAsr=asrCalls,endpointFeedback=feedbackCalls;await beginScenario(endpoint);
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  try { for(let i=0;i<30;i++){clock+=128;w.captureOptions.onLevel(.0004);}assert.equal(asrCalls,endpointAsr);for(let i=0;i<8;i++){clock+=128;w.captureOptions.onLevel(.06);}for(let i=0;i<19;i++){clock+=128;w.captureOptions.onLevel(.0004);} } finally {Date.now=realNow;}
  await until(()=>scenarioState(endpoint.id).attempts.at(-1).status==='feedback','speech then silence ends once');assert.equal(asrCalls,endpointAsr+1);assert.equal(feedbackCalls,endpointFeedback+1);
  pass('initial quiet does not send, while sustained speech and a quiet pause end the scenario recording and send one answer');

  for(const invalid of [{peak:0,ms:1000},{peak:.5,ms:120}]){
    const empty=await newScenario('No usable speech'),beforeAsr=asrCalls,beforeFeedback=feedbackCalls;w.captureResult=invalid;await beginScenario(empty);click(button('结束录音'));
    await until(()=>document.querySelector('[role=alert]'),'empty speech guidance');assert.equal(asrCalls,beforeAsr);assert.equal(feedbackCalls,beforeFeedback);assert.equal(scenarioState(empty.id).attempts.some(a=>a.feedback),false);
  }
  const emptyAsr=await newScenario('Empty transcript'),beforeEmptyFeedback=feedbackCalls;blankTranscript=true;await beginScenario(emptyAsr);click(button('结束录音'));await until(()=>document.querySelector('[role=alert]'),'empty transcript rejected');assert.equal(feedbackCalls,beforeEmptyFeedback);
  pass('silent audio, short taps and blank ASR output never submit a blank answer');

  const cancelled=await newScenario('Cancel recording'),cancelAsr=asrCalls,cancelFeedback=feedbackCalls;const cancelledAttempt=await beginScenario(cancelled);click(button('取消'));await until(()=>scenarioState(cancelled.id).attempts.at(-1).status==='recorded','cancel retained recording');assert.equal(asrCalls,cancelAsr);assert.equal(feedbackCalls,cancelFeedback);assert.equal((await repo.audioManifest(cancelledAttempt.clipId)).status,'ready');
  pass('cancelling a recording retains its original audio without transcribing or sending');

  const stopPending=await newScenario('Cancel pending transcription'),pendingFeedback=feedbackCalls,pendingAsr=asrCalls;asrGate=deferred();const delayedGate=asrGate;await beginScenario(stopPending);click(button('结束录音'));await until(()=>scenarioState(stopPending.id).attempts.at(-1).status==='recognizing'&&asrCalls>pendingAsr&&button('取消处理，改用文字'),'pending ASR');click(button('取消处理，改用文字'));await until(()=>scenarioState(stopPending.id).attempts.at(-1).status==='recorded','pending ASR cancelled');assert.equal(lastAsrSignal.aborted,true);asrGate=null;delayedGate.resolve();await wait(30);assert.equal(feedbackCalls,pendingFeedback);assert.equal(scenarioState(stopPending.id).attempts.at(-1).text,'');
  click(button('重新识别已保存的原声'));await until(()=>scenarioState(stopPending.id).attempts.at(-1).status==='draft','explicit transcript retry');assert.equal(feedbackCalls,pendingFeedback);await until(()=>document.querySelector('textarea')?.value,'retry transcript visible');click(button('发送回答'));await until(()=>scenarioState(stopPending.id).attempts.at(-1).status==='feedback','manual send after cancelled pipeline');
  pass('cancelling ASR ignores a late response, retains audio, and waits for explicit retry and send');

  const failAuto=await newScenario('Automatic feedback failure');feedbackFailure=true;await beginScenario(failAuto);click(button('结束录音'));await until(()=>document.querySelector('[role=alert]')&&['failed','unknown'].includes(scenarioState(failAuto.id).attempts.at(-1).status),'automatic feedback failed');const failedAutoAttempt=scenarioState(failAuto.id).attempts.at(-1);assert.ok(failedAutoAttempt.text);assert.equal((await repo.audioManifest(failedAutoAttempt.clipId)).status,'ready');feedbackFailure=false;click(button('发送回答'));await until(()=>scenarioState(failAuto.id).attempts.at(-1).status==='feedback','retry stored answer');assert.equal(scenarioState(failAuto.id).attempts.length,1);
  pass('automatic submission failure keeps the recording and transcription and retries that answer only on demand');

  const background=await newScenario('Background interruption'),backgroundFeedback=feedbackCalls,backgroundAsr=asrCalls;asrGate=deferred();const backgroundGate=asrGate;await beginScenario(background);click(button('结束录音'));await until(()=>scenarioState(background.id).attempts.at(-1).status==='recognizing'&&asrCalls>backgroundAsr,'background ASR pending');
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new w.Event('visibilitychange'));await until(()=>scenarioState(background.id).attempts.at(-1).status==='recorded','background cancellation');asrGate=null;backgroundGate.resolve();await wait(25);assert.equal(feedbackCalls,backgroundFeedback);Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  pass('backgrounding cancels automatic sending and rejects the delayed transcription');

  const stale=await newScenario('Leave pending answer'),staleFeedback=feedbackCalls;feedbackGate=deferred();const staleGate=feedbackGate;await beginScenario(stale);click(button('结束录音'));await until(()=>scenarioState(stale.id).attempts.at(-1).status==='submitting'&&feedbackCalls>staleFeedback,'leave while submitting');api.unmount();await until(()=>scenarioState(stale.id).attempts.at(-1).status==='draft','unmount recovers pending answer');assert.equal(lastFeedbackSignal.aborted,true);feedbackGate=null;staleGate.resolve();await wait(30);assert.equal(scenarioState(stale.id).attempts.at(-1).feedback,undefined);api.render('practice',{taskId:stale.id});await until(()=>button('开始回答录音'),'reopened answer is no longer busy');assert.equal(scenarioState(stale.id).attempts.at(-1).status,'draft');
  pass('leaving an in-flight answer preserves its text and original recording; reopening cannot stay stuck processing or apply late feedback');

  const preparing=await newScenario('Cancel before microphone opens'),preparingAsr=asrCalls,preparingFeedback=feedbackCalls,preparingStarts=w.captureStarts;
  const currentRepo=api.activeRepository(),realBegin=currentRepo.audioBegin.bind(currentRepo),prepareGate=deferred();let enteredBegin=false;
  currentRepo.audioBegin=async(...args)=>{enteredBegin=true;await prepareGate.promise;return realBegin(...args);};
  try {click(button('开始回答录音'));await until(()=>enteredBegin&&button('取消处理，改用文字'),'preparing microphone');click(button('取消处理，改用文字'));prepareGate.resolve();await until(()=>scenarioState(preparing.id).attempts.at(-1).status==='failed','cancelled preparation settled');assert.equal(w.captureStarts,preparingStarts);assert.equal(asrCalls,preparingAsr);assert.equal(feedbackCalls,preparingFeedback);}finally{prepareGate.resolve();currentRepo.audioBegin=realBegin;}
  pass('cancelling during storage preparation prevents a delayed microphone prompt or recording from starting');

  const manualFollow=await newScenario('Follow confirmation remains manual'),followFeedback=feedbackCalls;await api.actions.upsertTask({...manualFollow,mode:'follow'});await beginScenario(manualFollow);click(button('结束录音'));await until(()=>scenarioState(manualFollow.id).attempts.at(-1).status==='draft'&&button('发送回答'),'follow transcript awaiting review');assert.equal(feedbackCalls,followFeedback);
  pass('automatic sending is scoped to scenario conversation; follow-reading recordings still wait for an explicit send');

  const denied=await newScenario('Permission denied'),deniedAsr=asrCalls,deniedFeedback=feedbackCalls;w.captureDenied=true;click(button('开始回答录音'));await until(()=>document.querySelector('[role=alert]'),'denied permission shows recovery');assert.equal(asrCalls,deniedAsr);assert.equal(feedbackCalls,deniedFeedback);assert.equal(scenarioState(denied.id).attempts.some(a=>a.feedback||a.text),false);assert.equal(button('允许，并开始录音'),undefined);w.captureDenied=false;
  pass('microphone denial does not send audio or create a blank answered turn and offers text recovery without an extra permission sheet');

  const noExitConfirmation = () => {
    assert.equal(button('保留进度，回到来源'), undefined, 'Returning must not require an exit confirmation');
    assert.equal(document.querySelector('.sheet.on[aria-label="先离开练习？"]'), null);
  };
  const setAnswer = text => {
    const input = document.querySelector('#practice-answer'); assert.ok(input, 'Answer input is available');
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new w.Event('input', { bubbles:true }));
  };
  const assertDurableTask = async (id, verify) => {
    await api.flushPersist(); const snapshot = await api.activeRepository().loadSnapshot();
    const saved = snapshot.state.tasks.find(t => t.id === id); assert.ok(saved, 'Task survives in real IndexedDB'); verify(saved);
  };

  const backDraft = await newScenario('Return with text draft'), draftPops = api.popCount, draftAsr = asrCalls, draftFeedback = feedbackCalls;
  click(button('文字回答')); await until(() => document.querySelector('#practice-answer'), 'typed answer input');
  setAnswer('Keep this answer when I swipe back.');
  const draftBack = button('返回'); click(draftBack); click(draftBack); noExitConfirmation();
  await until(() => api.popCount === draftPops + 1, 'draft returns directly');
  assert.equal(scenarioState(backDraft.id).status, 'paused'); assert.equal(scenarioState(backDraft.id).draft, 'Keep this answer when I swipe back.');
  await assertDurableTask(backDraft.id, saved => assert.equal(saved.draft, 'Keep this answer when I swipe back.'));
  click(draftBack); await wait(30); assert.equal(api.popCount, draftPops + 1, 'Repeated returns must not pop the source page');
  assert.equal(asrCalls, draftAsr); assert.equal(feedbackCalls, draftFeedback);
  pass('returning saves the latest typed draft without a dialog and repeated taps pop only once');

  const backRecording = await newScenario('Return while recording'), recordingPops = api.popCount, recordingAsr = asrCalls, recordingFeedback = feedbackCalls;
  const backRecordingAttempt = await beginScenario(backRecording); click(button('返回')); noExitConfirmation();
  await until(() => api.popCount === recordingPops + 1, 'recording is saved before returning');
  assert.equal(scenarioState(backRecording.id).status, 'paused'); assert.equal(scenarioState(backRecording.id).attempts.at(-1).status, 'recorded');
  const backAudio = await repo.audioManifest(backRecordingAttempt.clipId); assert.equal(backAudio.status, 'ready'); assert.ok(backAudio.byteLength > 0);
  assert.equal(asrCalls, recordingAsr); assert.equal(feedbackCalls, recordingFeedback);
  await assertDurableTask(backRecording.id, saved => assert.equal(saved.attempts.at(-1).clipId, backRecordingAttempt.clipId));
  pass('returning during recording ends capture and saves playable original audio without transcribing or sending');

  const backAsr = await newScenario('Return while ASR waits'), backAsrPops = api.popCount, backAsrCount = asrCalls, backAsrFeedback = feedbackCalls;
  asrGate = deferred(); const returnAsrGate = asrGate; const returnAsrAttempt = await beginScenario(backAsr); click(button('结束录音'));
  await until(() => asrCalls > backAsrCount && scenarioState(backAsr.id).attempts.at(-1).status === 'recognizing', 'ASR waits for response');
  const returningAsrSignal = lastAsrSignal; click(button('返回')); noExitConfirmation();
  await until(() => api.popCount === backAsrPops + 1, 'return does not await ASR network response');
  assert.equal(returningAsrSignal.aborted, true); assert.equal(scenarioState(backAsr.id).status, 'paused');
  assert.equal((await repo.audioManifest(returnAsrAttempt.clipId)).status, 'ready');
  asrGate = null; returnAsrGate.resolve(); await wait(35);
  assert.equal(scenarioState(backAsr.id).attempts.at(-1).text, ''); assert.equal(scenarioState(backAsr.id).attempts.at(-1).feedback, undefined);
  assert.equal(feedbackCalls, backAsrFeedback); assert.equal(api.popCount, backAsrPops + 1);
  pass('returning aborts pending ASR immediately, retains the original and rejects a late transcript');

  const backFeedback = await newScenario('Return while feedback waits'), backFeedbackPops = api.popCount, beforeFeedback = feedbackCalls;
  feedbackGate = deferred(); const returnFeedbackGate = feedbackGate; const returnFeedbackAttempt = await beginScenario(backFeedback); click(button('结束录音'));
  await until(() => feedbackCalls > beforeFeedback && scenarioState(backFeedback.id).attempts.at(-1).status === 'submitting', 'feedback waits for response');
  const returningFeedbackSignal = lastFeedbackSignal; const returnedText = scenarioState(backFeedback.id).draft;
  click(button('返回')); noExitConfirmation(); await until(() => api.popCount === backFeedbackPops + 1, 'return does not await feedback response');
  assert.equal(returningFeedbackSignal.aborted, true); assert.equal(scenarioState(backFeedback.id).status, 'paused');
  assert.equal(scenarioState(backFeedback.id).draft, returnedText); assert.equal(scenarioState(backFeedback.id).attempts.at(-1).status, 'draft');
  assert.equal((await repo.audioManifest(returnFeedbackAttempt.clipId)).status, 'ready');
  feedbackGate = null; returnFeedbackGate.resolve(); await wait(35);
  assert.equal(scenarioState(backFeedback.id).attempts.at(-1).feedback, undefined); assert.equal(scenarioState(backFeedback.id).draft, returnedText);
  await assertDurableTask(backFeedback.id, saved => assert.equal(saved.attempts.at(-1).text, returnedText));
  pass('returning aborts pending feedback while preserving durable transcription and audio and rejects a late answer');

  const backSaving = await newScenario('Return while recording save waits'), savingPops = api.popCount, savingAsr = asrCalls, savingFeedback = feedbackCalls;
  const savingAttempt = await beginScenario(backSaving), finalizingGate = deferred(); let finalizingEntered = false;
  const finalizeBeforeReturn = repo.audioFinalize.bind(repo);
  repo.audioFinalize = async (...args) => { finalizingEntered = true; await finalizingGate.promise; return finalizeBeforeReturn(...args); };
  try {
    click(button('结束录音')); await until(() => finalizingEntered, 'recording finalization is pending');
    const saveBack = button('返回'); click(saveBack); click(saveBack); noExitConfirmation(); await wait(35);
    assert.equal(api.popCount, savingPops, 'Pending original must finish saving before navigation');
    assert.equal(asrCalls, savingAsr); assert.equal(feedbackCalls, savingFeedback);
    finalizingGate.resolve(); await until(() => api.popCount === savingPops + 1, 'return continues after finalization');
    assert.equal((await repo.audioManifest(savingAttempt.clipId)).status, 'ready'); assert.equal(scenarioState(backSaving.id).status, 'paused');
    assert.equal(asrCalls, savingAsr); assert.equal(feedbackCalls, savingFeedback);
  } finally { finalizingGate.resolve(); repo.audioFinalize = finalizeBeforeReturn; }
  pass('returning during an existing audio save waits for durable completion and does not restart automatic sending');

  const backSaveFailure = await newScenario('Return save failure'), failedSavePops = api.popCount, failedSaveAsr = asrCalls, failedSaveFeedback = feedbackCalls;
  const failedSaveAttempt = await beginScenario(backSaveFailure), successfulFinalize = repo.audioFinalize.bind(repo); let retryFinalizations = 0;
  repo.audioFinalize = async (...args) => { retryFinalizations++; if (retryFinalizations === 1) throw new Error(rawProtectionError); return successfulFinalize(...args); };
  try {
    click(button('返回')); await until(() => document.querySelector('[role=alert]'), 'failed return save keeps the page open');
    assert.equal(api.popCount, failedSavePops); assert.ok((await repo.audioManifest(failedSaveAttempt.clipId)).byteLength > 0, 'Original chunks remain recoverable');
    assert.equal(bodyText().includes('/private/'), false); assert.equal(asrCalls, failedSaveAsr); assert.equal(feedbackCalls, failedSaveFeedback);
    click(button('返回')); await until(() => api.popCount === failedSavePops + 1, 'return retries saving the original');
    assert.equal(retryFinalizations, 2); assert.equal((await repo.audioManifest(failedSaveAttempt.clipId)).status, 'ready');
    assert.equal(scenarioState(backSaveFailure.id).attempts.at(-1).clipId, failedSaveAttempt.clipId); assert.equal(scenarioState(backSaveFailure.id).status, 'paused');
  } finally { repo.audioFinalize = successfulFinalize; }
  pass('a return-save failure keeps the page and original chunks, and another return retries the same recording safely');

  const backEmpty = await newScenario('Return with no captured PCM'), emptyAudioPops = api.popCount, emptyAudioAsr = asrCalls, emptyAudioFeedback = feedbackCalls;
  w.captureResult = { pcmB64:'' }; const emptyAudioAttempt = await beginScenario(backEmpty); click(button('返回')); noExitConfirmation();
  await until(() => api.popCount === emptyAudioPops + 1, 'empty recording cannot trap return');
  assert.equal(scenarioState(backEmpty.id).status, 'paused'); assert.equal(scenarioState(backEmpty.id).attempts.at(-1).clipId, undefined);
  assert.equal(await repo.audioManifest(emptyAudioAttempt.clipId), null); assert.equal(asrCalls, emptyAudioAsr); assert.equal(feedbackCalls, emptyAudioFeedback);
  pass('an empty microphone result clears its unusable clip reference and returns with the practice progress intact');

  const backPartial = await newScenario('Return after partial chunk failure'), partialPops = api.popCount, partialAsr = asrCalls, partialFeedback = feedbackCalls;
  w.captureChunks = [btoa(String.fromCharCode(...new Uint8Array(16000).fill(1))), btoa(String.fromCharCode(...new Uint8Array(16000).fill(2)))];
  const appendBeforeReturn = repo.audioAppend.bind(repo); let appendedChunks = 0;
  repo.audioAppend = async (...args) => { appendedChunks++; if (appendedChunks === 2) throw new Error(rawProtectionError); return appendBeforeReturn(...args); };
  try {
    const partialAttempt = await beginScenario(backPartial); click(button('返回')); noExitConfirmation();
    await until(() => api.popCount === partialPops + 1, 'incomplete recording cannot trap return');
    assert.equal(appendedChunks, 2); assert.equal(scenarioState(backPartial.id).status, 'paused');
    assert.equal(scenarioState(backPartial.id).attempts.at(-1).clipId, partialAttempt.clipId);
    assert.ok((await repo.audioManifest(partialAttempt.clipId)).byteLength > 0, 'Successfully written original chunks remain recoverable');
    assert.equal(asrCalls, partialAsr); assert.equal(feedbackCalls, partialFeedback); assert.equal(bodyText().includes('/private/'), false);
  } finally { repo.audioAppend = appendBeforeReturn; w.captureChunks = undefined; }
  pass('a partial audio write failure preserves the available original chunks and returns without a permanent retry trap');

  const endUnanswered = await newScenario('End without completed answer'), emptyEndPops = api.popCount;
  click(button('文字回答')); await until(() => document.querySelector('#practice-answer'), 'end-round typed draft'); setAnswer('An unfinished answer stays mine.');
  click(button('结束')); noExitConfirmation(); await until(() => api.popCount === emptyEndPops + 1, 'unanswered end returns directly');
  assert.equal(scenarioState(endUnanswered.id).status, 'paused'); assert.equal(scenarioState(endUnanswered.id).draft, 'An unfinished answer stays mine.');
  pass('ending a round with no feedback or skipped step simply pauses and returns with its unfinished draft');

  const endAnswered = await newScenario('End answered round'), answeredEndPops = api.popCount;
  await beginScenario(endAnswered); click(button('结束录音')); await until(() => scenarioState(endAnswered.id).attempts.at(-1).feedback && !button('结束').disabled, 'answer feedback is ready');
  const answeredAttempt = structuredClone(scenarioState(endAnswered.id).attempts.at(-1)); click(button('结束')); noExitConfirmation();
  await until(() => scenarioState(endAnswered.id).status === 'completed' && bodyText().includes('本轮复盘'), 'answered round opens recap directly');
  assert.equal(api.popCount, answeredEndPops); assert.deepEqual(scenarioState(endAnswered.id).attempts.at(-1).feedback, answeredAttempt.feedback);
  assert.equal((await repo.audioManifest(answeredAttempt.clipId)).status, 'ready');
  pass('ending a round with feedback completes it directly into its recap while retaining answer and audio');
  await api.flushPersist(); const completedBeforeReturn = structuredClone(scenarioState(endAnswered.id));
  click(button('返回')); await until(() => api.popCount === answeredEndPops + 1, 'completed recap returns directly');
  assert.deepEqual(scenarioState(endAnswered.id), completedBeforeReturn);
  await assertDurableTask(endAnswered.id, saved => assert.equal(saved.updatedAt, completedBeforeReturn.updatedAt));
  pass('returning from a completed recap does not rewrite completion metadata or reorder practice history');


  const endSkipped = await newScenario('End skipped round'), skippedEndPops = api.popCount;
  await api.actions.upsertTask({ ...endSkipped, steps:['First question?', 'Second question?'] });
  click(button('这一步先跳过')); await until(() => scenarioState(endSkipped.id).step === 1 && !button('结束').disabled, 'first step skipped');
  click(button('结束')); noExitConfirmation(); await until(() => scenarioState(endSkipped.id).status === 'completed' && bodyText().includes('本轮复盘'), 'skipped round opens recap directly');
  assert.equal(api.popCount, skippedEndPops); assert.deepEqual(scenarioState(endSkipped.id).skippedSteps, [0]);
  pass('ending a round with a skipped step opens the recap directly and preserves that skipped progress');

  api.unmount(); await wait(20); api.hideToast(); w.captureDenied = false; w.captureResult = undefined; w.captureChunks = undefined;
  const reviewLeaveAsr = asrCalls, reviewLeaveFeedback = feedbackCalls;
  api.render('review', { initial: { stage:'ask', text:'Keep my typed review while I leave.' } });
  await until(() => button('录音试说'), 'spoken review for return recovery'); click(button('录音试说'));
  await until(() => button('结束录音') && api.reviewState?.pendingClipId, 'spoken review owns its pending original');
  const interruptedReview = structuredClone(api.reviewState), reviewPendingClip = interruptedReview.pendingClipId;
  assert.equal(interruptedReview.clipId, undefined); assert.equal(interruptedReview.text, 'Keep my typed review while I leave.');
  const reviewFinalize = repo.audioFinalize.bind(repo), reviewFinalizeGate = deferred(); let reviewFinalizeEntered = false;
  repo.audioFinalize = async (...args) => { reviewFinalizeEntered = true; await reviewFinalizeGate.promise; return reviewFinalize(...args); };
  try {
    api.unmount(); await until(() => reviewFinalizeEntered, 'unmounted review is still finalizing original');
    api.render('review', { initial: interruptedReview }); await until(() => api.reviewState?.pendingClipId === reviewPendingClip, 'review reopens before original finalization');
    await wait(2150); assert.equal(api.reviewState.clipId, undefined, 'Unfinished audio must not be advertised as a saved original, even beyond the former recovery timeout');
    reviewFinalizeGate.resolve();
    await until(() => api.reviewState?.clipId === reviewPendingClip && !api.reviewState.pendingClipId, 'reopened spoken review recovers original after finalization');
    assert.equal((await repo.audioManifest(reviewPendingClip)).status, 'ready');
  } finally { reviewFinalizeGate.resolve(); repo.audioFinalize = reviewFinalize; }
  assert.equal(api.reviewState.text, 'Keep my typed review while I leave.'); assert.equal(api.reviewState.stage, 'confirm', 'Recovered audio returns to answer confirmation before any manual grade');
  assert.equal(asrCalls, reviewLeaveAsr); assert.equal(feedbackCalls, reviewLeaveFeedback);
  pass('leaving spoken review during recording retains the pending original and reopening recovers it without replacing typed text or auto-transcribing');

  const switching=await newScenario('Profile switch while transcribing'),switchFeedback=feedbackCalls,switchAsr=asrCalls,originProfile=api.profileIdentity();asrGate=deferred();const switchGate=asrGate;await beginScenario(switching);click(button('结束录音'));await until(()=>asrCalls>switchAsr,'old profile ASR request');
  await api.switchProfile('another-conversation-profile',false);await api.actions.upsertTask({...switching,draft:'Keep the new profile text.',attempts:[]});asrGate=null;switchGate.resolve();await wait(30);
  assert.equal(api.getState().tasks.find(t=>t.id===switching.id).draft,'Keep the new profile text.');assert.equal(api.getState().tasks.find(t=>t.id===switching.id).attempts.length,0);assert.equal(feedbackCalls,switchFeedback);
  api.unmount();await wait(20);await api.switchProfile(originProfile,false);api.render('practice',{taskId:switching.id});await until(()=>scenarioState(switching.id).attempts.at(-1).status==='interrupted','old profile recording recoverable');
  pass('a delayed old-profile transcript cannot alter or submit the new profile, and returning to the old profile recovers its saved recording');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: ' + checks + ' recording failure/recovery regressions');
} finally {
  api?.unmount(); api?.hideToast(); api?.stopSpeak();
  try { await api?.flushPersist(); api?.activeRepository().close(); } catch {}
  dom.window.close(); console.warn = originalWarn; console.error = originalError; process.removeListener('unhandledRejection', unhandled);
  await rm(directory, { recursive: true, force: true });
}
