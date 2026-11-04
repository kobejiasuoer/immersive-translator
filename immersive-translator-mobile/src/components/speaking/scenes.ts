/**
 * 口语场景数据（speaking-parity · 原型 V2_SP_SCENES，html:2247-2268）。
 * 每个内置场景的步骤带原型同源的 title/cn（点一份主菜/选择饮料/提出一个特殊要求…）；
 * 练习中的②英文句式/③示例句不在这里预置——由 practice.ts 的 LLM 通道按步生成，
 * 失败在页面按级重试，绝不回退到这里的静态内容冒充生成结果。
 */
import type { PracticeTask } from "../../services/practice";

export interface SceneStep {
  /** 步骤名（overline / 页头副标，如「点一份主菜」）。 */
  title: string;
  /** 任务句（持久化在 PracticeTask.steps）。 */
  prompt: string;
  /** 中文对照（看看中文）。 */
  cn: string;
}

export interface SpeakingScene {
  title: string;
  description: string;
  level: string;
  steps: SceneStep[];
}

export const BUILTIN_SCENES: SpeakingScene[] = [
  {
    title: "寒暄",
    description: "认识新同事，聊两句，再问一个问题",
    level: "日常",
    steps: [
      { title: "介绍自己", prompt: "Hi! I am Alex. What is your name?", cn: "你好，我是 Alex。你叫什么名字？" },
      { title: "分享一个爱好", prompt: "Nice to meet you. What do you enjoy doing after work?", cn: "很高兴认识你。下班后喜欢做什么？" },
      { title: "把话题交给对方", prompt: "That sounds nice. Is there anything you would like to ask me?", cn: "听起来不错。你有什么想问我的吗？" },
    ],
  },
  {
    title: "旅行",
    description: "办理入住，选房间，确认早餐",
    level: "日常",
    steps: [
      { title: "说明入住需求", prompt: "Welcome! How can I help you today?", cn: "欢迎！今天有什么可以帮您的？" },
      { title: "提出房间偏好", prompt: "Of course. Do you have a preference for your room?", cn: "当然。您对房间有什么偏好吗？" },
      { title: "确认早餐信息", prompt: "Your room is ready. Do you have any questions before you go upstairs?", cn: "房间准备好了。上楼前还有什么需要了解的吗？" },
    ],
  },
  {
    title: "点餐",
    description: "点主菜、选饮料、提出特殊要求",
    level: "轻松",
    steps: [
      { title: "点一份主菜", prompt: "Hi there! What would you like to order?", cn: "您好！您想点什么？" },
      { title: "选择饮料", prompt: "And what would you like to drink?", cn: "想配什么饮料呢？" },
      { title: "提出一个特殊要求", prompt: "Sure. Do you have any special requests for your meal?", cn: "好的。对这份餐点有什么特殊要求吗？" },
    ],
  },
  {
    title: "面试",
    description: "介绍经历，讲一个项目，说明结果",
    level: "进阶",
    steps: [
      { title: "介绍自己的经历", prompt: "Could you briefly introduce yourself and your experience?", cn: "请简要介绍自己和相关经验。" },
      { title: "讲一个具体项目", prompt: "Tell me about a project you are proud of. What did you do?", cn: "讲一个让你自豪的项目。你具体做了什么？" },
      { title: "说明行动带来的结果", prompt: "What changed as a result of your work?", cn: "你的工作带来了什么变化？" },
    ],
  },
];

/** 自定义场景按「目标 / 细节 / 问题」三步生成练习；回答至少 4 个英文单词（speaking-parity 校验）。 */
export const CUSTOM_SCENE_MIN_WORDS = 4;
/* 第一步任务句为固定句（原型 html:2355 prompt 不内嵌用户目标；目标只进「看看中文」译文）。 */
export const CUSTOM_SCENE_INTRO_PROMPT = "Tell me what you would like to talk about.";
export function customSceneSteps(_goal: string): string[] {
  return [
    CUSTOM_SCENE_INTRO_PROMPT,
    "Could you share one specific detail, such as an action, a time, or a reason?",
    "What would you like to ask before we finish?",
  ];
}
export function customSceneTaskInput(scene: { title: string; goal: string }): Pick<PracticeTask, "mode" | "title" | "reference" | "steps" | "minAnswerWords"> {
  const steps = customSceneSteps(scene.goal);
  return { mode: "scenario", title: `我的场景 · ${scene.title.trim()}`, reference: steps[0], steps, minAnswerWords: CUSTOM_SCENE_MIN_WORDS };
}

/* ---------- 步骤元数据回查（读取侧） ----------
   PracticeTask.steps 只持久化任务句（string[]，存储形状不变）；原型步骤的 title/cn
   按任务句精确匹配回查（内置场景），自定义场景按生成句式回查（标题为原型 html:2355-2357
   的三步固定名，step 0 的译文从用户自己填的目标文本里取回）。 */
export interface SceneStepMeta { title: string; cn: string | null }

const BUILTIN_STEP_META = new Map<string, SceneStepMeta>();
for (const scene of BUILTIN_SCENES) {
  for (const step of scene.steps) BUILTIN_STEP_META.set(step.prompt, { title: step.title, cn: step.cn });
}
const CUSTOM_STEP_TITLES = ["说明这次的沟通目标", "补充一个具体细节", "向对方提出问题"];
const CUSTOM_STEP_CN: (string | null)[] = [null, "补充一个具体细节，例如行动、时间或原因。", "结束前，向对方问一个你关心的问题。"];

export function sceneStepMeta(steps: string[] | undefined, step: number, sceneTitle?: string): SceneStepMeta | null {
  const prompt = steps?.[step];
  if (!prompt) return null;
  const builtin = BUILTIN_STEP_META.get(prompt);
  if (builtin) return builtin;
  /* 自定义场景三步（任务句固定）：标题用原型三步固定名（html:2355-2357），
     step 0 的译文按原型 cn 口径带场景名（目标文本不落库，无法回显全文）。 */
  if (prompt === CUSTOM_SCENE_INTRO_PROMPT) return { title: CUSTOM_STEP_TITLES[0], cn: sceneTitle ? `围绕「${sceneTitle}」说说你想沟通的目标。` : null };
  if (prompt === "Could you share one specific detail, such as an action, a time, or a reason?") return { title: CUSTOM_STEP_TITLES[1], cn: CUSTOM_STEP_CN[1] };
  if (prompt === "What would you like to ask before we finish?") return { title: CUSTOM_STEP_TITLES[2], cn: CUSTOM_STEP_CN[2] };
  return null;
}

/** 任务当前步的名称（speaking-parity：口语首页续练卡副行 = 步骤名 · 已回答 x / y 步，html:2618）。
    场景按步骤回查（点一份主菜…）；follow 按出处/纠偏再练给名；词专项用原型固定步骤名。 */
export function practiceStepTitle(task: Pick<PracticeTask, "mode" | "steps" | "step" | "word" | "source" | "title">): string {
  const count = task.steps?.length || 1;
  if (task.mode === "scenario") return sceneStepMeta(task.steps, task.step)?.title ?? `第 ${task.step + 1} 步`;
  if (task.mode === "follow") {
    if (task.title === "再练这句表达") return "这次试试更自然的表达";
    return task.source ? `原文第 ${(task.source.sentenceIdx ?? 0) + task.step + 1} 句` : `第 ${task.step + 1} / ${count} 步`;
  }
  return task.word ? "试着用上这个表达" : `第 ${task.step + 1} / ${count} 步`;
}

/** 练习的场景名（speaking-parity：纠偏详情 nhead 副标，原型 VIEWS.correction `n.scene || "口语纠偏"`，html:3000）。
    原型 session.scene 口径：场景对话取场景名本身（点餐 / 我的场景标题，html:2345），词专项为「词块造句」
    （原型演示 sessions 同款，html:1684/1693），跟读无场景名时回落任务标题（html:2574 `scene || title`）。 */
export function practiceSceneLabel(task: Pick<PracticeTask, "mode" | "title">): string {
  if (task.mode === "scenario") return task.title.replace(/^(?:场景对话|我的场景) · /, "") || task.title;
  if (task.mode === "word") return "词块造句";
  return task.title || "口语纠偏";
}
