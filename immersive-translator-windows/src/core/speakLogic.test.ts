import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SCENARIO_UPDATED_AT,
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  computeCoachDiff,
  difficultyOf,
  isSpeakScenarioLike,
  lastAssistantText,
  listOfficialScenarios,
  listUserScenarios,
  newSpeakSession,
  parseAssistantReply,
  registerOfficialScenarios,
  registerUserScenarios,
  scenarioOf,
  SPEAK_DIFFICULTIES,
  SPEAK_SCENARIOS,
  textHitsTarget,
  type ShadowAttempt,
  type SpeakScenario,
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

// ---------- A1：内置场景迁移逐字基线（label→title、brief→aiRole） ----------

/** 迁移前（label/brief 版本）真实跑出的 buildSpeakSystemPrompt(id, "easy") 全串
 *  快照（JSON 序列化形态逐字贴入；施工流程：迁移前 console.log 取真值）。
 *  迁移后输出必须与这四条全串相等——system prompt 逐字不变的最后防线。 */
const EXPECTED_PROMPT_EASY = {
  ordering: JSON.parse(
    `"你是用户的英语口语陪练伙伴。场景：在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\\n\\n对话规则：\\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\\n- 回复格式必须严格四行：第一行以 \\"EN: \\" 开头，是你的英文回复；第二行以 \\"ZH: \\" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \\"BETTER: \\" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \\"TIP: \\" 开头，是一句中文点评（点出改写的关键点）。\\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。"`,
  ),
  interview: JSON.parse(
    `"你是用户的英语口语陪练伙伴。场景：英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\\n\\n对话规则：\\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\\n- 回复格式必须严格四行：第一行以 \\"EN: \\" 开头，是你的英文回复；第二行以 \\"ZH: \\" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \\"BETTER: \\" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \\"TIP: \\" 开头，是一句中文点评（点出改写的关键点）。\\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。"`,
  ),
  travel: JSON.parse(
    `"你是用户的英语口语陪练伙伴。场景：旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\\n\\n对话规则：\\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\\n- 回复格式必须严格四行：第一行以 \\"EN: \\" 开头，是你的英文回复；第二行以 \\"ZH: \\" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \\"BETTER: \\" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \\"TIP: \\" 开头，是一句中文点评（点出改写的关键点）。\\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。"`,
  ),
  smalltalk: JSON.parse(
    `"你是用户的英语口语陪练伙伴。场景：朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\\n\\n对话规则：\\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\\n- 回复格式必须严格四行：第一行以 \\"EN: \\" 开头，是你的英文回复；第二行以 \\"ZH: \\" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \\"BETTER: \\" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \\"TIP: \\" 开头，是一句中文点评（点出改写的关键点）。\\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。"`,
  ),
};

describe("内置场景迁移逐字基线（A1：label→title、brief→aiRole，文案一字不动）", () => {
  it("4 内置 title/aiRole/opener/openerZh 硬编码逐字断言", () => {
    const byId = (id: string) => SPEAK_SCENARIOS.find((s) => s.id === id)!;
    // ordering
    expect(byId("ordering").title).toBe("点餐");
    expect(byId("ordering").aiRole).toBe("在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单");
    expect(byId("ordering").opener).toBe("Hi there! Welcome in. What can I get started for you today?");
    expect(byId("ordering").openerZh).toBe("你好，欢迎光临！今天想吃点什么？（试着说：I'd like… / Can I have…）");
    // interview
    expect(byId("interview").title).toBe("面试");
    expect(byId("interview").aiRole).toBe("英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题");
    expect(byId("interview").opener).toBe("Good morning, thanks for coming in. Could you start by telling me a little about yourself?");
    expect(byId("interview").openerZh).toBe("早上好，先做个自我介绍吧。（提示：I'm currently… / I used to work…）");
    // travel
    expect(byId("travel").title).toBe("旅行");
    expect(byId("travel").aiRole).toBe("旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人");
    expect(byId("travel").opener).toBe("Good afternoon! You look a little lost — is there anything I can help you with?");
    expect(byId("travel").openerZh).toBe("下午好！看你想问路？（提示：Excuse me, how can I get to…）");
    // smalltalk
    expect(byId("smalltalk").title).toBe("寒暄");
    expect(byId("smalltalk").aiRole).toBe("朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松");
    expect(byId("smalltalk").opener).toBe("Hey! Long time no see. How has your week been going?");
    expect(byId("smalltalk").openerZh).toBe("嘿，好久不见！这周过得怎么样？（提示：Pretty good, I… / Not bad, just…）");
  });

  it("4 内置 source 均为 builtin、category 按拍板归类、updatedAt 统一基准值", () => {
    const byId = (id: string) => SPEAK_SCENARIOS.find((s) => s.id === id)!;
    for (const s of SPEAK_SCENARIOS) {
      expect(s.source).toBe("builtin");
      expect(s.updatedAt).toBe(BUILTIN_SCENARIO_UPDATED_AT);
      expect(BUILTIN_SCENARIO_UPDATED_AT).toBe(Date.UTC(2026, 0, 1));
    }
    expect(byId("ordering").category).toBe("daily");
    expect(byId("interview").category).toBe("workplace");
    expect(byId("travel").category).toBe("travel");
    expect(byId("smalltalk").category).toBe("daily");
  });

  it("buildSpeakSystemPrompt 4 内置 × easy 全串快照（迁移前后逐字节相等）", () => {
    expect(buildSpeakSystemPrompt("ordering", "easy")).toBe(EXPECTED_PROMPT_EASY.ordering);
    expect(buildSpeakSystemPrompt("interview", "easy")).toBe(EXPECTED_PROMPT_EASY.interview);
    expect(buildSpeakSystemPrompt("travel", "easy")).toBe(EXPECTED_PROMPT_EASY.travel);
    expect(buildSpeakSystemPrompt("smalltalk", "easy")).toBe(EXPECTED_PROMPT_EASY.smalltalk);
  });
});

// ---------- A1：三桶合并查找与回退 ----------

/** 合法场景构造器（合并查找/注册表用例共用；必填字段给默认值，overrides 覆盖）。 */
function makeScenario(overrides: Partial<SpeakScenario> & { id: string }): SpeakScenario {
  return {
    source: "official",
    title: `title-${overrides.id}`,
    category: "daily",
    aiRole: `aiRole-${overrides.id}`,
    opener: `opener-${overrides.id}`,
    updatedAt: 1,
    ...overrides,
  };
}

describe("合并查找与回退（A1 注册表）", () => {
  beforeEach(() => {
    registerOfficialScenarios([]);
    registerUserScenarios([]);
  });

  it("官方桶命中：registerOfficialScenarios 后 scenarioOf 查到 off_demo", () => {
    registerOfficialScenarios([makeScenario({ id: "off_demo", title: "官方演示" })]);
    expect(scenarioOf("off_demo").title).toBe("官方演示");
    expect(scenarioOf("off_demo").source).toBe("official");
  });

  it("用户桶命中：同步来的 usr_xxx 场景可被 resume 查找", () => {
    registerUserScenarios([makeScenario({ id: "usr_uuid-1", source: "user", title: "我的机场值机" })]);
    expect(scenarioOf("usr_uuid-1").title).toBe("我的机场值机");
    expect(scenarioOf("usr_uuid-1").source).toBe("user");
  });

  it("撞车优先级：内置 > official > user", () => {
    // official 注册与内置同 id 的伪造场景 → 内置赢
    registerOfficialScenarios([makeScenario({ id: "ordering", title: "伪造点餐" })]);
    expect(scenarioOf("ordering").title).toBe("点餐");
    // official 与 user 同 id → official 赢
    registerOfficialScenarios([makeScenario({ id: "off_dup", title: "official 版" })]);
    registerUserScenarios([makeScenario({ id: "off_dup", source: "user", title: "user 版" })]);
    expect(scenarioOf("off_dup").title).toBe("official 版");
  });

  it("未知 id 回退第一个内置（注册表非空时同样回退）", () => {
    expect(scenarioOf("nope").id).toBe("ordering");
    registerOfficialScenarios([makeScenario({ id: "off_demo" })]);
    registerUserScenarios([makeScenario({ id: "usr_x", source: "user" })]);
    expect(scenarioOf("nope").id).toBe("ordering");
  });

  it("非法项过滤：缺必填的项不进桶，scenarioOf 走回退", () => {
    registerOfficialScenarios([
      { id: "off_x" } as unknown as SpeakScenario, // 缺 source/title/category/aiRole/opener/updatedAt
      makeScenario({ id: "off_ok" }),
    ]);
    expect(listOfficialScenarios().map((s) => s.id)).toEqual(["off_ok"]);
    expect(scenarioOf("off_x").id).toBe("ordering");
  });

  it("listOfficialScenarios/listUserScenarios 返回注册序；桶内同 id 保留先出现者", () => {
    registerOfficialScenarios([makeScenario({ id: "off_a" }), makeScenario({ id: "off_b" })]);
    registerUserScenarios([
      makeScenario({ id: "usr_1", source: "user" }),
      makeScenario({ id: "usr_2", source: "user" }),
    ]);
    expect(listOfficialScenarios().map((s) => s.id)).toEqual(["off_a", "off_b"]);
    expect(listUserScenarios().map((s) => s.id)).toEqual(["usr_1", "usr_2"]);
    // 桶内同 id：先出现的赢
    registerOfficialScenarios([
      makeScenario({ id: "off_a", title: "第一" }),
      makeScenario({ id: "off_a", title: "第二" }),
    ]);
    expect(listOfficialScenarios()).toHaveLength(1);
    expect(scenarioOf("off_a").title).toBe("第一");
  });

  it("isSpeakScenarioLike：全字段合法 true；缺任一必填/类型错 false；可选项缺失仍 true", () => {
    expect(isSpeakScenarioLike(makeScenario({ id: "off_full", emoji: "🍜", openerZh: "zh" }))).toBe(true);
    // 只给必填（可选项全缺）仍合法
    expect(isSpeakScenarioLike(makeScenario({ id: "off_min" }))).toBe(true);
    // 缺任一必填
    const base = makeScenario({ id: "off_t" });
    for (const key of ["id", "source", "title", "category", "aiRole", "opener", "updatedAt"] as const) {
      const broken: Record<string, unknown> = { ...base };
      delete broken[key];
      expect(isSpeakScenarioLike(broken), `缺 ${key} 应判非法`).toBe(false);
    }
    // 类型错
    expect(isSpeakScenarioLike({ ...base, id: 42 })).toBe(false);
    expect(isSpeakScenarioLike({ ...base, source: "unknown" })).toBe(false);
    expect(isSpeakScenarioLike({ ...base, category: "other" })).toBe(false);
    expect(isSpeakScenarioLike({ ...base, updatedAt: "1767225600000" })).toBe(false);
    // 空串/非对象
    expect(isSpeakScenarioLike({ ...base, title: "" })).toBe(false);
    expect(isSpeakScenarioLike(null)).toBe(false);
    expect(isSpeakScenarioLike("ordering")).toBe(false);
  });
});
