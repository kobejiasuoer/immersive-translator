/**
 * 整页书架（应用首页）：对齐原型 reader-room-redesign-2026-10-26 的
 * 「书架 · 书」与「书架 · 短文」两视图（书架页重构 2026-10-26）。
 *
 * - 页头：书架标题 + 带「书 · N / 短文 · M」数量的分段切换 + 导入主按钮。
 * - 书 tab：最近阅读的书为主卡（封面 dataURL 优先、缺省主题色渐变占位、
 *   元信息一行化、进度 + 第 x/y 章、继续读/目录操作行），其余书紧凑列表跟随
 *   （books 全量渲染，删除入口保留）；右侧统计卡（今日阅读圆环 / 今日复习
 *   到期数与进度条 / 连续天数为 0 时给鼓励语）；下方发现三列
 *   （discover / feed / lib 三个导入入口）。
 * - 短文 tab：搜索（标题，含中文译名）+ 筛选（全部/未读完/已读完）+
 *   排序（最近阅读，唯一排序口径）工具行；按状态分组（继续阅读在前、
 *   已读完在后）；同 sourceUrl 的重复内容合并展示、可撤销；
 *   统一行结构（进度环 / 英文标题 + 中文行 / 一行元信息 / more 菜单收删除）。
 *   失败项分组为 blueprint defer 项（导入失败态不落库，无数据源），不渲染。
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  IconBookOpen,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconList,
  IconPlay,
  IconPlus,
  IconSearch,
  IconTrash,
} from "../ui/icons";
import type { ArticleSummary, BookMeta } from "../core/readerTypes";
import { bookChapterIndexOf, bookOverallPercent } from "../core/readerTypes";
import { EXAM_GOAL_LABELS, type CoverageStats, type ExamGoal } from "../core/examCoverage";

/** 导入弹窗直达 tab（propContracts 外壳契约：onOpenImport 升级为 (tab?) => void）。 */
export type ShelfImportTab = "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed";

interface Props {
  books: BookMeta[];
  articles: ArticleSummary[];
  /** 短文覆盖（按考试目标懒算，id → 覆盖统计）。 */
  articleCoverage: Record<string, CoverageStats>;
  examGoal: ExamGoal;
  readMinutesToday: number;
  readGoalMin: number;
  reviewedToday: number;
  dueNow: number;
  streak: number;
  onContinueBook: (book: BookMeta) => void;
  onOpenBookToc: (book: BookMeta) => void;
  onSelectArticle: (id: string) => void;
  onDeleteArticle: (id: string) => void;
  onDeleteBook: (id: string) => void;
  onOpenImport: (tab?: ShelfImportTab) => void;
  onGoReview: () => void;
}

/** 原型 flame 图标（连续天数角标）。 */
function IconFlame({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5c.4 2.2 2.4 3 2.9 5.1.4 1.8-.6 3.6-2.4 4.2.5-.9.3-1.9-.4-2.6-.3.9-1 1.2-1.6 2-.7 1-.4 2.3.5 3.1C4.3 13 2.5 11.3 2.5 9c0-2.8 2.6-3.6 3.1-5.8.9.7 1.4 1.5 1.5 2.6C7.9 4.7 8 3 8 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 订阅源图标（原型 rss symbol，Feather 风格内联；icons.tsx 暂缺）。 */
function IconRss({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8" />
      <circle cx="6.2" cy="17.8" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 竖排三点 more 图标（原型 dots symbol；Feather 风格圆点用圆头线帽画）。 */
function IconDots({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth={2.6} strokeLinecap="round">
        <path d="M6 12h.01" />
        <path d="M12 12h.01" />
        <path d="M18 12h.01" />
      </g>
    </svg>
  );
}

/** 阅读时长格式：分钟 < 60 → 「N 分钟」，否则「X.Y 小时」（去尾 .0）。 */
function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = minutes / 60;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1).replace(/\.0$/, "")} 小时`;
}

/** 词数 → 分钟（与旧版一致按 135 wpm 估）。 */
function estimateMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 135));
}

/**
 * 短文中文行的来源落款：与译名合并展示（原型 L438「译名 · 来源」口径）。
 * 书章给「来自《书名》第 N 章」（书已不在书架时回落日期落款），网页给域名，
 * 本地/粘贴给类型 + 日期。注意：现行存储书章不入短文列表（reader_list_articles
 * 永不返回书章），epub 分支兜底旧数据/边界数据。
 */
function sourceLabel(a: ArticleSummary, books: BookMeta[]): string {
  if (a.sourceType === "epub") {
    const book = books.find((b) => b.id === a.bookId);
    if (book) {
      return a.chapterIdx != null
        ? `来自《${book.title}》第 ${a.chapterIdx + 1} 章`
        : `来自《${book.title}》`;
    }
  }
  if (a.sourceUrl) {
    try {
      const host = new URL(a.sourceUrl).hostname.replace(/^www\./, "");
      if (host) return `网页 · ${host}`;
    } catch {
      /* 非法 URL 走类型落款 */
    }
  }
  const d = new Date(a.createdAt);
  const date = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  switch (a.sourceType) {
    case "url":
      return `网页 · ${date}`;
    case "paste":
      return `粘贴文本 · ${date}`;
    case "pdf":
      return `本地 PDF · ${date}`;
    case "docx":
      return `本地 Word · ${date}`;
    default:
      return `导入于 ${date}`;
  }
}

/** conic 进度环的 --v 百分比（0–100 取整），CSS 里 calc(var(--v) * 1%) 消费。 */
function ringVar(percent: number): CSSProperties {
  return { "--v": String(Math.max(0, Math.min(100, Math.round(percent)))) } as CSSProperties;
}

/** 一本书在书架上的派生量。 */
function bookFacts(b: BookMeta) {
  const idx = bookChapterIndexOf(b, b.progress.chapterId);
  const percent = Math.round(bookOverallPercent(b));
  const started = b.progress.percent > 0 || idx > 0;
  const words = b.chapters.reduce((n, c) => n + c.wordCount, 0);
  return { idx, percent, started, words, minutes: estimateMinutes(words) };
}

/** 删除书二次确认（与旧版同文案；返回 true=确认删除）。 */
function confirmDeleteBook(b: BookMeta): boolean {
  return window.confirm(
    `删除《${b.title}》？将删除全部 ${b.chapters.length} 章内容与这本书的阅读进度，不可恢复；生词本不受影响。`,
  );
}

export function ShelfPage({
  books,
  articles,
  articleCoverage,
  examGoal,
  readMinutesToday,
  readGoalMin,
  reviewedToday,
  dueNow,
  streak,
  onContinueBook,
  onOpenBookToc,
  onSelectArticle,
  onDeleteArticle,
  onDeleteBook,
  onOpenImport,
  onGoReview,
}: Props) {
  const [tab, setTab] = useState<"books" | "articles">("books");

  // ---- 短文 tab 本地工具态（纯 UI，不落盘） ----
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "reading" | "done">("all");
  /** 已撤销合并的 sourceUrl（撤销后该 URL 的重复条目全部展开）。 */
  const [unmergedUrls, setUnmergedUrls] = useState<Set<string>>(new Set());
  /** more 菜单打开的行 id（同时至多一个）。 */
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);

  // more 菜单外点 / Esc 关闭（document 级，仅菜单打开时挂监听）。
  useEffect(() => {
    if (moreMenuId === null) return;
    function onDown(e: MouseEvent) {
      const el = e.target as Element | null;
      if (el && el.closest(".shelf-item-more-wrap")) return;
      setMoreMenuId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreMenuId(null);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreMenuId]);

  // ---- 书 tab：最近阅读的书为主卡，其余紧凑列表（全量渲染） ----
  const sortedBooks = useMemo(
    () => [...books].sort((a, b) => b.lastReadAt - a.lastReadAt || b.createdAt - a.createdAt),
    [books],
  );
  const featured = sortedBooks[0] ?? null;
  const restBooks = sortedBooks.slice(1);

  // ---- 统计卡派生量（与旧版同口径） ----
  const goalOn = readGoalMin > 0;
  const readMin = Math.max(0, Math.round(readMinutesToday));
  const ringRatio = goalOn ? Math.min(1, readMin / readGoalMin) : 0;
  const todayTotal = reviewedToday + dueNow;
  const reviewPct = Math.round((reviewedToday / Math.max(1, todayTotal)) * 100);
  const streakGoalMin = goalOn ? readGoalMin : 10;

  // ---- 短文管线：搜索 → 筛选 → 排序 → sourceUrl 合并 → 状态分组 ----
  const shorts = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = articles;
    if (q) {
      list = list.filter(
        (a) => a.title.toLowerCase().includes(q) || (a.titleCn ?? "").toLowerCase().includes(q),
      );
    }
    if (filter === "reading") list = list.filter((a) => a.progress.percent < 100);
    else if (filter === "done") list = list.filter((a) => a.progress.percent >= 100);
    const sorted = [...list].sort((a, b) => b.lastReadAt - a.lastReadAt);

    // 同 sourceUrl 视为重复：保留最近读的一条，其余收进合并提示（可撤销）。
    const byUrl = new Map<string, ArticleSummary[]>();
    for (const a of sorted) {
      if (!a.sourceUrl) continue;
      const arr = byUrl.get(a.sourceUrl);
      if (arr) arr.push(a);
      else byUrl.set(a.sourceUrl, [a]);
    }
    const hidden = new Set<string>();
    const repByUrl = new Map<string, ArticleSummary>();
    const hiddenCountByUrl = new Map<string, number>();
    for (const [url, arr] of byUrl) {
      if (arr.length < 2 || unmergedUrls.has(url)) continue;
      const rep = arr.reduce((m, a) => (a.lastReadAt > m.lastReadAt ? a : m), arr[0]);
      for (const a of arr) if (a.id !== rep.id) hidden.add(a.id);
      repByUrl.set(url, rep);
      hiddenCountByUrl.set(url, arr.length - 1);
    }

    const reading: ArticleSummary[] = [];
    const done: ArticleSummary[] = [];
    for (const a of sorted) {
      if (hidden.has(a.id)) continue;
      (a.progress.percent >= 100 ? done : reading).push(a);
    }
    // 合并提示归到代表条目所在的分组（撤销按分组一次展开）。
    let mergedReadingCount = 0;
    let mergedDoneCount = 0;
    const mergedReadingUrls: string[] = [];
    const mergedDoneUrls: string[] = [];
    for (const [url, rep] of repByUrl) {
      const n = hiddenCountByUrl.get(url) ?? 0;
      if (rep.progress.percent >= 100) {
        mergedDoneCount += n;
        mergedDoneUrls.push(url);
      } else {
        mergedReadingCount += n;
        mergedReadingUrls.push(url);
      }
    }
    return {
      reading,
      done,
      mergedReadingCount,
      mergedDoneCount,
      mergedReadingUrls,
      mergedDoneUrls,
      searching: q.length > 0,
    };
  }, [articles, query, filter, unmergedUrls]);

  const unmerge = (urls: string[]) => {
    setUnmergedUrls((prev) => {
      const next = new Set(prev);
      for (const u of urls) next.add(u);
      return next;
    });
  };

  const goalLabel = EXAM_GOAL_LABELS[examGoal];

  /** 短文统一行（进度环 / 标题 + 中文行 / 一行元信息 / more 菜单）。 */
  const renderShortRow = (a: ArticleSummary) => {
    const done = a.progress.percent >= 100;
    const minutes = estimateMinutes(a.wordCount);
    const cov = articleCoverage[a.id];
    const menuOpen = moreMenuId === a.id;
    return (
      <div
        key={a.id}
        className={`shelf-item${done ? " done" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => onSelectArticle(a.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSelectArticle(a.id);
        }}
        title="打开这篇短文"
      >
        <div className={`shelf-probring${done ? " done" : ""}`} style={ringVar(a.progress.percent)} aria-hidden>
          {done && <IconCheck size={13} />}
        </div>
        <div className="shelf-item-titles">
          <div className="t serif" title={a.title}>
            {a.title}
          </div>
          {/* 原型「译名 · 来源」合并（L438）：有译名也不丢来源落款 */}
          <div className="z">{a.titleCn ? `${a.titleCn} · ${sourceLabel(a, books)}` : sourceLabel(a, books)}</div>
        </div>
        <div className="shelf-item-info">
          {a.level && <span className="shelf-lv">{a.level}</span>}
          <span>约 {fmtDuration(minutes)}</span>
          {cov && (
            <span title={`${goalLabel}大纲词命中 ${cov.total} 个`}>
              {goalLabel}词 {cov.total.toLocaleString()}
            </span>
          )}
        </div>
        <div className="shelf-item-more-wrap">
          <button
            className="shelf-item-more"
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMoreMenuId(menuOpen ? null : a.id);
            }}
          >
            <IconDots size={16} />
          </button>
          {menuOpen && (
            <div className="shelf-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                role="menuitem"
                onClick={() => {
                  setMoreMenuId(null);
                  if (window.confirm(`删除《${a.title}》？这篇短文将从书架移除；生词本不受影响。`))
                    onDeleteArticle(a.id);
                }}
              >
                <IconTrash size={13} />
                删除这篇短文
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="shelf-page">
      <div className="shelf-wrap">
        {/* ---- 页头：标题 + 带数量分段 + 导入主按钮 ---- */}
        <div className="shelf-pagehead">
          <h2>书架</h2>
          <div className="shelf-segment" role="tablist" aria-label="书架内容切换">
            <button
              role="tab"
              aria-selected={tab === "books"}
              className={tab === "books" ? "on" : ""}
              onClick={() => setTab("books")}
            >
              书 · {books.length}
            </button>
            <button
              role="tab"
              aria-selected={tab === "articles"}
              className={tab === "articles" ? "on" : ""}
              onClick={() => setTab("articles")}
            >
              短文 · {articles.length}
            </button>
          </div>
          <button
            className="btn btn-primary shelf-import-btn"
            onClick={() => onOpenImport()}
            title="导入阅读内容（内置文库 / 文件 / 链接 / 粘贴）"
          >
            <IconPlus size={13} />
            导入
          </button>
        </div>

        {tab === "books" ? (
          <>
            <div className="shelf-topgrid">
              <div className="shelf-bookcol">
                {featured ? (
                  (() => {
                    const b = featured;
                    const { idx, percent, started, words, minutes } = bookFacts(b);
                    const sentence = b.progress.sentenceIdx;
                    const radarCount = b.radar[examGoal];
                    return (
                      <div className="shelf-bookcard" key={b.id}>
                        <div className="shelf-cover" aria-hidden>
                          {b.cover ? (
                            <img src={b.cover} alt="" />
                          ) : (
                            <>
                              <small>EPUB</small>
                              <b className="serif">{b.title}</b>
                              <small>{b.author ?? ""}</small>
                            </>
                          )}
                          {percent >= 100 && <span className="shelf-cover-done">已读完 ✓</span>}
                        </div>
                        <div className="shelf-bookmain">
                          <h3 className="serif" title={b.title}>
                            {b.title}
                          </h3>
                          <div className="shelf-bookby">{b.author ?? "未知作者"}</div>
                          <div className="shelf-facts">
                            <span>
                              {b.chapters.length} 章 · {words.toLocaleString()} 词 · 约 {fmtDuration(minutes)}
                            </span>
                            {radarCount > 0 && (
                              <span className="tag" title="选书雷达：该考试目标的大纲词覆盖数">
                                {goalLabel} · 大纲词 {radarCount.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div className="shelf-progress">
                            <b>{percent}%</b>
                            <div className="shelf-bar" aria-hidden>
                              <i style={{ width: `${percent}%` }} />
                            </div>
                            <span className="shelf-muted">
                              {percent >= 100
                                ? "已读完"
                                : started
                                  ? `第 ${idx + 1} / ${b.chapters.length} 章`
                                  : "尚未开始"}
                            </span>
                          </div>
                          <div className="shelf-bookacts">
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => onContinueBook(b)}
                              title={
                                started
                                  ? `回到第 ${idx + 1} 章第 ${sentence + 1} 句`
                                  : "从第 1 章开始读这本书"
                              }
                            >
                              <IconPlay size={11} />
                              {started ? `继续读 · 第 ${idx + 1} 章第 ${sentence + 1} 句` : "开始阅读"}
                            </button>
                            <button className="btn btn-sm" onClick={() => onOpenBookToc(b)}>
                              目录
                            </button>
                            <button
                              className="shelf-iconbtn shelf-book-del"
                              title="移出书架（生词本不受影响）"
                              onClick={() => {
                                if (confirmDeleteBook(b)) onDeleteBook(b.id);
                              }}
                            >
                              <IconTrash size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <button className="shelf-emptycard" onClick={() => onOpenImport("epub")}>
                    <IconBookOpen size={20} />
                    <span className="t">还没有书</span>
                    <span className="sub">
                      导入整本 EPUB：自动分章 · 断点续读 · 生词进复习闭环；也可以先读内置文库的短篇
                    </span>
                  </button>
                )}

                {restBooks.length > 0 && (
                  <div className="shelf-booksmini">
                    {restBooks.map((b) => {
                      const { idx, percent, started } = bookFacts(b);
                      return (
                        <div
                          key={b.id}
                          className="shelf-minirow"
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenBookToc(b)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onOpenBookToc(b);
                          }}
                          title="查看目录"
                        >
                          <span className="shelf-minicover" aria-hidden>
                            {b.cover ? (
                              <img src={b.cover} alt="" />
                            ) : (
                              <span className="shelf-minicover-mark">{b.title.charAt(0).toUpperCase()}</span>
                            )}
                          </span>
                          <span className="shelf-minititle serif" title={b.title}>
                            {b.title}
                          </span>
                          <span className="shelf-minimeta">
                            {b.chapters.length} 章 · {percent}%
                            {percent > 0 && percent < 100 ? ` · 第 ${idx + 1} 章` : ""}
                            {percent >= 100 ? " · 已读完" : ""}
                          </span>
                          <span className="shelf-miniacts">
                            <button
                              className="shelf-iconbtn"
                              title={started ? `继续读 · 第 ${idx + 1} 章第 ${b.progress.sentenceIdx + 1} 句` : "开始阅读"}
                              onClick={(e) => {
                                e.stopPropagation();
                                onContinueBook(b);
                              }}
                            >
                              <IconPlay size={12} />
                            </button>
                            <button
                              className="shelf-iconbtn"
                              title="查看目录"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenBookToc(b);
                              }}
                            >
                              <IconList size={13} />
                            </button>
                            <button
                              className="shelf-iconbtn del"
                              title="移出书架（生词本不受影响）"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirmDeleteBook(b)) onDeleteBook(b.id);
                              }}
                            >
                              <IconTrash size={12} />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ---- 统计卡：今日阅读 / 今日复习 / 连续天数 ---- */}
              <div className="shelf-statcard">
                <div className="shelf-statblk">
                  <h4>今日阅读</h4>
                  <div className="shelf-statrow">
                    <div className="shelf-ring" style={ringVar(ringRatio * 100)} aria-hidden>
                      <span>{goalOn ? `${readMin}/${readGoalMin}` : `${readMin}′`}</span>
                    </div>
                    <div className="shelf-stattext">
                      <b>
                        {goalOn
                          ? readMin >= readGoalMin
                            ? "目标已达成"
                            : `还差 ${readGoalMin - readMin} 分钟`
                          : `已读 ${readMin} 分钟`}
                      </b>
                      <span className="shelf-muted">
                        {goalOn
                          ? readMin >= readGoalMin
                            ? "明天继续保持"
                            : "达成今日目标"
                          : "可在阅读设置里定每日阅读目标"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="shelf-statblk">
                  <h4>今日复习</h4>
                  <b>{dueNow > 0 ? `${dueNow} 张到期` : todayTotal > 0 ? "今日到期已清空" : "今天没有到期生词"}</b>
                  <div className="shelf-statbar" aria-hidden>
                    <i style={{ width: `${reviewPct}%` }} />
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={onGoReview}
                    /* 无到期词时点了只会进空队列，体验上像「点了没反应」。
                       禁用并把原因写进 title，让用户知道该等明天或先去加生词。 */
                    disabled={dueNow === 0}
                    title={
                      dueNow > 0
                        ? `去复习 ${dueNow} 个到期生词`
                        : todayTotal > 0
                          ? "今天的到期已清空，明天再来"
                          : "暂无到期生词。先在阅读里查词收藏，明天会出现在这里"
                    }
                  >
                    开始复习
                  </button>
                </div>
                <div className="shelf-statfoot">
                  {streak > 0 ? (
                    <span className="shelf-streak">
                      <IconFlame size={12} />
                      连续阅读 <b>{streak}</b> 天
                    </span>
                  ) : (
                    <span className="shelf-muted">读满 {streakGoalMin} 分钟，开启你的连续阅读</span>
                  )}
                </div>
              </div>
            </div>

            {/* ---- 发现入口三列（导入弹窗直达三个 tab） ---- */}
            <div className="shelf-sectitle">发现更多可读内容</div>
            <div className="shelf-disc">
              <button className="shelf-disc-card" onClick={() => onOpenImport("discover")}>
                <span className="shelf-disc-ic" aria-hidden>
                  <IconBookOpen size={16} />
                </span>
                <b>精选经典</b>
                <span>按难度和考纲词表挑选公版名著与短篇</span>
              </button>
              <button className="shelf-disc-card" onClick={() => onOpenImport("feed")}>
                <span className="shelf-disc-ic" aria-hidden>
                  <IconRss size={16} />
                </span>
                <b>英文资讯订阅</b>
                <span>订阅常用新闻源，每天自动收到可读短文</span>
              </button>
              <button className="shelf-disc-card" onClick={() => onOpenImport("lib")}>
                <span className="shelf-disc-ic" aria-hidden>
                  <IconPlus size={16} />
                </span>
                <b>导入自己的内容</b>
                <span>网址、文件或粘贴文本，自动拆句并翻译</span>
              </button>
            </div>
          </>
        ) : articles.length === 0 ? (
          <button className="shelf-emptycard" onClick={() => onOpenImport()}>
            <IconBookOpen size={20} />
            <span className="t">添加一篇短文</span>
            <span className="sub">内置文库 · 网页链接 · Word / PDF · 粘贴文本</span>
          </button>
        ) : (
          <>
            {/* ---- 工具行：搜索 / 筛选 / 排序 ---- */}
            <div className="shelf-tools">
              <div className="shelf-search">
                <IconSearch size={13} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索标题"
                  aria-label="搜索短文标题"
                />
                {query && (
                  <button className="shelf-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}>
                    <IconClose size={12} />
                  </button>
                )}
              </div>
              <span className="shelf-filters" role="group" aria-label="按状态筛选">
                <button
                  className={`chip${filter === "all" ? " on" : ""}`}
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  全部
                </button>
                <button
                  className={`chip${filter === "reading" ? " on" : ""}`}
                  aria-pressed={filter === "reading"}
                  onClick={() => setFilter("reading")}
                >
                  未读完
                </button>
                <button
                  className={`chip${filter === "done" ? " on" : ""}`}
                  aria-pressed={filter === "done"}
                  onClick={() => setFilter("done")}
                >
                  已读完
                </button>
              </span>
              <span className="shelf-sort" title="当前排序：最近阅读">
                排序：最近阅读
                <IconChevronDown size={13} />
              </span>
            </div>

            {shorts.reading.length === 0 && shorts.done.length === 0 ? (
              <div className="shelf-nores">
                {shorts.searching ? `没有匹配「${query.trim()}」的短文` : "这个筛选下暂无短文"}
              </div>
            ) : (
              <>
                {shorts.reading.length > 0 && (
                  <>
                    <div className="shelf-grouptitle">继续阅读 · {shorts.reading.length}</div>
                    <div className="shelf-list">{shorts.reading.map(renderShortRow)}</div>
                  </>
                )}
                {shorts.mergedReadingCount > 0 && (
                  <div className="shelf-merged">
                    已合并 {shorts.mergedReadingCount} 条重复内容
                    <button onClick={() => unmerge(shorts.mergedReadingUrls)}>撤销</button>
                  </div>
                )}
                {shorts.done.length > 0 && (
                  <>
                    <div className="shelf-grouptitle">已读完 · {shorts.done.length}</div>
                    <div className="shelf-list">{shorts.done.map(renderShortRow)}</div>
                  </>
                )}
                {shorts.mergedDoneCount > 0 && (
                  <div className="shelf-merged">
                    已合并 {shorts.mergedDoneCount} 条重复内容
                    <button onClick={() => unmerge(shorts.mergedDoneUrls)}>撤销</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
