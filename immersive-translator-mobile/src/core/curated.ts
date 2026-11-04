/**
 * 精选内容目录（proto-parity-2026-11-01 · 原型内容数据的对位实现）：
 *  · CURATED_FEEDS：英文资讯订阅源目录（原型 FEEDS，html:1562-1566）——名称/描述/频次/docIds
 *    逐字取自原型；「看样例」展示首个文档（docIds[0]）的题 + 前 2 句（原型 SHEETS.feedPreview，
 *    html:2068），「订阅，并开始读这篇」把该源全部文档入库并打开第一篇（原型 ACT subscribe-feed，
 *    html:2205，toast「已订阅，可以开始阅读」）。
 *  · CURATED_DOCS：订阅源样例文（原型 SHORT_ARTICLES 中被 FEEDS.docIds 引用的 7 篇，
 *    html:1222-1249）——句/译文/结构解析逐字对位；来源名与难度随原型 doc（粘贴导入/英文资讯订阅/
 *    精选经典 · 日常/职场），时长按原型口径（词数 ÷100 向上取整，html:1538）。
 *  · CURATED_BOOKS：精选经典书库目录（原型 BOOKS，html:1557-1561）——绿/蓝/棕三色封面
 *    （coverClass 对位原型 .cover/.c2/.c3）+ 难度 + 章数；难度筛选口径同原型
 *    （入门/中级 = level 匹配 /入门|日常|四六级/，html:2040）。
 * 这些是产品随包的编辑内容（与 DEMO_STARTER 同类），不是网络返回的假数据；
 * 自定义 RSS 订阅与书库真实下载导入链路（discovery.ts）原样保留。
 */
import type { Article, SentenceParseContent } from "./types";

/** 原型 SHORT_ARTICLES 的行结构：[en, zh, trunk, parts[[label, text, note, level]]]。 */
type CuratedSent = [string, string, string, [string, string, string, number][]];

interface CuratedDoc {
  id: string;
  title: string;
  /** 来源展示名（原型 doc.source）。 */
  source: string;
  /** 难度档（原型 doc.difficulty；terminal=职场，其余日常）。 */
  difficulty: string;
  sents: CuratedSent[];
}

const CURATED_DOC_META: CuratedDoc[] = [
  {
    id: "speed", title: "The Speed of Reading", source: "粘贴导入", difficulty: "日常",
    sents: [
      ["Researchers measured how fast volunteers could move through a text.", "研究人员测量了志愿者阅读一段文本的速度。", "Researchers measured", [["主语", "Researchers", "研究人员", 0], ["谓语", "measured", "测量", 0], ["宾语从句", "how fast volunteers could move through a text", "how fast 引导的方式宾语从句", 1]]],
      ["They found that silent reading is almost twice as fast as reading aloud.", "他们发现默读的速度几乎是朗读的两倍。", "They found that silent reading is fast", [["主语", "They", "指代研究人员", 0], ["谓语", "found", "发现", 0], ["宾语从句", "that silent reading is almost twice as fast...", "倍数表达 twice as... as...", 1]]],
      ["However, slowing down on unfamiliar phrases helps long-term memory.", "然而，在陌生的词块上放慢速度有助于长期记忆。", "slowing down helps memory", [["动名词主语", "slowing down on unfamiliar phrases", "放慢速度", 0], ["谓语", "helps", "有助于", 0], ["宾语", "long-term memory", "长期记忆", 0]]],
    ],
  },
  {
    id: "sleep", title: "How Sleep Consolidates Second Language Words", source: "英文资讯订阅", difficulty: "日常",
    sents: [
      ["Reviewing new vocabulary right before bed helps the brain replay and store word pairs.", "睡前复习生词有助于大脑重放并巩固词汇配对。", "Reviewing helps the brain replay", [["动名词主语", "Reviewing new vocabulary", "复习新词汇", 0], ["谓语", "helps the brain replay and store", "帮助大脑重放和储存", 0]]],
    ],
  },
  {
    id: "terminal", title: "Fixing Common Shell Commands", source: "粘贴导入", difficulty: "职场",
    sents: [
      ["Can you help me fix a command that keeps failing in the terminal?", "你能帮我修好一条在终端里一直报错的命令吗？", "Can you help me fix a command", [["主语", "you", "", 0], ["谓语", "help me fix a command", "帮我修复命令", 0], ["定语从句", "that keeps failing in the terminal", "修饰 command", 1]]],
    ],
  },
  {
    id: "booking", title: "I am wondering if others have experienced what I am seeing", source: "英文资讯订阅", difficulty: "日常",
    sents: [
      ["When traveling abroad, map apps sometimes show two different pins for the same hotel.", "出国旅行时，地图应用有时会为同一家酒店显示两个不同的定位针。", "map apps show pins", [["时间状语", "When traveling abroad", "分词短语作时间状语", 1], ["主语", "map apps", "地图应用", 0], ["谓语", "show two different pins", "显示两个不同的图钉", 0]]],
      ["Locations on Booking.com and Ctrip are also similarly inconsistent with the street address.", "Booking.com 和携程上的位置同样与街道地址对不上。", "Locations are inconsistent", [["主语", "Locations on Booking.com and Ctrip", "平台上的位置信息", 0], ["系表结构", "are inconsistent with", "与……不一致", 0], ["宾语", "the street address", "街道地址", 1]]],
      ["Always standardize your checklist by saving the local language address before departure.", "出发前务必先保存当地语言地址，把核对流程标准化。", "standardize your checklist", [["祈使谓语", "Always standardize", "务必标准化", 0], ["方式状语", "by saving the local language address", "通过保存当地语言地址", 1]]],
    ],
  },
  {
    id: "trees", title: "Why Cities Need Trees", source: "精选经典", difficulty: "日常",
    sents: [
      ["Urban trees do far more than decorate a neighborhood sidewalk.", "城市树木的作用远不止装点街区人行道。", "Urban trees do far more", [["主语", "Urban trees", "城市树木", 0], ["谓语", "do far more than decorate...", "远不止装饰", 0]]],
      ["A mature canopy can cool a street by several degrees in August.", "成熟的树冠在八月能让街道降温好几度。", "A canopy can cool a street", [["主语", "A mature canopy", "成熟的树冠", 0], ["谓语", "can cool a street", "能为街道降温", 0], ["程度状语", "by several degrees", "降温幅度", 1]]],
      ["Volunteers across the city now help map and water young saplings.", "全城的志愿者现在帮忙标记并浇灌幼苗。", "Volunteers help map and water saplings", [["主语", "Volunteers across the city", "全城志愿者", 0], ["谓语", "help map and water", "帮助标记并浇灌", 0]]],
    ],
  },
  {
    id: "coffee", title: "The Quiet Ritual of Morning Coffee", source: "精选经典", difficulty: "日常",
    sents: [
      ["Before the inbox opens, ten quiet minutes with a warm mug can reset the whole morning.", "在打开收件箱之前，捧着热杯子安静呆十分钟能重启整个早晨。", "ten minutes can reset the morning", [["时间状语", "Before the inbox opens", "打开收件箱前", 1], ["主语", "ten quiet minutes", "安静的十分钟", 0], ["谓语", "can reset the whole morning", "重启整个早晨", 0]]],
    ],
  },
  {
    id: "museum", title: "A Rainy Afternoon at the Museum", source: "精选经典", difficulty: "日常",
    sents: [
      ["Stepping out of the rain into a quiet gallery immediately slows your breathing.", "从雨中步入安静的展厅，呼吸立刻慢了下来。", "Stepping into a gallery slows breathing", [["动名词主语", "Stepping out of the rain...", "步入展厅", 0], ["谓语", "slows your breathing", "放慢呼吸", 0]]],
    ],
  },
];

/** 时长口径同原型（html:1538）：词数 ÷100 向上取整、不足 1 分钟记 1。 */
function curatedMinutes(article: Pick<Article, "sentences">): number {
  const words = article.sentences.reduce((n, s) => n + (s.en.match(/[A-Za-z0-9'’-]+/g)?.length ?? 0), 0);
  return Math.max(1, Math.ceil(words / 100));
}

function buildCuratedArticle(meta: CuratedDoc): Article {
  return {
    id: meta.id,
    title: meta.title,
    titleCn: "",
    sourceType: "sample",
    sourceLabel: meta.source,
    level: meta.difficulty,
    paragraphStarts: [0],
    minutes: 0, /* 先占位，下方按词数回填 */
    sentences: meta.sents.map(([en, zh, trunk, parts], idx): Article["sentences"][number] => ({
      idx,
      paragraphIdx: 0,
      en,
      zh,
      zhState: "machine",
      parse: { trunk, parts: parts.map(([label, text, note, level]) => ({ label, text, note: note || undefined, level })) } satisfies SentenceParseContent,
    })),
  };
}

/** 精选文档（订阅源样例）；id→文档 索引自举以计算时长。 */
export const CURATED_DOCS: Article[] = CURATED_DOC_META.map((meta) => {
  const article = buildCuratedArticle(meta);
  article.minutes = curatedMinutes(article);
  return article;
});

/** 订阅源目录（原型 FEEDS，html:1562-1566 逐字）。 */
export interface CuratedFeed {
  id: string;
  name: string;
  description: string;
  /** 频次行（如「每天一篇 · 约 3 分钟」）。 */
  frequency: string;
  docIds: string[];
}

export const CURATED_FEEDS: CuratedFeed[] = [
  { id: "f1", name: "Science Daily Brief", description: "用短篇科研资讯练习日常阅读", frequency: "精选 2 篇 · 本机练习短文", docIds: ["speed", "sleep"] },
  { id: "f2", name: "Tech & Terminal Weekly", description: "开发、产品和工作中的真实表达", frequency: "精选 2 篇 · 本机练习短文", docIds: ["terminal", "booking"] },
  { id: "f3", name: "Slow City Essays", description: "城市生活与文化，适合慢慢读", frequency: "精选 3 篇 · 本机练习短文", docIds: ["trees", "coffee", "museum"] },
];

export function curatedFeed(id: string): CuratedFeed | undefined {
  return CURATED_FEEDS.find((f) => f.id === id);
}

/** 某订阅源的全部文档（按 docIds 序；未收录 id 返回空）。 */
export function curatedFeedDocs(id: string): Article[] {
  const feed = curatedFeed(id);
  if (!feed) return [];
  return feed.docIds.map((docId) => CURATED_DOCS.find((d) => d.id === docId)).filter((d): d is Article => !!d);
}

/** 精选经典书库目录（原型 BOOKS，html:1557-1561 逐字）。coverClass 对位原型 .cover/.c2/.c3。 */
export interface CuratedBook {
  id: string;
  title: string;
  author: string;
  level: string;
  chapterCount: number;
  coverClass: "" | "c2" | "c3";
}

export const CURATED_BOOKS: CuratedBook[] = [
  { id: "b1", title: "Classic Short Stories", author: "Oscar Wilde & Jack London", level: "进阶", chapterCount: 6, coverClass: "" },
  { id: "b2", title: "The Gift of the Magi & Other Stories", author: "O. Henry", level: "日常", chapterCount: 2, coverClass: "c2" },
  { id: "b3", title: "Sherlock Holmes: Selected Cases", author: "Arthur Conan Doyle", level: "进阶", chapterCount: 2, coverClass: "c3" },
];
