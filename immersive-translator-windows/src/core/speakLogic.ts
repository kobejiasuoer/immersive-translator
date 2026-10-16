/**
 * 口语陪练 MVP 的纯逻辑层（R3）：场景/难度元数据、对话 prompt、回复解析、
 * 会话数据类型。
 *
 * 会话类型同时是 Rust speak_store.rs 的存储格式（camelCase）与
 * contracts/reading-room.schema.json 的 speakSession 定义，改动需三处同步。
 * 对话轮：用户说（ASR 英文转写）→ AI 回复（1-3 句口语英文 + 一行中文提示）
 * → 可选跟读（ISE 报告挂 assistant 轮）。SRS/生词数据不经过这里。
 */

import type { WordScore } from "./pronunciation";

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

/** 一次跟读评测的完整结果（5 分制；words 是讯飞识别词序列，含音节/音素）。 */
export interface ShadowAttempt {
  at: number;
  total: number;
  accuracy: number;
  fluency: number;
  /** 完整度（篇章层；漏读/增读拉低）。 */
  integrity: number;
  words: WordScore[];
}

/** 表达改进对比的一个片段：keep=保留 / del=用户原话里删掉 / ins=地道改写新加。 */
export interface CoachSeg {
  t: "keep" | "del" | "ins";
  v: string;
}

/** 用户一轮发言的表达改进建议（BETTER 改写的词级增删对比 + TIP 点评）。 */
export interface CoachDiff {
  segs: CoachSeg[];
  note?: string;
}

/**
 * 会话语境（v0.8 场景中心）：book=聊刚读的章节，vocab=生词造句闯关。
 * 场景枚举 SpeakScenarioId 保持四值不动（Rust 闭枚举整文件兼容），新场景
 * 由这个可选字段承载，老会话无 context 原样可读。
 */
export type SpeakSessionContext =
  | {
      kind: "book";
      bookTitle: string;
      chapterArticleId: string;
      chapterIdx: number;
      /** 章节开头摘要（前几句英文），注入系统提示给 LLM 当剧情上下文。 */
      excerpt: string[];
    }
  | {
      kind: "vocab";
      /** 待复习生词 id 列表（词面由调用方随 targets 传给提示构造）。 */
      wordIds: string[];
    };

/** 送进系统提示的目标词（词面 + 一句中文义）。 */
export interface SpeakContextTarget {
  word: string;
  zh: string;
}

/** 一轮对话。user.text 是 ASR 转写；assistant.text 是英文回复。 */
export interface SpeakTurn {
  role: "user" | "assistant";
  text: string;
  /** assistant 轮的中文提示（这句意思 + 怎么接话）。 */
  hintZh?: string;
  /** 兼容字段：最新一次跟读总分（旧版客户端/列表预览用）。 */
  shadowScore?: number;
  /** 跟读报告历史（最新在末尾）；旧会话无此字段。 */
  shadowAttempts?: ShadowAttempt[];
  /** user 轮：本轮发言的发音评测（同一录音送 ISE；凭据缺失/失败时缺省）。 */
  pron?: ShadowAttempt;
  /** user 轮：表达改进建议（LLM 的 BETTER/TIP 两行落盘）；旧会话无此字段。 */
  coachDiff?: CoachDiff;
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
  /** 会话语境（v0.8）：book/vocab 场景的额外上下文；老会话无此字段。 */
  context?: SpeakSessionContext;
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
  context?: SpeakSessionContext,
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
    ...(context ? { context } : {}),
  };
}

// ---------- LLM 对话 ----------

/** 送 LLM 的系统提示：场景角色 + 严格的 EN/ZH/BETTER/TIP 四行格式 + 可选会话语境。 */
export function buildSpeakSystemPrompt(
  scenario: SpeakScenarioId,
  difficulty: SpeakDifficulty,
  context?: SpeakSessionContext,
  targets?: SpeakContextTarget[],
): string {
  const sc = scenarioOf(scenario);
  const diff = difficultyOf(difficulty);
  const lines = [
    `你是用户的英语口语陪练伙伴。场景：${sc.brief}。难度：${diff.note}。`,
  ];
  if (context?.kind === "book") {
    const excerpt = context.excerpt.join(" ").trim();
    lines.push(
      `本次对话语境：用户刚读完《${context.bookTitle}》第 ${context.chapterIdx + 1} 章。` +
        (excerpt ? `章节开头摘要：${excerpt}` : ""),
    );
    lines.push("围绕这一章的情节、人物或主题与用户讨论，提问时自然引导用户用出下面这些目标词块。");
    if (targets && targets.length > 0) {
      lines.push(`目标词块（诱导用户在回答中自然用出）：${targets.map((t) => `${t.word}（${t.zh}）`).join("、")}。`);
    }
  } else if (context?.kind === "vocab") {
    lines.push("本次对话语境：生词造句闯关。");
    if (targets && targets.length > 0) {
      lines.push(
        `待复习词表：${targets.map((t) => `${t.word}（${t.zh}）`).join("、")}。` +
          "出生活化情境的提问，诱导用户在回答里用出这些词；用户用对就算过关，及时给正面反馈。",
      );
    }
  }
  lines.push(
    "",
    "对话规则：",
    "- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。",
    `- 回复格式必须严格四行：第一行以 "EN: " 开头，是你的英文回复；第二行以 "ZH: " 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 "BETTER: " 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 "TIP: " 开头，是一句中文点评（点出改写的关键点）。`,
    "- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。",
    "- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
  );
  return lines.join("\n");
}

/** 送 LLM 的用户消息：近几轮对话记录 + 本轮用户发言。 */
export function buildSpeakUserInput(turns: SpeakTurn[], userText: string): string {
  const recent = turns.slice(-12);
  const lines = recent.map((t) =>
    t.role === "user" ? `我: ${t.text}` : `你: ${t.text}`,
  );
  lines.push(`我: ${userText}`);
  return ["对话记录（最新在下）：", ...lines, "", "请给出你的下一轮回复（EN: / ZH: / BETTER: / TIP: 四行）。"].join("\n");
}

/** parseAssistantReply 的返回：better/tip 缺行时为 undefined（旧两行回复完全兼容）。 */
export interface ParsedAssistantReply {
  en: string;
  zh: string;
  /** 用户发言的地道改写（BETTER 行）；模型没给时 undefined。 */
  better?: string;
  /** 一句中文点评（TIP 行）；模型没给时 undefined。 */
  tip?: string;
}

/**
 * 解析模型回复为 { en, zh, better?, tip? }。宽容处理：剥代码块围栏；找不到
 * "ZH:" 时中文提示置空；整段没有 EN: 标记时把全文当英文回复（不丢内容）。
 * BETTER/TIP 行缺失时置 undefined（老两行格式的回复照常解析）。
 */
export function parseAssistantReply(raw: string): ParsedAssistantReply {
  let text = raw.trim();
  // 剥 ``` 围栏（模型偶尔手滑）
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "").trim();
  const enMatch = text.match(/(?:^|\n)\s*EN[:：]\s*([\s\S]*?)(?=\n\s*(?:ZH|BETTER|TIP)[:：]|$)/i);
  const zhMatch = text.match(/(?:^|\n)\s*ZH[:：]\s*([\s\S]*?)(?=\n\s*(?:BETTER|TIP)[:：]|$)/i);
  const betterMatch = text.match(/(?:^|\n)\s*BETTER[:：]\s*([\s\S]*?)(?=\n\s*(?:ZH|TIP)[:：]|$)/i);
  const tipMatch = text.match(/(?:^|\n)\s*TIP[:：]\s*([\s\S]*?)$/i);
  const en = (enMatch ? enMatch[1] : text.replace(/(?:^|\n)\s*(?:ZH|BETTER|TIP)[:：][\s\S]*$/i, ""))
    .replace(/\s+/g, " ")
    .trim();
  const zh = (zhMatch ? zhMatch[1] : "").replace(/\s+/g, " ").trim();
  const better = betterMatch ? betterMatch[1].replace(/\s+/g, " ").trim() : undefined;
  const tip = tipMatch ? tipMatch[1].replace(/\s+/g, " ").trim() : undefined;
  const out: ParsedAssistantReply = { en, zh };
  if (better) out.better = better;
  if (tip) out.tip = tip;
  return out;
}

/** 表达改进对比的词级 token 化（对齐 recallJudge.wordDiff 的切词思路）：
 * 单词（含词中撇号/连字符，don't / long-term 不拆）与标点各算一个 token。 */
function diffTokens(s: string): string[] {
  return s.match(/[A-Za-z0-9'’-]+|[.,!?;:()"]/g) ?? [];
}

/**
 * 用户原话与地道改写的词级增删对比（LCS 对齐）：
 * keep=两边都有；del=只出现在用户原话（建议删掉）；ins=只出现在改写（建议这样说）。
 * 保持两边各自的词序，相邻同状态片段合并。
 */
export function computeCoachDiff(original: string, better: string): CoachSeg[] {
  const a = diffTokens(original);
  const b = diffTokens(better);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] =
        a[i - 1].toLowerCase() === b[j - 1].toLowerCase()
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const rev: CoachSeg[] = [];
  let i = m;
  let j = n;
  const push = (t: CoachSeg["t"], v: string) => {
    const last = rev[0];
    if (last && last.t === t) last.v = `${v} ${last.v}`;
    else rev.unshift({ t, v });
  };
  while (i > 0 && j > 0) {
    if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
      push("keep", b[j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      push("del", a[i - 1]);
      i -= 1;
    } else {
      push("ins", b[j - 1]);
      j -= 1;
    }
  }
  while (i > 0) {
    push("del", a[i - 1]);
    i -= 1;
  }
  while (j > 0) {
    push("ins", b[j - 1]);
    j -= 1;
  }
  return rev;
}

/**
 * 用户发言是否命中目标词/词块（归一化判定）：大小写不敏感、忽略标点；
 * 目标末词容忍常见屈折后缀（unwind → unwinding/unwinds、rule → ruled 等），
 * 供 SRS 自动过关与目标 chips 打勾。
 */
export function textHitsTarget(userText: string, targetWord: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9'\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const textTokens = norm(userText).split(" ").filter(Boolean);
  const targetTokens = norm(targetWord).split(" ").filter(Boolean);
  if (textTokens.length === 0 || targetTokens.length === 0) return false;
  const SUFFIXES = ["s", "es", "ed", "d", "ing", "ings"];
  const isInflected = (word: string, base: string) => {
    if (word === base) return true;
    for (const suf of SUFFIXES) {
      if (word === base + suf) return true;
    }
    // 去 e 加 ing（make → making）等
    if (base.endsWith("e") && word === base.slice(0, -1) + "ing") return true;
    return false;
  };
  const n = targetTokens.length;
  for (let i = 0; i + n <= textTokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      const base = targetTokens[j];
      const word = textTokens[i + j];
      // 中间的词须原样（大小写/标点已归一）；只有末词容忍屈折
      if (j === n - 1 ? !isInflected(word, base) : word !== base) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** 会话最近的 assistant 英文（跟读参考文本用）。 */
export function lastAssistantText(turns: SpeakTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "assistant" && turns[i].text.trim()) return turns[i].text;
  }
  return null;
}
