/**
 * 口语陪练页的展示组件（纯 props 驱动，不持有业务状态）：场景条 / 目标词 chips /
 * 句内词着色 / 可行动提示条 / 麦克风按钮 / 右栏发音面板。
 * 从 SpeakView 拆出避免单文件继续膨胀；状态与回调全部由 SpeakView 传入。
 */

import { useMemo, type CSSProperties } from "react";
import type { PhoneScore, WordMark, WordScore } from "../core/pronunciation";
import type { ShadowAttempt } from "../core/speakLogic";
import { phoneTip, wordScorePath } from "../core/shadowDiagnose";
import {
  annotateSegments,
  scorePct,
  scoreTone,
  type Span,
  type TargetProgress,
} from "../core/speakUi";
import {
  IconAlertCircle,
  IconClose,
  IconHighlighter,
  IconLocate,
  IconMic,
  IconStar,
  IconStop,
  IconVolume,
} from "../ui/icons";
import { PhonemeRow } from "./ShadowReport";

// ---------- 场景条 ----------

export function SpeakSceneBar({
  title,
  difficultyLabel,
  progress,
  listenMode,
  onBack,
  onToggleListen,
}: {
  title: string;
  difficultyLabel: string;
  progress: TargetProgress | null;
  listenMode: boolean;
  onBack: () => void;
  onToggleListen: () => void;
}) {
  return (
    <div className="speak-scene">
      <button className="speak-scene-back" onClick={onBack}>
        ← 切换场景
      </button>
      <span className="speak-scene-title">{title}</span>
      <span className="speak-scene-level tabular">{difficultyLabel}难度</span>
      {progress && (
        <span
          className="speak-scene-progress"
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.hit}
        >
          <span className="speak-bar">
            <i style={{ width: `${progress.pct}%` }} />
          </span>
          <span className="tabular">{progress.label}</span>
        </span>
      )}
      <button
        className={`speak-listen-toggle${listenMode ? " on" : ""}`}
        onClick={onToggleListen}
        aria-pressed={listenMode}
        title="听力模式：AI 的话先只听不看——答完一句自动显示原文，也可点「看原文」随时查看"
      >
        <span className="speak-switch" aria-hidden />
        听力模式
      </button>
    </div>
  );
}

// ---------- 目标词 chips ----------

export interface TargetChipItem {
  key: string;
  word: string;
  zh?: string;
  done: boolean;
  /** 点击 chip 时的 toast 文案。 */
  toast: string;
}

export function TargetChips({
  items,
  nextKey,
  onPick,
}: {
  items: readonly TargetChipItem[];
  /** 建议下一个试的词（第一个还没用上的）；null = 全部用上。 */
  nextKey: string | null;
  onPick: (item: TargetChipItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="speak-targets" aria-label="本轮目标词">
      <span className="speak-targets-label">本轮目标词</span>
      {items.map((it) => (
        <button
          key={it.key}
          className={`speak-chip${it.done ? " done" : ""}${it.key === nextKey ? " next" : ""}`}
          title={`${it.word} — 在对话中自然说出即可完成`}
          onClick={() => onPick(it)}
        >
          <span className="speak-chip-dot" aria-hidden>
            {it.done ? "✓" : ""}
          </span>
          <strong>{it.word}</strong>
          {it.zh && <span className="speak-chip-zh">{it.zh}</span>}
          <span className="speak-sr-only">{it.done ? "（已用上）" : "（待练习）"}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- 句内着色：发音标记 + 目标词高亮 ----------

export function UserSentence({
  text,
  marks,
  targetSpans,
  selected,
  onPickMark,
}: {
  text: string;
  /** 发音评测词标记；缺省/空 = 只做目标词高亮。 */
  marks: readonly WordMark[];
  targetSpans: readonly Span[];
  /** 右栏当前选中的词（高亮底色）。 */
  selected?: WordScore;
  /** 传入则非 good 词可点；不传 = 只读（历史轮）。 */
  onPickMark?: (mark: WordMark) => void;
}) {
  return (
    <>
      {annotateSegments(text, marks, targetSpans).map((seg, i) => {
        const chunk = text.slice(seg.start, seg.end);
        const mark = seg.markIdx >= 0 ? marks[seg.markIdx] : undefined;
        const weak = mark !== undefined && mark.quality !== "good" ? mark : undefined;
        if (!seg.target && !weak) return <span key={i}>{chunk}</span>;
        const cls = [
          "speak-seg",
          seg.target ? "hit" : "",
          weak ? `wd-${weak.quality}` : "",
          weak && selected !== undefined && weak.word === selected ? "sel" : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (weak && onPickMark) {
          return (
            <button
              key={i}
              type="button"
              className={`${cls} pickable`}
              title={weak.quality === "missed" ? "漏读了 · 点击看细节" : `${weak.score.toFixed(1)} 分 · 点击看细节`}
              onClick={() => onPickMark(weak)}
            >
              {chunk}
            </button>
          );
        }
        return (
          <span key={i} className={cls}>
            {chunk}
          </span>
        );
      })}
    </>
  );
}

// ---------- 可行动提示条（只在本轮真的失败后出现） ----------

export interface NoticeAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export function SpeakNotice({
  message,
  detail,
  actions,
  onDismiss,
}: {
  message: string;
  /** 原始报错，悬浮查看；排查用。 */
  detail?: string;
  actions: readonly NoticeAction[];
  onDismiss: () => void;
}) {
  return (
    <div className="speak-notice" role="status">
      <IconAlertCircle size={15} />
      <span className="speak-notice-msg" title={detail}>
        {message}
      </span>
      <span className="speak-notice-actions">
        {actions.map((a) => (
          <button key={a.label} className={a.primary ? "primary" : undefined} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
        <button className="dismiss" onClick={onDismiss} aria-label="关闭提示">
          <IconClose size={13} />
        </button>
      </span>
    </div>
  );
}

// ---------- 麦克风主按钮 + 录音中提示行 ----------

/** 麦克风原始电平偏小（旧声波用 0.45 + level × 2.2 放大），×3 后夹到 [0,1] 给 CSS 变量用。 */
const levelVar = (level: number): CSSProperties =>
  ({ "--lv": Math.min(1, Math.max(0, level * 3)).toFixed(3) }) as CSSProperties;

export function SpeakMic({
  recording,
  level,
  disabled,
  title,
  ariaLabel,
  onClick,
}: {
  recording: boolean;
  /** 真实麦克风电平 0–1，驱动录音时的光圈。 */
  level: number;
  disabled: boolean;
  title: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`speak-mic${recording ? " rec" : ""}`}
      style={levelVar(level)}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {recording ? <IconStop size={22} /> : <IconMic size={24} />}
    </button>
  );
}

export function ListeningRow({ level, silenceSec }: { level: number; silenceSec: number }) {
  return (
    <div className="speak-live" style={levelVar(level)} role="status">
      <div className="speak-live-who">
        正在听你说…
        <span className="speak-wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="speak-live-sub">
        停顿约 {silenceSec} 秒自动发送 · 也可以点麦克风立即发送 · Esc 取消这句
      </div>
    </div>
  );
}

// ---------- 右栏：发音面板 ----------

const DIMS: { key: "accuracy" | "fluency" | "integrity"; label: string; title: string }[] = [
  { key: "accuracy", label: "准确", title: "准确度：每个音发得准不准" },
  { key: "fluency", label: "流利", title: "流畅度：语速与停顿是否自然" },
  { key: "integrity", label: "完整", title: "完整度：有没有漏词、添词" },
];

export function PronPanel({
  pron,
  weakCount,
  selWordIdx,
  selPhoneIdx,
  onSelectWord,
  onSelectPhone,
  onSpeakSlow,
  onSpeak,
  onOpenSettings,
}: {
  /** 最新一句你的发音评测；null = 还没有（没说过/凭据缺失/评测失败）。 */
  pron: ShadowAttempt | null;
  /** 句中需要注意（非 good）的词数，0 时提示「没有明显问题」。 */
  weakCount: number;
  selWordIdx: number | null;
  selPhoneIdx: number | null;
  onSelectWord: (idx: number) => void;
  onSelectPhone: (idx: number) => void;
  onSpeakSlow: (word: string) => void;
  onSpeak: (word: string) => void;
  onOpenSettings: () => void;
}) {
  const scorePath = useMemo(() => wordScorePath(pron?.words ?? []), [pron]);
  const selWord: WordScore | undefined = pron && selWordIdx !== null ? pron.words[selWordIdx] : undefined;
  const selPhones: PhoneScore[] = selWord?.sylls.flatMap((s) => s.phones) ?? [];
  const selPhone: PhoneScore | undefined = selPhoneIdx !== null ? selPhones[selPhoneIdx] : undefined;

  return (
    <aside className="speak-panel" aria-label="发音反馈">
      <div className="speak-panel-head">
        <span>{pron ? "这句的发音" : "发音反馈"}</span>
        <small>{pron ? "点句中标色的词看细节" : "每说一句自动更新"}</small>
      </div>
      <div className="speak-panel-body">
        {!pron ? (
          <ul className="speak-panel-preview">
            <li>
              <span className="ico">
                <IconStar size={14} />
              </span>
              整句总分，准确 / 流利 / 完整三项
            </li>
            <li>
              <span className="ico">
                <IconHighlighter size={14} />
              </span>
              读得不准的词会在你的句子里标色
            </li>
            <li>
              <span className="ico">
                <IconLocate size={14} />
              </span>
              点那个词，看哪个音偏了、听慢速示范
            </li>
          </ul>
        ) : (
          <>
            <div className="speak-total">
              <div
                className={`speak-ring ${scoreTone(pron.total)}`}
                style={{ "--p": scorePct(pron.total) } as CSSProperties}
                role="img"
                aria-label={`总分 ${pron.total.toFixed(1)} / 5`}
              >
                <span>
                  <b className="tabular">{pron.total.toFixed(1)}</b>
                  <small>/ 5</small>
                </span>
              </div>
              <div className="speak-subs">
                {DIMS.map((d) => (
                  <div key={d.key} className="speak-sub" title={d.title}>
                    <span>{d.label}</span>
                    <span className="speak-bar">
                      <i className={scoreTone(pron[d.key])} style={{ width: `${scorePct(pron[d.key])}%` }} />
                    </span>
                    <span className="tabular">{pron[d.key].toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </div>

            {selWord ? (
              <div className="speak-word">
                <div className="speak-word-head">
                  <b>{selWord.content}</b>
                  <span className={`speak-word-score tabular ${scoreTone(selWord.totalScore)}`}>
                    {selWord.totalScore.toFixed(1)} 分
                  </span>
                </div>
                {selPhones.length > 0 && (
                  <PhonemeRow
                    phones={selPhones}
                    variant="pills"
                    selectedIdx={selPhoneIdx}
                    onSelect={onSelectPhone}
                  />
                )}
                <p className="speak-word-tip">
                  {selPhone ? `/${selPhone.content}/：${phoneTip(selPhone.content)}` : "点上面的音素看针对性建议"}
                </p>
                <div className="speak-word-actions">
                  <button
                    className="speak-btn"
                    onClick={() => onSpeakSlow(selWord.content)}
                    title="云引擎按 0.75× 原生慢速合成示范；本地语音走普通朗读"
                  >
                    <IconVolume size={14} /> 慢速示范
                  </button>
                  <button className="speak-btn" onClick={() => onSpeak(selWord.content)}>
                    重读这个词
                  </button>
                </div>
              </div>
            ) : (
              <p className="speak-panel-note">
                {weakCount === 0 ? "这句没有明显读错的词，继续保持。" : "点你句子里标色的词，看具体哪个音偏了。"}
              </p>
            )}

            <details className="speak-curve">
              <summary>逐词得分曲线</summary>
              <svg
                className="word-score-svg"
                viewBox={`0 0 ${scorePath.width} ${scorePath.height}`}
                role="img"
                aria-label="逐词得分曲线"
              >
                <line
                  x1={12}
                  y1={scorePath.baselineY}
                  x2={scorePath.width - 12}
                  y2={scorePath.baselineY}
                  stroke="var(--glass-border-strong)"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
                <polyline
                  points={scorePath.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                {scorePath.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={selWordIdx === i ? 3.2 : 2}
                    fill={selWordIdx === i ? "var(--accent)" : "var(--ink-2)"}
                    onClick={() => onSelectWord(i)}
                    style={{ cursor: "pointer" }}
                  />
                ))}
              </svg>
              <p className="speak-panel-note">虚线是 5 分基准；点圆点同步选中上方单词。</p>
            </details>
          </>
        )}
      </div>
      <div className="speak-panel-foot">
        发音评分由讯飞提供 ·{" "}
        <button className="speak-link" onClick={onOpenSettings} title="讯飞评测/听写凭据在主窗口 设置 → 语音 里集中配置">
          凭据设置
        </button>
      </div>
    </aside>
  );
}
