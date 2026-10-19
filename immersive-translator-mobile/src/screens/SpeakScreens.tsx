/**
 * 口语陪练（push）—— §3.11：场景页 + 对话页（B1 真实链路实化）。
 * 对话页：首轮 opener 真人开场并朗读（store.speak 已云路由）；按住说话 =
 * startPcmCapture + createAsrSession 流式听写（<350ms 误触 toast；峰值<0.01 或
 * <250ms 不烧识别，SpeakViewController.swift:150-159）；识别文本入轮 →
 * chatStream 流式回复（每 delta parseAssistantReply 整体覆盖 typing 气泡，
 * :205-211 口径）→ 落正式轮；语音不等全文——流中凑满一句即预取合成并按序播
 * （createSentenceFeeder + 句队，见 requestReply）。打字模式同链路；LLM 失败横幅+重试；
 * 无 Key/无讯飞凭据如实降级（不放剧本）；15s 按住上限自动断；新按住打断播报；
 * resume 只还原真实对话（无剧本位置，「从第 N 轮继续」横幅已移除）。
 * pointerup/cancel 挂 document（useHold §6.1）；计时真实；结束摘要存档（#56）。
 */
import { useEffect, useRef, useState } from "react";
import { actions, speak, stopSpeak, toast } from "../store";
import { Icon } from "../ui/icons";
import { PNav, Seg, useHold } from "../ui/kit";
import { useNav } from "../ui/nav";
import { SPEAK_SCENES, type ChatTurn } from "../core/demo";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  createSentenceFeeder,
  parseAssistantReply,
  sceneMetaOf,
} from "../core/speak";
import {
  loadSpeakDiff,
  saveSpeakDiff,
  sessionWhen,
  useSpeakSessions,
  type SpeakSession,
} from "../core/sessions";
import { startPcmCapture, type Capture } from "../services/audio";
import { reportDiag } from "../services/device";
import { createAsrSession, prefetchCloud, voiceConfigured, type AsrSession } from "../services/voice";
import { chatStream, llmConfigured, type ChatStream } from "../services/translate";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* 按住会话的在途句柄（采集/听写共用一个相位，防 15s 自动断与松手双结算） */
interface HoldState {
  phase: "idle" | "holding" | "closing";
  startAt: number;
}

export function SpeakScenes() {
  const nav = useNav();
  const sessions = useSpeakSessions();
  const [diff, setDiff] = useState(loadSpeakDiff);
  return (
    <>
      <PNav title="口语陪练" onBack={() => nav.pop()} />
      <div className="pbody">
        <Seg
          value={diff}
          items={[
            ["easy", "入门"],
            ["medium", "进阶"],
            ["hard", "挑战"],
          ]}
          onChange={(v) => {
            setDiff(v);
            saveSpeakDiff(v);
          }}
        />
        <div className="meta" style={{ padding: "10px 2px 0" }}>
          难度影响陪练的用词与语速 · 四个场景均可从任意难度开始
        </div>
        <div style={{ marginTop: 8 }}>
          {SPEAK_SCENES.map((sc) => (
            <button key={sc.id} className="scene-row" onClick={() => nav.replace("chat", { scene: sc.id })}>
              <span className="scene-ic">
                <Icon name="chat" size={20} />
              </span>
              <span className="grow">
                <span className="scene-t" style={{ display: "block" }}>
                  {sc.label}
                </span>
                <span className="scene-d" style={{ display: "block" }}>
                  {sc.en} · 推荐 {sc.lv} · 约 {sc.turns} 轮
                </span>
              </span>
              <Icon name="right" size={15} />
            </button>
          ))}
        </div>
        <hr className="hr" style={{ marginTop: 2 }} />
        <div className="sec">
          <div className="overline">最近会话</div>
          {sessions.length ? (
            <div className="recent">
              {sessions.slice(0, 4).map((s) => (
                <button key={s.id} className="rc" onClick={() => nav.replace("chat", { scene: s.sceneId, resumeSession: s })}>
                  <div className="t">{s.scene}</div>
                  <div className="m">
                    {sessionWhen(s.at)} · {s.turns} 轮
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="meta" style={{ padding: "8px 0 2px" }}>
              还没有口语记录 · 完成一场陪练并保存，就会出现在这里
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export interface ChatProps {
  scene?: string;
  /** 真实存档会话：传入才还原对话（P-41：不传不声称续接；B1 起只还原 chat） */
  resumeSession?: SpeakSession;
}

export function SpeakChat({ scene = "ordering", resumeSession }: ChatProps) {
  const nav = useNav();
  const meta = sceneMetaOf(scene);
  /* 难度来自场景页三档选择（localStorage 记住上次；入门/进阶/挑战 → easy/medium/hard） */
  const [diff] = useState(loadSpeakDiff);
  const bodyRef = useRef<HTMLDivElement>(null);

  const saved = resumeSession && resumeSession.sceneId === meta.id ? resumeSession : undefined;
  const [turns, setTurns] = useState<ChatTurn[]>(() =>
    saved?.chat?.length ? saved.chat : [{ who: "ai", en: meta.opener, zh: meta.openerZh }],
  );
  /* turns 的 ref 单一真源：send/重试构 prompt 读它，不依赖渲染闭包（治 P-33 同源） */
  const turnsRef = useRef(turns);
  const startAt = useRef(Date.now());
  /* 流式回复气泡：null=不在思考；{en:"",zh:""} 命中后显示打字点，delta 到达后整体覆盖 */
  const [reply, setReply] = useState<{ en: string; zh: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [heard, setHeard] = useState("");
  const [typeMode, setTypeMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [micDenied, setMicDenied] = useState(false);
  const [fail, setFail] = useState<{ msg: string; retry?: () => void } | null>(null);

  const holdRef = useRef<HoldState>({ phase: "idle", startAt: 0 });
  const capRef = useRef<Capture | null>(null);
  const asrRef = useRef<AsrSession | null>(null);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<ChatStream | null>(null);

  useEffect(() => {
    if (!saved) speak(meta.opener, 0.95);
    return () => {
      stopSpeak();
      streamRef.current?.stop();
      if (capTimerRef.current) clearTimeout(capTimerRef.current);
      capRef.current?.cancel();
      asrRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, reply, recording, heard]);

  function commitTurns(next: ChatTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function openSummary() {
    stopSpeak();
    /* 掐掉在途 LLM 回复流（治 speak-1）：迟到的 onDone 会在摘要抽屉上层自动朗读 AI 回复，
       而摘要/存档用的是打开时刻的 turns 快照——这条迟到回复会永久丢失。
       与 skip()/beginHold 同款约定：stop + 清 reply，迟到回调被 chatStream 的 stopped 守卫丢弃。 */
    streamRef.current?.stop();
    streamRef.current = null;
    setReply(null);
    actions.setSheet({
      kind: "summary",
      sceneId: meta.id,
      scene: meta.label,
      turns: turnsRef.current.length,
      secs: Math.max(1, Math.round((Date.now() - startAt.current) / 1000)),
      me: turnsRef.current.filter((t) => t.who === "me").length,
      chat: turnsRef.current,
    });
  }

  /* ---------- LLM 回复（真实链路；无 Key 如实降级，不放剧本） ---------- */

  function requestReply(historyTurns: ChatTurn[], userText: string) {
    setFail(null);
    if (!llmConfigured()) return; /* 横幅由渲染层常驻提示（未配置模型服务） */
    streamRef.current?.stop();
    setReply({ en: "", zh: "" });
    /* 流式句队（治「回复看完了语音才慢慢出来」）：旧口径等 onDone 才整段 speak——
       整段 Edge 合成（全量 mp3 收完才返回）+ 整段解码，首声比文字晚好几秒。现在流中
       每凑满一句完整英文就 prefetchCloud 后台合成并入队按序播：首句出声 ≈ 首句合成
       耗时，后句合成与上句播放并行。走 store.speak 单句注册——按住说话/结束/跳过的
       stopSpeak、气泡重播的新 speak 都会顶掉队列推进（token 不匹配即断链，天然回收）。 */
    const feeder = createSentenceFeeder();
    const queue: string[] = [];
    let speaking = false;
    let queuedAny = false; /* 诊断面包屑：句队是否真的开跑（区分「队列没跑」与「播了没声」） */
    const speakNext = () => {
      if (speaking) return;
      const sent = queue.shift();
      if (!sent) return;
      speaking = true;
      speak(sent, 0.95, () => {
        speaking = false;
        speakNext();
      });
    };
    const enqueue = (sent: string) => {
      if (!queuedAny) {
        queuedAny = true;
        reportDiag("tts", `陪练句队开跑 · 首句「${sent.slice(0, 12)}${sent.length > 12 ? "…" : ""}」`);
      }
      prefetchCloud(sent, undefined, 0.95); /* 与 speak(sent, 0.95) 同键：命中缓存/在途共享 */
      queue.push(sent);
      speakNext();
    };
    const system = buildSpeakSystemPrompt(meta.id, diff);
    const content = buildSpeakUserInput(historyTurns, userText);
    const stream = chatStream(system, [{ role: "user", content }], {
      onDelta: (cum) => {
        const p = parseAssistantReply(cum);
        setReply(p);
        if (p.en) for (const s of feeder.feed(p.en)) enqueue(s);
      },
      onDone: (full) => {
        streamRef.current = null;
        setReply(null);
        const p = parseAssistantReply(full);
        if (!p.en.trim()) {
          setFail({ msg: "模型没有返回有效回复，再试一次", retry: () => requestReply(historyTurns, userText) });
          return;
        }
        commitTurns([...turnsRef.current, { who: "ai", en: p.en, zh: p.zh || undefined }]);
        for (const s of feeder.finish(p.en)) enqueue(s); /* 尾句补进队列，不再整段 speak */
      },
      onFail: (msg) => {
        streamRef.current = null;
        setReply(null);
        setFail({ msg, retry: () => requestReply(historyTurns, userText) });
      },
    });
    streamRef.current = stream;
  }

  function appendUser(text: string) {
    if (!llmConfigured()) {
      /* 未配置模型直接拦截（治 speak-5）：消息入轮后 requestReply 静默 return，
         每条消息石沉大海、只剩顶部常驻条幅太被动。对齐 beginHold 的拦截惯例：
         toast 引导去配置，消息不入轮。 */
      toast("模型服务未连接 · AI 暂时无法回复", { action: "去配置", onAction: () => nav.push("setModel") });
      return;
    }
    const history = turnsRef.current;
    commitTurns([...history, { who: "me", en: text }]);
    requestReply(history, text);
  }

  /* ---------- 按住说话（唯一录音手势；document 委托在 useHold 内） ---------- */

  function beginHold() {
    if (!voiceConfigured()) {
      toast("未配置语音识别 · 可打字继续");
      return;
    }
    if (holdRef.current.phase !== "idle") return; /* 重入守卫（治 speak-2）：双指误触同一按钮
       触发两次 pointerdown，第一轮 capture/asr 会被 ref 覆写后永不回收（麦克风轨道、
       Tauri 监听器泄漏）。已在按住/收尾中：忽略后续按下。 */
    setFail(null);
    setMicDenied(false);
    setHeard("");
    stopSpeak(); /* 新按住打断播报；同时掐掉在途回复（用户开口即插话） */
    streamRef.current?.stop();
    streamRef.current = null;
    setReply(null);
    holdRef.current = { phase: "holding", startAt: Date.now() };
    setRecording(true);
    const asr = createAsrSession("en_us", { onDelta: (t) => setHeard(t) });
    asrRef.current = asr;
    void startPcmCapture({ onChunk: (b64) => asr.push(b64) }).then((cap) => {
      if (holdRef.current.phase !== "holding") {
        cap?.cancel(); /* 松手早于就绪：本次已作废 */
        return;
      }
      if (!cap) {
        asr.abort();
        if (asrRef.current === asr) asrRef.current = null;
        holdRef.current.phase = "idle";
        setRecording(false);
        setMicDenied(true);
        return;
      }
      capRef.current = cap;
      /* 15s 按住上限：到点自动结算（SpeakViewController.swift:112-114 口径） */
      capTimerRef.current = setTimeout(() => endHold(15000), 15000);
    });
  }

  async function endHold(ms: number) {
    if (holdRef.current.phase !== "holding") return;
    if (capTimerRef.current) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
    const asr = asrRef.current;
    const cap = capRef.current;
    asrRef.current = null;
    capRef.current = null;
    holdRef.current.phase = "closing";
    setRecording(false);
    const settle = () => {
      holdRef.current.phase = "idle";
    };
    if (ms < 0) {
      /* pointercancel：不结算 */
      asr?.abort();
      cap?.cancel();
      settle();
      return;
    }
    if (ms < 350) {
      asr?.abort(); /* 误触不烧识别 */
      cap?.cancel();
      settle();
      toast("轻点了 · 按住说话，松开结束");
      return;
    }
    if (!cap) {
      /* 授权等待期松手：作废本次（还没拿到录音器，SpeakViewController.swift:142-146） */
      asr?.abort();
      settle();
      return;
    }
    const r = await cap.stop();
    if (r.peak < 0.01 || r.ms < 250) {
      /* 几乎无信号：提示而不烧识别次数（SpeakViewController.swift:150-159） */
      asr?.abort();
      settle();
      toast("没听到声音——检查麦克风后重试");
      return;
    }
    settle();
    let text = "";
    try {
      text = (await asr?.finish()) ?? "";
    } catch (err) {
      toast(`识别失败：${errMsg(err)}`);
      return;
    }
    if (!text.trim()) {
      toast("没识别到内容，再按住说一次");
      return;
    }
    appendUser(text.trim());
  }

  const hold = useHold(beginHold, endHold);

  /* ---------- 打字兜底（同链路：入轮 → LLM 流式回复） ---------- */

  function send() {
    const txt = draft.trim();
    if (!txt) return;
    setDraft("");
    setTypeMode(false);
    appendUser(txt);
  }

  /* thinking 态「跳过」：掐掉在途 LLM 请求（SpeakViewController.swift:235-239）。
     边流边读后流中已在出声，跳过 = 同时静音（stopSpeak 顶掉句队推进）。 */
  function skip() {
    const s = streamRef.current;
    if (!s) return;
    s.stop();
    streamRef.current = null;
    setReply(null);
    stopSpeak();
  }

  const thinking = reply !== null;
  const voiceReady = voiceConfigured();
  const llmReady = llmConfigured();

  return (
    <>
      <PNav
        title={meta.label}
        left={
          <button className="iconbtn" aria-label="结束" onClick={openSummary}>
            <Icon name="close" size={20} />
          </button>
        }
        right={
          <button className="tlink" style={{ fontSize: 15 }} onClick={openSummary}>
            结束
          </button>
        }
      />
      <div className="chat-body" ref={bodyRef}>
        {!voiceReady && (
          <div className="degrade">
            <Icon name="bolt" size={15} />
            <span>未配置语音识别 · 可打字继续（配置讯飞凭据后支持按住说话）</span>
          </div>
        )}
        {!llmReady && (
          <div className="degrade">
            <Icon name="bolt" size={15} />
            <span>未配置模型服务 · 在「我的→模型服务」填入 API Key 后开始真实对话</span>
          </div>
        )}
        {micDenied && (
          <div className="degrade">
            <Icon name="mic" size={15} />
            <span>麦克风不可用 · 可以打字继续，或去系统设置开权限</span>
          </div>
        )}
        {fail && (
          <div className="degrade">
            <Icon name="bolt" size={15} />
            <span style={{ flex: 1 }}>{fail.msg}</span>
            {fail.retry && (
              <button className="tlink" style={{ flex: "none" }} onClick={fail.retry}>
                重试
              </button>
            )}
          </div>
        )}
        {turns.map((t, i) =>
          t.who === "ai" ? (
            <div className="bubble ai" key={i}>
              <div className="en">{t.en}</div>
              {t.zh && <div className="zh">{t.zh}</div>}
              <div className="brow">
                <button className="spk" aria-label="朗读" onClick={() => speak(t.en, 0.95)}>
                  <Icon name="speaker" size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="bubble me" key={i}>
              <div className="en">{t.en}</div>
            </div>
          ),
        )}
        {thinking && (
          <div className="bubble ai">
            {reply.en ? (
              <>
                <div className="en">{reply.en}</div>
                {reply.zh && <div className="zh">{reply.zh}</div>}
              </>
            ) : (
              <div className="typing">
                <i />
                <i />
                <i />
              </div>
            )}
          </div>
        )}
        {recording && (
          <div className="bubble me">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="eq">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span style={{ fontSize: 13 }}>{heard || "正在听你说 · 松开结束"}</span>
            </div>
          </div>
        )}
      </div>
      <div className="chat-foot">
        {typeMode ? (
          <>
            <div className="type-row">
              <input
                className="input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="打字回复"
                autoComplete="off"
              />
              <button className="iconbtn" aria-label="发送" style={{ background: "var(--ink)", color: "var(--on-ink)", borderRadius: 12, flex: "none" }} onClick={send}>
                <Icon name="right" size={18} />
              </button>
            </div>
            <button className="tlink" style={{ fontSize: 13, marginTop: 8 }} onClick={() => setTypeMode(false)}>
              改回按住说话
            </button>
          </>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="iconbtn" aria-label="打字回复" style={{ border: "1px solid var(--hairline-strong)", borderRadius: 12 }} onClick={() => setTypeMode(true)}>
              <Icon name="kbd" size={19} />
            </button>
            <button className={`holdbtn ${recording ? "rec" : ""}`} {...hold}>
              <Icon name="mic" size={19} />
              {recording ? "松开结束" : "按住说话"}
            </button>
            {thinking && (
              <button className="iconbtn" aria-label="跳过" style={{ border: "1px solid var(--hairline-strong)", borderRadius: 12, flex: "none", fontSize: 13, fontWeight: 500 }} onClick={skip}>
                跳过
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
