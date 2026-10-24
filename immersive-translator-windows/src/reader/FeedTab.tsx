/**
 * 资讯订阅 tab（升级计划 B3）：RSS/Atom 订阅源聚合 → 合并文章列表 →
 * 点文章复用网页链接导入链（readerFetchUrl 抓正文 → 预览 → onImport 入库）。
 *
 * - 抓取：readerFetchFeed 匿名直连用户提供的源站（不走网关、不带 token），
 *   拿回 feed 原始 XML 文本；解析在 lib/feedCatalog.ts（DOMParser），
 *   订阅列表与条目缓存在 localStorage（feedStore.ts），Rust 侧零存储。
 * - 刷新：挂载先渲染缓存，再对 fetchedAt 距今超过 10 分钟的订阅并行自动刷新
 *   （Promise.allSettled，单源失败不阻断其他）；手动按钮无条件全量刷新；
 *   不做 setInterval 常驻轮询（切 tab 即卸载，无后台基建）。
 * - 导入：点文章标题 → readerFetchUrl(条目 link) → UrlTab 同款预览卡 →
 *   「加入书架并开始阅读」调 onImport(text, title, {sourceType:"url",
 *   sourceUrl: 文章 link, level})，之后的 importPaste 链路与 URL tab 共用。
 * - 埋点：feed_view / feed_import 走本地 trackEvent（telemetry_log_event，
 *   纯本地 JSONL 零网络；feed_import 埋「发起导入」意图，与
 *   epub_import_intent 同层级口径）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { countWords } from "../core/articleBuilder";
import { splitParagraphs } from "../core/sentenceSplit";
import {
  coverageForText,
  EXAM_GOALS,
  EXAM_GOAL_LABELS,
  type ExamGoal,
} from "../core/examCoverage";
import type { ArticleSourceType, VocabWord } from "../core/readerTypes";
import { trackEvent } from "../lib/telemetry";
import { readerFetchFeed } from "../lib/tauriBridge";
import { readerFetchUrl, type FetchedArticle } from "../lib/webExtract";
import {
  FEED_DUPLICATE_TEXT,
  FEED_EMPTY_TEXT,
  FEED_PARSE_ERROR_TEXT,
  RECOMMENDED_FEEDS,
  feedInvokeErrorText,
  feedTitleOf,
  findFeedByUrl,
  mergeFeedEntries,
  normalizeFeedUrl,
  parseFeedXml,
} from "../lib/feedCatalog";
import {
  loadFeedCache,
  loadFeeds,
  saveFeedCache,
  saveFeeds,
  type FeedCacheEntry,
  type FeedSubscription,
} from "./feedStore";

/** 缓存新鲜期：挂载自动刷新只针对超过该时长的订阅（10 分钟）。 */
const FRESH_TTL_MS = 10 * 60 * 1000;

/** 合并后的文章条目（mergeFeedEntries 已带 feedId/feedTitle 溯源字段）。 */
type MergedFeedEntry = ReturnType<typeof mergeFeedEntries>[number];

/** 与 ImportDialog.onImport 的 meta 形状一致（本地声明避免与弹窗文件循环引用）。 */
interface FeedImportMeta {
  sourceType?: ArticleSourceType;
  sourceUrl?: string;
  level?: string;
}

export interface FeedTabProps {
  /** 预览确认导入：与 URL tab 同链（ReaderApp importPaste 接力）。 */
  onImport: (text: string, title?: string, meta?: FeedImportMeta) => void;
  /** 「切到粘贴文本」退路（ImportDialog 层 setTab("paste")）。 */
  onSwitchToPaste?: () => void;
}

/** 与 ImportDialog.estimateLevel 同口径（句均词长估级；弹窗内函数未导出，此处复制保持预览卡一致）。 */
function feedEstimateLevel(text: string, sentences: number): string {
  const words = countWords(text);
  if (sentences === 0 || words === 0) return "B1";
  const avgLen = words / sentences;
  if (avgLen <= 13) return "A2";
  if (avgLen <= 17) return "B1";
  if (avgLen <= 22) return "B2";
  return "C1";
}

/** 订阅 id：crypto.randomUUID 优先，环境缺失时降级（不依赖严格 UUID 形状）。 */
function newFeedId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hostLabelOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 相对时间（「3 小时前」口径；未来时间按「刚刚」处理）。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function FeedTab({ onImport, onSwitchToPaste }: FeedTabProps) {
  const [feeds, setFeeds] = useState<FeedSubscription[]>(() => loadFeeds());
  const [cache, setCache] = useState<Record<string, FeedCacheEntry>>(() => loadFeedCache());

  // 订阅管理行
  const [urlDraft, setUrlDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  /** 最近一次发起添加的地址（失败行的「重试」按钮复用）。 */
  const [lastAddUrl, setLastAddUrl] = useState("");

  // 工具行
  const [refreshing, setRefreshing] = useState(false);
  const [failedFeedIds, setFailedFeedIds] = useState<string[]>([]);

  // 文章预览态（点开文章 → readerFetchUrl → UrlTab 同款预览卡）
  const [openEntry, setOpenEntry] = useState<MergedFeedEntry | null>(null);
  const [pvPhase, setPvPhase] = useState<"idle" | "loading" | "preview" | "error">("idle");
  const [pv, setPv] = useState<FetchedArticle | null>(null);
  const [pvError, setPvError] = useState("");

  // 预览卡覆盖数（与 UrlTab 同法：弹窗生命周期短，挂载拉一次生词本）
  const [vocabWords, setVocabWords] = useState<VocabWord[]>([]);
  const [goal, setGoal] = useState<ExamGoal>(() => {
    const saved = localStorage.getItem("intake-exam-goal");
    return saved && (EXAM_GOALS as string[]).includes(saved) ? (saved as ExamGoal) : "kaoyan";
  });

  useEffect(() => {
    // 覆盖数要跟生词本对齐；弹窗生命周期短，直接拉一次即可。
    import("../lib/readerStore")
      .then((m) => m.readerGetVocab())
      .then((f) => setVocabWords(f.words ?? []))
      .catch(() => undefined);
  }, []);

  /**
   * 刷新若干订阅：并行拉取（Promise.allSettled 口径，单源失败不阻断其他），
   * 成功源写缓存，失败源聚进 failedFeedIds（工具行给「N 个订阅刷新失败」+重试）。
   * parseFeedXml 返回 null（源站给了非 feed 内容）按该源失败计。
   */
  const refreshFeeds = useCallback(
    async (targets: FeedSubscription[], currentCache: Record<string, FeedCacheEntry>) => {
      if (targets.length === 0) return;
      setRefreshing(true);
      const nextCache = { ...currentCache };
      const failed: string[] = [];
      const results = await Promise.allSettled(
        targets.map(async (feed) => {
          const xml = await readerFetchFeed(feed.url);
          const entries = parseFeedXml(xml);
          if (entries === null) throw new Error(FEED_PARSE_ERROR_TEXT);
          return { feed, entries };
        }),
      );
      results.forEach((r, i) => {
        const feed = targets[i];
        if (r.status === "fulfilled") {
          nextCache[r.value.feed.id] = { entries: r.value.entries, fetchedAt: Date.now() };
        } else {
          failed.push(feed.id);
        }
      });
      saveFeedCache(nextCache);
      setCache(nextCache);
      setFailedFeedIds(failed);
      setRefreshing(false);
    },
    [],
  );

  // 挂载：曝光埋点 + 节流自动刷新（只刷超过 TTL 的订阅；全部新鲜则零网络）。
  // 依赖数组只含稳定的 refreshFeeds，本 effect 挂载即曝光只跑一次；
  // 首帧闭包里的 feeds/cache 即挂载初值（loadFeeds/loadFeedCache 快照）。
  useEffect(() => {
    trackEvent("feed_view", {});
    const stale = feeds.filter(
      (f) => Date.now() - (cache[f.id]?.fetchedAt ?? 0) > FRESH_TTL_MS,
    );
    if (stale.length > 0) void refreshFeeds(stale, cache);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshFeeds]);

  /** 添加订阅（手添输入与推荐勾选共用）：拉一次 feed 校验可达且是 feed，
   *  通过后入库存并立即写条目缓存（首拉即缓存）。 */
  const addFeed = useCallback(
    async (rawUrl: string) => {
      const url = normalizeFeedUrl(rawUrl);
      if (!url || adding) return;
      setAddError("");
      setLastAddUrl(url);
      if (findFeedByUrl(feeds, url)) {
        setAddError(FEED_DUPLICATE_TEXT);
        return;
      }
      setAdding(true);
      try {
        const xml = await readerFetchFeed(url);
        const entries = parseFeedXml(xml);
        // null=不是订阅（如填错成普通网页，形状门禁在 feedCatalog.isFeedShaped）；
        // [] 是合法 feed 暂无文章，照常入库（列表态走 FEED_EMPTY_TEXT 文案）。
        if (entries === null) {
          setAddError(FEED_PARSE_ERROR_TEXT);
          return;
        }
        let channelTitle = "";
        try {
          channelTitle = feedTitleOf(new DOMParser().parseFromString(xml, "text/xml"));
        } catch {
          channelTitle = "";
        }
        const sub: FeedSubscription = {
          id: newFeedId(),
          url,
          title: channelTitle || hostLabelOf(url),
          addedAt: Date.now(),
        };
        const nextFeeds = [...feeds, sub];
        const nextCache = { ...cache, [sub.id]: { entries, fetchedAt: Date.now() } };
        saveFeeds(nextFeeds);
        saveFeedCache(nextCache);
        setFeeds(nextFeeds);
        setCache(nextCache);
        setUrlDraft("");
      } catch (e) {
        setAddError(feedInvokeErrorText(e));
      } finally {
        setAdding(false);
      }
    },
    [feeds, cache, adding],
  );

  /** 删订阅：连同其条目缓存一起清（chips 上的 ✕）。 */
  const removeFeed = useCallback(
    (id: string) => {
      const nextFeeds = feeds.filter((f) => f.id !== id);
      const nextCache = { ...cache };
      delete nextCache[id];
      saveFeeds(nextFeeds);
      saveFeedCache(nextCache);
      setFeeds(nextFeeds);
      setCache(nextCache);
      setFailedFeedIds((ids) => ids.filter((x) => x !== id));
      if (openEntry?.feedId === id) closePreview();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feeds, cache, openEntry],
  );

  /** 点开文章：readerFetchUrl 抓正文 → 预览卡（UrlTab 同链）。 */
  const openArticle = useCallback(async (entry: MergedFeedEntry) => {
    setOpenEntry(entry);
    setPv(null);
    setPvError("");
    setPvPhase("loading");
    try {
      const res = await readerFetchUrl(entry.link);
      setPv(res);
      setPvPhase("preview");
    } catch (e) {
      setPvError(feedInvokeErrorText(e));
      setPvPhase("error");
    }
  }, []);

  function closePreview() {
    setOpenEntry(null);
    setPv(null);
    setPvError("");
    setPvPhase("idle");
  }

  const pvStats = useMemo(() => {
    if (!pv) return null;
    const words = countWords(pv.text);
    const paras = splitParagraphs(pv.text);
    const sentenceCount = paras.reduce((n, p) => n + p.sentences.length, 0);
    return {
      words,
      paras: paras.length,
      minutes: Math.max(1, Math.round(words / 135)),
      level: feedEstimateLevel(pv.text, Math.max(1, sentenceCount)),
    };
  }, [pv]);

  const pvCov = useMemo(
    () => (pv ? coverageForText(pv.text, goal, vocabWords) : null),
    [pv, goal, vocabWords],
  );

  /** 确认导入：同帧埋 feed_import（发起意图，本地轨），meta 带 sourceUrl=文章 link。 */
  function confirmImport() {
    if (!pv || !pvStats || !openEntry) return;
    trackEvent("feed_import", { host: pv.host });
    onImport(pv.text, pv.title, {
      sourceType: "url",
      sourceUrl: openEntry.link,
      level: pvStats.level,
    });
  }

  const merged = useMemo(
    () =>
      mergeFeedEntries(
        feeds.map((f) => ({
          feedId: f.id,
          feedTitle: f.title,
          fetchedAt: cache[f.id]?.fetchedAt ?? 0,
          entries: cache[f.id]?.entries ?? [],
        })),
      ),
    [feeds, cache],
  );

  const lastRefreshAt = useMemo(() => {
    let latest = 0;
    for (const f of feeds) latest = Math.max(latest, cache[f.id]?.fetchedAt ?? 0);
    return latest > 0 ? latest : null;
  }, [feeds, cache]);

  const hasAnyCache = feeds.some((f) => !!cache[f.id]);

  // ---- 文章预览态（照 UrlTab 预览卡结构，ImportDialog.tsx:622-662 同款） ----
  if (openEntry) {
    if (pvPhase === "loading") {
      return (
        <div className="reader-import-body reader-intake-body">
          <div className="intake-skel">
            <div className="intake-skel-line w40" />
            <div className="intake-skel-line w85" />
            <div className="intake-skel-line w85" />
            <div className="intake-skel-line w60" />
            <div className="intake-skel-phase">正在抓取正文…</div>
          </div>
        </div>
      );
    }
    if (pvPhase === "error") {
      return (
        <div className="reader-import-body reader-intake-body">
          <div className="intake-fail">
            <div className="t">没能读取这篇文章</div>
            <div className="d">{pvError}</div>
            <div className="intake-fail-btns">
              <button className="btn btn-secondary" onClick={closePreview}>
                返回列表
              </button>
              <button className="btn btn-secondary" onClick={() => void openArticle(openEntry)}>
                重试
              </button>
              {onSwitchToPaste && (
                <button className="btn btn-secondary" onClick={onSwitchToPaste}>
                  切到粘贴文本
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    if (pvPhase === "preview" && pv && pvStats && pvCov) {
      return (
        <div className="reader-import-body reader-intake-body">
          <div className="intake-goal-row" style={{ marginTop: 0 }}>
            <span className="intake-goal-label">按考试目标看覆盖：</span>
            {EXAM_GOALS.map((g) => (
              <button
                key={g}
                className={`intake-goal-chip${goal === g ? " on" : ""}`}
                onClick={() => setGoal(g)}
              >
                {EXAM_GOAL_LABELS[g]}
              </button>
            ))}
          </div>
          <div className="intake-preview">
            <div className="intake-pv-src">{pv.host} · 来自订阅「{openEntry.feedTitle}」</div>
            <div className="intake-pv-title serif">{pv.title}</div>
            <div className="intake-pv-meta">
              <span className="intake-lvl">{pvStats.level}</span>
              <span>
                {pvStats.words.toLocaleString()} 词 · {pvStats.paras} 段 · 约 {pvStats.minutes} 分钟
              </span>
            </div>
            {pv.truncated && <div className="epub-pv-note">原文过长，仅导入前 50,000 字符</div>}
            <div className="intake-pv-cov">
              覆盖{EXAM_GOAL_LABELS[goal]}大纲词 <b>{pvCov.total}</b>
              {pvCov.unmastered > 0 && (
                <em>
                  {" "}
                  · {pvCov.unmastered} 个你还没掌握
                </em>
              )}
            </div>
            <p className="intake-pv-snippet serif">{pv.text.slice(0, 180)}…</p>
            <div className="intake-pv-foot intake-fail-btns">
              <button className="btn btn-secondary" onClick={closePreview}>
                返回列表
              </button>
              <button className="btn btn-primary" onClick={confirmImport}>
                加入书架并开始阅读
              </button>
            </div>
          </div>
        </div>
      );
    }
  }

  // ---- 订阅主视图 ----
  return (
    <div className="reader-import-body reader-intake-body feed-body">
      <div className="feed-add-row">
        <input
          className="feed-add-input"
          type="text"
          spellCheck={false}
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addFeed(urlDraft);
          }}
          placeholder="粘贴 RSS/Atom 订阅地址"
          aria-label="订阅地址"
        />
        <button
          className="btn btn-primary"
          disabled={!urlDraft.trim() || adding}
          onClick={() => void addFeed(urlDraft)}
        >
          {adding ? "正在添加…" : "添加"}
        </button>
      </div>
      {addError && (
        <div className="feed-add-error">
          {addError}
          <button className="feed-add-retry" disabled={adding} onClick={() => void addFeed(lastAddUrl)}>
            重试
          </button>
        </div>
      )}

      {feeds.length > 0 && (
        <div className="feed-sub-chips">
          {feeds.map((f) => (
            <span className="feed-sub-chip" key={f.id} title={f.url}>
              {f.title}
              <button
                className="feed-sub-chip-x"
                aria-label={`删除订阅 ${f.title}`}
                title="删除这个订阅"
                onClick={() => removeFeed(f.id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="feed-reco">
        <div className="feed-reco-head">推荐订阅 · 美国政府公开源</div>
        <div className="feed-reco-list">
          {RECOMMENDED_FEEDS.map((r) => {
            const added = !!findFeedByUrl(feeds, r.url);
            return (
              <div className="feed-reco-item" key={r.url}>
                <div className="feed-reco-info">
                  <div className="feed-reco-title">{r.title}</div>
                  <div className="feed-reco-note">{r.note}</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={added || adding}
                  onClick={() => void addFeed(r.url)}
                >
                  {added ? "已添加" : "添加"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="feed-toolbar">
        <button
          className="btn btn-secondary btn-sm"
          disabled={refreshing || feeds.length === 0}
          onClick={() => void refreshFeeds(feeds, cache)}
        >
          {refreshing ? "正在刷新…" : "刷新"}
        </button>
        {lastRefreshAt && <span className="feed-refreshed-at">更新于 {relativeTime(lastRefreshAt)}</span>}
        {failedFeedIds.length > 0 && (
          <span className="feed-refresh-fail">
            {failedFeedIds.length} 个订阅刷新失败
            <button
              className="feed-retry-failed"
              disabled={refreshing}
              onClick={() =>
                void refreshFeeds(
                  feeds.filter((f) => failedFeedIds.includes(f.id)),
                  cache,
                )
              }
            >
              重试
            </button>
          </span>
        )}
      </div>

      {feeds.length === 0 ? (
        <div className="feed-empty">先添加一个 RSS/Atom 订阅地址，或从下方推荐列表勾选几个</div>
      ) : merged.length === 0 ? (
        !hasAnyCache && refreshing ? (
          <div className="intake-skel">
            <div className="intake-skel-line w40" />
            <div className="intake-skel-line w85" />
            <div className="intake-skel-line w85" />
            <div className="intake-skel-line w60" />
            <div className="intake-skel-phase">正在刷新订阅…</div>
          </div>
        ) : (
          <div className="feed-empty">{FEED_EMPTY_TEXT}</div>
        )
      ) : (
        <div className="feed-list">
          {merged.map((e, i) => (
            <div className="feed-item" key={`${e.feedId}-${e.link}-${i}`}>
              <div className="feed-item-src">{e.feedTitle}</div>
              <button className="feed-item-title serif" onClick={() => void openArticle(e)}>
                {e.title}
              </button>
              {e.summary && (
                <div className="feed-item-summary">
                  {e.summary.length > 120 ? `${e.summary.slice(0, 120)}…` : e.summary}
                </div>
              )}
              {e.publishedAt != null && (
                <div className="feed-item-time">{relativeTime(e.publishedAt)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
