/**
 * 麦克风录音器（跟读评测用）。
 *
 * WebView2 + Tauri 注意：麦克风权限依赖 tauri.conf.json 各窗口的
 * additionalBrowserArgs "--auto-accept-camera-and-microphone-capture"
 * （spike 验证：没有该参数 getUserMedia 会永久挂起）。
 *
 * 采集链路：getUserMedia → AudioContext(16k)（不支持时默认采样率 +
 * 线性插值软件重采样）→ ScriptProcessor 累积 Float32 → 16k 单声道 PCM。
 * onLevel 上报平滑电平（0–1，供 UI 电平条）与已录时长，驱动外层静音 VAD。
 */

export interface MicLevelEvent {
  /** 平滑电平 0–1（人声朗读通常 0.05–0.6）。 */
  level: number;
  /** 已录制毫秒数。 */
  elapsedMs: number;
  /** 实际采集采样率（onChunk 块即此采样率；非 16k 时调用方需自行重采样）。 */
  sampleRate: number;
}

export interface MicRecorderHandle {
  /** 停止录音并返回 16k 单声道 Float32 PCM（[-1,1]）。onChunk 模式返回空数据。 */
  stop(): Promise<Float32Array>;
  /** 放弃本次录音并立即释放麦克风。 */
  cancel(): void;
}

/**
 * getUserMedia 权限挂起时（弹窗无人应答/组策略拦截）promise 永不 settle，
 * UI 会永远停在「录音中 0.0s」。包一层超时把挂起变成可恢复的失败态。
 */
function getUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
  timeoutMs = 10_000,
): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(
        new DOMException(
          `麦克风授权等待超时（${Math.round(timeoutMs / 1000)}s），请检查系统麦克风权限或弹窗`,
          "TimeoutError",
        ),
      );
    }, timeoutMs);
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        window.clearTimeout(timer);
        resolve(stream);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

export async function startMicRecorder(opts: {
  deviceId?: string;
  onLevel?: (e: MicLevelEvent) => void;
  /**
   * 流式模式（录音直译用）：逐块回调 16k PCM + 平滑电平，不在内部留
   * 全量缓冲（长录音内存平稳），stop() 返回空数据。与 onLevel 二选一。
   */
  onChunk?: (chunk: Float32Array, e: MicLevelEvent) => void;
}): Promise<MicRecorderHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境不支持麦克风采集");
  }
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
  let stream: MediaStream;
  try {
    stream = await getUserMediaWithTimeout({ audio });
  } catch (err) {
    const dom = err as DOMException;
    if (dom?.name === "OverconstrainedError") {
      // 指定设备不存在（拔掉/换设备后 id 失效）：退回系统默认。
      stream = await getUserMediaWithTimeout({ audio: true });
    } else {
      throw err;
    }
  }

  let ctx: AudioContext;
  let rate: number;
  let nativeRate = true;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    rate = ctx.sampleRate;
  } catch {
    ctx = new AudioContext();
    rate = ctx.sampleRate;
    nativeRate = false;
  }

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const chunks: Float32Array[] = [];
  const startedAt = performance.now();
  let level = 0;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    let sumSq = 0;
    for (let i = 0; i < input.length; i += 1) sumSq += input[i] * input[i];
    const rms = Math.sqrt(sumSq / input.length);
    level = Math.max(level * 0.55, Math.min(1, rms * 4.5));
    const levelEvent = { level, elapsedMs: performance.now() - startedAt, sampleRate: rate };
    if (opts.onChunk) {
      // 流式模式：块按原生采样率交给调用方（内部不留全量缓冲）；
      // 非 16k 设备由调用方整句重采样（见 liveCaption）。
      opts.onChunk(new Float32Array(input), levelEvent);
    } else {
      chunks.push(new Float32Array(input));
      opts.onLevel?.(levelEvent);
    }
  };

  function teardown() {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
    } catch {
      /* 已断开 */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
  }

  function merged(): Float32Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
    if (inputRate === 16000) return input;
    return resamplePcmTo16k(input, inputRate);
  }

  return {
    stop: async () => {
      if (stopped) throw new Error("录音已结束");
      const captured = merged();
      teardown();
      return nativeRate && rate === 16000 ? captured : resampleTo16k(captured, rate);
    },
    cancel: () => {
      teardown();
      chunks.length = 0;
    },
  };
}

/** 线性插值重采样到 16k（流式调用方对整句使用，句级调用无跨块相位问题）。 */
export function resamplePcmTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** 枚举麦克风设备（先申请一次权限让 label 可读）。供设置面板下拉。 */
export async function listMicDevices(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const stream = await getUserMediaWithTimeout({ audio: true }, 8000);
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // 无权限/无设备/授权挂起时 label 为空，仍尽力列出
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "麦克风" }));
  } catch {
    return [];
  }
}
