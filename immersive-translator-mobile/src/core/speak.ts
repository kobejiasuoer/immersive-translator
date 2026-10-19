/**
 * 口语陪练纯逻辑层（B1）—— 场景/难度元数据、对话 prompt、回复解析的唯一出处，
 * 供 SpeakChat（B1）/ 结束摘要（B4）/ 学习笔记（B7）消费。
 * 口径逐句对齐 mac/Sources/ReaderCore/SpeakLogic.swift（v3 同源）：
 *  · 场景/开场白 :44-67 · 难度 :76-80 · system prompt :333-345
 *  · 用户消息包装 :348-355 · 回复宽容解析 :359-385
 * 会话级总结 prompt 为 mobile 新设计（Mac 无参考，见 buildSummaryPrompt）。
 * 轮次类型沿用 demo.ts 的 ChatTurn（store/sheets 仍从该处 import，未迁移）：
 * who "me" = 用户（ASR 转写），who "ai" = 陪练回复（en + 可选 zh 中文提示）。
 */
import type { ChatTurn } from "./demo";

export type SpeakSceneId = "ordering" | "interview" | "travel" | "smalltalk";
export type SpeakDifficulty = "easy" | "medium" | "hard";

export interface SpeakSceneMeta {
  id: SpeakSceneId;
  label: string;
  emoji: string;
  /** LLM 的场景角色设定（你扮演…）。 */
  brief: string;
  /** 开场白（AI 第一轮，避免用户先开口冷启动）。 */
  opener: string;
  openerZh: string;
}

/** 四场景元数据（brief/opener/openerZh 逐句照抄 SpeakLogic.swift:44-67）。 */
export const SPEAK_SCENE_META: SpeakSceneMeta[] = [
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

export interface SpeakDifficultyInfo {
  id: SpeakDifficulty;
  label: string;
  note: string;
}

/** 三难度（note 逐句照抄 SpeakLogic.swift:76-80）。 */
export const SPEAK_DIFFICULTIES: SpeakDifficultyInfo[] = [
  { id: "easy", label: "轻松", note: "用最简单的词汇和短句，放慢节奏，多给鼓励" },
  { id: "medium", label: "日常", note: "日常口语表达，正常语速" },
  { id: "hard", label: "进阶", note: "表达丰富地道，可以自然追问细节，接近母语者" },
];

export function sceneMetaOf(id: string): SpeakSceneMeta {
  return SPEAK_SCENE_META.find((s) => s.id === id) ?? SPEAK_SCENE_META[0];
}

export function difficultyInfoOf(id: SpeakDifficulty): SpeakDifficultyInfo {
  return SPEAK_DIFFICULTIES.find((d) => d.id === id) ?? SPEAK_DIFFICULTIES[0];
}

/* ---------- LLM 对话 prompt ---------- */

/** 送 LLM 的系统提示：场景角色 + 严格的 EN/ZH 两行格式（逐句照 SpeakLogic.swift:333-345）。 */
export function buildSpeakSystemPrompt(scene: SpeakSceneId, diff: SpeakDifficulty): string {
  const sc = sceneMetaOf(scene);
  const d = difficultyInfoOf(diff);
  return [
    `你是用户的英语口语陪练伙伴。场景：${sc.brief}。难度：${d.note}。`,
    "",
    "对话规则：",
    "- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。",
    '- 回复格式必须严格两行：第一行以 "EN: " 开头，是你的英文回复；第二行以 "ZH: " 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）。',
    "- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。",
    "- 不要输出这两行以外的任何内容（不要代码块、不要解释）。",
  ].join("\n");
}

/**
 * 送 LLM 的用户消息：最近 12 轮对话记录 + 本轮用户发言（包装语照 SpeakLogic.swift:348-355）。
 * 调用约定：turns 传「本轮之前」的历史（不含 userText 本身），userText 由包装语单列最后一行，
 * 避免最新一句在记录里重复出现两次。
 */
export function buildSpeakUserInput(turns: ChatTurn[], userText: string): string {
  const recent = turns.slice(-12);
  const lines = recent.map((t) => (t.who === "me" ? `我: ${t.en}` : `你: ${t.en}`));
  lines.push(`我: ${userText}`);
  return ["对话记录（最新在下）：", ...lines, "", "请给出你的下一轮回复（EN: + ZH: 两行）。"].join("\n");
}

export interface AssistantReply {
  en: string;
  zh: string;
}

/**
 * 解析模型回复为 { en, zh }。四步宽容解析（照 SpeakLogic.swift:359-385）：
 * 剥代码块围栏 → EN 正则（兼容中文冒号）→ EN 缺失时删掉 ZH 段当英文 → ZH 正则；
 * \s+ 折叠为单空格。找不到 ZH 时中文提示置空；整段没有 EN 标记时全文当英文（不丢内容）。
 */
export function parseAssistantReply(raw: string): AssistantReply {
  let text = raw.trim();
  text = text
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const capture = (re: RegExp): string | null => {
    const m = re.exec(text);
    return m && m.length > 1 ? m[1] ?? "" : null;
  };

  let en = capture(/(?:^|\n)\s*EN[:：]\s*([\s\S]*?)(?=\n\s*ZH[:：]|$)/i);
  if (en == null) {
    en = text.replace(/(?:^|\n)\s*ZH[:：][\s\S]*$/i, "");
  }
  const zh = capture(/(?:^|\n)\s*ZH[:：]\s*([\s\S]*)$/i) ?? "";
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  return { en: collapse(en), zh: collapse(zh) };
}

/* ---------- 流式切句（陪练 AI 回复边流边读） ---------- */

/**
 * 流式英文切句器（治「AI 回复看完了语音才慢慢出来」）：喂累计 en 文本（只会追加），
 * 每凑满一句完整英文就吐出。切点规则（近似自然停顿即可，切错只影响停顿位置，
 * 拼接后与整段等价、不丢内容）：
 *  · ! ? … 及中文对应标点 = 句界；句点 '.' 需后随空格才算（串尾的点等下一个 delta
 *    再定——可能是省略号中段或小数），数字间的小数点（3.5）永不切。
 *  · 句尾的引号/右括号并入本句（"Really?"）。
 *  · 短碎片（< minLen，如 "OK." "Sure!"）暂存与后句合并，避免碎句单独合成播放；
 *    finish() 无条件吐剩余尾巴（单句短回复也要读）。
 *  · parseAssistantReply 对 en 只做空白折叠/首尾 trim，前缀单调（收缩仅尾部）：
 *    游标越界时回夹即可。
 */
export interface SentenceFeeder {
  /** 喂累计文本，返回本次新凑满的完整句（可能为空数组）。 */
  feed: (cum: string) => string[];
  /** 流结束：返回剩余尾巴（含暂存的短碎片），此后 feeder 作废。 */
  finish: (cum: string) => string[];
}

const CLOSERS = "\"'”’）)]】》";

export function createSentenceFeeder(minLen = 10): SentenceFeeder {
  let consumed = 0;
  let hold = "";
  const take = (cum: string, final: boolean): string[] => {
    if (cum.length < consumed) consumed = cum.length;
    const out: string[] = [];
    for (let i = consumed; i < cum.length; i++) {
      const ch = cum[i];
      let end: boolean;
      if ("!?…。！？".includes(ch)) {
        end = true;
      } else if (ch === ".") {
        const prev = i > 0 ? cum[i - 1] : "";
        const next = cum[i + 1] ?? "";
        end = !/\d/.test(prev) && next === " ";
      } else {
        end = false;
      }
      if (!end) continue;
      let j = i + 1;
      while (j < cum.length && CLOSERS.includes(cum[j])) j++;
      /* slice 从上一句界后起（含界后空格）：trimStart 归一，hold 拼接不留双空格 */
      const piece = ((hold ? hold + " " : "") + cum.slice(consumed, j).trimStart()).trim();
      consumed = j;
      i = j - 1;
      hold = "";
      if (piece.length >= minLen) out.push(piece);
      else hold = piece;
    }
    if (final) {
      const tail = ((hold ? hold + " " : "") + cum.slice(consumed).trimStart()).trim();
      hold = "";
      consumed = cum.length;
      if (tail) out.push(tail);
    }
    return out;
  };
  return {
    feed: (cum) => take(cum, false),
    finish: (cum) => take(cum, true),
  };
}

/* ---------- 会话级总结（mobile 新设计，Mac 无参考） ---------- */

/** 结束摘要的量化输入（真实计时/计轮，非演示数字）。 */
export interface SpeakSummaryStats {
  /** 对话轮次（气泡条数口径）。 */
  turns: number;
  /** 会话用时（秒）。 */
  secs: number;
  /** 我方开口次数。 */
  me: number;
}

/**
 * 会话级总结 prompt（B4 消费；mobile 新设计——Mac 端无对应实现）：
 * 亮点句 / 万能句型 / 一条建议，2–3 句中文，基于真实对话内容不编造。
 */
export function buildSummaryPrompt(
  scene: string,
  turns: ChatTurn[],
  stats: SpeakSummaryStats,
): { system: string; user: string } {
  const label = sceneMetaOf(scene).label;
  const meTurns = turns.filter((t) => t.who === "me").map((t) => t.en).filter(Boolean);
  const aiTurns = turns.filter((t) => t.who === "ai").map((t) => t.en).filter(Boolean);
  const system = [
    "你是英语口语教练。根据一场口语陪练对话，用中文给学员写一份简短的会话总结。",
    "",
    "要求：",
    "- 严格 2–3 句中文，不客套、不夸大，只依据对话里真实出现过的内容。",
    "- 第一句点出学员说得最好的一句（亮点句，可引用原文片段）。",
    "- 第二句给一个这次对话里自然出现、以后可复用的万能句型。",
    "- 最后一句给一条具体的改进建议。",
    "- 不要输出以上内容以外的任何解释或标题。",
  ].join("\n");
  const user = [
    `场景：${label}；共 ${stats.turns} 轮、学员开口 ${stats.me} 次、用时约 ${stats.secs} 秒。`,
    "",
    "学员说的话：",
    ...(meTurns.length ? meTurns.map((t) => `- ${t}`) : ["-（学员没有开口）"]),
    "",
    "陪练回复（节选）：",
    ...(aiTurns.length ? aiTurns.map((t) => `- ${t}`) : ["-（无）"]),
  ].join("\n");
  return { system, user };
}

/* ---------- 学习笔记 prompt（供 B7；mobile 新设计，Mac 无参考） ---------- */

/** 复习统计输入（store.Stats 的结构子集，直接传 Stats 也可）。 */
export interface NotesStatsInput {
  clearedToday: number;
  streak: number;
  week: { review: number; add: number; trap: number };
}

/** 生词条目输入（core/types.ts VocabWord 的结构子集）。 */
export interface NotesVocabItem {
  word: string;
  kind?: "word" | "chunk";
  senses?: { pos: string; cn: string }[];
}

/**
 * 学习笔记 prompt（B7 消费）：基于真实复习统计 + 生词本，产出一段简短中文笔记
 * （本周概况一句 + 值得注意的词/词块一句 + 一条下周建议）。不编造数据。
 */
export function buildNotesPrompt(stats: NotesStatsInput, vocab: NotesVocabItem[]): { system: string; user: string } {
  const sample = vocab.slice(0, 20).map((v) => {
    const cn = v.senses?.map((s) => s.cn).filter(Boolean).slice(0, 2).join("；");
    return `- ${v.word}${v.kind === "chunk" ? "（词块）" : ""}${cn ? `：${cn}` : ""}`;
  });
  const system = [
    "你是英语学习助教。根据学员的复习统计和生词本，用中文写一段简短的学习笔记。",
    "",
    "要求：",
    "- 严格 2–3 句中文；只依据给出的真实数据，不编造数字和词条。",
    "- 第一句概括本周复习/新增/易错的真实情况。",
    "- 第二句从生词本里挑 1–2 个值得注意的词或词块点一下（可引用原文）。",
    "- 最后一句给一条下周的具体建议。",
    "- 不要输出以上内容以外的任何解释或标题。",
  ].join("\n");
  const user = [
    `复习统计：本周复习 ${stats.week.review} 次、新增 ${stats.week.add} 词、易错 ${stats.week.trap} 次；连续打卡 ${stats.streak} 天；今天已复习 ${stats.clearedToday} 个。`,
    "",
    `生词本（共 ${vocab.length} 条，节选）：`,
    ...(sample.length ? sample : ["-（生词本为空）"]),
  ].join("\n");
  return { system, user };
}
