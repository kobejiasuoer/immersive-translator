/**
 * 术语表（glossary）—— 用户自定义「原文 → 固定译法」对照，注入 LLM system prompt
 * （Rust LlmCfg.glossary → 「术语对照（优先采用）：a→b；…」，契约 A1）。
 * 存储：localStorage ita.v3.glossary，[{a,b}]；B6 只做编辑 UI，本模块为唯一读写口径。
 */

export interface GlossaryPair {
  /** 原文术语（源语言写法）。 */
  a: string;
  /** 固定译法（优先采用）。 */
  b: string;
}

import { actions, getState } from "../store";
export function readGlossary(): GlossaryPair[] { return getState().glossary; }
export function saveGlossary(list: GlossaryPair[]): void { actions.setGlossary(list.filter(p => p.a.trim() && p.b.trim())); }

/**
 * 解析多行文本为术语表：每行一条，支持
 * 「中文 → English」（→ / -> / => / 全角冒号 / 冒号 / 制表符分隔）或「中文,english」（半角逗号）。
 * 空行与解析不出两条的行跳过；顺序保留（system prompt 按序拼接）。
 */
export function parseGlossaryText(text: string): GlossaryPair[] {
  const out: GlossaryPair[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.match(/^(.+?)\s*(?:→|->|=>|：|:|\t)\s*(.+)$/);
    if (sep && sep[1].trim() && sep[2].trim()) {
      out.push({ a: sep[1].trim(), b: sep[2].trim() });
      continue;
    }
    const comma = t.split(",");
    if (comma.length === 2 && comma[0].trim() && comma[1].trim()) {
      out.push({ a: comma[0].trim(), b: comma[1].trim() });
    }
  }
  return out;
}
