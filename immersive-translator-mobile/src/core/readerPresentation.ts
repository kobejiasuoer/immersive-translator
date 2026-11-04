import type { Article, SentencePair } from "./types";

/** Preserve the source's paragraph boundaries while retaining addressable sentences. */
export function readingParagraphs(article: Pick<Article, "sentences" | "paragraphStarts">): SentencePair[][] {
  const starts = new Set(article.paragraphStarts || []);
  const explicitBoundaries = starts.size > 1;
  const paragraphs: SentencePair[][] = [];
  article.sentences.forEach((sentence, position) => {
    const previous = article.sentences[position - 1];
    const newParagraph = !previous || starts.has(sentence.idx) || (!explicitBoundaries && sentence.paragraphIdx !== previous.paragraphIdx);
    if (newParagraph) paragraphs.push([]);
    paragraphs[paragraphs.length - 1].push(sentence);
  });
  return paragraphs;
}

export function clampSentence(index: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, total - 1), Number.isFinite(index) ? Math.floor(index) : 0));
}
