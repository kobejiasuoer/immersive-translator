import { useState } from "react";
import { BUILTIN_SCENES, customSceneTaskInput, practiceStepTitle } from "../components/speaking/scenes";
import { CustomSceneSheet } from "../components/speaking/CustomSceneSheet";
import { ReplacePracticeSheet } from "../components/speaking/ReplacePracticeSheet";
import { VoiceSettingsSheet } from "../components/speaking/VoiceSettingsSheet";
import { vocabMeaning } from "../core/vocabMeaning";
import { actions, toast, useApp } from "../store";
import { createPracticeTask, type PracticeTask } from "../services/practice";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import { Heading } from "../ui/LearningHeading";
import { openPractice } from "../services/openPractice";
import "./speakingExperience.css";

type PracticeInput = Parameters<typeof createPracticeTask>[0];

/** A small practice workspace: continue, use one saved expression, or enter a real scene. */
export function SpeakingHome() {
  const nav = useNav();
  const tasks = useApp(s => s.tasks);
  const words = useApp(s => s.vocab);
  const customScenes = useApp(s => s.customScenes);
  const articles = useApp(s => s.articles);
  const progress = useApp(s => s.progress);
  const [pending, setPending] = useState<PracticeInput | null>(null);
  const [sceneSheet, setSceneSheet] = useState(false);
  const [voiceSheet, setVoiceSheet] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const unfinished = sorted.find(t => t.status !== "completed");
  const unfinishedAnswered = new Set((unfinished?.attempts ?? []).filter(a => a.feedback).map(a => a.step)).size;
  const recent = sorted.filter(t => t.id !== unfinished?.id).slice(0, 3);
  const readyWords = words.filter(w => !w.paused);
  const selectedWord = readyWords.find(w => w.id === selectedWordId) ?? readyWords[0];
  const reading = [...articles].filter(a => !a.archived && progress[a.id] !== undefined).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
  const followLines = reading ? [...reading.sentences].sort((x, y) => x.idx - y.idx).filter(s => s.idx >= (progress[reading.id] ?? 0)).slice(0, 3).map(s => s.en) : [];
  // Without saved vocabulary, use an expression actually provided by a saved reading item.
  const hasTerms = (a: typeof articles[number] | undefined) => Boolean(a?.terms?.some(w => w?.trim()));
  const termDoc = hasTerms(reading) ? reading : [...articles].filter(a => !a.archived && hasTerms(a)).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
  const expression = selectedWord?.word ?? termDoc?.terms?.find(w => w?.trim());
  const sourceArticle = selectedWord ? articles.find(a => a.id === selectedWord.sourceArticleId) : termDoc;
  const meaning = selectedWord ? vocabMeaning(selectedWord) : "";
  const begin = async (input: PracticeInput) => {
    if (unfinished) { setPending(input); return; }
    await openPractice(nav, input);
  };
  const startExpression = () => {
    if (!expression) { actions.setTab("today"); return; }
    const source = selectedWord?.sourceArticleId
      ? { articleId: selectedWord.sourceArticleId, sentenceIdx: selectedWord.sourceSentenceIdx ?? 0 }
      : !selectedWord && termDoc
        ? { articleId: termDoc.id, sentenceIdx: termDoc.sentences.find(s => s.en.toLowerCase().includes(expression.toLowerCase()))?.idx ?? progress[termDoc.id] ?? 0 }
        : undefined;
    void begin({ mode: "word", title: `用 ${expression} 说一句`, word: expression, reference: `Try one short sentence using "${expression}".`, ...(source ? { source } : {}) });
  };
  const restartUnfinished = () => {
    if (!unfinished) return;
    const { mode, title, reference, word, source, steps, minAnswerWords } = unfinished;
    void begin({ mode, title, reference, word, source, steps, minAnswerWords });
  };
  const changeExpression = () => {
    const index = readyWords.findIndex(w => w.id === selectedWord?.id);
    setSelectedWordId(readyWords[(index + 1) % readyWords.length].id);
  };

  if (historyOpen) return <SpeakingHistory sorted={sorted} onBack={() => setHistoryOpen(false)} />;
  return <>
    <Heading title="口语" extra={<button className="ibtn" aria-label="语音与朗读" onClick={() => setVoiceSheet(true)}><Icon name="wave" /></button>} />
    <main className="learning-body speaking-home">
      {unfinished && <section className="sp-home-resume" aria-label="继续上次练习">
        <div className="sp-home-resume-top"><span>上次练到这里</span><button onClick={restartUnfinished}>重新开始</button></div>
        <button className="sp-home-resume-main" aria-label={`继续上次练习：${unfinished.title}`} onClick={() => nav.push("learningPractice", { taskId: unfinished.id })}>
          <span className="sp-home-resume-icon"><Icon name="mic" size={21} /></span>
          <span className="sp-home-resume-copy"><b>{unfinished.mode === "word" && unfinished.word?.toLocaleLowerCase() === expression?.toLocaleLowerCase() ? "表达短练习" : unfinished.title}</b><small>{practiceStepTitle(unfinished)}<span>已回答 {unfinishedAnswered} / {unfinished.steps?.length || 1} 步</span></small></span>
          <span className="sp-home-resume-go">继续<Icon name="right" size={14} /></span>
        </button>
      </section>}

      <section className="sp-expression" aria-labelledby="sp-expression-heading">
        <div className="sp-expression-heading"><h2 id="sp-expression-heading">一个表达，一句话</h2>{readyWords.length > 1 && <button className="sp-home-link" onClick={changeExpression}><Icon name="sync" size={14} />换一个</button>}</div>
        {expression ? <>
          <div className="sp-expression-content" aria-live="polite">
            <p className="sp-expression-word" lang="en">{expression}</p>
            {meaning && meaning !== "暂无释义" ? <p className="sp-expression-meaning">{meaning}</p> : <p className="sp-expression-meaning">试着用它，说一件和你有关的小事。</p>}
            <p className="sp-expression-source"><Icon name={selectedWord ? "mark" : "bookopen"} size={13} /><span>{selectedWord ? "来自我的生词本" : "来自阅读"}{sourceArticle ? ` / ${sourceArticle.bookTitle || sourceArticle.title}` : ""}</span></p>
          </div>
          <div className="sp-expression-actions">
            <button className="sp-expression-start btn" onClick={startExpression}><Icon name="mic" size={18} />开始一句短练习</button>
            <button className="sp-expression-more" onClick={() => nav.push("learningWordbook")} aria-label="去生词本挑一个">生词本<Icon name="right" size={13} /></button>
          </div>
        </> : <div className="sp-expression-empty"><p>从阅读里留住一个想用的表达，下一次就在这里开口。</p><button className="btn" onClick={() => actions.setTab("today")}><Icon name="bookopen" size={17} />去阅读，积累表达</button></div>}
      </section>

      <section className="sp-home-section" aria-labelledby="sp-scenes-heading">
        <div className="sp-home-section-head"><h2 id="sp-scenes-heading">生活场景</h2><span>从一句自然的对话开始</span></div>
        <div className="sp-scene-list">
          {BUILTIN_SCENES.map(scene => <button className="sp-scene" key={scene.title} onClick={() => void begin({ mode: "scenario", title: `场景对话 · ${scene.title}`, reference: scene.steps[0].prompt, steps: scene.steps.map(s => s.prompt) })}>
            <span className="sp-scene-copy"><span className="sp-scene-title"><b>{scene.title}</b><small>{scene.level}</small></span><span className="sp-scene-description">{scene.description}</span></span>
            <span className="sp-scene-foot">{scene.steps.length} 轮</span><Icon name="right" size={15} />
          </button>)}
        </div>
        {customScenes.length > 0 && <div className="sp-custom-scenes">{customScenes.map(scene => <button className="sp-home-row" key={scene.id} onClick={() => void begin(customSceneTaskInput(scene))}><span className="sp-home-row-icon"><Icon name="chat" size={18} /></span><span className="sp-home-row-copy"><b>{scene.title}</b><small>{scene.goal}</small></span><span className="sp-home-row-meta">我的场景</span><Icon name="right" size={14} /></button>)}</div>}
      </section>

      <section className="sp-home-section" aria-labelledby="sp-follow-heading">
        <div className="sp-home-section-head"><h2 id="sp-follow-heading">按自己的节奏</h2></div>
        <div className="sp-personal-list">
        <button className="sp-home-row sp-free-practice" onClick={() => setSceneSheet(true)}>
          <span className="sp-home-row-icon"><Icon name="mic" size={22} /></span><span className="sp-home-row-copy"><b>自由练习</b><small>自建场景，聊聊你想说的事</small></span><Icon name="right" size={16} />
        </button>
        {reading && followLines.length ? <button className="sp-follow" onClick={() => void begin({ mode: "follow", title: "跟读原文", reference: followLines[0], steps: followLines, source: { articleId: reading.id, sentenceIdx: progress[reading.id] ?? 0 } })}>
          <span className="sp-home-row-icon"><Icon name="bookopen" size={22} /></span><span className="sp-home-row-copy"><b>跟读原文</b><small>{reading.title} · 第 {(progress[reading.id] ?? 0) + 1} 句起</small></span><Icon name="right" size={16} />
        </button> : <button className="sp-follow sp-follow-empty" onClick={() => actions.setTab("today")}><span className="sp-home-row-icon"><Icon name="bookopen" size={22} /></span><span className="sp-home-row-copy"><b>跟读原文</b><small>打开一篇文章，从读到的那句开始</small></span><Icon name="right" size={16} /></button>}
        </div>
      </section>

      <section className="sp-home-section" aria-labelledby="sp-history-heading">
        <div className="sp-home-section-head"><h2 id="sp-history-heading">最近练习</h2>{sorted.length > 0 && <button className="sp-home-link" onClick={() => setHistoryOpen(true)}>查看全部<Icon name="right" size={14} /></button>}</div>
        {recent.length ? <div className="sp-history-list">{recent.map(task => <PracticeRow key={task.id} task={task} onOpen={() => nav.push("learningPractice", { taskId: task.id })} />)}</div> : <p className="sp-home-empty">{unfinished ? "这轮结束后，可以在这里回看回答和建议。" : "你的第一句，会是积累的开始。练习后可在这里回看。"}</p>}
      </section>
      <p className="sp-home-storage">文字与反馈随账号同步，原声留在录制设备。</p>
    </main>
    <ReplacePracticeSheet open={!!pending} title={unfinished?.title ?? ""} answered={unfinishedAnswered}
      onClose={() => setPending(null)}
      onContinue={() => { const target = unfinished; setPending(null); if (target) nav.push("learningPractice", { taskId: target.id }); }}
      onReplace={() => {
        const target = unfinished, input = pending; setPending(null);
        // Keep previous answers in recap before starting the replacement task.
        void (async () => { if (target) await actions.upsertTask({ ...target, status: "completed" }); if (input) await openPractice(nav, input); })().catch(e => toast(String(e)));
      }} />
    <CustomSceneSheet open={sceneSheet} onClose={() => setSceneSheet(false)} onSave={scene => {
      try { actions.saveCustomScene(scene); setSceneSheet(false); void begin(customSceneTaskInput(scene)); }
      catch (e) { toast(String(e)); }
    }} />
    <VoiceSettingsSheet open={voiceSheet} onClose={() => setVoiceSheet(false)} />
  </>;
}

function PracticeRow({ task, onOpen }: { task: PracticeTask; onOpen: () => void }) {
  return <button className="sp-home-row" onClick={onOpen}>
    <span className="sp-home-row-icon"><Icon name={task.mode === "scenario" ? "chat" : task.mode === "follow" ? "bookopen" : "mic"} size={18} /></span>
    <span className="sp-home-row-copy"><b>{task.title}</b><small>{when(task.updatedAt)} / {task.attempts.length} 次回答</small></span>
    <span className="sp-home-row-meta">{task.status === "completed" ? "本轮完成" : "待继续"}</span><Icon name="right" size={14} />
  </button>;
}

/** Shared timestamp formatting for practice history and the practice detail header. */
export function when(at: number) {
  const d = new Date(at), now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function SpeakingHistory({ sorted, onBack }: { sorted: PracticeTask[]; onBack: () => void }) {
  const nav = useNav();
  return <>
    <header className="learning-head nhead"><button className="tlink" data-nav-back aria-label="返回" onClick={onBack}><Icon name="left" size={18} /></button><div className="nt"><h1>练习记录</h1><small>每次自己的回答，都能回看</small></div><span /></header>
    <main className="learning-body speaking-home sp-history-page">
      {sorted.length ? <div className="sp-history-list">{sorted.map(task => <PracticeRow key={task.id} task={task} onOpen={() => nav.push("learningPractice", { taskId: task.id })} />)}</div> : <p className="sp-home-empty">还没有练习记录。</p>}
    </main>
  </>;
}
