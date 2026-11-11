import { clamp, springStep } from "./navMotion";

const BACK_BUTTON = '[data-nav-back],header button[aria-label="返回"],.pnav button[aria-label="返回"],header button[aria-label="返回书架"],header button[aria-label="退出"]';
const CONTROLS = 'button,a,input,textarea,select,label,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="tablist"],[role="radiogroup"],.glass-nav,.glass-segments,.glass-switch,.seg,.learning-seg,[data-no-swipe-back],[data-no-edge-back]';
const EDGE = 24;
const BACK_PENDING = "data-nav-back-pending";
type Point = { x: number; time: number };
type Gesture = { kind: "pointer" | "touch"; id: number; x: number; y: number; origin: number; lastX: number; lastY: number; directionX: number; direction: -1 | 0 | 1; taken: boolean; samples: Point[]; surface: HTMLElement; button: HTMLButtonElement; width: number };
type BackRequest = Pick<Gesture, "surface" | "button" | "width">;
type Motion = { surface: HTMLElement; x: number; velocity: number; target: number; width: number; oldTransform: string; oldTransition: string; closing: boolean };

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[inert],[hidden],[aria-hidden="true"],.tab-inactive')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (node.matches(".sheet:not(.on),.push:not(.in),.push.out,.pane:not(.on)")) return false;
  }
  return true;
}

/** The back button is the only navigation authority: recording/draft/preview guards
 * remain exactly the same for a swipe and a tap. No route is popped here. */
export function attachEdgeBack(app: HTMLElement): () => void {
  let gesture: Gesture | null = null, motion: Motion | null = null;
  let backRequest: BackRequest | null = null;
  let frame: number | null = null, previousTime: number | null = null;
  let releaseFrame: number | null = null, suppressUntil = 0;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = preference.matches;

  const selectedText = () => { const selection = window.getSelection(); return Boolean(selection && !selection.isCollapsed && String(selection).trim()); };
  function currentSurface(): HTMLElement | null {
    const pushes = [...app.querySelectorAll<HTMLElement>('.push[data-push-id].in:not(.out):not(.tab-inactive)')].filter(visible);
    const page = pushes.at(-1) || [...app.querySelectorAll<HTMLElement>('.pane.on')].find(visible);
    if (!page) return null;
    // Local history/correction screens have their own back action, even without a push.
    const correction = [...page.querySelectorAll<HTMLElement>('.correction-layer')].filter(visible).at(-1);
    return correction || page;
  }
  function hasModal(surface: HTMLElement): boolean {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
      .some(modal => modal !== surface && !modal.classList.contains("push") && visible(modal));
  }
  function allowed(surface: HTMLElement): boolean {
    return currentSurface() === surface && visible(surface) && !hasModal(surface) && (window.visualViewport?.scale ?? 1) <= 1;
  }
  function stopFrame() { if (frame !== null) cancelAnimationFrame(frame); frame = null; previousTime = null; }
  function stopReleaseFrame() { if (releaseFrame !== null) cancelAnimationFrame(releaseFrame); releaseFrame = null; }
  function paint() {
    if (!motion) return;
    motion.surface.style.transform = reduced ? motion.oldTransform : `translate3d(${motion.x}px,0,0)`;
    motion.surface.style.transition = "none";
  }
  function restore() {
    stopFrame(); stopReleaseFrame(); backRequest = null;
    if (!motion) return;
    const { surface, oldTransform, oldTransition } = motion;
    surface.style.transform = oldTransform;
    surface.style.transition = oldTransition;
    surface.classList.remove("edge-back-dragging", "edge-back-settling", "edge-back-pending");
    motion = null;
  }
  function tick(time: number) {
    frame = null;
    if (!motion || !motion.surface.isConnected) { restore(); return; }
    if (!motion.closing && !allowed(motion.surface)) { restore(); return; }
    const elapsed = previousTime === null ? 1 / 60 : clamp((time - previousTime) / 1000, .001, .032);
    previousTime = time;
    [motion.x, motion.velocity] = springStep(motion.x, motion.velocity, motion.target, elapsed, 1, .27);
    motion.x = clamp(motion.x, 0, motion.width);
    paint();
    if (Math.abs(motion.x - motion.target) < .35 && Math.abs(motion.velocity) < 3) { restore(); return; }
    frame = requestAnimationFrame(tick);
  }
  function settle(target = 0, closing = false) {
    stopReleaseFrame(); backRequest = null;
    if (!motion) return;
    motion.target = target; motion.closing = closing;
    motion.surface.classList.remove("edge-back-dragging", "edge-back-pending");
    motion.surface.classList.add("edge-back-settling");
    if (reduced) { restore(); return; }
    stopFrame(); frame = requestAnimationFrame(tick);
  }
  function holdPendingBack() {
    if (!motion) return;
    stopFrame(); stopReleaseFrame();
    // The request now owns the gesture. Saving does not keep a RAF loop alive,
    // and its eventual exit starts from this same presentation position.
    motion.velocity = 0;
    if (!motion.surface.classList.contains("edge-back-pending")) {
      motion.surface.classList.remove("edge-back-dragging", "edge-back-settling");
      motion.surface.classList.add("edge-back-pending");
    }
  }
  function resolveBackRequest() {
    const request = backRequest;
    if (!request || !motion) return;
    const { surface, button, width } = request;
    if (!surface.isConnected || surface.closest('[hidden],[aria-hidden="true"],.tab-inactive,.pane:not(.on)')) { restore(); return; }
    // A real route pop wins even if its handler has not reached finally yet.
    if (surface.classList.contains("out")) { settle(width, true); return; }
    if (!allowed(surface) || !button.isConnected || !surface.contains(button)) { restore(); return; }
    if (button.hasAttribute(BACK_PENDING)) holdPendingBack();
    else settle();
  }
  function scheduleBackDecision() {
    if (releaseFrame !== null) return;
    releaseFrame = requestAnimationFrame(() => {
      releaseFrame = null;
      resolveBackRequest();
    });
  }
  function releaseCapture(active: Gesture) {
    if (active.kind === "pointer" && active.surface.hasPointerCapture?.(active.id)) active.surface.releasePointerCapture(active.id);
  }
  function cancel(immediate = false) {
    if (backRequest && !gesture && !immediate) return;
    const active = gesture; gesture = null;
    if (active) releaseCapture(active);
    if (immediate) restore(); else settle();
  }
  function down(kind: Gesture["kind"], id: number, x: number, y: number, time: number, target: EventTarget | null) {
    suppressUntil = 0;
    if (gesture) { cancel(); return; }
    if (backRequest || releaseFrame !== null || motion?.closing || selectedText()) return;
    const surface = currentSurface();
    if (!surface || !allowed(surface)) return;
    const element = target instanceof Element ? target : null;
    if (!element || element.closest(CONTROLS)) return;
    const button = [...surface.querySelectorAll<HTMLButtonElement>(BACK_BUTTON)].find(item => visible(item) && !item.disabled);
    if (!button || button.hasAttribute(BACK_PENDING)) return;
    const rect = surface.getBoundingClientRect();
    const offset = motion?.surface === surface ? motion.x : 0;
    const left = rect.left - (reduced ? 0 : offset);
    if (x < left || x > left + EDGE || y < rect.top || y > rect.bottom || rect.width <= 0) return;
    if (motion && motion.surface !== surface) restore();
    stopFrame();
    if (!motion) motion = { surface, x: 0, velocity: 0, target: 0, width: rect.width, oldTransform: surface.style.transform, oldTransition: surface.style.transition, closing: false };
    gesture = { kind, id, x, y, origin: motion.x, lastX: x, lastY: y, directionX: motion.x, direction: 0, taken: false, samples: [{ x: motion.x, time }], surface, button, width: rect.width };
  }
  function move(kind: Gesture["kind"], id: number, x: number, y: number, time: number): boolean {
    const active = gesture;
    if (!active || active.kind !== kind || active.id !== id || !motion) return false;
    if (!allowed(active.surface) || selectedText()) { cancel(true); return false; }
    const dx = x - active.x, dy = y - active.y;
    if (!active.taken) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 7) return false;
      if (dx <= 0 || Math.abs(dy) >= Math.abs(dx)) { cancel(); return false; }
      active.taken = true;
      active.surface.classList.add("edge-back-dragging");
      if (kind === "pointer") active.surface.setPointerCapture?.(id);
    }
    active.lastX = x; active.lastY = y;
    motion.x = clamp(active.origin + dx, 0, active.width);
    const directionalTravel = motion.x - active.directionX;
    if (Math.abs(directionalTravel) >= 4) { active.direction = directionalTravel > 0 ? 1 : -1; active.directionX = motion.x; }
    active.samples.push({ x: motion.x, time });
    active.samples = active.samples.filter((sample, index, samples) => index >= samples.length - 2 || time - sample.time <= 90).slice(-6);
    const first = active.samples[0], last = active.samples.at(-1)!;
    motion.velocity = last.time > first.time ? clamp((last.x - first.x) * 1000 / (last.time - first.time), -2200, 2200) : 0;
    paint();
    return true;
  }
  function up(kind: Gesture["kind"], id: number, x: number, y: number, time: number) {
    const active = gesture;
    if (!active || active.kind !== kind || active.id !== id || !motion) return;
    if (x !== active.lastX || y !== active.lastY) {
      move(kind, id, x, y, time);
      if (gesture !== active || !motion) return;
    }
    gesture = null; releaseCapture(active);
    if (!active.taken) { settle(); return; }
    suppressUntil = performance.now() + 500;
    if (!allowed(active.surface) || !visible(active.button) || active.button.disabled) { restore(); return; }
    if (time - active.samples.at(-1)!.time > 100) motion.velocity = 0;
    // Reversing the finger cancels even after a long outward drag.
    const commit = motion.x >= 36 && active.direction !== -1 && motion.velocity > -30 && motion.x + Math.max(0, motion.velocity) * .16 >= active.width * .4;
    if (!commit) { settle(); return; }
    backRequest = { surface: active.surface, button: active.button, width: active.width };
    active.button.click();
    // The business callback marks pending synchronously while it saves. A removed
    // marker gets one frame for React to commit .out before considering rollback.
    scheduleBackDecision();
  }

  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (event.button !== 0 || event.isPrimary === false) { cancel(); return; }
    down("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp, event.target);
  };
  const pointerMove = (event: PointerEvent) => { if (event.pointerType !== "touch" && move("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp) && event.cancelable) event.preventDefault(); };
  const pointerUp = (event: PointerEvent) => { if (event.pointerType !== "touch") up("pointer", event.pointerId, event.clientX, event.clientY, event.timeStamp); };
  const pointerCancel = (event: PointerEvent) => { if (gesture?.kind === "pointer" && gesture.id === event.pointerId) cancel(); };
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = event.changedTouches[0];
    if (touch) down("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.target);
  };
  const multiTouch = (event: TouchEvent) => { if (event.touches.length > 1) cancel(); };
  const touchMove = (event: TouchEvent) => {
    if (gesture?.kind !== "touch") return;
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = [...event.touches].find(item => item.identifier === gesture!.id);
    if (touch && move("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
  };
  const touchEnd = (event: TouchEvent) => {
    if (gesture?.kind !== "touch") return;
    const touch = [...event.changedTouches].find(item => item.identifier === gesture!.id);
    if (touch) up("touch", touch.identifier, touch.clientX, touch.clientY, event.timeStamp);
  };
  const touchCancel = () => { if (gesture?.kind === "touch") cancel(); };
  const click = (event: MouseEvent) => { if (event.detail !== 0 && performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); suppressUntil = 0; } };
  const interrupt = () => { if (gesture) cancel(true); else if (motion && !motion.closing) restore(); };
  const navigationChanged = () => { if (gesture) cancel(true); };
  const visibility = () => { if (document.hidden) interrupt(); };
  const preferenceChanged = () => { reduced = preference.matches; cancel(true); };
  const observer = new window.MutationObserver(() => {
    if (gesture && !allowed(gesture.surface)) { cancel(true); return; }
    if (backRequest) {
      const { surface, button } = backRequest;
      if (!surface.isConnected || surface.classList.contains("out") || !allowed(surface) || !button.isConnected) resolveBackRequest();
      else if (button.hasAttribute(BACK_PENDING)) holdPendingBack();
      else scheduleBackDecision();
    } else if (motion && !motion.surface.isConnected) restore();
  });
  observer.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "class", "hidden", "aria-hidden", BACK_PENDING] });
  app.addEventListener("pointerdown", pointerDown);
  app.addEventListener("touchstart", touchStart, { passive: true });
  app.addEventListener("lostpointercapture", pointerCancel);
  window.addEventListener("pointermove", pointerMove, { passive: false });
  window.addEventListener("pointerup", pointerUp); window.addEventListener("pointercancel", pointerCancel);
  window.addEventListener("touchstart", multiTouch, { passive: true });
  window.addEventListener("touchmove", touchMove, { passive: false });
  window.addEventListener("touchend", touchEnd); window.addEventListener("touchcancel", touchCancel);
  app.addEventListener("click", click, true);
  window.addEventListener("blur", interrupt); window.addEventListener("resize", interrupt);
  window.addEventListener("mobile-profile-change", interrupt); window.addEventListener("mobile-push-change", navigationChanged);
  document.addEventListener("visibilitychange", visibility);
  preference.addEventListener("change", preferenceChanged);
  return () => {
    observer.disconnect();
    stopReleaseFrame();
    cancel(true);
    app.removeEventListener("pointerdown", pointerDown); app.removeEventListener("touchstart", touchStart); app.removeEventListener("lostpointercapture", pointerCancel);
    window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerup", pointerUp); window.removeEventListener("pointercancel", pointerCancel);
    window.removeEventListener("touchstart", multiTouch); window.removeEventListener("touchmove", touchMove); window.removeEventListener("touchend", touchEnd); window.removeEventListener("touchcancel", touchCancel);
    app.removeEventListener("click", click, true);
    window.removeEventListener("blur", interrupt); window.removeEventListener("resize", interrupt);
    window.removeEventListener("mobile-profile-change", interrupt); window.removeEventListener("mobile-push-change", navigationChanged);
    document.removeEventListener("visibilitychange", visibility); preference.removeEventListener("change", preferenceChanged);
  };
}
