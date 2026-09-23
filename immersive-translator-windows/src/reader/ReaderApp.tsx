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
  takePendingReaderImport,
  takePendingOpenReview,
  translateStream,
} from "../lib/tauriBridge";
import { loadSettingsAsync, hasValidSettings } from "../lib/settingsStore";
import {
  noteDelete,
  noteList,
  noteRead,
  noteWriteReplay,
  readerDeleteArticle,
  readerGetArticle,
  readerGetVocab,
  readerListArticles,
  readerRecordRecall,
  readerRecordReview,
  readerSaveArticle,
  readerSaveVocabWord,
} from "../lib/readerStore";
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
import { loadGlobalReaderSettings, loadMicDeviceId, saveGlobalReaderSettings, saveMicDeviceId } from "./readerSettingsStore";
import { trayRefreshBadge } from "../lib/reminder";
import { buildArticleFromText, normalizeWordKey } from "../core/articleBuilder";
import { looksMostlyChinese, resolveTargetLanguage } from "../core/languageDetect";
import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  type Article,
  type ArticleSummary,
  type ReaderSettings,
  type RecallMode,
  type SentenceChunk,
  type SentencePair,
  type VocabCollocation,
  type VocabWord,
} from "../core/readerTypes";
import type { RecallVerdict } from "../core/recallJudge";
import type { ReviewLogFile } from "../core/readerSrs";
import {
  buildParagraphRequestInput,
  buildParagraphTranslateSystemPrompt,
  buildTitleTranslateSystemPrompt,
  parseParagraphResponse,
  parsePartialNumbered,
} from "../core/paragraphTranslate";
import { dueVocab, gradeSrs, recordReview, reviewStats, type ReviewGrade } from "../core/readerSrs";
import {
  buildReaderDictPrompt,
  entryToVocab,
  parseReaderDictResponse,
} from "../core/readerDict";
import {
  buildChunkAnnotateSystemPrompt,
  buildChunkBatchInput,
  chunkBatches,
  chunkToVocab,
  parseChunkResponse,
} from "../core/chunkAnnotate";
import "./reader.css";
import { ReaderTopBar, ViewMenu } from "./ReaderTopBar";
import { ReaderShelf } from "./ReaderShelf";
import { VocabListPanel } from "./VocabListPanel";
import { ReadingView } from "./ReadingView";
import { SettingsDrawer } from "./SettingsDrawer";
import { DictColumn, type DictPanelState } from "./DictColumn";
import { ReviewView } from "./ReviewView";
import { NotesView } from "./NotesView";
import { VocabNoteDialog } from "./VocabNoteDialog";
import { ImportDialog, type ImportMeta } from "./ImportDialog";
import { usePlayback } from "./usePlayback";
import { useShadowAssess } from "./useShadowAssess";
import { mapWordsToText } from "../core/pronunciation";
import {
  createEdgeEngine,
  createSapiEngine,
  createSpeechDispatcher,
  createXfyunEngine,
  type EdgeEngineConfig,
  type XfyunEngineConfig,
} from "./speechEngine";
import { loadXfyunTtsCredentials } from "../lib/iseCredentials";
import type { XfyunTtsCredentials } from "../core/xfyunTts";
import { AssessStrip, PlayBar } from "./PlayBar";
import { SpeakView } from "./SpeakView";
import { IconNext, IconPause, IconPlay, IconPrev } from "../ui/icons";

type ViewRoute = "reading" | "review" | "speak" | "notes";

interface PendingTranslate {
  onDelta?: (text: string) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
  onCancelled: (partial: string) => void;
}

export function ReaderApp() {
  // ---- 数据 ----
  const [globalSettings, setGlobalSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [articleList, setArticleList] = useState<ArticleSummary[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [vocabWords, setVocabWords] = useState<VocabWord[]>([]);
  const [reviewLog, setReviewLog] = useState<ReviewLogFile>({ schemaVersion: 1, days: [] });
  const [view, setView] = useState<ViewRoute>("reading");
  const [toast, setToast] = useState("");
  // ---- 笔记库 ----
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeNote, setActiveNote] = useState<{ meta: NoteMeta; parsed: ReturnType<typeof parseNoteMarkdown> } | null>(null);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [notePreselect, setNotePreselect] = useState<string[] | undefined>(undefined);
  const [replayBusy, setReplayBusy] = useState(false);
  /** 加练队列：非空时复习只排这批词（笔记复盘区「开始复习/只测仍错的词」入口）。 */
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(null);
  const [chunking, setChunking] = useState<{ done: number; total: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [viewMenuAnchor, setViewMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const [dict, setDict] = useState<DictPanelState>({ status: "closed" });
  const [peekAll, setPeekAll] = useState(false);
  const [searchMatchIdx, setSearchMatchIdx] = useState<number | null>(null);
  const [sourceCache, setSourceCache] = useState<Map<string, Article>>(new Map());

  const articleRef = useRef<Article | null>(null);
  const saveTimerRef = useRef<number | null>(null);
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

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const effectiveSettings = useMemo(
    () => mergeReaderSettings(globalSettings, article?.settings),
    [globalSettings, article?.settings],
  );

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

  const handleFinish = useCallback(() => {
    if (!articleRef.current) return;
    const id = articleRef.current.id;
    const lookups = dictCountRef.current.get(id) ?? 0;
    const added = vocabWords.filter((w) => w.source.articleId === id).length;
    showToast(`本篇读完 🎉 共查词 ${lookups} 次 · 生词本新增 ${added} 个`);
  }, [vocabWords, showToast]);

  // ---- 朗读引擎（Edge 在线免费 / 讯飞在线 / 本地 SAPI，凭据缺失自动回落本地） ----
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
  const sapiEngine = useMemo(() => createSapiEngine(), []);
  const xfyunEngine = useMemo(() => createXfyunEngine(() => ttsCfgRef.current), []);
  const edgeEngine = useMemo(() => createEdgeEngine(() => edgeCfgRef.current), []);
  const speechEngine = useMemo(
    () =>
      createSpeechDispatcher(() => {
        if (ttsProviderRef.current === "edge") return edgeEngine;
        if (ttsProviderRef.current === "xfyun" && ttsCfgRef.current.creds) return xfyunEngine;
        return sapiEngine;
      }),
    [sapiEngine, xfyunEngine, edgeEngine],
  );

  const playback = usePlayback({
    target: "reader",
    textsRef,
    settingsRef: playbackSettingsRef,
    engine: speechEngine,
    onFinish: handleFinish,
    onError: (error) => showToast(`朗读失败，已停止：${error instanceof Error ? error.message : String(error)}。请检查网络或语音设置后重新播放。`),
  });

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
        p.onError(e.body || `HTTP ${e.status ?? ""}`);
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

  /** 发一次翻译请求并等待其完成（tag 路由，超时保护）。 */
  const requestTranslate = useCallback(
    (
      input: string,
      systemPrompt: string,
      tag: string,
      onDelta?: (text: string) => void,
    ): Promise<{ status: "done" | "error" | "cancelled"; text: string }> => {
      return new Promise((resolve) => {
        let settled = false;
        let timer = 0;
        const finish = (r: { status: "done" | "error" | "cancelled"; text: string }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          pendingTranslateRef.current.delete(tag);
          resolve(r);
        };
        timer = window.setTimeout(() => finish({ status: "error", text: "翻译请求超时" }), 180_000);
        pendingTranslateRef.current.set(tag, {
          onDelta,
          onDone: (text) => finish({ status: "done", text }),
          onError: (message) => finish({ status: "error", text: message }),
          onCancelled: (partial) => finish({ status: "cancelled", text: partial }),
        });
        void loadSettingsAsync()
          .then((s) => {
            if (!hasValidSettings(s)) {
              finish({ status: "error", text: "未配置翻译接口" });
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
              finish({ status: "error", text: error instanceof Error ? error.message : String(error) });
            });
          })
          .catch((error) => finish({ status: "error", text: String(error) }));
      });
    },
    [],
  );

  // ---- 文章落盘（防抖） ----
  useEffect(() => {
    articleRef.current = article;
  }, [article]);

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
          const cn = res.text.trim().split(/\r?\n/)[0]?.trim();
          patchArticle((a) => ({
            ...a,
            ...(cn
              ? { titleCn: cn, titleCnState: "done" as const }
              : { titleCnState: "failed" as const }),
          }));
        } else if (res.status === "error") {
          patchArticle((a) => ({ ...a, titleCnState: "failed" }));
        }
      }

      let done = 0;
      for (const [, sentences] of pendingGroups) {
        const tag = `rp${++translateSeqRef.current}`;
        const paraInput = buildParagraphRequestInput(sentences.map((x) => x.en));
        const expected = sentences.length;
        const res = await requestTranslate(
          paraInput,
          buildParagraphTranslateSystemPrompt({
            targetLanguage: target,
            customStyle: s.customStyle,
            glossaryText: s.glossaryText,
          }),
          tag,
          (delta) => {
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
          },
        );
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
          markParagraphFailed(sentences);
        }
        done += 1;
        setTranslating(done < pendingGroups.length ? { done, total: pendingGroups.length } : null);
      }
      setTranslating(null);
      // 翻译完成后紧接词块标注（同一请求路由顺序执行，不与翻译并发）。
      void ensureAnnotated();

      function markParagraphFailed(group: SentencePair[]) {
        patchArticle((a) => ({
          ...a,
          sentences: a.sentences.map((st) =>
            group.some((x) => x.idx === st.idx) ? { ...st, zhState: "failed" as const } : st,
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
            ? { ...st, zh: null, zhState: "pending" as const }
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

  // ---- 进度（P0-2 断点续读） ----
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.activeIdx, article?.id]);

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

  const openArticle = useCallback(
    async (id: string) => {
      try {
        const full = await readerGetArticle(id);
        if (!full) return;
        setView("reading");
        setDict({ status: "closed" });
        setSearchMatchIdx(null);
        setArticle(full);
        articleRef.current = full;
        playback.reset(full.progress.sentenceIdx);
        scheduleSave({ ...full, lastReadAt: Date.now() });
        void ensureTranslated(full);
        void loadSourceArticles([full.id]);
      } catch (error) {
        console.error("[reader] open article failed", error);
        showToast("打开文章失败");
      }
    },
    [ensureTranslated, scheduleSave, showToast, playback, loadSourceArticles],
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
      setGlobalSettings(loadGlobalReaderSettings());
      const list = await refreshArticleList();
      await refreshVocab();
      // 笔记列表随启动加载（而不只进笔记库时）：书架/生词本的「未整理进笔记」
      // 角标首屏就要用，懒加载会让它在首次进笔记库前虚高成全部生词数。
      void refreshNotes();
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
      // 托盘「生词本」路径：窗口重建时取走「打开复习页」请求。
      try {
        if (await takePendingOpenReview()) {
          setView("review");
          return;
        }
      } catch (error) {
        console.error("[reader] take pending open review failed", error);
      }
      if (list.length > 0) {
        void openArticle(list[0].id);
      }
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

    // 托盘「生词本」（窗口已存在时）：切到复习页
    let unlistenOpenReview: (() => void) | undefined;
    listen("reader:open-review", () => {
      setFocusIds(null);
      setView("review");
    }).then((u) => {
      if (active) unlistenOpenReview = u;
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

    return () => {
      active = false;
      unlistenArticle?.();
      unlistenImport?.();
      unlistenOpenReview?.();
      unlistenVocab?.();
      unlistenCreds?.();
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
          const list = await refreshArticleList();
          if (articleRef.current?.id === id) {
            setArticle(null);
            articleRef.current = null;
            playback.reset(0);
            if (list.length > 0) void openArticle(list[0].id);
          }
          showToast("文章已删除");
        })
        .catch((error) => {
          console.error("[reader] delete failed", error);
          showToast("删除失败");
        });
    },
    [refreshArticleList, openArticle, playback, showToast],
  );

  // ---- 词典（屏 C） ----
  const lookup = useCallback(
    async (query: string, sentenceIdx: number) => {
      const articleId = articleRef.current?.id ?? "";
      const sourceSentence = articleRef.current?.sentences[sentenceIdx]?.en ?? "";
      dictCountRef.current.set(articleId, (dictCountRef.current.get(articleId) ?? 0) + 1);
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
  const gradeVocab = useCallback(
    (word: VocabWord, g: ReviewGrade) => {
      const graded = { ...word, srs: gradeSrs(word.srs, g) };
      const day = localDayKey();
      void readerSaveVocabWord(graded)
        .then(() => readerRecordReview(day, Date.now()))
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
      void readerRecordRecall(wordId, mode, bucket, Date.now()).catch((error) => {
        console.error("[reader] record recall failed", error);
      });
    },
    [],
  );

  /** 加练判分后把词移出队列（与到期队列「评完即走」同一语义）。 */
  const gradeAndDrainFocus = useCallback(
    (word: VocabWord, g: ReviewGrade) => {
      gradeVocab(word, g);
      setFocusIds((f) => (f ? f.filter((id) => id !== word.id) : f));
    },
    [gradeVocab],
  );

  /** 笔记复盘区「开始复习 / 只测仍错的词」：只排这批词，不等到期。 */
  const startFocusReview = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        showToast("这篇笔记的词这一轮都通过了，没有要补的");
        return;
      }
      setFocusIds(ids);
      setReviewPos(0);
      setView("review");
    },
    [showToast],
  );

  /** 离开复习视图就退出加练（回到普通到期队列）。 */
  const exitFocus = useCallback(() => setFocusIds(null), []);
  const goReading = useCallback(() => {
    setFocusIds(null);
    setView("reading");
  }, []);
  const goReview = useCallback(() => {
    setFocusIds(null);
    setView("review");
  }, []);
  const goNotes = useCallback(() => {
    setFocusIds(null);
    setView("notes");
  }, []);
  const goSpeak = useCallback(() => {
    setFocusIds(null);
    setView("speak");
  }, []);

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
    if (view === "review" && vocabWords.length > 0) {
      void loadSourceArticles(vocabWords.map((w) => w.source.articleId));
    }
  }, [view, vocabWords, loadSourceArticles]);

  // 进入笔记库：刷新列表；没有打开的笔记时自动打开最近一篇。
  useEffect(() => {
    if (view !== "notes") return;
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
    // 每次进入生词本都从队首开始（离开即卸载，results 随之清零）
    if (view === "review") setReviewPos(0);
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
      } else if ((e.key === "h" || e.key === "H") && effectiveSettings.maskTranslation) {
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
  }, [view, playback, effectiveSettings.maskTranslation]);

  // ---- 渲染 ----
  const showChrome = !effectiveSettings.zenMode;
  const articleTitle = useCallback(
    (id: string) => sourceCache.get(id)?.title ?? articleList.find((a) => a.id === id)?.title ?? null,
    [sourceCache, articleList],
  );
  const sourcePreview = useCallback(
    (id: string, sentenceIdx: number) => sourceCache.get(id)?.sentences[sentenceIdx]?.en ?? null,
    [sourceCache],
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

  return (
    <div className="reader-root" data-theme={effectiveSettings.theme} data-font={effectiveSettings.fontPair} style={rootStyle}>
      <ReaderTopBar
        articleName={
          view === "review" ? "生词本" : view === "speak" ? "口语陪练" : view === "notes" ? "笔记库" : (article?.title ?? null)
        }
        onBackToReading={view !== "reading" ? goReading : undefined}
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
      />

      {view === "reading" && effectiveSettings.showProgress && article && (
        <div className="reader-inkline" aria-hidden>
          <i style={{ width: `${Math.round(article.progress.percent)}%` }} />
        </div>
      )}

      <div className="reader-body">
        {showChrome && view === "reading" && (
          <ReaderShelf
            articles={articleList}
            activeId={article?.id ?? null}
            dueNow={dueNow}
            reviewedToday={stats.reviewedToday}
            streak={stats.streak}
            newToNote={unnotedCount}
            onSelect={(id) => void openArticle(id)}
            onOpenReview={goReview}
            onOpenSpeak={goSpeak}
            onOpenNotes={goNotes}
            onDelete={deleteArticle}
            onOpenImport={() => setImportOpen(true)}
          />
        )}
        {view === "review" && (
          <VocabListPanel
            words={vocabWords}
            due={activeDue}
            pos={reviewPos}
            reviewedToday={stats.reviewedToday}
            streak={stats.streak}
            focusCount={focusIds?.length ?? 0}
            onExitFocus={exitFocus}
            newWords={unnotedCount}
            onJumpToCard={setReviewPos}
            onOpenReader={goReading}
            onOpenSpeak={goSpeak}
            onOpenNotes={goNotes}
            requestTranslate={requestTranslate}
            onNoteSaved={(meta) => void openSavedNote(meta)}
          />
        )}
        {view === "notes" && (
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
              onOpenImport={() => setImportOpen(true)}
              onRetryTitle={retryTitle}
            />
            <DictColumn
              state={dict}
              inVocab={inVocab}
              knownIds={knownIds}
              onSpeak={speakWord}
              onAddVocab={addVocab}
              onAddCollVocab={addCollVocab}
              onLocate={(idx) => playback.jumpTo(idx)}
              onLookup={(text, idx) => void lookup(text, idx)}
              onClose={() => setDict({ status: "closed" })}
            />
          </>
        ) : view === "speak" ? (
          <SpeakView
            requestTranslate={requestTranslate}
            speakEn={speakEnToView}
            subscribeSpeakEnded={speechEngine.onEnded}
            stopSpeak={stopSpeakTrack}
            micDeviceId={micDeviceId}
            onToast={showToast}
            onBack={goReading}
          />
        ) : view === "notes" ? null : (
          <ReviewView
            words={vocabWords}
            due={activeDue}
            pos={reviewPos}
            onSetPos={setReviewPos}
            stats={stats}
            reviewMode={effectiveSettings.reviewMode}
            onReviewModeChange={(m) => patchReviewMode({ reviewMode: m })}
            onGrade={focusIds ? gradeAndDrainFocus : gradeVocab}
            onRecall={handleRecall}
            onJumpToSentence={jumpToSentence}
            onSpeakWord={speakWord}
            onSpeakSentence={speakRecallSentence}
            sourcePreview={sourcePreview}
            sourceSentence={sourceSentence}
            articleTitle={articleTitle}
            onGenerateNote={openNoteGenerator}
            onOpenNotes={goNotes}
            onOpenReader={goReading}
          />
        )}
      </div>

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
        />
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function localDayKey(now = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
