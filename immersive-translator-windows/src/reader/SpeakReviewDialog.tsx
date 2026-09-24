/**
 * 口语复盘弹层：跟读弱词 → 用户确认 → 查词典补释义 → 批量合并进生词本。
 *
 * 候选来自 extractSpeakVocab（纯规则，无模型参与）；词典释义在展开行或
 * 保存时按需查询（一次一词，失败降级为裸词保存，不阻塞）。已在生词本的
 * 词不可勾选，只展示「已在生词本 / 唤醒」；保存走 reader_merge_vocab_words
 * 批量合并（新词追加、旧词保留 SRS），唤醒词随后提到今日复习队列最前。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildReaderDictPrompt,
  parseReaderDictResponse,
  type ReaderDictEntry,
} from "../core/readerDict";
import {
  extractSpeakVocab,
  speakCandidateToVocab,
  type SpeakVocabCandidate,
} from "../core/speakVocab";
import type { SpeakSession } from "../core/speakLogic";
import type { VocabWord } from "../core/readerTypes";
import { readerMergeVocabWords, readerSaveVocabWord } from "../lib/readerStore";
import { loadSettingsAsync, hasValidSettings, type AppSettings } from "../lib/settingsStore";
import { resolveTargetLanguage } from "../core/languageDetect";
import type { NoteTranslateFn } from "./VocabNoteDialog";

interface Props {
  session: SpeakSession;
  vocabWords: VocabWord[];
  requestTranslate: NoteTranslateFn;
  onSpeakWord: (word: string) => void;
  onToast: (msg: string) => void;
  /** 合并成功（父组件刷新生词本；ids 为本次新追加的词）。 */
  onSaved: (addedIds: string[]) => void | Promise<void>;
  /** 成功视图「生成复习笔记」：父组件带预选 ids 打开笔记生成。 */
  onGenerateNote: (ids: string[]) => void;
  /** 成功视图「去复习」。 */
  onGoReview: () => void;
  onClose: () => void;
}

type Phase = "pick" | "saving" | "done" | "empty";

interface EntryState {
  status: "loading" | "ready" | "failed";
  entry?: ReaderDictEntry;
}

const DAY_MS = 86_400_000;

export function SpeakReviewDialog({
  session,
  vocabWords,
  requestTranslate,
  onSpeakWord,
  onToast,
  onSaved,
  onGenerateNote,
  onGoReview,
  onClose,
}: Props) {
  const extraction = useMemo(
    () => extractSpeakVocab(session, vocabWords),
    [session, vocabWords],
  );
  const allCandidates = useMemo(
    () => [...extraction.candidates, ...extraction.folded],
    [extraction],
  );

  const [phase, setPhase] = useState<Phase>(() =>
    allCandidates.length === 0 ? "empty" : "pick",
  );
  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const c of allCandidates) if (c.defaultChecked && !c.existing) init.add(c.id);
    return init;
  });
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [entries, setEntries] = useState<Record<string, EntryState>>({});
  const [foldOpen, setFoldOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [doneInfo, setDoneInfo] = useState<{
    addedWords: string[];
    addedIds: string[];
    wakeCount: number;
    mergedCount: number;
  } | null>(null);

  const entryPromisesRef = useRef(new Map<string, Promise<ReaderDictEntry | null>>());
  const settingsRef = useRef<AppSettings | null>(null);
  const seqRef = useRef(0);

  const rounds = Math.max(1, Math.ceil(session.turns.length / 2));
  const attemptCount = session.turns.reduce(
    (n, t) => n + (t.shadowAttempts?.length ?? 0),
    0,
  );

  // Esc 关闭（保存中不关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "saving") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  /** 查一个词的词典释义（去重并发；失败返回 null，不阻塞保存）。 */
  const fetchEntry = useCallback(
    (c: SpeakVocabCandidate): Promise<ReaderDictEntry | null> => {
      const inflight = entryPromisesRef.current.get(c.id);
      if (inflight) return inflight;
      setEntries((prev) =>
        prev[c.id]?.status === "loading" ? prev : { ...prev, [c.id]: { status: "loading" } },
      );
      const p = (async () => {
        try {
          if (!settingsRef.current) {
            settingsRef.current = await loadSettingsAsync().catch(() => null);
          }
          const s = settingsRef.current;
          if (!s || !hasValidSettings(s)) return null;
          const target = resolveTargetLanguage(c.word, {
            mode: s.translationMode,
            fixed: s.fixedTarget,
          });
          const res = await requestTranslate(
            c.word,
            buildReaderDictPrompt({
              targetLanguage: target,
              customStyle: "",
              glossaryText: s.glossaryText,
            }),
            `svd${++seqRef.current}`,
          );
          if (res.status !== "done") return null;
          const parsed = parseReaderDictResponse(res.text);
          return parsed.kind === "entry" ? parsed.entry : null;
        } catch {
          return null;
        }
      })();
      entryPromisesRef.current.set(c.id, p);
      void p.then((entry) =>
        setEntries((prev) => ({
          ...prev,
          [c.id]: { status: entry ? "ready" : "failed", ...(entry ? { entry } : {}) },
        })),
      );
      return p;
    },
    [requestTranslate],
  );

  const toggleRow = useCallback(
    (c: SpeakVocabCandidate) => {
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (next.has(c.id)) {
          next.delete(c.id);
        } else {
          next.add(c.id);
          if (!c.existing) void fetchEntry(c);
        }
        return next;
      });
    },
    [fetchEntry],
  );

  const toggleCheck = useCallback((c: SpeakVocabCandidate) => {
    if (c.existing) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const chosen = allCandidates.filter((c) => selected.has(c.id) && !c.existing);
    if (chosen.length === 0) return;
    setPhase("saving");
    setSaveError("");
    try {
      // 释义没查的这里补齐（并查；失败的按裸词保存，不阻塞）
      const words = await Promise.all(
        chosen.map(async (c) => speakCandidateToVocab(c, await fetchEntry(c))),
      );
      const result = await readerMergeVocabWords(words);
      // R9：唤醒的旧词提到今日复习队列最前（其余 SRS 字段原样保留）
      const wakes = allCandidates.filter((c) => c.wake && c.existing);
      await Promise.all(
        wakes.map((c) => {
          const w = c.existing!;
          return readerSaveVocabWord({ ...w, srs: { ...w.srs, dueAt: Date.now() } }).catch(
            () => undefined,
          );
        }),
      );
      setDoneInfo({
        addedWords: words.filter((w) => result.added.includes(w.id)).map((w) => w.word),
        addedIds: result.added,
        wakeCount: wakes.length,
        mergedCount: result.merged.length,
      });
      await onSaved(result.added);
      onToast(`已加入 ${result.added.length} 个词（生词本）`);
      setPhase("done");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setPhase("pick");
    }
  }, [allCandidates, selected, fetchEntry, onSaved, onToast]);

  const selectedCount = selected.size;
  const foldedCount = extraction.folded.length;

  // ---- 各视图 ----

  if (phase === "empty") {
    return (
      <div className="sv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sv-dialog" role="dialog" aria-modal="true" aria-label="本轮复盘">
          <DialogHead rounds={rounds} attemptCount={attemptCount} onClose={onClose} />
          <div className="sv-empty">
            <span className="emoji">🎉</span>
            <span className="h">这轮没有明显拖后腿的词</span>
            <span className="p">
              所有跟读词得分 ≥ 4.0，也没有漏读。保持这个状态，去下一轮吧！
            </span>
          </div>
          <div className="sv-foot">
            <span className="note" />
            <button className="btn btn-primary" onClick={onClose}>
              继续练习
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "done" && doneInfo) {
    return (
      <div className="sv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sv-dialog" role="dialog" aria-modal="true" aria-label="复盘完成">
          <div className="sv-done">
            <span className="ok-circle">✓</span>
            <span className="h">已加入 {doneInfo.addedWords.length} 个词</span>
            <span className="p">已排入复习计划 · 今天就可以复习（SRS）</span>
            <div className="chips">
              {doneInfo.addedWords.map((w) => (
                <span key={w} className="chip">
                  {w}
                  <i className="srs">今日</i>
                </span>
              ))}
            </div>
            {(doneInfo.wakeCount > 0 || doneInfo.mergedCount > 0) && (
              <span className="dup-line">
                {[
                  doneInfo.mergedCount > 0
                    ? `${doneInfo.mergedCount} 个词已在生词本 · 保留进度仅补例句`
                    : "",
                  doneInfo.wakeCount > 0
                    ? `已把 ${doneInfo.wakeCount} 个已收藏的弱词提到今天复习队列最前`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            <div className="actions">
              <button
                className="btn btn-secondary"
                disabled={doneInfo.addedIds.length === 0}
                onClick={() => onGenerateNote(doneInfo.addedIds)}
              >
                📄 生成复习笔记
              </button>
              <button className="btn btn-primary" onClick={onGoReview}>
                ▶ 去复习
              </button>
              <button className="btn btn-ghost" onClick={onClose}>
                继续练习
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && phase !== "saving" && onClose()}>
      <div className="sv-dialog" role="dialog" aria-modal="true" aria-label="本轮复盘">
        <DialogHead
          rounds={rounds}
          attemptCount={attemptCount}
          found={allCandidates.length}
          folded={foldedCount}
          onClose={onClose}
        />
        <div className="sv-rule">
          <b>候选规则</b>：最新一次词分 &lt; 3.5，或有漏读 / 替换（功能词不收）· 最新 ≥ 4.0
          视为已攻克 · 临界与纯漏读 1 次的词默认不勾，由你决定
        </div>

        <div className="sv-list">
          {extraction.candidates.map((c) => (
            <Row
              key={c.id}
              c={c}
              open={openIds.has(c.id)}
              entry={entries[c.id]}
              checked={selected.has(c.id)}
              onToggle={toggleRow}
              onCheck={toggleCheck}
              onSpeakWord={onSpeakWord}
            />
          ))}
          {foldedCount > 0 && (
            <div className="sv-fold">
              <button
                className="sv-fold-btn"
                onClick={() => setFoldOpen((v) => !v)}
              >
                另有 {foldedCount} 个较弱的词 ·{" "}
                {extraction.folded.map((c) => c.word).join("、")}{" "}
                <span className="chev">{foldOpen ? "▴" : "▾"}</span>
              </button>
              {foldOpen &&
                extraction.folded.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    open={openIds.has(c.id)}
                    entry={entries[c.id]}
                    checked={selected.has(c.id)}
                    onToggle={toggleRow}
                    onCheck={toggleCheck}
                    onSpeakWord={onSpeakWord}
                  />
                ))}
            </div>
          )}
        </div>

        <div className="sv-foot">
          <span className="note">
            {saveError ? (
              <b className="sv-err">保存失败：{saveError}</b>
            ) : (
              <>
                已选 <b>{selectedCount}</b> 个 · 保存时自动查词典补齐释义
              </>
            )}
          </span>
          <button className="btn btn-secondary" disabled={phase === "saving"} onClick={onClose}>
            稍后处理
          </button>
          <button
            className="btn btn-primary"
            disabled={selectedCount === 0 || phase === "saving"}
            onClick={() => void save()}
          >
            {phase === "saving" ? "⟳ 正在合并保存…" : `✓ 加入生词本（${selectedCount}）`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 子组件 ----------

function DialogHead({
  rounds,
  attemptCount,
  found,
  folded,
  onClose,
}: {
  rounds: number;
  attemptCount: number;
  found?: number;
  folded?: number;
  onClose: () => void;
}) {
  return (
    <div className="sv-head">
      <div>
        <div className="t">本轮复盘</div>
        <div className="sub">
          练了 {rounds} 轮 · 跟读了 {attemptCount} 句
          {found !== undefined && found > 0 ? (
            <>
              {" "}
              · 发现 <b>{found + (folded ?? 0)}</b> 个需要加强的词
              {folded ? `（已折叠 ${folded} 个）` : ""}
            </>
          ) : null}
        </div>
      </div>
      <button className="sv-close" onClick={onClose} title="关闭 (Esc)">
        ✕
      </button>
    </div>
  );
}

function Row({
  c,
  open,
  entry,
  checked,
  onToggle,
  onCheck,
  onSpeakWord,
}: {
  c: SpeakVocabCandidate;
  open: boolean;
  entry?: EntryState;
  checked: boolean;
  onToggle: (c: SpeakVocabCandidate) => void;
  onCheck: (c: SpeakVocabCandidate) => void;
  onSpeakWord: (word: string) => void;
}) {
  return (
    <div
      className={`sv-row${c.existing ? " is-dup" : ""}${open ? " open" : ""}`}
      onClick={() => onToggle(c)}
    >
      <label className="sv-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!!c.existing}
          onChange={() => onCheck(c)}
        />
        <i />
      </label>
      <div className="sv-main">
        <div className="line1">
          <span className="w">{c.word}</span>
          {entry?.entry?.phonetic && <span className="ipa">{entry.entry.phonetic}</span>}
          <CandidateTags c={c} />
        </div>
        {open ? (
          <RowDetail c={c} entry={entry} />
        ) : (
          <div className="gloss">{glossOf(entry)}</div>
        )}
      </div>
      <div className="side">
        <button
          className="sv-spk"
          title="听发音"
          onClick={(e) => {
            e.stopPropagation();
            onSpeakWord(c.word);
          }}
        >
          🔊
        </button>
        <span className="chev">▾</span>
      </div>
    </div>
  );
}

function CandidateTags({ c }: { c: SpeakVocabCandidate }) {
  const tags: React.ReactNode[] = [];
  if (c.latestScore !== null) {
    const cls = c.latestScore < 3.5 ? "low" : "warn";
    tags.push(
      <span key="score" className={`sv-tag ${cls}`}>
        最新 {c.latestScore.toFixed(1)} / 5
      </span>,
    );
  }
  if (c.reasons.includes("missed")) {
    const label =
      c.latestScore === null && c.missedCount >= 2 ? `漏读 ${c.missedCount} 次` : "漏读";
    tags.push(
      <span key="missed" className="sv-tag low">
        {label}
      </span>,
    );
  }
  if (c.reasons.includes("substituted")) {
    tags.push(
      <span key="sub" className="sv-tag low">
        替换
      </span>,
    );
  }
  if (c.latestScore !== null && c.latestScore >= 3.5) {
    tags.push(
      <span key="edge" className="sv-tag warn">
        临界
      </span>,
    );
  }
  if (c.existing) {
    const days = Math.max(1, Math.floor((Date.now() - c.existing.addedAt) / DAY_MS));
    const wrong = c.existing.recall?.total.wrong ?? 0;
    tags.push(
      c.wake ? (
        <span key="wake" className="sv-badge wake">
          已收藏 {days} 天 · {wrong >= 1 ? `复习 ${wrong} 次未过` : "已到期该复习了"}
        </span>
      ) : (
        <span key="dup" className="sv-badge dup">
          ✓ 已在生词本
        </span>
      ),
    );
  }
  return <>{tags}</>;
}

function glossOf(entry?: EntryState): string {
  if (!entry) return "";
  if (entry.status === "loading") return "查询词典中…";
  if (entry.status === "failed") return "释义获取失败（保存时按裸词收藏）";
  const senses = entry.entry?.senses ?? [];
  return senses.slice(0, 2).map((s) => `${s.pos} ${s.cn}`.trim()).join("；");
}

function RowDetail({
  c,
  entry,
}: {
  c: SpeakVocabCandidate;
  entry?: EntryState;
}) {
  return (
    <div className="sv-detail">
      <span className="lab">本轮原句</span>
      <div className="ex-en">“{c.example.en}”</div>
      {c.example.zh && <div className="ex-zh">{c.example.zh}</div>}
      {entry?.status === "loading" && <div className="sense-line">查询词典中…</div>}
      {entry?.status === "ready" && entry.entry && (
        <div className="sense-line">
          {entry.entry.senses
            .slice(0, 4)
            .map((s) => `${s.pos} ${s.cn}`.trim())
            .join("　")}
          {entry.entry.collocations && entry.entry.collocations.length > 0 && (
            <>　·　常搭配：{entry.entry.collocations[0].en}</>
          )}
        </div>
      )}
      {entry?.status === "failed" && (
        <div className="sense-line">释义没查到——不影响收藏，复习卡会用原句语境。</div>
      )}
      {c.existing && (
        <div className="dup-note">
          <b>✓ 不重复添加</b> · 保留你已有的 SRS 复习进度，这句口语原句仅作补充例句
          {c.wake ? "；已把它提到今天的复习队列最前" : ""}。
        </div>
      )}
    </div>
  );
}
