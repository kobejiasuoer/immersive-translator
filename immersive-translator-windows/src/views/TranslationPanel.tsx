import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import {
  translateStream,
  openSettings,
  onTranslationDelta,
  onTranslationDone,
  onTranslationError,
  type DoneEvent,
  type ErrorEvent,
} from "../lib/tauriBridge";
import { loadSettings, hasValidSettings } from "../lib/settingsStore";
import { classifyTranslationError } from "../core/errorMessageFormatter";
import { resolveTargetLanguage } from "../core/languageDetect";
import { buildSystemPrompt } from "../core/promptBuilder";

type Status = "idle" | "reading" | "translating" | "done" | "error" | "needsConfig";

const panelWindow = getCurrentWindow();

export function TranslationPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translated, setTranslated] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [retryable, setRetryable] = useState(false);
  const lastOriginalRef = useRef("");
  const dragStateRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const dragMovePendingRef = useRef(false);

  useEffect(() => {
    let unDelta: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    let unErr: (() => void) | undefined;

    onTranslationDelta((e) => {
      setTranslated(e.text);
      setElapsedMs(e.elapsed_ms);
    }).then((u) => (unDelta = u));

    onTranslationDone((e: DoneEvent) => {
      setTranslated(e.text);
      setElapsedMs(e.elapsed_ms);
      setStatus("done");
    }).then((u) => (unDone = u));

    onTranslationError((e: ErrorEvent) => {
      const classified = classifyTranslationError(toInput(e));
      setErrorMsg(classified.message);
      setRetryable(classified.retryable);
      setStatus("error");
    }).then((u) => (unErr = u));

    return () => {
      unDelta?.();
      unDone?.();
      unErr?.();
    };
  }, []);

  async function doTranslate(text: string) {
    const s = loadSettings();
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
      setErrorMsg(`翻译命令调用失败：${message}`);
      setRetryable(true);
      setStatus("error");
    }
  }

  async function triggerWithText(text: string) {
    const s = loadSettings();
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
    setOriginal(text);
    setTranslated("");
    setErrorMsg("");
    setStatus("translating");
    await doTranslate(text);
  }

  async function retry() {
    if (lastOriginalRef.current) {
      await doTranslate(lastOriginalRef.current);
    }
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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("panel:shown", (event) => triggerWithText(event.payload ?? "")).then(
      (u) => (unlisten = u),
    );
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void hidePanel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div style={panelStyle}>
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
            <button style={smallBtnStyle} onClick={() => navigator.clipboard.writeText(translated)}>
              复制
            </button>
          )}
          {status === "error" && retryable && (
            <button style={smallBtnStyle} onClick={retry}>
              重试
            </button>
          )}
          <button style={iconBtnStyle} onClick={() => openSettings()} title="打开设置">
            ⚙
          </button>
          <button style={iconBtnStyle} onClick={() => void hidePanel()} title="关闭">
            ×
          </button>
        </div>
      </div>

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
          {status === "reading" ? "正在读取选中文本..." : "翻译中..."}
          {status === "translating" && translated && (
            <div style={translatedStyle}>{translated}</div>
          )}
        </div>
      )}

      {status === "done" && (
        <>
          <div style={originalStyle}>{original}</div>
          <div style={translatedStyle}>{translated}</div>
          <div style={metaStyle}>耗时 {(elapsedMs / 1000).toFixed(1)}s</div>
        </>
      )}

      {status === "idle" && (
        <div style={idleStyle}>选中任意文本，按 Ctrl+Shift+Q 翻译。</div>
      )}

      {status === "error" && <div style={errorStyle}>{errorMsg}</div>}
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

const panelStyle: React.CSSProperties = {
  padding: 14,
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 14,
  background: "rgba(255,255,255,0.98)",
  borderRadius: 10,
  color: "#222",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontWeight: 600,
  marginBottom: 8,
  color: "#666",
  fontSize: 12,
  gap: 8,
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
};
const originalStyle: React.CSSProperties = { color: "#888", fontSize: 12, marginBottom: 6 };
const translatedStyle: React.CSSProperties = { lineHeight: 1.5 };
const metaStyle: React.CSSProperties = { color: "#aaa", fontSize: 11, marginTop: 8 };
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
const openSettingsBtnStyle: React.CSSProperties = {
  padding: "5px 14px",
  border: "none",
  background: "#2563eb",
  color: "#fff",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
