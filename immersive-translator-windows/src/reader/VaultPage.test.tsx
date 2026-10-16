// @vitest-environment jsdom
// 「笔记与复习」三合一的交互冒烟：三模式切换、胶带揭开/再盖上、秒懂过关
// 落 good 档、闯关开口卡命中目标词落 easy 档、看板三阶计数与热力格。
// 麦克风/听写链路 mock 掉（startMicRecorder/transcribeSpeech/loadAsrCredentials），
// 命中判定本身仍走真实 textHitsTarget。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dayKey, initialSrs, type ReviewLogFile } from "../core/readerSrs";
import type { VocabWord } from "../core/readerTypes";
import type { SpeakSession } from "../core/speakLogic";
import { VaultPage, type VaultPlayMode, type Props } from "./VaultPage";

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

/** 易错词：完形错 2 次（wrong+trap）。 */
const WEAK_WORD: VocabWord = {
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
  createdAt: 0,
  updatedAt: 0,
  turns: [
    {
      role: "user",
      text: "I was very tired.",
      at: 0,
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
    mode: "tape",
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

let mount: Mount | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  mount?.unmount();
  mount = undefined;
});

describe("三模式切换", () => {
  it("顶栏三档按钮把玩法档回调出去；当前档高亮", () => {
    const props = baseProps();
    mount = mountVault(props);
    const btns = [...mount.container.querySelectorAll<HTMLButtonElement>(".lens-mode-btn")];
    expect(btns.map((b) => textOf(b))).toEqual([
      "记忆胶带手账（点按自测）",
      "3 分钟快刷闯关（填空 / 听音 / 开口）",
      "Markdown 笔记导出",
    ]);
    expect(btns[0].classList.contains("active")).toBe(true);
    act(() => btns[1].click());
    expect(props.onModeChange).toHaveBeenCalledWith("challenge");
  });

  it("md 档渲染导出卡与复制按钮，challenge 档渲染闯关盒", () => {
    const props = baseProps({ mode: "md" });
    mount = mountVault(props);
    expect(mount!.container.querySelector(".vault-markdown-pre")).not.toBeNull();
    expect(textOf(mount.container.querySelector(".tape-copy-btn"))).toBe("复制 Markdown");
    mount.rerender(baseProps({ mode: "challenge" }));
    expect(mount!.container.querySelector(".challenge-stage-box")).not.toBeNull();
  });
});

describe("记忆胶带手账", () => {
  it("胶带点击揭开、再点盖上（peeled 类切换）", () => {
    mount = mountVault(baseProps());
    const tape = mount.container.querySelector<HTMLElement>(".memory-tape");
    expect(tape).not.toBeNull();
    expect(tape!.classList.contains("peeled")).toBe(false);
    act(() => tape?.click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(true);
    act(() => mount?.container.querySelector<HTMLElement>(".memory-tape")?.click());
    expect(mount!.container.querySelector(".memory-tape")!.classList.contains("peeled")).toBe(false);
  });

  it("✓ 秒懂过关按 good 档落盘；「去口语里用一次」走 pendingSpeak vocab 通道", () => {
    const props = baseProps();
    mount = mountVault(props);
    const m = mount!;
    act(() => findButton(m.container, "秒懂过关").click());
    expect(props.onGrade).toHaveBeenCalledWith(UNWIND, "good");
    act(() => findButton(m.container, "去口语里用一次").click());
    expect(props.onPracticeVocabSpeak).toHaveBeenCalledTimes(1);
  });

  it("口语改进轮渲染为手账行：原话 + 地道说法（ins 片段是胶带）", () => {
    mount = mountVault(baseProps());
    const m = mount!;
    const html = m.container.innerHTML;
    expect(html).toContain("口语表达改进记录");
    expect(html).toContain("I was very tired.");
    expect(html).toContain("completely");
    // 口语改进条目不是 SRS 词条：该行内不出现评分按钮，只有「听地道说法」
    // （按 .tape-speak-original 定位，避免命中带同样文案的归档过滤行）
    const speakRow = [...m.container.querySelectorAll(".tape-entry-row")].find((r) =>
      r.querySelector(".tape-speak-original") !== null,
    );
    expect(speakRow).toBeDefined();
    expect(speakRow!.querySelector(".tape-pass-btn")).toBeNull();
    expect(speakRow!.querySelector(".diff-del-span")).not.toBeNull();
    expect(speakRow!.querySelectorAll(".memory-tape").length).toBe(2); // completely + drained.
    expect(textOf(speakRow!.querySelector(".text-action-btn"))).toBe("听地道说法");
  });
});

describe("3 分钟快刷闯关", () => {
  it("原句缺失的词第一关落到开口卡：录音→转写→命中目标词按 easy+spokenAt 落盘", async () => {
    const props = baseProps({ mode: "challenge" });
    mount = mountVault(props);
    const mic = findButton(mount.container, "点击开口说一句");
    // 第一次点击：开麦（mock 的 startMicRecorder 立即就绪）
    await act(async () => mic.click());
    // 第二次点击：说完手动收 → stop → ASR → textHitsTarget("…unwind…","unwind") 命中
    await act(async () => mic.click());
    expect(props.onSpokenGrade).toHaveBeenCalledWith(UNWIND, "easy");
    expect(props.onGrade).not.toHaveBeenCalled();
    // 命中后出现「上一关」战报条
    expect(mount!.container.textContent).toContain("开口命中");
  });

  it("放弃这题：不评分，游标推进", () => {
    const props = baseProps({ mode: "challenge" });
    mount = mountVault(props);
    const m = mount!;
    act(() => findButton(m.container, "放弃这题").click());
    expect(props.onSpokenGrade).not.toHaveBeenCalled();
    expect(props.onGrade).not.toHaveBeenCalled();
    expect(props.onSetPos).toHaveBeenCalledWith(0); // 队列只剩 1 词：绕回队首
    expect(mount!.container.textContent).toContain("跳过（未评分）");
  });
});

describe("我的内化看板", () => {
  it("三阶计数按 masteryStage 派生；热力格 28 格且今日格带 today", () => {
    mount = mountVault(baseProps({ words: STAGE_WORDS, due: [UNWIND] }));
    const rows = [...mount.container.querySelectorAll(".vault-stage-row")];
    expect(rows).toHaveLength(3);
    expect(textOf(rows[0])).toContain("刚收集");
    expect(textOf(rows[0])).toContain("1 词");
    expect(textOf(rows[1])).toContain("眼熟能认");
    expect(textOf(rows[1])).toContain("1 词");
    expect(textOf(rows[2])).toContain("已变成我的口语表达");
    expect(textOf(rows[2])).toContain("1 词");
    const cells = mount.container.querySelectorAll(".heat-cell");
    expect(cells.length).toBe(28);
    expect(mount!.container.querySelectorAll(".heat-cell.today").length).toBe(1);
    // 今日 2 次复习 → l1 档
    expect(mount!.container.querySelector(".heat-cell.today")!.classList.contains("l1")).toBe(true);
  });

  it("易错项加练：一键把弱项词送进 focusIds 闯关；去口语走 pendingSpeak 通道", () => {
    const props = baseProps({ words: [WEAK_WORD], due: [] });
    mount = mountVault(props);
    const html = mount.container.innerHTML;
    expect(html).toContain("take root");
    expect(html).toContain("错题 2 次");
    const m = mount!;
    act(() => findButton(m.container, "1 分钟只练这 1 个易错项").click());
    expect(props.onStartFocusReview).toHaveBeenCalledWith(["take root"]);
    expect(props.onModeChange).toHaveBeenCalledWith("challenge");
    act(() => findButton(m.container, "去口语里加练").click());
    expect(props.onPracticeVocabSpeak).toHaveBeenCalledTimes(1);
  });
});
