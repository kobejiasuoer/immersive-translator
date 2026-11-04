import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, isStorePackaged, type UpdateInfo } from "./updater";
import { readKnownUpdate, subscribeUpdateInfo } from "./updateNoticeStore";

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 仅由 reader 主窗口调度；检查失败保持静默，下载仍由关于页的明确点击触发。 */
export function useProactiveUpdate(): UpdateInfo | null {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    // 浏览器预览没有 Tauri 更新器，避免调试时访问更新端点。
    if (!("__TAURI_INTERNALS__" in window)) return;

    let active = true;
    let busy = false;
    let disabled = false;
    let started = false;
    let currentVersion: string | null = null;
    let lastAttemptAt = 0;
    let lastAttemptFailed = false;

    function apply(info: UpdateInfo | null) {
      if (!active || !info || info.currentVersion !== currentVersion) return;
      setAvailable(info.hasUpdate && info.newVersion ? info : null);
    }

    async function runCheck() {
      if (!active || busy || disabled || navigator.onLine === false) return;
      busy = true;
      lastAttemptAt = Date.now();
      try {
        if (currentVersion === null) {
          // 身份确认前不展示缓存，商店版不能误用 EXE 通道的历史结果。
          if (await isStorePackaged()) {
            disabled = true;
            return;
          }
          if (!active) return;
          currentVersion = await getVersion();
          if (!active) return;
          apply(readKnownUpdate(currentVersion));
        }
        apply(await checkForUpdate());
        lastAttemptFailed = false;
      } catch (error) {
        lastAttemptFailed = true;
        console.debug("[updater] background check failed", error);
      } finally {
        busy = false;
      }
    }

    const unsubscribe = subscribeUpdateInfo(apply);
    const startup = window.setTimeout(() => {
      started = true;
      void runCheck();
    }, STARTUP_DELAY_MS);
    const periodic = window.setInterval(() => void runCheck(), CHECK_INTERVAL_MS);

    function checkIfDue() {
      if (started && Date.now() - lastAttemptAt >= CHECK_INTERVAL_MS) void runCheck();
    }
    function onVisible() {
      if (document.visibilityState === "visible") checkIfDue();
    }
    function onOnline() {
      if (started && lastAttemptFailed) void runCheck();
      else checkIfDue();
    }
    window.addEventListener("focus", checkIfDue);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearTimeout(startup);
      window.clearInterval(periodic);
      window.removeEventListener("focus", checkIfDue);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, []);

  return available;
}
