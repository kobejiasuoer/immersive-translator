// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PracticeRelayList, PracticeRelayView } from "./PracticeRelayView";
import type { AuthStatus, StoredSyncEntity } from "../lib/tauriBridge";

const mocks=vi.hoisted(()=>({invoke:vi.fn(),authGetStatus:vi.fn(),learningNamespace:vi.fn(),listen:vi.fn(),login:vi.fn(),list:vi.fn(),put:vi.fn(),sync:vi.fn(),syncStrict:vi.fn(),mic:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("../lib/tauriBridge",()=>({authGetStatus:mocks.authGetStatus,learningNamespace:mocks.learningNamespace,listenAuthStateChanged:mocks.listen,openLoginWindow:mocks.login,syncStoreList:mocks.list,syncStorePut:mocks.put}));
vi.mock("../lib/learningRelay",()=>({syncLearningRecordsSilently:mocks.sync,syncLearningRecords:mocks.syncStrict}));
vi.mock("../core/micRecorder",()=>({startMicRecorder:mocks.mic}));
vi.mock("../lib/voice",()=>({evaluatePronunciation:vi.fn(),pcm16kToBase64:vi.fn(),transcribeBatch:vi.fn()}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

let ns:string,loggedIn:boolean,listener:(status:AuthStatus)=>void,rows:Map<string,StoredSyncEntity[]>,container:HTMLDivElement,root:Root;
const task={id:"task-1",mode:"follow",title:"手机保存的练习",reference:"Hello from the phone",steps:["Hello from the phone","Next sentence"],step:0,attempts:[{id:"attempt-1",step:0,text:"Hello from Windows",deviceId:"phone",status:"draft",createdAt:1,reference:"Hello from the phone"}],draft:"",status:"active",createdAt:1,updatedAt:2};
function entity():StoredSyncEntity{return {id:task.id,baseVersion:3,updatedAt:2,deleted:false,schemaVersion:2,dirty:false,payload:{v:2,id:task.id,kind:"practice-task",scenario:"practice",difficulty:"medium",turns:[],startedAt:1,endedAt:2,task:structuredClone(task)}};}
async function settle(){await act(async()=>{for(let i=0;i<12;i++)await Promise.resolve();});}
async function click(text:string){const button=[...container.querySelectorAll("button")].find(item=>item.textContent?.includes(text));expect(button).toBeDefined();await act(async()=>button!.click());await settle();}
async function mountHub(){await act(async()=>root.render(<PracticeRelayList onToast={()=>undefined}/>));await settle();}
async function mount(translate=vi.fn().mockResolvedValue({status:"done",text:JSON.stringify({message:"语义清楚",improved:"Hello from Windows.",explanation:"保留原意",usedTarget:true})})){await act(async()=>root.render(<><PracticeRelayList onToast={()=>undefined}/><PracticeRelayView requestTranslate={translate} speakEn={async()=>1} onToast={()=>undefined}/></>));await settle();await click(task.title);return translate;}
beforeEach(()=>{vi.clearAllMocks();ns="guest";loggedIn=false;rows=new Map([["guest",[entity()]]]);mocks.invoke.mockResolvedValue("windows-device");mocks.authGetStatus.mockImplementation(async()=>({loggedIn,user:loggedIn?{id:"a"}:null,notice:null}));mocks.learningNamespace.mockImplementation(async()=>ns);mocks.listen.mockImplementation(async(fn)=>{listener=fn;return()=>undefined;});mocks.list.mockImplementation(async(_collection,expected)=>{if(expected&&expected!==ns)throw new Error("账号已切换");return structuredClone(rows.get(ns)??[]);});mocks.put.mockImplementation(async(_collection,entities,expected)=>{if(expected!==ns)throw new Error("账号已切换");rows.set(ns,structuredClone(entities));});mocks.sync.mockResolvedValue([]);mocks.syncStrict.mockResolvedValue([{ok:true,pulled:1,appliedRemote:1,keptLocal:0,pushed:0,conflicts:0,skipped:[],error:null}]);mocks.login.mockResolvedValue(undefined);container=document.createElement("div");document.body.append(container);root=createRoot(container);});
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
});
