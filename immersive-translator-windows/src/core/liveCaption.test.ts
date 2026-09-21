import { describe, expect, it } from "vitest";
import {
  asrLanguageOf,
  buildCaptionMarkdown,
  buildCaptionPlainText,
  buildCaptionSystemPrompt,
  captionFileName,
  LiveSegmenter,
  targetLabelOf,
  type CaptionSegment,
} from "./liveCaption";

/** 一块 4096 样本（16k 下 256ms）。 */
function chunk(): Float32Array {
  return new Float32Array(4096).fill(0.05);
}

describe("LiveSegmenter", () => {
  it("静音段不缓冲也不成句", () => {
    const seg = new LiveSegmenter();
    for (let i = 0; i < 10; i++) expect(seg.push(chunk(), 0.001)).toBeNull();
    expect(seg.speaking).toBe(false);
  });

  it("轻声说话（电平低于旧固定阈值 0.012）也能起句", () => {
    const seg = new LiveSegmenter();
    // 先有环境底噪 0.001，再以 0.008 说话：旧固定阈值 0.012 下永远起不了句
    for (let i = 0; i < 6; i++) expect(seg.push(chunk(), 0.001)).toBeNull();
    expect(seg.speaking).toBe(false);
    // 50 块 ≈ 12.8s 会撞上 maxMs 正常收句，因此「在攒句」或「已收出整句」都算起句成功
    let out: Float32Array | null = null;
    let started = false;
    for (let i = 0; i < 50 && !out; i++) {
      out = seg.push(chunk(), 0.008);
      if (seg.speaking) started = true;
    }
    expect(started).toBe(true);
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
  });

  it("起声后静音超阈值收句", () => {
    const seg = new LiveSegmenter({ silenceMs: 500 });
    // 说 ~1 秒（4 块）有声
    for (let i = 0; i < 4; i++) expect(seg.push(chunk(), 0.08)).toBeNull();
    expect(seg.speaking).toBe(true);
    // 静音 750ms（3 块）后应收句
    let out: Float32Array | null = null;
    for (let i = 0; i < 3 && !out; i++) out = seg.push(chunk(), 0.001);
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
    // 收句后复位，可继续下一句
    expect(seg.speaking).toBe(false);
    expect(seg.push(chunk(), 0.08)).toBeNull();
  });

  it("超长强制断句（不带静音也收）", () => {
    const seg = new LiveSegmenter({ maxMs: 2000 });
    let out: Float32Array | null = null;
    for (let i = 0; i < 12 && !out; i++) out = seg.push(chunk(), 0.08); // 256ms × 12 ≈ 3s
    expect(out).not.toBeNull();
  });

  it("太短的杂音不成句：静音后不交出", () => {
    const seg = new LiveSegmenter({ minMs: 600, silenceMs: 300 });
    seg.push(chunk(), 0.08); // 只说 256ms（< minMs）
    let out: Float32Array | null = null;
    for (let i = 0; i < 4 && !out; i++) out = seg.push(chunk(), 0.001);
    // 起声时长不足 minMs，静音后缓冲被丢弃（flush 也拿不到）
    expect(seg.speaking).toBe(false);
    expect(seg.flush()).toBeNull();
  });

  it("flush 交出攒着的半句并复位", () => {
    const seg = new LiveSegmenter();
    seg.push(chunk(), 0.08);
    seg.push(chunk(), 0.08);
    const out = seg.flush();
    expect(out).not.toBeNull();
    expect(out!.length).toBe(8192);
    expect(seg.flush()).toBeNull();
  });

  it("非 16k 采样率按实际值计时长（48k 下同样块数时长缩为 1/3）", () => {
    const seg16k = new LiveSegmenter({ maxMs: 2000 });
    const seg48k = new LiveSegmenter({ maxMs: 2000 });
    let out16: Float32Array | null = null;
    let out48: Float32Array | null = null;
    // 8 块 × 4096 样本：16k 下 ≈ 2s（触发 maxMs），48k 下 ≈ 0.68s（不触发）
    for (let i = 0; i < 8; i++) {
      if (!out16) out16 = seg16k.push(chunk(), 0.08, 16000);
      if (!out48) out48 = seg48k.push(chunk(), 0.08, 48000);
    }
    expect(out16).not.toBeNull(); // 16k：约 2048ms ≥ maxMs 收句
    expect(out48).toBeNull(); // 48k：约 683ms 还没收
  });
});

describe("方向与提示词", () => {
  it("方向映射 ASR 语言与目标语言", () => {
    expect(asrLanguageOf("zh2en")).toBe("zh_cn");
    expect(asrLanguageOf("en2zh")).toBe("en_us");
    expect(targetLabelOf("zh2en")).toBe("英文");
    expect(targetLabelOf("en2zh")).toBe("简体中文");
  });

  it("系统提示包含目标语言与语音识别容错", () => {
    const sys = buildCaptionSystemPrompt("en2zh");
    expect(sys).toContain("简体中文");
    expect(sys).toContain("语音识别");
    expect(sys).toContain("只输出译文");
  });
});

describe("双语导出", () => {
  const segments: CaptionSegment[] = [
    { id: 1, source: "今天我们讲第三章。", target: "Today we'll cover chapter three.", state: "done", at: 1 },
    { id: 2, source: "有问题的同学请举手。", target: null, state: "failed", at: 2 },
    { id: 3, source: "  ", target: null, state: "done", at: 3 },
  ];
  const meta = { direction: "zh2en" as const, startedAt: new Date(2026, 8, 15, 10, 5).getTime(), endedAt: new Date(2026, 8, 15, 10, 16).getTime() };

  it("Markdown 双语对照：空句跳过、未译只有原文", () => {
    const md = buildCaptionMarkdown(segments, meta);
    expect(md).toContain("# 录音直译 · 2026-09-15 10:05");
    expect(md).toContain("方向：中 → 英 · 时长约 11 分钟 · 3 句");
    expect(md).toContain("- 今天我们讲第三章。");
    expect(md).toContain("  - Today we'll cover chapter three.");
    expect(md).toContain("- 有问题的同学请举手。");
    expect(md).not.toContain("-   ");
  });

  it("纯文本逐段空行分隔", () => {
    const txt = buildCaptionPlainText(segments, meta);
    expect(txt).toContain("今天我们讲第三章。\n\nToday we'll cover chapter three.");
    expect(txt.startsWith("录音直译（中 → 英）")).toBe(true);
  });

  it("文件名带日期时间与扩展名", () => {
    const name = captionFileName(new Date(2026, 8, 15, 10, 5).getTime());
    expect(name).toBe("录音直译-2026-09-15-1005.md");
    expect(captionFileName(0, "txt").endsWith(".txt")).toBe(true);
  });
});
