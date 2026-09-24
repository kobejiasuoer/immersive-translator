/**
 * 口语复盘候选提取规则测试：R1 最新分 / R2 已攻克剔除 / R3 功能词 /
 * R4 漏读+低分合并 / R5 漏读 ≥2 / R6 纯漏读 1 次 / R7 临界 / R8 封顶折叠，
 * 以及跟丢护栏（完整度、漏读数封顶）、跨轮去重与生词本标注。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_SPEAK_CANDIDATES,
  extractSpeakVocab,
  speakCandidateToVocab,
} from "./speakVocab";
import {
  newSpeakSession,
  type ShadowAttempt,
  type SpeakSession,
  type SpeakTurn,
} from "./speakLogic";
import type { WordScore } from "./pronunciation";
import type { VocabWord } from "./readerTypes";

let seq = 0;

function word(content: string, totalScore: number, dpMessage = 0): WordScore {
  return { content, totalScore, dpMessage, sylls: [] };
}

function attempt(words: WordScore[], opts: { integrity?: number } = {}): ShadowAttempt {
  return {
    at: ++seq,
    total: 3,
    accuracy: 3,
    fluency: 4,
    integrity: opts.integrity ?? 5,
    words,
  };
}

function turnA(text: string, hintZh: string, attempts?: ShadowAttempt[]): SpeakTurn {
  return {
    role: "assistant",
    text,
    hintZh,
    ...(attempts ? { shadowAttempts: attempts, shadowScore: attempts[attempts.length - 1].total } : {}),
    at: ++seq,
  };
}

function turnU(text: string): SpeakTurn {
  return { role: "user", text, at: ++seq };
}

function session(turns: SpeakTurn[]): SpeakSession {
  return { ...newSpeakSession("ordering", "medium", 1000), turns };
}

describe("extractSpeakVocab 规则", () => {
  it("R1：单次低分 → 候选且默认勾选，例句取自 AI 原句", () => {
    const s = session([
      turnU("No, do you have a table for two?"),
      turnA("I'd like to make a reservation for two.", "我想预订两位。", [
        attempt([word("I'd", 4.5), word("reservation", 2.4), word("two", 4.6)]),
      ]),
    ]);
    const { candidates, folded } = extractSpeakVocab(s);
    expect(folded).toHaveLength(0);
    const c = candidates.find((x) => x.id === "reservation");
    expect(c).toBeDefined();
    expect(c!.defaultChecked).toBe(true);
    expect(c!.latestScore).toBe(2.4);
    expect(c!.reasons).toContain("low");
    expect(c!.example.en).toContain("reservation");
    expect(c!.example.zh).toBe("我想预订两位。");
  });

  it("R4：漏读 + 后来低分 → 合并为一条候选，默认勾选", () => {
    const s = session([
      turnA("We have a table available at 7:30.", "7 点半有空位。", [
        attempt([word("available", 0, 16)]),
        attempt([word("available", 2.9)]),
      ]),
    ]);
    const { candidates } = extractSpeakVocab(s);
    const c = candidates.find((x) => x.id === "available");
    expect(c).toBeDefined();
    expect(c!.defaultChecked).toBe(true);
    expect(c!.latestScore).toBe(2.9);
    expect(c!.missedCount).toBe(1);
    expect(c!.occurrences).toBe(2);
    expect(c!.reasons).toContain("missed");
    expect(c!.reasons).toContain("low");
  });

  it("R6/R5：纯漏读 1 次默认不勾；漏读 ≥2 次默认勾选", () => {
    const once = session([
      turnA("Would you like to see the dessert menu?", "要看看甜点单吗？", [
        attempt([word("dessert", 0, 16), word("menu", 4.4)]),
      ]),
    ]);
    const onceC = extractSpeakVocab(once).candidates.find((x) => x.id === "dessert");
    expect(onceC).toBeDefined();
    expect(onceC!.defaultChecked).toBe(false);
    expect(onceC!.latestScore).toBeNull();
    expect(onceC!.reasons).toEqual(["missed"]);

    const twice = session([
      turnA("Would you like dessert?", "要甜点吗？", [
        attempt([word("dessert", 0, 16)]),
        attempt([word("dessert", 0, 16)]),
      ]),
    ]);
    const twiceC = extractSpeakVocab(twice).candidates.find((x) => x.id === "dessert");
    expect(twiceC!.defaultChecked).toBe(true);
    expect(twiceC!.missedCount).toBe(2);
  });

  it("R3：功能词漏读不进候选；读得差仍进", () => {
    const s = session([
      turnA("Do you have a table by the window?", "有靠窗的位子吗？", [
        attempt([word("the", 0, 16), word("of", 0, 16), word("window", 2.2)]),
      ]),
    ]);
    const { candidates } = extractSpeakVocab(s);
    expect(candidates.map((c) => c.id)).toEqual(["window"]);

    const lowFunc = session([
      turnA("Here you are.", "给您。", [attempt([word("you", 2.0)])]),
    ]);
    expect(extractSpeakVocab(lowFunc).candidates.map((c) => c.id)).toContain("you");
  });

  it("R2：最新一次 ≥4.0 视为已攻克，剔除（即使之前低分）", () => {
    const s = session([
      turnA("Our chef recommends the special.", "主厨推荐特色菜。", [
        attempt([word("recommends", 3.0)]),
        attempt([word("recommends", 4.2)]),
      ]),
    ]);
    expect(extractSpeakVocab(s).candidates).toHaveLength(0);
  });

  it("R7：临界 3.5~4.0 进列表但默认不勾", () => {
    const s = session([
      turnA("It is popular with vegetarians.", "素食者也很喜欢。", [
        attempt([word("vegetarians", 3.8)]),
      ]),
    ]);
    const c = extractSpeakVocab(s).candidates.find((x) => x.id === "vegetarians");
    expect(c).toBeDefined();
    expect(c!.defaultChecked).toBe(false);
  });

  it("替换（dp=128）带低分 → 候选含替换原因", () => {
    const s = session([
      turnA("I'd like to make a reservation.", "我想预订。", [
        attempt([word("reservation", 2.8, 128)]),
      ]),
    ]);
    const c = extractSpeakVocab(s).candidates.find((x) => x.id === "reservation");
    expect(c!.reasons).toContain("substituted");
    expect(c!.reasons).toContain("low");
    expect(c!.defaultChecked).toBe(true);
  });

  it("增读（dp=32）与纯数字不产生候选", () => {
    const s = session([
      turnA("Table for two at 7:30?", "两位 7 点半？", [
        attempt([word("seven thirty", 1.0, 32), word("30", 1.0), word("table", 4.5)]),
      ]),
    ]);
    expect(extractSpeakVocab(s).candidates).toHaveLength(0);
  });

  it("跟丢护栏：完整度 <2.5 的 attempt 不采漏读词，但仍采有分数的词", () => {
    const s = session([
      turnA("Would you like to see the dessert menu?", "要看看甜点单吗？", [
        attempt([word("dessert", 0, 16), word("menu", 2.0)], { integrity: 2.0 }),
      ]),
    ]);
    const ids = extractSpeakVocab(s).candidates.map((c) => c.id);
    expect(ids).not.toContain("dessert");
    expect(ids).toContain("menu");
  });

  it("跟丢护栏：单次漏读词超过 4 个视为跟丢整句", () => {
    const s = session([
      turnA("The dessert beverage appetizer steak and sauce are nice.", "略。", [
        attempt([
          word("dessert", 0, 16),
          word("beverage", 0, 16),
          word("appetizer", 0, 16),
          word("steak", 0, 16),
          word("sauce", 0, 16),
          word("nice", 2.0),
        ]),
      ]),
    ]);
    const ids = extractSpeakVocab(s).candidates.map((c) => c.id);
    expect(ids).toEqual(["nice"]);
  });

  it("跨轮去重：同一词在两轮各漏读一次 → 一条候选、missedCount=2、例句取首次", () => {
    const s = session([
      turnA("Would you like dessert?", "要甜点吗？", [attempt([word("dessert", 0, 16)])]),
      turnU("Yes please."),
      turnA("Great, one dessert coming up.", "好，一份甜点马上来。", [
        attempt([word("dessert", 0, 16), word("coming", 4.5)]),
      ]),
    ]);
    const { candidates } = extractSpeakVocab(s);
    const list = candidates.filter((c) => c.id === "dessert");
    expect(list).toHaveLength(1);
    expect(list[0].occurrences).toBe(2);
    expect(list[0].missedCount).toBe(2);
    expect(list[0].example.en).toBe("Would you like dessert?");
  });

  it("R8：候选超过 8 个 → 只展示前 8（按证据强度），其余折叠", () => {
    const turns: SpeakTurn[] = [
      turnA("aaa bbb ccc ddd eee fff ggg hhh iii jjj.", "略。", [
        attempt([
          word("aaa", 2.0),
          word("bbb", 2.1),
          word("ccc", 2.2),
          word("ddd", 2.3),
          word("eee", 2.4),
          word("fff", 2.5),
          word("ggg", 2.6),
          word("hhh", 2.7),
          word("iii", 2.8),
          word("jjj", 2.9),
        ]),
      ]),
    ];
    const { candidates, folded } = extractSpeakVocab(session(turns));
    expect(candidates).toHaveLength(MAX_SPEAK_CANDIDATES);
    expect(folded).toHaveLength(2);
    // 按最新分升序：分数最高的两个被折叠
    expect(candidates[0].id).toBe("aaa");
    expect(folded.map((c) => c.id)).toEqual(["iii", "jjj"]);
  });

  it("排序：强证据在前，弱证据在后", () => {
    const turns: SpeakTurn[] = [
      turnA("vegan vegetarian reservation", "略。", [
        attempt([
          word("vegetarian", 3.8), // 临界 → 弱
          word("reservation", 2.4), // 低分 → 强
          word("vegan", 0, 16), // 纯漏读 1 次 → 弱
        ]),
      ]),
    ];
    const ids = extractSpeakVocab(session(turns)).candidates.map((c) => c.id);
    expect(ids.indexOf("reservation")).toBeLessThan(ids.indexOf("vegetarian"));
    expect(ids.indexOf("vegetarian")).toBeLessThan(ids.indexOf("vegan"));
  });
});

describe("生词本标注", () => {
  const vocabEntry = (id: string, over: Partial<VocabWord> = {}): VocabWord => ({
    id,
    word: id,
    senses: [],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: { ease: 2.5, intervalDays: 3, reps: 2, dueAt: 9000, lapses: 0 },
    addedAt: 1000,
    ...over,
  });

  it("命中已收藏词 → existing 标注、排最后、不参与默认勾选", () => {
    const s = session([
      turnA("reservation vegetarian", "略。", [
        attempt([word("reservation", 2.4), word("vegetarian", 3.8)]),
      ]),
    ]);
    const vocab = [vocabEntry("reservation")];
    const { candidates } = extractSpeakVocab(s, vocab, 10_000);
    expect(candidates[candidates.length - 1].id).toBe("reservation");
    const c = candidates.find((x) => x.id === "reservation")!;
    expect(c.existing).toBeDefined();
    expect(c.defaultChecked).toBe(true); // 规则判断不受收藏影响，UI 不可勾
  });

  it("已收藏且复习错过/已到期 → wake 标注", () => {
    const s = session([
      turnA("dessert menu", "略。", [attempt([word("dessert", 0, 16), word("menu", 2.0)])]),
    ]);
    const vocab = [
      vocabEntry("dessert", {
        recall: { total: { pass: 1, wrong: 2, trap: 0 }, byMode: {} },
      }),
    ];
    const c = extractSpeakVocab(s, vocab, 10_000).candidates.find((x) => x.id === "dessert")!;
    expect(c.wake).toBe(true);
    expect(c.defaultChecked).toBe(false);
  });
});

describe("speakCandidateToVocab 组装", () => {
  it("词条齐全时补齐音标/释义/搭配，例句用口语原句，来源留空", () => {
    const s = session([
      turnA("I'd like a reservation.", "我想预订。", [attempt([word("reservation", 2.4)])]),
    ]);
    const c = extractSpeakVocab(s).candidates[0];
    const v = speakCandidateToVocab(
      c,
      {
        word: "reservation",
        phonetic: "/ˌrezərˈveɪʃn/",
        senses: [{ pos: "n.", cn: "预订，预约" }],
        collocations: [{ en: "make a reservation", cn: "预订" }],
      },
      5000,
    );
    expect(v.id).toBe("reservation");
    expect(v.word).toBe("reservation");
    expect(v.kind).toBe("word");
    expect(v.phonetic).toBe("/ˌrezərˈveɪʃn/");
    expect(v.senses).toHaveLength(1);
    expect(v.example).toEqual({ en: "I'd like a reservation.", zh: "我想预订。" });
    expect(v.source).toEqual({ articleId: "", sentenceIdx: 0 });
    expect(v.srs).toEqual({ ease: 2.5, intervalDays: 0, reps: 0, dueAt: 5000, lapses: 0 });
    expect(v.addedAt).toBe(5000);
  });

  it("词条缺失时降级为裸词（空释义），不抛错", () => {
    const s = session([
      turnA("menu", "略。", [attempt([word("menu", 2.0)])]),
    ]);
    const c = extractSpeakVocab(s).candidates[0];
    const v = speakCandidateToVocab(c, null, 5000);
    expect(v.word).toBe("menu");
    expect(v.senses).toEqual([]);
  });
});
