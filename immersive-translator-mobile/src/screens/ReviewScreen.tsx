import { useMemo, useState } from "react";
import { useApp, actions } from "../store";
import { judge, JUDGE_SUGGEST, type Verdict } from "../core/judge";
import { GRADE_INTERVALS } from "../core/srs";
import type { VocabWord } from "../core/types";

interface QueueItem {
  vocab: VocabWord;
  mode: "cloze" | "recognition";
  sentence: string;
  sentenceCn: string;
  blank: string;
}

/**
 * 复习流 spike 版：词块走完形（挖空判分），单词走识别。
 * 真机观察点：键盘弹起是否遮挡输入槽（visualViewport 适配必要性）。
 */
export default function ReviewScreen({ onExit }: { onExit: () => void }) {
  const vocab = useApp((s) => s.vocab);
  const [pos, setPos] = useState(0);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"answer" | "graded">("answer");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [done, setDone] = useState(0);

  const queue = useMemo<QueueItem[]>(() => {
    const due = vocab.filter((v) => v.dueAt <= Date.now());
    return due.map((v) => {
      const isChunk = v.kind === "chunk";
      // spike：句子与挖空取演示数据的强关联；找不到就退化识别卡
      const { sentence, sentenceCn, blank } = findSentenceFor(v);
      const ok = isChunk && sentence && blank;
      return {
        vocab: v,
        mode: ok ? ("cloze" as const) : ("recognition" as const),
        sentence,
        sentenceCn,
        blank,
      };
    });
  }, [vocab]);

  const item = queue[pos];

  if (!item) {
    return (
      <div className="screen" style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 44 }}>🎉</div>
        <div className="serif-en" style={{ fontSize: 24, marginTop: 8 }}>
          本轮完成 · {done} 张
        </div>
        <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>spike：评分仅改内存 dueAt，不落盘</div>
        <div style={{ maxWidth: 260, margin: "24px auto 0" }}>
          <button className="btn" onClick={onExit}>
            回到今天
          </button>
        </div>
      </div>
    );
  }

  function findSentenceFor(v: VocabWord): { sentence: string; sentenceCn: string; blank: string } {
    // 演示数据里词块的 chunk 文本硬编码映射（spike 捷径，M2 换真实 source 定位）
    const MAP: Record<string, { sentence: string; cn: string; blank: string }> = {
      "take-root": { sentence: "The idea of car-free streets took root after the summer of heatwaves.", cn: "无车街道的想法在热浪之夏之后扎了根。", blank: "took root" },
      "in-the-wake-of": { sentence: "In the wake of the storm, the council planted twelve thousand trees.", cn: "风暴过后，市政会种下了一万两千棵树。", blank: "In the wake of" },
      "buffer-against": { sentence: "Rows of lindens buffer against the traffic noise all summer.", cn: "成排的椴树整个夏天都在抵御交通噪音。", blank: "buffer against" },
      "attribute-to": { sentence: "Residents attribute the cooler summers to the young canopy.", cn: "居民们把更凉爽的夏天归功于年轻的树冠。", blank: "attribute the cooler summers to" },
      "torrential-rain": { sentence: "Torrential rain tested the new drainage within a week.", cn: "倾盆大雨在一周内就考验了新的排水系统。", blank: "Torrential rain" },
      "settle-in": { sentence: "It took the new arrivals a month to settle in to the neighbourhood.", cn: "新来的人花了一个月才在街区里安顿下来。", blank: "settle in" },
    };
    const hit = MAP[v.id];
    return hit ? { sentence: hit.sentence, sentenceCn: hit.cn, blank: hit.blank } : { sentence: "", sentenceCn: "", blank: "" };
  }

  function submit() {
    if (phase === "graded") return;
    setVerdict(judge(input, item.blank, item.vocab.trap, [item.vocab.word]));
    setPhase("graded");
  }

  function grade(g: "forgot" | "hard" | "good" | "easy") {
    actions.gradeWord(item.vocab.id, Date.now() + GRADE_INTERVALS[g].ms);
    setPos((p) => p + 1);
    setDone((n) => n + 1);
    setPhase("answer");
    setInput("");
    setVerdict(null);
  }

  const graded = phase === "graded";
  const idx = item.blank ? item.sentence.toLowerCase().indexOf(item.blank.toLowerCase()) : -1;
  const before = idx >= 0 ? item.sentence.slice(0, idx) : "";
  const after = idx >= 0 ? item.sentence.slice(idx + item.blank.length) : "";
  const suggest = verdict ? JUDGE_SUGGEST[verdict] : "forgot";

  return (
    <div className="screen">
      <div className="rev-top">
        <button className="x" onClick={onExit}>
          ✕
        </button>
        <div className="prog">
          <i style={{ width: `${(pos / Math.max(1, queue.length)) * 100}%` }} />
        </div>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          {pos + 1} / {queue.length}
        </span>
      </div>

      {item.mode === "cloze" ? (
        <div className="rev-card">
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--text-3)" }}>
            <span className="badge">完形</span>
            <span>{item.vocab.chunkType} · 挖空产出</span>
          </div>
          <div className="cloze-sent">
            {graded ? (
              <>
                {before}
                <span style={{ color: verdict === "perfect" ? "var(--ok)" : verdict === "close" ? "var(--warn)" : "var(--err)" }}>{item.blank}</span>
                {after}
              </>
            ) : (
              <>
                {before}
                <input
                  className="blank-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="写出挖空部分"
                  autoComplete="off"
                  spellCheck={false}
                />
                {after}
              </>
            )}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>中文：{graded ? item.sentenceCn : item.sentenceCn.replace(/[^\s，。]/g, "＿")}</div>
          {graded && verdict && (
            <div className={`verdict ${verdict === "trap" ? "trapv" : verdict}`}>
              <b>{({ perfect: "✓ 一次写对", close: "≈ 很接近", trap: "⚠ 命中直译陷阱", wrong: "✗ 没想起来" } as Record<Verdict, string>)[verdict]}</b>
              <div style={{ fontSize: 13 }}>
                {verdict !== "perfect" && input && <>你写的：{input} · </>}
                正确：{item.blank}
                {item.vocab.trap && verdict !== "perfect" && <> · ⚠ {item.vocab.trap}</>}
              </div>
            </div>
          )}
          {graded ? (
            <GradeBar suggest={suggest} onGrade={grade} />
          ) : (
            <div className="act-row">
              <button className="btn" onClick={submit}>
                提交判分
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setVerdict("wrong");
                  setPhase("graded");
                }}
              >
                看答案
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="rev-card">
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--text-3)" }}>
            <span className="badge">识别</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="serif-en" style={{ fontSize: 36 }}>{item.vocab.word}</span>
            {item.vocab.phonetic && <span style={{ fontSize: 13.5, color: "var(--text-3)" }}>/{item.vocab.phonetic}/</span>}
          </div>
          {graded ? (
            <>
              <div style={{ fontSize: 15, lineHeight: 1.75 }}>{item.vocab.senses.map((s, i) => <div key={i}><i style={{ color: "var(--text-3)" }}>{s.pos}</i> {s.cn}</div>)}</div>
              <GradeBar suggest={suggest} onGrade={grade} />
            </>
          ) : (
            <>
              <div style={{ color: "var(--text-3)", fontSize: 13.5 }}>回想它的意思，再翻面。</div>
              <button className="btn" onClick={() => setPhase("graded")}>
                翻面看释义
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GradeBar({ suggest, onGrade }: { suggest: "forgot" | "hard" | "good" | "easy"; onGrade: (g: "forgot" | "hard" | "good" | "easy") => void }) {
  const bars: ["forgot" | "hard" | "good" | "easy", string, string][] = [
    ["forgot", "忘记", "10 分钟"],
    ["hard", "困难", "1 天"],
    ["good", "一般", "3 天"],
    ["easy", "简单", "7 天"],
  ];
  return (
    <div className="gradebar">
      {bars.map(([v, name, next]) => (
        <button key={v} className={`grade-btn ${v === suggest ? "focus" : ""}`} onClick={() => onGrade(v)}>
          <span className="name">{name}</span>
          <span className="next">{next}</span>
        </button>
      ))}
    </div>
  );
}
