/**
 * 复习流（push）—— §3.8：识别/完形/听写三形态（smart 路由 #51）+ 开口使用卡。
 * proto-parity-2026-11-01（vault 域）：nhead 页头（模式标题 + 本轮 N/M 副标 + 右上星标 +
 * accent 细进度条）、题目套白卡（tag + 来源 + eyebrow）、完形挖空 tape 斜纹块、答案 ans 块 +
 * rv-ex 释义回显卡、提示盒三级阶梯（思路/开头/完整例句 + 听示范 + N/3）、三档自评
 * （原型 html:2954：没记住·10 分钟后再看/有点模糊·明天再看/记住了·几天后再看）、
 * 听音辨认 70px 喇叭钮/听完标题句/eyeoff 灰条/禁用核对钮、底部「换成○○试试/保存进度并返回」、
 * 完成页 76px ✓ 圆环 + 三档计数卡 + 下一轮待强化卡 + 回今日复习主钮 + 调整学习提醒行。
 * 判分 = core/judge（perfect/close/trap/wrong + wordDiff 三色，勿重写）；
 * 调度 = core/srs GRADE_INTERVALS；每张即落盘（actions.gradeVocab）。
 * 撤销语义（定稿 2026-09-25）：恢复到「已亮答案、评分可改」的评分前一刻；undoGrade
 * 回滚 dueAt 与计数。三档 UI 仅少一档展示位（good=3 天档不再直选），SRS 与事件协议不变。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { vocabMeaning } from "../core/vocabMeaning";
import { actions, activeRepository, commitRepository, flushPersist, getState, profileIdentity, reviewStats, speak, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { haptic } from "../services/device";
import { judge, JUDGE_SUGGEST, type Verdict } from "../core/judge";
import { GRADE_INTERVALS, type ReviewGrade } from "../core/srs";
import { buildReviewQueue, cardForWord, type ReviewCard } from "../core/queue";
import type { Article, VocabWord } from "../core/types";
import { SpokenReviewCard, SPOKEN_GRADES, type SpokenState } from "../components/vault/SpokenReviewCard";
import { WordDetailSheet } from "../components/vault/WordDetailSheet";
import { ReminderSheet } from "../components/vault/ReminderSheet";
import { formatDueAt, pendingReinforcements } from "../components/vault/derive";

export interface ReviewProps {
  wordId?: string;
  from?: string;
  cards?: ReviewCard[];
  /** 今日复习卡选定的模式偏好（原型 V2_LEARN_MODES）：cloze=现行智能混排；listen=有原句即听写；speak=开口卡。 */
  mode?: "cloze" | "listen" | "speak";
}

/* 三档自评（原型 html:2954 v2-review-grades）。good=3 天档保留在 SRS 内核，
   仅不再作为直选按钮（梯度仍可经预复习等历史路径出现，展示层 GRADE_LABEL 兼容）。 */
const GRADES: [ReviewGrade, string, string][] = [
  ["forgot", "没记住", "10 分钟后再看"],
  ["hard", "有点模糊", "明天再看"],
  ["easy", "记住了", "几天后再看"],
];

/* 页头描述当前题型：没有原句的识别卡不冒充填空题。 */
const MODE_TITLE: Record<ReviewCard["mode"], string> = {
  recognition: "表达回忆",
  cloze: "填空回忆",
  dictation: "听音辨认",
  spoken: "开口使用",
};

interface CardState {
  phase: "front" | "answer" | "graded";
  input: string;
  hints: number;
  judged: Verdict | null;
  /** 听写卡：已按过「听这条表达」（听后才可核对，原型 listen disabled 口径）。 */
  listened?: boolean;
  /** 开口卡专属（vault-review-parity）：试说/核对文字/核对用法三段 + 原声与回答文字（随草稿恢复）。 */
  spoken?: SpokenState;
}

/** 本轮单卡结果：mode + 判分（开口卡无自动判分 → null）+ 所选档位（完成页三档计数用）。 */
interface CardResult {
  mode: ReviewCard["mode"];
  judged: Verdict | null;
  grade?: ReviewGrade;
}

export default function ReviewScreen({ wordId, from, cards, mode }: ReviewProps) {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  const st = useApp(reviewStats);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [starWord, setStarWord] = useState<string | null>(null);

  const queue = useMemo<ReviewCard[]>(() => {
    const built = cards && cards.length ? [...cards] : wordId ? (() => {
      const c = cardForWord(wordId, vocab as VocabWord[], articles as Article[]);
      return c ? [c] : [];
    })() : buildReviewQueue(vocab as VocabWord[], articles as Article[]);
    /* 模式偏好（今日复习卡三模式 chips）：listen=有原句改听写；speak=开口卡。cloze=智能混排不动。 */
    if (mode === "listen") {
      return built.map((c) => {
        const sent = c.articleId ? (articles as Article[]).find((a) => a.id === c.articleId)?.sentences[c.sentIdx] : undefined;
        return sent ? { ...c, mode: "dictation" as const, answer: sent.en, pre: undefined, post: undefined, hint: sent.zh || c.hint } : c;
      });
    }
    if (mode === "speak") return built.map((c) => ({ ...c, mode: "spoken" as const, pre: undefined, post: undefined }));
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [restored, setRestored] = useState(false);
  const identity = useRef(profileIdentity());
  const sessionId = useRef<string>(crypto.randomUUID());
  const saveDraft = useRef<Promise<void>>(Promise.resolve());
  const [pos, setPos] = useState(0);
  const [cs, setCs] = useState<CardState>(() => initCard(queue[0]));
  const [results, setResults] = useState<CardResult[]>([]);
  const [finished, setFinished] = useState(false);
  const [input, setInput] = useState("");
  const snap = useRef<CardState | null>(null);
  const advTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undone = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /* P-11：一次评分只落一档；P-09：撤销要回到被评分那张；P-10/P-14：streak 退出完成页一次性判定 */
  const gradeLock = useRef(false);
  const gradedPos = useRef(0);
  const finishedRef = useRef(false);
  const streakCommitted = useRef(false);

  useEffect(() => {
    if (cs.phase === "answer" && queue[pos]?.mode !== "recognition" && queue[pos]?.mode !== "spoken" && queue[pos]?.mode !== "dictation") {
      /* 完形输入自动聚焦（治 I3）；听写/开口先听先说，不抢键盘 */
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [pos, cs.phase, queue]);

  useEffect(
    () => () => {
      if (advTimer.current) clearTimeout(advTimer.current);
      stopSpeak();
    },
    [],
  );

  /* P-10/P-14/P-18：streak 在退出完成页时一次性判定——本轮队列全部清完（无未撤销的评分）
     且今日到期已清空（due===0）才 +1；完成页文案用 reviewStats 的今日真实已清数。
     预复习/加练不算今日复习：wordId 单卡预复习与生词页入口（from:"vocab"、传入 cards）
     的队列不含「进入时已到期」承诺，判完不 +1（治 home-2：streak 虚高且可同日反复刷）。 */
  const streakEligible = !wordId && from !== "vocab" && !(cards && cards.length);
  function exitFinished(destination: "back" | "home" = "back") {
    if (streakCommitted.current) return;
    streakCommitted.current = true;
    const eligible = streakEligible && queue.length > 0 && results.length === queue.length && st.due === 0;
    void saveDraft.current.then(() => actions.completeReviewSession(wordId || "current", eligible)).then(() => destination === "home" ? nav.popAll() : nav.pop()).catch(error => { streakCommitted.current = false; toast(String(error)); });
  }

  useEffect(() => {
    let alive=true;
    void activeRepository().get<{ sessionId?:string;queue:ReviewCard[];pos:number;cs:CardState;input:string;results:CardResult[];finished:boolean }>("local.review",wordId||"current").then(row=>{
      if(!alive || identity.current !== profileIdentity())return;
      const draft=row?.payload;
      if(draft && Array.isArray(draft.queue) && draft.queue.length && draft.pos<draft.queue.length && draft.queue.every(c=>getState().vocab.some(w=>w.id===c.id))) {
        queue.splice(0,queue.length,...draft.queue);
        if (draft.sessionId) sessionId.current = draft.sessionId;
        const events = getState().reviewEvents;
        const reversed = new Set(events.filter(e => e.kind === "undo").map(e => e.reversesEventId));
        const recovered: CardResult[] = [];
        for (let index = 0; index < queue.length; index++) {
          const prefix = "review:" + sessionId.current + ":" + index + ":";
          const grade = events.find(e => e.kind === "grade" && e.id.startsWith(prefix) && !reversed.has(e.id));
          if (!grade) break;
          recovered.push({ mode: queue[index].mode, judged: grade.recall?.bucket === "trap" ? "trap" : grade.recall?.bucket === "wrong" ? "wrong" : "perfect", grade: grade.grade });
        }
        const nextPos = draft.sessionId ? recovered.length : draft.pos;
        const done = nextPos >= queue.length;
        setPos(Math.min(nextPos, queue.length - 1));
        setCs(nextPos === draft.pos ? draft.cs : initCard(queue[nextPos]));
        setInput(nextPos === draft.pos ? draft.input : "");
        setResults(draft.sessionId ? recovered : draft.results);
        setFinished(done || !draft.sessionId && draft.finished); finishedRef.current = done;
      }
      setRestored(true);
    }).catch(error=>{toast(String(error));setRestored(true);});
    return ()=>{alive=false;};
  },[]);
  useEffect(()=>{
    if(!restored || profileIdentity()!==identity.current)return;
    const payload={sessionId:sessionId.current,queue,pos,cs,input,results,finished};
    saveDraft.current=saveDraft.current.then(()=>{if(profileIdentity()!==identity.current)return;return commitRepository({records:[{collection:"local.review",id:wordId||"current",payload}]});});
    void saveDraft.current.catch(error=>toast(String(error)));
  },[restored,pos,cs,input,results,finished]);

  if (!restored) return <div className="learning-body" role="status">正在恢复复习进度…</div>;

  if (finished) {
    const dayDone = st.due === 0 && results.length === queue.length;
    /* vault-review-parity：完成页补全——待强化（forgot 未到期回流窗）与三档计数均由真实
       reviewEvents/本轮评分推导，不造数。 */
    const pending = pendingReinforcements(getState());
    const tiers = {
      known: results.filter((r) => r.grade === "good" || r.grade === "easy").length,
      fuzzy: results.filter((r) => r.grade === "hard").length,
      forgot: results.filter((r) => r.grade === "forgot").length,
    };
    return (
      <>
        <ReviewTop title="本轮完成" subtitle={`已复习 ${results.length} 条`} onExit={() => exitFinished()} />
        <div className="rv-stage review-workspace">
          <div className="v2-review-done">
            <DoneRing />
            <h3>{tiers.forgot ? `${tiers.forgot} 条还需要巩固` : "这些表达，又熟悉了一点"}</h3>
            <p>
              {tiers.forgot && pending.length
                ? `本轮已完成，没记住的表达将在 ${formatDueAt(pending[0].dueAt)} 再次出现。`
                : st.due > 0
                  ? `现在还有 ${st.due} 条到期复习。`
                  : pending.length
                    ? `另有 ${pending.length} 条待强化，还没到时间。`
                    : "今天暂时没有到期复习，可以继续阅读。"}
            </p>
            <div className="learning-card v2-review-tally">
              <div>
                <b>{tiers.known}</b>
                <small>记住了</small>
              </div>
              <div>
                <b>{tiers.fuzzy}</b>
                <small>有点模糊</small>
              </div>
              <div>
                <b>{tiers.forgot}</b>
                <small>没记住</small>
              </div>
            </div>
            {/* 下一轮待强化（原型 div.card.v2-review-followup，html:2962）：静态信息卡——待强化按
                10 分钟回流窗到点后才进入复习（原型 v2LaunchReview「还没到时间，稍后回来」），不提供提前开轮。 */}
            {pending.length > 0 && (
              <div className="learning-card v2-review-followup">
                <b>下一轮：{pending.length} 条待强化</b>
                <p>{formatDueAt(pending[0].dueAt)}</p>
                <span style={{ display: "flex", flexWrap: "wrap" }}>
                  {pending.slice(0, 5).map((p) => (
                    <span key={p.word.id} className="learning-chip" lang="en">
                      {p.word.word}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {st.due > 0 && (
              <div className="meta" style={{ marginBottom: 12 }}>
                剩余到期 {st.due} 张 · 连续 {dayDone ? (getState().stats.lastReviewStreakDay === getState().stats.day ? st.streak : st.streak + 1) : st.streak} 天
              </div>
            )}
            <button className="btn" style={{ width: "100%" }} onClick={() => exitFinished("home")}>
              回今日复习，查看下一次安排
            </button>
            <button
              className="btn-ghost v2-learning-secondary"
              style={{ border: "1px solid var(--hairline-strong)" }}
              onClick={() => {
                if (streakCommitted.current) return;
                streakCommitted.current = true;
                const eligible = streakEligible && queue.length > 0 && results.length === queue.length && st.due === 0;
                void saveDraft.current.then(() => actions.completeReviewSession(wordId || "current", eligible)).then(() => { nav.popAll(); actions.setTab("vocab"); }).catch(error => { streakCommitted.current = false; toast(String(error)); });
              }}
            >
              回到生词本
            </button>
            {/* 完成页到「调整学习提醒」行为止（原型 VIEWS.review 完成分支 html:2961：主按钮 + 次按钮 +
                v2-reminder-row，无「整理成笔记」出口；复检 r2 review-done） */}
            <button className="v2-reminder-row" onClick={() => setReminderOpen(true)}>
              <Icon name="bell" size={14} />
              <span>调整学习提醒</span>
              <Icon name="right" size={13} />
            </button>
          </div>
        </div>
        <ReminderSheet open={reminderOpen} onClose={() => setReminderOpen(false)} />
      </>
    );
  }

  const card = queue[pos];
  if (!card) {
    /* 队列空 → 预复习入口式空态（§3.8） */
    return (
      <>
        <ReviewTop title="复习" subtitle="" onExit={nav.pop} />
        <div className="rv-stage review-workspace">
          <div className="serif" style={{ fontSize: 24, fontWeight: 600, textAlign: "center" }}>
            现在没有到期的卡片
          </div>
          <div className="meta" style={{ textAlign: "center", marginTop: 8 }}>
            可以提前预复习，或先去读点什么
          </div>
          <button className="btn-ghost" style={{ marginTop: 20, border: "1px solid var(--hairline-strong)", maxWidth: 240, alignSelf: "center" }} onClick={() => nav.pop()}>
            返回
          </button>
        </div>
      </>
    );
  }

  function initCard(c?: ReviewCard): CardState {
    if (c?.mode === "spoken") return { phase: "answer", input: "", hints: 0, judged: null, spoken: { stage: "ask", text: "" } };
    return { phase: c?.mode === "recognition" ? "front" : "answer", input: "", hints: 0, judged: null, listened: false };
  }

  /* 模式切换（原型 v2-review-change-mode）：有原句材料才切，否则 toast 说明保持当前形态。 */
  function switchMode(target: "dictation" | "cloze") {
    if (cs.phase === "graded") return;
    if (target === "dictation") {
      const sent = card.articleId ? articles.find((a) => a.id === card.articleId)?.sentences[card.sentIdx] : undefined;
      if (!sent) {
        toast("原句不在本机，先保持当前方式");
        return;
      }
      queue[pos] = { ...card, mode: "dictation", answer: sent.en, pre: undefined, post: undefined, hint: sent.zh || card.hint };
    } else {
      const base = cardForWord(card.id, getState().vocab as VocabWord[], articles as Article[]);
      const sent = card.articleId ? articles.find((a) => a.id === card.articleId)?.sentences[card.sentIdx] : undefined;
      const wordInSentence = base && sent ? sent.en.toLowerCase().indexOf(base.word.toLowerCase()) > -1 : false;
      if (!base || !sent || !wordInSentence) {
        toast("这条表达没有原句填空，先保持当前方式");
        return;
      }
      const at = sent.en.toLowerCase().indexOf(base.word.toLowerCase());
      queue[pos] = { ...base, mode: "cloze", answer: base.word, pre: sent.en.slice(0, at).trim(), post: sent.en.slice(at + base.word.length).trim() };
    }
    setCs(initCard(queue[pos]));
    setInput("");
  }

  function submit() {
    if (cs.phase === "graded") return;
    const v = judge(input, card.answer, card.trap, [card.word]);
    setCs((s) => ({ ...s, phase: "graded", input, judged: v }));
  }

  async function grade(g: ReviewGrade) {
    if (!restored || gradeLock.current) return; /* P-11：评分一次性，自动前进窗口内连点只落第一档 */
    gradeLock.current = true;
    try { await saveDraft.current; await flushPersist(); } catch(error) { gradeLock.current = false; toast(String(error)); return; }
    if (profileIdentity() !== identity.current) { gradeLock.current = false; return; }
    undone.current = false;
    gradedPos.current = pos;
    snap.current = { ...cs };
    haptic("light"); /* U-19：评分触感（规格：评分=light，真机轻微单脉冲） */
    /* 识别卡无判分输入：按所选档位映射摘要判定（easy/good→写对，hard→接近，forgot→未想起） */
    const judged: Verdict | null =
      card.mode === "recognition"
        ? g === "easy" || g === "good"
          ? "perfect"
          : g === "hard"
            ? "close"
            : "wrong"
        : cs.judged;
    const prefix = "review:" + sessionId.current + ":" + pos + ":";
    const ordinal = getState().reviewEvents.filter(e => e.kind === "grade" && e.id.startsWith(prefix)).length;
    /* 开口卡（vault-review-parity）：无自动判分 → 不落 recall 桶（bucket 缺省即不写 recall）；
       answer 记用户确认的试说文字。撤销/幂等仍走既有 lastGrade + eventId 机制。 */
    const spoken = card.mode === "spoken";
    const bucket = spoken ? undefined : judged === "trap" ? "trap" : judged === "wrong" ? "wrong" : "pass";
    try {
      actions.gradeVocab(card.id, g, { eventId:prefix+ordinal, trap: !spoken && judged === "trap", mode:card.mode, answer: spoken ? (cs.spoken?.text ?? "") : input, expected: spoken ? card.word : card.answer, ...(bucket ? { bucket } : {}) });
      await flushPersist();
    } catch (error) { gradeLock.current = false; toast(String(error)); return; }
    setResults((r) => [...r, { mode: card.mode, judged, grade: g }]);
    const again = spoken ? (SPOKEN_GRADES.find((x) => x.grade === g)?.again ?? `${GRADE_INTERVALS[g].label}后再见`) : `${GRADE_INTERVALS[g].label}后再见`;
    toast(`已记 · ${again}`, {
      action: "撤销",
      onAction: () => {
        undone.current = true;
        if (advTimer.current) clearTimeout(advTimer.current);
        gradeLock.current = false;
        if (snap.current) setCs(snap.current);
        setResults((r) => r.slice(0, -1));
        actions.undoGrade();
        /* P-09：500ms 自动前进已切走、甚至已进完成页时，撤销要回到被评分那张的
           评分前一刻（已亮答案、评分可改），原卡重回本轮，下一张不受污染 */
        if (finishedRef.current) {
          finishedRef.current = false;
          setFinished(false);
        }
        setPos(gradedPos.current);
      },
    });
    if (advTimer.current) clearTimeout(advTimer.current);
    advTimer.current = setTimeout(() => {
      if (undone.current) return;
      if (pos >= queue.length - 1) {
        finishedRef.current = true;
        setFinished(true); /* streak 改在退出完成页时判定（P-10/P-14），此处不落打卡 */
      } else {
        gradeLock.current = false;
        setPos((p) => p + 1);
        setCs(initCard(queue[pos + 1]));
        setInput("");
      }
    }, 500);
  }

  /* 三档 UI 的建议档：close 原映射 good（3 天档不在三档内），归入 hard 展示建议态。
     复检 r1：没写答案（选填留空）就不做判定式建议——空答案判 wrong 只是「没有输入」，
     不该把「没记住」高亮成建议（原型自评三格无预选，html:2954）。 */
  const suggest = cs.judged && cs.input.trim() ? ((JUDGE_SUGGEST[cs.judged] === "good" ? "hard" : JUDGE_SUGGEST[cs.judged]) as ReviewGrade) : null;
  const source = card.articleId ? articles.find((a) => a.id === card.articleId) : undefined;
  const example = card.mode === "dictation" ? card.answer : card.pre !== undefined ? `${card.pre} ${card.answer} ${card.post}`.trim() : source?.sentences[card.sentIdx]?.en || card.answer;
  /* 目标词「词性 释义」行（原型听音揭示态 word.pos，如「n. 志愿者（复数）」，html:2932）。 */
  const sourceWord = vocab.find((w) => w.id === card.id);
  const definition = sourceWord ? vocabMeaning(sourceWord) : card.hint;

  return (
    <>
      <ReviewTop
        title={MODE_TITLE[card.mode]}
        subtitle={`本轮 ${pos + 1} / ${queue.length}`}
        onExit={nav.pop}
        progress={queue.length ? (results.length / queue.length) * 100 : 0}
        onStar={() => setStarWord(card.id)}
      />
      <div className="rv-stage review-workspace">
        <div className="rv-card learning-card v2-review-card" key={pos + card.mode}>
          <div className="v2-note-h">
            <span className="learning-tag">{card.kind === "chunk" ? card.chunkType || "词块" : "单词"}</span>
            <span>{source?.title || "手动收集"}</span>
          </div>
          {card.mode === "recognition" && <RecogCard card={card} cs={cs} flip={() => setCs((s) => ({ ...s, phase: "answer" }))} />}
          {card.mode === "cloze" && (
            <ClozeCard
              card={card}
              cs={cs}
              translation={source?.sentences[card.sentIdx]?.zh || ""}
              definition={definition}
              input={input}
              setInput={setInput}
              inputRef={inputRef}
              onSubmit={submit}
              onHint={() => setCs((s) => ({ ...s, hints: Math.min(3, s.hints + 1) }))}
              example={example}
            />
          )}
          {card.mode === "dictation" && (
            <DictCard
              card={card}
              cs={cs}
              definition={definition}
              target={targetSpan(card.answer, card, articles as Article[])}
              input={input}
              setInput={setInput}
              inputRef={inputRef}
              onSubmit={submit}
              onHint={() => setCs((s) => ({ ...s, hints: Math.min(3, s.hints + 1) }))}
              onPlay={() => {
                speak(card.answer, 1);
                setCs((s) => ({ ...s, listened: true }));
              }}
            />
          )}
          {card.mode === "spoken" && (
            <SpokenReviewCard
              card={card}
              state={cs.spoken ?? { stage: "ask", text: "" }}
              patch={(next) => setCs((s) => ({ ...s, spoken: { ...(s.spoken ?? { stage: "ask", text: "" }), ...next } }))}
              articles={articles as Article[]}
              onGrade={(g) => grade(g)}
              grading={gradeLock.current}
              hint={<HintBox card={card} hints={cs.hints} onHint={() => setCs((s) => ({ ...s, hints: Math.min(3, s.hints + 1) }))} example={example} definition={definition} />}
              definition={definition}
            />
          )}
          {card.mode !== "spoken" && (cs.phase === "graded" || (card.mode === "recognition" && cs.phase === "answer")) && (
            <div className="v2-self-grade rv-flip">
              <p>你这次回忆得怎么样？</p>
              <div className="grades v2-review-grades">
                {GRADES.map(([g, g1, g2]) => (
                  <button
                    key={g}
                    className={`grade ${cs.judged && g === suggest ? "focus" : ""}`}
                    style={cs.judged && g === suggest ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
                    onClick={() => grade(g)}
                  >
                    <span className="g1">{g1}</span>
                    <span className="g2">{g2}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {card.mode !== "recognition" && (
            <div className="v2-learning-actions v2-review-switch">
              <button
                className="btn-ghost"
                style={{ border: "1px solid var(--hairline-strong)" }}
                disabled={gradeLock.current}
                onClick={() => switchMode(card.mode === "dictation" || card.mode === "spoken" ? "cloze" : "dictation")}
              >
                换成{card.mode === "dictation" || card.mode === "spoken" ? "填空" : "听音"}试试
              </button>
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => nav.pop()}>
                返回
              </button>
            </div>
          )}
        </div>
      </div>
      {starWord && <WordDetailSheet wordId={starWord} onClose={() => setStarWord(null)} />}
    </>
  );
}

/* ---------- 页头（原型 nhead，html:1015-1018,2949）：返回 + 居中标题/副标 + 右上星标圆钮；
   header 下沿 accent 细进度条（html:2950 v2-review-progress）。 ---------- */

function ReviewTop({
  title,
  subtitle,
  onExit,
  progress,
  onStar,
}: {
  title: string;
  subtitle: string;
  onExit: () => void;
  progress?: number;
  onStar?: () => void;
}) {
  return (
    <>
      <header className="rv-top vault-review-top">
        <button className="iconbtn" data-nav-back aria-label="返回" onClick={onExit}>
          <Icon name="left" size={20} />
        </button>
        <div className="nt">
          <h1 className="ttl">{title}</h1>
          {subtitle && <small>{subtitle}</small>}
        </div>
        {onStar ? (
          <button className="star" aria-label="查看当前生词" onClick={onStar}>
            <Icon name="star" size={18} />
          </button>
        ) : (
          <span />
        )}
      </header>
      {progress !== undefined && (
        <div className="rv-progress" role="progressbar" aria-label="本轮复习进度" aria-valuetext={subtitle} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, Math.max(0, progress)))}>
          <i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
    </>
  );
}

/* 完成环（原型 ring(1,1,76,6,"✓")，html:1606-1612）：76px 绿环 + 居中 ✓。 */
function DoneRing() {
  const size = 76, stroke = 6;
  const radius = (size - stroke) / 2, circle = 2 * Math.PI * radius;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label="本轮完成" style={{ marginTop: 4 }}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circle} ${circle}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="var(--ink)" fontSize="20" fontWeight="600">
        ✓
      </text>
    </svg>
  );
}

function RecogCard({ card, cs, flip }: { card: ReviewCard; cs: CardState; flip: () => void }) {
  useEffect(() => {
    if (cs.phase === "answer") speak(card.word, 0.9); /* 翻面自动发音（治 I8） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs.phase]);
  return (
    <>
      <div className="v2-listen-task">
        <div className="v2-audio-circle">
          <button className="iconbtn" aria-label="发音" style={{ background: "transparent", border: 0 }} onClick={() => speak(card.word, 0.9)}>
            <Icon name="speaker" size={26} />
          </button>
        </div>
        <div className="rv-word">{card.word}</div>
        {card.phonetic && <div className="rv-pho">{card.phonetic}</div>}
      </div>
      {cs.phase === "front" ? (
        <div style={{ textAlign: "center", marginTop: 22 }}>
          <button className="tlink" onClick={flip}>
            点按翻面
          </button>
        </div>
      ) : (
        <div className="rv-flip">
          <div style={{ textAlign: "center", fontSize: 16, lineHeight: "24px", marginTop: 14 }}>{card.hint}</div>
          {card.pattern && <div className="pattern" style={{ textAlign: "center" }}>{card.pattern}</div>}
        </div>
      )}
    </>
  );
}

/* ---------- 提示盒（原型 .v2-hint-box，html:2952）：三级阶梯 思路/开头/完整例句 + 听示范 + N/3 ---------- */

function HintBox({ card, hints, onHint, example, definition }: { card: ReviewCard; hints: number; onHint: () => void; example: string; definition?: string }) {
  const words = card.answer.split(" ");
  const lead = card.mode === "spoken" ? example.split(/\s+/).slice(0, 3).join(" ") || "I’m learning…" : words.map((w) => `${w.slice(0, 1)}…`).join(" ");
  return (
    <div className="v2-hint-box">
      <button className="v2-hint-toggle" onClick={onHint}>
        <Icon name="info" size={15} />
        {hints ? "再给一点提示" : "给点提示"}
        <span>{hints ? `${hints} / 3` : "可一直展开"}</span>
      </button>
      {hints > 0 && (
        <p>
          <b>思路</b> {definition || card.hint}
        </p>
      )}
      {hints >= 2 && (
        <p>
          <b>开头</b> <span className="serif">{lead}</span>
        </p>
      )}
      {hints >= 3 && (
        <>
          <div className="en" lang="en">
            {example}
          </div>
          <button className="btn-ghost" style={{ width: "auto", padding: "0 14px", border: "1px solid var(--hairline-strong)" }} onClick={() => speak(example, 0.95)}>
            <Icon name="speaker" size={14} />
            听示范
          </button>
        </>
      )}
    </div>
  );
}

function ClozeCard({
  card,
  cs,
  translation,
  definition,
  input,
  setInput,
  inputRef,
  onSubmit,
  onHint,
  example,
}: {
  card: ReviewCard;
  cs: CardState;
  translation: string;
  definition: string;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onHint: () => void;
  example: string;
}) {
  /* 原型填空题（html:2936）：题干下一行是出处句中文（word.cn），无译文时退回释义；答案卡给「词性 释义」（word.pos）。 */
  const copy = translation || card.hint;
  if (cs.phase === "answer") {
    return (
      <>
        <span className="v2-eyebrow">回忆原句里缺少的表达</span>
        <div className="rv-sent">
          {card.pre} <span className="blank tape">&nbsp;</span> {card.post}
        </div>
        <p className="v2-learning-copy" style={{ margin: "9px 0 0" }}>
          {copy}
        </p>
        <input
          ref={inputRef}
          className="input"
          style={{ marginTop: 13 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          placeholder="写下你想到的答案（选填）"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="填空回答（选填）"
        />
        <HintBox card={card} hints={cs.hints} onHint={onHint} example={example} definition={definition} />
        <button className="btn" style={{ width: "100%", marginTop: 14 }} onClick={onSubmit}>
          核对答案
        </button>
      </>
    );
  }
  const cls = cs.judged === "trap" ? "trap" : cs.judged === "wrong" ? "wrong" : "good";
  return (
    <>
      <span className="v2-eyebrow">回忆原句里缺少的表达</span>
      <div className="rv-sent">
        {card.pre} <span className={`blank ans ${cls}`}>{card.answer}</span> {card.post}
      </div>
      <p className="v2-learning-copy" style={{ margin: "9px 0 0" }}>
        {copy}
      </p>
      {(cs.judged === "trap" || cs.judged === "close") && <VerdictLine card={card} cs={cs} />}
      {/* 原型揭示后输入框仍在（保留刚才写的答案），这里只读展示 */}
      <input className="input" style={{ marginTop: 13 }} value={cs.input} readOnly placeholder="写下你想到的答案（选填）" aria-label="填空回答（已核对）" />
      <div className="rv-ex">
        <b>{card.answer}</b>
        <p className="def">{definition}</p>
        {cs.input && <small>你刚才写的是：{cs.input}</small>}
      </div>
      <HintBox card={card} hints={cs.hints} onHint={onHint} example={example} definition={definition} />
    </>
  );
}

function VerdictLine({ card, cs }: { card: ReviewCard; cs: CardState }) {
  const v = cs.judged;
  if (!v) return null;
  if (v === "trap") {
    return (
      <>
        <div className="verdict">
          <span className="v-warn">命中直译陷阱</span>
          <span style={{ color: "var(--ink-3)" }}>正确说法是 {card.answer}</span>
        </div>
        <div className="trap-note">{card.vTrap || `别写成 ${card.trap}`}</div>
      </>
    );
  }
  if (v === "close") {
    return (
      <div className="verdict">
        <span className="v-ok" style={{ color: "var(--warn)" }}>
          接近了
        </span>
      </div>
    );
  }
  return null;
}

function DictCard({
  card,
  cs,
  definition,
  target,
  input,
  setInput,
  inputRef,
  onSubmit,
  onHint,
  onPlay,
}: {
  card: ReviewCard;
  cs: CardState;
  definition: string;
  target: string;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onHint: () => void;
  onPlay: () => void;
}) {
  const listened = cs.listened ?? false;
  const answered = cs.phase !== "answer";
  /* 原型听音辨认（html:2932）：揭示前后同一骨架——喇叭圆钮 / 标题句 / 说明 / 主钮 / 输入框；
     揭示后输入框下方换成原句（目标表达 ans 高亮）+ 目标词「词性 释义」，不再叠三色比对与图例。 */
  return (
    <div className="v2-listen-task">
      <div className="v2-audio-circle">
        <button className="iconbtn" aria-label={answered ? "再听一次" : "播放原句"} style={{ background: "transparent", border: 0 }} onClick={onPlay}>
          <Icon name="speaker" size={26} />
        </button>
      </div>
      <h3>听完后，回忆你听到了什么</h3>
      <p>先听原句，再写下目标表达或在心里回答。</p>
      <button className="btn" style={{ width: "100%" }} onClick={onPlay}>
        <Icon name="speaker" size={15} />
        {listened || answered ? "再听一次" : "听这条表达"}
      </button>
      {answered ? (
        <input className="input" value={cs.input} readOnly placeholder="写下听到的表达（选填）" aria-label="听音回答（已核对）" />
      ) : (
        <input
          ref={inputRef}
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          placeholder="写下听到的表达（选填）"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="听音回答（选填）"
        />
      )}
      {answered ? (
        <div className="v2-listen-answer">
          <div className="rv-sent" lang="en">
            {markTarget(card.answer, target)}
          </div>
          <p className="v2-learning-copy">{definition}</p>
          <VerdictLine card={card} cs={cs} />
        </div>
      ) : (
        <div className="v2-listen-hidden">
          <Icon name="eyeoff" size={14} />
          文字先收起来，让耳朵先试试
        </div>
      )}
      <HintBox card={card} hints={cs.hints} onHint={onHint} example={card.answer} definition={definition} />
      {!answered && (
        <button className="btn" style={{ width: "100%", marginTop: 14 }} disabled={!listened} onClick={onSubmit}>
          核对听到的表达
        </button>
      )}
    </div>
  );
}

/** 句内目标表达定位：先找词条原形，找不到再用出处句词块的句内形态（如 take root → took root）。 */
function targetSpan(sentence: string, card: ReviewCard, articles: Article[]): string {
  const lower = sentence.toLowerCase();
  if (card.word && lower.includes(card.word.toLowerCase())) return card.word;
  const sent = card.articleId ? articles.find((a) => a.id === card.articleId)?.sentences[card.sentIdx] : undefined;
  const key = card.word.toLowerCase();
  const chunk = sent?.chunks?.find((c) => (c.word && c.word.toLowerCase() === key) || c.text.toLowerCase() === key);
  return chunk && lower.includes(chunk.text.toLowerCase()) ? chunk.text : "";
}

/** 原句里的目标表达 ans 高亮（原型 v2WordHighlight 非遮罩态 .ans，html:2796-2801）。 */
function markTarget(sentence: string, span: string) {
  const at = span ? sentence.toLowerCase().indexOf(span.toLowerCase()) : -1;
  if (at < 0) return sentence;
  return (
    <>
      {sentence.slice(0, at)}
      <span className="blank ans">{sentence.slice(at, at + span.length)}</span>
      {sentence.slice(at + span.length)}
    </>
  );
}
