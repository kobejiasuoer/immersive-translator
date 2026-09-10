import { describe, it, expect } from "vitest";
import { parseDictResponse, cardToText, splitByWord } from "./dictCard";

const SAMPLE = JSON.stringify({
  word: "resilient",
  phonetics: [
    { label: "UK", value: "rɪˈzɪliənt" },
    { label: "US", value: "rɪˈzɪliənt" },
  ],
  translation: "adj. 有韧性的；适应力强的",
  senses: [
    {
      pos: "adj.",
      gloss: "有弹性的；能快速恢复的",
      examples: [{ s: "The economy proved resilient.", t: "经济展现出韧性。" }],
    },
  ],
  inflections: "n. resilience · adv. resiliently",
  etymology: "re-（回）+ salire（跳）→ 跳回来的 → 有韧性的",
});

describe("parseDictResponse", () => {
  it("parses a clean JSON object", () => {
    const result = parseDictResponse(SAMPLE, "resilient");
    expect(result.kind).toBe("card");
    if (result.kind === "card") {
      expect(result.card.word).toBe("resilient");
      expect(result.card.phonetics).toHaveLength(2);
      expect(result.card.senses[0].examples[0].t).toBe("经济展现出韧性。");
    }
  });

  it("strips markdown code fences", () => {
    const fenced = "```json\n" + SAMPLE + "\n```";
    expect(parseDictResponse(fenced, "resilient").kind).toBe("card");
  });

  it("extracts JSON from surrounding prose", () => {
    const noisy = `好的，这是查询结果：\n${SAMPLE}\n希望对你有帮助！`;
    expect(parseDictResponse(noisy, "resilient").kind).toBe("card");
  });

  it("repairs trailing commas", () => {
    const trailing = `{"word":"test","translation":"测试","senses":[{"pos":"n.","gloss":"试验",}],}`;
    const result = parseDictResponse(trailing, "test");
    expect(result.kind).toBe("card");
  });

  it("returns notAWord for the escape hatch response", () => {
    expect(parseDictResponse('{"error":"not_a_word"}', "hello world")).toEqual({
      kind: "notAWord",
    });
    // 变体容忍
    expect(parseDictResponse('{"error":"not a word"}', "x").kind).toBe("notAWord");
  });

  it("falls back to query word when word is missing", () => {
    const result = parseDictResponse('{"translation":"测试"}', "test");
    expect(result.kind).toBe("card");
    if (result.kind === "card") expect(result.card.word).toBe("test");
  });

  it("normalizes: caps senses at 4, examples at 2, drops empty entries", () => {
    const bloated = {
      translation: "x",
      senses: [
        { gloss: "1", examples: [{ s: "a" }, { s: "b" }, { s: "c" }] },
        { gloss: "", examples: [] },
        { gloss: "3" },
        { gloss: "4" },
        { gloss: "5" },
        { gloss: "6" },
      ],
    };
    const result = parseDictResponse(JSON.stringify(bloated), "q");
    expect(result.kind).toBe("card");
    if (result.kind === "card") {
      expect(result.card.senses).toHaveLength(4);
      expect(result.card.senses[0].examples).toHaveLength(2);
    }
  });

  it("non-string fields are tolerated and coerced", () => {
    const weird = { word: 42, phonetics: "n/a", senses: [{ gloss: "释义", pos: null }] };
    const result = parseDictResponse(JSON.stringify(weird), "q");
    expect(result.kind).toBe("card");
    if (result.kind === "card") {
      expect(result.card.word).toBe("q"); // word 非字符串 → 用查询词兜底
      expect(result.card.phonetics).toEqual([]);
      expect(result.card.senses[0].pos).toBe("");
    }
  });

  it("returns invalid when there is no usable JSON", () => {
    expect(parseDictResponse("这不是 JSON", "test").kind).toBe("invalid");
    expect(parseDictResponse("[1,2,3]", "test").kind).toBe("invalid");
    expect(parseDictResponse("", "test").kind).toBe("invalid");
  });

  it("returns invalid when object has no translation and no senses", () => {
    expect(parseDictResponse('{"word":"x"}', "x").kind).toBe("invalid");
  });
});

describe("cardToText", () => {
  it("formats word, phonetics, senses, examples and extras", () => {
    const result = parseDictResponse(SAMPLE, "resilient");
    if (result.kind !== "card") throw new Error("expected card");
    const text = cardToText(result.card);
    expect(text).toContain("resilient");
    expect(text).toContain("UK /rɪˈzɪliənt/");
    expect(text).toContain("adj. 有韧性的");
    expect(text).toContain("[adj.] 有弹性的");
    expect(text).toContain("- The economy proved resilient. 经济展现出韧性。");
    expect(text).toContain("词形: n. resilience");
    expect(text).toContain("记忆: re-（回）");
  });

  it("omits absent sections", () => {
    const result = parseDictResponse('{"word":"t","translation":"译"}', "t");
    if (result.kind !== "card") throw new Error("expected card");
    const text = cardToText(result.card);
    expect(text).toBe("t\n译");
  });
});

describe("splitByWord", () => {
  it("highlights latin word with boundaries (no substring hits)", () => {
    const parts = splitByWord("The resilient economy was resiliently strong.", "resilient");
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["resilient"]);
    // resiliently 不应命中（后看断言）
  });

  it("matches CJK words without word boundaries", () => {
    const parts = splitByWord("这个方案很有韧性。", "韧性");
    expect(parts.some((p) => p.hit && p.text === "韧性")).toBe(true);
  });

  it("matches the longest token of a phrase first", () => {
    const parts = splitByWord("He took the offer on.", "take on");
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["on"]);
  });

  it("returns a single untouched part when word is empty", () => {
    expect(splitByWord("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("handles no-hit sentences", () => {
    const parts = splitByWord("Nothing here.", "word");
    expect(parts).toEqual([{ text: "Nothing here.", hit: false }]);
  });
});
