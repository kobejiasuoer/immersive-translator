/**
 * 语音设置同源中枢（voiceSettingsHub，设计 docs/voice-settings-merge-plan-2026-11-11.md §5.3）。
 *
 * 两个语音设置入口分属两个 Tauri WebView（settings / reader，同 origin 共享 localStorage），
 * 此前「单写点」数据已同源，缺的只是跨窗口通知：B（设置中心·语音页）改完没有任何广播，
 * A（阅读室）界面停留在挂载快照。hub 三职责：
 *
 * 1. 写 API：writeVoicePrefs（L0 语音页偏好，包 saveVoicePrefs + 广播；Settings.applyVoicePrefs
 *    是唯一业务调用点）、writeReaderVoice（L1 阅读默认层全局键写 + 广播，为 QuickReviewApp
 *    等第三消费者预留，P1 不接线）。
 * 2. 订阅 API：listenVoicePrefsChanged，事件 voice:prefs-changed。
 * 3. 派生投影：effectiveShadowAssess / currentVoiceChain，复用 resolveVoiceRoute 既有归约
 *    （其内部已复用 resolveInitialVoiceProvider，归约单点存在，这里不重复实现）。
 *
 * 事件协议（跨端共同契约，P3 落 docs 决策文档）：
 * - payload 只带 { scopes, from, rev }，不带值——回执方一律重读存储，防事件与存储竞态；
 * - from === 当前窗口 label 则忽略回声（Tauri emit 广播含发送窗自身）；
 * - rev 为发送方单调递增计数，回执方按 from 维护已见最大值，rev ≤ 已见值的视为乱序旧事件；
 * - 新增语音字段必须进 hub 写 API + 登记VoiceSettingsScope，漏了就复现不同步（以 hub
 *   单文件 + 约定缓解）。
 *
 * 边界（mustFix-7）：凭据同步不另造轮子，继续走既有 xfyun:creds-updated
 * （emit 点 XfyunVoiceSection.tsx，消费点 ReaderApp/VoiceSettingsTab/XfyunVoiceSection），
 * hub 不重复封装。回执侧收到事件后重读存储（mustFix-2 的前提由「payload 不带值」保证），
 * 监听器生命周期照仓内 active + unlisten 模式（XfyunVoiceSection.tsx:207-228 先例），
 * 由消费方在 effect cleanup 里 unlisten（P2 接线）。
 */

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings, saveVoicePrefs, type VoicePrefsPatch } from "./settingsStore";
import {
  loadGlobalReaderSettings,
  saveGlobalReaderSettings,
} from "../reader/readerSettingsStore";
import type { ReaderSettings } from "../core/readerTypes";
import { resolveVoiceRoute, type VoiceRouteDecision } from "./voice/voiceRoute";
import { readerEdgeFallbackNotice } from "../reader/readerSpeechRoute";
import { xfyunTtsCredsConfigured } from "./iseCredentials";

// ---- 事件协议 ----

export const VOICE_PREFS_CHANGED_EVENT = "voice:prefs-changed";

/** 变更范围登记表：新增语音字段必须进对应写 API + 登记这里（§5.3 约定）。
 *  - voicePrefs：L0 语音页偏好（immersive-translator-settings 的 voiceProvider /
 *    voiceGatewayVoice / voiceGatewayIseEnabled，settingsStore.VoicePrefsPatch）；
 *  - readerVoice：L1 阅读默认层全局键（immersive-translator-reader-settings）。 */
export type VoiceSettingsScope = "voicePrefs" | "readerVoice";

/** voice:prefs-changed 的 payload：只有元信息，不带值（回执方一律重读存储）。 */
export interface VoicePrefsChangedPayload {
  scopes: VoiceSettingsScope[];
  /** 发送方窗口 label（settings / reader / quick-review…），回执方据此忽略回声。 */
  from: string;
  /** 发送方单调递增计数，回执方按 from 维护已见最大值，防乱序。 */
  rev: number;
}

/** 当前窗口 label；非 Tauri 环境（单测 / 纯浏览器预览）返回空串。 */
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

let revCounter = 0;

/** 落盘后广播（模块私有：写变更只能走 writeVoicePrefs / writeReaderVoice，
 *  不给绕过写 API 的裸广播口）。emit 失败（非 Tauri 环境）静默忽略，
 *  与 XfyunVoiceSection.tsx:268 的容错口径一致。 */
function broadcast(scopes: VoiceSettingsScope[]): void {
  revCounter += 1;
  const payload: VoicePrefsChangedPayload = {
    scopes,
    from: currentWindowLabel(),
    rev: revCounter,
  };
  void emit(VOICE_PREFS_CHANGED_EVENT, payload).catch(() => undefined);
}

// ---- 写 API ----

/** B→A 主方向写 API：设置中心语音页唯一写点的包装（saveVoicePrefs 点卡即写盘、
 *  只合并语音偏好字段、不触碰其余设置）+ 落盘后广播。不改变既有写语义，只补通知。 */
export function writeVoicePrefs(patch: VoicePrefsPatch): void {
  saveVoicePrefs(patch);
  broadcast(["voicePrefs"]);
}

/** L1 全局层写 API（为 QuickReviewApp 等第三消费者预留，P1 不接线）：
 *  读-合并-整包写 immersive-translator-reader-settings 全局键 + 广播。
 *  丢更新边界：saveGlobalReaderSettings 是整包写，两个 WebView 同键并发写存在
 *  丢更新窗口（设计 §4 弃方案二的理由）——本 API 只给阅读室之外的第三窗低频偏好用；
 *  阅读室抽屉继续走 ReaderApp 既有「全局 + 文章覆盖」双写路径，不经此 API。 */
export function writeReaderVoice(patch: Partial<ReaderSettings>): void {
  saveGlobalReaderSettings({ ...loadGlobalReaderSettings(), ...patch });
  broadcast(["readerVoice"]);
}

// ---- 订阅 API ----

export interface VoicePrefsChangedOptions {
  /** 只回执这些 scope（任一命中即回执）；不传 = 全部回执。 */
  scopes?: VoiceSettingsScope[];
}

/** 订阅语音偏好变更。已内置回声抑制与乱序过滤；scope 过滤在协议层完成，
 *  回执方仍须自行重读存储取值（payload 不带值）。返回 unlisten，消费方照
 *  active + unlisten 模式管理生命周期（XfyunVoiceSection.tsx:207-228 先例）。 */
export async function listenVoicePrefsChanged(
  handler: (payload: VoicePrefsChangedPayload) => void,
  opts?: VoicePrefsChangedOptions,
): Promise<() => void> {
  const self = currentWindowLabel();
  const lastRevByFrom = new Map<string, number>();
  const unlisten = await listen<VoicePrefsChangedPayload>(
    VOICE_PREFS_CHANGED_EVENT,
    (event) => {
      const payload = event.payload as VoicePrefsChangedPayload | undefined;
      if (!payload || typeof payload !== "object") return;
      // 协议完整性：缺 from/rev/scopes 或类型不符的畸形事件一律忽略（保守不回执）。
      if (
        typeof payload.from !== "string" ||
        typeof payload.rev !== "number" ||
        !Number.isFinite(payload.rev) ||
        !Array.isArray(payload.scopes)
      ) {
        return;
      }
      // 回声抑制：自己发的广播不回执（改了界面的窗自己重渲染即可）。
      if (payload.from === self) return;
      // 乱序防护：同一发送方 rev 单调，旧事件/重放直接忽略。
      const seen = lastRevByFrom.get(payload.from);
      if (seen !== undefined && payload.rev <= seen) return;
      lastRevByFrom.set(payload.from, payload.rev);
      if (opts?.scopes) {
        const wanted = opts.scopes;
        if (!payload.scopes?.some((s) => wanted.includes(s))) return;
      }
      handler(payload);
    },
  );
  return unlisten;
}

// ---- 派生投影 ----
// 纯归约（fold*）与异步取数（effective*/current*）分开：归约穷举单测，取数侧薄包装
// （与 voiceRoute.ts「纯归约 reduceVoiceRoute / 异步取数 resolveVoiceRoute」同构）。

/** 打分链断环归因：按 chips 顺序 跟读模式 → 跟读评测 → 评分开关（设置中心）→ 服务端，
 *  取第一条断环。 */
export type ShadowAssessBroken = "mode" | "assess" | "settings" | "server";

/** 打分链各环通断：断环 false、通 true、不适用/未评估 null（讯飞直连不经过评分开关
 *  与服务端守卫；上游断环时下游不再评估）。打分链 chips 按此渲染，断环显红 ✗
 *  （§5.2 A-3）。 */
export interface ShadowAssessLinks {
  mode: boolean;
  assess: boolean | null;
  settings: boolean | null;
  server: boolean | null;
}

export interface ShadowAssessProjection {
  /** AND 链全通：会真正送评分。 */
  effective: boolean;
  /** 第一条断环；null = 全通。提示行断言用 broken === "settings"（恰为 §5.2 A-3 的
   *  「抽屉两开关均开 + 沉浸云链路 + 评分开关关」条件）。 */
  broken: ShadowAssessBroken | null;
  links: ShadowAssessLinks;
}

export interface ShadowAssessFoldInput {
  shadowingMode: boolean;
  shadowingAssess: boolean;
  /** 设置中心评分开关（voiceGatewayIseEnabled）。单独传而不从 decision 反推：
   *  reduceVoiceRoute 里配额先于本地开关归约（voiceRoute.ts:120 → :128），
   *  engine=off 且 reason≠ise_turned_off 时开关也可能是关的。 */
  iseSwitchOn: boolean;
  /** resolveVoiceRoute("ise") 归约结果；null = 未经沉浸云守卫（调用方主动跳过守卫，
   *  如纯本地场景）——此时按讯飞直连同口径：评分开关与服务端两环不适用。 */
  iseRoute: VoiceRouteDecision | null;
}

/** 打分链 AND 链投影（纯归约）：抽屉两环 + 评分开关环 + 服务端环。
 *  讯飞直连（iseRoute 为 null 或 engine=xfyun）不经沉浸云守卫，开关与服务端两环
 *  不适用、不提示（§5.2 A-3：「讯飞直连用户与该开关无关」）。 */
export function foldShadowAssess(input: ShadowAssessFoldInput): ShadowAssessProjection {
  if (!input.shadowingMode) {
    return {
      effective: false,
      broken: "mode",
      links: { mode: false, assess: null, settings: null, server: null },
    };
  }
  if (!input.shadowingAssess) {
    return {
      effective: false,
      broken: "assess",
      links: { mode: true, assess: false, settings: null, server: null },
    };
  }
  if (input.iseRoute === null || input.iseRoute.engine === "xfyun") {
    return {
      effective: true,
      broken: null,
      links: { mode: true, assess: true, settings: null, server: null },
    };
  }
  const settings = input.iseSwitchOn;
  // 服务端环通断：放行 = 通过；ise_turned_off = 归约在本地开关处短路返回
  // （voiceRoute.ts:128），登录/配额已过、能力未查，标「未评估」而不是误报断环；
  // 其余 off 原因都是服务端环本身没过。
  const server =
    input.iseRoute.engine === "gateway"
      ? true
      : input.iseRoute.reason === "ise_turned_off"
        ? null
        : false;
  // chips 顺序取第一条断环：评分开关先于服务端（voiceRoute.ts 的归约顺序与之相反
  // ——配额先于开关——这里按 UI 指引优先级归因，两环都断时提示行指向可操作的一环）。
  const broken: ShadowAssessBroken | null = !settings
    ? "settings"
    : server === false
      ? "server"
      : null;
  return {
    effective: broken === null,
    broken,
    links: { mode: true, assess: true, settings, server },
  };
}

/** 打分链生效投影（异步取数版）：现查沉浸云守卫（ise 能力）+ 现读评分开关，
 *  与播放侧 useShadowAssess 的判定同源。 */
export async function effectiveShadowAssess(opts: {
  shadowingMode: boolean;
  shadowingAssess: boolean;
}): Promise<ShadowAssessProjection> {
  const iseRoute = await resolveVoiceRoute("ise");
  // 与 voiceRoute.ts:227 同一读式：undefined/缺省视为开，显式 false 才算关。
  const iseSwitchOn = loadSettings().voiceGatewayIseEnabled !== false;
  return foldShadowAssess({
    shadowingMode: opts.shadowingMode,
    shadowingAssess: opts.shadowingAssess,
    iseSwitchOn,
    iseRoute,
  });
}

/** 链路行引擎档（§5.2 A-1 五态 + 讯飞缺凭据回落系统语音态）。 */
export type VoiceChainEngine = "edge" | "local" | "cloud-gateway" | "cloud-xfyun";

export interface VoiceChainProjection {
  engine: VoiceChainEngine;
  /** 链路行文案（§5.2 A-1 口径，与 voice.md:35 对齐）。 */
  label: string;
  /** 沉浸云守卫 off 临时回落 Edge 时的回落说明（readerEdgeFallbackNotice 统一口径，
   *  不另写第三份）；其余 null。 */
  fallbackNotice: string | null;
  /** 行内着色（原型 chain-pill 的 ok/warn）：ok = 正常放行档，warn = 回落/降级档。 */
  tone: "ok" | "warn";
}

export type VoiceChainFoldInput =
  | { ttsProvider: "edge" }
  | { ttsProvider: "local" }
  | { ttsProvider: "xfyun"; xfyunTtsReady: boolean }
  | {
      ttsProvider: "cloud";
      /** resolveVoiceRoute("tts") 归约结果。 */
      ttsRoute: VoiceRouteDecision;
      /** 讯飞 TTS 凭据是否齐全（xfyunTtsCredsConfigured）；仅 ttsRoute.engine=xfyun 分支消费。 */
      xfyunTtsReady: boolean;
    };

/** 讯飞直连档：凭据齐全 → 讯飞；缺 TTS 凭据 → 播放回落本地系统语音 SAPI
 *  （readerSpeechRoute.ts:39-41/:45-47 同语义；文案 §5.2 A-1）。 */
function xfyunDirectChain(xfyunTtsReady: boolean): VoiceChainProjection {
  return xfyunTtsReady
    ? {
        engine: "cloud-xfyun",
        label: "云音色 · 讯飞 · 合成凭据已配置 ✓",
        fallbackNotice: null,
        tone: "ok",
      }
    : {
        engine: "local",
        label: "云音色 · 讯飞 · 合成凭据未配置 · 播放回落系统语音",
        fallbackNotice: null,
        tone: "warn",
      };
}

/** 链路行投影（纯归约）。旧 xfyun 档不经过新守卫（readerSpeechRoute.ts:30,39-41）；
 *  cloud 档跟随语音页 voiceProvider，守卫 off 时临时回落 Edge 并带回落决策
 *  （readerSpeechRoute.ts:43-48）。 */
export function foldVoiceChain(input: VoiceChainFoldInput): VoiceChainProjection {
  switch (input.ttsProvider) {
    case "edge":
      return { engine: "edge", label: "Edge 在线 · 免费直连", fallbackNotice: null, tone: "ok" };
    case "local":
      return { engine: "local", label: "系统语音 · 离线可用", fallbackNotice: null, tone: "ok" };
    case "xfyun":
      return xfyunDirectChain(input.xfyunTtsReady);
    case "cloud":
      if (input.ttsRoute.engine === "gateway") {
        return {
          engine: "cloud-gateway",
          label: "云音色 · 沉浸云 · 已登录",
          fallbackNotice: null,
          tone: "ok",
        };
      }
      if (input.ttsRoute.engine === "xfyun") {
        return xfyunDirectChain(input.xfyunTtsReady);
      }
      return {
        engine: "edge",
        label: "Edge 在线 · 免费直连",
        fallbackNotice: readerEdgeFallbackNotice(input.ttsRoute).message,
        tone: "warn",
      };
  }
}

/** 链路行生效投影（异步取数版）：cloud 档现查沉浸云守卫，讯飞档现查 TTS 凭据。
 *  播放侧现读（voiceRoute.ts:206 / readerSpeechRoute.ts:31-49），投影与播放同源。 */
export async function currentVoiceChain(opts: {
  ttsProvider: ReaderSettings["ttsProvider"];
}): Promise<VoiceChainProjection> {
  if (opts.ttsProvider === "edge") return foldVoiceChain({ ttsProvider: "edge" });
  if (opts.ttsProvider === "local") return foldVoiceChain({ ttsProvider: "local" });
  if (opts.ttsProvider === "xfyun") {
    return foldVoiceChain({
      ttsProvider: "xfyun",
      xfyunTtsReady: await xfyunTtsCredsConfigured(),
    });
  }
  const ttsRoute = await resolveVoiceRoute("tts");
  return foldVoiceChain({
    ttsProvider: "cloud",
    ttsRoute,
    xfyunTtsReady: await xfyunTtsCredsConfigured(),
  });
}
