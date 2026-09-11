import { describe, expect, it } from "vitest";
import {
  buildArticleFromText,
  countWords,
  detectTitleFromText,
  normalizeWordKey,
} from "./articleBuilder";

const SAMPLE = `The Speed of Reading

Reading speed was the goal, and comprehension was the test. Researchers
measured how fast volunteers could move through a text.

The results surprised everyone involved.`;

describe("buildArticleFromText", () => {
  it("首行短且无句号时作为标题，不进正文", () => {
    const article = buildArticleFromText(SAMPLE);
    expect(article).not.toBeNull();
    expect(article!.title).toBe("The Speed of Reading");
    expect(article!.sentences[0].en).toBe(
      "Reading speed was the goal, and comprehension was the test.",
    );
    expect(article!.titleCnState).toBe("pending");
  });

  it("无标题时取第一句当标题", () => {
    const article = buildArticleFromText("First sentence goes here. Second one.");
    expect(article!.title).toBe("First sentence goes here.");
    expect(article!.sentences).toHaveLength(2);
    expect(article!.sentences[0].en).toBe("First sentence goes here.");
  });

  it("句对 idx 连续、paragraphIdx 正确", () => {
    const article = buildArticleFromText(SAMPLE);
    const idxs = article!.sentences.map((s) => s.idx);
    expect(idxs).toEqual(idxs.map((_, i) => i));
    expect(article!.sentences[2].paragraphIdx).toBe(1);
    expect(article!.sentences.every((s) => s.zh === null && s.zhState === "pending")).toBe(true);
  });

  it("字数统计包含正文不包含标题", () => {
    const article = buildArticleFromText(SAMPLE);
    expect(article!.wordCount).toBe(
      countWords(
        "Reading speed was the goal, and comprehension was the test. Researchers\nmeasured how fast volunteers could move through a text.\n\nThe results surprised everyone involved.",
      ),
    );
  });

  it("空文本返回 null", () => {
    expect(buildArticleFromText("   \n  ")).toBeNull();
  });

  it("显式标题与识别首行相同时，首行仍不进正文", () => {
    const article = buildArticleFromText(SAMPLE, { title: "The Speed of Reading" });
    expect(article!.title).toBe("The Speed of Reading");
    expect(article!.sentences[0].en).toBe(
      "Reading speed was the goal, and comprehension was the test.",
    );
  });

  it("显式标题与首行不同时，整段进正文、标题原样采用", () => {
    const article = buildArticleFromText("Hotels and OTAs are not fooling anybody.", {
      title: "我的读书笔记",
    });
    expect(article!.title).toBe("我的读书笔记");
    expect(article!.sentences[0].en).toBe("Hotels and OTAs are not fooling anybody.");
  });

  it("显式标题为空白时回落到自动识别", () => {
    const article = buildArticleFromText(SAMPLE, { title: "   " });
    expect(article!.title).toBe("The Speed of Reading");
  });
});

describe("detectTitleFromText", () => {
  it("首行短且无句末标点时返回首行", () => {
    expect(detectTitleFromText(SAMPLE)).toBe("The Speed of Reading");
  });
  it("首行带句末标点或超长时返回 null", () => {
    expect(detectTitleFromText("First sentence goes here. Second one.")).toBeNull();
    expect(detectTitleFromText("a".repeat(81))).toBeNull();
  });
  it("空文本返回 null", () => {
    expect(detectTitleFromText("  ")).toBeNull();
  });
});

describe("countWords", () => {
  it("英文按空白计词", () => {
    expect(countWords("one two three")).toBe(3);
  });
  it("中文字符折算", () => {
    expect(countWords("一二三四五")).toBe(3);
  });
});

describe("normalizeWordKey", () => {
  it("小写并去掉首尾标点", () => {
    expect(normalizeWordKey("  “Settle,” ")).toBe("settle");
    expect(normalizeWordKey("Don't")).toBe("don't");
    expect(normalizeWordKey("take-on")).toBe("take-on");
  });
});
