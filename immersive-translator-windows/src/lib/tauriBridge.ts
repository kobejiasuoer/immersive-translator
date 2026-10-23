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

/** 阅读室窗口挂载时取走「打开书断点」请求（提醒卡「继续阅读」入口，窗口重建路径）。 */
export async function takePendingOpenBook(): Promise<string | null> {
  return invoke<string | null>("take_pending_open_book");
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

/**
 * 探测 https URL 的 HTTP 状态（语音凭据自检）：浏览器把 WS 握手失败一律报
 * 1006，这里经 Rust 发同路径的 GET 拿到真实状态码（401=签名被拒等）。
 */
export async function probeHttps(url: string): Promise<ConnectivityResult> {
  return invoke<ConnectivityResult>("probe_https", { url });
}

// ---- 取消翻译 ----

/**
 * 取消正在进行的流式翻译。传 tag 只取消该请求（不打伤并发的
 * 词块标注/字幕翻译等其他流）；不传取消当前全部在途请求。
 */
export async function cancelTranslation(tag?: string): Promise<void> {
  await invoke("cancel_translation", { tag: tag ?? null });
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

/**
 * 命名 secret（翻译 Key 之外的第二类凭据，如讯飞评测）。
 * name 限小写字母/数字/下划线；不存在返回空串，空值删除。
 */
export async function secretGetNamed(name: string): Promise<string> {
  return invoke<string>("secret_get", { name });
}

export async function secretSetNamed(name: string, value: string): Promise<void> {
  await invoke("secret_set", { name, value });
}

export async function secretExistsNamed(name: string): Promise<boolean> {
  return invoke<boolean>("secret_exists", { name });
}

// ---- 文件导出（原生另存为） ----

/** 弹原生保存对话框写入 UTF-8 文本（复习笔记 .md 等）；用户取消返回 null。 */
export async function saveTextFile(defaultName: string, contents: string): Promise<string | null> {
  return invoke<string | null>("save_text_file", { defaultName, contents });
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
  /**
   * 云引擎原生合成语速（SSML 百分比，如 "-25%"；v0.8 慢速示范用）。
   * 只被 Edge/讯飞引擎消费——SAPI（tts_speak）invoke 载荷不含此字段，
   * 缺省 undefined 走既有「1× 合成 + playbackRate 变速」路径。
   */
  nativeRate?: string;
}

/** 带完整参数的朗读（阅读室用）。返回本次朗读代数。
 * 显式挑选 track/rate/voice/target 传参：nativeRate 是云引擎专属字段，
 * 不透传给 SAPI，保证 tts_speak invoke 载荷与旧版逐字节一致。 */
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

// ---- 首启引导（onboarding）----

/** 完成（或跳过）首启引导：后端写标记并关闭引导窗口。 */
export function finishOnboarding(): Promise<void> {
  return invoke("finish_onboarding");
}

/** 重新打开引导窗口（设置 → 关于「查看引导」）。 */
export function openOnboarding(): Promise<void> {
  return invoke("open_onboarding");
}

// ---- 账号登录（windows-auth；docs/windows-auth-design-2026-09-26.md §7 IPC 契约表）----
// 令牌永不跨 IPC：前端只见 user / 登录态布尔 / notice 失效原因（设计 D4/D5）。
// 错误统一为 AuthError（invoke reject 的对象），文案映射唯一出口在 authErrorText.ts。

/** Rust AuthError 结构（serde camelCase），code 分支见设计 §3。 */
export interface AuthError {
  code: string;
  message: string;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
}

export interface AuthUser {
  id: string;
  email: string;
  /** Rust 侧 Option<String>（服务端 PublicUser.nickname 可为 null，auth.rs 注释）。 */
  nickname: string | null;
  plan: string;
  createdAt: string;
}

/** 登录 / 刷新成功只回 user，不含任何令牌。 */
export interface AuthSession {
  user: AuthUser;
}

/** 失效原因：token_invalid → session_expired；token_reused → session_kicked。 */
export type AuthNotice = "session_expired" | "session_kicked" | null;

export interface AuthStatus {
  loggedIn: boolean;
  user: AuthUser | null;
  notice: AuthNotice;
}

export interface LogoutOutcome {
  /** 服务端吊销是否成功（尽力而为，失败仍完成本地清空）。 */
  serverRevoked: boolean;
}

/** 请求向 email 发送验证码（服务端恒 {ok:true}，防枚举）。 */
export function authSendOtp(email: string): Promise<void> {
  return invoke("auth_send_otp", { email });
}

/** 验证码登录（未注册邮箱自动建号；device 由 Rust 填充，前端不传）。 */
export function authVerifyOtp(email: string, code: string): Promise<AuthSession> {
  return invoke("auth_verify_otp", { email, code });
}

/** 密码登录（密码页签）。 */
export function authLoginPassword(email: string, password: string): Promise<AuthSession> {
  return invoke("auth_login_password", { email, password });
}

/** 登出：服务端吊销尽力 + 本地清空；clear 失败保登录态并 reject storage_error（§5.3）。 */
export function authLogout(): Promise<LogoutOutcome> {
  return invoke("auth_logout");
}

/** 当前登录态（内存优先，空则回读 DPAPI 懒预填；不会 reject）。 */
export function authGetStatus(): Promise<AuthStatus> {
  return invoke("auth_get_status");
}

/** 手动触发一次刷新（账号区「刷新」入口，走 Rust 单飞）。 */
export function authRefreshNow(): Promise<AuthSession> {
  return invoke("auth_refresh_now");
}

/** GET /v1/me（带鉴权请求样板，Rust 侧 401 分支处理）。 */
export function authFetchMe(): Promise<AuthUser> {
  return invoke("auth_fetch_me");
}

/** GET /v1/me/config：Rust 落盘 app_data_dir/server_config.json 后原样返回（MVP 只存不消费）。 */
export function authFetchServerConfig(): Promise<unknown> {
  return invoke("auth_fetch_server_config");
}

/** POST /v1/events（Phase 0 埋点，计划书 §8）：Bearer 会话 token 由 Rust 附带，
 *  ts(毫秒) 由 Rust 发送时打上；properties 整体 JSON 上报。失败 reject AuthError
 *  （unauthorized=未登录），由 lib/analytics.ts 的 track() 静默吞掉。 */
export function authTrackEvent(
  event: string,
  properties: Record<string, unknown>,
): Promise<void> {
  return invoke("auth_track_event", { event, properties });
}

/** 服务端 base URL（§4.6 两层机制解析结果，非敏感）。沉浸云未开放（服务端
 *  未公开部署且本机无 server_endpoint.json）时返回 null——设置页据此隐藏入口。 */
export function authServerBaseUrl(): Promise<string | null> {
  return invoke<string | null>("auth_server_base_url");
}

/** 打开（或聚焦）登录窗口。 */
export function openLoginWindow(): Promise<void> {
  return invoke("open_login_window");
}

/** 定位设置页指定 tab（settings 窗存在走事件，不存在写 pending 由挂载时取走）。 */
export function settingsOpenTab(tab: string): Promise<void> {
  return invoke("settings_open_tab", { tab });
}

/** Settings 挂载时取走 pending tab（恰好一次，取走即清空）。 */
export function settingsTakePendingTab(): Promise<string | null> {
  return invoke("settings_take_pending_tab");
}

/** 登录态变化（登录/登出/启动预填/续期/失效），全窗广播。 */
export function listenAuthStateChanged(
  handler: (status: AuthStatus) => void,
): Promise<UnlistenFn> {
  return listen<AuthStatus>("auth-state-changed", (event) => handler(event.payload));
}

/** settings 窗运行中的 tab 定位事件（settings_open_tab 在窗口已存在时）。 */
export function listenSettingsNavigateTab(
  handler: (tab: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("settings:navigate-tab", (event) => handler(event.payload));
}
