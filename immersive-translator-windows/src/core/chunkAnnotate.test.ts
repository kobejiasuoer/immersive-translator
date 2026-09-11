import { describe, expect, it } from "vitest";
import {
  blankChunkInSentence,
  buildChunkBatchInput,
  buildSentenceSpans,
  chunkBatches,
  findChunkRange,
  parseChunkResponse,
  splitBySpans,
} from "./chunkAnnotate";

describe("chunkBatches / buildChunkBatchInput", () => {
  it("按批次切分并生成编号行", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ idx: i, en: `S${i}.` }));
    const batches = chunkBatches(items, 10);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(buildChunkBatchInput(batches[0]!.slice(0, 2))).toBe("0| S0.\n1| S1.");
    expect(chunkBatches([])).toEqual([]);
  });
});

describe("findChunkRange（三档回退）", () => {
  const en = "Speed was the goal, and the campaign took on momentum.";

  it("精确匹配", () => {
    expect(findChunkRange(en, "took on momentum")).toEqual({ start: 37, end: 53 });
  });

  it("忽略大小写", () => {
    expect(findChunkRange(en, "Took On Momentum")).toEqual({ start: 37, end: 53 });
  });

  it("空格弹性（换行/多空格折叠）", () => {
    expect(findChunkRange(en, "took  on   momentum")).toEqual({ start: 37, end: 53 });
    expect(findChunkRange("a\tb", "a b")).toEqual({ start: 0, end: 3 });
  });

  it("定位不到返回 null（宁漏勿错）", () => {
    expect(findChunkRange(en, "gained momentum")).toBeNull();
    expect(findChunkRange(en, "")).toBeNull();
  });
});

describe("parseChunkResponse", () => {
  const batch = [
    { idx: 0, en: "Speed was the goal, and the campaign took on momentum." },
    { idx: 1, en: "In the wake of the scandal, he settled in quietly." },
  ];

  it("解析合法响应并定位校验", () => {
    const raw = JSON.stringify({
      items: [
        { i: 0, chunks: [{ text: "took on momentum", type: "collocation", gloss: "获得动力", pattern: "take on sth", trap: "make momentum" }] },
        { i: 1, chunks: [{ text: "in the wake of", type: "idiom", gloss: "在……的余波中" }, { text: "settled in", type: "phrasal", gloss: "安顿下来" }] },
      ],
    });
    const byIdx = parseChunkResponse(raw, batch);
    expect(byIdx.get(0)).toEqual([
      { text: "took on momentum", chunkType: "collocation", gloss: "获得动力", pattern: "take on sth", trap: "make momentum" },
    ]);
    expect(byIdx.get(1)).toHaveLength(2);
    expect(byIdx.get(1)![1]).toEqual({ text: "settled in", chunkType: "phrasal", gloss: "安顿下来" });
  });

  it("对位失败/非法的词块被丢弃，模型编造的句号被忽略", () => {
    const raw = JSON.stringify({
      items: [
        {
          i: 0,
          chunks: [
            { text: "gained momentum", type: "collocation", gloss: "不存在于句中" },
            { text: "the goal", type: "collocation" }, // 无 gloss
            { text: "Speed was", type: "collocation", gloss: "ok" }, // 合法，保留
          ],
        },
        { i: 99, chunks: [{ text: "ghost", type: "idiom", gloss: "句号不存在" }] },
      ],
    });
    const byIdx = parseChunkResponse(raw, batch);
    expect(byIdx.get(0)).toEqual([{ text: "Speed was", chunkType: "collocation", gloss: "ok" }]);
    expect(byIdx.has(99)).toBe(false);
  });

  it("每句截断到 3 个、同义去重、未知类型回落 collocation", () => {
    const raw = JSON.stringify({
      items: [
        {
          i: 0,
          chunks: [
            { text: "Speed", type: "weird-type", gloss: "1" },
            { text: "speed", type: "collocation", gloss: "dup" }, // 归一化重复
            { text: "the goal", type: "collocation", gloss: "2" },
            { text: "took on momentum", type: "collocation", gloss: "3" },
            { text: "campaign", type: "collocation", gloss: "4" }, // 超出 3 个被截
          ],
        },
      ],
    });
    const byIdx = parseChunkResponse(raw, batch);
    expect(byIdx.get(0)!.map((c) => c.gloss)).toEqual(["1", "2", "3"]);
    expect(byIdx.get(0)![0].chunkType).toBe("collocation");
  });

  it("非 JSON / 缺 items 返回空 Map", () => {
    expect(parseChunkResponse("not json at all", batch).size).toBe(0);
    expect(parseChunkResponse('{"nope":1}', batch).size).toBe(0);
  });

  it("剥掉 markdown 围栏", () => {
    const raw = '```json\n{"items":[{"i":0,"chunks":[{"text":"the goal","type":"collocation","gloss":"目标"}]}]}\n```';
    expect(parseChunkResponse(raw, batch).get(0)).toHaveLength(1);
  });
});

describe("buildSentenceSpans / splitBySpans", () => {
  const en = "Speed was the goal, and the campaign took on momentum.";
  const chunk = { text: "took on momentum", chunkType: "collocation" as const, gloss: "获得动力" };

  it("词块 + 已知生词合并，不重叠", () => {
    const spans = buildSentenceSpans(en, [chunk], new Set(["speed"]));
    expect(spans.map((s) => [s.start, s.end, s.kind])).toEqual([
      [0, 5, "known"], // speed 再现
      [37, 53, "chunk"],
    ]);
    const segs = splitBySpans(en, spans);
    expect(segs[0]).toEqual({ text: "Speed", span: spans[0] });
    expect(segs[1]).toEqual({ text: " was the goal, and the campaign " });
    expect(segs[2]).toEqual({ text: "took on momentum", span: spans[1] });
    expect(segs[3]).toEqual({ text: "." });
  });

  it("词块在生词本里 → 归为 known 且保留 chunk 数据", () => {
    const spans = buildSentenceSpans(en, [chunk], new Set(["took on momentum"]));
    const hit = spans.find((s) => s.chunk);
    expect(hit?.kind).toBe("known");
    expect(hit?.chunk?.gloss).toBe("获得动力");
  });

  it("重叠时先长后短贪心：known 单词让位更长的词块", () => {
    const spans = buildSentenceSpans(en, [chunk], new Set(["momentum"]));
    const inner = spans.find((s) => en.slice(s.start, s.end) === "momentum");
    expect(inner).toBeUndefined(); // 被词块整体吞掉
  });

  it("多词生词的空格弹性再现", () => {
    const spans = buildSentenceSpans("He took  on momentum fast.", undefined, new Set(["took on momentum"]));
    expect(spans).toEqual([{ start: 3, end: 20, kind: "known" }]);
  });

  it("词内命中不算（词边界）", () => {
    expect(buildSentenceSpans("The assessment began.", undefined, new Set(["assess"]))).toEqual([]);
  });

  it("空输入安全", () => {
    expect(buildSentenceSpans(en, undefined, new Set())).toEqual([]);
    expect(splitBySpans(en, [])).toEqual([{ text: en }]);
  });
});

describe("blankChunkInSentence", () => {
  it("挖掉首次出现并保留其余原文", () => {
    expect(blankChunkInSentence("The campaign took on momentum fast.", "took on momentum")).toBe(
      "The campaign ▁▁▁▁ fast.",
    );
  });

  it("定位不到原样返回", () => {
    expect(blankChunkInSentence("Nothing here.", "took on momentum")).toBe("Nothing here.");
  });
});
