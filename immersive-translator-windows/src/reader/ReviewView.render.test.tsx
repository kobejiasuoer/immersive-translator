import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ReviewView, GRADE_COPY, gradeAsk } from "./ReviewView";
import { VocabListPanel } from "./VocabListPanel";
import type { ReviewModeSetting } from "../core/readerTypes";
import type { ReviewStats } from "../lib/readerStore";
import type { VocabWord } from "../core/readerTypes";
import { dueVocab, initialSrs } from "../core/readerSrs";

// SSR 渲染冒烟：三种练习形态 + 空态能真实渲染，不抛错。
// （交互行为由 recallJudge.test.ts 的纯函数用例与人工验收覆盖。）

function makeWord(partial: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    senses: [{ pos: "n.", cn: "测试释义" }],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(0),
    addedAt: 0,
    ...partial,
  };
}

const CHUNK = makeWord({
  id: "take root",
  word: "take root",
  kind: "chunk",
  chunkType: "phrasal",
  pattern: "take root (in sth)",
  trap: "take roots（不可数）",
  senses: [{ pos: "phrasal", cn: "扎根" }],
});

const FRESH_WORD = makeWord({ id: "canopy", word: "canopy", phonetic: "ˈkænəpi" });

const KNOWN_WORD = makeWord({
  id: "buffer",
  word: "buffer",
  srs: { ease: 2.5, intervalDays: 3, reps: 2, dueAt: 0, lapses: 0 },
});

/** 划词收藏（无文章来源）：source.articleId 为空，带 LLM 例句。 */
const POPUP_WORD = makeWord({
  id: "serendipity",
  word: "serendipity",
  phonetic: "ˌserənˈdipəti",
  senses: [{ pos: "n.", cn: "意外发现珍奇事物的运气" }],
  source: { articleId: "", sentenceIdx: 0 },
  example: { en: "Finding this book was pure serendipity.", zh: "找到这本书纯属机缘巧合。" },
});

const STATS: ReviewStats = {
  dueNow: 4,
  reviewedToday: 0,
  total: 4,
  streak: 1,
  distribution: { learning: 4, familiar: 0, mastered: 0 },
  totalWords: 3,
  totalChunks: 1,
  dueWords: 3,
  dueChunks: 1,
};

const SOURCE: Record<string, { en: string; zh: string | null }> = {
  a1: {
    // 词块 text 是句子的连续子串——这是标注管线（chunkAnnotate）保证的不变量
    en: "These ideas take root only when the soil is ready.",
    zh: "这些想法只有在土壤就绪时才会扎根。",
  },
};

function baseProps(reviewMode: ReviewModeSetting, words?: VocabWord[]) {
  const ws = words ?? [CHUNK, POPUP_WORD, FRESH_WORD, KNOWN_WORD];
  return {
    words: ws,
    due: dueVocab(ws),
    pos: 0,
    onSetPos: () => undefined,
    stats: STATS,
    reviewMode,
    onReviewModeChange: () => undefined,
    onGrade: () => undefined,
    onJumpToSentence: () => undefined,
    onSpeakWord: () => undefined,
    onSpeakSentence: () => undefined,
    sourcePreview: (id: string, idx: number) => SOURCE[id]?.en.split(/\.(?=\s|$)/)[idx] ?? null,
    sourceSentence: (id: string, _idx: number) => {
      const s = SOURCE[id];
      return s ? { en: s.en, zh: s.zh } : null;
    },
    articleTitle: () => "Test Article",
  };
}

describe("ReviewView render smoke", () => {
  it("smart 模式：词块卡渲染为完形（挖空输入框 + 中文打码提示）", () => {
    const html = renderToString(<ReviewView {...baseProps("smart")} />);
    expect(html).toContain("完形");
    // 智能混合下小签带「智能」前缀（派发可见），强制模式不带
    expect(html).toContain("智能 · 完形");
    expect(html).toContain("被挖空的部分");
    expect(html).toContain("cn-masked");
    // 完形卡不渲染词头（词条即答案，避免剧透）
    expect(html).not.toContain("rc-word");
  });

  it("强制听写模式：渲染播放条与听写输入区", () => {
    const html = renderToString(<ReviewView {...baseProps("dictation")} />);
    expect(html).toContain("听写");
    expect(html).toContain("听写输入");
  });

  it("强制识别模式：正面不泄露释义，且原句目标被遮住", () => {
    const html = renderToString(<ReviewView {...baseProps("recognition")} />);
    expect(html).toContain("翻面");
    // 释义（答案）不在正面
    expect(html).not.toContain("测试释义");
    // 正面书证里目标词被挖空（rc-blank），不直接显示 take root
    expect(html).toContain("rc-blank");
  });

  it("划词收藏（无文章来源）：识别卡回退用 LLM 例句，来源显示「来自划词收藏」", () => {
    const html = renderToString(
      <ReviewView {...baseProps("recognition", [POPUP_WORD, CHUNK, FRESH_WORD, KNOWN_WORD])} />,
    );
    // 队首是划词收藏卡：来源标签
    expect(html).toContain("来自划词收藏");
    // 正面书证用例句（目标词被挖空，不泄露答案）
    expect(html).toContain("Finding this book was pure");
    expect(html).toContain("rc-blank");
    expect(html).not.toContain("测试释义");
  });

  it("到期队列为空：显示完成态与四主题模式切换", () => {
    const html = renderToString(<ReviewView {...baseProps("smart", [])} />);
    expect(html).toContain("今日复习完成");
    expect(html).toContain("智能混合");
  });

  it("评分带文案：白话提问 + 四档回答（不再露出 SRS 术语）", () => {
    // 评分带只在翻面/判分后出现，SSR 冒烟渲染不到——直接断言导出的文案契约
    expect(gradeAsk("recognition")).toBe("翻面前，你想出意思了吗？");
    expect(gradeAsk("cloze")).toBe("这个空，你答上来了吗？");
    expect(gradeAsk("dictation")).toBe("这一句，你写出来了吗？");
    const names = Object.values(GRADE_COPY).map((c) => c.name);
    expect(names).toEqual(["没想起", "很勉强", "想起来了", "很轻松"]);
    expect(GRADE_COPY.forgot.next).toContain("10分钟");
    expect(GRADE_COPY.easy.next).toContain("7天后");
    const copy = names.join() + Object.values(GRADE_COPY).map((c) => c.next).join();
    for (const term of ["忘记", "困难", "一般", "简单"]) {
      expect(copy).not.toContain(term);
    }
  });
});

describe("VocabListPanel render smoke", () => {
  it("到期组带序号可跳卡，未到期组显示下次见面时间，页脚是回阅读室入口", () => {
    const later = makeWord({
      id: "novel",
      word: "novel",
      srs: { ease: 2.5, intervalDays: 3, reps: 1, dueAt: Date.now() + 3 * 86400000, lapses: 0 },
    });
    const words = [CHUNK, FRESH_WORD, later];
    const html = renderToString(
      <VocabListPanel
        words={words}
        due={dueVocab(words)}
        pos={0}
        reviewedToday={1}
        streak={2}
        onJumpToCard={() => undefined}
        onOpenReader={() => undefined}
      />,
    );
    expect(html).toContain("待复习");
    expect(html).toContain("vlist-due");
    expect(html).toContain("稍后再来");
    expect(html).toContain("3天后");
    expect(html).toContain("沉浸式阅读");
  });

  it("空词表：给出攒词指引", () => {
    const html = renderToString(
      <VocabListPanel
        words={[]}
        due={[]}
        pos={0}
        reviewedToday={0}
        streak={0}
        onJumpToCard={() => undefined}
        onOpenReader={() => undefined}
      />,
    );
    expect(html).toContain("还没有生词");
    expect(html).toContain("沉浸式阅读");
  });
});
