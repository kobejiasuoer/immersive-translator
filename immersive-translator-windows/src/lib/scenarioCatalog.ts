/**
 * 场景目录装载器（升级计划 A1 §2.1/§2.2）：启动装载 + 拉取官方目录。
 *
 * - preloadScenarioCatalog：单飞 promise 缓存（照 core/pdfjsLoader.ts 模式），
 *   官方缓存（scenario_cache_read）+ 本地用户场景（A0 sync_store_list
 *   "speak-scenarios"）→ speakLogic 内存注册表。任一来源失败只清空本桶
 *   （=只剩内置 4 场景），promise 永不 reject。
 * - refreshOfficialScenarioCatalog：单飞；每次进入口语 tab 都拉一次
 *   GET /v1/scenarios（管理后台上下架/改版后重进 tab 即可见，端点匿名 +
 *   服务端 per-IP 限流兜底）→ 校验 → 有更新才写缓存并重装载。离线、
 *   首启、接口失败、垃圾 body 全路径静默降级，绝不影响 UI 主流程。
 */

import {
  isSpeakScenarioLike,
  registerOfficialScenarios,
  registerUserScenarios,
  type SpeakScenario,
} from "../core/speakLogic";
import {
  scenarioCacheRead,
  scenarioCacheWrite,
  scenarioFetchOfficial,
  syncStoreList,
} from "./tauriBridge";

/** 用户场景所在的同步集合（A0 syncEngine 已登记，与云端目录对齐）。
 *  A2 起导出：场景编辑器保存/读回 baseVersion 共用，杜绝字面量漂移。 */
export const USER_SCENARIO_COLLECTION = "speak-scenarios";

/** 官方目录来源三态（catalogBadge）。不变式：fallback ⟺ 官方桶为空（只剩内置场景）。
 *  server=refresh 2xx 且装载进非空官方桶（2xx 但内容==缓存也算 server/已同步）；
 *  cache=preload 命中非空本地缓存、尚无成功 refresh；fallback=官方桶空。 */
export type OfficialCatalogSource = "server" | "cache" | "fallback";
export const OFFICIAL_CATALOG_BADGE: Record<OfficialCatalogSource, string> = {
  server: "云端目录·已同步",
  cache: "云端目录·本地缓存",
  fallback: "内置场景",
};
let officialSource: OfficialCatalogSource = "fallback";
/** 当前官方目录来源（纯读取；SpeakView 渲染时随 setExtraLists 的重渲染读到最新值）。 */
export function officialCatalogSource(): OfficialCatalogSource {
  return officialSource;
}

/** preload 单飞缓存（once 语义：装载失败也只发生一次，之后保持空注册表）。 */
let preloadPromise: Promise<void> | null = null;
/** refresh 单飞（in-flight 期并发调用共享同一次请求）。 */
let refreshInFlight: Promise<void> | null = null;
/** 已装载的官方目录（过滤后 JSON 串；「有更新才替换缓存」的比较基准）。 */
let loadedOfficialJson = "";

/** 启动装载（只跑一次）：官方缓存 + 同步的用户场景 → 注册表。各来源独立
 *  降级（catch→空列表），promise 永不 reject——装载失败=注册表空=只剩内置。 */
async function loadScenarioCatalogOnce(): Promise<void> {
  // 官方目录缓存（空数组=无缓存；未知形状逐项被 isSpeakScenarioLike 过滤）
  const cached: unknown[] = await scenarioCacheRead().catch(() => []);
  const official = cached.filter(isSpeakScenarioLike);
  registerOfficialScenarios(official);
  loadedOfficialJson = JSON.stringify(official);
  // 缓存读失败被 catch 成 [] → 官方桶空 → fallback（三态不变式）。
  officialSource = official.length > 0 ? "cache" : "fallback";
  // 本地用户场景（A0 同步实体；tombstone 跳过）
  const stored = await syncStoreList(USER_SCENARIO_COLLECTION).catch(() => []);
  const user = stored
    .filter((e) => !e.deleted && isSpeakScenarioLike(e.payload))
    .map((e) => e.payload as SpeakScenario);
  registerUserScenarios(user);
}

/** 启动装载场景目录（SpeakView 挂载时触发；单飞、全静默、永不 reject）。 */
export function preloadScenarioCatalog(): Promise<void> {
  if (!preloadPromise) {
    preloadPromise = loadScenarioCatalogOnce().catch(() => undefined);
  }
  return preloadPromise;
}

/** 解析拉取应答 body：兼容 { scenarios: [...] } 包装与裸数组两种服务端形状；
 *  非法 JSON / 无数组字段返回 null（垃圾 body 不写盘）。 */
function parseOfficialScenariosBody(body: string): SpeakScenario[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { scenarios?: unknown } | null)?.scenarios;
  if (!Array.isArray(list)) return null;
  return list.filter(isSpeakScenarioLike);
}

/**
 * 拉取官方目录（单飞）：先复用 preload 单飞保证缓存已装载，再拉
 * GET /v1/scenarios；2xx 且过滤后内容有变化才写缓存并重装载注册表。
 * 每次进入口语 tab 都调用（无节流：旧节流导致管理后台下架后客户端最长
 * 15 分钟 + 当次会话内持续可见旧目录）；in-flight 期并发调用共享同一次
 * 请求。404（端点未上线）/ 断网 / 未登录 / 垃圾 body 全静默，永不 reject。
 */
export function refreshOfficialScenarioCatalog(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      await preloadScenarioCatalog();
      const res = await scenarioFetchOfficial();
      if (res.status >= 200 && res.status < 300) {
        const list = parseOfficialScenariosBody(res.body);
        if (list) {
          // 2xx 即视为已与云端同步（内容==缓存也算 server）；2xx 但目录为空 →
          // 桶空 → fallback（不变式保持）。404/断网/reject 不改状态（保留 cache）。
          officialSource = list.length > 0 ? "server" : "fallback";
          const json = JSON.stringify(list);
          if (json !== loadedOfficialJson) {
            await scenarioCacheWrite(json).catch(() => undefined);
            registerOfficialScenarios(list);
            loadedOfficialJson = json;
          }
        }
      }
    } catch {
      /* 断网/未登录（fetch reject）：静默，保留已装载的缓存结果 */
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
