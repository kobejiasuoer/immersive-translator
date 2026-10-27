import { describe, expect, it } from "vitest";
import {
  annotateSegments,
  filterScenarioPreview,
  findTargetSpans,
  friendlyNotice,
  micTip,
  nextTargetKey,
  scenarioCategoryCounts,
  scenarioSummary,
  scorePct,
  scoreTone,
  targetProgress,
  worstPhoneIdx,
} from "./speakUi";
import { textHitsTarget, type SpeakScenario, type SpeakScenarioCategory } from "./speakLogic";

describe("targetProgress", () => {
  it("没有目标词时不显示进度", () => {
    expect(targetProgress(0, 0)).toBeNull();
    expect(targetProgress(3, -1)).toBeNull();
  });
  it("给出文案与百分比", () => {
    expect(targetProgress(2, 5)).toEqual({ hit: 2, total: 5, pct: 40, label: "已用上 2 / 5 个词" });
    expect(targetProgress(0, 5)?.pct).toBe(0);
    expect(targetProgress(5, 5)?.pct).toBe(100);
  });
  it("命中数越界时夹到 [0, total]", () => {
    expect(targetProgress(9, 5)?.hit).toBe(5);
    expect(targetProgress(-2, 5)?.hit).toBe(0);
  });
});

describe("nextTargetKey", () => {
  it("返回第一个还没用上的词", () => {
    expect(nextTargetKey(["a", "b", "c"], new Set(["a"]))).toBe("b");
    expect(nextTargetKey(["a", "b", "c"], new Set())).toBe("a");
  });
  it("全部用上或为空时返回 null", () => {
    expect(nextTargetKey(["a", "b"], new Set(["a", "b"]))).toBeNull();
    expect(nextTargetKey([], new Set())).toBeNull();
  });
  it("按传入顺序而不是命中集合顺序", () => {
    expect(nextTargetKey(["x", "y", "z"], new Set(["y", "x"]))).toBe("z");
  });
});

describe("friendlyNotice（输入取自 SpeakView / useShadowAssess 真实报错文案）", () => {
  it("麦克风打不开 → mic，保留原文供悬浮查看", () => {
    const raw = "麦克风打不开（NotAllowedError）：Permission denied";
    const n = friendlyNotice(raw);
    expect(n.kind).toBe("mic");
    expect(n.detail).toBe(raw);
    expect(n.message).not.toContain("NotAllowedError");
  });
  it("没听到声音（跟读评测）→ mic", () => {
    const n = friendlyNotice("没听到声音——检查设置里的麦克风选择（可能选中了虚拟设备）");
    expect(n.kind).toBe("mic");
  });
  it("「打不开」和「没听到」是两种原因，文案不能混用", () => {
    const cantOpen = friendlyNotice("麦克风打不开（NotAllowedError）：Permission denied");
    const silent = friendlyNotice("没听到声音，离麦克风近一点");
    expect(cantOpen.message).toContain("没能打开");
    expect(cantOpen.message).not.toContain("声音偏小");
    expect(silent.message).toContain("没听清");
    expect(cantOpen.message).not.toBe(silent.message);
  });
  it("未配置凭据 → credential，文案原样保留（本身已可行动）", () => {
    const raw = "未配置讯飞听写凭据：到 设置 → 语音 里填一次（或复用跟读评测那组）";
    const n = friendlyNotice(raw);
    expect(n.kind).toBe("credential");
    expect(n.message).toBe(raw);
  });
  it("识别/回复失败 → network", () => {
    expect(friendlyNotice("语音识别失败：Network Error").kind).toBe("network");
    expect(friendlyNotice("回复生成失败：timeout").kind).toBe("network");
  });
  it("其余文案 → other，原样透出", () => {
    const skipped = friendlyNotice("已跳过这次回复，接着说下一句");
    expect(skipped).toMatchObject({ kind: "other", message: "已跳过这次回复，接着说下一句" });
    expect(friendlyNotice("回复格式异常，重试一次").kind).toBe("other");
  });
  it("空串不抛错", () => {
    expect(friendlyNotice("").kind).toBe("other");
  });
});

describe("scorePct", () => {
  it("5 分制换算百分比并夹取", () => {
    expect(scorePct(4.3)).toBe(86);
    expect(scorePct(5)).toBe(100);
    expect(scorePct(0)).toBe(0);
    expect(scorePct(7)).toBe(100);
    expect(scorePct(-1)).toBe(0);
  });
  it("非有限数按 0", () => {
    expect(scorePct(Number.NaN)).toBe(0);
  });
});

describe("findTargetSpans", () => {
  const cut = (text: string, target: string) =>
    findTargetSpans(text, target).map((s) => text.slice(s.start, s.end));

  it("返回原文里命中的字符区间", () => {
    expect(cut("I would give all the volunteers the same guide", "volunteers")).toEqual(["volunteers"]);
  });
  it("多词词块整体命中，区间覆盖首尾词", () => {
    expect(cut("so their answers are not inconsistent with each other", "inconsistent with")).toEqual([
      "inconsistent with",
    ]);
  });
  it("末词容忍屈折，区间取实际说出的形式", () => {
    expect(cut("He standardizes it, then standardized again", "standardize")).toEqual([
      "standardizes",
      "standardized",
    ]);
  });
  it("标点不进区间、大小写不敏感", () => {
    expect(cut("Volunteers, please wait.", "volunteers")).toEqual(["Volunteers"]);
  });
  it("中间词不容忍屈折", () => {
    expect(cut("fixing the command", "fix the command")).toEqual([]);
  });
  it("空目标 / 无命中返回空数组", () => {
    expect(findTargetSpans("hello world", "")).toEqual([]);
    expect(findTargetSpans("hello world", "volunteers")).toEqual([]);
    expect(findTargetSpans("", "volunteers")).toEqual([]);
  });
  it("与 textHitsTarget 判定一致（芯片打勾和句内高亮不会打架）", () => {
    const cases: [string, string][] = [
      ["I would give all the volunteers the same guide", "volunteers"],
      ["so their answers are not inconsistent with each other", "inconsistent with"],
      ["He standardizes it", "standardize"],
      ["making a rule", "make"],
      ["fixing the command", "fix the command"],
      ["It's well-known that", "well-known"],
      ["I like volunteer work", "volunteers"],
      ["Inconsistencies are bad", "inconsistency"],
      ["", "x"],
      ["hello", ""],
    ];
    for (const [text, target] of cases) {
      expect(findTargetSpans(text, target).length > 0, `${text} / ${target}`).toBe(textHitsTarget(text, target));
    }
  });
});

describe("annotateSegments", () => {
  it("按两层区间的边界切段，并合并属性相同的相邻段", () => {
    // "I love cats"：love=[2,6) 是发音标记，[2,11) 是目标词块
    expect(annotateSegments("I love cats", [{ start: 2, end: 6 }], [{ start: 2, end: 11 }])).toEqual([
      { start: 0, end: 2, markIdx: -1, target: false },
      { start: 2, end: 6, markIdx: 0, target: true },
      { start: 6, end: 11, markIdx: -1, target: true },
    ]);
  });
  it("没有任何区间时整段原样返回", () => {
    expect(annotateSegments("hello", [], [])).toEqual([{ start: 0, end: 5, markIdx: -1, target: false }]);
  });
  it("空文本返回空数组", () => {
    expect(annotateSegments("", [{ start: 0, end: 3 }], [])).toEqual([]);
  });
  it("越界区间被夹取，不产生空段", () => {
    const segs = annotateSegments("abc", [{ start: -5, end: 99 }], []);
    expect(segs).toEqual([{ start: 0, end: 3, markIdx: 0, target: false }]);
  });
  it("markIdx 指向传入数组下标", () => {
    const segs = annotateSegments("one two", [{ start: 0, end: 3 }, { start: 4, end: 7 }], []);
    expect(segs.filter((s) => s.markIdx >= 0).map((s) => s.markIdx)).toEqual([0, 1]);
  });
});

describe("scoreTone（阈值与 mapWordsToText 的词着色一致：≥4 好 / ≥3 一般 / 其余差）", () => {
  it("边界值", () => {
    expect(scoreTone(5)).toBe("good");
    expect(scoreTone(4)).toBe("good");
    expect(scoreTone(3.99)).toBe("ok");
    expect(scoreTone(3)).toBe("ok");
    expect(scoreTone(2.99)).toBe("bad");
    expect(scoreTone(0)).toBe("bad");
  });
  it("非有限数按差处理", () => {
    expect(scoreTone(Number.NaN)).toBe("bad");
  });
});

describe("micTip（麦克风按钮下方的一句话提示）", () => {
  const base = { shadowBusy: false, hasSpoken: false };
  it("录音中：说明怎么发送和取消", () => {
    const t = micTip("recording", base);
    expect(t).toContain("再点");
    expect(t).toContain("Esc");
  });
  it("识别 / 回复 / 播报各自一句", () => {
    expect(micTip("asr", base)).toContain("识别中");
    expect(micTip("thinking", base)).toContain("对方回复中");
    expect(micTip("speaking", base)).toContain("插话");
  });
  it("空闲：第一次引导开口，之后引导继续", () => {
    expect(micTip("idle", base)).toContain("用英语回答");
    expect(micTip("idle", { ...base, hasSpoken: true })).toContain("继续回答");
  });
  it("出错后的空闲态提示重说一次", () => {
    expect(micTip("error", base)).toContain("再说一次");
  });
  it("跟读占用麦克风时优先说明原因", () => {
    expect(micTip("idle", { ...base, shadowBusy: true })).toContain("跟读");
  });
  it("每个文案都不为空", () => {
    for (const p of ["idle", "recording", "asr", "thinking", "speaking", "error"] as const) {
      expect(micTip(p, base).length).toBeGreaterThan(0);
    }
  });
});

describe("worstPhoneIdx（展平音素后，gwpp 惩罚最重的那个的下标）", () => {
  const word = (...gwpps: number[][]) => ({
    sylls: gwpps.map((g) => ({ phones: g.map((gwpp, i) => ({ content: `p${i}`, gwpp })) })),
  });
  it("单音节：返回惩罚最重的音素下标", () => {
    expect(worstPhoneIdx(word([-0.02, -0.1, -1.6]))).toBe(2);
  });
  it("多音节：下标按展平后的顺序计", () => {
    expect(worstPhoneIdx(word([-0.1, -0.2], [-0.05, -1.2, -0.3]))).toBe(3);
  });
  it("没有明显出错的音素（都轻于 -0.4）：回到第一个", () => {
    expect(worstPhoneIdx(word([-0.1, -0.3, -0.2]))).toBe(0);
  });
  it("并列最差取靠前的", () => {
    expect(worstPhoneIdx(word([-1, -1]))).toBe(0);
  });
  it("没有音素 / 没有词：0", () => {
    expect(worstPhoneIdx(word())).toBe(0);
    expect(worstPhoneIdx(word([]))).toBe(0);
    expect(worstPhoneIdx(undefined)).toBe(0);
  });
});

// ---- 场景中心目录卡（官方库筛选/截断与摘要取值） ----

/** 与 speakLogic.test.ts 的 makeScenario 同款骨架（speakUi 侧独立一份，不跨文件借用）。 */
function makeScenario(id: string, category: SpeakScenarioCategory = "daily"): SpeakScenario {
  return {
    id,
    source: "official",
    title: `title-${id}`,
    category,
    aiRole: `你扮演……（${id}）`,
    opener: `opener-${id}`,
    updatedAt: 1,
  };
}

describe("scenarioSummary（紧凑卡摘要：goal 优先，aiRole 兜底）", () => {
  it("有 goal 用 goal（官方目录当前 30/30 全量填充）", () => {
    expect(scenarioSummary({ goal: "说清症状、听懂追问", aiRole: "你扮演全科医生……" })).toBe(
      "说清症状、听懂追问",
    );
  });
  it("goal 缺失或全是空白时回退 aiRole", () => {
    expect(scenarioSummary({ aiRole: "你扮演发型师……" })).toBe("你扮演发型师……");
    expect(scenarioSummary({ goal: "  ", aiRole: "你扮演发型师……" })).toBe("你扮演发型师……");
  });
});

describe("scenarioCategoryCounts（筛选 chips 的分类候选）", () => {
  it("空列表：没有任何分类", () => {
    expect(scenarioCategoryCounts([])).toEqual([]);
  });
  it("只保留实际有场景的分类，按固定展示序而非出现序", () => {
    const list = [
      makeScenario("a", "academic"),
      makeScenario("b", "workplace"),
      makeScenario("c", "daily"),
      makeScenario("d", "daily"),
    ];
    expect(scenarioCategoryCounts(list)).toEqual([
      { category: "daily", count: 2 },
      { category: "workplace", count: 1 },
      { category: "academic", count: 1 },
    ]);
  });
});

describe("filterScenarioPreview（筛选 + 收起截断）", () => {
  const list = [
    ...Array.from({ length: 3 }, (_, i) => makeScenario(`d${i}`, "daily")),
    ...Array.from({ length: 5 }, (_, i) => makeScenario(`t${i}`, "travel")),
  ];
  const pick = (r: ReturnType<typeof filterScenarioPreview>) => r.visible.map((s) => s.id);

  it("分类下没有场景：空结果、不出展开按钮", () => {
    const r = filterScenarioPreview(list, "academic", false, 3);
    expect(r.visible).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.hasMore).toBe(false);
  });
  it("分类只有 1 个：直接全显示", () => {
    const r = filterScenarioPreview(list.slice(0, 1), "daily", false, 3);
    expect(pick(r)).toEqual(["d0"]);
    expect(r.hasMore).toBe(false);
  });
  it("「全部」超过上限：收起只出前 limit 张（注册序），hasMore 标记展开按钮", () => {
    const r = filterScenarioPreview(list, "all", false, 3);
    expect(pick(r)).toEqual(["d0", "d1", "d2"]);
    expect(r.total).toBe(8);
    expect(r.hasMore).toBe(true);
  });
  it("选具体分类：只在分类内筛选并截断", () => {
    const r = filterScenarioPreview(list, "travel", false, 3);
    expect(pick(r)).toEqual(["t0", "t1", "t2"]);
    expect(r.total).toBe(5);
    expect(r.hasMore).toBe(true);
  });
  it("展开：全量显示、hasMore 归位；再收起回到截断", () => {
    const expanded = filterScenarioPreview(list, "all", true, 3);
    expect(pick(expanded)).toHaveLength(8);
    expect(expanded.hasMore).toBe(false);
    const collapsedAgain = filterScenarioPreview(list, "all", false, 3);
    expect(pick(collapsedAgain)).toHaveLength(3);
    expect(collapsedAgain.hasMore).toBe(true);
  });
  it("默认上限是 8（SCENARIO_PREVIEW_LIMIT）：9 个收起出 8 张", () => {
    const nine = Array.from({ length: 9 }, (_, i) => makeScenario(`n${i}`));
    const r = filterScenarioPreview(nine, "all", false);
    expect(r.visible).toHaveLength(8);
    expect(r.total).toBe(9);
    expect(r.hasMore).toBe(true);
  });
  it("不修改传入列表（展开时也不回写原数组）", () => {
    const frozen = [makeScenario("x"), makeScenario("y")];
    filterScenarioPreview(frozen, "all", true, 1);
    expect(frozen).toHaveLength(2);
  });
});
