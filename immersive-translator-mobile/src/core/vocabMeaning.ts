import type { ContextExplanation, VocabWord } from "./types";

/** Optional synced English help must remain plain text, including on older clients. */
export function contextExplanationOf(value: unknown): ContextExplanation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.sentence !== "string" || !item.sentence.trim() || item.sentence.length > 6000
    || typeof item.meaning !== "string" || !item.meaning.trim() || item.meaning.length > 1800
    || !/[A-Za-z]/.test(item.meaning) || /[\u3400-\u9fff]/.test(item.meaning)) return null;
  return { sentence: item.sentence, meaning: item.meaning, ...(typeof item.example === "string" && item.example.trim() && item.example.length <= 600 ? { example: item.example } : {}) };
}

export function chineseVocabMeaning(word: Pick<VocabWord, "senses">): string {
  return word.senses.filter(s => typeof s.cn === "string" && s.cn.trim() && !/^（(?:暂无释义|查询失败|词典服务未返回)/.test(s.cn))
    .map(s => `${s.pos || ""} ${s.cn}`.trim()).join("；");
}

export function vocabMeaning(word: Pick<VocabWord, "senses" | "contextExplanation">): string {
  return chineseVocabMeaning(word) || contextExplanationOf(word.contextExplanation)?.meaning || "暂无释义";
}

export function vocabSearchText(word: VocabWord): string {
  const english = contextExplanationOf(word.contextExplanation);
  return [word.word, word.phonetic, chineseVocabMeaning(word), english?.meaning, english?.sentence, english?.example, word.note].filter(Boolean).join(" ").toLocaleLowerCase();
}
