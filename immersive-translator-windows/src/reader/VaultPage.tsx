/**
 * 「笔记与复习」三合一容器（v0.8 Phase 4）。
 *
 * 顶栏三档玩法切换（原型 renderVaultSurface）：
 * - 记忆胶带手账（tape）：生词原句 + 口语改进句渲染为手账行，核心词块包
 *   .memory-tape 胶带（默认遮盖、点击揭开自测），✓ 秒懂过关按 good 档落 SRS；
 * - 3 分钟快刷闯关（challenge）：到期/加练队列驱动 Cloze/Dictation/SpeakChallenge
 *   三种卡轮转（卡片复用 ReviewView 的具名导出，判分链路零改动）；
 * - Markdown 笔记导出（md）：buildVaultMarkdown 真实数据生成 + 一键复制，
 *   并提供既有笔记库（NotesView，ReaderApp 喂数据）的回看弹层。
 *
 * 右侧「我的内化看板」：今日进度、三阶内化计数（masteryStage 统一派生）、
 * 近 28 天复习热力格（heatBuckets）、易错项靶向加练。
 *
 * 数据全部来自真实存储（vocabWords / reviewLog / speak_list_sessions），
 * 本组件不包含任何演示常量。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCopy, IconNotebook, IconVolume } from "../ui/icons";
import { findChunkRange } from "../core/chunkAnnotate";
import { firstLetters, judgeCloze, judgeDictation, type RecallVerdict } from "../core/recallJudge";
import { dayKey, heatBuckets, masteryStage, type ReviewGrade, type ReviewLogFile } from "../core/readerSrs";
import { buildVaultMarkdown } from "../core/vaultExport";
import type { RecallMode, VocabWord } from "../core/readerTypes";
import type { ReviewStats } from "../lib/readerStore";
import type { CoachSeg, SpeakSession } from "../core/speakLogic";
import {
  ClozeCard,
  DictationCard,
  GRADE_COPY,
  SpeakChallengeCard,
  type SentenceSpec,
} from "./ReviewView";

export type VaultPlayMode = "tape" | "challenge" | "md";

export interface Props {
  /** 全库生词（ReaderApp 真实数据）。 */
  words: VocabWord[];
  /** 到期/加练队列（与左栏词表共用同一序号）。 */
  due: VocabWord[];
  stats: ReviewStats;
  reviewLog: ReviewLogFile;
  sourceSentence: (articleId: string, sentenceIdx: number) => { en: string; zh: string | null } | null;
  articleTitle: (articleId: string) => string | null;
  /** 口语会话（speak_list_sessions；手账口语条目与导出的数据源）。 */
  speakSessions: SpeakSession[];
  mode: VaultPlayMode;
  onModeChange: (m: VaultPlayMode) => void;
  pos: number;
  onSetPos: (i: number) => void;
  /** 普通评分（gradeVocab→readerSaveVocabWord+readerRecordReview 落盘）。 */
  onGrade: (word: VocabWord, grade: ReviewGrade) => void;
  /** 开口命中评分：easy 档 + spokenAt（内化三阶「已变成口语表达」的数据来源）。 */
  onSpokenGrade: (word: VocabWord, grade: "easy") => void;
  onRecall: (wordId: string, mode: RecallMode, judged: RecallVerdict | null, grade: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
  onSpeakWord: (text: string) => void;
  onSpeakSentence: (text: string) => void;
  micDeviceId?: string;
  /** 「去口语里用一次」：pendingSpeak 置 {kind:"vocab"} 后进口语造句闯关。 */
  onPracticeVocabSpeak: () => void;
  /** 弱项专项闯关：focusIds 加练队列 + 切到闯关模式。 */
  onStartFocusReview: (ids: string[]) => void;
  onGenerateNote?: () => void;
  /** 既有笔记库（ReaderApp 继续喂数据的 NotesView）：md 模式的回看弹层。 */
  notesPanel?: ReactNode;
}

const MODE_LABELS: { id: VaultPlayMode; label: string }[] = [
  { id: "tape", label: "记忆胶带手账（点按自测）" },
  { id: "challenge", label: "3 分钟快刷闯关（填空 / 听音 / 开口）" },
  { id: "md", label: "Markdown 笔记导出" },
];

const STAGE_ROWS: { stage: "s1" | "s2" | "s3"; label: string }[] = [
  { stage: "s1", label: "🌱 刚收集（待认熟）" },
  { stage: "s2", label: "👀 眼熟能认（阅读遇到能懂）" },
  { stage: "s3", label: "✨ 已变成我的口语表达（在对话中说出）" },
];

/** 手账行上的三阶短标签（比看板行短，贴着句子放）。 */
const TAPE_STAGE_LABELS: Record<"s1" | "s2" | "s3", string> = {
  s1: "刚收集 · 还没认熟",
  s2: "眼熟能认 · 阅读遇到能懂",
  s3: "已内化 · 在口语里用出过",
};

/** 闯关轮转顺序：完形 → 听写 → 开口（原句缺失时完形/听写降级为开口卡）。 */
const CHALLENGE_ROTATION: ("cloze" | "dictation" | "speak")[] = ["cloze", "dictation", "speak"];

export function VaultPage(props: Props) {
  return (
    <div className="vault-page">
      <VaultTopBar {...props} />
      <div className="vault-studio-grid">
        <div className="vault-main-scroll">
          {props.mode === "tape" ? (
            <TapeNotebook {...props} />
          ) : props.mode === "challenge" ? (
            <ChallengeStage {...props} />
          ) : (
            <MarkdownExport {...props} />
          )}
        </div>
        <InternalizationDashboard {...props} />
      </div>
    </div>
  );
}

// ---------- 顶栏：三档玩法 + 归档过滤 ----------

function VaultTopBar({ words, speakSessions, mode, onModeChange }: Props) {
  const coachedCount = countCoachedTurns(speakSessions);
  return (
    <div className="vault-top-bar">
      <div className="vault-top-left">
        <div className="lens-mode-switch" role="tablist" aria-label="笔记与复习玩法切换">
          {MODE_LABELS.map((m) => (
            <button
              key={m.id}
              className={`lens-mode-btn${mode === m.id ? " active" : ""}`}
              onClick={() => onModeChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === "tape" && (
          <span className="vault-filter-label tabular">
            生词 {words.length} 词 · 口语改进 {coachedCount} 条
          </span>
        )}
      </div>
    </div>
  );
}

function countCoachedTurns(sessions: SpeakSession[]): number {
  return sessions.reduce(
    (n, s) => n + s.turns.filter((t) => t.role === "user" && t.coachDiff).length,
    0,
  );
}

// ---------- 模式 1：记忆胶带手账 ----------

/** 手账词块条目（真实生词 + 原句切分）。 */
interface TapeWordEntry {
  kind: "word";
  key: string;
  word: VocabWord;
  category: string;
  pre: string;
  blank: string;
  post: string;
  sentenceEn: string | null;
  sentenceZh: string | null;
  hint: string;
  tip: string;
}

/** 手账口语改进条目（speakSessions 带 coachDiff 的 user 轮）。 */
interface TapeSpeakEntry {
  kind: "speak";
  key: string;
  category: string;
  original: string;
  segs: CoachSeg[];
  better: string;
  note?: string;
}

type TapeEntry = TapeWordEntry | TapeSpeakEntry;

function TapeNotebook({
  words,
  speakSessions,
  sourceSentence,
  articleTitle,
  onGrade,
  onSpeakWord,
  onSpeakSentence,
  onPracticeVocabSpeak,
}: Props) {
  const [peeled, setPeeled] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<string>("all");

  const entries = useMemo(() => buildTapeEntries(words, speakSessions, sourceSentence, articleTitle), [
    words,
    speakSessions,
    sourceSentence,
    articleTitle,
  ]);

  const archiveOptions = useMemo(() => buildArchiveOptions(entries), [entries]);
  const visible = useMemo(
    () => (archive === "all" ? entries : entries.filter((e) => entryArchiveKey(e) === archive)),
    [entries, archive],
  );

  const toggleTape = (key: string) => {
    setPeeled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = (peel: boolean) => {
    setPeeled(peel ? new Set(visible.map((e) => e.key)) : new Set());
  };

  return (
    <div className="notebook-sheet-card">
      <div className="tape-sheet-head">
        <div>
          <div className="tape-sheet-kicker">1 分钟遮罩自测手账 · 告别死板背单词卡</div>
          <h3 className="tape-sheet-title">生词原句 &amp; 口语纠偏手账</h3>
        </div>
        <span className="tabular tape-sheet-hint">点击琥珀色胶带即可刮开自测</span>
      </div>

      <div className="tape-entry-row tape-filter-row">
        <label className="vault-archive-label">
          按来源归档：
          <select className="vault-archive-select" value={archive} onChange={(e) => setArchive(e.target.value)}>
            {archiveOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="tape-global-actions">
          <button className="pill-Ghost-btn" onClick={() => toggleAll(false)}>
            全部盖上胶带自测
          </button>
          <button className="pill-Ghost-btn" onClick={() => toggleAll(true)}>
            全部揭开
          </button>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="tape-empty">
          这里还没有手账条目。在阅读里查词收藏、或去口语里练几轮，胶带条目会自动出现在这里。
        </div>
      )}

      {visible.map((entry) =>
        entry.kind === "word" ? (
          <TapeWordRow
            key={entry.key}
            entry={entry}
            peeled={peeled.has(entry.key)}
            onToggle={() => toggleTape(entry.key)}
            onGrade={onGrade}
            onSpeakWord={onSpeakWord}
            onSpeakSentence={onSpeakSentence}
            onPracticeVocabSpeak={onPracticeVocabSpeak}
          />
        ) : (
          <TapeSpeakRow
            key={entry.key}
            entry={entry}
            peeled={peeled.has(entry.key)}
            onToggle={() => toggleTape(entry.key)}
            onSpeakWord={onSpeakWord}
          />
        ),
      )}
    </div>
  );
}

function TapeWordRow({
  entry,
  peeled,
  onToggle,
  onGrade,
  onSpeakWord,
  onSpeakSentence,
  onPracticeVocabSpeak,
}: {
  entry: TapeWordEntry;
  peeled: boolean;
  onToggle: () => void;
  onGrade: Props["onGrade"];
  onSpeakWord: Props["onSpeakWord"];
  onSpeakSentence: Props["onSpeakSentence"];
  onPracticeVocabSpeak: Props["onPracticeVocabSpeak"];
}) {
  const stage = masteryStage(entry.word);
  const tip = [entry.word.pattern, entry.word.trap].filter(Boolean).join(" · ");
  return (
    <div className="tape-entry-row">
      <div className="tape-row-meta">
        <span className="tape-category">{entry.category}</span>
        <span className={`stage-pill ${stage}`}>{TAPE_STAGE_LABELS[stage]}</span>
      </div>

      <div className="tape-sentence">
        {entry.pre}
        <span
          className={`memory-tape${peeled ? " peeled" : ""}`}
          data-hint={entry.hint}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          role="button"
          tabIndex={0}
          title="点击揭开或重新贴上胶带"
        >
          {entry.blank}
        </span>
        {entry.post}
      </div>

      {entry.sentenceZh && <div className="tape-zh">{entry.sentenceZh}</div>}

      <div className="tape-row-actions">
        <span className="tape-tip-row">{tip ? `提示：${tip}` : `首字母：${firstLetters(entry.blank)}`}</span>
        <div className="tape-action-btns">
          <button
            className="text-action-btn"
            onClick={() =>
              entry.sentenceEn ? onSpeakSentence(entry.sentenceEn) : onSpeakWord(entry.word.word)
            }
          >
            <IconVolume size={14} />
            听原句
          </button>
          <button className="pill-Ghost-btn tape-pass-btn" onClick={() => onGrade(entry.word, "good")}>
            <IconCheck size={13} />
            秒懂过关
          </button>
          <button className="pill-Ghost-btn" onClick={onPracticeVocabSpeak}>
            去口语里用一次 →
          </button>
        </div>
      </div>
    </div>
  );
}

function TapeSpeakRow({
  entry,
  peeled,
  onToggle,
  onSpeakWord,
}: {
  entry: TapeSpeakEntry;
  peeled: boolean;
  onToggle: () => void;
  onSpeakWord: Props["onSpeakWord"];
}) {
  return (
    <div className="tape-entry-row">
      <div className="tape-row-meta">
        <span className="tape-category">{entry.category}</span>
        <span className="stage-pill s2">熟悉中 · 替代中式表达</span>
      </div>

      <div className="tape-sentence">
        <span className="tape-speak-original">你原本说：{entry.original}</span>
        <span className="tape-speak-arrow"> → 地道说法：</span>
        {entry.segs.map((seg, i) => {
          if (seg.t === "del") {
            return (
              <span key={i} className="diff-del-span">
                {seg.v}
              </span>
            );
          }
          if (seg.t === "ins") {
            return (
              <span
                key={i}
                className={`memory-tape${peeled ? " peeled" : ""}`}
                data-hint={`新说法（${firstLetters(seg.v)}）`}
                onClick={onToggle}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle();
                  }
                }}
                title="点击揭开或重新贴上胶带"
              >
                {seg.v}
              </span>
            );
          }
          return <span key={i}>{seg.v} </span>;
        })}
      </div>

      {entry.note && <div className="tape-zh">{entry.note}</div>}

      <div className="tape-row-actions">
        <span className="tape-tip-row">在口语里替换掉左边的说法，胶带遮住先自己回忆</span>
        <div className="tape-action-btns">
          <button className="text-action-btn" onClick={() => onSpeakWord(entry.better)}>
            <IconVolume size={14} />
            听地道说法
          </button>
        </div>
      </div>
    </div>
  );
}

/** 手账条目构建：生词（原句切分）+ 口语改进轮（真实数据，无演示常量）。 */
function buildTapeEntries(
  words: VocabWord[],
  speakSessions: SpeakSession[],
  sourceSentence: Props["sourceSentence"],
  articleTitle: Props["articleTitle"],
): TapeEntry[] {
  const wordEntries: TapeWordEntry[] = [];
  for (const w of [...words].sort((a, b) => a.srs.dueAt - b.srs.dueAt)) {
    const src = w.source.articleId
      ? sourceSentence(w.source.articleId, w.source.sentenceIdx)
      : w.example
        ? { en: w.example.en, zh: w.example.zh }
        : null;
    let pre = "";
    let blank = w.word;
    let post = "";
    if (src?.en) {
      const range = findChunkRange(src.en, w.word);
      if (range) {
        pre = src.en.slice(0, range.start);
        blank = src.en.slice(range.start, range.end);
        post = src.en.slice(range.end);
      }
    }
    const title = w.source.articleId ? articleTitle(w.source.articleId) : null;
    wordEntries.push({
      kind: "word",
      key: `w:${w.id}`,
      word: w,
      category: title ? `《${title}》· 核心词块` : "划词收藏 · 核心词块",
      pre,
      blank,
      post,
      sentenceEn: src?.en ?? null,
      sentenceZh: src?.zh ?? null,
      hint: `${w.senses[0]?.cn ?? w.word}（${firstLetters(blank)}）`,
      tip: [w.pattern, w.trap].filter(Boolean).join(" · "),
    });
  }

  const speakEntries: TapeSpeakEntry[] = [];
  for (const session of speakSessions) {
    for (let i = 0; i < session.turns.length; i += 1) {
      const turn = session.turns[i];
      if (turn.role !== "user" || !turn.coachDiff) continue;
      const better = turn.coachDiff.segs
        .filter((s) => s.t !== "del")
        .map((s) => s.v)
        .join(" ")
        .trim();
      if (!better) continue;
      const d = new Date(turn.at);
      speakEntries.push({
        kind: "speak",
        key: `s:${session.id}:${i}`,
        category: `口语表达改进记录 · ${d.getMonth() + 1}月${d.getDate()}日`,
        original: turn.text,
        segs: turn.coachDiff.segs,
        better,
        note: turn.coachDiff.note,
      });
    }
  }
  return [...wordEntries, ...speakEntries];
}

function entryArchiveKey(e: TapeEntry): string {
  if (e.kind === "speak") return "speak";
  return e.word.source.articleId ? `article:${e.word.source.articleId}` : "popup";
}

function buildArchiveOptions(entries: TapeEntry[]): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const e of entries) {
    const key = entryArchiveKey(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!labels.has(key)) labels.set(key, e.category);
  }
  const total = entries.length;
  const options: { value: string; label: string }[] = [{ value: "all", label: `全部（${total} 条）` }];
  for (const [value, label] of labels) {
    options.push({ value, label: `${label}（${counts.get(value) ?? 0} 条）` });
  }
  return options;
}

// ---------- 模式 2：3 分钟快刷闯关 ----------

function ChallengeStage(props: Props) {
  const { due, pos, onSetPos, stats } = props;
  const [step, setStep] = useState(0);
  const [outcome, setOutcome] = useState<{ word: string; text: string } | null>(null);
  // ---- 卡片内状态（每张卡重置，语义与 ReviewView 相同） ----
  const [input, setInput] = useState("");
  const [hints, setHints] = useState(0);
  const [cnShown, setCnShown] = useState(false);
  const [verdict, setVerdict] = useState<RecallVerdict | null>(null);
  const [replays, setReplays] = useState(3);
  const spokeRef = useRef("");
  /** 防重入：评分后到队列刷新的间隙里同一张卡只允许评一次（语义同 ReviewView.gradedRef）。 */
  const gradedRef = useRef<string>("");

  const current = due[pos] ?? due[0] ?? null;

  // 队列耗尽（评完最后一张）时收拢游标，保证计数显示正确。
  useEffect(() => {
    if (pos >= due.length) onSetPos(0);
  }, [due.length, pos, onSetPos]);

  // 换卡：重置卡片内状态。
  useEffect(() => {
    setInput("");
    setHints(0);
    setCnShown(false);
    setVerdict(null);
    setReplays(3);
  }, [current?.id]);

  /** 当前卡的形态与句子素材（原句缺失时完形/听写降级为开口卡）。 */
  const { effKind, spec } = useMemo(() => {
    if (!current) return { effKind: "cloze" as const, spec: null as SentenceSpec | null };
    const desired = CHALLENGE_ROTATION[step % CHALLENGE_ROTATION.length];
    const src =
      (current.source.articleId
        ? props.sourceSentence(current.source.articleId, current.source.sentenceIdx)
        : null) ??
      (current.example ? { en: current.example.en, zh: current.example.zh ?? null } : null);
    if (desired === "speak" || !src?.en) return { effKind: "speak" as const, spec: null };
    if (desired === "dictation") {
      return { effKind: "dictation" as const, spec: { sentence: src.en, zh: src.zh, pre: "", blank: "", post: "" } };
    }
    const range = findChunkRange(src.en, current.word);
    return range
      ? {
          effKind: "cloze" as const,
          spec: {
            sentence: src.en,
            zh: src.zh,
            pre: src.en.slice(0, range.start),
            blank: src.en.slice(range.start, range.end),
            post: src.en.slice(range.end),
          },
        }
      : { effKind: "speak" as const, spec: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, step]);

  // 听写卡进入即自动朗读一次（word 音轨，不打断句子朗读）。
  useEffect(() => {
    if (effKind === "dictation" && spec && current && spokeRef.current !== current.id) {
      spokeRef.current = current.id;
      props.onSpeakSentence(spec.sentence);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effKind, spec, current]);

  /** 评分落盘（ReaderApp 刷新队列，词离队 → pos 自然指向下一张）。 */
  const grade = useCallback(
    (g: ReviewGrade) => {
      if (!current || gradedRef.current === current.id) return;
      gradedRef.current = current.id;
      const mode: RecallMode = effKind === "speak" ? "recognition" : effKind;
      props.onGrade(current, g);
      props.onRecall(current.id, mode, verdict, g);
      setOutcome({ word: current.word, text: `已按「${GRADE_COPY[g].name}」完成` });
      setStep((s) => s + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, effKind, verdict],
  );

  /** 开口卡命中目标词：easy 档 + spokenAt（内化三阶最高档）。 */
  const passSpeak = useCallback(() => {
    if (!current || gradedRef.current === current.id) return;
    gradedRef.current = current.id;
    props.onSpokenGrade(current, "easy");
    setOutcome({ word: current.word, text: "开口命中 · 已按「很轻松」完成并记一次口语表达" });
    setStep((s) => s + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  /** 放弃（跳过不评分）：词不离队，游标手动推进。 */
  const skipCurrent = useCallback(() => {
    if (!current) return;
    setOutcome({ word: current.word, text: "跳过（未评分）" });
    setStep((s) => s + 1);
    onSetPos(due.length > pos + 1 ? pos + 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, due.length, pos, onSetPos]);

  const sourceLabel = current
    ? current.source.articleId && props.articleTitle(current.source.articleId)
      ? `来自「${props.articleTitle(current.source.articleId)}」· 第 ${current.source.sentenceIdx + 1} 句`
      : "来自划词收藏"
    : "";

  const KIND_BADGE = { cloze: "完形 · 原句挖空", dictation: "听音 · 听整句写整句", speak: "开口 · 说一句直接过关" } as const;

  return (
    <div className="challenge-stage-box">
      <div className="challenge-stage-head">
        <span className="sc-tag">{KIND_BADGE[effKind]}</span>
        <span className="tabular">
          第 {Math.min(pos + 1, Math.max(due.length, 1))} / {due.length} 关
        </span>
      </div>

      {outcome && (
        <div className="vault-outcome-strip" role="status">
          上一关：<b>{outcome.word}</b> {outcome.text}
        </div>
      )}

      {current ? (
        effKind === "cloze" && spec ? (
          <ClozeCard
            word={current}
            spec={spec}
            input={input}
            hints={hints}
            cnShown={cnShown}
            verdict={verdict}
            pos={pos}
            total={due.length}
            sourceLabel={sourceLabel}
            onInput={setInput}
            onHint={() => setHints((n) => Math.min(3, n + 1))}
            onRevealCn={() => setCnShown(true)}
            onSubmit={() => {
              if (verdict !== null || !input.trim()) return;
              setVerdict(judgeCloze(input, spec.blank, { trap: current?.trap, accepted: [current?.word ?? ""] }));
            }}
            onGiveUp={() => setVerdict("wrong")}
            onGrade={grade}
            onJumpToSentence={props.onJumpToSentence}
          />
        ) : effKind === "dictation" && spec ? (
          <DictationCard
            word={current}
            spec={spec}
            input={input}
            verdict={verdict}
            replays={replays}
            pos={pos}
            total={due.length}
            sourceLabel={sourceLabel}
            onInput={setInput}
            onReplay={() => {
              if (verdict === null) {
                if (replays <= 0) return;
                setReplays((r) => r - 1);
              }
              props.onSpeakSentence(spec.sentence);
            }}
            onSubmit={() => {
              if (verdict !== null || !input.trim()) return;
              setVerdict(judgeDictation(input, spec.sentence, { trap: current?.trap }));
            }}
            onGiveUp={() => setVerdict("wrong")}
            onGrade={grade}
            onJumpToSentence={props.onJumpToSentence}
          />
        ) : (
          <SpeakChallengeCard
            word={current}
            sample={
              (current.source.articleId
                ? props.sourceSentence(current.source.articleId, current.source.sentenceIdx)?.en
                : null) ?? current.example?.en ?? null
            }
            pos={pos}
            total={due.length}
            sourceLabel={sourceLabel}
            onPass={passSpeak}
            onGiveUp={skipCurrent}
            onSpeakSample={props.onSpeakSentence}
            micDeviceId={props.micDeviceId}
          />
        )
      ) : (
        <div className="vault-done-panel">
          <div className="big">{stats.total === 0 ? "生词本还是空的" : "本轮闯关完成 🎉"}</div>
          <div className="sub">
            {stats.total === 0
              ? "在阅读室里查词并点击「加入生词本」，闯关卡会出现在这里。"
              : "这一批都过了。换个玩法，或回阅读室继续攒新词。"}
          </div>
          <div className="review-done-nav">
            <button className="btn btn-secondary btn-sm" onClick={() => props.onModeChange("tape")}>
              回手账自测
            </button>
            {props.onGenerateNote && (
              <button className="btn btn-primary btn-sm" onClick={props.onGenerateNote}>
                整理成笔记
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 模式 3：Markdown 笔记导出 ----------

function MarkdownExport({ words, speakSessions, sourceSentence, notesPanel }: Props) {
  const [copied, setCopied] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const dateKey = dayKey();
  const markdown = useMemo(
    () => buildVaultMarkdown({ words, sourceSentence, speakSessions, dateKey }),
    [words, sourceSentence, speakSessions, dateKey],
  );

  const copy = () => {
    void navigator.clipboard
      .writeText(markdown)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2400);
      })
      .catch(() => setCopied(false));
  };

  return (
    <>
      <div className="notebook-sheet-card">
        <div className="tape-sheet-head">
          <div>
            <h3 className="tape-sheet-title">Markdown 结构化学习笔记（可直接复制进 Notion / Obsidian）</h3>
            <p className="tape-sheet-sub">自动汇总自阅读查词、口语表达改进与发音诊断</p>
          </div>
          <div className="tape-action-btns">
            {notesPanel && (
              <button className="pill-Ghost-btn" onClick={() => setNotesOpen(true)}>
                <IconNotebook size={14} />
                笔记库回看
              </button>
            )}
            <button className="pill-Ghost-btn tape-copy-btn" onClick={copy}>
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copied ? "已复制" : "复制 Markdown"}
            </button>
          </div>
        </div>
        <pre className="vault-markdown-pre">{markdown}</pre>
      </div>

      {notesOpen && notesPanel && (
        <div
          className="vault-notes-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="笔记库回看"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setNotesOpen(false);
          }}
        >
          <div className="vault-notes-embed">
            <button className="pill-Ghost-btn vault-notes-close" onClick={() => setNotesOpen(false)}>
              收起笔记库
            </button>
            {notesPanel}
          </div>
        </div>
      )}
    </>
  );
}

// ---------- 右侧：我的内化看板 ----------

function InternalizationDashboard({
  words,
  due,
  stats,
  reviewLog,
  onPracticeVocabSpeak,
  onStartFocusReview,
  onModeChange,
}: Props) {
  const stageCounts = useMemo(() => {
    const counts = { s1: 0, s2: 0, s3: 0 };
    for (const w of words) counts[masteryStage(w)] += 1;
    return counts;
  }, [words]);

  const buckets = useMemo(() => heatBuckets(reviewLog), [reviewLog]);
  const attended = buckets.filter((b) => b.count > 0).length;

  const dueSpoken = useMemo(() => due.filter((w) => w.spokenAt).length, [due]);

  /** 易错词：错题（wrong+trap）最多的前 3 个，按错题数降序。 */
  const weakWords = useMemo(
    () =>
      words
        .map((w) => ({ word: w, bad: (w.recall?.total.wrong ?? 0) + (w.recall?.total.trap ?? 0) }))
        .filter((x) => x.bad > 0)
        .sort((a, b) => b.bad - a.bad)
        .slice(0, 3),
    [words],
  );

  const todayTotal = stats.reviewedToday + due.length;

  return (
    <aside className="spatial-lens-card vault-lens-card">
      <div className="lens-header">
        <span className="vault-lens-title">我的内化看板</span>
        <span className="tabular vault-streak">连续 {stats.streak} 天</span>
      </div>
      <div className="lens-body">
        <div className="lens-section">
          <div className="lens-kicker tabular">
            <span>今日内化进度</span>
            <span className="vault-progress-num">
              {stats.reviewedToday} / {todayTotal} 项已完成
            </span>
          </div>
          <div className="vault-progress-track">
            <i
              style={{
                width: `${todayTotal > 0 ? Math.min(100, (stats.reviewedToday / todayTotal) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="vault-progress-note">
            剩余 <b>{due.length}</b> 项待过关 · 其中 <b>{dueSpoken}</b> 项已在口语对谈中用出
          </div>
        </div>

        <div className="lens-section">
          <div className="lens-kicker">
            <span>词块内化三阶段（看见自己的积累）</span>
          </div>
          <div className="vault-stage-rows">
            {STAGE_ROWS.map((row) => (
              <div key={row.stage} className="vault-stage-row">
                <span>{row.label}</span>
                <b className={`tabular stage-pill ${row.stage}`}>{stageCounts[row.stage]} 词</b>
              </div>
            ))}
          </div>
        </div>

        <div className="lens-section">
          <div className="lens-kicker tabular">
            <span>近 28 天学习足迹</span>
            <span>出勤 {attended} 天</span>
          </div>
          <div className="heatmap-grid">
            {buckets.map((b) => (
              <span
                key={b.dayKey}
                className={`heat-cell${b.level > 0 ? ` l${b.level}` : ""}${b.today ? " today" : ""}`}
                title={`${b.dayKey} · 复习 ${b.count} 次`}
              />
            ))}
          </div>
        </div>

        <div className="lens-section">
          <div className="lens-kicker">
            <span>易错项靶向加练</span>
          </div>
          {weakWords.length === 0 ? (
            <div className="vault-weak-empty">暂无错题记录——保持复习，错题会出现在这里。</div>
          ) : (
            <>
              <div className="vault-weak-list">
                {weakWords.map((x) => (
                  <div key={x.word.id}>
                    • <b>{x.word.word}</b>（错题 {x.bad} 次）
                  </div>
                ))}
              </div>
              <button
                className="island-tab active vault-weak-btn"
                onClick={() => {
                  onStartFocusReview(weakWords.map((x) => x.word.id));
                  onModeChange("challenge");
                }}
              >
                1 分钟只练这 {weakWords.length} 个易错项
              </button>
              <button className="pill-Ghost-btn vault-weak-speak" onClick={onPracticeVocabSpeak}>
                去口语里加练 →
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
