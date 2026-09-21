/**
 * 左栏 · 生词本词表（复习态）。
 *
 * 与书架同一列壳（232px、同页脚槽位），但内容随视图切换：
 * 进入生词本后这一列就是词表本身——到期队列带序号（与卡片 1/N 对应，可点跳卡），
 * 其余词按到期时间排列，只读展示下次见面时间。页脚槽位换成「沉浸式阅读」回程入口，
 * 并带上口语/笔记库入口（四个房间在任何左栏都可见，不要求先回书架）。
 *
 * 生词本定位是「复习笔记」的原料库：传入 requestTranslate（ReaderApp 的流式
 * 翻译通道）时展示「生成复习笔记」入口，缺省（预览页/单测）不展示。
 * 加练模式（focusCount>0）：队列只含某篇笔记的仍错词，横幅提示并给退出口。
 */

import { useState } from "react";
import { IconBookOpen, IconMic, IconNotebook } from "../ui/icons";
import type { NoteMeta, VocabWord } from "../core/readerTypes";
import { VocabNoteDialog, type NoteTranslateFn } from "./VocabNoteDialog";
import { TodayCard } from "./TodayCard";

interface Props {
  words: VocabWord[];
  /** 到期队列（ReaderApp 统一计算，与 ReviewView 共用，保证序号一致）。 */
  due: VocabWord[];
  /** 当前卡片在队列中的位置。 */
  pos: number;
  reviewedToday: number;
  streak: number;
  /** 加练模式：队列只含笔记仍错词时的剩余数量（0/缺省 = 正常到期队列）。 */
  focusCount?: number;
  /** 退出加练，回到全局到期队列。 */
  onExitFocus?: () => void;
  /** 还没整理进任何笔记的生词数（生成按钮角标）。 */
  newWords?: number;
  onJumpToCard: (i: number) => void;
  onOpenReader: () => void;
  onOpenSpeak?: () => void;
  onOpenNotes?: () => void;
  /** 复习笔记生成通道；缺省不渲染生成入口（预览页/单测）。 */
  requestTranslate?: NoteTranslateFn;
  /** 笔记入库成功 →「在笔记库打开」（ReaderApp 切视图）。 */
  onNoteSaved?: (meta: NoteMeta) => void;
}

/** 下次见面时间：10分钟后 / 5小时后 / 3天后 / 超过一个月给日期。 */
function nextDueLabel(dueAt: number, now = Date.now()): string {
  const min = Math.round((dueAt - now) / 60000);
  if (min < 60) return `${Math.max(1, min)}分钟后`;
  if (min < 24 * 60) return `${Math.round(min / 60)}小时后`;
  const day = Math.round(min / (24 * 60));
  if (day < 30) return `${day}天后`;
  return new Date(dueAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function VocabListPanel({
  words,
  due,
  pos,
  reviewedToday,
  streak,
  focusCount,
  onExitFocus,
  newWords,
  onJumpToCard,
  onOpenReader,
  onOpenSpeak,
  onOpenNotes,
  requestTranslate,
  onNoteSaved,
}: Props) {
  const [noteOpen, setNoteOpen] = useState(false);
  const focusing = (focusCount ?? 0) > 0;
  const dueIds = new Set(due.map((w) => w.id));
  const later = words.filter((w) => !dueIds.has(w.id)).sort((a, b) => a.srs.dueAt - b.srs.dueAt);

  return (
    <aside className="reader-shelf vlist">
      <div className="reader-shelf-header">
        生词本
        <span className="vlist-total">{words.length}</span>
      </div>
      {focusing && (
        <div className="focus-banner">
          <span className="t">加练 · 只测笔记仍错词（剩 {focusCount}）</span>
          {onExitFocus && (
            <button onClick={onExitFocus} title="回到全部到期队列">
              退出
            </button>
          )}
        </div>
      )}
      <div className="reader-shelf-list">
        {words.length === 0 && (
          <div className="reader-empty-shelf">
            还没有生词。
            <br />
            在阅读里查词或点词块，选「加入生词本」——攒下的词随时能一键整理成复习笔记。
          </div>
        )}
        {due.length > 0 && <div className="vlist-group">{focusing ? "加练队列" : "待复习"} · {due.length}</div>}
        {due.map((w, i) => (
          <div
            key={w.id}
            className={`reader-shelf-item vlist-due${i === pos ? " active" : ""}`}
            onClick={() => onJumpToCard(i)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onJumpToCard(i);
            }}
            title={i === pos ? "当前卡片" : `跳到第 ${i + 1} 张`}
          >
            <span className="q-idx">{i + 1}</span>
            <span className="t">{w.word}</span>
            {w.kind === "chunk" && <span className="q-kind">块</span>}
          </div>
        ))}
        {!focusing && later.length > 0 && <div className="vlist-group">稍后再来 · {later.length}</div>}
        {!focusing &&
          later.map((w) => (
            <div key={w.id} className="reader-shelf-item vlist-later" title="还没到期">
              <span className="t">{w.word}</span>
              <span className="dots" aria-hidden />
              <span className="when">{nextDueLabel(w.srs.dueAt)}</span>
            </div>
          ))}
      </div>
      <div className="reader-shelf-footer">
        {requestTranslate && words.length > 0 && (
          <button className="vlist-note-btn" onClick={() => setNoteOpen(true)}>
            生成复习笔记
            {newWords ? <span className="mini-badge">{newWords} 词未整理</span> : null}
          </button>
        )}
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
        {onOpenSpeak && (
          <div
            className="reader-shelf-nav"
            onClick={onOpenSpeak}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpenSpeak();
            }}
          >
            <IconMic size={15} />
            口语陪练
          </div>
        )}
        {onOpenNotes && (
          <div
            className="reader-shelf-nav"
            onClick={onOpenNotes}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpenNotes();
            }}
          >
            <IconNotebook size={15} />
            笔记库
          </div>
        )}
        <TodayCard
          reviewedToday={reviewedToday}
          dueNow={due.length}
          streak={streak}
          emptyText="今日没有到期生词了。"
        />
      </div>
      {noteOpen && requestTranslate && (
        <VocabNoteDialog
          words={words}
          requestTranslate={requestTranslate}
          onSaved={onNoteSaved}
          onClose={() => setNoteOpen(false)}
        />
      )}
    </aside>
  );
}
