/**
 * Spike 演示数据（与 prototypes/mobile-v1.html 同源）+ 压测文章生成器。
 * M1 时由真实数据层（reader_store 经 Tauri command）替代。
 */

import type { Article, SentenceChunk, SentencePair, VocabWord } from "./types";

const TREES_PARAS: { en: string; zh: string; chunks: SentenceChunk[] }[] = [
  {
    en: "The idea of car-free streets took root after the summer of heatwaves. In the wake of the storm, the council planted twelve thousand trees.",
    zh: "无车街道的想法在热浪之夏之后扎了根。风暴过后，市政会种下了一万两千棵树。",
    chunks: [
      { text: "took root", chunkType: "phrasal", gloss: "扎根；被接受并流行开来", pattern: "take root (in sth)", trap: "take roots（不可数）", word: "take root" },
      { text: "In the wake of", chunkType: "idiom", gloss: "紧随……之后", pattern: "in the wake of sth", trap: "in the wake for", word: "in the wake of" },
    ],
  },
  {
    en: "The city's tree canopy now covers forty percent of the streets. Rows of lindens buffer against the traffic noise all summer.",
    zh: "这座城市的树冠层如今覆盖了四成的街道。成排的椴树整个夏天都在抵御交通噪音。",
    chunks: [
      { text: "buffer against", chunkType: "collocation", gloss: "缓冲，抵御", pattern: "buffer A against B", trap: "buffer from（中式直译）", word: "buffer against" },
    ],
  },
  {
    en: "Residents attribute the cooler summers to the young canopy. Torrential rain tested the new drainage within a week.",
    zh: "居民们把更凉爽的夏天归功于年轻的树冠。倾盆大雨在一周内就考验了新的排水系统。",
    chunks: [
      { text: "attribute the cooler summers to", chunkType: "pattern", gloss: "把……归因于", pattern: "attribute X to Y", trap: "attribute for", word: "attribute X to Y" },
      { text: "Torrential rain", chunkType: "collocation", gloss: "倾盆大雨", trap: "big rain（中文直译）", word: "torrential rain" },
    ],
  },
  {
    en: "City planners say the young canopy will pay off within a decade. By and large, cooler streets mean longer walks.",
    zh: "城市规划者说，年轻的树冠十年内就会见效。总体而言，街道越凉爽，步行的人越多。",
    chunks: [
      { text: "pay off", chunkType: "phrasal", gloss: "见效；得到回报", pattern: "sth pays off", word: "pay off" },
      { text: "By and large", chunkType: "idiom", gloss: "大体上，总的来说", word: "by and large" },
    ],
  },
];

const SLOW_PARAS: { en: string; zh: string; chunks: SentenceChunk[] }[] = [
  {
    en: "Speed was the goal, and comprehension was the test. Nobody told us what the rushing was for.",
    zh: "速度是目标，理解力是考卷。没有人告诉我们，匆忙本身是为了什么。",
    chunks: [],
  },
  {
    en: "There was a murmur of pages, and then solitude did its quiet work.",
    zh: "书页沙沙作响，然后独处安静地完成了它的工作。",
    chunks: [],
  },
];

function parasToArticle(id: string, title: string, titleCn: string, paras: { en: string; zh: string; chunks: SentenceChunk[] }[]): Article {
  const sentences: SentencePair[] = [];
  const paragraphStarts: number[] = [];
  paras.forEach((p, pi) => {
    paragraphStarts.push(sentences.length);
    const parts = p.en.match(/[^.!?]+[.!?]+["']?\s*|[^.!?]+$/g) || [p.en];
    parts.forEach((s) => {
      const t = s.trim();
      if (t) sentences.push({ idx: sentences.length, paragraphIdx: pi, en: t, zh: p.zh, chunks: p.chunks });
    });
  });
  return { id, title, titleCn, sentences, paragraphStarts };
}

export const DEMO_ARTICLES: Article[] = [
  parasToArticle("trees", "Why Cities Need Trees", "为什么城市需要树", TREES_PARAS),
  parasToArticle("slow", "The Quiet Power of Reading Slowly", "慢读的力量", SLOW_PARAS),
];

/**
 * 压测文章：把 trees 文章重复 multiplier 遍（默认 75 → 约 600 句、~2400 词块高亮节点）。
 * spike S2 用：渲染全部段落（不做虚拟化），测 WKWebView 裸性能。
 */
export function makeStressArticle(multiplier = 75): Article {
  const paras: { en: string; zh: string; chunks: SentenceChunk[] }[] = [];
  for (let i = 0; i < multiplier; i++) TREES_PARAS.forEach((p) => paras.push(p));
  return parasToArticle("stress", `Stress ×${multiplier}`, `压测文章（约 ${multiplier * 8} 句）`, paras);
}

const now = Date.now();

export const DEMO_VOCAB: VocabWord[] = [
  { id: "take-root", word: "take root", kind: "chunk", chunkType: "短语动词", senses: [{ pos: "phrasal", cn: "扎根；（想法）被接受并流行开来" }], pattern: "take root (in sth)", trap: "take roots（不可数，无复数）", sourceArticleId: "trees", sourceSentenceIdx: 0, dueAt: now },
  { id: "in-the-wake-of", word: "in the wake of", kind: "chunk", chunkType: "习语", senses: [{ pos: "idiom", cn: "紧随……之后（常指随坏事件而来）" }], pattern: "in the wake of sth", trap: "in the wake for / at the wake of", sourceArticleId: "trees", sourceSentenceIdx: 1, dueAt: now },
  { id: "buffer-against", word: "buffer against", kind: "chunk", chunkType: "搭配", senses: [{ pos: "collocation", cn: "缓冲，抵御（噪声、冲击、炎热）" }], pattern: "buffer A against B", trap: "buffer from（中式直译）", sourceArticleId: "trees", sourceSentenceIdx: 3, dueAt: now },
  { id: "attribute-to", word: "attribute X to Y", kind: "chunk", chunkType: "句式", senses: [{ pos: "pattern", cn: "把 X 归因于 Y" }], pattern: "attribute X to Y", trap: "attribute for（介词误用）", sourceArticleId: "trees", sourceSentenceIdx: 4, dueAt: now },
  { id: "torrential-rain", word: "torrential rain", kind: "chunk", chunkType: "搭配", senses: [{ pos: "collocation", cn: "倾盆大雨（不是 big rain）" }], trap: "big rain（中文直译）", sourceArticleId: "trees", sourceSentenceIdx: 5, dueAt: now },
  { id: "settle-in", word: "settle in", kind: "chunk", chunkType: "短语动词", senses: [{ pos: "phrasal", cn: "安顿下来，适应新环境" }], pattern: "settle in (to sth)", trap: "settle down to（语义偏向安定就寝）", sourceArticleId: "trees", sourceSentenceIdx: 6, dueAt: now },
  { id: "canopy", word: "canopy", phonetic: "ˈkænəpi", senses: [{ pos: "n.", cn: "（树的）树冠层；顶篷" }], sourceArticleId: "trees", sourceSentenceIdx: 2, dueAt: now },
  { id: "comprehension", word: "comprehension", phonetic: "ˌkɒmprɪˈhenʃn", senses: [{ pos: "n.", cn: "理解力（尤指阅读/听力）" }], sourceArticleId: "slow", sourceSentenceIdx: 0, dueAt: now },
  { id: "heatwave", word: "heatwave", phonetic: "ˈhiːtweɪv", senses: [{ pos: "n.", cn: "热浪" }], sourceArticleId: "trees", sourceSentenceIdx: 0, dueAt: now + 3 * 86400_000 },
  { id: "linden", word: "linden", phonetic: "ˈlɪndən", senses: [{ pos: "n.", cn: "椴树（常用行道树）" }], sourceArticleId: "trees", sourceSentenceIdx: 3, dueAt: now + 7 * 86400_000 },
  { id: "drainage", word: "drainage", phonetic: "ˈdreɪnɪdʒ", senses: [{ pos: "n.", cn: "排水（系统）" }], sourceArticleId: "trees", sourceSentenceIdx: 5, dueAt: now + 12 * 86400_000 },
  { id: "solitude", word: "solitude", phonetic: "ˈsɒlɪtjuːd", senses: [{ pos: "n.", cn: "独处；远离人群的状态（中性偏褒）" }], trap: "别与 loneliness（孤独感，贬义）混译", sourceArticleId: "slow", sourceSentenceIdx: 3, dueAt: now + 12 * 86400_000 },
];

/** spike 词典（未收藏词 tap 查词的假结果；实际实现走 readerDict）。 */
export const MINI_DICT: Record<string, { senses: { pos: string; cn: string }[]; trap?: string }> = {
  council: { senses: [{ pos: "n.", cn: "市政会，议会" }] },
  planners: { senses: [{ pos: "n.", cn: "规划者" }] },
  decade: { senses: [{ pos: "n.", cn: "十年" }] },
  residents: { senses: [{ pos: "n.", cn: "居民" }] },
  neighbourhood: { senses: [{ pos: "n.", cn: "街区，邻里" }], trap: "美式拼写 neighborhood" },
  murmur: { senses: [{ pos: "n./v.", cn: "低语，沙沙声" }] },
  gale: { senses: [{ pos: "n.", cn: "大风，强风" }] },
};
