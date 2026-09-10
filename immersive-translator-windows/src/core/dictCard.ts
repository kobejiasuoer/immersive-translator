/**
 * 词典卡片的数据契约与宽容解析。
 *
 * 模型被要求只回一个 JSON 对象（见 buildDictionaryPrompt），但任意 OpenAI 兼容
 * 端点的模型未必听话：可能包 markdown 代码块、带前言后语、留尾逗号。这里的
 * 解析按"先剥壳、再截取、再修复"逐级降级，全部失败才判 invalid。
 */

export interface DictPhonetic {
  /** 如 UK / US / 拼音 / 罗马字。 */
  label: string;
  /** 音标本身（不含斜杠）。 */
  value: string;
}

export interface DictExample {
  /** 原文例句。 */
  s: string;
  /** 例句译文。 */
  t: string;
}

export interface DictSense {
  /** 词性，如 n. / v. / adj.，可为空。 */
  pos: string;
  /** 目标语言释义。 */
  gloss: string;
  examples: DictExample[];
}

export interface DictCardData {
  word: string;
  phonetics: DictPhonetic[];
  /** 一行核心释义（历史记录与列表展示用）。 */
  translation: string;
  senses: DictSense[];
  /** 词形变化说明，可为空。 */
  inflections: string;
  /** 词根/构词记忆提示，可为空。 */
  etymology: string;
}

export type DictParseResult =
  | { kind: "card"; card: DictCardData }
  | { kind: "notAWord" }
  | { kind: "invalid"; raw: string };

/** 与提示词约定的输出规模上限；解析时再截一次，防模型超发。 */
const MAX_SENSES = 4;
const MAX_EXAMPLES_PER_SENSE = 2;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 剥掉 ```json 围栏。 */
function stripCodeFence(raw: string): string {
  return raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** 取首个 { 到最后一个 } 之间的内容，丢弃前后杂质。 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    // 常见修复：尾逗号（}" 前、"]" 前的 ", "）
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

/** 规范化模型输出；query 用于 word 缺失时兜底。 */
function normalizeCard(obj: Record<string, unknown>, query: string): DictCardData | null {
  const phonetics = asArray(obj.phonetics)
    .map((p) => {
      const item = (p ?? {}) as Record<string, unknown>;
      return { label: asString(item.label), value: asString(item.value) };
    })
    .filter((p) => p.value !== "");

  const senses = asArray(obj.senses)
    .map((s) => {
      const item = (s ?? {}) as Record<string, unknown>;
      return {
        pos: asString(item.pos),
        gloss: asString(item.gloss),
        examples: asArray(item.examples)
          .map((e) => {
            const ex = (e ?? {}) as Record<string, unknown>;
            return { s: asString(ex.s), t: asString(ex.t) };
          })
          .filter((ex) => ex.s !== "")
          .slice(0, MAX_EXAMPLES_PER_SENSE),
      };
    })
    .filter((s) => s.gloss !== "" || s.examples.length > 0)
    .slice(0, MAX_SENSES);

  const translation = asString(obj.translation);
  if (translation === "" && senses.length === 0) {
    return null; // 没有任何可用内容
  }

  return {
    word: asString(obj.word) || query,
    phonetics,
    translation,
    senses,
    inflections: asString(obj.inflections),
    etymology: asString(obj.etymology),
  };
}

/** 解析模型对一次查词的完整响应。 */
export function parseDictResponse(raw: string, query: string): DictParseResult {
  const cleaned = stripCodeFence(raw.trim());
  const candidate = extractJsonObject(cleaned);
  if (candidate === null) {
    return { kind: "invalid", raw };
  }
  const parsed = tryParseJson(candidate);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", raw };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === "string" && /not[ _]?a[ _]?word/i.test(obj.error)) {
    return { kind: "notAWord" };
  }
  const card = normalizeCard(obj, query);
  if (card === null) {
    return { kind: "invalid", raw };
  }
  return { kind: "card", card };
}

/** 把卡片格式化为可复制/可入库的纯文本。 */
export function cardToText(card: DictCardData): string {
  const lines: string[] = [];
  const phonetics = card.phonetics.map((p) => `${p.label ? `${p.label} ` : ""}/${p.value}/`).join(" ");
  lines.push([card.word, phonetics].filter(Boolean).join(" "));
  if (card.translation) lines.push(card.translation);
  card.senses.forEach((sense) => {
    const pos = sense.pos ? `[${sense.pos}] ` : "";
    lines.push(`${pos}${sense.gloss}`.trim());
    sense.examples.forEach((ex) => {
      lines.push(`  - ${ex.s}${ex.t ? ` ${ex.t}` : ""}`);
    });
  });
  if (card.inflections) lines.push(`词形: ${card.inflections}`);
  if (card.etymology) lines.push(`记忆: ${card.etymology}`);
  return lines.join("\n");
}

/** 例句高亮切分结果：hit 段渲染为高亮。 */
export interface SplitPart {
  text: string;
  hit: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** CJK 等无空格脚本：无词边界概念，词条在句中前后必然紧邻其他字。 */
const CJK_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 把例句按查询词切分。对短语按"最长 token 优先"整体匹配；
 * 拉丁类脚本用字母/数字环视做词边界，CJK 脚本直接子串匹配。
 */
export function splitByWord(sentence: string, word: string): SplitPart[] {
  const w = word.trim();
  if (!w || !sentence) return [{ text: sentence, hit: false }];

  const tokens = [...new Set(w.split(/\s+/).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = tokens
    .map((t) => {
      const body = escapeRegExp(t);
      return CJK_TEXT.test(t) ? body : `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`;
    })
    .join("|");
  const regex = new RegExp(pattern, "gu");

  const parts: SplitPart[] = [];
  let cursor = 0;
  for (const match of sentence.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: sentence.slice(cursor, index), hit: false });
    parts.push({ text: match[0], hit: true });
    cursor = index + match[0].length;
  }
  if (cursor < sentence.length) parts.push({ text: sentence.slice(cursor), hit: false });
  return parts;
}
