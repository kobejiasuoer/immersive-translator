/**
 * 段级翻译协议：一段（若干句）一次请求，编号行保序换回。
 *
 * 选段而不是逐句请求，是为了流式渲染有段级颗粒度（「翻译中 N/M 段」），
 * 同时请求数可控；选编号行而不是让模型自由分段，是为了句对对齐不漂移。
 */

import type { PromptInput } from "./promptBuilder";

/** 段内编号行的输入格式：`[1] Sentence one.` */
export function buildParagraphRequestInput(sentences: string[]): string {
  return sentences.map((s, i) => `[${i + 1}] ${s}`).join("\n");
}

const NUMBERED_LINE = /^\s*[\[(【]?\s*(\d{1,3})\s*[\])】]?\s*[.、:：]?\s*(.+)$/u;

/**
 * 解析编号行响应。返回按输入序号对齐的译文数组；行数与序号
 * 无法和输入一一对应时返回 null（上层把该段标为 failed，可重试）。
 */
export function parseParagraphResponse(raw: string, expectedCount: number): string[] | null {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const byIndex = new Map<number, string>();
  let numbered = 0;
  for (const line of lines) {
    // 跳过 markdown 围栏与常见前言后语
    if (/^```/.test(line)) continue;
    const m = NUMBERED_LINE.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    const text = m[2].trim();
    if (!text || idx < 1 || idx > expectedCount) continue;
    if (!byIndex.has(idx)) {
      byIndex.set(idx, text);
      numbered++;
    }
  }

  if (numbered !== expectedCount) {
    // 降级：完全没有编号时，按「非空行数 == 句数」对齐（模型偶尔丢前缀）
    if (numbered === 0 && lines.length === expectedCount) {
      return lines.map((l) => l.replace(/^```+|```+$/g, "").trim());
    }
    return null;
  }
  const out: string[] = [];
  for (let i = 1; i <= expectedCount; i++) out.push(byIndex.get(i) as string);
  return out;
}

/** 中文句子之间不加空格（§4 硬规则）。 */
export function joinChineseLines(lines: string[]): string {
  return lines.map((l) => l.trim()).filter(Boolean).join("");
}

/** 段落翻译的系统提示词：保序、编号、只输出译文行。 */
export function buildParagraphTranslateSystemPrompt(input: PromptInput): string {
  const target = input.targetLanguage || "中文";
  return [
    `你是专业的英译${target}译者。输入是若干行带 [N] 编号的英文句子（属于同一段落）。`,
    `要求：`,
    `1. 逐行翻译成自然的${target}，保持编号前缀，输出恰好与输入相同数量的行；`,
    `2. 输出格式严格为 \`[N] 译文\`，每行一句，不要合并、不要拆分、不要加任何解释或前后缀；`,
    `3. 保留专有名词与数字的准确性；不要输出 Markdown 代码块围栏。`,
    input.customStyle ? `风格要求：${input.customStyle}` : "",
    input.glossaryText ? `术语表（优先遵守）：\n${input.glossaryText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 标题（单行）翻译的系统提示词。 */
export function buildTitleTranslateSystemPrompt(target: string): string {
  return [
    `你是专业的英译${target}译者。把输入的文章标题翻译成简洁自然的${target}。`,
    `只输出译文本身，不要解释、不要引号、不要保留原文。`,
  ].join("\n");
}
