import { describe, expect, it } from "vitest";
import {
  dayKey,
  dueVocab,
  gradeSrs,
  heatBuckets,
  initialSrs,
  isDue,
  masteryStage,
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

describe("v0.8 内化三阶（masteryStage）", () => {
  it("s1 刚收集（intervalDays<1 且无 spokenAt）· s2 眼熟能认（intervalDays≥1）", () => {
    expect(masteryStage(makeWord("fresh", NOW, 0))).toBe("s1");
    expect(masteryStage(makeWord("familiar", NOW, 1))).toBe("s2");
    expect(masteryStage(makeWord("mastered", NOW, 7))).toBe("s2");
  });

  it("spokenAt 存在即升 s3（「在对话中说出」优先于间隔）", () => {
    // 新词当天就在口语里用出：s1 → s3，不被 intervalDays<1 压住
    const spokenFresh: VocabWord = { ...makeWord("spoken-fresh", NOW, 0), spokenAt: NOW - 1000 };
    expect(masteryStage(spokenFresh)).toBe("s3");
    // 熟词用出：s2 → s3
    const spokenFamiliar: VocabWord = { ...makeWord("spoken-fam", NOW, 7), spokenAt: NOW - 1000 };
    expect(masteryStage(spokenFamiliar)).toBe("s3");
  });
});

describe("v0.8 热力格（heatBuckets）", () => {
  it("近 28 天窗口：首格是 27 天前，末格是今天且带 today 标记", () => {
    const buckets = heatBuckets({ schemaVersion: 1, days: [] }, NOW);
    expect(buckets).toHaveLength(28);
    expect(buckets[27].dayKey).toBe(dayKey(NOW));
    expect(buckets[27].today).toBe(true);
    expect(buckets.filter((b) => b.today)).toHaveLength(1);
    // 首格 = 今天往前 27 天（跨月也按本地日期键推进）
    expect(buckets[0].dayKey).toBe("2026-08-14");
    expect(buckets[0].today).toBe(false);
  });

  it("分档：0 无记录 / <3 次 l1 / 3-6 次 l2 / >6 次 l3", () => {
    const today = dayKey(NOW);
    const log: ReviewLogFile = {
      schemaVersion: 1,
      days: [
        { day: today, count: 1 }, // l1
        { day: "2026-09-09", count: 3 }, // l2
        { day: "2026-09-08", count: 6 }, // l2（6 次仍在 3-6 档）
        { day: "2026-09-07", count: 7 }, // l3
        { day: "2026-01-01", count: 9 }, // 窗口外不计
      ],
    };
    const buckets = heatBuckets(log, NOW);
    expect(buckets.find((b) => b.dayKey === today)).toMatchObject({ level: 1, count: 1 });
    expect(buckets.find((b) => b.dayKey === "2026-09-09")?.level).toBe(2);
    expect(buckets.find((b) => b.dayKey === "2026-09-08")?.level).toBe(2);
    expect(buckets.find((b) => b.dayKey === "2026-09-07")).toMatchObject({ level: 3, count: 7 });
    // 没有记录的天是 level 0，窗口外的天不出现在窗口里
    expect(buckets.find((b) => b.dayKey === "2026-01-01")).toBeUndefined();
    expect(buckets.filter((b) => b.level === 0).length).toBe(28 - 4);
  });
});
