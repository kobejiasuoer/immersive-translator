/**
 * 「加入生词本」的词条决策（纯函数）：词典查询成功用词条；失败时的兜底译文
 * 只在「短释义形状」时可用——历史译文/浮窗译文可能是整句翻译，
 * 不能无条件当作词典释义（否则复习卡会把整句话当释义展示）。
 */

import type { ReaderDictEntry, ReaderDictResult } from "./readerDict";

/**
 * 兜底译文可用性：非空、≤40 字、不含句末终结符。
 * 例：「有弹性的；恢复快的」可用；「这种材料非常有韧性。」不可用。
 */
export function looksLikeShortDefinition(cn: string): boolean {
  const trimmed = cn.trim();
  if (!trimmed || trimmed.length > 40) return false;
  return !/[。．！？!?…]/.test(trimmed);
}

/**
 * 从词典查询结果与兜底译文里定出词条。
 * dictResult 为 null（请求失败）或非 entry（not_a_word / 解析失败）时走兜底；
 * 兜底译文不是「短释义形状」则抛错，要求重试而不是收一条整句释义。
 */
export function resolveVocabEntry(
  queryText: string,
  dictResult: ReaderDictResult | null,
  fallbackCn: string,
): ReaderDictEntry {
  if (dictResult?.kind === "entry") return dictResult.entry;
  const cn = fallbackCn.trim();
  if (!looksLikeShortDefinition(cn)) {
    throw new Error("词典查询失败，请稍后重试");
  }
  return { word: queryText, senses: [{ pos: "", cn }] };
}
