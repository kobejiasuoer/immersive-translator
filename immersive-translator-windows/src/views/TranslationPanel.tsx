import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  cursorPosition,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
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
  onTtsEnded,
  ttsSpeak,
  ttsStop,
  historyAdd,
  historyToggleFavorite,
  clearPendingPanelPayload,
  takePendingPanelPayload,
  type DoneEvent,
  type ErrorEvent,
  type HistorySource,
  type PanelPayload,
  type PanelSource,
  type TranslationPhase,
} from "../lib/tauriBridge";
import { loadSettingsAsync, hasValidSettings } from "../lib/settingsStore";
import { readerSaveArticle } from "../lib/readerStore";
import { buildArticleFromText } from "../core/articleBuilder";
import {
  classifyTranslationError,
  sanitizeDiagnosticText,
} from "../core/errorMessageFormatter";
import { resolveTargetLanguage, looksMostlyChinese } from "../core/languageDetect";
import { isLookupText } from "../core/dictDetect";
import {
  parseDictResponse,
  cardToText,
  type DictCardData,
} from "../core/dictCard";
import {
  buildSystemPrompt,
  buildActionSystemPrompt,
  buildDictionaryPrompt,
  type QuickAction,
} from "../core/promptBuilder";
import { DictCard } from "./DictCard";
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
  IconVolume,
  IconSparkles,
  IconBookOpen,
  IconList,
  IconShuffle,
  IconSendToReader,
} from "../ui/icons";

type Status = "idle" | "reading" | "translating" | "done" | "error" | "needsConfig";
type PanelShownPayload = string | Partial<PanelPayload>;
type ResizeDirection = "East" | "South" | "SouthEast";

/** 正在朗读的文本位置：原文 / 译文 / 动作结果 / 词典词条。 */
type SpeakTarget = "original" | "translated" | "action" | "dict";

type QuickActionStatus = "streaming" | "done" | "error";

interface QuickActionState {
  type: QuickAction;
  status: QuickActionStatus;
  text: string;
  errorMsg: string;
}

/** 译文下方快捷动作条的定义（LLM prompt 变体）。 */
const QUICK_ACTIONS: {
  type: QuickAction;
  label: string;
  title: string;
  Icon: typeof IconSparkles;
}[] = [
  { type: "polish", label: "润色", title: "在保持原意的前提下让译文更通顺自然", Icon: IconSparkles },
  { type: "grammar", label: "解释语法", title: "拆解原文句子结构与语法点", Icon: IconBookOpen },
  { type: "summarize", label: "总结", title: "用要点概括原文内容", Icon: IconList },
  { type: "rephrase", label: "换种说法", title: "给出 3 种不同风格的备选译文", Icon: IconShuffle },
];

const panelWindow = getCurrentWindow();

// ---- 浮窗位置/大小记忆（localStorage，物理像素 + 缩放比）----
interface PanelGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}
const PANEL_GEOMETRY_KEY = "immersive-translator-panel-geometry";

function loadPanelGeometry(): PanelGeometry | null {
  try {
    const raw = localStorage.getItem(PANEL_GEOMETRY_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as PanelGeometry;
    if (
      Number.isFinite(g.x) &&
      Number.isFinite(g.y) &&
      Number.isFinite(g.w) &&
      Number.isFinite(g.h) &&
      Number.isFinite(g.scale) &&
      g.scale > 0
    ) {
      return g;
    }
    return null;
  } catch {
    return null;
  }
}

function savePanelGeometry(g: PanelGeometry) {
  try {
    localStorage.setItem(PANEL_GEOMETRY_KEY, JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

/** 读取窗口当前位置/尺寸并持久化（供下次启动恢复）。 */
async function persistPanelGeometry() {
  try {
    const [pos, size, scale] = await Promise.all([
      panelWindow.outerPosition(),
      panelWindow.outerSize(),
      panelWindow.scaleFactor(),
    ]);
    savePanelGeometry({ x: pos.x, y: pos.y, w: size.width, h: size.height, scale });
  } catch {
    /* ignore */
  }
}
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
  /** 等待用户手动 Ctrl+C 的提示态（自动读取被安全软件拦截时）。 */
  const [awaitCopyHint, setAwaitCopyHint] = useState(false);
  /** 快捷动作（润色/语法/总结/换种说法）的运行状态，独立于主翻译结果展示。 */
  const [quickAction, setQuickAction] = useState<QuickActionState | null>(null);
  /** 词典卡片数据：后台预取完成且解析成功时存在。 */
  const [dictCardData, setDictCardData] = useState<DictCardData | null>(null);
  /** 词典预取状态：hidden=非词条/未开启；querying=后台查询中；ready=可秒开；error=可点击重试。 */
  const [dictStatus, setDictStatus] = useState<
    "hidden" | "querying" | "ready" | "error"
  >("hidden");
  /** done 态当前展示的视图：false=译文，true=词典卡片。 */
  const [dictView, setDictView] = useState(false);
  /** 正在朗读的位置；null 表示未在朗读。 */
  const [speaking, setSpeaking] = useState<SpeakTarget | null>(null);
  /** 当前事件归属：主翻译流还是快捷动作流。词典预取不经过 flowRef，按 tag 路由。 */
  const flowRef = useRef<"translate" | "action">("translate");
  /** 主流程（翻译/快捷动作）当前请求 tag；事件 tag 不匹配即视为过期请求，直接丢弃。 */
  const mainTagRef = useRef("");
  /** 词典预取请求 tag；与主流程并行跑，事件按各自的 tag 各行其路。 */
  const dictTagRef = useRef("");
  const requestSeqRef = useRef(0);
  /** 最近一次朗读的代数；tts:ended 只处理与其匹配的事件。 */
  const ttsGenRef = useRef<number | null>(null);
  const lastOriginalRef = useRef("");
  const lastEndpointRef = useRef("");
  const lastApiKeyRef = useRef("");
  const lastSourceRef = useRef<HistorySource>("selection");
  const lastPanelPayloadRef = useRef("");
  const lastPanelPayloadAtRef = useRef(0);
  const lastDoneHistoryKeyRef = useRef("");
  /** done 态原文编辑框（高度跟随内容）。 */
  const origEditRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStateRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const dragMovePendingRef = useRef(false);
  /** 最近一次窗口缩放（含原生 startResizeDragging）的时间戳。
   *  失焦隐藏检查时据此判断是否仍处于"缩放刚结束"的缓冲期，避免缩放松手瞬间的失焦把浮窗误隐藏。 */
  const lastResizeAtRef = useRef(0);
  /** 缩放抑制隐藏的缓冲窗口（毫秒）：onResized 每次刷新 lastResizeAt，失焦检查看距今是否在此窗口内。 */
  const RESIZE_HIDE_SUPPRESS_MS = 800;
  /** 位置/大小记忆的防抖计时器。 */
  const geometryTimerRef = useRef<number | null>(null);

  /** 拖拽/缩放结束后（600ms 防抖）持久化浮窗几何信息。 */
  function scheduleGeometrySave() {
    if (geometryTimerRef.current !== null) {
      window.clearTimeout(geometryTimerRef.current);
    }
    geometryTimerRef.current = window.setTimeout(() => {
      geometryTimerRef.current = null;
      void persistPanelGeometry();
    }, 600);
  }

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
      if (e.tag === dictTagRef.current) return; // 词典响应是 JSON，增量无渲染意义
      if (e.tag !== mainTagRef.current) return; // 过期请求（已被新翻译/动作取代）
      if (flowRef.current === "action") {
        setQuickAction((q) => (q ? { ...q, text: e.text } : q));
        return;
      }
      setTranslated(e.text);
      setElapsedMs(e.elapsedMs);
    }).then((u) => {
      if (active) unDelta = u;
      else u();
    });

    onTranslationStatus((e) => {
      if (!active) return;
      if (e.tag === dictTagRef.current) return; // 预取不展示分阶段文案
      if (e.tag !== mainTagRef.current) return;
      if (flowRef.current !== "translate") return; // 动作流不展示分阶段文案
      setPhase(e.phase);
      setElapsedMs(e.elapsedMs);
    }).then((u) => {
      if (active) unStatus = u;
      else u();
    });

    onTranslationDone((e: DoneEvent) => {
      if (!active) return;
      if (e.tag === dictTagRef.current) {
        // 词典预取完成：解析出卡片置为就绪；模型判定非词条则收起入口；
        // 解析失败给可重试态。词典不落历史，历史只记主翻译。
        const query = lastOriginalRef.current.trim();
        const result = parseDictResponse(e.text, query);
        if (result.kind === "card") {
          setDictCardData(result.card);
          setDictStatus("ready");
        } else if (result.kind === "notAWord") {
          setDictStatus("hidden");
          setDictView(false);
        } else {
          setDictStatus("error");
        }
        return;
      }
      if (e.tag !== mainTagRef.current) return;
      if (flowRef.current === "action") {
        // 动作结果只更新动作区，不覆盖译文、不落历史。
        setQuickAction((q) => (q ? { ...q, status: "done", text: e.text } : q));
        return;
      }
      setElapsedMs(e.elapsedMs);
      setTiming({ connectMs: e.connectMs, firstTokenMs: e.firstTokenMs, totalMs: e.elapsedMs });
      setPhase("done");
      setTranslated(e.text);
      setStatus("done");
      recordHistory(lastOriginalRef.current.trim(), e.text.trim(), e.elapsedMs);
    }).then((u) => {
      if (active) unDone = u;
      else u();
    });

    onTranslationError((e: ErrorEvent) => {
      if (!active) return;
      if (e.tag === dictTagRef.current) {
        setDictStatus("error"); // 预取失败：按钮变可重试，不影响主翻译
        return;
      }
      if (e.tag !== mainTagRef.current) return;
      const classified = classifyTranslationError(
        toInput(e),
        lastEndpointRef.current,
        lastApiKeyRef.current,
      );
      if (flowRef.current === "action") {
        setQuickAction((q) =>
          q ? { ...q, status: "error", errorMsg: classified.message } : q,
        );
        return;
      }
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
      if (e.tag === dictTagRef.current) {
        setDictStatus("error"); // 预取被停止：给重试入口
        return;
      }
      if (e.tag !== mainTagRef.current) return;
      if (flowRef.current === "action") {
        // 用户取消动作：保留已生成的部分，动作区进入 done 态
        setQuickAction((q) => (q ? { ...q, status: "done", text: e.partial } : q));
        return;
      }
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

  /** 清空快捷动作状态并停止朗读（新翻译开始 / 面板关闭时调用）。 */
  function resetQuickAction() {
    flowRef.current = "translate";
    setQuickAction(null);
    stopSpeaking();
  }

  /** 翻译/查词完成后落库（fire-and-forget，失败不影响展示）。只依赖 ref 和 setter，闭包安全。 */
  function recordHistory(original: string, translation: string, elapsed: number) {
    if (!original || !translation) return;
    const historyKey = `${lastSourceRef.current}\u0000${original}\u0000${translation}\u0000${elapsed}`;
    if (lastDoneHistoryKeyRef.current === historyKey) {
      return;
    }
    lastDoneHistoryKeyRef.current = historyKey;
    // 目标语言此刻未知（doTranslate 里算的），这里用 settings 简单推断
    void loadSettingsAsync()
      .then((s) =>
        historyAdd(
          original,
          translation,
          resolveTargetLanguage(original, {
            mode: s.translationMode,
            fixed: s.fixedTarget,
          }),
          lastSourceRef.current,
          s.model,
          elapsed,
        ),
      )
      .then((rec) => setLastRecordId(rec.id))
      .catch((error) => console.error("[history] settings load or add failed", error));
  }

  /**
   * 发起主流程翻译。默认永远是普通翻译（词条也不例外）；若开启词典卡片且文本
   * 像词条，同时在后台预取词典（与主翻译并行，事件按 tag 各行其路）。
   */
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

    resetQuickAction();

    setStatus("translating");
    setTranslated("");
    setErrorMsg("");
    setPhase(null);
    setTiming(null);
    setLastRecordId(null);
    setFavToggled(false);
    lastDoneHistoryKeyRef.current = "";
    // 词典视图复位；词条类文本置为查询中并后台预取
    setDictView(false);
    setDictCardData(null);
    const wantsDict = s.dictCard === "auto" && isLookupText(text);
    setDictStatus(wantsDict ? "querying" : "hidden");

    const tag = `t${++requestSeqRef.current}`;
    mainTagRef.current = tag;
    // 不 await：主请求与词典预取并行，结果由事件按 tag 分发
    translateStream({
      text,
      endpoint: s.endpoint,
      apiKey: s.apiKey,
      model: s.model,
      systemPrompt,
      stream: s.stream,
      windowLabel: "panel",
      tag,
    }).catch((error) => {
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
    });

    if (wantsDict) {
      void lookupDict(text);
    }
  }

  /** 发起（或重试）词典预取查询。与主翻译并行，事件按 dictTagRef 路由，不落历史。 */
  async function lookupDict(text: string) {
    const s = await loadSettingsSafely();
    if (s === null) return;
    if (!hasValidSettings(s)) {
      setDictStatus("hidden");
      return;
    }
    const target = resolveTargetLanguage(text, {
      mode: s.translationMode,
      fixed: s.fixedTarget,
    });
    const tag = `d${++requestSeqRef.current}`;
    dictTagRef.current = tag;
    setDictCardData(null);
    setDictStatus("querying");
    try {
      await translateStream({
        text,
        endpoint: s.endpoint,
        apiKey: s.apiKey,
        model: s.model,
        systemPrompt: buildDictionaryPrompt({
          targetLanguage: target,
          customStyle: s.customStyle,
          glossaryText: s.glossaryText,
        }),
        stream: s.stream,
        windowLabel: "panel",
        tag,
      });
    } catch {
      setDictStatus("error");
    }
  }

  async function triggerWithText(text: string, source: PanelSource = "selection") {
    const s = await loadSettingsSafely();
    if (s === null) return;
    setAwaitCopyHint(false);
    resetQuickAction();
    if (!hasValidSettings(s)) {
      setStatus("needsConfig");
      return;
    }
    if (source === "error") {
      // Rust 端发来的错误：直接把错误消息当面板内容展示，不调翻译接口。
      setErrorMsg(text || "发生未知错误");
      setRetryable(false);
      setStatus("error");
      return;
    }
    if (source === "awaitCopy") {
      // 自动读取未取得选区时的等待态：提示用户按真实 Ctrl+C，
      // 后端监听到剪贴板变化后会再发 source=selection 的负载触发翻译。
      setOriginal("");
      setTranslated("");
      setErrorMsg("");
      setStatus("reading");
      setAwaitCopyHint(true);
      return;
    }
    if (!text || !text.trim()) {
      setErrorMsg("没有读取到选中的文本。请先在任意应用里选中文本。");
      setRetryable(false);
      setStatus("error");
      return;
    }
    lastOriginalRef.current = text;
    // source 在前面已 narrow 到 "selection" | "ocr"（error 已提前返回），
    // 这里多走一层显式断言避免 ref 泛型与 PanelSource 冲突。
    lastSourceRef.current = source === "ocr" ? "ocr" : "selection";
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

  /** 用户已修改原文且尚未重新翻译（done 态显示「重新翻译」按钮）。 */
  const canRetranslate =
    status === "done" && !!original.trim() && original !== lastOriginalRef.current;

  /** 用编辑后的原文重新发起翻译，保持原来源标签（选中/OCR）。 */
  async function retranslateFromEditor() {
    const text = original;
    if (!text.trim()) return;
    await triggerWithText(text, panelSource === "ocr" ? "ocr" : "selection");
  }

  /** 短暂显示复制提示（2 秒后消失）。 */
  function flashCopied(msg: string) {
    setCopiedHint(msg);
    setTimeout(() => setCopiedHint(""), 2000);
  }

  /** 停止朗读并复位朗读状态（面板隐藏、新翻译开始时调用）。 */
  function stopSpeaking() {
    ttsGenRef.current = null;
    setSpeaking(null);
    void ttsStop().catch((error) => console.error("[tts] stop failed", error));
  }

  /** 朗读一段文本；再次点击同一处即停止。中文文本自动选中文声音。 */
  async function speakText(target: SpeakTarget, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (speaking === target) {
      stopSpeaking();
      return;
    }
    try {
      const gen = await ttsSpeak(trimmed, looksMostlyChinese(trimmed));
      ttsGenRef.current = gen;
      setSpeaking(target);
    } catch (error) {
      console.error("[tts] speak failed", error);
      ttsGenRef.current = null;
      setSpeaking(null);
      const message = typeof error === "string" ? error : String(error);
      flashCopied(`朗读失败：${message}`);
    }
  }

  /** 运行快捷动作（润色/解释语法/总结/换种说法）：复用翻译流式管线，仅换系统提示词。 */
  async function runQuickAction(type: QuickAction) {
    if (status !== "done" || !translated.trim()) return;
    if (quickAction?.status === "streaming") return;
    const s = await loadSettingsSafely();
    if (s === null) return;
    if (!hasValidSettings(s)) {
      setStatus("needsConfig");
      return;
    }
    const source = (lastOriginalRef.current.trim() || original).trim();
    if (!source) return;
    const target = resolveTargetLanguage(source, {
      mode: s.translationMode,
      fixed: s.fixedTarget,
    });
    const systemPrompt = buildActionSystemPrompt(type, {
      targetLanguage: target,
      customStyle: s.customStyle,
      glossaryText: s.glossaryText,
    });
    // polish 需要"原文 + 草稿译文"两段输入；其余动作直接基于原文。
    const text =
      type === "polish"
        ? `<source>\n${source}\n</source>\n<draft_translation>\n${translated.trim()}\n</draft_translation>`
        : source;

    flowRef.current = "action";
    const tag = `a${++requestSeqRef.current}`;
    mainTagRef.current = tag;
    setQuickAction({ type, status: "streaming", text: "", errorMsg: "" });

    try {
      await translateStream({
        text,
        endpoint: s.endpoint,
        apiKey: s.apiKey,
        model: s.model,
        systemPrompt,
        stream: s.stream,
        windowLabel: "panel",
        tag,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQuickAction({
        type,
        status: "error",
        text: "",
        errorMsg: sanitizeDiagnosticText(message, s.endpoint, s.apiKey),
      });
    }
  }

  async function hidePanel() {
    void persistPanelGeometry(); // 隐藏前保存当前位置，下次打开仍停在你放的位置
    stopSpeaking();
    await panelWindow.hide();
  }

  // 朗读结束事件：只处理与最新一次朗读匹配的代数（被打断的旧事件直接丢弃）。
  useEffect(() => {
    let active = true;
    let unTts: (() => void) | undefined;
    onTtsEnded((e) => {
      if (!active) return;
      if (ttsGenRef.current === null || e.gen !== ttsGenRef.current) return;
      ttsGenRef.current = null;
      setSpeaking(null);
    }).then((u) => {
      if (active) unTts = u;
      else u();
    });
    return () => {
      active = false;
      unTts?.();
    };
  }, []);

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
    // 拖动结束：异步捕获最终位置并保存（不阻塞 UI）
    void persistPanelGeometry();
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

  /** done 态对外展示的"结果文本"：词典视图为格式化卡片文本，否则为译文。 */
  const resultText = dictView && dictCardData ? cardToText(dictCardData) : translated;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Esc：正在编辑原文时先退出编辑，再按一次才关闭浮窗
      if (event.key === "Escape") {
        event.preventDefault();
        const el = document.activeElement;
        if (el instanceof HTMLTextAreaElement) {
          el.blur();
          return;
        }
        void hidePanel();
        return;
      }
      // Ctrl/Cmd + Enter：复制结果（done 时；词典模式为卡片文本）
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (status === "done" && resultText) {
          event.preventDefault();
          void navigator.clipboard.writeText(resultText);
          flashCopied(dictView && dictCardData ? "已复制词典卡片" : "已复制译文");
        }
        return;
      }
      // Ctrl/Cmd + Shift + C：复制组合（原文 + 结果）
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "C" || event.key === "c")) {
        if (status === "done" && resultText && original) {
          event.preventDefault();
          const combo = `${original}\n\n${resultText}`;
          void navigator.clipboard.writeText(combo);
          flashCopied("已复制原文+结果");
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
  }, [status, translated, original, retryable, resultText]);

  // 原文编辑框高度跟随内容（上限内自动增高，超出内部滚动）。
  useEffect(() => {
    const el = origEditRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [original, status]);

  // 监听原生缩放（含右下角 startResizeDragging 与系统最大化的尺寸变化），
  // 持续刷新 lastResizeAt。原生缩放过程中 JS pointer 事件不触发，只能靠这个事件感知。
  useEffect(() => {
    const unlistenPromise = panelWindow.onResized(() => {
      lastResizeAtRef.current = Date.now();
      scheduleGeometrySave(); // 缩放结束后防抖保存尺寸/位置
    });
    return () => {
      if (geometryTimerRef.current !== null) {
        window.clearTimeout(geometryTimerRef.current);
      }
      void unlistenPromise.then((u) => u());
    };
  }, []);

  // 启动时恢复上次保存的浮窗位置与尺寸（用户拖动/缩放后持久化）。
  useEffect(() => {
    const geometry = loadPanelGeometry();
    if (!geometry) return;
    let cancelled = false;
    (async () => {
      try {
        if (cancelled) return;
        await panelWindow.setPosition(new PhysicalPosition(Math.round(geometry.x), Math.round(geometry.y)));
        if (geometry.w > 0 && geometry.h > 0) {
          await panelWindow.setSize(
            new LogicalSize(geometry.w / geometry.scale, geometry.h / geometry.scale),
          );
        }
      } catch {
        /* 恢复失败则保持默认位置 */
      }
    })();
    return () => {
      cancelled = true;
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
        stopSpeaking(); // 浮窗隐藏即停止朗读
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

  /**
   * 发送到阅读室（§8.2）：把浮窗当前文本建成文章，送进沉浸阅读室精读。
   * 抓取范围决策（decisions #2）：不做前台正文抓取，只送当前文本；
   * 长文本直接成篇，短句也能成篇（单句阅读），提示语区分两种情况。
   */
  async function sendToReader() {
    const text = (lastOriginalRef.current || original).trim();
    if (!text) return;
    try {
      const article = buildArticleFromText(text, { sourceType: "paste" });
      if (!article) {
        flashCopied("没有可发送的内容");
        return;
      }
      await readerSaveArticle(article);
      await emit("reader:article-added", article.id);
      await invoke("open_reader");
      flashCopied(text.length > 200 ? "已送入阅读室" : "已发送所选内容");
    } catch (error) {
      console.error("[reader] send to reader failed", error);
      flashCopied("发送到阅读室失败");
    }
  }

  /** 当前是否有可用操作按钮集（控制头部折叠）。 */
  const canCopy = status === "done" && !!resultText;
  const canRetry = status === "error" && retryable;
  /** 译文行「词典」按钮：词条类文本且预取未被判非词条时显示。 */
  const showDictButton = status === "done" && dictStatus !== "hidden";

  /** 原文角标文案。错误态隐藏来源标签，避免误导。 */
  const sourceLabel =
    panelSource === "ocr" ? "OCR" : panelSource === "error" ? "" : "选中";
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
          {/* 原文+结果一键复制：常驻但仅 done 可用 */}
          <button
            className="icon-btn"
            onClick={() => {
              if (canCopy && original) {
                void navigator.clipboard.writeText(`${original}\n\n${resultText}`);
                flashCopied("已复制原文+结果");
              }
            }}
            disabled={!canCopy || !original}
            title="复制原文+结果 (Ctrl+Shift+C)"
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
          {/* 发送到阅读室（§8.2）：位于「收藏」和「固定」之间，只新增不改旧行为 */}
          <button
            className="icon-btn"
            onClick={() => void sendToReader()}
            disabled={!original.trim()}
            title="在阅读室精读 (Ctrl+Shift+R)"
          >
            <IconSendToReader size={15} />
          </button>
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
              {status === "reading" && awaitCopyHint ? (
                <>
                  <span className="spinner" />
                  请按 Ctrl+C 复制选中的文字，复制后会自动翻译…
                </>
              ) : status === "reading" ? (
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
            {dictView ? (
              dictCardData ? (
                <DictCard
                  card={dictCardData}
                  query={original.trim()}
                  speaking={speaking === "dict"}
                  onSpeak={() => void speakText("dict", dictCardData.word || original)}
                  onCopy={(text, hint) => {
                    void navigator.clipboard.writeText(text);
                    flashCopied(hint);
                  }}
                  onSwitchToTranslate={() => setDictView(false)}
                />
              ) : dictStatus === "error" ? (
                <div className="dict-empty">
                  <span className="dict-empty-text">词典查询失败</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void lookupDict(original.trim())}
                  >
                    <IconRetry size={12} />
                    重试
                  </button>
                </div>
              ) : (
                // 预取未就绪：骨架屏，就绪后自动出卡片
                <div className="dict-card">
                  <div className="dict-skeleton-head">
                    <span className="dict-word">{original}</span>
                    <span className="dict-loading-label">
                      <span className="spinner" />
                      查询词典…
                    </span>
                  </div>
                  <div className="skeleton-block" aria-hidden>
                    <span className="skeleton-line" style={{ width: "46%" }} />
                    <span className="skeleton-line" style={{ width: "96%" }} />
                    <span className="skeleton-line" style={{ width: "82%" }} />
                    <span className="skeleton-line" style={{ width: "58%" }} />
                  </div>
                </div>
              )
            ) : (
              <>
            {original && (
              <div className="orig-block">
                <div className="orig-label-row">
                  <div className="orig-label">原文 · {sourceLabel}</div>
                  <span className="orig-edit-hint">可编辑</span>
                  {canRetranslate && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void retranslateFromEditor()}
                      title="用修改后的原文重新翻译 (Ctrl+Enter)"
                    >
                      <IconRetry size={12} />
                      重新翻译
                    </button>
                  )}
                  <button
                    className={`icon-btn icon-btn-sm${speaking === "original" ? " active" : ""}`}
                    onClick={() => void speakText("original", original)}
                    disabled={!original.trim()}
                    title={speaking === "original" ? "停止朗读原文" : "朗读原文"}
                  >
                    {speaking === "original" ? <IconStop size={14} /> : <IconVolume size={14} />}
                  </button>
                </div>
                <textarea
                  ref={origEditRef}
                  className="orig-text orig-text-edit"
                  value={original}
                  spellCheck={false}
                  onChange={(event) => setOriginal(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      // 编辑框内 Ctrl+Enter 优先重新翻译，不触发全局「复制译文」
                      event.preventDefault();
                      event.stopPropagation();
                      void retranslateFromEditor();
                    }
                  }}
                  aria-label="原文（可编辑，修改后 Ctrl+Enter 重新翻译）"
                />
              </div>
            )}
            <div className="trans-block">
              <div className="trans-row">
                <div className="trans-label">
                  <IconTranslate size={11} />
                  译文
                </div>
                <div className="trans-actions">
                  {showDictButton && (
                    <button
                      className={`btn btn-secondary btn-sm dict-btn${
                        dictStatus === "ready" ? " ready" : dictStatus === "querying" ? " querying" : ""
                      }${dictView ? " current" : ""}`}
                      onClick={() => {
                        if (dictStatus === "error") {
                          void lookupDict(original.trim());
                          return;
                        }
                        setDictView(!dictView);
                      }}
                      title={
                        dictStatus === "querying"
                          ? "词典查询中，点击先看骨架，就绪后自动出卡片"
                          : dictStatus === "error"
                            ? "词典查询失败，点击重试"
                            : dictView
                              ? "返回译文"
                              : "查看词典卡片（音标/释义/例句，已就绪秒开）"
                      }
                    >
                      {dictStatus === "querying" ? <span className="spinner" /> : <IconBookOpen size={12} />}
                      词典
                      {dictStatus === "ready" && !dictView && <span className="dict-dot" />}
                    </button>
                  )}
                  {translated && (
                    <>
                      <button
                        className={`icon-btn icon-btn-sm${speaking === "translated" ? " active" : ""}`}
                        onClick={() => void speakText("translated", translated)}
                        title={speaking === "translated" ? "停止朗读译文" : "朗读译文"}
                      >
                        {speaking === "translated" ? <IconStop size={14} /> : <IconVolume size={14} />}
                      </button>
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
                    </>
                  )}
                </div>
              </div>
              <div className="trans-text">{translated}</div>
            </div>

            {translated && (
              <div className="quick-actions" role="toolbar" aria-label="译文快捷操作">
                {QUICK_ACTIONS.map(({ type, label, title, Icon }) => (
                  <button
                    key={type}
                    className="btn btn-secondary btn-sm"
                    onClick={() => void runQuickAction(type)}
                    disabled={quickAction?.status === "streaming"}
                    title={title}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            )}

            {quickAction &&
              (() => {
                const def = QUICK_ACTIONS.find((d) => d.type === quickAction.type);
                const label = def?.label ?? quickAction.type;
                const Icon = def?.Icon ?? IconSparkles;
                return (
                  <div className="action-block">
                    <div className="trans-row">
                      <div className="action-label">
                        <Icon size={11} />
                        {label}
                      </div>
                      <div className="trans-actions">
                        {quickAction.status === "streaming" && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => void cancelTranslation()}
                            title="停止本次生成"
                          >
                            <IconStop size={12} />
                            停止
                          </button>
                        )}
                        {quickAction.status === "done" && quickAction.text && (
                          <>
                            <button
                              className={`icon-btn icon-btn-sm${speaking === "action" ? " active" : ""}`}
                              onClick={() => void speakText("action", quickAction.text)}
                              title={speaking === "action" ? "停止朗读" : "朗读结果"}
                            >
                              {speaking === "action" ? <IconStop size={14} /> : <IconVolume size={14} />}
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                void navigator.clipboard.writeText(quickAction.text);
                                flashCopied("已复制结果");
                              }}
                            >
                              <IconCopy size={13} />
                              复制
                            </button>
                          </>
                        )}
                        <button
                          className="icon-btn icon-btn-sm"
                          onClick={() => setQuickAction(null)}
                          title="收起结果"
                        >
                          <IconClose size={14} />
                        </button>
                      </div>
                    </div>
                    {quickAction.status === "streaming" ? (
                      quickAction.text ? (
                        <div className="trans-text caret">{quickAction.text}</div>
                      ) : (
                        <div className="action-pending">
                          <span className="spinner" />
                          生成中…
                        </div>
                      )
                    ) : quickAction.status === "error" ? (
                      <div className="action-error">{quickAction.errorMsg || "生成失败，请重试。"}</div>
                    ) : (
                      <div className="trans-text">{quickAction.text}</div>
                    )}
                  </div>
                );
              })()}
              </>
            )}
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
