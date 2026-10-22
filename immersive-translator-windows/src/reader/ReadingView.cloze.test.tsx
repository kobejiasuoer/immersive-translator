// @vitest-environment jsdom
// 随读抽查（原位挖空微测）：开关只挖已读句、Enter 本地判分（命中/陷阱）、
// 判定印章与错答删除线、onClozeVerdict 接线（known 槽联动）、
// 开关关闭零残留、按住 H 显影（peeked）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReadingView } from "./ReadingView";
import { DEFAULT_READER_SETTINGS, type Article } from "../core/readerTypes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 未实现 scrollTo（当前句滚动跟随 effect 会调用），stub 成 noop。
Element.prototype.scrollTo = () => undefined;

const ARTICLE: Article = {
  id: "a1",
  title: "The Town",
  titleCn: "小镇",
  titleCnState: "done",
  sourceType: "paste",
  wordCount: 40,
  createdAt: Date.now(),
  lastReadAt: Date.now(),
  progress: { sentenceIdx: 1, percent: 40, secondsListened: 0 },
  sentences: [
    {
      idx: 0,
      paragraphIdx: 0,
      en: "The tide is still making up its mind.",
      zh: "潮水仍在犹豫。",
      zhState: "done",
      chunks: [
        { text: "making up its mind", chunkType: "idiom", gloss: "下定决心", trap: "making its mind" },
      ],
    },
    // 段 1 + known 生词再现（slumbered 在生词本）→ known 槽
    { idx: 1, paragraphIdx: 1, en: "For forty years the town slumbered.", zh: "小镇沉睡。", zhState: "done" },
    // 未读到（watermark = 1）：即使有词块也不挖
    {
      idx: 2,
      paragraphIdx: 2,
      en: "Now cranes swing over the locks again.",
      zh: "吊臂转动。",
      zhState: "done",
      chunks: [{ text: "swing over", chunkType: "phrasal", gloss: "在…上空转动" }],
    },
  ],
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    article: ARTICLE,
    settings: { ...DEFAULT_READER_SETTINGS, spotQuizMode: true },
    activeIdx: 0,
    playing: false,
    translating: null,
    chunking: null,
    peekAll: false,
    searchMatchIdx: null,
    knownIds: new Set(["slumbered"]),
    assessMarks: null,
    onReveal: vi.fn(),
    onMask: vi.fn(),
    onRevealAll: vi.fn(),
    onMaskAll: vi.fn(),
    onSelection: vi.fn(),
    onWordClick: vi.fn(),
    onChunkClick: vi.fn(),
    onSpeakSentence: vi.fn(),
    onStopSpeaking: vi.fn(),
    onRetryParagraph: vi.fn(),
    onEditTranslation: vi.fn(),
    onJumpTo: vi.fn(),
    onViewportIdx: vi.fn(),
    onOpenImport: vi.fn(),
    onRetryTitle: vi.fn(),
    showFinishAction: false,
    finishLabel: "读完本篇",
    onFinishRead: vi.fn(),
    onPatchSettings: vi.fn(),
    onOpenXray: vi.fn(),
    onPracticeSentence: vi.fn(),
    hoveredClause: null,
    readWatermark: 1,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: Partial<ComponentProps<typeof ReadingView>>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ReadingView {...(props as ComponentProps<typeof ReadingView>)} />);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ReadingView · 随读抽查", () => {
  it("开关开启：只挖已读句（watermark 内），未读句词块保持点线", () => {
    const el = render(baseProps());
    const inputs = el.querySelectorAll("input.cloze-input");
    expect(inputs.length).toBe(2); // 句 0 词块槽 + 句 1 known 槽
    // 未读句 2 的词块仍是普通标注
    expect(el.textContent).toContain("swing over");
    expect(el.querySelector('[title="词块 · 点击查看"]')).not.toBeNull();
  });

  it("Enter 本地判分：陷阱答案出「陷阱」印章 + 错答删除线 + 朱批", () => {
    const onClozeVerdict = vi.fn();
    const el = render(baseProps({ onClozeVerdict }));
    const input = el.querySelector('input[aria-label^="补全挖空的词块"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      input.value = "making its mind";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(el.textContent).toContain("陷阱");
    expect(el.querySelector(".cloze-wrong")?.textContent).toBe("making its mind");
    expect(el.textContent).toContain("陷阱 · making its mind");
    // ReadingView 无条件上报判分；SRS 过滤（只认 known 槽）在 ReaderApp 侧做
    expect(onClozeVerdict).toHaveBeenCalledTimes(1);
    expect(onClozeVerdict.mock.calls[0]![0].isKnown).toBe(false);
  });

  it("known 槽答对：命中印章 + onClozeVerdict(perfect) 联动 SRS", () => {
    const onClozeVerdict = vi.fn();
    const el = render(baseProps({ onClozeVerdict }));
    const input = el.querySelector('input[aria-label^="补全挖空的生词"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      input.value = "slumbered";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(el.textContent).toContain("命中");
    expect(onClozeVerdict).toHaveBeenCalledTimes(1);
    const [slot, verdict] = onClozeVerdict.mock.calls[0]!;
    expect(slot.vocabId).toBe("slumbered");
    expect(verdict).toBe("perfect");
  });

  it("首字母提示后命中降档为 close", () => {
    const onClozeVerdict = vi.fn();
    const el = render(baseProps({ onClozeVerdict }));
    const input = el.querySelector('input[aria-label^="补全挖空的生词"]') as HTMLInputElement;
    // 提示要点在 known 槽自己的 ? 钮上（不是第一个槽的）
    act(() => {
      (input.closest(".cloze")?.querySelector("button.cloze-hint-btn") as HTMLButtonElement).click();
    });
    act(() => {
      input.value = "slumbered";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onClozeVerdict.mock.calls[0]![1]).toBe("close");
    expect(el.textContent).toContain("接近");
  });

  it("按住 H（peekAll）：待答槽显影；开关关闭：槽位零残留", () => {
    const el = render(baseProps({ peekAll: true }));
    expect(el.querySelectorAll(".cloze.peeked").length).toBe(2);

    const off = render(baseProps({ settings: { ...DEFAULT_READER_SETTINGS, spotQuizMode: false } }));
    expect(off.querySelectorAll("input.cloze-input").length).toBe(0);
    expect(off.querySelectorAll(".cloze").length).toBe(0);
  });

  it("抽查计数器随判分更新", () => {
    const el = render(baseProps());
    expect(el.querySelector(".cloze-meter")?.textContent).toContain("剩 2");
    const input = el.querySelector('input[aria-label^="补全挖空的词块"]') as HTMLInputElement;
    act(() => {
      input.value = "making up its mind";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(el.querySelector(".cloze-meter")?.textContent).toContain("1 命中");
    expect(el.querySelector(".cloze-meter")?.textContent).toContain("剩 1");
  });
});
