import type { TranslationMode } from "../core/languageDetect";
import { isLocalhostEndpoint } from "../core/providerPresets";
import { secretGet, secretSet } from "./tauriBridge";

export interface AppSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  translationMode: TranslationMode;
  fixedTarget: string;
  customStyle: string;
  glossaryText: string;
  stream: boolean;
  /** 全局翻译热键，Tauri 格式如 "Ctrl+Shift+Q"。 */
  hotkey: string;
  /** 截图 OCR 翻译热键，Tauri 格式如 "Ctrl+Shift+E"。 */
  ocrHotkey: string;
}

const STORAGE_KEY = "immersive-translator-settings";
const ONBOARDING_KEY = "immersive-translator-onboarding-dismissed";

/** 是否已关闭首次引导横幅。 */
export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOnboardingDismissed(v: boolean): void {
  try {
    if (v) localStorage.setItem(ONBOARDING_KEY, "1");
    else localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    /* ignore */
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o-mini",
  translationMode: "auto",
  fixedTarget: "",
  customStyle: "",
  glossaryText: "",
  stream: true,
  hotkey: "Ctrl+Shift+Q",
  ocrHotkey: "Ctrl+Shift+E",
};

/** localStorage 里保存的非敏感字段（apiKey 走 DPAPI，不落明文）。 */
type PersistedSettings = Omit<AppSettings, "apiKey">;

type PersistedRawReader = () => string | null;
type PersistedRawWriter = (raw: string | null) => void;
type SecretWriter = (value: string) => Promise<void>;

interface LoadedPersistedSettings {
  settings: PersistedSettings;
  legacyApiKey?: string;
}

function defaultPersistedSettings(): PersistedSettings {
  const { apiKey: _ignored, ...rest } = DEFAULT_SETTINGS;
  return rest;
}

function loadPersistedState(): LoadedPersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { settings: defaultPersistedSettings() };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings JSON must be an object");
    }
    const { apiKey, ...persisted } = parsed as Record<string, unknown>;
    return {
      settings: { ...defaultPersistedSettings(), ...persisted } as PersistedSettings,
      legacyApiKey:
        typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey : undefined,
    };
  } catch {
    return { settings: defaultPersistedSettings() };
  }
}

function loadPersisted(): PersistedSettings {
  return loadPersistedState().settings;
}

function savePersisted(p: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

function formatPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist non-sensitive settings and the DPAPI secret as one recoverable
 * operation. The injected storage functions keep the rollback behavior
 * testable without requiring a browser or Tauri runtime.
 */
export async function persistSettingsTransaction(
  settings: AppSettings,
  readRaw: PersistedRawReader,
  writeRaw: PersistedRawWriter,
  writeSecret: SecretWriter,
): Promise<void> {
  const previousRaw = readRaw();
  const { apiKey, ...rest } = settings;

  writeRaw(JSON.stringify(rest));
  try {
    await writeSecret(apiKey);
  } catch (error) {
    try {
      writeRaw(previousRaw);
    } catch (rollbackError) {
      throw new Error(
        `保存 API Key 失败：${formatPersistenceError(error)}；恢复设置失败：${formatPersistenceError(rollbackError)}`,
      );
    }
    throw error;
  }
}

/** Update only the persisted hotkey without saving other edited form fields. */
export function persistHotkeyField(
  hotkey: string,
  readRaw: PersistedRawReader,
  writeRaw: (raw: string) => void,
): void {
  const raw = readRaw();
  let persisted: Record<string, unknown>;

  if (raw === null) {
    const { apiKey: _ignored, ...defaults } = DEFAULT_SETTINGS;
    persisted = defaults;
  } else {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("已保存的设置格式无效");
    }
    const { apiKey: _ignored, ...withoutLegacySecret } = parsed as Record<string, unknown>;
    persisted = withoutLegacySecret;
  }

  writeRaw(JSON.stringify({ ...persisted, hotkey }));
}

export function savePersistedHotkey(hotkey: string): void {
  persistHotkeyField(
    hotkey,
    () => localStorage.getItem(STORAGE_KEY),
    (raw) => localStorage.setItem(STORAGE_KEY, raw),
  );
}

/**
 * 加载设置（异步）。apiKey 从 DPAPI 读取，其余从 localStorage。
 * 设置窗口调用。
 */
export async function loadSettingsAsync(): Promise<AppSettings> {
  const { settings: persisted, legacyApiKey } = loadPersistedState();
  if (legacyApiKey !== undefined) {
    await secretSet(legacyApiKey);
    savePersisted(persisted);
    return { ...persisted, apiKey: legacyApiKey };
  }
  const apiKey = await secretGet();
  return { ...persisted, apiKey };
}

/**
 * 保存设置（异步）。apiKey 经 DPAPI 加密落盘，不写入 localStorage 明文。
 */
export async function saveSettingsAsync(settings: AppSettings): Promise<void> {
  await persistSettingsTransaction(
    settings,
    () => localStorage.getItem(STORAGE_KEY),
    (raw) => {
      if (raw === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, raw);
    },
    secretSet,
  );
}

// ---- 同步读取（仅用于翻译浮窗的快速校验 / 缺 Key 时引导）----
// 注意：同步版本读不到 DPAPI 里的 apiKey，只能拿到 hasApiKey 标记外的字段。
// 翻译流程现在统一走 loadSettingsAsync。

/**
 * 同步读取非敏感设置 + DPAPI 不可用的占位 apiKey（空串）。
 * 仅用于不需要真实 Key 的快速路径。需要 Key 的流程请用 loadSettingsAsync。
 */
export function loadSettings(): AppSettings {
  return { ...loadPersisted(), apiKey: "" };
}

export function saveSettings(settings: AppSettings): void {
  // 向后兼容：老的同步调用退化为只存非敏感字段 + fire-and-forget 写 Key。
  void saveSettingsAsync(settings).catch((error) => {
    console.error("[settingsStore] save failed", error);
  });
}

/**
 * 判断是否已配置好可用的接口。
 * 本地接口（localhost）允许留空 API Key。
 */
export function hasValidSettings(settings: AppSettings): boolean {
  const endpointOk = settings.endpoint.trim() !== "";
  const isLocal = isLocalhostEndpoint(settings.endpoint);
  const keyOk = settings.apiKey.trim() !== "" || isLocal;
  return endpointOk && keyOk;
}
