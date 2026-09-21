/**
 * 本地文件导入：.txt / .docx / .pdf → 正文纯文本。
 *
 * - txt：按 BOM/严格 UTF-8/GBK 顺序探测编码（记事本 ANSI 文件可导入）。
 * - docx：mammoth（browser build，vite 走 browser 字段映射）extractRawText 抽段落。
 * - pdf：pdfjs-dist 抽文本层；扫描件/无文本层给明确报错引导走粘贴，
 *   绝不静默产出空文章。
 *
 * 抽出的文本交给 sentenceSplit.splitParagraphs 切段，走既有 onImport 流程。
 * PDF/DOCX 不做排版还原（需求卡 R1 明确不做），只保证句子流完整。
 */

import type { ArticleSourceType } from "./readerTypes";

export type ImportFileKind = "txt" | "docx" | "pdf";

/** 带中文提示的导入失败；message 直接进 ImportDialog 的失败态。 */
export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileImportError";
  }
}

export function detectImportFileKind(fileName: string): ImportFileKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/** 文件来源 → ArticleSourceType；txt 维持既有 "paste"。 */
export function importKindSourceType(kind: ImportFileKind): ArticleSourceType {
  if (kind === "pdf") return "pdf";
  if (kind === "docx") return "docx";
  return "paste";
}

/** 文件名去扩展名做默认标题。 */
export function fileTitleOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base || fileName;
}

// 纯文本 4MB 与粘贴页一致；docx/pdf 常嵌图片与字体子集（不影响文本抽取），
// 放宽到 32MB（仍拒绝大部头扫描件）。
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DOC_FILE_BYTES = 32 * 1024 * 1024;

export function maxBytesForKind(kind: ImportFileKind): number {
  return kind === "txt" ? MAX_TEXT_FILE_BYTES : MAX_DOC_FILE_BYTES;
}

export interface ExtractedFileText {
  kind: ImportFileKind;
  text: string;
  /** PDF 页数（其他格式缺省）。 */
  pages?: number;
}

// ---------- PDF ----------

/** pdfjs 的最小面（便于单测注入 mock，不依赖 worker）。带索引签名以兼容 TextMarkedContent 等杂项项。 */
export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  [key: string]: unknown;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup?: () => void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

export interface PdfjsLike {
  getDocument(args: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
}

/**
 * pdfjs 文本项 → 行列表：hasEOL 结束当前行。纯函数，单测覆盖。
 * 逐词定位排版的 PDF（LaTeX 等）文本项之间没有空格字形，直接拼接会把
 * "Word positioning glues" 粘成 "Wordpositioningglues"——相邻项两侧都无
 * 空白时补一个空格（宁可多空格，后续 joinPdfLines/切句都会折叠空白）。
 */
export function pdfItemsToLines(items: PdfTextItem[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str) {
      if (current && !/\s$/.test(current) && !/^\s/.test(str)) current += " ";
      current += str;
    }
    if (item.hasEOL) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 行 → 段落文本：行尾 "word-" 且下一行小写开头时去连字符拼接（跨行断词），
 * 其余行以空格相连。整页合成一个段落 —— PDF 里行内句号不等于段落结束，
 * 段落结构无从可靠恢复，交给 splitSentences 按句界切分即可。
 */
export function joinPdfLines(lines: string[]): string {
  const parts: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const prev = parts[parts.length - 1];
    if (prev !== undefined && /[A-Za-z]-$/.test(prev) && /^[a-z]/.test(line)) {
      parts[parts.length - 1] = prev.slice(0, -1) + line;
    } else {
      parts.push(line);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 是否存在可读文字（判定文本层，而非页码/装饰字符）。 */
export function hasMeaningfulText(text: string): boolean {
  return /[A-Za-z]{2,}|[\u4e00-\u9fff]{2,}/.test(text);
}

async function extractPdfText(
  file: File,
  loadPdfjs: () => Promise<PdfjsLike>,
): Promise<ExtractedFileText> {
  let doc: PdfDocumentLike;
  try {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch (e) {
    throw new FileImportError(
      `PDF 解析失败：${e instanceof Error ? e.message : String(e)}。文件可能已损坏或加了密。`,
    );
  }
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(joinPdfLines(pdfItemsToLines(content.items)));
    page.cleanup?.();
  }
  const text = pageTexts.filter(Boolean).join("\n\n");
  if (!hasMeaningfulText(text)) {
    throw new FileImportError(
      "这个 PDF 提取不到文字（多半是扫描件或图片导出，没有文字层）。\n请改用「粘贴文本」把内容贴进来，或换一个文字版 PDF。",
    );
  }
  return { kind: "pdf", text, pages: doc.numPages };
}

// ---------- TXT ----------

/**
 * 按字节探测编码解码文本文件：UTF-8（含 BOM）/ UTF-16（BOM）/ GBK 兜底。
 * 中文 Windows 记事本「ANSI」编码的 .txt 是常见场景，按 UTF-8 直读会整篇
 * 乱码（U+FFFD），这里用严格 UTF-8 解码失败后回退 GBK（Chromium/Node 内置）。
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  // BOM 优先：UTF-8 / UTF-16LE / UTF-16BE
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // 严格 UTF-8：GBK 字节序列几乎必然非法，据此区分两种常见编码。
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    /* 不是（纯）UTF-8，走 GBK */
  }
  try {
    const gbk = new TextDecoder("gbk");
    const text = gbk.decode(bytes);
    if (!text.includes("\uFFFD")) return text;
  } catch {
    /* 环境不支持 GBK，退回宽松 UTF-8 */
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function extractTxtText(file: File): Promise<ExtractedFileText> {
  const text = decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
  if (!text.trim()) throw new FileImportError("文件是空的");
  if (text.includes("\uFFFD")) {
    throw new FileImportError(
      "这个文本文件的编码无法识别（解码后存在乱码字符）。\n请在记事本里「另存为 → UTF-8」后再导入。",
    );
  }
  return { kind: "txt", text };
}

// ---------- 入口 ----------

/**
 * 解析本地文件为正文文本。解析失败/无文本层抛 FileImportError（中文可读）。
 * `loadPdfjs` 注入 pdfjs 实现（应用 = 浏览器 build + worker；单测 = legacy build / mock）。
 */
export async function extractTextFromFile(
  file: File,
  loadPdfjs: () => Promise<PdfjsLike>,
): Promise<ExtractedFileText> {
  const kind = detectImportFileKind(file.name);
  if (!kind) {
    throw new FileImportError("仅支持 .txt / .docx / .pdf 文件");
  }
  const maxBytes = maxBytesForKind(kind);
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new FileImportError(`文件超过 ${mb}MB 上限，请精简后再导入`);
  }
  if (kind === "txt") {
    return extractTxtText(file);
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    let result: { value: string };
    try {
      // mammoth browser build 只认 arrayBuffer，Node build（单测环境）只认
      // buffer；JSZip 两者都吃，一并传入各取所需（类型是互斥联合，这里整包转一次）。
      const arrayBuffer = await file.arrayBuffer();
      const input = { arrayBuffer, buffer: new Uint8Array(arrayBuffer) } as unknown as Parameters<
        typeof mammoth.extractRawText
      >[0];
      result = await mammoth.extractRawText(input);
    } catch (e) {
      throw new FileImportError(
        `Word 解析失败：${e instanceof Error ? e.message : String(e)}。请确认是 .docx（旧版 .doc 请另存为 .docx）。`,
      );
    }
    if (!result.value.trim()) {
      throw new FileImportError("这个 Word 文档里没有抽到正文段落（可能只有图片/表格）。");
    }
    return { kind, text: result.value };
  }
  return extractPdfText(file, loadPdfjs);
}
