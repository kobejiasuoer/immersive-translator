(() => {
  "use strict";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const header = document.querySelector(".site-header");
  const chapters = [...document.querySelectorAll(".chapter")];
  const menu = document.querySelector(".mobile-menu");
  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    const entrances = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.08 },
    );
    document.querySelectorAll(".enter").forEach((element) => entrances.observe(element));
  }
  let scrollQueued = false;
  function updateHeader() {
    scrollQueued = false;
    const edge = header.getBoundingClientRect().bottom;
    const chapter = chapters.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top <= edge && rect.bottom > edge;
    });
    header.classList.toggle("on-dark", chapter?.dataset.tone === "dark");
  }
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(updateHeader);
    },
    { passive: true },
  );
  window.addEventListener("resize", updateHeader);
  updateHeader();
  menu.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      menu.open = false;
    }),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  const scenes = {
    reading: "原文查词，带着这一句开口。",
    speaking: "场景对话，改进表达与发音。",
    review: "原句生词，到期再练一次。",
  };
  const controls = document.querySelector(".scene-controls");
  const buttons = [...controls.querySelectorAll("button")];
  const panels = [...document.querySelectorAll(".scene-panel")];
  controls.hidden = false;
  buttons.forEach((button) =>
    button.addEventListener("click", () => {
      const name = button.dataset.scene;
      if (!(name in scenes) || button.getAttribute("aria-pressed") === "true") return;
      buttons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      panels.forEach((panel) => {
        panel.hidden = panel.id !== `scene-${name}`;
        panel.classList.remove("is-changing");
        if (!panel.hidden && !reducedMotion.matches) {
          void panel.offsetWidth;
          panel.classList.add("is-changing");
        }
      });
      document.getElementById("scene-description").textContent = scenes[name];
    }),
  );
  const viewer = document.querySelector(".image-viewer");
  const viewerImage = viewer.querySelector("img");
  const viewerScroll = viewer.querySelector(".viewer-scroll");
  let sourceLink = null;
  if (typeof viewer.showModal === "function") {
    document.querySelectorAll(".zoom").forEach((link) =>
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        sourceLink = link;
        const original = link.querySelector("img");
        viewerImage.src = link.href;
        viewerImage.alt = original.alt;
        const wide = Number(link.dataset.fullWidth || original.getAttribute("width")) > 800;
        viewerScroll.classList.toggle("wide-image", wide);
        viewer.classList.toggle("detail-view", !wide);
        viewer.showModal();
        viewerScroll.scrollTo(0, 0);
      }),
    );
    viewer.querySelector(".viewer-close").addEventListener("click", () => viewer.close());
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer) viewer.close();
    });
    viewer.addEventListener("close", () => sourceLink?.focus({ preventScroll: true }));
  }
})();
