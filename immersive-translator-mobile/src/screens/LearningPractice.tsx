import { useEffect, useRef, useState } from "react";
import { actions, activeRepository, deviceId, getState, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { ensureAccount } from "../services/authGate";
import { cloudState, useCloud } from "../services/cloud";
import { assessRecording, expressionFeedback, isUnknownRequest, playOriginal, practiceError, practiceHints, practiceId, startDurableRecording, taskReference, transcribeRecording, type DurableRecording, type PracticeAttempt, type PracticeHints, type PracticeTask } from "../services/practice";
import { ReadingDrawer } from "../components/reading/Drawer";
import { CorrectionDetail } from "../components/vault/CorrectionDetail";
import { MicPermissionSheet } from "../components/speaking/MicPermissionSheet";
import { PronunciationSheet, notifyPronunciationReturn, usePronunciationReturn } from "../components/speaking/PronunciationSheet";
import { speakDemo } from "../components/speaking/demoVoice";
import { sceneStepMeta } from "../components/speaking/scenes";
import { openPractice, when } from "./LearningHome";
import type { Repository } from "../core/persistence";
import { useLocalRecording } from "../core/useLocalRecording";

/* 时钟（原型 I('clock')）：icons.tsx 暂无该条目，口语域内联一份同规格线性图标（1.8 描边）。 */
function Clock({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>;
}

/* 口语练习页（speaking-parity · 原型 VIEWS.practice / practiceRecap / sessionDetail）。
   结构对齐原型 html:2625-2654：nhead（标题+副标+结束）→ 细进度条 → notice/上一步回答 →
   任务卡（衬线例句 + 听一遍/看看中文/发音要点 文字链 + 虚线提示盒）→ 回答区 →
   四态 dock（录音中 / 评测中 spinner / 反馈 / 草稿 / 作答三段）；
   反馈＝我的回答 voice-soft 气泡 + verdict + 白卡纠偏（或 no-fix 卡）；
   复盘＝圆标 hero + 三格统计 + 步骤结果 + 回合卡（第 N 次 · 回答/重说）。 */
export function LearningPractice({ taskId }: { taskId: string }) {
  const nav = useNav(); const tasks = useApp(s => s.tasks); const task = tasks.find(t => t.id === taskId);
  const articles = useApp(s => s.articles); const vocabWords = useApp(s => s.vocab);
  const cloud = useCloud();
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [exit, setExit] = useState(false);
  const [skipAsk, setSkipAsk] = useState(false); const [pron, setPron] = useState(false); const [micAsk, setMicAsk] = useState(false);
  const [recording, setRecording] = useState(false); const [seconds, setSeconds] = useState(0);
  /* 三级提示（speaking-parity）：0 收起；①中文思路静态 ②英文句式 ③听一个示例（word/scenario 走 LLM，follow 用静态文案+原句）。 */
  const [hintLevel, setHintLevel] = useState(0);
  const [hints, setHints] = useState<PracticeHints | null>(null); const [hintPhase, setHintPhase] = useState<"idle" | "loading" | "done" | "fail">("idle"); const [hintError, setHintError] = useState("");
  /* 文字草稿开合（原型 draft 态：点「文字回答」或录音转写后出现；answer 态只有三段 dock）。 */
  const [textOpen, setTextOpen] = useState(false);
  /* 顶部 notice 条（原型 p.notice：文字回答引导 / 重说保留说明）。 */
  const [notice, setNotice] = useState("");
  /* 重说态：反馈已出，点「重说一次」→ 顶部 notice + accent-soft 引导卡 + 作答 dock（原回答保留）。 */
  const [retrying, setRetrying] = useState(false);
  /* 纠偏详情（复盘里「查看这条纠偏」）：复用 vault 域 CorrectionDetail 做页内整层。 */
  const [correctionOpen, setCorrectionOpen] = useState(false);
  /* 练习记录详情（原型 VIEWS.sessionDetail html:2650-2655）：复盘页「查看本次完整回答」→ 同一任务的
     逐回合完整记录（meta 行 + 每回合白卡 + 纠偏卡 + dock「同一主题再练」），页头返回回到复盘。 */
  const [detailOpen, setDetailOpen] = useState(false);
  /* 详情/复盘切换共用同一 <main>：切换时滚回顶部，meta 行与首回合不被复盘页残留的滚动位置切出视口 */
  const bodyRef = useRef<HTMLElement>(null);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [detailOpen]);
  /* 看看中文：follow 按原型默认展开译文（html:2367 showCN 默认）。 */
  const [showCN, setShowCN] = useState(task?.mode === "follow");
  const [draft, setDraft] = useState(task?.draft ?? "");
  const current = useRef<{ session: DurableRecording; repo: Repository; attemptId: string; generation: number; startedAt: number } | null>(null);
  const request = useRef<AbortController | null>(null); const playing = useRef<(() => void) | null>(null);
  const hintRequest = useRef<AbortController | null>(null); const hintGen = useRef(0); const hintInFlight = useRef(false);
  const pronContext = useRef<{ word?: string; sentence: string } | null>(null);
  const mounted = useRef(true); const finishRef = useRef<() => void>(() => {}); const lock = useRef(false);
  const mutations = useRef<Promise<void>>(Promise.resolve());
  const latestAttempt = task?.attempts.filter(a => a.step === task.step).at(-1);
  const localRecording = useLocalRecording(activeRepository(), latestAttempt?.deviceId === deviceId() ? latestAttempt.clipId : undefined, latestAttempt?.status);
  const getTask = (): PracticeTask => { const found = getState().tasks.find(t => t.id === taskId); if (!found) throw new Error("未找到这次练习，原有记录仍保留。"); return found; };
  const update = (change: (t: PracticeTask) => PracticeTask) => {
    const identity = activeRepository().identity;
    const pending = mutations.current.then(async () => {
      if (identity !== activeRepository().identity) throw new Error("账号已切换，请在当前账号继续练习。");
      const next = change(getTask()); await actions.upsertTask({ ...next, updatedAt: Date.now() });
    });
    mutations.current = pending.catch(() => undefined); return pending;
  };
  const updateAttempt = (id: string, patch: Partial<PracticeAttempt>, draft?: string) => update(t => ({ ...t, ...(draft === undefined ? {} : { draft }), attempts: t.attempts.map(a => a.id === id ? { ...a, ...patch } : a) }));
  const guard = async (label: string, work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(label); setError("");
    try { await mutations.current; await work(); } catch (failure) { if (mounted.current) setError(practiceError(failure)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; request.current?.abort(); hintRequest.current?.abort(); playing.current?.(); stopSpeak();
      const active = current.current; current.current = null; if (active) void active.session.stop().catch(() => undefined);
      /* 发音要点抽屉里开的跟读练习：退出时通知下层复盘页重开抽屉（回到本抽屉）。 */
      if (getState().tasks.find(t => t.id === taskId)?.pronunciationReturn) notifyPronunciationReturn();
    };
  }, []);
  useEffect(() => { setDraft(task?.draft ?? ""); }, [taskId, task?.step, task?.attempts.at(-1)?.id, task?.attempts.at(-1)?.text]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => { const elapsed = Math.floor((Date.now() - (current.current?.startedAt ?? Date.now())) / 1000); setSeconds(elapsed); if (elapsed >= 45) finishRef.current(); }, 200);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    request.current?.abort(); const active = current.current;
    if (active && active.generation !== cloud.generation) { current.current = null; setRecording(false); void active.session.stop().catch(() => undefined); }
  }, [cloud.generation]);
  /* 三级提示：换任务/换步作废在途请求与缓存；②级可见时自动发起，失败按级重试（不回退假数据）。 */
  useEffect(() => {
    hintGen.current++; hintRequest.current?.abort(); hintRequest.current = null; hintInFlight.current = false;
    setHints(null); setHintPhase("idle"); setHintError("");
  }, [taskId, task?.step, task?.mode]);
  async function loadHints() {
    const latest = getTask();
    if (latest.mode === "follow" || hintInFlight.current) return;
    hintInFlight.current = true;
    hintRequest.current?.abort();
    const controller = new AbortController(); hintRequest.current = controller;
    const generation = ++hintGen.current;
    setHintPhase("loading"); setHintError("");
    try {
      const result = await practiceHints(latest, controller.signal);
      if (generation !== hintGen.current || controller.signal.aborted || !mounted.current) return;
      setHints(result); setHintPhase("done");
    } catch (failure) {
      if (generation !== hintGen.current || controller.signal.aborted || !mounted.current) return;
      setHintError(practiceError(failure)); setHintPhase("fail");
    } finally { hintInFlight.current = false; if (hintRequest.current === controller) hintRequest.current = null; }
  }
  useEffect(() => {
    if (hintLevel < 2 || task?.mode === "follow" || hintPhase !== "idle") return;
    void loadHints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintLevel, hintPhase, task?.mode, task?.step, taskId]);
  /* 发音要点里「跟读这个表达」开的练习退出后，回到本抽屉。 */
  usePronunciationReturn(() => { if (pronContext.current) setPron(true); });

  async function startRecord() {
    await guard("正在准备录音", async () => {
      if (!await ensureAccount({ taskId })) return;
      const latest = getTask(); const repo = activeRepository(); const id = practiceId("attempt"); const clipId = practiceId("clip");
      playing.current?.(); stopSpeak();
      const attempt: PracticeAttempt = { id, step: latest.step, text: "", clipId, deviceId: deviceId(), status: "recording", createdAt: Date.now(), reference: taskReference(latest) };
      await update(t => ({ ...t, status: "active", attempts: [...t.attempts, attempt] }));
      try {
        const session = await startDurableRecording(repo, clipId, { taskId, attemptId: id, reference: attempt.reference }, () => { /* 电平不进 UI（原型录音态为波形+计时） */ });
        if (!mounted.current || repo.identity !== activeRepository().identity) { await session.stop(); return; }
        current.current = { session, repo, attemptId: id, generation: cloudState().generation, startedAt: Date.now() };
        setSeconds(0); setRecording(true); setMicAsk(false); setNotice(""); setRetrying(false); setTextOpen(false);
      } catch (failure) { if (repo.identity === activeRepository().identity) await updateAttempt(id, { status: "failed", clipId: undefined, error: practiceError(failure) }); if (mounted.current) setMicAsk(false); throw failure; }
    });
  }
  async function stopRecord() {
    if (!current.current || lock.current) return;
    await guard("正在保存原声", async () => {
      const active = current.current!; current.current = null; setRecording(false);
      let recorded = false;
      try {
        const result = await active.session.stop();
        if (active.generation !== cloudState().generation) return;
        await updateAttempt(active.attemptId, { status: "recorded" });
        recorded = true;
        if (result.peak < .01 || result.ms < 350) { setError("声音太轻或录音太短，原声已保留。可以重新录一句，或输入回答。"); return; }
        await recognize(active.attemptId, active.repo);
      } catch (failure) { if (!recorded && active.generation === cloudState().generation) await updateAttempt(active.attemptId, { status: "interrupted", error: practiceError(failure) }); throw failure; }
    });
  }
  finishRef.current = () => { void stopRecord(); };
  async function discardRecord() {
    if (!current.current) return;
    await guard("正在取消录音", async () => {
      const active = current.current!; current.current = null; setRecording(false); await active.session.discard();
      if (active.generation === cloudState().generation) await update(t => ({ ...t, attempts: t.attempts.filter(a => a.id !== active.attemptId), removedAttemptIds: [...new Set([...(t.removedAttemptIds ?? []), active.attemptId])] }));
    });
  }
  async function recognize(id: string, repo = activeRepository()) {
    if (!await ensureAccount({ taskId })) return;
    const attempt = getTask().attempts.find(a => a.id === id); if (!attempt?.clipId) throw new Error("这次回答没有录音");
    const generation = cloudState().generation; const controller = new AbortController(); request.current = controller;
    await updateAttempt(id, { status: "recognizing", error: undefined });
    try {
      const text = await transcribeRecording(repo, attempt.clipId, controller.signal);
      if (generation === cloudState().generation) { await updateAttempt(id, { status: "draft", text }, text); if (mounted.current) { setTextOpen(true); setDraft(text); } }
    } catch (failure) {
      if (generation === cloudState().generation) await updateAttempt(id, { status: isUnknownRequest(failure) ? "unknown" : "failed", error: practiceError(failure) });
      throw failure;
    } finally { if (request.current === controller) request.current = null; }
  }
  async function submit() {
    await guard("正在查看这次回答", async () => {
      if (!await ensureAccount({ taskId })) return;
      const latest = getTask(); const text = draft.trim(); if (!text) throw new Error("先说一句，或写下你想说的话。");
      /* 自定义场景：回答至少说满 minAnswerWords 个英文单词（speaking-parity 校验）。 */
      if ((latest.minAnswerWords ?? 0) > 0 && text.split(/\s+/).filter(token => /[A-Za-z]/.test(token)).length < (latest.minAnswerWords ?? 0)) throw new Error(`围绕这个场景多说一点：至少 ${latest.minAnswerWords} 个英文单词再发送。`);
      await update(t => ({ ...t, draft: text }));
      const last = [...latest.attempts].reverse().find(a => a.step === latest.step && !a.feedback && a.status !== "recording");
      const id = last?.id ?? practiceId("attempt");
      if (last) await updateAttempt(id, { text, status: "submitting", error: undefined });
      else await update(t => ({ ...t, attempts: [...t.attempts, { id, step: t.step, text, deviceId: deviceId(), status: "submitting", createdAt: Date.now(), reference: taskReference(t) }] }));
      setNotice(""); setRetrying(false);
      const generation = cloudState().generation; const controller = new AbortController(); request.current = controller;
      try {
        const feedback = await expressionFeedback(latest, text, controller.signal);
        if (generation === cloudState().generation) await updateAttempt(id, { feedback, status: "feedback" });
      } catch (failure) {
        if (generation === cloudState().generation) await updateAttempt(id, { status: isUnknownRequest(failure) ? "unknown" : "failed", error: practiceError(failure) });
        throw failure;
      } finally { if (request.current === controller) request.current = null; }
    });
  }
  async function pronunciation(attempt: PracticeAttempt) {
    await guard("正在评测这次跟读", async () => {
      if (!await ensureAccount({ taskId })) return;
      if (!attempt.clipId || attempt.deviceId !== deviceId()) throw new Error("只有录制原声的设备可以评测这段音频。");
      const generation = cloudState().generation; const controller = new AbortController(); request.current = controller;
      await updateAttempt(attempt.id, { pronunciationStatus: "submitting", error: undefined });
      try {
        const result = await assessRecording(activeRepository(), attempt.clipId, attempt.reference ?? getTask().reference, controller.signal);
        if (generation === cloudState().generation) await updateAttempt(attempt.id, { pronunciation: result, pronunciationStatus: "ready" });
      } catch (failure) {
        if (generation === cloudState().generation) await updateAttempt(attempt.id, { pronunciationStatus: isUnknownRequest(failure) ? "unknown" : "failed", error: practiceError(failure, "pronunciation") });
        throw failure;
      } finally { if (request.current === controller) request.current = null; }
    });
  }
  const listenOriginal = (attempt: PracticeAttempt) => guard("正在打开原声", async () => {
    if (!attempt.clipId || attempt.deviceId !== deviceId()) throw new Error("原声只保存在录制它的设备，文字和反馈可以跨端查看。");
    playing.current?.(); stopSpeak(); playing.current = await playOriginal(activeRepository(), attempt.clipId);
  });
  /* 保存纠偏：落账后按原型弹底部深色 toast（html:2580 v2SpSaveTurn）。 */
  const saveCorrection = (attempt: PracticeAttempt) => guard("正在保存建议", async () => {
    if (attempt.feedback && !attempt.feedback.savedAt) {
      await updateAttempt(attempt.id, { feedback: { ...attempt.feedback, savedAt: Date.now() } });
      toast("已保存到口语纠偏，可以回看和再练。");
    }
  });
  const returnToSource = () => { setExit(false); nav.pop(); };
  /* 复盘 dock：有来源则带回源句号定位（原型 v2-sp-return → 回到原文第 N 句，html:2647/1668）。 */
  const returnFromRecap = () => {
    setExit(false);
    const source = task?.source;
    if (source) {
      nav.pop();
      actions.locateReader(source.articleId, source.sentenceIdx + (task?.step ?? 0));
      nav.push("reader", { articleId: source.articleId });
    } else returnToSource();
  };
  const pause = () => guard("正在保留进度", async () => { await update(t => ({ ...t, status: t.status === "completed" ? "completed" : "paused" })); returnToSource(); });
  const finish = () => guard("正在保存本轮记录", async () => { await update(t => ({ ...t, status: "completed" })); setExit(false); });
  const next = (skip = false) => guard("正在保存进度", async () => {
    const latest = getTask(); const count = latest.steps?.length || 1;
    await update(t => ({ ...t, skippedSteps: skip ? [...new Set([...(t.skippedSteps ?? []), t.step])] : t.skippedSteps, draft: "", step: Math.min(t.step + 1, count - 1), status: t.step + 1 >= count ? "completed" : "active" }));
    setHintLevel(0); setSkipAsk(false); setTextOpen(false); setNotice(""); setRetrying(false); setShowCN(latest.mode === "follow");
    setDraft("");
  });
  /* 跳过：有未发送草稿先确认（跳过后标为待练），空草稿直接跳过（原型 SHEETS.skipStep）。 */
  const askSkip = () => { if (draft.trim()) setSkipAsk(true); else void next(true); };
  const openPronunciation = () => { const latest = getTask(); pronContext.current = { word: latest.word, sentence: taskReference(latest) }; setPron(true); };
  /* 重说一次（原型 ACT v2-sp-retry，html:2719）：反馈保留，notice 引导，回到作答态。 */
  const beginRetry = () => { setRetrying(true); setTextOpen(false); setNotice("前一次回答仍保留；这次只练刚才那一处。"); setDraft(""); };
  /** 复盘态：同一主题再练一轮——用原 config 重开（顶替当前复盘页，不叠栈）。 */
  const restart = () => guard("正在准备新一轮", async () => {
    const latest = getTask();
    await openPractice(nav, { mode: latest.mode, title: latest.title, reference: latest.reference, ...(latest.word ? { word: latest.word } : {}), ...(latest.steps ? { steps: latest.steps } : {}), ...(latest.source ? { source: latest.source } : {}), ...(latest.minAnswerWords ? { minAnswerWords: latest.minAnswerWords } : {}) }, { replace: true });
  });
  /** 复盘态：目标表达未收藏时，把它留到生词本（出处带回原句）。 */
  const saveTargetWord = () => {
    const word = getTask().word?.trim(); if (!word) return;
    const kind: "word" | "chunk" = /\s/.test(word) ? "chunk" : "word";
    const latest = getTask();
    actions.saveWord({ word, kind, senses: [] }, kind, latest.source ? { articleId: latest.source.articleId, sentIdx: latest.source.sentenceIdx } : undefined);
  };

  if (!task) return <><header className="learning-head nhead"><button className="tlink" aria-label="返回" onClick={() => nav.pop()}><Icon name="left" size={18} /></button><div className="nt"><h1>口语练习</h1></div><span /></header><main className="pbody"><p>未找到这次练习记录，请回到来源重新选择。</p></main></>;
  const count = task.steps?.length || 1;
  const attempts = task.attempts.filter(a => a.step === task.step); const latest = attempts.at(-1);
  const answered = new Set(task.attempts.filter(a => a.feedback).map(a => a.step)).size;
  const skipped = task.skippedSteps?.length ?? 0;
  /* 无需纠偏（原型 no-fix 分支，html:2601）：LLM 对无建议的回答原样返回 improved
     （practice.ts 提示词约定），与用户确认文字一致即「这句可以先留在这里」。 */
  const noFix = Boolean(latest?.feedback && latest.feedback.improved.trim() === (latest.text ?? "").trim());
  /* 三级提示的静态文案：①中文思路按模式给；follow 的②用停顿/重音静态文案、③用任务原句当示例。 */
  const thought = task.mode === "word" ? `想一件和你有关的小事，用 ${task.word || "这个表达"} 说一句。先把意思说明白就好。` : task.mode === "follow" ? "先听一遍原句，留意哪里停顿、哪个词读得重，再按自己的速度完整跟读。" : "先回答当前问题，再补一个具体细节。不用一次说得很长。";
  const followPattern = "照原句的停顿和重音读：长句先拆成两段，重音落在意思最重要的词上，其他词轻轻带过。";
  const targetSaved = task.word ? vocabWords.some(w => w.word.toLowerCase() === task.word!.toLowerCase()) : true;
  const lastClipped = [...task.attempts].reverse().find(a => a.clipId && a.deviceId === deviceId());
  const processing = ["recognizing", "submitting"].includes(latest?.status ?? "") && !busy;
  const showFeedback = Boolean(latest?.feedback);
  /* 场景步骤元数据回查（原型步骤名/译文，html:2247-2268）：任务只持久化任务句，
     内置场景按句精确匹配、自定义场景按固定任务句匹配（scenes.ts；译文带场景名）。 */
  const stepMeta = task.mode === "scenario"
    ? sceneStepMeta(task.steps, task.step, task.title.startsWith("我的场景 · ") ? task.title.slice("我的场景 · ".length) : undefined)
    : null;
  /* 看看中文：follow/word 取出处文章原句译文，场景取原型步骤译文（scenes.ts），无译文不显示入口。 */
  const sourceArticle = task.source ? articles.find(a => a.id === task.source?.articleId) : undefined;
  const cnText = task.mode === "follow"
    ? sourceArticle?.sentences.find(s => s.idx === (task.source?.sentenceIdx ?? 0) + task.step)?.zh ?? null
    : task.mode === "word"
      ? sourceArticle?.sentences.find(s => s.idx === (task.source?.sentenceIdx ?? 0))?.zh ?? null
      : stepMeta?.cn ?? null;
  /* 页头标题/副标（原型 nhead，html:2631/2638）：word=用一个表达，说一句/只练这一个表达；
     follow=跟读原文（纠偏再练=再练这句表达）/第 N / M · 原文第 X 句（纠偏再练=这次试试更自然的表达，
     html:2341 步骤名）；scenario=任务标题/第 N / M · 步骤名（点一份主菜…）；
     复盘副标=任务名（word 用原型 title 口径「用一个表达，说一句」，html:2643 nhead('本轮复盘', s.title)）。 */
  const correctionRetry = task.mode === "follow" && task.title === "再练这句表达";
  const headTitle = task.status === "completed" ? "本轮复盘" : task.mode === "word" ? "用一个表达，说一句" : task.mode === "follow" ? (correctionRetry || task.pronunciationReturn ? "再练这句表达" : "跟读原文") : task.title;
  const headSub = task.status === "completed"
    ? task.mode === "word" ? "用一个表达，说一句" : task.mode === "follow" && !correctionRetry && !task.pronunciationReturn ? "跟读原文" : task.title
    : task.mode === "word" ? "只练这一个表达"
      : task.mode === "follow" ? `${task.step + 1} / ${count} · ${correctionRetry || task.pronunciationReturn ? "这次试试更自然的表达" : task.source ? `原文第 ${(task.source.sentenceIdx ?? 0) + task.step + 1} 句` : "跟读这句原文"}`
        : stepMeta ? `${task.step + 1} / ${count} · ${stepMeta.title}` : `${task.step + 1} / ${count}`;
  /* 任务卡 overline（原型 step.title，html:2634）：场景=步骤名；follow=原文第 N 句
     （原型 v2SpBuild html:2341 的步骤名），无出处回退引导语；其余按模式给固定引导语。 */
  const stepLabel = stepMeta?.title ?? (correctionRetry ? "这次试试更自然的表达"
    : task.mode === "follow" ? (task.source ? `原文第 ${(task.source.sentenceIdx ?? 0) + task.step + 1} 句` : "跟读这句原文")
      : task.mode === "word" ? "试着用上这个表达" : "这一步的沟通任务");
  /* 纠偏卡（原型 v2SpCorrection，html:2589-2595）：反馈态（active=带「重说一次」与 follow 评测）、
     复盘纠偏区与回合历史卡共用同一结构（原型 practiceRecap/sessionDetail 直接渲染 v2SpCorrection）。 */
  const correctionCard = (attempt: PracticeAttempt, active = false) => {
    const feedback = attempt.feedback!;
    const acoustic = attempt.pronunciation;
    const canPlayOriginal = Boolean(attempt.clipId) && attempt.deviceId === deviceId();
    return <article className="card v2-sp-correction" key={attempt.id}>
      <div className="v2-sp-overline">这一句，改一处就好</div>
      <small>我刚才的表达</small>
      <p className="v2-sp-original" lang="en">{attempt.text || "这次录音尚未确认文字"}</p>
      <small>这次试试</small>
      <p className="v2-sp-improved" lang="en">{feedback.improved}</p>
      <p className="v2-sp-explain">{feedback.explanation}</p>
      <div className="v2-sp-actions">
        <button className="btn-ghost v2-sp-compact" onClick={() => speakDemo(feedback.improved)}><Icon name="speaker" size={15} />听示范</button>
        {canPlayOriginal && <button className="btn-ghost v2-sp-compact" disabled={Boolean(busy)} onClick={() => void listenOriginal(attempt)}><Icon name="speaker" size={15} />听我的回答</button>}
      </div>
      {/* follow 模式真实发音评测（原句固定 reference，修改识别文字不影响评分）；只在反馈态提供。 */}
      {active && task.mode === "follow" && attempt.clipId && <section style={{ marginTop: 12 }}>
        <div className="v2-sp-overline">原句跟读 · 真实音频评测</div>
        {acoustic ? acoustic.isRejected
          ? <p className="v2-sp-error">{acoustic.exceptInfo || "声音不清晰或与原句不匹配，本次不展示分数。"}</p>
          : <div className="lp-score">{[["综合", acoustic.total], ["准确", acoustic.accuracy], ["流畅", acoustic.fluency], ["标准", acoustic.standard]].map(([label, value]) => <span key={label}><b>{Number(value).toFixed(1)}</b>{label}</span>)}</div>
          : <><p className="v2-sp-explain" style={{ margin: "6px 0" }}>按录音时固定的原句评测。修改识别文字不会改变发音分。</p><button className="btn-ghost v2-sp-compact" disabled={Boolean(busy) || attempt.deviceId !== deviceId()} onClick={() => void pronunciation(attempt)}>{attempt.pronunciationStatus === "unknown" || attempt.pronunciationStatus === "submitting" ? "确认重新评测（可能再次计费）" : "评测这次跟读"}</button></>}
      </section>}
      {active && <button className="btn voice v2-sp-retry" disabled={Boolean(busy)} onClick={beginRetry}><Icon name="mic" size={15} />重说一次</button>}
      <button className="v2-sp-save" disabled={Boolean(busy)} onClick={() => feedback.savedAt ? setCorrectionOpen(true) : void saveCorrection(attempt)}>
        <Icon name={feedback.savedAt ? "check" : "note"} size={14} />{feedback.savedAt ? "已保存 · 查看这条纠偏" : "保存这条建议"}
      </button>
    </article>;
  };
  /* ---- 反馈区（原型 v2SpFeedback / v2SpCorrection / v2-sp-no-fix，html:2589-2601） ---- */
  const feedbackBlock = (attempt: PracticeAttempt, active: boolean) => {
    const feedback = attempt.feedback;
    if (!feedback) return null;
    const attemptedNoFix = feedback.improved.trim() === (attempt.text ?? "").trim();
    return <section className="v2-sp-feedback" key={attempt.id}>
      <div className="v2-sp-overline">我的回答</div>
      <div className="v2-sp-answer" lang="en">{attempt.text || "这次录音尚未确认文字"}</div>
      <div className={`v2-sp-verdict${attemptedNoFix ? " v2-sp-good" : ""}`}><Icon name={attemptedNoFix ? "check" : "info"} size={14} /><span>{feedback.message}</span></div>
      {attemptedNoFix ? <div className="card v2-sp-no-fix">
        <b>这句可以先留在这里</b>
        <p>没有需要单独保存的表达建议。想更熟练，可以听一遍自己的回答，再说一次。</p>
        <div className="v2-sp-actions">
          {attempt.clipId && attempt.deviceId === deviceId() && <button className="btn-ghost v2-sp-compact" disabled={Boolean(busy)} onClick={() => void listenOriginal(attempt)}><Icon name="speaker" size={15} />听我的回答</button>}
          {active && <button className="btn-ghost v2-sp-compact" disabled={Boolean(busy)} onClick={beginRetry}><Icon name="mic" size={15} />再说一次</button>}
        </div>
      </div> : correctionCard(attempt, active)}
      {(attempt.status === "unknown" || attempt.pronunciationStatus === "unknown") && <p className="v2-sp-error" role="alert">上次请求的结果未知，已保留回答和原声。没有自动重发，再次提交可能产生新的用量。</p>}
      {attempt.error && <p className="v2-sp-explain">{attempt.error}</p>}
    </section>;
  };
  /* ---- 回合历史卡（原型 v2-sp-history-turn，html:2653）：复盘/详情里每回合独立白卡。 ---- */
  const historyTurn = (attempt: PracticeAttempt, index: number) => {
    const retried = task.attempts.some(a => a.step === attempt.step && a.createdAt < attempt.createdAt && a.feedback);
    const prompt = attempt.reference || taskReference({ ...task, step: attempt.step });
    const feedback = attempt.feedback;
    const attemptedNoFix = Boolean(feedback && feedback.improved.trim() === (attempt.text ?? "").trim());
    return <article className="card v2-sp-history-turn" key={attempt.id}>
      <small>第 {index + 1} 次 · {retried ? "重说" : "回答"}</small>
      <p className="v2-sp-history-question" lang="en">{prompt}</p>
      <div className="v2-sp-overline">我的回答</div>
      <div className="v2-sp-answer" lang="en">{attempt.text || "这次录音尚未确认文字"}</div>
      {attempt.clipId && attempt.deviceId === deviceId() && <button className="v2-sp-audio-link" disabled={Boolean(busy)} onClick={() => void listenOriginal(attempt)}><Icon name="speaker" size={15} />听我的回答</button>}
      {feedback && !attemptedNoFix && <div style={{ marginTop: 12 }}>{correctionCard(attempt)}</div>}
    </article>;
  };
  /* 本轮用时（原型 hero/meta 的 v2SpTime(s.durationSeconds)，html:2643/2653）：任务未单独记录时长，
     按首末回合时间戳真实推算（单回合即 0:00），与练习记录详情同一口径。 */
  const turnSpan = (() => {
    const times = task.attempts.map(a => a.createdAt).sort((a, b) => a - b);
    const seconds = times.length > 1 ? Math.max(0, Math.round((times.at(-1)! - times[0]) / 1000)) : 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  })();
  const recapDuration = turnSpan;
  /* ---- 复盘页（原型 VIEWS.practiceRecap，html:2638-2647） ---- */
  const recapView = (() => {
    const usedCount = task.attempts.filter(a => a.feedback?.usedTarget).length;
    const pending = Math.max(0, count - answered - skipped);
    const allDone = answered === count;
    const achievement = task.mode === "word" ? (usedCount ? "这个表达，今天亲自用了一次" : "回答已留下，目标表达还可以再试") : task.mode === "follow" ? (allDone ? "这一轮跟读已完成" : "这轮先练到这里") : (allDone ? "这一轮对话已完成" : "这轮先练到这里");
    const corrections = task.attempts.filter(a => a.feedback && a.feedback.improved.trim() !== (a.text ?? "").trim());
    const resultsTitle = task.mode === "scenario" ? "本次沟通任务" : task.mode === "word" ? "表达用上了吗" : "这次练过的原句";
    /* 用上计数：word 按 usedTarget 真实判定；follow/scenario 无词级匹配数据，按原型 z.matched=0 口径显示 */
    const matchedCount = task.mode === "word" ? usedCount : 0;
    return <>
      <article className="card v2-sp-recap-hero">
        <div className="v2-sp-recap-icon">{allDone ? <Icon name="check" size={20} /> : <Clock size={20} />}</div>
        <h3>{achievement}</h3>
        <p>{answered} 次已回答 · {recapDuration}{skipped ? ` · ${skipped} 步已跳过` : ""}</p>
        <div className="v2-sp-summary-grid">
          <div><b>{answered}</b><small>已练</small></div>
          <div><b>{skipped}</b><small>已跳过</small></div>
          <div><b>{pending}</b><small>还没练</small></div>
        </div>
      </article>
      <div className="v2-sec-h"><b>{resultsTitle}</b><span>{matchedCount} / {count} 项已用上</span></div>
      <div className="card v2-sp-results">
        {Array.from({ length: count }, (_, i) => {
          const stepAttempts = task.attempts.filter(a => a.step === i);
          const stepDone = stepAttempts.some(a => a.feedback);
          const stepSkipped = task.skippedSteps?.includes(i) ?? false;
          const matched = task.mode === "word" ? stepAttempts.some(a => a.feedback?.usedTarget) : false;
          const name = task.mode === "follow" ? `原文第 ${(task.source?.sentenceIdx ?? 0) + i + 1} 句` : task.mode === "word" ? task.word : `第 ${i + 1} 步`;
          return <div className="learning-row" style={{ borderBottom: i < count - 1 ? "1px solid var(--hairline)" : "none", minHeight: 72 }} key={i}>
            <span className={`v2-sp-result-icon${matched ? " v2-sp-good" : ""}`}>{stepSkipped || !stepDone || !matched ? <Clock size={15} /> : <Icon name="check" size={15} />}</span>
            <span className="tx" style={{ flex: 1, minWidth: 0 }}>
              <b>{name}</b>
              <small>{stepSkipped ? "已跳过，留作待练" : !stepDone ? "还没有回答" : matched ? "本次回答已用上" : "已经回答，还可以再改进"}</small>
            </span>
          </div>;
        })}
      </div>
      <div className="v2-sec-h"><b>留下一处，下次更好说</b>{corrections.length ? <span>{corrections.length} 条表达建议</span> : undefined}</div>
      {/* 原型 html:2645：复盘纠偏区直接渲染纠偏卡（v2SpCorrection，无回合问题句/我的回答） */}
      {corrections.length ? corrections.map(a => correctionCard(a)) : <div className="card v2-sp-no-fix"><b>这次没有需要单独保存的建议</b><p>继续阅读，遇到下一个想用的表达时，再来练一句。</p></div>}
      {/* 原型 html:2646：纠偏区之后「查看本次完整回答」→ 练习记录详情（VIEWS.sessionDetail）；两钮均为原型
          普通 .btn block（surface 底 + border-strong 描边，html:119）→ App 对位 .btn-ghost，不是 accent 主按钮 */}
      <button className="btn-ghost v2-sp-collect" onClick={() => setDetailOpen(true)}>查看本次完整回答</button>
      {!targetSaved && task.word && <button className="btn-ghost v2-sp-collect" onClick={saveTargetWord}><Icon name="star" size={15} />把这个表达留到生词本</button>}
      <button className="v2-sp-text-action" disabled={Boolean(busy)} onClick={() => void guard("正在继续练习", () => update(t => ({ ...t, status: "active" })))}>回到这一步，再说一次</button>
      <button className="v2-sp-text-action" disabled={Boolean(busy)} onClick={() => void restart()}>同一主题，再练一轮</button>
      <button className="v2-sp-text-action" onClick={openPronunciation}>看这一步的发音要点</button>
    </>;
  })();
  /* ---- 练习记录详情（原型 VIEWS.sessionDetail，html:2650-2655）：meta 行「N 次回答 · m:ss（· 练习表达 X）」+
     逐回合白卡（第 N 次 · 回答/重说 → 问题句 → 我的回答 → 听我的回答 → 纠偏卡）。用时按首末回合时间戳
     真实推算（任务未单独记录时长；单回合即 0:00）。 ---- */
  const detailView = (() => {
    const turns = [...task.attempts].sort((a, b) => a.createdAt - b.createdAt);
    return <>
      <div className="v2-sp-history-meta">{turns.length} 次回答 · {turnSpan}{task.word ? ` · 练习表达 ${task.word}` : ""}</div>
      {turns.length ? turns.map((a, i) => historyTurn(a, i)) : <p className="learning-empty">这轮还没有发送回答。可以重新开始。</p>}
    </>;
  })();
  /* ---- 进行中正文（原型 VIEWS.practice body，html:2631-2635） ---- */
  const retryTurn = retrying ? latest : undefined;
  const previous = task.step > 0 ? [...task.attempts].reverse().find(a => a.step === task.step - 1 && a.feedback) : undefined;
  const practiceView = <>
    {notice && <div className="v2-sp-notice" role="status"><Icon name="info" size={14} /><span>{notice}</span></div>}
    {previous && previous.text && <div className="v2-sp-previous"><small>上一步，我说了</small><p lang="en">{previous.text}</p></div>}
    <article className="card v2-sp-prompt">
      <div className="v2-sp-overline">{stepLabel}</div>
      {task.word && <div className="v2-sp-target" lang="en">{task.word}</div>}
      <p className="v2-sp-question" lang="en">{taskReference(task)}</p>
      <div className="v2-sp-prompt-tools">
        <button className="v2-sp-audio-link" onClick={() => speakDemo(taskReference(task))}><Icon name="speaker" size={15} />听一遍</button>
        {cnText && <button className="v2-sp-audio-link" onClick={() => setShowCN(!showCN)}>{showCN ? "收起中文" : "看看中文"}</button>}
        <button className="v2-sp-audio-link" onClick={openPronunciation}><Icon name="wave" size={15} />发音要点</button>
      </div>
      {showCN && cnText && <p className="v2-sp-cn">{cnText}</p>}
    </article>
    {showFeedback && latest && !retrying ? feedbackBlock(latest, true) : <>
      {retryTurn?.feedback && <div className="v2-sp-retry-guide">
        <small>这次试试这样说</small>
        <p lang="en">{retryTurn.feedback.improved}</p>
        <button className="v2-sp-audio-link" onClick={() => speakDemo(retryTurn.feedback!.improved)}><Icon name="speaker" size={15} />再听示范</button>
      </div>}
      <div className="v2-sp-hints">
        <button className="v2-sp-hint-toggle" onClick={() => setHintLevel(hintLevel >= 3 ? 0 : hintLevel + 1)}><Icon name="info" size={15} /><span>{hintLevel === 0 ? "给点提示" : hintLevel < 3 ? "再给一点提示" : "收起提示"}</span><small>{hintLevel ? `${hintLevel} / 3` : "从中文思路开始"}</small></button>
        {hintLevel >= 1 && <div className="v2-sp-hint-line"><small>① 中文思路</small><p>{thought}</p></div>}
        {hintLevel >= 2 && <div className="v2-sp-hint-line"><small>② 英文句式</small>{task.mode === "follow" ? <p>{followPattern}</p> : hintPhase === "fail" ? <><p className="v2-sp-error" role="alert">{hintError || "提示暂时拿不到。"}</p><button className="btn-ghost v2-sp-compact" onClick={() => void loadHints()}>重试这一级</button></> : hintPhase === "done" && hints ? <p className="en">{hints.pattern}</p> : <p role="status">正在生成这一步的句式…</p>}</div>}
        {hintLevel >= 3 && <div className="v2-sp-hint-line"><small>③ 听一个示例</small>{task.mode === "follow" ? <><p className="en">{taskReference(task)}</p><button className="btn-ghost v2-sp-compact" onClick={() => speakDemo(taskReference(task))}><Icon name="speaker" size={15} />听示例</button></> : hintPhase === "done" && hints ? <><p className="en">{hints.example}</p><button className="btn-ghost v2-sp-compact" onClick={() => speakDemo(hints.example)}><Icon name="speaker" size={15} />听示例</button></> : hintPhase === "fail" ? <p>先重试上一级，示例句会和句式一起返回。</p> : <p role="status">示例句和句式一起返回…</p>}</div>}
      </div>
      {(textOpen || processing) && <div className="v2-sp-draft">
        <label htmlFor="practice-answer">{latest?.clipId && ["draft", "recorded", "recognizing"].includes(latest.status) ? "这次录到的回答 · 可以修改" : "我想这样说"}</label>
        <textarea id="practice-answer" className="input v2-inp v2-sp-answer-input" maxLength={900} rows={3} value={draft} disabled={Boolean(busy) || processing} placeholder="用英语写下你想说的一句…" onChange={event => { const next = event.target.value; setDraft(next); void update(t => ({ ...t, draft: next })).catch(failure => setError(practiceError(failure))); }} />
        {error && <p className="v2-sp-error" role="alert">{error}</p>}
      </div>}
      {latest && localRecording && !showFeedback && ["recorded", "failed", "interrupted", "unknown"].includes(latest.status) && !processing && <button className="v2-sp-text-action" disabled={Boolean(busy)} onClick={() => void guard("正在识别这次录音", () => recognize(latest.id))}>{localRecording.status === "ready" ? "重新识别已保存的原声" : "尝试恢复并识别原声"}</button>}
      {!processing && !recording && <button className="v2-sp-skip" disabled={Boolean(busy)} onClick={askSkip}>{task.mode === "follow" ? "这句先跳过，留待下次练" : "这一步先跳过"}</button>}
    </>}
  </>;
  /* ---- dock（原型 v2SpComposer，html:2603-2608）：录音 / 评测中 / 反馈 / 草稿 / 作答五态 ---- */
  const composer = (() => {
    if (recording) return <footer className="v2-sp-dock">
      <div className="v2-sp-wave" aria-hidden="true">{[8, 16, 23, 12, 27, 19, 9, 21, 15].map((h, i) => <i key={i} style={{ height: h, animationDelay: `${i * .07}s` }} />)}</div>
      <div className="v2-sp-mic-row">
        <button className="btn-ghost v2-sp-compact" disabled={Boolean(busy)} onClick={() => void discardRecord()}>取消</button>
        <button className="v2-sp-mic v2-sp-mic-rec" aria-label="结束录音" disabled={Boolean(busy)} onClick={() => void stopRecord()}><span className="v2-sp-stop" /></button>
        <span className="v2-sp-timer">{seconds}s</span>
      </div>
      <p>说完点一下，停下后可以修改</p>
    </footer>;
    if (processing || busy) return <footer className="v2-sp-dock v2-sp-checking" role="status">
      <span className="v2-sp-spinner" aria-hidden="true" />
      <b>{busy || "正在查看这次回答…"}</b>
      <p>你的文字会和当前练习一起保存</p>
    </footer>;
    if (showFeedback && !retrying) return <footer className="v2-sp-dock">
      <button className="btn" disabled={Boolean(busy)} onClick={() => void next()}>{task.step + 1 < count ? "继续下一步" : "完成这一轮 · 看复盘"}<Icon name="right" size={15} /></button>
      <p>{noFix ? "本次回答已记录" : "可以先继续，待改进的地方会留在复盘里"}</p>
    </footer>;
    if (textOpen) return <footer className="v2-sp-dock">
      <div className="v2-sp-actions">
        <button className="btn-ghost" disabled={Boolean(busy) || processing} onClick={() => { setTextOpen(false); setNotice(""); setMicAsk(true); }}><Icon name="mic" size={15} />重新录一句</button>
        {/* 原型发送回答为常可点的 voice 实底（html:2607），空草稿在提交时校验报错（html:2515-2516），不置灰。 */}
        <button className="btn voice" disabled={Boolean(busy) || processing} onClick={() => void submit()}><Icon name="check" size={15} />发送回答</button>
      </div>
      <p>按你的意思修改后，直接发送就好</p>
    </footer>;
    return <footer className="v2-sp-dock">
      <div className="v2-sp-mic-row">
        <button className="btn-ghost v2-sp-compact" onClick={() => speakDemo(taskReference(task))}><Icon name="speaker" size={15} />听一遍</button>
        <button className="v2-sp-mic" aria-label="开始回答录音" disabled={Boolean(busy)} onClick={() => setMicAsk(true)}><Icon name="mic" size={26} /></button>
        <button className="btn-ghost v2-sp-compact" onClick={() => { setTextOpen(true); setNotice("先把想说的话写下来，也是一种开始。"); }}>文字回答</button>
      </div>
      <p>点一下，先说一句短回答</p>
    </footer>;
  })();

  const completed = task.status === "completed";
  /* 练习记录详情态只在复盘（completed）之上展开；页头按原型 nhead(title, 时间 · 完成态) 无右侧动作 */
  const showDetail = completed && detailOpen;
  return <>
    <header className="learning-head nhead sp-nhead">
      {/* 复盘页页头返回＝原路退回（nav.pop）；带回源跳转只在 dock 主按钮「回到原文第 N 句」（原型 html:2647）。
          详情态返回＝回到复盘（原型 sessionDetail 由复盘「查看本次完整回答」进入）。 */}
      <button className="tlink" aria-label="返回" onClick={() => { if (recording) setError("请先结束或取消这次录音，保存后可以离开。"); else if (showDetail) setDetailOpen(false); else if (completed) returnToSource(); else setExit(true); }}><Icon name="left" size={18} /></button>
      <div className="nt"><h1>{showDetail ? task.title : headTitle}</h1><small>{showDetail ? `${when(task.updatedAt)} · 本轮完成` : headSub}</small></div>
      {/* 原型复盘页 nhead 无右侧动作（html:2643 nhead('本轮复盘', s.title) 两参形态）：
          复盘/详情态第三列留空，退出走 dock「回到口语首页」 */}
      {showDetail || completed ? <span /> : <button className="v2-sp-end" disabled={recording || Boolean(busy)} onClick={() => setExit(true)}>结束</button>}
    </header>
    {/* 细进度条只挂在进行中练习（原型复盘页 nhead 后直接进 hero，无进度条，html:2638-2643）。 */}
    {!completed && <div className="v2-sp-progress">
      <div className="v2-pbar"><i style={{ width: `${Math.round(answered / count * 100)}%` }} /></div>
      <span>已回答 {answered} / {count}</span>
    </div>}
    <main ref={bodyRef} className={`pbody ${completed ? "sp-recap-body" : "sp-has-dock"}`}>
      {error && !textOpen && !processing && <p className="v2-sp-error" role="alert">{error}</p>}
      {showDetail ? detailView : completed ? recapView : practiceView}
    </main>
    {!completed && composer}
    {/* 详情 dock（原型 html:2655）：「同一主题再练」= 同一 config 重开一轮；复盘 dock 为回到来源 */}
    {showDetail && <footer className="v2-sp-dock">
      <button className="btn" disabled={Boolean(busy)} onClick={() => void restart()}><Icon name="mic" size={15} />同一主题再练</button>
    </footer>}
    {completed && !showDetail && <footer className="v2-sp-dock">
      <button className="btn" disabled={Boolean(busy)} onClick={returnFromRecap}><Icon name="left" size={15} />{task.source ? `回到原文第 ${(task.source.sentenceIdx ?? 0) + task.step + 1} 句` : "回到口语首页"}</button>
    </footer>}
    {/* 退出确认抽屉（原型 SHEETS.practiceExit，html:2666-2669） */}
    <PracticeExitSheet
      open={exit}
      onClose={() => setExit(false)}
      answered={answered} skipped={skipped} total={count}
      busy={Boolean(busy)}
      onPause={() => void pause()}
      onFinish={() => void finish()}
    />
    {/* 跳过确认抽屉（原型 SHEETS.skipStep，html:2670） */}
    <SkipStepSheet
      open={skipAsk}
      onClose={() => setSkipAsk(false)}
      busy={Boolean(busy)}
      onSkip={() => void next(true)}
    />
    {/* 麦克风授权抽屉（原型 SHEETS.micPermission；允许后走既有 startRecord 真实链路） */}
    <MicPermissionSheet
      open={micAsk}
      onClose={() => setMicAsk(false)}
      onAllow={() => { setMicAsk(false); void startRecord(); }}
      onText={() => { setMicAsk(false); setTextOpen(true); setNotice("先把想说的话写下来，也是一种开始。"); }}
    />
    {/* 发音要点抽屉（speaking-parity）：练习内=回去重说这句；复盘态=跟读这个表达（结束后回到本抽屉） */}
    <PronunciationSheet
      open={pron}
      onClose={() => setPron(false)}
      word={task.word}
      sentence={taskReference(task)}
      phonetic={task.word ? vocabWords.find(w => w.word.toLowerCase() === task.word!.toLowerCase())?.phonetic : undefined}
      answerLabel={lastClipped ? "听我刚才的回答" : undefined}
      onPlayAnswer={lastClipped ? () => { setPron(false); void listenOriginal(lastClipped); } : undefined}
      inPractice={task.status !== "completed"}
      onRepeat={() => { setPron(false); if (showFeedback && !retrying) beginRetry(); else setMicAsk(true); }}
      onFollowExpression={() => {
        try {
          const latestTask = getTask();
          pronContext.current = { word: latestTask.word, sentence: taskReference(latestTask) };
          setPron(false);
          /* 原型 v2-sp-pron-repeat（html:2739）：以表达/句子开跟读（config.text → title「再练这句表达」），
             结束后回到本抽屉（pronunciationReturn）。 */
          void openPractice(nav, { mode: "follow", title: "再练这句表达", reference: latestTask.word || taskReference(latestTask), ...(latestTask.source ? { source: latestTask.source } : {}), pronunciationReturn: true });
        } catch (failure) { setError(practiceError(failure)); }
      }}
    />
    {/* 纠偏详情（原型 VIEWS.correction）：复盘里「已保存 · 查看这条纠偏」的页内整层 */}
    {correctionOpen && latest?.feedback && <div className="correction-layer">
      <CorrectionDetail task={task} attempt={latest} onBack={() => setCorrectionOpen(false)} />
    </div>}
  </>;
}

/* 退出确认抽屉（原型 SHEETS.practiceExit）：计数进文案；按钮纵排；第三钮有回答/跳过才出现。 */
function PracticeExitSheet({ open, onClose, answered, skipped, total, busy, onPause, onFinish }: {
  open: boolean; onClose: () => void; answered: number; skipped: number; total: number; busy: boolean; onPause: () => void; onFinish: () => void;
}) {
  return <ReadingDrawer open={open} onClose={onClose} label="退出练习">
    <div className="sp-sheet-head">
      <h3>{answered ? "这次先练到这里？" : "这一句还没有发送"}</h3>
      <p className="sp-sheet-copy">已回答 {answered} / {total} 步{skipped ? `，跳过 ${skipped} 步` : ""}。{answered ? "可以看本轮记录，也可以保留进度稍后继续。" : "保留进度后，下次可以从这里接着练。"}</p>
    </div>
    <div className="sp-sheet-body">
      <button className="btn" onClick={onClose}>继续练这句</button>
      <button className="btn-ghost" style={{ marginTop: 10 }} disabled={busy} onClick={onPause}>保留进度，回到来源</button>
      {(answered > 0 || skipped > 0) && <button className="v2-sp-text-action" disabled={busy} onClick={onFinish}>结束这一轮，查看复盘</button>}
    </div>
  </ReadingDrawer>;
}

/* 跳过确认抽屉（原型 SHEETS.skipStep）：primary 继续写这句 / outline 跳过这句，纵排全宽。 */
function SkipStepSheet({ open, onClose, busy, onSkip }: { open: boolean; onClose: () => void; busy: boolean; onSkip: () => void }) {
  return <ReadingDrawer open={open} onClose={onClose} label="跳过这一步">
    <div className="sp-sheet-head">
      <h3>这句先留到下次？</h3>
      <p className="sp-sheet-copy">这份草稿还未发送。跳过后会标为待练，不会计为已完成。</p>
    </div>
    <div className="sp-sheet-body">
      <button className="btn" onClick={onClose}>继续写这句</button>
      <button className="btn-ghost" style={{ marginTop: 10 }} disabled={busy} onClick={onSkip}>跳过这句</button>
    </div>
  </ReadingDrawer>;
}

export default LearningPractice;
