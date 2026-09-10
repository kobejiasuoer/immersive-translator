import { describe, expect, it } from "vitest";
import { splitParagraphs, splitSentences } from "./sentenceSplit";

describe("splitSentences", () => {
  it("按句号切分并保留标点", () => {
    expect(splitSentences("One. Two. Three.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("不切小数点与网址类数字", () => {
    expect(splitSentences("It costs 3.14 dollars. Version 2.0 shipped.")).toEqual([
      "It costs 3.14 dollars.",
      "Version 2.0 shipped.",
    ]);
  });

  it("不切常见缩写", () => {
    expect(splitSentences("Mr. Smith met Dr. Brown. They talked.")).toEqual([
      "Mr. Smith met Dr. Brown.",
      "They talked.",
    ]);
    expect(splitSentences("Compare e.g. apples and pears. Fruit is good.")).toEqual([
      "Compare e.g. apples and pears.",
      "Fruit is good.",
    ]);
  });

  it("问号叹号与省略号收句", () => {
    expect(splitSentences("Really?! Yes... Then what? Next.")).toEqual([
      "Really?!",
      "Yes...",
      "Then what?",
      "Next.",
    ]);
  });

  it("小写开头的后续不算新句", () => {
    expect(splitSentences("He said \"hello. then left. quickly.")).toEqual([
      'He said "hello. then left. quickly.',
    ]);
  });

  it("折叠多余空白", () => {
    expect(splitSentences("A  sentence\n  with  whitespace. Another.")).toEqual([
      "A sentence with whitespace.",
      "Another.",
    ]);
  });

  it("末尾无标点的尾巴成句", () => {
    expect(splitSentences("First. Second without dot")).toEqual([
      "First.",
      "Second without dot",
    ]);
  });
});

describe("splitParagraphs", () => {
  it("按空行分段并编号", () => {
    const result = splitParagraphs("Para one. Two sentences here.\n\nSecond paragraph.");
    expect(result).toHaveLength(2);
    expect(result[0].paragraphIdx).toBe(0);
    expect(result[0].sentences).toEqual(["Para one.", "Two sentences here."]);
    expect(result[1].paragraphIdx).toBe(1);
    expect(result[1].sentences).toEqual(["Second paragraph."]);
  });

  it("单换行也分段", () => {
    const result = splitParagraphs("Line one. More.\nLine two.");
    expect(result).toHaveLength(2);
  });

  it("跳过纯空白段", () => {
    const result = splitParagraphs("Only.  \n\n   \n\nReal.");
    expect(result).toHaveLength(2);
  });

  it("中文段落按句读不成句时整段为一句", () => {
    const result = splitParagraphs("这是一段没有英文句号的中文");
    expect(result[0].sentences).toEqual(["这是一段没有英文句号的中文"]);
  });
});
