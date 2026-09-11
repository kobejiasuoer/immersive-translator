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
import type { Article, ReaderSettings } from "../core/readerTypes";

interface Props {
  article: Article | null;
  playback: PlaybackHandle;
  settings: ReaderSettings;
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  onOpenViewMenu: (anchor: { top: number; right: number }) => void;
  onOpenDrawer: () => void;
}

export function PlayBar({ article, playback, settings, onPatchSettings, onOpenViewMenu, onOpenDrawer }: Props) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);
  const draggingRef = useRef(false);

  const total = article?.sentences.length ?? 0;
  const idx = playback.activeIdx;
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
    playback.jumpTo(idxFromClientX(e.clientX));
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const targetIdx = idxFromClientX(e.clientX);
    setHover({ x: e.clientX, idx: targetIdx });
    if (draggingRef.current) {
      playback.jumpTo(targetIdx);
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
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
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={idx + 1}
        aria-label="朗读进度"
      >
        <div className="track">
          <div className="fill" style={{ width: `${percent}%` }} />
          <div className="knob" style={{ left: `${percent}%` }} />
        </div>
        {hover && previewText && (
          <div className="preview" style={{ left: hover.x - (barRef.current?.getBoundingClientRect().left ?? 0) }}>
            第 {hover.idx + 1} 句 · {previewText}
          </div>
        )}
        <div className="sentence-count">
          {total > 0 ? `第 ${idx + 1} / ${total} 句` : "暂无句子"}
        </div>
      </div>

      <div className="right">
        {playback.shadowingWait ? (
          <span className="reader-shadowing-tip" title="跟读模式：读完本句后点击继续">
            请跟读当前句
            <button className="btn btn-primary btn-sm" onClick={playback.continueAfterShadowing}>
              继续
            </button>
          </span>
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
