import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import {
  IconCopy,
  IconCopyAll,
  IconPin,
  IconClock,
  IconSettings,
  IconClose,
  IconStar,
  IconRetry,
  IconStop,
  IconTranslate,
  IconCheck,
  IconAlertCircle,
} from "../ui/icons";

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
    return "连接偏慢：网络到服务商延迟高，或需要代理";
  }
  if (t.firstTokenMs > 5000) {
    return "首字偏慢：模型推理或排队耗时";
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
  /** 来源（选中/OCR）角标。 */
  const [panelSource, setPanelSource] = useState<PanelSource>("selection");
  const lastOriginalRef = useRef("");
  const lastEndpointRef = useRef("");
  const lastApiKeyRef = useRef("");
  const lastSourceRef = useRef<PanelSource>("selection");
  const lastPanelPayloadRef = useRef("");
  const lastPanelPayloadAtRef = useRef(0);
  const lastDoneHistoryKeyRef = useRef("");
  const dragStateRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const dragMovePendingRef = useRef(false);
  /** 最近一次窗口缩放（含原生 startResizeDragging）的时间戳。
   *  失焦隐藏检查时据此判断是否仍处于"缩放刚结束"的缓冲期，避免缩放松手瞬间的失焦把浮窗误隐藏。 */
  const lastResizeAtRef = useRef(0);
  /** 缩放抑制隐藏的缓冲窗口（毫秒）：onResized 每次刷新 lastResizeAt，失焦检查看距今是否在此窗口内。 */
  const RESIZE_HIDE_SUPPRESS_MS = 800;

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
      const trimmed = lastOriginalRef.current.trim();
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
    setPanelSource(source);
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

  async function startManualDrag(event: ReactPointerEvent<HTMLDivElement>) {
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

  async function moveDraggedPanel(event: ReactPointerEvent<HTMLDivElement>) {
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

  function stopManualDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
  }

  async function startResize(direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    // 标记缩放起点，覆盖 onResized 首帧到来前的空档，避免按下瞬间的失焦误隐藏。
    lastResizeAtRef.current = Date.now();
    // startResizeDragging 是非阻塞的原生调用（交由 OS 处理 WM_SIZE），会立即返回；
    // 缩放过程中的尺寸变化由 onResized 监听持续刷新 lastResizeAt，无需在这里靠定时器盲猜。
    await panelWindow.startResizeDragging(direction);
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

  // 监听原生缩放（含右下角 startResizeDragging 与系统最大化的尺寸变化），
  // 持续刷新 lastResizeAt。原生缩放过程中 JS pointer 事件不触发，只能靠这个事件感知。
  useEffect(() => {
    const unlistenPromise = panelWindow.onResized(() => {
      lastResizeAtRef.current = Date.now();
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, []);

  // 自动隐藏：浮窗失焦且未固定时，延迟 400ms 隐藏（对齐 Mac）。
  // 排除三种情况：正在拖动标题栏、缩放刚结束的缓冲期内、翻译进行中。
  useEffect(() => {
    const unlistenPromise = panelWindow.onFocusChanged(({ payload: focused }) => {
      const canAutoHide = status === "idle" || status === "done";
      if (focused || pinned || !canAutoHide) return;
      if (dragStateRef.current) return; // 正在拖动标题栏
      // 延迟以避免点击浮窗内按钮瞬间失焦导致误隐藏
      window.setTimeout(() => {
        const sinceResize = Date.now() - lastResizeAtRef.current;
        if (dragStateRef.current || sinceResize < RESIZE_HIDE_SUPPRESS_MS) {
          return; // 缩放缓冲期内或仍在拖动，不隐藏
        }
        void panelWindow.hide();
      }, 400);
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

  /** 当前是否有可用操作按钮集（控制头部折叠）。 */
  const canCopy = status === "done" && !!translated;
  const canRetry = status === "error" && retryable;

  /** 原文角标文案。 */
  const sourceLabel = panelSource === "ocr" ? "OCR" : "选中";
  const stateDot = {
    title: status === "translating" ? "翻译中" : status === "done" ? "完成" : "",
    className: status === "translating" ? "dot-pulse" : "",
  };

  return (
    <div className="panel-root">
      {/* 标题栏 */}
      <header className="panel-header">
        <div className="panel-title"
          onPointerDown={(event) => void startManualDrag(event)}
          onPointerMove={(event) => void moveDraggedPanel(event)}
          onPointerUp={stopManualDrag}
          onPointerCancel={stopManualDrag}
          title="拖动移动窗口"
        >
          <span className="panel-logo" aria-hidden>
            <IconTranslate size={13} />
          </span>
          <span className="app-name">ImmersiveTranslator</span>
          {stateDot.className && <span className={stateDot.className} title={stateDot.title} />}
          {sourceLabel && (status === "done" || status === "translating" || status === "error") && (
            <span className={`chip chip-${panelSource === "ocr" ? "amber" : "blue"}`}>{sourceLabel}</span>
          )}
        </div>

        <div className="panel-actions">
          {/* 原文+译文一键复制：常驻但仅 done 可用 */}
          <button
            className="icon-btn"
            onClick={() => {
              if (canCopy && original) {
                void navigator.clipboard.writeText(`${original}\n\n${translated}`);
                flashCopied("已复制原文+译文");
              }
            }}
            disabled={!canCopy || !original}
            title="复制原文+译文 (Ctrl+Shift+C)"
          >
            <IconCopyAll size={15} />
          </button>
          {/* 取消/重试 */}
          {status === "translating" && (
            <button className="icon-btn" onClick={() => void cancelTranslation()} title="取消当前请求">
              <IconStop size={15} />
            </button>
          )}
          {canRetry && (
            <button className="icon-btn" onClick={() => void retry()} title="重试 (Ctrl+R)">
              <IconRetry size={15} />
            </button>
          )}
          {status === "done" && lastRecordId && (
            <button
              className={`icon-btn${favToggled ? " active" : ""}`}
              onClick={() => void toggleFavorite()}
              title={favToggled ? "取消收藏" : "收藏到历史"}
            >
              <IconStar size={15} filled={favToggled} />
            </button>
          )}
          <button
            className={`icon-btn${pinned ? " active" : ""}`}
            onClick={() => setPinned((v) => !v)}
            title={pinned ? "已固定，失焦不隐藏" : "固定浮窗"}
          >
            <IconPin size={15} />
          </button>
          <button className="icon-btn" onClick={() => openHistory()} title="翻译历史">
            <IconClock size={15} />
          </button>
          <button className="icon-btn" onClick={() => openSettings()} title="设置">
            <IconSettings size={15} />
          </button>
          <button className="icon-btn" onClick={() => void hidePanel()} title="关闭 (Esc)">
            <IconClose size={15} />
          </button>
        </div>
      </header>

      {/* 内容区 */}
      <div className="panel-body">
        {status === "needsConfig" && (
          <div className="center-state">
            <div className="big" aria-hidden>
              <IconSettings size={30} />
            </div>
            <div className="title">先配置翻译接口</div>
            <div className="sub">
              在设置中选择服务商并填入 API Key，之后选中文本按热键即可翻译。
            </div>
            <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => openSettings()}>
              <IconSettings size={14} />
              打开设置
            </button>
          </div>
        )}

        {(status === "reading" || status === "translating") && (
          <div className="loading-block">
            {original && (
              <div className="orig-block">
                <div className="orig-label">原文 · {sourceLabel}</div>
                <div className="orig-text">{original}</div>
              </div>
            )}
            <div className="loading-line">
              {status === "reading" ? (
                <>
                  <span className="spinner" />
                  正在读取选中文本…
                </>
              ) : (
                <>
                  <span className="spinner" />
                  {phaseLabel(phase, translated)}
                  {elapsedMs > 0 && (
                    <span className="mono-ms">{(elapsedMs / 1000).toFixed(1)}s</span>
                  )}
                </>
              )}
            </div>
            {translated ? (
              <div className="trans-block">
                <div className="trans-label">译文</div>
                <div className="trans-text caret">{translated}</div>
              </div>
            ) : (
              <div className="skeleton-block" aria-hidden>
                <span className="skeleton-line" style={{ width: "96%" }} />
                <span className="skeleton-line" style={{ width: "82%" }} />
                <span className="skeleton-line" style={{ width: "58%" }} />
              </div>
            )}
          </div>
        )}

        {status === "done" && (
          <>
            {original && (
              <div className="orig-block">
                <div className="orig-label">原文 · {sourceLabel}</div>
                <div className="orig-text">{original}</div>
              </div>
            )}
            <div className="trans-block">
              <div className="trans-row">
                <div className="trans-label">
                  <IconTranslate size={11} />
                  译文
                </div>
                <div className="trans-actions">
                  {translated && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(translated);
                        flashCopied("已复制译文");
                      }}
                      title="Ctrl+Enter"
                    >
                      <IconCopy size={13} />
                      复制译文
                    </button>
                  )}
                </div>
              </div>
              <div className="trans-text">{translated}</div>
            </div>
            <div className="panel-meta">
              {timing ? (
                <>
                  <span>
                    总耗时 <strong>{(timing.totalMs / 1000).toFixed(1)}s</strong>
                  </span>
                  <span className="meta-break">
                    连接 {fmtMs(timing.connectMs)} · 首字 {fmtMs(timing.firstTokenMs)}
                  </span>
                  {slowHint(timing) && <span className="meta-slow">{slowHint(timing)}</span>}
                </>
              ) : (
                <span>耗时 {(elapsedMs / 1000).toFixed(1)}s</span>
              )}
            </div>
          </>
        )}

        {status === "error" && (
          <div className="error-block">
            <div className="error-title">
              <IconAlertCircle size={15} />
              翻译失败
            </div>
            <div className="error-text">{errorMsg}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              {canRetry && (
                <button className="btn btn-primary btn-sm" onClick={() => void retry()}>
                  <IconRetry size={13} />
                  重试
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => openSettings()}>
                <IconSettings size={13} />
                去设置检查
              </button>
            </div>
          </div>
        )}

        {status === "idle" && (
          <div className="center-state">
            <div className="big" aria-hidden>
              <IconTranslate size={30} />
            </div>
            <div className="title">选中文本，即译即达</div>
            <div className="sub">
              在任意应用中选中文字，按 <span className="kbd">Ctrl</span>+
              <span className="kbd">Shift</span>+<span className="kbd">Q</span> 唤起翻译；
              <span className="kbd">Ctrl</span>+<span className="kbd">Shift</span>+
              <span className="kbd">E</span> 截图 OCR。
            </div>
            <div className="shortcut-hint">
              Esc 关闭 · Ctrl+Enter 复制译文 · Ctrl+Shift+C 复制原文+译文 · Ctrl+R 重试
            </div>
          </div>
        )}
      </div>

      {copiedHint && (
        <div className="toast">
          <IconCheck size={13} />
          {copiedHint}
        </div>
      )}

      {/* 右下角缩放手柄 */}
      <div
        className="resize-handle"
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
