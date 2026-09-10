/**
 * 判断选中文本是否"像一个待查的单词/短语"，用于决定浮窗是否切换为词典卡片。
 *
 * 纯启发式，误判由两层兜底：模型可返回 {"error":"not_a_word"}（面板自动降级为
 * 整句翻译），用户也可在卡片/译文之间一键手动切换。
 */

/** 无空格书写系统：CJK 统一表意文字（含扩展/兼容）、假名、谚文。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 空格书写系统的单个 token：字母/数字/撇号/连字符。
 * 句读标点（. ? ! ; : ，。）与代码痕迹（_ / \ @ #）都不在其中，天然排除
 * 句子、URL、路径、邮箱、标识符。
 */
const TOKEN = /^[\p{L}\p{N}'’\-]+$/u;

/** 无空格书写系统的词条长度上限（覆盖双字词、成语、短惯用语）。 */
const CJK_MAX_CHARS = 6;
/** 空格书写系统的词数上限（覆盖 "in the wake of" 级别短语）。 */
const MAX_TOKENS = 4;
/** 总字符数上限。 */
const MAX_CHARS = 40;

export function isLookupText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // 多行内容一定不是词条
  if (/[\r\n]/.test(trimmed)) return false;
  if (trimmed.length > MAX_CHARS) return false;

  if (CJK_CHAR.test(trimmed)) {
    // 含 CJK 字符：要求全部字符都是 CJK（排除中英混排），且长度在上限内
    for (const ch of trimmed) {
      if (!CJK_CHAR.test(ch)) return false;
    }
    return [...trimmed].length <= CJK_MAX_CHARS;
  }

  // 空格书写系统：1~4 个 token，每个都是纯词形，且至少含一个字母（排除纯数字）
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 1 || tokens.length > MAX_TOKENS) return false;
  let hasLetter = false;
  for (const token of tokens) {
    if (!TOKEN.test(token)) return false;
    if (/\p{L}/u.test(token)) hasLetter = true;
  }
  return hasLetter;
}
