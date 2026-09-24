/**
 * 最小本地埋点（UX-6）：事件追加到 app_data/logs/reader-events.jsonl，纯本地无网络。
 * 只埋方案 §8 的最小事件集（book_import_attempt / book_import_result / book_open /
 * chapter_complete / reading_minutes / reminder_continue_click / epub_import_intent）。
 * 埋点永远不抛错、不打断主流程。
 */

import { invoke } from "@tauri-apps/api/core";

export function trackEvent(name: string, props: Record<string, unknown> = {}): void {
  try {
    void invoke("telemetry_log_event", { name, props: props ?? {} }).catch(() => undefined);
  } catch {
    /* 埋点不可用不影响主流程 */
  }
}
