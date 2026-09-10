import { describe, expect, it } from "vitest";
import {
  buildReaderDictPrompt,
  entryToVocab,
  extractJsonObject,
  extractSelectionText,
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
