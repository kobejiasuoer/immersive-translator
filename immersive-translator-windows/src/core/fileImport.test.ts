import { describe, expect, it } from "vitest";
import {
  detectImportFileKind,
  extractTextFromFile,
  FileImportError,
  fileTitleOf,
  hasMeaningfulText,
  importKindSourceType,
  joinPdfLines,
  maxBytesForKind,
  pdfItemsToLines,
  type PdfjsLike,
  type PdfTextItem,
} from "./fileImport";

// ---------- 测试工具：手工构造 docx（STORE zip）与带文本层的 PDF ----------

/** 标准查表 CRC32（ZIP 用）。 */
function crc32(bytes: Uint8Array): number {
  let c = 0;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 最小 ZIP（STORE 不压缩）：本地头 + 中央目录 + EOCD，全小端。 */
function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length + e.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(12, 0x21, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const localsSize = locals.reduce((n, l) => n + l.length, 0);
  const out = new Uint8Array(localsSize + centralSize + 22);
  let pos = 0;
  for (const l of locals) {
    out.set(l, pos);
    pos += l.length;
  }
  for (const c of centrals) {
    out.set(c, pos);
    pos += c.length;
  }
  const ev = new DataView(out.buffer, pos);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, localsSize, true);
  return out;
}

function docxParagraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/** 最小 docx：mammoth 缺关系文件时回退到 word/document.xml。 */
function buildTestDocx(paragraphs: string[]): File {
  const body = paragraphs.map(docxParagraph).join("");
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`;
  const bytes = buildZip([{ name: "word/document.xml", data: new TextEncoder().encode(xml) }]);
  return new File([bytes], "sample.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function escapePdfText(s: string): string {
  return s.replace(/([()\\])/g, "\\$1");
}

/** 单页带文本层的最小 PDF（Helvetica + Tj），xref 偏移实时计算。 */
function buildTestPdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const content =
    "BT /F1 12 Tf 72 720 Td\n" +
    lines.map((l) => `(${escapePdfText(l)}) Tj 0 -18 Td`).join("\n") +
    "\nET";
  const objs: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    4: `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = enc.encode(out).length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = enc.encode(out).length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return enc.encode(out);
}

/** Node 单测用 pdfjs legacy build（无 worker 依赖）。 */
async function loadPdfjsLegacy(): Promise<PdfjsLike> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { getDocument };
}

function fakePdfjs(pages: PdfTextItem[][]): PdfjsLike {
  return {
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          async getPage(n: number) {
            return {
              async getTextContent() {
                return { items: pages[n - 1] };
              },
            };
          },
        }),
      };
    },
  };
}

// ---------- 纯函数 ----------

describe("detectImportFileKind / importKindSourceType / fileTitleOf", () => {
  it("扩展名大小写不敏感", () => {
    expect(detectImportFileKind("Report.PDF")).toBe("pdf");
    expect(detectImportFileKind("notes.DocX")).toBe("docx");
    expect(detectImportFileKind("a.txt")).toBe("txt");
  });

  it("旧版 .doc 与其他格式不支持", () => {
    expect(detectImportFileKind("archive.doc")).toBeNull();
    expect(detectImportFileKind("photo.png")).toBeNull();
    expect(detectImportFileKind("noext")).toBeNull();
  });

  it("来源类型映射：txt 维持 paste，pdf/docx 各自枚举", () => {
    expect(importKindSourceType("txt")).toBe("paste");
    expect(importKindSourceType("pdf")).toBe("pdf");
    expect(importKindSourceType("docx")).toBe("docx");
  });

  it("文件名去扩展名做标题", () => {
    expect(fileTitleOf("My Article.docx")).toBe("My Article");
    expect(fileTitleOf(".pdf")).toBe(".pdf");
  });

  it("PDF/docx 上限比纯文本宽（嵌图不影响文本抽取）", () => {
    expect(maxBytesForKind("pdf")).toBe(maxBytesForKind("docx"));
    expect(maxBytesForKind("docx")).toBeGreaterThan(maxBytesForKind("txt"));
  });
});

describe("pdfItemsToLines / joinPdfLines", () => {
  it("hasEOL 结束当前行", () => {
    const items = [
      { str: "Hello world.", hasEOL: true },
      { str: "Second ", hasEOL: false },
      { str: "line.", hasEOL: false },
    ];
    expect(pdfItemsToLines(items)).toEqual(["Hello world.", "Second line."]);
  });

  it("逐词定位（无空格字形）的 item 之间补空格，不粘连", () => {
    const items = [
      { str: "Word", hasEOL: false },
      { str: "positioning", hasEOL: false },
      { str: "glues", hasEOL: true },
    ];
    expect(pdfItemsToLines(items)).toEqual(["Word positioning glues"]);
  });

  it("两侧已有空白/空串 item 不重复补空格", () => {
    const items = [
      { str: "hello ", hasEOL: false },
      { str: "world", hasEOL: false },
      { str: "", hasEOL: false },
      { str: "next", hasEOL: true },
    ];
    expect(pdfItemsToLines(items)).toEqual(["hello world next"]);
  });

  it("跨行断词去连字符拼接", () => {
    expect(joinPdfLines(["comprehen-", "sive reading"])).toBe("comprehensive reading");
  });

  it("下行大写开头视为新词而非断词", () => {
    expect(joinPdfLines(["warm-", "Up drills"])).toBe("warm- Up drills");
  });

  it("空白折叠与空行跳过", () => {
    expect(joinPdfLines(["  ", "One   two.", "  Three.  "])).toBe("One two. Three.");
  });
});

describe("hasMeaningfulText", () => {
  it("页码/装饰字符不算文本层", () => {
    expect(hasMeaningfulText("12 · · · 3")).toBe(false);
    expect(hasMeaningfulText("")).toBe(false);
  });
  it("英文单词与中文都算", () => {
    expect(hasMeaningfulText("Hello")).toBe(true);
    expect(hasMeaningfulText("中文正文")).toBe(true);
  });
});

// ---------- extractTextFromFile ----------

describe("extractTextFromFile", () => {
  it("txt 原样读出", async () => {
    const file = new File(["Hello world.\n\nBye."], "a.txt", { type: "text/plain" });
    const res = await extractTextFromFile(file, loadPdfjsLegacy);
    expect(res.kind).toBe("txt");
    expect(res.text).toContain("Hello world.");
  });

  it("txt 空文件报中文错误", async () => {
    const file = new File(["   "], "a.txt", { type: "text/plain" });
    await expect(extractTextFromFile(file, loadPdfjsLegacy)).rejects.toThrow(FileImportError);
  });

  it("GBK（记事本 ANSI）编码的中文正确解码，不再整篇乱码", async () => {
    // "你好世界。Hello" 的 GBK 字节序列
    const bytes = new Uint8Array([
      0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xa1, 0xa3, 0x48, 0x65, 0x6c, 0x6c, 0x6f,
    ]);
    const file = new File([bytes], "ansi.txt", { type: "text/plain" });
    const res = await extractTextFromFile(file, loadPdfjsLegacy);
    expect(res.text).toBe("你好世界。Hello");
  });

  it("带 BOM 的 UTF-16LE 按宽字符解码", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    const file = new File([bytes], "utf16.txt", { type: "text/plain" });
    const res = await extractTextFromFile(file, loadPdfjsLegacy);
    expect(res.text).toBe("Hi");
  });

  it("两种编码都解不出的文件给中文报错引导，而不是静默乱码", async () => {
    // 0x81 0x7F 非法 UTF-8，GBK 也解不出（FFFD）
    const bytes = new Uint8Array([0x81, 0x7f, 0x41]);
    const file = new File([bytes], "broken.txt", { type: "text/plain" });
    await expect(extractTextFromFile(file, loadPdfjsLegacy)).rejects.toThrow("编码");
  });

  it("不支持的扩展名明确报错", async () => {
    const file = new File(["x"], "a.doc", {});
    await expect(extractTextFromFile(file, loadPdfjsLegacy)).rejects.toThrow("仅支持");
  });

  it("超过大小上限拒绝", async () => {
    const file = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.txt", { type: "text/plain" });
    await expect(extractTextFromFile(file, loadPdfjsLegacy)).rejects.toThrow("超过");
  });

  it("docx 抽出段落（真实 mammoth）", async () => {
    const file = buildTestDocx([
      "Reading Speed",
      "Reading speed was the goal, and comprehension was the test.",
      "Second paragraph here.",
    ]);
    const res = await extractTextFromFile(file, loadPdfjsLegacy);
    expect(res.kind).toBe("docx");
    expect(res.text).toContain("Reading speed was the goal, and comprehension was the test.");
    expect(res.text).toContain("Second paragraph here.");
  });

  it("docx 缺正文部件给中文报错", async () => {
    const bytes = buildZip([{ name: "unrelated.txt", data: new TextEncoder().encode("x") }]);
    const file = new File([bytes], "bad.docx", {});
    await expect(extractTextFromFile(file, loadPdfjsLegacy)).rejects.toThrow("Word 解析失败");
  });

  it("pdf 抽出文本层（真实 pdfjs legacy）", async () => {
    const bytes = buildTestPdf(["Hello world from PDF text layer.", "Second line here."]);
    const file = new File([bytes], "sample.pdf", { type: "application/pdf" });
    const res = await extractTextFromFile(file, loadPdfjsLegacy);
    expect(res.kind).toBe("pdf");
    expect(res.pages).toBe(1);
    expect(res.text).toContain("Hello world from PDF text layer.");
    expect(res.text).toContain("Second line here.");
  });

  it("无文本层 PDF（扫描件）明确引导走粘贴", async () => {
    const pdfjs = fakePdfjs([
      [
        { str: "3", hasEOL: true }, // 页码
        { str: " ", hasEOL: false },
      ],
    ]);
    const file = new File([new Uint8Array(8)], "scan.pdf", { type: "application/pdf" });
    await expect(extractTextFromFile(file, () => Promise.resolve(pdfjs))).rejects.toThrow("粘贴文本");
  });

  it("多页 PDF 以空行分页", async () => {
    const pdfjs = fakePdfjs([
      [{ str: "Page one text.", hasEOL: true }],
      [{ str: "Page two text.", hasEOL: true }],
    ]);
    const file = new File([new Uint8Array(8)], "two.pdf", { type: "application/pdf" });
    const res = await extractTextFromFile(file, () => Promise.resolve(pdfjs));
    expect(res.pages).toBe(2);
    expect(res.text).toBe("Page one text.\n\nPage two text.");
  });
});
