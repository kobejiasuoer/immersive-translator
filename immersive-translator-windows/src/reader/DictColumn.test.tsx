// @vitest-environment jsdom
// v0.8 Phase 2 透镜卡（DictColumn）：双 Tab「句子解析 / 查词」切换互不丢状态、
// 查词 Tab ready/chunk 两态回归、句子解析 Tab 渲染 spine/clauses/pattern
// 与悬停回标（onHoverClause）/带入口语（onPracticeSentence）接线。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DictColumn, type DictPanelState, type LensXrayState } from "./DictColumn";
import type { ReaderDictEntry } from "../core/readerDict";
import type { SentenceChunk } from "../core/readerTypes";
import type { SentenceXray } from "../core/sentenceXray";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: ReaderDictEntry = {
  word: "primitive",
  phonetic: "ˈprɪmətɪv",
  senses: [
    { pos: "adj", cn: "原始的" },
    { pos: "n", cn: "原始人" },
  ],
  collocations: [{ en: "primitive instinct", cn: "原始本能" }],
  forms: ["primitively"],
};

const READY_STATE: DictPanelState = {
  status: "ready",
  query: "primitive",
  entry: ENTRY,
  sentenceIdx: 2,
  sourceSentence: "He was a primitive dog.",
};

const CHUNK: SentenceChunk = {
  text: "fall away from",
  chunkType: "phrasal",
  gloss: "逐渐失去",
  pattern: "fall away from sth",
};

const CHUNK_STATE: DictPanelState = {
  status: "chunk",
  chunk: CHUNK,
  sentenceIdx: 1,
  sourceSentence: "The generations fell away from him.",
};

const XRAY_DATA: SentenceXray = {
  spine: "He was a primitive dog",
  clauses: [
    { tag: "主语", snippet: "He", desc: "句子的主语" },
    { tag: "表语", snippet: "a primitive dog", desc: "说明主语是什么" },
  ],
  pattern: "S + be + a/an + adj + n",
};

const XRAY_READY: LensXrayState = { status: "ready", sentenceIdx: 2, data: XRAY_DATA };

interface MountResult {
  root: Root;
  container: HTMLDivElement;
  rerender: (props: Partial<Parameters<typeof DictColumn>[0]>) => void;
}

function mount(props?: Partial<Parameters<typeof DictColumn>[0]>): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const base = {
    state: READY_STATE,
    inVocab: false,
    knownIds: new Set<string>(),
    bookSource: null,
    onSpeak: () => undefined,
    onAddVocab: () => undefined,
    onAddCollVocab: () => undefined,
    onLocate: () => undefined,
    onLookup: () => undefined,
    onClose: () => undefined,
    lensMode: "xray" as const,
    onLensMode: () => undefined,
    activeIdx: 2,
    xray: XRAY_READY,
    xrayBusy: false,
    onOpenXray: () => undefined,
    onHoverClause: () => undefined,
    onPracticeSentence: () => undefined,
    ...props,
  };
  act(() => root.render(<DictColumn {...base} />));
  return {
    root,
    container,
    rerender: (patch) => act(() => root.render(<DictColumn {...{ ...base, ...patch }} />)),
  };
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function hover(el: Element, type: "mouseover" | "mouseout") {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

function tab(container: HTMLElement, label: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLButtonElement>(".lens-mode-btn")).find(
    (b) => b.textContent === label,
  );
  if (!el) throw new Error(`lens tab "${label}" not found`);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DictColumn（v0.8 透镜卡）", () => {
  it("双 Tab 切换互不丢状态：句子解析与查词内容都是 props，切回来原样", () => {
    const onLensMode = vi.fn();
    const { container, rerender } = mount({ onLensMode });
    expect(container.querySelector(".spatial-lens-card")).toBeTruthy();
    expect(container.querySelector(".lens-spine")?.textContent).toContain("He was a primitive dog");

    // xray → lex：点 Tab 交给父层（受控），父层切 lensMode 后查词内容在位
    click(tab(container, "查词"));
    expect(onLensMode).toHaveBeenCalledExactlyOnceWith("lex");
    rerender({ lensMode: "lex" });
    expect(container.querySelector(".dict-word")?.textContent).toBe("primitive");

    // lex → xray：解析数据没丢
    click(tab(container, "句子解析"));
    rerender({ lensMode: "xray" });
    expect(container.querySelector(".lens-spine")?.textContent).toContain("He was a primitive dog");
    expect(container.querySelector(".dict-word")).toBeNull();
  });

  it("查词 Tab · ready：词条/释义/原句卡/收藏按钮回归", () => {
    const onLocate = vi.fn();
    const { container } = mount({ lensMode: "lex", onLocate });
    expect(container.querySelector(".dict-word")?.textContent).toBe("primitive");
    expect(container.textContent).toContain("原始的");
    expect(container.querySelector(".source-card")?.textContent).toContain("He was a primitive dog.");
    click(container.querySelector(".source-card")!);
    expect(onLocate).toHaveBeenCalledExactlyOnceWith(2);
    expect(container.textContent).toContain("加入生词本");
    expect(container.textContent).toContain("primitive instinct");
  });

  it("查词 Tab · chunk：即时卡释义/记法/原句 + 详查词典走 onLookup", () => {
    const onLookup = vi.fn();
    const { container } = mount({ lensMode: "lex", state: CHUNK_STATE, onLookup });
    expect(container.querySelector(".dict-word")?.textContent).toBe("fall away from");
    expect(container.textContent).toContain("逐渐失去");
    expect(container.textContent).toContain("fall away from sth");
    const detail = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "详查词典");
    expect(detail).toBeTruthy();
    click(detail!);
    expect(onLookup).toHaveBeenCalledExactlyOnceWith("fall away from", 1);
  });

  it("句子解析 Tab：渲染 spine/clauses/pattern，悬停回标与练口语接线", () => {
    const onHoverClause = vi.fn();
    const onPracticeSentence = vi.fn();
    const { container } = mount({ onHoverClause, onPracticeSentence });
    expect(container.querySelector(".lens-spine")?.textContent).toContain("He was a primitive dog");
    const steps = container.querySelectorAll(".clause-step-item");
    expect(steps).toHaveLength(2);
    expect(steps[0].textContent).toContain("主语");
    expect(steps[0].textContent).toContain("He");
    expect(steps[0].textContent).toContain("句子的主语");
    expect(container.querySelector(".lens-pattern")?.textContent).toContain("S + be + a/an + adj + n");

    hover(steps[1], "mouseover");
    expect(onHoverClause).toHaveBeenCalledExactlyOnceWith("a primitive dog");
    hover(steps[1], "mouseout");
    expect(onHoverClause).toHaveBeenLastCalledWith(null);

    const practice = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "用这个句型练口语 →",
    );
    expect(practice).toBeTruthy();
    click(practice!);
    expect(onPracticeSentence).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("句子解析 Tab：未解析/解析中/失败/光标已移走四种状态", () => {
    // 未请求过：给「解析这一句」入口
    const onOpenXray = vi.fn();
    let mounted = mount({ xray: null, onOpenXray });
    expect(mounted.container.textContent).toContain("第 3 句还没解析");
    click(Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent === "解析这一句 →")!);
    expect(onOpenXray).toHaveBeenCalledExactlyOnceWith(2);

    // 解析中：骨架 + 文案
    mounted.rerender({ xray: { status: "loading", sentenceIdx: 2, data: null }, xrayBusy: true });
    expect(mounted.container.textContent).toContain("正在解析第 3 句");

    // 失败：重试按钮
    mounted.rerender({ xray: { status: "error", sentenceIdx: 2, data: null } });
    expect(mounted.container.textContent).toContain("句子解析失败");
    click(Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent === "重试")!);
    expect(onOpenXray).toHaveBeenCalledTimes(2);

    // 光标移走：旧句数据不冒充当前句，回到解析入口
    mounted = mount({ activeIdx: 5 });
    expect(mounted.container.textContent).toContain("第 6 句还没解析");
    expect(mounted.container.querySelector(".lens-spine")).toBeNull();
  });

  it("查词 Tab 空态（closed）：给查词引导；关闭按钮只在查词结果打开时出现", () => {
    const onClose = vi.fn();
    const { container, rerender } = mount({
      lensMode: "lex",
      state: { status: "closed" },
      xray: null,
      onClose,
    });
    expect(container.textContent).toContain("单击正文里的单词、划选短语");
    expect(container.querySelector(".lens-header button.reader-tb-btn")).toBeNull();
    rerender({ lensMode: "lex", state: READY_STATE });
    const closeBtn = container.querySelector(".lens-header button.reader-tb-btn");
    expect(closeBtn).toBeTruthy();
    click(closeBtn!);
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });
});
