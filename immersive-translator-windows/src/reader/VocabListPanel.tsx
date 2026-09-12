/**
 * 左栏 · 生词本词表（复习态）。
 *
 * 与书架同一列壳（232px、同页脚槽位），但内容随视图切换：
 * 进入生词本后这一列就是词表本身——到期队列带序号（与卡片 1/N 对应，可点跳卡），
 * 其余词按到期时间排列，只读展示下次见面时间。页脚槽位换成「沉浸式阅读」回程入口。
 */

import { IconBookOpen } from "../ui/icons";
import type { VocabWord } from "../core/readerTypes";

interface Props {
  words: VocabWord[];
  /** 到期队列（ReaderApp 统一计算，与 ReviewView 共用，保证序号一致）。 */
  due: VocabWord[];
  /** 当前卡片在队列中的位置。 */
  pos: number;
  reviewedToday: number;
  streak: number;
  onJumpToCard: (i: number) => void;
  onOpenReader: () => void;
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

export function VocabListPanel({ words, due, pos, reviewedToday, streak, onJumpToCard, onOpenReader }: Props) {
  const dueIds = new Set(due.map((w) => w.id));
  const later = words.filter((w) => !dueIds.has(w.id)).sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  const todayTotal = reviewedToday + due.length;

  return (
    <aside className="reader-shelf vlist">
      <div className="reader-shelf-header">
        生词本
        <span className="vlist-total">{words.length}</span>
      </div>
      <div className="reader-shelf-list">
        {words.length === 0 && (
          <div className="reader-empty-shelf">
            还没有生词。
            <br />
            在阅读里查词或点词块，选「加入生词本」，就会出现在这里。
          </div>
        )}
        {due.length > 0 && <div className="vlist-group">待复习 · {due.length}</div>}
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
        {later.length > 0 && <div className="vlist-group">稍后再来 · {later.length}</div>}
        {later.map((w) => (
          <div key={w.id} className="reader-shelf-item vlist-later" title="还没到期">
            <span className="t">{w.word}</span>
            <span className="dots" aria-hidden />
            <span className="when">{nextDueLabel(w.srs.dueAt)}</span>
          </div>
        ))}
      </div>
      <div className="reader-shelf-footer">
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
        {todayTotal > 0 ? (
          <div className="reader-review-card">
            今日复习 <strong>{reviewedToday}</strong> / {todayTotal} · 连续打卡 <strong>{streak}</strong> 天
          </div>
        ) : (
          <div className="reader-review-card">今日没有到期生词了。</div>
        )}
      </div>
    </aside>
  );
}
