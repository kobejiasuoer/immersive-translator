// 「Markdown 笔记导出」生成器：三段结构、原句强调、Before→After、低分发音复盘。
// 断言全部对着构造入参做包含性断言（不复制原型演示句）。
import { describe, expect, it } from "vitest";
import { buildVaultMarkdown } from "./vaultExport";
import { initialSrs } from "./readerSrs";
import type { VocabWord } from "./readerTypes";
import type { SpeakSession } from "./speakLogic";

function makeWord(partial: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    senses: [{ pos: "n.", cn: "测试释义" }],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(0),
    addedAt: 0,
    ...partial,
  };
}

const SOURCE: Record<string, { en: string; zh: string | null }> = {
  a1: {
    en: "Reading a few pages each evening helps the habit take root.",
    zh: "每晚读几页能让习惯扎根。",
  },
};

const WORDS: VocabWord[] = [
  makeWord({
    id: "take root",
    word: "take root",
    kind: "chunk",
    phonetic: "teɪk ruːt",
    pattern: "take root (in sth)",
    trap: "take roots（不可数）",
    senses: [{ pos: "phrasal", cn: "扎根" }],
  }),
  makeWord({
    id: "unwind",
    word: "unwind",
    spokenAt: 1770000000000,
    senses: [{ pos: "v.", cn: "放松下来" }],
  }),
];

/** 一条带表达改进与发音评测的 user 轮（coachDiff = 删 tired 加 drained）。 */
const SESSION: SpeakSession = {
  id: "s1",
  scenario: "smalltalk",
  difficulty: "medium",
  createdAt: 0,
  updatedAt: 0,
  turns: [
    {
      role: "user",
      text: "I was very tired after the long meeting.",
      at: 0,
      coachDiff: {
        segs: [
          { t: "keep", v: "I" },
          { t: "keep", v: "was" },
          { t: "del", v: "very" },
          { t: "del", v: "tired" },
          { t: "ins", v: "completely" },
          { t: "ins", v: "drained" },
          { t: "keep", v: "after" },
          { t: "keep", v: "the" },
          { t: "keep", v: "long" },
          { t: "keep", v: "meeting." },
        ],
        note: "drained 比 tired 更有画面感",
      },
      pron: {
        at: 0,
        total: 3.1,
        accuracy: 3.0,
        fluency: 3.2,
        integrity: 4.8,
        words: [
          {
            content: "drained",
            totalScore: 2.1,
            dpMessage: 0,
            sylls: [
              {
                content: "drained",
                syllScore: 2,
                serrMsg: 0,
                phones: [{ content: "eɪ", dpMessage: 0, gwpp: -1.2 }],
              },
            ],
          },
          { content: "meeting", totalScore: 4.6, dpMessage: 0, sylls: [] },
        ],
      },
    },
  ],
};

const BASE = {
  words: WORDS,
  sourceSentence: (id: string, _idx: number) => SOURCE[id] ?? null,
  speakSessions: [SESSION],
  dateKey: "2026-10-16",
};

describe("buildVaultMarkdown", () => {
  it("标题用传入日期键；三段标题齐备", () => {
    const md = buildVaultMarkdown(BASE);
    expect(md.startsWith("# 2026-10-16 英语精读与口语内化笔记")).toBe(true);
    expect(md).toContain("## 一、核心词块（带原句与用法提示）");
    expect(md).toContain("## 二、口语地道表达升级（Before → After）");
    expect(md).toContain("## 三、发音重点复盘");
  });

  it("核心词块：词/音标/释义/三阶徽标/原句强调/pattern/trap 全落地", () => {
    const md = buildVaultMarkdown(BASE);
    expect(md).toContain("**take root**");
    expect(md).toContain("`teɪk ruːt`");
    expect(md).toContain("扎根");
    expect(md).toContain("[🌱 刚收集]");
    // 原句来自 sourceSentence，目标词块加斜体强调
    expect(md).toContain("**原句**：Reading a few pages each evening helps the habit *take root*.");
    expect(md).toContain("**记法**：take root (in sth)");
    expect(md).toContain("**直译陷阱**：take roots（不可数）");
    // spokenAt 存在 → s3 徽标
    expect(md).toContain("**unwind**");
    expect(md).toContain("[✨ 已变成口语表达]");
  });

  it("口语升级：Before 是用户原话，After 是 keep+ins 拼回的地道改写", () => {
    const md = buildVaultMarkdown(BASE);
    expect(md).toContain("❌ **我的原话**：I was very tired after the long meeting.");
    expect(md).toContain("✅ **地道改写**：**I was completely drained after the long meeting.**");
    expect(md).toContain("**值得记的新说法**：completely drained");
    expect(md).toContain("**点评**：drained 比 tired 更有画面感");
  });

  it("发音复盘：只列低分词（<3 分），带最差音素的舌位建议", () => {
    const md = buildVaultMarkdown(BASE);
    expect(md).toContain("**drained**（最低 2.1 分）");
    // gwpp -1.2 ≤ -0.4 命中 worstPhoneOf → phoneTip（有针对提示或兜底文案）
    expect(md).toMatch(/\*\*drained\*\*（最低 2\.1 分）：.+/);
    // 4.6 分的 meeting 不是低分词，不进复盘
    expect(md).not.toContain("**meeting**");
  });

  it("空数据不产出空段：只剩标题与来源行", () => {
    const md = buildVaultMarkdown({ words: [], speakSessions: [], sourceSentence: () => null, dateKey: "2026-10-16" });
    expect(md).toContain("# 2026-10-16 英语精读与口语内化笔记");
    expect(md).not.toContain("## 一、");
    expect(md).not.toContain("## 二、");
    expect(md).not.toContain("## 三、");
  });

  it("原句缺失时回退词条自带例句，仍然不伪造强调", () => {
    const popup = makeWord({
      id: "serenity",
      word: "serenity",
      source: { articleId: "", sentenceIdx: 0 },
      example: { en: "She found serenity in the morning garden.", zh: null },
    });
    const md = buildVaultMarkdown({ ...BASE, words: [popup] });
    expect(md).toContain("**原句**：She found *serenity* in the morning garden.");
  });
});
