/**
 * 录音直译（R4）的纯逻辑层：VAD 分句器 + 字幕段模型 + 双语导出。
 *
 * 分句器把连续麦克风流切成一句一句：电平起声开攒、静音超过阈值收句，
 * 超长强制断句（IAT 单句上限 60s，这里 12s 更接近口语换气）。
 * 收句即交出缓冲并复位 —— 长录音内存不随时长增长。
 */

/** 一个字幕段：一句原文（ASR）+ 译文（LLM）。 */
export interface CaptionSegment {
  id: number;
  /** ASR 原文。 */
  source: string;
  /** 译文；未完成为 null。 */
  target: string | null;
  state: "transcribing" | "translating" | "done" | "failed";
  at: number;
}

/** 方向：中→英 / 英→中。 */
export type CaptionDirection = "zh2en" | "en2zh";

export function asrLanguageOf(direction: CaptionDirection): "zh_cn" | "en_us" {
  return direction === "zh2en" ? "zh_cn" : "en_us";
}

export function targetLabelOf(direction: CaptionDirection): string {
  return direction === "zh2en" ? "英文" : "简体中文";
}

/** 字幕翻译的系统提示（句级、只出译文、容忍 ASR 错词）。 */
export function buildCaptionSystemPrompt(direction: CaptionDirection): string {
  const target = targetLabelOf(direction);
  return [
    `你是同声传译引擎。把用户消息里的原句翻译成${target}。`,
    "规则：只输出译文，不要解释；保留数字、专名与语气；",
    "原句来自语音识别，可能有错词或没有标点，按上下文合理理解与断句；",
    "句子不完整时也照翻已说出的部分。",
  ].join("");
}

// ---------- VAD 分句器 ----------

export interface SegmenterOptions {
  /** 起声电平绝对下限；实际阈值 = max(下限, 运行时底噪 × 2.8)，
   * 轻声/低灵敏麦克风靠底噪自适应起句，不再卡死在固定电平上。 */
  speechLevel?: number;
  /** 静音判定电平绝对下限；实际阈值 = max(下限, 底噪 × 1.6)。 */
  silenceLevel?: number;
  /** 收句静音时长（毫秒）。 */
  silenceMs?: number;
  /** 最短成句时长（毫秒），太短的杂音不成句。 */
  minMs?: number;
  /** 强制断句上限（毫秒）。 */
  maxMs?: number;
}

const DEFAULTS = {
  speechLevel: 0.005,
  silenceLevel: 0.0025,
  silenceMs: 900,
  minMs: 600,
  maxMs: 12000,
};

/** 起声阈值相对底噪的倍率与封顶（与跟读评测的 VAD 同一套经验值）。
 * 底噪只采信低于当前阈值的电平——说话块不抬高底噪，阈值不会追着人声涨；
 * 封顶保证一开口就是说话（前面没有静音块）时也能立刻起句。
 * 静音收句走「距上次出声的时长」，不依赖电平阈值（silenceLevel 仅作历史选项保留）。 */
const SPEECH_FLOOR_RATIO = 2.8;
const SPEECH_LEVEL_CEILING = 0.05;

/**
 * 流式分句状态机：push(块, 电平, 采样率) → 收句时返回整句 PCM，否则 null。
 * 静音段不缓冲；收句后缓冲清零。块按实际采样率计时长（非 16k 设备断句不失真）。
 */
export class LiveSegmenter {
  private readonly opts: Required<SegmenterOptions>;
  private buffer: Float32Array[] = [];
  private bufferedSamples = 0;
  private started = false;
  private lastVoiceMs = 0;
  private elapsedMs = 0;
  /** 运行时底噪估计（快速下探、缓慢上浮）；null = 还没收到电平。 */
  private floor: number | null = null;

  constructor(options: SegmenterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** 是否正在攒一句（供 UI 显示「正在听」）。 */
  get speaking(): boolean {
    return this.started;
  }

  /** 当前起声阈值：max(绝对下限, 底噪 × 倍率)，封顶防阈值被说话电平顶飞。 */
  private speechLevel(): number {
    const floor = this.floor ?? 0;
    return Math.min(SPEECH_LEVEL_CEILING, Math.max(this.opts.speechLevel, floor * SPEECH_FLOOR_RATIO));
  }

  push(chunk: Float32Array, level: number, sampleRate = 16000): Float32Array | null {
    this.elapsedMs += (chunk.length / sampleRate) * 1000;
    const speechLevel = this.speechLevel();
    if (level < speechLevel) {
      // 底噪估计：快速下探、缓慢上浮，只采信低于阈值的电平。
      this.floor = this.floor === null ? level : Math.min(level, this.floor * 1.05);
    }
    if (!this.started) {
      if (level < speechLevel) return null; // 静音段不缓冲
      this.started = true;
      this.lastVoiceMs = this.elapsedMs;
    }
    this.buffer.push(chunk);
    this.bufferedSamples += chunk.length;
    if (level >= speechLevel) this.lastVoiceMs = this.elapsedMs;

    if (this.elapsedMs - this.lastVoiceMs >= this.opts.silenceMs) {
      // 静音收句：说够最短时长才成句，太短的杂音丢弃
      return this.lastVoiceMs >= this.opts.minMs ? this.take() : this.reset();
    }    if (this.elapsedMs >= this.opts.maxMs) {
      return this.take();
    }
    return null;
  }

  /** 主动收句（停止录音时把攒着的半句交出来）；没攒返回 null。 */
  flush(): Float32Array | null {
    if (!this.started) return null;
    return this.take();
  }

  private reset(): null {
    this.buffer = [];
    this.bufferedSamples = 0;
    this.started = false;
    this.lastVoiceMs = 0;
    this.elapsedMs = 0;
    return null;
  }

  private take(): Float32Array | null {
    if (this.bufferedSamples === 0) return this.reset();
    const out = new Float32Array(this.bufferedSamples);
    let off = 0;
    for (const c of this.buffer) {
      out.set(c, off);
      off += c.length;
    }
    this.reset();
    return out;
  }
}

// ---------- 双语导出 ----------

export interface CaptionExportMeta {
  direction: CaptionDirection;
  startedAt: number;
  endedAt: number;
}

function directionLine(direction: CaptionDirection): string {
  return direction === "zh2en" ? "中 → 英" : "英 → 中";
}

export function captionFileName(now = Date.now(), ext: "md" | "txt" = "md"): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `录音直译-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/** 双语对照 Markdown：一句原文 + 缩进译文。 */
export function buildCaptionMarkdown(segments: CaptionSegment[], meta: CaptionExportMeta): string {
  const start = new Date(meta.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}:${p(start.getMinutes())}`;
  const mins = Math.max(1, Math.round((meta.endedAt - meta.startedAt) / 60000));
  const lines: string[] = [
    `# 录音直译 · ${time}`,
    "",
    `方向：${directionLine(meta.direction)} · 时长约 ${mins} 分钟 · ${segments.length} 句`,
    "",
  ];
  for (const seg of segments) {
    if (!seg.source.trim()) continue;
    lines.push(`- ${seg.source.trim()}`);
    if (seg.target?.trim()) lines.push(`  - ${seg.target.trim()}`);
  }
  return lines.join("\n") + "\n";
}

/** 双语对照纯文本：原文一行、译文一行、空行分隔。 */
export function buildCaptionPlainText(segments: CaptionSegment[], meta: CaptionExportMeta): string {
  const blocks: string[] = [`录音直译（${directionLine(meta.direction)}）`];
  for (const seg of segments) {
    if (!seg.source.trim()) continue;
    blocks.push(seg.source.trim());
    if (seg.target?.trim()) blocks.push(seg.target.trim());
  }
  return blocks.join("\n\n") + "\n";
}
