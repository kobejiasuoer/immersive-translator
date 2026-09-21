/**
 * 跟读评测状态机（shadowingMode + shadowingAssess 时由 ReaderApp 挂到
 * playback.shadowingWait 上）：
 *
 *   本句 TTS 读完 → 自动开麦录音 → 静音 VAD/手动结束 → 送讯飞评测
 *     ├─ 达标 → 短暂展示 ✅ → continueAfterShadowing 进下一句
 *     └─ 不达标 → 词着色 + [再试] [领读(慢速 TTS，读完自动重新开麦)] [跳过]
 *
 * 评测失败的兜底原则：永不卡死播放——任何错误都给「跳过」逃生门。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { onTtsEnded } from "../lib/tauriBridge";
import { loadIseCredentials } from "../lib/iseCredentials";
import {
  evaluateSentence,
  isPass,
  type PronunciationResult,
} from "../core/pronunciation";
import { startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";

export type AssessPhase =
  | "idle" // 非跟读等待（或尚未开始）
  | "ready" // 手动开麦模式：等用户点「开口跟读」（关自动时领读结束也回到这）
  | "recording"
  | "evaluating"
  | "leading" // 领读慢速 TTS 播放中，播完按开麦方式分流
  | "passed"
  | "failed"
  | "error";

/** VAD 参数（经验值）。开说/静音阈值不再写死绝对电平——轻声说话或低灵敏
 * 麦克风的绝对电平可能永远够不到固定线，这里按「运行时估计的底噪 × 信噪比
 * 倍率」自适应，绝对下限兜住极安静房间的噪声毛刺，封顶保证开口即说话
 * （前面没有静音样本）时阈值不会被顶飞。
 * 静音断句时长不在此写死——由设置 shadowingSilenceMs 提供（默认 1500ms）。 */
const SPEECH_LEVEL_MIN = 0.006;
const SPEECH_LEVEL_CEILING = 0.05;
const SILENCE_LEVEL_MIN = 0.003;
/** 开说阈值 = clamp(底噪 × 2.8, 绝对下限, 封顶)；静音判定 = max(下限, 底噪 × 1.6)。 */
const SPEECH_FLOOR_RATIO = 2.8;
const SILENCE_FLOOR_RATIO = 1.6;
/** 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口（超低电平麦克风）。 */
const RESCUE_AFTER_MS = 3500;
const RESCUE_FLOOR_RATIO = 1.8;
/** 一直没听到开说 → 提前收（原来干等满 15s 才停），提示检查麦克风。 */
const NO_SPEECH_TIMEOUT_MS = 8000;
const MIN_RECORD_MS = 700;
const MAX_RECORD_MS = 15000;
/** 过关后停留展示的时长，再自动进下一句。 */
const PASS_LINGER_MS = 650;
/** 领读语速（比正常朗读慢，示范用）。 */
const LEAD_RATE = 0.72;

export interface UseShadowAssessDeps {
  /** 当前文章的英文句（下标即句 idx，与 usePlayback 共用）。 */
  textsRef: { current: string[] };
  /** 实时读取配置（过关阈值、麦克风设备、开麦方式、静音断句时长）。 */
  getConfig: () => {
    passScore: number;
    micDeviceId: string;
    autoMic: boolean;
    silenceMs: number;
  };
  /** 领读：慢速 TTS 播原句，返回朗读代数（用于等 tts:ended）。 */
  leadSpeak: (text: string) => Promise<number>;
  /** 停领读（word 轨）：再试/跳过/取消时必须叫停在播音频与在途合成。 */
  stopLead: () => void;
  /** 放行：过关节点调用（ReaderApp 接 playback.continueAfterShadowing）。 */
  onAdvance: () => void;
}

export interface ShadowAssessState {
  phase: AssessPhase;
  level: number;
  elapsedMs: number;
  result: PronunciationResult | null;
  error: string | null;
  sentenceIdx: number | null;
}

export function useShadowAssess(deps: UseShadowAssessDeps) {
  // 回调全部走 depsRef，保证 begin/cancel 等引用稳定（effect 依赖不抖动）。
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [state, setState] = useState<ShadowAssessState>({
    phase: "idle",
    level: 0,
    elapsedMs: 0,
    result: null,
    error: null,
    sentenceIdx: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const recorderRef = useRef<MicRecorderHandle | null>(null);
  const idxRef = useRef<number | null>(null);
  /** 一次评测尝试的纪元：cancel/retry 后旧结果作废。 */
  const epochRef = useRef(0);
  /** VAD 状态：started=已判定开说；floor=运行时底噪估计（null=还没收到电平）。 */
  const vadRef = useRef({ started: false, lastVoiceAt: 0, floor: null as number | null });
  /** 本次录音生效的静音断句时长（开麦那一刻从配置取，录音中途改设置不打断本次）。 */
  const silenceMsRef = useRef(1500);
  const passTimerRef = useRef<number | null>(null);
  const leadGenRef = useRef<number | null>(null);

  const patch = useCallback((p: Partial<ShadowAssessState>) => {
    setState((cur) => ({ ...cur, ...p }));
  }, []);

  const clearPassTimer = useCallback(() => {
    if (passTimerRef.current !== null) {
      window.clearTimeout(passTimerRef.current);
      passTimerRef.current = null;
    }
  }, []);

  const dropRecorder = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
  }, []);

  // ---- 评测 ----
  const evaluate = useCallback(
    async (pcm: Float32Array, idx: number, epoch: number) => {
      const text = depsRef.current.textsRef.current[idx];
      if (!text) {
        patch({ phase: "error", error: "句子不存在" });
        return;
      }
      let creds;
      try {
        creds = await loadIseCredentials();
      } catch {
        creds = null;
      }
      if (!creds) {
        patch({ phase: "error", error: "未配置讯飞评测凭据：设置 → 语音" });
        return;
      }
      try {
        const result = await evaluateSentence(pcm, text, creds);
        if (epoch !== epochRef.current) return; // 已被取消/重试
        const { passScore } = depsRef.current.getConfig();
        if (isPass(result, passScore)) {
          patch({ phase: "passed", result, error: null });
          clearPassTimer();
          passTimerRef.current = window.setTimeout(() => {
            passTimerRef.current = null;
            depsRef.current.onAdvance();
          }, PASS_LINGER_MS);
        } else {
          const hint =
            result.isRejected || result.exceptInfo === "28673"
              ? "没听到足够的声音——离麦克风近一点，或在设置里换个麦克风"
              : `${result.total.toFixed(1)} / ${passScore.toFixed(1)} 分，差一点`;
          patch({ phase: "failed", result, error: hint });
        }
      } catch (err) {
        if (epoch !== epochRef.current) return;
        patch({ phase: "error", result: null, error: err instanceof Error ? err.message : String(err) });
      }
    },
    [patch, clearPassTimer],
  );

  // ---- 结束录音（静音 VAD / 手动 / 超时共用） ----
  const finishRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    const idx = idxRef.current;
    const epoch = epochRef.current;
    if (idx == null) return;
    patch({ phase: "evaluating" });
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (err) {
      patch({ phase: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // 静音兜底：几乎无信号就不烧调用次数，直接提示换设备。
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < 16000 * 0.4) {
      patch({
        phase: "failed",
        result: null,
        error: "没听到声音——检查设置里的麦克风选择（可能选中了虚拟设备）",
      });
      return;
    }
    await evaluate(pcm, idx, epoch);
  }, [patch, evaluate]);

  // ---- 开始录音（自动开麦 / 手动开口 / 领读后重录共用） ----
  const startRecording = useCallback(async () => {
    const idx = idxRef.current;
    if (idx == null) return;
    const epoch = epochRef.current;
    vadRef.current = { started: false, lastVoiceAt: 0, floor: null };
    setState({
      phase: "recording",
      level: 0,
      elapsedMs: 0,
      result: null,
      error: null,
      sentenceIdx: idx,
    });
    try {
      const { micDeviceId, silenceMs } = depsRef.current.getConfig();
      silenceMsRef.current = silenceMs;
      const recorder = await startMicRecorder({
        deviceId: micDeviceId || undefined,
        onLevel: ({ level, elapsedMs }) => {
          setState((s) => (s.phase === "recording" ? { ...s, level, elapsedMs } : s));
          const vad = vadRef.current;
          const speechLevel = Math.min(
            SPEECH_LEVEL_CEILING,
            Math.max(SPEECH_LEVEL_MIN, (vad.floor ?? 0) * SPEECH_FLOOR_RATIO),
          );
          if (level < speechLevel) {
            // 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
            vad.floor = vad.floor === null ? level : Math.min(level, vad.floor * 1.05);
          }
          const silenceLevel = Math.max(SILENCE_LEVEL_MIN, (vad.floor ?? 0) * SILENCE_FLOOR_RATIO);
          if (level >= speechLevel) {
            vad.started = true;
            vad.lastVoiceAt = elapsedMs;
          } else if (
            !vad.started &&
            elapsedMs >= RESCUE_AFTER_MS &&
            level >= (vad.floor ?? 0) * RESCUE_FLOOR_RATIO
          ) {
            // 超低电平麦克风：绝对阈值够不到，但持续高于底噪也算开口。
            vad.started = true;
            vad.lastVoiceAt = elapsedMs;
          }
          if (!vad.started && elapsedMs >= NO_SPEECH_TIMEOUT_MS) {
            // 一直没等到开说：提前收，别让用户干等满 15s。
            void finishRecording();
            return;
          }
          if (
            vad.started &&
            level < silenceLevel &&
            elapsedMs - vad.lastVoiceAt >= silenceMsRef.current &&
            elapsedMs >= MIN_RECORD_MS
          ) {
            void finishRecording();
          } else if (elapsedMs >= MAX_RECORD_MS) {
            void finishRecording();
          }
        },
      });
      if (epoch !== epochRef.current) {
        // 等待授权期间被取消/换句
        recorder.cancel();
        return;
      }
      // 覆盖前先停旧录音器：领读合成期间点「再试」等路径会让第二次开麦落在
      // 旧录音器还活着的时候——直接赋值会让旧 recorder 永久失联（麦克风灯
      // 长亮、内存泄漏，其电平还会误触 VAD）。
      recorderRef.current?.cancel();
      recorderRef.current = recorder;
    } catch (err) {
      if (epoch !== epochRef.current) return;
      const dom = err as DOMException;
      patch({
        phase: "error",
        error: `麦克风打不开（${dom?.name ?? "错误"}）：${dom?.message ?? err} — 可在设置 → 跟读评测里换设备`,
      });
    }
  }, [patch, finishRecording]);

  /** 本句进入跟读等待：自动开麦直接录，手动模式停在 ready 等「开口跟读」。 */
  const begin = useCallback(
    (idx: number) => {
      const cur = stateRef.current;
      if (cur.phase === "recording" || cur.phase === "evaluating") {
        if (idxRef.current === idx) return; // 同句重复触发，忽略
        dropRecorder(); // 句子变了，弃掉旧录音
      }
      clearPassTimer();
      depsRef.current.stopLead(); // 换句时掐掉上一句可能还在播的领读（word 轨）
      leadGenRef.current = null;
      idxRef.current = idx;
      epochRef.current += 1;
      setState({
        phase: "idle",
        level: 0,
        elapsedMs: 0,
        result: null,
        error: null,
        sentenceIdx: idx,
      });
      if (depsRef.current.getConfig().autoMic) {
        void startRecording();
      } else {
        patch({ phase: "ready" });
      }
    },
    [clearPassTimer, dropRecorder, patch, startRecording],
  );

  /** 手动开麦模式：ready 状态下的「开口跟读」按钮。 */
  const openMic = useCallback(() => {
    if (stateRef.current.phase !== "ready") return;
    void startRecording();
  }, [startRecording]);

  /** 再试：failed/error/ready 里点「再试」都立即开录（用户显式动作，不走 ready）。 */
  const retry = useCallback(() => {
    if (idxRef.current == null) return;
    dropRecorder();
    clearPassTimer();
    depsRef.current.stopLead(); // 领读合成/播放中点「再试」：叫停在播与在途的领读音频
    leadGenRef.current = null;
    epochRef.current += 1;
    void startRecording();
  }, [dropRecorder, clearPassTimer, startRecording]);

  /** 领读：慢速 TTS 播原句；播完（tts:ended word 轨）自动重新开麦。 */
  const leadRead = useCallback(() => {
    const idx = idxRef.current;
    if (idx == null) return;
    const text = depsRef.current.textsRef.current[idx];
    if (!text) return;
    dropRecorder();
    const epoch = epochRef.current;
    depsRef.current
      .leadSpeak(text)
      .then((gen) => {
        if (epoch !== epochRef.current) {
          // 合成期间点了再试/跳过/取消：这次领读作废，停掉已落地的音频。
          depsRef.current.stopLead();
          return;
        }
        leadGenRef.current = gen;
        patch({ phase: "leading", level: 0 });
      })
      .catch(() => {
        if (epoch !== epochRef.current) return;
        patch({ phase: "failed", error: "领读播放失败" });
      });
  }, [dropRecorder, patch]);

  /** 复位到空闲（shadowingWait 结束/开关关闭时调用）。 */
  const cancel = useCallback(() => {
    epochRef.current += 1;
    clearPassTimer();
    depsRef.current.stopLead();
    dropRecorder();
    leadGenRef.current = null;
    idxRef.current = null;
    setState((s) =>
      s.phase === "idle"
        ? s
        : { phase: "idle", level: 0, elapsedMs: 0, result: s.result, error: null, sentenceIdx: s.sentenceIdx },
    );
  }, [clearPassTimer, dropRecorder]);

  // 领读结束 → 按开麦方式分流：自动直接重录，手动回到 ready 等开口
  // （word 音轨 + 代数匹配；查词发音的 ended 不触发）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    onTtsEnded((e) => {
      if (!active) return;
      if (e.track !== "word") return;
      if (leadGenRef.current === null || e.gen !== leadGenRef.current) return;
      leadGenRef.current = null;
      const idx = idxRef.current;
      if (idx != null && stateRef.current.phase === "leading") {
        if (depsRef.current.getConfig().autoMic) {
          void startRecording();
        } else {
          patch({ phase: "ready" });
        }
      }
    }).then((u) => {
      if (active) unlisten = u;
      else u();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [startRecording, patch]);

  // 卸载保护
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      if (passTimerRef.current !== null) window.clearTimeout(passTimerRef.current);
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

  return {
    ...state,
    /** 本句进入跟读等待时由外层调用（自动开麦直接录，手动模式进 ready）。 */
    begin,
    /** 手动开麦模式：ready 状态下的「开口跟读」。 */
    openMic,
    /** 再试：任何未过状态点它都立即重新开录。 */
    retry,
    /** 手动结束录音（说完按钮）。 */
    stopRecording: finishRecording,
    leadRead,
    /** 跳过本句（任何阶段可调，直接放行）。 */
    skip: useCallback(() => {
      epochRef.current += 1;
      clearPassTimer();
      depsRef.current.stopLead(); // leading 中点「跳过」：0.72× 慢速领读继续外放会与下一句叠音
      dropRecorder();
      leadGenRef.current = null;
      depsRef.current.onAdvance();
    }, [clearPassTimer, dropRecorder]),
    cancel,
    /** 领读语速（展示用常量）。 */
    leadRate: LEAD_RATE,
  };
}

export type ShadowAssess = ReturnType<typeof useShadowAssess>;
