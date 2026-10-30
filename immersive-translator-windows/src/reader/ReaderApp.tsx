/**
 * 沉浸阅读室 · 组合根（reader 窗口）。
 *
 * 职责：加载数据（文章/生词/设置）、驱动翻译管线（段级流式 + 失败重试 +
 * 手改译文）、接线播放引擎、词典栏、遮罩、复习流与全部入口状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  onTranslationCancelled,
  onTranslationDelta,
  onTranslationDone,
  onTranslationError,
  settingsOpenTab,
  takePendingOpenBook,
  takePendingReaderImport,
  translateStream,
  listenAuthStateChanged,
  authGetStatus,
} from "../lib/tauriBridge";
import { syncLearningRecordsSilently } from "../lib/learningRelay";
import { loadSettingsAsync, hasValidSettings, loadSettings } from "../lib/settingsStore";
import { classifyTtsError } from "../lib/ttsError";
import {
  noteDelete,
  noteList,
  noteRead,
  noteWriteReplay,
  readerDeleteArticle,
  readerDeleteBook,
  readerGetArticle,
  readerGetVocab,
  readerListArticles,
  readerListBooks,
  readerRecordReading,
  readerGradeVocab,
  readerReadSecondsToday,
  readerSaveArticle,
  readerSaveBook,
  readerSaveBookMeta,
  readerSaveVocabWord,
} from "../lib/readerStore";
import { trackEvent } from "../lib/telemetry";
import { track } from "../lib/analytics";
import { reminderGetConfig } from "../lib/reminder";
import {
  buildReplayInput,
  buildReplaySystemPrompt,
  findWordByHeading,
  isStillWeak,
  parseReplay,
  recallBucket,
  verifyReplayWords,
} from "../core/noteBuilder";
import { parseNoteMarkdown } from "../core/noteParser";
import type { NoteMeta, NoteReplay } from "../core/readerTypes";
import { bookChapterIndexOf } from "../core/readerTypes";
import { discoverImportProps, type BookImportDraft } from "../core/bookImport";
import { loadGlobalReaderSettings, loadMicDeviceId, saveGlobalReaderSettings, saveMicDeviceId, resolveLegacyTtsMigrationAllowed } from "./readerSettingsStore";
import { trayRefreshBadge } from "../lib/reminder";
import { buildArticleFromText, normalizeWordKey } from "../core/articleBuilder";
import { looksMostlyChinese, resolveTargetLanguage } from "../core/languageDetect";
import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  migrateLegacyTtsProviderValue,
  type Article,
  type ArticleSummary,
  type BookChapterMeta,
  type BookMeta,
  type ReaderSettings,
  type RecallMode,
  type SentenceChunk,
  type SentencePair,
  type VocabCollocation,
  type VocabWord,
} from "../core/readerTypes";
import type { RecallVerdict } from "../core/recallJudge";
import { clozeVerdictToGrade, type ClozeSlot } from "../core/clozeSlots";
import type { ReviewLogFile } from "../core/readerSrs";
import {
  buildParagraphRequestInput,
  buildParagraphTranslateSystemPrompt,
  buildTitleTranslateSystemPrompt,
  parseParagraphResponse,
  parsePartialNumbered,
  planTranslateRetry,
} from "../core/paragraphTranslate";
import { readerParagraphErrorText } from "../core/errorMessageFormatter";
import { dueVocab, isDue, recordReview, reviewStats, type ReviewGrade } from "../core/readerSrs";
import {
  buildReaderDictPrompt,
  entryToVocab,
  parseReaderDictResponse,
} from "../core/readerDict";
import {
  buildSentenceXrayInput,
  buildSentenceXraySystemPrompt,
  parseSentenceXrayResponse,
} from "../core/sentenceXray";
import {
  buildChunkAnnotateSystemPrompt,
  buildChunkBatchInput,
  chunkBatches,
  chunkToVocab,
  parseChunkResponse,
} from "../core/chunkAnnotate";
import "./reader.css";
import { ReaderTopBar, ViewMenu, type IslandSurface } from "./ReaderTopBar";
import { FolioSheet } from "./ReaderShelf";
import { ReadingView } from "./ReadingView";
import { SettingsDrawer } from "./SettingsDrawer";
import { DictColumn, type DictPanelState, type LensMode, type LensXrayState } from "./DictColumn";
import { NotesView } from "./NotesView";
import { VaultPage, type VaultPlayMode } from "./VaultPage";
import { speakListSessions } from "../lib/speakStore";
import type { SpeakSession } from "../core/speakLogic";
import { VocabNoteDialog } from "./VocabNoteDialog";
import { ImportDialog, type ImportMeta } from "./ImportDialog";
import { usePlayback } from "./usePlayback";
import { useShadowAssess } from "./useShadowAssess";
import { mapWordsToText } from "../core/pronunciation";
import {
  createEdgeEngine,
  createGatewayEngine,
  createSapiEngine,
  createSpeechDispatcher,
  createXfyunEngine,
  type EdgeEngineConfig,
  type GatewayEngineConfig,
  type XfyunEngineConfig,
} from "./speechEngine";
import { loadXfyunTtsCredentials } from "../lib/iseCredentials";
import type { XfyunTtsCredentials } from "../core/xfyunTts";
import { quotaDetailsOf, voiceErrorDisplayText, type VoiceRouteDecision } from "../lib/voice";
import { readerEdgeFallbackNotice, routeReaderSpeech } from "./readerSpeechRoute";
import { AssessStrip, PlayBar } from "./PlayBar";
import { SpeakView } from "./SpeakView";
import { BookTocModal } from "./BookTocModal";
import { ShelfPage } from "./ShelfPage";
import { coverageForText, type CoverageStats, type ExamGoal } from "../core/examCoverage";
import { IconNext, IconPause, IconPlay, IconPrev } from "../ui/icons";

/**
 * 视图路由。原先的 "review" / "notes" 两个成员已移除——它们没有任何 setView
 * 入口，导致 7 处 `view === "review" || view === "notes"` 恒为假。
 *
 * 注意：ReviewView / NotesView 两个**组件**仍是活代码，不要跟着删：
 *   - VaultPage.tsx:28-34 从 ./ReviewView 具名导入 ClozeCard/DictationCard 等卡片
 *   - ReaderApp 的 notesPanel（见下）把 <NotesView/> 挂在 vault 的 md 档回看入口
 * 删掉路由值即可，组件与其测试、预览页都要保留。
 */
type ViewRoute = "shelf" | "reading" | "speak" | "vault";

/**
 * 章末小结卡数据（本章查词/收录生词/到期词/用时 + 下一章）。
 * collected/dueIds 口径 = 归属本章的全部生词（不区分本次阅读是否新增）。
 */
interface ChapterEndState {
  bookId: string;
  bookTitle: string;
  chapterIdx: number;
  chapterCount: number;
  lookups: number;
  collected: number;
  minutes: number;
  nextChapterId: string | null;
  nextChapterTitle: string | null;
  lastChapter: boolean;
  /** 本章生词 id（「整理本章笔记」预选用）。 */
  wordIds: string[];
  /** 本章已到期的生词 id（「复习本章」只送这批进加练，不碰其他词的计划）。 */
  dueIds: string[];
}

/** 短文结课条数据：自然播完末句或手动确认「读完本篇」时的本篇收获快照。 */
interface ArticleFinishCard {
  articleId: string;
  lookups: number;
  /** 本篇收录的词块和生词数。 */
  collected: number;
  /** 其中已到期、可立即复习的数量。 */
  dueCount: number;
  wordIds: string[];
  dueIds: string[];
}

interface PendingTranslate {
  onDelta?: (text: string) => void;
  onDone: (text: string) => void;
  /** httpStatus：结构化 HTTP 状态码（429 退避判定只用它，绝不匹配响应文本）；非 HTTP 失败为 undefined。 */
  onError: (message: string, httpStatus?: number | null) => void;
  onCancelled: (partial: string) => void;
}

/**
 * 「带着语境进口语」的带入意图（v0.8）。
 * Phase 2 只落 book/sentence 形态（正文行间「用这句练口语」、透镜卡
 * 「用这个句型练口语」、刊头「围绕本章练口语」）；vocab 形态是 Phase 3/4
 * 生词造句闯关的槽位，形状在此一次定死，后续阶段不再改形状。
 */
type PendingSpeak =
  | { kind: "book"; articleId: string; sentenceIdx: number }
  | { kind: "vocab" }
  | null;

/** 导入弹窗初始 tab（与 ImportDialog 的 TabId 同集合；propContracts 外壳契约：
 *  onOpenImport 升级为 (tab?) => void，三挂点共用）。 */
type ImportOpenTab = "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed";

/** openImport 的运行时白名单：拦下 onClick 直传泄漏进来的事件对象等非 tab 值。 */
const IMPORT_OPEN_TABS: readonly ImportOpenTab[] = [
  "lib",
  "epub",
  "file",
  "url",
  "paste",
  "discover",
  "feed",
];

/** toast 附带的动作位（当前仅配额耗尽的「兑换更多额度」）。 */
type ToastAction = "redeem";

/** 从任意错误取服务端错误码（VoiceError/AuthError/WSS error 帧形状均兼容）。 */
function voiceErrorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return null;
}

/** 把运行时 quota_exceeded 归一成守卫同形的回落决策，供提示与「下一句转 Edge」共用。 */
function quotaFallbackDecision(error: unknown): VoiceRouteDecision {
  const details = quotaDetailsOf(error as { details?: unknown });
  return {
    engine: "off",
    reason: "quota_exhausted",
    hint: voiceErrorDisplayText(error as { code?: unknown; details?: unknown }),
    quota: {
      remaining: details.remaining,
      allowance: details.allowance,
      resetsAt: details.resetsAt,
    },
  };
}

export function ReaderApp() {
  // ---- 数据 ----
  const [globalSettings, setGlobalSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [articleList, setArticleList] = useState<ArticleSummary[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [vocabWords, setVocabWords] = useState<VocabWord[]>([]);
  const [reviewLog, setReviewLog] = useState<ReviewLogFile>({ schemaVersion: 1, days: [] });
  // 书架是首页（对齐原型）：应用打开落在整页书架，点书卡/短文进阅读。
  const [view, setView] = useState<ViewRoute>("shelf");
  const [toast, setToast] = useState("");
  const [toastAction, setToastAction] = useState<ToastAction | null>(null);
  /** 旧 xfyun → cloud 的迁移允许（任一讯飞凭据存在或已登录沉浸云，启动时判定一次）。 */
  const [legacyTtsMigrationAllowed, setLegacyTtsMigrationAllowed] = useState(false);
  // 弹出式书架浮层（v0.8）：由导航岛左上「书架 · 书名」触发，挂在根节点顶层。
  const [folioOpen, setFolioOpen] = useState(false);
  // ---- 笔记库 ----
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeNote, setActiveNote] = useState<{ meta: NoteMeta; parsed: ReturnType<typeof parseNoteMarkdown> } | null>(null);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [notePreselect, setNotePreselect] = useState<string[] | undefined>(undefined);
  const [replayBusy, setReplayBusy] = useState(false);
  /** 加练队列：非空时复习只排这批词（笔记复盘区「开始复习/只测仍错的词」入口）。 */
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(null);
  /** 标题失败原因（瞬态，不持久化——重启后仅显「标题翻译失败」，与现状一致）。 */
  const [titleCnError, setTitleCnError] = useState<string | null>(null);
  const [chunking, setChunking] = useState<{ done: number; total: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /** 导入弹窗初始 tab（书架「发现/订阅/文库」入口直达；缺省文库）。ImportDialog
      条件挂载，每次重开都以该值作 useState 初值生效（外壳 2026-10-26 契约）。 */
  const [importInitialTab, setImportInitialTab] = useState<ImportOpenTab>("lib");
  const [viewMenuAnchor, setViewMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const [dict, setDict] = useState<DictPanelState>({ status: "closed" });
  // ---- v0.8 阅读画报：透镜卡双模 + 句子解析 + 口语带入 ----
  /** 右栏透镜卡当前 Tab（查词动作发生时切到 lex，句子解析请求切回 xray）。 */
  const [lensMode, setLensMode] = useState<LensMode>("xray");
  /** 句子解析数据（translateStream，tag 前缀 rx；null = 本窗口还没请求过）。 */
  const [xray, setXray] = useState<LensXrayState | null>(null);
  /** 透镜卡结构拆解悬停中的片段（回标正文原文，null = 未悬停）。 */
  const [hoveredClause, setHoveredClause] = useState<string | null>(null);
  /** 带入口语的语境（见 PendingSpeak；Phase 3 在口语侧消费）。 */
  const [pendingSpeak, setPendingSpeak] = useState<PendingSpeak>(null);
  const [peekAll, setPeekAll] = useState(false);
  const [searchMatchIdx, setSearchMatchIdx] = useState<number | null>(null);
  const [sourceCache, setSourceCache] = useState<Map<string, Article>>(new Map());
  // ---- 整本书阅读室（书级载体） ----
  const [bookList, setBookList] = useState<BookMeta[]>([]);
  const [tocBookId, setTocBookId] = useState<string | null>(null);
  // ---- v0.8「笔记与复习」三合一（2026-10-26 改版为 home/notes/focus/export 四态） ----
  /** 当前档：goReview→home、goNotes→notes、startFocusReview→focus、导出按钮→export。 */
  const [vaultMode, setVaultMode] = useState<VaultPlayMode>("home");
  /** 口语会话缓存（speak_list_sessions；进 vault 视图时拉取，手账/导出的数据源）。 */
  const [speakSessions, setSpeakSessions] = useState<SpeakSession[]>([]);
  /** 今日已读秒数 / 每日阅读目标分钟（辅助增强二）。 */
  const [readSecondsToday, setReadSecondsToday] = useState(0);
  const [readGoalMin, setReadGoalMin] = useState(0);
  /** 章末小结卡（书章读完弹出）。 */
  const [chapterEnd, setChapterEnd] = useState<ChapterEndState | null>(null);
  /** 短文结课条（自然播完或手动确认后常驻显示，可关闭）。 */
  const [finishCard, setFinishCard] = useState<ArticleFinishCard | null>(null);

  const articleRef = useRef<Article | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  /** 书元信息写回（防抖；与章文章保存分开，避免索引重写放大）。 */
  const booksRef = useRef<BookMeta[]>([]);
  const bookSaveTimerRef = useRef<number | null>(null);
  /** 未落盘的阅读秒数缓冲（每 15s 批量上报）。 */
  const secondsBufferRef = useRef(0);
  /** 打开本章时的累计秒基线（章末小结「本章用时」用）。 */
  const openSecondsRef = useRef(0);
  const dictCountRef = useRef<Map<string, number>>(new Map());
  const pendingTranslateRef = useRef(new Map<string, PendingTranslate>());
  const translateSeqRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  /** 阅读室热键导入去重（挂载取件与事件送达两条路径共享同一 nonce）。 */
  const importNonceRef = useRef("");
  /** 词块标注并发闸（同一时刻只允许一篇文章在标）。 */
  const annotatingRef = useRef(false);
  /** ensureAnnotated 读实时合并设置，避免渲染闭包过期。 */
  const globalSettingsRef = useRef(globalSettings);
  useEffect(() => {
    globalSettingsRef.current = globalSettings;
  }, [globalSettings]);

  // 口语记录静默云同步（2026-10-28：speak-sessions/speak-assessments 跟账号走）：
  // 登录后挂载即拉推一轮（SpeakView 挂载与设置页手动按钮另有入口）；未登录直接
  // 跳过——零网络请求，记录仅本地，无登录墙。失败静默（汇总不展示）。
  useEffect(() => {
    void syncLearningRecordsSilently();
  }, []);

  const showToast = useCallback((message: string, action: ToastAction | null = null) => {
    setToast(message);
    setToastAction(action);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      setToastAction(null);
    }, action ? 8000 : 3200);
  }, []);
  /** 守卫回落 / 配额同句恢复时的 Edge 提示，去重避免连读每句重复弹。 */
  const fallbackNoticeKeyRef = useRef("");
  const showEdgeFallback = useCallback(
    (decision: VoiceRouteDecision) => {
      const notice = readerEdgeFallbackNotice(decision);
      const key = `${notice.message}|${notice.action ?? ""}`;
      if (key === fallbackNoticeKeyRef.current) return;
      fallbackNoticeKeyRef.current = key;
      showToast(notice.message, notice.action);
    },
    [showToast],
  );
  const showEdgeFallbackRef = useRef(showEdgeFallback);
  showEdgeFallbackRef.current = showEdgeFallback;
  /** 回整页书架（首页）。声明在前：删除文章/书等早于导航区的地方也要用。 */
  const goShelf = useCallback(() => {
    setFocusIds(null);
    setView("shelf");
  }, []);

  /** 打开导入弹窗，可指定直达 tab（书架发现三列 discover/feed/lib、书架浮层与
      阅读页空态不带 tab 落缺省文库）。挂点：FolioSheet/ShelfPage/ReadingView。
      白名单防御：onClick 直传本函数时第一个参数是事件对象，不能进 tab 状态，
      否则 ImportDialog 里所有 tab === "…" 都不命中，弹窗只剩头和 tab 条。 */
  const openImport = useCallback((tab?: ImportOpenTab) => {
    setImportInitialTab(tab !== undefined && IMPORT_OPEN_TABS.includes(tab) ? tab : "lib");
    setImportOpen(true);
  }, []);

  /** 书架浮层外点关闭（左上触发胶囊不算「外」——它自己走 onToggleFolio；
      .shell-brand 是外壳重构后的新容器类，与旧 .brand-folio-pill 并列兜底）。 */
  useEffect(() => {
    if (!folioOpen) return;
    function onDown(e: MouseEvent) {
      const el = e.target as Element | null;
      if (el && el.closest(".floating-folio-sheet, .brand-folio-pill, .shell-brand")) return;
      setFolioOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [folioOpen]);

  const effectiveSettings = useMemo(() => {
    const merged = mergeReaderSettings(globalSettings, article?.settings);
    const provider = migrateLegacyTtsProviderValue(merged.ttsProvider, legacyTtsMigrationAllowed);
    return provider === merged.ttsProvider ? merged : { ...merged, ttsProvider: provider };
  }, [globalSettings, article?.settings, legacyTtsMigrationAllowed]);

  // ---- 播放引擎 ----
  const textsRef = useRef<string[]>([]);
  const playbackSettingsRef = useRef({
    rate: effectiveSettings.rate,
    voice: effectiveSettings.voice,
    sentencePauseMs: effectiveSettings.sentencePauseMs,
    shadowingMode: effectiveSettings.shadowingMode,
  });
  useEffect(() => {
    textsRef.current = article?.sentences.map((s) => s.en) ?? [];
  }, [article?.sentences]);
  useEffect(() => {
    playbackSettingsRef.current = {
      rate: effectiveSettings.rate,
      voice: effectiveSettings.voice,
      sentencePauseMs: effectiveSettings.sentencePauseMs,
      shadowingMode: effectiveSettings.shadowingMode,
    };
  }, [effectiveSettings]);

  const vocabWordsRef = useRef(vocabWords);
  vocabWordsRef.current = vocabWords;
  /** 章末小结（定义在下方，播放引擎回调先持引用，避免声明顺序问题）。 */
  const showChapterEndRef = useRef<(a: Article) => void>(() => {});
  /**
   * 「读完」事件（usePlayback onFinish：仅连续朗读自然播完末句触发；
   * 单句朗读、跳到末句都不会走到这里）。书章 → 章末小结卡；短文 → 结课条。
   */
  const handleFinish = useCallback(() => {
    const a = articleRef.current;
    if (!a) return;
    if (a.bookId) {
      showChapterEndRef.current(a);
      return;
    }
    showFinishCardRef.current(a);
  }, []);

  /** 短文结课条（定义在下方，同上持引用）。 */
  const showFinishCardRef = useRef<(a: Article) => void>(() => {});

  // ---- 朗读引擎（Edge 在线免费 / 云音色 / 本地 SAPI，凭据缺失自动回落本地） ----
  const [ttsCreds, setTtsCreds] = useState<XfyunTtsCredentials | null>(null);
  const refreshTtsCreds = useCallback(() => {
    void loadXfyunTtsCredentials()
      .then(setTtsCreds)
      .catch(() => setTtsCreds(null));
  }, []);
  useEffect(() => {
    refreshTtsCreds();
  }, [refreshTtsCreds]);
  const ttsCfgRef = useRef<XfyunEngineConfig>({ vcnZh: "", vcnEn: "", rate: 1, creds: null });
  ttsCfgRef.current = {
    vcnZh: effectiveSettings.cloudVoice,
    vcnEn: effectiveSettings.cloudVoiceEn,
    rate: effectiveSettings.rate,
    creds: ttsCreds,
  };
  const edgeCfgRef = useRef<EdgeEngineConfig>({ voiceZh: "", voiceEn: "", rate: 1 });
  edgeCfgRef.current = {
    voiceZh: effectiveSettings.edgeVoiceZh,
    voiceEn: effectiveSettings.edgeVoiceEn,
    rate: effectiveSettings.rate,
  };
  const ttsProviderRef = useRef(effectiveSettings.ttsProvider);
  ttsProviderRef.current = effectiveSettings.ttsProvider;

  /** 统一朗读错误入口：云网关错误按 §二映射且不透传原文，其余走既有归因。 */
  const handleSpeechError = useCallback(
    (error: unknown) => {
      const code = voiceErrorCodeOf(error);
      if (code !== null) {
        const text = voiceErrorDisplayText(error as { code?: unknown; details?: unknown }) ||
          "服务暂时不可用，请稍后再试";
        showToast(`朗读失败，已停止：${text}`, code === "quota_exceeded" ? "redeem" : null);
        return;
      }
      const info = classifyTtsError(error);
      showToast(
        `朗读失败，已停止：${info.message}（点播放键重试${info.allowSettings ? "，或到 设置 → 语音 检查" : ""}）`,
      );
    },
    [showToast],
  );

  const gatewayCfgRef = useRef<GatewayEngineConfig>({ rate: 1 });
  gatewayCfgRef.current = { voice: loadSettings().voiceGatewayVoice, rate: effectiveSettings.rate };
  /** 首片播放后的异步失败（启动失败仍走 speak reject）。 */
  const gatewayAsyncErrorRef = useRef<(error: unknown) => void>(() => {});
  /** 运行时配额耗尽：本句转 Edge，后续句直接走 Edge（守卫缓存可能尚未感知）。 */
  const gatewayQuotaErrorRef = useRef<unknown | null>(null);

  const sapiEngine = useMemo(() => createSapiEngine(), []);
  const xfyunEngine = useMemo(() => createXfyunEngine(() => ttsCfgRef.current), []);
  const edgeEngine = useMemo(() => createEdgeEngine(() => edgeCfgRef.current), []);
  const gatewayEngine = useMemo(
    () =>
      createGatewayEngine(() => gatewayCfgRef.current, {
        onAsyncError: (error) => gatewayAsyncErrorRef.current(error),
      }),
    [],
  );
  const speechEngine = useMemo(
    () =>
      createSpeechDispatcher(
        async () => {
          const routed = await routeReaderSpeech({
            provider: ttsProviderRef.current,
            xfyunReady: ttsCfgRef.current.creds !== null,
            engines: { edge: edgeEngine, xfyun: xfyunEngine, gateway: gatewayEngine, sapi: sapiEngine },
          });
          if (routed.engine === gatewayEngine && gatewayQuotaErrorRef.current !== null) {
            showEdgeFallbackRef.current(quotaFallbackDecision(gatewayQuotaErrorRef.current));
            return edgeEngine;
          }
          if (routed.fallback) {
            showEdgeFallbackRef.current(routed.fallback);
            return routed.engine;
          }
          if (routed.engine === gatewayEngine) fallbackNoticeKeyRef.current = "";
          return routed.engine;
        },
        {
          onSpeakError: (error, engine) => {
            if (engine !== gatewayEngine) return null;
            if (voiceErrorCodeOf(error) === "quota_exceeded") {
              gatewayQuotaErrorRef.current = error;
              showEdgeFallbackRef.current(quotaFallbackDecision(error));
              return edgeEngine;
            }
            return null;
          },
        },
      ),
    [sapiEngine, xfyunEngine, edgeEngine, gatewayEngine],
  );

  const playback = usePlayback({
    target: "reader",
    textsRef,
    settingsRef: playbackSettingsRef,
    engine: speechEngine,
    onFinish: handleFinish,
    // P1：TTS 失败给明确归因（缺凭据/网络/系统），并指出出路（重试 / 去设置）。
    onError: handleSpeechError,
  });
  gatewayAsyncErrorRef.current = (error) => {
    if (voiceErrorCodeOf(error) === "quota_exceeded") gatewayQuotaErrorRef.current = error;
    playback.stop();
    handleSpeechError(error);
  };

  // ---- 跟读评测（shadowingMode + shadowingAssess）----
  const [micDeviceId, setMicDeviceId] = useState<string>(() => loadMicDeviceId());
  // 渲染期同步 ref，getConfig 永远读到最新阈值/设备/开麦方式。
  const assessConfigRef = useRef({
    passScore: effectiveSettings.shadowingPassScore,
    micDeviceId,
    autoMic: effectiveSettings.shadowingAutoMic,
    silenceMs: effectiveSettings.shadowingSilenceMs,
  });
  assessConfigRef.current = {
    passScore: effectiveSettings.shadowingPassScore,
    micDeviceId,
    autoMic: effectiveSettings.shadowingAutoMic,
    silenceMs: effectiveSettings.shadowingSilenceMs,
  };
  const assess = useShadowAssess({
    textsRef,
    getConfig: () => assessConfigRef.current,
    leadSpeak: (text) =>
      speechEngine.speak(text, false, { track: "word", target: "reader", rate: 0.72 }),
    stopLead: () => {
      void speechEngine.stopTrack("word").catch(() => undefined);
    },
    onAdvance: () => playback.continueAfterShadowing(),
  });
  const assessEnabled = effectiveSettings.shadowingMode && effectiveSettings.shadowingAssess;

  // 本句读完进入跟读等待 → 自动开麦；等待结束（过关/跳过/换句）→ 收麦克风。
  useEffect(() => {
    if (!assessEnabled) {
      assess.cancel();
      return;
    }
    if (playback.shadowingWait) void assess.begin(playback.activeIdx);
    else assess.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessEnabled, playback.shadowingWait, playback.activeIdx]);

  /** 最近一次评测的词着色（下一次评测前保持在正文里）。 */
  const assessMarks = useMemo(() => {
    if (!article || assess.result == null || assess.sentenceIdx == null) return null;
    const st = article.sentences[assess.sentenceIdx];
    if (!st) return null;
    return { sentenceIdx: assess.sentenceIdx, marks: mapWordsToText(st.en, assess.result.words) };
  }, [article, assess.result, assess.sentenceIdx]);

  // ---- 翻译事件路由（tag → 请求） ----
  useEffect(() => {
    const uns: (() => void)[] = [];
    onTranslationDelta((e) => {
      pendingTranslateRef.current.get(e.tag)?.onDelta?.(e.text);
    }).then((u) => uns.push(u));
    onTranslationDone((e) => {
      const p = pendingTranslateRef.current.get(e.tag);
      if (p) {
        pendingTranslateRef.current.delete(e.tag);
        p.onDone(e.text);
      }
    }).then((u) => uns.push(u));
    onTranslationError((e) => {
      const p = pendingTranslateRef.current.get(e.tag);
      if (p) {
        pendingTranslateRef.current.delete(e.tag);
        p.onError(e.body || `HTTP ${e.status ?? ""}`, e.status);
      }
    }).then((u) => uns.push(u));
    onTranslationCancelled((e) => {
      const p = pendingTranslateRef.current.get(e.tag);
      if (p) {
        pendingTranslateRef.current.delete(e.tag);
        p.onCancelled(e.partial);
      }
    }).then((u) => uns.push(u));
    return () => {
      uns.forEach((u) => u());
    };
  }, []);

  /** 发一次翻译请求并等待其完成（tag 路由，超时保护）。httpStatus 供 429 自动退避与失败文案分桶。 */
  const requestTranslate = useCallback(
    (
      input: string,
      systemPrompt: string,
      tag: string,
      onDelta?: (text: string) => void,
    ): Promise<{ status: "done" | "error" | "cancelled"; text: string; httpStatus: number | null }> => {
      return new Promise((resolve) => {
        let settled = false;
        let timer = 0;
        const finish = (r: {
          status: "done" | "error" | "cancelled";
          text: string;
          httpStatus: number | null;
        }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          pendingTranslateRef.current.delete(tag);
          resolve(r);
        };
        timer = window.setTimeout(() => finish({ status: "error", text: "翻译请求超时", httpStatus: null }), 180_000);
        pendingTranslateRef.current.set(tag, {
          onDelta,
          onDone: (text) => finish({ status: "done", text, httpStatus: null }),
          onError: (message, httpStatus) => finish({ status: "error", text: message, httpStatus: httpStatus ?? null }),
          onCancelled: (partial) => finish({ status: "cancelled", text: partial, httpStatus: null }),
        });
        void loadSettingsAsync()
          .then((s) => {
            if (!hasValidSettings(s)) {
              finish({ status: "error", text: "未配置翻译接口", httpStatus: null });
              return;
            }
            return translateStream({
              text: input,
              endpoint: s.endpoint,
              apiKey: s.apiKey,
              model: s.model,
              systemPrompt,
              stream: s.stream,
              windowLabel: "reader",
              tag,
            }).catch((error) => {
              finish({ status: "error", text: error instanceof Error ? error.message : String(error), httpStatus: null });
            });
          })
          .catch((error) => finish({ status: "error", text: String(error), httpStatus: null }));
      });
    },
    [],
  );

  // ---- 文章落盘（防抖） ----
  useEffect(() => {
    articleRef.current = article;
  }, [article]);

  /** 带入句过期清理：切到别的文章后旧 pendingSpeak 不再有效（Phase 3 消费前保证新鲜）。
   * vocab 形态一次性消费：离开口语视图即清（Phase 4「去口语里用一次」每次点击重新置值，
   * 避免再次进口语视图时重开旧造句会话）。 */
  useEffect(() => {
    if (!pendingSpeak) return;
    const a = articleRef.current;
    if (pendingSpeak.kind === "book" && a && pendingSpeak.articleId !== a.id) {
      setPendingSpeak(null);
    }
    if (pendingSpeak.kind === "vocab" && view !== "speak") {
      setPendingSpeak(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSpeak, article?.id, view]);

  const scheduleSave = useCallback((next: Article) => {
    articleRef.current = next;
    setArticle(next);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const a = articleRef.current;
      if (a) {
        void readerSaveArticle(a)
          .then((summary) => {
            setArticleList((list) => {
              const others = list.filter((x) => x.id !== summary.id);
              return [summary, ...others].sort((x, y) => y.lastReadAt - x.lastReadAt);
            });
          })
          .catch((error) => console.error("[reader] save article failed", error));
      }
    }, 700);
  }, []);

  const patchArticle = useCallback(
    (updater: (a: Article) => Article) => {
      const current = articleRef.current;
      if (!current) return;
      scheduleSave(updater(current));
    },
    [scheduleSave],
  );

  // ---- 书元信息写回（书级断点/时长/最近阅读；防抖，只写 reader_books.json 索引） ----
  useEffect(() => {
    booksRef.current = bookList;
  }, [bookList]);

  const scheduleBookMetaSave = useCallback((updater: (b: BookMeta) => BookMeta) => {
    const bookId = articleRef.current?.bookId;
    if (!bookId) return;
    const current = booksRef.current.find((b) => b.id === bookId);
    if (!current) return;
    const next = updater(current);
    booksRef.current = booksRef.current.map((b) => (b.id === next.id ? next : b));
    setBookList((list) => list.map((b) => (b.id === next.id ? next : b)));
    if (bookSaveTimerRef.current !== null) window.clearTimeout(bookSaveTimerRef.current);
    bookSaveTimerRef.current = window.setTimeout(() => {
      bookSaveTimerRef.current = null;
      const meta = booksRef.current.find((b) => b.id === next.id);
      if (meta) {
        void readerSaveBookMeta(meta).catch((error) =>
          console.error("[reader] save book meta failed", error),
        );
      }
    }, 1200);
  }, []);

  // ---- 词块标注（文章翻译完成后按批跑；切走文章即停） ----
  const ensureAnnotated = useCallback(async () => {
    const a = articleRef.current;
    if (!a || annotatingRef.current) return;
    // 设置读实时合并值：开关状态可能来自全局默认或文章覆盖。
    if (!mergeReaderSettings(globalSettingsRef.current, a.settings).chunkHighlight) return;
    if (a.chunkState === "done") return;
    const s = await loadSettingsAsync().catch(() => null);
    if (!s || !hasValidSettings(s)) return; // 翻译路径已提示过配接口
    annotatingRef.current = true;
    try {
      const firstEn = a.sentences[0]?.en ?? a.title;
      const target = resolveTargetLanguage(firstEn, { mode: s.translationMode, fixed: s.fixedTarget });
      const batches = chunkBatches(a.sentences.map((st) => ({ idx: st.idx, en: st.en })));
      if (batches.length === 0) {
        patchArticle((cur) => ({ ...cur, chunkState: "done" }));
        return;
      }
      const system = buildChunkAnnotateSystemPrompt(target);
      setChunking({ done: 0, total: batches.length });
      let marked = 0;
      let anyError = false;
      let done = 0;
      for (const batch of batches) {
        if (articleRef.current?.id !== a.id) return; // 切走文章，整批终止
        const tag = `rc${++translateSeqRef.current}`;
        const res = await requestTranslate(buildChunkBatchInput(batch), system, tag);
        if (res.status === "done") {
          const byIdx = parseChunkResponse(res.text, batch);
          if (byIdx.size > 0) {
            marked += [...byIdx.values()].reduce((n, list) => n + list.length, 0);
            patchArticle((cur) => ({
              ...cur,
              sentences: cur.sentences.map((st) => {
                const chunks = byIdx.get(st.idx);
                return chunks ? { ...st, chunks } : st;
              }),
            }));
          }
        } else {
          anyError = true;
        }
        done += 1;
        setChunking(done < batches.length ? { done, total: batches.length } : null);
      }
      patchArticle((cur) => ({ ...cur, chunkState: anyError && marked === 0 ? "failed" : "done" }));
      if (anyError && marked === 0) showToast("词块标注失败，可在设置里重试");
    } finally {
      annotatingRef.current = false;
      setChunking(null);
    }
  }, [patchArticle, requestTranslate, showToast]);

  /** 设置抽屉「重新标注」：清空本篇词块后重跑。 */
  const reannotateChunks = useCallback(() => {
    const a = articleRef.current;
    if (!a) return;
    patchArticle((cur) => ({
      ...cur,
      chunkState: "pending",
      sentences: cur.sentences.map((st) => {
        const { chunks: _drop, ...rest } = st;
        return rest;
      }),
    }));
    void ensureAnnotated();
  }, [patchArticle, ensureAnnotated]);

  // ---- 设置（全局 + 文章覆盖，见 §6 屏 B 职责划分） ----
  const patchSettings = useCallback(
    (patch: Partial<ReaderSettings>) => {
      const merged = mergeReaderSettings(globalSettings, patch);
      setGlobalSettings(merged);
      saveGlobalReaderSettings(merged);
      patchArticle((a) => ({ ...a, settings: { ...(a.settings ?? {}), ...patch } }));
      // 开关从关到开：当前文章立刻补标（scheduleSave 已同步 articleRef）。
      if (patch.chunkHighlight === true && articleRef.current?.chunkState !== "done") {
        void ensureAnnotated();
      }
    },
    [globalSettings, patchArticle, ensureAnnotated],
  );

  const resetSettings = useCallback(() => {
    setGlobalSettings({ ...DEFAULT_READER_SETTINGS });
    saveGlobalReaderSettings({ ...DEFAULT_READER_SETTINGS });
    patchArticle((a) => ({ ...a, settings: { ...DEFAULT_READER_SETTINGS } }));
    showToast("已恢复默认阅读设置");
  }, [patchArticle, showToast]);

  // ---- 翻译管线（P0-1：段级流式渲染 + 单段重试 + 手改译文） ----
  const ensureTranslated = useCallback(
    async (input: Article) => {
      const s = await loadSettingsAsync().catch(() => null);
      if (!s || !hasValidSettings(s)) {
        showToast("先在设置里配置翻译接口，译文才会自动生成");
        return;
      }
      const firstEn = input.sentences[0]?.en ?? input.title;
      const target = resolveTargetLanguage(firstEn, { mode: s.translationMode, fixed: s.fixedTarget });

      const groups = new Map<number, SentencePair[]>();
      for (const st of input.sentences) {
        if (st.zhState !== "pending") continue;
        const list = groups.get(st.paragraphIdx) ?? [];
        list.push(st);
        groups.set(st.paragraphIdx, list);
      }
      const pendingGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);
      const titlePending = input.titleCnState === "pending";
      if (!titlePending && pendingGroups.length === 0) {
        // 已翻完的老文章打开时在此补跑词块标注。
        void ensureAnnotated();
        return;
      }

      setTranslating({ done: 0, total: pendingGroups.length });

      if (titlePending) {
        const tag = `rt${++translateSeqRef.current}`;
        const res = await requestTranslate(input.title, buildTitleTranslateSystemPrompt(target), tag);
        if (res.status === "done") {
          setTitleCnError(null);
          const cn = res.text.trim().split(/\r?\n/)[0]?.trim();
          patchArticle((a) => ({
            ...a,
            ...(cn
              ? { titleCn: cn, titleCnState: "done" as const }
              : { titleCnState: "failed" as const }),
          }));
        } else if (res.status === "error") {
          setTitleCnError(readerParagraphErrorText(res.httpStatus));
          patchArticle((a) => ({ ...a, titleCnState: "failed" }));
        }
      }

      let done = 0;
      // 整篇自动退避计数（429 等待次数，跨段共享；手动重试发起的新 run 从 0 重新起算）。
      let runBackoffs = 0;
      for (const [, sentences] of pendingGroups) {
        // B1 修复：中途切到别的文章时旧 run 必须先清掉「翻译中 N/M 段」chip 再退出——
        // ensureAnnotated 有 try/finally 兜底，本函数没有，裸 return 会让 chip 永久卡死。
        if (articleRef.current?.id !== input.id) {
          setTranslating(null);
          return;
        }
        const paraInput = buildParagraphRequestInput(sentences.map((x) => x.en));
        const expected = sentences.length;
        const systemPrompt = buildParagraphTranslateSystemPrompt({
          targetLanguage: target,
          customStyle: s.customStyle,
          glossaryText: s.glossaryText,
        });
        const onDelta = (delta: string) => {
          const partial = parsePartialNumbered(delta, expected);
          partial.forEach((text, i) => {
            if (text === null) return;
            const idx = sentences[i].idx;
            patchArticle((a) => ({
              ...a,
              sentences: a.sentences.map((st) =>
                st.idx === idx && st.zhState === "pending" ? { ...st, zh: text } : st,
              ),
            }));
          });
        };
        let groupRetries = 0;
        let tag = `rp${++translateSeqRef.current}`;
        let res = await requestTranslate(paraInput, systemPrompt, tag, onDelta);
        // 429 自动退避：仅结构化状态码 429 触发；每段最多 1 次，整篇 ≤6 次。
        for (
          let wait;
          (wait = planTranslateRetry({
            httpStatus: res.status === "error" ? res.httpStatus : null,
            groupRetries,
            runBackoffs,
          })) !== null;

        ) {
          groupRetries += 1;
          runBackoffs += 1;
          await new Promise<void>((r) => window.setTimeout(r, wait));
          if (articleRef.current?.id !== input.id) {
            // 退避期间切走文章：同款先清 chip 再退出（B1 修复）。
            setTranslating(null);
            return;
          }
          // 重试用新 tag，避免事件路由按旧 tag 误路由；systemPrompt/onDelta 与首次尝试相同。
          tag = `rp${++translateSeqRef.current}`;
          res = await requestTranslate(paraInput, systemPrompt, tag, onDelta);
        }
        if (res.status === "done") {
          const parsed = parseParagraphResponse(res.text, expected);
          if (parsed) {
            patchArticle((a) => ({
              ...a,
              sentences: a.sentences.map((st) => {
                const i = sentences.findIndex((x) => x.idx === st.idx);
                if (i < 0) return st;
                return { ...st, zh: parsed[i], zhState: "done" as const };
              }),
            }));
          } else {
            markParagraphFailed(sentences);
          }
        } else if (res.status === "cancelled") {
          // 取消：流式已完成的句子按部分解析收尾（能救几句是几句）；
          // 没译出来的标 failed——留着永远 pending 会是空白且没有重试入口。
          const partial = parsePartialNumbered(res.text, expected);
          patchArticle((a) => ({
            ...a,
            sentences: a.sentences.map((st) => {
              const i = sentences.findIndex((x) => x.idx === st.idx);
              if (i < 0) return st;
              const zh = partial[i];
              return zh
                ? { ...st, zh, zhState: "done" as const }
                : { ...st, zhState: "failed" as const };
            }),
          }));
        } else {
          markParagraphFailed(sentences, readerParagraphErrorText(res.httpStatus));
        }
        done += 1;
        setTranslating(done < pendingGroups.length ? { done, total: pendingGroups.length } : null);
      }
      setTranslating(null);
      // 翻译完成后紧接词块标注（同一请求路由顺序执行，不与翻译并发）。
      void ensureAnnotated();

      function markParagraphFailed(group: SentencePair[], errorText?: string) {
        patchArticle((a) => ({
          ...a,
          sentences: a.sentences.map((st) =>
            group.some((x) => x.idx === st.idx)
              ? { ...st, zhState: "failed" as const, zhError: errorText }
              : st,
          ),
        }));
      }
    },
    [requestTranslate, patchArticle, showToast, ensureAnnotated],
  );

  const retryParagraph = useCallback(
    (paragraphIdx: number) => {
      patchArticle((a) => ({
        ...a,
        sentences: a.sentences.map((st) =>
          st.paragraphIdx === paragraphIdx && st.zhState === "failed"
            ? { ...st, zh: null, zhState: "pending" as const, zhError: undefined }
            : st,
        ),
      }));
      const current = articleRef.current;
      if (!current) return;
      const titleCnState = current.titleCnState;
      void ensureTranslated({
        ...current,
        ...(titleCnState !== "pending" ? {} : { titleCnState: "done" as const }),
        sentences: current.sentences.filter((s) => s.paragraphIdx === paragraphIdx),
      });
    },
    [patchArticle, ensureTranslated],
  );

  const retryTitle = useCallback(() => {
    setTitleCnError(null);
    patchArticle((a) => ({ ...a, titleCnState: "pending", titleCn: undefined }));
    const current = articleRef.current;
    if (current) void ensureTranslated({ ...current, titleCnState: "pending", sentences: [] });
  }, [patchArticle, ensureTranslated]);

  const editTranslation = useCallback(
    (idx: number, zh: string) => {
      patchArticle((a) => ({
        ...a,
        sentences: a.sentences.map((st) =>
          // 刚手改过的句子在遮罩模式下保持可见，避免改完又被盖回去
          st.idx === idx ? { ...st, zh, zhState: "edited" as const, revealed: true } : st,
        ),
      }));
    },
    [patchArticle],
  );

  // ---- 进度（P0-2 断点续读；书级断点随之写回 BookMeta） ----
  useEffect(() => {
    if (!article) return;
    const idx = playback.activeIdx;
    const total = article.sentences.length;
    const maxIdx = Math.max(article.progress.sentenceIdx, Math.min(idx, Math.max(0, total - 1)));
    const percent = total > 1 ? (maxIdx / (total - 1)) * 100 : total === 1 ? 100 : 0;
    if (maxIdx !== article.progress.sentenceIdx || Math.abs(percent - article.progress.percent) >= 0.5) {
      patchArticle((a) => ({
        ...a,
        lastReadAt: Date.now(),
        progress: { ...a.progress, sentenceIdx: maxIdx, percent },
      }));
    }
    if (article.bookId) {
      scheduleBookMetaSave((b) =>
        b.id === article.bookId
          ? {
              ...b,
              lastReadAt: Date.now(),
              progress: { chapterId: article.id, sentenceIdx: maxIdx, percent },
            }
          : b,
      );
      // 章末小结只在「自然播完末句」或「手动点读完本章」时弹（showChapterEnd）；
      // 光标进入最后一句不算读完——跳读/滚动经过都会误触发。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.activeIdx, article?.id]);

  // ---- 每日阅读时长（辅助增强二）：朗读播放与停留阅读均计入，15s 批量落盘 ----
  // 双重闸门：document.hidden 之外再加 hasFocus —— 阅读室窗口是点 ✕ 隐藏而非
  // 销毁，WebView2 里隐藏窗口的 document.hidden 不一定为 true，只看它会把
  // 挂在后台的整天都计成阅读时长（2026-09-27 实测一天被记满 86400s）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const a = articleRef.current;
      if (view !== "reading" || !a || document.hidden || !document.hasFocus()) return;
      secondsBufferRef.current += 1;
      if (secondsBufferRef.current < 15) return;
      const chunk = secondsBufferRef.current;
      secondsBufferRef.current = 0;
      patchArticle((cur) => ({
        ...cur,
        progress: { ...cur.progress, secondsListened: cur.progress.secondsListened + chunk },
      }));
      if (a.bookId) {
        scheduleBookMetaSave((b) =>
          b.id === a.bookId ? { ...b, secondsListened: b.secondsListened + chunk } : b,
        );
      }
      void readerRecordReading(localDayKey(), chunk)
        .then(setReadSecondsToday)
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, patchArticle, scheduleBookMetaSave]);

  // ---- 打开/切换文章 ----
  const loadSourceArticles = useCallback(async (ids: string[]) => {
    for (const id of new Set(ids)) {
      if (!id) continue;
      setSourceCache((prev) => {
        if (prev.has(id)) return prev;
        void readerGetArticle(id)
          .then((full) => {
            if (full) setSourceCache((p) => new Map(p).set(id, full));
          })
          .catch(() => undefined);
        return prev;
      });
    }
  }, []);

  /** 「归属本篇」的生词与其中已到期部分（结课条/章末小结共用同一口径）。 */
  const collectArticleWords = useCallback((a: Article) => {
    const words = vocabWordsRef.current.filter((w) => w.source.articleId === a.id);
    const now = Date.now();
    return {
      wordIds: words.map((w) => w.id),
      dueIds: words.filter((w) => isDue(w, now)).map((w) => w.id),
    };
  }, []);

  /**
   * 章末小结卡：本章查词/收录生词/到期词/用时 + 下一章入口。
   * 触发来源只有两个——连续朗读自然播完末句（onFinish）、手动点「读完本章」；
   * 光标滚进最后一句不再弹（那时用户未必读完）。
   */
  const showChapterEnd = useCallback((a: Article) => {
    const book = booksRef.current.find((b) => b.id === a.bookId);
    if (!book) return;
    const chapterIdx = a.chapterIdx ?? bookChapterIndexOf(book, a.id);
    const next = book.chapters[chapterIdx + 1] ?? null;
    const secondsRead = Math.max(0, Math.round(a.progress.secondsListened - openSecondsRef.current));
    const { wordIds, dueIds } = collectArticleWords(a);
    setChapterEnd({
      bookId: book.id,
      bookTitle: book.title,
      chapterIdx,
      chapterCount: book.chapters.length,
      lookups: dictCountRef.current.get(a.id) ?? 0,
      collected: wordIds.length,
      minutes: Math.round(secondsRead / 60),
      nextChapterId: next?.id ?? null,
      nextChapterTitle: next?.title ?? null,
      lastChapter: !next,
      wordIds,
      dueIds,
    });
    trackEvent("chapter_complete", {
      bookId: book.id,
      chapterIdx,
      lookedUpCount: dictCountRef.current.get(a.id) ?? 0,
      collectedCount: wordIds.length,
      dueCount: dueIds.length,
      secondsRead,
    });
  }, [collectArticleWords]);
  showChapterEndRef.current = showChapterEnd;

  /** 短文结课条：本篇收获快照 + 笔记/复习入口（替代原先一闪而过的 toast）。 */
  const showFinishCard = useCallback(
    (a: Article) => {
      const { wordIds, dueIds } = collectArticleWords(a);
      setFinishCard({
        articleId: a.id,
        lookups: dictCountRef.current.get(a.id) ?? 0,
        collected: wordIds.length,
        dueCount: dueIds.length,
        wordIds,
        dueIds,
      });
      trackEvent("article_finish", {
        articleId: a.id,
        lookedUpCount: dictCountRef.current.get(a.id) ?? 0,
        collectedCount: wordIds.length,
        dueCount: dueIds.length,
      });
    },
    [collectArticleWords],
  );
  showFinishCardRef.current = showFinishCard;

  /** 正文末「读完本篇/读完本章」按钮（纯手动阅读路径）：与自然播完走同一落点。 */
  const confirmFinish = useCallback(() => {
    const a = articleRef.current;
    if (!a) return;
    if (a.bookId) showChapterEnd(a);
    else showFinishCard(a);
  }, [showChapterEnd, showFinishCard]);

  const openArticle = useCallback(
    async (id: string) => {
      try {
        const full = await readerGetArticle(id);
        if (!full) return;
        setView("reading");
        setDict({ status: "closed" });
        setSearchMatchIdx(null);
        // 换文章：句子解析/悬停标记/透镜卡 Tab 归位（解析结果属于旧句，不带走）。
        setXray(null);
        setHoveredClause(null);
        setLensMode("xray");
        setTocBookId(null);
        setChapterEnd(null);
        setFinishCard(null);
        // 文章级旧 xfyun 覆盖随迁移允许一并升格，未满足条件时保留旧语义。
        const articleProvider = migrateLegacyTtsProviderValue(
          full.settings?.ttsProvider ?? "edge",
          legacyTtsMigrationAllowed,
        );
        const migratedArticle =
          articleProvider === (full.settings?.ttsProvider ?? "edge")
            ? full
            : { ...full, settings: { ...(full.settings ?? {}), ttsProvider: articleProvider } };
        setArticle(migratedArticle);
        articleRef.current = migratedArticle;
        openSecondsRef.current = migratedArticle.progress.secondsListened;
        playback.reset(migratedArticle.progress.sentenceIdx);
        scheduleSave({ ...migratedArticle, lastReadAt: Date.now() });
        if (migratedArticle.bookId) {
          trackEvent("book_open", {
            bookId: migratedArticle.bookId,
            chapterIdx: migratedArticle.chapterIdx ?? 0,
            sentenceIdx: migratedArticle.progress.sentenceIdx,
          });
          // 云端埋点（Phase 0 §8）：同一触发点补发云端事件（口径与本地
          // book_open 一致：打开书的一章；chapterIdx 缺省归 0）。
          track("book_open", { bookId: migratedArticle.bookId, chapterIdx: migratedArticle.chapterIdx ?? 0 });
          scheduleBookMetaSave((b) =>
            b.id === migratedArticle.bookId ? { ...b, lastReadAt: Date.now() } : b,
          );
        }
        void ensureTranslated(migratedArticle);
        void loadSourceArticles([migratedArticle.id]);
      } catch (error) {
        console.error("[reader] open article failed", error);
        showToast("打开文章失败");
      }
    },
    [ensureTranslated, scheduleSave, showToast, playback, loadSourceArticles, scheduleBookMetaSave, legacyTtsMigrationAllowed],
  );

  /** 书卡/提醒卡进书：直达书级断点章。 */
  const openBookAtBreakpoint = useCallback(
    async (bookId: string) => {
      const book = booksRef.current.find((b) => b.id === bookId);
      if (!book || book.chapters.length === 0) return;
      const target = book.chapters.some((c) => c.id === book.progress.chapterId)
        ? book.progress.chapterId
        : book.chapters[0].id;
      await openArticle(target);
    },
    [openArticle],
  );

  const refreshArticleList = useCallback(async (): Promise<ArticleSummary[]> => {
    try {
      const list = await readerListArticles();
      setArticleList(list);
      return list;
    } catch (error) {
      console.error("[reader] list articles failed", error);
      return [];
    }
  }, []);

  const refreshBooks = useCallback(async (): Promise<BookMeta[]> => {
    try {
      const books = await readerListBooks();
      setBookList(books);
      booksRef.current = books;
      return books;
    } catch (error) {
      console.error("[reader] list books failed", error);
      return [];
    }
  }, []);

  const refreshVocab = useCallback(async () => {
    try {
      const file = await readerGetVocab();
      setVocabWords(file.words ?? []);
      setReviewLog(file.reviewLog ?? { schemaVersion: 1, days: [] });
      // 生词任何变化（收藏/评分/划词新增）都同步托盘角标与菜单文案
      trayRefreshBadge();
    } catch (error) {
      console.error("[reader] load vocab failed", error);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      // 先判定旧 xfyun → cloud 迁移允许（任一讯飞凭据存在或已登录沉浸云），再加载全局设置。
      const migrationAllowed = await resolveLegacyTtsMigrationAllowed();
      if (!active) return;
      setLegacyTtsMigrationAllowed(migrationAllowed);
      const loaded = loadGlobalReaderSettings();
      const migratedProvider = migrateLegacyTtsProviderValue(loaded.ttsProvider, migrationAllowed);
      const migrated =
        migratedProvider === loaded.ttsProvider ? loaded : { ...loaded, ttsProvider: migratedProvider };
      setGlobalSettings(migrated);
      if (migrated !== loaded) saveGlobalReaderSettings(migrated);
      const list = await refreshArticleList();
      const books = await refreshBooks();
      await refreshVocab();
      // 笔记列表随启动加载（而不只进笔记库时）：书架/生词本的「未整理进笔记」
      // 角标首屏就要用，懒加载会让它在首次进笔记库前虚高成全部生词数。
      void refreshNotes();
      // 每日阅读目标（只读配置）与今日已读秒数。
      void reminderGetConfig()
        .then((c) => setReadGoalMin(c.readGoalMin))
        .catch(() => undefined);
      void readerReadSecondsToday(localDayKey())
        .then(setReadSecondsToday)
        .catch(() => undefined);
      if (!active) return;
      // 阅读室热键路径：窗口首次挂载时取走待导入文本（nonce 防与事件路径重复）。
      try {
        const pending = await takePendingReaderImport();
        if (pending) {
          importNonceRef.current = pending.nonce;
          if (list.length > 0) await openArticle(list[0].id);
          importPaste(pending.text);
          return;
        }
      } catch (error) {
        console.error("[reader] take pending import failed", error);
      }
      // 提醒卡「继续阅读」路径：窗口重建时取走书级断点直达请求。
      try {
        const bookId = await takePendingOpenBook();
        if (bookId) {
          await openBookAtBreakpoint(bookId);
          return;
        }
      } catch (error) {
        console.error("[reader] take pending open book failed", error);
      }
      // 默认落在整页书架（书架是首页）；只有外部推入（热键导入/继续阅读）才直接进阅读。
      void list;
      void books;
    })();

    // 浮窗「发送到阅读室」时，若本窗口已打开则切换到新文章
    let unlistenArticle: (() => void) | undefined;
    listen("reader:article-added", () => {
      void (async () => {
        const list = await refreshArticleList();
        if (list.length > 0) void openArticle(list[0].id);
      })();
    }).then((u) => {
      if (active) unlistenArticle = u;
      else u();
    });

    // 阅读室热键路径（窗口已存在时）：事件送达，nonce 去重挂载路径
    let unlistenImport: (() => void) | undefined;
    listen<{ text: string; nonce: string }>("reader:import", (event) => {
      if (event.payload.nonce === importNonceRef.current) return;
      importNonceRef.current = event.payload.nonce;
      importPaste(event.payload.text);
    }).then((u) => {
      if (active) unlistenImport = u;
      else u();
    });

    // 划词浮窗「加入生词本」：刷新生词与到期徽标
    let unlistenVocab: (() => void) | undefined;
    listen("reader:vocab-added", () => {
      void refreshVocab();
    }).then((u) => {
      if (active) unlistenVocab = u;
      else u();
    });

    // 设置窗口保存讯飞凭据后刷新云端合成凭据缓存（其余凭据都是用时加载）。
    let unlistenCreds: (() => void) | undefined;
    listen("xfyun:creds-updated", () => {
      refreshTtsCreds();
    }).then((u) => {
      if (active) unlistenCreds = u;
      else u();
    });

    // 提醒卡「继续阅读」（窗口已存在时）：事件路径直达书级断点。
    let unlistenOpenBook: (() => void) | undefined;
    listen<string>("reader:open-book", (event) => {
      void openBookAtBreakpoint(event.payload);
    }).then((u) => {
      if (active) unlistenOpenBook = u;
      else u();
    });

    return () => {
      active = false;
      unlistenArticle?.();
      unlistenImport?.();
      unlistenVocab?.();
      unlistenCreds?.();
      unlistenOpenBook?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 点标题栏 ✕ = 隐藏窗口，不销毁 ----
  // 窗口一旦销毁，托盘重开就得在 Rust 事件处理器里同步重建 WebView（Windows 上
  // 有死锁/失败风险，实测表现为「关了就再也打不开」）。隐藏则重开是纯 show()，
  // 阅读进度与文章列表原样保留，与历史/设置窗口的关闭行为一致。
  const stopPlaybackRef = useRef(playback.stop);
  stopPlaybackRef.current = playback.stop;
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenP = win.onCloseRequested((event) => {
      event.preventDefault();
      // 隐藏前停掉朗读/评测，避免窗口看不见了声音还在播。
      stopPlaybackRef.current();
      void win.hide();
    });
    return () => {
      void unlistenP.then((u) => u());
    };
  }, []);

  // ---- Web 字体（§4；本地字体兜底已写进令牌） ----
  useEffect(() => {
    const id = "reader-webfonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600&family=Noto+Serif+SC:wght@400&family=Noto+Sans+SC:wght@400;500&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }, []);

  // ---- 导入 / 删除 ----
  const importPaste = useCallback(
    (text: string, title?: string, meta?: ImportMeta) => {
      const built = buildArticleFromText(text, {
        sourceType: meta?.sourceType ?? "paste",
        ...(meta?.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...(title ? { title } : {}),
        ...(meta?.titleCn ? { titleCn: meta.titleCn } : {}),
        ...(meta?.level ? { level: meta.level } : {}),
      });
      if (!built) {
        showToast("没有识别到正文内容");
        return;
      }
      void readerSaveArticle(built)
        .then(async () => {
          await refreshArticleList();
          await openArticle(built.id);
          showToast(`已导入「${built.title}」`);
        })
        .catch((error) => {
          console.error("[reader] import failed", error);
          showToast("导入失败");
        });
    },
    [refreshArticleList, openArticle, showToast],
  );

  const deleteArticle = useCallback(
    (id: string) => {
      void readerDeleteArticle(id)
        .then(async () => {
          await refreshArticleList();
          if (articleRef.current?.id === id) {
            setArticle(null);
            articleRef.current = null;
            playback.reset(0);
            goShelf();
          }
          showToast("文章已删除");
        })
        .catch((error) => {
          console.error("[reader] delete failed", error);
          showToast("删除失败");
        });
    },
    [refreshArticleList, goShelf, playback, showToast],
  );

  /** 整本入库（EPUB/长书 tab 确认导入）：章文本 → 章 Article（sourceType="epub"）。 */
  const importBook = useCallback(
    (draft: BookImportDraft) => {
      const now = Date.now();
      const bookId = `b${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const chapters: Article[] = [];
      const metas: BookChapterMeta[] = [];
      draft.chapters.forEach((ch, idx) => {
        const built = buildArticleFromText(ch.text, {
          sourceType: "epub",
          title: ch.title,
          now: now + idx,
        });
        if (!built) return;
        const chapter: Article = { ...built, bookId, chapterIdx: metas.length };
        chapters.push(chapter);
        metas.push({
          id: chapter.id,
          title: chapter.title,
          wordCount: chapter.wordCount,
          sentenceCount: chapter.sentences.length,
        });
      });
      if (metas.length === 0) {
        showToast("没有可导入的章节内容");
        return;
      }
      const meta: BookMeta = {
        id: bookId,
        title: draft.title,
        ...(draft.author ? { author: draft.author } : {}),
        ...(draft.cover ? { cover: draft.cover } : {}),
        createdAt: now,
        lastReadAt: now,
        chapters: metas,
        progress: { chapterId: metas[0].id, sentenceIdx: 0, percent: 0 },
        secondsListened: 0,
        radar: draft.radar,
      };
      setImportOpen(false);
      void readerSaveBook(meta, chapters)
        .then(async (books) => {
          setBookList(books);
          booksRef.current = books;
          showToast(`已导入《${draft.title}》· ${metas.length} 章`);
          // 发现页下载导入：入库成功才上报 discover_import（本地导入缺省不埋）。
          const discoverEv = discoverImportProps(draft);
          if (discoverEv) track("discover_import", discoverEv);
          await openArticle(metas[0].id);
        })
        .catch((error) => {
          console.error("[reader] import book failed", error);
          showToast("导入书籍失败");
        });
    },
    [openArticle, showToast],
  );

  /** 删除书 = 删书卡与全部章文章（进度不可恢复），生词一律保留。 */
  const deleteBook = useCallback(
    (bookId: string) => {
      void readerDeleteBook(bookId)
        .then(async (removed) => {
          if (!removed) return;
          await refreshBooks();
          if (articleRef.current?.bookId === bookId) {
            setArticle(null);
            articleRef.current = null;
            playback.reset(0);
            goShelf();
          }
          showToast("这本书已删除（生词保留）");
        })
        .catch((error) => {
          console.error("[reader] delete book failed", error);
          showToast("删除书籍失败");
        });
    },
    [refreshBooks, goShelf, playback, showToast],
  );

  // ---- 词典（屏 C） ----
  const lookup = useCallback(
    async (query: string, sentenceIdx: number) => {
      const articleId = articleRef.current?.id ?? "";
      const sourceSentence = articleRef.current?.sentences[sentenceIdx]?.en ?? "";
      dictCountRef.current.set(articleId, (dictCountRef.current.get(articleId) ?? 0) + 1);
      setLensMode("lex"); // 查词发生 → 透镜卡切到「查词」Tab
      setDict({ status: "loading", query, sentenceIdx, sourceSentence });
      const s = await loadSettingsAsync().catch(() => null);
      if (!s || !hasValidSettings(s)) {
        setDict({
          status: "error",
          query,
          sentenceIdx,
          sourceSentence,
          message: "请先在设置中配置翻译接口",
        });
        return;
      }
      const target = resolveTargetLanguage(query, { mode: s.translationMode, fixed: s.fixedTarget });
      const tag = `rd${++translateSeqRef.current}`;
      const res = await requestTranslate(
        query,
        buildReaderDictPrompt({ targetLanguage: target, customStyle: "", glossaryText: s.glossaryText }),
        tag,
      );
      if (res.status === "cancelled") {
        setDict({ status: "closed" });
        return;
      }
      if (res.status === "error") {
        setDict({ status: "error", query, sentenceIdx, sourceSentence, message: res.text });
        return;
      }
      const parsed = parseReaderDictResponse(res.text);
      if (parsed.kind === "entry") {
        setDict({ status: "ready", query, entry: parsed.entry, sentenceIdx, sourceSentence });
      } else if (parsed.kind === "notAWord") {
        setDict({ status: "notAWord", query, sentenceIdx, sourceSentence });
      } else {
        setDict({ status: "error", query, sentenceIdx, sourceSentence, message: "返回格式无法解析，请重试" });
      }
    },
    [requestTranslate],
  );

  const speakWord = useCallback(
    (text: string) => {
      void speechEngine
        .speak(text, looksMostlyChinese(text), { track: "word", target: "reader", rate: 1 })
        .catch((error) => console.error("[reader] word tts failed", error));
    },
    [speechEngine],
  );

  /**
   * 句子解析（v0.8 透镜卡「句子解析」Tab）：当前句 en 走 translateStream
   * （tag 前缀 rx，不与 rt/rp/rd/rc/replay 冲突），拿到主干/结构拆解/句型。
   * 失败只提示不阻塞阅读；解析结果不落盘（句子没变就不用重查，Phase 2 先
   * 以会话内 state 承载）。
   */
  const lookupXray = useCallback(
    async (idx: number) => {
      const a = articleRef.current;
      const en = a?.sentences[idx]?.en;
      if (!en) return;
      setLensMode("xray");
      setXray({ status: "loading", sentenceIdx: idx, data: null });
      const s = await loadSettingsAsync().catch(() => null);
      if (!s || !hasValidSettings(s)) {
        setXray({ status: "error", sentenceIdx: idx, data: null });
        showToast("先在设置里配置翻译接口，才能解析句子");
        return;
      }
      const target = resolveTargetLanguage(en, { mode: s.translationMode, fixed: s.fixedTarget });
      const tag = `rx${++translateSeqRef.current}`;
      const res = await requestTranslate(
        buildSentenceXrayInput(en),
        buildSentenceXraySystemPrompt(target),
        tag,
      );
      if (articleRef.current?.id !== a.id) return; // 请求期间已切文章，作废
      if (res.status !== "done") {
        setXray({ status: "error", sentenceIdx: idx, data: null });
        showToast("句子解析失败，稍后再试");
        return;
      }
      const parsed = parseSentenceXrayResponse(res.text, en);
      if (!parsed) {
        setXray({ status: "error", sentenceIdx: idx, data: null });
        showToast("句子解析结果无法解析，请重试");
        return;
      }
      setXray({ status: "ready", sentenceIdx: idx, data: parsed });
    },
    [requestTranslate, showToast],
  );

  /** 点正文词块下划线 → 即时卡（无 LLM 调用）。 */
  const openChunkCard = useCallback((sentenceIdx: number, chunk: SentenceChunk) => {
    setDict({
      status: "chunk",
      chunk,
      sentenceIdx,
      sourceSentence: articleRef.current?.sentences[sentenceIdx]?.en ?? "",
    });
  }, []);

  const addVocab = useCallback(() => {
    if (!articleRef.current) return;
    if (dict.status === "chunk") {
      const word = chunkToVocab(dict.chunk, {
        articleId: articleRef.current.id,
        sentenceIdx: dict.sentenceIdx,
      });
      void readerSaveVocabWord(word)
        .then(async () => {
          await refreshVocab();
          showToast(`已收藏词块：${word.word}`);
        })
        .catch((error) => {
          console.error("[reader] add chunk vocab failed", error);
          showToast("收藏词块失败");
        });
      return;
    }
    if (dict.status !== "ready") return;
    const word = entryToVocab(dict.entry, {
      articleId: articleRef.current.id,
      sentenceIdx: dict.sentenceIdx,
    });
    void readerSaveVocabWord(word)
      .then(async () => {
        await refreshVocab();
        showToast(`已加入生词本：${word.word}`);
      })
      .catch((error) => {
        console.error("[reader] add vocab failed", error);
        showToast("加入生词本失败");
      });
  }, [dict, refreshVocab, showToast]);

  const inVocab = useMemo(() => {
    if (dict.status === "closed") return false;
    const key = dict.status === "chunk" ? dict.chunk.text : dict.query;
    return vocabWords.some((w) => w.id === normalizeWordKey(key));
  }, [dict, vocabWords]);

  /** 生词再现标记：生词本归一化 id 集。 */
  const knownIds = useMemo(() => new Set(vocabWords.map((w) => w.id)), [vocabWords]);
  /** 本章生词（按当前文章 id 过滤；DictColumn「本章生词」第三 tab 数据源，
      外壳 2026-10-26 契约 chapterVocab）。 */
  const chapterVocab = useMemo(
    () => (article ? vocabWords.filter((w) => w.source.articleId === article.id) : []),
    [vocabWords, article?.id],
  );

  /** 常用搭配行一键收藏为词块。 */
  const addCollVocab = useCallback(
    (coll: VocabCollocation) => {
      const a = articleRef.current;
      if (!a || dict.status !== "ready") return;
      const word = chunkToVocab(
        { text: coll.en, chunkType: "collocation", gloss: coll.cn },
        { articleId: a.id, sentenceIdx: dict.sentenceIdx },
      );
      void readerSaveVocabWord(word)
        .then(async () => {
          await refreshVocab();
          showToast(`已收藏搭配：${word.word}`);
        })
        .catch((error) => {
          console.error("[reader] add coll vocab failed", error);
          showToast("收藏搭配失败");
        });
    },
    [dict.status, refreshVocab, showToast],
  );

  // ---- 复习（屏 D） ----
  const pendingRecallRef = useRef(new Map<string, { mode: RecallMode; bucket: "pass" | "wrong" | "trap" }>());
  const gradeVocab = useCallback(
    (word: VocabWord, g: ReviewGrade) => {
      void Promise.resolve().then(() => {
        const recall = pendingRecallRef.current.get(word.id); pendingRecallRef.current.delete(word.id);
        return readerGradeVocab(word, g, recall?.mode ?? "recognition", recall ? { bucket: recall.bucket } : undefined);
      })
        .then(() => {
          setReviewLog((log) => recordReview(log));
          return refreshVocab();
        })
        .catch((error) => {
          console.error("[reader] grade failed", error);
          showToast("保存复习记录失败");
        });
    },
    [refreshVocab, showToast],
  );

  /** 一次复习判分 → 错题分桶落盘（笔记「为什么记不住」诊断的数据源）。 */
  const handleRecall = useCallback(
    (wordId: string, mode: RecallMode, judged: RecallVerdict | null, g: ReviewGrade) => {
      const bucket = recallBucket(mode, judged, g);
      pendingRecallRef.current.set(wordId, { mode, bucket });
    },
    [],
  );

  /**
   * 随读抽查判分：只有生词再现槽联动 SRS（限幅：即时回忆最高只记 good，
   * 防刚见过的词推高间隔——见 clozeSlots.clozeVerdictToGrade）；
   * 词块槽不进生词本，纯在正文里给反馈。
   */
  const clozeVerdict = useCallback(
    (slot: ClozeSlot, verdict: RecallVerdict) => {
      if (!slot.isKnown || !slot.vocabId) return;
      const word = vocabWords.find((w) => w.id === slot.vocabId);
      if (!word) return;
      const g = clozeVerdictToGrade(verdict);
      gradeVocab(word, g);
      handleRecall(word.id, "cloze", verdict, g);
    },
    [vocabWords, gradeVocab, handleRecall],
  );

  /** 加练判分后把词移出队列（与到期队列「评完即走」同一语义）。 */
  const gradeAndDrainFocus = useCallback(
    (word: VocabWord, g: ReviewGrade) => {
      gradeVocab(word, g);
      setFocusIds((f) => (f ? f.filter((id) => id !== word.id) : f));
    },
    [gradeVocab],
  );

  /** 笔记复盘区「开始复习 / 只测仍错的词」：只排这批词，不等到期（v0.8 落地 vault 专注态）。 */
  const startFocusReview = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        showToast("这篇笔记的词这一轮都通过了，没有要补的");
        return;
      }
      setFocusIds(ids);
      setReviewPos(0);
      setVaultMode("focus");
      setView("vault");
    },
    [showToast],
  );

  /** 离开复习视图就退出加练（回到普通到期队列）。 */
  const exitFocus = useCallback(() => setFocusIds(null), []);
  const goReading = useCallback(() => {
    setFocusIds(null);
    setView("reading");
  }, []);
  /** 生词复习（v0.8 改版：vault 复习首页，Hero 开始复习再进专注态）。 */
  const goReview = useCallback(() => {
    setFocusIds(null);
    setVaultMode("home");
    setView("vault");
  }, []);
  /** 笔记库（v0.8 改版：vault 的「全部笔记」档，stage 内嵌 NotesView）。 */
  const goNotes = useCallback(() => {
    setFocusIds(null);
    setVaultMode("notes");
    setView("vault");
  }, []);
  const goSpeak = useCallback(() => {
    setFocusIds(null);
    setView("speak");
  }, []);
  /** 「用这句练口语」：带入句记进 pendingSpeak 再进口语（Phase 3 消费）。 */
  const practiceSentence = useCallback(
    (idx: number) => {
      const a = articleRef.current;
      if (!a) return;
      setPendingSpeak({ kind: "book", articleId: a.id, sentenceIdx: idx });
      goSpeak();
      showToast(`已带入第 ${idx + 1} 句进入口语对话`);
    },
    [goSpeak, showToast],
  );
  /** 刊头「围绕本章练口语」：以当前光标句为锚带入本章语境。 */
  const practiceChapter = useCallback(
    (idx: number) => {
      const a = articleRef.current;
      if (!a) return;
      setPendingSpeak({ kind: "book", articleId: a.id, sentenceIdx: idx });
      goSpeak();
      showToast("已带入本章进入口语对话");
    },
    [goSpeak, showToast],
  );
  /** 导航岛三档路由（v0.8）：阅读 / 口语 / 笔记与复习。
   * vault 档落在三合一页（Phase 4）：已在 vault 内不重置玩法档，跨视图进入保留上次档位。 */
  const navigateSurface = useCallback(
    (surface: IslandSurface) => {
      setFolioOpen(false);
      if (surface === "reading") goReading();
      else if (surface === "speak") goSpeak();
      else setView("vault");
    },
    [goReading, goSpeak],
  );
  /** 导航岛当前高亮档：shelf/reading→阅读、speak→口语、vault→笔记与复习。 */
  const islandSurface: IslandSurface =
    view === "speak" ? "speak" : view === "vault" ? "vault" : "reading";

  // ---- 笔记库 ----
  const replaySeqRef = useRef(0);
  const refreshNotes = useCallback(async () => {
    try {
      const list = await noteList();
      setNotes(list);
      return list;
    } catch (error) {
      console.error("[reader] list notes failed", error);
      return [];
    }
  }, []);
  useEffect(()=>{
    let disposed=false;let loadGeneration=0;
    const warning=listen<{message:string}>("learning-export-warning",event=>showToast(event.payload.message));
    const refresh=async()=>{const generation=++loadGeneration;try{const [articles,books,vocab,noteRows,sessions]=await Promise.all([readerListArticles(),readerListBooks(),readerGetVocab(),noteList(),speakListSessions()]);if(disposed||generation!==loadGeneration)return;setArticleList(articles);setBookList(books);booksRef.current=books;setVocabWords(vocab.words);setReviewLog(vocab.reviewLog);setNotes(noteRows);setSpeakSessions(sessions.slice(0,20));}catch(error){console.error("[reader] relay refresh failed",error);}};
    const completed=()=>{void refresh();};window.addEventListener("learning-sync-complete",completed);
    let account:string|undefined;let authEventReceived=false;
    void authGetStatus().then(status=>{if(!authEventReceived)account=status.user?.id??"guest";});
    const unlisten=listenAuthStateChanged(status=>{authEventReceived=true;const next=status.user?.id??"guest";if(next===account)return;const adoptingGuest=(account===undefined||account==="guest")&&status.loggedIn;account=next;loadGeneration++;setArticle(null);setArticleList([]);setBookList([]);booksRef.current=[];setVocabWords([]);setReviewLog({schemaVersion:1,days:[]});setNotes([]);setActiveNote(null);setSpeakSessions([]);setSourceCache(new Map());setPendingSpeak(null);setView(previous=>adoptingGuest&&previous==="speak"?previous:"shelf");void refresh();if(status.loggedIn)void syncLearningRecordsSilently();});
    return()=>{disposed=true;loadGeneration++;window.removeEventListener("learning-sync-complete",completed);void unlisten.then(fn=>fn());void warning.then(fn=>fn());};
  },[]);
  useEffect(()=>{const open=(event:Event)=>{const source=(event as CustomEvent<{articleId:string;sentenceIdx:number}>).detail;if(!source?.articleId)return;void readerGetArticle(source.articleId).then(found=>{if(!found){showToast("原文已删除，练习仍保留完整参考句和反馈");return;}setArticle({...found,progress:{...found.progress,sentenceIdx:source.sentenceIdx}});setView("reading");}).catch(error=>showToast(String(error)));};window.addEventListener("reader-relay-source",open);return()=>window.removeEventListener("reader-relay-source",open);},[showToast]);

  const openNote = useCallback(async (file: string) => {
    try {
      const content = await noteRead(file);
      if (!content) return;
      setActiveNote({ meta: content.meta, parsed: parseNoteMarkdown(content.content) });
    } catch (error) {
      console.error("[reader] read note failed", error);
    }
  }, []);

  const activeNoteFile = activeNote?.meta.file ?? null;
  const selectNote = useCallback(
    (file: string) => {
      if (file === activeNoteFile) return;
      void openNote(file);
    },
    [activeNoteFile, openNote],
  );

  const deleteNote = useCallback(
    (file: string) => {
      if (!window.confirm("删除这篇笔记？删除后不可恢复。")) return;
      void noteDelete(file)
        .then(async (removed) => {
          if (!removed) return;
          setActiveNote((cur) => (cur?.meta.file === file ? null : cur));
          await refreshNotes();
          showToast("已删除笔记");
        })
        .catch((error) => console.error("[reader] delete note failed", error));
    },
    [refreshNotes, showToast],
  );

  /** 生成弹窗「在笔记库打开」：切到笔记库并打开刚存的这篇。 */
  const openSavedNote = useCallback(
    async (meta: NoteMeta) => {
      setNoteDialogOpen(false);
      goNotes();
      await refreshNotes();
      await openNote(meta.file);
    },
    [refreshNotes, openNote, goNotes],
  );

  const openNoteGenerator = useCallback(() => {
    setNotePreselect(undefined);
    setNoteDialogOpen(true);
  }, []);

  /** 口语复盘「生成复习笔记」：预选刚加入的词。 */
  const openNoteGeneratorWith = useCallback((ids: string[]) => {
    setNotePreselect(ids);
    setNoteDialogOpen(true);
  }, []);

  /** 复盘后又产生了新的复习记录 → 允许（重新）生成复盘。 */
  const generateReplay = useCallback(
    async (meta: NoteMeta) => {
      const noteWords = vocabWords.filter((w) => meta.wordIds.includes(w.id));
      // 与笔记库实时口径一致（isStillWeak）：从没测过的词算仍错，不算「已过」，
      // 否则只测了部分词时会误报「全部通过，无需复盘」。
      const weak = noteWords.filter(isStillWeak).map((w) => w.id);
      if (weak.length === 0) {
        showToast("这一轮全部通过，无需复盘");
        return;
      }
      setReplayBusy(true);
      try {
        const weakWords = noteWords.filter((w) => weak.includes(w.id));
        const tag = `replay${++replaySeqRef.current}`;
        const res = await requestTranslate(
          buildReplayInput(noteWords, weak, meta.file),
          buildReplaySystemPrompt(),
          tag,
        );
        if (res.status !== "done") {
          showToast(res.status === "cancelled" ? "复盘已取消" : "复盘失败，请重试");
          return;
        }
        const parsedReplay = parseReplay(res.text);
        if (!parsedReplay) {
          showToast("复盘结果无法解析，请重试");
          return;
        }
        if (!verifyReplayWords(parsedReplay, weakWords)) {
          showToast("复盘的仍错词头与记录不符，请重试");
          return;
        }
        const replay: NoteReplay = {
          rounds: (meta.replay?.rounds ?? 0) + 1,
          lastAt: Date.now(),
          passed: noteWords.length - weak.length,
          stillWeak: weak.length,
          verdict: parsedReplay.verdict,
          // 词头按宽容归一化回挂词条（LLM 可能改大小写/加后缀，精确相等会静默丢词）。
          weak: parsedReplay.weak.map((item) => ({ w: item.w, why: item.why })),
        };
        const updated = await noteWriteReplay(meta.file, replay, replay.rounds, Date.now());
        await refreshNotes();
        if (activeNoteFile === meta.file) await openNote(meta.file);
        showToast(`复盘完成：${updated.replay?.stillWeak ?? weak.length} 词仍错`);
      } catch (error) {
        console.error("[reader] replay failed", error);
        showToast("复盘失败，请重试");
      } finally {
        setReplayBusy(false);
      }
    },
    [vocabWords, requestTranslate, refreshNotes, openNote, activeNoteFile, showToast],
  );

  /** 把仍错词滚进新笔记：预选打开生成弹窗。 */
  const rollIntoNote = useCallback(
    (replay: NoteReplay) => {
      const ids = replay.weak
        .map((item) => findWordByHeading(item.w, vocabWords)?.id)
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) {
        showToast("没有可滚进的词条");
        return;
      }
      setNotePreselect(ids);
      setNoteDialogOpen(true);
    },
    [vocabWords, showToast],
  );

  useEffect(() => {
    if (view === "vault" && vocabWords.length > 0) {
      void loadSourceArticles(vocabWords.map((w) => w.source.articleId));
    }
  }, [view, vocabWords, loadSourceArticles]);

  // 进入笔记库：刷新列表；没有打开的笔记时自动打开最近一篇。
  // v0.8：笔记库挂在 vault 的 Markdown 导出档（弹层回看），进 vault 即预载。
  useEffect(() => {
    if (view !== "vault") return;
    let cancelled = false;
    void (async () => {
      const list = await refreshNotes();
      if (cancelled) return;
      if (!activeNote && list.length > 0) await openNote(list[0].file);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, refreshNotes, openNote, activeNote]);

  // 进 vault 视图：拉取口语会话（手账口语条目与 Markdown 导出的数据源；
  // 从口语视图回来也会经过这里刷新，覆盖最新一轮的 coachDiff/pron）。
  useEffect(() => {
    if (view !== "vault") return;
    void speakListSessions()
      .then((list) => setSpeakSessions(list.slice(0, 20)))
      .catch((error) => console.error("[reader] list speak sessions failed", error));
  }, [view]);

  const stats = useMemo(() => reviewStats(vocabWords, reviewLog), [vocabWords, reviewLog]);
  const dueNow = useMemo(() => dueVocab(vocabWords).length, [vocabWords]);
  /** 到期队列：复习卡与左栏词表共用同一序号，pos 上提在此（左栏词表可跳卡）。 */
  const dueWords = useMemo(() => dueVocab(vocabWords), [vocabWords]);
  /** 加练模式下复习队列 = 笔记仍错词（无视到期时间）；否则 = 全局到期队列。 */
  const activeDue = useMemo(
    () => (focusIds ? vocabWords.filter((w) => focusIds.includes(w.id)) : dueWords),
    [focusIds, vocabWords, dueWords],
  );
  /** 还没整理进任何笔记的生词数（笔记库入口角标：该整理了）。 */
  const unnotedCount = useMemo(() => {
    const noted = new Set(notes.flatMap((n) => n.wordIds));
    return vocabWords.filter((w) => !noted.has(w.id)).length;
  }, [vocabWords, notes]);
  const [reviewPos, setReviewPos] = useState(0);
  useEffect(() => {
    // 每次进入生词本/三合一页都从队首开始（离开即卸载，pos 归零防跨模式残留）
    if (view === "vault") setReviewPos(0);
  }, [view]);

  const jumpToSentence = useCallback(
    (articleId: string, sentenceIdx: number) => {
      if (articleRef.current?.id !== articleId) {
        void openArticle(articleId).then(() => playback.jumpTo(sentenceIdx));
      } else {
        setView("reading");
        playback.jumpTo(sentenceIdx);
      }
    },
    [openArticle, playback],
  );

  // ---- 键盘（§9-11：空格/J/K/L/H 只在阅读视图生效——笔记库/复习/口语页
  // 会用空格滚页、J/K 翻列表，劫持会在后台误触朗读；方向键不劫持） ----
  useEffect(() => {
    function isTyping(el: EventTarget | null): boolean {
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTyping(e.target)) return;
      if (view !== "reading") return;
      if (e.key === " ") {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === "j" || e.key === "J") {
        playback.step(1);
      } else if (e.key === "k" || e.key === "K") {
        playback.toggle();
      } else if (e.key === "l" || e.key === "L") {
        playback.step(-1);
      } else if ((e.key === "h" || e.key === "H") && (effectiveSettings.maskTranslation || effectiveSettings.spotQuizMode)) {
        setPeekAll(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "h" || e.key === "H") setPeekAll(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [view, playback, effectiveSettings.maskTranslation, effectiveSettings.spotQuizMode]);

  // ---- 渲染 ----
  /** 光标已停在末句（自然播完/跳读/滚动到底都会到这）且还没确认读完。 */
  const atArticleEnd =
    !!article && article.sentences.length > 0 && playback.activeIdx >= article.sentences.length - 1;
  /** 正文末「读完本篇/本章」按钮：到位即出，读完确认后撤下。 */
  const showFinishAction =
    view === "reading" && atArticleEnd && !finishCard && !chapterEnd && !playback.playing;
  /** 当前打开文章所属的书（书章模式）。 */
  const currentBook = useMemo(
    () => (article?.bookId ? bookList.find((b) => b.id === article.bookId) ?? null : null),
    [article?.bookId, bookList],
  );
  /** 词典栏/生词词条的书级来源：「《书名》·第 N 章」。 */
  const bookSource = useMemo(() => {
    if (!article?.bookId || !currentBook) return null;
    const idx = article.chapterIdx ?? bookChapterIndexOf(currentBook, article.id);
    return `《${currentBook.title}》·第 ${idx + 1} 章`;
  }, [article, currentBook]);
  /** 章文章 id → 「《书名》·第 N 章」（复习卡/生词来源展示；短文回落标题）。 */
  const chapterLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bookList) {
      b.chapters.forEach((c, i) => map.set(c.id, `《${b.title}》·第 ${i + 1} 章`));
    }
    return map;
  }, [bookList]);
  /**
   * 口语场景中心「聊刚读的章节」卡的语境（v0.8 Phase 3）：只有书章给出
   * （短文无章节概念，避免「第 1 章」的假上下文）。pendingSpeak 带 sentenceIdx
   * 时（阅读室「用这句练口语」）把那句放进摘要首位——口语侧的开场白与系统
   * 提示自然从这句聊起。
   */
  const speakBookContext = useMemo(() => {
    if (!article?.bookId || !currentBook) return null;
    const chapterIdx = article.chapterIdx ?? bookChapterIndexOf(currentBook, article.id);
    const ens = article.sentences.map((s) => s.en);
    const pending =
      pendingSpeak?.kind === "book" && pendingSpeak.articleId === article.id ? pendingSpeak : null;
    const focus = pending ? ens[pending.sentenceIdx] : undefined;
    const excerpt = [focus, ...ens].filter((s): s is string => Boolean(s)).slice(0, 3);
    return {
      articleId: article.id,
      title: currentBook.title,
      chapterIdx,
      excerpt: excerpt.length > 0 ? excerpt : [article.title],
    };
  }, [article, currentBook, pendingSpeak]);
  /** 口语「生词造句闯关」：今日待复习词（最多 8 个，与 pendingSpeak vocab 通道共用）。 */
  const speakDueWords = useMemo(() => dueWords.slice(0, 8), [dueWords]);
  /** 口语里用出目标词：按 easy 档记 SRS 并落 spokenAt（内化看板「已变成口语表达」）。 */
  const gradeSpokenVocab = useCallback(
    (word: VocabWord, g: "easy") => {
      gradeVocab(g === "easy" ? { ...word, spokenAt: Date.now() } : word, g);
    },
    [gradeVocab],
  );
  /** 加练队列里开口命中：同样按 easy+spokenAt 落盘，并把词移出队列。 */
  const gradeSpokenAndDrainFocus = useCallback(
    (word: VocabWord, g: "easy") => {
      gradeSpokenVocab(word, g);
      setFocusIds((f) => (f ? f.filter((id) => id !== word.id) : f));
    },
    [gradeSpokenVocab],
  );
  /** 手账/看板「去口语里用一次」：pendingSpeak 置 vocab 形态再进口语造句闯关
   * （Phase 2 定形状、Phase 3 消费的同一通道，不新增传参）。 */
  const practiceVocabSpeak = useCallback(() => {
    setPendingSpeak({ kind: "vocab" });
    goSpeak();
  }, [goSpeak]);
  /** 发音详情「慢速示范 0.75×」：word 轨 + 云引擎原生 -25% 合成（SAPI 走普通朗读）。 */
  const speakWordSlowly = useCallback(
    (text: string) => speechEngine.speak(text, false, { track: "word", target: "reader", rate: 1, nativeRate: "-25%" }),
    [speechEngine],
  );
  /** 每章已收藏生词数（目录面板）。 */
  const vocabCountByChapter = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const w of vocabWords) {
      counts[w.source.articleId] = (counts[w.source.articleId] ?? 0) + 1;
    }
    return counts;
  }, [vocabWords]);

  /** 书架页考试目标（与导入弹窗同一 localStorage 键）。 */
  const shelfExamGoal: ExamGoal = useMemo(() => {
    const saved = localStorage.getItem("intake-exam-goal");
    return saved && ["kaoyan", "cet4", "cet6"].includes(saved) ? (saved as ExamGoal) : "kaoyan";
  }, []);

  // 书架页短文覆盖：懒加载全文到 sourceCache 后本地词表现算（书架页才拉）。
  useEffect(() => {
    if (view === "shelf" && articleList.length > 0) {
      void loadSourceArticles(articleList.map((a) => a.id));
    }
  }, [view, articleList, loadSourceArticles]);

  const articleCoverage = useMemo(() => {
    const map: Record<string, CoverageStats> = {};
    if (view !== "shelf") return map;
    for (const a of articleList) {
      const full = sourceCache.get(a.id);
      if (!full) continue;
      const text = full.sentences.map((s) => s.en).join(" ");
      map[a.id] = coverageForText(text, shelfExamGoal, vocabWords);
    }
    return map;
  }, [view, articleList, sourceCache, vocabWords, shelfExamGoal]);

  /** 目录面板当前展示的书（阅读页章节栏 / 书架「查看目录」共用）。 */
  const tocBook = useMemo(
    () => (tocBookId ? bookList.find((b) => b.id === tocBookId) ?? null : null),
    [tocBookId, bookList],
  );

  const articleTitle = useCallback(
    (id: string) =>
      chapterLabelById.get(id) ??
      sourceCache.get(id)?.title ??
      articleList.find((a) => a.id === id)?.title ??
      null,
    [chapterLabelById, sourceCache, articleList],
  );
  /** 原句含译文（复习完形卡的中文提示行）。 */
  const sourceSentence = useCallback((id: string, sentenceIdx: number) => {
    const s = sourceCache.get(id)?.sentences[sentenceIdx];
    return s ? { en: s.en, zh: s.zh } : null;
  }, [sourceCache]);

  /** 听写卡整句朗读：word 音轨 + 稍慢语速，与句子朗读音轨互不打断。 */
  const speakRecallSentence = useCallback(
    (text: string) => {
      void speechEngine
        .speak(text, false, { track: "word", target: "reader", rate: 0.92 })
        .catch((error) => console.error("[reader] recall sentence tts failed", error));
    },
    [speechEngine],
  );

  /** 口语陪练的播报通道。必须引用稳定（useCallback）：SpeakView 的卸载保护
   * effect 依赖 stopSpeak，内联箭头会让任何 ReaderApp 重渲染都执行 cleanup，
   * 掐断进行中的录音。 */
  const speakEnToView = useCallback(
    (text: string) =>
      speechEngine.speak(text, false, { track: "sentence", target: "reader", rate: effectiveSettings.rate }),
    [speechEngine, effectiveSettings.rate],
  );
  const stopSpeakTrack = useCallback(() => {
    void speechEngine.stopTrack("sentence").catch(() => undefined);
  }, [speechEngine]);

  /** 复习模式只进全局默认，不写文章覆盖（复习不随文章变化）。 */
  const patchReviewMode = useCallback(
    (patch: Partial<ReaderSettings>) => {
      if (patch.reviewMode === undefined) return;
      const merged: ReaderSettings = { ...globalSettings, reviewMode: patch.reviewMode };
      setGlobalSettings(merged);
      saveGlobalReaderSettings(merged);
    },
    [globalSettings],
  );

  const rootStyle = {
    "--read-en-size-cur": `${effectiveSettings.fontSize}px`,
    "--read-en-lh-cur": `${Math.round((effectiveSettings.fontSize / 19) * 29 * effectiveSettings.lineHeight)}px`,
    "--read-cn-size-cur": `${Math.round((effectiveSettings.fontSize / 19) * 15)}px`,
    "--read-cn-lh-cur": `${Math.round((effectiveSettings.fontSize / 19) * 24 * effectiveSettings.lineHeight)}px`,
  } as CSSProperties;

  /** 笔记库渲染内核（Props 不变，由本组件继续喂数据）：vault 的 md 档弹层回看入口。 */
  const notesPanel = (
    <NotesView
      notes={notes}
      activeId={activeNote?.meta.file ?? null}
      active={activeNote}
      words={vocabWords}
      reviewedToday={stats.reviewedToday}
      streak={stats.streak}
      dueNow={dueNow}
      newWords={unnotedCount}
      replayBusy={replayBusy}
      onSelect={selectNote}
      onDelete={deleteNote}
      onOpenReader={goReading}
      onOpenReview={goReview}
      onStartFocusReview={startFocusReview}
      onGenerate={openNoteGenerator}
      onGenerateReplay={(meta) => void generateReplay(meta)}
      onRollIntoNote={rollIntoNote}
      onSpeakWord={speakWord}
      readMinutesToday={Math.round(readSecondsToday / 60)}
      readGoalMin={readGoalMin}
    />
  );

  return (
    /* data-skin='folio'：书架/阅读两视图挂 folio 外壳皮肤（令牌矩阵与共享基元见
       reader.css 末尾「外壳重构 2026-10-26」横幅）；口语/笔记视图不挂，v0.8
       主题层原样。data-theme 四主题循环与 data-font 均不受影响。 */
    <div
      className="reader-root"
      data-theme={effectiveSettings.theme}
      data-font={effectiveSettings.fontPair}
      data-skin={view === "shelf" || view === "reading" ? "folio" : undefined}
      style={rootStyle}
    >
      <ReaderTopBar
        articleName={
          view === "shelf"
            ? null
            : view === "vault"
              ? "笔记与复习"
              : view === "speak"
                ? "口语陪练"
                : (article?.title ?? null)
        }
        onHome={goShelf}
        settings={effectiveSettings}
        onPatchSettings={patchSettings}
        onOpenDrawer={() => setDrawerOpen(true)}
        onSearch={(q) => {
          if (!article) return;
          const lower = q.toLowerCase();
          const hit = article.sentences.find((s) => s.en.toLowerCase().includes(lower));
          if (hit) {
            setSearchMatchIdx(hit.idx);
            playback.setActiveIdx(hit.idx);
            showToast(`在第 ${hit.idx + 1} 句找到「${q}」`);
          } else {
            showToast(`本文没有包含「${q}」的句子`);
          }
        }}
        view={islandSurface}
        dueNow={dueNow}
        unnotedCount={unnotedCount}
        onNavigate={navigateSurface}
        onToggleFolio={() => setFolioOpen((v) => !v)}
        focusMode={view === "vault" && vaultMode === "focus"}
      />

      {folioOpen && (
        <FolioSheet
          articles={articleList}
          books={bookList}
          activeBookId={currentBook?.id ?? null}
          onSelect={(id) => void openArticle(id)}
          onContinueBook={(b) => void openBookAtBreakpoint(b.id)}
          onDelete={deleteArticle}
          onDeleteBook={deleteBook}
          onOpenImport={() => openImport()}
          onClose={() => setFolioOpen(false)}
        />
      )}

      {view === "reading" && effectiveSettings.showProgress && article && (
        <div className="reader-inkline" aria-hidden>
          <i style={{ width: `${Math.round(article.progress.percent)}%` }} />
        </div>
      )}

      <div className="reader-body">
        {view === "shelf" && (
          <ShelfPage
            books={bookList}
            articles={articleList}
            articleCoverage={articleCoverage}
            examGoal={shelfExamGoal}
            readMinutesToday={Math.round(readSecondsToday / 60)}
            readGoalMin={readGoalMin}
            reviewedToday={stats.reviewedToday}
            dueNow={dueNow}
            streak={stats.streak}
            onContinueBook={(b) => void openBookAtBreakpoint(b.id)}
            onOpenBookToc={(b) => setTocBookId(b.id)}
            onSelectArticle={(id) => void openArticle(id)}
            onDeleteArticle={deleteArticle}
            onDeleteBook={deleteBook}
            onOpenImport={openImport}
            onGoReview={goReview}
          />
        )}

        {view === "reading" ? (
          <>
            <ReadingView
              article={article}
              settings={effectiveSettings}
              activeIdx={playback.activeIdx}
              playing={playback.playing}
              translating={translating}
              chunking={chunking}
              peekAll={peekAll}
              searchMatchIdx={searchMatchIdx}
              knownIds={knownIds}
              assessMarks={assessMarks}
              onReveal={(idx) =>
                patchArticle((a) => ({
                  ...a,
                  sentences: a.sentences.map((st) => (st.idx === idx ? { ...st, revealed: true } : st)),
                }))
              }
              onMask={(idx) =>
                patchArticle((a) => ({
                  ...a,
                  sentences: a.sentences.map((st) => (st.idx === idx ? { ...st, revealed: false } : st)),
                }))
              }
              onRevealAll={() =>
                patchArticle((a) => ({
                  ...a,
                  sentences: a.sentences.map((st) => (st.zh ? { ...st, revealed: true } : st)),
                }))
              }
              onMaskAll={() =>
                patchArticle((a) => ({
                  ...a,
                  sentences: a.sentences.map((st) => (st.zh ? { ...st, revealed: false } : st)),
                }))
              }
              onSelection={(idx, text) => void lookup(text, idx)}
              onWordClick={(idx, word) => void lookup(word, idx)}
              onChunkClick={openChunkCard}
              onSpeakSentence={(idx) => playback.jumpTo(idx, { autoplay: true, once: true })}
              onStopSpeaking={() => playback.stop()}
              onRetryParagraph={retryParagraph}
              onEditTranslation={editTranslation}
              onJumpTo={(idx) => playback.jumpTo(idx)}
              onViewportIdx={(idx) => {
                // 滚动到哪 = 读到哪：未播放（且非跟读等待）时光标跟随视口，
                // 顶部墨线、走带进度、当前句高亮与断点记忆随之更新。
                if (!playback.playing && !playback.shadowingWait) playback.setActiveIdx(idx);
              }}
              onOpenImport={openImport}
              onRetryTitle={retryTitle}
              titleCnError={titleCnError ?? undefined}
              showFinishAction={showFinishAction}
              finishLabel={article?.bookId ? "读完本章" : "读完本篇"}
              onFinishRead={confirmFinish}
              book={
                article?.bookId && currentBook
                  ? {
                      title: currentBook.title,
                      chapterIdx: article.chapterIdx ?? bookChapterIndexOf(currentBook, article.id),
                      chapterCount: currentBook.chapters.length,
                    }
                  : null
              }
              onOpenToc={currentBook ? () => setTocBookId(currentBook.id) : undefined}
              onPatchSettings={patchSettings}
              onOpenXray={(idx) => void lookupXray(idx)}
              xrayIdle={
                // 解析面板对当前句的速览 idle 态（与右栏三态渲染同口径：本句无
                // loading/ready/error 记录且无请求在途）——E 键仅此时触发解析。
                xray?.status !== "loading" &&
                !(xray != null && xray.sentenceIdx === playback.activeIdx)
              }
              onPracticeSentence={practiceSentence}
              onPracticeChapter={article ? () => practiceChapter(playback.activeIdx) : undefined}
              hoveredClause={hoveredClause}
              readWatermark={article?.progress.sentenceIdx ?? 0}
              onClozeVerdict={clozeVerdict}
            />
            <DictColumn
              state={dict}
              inVocab={inVocab}
              knownIds={knownIds}
              bookSource={bookSource}
              onSpeak={speakWord}
              onAddVocab={addVocab}
              onAddCollVocab={addCollVocab}
              onLocate={(idx) => playback.jumpTo(idx)}
              onLookup={(text, idx) => void lookup(text, idx)}
              onClose={() => {
                setDict({ status: "closed" });
                setLensMode("xray");
              }}
              lensMode={lensMode}
              onLensMode={setLensMode}
              activeIdx={playback.activeIdx}
              activeSentence={article?.sentences[playback.activeIdx] ?? null}
              chapterVocab={chapterVocab}
              xray={xray}
              xrayBusy={xray?.status === "loading"}
              onOpenXray={(idx) => void lookupXray(idx)}
              onHoverClause={setHoveredClause}
              onPracticeSentence={practiceSentence}
            />
          </>
        ) : view === "speak" ? (
          <SpeakView
            requestTranslate={requestTranslate}
            speakEn={speakEnToView}
            speakWordSlow={speakWordSlowly}
            subscribeSpeakEnded={speechEngine.onEnded}
            stopSpeak={stopSpeakTrack}
            micDeviceId={micDeviceId}
            onToast={showToast}
            onBack={goReading}
            vocabWords={vocabWords}
            onVocabSaved={() => refreshVocab()}
            onGenerateNote={openNoteGeneratorWith}
            onGoReview={goReview}
            bookContext={speakBookContext}
            dueVocabWords={speakDueWords}
            pendingSpeak={pendingSpeak}
            onGradeVocab={gradeSpokenVocab}
            onOpenReaderSettings={() => setDrawerOpen(true)}
          />
        ) : view === "vault" ? (
          <VaultPage
            words={vocabWords}
            due={activeDue}
            stats={stats}
            reviewLog={reviewLog}
            sourceSentence={sourceSentence}
            articleTitle={articleTitle}
            speakSessions={speakSessions}
            mode={vaultMode}
            onModeChange={setVaultMode}
            pos={reviewPos}
            onSetPos={setReviewPos}
            onGrade={focusIds ? gradeAndDrainFocus : gradeVocab}
            onSpokenGrade={focusIds ? gradeSpokenAndDrainFocus : gradeSpokenVocab}
            onRecall={handleRecall}
            onJumpToSentence={jumpToSentence}
            onSpeakWord={speakWord}
            onSpeakSentence={speakRecallSentence}
            micDeviceId={micDeviceId}
            onPracticeVocabSpeak={practiceVocabSpeak}
            onStartFocusReview={startFocusReview}
            onGenerateNote={openNoteGenerator}
            notesPanel={notesPanel}
            focusCount={focusIds?.length ?? 0}
            onExitFocus={exitFocus}
            requestTranslate={requestTranslate}
            onNoteSaved={(meta) => void openSavedNote(meta)}
            unnotedCount={unnotedCount}
            onOpenReader={goReading}
          />
        ) : null}
      </div>

      {view === "reading" && finishCard && article?.id === finishCard.articleId && !article.bookId && (
        <div className="reader-finish-bar" role="status" style={effectiveSettings.zenMode ? { marginBottom: 64 } : undefined}>
          <span className="fb-text">
            本篇读完 🎉 收录 <b>{finishCard.collected}</b> 个词块和生词
            {finishCard.dueCount > 0 && (
              <>
                ，其中 <b>{finishCard.dueCount}</b> 个待复习
              </>
            )}
          </span>
          <div className="fb-actions">
            {finishCard.collected > 0 && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const ids = finishCard.wordIds;
                  setFinishCard(null);
                  openNoteGeneratorWith(ids);
                }}
                title="把这批词预选进复习笔记生成弹窗"
              >
                整理本篇复习笔记
              </button>
            )}
            {finishCard.dueCount > 0 && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  const ids = finishCard.dueIds;
                  setFinishCard(null);
                  startFocusReview(ids);
                }}
                title="只复习本篇已到期的词，不打乱其他词的复习计划"
              >
                复习本篇 {finishCard.dueCount} 词
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setFinishCard(null)}>
              继续阅读
            </button>
          </div>
        </div>
      )}

      {view === "reading" && (
        <PlayBar
          article={article}
          playback={playback}
          settings={effectiveSettings}
          onPatchSettings={patchSettings}
          onOpenViewMenu={(anchor) => setViewMenuAnchor(anchor)}
          onOpenDrawer={() => setDrawerOpen(true)}
          assess={assessEnabled ? assess : null}
        />
      )}

      {effectiveSettings.zenMode && view === "reading" && (
        <div className="reader-zen-controls">
          {assessEnabled && playback.shadowingWait && (
            <AssessStrip assess={assess} passScore={effectiveSettings.shadowingPassScore} />
          )}
          <button className="reader-skip-btn" onClick={() => playback.step(-1)} title="上一句">
            <IconPrev size={15} />
          </button>
          <button
            className="reader-play-btn"
            style={{ width: 36, height: 36 }}
            onClick={playback.toggle}
            title="播放/暂停"
          >
            {playback.playing ? <IconPause size={15} /> : <IconPlay size={15} style={{ marginLeft: 1 }} />}
          </button>
          <button className="reader-skip-btn" onClick={() => playback.step(1)} title="下一句">
            <IconNext size={15} />
          </button>
        </div>
      )}

      {drawerOpen && (
        <SettingsDrawer
          settings={effectiveSettings}
          onPatch={patchSettings}
          onPatchReview={patchReviewMode}
          onReset={resetSettings}
          onClose={() => setDrawerOpen(false)}
          micDeviceId={micDeviceId}
          onMicDevice={(id) => {
            setMicDeviceId(id);
            saveMicDeviceId(id);
          }}
          chunkState={
            article?.chunkState === "done" || article?.chunkState === "failed"
              ? article.chunkState
              : undefined
          }
          onReannotate={reannotateChunks}
        />
      )}

      {importOpen && (
        <ImportDialog
          vocabWords={vocabWords}
          articles={articleList}
          onClose={() => setImportOpen(false)}
          onImport={(text, title, meta) => {
            setImportOpen(false);
            importPaste(text, title, meta);
          }}
          onImportBook={importBook}
          initialTab={importInitialTab}
        />
      )}

      {tocBook && (
        <BookTocModal
          book={tocBook}
          currentChapterId={tocBook.id === currentBook?.id ? (article?.id ?? null) : null}
          vocabCountByChapter={vocabCountByChapter}
          onSelect={(chapterId) => {
            setTocBookId(null);
            void openArticle(chapterId);
          }}
          onClose={() => setTocBookId(null)}
        />
      )}

      {chapterEnd && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChapterEnd(null);
          }}
        >
          <div className="chapter-end-modal" role="dialog" aria-modal="true" aria-label="章末小结">
            <div className="ce-badge" aria-hidden>
              🎉
            </div>
            <h3 className="serif">
              第 {chapterEnd.chapterIdx + 1} 章读完
            </h3>
            <p className="ce-book">
              《{chapterEnd.bookTitle}》 · {chapterEnd.chapterIdx + 1}/{chapterEnd.chapterCount} 章
            </p>
            <div className="ce-stats">
              <span>
                查词 <b>{chapterEnd.lookups}</b> 次
              </span>
              <span>
                本章收录 <b>{chapterEnd.collected}</b> 词
              </span>
              <span>
                本章用时 <b>{chapterEnd.minutes}</b> 分钟
              </span>
            </div>
            {chapterEnd.lastChapter ? (
              <p className="ce-next">全书读完，恭喜！这些生词都已在复习闭环里了。</p>
            ) : (
              <p className="ce-next">下一章：{chapterEnd.nextChapterTitle}</p>
            )}
            {(chapterEnd.collected > 0 || chapterEnd.dueIds.length > 0) && (
              <div className="ce-more">
                {chapterEnd.collected > 0 && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      const ids = chapterEnd.wordIds;
                      setChapterEnd(null);
                      openNoteGeneratorWith(ids);
                    }}
                    title="把本章这批词预选进复习笔记生成弹窗"
                  >
                    整理本章笔记
                  </button>
                )}
                {chapterEnd.dueIds.length > 0 && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      const ids = chapterEnd.dueIds;
                      setChapterEnd(null);
                      startFocusReview(ids);
                    }}
                    title="只复习本章已到期的词，不打乱其他词的复习计划"
                  >
                    复习本章 {chapterEnd.dueIds.length} 词
                  </button>
                )}
              </div>
            )}
            <div className="ce-actions">
              <button className="btn btn-secondary" onClick={() => setChapterEnd(null)}>
                留在本章
              </button>
              {chapterEnd.nextChapterId && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const next = chapterEnd.nextChapterId;
                    setChapterEnd(null);
                    if (next) void openArticle(next);
                  }}
                >
                  开始下一章
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {noteDialogOpen && (
        <VocabNoteDialog
          words={vocabWords}
          requestTranslate={requestTranslate}
          preselect={notePreselect}
          onSaved={(meta) => void openSavedNote(meta)}
          onClose={() => setNoteDialogOpen(false)}
        />
      )}

      {viewMenuAnchor && (
        <ViewMenu
          anchorRect={viewMenuAnchor}
          settings={effectiveSettings}
          onPatchSettings={patchSettings}
          onClose={() => setViewMenuAnchor(null)}
        />
      )}

      {toast && (
        /* role="status" + aria-live="polite"：toast 是「已加入生词本」「已复制」
           这类操作反馈的唯一通道，缺了它读屏用户完全收不到确认信息。
           polite 而非 assertive：不必打断当前朗读。 */
        <div className="toast" role="status" aria-live="polite">
          <span>{toast}</span>
          {toastAction === "redeem" && (
            <button
              type="button"
              className="toast-action"
              onClick={() => void settingsOpenTab("account").catch(() => undefined)}
            >
              兑换更多额度
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function localDayKey(now = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
