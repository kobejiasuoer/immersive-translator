import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  readSelection,
  translateStream,
  onTranslationDelta,
  onTranslationDone,
  onTranslationError,
  type DoneEvent,
  type ErrorEvent,
} from "../lib/tauriBridge";
import { loadSettings } from "../lib/settingsStore";
import { classifyTranslationError } from "../core/errorMessageFormatter";
import { resolveTargetLanguage } from "../core/languageDetect";
import { buildSystemPrompt } from "../core/promptBuilder";

type Status = "idle" | "reading" | "translating" | "done" | "error";

export function TranslationPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translated, setTranslated] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [retryable, setRetryable] = useState(false);
  const lastOriginalRef = useRef("");

  // 监听翻译事件
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
    const settings = loadSettings();
    const target = resolveTargetLanguage(text, {
      mode: settings.translationMode,
      fixed: settings.fixedTarget,
    });
    const systemPrompt = buildSystemPrompt({
      targetLanguage: target,
      customStyle: settings.customStyle,
      glossaryText: settings.glossaryText,
    });

    setStatus("translating");
    setTranslated("");
    setErrorMsg("");

    await translateStream({
      text,
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      systemPrompt,
      stream: settings.stream,
      windowLabel: "panel",
    });
  }

  async function triggerFromHotkey() {
    setStatus("reading");
    setOriginal("");
    setTranslated("");
    setErrorMsg("");
    const text = await readSelection();
    if (!text) {
      setErrorMsg("没有读取到选中的文本。请先在任意应用里选中文本。");
      setRetryable(false);
      setStatus("error");
      return;
    }
    lastOriginalRef.current = text;
    setOriginal(text);
    await doTranslate(text);
  }

  async function retry() {
    if (lastOriginalRef.current) {
      await doTranslate(lastOriginalRef.current);
    }
  }

  // Rust 端在 panel.show() 后 emit "panel:shown"，前端监听后触发翻译
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("panel:shown", () => triggerFromHotkey()).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>ImmersiveTranslator</span>
        {status === "done" && (
          <button style={copyBtnStyle} onClick={() => navigator.clipboard.writeText(translated)}>
            复制
          </button>
        )}
        {status === "error" && retryable && (
          <button style={copyBtnStyle} onClick={retry}>
            重新翻译
          </button>
        )}
      </div>

      {(status === "reading" || status === "translating") && (
        <div style={loadingStyle}>
          {status === "reading" ? "正在读取选中文本…" : "翻译中…"}
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

      {status === "error" && <div style={errorStyle}>{errorMsg}</div>}
    </div>
  );
}

// 把 Rust 错误事件转成 classifyTranslationError 的输入
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
};
const originalStyle: React.CSSProperties = { color: "#888", fontSize: 12, marginBottom: 6 };
const translatedStyle: React.CSSProperties = { lineHeight: 1.5 };
const metaStyle: React.CSSProperties = { color: "#aaa", fontSize: 11, marginTop: 8 };
const errorStyle: React.CSSProperties = { color: "#c0392b", lineHeight: 1.5 };
const loadingStyle: React.CSSProperties = { color: "#666" };
const copyBtnStyle: React.CSSProperties = {
  fontSize: 11,
  border: "1px solid #ddd",
  background: "#fff",
  borderRadius: 4,
  padding: "2px 8px",
  cursor: "pointer",
};
