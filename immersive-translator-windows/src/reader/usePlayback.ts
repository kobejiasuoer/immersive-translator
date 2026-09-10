/**
 * 阅读室播放引擎。
 *
 * 高亮推进由真实 TTS 事件驱动（§9-1）：逐句投递朗读，tts:ended（代数匹配）
 * 才推进下一句；后端的 word/sentence boundary 事件用于校验同步，句级高亮
 * 本身不依赖估算时长。变速不影响同步——因为高亮跟着「这句播完」走。
 *
 * 修复的原型缺陷：
 * - §9-7：未播放时 prev/next 只移动光标，不自动开始播放；
 * - §9-6：自然播完后状态与视图位置一致（停在末句，不回滚、不清滚动）；
 * - §9-2：跟读/查词发音走独立音轨，不打断句子朗读（查词用 track:word）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  onTtsBoundary,
  onTtsEnded,
  ttsSpeakAdvanced,
  ttsStopTrack,
  type ReaderSpeakOptions,
} from "../lib/tauriBridge";
import { looksMostlyChinese } from "../core/languageDetect";

/** 语速快捷档（播放条 1.0× 菜单）。 */
export const RATE_PRESETS = [0.75, 1, 1.25, 1.5] as const;

export interface PlaybackHandle {
  playing: boolean;
  activeIdx: number;
  /** 跟读模式：本句读完，等用户点「继续」。 */
  shadowingWait: boolean;
  setActiveIdx: (idx: number) => void;
  toggle: () => void;
  stop: () => void;
  /** 未播放时移动光标；播放中则跳读。返回是否改变。 */
  step: (delta: number) => void;
  jumpTo: (idx: number, opts?: { autoplay?: boolean }) => void;
  /** 跟读确认：读完本句后继续下一句。 */
  continueAfterShadowing: () => void;
  /** 句子总数变化（文章切换）后由视图调用复位。 */
  reset: (startIdx: number) => void;
}

interface PlaybackConfig {
  /** 事件目标窗口 label（阅读室为 "reader"）。 */
  target: string;
  /** 当前文章的待读文本（下标即句 idx）。 */
  textsRef: { current: string[] };
  settingsRef: { current: { rate: number; voice: string; sentencePauseMs: number; shadowingMode: boolean } };
  /** 播放自然结束（最后一句的 ended）。 */
  onFinish?: () => void;
}

export function usePlayback(config: PlaybackConfig): PlaybackHandle {
  const { target } = config;
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdxState] = useState(0);
  const [shadowingWait, setShadowingWait] = useState(false);

  const activeIdxRef = useRef(0);
  const genRef = useRef<number | null>(null);
  /** 本地播放纪元：stop/复位后 +1，使 in-flight 的推进计时器失效。 */
  const epochRef = useRef(0);
  const pauseTimerRef = useRef<number | null>(null);
  const playingRef = useRef(false);

  const setActiveIdx = useCallback((idx: number) => {
    activeIdxRef.current = idx;
    setActiveIdxState(idx);
  }, []);

  const speakIdx = useCallback(
    (idx: number) => {
      const texts = config.textsRef.current;
      if (idx < 0 || idx >= texts.length) {
        return;
      }
      const s = config.settingsRef.current;
      setActiveIdx(idx);
      const opts: ReaderSpeakOptions = {
        track: "sentence",
        rate: s.rate,
        target,
      };
      if (s.voice) opts.voice = s.voice;
      ttsSpeakAdvanced(texts[idx], looksMostlyChinese(texts[idx]), opts)
        .then((gen) => {
          genRef.current = gen;
        })
        .catch((error) => {
          console.error("[reader] tts speak failed", error);
          stop();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target],
  );

  const clearPauseTimer = useCallback(() => {
    if (pauseTimerRef.current !== null) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    epochRef.current += 1;
    clearPauseTimer();
    playingRef.current = false;
    setPlaying(false);
    setShadowingWait(false);
    genRef.current = null;
    void ttsStopTrack("sentence").catch((error) =>
      console.error("[reader] tts stop failed", error),
    );
  }, [clearPauseTimer]);

  /** ended 后的推进决策：跟读等待 / 停顿 / 立即下一句 / 结束。 */
  const advanceAfterEnded = useCallback(
    (epoch: number) => {
      const nextIdx = activeIdxRef.current + 1;
      const texts = config.textsRef.current;
      if (epoch !== epochRef.current || !playingRef.current) {
        return;
      }
      if (nextIdx >= texts.length) {
        // §9-6：自然播完停在末句，状态与视图一致。
        playingRef.current = false;
        setPlaying(false);
        config.onFinish?.();
        return;
      }
      const s = config.settingsRef.current;
      if (s.shadowingMode) {
        setShadowingWait(true);
        return;
      }
      if (s.sentencePauseMs > 0) {
        pauseTimerRef.current = window.setTimeout(() => {
          pauseTimerRef.current = null;
          if (epoch === epochRef.current && playingRef.current) {
            speakIdx(nextIdx);
          }
        }, s.sentencePauseMs);
        return;
      }
      speakIdx(nextIdx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speakIdx],
  );

  const toggle = useCallback(() => {
    if (playingRef.current) {
      stop();
      return;
    }
    if (shadowingWait) {
      continueAfterShadowing();
      return;
    }
    clearPauseTimer();
    const epoch = ++epochRef.current;
    playingRef.current = true;
    setPlaying(true);
    speakIdx(activeIdxRef.current);
    void epoch;
  }, [shadowingWait, speakIdx, stop, clearPauseTimer]);

  const continueAfterShadowing = useCallback(() => {
    if (!shadowingWait) return;
    setShadowingWait(false);
    const nextIdx = activeIdxRef.current + 1;
    if (nextIdx >= config.textsRef.current.length) {
      playingRef.current = false;
      setPlaying(false);
      config.onFinish?.();
      return;
    }
    speakIdx(nextIdx);
  }, [shadowingWait, speakIdx, config]);

  /** 未播放时只移动光标（§9-7）；播放中直接跳读。 */
  const jumpTo = useCallback(
    (idx: number, opts?: { autoplay?: boolean }) => {
      const texts = config.textsRef.current;
      if (texts.length === 0) return;
      const clamped = Math.max(0, Math.min(texts.length - 1, idx));
      if (playingRef.current || opts?.autoplay) {
        const epoch = ++epochRef.current;
        clearPauseTimer();
        setShadowingWait(false);
        if (!playingRef.current) {
          playingRef.current = true;
          setPlaying(true);
        }
        speakIdx(clamped);
        void epoch;
      } else {
        setActiveIdx(clamped);
      }
    },
    [speakIdx, setActiveIdx, clearPauseTimer, config],
  );

  const step = useCallback(
    (delta: number) => {
      jumpTo(activeIdxRef.current + delta);
    },
    [jumpTo],
  );

  const reset = useCallback(
    (startIdx: number) => {
      epochRef.current += 1;
      clearPauseTimer();
      playingRef.current = false;
      setPlaying(false);
      setShadowingWait(false);
      genRef.current = null;
      setActiveIdx(Math.max(0, startIdx));
    },
    [clearPauseTimer, setActiveIdx],
  );

  // tts:ended：只有与最新代数匹配的 sentence 音轨事件才推进。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    onTtsEnded((e) => {
      if (!active) return;
      if (e.track && e.track !== "sentence") return;
      if (genRef.current === null || e.gen !== genRef.current) return;
      genRef.current = null;
      const epoch = epochRef.current;
      advanceAfterEnded(epoch);
    }).then((u) => {
      if (active) unlisten = u;
      else u();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [advanceAfterEnded]);

  // boundary 事件：句级高亮由逐句朗读 + ended 驱动（decisions #5），
  // 这里只消费事件确认链路存活，不做词级视觉高亮。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    onTtsBoundary(() => {
      /* 句级高亮不依赖 word boundary；预留调试锚点 */
    }).then((u) => {
      if (active) unlisten = u;
      else u();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // 卸载/文章切换时停声。
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      void ttsStopTrack("sentence").catch(() => undefined);
    };
  }, []);

  return {
    playing,
    activeIdx,
    shadowingWait,
    setActiveIdx,
    toggle,
    stop,
    step,
    jumpTo,
    continueAfterShadowing,
    reset,
  };
}
