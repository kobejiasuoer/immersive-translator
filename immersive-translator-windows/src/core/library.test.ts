import { describe, expect, it } from "vitest";
import { buildArticleFromLibraryItem, LIBRARY, localDayNumber, todayLibraryItem } from "./library";
import { countWords } from "./articleBuilder";

describe("library 数据", () => {
  it("文库非空且字段完整", () => {
    expect(LIBRARY.length).toBeGreaterThanOrEqual(6);
    for (const item of LIBRARY) {
      expect(item.id).toBeTruthy();
      expect(item.en).toBeTruthy();
      expect(item.cn).toBeTruthy();
      expect(item.words).toBeGreaterThan(500);
      expect(item.text.split(/\n\n/).length).toBeGreaterThan(10);
      // 正文以真实首段开头（不带书名题头行）
      expect(item.text.startsWith(item.en)).toBe(false);
      expect(item.quote.length).toBeGreaterThan(20);
    }
  });

  it("id 唯一", () => {
    expect(new Set(LIBRARY.map((i) => i.id)).size).toBe(LIBRARY.length);
  });
});

describe("todayLibraryItem", () => {
  it("同一天返回同一篇，跨天轮换", () => {
    const day = localDayNumber();
    expect(todayLibraryItem()).toBe(LIBRARY[day % LIBRARY.length]);
    const tomorrow = todayLibraryItem(Date.now() + 86_400_000);
    const dayAfter = todayLibraryItem(Date.now() + 2 * 86_400_000);
    // 三天周期内不重复（文库长度 > 2）
    expect(new Set([todayLibraryItem().id, tomorrow.id, dayAfter.id]).size).toBe(3);
  });
});

describe("buildArticleFromLibraryItem", () => {
  it("建出的文章：标题/副标题/难度/来源就位，正文不含标题行", () => {
    const item = LIBRARY[0];
    const article = buildArticleFromLibraryItem(item);
    expect(article).not.toBeNull();
    expect(article!.title).toBe(item.en);
    expect(article!.titleCn).toContain(item.cn);
    expect(article!.titleCnState).toBe("done");
    expect(article!.level).toBe(item.level);
    expect(article!.sourceType).toBe("paste");
    expect(article!.sourceUrl).toBe(`library:${item.id}`);
    expect(article!.wordCount).toBeGreaterThan(500);
    // 副标题已就位时不再进入标题翻译管线
    expect(article!.sentences[0].zhState).toBe("pending");
    expect(article!.wordCount).toBe(countWords(item.text));
  });
});
