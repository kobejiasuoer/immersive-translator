/**
 * 云端埋点（Phase 0 任务 1；docs/product-upgrade-plan-2026-10-22.md §8）。
 *
 * 契约：POST /v1/events，Bearer 会话 token，body { event, properties, ts(毫秒) }，
 * 成功 2xx。会话 token 永不跨 IPC（windows-auth 设计 D4/D5），请求经 Rust 命令
 * auth_track_event 发出（见 tauriBridge.authTrackEvent）；ts 由 Rust 发送时打上，
 * 不依赖客户端时钟。
 *
 * 静默契约（Phase 0）：未登录（Rust 回 unauthorized）、请求失败、白名单外事件
 * 一律静默吞掉，绝不影响 UI 主流程；不重试、不排队。
 * 与 lib/telemetry.ts 的本地 JSONL 埋点（UX-6，纯本地无网络）并存，互不替代。
 */

import { authTrackEvent } from "./tauriBridge";

/** 场景来源：builtin=内置场景；official=官方场景库；user=用户自建（A 阶段引入）。 */
export type ScenarioSource = "builtin" | "official" | "user";

/**
 * Phase 0 事件白名单（与服务端校验一致；properties 整体 JSON 存储，
 * 不为单个事件建列）。scenario_create / scenario_generate_result /
 * discover_view / discover_import 对应的 UI 尚不存在，仅定义类型不埋点。
 */
export interface AnalyticsEventProps {
  /** 口语陪练：开始一场会话。 */
  speak_session_start: { scenarioId: string; scenarioSource: ScenarioSource };
  /** 口语陪练：结束一场会话。turns=会话 turns 数组长度。 */
  speak_session_end: { scenarioId: string; turns: number; durationSeconds: number };
  /** 场景中心：创建自定义场景（A 阶段 UI）。 */
  scenario_create: { via: "generate" | "manual" };
  /** 场景中心：一句话生成结果（A 阶段 UI）。 */
  scenario_generate_result: { ok: boolean; parseError?: string };
  /** 阅读市场：发现页曝光（B 阶段 UI）。 */
  discover_view: Record<string, never>;
  /** 阅读市场：从发现页导入书（B 阶段 UI）。 */
  discover_import: { bookId: string };
  /** 阅读室：打开书的一章。 */
  book_open: { bookId: string; chapterIdx?: number };
}

export type AnalyticsEventName = keyof AnalyticsEventProps;

const EVENT_NAMES = new Set<string>(
  [
    "speak_session_start",
    "speak_session_end",
    "scenario_create",
    "scenario_generate_result",
    "discover_view",
    "discover_import",
    "book_open",
  ] satisfies AnalyticsEventName[],
);

/** 运行时白名单判定（类型之外的双保险；未知事件直接丢弃不发）。 */
export function isAnalyticsEventName(name: string): name is AnalyticsEventName {
  return EVENT_NAMES.has(name);
}

/**
 * 上报一条事件（fire-and-forget）：白名单外事件不发；未登录 / 网络失败等
 * 一切错误静默吞掉，不重试不排队。发送结果调用方无从感知（也不应感知）。
 */
export function track<K extends AnalyticsEventName>(
  event: K,
  props: AnalyticsEventProps[K],
): void {
  try {
    if (!isAnalyticsEventName(event)) return;
    void authTrackEvent(event, props as Record<string, unknown>).catch(() => undefined);
  } catch {
    /* 埋点不可用不影响主流程 */
  }
}
