import { describe, expect, it } from "vitest";
import { parseNoteMarkdown, splitNoteFrontmatter } from "./noteParser";
import type { NoteMeta } from "./readerTypes";

const META: NoteMeta = {
  file: "学词笔记-2026-09-16.md",
  createdAt: 1_700_000_000_000,
  words: 2,
  partial: false,
  wordIds: ["inconsistencies", "sourcing from"],
  replay: null,
  updatedAt: 1_700_000_000_000,
};

describe("splitNoteFrontmatter", () => {
  it("拆出 meta 与正文（body 不含定界符）", () => {
    const raw = `---\n${JSON.stringify(META)}\n---\n# 复习笔记\n\n正文`;
    const { meta, body } = splitNoteFrontmatter(raw);
    expect(meta).not.toBeNull();
    expect(meta?.file).toBe(META.file);
    expect(meta?.wordIds).toEqual(META.wordIds);
    expect(body).toBe("# 复习笔记\n\n正文");
  });

  it("兼容 \\r\\n", () => {
    const raw = `---\r\n${JSON.stringify(META)}\r\n---\r\n正文`;
    const { meta, body } = splitNoteFrontmatter(raw);
    expect(meta?.file).toBe(META.file);
    expect(body).toBe("正文");
  });

  it("无 frontmatter 返回 null 与原文", () => {
    const { meta, body } = splitNoteFrontmatter("# 复习笔记\n外部拷入");
    expect(meta).toBeNull();
    expect(body).toBe("# 复习笔记\n外部拷入");
  });

  it("frontmatter 损坏返回 null（不抛错）", () => {
    const { meta } = splitNoteFrontmatter("---\n{broken json\n---\n正文");
    expect(meta).toBeNull();
  });
});

describe("parseNoteMarkdown", () => {
  const body = `# 复习笔记

## 先看这里
- 这批词的通病——不是不认识，是搭配调不出
- sourcing from 踩过 2 次陷阱

## 单词
### inconsistencies
【记不住】复习 4 次、忘 3 次，两次都栽在完形：in the data 里选了 of。
【记法】记整块不记词：inconsistencies in the data——介词就是考点。
- n. 不一致；矛盾；前后不一之处
- n. 反复无常，不连贯
> Like hotel-level inconsistencies, sourcing from multiple suppliers may have room-level inconsistencies.
- 必记｜inconsistencies in the data｜数据里的不一致
- 类推｜X-level inconsistencies｜hotel-level / room-level 都对
【测】完形｜考介词：supplier 数据 __ the report 也有不一致。

## 词块
### sourcing from
【记住了】连对 2 次进入 3 天间隔，保持节奏。
- 从……采购/获取
> …, sourcing from multiple suppliers may have room-level inconsistencies.
【测】完形｜考句式方向：We ___ two suppliers in Germany.
`;

  it("解析速览结论", () => {
    const note = parseNoteMarkdown(body);
    expect(note.glance).toHaveLength(2);
    expect(note.glance[0]).toContain("搭配调不出");
  });

  it("解析词条卡的全部批注标记", () => {
    const note = parseNoteMarkdown(body);
    const card = note.sections[0].cards[0];
    expect(card.word).toBe("inconsistencies");
    expect(card.diagnose).toEqual({
      ok: false,
      text: "复习 4 次、忘 3 次，两次都栽在完形：in the data 里选了 of。",
    });
    expect(card.anchor).toContain("记整块不记词");
    expect(card.senses).toEqual([
      { pos: "n.", text: "不一致；矛盾；前后不一之处" },
      { pos: "n.", text: "反复无常，不连贯" },
    ]);
    expect(card.example).toContain("Like hotel-level inconsistencies");
    expect(card.collos).toEqual([
      { k: "必记", en: "inconsistencies in the data", zh: "数据里的不一致" },
      { k: "类推", en: "X-level inconsistencies", zh: "hotel-level / room-level 都对" },
    ]);
    expect(card.nextTest).toEqual({ mode: "完形", tip: "考介词：supplier 数据 __ the report 也有不一致。" });
  });

  it("解析词块卡（无词性释义 + 【记住了】）", () => {
    const note = parseNoteMarkdown(body);
    const card = note.sections[1].cards[0];
    expect(card.word).toBe("sourcing from");
    expect(card.diagnose?.ok).toBe(true);
    expect(card.senses).toEqual([{ pos: null, text: "从……采购/获取" }]);
    expect(card.nextTest?.mode).toBe("完形");
  });

  it("空正文与无结构正文都返回空骨架", () => {
    expect(parseNoteMarkdown("")).toEqual({ glance: [], sections: [] });
    const loose = parseNoteMarkdown("随便一段话\n没有标记");
    expect(loose.glance).toEqual([]);
    expect(loose.sections).toEqual([]);
  });

  it("缺【测】等标记时不抛错、其余字段照常", () => {
    const note = parseNoteMarkdown("### bare\n- n. 只有一条释义");
    const card = note.sections[0].cards[0];
    expect(card.word).toBe("bare");
    expect(card.senses).toEqual([{ pos: "n.", text: "只有一条释义" }]);
    expect(card.diagnose).toBeUndefined();
    expect(card.nextTest).toBeUndefined();
  });
});
