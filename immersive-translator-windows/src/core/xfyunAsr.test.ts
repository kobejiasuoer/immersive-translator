import { describe, expect, it } from "vitest";
import { extractIatSegment, mergeIatSegments } from "./xfyunAsr";

describe("extractIatSegment", () => {
  it("拼接 ws/cw 词并取 sn", () => {
    const payload = JSON.stringify({
      code: 0,
      data: {
        result: {
          sn: 2,
          ws: [
            { cw: [{ w: "like ", sc: 0 }] },
            { cw: [{ w: "a ", sc: 0 }] },
            { cw: [{ w: "coffee", sc: 0 }] },
          ],
        },
        status: 1,
      },
    });
    expect(extractIatSegment(payload)).toEqual({ sn: 2, text: "like a coffee" });
  });

  it("多候选 cw 取第一个", () => {
    const payload = JSON.stringify({
      code: 0,
      data: { result: { sn: 1, ws: [{ cw: [{ w: "hello", sc: 0 }, { w: "hallo", sc: 1 }] }] } },
    });
    expect(extractIatSegment(payload)).toEqual({ sn: 1, text: "hello" });
  });

  it("非结果消息返回 null", () => {
    expect(extractIatSegment(JSON.stringify({ code: 0, data: { status: 2 } }))).toBeNull();
    expect(extractIatSegment("not json")).toBeNull();
    expect(extractIatSegment("")).toBeNull();
  });
});

describe("mergeIatSegments", () => {
  it("按 sn 排序拼接并去首尾空白", () => {
    const segs = new Map<number, string>([
      [2, "a coffee"],
      [1, "I'd like "],
    ]);
    expect(mergeIatSegments(segs)).toBe("I'd like a coffee");
  });

  it("后到覆盖先到（同 sn 修正）", () => {
    const segs = new Map<number, string>([[1, "I'd lick"]]);
    segs.set(1, "I'd like");
    expect(mergeIatSegments(segs)).toBe("I'd like");
  });

  it("空段返回空串", () => {
    expect(mergeIatSegments(new Map())).toBe("");
  });
});
