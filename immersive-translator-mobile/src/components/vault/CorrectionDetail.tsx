/**
 * 独立纠偏详情页（speaking-parity · 原型 VIEWS.correction，html:2996-3004）：
 * nhead「这句话，可以说得更自然」+ 副标场景名（原型 n.scene：词专项「词块造句」/ 场景名 / 跟读标题，
 * practiceSceneLabel）→ 单张白卡「原话 ↓ 建议」（eyebrow accent / 衬线原话 / 衬线 accent 20px 建议 /
 * 仅一枚 🔊 听示范描边胶囊——原型白卡没有「听我的原声」，原声回听走「来自这次练习」→ 练习记录详情的
 * 「听我的回答」）→ 独立「为什么这样改」卡 → 来自这次练习（相对时间 + 「用 X 说一句 · 查看当轮回答与复盘」行）
 * → 关联生词 chips → 主按钮「🎤 再练这句，完成后回来看笔记」（原型 ACT v2-correction-practice：以改法句
 * 开 follow 练习，标题「再练这句表达」）。
 * 数据只读自已保存的 attempts feedback（feedback.savedAt 落账的那条）；「为什么这样改」直接展示
 * 云端表达反馈的 explanation（原型 n.explanation 同口径），无则兜底「保留原意，让表达更顺畅。」。
 */
import { useState } from "react";
import { speak, stopSpeak, useApp } from "../../store";
import { useNav } from "../../ui/nav";
import { Icon } from "../../ui/icons";
import type { PracticeAttempt, PracticeTask } from "../../services/practice";
import { openPractice } from "../../screens/LearningHome";
import { practiceSceneLabel } from "../speaking/scenes";
import { WordDetailSheet } from "./WordDetailSheet";

/* 相对时间（原型 timeLabel 口径）：今天/昨天带 HH:MM，更早 M月D日 HH:MM。 */
function relativeTime(at: number): string {
  const d = new Date(at), now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function CorrectionDetail({ task, attempt, onBack }: { task: PracticeTask; attempt: PracticeAttempt; onBack: () => void }) {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const [wordSheet, setWordSheet] = useState<string | null>(null);
  const feedback = attempt.feedback;
  if (!feedback) return null;
  const related = task.word ? vocab.find((w) => w.word.toLowerCase() === task.word!.toLowerCase()) : undefined;
  return (
    <>
      <header className="learning-head nhead">
        <button className="tlink" aria-label="返回" onClick={onBack}>
          <Icon name="left" size={18} />
        </button>
        <div className="nt">
          <h1>这句话，可以说得更自然</h1>
          {/* 原型 html:3000 副标为场景名（n.scene），不是带词的任务标题；任务标题落在下方「来自这次练习」行 */}
          <small>{practiceSceneLabel(task)}</small>
        </div>
        <span />
      </header>
      <main className="learning-body" style={{ paddingTop: 0, paddingBottom: 140 }}>
        <section className="learning-card v2-correction-card" style={{ marginTop: 0 }}>
          <span className="v2-eyebrow">当时的原话</span>
          <p className="v2-correction-original" lang="en">{attempt.text || "这次回答没有确认文字"}</p>
          <div className="v2-correction-arrow"><Icon name="right" size={16} /></div>
          <span className="v2-eyebrow">建议这样说</span>
          <p className="v2-correction-improved" lang="en">{feedback.improved}</p>
          {/* 原型 html:3000 白卡只有一枚「听示范」（.btn 描边胶囊）；原声回听在练习记录详情里 */}
          <button className="btn-ghost" style={{ width: "auto", padding: "0 16px" }} onClick={() => speak(feedback.improved)}>
            <Icon name="speaker" size={15} />
            听示范
          </button>
        </section>
        <section className="learning-card v2-correction-why">
          <b>为什么这样改</b>
          <p>{feedback.explanation || "保留原意，让表达更顺畅。"}</p>
        </section>
        <div className="v2-learning-title"><b>来自这次练习</b><span>{relativeTime(attempt.createdAt)}</span></div>
        <button
          className="learning-card v2-note-source"
          style={{ padding: 14, marginTop: 0 }}
          onClick={() => { stopSpeak(); nav.push("learningPractice", { taskId: task.id }); }}
        >
          <span style={{ minWidth: 0 }}>
            <b>{task.mode === "word" && task.word ? `用 ${task.word} 说一句` : task.title}</b>
            <small>查看当轮回答与复盘</small>
          </span>
          <Icon name="right" size={15} />
        </button>
        {related && (
          <>
            <div className="v2-learning-title"><b>关联生词</b></div>
            <button className="learning-chip" style={{ margin: 0, fontFamily: "var(--font-serif)" }} onClick={() => setWordSheet(related.id)}>
              {related.word}
            </button>
          </>
        )}
        {/* 原型 html:3000-3003 纠偏详情没有独立的「回到原句」行：回到出处句走关联生词 chip → 词条详情的
            原句 trunk，或「来自这次练习」→ 复盘 dock「回到练习来源」。 */}
        {/* 原型 ACT 区按钮为 accent 绿实底（html:3003 btn primary block v2-learning-secondary，非 voice 靛蓝） */}
        <button
          className="btn"
          style={{ marginTop: 16 }}
          onClick={() => {
            stopSpeak();
            /* 原型 v2-correction-practice（html:3188-3190）：以改法句开跟读练习（再练这句表达）。 */
            void openPractice(nav, { mode: "follow", title: "再练这句表达", reference: feedback.improved });
          }}
        >
          <Icon name="mic" size={15} />
          再练这句，完成后回来看笔记
        </button>
      </main>
      {wordSheet && <WordDetailSheet wordId={wordSheet} onClose={() => setWordSheet(null)} />}
    </>
  );
}
