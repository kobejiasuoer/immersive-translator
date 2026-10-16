// @vitest-environment jsdom
// v0.8 Phase 1 书架浮层（FolioSheet，ReaderShelf.tsx 新导出）交互用例：
// 当前书卡 + 短文行渲染、点书卡继续读并请求关闭、点短文切换、
// 「＋ 导入文件」开导入、删除走 window.confirm（文案契约不变）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolioSheet } from "./ReaderShelf";
import type { ArticleSummary, BookMeta } from "../core/readerTypes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBook(partial: Partial<BookMeta> & Pick<BookMeta, "id" | "title">): BookMeta {
  return {
    author: "Jack London",
    createdAt: 0,
    lastReadAt: 0,
    chapters: [
      { id: "b1-c1", title: "Chapter 1", wordCount: 100, sentenceCount: 10 },
      { id: "b1-c2", title: "Chapter 2", wordCount: 100, sentenceCount: 10 },
    ],
    progress: { chapterId: "b1-c1", sentenceIdx: 3, percent: 40 },
    secondsListened: 0,
    radar: { kaoyan: 0, cet4: 0, cet6: 0 },
    ...partial,
  };
}

function makeArticle(partial: Partial<ArticleSummary> & Pick<ArticleSummary, "id" | "title">): ArticleSummary {
  return {
    titleCnState: "none",
    sourceType: "paste",
    wordCount: 80,
    createdAt: 0,
    lastReadAt: 0,
    progress: { sentenceIdx: 0, percent: 82, secondsListened: 0 },
    sentenceCount: 8,
    ...partial,
  } as ArticleSummary;
}

const BOOK = makeBook({ id: "b1", title: "The Call of the Wild" });
const OTHER_BOOK = makeBook({
  id: "b2",
  title: "Old Book",
  lastReadAt: 1,
  progress: { chapterId: "b2-c2", sentenceIdx: 0, percent: 10 },
});
const ARTICLE = makeArticle({ id: "a1", title: "Why Deep Reading Matters" });
const DONE_ARTICLE = makeArticle({
  id: "a2",
  title: "The Happy Prince",
  progress: { sentenceIdx: 9, percent: 100, secondsListened: 0 },
});

interface MountResult {
  root: Root;
  container: HTMLDivElement;
}

function mount(props?: Partial<Parameters<typeof FolioSheet>[0]>): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <FolioSheet
        articles={[ARTICLE, DONE_ARTICLE]}
        books={[BOOK, OTHER_BOOK]}
        activeBookId="b1"
        onSelect={() => undefined}
        onContinueBook={() => undefined}
        onDelete={() => undefined}
        onDeleteBook={() => undefined}
        onOpenImport={() => undefined}
        onClose={() => undefined}
        {...props}
      />,
    ),
  );
  return { root, container };
}

function byText(container: HTMLElement, text: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>("*")).find((n) => n.textContent === text);
  if (!el) throw new Error(`element with exact text "${text}" not found`);
  return el;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("FolioSheet（v0.8 书架浮层）", () => {
  it("渲染当前书卡（activeBookId 命中）与短文行（含读完态）", () => {
    const { container } = mount();
    expect(container.querySelector(".floating-folio-sheet.open")).toBeTruthy();
    expect(container.querySelector(".folio-book-hero .folio-hero-title")?.textContent).toBe(
      "The Call of the Wild",
    );
    // 作者 · 第 1/2 章 · 已读 20%（全书进度 = (0 + 40%) / 2 章）
    expect(container.querySelector(".folio-hero-meta")?.textContent).toContain("Jack London");
    expect(container.querySelector(".folio-hero-meta")?.textContent).toContain("第 1/2 章");
    expect(container.querySelector(".folio-hero-meta")?.textContent).toContain("已读 20%");
    const rows = container.querySelectorAll(".folio-article-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".folio-row-title")?.textContent).toBe("Why Deep Reading Matters");
    expect(rows[0].querySelector(".folio-row-pct")?.textContent).toBe("82%");
    expect(rows[1].querySelector(".folio-row-pct")?.textContent).toBe("读完");
  });

  it("点当前书卡 → onContinueBook(书) 并请求关闭浮层", () => {
    const onContinueBook = vi.fn();
    const onClose = vi.fn();
    const { container } = mount({ onContinueBook, onClose });
    click(container.querySelector(".folio-book-hero")!);
    expect(onContinueBook).toHaveBeenCalledExactlyOnceWith(BOOK);
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it("activeBookId 未命中时书卡回落最近一本书", () => {
    const onContinueBook = vi.fn();
    const { container } = mount({ activeBookId: null, onContinueBook });
    // books 顺序即最近阅读倒序（ReaderApp 传入 bookList）——回落第 0 本
    click(container.querySelector(".folio-book-hero")!);
    expect(onContinueBook).toHaveBeenCalledExactlyOnceWith(BOOK);
  });

  it("点短文行 → onSelect(id) 并请求关闭；「＋ 导入文件」→ onOpenImport 并请求关闭", () => {
    const onSelect = vi.fn();
    const onOpenImport = vi.fn();
    const onClose = vi.fn();
    const { container } = mount({ onSelect, onOpenImport, onClose });
    click(byText(container, "Why Deep Reading Matters"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a1");
    click(byText(container, "＋ 导入文件"));
    expect(onOpenImport).toHaveBeenCalledExactlyOnceWith();
    // 两次交互各请求一次关闭
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("删除书 / 删除短文都走 window.confirm；confirm 拒绝则不删", () => {
    const onDelete = vi.fn();
    const onDeleteBook = vi.fn();
    const { container } = mount({ onDelete, onDeleteBook });
    // 书卡删除按钮（aria-label 删除《书名》）
    click(container.querySelector('.folio-book-hero .folio-del')!);
    expect(confirmMock).toHaveBeenCalledExactlyOnceWith(
      "删除《The Call of the Wild》？将删除全部 2 章内容与这本书的阅读进度，不可恢复；生词本不受影响。",
    );
    expect(onDeleteBook).toHaveBeenCalledExactlyOnceWith("b1");
    // 短文删除
    confirmMock.mockClear();
    click(container.querySelectorAll(".folio-article-row")[0].querySelector(".folio-del")!);
    expect(confirmMock).toHaveBeenCalledExactlyOnceWith(
      "删除《Why Deep Reading Matters》？生词本不受影响。",
    );
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("a1");
    // 拒绝 → 不删
    confirmMock.mockClear();
    confirmMock.mockReturnValue(false);
    onDelete.mockClear();
    click(container.querySelectorAll(".folio-article-row")[0].querySelector(".folio-del")!);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("空书架（无书无短文）渲染引导文案，不渲染书卡与短文行", () => {
    const { container } = mount({ articles: [], books: [], activeBookId: null });
    expect(container.querySelector(".folio-book-hero")).toBeNull();
    expect(container.querySelectorAll(".folio-article-row")).toHaveLength(0);
    expect(container.querySelector(".folio-empty-hint")?.textContent).toContain("还没有书或短文");
  });
});
