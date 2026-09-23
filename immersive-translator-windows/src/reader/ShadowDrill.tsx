/**
 * 只练差词（口语陪练跟读报告的动作落点）。
 *
 * 底部抽屉：逐词「领读 → 按住跟读 → 出分」，练完引导回整句。
 * 自带录音/评测（单词一次送 ISE），与主跟读互斥（抽屉打开时主按钮被遮罩挡住）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { evaluateSentence, type PronunciationResult } from "../core/pronunciation";
import { phoneTip, worstPhoneOf } from "../core/shadowDiagnose";
import { startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";
import { loadIseCredentials } from "../lib/iseCredentials";
import type { DrillEntry } from "./ShadowReport";

interface Props {
  entries: DrillEntry[];
  micDeviceId: string;
  onToast: (msg: string) => void;
  /** TTS 读一个词（走句子轨的 speak）。 */
  onSpeakWord: (word: string) => void;
  onClose: () => void;
  /** 全部练完 → 回整句跟读。 */
  onDone: (wordScores: number[]) => void;
}

/** 单词跟读最长 8 秒。 */
const MAX_WORD_MS = 8000;

type StepState =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "evaluating" }
  | { kind: "result"; score: number; improved: boolean };

export function ShadowDrill(props: Props) {
  const { entries, micDeviceId, onToast } = props;
  const [idx, setIdx] = useState(0);
  const [step, setStep] = useState<StepState>({ kind: "idle" });
  const [level, setLevel] = useState(0);
  /** 每个词练完的分（null = 没练）。 */
  const [scores, setScores] = useState<(number | null)[]>(() => entries.map(() => null));
  const recorderRef = useRef<MicRecorderHandle | null>(null);
  const releasePendingRef = useRef(false);
  const finishRef = useRef<() => void>(() => undefined);

  const entry = entries[idx];

  // 卸载收麦
  useEffect(() => {
    return () => recorderRef.current?.cancel();
  }, []);

  const finishWord = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) {
      setStep((s) => (s.kind === "recording" ? { kind: "idle" } : s));
      releasePendingRef.current = true;
      return;
    }
    recorderRef.current = null;
    setStep({ kind: "evaluating" });
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (e) {
      onToast(`录音失败：${e instanceof Error ? e.message : String(e)}`);
      setStep({ kind: "idle" });
      return;
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < 8000) {
      onToast("没听到声音，离麦克风近一点");
      setStep({ kind: "idle" });
      return;
    }
    const creds = await loadIseCredentials().catch(() => null);
    if (!creds) {
      onToast("未配置讯飞评测凭据：设置 → 语音");
      setStep({ kind: "idle" });
      return;
    }
    let result: PronunciationResult;
    try {
      result = await evaluateSentence(pcm, entry.text, creds);
    } catch (e) {
      onToast(`评测失败：${e instanceof Error ? e.message : String(e)}`);
      setStep({ kind: "idle" });
      return;
    }
    if (result.isRejected || result.exceptInfo !== null) {
      onToast("这个没听清，再试一次（读准一点、声音大一点）");
      setStep({ kind: "idle" });
      return;
    }
    const prev = entry.mark.score;
    setScores((s) => {
      const next = [...s];
      next[idx] = result.total;
      return next;
    });
    setStep({ kind: "result", score: result.total, improved: result.total > prev });
  }, [entry, idx, onToast]);

  finishRef.current = finishWord;

  const startWord = useCallback(() => {
    if (step.kind === "recording" || step.kind === "evaluating") return;
    setStep({ kind: "recording" });
    setLevel(0);
    releasePendingRef.current = false;
    void (async () => {
      try {
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level, elapsedMs }) => {
            setLevel(level);
            if (elapsedMs >= MAX_WORD_MS) void finishRef.current();
          },
        });
        if (releasePendingRef.current) {
          releasePendingRef.current = false;
          recorder.cancel();
          setStep({ kind: "idle" });
          return;
        }
        recorderRef.current = recorder;
      } catch (e) {
        const dom = e as DOMException;
        onToast(`麦克风打不开（${dom?.name ?? "错误"}）：${dom?.message ?? e}`);
        setStep({ kind: "idle" });
      }
    })();
  }, [step.kind, micDeviceId, onToast]);

  const next = () => {
    if (idx + 1 < entries.length) {
      setIdx(idx + 1);
      setStep({ kind: "idle" });
    } else {
      // 全部过完（scores 里可能有 null = 跳过没练的）
      props.onDone(scores.map((s) => s ?? 0));
    }
  };

  const skip = () => {
    if (idx + 1 < entries.length) {
      setIdx(idx + 1);
      setStep({ kind: "idle" });
    } else {
      props.onDone(scores.map((s) => s ?? 0));
    }
  };

  const word = entry.mark.word;
  const worst = worstPhoneOf(word);
  const phones = word?.sylls.flatMap((s) => s.phones) ?? [];

  return (
    <div className="drill-backdrop" role="dialog" aria-label="只练差的词">
      <div className="drill-sheet">
        <div className="drill-head">
          <span className="t">只练差的词</span>
          <span className="drill-dots" aria-hidden>
            {entries.map((_, i) => (
              <i key={i} className={i < idx ? "done" : i === idx ? "cur" : ""} />
            ))}
          </span>
          <span className="sub">
            {idx + 1} / {entries.length} · 练完回整句
          </span>
          <button className="x" onClick={props.onClose} aria-label="退出词练">
            ✕
          </button>
        </div>

        <div className="drill-body">
          <div className="drill-card">
            <div className="dw">{entry.text}</div>
            <div className="dipa">
              {missed(entry) ? "整句里漏读了它" : `上次 ${entry.mark.score.toFixed(1)} 分`}
            </div>
            {phones.length > 0 && (
              <div className="ph-row">
                {phones.map((p, i) => {
                  const isWorst = worst !== null && p.content === worst.content && p.gwpp === worst.gwpp;
                  return (
                    <span key={i} className={`ph${isWorst ? " err" : ""}`}>
                      {p.content}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div className="drill-tip">
            {missed(entry) ? (
              <>
                先听一遍怎么读，<b>下一轮整句把它带上</b>就好。
              </>
            ) : (
              <>{worst ? <b>{phoneTip(worst.content)}</b> : <>对照领读慢速跟两遍，注意口型。</>}</>
            )}
          </div>
        </div>

        <div className="drill-level" aria-hidden>
          <i style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
        </div>

        <div className="drill-actions">
          {step.kind === "result" ? (
            <>
              <div className="drill-result">
                <span className={`sc${step.improved ? " up" : ""}`}>{step.score.toFixed(1)}</span>
                <span className="note">
                  {missed(entry)
                    ? "会读它了，回整句时带上"
                    : step.improved
                      ? `比整句里的 ${entry.mark.score.toFixed(1)} 高`
                      : "还差一点，注意高亮的音"}
                </span>
              </div>
              <button className="rc-btn primary" onClick={next}>
                {idx + 1 < entries.length ? "下一个词 →" : "回整句再跟读 🎤"}
              </button>
            </>
          ) : (
            <>
              <button className="rc-btn" onClick={() => props.onSpeakWord(entry.text)}>
                🔊 领读
              </button>
              <button
                className={`drill-hold${step.kind === "recording" ? " rec" : ""}`}
                disabled={step.kind === "evaluating"}
                onClick={step.kind === "recording" ? finishRef.current : startWord}
              >
                {step.kind === "recording"
                  ? "跟读中…松开结束"
                  : step.kind === "evaluating"
                    ? "评分中…"
                    : missed(entry)
                      ? "🎤 按住读一读它"
                      : "🎤 按住跟读这个词"}
              </button>
              <button className="rc-link" onClick={skip}>
                {idx + 1 < entries.length ? "跳过" : "结束"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function missed(entry: DrillEntry): boolean {
  return entry.mark.quality === "missed";
}
