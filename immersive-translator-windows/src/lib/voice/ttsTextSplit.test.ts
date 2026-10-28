import { describe, expect, it } from "vitest";
import { splitTtsText, utf8ByteLength, TTS_MAX_TEXT_BYTES, TTS_SPLIT_MAX_BYTES } from "./ttsTextSplit";

/** 致命解码:出现孤立代理对/非法 UTF-8 会 throw,用来验证多字节字符不被截断。 */
function assertValidUtf8(piece: string): void {
  const bytes = new TextEncoder().encode(piece);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
}

describe("splitTtsText(契约:单次 <8000 UTF-8 字节,超长按句拆分)", () => {
  it("短文本原样单片段;纯空白返回空数组", () => {
    expect(splitTtsText("Hello world.")).toEqual(["Hello world."]);
    expect(splitTtsText("   \n\t ")).toEqual([]);
    expect(TTS_SPLIT_MAX_BYTES).toBeLessThan(TTS_MAX_TEXT_BYTES);
  });

  it("按句边界贪心打包:每片不超上限,join 还原原文,顺序保持", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(300); // 46 字节/句 ×300 ≈ 13.8KB
    const pieces = splitTtsText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(utf8ByteLength(piece)).toBeLessThanOrEqual(TTS_SPLIT_MAX_BYTES);
      assertValidUtf8(piece);
    }
    expect(pieces.join("")).toBe(text.trim());
  });

  it("中文长文本(3 字节/字)按句切分不超字节上限", () => {
    const text = "沉浸式翻译是一款双语对照翻译工具。它支持网页翻译与文档翻译。语音功能正在内测中。".repeat(200);
    const pieces = splitTtsText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(utf8ByteLength(piece)).toBeLessThanOrEqual(TTS_SPLIT_MAX_BYTES);
    }
    expect(pieces.join("")).toBe(text);
  });

  it("无标点超长句在码点边界硬切,多字节字符/emoji 不被腰斩", () => {
    // 中文 3 字节:2700 字 ≈ 8100 字节,单句超限;尾部放 emoji(4 字节代理对)踩边界。
    const body = "译".repeat(2700);
    const text = `${body}\u{1F600}`;
    const pieces = splitTtsText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(utf8ByteLength(piece)).toBeLessThanOrEqual(TTS_SPLIT_MAX_BYTES);
      assertValidUtf8(piece); // 孤立代理对会在此失败
    }
    expect(pieces.join("")).toBe(text);
  });

  it("emoji 紧贴切分边界:每片都是合法 UTF-8(fatal 解码不抛)", () => {
    // 每组 4 字节,叠到上限附近,迫使硬切点落在 emoji 附近
    const text = "\u{1F600}".repeat(2100); // 8400 字节,无标点单句
    const pieces = splitTtsText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) assertValidUtf8(piece);
    expect(pieces.join("")).toBe(text);
  });

  it("换行也是句界(中英混排);连续终结符归前句", () => {
    const text = `${"a".repeat(4000)}?!${"b".repeat(4000)}…`;
    const pieces = splitTtsText(text);
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.endsWith("?!")).toBe(true);
    expect(pieces[1]!.endsWith("…")).toBe(true);
  });

  it("自定义上限生效(拆得更细)", () => {
    const text = "first sentence. second sentence. third sentence.";
    const pieces = splitTtsText(text, 20);
    for (const piece of pieces) expect(utf8ByteLength(piece)).toBeLessThanOrEqual(20);
    expect(pieces.join("")).toBe(text);
  });
});
