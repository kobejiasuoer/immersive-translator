import { describe, expect, it } from "vitest";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  computeCoachDiff,
  difficultyOf,
  lastAssistantText,
  newSpeakSession,
  parseAssistantReply,
  scenarioOf,
  SPEAK_DIFFICULTIES,
  SPEAK_SCENARIOS,
  textHitsTarget,
  type ShadowAttempt,
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

  it("book 语境注入书名/章号/章节摘要与目标词块", () => {
    const sys = buildSpeakSystemPrompt(
      "smalltalk",
      "medium",
      { kind: "book", bookTitle: "The Call of the Wild", chapterArticleId: "a1", chapterIdx: 0, excerpt: ["Buck lived at a big house.", "He ruled the estate."] },
      [
        { word: "nomadic longing", zh: "对远方的向往" },
        { word: "chafing against", zh: "因束缚而焦躁" },
      ],
    );
    expect(sys).toContain("《The Call of the Wild》第 1 章");
    expect(sys).toContain("Buck lived at a big house. He ruled the estate.");
    expect(sys).toContain("nomadic longing（对远方的向往）");
    expect(sys).toContain("chafing against（因束缚而焦躁）");
  });

  it("vocab 语境注入待复习词表并要求情境提问", () => {
    const sys = buildSpeakSystemPrompt(
      "smalltalk",
      "medium",
      { kind: "vocab", wordIds: ["w1", "w2"] },
      [{ word: "unwind", zh: "放松解压" }],
    );
    expect(sys).toContain("生词造句闯关");
    expect(sys).toContain("unwind（放松解压）");
    expect(sys).toContain("用出这些词");
  });

  it("四行格式约束写进系统提示", () => {
    const sys = buildSpeakSystemPrompt("ordering", "easy");
    expect(sys).toContain("BETTER:");
    expect(sys).toContain("TIP:");
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

  it("标准四行格式：BETTER/TIP 解析出来", () => {
    const r = parseAssistantReply(
      "EN: Spot on! How did Buck react?\nZH: 说得准！巴克是什么反应？\nBETTER: Deep in his veins, he still carried a nomadic longing.\nTIP: 用 deep in his veins 替代了中式的 inside his blood。",
    );
    expect(r.en).toBe("Spot on! How did Buck react?");
    expect(r.zh).toBe("说得准！巴克是什么反应？");
    expect(r.better).toBe("Deep in his veins, he still carried a nomadic longing.");
    expect(r.tip).toBe("用 deep in his veins 替代了中式的 inside his blood。");
  });

  it("缺 BETTER/TIP 行时置 undefined（旧两行回复完全兼容）", () => {
    const r = parseAssistantReply("EN: Sure! One latte coming up.\nZH: 好的拿铁马上来");
    expect(r.en).toBe("Sure! One latte coming up.");
    expect(r.zh).toBe("好的拿铁马上来");
    expect(r.better).toBeUndefined();
    expect(r.tip).toBeUndefined();
  });

  it("围栏剥离同样适用于四行回复", () => {
    const r = parseAssistantReply("```\nEN: Hi!\nZH: 你好\nBETTER: Hello there.\nTIP: 更自然。\n```");
    expect(r.en).toBe("Hi!");
    expect(r.better).toBe("Hello there.");
    expect(r.tip).toBe("更自然。");
  });
});

describe("computeCoachDiff", () => {
  it("词级增删保序：del+keep 拼回原话、ins+keep 拼回改写", () => {
    const segs = computeCoachDiff(
      "Because deep inside his blood, he still have the primitive law.",
      "Because deep in his veins, he still carried the primitive law.",
    );
    expect(segs.every((s) => (s.t === "keep" || s.t === "del" || s.t === "ins") && s.v.length > 0)).toBe(true);
    expect(segs.some((s) => s.t === "del")).toBe(true);
    expect(segs.some((s) => s.t === "ins")).toBe(true);
    const originalSide = segs.flatMap((s) => (s.t === "ins" ? [] : s.v.split(" "))).join(" ");
    const betterSide = segs.flatMap((s) => (s.t === "del" ? [] : s.v.split(" "))).join(" ");
    expect(originalSide).toBe("Because deep inside his blood , he still have the primitive law .");
    expect(betterSide).toBe("Because deep in his veins , he still carried the primitive law .");
    // 片段按原文顺序：开头是 keep（Because deep 两边一致）
    expect(segs[0].t).toBe("keep");
    expect(segs[0].v).toContain("Because");
  });

  it("纯插入与纯删除也可表达；相邻同状态片段合并", () => {
    expect(computeCoachDiff("I make an app", "I recently built an app")).toEqual([
      { t: "keep", v: "I" },
      { t: "ins", v: "recently built" },
      { t: "del", v: "make" },
      { t: "keep", v: "an app" },
    ]);
    expect(computeCoachDiff("very very good", "very good")).toEqual([
      { t: "del", v: "very" },
      { t: "keep", v: "very good" },
    ]);
  });

  it("大小写不同仍算同一个词（keep 取改写侧词面）", () => {
    expect(computeCoachDiff("the World", "the world")).toEqual([{ t: "keep", v: "the world" }]);
  });
});

describe("textHitsTarget", () => {
  it("大小写与标点不影响命中", () => {
    expect(textHitsTarget("I felt a Nomadic Longing inside.", "nomadic longing")).toBe(true);
    expect(textHitsTarget("Chafing against the rules, he left.", "chafing against")).toBe(true);
  });

  it("末词容忍常见屈折词形", () => {
    expect(textHitsTarget("I unwind with a book on weekends.", "unwind")).toBe(true);
    expect(textHitsTarget("It helps me unwinding after work.", "unwind")).toBe(true);
    expect(textHitsTarget("She unwinds on Friday.", "unwind")).toBe(true);
    expect(textHitsTarget("He ruled the estate.", "rule")).toBe(true);
  });

  it("子串不算命中（要整词）", () => {
    expect(textHitsTarget("I love understanding this.", "under")).toBe(false);
    expect(textHitsTarget("He was chafing again and again.", "chafing against")).toBe(false);
  });
});

describe("newSpeakSession context 透传与 pron 完整类型", () => {
  it("context 挂到会话；不传时字段缺省", () => {
    const ctx = {
      kind: "book" as const,
      bookTitle: "The Call of the Wild",
      chapterArticleId: "a1",
      chapterIdx: 2,
      excerpt: ["One sentence."],
    };
    const s = newSpeakSession("smalltalk", "medium", 1_000, ctx);
    expect(s.context).toEqual(ctx);
    expect(newSpeakSession("smalltalk", "medium", 1_000).context).toBeUndefined();
  });

  it("user 轮的 pron 复用完整 ShadowAttempt（含必填 at）", () => {
    const pron: ShadowAttempt = {
      at: 1_728_000_000_000,
      total: 3.9,
      accuracy: 4.0,
      fluency: 3.4,
      integrity: 4.6,
      words: [
        {
          content: "world",
          totalScore: 2.6,
          dpMessage: 0,
          sylls: [{ content: "w er l d", syllScore: 2.6, serrMsg: 0, phones: [{ content: "w", dpMessage: 0, gwpp: -0.1 }] }],
        },
      ],
    };
    const turn = { role: "user" as const, text: "the world", at: 1, pron };
    expect(turn.pron?.at).toBe(1_728_000_000_000);
    expect(turn.pron?.words[0].content).toBe("world");
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
