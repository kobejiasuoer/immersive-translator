import { useLayoutEffect, useRef, type ReactNode } from "react";
import { haptic } from "../services/device";
import { clamp, hitAnchor, projectedCenter, rubberCenter, springStep, widthAt, type NavAnchor } from "./navMotion";
import { LiquidLens, type LiquidLensHandle } from "./LiquidLens";
import { resolveGlassOptions, type LiquidGlassOptions } from "./liquidOptics";
import "./glassSwitch.css";

export interface GlassSwitchItem<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  accessibleLabel?: string;
  id?: string;
  controls?: string;
}
export interface GlassSwitchProps<V extends string> {
  value: V | null;
  items: readonly GlassSwitchItem<V>[];
  onChange: (value: V) => void;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  className?: string;
  role?: "tablist" | "radiogroup" | "group";
  disabled?: boolean;
  /** Explicitly record the selected choice again (for example a self-assessment). */
  allowReselect?: boolean;
  /** Optical and physical tuning; defaults are shared with the bottom navigation. */
  glass?: Partial<LiquidGlassOptions>;
}
interface Gesture {
  kind: "pointer" | "touch";
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  origin: number;
  pressed: number;
  moved: boolean;
  held: boolean;
  preview: number;
  samples: { x: number; time: number }[];
}
interface Geometry {
  left: number;
  top: number;
  bottom: number;
  baseWidth: number;
  anchors: NavAnchor[];
}

/** A controlled WebView segmented control with the product's draggable glass material.
 * Values change only on release/activation; the preview never runs the business action. */
export function GlassSwitch<V extends string>({ value, items, onChange, ariaLabel, ariaDescribedBy, className = "", role = "radiogroup", disabled = false, allowReselect = false, glass }: GlassSwitchProps<V>) {
  const root = useRef<HTMLDivElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const lens = useRef<LiquidLensHandle>(null), buttonNodes = useRef<HTMLButtonElement[]>([]);
  const selected = items.findIndex(item => item.value === value);
  const current = useRef({ items, selected, onChange, disabled, allowReselect, glass: resolveGlassOptions(glass) });
  current.current = { items, selected, onChange, disabled, allowReselect, glass: resolveGlassOptions(glass) };
  const reduced = useRef(false), geometry = useRef<Geometry | null>(null), gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null), previousFrame = useRef<number | null>(null), suppressUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null), lastHaptic = useRef(-Infinity);
  const motion = useRef({ center: 0, velocity: 0, width: 0, widthVelocity: 0, press: 0, pressVelocity: 0, stretch: 0, stretchVelocity: 0, damping: 1, initialized: false });
  const buttons = () => buttonNodes.current;
  const blocked = () => current.current.disabled || !!root.current?.closest("[inert], [hidden], .pane:not(.on), .push.tab-inactive");
  const enabled = (index: number) => !!current.current.items[index] && !current.current.items[index].disabled;
  function enabledIndex(center: number, layout: Geometry) {
    let best = -1, distance = Infinity;
    for (let index = 0; index < layout.anchors.length; index++) {
      const candidate = Math.abs(layout.anchors[index].center - center);
      if (enabled(index) && candidate < distance) { best = index; distance = candidate; }
    }
    return best;
  }
  function feedback() {
    const now = performance.now();
    if (now - lastHaptic.current < 55) return;
    lastHaptic.current = now; haptic("light");
  }
  function clearHold() {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }
  function spring(value: number, velocity: number, target: number, elapsed: number, dampingFactor = 1) {
    const { stiffness, damping } = current.current.glass;
    const omega = Math.sqrt(stiffness);
    return springStep(value, velocity, target, elapsed, damping / (2 * omega) * dampingFactor, 2 * Math.PI / omega);
  }
  function stopFrame() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; previousFrame.current = null;
  }
  function paint() {
    const layout = geometry.current, node = bubble.current;
    if (!layout || !node) return;
    node.hidden = current.current.selected < 0 && !gesture.current;
    const state = motion.current;
    const stretch = reduced.current ? 0 : state.stretch;
    const press = reduced.current ? 0 : state.press;
    const scaleX = state.width / layout.baseWidth * (1 + stretch + press * .035), scaleY = 1 + press * .08 - stretch * .65;
    node.style.transform = `translate3d(${state.center - layout.baseWidth / 2}px,0,0) scale(${scaleX},${scaleY})`;
    node.style.setProperty("--glass-switch-light", String(gesture.current ? .75 : press * .5));
    node.style.setProperty("--glass-switch-light-x", `${clamp(50 + state.velocity / 45, 15, 85)}%`);
    root.current?.toggleAttribute("data-dragging", !!gesture.current?.moved);
    const active = !!gesture.current || frame.current !== null;
    root.current?.setAttribute("data-liquid-state", gesture.current?.moved ? "dragging" : gesture.current?.held ? "holding" : gesture.current ? "pressed" : active ? "settling" : "idle");
    root.current?.toggleAttribute("data-liquid-active", active);
    const preview = gesture.current?.moved ? enabledIndex(state.center, layout) : gesture.current?.pressed;
    buttons().forEach((button, index) => button.toggleAttribute("data-pressed", preview === index && enabled(index)));
    lens.current?.paint({ center: state.center, width: node.hidden ? 0 : state.width, press, velocity: state.velocity, reduced: reduced.current, active: active && !node.hidden, scaleX, scaleY });
  }
  function snap() {
    stopFrame();
    const layout = geometry.current, target = layout?.anchors[current.current.selected];
    if (!layout) return;
    Object.assign(motion.current, { ...(target ? { center: target.center, width: target.width } : {}), velocity: 0, widthVelocity: 0, press: 0, pressVelocity: 0, stretch: 0, stretchVelocity: 0 });
    paint();
  }
  function requestFrame() { if (frame.current === null) frame.current = requestAnimationFrame(tick); }
  function tick(time: number) {
    frame.current = null;
    const layout = geometry.current, target = layout?.anchors[current.current.selected];
    if (!layout) { previousFrame.current = null; return; }
    if (blocked()) { cancel(true); return; }
    const active = gesture.current;
    if (!target && !active) { snap(); return; }
    if (reduced.current) { if (active) { previousFrame.current = null; paint(); } else snap(); return; }
    const state = motion.current;
    const elapsed = previousFrame.current === null ? 1 / 60 : clamp((time - previousFrame.current) / 1000, .001, .032);
    previousFrame.current = time;
    const heldTarget = active?.held && !active.moved ? layout.anchors[active.pressed] : null;
    const destination = heldTarget || target;
    if ((!active || heldTarget) && destination) {
      [state.center, state.velocity] = spring(state.center, state.velocity, destination.center, elapsed, state.damping);
      [state.width, state.widthVelocity] = spring(state.width, state.widthVelocity, destination.width, elapsed);
    }
    const pressTarget = active ? active.held || active.moved ? 1 : .62 : 0;
    const lastSample = active?.samples.at(-1);
    const stretchTarget = active?.moved && lastSample && time - lastSample.time < 80 ? Math.min(.085, Math.abs(state.velocity) / 18000) : 0;
    [state.press, state.pressVelocity] = spring(state.press, state.pressVelocity, pressTarget, elapsed);
    [state.stretch, state.stretchVelocity] = spring(state.stretch, state.stretchVelocity, stretchTarget, elapsed);
    const shapeSettled = Math.abs(state.press - pressTarget) < .002 && Math.abs(state.pressVelocity) < .02 && Math.abs(state.stretch - stretchTarget) < .001 && Math.abs(state.stretchVelocity) < .02;
    const positionSettled = active && !heldTarget || destination && Math.abs(state.center - destination.center) < .05 && Math.abs(state.velocity) < .5 && Math.abs(state.width - destination.width) < .05 && Math.abs(state.widthVelocity) < .5;
    if (shapeSettled && positionSettled) {
      if (!active) { snap(); return; }
      state.press = pressTarget; state.pressVelocity = state.stretchVelocity = 0; state.stretch = stretchTarget; previousFrame.current = null;
      paint(); return;
    }
    requestFrame(); paint();
  }
  function animate() { if (reduced.current || blocked()) snap(); else requestFrame(); }
  function commit(index: number) {
    if (blocked() || !enabled(index)) { animate(); return; }
    if (index !== current.current.selected || current.current.allowReselect) { feedback(); current.current.onChange(current.current.items[index].value); }
    // Remain controlled: the next frame follows the value accepted by the owner.
    animate();
  }
  function releaseCapture(active: Gesture) {
    if (active.kind === "pointer" && root.current?.hasPointerCapture?.(active.id)) root.current.releasePointerCapture(active.id);
  }
  function cancel(immediate = false) {
    const active = gesture.current; gesture.current = null;
    clearHold();
    if (active) { releaseCapture(active); suppressUntil.current = performance.now() + 700; }
    motion.current.damping = 1;
    if (immediate) snap(); else animate();
    paint();
  }
  function measure() {
    const node = root.current, indicator = bubble.current;
    if (!node || !indicator) return;
    if (gesture.current) cancel(true);
    const rect = node.getBoundingClientRect(), nodes = [...node.querySelectorAll<HTMLButtonElement>(":scope > .glass-switch-item")];
    buttonNodes.current = nodes;
    const bounds = nodes.map(button => button.getBoundingClientRect());
    const anchors = bounds.map(bound => ({ center: bound.left + bound.width / 2 - rect.left - node.clientLeft, width: bound.width }));
    if (!anchors.length || anchors.some(anchor => anchor.width <= 0)) return;
    geometry.current = { left: rect.left + node.clientLeft, top: rect.top, bottom: rect.bottom, baseWidth: anchors[0].width, anchors };
    indicator.style.width = `${anchors[0].width}px`;
    indicator.style.top = `${bounds[0].top - rect.top - node.clientTop}px`;
    indicator.style.height = `${bounds[0].height}px`;
    lens.current?.configure({ root: node, items: nodes, width: anchors[0].width, height: bounds[0].height, top: bounds[0].top - rect.top - node.clientTop });
    if (!motion.current.initialized || reduced.current || blocked()) { motion.current.initialized = true; snap(); }
    else animate();
  }
  function down(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    if (blocked()) return;
    if (gesture.current) { cancel(); return; }
    // Scroll position can change between gestures; measure once on touch-down, never on move.
    measure();
    const layout = geometry.current;
    if (!layout) return;
    const pressed = hitAnchor(x - layout.left, layout.anchors);
    if (!enabled(pressed)) return;
    stopFrame(); suppressUntil.current = 0;
    if (current.current.selected < 0) Object.assign(motion.current, { center: layout.anchors[pressed].center, width: layout.anchors[pressed].width, velocity: 0 });
    gesture.current = { kind, id, startX: x, startY: y, lastX: x, lastY: y, origin: motion.current.center, pressed, preview: pressed, moved: false, held: false, samples: [{ x: motion.current.center, time }] };
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      const active = gesture.current;
      if (!active || active.id !== id || active.moved || blocked()) return;
      active.held = true; feedback(); requestFrame(); paint();
    }, current.current.glass.longPressMs);
    requestFrame(); paint();
  }
  function move(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const active = gesture.current, layout = geometry.current;
    if (!active || active.kind !== kind || active.id !== id || !layout) return false;
    if (blocked()) { cancel(true); return false; }
    let dx = x - active.startX;
    const dy = y - active.startY;
    if (!active.moved && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) { cancel(); return false; }
    if (!active.moved && Math.abs(dx) <= 6) return false;
    if (!active.moved) {
      if (active.held) { active.origin = motion.current.center; active.startX = active.lastX; dx = x - active.startX; }
      active.moved = true; clearHold();
      if (kind === "pointer") root.current?.setPointerCapture?.(id);
    }
    active.lastX = x; active.lastY = y;
    const state = motion.current;
    state.center = rubberCenter(active.origin + dx, layout.anchors); state.width = widthAt(state.center, layout.anchors);
    active.samples.push({ x: state.center, time });
    active.samples = active.samples.filter(sample => time - sample.time <= 80).slice(-6);
    const first = active.samples[0], last = active.samples.at(-1)!;
    state.velocity = last.time > first.time ? clamp((last.x - first.x) * 1000 / (last.time - first.time), -1800, 1800) : 0;
    const preview = enabledIndex(state.center, layout);
    if (preview >= 0 && preview !== active.preview) { active.preview = preview; feedback(); }
    requestFrame(); return true;
  }
  function up(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const active = gesture.current, layout = geometry.current;
    if (!active || active.kind !== kind || active.id !== id || !layout) return;
    if (blocked()) { cancel(true); return; }
    if (x !== active.lastX || y !== active.lastY) { move(kind, id, x, y, time); if (gesture.current !== active) return; }
    gesture.current = null; clearHold(); releaseCapture(active);
    // Both tap and drag handle release here; consume the browser's following click once.
    suppressUntil.current = performance.now() + 700;
    if (active.moved) {
      if (time - active.samples.at(-1)!.time > 80) motion.current.velocity = 0;
      motion.current.damping = Math.abs(motion.current.velocity) > 100 ? .88 : 1;
      commit(enabledIndex(projectedCenter(motion.current.center, motion.current.velocity, layout.anchors), layout));
    } else {
      motion.current.damping = 1;
      const anchor = layout.anchors[active.pressed];
      const inside = Math.abs(x - layout.left - anchor.center) <= anchor.width / 2 + 10 && y >= layout.top - 10 && y <= layout.bottom + 10;
      if (inside) commit(active.pressed); else animate();
    }
    paint();
  }
  useLayoutEffect(() => {
    const node = root.current!;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)"); reduced.current = preference.matches; measure();
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null; resize?.observe(node); buttons().forEach(button => resize?.observe(button));
    window.addEventListener("resize", measure);
    const onPreference = () => { reduced.current = preference.matches; cancel(true); };
    const pointerDown = (event: PointerEvent) => { if (event.pointerType === "touch") return; if (event.button !== 0 || event.isPrimary === false) { if (gesture.current) cancel(); return; } down("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerMove = (event: PointerEvent) => { if (event.pointerType !== "touch") move("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerUp = (event: PointerEvent) => { if (event.pointerType !== "touch") up("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
    const pointerCancel = (event: PointerEvent) => { if (gesture.current?.kind === "pointer" && gesture.current.id === event.pointerId) cancel(); };
    const touchStart = (event: TouchEvent) => { if (event.touches.length !== 1) { cancel(); return; } const touch = event.changedTouches[0]; if (touch) down("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp); };
    const multiTouch = (event: TouchEvent) => { if (gesture.current && event.touches.length > 1) cancel(); };
    const touchMove = (event: TouchEvent) => { if (gesture.current?.kind !== "touch") return; if (event.touches.length !== 1) { cancel(); return; } const touch = [...event.touches].find(item => item.identifier === gesture.current!.id); if (touch && move("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault(); };
    const touchEnd = (event: TouchEvent) => { if (gesture.current?.kind !== "touch") return; const touch = [...event.changedTouches].find(item => item.identifier === gesture.current!.id); if (touch) up("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp); };
    const touchCancel = () => { if (gesture.current?.kind === "touch") cancel(); };
    const contextMenu = (event: Event) => { if (gesture.current) event.preventDefault(); };
    const blur = () => cancel(true), visibility = () => { if (document.hidden) cancel(true); };
    // Portalled sheets inert the control's ancestors without changing its React props.
    const inertChanges = new window.MutationObserver(() => { if (blocked()) cancel(true); });
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) inertChanges.observe(parent, { attributes: true, attributeFilter: ["inert", "hidden", "class"] });
    node.addEventListener("pointerdown", pointerDown); node.addEventListener("lostpointercapture", pointerCancel);
    node.addEventListener("contextmenu", contextMenu);
    window.addEventListener("pointermove", pointerMove); window.addEventListener("pointerup", pointerUp); window.addEventListener("pointercancel", pointerCancel);
    node.addEventListener("touchstart", touchStart, { passive: true }); window.addEventListener("touchstart", multiTouch, { passive: true });
    window.addEventListener("touchmove", touchMove, { passive: false }); window.addEventListener("touchend", touchEnd); window.addEventListener("touchcancel", touchCancel);
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", visibility); preference.addEventListener?.("change", onPreference);
    return () => {
      const active = gesture.current; gesture.current = null;
      clearHold();
      if (active?.kind === "pointer" && node.hasPointerCapture?.(active.id)) node.releasePointerCapture(active.id);
      stopFrame(); resize?.disconnect(); inertChanges.disconnect(); window.removeEventListener("resize", measure); motion.current.initialized = false;
      node.removeEventListener("pointerdown", pointerDown); node.removeEventListener("lostpointercapture", pointerCancel);
      node.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerup", pointerUp); window.removeEventListener("pointercancel", pointerCancel);
      node.removeEventListener("touchstart", touchStart); window.removeEventListener("touchstart", multiTouch); window.removeEventListener("touchmove", touchMove); window.removeEventListener("touchend", touchEnd); window.removeEventListener("touchcancel", touchCancel);
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility); preference.removeEventListener?.("change", onPreference);
    };
  }, []);
  const structure = items.map(item => `${item.value}:${!!item.disabled}`).join("|");
  const materialKey = Object.values(current.current.glass).join(":");
  useLayoutEffect(() => { if (blocked()) cancel(true); else { if (gesture.current) cancel(true); measure(); } }, [selected, disabled, structure, materialKey]);

  function keydown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (blocked()) return;
    const available = items.map((_, itemIndex) => itemIndex).filter(enabled);
    const position = available.indexOf(index);
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const next = forward ? available[(position + 1) % available.length] : backward ? available[(position + available.length - 1) % available.length] : event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1) : undefined;
    if (next === undefined) return;
    event.preventDefault(); buttons()[next]?.focus();
    // Automatic radio/tab selection follows the standard arrow-key pattern.
    if (role !== "group") commit(next);
  }
  const focusIndex = selected >= 0 && enabled(selected) ? selected : items.findIndex(item => !item.disabled);
  return <div ref={root} className={`glass-switch ${className}`} data-glass-switch="" data-no-edge-back="" role={role} aria-label={ariaLabel} aria-describedby={ariaDescribedBy} aria-disabled={disabled || undefined}
    onClickCapture={event => {
      if (event.detail !== 0 && performance.now() < suppressUntil.current) { event.preventDefault(); event.stopPropagation(); suppressUntil.current = 0; }
    }}>
    <span ref={bubble} className="glass-switch-bubble" aria-hidden="true" hidden={selected < 0} />
    <LiquidLens ref={lens} options={glass} />
    {items.map((item, index) => <button type="button" key={item.value} id={item.id}
      className={`glass-switch-item ${index === selected ? "on" : ""}`} disabled={disabled || item.disabled}
      role={role === "tablist" ? "tab" : role === "radiogroup" ? "radio" : undefined}
      aria-label={item.accessibleLabel} aria-controls={item.controls}
      aria-selected={role === "tablist" ? index === selected : undefined}
      aria-checked={role === "radiogroup" ? index === selected : undefined}
      aria-pressed={role === "group" ? index === selected : undefined}
      tabIndex={role === "group" || index === focusIndex ? 0 : -1}
      onClick={() => commit(index)} onKeyDown={event => keydown(event, index)}><span className="glass-switch-content" data-liquid-content="">{item.label}</span></button>)}
  </div>;
}
