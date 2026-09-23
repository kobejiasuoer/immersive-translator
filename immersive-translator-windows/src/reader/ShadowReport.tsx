/**
 * 跟读报告卡 + 点词音素弹层（口语陪练）。
 *
 * 回答「差的 X 分差在哪」：维度条（准确度/流畅度/完整度）指出短板，
 * 规则诊断句点名差词/漏词，原句按四档着色；每个问题都连着动作——
 * 点词看音素、听领读、听自己的录音、只练差词、整句重读。
 * 数据全部来自 ISE 返回（pronunciation.ts 解析），无额外请求。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DIM_LABELS,
  SHADOW_PASS_SCORE,
  diagnoseShadow,
  phoneTip,
  worstPhoneOf,
  type DiagSegment,
  type ShadowDiagnosis,
} from "../core/shadowDiagnose";
import type { PronunciationResult, WordMark } from "../core/pronunciation";

export interface DrillEntry {
  /** 原文里的词（保留原大小写）。 */
  text: string;
  mark: WordMark;
}

interface Props {
  /** 跟读的整句原文（词着色的底本）。 */
  target: string;
  result: PronunciationResult;
  marks: WordMark[];
  /** 历史总分（含本次，最新在末尾）。 */
  attemptTotals: number[];
  onAgain: () => void;
  onDrill: (entries: DrillEntry[]) => void;
  onHearModel: () => void;
  /** 无录音可放时为 null（按钮禁用）。 */
  onHearMine: (() => void) | null;
  onSpeakWord: (word: string) => void;
}

/** 徽章 → 样式类。 */
const BADGE_CLASS: Record<ShadowDiagnosis["badgeKind"], string> = {
  pass: "rc-badge pass",
  almost: "rc-badge almost",
  fail: "rc-badge fail",
};

export function ShadowReport(props: Props) {
  const { target, result, marks, attemptTotals } = props;
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pop, setPop] = useState<{ mark: WordMark; left: number; top: number } | null>(null);
  /** 程序滚动（给弹层腾位）的豁免截止时间：此窗口内 scroll 事件不关弹层。 */
  const scrollGuardRef = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(t);
  }, []);

  // 弹层关闭/换词时移除日志末尾的占位（openPop 会先清再按需垫新的）
  useEffect(() => {
    if (pop) return;
    const log = cardRef.current?.closest(".speak-log");
    if (log) removeSpacer(log);
  }, [pop]);

  // 卸载兜底清占位
  useEffect(() => {
    return () => {
      const log = cardRef.current?.closest(".speak-log");
      if (log) removeSpacer(log);
    };
  }, []);

  // 换目标句（新一轮 assistant 回复）时收起弹层
  useEffect(() => setPop(null), [target]);

  const diag = diagnoseShadow(result, marks, SHADOW_PASS_SCORE);
  const attemptNo = attemptTotals.length;
  const total = result.total;
  const prev = attemptNo >= 2 ? attemptTotals[attemptNo - 2] : null;
  const delta = prev !== null ? total - prev : null;

  /**
   * 弹层挂到 .speak-log（portal），始终放词下方（上方是维度/诊断，不能盖）：
   * 词下空间不够就往日志末尾垫 spacer 撑出滚动空间。top 是内容坐标；
   * 滚动放到弹层提交后的下一帧（同步滚动会被浏览器 scroll anchoring 弹回）。
   */
  const openPop = (mark: WordMark, el: HTMLElement) => {
    const card = cardRef.current;
    const log = card?.closest(".speak-log");
    if (!card || !log) return;
    const POP_W = 264;
    const POP_H = 216;
    removeSpacer(log);
    const lr = log.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const top = r.bottom - lr.top + log.scrollTop + 7;
    const left = Math.max(8, Math.min(r.left - lr.left + log.scrollLeft - 8, log.clientWidth - POP_W - 8));
    const visibleBottom = log.scrollTop + log.clientHeight;
    if (top + POP_H > visibleBottom - 4) {
      const need = top + POP_H - visibleBottom + 4;
      // spacer 多垫 60px 冗余：Chrome 下 flex 容器的 scrollHeight 不计底部
      // padding，按它算的滚动余量会虚少，导致滚动量被钳不足。
      const sp = document.createElement("div");
      sp.className = "pop-spacer";
      sp.style.flex = "none";
      sp.style.height = `${need + 60}px`;
      log.appendChild(sp);
      // 滚动与 clamp 都要等滚动落地后再做（clamp 的上下限随 scrollTop 变）
      window.setTimeout(() => {
        scrollGuardRef.current = Date.now() + 250;
        log.scrollTop += need; // 超出部分由浏览器自钳
        const settled = Math.max(log.scrollTop + 6, Math.min(top, log.scrollTop + log.clientHeight - POP_H - 6));
        setPop({ mark, left, top: settled });
      }, 0);
      return;
    }
    const clampedTop = Math.max(log.scrollTop + 6, Math.min(top, log.scrollTop + log.clientHeight - POP_H - 6));
    setPop({ mark, left, top: clampedTop });
  };

  // 弹层打开时：点外部（卡与弹层以外）/ 滚动日志 / Esc 收起
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".speak-report-card") && !t.closest(".speak-popover")) setPop(null);
    };
    const log = cardRef.current?.closest(".speak-log");
    const onScroll = () => {
      if (Date.now() < scrollGuardRef.current) return; // 程序滚动豁免
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    document.addEventListener("mousedown", onDown, true);
    log?.addEventListener("scroll", onScroll);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      log?.removeEventListener("scroll", onScroll);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  return (
    <div className="speak-report-card" ref={cardRef}>
      <div className="rc-head">
        <div className="rc-score">
          <b className="rc-num">{total.toFixed(1)}</b>
          <span className="rc-den">/ 5</span>
        </div>
        <div className="rc-status">
          <span className={BADGE_CLASS[diag.badgeKind]}>{diag.badge}</span>
          <span className="rc-sub">
            第 {attemptNo} 次跟读
            {prev !== null && delta !== null && (
              <>
                {" · 上次 "}
                {prev.toFixed(1)}{" "}
                <span className={delta >= 0 ? "up" : "down"}>
                  {delta >= 0 ? "↑" : "↓"}
                  {Math.abs(delta).toFixed(1)}
                </span>
              </>
            )}
          </span>
        </div>
        {attemptNo >= 2 && (
          <div className="rc-chips">
            {attemptTotals.map((t, i) => (
              <span key={i} className={`chip${i === attemptNo - 1 ? " cur" : t >= SHADOW_PASS_SCORE ? " best" : ""}`}>
                {t.toFixed(1)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="rc-dims">
        {(["accuracy", "fluency", "integrity"] as const).map((dim) => (
          <div key={dim} className={`dim${diag.weakDim === dim ? " weak" : ""}`} title={DIM_TITLES[dim]}>
            <span className="dim-name">{DIM_LABELS[dim]}</span>
            <span className="dim-bar">
              <i style={{ width: mounted ? `${(result[dim] / 5) * 100}%` : "0%" }} />
            </span>
            <span className="dim-val">{result[dim].toFixed(1)}</span>
            {diag.weakDim === dim && <div className="dim-note">{DIM_NOTES[dim]}</div>}
          </div>
        ))}
      </div>

      <div className="rc-diag">{diag.segments.map((s, i) => <DiagSpan key={i} seg={s} />)}</div>

      <div className="rc-words">
        {renderMarked(target, marks, (mark, el) => openPop(mark, el))}
      </div>

      <div className="rc-actions">
        <button className="rc-btn primary" onClick={props.onAgain}>
          🎤 再跟读整句
        </button>
        {diag.drillWords.length > 0 && (
          <button className="rc-btn" onClick={() => props.onDrill(drillEntries(target, marks))}>
            🎯 只练 {diag.drillWords.length} 个词
          </button>
        )}
        <button className="rc-link" onClick={props.onHearModel}>
          🔊 听领读
        </button>
        <button className="rc-link" disabled={!props.onHearMine} onClick={props.onHearMine ?? undefined}>
          ▶ 听我的录音
        </button>
      </div>

      {pop &&
        (() => {
          const log = cardRef.current?.closest(".speak-log");
          const node = (
            <WordPopover
              mark={pop.mark}
              left={pop.left}
              top={pop.top}
              onClose={() => setPop(null)}
              onSpeakWord={props.onSpeakWord}
              onDrillWord={(w) => {
                setPop(null);
                const entries = drillEntries(target, marks);
                const idx = entries.findIndex((e) => e.text.toLowerCase() === w.toLowerCase());
                props.onDrill(idx >= 0 ? [entries[idx], ...entries.filter((_, i) => i !== idx)] : entries);
              }}
            />
          );
          // portal 到日志区：弹层可越出卡片（空间不足时滚日志腾位），不被卡内裁切
          return log ? createPortal(node, log) : node;
        })()}
    </div>
  );
}

// ---------- 词着色渲染 ----------

/** 移除日志末尾为弹层腾位垫的占位。 */
function removeSpacer(log: Element) {
  log.querySelectorAll(".pop-spacer").forEach((e) => e.remove());
}

function renderMarked(
  target: string,
  marks: WordMark[],
  onClick: (mark: WordMark, el: HTMLElement) => void,
) {
  const out: React.ReactNode[] = [];
  let pos = 0;
  marks.forEach((m, i) => {
    if (m.start > pos) out.push(target.slice(pos, m.start));
    const clickable = m.quality !== "good";
    out.push(
      <span
        key={i}
        className={`wd ${m.quality}${clickable ? " clickable" : ""}`}
        title={clickable ? `${m.quality === "missed" ? "漏读了" : m.score.toFixed(1) + " 分"}${m.quality === "missed" ? "" : " · 点击看细节"}` : undefined}
        onClick={clickable ? (e) => onClick(m, e.currentTarget) : undefined}
      >
        {target.slice(m.start, m.end)}
      </span>,
    );
    pos = m.end;
  });
  if (pos < target.length) out.push(target.slice(pos));
  return out;
}

/** 差词 + 漏词（按出现序，最多 4 个）作为逐词练习清单。 */
function drillEntries(target: string, marks: WordMark[]): DrillEntry[] {
  return marks
    .filter((m) => m.quality === "bad" || m.quality === "missed")
    .slice(0, 4)
    .map((m) => ({ text: target.slice(m.start, m.end), mark: m }));
}

// ---------- 音素弹层 ----------

interface PopoverProps {
  mark: WordMark;
  left: number;
  top: number;
  onClose: () => void;
  onSpeakWord: (word: string) => void;
  onDrillWord: (word: string) => void;
}

function WordPopover({ mark, left, top, onClose, onSpeakWord, onDrillWord }: PopoverProps) {
  const word = mark.word;
  const missed = mark.quality === "missed";
  const worst = worstPhoneOf(word);
  const phones = word?.sylls.flatMap((s) => s.phones) ?? [];
  const tip = worst ? phoneTip(worst.content) : null;
  const display = word?.content ?? "";

  return (
    <div className="speak-popover" style={{ left, top }} role="dialog" aria-label={`${display} 发音细节`}>
      <button className="po-close" onClick={onClose} aria-label="关闭">
        ✕
      </button>
      <div className="po-word">
        <b>{display}</b>
        {missed ? (
          <span className="wscore missed">漏读</span>
        ) : (
          <span className={`wscore ${mark.quality}`}>{mark.score.toFixed(1)}</span>
        )}
      </div>
      {missed ? (
        <div className="po-tip">
          整句里<b>没有读到这个词</b>——不算读错，下一轮把它带上就好。
        </div>
      ) : (
        <>
          {phones.length > 0 && (
            <div className="ph-row">
              {phones.map((p, i) => {
                // worstPhoneOf 返回拷贝；按内容+惩罚值对位高亮同一音素
                const isWorst = worst !== null && p.content === worst.content && p.gwpp === worst.gwpp;
                return (
                  <span key={i} className={`ph${isWorst ? " err" : ""}`}>
                    {p.content}
                  </span>
                );
              })}
            </div>
          )}
          <div className="po-tip">{tip ?? "这个词没有明显出错的音素，整体含糊了一点——对照领读放慢再读一遍。"}</div>
        </>
      )}
      <div className="po-actions">
        <button className="rc-btn" onClick={() => onSpeakWord(display)}>
          🔊 听这个词
        </button>
        {!missed && (
          <button className="rc-btn primary" onClick={() => onDrillWord(display)}>
            🎯 练这个词
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 杂项 ----------

const DIM_TITLES: Record<"accuracy" | "fluency" | "integrity", string> = {
  accuracy: "准确度：每个音发得准不准",
  fluency: "流畅度：语速与停顿是否自然",
  integrity: "完整度：有没有漏词、添词",
};

const DIM_NOTES: Record<"accuracy" | "fluency" | "integrity", string> = {
  accuracy: "有词的发音不够准（见下方红色词）",
  fluency: "语速与停顿：放慢不着急，词与词连贯",
  integrity: "有漏读/吞掉的词（见下方红底词）",
};

function DiagSpan({ seg }: { seg: DiagSegment }) {
  if (!seg.kind) return <>{seg.text}</>;
  return <b className={`hl-${seg.kind}`}>{seg.text}</b>;
}
