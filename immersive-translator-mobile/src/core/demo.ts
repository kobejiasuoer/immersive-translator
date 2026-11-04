/**
 * v3 演示/种子数据 —— B1 清理后仅存内容种子与过渡常量：
 *  · DEMO_STARTER：入门演示文（首启书架种子，proto-parity-2026-11-01：原型 DOCUMENTS.starter
 *    「A Small Break」同文句/同词条，html:1524-1541——read-fresh hero 预览块、书架「开始这篇短文」、
 *    阅读演示态与点词查词卡同源）；V3_VOCAB：SRS 词表种子（core/data.ts 口径）。
 *  · ChatTurn：陪练轮次类型（store.ts/sheets.tsx 仍从此处 import，未迁移）。
 *  · SPEAK_SCENES：陪练场景页列表（prompt 元数据唯一出处在 core/speak.ts，此处仅展示层）。
 * 陪练对话剧本 CHAT_SCRIPT、演示历史/术语/文库种子、写死跟读句库 SHADOW_SENTS 已随真实链路实化删除。
 */
import type { Article, SentenceChunk, SentencePair, SentenceParseContent } from "./types";
import { DEMO_VOCAB } from "./data";

type RawSentence = { en: string; zh: string | null; chunks?: SentenceChunk[]; parse?: SentenceParseContent };

function buildArticle(id: string, title: string, titleCn: string, raw: RawSentence[], paras: [number, number][], extra: Partial<Article> = {}): Article {
  const sentences: SentencePair[] = raw.map((s, i) => ({
    idx: i,
    paragraphIdx: paras.findIndex(([a, b]) => i >= a && i <= b),
    en: s.en,
    zh: s.zh,
    chunks: s.chunks,
    parse: s.parse,
  }));
  const paragraphStarts = paras.map(([a]) => a);
  return { id, title, titleCn, sentences, paragraphStarts, ...extra };
}

const STARTER_SENTS: RawSentence[] = [
  { en: "Every afternoon, I take a break from work.", zh: "每天下午，我都会暂停工作，休息一会儿。", chunks: [{ text: "take a break", chunkType: "phrasal", word: "take a break", gloss: "休息一会儿，暂停一下", pos: "phr.", phonetic: "/teɪk ə breɪk/" }], parse: { trunk: "I take a break", parts: [
    { label: "时间状语", text: "Every afternoon", note: "每天下午", level: 1 },
    { label: "主语", text: "I", note: "我", level: 0 },
    { label: "谓语与词块", text: "take a break from work", note: "暂时放下工作休息一会儿", level: 0 },
  ] } },
  { en: "I leave my phone on the desk and walk outside.", zh: "我把手机留在桌上，走到外面。", parse: { trunk: "I leave my phone and walk outside", parts: [
    { label: "主语", text: "I", note: "我", level: 0 },
    { label: "并列动作", text: "leave my phone … and walk outside", note: "放下手机，然后走出去", level: 0 },
  ] } },
  { en: "A quiet street helps me clear my head.", zh: "一条安静的街道能让我理清思绪。", chunks: [
    { text: "clear my head", chunkType: "collocation", word: "clear my head", gloss: "理清思绪，让头脑清醒", pos: "phr.", phonetic: "/klɪə maɪ hed/" },
    { text: "quiet", gloss: "安静的", pos: "adj.", phonetic: "/ˈkwaɪət/" },
  ], parse: { trunk: "A quiet street helps me", parts: [
    { label: "主语", text: "A quiet street", note: "一条安静的街道", level: 0 },
    { label: "谓语", text: "helps me clear my head", note: "帮助我理清思绪；help sb. do sth.", level: 0 },
  ] } },
  { en: "After ten minutes, I come back with a fresh idea.", zh: "十分钟后，我带着一个新想法回来。", chunks: [{ text: "come back", chunkType: "phrasal", word: "come back", gloss: "回来", pos: "phr.", phonetic: "/kʌm bæk/" }], parse: { trunk: "I come back with a fresh idea", parts: [
    { label: "时间状语", text: "After ten minutes", note: "十分钟后", level: 1 },
    { label: "谓语", text: "come back", note: "回来", level: 0 },
    { label: "伴随信息", text: "with a fresh idea", note: "带着一个新想法", level: 1 },
  ] } },
  { en: "Sometimes, doing less helps us do better.", zh: "有时候，少做一点，反而能做得更好。", parse: { trunk: "doing less helps us do better", parts: [
    { label: "主语", text: "doing less", note: "少做一点，动名词短语", level: 0 },
    { label: "谓语", text: "helps us do better", note: "帮助我们做得更好", level: 0 },
  ] } },
];

export const DEMO_STARTER: Article = buildArticle(
  "starter", "A Small Break", "给自己一个小休息",
  STARTER_SENTS, [[0, 2], [3, 4]],
  {
    minutes: 2,
    terms: ["take a break", "clear my head", "quiet", "come back"],
    termMeta: [
      { w: "take a break", ph: "/teɪk ə breɪk/", pos: "phr.", cn: "休息一会儿，暂停一下" },
      { w: "clear my head", ph: "/klɪə maɪ hed/", pos: "phr.", cn: "理清思绪，让头脑清醒" },
      { w: "quiet", ph: "/ˈkwaɪət/", pos: "adj.", cn: "安静的" },
      { w: "come back", ph: "/kʌm bæk/", pos: "phr.", cn: "回来" },
    ],
  },
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
