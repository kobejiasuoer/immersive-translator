// @vitest-environment jsdom
// 发现页 tab（B2）组件测试：曝光埋点、装载/筛选参数、加载更多累计、下载进度
// 订阅与展示、下载全链路产物（File 断言）、每条失败路径的行内/整块中文文案。
// mock ../lib/tauriBridge（booksList/booksDownload/onBooksDownloadProgress +
// authTrackEvent——track 走真实 analytics，埋点断言落在 authTrackEvent 上，
// SpeakScenarioEditor.test.tsx 同款）；discoverCatalog 用真实实现（信封解析/
// sha256 校验随组件一起被测到，sha256 用 node:crypto 真摘要避免误拦截）。
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiscoverTab } from "./DiscoverTab";

// jsdom 的 window.crypto 无 SubtleCrypto 时挂 node webcrypto（sha256 校验可算）。
if (!globalThis.crypto?.subtle) {
  vi.stubGlobal("crypto", webcrypto);
}

// vi.hoisted：mock 工厂与测试用同一组 vi.fn 实例（scenarioCatalog.test.ts 先例）
const mocks = vi.hoisted(() => ({
  booksList: vi.fn(),
  booksDownload: vi.fn(),
  onBooksDownloadProgress: vi.fn(),
  authTrackEvent: vi.fn(),
}));

vi.mock("../lib/tauriBridge", () => mocks);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 一行书目（sha256 由用例按下载字节实算后覆盖）。 */
function book(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alice-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    description: "A girl falls down a rabbit hole into a fantasy world.",
    wordCount: 26500,
    grade: "easy",
    category: "fiction",
    language: "en",
    coverEmoji: "🐰",
    source: "standard-ebooks",
    sourceUrl: "https://standardebooks.org/ebooks/alice",
    licenseName: "Public Domain",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    fileSizeBytes: 812546,
    sha256: "",
    ...overrides,
  };
}

/** 目录应答信封（200）。 */
function okBody(rows: Record<string, unknown>[], total: number): string {
  return JSON.stringify({ data: rows, total, page: 1, perPage: 20 });
}

function httpOk(body: string): { status: number; body: string; retryAfterSeconds: number | null } {
  return { status: 200, body, retryAfterSeconds: null };
}

const AUTH_NETWORK_ERROR = { code: "network_error", message: "", httpStatus: null, retryAfterSeconds: null };

interface Mount {
  root: Root;
  container: HTMLDivElement;
  unmount(): void;
}

/** onDeliver 测试桩：与真实签名做交集（渲染传参 + 断言两头都可用）。 */
type DeliverMock = ((file: File, sourceBookId: string) => void) & ReturnType<typeof vi.fn>;

/** vi.fn 的 Mock 类型与交集签名之间 variance 繁琐，创建处统一收口断言。 */
function deliverMock(): DeliverMock {
  return vi.fn() as unknown as DeliverMock;
}

function mountTab(onDeliver: DeliverMock): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DiscoverTab onDeliver={onDeliver} />));
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 冲刷微任务直到组件稳定（fetchPage/download 链路的 promise 落地）。 */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => {});
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function findButton(container: HTMLElement, includes: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => textOf(b).includes(includes));
  if (!btn) throw new Error(`button not found: ${includes}`);
  return btn as HTMLButtonElement;
}

function searchInput(m: Mount): HTMLInputElement {
  const el = m.container.querySelector<HTMLInputElement>("input.discover-search");
  if (!el) throw new Error("search input not found");
  return el;
}

function gradeSelect(m: Mount): HTMLSelectElement {
  const el = m.container.querySelector<HTMLSelectElement>("select.discover-grade-select");
  if (!el) throw new Error("grade select not found");
  return el;
}

/** jsdom 下改受控控件值（原生 setter + 事件，React 才会接收）。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

beforeEach(() => {
  mocks.booksList.mockReset();
  mocks.booksDownload.mockReset();
  mocks.onBooksDownloadProgress.mockReset();
  mocks.authTrackEvent.mockReset();
  mocks.onBooksDownloadProgress.mockImplementation(async () => () => undefined);
  mocks.booksList.mockResolvedValue(httpOk(okBody([], 0)));
  mocks.booksDownload.mockResolvedValue({ status: 200, body: "", retryAfterSeconds: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DiscoverTab（发现书库）", () => {
  it("挂载即上报 discover_view（云端 track 未登录/失败静默）", async () => {
    const m = mountTab(deliverMock());
    await flush();
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("discover_view", {});
    m.unmount();
  });

  it("装载成功：booksList({page:1,perPage:20}) → 卡片渲染书名/作者/难度/大小/许可", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book()], 1)));
    const m = mountTab(deliverMock());
    await flush();
    expect(mocks.booksList).toHaveBeenCalledWith({ q: undefined, grade: undefined, page: 1, perPage: 20 });
    const text = m.container.textContent ?? "";
    expect(text).toContain("Alice's Adventures in Wonderland");
    expect(text).toContain("Lewis Carroll");
    expect(text).toContain("入门");
    expect(text).toContain("0.8 MB");
    expect(text).toContain("许可：Public Domain");
    expect(text).toContain("共 1 本");
    m.unmount();
  });

  it("筛选：q 输入 poe 按 Enter → booksList 收到 {q:'poe',grade:undefined,page:1,perPage:20}", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([], 0)));
    const m = mountTab(deliverMock());
    await flush();
    act(() => {
      setInputValue(searchInput(m), "poe");
      pressEnter(searchInput(m));
    });
    await flush();
    expect(mocks.booksList.mock.calls[1][0]).toEqual({ q: "poe", grade: undefined, page: 1, perPage: 20 });
    m.unmount();
  });

  it("grade 切「进阶」→ grade:'medium' 重拉第一页", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([], 0)));
    const m = mountTab(deliverMock());
    await flush();
    act(() => setSelectValue(gradeSelect(m), "medium"));
    await flush();
    expect(mocks.booksList.mock.calls[1][0]).toEqual({ q: undefined, grade: "medium", page: 1, perPage: 20 });
    m.unmount();
  });

  it("加载更多：1/3 → 点按钮拉 page 2 → 累计 2 行、按钮文案含 2/3", async () => {
    mocks.booksList
      .mockResolvedValueOnce(httpOk(okBody([book()], 3)))
      .mockResolvedValueOnce(httpOk(okBody([book({ id: "second-book", title: "Second Book" })], 3)));
    const m = mountTab(deliverMock());
    await flush();
    expect(m.container.querySelectorAll(".discover-card")).toHaveLength(1);
    const more = findButton(m.container, "加载更多");
    expect(textOf(more)).toContain("1/3");
    await act(async () => {
      more.click();
    });
    await flush();
    expect(mocks.booksList.mock.calls[1][0]).toEqual({ q: undefined, grade: undefined, page: 2, perPage: 20 });
    expect(m.container.querySelectorAll(".discover-card")).toHaveLength(2);
    expect(textOf(findButton(m.container, "加载更多"))).toContain("2/3");
    m.unmount();
  });

  it("进度：下载中回调 {received:524288,total:812546} → 显示 0.5 MB / 0.8 MB…", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book()], 1)));
    // 下载请求悬挂，保持 download 态以观察进度。
    mocks.booksDownload.mockImplementationOnce(() => new Promise(() => {}));
    const m = mountTab(deliverMock());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(mocks.onBooksDownloadProgress).toHaveBeenCalledTimes(1);
    const handler = mocks.onBooksDownloadProgress.mock.calls[0][0] as (p: unknown) => void;
    act(() => handler({ bookId: "alice-in-wonderland", received: 524288, total: 812546 }));
    expect(m.container.textContent).toContain("0.5 MB / 0.8 MB…");
    // 总大小未知（total=0）时的另一形态。
    act(() => handler({ bookId: "alice-in-wonderland", received: 524288, total: 0 }));
    expect(m.container.textContent).toContain("下载中…0.5 MB");
    m.unmount();
  });

  it("下载成功：booksDownload 200+btoa(bytes) → onDeliver 收到 File 与书目 id", async () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i;
    const sha = createHash("sha256").update(bytes).digest("hex");
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book({ sha256: sha })], 1)));
    mocks.booksDownload.mockResolvedValueOnce({
      status: 200,
      body: btoa(String.fromCharCode(...bytes)),
      retryAfterSeconds: null,
    });
    const onDeliver = deliverMock();
    const m = mountTab(onDeliver);
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(mocks.booksDownload).toHaveBeenCalledWith("alice-in-wonderland");
    expect(onDeliver).toHaveBeenCalledTimes(1);
    const [file, sourceBookId] = onDeliver.mock.calls[0] as [File, string];
    expect(sourceBookId).toBe("alice-in-wonderland");
    expect(file.name.endsWith(".epub")).toBe(true);
    expect(file.name).toBe("alice-in-wonderland.epub");
    expect(file.type).toBe("application/epub+zip");
    expect(file.size).toBe(bytes.length);
    m.unmount();
  });

  it("下载 404 → 行内「当前不可下载」+「重新下载」按钮恢复", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book()], 1)));
    mocks.booksDownload.mockResolvedValueOnce({
      status: 404,
      body: JSON.stringify({ error: { code: "not_found", message: "missing" } }),
      retryAfterSeconds: null,
    });
    const m = mountTab(deliverMock());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(m.container.textContent).toContain("这本书当前不可下载，请稍后再试或换一本");
    const retry = findButton(m.container, "重新下载");
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    // 其余卡片与列表不被破坏（不白屏不崩）。
    expect(m.container.querySelectorAll(".discover-card")).toHaveLength(1);
    m.unmount();
  });

  it("下载 429 无秒数 → 「操作过于频繁，请稍后再试」", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book()], 1)));
    mocks.booksDownload.mockResolvedValueOnce({ status: 429, body: "", retryAfterSeconds: null });
    const m = mountTab(deliverMock());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(m.container.textContent).toContain("操作过于频繁，请稍后再试");
    m.unmount();
  });

  it("下载 reject network_error → 「网络连接失败，请检查网络后重试」", async () => {
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book()], 1)));
    mocks.booksDownload.mockRejectedValueOnce(AUTH_NETWORK_ERROR);
    const m = mountTab(deliverMock());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(m.container.textContent).toContain("网络连接失败，请检查网络后重试");
    m.unmount();
  });

  it("sha256 不匹配 → 「下载的文件校验失败，请重新下载」", async () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i;
    // 目录摘要 = 另一份字节的真摘要（合法 64 位 hex，但与下载内容不符）。
    const otherSha = createHash("sha256").update(new Uint8Array(99)).digest("hex");
    mocks.booksList.mockResolvedValueOnce(httpOk(okBody([book({ sha256: otherSha })], 1)));
    mocks.booksDownload.mockResolvedValueOnce({
      status: 200,
      body: btoa(String.fromCharCode(...bytes)),
      retryAfterSeconds: null,
    });
    const onDeliver = deliverMock();
    const m = mountTab(onDeliver);
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    expect(m.container.textContent).toContain("下载的文件校验失败，请重新下载");
    expect(onDeliver).not.toHaveBeenCalled();
    m.unmount();
  });

  it("列表 reject → intake-fail「没能加载书库」+「重试」按钮", async () => {
    mocks.booksList.mockRejectedValueOnce(AUTH_NETWORK_ERROR);
    const m = mountTab(deliverMock());
    await flush();
    const fail = m.container.querySelector(".intake-fail");
    expect(fail).not.toBeNull();
    expect(textOf(fail)).toContain("没能加载书库");
    expect(textOf(fail)).toContain("网络连接失败，请检查网络后重试");
    expect(findButton(m.container, "重试")).toBeTruthy();
    m.unmount();
  });

  it("列表 200 坏 body → 「书库数据异常」整块错误卡片", async () => {
    mocks.booksList.mockResolvedValueOnce({ status: 200, body: "<html>not json</html>", retryAfterSeconds: null });
    const m = mountTab(deliverMock());
    await flush();
    const fail = m.container.querySelector(".intake-fail");
    expect(fail).not.toBeNull();
    expect(textOf(fail)).toContain("书库数据异常，请稍后重试；若持续出现请更新应用");
    m.unmount();
  });

  it("卸载时取消进度订阅（unlisten 被调用，then 竞态不炸）", async () => {
    const unlisten = vi.fn();
    let release: ((fn: () => void) => void) | null = null;
    mocks.onBooksDownloadProgress.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => (release = resolve)),
    );
    const m = mountTab(deliverMock());
    await flush();
    // 先卸载，promise 才 resolve：disposed 分支应立即执行 unlisten。
    m.unmount();
    act(() => release!(() => unlisten()));
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
