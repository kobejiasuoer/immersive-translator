import { describe, expect, it } from "vitest";
import {
  buildSentenceXrayInput,
  buildSentenceXraySystemPrompt,
  parseSentenceXrayResponse,
} from "./sentenceXray";

const SENTENCE =
  "It was not that Buck could not adapt, but that the domesticated generations fell away from him.";

describe("buildSentenceXraySystemPrompt", () => {
  it("约束只输出 JSON 且 snippet 必须是原句连续子串", () => {
    const prompt = buildSentenceXraySystemPrompt("简体中文");
    expect(prompt).toContain('"spine"');
    expect(prompt).toContain('"clauses"');
    expect(prompt).toContain('"pattern"');
    expect(prompt).toContain("exact contiguous substring");
    // 目标语为空串时回落简体中文，不为空时原样进入。
    expect(buildSentenceXraySystemPrompt("")).toContain("简体中文");
    expect(buildSentenceXraySystemPrompt("日本語")).toContain("日本語");
  });

  it("用户内容把原句包进 <sentence> 标签", () => {
    const input = buildSentenceXrayInput(SENTENCE);
    expect(input).toContain("<sentence>");
    expect(input).toContain("</sentence>");
    expect(input).toContain(SENTENCE);
  });
});

describe("parseSentenceXrayResponse", () => {
  it("合法 JSON：spine/clauses/pattern 全量解析", () => {
    const raw = JSON.stringify({
      spine: "It was not that Buck could not adapt",
      clauses: [
        { tag: "主语", snippet: "Buck", desc: "主语" },
        { tag: "转折框架", snippet: "not that ... but that", desc: "不是…而是…" },
      ],
      pattern: "It was not that X, but that Y",
    });
    const parsed = parseSentenceXrayResponse(raw, SENTENCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("It was not that Buck could not adapt");
    expect(parsed!.clauses).toHaveLength(1); // "not that ... but that" 不是原句子串，被丢弃
    expect(parsed!.clauses[0]).toEqual({ tag: "主语", snippet: "Buck", desc: "主语" });
    expect(parsed!.pattern).toBe("It was not that X, but that Y");
  });

  it("剥 markdown 围栏与前后杂讯", () => {
    const raw = '好的，解析如下：\n```json\n{"spine":"the generations fell away","clauses":[],"pattern":""}\n```\n以上。';
    const parsed = parseSentenceXrayResponse(raw, SENTENCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("the generations fell away");
    expect(parsed!.clauses).toEqual([]);
  });

  it("snippet 非原句子串的条目被丢弃（宁漏勿错）", () => {
    const raw = JSON.stringify({
      spine: "It was not that Buck",
      clauses: [
        { tag: "编造", snippet: "totally invented phrase", desc: "不在原句里" },
        { tag: "大小写弹性", snippet: "BUCK", desc: "忽略大小写可定位，保留" },
        { tag: "空片段", snippet: "  ", desc: "空串丢弃" },
        { tag: "缺说明", snippet: "Buck", desc: "" },
      ],
      pattern: "",
    });
    const parsed = parseSentenceXrayResponse(raw, SENTENCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.clauses.map((c) => c.tag)).toEqual(["大小写弹性"]);
  });

  it("整段垃圾 / 缺 spine 返回 null", () => {
    expect(parseSentenceXrayResponse("模型跑偏了，这不是 JSON。", SENTENCE)).toBeNull();
    expect(parseSentenceXrayResponse("{}", SENTENCE)).toBeNull();
    expect(
      parseSentenceXrayResponse(JSON.stringify({ clauses: [{ tag: "主", snippet: "Buck", desc: "x" }] }), SENTENCE),
    ).toBeNull(); // 没有 spine 视为无效
  });
});
