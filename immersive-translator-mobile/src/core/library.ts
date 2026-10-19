/**
 * 内置文库（B4）——真实全文短文（自写，公版口径），替代演示占位书单。
 * 书单/「今日一篇」单一数据源；词数按正文实时统计（非写死）。
 * libToArticle 构建的文章 zh=null，走既有段级翻译管线（§3.6/#35）。
 */
import type { Article } from "./types";

export type LibLevel = "A2" | "B1" | "B2";

/** 考试标签（筛选 chips 顺序即展示顺序）。 */
export const EXAM_TAGS = ["雅思", "托福", "四六级", "考研"] as const;

export interface LibArticle {
  id: string;
  title: string;
  titleCn: string;
  level: LibLevel;
  /** 适配考试标签（EXAM_TAGS 子集，筛选用）。 */
  exams: string[];
  /** 完整英文原文，按句切好（每元素一句，含句末标点）。 */
  sentences: string[];
}

export const LIB_ARTICLES: LibArticle[] = [
  {
    id: "city15",
    title: "The 15-Minute City",
    titleCn: "十五分钟城市",
    level: "B1",
    exams: ["四六级", "考研"],
    sentences: [
      "The fifteen-minute city is a simple idea with a long reach.",
      "It asks that daily needs sit within a fifteen-minute walk or bike ride of home.",
      "Work, school, food, care and a quiet park should all share the same neighbourhood.",
      "The concept grew out of Paris, where the mayor made it official policy.",
      "Cities that try it paint new bike lanes and turn parking spaces into small squares.",
      "Residents begin to meet the baker, the nurse and the teacher by name.",
      "Fewer short car trips mean cleaner air and calmer streets.",
      "Critics worry about jobs that cannot move closer to workers.",
      "Supporters answer that remote work and local hubs can absorb much of the demand.",
      "Whatever the debate, the question it raises is here to stay: what can you reach on foot?",
    ],
  },
  {
    id: "treesnight",
    title: "How Trees Cool the Night",
    titleCn: "树如何给夜晚降温",
    level: "A2",
    exams: ["四六级"],
    sentences: [
      "A street tree works long after the sun goes down.",
      "Its leaves hold water, and water carries heat away as it dries.",
      "Through the day the canopy blocks light before it can warm the pavement.",
      "At night the shade slowly lets the stored heat go.",
      "A line of young lindens can cool a block by a few degrees.",
      "That may sound small, but sleep improves when bedrooms stay cooler.",
      "Trees also drink stormwater, so the drains are less likely to flood.",
      "A sapling asks for little: water, mulch and room to grow.",
      "Plant one now, and it will work every summer night for fifty years.",
    ],
  },
  {
    id: "slowweb",
    title: "The Slow Web Movement",
    titleCn: "慢网络运动",
    level: "B1",
    exams: ["考研"],
    sentences: [
      "The slow web is a quiet answer to noisy feeds.",
      "It favours pages written by a person, not assembled by a machine.",
      "Essays are dated, not ranked; links are few, not endless.",
      "Readers keep their own lists instead of renting an algorithm's.",
      "A slow site loads fast because it carries so little.",
      "No banner begs for your email before you have read a word.",
      "Writers publish when something is worth saying, which may be twice a year.",
      "The practice borrows from slow food: know the source, take your time.",
      "Attention, like soil, gets poorer when it is forced.",
      "The movement is small, yet its pages load in a blink anywhere in the world.",
    ],
  },
  {
    id: "museums",
    title: "What Museums Do at Night",
    titleCn: "博物馆的夜晚",
    level: "B2",
    exams: ["雅思", "托福"],
    sentences: [
      "When the last visitor leaves, the museum's second shift begins.",
      "Guards walk their rounds under emergency lighting, past darkened galleries.",
      "Conservators move paintings into the lab to check old varnish and new cracks.",
      "Humidity loggers whisper their data to a server in the basement.",
      "Freezers hold fragile textiles against the quiet war of insects.",
      "Registrars unpack crates loaned from another continent and match each number to a list.",
      "Somewhere a curator rewrites a wall text for the third time.",
      "Cleaning staff vacuum the stairs that a thousand shoes will climb tomorrow.",
      "In the sculpture hall, a cracked marble arm waits for its custom brace.",
      "Night is also when the building tests its alarms, one zone at a time.",
      "By dawn the crates are gone and the labels are level again.",
      "The doors open, and the overnight work is invisible, which is the point.",
    ],
  },
  {
    id: "mistakes",
    title: "Learning to Love Mistakes",
    titleCn: "学会爱上犯错",
    level: "A2",
    exams: ["雅思"],
    sentences: [
      "Most of us were taught that mistakes are marks against us.",
      "In language learning the opposite is closer to the truth.",
      "Every wrong word is a door you have tried before you knew the key.",
      "A learner who speaks badly every day soon speaks well.",
      "A learner who waits to be perfect never starts.",
      "Researchers call this the growth mindset, but the idea is older than the term.",
      "Keep a small list of your best mistakes, and read it like a map.",
      "Each one shows where you went, and each one shows the way back.",
    ],
  },
];

/** 正文真实词数（按空格分词统计，非写死）。 */
export function libWords(a: LibArticle): number {
  return a.sentences.join(" ").trim().split(/\s+/).length;
}

/** 书单/「今日一篇」meta 行。 */
export function libMeta(a: LibArticle): string {
  return `${a.level} · ${a.sentences.length} 句 · ${libWords(a)} 词 · ${a.exams.join("/")}`;
}

/** 「今日一篇」按日轮换（UTC 天数取模，自然换篇）。 */
export function libToday(): LibArticle {
  const day = Math.floor(Date.now() / 86_400_000);
  return LIB_ARTICLES[day % LIB_ARTICLES.length]!;
}

/** 文库篇目 → 书架 Article：全文真实句子、zh=null（既有翻译管线补齐）、≥8 句均分两段。 */
export function libToArticle(a: LibArticle): Article {
  const mid = a.sentences.length >= 8 ? Math.ceil(a.sentences.length / 2) : -1;
  const starts = mid >= 0 ? [0, mid] : [0];
  return {
    id: `lib-${a.id}-${Date.now().toString(36)}`,
    title: a.title,
    titleCn: a.titleCn,
    sentences: a.sentences.map((en, i) => ({
      idx: i,
      paragraphIdx: starts.filter((s) => i >= s).length - 1,
      en,
      zh: null,
      chunks: [],
    })),
    paragraphStarts: starts,
  };
}
