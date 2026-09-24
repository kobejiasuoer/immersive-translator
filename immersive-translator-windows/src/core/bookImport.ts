/**
 * 整本书阅读室 · EPUB 导入解析（.epub = zip + OPF 元数据 + XHTML 章节）。
 *
 * - 只抽正文纯文本与章序，不做排版还原（沿用 fileImport「句子流完整」的口径）。
 * - 分章规则（docs/reading-room-feature-proposal.md §5.3 流程一，写死）：
 *   1) 以 toc.ncx / EPUB NAV 目录为准；一个 toc 条目可对应多个 spine XHTML
 *      （「多 HTML 拼一章」），按 toc 条目把它们合并为一章；
 *   2) 多级目录展平到叶子条目，卷名作章名前缀（「卷一 · 第 3 章」）；
 *   3) 无 toc、或 toc 对 spine 实质内容的覆盖率异常（>20% 的实质 spine 文件
 *      未被任何条目引用，判为可疑目录）时回退：按 spine 顺序每 ~3,000 词
 *      自动分节，命名「第 N 节」，预览页明示。
 * - DRM：META-INF/encryption.xml 里加密了非字体资源 → 判受保护，失败退出，
 *   不产出空书，也不提供任何解除技术保护的指引（版权红线）。
 *   只混淆字体的 encryption.xml（合法做法）不算 DRM。
 * - 解析在 webview 里做（JSZip + DOMParser），落盘走 Rust store 命令；
 *   docx/pdf 同为前端抽取管线，失败一律中文报错绝不静默给空书。
 */

import JSZip from "jszip";
import { countWords } from "./articleBuilder";
import { FileImportError } from "./fileImport";

/** 单章（纯文本 + 词数；Article 由导入方按章调 buildArticleFromText 构建）。 */
export interface EpubChapter {
  title: string;
  text: string;
  wordCount: number;
}

export interface EpubBook {
  title: string;
  author: string;
  /** 原始封面 dataURL（可能较大，入库前由调用方缩小；无封面缺省）。 */
  coverDataUrl?: string;
  chapters: EpubChapter[];
  /** 章节是否来自书目（toc）。false = 回退分节。 */
  tocUsed: boolean;
  /** 回退时的明示文案（预览页展示）。 */
  fallbackNotice?: string;
  totalWords: number;
  /** 估时（分钟，135 wpm，与 library.ts 同口径）。 */
  minutes: number;
}

const MAX_EPUB_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TEXT_CHARS = 12_000_000;
const MAX_CHAPTERS = 999;
/** 回退分节的每节词数。 */
const FALLBACK_SECTION_WORDS = 3000;
/** 「实质内容」判定：纯文本少于此的 spine 文件（封面/扉页等）不计入覆盖率。 */
const SUBSTANTIAL_TEXT_CHARS = 200;
/** >20% 的实质 spine 文件未被 toc 引用 → 可疑目录 → 回退。 */
const MAX_UNREFERENCED_RATIO = 0.2;
/** 封面 dataURL 上限（超过视为异常资源，丢弃封面不影响文本）。 */
const MAX_COVER_DATAURL_CHARS = 400_000;

const WPM = 135;

/** 导入向导确认时交给 ReaderApp 的入库草稿（章文本 → Article 在 ReaderApp 侧构建）。 */
export interface BookImportDraft {
  title: string;
  author?: string;
  /** 缩小后的封面 dataURL（无封面缺省）。 */
  cover?: string;
  /** 用户勾选的章（按书序）。 */
  chapters: { title: string; text: string }[];
  /** 三个目标的大纲词命中数（按所选章文本实算）。 */
  radar: { kaoyan: number; cet4: number; cet6: number };
  totalWords: number;
  minutes: number;
}

/**
 * 封面缩小为 ≤160px 宽的 JPEG dataURL（书卡/索引保持轻量；
 * 浏览器 canvas 才可用，失败返回 undefined，调用方退回原图或无封面）。
 */
export async function downscaleCoverDataUrl(
  dataUrl: string,
  maxW = 160,
  maxH = 240,
): Promise<string | undefined> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const img = await createImageBitmap(blob);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, w, h);
    img.close();
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return undefined;
  }
}

/** zip 内路径定位：精确匹配优先，其次忽略大小写与 URL 编码差异。 */
function zipEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const direct = zip.file(path);
  if (direct) return direct;
  const norm = decodeURIComponent(path).toLowerCase();
  let found: JSZip.JSZipObject | null = null;
  zip.forEach((relPath, entry) => {
    if (found || entry.dir) return;
    if (decodeURIComponent(relPath).toLowerCase() === norm) found = entry;
  });
  return found;
}

/** OPF 相对 href → zip 内绝对路径（处理 ../ 与 URL 编码；fragment 丢弃）。 */
function resolveZipPath(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0] ?? "").trim();
  if (!clean) return "";
  const parts = `${baseDir}${clean}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

// ---------- XHTML → 纯文本 ----------

const SKIP_TAGS = new Set(["script", "style", "head", "template", "svg", "iframe"]);
const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
  "td", "th", "dd", "dt", "pre", "section", "article", "header", "footer",
  "figure", "figcaption", "main", "aside", "table", "tr", "ul", "ol", "body", "html",
]);

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/** 行内节点的平文本：br 折空格，跳过 script/style。 */
function inlineText(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? "";
    } else if (isElement(child)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === "br") {
        out += " ";
        return;
      }
      out += inlineText(child);
    }
  });
  return out;
}

/** 块级结构 → 段落列表：块边界切段落，行内折叠空白。 */
function blockParagraphs(node: Element): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    const text = cur.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    cur = "";
  };
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      cur += child.nodeValue ?? "";
      return;
    }
    if (!isElement(child)) return;
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "br") {
      cur += " ";
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      out.push(...blockParagraphs(child));
    } else {
      cur += inlineText(child);
    }
  });
  flush();
  return out;
}

/** 单个 XHTML 文档 → 正文纯文本（段落间空行）。解析失败返回空串。 */
export function extractXhtmlText(xml: string): string {
  const parsed = new DOMParser().parseFromString(xml, "text/xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) {
    // 宽松 HTML 再试一次（不少 epub 的 XHTML 并不严格合法）。
    const html = new DOMParser().parseFromString(xml, "text/html");
    const body = html.body;
    if (!body) return "";
    return blockParagraphs(body).join("\n\n");
  }
  const body = parsed.getElementsByTagName("body")[0];
  if (!body) return "";
  return blockParagraphs(body).join("\n\n");
}

// ---------- DRM 识别 ----------

/** encryption.xml 里是否加密了非字体资源（= DRM；只混淆字体是合法做法）。 */
async function looksDrmProtected(zip: JSZip): Promise<boolean> {
  const entry = zipEntry(zip, "META-INF/encryption.xml");
  if (!entry) return false;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(await entry.async("string"), "text/xml");
  } catch {
    return false;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return false;
  const fontRe = /\.(ttf|otf|woff2?)(\?|$)/i;
  const refs = Array.from(doc.getElementsByTagName("*")).filter(
    (el) => el.tagName.toLowerCase().endsWith("cipherreference"),
  );
  if (refs.length === 0) return false;
  return refs.some((el) => {
    const uri = el.getAttribute("URI") ?? "";
    return !fontRe.test(uri);
  });
}

// ---------- OPF / 目录解析 ----------

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

interface OpfInfo {
  opfPath: string;
  opfDir: string;
  title: string;
  author: string;
  manifest: Map<string, ManifestItem>;
  spine: string[];
  ncxId: string | null;
  coverItemId: string | null;
}

function firstTagText(doc: Document, tag: string): string {
  const el = doc.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? "";
}

function parseOpf(opfPath: string, xml: string, fileTitle: string): OpfInfo | null {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const manifest = new Map<string, ManifestItem>();
  for (const el of Array.from(doc.getElementsByTagName("item"))) {
    const id = el.getAttribute("id");
    const href = el.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href,
      mediaType: el.getAttribute("media-type") ?? "",
      properties: el.getAttribute("properties") ?? "",
    });
  }
  const spine: string[] = [];
  let ncxId: string | null = null;
  for (const el of Array.from(doc.getElementsByTagName("itemref"))) {
    const idref = el.getAttribute("idref");
    if (idref) spine.push(idref);
  }
  const spineEl = doc.getElementsByTagName("spine")[0];
  ncxId = spineEl?.getAttribute("toc") ?? null;
  let coverItemId: string | null = null;
  // EPUB3 properties="cover-image"；EPUB2 meta name="cover" content=id。
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes("cover-image")) coverItemId = item.id;
  }
  for (const el of Array.from(doc.getElementsByTagName("meta"))) {
    if (el.getAttribute("name") === "cover") coverItemId = el.getAttribute("content") ?? coverItemId;
  }
  return {
    opfPath,
    opfDir: parentDir(opfPath),
    title: firstTagText(doc, "dc:title") || fileTitle,
    author: firstTagText(doc, "dc:creator"),
    manifest,
    spine,
    ncxId,
    coverItemId,
  };
}

interface TocEntry {
  title: string;
  /** zip 内路径（去 fragment）。 */
  zipPath: string;
}

interface FlatTocNode {
  label: string;
  href: string;
  children: FlatTocNode[];
}

/** EPUB3 NAV 文档 → toc 树（a 的 href 为相对导航文件的路径）。 */
function parseNavDoc(xml: string): FlatTocNode[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const navs = Array.from(doc.getElementsByTagName("nav"));
  const tocNav =
    navs.find((n) => (n.getAttribute("epub:type") ?? n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "") === "toc") ??
    navs[0];
  if (!tocNav) return [];
  // 只找本 li 的直接子级标签（嵌套 ol 里的 a 归子节点所有）。
  const ownAnchorOf = (li: Element): Element | null =>
    Array.from(li.children).find((c) => ["a", "span"].includes(c.tagName.toLowerCase())) ?? null;
  const walk = (li: Element): FlatTocNode | null => {
    const a = ownAnchorOf(li);
    if (!a) return null;
    const childOl = Array.from(li.children).find((c) => c.tagName.toLowerCase() === "ol");
    const kids = childOl
      ? Array.from(childOl.children)
          .filter((c) => c.tagName.toLowerCase() === "li")
          .map(walk)
          .filter((n): n is FlatTocNode => n !== null)
      : [];
    return { label: (a.textContent ?? "").trim(), href: a.getAttribute("href") ?? "", children: kids };
  };
  const rootOl = tocNav.getElementsByTagName("ol")[0];
  if (!rootOl) return [];
  return Array.from(rootOl.children)
    .filter((c) => c.tagName.toLowerCase() === "li")
    .map(walk)
    .filter((n): n is FlatTocNode => n !== null);
}

/** EPUB2 NCX → toc 树。content/navLabel 只认本 navPoint 的直接子级。 */
function parseNcxDoc(xml: string): FlatTocNode[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const directChild = (navPoint: Element, tag: string): Element | null =>
    Array.from(navPoint.children).find((c) => c.tagName.toLowerCase() === tag) ?? null;
  const walk = (navPoint: Element): FlatTocNode | null => {
    const label = directChild(navPoint, "navlabel")?.textContent?.trim() ?? "";
    const content = directChild(navPoint, "content")?.getAttribute("src") ?? "";
    const kids = Array.from(navPoint.children)
      .filter((c) => c.tagName.toLowerCase() === "navpoint")
      .map(walk)
      .filter((n): n is FlatTocNode => n !== null);
    return { label, href: content, children: kids };
  };
  const navMap = doc.getElementsByTagName("navMap")[0];
  if (!navMap) return [];
  return Array.from(navMap.children)
    .filter((c) => c.tagName.toLowerCase() === "navpoint")
    .map(walk)
    .filter((n): n is FlatTocNode => n !== null);
}

/** toc 树 → 叶子条目（展平；卷名作章名前缀），并解析为 zip 路径。 */
function flattenToc(
  roots: FlatTocNode[],
  baseDir: string,
  pathToSpineIdx: Map<string, number>,
): TocEntry[] {
  const entries: TocEntry[] = [];
  const walk = (nodes: FlatTocNode[], prefix: string) => {
    for (const node of nodes) {
      const title = [prefix, node.label].filter(Boolean).join(" · ");
      const zipPath = node.href ? resolveZipPath(baseDir, node.href) : "";
      const hasSpineTarget = zipPath !== "" && pathToSpineIdx.has(zipPath);
      if (node.children.length === 0) {
        if (title && hasSpineTarget) entries.push({ title, zipPath });
      } else {
        // 有子节点且自身也指向内容 → 自身也算一章（卷首页常有正文）。
        if (hasSpineTarget && title) entries.push({ title, zipPath });
        walk(node.children, title);
      }
    }
  };
  walk(roots, "");
  // 同一 spine 文件被多个条目引用时保留首个（后续是重复目录）。
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.zipPath)) return false;
    seen.add(e.zipPath);
    return true;
  });
}

// ---------- 主入口 ----------

/**
 * 解析 .epub → 章节文本数组。任何失败抛 FileImportError（中文可读、给出退路），
 * 绝不产出空书。
 */
export async function parseEpub(file: File): Promise<EpubBook> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".epub")) {
    throw new FileImportError("仅支持 .epub 文件；.mobi / .azw3 暂不支持，可先用 Calibre 转成 .epub");
  }
  if (file.size > MAX_EPUB_BYTES) {
    throw new FileImportError("文件超过 64MB 上限，请确认是文字版 EPUB");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new FileImportError("EPUB 解析失败：文件已损坏或不是有效的 .epub。请重新获取文件，或改走「粘贴文本」导入。");
  }
  if (await looksDrmProtected(zip)) {
    throw new FileImportError(
      "该文件受 DRM（数字版权保护）加密，无法解析。请使用你已购买/无保护的正版文件，或改走「粘贴文本」导入。",
    );
  }
  const containerEntry = zipEntry(zip, "META-INF/container.xml");
  if (!containerEntry) {
    throw new FileImportError("不是有效的 EPUB（缺少 META-INF/container.xml）。请确认文件未损坏后重试。");
  }
  const containerXml = await containerEntry.async("string");
  const containerDoc = new DOMParser().parseFromString(containerXml, "text/xml");
  const rootfile =
    Array.from(containerDoc.getElementsByTagName("rootfile"))
      .map((el) => el.getAttribute("full-path"))
      .find((p): p is string => !!p) ?? "";
  const opfEntry = rootfile ? zipEntry(zip, rootfile) : null;
  if (!opfEntry) {
    throw new FileImportError("不是有效的 EPUB（找不到 OPF 元数据）。请确认文件未损坏后重试。");
  }
  const fileTitle = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
  const opf = parseOpf(rootfile, await opfEntry.async("string"), fileTitle);
  if (!opf || opf.spine.length === 0) {
    throw new FileImportError("EPUB 缺少阅读顺序（spine）信息，无法分章。请确认是完整的电子书文件。");
  }

  // manifest idref → zip 路径；spine 顺序即阅读顺序。
  const spinePaths: string[] = [];
  for (const idref of opf.spine) {
    const item = opf.manifest.get(idref);
    if (!item) continue;
    if (item.mediaType && !/xhtml|html|xml/i.test(item.mediaType)) continue;
    spinePaths.push(resolveZipPath(opf.opfDir, item.href));
  }
  if (spinePaths.length === 0) {
    throw new FileImportError("EPUB 里没有可抽取正文的 XHTML 内容。");
  }
  const pathToSpineIdx = new Map<string, number>();
  spinePaths.forEach((p, i) => {
    if (!pathToSpineIdx.has(p)) pathToSpineIdx.set(p, i);
  });

  // 逐文件抽正文（一次抽取，分章与词数共用）。
  const texts: string[] = [];
  let totalChars = 0;
  for (const path of spinePaths) {
    const entry = zipEntry(zip, path);
    if (!entry) {
      texts.push("");
      continue;
    }
    const text = extractXhtmlText(await entry.async("string"));
    totalChars += text.length;
    texts.push(text);
    if (totalChars > MAX_TOTAL_TEXT_CHARS) {
      throw new FileImportError("这本书太大了（正文超过上限），请拆分后分卷导入。");
    }
  }
  const hasText = texts.some((t) => t.trim().length > 0);
  if (!hasText) {
    throw new FileImportError(
      "这个 EPUB 里抽不到正文文字（可能整本都是图片扫描页）。\n请改用「粘贴文本」导入，或换文字版文件。",
    );
  }

  // ---- 目录（toc）解析与分章 ----
  let tocRoots: FlatTocNode[] = [];
  // toc 条目的 href 相对「toc 文档所在目录」（可能与 OPF 不同级）。
  let tocBaseDir = opf.opfDir;
  const navItem = [...opf.manifest.values()].find((item) =>
    item.properties.split(/\s+/).includes("nav"),
  );
  if (navItem) {
    const navPath = resolveZipPath(opf.opfDir, navItem.href);
    const navEntry = zipEntry(zip, navPath);
    if (navEntry) {
      tocRoots = parseNavDoc(await navEntry.async("string"));
      tocBaseDir = parentDir(navPath);
    }
  }
  if (tocRoots.length === 0) {
    const ncxId = opf.ncxId ?? [...opf.manifest.entries()].find(([, i]) => i.mediaType === "application/x-dtbncx+xml")?.[0];
    const ncxItem = ncxId ? opf.manifest.get(ncxId) : undefined;
    if (ncxItem) {
      const ncxPath = resolveZipPath(opf.opfDir, ncxItem.href);
      const ncxEntry = zipEntry(zip, ncxPath);
      if (ncxEntry) {
        tocRoots = parseNcxDoc(await ncxEntry.async("string"));
        tocBaseDir = parentDir(ncxPath);
      }
    }
  }

  let chapters: EpubChapter[];
  let tocUsed = true;
  let fallbackNotice: string | undefined;
  const tocEntries = flattenToc(tocRoots, tocBaseDir, pathToSpineIdx);

  const substantialIdx: number[] = [];
  spinePaths.forEach((_, i) => {
    if (texts[i].length >= SUBSTANTIAL_TEXT_CHARS) substantialIdx.push(i);
  });
  const referenced = new Set(tocEntries.map((e) => pathToSpineIdx.get(e.zipPath)).filter((x): x is number => x !== undefined));
  const unreferencedSubstantial = substantialIdx.filter((i) => !referenced.has(i)).length;
  const coverageSuspicious =
    substantialIdx.length > 0 &&
    unreferencedSubstantial / substantialIdx.length > MAX_UNREFERENCED_RATIO;

  if (tocEntries.length > 0 && !coverageSuspicious) {
    // 按 toc 条目切：条目 k 覆盖 [起始 spine, 下一条目起始) 的全部文件。
    const bounds = tocEntries
      .map((e) => ({ title: e.title, start: pathToSpineIdx.get(e.zipPath) ?? 0 }))
      .filter((b, i, arr) => i === 0 || b.start > arr[i - 1].start);
    chapters = [];
    for (let k = 0; k < bounds.length; k++) {
      const from = bounds[k].start;
      const to = k + 1 < bounds.length ? bounds[k + 1].start : spinePaths.length;
      const text = texts.slice(from, to).filter((t) => t.trim()).join("\n\n").trim();
      if (!text) continue;
      chapters.push({ title: bounds[k].title, text, wordCount: countWords(text) });
      if (chapters.length >= MAX_CHAPTERS) break;
    }
  } else {
    // 回退：按 spine 顺序每 ~3,000 词分节（跳过空文件/封面页）。
    tocUsed = false;
    fallbackNotice =
      tocEntries.length > 0
        ? "这本书的目录不完整，已按内容长度自动分节"
        : "未识别到目录，已按内容长度自动分节";
    chapters = [];
    let buf: string[] = [];
    let bufWords = 0;
    for (const text of texts) {
      const t = text.trim();
      if (!t) continue;
      buf.push(t);
      bufWords += countWords(t);
      if (bufWords >= FALLBACK_SECTION_WORDS) {
        const joined = buf.join("\n\n");
        chapters.push({ title: `第 ${chapters.length + 1} 节`, text: joined, wordCount: countWords(joined) });
        buf = [];
        bufWords = 0;
        if (chapters.length >= MAX_CHAPTERS) break;
      }
    }
    if (buf.length > 0 && chapters.length < MAX_CHAPTERS) {
      const joined = buf.join("\n\n");
      chapters.push({ title: `第 ${chapters.length + 1} 节`, text: joined, wordCount: countWords(joined) });
    }
  }

  chapters = chapters.filter((c) => c.wordCount > 0);
  if (chapters.length === 0) {
    throw new FileImportError("没有解析到有效的章节内容，已放弃导入（不会产出空书）。请换一个文件或改走「粘贴文本」。");
  }
  // 章名去重/兜底。
  const seenTitles = new Set<string>();
  chapters = chapters.map((c, i) => {
    let title = c.title.trim() || `第 ${i + 1} 章`;
    if (seenTitles.has(title)) title = `${title}（${i + 1}）`;
    seenTitles.add(title);
    return { ...c, title };
  });

  // ---- 封面（可失败，不影响文本） ----
  let coverDataUrl: string | undefined;
  if (opf.coverItemId) {
    try {
      const item = opf.manifest.get(opf.coverItemId);
      if (item) {
        const entry = zipEntry(zip, resolveZipPath(opf.opfDir, item.href));
        if (entry) {
          const mime = /png/i.test(item.mediaType) ? "image/png" : "image/jpeg";
          const b64 = await entry.async("base64");
          const dataUrl = `data:${mime};base64,${b64}`;
          if (dataUrl.length <= MAX_COVER_DATAURL_CHARS) coverDataUrl = dataUrl;
        }
      }
    } catch {
      coverDataUrl = undefined;
    }
  }

  const totalWords = chapters.reduce((n, c) => n + c.wordCount, 0);
  return {
    title: opf.title || fileTitle,
    author: opf.author,
    coverDataUrl,
    chapters,
    tocUsed,
    fallbackNotice,
    totalWords,
    minutes: Math.max(1, Math.round(totalWords / WPM)),
  };
}
