import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { publishUpdateInfo } from "./updateNoticeStore";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./updateNoticeStore", () => ({ publishUpdateInfo: vi.fn() }));

let updater: typeof import("./updater");

function updateFixture() {
  const update = {
    version: "0.12.0",
    body: "修复阅读与语音体验",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(check).mockResolvedValue(update as unknown as Update);
  return update;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue("0.11.1");
  vi.mocked(invoke).mockResolvedValue(false);
  vi.mocked(check).mockResolvedValue(null);
  vi.mocked(relaunch).mockResolvedValue(undefined);
  updater = await import("./updater");
});

afterEach(() => vi.restoreAllMocks());

describe("更新检查与商店保护", () => {
  it("商店版不访问 EXE 更新器，也不下载安装", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(updater.checkForUpdate()).resolves.toEqual({ hasUpdate: false, currentVersion: "0.11.1" });
    const progress = vi.fn();
    await updater.downloadAndInstall(progress);
    expect(check).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith({ stage: "done", message: "商店版更新由 Microsoft Store 接管" });
    expect(publishUpdateInfo).toHaveBeenCalledWith({ hasUpdate: false, currentVersion: "0.11.1" });
  });

  it("不能确认商店身份时检查和安装均停止", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("IPC unavailable"));
    await expect(updater.checkForUpdate()).rejects.toThrow("IPC unavailable");
    await expect(updater.downloadAndInstall(vi.fn())).rejects.toThrow("IPC unavailable");
    expect(check).not.toHaveBeenCalled();
    expect(publishUpdateInfo).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("同窗口并发检查只发一个请求，并在读取普通元信息后关闭资源", async () => {
    const update = updateFixture();
    const first = updater.checkForUpdate();
    const second = updater.checkForUpdate();
    expect(first).toBe(second);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ hasUpdate: true, currentVersion: "0.11.1", newVersion: "0.12.0", releaseNotes: update.body });
    expect(b).toEqual(a);
    expect(check).toHaveBeenCalledExactlyOnceWith({ timeout: 30_000 });
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(publishUpdateInfo).toHaveBeenCalledExactlyOnceWith(a);
  });

  it("检查失败不清空已发现更新，结束后允许再次检查", async () => {
    vi.mocked(check).mockRejectedValueOnce(new Error("offline"));
    await expect(updater.checkForUpdate()).rejects.toThrow("检查更新失败：Error: offline");
    expect(publishUpdateInfo).not.toHaveBeenCalled();
    await expect(updater.checkForUpdate()).resolves.toEqual({ hasUpdate: false, currentVersion: "0.11.1" });
    expect(check).toHaveBeenCalledTimes(2);
    expect(publishUpdateInfo).toHaveBeenCalledExactlyOnceWith({ hasUpdate: false, currentVersion: "0.11.1" });
  });

  it("关闭资源失败不会覆盖有效更新结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const update = updateFixture();
    update.close.mockRejectedValue(new Error("resource already closed"));
    await expect(updater.checkForUpdate()).resolves.toMatchObject({ newVersion: "0.12.0" });
    expect(warn).toHaveBeenCalledWith("[updater] close update resource failed", expect.any(Error));
  });
});

describe("下载和安装", () => {
  it("重复下载点击只启动一个安装流程，向调用方广播进度并释放资源", async () => {
    const update = updateFixture();
    update.downloadAndInstall.mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: "Started", data: { contentLength: 2048 } });
      onEvent({ event: "Progress", data: { chunkLength: 1024 } });
      onEvent({ event: "Finished" });
    });
    const a = vi.fn();
    const b = vi.fn();
    const first = updater.downloadAndInstall(a);
    const second = updater.downloadAndInstall(b);
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledExactlyOnceWith({ timeout: 30_000 });
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ stage: "downloading", message: "正在下载… 1.0 KB / 2.0 KB", progress: 0.5 });
    expect(b).toHaveBeenCalledWith({ stage: "installing", message: "下载完成，正在安装…", progress: 1 });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("安装失败也释放资源，保留原始错误且允许重试", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const update = updateFixture();
    update.downloadAndInstall.mockRejectedValueOnce(new Error("signature invalid"));
    update.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(updater.downloadAndInstall(vi.fn())).rejects.toThrow("signature invalid");
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
    await updater.downloadAndInstall(vi.fn());
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(update.close).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("更新已不存在时清空元信息且不重启", async () => {
    const progress = vi.fn();
    await updater.downloadAndInstall(progress);
    expect(progress).toHaveBeenLastCalledWith({ stage: "done", message: "已是最新版本" });
    expect(publishUpdateInfo).toHaveBeenCalledExactlyOnceWith({ hasUpdate: false, currentVersion: "0.11.1" });
    expect(relaunch).not.toHaveBeenCalled();
  });
});
