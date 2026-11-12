(() => {
  "use strict";

  function bindToggle(controlId, panelId, stateAttribute, labels) {
    const control = document.getElementById(controlId);
    const panel = document.getElementById(panelId);
    if (!control || !panel) return;

    function updateState() {
      const visible = !panel.hidden;
      control.setAttribute(stateAttribute, String(visible));
      if (labels) control.textContent = visible ? labels.open : labels.closed;
    }

    control.setAttribute("aria-controls", panelId);
    updateState();
    control.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      updateState();
    });
    control.hidden = false;
  }

  bindToggle("demo-translation", "demo-translation-text", "aria-pressed", {
    open: "收起译文",
    closed: "看译文",
  });
  bindToggle("demo-word", "demo-word-meaning", "aria-expanded");
  bindToggle("demo-practice", "demo-practice-panel", "aria-expanded");
})();
