/**
 * vad 纯内核单测：与 useShadowAssess 抽取前 onLevel 内联逻辑逐条等价
 * （底噪自适应 / 开说阈值 clamp / 静音断句 / 3.5s 救援线 / 8s 无话提前收 /
 * 15s 上限），表驱动喂 { level, elapsedMs } 序列断言回调时机。
 */
import { describe, expect, it, vi } from "vitest";
import { createVadDetector } from "./vad";

interface Step {
  level: number;
  elapsedMs: number;
}

function run(steps: Step[], silenceMs = 1500) {
  const onSpeechStart = vi.fn();
  const stops: string[] = [];
  const det = createVadDetector({
    silenceMs,
    onSpeechStart,
    onAutoStop: (reason) => stops.push(reason),
  });
  for (const s of steps) det.feed(s.level, s.elapsedMs);
  return { det, stops, speechStarts: onSpeechStart.mock.calls.length };
}

describe("底噪自适应（说话块不抬底噪）", () => {
  it("低于阈值的电平才进底噪估计；说话电平不抬高 floor", () => {
    const { det } = run([
      { level: 0.004, elapsedMs: 100 }, // 静音：floor=0.004
      { level: 0.3, elapsedMs: 600 }, // 说话：floor 不动
      { level: 0.3, elapsedMs: 900 },
    ]);
    expect(det.started).toBe(true);
    expect(det.floor).toBe(0.004);
  });

  it("底噪只降不升（×1.05 容差内取小）", () => {
    const { det } = run([
      { level: 0.005, elapsedMs: 100 }, // floor=0.005
      { level: 0.0051, elapsedMs: 200 }, // < speechLevel(0.014)：floor=min(0.0051, 0.00525)=0.0051
    ]);
    expect(det.floor).toBeCloseTo(0.0051, 6);
  });
});

describe("开说阈值 clamp", () => {
  it("极安静房间有绝对下限：floor 极低时低于 0.006 不算开说", () => {
    const { det } = run([
      { level: 0.0005, elapsedMs: 100 }, // floor=0.0005，speechLevel=max(0.006, 0.0014)=0.006
      { level: 0.0058, elapsedMs: 2000 }, // 高于 floor×2.8 但低于绝对下限
    ]);
    expect(det.started).toBe(false);
  });

  it("开口即说话（无静音样本）时封顶 0.05：0.06 直接算开说", () => {
    const { det } = run([{ level: 0.06, elapsedMs: 120 }]);
    expect(det.started).toBe(true);
  });
});

describe("静音 silenceMs 断句", () => {
  it("开说后静音满 silenceMs 且超过最短时长 → 自动收（silence）", () => {
    const { stops } = run(
      [
        { level: 0.2, elapsedMs: 800 }, // 开说
        { level: 0.0, elapsedMs: 900 },
        { level: 0.0, elapsedMs: 2300 }, // 静音 1500ms、总长 2300 ≥ 700
        { level: 0.0, elapsedMs: 3000 },
      ],
      1500,
    );
    expect(stops).toEqual(["silence"]); // 只触发一次
  });

  it("静音不足 silenceMs 不收；最短时长不足也不收", () => {
    const a = run([{ level: 0.2, elapsedMs: 200 }, { level: 0.0, elapsedMs: 1200 }], 1500);
    expect(a.stops).toEqual([]); // 静音 1000 < 1500
    const b = run([{ level: 0.2, elapsedMs: 100 }, { level: 0.0, elapsedMs: 600 }], 400);
    expect(b.stops).toEqual([]); // 静音 500 ≥ 400 但总长 600 < 700（minRecordMs）
  });
});

describe("3.5s 救援线（超低电平麦克风）", () => {
  it("绝对阈值够不到但持续高于底噪 1.8× 也算开口", () => {
    const { det, speechStarts } = run([
      { level: 0.004, elapsedMs: 100 }, // floor=0.004；speechLevel=0.0112
      { level: 0.009, elapsedMs: 3600 }, // 0.009 < 0.0112，但 ≥ 0.004×1.8=0.0072 且 ≥3500ms
    ]);
    expect(det.started).toBe(true);
    expect(speechStarts).toBe(1);
    // 救援开说后同样吃静音断句
    const after = run(
      [
        { level: 0.004, elapsedMs: 100 },
        { level: 0.009, elapsedMs: 3600 },
        { level: 0.0, elapsedMs: 5201 }, // 静音 1601 ≥ 1500
      ],
      1500,
    );
    expect(after.stops).toEqual(["silence"]);
  });

  it("3.5s 前高于底噪 1.8× 不触发救援", () => {
    const { det } = run([
      { level: 0.004, elapsedMs: 100 },
      { level: 0.009, elapsedMs: 3400 },
    ]);
    expect(det.started).toBe(false);
  });
});

describe("8s 无话提前收 与 15s 上限", () => {
  it("一直没开说 → 8000ms 提前收（noSpeech）", () => {
    const { stops } = run([
      { level: 0.004, elapsedMs: 1000 },
      { level: 0.004, elapsedMs: 7999 },
      { level: 0.004, elapsedMs: 8000 },
    ]);
    expect(stops).toEqual(["noSpeech"]);
  });

  it("一直说话 → 15000ms 上限收（maxDuration）", () => {
    const steps: Step[] = [];
    for (let t = 0; t <= 15000; t += 500) steps.push({ level: 0.3, elapsedMs: t });
    const { stops } = run(steps);
    expect(stops).toEqual(["maxDuration"]);
  });

  it("收过一次后不再触发（等价旧实现里 recorderRef 置空的早退）", () => {
    const { stops } = run([
      { level: 0.2, elapsedMs: 800 },
      { level: 0.0, elapsedMs: 2300 },
      { level: 0.0, elapsedMs: 9000 }, // 已收过：不再发 noSpeech
      { level: 0.0, elapsedMs: 15000 }, // 也不再发 maxDuration
    ]);
    expect(stops).toEqual(["silence"]);
  });
});

describe("reset", () => {
  it("复位后底噪/开说状态清零，可开始新一轮", () => {
    const onAutoStop = vi.fn();
    const det = createVadDetector({ silenceMs: 1500, onAutoStop });
    det.feed(0.2, 800);
    det.feed(0.0, 2300);
    expect(onAutoStop).toHaveBeenCalledOnce();
    det.reset();
    expect(det.started).toBe(false);
    expect(det.floor).toBeNull();
    det.feed(0.2, 100);
    expect(det.started).toBe(true);
  });
});
