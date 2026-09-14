/**
 * 快速复习迷你窗（quick-review 窗口）：托盘「快速复习」/ 提醒卡「开始复习」直达。
 *
 * 与复习流同源：到期判定 srs.dueAt、判分 recallJudge、评分 gradeSrs、
 * 打卡 readerRecordReview；每张卡评分即落盘，收起/关窗不丢进度。
 * 迷你窗只做 识别 + 完形 两形态（听写需要句子连播语境，留在阅读室复习流）。
 *
 * 卡片可自由前后切换（‹ › 按钮 / ← → 键 / 点圆点），不必评分也能跳过；
 * 每张卡的界面状态独立保存，切走再切回不丢；识别卡释义可盖回，反复自测；
 * 已评的卡回看时可改评——
 * 档位按进窗时的原 SRS 重算（不叠加），打卡只在首次评分时记一次。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readerGetArticle, readerGetVocab, readerRecordReview, readerSaveVocabWord } from "../lib/readerStore";
import { ttsSpeakAdvanced } from "../lib/tauriBridge";
import { trayRefreshBadge } from "../lib/reminder";
import { loadGlobalReaderSettings } from "../reader/readerSettingsStore";
import { judgeCloze, routeRecallMode, verdictToSuggestedGrade, type RecallVerdict } from "../core/recallJudge";
import { dayKey, gradeSrs, GRADE_INTERVALS, type ReviewGrade } from "../core/readerSrs";
import type { Article, VocabWord } from "../core/readerTypes";
import "./quickreview.css";

interface PreparedCard {
  word: VocabWord;
  mode: "cloze" | "recognition";
  /** 完形句（en 一定包含 word.word，不包含则已降级为 recognition）。 */
  sentence?: string;
  sentenceZh?: string | null;
  sourceLabel: string;
}

const GRADES: ReviewGrade[] = ["forgot", "hard", "good", "easy"];

type Appearance = Pick<GlobalReaderSettingsShape, "theme" | "fontPair">;
type GlobalReaderSettingsShape = ReturnType<typeof loadGlobalReaderSettings>;

const DEFAULT_UI: UICardState = { hintLevel: 0, revealed: false, input: "", verdict: null };

export function QuickReviewApp() {
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "done">("loading");
  const [cards, setCards] = useState<PreparedCard[]>([]);
  const [pos, setPos] = useState(0);
  /** 每张卡各自的界面状态（输入/提示/翻面/判定），来回切卡互不影响。 */
  const [uis, setUis] = useState<UICardState[]>([]);
  /** 本次会话各卡已评的档；null = 还没评过。 */
  const [grades, setGrades] = useState<(ReviewGrade | null)[]>([]);
  const [streak, setStreak] = useState<number | null>(null);
  const [appearance, setAppearance] = useState<Appearance>({ theme: "light", fontPair: "serif" });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setAppearance(loadGlobalReaderSettings());
    // 识别卡的词条用衬线展示，与阅读室同源字体
    const id = "quickreview-webfonts";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600&family=Noto+Sans+SC:wght@400;500&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const file = await readerGetVocab();
        if (!active) return;
        const now = Date.now();
        const due = (file.words ?? [])
          .filter((w) => w.srs.dueAt <= now)
          .sort((a, b) => a.srs.dueAt - b.srs.dueAt);
        if (due.length === 0) {
          setStatus("empty");
          return;
        }
        const prepared = await prepareCards(due);
        if (!active) return;
        setCards(prepared);
        setUis(prepared.map(() => ({ ...DEFAULT_UI })));
        setGrades(prepared.map(() => null));
        setStatus("ready");
      } catch (error) {
        console.error("[quick-review] load failed", error);
        if (active) setStatus("empty");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // 每张完形卡渲染后聚焦输入框
    if (status === "ready" && cards[pos]?.mode === "cloze") inputRef.current?.focus();
  }, [status, pos, cards]);

  const card = cards[pos];
  const total = cards.length;
  const ui = uis[pos] ?? DEFAULT_UI;
  const setUi: SetUi = useCallback(
    (updater) => setUis((arr) => arr.map((s, i) => (i === pos ? updater(s ?? DEFAULT_UI) : s))),
    [pos],
  );

  /** 前后切卡；越界即停在首/尾。 */
  const go = useCallback(
    (delta: number) => setPos((p) => Math.min(total - 1, Math.max(0, p + delta))),
    [total],
  );

  const applyGrade = useCallback(
    (g: ReviewGrade) => {
      if (!card) return;
      const first = grades[pos] == null;
      setGrades((arr) => arr.map((x, i) => (i === pos ? g : x)));
      // 一律按进窗时的原 SRS 重算：改评不会把间隔叠加上一轮的结果
      const graded = { ...card.word, srs: gradeSrs(card.word.srs, g) };
      void readerSaveVocabWord(graded)
        .then(() => (first ? readerRecordReview(dayKey(), Date.now()) : null))
        .then((stats) => {
          if (stats) setStreak(stats.streak);
          trayRefreshBadge();
        })
        .catch((error) => console.error("[quick-review] save grade failed", error));
      // 首评才前进（尾卡评完即收工）；回看改评留在原地
      if (first) {
        if (pos + 1 >= total) {
          setStatus("done");
        } else {
          setPos(pos + 1);
        }
      }
    },
    [card, pos, total, grades],
  );

  // 键盘：←/→ 切卡（输入框内不劫持）；识别卡 Space 翻面；1–4 打分；Esc 收起
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        void getCurrentWindow().hide();
        return;
      }
      if (status !== "ready" || !card) return;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.isContentEditable === true;
      if (!typing && e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
        return;
      }
      if (!typing && e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
        return;
      }
      const gradedShown = card.mode === "recognition" ? ui.revealed : ui.verdict !== null;
      if (gradedShown && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        applyGrade(GRADES[Number(e.key) - 1]);
      } else if (!typing && card.mode === "recognition" && e.key === " ") {
        e.preventDefault();
        // Space 双向翻面：盖住释义可反复自测
        setUi((s) => ({ ...s, revealed: !s.revealed }));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, card, ui, applyGrade, go, setUi]);

  if (status === "loading") {
    return (
      <div className="qr-root" data-theme={appearance.theme}>
        <div className="qr-loading">正在读取生词本…</div>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div className="qr-root" data-theme={appearance.theme}>
        <TitleBar label="快速复习" />
        <div className="qr-center">
          <div className="qr-done-ring">✓</div>
          <h3>现在没有到期的生词</h3>
          <p className="qr-sub">到期了托盘图标会带数字提醒你；现在去阅读里攒几个新词吧。</p>
          <div className="qr-done-btns">
            <button className="qr-btn" onClick={() => void openReaderAndHide()}>
              打开阅读室
            </button>
            <button className="qr-btn primary" onClick={() => void getCurrentWindow().hide()}>
              完成
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "done") {
    const gradedCount = grades.filter((g) => g !== null).length;
    return (
      <div className="qr-root" data-theme={appearance.theme}>
        <TitleBar label="快速复习" progress={`${gradedCount} / ${total}`} />
        <div className="qr-dots" aria-hidden>
          {cards.map((_, i) => (
            <i key={i} className={grades[i] ? "done" : ""} />
          ))}
        </div>
        <div className="qr-center">
          <div className="qr-done-ring">✓</div>
          <h3>今天收工</h3>
          {streak !== null && (
            <p className="qr-streak">
              连续打卡 <b>{streak}</b> 天
            </p>
          )}
          <p className="qr-sub">
            {gradedCount >= total
              ? `这 ${total} 个词都往后推了一轮。明天到期时提醒会再来，也可以随时从托盘点开。`
              : `本次评了 ${gradedCount} / ${total} 个，没评的仍在到期队列，下次提醒会再来。`}
          </p>
          <div className="qr-done-btns">
            <button className="qr-btn" onClick={() => void openReaderAndHide()}>
              打开阅读室
            </button>
            <button className="qr-btn primary" onClick={() => void getCurrentWindow().hide()}>
              完成
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!card) return null;
  const graded = grades[pos] ?? null;
  const gradedShown = card.mode === "recognition" ? ui.revealed : ui.verdict !== null;

  return (
    <div className="qr-root" data-theme={appearance.theme}>
      <TitleBar label="快速复习" progress={`${pos + 1} / ${total}`} />
      <div className="qr-navrow">
        <button
          className="qr-nav"
          disabled={pos === 0}
          onClick={(e) => {
            // 点完即失焦：焦点留在按钮上时，Space 会误触按钮而不是翻面
            e.currentTarget.blur();
            go(-1);
          }}
          aria-label="上一张"
          title="上一张（←）"
        >
          ‹
        </button>
        <div className="qr-dots">
          {cards.map((_, i) => (
            <button
              key={i}
              className={grades[i] ? "done" : i === pos ? "now" : ""}
              onClick={(e) => {
                e.currentTarget.blur();
                setPos(i);
              }}
              aria-label={`第 ${i + 1} 张`}
              title={`第 ${i + 1} 张`}
            />
          ))}
        </div>
        <button
          className="qr-nav"
          disabled={pos >= total - 1}
          onClick={(e) => {
            e.currentTarget.blur();
            go(1);
          }}
          aria-label="下一张"
          title="下一张（→）"
        >
          ›
        </button>
      </div>

      <div className="qr-body">
        {card.mode === "cloze" ? (
          <ClozeCard card={card} ui={ui} setUi={setUi} inputRef={inputRef} />
        ) : (
          <RecognitionCard card={card} ui={ui} setUi={setUi} />
        )}
      </div>

      {graded && (
        <div className="qr-graded-note">
          已评分：{GRADE_LABELS[graded]} · {GRADE_INTERVALS[graded].label}后复习（可直接改评）
        </div>
      )}

      {gradedShown && (
        <div className="qr-grades">
          {GRADES.map((g) => {
            const suggested = card.mode === "recognition" ? ("good" as const) : ui.verdict ? verdictToSuggestedGrade(ui.verdict) : null;
            return (
              <button
                key={g}
                className={suggested === g ? "sug" : ""}
                onClick={() => applyGrade(g)}
              >
                {GRADE_LABELS[g]}
                <small>
                  {GRADE_INTERVALS[g].label}
                  {suggested === g ? " · 建议" : ""}
                </small>
              </button>
            );
          })}
        </div>
      )}

      <div className="qr-foot">
        {card.mode === "cloze" ? "Enter 提交" : "Space 翻面"} ·{" "}
        <span className="qr-kbd">1</span>–<span className="qr-kbd">4</span> 评分 ·{" "}
        <span className="qr-kbd">←</span>
        <span className="qr-kbd">→</span> 切卡 · Esc 收起，随时回到桌面
      </div>
    </div>
  );
}

// ---------- 子组件 ----------

interface UICardState {
  hintLevel: number;
  revealed: boolean;
  input: string;
  verdict: RecallVerdict | null;
}

type SetUi = (updater: (s: UICardState) => UICardState) => void;

const GRADE_LABELS: Record<ReviewGrade, string> = {
  forgot: "忘记",
  hard: "困难",
  good: "一般",
  easy: "简单",
};

function TitleBar({ label, progress }: { label: string; progress?: string }) {
  return (
    <div className="qr-titlebar" data-tauri-drag-region>
      <span className="qr-logo" aria-hidden>
        读
      </span>
      <span className="qr-title" data-tauri-drag-region>
        {label}
      </span>
      {progress && <span className="qr-prog">{progress}</span>}
      <button
        className="qr-x"
        onClick={() => void getCurrentWindow().hide()}
        title="收起（进度已保存）"
        aria-label="收起"
      >
        ✕
      </button>
    </div>
  );
}

function ClozeCard({
  card,
  ui,
  setUi,
  inputRef,
}: {
  card: PreparedCard;
  ui: UICardState;
  setUi: SetUi;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const word = card.word;
  const answer = word.word;
  const parts = useMemo(() => clozeParts(card.sentence ?? "", answer), [card.sentence, answer]);

  function submit() {
    if (ui.verdict !== null || !ui.input.trim()) return;
    setUi((s) => ({ ...s, verdict: judgeCloze(s.input, answer, { trap: word.trap }) }));
  }

  if (!parts) return null;
  return (
    <div>
      <span className="qr-chip">词块 · 完形</span>
      <div className="qr-sent">
        {parts.before}
        <span className={`qr-slot${ui.verdict === "perfect" || ui.verdict === "close" ? " ok" : ui.verdict ? " bad" : ""}`}>
          {ui.verdict === null ? (
            <input
              ref={inputRef}
              value={ui.input}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setUi((s) => ({ ...s, input: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              aria-label="填入词块"
            />
          ) : ui.verdict === "perfect" || ui.verdict === "close" ? (
            answer
          ) : (
            <>
              <s>{ui.input || "…"}</s> <b>{answer}</b>
            </>
          )}
        </span>
        {parts.after}
      </div>
      {ui.verdict === null ? (
        <div className="qr-hint-row">
          {ui.hintLevel === 0 ? (
            <a
              onClick={() => setUi((s) => ({ ...s, hintLevel: 1 }))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") setUi((s) => ({ ...s, hintLevel: 1 }));
              }}
            >
              想不起来？看提示
            </a>
          ) : (
            <div className="qr-hint-ladder">
              <span className="step">
                <b>① 释义</b>
                {word.senses[0]?.cn || "（无释义，凭语感试试）"}
              </span>
              {ui.hintLevel >= 2 && (
                <span className="step">
                  <b>② 槽位</b>
                  {word.pattern || `${answer.charAt(0)}…（${answer.split(/\s+/).length} 词）`}
                </span>
              )}
              {ui.hintLevel < 2 && (
                <a
                  onClick={() => setUi((s) => ({ ...s, hintLevel: 2 }))}
                  role="button"
                  tabIndex={0}
                >
                  再看一步
                </a>
              )}
            </div>
          )}
        </div>
      ) : (
        ui.verdict === "trap" &&
        word.trap && (
          <div className="qr-trap">
            <b>直译陷阱</b> · {word.trap}
          </div>
        )
      )}
      <div className="qr-src">{card.sourceLabel}</div>
    </div>
  );
}

function RecognitionCard({
  card,
  ui,
  setUi,
}: {
  card: PreparedCard;
  ui: UICardState;
  setUi: SetUi;
}) {
  const word = card.word;
  const [speakError, setSpeakError] = useState("");
  function speak() {
    void ttsSpeakAdvanced(word.word, false, { track: "word", target: "quick-review", rate: 1 }).catch(
      () => setSpeakError("发音不可用"),
    );
  }
  return (
    <div>
      <span className="qr-chip word">{word.kind === "chunk" ? "词块 · 识别" : "单词 · 识别"}</span>
      <div className="qr-word-face">
        <div className="qr-word serif">{word.word}</div>
        {word.phonetic && <div className="qr-phon">{word.phonetic}</div>}
        <button className="qr-say" onClick={speak} title="发音">
          ♪ {speakError && <small>{speakError}</small>}
        </button>
        <div className="qr-hint-row">
          <a
            onClick={() => setUi((s) => ({ ...s, revealed: !s.revealed }))}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") setUi((s) => ({ ...s, revealed: !s.revealed }));
            }}
          >
            {ui.revealed ? "盖住释义" : "显示释义"}
          </a>
        </div>
        {ui.revealed && (
          <div className="qr-senses">
            {word.senses.slice(0, 3).map((s, i) => (
              <div key={i}>
                <span className="pos">{s.pos}</span>
                {s.cn}
              </div>
            ))}
            {word.senses.length === 0 && <div>（无释义记录，凭印象评分即可）</div>}
          </div>
        )}
      </div>
      {ui.revealed && word.trap && <div className="qr-trap soft">{word.trap}</div>}
      <div className="qr-src">{card.sourceLabel}</div>
    </div>
  );
}

// ---------- 数据准备 ----------

/** 拉取完形句并组装卡片；句子缺失/不含目标词块时降级为识别形态。 */
async function prepareCards(due: VocabWord[]): Promise<PreparedCard[]> {
  const articleCache = new Map<string, Article | null>();
  const out: PreparedCard[] = [];
  for (const word of due) {
    const routed = routeRecallMode(word, "smart");
    let mode: PreparedCard["mode"] = routed === "cloze" ? "cloze" : "recognition";
    let sentence: string | undefined;
    let sentenceZh: string | null = null;
    let sourceLabel = "划词收藏";

    const articleId = word.source.articleId;
    if (articleId) {
      if (!articleCache.has(articleId)) {
        articleCache.set(articleId, await readerGetArticle(articleId).catch(() => null));
      }
      const article = articleCache.get(articleId) ?? null;
      const pair = article?.sentences[word.source.sentenceIdx];
      if (article && pair) {
        sentence = pair.en;
        sentenceZh = pair.zh;
        sourceLabel = `${article.title} · 第 ${word.source.sentenceIdx + 1} 句`;
      }
    } else if (word.example) {
      sentence = word.example.en;
      sentenceZh = word.example.zh;
      sourceLabel = "收藏时例句";
    }

    if (mode === "cloze") {
      const ok = !!sentence && clozeParts(sentence, word.word) !== null;
      if (!ok) mode = "recognition"; // 句子缺失或词块已改写：降级为识别
    }
    out.push({ word, mode, ...(sentence ? { sentence } : {}), sentenceZh, sourceLabel });
  }
  return out;
}

function clozeParts(sentence: string, answer: string): { before: string; after: string } | null {
  if (!sentence) return null;
  const i = sentence.toLowerCase().indexOf(answer.toLowerCase());
  if (i < 0) return null;
  return { before: sentence.slice(0, i), after: sentence.slice(i + answer.length) };
}

async function openReaderAndHide() {
  try {
    await invoke("open_reader");
  } catch (error) {
    console.error("[quick-review] open reader failed", error);
  }
  void getCurrentWindow().hide();
}
