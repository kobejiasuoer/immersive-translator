/**
 * 复习安排抽屉（proto-parity · SHEETS.reviewSchedule，html:2924 + .v2-schedule-list html:821-824）：
 * 头部「你的复习安排」无衬线加粗 + 说明「没记住的表达会先回来；也可以打开词条，立即练一次。」；
 * 行 = 衬线词 + 状态·时间副行（待强化 · 10 分钟后 · 今天 HH:MM，formatDueAt 即原型 v2LearningTime）
 * + 右 chevron，行间 hairline 分隔；
 * 点行打开词条详情抽屉。数据只读自 store（dueAt 升序同口径），不新增字段。
 */
import { useEffect, useState } from "react";
import { Icon } from "../../ui/icons";
import { useApp } from "../../store";
import { ReadingDrawer } from "../reading/Drawer";
import { WordDetailSheet } from "./WordDetailSheet";
import { formatDueAt, pendingReinforcements } from "./derive";

export function ReviewScheduleSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const vocab = useApp((s) => s.vocab);
  const reviewEvents = useApp((s) => s.reviewEvents);
  const [now, setNow] = useState(() => Date.now());
  const [wordSheet, setWordSheet] = useState<string | null>(null);
  /* 抽屉常驻挂载（VaultBody 顶层）：每次打开重取当前时刻，避免停留页面后显示过期的相对时间。 */
  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open]);
  const rows = [...vocab].sort((a, b) => a.dueAt - b.dueAt);
  const pendingIds = new Set(pendingReinforcements({ vocab, reviewEvents }, now).map((p) => p.word.id));
  return (
    <>
      <ReadingDrawer open={open} onClose={onClose} label="复习安排">
        {/* 抽屉头（原型 .sh-head：17px 无衬线粗体 + 说明 + 下缘分隔线，html:417,2924） */}
        <div className="v2-sh-head">
          <div className="sheet-title plain">你的复习安排</div>
          <p className="v2-learning-caption">没记住的表达会先回来；也可以打开词条，立即练一次。</p>
        </div>
        <div className="v2-schedule-list">
          {rows.length ? (
            rows.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setNow(Date.now());
                  setWordSheet(w.id);
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <b>{w.word}</b>
                  <small>
                    {pendingIds.has(w.id) ? "待强化 · " : ""}
                    {w.paused ? "已暂停" : formatDueAt(w.dueAt, now)}
                  </small>
                </span>
                <Icon name="right" size={15} />
              </button>
            ))
          ) : (
            <p className="v2-learning-copy">现在没有已开启的复习任务。</p>
          )}
        </div>
      </ReadingDrawer>
      {wordSheet && <WordDetailSheet wordId={wordSheet} onClose={() => setWordSheet(null)} />}
    </>
  );
}
