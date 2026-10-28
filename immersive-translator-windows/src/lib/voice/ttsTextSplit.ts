/**
 * TTS 超长文本按句拆分(协议:单次合成文本 UTF-8 字节数须 < 8000)。
 *
 * 服务端红线是「字节」而非字符——中文 3 字节、emoji 4 字节,按字符数切会超限,
 * 按字节切又可能腰斩代理对。规则:
 * 1. 先按句终结符(中英文句号/问叹号/省略号/换行)切成带标点的句子;
 * 2. 贪心打包,每片 ≤ 上限;句子自带标点与原空白,join 后可还原原文;
 * 3. 单句超限(无标点长文本)在码点边界硬切,绝不产生孤立代理对。
 */

/** 服务端 VOICE_TTS_MAX_TEXT_BYTES(env 默认 8000,`>= 8000` 拒绝)。 */
export const TTS_MAX_TEXT_BYTES = 8000;
/** 客户端拆分上限:留 100 字节余量,吸收服务端后续收紧与服务端侧再 trim 的偏差。 */
export const TTS_SPLIT_MAX_BYTES = TTS_MAX_TEXT_BYTES - 100;

const encoder = new TextEncoder();

/** UTF-8 字节数(TextEncoder 与服务端 Buffer.byteLength 同口径)。 */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 句终结符(含收尾连续标点)。 */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "…", ".", "\n"]);

/** 按句切(标点附着在前句尾部;换行自成一句界;不改动任何字符)。 */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    if (TERMINATORS.has(ch)) {
      // 吞掉连续终结符(「?!」「...」归前一句)
      sentences.push(current);
      current = "";
    }
  }
  if (current !== "") sentences.push(current);
  return sentences;
}

/** 单个码点的 UTF-8 字节数。 */
function codePointBytes(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** 单句超限时按码点边界硬切成 ≤maxBytes 的片(多字节字符/代理对不截断)。 */
function hardSplit(sentence: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let pieceBytes = 0;
  for (const ch of sentence) {
    const chBytes = codePointBytes(ch.codePointAt(0)!);
    if (pieceBytes + chBytes > maxBytes && piece !== "") {
      pieces.push(piece);
      piece = "";
      pieceBytes = 0;
    }
    piece += ch;
    pieceBytes += chBytes;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/**
 * 拆成每片 UTF-8 字节数 ≤ maxBytes(默认 TTS_SPLIT_MAX_BYTES)的有序片段;
 * 短文本原样单片段返回;纯空白返回 []。join("") 恒等于 trim 后的输入。
 */
export function splitTtsText(text: string, maxBytes: number = TTS_SPLIT_MAX_BYTES): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (utf8ByteLength(trimmed) <= maxBytes) return [trimmed];

  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const sentence of splitIntoSentences(trimmed)) {
    let sentenceBytes = utf8ByteLength(sentence);
    if (sentenceBytes > maxBytes) {
      // 前面积攒的先落袋,再硬切超长句(句子间无空白丢失,直接推入)
      if (current !== "") {
        pieces.push(current);
        current = "";
        currentBytes = 0;
      }
      for (const piece of hardSplit(sentence, maxBytes)) pieces.push(piece);
      continue;
    }
    if (currentBytes + sentenceBytes > maxBytes) {
      if (current !== "") pieces.push(current);
      current = sentence;
      currentBytes = sentenceBytes;
    } else {
      current += sentence;
      currentBytes += sentenceBytes;
    }
  }
  if (current !== "") pieces.push(current);
  // 防御:任何一片超限(理论上不会)再硬切一遍,保证协议红线。
  const safe: string[] = [];
  for (const piece of pieces) {
    if (utf8ByteLength(piece) > maxBytes) safe.push(...hardSplit(piece, maxBytes));
    else safe.push(piece);
  }
  // 全空白片段丢弃(trim 过的输入不会出现,防御硬切边界产生空白片)。
  return safe.filter((p) => p.trim() !== "");
}
