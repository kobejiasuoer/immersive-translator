/**
 * 阅读域展示元信息（proto-parity · 原型 v2DocMeta/v2ReadingCard，html:1781,1767-1769）。
 * 来源/级别/时长全部由文章真实数据推导（无写死内容）：时长 = 正文词数 ÷ 130 词/分钟向上取整；
 * 级别：文章自带 level 字段优先，书章缺省「进阶」，内置样文「入门」，导入内容「自己的内容」。
 */
import type { Article } from "../../core/types";

export function wordsOf(article: Article): number {
  return article.sentences.reduce((n, s) => n + (s.en.match(/[A-Za-z0-9'’-]+/g)?.length ?? 0), 0);
}

export function minutesOf(article: Article): number {
  /* 内容源声明的时长优先（原型 doc.minutes，如《A Small Break》2 分钟）；缺省按词数估算 */
  if (typeof article.minutes === "number" && article.minutes > 0) return article.minutes;
  return Math.max(1, Math.ceil(wordsOf(article) / 130));
}

export function sourceLabelOf(article: Article): string {
  if (article.bookId) return String(article.bookTitle || article.title);
  /* 内容源给出的来源名优先（原型 doc.source，html:1781 v2DocMeta 直出），如精选资讯样例文的「粘贴导入」 */
  if (typeof article.sourceLabel === "string" && article.sourceLabel.trim()) return article.sourceLabel.trim();
  if (article.sourceType === "sample") return "精选短文";
  if (article.sourceType === "relay") return "来自电脑";
  if (article.sourceType === "url") return "网页导入";
  if (article.sourceType === "rss") return "订阅导入";
  return "我的导入";
}

export function levelLabelOf(article: Article): string {
  const level = article.level;
  if (typeof level === "string" && level.trim()) return level;
  if (article.bookId) return "进阶";
  if (article.sourceType === "sample") return "入门";
  return "自己的内容";
}

/** 阅读器页头副标（原型 v2DocMeta）：书=「书名 · 第 N 章节选」；其余=「来源 · 级别 · 约 N 分钟」。 */
export function docMetaOf(article: Article): string {
  if (article.bookId) {
    const chapter = Number(article.chapterIndex ?? 0) + 1;
    return `${String(article.bookTitle || article.title)} · 第 ${chapter} 章节选`;
  }
  return `${sourceLabelOf(article)} · ${levelLabelOf(article)} · 约 ${minutesOf(article)} 分钟`;
}

/** 相对时间（原型 timeLabel 口径）：同日「今天 HH:MM」，更早「M月D日」。 */
export function timeLabelOf(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
