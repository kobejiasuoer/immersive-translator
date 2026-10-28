/**
 * 阅读室全局设置（localStorage）。
 *
 * 「设置按文章记忆，并全局记忆一份默认值」：文章级覆盖存在文章记录里
 * （Rust reader_store），这里是全局那份默认值。
 */

import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  shouldMigrateLegacyTtsProvider,
  type ReaderSettings,
} from "../core/readerTypes";
import { hasAnyXfyunCredential } from "../lib/iseCredentials";
import { authGetStatus } from "../lib/tauriBridge";

const STORAGE_KEY = "immersive-translator-reader-settings";

export function loadGlobalReaderSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_READER_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_READER_SETTINGS };
    }
    return mergeReaderSettings(DEFAULT_READER_SETTINGS, parsed as Partial<ReaderSettings>);
  } catch {
    return { ...DEFAULT_READER_SETTINGS };
  }
}

export function saveGlobalReaderSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export interface ReaderTtsMigrationDeps {
  hasAnyXfyunCredential: () => Promise<boolean>;
  isLoggedIn: () => Promise<boolean>;
}

/** 启动时判定一次，同时供全局设置与文章级旧覆盖迁移；探测失败按无该项处理。 */
export async function resolveLegacyTtsMigrationAllowed(
  deps: ReaderTtsMigrationDeps = {
    hasAnyXfyunCredential,
    isLoggedIn: () => authGetStatus().then((s) => s.loggedIn),
  },
): Promise<boolean> {
  const [credential, loggedIn] = await Promise.all([
    deps.hasAnyXfyunCredential().catch(() => false),
    deps.isLoggedIn().catch(() => false),
  ]);
  return shouldMigrateLegacyTtsProvider("xfyun", {
    hasAnyXfyunCredential: credential,
    loggedIn,
  });
}

// ---- 跟读评测：麦克风设备偏好（机器本地，不随文章、不进 schema） ----

const MIC_DEVICE_KEY = "immersive-translator-mic-device";

export function loadMicDeviceId(): string {
  try {
    return localStorage.getItem(MIC_DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveMicDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(MIC_DEVICE_KEY, deviceId);
  } catch {
    /* ignore */
  }
}

// ---- 口语陪练：听力模式（先听后看；机器本地偏好，不进 schema） ----

const SPEAK_LISTEN_MODE_KEY = "immersive-translator-speak-listen-mode";

export function loadSpeakListenMode(): boolean {
  try {
    return localStorage.getItem(SPEAK_LISTEN_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSpeakListenMode(on: boolean): void {
  try {
    localStorage.setItem(SPEAK_LISTEN_MODE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}
