/**
 * 复习流（push）—— §3.8：识别/完形/听写三形态（smart 路由 #51）。
 * 判分 = core/judge（perfect/close/trap/wrong + wordDiff 三色，勿重写）；
 * 调度 = core/srs GRADE_INTERVALS；每张即落盘（actions.gradeVocab），
 * 四档评分 ≥58px 白话文案 + 5s 撤销（治 I7）。
 * 撤销语义（定稿 2026-09-25）：恢复到「已亮答案、评分可改」的评分前一刻，三类卡统一
 * （完形/听写保留已填输入，识别卡保持翻面）；SRS 视为本次评分未发生——undoGrade
 * 回滚 dueAt 与计数，下次评分重新计，与「评分即落盘」互补。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, reviewStats, speak, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { judge, wordDiff, JUDGE_SUGGEST, type Verdict } from "../core/judge";
import { GRADE_INTERVALS, type ReviewGrade } from "../core/srs";
import { buildReviewQueue, cardForWord, type ReviewCard } from "../core/queue";
import type { Article, VocabWord } from "../core/types";

export interface ReviewProps {
  wordId?: string;
  from?: string;
  cards?: ReviewCard[];
}

const GRADES: [ReviewGrade, string, string][] = [
  ["forgot", "没想起", "10 分钟后再见"],
  ["hard", "想了很久", "1 天后再见"],
  ["good", "想起来了", "3 天后再见"],
  ["easy", "脱口而出", "7 天后再见"],
];

interface CardState {
  phase: "front" | "answer" | "graded";
  input: string;
  hints: number;
  judged: Verdict | null;
}

export default function ReviewScreen({ wordId, from, cards }: ReviewProps) {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  const st = useApp(reviewStats);

  const queue = useMemo<ReviewCard[]>(() => {
    if (cards && cards.length) return cards;
    if (wordId) {
      const c = cardForWord(wordId, vocab as VocabWord[], articles as Article[]);
      return c ? [c] : [];
    }
    return buildReviewQueue(vocab as VocabWord[], articles as Article[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pos, setPos] = useState(0);
  const [cs, setCs] = useState<CardState>(() => initCard(queue[0]));
  const [results, setResults] = useState<{ mode: ReviewCard["mode"]; judged: Verdict | null }[]>([]);
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
    if (cs.phase === "answer" && queue[pos]?.mode !== "recognition") {
      /* 完形/听写输入自动聚焦（治 I3） */
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
  function exitFinished() {
    if (!streakCommitted.current) {
      streakCommitted.current = true;
      if (streakEligible && queue.length > 0 && results.length === queue.length && st.due === 0) {
        actions.finishReviewStreak();
      }
    }
    nav.popAll();
  }

  if (finished) {
    const dayDone = st.due === 0 && results.length === queue.length;
    return (
      <>
        <ReviewTop pos={queue.length} total={queue.length} onExit={exitFinished} plain />
        <div className="rv-stage">
          <div className="overline" style={{ textAlign: "center" }}>
            复习完成
          </div>
          {st.due > 0 ? (
            <>
              <div className="serif" style={{ fontSize: 28, lineHeight: "38px", fontWeight: 600, textAlign: "center", marginTop: 8 }}>
                已清 {st.cleared} 张
              </div>
              <div className="meta" style={{ textAlign: "center", marginTop: 6 }}>
                还剩 {st.due} 张 · 今晚继续
              </div>
            </>
          ) : (
            <>
              <div className="serif" style={{ fontSize: 28, lineHeight: "38px", fontWeight: 600, textAlign: "center", marginTop: 8 }}>
                今天的 {st.cleared} 张清完了
              </div>
              <div className="meta" style={{ textAlign: "center", marginTop: 6 }}>
                连续 {dayDone ? st.streak + 1 : st.streak} 天 · 明晚再见
              </div>
            </>
          )}
          <SumGrid results={results} />
          <button className="btn" style={{ marginTop: 24 }} onClick={() => nav.push("notes")}>
            <Icon name="note" size={16} />
            整理成笔记
          </button>
          <button className="btn-ghost" style={{ marginTop: 10 }} onClick={exitFinished}>
            回到今天
          </button>
        </div>
      </>
    );
  }

  const card = queue[pos];
  if (!card) {
    /* 队列空 → 预复习入口式空态（§3.8） */
    return (
      <>
        <ReviewTop pos={0} total={0} onExit={() => nav.popAll()} plain />
        <div className="rv-stage">
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
    return { phase: c?.mode === "recognition" ? "front" : "answer", input: "", hints: 0, judged: null };
  }

  function submit() {
    if (cs.phase === "graded") return;
    const v = judge(input, card.answer, card.trap, [card.word]);
    setCs((s) => ({ ...s, phase: "graded", input, judged: v }));
  }

  function giveUp() {
    setCs((s) => ({ ...s, phase: "graded", input: s.input || "", judged: "wrong" }));
  }

  function grade(g: ReviewGrade) {
    if (gradeLock.current) return; /* P-11：评分一次性，自动前进窗口内连点只落第一档 */
    gradeLock.current = true;
    undone.current = false;
    gradedPos.current = pos;
    snap.current = { ...cs };
    /* 识别卡无判分输入：按所选档位映射摘要判定（easy/good→写对，hard→接近，forgot→未想起） */
    const judged: Verdict | null =
      card.mode === "recognition"
        ? g === "easy" || g === "good"
          ? "perfect"
          : g === "hard"
            ? "close"
            : "wrong"
        : cs.judged;
    actions.gradeVocab(card.id, g, { trap: judged === "trap" });
    setResults((r) => [...r, { mode: card.mode, judged }]);
    toast(`已记 · ${GRADE_INTERVALS[g].label}后再见`, {
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

  const suggest = JUDGE_SUGGEST[cs.judged || "wrong"] as ReviewGrade;

  return (
    <>
      <ReviewTop
        pos={pos}
        total={queue.length}
        onExit={() => (from === "vocab" ? nav.pop() : actions.setSheet({ kind: "confirm" }))}
      />
      <div className="rv-stage">
        <div className="rv-card" key={pos + card.mode}>
          {card.mode === "recognition" && <RecogCard card={card} cs={cs} flip={() => setCs((s) => ({ ...s, phase: "answer" }))} />}
          {card.mode === "cloze" && (
            <ClozeCard
              card={card}
              cs={cs}
              input={input}
              setInput={setInput}
              inputRef={inputRef}
              onSubmit={submit}
              onGiveUp={giveUp}
              onHint={() => setCs((s) => ({ ...s, hints: Math.min(3, s.hints + 1) }))}
            />
          )}
          {card.mode === "dictation" && (
            <DictCard
              card={card}
              cs={cs}
              input={input}
              setInput={setInput}
              inputRef={inputRef}
              onSubmit={submit}
              onGiveUp={giveUp}
              onHint={() => setCs((s) => ({ ...s, hints: Math.min(3, s.hints + 1) }))}
              onPlay={() => speak(card.answer, 1)}
            />
          )}
          {(cs.phase === "graded" || (card.mode === "recognition" && cs.phase === "answer")) && (
            <div className="grades">
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
          )}
        </div>
      </div>
    </>
  );
}

function ReviewTop({ pos, total, onExit, plain }: { pos: number; total: number; onExit: () => void; plain?: boolean }) {
  return (
    <div className="rv-top">
      <button className="iconbtn" aria-label="退出" onClick={onExit}>
        <Icon name="left" size={20} />
      </button>
      <div className="rv-prog">
        <div className="meter">
          <i style={{ width: `${total ? (pos / total) * 100 : 100}%` }} />
        </div>
      </div>
      <span className="meta num">
        {plain ? `${total}/${total}` : `${pos + 1}/${total}`}
      </span>
    </div>
  );
}

function RecogCard({ card, cs, flip }: { card: ReviewCard; cs: CardState; flip: () => void }) {
  useEffect(() => {
    if (cs.phase === "answer") speak(card.word, 0.9); /* 翻面自动发音（治 I8） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs.phase]);
  return (
    <>
      <div className="overline" style={{ textAlign: "center" }}>
        {card.kind === "chunk" ? card.chunkType || "词块" : "单词"} · 认识它吗
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <button className="iconbtn" aria-label="发音" style={{ marginTop: 10 }} onClick={() => speak(card.word, 0.9)}>
          <Icon name="speaker" size={18} />
        </button>
      </div>
      <div className="rv-word">{card.word}</div>
      {card.phonetic && <div className="rv-pho">{card.phonetic}</div>}
      {cs.phase === "front" ? (
        <div style={{ textAlign: "center", marginTop: 22 }}>
          <span className="tlink" onClick={flip}>
            点按翻面
          </span>
        </div>
      ) : (
        <>
          <div style={{ textAlign: "center", fontSize: 16, lineHeight: "24px", marginTop: 14 }}>{card.hint}</div>
          {card.pattern && <div className="pattern" style={{ textAlign: "center" }}>{card.pattern}</div>}
        </>
      )}
    </>
  );
}

function hintLadder(card: ReviewCard, n: number) {
  if (n <= 0) return null;
  const words = card.answer.split(" ");
  return (
    <div className="hintbox">
      {n === 1 && <>提示 · {card.hint}</>}
      {n === 2 && <>提示 · 首字母 {words.map((w) => `${w[0]}···`).join(" ")}</>}
      {n >= 3 && <>提示 · 槽位 {words.map((w) => `${w[0]}${"_".repeat(Math.max(2, w.length - 2))}?`).join(" ")}</>}
    </div>
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
  if (v === "perfect") {
    return (
      <div className="verdict">
        <span className="v-ok">写对了</span>
      </div>
    );
  }
  if (v === "close") {
    return (
      <div className="verdict">
        <span className="v-ok" style={{ color: "var(--warn)" }}>
          接近了
        </span>
        <span style={{ color: "var(--ink-3)" }}>标准写法是 {card.answer}</span>
      </div>
    );
  }
  return (
    <>
      <div className="verdict">
        <span className="v-err">还差点</span>
        <span style={{ color: "var(--ink-3)" }}>答案是 {card.answer}</span>
      </div>
      {card.vTrap && <div className="trap-note">直译陷阱 · {card.vTrap}</div>}
    </>
  );
}

function ClozeCard({
  card,
  cs,
  input,
  setInput,
  inputRef,
  onSubmit,
  onGiveUp,
  onHint,
}: {
  card: ReviewCard;
  cs: CardState;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onGiveUp: () => void;
  onHint: () => void;
}) {
  if (cs.phase === "answer") {
    return (
      <>
        <div className="overline" style={{ textAlign: "center" }}>
          完形 · 补上这个词
        </div>
        <div className="rv-sent" style={{ marginTop: 16 }}>
          {card.pre} <span className="blank">&nbsp;</span> {card.post}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <input
            ref={inputRef}
            className="input"
            style={{ flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder="输入英文"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="iconbtn" aria-label="提交" style={{ background: "var(--ink)", color: "var(--on-ink)", borderRadius: 12 }} onClick={onSubmit}>
            <Icon name="check" size={19} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
          <span className="tlink" style={{ fontSize: 14 }} onClick={onHint}>
            给点提示
          </span>
          <span className="meta" style={{ cursor: "pointer" }} onClick={onGiveUp}>
            直接看答案
          </span>
        </div>
        {hintLadder(card, cs.hints)}
      </>
    );
  }
  const cls = cs.judged === "trap" ? "trap" : cs.judged === "wrong" ? "wrong" : "good";
  const show = cs.judged === "wrong" ? cs.input || "…" : card.answer;
  return (
    <>
      <div className="overline" style={{ textAlign: "center" }}>
        完形
      </div>
      <div className="rv-sent" style={{ marginTop: 16 }}>
        {card.pre}{" "}
        <span className={`blank fill ${cls}`}>{show}</span> {card.post}
      </div>
      <VerdictLine card={card} cs={cs} />
    </>
  );
}

function DictCard({
  card,
  cs,
  input,
  setInput,
  inputRef,
  onSubmit,
  onGiveUp,
  onHint,
  onPlay,
}: {
  card: ReviewCard;
  cs: CardState;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onGiveUp: () => void;
  onHint: () => void;
  onPlay: () => void;
}) {
  if (cs.phase === "answer") {
    return (
      <>
        <div className="overline" style={{ textAlign: "center" }}>
          听写 · 听音写句
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
          <button className="iconbtn" aria-label="播放" style={{ background: "var(--surface-2)" }} onClick={onPlay}>
            <Icon name="play" size={18} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <input
            ref={inputRef}
            className="input"
            style={{ flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder="写下你听到的句子"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="iconbtn" aria-label="提交" style={{ background: "var(--ink)", color: "var(--on-ink)", borderRadius: 12 }} onClick={onSubmit}>
            <Icon name="check" size={19} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
          <span className="tlink" style={{ fontSize: 14 }} onClick={onHint}>
            给点提示
          </span>
          <span className="meta" style={{ cursor: "pointer" }} onClick={onGiveUp}>
            直接看答案
          </span>
        </div>
        {hintLadder(card, cs.hints)}
      </>
    );
  }
  const toks = wordDiff(cs.input, card.answer);
  return (
    <>
      <div className="overline" style={{ textAlign: "center" }}>
        听写
      </div>
      <div className="diffline">
        {toks.map((t, i) => (
          <span key={i} className={t.s}>
            {t.w}
          </span>
        ))}
      </div>
      <div className="diff-legend">
        <span>
          <i style={{ background: "var(--ink)" }} />
          写对
        </span>
        <span>
          <i style={{ background: "var(--warn)" }} />
          漏写
        </span>
        <span>
          <i style={{ background: "var(--err)" }} />
          多写/写错
        </span>
      </div>
      <VerdictLine card={card} cs={cs} />
    </>
  );
}

function SumGrid({ results }: { results: { mode: ReviewCard["mode"]; judged: Verdict | null }[] }) {
  const n = (v: Verdict | null) => results.filter((r) => r.judged === v).length;
  return (
    <div className="sum-grid">
      <div className="sum-cell">
        <div className="n num">{n("perfect")}</div>
        <div className="l">一次写对</div>
      </div>
      <div className="sum-cell">
        <div className="n num">{n("close")}</div>
        <div className="l">接近</div>
      </div>
      <div className="sum-cell warn">
        <div className="n num">{n("trap")}</div>
        <div className="l">直译陷阱</div>
      </div>
      <div className="sum-cell err">
        <div className="n num">{n("wrong")}</div>
        <div className="l">未想起</div>
      </div>
    </div>
  );
}
