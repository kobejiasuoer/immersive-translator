import { invoke } from "@tauri-apps/api/core";
import { authGetStatus, authFetchServerConfig, learningNamespace } from "./tauriBridge";
import { syncNow, type SyncSummary } from "./syncEngine";
let running:Promise<SyncSummary[]>|null=null;
/** All learning writers already place their edits in the durable, account-scoped outbox. */
export function syncLearningRecordsSilently():Promise<SyncSummary[]>{
  return syncLearningRecords().catch(error=>{console.error("[learning-sync]",error);return [];});
}
/** User-triggered sync keeps failures visible to the calling surface. */
export function syncLearningRecords():Promise<SyncSummary[]>{
  if(running)return running;
  running=(async()=>{
    const status=await authGetStatus();if(!status.loggedIn)throw new Error("登录后才能同步学习资料");
    const namespace=await learningNamespace();
    const config=await authFetchServerConfig() as {sync?:{protocolVersion?:number;collections?:Record<string,{schemaVersions:number[];maxEntityBytes:number}>;maxPushEntities:number;maxPullLimit:number;maxBodyBytes:number}};
    if(config.sync?.protocolVersion!==2)throw new Error("服务端尚不支持学习接力协议 v2，请升级后同步");
    if(namespace!==await learningNamespace())throw new Error("账号已切换，同步已取消");
    await invoke("learning_migrate",{expectedNamespace:namespace});
    const results:SyncSummary[]=[];
    for(const collection of ["reading-articles","reading-vocab","notes","review-events","speak-scenarios","speak-sessions","speak-assessments"]){
      if(!config.sync.collections?.[collection]?.schemaVersions.includes(2))continue;
      if(namespace!==await learningNamespace())throw new Error("账号已切换，同步已取消");
      results.push(await syncNow(collection,{namespace,...config.sync,...config.sync.collections[collection]}));
    }
    window.dispatchEvent(new CustomEvent("learning-sync-complete",{detail:results}));return results;
  })().finally(()=>{running=null;});return running;
}
