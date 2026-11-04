// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PracticeRelayList, PracticeRelayView } from "./PracticeRelayView";
import type { AuthStatus, StoredSyncEntity } from "../lib/tauriBridge";

const mocks=vi.hoisted(()=>({invoke:vi.fn(),authGetStatus:vi.fn(),learningNamespace:vi.fn(),listen:vi.fn(),login:vi.fn(),list:vi.fn(),put:vi.fn(),sync:vi.fn(),syncStrict:vi.fn(),mic:vi.fn(),route:vi.fn(),asr:vi.fn(),ise:vi.fn(),asrCreds:vi.fn(),iseCreds:vi.fn(),xfyunAsr:vi.fn(),xfyunIse:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("../lib/tauriBridge",()=>({authGetStatus:mocks.authGetStatus,learningNamespace:mocks.learningNamespace,listenAuthStateChanged:mocks.listen,openLoginWindow:mocks.login,syncStoreList:mocks.list,syncStorePut:mocks.put}));
vi.mock("../lib/learningRelay",()=>({syncLearningRecordsSilently:mocks.sync,syncLearningRecords:mocks.syncStrict}));
vi.mock("../core/micRecorder",()=>({startMicRecorder:mocks.mic}));
vi.mock("../lib/voice",()=>({evaluatePronunciation:mocks.ise,pcm16kToBase64:vi.fn(),transcribeBatch:mocks.asr,resolveVoiceRoute:mocks.route,voiceErrorDisplayText:(error:{code?:unknown})=>error.code==="quota_exceeded"?"本月语音额度已用完":"服务暂时不可用，请稍后再试"}));
vi.mock("../lib/iseCredentials",()=>({loadAsrCredentials:mocks.asrCreds,loadIseCredentials:mocks.iseCreds}));
vi.mock("../core/xfyunAsr",()=>({transcribeSpeech:mocks.xfyunAsr}));
vi.mock("../core/pronunciation",()=>({evaluateSentence:mocks.xfyunIse}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

let ns:string,loggedIn:boolean,listener:(status:AuthStatus)=>void,rows:Map<string,StoredSyncEntity[]>,container:HTMLDivElement,root:Root;
const task={id:"task-1",mode:"follow",title:"手机保存的练习",reference:"Hello from the phone",steps:["Hello from the phone","Next sentence"],step:0,attempts:[{id:"attempt-1",step:0,text:"Hello from Windows",deviceId:"phone",status:"draft",createdAt:1,reference:"Hello from the phone"}],draft:"",status:"active",createdAt:1,updatedAt:2};
function entity():StoredSyncEntity{return {id:task.id,baseVersion:3,updatedAt:2,deleted:false,schemaVersion:2,dirty:false,payload:{v:2,id:task.id,kind:"practice-task",scenario:"practice",difficulty:"medium",turns:[],startedAt:1,endedAt:2,task:structuredClone(task)}};}
function recordedEntity():StoredSyncEntity{const row=entity();const saved=row.payload as {task:{attempts:Record<string,unknown>[]}};saved.task.attempts[0]={...saved.task.attempts[0],clipId:"clip-1",deviceId:"windows-device",status:"recorded"};return row;}
async function settle(){await act(async()=>{for(let i=0;i<12;i++)await Promise.resolve();});}
async function click(text:string){const button=[...container.querySelectorAll("button")].find(item=>item.textContent?.includes(text));expect(button).toBeDefined();await act(async()=>button!.click());await settle();}
async function mountHub(){await act(async()=>root.render(<PracticeRelayList onToast={()=>undefined}/>));await settle();}
async function mount(translate=vi.fn().mockResolvedValue({status:"done",text:JSON.stringify({message:"语义清楚",improved:"Hello from Windows.",explanation:"保留原意",usedTarget:true})})){await act(async()=>root.render(<><PracticeRelayList onToast={()=>undefined}/><PracticeRelayView requestTranslate={translate} speakEn={async()=>1} onToast={()=>undefined}/></>));await settle();await click(task.title);return translate;}
beforeEach(()=>{vi.clearAllMocks();ns="guest";loggedIn=false;rows=new Map([["guest",[entity()]]]);mocks.invoke.mockImplementation(async command=>command==="learning_audio"?{pcmB64:"AAAAgP9/"}:"windows-device");mocks.authGetStatus.mockImplementation(async()=>({loggedIn,user:loggedIn?{id:"a"}:null,notice:null}));mocks.learningNamespace.mockImplementation(async()=>ns);mocks.listen.mockImplementation(async(fn)=>{listener=fn;return()=>undefined;});mocks.list.mockImplementation(async(_collection,expected)=>{if(expected&&expected!==ns)throw new Error("账号已切换");return structuredClone(rows.get(ns)??[]);});mocks.put.mockImplementation(async(_collection,entities,expected)=>{if(expected!==ns)throw new Error("账号已切换");rows.set(ns,structuredClone(entities));});mocks.sync.mockResolvedValue([]);mocks.syncStrict.mockResolvedValue([{ok:true,pulled:1,appliedRemote:1,keptLocal:0,pushed:0,conflicts:0,skipped:[],error:null}]);mocks.login.mockResolvedValue(undefined);mocks.route.mockImplementation(async()=>loggedIn?{engine:"gateway",reason:null,hint:null}:{engine:"off",reason:"not_logged_in",hint:"登录沉浸云即用"});mocks.asrCreds.mockResolvedValue({appId:"app",apiKey:"key",apiSecret:"secret"});mocks.iseCreds.mockResolvedValue({appId:"app",apiKey:"key",apiSecret:"secret"});mocks.asr.mockResolvedValue({text:"Cloud transcription",durationMs:1});mocks.xfyunAsr.mockResolvedValue("Xfyun transcription");const score={total:4,accuracy:4,fluency:4,standard:4,integrity:5,isRejected:false,exceptInfo:null,words:[]};mocks.ise.mockResolvedValue(score);mocks.xfyunIse.mockResolvedValue(score);container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});

describe("Windows练习接力",()=>{
  it("does not render a sync panel when there is no saved practice",async()=>{
    rows.set("guest",[]);await mountHub();
    expect(container.querySelector(".practice-relay-menu")).toBeNull();expect(container.querySelector(".practice-relay-trigger")).toBeNull();
    expect(container.textContent).not.toContain("继续口语练习");
  });
  it("shows saved practice as continuation rows and refreshes them after background sync",async()=>{
    loggedIn=true;ns="account-a";rows.set(ns,[entity()]);await mountHub();
    expect(container.querySelectorAll(".recent-session-row")).toHaveLength(1);expect(container.textContent).toContain("继续口语练习");
    const updated=entity();(updated.payload as {task:typeof task}).task.step=1;rows.set(ns,[updated]);
    await act(async()=>window.dispatchEvent(new CustomEvent("learning-sync-complete")));await settle();
    expect(container.textContent).toContain("第 2 步");
  });
  it("opens a selected saved practice in the content flow",async()=>{
    await mount();const detail=container.querySelector("section");expect(detail).not.toBeNull();expect(detail?.closest(".recent-session-row")).toBeNull();
  });
  it("游客登录后恢复已保存的练习动作和反馈",async()=>{
    const translate=await mount();expect(container.textContent).toContain("Hello from the phone");await click("获取表达建议");expect(mocks.login).toHaveBeenCalledTimes(1);expect(translate).not.toHaveBeenCalled();
    rows.set("account-a",structuredClone(rows.get("guest")!));ns="account-a";loggedIn=true;await act(async()=>listener({loggedIn:true,user:{id:"a",email:"a@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null}));await settle();
    expect(translate).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("语义清楚");expect(mocks.put.mock.calls[0]?.[2]).toBe("account-a");
    expect((rows.get("account-a")![0].payload as {task:{attempts:{feedback?:unknown}[]}}).task.attempts[0].feedback).toBeDefined();
  });
  it("云请求在途切账号时丢弃旧响应且不写新账号",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[entity()]);let resolve!:(value:{status:"done";text:string})=>void;const translate=vi.fn(()=>new Promise<{status:"done";text:string}>(done=>{resolve=done;}));await mount(translate);
    const button=[...container.querySelectorAll("button")].find(item=>item.textContent==="获取表达建议")!;await act(async()=>button.click());await settle();expect(translate).toHaveBeenCalledTimes(1);
    ns="account-b";rows.set(ns,[]);await act(async()=>listener({loggedIn:true,user:{id:"b",email:"b@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null}));await settle();
    await act(async()=>resolve({status:"done",text:JSON.stringify({message:"旧账号反馈",improved:"x",explanation:"x",usedTarget:true})}));await settle();
    expect(mocks.put).not.toHaveBeenCalled();expect(container.textContent).not.toContain("旧账号反馈");expect(rows.get("account-b")).toEqual([]);
  });
  it("云反馈在途遇另一设备追加回答，旧UI保存后仍显示双方记录",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[entity()]);
    let resolve!:(value:{status:"done";text:string})=>void;const translate=vi.fn(()=>new Promise<{status:"done";text:string}>(done=>{resolve=done;}));
    await mount(translate);const button=[...container.querySelectorAll("button")].find(item=>item.textContent==="获取表达建议")!;
    await act(async()=>button.click());await settle();
    const remote=entity(),payload=remote.payload as {task:typeof task};
    payload.task.attempts.push({...task.attempts[0],id:"phone-added",text:"Another phone answer",createdAt:3});
    payload.task.updatedAt=3;remote.updatedAt=3;rows.set(ns,[remote]);
    await act(async()=>resolve({status:"done",text:JSON.stringify({message:"本机反馈",improved:"Hello.",explanation:"Saved",usedTarget:true})}));await settle();
    expect(container.textContent).toContain("Another phone answer");expect(container.textContent).toContain("本机反馈");
    const saved=(rows.get(ns)![0].payload as {task:typeof task}).task;expect(saved.attempts.map(a=>a.id)).toEqual(["attempt-1","phone-added"]);
  });
  it("已被远端删除的任务不会因旧UI反馈完成而重新写入",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[entity()]);
    let resolve!:(value:{status:"done";text:string})=>void;const translate=vi.fn(()=>new Promise<{status:"done";text:string}>(done=>{resolve=done;}));
    await mount(translate);const button=[...container.querySelectorAll("button")].find(item=>item.textContent==="获取表达建议")!;
    await act(async()=>button.click());await settle();rows.set(ns,[{...entity(),deleted:true,payload:undefined}]);
    await act(async()=>resolve({status:"done",text:JSON.stringify({message:"旧响应",improved:"x",explanation:"x",usedTarget:true})}));await settle();
    expect(mocks.put).not.toHaveBeenCalled();expect(container.textContent).toContain("这组练习已删除");expect(rows.get(ns)![0].deleted).toBe(true);
  });
  it("沉浸云转写先通过语种守卫，再读取原录音并保存结果",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);await mount();await click("转成文字");
    expect(mocks.route).toHaveBeenCalledWith("asr",{asrLang:"en_us"});
    expect(mocks.invoke).toHaveBeenCalledWith("learning_audio",{action:"read",clipId:"clip-1",expectedNamespace:"account-a"});
    expect(mocks.asr).toHaveBeenCalledWith("en_us","AAAAgP9/");expect(mocks.xfyunAsr).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Cloud transcription");
    const saved=(rows.get(ns)![0].payload as {task:{draft:string;attempts:{clipId:string;text:string}[]}}).task;
    expect(saved.draft).toBe("Cloud transcription");expect(saved.attempts[0].clipId).toBe("clip-1");
  });
  it.each([
    ["capability_missing","沉浸云跟读打分暂未开放"],
    ["ise_turned_off","跟读打分已在设置里关闭"],
    ["quota_exhausted","本月评分额度已用完"],
  ])("跟读守卫 %s 时不读取或上传录音",async(reason,hint)=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);mocks.route.mockResolvedValue({engine:"off",reason,hint});
    await mount();await click("真实发音评测");
    expect(mocks.route).toHaveBeenCalledWith("ise",undefined);expect(container.textContent).toContain(hint);expect(container.textContent).toContain("原录音已保留");
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="learning_audio")).toHaveLength(0);
    expect(mocks.ise).not.toHaveBeenCalled();expect(mocks.xfyunIse).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
  });
  it("讯飞转写复用保存的PCM和凭据，游客无需登录沉浸云",async()=>{
    rows.set(ns,[recordedEntity()]);mocks.route.mockResolvedValue({engine:"xfyun",reason:null,hint:null});await mount();await click("转成文字");
    expect(mocks.xfyunAsr).toHaveBeenCalledWith(new Float32Array([0,-1,32767/32768]),"en_us",{appId:"app",apiKey:"key",apiSecret:"secret"});
    expect(mocks.asr).not.toHaveBeenCalled();expect(mocks.login).not.toHaveBeenCalled();expect(container.textContent).toContain("Xfyun transcription");
    expect(mocks.put.mock.calls[0]?.[2]).toBe("guest");
  });
  it("讯飞评测使用录音冻结的参考原句，保留原录音引用",async()=>{
    rows.set(ns,[recordedEntity()]);mocks.route.mockResolvedValue({engine:"xfyun",reason:null,hint:null});await mount();await click("真实发音评测");
    expect(mocks.xfyunIse).toHaveBeenCalledWith(new Float32Array([0,-1,32767/32768]),"Hello from the phone",{appId:"app",apiKey:"key",apiSecret:"secret"});
    expect(mocks.ise).not.toHaveBeenCalled();expect(mocks.login).not.toHaveBeenCalled();
    const saved=(rows.get(ns)![0].payload as {task:{attempts:{clipId:string;pronunciation:{total:number}}[]}}).task;
    expect(saved.attempts[0].clipId).toBe("clip-1");expect(saved.attempts[0].pronunciation.total).toBe(4);
  });
  it("讯飞凭据缺失时在读取录音前提示设置入口",async()=>{
    rows.set(ns,[recordedEntity()]);mocks.route.mockResolvedValue({engine:"xfyun",reason:null,hint:null});mocks.asrCreds.mockResolvedValue(null);
    await mount();await click("转成文字");
    expect(container.textContent).toContain("未配置讯飞听写凭据");expect(container.textContent).toContain("原录音已保留");
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="learning_audio")).toHaveLength(0);expect(mocks.asr).not.toHaveBeenCalled();expect(mocks.xfyunAsr).not.toHaveBeenCalled();
  });
  it("云语音未登录时不读取录音，登录后重新守卫并恢复操作",async()=>{
    rows.set(ns,[recordedEntity()]);await mount();await click("转成文字");
    expect(mocks.login).toHaveBeenCalledTimes(1);expect(mocks.invoke.mock.calls.filter(([command])=>command==="learning_audio")).toHaveLength(0);
    rows.set("account-a",structuredClone(rows.get("guest")!));ns="account-a";loggedIn=true;
    await act(async()=>listener({loggedIn:true,user:{id:"a",email:"a@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null}));await settle();
    expect(mocks.asr).toHaveBeenCalledTimes(1);expect(mocks.put.mock.calls[0]?.[2]).toBe("account-a");expect(container.textContent).toContain("Cloud transcription");
  });
  it.each(["转成文字","真实发音评测"])("Rust仍显示已登录但语音鉴权失效时，%s不会递归重试",async(action)=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);
    mocks.route.mockResolvedValue({engine:"off",reason:"not_logged_in",hint:"登录已失效，请重新登录"});
    await mount();await click(action);await settle();
    expect(mocks.route).toHaveBeenCalledTimes(1);expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("登录已失效，请重新登录");expect(container.textContent).toContain("原录音已保存在本机");
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="learning_audio")).toHaveLength(0);
    expect(mocks.asr).not.toHaveBeenCalled();expect(mocks.ise).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
  });
  it("重新登录同一账号后只恢复一次等待的语音操作",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);
    mocks.route.mockResolvedValue({engine:"off",reason:"not_logged_in",hint:"登录已失效，请重新登录"});
    await mount();await click("转成文字");expect(mocks.asr).not.toHaveBeenCalled();
    mocks.route.mockResolvedValue({engine:"gateway",reason:null,hint:null});
    const status:AuthStatus={loggedIn:true,user:{id:"a",email:"a@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null};
    await act(async()=>listener(status));await settle();
    expect(mocks.route).toHaveBeenCalledTimes(2);expect(mocks.asr).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("Cloud transcription");
    await act(async()=>listener(status));await settle();
    expect(mocks.asr).toHaveBeenCalledTimes(1);expect(mocks.login).toHaveBeenCalledTimes(1);
  });
  it("读取原录音期间换账号不会继续上传录音",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);let resolve!:(value:{pcmB64:string})=>void;
    mocks.invoke.mockImplementation(command=>command==="learning_audio"?new Promise<{pcmB64:string}>(done=>{resolve=done;}):Promise.resolve("windows-device"));
    await mount();await click("转成文字");
    ns="account-b";rows.set(ns,[]);await act(async()=>listener({loggedIn:true,user:{id:"b",email:"b@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null}));await settle();
    await act(async()=>resolve({pcmB64:"AAAAgP9/"}));await settle();
    expect(mocks.asr).not.toHaveBeenCalled();expect(mocks.xfyunAsr).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();expect(rows.get(ns)).toEqual([]);
  });
  it("语音请求在途切账号后丢弃旧响应",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);let resolve!:(value:{text:string;durationMs:number})=>void;
    mocks.asr.mockImplementation(()=>new Promise<{text:string;durationMs:number}>(done=>{resolve=done;}));await mount();await click("转成文字");
    expect(mocks.asr).toHaveBeenCalledTimes(1);
    ns="account-b";rows.set(ns,[]);await act(async()=>listener({loggedIn:true,user:{id:"b",email:"b@example.test",nickname:null,plan:"free",createdAt:"2026-10-30T00:00:00Z"},notice:null}));await settle();
    await act(async()=>resolve({text:"旧账号语音",durationMs:1}));await settle();
    expect(mocks.put).not.toHaveBeenCalled();expect(container.textContent).not.toContain("旧账号语音");expect(rows.get(ns)).toEqual([]);
  });
  it("语音网关错误按公共映射显示，不暴露接口消息",async()=>{
    ns="account-a";loggedIn=true;rows.set(ns,[recordedEntity()]);mocks.asr.mockRejectedValue({code:"quota_exceeded",message:"upstream details"});await mount();await click("转成文字");
    expect(container.textContent).toContain("本月语音额度已用完");expect(container.textContent).not.toContain("upstream details");expect(mocks.put).not.toHaveBeenCalled();
  });
});
