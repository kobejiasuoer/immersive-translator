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
  elapsedMs: number;
}

export type TranslationPhase = "connecting" | "waitingFirstToken" | "streaming" | "done";

export interface StatusEvent {
  phase: TranslationPhase;
  elapsedMs: number;
}

export interface DoneEvent {
  text: string;
  elapsedMs: number;
  /** 连接耗时（请求发出到收到响应头）。 */
  connectMs: number;
  /** 首字耗时（收到响应头到第一个可见文字）。 */
  firstTokenMs: number;
  model: string;
}

export interface ErrorEvent {
  kind: string;
  status: number | null;
  body: string;
  /** 失败时已耗时（毫秒）。 */
  elapsedMs: number;
}

/** 读取当前选中文本（模拟 Ctrl+C）。 */
export async function readSelection(): Promise<string> {
  return invoke<string>("read_selection");
}

/** 打开设置窗口。 */
export async function openSettings(): Promise<void> {
  await invoke("open_settings");
}

/** 打开历史记录窗口。 */
export async function openHistory(): Promise<void> {
  await invoke("open_history");
}

/** 进入截图 OCR 模式（显示框选覆盖层）。 */
export async function openOcrOverlay(): Promise<void> {
  await invoke("open_ocr_overlay");
}

/** 显示 OCR 结果浮窗并触发翻译。 */
export async function showOcrResult(text: string): Promise<void> {
  await invoke("show_ocr_result", { text });
}

export type PanelSource = "selection" | "ocr";

export interface PanelPayload {
  text: string;
  source: PanelSource;
}

/** 读取后端暂存的待翻译文本，避免窗口首次加载时事件早于监听注册。 */
export async function takePendingPanelPayload(): Promise<PanelPayload | null> {
  return invoke<PanelPayload | null>("take_pending_panel_payload");
}

/** 事件已送达时清掉后端暂存文本，避免窗口重载后重复翻译。 */
export async function clearPendingPanelPayload(): Promise<void> {
  await invoke("clear_pending_panel_payload");
}

// ---- OCR 模型管理 ----

/** 检查 OCR 模型是否就绪（det + rec 存在）。 */
export async function ocrModelsReady(): Promise<boolean> {
  return invoke<boolean>("ocr_models_ready");
}

/** 下载 OCR 模型（det + rec）。 */
export async function ocrDownloadModels(): Promise<void> {
  await invoke("ocr_download_models");
}

/** 模型下载进度事件。 */
export interface DownloadProgress {
  file: string;
  status: "downloading" | "done" | "exists" | "complete";
  downloaded?: number;
  total?: number;
}

export function onDownloadProgress(
  handler: (e: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("ocr:download:progress", (event) =>
    handler(event.payload),
  );
}

/**
 * 运行时切换全局热键。注销旧键、注册新键、持久化到 hotkey.txt。
 * 返回规范化后的热键字符串；注册失败会 reject（含原因）。
 */
export async function reregisterHotkey(hotkey: string): Promise<string> {
  return invoke<string>("reregister_hotkey", { hotkey });
}

/** 返回后端当前实际注册并持久化的全局热键。 */
export async function getActiveHotkey(): Promise<string> {
  return invoke<string>("get_active_hotkey");
}

// ---- 连通性测试 ----

export interface ConnectivityResult {
  ok: boolean;
  status: number | null;
  message: string;
  elapsedMs: number;
}

/** 用 1-token 最小请求探测接口可用性。 */
export async function testConnectivity(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<ConnectivityResult> {
  return invoke<ConnectivityResult>("test_connectivity", { endpoint, apiKey, model });
}

// ---- 取消翻译 ----

/** 取消当前正在进行的流式翻译。 */
export async function cancelTranslation(): Promise<void> {
  await invoke("cancel_translation");
}

export interface CancelledEvent {
  partial: string;
  elapsedMs: number;
}

export function onTranslationCancelled(
  handler: (e: CancelledEvent) => void,
): Promise<UnlistenFn> {
  return listen<CancelledEvent>("translation:cancelled", (event) =>
    handler(event.payload),
  );
}

// ---- 安全存储（DPAPI）----
// API Key 经 Rust 端 CryptProtectData 加密后落盘，不进 localStorage 明文。

/** 读取已加密保存的 API Key 明文；不存在返回空串，读取/解密失败会 reject。 */
export async function secretGet(): Promise<string> {
  return invoke<string>("secret_get");
}

/** 加密保存 API Key；传空串会删除条目。 */
export async function secretSet(value: string): Promise<void> {
  await invoke("secret_set", { value });
}

// ---- 翻译历史 ----

export type HistorySource = "selection" | "ocr";

export interface HistoryRecord {
  id: string;
  createdAt: number;
  original: string;
  translation: string;
  targetLanguage: string;
  source: HistorySource;
  isFavorite: boolean;
  model: string;
  elapsedMs: number;
}

export type ExportFormat = "csv" | "json" | "markdown" | "text";

export async function historyAdd(
  original: string,
  translation: string,
  targetLanguage: string,
  source: HistorySource,
  model: string,
  elapsedMs: number,
): Promise<HistoryRecord> {
  return invoke<HistoryRecord>("history_add", {
    original,
    translation,
    targetLanguage,
    source,
    model,
    elapsedMs,
  });
}

export async function historyList(query?: string): Promise<HistoryRecord[]> {
  return invoke<HistoryRecord[]>("history_list", { query: query ?? null });
}

export async function historyToggleFavorite(id: string): Promise<void> {
  await invoke("history_toggle_favorite", { id });
}

export async function historyDelete(id: string): Promise<void> {
  await invoke("history_delete", { id });
}

export async function historyClearNonFavorites(): Promise<number> {
  return invoke<number>("history_clear_non_favorites");
}

export async function historyExport(
  query: string | null,
  favoritesOnly: boolean,
  format: ExportFormat,
): Promise<string> {
  return invoke<string>("history_export", { query, favoritesOnly, format });
}

/** 发起翻译请求。结果通过事件回调返回。 */
export async function translateStream(req: TranslateRequest): Promise<void> {
  await invoke("translate_stream", { req });
}

/** 监听翻译增量。返回取消监听的函数。 */
export function onTranslationDelta(handler: (e: DeltaEvent) => void): Promise<UnlistenFn> {
  return listen<DeltaEvent>("translation:delta", (event) => handler(event.payload));
}

export function onTranslationStatus(
  handler: (e: StatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<StatusEvent>("translation:status", (event) => handler(event.payload));
}

export function onTranslationDone(handler: (e: DoneEvent) => void): Promise<UnlistenFn> {
  return listen<DoneEvent>("translation:done", (event) => handler(event.payload));
}

export function onTranslationError(handler: (e: ErrorEvent) => void): Promise<UnlistenFn> {
  return listen<ErrorEvent>("translation:error", (event) => handler(event.payload));
}
