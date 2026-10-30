/**
 * 复习队列构建（smart 路由 #51）：词块 → 完形/听写，单词 → 识别；
 * 素材缺失（出处句不含词条）降级识别卡。判分/SRS 内核 = core/judge、core/srs（§6.2 勿重写）。
 */
import { norm } from "./judge";
import { CLOZE_FALLBACK } from "./demo";
import type { Article, VocabWord } from "./types";

export type CardMode = "recognition" | "cloze" | "dictation";

export interface ReviewCard {
  id: string;
  mode: CardMode;
  word: string;
  phonetic?: string;
  kind: "word" | "chunk";
  chunkType?: string;
  /** 完形槽 */
  pre?: string;
  post?: string;
  answer: string;
  trap?: string;
  vTrap?: string;
  hint: string;
  pattern?: string;
  /** 原句定位（完形/听写来源句，词典卡「来自」复用） */
  articleId?: string;
  sentIdx: number;
}

function sensesCn(v: VocabWord): string {
  return v.senses[0]?.cn || "（暂无释义）";
}

function findSentence(articles: Article[], articleId: string, sentIdx: number) {
  const a = articles.find((x) => x.id === articleId);
  return a ? a.sentences[sentIdx] : undefined;
}

export function buildCard(v: VocabWord, articles: Article[]): ReviewCard {
  const kind: "word" | "chunk" = v.kind === "chunk" ? "chunk" : "word";
  const sent = findSentence(articles, v.sourceArticleId, v.sourceSentenceIdx);
  const base: ReviewCard = {
    id: v.id,
    mode: "recognition",
    word: v.word,
    phonetic: v.phonetic,
    kind,
    chunkType: v.chunkType,
    answer: v.word,
    trap: v.trap,
    vTrap: v.trap,
    hint: sensesCn(v),
    pattern: v.pattern,
    articleId: v.sourceArticleId,
    sentIdx: v.sourceSentenceIdx,
  };
  if (kind === "word") return base;

  /* 词块：优先完形（出处句含词条文本），否则兜底句，再否则降级识别 */
  let en: string | undefined;
  let answer = v.word;
  if (sent) {
    const chunkHit = (sent.chunks || []).find((c) => (c.word && norm(c.word) === norm(v.word)) || norm(c.text) === norm(v.word));
    const span = chunkHit ? chunkHit.text : v.word;
    const pos = sent.en.toLowerCase().indexOf(span.toLowerCase());
    if (pos > -1) {
      en = sent.en;
      answer = span;
    }
  }
  if (!en) {
    const fb = CLOZE_FALLBACK[v.id];
    if (fb) {
      const pos = fb.en.toLowerCase().indexOf(v.word.toLowerCase());
      if (pos > -1) {
        en = fb.en;
        answer = v.word;
      }
    }
  }
  if (en) {
    const pos = en.toLowerCase().indexOf(answer.toLowerCase());
    return {
      ...base,
      mode: "cloze",
      answer,
      pre: en.slice(0, pos).trim(),
      post: en.slice(pos + answer.length).trim(),
    };
  }
  return base;
}

/** 今日队列：单词识别与词块完形交错；每 4 张插一张听写（有出处句的词块）。 */
export function buildReviewQueue(vocab: VocabWord[], articles: Article[]): ReviewCard[] {
  const due = vocab.filter((v) => !v.paused && v.dueAt <= Date.now());
  const cards = due.map((v) => buildCard(v, articles));
  const words = cards.filter((c) => c.kind === "word");
  const chunks = cards.filter((c) => c.kind === "chunk");
  const out: ReviewCard[] = [];
  let wi = 0;
  let ci = 0;
  while (wi < words.length || ci < chunks.length) {
    if (ci < chunks.length) out.push(chunks[ci++]);
    if (wi < words.length) out.push(words[wi++]);
  }
  /* 听写化：按完形卡计数，每第 4 张完形改听写（最多 2 张，对齐原型 8 卡中 2 听写）。
     不再用 i+=4 的索引法——交错后单词卡占偶数位，恒落单词位导致听写永不可达（P-13）。 */
  let placed = 0;
  let clozeSeen = 0;
  for (let i = 0; i < out.length && placed < 2; i++) {
    const c = out[i];
    if (c.mode !== "cloze") continue;
    clozeSeen++;
    if (clozeSeen % 4 !== 0) continue;
    const sent = c.articleId ? findSentence(articles, c.articleId, c.sentIdx) : undefined;
    if (sent) {
      out[i] = { ...c, mode: "dictation", answer: sent.en, pre: undefined, post: undefined, hint: sent.zh || c.hint };
      placed++;
    }
  }
  return out;
}

export function cardForWord(id: string, vocab: VocabWord[], articles: Article[]): ReviewCard | null {
  const v = vocab.find((x) => x.id === id);
  return v ? buildCard(v, articles) : null;
}
