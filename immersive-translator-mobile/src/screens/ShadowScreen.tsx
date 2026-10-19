/**
 * 影子跟读轮（push）—— 真实链路（B2）：startPcmCapture 采集 + ShadowVad 收句
 * （套B 经验值照 mac ShadowAssessController.swift:218-251）→ 讯飞 ISE 评测 →
 * iseAlign 保序对齐词级标红。六态状态机全有「跳过」逃生门（#46）；领读默认常速
 * + 三档倍速（常速/0.8×/慢速 0.6×，store speak 云/系统自动路由）；句子出现时
 * prefetchCloud 后台拉音，点领读即命中缓存（免首次等合成）；不达标 → 词级标红
 * （唯一允许 err 大面积场景）+ [再试][听领读][跳过]；达标 → 分数胶囊；报告卡
 * 底部小卡（#57）+ 只练差词抽屉（#58）。未配置讯飞：录音/VAD 仍真实，到评测步
 * 如实停住（不假打分）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actions, speak, stopSpeak, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav, Seg } from "../ui/kit";
import { useNav } from "../ui/nav";
import { isTauri, reportDiag } from "../services/device";
import { startPcmCapture, type Capture } from "../services/audio";
import { assessSentence, prefetchCloud } from "../services/voice";
import { SHADOW_VAD, ShadowVad } from "../core/vad";
import { alignWords, type WordMark } from "../core/iseAlign";
import { getShadowDiffWords, setShadowDiffWords, SHADOW_MAX_SENTS } from "../core/shadowState";
import { DEMO_TREES } from "../core/demo";

type Phase = "idle" | "prep" | "lead" | "rec" | "eval" | "pass" | "fail" | "report" | "warn" | "noeval";

/** 过线分：ISE 句分 4.2×20 = 84（Mac ShadowAssess passScore 口径）。 */
const ISE_PASS_SCORE = 4.2;

interface ShadowResult {
  i: number;
  score: number;
  passed: boolean;
  /** 该句真实差词（未通过时来自 ISE 对齐 missed+bad，报告与只练差词同源）。 */
  miss: string[];
}

export interface ShadowProps {
  fromArticle?: string;
  sentIdx?: number;
}

export default function ShadowScreen({ fromArticle, sentIdx }: ShadowProps) {
  const nav = useNav();
  const articles = useApp((s) => s.articles);
  /* settings.voice = 讯飞三件套齐全的派生标记（SettingsScreens updVoice）；
     评测只在真机走 ISE——浏览器即使填了凭据也不是真链路 */
  const voiceReady = useApp((s) => s.settings.voice);
  const iseReady = voiceReady && isTauri();

  /* 句源：fromArticle+sentIdx → 该文章自 sentIdx 起（上限 6 句）；否则书架第一篇；
     书架空兜底 DEMO_TREES（演示内容种子，句源真实可用） */
  const sents = useMemo(() => {
    if (fromArticle && sentIdx !== undefined) {
      const art = articles.find((a) => a.title === fromArticle || a.titleCn === fromArticle || a.id === fromArticle);
      if (art && sentIdx >= 0 && sentIdx < art.sentences.length) {
        return art.sentences.slice(sentIdx, sentIdx + SHADOW_MAX_SENTS).map((s) => s.en);
      }
    }
    const shelf = articles.length > 0 ? articles[0] : DEMO_TREES;
    return shelf.sentences.slice(0, SHADOW_MAX_SENTS).map((s) => s.en);
  }, [articles, fromArticle, sentIdx]);

  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [score, setScore] = useState(0);
  const [marks, setMarks] = useState<WordMark[]>([]);
  const [warnMsg, setWarnMsg] = useState("");
  const [results, setResults] = useState<ShadowResult[]>([]);
  /** 在途录音令牌（epoch 口径）：跳过/重开/卸载时作废旧轮次，防迟到的 stop 回写 */
  const recTokenRef = useRef(0);
  const captureRef = useRef<Capture | null>(null);
  const stopRecRef = useRef<(() => void) | null>(null);
  /** 壁钟看门狗：iOS 来电/切后台打断音频会话后 onLevel 不再产块，VAD 的 8s/1.5s/15s
   *  判定全部依赖音频块事件、永不触发——没有这道壁钟，界面会冻在「正在听你跟读」（治 speak-6）。 */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sent = sents[i] ?? "";
  /* 报告页差词来自模块态（next() 进报告前已写入当轮真实标红词） */
  const diffWords = phase === "report" ? getShadowDiffWords() : [];

  useEffect(
    () => () => {
      abandonRec();
      stopSpeak();
    },
    [],
  );

  function abandonRec(): void {
    recTokenRef.current += 1;
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    stopRecRef.current = null;
    captureRef.current?.cancel();
    captureRef.current = null;
  }

  /** 领读倍速：常速 1（默认）/ 0.8 / 慢速 0.6——切换即预取对应语速的合成音频。 */
  const [leadRate, setLeadRate] = useState(1);

  function lead(rate?: number) {
    setPhase("lead");
    speak(sent, rate ?? leadRate, () => setPhase((p) => (p === "lead" ? "idle" : p)));
  }

  /* 句子/倍速变化即后台预取合成——点领读时缓存已热，秒出声（首次不再等网络）。 */
  useEffect(() => {
    if (sent) prefetchCloud(sent, undefined, leadRate);
  }, [sent, leadRate]);

  /* ---------- 录音（真实采集 + VAD 收句） ---------- */

  async function record() {
    abandonRec(); // 幂等：重开/领读中途点录都先作废旧轮
    const token = recTokenRef.current;
    stopSpeak();
    /* prep 态：授权弹窗/建流期间如实显示「正在唤醒麦克风」，停止按钮不可点——
       此前先进 rec 态，首次授权等待期点「说完了」是静默空操作（治 speak-7） */
    setPhase("prep");
    setWarnMsg("");
    const vad = new ShadowVad();
    /* 时钟起点在采集就绪之后（治 algo-2）：首次使用的授权弹窗停留时间不该计入
       VAD 的 8s 不开口超时——否则刚授权就被误报「一直没听到你开口」。 */
    let t0 = 0;
    let done = false;
    const finish = (why: "segment" | "noSpeech" | "manual") => {
      if (done || token !== recTokenRef.current) return;
      if (why === "manual" && !captureRef.current) return; // 采集未就绪的手动停止忽略，防泄漏会话
      done = true;
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      stopRecRef.current = null;
      void settle(token, why);
    };

    const capture = await startPcmCapture({
      // 逐电平喂 VAD（套B：开说/静音收句/超时强收都在 vad.push 内判定）
      onLevel: (level) => {
        if (done || token !== recTokenRef.current) return;
        const elapsedMs = performance.now() - t0;
        if (vad.push(level, elapsedMs) === "finished") {
          finish(vad.speaking ? "segment" : "noSpeech");
        }
      },
      // PCM 累计由 Capture 内部完成（onChunk 不必自攒），stop() 交付整段
    });
    if (token !== recTokenRef.current) {
      capture?.cancel();
      return;
    }
    if (!capture) {
      setWarnMsg("无法访问麦克风——请在系统设置中允许麦克风权限后重试");
      setPhase("warn");
      return;
    }
    captureRef.current = capture;
    t0 = performance.now(); // 采集就绪才起表：VAD 时钟从第一块电平的真实时间起算
    // 手动停止入口在采集就绪后才挂（此前点不到真录音）
    stopRecRef.current = () => finish("manual");
    setPhase("rec");
    // 壁钟兜底：音频块断流时强制按手动停止收句（VAD 的上限 15s + 余量）
    watchdogRef.current = setTimeout(() => finish("manual"), SHADOW_VAD.maxRecordMs + 1500);
  }

  /* ---------- 收句 → 质量门槛 → 评测 ---------- */

  async function settle(token: number, why: "segment" | "noSpeech" | "manual") {
    const cap = captureRef.current;
    captureRef.current = null;
    const r = cap ? await cap.stop() : null;
    if (token !== recTokenRef.current) return;

    if (why === "noSpeech") {
      /* 8s 没开口：提前收（ShadowVad noSpeechTimeout） */
      setWarnMsg("一直没听到你开口——检查麦克风");
      setPhase("warn");
      return;
    }
    if (!r || r.peak < 0.01 || r.ms < SHADOW_VAD.minRecordMs) {
      /* 太短/太轻：不烧评测（ISE 拒绝一次白花一次调用） */
      setWarnMsg("没听到足够的声音——离麦克风近一点");
      setPhase("warn");
      return;
    }
    if (!iseReady) {
      /* 未配置讯飞：录音/VAD 已真实走到这，评测步如实停住（不假打分） */
      setPhase("noeval");
      return;
    }

    setPhase("eval");
    try {
      const res = await assessSentence(sent, r.pcmB64);
      if (token !== recTokenRef.current) return;
      if (res.isRejected || res.exceptInfo != null) {
        /* ISE 拒收（28673/28680 等）：不进 results，提示后重试 */
        setWarnMsg("没听到足够的声音——离麦克风近一点");
        setPhase("warn");
        return;
      }
      const s = Math.max(0, Math.min(100, Math.round(res.totalScore * 20)));
      const passed = res.totalScore >= ISE_PASS_SCORE;
      const wordMarks = alignWords(sent, res.words);
      const miss = wordMarks.filter((m) => m.quality === "missed" || m.quality === "bad").map((m) => m.word);
      setScore(s);
      setMarks(wordMarks);
      setResults((rs) => [...rs, { i, score: s, passed, miss }]);
      setPhase(passed ? "pass" : "fail");
    } catch (err) {
      if (token !== recTokenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      reportDiag("ise", `评测失败：${msg}`);
      setWarnMsg(`评测失败：${msg}`);
      setPhase("warn");
    }
  }

  function next() {
    abandonRec();
    stopSpeak();
    if (i >= sents.length - 1) {
      /* 报告页与只练差词抽屉消费当轮真实差词；口径同 P-43：重试过的句只计最后一次成绩的差词 */
      setShadowDiffWords(finalResults(results).flatMap((r) => r.miss));
      setPhase("report");
      return;
    }
    setI(i + 1);
    setPhase("idle");
    setScore(0);
    setMarks([]);
    setWarnMsg("");
  }

  function again() {
    setI(0);
    setPhase("idle");
    setResults([]);
    setScore(0);
    setMarks([]);
    setWarnMsg("");
  }

  /* 词级标红渲染：marks 为原文区间，区间外原样（标点/空白） */
  function renderMarked(text: string, ms: WordMark[]): ReactNode[] {
    const out: ReactNode[] = [];
    let pos = 0;
    const sorted = [...ms].sort((a, b) => a.start - b.start);
    sorted.forEach((m, k) => {
      if (m.start > pos) out.push(text.slice(pos, m.start));
      const bad = m.quality === "missed" || m.quality === "bad";
      out.push(
        <span key={k} className={bad ? "w-err" : "w-ok"}>
          {text.slice(m.start, m.end)}{" "}
        </span>,
      );
      pos = m.end;
    });
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  }

  return (
    <>
      <PNav
        title={`影子跟读 · ${i + 1}/${sents.length}`}
        onBack={() => nav.pop()}
        right={
          phase !== "report" ? (
            <button className="tlink" style={{ fontSize: 15 }} onClick={next}>
              跳过
            </button>
          ) : undefined
        }
      />
      <div className="sh-stage">
        {phase === "report" ? (
          <>
            <div className="overline" style={{ textAlign: "center" }}>
              本轮跟读
            </div>
            <div className="serif" style={{ fontSize: 28, fontWeight: 600, marginTop: 8, textAlign: "center" }}>
              {/* 分母用本轮句数（治 speak-4）：此前用「评测过的句数」，录 1 句跳 5 句
                  也会显示「过线 1/1 · 全部过线」，与轮内 1/6 进度自相矛盾 */}
              过线 {finalResults(results).filter((r) => r.passed).length} / {sents.length} 句
            </div>
            <div className="sh-report">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="meta2">总分</span>
                <span className="serif num" style={{ fontSize: 26, fontWeight: 600 }}>
                  {avgScore(results)}
                </span>
              </div>
              <div className="meter" style={{ marginTop: 10 }}>
                <i style={{ width: `${avgScore(results)}%` }} />
              </div>
              {diffWords.length ? (
                <div className="meta" style={{ marginTop: 10 }}>
                  高频问题：{diffWords.slice(0, 4).map((w) => w.word).join("、")} 的发音
                </div>
              ) : finalResults(results).filter((r) => r.passed).length === sents.length ? (
                <div className="meta" style={{ marginTop: 10 }}>
                  这一轮全部过线 · 没有差词要加练
                </div>
              ) : (
                <div className="meta" style={{ marginTop: 10 }}>
                  还有 {sents.length - finalResults(results).length} 句未练 · 可以再来一轮
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                {diffWords.length > 0 && (
                  <button className="sb pri" style={{ flex: 1, justifyContent: "center" }} onClick={() => actions.setSheet({ kind: "diffwords" })}>
                    只练差词 · {diffWords.length} 个
                  </button>
                )}
                <button className="sb" style={{ flex: 1, justifyContent: "center" }} onClick={again}>
                  再来一轮
                </button>
              </div>
            </div>
          </>
        ) : phase === "fail" ? (
          <>
            <div className="sh-words">{renderMarked(sent, marks)}</div>
            <div style={{ marginTop: 14 }}>
              <span className="score-pill">
                <span className="n num">{score}</span>
                {/* 过线分 = ISE 句分 4.2×20（Mac 口径） */}
                <span className="meta">分 · 未到 {Math.round(ISE_PASS_SCORE * 20)} 分线</span>
              </span>
            </div>
            <div className="sh-actions">
              <button className="sb pri" onClick={() => record()}>
                <Icon name="undo" size={15} />
                再试一次
              </button>
              <button className="sb" onClick={() => lead()}>
                <Icon name="slow" size={15} />
                听领读 · {leadRate}×
              </button>
              <button className="sb" onClick={next}>
                跳过
              </button>
            </div>
          </>
        ) : phase === "pass" ? (
          <>
            <div className="sh-sent">{sent}</div>
            <div style={{ marginTop: 22 }}>
              <span className="score-pill">
                <span className="n num" style={{ color: "var(--ok)" }}>
                  {score}
                </span>
                <span className="meta">分 · 过线了</span>
              </span>
            </div>
            <div className="sh-actions">
              <button className="sb pri" onClick={next}>
                {i >= sents.length - 1 ? "看跟读报告" : "下一句"}
              </button>
            </div>
          </>
        ) : phase === "warn" ? (
          <>
            <div className="sh-sent">{sent}</div>
            <div className="meta" style={{ marginTop: 14, textAlign: "center" }}>
              {warnMsg}
            </div>
            <div className="sh-actions">
              <button className="sb pri" onClick={() => record()}>
                <Icon name="undo" size={15} />
                再试一次
              </button>
              <button className="sb" onClick={next}>
                跳过
              </button>
            </div>
          </>
        ) : phase === "noeval" ? (
          <>
            <div className="sh-sent">{sent}</div>
            <div className="meta" style={{ marginTop: 14, textAlign: "center" }}>
              讯飞评测未配置——配置后获得真实评分
            </div>
            <div className="sh-actions">
              <button className="sb pri" onClick={() => nav.push("setVoice")}>
                <Icon name="gear" size={15} />
                去设置
              </button>
              <button className="sb" onClick={next}>
                跳过
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sh-sent">{sent}</div>
            {fromArticle && sentIdx !== undefined && (
              <div className="meta" style={{ marginTop: 8 }}>
                来自《{fromArticle}》第 {sentIdx + i + 1} 句
              </div>
            )}
            <div className="sh-state">
              {phase === "lead" && (
                <>
                  <span className="eq static">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  领读中 · {leadRate}×
                </>
              )}
              {phase === "idle" && "戴上耳机更有效 · 点麦克风开始"}
              {phase === "prep" && (
                <>
                  <span className="eq static">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  正在唤醒麦克风…
                </>
              )}
              {phase === "rec" && (
                <>
                  <span className="eq">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  正在听你跟读
                </>
              )}
              {phase === "eval" && "评测中 · 对照原音与你的发音"}
            </div>
            <div style={{ display: "flex", justifyContent: "center", margin: "14px 0 0" }}>
              <Seg
                value={String(leadRate)}
                items={[
                  ["1", "常速"],
                  ["0.8", "0.8×"],
                  ["0.6", "慢速 0.6×"],
                ]}
                onChange={(v) => setLeadRate(Number(v))}
              />
            </div>
            <div className="sh-actions">
              {(phase === "lead" || phase === "idle") && (
                <>
                  <button className="sb pri" onClick={() => record()}>
                    <Icon name="mic" size={16} />
                    开始跟读
                  </button>
                  <button className="sb" onClick={() => lead()}>
                    <Icon name="speaker" size={15} />
                    再听领读 · {leadRate}×
                  </button>
                </>
              )}
              {phase === "prep" && (
                <button className="sb pri" disabled style={{ opacity: 0.55 }}>
                  <Icon name="mic" size={16} />
                  正在唤醒麦克风…
                </button>
              )}
              {phase === "rec" && (
                <button className="sb pri" onClick={() => stopRecRef.current?.()}>
                  <Icon name="stop" size={15} />
                  说完了 · 停止并评测
                </button>
              )}
            </div>
            {phase === "eval" && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
                <div className="skel" style={{ width: 180 }} />
                <div className="skel" style={{ width: 80, marginLeft: 10 }} />
              </div>
            )}
            {!iseReady && phase !== "rec" && phase !== "eval" && (
              <div className="meta" style={{ marginTop: 16 }}>
                讯飞评测未配置 · 录音真实生效，评分需配置讯飞后可用。
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 报告统计口径：同句重试只计最后一次成绩（fail 后「再试一次」不再把一句算成两句）。 */
function finalResults(results: ShadowResult[]): ShadowResult[] {
  const bySentence = new Map<number, ShadowResult>();
  for (const r of results) bySentence.set(r.i, r);
  return Array.from(bySentence.values());
}

function avgScore(results: ShadowResult[]): number {
  const finals = finalResults(results);
  if (!finals.length) return 0;
  return Math.round(finals.reduce((s, r) => s + r.score, 0) / finals.length);
}
