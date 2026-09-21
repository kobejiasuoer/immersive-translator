/**
 * 播放条 72px（屏 A）：上一句 · 播放 · 下一句 | 进度条 + 第 N/M 句 | 1.0× · 视图 · 设置。
 * 进度条支持拖拽与 hover 预览（§9-10）。
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconSettings,
} from "../ui/icons";
import { RATE_PRESETS, type PlaybackHandle } from "./usePlayback";
import type { ShadowAssess } from "./useShadowAssess";
import type { Article, ReaderSettings } from "../core/readerTypes";

interface Props {
  article: Article | null;
  playback: PlaybackHandle;
  settings: ReaderSettings;
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  onOpenViewMenu: (anchor: { top: number; right: number }) => void;
  onOpenDrawer: () => void;
  /** 跟读评测状态（shadowingMode + shadowingAssess 开启时传入；禅模式由 ReaderApp 复用 AssessStrip）。 */
  assess?: ShadowAssess | null;
}

/**
 * 跟读评测条：录音（电平/计时/说完）→ 评测中 → 过关 ✅ / 不过关
 * （得分 + 再试 / 领读 / 跳过）。任何失败都保留「跳过」逃生门，不卡播放。
 */
export function AssessStrip({
  assess,
  passScore,
}: {
  assess: ShadowAssess;
  passScore: number;
}) {
  if (assess.phase === "ready") {
    return (
      <span className="reader-assess ready" title="手动开麦模式：点了才录音，不说也可以跳过">
        <span className="lbl">请跟读当前句</span>
        <button className="btn btn-primary btn-sm" onClick={assess.openMic}>
          🎤 开口跟读
        </button>
        <button className="btn btn-ghost btn-sm" onClick={assess.skip}>
          跳过
        </button>
      </span>
    );
  }
  if (assess.phase === "recording") {
    return (
      <span className="reader-assess recording" title="读完这句自动停止；也可以点「说完」">
        <i className="rec-dot" />
        <span className="lbl">录音中</span>
        <i className="meter" aria-hidden>
          <i style={{ width: `${Math.min(100, Math.round(assess.level * 100))}%` }} />
        </i>
        <span className="time">{(assess.elapsedMs / 1000).toFixed(1)}s</span>
        <button className="btn btn-primary btn-sm" onClick={assess.stopRecording}>
          说完
        </button>
        <button className="btn btn-ghost btn-sm" onClick={assess.skip}>
          跳过
        </button>
      </span>
    );
  }
  if (assess.phase === "evaluating") {
    return (
      <span className="reader-assess">
        <i className="spin" aria-hidden />
        <span className="lbl">评测中…</span>
        <button className="btn btn-ghost btn-sm" onClick={assess.skip}>
          跳过
        </button>
      </span>
    );
  }
  if (assess.phase === "leading") {
    return (
      <span className="reader-assess leading" title="AI 领读中，听完自动开始录音">
        <span className="lbl">🔊 领读中…</span>
        <button className="btn btn-ghost btn-sm" onClick={assess.skip}>
          跳过
        </button>
      </span>
    );
  }
  if (assess.phase === "passed") {
    return (
      <span className="reader-assess passed">
        ✅ {assess.result ? assess.result.total.toFixed(1) : ""} 分 · 过关
      </span>
    );
  }
  if (assess.phase === "failed" || assess.phase === "error") {
    return (
      <span className="reader-assess failed">
        {assess.result && <b className="score">{assess.result.total.toFixed(1)}</b>}
        <span className="lbl" title={assess.error ?? undefined}>
          {assess.error ?? `没到 ${passScore.toFixed(1)} 分`}
        </span>
        <button className="btn btn-primary btn-sm" onClick={assess.retry}>
          再试
        </button>
        <button className="btn btn-secondary btn-sm" onClick={assess.leadRead} title="AI 慢速领读一遍，听完自动重新录音">
          领读
        </button>
        <button className="btn btn-ghost btn-sm" onClick={assess.skip}>
          跳过
        </button>
      </span>
    );
  }
  // idle / 极短暂状态：等待开麦。
  return <span className="reader-assess">准备中…</span>;
}

export function PlayBar({ article, playback, settings, onPatchSettings, onOpenViewMenu, onOpenDrawer, assess }: Props) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);
  const draggingRef = useRef(false);
  /** 拖拽中的目标句（仅移动光标/计数，不触发合成）；null = 未在拖拽。 */
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const total = article?.sentences.length ?? 0;
  // 拖拽时进度条/计数跟随手指，不跟 playback.activeIdx（拖动不打断当前朗读）。
  const idx = dragIdx ?? playback.activeIdx;
  const percent = total > 1 ? (idx / (total - 1)) * 100 : 0;

  function idxFromClientX(clientX: number): number {
    const el = barRef.current;
    if (!el || total === 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(total - 1, Math.round(ratio * (total - 1)));
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (total === 0) return;
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragIdx(idxFromClientX(e.clientX));
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const targetIdx = idxFromClientX(e.clientX);
    setHover({ x: e.clientX, idx: targetIdx });
    if (draggingRef.current) setDragIdx(targetIdx);
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (draggingRef.current) {
      draggingRef.current = false;
      const target = idxFromClientX(e.clientX);
      setDragIdx(null);
      // 松手才真正跳转：拖过一长串句子只触发这最后一句的合成，
      // 逐句 jumpTo 会把讯飞每日免费额度烧在拖拽路上。
      if (total > 0) playback.jumpTo(target);
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handlePointerCancel() {
    // 拖拽被打断（来电/系统手势）：只还原光标，不跳转不合成。
    draggingRef.current = false;
    setDragIdx(null);
  }

  if (settings.zenMode) {
    // 禅模式：极简浮起控制由 ReaderApp 渲染，这里不渲染整条播放条。
    return null;
  }

  const playing = playback.playing;
  const previewText = hover && article?.sentences[hover.idx]?.en;

  return (
    <footer className="reader-playbar">
      <div className="reader-transport">
        <button
          className="reader-skip-btn"
          onClick={() => playback.step(-1)}
          disabled={total === 0 || idx <= 0}
          title="上一句 (L)"
        >
          <IconPrev size={17} />
        </button>
        <button
          className="reader-play-btn"
          onClick={playback.toggle}
          disabled={total === 0}
          title={playing ? "暂停 (Space)" : "播放 (Space)"}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} style={{ marginLeft: 2 }} />}
        </button>
        <button
          className="reader-skip-btn"
          onClick={() => playback.step(1)}
          disabled={total === 0 || idx >= total - 1}
          title="下一句 (J)"
        >
          <IconNext size={17} />
        </button>
      </div>

      <div
        className="reader-progress"
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={idx + 1}
        aria-label="朗读进度"
      >
        <div className="track">
          <div className="fill" style={{ width: `${percent}%` }} />
          {article &&
            total > 1 &&
            total <= 40 &&
            article.sentences.map((_, i) =>
              i === 0 ? null : (
                <i key={i} className="tick" style={{ left: `${(i / (total - 1)) * 100}%` }} aria-hidden />
              ),
            )}
          <div className="knob" style={{ left: `${percent}%` }} />
        </div>
        {hover && previewText && (
          <div className="preview" style={{ left: hover.x - (barRef.current?.getBoundingClientRect().left ?? 0) }}>
            第 {hover.idx + 1} 句 · {previewText}
          </div>
        )}
      </div>

      <div className="reader-count" aria-hidden>
        {total > 0 ? (
          <>
            <span className="cur">{idx + 1}</span>
            <span className="total"> ∕ {total} 句</span>
          </>
        ) : (
          "暂无句子"
        )}
      </div>

      <div className="right">
        {playback.shadowingWait ? (
          assess ? (
            <AssessStrip assess={assess} passScore={settings.shadowingPassScore} />
          ) : (
            <span className="reader-shadowing-tip" title="跟读模式：读完本句后点击继续">
              请跟读当前句
              <button className="btn btn-primary btn-sm" onClick={playback.continueAfterShadowing}>
                继续
              </button>
            </span>
          )
        ) : (
          <button
            className="reader-rate-btn"
            onClick={() => {
              const i = RATE_PRESETS.indexOf(settings.rate as (typeof RATE_PRESETS)[number]);
              const next = RATE_PRESETS[(i + 1) % RATE_PRESETS.length];
              onPatchSettings({ rate: next });
            }}
            title="播放语速（更多档位在阅读设置）"
          >
            {settings.rate.toFixed(2).replace(/0$/, "")}×
          </button>
        )}
        <button
          className="reader-tb-btn"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenViewMenu({ top: rect.top, right: rect.right });
          }}
          title="视图"
        >
          视图
        </button>
        <button className="reader-tb-btn" onClick={onOpenDrawer} title="阅读设置">
          <IconSettings size={15} />
        </button>
      </div>
    </footer>
  );
}
