/**
 * 考试大纲词表覆盖计算（内容进水口：文库 / URL 预览的「覆盖 N 词 · M 个未掌握」）。
 *
 * - 词表数据来自 scripts/build-intake-assets.mjs 生成的 exam-wordlists.json
 *   （四级/六级整理自官方大纲，考研为 2025 红宝书导出）；v1 只带这三个目标。
 * - 「未掌握」口径与复习流掌握度分布一致：已在生词本且 srs.intervalDays < 7
 *   （≥7 天记为已掌握，见 readerSrs.reviewStats 的分桶）。
 */

import wordlists from "./data/exam-wordlists.json";
import type { VocabWord } from "./readerTypes";

export type ExamGoal = keyof typeof wordlists;

export const EXAM_GOALS: ExamGoal[] = ["kaoyan", "cet4", "cet6"];

export const EXAM_GOAL_LABELS: Record<ExamGoal, string> = {
  kaoyan: "考研",
  cet4: "四级",
  cet6: "六级",
};

const SETS: Record<ExamGoal, ReadonlySet<string>> = {
  kaoyan: new Set<string>(wordlists.kaoyan),
  cet4: new Set<string>(wordlists.cet4),
  cet6: new Set<string>(wordlists.cet6),
};

/** 常见不规则过去式/分词 → 原形（覆盖主要屈折形式，避免词表命中率明显偏低）。 */
const IRREGULAR_LEMMA: Record<string, string> = {
  was: "be", were: "be", been: "be", am: "be", is: "be", are: "be",
  had: "have", has: "have", having: "have",
  did: "do", does: "do", done: "do",
  went: "go", gone: "go", goes: "go",
  made: "make", makes: "make",
  said: "say", says: "say",
  got: "get", gotten: "get", gets: "get",
  knew: "know", known: "know", knows: "know",
  took: "take", taken: "take", takes: "take",
  came: "come", comes: "come",
  saw: "see", seen: "see", sees: "see",
  gave: "give", given: "give", gives: "give",
  found: "find", finds: "find",
  told: "tell", tells: "tell",
  felt: "feel", feels: "feel",
  left: "leave", leaves: "leave",
  kept: "keep", keeps: "keep",
  held: "hold", holds: "hold",
  brought: "bring", brings: "bring",
  thought: "think", thinks: "think",
  stood: "stand", stands: "stand",
  heard: "hear", hears: "hear",
  ran: "run", runs: "run",
  wrote: "write", written: "write", writes: "write",
  read: "read", reads: "read",
  sat: "sit", sits: "sit",
  spoke: "speak", spoken: "speak", speaks: "speak",
  lay: "lie", laid: "lay", lain: "lie", lies: "lie",
  grew: "grow", grown: "grow", grows: "grow",
  flew: "fly", flown: "fly", flies: "fly",
  fell: "fall", fallen: "fall", falls: "fall",
  began: "begin", begun: "begin", begins: "begin",
  sang: "sing", sung: "sing", sings: "sing",
  swam: "swim", swum: "swim",
  ate: "eat", eaten: "eat", eats: "eat",
  drank: "drink", drunk: "drink",
  slept: "sleep", sleeps: "sleep",
  woke: "wake", woken: "wake", wakes: "wake",
  chose: "choose", chosen: "choose", chooses: "choose",
  drove: "drive", driven: "drive", drives: "drive",
  wore: "wear", worn: "wear", wears: "wear",
  won: "win", wins: "win",
  sent: "send", sends: "send",
  built: "build", builds: "build",
  sold: "sell", sells: "sell",
  spent: "spend", spends: "spend",
  met: "meet", meets: "meet",
  paid: "pay", pays: "pay",
  lost: "lose", loses: "lose",
  rose: "rise", risen: "rise", rises: "rise",
  broke: "break", broken: "break", breaks: "break",
  hid: "hide", hidden: "hide", hides: "hide",
  children: "child", men: "man", women: "woman", feet: "foot",
  teeth: "tooth", mice: "mouse", better: "good", best: "good",
  worse: "bad", worst: "bad", less: "little", least: "little",
  more: "much", most: "much",
};

/** 规则屈折回落：复数/动词三单/-ed/-ing → 原形候选。 */
function lemmaCandidates(token: string): string[] {
  const out: string[] = [token];
  const irregular = IRREGULAR_LEMMA[token];
  if (irregular) out.push(irregular);
  const push = (w: string) => {
    if (w.length >= 3 && !out.includes(w)) out.push(w);
  };
  if (token.endsWith("ies") && token.length > 4) push(`${token.slice(0, -3)}y`);
  else if (token.endsWith("es")) {
    push(token.slice(0, -2));
    if (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("ches") || token.endsWith("shes")) {
      push(token.slice(0, -1));
    }
  } else if (token.endsWith("s") && !token.endsWith("ss")) {
    push(token.slice(0, -1));
  }
  if (token.endsWith("ing")) {
    push(token.slice(0, -3));
    push(token.slice(0, -3) + "e");
    const stem = token.slice(0, -3);
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && !/[aeiouwxy]/.test(stem[stem.length - 1])) {
      push(stem.slice(0, -1));
    }
  } else if (token.endsWith("ied") && token.length > 4) {
    push(`${token.slice(0, -3)}y`);
  } else if (token.endsWith("ed")) {
    push(token.slice(0, -2));
    push(token.slice(0, -1));
    const stem = token.slice(0, -2);
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && !/[aeiouwxy]/.test(stem[stem.length - 1])) {
      push(stem.slice(0, -1));
    }
  }
  return out;
}

/** 分词：小写字母串（撇号保留），供词表命中统计。 */
export function examTokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/g) ?? []).map((t) =>
    t.replace(/’/g, "'"),
  );
}

/** 文本命中某目标词表的不重复词数（含屈折回落）。 */
export function coveredWords(text: string, goal: ExamGoal): Set<string> {
  const set = SETS[goal];
  const hit = new Set<string>();
  for (const token of examTokenize(text)) {
    for (const cand of lemmaCandidates(token)) {
      if (set.has(cand)) {
        hit.add(cand);
        break;
      }
    }
  }
  return hit;
}

export interface CoverageStats {
  /** 篇内命中的大纲词个数（去重）。 */
  total: number;
  /** 其中在生词本里且尚未掌握（intervalDays < 7）的个数。 */
  unmastered: number;
}

/** 覆盖统计：命中目标词表 + 与生词本求交集。 */
export function coverageForText(
  text: string,
  goal: ExamGoal,
  vocab: VocabWord[],
): CoverageStats {
  const hit = coveredWords(text, goal);
  let unmastered = 0;
  for (const w of vocab) {
    if (hit.has(w.id) && w.srs.intervalDays < 7) unmastered += 1;
  }
  return { total: hit.size, unmastered };
}

/** 全库词表命中（URL 预览等场景需要全词集判断）。 */
export function wordInGoalList(word: string, goal: ExamGoal): boolean {
  return SETS[goal].has(word.toLowerCase());
}
