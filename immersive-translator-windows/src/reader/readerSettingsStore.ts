/**
 * 阅读室全局设置（localStorage）。
 *
 * 「设置按文章记忆，并全局记忆一份默认值」：文章级覆盖存在文章记录里
 * （Rust reader_store），这里是全局那份默认值。
 */

import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  type ReaderSettings,
} from "../core/readerTypes";

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
