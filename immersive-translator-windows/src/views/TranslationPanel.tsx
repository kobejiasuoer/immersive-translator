import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import {
  translateStream,
  cancelTranslation,
  openSettings,
  openHistory,
  onTranslationDelta,
  onTranslationStatus,
  onTranslationDone,
  onTranslationError,
  onTranslationCancelled,
  historyAdd,
  historyToggleFavorite,
  clearPendingPanelPayload,
  takePendingPanelPayload,
  type DoneEvent,
  type ErrorEvent,
  type PanelPayload,
  type PanelSource,
  type TranslationPhase,
} from "../lib/tauriBridge";
import { loadSettingsAsync, hasValidSettings } from "../lib/settingsStore";
import {
  classifyTranslationError,
  sanitizeDiagnosticText,
} from "../core/errorMessageFormatter";
import { resolveTargetLanguage } from "../core/languageDetect";
import { buildSystemPrompt } from "../core/promptBuilder";

type Status = "idle" | "reading" | "translating" | "done" | "error" | "needsConfig";
type PanelShownPayload = string | Partial<PanelPayload>;
type ResizeDirection = "East" | "South" | "SouthEast";

const panelWindow = getCurrentWindow();
const SECURE_SETTINGS_LOAD_ERROR =
  "安全存储读取失败，未覆盖凭证。请打开设置检查后重试。";

/** 根据阶段 + 是否已有文字给出加载文案，对齐 Mac 的状态机语义。 */
function phaseLabel(phase: TranslationPhase | null, text: string): string {
  if (text) return "翻译中…";
  switch (phase) {
    case "connecting":
      return "正在连接服务商…";
    case "waitingFirstToken":
      return "已连接，等待首个字符…";
    case "streaming":
      return "翻译中…";
    default:
      return "翻译中…";
  }
}

/** 毫秒格式化：< 1000 显示 ms，否则显示 s。 */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 偏慢原因提示（对齐 Mac：连接或首字过慢时给排查方向）。 */
function slowHint(t: {
  connectMs: number;
  firstTokenMs: number;
  totalMs: number;
}): string {
  if (t.connectMs > 3000) {
    return " · 连接偏慢：网络到服务商延迟高，或需要代理";
  }
  if (t.firstTokenMs > 5000) {
    return " · 首字偏慢：模型推理或排队耗时";
  }
  return "";
}

export function TranslationPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translated, setTranslated] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [phase, setPhase] = useState<TranslationPhase | null>(null);
  /** 拆分耗时：连接 / 首字 / 总耗时。 */
  const [timing, setTiming] = useState<{ connectMs: number; firstTokenMs: number; totalMs: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [retryable, setRetryable] = useState(false);
  const [copiedHint, setCopiedHint] = useState("");
  /** 固定状态：固定后浮窗不会因失焦自动隐藏。 */
  const [pinned, setPinned] = useState(false);
  /** 最近一次翻译落库后的历史记录 id，用于收藏按钮。 */
  const [lastRecordId, setLastRecordId] = useState<string | null>(null);
  /** 收藏按钮的本地镜像，用于即时反馈。 */
  const [favToggled, setFavToggled] = useState(false);
  const lastOriginalRef = useRef("");
  const lastEndpointRef = useRef("");
  const lastApiKeyRef = useRef("");
  const lastSourceRef = useRef<PanelSource>("selection");
  const lastPanelPayloadRef = useRef("");
  const lastPanelPayloadAtRef = useRef(0);
  const lastDoneHistoryKeyRef = useRef("");
  const dragStateRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const dragMovePendingRef = useRef(false);
  const resizingRef = useRef(false);

  function showSecureSettingsLoadError(error: unknown) {
    console.error("[settings] secure storage read failed", error);
    setErrorMsg(SECURE_SETTINGS_LOAD_ERROR);
    setRetryable(false);
    setStatus("error");
  }

  async function loadSettingsSafely() {
    try {
      return await loadSettingsAsync();
    } catch (error) {
      showSecureSettingsLoadError(error);
      return null;
    }
  }

  useEffect(() => {
    let unDelta: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    let unErr: (() => void) | undefined;
    let unStatus: (() => void) | undefined;

    let active = true;

    onTranslationDelta((e) => {
      if (!active) return;
      setTranslated(e.text);
      setElapsedMs(e.elapsedMs);
    }).then((u) => {
      if (active) unDelta = u;
      else u();
    });

    onTranslationStatus((e) => {
      if (!active) return;
      setPhase(e.phase);
      setElapsedMs(e.elapsedMs);
    }).then((u) => {
      if (active) unStatus = u;
      else u();
    });

    onTranslationDone((e: DoneEvent) => {
      if (!active) return;
      setTranslated(e.text);
      setElapsedMs(e.elapsedMs);
      setTiming({ connectMs: e.connectMs, firstTokenMs: e.firstTokenMs, totalMs: e.elapsedMs });
      setPhase("done");
      setStatus("done");
      // 落库到历史记录（fire-and-forget，失败不影响展示）
      const original = lastOriginalRef.current;
      const trimmed = original.trim();
      const transTrimmed = e.text.trim();
      if (trimmed && transTrimmed) {
        const historyKey = `${lastSourceRef.current}\u0000${trimmed}\u0000${transTrimmed}\u0000${e.elapsedMs}`;
        if (lastDoneHistoryKeyRef.current === historyKey) {
          return;
        }
        lastDoneHistoryKeyRef.current = historyKey;
        // 目标语言此刻未知（doTranslate 里算的），这里用 settings 简单推断
        void loadSettingsAsync()
          .then((s) =>
            historyAdd(
              trimmed,
              transTrimmed,
              resolveTargetLanguage(trimmed, {
                mode: s.translationMode,
                fixed: s.fixedTarget,
              }),
              lastSourceRef.current,
              s.model,
              e.elapsedMs,
            ),
          )
          .then((rec) => setLastRecordId(rec.id))
          .catch((error) => console.error("[history] settings load or add failed", error));
      }
    }).then((u) => {
      if (active) unDone = u;
      else u();
    });

    onTranslationError((e: ErrorEvent) => {
      if (!active) return;
      const classified = classifyTranslationError(
        toInput(e),
        lastEndpointRef.current,
        lastApiKeyRef.current,
      );
      setErrorMsg(classified.message);
      setRetryable(classified.retryable);
      setStatus("error");
    }).then((u) => {
      if (active) unErr = u;
      else u();
    });

    let unCancel: (() => void) | undefined;
    onTranslationCancelled((e) => {
      if (!active) return;
      // 用户取消：保留已翻译的部分，进入 done 态
      setTranslated(e.partial);
      setElapsedMs(e.elapsedMs);
      setStatus("done");
    }).then((u) => {
      if (active) unCancel = u;
      else u();
    });

    return () => {
      active = false;
      unDelta?.();
      unDone?.();
      unErr?.();
      unStatus?.();
      unCancel?.();
    };
  }, []);

  async function doTranslate(text: string) {
    const s = await loadSettingsSafely();
    if (s === null) return;
    lastEndpointRef.current = s.endpoint;
    lastApiKeyRef.current = s.apiKey;
    const target = resolveTargetLanguage(text, {
      mode: s.translationMode,
      fixed: s.fixedTarget,
    });
    const systemPrompt = buildSystemPrompt({
      targetLanguage: target,
      customStyle: s.customStyle,
      glossaryText: s.glossaryText,
    });

    setStatus("translating");
    setTranslated("");
    setErrorMsg("");
    setPhase(null);
    setTiming(null);
    setLastRecordId(null);
    setFavToggled(false);
    lastDoneHistoryKeyRef.current = "";

    try {
      await translateStream({
        text,
        endpoint: s.endpoint,
        apiKey: s.apiKey,
        model: s.model,
        systemPrompt,
        stream: s.stream,
        windowLabel: "panel",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMsg(
        `翻译命令调用失败：${sanitizeDiagnosticText(
          message,
          s.endpoint,
          s.apiKey,
        )}`,
      );
      setRetryable(true);
      setStatus("error");
    }
  }

  async function triggerWithText(text: string, source: PanelSource = "selection") {
    const s = await loadSettingsSafely();
    if (s === null) return;
    if (!hasValidSettings(s)) {
      setStatus("needsConfig");
      return;
    }
    if (!text || !text.trim()) {
      setErrorMsg("没有读取到选中的文本。请先在任意应用里选中文本。");
      setRetryable(false);
      setStatus("error");
      return;
    }
    lastOriginalRef.current = text;
    lastSourceRef.current = source;
    setOriginal(text);
    setTranslated("");
    setErrorMsg("");
    setStatus("translating");
    await doTranslate(text);
  }

  async function handlePanelPayload(payload: PanelPayload) {
    const key = `${payload.source}\u0000${payload.text}`;
    const now = Date.now();
    if (lastPanelPayloadRef.current === key && now - lastPanelPayloadAtRef.current < 1500) {
      return;
    }
    lastPanelPayloadRef.current = key;
    lastPanelPayloadAtRef.current = now;
    await triggerWithText(payload.text, payload.source);
  }

  async function retry() {
    if (lastOriginalRef.current) {
      await doTranslate(lastOriginalRef.current);
    }
  }

  /** 短暂显示复制提示（2 秒后消失）。 */
  function flashCopied(msg: string) {
    setCopiedHint(msg);
    setTimeout(() => setCopiedHint(""), 2000);
  }

  async function hidePanel() {
    await panelWindow.hide();
  }

  async function startManualDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const [cursor, position] = await Promise.all([
      cursorPosition(),
      panelWindow.outerPosition(),
    ]);

    dragStateRef.current = {
      offsetX: cursor.x - position.x,
      offsetY: cursor.y - position.y,
    };
  }

  async function moveDraggedPanel(event: React.PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || event.buttons !== 1 || dragMovePendingRef.current) {
      return;
    }

    event.preventDefault();
    dragMovePendingRef.current = true;
    try {
      const cursor = await cursorPosition();
      await panelWindow.setPosition(
        new PhysicalPosition(
          Math.round(cursor.x - dragState.offsetX),
          Math.round(cursor.y - dragState.offsetY),
        ),
      );
    } finally {
      dragMovePendingRef.current = false;
    }
  }

  function stopManualDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
  }

  async function startResize(direction: ResizeDirection, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizingRef.current = true;
    window.setTimeout(() => {
      resizingRef.current = false;
    }, 1200);
    try {
      await panelWindow.startResizeDragging(direction);
    } finally {
      window.setTimeout(() => {
        resizingRef.current = false;
      }, 250);
    }
  }

  useEffect(() => {
    let active = true;
    void takePendingPanelPayload()
      .then(async (payload) => {
        if (active && payload) {
          await handlePanelPayload(payload);
        }
      })
      .catch((error) => {
        if (!active) return;
        console.error("[panel] initial payload failed", error);
        setErrorMsg("读取待翻译内容失败，请重试。");
        setRetryable(true);
        setStatus("error");
      });

    let unlisten: (() => void) | undefined;
    listen<PanelShownPayload>("panel:shown", (event) => {
      if (!active) return;
      const payload = event.payload;
      const text = typeof payload === "string" ? payload : payload.text ?? "";
      const source = typeof payload === "string" ? "selection" : payload.source ?? "selection";
      void clearPendingPanelPayload().catch((error) =>
        console.error("[panel] clear pending payload failed", error),
      );
      void handlePanelPayload({ text, source }).catch((error) => {
        console.error("[panel] payload handling failed", error);
        setErrorMsg("读取待翻译内容失败，请重试。");
        setRetryable(true);
        setStatus("error");
      });
    }).then(
      (u) => {
        if (active) unlisten = u;
        else u();
      },
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Esc：关闭浮窗
      if (event.key === "Escape") {
        event.preventDefault();
        void hidePanel();
        return;
      }
      // Ctrl/Cmd + Enter：复制译文（done 时）
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (status === "done" && translated) {
          event.preventDefault();
          void navigator.clipboard.writeText(translated);
          flashCopied("已复制译文");
        }
        return;
      }
      // Ctrl/Cmd + Shift + C：复制组合（原文 + 译文）
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "C" || event.key === "c")) {
        if (status === "done" && translated && original) {
          event.preventDefault();
          const combo = `${original}\n\n${translated}`;
          void navigator.clipboard.writeText(combo);
          flashCopied("已复制原文+译文");
        }
        return;
      }
      // Ctrl/Cmd + R：重试（error retryable 时）
      if ((event.ctrlKey || event.metaKey) && event.key === "r") {
        if (status === "error" && retryable) {
          event.preventDefault();
          void retry();
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status, translated, original, retryable]);

  // 自动隐藏：浮窗失焦且未固定时，延迟 400ms 隐藏（对齐 Mac）。
  useEffect(() => {
    const unlistenPromise = panelWindow.onFocusChanged(({ payload: focused }) => {
      const canAutoHide = status === "idle" || status === "done";
      if (!focused && !pinned && canAutoHide && !resizingRef.current) {
        // 延迟以避免点击浮窗内按钮瞬间失焦导致误隐藏
        window.setTimeout(() => {
          if (!resizingRef.current) {
            void panelWindow.hide();
          }
        }, 400);
      }
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [pinned, status]);

  /** 切换最近一条历史记录的收藏状态。 */
  async function toggleFavorite() {
    if (!lastRecordId) return;
    await historyToggleFavorite(lastRecordId);
    setFavToggled((v) => !v);
  }

  return (
    <div style={panelShellStyle}>
      <div style={headerStyle}>
        <div
          style={dragHandleStyle}
          onPointerDown={(event) => void startManualDrag(event)}
          onPointerMove={(event) => void moveDraggedPanel(event)}
          onPointerUp={stopManualDrag}
          onPointerCancel={stopManualDrag}
          title="拖动移动窗口"
        >
          ImmersiveTranslator
        </div>
        <div style={actionsStyle}>
          {status === "done" && (
            <>
              <button
                style={smallBtnStyle}
                onClick={() => {
                  void navigator.clipboard.writeText(translated);
                  flashCopied("已复制译文");
                }}
                title="Ctrl+Enter"
              >
                复制
              </button>
              <button
                style={smallBtnStyle}
                onClick={() => {
                  void navigator.clipboard.writeText(`${original}\n\n${translated}`);
                  flashCopied("已复制原文+译文");
                }}
                title="Ctrl+Shift+C"
              >
                复制组合
              </button>
            </>
          )}
          {status === "error" && retryable && (
            <button style={smallBtnStyle} onClick={retry} title="Ctrl+R">
              重试
            </button>
          )}
          {status === "translating" && (
            <button
              style={smallBtnStyle}
              onClick={() => void cancelTranslation()}
              title="取消当前请求"
            >
              取消
            </button>
          )}
          {status === "done" && lastRecordId && (
            <button
              style={iconBtnStyle}
              onClick={() => void toggleFavorite()}
              title={favToggled ? "取消收藏" : "收藏"}
            >
              {favToggled ? "★" : "☆"}
            </button>
          )}
          <button
            style={pinned ? activeIconBtnStyle : iconBtnStyle}
            onClick={() => setPinned((v) => !v)}
            title={pinned ? "已固定（失焦不隐藏）" : "固定浮窗"}
          >
            📌
          </button>
          <button style={iconBtnStyle} onClick={() => openHistory()} title="翻译历史">
            ☰
          </button>
          <button style={iconBtnStyle} onClick={() => openSettings()} title="打开设置">
            ⚙
          </button>
          <button style={iconBtnStyle} onClick={() => void hidePanel()} title="关闭">
            ×
          </button>
        </div>
      </div>

      <div style={contentStyle}>
        {status === "needsConfig" && (
          <div style={needsConfigStyle}>
            <div style={{ marginBottom: 10 }}>尚未配置翻译接口。</div>
            <button style={openSettingsBtnStyle} onClick={() => openSettings()}>
              打开设置
            </button>
          </div>
        )}

        {(status === "reading" || status === "translating") && (
          <div style={loadingStyle}>
            {status === "reading"
              ? "正在读取选中文本..."
              : phaseLabel(phase, translated)}
            {elapsedMs > 0 && status === "translating" && (
              <div style={phaseTimingStyle}>{(elapsedMs / 1000).toFixed(1)}s</div>
            )}
            {status === "translating" && translated && (
              <div style={translatedStyle}>{translated}</div>
            )}
          </div>
        )}

        {status === "done" && (
          <>
            <div style={originalStyle}>{original}</div>
            <div style={translatedStyle}>{translated}</div>
            <div style={metaStyle}>
              {timing ? (
                <>
                  总耗时 {(timing.totalMs / 1000).toFixed(1)}s
                  <span style={timingBreakStyle}>
                    （连接 {fmtMs(timing.connectMs)} · 首字 {fmtMs(timing.firstTokenMs)}）
                    {slowHint(timing)}
                  </span>
                </>
              ) : (
                <>耗时 {(elapsedMs / 1000).toFixed(1)}s</>
              )}
            </div>
          </>
        )}

        {status === "idle" && (
          <div style={idleStyle}>
            选中任意文本，按热键翻译。
            <div style={shortcutHintStyle}>
              快捷键：Esc 关闭 · Ctrl+Enter 复制译文 · Ctrl+Shift+C 复制原文+译文 · Ctrl+R 重试
            </div>
          </div>
        )}

        {status === "error" && <div style={errorStyle}>{errorMsg}</div>}
      </div>

      {copiedHint && <div style={toastStyle}>{copiedHint}</div>}
      <div
        style={resizeHandleStyle}
        onPointerDown={(event) => void startResize("SouthEast", event)}
        title="拖动调整浮窗大小"
      />
    </div>
  );
}

function toInput(e: ErrorEvent) {
  switch (e.kind) {
    case "network":
      return { kind: "network" as const, message: e.body };
    case "timeout":
      return { kind: "timeout" as const };
    case "empty":
      return { kind: "emptyTranslation" as const };
    case "invalid":
      return { kind: "invalidResponse" as const, preview: e.body };
    case "http":
    default:
      return { kind: "http" as const, status: e.status ?? 0, body: e.body };
  }
}

const panelShellStyle: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 14,
  background: "rgba(255,255,255,0.98)",
  borderRadius: 10,
  color: "#222",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxSizing: "border-box",
  position: "relative",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontWeight: 600,
  color: "#666",
  fontSize: 12,
  gap: 8,
  padding: "10px 12px 8px",
  background: "rgba(255,255,255,0.98)",
  borderBottom: "1px solid rgba(0,0,0,0.06)",
  flexShrink: 0,
  position: "relative",
  zIndex: 2,
};
const contentStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "12px 14px 18px",
  minHeight: 0,
};
const dragHandleStyle: React.CSSProperties = {
  flex: 1,
  cursor: "move",
  userSelect: "none",
  padding: "5px 0",
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
};
const originalStyle: React.CSSProperties = { color: "#888", fontSize: 12, marginBottom: 6 };
const translatedStyle: React.CSSProperties = { lineHeight: 1.5 };
const metaStyle: React.CSSProperties = { color: "#aaa", fontSize: 11, marginTop: 10 };
const timingBreakStyle: React.CSSProperties = { color: "#bbb" };
const phaseTimingStyle: React.CSSProperties = {
  color: "#999",
  fontSize: 11,
  marginTop: 4,
};
const toastStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 12,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(0,0,0,0.78)",
  color: "#fff",
  padding: "4px 12px",
  borderRadius: 5,
  fontSize: 12,
  pointerEvents: "none",
};
const shortcutHintStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 10,
  color: "#bbb",
  lineHeight: 1.5,
};
const errorStyle: React.CSSProperties = { color: "#c0392b", lineHeight: 1.5 };
const loadingStyle: React.CSSProperties = { color: "#666" };
const idleStyle: React.CSSProperties = { color: "#aaa", fontSize: 12 };
const needsConfigStyle: React.CSSProperties = { color: "#555", textAlign: "center", padding: 8 };
const smallBtnStyle: React.CSSProperties = {
  fontSize: 11,
  border: "1px solid #ddd",
  background: "#fff",
  borderRadius: 4,
  padding: "2px 8px",
  cursor: "pointer",
};
const iconBtnStyle: React.CSSProperties = {
  ...smallBtnStyle,
  width: 24,
  padding: "2px 0",
};
/** 固定等激活状态的图标按钮。 */
const activeIconBtnStyle: React.CSSProperties = {
  ...iconBtnStyle,
  background: "#dbeafe",
  borderColor: "#2563eb",
  color: "#2563eb",
};
const openSettingsBtnStyle: React.CSSProperties = {
  padding: "5px 14px",
  border: "none",
  background: "#2563eb",
  color: "#fff",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
const resizeHandleStyle: React.CSSProperties = {
  position: "fixed",
  right: 0,
  bottom: 0,
  width: 18,
  height: 18,
  cursor: "nwse-resize",
  zIndex: 5,
  background:
    "linear-gradient(135deg, transparent 0 45%, rgba(0,0,0,0.22) 46% 52%, transparent 53% 62%, rgba(0,0,0,0.22) 63% 69%, transparent 70%)",
};
