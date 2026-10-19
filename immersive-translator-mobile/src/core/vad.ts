/**
 * VAD（语音活动检测）双套状态机 —— 纯逻辑、无副作用，供批次二各屏复用。
 *
 * 套A LiveSegmenter：录音直译/听写的流式分句器（移植 mac ReaderCore/LiveCaption.swift:72-184）。
 * 套B ShadowVad：跟读评测的开说/收句判定（移植 mac ShadowAssessController.swift:52-251 的经验值与 handleLevel 逻辑）。
 *
 * 输入口径：16k 单声道 PCM16（Int16Array，services/audio.ts 产出）与平滑电平
 * （smoothed = 0.6*prev + 0.4*rms，MicRecorder.swift:226-232）。
 */

/* ===================== 套A：LiveSegmenter（流式分句） ===================== */

export interface SegmenterOptions {
  /** 起声电平绝对下限；实际阈值 = max(下限, 运行时底噪 × 2.8)，封顶 0.05。 */
  speechLevel: number;
  /** 收句静音时长（毫秒）。 */
  silenceMs: number;
  /** 最短成句时长（毫秒），太短的杂音不成句（整段丢弃）。 */
  minMs: number;
  /** 强制断句上限（毫秒）。 */
  maxMs: number;
}

/** mac LiveCaption.swift:74-98 默认值逐一照搬。 */
export const SEGMENTER_DEFAULTS: SegmenterOptions = {
  speechLevel: 0.005,
  silenceMs: 900,
  minMs: 600,
  maxMs: 12_000,
};

/** 起声阈值相对底噪的倍率与封顶（LiveCaption.swift:101-105）。 */
const SEGMENTER_SPEECH_FLOOR_RATIO = 2.8;
const SEGMENTER_SPEECH_LEVEL_CEILING = 0.05;

/**
 * 流式分句状态机：push(块, 电平, 采样率) → 收句时返回整句 PCM16（Int16Array），否则 null。
 * 静音段不缓冲；收句后缓冲清零（长录音内存不随时长增长）；
 * 说够 minMs 才成句，否则整段丢弃；flush() 交出攒着的半句。
 */
export class LiveSegmenter {
  private readonly opts: SegmenterOptions;
  private buffer: Int16Array[] = [];
  private bufferedSamples = 0;
  private started = false;
  private lastVoiceMs = 0;
  /** 本次起声的时刻（elapsedMs 口径）：minMs 比的是「说话时长」而非最后一声的绝对时刻。 */
  private speechStartMs = 0;
  private elapsedMs = 0;
  /** 运行时底噪估计（只降缓升）；null = 还没收到电平。 */
  private floor: number | null = null;

  constructor(options?: Partial<SegmenterOptions>) {
    this.opts = { ...SEGMENTER_DEFAULTS, ...options };
  }

  /** 是否正在攒一句（供 UI 显示「正在听」）。 */
  get speaking(): boolean {
    return this.started;
  }

  /** 当前起声阈值：max(绝对下限, 底噪 × 倍率)，封顶防阈值被说话电平顶飞。 */
  get speechLevel(): number {
    const f = this.floor ?? 0;
    return Math.min(SEGMENTER_SPEECH_LEVEL_CEILING, Math.max(this.opts.speechLevel, f * SEGMENTER_SPEECH_FLOOR_RATIO));
  }

  /** 推入一块 16k PCM16 与平滑电平；收句返回整句，否则 null。 */
  push(chunk: Int16Array, level: number, sampleRate = 16_000): Int16Array | null {
    this.elapsedMs += (chunk.length / sampleRate) * 1000;
    const threshold = this.speechLevel;
    if (level < threshold) {
      // 底噪只采信低于当前阈值的电平——说话块不抬高底噪
      this.floor = this.floor == null ? level : Math.min(level, this.floor * 1.05);
    }
    if (!this.started) {
      if (level < threshold) return null; // 静音段不缓冲
      this.started = true;
      this.speechStartMs = this.elapsedMs;
      this.lastVoiceMs = this.elapsedMs;
    }
    this.buffer.push(chunk);
    this.bufferedSamples += chunk.length;
    if (level >= threshold) {
      this.lastVoiceMs = this.elapsedMs;
    }
    if (this.elapsedMs - this.lastVoiceMs >= this.opts.silenceMs) {
      // 静音收句：说够最短「说话时长」才成句——比 lastVoiceMs 的绝对时刻才能拦住
      // 「录音已过 600ms 后的一声 128ms 杂音也成句」（此前杂音必成句并触发一次识别，治 algo-3）
      return this.lastVoiceMs - this.speechStartMs >= this.opts.minMs ? this.take() : this.reset();
    }
    if (this.elapsedMs >= this.opts.maxMs) {
      return this.take();
    }
    return null;
  }

  /** 主动收句（停止录音时把攒着的半句交出来）；没攒返回 null。 */
  flush(): Int16Array | null {
    return this.started ? this.take() : null;
  }

  /** 丢弃缓冲并复位（换会话/取消时调用）。 */
  reset(): Int16Array | null {
    this.buffer = [];
    this.bufferedSamples = 0;
    this.started = false;
    this.lastVoiceMs = 0;
    this.elapsedMs = 0;
    return null;
  }

  private take(): Int16Array | null {
    if (this.bufferedSamples <= 0) return this.reset();
    const out = new Int16Array(this.bufferedSamples);
    let off = 0;
    for (const c of this.buffer) {
      out.set(c, off);
      off += c.length;
    }
    this.reset();
    return out;
  }
}

/* ===================== 套B：ShadowVad（跟读评测） ===================== */

/** mac ShadowAssessController.swift:55-68 经验值逐一照搬。 */
export const SHADOW_VAD = {
  /** 开说阈值绝对下限。 */
  speechLevelMin: 0.006,
  /** 开说阈值封顶。 */
  speechLevelCeiling: 0.05,
  /** 静音判定电平绝对下限。 */
  silenceLevelMin: 0.003,
  /** 开说阈值 = 底噪 × 2.8。 */
  speechFloorRatio: 2.8,
  /** 静音阈值 = 底噪 × 1.6。 */
  silenceFloorRatio: 1.6,
  /** 默认静音收句时长（mac 端为可配置项，默认 1500）。 */
  silenceMs: 1500,
  /** 最短录音时长。 */
  minRecordMs: 700,
  /** 最长录音时长。 */
  maxRecordMs: 15_000,
  /** 一直没听到开说 → 提前收（提示检查麦克风）。 */
  noSpeechTimeoutMs: 8000,
  /** 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口。 */
  rescueAfterMs: 3500,
  rescueFloorRatio: 1.8,
  /** 过关后停留展示的时长，再自动进下一句（UI 计时常量）。 */
  passLingerMs: 650,
} as const;

export type ShadowVadDecision = "none" | "finished";

/**
 * 跟读评测 VAD：逐电平事件推进，返回是否收句（finished）。
 * 调用方结合 speaking 区分「说完收句」与「无语音超时」（!speaking && finished）。
 */
export class ShadowVad {
  /** 静音收句时长（毫秒），构造时可覆盖（mac 端由设置注入，默认 1500）。 */
  readonly silenceMs: number;
  private floor: number | null = null;
  private started = false;
  private lastVoiceAt = 0;

  constructor(silenceMs: number = SHADOW_VAD.silenceMs) {
    this.silenceMs = silenceMs;
  }

  /** 是否已判定开口（说完判定与无语音超时区分用）。 */
  get speaking(): boolean {
    return this.started;
  }

  /** 当前开说阈值：min(封顶, max(下限, 底噪 × 2.8))。 */
  get speechThreshold(): number {
    return Math.min(
      SHADOW_VAD.speechLevelCeiling,
      Math.max(SHADOW_VAD.speechLevelMin, (this.floor ?? 0) * SHADOW_VAD.speechFloorRatio),
    );
  }

  /** 当前静音阈值：max(绝对下限, 底噪 × 1.6)。 */
  get silenceThreshold(): number {
    return Math.max(SHADOW_VAD.silenceLevelMin, (this.floor ?? 0) * SHADOW_VAD.silenceFloorRatio);
  }

  /** 新一轮录音前复位（底噪估计一并清零）。 */
  reset(): void {
    this.floor = null;
    this.started = false;
    this.lastVoiceAt = 0;
  }

  /** 推入一次平滑电平与已录时长（毫秒）；返回收句决策（ShadowAssessController.handleLevel 口径）。 */
  push(level: number, elapsedMs: number): ShadowVadDecision {
    const speechLevel = this.speechThreshold;
    if (level < speechLevel) {
      // 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨
      this.floor = this.floor == null ? level : Math.min(level, this.floor * 1.05);
    }
    const silenceLevel = this.silenceThreshold;
    if (level >= speechLevel) {
      this.started = true;
      this.lastVoiceAt = elapsedMs;
    } else if (
      !this.started &&
      elapsedMs >= SHADOW_VAD.rescueAfterMs &&
      level >= (this.floor ?? 0) * SHADOW_VAD.rescueFloorRatio
    ) {
      // 超低电平麦克风：绝对阈值够不到，但持续高于底噪也算开口
      this.started = true;
      this.lastVoiceAt = elapsedMs;
    }
    if (!this.started && elapsedMs >= SHADOW_VAD.noSpeechTimeoutMs) {
      return "finished"; // 一直没听到开说 → 提前收（调用方提示检查麦克风）
    }
    if (
      this.started &&
      level < silenceLevel &&
      elapsedMs - this.lastVoiceAt >= this.silenceMs &&
      elapsedMs >= SHADOW_VAD.minRecordMs
    ) {
      return "finished";
    }
    if (elapsedMs >= SHADOW_VAD.maxRecordMs) {
      return "finished";
    }
    return "none";
  }
}
