type Drag = { id: number; x: number; y: number; dy: number; startedAt: number; taken: boolean };

/** 阅读/全局抽屉共用：只接管向下主指手势，编辑、选择文字与原生滚动保持各自行为。 */
export function attachSheetDrag(panel: HTMLElement, onClose: () => void): () => void {
  let drag: Drag | null = null;
  let clearClick: (() => void) | null = null;

  const selectedText = () => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && selection.anchorNode && panel.contains(selection.anchorNode);
  };
  const restore = () => {
    const previous = drag;
    drag = null;
    panel.style.transition = "";
    panel.style.transform = "";
    if (previous && panel.hasPointerCapture?.(previous.id)) panel.releasePointerCapture(previous.id);
  };
  const clearSyntheticClick = () => { clearClick?.(); clearClick = null; };
  const suppressSyntheticClick = (pointerId: number) => {
    clearSyntheticClick();
    const stopClick = (event: MouseEvent) => {
      const id = "pointerId" in event ? Number(event.pointerId) : null;
      const sameGesture = id === pointerId || (id === null && event.detail > 0 && event.target instanceof Node && panel.contains(event.target));
      clearSyntheticClick();
      if (sameGesture) { event.preventDefault(); event.stopPropagation(); }
    };
    /* 新的按下动作或超时都结束抑制，旧拖拽不能吞掉未来的正常点击。 */
    const timeout = window.setTimeout(clearSyntheticClick, 400);
    window.addEventListener("click", stopClick, true);
    window.addEventListener("pointerdown", clearSyntheticClick, true);
    clearClick = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("click", stopClick, true);
      window.removeEventListener("pointerdown", clearSyntheticClick, true);
    };
  };
  function down(event: PointerEvent) {
    if (event.isPrimary === false) { restore(); return; }
    if (drag || event.button !== 0 || panel.closest("[inert]")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("input,textarea,select,label,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='slider']") || selectedText()) return;
    const scroller = target.closest(".sheet-body");
    if (scroller && scroller.scrollTop > 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dy: 0, startedAt: performance.now(), taken: false };
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    if (selectedText()) { restore(); return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.taken) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      if (Math.abs(dx) >= Math.abs(dy) || dy <= 0) { restore(); return; }
      drag.taken = true;
      panel.style.transition = "none";
      panel.setPointerCapture?.(event.pointerId);
    }
    drag.dy = Math.max(0, dy);
    panel.style.transform = `translateY(${drag.dy}px)`;
  }
  function up(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const finished = drag;
    restore();
    if (!finished.taken) return;
    suppressSyntheticClick(finished.id);
    const velocity = finished.dy / Math.max(1, performance.now() - finished.startedAt);
    if (finished.dy > 120 || velocity > 0.4) onClose();
  }
  function cancel(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    restore();
  }

  restore();
  panel.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  panel.addEventListener("lostpointercapture", cancel);
  return () => {
    panel.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    panel.removeEventListener("lostpointercapture", cancel);
    restore();
    clearSyntheticClick();
  };
}
