import { useEffect, useRef, useState } from "react";
import { actions, activeRepository, deviceId, getState, speak, stopSpeak, useApp } from "../store";
import { PNav } from "../ui/kit";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { ensureAccount } from "../services/authGate";
import { cloudState, useCloud } from "../services/cloud";
import { assessRecording, expressionFeedback, isUnknownRequest, playOriginal, practiceError, practiceId, startDurableRecording, taskReference, transcribeRecording, type DurableRecording, type PracticeAttempt, type PracticeTask } from "../services/practice";
import type { Repository } from "../core/persistence";

const CSS = `.lp-body{padding-bottom:28px}.lp-progress{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--text-2,#68736d);margin-bottom:20px}.lp-prompt{padding:20px;margin:14px 0}.lp-prompt h2{font-size:24px;line-height:1.5;margin:12px 0;overflow-wrap:anywhere}.lp-eyebrow{font-size:12px;letter-spacing:.08em;color:var(--text-2,#68736d)}.lp-word{font-size:30px;font-weight:650;line-height:1.3;margin-top:10px}.lp-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.lp-actions>.btn{flex:1;min-height:44px;min-width:110px}.lp-input{box-sizing:border-box;width:100%;min-height:124px;font:inherit;font-size:18px;line-height:1.6;padding:13px;border:1px solid var(--border,#d4dbd6);border-radius:12px;background:var(--surface,#f7f9f6);color:inherit;margin:10px 0}.lp-recorder{padding:20px 12px;text-align:center}.lp-mic{display:grid;place-items:center;width:76px;height:76px;border:0;border-radius:50%;background:#535f83;color:white;margin:14px auto;cursor:pointer}.lp-mic:disabled{opacity:.5}.lp-meter{height:5px;border-radius:5px;background:#d8dfda;overflow:hidden;margin:12px auto;max-width:180px}.lp-meter i{display:block;height:100%;background:#535f83;transform-origin:left;transition:transform .1s}.lp-error{padding:13px;border-radius:10px;background:rgba(168,67,56,.08);color:var(--danger,#994339);font-size:13px;line-height:1.6}.lp-feedback{padding:18px;margin:16px 0}.lp-feedback h3{margin:8px 0}.lp-answer{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:17px}.lp-improved{font-size:20px;line-height:1.6}.lp-score{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px}.lp-score span{flex:1;min-width:64px;font-size:12px}.lp-score b{display:block;font-size:24px;margin-bottom:4px}.lp-history{border-top:1px solid var(--border,#d4dbd6);padding-top:20px;margin-top:22px}.lp-exit{padding:16px}.lp-hint{font-size:13px;line-height:1.7;color:var(--text-2,#68736d)}.lp-link{background:none;border:0;padding:10px 0;color:inherit;text-decoration:underline;cursor:pointer;min-height:44px}.lp-status{font-size:13px;line-height:1.7}.lp-complete{padding:22px;margin-bottom:18px}.lp-dock{position:sticky;bottom:0;padding:14px 0;background:var(--bg,#eef1ee)}@media(prefers-reduced-motion:reduce){.lp-meter i{transition:none}}`;

export function LearningPractice({ taskId }: { taskId: string }) {
  const nav = useNav(); const tasks = useApp(s => s.tasks); const task = tasks.find(t => t.id === taskId);
  const cloud = useCloud();
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [exit, setExit] = useState(false);
  const [hint, setHint] = useState(false); const [level, setLevel] = useState(0); const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false); const [micIntro, setMicIntro] = useState(false);
  const [draft, setDraft] = useState(task?.draft ?? "");
  const current = useRef<{ session: DurableRecording; repo: Repository; attemptId: string; generation: number; startedAt: number } | null>(null);
  const request = useRef<AbortController | null>(null); const playing = useRef<(() => void) | null>(null);
  const mounted = useRef(true); const finishRef = useRef<() => void>(() => {}); const lock = useRef(false);
  const mutations = useRef<Promise<void>>(Promise.resolve());
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
    return () => { mounted.current = false; request.current?.abort(); playing.current?.(); stopSpeak(); const active = current.current; current.current = null; if (active) void active.session.stop().catch(() => undefined); };
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

  async function startRecord() {
    await guard("正在准备录音", async () => {
      if (!await ensureAccount({ taskId })) return;
      const latest = getTask(); const repo = activeRepository(); const id = practiceId("attempt"); const clipId = practiceId("clip");
      playing.current?.(); stopSpeak();
      const attempt: PracticeAttempt = { id, step: latest.step, text: "", clipId, deviceId: deviceId(), status: "recording", createdAt: Date.now(), reference: taskReference(latest) };
      await update(t => ({ ...t, status: "active", attempts: [...t.attempts, attempt] }));
      try {
        const session = await startDurableRecording(repo, clipId, { taskId, attemptId: id, reference: attempt.reference }, value => { if (mounted.current) setLevel(Math.min(1, value * 7)); });
        if (!mounted.current || repo.identity !== activeRepository().identity) { await session.stop(); return; }
        current.current = { session, repo, attemptId: id, generation: cloudState().generation, startedAt: Date.now() };
        setSeconds(0); setLevel(0); setRecording(true); setMicIntro(false);
      } catch (failure) { await updateAttempt(id, { status: "failed", error: practiceError(failure) }); throw failure; }
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
      if (generation === cloudState().generation) await updateAttempt(id, { status: "draft", text }, text);
    } catch (failure) {
      if (generation === cloudState().generation) await updateAttempt(id, { status: isUnknownRequest(failure) ? "unknown" : "failed", error: practiceError(failure) });
      throw failure;
    } finally { if (request.current === controller) request.current = null; }
  }
  async function submit() {
    await guard("正在查看这次回答", async () => {
      if (!await ensureAccount({ taskId })) return;
      const latest = getTask(); const text = draft.trim(); if (!text) throw new Error("先说一句，或写下你想说的话。");
      await update(t => ({ ...t, draft: text }));
      const last = [...latest.attempts].reverse().find(a => a.step === latest.step && !a.feedback && a.status !== "recording");
      const id = last?.id ?? practiceId("attempt");
      if (last) await updateAttempt(id, { text, status: "submitting", error: undefined });
      else await update(t => ({ ...t, attempts: [...t.attempts, { id, step: t.step, text, deviceId: deviceId(), status: "submitting", createdAt: Date.now(), reference: taskReference(t) }] }));
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
        if (generation === cloudState().generation) await updateAttempt(attempt.id, { pronunciationStatus: isUnknownRequest(failure) ? "unknown" : "failed", error: practiceError(failure) });
        throw failure;
      } finally { if (request.current === controller) request.current = null; }
    });
  }
  const listenOriginal = (attempt: PracticeAttempt) => guard("正在打开原声", async () => {
    if (!attempt.clipId || attempt.deviceId !== deviceId()) throw new Error("原声只保存在录制它的设备，文字和反馈可以跨端查看。");
    playing.current?.(); stopSpeak(); playing.current = await playOriginal(activeRepository(), attempt.clipId);
  });
  const saveCorrection = (attempt: PracticeAttempt) => guard("正在保存建议", async () => { if (attempt.feedback && !attempt.feedback.savedAt) await updateAttempt(attempt.id, { feedback: { ...attempt.feedback, savedAt: Date.now() } }); });
  const returnToSource = () => { setExit(false); nav.pop(); };
  const pause = () => guard("正在保留进度", async () => { await update(t => ({ ...t, status: t.status === "completed" ? "completed" : "paused" })); returnToSource(); });
  const finish = () => guard("正在保存本轮记录", async () => { await update(t => ({ ...t, status: "completed" })); setExit(false); });
  const next = (skip = false) => guard("正在保存进度", async () => {
    const latest = getTask(); const count = latest.steps?.length || 1;
    await update(t => ({ ...t, skippedSteps: skip ? [...new Set([...(t.skippedSteps ?? []), t.step])] : t.skippedSteps, draft: "", step: Math.min(t.step + 1, count - 1), status: t.step + 1 >= count ? "completed" : "active" }));
    setHint(false);
    setDraft("");
  });

  if (!task) return <><PNav title="口语练习" onBack={() => nav.pop()} /><div className="pbody"><p>未找到这次练习记录，请回到来源重新选择。</p></div></>;
  const count = task.steps?.length || 1;
  const attempts = task.attempts.filter(a => a.step === task.step); const latest = attempts.at(-1);
  const answered = new Set(task.attempts.filter(a => a.feedback).map(a => a.step)).size;
  const processing = ["recognizing", "submitting"].includes(latest?.status ?? "") && !busy;
  const showFeedback = Boolean(latest?.feedback);
  const attemptCard = (attempt: PracticeAttempt) => {
    const feedback = attempt.feedback; const acoustic = attempt.pronunciation;
    return <article className="card lp-feedback" key={attempt.id}>
      <div className="lp-eyebrow">第 {attempt.step + 1} 步 · {new Date(attempt.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
      <h3>我的回答</h3><p className="lp-answer">{attempt.text || "这次录音尚未确认文字"}</p>
      {attempt.clipId && <button className="btn" disabled={Boolean(busy)} onClick={() => void listenOriginal(attempt)}><Icon name="play" size={16} />{attempt.deviceId === deviceId() ? "听我的原声" : "原声保存在另一台设备"}</button>}
      {feedback && <><p className="lp-status">{feedback.message}</p><div className="lp-eyebrow">这一句，改一处就好</div><p className="lp-improved">{feedback.improved}</p><p className="lp-hint">{feedback.explanation}</p><div className="lp-actions"><button className="btn" onClick={() => speak(feedback.improved)}>听示范</button><button className="btn" disabled={Boolean(busy) || Boolean(feedback.savedAt)} onClick={() => void saveCorrection(attempt)}>{feedback.savedAt ? "已保存到口语纠偏" : "保存这条建议"}</button></div></>}
      {task.mode === "follow" && attempt.clipId && <section><div className="lp-eyebrow">原句跟读 · 真实音频评测</div>{acoustic ? acoustic.isRejected ? <p className="lp-error">{acoustic.exceptInfo || "声音不清晰或与原句不匹配，本次不展示分数。"}</p> : <div className="lp-score">{[["综合", acoustic.total], ["准确", acoustic.accuracy], ["流畅", acoustic.fluency], ["标准", acoustic.standard]].map(([label, value]) => <span key={label}><b>{Number(value).toFixed(1)}</b>{label}</span>)}</div> : <><p className="lp-hint">按录音时固定的原句评测。修改识别文字不会改变发音分。</p><button className="btn" disabled={Boolean(busy) || attempt.deviceId !== deviceId()} onClick={() => void pronunciation(attempt)}>{attempt.pronunciationStatus === "unknown" || attempt.pronunciationStatus === "submitting" ? "确认重新评测（可能再次计费）" : "评测这次跟读"}</button></>}</section>}
      {task.mode !== "follow" && <p className="lp-hint">表达建议基于你确认的文字；这次自由表达不生成发音分。</p>}
      {(attempt.status === "unknown" || attempt.pronunciationStatus === "unknown") && <p className="lp-error">上次请求的结果未知，已保留回答和原声。没有自动重发，再次提交可能产生新的用量。</p>}
      {attempt.error && <p className="lp-hint">{attempt.error}</p>}
    </article>;
  };
  return <><style>{CSS}</style><PNav title={task.status === "completed" ? "本轮复盘" : task.title} onBack={() => { if (recording) setError("请先结束或取消这次录音，保存后可以离开。"); else if (task.status === "completed") returnToSource(); else setExit(true); }} right={<button className="lp-link" disabled={recording || Boolean(busy)} onClick={() => setExit(true)}>结束</button>} />
    <main className="pbody lp-body">
      {error && <p className="lp-error" role="alert">{error}</p>}
      {exit && <section className="card lp-exit"><h3>这次先练到这里？</h3><p className="lp-hint">回答、原声与草稿会保留，下次可以从这里继续。</p><div className="lp-actions"><button className="btn primary" onClick={() => setExit(false)}>继续练这句</button><button className="btn" disabled={Boolean(busy)} onClick={() => void pause()}>保留进度，返回</button></div><button className="lp-link" disabled={Boolean(busy)} onClick={() => void finish()}>结束这一轮，看复盘</button></section>}
      {task.status === "completed" ? <><section className="card lp-complete"><div className="lp-eyebrow">{task.title}</div><h2>{answered === count ? "这一轮已完成" : "这轮先练到这里"}</h2><p>{answered} 步已回答 · {task.skippedSteps?.length ?? 0} 步已跳过 · {Math.max(0, count - answered - (task.skippedSteps?.length ?? 0))} 步待练</p><p className="lp-hint">文字与反馈跟账号同步，原声留在录制它的设备。</p></section>{task.attempts.map(attemptCard)}<button className="btn primary block" onClick={returnToSource}>回到练习来源</button><button className="lp-link" disabled={Boolean(busy)} onClick={() => void guard("正在继续练习", () => update(t => ({ ...t, status: "active" })))}>回到这一步，再说一次</button></> : <>
        <div className="lp-progress"><span>第 {task.step + 1} / {count} 步</span><span>已回答 {answered} / {count}</span></div>
        <article className="card lp-prompt"><div className="lp-eyebrow">{task.mode === "follow" ? "跟读这句原文" : task.mode === "word" ? "把这个表达用一次" : "这一步的沟通任务"}</div>{task.word && <div className="lp-word">{task.word}</div>}<h2>{taskReference(task)}</h2><div className="lp-actions"><button className="btn" onClick={() => speak(taskReference(task))}><Icon name="speaker" size={16} />听一遍</button><button className="btn" onClick={() => setHint(!hint)}>{hint ? "收起提示" : "给点提示"}</button></div>{hint && <p className="lp-hint">{task.mode === "word" ? `想一件和你有关的小事，用 ${task.word || "这个表达"} 说一句。先把意思说明白就好。` : task.mode === "follow" ? "先听停顿和重音，再完整跟读。发音评测始终与这句原文对照。" : "先回答当前问题，再补一个具体细节。不用一次说得很长。"}</p>}</article>
        {recording ? <section className="lp-recorder"><div className="lp-meter" aria-hidden="true"><i style={{ transform: `scaleX(${level})` }} /></div><p aria-live="off">正在录音 · {seconds} 秒 / 45 秒</p><button className="lp-mic" aria-label="结束录音" disabled={Boolean(busy)} onClick={() => void stopRecord()}><Icon name="stop" size={28} /></button><button className="lp-link" disabled={Boolean(busy)} onClick={() => void discardRecord()}>取消这次录音</button></section> : <>
          {showFeedback && latest && attemptCard(latest)}
          <section><label htmlFor="practice-answer">{latest?.clipId ? "这次识别到的回答 · 请核对后发送" : "我想这样说"}</label><textarea id="practice-answer" className="lp-input" maxLength={900} value={draft} disabled={Boolean(busy)} placeholder="用英语写下你想说的一句…" onChange={event => { const draft = event.target.value; setDraft(draft); void update(t => ({ ...t, draft })).catch(failure => setError(practiceError(failure))); }} /><p className="lp-hint">先核对识别文字，再决定发送。修改文字只用于表达反馈。</p></section>
          {processing && <p className="lp-error">上次操作在处理中退出，结果尚未确认。回答与录音已保留，选择继续时会发起一次新请求。</p>}
          {latest?.clipId && !latest.feedback && ["recorded", "failed", "interrupted", "unknown", "recognizing", "recording"].includes(latest.status) && <button className="btn block" disabled={Boolean(busy) || latest.deviceId !== deviceId()} onClick={() => void guard("正在识别这次录音", () => recognize(latest.id))}>重新识别已保存的原声</button>}
          {micIntro ? <section className="card lp-feedback"><h3>允许使用麦克风？</h3><p className="lp-hint">声音保存在这台设备。停下后可以修改识别结果，再发送文字或原句发音评测；语音服务会处理本次音频。</p><div className="lp-actions"><button className="btn primary" disabled={Boolean(busy)} onClick={() => void startRecord()}>允许，并开始录音</button><button className="btn" onClick={() => setMicIntro(false)}>先用文字回答</button></div></section> : <div className="lp-recorder"><button className="lp-mic" aria-label="开始回答录音" disabled={Boolean(busy)} onClick={() => setMicIntro(true)}><Icon name="mic" size={30} /></button><p className="lp-hint">{showFeedback ? "重说一次，会保留上一条回答" : "点一下，先说一句短回答"}</p></div>}
          <div className="lp-dock"><button className="btn primary block" disabled={Boolean(busy) || !draft.trim()} onClick={() => void submit()}>{busy || (latest?.status === "unknown" ? "确认再次提交回答" : "确认文字，发送回答")}</button>{showFeedback && <button className="btn block" disabled={Boolean(busy)} onClick={() => void next()}>{task.step + 1 < count ? "继续下一步" : "完成这一轮，看复盘"}</button>}<button className="lp-link" disabled={Boolean(busy)} onClick={() => void next(true)}>这一步先跳过，留待下次练</button></div>
        </>}
        {task.attempts.length > 1 && <details className="lp-history"><summary>查看这轮此前的回答（{task.attempts.length - (latest ? 1 : 0)}）</summary>{task.attempts.filter(a => a.id !== latest?.id).map(attemptCard)}</details>}
      </>}
    </main></>;
}

export default LearningPractice;
