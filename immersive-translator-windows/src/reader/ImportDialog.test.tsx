// @vitest-environment jsdom
// 导入弹窗（B2 发现页接入）全链路组件测试：发现 → 下载 → 自动切 epub tab →
// parseEpub 真实解析 → 预览 → 「导入所选」draft 含 sourceBookId；
// parse 失败 / 下载 404 的失败形态；既有四导入通道回归冒烟与七 tab 渲染；
// B3 资讯订阅 tab 集成链（推荐添加 → 点文章 → 预览 → onImport url 参数）。
// mock ../lib/tauriBridge（booksList/booksDownload/onBooksDownloadProgress +
// authTrackEvent——track 走真实 analytics；readerFetchFeed——B3 feed 拉取）；
// @tauri-apps/api/core（B3 本地埋点 telemetry_log_event）与 ../lib/webExtract
// （readerFetchUrl——FeedTab 点开文章的正文抓取，漏它会在 jsdom 真发 invoke 悬挂）；
// parseEpub/bookImport/feedCatalog/feedStore 用真实实现。
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import JSZip from "jszip";
import { ImportDialog } from "./ImportDialog";
import type { BookImportDraft } from "../core/bookImport";
import { normalizeFeedUrl, RECOMMENDED_FEEDS } from "../lib/feedCatalog";

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
  readerFetchFeed: vi.fn(),
}));

// B3 专帮手：@tauri-apps/api/core（telemetry_log_event 本地埋点）与
// webExtract.readerFetchUrl（文章正文抓取）——既有用例不经这两条链路。
const feedMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readerFetchUrl: vi.fn(),
}));

vi.mock("../lib/tauriBridge", () => mocks);
vi.mock("@tauri-apps/api/core", () => ({ invoke: feedMocks.invoke }));
vi.mock("../lib/webExtract", () => ({ readerFetchUrl: feedMocks.readerFetchUrl }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- 最小 EPUB 构造（bookImport.test.ts:8 buildEpub 同款） ----

async function buildEpub(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Call of the Wild</dc:title>
    <dc:creator>Jack London</dc:creator>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

const XHTML = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;

const EPUB_FILES = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": OPF,
  "OEBPS/ch1.xhtml": XHTML(`<p>Old longings nomadic leap.</p><p>Chafing at custom's chain.</p>`),
  "OEBPS/ch2.xhtml": XHTML(`<p>Buck did not read the newspapers.</p><p>He did not know that trouble was coming.</p>`),
  "OEBPS/nav.xhtml": `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <body><nav epub:type="toc"><ol>
        <li><a href="ch1.xhtml">Into the Primitive</a></li>
        <li><a href="ch2.xhtml">The Law of Club and Fang</a></li>
      </ol></nav></body></html>`,
};

// ---- 目录 fixture ----

function book(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alice-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
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

function httpOk(body: string): { status: number; body: string; retryAfterSeconds: number | null } {
  return { status: 200, body, retryAfterSeconds: null };
}

interface DialogProps {
  /** onImportBook 测试桩：与真实签名做交集（渲染传参 + 断言两头都可用）。 */
  onImportBook: ((draft: BookImportDraft) => void) & ReturnType<typeof vi.fn>;
  /** onImport 测试桩（B3 集成用例断言；既有用例不传＝不触发）。 */
  onImport?: ((text: string, title?: string, meta?: Record<string, unknown>) => void) &
    ReturnType<typeof vi.fn>;
}

/** vi.fn 的 Mock 类型与交集签名之间 variance 繁琐，创建处统一收口断言。 */
function importBookMock(): DialogProps["onImportBook"] {
  return vi.fn() as unknown as DialogProps["onImportBook"];
}

interface Mount {
  root: Root;
  container: HTMLDivElement;
  unmount(): void;
}

function mountDialog(props: DialogProps): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ImportDialog
        vocabWords={[]}
        articles={[]}
        onImport={props.onImport ?? vi.fn()}
        onImportBook={props.onImportBook}
        onClose={vi.fn()}
      />,
    ),
  );
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => {});
}

/** 冲刷到条件成立（parseEpub 下载/解析链路含真实宏任务——verifyEpubSha256 走
 * crypto.subtle.digest——纯微任务冲刷在满载 CI 上偶发轮空；每轮先冲微任务
 * 再让出一个宏任务轮，同 DiscoverTab 的 flushUntil 口径）。 */
async function until(cond: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i += 1) {
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(cond()).toBe(true);
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function findButton(container: HTMLElement, includes: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => textOf(b).includes(includes));
  if (!btn) throw new Error(`button not found: ${includes}`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  mocks.booksList.mockReset();
  mocks.booksDownload.mockReset();
  mocks.onBooksDownloadProgress.mockReset();
  mocks.authTrackEvent.mockReset();
  mocks.readerFetchFeed.mockReset();
  mocks.onBooksDownloadProgress.mockImplementation(async () => () => undefined);
  mocks.booksList.mockResolvedValue(httpOk(JSON.stringify({ data: [], total: 0, page: 1, perPage: 20 })));
  mocks.booksDownload.mockResolvedValue({ status: 200, body: "", retryAfterSeconds: null });
  feedMocks.invoke.mockReset();
  feedMocks.readerFetchUrl.mockReset();
  feedMocks.invoke.mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ImportDialog 发现书库（B2 全链路）", () => {
  it("发现 → 下载 → 切 epub → parseEpub 真实解析 → 预览 → 导入 draft 含 sourceBookId", async () => {
    const bytes = await buildEpub(EPUB_FILES);
    const sha = createHash("sha256").update(bytes).digest("hex");
    mocks.booksList.mockResolvedValueOnce(
      httpOk(JSON.stringify({ data: [book({ sha256: sha })], total: 1, page: 1, perPage: 20 })),
    );
    mocks.booksDownload.mockResolvedValueOnce({
      status: 200,
      body: btoa(String.fromCharCode(...bytes)),
      retryAfterSeconds: null,
    });
    const onImportBook = importBookMock();
    const m = mountDialog({ onImportBook });

    // 进入发现 tab → 曝光埋点 + 目录渲染。
    act(() => findButton(m.container, "发现书库").click());
    await flush();
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("discover_view", {});
    expect(m.container.textContent).toContain("Alice's Adventures in Wonderland");

    // 下载 → 校验通过 → onDeliver → 自动切 epub tab 注入解析。
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await until(() => (m.container.textContent ?? "").includes("解析完成"));
    // 预览出书名/作者/章列（parseEpub 真实实现的产物）。
    const text = m.container.textContent ?? "";
    expect(text).toContain("The Call of the Wild");
    expect(text).toContain("Jack London");
    expect(text).toContain("Into the Primitive");
    expect(text).toContain("The Law of Club and Fang");
    expect(text).toContain("alice-in-wonderland.epub");

    // 导入所选 → draft 带 sourceBookId、章列表、cover 走 jsdom 无 canvas 降级。
    await act(async () => {
      findButton(m.container, "导入所选").click();
    });
    expect(onImportBook).toHaveBeenCalledTimes(1);
    const draft = onImportBook.mock.calls[0][0] as BookImportDraft;
    expect(draft.sourceBookId).toBe("alice-in-wonderland");
    expect(draft.title).toBe("The Call of the Wild");
    expect(draft.chapters.length).toBeGreaterThanOrEqual(1);
    expect(draft.cover).toBeUndefined();
    m.unmount();
  });

  it("parse 失败：200+base64('not a zip') → EpubTab error 卡片「没能读取这本电子书」", async () => {
    const garbage = new TextEncoder().encode("not a zip");
    const sha = createHash("sha256").update(garbage).digest("hex");
    mocks.booksList.mockResolvedValueOnce(
      httpOk(JSON.stringify({ data: [book({ sha256: sha })], total: 1, page: 1, perPage: 20 })),
    );
    mocks.booksDownload.mockResolvedValueOnce({
      status: 200,
      body: btoa("not a zip"),
      retryAfterSeconds: null,
    });
    const m = mountDialog({ onImportBook: importBookMock() });

    act(() => findButton(m.container, "发现书库").click());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await until(() => (m.container.textContent ?? "").includes("没能读取这本电子书"));
    const fail = m.container.querySelector(".intake-fail");
    expect(fail).not.toBeNull();
    expect(textOf(fail)).toContain("文件已损坏或不是有效的 .epub");
    // 退路按钮仍在（不白屏）。
    expect(findButton(m.container, "返回重选文件")).toBeTruthy();
    expect(findButton(m.container, "切到粘贴文本")).toBeTruthy();
    m.unmount();
  });

  it("booksDownload 404 → 停留发现 tab 行内错误，无白屏", async () => {
    mocks.booksList.mockResolvedValueOnce(
      httpOk(JSON.stringify({ data: [book()], total: 1, page: 1, perPage: 20 })),
    );
    mocks.booksDownload.mockResolvedValueOnce({
      status: 404,
      body: JSON.stringify({ error: { code: "not_found", message: "missing" } }),
      retryAfterSeconds: null,
    });
    const onImportBook = importBookMock();
    const m = mountDialog({ onImportBook });

    act(() => findButton(m.container, "发现书库").click());
    await flush();
    await act(async () => {
      findButton(m.container, "下载").click();
    });
    await flush();
    // 仍在发现 tab：卡片在、行内红字在、重新下载可点；epub 预览未出现、未上抛。
    expect(m.container.querySelectorAll(".discover-card")).toHaveLength(1);
    expect(m.container.querySelector(".discover-dl-error")).not.toBeNull();
    expect(m.container.textContent).toContain("这本书当前不可下载，请稍后再试或换一本");
    expect((findButton(m.container, "重新下载") as HTMLButtonElement).disabled).toBe(false);
    expect(m.container.textContent ?? "").not.toContain("解析完成");
    expect(onImportBook).not.toHaveBeenCalled();
    m.unmount();
  });

  it("回归冒烟：直接切「EPUB / 长书」tab（无注入）→ idle 拖拽区原样", async () => {
    const m = mountDialog({ onImportBook: importBookMock() });
    act(() => findButton(m.container, "EPUB / 长书").click());
    await flush();
    expect(m.container.textContent).toContain("拖入整本 .epub 电子书，或点击选择");
    // 注入未发生：未进入 parsing/preview。
    expect(m.container.textContent ?? "").not.toContain("解析完成");
    m.unmount();
  });

  it("七 tab 标签均渲染", async () => {
    const m = mountDialog({ onImportBook: importBookMock() });
    for (const label of ["内置文库", "EPUB / 长书", "本地文件", "网页链接", "粘贴文本", "发现书库", "资讯订阅"]) {
      expect(findButton(m.container, label)).toBeTruthy();
    }
    m.unmount();
  });

  it("网页链接（UrlTab）：readerFetchUrl 返回 truncated → 预览卡显示「原文过长」提示", async () => {
    feedMocks.readerFetchUrl.mockResolvedValueOnce({
      url: "https://en.wikipedia.org/wiki/Reading",
      host: "en.wikipedia.org",
      title: "Reading",
      text: "Reading is the process of taking in the sense or meaning of letters, symbols, or sentence structure.",
      truncated: true,
    });
    const m = mountDialog({ onImportBook: importBookMock() });

    // 切「网页链接」tab → 原生 setter 给受控输入赋值 → 抓取正文。
    act(() => findButton(m.container, "网页链接").click());
    await flush();
    const input = m.container.querySelector<HTMLInputElement>('input[aria-label="文章链接"]');
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input!, "https://en.wikipedia.org/wiki/Reading");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      findButton(m.container, "抓取正文").click();
    });
    await until(() => (m.container.textContent ?? "").includes("原文过长，仅导入前 50,000 字符"));
    expect(m.container.textContent).toContain("en.wikipedia.org");
    m.unmount();
  });

  it("资讯订阅（B3）：点开一篇文章走导入管线 → 「加入书架并开始阅读」onImport 带 url 链参数", async () => {
    const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>NASA News Releases</title>
<link>https://www.nasa.gov/</link>
<item>
  <title>Artemis II Crew Named</title>
  <link>https://www.nasa.gov/artemis-ii</link>
  <description>Artemis II crew announcement detail.</description>
  <pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate>
</item>
</channel></rss>`;
    const FETCH_TEXT = "Artemis II will fly around the Moon. The crew of four is ready for the mission.";
    mocks.readerFetchFeed.mockResolvedValueOnce(RSS_XML);
    feedMocks.readerFetchUrl.mockResolvedValueOnce({
      url: "https://www.nasa.gov/artemis-ii",
      host: "www.nasa.gov",
      title: "Artemis II Crew Named",
      text: FETCH_TEXT,
    });
    const onImport = vi.fn() as unknown as NonNullable<DialogProps["onImport"]>;
    const m = mountDialog({ onImportBook: importBookMock(), onImport });

    // 进入资讯订阅 tab → FeedTab 挂载：本地曝光埋点（telemetry_log_event）。
    act(() => findButton(m.container, "资讯订阅").click());
    await flush();
    expect(feedMocks.invoke).toHaveBeenCalledWith("telemetry_log_event", {
      name: "feed_view",
      props: {},
    });
    // 推荐列表勾选 NASA 源 → 同一添加链拉回 feed 并入库（feedCatalog/feedStore 真实现）。
    const nasa = RECOMMENDED_FEEDS.find((r) => r.url.includes("nasa.gov")) ?? RECOMMENDED_FEEDS[0];
    const recoRow = [...m.container.querySelectorAll(".feed-reco-item")].find((el) =>
      (el.textContent ?? "").includes(nasa.title),
    );
    expect(recoRow).toBeTruthy();
    await act(async () => {
      (recoRow!.querySelector("button") as HTMLButtonElement).click();
    });
    await until(() => (m.container.textContent ?? "").includes("Artemis II Crew Named"));
    // 添加链发起拉取的是归一化地址（推荐源 URL 去尾部斜杠）。
    expect(mocks.readerFetchFeed).toHaveBeenCalledWith(normalizeFeedUrl(nasa.url));

    // 点文章标题 → readerFetchUrl 抓正文 → UrlTab 同款预览卡。
    await act(async () => {
      findButton(m.container, "Artemis II Crew Named").click();
    });
    await until(() => (m.container.textContent ?? "").includes("www.nasa.gov"));
    expect(m.container.textContent).toContain("加入书架并开始阅读");

    // 确认导入：onImport 收到正文/标题与 url 源 meta（ImportDialog 接线为真）。
    await act(async () => {
      findButton(m.container, "加入书架并开始阅读").click();
    });
    expect(onImport).toHaveBeenCalledTimes(1);
    const [text, title, meta] = onImport.mock.calls[0] as [
      string,
      string,
      { sourceType?: string; sourceUrl?: string; level?: string },
    ];
    expect(text).toBe(FETCH_TEXT);
    expect(title).toBe("Artemis II Crew Named");
    expect(meta.sourceType).toBe("url");
    expect(meta.sourceUrl).toBe("https://www.nasa.gov/artemis-ii");
    expect(typeof meta.level).toBe("string");
    // 同帧埋 feed_import（本地轨，零网络）。
    expect(feedMocks.invoke).toHaveBeenCalledWith("telemetry_log_event", {
      name: "feed_import",
      props: { host: "www.nasa.gov" },
    });
    m.unmount();
  });
});
