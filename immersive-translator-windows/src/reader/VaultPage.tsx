/**
 * 「笔记与复习」工作台（2026-10-26 改版，对照原型
 * prototypes/notes-review-redesign-2026-10-26.html）。
 *
 * 三栏 rail | stage | board；专注态（mode=focus）rail/board 与顶栏中岛隐藏、
 * 单列居中。四态（VaultPlayMode）：
 * - home  复习首页：stage-head（今日复习/全部笔记 seg + 导出笔记动作）+
 *   开始复习 Hero（今天 N 条 · 预计 X 分钟 · 形态 chips）+ 待复习胶带列表
 *   （先自己想一想，点胶带看答案；未揭开时译文/释义/评分带一律不渲染）；
 * - notes 全部笔记：seg 第二档，stage 主区内嵌既有 NotesView（ReaderApp 喂数据）；
 * - focus 专注复习：focus-top（退出 Esc + 进度条 + n/m），按轮转渲染 FocusCloze
 *   （26px 衬线大句 + 两级提示阶梯 + 三档评分带）/ DictationCard / SpeakChallengeCard
 *   （后两者复用现组件与内部四档评分带，判分链路零改动）；
 * - export 导出：范围 chips 在调用侧预过滤 words/speakSessions 传 buildVaultMarkdown，
 *   包含 chips 只作用于预览渲染层；预览/Markdown 源码 seg + 复制 + 保存为 .md。
 *
 * 右侧看板 Board：64px conic 进度环（done/total = reviewedToday / +due.length）、
 * 三阶分段条 + 图例（masteryStage 口径不变）、近 28 天热力（heatBuckets）、
 * 易错项靶向加练（保留）。
 *
 * 业务语义零改动：评分链 onGrade/onSpokenGrade（gradeSrs→readerSaveVocabWord→
 * readerRecordReview）与 onRecall（错题分桶）逐字透传；导出 buildVaultMarkdown
 * 纯函数不改；队列语义（due = focusIds 或全局到期、评分即出队、pos 受控游标、
 * Esc 退出只切档不清 focusIds）与 ReaderApp 完全一致。三档文案的间隔副行从
 * GRADE_INTERVALS 派生（good=3 天），GRADE_COPY 四档契约（ReviewView）不动。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconHelp,
  IconMic,
  IconPlay,
  IconVolume,
} from "../ui/icons";
import { saveTextFile } from "../lib/tauriBridge";
import { findChunkRange } from "../core/chunkAnnotate";
import {
  firstLetters,
  judgeCloze,
  judgeDictation,
  verdictToSuggestedGrade,
  type RecallVerdict,
} from "../core/recallJudge";
import {
  dayKey,
  GRADE_INTERVALS,
  heatBuckets,
  masteryStage,
  type ReviewGrade,
  type ReviewLogFile,
} from "../core/readerSrs";
import { buildVaultMarkdown } from "../core/vaultExport";
import type { NoteMeta, RecallMode, VocabWord } from "../core/readerTypes";
import type { ReviewStats } from "../lib/readerStore";
import type { CoachSeg, SpeakSession } from "../core/speakLogic";
import {
  BlankInput,
  DictationCard,
  GRADE_COPY,
  SpeakChallengeCard,
  VerdictPanel,
  type SentenceSpec,
} from "./ReviewView";
import {
  VaultRail,
  type VaultSourceFilter,
  type VaultTypeFilter,
} from "./VocabListPanel";
import type { NoteTranslateFn } from "./VocabNoteDialog";

export type VaultPlayMode = "home" | "notes" | "focus" | "export";

export interface Props {
  /** 全库生词（ReaderApp 真实数据）。 */
  words: VocabWord[];
  /** 到期/加练队列（focusIds 非空时 = 笔记仍错词，无视到期）。 */
  due: VocabWord[];
  stats: ReviewStats;
  reviewLog: ReviewLogFile;
  sourceSentence: (articleId: string, sentenceIdx: number) => { en: string; zh: string | null } | null;
  articleTitle: (articleId: string) => string | null;
  /** 口语会话（speak_list_sessions；口语纠偏条目与导出的数据源）。 */
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
  /** 弱项专项闯关：focusIds 加练队列 + 切到专注态。 */
  onStartFocusReview: (ids: string[]) => void;
  onGenerateNote?: () => void;
  /** 既有笔记库（ReaderApp 继续喂数据的 NotesView）：notes 档内嵌。 */
  notesPanel?: ReactNode;
  /** 加练模式剩余数量（rail 横幅）。 */
  focusCount?: number;
  /** 退出加练，回到全局到期队列。 */
  onExitFocus?: () => void;
  /** 复习笔记生成通道（rail「去处理」）；缺省不渲染入口（预览页/单测）。 */
  requestTranslate?: NoteTranslateFn;
  /** 笔记入库成功 →「在笔记库打开」。 */
  onNoteSaved?: (meta: NoteMeta) => void;
  /** 未整理进任何笔记的生词数（rail-note）。 */
  unnotedCount?: number;
  /** 回阅读室（完成态出口）。 */
  onOpenReader?: () => void;
}

// ---------- 三档评分文案（vault 表面专用；GRADE_COPY 四档契约在 ReviewView 不动） ----------

/** 三档：没记住→forgot / 有点模糊→hard / 记住了→good（一次写对的 easy 建议档收敛为 good）。 */
export interface VaultGradeBand {
  grade: Exclude<ReviewGrade, "easy">;
  name: string;
  cls: "f" | "m" | "g";
  key: string;
}

export const VAULT_GRADE_BANDS: VaultGradeBand[] = [
  { grade: "forgot", name: "没记住", cls: "f", key: "1" },
  { grade: "hard", name: "有点模糊", cls: "m", key: "2" },
  { grade: "good", name: "记住了", cls: "g", key: "3" },
];

/** 评分带的间隔副行：从 GRADE_INTERVALS 派生（间隔定值若调整会自动跟随，不写死矛盾间隔）。 */
export function vaultNextLabel(grade: ReviewGrade): string {
  const minutes = Math.round(GRADE_INTERVALS[grade].ms / 60000);
  if (minutes < 60) return `${minutes} 分钟后再来`;
  const days = Math.round(minutes / (24 * 60));
  if (days <= 1) return "明天再看";
  return `${days} 天后再看`;
}

/** 完形/听写判分的建议档收敛到 vault 三档：easy → good（3 天）。 */
export function vaultSuggested(verdict: RecallVerdict): Exclude<ReviewGrade, "easy"> {
  const g = verdictToSuggestedGrade(verdict);
  return g === "easy" ? "good" : g;
}

/** 三档评分带（首页 reveal 与专注完形共用；点击 onGrade 落盘出队）。 */
function VaultGradeBandRow({
  suggested,
  onGrade,
}: {
  suggested?: Exclude<ReviewGrade, "easy">;
  onGrade: (g: ReviewGrade) => void;
}) {
  return (
    <div className="grades" role="group" aria-label="评分">
      {VAULT_GRADE_BANDS.map((b) => (
        <button
          key={b.grade}
          className={`grade-chip ${b.cls}${suggested === b.grade ? " suggest" : ""}`}
          onClick={() => onGrade(b.grade)}
          title={`快捷键 ${b.key}`}
        >
          {b.name}
          <small>{vaultNextLabel(b.grade)}</small>
        </button>
      ))}
    </div>
  );
}

// ---------- 根：三栏布局 + rail 筛选状态 + home Enter 快捷键 ----------

export function VaultPage(props: Props) {
  const { mode, onModeChange, due } = props;
  const [source, setSource] = useState<VaultSourceFilter>("all");
  const [type, setType] = useState<VaultTypeFilter>("all");

  // home 态 Enter = 开始复习（typing 守卫；焦点态/导出态的键在各自组件内处理）。
  useEffect(() => {
    function typing(): boolean {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    }
    function onKey(e: KeyboardEvent) {
      if (typing()) return;
      if (mode === "home" && e.key === "Enter" && due.length > 0) {
        e.preventDefault();
        onModeChange("focus");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, due.length, onModeChange]);

  return (
    <div className="vault-page" data-vault-view={mode === "focus" ? "focus" : "wide"}>
      <VaultRail
        words={props.words}
        due={props.due}
        speakSessions={props.speakSessions}
        articleTitle={props.articleTitle}
        source={source}
        onSourceChange={setSource}
        type={type}
        onTypeChange={setType}
        focusCount={props.focusCount ?? 0}
        onExitFocus={props.onExitFocus}
        unnotedCount={props.unnotedCount}
        requestTranslate={props.requestTranslate}
        onNoteSaved={props.onNoteSaved}
      />
      {mode === "focus" ? (
        <FocusStage {...props} />
      ) : mode === "export" ? (
        <ExportStage {...props} />
      ) : (
        <HomeStage {...props} source={source} type={type} />
      )}
      <Board {...props} />
      {/* 底部快捷切换器（原型底部深色胶囊，应用为产品内浮层）：focus 态下与
          「退出」等效，只切档不清 focusIds，专注队列得以续跑。 */}
      <nav className="vault-switch" aria-label="复习状态快捷切换">
        {(
          [
            ["home", "复习首页"],
            ["focus", "专注复习"],
            ["export", "导出"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            className={mode === m ? "on" : undefined}
            aria-pressed={mode === m}
            onClick={() => {
              if (mode !== m) onModeChange(m);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------- 首页 / 笔记档：stage-head + Hero + 胶带列表（notes 档内嵌笔记库） ----------

/** 列表词条：原句切分出 pre/blank/post（胶带遮 blank）。 */
interface ListWordEntry {
  kind: "word";
  key: string;
  word: VocabWord;
  sourceLabel: string;
  articleId: string;
  pre: string;
  blank: string;
  post: string;
  sentenceEn: string | null;
  sentenceZh: string | null;
}

/** 口语纠偏条目（speakSessions 带 coachDiff 的 user 轮；无评分带）。 */
interface ListSpeakEntry {
  kind: "speak";
  key: string;
  dateLabel: string;
  original: string;
  segs: CoachSeg[];
  better: string;
  note?: string;
}

type ListEntry = ListWordEntry | ListSpeakEntry;

/** 列表条目构建：到期队列（已按 dueAt 排序）+ 口语改进轮（真实数据，无演示常量）。 */
function buildListEntries(
  due: VocabWord[],
  speakSessions: SpeakSession[],
  sourceSentence: Props["sourceSentence"],
  articleTitle: Props["articleTitle"],
): ListEntry[] {
  const wordEntries: ListWordEntry[] = [];
  for (const w of due) {
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
      sourceLabel: title ? `《${title}》` : "划词收藏",
      articleId: w.source.articleId,
      pre,
      blank,
      post,
      sentenceEn: src?.en ?? null,
      sentenceZh: src?.zh ?? null,
    });
  }

  const speakEntries: ListSpeakEntry[] = [];
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
        dateLabel: `${d.getMonth() + 1}月${d.getDate()}日`,
        original: turn.text,
        segs: turn.coachDiff.segs,
        better,
        note: turn.coachDiff.note,
      });
    }
  }
  return [...wordEntries, ...speakEntries];
}

/** rail 筛选联合过滤：来源（全部/文章/划词/口语纠偏）× 类型（单词/词块）。 */
function filterEntries(
  entries: ListEntry[],
  source: VaultSourceFilter,
  type: VaultTypeFilter,
): ListEntry[] {
  return entries.filter((e) => {
    if (source === "speak") return e.kind === "speak";
    // 口语条目只挂在 全部×全部：它非词非块，类型筛选时一并隐藏——rail 计数与列表严格一致
    if (e.kind === "speak") return source === "all" && type === "all";
    if (source === "popup" && e.articleId) return false;
    if (source.startsWith("article:") && e.articleId !== source.slice("article:".length)) return false;
    if (type === "word" && e.word.kind === "chunk") return false;
    if (type === "chunk" && e.word.kind !== "chunk") return false;
    return true;
  });
}

/** 复习一分钟数：与 Hero/看板共用同一口径（N=0 时为 1，避免出现「0 分钟」）。 */
function vaultMinutes(n: number): number {
  return Math.max(1, Math.ceil(n * 0.6));
}

function HomeStage(props: Props & { source: VaultSourceFilter; type: VaultTypeFilter }) {
  const {
    mode,
    onModeChange,
    due,
    speakSessions,
    sourceSentence,
    articleTitle,
    notesPanel,
  } = props;
  const [peeled, setPeeled] = useState<Set<string>>(new Set());
  const [hinted, setHinted] = useState<Set<string>>(new Set());

  const entries = useMemo(
    () => buildListEntries(due, speakSessions, sourceSentence, articleTitle),
    [due, speakSessions, sourceSentence, articleTitle],
  );
  const visible = useMemo(
    () => filterEntries(entries, props.source, props.type),
    [entries, props.source, props.type],
  );

  /** Hero 的形态 chips：由 due 队列逐词按同款降级规则派生，会出现才点亮。 */
  const modeChips = useMemo(() => {
    let cloze = false;
    let dictation = false;
    for (const w of due) {
      const src =
        (w.source.articleId
          ? sourceSentence(w.source.articleId, w.source.sentenceIdx)
          : null) ??
        (w.example ? { en: w.example.en, zh: w.example.zh ?? null } : null);
      if (!src?.en) continue;
      dictation = true;
      if (findChunkRange(src.en, w.word)) cloze = true;
    }
    return { cloze, dictation };
  }, [due, sourceSentence]);

  const toggleTape = (key: string) => {
    setPeeled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const anyPeeled = visible.some((e) => peeled.has(e.key));
  const toggleAll = () => {
    setPeeled(anyPeeled ? new Set() : new Set(visible.map((e) => e.key)));
  };
  const toggleHint = (key: string) => {
    setHinted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const total = due.length;
  const minutes = vaultMinutes(total);

  return (
    <section className="stage">
      <div className="stage-head">
        <div className="seg" role="tablist" aria-label="笔记与复习档位">
          <button
            className={mode === "home" ? "on" : ""}
            onClick={() => onModeChange("home")}
            role="tab"
            aria-selected={mode === "home"}
          >
            今日复习
          </button>
          <button
            className={mode === "notes" ? "on" : ""}
            onClick={() => onModeChange("notes")}
            role="tab"
            aria-selected={mode === "notes"}
          >
            全部笔记
          </button>
        </div>
        <button className="vault-btn sm" onClick={() => onModeChange("export")}>
          <IconDownload size={14} />
          导出笔记
        </button>
      </div>

      {mode === "notes" ? (
        <div className="vault-notes-embed">{notesPanel}</div>
      ) : (
        <>
          <div className="vault-hero">
            <div>
              <h2>{total > 0 ? `今天有 ${total} 条要复习` : "今天没有要复习的了"}</h2>
              <p>
                {total > 0
                  ? `预计 ${minutes} 分钟 · 都是你最近读到、收藏过的表达`
                  : "到期的表达会按记忆曲线回来——明天再来，或去阅读室继续攒新词。"}
              </p>
              <div className="modes">
                <span className={`mode${modeChips.cloze && total > 0 ? " on" : ""}`}>填空</span>
                <span className={`mode${modeChips.dictation && total > 0 ? " on" : ""}`}>听音</span>
                <span className={`mode${total > 0 ? " on" : ""}`}>开口</span>
              </div>
            </div>
            <div className="hero-cta">
              <button
                className="vault-btn primary lg"
                disabled={total === 0}
                onClick={() => onModeChange("focus")}
              >
                <IconPlay size={15} />
                开始复习
              </button>
              {total > 0 && <div className="muted">按 Enter 也可以开始</div>}
            </div>
          </div>

          <div className="list-title">
            <span>先自己想一想，点胶带看答案</span>
            {visible.length > 0 && <button onClick={toggleAll}>{anyPeeled ? "全部盖住" : "全部揭开"}</button>}
          </div>

          {visible.length === 0 && (
            <div className="vault-list-empty">
              这个筛选下还没有条目。在阅读里查词收藏、或去口语里练几轮，条目会出现在这里。
            </div>
          )}

          {visible.map((entry) =>
            entry.kind === "word" ? (
              <VaultWordItem
                key={entry.key}
                entry={entry}
                peeled={peeled.has(entry.key)}
                hinted={hinted.has(entry.key)}
                onToggle={() => toggleTape(entry.key)}
                onToggleHint={() => toggleHint(entry.key)}
                onGrade={props.onGrade}
                onSpeakWord={props.onSpeakWord}
                onSpeakSentence={props.onSpeakSentence}
                onPracticeVocabSpeak={props.onPracticeVocabSpeak}
              />
            ) : (
              <VaultSpeakItem
                key={entry.key}
                entry={entry}
                peeled={peeled.has(entry.key)}
                onToggle={() => toggleTape(entry.key)}
                onSpeakWord={props.onSpeakWord}
              />
            ),
          )}
        </>
      )}
    </section>
  );
}

/** 词条：src 标签 + 来源 + 19px 衬线原句 + 胶带；揭开后才渲染译文/释义/三档评分带。 */
function VaultWordItem({
  entry,
  peeled,
  hinted,
  onToggle,
  onToggleHint,
  onGrade,
  onSpeakWord,
  onSpeakSentence,
  onPracticeVocabSpeak,
}: {
  entry: ListWordEntry;
  peeled: boolean;
  hinted: boolean;
  onToggle: () => void;
  onToggleHint: () => void;
  onGrade: Props["onGrade"];
  onSpeakWord: Props["onSpeakWord"];
  onSpeakSentence: Props["onSpeakSentence"];
  onPracticeVocabSpeak: Props["onPracticeVocabSpeak"];
}) {
  const w = entry.word;
  const gloss = w.senses.map((s) => (s.pos ? `${s.pos} ${s.cn}` : s.cn)).join("；");
  return (
    <div className="vault-item">
      <div className="src">
        <span className={`tag${w.kind === "chunk" ? " chunk" : ""}`}>{w.kind === "chunk" ? "词块" : "单词"}</span>
        <span>{entry.sourceLabel}</span>
      </div>
      <div className="sent">
        {entry.pre}
        <span
          className={`memory-tape${peeled ? " peeled" : ""}`}
          data-hint={`${w.senses[0]?.cn ?? w.word}（${firstLetters(entry.blank)}）`}
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

      {/* 防剧透：未揭开时译文/词典行/评分带一律不渲染 */}
      {peeled && (
        <div className="reveal">
          {entry.sentenceZh && <div className="zh">{entry.sentenceZh}</div>}
          <div className="def">
            {w.word}
            {gloss ? ` · ${gloss}` : ""}
          </div>
          <VaultGradeBandRow onGrade={(g) => onGrade(w, g)} />
        </div>
      )}

      <div className="item-actions">
        {!peeled && (
          <button onClick={onToggleHint} className={hinted ? "on" : ""}>
            <IconHelp size={14} />
            给点提示
          </button>
        )}
        {hinted && !peeled && (
          <span className="hint-text">
            首字母：{firstLetters(entry.blank)}（{entry.blank.trim().split(/\s+/).length} 词）
          </span>
        )}
        <button
          onClick={() =>
            entry.sentenceEn ? onSpeakSentence(entry.sentenceEn) : onSpeakWord(w.word)
          }
        >
          <IconVolume size={14} />
          听原句
        </button>
        <button onClick={onPracticeVocabSpeak}>
          <IconMic size={14} />
          去口语里用一次
        </button>
      </div>
    </div>
  );
}

/** 口语纠偏条目：原话 + 地道说法 diff（ins 片段是胶带），无评分带。 */
function VaultSpeakItem({
  entry,
  peeled,
  onToggle,
  onSpeakWord,
}: {
  entry: ListSpeakEntry;
  peeled: boolean;
  onToggle: () => void;
  onSpeakWord: Props["onSpeakWord"];
}) {
  return (
    <div className="vault-item">
      <div className="src">
        <span className="tag speak">口语纠偏</span>
        <span>{entry.dateLabel}</span>
      </div>
      <div className="sent">
        <span className="speak-original">你原本说：{entry.original}</span>
        <span className="speak-arrow"> → 地道说法：</span>
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
      {peeled && entry.note && <div className="reveal"><div className="zh">{entry.note}</div></div>}
      <div className="item-actions">
        <button onClick={() => onSpeakWord(entry.better)}>
          <IconVolume size={14} />
          听地道说法
        </button>
      </div>
    </div>
  );
}

// ---------- 专注复习：退出 Esc + 进度条 + 轮转三卡 ----------

/** 轮转顺序：完形 → 听写 → 开口（原句缺失时完形/听写降级为开口卡）。 */
const CHALLENGE_ROTATION: ("cloze" | "dictation" | "speak")[] = ["cloze", "dictation", "speak"];

function FocusStage(props: Props) {
  const { due, pos, onSetPos, stats } = props;
  const [step, setStep] = useState(0);
  const [outcome, setOutcome] = useState<{ word: string; text: string } | null>(null);
  // ---- 卡片内状态（每张卡重置，语义与 ReviewView 相同） ----
  const [input, setInput] = useState("");
  const [hints, setHints] = useState(0);
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
      // 三档带用 vault 文案；听写卡四档带的 easy 回退 GRADE_COPY（很轻松），
      // 否则 easy 会落进「没记住」。
      setOutcome({
        word: current.word,
        text: `已按「${VAULT_GRADE_BANDS.find((b) => b.grade === g)?.name ?? GRADE_COPY[g].name}」完成`,
      });
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

  /** 完形卡提交判分（与 ClozeCard 同一判分器与参数）。 */
  const submitCloze = useCallback(() => {
    if (verdict !== null || !spec) return;
    if (!input.trim()) return;
    setVerdict(judgeCloze(input, spec.blank, { trap: current?.trap, accepted: [current?.word ?? ""] }));
  }, [verdict, spec, input, current]);

  // ---- 专注态快捷键：Esc 退出（focusIds 保留）、Tab 下一级提示、Enter 提交/采纳、1-3 直选 ----
  useEffect(() => {
    function typing(): boolean {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    }
    function onKey(e: KeyboardEvent) {
      // Esc / Tab 不受 typing 守卫：Esc 是退出语义（输入框内也生效），
      // Tab 在完形答题时就是「下一级提示」（用户正在输入框里打字）。
      if (e.key === "Escape") {
        e.preventDefault();
        props.onModeChange("home");
        return;
      }
      if (effKind !== "cloze" || !spec || !current) return;
      if (e.key === "Tab") {
        if (verdict === null && hints < 2) {
          e.preventDefault();
          setHints((n) => Math.min(2, n + 1));
        }
        return;
      }
      if (typing()) return;
      if ((e.key === "h" || e.key === "H") && verdict === null && hints < 2) {
        setHints((n) => Math.min(2, n + 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (verdict === null) {
          submitCloze();
          return;
        }
        grade(vaultSuggested(verdict));
        return;
      }
      if (verdict !== null) {
        const band = VAULT_GRADE_BANDS.find((b) => b.key === e.key);
        if (band) {
          e.preventDefault();
          grade(band.grade);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effKind, spec, current, verdict, hints, input, grade, submitCloze, props.onModeChange]);

  const sourceLabel = current
    ? current.source.articleId && props.articleTitle(current.source.articleId)
      ? `来自《${props.articleTitle(current.source.articleId)}》`
      : "来自划词收藏"
    : "";

  const progress = due.length > 0 ? (Math.min(pos + 1, due.length) / due.length) * 100 : 0;

  return (
    <section className="stage">
      <div className="focus-wrap">
        <div className="focus-top">
          <button className="exit" onClick={() => props.onModeChange("home")}>
            <IconClose size={14} />
            退出 <kbd>Esc</kbd>
          </button>
          <div className="bar">
            <i style={{ width: `${progress}%` }} />
          </div>
          <span className="muted">
            {Math.min(pos + 1, Math.max(due.length, 1))} / {due.length}
          </span>
        </div>

        {outcome && (
          <div className="vault-outcome-strip" role="status">
            上一关：<b>{outcome.word}</b> {outcome.text}
          </div>
        )}

        {current ? (
          effKind === "cloze" && spec ? (
            <div className="focus-card">
              <FocusCloze
                word={current}
                spec={spec}
                input={input}
                hints={hints}
                verdict={verdict}
                sourceLabel={sourceLabel}
                onInput={setInput}
                onHint={() => setHints((n) => Math.min(2, n + 1))}
                onSubmit={submitCloze}
                onGiveUp={() => setVerdict("wrong")}
                onGrade={grade}
                onJumpToSentence={props.onJumpToSentence}
              />
            </div>
          ) : effKind === "dictation" && spec ? (
            <div className="vault-focus">
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
            </div>
          ) : (
            <div className="vault-focus">
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
            </div>
          )
        ) : (
          <div className="vault-done-panel">
            <div className="big">{stats.total === 0 ? "生词本还是空的" : "本轮复习完成 🎉"}</div>
            <div className="sub">
              {stats.total === 0
                ? "在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。"
                : "这一批都过了。整理成笔记，或回阅读室继续攒新词。"}
            </div>
            <div className="review-done-nav">
              <button className="btn btn-secondary btn-sm" onClick={() => props.onModeChange("home")}>
                回复习首页
              </button>
              {props.onOpenReader && (
                <button className="btn btn-ghost btn-sm" onClick={props.onOpenReader}>
                  回阅读室
                </button>
              )}
              {props.onGenerateNote && (
                <button className="btn btn-primary btn-sm" onClick={props.onGenerateNote}>
                  整理成笔记
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 专注完形卡：26px 衬线大句 + 内嵌输入 + 两级提示阶梯（提示不显示答案本身）+ 三档评分带。 */
function FocusCloze({
  word,
  spec,
  input,
  hints,
  verdict,
  sourceLabel,
  onInput,
  onHint,
  onSubmit,
  onGiveUp,
  onGrade,
  onJumpToSentence,
}: {
  word: VocabWord;
  spec: SentenceSpec;
  input: string;
  hints: number;
  verdict: RecallVerdict | null;
  sourceLabel: string;
  onInput: (v: string) => void;
  onHint: () => void;
  onSubmit: () => void;
  onGiveUp: () => void;
  onGrade: (g: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
}) {
  const graded = verdict !== null;
  const wordCount = spec.blank.trim().split(/\s+/).length;
  return (
    <>
      <div className="q-meta">
        <span className="tag">填空</span>
        <span>{sourceLabel}</span>
      </div>

      <div className="q-sent">
        {spec.pre}
        {graded ? (
          <span
            className={`cloze-blank fill ${verdict === "perfect" ? "good" : verdict === "close" ? "warn" : "bad"}`}
          >
            {spec.blank}
          </span>
        ) : (
          <BlankInput value={input} onChange={onInput} onSubmit={onSubmit} />
        )}
        {spec.post}
      </div>

      {!graded && (
        <div className="hint-ladder">
          <div className={`hint-step${hints >= 1 ? " shown" : ""}`}>
            <span className="lv">提示 1</span>
            {hints >= 1 ? (
              spec.zh ? <>译文：{spec.zh}</> : "这篇没有配译文"
            ) : (
              <>
                整句译文
                <button onClick={onHint}>展开</button>
              </>
            )}
          </div>
          <div className={`hint-step${hints >= 2 ? " shown" : ""}`}>
            <span className="lv">提示 2</span>
            {hints >= 2 ? (
              <>
                首字母与长度：{firstLetters(spec.blank)}（{wordCount} 词）
              </>
            ) : (
              <>
                首字母与长度
                <button onClick={onHint}>展开</button>
              </>
            )}
          </div>
        </div>
      )}

      {graded && (
        <>
          <VerdictPanel
            verdict={verdict}
            onJump={
              word.source.articleId
                ? () => onJumpToSentence(word.source.articleId, word.source.sentenceIdx)
                : undefined
            }
          >
            {verdict === "close" && (
              <span className="v-body">
                你写的：<b>{input.trim()}</b>
                <br />
              </span>
            )}
            {verdict === "trap" && (
              <span className="v-body">
                你写了 <b>{input.trim()}</b> —— {word.trap || "这是常见的直译错误"}
                <br />
              </span>
            )}
            <span className="ans">
              {spec.blank}
              {spec.blank !== word.word && <span className="ans-note">（词条原形：{word.word}）</span>}
            </span>
          </VerdictPanel>
          <div className="answer-row">
            <VaultGradeBandRow suggested={vaultSuggested(verdict)} onGrade={onGrade} />
            <div className="keys">
              <span>
                <kbd>Enter</kbd> {VAULT_GRADE_BANDS.find((b) => b.grade === vaultSuggested(verdict))?.name}
              </span>
              <span>
                <kbd>1</kbd>–<kbd>3</kbd> 直选
              </span>
            </div>
          </div>
        </>
      )}

      {!graded && (
        <div className="answer-row">
          <button className="vault-btn primary lg" onClick={onSubmit} disabled={!input.trim()}>
            提交
          </button>
          <button className="vault-btn lg" onClick={onGiveUp}>
            我不会
          </button>
          <div className="keys">
            <span>
              <kbd>Enter</kbd> 提交
            </span>
            <span>
              <kbd>Tab</kbd> 下一级提示
            </span>
          </div>
        </div>
      )}

      <div className="focus-foot">
        <span>提示不会显示答案本身</span>
        <span>提交后选择「记住了 / 模糊 / 没记住」</span>
      </div>
    </>
  );
}

// ---------- 导出：范围预过滤 + 包含项只作用于预览 + 预览/源码 seg ----------

type ExpScope = "week" | "today" | "all";

const EXP_SCOPES: { id: ExpScope; label: string }[] = [
  { id: "week", label: "本周（最近 7 天）" },
  { id: "today", label: "今天" },
  { id: "all", label: "全部" },
];

const EXP_INCLUDES: { id: "ex" | "def" | "ipa" | "note"; label: string }[] = [
  { id: "ex", label: "原句" },
  { id: "def", label: "释义" },
  { id: "ipa", label: "音标" },
  { id: "note", label: "用法提示" },
];

function ExportStage(props: Props) {
  const { words, speakSessions, sourceSentence } = props;
  const [scope, setScope] = useState<ExpScope>("week");
  const [incl, setIncl] = useState<Record<"ex" | "def" | "ipa" | "note", boolean>>({
    ex: true,
    def: true,
    ipa: false,
    note: true,
  });
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState("");
  const dateKey = dayKey();

  /** 范围筛选只在调用侧预过滤（buildVaultMarkdown 纯函数与三段结构零改动）。 */
  const filteredWords = useMemo(() => {
    if (scope === "all") return words;
    const now = Date.now();
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    return words.filter((w) =>
      scope === "today" ? dayKey(w.addedAt) === dayKey(now) : w.addedAt >= weekStart,
    );
  }, [words, scope]);
  const filteredSessions = useMemo(() => {
    if (scope === "all") return speakSessions;
    const now = Date.now();
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    return speakSessions.filter((s) =>
      scope === "today" ? dayKey(s.createdAt) === dayKey(now) : s.createdAt >= weekStart,
    );
  }, [speakSessions, scope]);

  const markdown = useMemo(
    () => buildVaultMarkdown({ words: filteredWords, sourceSentence, speakSessions: filteredSessions, dateKey }),
    [filteredWords, sourceSentence, filteredSessions, dateKey],
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

  const save = () => {
    setSaveError("");
    void saveTextFile(`${dateKey}-学习笔记.md`, markdown).catch((e: unknown) => {
      setSaveError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <section className="stage">
      <div className="stage-head">
        <button className="exit" onClick={() => props.onModeChange("home")}>
          ← 返回复习
        </button>
        <div className="row">
          <button className="vault-btn sm" onClick={copy}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? "已复制" : "复制 Markdown"}
          </button>
          <button className="vault-btn primary sm" onClick={save}>
            <IconDownload size={14} />
            保存为 .md
          </button>
        </div>
      </div>

      <div className="exp">
        <h2>导出学习笔记</h2>
        <div className="exp-opts">
          <div className="opt-group">
            <label>范围</label>
            {EXP_SCOPES.map((s) => (
              <button
                key={s.id}
                className={`chk${scope === s.id ? " on" : ""}`}
                aria-pressed={scope === s.id}
                onClick={() => setScope(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="opt-group">
            <label>包含</label>
            {EXP_INCLUDES.map((c) => (
              <button
                key={c.id}
                className={`chk${incl[c.id] ? " on" : ""}`}
                aria-pressed={incl[c.id]}
                onClick={() => setIncl((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {saveError && <div className="exp-error">保存失败：{saveError}</div>}

        <div className="exp-bar">
          <div className="seg">
            <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>
              预览
            </button>
            <button className={tab === "source" ? "on" : ""} onClick={() => setTab("source")}>
              Markdown 源码
            </button>
          </div>
          <span className="muted">共 {filteredWords.length} 条</span>
        </div>

        {tab === "source" ? (
          <pre className="vault-markdown-pre">{markdown}</pre>
        ) : (
          <div className="md">
            <h3>{dateKey} 英语精读笔记</h3>
            {filteredWords.map((w) => {
              const src =
                (w.source.articleId
                  ? sourceSentence(w.source.articleId, w.source.sentenceIdx)
                  : null) ??
                (w.example ? { en: w.example.en, zh: w.example.zh } : null);
              const gloss = w.senses.map((s) => (s.pos ? `${s.pos} ${s.cn}` : s.cn)).join("；");
              const usage = [w.pattern, w.trap].filter(Boolean).join(" · ");
              return (
                <div className="w" key={w.id}>
                  <b>{w.word}</b>
                  {incl.ipa && w.phonetic && <span className="ipa">/{w.phonetic.replace(/^\/|\/$/g, "")}/</span>}
                  {incl.def && gloss ? <span> {gloss}</span> : null}
                  {incl.ex && src?.en && <div className="ex">{src.en}</div>}
                  {incl.note && usage && <div className="note">用法：{usage}</div>}
                </div>
              );
            })}
            {filteredWords.length === 0 && (
              <div className="vault-list-empty">这个范围内还没有可导出的词条。</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- 右侧看板：进度环 + 三阶分段条 + 28 天热力 + 易错项 ----------

const STAGE_LEGEND: { stage: "s1" | "s2" | "s3"; label: string }[] = [
  { stage: "s1", label: "刚收集" },
  { stage: "s2", label: "眼熟（读到能懂）" },
  { stage: "s3", label: "能说出口" },
];

function Board({
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
  const todayCount = buckets.find((b) => b.today)?.count ?? 0;

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
  const pct = todayTotal > 0 ? Math.min(100, (stats.reviewedToday / todayTotal) * 100) : 0;
  const stageTotal = Math.max(1, words.length);

  return (
    <aside className="board">
      <div className="card">
        <h3>今日进度</h3>
        <div className="prog">
          <div className="ring" style={{ "--p": pct } as CSSProperties}>
            <span>
              {stats.reviewedToday}/{todayTotal}
            </span>
          </div>
          <div>
            <b>还差 {due.length} 条</b>
            <span className="muted">约 {vaultMinutes(due.length)} 分钟</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>掌握阶段</h3>
        <div className="stages">
          <i style={{ width: `${(stageCounts.s1 / stageTotal) * 100}%` }} className="v-s1" />
          <i style={{ width: `${(stageCounts.s2 / stageTotal) * 100}%` }} className="v-s2" />
          <i style={{ width: `${(stageCounts.s3 / stageTotal) * 100}%` }} className="v-s3" />
        </div>
        {STAGE_LEGEND.map((row) => (
          <div key={row.stage} className="stage-row">
            <span className={`dot ${row.stage}`} />
            <span>{row.label}</span>
            <span className="n">{stageCounts[row.stage]}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>近 28 天</h3>
        <div className="heatmap-grid">
          {buckets.map((b) => (
            <span
              key={b.dayKey}
              className={`heat-cell${b.level > 0 ? ` l${b.level}` : ""}${b.today ? " today" : ""}`}
              title={`${b.dayKey} · 复习 ${b.count} 次`}
            />
          ))}
        </div>
        <div className="empty-hint">
          {todayCount === 0 ? "完成第一轮复习，就会点亮今天。" : `出勤 ${attended} 天`}
        </div>
      </div>

      <div className="card">
        <h3>易错项靶向加练</h3>
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
              className="vault-btn sm weak-btn"
              onClick={() => {
                onStartFocusReview(weakWords.map((x) => x.word.id));
                onModeChange("focus");
              }}
            >
              1 分钟只练这 {weakWords.length} 个易错项
            </button>
            <button className="vault-btn ghost sm weak-speak-btn" onClick={onPracticeVocabSpeak}>
              去口语里加练 →
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
