import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = require(root + '/immersive-translator-mobile/node_modules/typescript');
class CloudError extends Error { constructor(message, status=0, code='network_error') { super(message); this.status=status; this.code=code; } }
const cache = new Map();
function load(file) {
  file=path.resolve(file); if(cache.has(file))return cache.get(file).exports;
  const mod=new Module(file); cache.set(file,mod); mod.filename=file; mod.paths=Module._nodeModulePaths(path.dirname(file));
  mod.require=name=> {
    if(name==='react')return {useSyncExternalStore(){}};
    if(name==='../store')return Object.fromEntries(['activeRepository','commitRepository','deviceId','flushPersist','getState','profileIdentity','replaceSyncedState'].map(k=>[k,()=>{}]));
    if(name==='./cloud')return {CloudError,cloudState(){return{}},cloudRequest(){},loadCloudConfig(){}};
    if(name.startsWith('.')){let next=path.resolve(path.dirname(file),name);if(!next.endsWith('.ts'))next+='.ts';return load(next);}return require(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;
}
const {MobileSync}=load(root+'/immersive-translator-mobile/src/services/sync.ts');
const {stampPracticeTask,mergePracticeTask}=load(root+'/packages/learning-core/src/index.ts');
const clone=v=>structuredClone(v);
const collections=['reading-articles','reading-vocab','review-events','notes','speak-sessions','history','glossary'];
function setup(initial={}, options={}) {
  let state={articles:[],vocab:[],reviewEvents:[],notes:[],sessions:[],tasks:[],history:[],glossary:[],progress:{},speakDifficulty:'medium',...clone(initial)};
  const records=new Map(),outbox=new Map(),remote=new Map(collections.map(c=>[c,new Map()]));
  let version=0; const calls=[];let commits=0;
  const repo={identity:'u1',get:async(c,id)=>clone(records.get(c+':'+id)??null),list:async c=>clone([...records.values()].filter(r=>r.collection===c)),listOutbox:async()=>clone([...outbox.values()]),ackOutbox:async ids=>ids.forEach(id=>outbox.delete(id))};
  function apply(input={}){commits++;for(const r of input.records??[]){const key=r.collection+':'+r.id;records.set(key,{...clone(r),version:(records.get(key)?.version??0)+1,deleted:!!r.deleted});}for(const item of input.outbox??[]){assert(!outbox.has(item.id));outbox.set(item.id,clone(item));}}
  const config={features:{sync:true},sync:{protocolVersion:2,maxPushEntities:200,maxBodyBytes:12*1024*1024,collections:Object.fromEntries(collections.map(c=>[c,{schemaVersions:[1,2],maxEntityBytes:c==='speak-sessions'?65536:524288}]))}};
  const cloud={account:{id:'u1'},generation:1,config};
  const server=async(url,method='GET',body)=>{
    calls.push({url,method,body:clone(body)});
    const parsed=new URL(url,'https://local'),collection=parsed.pathname.split('/')[3],table=remote.get(collection);
    if(options.intercept){const intercepted=await options.intercept({url,method,body,parsed,collection,table,state,records,remote});if(intercepted!==undefined)return intercepted;}
    if(method==='GET'){const since=Number(parsed.searchParams.get('since'));const entities=[...table.values()].filter(e=>e.version>since).sort((a,b)=>a.version-b.version);return {collection,cursor:entities.length?entities.at(-1).version:since,hasMore:false,entities:clone(entities)};}
    for(const e of body.entities){const old=table.get(e.id);if((old?.version??0)!==e.baseVersion)throw new CloudError('conflict',409,'sync_conflict');}
    const results=[];for(const e of body.entities){const wire={...clone(e),version:++version};table.set(e.id,wire);results.push({id:e.id,status:'accepted',version});}return {collection,results};
  };
  const engine=new MobileSync({repository:()=>repo,identity:()=>repo.identity,deviceId:()=> 'mobile-1',state:()=>state,flush:async()=>{},commit:async input=>apply(input),replace:async(mapper,extra)=>{const patch=mapper(state);apply(extra);state={...state,...clone(patch)};},cloud:()=>cloud,config:async()=>config,request:server});
  return {engine,repo,records,outbox,remote,calls,cloud,state:()=>state,change:patch=>{state={...state,...clone(patch)}},setRemote:(collection,id,payload,updatedAt=Date.now(),schemaVersion=2)=>{const wire={id,payload:clone(payload),updatedAt:new Date(updatedAt).toISOString(),schemaVersion,deleted:false,version:++version};remote.get(collection).set(id,wire);return wire;},commits:()=>commits};
}
const note=(body='first')=>({id:'note-1',title:'Title',sub:'',body,insight:'',createdAt:1,updatedAt:1});
const article=(zh='你好')=>({id:'article-1',title:'Story',titleCn:'',paragraphStarts:[0],createdAt:1,lastReadAt:2,sentences:[{idx:0,paragraphIdx:0,en:'Hello world.',zh,zhState:'machine'}]});
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
test('normal push is durable, uses compatible note envelope, and does not re-push unchanged rows',async()=>{const t=setup({notes:[note()]});await t.engine.sync();assert.equal(t.remote.get('notes').get('note-1.md').payload.content,'first');assert.equal(t.outbox.size,0);const pushes=t.calls.filter(c=>c.method==='POST').length;await t.engine.sync();assert.equal(t.calls.filter(c=>c.method==='POST').length,pushes);assert.equal(t.engine.getStatus().phase,'idle');});
test('editing while old push is in flight keeps newer payload and sends it at acknowledged baseVersion',async()=>{let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let first=true;const t=setup({notes:[note()]},{intercept:async c=>{if(c.method==='POST'&&c.collection==='notes'&&first){first=false;entered();await gate;}}});const flight=t.engine.sync();await ready;t.change({notes:[note('second')]});await t.engine.queueLocal();release();await flight;assert.equal(t.remote.get('notes').get('note-1.md').payload.content,'second');const sent=t.calls.filter(c=>c.method==='POST'&&c.url.includes('/notes/'));assert.equal(sent.length,2);assert.equal(sent[1].body.entities[0].baseVersion,1);assert.equal(t.outbox.size,0);});
test('staleCursor full snapshot removes compacted remote deletion without resurrecting local clean note',async()=>{let stale=false;const t=setup({notes:[note()]},{intercept:c=>{if(stale&&c.method==='GET'&&c.collection==='notes'&&Number(c.parsed.searchParams.get('since'))>0)return {collection:'notes',cursor:1,hasMore:false,staleCursor:true,entities:[]};}});await t.engine.sync();await t.engine.sync();t.remote.get('notes').clear();stale=true;await t.engine.sync();assert.equal(t.state().notes.length,0);assert.equal(t.remote.get('notes').size,0);assert.equal(t.records.get('sync.v2.meta:notes').payload.cursor,0);});
test('full snapshot page failure preserves old cursor, domain snapshot, and pending local data',async()=>{let broken=false;const t=setup({notes:[note()]},{intercept:c=>{if(broken&&c.method==='GET'&&c.collection==='notes'){const since=Number(c.parsed.searchParams.get('since'));if(since===1)return {collection:'notes',cursor:1,hasMore:false,staleCursor:true,entities:[]};if(since===0)return {collection:'notes',cursor:2,hasMore:true,entities:[{id:'other.md',payload:{meta:{},content:'new'},schemaVersion:2,updatedAt:new Date().toISOString(),version:2,deleted:false}]};throw new CloudError('offline');}}});await t.engine.sync();await t.engine.sync();broken=true;await assert.rejects(t.engine.sync(),/offline/);assert.equal(t.state().notes[0].body,'first');assert.equal(t.records.get('sync.v2.meta:notes').payload.cursor,1);assert.equal(t.records.has('sync.v2.notes:other.md'),false);});
test('stale rebuild keeps local dirty edit even when remote clock is newer',async()=>{let stale=false;const t=setup({notes:[note()]},{intercept:c=>{if(stale&&c.method==='GET'&&c.collection==='notes'&&Number(c.parsed.searchParams.get('since'))>0){stale=false;return {collection:'notes',cursor:1,hasMore:false,staleCursor:true,entities:[]};}}});await t.engine.sync();await t.engine.sync();t.setRemote('notes','note-1.md',{...note('remote'),id:'note-1.md',mobileId:'note-1',meta:{},content:'remote'},Date.now()+100000);t.change({notes:[note('local draft')]});stale=true;await t.engine.sync();assert.equal(t.state().notes[0].body,'local draft');assert.equal(t.remote.get('notes').get('note-1.md').payload.content,'local draft');});
test('409 reload rebases against remote version and equal/newer remote wins deterministically',async()=>{let conflict=false;let t; t=setup({notes:[note()]},{intercept:c=>{if(conflict&&c.method==='POST'&&c.collection==='notes'){conflict=false;t.setRemote('notes','note-1.md',{...note('server'),id:'note-1.md',mobileId:'note-1',content:'server',meta:{}},Date.now()+100000);throw new CloudError('conflict',409,'sync_conflict');}}});await t.engine.sync();t.change({notes:[note('offline edit')]});conflict=true;await t.engine.sync();assert.equal(t.state().notes[0].body,'server');assert.equal(t.outbox.size,0);});
test('immutable review same ID different business content is surfaced and local event remains',async()=>{const e={v:2,id:'e1',wordId:'w1',deviceId:'d1',reviewedAt:1,kind:'grade',grade:'good',mode:'recognition'};const t=setup({reviewEvents:[e]});await t.engine.sync();t.setRemote('review-events','e1',{...e,grade:'easy'});t.change({reviewEvents:[{...e,grade:'forgot'}]});await assert.rejects(t.engine.sync(),/复习事件 ID 内容冲突|不可变/);assert.equal(t.state().reviewEvents[0].grade,'forgot');});
test('task envelope is desktop compatible and audio bytes never leave device',async()=>{const task={id:'task1',mode:'word',title:'Practice',reference:'Hello',step:0,attempts:[{id:'a1',text:'Hello',step:0,deviceId:'d1',clipId:'clip1',audio:'secret',pcm:'secret',wavB64:'secret',pcmB64:'secret',feedback:{message:'fine'}}],draft:'',status:'paused',createdAt:1,updatedAt:2};const t=setup({tasks:[task]});await t.engine.sync();const p=t.remote.get('speak-sessions').get('task1').payload;assert.equal(p.kind,'practice-task');assert.equal(p.scenario,'practice');assert.equal(p.difficulty,'medium');assert.deepEqual(p.turns,[]);assert.equal(p.task.attempts[0].clipId,'clip1');for(const key of ['audio','pcm','wavB64','pcmB64'])assert.equal(p.task.attempts[0][key],undefined);const t2=setup();t2.remote.get('speak-sessions').set('task1',clone(t.remote.get('speak-sessions').get('task1')));await t2.engine.sync();assert.equal(t2.state().tasks[0].attempts[0].feedback.message,'fine');});
test('invalid ack preserves pending mirror and outbox',async()=>{const t=setup({notes:[note()]},{intercept:c=>c.method==='POST'?{collection:c.collection,results:[]}:undefined});await assert.rejects(t.engine.sync(),/确认响应不完整/);assert(t.records.get('sync.v2.notes:note-1.md').payload.dirty);assert(t.outbox.size>0);});
test('future schema does not replace current state or advance cursor',async()=>{const t=setup({notes:[note()]});await t.engine.sync();await t.engine.sync();t.setRemote('notes','note-1.md',{id:'note-1.md',content:'future'},Date.now(),3);await assert.rejects(t.engine.sync(),/较新格式/);assert.equal(t.state().notes[0].body,'first');assert.equal(t.records.get('sync.v2.meta:notes').payload.cursor,1);});
test('rate limit preserves outbox and exposes an actionable sync error',async()=>{const t=setup({notes:[note()]},{intercept:c=>{if(c.method==='POST')throw new CloudError('稍后再试',429,'rate_limited');}});await assert.rejects(t.engine.sync(),/稍后再试/);assert.equal(t.engine.getStatus().phase,'error');assert(t.outbox.size>0);assert.equal(t.calls.filter(c=>c.method==='POST').length,1);});
test('late pull after account switch never commits response or advances its cursor',async()=>{let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);const t=setup({}, {intercept:async c=>{if(c.method==='GET'&&c.collection==='notes'){entered();await gate;return {collection:'notes',cursor:1,hasMore:false,entities:[{id:'late.md',schemaVersion:2,deleted:false,payload:{content:'private'},version:1,updatedAt:new Date().toISOString()}]};}}});const flight=t.engine.sync();await ready;const before=t.commits();t.cloud.generation++;t.cloud.account={id:'u2'};release();await assert.rejects(flight,e=>e.name==='AbortError');assert.equal(t.commits(),before);assert.equal(t.state().notes.length,0);assert.equal(t.records.has('sync.v2.notes:late.md'),false);});
test('Chinese translation changes produce new immutable chunk IDs and stable sentence locators',async()=>{const t=setup({articles:[article()]});await t.engine.sync();const old=t.remote.get('reading-articles').get('article-1').payload;const oldChunk=t.remote.get('reading-articles').get(old.chunkIds[0]).payload;t.change({articles:[article('您好，世界。')]});await t.engine.sync();const next=t.remote.get('reading-articles').get('article-1').payload,nextChunk=t.remote.get('reading-articles').get(next.chunkIds[0]).payload;assert.notEqual(next.contentRevision,old.contentRevision);assert.notEqual(next.chunkIds[0],old.chunkIds[0]);assert.equal(nextChunk.sentences[0].id,oldChunk.sentences[0].id);assert.equal(nextChunk.sentences[0].zh,'您好，世界。');});
test('unknown desktop session feedback and timestamps survive a mobile edit',async()=>{const t=setup();t.setRemote('speak-sessions','s1',{id:'s1',scenario:'coffee',difficulty:'hard',turns:[{role:'user',text:'Coffee please',at:100,feedback:{score:92},future:'retain'}],createdAt:90,updatedAt:110});await t.engine.sync();assert.equal(t.state().sessions[0].turns,1);const session=t.state().sessions[0];t.change({sessions:[{...session,chat:[{...session.chat[0],en:'Tea please'}]}]});await t.engine.sync();const p=t.remote.get('speak-sessions').get('s1').payload;assert.equal(p.turns[0].text,'Tea please');assert.equal(p.turns[0].at,100);assert.equal(p.turns[0].feedback.score,92);assert.equal(p.turns[0].future,'retain');assert.equal(p.difficulty,'hard');assert.equal(p._syncTurns,undefined);});
test('remote legacy recall baseline is retained and review replay does not double count',async()=>{const t=setup();const baseline={intervalDays:0,repetitions:0,easeFactor:2.5,dueAt:1};t.setRemote('reading-vocab','w1',{id:'w1',word:'hello',generation:'g1',srs:baseline,baseline,baselineRecall:{total:{pass:3,wrong:2,trap:1},byMode:{recognition:{pass:3,wrong:2,trap:1}}},senses:[],source:{articleId:'a',sentenceIdx:0}});t.setRemote('review-events','e1',{v:2,id:'e1',wordId:'w1',deviceId:'desktop',generation:'g1',reviewedAt:2000,kind:'grade',grade:'good',mode:'recognition',recall:{bucket:'pass'}});await t.engine.sync();assert.equal(t.state().vocab[0].recall.total.pass,4);await t.engine.sync();assert.equal(t.state().vocab[0].recall.total.pass,4);assert.equal(t.state().vocab[0].baselineRecall.total.pass,3);});
const taskBase=()=>({id:'practice-concurrent',mode:'word',title:'Practice',reference:'Use hello',word:'hello',step:0,attempts:[],draft:'',status:'active',createdAt:1,updatedAt:1});
const attempt=(id,createdAt)=>({id,step:0,text:id,deviceId:id,status:'feedback',createdAt,feedback:{message:id,improved:id,explanation:id,usedTarget:true}});
const envelope=task=>({v:2,id:task.id,kind:'practice-task',scenario:'practice',difficulty:'medium',turns:[],createdAt:task.createdAt,updatedAt:task.updatedAt,startedAt:task.createdAt,endedAt:task.updatedAt,task});
test('offline attempts from two devices form a durable union and converge without repeated pushes',async()=>{
  const base=stampPracticeTask(undefined,taskBase(),10);
  const local=stampPracticeTask(base,{...base,attempts:[attempt('mobile',20)],draft:'mobile draft'},20);
  const other=stampPracticeTask(base,{...base,attempts:[attempt('windows',30)],draft:'windows draft'},30);
  const t=setup({tasks:[local]});t.setRemote('speak-sessions',base.id,envelope(other),Date.now()+1000);
  await t.engine.sync();
  assert.deepEqual(t.state().tasks[0].attempts.map(a=>a.id),['mobile','windows']);
  assert.equal(t.state().tasks[0].draft,'windows draft');
  assert.deepEqual(t.remote.get('speak-sessions').get(base.id).payload.task.attempts.map(a=>a.id),['mobile','windows']);
  const pushes=t.calls.filter(c=>c.method==='POST').length;await t.engine.sync();
  assert.equal(t.calls.filter(c=>c.method==='POST').length,pushes);assert.equal(t.outbox.size,0);
});
test('feedback and pronunciation on one attempt survive independent device updates',async()=>{
  const base=stampPracticeTask(undefined,{...taskBase(),attempts:[{...attempt('shared',10),feedback:undefined,status:'recorded'}]},10);
  const local=stampPracticeTask(base,{...base,attempts:[{...base.attempts[0],feedback:{message:'text',improved:'Hello',explanation:'text only',usedTarget:true},status:'feedback'}]},20);
  const other=stampPracticeTask(base,{...base,attempts:[{...base.attempts[0],pronunciation:{total:89,accuracy:90,fluency:88,standard:90,isRejected:false,exceptInfo:null,words:[]},pronunciationStatus:'ready'}]},30);
  const t=setup({tasks:[local]});t.setRemote('speak-sessions',base.id,envelope(other),Date.now()+1000);await t.engine.sync();
  const a=t.state().tasks[0].attempts[0];assert.equal(a.feedback.message,'text');assert.equal(a.pronunciation.total,89);assert.equal(a.status,'feedback');
});
test('cancelled attempt tombstones prevent a later stale device from restoring it',async()=>{
  const base=stampPracticeTask(undefined,{...taskBase(),attempts:[attempt('cancelled',10)]},10);
  const local=stampPracticeTask(base,{...base,attempts:[],removedAttemptIds:['cancelled']},20);
  const other=stampPracticeTask(base,{...base,draft:'edited later'},30);
  const t=setup({tasks:[local]});t.setRemote('speak-sessions',base.id,envelope(other),Date.now()+1000);await t.engine.sync();
  assert.equal(t.state().tasks[0].attempts.length,0);assert.deepEqual(t.remote.get('speak-sessions').get(base.id).payload.task.removedAttemptIds,['cancelled']);
});
test('task deletion wins over dirty live task and cannot resurrect attempts',async()=>{
  const task=stampPracticeTask(undefined,{...taskBase(),attempts:[attempt('local',10)]},10);const t=setup({tasks:[task]});
  const deleted=t.setRemote('speak-sessions',task.id,null,Date.now()+1000);deleted.deleted=true;
  await t.engine.sync();assert.equal(t.state().tasks.length,0);assert.equal(t.remote.get('speak-sessions').get(task.id).deleted,true);
});
test('edits made while a task pull is in flight merge with the pulled attempts',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let blocked=false;
  const base=stampPracticeTask(undefined,taskBase(),10);
  const t=setup({tasks:[base]},{intercept:async c=>{if(blocked&&c.method==='GET'&&c.collection==='speak-sessions'){blocked=false;entered();await gate;}}});await t.engine.sync();
  const other=stampPracticeTask(base,{...base,attempts:[attempt('windows',20)]},20);t.setRemote('speak-sessions',base.id,envelope(other),Date.now()+1000);blocked=true;
  const flight=t.engine.sync();await ready;t.change({tasks:[stampPracticeTask(base,{...base,attempts:[attempt('mobile',30)]},30)]});release();await flight;
  assert.deepEqual(t.state().tasks[0].attempts.map(a=>a.id),['windows','mobile']);assert.equal(t.remote.get('speak-sessions').get(base.id).payload.task.attempts.length,2);
});

const audioRegisters=()=>({fieldUpdatedAt:{'/future':40,'/future/audioB64':20,'/future~1format/PCM':20,'/future/data':20,'/clipId':10},fieldShadow:{'/future/audioB64':'PRIVATE_SHADOW_AUDIO','/future~1format/PCM':'PRIVATE_ESCAPED_PCM','/future/data':{audio:'PRIVATE_NESTED_AUDIO',safe:'retained extension'}}});
function assertNoAudioRegisters(value){
  const privateKeys=new Set(['audio','audiob64','audiobase64','audio_base64','pcmb64','pcm','pcm_base64','wavb64','wav','blob','audiofile','audiopath','localpath']);
  const walk=row=>{if(Array.isArray(row)){row.forEach(walk);return;}if(!row||typeof row!=='object')return;for(const[key,child]of Object.entries(row)){assert.equal(privateKeys.has(key.toLowerCase()),false,'private audio field '+key);if(key.startsWith('/'))for(const part of key.slice(1).split('/'))assert.equal(privateKeys.has(part.replace(/~1/g,'/').replace(/~0/g,'~').toLowerCase()),false,'private audio register '+key);walk(child);}};
  walk(value);assert.equal(JSON.stringify(value).includes('PRIVATE_'),false,'audio bytes survived synchronization');
}
test('stamped hidden audio registers are stripped before task projection and push while safe extensions remain',async()=>{
  const original=stampPracticeTask(undefined,{...taskBase(),attempts:[{...attempt('recorded',10),clipId:'local-clip',future:{audioB64:'PRIVATE_GENERATED_SHADOW',safe:'safe scalar extension'}}]},10);
  const scalar=stampPracticeTask(undefined,{...taskBase(),attempts:[{...attempt('recorded',10),clipId:'local-clip',future:0}]},20);
  const task=mergePracticeTask(original,scalar);
  assert.equal(task.attempts[0].fieldShadow['/future/audioB64'],'PRIVATE_GENERATED_SHADOW');
  task.attempts[0].fieldShadow['/future/data']={audio:'PRIVATE_NESTED_AUDIO',safe:'retained extension'};task.attempts[0].fieldUpdatedAt['/future/data']=10;
  const t=setup({tasks:[task]});await t.engine.sync();
  const sent=t.calls.find(c=>c.method==='POST'&&c.url.includes('/speak-sessions/')).body.entities[0].payload;assertNoAudioRegisters(sent);
  const a=sent.task.attempts[0];assert.equal(a.clipId,'local-clip');assert.equal(a.fieldShadow['/future/safe'],'safe scalar extension');assert.equal(a.fieldShadow['/future/data'].safe,'retained extension');
  await t.engine.sync();const pushes=t.calls.filter(c=>c.method==='POST').length;await t.engine.sync();assert.equal(t.calls.filter(c=>c.method==='POST').length,pushes);assert.equal(t.outbox.size,0);
});
test('remote hidden audio is removed from restored state, dirty task merge and every outgoing payload',async()=>{
  const local=stampPracticeTask(undefined,{...taskBase(),attempts:[{...attempt('mobile',10),clipId:'local-clip'}]},10);
  const remote=stampPracticeTask(undefined,{...taskBase(),draft:'remote answer',attempts:[{...attempt('desktop',20),clipId:'desktop-clip',future:0}]},20);Object.assign(remote.attempts[0],audioRegisters());
  const payload=envelope(remote);Object.assign(payload,audioRegisters());payload.future=0;
  const t=setup({tasks:[local]});t.setRemote('speak-sessions',remote.id,payload,Date.now()+1000);await t.engine.sync();
  assertNoAudioRegisters(t.state().tasks);assert.deepEqual(t.state().tasks[0].attempts.map(a=>a.id),['mobile','desktop']);assert.equal(t.state().tasks[0].draft,'remote answer');
  const a=t.state().tasks[0].attempts.find(a=>a.id==='desktop');assert.equal(a.clipId,'desktop-clip');assert.equal(a.fieldShadow['/future/data'].safe,'retained extension');
  for(const call of t.calls.filter(c=>c.method==='POST'))assertNoAudioRegisters(call.body);for(const row of t.records.values())assertNoAudioRegisters(row);
  const pushes=t.calls.filter(c=>c.method==='POST').length;await t.engine.sync();assert.equal(t.calls.filter(c=>c.method==='POST').length,pushes);assert.equal(t.outbox.size,0);
});
test('hidden audio added during a task pull is sanitized before rebase and acknowledgement',async()=>{
  let entered,release,blocked=false;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const base=stampPracticeTask(undefined,taskBase(),10);
  const t=setup({tasks:[base]},{intercept:async c=>{if(blocked&&c.method==='GET'&&c.collection==='speak-sessions'){blocked=false;entered();await gate;}}});await t.engine.sync();
  const remote=stampPracticeTask(base,{...base,attempts:[attempt('remote',20)]},20);t.setRemote('speak-sessions',base.id,envelope(remote),Date.now()+1000);blocked=true;
  const flight=t.engine.sync();await ready;
  t.change({tasks:[stampPracticeTask(base,{...base,draft:'edit during pull',attempts:[{...attempt('local',30),future:0,clipId:'local-clip',...audioRegisters()}]},30)]});release();await flight;
  assertNoAudioRegisters(t.state().tasks);assert.equal(t.state().tasks[0].draft,'edit during pull');assert.deepEqual(t.state().tasks[0].attempts.map(a=>a.id),['remote','local']);
  for(const call of t.calls.filter(c=>c.method==='POST'))assertNoAudioRegisters(call.body);assertNoAudioRegisters([...t.records.values()]);assert.equal(t.outbox.size,0);
});
(async()=>{let passed=0;for(const[name,fn]of tests){try{await fn();console.log('PASS '+name);passed++;}catch(e){console.error('FAIL '+name,e);process.exitCode=1;}}console.log(`${passed}/${tests.length} tests passed`);})();
