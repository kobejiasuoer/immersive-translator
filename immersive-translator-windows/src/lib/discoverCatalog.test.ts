// 发现书库纯函数与文案（B2）：信封解析过滤口径、base64 字节还原、sha256 校验
// （node:crypto 真摘要向量）、File 构造、大小格式化、三条错误文案逐字断言
// （authErrorText 真实现联测兜底分支）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DISCOVER_BODY_ERROR_TEXT,
  bytesFromBase64,
  discoverDownloadErrorText,
  discoverInvokeErrorText,
  discoverListErrorText,
  epubFileOf,
  formatFileSize,
  parseBooksPage,
  verifyEpubSha256,
  type DiscoverBook,
} from "./discoverCatalog";

/** 全 15 键的服务端行（description/wordCount 均在）。 */
function fullRow(): Record<string, unknown> {
  return {
    id: "alice-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    description: "A girl falls down a rabbit hole.",
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
    sha256: "a".repeat(64),
  };
}

function envOf(data: unknown, total = 1): string {
  return JSON.stringify({ data, total, page: 1, perPage: 20 });
}

describe("parseBooksPage", () => {
  it("15 键行全字段解析", () => {
    const page = parseBooksPage(envOf([fullRow()], 1))!;
    expect(page).not.toBeNull();
    expect(page.total).toBe(1);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
    expect(page.books).toHaveLength(1);
    expect(page.books[0]).toEqual({
      id: "alice-in-wonderland",
      title: "Alice's Adventures in Wonderland",
      author: "Lewis Carroll",
      description: "A girl falls down a rabbit hole.",
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
      sha256: "a".repeat(64),
    });
  });

  it("缺 description/wordCount → undefined（服务端空时整体省键）", () => {
    const row = fullRow();
    delete row.description;
    delete row.wordCount;
    const page = parseBooksPage(envOf([row]))!;
    expect(page.books[0].description).toBeUndefined();
    expect(page.books[0].wordCount).toBeUndefined();
    // 其余字段仍在（单键缺失不拖垮整行）。
    expect(page.books[0].title).toBe("Alice's Adventures in Wonderland");
  });

  it("行缺 id/title → 只过滤该行，不整页失败", () => {
    const noId = fullRow();
    delete noId.id;
    const noTitle = fullRow();
    delete noTitle.title;
    const page = parseBooksPage(envOf([noId, noTitle, fullRow()], 3))!;
    expect(page.books).toHaveLength(1);
    expect(page.books[0].id).toBe("alice-in-wonderland");
    expect(page.total).toBe(3);
  });

  it("data 非数组 / body 非 JSON → null", () => {
    expect(parseBooksPage(JSON.stringify({ total: 0 }))).toBeNull();
    expect(parseBooksPage("not json at all")).toBeNull();
  });
});

describe("bytesFromBase64", () => {
  it("btoa 已知向量往返逐字节相等", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66, 250, 7]);
    const back = bytesFromBase64(btoa(String.fromCharCode(...bytes)));
    expect(back).toHaveLength(bytes.length);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe("verifyEpubSha256", () => {
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

  it("node:crypto 真摘要 → true", async () => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(await verifyEpubSha256(bytes, digest)).toBe(true);
    // 大写 hex 也接受（内部归一小写比对）。
    expect(await verifyEpubSha256(bytes, digest.toUpperCase())).toBe(true);
  });

  it("篡改一位 → false", async () => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const tampered = new Uint8Array(bytes);
    tampered[100] = (tampered[100] + 1) % 256;
    expect(await verifyEpubSha256(tampered, digest)).toBe(false);
  });

  it("expected 非法（非 64 位 hex）→ true 放行", async () => {
    expect(await verifyEpubSha256(bytes, "")).toBe(true);
    expect(await verifyEpubSha256(bytes, "not-a-digest")).toBe(true);
  });
});

describe("epubFileOf", () => {
  it("文件名 <id>.epub、type、size 与字节一致", () => {
    const book = { ...fullRow(), sha256: "0".repeat(64) } as unknown as DiscoverBook;
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 1]);
    const file = epubFileOf(book, bytes);
    expect(file.name).toBe("alice-in-wonderland.epub");
    expect(file.type).toBe("application/epub+zip");
    expect(file.size).toBe(bytes.length);
  });
});

describe("formatFileSize", () => {
  it("524288 → 0.5 MB；300000 → 293 KB", () => {
    expect(formatFileSize(524288)).toBe("0.5 MB");
    expect(formatFileSize(300_000)).toBe("293 KB");
  });
});

describe("错误文案逐字断言", () => {
  it("discoverListErrorText：400/列表 404/429 有无秒数/5xx 与未知", () => {
    expect(discoverListErrorText({ status: 400, body: "", retryAfterSeconds: null })).toBe(
      "请求参数异常，请更新应用后重试；若持续出现请反馈",
    );
    expect(discoverListErrorText({ status: 404, body: "", retryAfterSeconds: null })).toBe(
      "书库暂时无法访问（404），请稍后再试",
    );
    expect(discoverListErrorText({ status: 429, body: "", retryAfterSeconds: 37 })).toBe(
      "操作过于频繁，请 37 秒后再试",
    );
    expect(discoverListErrorText({ status: 429, body: "", retryAfterSeconds: null })).toBe(
      "操作过于频繁，请稍后再试",
    );
    expect(discoverListErrorText({ status: 503, body: "", retryAfterSeconds: null })).toBe(
      "服务暂时不可用，请稍后再试",
    );
    expect(discoverListErrorText({ status: 418, body: "", retryAfterSeconds: null })).toBe(
      "服务暂时不可用，请稍后再试",
    );
  });

  it("信封坏文案常量（errorDesign 7）", () => {
    expect(DISCOVER_BODY_ERROR_TEXT).toBe("书库数据异常，请稍后重试；若持续出现请更新应用");
  });

  it("discoverDownloadErrorText：下载 404/400/401/429/未知（与列表 404 双口径分开）", () => {
    expect(discoverDownloadErrorText({ status: 404, body: "", retryAfterSeconds: null })).toBe(
      "这本书当前不可下载，请稍后再试或换一本",
    );
    expect(discoverDownloadErrorText({ status: 400, body: "", retryAfterSeconds: null })).toBe(
      "请求参数异常，请更新应用后重试；若持续出现请反馈",
    );
    expect(discoverDownloadErrorText({ status: 401, body: "", retryAfterSeconds: null })).toBe(
      "登录已失效，请重新登录",
    );
    expect(discoverDownloadErrorText({ status: 429, body: "", retryAfterSeconds: null })).toBe(
      "操作过于频繁，请稍后再试",
    );
    expect(discoverDownloadErrorText({ status: 429, body: "", retryAfterSeconds: 9 })).toBe(
      "操作过于频繁，请 9 秒后再试",
    );
    expect(discoverDownloadErrorText({ status: 500, body: "", retryAfterSeconds: null })).toBe(
      "服务暂时不可用，请稍后再试",
    );
  });

  it("discoverInvokeErrorText：platform_unavailable 专属文案，其余走 authErrorText 真实现兜底", () => {
    expect(discoverInvokeErrorText({ code: "platform_unavailable", message: "", httpStatus: null, retryAfterSeconds: null })).toBe(
      "书库服务暂未开放，请稍后再试",
    );
    // authErrorText 真实现联测：network_error / unknown / 字符串 reject 三形态。
    expect(discoverInvokeErrorText({ code: "network_error", message: "", httpStatus: null, retryAfterSeconds: null })).toBe(
      "网络连接失败，请检查网络后重试",
    );
    expect(discoverInvokeErrorText({ code: "unknown", message: "boom", httpStatus: null, retryAfterSeconds: null })).toBe(
      "服务响应异常，请稍后再试",
    );
    expect(discoverInvokeErrorText("network_error")).toBe("网络连接失败，请检查网络后重试");
  });
});
