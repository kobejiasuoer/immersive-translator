import { describe, expect, it } from "vitest";
import { looksLikeShortDefinition, resolveVocabEntry } from "./vocabEntry";
import type { ReaderDictResult } from "./readerDict";

describe("looksLikeShortDefinition", () => {
  it("短释义可用", () => {
    expect(looksLikeShortDefinition("有弹性的；恢复快的")).toBe(true);
    expect(looksLikeShortDefinition("n. 韧性")).toBe(true);
    expect(looksLikeShortDefinition("resilience")).toBe(true);
  });

  it("整句翻译不可用（含句末终结符）", () => {
    expect(looksLikeShortDefinition("这种材料非常有韧性。")).toBe(false);
    expect(looksLikeShortDefinition("它挺住了！")).toBe(false);
    expect(looksLikeShortDefinition("It works!")).toBe(false);
    expect(looksLikeShortDefinition("这是什么呢？")).toBe(false);
  });

  it("空与超长不可用", () => {
    expect(looksLikeShortDefinition("")).toBe(false);
    expect(looksLikeShortDefinition("   ")).toBe(false);
    expect(looksLikeShortDefinition("释".repeat(41))).toBe(false);
    expect(looksLikeShortDefinition("释".repeat(40))).toBe(true);
  });
});

describe("resolveVocabEntry", () => {
  const entryResult: ReaderDictResult = {
    kind: "entry",
    entry: {
      word: "resilient",
      phonetic: "/rɪˈzɪliənt/",
      senses: [{ pos: "adj.", cn: "有弹性的；恢复快的" }],
    },
  };

  it("词典成功：直接用词条，忽略兜底译文", () => {
    const entry = resolveVocabEntry("resilient", entryResult, "整句译文。不应被采用。");
    expect(entry.word).toBe("resilient");
    expect(entry.phonetic).toBe("/rɪˈzɪliənt/");
    expect(entry.senses).toHaveLength(1);
  });

  it("词典失败 + 短释义形状的兜底译文：用译文当释义", () => {
    const entry = resolveVocabEntry("resilient", null, "有弹性的；恢复快的");
    expect(entry.word).toBe("resilient");
    expect(entry.senses).toEqual([{ pos: "", cn: "有弹性的；恢复快的" }]);
  });

  it("模型判非词条 + 短释义兜底：同样可用", () => {
    const entry = resolveVocabEntry("take on", { kind: "notAWord" }, "承担；呈现");
    expect(entry.word).toBe("take on");
    expect(entry.senses).toEqual([{ pos: "", cn: "承担；呈现" }]);
  });

  it("词典失败 + 整句译文：抛错而不是把整句当释义", () => {
    expect(() => resolveVocabEntry("resilient", null, "这种材料在压力下表现出了极强的韧性。")).toThrow(
      "词典查询失败",
    );
    expect(() => resolveVocabEntry("resilient", null, "")).toThrow("词典查询失败");
  });

  it("词典失败 + 无兜底：抛错", () => {
    expect(() => resolveVocabEntry("resilient", null, "   ")).toThrow("词典查询失败");
  });
});
