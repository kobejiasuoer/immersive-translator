/**
 * 发现书库（升级计划 B2 §3/§6）：目录信封解析 + 下载字节还原/校验 + 错误文案。
 *
 * - parseBooksPage：GET /v1/books 应答 body → DiscoverPage；行缺 id/title 只丢该行
 *   （不整页失败），信封形状不对返回 null（调用方给「书库数据异常」文案）。
 * - bytesFromBase64 / verifyEpubSha256 / epubFileOf：下载的 EPUB 字节从 base64
 *   还原（pronunciation.ts 同款 atob 逐字节法）、SubtleCrypto SHA-256 校验、
 *   构造 `<bookId>.epub` 的 File 喂给 parseEpub 既有管线。
 * - 三个文案函数：失败路径中文口径的唯一出口（列表级 / 下载级 / invoke reject 级），
 *   与 authErrorText.ts 的「只按 code/状态分支、绝不匹配服务端 message」同约束。
 */

import { authErrorText } from "./authErrorText";
import type { BooksDownloadResult, SyncHttpText } from "./tauriBridge";

/** 目录行（服务端 BookView 的 15 键形状；description/wordCount 空时整体省键）。 */
export interface DiscoverBook {
  id: string;
  title: string;
  author: string;
  description?: string;
  wordCount?: number;
  grade: string;
  category: string;
  language: string;
  coverEmoji: string;
  source: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  fileSizeBytes: number;
  sha256: string;
}

/** 一页目录的解析结果（books 为累计前的当页行）。 */
export interface DiscoverPage {
  books: DiscoverBook[];
  total: number;
  page: number;
  perPage: number;
}

/** 难度 → 中文标签（服务端 grade 取值 easy/medium/hard）。 */
export const GRADE_LABELS: Record<string, string> = {
  easy: "入门",
  medium: "进阶",
  hard: "挑战",
};

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asBook(row: unknown): DiscoverBook | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  // id/title 是管线的硬依赖（文件名 / 埋点 bookId），缺任一只丢该行不整页失败。
  const id = asStr(r.id);
  const title = asStr(r.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    author: asStr(r.author),
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    ...(typeof r.wordCount === "number" && Number.isFinite(r.wordCount) ? { wordCount: r.wordCount } : {}),
    grade: asStr(r.grade),
    category: asStr(r.category),
    language: asStr(r.language),
    coverEmoji: asStr(r.coverEmoji),
    source: asStr(r.source),
    sourceUrl: asStr(r.sourceUrl),
    licenseName: asStr(r.licenseName),
    licenseUrl: asStr(r.licenseUrl),
    fileSizeBytes: asNum(r.fileSizeBytes),
    sha256: asStr(r.sha256),
  };
}

/**
 * 解析目录应答 body：信封 { data: BookView[], total, page, perPage }。
 * body 非 JSON、data 非数组 → null（信封坏，调用方走「书库数据异常」文案）。
 */
export function parseBooksPage(body: string): DiscoverPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const env = parsed as { data?: unknown; total?: unknown; page?: unknown; perPage?: unknown };
  if (!Array.isArray(env.data)) return null;
  const books = env.data.map(asBook).filter((b): b is DiscoverBook => b !== null);
  return {
    books,
    total: asNum(env.total),
    page: asNum(env.page),
    perPage: asNum(env.perPage),
  };
}

/** base64 → 字节（atob 产出 latin1 字符串，按 charCodeAt 逐字节还原，
 *  pronunciation.ts 讯飞评测同款）。atob 对非法输入抛错，由调用方 catch 给文案。 */
export function bytesFromBase64(b64: string): Uint8Array {
  const latin = atob(b64);
  const bytes = new Uint8Array(latin.length);
  for (let i = 0; i < latin.length; i += 1) bytes[i] = latin.charCodeAt(i);
  return bytes;
}

/** SubtleCrypto SHA-256（hex 小写）与目录 sha256 比对。expected 非法（缺省/非
 *  64 位 hex）或摘要能力不可用时返回 true 放行——校验是传输损坏的旁路防线，
 *  不构成硬门槛；不匹配返回 false（下载损坏，要求重下）。 */
export async function verifyEpubSha256(bytes: Uint8Array, expected: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(expected)) return true;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    let hex = "";
    for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
    return hex === expected.toLowerCase();
  } catch {
    return true;
  }
}

/** 构造交给 parseEpub 的 File：bookId 满足 ^[a-z0-9]+(-[a-z0-9]+)*$（BOOK_ID_PATTERN），
 *  天然带 .epub 后缀过扩展名校验且零 Windows 非法字符，无需按书名清洗。 */
export function epubFileOf(book: DiscoverBook, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], `${book.id}.epub`, { type: "application/epub+zip" });
}

/** 字节数 → 展示大小（≥0.5MB 走 MB 一位小数，否则 KB 取整）。 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 524288) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 429 插值口径（与 authErrorText.rate_limited 一致：秒数缺失/非正 → 通用文案）。 */
function rateLimitedText(retryAfterSeconds: number | null): string {
  return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
    ? `操作过于频繁，请 ${retryAfterSeconds} 秒后再试`
    : "操作过于频繁，请稍后再试";
}

/** 列表/加载更多失败文案（errorDesign 3/4/5/6）：400 参数异常、404 书库不可访问、
 *  429 限流插值、其余（5xx/未知）服务暂不可用。信封坏文案见 DISCOVER_BODY_ERROR_TEXT。 */
export function discoverListErrorText(http: SyncHttpText): string {
  if (http.status === 400) return "请求参数异常，请更新应用后重试；若持续出现请反馈";
  if (http.status === 404) return "书库暂时无法访问（404），请稍后再试";
  if (http.status === 429) return rateLimitedText(http.retryAfterSeconds);
  return "服务暂时不可用，请稍后再试";
}

/** 200 但信封解析失败的专属文案（errorDesign 7，DiscoverTab 直接引用）。 */
export const DISCOVER_BODY_ERROR_TEXT = "书库数据异常，请稍后重试；若持续出现请更新应用";

/** 下载失败文案（errorDesign 9/10/11/12/15）：404 行不存在/文件缺失统一为
 *  「当前不可下载」，401 理论不可达（匿名可用）仍给归一化口径。 */
export function discoverDownloadErrorText(http: BooksDownloadResult): string {
  if (http.status === 404) return "这本书当前不可下载，请稍后再试或换一本";
  if (http.status === 400) return "请求参数异常，请更新应用后重试；若持续出现请反馈";
  if (http.status === 401) return "登录已失效，请重新登录";
  if (http.status === 429) return rateLimitedText(http.retryAfterSeconds);
  return "服务暂时不可用，请稍后再试";
}

/** invoke reject（AuthError）文案（errorDesign 1/2/8）：platform_unavailable 专属
 *  文案不进 authErrorText 全局表；其余（network_error/unknown 等）由 authErrorText 兜底。 */
export function discoverInvokeErrorText(err: unknown): string {
  if (err !== null && typeof err === "object" && (err as { code?: unknown }).code === "platform_unavailable") {
    return "书库服务暂未开放，请稍后再试";
  }
  return authErrorText(err).text;
}
