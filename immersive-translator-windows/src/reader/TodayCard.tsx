/**
 * 今日复习进度卡（进度环 + 打卡天数）。
 * 阅读书架 / 生词本 / 笔记库三个左栏共用——此前进度环只在阅读书架出现，
 * 其他视图只剩一行数字，今日目标在哪个房间都该可见。
 */

/** 进度环周长（r=19）。 */
const RING_LEN = 2 * Math.PI * 19;

interface Props {
  reviewedToday: number;
  dueNow: number;
  streak: number;
  /** 有到期词时的「继续复习」按钮；缺省不渲染。 */
  onGoReview?: () => void;
  /** 今日无到期词时的占位文案。 */
  emptyText?: string;
}

export function TodayCard({ reviewedToday, dueNow, streak, onGoReview, emptyText }: Props) {
  const todayTotal = reviewedToday + dueNow;
  if (todayTotal === 0) {
    return <div className="reader-review-card">{emptyText ?? "今日没有到期生词，去阅读里攒几个吧。"}</div>;
  }
  const offset = RING_LEN * (1 - reviewedToday / todayTotal);
  return (
    <div className="reader-review-card reader-today-card">
      <div className="today-ring" aria-hidden>
        <svg width="46" height="46" viewBox="0 0 46 46">
          <circle cx="23" cy="23" r="19" fill="none" stroke="var(--border)" strokeWidth="3.5" />
          <circle
            cx="23"
            cy="23"
            r="19"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={RING_LEN}
            strokeDashoffset={offset}
            transform="rotate(-90 23 23)"
          />
        </svg>
        <span className="today-ring-num">
          {reviewedToday}/{todayTotal}
        </span>
      </div>
      <div className="today-main">
        <div className="today-line">
          今日复习 <strong>{reviewedToday}</strong> / {todayTotal} · 连续打卡 <strong>{streak}</strong> 天
        </div>
        <div className="today-sub">
          {dueNow > 0 ? `还差 ${dueNow} 个清空今天到期` : "今天的到期已清空 ✓"}
        </div>
        {dueNow > 0 && onGoReview && (
          <button className="btn btn-primary btn-sm today-go" onClick={onGoReview}>
            继续复习
          </button>
        )}
      </div>
    </div>
  );
}
