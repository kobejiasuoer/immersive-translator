/**
 * 音频采集管线（services/audio.ts）—— 16k 单声道 PCM16 采集，批次二全部语音屏消费。
 *
 * 链路：getUserMedia({channelCount:1, echoCancellation:true}) → AudioContext（尝试 16k，
 * 实际非 16k 时处理器内线性重采样）→ AudioWorklet（Blob URL addModule，失败降级
 * ScriptProcessorNode）内 Float32→Int16LE（负 ×32768 / 正 ×32767 / clamp，
 * mac XfyunIse.swift:117-125 口径）+ 逐块 RMS → 平滑 smoothed = 0.6*prev + 0.4*rms
 * （MicRecorder.swift:226-232 口径）。
 *
 * chunk ≈2048 样本（128ms@16k）以 base64 交付；stop() 返回整段 {pcmB64, peak, ms}。
 * 15s 录音上限由调用方控制（跟读/听写各自超时口径不同）。
 * 拒绝授权 → 返回 null，由调用方显示真实拒权态或文字输入。
 */
import { invoke } from "./device";

export interface CaptureOpts {
  /** 平滑电平回调（0..1，约每 128ms 一次）。 */
  onLevel?: (level: number) => void;
  /** PCM16LE/16k/单声道分块回调（base64，≈2048 样本/块）。 */
  onChunk?: (pcmB64: string) => void;
}

export interface CaptureStopResult {
  /** 整段录音 PCM16LE base64（16k 单声道）。 */
  pcmB64: string;
  /** 全段峰值（0..1）。 */
  peak: number;
  /** 时长（毫秒）。 */
  ms: number;
}

export interface Capture {
  stop: () => Promise<CaptureStopResult>;
  cancel: () => void;
}

/** 目标采样率（讯飞 IAT/ISE 口径）。 */
const TARGET_RATE = 16_000;
/** 每块样本数（≈128ms@16k）。 */
const CHUNK_SAMPLES = 2048;

/* ---------- base64 / PCM 工具（主线程与降级路径共用） ---------- */

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  }
  return btoa(bin);
}

export function pcm16ToB64(pcm: Int16Array): string {
  return bytesToB64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** Float32 [-1,1] → Int16（小端；负 ×32768 / 正 ×32767 / clamp，XfyunIse.swift:117-125）。 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    out[i] = c < 0 ? c * 32768 : c * 32767;
  }
  return out;
}

/* ---------- AudioWorklet 处理器源码（Blob URL 注入） ---------- */

const WORKLET_SRC = `
class ItaPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = ${TARGET_RATE};
    this.ratio = sampleRate / this.targetRate; // 输入/输出采样率比
    this.carry = new Float32Array(0);          // 重采样跨块残留
    this.pos = 0;                              // 残留内分数读位置
    this.chunk = new Float32Array(${CHUNK_SAMPLES});
    this.chunkLen = 0;
    this.smoothed = 0;
    this.peak = 0;
    this.finished = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') {
        if (!this.finished) {
          const tail = [];
          for (let p = this.pos; p < this.carry.length; p += this.ratio) {
            const i = p | 0, frac = p - i;
            tail.push(this.carry[i] * (1 - frac) + this.carry[Math.min(i + 1, this.carry.length - 1)] * frac);
          }
          this.accumulate(tail);
          this.carry = new Float32Array(0);
          if (this.chunkLen > 0) { this.emit(this.chunk.slice(0,this.chunkLen)); this.chunkLen = 0; }
          this.finished = true;
        }
        // 排空尾部不足一整块的采样后再回执
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    if (this.finished) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // 拼接待重采样缓冲
    const buf = new Float32Array(this.carry.length + ch.length);
    buf.set(this.carry, 0);
    buf.set(ch, this.carry.length);
    // 线性插值重采样到 16k（分数位置跨块保持，无接缝）
    const out = [];
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = p | 0;
      const frac = p - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      p += this.ratio;
    }
    // 下采样可能越过本块末尾；保留越过的相位，不能把下一块从 0 重启。
    const consumed = Math.min(p | 0, buf.length);
    this.carry = buf.slice(consumed);
    this.pos = p - consumed;
    this.accumulate(out);
    return true;
  }
  accumulate(out) {
    // 累积成 CHUNK_SAMPLES 块
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      const abs = s < 0 ? -s : s;
      if (abs > this.peak) this.peak = abs;
      this.chunk[this.chunkLen++] = s;
      if (this.chunkLen === this.chunk.length) {
        this.emit(this.chunk);
        this.chunk = new Float32Array(this.chunk.length);
        this.chunkLen = 0;
      }
    }
  }
  emit(f32) {
    // 逐块 RMS → 平滑（MicRecorder.swift:226-232：smoothed = 0.6*prev + 0.4*rms）
    let sumSq = 0;
    for (let i = 0; i < f32.length; i++) sumSq += f32[i] * f32[i];
    const rms = Math.sqrt(sumSq / f32.length);
    this.smoothed = this.smoothed * 0.6 + rms * 0.4;
    const i16 = floatToI16(f32);
    this.port.postMessage(
      { type: 'chunk', pcm: i16, level: this.smoothed, peak: this.peak },
      [i16.buffer]
    );
  }
}
function floatToI16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const c = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = c < 0 ? c * 32768 : c * 32767;
  }
  return i16;
}
registerProcessor('ita-pcm-capture', ItaPcmCaptureProcessor);
`;

/* ---------- 主线程共享状态与降级处理 ---------- */

interface CaptureState {
  chunks: Int16Array[];
  totalSamples: number;
  peak: number;
  smoothed: number;
  onLevel?: (l: number) => void;
  onChunk?: (b64: string) => void;
}

/** ScriptProcessor 降级路径的主线程块处理（重采样 + 分块 + RMS 平滑，与 worklet 同口径）。 */
function makeFallbackBlockHandler(state: CaptureState, ctxRate: number) {
  const ratio = ctxRate / TARGET_RATE;
  let carry = new Float32Array(0);
  let pos = 0;
  let chunk = new Float32Array(CHUNK_SAMPLES);
  let chunkLen = 0;
  let finished = false;
  const accumulate = (samples: number[]) => {
    for (const s of samples) {
      const abs = Math.abs(s);
      if (abs > state.peak) state.peak = abs;
      chunk[chunkLen++] = s;
      if (chunkLen === chunk.length) {
        deliverChunk(state, chunk, () => {
          chunk = new Float32Array(CHUNK_SAMPLES);
          chunkLen = 0;
        });
      }
    }
  };
  const handle = (ch: Float32Array) => {
    if (finished) return;
    const buf = new Float32Array(carry.length + ch.length);
    buf.set(carry, 0);
    buf.set(ch, carry.length);
    const out: number[] = [];
    let p = pos;
    while (p + 1 < buf.length) {
      const i = p | 0;
      const frac = p - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      p += ratio;
    }
    const consumed = Math.min(p | 0, buf.length);
    carry = buf.slice(consumed);
    pos = p - consumed;
    accumulate(out);
  };
  return { process: handle, flush() {
    if (finished) return;
    const tail: number[] = [];
    for (let p = pos; p < carry.length; p += ratio) {
      const i = p | 0, frac = p - i;
      tail.push(carry[i] * (1 - frac) + carry[Math.min(i + 1, carry.length - 1)] * frac);
    }
    accumulate(tail); carry = new Float32Array(0);
    if (chunkLen > 0) deliverChunk(state, chunk.slice(0, chunkLen), () => { chunkLen = 0; });
    finished = true;
  } };
}

/** 交付一块：RMS 平滑 + Int16 转换 + 回调（两路径共用）。 */
function deliverChunk(state: CaptureState, f32: Float32Array, after: () => void) {
  let sumSq = 0;
  for (let i = 0; i < f32.length; i++) sumSq += f32[i] * f32[i];
  const rms = Math.sqrt(sumSq / f32.length);
  state.smoothed = state.smoothed * 0.6 + rms * 0.4;
  const i16 = floatToPcm16(f32);
  state.chunks.push(i16);
  state.totalSamples += i16.length;
  state.onLevel?.(state.smoothed);
  state.onChunk?.(pcm16ToB64(i16));
  after();
}

/** 拼装整段结果。 */
function assemble(state: CaptureState): CaptureStopResult {
  const all = new Int16Array(state.totalSamples);
  let off = 0;
  for (const c of state.chunks) {
    all.set(c, off);
    off += c.length;
  }
  return {
    pcmB64: pcm16ToB64(all),
    peak: Math.min(1, state.peak),
    ms: Math.round((state.totalSamples / TARGET_RATE) * 1000),
  };
}

/**
 * 开始采集。拒绝授权/无麦克风 → null（调用方降级）。
 * iOS Safari 需在用户手势内调用（AudioContext resume）。
 */
export async function startPcmCapture(opts: CaptureOpts = {}): Promise<Capture | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true },
    });
  } catch (err) {
    console.warn("[audio] 麦克风不可用（拒权或约束失败）", err);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return null;
    }
  }

  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE });
  } catch {
    ctx = new AudioContext(); // 实际非 16k → 处理器内重采样
  }
  try {
    await ctx.resume(); // iOS 手势内解锁
  } catch {
    /* 部分旧 WebView resume 可能拒绝：继续尝试采集 */
  }

  const state: CaptureState = {
    chunks: [],
    totalSamples: 0,
    peak: 0,
    smoothed: 0,
    onLevel: opts.onLevel,
    onChunk: opts.onChunk,
  };

  const src = ctx.createMediaStreamSource(stream);
  let workletNode: AudioWorkletNode | null = null;
  let legacyNode: ScriptProcessorNode | null = null;
  let workletUrl: string | null = null;
  let stopped = false;
  let teardownFlight: Promise<void> | null = null;
  let flushFallback: (()=>void) | null = null;

  try {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
    workletNode = new AudioWorkletNode(ctx, "ita-pcm-capture");
    workletNode.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; pcm?: ArrayBuffer | Int16Array; level?: number; peak?: number };
      if (stopped) return;
      if (d?.type === "chunk" && d.pcm) {
        const i16 = d.pcm instanceof Int16Array ? d.pcm : new Int16Array(d.pcm);
        state.chunks.push(i16);
        state.totalSamples += i16.length;
        if (typeof d.peak === "number" && d.peak > state.peak) state.peak = d.peak;
        if (typeof d.level === "number") state.onLevel?.(d.level);
        state.onChunk?.(bytesToB64(new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)));
      }
    };
    src.connect(workletNode);
    // 处理器必须有到 destination 的通路才会被拉动（Web Audio 图拉动模型）；
    // 经零增益节点防直通啸叫（worklet 不写输出，本身静默，双保险）。
    const muteW = ctx.createGain();
    muteW.gain.value = 0;
    workletNode.connect(muteW);
    muteW.connect(ctx.destination);
  } catch (err) {
    console.warn("[audio] AudioWorklet 不可用，降级 ScriptProcessor", err);
    workletNode = null;
    const handleBlock = makeFallbackBlockHandler(state, ctx.sampleRate);
    flushFallback = handleBlock.flush;
    legacyNode = ctx.createScriptProcessor(4096, 1, 1);
    legacyNode.onaudioprocess = (e) => {
      if (stopped) return;
      handleBlock.process(e.inputBuffer.getChannelData(0));
    };
    src.connect(legacyNode);
    // ScriptProcessor 必须连 destination 才回调；增益 0 防啸叫
    const mute = ctx.createGain();
    mute.gain.value = 0;
    legacyNode.connect(mute);
    mute.connect(ctx.destination);
  }

  async function performTeardown(flushWorklet: boolean): Promise<void> {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    try {
      src.disconnect();
    } catch {
      /* 已断开 */
    }
    if (workletNode) {
      if (flushWorklet) {
        // 停止握手：等 worklet 排空此前所有 chunk 消息（200ms 兜底）
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          workletNode!.port.onmessage = (e: MessageEvent) => {
            const d = e.data as { type?: string; pcm?: ArrayBuffer | Int16Array; level?: number; peak?: number };
            if (d?.type === "flushed") {
              clearTimeout(timer);
              resolve();
            } else if (d?.type === "chunk" && d.pcm) {
              const i16 = d.pcm instanceof Int16Array ? d.pcm : new Int16Array(d.pcm);
              state.chunks.push(i16);
              state.totalSamples += i16.length;
              if (typeof d.peak === "number" && d.peak > state.peak) state.peak = d.peak;
              if (typeof d.level === "number") state.onLevel?.(d.level);
              state.onChunk?.(bytesToB64(new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)));
            }
          };
          workletNode!.port.postMessage({ type: "flush" });
        });
      }
      workletNode.port.onmessage = null;
      try {
        workletNode.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    if (legacyNode) {
      if(flushWorklet) flushFallback?.();
      legacyNode.onaudioprocess = null;
      try {
        legacyNode.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    try {
      await ctx.close();
    } catch {
      /* 已关闭 */
    }
    /* 录音后重设 playback 音频会话（治「录完就播全无声」）：WebKit 录音时把会话切到
       PlayAndRecord，停止后的自动恢复有竞态窗——录制刚停就播的云 TTS（陪练句队）
       会掉进听筒路由/中断态。fire-and-forget：浏览器/失败均静默（会话设置幂等）。 */
    await invoke("restore_playback_audio");
  }
  function teardown(flushWorklet: boolean): Promise<void> {
    if (!teardownFlight) teardownFlight = performTeardown(flushWorklet);
    return teardownFlight;
  }

  return {
    stop: async () => {
      await teardown(true);
      return assemble(state);
    },
    cancel: () => {
      void teardown(false);
    },
  };
}
