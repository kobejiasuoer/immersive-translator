import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildActionSystemPrompt, buildDictionaryPrompt } from "./promptBuilder";
import { parseGlossary } from "./glossaryParser";

describe("buildSystemPrompt", () => {
  it("includes base translation instruction with target language", () => {
    const prompt = buildSystemPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "" });
    expect(prompt).toContain("简体中文");
    expect(prompt).toContain("<text>");
    expect(prompt).toContain("</text>");
  });

  it("falls back to 简体中文 when targetLanguage is empty", () => {
    const prompt = buildSystemPrompt({ targetLanguage: "", customStyle: "", glossaryText: "" });
    expect(prompt).toContain("简体中文");
  });

  it("includes custom style section when provided", () => {
    const prompt = buildSystemPrompt({
      targetLanguage: "English",
      customStyle: "Use natural spoken style",
      glossaryText: "",
    });
    expect(prompt).toContain("User translation style preference");
    expect(prompt).toContain("Use natural spoken style");
  });

  it("omits custom style section when empty", () => {
    const prompt = buildSystemPrompt({ targetLanguage: "English", customStyle: "   ", glossaryText: "" });
    expect(prompt).not.toContain("User translation style preference");
  });

  it("includes glossary section when provided with valid entries", () => {
    const prompt = buildSystemPrompt({
      targetLanguage: "简体中文",
      customStyle: "",
      glossaryText: "hello = 你好\nworld = 世界",
    });
    expect(prompt).toContain("Local glossary");
    expect(prompt).toContain("hello");
    expect(prompt).toContain("你好");
  });

  it("omits glossary section when glossary has no valid entries", () => {
    const prompt = buildSystemPrompt({
      targetLanguage: "简体中文",
      customStyle: "",
      glossaryText: "# just a comment\n\n",
    });
    expect(prompt).not.toContain("Local glossary");
  });

  it("glossary section is capped at MAX_SEND_ENTRIES", () => {
    const many = Array.from({ length: 100 }, (_, i) => `s${i} = t${i}`).join("\n");
    const prompt = buildSystemPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: many });
    const parsed = parseGlossary(many);
    // s79 在前 80 条内会出现，s99 在第 100 条不会出现
    expect(prompt).toContain("s79");
    expect(prompt).not.toContain("s99");
    expect(parsed.toSend).toHaveLength(80);
  });
});

describe("buildActionSystemPrompt", () => {
  const glossaryInput = { targetLanguage: "简体中文", customStyle: "Use formal tone", glossaryText: "hello = 你好" };

  it("polish references source and draft_translation and injects glossary + style", () => {
    const prompt = buildActionSystemPrompt("polish", glossaryInput);
    expect(prompt).toContain("<source>");
    expect(prompt).toContain("<draft_translation>");
    expect(prompt).toContain("Local glossary");
    expect(prompt).toContain("hello -> 你好");
    expect(prompt).toContain("User translation style preference");
    expect(prompt).toContain("Use formal tone");
  });

  it("grammar explains in target language without glossary or style", () => {
    const prompt = buildActionSystemPrompt("grammar", glossaryInput);
    expect(prompt).toContain("简体中文");
    expect(prompt).toContain("<text>");
    expect(prompt).not.toContain("Local glossary");
    expect(prompt).not.toContain("User translation style preference");
  });

  it("summarize caps bullet count and skips glossary", () => {
    const prompt = buildActionSystemPrompt("summarize", glossaryInput);
    expect(prompt).toContain("at most 3");
    expect(prompt).not.toContain("Local glossary");
  });

  it("rephrase asks for 3 numbered alternatives with glossary", () => {
    const prompt = buildActionSystemPrompt("rephrase", glossaryInput);
    expect(prompt).toContain("3 alternative translations");
    expect(prompt).toContain('"1." "2." "3."');
    expect(prompt).toContain("Local glossary");
  });

  it("falls back to 简体中文 when targetLanguage is empty", () => {
    for (const action of ["polish", "grammar", "summarize", "rephrase"] as const) {
      const prompt = buildActionSystemPrompt(action, { targetLanguage: "", customStyle: "", glossaryText: "" });
      expect(prompt).toContain("简体中文");
    }
  });
});

describe("buildDictionaryPrompt", () => {
  it("includes the JSON contract keys and target language", () => {
    const prompt = buildDictionaryPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "" });
    expect(prompt).toContain("dictionary engine");
    expect(prompt).toContain("简体中文");
    for (const key of ['"word"', '"phonetics"', '"translation"', '"senses"', '"inflections"', '"etymology"', '"not_a_word"']) {
      expect(prompt).toContain(key);
    }
  });

  it("caps senses and examples", () => {
    const prompt = buildDictionaryPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "" });
    expect(prompt).toContain("At most 4 senses");
    expect(prompt).toContain("at most 2 short examples");
  });

  it("includes glossary when provided", () => {
    const prompt = buildDictionaryPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "hello = 你好" });
    expect(prompt).toContain("Local glossary");
    expect(prompt).toContain("hello -> 你好");
  });

  it("omits glossary when empty and never injects custom style", () => {
    const prompt = buildDictionaryPrompt({ targetLanguage: "简体中文", customStyle: "用口语风格", glossaryText: "  " });
    expect(prompt).not.toContain("Local glossary");
    expect(prompt).not.toContain("口语风格");
  });

  it("falls back to 简体中文 when targetLanguage is empty", () => {
    const prompt = buildDictionaryPrompt({ targetLanguage: "", customStyle: "", glossaryText: "" });
    expect(prompt).toContain("简体中文");
  });
});
