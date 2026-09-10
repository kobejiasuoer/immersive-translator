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
  /** 请求标识，随事件原样回传；面板据此丢弃过期请求的事件。 */
  tag: string;
}

export interface DeltaEvent {
  text: string;
  elapsedMs: number;
  tag: string;
}

export type TranslationPhase = "connecting" | "waitingFirstToken" | "streaming" | "done";

export interface StatusEvent {
  phase: TranslationPhase;
  elapsedMs: number;
  tag: string;
}

export interface DoneEvent {
  text: string;
  elapsedMs: number;
  /** 连接耗时（请求发出到收到响应头）。 */
  connectMs: number;
  /** 首字耗时（收到响应头到第一个可见文字）。 */
  firstTokenMs: number;
  model: string;
  tag: string;
}

export interface ErrorEvent {
  kind: string;
  status: number | null;
  body: string;
  /** 失败时已耗时（毫秒）。 */
  elapsedMs: number;
  tag: string;
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

export type PanelSource = "selection" | "ocr" | "error" | "awaitCopy";

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

// ---- 阅读室热键导入 ----

export interface ReaderImportPayload {
  text: string;
  nonce: string;
}

/** 阅读室窗口挂载时取走热键送来的待导入文本（与 takePendingPanelPayload 同模式）。 */
export async function takePendingReaderImport(): Promise<ReaderImportPayload | null> {
  return invoke<ReaderImportPayload | null>("take_pending_reader_import");
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
 * 运行时切换全局热键（翻译 / 截图 OCR / 阅读室三键，两两互斥）。
 * 可回滚：任一注册失败会 reject（含原因），旧键保持生效。
 */
export async function reregisterHotkeys(
  translateHotkey: string,
  ocrHotkey: string,
  readerHotkey: string,
): Promise<string> {
  return invoke<string>("reregister_hotkeys", { translateHotkey, ocrHotkey, readerHotkey });
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
  tag: string;
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

// ---- 朗读（TTS，Windows SAPI）----

/**
 * 朗读一段文本。chinese 决定后端优先选中文声音还是非中文声音。
 * 返回本次朗读的代数：onTtsEnded 只应处理与最新代数匹配的事件。
 */
export async function ttsSpeak(text: string, chinese: boolean): Promise<number> {
  return invoke<number>("tts_speak", { text, chinese });
}

/** 停止当前朗读。 */
export async function ttsStop(): Promise<void> {
  await invoke("tts_stop");
}

export interface TtsEndedEvent {
  gen: number;
  track?: string;
}

/** 朗读结束（自然播完或被打断）。gen 用于丢弃过期那次的结束事件。 */
export function onTtsEnded(handler: (e: TtsEndedEvent) => void): Promise<UnlistenFn> {
  return listen<TtsEndedEvent>("tts:ended", (event) => handler(event.payload));
}

// ---- 朗读扩展（沉浸阅读室）：独立音轨 / 语速 / 音色 / boundary 事件 ----

export type TtsTrack = "sentence" | "word";

export interface ReaderSpeakOptions {
  /** word 音轨独立于句子朗读，查词发音不打断正在读的句子。 */
  track?: TtsTrack;
  /** 语速 0.5–2.0，默认 1.0。 */
  rate?: number;
  /** 系统音色名（ttsVoices 返回的 name），空则引擎默认。 */
  voice?: string;
  /** 事件目标窗口 label，默认 "panel"。阅读室传 "reader"。 */
  target?: string;
}

/** 带完整参数的朗读（阅读室用）。返回本次朗读代数。 */
export async function ttsSpeakAdvanced(text: string, chinese: boolean, opts: ReaderSpeakOptions = {}): Promise<number> {
  return invoke<number>("tts_speak", {
    text,
    chinese,
    track: opts.track ?? null,
    rate: opts.rate ?? null,
    voice: opts.voice ? opts.voice : null,
    target: opts.target ?? null,
  });
}

/** 停止指定音轨（默认 sentence）。 */
export async function ttsStopTrack(track: TtsTrack = "sentence"): Promise<void> {
  await invoke("tts_stop", { track });
}

/** SAPI word/sentence boundary 事件（真实语音边界，§9-1）。 */
export interface TtsBoundaryEvent {
  gen: number;
  track: string;
  kind: "word" | "sentence";
  charStart: number;
  charLength: number;
}

export function onTtsBoundary(handler: (e: TtsBoundaryEvent) => void): Promise<UnlistenFn> {
  return listen<TtsBoundaryEvent>("tts:boundary", (event) => handler(event.payload));
}

export interface TtsVoiceInfo {
  name: string;
  chinese: boolean;
}

/** 枚举系统 SAPI 音色（设置面板音色下拉）。 */
export async function ttsVoices(): Promise<TtsVoiceInfo[]> {
  return invoke<TtsVoiceInfo[]>("tts_voices");
}
