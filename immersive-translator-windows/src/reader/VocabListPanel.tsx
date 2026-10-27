/**
 * 「笔记与复习」左栏 · 筛选 rail（2026-10-26 改版，导出名 VaultRail，文件路径保留）。
 *
 * 原型 prototypes/notes-review-redesign-2026-10-26.html:183-193：
 * 不再摆出待复习词表——避免泄露答案；只做两组筛选 +
 * 加练横幅 + 未整理提示。「内容来源」= 全部 / 各《文章》/ 划词收藏 / 口语纠偏
 * （按到期队列 due 分组计数；口语纠偏 = 今日 coachDiff 轮数）；
 * 「类型」= 单词 / 词块·短语。筛选状态（source/type）由 VaultPage 持有并回传，
 * 联合驱动复习首页的胶带列表。
 *
 * rail 里不出现任何词面；「去处理」打开内嵌 VocabNoteDialog（选词 → LLM →
 * noteSave 永不覆盖，链路零改动，requestTranslate 缺省（预览页/单测）不展示按钮）。
 */

import { useMemo, useState } from "react";
import type { NoteMeta, VocabWord } from "../core/readerTypes";
import type { SpeakSession } from "../core/speakLogic";
import { VocabNoteDialog, type NoteTranslateFn } from "./VocabNoteDialog";

/** 内容来源筛选：all 全部 / article:<id> 某篇文章 / popup 划词收藏 / speak 口语纠偏。 */
export type VaultSourceFilter = "all" | "popup" | "speak" | `article:${string}`;

/** 类型筛选：all 全部 / word 单词 / chunk 词块·短语。 */
export type VaultTypeFilter = "all" | "word" | "chunk";

interface Props {
  /** 全库生词（「去处理」弹窗的选词数据源）。 */
  words: VocabWord[];
  /** 到期/加练队列（rail 计数按它分组）。 */
  due: VocabWord[];
  speakSessions: SpeakSession[];
  articleTitle: (articleId: string) => string | null;
  source: VaultSourceFilter;
  onSourceChange: (s: VaultSourceFilter) => void;
  type: VaultTypeFilter;
  onTypeChange: (t: VaultTypeFilter) => void;
  /** 加练模式：队列只含笔记仍错词时的剩余数量（0 = 正常到期队列）。 */
  focusCount: number;
  /** 退出加练，回到全局到期队列。 */
  onExitFocus?: () => void;
  /** 还没整理进任何笔记的生词数（rail-note 提示）。 */
  unnotedCount?: number;
  /** 复习笔记生成通道；缺省不渲染「去处理」（预览页/单测）。 */
  requestTranslate?: NoteTranslateFn;
  /** 笔记入库成功 →「在笔记库打开」（ReaderApp 切视图）。 */
  onNoteSaved?: (meta: NoteMeta) => void;
}

/** 口语纠偏轮数（带 coachDiff 的 user 轮，全部历史）——与下方列表的口语条目同口径，
    数字 = 点进该筛选后列表实际显示的条数。 */
function countCoached(sessions: SpeakSession[]): number {
  return sessions.reduce(
    (n, s) => n + s.turns.filter((t) => t.role === "user" && t.coachDiff).length,
    0,
  );
}

export function VaultRail({
  words,
  due,
  speakSessions,
  articleTitle,
  source,
  onSourceChange,
  type,
  onTypeChange,
  focusCount,
  onExitFocus,
  unnotedCount,
  requestTranslate,
  onNoteSaved,
}: Props) {
  const [noteOpen, setNoteOpen] = useState(false);

  /** 文章来源分组：按到期队列首次出现排序，只列出有到期词的文章。 */
  const articleGroups = useMemo(() => {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const w of due) {
      const id = w.source.articleId;
      if (!id) continue;
      if (!counts.has(id)) order.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return order.map((id) => ({ id, n: counts.get(id) ?? 0, title: articleTitle(id) }));
  }, [due, articleTitle]);

  const popupCount = useMemo(() => due.filter((w) => !w.source.articleId).length, [due]);
  const coachedCount = useMemo(() => countCoached(speakSessions), [speakSessions]);
  const wordCount = useMemo(() => due.filter((w) => w.kind !== "chunk").length, [due]);
  const chunkCount = due.length - wordCount;

  const srcBtn = (value: VaultSourceFilter, label: string, n: number) => (
    <button
      key={value}
      className={`rail-item${source === value ? " on" : ""}`}
      onClick={() => onSourceChange(value)}
    >
      <span>{label}</span>
      <span className="n">{n}</span>
    </button>
  );
  const typeBtn = (value: VaultTypeFilter, label: string, n: number) => (
    <button
      key={value}
      className={`rail-item${type === value ? " on" : ""}`}
      onClick={() => onTypeChange(type === value ? "all" : value)}
      aria-pressed={type === value}
    >
      <span>{label}</span>
      <span className="n">{n}</span>
    </button>
  );

  return (
    <aside className="vault-rail">
      {focusCount > 0 && (
        <div className="focus-banner">
          <span className="t">加练 · 只测笔记仍错词（剩 {focusCount}）</span>
          {onExitFocus && (
            <button onClick={onExitFocus} title="回到全部到期队列">
              退出
            </button>
          )}
        </div>
      )}
      {/* 计数口径 = 下方列表：全部含口语纠偏条目；类型筛选时口语条目隐藏（非词非块） */}
      <h4>内容来源 · 待复习</h4>
      {srcBtn("all", "全部", due.length + coachedCount)}
      {articleGroups.map((g) =>
        srcBtn(`article:${g.id}` as VaultSourceFilter, `《${g.title ?? "未命名文章"}》`, g.n),
      )}
      {srcBtn("popup", "划词收藏", popupCount)}
      {srcBtn("speak", "口语纠偏", coachedCount)}
      <h4>类型 · 待复习</h4>
      {typeBtn("word", "单词", wordCount)}
      {typeBtn("chunk", "词块 / 短语", chunkCount)}
      {words.length === 0 && (
        <div className="rail-empty">在阅读里查词收藏，复习从这里开始。</div>
      )}
      {(unnotedCount ?? 0) > 0 && (
        <div className="rail-note">
          有 {unnotedCount} 条内容未整理，可能不是词汇（如命令行）。
          <br />
          {requestTranslate && <button onClick={() => setNoteOpen(true)}>去处理</button>}
        </div>
      )}
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
