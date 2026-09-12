import { describe, expect, it } from "vitest";
import type { VocabWord } from "./readerTypes";
import {
  firstLetters,
  judgeCloze,
  judgeDictation,
  levenshtein,
  normalizeAnswer,
  routeRecallMode,
  verdictToSuggestedGrade,
  wordDiff,
  wordHitRate,
} from "./recallJudge";
import { initialSrs } from "./readerSrs";

describe("normalizeAnswer", () => {
  it("小写、去标点、折空白", () => {
    expect(normalizeAnswer("  Take Root! ")).toBe("take root");
    expect(normalizeAnswer("In the wake of…")).toBe("in the wake of");
  });

  it("撇号剥掉（缩写/所有格不拆词：dont == don't，citys == city's）", () => {
    expect(normalizeAnswer("don't")).toBe("dont");
    expect(normalizeAnswer("The city’s canopy")).toBe("the citys canopy");
  });

  it("中文按空格折叠（trap 字段的中文注释自然脱落）", () => {
    expect(normalizeAnswer("take roots（不可数，无复数）")).toBe("take roots");
    expect(normalizeAnswer("buffer from（中式直译）")).toBe("buffer from");
  });

  it("空输入返回空串", () => {
    expect(normalizeAnswer("")).toBe("");
    expect(normalizeAnswer("   ")).toBe("");
  });
});

describe("levenshtein", () => {
  it("基础距离", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("took root", "took roots")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("judgeCloze", () => {
  it("精确与大小写/标点不敏感 → perfect", () => {
    expect(judgeCloze("take root", "take root")).toBe("perfect");
    expect(judgeCloze("  Took Root. ", "took root")).toBe("perfect");
  });

  it("accepted 形式（词条原形 vs 句中屈折形式）→ perfect", () => {
    expect(judgeCloze("take root", "took root", { accepted: ["take root"] })).toBe("perfect");
  });

  it("命中直译陷阱 → trap（支持 / 分隔的多候选与长候选包含）", () => {
    expect(judgeCloze("take roots", "take root", { trap: "take roots（不可数，无复数）" })).toBe("trap");
    expect(judgeCloze("attribute for", "attribute", { trap: "attribute for（介词误用）" })).toBe("trap");
    expect(
      judgeCloze("attribute x for y", "attribute", { trap: "attribute X for Y / attribute to sb" }),
    ).toBe("trap");
  });

  it("perfect 优先于 trap（答案恰含 trap 候选时不误伤）", () => {
    expect(judgeCloze("big rain", "big rain", { trap: "big rain" })).toBe("perfect");
  });

  it("接近 → close：去冠词相等或编辑距离在阈值内", () => {
    expect(judgeCloze("took roots", "took root")).toBe("close");
    expect(judgeCloze("in wake of", "in the wake of")).toBe("close");
    expect(judgeCloze("comprehension", "comprehensions")).toBe("close");
  });

  it("不相关 → wrong；空输入 → wrong", () => {
    expect(judgeCloze("make momentum", "take root", { trap: "make momentum" })).toBe("trap");
    expect(judgeCloze("settle down", "take root")).toBe("wrong");
    expect(judgeCloze("", "take root")).toBe("wrong");
    expect(judgeCloze("   ", "take root")).toBe("wrong");
  });
});

describe("wordDiff / wordHitRate", () => {
  it("对齐混合错误：ok/miss/extra 各就各位", () => {
    const diff = wordDiff(
      "The citys tree canopy now cover fourty percent of the streets",
      "The city's tree canopy now covers forty percent of the streets",
    );
    const ok = diff.filter((t) => t.status === "ok").map((t) => t.text);
    const miss = diff.filter((t) => t.status === "miss").map((t) => t.text);
    const extra = diff.filter((t) => t.status === "extra").map((t) => t.text);
    expect(ok).toEqual(["the", "citys", "tree", "canopy", "now", "percent", "of", "the", "streets"]);
    expect(miss).toEqual(["covers", "forty"]);
    expect(extra).toEqual(["cover", "fourty"]);
  });

  it("全对 → 命中率 1；全错 → 低于 0.5", () => {
    const s = "Torrential rain tested the new drainage within a week.";
    expect(wordHitRate(s, s)).toBe(1);
    expect(wordHitRate("completely different words here ok", s)).toBeLessThan(0.5);
  });

  it("空答案句命中率 0（防除零）", () => {
    expect(wordHitRate("anything", "")).toBe(0);
  });
});

describe("judgeDictation", () => {
  const SENTENCE = "The city's tree canopy now covers forty percent of the streets.";

  it("标点/撇号/大小写不敏感的整句 → perfect", () => {
    expect(judgeDictation("the citys tree canopy now covers forty percent of the streets", SENTENCE)).toBe(
      "perfect",
    );
  });

  it("词级命中率 ≥85% → close；更低 → wrong", () => {
    // 漏一个 the：10/11 ≈ 91% → close
    expect(judgeDictation("The citys tree canopy now covers forty percent of streets", SENTENCE)).toBe(
      "close",
    );
    // cover/fourty 两处拼写错：9/11 ≈ 82% → wrong
    expect(judgeDictation("The citys tree canopy now cover fourty percent of the streets", SENTENCE)).toBe(
      "wrong",
    );
  });

  it("整句含直译陷阱 → trap", () => {
    expect(
      judgeDictation("Big rain tested the new drainage within a week.", "Torrential rain tested the drainage.", {
        trap: "big rain（中文直译）",
      }),
    ).toBe("trap");
  });

  it("空输入 → wrong", () => {
    expect(judgeDictation("", SENTENCE)).toBe("wrong");
  });
});

function makeWord(partial: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    senses: [],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(0),
    addedAt: 0,
    ...partial,
  };
}

describe("routeRecallMode", () => {
  it("smart：词块 → 完形", () => {
    expect(routeRecallMode(makeWord({ id: "c", word: "take root", kind: "chunk" }), "smart")).toBe("cloze");
  });

  it("smart：熟词（间隔 ≥1 天）→ 听写，新词 → 识别", () => {
    const fresh = makeWord({ id: "w1", word: "canopy", srs: { ...initialSrs(0), intervalDays: 0 } });
    const known = makeWord({ id: "w2", word: "canopy", srs: { ...initialSrs(0), intervalDays: 3 } });
    expect(routeRecallMode(fresh, "smart")).toBe("recognition");
    expect(routeRecallMode(known, "smart")).toBe("dictation");
  });

  it("非 smart 直接透传", () => {
    const w = makeWord({ id: "w", word: "take root", kind: "chunk" });
    expect(routeRecallMode(w, "recognition")).toBe("recognition");
    expect(routeRecallMode(w, "cloze")).toBe("cloze");
    expect(routeRecallMode(w, "dictation")).toBe("dictation");
  });
});

describe("verdictToSuggestedGrade", () => {
  it("四档映射", () => {
    expect(verdictToSuggestedGrade("perfect")).toBe("easy");
    expect(verdictToSuggestedGrade("close")).toBe("good");
    expect(verdictToSuggestedGrade("trap")).toBe("forgot");
    expect(verdictToSuggestedGrade("wrong")).toBe("forgot");
  });
});

describe("firstLetters", () => {
  it("首字母提示", () => {
    expect(firstLetters("take root")).toBe("t… r…");
    expect(firstLetters("In the wake of")).toBe("i… t… w… o…");
  });
});
