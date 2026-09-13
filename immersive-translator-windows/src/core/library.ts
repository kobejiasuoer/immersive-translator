/**
 * 内置分级文库（内容进水口）：公版书全文 + 元信息。
 *
 * 数据来自 scripts/build-intake-assets.mjs 生成的 library.json
 * （文本取自 Standard Ebooks，均为公有领域）。v1 内置六篇短篇/选章，
 * 「今日一篇」按本地日期轮换；文库扩容走服务端（v2.0）。
 */

import data from "./data/library.json";
import { buildArticleFromText } from "./articleBuilder";
import type { Article } from "./readerTypes";

export interface LibraryItem {
  id: string;
  /** 英文标题。 */
  en: string;
  /** 中文标题。 */
  cn: string;
  author: string;
  /** 难度标签（A2 / B1 / B2），文库分级是人工标注的。 */
  level: "A2" | "B1" | "B2";
  words: number;
  /** 估时（分钟，按 135 wpm）。 */
  minutes: number;
  /** 开篇摘句（文库卡展示）。 */
  quote: string;
  /** 文本来源（Standard Ebooks 仓库）。 */
  sourceUrl: string;
  /** 全文，段落以空行分隔。 */
  text: string;
}

export const LIBRARY: LibraryItem[] = data as LibraryItem[];

/** 本地日期序（用于「今日一篇」轮换，跨天换篇且全设备同序）。 */
export function localDayNumber(now = Date.now()): number {
  const d = new Date(now);
  return Math.floor(
    (d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000,
  );
}

/** 今日一篇：按日期在文库中轮换。 */
export function todayLibraryItem(now = Date.now()): LibraryItem {
  return LIBRARY[localDayNumber(now) % LIBRARY.length];
}

/** 文库条目 → 阅读室文章（标题用首行识别，副标题/难度直接带入）。 */
export function buildArticleFromLibraryItem(item: LibraryItem, now = Date.now()): Article | null {
  return buildArticleFromText(item.text, {
    sourceType: "paste",
    sourceUrl: `library:${item.id}`,
    title: item.en,
    titleCn: `${item.cn} · ${item.author}`,
    level: item.level,
    now,
  });
}
