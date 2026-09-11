import { describe, expect, it } from "vitest";
import {
  dueVocab,
  gradeSrs,
  initialSrs,
  isDue,
  recordReview,
  reviewStats,
  type ReviewLogFile,
} from "./readerSrs";
import type { VocabWord } from "./readerTypes";

const NOW = new Date(2026, 8, 10, 10, 0, 0).getTime(); // 2026-09-10 本地 10:00

function makeWord(id: string, dueAt: number, intervalDays = 0): VocabWord {
  return {
    id,
    word: id,
    senses: [],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: { ease: 2.5, intervalDays, reps: 0, dueAt, lapses: 0 },
    addedAt: 0,
  };
}

describe("到期判定与计数同源（§9-3）", () => {
  it("dueVocab 只含到期词且按紧急度排序", () => {
    const vocab = [
      makeWord("later", NOW + 5000),
      makeWord("older-due", NOW - 9000),
      makeWord("newer-due", NOW - 1000),
    ];
    const due = dueVocab(vocab, NOW);
    expect(due.map((w) => w.id)).toEqual(["older-due", "newer-due"]);
  });

  it("isDue 边界：等于到期时间即到期", () => {
    expect(isDue(makeWord("a", NOW), NOW)).toBe(true);
    expect(isDue(makeWord("b", NOW + 1), NOW)).toBe(false);
  });

  it("reviewStats.dueNow 与 dueVocab 一致", () => {
    const vocab = [makeWord("a", NOW - 1), makeWord("b", NOW + 1)];
    const log: ReviewLogFile = { schemaVersion: 1, days: [] };
    const stats = reviewStats(vocab, log, NOW);
    expect(stats.dueNow).toBe(dueVocab(vocab, NOW).length);
    expect(stats.dueNow).toBe(1);
    expect(stats.total).toBe(2);
  });

  it("单词/词块分开计数（kind 缺省视为单词）", () => {
    const word = makeWord("speed", NOW - 1);
    const wordLater = makeWord("goal", NOW + 999_999);
    const chunk: VocabWord = {
      ...makeWord("take on momentum", NOW - 1),
      kind: "chunk",
      chunkType: "collocation",
    };
    const chunkLater: VocabWord = {
      ...makeWord("settle in", NOW + 999_999),
      kind: "chunk",
      chunkType: "phrasal",
    };
    const stats = reviewStats([word, wordLater, chunk, chunkLater], { schemaVersion: 1, days: [] }, NOW);
    expect(stats.total).toBe(4);
    expect(stats.totalWords).toBe(2);
    expect(stats.totalChunks).toBe(2);
    expect(stats.dueWords).toBe(1);
    expect(stats.dueChunks).toBe(1);
  });
});

describe("四档评分", () => {
  it("间隔为文档定值：10 分钟 / 1 天 / 3 天 / 7 天", () => {
    const srs = initialSrs(NOW);
    expect(gradeSrs(srs, "forgot", NOW).dueAt - NOW).toBe(10 * 60 * 1000);
    expect(gradeSrs(srs, "hard", NOW).dueAt - NOW).toBe(24 * 60 * 60 * 1000);
    expect(gradeSrs(srs, "good", NOW).dueAt - NOW).toBe(3 * 24 * 60 * 60 * 1000);
    expect(gradeSrs(srs, "easy", NOW).dueAt - NOW).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("忘记会累计 lapses 且 ease 下降；简单则上升；ease 有边界", () => {
    const srs = initialSrs(NOW);
    const forgot = gradeSrs(srs, "forgot", NOW);
    expect(forgot.lapses).toBe(1);
    expect(forgot.ease).toBeCloseTo(2.3);
    const easy = gradeSrs(srs, "easy", NOW);
    expect(easy.lapses).toBe(0);
    expect(easy.ease).toBeCloseTo(2.65);
    let s = srs;
    for (let i = 0; i < 20; i++) s = gradeSrs(s, "forgot", NOW);
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
    s = srs;
    for (let i = 0; i < 20; i++) s = gradeSrs(s, "easy", NOW);
    expect(s.ease).toBeLessThanOrEqual(2.8);
  });

  it("不修改入参", () => {
    const srs = initialSrs(NOW);
    gradeSrs(srs, "hard", NOW);
    expect(srs.reps).toBe(0);
  });
});

describe("打卡与 streak", () => {
  it("今天没打卡但从昨天连续", () => {
    const log: ReviewLogFile = {
      schemaVersion: 1,
      days: [
        { day: "2026-09-08", count: 1 },
        { day: "2026-09-09", count: 2 },
      ],
    };
    expect(reviewStats([], log, NOW).streak).toBe(2);
  });

  it("记录评分落到今天", () => {
    const log: ReviewLogFile = { schemaVersion: 1, days: [] };
    const updated = recordReview(log, NOW);
    const stats = reviewStats([], updated, NOW);
    expect(stats.reviewedToday).toBe(1);
    expect(stats.streak).toBe(1);
  });

  it("中间断一天则断签", () => {
    // 今天 09-10 没打卡 → 从昨天 09-09 数：09-09、09-08 连续，09-06 断。
    const log: ReviewLogFile = {
      schemaVersion: 1,
      days: [
        { day: "2026-09-06", count: 1 },
        { day: "2026-09-08", count: 1 },
        { day: "2026-09-09", count: 1 },
      ],
    };
    expect(reviewStats([], log, NOW).streak).toBe(2);
  });

  it("今天和昨天都没打卡则 streak 归零", () => {
    const log: ReviewLogFile = {
      schemaVersion: 1,
      days: [{ day: "2026-09-08", count: 1 }],
    };
    expect(reviewStats([], log, NOW).streak).toBe(0);
  });

  it("掌握度分布按当前间隔分桶", () => {
    const vocab = [
      makeWord("l", NOW, 0),
      makeWord("f", NOW, 3),
      makeWord("m", NOW, 7),
    ];
    expect(reviewStats(vocab, { schemaVersion: 1, days: [] }, NOW).distribution).toEqual({
      learning: 1,
      familiar: 1,
      mastered: 1,
    });
  });
});
