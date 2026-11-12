import { prepare, layout } from "./pretext.js";

async function setupTextLayout() {
  const elements = [...document.querySelectorAll("[data-pretext]")];
  if (!elements.length) return;
  await document.fonts.ready;

  const prepared = new Map();
  const observedWidths = new WeakMap();
  let pendingFrame = null;

  function relayout() {
    pendingFrame = null;
    for (const element of elements) {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const previous = prepared.get(element);
      if (width <= 0) {
        if (previous) previous.width = 0;
        continue;
      }

      const text = element.textContent.replace(/\s+/g, " ").trim();
      const font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      let entry = previous;
      if (!entry || entry.text !== text || entry.font !== font) {
        entry = { handle: prepare(text, font), text, font, width: 0, lineHeight: 0 };
        prepared.set(element, entry);
      }
      if (entry.width === width && entry.lineHeight === lineHeight) continue;

      const { height } = layout(entry.handle, width, lineHeight);
      // Keep native wrapping available when punctuation or text-wrap changes a line break.
      const minHeight = height > 0 ? `${Math.ceil(height)}px` : "";
      if (element.style.minHeight !== minHeight) element.style.minHeight = minHeight;
      entry.width = width;
      entry.lineHeight = lineHeight;
    }
  }

  function queueRelayout() {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(relayout);
  }

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (observedWidths.get(entry.target) === width) continue;
        observedWidths.set(entry.target, width);
        queueRelayout();
      }
    });
    elements.forEach((element) => resizeObserver.observe(element));
  }
  // Font size and weight can change at a breakpoint even when a paragraph keeps its width.
  window.addEventListener("resize", queueRelayout, { passive: true });

  const editable = new URLSearchParams(location.search).get("edit") === "1";
  const mutationObserver = new MutationObserver(queueRelayout);
  elements.forEach((element) => {
    if (editable) element.contentEditable = "true";
    mutationObserver.observe(element, { characterData: true, subtree: true, childList: true });
  });

  relayout();
}

await setupTextLayout();
