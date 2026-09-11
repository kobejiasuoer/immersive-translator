/**
 * 沉浸阅读室 · 组合根（reader 窗口）。
 *
 * 职责：加载数据（文章/生词/设置）、驱动翻译管线（段级流式 + 失败重试 +
 * 手改译文）、接线播放引擎、词典栏、遮罩、复习流与全部入口状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  onTranslationCancelled,
  onTranslationDelta,
  onTranslationDone,
  onTranslationError,
  takePendingReaderImport,
  translateStream,
  ttsSpeakAdvanced,
} from "../lib/tauriBridge";
import { loadSettingsAsync, hasValidSettings } from "../lib/settingsStore";
import {
  readerDeleteArticle,
  readerGetArticle,
  readerGetVocab,
  readerListArticles,
  readerRecordReview,
  readerSaveArticle,
  readerSaveVocabWord,
} from "../lib/readerStore";
import { loadGlobalReaderSettings, saveGlobalReaderSettings } from "./readerSettingsStore";
import { buildArticleFromText, normalizeWordKey } from "../core/articleBuilder";
import { looksMostlyChinese, resolveTargetLanguage } from "../core/languageDetect";
import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  type Article,
  type ArticleSummary,
  type ReaderSettings,
  type SentenceChunk,
  type SentencePair,
  type VocabWord,
} from "../core/readerTypes";
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
import { ReadingView } from "./ReadingView";
import { PlayBar } from "./PlayBar";
import { SettingsDrawer } from "./SettingsDrawer";
import { DictColumn, type DictPanelState } from "./DictColumn";
import { ReviewView } from "./ReviewView";
import { ImportDialog } from "./ImportDialog";
import { usePlayback } from "./usePlayback";
import { IconNext, IconPause, IconPlay, IconPrev } from "../ui/icons";

type ViewRoute = "reading" | "review";

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

  const playback = usePlayback({
    target: "reader",
    textsRef,
    settingsRef: playbackSettingsRef,
    onFinish: handleFinish,
  });

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
        if (res.status === "done" || res.status === "cancelled") {
          // cancelled 时已收到的部分也按完整解析尝试（多数句子已完整）
          const parsed =
            res.status === "done"
              ? parseParagraphResponse(res.text, expected)
              : parseParagraphResponse(res.text, expected);
          if (parsed) {
            patchArticle((a) => ({
              ...a,
              sentences: a.sentences.map((st) => {
                const i = sentences.findIndex((x) => x.idx === st.idx);
                if (i < 0) return st;
                return { ...st, zh: parsed[i], zhState: "done" as const };
              }),
            }));
          } else if (res.status === "done") {
            markParagraphFailed(sentences);
          }
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

    return () => {
      active = false;
      unlistenArticle?.();
      unlistenImport?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    (text: string, title?: string) => {
      const built = buildArticleFromText(text, {
        sourceType: "paste",
        ...(title ? { title } : {}),
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

  const speakWord = useCallback((text: string) => {
    void ttsSpeakAdvanced(text, looksMostlyChinese(text), {
      track: "word",
      target: "reader",
      rate: 1,
    }).catch((error) => console.error("[reader] word tts failed", error));
  }, []);

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

  useEffect(() => {
    if (view === "review" && vocabWords.length > 0) {
      void loadSourceArticles(vocabWords.map((w) => w.source.articleId));
    }
  }, [view, vocabWords, loadSourceArticles]);

  const stats = useMemo(() => reviewStats(vocabWords, reviewLog), [vocabWords, reviewLog]);
  const dueNow = useMemo(() => dueVocab(vocabWords).length, [vocabWords]);

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

  // ---- 键盘（§9-11：空格仅阅读器内生效；J/K/L 备选；方向键不劫持） ----
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
      if (view === "review") return;
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

  const rootStyle = {
    "--read-en-size-cur": `${effectiveSettings.fontSize}px`,
    "--read-en-lh-cur": `${Math.round((effectiveSettings.fontSize / 19) * 32 * effectiveSettings.lineHeight)}px`,
    "--read-cn-size-cur": `${Math.round((effectiveSettings.fontSize / 19) * 15)}px`,
    "--read-cn-lh-cur": `${Math.round((effectiveSettings.fontSize / 19) * 26 * effectiveSettings.lineHeight)}px`,
  } as CSSProperties;

  return (
    <div className="reader-root" data-theme={effectiveSettings.theme} data-font={effectiveSettings.fontPair} style={rootStyle}>
      <ReaderTopBar
        articleName={article?.title ?? null}
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

      <div className="reader-body">
        {showChrome && (
          <ReaderShelf
            articles={articleList}
            activeId={article?.id ?? null}
            dueNow={dueNow}
            reviewedToday={stats.reviewedToday}
            streak={stats.streak}
            onSelect={(id) => void openArticle(id)}
            onOpenReview={() => setView("review")}
            onDelete={deleteArticle}
            onOpenImport={() => setImportOpen(true)}
          />
        )}

        {view === "reading" ? (
          <>
            <ReadingView
              article={article}
              settings={effectiveSettings}
              activeIdx={playback.activeIdx}
              translating={translating}
              chunking={chunking}
              peekAll={peekAll}
              searchMatchIdx={searchMatchIdx}
              knownIds={knownIds}
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
              onSpeakSentence={(idx) => playback.jumpTo(idx, { autoplay: true })}
              onRetryParagraph={retryParagraph}
              onEditTranslation={editTranslation}
              onJumpTo={(idx) => playback.jumpTo(idx)}
              onOpenImport={() => setImportOpen(true)}
              onRetryTitle={retryTitle}
            />
            <DictColumn
              state={dict}
              inVocab={inVocab}
              onSpeak={speakWord}
              onAddVocab={addVocab}
              onLocate={(idx) => playback.jumpTo(idx)}
              onLookup={(text, idx) => void lookup(text, idx)}
              onClose={() => setDict({ status: "closed" })}
            />
          </>
        ) : (
          <ReviewView
            words={vocabWords}
            stats={stats}
            onGrade={gradeVocab}
            onJumpToSentence={jumpToSentence}
            onSpeakWord={speakWord}
            sourcePreview={sourcePreview}
            articleTitle={articleTitle}
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
        />
      )}

      {effectiveSettings.zenMode && view === "reading" && (
        <div className="reader-zen-controls">
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
          onReset={resetSettings}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(text, title) => {
            setImportOpen(false);
            importPaste(text, title);
          }}
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
