import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  migrateLegacyTtsProviderValue,
  shouldMigrateLegacyTtsProvider,
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

  it("遮罩样式：合法枚举采纳，非法拒绝回落全局", () => {
    expect(mergeReaderSettings(DEFAULT_READER_SETTINGS, { maskStyle: "frost" }).maskStyle).toBe("frost");
    const merged = mergeReaderSettings({ ...DEFAULT_READER_SETTINGS, maskStyle: "frost" }, {
      maskStyle: "grid" as never,
    });
    expect(merged.maskStyle).toBe("frost");
    expect(mergeReaderSettings(DEFAULT_READER_SETTINGS, { maskStyle: 3 as never }).maskStyle).toBe("blank");
  });

  it("词块开关：布尔覆盖生效，非法类型拒绝回落全局", () => {
    expect(DEFAULT_READER_SETTINGS.chunkHighlight).toBe(true);
    expect(DEFAULT_READER_SETTINGS.showVocabMarks).toBe(true);
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      chunkHighlight: false,
      showVocabMarks: false,
    });
    expect(merged.chunkHighlight).toBe(false);
    expect(merged.showVocabMarks).toBe(false);
    const bad = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      chunkHighlight: "off" as never,
      showVocabMarks: 0 as never,
    });
    expect(bad.chunkHighlight).toBe(true);
    expect(bad.showVocabMarks).toBe(true);
  });

  it("跟读评测：默认自动开麦 1.5s 断句；覆盖与越界收紧", () => {
    expect(DEFAULT_READER_SETTINGS.shadowingAutoMic).toBe(true);
    expect(DEFAULT_READER_SETTINGS.shadowingSilenceMs).toBe(1500);
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      shadowingAutoMic: false,
      shadowingSilenceMs: 2400,
    });
    expect(merged.shadowingAutoMic).toBe(false);
    expect(merged.shadowingSilenceMs).toBe(2400);
    const clamped = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      shadowingSilenceMs: 200,
      shadowingAutoMic: "yes" as never,
    });
    expect(clamped.shadowingSilenceMs).toBe(800); // 收紧到下限
    expect(clamped.shadowingAutoMic).toBe(true); // 非法类型拒绝回落
  });

  it("v0.8 画报设置：spotlightMode/spreadLayout 缺省回落、合法覆盖、非法值忽略（字段名与 Rust camelCase 序列化一致）", () => {
    // 默认：专注模式关、段落排版。
    expect(DEFAULT_READER_SETTINGS.spotlightMode).toBe(false);
    expect(DEFAULT_READER_SETTINGS.spreadLayout).toBe("prose");
    // 缺省回落：老文章 settings 没有这两个字段。
    const fallback = mergeReaderSettings(DEFAULT_READER_SETTINGS, { fontSize: 20 });
    expect(fallback.spotlightMode).toBe(false);
    expect(fallback.spreadLayout).toBe("prose");
    // 合法覆盖（键名必须是 spotlightMode/spreadLayout——serde 按名剥离，改名即静默丢设置）。
    const merged = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
      spotlightMode: true,
      spreadLayout: "parallel",
    });
    expect(merged.spotlightMode).toBe(true);
    expect(merged.spreadLayout).toBe("parallel");
    // 非法值忽略：布尔给字符串、排版给未契约枚举都回落全局。
    const bad = mergeReaderSettings({ ...DEFAULT_READER_SETTINGS, spotlightMode: true }, {
      spotlightMode: "on" as never,
      spreadLayout: "magazine" as never,
    });
    expect(bad.spotlightMode).toBe(true);
    expect(bad.spreadLayout).toBe("prose");
  });
});

describe("旧 xfyun → cloud 迁移谓词（零回归）", () => {
  it("仅旧值参与迁移；edge/local/cloud 永不被凭据或登录态改写", () => {
    expect(shouldMigrateLegacyTtsProvider("xfyun", { hasAnyXfyunCredential: true, loggedIn: false })).toBe(true);
    expect(shouldMigrateLegacyTtsProvider("xfyun", { hasAnyXfyunCredential: false, loggedIn: true })).toBe(true);
    expect(shouldMigrateLegacyTtsProvider("xfyun", { hasAnyXfyunCredential: false, loggedIn: false })).toBe(false);
    expect(shouldMigrateLegacyTtsProvider("edge", { hasAnyXfyunCredential: true, loggedIn: true })).toBe(false);
    expect(shouldMigrateLegacyTtsProvider("cloud", { hasAnyXfyunCredential: true, loggedIn: true })).toBe(false);
  });

  it("迁移允许时旧值升格 cloud；不允许时保留 xfyun（继续本地回落，不串 Edge）", () => {
    expect(migrateLegacyTtsProviderValue("xfyun", true)).toBe("cloud");
    expect(migrateLegacyTtsProviderValue("xfyun", false)).toBe("xfyun");
    expect(migrateLegacyTtsProviderValue("edge", true)).toBe("edge");
    expect(migrateLegacyTtsProviderValue("cloud", true)).toBe("cloud");
  });
});
