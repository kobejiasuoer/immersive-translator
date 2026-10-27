/**
 * 自动更新检查。对齐 Mac 版 UpdateChecker。
 *
 * 流程：check() → 发现新版本 → 下载 + 校验签名 → 安装 → relaunch
 * 用 Tauri 2 的 updater + process 插件。
 *
 * 签名校验：tauri.conf.json 里配的 pubkey 会在下载后自动验证，
 * 签名不匹配会拒绝安装（防止中间人篡改）。
 */

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

/**
 * 商店版（MSIX，带包身份）检测。商店版的更新由 Microsoft Store 接管：
 * MSIX 容器只读，内置自更新（下载 NSIS 覆盖安装）必然失败，
 * 所以带包身份时所有更新检查直接短路为"无更新"。
 */
async function isStorePackaged(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_store_packaged");
  } catch {
    return false;
  }
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

/** 检查是否有新版本（不下载）。 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = await getVersion();
  if (await isStorePackaged()) {
    return { hasUpdate: false, currentVersion };
  }
  try {
    const update = await check();
    if (update) {
      return {
        hasUpdate: true,
        currentVersion,
        newVersion: update.version,
        releaseNotes: update.body ?? undefined,
      };
    }
    return { hasUpdate: false, currentVersion };
  } catch (e) {
    throw new Error(`检查更新失败：${e}`);
  }
}

/**
 * 下载并安装更新。
 * onProgress 回调报告下载/安装进度。
 * 安装完成后自动重启应用。
 */
export async function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  if (await isStorePackaged()) {
    onProgress({ stage: "done", message: "商店版更新由 Microsoft Store 接管" });
    return;
  }
  onProgress({ stage: "checking", message: "正在检查更新…" });

  const update = await check();
  if (!update) {
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

  onProgress({ stage: "done", message: "安装完成，正在重启…" });

  // 安装完成后重启应用
  await relaunch();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
