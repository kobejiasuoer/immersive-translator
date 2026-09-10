/**
 * 英文文章 → 段落 → 句对的切分。
 *
 * 阅读室的句对是朗读/高亮/遮罩的最小单元，切分错误会直接破坏对齐，
 * 所以规则保守：先按空行/换行切段，段内按「句子终结符 + 空白 + 大写/数字/引号」
 * 切句，常见缩写（Mr. / e.g. / U.S. 等）不作为切分点。
 */

/** 常见不可切分的缩写结尾（大小写敏感匹配）。 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
  "e.g", "i.e", "cf", "al", "inc", "ltd", "co", "corp", "approx",
  "dept", "est", "fig", "gen", "gov", "sen", "rep", "no", "nos", "vol",
]);

/** 句子终结符后必须跟的"新句开头"。 */
const NEXT_SENTENCE_LOOKAHEAD = /[A-Z0-9"'“‘(\[]/;

/** 判断 "word." 形式的句点是否属于缩写。 */
function endsWithAbbreviation(text: string, dotIndex: number): boolean {
  let start = dotIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) {
    start--;
  }
  const token = text.slice(start, dotIndex).toLowerCase();
  if (!token) return false;
  // U.S.A. / e.g. 这类多段缩写：末段在缩写表即认为整体是缩写
  return ABBREVIATIONS.has(token);
}

/**
 * 段内切句。返回的句子保留原文标点，不做 trim 后再拼接的改写。
 * 空白一律折叠为单个空格；中英之间不加空格（§4 硬规则由渲染侧保证，
 * 这里只保证不引入多余空白）。
 */
export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    // 吞掉连续终结符（?!、...、!?。）
    let end = i;
    while (end + 1 < text.length && ".!?…".includes(text[end + 1])) {
      end++;
    }
    // 末尾终结符必然收句；否则看后随字符
    if (end + 1 < text.length) {
      // 句点且是缩写（如 "Mr."）→ 不切
      if (ch === "." && endsWithAbbreviation(text, i)) continue;
      // 后面必须跟空白 + 新句开头才算句界（小数点 3.14、网址不切）
      if (!/\s/.test(text[end + 1])) continue;
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (next >= text.length || !NEXT_SENTENCE_LOOKAHEAD.test(text[next])) continue;
    }
    const sentence = text.slice(start, end + 1).trim();
    if (sentence) sentences.push(sentence);
    start = end + 1;
    i = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

export interface SplitParagraph {
  paragraphIdx: number;
  en: string;
  sentences: string[];
}

/**
 * 全文切段：空行（或单换行）分隔段落。
 * 返回非空段落，paragraphIdx 连续。
 */
export function splitParagraphs(text: string): SplitParagraph[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const rawParagraphs = normalized.split(/\n{2,}|\n/);
  const result: SplitParagraph[] = [];
  for (const raw of rawParagraphs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const sentences = splitSentences(trimmed);
    if (sentences.length === 0) continue;
    result.push({ paragraphIdx: result.length, en: sentences.join(" "), sentences });
  }
  return result;
}
