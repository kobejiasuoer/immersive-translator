// @vitest-environment jsdom
// 「笔记与复习」改版（2026-10-26）的交互冒烟：三态入口（home/notes/focus/export）、
// Hero 开始复习、胶带反剧透（未揭开时 reveal/评分带不渲染）、三档评分映射
// （没记住→forgot / 有点模糊→hard / 记住了→good；easy 建议档收敛 good）、
// 提示阶梯不露答案、Esc 退出、开口命中 easy+spokenAt 链路与放弃推进、
// rail 计数不泄词面 + 「去处理」开弹窗、看板三阶新文案 + 热力 + 易错项、
// 导出范围预过滤 / 保存 / 预览·源码切换。
// 麦克风/听写链路 mock 掉（startMicRecorder/transcribeSpeech/loadAsrCredentials），
// 命中判定本身仍走真实 textHitsTarget / judgeCloze。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dayKey, initialSrs, type ReviewLogFile } from "../core/readerSrs";
import type { VocabWord } from "../core/readerTypes";
import type { SpeakSession } from "../core/speakLogic";
import { VaultPage, VAULT_GRADE_BANDS, vaultNextLabel, type VaultPlayMode, type Props } from "./VaultPage";

vi.mock("../core/micRecorder", () => ({
  startMicRecorder: vi.fn(async () => ({
    stop: async () => new Float32Array(4000).fill(0.3),
    cancel: () => undefined,
  })),
}));
vi.mock("../core/xfyunAsr", () => ({
  transcribeSpeech: vi.fn(async () => "I finally managed to unwind after a long day."),
}));
vi.mock("../lib/iseCredentials", () => ({
  loadAsrCredentials: vi.fn(async () => ({ appId: "a", apiKey: "k", apiSecret: "s" })),
  loadIseCredentials: vi.fn(async () => null),
}));
vi.mock("../lib/tauriBridge", () => ({
  saveTextFile: vi.fn(async () => "/mock/notes.md"),
  cancelTranslation: vi.fn(async () => undefined),
}));

import { saveTextFile } from "../lib/tauriBridge";
const saveTextFileMock = vi.mocked(saveTextFile);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWord(partial: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    senses: [{ pos: "v.", cn: "放松" }],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(0),
    addedAt: 0,
    ...partial,
  };
}

const UNWIND = makeWord({ id: "unwind", word: "unwind" });

/** 完形素材词：sourceSentence 能取到含目标词的原句。 */
const UNWIND_SENTENCE = { en: "Please unwind after a long day.", zh: "漫长的一天后请放松一下。" };

/** 三阶各一个：s1 新词 / s2 熟词 / s3 口语用出。 */
const STAGE_WORDS: VocabWord[] = [
  makeWord({ id: "canopy", word: "canopy" }),
  makeWord({
    id: "buffer",
    word: "buffer",
    srs: { ease: 2.5, intervalDays: 3, reps: 2, dueAt: Date.now() + 86400000, lapses: 0 },
  }),
  makeWord({ id: "unwind", word: "unwind", spokenAt: Date.now() - 1000 }),
];

/** 易错词块：完形错 2 次（wrong+trap）。 */
const WEAK_CHUNK: VocabWord = {
  ...makeWord({ id: "take root", word: "take root", kind: "chunk" }),
  recall: {
    total: { pass: 0, wrong: 1, trap: 1 },
    byMode: { cloze: { pass: 0, wrong: 1, trap: 1 } },
  },
};

const SPEAK_SESSION: SpeakSession = {
  id: "s1",
  scenario: "smalltalk",
  difficulty: "medium",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [
    {
      role: "user",
      text: "I was very tired.",
      at: Date.now(),
      coachDiff: {
        segs: [
          { t: "keep", v: "I" },
          { t: "keep", v: "was" },
          { t: "del", v: "very" },
          { t: "del", v: "tired." },
          { t: "ins", v: "completely" },
          { t: "ins", v: "drained." },
        ],
        note: "drained 更地道",
      },
    },
  ],
};

function baseProps(overrides?: Partial<Props> & { mode?: VaultPlayMode }): Props {
  return {
    words: [UNWIND],
    due: [UNWIND],
    stats: {
      dueNow: 1,
      reviewedToday: 2,
      total: 1,
      streak: 3,
      distribution: { learning: 1, familiar: 0, mastered: 0 },
      totalWords: 1,
      totalChunks: 0,
      dueWords: 1,
      dueChunks: 0,
    },
    reviewLog: { schemaVersion: 1, days: [{ day: dayKey(), count: 2 }] } satisfies ReviewLogFile,
    sourceSentence: () => null,
    articleTitle: () => "Test Chapter",
    speakSessions: [SPEAK_SESSION],
    mode: "home",
    onModeChange: vi.fn(),
    pos: 0,
    onSetPos: vi.fn(),
    onGrade: vi.fn(),
    onSpokenGrade: vi.fn(),
    onRecall: vi.fn(),
    onJumpToSentence: vi.fn(),
    onSpeakWord: vi.fn(),
    onSpeakSentence: vi.fn(),
    onPracticeVocabSpeak: vi.fn(),
    onStartFocusReview: vi.fn(),
    ...overrides,
  };
}

interface Mount {
  root: Root;
  container: HTMLDivElement;
  rerender(props: Props): void;
  unmount(): void;
}

function mountVault(props: Props): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<VaultPage {...props} />));
  return {
    root,
    container,
    rerender: (next: Props) => act(() => root.render(<VaultPage {...next} />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function findButton(container: HTMLElement, includes: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => textOf(b).includes(includes));
  if (!btn) throw new Error(`button not found: ${includes}`);
  return btn as HTMLButtonElement;
}

/** 受控输入赋值（React 覆写了 value 描述符，必须走原型 setter）。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}

let mount: Mount | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  mount?.unmount();
  mount = undefined;
});

describe("三态入口与 Hero", () => {
  it("stage-head：seg 今日复习/全部笔记 + 导出笔记动作（导出是动作不再占档）", () => {
    const props = baseProps();
    mount = mountVault(props);
    const segBtns = [...mount.container.querySelectorAll(".stage-head .seg button")];
    expect(segBtns.map((b) => textOf(b))).toEqual(["今日复习", "全部笔记"]);
    act(() => findButton(mount!.container, "导出笔记").click());
    expect(props.onModeChange).toHaveBeenCalledWith("export");
    act(() => findButton(mount!.container, "全部笔记").click());
    expect(props.onModeChange).toHaveBeenCalledWith("notes");
  });

  it("Hero：今天 N 条 + 预计分钟 + 开始复习/Enter 都进 focus", () => {
    const props = baseProps();
    mount = mountVault(props);
    expect(mount.container.textContent).toContain("今天有 1 条要复习");
    expect(mount.container.textContent).toContain("预计 1 分钟");
    expect(mount.container.textContent).toContain("按 Enter 也可以开始");
    act(() => findButton(mount!.container, "开始复习").click());
    expect(props.onModeChange).toHaveBeenCalledWith("focus");
    act(() => pressKey("Enter"));
    expect(props.onModeChange).toHaveBeenCalledWith("focus");
  });

  it("due=0：开始复习禁用 + 完成态文案，Enter 不再触发", () => {
    const props = baseProps({ due: [] });
    mount = mountVault(props);
    expect(mount.container.textContent).toContain("今天没有要复习的了");
    const start = findButton(mount!.container, "开始复习");
    expect(start.disabled).toBe(true);
    act(() => pressKey("Enter"));
    expect(props.onModeChange).not.toHaveBeenCalled();
  });

  it("notes 档：seg 第二档内嵌既有笔记库（notesPanel 原样挂载）", () => {
    mount = mountVault(
      baseProps({ mode: "notes", notesPanel: <div className="notes-stub">NOTES-STUB</div> }),
    );
    expect(mount.container.querySelector(".notes-stub")?.textContent).toBe("NOTES-STUB");
    // notes 档不再有 Hero/胶带列表
    expect(mount.container.querySelector(".vault-hero")).toBeNull();
  });

  it("export 档：← 返回复习回 home", () => {
    const props = baseProps({ mode: "export" });
    mount = mountVault(props);
    act(() => findButton(mount!.container, "← 返回复习").click());
    expect(props.onModeChange).toHaveBeenCalledWith("home");
  });

  it("底部快捷切换器：复习首页/专注复习/导出三档，active 随档位，点击切档；focus 态常驻", () => {
    const props = baseProps();
    mount = mountVault(props);
    const sw = [...mount.container.querySelectorAll(".vault-switch button")];
    expect(sw.map((b) => textOf(b))).toEqual(["复习首页", "专注复习", "导出"]);
    expect(sw[0]!.classList.contains("on")).toBe(true);
    act(() => findButton(mount!.container, "专注复习").click());
    expect(props.onModeChange).toHaveBeenCalledWith("focus");
    mount.rerender({ ...props, mode: "focus" });
    const ons = [...mount.container.querySelectorAll(".vault-switch button.on")];
    expect(ons.map(textOf)).toEqual(["专注复习"]);
  });
});

describe("待复习列表（胶带）", () => {
  it("胶带点击揭开、再点盖上（peeled 类切换）；全部揭开/全部盖住", () => {
    mount = mountVault(baseProps());
    const tape = mount.container.querySelector<HTMLElement>(".memory-tape");
    expect(tape).not.toBeNull();
    expect(tape!.classList.contains("peeled")).toBe(false);
    act(() => tape?.click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(true);
    act(() => mount?.container.querySelector<HTMLElement>(".memory-tape")?.click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(false);
    // 全部揭开 → 再全部盖住
    act(() => findButton(mount!.container, "全部揭开").click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(true);
    expect(findButton(mount!.container, "全部盖住")).toBeTruthy();
    act(() => findButton(mount!.container, "全部盖住").click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(false);
  });

  it("反剧透：未揭开时 reveal/译文/释义/评分带一律不在 DOM；揭开后三者齐备", () => {
    mount = mountVault(baseProps());
    const m = mount!;
    const item = m.container.querySelector(".vault-item")!;
    expect(item.querySelector(".reveal")).toBeNull();
    expect(item.querySelectorAll(".grade-chip")).toHaveLength(0);
    // 反剧透：未揭开时译文/释义不在条目文本里（胶带遮盖机制由 CSS transparent 承担）
    expect(item.textContent).not.toContain("放松");
    act(() => m.container.querySelector<HTMLElement>(".memory-tape")!.click());
    const reveal = item.querySelector(".reveal")!;
    expect(textOf(reveal)).toContain("unwind · v. 放松");
    expect(m.container.querySelectorAll(".grade-chip")).toHaveLength(3);
  });

  it("三档评分映射：记住了→good / 没记住→forgot / 有点模糊→hard；副行从 GRADE_INTERVALS 派生", () => {
    const props = baseProps();
    mount = mountVault(props);
    act(() => mount!.container.querySelector<HTMLElement>(".memory-tape")!.click());
    const chips = [...mount!.container.querySelectorAll<HTMLButtonElement>(".grade-chip")];
    expect(chips.map((c) => textOf(c).replace(/\s+/g, ""))).toEqual([
      "没记住10分钟后再来",
      "有点模糊明天再看",
      "记住了3天后再看",
    ]);
    act(() => chips[2].click()); // 记住了 → good
    act(() => chips[0].click()); // 没记住 → forgot
    act(() => chips[1].click()); // 有点模糊 → hard
    expect(props.onGrade).toHaveBeenNthCalledWith(1, UNWIND, "good");
    expect(props.onGrade).toHaveBeenNthCalledWith(2, UNWIND, "forgot");
    expect(props.onGrade).toHaveBeenNthCalledWith(3, UNWIND, "hard");
    // 三档文案契约（导出常量）：名称与档位
    expect(VAULT_GRADE_BANDS.map((b) => b.name)).toEqual(["没记住", "有点模糊", "记住了"]);
    expect(VAULT_GRADE_BANDS.map((b) => b.grade)).toEqual(["forgot", "hard", "good"]);
    expect(vaultNextLabel("good")).toContain("3 天");
  });

  it("给点提示：首字母 + 词数，不露答案；听原句无原句回退 onSpeakWord；去口语走 vocab 通道", () => {
    const props = baseProps();
    mount = mountVault(props);
    const m = mount!;
    act(() => findButton(m.container, "给点提示").click());
    const hint = m.container.querySelector(".hint-text")!;
    expect(textOf(hint)).toBe("首字母：u…（1 词）");
    expect(textOf(hint)).not.toContain("unwind");
    act(() => findButton(m.container, "听原句").click());
    expect(props.onSpeakWord).toHaveBeenCalledWith("unwind"); // 无原句回退读词
    act(() => findButton(m.container, "去口语里用一次").click());
    expect(props.onPracticeVocabSpeak).toHaveBeenCalledTimes(1);
  });

  it("口语纠偏条目：原话 + 地道说法 diff（ins 片段是胶带），无评分带", () => {
    mount = mountVault(baseProps());
    const m = mount!;
    const speakRow = [...m.container.querySelectorAll(".vault-item")].find((r) =>
      r.textContent?.includes("口语纠偏"),
    );
    expect(speakRow).toBeDefined();
    expect(speakRow!.textContent).toContain("I was very tired.");
    expect(speakRow!.querySelector(".diff-del-span")).not.toBeNull();
    expect(speakRow!.querySelectorAll(".memory-tape").length).toBe(2); // completely + drained.
    expect(speakRow!.querySelector(".grades")).toBeNull(); // 口语条目不评 SRS 档
    expect(textOf(speakRow!.querySelector(".item-actions button"))).toBe("听地道说法");
  });
});

describe("左栏 rail", () => {
  it("内容来源/类型分组计数；rail 不出现任何词面", () => {
    mount = mountVault(baseProps({ words: [UNWIND, WEAK_CHUNK], due: [UNWIND, WEAK_CHUNK] }));
    const m = mount!;
    const rail = m.container.querySelector(".vault-rail")!;
    const railText = rail.textContent ?? "";
    expect(railText).toContain("全部");
    expect(railText).toContain("《Test Chapter》");
    expect(railText).toContain("划词收藏");
    expect(railText).toContain("口语纠偏");
    expect(railText).toContain("单词");
    expect(railText).toContain("词块 / 短语");
    // 防泄答案：rail DOM 里没有词面（含词块）
    expect(rail.innerHTML).not.toContain(">unwind<");
    expect(rail.innerHTML.toLowerCase()).not.toContain("take root");
    // 口径标注：数字 = 点进筛选后列表实际条数（全部含口语纠偏条目）
    expect(railText).toContain("内容来源 · 待复习");
    // 计数：全部 = 到期词 2 + 口语轮 1 = 3 / 文章 2 / 划词 0 / 口语纠偏 1 / 单词 1 / 词块 1
    const items = [...rail.querySelectorAll(".rail-item")];
    expect(items.map((b) => textOf(b).replace(/\s+/g, ""))).toEqual([
      "全部3",
      "《TestChapter》2",
      "划词收藏0",
      "口语纠偏1",
      "单词1",
      "词块/短语1",
    ]);
    // 类型筛选「词块·短语」：口语条目一并隐藏（非词非块），只剩词块条目
    act(() => findButton(rail as HTMLElement, "词块 / 短语").click());
    const itemsAfter = m.container.querySelectorAll(".vault-item");
    expect(itemsAfter.length).toBe(1);
    expect(itemsAfter[0].textContent).toContain("词块");
    // 再点一次已选中的类型 = 取消筛选（类型组无「全部」入口，靠 toggle 回全集）
    act(() => findButton(rail as HTMLElement, "词块 / 短语").click());
    expect(m.container.querySelectorAll(".vault-item").length).toBe(3);
  });

  it("「口语纠偏」来源筛选：列表只剩口语条目；计数含历史轮（与列表严格一致）", () => {
    const oldTurn = { ...SPEAK_SESSION.turns[0], at: Date.now() - 10 * 86400000 };
    const oldSession: SpeakSession = {
      ...SPEAK_SESSION,
      id: "s0",
      createdAt: oldTurn.at,
      updatedAt: oldTurn.at,
      turns: [oldTurn],
    };
    mount = mountVault(baseProps({ speakSessions: [oldSession, SPEAK_SESSION] }));
    const railText = mount!.container.querySelector(".vault-rail")!.textContent ?? "";
    expect(railText.replace(/\s+/g, "")).toContain("口语纠偏2");
    expect(railText.replace(/\s+/g, "")).toContain("全部3");
    act(() => findButton(mount!.container.querySelector(".vault-rail") as HTMLElement, "口语纠偏").click());
    const items = mount!.container.querySelectorAll(".vault-item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("I was very tired.");
    expect(items[0].querySelector(".memory-tape")).not.toBeNull();
  });

  it("rail-note：未整理提示 + 「去处理」打开 VocabNoteDialog", () => {
    const requestTranslate = vi.fn(async () => ({ status: "done" as const, text: "" }));
    mount = mountVault(baseProps({ unnotedCount: 1, requestTranslate }));
    const m = mount!;
    expect(m.container.querySelector(".rail-note")!.textContent).toContain(
      "有 1 条内容未整理，可能不是词汇（如命令行）。",
    );
    expect(m.container.querySelector(".reader-note-modal")).toBeNull();
    act(() => findButton(m.container.querySelector(".rail-note") as HTMLElement, "去处理").click());
    expect(m.container.querySelector(".reader-note-modal")).not.toBeNull();
  });

  it("加练横幅：剩余数 + 退出回到全局到期队列", () => {
    const props = baseProps({ focusCount: 2, onExitFocus: vi.fn() });
    mount = mountVault(props);
    expect(mount!.container.querySelector(".focus-banner")!.textContent).toContain("剩 2");
    act(() => findButton(mount!.container.querySelector(".focus-banner") as HTMLElement, "退出").click());
    expect(props.onExitFocus).toHaveBeenCalledTimes(1);
  });
});

describe("专注复习（focus）", () => {
  it("原句缺失的词第一关落到开口卡：录音→转写→命中目标词按 easy+spokenAt 落盘", async () => {
    const props = baseProps({ mode: "focus" });
    mount = mountVault(props);
    const mic = findButton(mount.container, "点击开口说一句");
    await act(async () => mic.click());
    await act(async () => mic.click());
    expect(props.onSpokenGrade).toHaveBeenCalledWith(UNWIND, "easy");
    expect(props.onGrade).not.toHaveBeenCalled();
    expect(mount!.container.textContent).toContain("开口命中");
  });

  it("放弃这题：不评分，游标推进；Esc 退回 home（focusIds 保留在 ReaderApp）", () => {
    const props = baseProps({ mode: "focus" });
    mount = mountVault(props);
    const m = mount!;
    act(() => findButton(m.container, "放弃这题").click());
    expect(props.onSpokenGrade).not.toHaveBeenCalled();
    expect(props.onGrade).not.toHaveBeenCalled();
    expect(props.onSetPos).toHaveBeenCalledWith(0); // 队列只剩 1 词：绕回队首
    expect(m.container.textContent).toContain("跳过（未评分）");
    act(() => pressKey("Escape"));
    expect(props.onModeChange).toHaveBeenCalledWith("home");
  });

  it("完形卡：26px 衬线大句 + 内嵌输入；判分 perfect → 三档带建议「记住了」；Enter 采纳（easy 收敛 good）", () => {
    const props = baseProps({
      mode: "focus",
      sourceSentence: () => UNWIND_SENTENCE,
    });
    mount = mountVault(props);
    const m = mount!;
    expect(m.container.querySelector(".q-sent")?.textContent).toContain("Please");
    const input = m.container.querySelector<HTMLInputElement>(".cloze-blank-input")!;
    act(() => setInputValue(input, "unwind"));
    // 输入框内 Enter 提交（stopPropagation 防双触发路径）
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(m.container.querySelector(".recall-verdict")?.textContent).toContain("一次写对");
    // easy 建议档在 vault 三档带收敛为 good（3 天）
    const suggest = m.container.querySelector(".grade-chip.suggest")!;
    expect(textOf(suggest)).toContain("记住了");
    expect(textOf(suggest)).toContain("3 天");
    // 全局 Enter = 采纳建议档 → good（不是 easy）
    act(() => pressKey("Enter"));
    expect(props.onGrade).toHaveBeenCalledWith(UNWIND, "good");
    expect(props.onRecall).toHaveBeenCalledWith("unwind", "cloze", "perfect", "good");
    expect(m.container.textContent).toContain("已按「记住了」完成");
  });

  it("完形卡：我不会 → wrong；数字键 1-3 直选三档", () => {
    const props = baseProps({
      mode: "focus",
      sourceSentence: () => UNWIND_SENTENCE,
    });
    mount = mountVault(props);
    const m = mount!;
    act(() => findButton(m.container, "我不会").click());
    expect(m.container.querySelector(".recall-verdict")?.textContent).toContain("没想起来");
    const suggest = m.container.querySelector(".grade-chip.suggest")!;
    expect(textOf(suggest)).toContain("没记住");
    act(() => pressKey("2")); // 有点模糊 → hard
    expect(props.onGrade).toHaveBeenCalledWith(UNWIND, "hard");
  });

  it("提示阶梯：Tab 展开两级；提示 1 是整句译文、提示 2 是首字母与长度，都不显示答案本身", () => {
    mount = mountVault(
      baseProps({ mode: "focus", sourceSentence: () => UNWIND_SENTENCE }),
    );
    const m = mount!;
    expect(m.container.querySelectorAll(".hint-step.shown")).toHaveLength(0);
    act(() => pressKey("Tab"));
    expect(m.container.querySelectorAll(".hint-step.shown")).toHaveLength(1);
    const step1 = m.container.querySelectorAll(".hint-step")[0]!;
    expect(textOf(step1)).toContain("漫长的一天后请放松一下。");
    act(() => pressKey("Tab"));
    const step2 = m.container.querySelectorAll(".hint-step")[1]!;
    expect(textOf(step2)).toContain("首字母与长度");
    expect(textOf(step2)).toContain("u…");
    expect(textOf(step2)).toContain("1 词");
    expect(textOf(step2)).not.toContain("unwind");
  });
});

describe("右侧看板", () => {
  it("今日进度：conic 环 done/total + 还差 N 条 + 约分钟；口径 reviewedToday+due.length", () => {
    mount = mountVault(baseProps());
    const m = mount!;
    const ring = m.container.querySelector(".ring span")!;
    expect(textOf(ring)).toBe("2/3");
    expect(m.container.querySelector(".prog")!.textContent).toContain("还差 1 条");
    expect(m.container.querySelector(".prog")!.textContent).toContain("约 1 分钟");
  });

  it("掌握阶段：三色分段条 + 新图例文案（刚收集/眼熟/能说出口），masteryStage 口径", () => {
    mount = mountVault(baseProps({ words: STAGE_WORDS, due: [UNWIND] }));
    const rows = [...mount!.container.querySelectorAll(".stage-row")];
    expect(rows.map((r) => textOf(r).replace(/\s+/g, ""))).toEqual([
      "刚收集1",
      "眼熟（读到能懂）1",
      "能说出口1",
    ]);
    expect(mount!.container.querySelectorAll(".stages i").length).toBe(3);
  });

  it("近 28 天：热力 28 格、今日格带 today+l1、出勤文案；空态给点亮提示", () => {
    mount = mountVault(baseProps({ words: STAGE_WORDS, due: [UNWIND] }));
    const cells = mount!.container.querySelectorAll(".heat-cell");
    expect(cells.length).toBe(28);
    expect(mount!.container.querySelectorAll(".heat-cell.today").length).toBe(1);
    expect(mount!.container.querySelector(".heat-cell.today")!.classList.contains("l1")).toBe(true);
    expect(mount!.container.querySelector(".empty-hint")!.textContent).toContain("出勤");

    mount!.unmount();
    mount = mountVault(
      baseProps({
        words: [UNWIND],
        due: [],
        stats: {
          dueNow: 0,
          reviewedToday: 0,
          total: 1,
          streak: 0,
          distribution: { learning: 1, familiar: 0, mastered: 0 },
          totalWords: 1,
          totalChunks: 0,
          dueWords: 0,
          dueChunks: 0,
        },
        reviewLog: { schemaVersion: 1, days: [] } satisfies ReviewLogFile,
      }),
    );
    expect(mount!.container.querySelector(".empty-hint")!.textContent).toContain(
      "完成第一轮复习，就会点亮今天。",
    );
  });

  it("易错项加练：一键把弱项词送进 focusIds 专注态；去口语走 pendingSpeak 通道", () => {
    const props = baseProps({ words: [WEAK_CHUNK], due: [] });
    mount = mountVault(props);
    const m = mount!;
    const board = m.container.querySelector(".board")!;
    expect(board.textContent).toContain("take root");
    expect(board.textContent).toContain("错题 2 次");
    act(() => findButton(m.container, "1 分钟只练这 1 个易错项").click());
    expect(props.onStartFocusReview).toHaveBeenCalledWith(["take root"]);
    expect(props.onModeChange).toHaveBeenCalledWith("focus");
    act(() => findButton(m.container, "去口语里加练").click());
    expect(props.onPracticeVocabSpeak).toHaveBeenCalledTimes(1);
  });
});

describe("导出（export）", () => {
  /** addedAt=今天 的词 + addedAt=0（久远）的词：用于范围预过滤断言。 */
  const FRESH = makeWord({
    id: "volunteers",
    word: "volunteers",
    addedAt: Date.now(),
    phonetic: "vɒlənˈtɪəz",
  });
  const exportWords = [UNWIND, FRESH];

  it("范围 chips 预过滤：默认本周（含今天词、排除久远词）；「全部」收齐；共 N 条随动", () => {
    mount = mountVault(baseProps({ mode: "export", words: exportWords }));
    const m = mount!;
    const opts = m.container.querySelector(".exp-opts")! as HTMLElement;
    expect(m.container.textContent).toContain("共 1 条");
    act(() => findButton(opts, "全部").click());
    expect(m.container.textContent).toContain("共 2 条");
    act(() => findButton(opts, "今天").click());
    expect(m.container.textContent).toContain("共 1 条");
    // 源码态内容随范围过滤
    act(() => findButton(m.container, "Markdown 源码").click());
    const pre = m.container.querySelector(".vault-markdown-pre")!;
    expect(pre.textContent).toContain("volunteers");
    expect(pre.textContent).not.toContain("unwind"); // addedAt=0 不在今天范围
  });

  it("预览/源码 seg 切换：预览卡渲染词条 + 原句左线；包含 chips（音标）只作用预览层", () => {
    mount = mountVault(
      baseProps({
        mode: "export",
        words: exportWords,
        sourceSentence: () => UNWIND_SENTENCE,
      }),
    );
    const m = mount!;
    const md = m.container.querySelector(".md")!;
    expect(md.querySelector("h3")!.textContent).toContain("英语精读笔记");
    expect(md.querySelector(".w b")!.textContent).toBe("volunteers");
    // 音标缺省不包含
    expect(md.querySelector(".ipa")).toBeNull();
    act(() => findButton(m.container, "音标").click());
    expect(m.container.querySelector(".md .ipa")!.textContent).toContain("vɒlənˈtɪəz");
    // 原句缺省包含（sourceSentence 通道）
    expect(m.container.querySelector(".md .ex")!.textContent).toContain("unwind");
  });

  it("保存为 .md 走 saveTextFile（完整三段结构随范围过滤）；复制按钮就位", async () => {
    const props = baseProps({ mode: "export", words: exportWords });
    mount = mountVault(props);
    const m = mount!;
    expect(findButton(m.container, "复制 Markdown")).toBeTruthy();
    await act(async () => {
      findButton(m.container, "保存为 .md").click();
    });
    expect(saveTextFileMock).toHaveBeenCalledTimes(1);
    const [name, contents] = saveTextFileMock.mock.calls[0];
    expect(String(name)).toMatch(/-学习笔记\.md$/);
    expect(String(contents)).toContain("volunteers");
    expect(String(contents)).not.toContain("unwind"); // 本周范围外
    expect(String(contents)).toContain("## 一、核心词块"); // buildVaultMarkdown 三段结构
  });
});
