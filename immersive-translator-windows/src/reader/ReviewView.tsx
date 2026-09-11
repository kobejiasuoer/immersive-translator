/**
 * 屏 D · 生词本复习流：左栏 260px（今日进度/连续打卡/掌握度分布）+
 * 中间 640px SRS 卡片 + 四档评分（忘记 10 分钟 · 困难 1 天 · 一般 3 天 · 简单 7 天）。
 * 到期判定与计数同一份 srs.dueAt（§9-3）。
 */

import { useCallback, useEffect, useState } from "react";
import { IconVolume } from "../ui/icons";
import { GRADE_INTERVALS, dueVocab, type ReviewGrade } from "../core/readerSrs";
import { CHUNK_TYPE_LABELS, type VocabWord } from "../core/readerTypes";
import { blankChunkInSentence } from "../core/chunkAnnotate";
import type { ReviewStats } from "../lib/readerStore";

interface Props {
  words: VocabWord[];
  stats: ReviewStats;
  /** 评分提交：由 ReaderApp 落盘并刷新。 */
  onGrade: (word: VocabWord, grade: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
  onSpeakWord: (text: string) => void;
  /** 原句卡与文章名：由 ReaderApp 的文章缓存提供。 */
  sourcePreview: (articleId: string, sentenceIdx: number) => string | null;
  articleTitle: (articleId: string) => string | null;
}

const GRADES: { value: ReviewGrade; key: string }[] = [
  { value: "forgot", key: "1" },
  { value: "hard", key: "2" },
  { value: "good", key: "3" },
  { value: "easy", key: "4" },
];

export function ReviewView({ words, stats, onGrade, onJumpToSentence, onSpeakWord, sourcePreview, articleTitle }: Props) {
  const due = dueVocab(words);
  const [pos, setPos] = useState(0);

  // 到期队列变化（评分后）时保持游标在队首。
  useEffect(() => {
    setPos(0);
  }, [words.length]);

  const current = due[pos] ?? due[0] ?? null;

  const grade = useCallback(
    (g: ReviewGrade) => {
      if (!current) return;
      onGrade(current, g);
      setPos(0); // 评分后队列立即缩短，回到队首
    },
    [current, onGrade],
  );

  // 快捷键：1-4 评分，空格发音。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const g = GRADES.find((x) => x.key === e.key);
      if (g) {
        e.preventDefault();
        grade(g.value);
        return;
      }
      if (e.key === " " && current) {
        e.preventDefault();
        onSpeakWord(current.word);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade, current, onSpeakWord]);

  const distTotal = Math.max(
    1,
    stats.distribution.learning + stats.distribution.familiar + stats.distribution.mastered,
  );

  return (
    <div className="review-layout">
      <aside className="review-side">
        <div className="stat-card">
          <div className="stat-num">
            {stats.reviewedToday}/{stats.reviewedToday + due.length}
          </div>
          <div className="stat-label">今日复习（到期 {due.length} 词待复习）</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{stats.streak}</div>
          <div className="stat-label">连续打卡天数</div>
        </div>
        <div>
          <div className="section-label" style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>
            掌握度分布 · 共 {stats.total} 词
          </div>
          <div className="dist-row">
            <span className="name">学习中</span>
            <span className="bar">
              <i style={{ width: `${(stats.distribution.learning / distTotal) * 100}%`, background: "var(--warn)" }} />
            </span>
            <span className="n">{stats.distribution.learning}</span>
          </div>
          <div className="dist-row">
            <span className="name">渐熟</span>
            <span className="bar">
              <i style={{ width: `${(stats.distribution.familiar / distTotal) * 100}%`, background: "var(--accent)" }} />
            </span>
            <span className="n">{stats.distribution.familiar}</span>
          </div>
          <div className="dist-row">
            <span className="name">掌握</span>
            <span className="bar">
              <i style={{ width: `${(stats.distribution.mastered / distTotal) * 100}%`, background: "var(--ok)" }} />
            </span>
            <span className="n">{stats.distribution.mastered}</span>
          </div>
          <div className="kind-split">
            单词 {stats.totalWords}（到期 {stats.dueWords}）· 词块 {stats.totalChunks}（到期 {stats.dueChunks}）
          </div>
        </div>
      </aside>

      <div className="review-main">
        <div className="review-card-col">
          {current ? (
            <div className="review-card" key={current.id}>
              <div className="card-meta">
                <span>
                  来自「{articleTitle(current.source.articleId) ?? "已删除的文章"}」· 第{" "}
                  {current.source.sentenceIdx + 1} 句
                </span>
                <span>
                  {pos + 1} / {due.length}
                </span>
              </div>

              <div className="word-line">
                <span className="word">{current.word}</span>
                {current.kind === "chunk" && current.chunkType && (
                  <span className="chunk-type-badge">{CHUNK_TYPE_LABELS[current.chunkType]}</span>
                )}
                {current.phonetic && <span className="phonetic">/{current.phonetic.replace(/^\/|\/$/g, "")}/</span>}
                <button
                  className="reader-tb-btn"
                  onClick={() => (current.word ? onSpeakWord(current.word) : undefined)}
                  title="发音（空格）"
                >
                  <IconVolume size={15} />
                </button>
              </div>

              <div className="sense-line">
                {current.senses.map((s, i) => (
                  <div key={i}>
                    {s.pos && <span className="pos">{s.pos}</span>}
                    {s.cn}
                  </div>
                ))}
              </div>

              {current.kind === "chunk" && current.pattern && (
                <div className="chunk-detail">记法：<i>{current.pattern}</i></div>
              )}
              {current.kind === "chunk" && current.trap && (
                <div className="chunk-detail trap">直译陷阱：{current.trap}</div>
              )}

              {current.collocations && current.collocations.length > 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
                  {current.collocations.map((c, i) => (
                    <div key={i}>
                      {c.en}
                      <span style={{ color: "var(--text-3)", marginLeft: 6 }}>{c.cn}</span>
                    </div>
                  ))}
                </div>
              )}

              <div
                className="source-sentence"
                onClick={() => onJumpToSentence(current.source.articleId, current.source.sentenceIdx)}
                title="点击回到原文这一句"
              >
                {(() => {
                  const src = sourcePreview(current.source.articleId, current.source.sentenceIdx);
                  if (src === null) return "（原句已随文章删除）";
                  // 词块卡：原句挖空做产出式回忆，点击回原文可看全句。
                  return current.kind === "chunk" ? blankChunkInSentence(src, current.word) : src;
                })()}
                <span className="from">点击回到原文这一句</span>
              </div>

              <div className="review-gradebar">
                {GRADES.map(({ value, key }) => (
                  <button key={value} className={`grade-btn ${value}`} onClick={() => grade(value)}>
                    <span className="name">{gradeLabel(value)}</span>
                    <span className="next">{GRADE_INTERVALS[value].label}</span>
                    <span className="next kbd">{key}</span>
                  </button>
                ))}
              </div>

              <div className="shortcut-hints">
                <span>
                  <span className="kbd">1</span>–<span className="kbd">4</span> 评分
                </span>
                <span>
                  <span className="kbd">Space</span> 发音
                </span>
              </div>
            </div>
          ) : (
            <div className="review-done">
              <div className="big">{stats.total === 0 ? "生词本还是空的" : "今日复习完成 🎉"}</div>
              <div className="sub">
                {stats.total === 0
                  ? "在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。"
                  : "没有到期的生词了。明天再来看看，或去阅读室继续攒新词。"}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function gradeLabel(g: ReviewGrade): string {
  return { forgot: "忘记", hard: "困难", good: "一般", easy: "简单" }[g];
}
