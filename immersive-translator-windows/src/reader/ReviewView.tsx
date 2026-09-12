/**
 * 屏 D · 生词本复习流：产出式复习（Active Recall）。
 *
 * 左列 232px 是生本词表（VocabListPanel，由 ReaderApp 按视图挂载），
 * 本组件自带中列 240px（今日进度/连续打卡/掌握度分布）+ 卡片列 640px。
 * 三种练习形态：识别（词典词条式翻卡）/ 完形填空（原句挖空打字）/ 听写（听句写句）。
 * reviewMode = smart 时按卡路由：词块→完形 · 熟词（间隔≥1天）→听写 · 新词→识别。
 *
 * 判分在 recallJudge.ts（纯本地）；判定只映射为评分带上的「建议档」描边，
 * 四档评分以白话提问+作答呈现（没想起/很勉强/想起来了/很轻松），SRS 演进不变。
 * 原句缺失（文章被删）或词块定位失败时自动降级为识别卡。
 *
 * 版式取向：卡片是一则「词典词条」——词头 / 词性 / 释义 / 书证（原句）。
 * 唯一的视觉重音是释义；层级靠两条细分隔线组织，不靠堆卡片。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconVolume } from "../ui/icons";
import type { ReviewGrade } from "../core/readerSrs";
import {
  CHUNK_TYPE_LABELS,
  REVIEW_MODE_LABELS,
  type RecallMode,
  type ReviewModeSetting,
  type VocabCollocation,
  type VocabSense,
  type VocabWord,
} from "../core/readerTypes";
import { findChunkRange } from "../core/chunkAnnotate";
import {
  firstLetters,
  judgeCloze,
  judgeDictation,
  routeRecallMode,
  verdictToSuggestedGrade,
  wordDiff,
  type RecallVerdict,
} from "../core/recallJudge";
import type { ReviewStats } from "../lib/readerStore";

interface Props {
  words: VocabWord[];
  /** 到期队列（ReaderApp 统一计算，与左栏词表共用）。 */
  due: VocabWord[];
  /** 当前卡在队列中的位置（受控：左栏词表可跳卡）。 */
  pos: number;
  onSetPos: (i: number) => void;
  stats: ReviewStats;
  /** 复习模式（全局设置）：smart 按卡路由。 */
  reviewMode: ReviewModeSetting;
  onReviewModeChange: (mode: ReviewModeSetting) => void;
  /** 评分提交：由 ReaderApp 落盘并刷新。 */
  onGrade: (word: VocabWord, grade: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
  onSpeakWord: (text: string) => void;
  /** 听写整句朗读：word 音轨 + 稍慢语速，不打断句子朗读音轨。 */
  onSpeakSentence: (text: string) => void;
  /** 原句英文（识别/听写卡的书证）。 */
  sourcePreview: (articleId: string, sentenceIdx: number) => string | null;
  /** 原句含译文（完形卡的中文提示行）。 */
  sourceSentence: (articleId: string, sentenceIdx: number) => { en: string; zh: string | null } | null;
  articleTitle: (articleId: string) => string | null;
}

interface RecallResult {
  wordId: string;
  mode: RecallMode;
  judged: RecallVerdict | null;
  grade: ReviewGrade;
}

/** 听写卡除首次自动朗读外的重播次数。 */
const DICTATION_REPLAYS = 3;

const MODE_DESC: Record<ReviewModeSetting, string> = {
  smart: "智能混合：词块→完形 · 熟词→听写 · 新词→识别",
  recognition: "识别：看词想义",
  cloze: "完形：原句挖空 · 打字产出",
  dictation: "听写：听整句 · 写整句",
};

const GRADES: { value: ReviewGrade; key: string }[] = [
  { value: "forgot", key: "1" },
  { value: "hard", key: "2" },
  { value: "good", key: "3" },
  { value: "easy", key: "4" },
];

/**
 * 四档评分的白话文案：名字回答「刚才想起来了吗」，副行回答「下次什么时候见」。
 * 不再露出 SRS 术语（忘记/困难/一般/简单）——新用户也能望文生义。
 */
export const GRADE_COPY: Record<ReviewGrade, { name: string; next: string }> = {
  forgot: { name: "没想起", next: "10分钟后再来" },
  hard: { name: "很勉强", next: "明天再来" },
  good: { name: "想起来了", next: "3天后再来" },
  easy: { name: "很轻松", next: "7天后再来" },
};

/** 评分带的提问行：四种练习各问一句，按钮就是回答。 */
export function gradeAsk(mode: RecallMode): string {
  return {
    recognition: "翻面前，你想出意思了吗？",
    cloze: "这个空，你答上来了吗？",
    dictation: "这一句，你写出来了吗？",
  }[mode];
}

/**
 * 智能模式下卡片小签的派发说明：为什么这张卡练这个形态。
 * （词块→完形 · 熟词间隔≥1天→听写 · 其余→识别）
 */
const SMART_ROUTE_TIP: Record<RecallMode, string> = {
  cloze: "智能混合：本卡是词块，练完形（放进原句默写）",
  dictation: "智能混合：本卡已复习过（间隔≥1 天），练听写",
  recognition: "智能混合：本卡是新词，先看词想义",
};

/** 完形/听写卡的句子素材：挖空定位过的一段。 */
interface SentenceSpec {
  sentence: string;
  zh: string | null;
  pre: string;
  blank: string;
  post: string;
}

/** 在原句里定位要挖空/听写的目标；定位不到返回 null（调用方降级为识别卡）。 */
function locateSentence(word: VocabWord, src: { en: string; zh: string | null } | null): SentenceSpec | null {
  if (!src || !src.en) return null;
  const range = findChunkRange(src.en, word.word);
  if (!range) return null;
  return {
    sentence: src.en,
    zh: src.zh,
    pre: src.en.slice(0, range.start),
    blank: src.en.slice(range.start, range.end),
    post: src.en.slice(range.end),
  };
}

export function ReviewView({
  words,
  due,
  pos,
  onSetPos,
  stats,
  reviewMode,
  onReviewModeChange,
  onGrade,
  onJumpToSentence,
  onSpeakWord,
  onSpeakSentence,
  sourcePreview,
  sourceSentence,
  articleTitle,
}: Props) {
  const [results, setResults] = useState<RecallResult[]>([]);

  // ---- 卡片内状态（每张卡重置） ----
  const [flipped, setFlipped] = useState(false); // 识别卡翻面
  const [input, setInput] = useState(""); // 完形/听写输入
  const [hints, setHints] = useState(0); // 完形提示阶梯 0-3
  const [cnShown, setCnShown] = useState(false); // 完形卡中文提示揭幕
  const [verdict, setVerdict] = useState<RecallVerdict | null>(null); // 产出判分（null=未判）
  const [replays, setReplays] = useState(DICTATION_REPLAYS);
  const gradedRef = useRef<Set<string>>(new Set());
  const spokeRef = useRef<string>("");

  const current = due[pos] ?? due[0] ?? null;

  // ---- 到期队列变化（评分后父层刷新）时回到队首，并清评分防重入 ----
  useEffect(() => {
    onSetPos(0);
    gradedRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words.length]);

  // ---- 队列耗尽（评完最后一张）时收拢游标，保证计数显示正确 ----
  useEffect(() => {
    if (pos >= due.length) onSetPos(0);
  }, [due.length, pos, onSetPos]);

  // ---- 换卡/换模式：重置卡片内状态 ----
  useEffect(() => {
    setFlipped(false);
    setInput("");
    setHints(0);
    setCnShown(false);
    setVerdict(null);
    setReplays(DICTATION_REPLAYS);
  }, [current?.id, reviewMode]);

  // ---- 当前卡的形态与句子素材 ----
  const { effMode, spec } = useMemo(() => {
    if (!current) return { effMode: "recognition" as RecallMode, spec: null as SentenceSpec | null };
    const routed = routeRecallMode(current, reviewMode);
    // 无文章来源（划词收藏）时回退到 LLM 例句
    const exSrc = current.example ? { en: current.example.en, zh: current.example.zh ?? null } : null;
    const src =
      routed === "cloze" || routed === "dictation"
        ? (sourceSentence(current.source.articleId, current.source.sentenceIdx) ?? exSrc)
        : null;
    if (routed === "recognition" || !src || !src.en) return { effMode: "recognition" as RecallMode, spec: null };
    // 听写只需要整句；完形还要求词块文本在句中可定位（标注管线保证的不变量），
    // 定位不到就降级为识别卡。
    if (routed === "dictation") {
      return {
        effMode: routed,
        spec: { sentence: src.en, zh: src.zh, pre: "", blank: "", post: "" },
      };
    }
    const s = locateSentence(current, src);
    return s ? { effMode: routed, spec: s } : { effMode: "recognition" as RecallMode, spec: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, reviewMode]);

  /** 卡片头部来源行：有文章给「文章名 · 第 N 句」，划词收藏给专属标签。 */
  const metaSource = useCallback(
    (w: VocabWord) => {
      const title = w.source.articleId ? articleTitle(w.source.articleId) : null;
      return title ? `来自「${title}」· 第 ${w.source.sentenceIdx + 1} 句` : "来自划词收藏";
    },
    [articleTitle],
  );

  /** 识别卡书证：文章原句，缺失时回退例句。 */
  const recognitionSentence = useCallback(
    (w: VocabWord) => sourcePreview(w.source.articleId, w.source.sentenceIdx) ?? w.example?.en ?? null,
    [sourcePreview],
  );

  // ---- 听写卡进入即自动朗读一次（word 音轨，不打断句子朗读） ----
  useEffect(() => {
    if (effMode === "dictation" && spec && current && spokeRef.current !== current.id) {
      spokeRef.current = current.id;
      onSpeakSentence(spec.sentence);
    }
  }, [effMode, spec, current, onSpeakSentence]);

  const grade = useCallback(
    (g: ReviewGrade) => {
      if (!current) return;
      if (gradedRef.current.has(current.id)) return;
      gradedRef.current.add(current.id);
      setResults((rs) => [...rs, { wordId: current.id, mode: effMode, judged: verdict, grade: g }]);
      onGrade(current, g);
    },
    [current, effMode, verdict, onGrade],
  );

  const submitCloze = useCallback(() => {
    if (verdict !== null || !spec) return;
    if (!input.trim()) return;
    setVerdict(judgeCloze(input, spec.blank, { trap: current?.trap, accepted: [current?.word ?? ""] }));
  }, [verdict, spec, input, current]);

  const submitDictation = useCallback(() => {
    if (verdict !== null || !spec) return;
    if (!input.trim()) return;
    setVerdict(judgeDictation(input, spec.sentence, { trap: current?.trap }));
  }, [verdict, spec, input, current]);

  // ---- 快捷键：1-4 评分 · 空格翻面/重播/发音 · Enter 翻面 · H 提示 ----
  useEffect(() => {
    function typing(): boolean {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    }
    function onKey(e: KeyboardEvent) {
      if (typing() || !current) return;
      const g = GRADES.find((x) => x.key === e.key);
      if (g) {
        const gradeable = effMode === "recognition" ? flipped : verdict !== null;
        if (gradeable) {
          e.preventDefault();
          grade(g.value);
        }
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        if (effMode === "recognition") {
          e.preventDefault();
          if (!flipped) setFlipped(true);
          else if (e.key === " ") onSpeakWord(current.word);
        } else if (verdict !== null && e.key === "Enter") {
          // 产出卡判分后：Enter = 接受建议档（1–4 可改选）
          e.preventDefault();
          grade(verdictToSuggestedGrade(verdict));
        } else if (effMode === "dictation" && verdict === null && e.key === " ") {
          e.preventDefault();
          if (replays > 0 && spec) {
            setReplays((r) => r - 1);
            onSpeakSentence(spec.sentence);
          }
        }
        return;
      }
      if ((e.key === "h" || e.key === "H") && effMode === "cloze" && verdict === null) {
        setHints((n) => Math.min(3, n + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, effMode, flipped, verdict, replays, spec, grade, onSpeakWord, onSpeakSentence]);

  // ---- 左栏（沿用现版式） ----
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
          <ModeSwitch value={reviewMode} onChange={onReviewModeChange} />
          {current ? (
            effMode === "recognition" ? (
              <RecognitionCard
                word={current}
                flipped={flipped}
                pos={pos}
                total={due.length}
                smart={reviewMode === "smart"}
                sourceLabel={metaSource(current)}
                sentence={recognitionSentence(current)}
                onFlip={() => setFlipped(true)}
                onUnflip={() => setFlipped(false)}
                onGrade={grade}
                onSpeakWord={onSpeakWord}
                onJumpToSentence={onJumpToSentence}
              />
            ) : effMode === "cloze" && spec ? (
              <ClozeCard
                word={current}
                spec={spec}
                input={input}
                hints={hints}
                cnShown={cnShown}
                verdict={verdict}
                pos={pos}
                total={due.length}
                smart={reviewMode === "smart"}
                sourceLabel={metaSource(current)}
                onInput={setInput}
                onHint={() => setHints((n) => Math.min(3, n + 1))}
                onRevealCn={() => setCnShown(true)}
                onSubmit={submitCloze}
                onGiveUp={() => setVerdict("wrong")}
                onGrade={grade}
                onJumpToSentence={onJumpToSentence}
              />
            ) : spec ? (
              <DictationCard
                word={current}
                spec={spec}
                input={input}
                verdict={verdict}
                replays={replays}
                pos={pos}
                total={due.length}
                smart={reviewMode === "smart"}
                sourceLabel={metaSource(current)}
                onInput={setInput}
                onReplay={() => {
                  if (!spec) return;
                  if (verdict === null) {
                    // 答题阶段限次重播；判分后不限次（对照复盘用）
                    if (replays <= 0) return;
                    setReplays((r) => r - 1);
                  }
                  onSpeakSentence(spec.sentence);
                }}
                onSubmit={submitDictation}
                onGiveUp={() => setVerdict("wrong")}
                onGrade={grade}
                onJumpToSentence={onJumpToSentence}
              />
            ) : null
          ) : due.length === 0 && results.length > 0 ? (
            <SummaryPanel
              results={results}
              onRestart={() => {
                setResults([]);
                gradedRef.current = new Set();
              }}
            />
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

// ---------- 模式切换 ----------

function ModeSwitch({ value, onChange }: { value: ReviewModeSetting; onChange: (m: ReviewModeSetting) => void }) {
  const options: ReviewModeSetting[] = ["smart", "recognition", "cloze", "dictation"];
  return (
    <div className="review-mode-row">
      <div className="review-mode-seg" role="group" aria-label="复习模式">
        {options.map((m) => (
          <button key={m} className={`review-mode-btn${value === m ? " on" : ""}`} onClick={() => onChange(m)}>
            {REVIEW_MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <span className="review-mode-desc">{MODE_DESC[value]}</span>
    </div>
  );
}

// ---------- 词条版式小件 ----------

/** 卡片头部：形态标签 + 来源 + 进度。 */
/**
 * 卡片头部：形态标签（智能模式下前缀「智能」并带派发原因悬停说明）+ 来源 + 进度。
 */
function CardMeta({
  pill,
  tone,
  smart,
  source,
  pos,
  total,
}: {
  pill: string;
  tone?: "muted" | "dict";
  /** 智能混合按卡路由时为 true：小签变「智能 · X」，一眼可见是派发而非切错模式。 */
  smart?: boolean;
  source: string;
  pos: number;
  total: number;
}) {
  return (
    <div className="card-meta">
      <span
        className={`mode-pill${tone ? ` ${tone}` : ""}${smart ? " smart" : ""}`}
        title={smart ? pillTip(pill) : undefined}
      >
        {smart ? `智能 · ${pill}` : pill}
      </span>
      <span className="rc-from">{source}</span>
      <span className="rc-counter">
        {pos + 1} / {total}
      </span>
    </div>
  );
}

function pillTip(pill: string): string | undefined {
  if (pill === "完形") return SMART_ROUTE_TIP.cloze;
  if (pill === "听写") return SMART_ROUTE_TIP.dictation;
  if (pill === "识别") return SMART_ROUTE_TIP.recognition;
  return undefined;
}

/** 词头：目标词 + 类型徽章 / 音标 + 发音（背面可加「遮住释义」）。 */
function WordHead({
  word,
  onSpeak,
  onCollapse,
}: {
  word: VocabWord;
  onSpeak: (t: string) => void;
  onCollapse?: () => void;
}) {
  return (
    <div className="rc-head">
      <div className="rc-head-main">
        <span className="rc-word">{word.word}</span>
        {word.kind === "chunk" && word.chunkType && (
          <span className="chunk-type-badge">{CHUNK_TYPE_LABELS[word.chunkType]}</span>
        )}
      </div>
      <div className="rc-head-sub">
        {word.phonetic && <span className="rc-phonetic">/{word.phonetic.replace(/^\/|\/$/g, "")}/</span>}
        <button
          className="rc-speak"
          onClick={() => word.word && onSpeak(word.word)}
          title="发音（空格）"
          aria-label="发音"
        >
          <IconVolume size={15} />
        </button>
        {onCollapse && (
          <button className="rc-collapse" onClick={onCollapse}>
            遮住释义
          </button>
        )}
      </div>
    </div>
  );
}

/** 释义：卡片的视觉重音。 */
function MeaningBlock({ senses }: { senses: VocabSense[] }) {
  if (senses.length === 0) return null;
  return (
    <div className="rc-meaning">
      {senses.map((s, i) => (
        <p key={i} className="rc-sense">
          {s.pos && <span className="rc-pos">{s.pos}</span>}
          {s.cn}
        </p>
      ))}
    </div>
  );
}

/** 用法细节：记法 / 直译陷阱（标签列对齐）。 */
function UsageBlock({ word }: { word: VocabWord }) {
  if (word.kind !== "chunk") return null;
  const rows: { label: string; value: ReactNode; tone?: string }[] = [];
  if (word.pattern) rows.push({ label: "记法", value: <i className="rc-serif">{word.pattern}</i> });
  if (word.trap) rows.push({ label: "直译陷阱", value: word.trap, tone: "trap" });
  if (rows.length === 0) return null;
  return (
    <div className="rc-usage">
      {rows.map((r, i) => (
        <div key={i} className={`rc-usage-row${r.tone === "trap" ? " trap" : ""}`}>
          <span className="rc-usage-label">{r.label}</span>
          <span className="rc-usage-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 常用搭配：英文搭配 + 中文，列对齐。 */
function CollocationBlock({ items }: { items: VocabCollocation[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="rc-colloc">
      <div className="rc-section-title">常用搭配</div>
      {items.map((c, i) => (
        <div key={i} className="rc-colloc-row">
          <span className="rc-colloc-en">{c.en}</span>
          <span className="rc-colloc-cn">{c.cn}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 书证（原句）：识别卡正面把目标挖空（只给语境、不给答案），背面高亮目标。
 * 整块可点 → 回到原文该句。
 */
function ContextBlock({
  sentence,
  target,
  revealed,
  onJump,
  empty,
}: {
  sentence: string | null;
  target: string;
  revealed: boolean;
  onJump?: () => void;
  empty?: string;
}) {
  if (!sentence) {
    return empty ? <div className="rc-context rc-context-empty">{empty}</div> : null;
  }
  const range = findChunkRange(sentence, target);
  const pre = range ? sentence.slice(0, range.start) : sentence;
  const mid = range ? sentence.slice(range.start, range.end) : "";
  const post = range ? sentence.slice(range.end) : "";
  const clickable = Boolean(onJump);
  return (
    <div
      className={`rc-context${clickable ? " clickable" : ""}`}
      onClick={clickable ? onJump : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump?.();
              }
            }
          : undefined
      }
      title={clickable ? "回到原文这一句" : undefined}
    >
      <span className="rc-context-sentence">
        {pre}
        {mid &&
          (revealed ? (
            <mark className="rc-hit">{mid}</mark>
          ) : (
            <span className="rc-blank" style={{ width: `${Math.max(3, mid.length)}ch` }} aria-label="此处被遮住" />
          ))}
        {post}
      </span>
      {clickable && <span className="rc-context-jump">回到原文</span>}
    </div>
  );
}

// ---------- 评分带 ----------

/**
 * 先提问、后作答：一行白话问题 + 四个回答按钮。
 * 按钮名是回忆的体感（没想起→很轻松），副行是后果（下次什么时候见），
 * 快捷键数字退成右上角标；建议档仍以描边 + 「建议」小签标出。
 */
function GradeBar({ suggest, ask, onGrade }: { suggest: ReviewGrade | null; ask: string; onGrade: (g: ReviewGrade) => void }) {
  return (
    <div className="review-gradebar">
      <div className="grade-ask">{ask}</div>
      <div className="grade-row">
        {GRADES.map(({ value, key }) => (
          <button
            key={value}
            className={`grade-btn ${value}${suggest === value ? " focus" : ""}`}
            onClick={() => onGrade(value)}
          >
            <span className="name">{GRADE_COPY[value].name}</span>
            <span className="next">{GRADE_COPY[value].next}</span>
            <span className="kbd" title={`快捷键 ${key}`}>
              {key}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 评分区（页脚）：提问 + 四档；产出卡判分后附建议档快捷路径说明。 */
function GradeFooter({
  suggest,
  ask,
  onGrade,
}: {
  suggest: ReviewGrade | null;
  ask: string;
  onGrade: (g: ReviewGrade) => void;
}) {
  return (
    <div className="rc-footer">
      <GradeBar suggest={suggest} ask={ask} onGrade={onGrade} />
      {suggest && (
        <div className="rc-note">
          <span className="kbd">Enter</span> 采纳「建议」档 · <span className="kbd">1</span>–<span className="kbd">4</span>{" "}
          改选
        </div>
      )}
    </div>
  );
}

function VerdictPanel({
  verdict,
  onJump,
  children,
}: {
  verdict: RecallVerdict;
  onJump?: () => void;
  children: ReactNode;
}) {
  const head = { perfect: "✓ 一次写对", close: "≈ 很接近，差一点", trap: "⚠ 命中直译陷阱", wrong: "✗ 没想起来" }[verdict];
  return (
    <div className={`recall-verdict ${verdict}`}>
      <span className="v-head">{head}</span>
      {children}
      {onJump && (
        <button className="rc-jump" onClick={onJump}>
          回到原文
        </button>
      )}
    </div>
  );
}

// ---------- 识别卡（词典词条式） ----------

function RecognitionCard({
  word,
  flipped,
  pos,
  total,
  smart,
  sourceLabel,
  sentence,
  onFlip,
  onUnflip,
  onGrade,
  onSpeakWord,
  onJumpToSentence,
}: {
  word: VocabWord;
  flipped: boolean;
  pos: number;
  total: number;
  smart?: boolean;
  sourceLabel: string;
  sentence: string | null;
  onFlip: () => void;
  onUnflip: () => void;
  onGrade: (g: ReviewGrade) => void;
  onSpeakWord: (t: string) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
}) {
  const jump = () => onJumpToSentence(word.source.articleId, word.source.sentenceIdx);
  return (
    <div className="review-card" key={word.id}>
      <CardMeta pill="识别" tone="muted" smart={smart} source={sourceLabel} pos={pos} total={total} />

      <WordHead word={word} onSpeak={onSpeakWord} onCollapse={flipped ? onUnflip : undefined} />

      <div className="rc-rule" />

      {flipped ? (
        <div className="rc-answer">
          <MeaningBlock senses={word.senses} />
          <ContextBlock
            sentence={sentence}
            target={word.word}
            revealed
            onJump={sentence ? jump : undefined}
            empty={word.example ? undefined : "（原句已随文章删除）"}
          />
          <UsageBlock word={word} />
          <CollocationBlock items={word.collocations ?? []} />
        </div>
      ) : (
        <div className="rc-prompt">
          <div className="rc-prompt-text">{sentence ? "先想想它在句中的意思" : "想好意思了吗？"}</div>
          <ContextBlock sentence={sentence} target={word.word} revealed={false} />
        </div>
      )}

      <div className="rc-footer">
        {flipped ? (
          <>
            <GradeBar suggest={null} ask={gradeAsk("recognition")} onGrade={onGrade} />
            <div className="rc-note">
              <span className="kbd">1</span>–<span className="kbd">4</span> 评分 · <span className="kbd">Space</span> 发音
            </div>
          </>
        ) : (
          <div className="submit-row">
            <button className="recall-btn primary" onClick={onFlip}>
              翻面 · 看释义
            </button>
            <span className="rc-keyhint">
              <span className="kbd">Space</span> / <span className="kbd">Enter</span> 翻面
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 完形卡 ----------

function ClozeCard({
  word,
  spec,
  input,
  hints,
  cnShown,
  verdict,
  pos,
  total,
  smart,
  sourceLabel,
  onInput,
  onHint,
  onRevealCn,
  onSubmit,
  onGiveUp,
  onGrade,
  onJumpToSentence,
}: {
  word: VocabWord;
  spec: SentenceSpec;
  input: string;
  hints: number;
  cnShown: boolean;
  verdict: RecallVerdict | null;
  pos: number;
  total: number;
  smart?: boolean;
  sourceLabel: string;
  onInput: (v: string) => void;
  onHint: () => void;
  onRevealCn: () => void;
  onSubmit: () => void;
  onGiveUp: () => void;
  onGrade: (g: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
}) {
  const graded = verdict !== null;
  const gloss = word.senses[0]?.cn ?? "";
  const jump = () => onJumpToSentence(word.source.articleId, word.source.sentenceIdx);
  const hintLevel3 = word.pattern
    ? { tag: "槽位记法", body: <i className="rc-serif">{word.pattern}</i> }
    : spec.zh
      ? { tag: "中文句", body: <>{spec.zh}</> }
      : word.phonetic
        ? { tag: "音标", body: <>/{word.phonetic.replace(/^\/|\/$/g, "")}/</> }
        : null;

  return (
    <div className="review-card" key={word.id}>
      <CardMeta pill="完形" smart={smart} source={sourceLabel} pos={pos} total={total} />

      <div className="cloze-sentence">
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

      {spec.zh && (
        <div className="cloze-cn">
          中文提示：
          <span className={cnShown ? "" : "cn-masked"} onClick={onRevealCn} title={cnShown ? undefined : "点击显示"}>
            {cnShown ? spec.zh : maskChinese(spec.zh)}
          </span>
        </div>
      )}

      {!graded && (
        <div className="recall-hints">
          {hints >= 1 && (
            <div className="hint">
              <span className="hint-tag">提示 1</span>
              {gloss}
            </div>
          )}
          {hints >= 2 && (
            <div className="hint">
              <span className="hint-tag">提示 2</span>首字母：{firstLetters(spec.blank)}（
              {spec.blank.trim().split(/\s+/).length} 词）
            </div>
          )}
          {hints >= 3 && hintLevel3 && (
            <div className="hint">
              <span className="hint-tag">提示 3</span>
              {hintLevel3.tag}：{hintLevel3.body}
            </div>
          )}
          {hints < 3 && (
            <button className="hint-btn" onClick={onHint}>
              再给一点提示（H）
            </button>
          )}
        </div>
      )}

      {graded && (
        <>
          <VerdictPanel verdict={verdict} onJump={jump}>
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
          <GradeFooter suggest={verdictToSuggestedGrade(verdict)} ask={gradeAsk("cloze")} onGrade={onGrade} />
        </>
      )}

      {!graded && (
        <div className="rc-footer">
          <div className="submit-row">
            <button className="recall-btn primary" onClick={onSubmit}>
              提交判分
            </button>
            <button className="recall-btn" onClick={onGiveUp}>
              想不出来，直接看答案
            </button>
            <span className="rc-keyhint">
              <span className="kbd">Enter</span> 提交 · <span className="kbd">H</span> 提示
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 句中内嵌的下划线输入框，宽度随内容自适应。 */
function BlankInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    const m = measureRef.current;
    if (!el || !m) return;
    m.textContent = value || el.placeholder || "";
    el.style.width = `${Math.min(320, Math.max(96, m.offsetWidth + 30))}px`;
  }, [value]);
  return (
    <>
      <span ref={measureRef} className="cloze-measure" aria-hidden />
      <input
        ref={inputRef}
        className="cloze-blank-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="写出被挖空的部分"
        aria-label="被挖空的词块"
        autoFocus
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // 输入框内按键不进全局快捷键：否则 Enter 提交后同一事件冒泡到 window，
            // 判分结果刚落就触发「采纳建议档」，用户永远看不到判分（实测可复现）。
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
    </>
  );
}

function maskChinese(zh: string): string {
  return zh.replace(/[^\s，。；：、！？]/g, "＿");
}

// ---------- 听写卡 ----------

function DictationCard({
  word,
  spec,
  input,
  verdict,
  replays,
  pos,
  total,
  smart,
  sourceLabel,
  onInput,
  onReplay,
  onSubmit,
  onGiveUp,
  onGrade,
  onJumpToSentence,
}: {
  word: VocabWord;
  spec: SentenceSpec;
  input: string;
  verdict: RecallVerdict | null;
  replays: number;
  pos: number;
  total: number;
  smart?: boolean;
  sourceLabel: string;
  onInput: (v: string) => void;
  onReplay: () => void;
  onSubmit: () => void;
  onGiveUp: () => void;
  onGrade: (g: ReviewGrade) => void;
  onJumpToSentence: (articleId: string, sentenceIdx: number) => void;
}) {
  const graded = verdict !== null;
  const diff = graded ? wordDiff(input, spec.sentence) : [];
  const hit = graded
    ? Math.round(
        (diff.filter((t) => t.status === "ok").length / Math.max(1, spec.sentence.trim().split(/\s+/).length)) * 100,
      )
    : 0;
  const jump = () => onJumpToSentence(word.source.articleId, word.source.sentenceIdx);

  return (
    <div className="review-card" key={word.id}>
      <CardMeta pill="听写" tone="dict" smart={smart} source={sourceLabel} pos={pos} total={total} />

      <div className="dictation-bar">
        <button className="recall-btn primary" onClick={onReplay} disabled={verdict === null && replays <= 0}>
          {graded ? "再听一遍" : replays < DICTATION_REPLAYS ? "重播句子" : "播放句子"}
        </button>
        <span className="dict-replay">
          可重播 <b>{replays}</b> 次（Space）
        </span>
        <span className="dict-replay" style={{ marginLeft: "auto" }}>
          听整句 · 写整句
        </span>
      </div>

      {!graded ? (
        <textarea
          className="dict-input"
          value={input}
          spellCheck={false}
          placeholder="听写整句（不区分大小写与标点）"
          aria-label="听写输入"
          autoFocus
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            // 同完形输入框：先断掉全局快捷键，Enter 只提交判分
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      ) : (
        <>
          <VerdictPanel verdict={verdict} onJump={jump}>
            <span className="v-head" style={{ fontWeight: 400 }}>
              词级命中 {hit}%
            </span>
            <span className="diff-line">
              {diff
                .map((t, i) =>
                  t.status === "ok" ? (
                    <span key={i} className="w-ok">
                      {t.text}
                    </span>
                  ) : t.status === "miss" ? (
                    <span key={i} className="w-miss">
                      {t.text}
                    </span>
                  ) : (
                    <span key={i} className="w-extra">
                      {t.text}
                    </span>
                  ),
                )
                .reduce<ReactNode[]>((acc, node, i) => (i === 0 ? [node] : [...acc, " ", node]), [])}
            </span>
            <span className="v-body" style={{ fontSize: 11 }}>
              图例：<span className="w-ok">写对</span> · <span className="w-miss">漏写的词</span> ·{" "}
              <span className="w-extra">多写/写错的词</span>
            </span>
            <span className="v-body">
              <span className="ans">{spec.sentence}</span>
            </span>
          </VerdictPanel>
          <GradeFooter suggest={verdictToSuggestedGrade(verdict)} ask={gradeAsk("dictation")} onGrade={onGrade} />
        </>
      )}

      {!graded && (
        <div className="rc-footer">
          <div className="submit-row">
            <button className="recall-btn primary" onClick={onSubmit}>
              提交判分
            </button>
            <button className="recall-btn" onClick={onGiveUp}>
              听不出，看句子
            </button>
            <span className="rc-keyhint">
              <span className="kbd">Enter</span> 提交
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 结果摘要 ----------

function SummaryPanel({ results, onRestart }: { results: RecallResult[]; onRestart: () => void }) {
  const produced = results.filter((r) => r.mode !== "recognition");
  const recogN = results.length - produced.length;
  const count = (j: RecallVerdict) => produced.filter((r) => r.judged === j).length;
  return (
    <div className="review-summary">
      <div className="big">本轮复习完成 🎉</div>
      <div className="sub">
        {produced.length} 张产出卡（完形/听写）
        {recogN > 0 ? ` · 另完成 ${recogN} 张识别卡` : ""}
      </div>
      <div className="sum-grid">
        <div className="sum-cell ok">
          <div className="n">{count("perfect")}</div>
          <div className="l">一次写对</div>
        </div>
        <div className="sum-cell warn">
          <div className="n">{count("close")}</div>
          <div className="l">接近差一点</div>
        </div>
        <div className="sum-cell err">
          <div className="n">{count("trap")}</div>
          <div className="l">直译陷阱</div>
        </div>
        <div className="sum-cell mute">
          <div className="n">{count("wrong")}</div>
          <div className="l">未想起</div>
        </div>
      </div>
      <div className="submit-row" style={{ justifyContent: "center" }}>
        <button className="recall-btn" onClick={onRestart}>
          清空本轮统计
        </button>
      </div>
    </div>
  );
}
