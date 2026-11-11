/**
 * 开口使用卡（vault-review-parity · CardMode "spoken" + proto-parity review-speak-question/
 * recorded/confirmed，原型 html:2933-2935）：录音试说 → 核对识别文字（可改写）→ 核对用法
 * （出处句/释义/句式）→ 人工三档自评。录音与 ASR 复用 services/practice 的管线
 * （startDurableRecording / transcribeRecording / playOriginal）。点录音直接进入系统授权，
 * 识别后的回答仍由用户确认，再自行选择记忆程度。
 * 复检 r1：录音盒/草稿区在已录与确认态常驻（原型 recorded/confirmed 同屏），确认态不再附加
 * 原句/释义卡；提示盒经 hint 插槽放在题目块之后；出错时才露出「听我的原声/重新识别原声」。
 * 题面 = tag/来源 + eyebrow「用这个表达，说一个关于自己的句子」+ 28px 衬线目标词 + 释义行；
 * 录音入口在 surface-2 圆角盒（录音试说 / 已录态「重新录一次」+「已录 N 秒…」）；草稿区
 * 「先写一份草稿」textarea + 填入示例草稿/保存草稿 + 保留说明；确认态「你的回答」rv-ex 卡
 * （衬线草稿 + 🔊听这份草稿）。严禁自动评分：三档只由用户点选，映射写死——
 * 没记住=forgot（10 分钟后再见）、有点模糊=hard（明天再见）、记住了=easy（7 天后再见），
 * good（3 天）档不进三档 UI；文案为实际固定间隔（srs.ts GRADE_INTERVALS），非「间隔翻倍」。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../ui/icons";
import { activeRepository, speak, stopSpeak, toast } from "../../store";
import { ensureAccount } from "../../services/authGate";
import { cloudState } from "../../services/cloud";
import { playOriginal, practiceError, practiceId, startDurableRecording, transcribeRecording, type DurableRecording } from "../../services/practice";
import type { Repository } from "../../core/persistence";
import type { Article } from "../../core/types";
import type { ReviewCard } from "../../core/queue";
import { useLocalRecording } from "../../core/useLocalRecording";

const RECORDING_FINALIZED = "mobile-spoken-review-recording-finalized";
function notifyRecordingFinalized(repo: Repository, clipId: string) {
  window.dispatchEvent(new window.CustomEvent(RECORDING_FINALIZED, { detail: { identity: repo.identity, clipId } }));
}

export interface SpokenState {
  /** ask=试说（录音/文字）；confirm=核对识别文字；check=核对用法+三档自评。 */
  stage: "ask" | "confirm" | "check";
  /** 已保存的原声（跨草稿恢复可再听/再识别；录音会话本身不可跨进程恢复）。 */
  clipId?: string;
  /** In-progress replacement reference; never presented as saved until its manifest is durable. */
  pendingClipId?: string;
  /** 已确认/识别的回答文字。 */
  text: string;
  /** 最近一次有效录音时长（毫秒，展示「已录 N 秒」用）。 */
  recordedMs?: number;
}

export const SPOKEN_GRADES: { grade: "forgot" | "hard" | "easy"; label: string; again: string }[] = [
  { grade: "forgot", label: "没记住", again: "10 分钟后再见" },
  { grade: "hard", label: "有点模糊", again: "明天再见" },
  { grade: "easy", label: "记住了", again: "7 天后再见" },
];

/* 自评三格副文与填空/听音同口径（原型 html:2954：10 分钟后再看 / 明天再看 / 几天后再看）。 */
const SPOKEN_GRADE_HINT: Record<"forgot" | "hard" | "easy", string> = { forgot: "10 分钟后再看", hard: "明天再看", easy: "几天后再看" };

export function SpokenReviewCard({
  card,
  state,
  patch,
  articles,
  onGrade,
  grading,
  hint,
  definition,
}: {
  card: ReviewCard;
  state: SpokenState;
  patch: (next: Partial<SpokenState>) => void;
  articles: Article[];
  onGrade: (g: "forgot" | "hard" | "easy") => void;
  grading: boolean;
  /** 提示盒（原型 .v2-hint-box 在题目块之后、自评之前，html:2952）。 */
  hint?: ReactNode;
  /** 目标词「词性 释义」行（原型 word.pos，如「n. 志愿者（复数）」，html:2933）；缺省用卡片释义。 */
  definition?: string;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recognizing, setRecognizing] = useState(false);
  const current = useRef<{ session: DurableRecording; repo: Repository; clipId: string; generation: number; startedAt: number } | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const playing = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const starting = useRef(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const finishRef = useRef<() => void>(() => {});
  const localRecording = useLocalRecording(activeRepository(), state.clipId, recording);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const pendingRecording = useLocalRecording(activeRepository(), state.pendingClipId, `${recording}:${recoveryTick}`);
  useEffect(() => {
    const clipId = state.pendingClipId, identity = activeRepository().identity;
    if (!clipId) return;
    const finalized = (event: Event) => {
      const detail = (event as CustomEvent<{ identity: string; clipId: string }>).detail;
      if (detail?.identity === identity && detail.clipId === clipId) setRecoveryTick(tick => tick + 1);
    };
    // A previous mounted card may still be finalizing its native recording.
    // Re-read on completion; a clip already finalized is found by the initial read.
    window.addEventListener(RECORDING_FINALIZED, finalized);
    return () => window.removeEventListener(RECORDING_FINALIZED, finalized);
  }, [state.pendingClipId]);
  useEffect(() => {
    if (recording || busy || !state.pendingClipId || !pendingRecording) return;
    patch({ clipId: pendingRecording.clipId, recordedMs: pendingRecording.durationMs, pendingClipId: undefined, stage: "confirm" });
  }, [state.pendingClipId, pendingRecording, recording, busy, patch]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      preparation.current?.abort();
      request.current?.abort();
      playing.current?.();
      const active = current.current;
      current.current = null;
      if (active) void active.session.stop().catch(() => undefined).finally(() => notifyRecordingFinalized(active.repo, active.clipId));
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - (current.current?.startedAt ?? Date.now())) / 1000);
      setSeconds(elapsed);
      if (elapsed >= 45) finishRef.current();
    }, 200);
    return () => window.clearInterval(timer);
  }, [recording]);

  /** 录音（与 LearningPractice.startRecord 同管线：durable 分片 + 电平回调 + 云代数守卫）。 */
  async function beginRecording() {
    if (busy || recording || recognizing || starting.current || current.current) return;
    starting.current = true;
    const controller = new AbortController(); preparation.current = controller;
    setBusy("正在打开麦克风");
    setError("");
    try {
      if (!await ensureAccount({ reason: "spoken-review" })) {
        if (mounted.current) setError("未登录不能使用语音识别，可以先用文字回答。");
        return;
      }
      if (!mounted.current || controller.signal.aborted) return;
      const repo = activeRepository();
      const clipId = practiceId("clip");
      playing.current?.(); playing.current = null; stopSpeak();
      const session = await startDurableRecording(repo, clipId, { review: "spoken", wordId: card.id, word: card.word }, () => undefined, controller.signal);
      if (!mounted.current || repo !== activeRepository()) {
        await session.stop();
        return;
      }
      current.current = { session, repo, clipId, generation: cloudState().generation, startedAt: Date.now() };
      setRecoveryTick(0);
      patch({ pendingClipId: clipId });
      setSeconds(0);
      setRecording(true);
    } catch (failure) {
      if (mounted.current) setError(practiceError(failure));
    } finally {
      if (preparation.current === controller) preparation.current = null;
      starting.current = false;
      if (mounted.current) setBusy("");
    }
  }

  async function stopRecord() {
    const active = current.current;
    if (!active || busy) return;
    setBusy("正在保存原声");
    setError("");
    let recorded = false;
    try {
      current.current = null;
      setRecording(false);
      const result = await active.session.stop();
      if (active.generation !== cloudState().generation || !mounted.current) return;
      recorded = true;
      patch({ clipId: active.clipId, recordedMs: result.ms, pendingClipId: undefined });
      if (result.peak < 0.01 || result.ms < 350) {
        setError("声音太轻或录音太短，原声已保留。可以重新说一句，或改用文字回答。");
        return;
      }
      await recognize(active.clipId, active.repo, true);
    } catch (failure) {
      if (mounted.current && !recorded) { patch({ pendingClipId: undefined }); setError(practiceError(failure)); }
      else if (mounted.current) patch({ stage: "confirm" });
    } finally {
      notifyRecordingFinalized(active.repo, active.clipId);
      if (mounted.current) setBusy("");
    }
  }
  finishRef.current = () => { void stopRecord(); };

  async function discardRecord() {
    const active = current.current;
    if (!active || busy) return;
    setBusy("正在取消录音");
    try {
      current.current = null;
      setRecording(false);
      await active.session.discard();
      if (mounted.current) patch({ pendingClipId: undefined, ...(active.clipId === state.clipId ? { clipId: undefined } : {}) });
    } catch (failure) {
      if (mounted.current) setError(practiceError(failure));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  /** ASR 识别已保存的原声（带超时/取消：AbortController；迟到结果按云代数丢弃）。 */
  async function recognize(clipId: string, repo = activeRepository(), afterRecording = false) {
    if (recognizing || busy && !afterRecording) return;
    if (!await ensureAccount({ reason: "spoken-review" })) {
      if (mounted.current) setError("未登录不能使用语音识别，可以先核对或改写文字。");
      return;
    }
    setRecognizing(true);
    setError("");
    const generation = cloudState().generation;
    const controller = new AbortController();
    request.current = controller;
    try {
      const text = await transcribeRecording(repo, clipId, controller.signal);
      if (!mounted.current || generation !== cloudState().generation || controller.signal.aborted) return;
      patch({ stage: "confirm", text });
    } catch (failure) {
      if (!mounted.current || generation !== cloudState().generation) return;
      setError(practiceError(failure));
      patch({ stage: "confirm" });
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current) setRecognizing(false);
    }
  }

  const listenOriginal = async () => {
    if (!state.clipId) return;
    setBusy("正在打开原声");
    try {
      playing.current?.();
      playing.current = await playOriginal(activeRepository(), state.clipId);
    } catch (failure) {
      if (mounted.current) setError(practiceError(failure));
    } finally {
      if (mounted.current) setBusy("");
    }
  };

  const listenDraft = async () => {
    setBusy("正在朗读草稿");
    try {
      playing.current?.();
      speak(state.text, 0.95);
    } finally {
      if (mounted.current) setBusy("");
    }
  };

  const source = card.articleId ? articles.find((a) => a.id === card.articleId)?.sentences[card.sentIdx] : undefined;
  const recordedSeconds = localRecording ? Math.max(1, Math.round(localRecording.durationMs / 1000)) : 0;
  const goTextAnswer = () => draftRef.current?.focus();

  return (
    <>
      <span className="v2-eyebrow">用这个表达，说一个关于自己的句子</span>
      <div className="v2-speaking-target" lang="en">
        {card.word}
      </div>
      <p className="v2-learning-copy" style={{ margin: "6px 0 0" }}>
        {definition || card.hint}
      </p>
      {error && (
        <>
          <p className="learning-notice" role="alert" style={{ textAlign: "left" }}>{error}</p>
          {!recording && <button className="btn-ghost" disabled={Boolean(busy) || recognizing} onClick={goTextAnswer}>用文字回答</button>}
        </>
      )}

      {/* 录音盒（原型 .v2-speaking-recorder，html:2933）：非录音中常驻——已录（有原声）显示
          「重新录一次」+「已录 N 秒，请确认刚才说的内容。」，确认后仍保留（原型 confirmed 态同屏）。
          「听我的原声 / 重新识别原声」只在出错时出现（声音太轻/识别失败的恢复路径）。 */}
      {!recording && (
        <div className="v2-speaking-recorder">
          <button className="btn" style={{ width: "100%" }} disabled={Boolean(busy) || recognizing} onClick={() => void beginRecording()}>
            <Icon name="mic" size={15} />
            {localRecording ? "重新录一次" : "录音试说"}
          </button>
          <p className="v2-learning-caption" style={{ margin: "9px 0 0" }}>
            {localRecording?.status === "ready" ? `已录 ${recordedSeconds} 秒，请确认刚才说的内容。` : localRecording ? "有一段中断的原声，可以尝试恢复或重新录一句。" : "只需一句，提示可以一直展开。"}
          </p>
          {localRecording && error && !recognizing && (
            <div className="v2-learning-actions" style={{ marginTop: 10 }}>
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={Boolean(busy)} onClick={() => void listenOriginal()}>
                <Icon name="play" size={14} />
                听我的原声
              </button>
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={Boolean(busy)} onClick={() => void recognize(state.clipId!)}>
                {localRecording.status === "ready" ? "重新识别原声" : "尝试恢复原声"}
              </button>
            </div>
          )}
        </div>
      )}

      {recording && (
        <div className="v2-speaking-recorder is-recording">
          <div className="v2-review-wave" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i>
          </div>
          <b>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</b>
          <p>说完后点结束，确认刚才的内容。</p>
          <div className="v2-learning-actions">
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={Boolean(busy)} onClick={() => void discardRecord()}>
              取消
            </button>
            <button className="btn" disabled={Boolean(busy)} onClick={() => void stopRecord()}>
              结束录音
            </button>
          </div>
        </div>
      )}

      {/* 草稿区（原型 html:2934）：label 随已录态切换 + 填入示例草稿/保存草稿 双钮常驻；
          已录 → 「确认回答，核对用法」主钮（草稿为空时禁用），未录 → 保留说明。确认后仍可改写。 */}
      {!recording && (
        <div style={{ marginTop: 4 }}>
          <label htmlFor="v2-review-speaking-draft" className="v2-draft-label">
            {localRecording ? "确认或改写我的回答" : "先写一份草稿"}
          </label>
          <textarea
            ref={draftRef}
            id="v2-review-speaking-draft"
            className="input"
            rows={3}
            maxLength={900}
            value={state.text}
            disabled={Boolean(busy)}
            placeholder="试着用上这个表达…"
            onChange={(e) => patch({ text: e.target.value })}
            style={{ width: "100%" }}
          />
          <div className="v2-learning-actions">
            {source && (
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => patch({ text: source.en })}>
                填入示例草稿
              </button>
            )}
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => toast(state.text.trim() ? "草稿已保存在本轮复习里" : "先写下一句，再保存草稿")}>
              保存草稿
            </button>
          </div>
          {localRecording ? (
            <button className="btn v2-learning-secondary" style={{ width: "100%" }} disabled={Boolean(busy) || recognizing || !state.text.trim()} onClick={() => patch({ stage: "check" })}>
              确认回答，核对用法
            </button>
          ) : (
            <p className="v2-learning-caption" style={{ textAlign: "left" }}>
              草稿会保留；完成录音并确认回答后，才记录为开口练习。
            </p>
          )}
          {recognizing && (
            <p className="meta" role="status" style={{ textAlign: "left" }}>
              正在识别这次录音…
            </p>
          )}
        </div>
      )}

      {/* 「你的回答」卡（原型 .rv-ex，html:2935）：确认后出现——标签 + 衬线回答 + 🔊听这份草稿 */}
      {state.stage === "check" && !recording && (
        <div className="rv-ex v2-speak-answer rv-flip">
          <b>你的回答</b>
          <div className="en" lang="en">
            {state.text}
          </div>
          <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} disabled={Boolean(busy)} onClick={() => void listenDraft()}>
            <Icon name="speaker" size={14} />
            听这份草稿
          </button>
        </div>
      )}

      {!recording && hint}

      {/* 三档自评（原型 .v2-self-grade，html:2954）：确认回答后出现 */}
      {state.stage === "check" && !recording && (
        <div className="v2-self-grade rv-flip">
          <p>你这次回忆得怎么样？</p>
          <div className="grades v2-review-grades">
            {SPOKEN_GRADES.map((g) => (
              <button key={g.grade} className="grade" disabled={grading || Boolean(busy)} onClick={() => onGrade(g.grade)}>
                <span className="g1">{g.label}</span>
                <span className="g2">{SPOKEN_GRADE_HINT[g.grade]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!recording && busy && (
        <p className="meta" role="status" style={{ textAlign: "center", marginTop: 10 }}>
          {busy}…
        </p>
      )}

    </>
  );
}
