/**
 * 复习笔记解析：md 文件（JSON frontmatter + 固定标记正文）→ 结构化文档。
 *
 * 正文格式由 noteBuilder 的 prompt 严格约束（【记不住】/【记住了】/【记法】/
 * 【测】/ `> 例句` / `- 标签｜英文｜中文`），解析宁漏勿错：标记不认识的行
 * 按宽松规则兜底，绝不抛错——笔记是生成物，解析失败也要尽量渲染。
 */

import type { NoteMeta } from "./readerTypes";

/** 一张词条卡（md 解析结果；音标/词性/错题记号由调用方用生词数据补齐）。 */
export interface ParsedCard {
  word: string;
  /** 【记不住】/【记住了】二选一；缺省 = 没写（渲染时用数据兜底）。 */
  diagnose?: { ok: boolean; text: string };
  /** 【记法】锚点。 */
  anchor?: string;
  /** 释义行：pos 为空表示词块释义或未标注词性。 */
  senses: { pos: string | null; text: string }[];
  /** `> ` 引用的例句（原样）。 */
  example?: string;
  /** `- 标签｜英文｜中文` 行。 */
  collos: { k: string; en: string; zh: string }[];
  /** 【测】模式｜一句怎么测。 */
  nextTest?: { mode: string; tip: string };
}

export interface ParsedNote {
  glance: string[];
  sections: { title: string; cards: ParsedCard[] }[];
}

/** 拆 JSON frontmatter：`---\n{...}\n---\n正文`（兼容 \r\n）。 */
export function splitNoteFrontmatter(raw: string): { meta: NoteMeta | null; body: string } {
  const rest = raw.startsWith("---\n") ? raw.slice(4) : raw.startsWith("---\r\n") ? raw.slice(5) : null;
  if (rest === null) return { meta: null, body: raw };
  const end = rest.search(/\r?\n---\r?\n/);
  if (end < 0) return { meta: null, body: raw };
  let meta: NoteMeta | null = null;
  try {
    const parsed = JSON.parse(rest.slice(0, end)) as NoteMeta;
    if (parsed && typeof parsed === "object" && typeof parsed.file === "string") meta = parsed;
  } catch {
    meta = null;
  }
  const body = rest.slice(end).replace(/^\r?\n---\r?\n/, "");
  return { meta, body };
}

/** 全角/半角竖线切分（LLM 两种都可能输出）。 */
function splitBar(line: string): string[] {
  return line.split(/\s*[｜|]\s*/).map((s) => s.trim());
}

function parseCardLine(card: ParsedCard, line: string): void {
  const t = line.trim();
  if (!t) return;

  const diagnose = t.match(/^【(记不住|记住了)】\s*([\s\S]+)$/);
  if (diagnose) {
    card.diagnose = { ok: diagnose[1] === "记住了", text: diagnose[2].trim() };
    return;
  }
  const anchor = t.match(/^【记法】\s*([\s\S]+)$/);
  if (anchor) {
    card.anchor = anchor[1].trim();
    return;
  }
  const test = t.match(/^【测】\s*([\s\S]+)$/);
  if (test) {
    const [mode = "", tip = ""] = splitBar(test[1]);
    card.nextTest = { mode, tip };
    return;
  }
  if (t.startsWith(">")) {
    const quote = t.replace(/^>\s?/, "").trim();
    if (quote) card.example = card.example ? `${card.example} ${quote}` : quote;
    return;
  }
  if (t.startsWith("- ")) {
    const item = t.slice(2).trim();
    // 搭配行：- 标签｜英文｜中文
    const bars = splitBar(item);
    if (bars.length >= 3 && bars[0].length <= 6) {
      card.collos.push({ k: bars[0], en: bars[1], zh: bars.slice(2).join("：") });
      return;
    }
    // 释义行：- n. 中文（pos = 1~5 个字母 + .）
    const sense = item.match(/^([a-z]{1,5}\.)\s+(.+)$/);
    if (sense) {
      card.senses.push({ pos: sense[1], text: sense[2] });
    } else {
      card.senses.push({ pos: null, text: item });
    }
  }
}

/** 解析笔记正文；结构异常时尽量兜底，不抛错。 */
export function parseNoteMarkdown(body: string): ParsedNote {
  const note: ParsedNote = { glance: [], sections: [] };
  let inGlance = false;
  let section: ParsedNote["sections"][number] | null = null;
  let card: ParsedCard | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const h1 = line.match(/^#\s+(?!#)(.+)/);
    if (h1) continue; // 「# 复习笔记」标题行
    const h2 = line.match(/^##\s+(?!#)(.+)/);
    if (h2) {
      const title = h2[1].trim();
      card = null;
      if (/先看这里|速览/.test(title)) {
        inGlance = true;
        section = null;
        continue;
      }
      inGlance = false;
      section = { title, cards: [] };
      note.sections.push(section);
      continue;
    }
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      inGlance = false;
      if (!section) {
        section = { title: "词条", cards: [] };
        note.sections.push(section);
      }
      card = { word: h3[1].trim(), senses: [], collos: [] };
      section.cards.push(card);
      continue;
    }
    if (inGlance) {
      const t = line.trim();
      if (t.startsWith("- ") && t.slice(2).trim()) note.glance.push(t.slice(2).trim());
      continue;
    }
    if (card) parseCardLine(card, line);
  }
  return note;
}
