/**
 * 静音检测（VAD）纯内核：从 useShadowAssess 的 onLevel 内联逻辑逐行等价抽出
 * （v0.8），供跟读评测与口语免长按开麦共用。
 *
 * 设计（沿用跟读评测的经验值，语义不变）：
 * - 开说/静音阈值不写死绝对电平——轻声说话或低灵敏麦克风的绝对电平可能永远
 *   够不到固定线，这里按「运行时估计的底噪 × 信噪比倍率」自适应，绝对下限
 *   兜住极安静房间的噪声毛刺，封顶保证开口即说话（前面没有静音样本）时阈值
 *   不会被顶飞。
 * - 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
 * - 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口（超低电平
 *   麦克风）；一直没听到开说 → 8s 提前收（提示检查麦克风）。
 *
 * 无计时器、无状态订阅：调用方把 micRecorder 的 { level, elapsedMs } 喂进
 * feed()，判定到断句时机时回调 onAutoStop。纯逻辑，单测友好。
 */

/** 开说阈值 = clamp(底噪 × 2.8, 绝对下限, 封顶)；静音判定 = max(下限, 底噪 × 1.6)。 */
export const SPEECH_LEVEL_MIN = 0.006;
export const SPEECH_LEVEL_CEILING = 0.05;
export const SILENCE_LEVEL_MIN = 0.003;
export const SPEECH_FLOOR_RATIO = 2.8;
export const SILENCE_FLOOR_RATIO = 1.6;
/** 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口（超低电平麦克风）。 */
export const RESCUE_AFTER_MS = 3500;
export const RESCUE_FLOOR_RATIO = 1.8;
/** 一直没听到开说 → 提前收（原来干等满 15s 才停），提示检查麦克风。 */
export const NO_SPEECH_TIMEOUT_MS = 8000;
/** 静音断句最短录音时长：太短的片段直接判静音没有意义。 */
export const MIN_RECORD_MS = 700;
/** 单次录音上限。 */
export const MAX_RECORD_MS = 15000;

/** onAutoStop 的触发原因。 */
export type VadStopReason = "silence" | "noSpeech" | "maxDuration";

export interface VadDetectorOptions {
  /** 开麦那一刻取定的静音断句时长（录音中途改设置不打断本次）。 */
  silenceMs: number;
  /** 静音断句最短录音时长（默认 700ms）。 */
  minRecordMs?: number;
  /** 单次录音上限（默认 15000ms）。 */
  maxRecordMs?: number;
  /** 判定「开口说话」的瞬间回调（false→true 跳变，含救援线判定）。 */
  onSpeechStart?: () => void;
  /** 自动收麦：静音断句 / 一直没开说 / 超时长。一次检测生命周期至多一次。 */
  onAutoStop?: (reason: VadStopReason) => void;
}

export interface VadDetector {
  /** 喂入 micRecorder 的电平事件（level 0–1，elapsedMs 已录毫秒）。 */
  feed(level: number, elapsedMs: number): void;
  /** 是否已判定开口。 */
  readonly started: boolean;
  /** 运行时底噪估计（null = 还没收到电平）。 */
  readonly floor: number | null;
  /** 复位（新一轮录音前调用，语义同 useShadowAssess 里重置 vadRef）。 */
  reset(): void;
}

/** 创建一次录音会话的 VAD 检测器。 */
export function createVadDetector(opts: VadDetectorOptions): VadDetector {
  const minRecordMs = opts.minRecordMs ?? MIN_RECORD_MS;
  const maxRecordMs = opts.maxRecordMs ?? MAX_RECORD_MS;
  let started = false;
  let lastVoiceAt = 0;
  let floor: number | null = null;
  let stopped = false;

  const markStarted = (elapsedMs: number) => {
    if (started) return;
    started = true;
    lastVoiceAt = elapsedMs;
    opts.onSpeechStart?.();
  };

  return {
    get started() {
      return started;
    },
    get floor() {
      return floor;
    },
    reset() {
      started = false;
      lastVoiceAt = 0;
      floor = null;
      stopped = false;
    },
    feed(level: number, elapsedMs: number) {
      if (stopped) return;
      const speechLevel = Math.min(
        SPEECH_LEVEL_CEILING,
        Math.max(SPEECH_LEVEL_MIN, (floor ?? 0) * SPEECH_FLOOR_RATIO),
      );
      if (level < speechLevel) {
        // 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
        floor = floor === null ? level : Math.min(level, floor * 1.05);
      }
      const silenceLevel = Math.max(SILENCE_LEVEL_MIN, (floor ?? 0) * SILENCE_FLOOR_RATIO);
      if (level >= speechLevel) {
        markStarted(elapsedMs);
        lastVoiceAt = elapsedMs;
      } else if (
        !started &&
        elapsedMs >= RESCUE_AFTER_MS &&
        level >= (floor ?? 0) * RESCUE_FLOOR_RATIO
      ) {
        // 超低电平麦克风：绝对阈值够不到，但持续高于底噪也算开口。
        markStarted(elapsedMs);
      }
      if (!started && elapsedMs >= NO_SPEECH_TIMEOUT_MS) {
        // 一直没等到开说：提前收，别让用户干等满 15s。
        stopped = true;
        opts.onAutoStop?.("noSpeech");
        return;
      }
      if (
        started &&
        level < silenceLevel &&
        elapsedMs - lastVoiceAt >= opts.silenceMs &&
        elapsedMs >= minRecordMs
      ) {
        stopped = true;
        opts.onAutoStop?.("silence");
      } else if (elapsedMs >= maxRecordMs) {
        stopped = true;
        opts.onAutoStop?.("maxDuration");
      }
    },
  };
}
