import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
} from "./readerTypes";

describe("mergeReaderSettings", () => {
  it("无覆盖时返回默认副本", () => {
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, null);
    expect(merged).toEqual(DEFAULT_READER_SETTINGS);
    expect(merged).not.toBe(DEFAULT_READER_SETTINGS);
  });

  it("文章覆盖只影响合法字段", () => {
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      fontSize: 22,
      theme: "sepia",
      rate: 1.5,
    });
    expect(merged.fontSize).toBe(22);
    expect(merged.theme).toBe("sepia");
    expect(merged.rate).toBeCloseTo(1.5);
    expect(merged.contrastMode).toBe(DEFAULT_READER_SETTINGS.contrastMode);
  });

  it("非法类型被拒，越界数值收紧到边界", () => {
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      fontSize: 999,
      rate: 99,
      theme: "rainbow" as never,
      sentencePauseMs: -5,
      lineHeight: 9,
    });
    expect(merged.fontSize).toBe(24); // 收紧到上限
    expect(merged.rate).toBe(2); // 收紧到上限
    expect(merged.theme).toBe(DEFAULT_READER_SETTINGS.theme); // 非法枚举拒绝
    expect(merged.sentencePauseMs).toBe(0); // 负数收紧到下限
    expect(merged.lineHeight).toBe(1); // 超范围拒绝
  });
});
