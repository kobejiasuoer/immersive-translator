import { describe, expect, it } from "vitest";
import {
  coveredWords,
  coverageForText,
  examTokenize,
  wordInGoalList,
} from "./examCoverage";
import { initialSrs } from "./readerSrs";
import type { VocabWord } from "./readerTypes";

function vocabWord(word: string, intervalDays = 0): VocabWord {
  const now = Date.now();
  return {
    id: word,
    word,
    senses: [],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: { ...initialSrs(now), intervalDays, dueAt: now },
    addedAt: now,
  };
}

describe("examTokenize", () => {
  it("拆小写词并保留撇号", () => {
    expect(examTokenize("The Swallow's eyes; EYES!")).toEqual([
      "the",
      "swallow's",
      "eyes",
      "eyes",
    ]);
  });

  it("忽略数字与 CJK", () => {
    expect(examTokenize("180 cents，铜板")).toEqual(["cents"]);
  });
});

describe("coveredWords", () => {
  it("命中词表并做屈折回落", () => {
    // abandon / ability 都是四级大纲词；abandoning 回落到 abandon
    const hit = coveredWords("He would abandon everything. Abandoning tasks tests ability.", "cet4");
    expect(hit.has("abandon")).toBe(true);
    expect(hit.has("ability")).toBe(true);
  });

  it("不规则形式回落到原形", () => {
    const hit = coveredWords("She took the money and ran away. The children came.", "cet4");
    expect(hit.has("take")).toBe(true);
    expect(hit.has("run")).toBe(true);
    expect(hit.has("child")).toBe(true);
    expect(hit.has("come")).toBe(true);
  });

  it("不命中时为空集", () => {
    const hit = coveredWords("qwerty fluorspar zzz", "cet4");
    expect(hit.size).toBe(0);
  });

  it("去重：同词多次出现只记一次", () => {
    const hit = coveredWords("ability ability ability", "cet4");
    expect(hit.size).toBe(1);
  });
});

describe("coverageForText", () => {
  it("未掌握 = 命中 ∩ 生词本且 intervalDays < 7（覆盖数含大纲内的功能词）", () => {
    const text = "He would abandon everything for ability.";
    const vocab = [vocabWord("abandon", 0), vocabWord("ability", 7)];
    const stats = coverageForText(text, "cet4", vocab);
    const hit = coveredWords(text, "cet4");
    expect(stats.total).toBe(hit.size);
    expect(hit.has("abandon")).toBe(true);
    expect(hit.has("ability")).toBe(true);
    // 生词本里两个词都命中，ability 已到 7 天视为已掌握
    expect(stats.unmastered).toBe(1);
  });

  it("考研词表命中考研专属词", () => {
    expect(wordInGoalList("embrace", "kaoyan")).toBe(true);
    expect(coveredWords("They embraced the new era.", "kaoyan").has("embrace")).toBe(true);
  });
});
