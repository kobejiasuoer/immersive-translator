/**
 * 复习页开发预览（review-preview.html 专用，不进生产构建）：
 * 整页挂载真实 VaultPage（rail / stage / board 全部真实渲染），
 * mock 生词/口语会话/复习日志驱动三个新状态，供浏览器里人工验收与截图。
 * 用法：?v=home|focus|export|notes  &theme=light|dark|sepia|oled（默认 sepia=原型灰绿板）。
 * TTS（听原句/听写自动朗读）与麦克风（开口卡）在浏览器里不可用属预期；
 * 评分 = 该词离开到期队列（模拟父层 refreshVocab），让预览能走完整轮。
 */

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { VaultPage, type VaultPlayMode } from "./VaultPage";
import { NotesView } from "./NotesView";
import type { ParsedNote } from "../core/noteParser";
import type { NoteMeta, ReaderTheme, VocabWord } from "../core/readerTypes";
import { dueVocab, initialSrs, reviewStats, dayKey, type ReviewLogFile } from "../core/readerSrs";
import type { SpeakSession } from "../core/speakLogic";
import "../styles.css";
import "./reader.css";

// 开发预览专用：渲染期错误直接钉在页面上（无控制台可看时的逃生门）
for (const kind of ["error", "unhandledrejection"] as const) {
  window.addEventListener(kind, (e) => {
    const msg = e instanceof ErrorEvent ? `${e.message} @ ${e.filename}:${e.lineno}` : String((e as PromiseRejectionEvent).reason);
    const d = document.createElement("div");
    d.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999;background:#dc2626;color:#fff;font:12px monospace;padding:6px 10px;white-space:pre-wrap";
    d.textContent = `${kind}: ${msg}`;
    document.body.appendChild(d);
  });
}

const params = new URLSearchParams(location.search);
const MODES: VaultPlayMode[] = ["home", "focus", "export", "notes"];
const initMode = MODES.includes(params.get("v") as VaultPlayMode) ? (params.get("v") as VaultPlayMode) : "home";
const THEMES: ReaderTheme[] = ["light", "dark", "sepia", "oled"];
const initTheme = THEMES.includes(params.get("theme") as ReaderTheme)
  ? (params.get("theme") as ReaderTheme)
  : "sepia";

// ---------- mock 数据（对照原型三张截图：due 5 词、口语纠偏 1 轮、易错 1 词） ----------
// 收录时间刻意铺开（今天 2 词 / 3 天前 2 词 / 20 天前 1 词；口语会话今天+10 天前各
// 一轮），让导出档的 本周/今天/全部 三档过滤与「共 N 条」肉眼可辨。

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeWord(p: Partial<VocabWord> & Pick<VocabWord, "id" | "word">): VocabWord {
  return {
    senses: [{ pos: "n.", cn: "释义" }],
    source: { articleId: "a1", sentenceIdx: 0 },
    srs: initialSrs(now),
    addedAt: now,
    ...p,
  };
}

const WORDS: VocabWord[] = [
  {
    ...makeWord({
      id: "volunteers",
      word: "volunteers",
      senses: [{ pos: "n.", cn: "志愿者（volunteer 的复数）" }],
      phonetic: "ˌvɒlənˈtɪəz",
    }),
    source: { articleId: "a1", sentenceIdx: 2 },
  },
  {
    ...makeWord({
      id: "inconsistent with",
      word: "inconsistent with",
      kind: "chunk",
      chunkType: "phrasal",
      senses: [{ pos: "phr.", cn: "与……不一致" }],
      pattern: "be inconsistent with sth",
    }),
    source: { articleId: "a2", sentenceIdx: 4 },
  },
  {
    ...makeWord({
      id: "standardizes",
      word: "standardizes",
      addedAt: now - 3 * DAY,
      senses: [{ pos: "v.", cn: "使标准化" }],
      phonetic: "ˈstændədaɪzɪz",
    }),
    source: { articleId: "", sentenceIdx: 0 },
    example: {
      en: "Our company standardizes all reports so every department uses the same simple format.",
      zh: "我们公司把所有报告标准化，每个部门都用同样简单的格式。",
    },
  },
  // 看板三阶素材：口语用出过（s3）+ 易错词（wrong+trap）
  makeWord({ id: "unwind", word: "unwind", addedAt: now - 3 * DAY, spokenAt: now - 1000, srs: { ease: 2.5, intervalDays: 3, reps: 2, dueAt: now - 2000, lapses: 0 } }),
  {
    ...makeWord({ id: "take root", word: "take root", kind: "chunk", addedAt: now - 20 * DAY }),
    recall: {
      total: { pass: 0, wrong: 1, trap: 1 },
      byMode: { cloze: { pass: 0, wrong: 1, trap: 1 } },
    },
  },
];

const SENTENCES: Record<string, { en: string; zh: string | null }[]> = {
  a1: [
    {
      en: "Researchers measured how fast volunteers could move through a text.",
      zh: "研究人员测量了志愿者阅读一段文本的速度。",
    },
  ],
  a2: [
    {
      en: "Locations on Booking.com and Ctrip are also similarly inconsistent with street address.",
      zh: "Booking 与携程上的位置信息与街道地址也同样不一致。",
    },
  ],
};

const SPEAK_SESSIONS: SpeakSession[] = [
  {
    id: "s1",
    scenario: "smalltalk",
    difficulty: "medium",
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        role: "user",
        text: "I was very tired.",
        at: now,
        coachDiff: {
          segs: [
            { t: "keep", v: "I" },
            { t: "keep", v: "was" },
            { t: "del", v: "very" },
            { t: "del", v: "tired." },
            { t: "ins", v: "completely" },
            { t: "ins", v: "drained." },
          ],
          note: "drained 比 very tired 更地道",
        },
      },
    ],
  },
  // 10 天前的口语轮：在「本周」范围外，切「全部」才会出现（过滤效果素材）。
  {
    id: "s2",
    scenario: "meeting",
    difficulty: "hard",
    createdAt: now - 10 * DAY,
    updatedAt: now - 10 * DAY,
    turns: [
      {
        role: "user",
        text: "We will discuss about the plan tomorrow.",
        at: now - 10 * DAY,
        coachDiff: {
          segs: [
            { t: "keep", v: "We will" },
            { t: "del", v: "discuss about" },
            { t: "ins", v: "go over" },
            { t: "keep", v: "the plan tomorrow." },
          ],
          note: "discuss 是及物动词，不加 about；口语可用 go over 更自然",
        },
      },
    ],
  },
];

// ---------- 「全部笔记」档 mock：真实 NotesView（传参与 ReaderApp 同构） ----------

const NOTE_META: NoteMeta = {
  file: "学词笔记-2026-10-20.md",
  createdAt: now - 7 * DAY,
  words: 3,
  partial: false,
  wordIds: ["volunteers", "inconsistent with", "take root"],
  replay: {
    rounds: 1,
    lastAt: now - 2 * 3600_000,
    passed: 1,
    stillWeak: 2,
    verdict:
      "整体眼熟度在涨：volunteers 已能秒认；inconsistent with 的搭配介词还不稳，take root 停留在「见过」。下一步优先测搭配。",
    weak: [
      { w: "inconsistent with", why: "with 常漏；be inconsistent with sth 是固定搭法" },
      { w: "take root", why: "只认得字面「生根」，引申义「扎根/固定下来」还没建立" },
    ],
  },
  updatedAt: now - 2 * 3600_000,
};

const NOTE_PARSED: ParsedNote = {
  glance: [
    "**inconsistent with** 的介词搭配仍不稳，优先复习",
    "**take root** 需要建立引申义锚点：观点/习惯「扎根」",
    "volunteers 已过关，保持复测间隔即可",
  ],
  sections: [
    {
      title: "记忆诊断",
      cards: [
        {
          word: "volunteers",
          diagnose: { ok: true, text: "秒认；复数 -s 别漏读" },
          senses: [{ pos: "n.", text: "志愿者（volunteer 的复数）" }],
          example: "Researchers measured how fast volunteers could move through a text.",
          collos: [],
          nextTest: { mode: "recognition", tip: "7 天后再认一次即可" },
        },
        {
          word: "inconsistent with",
          diagnose: { ok: false, text: "with 常漏，搭配不完整" },
          anchor: "in-（不）+ consistent（一致）→ 与……不一致；固定搭法 be inconsistent with sth",
          senses: [{ pos: "phr.", text: "与……不一致" }],
          example: "Locations on Booking.com and Ctrip are also similarly inconsistent with street address.",
          collos: [{ k: "搭配", en: "be inconsistent with", zh: "与……不一致" }],
          nextTest: { mode: "cloze", tip: "明天完形再测：similarly ___ street address" },
        },
        {
          word: "take root",
          diagnose: { ok: false, text: "只认得字面「生根」" },
          anchor: "take root → 观点/习惯像植物一样「扎根；固定下来」",
          senses: [{ pos: "phr.", text: "扎根；固定下来" }],
          collos: [],
          nextTest: { mode: "cloze", tip: "后天测引申义：The idea took ___ among teenagers" },
        },
      ],
    },
  ],
};

/** 复习日志：今日 2 次 + 近 28 天随机出勤（进度环 / 热力 / empty-hint 三形态都可截）。 */
const REVIEW_LOG: ReviewLogFile = {
  schemaVersion: 1,
  days: (() => {
    const days = [{ day: dayKey(now), count: 2 }];
    for (let offset = 1; offset < 28; offset += 1) {
      if (Math.random() < 0.45) {
        const d = new Date(now - offset * 86400000);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        days.push({ day: `${d.getFullYear()}-${mm}-${dd}`, count: 1 + Math.floor(Math.random() * 6) });
      }
    }
    return days;
  })(),
};

function Preview() {
  const [theme, setTheme] = useState<ReaderTheme>(initTheme);
  const [mode, setMode] = useState<VaultPlayMode>(initMode);
  const [words, setWords] = useState(WORDS);
  const [pos, setPos] = useState(0);
  const due = useMemo(() => dueVocab(words), [words]);
  const stats = useMemo(() => reviewStats(words, REVIEW_LOG), [words]);

  /** onModeChange 同步 URL（?v= 直达契约保持），onGrade 把词移出 due（模拟 refreshVocab）。 */
  const changeMode = (m: VaultPlayMode) => {
    setMode(m);
    const p = new URLSearchParams(location.search);
    p.set("v", m);
    history.replaceState(null, "", `?${p.toString()}`);
  };
  const changeTheme = (t: ReaderTheme) => {
    setTheme(t);
    const p = new URLSearchParams(location.search);
    p.set("theme", t);
    history.replaceState(null, "", `?${p.toString()}`);
  };

  const drainWord = (id: string) => setWords((ws) => ws.filter((w) => w.id !== id));

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
            onClick={() => changeTheme(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}>
        VaultPage 三态预览 · 真实 rail/stage/board + mock 数据 · TTS/麦克风在浏览器不可用属预期 · ?v=home|focus|export|notes
        &amp; ?theme=
      </div>
      <VaultPage
        words={words}
        due={due}
        stats={stats}
        reviewLog={REVIEW_LOG}
        sourceSentence={(id, idx) => SENTENCES[id]?.[idx] ?? null}
        articleTitle={(id) => (id === "a1" ? "The Speed of Reading" : id === "a2" ? "I am wondering if others have experienced what I am seeing" : null)}
        speakSessions={SPEAK_SESSIONS}
        mode={mode}
        onModeChange={changeMode}
        pos={pos}
        onSetPos={setPos}
        onGrade={(word) => drainWord(word.id)}
        onSpokenGrade={(word) => drainWord(word.id)}
        onRecall={() => undefined}
        onJumpToSentence={() => undefined}
        onSpeakWord={() => undefined}
        onSpeakSentence={() => undefined}
        onPracticeVocabSpeak={() => undefined}
        onStartFocusReview={(ids) => {
          setPos(0);
          setMode("focus");
          void ids;
        }}
        unnotedCount={1}
        notesPanel={
          <NotesView
            notes={[NOTE_META]}
            activeId={NOTE_META.file}
            active={{ meta: NOTE_META, parsed: NOTE_PARSED }}
            words={words}
            reviewedToday={stats.reviewedToday}
            streak={stats.streak}
            dueNow={due.length}
            newWords={1}
            replayBusy={false}
            onSelect={() => undefined}
            onDelete={() => undefined}
            onOpenReader={() => undefined}
            onOpenReview={() => changeMode("focus")}
            onStartFocusReview={(ids) => {
              setPos(0);
              setMode("focus");
              void ids;
            }}
            onGenerate={() => undefined}
            onGenerateReplay={() => undefined}
            onRollIntoNote={() => undefined}
            onSpeakWord={() => undefined}
            readMinutesToday={2}
            readGoalMin={10}
          />
        }
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
