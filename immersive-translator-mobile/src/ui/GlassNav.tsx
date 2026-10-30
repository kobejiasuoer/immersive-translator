import { useEffect, useRef } from "react";
import { actions, useApp } from "../store";
import { haptic } from "../services/device";
import { Icon } from "./icons";
const tabs = [{ key: "today", label: "阅读", icon: "shelf" }, { key: "practice", label: "口语", icon: "wave" }, { key: "vocab", label: "笔记与复习", icon: "mark" }] as const;
export default function GlassNav({ hidden, inert }: { hidden: boolean; inert: boolean }) {
  const tab = useApp(s => s.tab);
  const root = useRef<HTMLElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ id: number; start: number; y: number; x: number; moved: boolean } | null>(null);
  const frame = useRef<number | null>(null), suppress = useRef(false);
  const selected = Math.max(0, tabs.findIndex(t => t.key === tab));
  const width = () => Math.max(1, (root.current!.getBoundingClientRect().width - 8) / 3);
  function move(x: number, animate = true) {
    if (!bubble.current) return;
    bubble.current.style.transition = animate ? "transform 360ms cubic-bezier(.22,.78,.24,1),width 240ms" : "none";
    bubble.current.style.transform = "translate3d(" + x + "px,0,0)";
  }
  function cancelFrame() { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; }
  useEffect(() => {
    const update = () => { if (!root.current || drag.current) return; const w = width(); if (bubble.current) bubble.current.style.width = w + "px"; move(selected * w); };
    update(); const observer = new ResizeObserver(update); if (root.current) observer.observe(root.current);
    return () => { observer.disconnect(); cancelFrame(); };
  }, [selected]);
  function finish(cancelled: boolean) {
    const d = drag.current; if (!d) return;
    drag.current = null; cancelFrame();
    const w = width(); const index = cancelled || !d.moved ? selected : Math.max(0, Math.min(2, Math.round(d.x / w)));
    move(index * w); suppress.current = d.moved;
    if (root.current?.hasPointerCapture(d.id)) root.current.releasePointerCapture(d.id);
    if (!cancelled && d.moved) { actions.setTab(tabs[index].key); haptic("light"); }
  }
  return <nav ref={root} className={"tabbar glass-nav " + (hidden ? "behind" : "")} aria-label="主导航" inert={inert || undefined}
    onPointerDown={e => { if (e.button !== 0 || drag.current) return; suppress.current = false; drag.current = { id: e.pointerId, start: e.clientX, y: e.clientY, x: selected * width(), moved: false }; }}
    onPointerMove={e => {
      const d = drag.current; if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.start, dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) { finish(true); return; }
      if (!d.moved && Math.abs(dx) > 6) { d.moved = true; root.current!.setPointerCapture(e.pointerId); }
      if (!d.moved) return;
      d.x = Math.max(0, Math.min(width() * 2, selected * width() + dx));
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (drag.current) move(drag.current.x, false); });
    }}
    onPointerUp={e => { if (drag.current?.id === e.pointerId) finish(false); }}
    onPointerCancel={e => { if (drag.current?.id === e.pointerId) finish(true); }}
    onLostPointerCapture={() => { if (drag.current) finish(true); }}
    onClickCapture={e => { if (suppress.current) { e.preventDefault(); e.stopPropagation(); suppress.current = false; } }}>
    <span ref={bubble} className="glass-bubble" aria-hidden="true" />
    {tabs.map((item, i) => <button className={"tab " + (selected === i ? "on" : "")} key={item.key} aria-current={selected === i ? "page" : undefined} onClick={() => { actions.setTab(item.key); haptic("light"); }}><Icon name={item.icon} size={20}/><span>{item.label}</span></button>)}
  </nav>;
}
