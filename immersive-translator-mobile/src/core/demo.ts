/**
 * v3 演示/种子数据 —— B1 清理后仅存内容种子与过渡常量：
 *  · DEMO_TREES/DEMO_SLOW：演示文章（首启书架种子）；V3_VOCAB：SRS 词表种子（core/data.ts 口径）。
 *  · ChatTurn：陪练轮次类型（store.ts/sheets.tsx 仍从此处 import，未迁移）。
 *  · SPEAK_SCENES：陪练场景页列表（prompt 元数据唯一出处在 core/speak.ts，此处仅展示层）。
 * 陪练对话剧本 CHAT_SCRIPT、演示历史/术语/文库种子、写死跟读句库 SHADOW_SENTS 已随真实链路实化删除。
 */
import type { Article, SentenceChunk, SentencePair } from "./types";
import { DEMO_VOCAB } from "./data";

type RawSentence = { en: string; zh: string | null; chunks?: SentenceChunk[] };

function buildArticle(id: string, title: string, titleCn: string, raw: RawSentence[], paras: [number, number][]): Article {
  const sentences: SentencePair[] = raw.map((s, i) => ({
    idx: i,
    paragraphIdx: paras.findIndex(([a, b]) => i >= a && i <= b),
    en: s.en,
    zh: s.zh,
    chunks: s.chunks,
  }));
  const paragraphStarts = paras.map(([a]) => a);
  return { id, title, titleCn, sentences, paragraphStarts };
}

const TREE_SENTS: RawSentence[] = [
  { en: "The idea of car-free streets took root after the summer of heatwaves.", zh: "无车街道的想法，在热浪之夏之后扎下了根。", chunks: [{ text: "took root", chunkType: "phrasal", gloss: "扎根；（想法）被接受并流行开来", pattern: "take root (in sth)", trap: "take roots（不可数）", word: "take root" }] },
  { en: "In the wake of the storm, the council planted twelve thousand trees.", zh: "风暴过后，市政会种下了一万两千棵树。", chunks: [{ text: "In the wake of", chunkType: "idiom", gloss: "紧随……之后", pattern: "in the wake of sth", trap: "in the wake for", word: "in the wake of" }] },
  { en: "Planners borrowed the Dutch woonerven, where pedestrians come first.", zh: "规划者借鉴了荷兰的「生活庭院」街道——行人优先。" },
  { en: "The city's tree canopy now covers forty percent of the streets.", zh: "这座城市的树冠层，如今覆盖了四成街道。" },
  { en: "Rows of lindens buffer against the traffic noise all summer.", zh: "成排的椴树，整个夏天都在抵御交通噪音。", chunks: [{ text: "buffer against", chunkType: "collocation", gloss: "缓冲，抵御", pattern: "buffer A against B", trap: "buffer from（中式直译）", word: "buffer against" }] },
  { en: "Residents say the air feels lighter near the boulevard.", zh: "居民们说，林荫道附近的空气都轻了几分。" },
  { en: "Residents attribute the cooler summers to the young canopy.", zh: "居民们把更凉爽的夏天，归功于年轻的树冠。", chunks: [{ text: "attribute", chunkType: "pattern", gloss: "把……归因于", pattern: "attribute X to Y", trap: "attribute for（介词误用）", word: "attribute X to Y" }] },
  { en: "Torrential rain tested the new drainage within a week.", zh: "倾盆大雨在一周内，就考验了新的排水系统。" },
  { en: "Nothing flooded, and the boulevards dried within an hour.", zh: "没有一处积水，林荫大道一小时内就干了。" },
  { en: "City planners say the young canopy will pay off within a decade.", zh: "城市规划者说，年轻的树冠十年内就会见效。", chunks: [{ text: "pay off", chunkType: "phrasal", gloss: "见效；得到回报", pattern: "sth pays off", word: "pay off" }] },
  { en: "By and large, cooler streets mean longer walks.", zh: "总体而言，街道越凉爽，人们走得越远。", chunks: [{ text: "By and large", chunkType: "idiom", gloss: "大体上，总的来说", word: "by and large" }] },
  { en: "The next phase will shade the market square by 2027.", zh: "下一阶段将在 2027 年前，为市集广场遮出一片荫。" },
];

const SLOW_SENTS: RawSentence[] = [
  { en: "Speed was the goal, and comprehension was the test.", zh: "速度是目标，理解力是考卷。" },
  { en: "Nobody told us what the rushing was for.", zh: "没有人告诉我们，匆忙本身是为了什么。" },
  { en: "There was a murmur of pages, and then solitude did its quiet work.", zh: "书页沙沙作响，然后独处安静地完成了它的工作。" },
];

export const DEMO_TREES: Article = buildArticle(
  "trees", "Why Cities Need Trees", "为什么城市需要树",
  TREE_SENTS, [[0, 2], [3, 5], [6, 8], [9, 11]],
);

export const DEMO_SLOW: Article = buildArticle(
  "slow", "The Quiet Power of Reading Slowly", "慢读的力量",
  SLOW_SENTS, [[0, 1], [2, 2]],
);

/** 陪练场景页列表（B1 新结构；id 与 core/speak.ts SPEAK_SCENE_META 对齐，label/en/lv/turns 为展示层数据）。 */
export const SPEAK_SCENES = [
  { id: "ordering", label: "点餐", en: "Ordering at a restaurant", lv: "入门", turns: 8 },
  { id: "interview", label: "面试", en: "A practice job interview", lv: "进阶", turns: 10 },
  { id: "travel", label: "旅行", en: "Airport, hotel & asking directions", lv: "进阶", turns: 8 },
  { id: "smalltalk", label: "寒暄", en: "Everyday small talk", lv: "入门", turns: 8 },
] as const;

export type ChatTurn = { who: "ai" | "me"; en: string; zh?: string };

export const V3_VOCAB = DEMO_VOCAB;

/** 完形兜底句：词块出处句不含词条文本时使用（§3.8 素材缺失降级）。 */
export const CLOZE_FALLBACK: Record<string, { en: string; cn: string }> = {
  "settle-in": { en: "It took the new arrivals a week to settle in to the neighbourhood.", cn: "新来的人花了一周才在街区里安顿下来。" },
};
