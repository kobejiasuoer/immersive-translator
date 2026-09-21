/**
 * 口语陪练 MVP 的纯逻辑层（R3）：场景/难度元数据、对话 prompt、回复解析、
 * 会话数据类型。
 *
 * 会话类型同时是 Rust speak_store.rs 的存储格式（camelCase）与
 * contracts/reading-room.schema.json 的 speakSession 定义，改动需三处同步。
 * 对话轮：用户说（ASR 英文转写）→ AI 回复（1-3 句口语英文 + 一行中文提示）
 * → 可选跟读（ISE 打分挂在 assistant 轮上）。SRS/生词数据不经过这里。
 */

export const SPEAK_SCHEMA_VERSION = 1;

export type SpeakScenarioId = "ordering" | "interview" | "travel" | "smalltalk";
export type SpeakDifficulty = "easy" | "medium" | "hard";

export interface SpeakScenario {
  id: SpeakScenarioId;
  label: string;
  emoji: string;
  /** LLM 的场景角色设定（你扮演…）。 */
  brief: string;
  /** 开场白（AI 第一轮，避免用户先开口冷启动）。 */
  opener: string;
  openerZh: string;
}

export const SPEAK_SCENARIOS: SpeakScenario[] = [
  {
    id: "ordering",
    label: "点餐",
    emoji: "🍜",
    brief: "在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单",
    opener: "Hi there! Welcome in. What can I get started for you today?",
    openerZh: "你好，欢迎光临！今天想吃点什么？（试着说：I'd like… / Can I have…）",
  },
  {
    id: "interview",
    label: "面试",
    emoji: "💼",
    brief: "英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题",
    opener: "Good morning, thanks for coming in. Could you start by telling me a little about yourself?",
    openerZh: "早上好，先做个自我介绍吧。（提示：I'm currently… / I used to work…）",
  },
  {
    id: "travel",
    label: "旅行",
    emoji: "✈️",
    brief: "旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人",
    opener: "Good afternoon! You look a little lost — is there anything I can help you with?",
    openerZh: "下午好！看你想问路？（提示：Excuse me, how can I get to…）",
  },
  {
    id: "smalltalk",
    label: "寒暄",
    emoji: "☕️",
    brief: "朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松",
    opener: "Hey! Long time no see. How has your week been going?",
    openerZh: "嘿，好久不见！这周过得怎么样？（提示：Pretty good, I… / Not bad, just…）",
  },
];

export const SPEAK_DIFFICULTIES: { id: SpeakDifficulty; label: string; note: string }[] = [
  { id: "easy", label: "轻松", note: "用最简单的词汇和短句，放慢节奏，多给鼓励" },
  { id: "medium", label: "日常", note: "日常口语表达，正常语速" },
  { id: "hard", label: "进阶", note: "表达丰富地道，可以自然追问细节，接近母语者" },
];

export function scenarioOf(id: SpeakScenarioId): SpeakScenario {
  return SPEAK_SCENARIOS.find((s) => s.id === id) ?? SPEAK_SCENARIOS[0];
}

export function difficultyOf(id: SpeakDifficulty): { id: SpeakDifficulty; label: string; note: string } {
  return SPEAK_DIFFICULTIES.find((d) => d.id === id) ?? SPEAK_DIFFICULTIES[1];
}

/** 一轮对话。user.text 是 ASR 转写；assistant.text 是英文回复。 */
export interface SpeakTurn {
  role: "user" | "assistant";
  text: string;
  /** assistant 轮的中文提示（这句意思 + 怎么接话）。 */
  hintZh?: string;
  /** assistant 轮的跟读得分（5 分制 ISE；null/缺省 = 没测）。 */
  shadowScore?: number;
  at: number;
}

/** 一次陪练会话（本地保存，可重开上次对话）。 */
export interface SpeakSession {
  id: string;
  scenario: SpeakScenarioId;
  difficulty: SpeakDifficulty;
  turns: SpeakTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface SpeakSessionsFile {
  schemaVersion: number;
  sessions: SpeakSession[];
}

export function newSpeakSessionId(now = Date.now()): string {
  return `s${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function newSpeakSession(
  scenario: SpeakScenarioId,
  difficulty: SpeakDifficulty,
  now = Date.now(),
): SpeakSession {
  return {
    id: newSpeakSessionId(now),
    scenario,
    difficulty,
    turns: [
      {
        role: "assistant",
        text: scenarioOf(scenario).opener,
        hintZh: scenarioOf(scenario).openerZh,
        at: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------- LLM 对话 ----------

/** 送 LLM 的系统提示：场景角色 + 严格的 EN/ZH 两行格式。 */
export function buildSpeakSystemPrompt(scenario: SpeakScenarioId, difficulty: SpeakDifficulty): string {
  const sc = scenarioOf(scenario);
  const diff = difficultyOf(difficulty);
  return [
    `你是用户的英语口语陪练伙伴。场景：${sc.brief}。难度：${diff.note}。`,
    "",
    "对话规则：",
    "- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。",
    `- 回复格式必须严格两行：第一行以 "EN: " 开头，是你的英文回复；第二行以 "ZH: " 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）。`,
    "- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。",
    "- 不要输出这两行以外的任何内容（不要代码块、不要解释）。",
  ].join("\n");
}

/** 送 LLM 的用户消息：近几轮对话记录 + 本轮用户发言。 */
export function buildSpeakUserInput(turns: SpeakTurn[], userText: string): string {
  const recent = turns.slice(-12);
  const lines = recent.map((t) =>
    t.role === "user" ? `我: ${t.text}` : `你: ${t.text}`,
  );
  lines.push(`我: ${userText}`);
  return ["对话记录（最新在下）：", ...lines, "", "请给出你的下一轮回复（EN: + ZH: 两行）。"].join("\n");
}

/**
 * 解析模型回复为 { en, zh }。宽容处理：剥代码块围栏；找不到 "ZH:" 时
 * 中文提示置空；整段没有 EN: 标记时把全文当英文回复（不丢内容）。
 */
export function parseAssistantReply(raw: string): { en: string; zh: string } {
  let text = raw.trim();
  // 剥 ``` 围栏（模型偶尔手滑）
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "").trim();
  const enMatch = text.match(/(?:^|\n)\s*EN[:：]\s*([\s\S]*?)(?=\n\s*ZH[:：]|$)/i);
  const zhMatch = text.match(/(?:^|\n)\s*ZH[:：]\s*([\s\S]*)$/i);
  const en = (enMatch ? enMatch[1] : text.replace(/(?:^|\n)\s*ZH[:：][\s\S]*$/i, ""))
    .replace(/\s+/g, " ")
    .trim();
  const zh = (zhMatch ? zhMatch[1] : "").replace(/\s+/g, " ").trim();
  return { en, zh };
}

/** 会话最近的 assistant 英文（跟读参考文本用）。 */
export function lastAssistantText(turns: SpeakTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "assistant" && turns[i].text.trim()) return turns[i].text;
  }
  return null;
}
