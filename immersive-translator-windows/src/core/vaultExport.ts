/**
 * 「Markdown 笔记导出」的纯函数生成器（v0.8 Phase 4）。
 *
 * 把三路真实数据汇成一篇可直接粘进 Notion / Obsidian 的学习笔记：
 * 一、核心词块（词/音标/释义/三阶徽标/原句/pattern/trap，数据 = 生词本）；
 * 二、口语表达升级 Before → After（数据 = 口语会话里带 coachDiff 的 user 轮）；
 * 三、发音重点复盘（数据 = user 轮发音评测里的低分词 + 舌位建议）。
 *
 * 红线：所有内容来自入参（真实存储），本模块不包含任何示例句；
 * 某一段没有数据时整段省略，不产出空标题。
 */

import { findChunkRange } from "./chunkAnnotate";
import { masteryStage } from "./readerSrs";
import { worstPhoneOf, phoneTip } from "./shadowDiagnose";
import type { VocabWord } from "./readerTypes";
import type { SpeakSession, SpeakTurn } from "./speakLogic";

export interface VaultExportInput {
  /** 要导出的生词（调用方按归档过滤后的子集）。 */
  words: VocabWord[];
  /** 原句取回（与复习卡同一通道；缺失时回退词条自带例句）。 */
  sourceSentence: (articleId: string, sentenceIdx: number) => { en: string; zh: string | null } | null;
  /** 口语会话列表（speak_list_sessions 的真实返回）。 */
  speakSessions: SpeakSession[];
  /** 本地日期键（YYYY-MM-DD）。 */
  dateKey: string;
}

const STAGE_BADGE: Record<string, string> = {
  s1: "🌱 刚收集",
  s2: "👀 眼熟能认",
  s3: "✨ 已变成口语表达",
};

/** 发音复盘的低分线：与正文着色 mapWordsToText 的 bad 档（<3 分）一致。 */
const PRON_BAD_BELOW = 3;

/** user 轮里 coachDiff 的「地道改写」全文：keep + ins 片段按序拼回。 */
function betterTextOf(turn: SpeakTurn): string {
  return (turn.coachDiff?.segs ?? [])
    .filter((s) => s.t !== "del")
    .map((s) => s.v)
    .join(" ");
}

/** user 轮里 coachDiff 新加的词块（ins 片段）——「值得记下来的新说法」。 */
function insertedTextOf(turn: SpeakTurn): string {
  return (turn.coachDiff?.segs ?? [])
    .filter((s) => s.t === "ins")
    .map((s) => s.v)
    .join(" ");
}

/** 原句里把目标词标斜体（定位不到就原样返回，不伪造强调）。 */
function emphasize(sentence: string, target: string): string {
  const range = findChunkRange(sentence, target);
  if (!range) return sentence;
  return `${sentence.slice(0, range.start)}*${sentence.slice(range.start, range.end)}*${sentence.slice(range.end)}`;
}

/** 发音低分词（去重保留最低分；漏读/被丢弃的词没有分数意义，不计）。 */
function lowPronWords(sessions: SpeakSession[]): { word: string; score: number; tip: string }[] {
  const worst = new Map<string, { word: string; score: number }>();
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.role !== "user" || !turn.pron) continue;
      for (const w of turn.pron.words) {
        if (w.dpMessage === 16 || w.dpMessage === 32) continue;
        if (w.totalScore >= PRON_BAD_BELOW) continue;
        const key = w.content.toLowerCase();
        const prev = worst.get(key);
        if (!prev || w.totalScore < prev.score) {
          worst.set(key, { word: w.content, score: w.totalScore });
        }
      }
    }
  }
  return [...worst.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map((w) => {
      const source = findPronWord(sessions, w.word);
      const worstPhone = worstPhoneOf(source);
      return { ...w, tip: worstPhone ? phoneTip(worstPhone.content) : "" };
    });
}

/** 低分词对应的最差一次评测词结构（取舌位建议用；找不到就不给建议）。 */
function findPronWord(
  sessions: SpeakSession[],
  word: string,
): { sylls: { phones: { content: string; gwpp: number }[] }[] } | undefined {
  let best: { sylls: { phones: { content: string; gwpp: number }[] }[] } | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.role !== "user" || !turn.pron) continue;
      for (const w of turn.pron.words) {
        if (w.content.toLowerCase() !== word.toLowerCase()) continue;
        if (w.totalScore < bestScore) {
          bestScore = w.totalScore;
          best = w;
        }
      }
    }
  }
  return best;
}

/** 生成整篇 Markdown（标题 + 有数据的三段；数据为空时只余标题与来源行）。 */
export function buildVaultMarkdown(input: VaultExportInput): string {
  const { words, sourceSentence, speakSessions, dateKey } = input;
  const lines: string[] = [`# ${dateKey} 英语精读与口语内化笔记`, ""];

  // ---- 一、核心词块 ----
  if (words.length > 0) {
    lines.push("## 一、核心词块（带原句与用法提示）", "");
    words.forEach((w, i) => {
      const phonetic = w.phonetic ? ` \`${w.phonetic.replace(/^\/|\/$/g, "")}\`` : "";
      const gloss = w.senses.map((s) => (s.pos ? `${s.pos} ${s.cn}` : s.cn)).join("；");
      lines.push(`${i + 1}. **${w.word}**${phonetic} — ${gloss} [${STAGE_BADGE[masteryStage(w)]}]`);
      const src =
        (w.source.articleId ? sourceSentence(w.source.articleId, w.source.sentenceIdx) : null) ??
        (w.example ? { en: w.example.en, zh: w.example.zh } : null);
      if (src?.en) {
        lines.push(`   - **原句**：${emphasize(src.en, w.word)}`);
      }
      if (w.pattern) lines.push(`   - **记法**：${w.pattern}`);
      if (w.trap) lines.push(`   - **直译陷阱**：${w.trap}`);
    });
    lines.push("");
  }

  // ---- 二、口语表达升级 Before → After ----
  const coached = speakSessions.flatMap((s) => s.turns).filter((t) => t.role === "user" && t.coachDiff);
  if (coached.length > 0) {
    lines.push("## 二、口语地道表达升级（Before → After）", "");
    for (const turn of coached) {
      const better = betterTextOf(turn).trim();
      if (!better) continue;
      lines.push(`- ❌ **我的原话**：${turn.text}`);
      lines.push(`- ✅ **地道改写**：**${better}**`);
      const ins = insertedTextOf(turn).trim();
      if (ins) lines.push(`  - **值得记的新说法**：${ins}`);
      if (turn.coachDiff?.note) lines.push(`  - **点评**：${turn.coachDiff.note}`);
      lines.push("");
    }
  }

  // ---- 三、发音重点复盘 ----
  const lowWords = lowPronWords(speakSessions);
  if (lowWords.length > 0) {
    lines.push("## 三、发音重点复盘", "");
    for (const w of lowWords) {
      const tip = w.tip ? `：${w.tip}` : "";
      lines.push(`- **${w.word}**（最低 ${w.score.toFixed(1)} 分）${tip}`);
    }
    lines.push("");
  }

  lines.push("> 自动汇总自阅读查词、口语表达改进与发音诊断，可直接复制进 Notion / Obsidian。");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
