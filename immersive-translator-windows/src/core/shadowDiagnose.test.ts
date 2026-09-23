/**
 * 跟读报告诊断逻辑单测：徽章判定、短板维度点名、差词/漏词清单、音素提示。
 */

import { describe, expect, it } from "vitest";
import {
  DIM_LABELS,
  SHADOW_PASS_SCORE,
  diagnoseShadow,
  phoneTip,
  worstPhoneOf,
} from "./shadowDiagnose";
import { mapWordsToText, type PronunciationResult, type WordScore } from "./pronunciation";

function word(content: string, totalScore: number, dpMessage = 0): WordScore {
  return { content, totalScore, dpMessage, sylls: [] };
}

function result(over: Partial<PronunciationResult>, words: WordScore[]): PronunciationResult {
  return {
    total: 4.1,
    accuracy: 4.3,
    fluency: 3.4,
    standard: 4.1,
    integrity: 4.6,
    isRejected: false,
    exceptInfo: null,
    words,
    ...over,
  };
}

const TARGET = "The quick brown fox jumps over the lazy dog.";

describe("diagnoseShadow", () => {
  it("用户主场景：4.1 分 → almost 徽章点名差 0.1，短板流畅度，差词/漏词清单", () => {
    const words = [
      word("the", 5),
      word("quick", 4.7),
      word("brown", 0, 16), // 漏读
      word("fox", 2.5), // 差词
      word("jumps", 3.5), // ok
      word("over", 5),
      word("the", 5),
      word("lazy", 4.9),
      word("dog", 4.7),
    ];
    const r = result({ total: 4.1, accuracy: 4.3, fluency: 3.4, integrity: 4.6 }, words);
    const d = diagnoseShadow(r, mapWordsToText(TARGET, words), SHADOW_PASS_SCORE);

    expect(d.pass).toBe(false);
    expect(d.badgeKind).toBe("almost");
    expect(d.badge).toBe("差 0.1 过关");
    expect(d.weakDim).toBe("fluency");
    expect(d.drillWords).toEqual(["fox", "brown"]);
    expect(d.badCount).toBe(1);
    expect(d.missedCount).toBe(1);
    // 诊断句点名短板与差词/漏词
    const text = d.segments.map((s) => s.text).join("");
    expect(text).toContain("流畅度 3.4");
    expect(text).toContain("fox");
    expect(text).toContain("漏读了 brown");
    // 短板维度片段是 warn 强调
    expect(d.segments.some((s) => s.kind === "warn" && s.text.includes(DIM_LABELS.fluency))).toBe(true);
  });

  it("过关：pass 徽章 + 轻量正向文案，不再列问题清单", () => {
    const words = [word("the", 4.9), word("quick", 4.6), word("brown", 4.8), word("fox", 4.4)];
    const r = result({ total: 4.7, accuracy: 4.8, fluency: 4.6, integrity: 5 }, words);
    const d = diagnoseShadow(r, mapWordsToText("The quick brown fox.", words));
    expect(d.pass).toBe(true);
    expect(d.badgeKind).toBe("pass");
    expect(d.drillWords).toEqual([]);
    const text = d.segments.map((s) => s.text).join("");
    expect(text).not.toContain("漏读");
    expect(text).not.toContain("不准");
  });

  it("明显不足：fail 徽章；短板缺口不足 0.4 时不硬点名维度", () => {
    const words = [word("the", 3.0)];
    const r = result({ total: 2.8, accuracy: 4.7, fluency: 4.75, integrity: 4.7 }, words);
    const d = diagnoseShadow(r, mapWordsToText("The end.", [...words, word("end", 2.9)]));
    expect(d.badgeKind).toBe("fail");
    expect(d.badge).toBe("再练练");
    expect(d.weakDim).toBeNull();
  });

  it("差词超过 4 个时聚焦前 4 个（按出现序，差词优先于漏词）", () => {
    const words = [word("a", 1), word("b", 1), word("c", 0, 16), word("d", 1), word("e", 1), word("f", 0, 16)];
    const marks = mapWordsToText("a b c d e f", words);
    const d = diagnoseShadow(result({ total: 2.5 }, words), marks);
    expect(d.drillWords).toEqual(["a", "b", "d", "e"]);
    expect(d.badCount).toBe(4);
    expect(d.missedCount).toBe(2);
  });
});

describe("音素提示", () => {
  it("worstPhoneOf 取惩罚最重且 |gwpp| ≥ 0.4 的音素", () => {
    const w: WordScore = {
      content: "latte",
      totalScore: 2.4,
      dpMessage: 0,
      sylls: [
        {
          content: "l aa t ey",
          syllScore: 2.1,
          serrMsg: 0,
          phones: [
            { content: "l", dpMessage: 0, gwpp: -0.01 },
            { content: "aa", dpMessage: 0, gwpp: -1.9 },
            { content: "t", dpMessage: 0, gwpp: -0.05 },
            { content: "ey", dpMessage: 0, gwpp: -0.1 },
          ],
        },
      ],
    };
    const worst = worstPhoneOf(w);
    expect(worst?.content).toBe("aa");
    // 都很轻微 → 不点名
    const clean: WordScore = {
      ...w,
      sylls: [{ ...w.sylls[0], phones: w.sylls[0].phones.map((p) => ({ ...p, gwpp: -0.05 })) }],
    };
    expect(worstPhoneOf(clean)).toBeNull();
    expect(worstPhoneOf(undefined)).toBeNull();
  });

  it("常见问题音素有人话提示，未命中走兜底", () => {
    expect(phoneTip("dh")).toContain("齿");
    expect(phoneTip("ih")).toContain("短");
    expect(phoneTip("xx")).toContain("领读");
  });
});
