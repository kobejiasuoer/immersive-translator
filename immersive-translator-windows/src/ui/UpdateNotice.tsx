import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { settingsOpenTab } from "../lib/tauriBridge";
import type { UpdateInfo } from "../lib/updater";
import { IconClose, IconDownload } from "./icons";
import "./updateNotice.css";

const SNOOZE_KEY = "immersive-translator-update-snooze";
const SNOOZE_DURATION = 24 * 60 * 60 * 1000;
let memorySnooze: { version: string; until: number } | null = null;

function readSnooze(version: string): number {
  // 写入失败时内存保存的是最新选择，不能再被可读取的旧缓存覆盖。
  let value: unknown = memorySnooze;
  if (!value) {
    try {
      const raw = localStorage.getItem(SNOOZE_KEY);
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== "object") return 0;
  const record = value as { version?: unknown; until?: unknown };
  const now = Date.now();
  return record.version === version && typeof record.until === "number" &&
    Number.isFinite(record.until) && record.until > now && record.until <= now + SNOOZE_DURATION
    ? record.until
    : 0;
}

function saveSnooze(version: string): number {
  const record = { version, until: Date.now() + SNOOZE_DURATION };
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(record));
    memorySnooze = null;
  } catch {
    memorySnooze = record;
  }
  return record.until;
}

/** 不抢焦点的更新提示；同一版本的提醒由用户收起后延后一天。 */
export function UpdateNotice({ info }: { info: UpdateInfo | null }) {
  if (!info?.hasUpdate || !info.newVersion) return null;
  return <AvailableUpdateNotice key={`${info.currentVersion}:${info.newVersion}`} version={info.newVersion} />;
}

function AvailableUpdateNotice({ version }: { version: string }) {
  const [snoozeUntil, setSnoozeUntil] = useState(() => readSnooze(version));
  const [open, setOpen] = useState(() => snoozeUntil <= Date.now());
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);
  const openingRef = useRef(false);
  const panelId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const dismiss = useCallback((returnFocus = false) => {
    setSnoozeUntil(saveSnooze(version));
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, [version]);

  useEffect(() => {
    if (!snoozeUntil) return;
    const timer = window.setTimeout(() => {
      setSnoozeUntil(0);
      setError(null);
      setOpen(true);
    }, Math.max(0, snoozeUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [snoozeUntil]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, dismiss]);

  async function openUpdates() {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      await settingsOpenTab("about");
      if (mountedRef.current) dismiss();
    } catch {
      if (mountedRef.current) setError("暂时无法打开更新页面，请稍后重试。");
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // 阅读室的播放快捷键不排除按钮；提示内的按键由控件自己处理。
    event.stopPropagation();
    if (event.key === "Escape" && open) {
      event.preventDefault();
      dismiss(rootRef.current?.contains(document.activeElement) ?? false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="update-notice"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        // 正文中按住 H 后进入提示，仍让全局收到释放事件以清除临时译文。
        if (event.key !== "h" && event.key !== "H") event.stopPropagation();
      }}
      onBlur={(event) => {
        if (open && !openingRef.current && !event.currentTarget.contains(event.relatedTarget as Node)) dismiss();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="update-notice-trigger"
        aria-label={`发现新版本 v${version}，查看更新`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`新版本 v${version} 可用`}
        onClick={() => {
          if (open) dismiss();
          else {
            setError(null);
            setOpen(true);
          }
        }}
      >
        <IconDownload size={14} />
        <span className="update-notice-label">新版本</span>
        <span className="update-notice-dot" aria-hidden />
      </button>
      {open && (
        <section className="update-notice-panel" id={panelId} aria-label="应用更新">
          <button
            type="button"
            className="update-notice-close"
            aria-label="关闭更新提示"
            title="关闭更新提示，明天再提醒"
            onClick={() => dismiss(true)}
          >
            <IconClose size={13} />
          </button>
          <div className="update-notice-message" role="status" aria-live="polite">
            <span className="update-notice-eyebrow">有新版本可用</span>
            <strong>v{version} 已可更新</strong>
            <p>准备好时再下载，安装后会重启应用。</p>
          </div>
          <div className="update-notice-actions">
            <button type="button" className="update-notice-view" disabled={opening} onClick={() => void openUpdates()}>
              {opening ? "正在打开…" : "查看更新"}
            </button>
            <button type="button" className="update-notice-later" title="明天再提醒这个版本" onClick={() => dismiss(true)}>
              稍后提醒
            </button>
          </div>
          {error && <p className="update-notice-error" role="alert">{error}</p>}
        </section>
      )}
    </div>
  );
}
