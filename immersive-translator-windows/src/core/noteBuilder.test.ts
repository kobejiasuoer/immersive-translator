import { describe, expect, it } from "vitest";
import {
  buildNoteMaterials,
  buildNoteUserInput,
  buildNoteSystemPrompt,
  buildReplayInput,
  buildReplaySystemPrompt,
  defaultNoteSelection,
  findWordByHeading,
  isStillWeak,
  noteBaseName,
  parseReplay,
  recallBucket,
  recallSummary,
  verifyNoteWords,
  verifyReplayWords,
} from "./noteBuilder";
import { initialSrs } from "./readerSrs";
import type { Article, RecallStat, VocabWord } from "./readerTypes";

function word(over: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    kind: "word",
    senses: [],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(0),
    addedAt: 0,
    ...over,
  };
}

function recallStat(over: {
  pass?: number;
  wrong?: number;
  trap?: number;
  clozeWrong?: number;
}): RecallStat {
  return {
    total: {
      pass: over.pass ?? 0,
      wrong: over.wrong ?? 0,
      trap: over.trap ?? 0,
    },
    byMode: {
      cloze: {
        pass: 0,
        wrong: over.clozeWrong ?? 0,
        trap: 0,
      },
    },
    lastAt: 1_700_000_000_000,
  };
}

describe("recallBucket", () => {
  it("判分结论优先：trap 即使最终评 hard 也归 trap", () => {
    expect(recallBucket("cloze", "trap", "hard")).toBe("trap");
    expect(recallBucket("cloze", "wrong", "hard")).toBe("wrong");
    expect(recallBucket("cloze", "perfect", "easy")).toBe("pass");
    expect(recallBucket("cloze", "close", "good")).toBe("pass");
  });

  it("识别卡无判分，按最终评分归桶", () => {
    expect(recallBucket("recognition", null, "forgot")).toBe("wrong");
    expect(recallBucket("recognition", null, "good")).toBe("pass");
  });
});

describe("isStillWeak（笔记库与 AI 复盘的统一口径）", () => {
  it("从没测过的词算仍错，不算「已过」", () => {
    expect(isStillWeak(word({ id: "a", word: "a" }))).toBe(true);
    expect(isStillWeak(word({ id: "b", word: "b", recall: recallStat({}) }))).toBe(true);
  });

  it("错+陷阱多于过 → 仍错；反之为已过", () => {
    expect(isStillWeak(word({ id: "c", word: "c", recall: recallStat({ pass: 1, wrong: 2 }) }))).toBe(true);
    expect(isStillWeak(word({ id: "d", word: "d", recall: recallStat({ pass: 1, trap: 2 }) }))).toBe(true);
    expect(isStillWeak(word({ id: "e", word: "e", recall: recallStat({ pass: 3, wrong: 1, trap: 1 }) }))).toBe(false);
    // 平局（错+陷阱 == 过）与笔记库实时口径一致：算已过
    expect(isStillWeak(word({ id: "f", word: "f", recall: recallStat({ pass: 1, trap: 1 }) }))).toBe(false);
  });
});

describe("recallSummary / buildNoteMaterials", () => {
  it("无 recall 记录的材料不带 stats（缺字段 = 没有）", () => {
    const [m] = buildNoteMaterials([word({ id: "bare", word: "bare" })], new Map());
    expect(m.stats).toBeUndefined();
    expect(recallSummary(word({ id: "bare", word: "bare" }))).toBeUndefined();
  });

  it("带 recall 的词条把统计投影进材料", () => {
    const w = word({
      id: "inconsistencies",
      word: "inconsistencies",
      srs: { ...initialSrs(0), reps: 4, lapses: 3, intervalDays: 0 },
      recall: recallStat({ pass: 1, wrong: 3, clozeWrong: 2 }),
    });
    const summary = recallSummary(w);
    expect(summary?.total).toEqual({ pass: 1, wrong: 3, trap: 0 });
    expect(summary?.byMode.cloze.wrong).toBe(2);
    const [m] = buildNoteMaterials([w], new Map());
    expect(m.stats?.total.wrong).toBe(3);
    expect(m.stats?.lapses).toBe(3);
  });
});

describe("defaultNoteSelection", () => {
  it("默认只选未掌握（intervalDays < 7）", () => {
    const words = [
      word({ id: "new", word: "new", srs: { ...initialSrs(0), intervalDays: 0 } }),
      word({ id: "familiar", word: "familiar", srs: { ...initialSrs(0), intervalDays: 3 } }),
      word({ id: "mastered", word: "mastered", srs: { ...initialSrs(0), intervalDays: 7 } }),
      word({ id: "gone", word: "gone", srs: { ...initialSrs(0), intervalDays: 30 } }),
    ];
    const sel = defaultNoteSelection(words);
    expect([...sel].sort()).toEqual(["familiar", "new"]);
  });
});

describe("buildNoteMaterials", () => {
  const article: Pick<Article, "sentences"> = {
    sentences: [
      {
        idx: 0,
        paragraphIdx: 0,
        en: "It took on momentum quickly.",
        zh: null,
        zhState: "pending",
        chunks: [
          { text: "took on momentum", chunkType: "collocation", gloss: "获得动力", pattern: "take on sth" },
        ],
      },
    ],
  };

  it("文章例句与同句词块随词条进入材料", () => {
    const w = word({
      id: "take on momentum",
      word: "take on momentum",
      kind: "chunk",
      chunkType: "collocation",
      pattern: "take on sth",
      trap: "不是 make momentum",
    });
    const [m] = buildNoteMaterials([w], new Map([["a1", article]]));
    expect(m.example).toBe("It took on momentum quickly.");
    expect(m.sentenceChunks).toHaveLength(1);
    expect(m.pattern).toBe("take on sth");
    expect(m.trap).toBe("不是 make momentum");
  });

  it("文章缺失时退回划词收藏的 LLM 例句，找不到就不编", () => {
    const w = word({
      id: "solo",
      word: "solo",
      source: { articleId: "", sentenceIdx: 0 },
      example: { en: "He flew solo.", zh: null },
    });
    const [m] = buildNoteMaterials([w], new Map());
    expect(m.example).toBe("He flew solo.");
    expect(m.sentenceChunks).toBeUndefined();

    const bare = word({ id: "bare", word: "bare" });
    const [m2] = buildNoteMaterials([bare], new Map());
    expect(m2.example).toBeUndefined();
  });
});

describe("buildNoteUserInput / buildNoteSystemPrompt", () => {
  it("用户消息是合法 JSON 且只含真实词条（无幻觉输入面）", () => {
    const materials = buildNoteMaterials(
      [word({ id: "resilience", word: "resilience", phonetic: "/rɪˈzɪliəns/" })],
      new Map(),
    );
    const input = buildNoteUserInput(materials, Date.UTC(2026, 8, 15));
    const parsed = JSON.parse(input) as { words: { word: string }[] };
    expect(parsed.words.map((w) => w.word)).toEqual(["resilience"]);
    expect(input).toContain("resilience");
  });

  it("系统提示包含防幻觉硬规则、【批注】格式与错题数字约束", () => {
    const sys = buildNoteSystemPrompt();
    expect(sys).toContain("不得新增");
    expect(sys).toContain("不得编造");
    expect(sys).toContain("例句必须原样引用");
    expect(sys).toContain("【记不住】");
    expect(sys).toContain("【记法】");
    expect(sys).toContain("【测】");
    expect(sys).toContain("只能引用 stats 里的数字");
  });

  it("系统提示要求全程说人话（禁止程序术语进正文）", () => {
    const sys = buildNoteSystemPrompt();
    expect(sys).toContain("全程说人话");
    expect(sys).toContain("禁止");
    expect(sys).toContain("stats 说成");
    expect(sys).toContain("还没测过");
  });
});

describe("noteBaseName", () => {
  it("按本地日期命名（不含扩展名；同日多份由存储层去重）", () => {
    expect(noteBaseName(new Date(2026, 8, 15, 10, 0).getTime())).toBe("学词笔记-2026-09-15");
  });
});

describe("verifyNoteWords", () => {
  const words = [
    word({ id: "resilience", word: "resilience" }),
    word({ id: "take on momentum", word: "take on momentum" }),
  ];

  it("全部词条可溯源时通过", () => {
    const note = "# 复习笔记\n\n## 单词\n\n### resilience /rɪˈzɪliəns/\n\n内容。\n\n### take on momentum（搭配）\n\n内容。";
    expect(verifyNoteWords(note, words)).toEqual({ ok: true, unknownHeadings: [] });
  });

  it("编造的词条标题被点名", () => {
    const note = "### resilience\n\n### serendipity\n\n### take on momentum";
    const res = verifyNoteWords(note, words);
    expect(res.ok).toBe(false);
    expect(res.unknownHeadings).toEqual(["serendipity"]);
  });

  it("没有三级标题时通过（结构性问题不归本校验管）", () => {
    expect(verifyNoteWords("纯文本", words).ok).toBe(true);
  });
});

describe("AI 复盘 prompt / 解析", () => {
  const weak = [
    word({ id: "sourcing from", word: "sourcing from" }),
    word({ id: "inconsistent with", word: "inconsistent with" }),
  ];

  it("复盘输入带 weakIds 与最新统计", () => {
    const words = [
      word({
        id: "sourcing from",
        word: "sourcing from",
        trap: "不是「来源自」",
        recall: recallStat({ trap: 2 }),
      }),
      word({ id: "trade-off", word: "trade-off" }),
    ];
    const input = buildReplayInput(words, ["sourcing from"], "2026-09-16");
    const parsed = JSON.parse(input) as {
      weakIds: string[];
      words: { word: string; stats?: { total: { trap: number } } }[];
    };
    expect(parsed.weakIds).toEqual(["sourcing from"]);
    expect(parsed.words.find((w) => w.word === "sourcing from")?.stats?.total.trap).toBe(2);
    expect(parsed.words.find((w) => w.word === "trade-off")?.stats).toBeUndefined();
  });

  it("复盘系统提示约束数字来源与词头来源", () => {
    const sys = buildReplaySystemPrompt();
    expect(sys).toContain("只能引用 stats 里的数字");
    expect(sys).toContain("必须逐字来自 weakIds");
    expect(sys).toContain("【总结】");
    expect(sys).toContain("【仍错】");
    expect(sys).toContain("全程说人话");
  });

  it("解析【总结】与【仍错】行", () => {
    const text = "【总结】4 个词过了，2 个仍在错，薄弱点是搭配调不出。\n【仍错】sourcing from｜又答成「来源自」，改记主动句式 source sth from sb。\n【仍错】inconsistent with｜连续踩同一个陷阱，见到 with 先默念「对不上」。";
    const replay = parseReplay(text);
    expect(replay?.verdict).toContain("薄弱点是搭配调不出");
    expect(replay?.weak).toHaveLength(2);
    expect(replay?.weak[0]).toEqual({
      w: "sourcing from",
      why: "又答成「来源自」，改记主动句式 source sth from sb。",
    });
  });

  it("解析不到任何标记返回 null", () => {
    expect(parseReplay("模型跑题了，输出了一段散文")).toBeNull();
  });

  it("仍错词头可溯源校验：编造的词不通过", () => {
    expect(
      verifyReplayWords({ weak: [{ w: "sourcing from" }] }, weak),
    ).toBe(true);
    expect(
      verifyReplayWords({ weak: [{ w: "serendipity" }] }, weak),
    ).toBe(false);
  });
});

describe("findWordByHeading（复盘词头宽容回挂）", () => {
  const words = [
    word({ id: "w1", word: "get over" }),
    word({ id: "w2", word: "Commit" }),
  ];

  it("LLM 改了大小写/空格也能找回词条（精确相等会静默丢词）", () => {
    expect(findWordByHeading("commit", words)?.id).toBe("w2");
    expect(findWordByHeading("Get Over", words)?.id).toBe("w1");
  });

  it("词头带后缀说明时按互相包含匹配", () => {
    expect(findWordByHeading("commit（动词）", words)?.id).toBe("w2");
  });

  it("完全无关的词头返回 undefined", () => {
    expect(findWordByHeading("serendipity", words)).toBeUndefined();
    expect(findWordByHeading("   ", words)).toBeUndefined();
  });
});
