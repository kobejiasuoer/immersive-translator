/**
 * 复习页开发预览（review-preview.html 专用，不进生产构建）：
 * 挂载真实 ReviewView + 真实令牌/样式，用 mock 生词数据驱动三种练习形态，
 * 供浏览器里人工验收与截图。主题按钮切换 data-theme（与阅读室四主题同源）。
 */

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewView } from "./ReviewView";
import { VocabListPanel } from "./VocabListPanel";
import type { ReaderTheme, ReviewModeSetting, VocabWord } from "../core/readerTypes";
import type { ReviewStats } from "../lib/readerStore";
import { dueVocab, initialSrs } from "../core/readerSrs";
import "../styles.css";
import "./reader.css";

const now = Date.now();

const WORDS: VocabWord[] = [
  {
    id: "take root",
    word: "take root",
    kind: "chunk",
    chunkType: "phrasal",
    senses: [{ pos: "phr.", cn: "扎根；（想法、观念）被接受并固定下来" }],
    pattern: "take root (in sth)",
    trap: "take roots（不可数，无复数）",
    collocations: [
      { en: "take root in", cn: "在某处扎根" },
      { en: "deeply rooted", cn: "根深蒂固的" },
    ],
    source: { articleId: "a1", sentenceIdx: 2 },
    srs: initialSrs(now),
    addedAt: now,
  },
  {
    id: "canopy",
    word: "canopy",
    senses: [{ pos: "n.", cn: "（树的）树冠层；遮蔽的顶篷" }],
    phonetic: "ˈkænəpi",
    source: { articleId: "a1", sentenceIdx: 4 },
    srs: initialSrs(now),
    addedAt: now,
  },
  {
    id: "buffer",
    word: "buffer",
    senses: [{ pos: "v.", cn: "缓冲，抵御（噪声、冲击、炎热）" }],
    phonetic: "ˈbʌfə",
    source: { articleId: "a1", sentenceIdx: 6 },
    srs: { ease: 2.5, intervalDays: 3, reps: 2, dueAt: now - 1000, lapses: 0 },
    addedAt: now,
  },
  {
    id: "mingle",
    word: "mingle",
    senses: [{ pos: "v.", cn: "混入；交际，往来" }],
    phonetic: "ˈmɪŋɡl",
    source: { articleId: "a1", sentenceIdx: 8 },
    srs: { ease: 2.5, intervalDays: 3, reps: 1, dueAt: now + 3 * 86400000, lapses: 0 },
    addedAt: now,
  },
];

const SENTENCES: Record<number, { en: string; zh: string | null }> = {
  2: { en: "These ideas take root only when the soil of daily life is ready.", zh: "这些想法只有在日常生活的土壤准备好的时候才会扎根。" },
  4: { en: "The city's tree canopy now covers forty percent of the streets.", zh: "这座城市的树冠层如今覆盖了四成的街道。" },
  6: { en: "Rows of lindens buffer the library against traffic noise.", zh: "成排的椴树为图书馆隔绝交通噪音。" },
};

const STATS: ReviewStats = {
  dueNow: 3,
  reviewedToday: 0,
  total: 42,
  streak: 14,
  distribution: { learning: 12, familiar: 18, mastered: 12 },
  totalWords: 31,
  totalChunks: 11,
  dueWords: 2,
  dueChunks: 1,
};

const THEMES: ReaderTheme[] = ["light", "dark", "sepia", "oled"];

function Preview() {
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [mode, setMode] = useState<ReviewModeSetting>("smart");
  // 评分 = 该词离开到期队列（模拟父层 refreshVocab），让预览能走完整轮
  const [words, setWords] = useState(WORDS);
  const [pos, setPos] = useState(0);
  const due = useMemo(() => dueVocab(words), [words]);
  return (
    <div
      className="reader-root"
      data-theme={theme}
      style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 10,
          zIndex: 10,
          display: "flex",
          gap: 6,
        }}
      >
        {THEMES.map((t) => (
          <button
            key={t}
            className="review-mode-btn"
            style={t === theme ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
            onClick={() => setTheme(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}>
        复习页开发预览 · 真实 ReviewView 组件 + mock 数据（TTS 在浏览器里不可用属预期）
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <VocabListPanel
          words={words}
          due={due}
          pos={pos}
          reviewedToday={0}
          streak={14}
          onJumpToCard={setPos}
          onOpenReader={() => undefined}
        />
        <ReviewView
          words={words}
          due={due}
          pos={pos}
          onSetPos={setPos}
          stats={STATS}
          reviewMode={mode}
          onReviewModeChange={setMode}
          onGrade={(word) => setWords((ws) => ws.filter((w) => w.id !== word.id))}
          onJumpToSentence={() => undefined}
          onSpeakWord={() => undefined}
          onSpeakSentence={() => undefined}
          sourcePreview={(_id, idx) => SENTENCES[idx]?.en ?? null}
          sourceSentence={(_id, idx) => SENTENCES[idx] ?? null}
          articleTitle={() => "Why Cities Need Trees"}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
