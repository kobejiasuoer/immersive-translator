import { describe, expect, it } from "vitest";
import {
  TRANSLATE_BACKOFF_WAIT_MS,
  TRANSLATE_MAX_GROUP_RETRIES,
  TRANSLATE_MAX_RUN_BACKOFFS,
  buildParagraphRequestInput,
  buildParagraphTranslateSystemPrompt,
  joinChineseLines,
  parseParagraphResponse,
  planTranslateRetry,
} from "./paragraphTranslate";

describe("parseParagraphResponse", () => {
  it("标准编号行对齐", () => {
    const raw = "[1] 速度是目标，理解力是考卷。\n[2] 研究人员测量了志愿者的阅读速度。";
    expect(parseParagraphResponse(raw, 2)).toEqual([
      "速度是目标，理解力是考卷。",
      "研究人员测量了志愿者的阅读速度。",
    ]);
  });

  it("容忍方括号/全角编号与冒号", () => {
    const raw = "【1】速度是目标。\n2、理解力是考卷。";
    expect(parseParagraphResponse(raw, 2)).toEqual(["速度是目标。", "理解力是考卷。"]);
  });

  it("markdown 围栏被剥掉", () => {
    const raw = "```\n[1] 甲。\n[2] 乙。\n```";
    expect(parseParagraphResponse(raw, 2)).toEqual(["甲。", "乙。"]);
  });

  it("序号乱序也能按序号对齐", () => {
    const raw = "[2] 乙。\n[1] 甲。";
    expect(parseParagraphResponse(raw, 2)).toEqual(["甲。", "乙。"]);
  });

  it("行数不足返回 null（段失败可重试）", () => {
    expect(parseParagraphResponse("[1] 甲。", 2)).toBeNull();
  });

  it("序号越界行被忽略", () => {
    expect(parseParagraphResponse("[1] 甲。\n[9] 越界。", 1)).toEqual(["甲。"]);
  });

  it("无编号但行数恰好的降级对齐", () => {
    expect(parseParagraphResponse("甲。\n乙。", 2)).toEqual(["甲。", "乙。"]);
  });

  it("空响应返回 null", () => {
    expect(parseParagraphResponse("   \n", 1)).toBeNull();
  });
});

describe("buildParagraphRequestInput", () => {
  it("生成 1 起始编号行", () => {
    expect(buildParagraphRequestInput(["A.", "B."])).toBe("[1] A.\n[2] B.");
  });
});

describe("joinChineseLines", () => {
  it("中文句间不加空格（§4 硬规则）", () => {
    expect(joinChineseLines(["速度是目标。", "理解力是考卷。"])).toBe("速度是目标。理解力是考卷。");
  });
});

describe("buildParagraphTranslateSystemPrompt", () => {
  it("要求保序等量输出", () => {
    const prompt = buildParagraphTranslateSystemPrompt({
      targetLanguage: "中文",
      customStyle: "",
      glossaryText: "",
    });
    expect(prompt).toContain("[N]");
    expect(prompt).toContain("相同数量");
  });
});

describe("planTranslateRetry", () => {
  it("429 且两重配额未满 → 等待 20s", () => {
    expect(
      planTranslateRetry({ httpStatus: 429, groupRetries: 0, runBackoffs: 0 }),
    ).toBe(TRANSLATE_BACKOFF_WAIT_MS);
    expect(TRANSLATE_BACKOFF_WAIT_MS).toBe(20_000);
  });

  it("每段自动重试最多 1 次：groupRetries 已满 → 不再重试", () => {
    expect(
      planTranslateRetry({ httpStatus: 429, groupRetries: 1, runBackoffs: 0 }),
    ).toBeNull();
  });

  it("整篇退避总次数上限 6：runBackoffs 已满 → 不再重试", () => {
    expect(
      planTranslateRetry({ httpStatus: 429, groupRetries: 0, runBackoffs: 6 }),
    ).toBeNull();
    expect(TRANSLATE_MAX_GROUP_RETRIES).toBe(1);
    expect(TRANSLATE_MAX_RUN_BACKOFFS).toBe(6);
  });

  it("非 429（结构化状态码判定，如 500）→ 不重试", () => {
    expect(
      planTranslateRetry({ httpStatus: 500, groupRetries: 0, runBackoffs: 0 }),
    ).toBeNull();
  });

  it("状态码未知（null：超时/未配置等非 HTTP 失败）→ 不重试", () => {
    expect(
      planTranslateRetry({ httpStatus: null, groupRetries: 0, runBackoffs: 0 }),
    ).toBeNull();
  });
});
