/**
 * 自动更新检查。对齐 Mac 版 UpdateChecker。
 *
 * 流程：check() → 发现新版本 → 下载 + 校验签名 → 安装 → relaunch
 * 用 Tauri 2 的 updater + process 插件。
 *
 * 签名校验：tauri.conf.json 里配的 pubkey 会在下载后自动验证，
 * 签名不匹配会拒绝安装（防止中间人篡改）。
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { publishUpdateInfo } from "./updateNoticeStore";

/**
 * 商店版（MSIX，带包身份）检测。商店版的更新由 Microsoft Store 接管：
 * MSIX 容器只读，内置自更新（下载 NSIS 覆盖安装）必然失败，
 * 所以带包身份时所有更新检查直接短路为"无更新"。
 */
export async function isStorePackaged(): Promise<boolean> {
  // 不能确认包身份时禁止走 EXE 更新，避免商店版检测失败后绕过保护。
  return invoke<boolean>("is_store_packaged");
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  newVersion?: string;
  releaseNotes?: string;
}

export type UpdateStage = "idle" | "checking" | "downloading" | "installing" | "done" | "error";

export interface UpdateProgress {
  stage: UpdateStage;
  message: string;
  /** 下载进度 0-1（仅 downloading 阶段有意义）。 */
  progress?: number;
}

const CHECK_TIMEOUT_MS = 30_000;
let pendingCheck: Promise<UpdateInfo> | null = null;
let pendingInstall: Promise<void> | null = null;
const installListeners = new Set<(p: UpdateProgress) => void>();

async function closeUpdate(update: Update): Promise<void> {
  try {
    await update.close();
  } catch (error) {
    // 清理失败不能覆盖检查结果或下载/安装的原始错误。
    console.warn("[updater] close update resource failed", error);
  }
}

/** 检查是否有新版本（不下载）；同一窗口的并发检查复用请求。 */
export function checkForUpdate(): Promise<UpdateInfo> {
  if (pendingCheck) return pendingCheck;
  pendingCheck = performCheck().finally(() => {
    pendingCheck = null;
  });
  return pendingCheck;
}

async function performCheck(): Promise<UpdateInfo> {
  const currentVersion = await getVersion();
  if (await isStorePackaged()) {
    const info: UpdateInfo = { hasUpdate: false, currentVersion };
    publishUpdateInfo(info);
    return info;
  }
  try {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    let info: UpdateInfo;
    if (update) {
      try {
        info = {
          hasUpdate: true,
          currentVersion,
          newVersion: update.version,
          releaseNotes: update.body ?? undefined,
        };
      } finally {
        await closeUpdate(update);
      }
    } else {
      info = { hasUpdate: false, currentVersion };
    }
    publishUpdateInfo(info);
    return info;
  } catch (e) {
    throw new Error(`检查更新失败：${e}`);
  }
}

/**
 * 下载并安装更新。
 * onProgress 回调报告下载/安装进度。
 * 安装完成后自动重启应用。
 */
export function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  installListeners.add(onProgress);
  if (pendingInstall) return pendingInstall;
  pendingInstall = performInstall(reportInstallProgress).finally(() => {
    pendingInstall = null;
    installListeners.clear();
  });
  return pendingInstall;
}

function reportInstallProgress(progress: UpdateProgress): void {
  for (const listener of installListeners) {
    try {
      listener(progress);
    } catch (error) {
      console.warn("[updater] install progress listener failed", error);
    }
  }
}

async function performInstall(onProgress: (p: UpdateProgress) => void): Promise<void> {
  if (await isStorePackaged()) {
    onProgress({ stage: "done", message: "商店版更新由 Microsoft Store 接管" });
    return;
  }
  onProgress({ stage: "checking", message: "正在检查更新…" });

  const update = await check({ timeout: CHECK_TIMEOUT_MS });
  if (!update) {
    publishUpdateInfo({ hasUpdate: false, currentVersion: await getVersion() });
    onProgress({ stage: "done", message: "已是最新版本" });
    return;
  }

  onProgress({
    stage: "downloading",
    message: `正在下载 v${update.version}…`,
    progress: 0,
  });

  let totalDownloaded = 0;
  let contentLength = 0;

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          onProgress({
            stage: "downloading",
            message: `正在下载 v${update.version}…`,
            progress: 0,
          });
          break;
        case "Progress":
          totalDownloaded += event.data.chunkLength;
          onProgress({
            stage: "downloading",
            message: `正在下载… ${formatBytes(totalDownloaded)}${contentLength ? " / " + formatBytes(contentLength) : ""}`,
            progress: contentLength > 0 ? totalDownloaded / contentLength : undefined,
          });
          break;
        case "Finished":
          onProgress({
            stage: "installing",
            message: "下载完成，正在安装…",
            progress: 1,
          });
          break;
      }
    });
  } finally {
    await closeUpdate(update);
  }

  onProgress({ stage: "done", message: "安装完成，正在重启…" });

  // 安装完成后重启应用
  await relaunch();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
