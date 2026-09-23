/**
 * 跟读报告卡 SSR 渲染冒烟：徽章/维度/诊断/词着色/动作按钮都能真实渲染不抛错。
 * （诊断文案的规则由 shadowDiagnose.test.ts 覆盖；弹层交互人工验收。）
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ShadowReport } from "./ShadowReport";
import { mapWordsToText, type PronunciationResult, type WordScore } from "../core/pronunciation";

const TARGET = "The quick brown fox jumps over the lazy dog.";

function word(content: string, totalScore: number, dpMessage = 0): WordScore {
  return { content, totalScore, dpMessage, sylls: [] };
}

const WORDS: WordScore[] = [
  { ...word("the", 5), sylls: [{ content: "dh ax", syllScore: 5, serrMsg: 0, phones: [{ content: "dh", dpMessage: 0, gwpp: -0.01 }, { content: "ax", dpMessage: 0, gwpp: -0.01 }] }] },
  word("quick", 4.7),
  word("brown", 0, 16), // 漏读
  word("fox", 2.5), // 差词
  word("jumps", 3.5),
  word("over", 5),
  word("the", 5),
  word("lazy", 4.9),
  word("dog", 4.7),
];

const RESULT: PronunciationResult = {
  total: 4.1,
  accuracy: 4.3,
  fluency: 3.4,
  standard: 4.1,
  integrity: 4.6,
  isRejected: false,
  exceptInfo: null,
  words: WORDS,
};

describe("ShadowReport 渲染冒烟", () => {
  it("4.1 分报告卡：差 0.1 过关 + 三维度 + 诊断点名 + 差/漏词着色与动作", () => {
    const html = renderToString(
      <ShadowReport
        target={TARGET}
        result={RESULT}
        marks={mapWordsToText(TARGET, WORDS)}
        attemptTotals={[3.6, 4.1]}
        onAgain={() => undefined}
        onDrill={() => undefined}
        onHearModel={() => undefined}
        onHearMine={() => undefined}
        onSpeakWord={() => undefined}
      />,
    );
    expect(html).toContain("4.1");
    expect(html).toContain("差 0.1 过关");
    expect(html).toContain("次跟读"); // 第 2 次（数字与文本间有 SSR 注释节点）
    expect(html).toContain("上次");
    expect(html).toContain("↑");
    expect(html).toContain("0.5");
    expect(html).toContain("3.6"); // 趋势 chips
    expect(html).toContain("准确度");
    expect(html).toContain("流畅度");
    expect(html).toContain("完整度");
    // 诊断句点名短板与差/漏词
    expect(html).toContain("流畅度 3.4");
    expect(html).toContain("fox");
    expect(html).toContain("漏读了 brown");
    // 动作：差词/漏词共 2 个
    expect(html).toContain("只练");
    expect(html).toContain("个词");
    expect(html).toContain("听我的录音");
    // 词着色四档里出现的三档类名（good 是纯色无额外标记，missed/bad 有）
    expect(html).toContain("wd missed");
    expect(html).toContain("wd bad");
    expect(html).toContain("wd ok");
  });

  it("过关报告卡：无词练按钮，正向文案", () => {
    const goodWords = WORDS.map((w) => ({ ...w, totalScore: 4.6, dpMessage: 0 }));
    const html = renderToString(
      <ShadowReport
        target={TARGET}
        result={{ ...RESULT, total: 4.7, accuracy: 4.8, fluency: 4.6, integrity: 5, words: goodWords }}
        marks={mapWordsToText(TARGET, goodWords)}
        attemptTotals={[3.6, 4.1, 4.7]}
        onAgain={() => undefined}
        onDrill={() => undefined}
        onHearModel={() => undefined}
        onHearMine={null}
        onSpeakWord={() => undefined}
      />,
    );
    expect(html).toContain("✓ 过关");
    expect(html).not.toContain("只练");
    // 没有录音可回放时按钮禁用而不是消失
    expect(html).toContain("听我的录音");
    expect(html).toContain("disabled");
  });
});
