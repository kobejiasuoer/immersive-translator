import type { TranslationMode } from "../core/languageDetect";
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

function loadPersisted(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const { apiKey: _ignored, ...rest } = DEFAULT_SETTINGS;
      return rest;
    }
    const parsed = JSON.parse(raw);
    // 兼容旧版本：旧 localStorage 里可能还存了 apiKey，读取后立刻清掉
    if (typeof parsed.apiKey === "string" && parsed.apiKey !== "") {
      void migrateLegacyApiKey(parsed.apiKey);
      parsed.apiKey = "";
    }
    const { apiKey: _ignored, ...rest } = DEFAULT_SETTINGS;
    return { ...rest, ...parsed };
  } catch {
    const { apiKey: _ignored, ...rest } = DEFAULT_SETTINGS;
    return rest;
  }
}

/** 一次性把旧版本残留在 localStorage 的明文 Key 迁移进 DPAPI，然后清空。 */
async function migrateLegacyApiKey(legacyKey: string) {
  try {
    await secretSet(legacyKey);
    const persisted = loadPersisted();
    savePersisted({ ...persisted });
  } catch (e) {
    console.error("[settingsStore] migrate legacy apiKey failed", e);
  }
}

function savePersisted(p: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/**
 * 加载设置（异步）。apiKey 从 DPAPI 读取，其余从 localStorage。
 * 设置窗口调用。
 */
export async function loadSettingsAsync(): Promise<AppSettings> {
  const persisted = loadPersisted();
  const apiKey = await secretGet();
  return { ...persisted, apiKey };
}

/**
 * 保存设置（异步）。apiKey 经 DPAPI 加密落盘，不写入 localStorage 明文。
 */
export async function saveSettingsAsync(settings: AppSettings): Promise<void> {
  const { apiKey, ...rest } = settings;
  savePersisted(rest);
  await secretSet(apiKey);
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
  void saveSettingsAsync(settings);
}

/**
 * 判断是否已配置好可用的接口。
 * 本地接口（localhost）允许留空 API Key。
 */
export function hasValidSettings(settings: AppSettings): boolean {
  const endpointOk = settings.endpoint.trim() !== "";
  const isLocal =
    /:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(settings.endpoint);
  const keyOk = settings.apiKey.trim() !== "" || isLocal;
  return endpointOk && keyOk;
}
