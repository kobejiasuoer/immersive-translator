/**
 * 录音直译窗口（R4，label "live-caption"）：麦克风实时转写 + 句级翻译，
 * 双语滚动字幕，中→英 / 英→中可切；结束后可保存双语对照 .md / .txt。
 *
 * 链路：micRecorder（onChunk 流式，不留全量缓冲）→ LiveSegmenter（VAD 分句，
 * 收句即释放缓冲）→ 讯飞流式听写（xfyunAsr）→ translate_stream 句级翻译
 * （translateClient 按 tag 路由）。保存走 save_text_file 原生另存为。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./liveCaption.css";
import {
  asrLanguageOf,
  buildCaptionMarkdown,
  buildCaptionPlainText,
  buildCaptionSystemPrompt,
  captionFileName,
  LiveSegmenter,
  type CaptionDirection,
  type CaptionSegment,
} from "../core/liveCaption";
import { transcribeSpeech } from "../core/xfyunAsr";
import { resamplePcmTo16k, startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";
import { loadAsrCredentials } from "../lib/iseCredentials";
import { createTranslateClient } from "../lib/translateClient";
import { openSettings, saveTextFile } from "../lib/tauriBridge";

/** 界面上保留的最大段数（保存仍用全量）。 */
const MAX_VISIBLE_SEGMENTS = 200;

export function LiveCaptionApp() {
  const [direction, setDirection] = useState<CaptionDirection>("zh2en");
  const [recording, setRecording] = useState(false);
  const [segments, setSegments] = useState<CaptionSegment[]>([]);
  const [listening, setListening] = useState(false); // 分句器正在攒一句
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [endedAt, setEndedAt] = useState(0);

  const recorderRef = useRef<MicRecorderHandle | null>(null);
  const segmenterRef = useRef<LiveSegmenter | null>(null);
  const clientRef = useRef<ReturnType<typeof createTranslateClient> | null>(null);
  const segmentsRef = useRef<CaptionSegment[]>([]);
  const startedAtRef = useRef(0);
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** getUserMedia 授权等待期就点了停止：录音器就绪后直接丢弃。 */
  const stopPendingRef = useRef(false);
  /** 当前录音的实际采样率（flush 尾巴重采样用）。 */
  const sampleRateRef = useRef(16000);

  const noticeTimer = useRef<number | null>(null);
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 4000);
  }, []);

  // 卸载时清掉未触发的提示定时器
  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  // 翻译客户端（窗口生命周期一个）
  useEffect(() => {
    const client = createTranslateClient("live-caption");
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // 新段/更新时贴底滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments, listening]);

  const patchSegment = useCallback((id: number, patch: Partial<CaptionSegment>) => {
    setSegments((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** 一句收尾：ASR → 翻译 → 更新段。失败段给降级提示但不中断录音。
   * 方向在进函数这刻定格：停止录音后用户立刻切方向，
   * 尾句（flush 出来的半句）不能按新方向识别/翻译。 */
  const handleUtterance = useCallback(
    async (pcm: Float32Array) => {
      const dir = directionRef.current;
      const client = clientRef.current;
      const creds = await loadAsrCredentials().catch(() => null);
      if (!client || !creds) {
        flash("讯飞听写凭据未配置：到 设置 → 语音 里填一次（或复用跟读评测那组）");
        return;
      }
      const id = ++seqRef.current;
      setSegments((list) => [
        ...list,
        { id, source: "", target: null, state: "transcribing", at: Date.now() },
      ]);
      let text: string;
      try {
        text = await transcribeSpeech(pcm, asrLanguageOf(dir), creds);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patchSegment(id, { state: "failed", source: `〔识别失败：${msg}〕` });
        return;
      }
      if (!text) {
        // 没识别出内容：移除占位段，不打断后续
        setSegments((list) => list.filter((s) => s.id !== id));
        return;
      }
      patchSegment(id, { source: text, state: "translating" });

      const res = await client.request(
        text,
        buildCaptionSystemPrompt(dir),
        `lc${id}`,
        (partial) => patchSegment(id, { target: partial }),
      );
      if (res.status === "done" && res.text.trim()) {
        patchSegment(id, { target: res.text.trim(), state: "done" });
      } else if (res.status === "cancelled") {
        // 已流出的部分译文保留（onDelta 已写入）；没有任何译文时标失败给提示，
        // 否则这句下面永远空白，看起来像丢了。
        if (res.text.trim()) {
          patchSegment(id, { state: "done" });
        } else {
          patchSegment(id, { state: "failed" });
          flash("有一句翻译被取消，没有产出译文（原文已保留）");
        }
      } else {
        patchSegment(id, { state: "failed" });
        flash(`翻译失败：${res.text.slice(0, 120)}`);
      }
    },
    [flash, patchSegment],
  );

  const startRecording = useCallback(async () => {
    // 前置检查：凭据缺了先说清楚，不开麦
    const creds = await loadAsrCredentials().catch(() => null);
    if (!creds) {
      flash("讯飞听写凭据未配置：到 设置 → 语音 里填一次（或复用跟读评测那组）");
      return;
    }
    try {
      stopPendingRef.current = false;
      sampleRateRef.current = 16000;
      const seg = new LiveSegmenter();
      const recorder = await startMicRecorder({
        onChunk: (chunk, e) => {
          setLevel(e.level);
          setListening(seg.speaking);
          sampleRateRef.current = e.sampleRate;
          const utterance = seg.push(chunk, e.level, e.sampleRate);
          if (utterance) {
            setListening(false);
            // 非 16k 设备整句重采样（句级做，无跨块相位问题）
            void handleUtterance(resamplePcmTo16k(utterance, sampleRateRef.current));
          }
        },
      });
      if (stopPendingRef.current) {
        // 授权等待期用户已点停止：不开录
        stopPendingRef.current = false;
        recorder.cancel();
        return;
      }
      segmenterRef.current = seg;
      recorderRef.current = recorder;
      const now = Date.now();
      startedAtRef.current = now;
      setStartedAt(now);
      setEndedAt(0);
      setRecording(true);
    } catch (e) {
      const dom = e as DOMException;
      flash(`麦克风打不开（${dom?.name ?? "错误"}）：${dom?.message ?? e}`);
    }
  }, [flash, handleUtterance]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    const segmenter = segmenterRef.current;
    recorderRef.current = null;
    segmenterRef.current = null;
    setRecording(false);
    setListening(false);
    setLevel(0);
    setEndedAt(Date.now());
    if (!recorder) {
      // 录音器还在等授权：标记后由 startRecording 的续体丢弃
      stopPendingRef.current = true;
      return;
    }
    if (segmenter) {
      const tail = segmenter.flush();
      if (tail) void handleUtterance(resamplePcmTo16k(tail, sampleRateRef.current));
    }
    // 流式模式 stop() 只释放麦克风，不返回数据
    void recorder?.stop().catch(() => undefined);
  }, [handleUtterance]);

  // 关窗/卸载保护：收麦克风
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

  const toggleDirection = useCallback(() => {
    if (recording) {
      flash("先停止录音再切换方向");
      return;
    }
    setDirection((d) => (d === "zh2en" ? "en2zh" : "zh2en"));
  }, [recording, flash]);

  const doneSegments = useMemo(() => segments.filter((s) => s.source.trim()), [segments]);

  const save = useCallback(
    async (ext: "md" | "txt") => {
      if (doneSegments.length === 0) return;
      const body =
        ext === "md"
          ? buildCaptionMarkdown(doneSegments, {
              direction,
              startedAt: startedAt || startedAtRef.current,
              endedAt: endedAt || Date.now(),
            })
          : buildCaptionPlainText(doneSegments, {
              direction,
              startedAt: startedAt || startedAtRef.current,
              endedAt: endedAt || Date.now(),
            });
      const path = await saveTextFile(captionFileName(Date.now(), ext), body);
      if (path) flash(`已保存到 ${path}`);
    },
    [doneSegments, direction, startedAt, endedAt, flash],
  );

  const clearAll = useCallback(() => {
    if (recording) return;
    setSegments([]);
  }, [recording]);

  return (
    <div className="lc-page">
      <header className="lc-head">
        <h1>录音直译</h1>
        <div className="lc-direction" role="group" aria-label="翻译方向">
          <button
            className={`lc-dir-btn${direction === "zh2en" ? " on" : ""}`}
            onClick={toggleDirection}
            disabled={recording}
          >
            中 → 英
          </button>
          <button
            className={`lc-dir-btn${direction === "en2zh" ? " on" : ""}`}
            onClick={toggleDirection}
            disabled={recording}
          >
            英 → 中
          </button>
        </div>
      </header>

      {notice && <div className="lc-notice">{notice}</div>}

      <div className="lc-stream" ref={scrollRef}>
        {doneSegments.length === 0 && !recording && (
          <div className="lc-empty">
            点「开始录音」说话 —— 每说完一句，原文和译文会先后出现在这里。
            <br />
            适合听课、开会、看无字幕视频时挂着当双语字幕。
          </div>
        )}
        {doneSegments.slice(-MAX_VISIBLE_SEGMENTS).map((s) => (
          <div key={s.id} className="lc-line">
            <div className="lc-src">{s.source}</div>
            {s.state === "translating" && s.target === null && <div className="lc-dst pending">翻译中…</div>}
            {s.target !== null && <div className="lc-dst">{s.target}</div>}
            {s.state === "failed" && s.target === null && <div className="lc-dst failed">这句翻译失败（原文已保留）</div>}
          </div>
        ))}
        {recording && (
          <div className={`lc-listening${listening ? " on" : ""}`}>{listening ? "正在听…" : "等待你开口…"}</div>
        )}
      </div>

      <div className="lc-controls">
        <div className="lc-level" aria-hidden>
          <i style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
        </div>
        <div className="lc-controls-row">
          {recording ? (
            <button className="btn btn-primary lc-record-btn stop" onClick={stopRecording}>
              ⏹ 停止录音
            </button>
          ) : (
            <button className="btn btn-primary lc-record-btn" onClick={() => void startRecording()}>
              ● 开始录音
            </button>
          )}
          <button className="btn" disabled={recording || doneSegments.length === 0} onClick={() => void save("md")}>
            保存 .md
          </button>
          <button className="btn" disabled={recording || doneSegments.length === 0} onClick={() => void save("txt")}>
            保存 .txt
          </button>
          <button className="btn" disabled={recording || segments.length === 0} onClick={clearAll}>
            清空
          </button>
        </div>
        <div className="lc-hint">
          静音约 1 秒自动断句；讯飞听写凭据在 设置 → 语音 集中配置
          <button className="lc-creds-toggle" onClick={() => void openSettings().catch(() => undefined)}>
            打开设置
          </button>
        </div>
      </div>
    </div>
  );
}
