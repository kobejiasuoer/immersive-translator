/**
 * 整页书架（应用首页）：DOM 与视觉逐块对齐原型 screen-shelf。
 *
 * - 头部：书架 h2 + 书/短文 seg tab + 数量 + 导入按钮。
 * - 书 tab：bookgrid 两列大书卡（渐变封皮印书名/作者、词数估时 chips、
 *   章进度条、「继续读 第 N 章 · 第 M 句」直达断点、查看目录、考研词雷达徽标）。
 * - 短文 tab：artlist 单容器行（级别 chip、标题、点线引导、大纲词角标、百分比、悬停删除）。
 * - 底部 todaycard：阅读圆环 + 今日已读/连续天数 + 今日复习进度与「继续复习」。
 */

import { useMemo, useState } from "react";
import { IconBookOpen, IconPlay, IconPlus, IconStar, IconTrash } from "../ui/icons";
import type { ArticleSummary, BookMeta } from "../core/readerTypes";
import { bookChapterIndexOf, bookOverallPercent } from "../core/readerTypes";
import { EXAM_GOAL_LABELS, type CoverageStats, type ExamGoal } from "../core/examCoverage";

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
  onOpenImport: () => void;
  onGoReview: () => void;
}

const RING_LEN = 2 * Math.PI * 24;

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
  const totalBookWords = useMemo(
    () => books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.wordCount, 0), 0),
    [books],
  );

  const goalOn = readGoalMin > 0;
  const readMin = Math.max(0, Math.round(readMinutesToday));
  const ringRatio = goalOn ? Math.min(1, readMin / readGoalMin) : 0;
  const todayTotal = reviewedToday + dueNow;
  const reviewPct = Math.round((reviewedToday / Math.max(1, todayTotal)) * 100);

  return (
    <div className="shelf-page">
      <div className="shelf-inner">
        <div className="shelf-head">
          <h2>书架</h2>
          <div className="shelf-seg" role="tablist">
            <button className={tab === "books" ? "on" : ""} role="tab" aria-selected={tab === "books"} onClick={() => setTab("books")}>
              书
            </button>
            <button
              className={tab === "articles" ? "on" : ""}
              role="tab"
              aria-selected={tab === "articles"}
              onClick={() => setTab("articles")}
            >
              短文
            </button>
          </div>
          <span className="count">
            {tab === "books"
              ? books.length > 0
                ? `${books.length} 本书 · ${totalBookWords.toLocaleString()} 词`
                : "还没有书"
              : articles.length > 0
                ? `${articles.length} 篇短文`
                : "还没有短文"}
          </span>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onOpenImport} title="导入向导 · 新增 EPUB 长书">
            <IconPlus size={13} />
            导入
          </button>
        </div>

        {tab === "books" ? (
          books.length === 0 ? (
            <button className="shelf-empty" onClick={onOpenImport}>
              <IconBookOpen size={20} />
              <span className="t">导入整本 EPUB</span>
              <span className="sub">自动分章 · 断点续读 · 生词进复习闭环；也可以先读内置文库的短篇</span>
            </button>
          ) : (
            <div className="bookgrid">
              {books.map((b) => {
                const idx = bookChapterIndexOf(b, b.progress.chapterId);
                const percent = Math.round(bookOverallPercent(b));
                const started = b.progress.percent > 0 || idx > 0;
                const sentence = b.progress.sentenceIdx;
                const words = b.chapters.reduce((n, c) => n + c.wordCount, 0);
                const minutes = Math.max(1, Math.round(words / 135));
                return (
                  <div
                    key={b.id}
                    className="bookcard"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenBookToc(b)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpenBookToc(b);
                    }}
                    title="进入书目录"
                  >
                    <div className="bookcover" aria-hidden>
                      {b.cover ? (
                        <img src={b.cover} alt="" />
                      ) : (
                        <>
                          <span className="cv-mark">{b.title.charAt(0).toUpperCase()}</span>
                          <span className="cv-t">{b.title}</span>
                          <span className="cv-a">{b.author ?? ""}</span>
                        </>
                      )}
                      {percent >= 100 && <span className="cv-done">已读完 ✓</span>}
                    </div>
                    <div className="bookmain">
                      <div className="booktitle serif" title={b.title}>
                        {b.title}
                      </div>
                      <div className="booktitle-cn">
                        {b.author ?? "未知作者"} · 共 {b.chapters.length} 章
                      </div>
                      <div className="bookchips">
                        <span className="chip">{b.chapters.length} 章</span>
                        <span className="chip">{words.toLocaleString()} 词</span>
                        <span className="chip">约 {minutes >= 60 ? `${(minutes / 60).toFixed(1).replace(/\.0$/, "")} 小时` : `${minutes} 分钟`}</span>
                      </div>
                      <div className="bookprog">
                        <div className="row">
                          <b>{percent}%</b>
                          <span>{percent >= 100 ? "已读完" : started ? `已读至第 ${idx + 1} / ${b.chapters.length} 章` : "尚未开始"}</span>
                        </div>
                        <div className="track" aria-hidden>
                          <div className="fill" style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                      <div className="bookacts">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onContinueBook(b);
                          }}
                        >
                          <IconPlay size={11} />
                          {started ? `继续读 第 ${idx + 1} 章 · 第 ${sentence + 1} 句` : "开始阅读"}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenBookToc(b);
                          }}
                        >
                          查看目录
                        </button>
                        {b.radar.kaoyan > 0 && (
                          <button
                            className="radar-badge"
                            title="选书雷达：考研大纲词覆盖数"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenBookToc(b);
                            }}
                          >
                            {EXAM_GOAL_LABELS.kaoyan} · 大纲词 {b.radar.kaoyan.toLocaleString()}
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `删除《${b.title}》？将删除全部 ${b.chapters.length} 章内容与这本书的阅读进度，不可恢复；生词本不受影响。`,
                          )
                        )
                          onDeleteBook(b.id);
                      }}
                      title="移出书架（生词本不受影响）"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : articles.length === 0 ? (
          <button className="shelf-empty" onClick={onOpenImport}>
            <IconBookOpen size={20} />
            <span className="t">添加一篇短文</span>
            <span className="sub">内置文库 · 网页链接 · Word / PDF · 粘贴文本</span>
          </button>
        ) : (
          <div className="artlist">
            {articles.map((a) => {
              const cov = articleCoverage[a.id];
              return (
                <div
                  key={a.id}
                  className="artrow"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectArticle(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelectArticle(a.id);
                  }}
                >
                  {a.level && <span className="chip lvl">{a.level}</span>}
                  <div className="art-t">
                    <div className="t serif" title={a.title}>
                      {a.title}
                    </div>
                    {a.titleCn && <div className="cn">{a.titleCn}</div>}
                  </div>
                  <span className="dots" aria-hidden />
                  {cov && (
                    <span className="vocabadge" title={`${EXAM_GOAL_LABELS[examGoal]}大纲词命中 ${cov.total} 个`}>
                      <IconStar size={10} />
                      {EXAM_GOAL_LABELS[examGoal]}词 {cov.total}
                    </span>
                  )}
                  <span className="pct">{Math.round(a.progress.percent)}%</span>
                  <button
                    className="del"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`删除《${a.title}》？这篇短文将从书架移除；生词本不受影响。`)) onDeleteArticle(a.id);
                    }}
                    title="删除文章（生词本不受影响）"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="shelf-foot">
          <div className="todaycard">
            <div className="today-ring" aria-hidden>
              <svg width="56" height="56" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r="24" fill="none" stroke="var(--border)" strokeWidth="4" />
                <circle
                  className={ringRatio >= 1 ? "ring-pop" : undefined}
                  cx="28"
                  cy="28"
                  r="24"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={RING_LEN}
                  strokeDashoffset={RING_LEN * (1 - ringRatio)}
                  transform="rotate(-90 28 28)"
                />
              </svg>
              <span className="num">{goalOn ? `${readMin}/${readGoalMin}` : `${readMin}′`}</span>
            </div>
            <div className="today-main">
              <div className="today-line">
                今日已读 <strong>{readMin}</strong> / {goalOn ? `${readGoalMin} 分钟` : "— 分钟"}
              </div>
              <div className="today-sub">
                {goalOn
                  ? readMin >= readGoalMin
                    ? "阅读目标已达成 ✓ · 明天继续保持"
                    : `阅读目标还差 ${readGoalMin - readMin} 分钟达成`
                  : "可在阅读设置里定每日阅读目标"}
              </div>
              <div className="today-sub">
                <span className="streak-pill">
                  <IconFlame size={12} />
                  连续阅读 <b>{streak}</b> 天
                </span>
              </div>
            </div>
            <div className="today-review">
              <div className="today-line">
                今日复习 <strong>{reviewedToday}</strong> / {todayTotal}
              </div>
              <div className="bar" aria-hidden>
                <div className="fill" style={{ width: `${reviewPct}%` }} />
              </div>
              <div className="today-sub">
                {dueNow > 0 ? `还差 ${dueNow} 个清空今天到期` : todayTotal > 0 ? "今天的到期已清空 ✓" : "今天没有到期生词"}
              </div>
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: 8 }}
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
                {dueNow > 0 ? "继续复习" : "今日已清空"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
