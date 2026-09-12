import { describe, expect, it } from "vitest";
import {
  buildExamplePrompt,
  buildReaderDictPrompt,
  entryToVocab,
  extractJsonObject,
  extractSelectionText,
  parseExampleResponse,
  parseReaderDictResponse,
} from "./readerDict";

describe("extractSelectionText", () => {
  it("折叠空白并去掉首尾标点引号", () => {
    expect(extractSelectionText("  “Take on momentum,”  ")).toBe("Take on momentum");
    expect(extractSelectionText("settle in.")).toBe("settle in");
  });
  it("空串与超长返回 null", () => {
    expect(extractSelectionText("   ")).toBeNull();
    expect(extractSelectionText("a".repeat(81))).toBeNull();
  });
});

describe("parseReaderDictResponse", () => {
  const RAW = JSON.stringify({
    word: "settle in",
    phonetic: "/ˈsetl ɪn/",
    senses: [
      { pos: "phr. v.", cn: "安顿下来；适应新环境" },
      { pos: "phr. v.", cn: "习惯于" },
    ],
    collocations: [
      { en: "settle into a routine", cn: "进入日常节奏" },
      { en: "settle in for the night", cn: "安顿下来过夜" },
    ],
    forms: ["settled in", "settling in"],
  });

  it("解析完整词条", () => {
    const result = parseReaderDictResponse(RAW);
    expect(result.kind).toBe("entry");
    if (result.kind !== "entry") return;
    expect(result.entry.word).toBe("settle in");
    expect(result.entry.phonetic).toBe("/ˈsetl ɪn/");
    expect(result.entry.senses).toHaveLength(2);
    expect(result.entry.collocations).toHaveLength(2);
    expect(result.entry.forms).toEqual(["settled in", "settling in"]);
  });

  it("剥 markdown 围栏", () => {
    expect(parseReaderDictResponse("```json\n" + RAW + "\n```").kind).toBe("entry");
  });

  it("非词条返回 notAWord", () => {
    expect(parseReaderDictResponse('{"error":"not_a_word"}').kind).toBe("notAWord");
  });

  it("坏 JSON 返回 invalid", () => {
    expect(parseReaderDictResponse("抱歉我不知道").kind).toBe("invalid");
  });

  it("缺 senses 返回 invalid", () => {
    expect(parseReaderDictResponse('{"word":"x"}').kind).toBe("invalid");
  });
});

describe("extractJsonObject", () => {
  it("截取最外层对象，忽略前后废话", () => {
    const obj = extractJsonObject('好的：{"a":1} 以上。');
    expect(obj).toEqual({ a: 1 });
  });
  it("无对象返回 null", () => {
    expect(extractJsonObject("no object here")).toBeNull();
  });
});

describe("entryToVocab", () => {
  it("生成归一化 id 与初始 SRS", () => {
    const now = 1_700_000_000_000;
    const vocab = entryToVocab(
      {
        word: "Settle",
        phonetic: "/ˈsetl/",
        senses: [{ pos: "v.", cn: "安顿" }],
        collocations: [{ en: "settle in", cn: "安顿下来" }],
        forms: ["settled"],
      },
      { articleId: "a1", sentenceIdx: 3 },
      now,
    );
    expect(vocab.id).toBe("settle");
    expect(vocab.source).toEqual({ articleId: "a1", sentenceIdx: 3 });
    expect(vocab.srs.dueAt).toBe(now);
    expect(vocab.srs.reps).toBe(0);
  });
});

describe("buildReaderDictPrompt", () => {
  it("要求 collocations 与 not_a_word 口径", () => {
    const p = buildReaderDictPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "" });
    expect(p).toContain("collocations");
    expect(p).toContain("not_a_word");
  });
});

describe("词块字段（chunkType/pattern/trap）", () => {
  it("多词短语解析并带出词块字段", () => {
    const res = parseReaderDictResponse(
      JSON.stringify({
        word: "take on momentum",
        senses: [{ pos: "搭配", cn: "获得动力" }],
        chunkType: "collocation",
        pattern: "take on sth",
        trap: "make momentum",
      }),
    );
    expect(res.kind).toBe("entry");
    if (res.kind !== "entry") return;
    expect(res.entry.chunkType).toBe("collocation");
    expect(res.entry.pattern).toBe("take on sth");
    expect(res.entry.trap).toBe("make momentum");
  });

  it("非法 chunkType 被丢弃，单词词条不受影响", () => {
    const res = parseReaderDictResponse(
      JSON.stringify({ word: "settle", senses: [{ pos: "v.", cn: "安顿" }], chunkType: "weird" }),
    );
    expect(res.kind).toBe("entry");
    if (res.kind !== "entry") return;
    expect(res.entry.chunkType).toBeUndefined();
  });

  it("entryToVocab：多词自动 kind=chunk 并带词块字段，单词 kind=word", () => {
    const now = 1_700_000_000_000;
    const chunk = entryToVocab(
      {
        word: "take on momentum",
        senses: [{ pos: "搭配", cn: "获得动力" }],
        chunkType: "phrasal",
        pattern: "take on sth",
        trap: "make momentum",
      },
      { articleId: "a1", sentenceIdx: 0 },
      now,
    );
    expect(chunk.kind).toBe("chunk");
    expect(chunk.chunkType).toBe("phrasal");
    expect(chunk.pattern).toBe("take on sth");
    expect(chunk.id).toBe("take on momentum");

    const single = entryToVocab(
      { word: "settle", senses: [{ pos: "v.", cn: "安顿" }] },
      { articleId: "a1", sentenceIdx: 0 },
      now,
    );
    expect(single.kind).toBe("word");
    expect(single.chunkType).toBeUndefined();
  });
});

describe("buildExamplePrompt", () => {
  it("把目标词嵌入提示词（含原形硬约束）", () => {
    const p = buildExamplePrompt("take root", "简体中文");
    expect(p).toContain('"take root"');
    expect(p).toContain("EXACTLY this form");
    expect(p).toContain("简体中文");
  });
});

describe("parseExampleResponse", () => {
  it("解析合法例句对", () => {
    const r = parseExampleResponse('{"en":"These ideas take root slowly.","zh":"这些想法扎根很慢。"}', "take root");
    expect(r).toEqual({ en: "These ideas take root slowly.", zh: "这些想法扎根很慢。" });
  });

  it("例句不含目标词 → null（宁缺勿错）", () => {
    expect(parseExampleResponse('{"en":"Unrelated words here.","zh":"无关"}', "take root")).toBeNull();
  });

  it("缺 en / 非 JSON / 超长 → null", () => {
    expect(parseExampleResponse('{"zh":"只有中文"}', "word")).toBeNull();
    expect(parseExampleResponse("not json", "word")).toBeNull();
    expect(parseExampleResponse(`{"en":"${"x".repeat(240)}"}`, "word")).toBeNull();
  });

  it("zh 缺省 → null（字段可空）", () => {
    expect(parseExampleResponse('{"en":"A word appears here."}', "word")).toEqual({
      en: "A word appears here.",
      zh: null,
    });
  });
});
