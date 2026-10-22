/**
 * 快速复习 · 清一张（push）—— §3.14：单卡流，无导航圆点、不强制评分（#29）。
 * 顶部「完成」随时退出（进度保留）；通知深链进入时显示来源行（#28）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, reviewStats, speak, stopSpeak, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { haptic } from "../services/device";
import { judge, JUDGE_SUGGEST, type Verdict } from "../core/judge";
import { GRADE_INTERVALS, type ReviewGrade } from "../core/srs";
import { buildCard } from "../core/queue";
import type { Article, VocabWord } from "../core/types";

export interface QuickProps {
  wordId?: string;
  fromNotify?: boolean;
}

export default function QuickReview({ wordId, fromNotify }: QuickProps) {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  const st = useApp(reviewStats);
  const dueList = vocab.filter((v) => v.dueAt <= Date.now());

  const card = useMemo(() => {
    const target = wordId ? vocab.find((v) => v.id === wordId) : dueList[0];
    return target ? buildCard(target as VocabWord, articles as Article[]) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordId]);

  const [phase, setPhase] = useState<"answer" | "graded" | "done">("answer");
  const [input, setInput] = useState("");
  const [hints, setHints] = useState(0);
  const [judged, setJudged] = useState<Verdict | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase === "answer") {
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [phase]);

  /* 卸载停朗读（治 home-5）：识别卡翻面触发 speak 后点「完成」退出，朗读在退出后
     还会播完一两秒；主复习流（ReviewScreen）有同款清理，两屏对齐。 */
  useEffect(() => () => stopSpeak(), []);

  if (!card) {
    return (
      <>
        <QuickTop fromNotify={fromNotify} onExit={() => nav.popAll()} />
        <div className="qk-stage">
          <div className="qk-done">
            <div className="big">已清完，明天见</div>
            <div className="sub">现在没有到期的卡片</div>
            <button className="btn" style={{ marginTop: 26 }} onClick={() => nav.popAll()}>
              回到今天
            </button>
          </div>
        </div>
      </>
    );
  }

  function submit() {
    const v = judge(input, card!.answer, card!.trap, [card!.word]);
    setJudged(v);
    setPhase("graded");
  }

  function grade(g: ReviewGrade) {
    actions.gradeVocab(card!.id, g, { trap: judged === "trap" });
    /* U-19：清掉最后一张到期发 success 双脉冲，不与 light 叠发（§4 取舍 6）；其余轻脉冲 */
    if (st.due === 1) haptic("success");
    else haptic("light");
    setPhase("done");
  }

  /* P-17：识别卡翻面尚未判分（judged=null）时四档不出建议高亮，与主复习流一致 */
  const suggest = (judged ? JUDGE_SUGGEST[judged] : null) as ReviewGrade | null;

  return (
    <>
      <QuickTop fromNotify={fromNotify} onExit={() => nav.popAll()} />
      <div className="qk-stage">
        {phase === "done" ? (
          <div className="qk-done rv-flip">
            <div style={{ display: "flex", justifyContent: "center", color: "var(--ok)" }}>
              <Icon name="check" size={40} />
            </div>
            <div className="big" style={{ marginTop: 10 }}>
              已清 1 张
            </div>
            {/* U-14：st.due===0（最后一张已清）与「都在今晚的提醒里」同句矛盾——按定稿 §3.14 分叉 */}
            <div className="sub">
              {st.due === 0 ? "今天的到期都清完了 · 明天见" : `还剩 ${Math.max(0, st.due)} 张 · 都在今晚的提醒里`}
            </div>
            <button className="btn" style={{ marginTop: 26 }} onClick={() => nav.popAll()}>
              回到今天
            </button>
          </div>
        ) : card.mode === "recognition" ? (
          <div className="rv-card">
            <div className="overline" style={{ textAlign: "center" }}>
              {card.chunkType || "单词"} · 认识它吗
            </div>
            <div className="rv-word">{card.word}</div>
            {card.phonetic && <div className="rv-pho">{card.phonetic}</div>}
            {phase === "answer" ? (
              <div style={{ textAlign: "center", marginTop: 22 }}>
                <button
                  className="tlink"
                  onClick={() => {
                    speak(card.word, 0.9);
                    setPhase("graded");
                  }}
                >
                  点按翻面
                </button>
              </div>
            ) : (
              /* U-18：翻面 240ms 入场（hint + 评分组同批呈现），与规格 docs:138 对齐 */
              <div className="rv-flip">
                <div style={{ textAlign: "center", fontSize: 16, lineHeight: "24px", marginTop: 14 }}>{card.hint}</div>
                <GradeRow suggest={suggest} onGrade={grade} />
              </div>
            )}
          </div>
        ) : (
          <div className="rv-card">
            <div className="overline" style={{ textAlign: "center" }}>
              完形 · 补上这个词
            </div>
            {phase === "answer" ? (
              <>
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
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder="输入英文"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-label="输入答案（完形）"
                  />
                  <button className="iconbtn" aria-label="提交" style={{ background: "var(--ink)", color: "var(--on-ink)", borderRadius: 12 }} onClick={submit}>
                    <Icon name="check" size={19} />
                  </button>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
                  <button className="tlink" style={{ fontSize: 14 }} onClick={() => setHints((h) => Math.min(3, h + 1))}>
                    给点提示
                  </button>
                  <button
                    className="meta"
                    onClick={() => {
                      setJudged("wrong");
                      setPhase("graded");
                    }}
                  >
                    直接看答案
                  </button>
                </div>
                {hints > 0 && (
                  <div className="hintbox">
                    {hints === 1 && <>提示 · {card.hint}</>}
                    {hints === 2 && <>提示 · 首字母 {card.answer.split(" ").map((w) => `${w[0]}···`).join(" ")}</>}
                    {hints >= 3 && <>提示 · 槽位 {card.answer.split(" ").map((w) => `${w[0]}${"_".repeat(Math.max(2, w.length - 2))}?`).join(" ")}</>}
                  </div>
                )}
              </>
            ) : (
              /* U-18：判分结果与评分组 240ms 入场（同型主复习流） */
              <div className="rv-flip">
                <div className="rv-sent" style={{ marginTop: 16 }}>
                  {card.pre}{" "}
                  <span className={`blank fill ${judged === "trap" ? "trap" : judged === "wrong" ? "wrong" : "good"}`}>
                    {judged === "wrong" ? input || "…" : card.answer}
                  </span>{" "}
                  {card.post}
                </div>
                {judged === "trap" && (
                  <>
                    <div className="verdict">
                      <span className="v-warn">命中直译陷阱</span>
                      <span style={{ color: "var(--ink-3)" }}>正确说法是 {card.answer}</span>
                    </div>
                    <div className="trap-note">{card.vTrap || `别写成 ${card.trap}`}</div>
                  </>
                )}
                {judged === "perfect" && (
                  <div className="verdict">
                    <span className="v-ok">写对了</span>
                  </div>
                )}
                {judged === "close" && (
                  <div className="verdict">
                    <span className="v-ok" style={{ color: "var(--warn)" }}>
                      接近了
                    </span>
                    <span style={{ color: "var(--ink-3)" }}>标准写法是 {card.answer}</span>
                  </div>
                )}
                {judged === "wrong" && (
                  <div className="verdict">
                    <span className="v-err">还差点</span>
                    <span style={{ color: "var(--ink-3)" }}>答案是 {card.answer}</span>
                  </div>
                )}
                <GradeRow suggest={suggest} onGrade={grade} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function QuickTop({ fromNotify, onExit }: { fromNotify?: boolean; onExit: () => void }) {
  return (
    <div className="qk-top">
      <span className="qk-src">
        {fromNotify && <Icon name="mark" size={13} />}
        {fromNotify ? "来自今晚的复习提醒" : "快速复习 · 不强制评分"}
      </span>
      <button className="tlink" style={{ fontSize: 15 }} onClick={onExit}>
        完成
      </button>
    </div>
  );
}

function GradeRow({ suggest, onGrade }: { suggest: ReviewGrade | null; onGrade: (g: ReviewGrade) => void }) {
  const GRADES: [ReviewGrade, string, string][] = [
    ["forgot", "没想起", GRADE_INTERVALS.forgot.label],
    ["hard", "想了很久", GRADE_INTERVALS.hard.label],
    ["good", "想起来了", GRADE_INTERVALS.good.label],
    ["easy", "脱口而出", GRADE_INTERVALS.easy.label],
  ];
  return (
    <div className="grades">
      {GRADES.map(([g, g1, g2]) => (
        <button
          key={g}
          className={`grade ${g === suggest ? "focus" : ""}`}
          style={g === suggest ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
          onClick={() => onGrade(g)}
        >
          <span className="g1">{g1}</span>
          <span className="g2">{g2}后再见</span>
        </button>
      ))}
    </div>
  );
}
