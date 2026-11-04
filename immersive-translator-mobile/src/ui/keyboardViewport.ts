/** WKWebView 的键盘只缩可视视口；缩放时沿用最近的未缩放测量，避免把 pinch 当键盘。 */
export function startKeyboardViewportSync(): () => void {
  const viewport = window.visualViewport;
  const sync = () => {
    if (viewport && viewport.scale > 1) return;
    const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty("--kb-inset", inset > 120 ? `${Math.round(inset)}px` : "0px");
  };
  sync();
  viewport?.addEventListener("resize", sync);
  viewport?.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  return () => {
    viewport?.removeEventListener("resize", sync);
    viewport?.removeEventListener("scroll", sync);
    window.removeEventListener("resize", sync);
  };
}
