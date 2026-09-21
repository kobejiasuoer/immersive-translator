/**
 * 笔记库（R3）：复习笔记的留存与阅读视图。
 *
 * 结构与书架/文章同构——左栏目录（按「今天 / 更早」分组），主区是渲染后的
 * 「一页纸」：本篇速览（朱批）、记忆诊断词条卡（批语 + 批改记号 + 下次怎么测）、
 * AI 复盘区（闭环链路 + 「阅」章）。视觉：纸张分层 + 双墨系统（靛蓝管版式、
 * 朱红管批语），样式见 reader.css 的「笔记库」段。
 *
 * 纯展示 + 交互转发：数据（列表/正文/解析）由 ReaderApp 加载，LLM 通道由
 * ReaderApp 的复盘处理器使用。
 */

import { useMemo, Fragment } from "react";
import { IconBookOpen } from "../ui/icons";
import type { ParsedCard, ParsedNote } from "../core/noteParser";
import { findWordByHeading, isStillWeak } from "../core/noteBuilder";
import type { NoteMeta, NoteReplay, RecallStat, VocabWord } from "../core/readerTypes";
import { TodayCard } from "./TodayCard";

interface Props {
  notes: NoteMeta[];
  activeId: string | null;
  /** 当前打开的笔记（ReaderApp 读取文件并解析后传入）。 */
  active: { meta: NoteMeta; parsed: ParsedNote } | null;
  words: VocabWord[];
  reviewedToday: number;
  streak: number;
  /** 全局到期生词数（「生词本复习」入口角标）。 */
  dueNow: number;
  /** 还没整理进任何笔记的生词数（生成按钮角标：该整理了）。 */
  newWords?: number;
  replayBusy: boolean;
  onSelect: (file: string) => void;
  onDelete: (file: string) => void;
  onOpenReader: () => void;
  /** 回生词本（普通到期队列）。 */
  onOpenReview: () => void;
  /** 只测某批词（笔记仍错词加练，无视到期时间）。 */
  onStartFocusReview: (wordIds: string[]) => void;
  onGenerate: () => void;
  /** 生成/刷新 AI 复盘（仅当复盘后又有新的复习记录时可用）。 */
  onGenerateReplay: (meta: NoteMeta) => void;
  /** 把仍错词滚进新笔记（打开生成弹窗并预选）。 */
  onRollIntoNote: (replay: NoteReplay) => void;
  onSpeakWord: (text: string) => void;
}

// ---------- 展示工具 ----------

const POS_LABELS: Record<string, string> = {
  "n.": "名词",
  "v.": "动词",
  "adj.": "形容词",
  "adv.": "副词",
  "prep.": "介词",
  "phr.": "短语",
};

function formatTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay =
    d.getFullYear() === new Date(now).getFullYear() &&
    d.getMonth() === new Date(now).getMonth() &&
    d.getDate() === new Date(now).getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function modeLabel(mode: string): string {
  return mode === "recognition" ? "识别" : mode === "cloze" ? "完形" : mode === "dictation" ? "听写" : mode;
}

function recallHits(recall: RecallStat | undefined): { hits: number; pass: number; total: number } {
  const total = recall ? recall.total.pass + recall.total.wrong + recall.total.trap : 0;
  const hits = recall ? recall.total.wrong + recall.total.trap : 0;
  return { hits, pass: total - hits, total };
}

/** 批改记号：✗（没想起/踩陷阱）在前，✓ 在后。 */
function ticksHtml(recall: RecallStat | undefined): { marks: { ok: boolean }[]; label: string } | null {
  const { hits, pass, total } = recallHits(recall);
  if (total === 0) return null;
  const marks = [
    ...Array.from({ length: hits }, () => ({ ok: false })),
    ...Array.from({ length: pass }, () => ({ ok: true })),
  ];
  const label = hits === 0 ? `连过 ${pass} 次` : hits === total ? "全错" : `${total} 次里错 ${hits}`;
  return { marks, label };
}

/** 判分轨迹行：识别 ✓✓ · 完形 ✗✗ · 最近一次错：9月16日 08:40 */
function recallTrace(recall: RecallStat | undefined): string | null {
  if (!recall) return null;
  const parts: string[] = [];
  for (const [mode, st] of Object.entries(recall.byMode)) {
    const bad = st.wrong + st.trap;
    const marks =
      "✗".repeat(Math.min(bad, 4)) + "✓".repeat(Math.min(st.pass, 4));
    if (marks) parts.push(`${modeLabel(mode)} ${marks}`);
  }
  if (recall.lastAt) parts.push(`最近一次：${formatTime(recall.lastAt)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** 仍错判定：与 ReaderApp 复盘选词同一口径（core/noteBuilder.isStillWeak）——
 * 从没测过，或 错+陷阱 > 过；词已从生词本删除则不计。 */
function isStillWeakNow(word: VocabWord | undefined): boolean {
  return word !== undefined && isStillWeak(word);
}

/** 一篇笔记当前仍错的词数（实时；词已从生词本删除则不计）。 */
function noteStillWeakCount(note: NoteMeta, wordById: Map<string, VocabWord>): number {
  if (!note.replay) return 0;
  return note.wordIds.filter((id) => isStillWeakNow(wordById.get(id))).length;
}

/** 复排行上的实时判定签：后来连对过的词翻绿，不再喊「狼来了」。 */
function weakChipOf(word: VocabWord | undefined): { chip: string; tone: "bad" | "fair" | "done" } {
  const trap = word?.recall?.total.trap ?? 0;
  const wrong = word?.recall?.total.wrong ?? 0;
  const pass = word?.recall?.total.pass ?? 0;
  const bad = trap + wrong;
  if (bad + pass > 0 && bad <= pass) return { chip: "已过 ✓", tone: "done" };
  if (trap > 0) return { chip: "踩陷阱", tone: "bad" };
  if (wrong >= 2) return { chip: "多次答错", tone: "bad" };
  return { chip: "仍在错", tone: "fair" };
}

/** 批注文本内联渲染：**加粗** → <b>，`code` 去记号；先转义再还原，防注入。 */
function renderInline(text: string): { __html: string } {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const rich = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "$1");
  return { __html: rich };
}

export function NotesView({
  notes,
  activeId,
  active,
  words,
  reviewedToday,
  streak,
  dueNow,
  newWords,
  replayBusy,
  onSelect,
  onDelete,
  onOpenReader,
  onOpenReview,
  onStartFocusReview,
  onGenerate,
  onGenerateReplay,
  onRollIntoNote,
  onSpeakWord,
}: Props) {
  const wordById = useMemo(() => new Map(words.map((w) => [w.id, w])), [words]);

  const today = notes.filter((n) => {
    const d = new Date(n.createdAt);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  });
  const earlier = notes.filter((n) => !today.includes(n));

  // 书架与主区一页纸必须是兄弟节点：aside 定宽 232px，notes-page 靠
  // reader-body 的横向 flex 占据其余空间；嵌进 aside 会被挤成一条竖条。
  return (
    <>
    <aside className="reader-shelf noteslist">
      <div className="reader-shelf-header">
        笔记库
        <span className="notes-count">{notes.length}</span>
      </div>
      <div className="reader-shelf-list">
        {notes.length === 0 && (
          <div className="reader-empty-shelf">
            笔记库还是空的。
            <br />
            在阅读里攒生词，随时能一键整理成复习笔记，自动存在这里。
          </div>
        )}
        {today.length > 0 && <div className="vlist-group">今天</div>}
        {today.map((n) => (
          <NoteItem
            key={n.file}
            note={n}
            active={n.file === activeId}
            weakLive={noteStillWeakCount(n, wordById)}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
        {earlier.length > 0 && <div className="vlist-group">更早</div>}
        {earlier.map((n) => (
          <NoteItem
            key={n.file}
            note={n}
            active={n.file === activeId}
            weakLive={noteStillWeakCount(n, wordById)}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
      <div className="reader-shelf-footer">
        <button className="notes-gen-btn" onClick={onGenerate}>
          ＋ 生成新笔记
          {newWords ? <span className="mini-badge">{newWords} 词未整理</span> : null}
        </button>
        <div
          className="reader-shelf-nav"
          onClick={onOpenReview}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenReview();
          }}
        >
          <IconBookOpen size={15} />
          生词本复习
          {dueNow > 0 && <span className="badge">{dueNow}</span>}
        </div>
        <div
          className="reader-shelf-nav"
          onClick={onOpenReader}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenReader();
          }}
        >
          <IconBookOpen size={15} />
          沉浸式阅读
        </div>
        <TodayCard
          reviewedToday={reviewedToday}
          dueNow={dueNow}
          streak={streak}
          emptyText="今日没有到期生词了。"
        />
      </div>
    </aside>
    <NotesSheet
      active={active}
      words={words}
      wordById={wordById}
      replayBusy={replayBusy}
      onGenerateReplay={onGenerateReplay}
      onRollIntoNote={onRollIntoNote}
      onOpenReview={onOpenReview}
      onStartFocusReview={onStartFocusReview}
      onSpeakWord={onSpeakWord}
    />
    </>
  );
}

function NoteItem({
  note,
  active,
  weakLive,
  onSelect,
  onDelete,
}: {
  note: NoteMeta;
  active: boolean;
  /** 实时仍错词数（note.replay 存在时有效）。 */
  weakLive: number;
  onSelect: (file: string) => void;
  onDelete: (file: string) => void;
}) {
  return (
    <div
      className={`notes-item${active ? " active" : ""}`}
      onClick={() => onSelect(note.file)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(note.file);
      }}
      title={note.file}
    >
      <span className="item-t">
        {formatTime(note.createdAt)}
        {note.partial && <span className="notes-flag">未完成</span>}
      </span>
      <span className="item-m">
        {note.words} 词条
        {note.replay && weakLive > 0 && <span className="notes-weak"> · {weakLive} 词仍错</span>}
        {note.replay && weakLive === 0 && <span className="notes-passed"> · 已全过 ✓</span>}
      </span>
      <button
        className="del"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(note.file);
        }}
        title="删除这篇笔记"
      >
        ✕
      </button>
    </div>
  );
}

// ---------- 主区：一页纸 ----------

function NotesSheet({
  active,
  words,
  wordById,
  replayBusy,
  onGenerateReplay,
  onRollIntoNote,
  onOpenReview,
  onStartFocusReview,
  onSpeakWord,
}: {
  active: { meta: NoteMeta; parsed: ParsedNote } | null;
  words: VocabWord[];
  wordById: Map<string, VocabWord>;
  replayBusy: boolean;
  onGenerateReplay: (meta: NoteMeta) => void;
  onRollIntoNote: (replay: NoteReplay) => void;
  onOpenReview: () => void;
  onStartFocusReview: (wordIds: string[]) => void;
  onSpeakWord: (text: string) => void;
}) {
  if (!active) {
    return (
      <div className="notes-page">
        <div className="notes-sheet notes-sheet-empty">
          <div className="notes-empty">
            <div className="notes-empty-icon">📓</div>
            <div className="notes-empty-t">笔记库还是空的</div>
            <div className="notes-empty-d">
              在阅读里查词、点词块，选「加入生词本」——
              <br />
              攒下的词和你的错题记录，会一起整理成复习笔记，自动存在这里。
            </div>
            <button className="notes-gen-btn" onClick={onOpenReview}>
              去生词本攒词
            </button>
          </div>
        </div>
      </div>
    );
  }
  const { meta, parsed } = active;
  const date = formatTime(meta.createdAt);
  const title = date.startsWith("今天")
    ? "今天整理的复习笔记"
    : `${date.split(" ")[0]}整理的复习笔记`;
  // 单词 = kind 不是 chunk（含老数据 kind 缺省与已删词）；词块 = kind === chunk。
  // 之前用 kind === undefined 判单词，而入库词条都显式写了 kind，导致单词恒为 0、
  // 已删除的词反被计成单词。
  const wordCount = (kind: "word" | "chunk") =>
    meta.wordIds.filter((id) =>
      kind === "chunk" ? wordById.get(id)?.kind === "chunk" : wordById.get(id)?.kind !== "chunk",
    ).length;

  return (
    <div className="notes-page">
      <div className="notes-sheet">
        <div className="notes-head">
          <div className="notes-date">{title}</div>
          {meta.partial && <div className="notes-partial-tag">生成被取消 · 此为已完成部分</div>}
        </div>
        <div className="notes-meta">
          {date} · {meta.words} 词条（单词 {wordCount("word")} · 词块 {wordCount("chunk")}） ·{" "}
          <span className="notes-saved">已自动保存</span>
        </div>
        <div className="notes-head-rule" />

        {parsed.glance.length > 0 && (
          <>
            <div className="notes-sec">先看这里</div>
            <div className="notes-glance">
              {parsed.glance.map((g, i) => (
                <div key={i} className="notes-glance-item" dangerouslySetInnerHTML={renderInline(g)} />
              ))}
            </div>
          </>
        )}

        {parsed.sections.map((sec) => (
          <div key={sec.title}>
            <div className="notes-sec">{sec.title}</div>
            {sec.cards.map((card, i) => (
              <EntryCard
                key={`${sec.title}-${card.word}-${i}`}
                card={card}
                word={findWord(words, card.word)}
                onSpeakWord={onSpeakWord}
              />
            ))}
          </div>
        ))}

        <ReplayArea
          meta={meta}
          wordById={wordById}
          busy={replayBusy}
          onGenerateReplay={onGenerateReplay}
          onRollIntoNote={onRollIntoNote}
          onStartFocusReview={onStartFocusReview}
        />
      </div>
    </div>
  );
}

/** md 词头 → 生词数据（宽容匹配，与 verifyNoteWords 同思路）。 */
function findWord(words: VocabWord[], headword: string): VocabWord | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\u4e00-\u9fff]+/g, " ").trim();
  const target = norm(headword);
  return (
    words.find((w) => norm(w.word) === target) ??
    words.find((w) => norm(w.word).includes(target) || target.includes(norm(w.word)))
  );
}

function EntryCard({
  card,
  word,
  onSpeakWord,
}: {
  card: ParsedCard;
  word: VocabWord | undefined;
  onSpeakWord: (text: string) => void;
}) {
  const ticks = ticksHtml(word?.recall);
  const trace = recallTrace(word?.recall);
  const pos =
    word?.kind === "chunk"
      ? "词块"
      : POS_LABELS[card.senses.find((s) => s.pos)?.pos ?? ""] ??
        card.senses.find((s) => s.pos)?.pos?.replace(/\.$/, "") ??
        "词条";
  // 无批语时用数据兜底一条（宁短勿编）。
  const diagnose = card.diagnose ?? {
    ok: (word?.recall?.total.wrong ?? 0) + (word?.recall?.total.trap ?? 0) === 0,
    text: word?.recall
      ? "复习过但本篇没有诊断结论——先过一遍下面的记法。"
      : "还没有复习记录，首次测试安排在到期日。",
  };
  return (
    <article className="notes-entry">
      <div className="notes-entry-hd">
        {word ? (
          <button
            className="notes-word"
            onClick={() => onSpeakWord(word.word)}
            title="朗读"
          >
            {card.word}
          </button>
        ) : (
          <span className="notes-word" style={{ cursor: "default" }}>
            {card.word}
          </span>
        )}
        {word?.phonetic && <span className="notes-phon">{word.phonetic}</span>}
        <span className="notes-pos">{pos}</span>
        {ticks && (
          <span className="notes-ticks" title="批改记号：✗ 没想起/踩陷阱，✓ 通过">
            {ticks.marks.map((m, i) => (
              <i key={i} className={m.ok ? "tk pass" : "tk hit"}>
                {m.ok ? "✓" : "✗"}
              </i>
            ))}
            <span className="notes-ticks-label">{ticks.label}</span>
          </span>
        )}
      </div>

      <div className={`notes-remark${diagnose.ok ? " ok" : ""}`}>
        <span className="rk">{diagnose.ok ? "批 · 为什么记住了" : "批 · 为什么记不住"}</span>
        <span dangerouslySetInnerHTML={renderInline(diagnose.text)} />
        {trace && <div className="notes-trace">{trace}</div>}
      </div>

      {card.senses.length > 0 && (
        <div className="notes-cn">
          {card.senses.map((s, i) => (
            <span key={i}>
              {s.pos && <span className="cn-tag">{s.pos}</span>}
              {s.text}
              {i < card.senses.length - 1 ? "；" : ""}
            </span>
          ))}
        </div>
      )}

      {card.anchor && (
        <div className="notes-anchor">
          <span className="rk">记</span>
          <span dangerouslySetInnerHTML={renderInline(card.anchor)} />
        </div>
      )}

      {card.example && (
        <div className="notes-example">
          <div className="en">{card.example}</div>
          {word && word.source.articleId && (
            <div className="from">出自收藏 · 复习时作为出语境</div>
          )}
        </div>
      )}

      {card.collos.length > 0 && (
        <div className="notes-collos">
          {card.collos.map((c, i) => (
            <div key={i} className="collo">
              <span className="k">{c.k}</span>
              <span className="en">{c.en}</span>
              <span className="zh">{c.zh}</span>
            </div>
          ))}
        </div>
      )}

      {card.nextTest && (
        <div className="notes-next-test">
          <span className="tag">下次怎么测</span>
          <span className="mode">{card.nextTest.mode}</span>
          <span dangerouslySetInnerHTML={renderInline(card.nextTest.tip)} />
        </div>
      )}
    </article>
  );
}

// ---------- AI 复盘 ----------

function ReplayArea({
  meta,
  wordById,
  busy,
  onGenerateReplay,
  onRollIntoNote,
  onStartFocusReview,
}: {
  meta: NoteMeta;
  wordById: Map<string, VocabWord>;
  busy: boolean;
  onGenerateReplay: (meta: NoteMeta) => void;
  onRollIntoNote: (replay: NoteReplay) => void;
  onStartFocusReview: (wordIds: string[]) => void;
}) {
  const noteWords = meta.wordIds.map((id) => wordById.get(id));
  // 复盘后又产生了新的复习记录 → 可以再复盘。
  const hasNewData = noteWords.some(
    (w) => w?.recall?.lastAt !== undefined && w.recall.lastAt > meta.updatedAt,
  );
  // 实时仍错词（从没测过 或 错+陷阱 > 过）：加练队列只排这些。
  const stillWeakIds = meta.wordIds.filter((id) => isStillWeakNow(wordById.get(id)));
  const replay = meta.replay;
  return (
    <div className="notes-replay">
      <div className="notes-replay-hd">
        <span className="t">AI 复盘</span>
        {replay ? (
          <>
            <span className="sub">
              生成后复习 {replay.rounds} 轮 · 最近一次 {formatTime(replay.lastAt)}
            </span>
            <span className="chip">
              {replay.passed} 词已过 · {replay.stillWeak} 仍错
              {replay.stillWeak > 0 && stillWeakIds.length === 0 ? " · 现在全过了" : ""}
              {stillWeakIds.length > 0 && stillWeakIds.length !== replay.stillWeak
                ? ` · 现在 ${stillWeakIds.length} 词仍错`
                : ""}
            </span>
          </>
        ) : (
          <span className="sub">这篇笔记还没有复盘记录</span>
        )}
      </div>
      <div className="notes-replay-bd">
        <div className="notes-loop">{loopSteps(replay ? 7 : 4)}</div>
        {replay ? (
          <>
            <div className="notes-verdict">
              {replay.verdict}
              <span className="notes-seal" aria-hidden>
                阅
              </span>
            </div>
            {replay.weak.length > 0 && (
              <div className="notes-weak-list">
                {replay.weak.map((wk, i) => {
                  // 宽容归一化回挂（与复盘生成/滚进新笔记同口径），
                  // LLM 改过大小写的词头也能找到词条算实时着色。
                  const w = findWordByHeading(
                    wk.w,
                    noteWords.filter((x): x is VocabWord => x !== undefined),
                  );
                  const chip = weakChipOf(w);
                  return (
                    <div key={i} className="notes-weak-row">
                      <span className="w">{wk.w}</span>
                      <span className="why">{wk.why}</span>
                      <span className={`verdict-chip${chip.tone !== "bad" ? ` ${chip.tone}` : ""}`}>
                        {chip.chip}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="notes-replay-ft">
              <span className="hint">仍错的词可以滚进下一篇笔记（默认勾选）。</span>
              {hasNewData && (
                <button className="btn btn-secondary" disabled={busy} onClick={() => onGenerateReplay(meta)}>
                  {busy ? "复盘中…" : "重新复盘"}
                </button>
              )}
              <button
                className="btn btn-secondary"
                disabled={busy || stillWeakIds.length === 0}
                title="只排这篇笔记仍错的词，不用等到期"
                onClick={() => onStartFocusReview(stillWeakIds)}
              >
                只测仍错的词{stillWeakIds.length > 0 ? `（${stillWeakIds.length}）` : ""}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || stillWeakIds.length === 0}
                onClick={() => onRollIntoNote(replay)}
              >
                把仍错词滚进新笔记
              </button>
            </div>
          </>
        ) : (
          <div className="notes-replay-ft">
            <span className="hint">
              复习一轮后回来，这里会出现：哪些词过了、哪些还在错、下一步测什么。
            </span>
            {hasNewData && (
              <button className="btn btn-primary" disabled={busy} onClick={() => onGenerateReplay(meta)}>
                {busy ? "复盘中…" : "生成复盘"}
              </button>
            )}
            <button
              className={hasNewData ? "btn btn-secondary" : "btn btn-primary"}
              disabled={stillWeakIds.length === 0}
              onClick={() => onStartFocusReview(stillWeakIds)}
            >
              开始复习
              {!hasNewData && stillWeakIds.length > 0 && stillWeakIds.length < meta.wordIds.length
                ? `（只测仍错的 ${stillWeakIds.length} 个）`
                : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 闭环链路：now = 当前推进到的环节（索引）。 */
function loopSteps(now: number) {
  const steps = [
    { i: "📖", t: "阅读发现" },
    { i: "✎", t: "自动记录" },
    { i: "🔍", t: "AI 诊断" },
    { i: "📝", t: "复习笔记" },
    { i: "⏱", t: "间隔复习" },
    { i: "✓", t: "再测" },
    { i: "♻", t: "更新薄弱点" },
  ];
  return steps.map((s, idx) => (
    <Fragment key={s.t}>
      <span className={`notes-loop-step${idx < now ? " done" : idx === now ? " now" : ""}`}>
        <span className="i">{s.i}</span>
        {s.t}
      </span>
      {idx < steps.length - 1 && <span className="notes-loop-arrow">›</span>}
    </Fragment>
  ));
}
