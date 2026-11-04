import { useLayoutEffect, useRef } from "react";
import { actions, dueReviewCount, useApp } from "../store";
import { haptic } from "../services/device";
import { Icon } from "./icons";
import { clamp, hitAnchor, nearestAnchor, projectedCenter, rubberCenter, springStep, widthAt, type NavAnchor } from "./navMotion";

const tabs = [{ key: "today", label: "阅读", icon: "shelf" }, { key: "practice", label: "口语", icon: "wave" }, { key: "vocab", label: "笔记与复习", icon: "mark" }] as const;
interface Gesture {
  kind: "pointer" | "touch"; id: number; startX: number; startY: number; lastX: number; lastY: number; origin: number;
  pressed: number; moved: boolean; samples: { x: number; time: number }[];
}

export default function GlassNav({ hidden, inert }: { hidden: boolean; inert: boolean }) {
  const tab = useApp(s => s.tab), due = useApp(dueReviewCount);
  const root = useRef<HTMLElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const selected = Math.max(0, tabs.findIndex(t => t.key === tab));
  const selectedRef = useRef(selected), blocked = useRef(hidden || inert), reduced = useRef(false);
  selectedRef.current = selected; blocked.current = hidden || inert;
  const geometry = useRef<{ left: number; top: number; bottom: number; baseWidth: number; anchors: NavAnchor[] } | null>(null);
  const gesture = useRef<Gesture | null>(null), suppressUntil = useRef(0);
  const motion = useRef({ center: 0, velocity: 0, width: 0, widthVelocity: 0, press: 0, damping: 1, initialized: false });
  const frame = useRef<number | null>(null), previousFrame = useRef<number | null>(null);

  function stopFrame() { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; previousFrame.current = null; }
  function paint() {
    const layout = geometry.current, node = bubble.current; if (!layout || !node) return;
    const value = motion.current;
    const stretch = reduced.current ? 0 : Math.min(.075, Math.abs(value.velocity) / 24000);
    const press = reduced.current ? 0 : value.press;
    node.style.transform = `translate3d(${value.center - layout.baseWidth / 2}px,0,0) scale(${value.width / layout.baseWidth * (1 + stretch + press * .025)},${1 + press * .06 - stretch * .3})`;
    node.style.setProperty("--glass-light", String(gesture.current ? .82 : value.press * .58));
    node.style.setProperty("--glass-light-x", `${clamp(50 + value.velocity / 45, 15, 85)}%`);
    root.current?.toggleAttribute("data-dragging", Boolean(gesture.current?.moved));
    const preview = gesture.current?.moved ? nearestAnchor(value.center, layout.anchors) : gesture.current?.pressed;
    root.current?.querySelectorAll<HTMLElement>(".tab").forEach((button, index) => button.toggleAttribute("data-pressed", preview === index));
  }
  function requestFrame() { if (frame.current === null) frame.current = requestAnimationFrame(tick); }
  function tick(time: number) {
    frame.current = null;
    const layout = geometry.current; if (!layout || blocked.current) return;
    const value = motion.current;
    if (gesture.current) { previousFrame.current = null; paint(); return; }
    const elapsed = previousFrame.current === null ? 1 / 60 : clamp((time - previousFrame.current) / 1000, .001, .032);
    previousFrame.current = time;
    const target = layout.anchors[selectedRef.current];
    [value.center, value.velocity] = springStep(value.center, value.velocity, target.center, elapsed, value.damping);
    [value.width, value.widthVelocity] = springStep(value.width, value.widthVelocity, target.width, elapsed);
    value.press *= Math.exp(-elapsed * 24);
    const settled = Math.abs(value.center - target.center) < .05 && Math.abs(value.velocity) < .5 && Math.abs(value.width - target.width) < .05 && Math.abs(value.widthVelocity) < .5 && value.press < .002;
    if (settled) { value.center = target.center; value.width = target.width; value.velocity = value.widthVelocity = value.press = 0; previousFrame.current = null; }
    paint(); if (!settled) requestFrame();
  }
  function snap() {
    const layout = geometry.current; if (!layout) return;
    stopFrame(); const target = layout.anchors[selectedRef.current];
    Object.assign(motion.current, { center: target.center, width: target.width, velocity: 0, widthVelocity: 0, press: 0 }); paint();
  }
  function animate() { if (reduced.current || blocked.current) snap(); else requestFrame(); }
  function commit(index: number) {
    if (blocked.current) return;
    if (index !== selectedRef.current) { selectedRef.current = index; actions.setTab(tabs[index].key); haptic("light"); }
    animate();
  }
  function releaseCapture(active: Gesture) {
    if (active.kind === "pointer" && root.current?.hasPointerCapture(active.id)) root.current.releasePointerCapture(active.id);
  }
  function cancel(immediate = false) {
    const active = gesture.current; gesture.current = null;
    if (active) releaseCapture(active);
    suppressUntil.current = 0; motion.current.damping = 1;
    if (immediate) snap(); else animate();
  }
  function measure() {
    const nav = root.current; if (!nav) return;
    if (gesture.current) cancel(true);
    const rect = nav.getBoundingClientRect();
    const anchors = [...nav.querySelectorAll<HTMLElement>(".tab")].map(button => {
      const bounds = button.getBoundingClientRect();
      return { center: bounds.left + bounds.width / 2 - rect.left - nav.clientLeft, width: bounds.width };
    });
    if (anchors.some(anchor => anchor.width <= 0)) return;
    geometry.current = { left: rect.left + nav.clientLeft, top: rect.top, bottom: rect.bottom, baseWidth: anchors[0].width, anchors };
    bubble.current!.style.width = `${anchors[0].width}px`;
    if (!motion.current.initialized || reduced.current || blocked.current) { motion.current.initialized = true; snap(); }
    else animate();
  }
  function down(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const layout = geometry.current; if (blocked.current || !layout) return;
    if (gesture.current) { cancel(); return; }
    stopFrame(); suppressUntil.current = 0;
    gesture.current = { kind, id, startX: x, startY: y, lastX: x, lastY: y, origin: motion.current.center, pressed: hitAnchor(x - layout.left, layout.anchors), moved: false, samples: [{ x: motion.current.center, time }] };
    motion.current.press = 1; paint();
  }
  function move(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const active = gesture.current, layout = geometry.current; if (!active || active.kind !== kind || active.id !== id || !layout) return false;
    const dx = x - active.startX, dy = y - active.startY;
    if (!active.moved && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) { cancel(); return false; }
    active.lastX = x; active.lastY = y;
    if (!active.moved && Math.abs(dx) <= 6) return false;
    if (!active.moved) {
      active.moved = true;
      if (kind === "pointer") root.current?.setPointerCapture(id);
    }
    const value = motion.current;
    value.center = rubberCenter(active.origin + dx, layout.anchors);
    value.width = widthAt(value.center, layout.anchors);
    active.samples.push({ x: value.center, time });
    active.samples = active.samples.filter(sample => time - sample.time <= 80).slice(-6);
    const first = active.samples[0], last = active.samples.at(-1)!;
    value.velocity = last.time > first.time ? clamp((last.x - first.x) * 1000 / (last.time - first.time), -1800, 1800) : 0;
    requestFrame(); return true;
  }
  function up(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const active = gesture.current, layout = geometry.current; if (!active || active.kind !== kind || active.id !== id || !layout) return;
    if (x !== active.lastX || y !== active.lastY) {
      move(kind, id, x, y, time);
      if (gesture.current !== active) return;
    }
    gesture.current = null; releaseCapture(active);
    if (active.moved) {
      if (time - active.samples.at(-1)!.time > 80) motion.current.velocity = 0;
      motion.current.damping = Math.abs(motion.current.velocity) > 100 ? .88 : 1;
      const index = nearestAnchor(projectedCenter(motion.current.center, motion.current.velocity, layout.anchors), layout.anchors);
      suppressUntil.current = performance.now() + 700; commit(index);
    } else {
      motion.current.damping = 1;
      const anchor = layout.anchors[active.pressed];
      const inside = Math.abs(x - layout.left - anchor.center) <= anchor.width / 2 + 10 && y >= layout.top - 10 && y <= layout.bottom + 10;
      if (inside) commit(active.pressed); else animate();
    }
    paint();
  }

  useLayoutEffect(() => {
    const nav = root.current!;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = preference.matches; measure();
    const resize = new ResizeObserver(measure); resize.observe(nav); nav.querySelectorAll(".tab").forEach(button => resize.observe(button));
    const onPreference = () => { reduced.current = preference.matches; cancel(true); };
    const pointerDown = (event: PointerEvent) => { if (event.pointerType === "touch") return; if (event.button !== 0 || event.isPrimary === false) { if (gesture.current) cancel(); return; } down("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerMove = (event: PointerEvent) => { if (event.pointerType !== "touch") move("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerUp = (event: PointerEvent) => { if (event.pointerType !== "touch") up("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerCancel = (event: PointerEvent) => { if (gesture.current?.kind === "pointer" && gesture.current.id === event.pointerId) cancel(); };
    const touchStart = (event: TouchEvent) => { if (event.touches.length !== 1) { cancel(); return; } const touch = event.changedTouches[0]; if (touch) down("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp); };
    const multiTouch = (event: TouchEvent) => { if (gesture.current && event.touches.length > 1) cancel(); };
    const touchMove = (event: TouchEvent) => { if (gesture.current?.kind !== "touch") return; if (event.touches.length !== 1) { cancel(); return; } const touch = [...event.touches].find(t => t.identifier === gesture.current!.id); if (touch && move("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault(); };
    const touchEnd = (event: TouchEvent) => { if (gesture.current?.kind !== "touch") return; const touch = [...event.changedTouches].find(t => t.identifier === gesture.current!.id); if (touch) up("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp); };
    const touchCancel = () => { if (gesture.current?.kind === "touch") cancel(); };
    const blur = () => cancel(true), visibility = () => { if (document.hidden) cancel(true); };
    nav.addEventListener("pointerdown", pointerDown);
    nav.addEventListener("lostpointercapture", pointerCancel);
    window.addEventListener("pointermove", pointerMove); window.addEventListener("pointerup", pointerUp); window.addEventListener("pointercancel", pointerCancel);
    nav.addEventListener("touchstart", touchStart, { passive: true });
    window.addEventListener("touchstart", multiTouch, { passive: true });
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("touchend", touchEnd); window.addEventListener("touchcancel", touchCancel);
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", visibility);
    preference.addEventListener("change", onPreference);
    return () => {
      const active = gesture.current; gesture.current = null;
      if (active?.kind === "pointer" && nav.hasPointerCapture(active.id)) nav.releasePointerCapture(active.id);
      stopFrame(); resize.disconnect(); motion.current.initialized = false;
      nav.removeEventListener("pointerdown", pointerDown); nav.removeEventListener("lostpointercapture", pointerCancel);
      window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerup", pointerUp); window.removeEventListener("pointercancel", pointerCancel);
      nav.removeEventListener("touchstart", touchStart); window.removeEventListener("touchstart", multiTouch); window.removeEventListener("touchmove", touchMove); window.removeEventListener("touchend", touchEnd); window.removeEventListener("touchcancel", touchCancel);
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility); preference.removeEventListener("change", onPreference);
    };
  }, []);
  useLayoutEffect(() => { if (blocked.current) cancel(true); else measure(); }, [selected, due, hidden, inert]);

  return <nav ref={root} className={`tabbar glass-nav ${hidden ? "behind" : ""}`} aria-label="主导航" inert={inert || undefined}
    onClickCapture={event => { if (event.detail !== 0 && performance.now() < suppressUntil.current) { event.preventDefault(); event.stopPropagation(); suppressUntil.current = 0; } }}>
    <span ref={bubble} className="glass-bubble" aria-hidden="true" />
    {tabs.map((item, index) => <button className={`tab ${selected === index ? "on" : ""}`} key={item.key} aria-current={selected === index ? "page" : undefined} onClick={() => commit(index)}><Icon name={item.icon} size={20}/><span>{item.label}</span>{item.key === "vocab" && due > 0 && <span className="nav-badge">{due > 99 ? "99+" : due}</span>}</button>)}
  </nav>;
}
