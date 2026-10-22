import { describe, expect, it } from "vitest";
import { buildSentenceSpans } from "./chunkAnnotate";
import type { ChunkSpan } from "./chunkAnnotate";
import { clozeVerdictToGrade, pickClozeSlots } from "./clozeSlots";

const S0 = "The tide is still making up its mind.";
const S1 = "For forty years the town slumbered quietly.";
const S2 = "Now cranes swing over the locks again.";
const S3 = "It began with a single act of stubbornness.";

const SENTS = [
  { idx: 0, en: S0, paragraphIdx: 0 },
  { idx: 1, en: S1, paragraphIdx: 0 },
  { idx: 2, en: S2, paragraphIdx: 1 },
  { idx: 3, en: S3, paragraphIdx: 1 },
];

/** 用子串定位构造跨度，偏移量交给 indexOf，避免手数出错。 */
function spanOf(en: string, phrase: string, kind: ChunkSpan["kind"], trap?: string): ChunkSpan {
  const start = en.indexOf(phrase);
  if (start < 0) throw new Error(`phrase not found: ${phrase}`);
  return { start, end: start + phrase.length, kind, ...(trap ? { chunk: { text: phrase, chunkType: "idiom", gloss: "", trap } } : {}) };
}

describe("pickClozeSlots（随读抽查选槽）", () => {
  it("只挖已读句（watermark 之后的句子不入选）", () => {
    const spans = new Map<number, ChunkSpan[]>([
      [0, [spanOf(S0, "making up its mind", "chunk")]],
      [3, [spanOf(S3, "stubbornness", "chunk")]],
    ]);
    const slots = pickClozeSlots(spans, SENTS, 0);
    expect([...slots.keys()]).toEqual([0]);
    expect(slots.get(0)?.answer).toBe("making up its mind");
  });

  it("每段最多一槽，段内取权重最高者", () => {
    const spans = new Map<number, ChunkSpan[]>([
      [0, [spanOf(S0, "making up its mind", "chunk")]], // 段 0：普通词块
      [1, [spanOf(S1, "slumbered", "known")]], // 段 0：known 权重最高
      [2, [spanOf(S2, "cranes", "chunk")]], // 段 1：普通
      [3, [spanOf(S3, "stubbornness", "chunk", "直译陷阱")]], // 段 1：带陷阱
    ]);
    const slots = pickClozeSlots(spans, SENTS, 3);
    expect([...slots.keys()].sort()).toEqual([1, 3]);
    expect(slots.get(1)?.isKnown).toBe(true);
    expect(slots.get(3)?.trap).toBe("直译陷阱");
  });

  it("known 优先于普通词块，同段落只出一个", () => {
    const spans = new Map<number, ChunkSpan[]>([
      [0, [spanOf(S0, "slumbered".slice(0, 0) + "making up its mind", "chunk")]],
      [1, [spanOf(S1, "slumbered", "known")]],
    ]);
    const slots = pickClozeSlots(spans, SENTS, 1);
    expect(slots.get(1)?.isKnown).toBe(true);
    expect(slots.get(1)?.vocabId).toBe("slumbered");
    expect(slots.has(0)).toBe(false); // 同段已用完名额
  });

  it("太短 / 太长 / 非纯英文的跨度不挖", () => {
    const en = "He ran far and it was extraordinarily remarkable today, sure.";
    const spans = new Map<number, ChunkSpan[]>([
      [0, [spanOf(en, "ran", "chunk"), spanOf(en, "far and it was extraordinarily remarkable", "chunk"), spanOf(en, "sure", "chunk")]],
    ]);
    const slots = pickClozeSlots(spans, [{ idx: 0, en, paragraphIdx: 0 }], 0);
    expect(slots.size).toBe(1);
    const answer = [...slots.values()][0]!.answer;
    expect(["ran", "sure"]).toContain(answer);
  });

  it("槽 id 稳定（句号 + 起点），跨次计算一致", () => {
    const spans = new Map<number, ChunkSpan[]>([[0, [spanOf(S0, "making up its mind", "chunk")]]]);
    const a = pickClozeSlots(spans, SENTS, 2);
    const b = pickClozeSlots(spans, SENTS, 2);
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect(a.get(0)?.id).toBe(`0:${S0.indexOf("making")}`);
  });

  it("无跨度 / 全部未读到 → 空集", () => {
    expect(pickClozeSlots(new Map(), SENTS, 3).size).toBe(0);
    const spans = new Map<number, ChunkSpan[]>([[0, [spanOf(S0, "making up its mind", "chunk")]]]);
    expect(pickClozeSlots(spans, SENTS, -1).size).toBe(0);
  });

  it("与 buildSentenceSpans 串联：真实跨度可选出槽", () => {
    const en = "Nobody will tell you the revival was engineered from above.";
    const chunks = [
      { text: "engineered from above", chunkType: "collocation" as const, gloss: "自上而下策划", trap: "从上面工程" },
    ];
    const arr = buildSentenceSpans(en, chunks, new Set(["engineered from above"]));
    const spans = new Map<number, ChunkSpan[]>([[0, arr]]);
    const slots = pickClozeSlots(spans, [{ idx: 0, en, paragraphIdx: 0 }], 0);
    const slot = slots.get(0);
    expect(slot?.answer).toBe("engineered from above");
    expect(slot?.isKnown).toBe(true);
    expect(slot?.vocabId).toBe("engineered from above");
  });
});

describe("clozeVerdictToGrade（SRS 限幅）", () => {
  it("perfect 最高只记 good，不记 easy", () => {
    expect(clozeVerdictToGrade("perfect")).toBe("good");
  });
  it("close 记 hard（差一点 = 提前再见）", () => {
    expect(clozeVerdictToGrade("close")).toBe("hard");
  });
  it("trap / wrong 记 forgot（进错题桶）", () => {
    expect(clozeVerdictToGrade("trap")).toBe("forgot");
    expect(clozeVerdictToGrade("wrong")).toBe("forgot");
  });
});
