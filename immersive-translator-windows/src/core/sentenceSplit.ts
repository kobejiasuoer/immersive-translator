/**
 * 英文文章 → 段落 → 句对的切分。
 *
 * 阅读室的句对是朗读/高亮/遮罩的最小单元，切分错误会直接破坏对齐，
 * 所以规则保守：先按空行/换行切段，段内按「句子终结符 + 空白 + 大写/数字/引号」
 * 切句，保留称谓、姓名首字母和句中的缩写；缩写也可能位于句末，
 * 所以后续明显开启新句时仍允许切分。
 */

/** 后面通常还有姓名、地点、编号或例子的前缀；匹配时统一转小写。 */
const ABBREVIATION_PREFIXES = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "vs", "rev", "hon",
  "e.g", "i.e", "cf", "approx", "dept", "fig", "gen", "gov", "sen",
  "rep", "no", "nos", "vol", "capt", "lt", "col", "sgt",
]);

/** 句子终结符后必须跟的"新句开头"。 */
const NEXT_SENTENCE_LOOKAHEAD = /[A-Z0-9"'“‘(\[]/;

/** 与 Department / Secretary 等缩写后续名称区分的明确新句起始词。 */
const SENTENCE_STARTERS = /^(?:I|You|He|She|It|We|They|My|Your|His|Her|Its|Our|Their|This|That|These|Those|The|A|An|There|Here|Then|Next|However|Meanwhile|Afterward|Afterwards|Instead|Finally|Moreover|Nevertheless|Therefore|Thus|But|And|Yet|So|When|Where|Why|How|What|Who|Which|If|Although|Because|Before|After|During|Since|While|Despite|In|On|At|By|From|With|Without|For|As|Today|Yesterday|Tomorrow|Now|Later|Another)\b/;

/** 判断此处是否为句中缩写，而不把所有缩写的最后一点永久屏蔽。 */
function endsWithAbbreviation(text: string, dotIndex: number, nextIndex: number): boolean {
  let start = dotIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) {
    start--;
  }
  const token = text.slice(start, dotIndex);
  if (!token) return false;
  if (ABBREVIATION_PREFIXES.has(token.toLowerCase())) return true;

  // U.S. / U.K. / J.R.R. 与 J. R. R. 的中间首字母不能拆开。
  if (/^(?:[A-Z]\.)*[A-Z]$/.test(token)) {
    const following = text.slice(nextIndex);
    if (/^[A-Z]\.(?:\s|$)/.test(following)) return true;
    // "in the U.S. It..." 的句点同时结束缩写与句子。引号、数字
    // 及明确新句起始词保留正常句界；其余专名采用保守的不拆分规则。
    return !/^[0-9"'“‘(\[]/.test(following) && !SENTENCE_STARTERS.test(following);
  }
  // etc. / Inc. / Jr. / p.m. 等可以自然出现在句末：后接大写时
  // 允许正常切句，后接小写时由调用方的句首检测继续保留在原句中。
  return false;
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
    const punctuationEnd = end;
    // 结束引号/括号跟随它们包住的句子，不能留作下一句的开头。
    while (end + 1 < text.length && /["'”’)\]}]/.test(text[end + 1])) end++;
    // 末尾终结符必然收句；否则看后随字符
    if (end + 1 < text.length) {
      // 后面必须跟空白 + 新句开头才算句界（小数点 3.14、网址不切）
      if (!/\s/.test(text[end + 1])) continue;
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (next >= text.length || !NEXT_SENTENCE_LOOKAHEAD.test(text[next])) continue;
      // 仅孤立句点适用缩写保护；省略号、问号以及已闭合的引文仍收句。
      if (ch === "." && punctuationEnd === i && end === i && endsWithAbbreviation(text, i, next)) continue;
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
