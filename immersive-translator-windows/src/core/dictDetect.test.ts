import { describe, it, expect } from "vitest";
import { isLookupText } from "./dictDetect";

describe("isLookupText", () => {
  it("accepts a single english word", () => {
    expect(isLookupText("resilient")).toBe(true);
  });

  it("accepts words with case", () => {
    expect(isLookupText("Hello")).toBe(true);
  });

  it("accepts contractions and possessives", () => {
    expect(isLookupText("don't")).toBe(true);
    expect(isLookupText("it's")).toBe(true);
  });

  it("accepts hyphenated words", () => {
    expect(isLookupText("well-known")).toBe(true);
    expect(isLookupText("state-of-the-art")).toBe(true);
  });

  it("accepts short phrases up to 4 tokens", () => {
    expect(isLookupText("take on")).toBe(true);
    expect(isLookupText("in the wake of")).toBe(true);
  });

  it("rejects phrases with more than 4 tokens", () => {
    expect(isLookupText("as a matter of fact")).toBe(false);
  });

  it("rejects sentences and sentence punctuation", () => {
    expect(isLookupText("The economy proved resilient.")).toBe(false);
    expect(isLookupText("What does it mean?")).toBe(false);
    expect(isLookupText("hello, world")).toBe(false);
  });

  it("rejects multiline text", () => {
    expect(isLookupText("resilient\nresilient")).toBe(false);
  });

  it("rejects urls, paths, emails", () => {
    expect(isLookupText("https://example.com")).toBe(false);
    expect(isLookupText("src/core/dictDetect.ts")).toBe(false);
    expect(isLookupText("user@example.com")).toBe(false);
    expect(isLookupText("C:\\Windows")).toBe(false);
  });

  it("tolerates camelCase identifiers as words (模型兜底/手动切换负责纠正)", () => {
    // 全字母 token 会通过启发式；误判由 not_a_word 响应与手动切换兜底
    expect(isLookupText("getCurrentWindow")).toBe(true);
  });

  it("rejects pure numbers and empty text", () => {
    expect(isLookupText("2024")).toBe(false);
    expect(isLookupText("3 14")).toBe(false);
    expect(isLookupText("   ")).toBe(false);
    expect(isLookupText("")).toBe(false);
  });

  it("rejects overly long input", () => {
    expect(isLookupText("a".repeat(41))).toBe(false);
    expect(isLookupText("a".repeat(40))).toBe(true);
  });

  it("accepts short CJK words within the length cap", () => {
    expect(isLookupText("韧性")).toBe(true);
    expect(isLookupText("机器学习")).toBe(true);
    expect(isLookupText("塞翁失马焉知非福")).toBe(false); // 8 字超上限
  });

  it("caps CJK length at 6 chars", () => {
    expect(isLookupText("一心一意")).toBe(true);
    expect(isLookupText("不管三七二十一")).toBe(false);
  });

  it("rejects CJK with punctuation or mixed scripts", () => {
    expect(isLookupText("你好，世界")).toBe(false);
    expect(isLookupText("iPhone手机")).toBe(false);
    expect(isLookupText("学习 ing")).toBe(false);
  });

  it("accepts kana, hangul and cyrillic words", () => {
    expect(isLookupText("すし")).toBe(true);
    expect(isLookupText("스시")).toBe(true);
    expect(isLookupText("привет")).toBe(true);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(isLookupText("  resilient \n")).toBe(true);
  });
});
