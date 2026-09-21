import { describe, expect, it } from "vitest";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  difficultyOf,
  lastAssistantText,
  newSpeakSession,
  parseAssistantReply,
  scenarioOf,
  SPEAK_DIFFICULTIES,
  SPEAK_SCENARIOS,
} from "./speakLogic";

describe("场景/难度元数据", () => {
  it("四个场景三档难度齐全", () => {
    expect(SPEAK_SCENARIOS.map((s) => s.id)).toEqual(["ordering", "interview", "travel", "smalltalk"]);
    expect(SPEAK_DIFFICULTIES.map((d) => d.id)).toEqual(["easy", "medium", "hard"]);
  });
  it("非法 id 回落到默认", () => {
    expect(scenarioOf("nope" as never).id).toBe("ordering");
    expect(difficultyOf("nope" as never).id).toBe("medium");
  });
});

describe("newSpeakSession", () => {
  it("开场白是 assistant 第一轮", () => {
    const s = newSpeakSession("ordering", "easy", 1_000);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].role).toBe("assistant");
    expect(s.turns[0].text).toBe(scenarioOf("ordering").opener);
    expect(s.turns[0].hintZh).toBeTruthy();
    expect(s.createdAt).toBe(1_000);
  });
});

describe("buildSpeakSystemPrompt / buildSpeakUserInput", () => {
  it("系统提示带场景角色、难度与两行格式约束", () => {
    const sys = buildSpeakSystemPrompt("interview", "hard");
    expect(sys).toContain("面试官");
    expect(sys).toContain("EN:");
    expect(sys).toContain("ZH:");
    expect(sys).toContain("追问");
  });

  it("用户消息包含近几轮与本轮发言", () => {
    const turns = newSpeakSession("smalltalk", "easy", 1).turns;
    const input = buildSpeakUserInput(turns, "Pretty good, thanks");
    expect(input).toContain("你: " + turns[0].text);
    expect(input).toContain("我: Pretty good, thanks");
  });
});

describe("parseAssistantReply", () => {
  it("标准两行格式", () => {
    const { en, zh } = parseAssistantReply("EN: Sure! One latte coming up. Anything else?\nZH: 好的拿铁马上来，还要别的吗");
    expect(en).toBe("Sure! One latte coming up. Anything else?");
    expect(zh).toBe("好的拿铁马上来，还要别的吗");
  });

  it("剥代码块围栏", () => {
    const { en } = parseAssistantReply("```\nEN: Hi there!\nZH: 你好呀\n```");
    expect(en).toBe("Hi there!");
  });

  it("缺 ZH 行时中文置空", () => {
    const { en, zh } = parseAssistantReply("EN: Just a moment please.");
    expect(en).toBe("Just a moment please.");
    expect(zh).toBe("");
  });

  it("完全没标记时全文当英文（不丢内容）", () => {
    const { en } = parseAssistantReply("Sure, what size would you like?");
    expect(en).toBe("Sure, what size would you like?");
  });

  it("中文冒号也认", () => {
    const { en, zh } = parseAssistantReply("EN：Two sugars?\nZH：要加糖吗");
    expect(en).toBe("Two sugars?");
    expect(zh).toBe("要加糖吗");
  });
});

describe("lastAssistantText", () => {
  it("取最后一个 assistant 轮", () => {
    const turns = [
      { role: "assistant" as const, text: "First", at: 1 },
      { role: "user" as const, text: "ok", at: 2 },
      { role: "assistant" as const, text: "Second", at: 3 },
    ];
    expect(lastAssistantText(turns)).toBe("Second");
    expect(lastAssistantText([])).toBeNull();
  });
});
