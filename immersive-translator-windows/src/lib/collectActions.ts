/**
 * 「加入生词本」与「送到阅读室」的公共实现：浮窗与历史窗口共用。
 *
 * 设计约束（2026-09-24 历史→生词本/阅读室串联，docs/product-audit S3）：
 * - 生词落库一律走 readerMergeVocabWords：已有同名词保留 SRS/recall 进度，
 *   仅在原本没有例句时补例句；不用会整体覆盖旧词的 readerSaveVocabWord。
 * - 词典查询失败时的兜底译文（历史记录的译文 / 浮窗当前译文）只在
 *   「短释义形状」时才可采用——它可能是整句翻译，不能无条件当作词典释义。
 * - 送到阅读室只建文章不填句对译文：阅读室按句保存译文，调用方手里只有
 *   整段译文，强行拆句会错位，交给阅读室逐句翻译。
 */

import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { hasValidSettings, loadSettingsAsync } from "./settingsStore";
import { readerMergeVocabWords, readerSaveArticle } from "./readerStore";
import { buildArticleFromText } from "../core/articleBuilder";
import {
  buildExamplePrompt,
  buildReaderDictPrompt,
  entryToVocab,
  parseExampleResponse,
  parseReaderDictResponse,
} from "../core/readerDict";
import { resolveTargetLanguage } from "../core/languageDetect";
import { resolveVocabEntry } from "../core/vocabEntry";
import type { Article, VocabWord } from "../core/readerTypes";

/** 一次性 LLM 请求依赖：失败 reject，成功返回模型原始输出。 */
export interface VocabRequestDeps {
  requestOnce: (text: string, systemPrompt: string, tag: string) => Promise<string>;
  /** 生成请求 tag。各窗口用自己的前缀（panel 用 t/d/v，历史用 hv），避免跨窗口 tag 相撞。 */
  makeTag: () => string;
}

export type AddVocabOutcome = {
  /** added = 新词入库；merged = 已在生词本（SRS 进度保持不变）。 */
  status: "added" | "merged";
  word: VocabWord;
  /** 例句是否生成成功（旧词仅在原本没有例句时才会真正补上）。 */
  withExample: boolean;
};

/**
 * 加入生词本：词典查词条 + LLM 造例句（并行），entryToVocab 生成词条后
 * 合并落库（保留已有词的 SRS 进度），并广播阅读室刷新。
 * `fallbackCn`：词典失败时的参考译文（浮窗当前译文 / 历史记录译文），
 * 仅在「短释义形状」时采用。
 */
export async function addTextToVocab(
  deps: VocabRequestDeps,
  rawText: string,
  options: { fallbackCn?: string } = {},
): Promise<AddVocabOutcome> {
  const text = rawText.trim();
  if (!text) throw new Error("没有可加入的文本");
  const s = await loadSettingsAsync();
  if (!hasValidSettings(s)) throw new Error("先在设置里配置翻译接口");
  const target = resolveTargetLanguage(text, { mode: s.translationMode, fixed: s.fixedTarget });
  const [dictRes, exRes] = await Promise.allSettled([
    deps.requestOnce(
      text,
      buildReaderDictPrompt({
        targetLanguage: target,
        customStyle: "",
        glossaryText: s.glossaryText,
      }),
      deps.makeTag(),
    ),
    deps.requestOnce(text, buildExamplePrompt(text, target), deps.makeTag()),
  ]);
  const entry = resolveVocabEntry(
    text,
    dictRes.status === "fulfilled" ? parseReaderDictResponse(dictRes.value) : null,
    options.fallbackCn ?? "",
  );
  const word = entryToVocab(entry, { articleId: "", sentenceIdx: 0 });
  let withExample = false;
  if (exRes.status === "fulfilled") {
    const example = parseExampleResponse(exRes.value, entry.word);
    if (example) {
      word.example = example;
      withExample = true;
    }
  }
  const result = await readerMergeVocabWords([word]);
  const status: AddVocabOutcome["status"] = result.added.includes(word.id) ? "added" : "merged";
  await emit("reader:vocab-added", word.id);
  return { status, word, withExample };
}

/**
 * 送到阅读室：英文原文 → 建文章（分句/标题）→ 落库 → 广播 → 打开阅读室窗口。
 * 返回建成的文章。失败时抛错，调用方负责提示；不填句对译文（见模块头注释）。
 */
export async function sendTextToReader(rawText: string): Promise<Article> {
  const text = rawText.trim();
  if (!text) throw new Error("没有可发送的内容");
  const article = buildArticleFromText(text, { sourceType: "paste" });
  if (!article) throw new Error("没有可发送的内容");
  await readerSaveArticle(article);
  await emit("reader:article-added", article.id);
  await invoke("open_reader");
  return article;
}
