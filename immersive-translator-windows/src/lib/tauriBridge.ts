import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TranslateRequest {
  text: string;
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  stream: boolean;
  windowLabel: string;
}

export interface DeltaEvent {
  text: string;
  elapsed_ms: number;
}

export interface DoneEvent {
  text: string;
  elapsed_ms: number;
  model: string;
}

export interface ErrorEvent {
  kind: string;
  status: number | null;
  body: string;
}

/** 读取当前选中文本（模拟 Ctrl+C）。 */
export async function readSelection(): Promise<string> {
  return invoke<string>("read_selection");
}

/** 打开设置窗口。 */
export async function openSettings(): Promise<void> {
  await invoke("open_settings");
}

/** 发起翻译请求。结果通过事件回调返回。 */
export async function translateStream(req: TranslateRequest): Promise<void> {
  await invoke("translate_stream", { req });
}

/** 监听翻译增量。返回取消监听的函数。 */
export function onTranslationDelta(handler: (e: DeltaEvent) => void): Promise<UnlistenFn> {
  return listen<DeltaEvent>("translation:delta", (event) => handler(event.payload));
}

export function onTranslationDone(handler: (e: DoneEvent) => void): Promise<UnlistenFn> {
  return listen<DoneEvent>("translation:done", (event) => handler(event.payload));
}

export function onTranslationError(handler: (e: ErrorEvent) => void): Promise<UnlistenFn> {
  return listen<ErrorEvent>("translation:error", (event) => handler(event.payload));
}
