import type { TranslationMode } from "../core/languageDetect";

export interface AppSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  translationMode: TranslationMode;
  fixedTarget: string;
  customStyle: string;
  glossaryText: string;
  stream: boolean;
}

const STORAGE_KEY = "immersive-translator-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o-mini",
  translationMode: "auto",
  fixedTarget: "",
  customStyle: "",
  glossaryText: "",
  stream: true,
};

/** 阶段 1 用 localStorage 暂存设置。阶段 2 换成持久化存储 + Credential Manager 存 API Key。 */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * 判断是否已配置好可用的接口。
 * 阶段 1 验证用：apiKey 非空视为已配置（本地 Ollama 等免 key 接口另说，但这里简单按 apiKey 判断）。
 */
export function hasValidSettings(settings: AppSettings): boolean {
  return settings.endpoint.trim() !== "" && settings.apiKey.trim() !== "";
}

