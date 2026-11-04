import type { UpdateInfo } from "./updater";

const STORAGE_KEY = "immersive-translator-update-info";
let latestUpdate: UpdateInfo | null = null;
let latestWriteFailed = false;
const listeners = new Set<(info: UpdateInfo) => void>();

/** 只共享展示用元信息；不持久化更新资源、下载地址或签名。 */
function parseUpdateInfo(value: unknown): UpdateInfo | null {
  if (!value || typeof value !== "object") return null;
  const info = value as Record<string, unknown>;
  if (typeof info.hasUpdate !== "boolean" ||
      typeof info.currentVersion !== "string" || !info.currentVersion.trim()) return null;
  if (!info.hasUpdate) return { hasUpdate: false, currentVersion: info.currentVersion };
  if (typeof info.newVersion !== "string" || !info.newVersion.trim() ||
      info.newVersion === info.currentVersion ||
      (info.releaseNotes !== undefined && typeof info.releaseNotes !== "string")) return null;
  return {
    hasUpdate: true,
    currentVersion: info.currentVersion,
    newVersion: info.newVersion,
    releaseNotes: info.releaseNotes as string | undefined,
  };
}

function parseStoredInfo(raw: string): UpdateInfo | null {
  try {
    return parseUpdateInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 更新应用后，旧版本产生的缓存不再作为更新提示。 */
export function readKnownUpdate(currentVersion: string): UpdateInfo | null {
  let info = latestUpdate;
  try {
    // 配额不足时 getItem 仍可能返回旧值；本次写入失败后应保留新检查结果。
    if (!latestWriteFailed) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) info = parseStoredInfo(raw);
    }
  } catch {
    // 存储不可用时仍可读取本次运行检查到的更新。
  }
  return info?.currentVersion === currentVersion ? { ...info } : null;
}

function notify(info: UpdateInfo): void {
  for (const listener of listeners) {
    try {
      listener({ ...info });
    } catch (error) {
      console.warn("[updater] update listener failed", error);
    }
  }
}

/** 检查成功时发布；网络失败不覆盖之前已发现的更新。 */
export function publishUpdateInfo(value: UpdateInfo): void {
  const info = parseUpdateInfo(value);
  if (!info) return;
  latestUpdate = info;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    latestWriteFailed = false;
  } catch {
    latestWriteFailed = true;
    // 不影响实际更新检查及同窗口通知。
  }
  notify(info);
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY || event.newValue === null) return;
  const info = parseStoredInfo(event.newValue);
  if (!info) return;
  latestUpdate = info;
  latestWriteFailed = false;
  notify(info);
}

/** 同窗口走内存通知；reader 与 settings 独立 WebView 通过 storage 事件同步。 */
export function subscribeUpdateInfo(listener: (info: UpdateInfo) => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
