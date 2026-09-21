/**
 * 跟读评测核心逻辑单测：ISE 结果 XML 解析、识别词→原文对齐、过关判定。
 * XML 样本截取自 spike 对讯飞语音评测的真实调测返回（结构一致，分数有改动以覆盖各档）。
 */

import { describe, expect, it } from "vitest";
import {
  buildIseAuthUrl,
  floatToPcm16,
  isPass,
  mapWordsToText,
  parseIseXml,
  type WordScore,
} from "./pronunciation";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xml_result>
  <read_sentence lan="en" type="study" version="7.0.0.1020">
    <rec_paper>
      <read_chapter accuracy_score="4.959870" fluency_score="5.000000" integrity_score="5.000000" is_rejected="false" except_info="0" standard_score="5.000000" total_score="4.975922" word_count="9">
        <sentence accuracy_score="4.709870" fluency_score="4.837811" index="0" standard_score="4.940472" total_score="4.771313" word_count="9">
          <word beg_pos="1" content="the" dp_message="0" total_score="5.000000">
            <syll content="dh ax" syll_score="4.994185" serr_msg="0">
              <phone content="dh" dp_message="0" gwpp="-0.002308"></phone>
              <phone content="ax" dp_message="0" gwpp="-0.000020"></phone>
            </syll>
          </word>
          <word beg_pos="20" content="quick" dp_message="0" total_score="4.789420">
            <syll content="k w ih k" syll_score="4.081688" serr_msg="0">
              <phone content="k" dp_message="0" gwpp="-0.000025"></phone>
              <phone content="ih" dp_message="0" gwpp="-1.304340"></phone>
            </syll>
          </word>
          <word content="brown" dp_message="16" total_score="0.000000"/>
          <word content="uh" dp_message="32" total_score="0.000000"/>
          <word content="fox" dp_message="0" total_score="2.500000"/>
          <word content="jumps" dp_message="0" total_score="3.500000"/>
          <word content="over" dp_message="0" total_score="5.000000"/>
          <word content="the" dp_message="0" total_score="5.000000"/>
          <word content="lazy" dp_message="0" total_score="4.975247"/>
          <word content="dog" dp_message="0" total_score="4.740376"/>
        </sentence>
      </read_chapter>
    </rec_paper>
  </read_sentence>
</xml_result>`;

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog.";

function w(content: string, totalScore: number, dpMessage = 0): WordScore {
  return { content, totalScore, dpMessage, sylls: [] };
}

describe("parseIseXml", () => {
  it("解析句级四项分数与乱读标记", () => {
    const r = parseIseXml(SAMPLE_XML);
    expect(r.total).toBeCloseTo(4.771313, 5);
    expect(r.accuracy).toBeCloseTo(4.70987, 5);
    expect(r.fluency).toBeCloseTo(4.837811, 5);
    expect(r.standard).toBeCloseTo(4.940472, 5);
    expect(r.isRejected).toBe(false);
    expect(r.exceptInfo).toBeNull();
  });

  it("解析词/音节/音素层级（含自闭合漏读词与增读词）", () => {
    const r = parseIseXml(SAMPLE_XML);
    // 9 个正常/漏读词 + 1 个增读词
    expect(r.words).toHaveLength(10);
    expect(r.words[0].content).toBe("the");
    expect(r.words[0].sylls).toHaveLength(1);
    expect(r.words[0].sylls[0].phones.map((p) => p.content)).toEqual(["dh", "ax"]);
    expect(r.words[0].sylls[0].phones[1].gwpp).toBeCloseTo(-0.00002, 8);
    // 自闭合的漏读词（dp=16）也能解析
    const brown = r.words.find((x) => x.content === "brown");
    expect(brown?.dpMessage).toBe(16);
    expect(brown?.totalScore).toBe(0);
  });

  it("无语音异常（except_info 28673）会透出且判不过关", () => {
    const xml = SAMPLE_XML.replace('except_info="0"', 'except_info="28673"');
    const r = parseIseXml(xml);
    expect(r.exceptInfo).toBe("28673");
    expect(isPass(r, 4.2)).toBe(false);
  });
});

describe("mapWordsToText", () => {
  it("按词序对齐到字符区间，覆盖四档着色", () => {
    const r = parseIseXml(SAMPLE_XML);
    const marks = mapWordsToText(SAMPLE_TEXT, r.words);
    // 增读词（uh, dp=32）不着色：9 个词 9 个标记
    expect(marks).toHaveLength(9);
    const byStart = new Map(marks.map((m) => [m.start, m]));
    // The quick brown fox jumps over the lazy dog.
    // 0-3  4-9  10-15 16-19 20-25 26-30 31-34 35-39 40-43
    expect(byStart.get(0)?.quality).toBe("good"); // the 5.0
    expect(byStart.get(4)?.quality).toBe("good"); // quick 4.79
    expect(byStart.get(10)?.quality).toBe("missed"); // brown dp=16
    expect(byStart.get(16)?.quality).toBe("bad"); // fox 2.5
    expect(byStart.get(20)?.quality).toBe("ok"); // jumps 3.5
    expect(byStart.get(40)?.end).toBe(43); // dog.
    // 标记按位置升序
    const starts = marks.map((m) => m.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("大小写不敏感对齐；对不上的识别词跳过", () => {
    const marks = mapWordsToText("Don't stop.", [w("don't", 5), w("thinking", 4.5), w("stop", 4.8)]);
    // "thinking" 原文没有 → 跳过；don't/stop 对齐
    expect(marks).toHaveLength(2);
    expect(marks[0].start).toBe(0);
    expect(marks[0].end).toBe(5); // Don't
    expect(marks[1].start).toBe(6);
  });

  it("dp=128（读成别的词）按分数着色，不再标成漏读底纹", () => {
    const marks = mapWordsToText("The quick brown fox.", [
      w("the", 3.2, 128),
      w("quick", 4.5),
      w("brown", 2.0, 128),
    ]);
    const byStart = new Map(marks.map((mm) => [mm.start, mm]));
    expect(byStart.get(0)?.quality).toBe("ok"); // 3.2 → ok（读错但读了）
    expect(byStart.get(10)?.quality).toBe("bad"); // 2.0 → bad
    expect(marks.every((mm) => mm.quality !== "missed")).toBe(true);
  });

  it("重复词按保序最优对齐：漏读的第一个 the 落在第一位，不错位", () => {
    //              the  to   the  that
    const marks = mapWordsToText("the to the that", [
      w("the", 0, 16), // 漏读第一个 the
      w("to", 4.6),
      w("the", 4.8),
      w("that", 4.7),
    ]);
    expect(marks.map((mm) => mm.start)).toEqual([0, 4, 7, 11]);
    expect(marks[0].quality).toBe("missed");
    expect(marks[1].quality).toBe("good");
  });
});

describe("isPass", () => {
  const base = { total: 4.5, accuracy: 4, fluency: 4, standard: 4, isRejected: false, exceptInfo: null, words: [] };
  it("达到阈值且未乱读 → 过", () => {
    expect(isPass({ ...base }, 4.2)).toBe(true);
    expect(isPass({ ...base, total: 4.2 }, 4.2)).toBe(true);
  });
  it("低于阈值 / 乱读 / 无语音 → 不过", () => {
    expect(isPass({ ...base, total: 4.19 }, 4.2)).toBe(false);
    expect(isPass({ ...base, isRejected: true }, 4.2)).toBe(false);
    expect(isPass({ ...base, exceptInfo: "28673" }, 4.2)).toBe(false);
  });
});

describe("buildIseAuthUrl / floatToPcm16", () => {
  it("生成带签名 query 的 wss 地址", async () => {
    const url = await buildIseAuthUrl({ appId: "app", apiKey: "key", apiSecret: "secret" });
    expect(url.startsWith("wss://ise-api.xfyun.cn/v2/open-ise?")).toBe(true);
    expect(url).toContain("authorization=");
    expect(url).toContain("date=");
    expect(url).toContain("host=ise-api.xfyun.cn");
  });

  it("Float32 → Int16 饱和转换", () => {
    const pcm = floatToPcm16(new Float32Array([1, -1, 0, 0.5, 2]));
    expect([...pcm]).toEqual([32767, -32768, 0, 16384, 32767]);
  });
});
