/**
 * 屏 E · 口语陪练 MVP（R3）：我说 → AI 答 → 我跟读。
 *
 * 对话环：按住说话（micRecorder 16k PCM）→ 讯飞流式听写（xfyunAsr，en_us）
 * → LLM 以场景角色回复（translate_stream，EN+ZH 两行格式）→ 解析后 TTS 播报
 * 英文 → 每轮 assistant 可「跟读」送 ISE 打分。会话本地保存（speak_store），
 * 入口页可重开上次对话。
 *
 * 降级原则：断麦/断网/凭据缺失都给中文提示 + 逃生门（重试/文字兜底），不卡死。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  difficultyOf,
  lastAssistantText,
  newSpeakSession,
  parseAssistantReply,
  scenarioOf,
  SPEAK_DIFFICULTIES,
  SPEAK_SCENARIOS,
  type SpeakDifficulty,
  type SpeakScenarioId,
  type SpeakSession,
} from "../core/speakLogic";
import { transcribeSpeech } from "../core/xfyunAsr";
import { evaluateSentence, isPass, type PronunciationResult } from "../core/pronunciation";
import { startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";
import { loadAsrCredentials, loadIseCredentials } from "../lib/iseCredentials";
import { speakListSessions, speakSaveSession } from "../lib/speakStore";
import { cancelTranslation, openSettings } from "../lib/tauriBridge";
import type { NoteTranslateFn } from "./VocabNoteDialog";

/** 一轮里的阶段（主对话环）。 */
type RoundPhase =
  | "idle" // 等用户按住说话
  | "recording" // 按住说话中
  | "asr" // 识别转写中
  | "thinking" // LLM 回复生成中（流式）
  | "speaking" // TTS 播报中
  | "error"; // 本轮失败（显示重试）

/** 跟读子状态（独立于主环，只对最新 assistant 轮开放）。 */
type ShadowPhase = "idle" | "recording" | "evaluating" | "done" | "error";

const MAX_UTTERANCE_MS = 15000;
const MIN_UTTERANCE_SAMPLES = 16000 * 0.5;

interface Props {
  requestTranslate: NoteTranslateFn;
  /** TTS 播英文（speechEngine dispatcher 的 speak），resolve 本次朗读代数（配对 tts:ended）。 */
  speakEn: (text: string) => Promise<number>;
  /** 订阅朗读结束事件（返回取消订阅函数；sentence/word 轨都会到达，自行按 track 过滤）。 */
  subscribeSpeakEnded: (handler: (e: { gen: number; track: string }) => void) => () => void;
  /** 停 TTS。 */
  stopSpeak: () => void;
  micDeviceId: string;
  onToast: (msg: string) => void;
  /** 回书架（口语页没有左栏，给一个明确的返回位）。 */
  onBack?: () => void;
}

export function SpeakView({
  requestTranslate,
  speakEn,
  subscribeSpeakEnded,
  stopSpeak,
  micDeviceId,
  onToast,
  onBack,
}: Props) {
  const [session, setSession] = useState<SpeakSession | null>(null);
  const [difficulty, setDifficulty] = useState<SpeakDifficulty>("medium");
  const [recent, setRecent] = useState<SpeakSession[]>([]);
  const [phase, setPhase] = useState<RoundPhase>("idle");
  const [roundError, setRoundError] = useState("");
  const [liveReply, setLiveReply] = useState("");
  const [shadow, setShadow] = useState<{ phase: ShadowPhase; score: number | null; error: string }>({
    phase: "idle",
    score: null,
    error: "",
  });
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MicRecorderHandle | null>(null);
  const shadowRecorderRef = useRef<MicRecorderHandle | null>(null);
  /** 轮次纪元：换场景/跳过/卸载时自增，旧轮的异步结果一律丢弃。 */
  const epochRef = useRef(0);
  /** LLM 请求 tag 序号（只保证唯一，不作失效判定）。 */
  const tagRef = useRef(0);
  /** 在途 LLM 请求的 tag：「跳过回复」只掐掉自己的流，不误伤并发的其他翻译。 */
  const activeTagRef = useRef("");
  /** getUserMedia 授权等待期就松开了按住按钮：录音器就绪后直接丢弃。 */
  const releasePendingRef = useRef(false);
  const shadowReleasePendingRef = useRef(false);
  /** 本轮主对话已收尾（finishUtterance 已取走录音器）：迟到的 mouseup/mouseleave 忽略。 */
  const finishingRef = useRef(false);
  const sessionRef = useRef<SpeakSession | null>(null);
  sessionRef.current = session;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 本组件最近一次朗读的代数；null = 当前没有由本组件发起、尚未终结的朗读。 */
  const speakGenRef = useRef<number | null>(null);
  /** speak 已发出但代数还没拿回（云引擎要等合成完才 resolve）。 */
  const speakPendingRef = useRef(false);

  // 挂载时拉历史会话（入口页「重开上次对话」）
  useEffect(() => {
    void speakListSessions()
      .then((list) => setRecent(list.slice(0, 5)))
      .catch(() => undefined);
  }, []);

  // 新消息后贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, liveReply, phase]);

  // TTS 播完（或被打断/失败）→ speaking 回 idle。按 gen 配对丢弃过期事件；
  // 等代数期间到达的 ended 若匹配旧代数，是新朗读打断旧朗读的收尾，忽略；
  // 其余（合成失败等）视为本次朗读已终结，同样回收状态。
  useEffect(
    () =>
      subscribeSpeakEnded(({ gen, track }) => {
        if (track !== "sentence") return;
        const cur = speakGenRef.current;
        if (speakPendingRef.current) {
          if (cur !== null && gen === cur) return;
        } else if (cur === null || cur !== gen) {
          return; // 过期事件，或别人（如阅读室播放）的事件
        }
        speakPendingRef.current = false;
        speakGenRef.current = null;
        setPhase((p) => (p === "speaking" ? "idle" : p));
      }),
    [subscribeSpeakEnded],
  );

  /** 播一句 AI 英语并推进状态机：speaking →（tts:ended）→ idle。开场白/回复/重听共用。 */
  const speakRound = useCallback(
    (text: string) => {
      setPhase("speaking");
      speakPendingRef.current = true;
      void speakEn(text)
        .then((gen) => {
          if (!speakPendingRef.current) return; // 期间已经 ended（快速失败等），不再记录
          speakPendingRef.current = false;
          speakGenRef.current = gen;
        })
        .catch((e) => {
          speakPendingRef.current = false;
          speakGenRef.current = null;
          setPhase((p) => (p === "speaking" ? "idle" : p));
          onToast(`朗读失败：${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [speakEn, onToast],
  );

  const persist = useCallback((next: SpeakSession) => {
    void speakSaveSession(next)
      .then(() => speakListSessions().then((l) => setRecent(l.slice(0, 5))).catch(() => undefined))
      .catch(() => undefined);
  }, []);

  const start = useCallback(
    (scenario: SpeakScenarioId, difficulty: SpeakDifficulty) => {
      stopSpeak();
      epochRef.current += 1;
      const s = newSpeakSession(scenario, difficulty);
      setSession(s);
      setRoundError("");
      setShadow({ phase: "idle", score: null, error: "" });
      // 开场白直接播报
      speakRound(s.turns[0].text);
      persist(s);
    },
    [persist, speakRound, stopSpeak],
  );

  const resume = useCallback(
    (s: SpeakSession) => {
      stopSpeak();
      epochRef.current += 1;
      setSession(s);
      setPhase("idle");
      setRoundError("");
      setShadow({ phase: "idle", score: null, error: "" });
    },
    [stopSpeak],
  );

  /** 结束录音并推进一轮：ASR → LLM → 解析 + TTS。 */
  const finishUtterance = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || finishingRef.current) return;
    finishingRef.current = true;
    recorderRef.current = null;
    const epoch = ++epochRef.current;
    setPhase("asr");
    setRoundError("");
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (e) {
      setPhase("error");
      setRoundError(e instanceof Error ? e.message : String(e));
      return;
    }
    // 静音兜底：没说到话不算一轮
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < MIN_UTTERANCE_SAMPLES) {
      setPhase("idle");
      onToast("没听到声音——离麦克风近一点再说一次");
      return;
    }
    const creds = await loadAsrCredentials().catch(() => null);
    if (!creds) {
      setPhase("error");
      setRoundError("未配置讯飞听写凭据：到 设置 → 语音 里填一次（或复用跟读评测那组）");
      return;
    }
    let userText: string;
    try {
      userText = await transcribeSpeech(pcm, "en_us", creds);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setPhase("error");
      setRoundError(`语音识别失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (epochRef.current !== epoch) return;
    if (!userText) {
      setPhase("idle");
      onToast("没识别出内容，再试一次（尽量用完整的英语句子）");
      return;
    }

    // 记用户轮（会话先落盘，LLM 失败也不丢用户发言）
    const cur = sessionRef.current;
    if (!cur) return;
    const withUser: SpeakSession = {
      ...cur,
      turns: [...cur.turns, { role: "user", text: userText, at: Date.now() }],
      updatedAt: Date.now(),
    };
    setSession(withUser);
    sessionRef.current = withUser;
    persist(withUser);

    // LLM 回复（流式上屏）
    setPhase("thinking");
    setLiveReply("");
    const tag = `spk${++tagRef.current}`;
    activeTagRef.current = tag;
    const res = await requestTranslate(
      buildSpeakUserInput(withUser.turns.slice(0, -1), userText),
      buildSpeakSystemPrompt(withUser.scenario, withUser.difficulty),
      tag,
      (t) => setLiveReply(t),
    );
    if (epochRef.current !== epoch) return; // 已换场景/跳过：丢弃旧轮结果
    if (res.status === "error") {
      setPhase("error");
      setRoundError(`回复生成失败：${res.text}`);
      return;
    }
    const reply = parseAssistantReply(res.text);
    if (!reply.en) {
      setPhase("error");
      setRoundError("回复格式异常，重试一次");
      return;
    }
    const withAssistant: SpeakSession = {
      ...withUser,
      turns: [
        ...withUser.turns,
        { role: "assistant", text: reply.en, hintZh: reply.zh, at: Date.now() },
      ],
      updatedAt: Date.now(),
    };
    setSession(withAssistant);
    sessionRef.current = withAssistant;
    persist(withAssistant);
    setLiveReply("");
    setShadow({ phase: "idle", score: null, error: "" });
    speakRound(reply.en);
  }, [onToast, persist, requestTranslate, speakRound]);

  /** 按住说话：按下开录（播报中按下 = 打断播报插话），松开结束进 ASR。 */
  const pressStart = useCallback(() => {
    if (phase !== "idle" && phase !== "error" && phase !== "speaking") return;
    if (shadow.phase === "recording" || shadow.phase === "evaluating") return; // 跟读占用麦克风
    if (phase === "error") setRoundError("");
    stopSpeak();
    setPhase("recording");
    setLevel(0);
    releasePendingRef.current = false;
    finishingRef.current = false;
    void (async () => {
      try {
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level, elapsedMs }) => {
            setLevel(level);
            if (elapsedMs >= MAX_UTTERANCE_MS) void finishUtterance();
          },
        });
        if (releasePendingRef.current) {
          // 授权等待期用户已松开：这轮作废，不留悬空录音
          releasePendingRef.current = false;
          recorder.cancel();
          return;
        }
        recorderRef.current = recorder;
      } catch (e) {
        const dom = e as DOMException;
        setPhase("error");
        setRoundError(`麦克风打不开（${dom?.name ?? "错误"}）：${dom?.message ?? e}`);
      }
    })();
  }, [phase, shadow.phase, micDeviceId, finishUtterance, stopSpeak]);

  const pressEnd = useCallback(() => {
    if (phase !== "recording") return;
    if (finishingRef.current) return; // 本轮已收尾，忽略迟到的 mouseup/mouseleave
    if (!recorderRef.current) {
      // 录音器还在等授权：标记后由 pressStart 的续体丢弃
      releasePendingRef.current = true;
      setPhase("idle");
      return;
    }
    void finishUtterance();
  }, [phase, finishUtterance]);

  /** 跳过等待中的 LLM 回复（长等待逃生门）。 */
  const skipReply = useCallback(() => {
    epochRef.current += 1;
    if (activeTagRef.current) void cancelTranslation(activeTagRef.current);
    setLiveReply("");
    setPhase("idle");
    setRoundError("已跳过这次回复，接着说下一句");
  }, []);

  // ---- 跟读（最新 assistant 轮，ISE 打分） ----
  const shadowTarget = useMemo(
    () => (session ? lastAssistantText(session.turns) : null),
    [session],
  );

  const startShadow = useCallback(() => {
    if (!shadowTarget || shadow.phase === "recording" || shadow.phase === "evaluating") return;
    if (phase !== "idle" && phase !== "speaking" && phase !== "error") return;
    stopSpeak();
    setShadow({ phase: "recording", score: null, error: "" });
    setLevel(0);
    shadowReleasePendingRef.current = false;
    void (async () => {
      try {
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level, elapsedMs }) => {
            setLevel(level);
            if (elapsedMs >= MAX_UTTERANCE_MS) void finishShadow();
          },
        });
        if (shadowReleasePendingRef.current) {
          // 授权等待期用户已点了结束：这次跟读作废
          shadowReleasePendingRef.current = false;
          recorder.cancel();
          return;
        }
        shadowRecorderRef.current = recorder;
      } catch (e) {
        const dom = e as DOMException;
        setShadow({ phase: "error", score: null, error: `麦克风打不开：${dom?.message ?? e}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowTarget, shadow.phase, phase, micDeviceId, stopSpeak]);

  const finishShadow = useCallback(async () => {
    const rec = shadowRecorderRef.current;
    if (!rec) {
      // 只处理「授权等待期就点了结束」；mouseup+click 双触发的第二次调用直接忽略
      setShadow((s) => {
        if (s.phase !== "recording") return s;
        shadowReleasePendingRef.current = true;
        return { phase: "idle", score: null, error: "" };
      });
      return;
    }
    shadowRecorderRef.current = null;
    const target = shadowTarget;
    if (!target) return;
    setShadow({ phase: "evaluating", score: null, error: "" });
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (e) {
      setShadow({ phase: "error", score: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < MIN_UTTERANCE_SAMPLES) {
      setShadow({ phase: "error", score: null, error: "没听到声音，离麦克风近一点" });
      return;
    }
    const creds = await loadIseCredentials().catch(() => null);
    if (!creds) {
      setShadow({ phase: "error", score: null, error: "未配置讯飞评测凭据：设置 → 语音" });
      return;
    }
    let result: PronunciationResult;
    try {
      result = await evaluateSentence(pcm, target, creds);
    } catch (e) {
      setShadow({ phase: "error", score: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const score = result.total;
    setShadow({ phase: "done", score, error: "" });
    // 分数回写会话（找到最后一个 assistant 轮）
    const cur = sessionRef.current;
    if (cur && cur.turns.length > 0) {
      const turns = [...cur.turns];
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === "assistant") {
          turns[i] = { ...turns[i], shadowScore: score };
          break;
        }
      }
      const next = { ...cur, turns, updatedAt: Date.now() };
      setSession(next);
      sessionRef.current = next;
      persist(next);
    }
    if (!isPass(result, 4.2)) {
      onToast(`跟读 ${score.toFixed(1)} 分：对照高亮再试一次会更好`);
    }
  }, [shadowTarget, persist, onToast]);

  // 组件卸载/切视图时收麦停声。stopSpeak 走 ref、依赖恒为 []：
  // 若直接依赖 prop，ReaderApp 的任何重渲染（翻译流式 delta、自动保存等）
  // 都会执行 cleanup，掐断进行中的录音，松开时报「录音已结束」。
  const stopSpeakRef = useRef(stopSpeak);
  stopSpeakRef.current = stopSpeak;
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      recorderRef.current?.cancel();
      shadowRecorderRef.current?.cancel();
      stopSpeakRef.current();
    };
  }, []);

  // ---- 入口页（未开始会话） ----
  if (!session) {
    return (
      <div className="speak-page">
        {onBack && (
          <button className="speak-back" onClick={onBack}>
            ‹ 返回书架
          </button>
        )}
        <div className="speak-hero">
          <h3>口语陪练</h3>
          <p>选个场景开口说：你说话 → AI 用英语接 → 听不懂就看中文提示，还能跟读打分</p>
        </div>
        <div className="speak-scenario-grid">
          {SPEAK_SCENARIOS.map((s) => (
            <button key={s.id} className="speak-scenario-card" onClick={() => start(s.id, difficulty)}>
              <span className="emoji" aria-hidden>
                {s.emoji}
              </span>
              <span className="t">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="speak-diff-row">
          <span className="speak-goal-label">难度：</span>
          {SPEAK_DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              className={`speak-diff-chip${d.id === difficulty ? " on" : ""}`}
              title={d.note}
              onClick={() => setDifficulty(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="speak-recent">
          {recent.length > 0 && <div className="speak-recent-title">上次的对话</div>}
          {recent.slice(0, 3).map((s) => (
            <button key={s.id} className="speak-recent-row" onClick={() => resume(s)}>
              <span className="emoji" aria-hidden>
                {scenarioOf(s.scenario).emoji}
              </span>
              <span className="t">
                {scenarioOf(s.scenario).label} · {difficultyOf(s.difficulty).label} · {s.turns.length} 轮
              </span>
              <span className="when">
                {new Date(s.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const sc = scenarioOf(session.scenario);
  // speaking 不算 busy：按住说话可打断播报插话
  const busy = phase === "recording" || phase === "asr" || phase === "thinking";

  // ---- 对话页 ----
  return (
    <div className="speak-room">
      <div className="speak-room-head">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            epochRef.current += 1;
            stopSpeak();
            setSession(null);
            setPhase("idle");
          }}
        >
          ← 换场景
        </button>
        <span className="speak-room-title">
          {sc.emoji} {sc.label} · {difficultyOf(session.difficulty).label}
        </span>
        <span className="speak-round-count">第 {Math.ceil(session.turns.length / 2)} 轮</span>
      </div>

      <div className="speak-log" ref={scrollRef}>
        {session.turns.map((t, i) => (
          <div key={i} className={`speak-bubble ${t.role}`}>
            {t.role === "assistant" ? (
              <>
                <div className="en serif">{t.text}</div>
                {t.hintZh && <div className="zh">{t.hintZh}</div>}
                {typeof t.shadowScore === "number" && i === session.turns.length - 1 && (
                  <div className="speak-shadow-score">跟读 {t.shadowScore.toFixed(1)} / 5</div>
                )}
              </>
            ) : (
              <div className="en">{t.text}</div>
            )}
          </div>
        ))}
        {phase === "thinking" && (
          <div className="speak-bubble assistant live">
            <div className="en serif">{liveReply || "…在想你该怎么说…"}</div>
          </div>
        )}
        {phase === "asr" && <div className="speak-bubble user live">…识别你刚才说的…</div>}
      </div>

      {roundError && (
        <div className="speak-error">
          {roundError}
          <button className="btn btn-secondary btn-sm" onClick={() => { setRoundError(""); setPhase("idle"); }}>
            知道了
          </button>
        </div>
      )}

      <div className="speak-controls">
        <div className="speak-level-bar" aria-hidden>
          <i style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
        </div>
        <div className="speak-controls-row">
          <button
            className={`speak-hold-btn${phase === "recording" ? " rec" : ""}${
              phase === "asr" || phase === "thinking" ? " disabled" : ""
            }`}
            onMouseDown={pressStart}
            onMouseUp={pressEnd}
            onMouseLeave={phase === "recording" ? pressEnd : undefined}
            onTouchStart={(e) => {
              e.preventDefault();
              pressStart();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              pressEnd();
            }}
          >
            {phase === "recording"
              ? "松开结束"
              : phase === "asr"
                ? "识别中…"
                : phase === "thinking"
                  ? "对方回复中…"
                  : phase === "speaking"
                    ? "对方说话中 · 可插话"
                    : "按住说话"}
          </button>
          {phase === "thinking" && (
            <button className="btn btn-secondary" onClick={skipReply}>
              跳过回复
            </button>
          )}
          <button
            className="btn btn-secondary"
            disabled={!shadowTarget || busy || shadow.phase === "evaluating"}
            onClick={shadow.phase === "recording" ? finishShadow : startShadow}
            onMouseUp={shadow.phase === "recording" ? finishShadow : undefined}
            title="照着 AI 最新一句读，讯飞评测打分"
          >
            {shadow.phase === "recording"
              ? "松开结束跟读"
              : shadow.phase === "evaluating"
                ? "评分中…"
                : shadow.phase === "done"
                  ? `跟读 ${shadow.score?.toFixed(1)} 分 · 再跟读`
                  : shadow.phase === "error"
                    ? `跟读失败 · 重试（${shadow.error}）`
                    : "跟读打分"}
          </button>
          <button
            className="speak-replay"
            disabled={!shadowTarget || busy}
            onClick={() => shadowTarget && speakRound(shadowTarget)}
            title="重听 AI 这句（播完自动回到「按住说话」）"
          >
            🔊 重听
          </button>
        </div>
        {shadow.phase === "error" && <div className="speak-shadow-err">{shadow.error}</div>}
        <div className="speak-hint">
          按住说话（英语）→ AI 回复带中文提示；「跟读打分」照 AI 最新一句读，5 分制
        </div>
        <button
          className="speak-creds-toggle"
          onClick={() => void openSettings().catch(() => undefined)}
          title="讯飞评测/听写凭据在主窗口 设置 → 语音 里集中配置"
        >
          讯飞凭据设置
        </button>
      </div>
    </div>
  );
}
