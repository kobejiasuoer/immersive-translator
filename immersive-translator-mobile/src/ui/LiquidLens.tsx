import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { inverseLensPath, lensOutlinePath, lensTextures, resolveGlassOptions, type LiquidGlassOptions } from "./liquidOptics";
import "./liquidGlass.css";

export interface LiquidLensGeometry {
  root: HTMLElement;
  items: readonly HTMLElement[];
  width: number;
  height: number;
  /** Relative to the root's padding box, matching the indicator's top. */
  top: number;
}
export interface LiquidLensFrame {
  center: number; width: number; press: number; velocity: number;
  reduced: boolean; active: boolean;
  /** Complete indicator scales, when its owner uses a smoothed stretch spring. */
  scaleX?: number; scaleY?: number;
}
export interface LiquidLensHandle {
  configure: (geometry: LiquidLensGeometry) => void;
  paint: (frame: LiquidLensFrame) => void;
}
interface SourceItem { original: HTMLElement; target: HTMLElement; clone: HTMLElement; color: string; left: number; top: number; width: number; height: number; clip: SVGPathElement; previousClip: string }
const svgNS = "http://www.w3.org/2000/svg";
const typography = ["font", "font-kerning", "font-optical-sizing", "font-feature-settings", "letter-spacing", "line-height", "text-align", "white-space", "overflow-wrap", "color", "opacity"];
const layoutStyles = ["display", "align-items", "justify-content", "flex-direction", "gap", "padding", "border", "border-radius", "box-sizing"];

/** Mirrors only visual content. No cloned ids, handlers, form values or focus targets. */
function visualCopy(original: HTMLElement): HTMLElement {
  const clone = document.createElement("span");
  clone.className = "liquid-lens-item";
  for (const node of original.childNodes) clone.append(node.cloneNode(true));
  const originals = [original, ...original.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  copies.forEach((node, index) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === "id" || attribute.name.startsWith("on") || attribute.name.startsWith("aria-") || ["role", "tabindex", "name", "for", "autofocus", "data-liquid-content"].includes(attribute.name)) node.removeAttribute(attribute.name);
    }
    const source = originals[index];
    if (!source) return;
    const computed = window.getComputedStyle(source);
    for (const property of typography) node.style.setProperty(property, computed.getPropertyValue(property));
    for (const property of layoutStyles) node.style.setProperty(property, computed.getPropertyValue(property));
    if (node !== clone) for (const property of ["position", "top", "right", "bottom", "left", "width", "height", "min-width", "margin", "background-color", "flex", "align-self", "vertical-align"]) node.style.setProperty(property, computed.getPropertyValue(property));
    if (node !== clone && computed.color === window.getComputedStyle(original).color) node.style.color = "inherit";
    node.style.clipPath = "none";
    node.style.setProperty("pointer-events", "none");
    if (node instanceof HTMLElement) node.tabIndex = -1;
  });
  clone.style.position = "absolute";
  clone.style.margin = "0";
  clone.style.background = "transparent";
  clone.style.clipPath = "none";
  clone.style.transform = "none";
  clone.style.transition = "none";
  return clone;
}

/** An SVG-filtered optical replay for WebKit as well as Chromium.
 * CSS backdrop-filter:url() is deliberately not required: Safari can blur a
 * backdrop, but does not reliably run arbitrary SVG backdrop filters. This
 * component refracts the control's icon/text plane; the page behind stays CSS glass.
 * The owner alone owns RAF. configure may read layout; paint never does. */
export const LiquidLens = forwardRef<LiquidLensHandle, { options?: Partial<LiquidGlassOptions> }>(function LiquidLens({ options }, forwardedRef) {
  const identifier = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const shell = useRef<HTMLSpanElement>(null), plane = useRef<HTMLSpanElement>(null), source = useRef<HTMLSpanElement>(null), clipDefs = useRef<SVGDefsElement>(null), aperture = useRef<SVGPathElement>(null);
  const filter = useRef<SVGFilterElement>(null), mainMap = useRef<SVGFEImageElement>(null), edgeMap = useRef<SVGFEImageElement>(null);
  const refraction = useRef<SVGFEDisplacementMapElement>(null), red = useRef<SVGFEDisplacementMapElement>(null), blue = useRef<SVGFEDisplacementMapElement>(null), blur = useRef<SVGFEGaussianBlurElement>(null);
  const normalUnits = useRef<SVGFEColorMatrixElement>(null), edgeUnits = useRef<SVGFEColorMatrixElement>(null), planeWidth = useRef(1);
  const geometry = useRef<LiquidLensGeometry | null>(null), sources = useRef<SourceItem[]>([]);
  const frame = useRef<LiquidLensFrame | null>(null), ready = useRef(false), opaque = useRef(false);
  const configuration = useRef(0);
  const material = useRef(resolveGlassOptions(options)); material.current = resolveGlassOptions(options);

  function restoreClips() {
    for (const item of sources.current) item.target.style.clipPath = item.previousClip;
  }
  function paint(next: LiquidLensFrame) {
    frame.current = next;
    const node = shell.current, layout = geometry.current, content = source.current, opticalPlane = plane.current;
    if (!node || !layout || !content || !opticalPlane) return;
    const visible = ready.current && !next.reduced && !opaque.current && next.width > 0;
    node.hidden = !visible;
    opticalPlane.hidden = !visible;
    if (!visible) { restoreClips(); return; }
    const press = Math.max(0, Math.min(1, next.press));
    const stretch = Math.min(.1, Math.abs(next.velocity) / 16000);
    const sx = next.scaleX ?? next.width / layout.width * (1 + stretch + press * .045), sy = next.scaleY ?? 1 + press * .10 - stretch * .55;
    const left = next.center - layout.width / 2;
    node.style.transform = `translate3d(${left}px,0,0) scale(${sx},${sy})`;
    node.style.setProperty("--lens-press", String(press));
    node.style.setProperty("--lens-light-x", `${Math.max(12, Math.min(88, 50 + next.velocity / 48))}%`);
    node.toggleAttribute("data-active", next.active);
    const scale = (material.current.ior - 1) * 24 * (.45 + press * .55);
    refraction.current?.setAttribute("scale", String(scale / layout.height));
    red.current?.setAttribute("scale", String(material.current.dispersion * 2 * (.4 + press * .6) / layout.height));
    blue.current?.setAttribute("scale", String(-material.current.dispersion * 2 * (.4 + press * .6) / layout.height));
    const visibleWidth = layout.width * sx, visibleHeight = layout.height * sy;
    // Sample a stationary control plane. Only the local map and aperture move;
    // the bounded SVG source never needs a moving CSS transform or layout read.
    const filterLeft = next.center - visibleWidth / 2, filterTop = (layout.height - visibleHeight) / 2;
    aperture.current?.setAttribute("d", lensOutlinePath(filterLeft, filterTop, visibleWidth, visibleHeight));
    for (const element of [mainMap.current, edgeMap.current]) if (element) {
      element.setAttribute("x", String(filterLeft / planeWidth.current)); element.setAttribute("y", String(filterTop / layout.height));
      element.setAttribute("width", String(visibleWidth / planeWidth.current)); element.setAttribute("height", String(visibleHeight / layout.height));
    }
    for (const item of sources.current) {
      // Only the explicit visual wrapper is clipped. The button itself retains
      // its hit box and focus ring. A small overlap covers antialiasing seams.
      item.clip.setAttribute("d", inverseLensPath(next.center - visibleWidth / 2 - item.left + .3, layout.top + (layout.height - visibleHeight) / 2 - item.top + .3, visibleWidth - .6, visibleHeight - .6, item.width, item.height));
      item.target.style.clipPath = `url(#${item.clip.parentElement!.id})`;
      const selected = item.original.classList.contains("on") || item.original.hasAttribute("data-pressed");
      item.clone.style.color = selected ? "var(--accent)" : item.color;
    }
  }
  function configure(next: LiquidLensGeometry) {
    const revision = ++configuration.current;
    restoreClips();
    geometry.current = next;
    const node = shell.current, content = source.current, defs = clipDefs.current, opticalPlane = plane.current;
    if (!node || !content || !defs || !opticalPlane || next.width <= 0 || next.height <= 0) return;
    const map = lensTextures(next.width, next.height, material.current.edgeWidth);
    ready.current = map?.decoded ?? false;
    node.dataset.optics = map ? map.decoded ? "svg-replay" : "loading" : "static";
    node.style.width = `${next.width}px`; node.style.height = `${next.height}px`; node.style.top = `${next.top}px`;
    if (!map) { sources.current = []; node.hidden = true; opticalPlane.hidden = true; return; }
    for (const [image, uri] of [[mainMap.current!, map.displacement], [edgeMap.current!, map.edge]] as const) {
      image.setAttribute("href", uri); image.setAttribute("width", String(next.width)); image.setAttribute("height", String(next.height));
    }
    const rootBounds = next.root.getBoundingClientRect();
    planeWidth.current = rootBounds.width;
    // WebKit resolves userSpaceOnUse on CSS-filtered HTML against its viewport
    // position. Fully normalized coordinates avoid wrong labels/empty captures
    // as the page scrolls. R is compressed so X and Y still displace equally in px.
    const ratio = next.height / rootBounds.width;
    const units = `${ratio} 0 0 0 ${.5 * (1 - ratio)}  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0`;
    normalUnits.current!.setAttribute("values", units); edgeUnits.current!.setAttribute("values", units);
    blur.current!.setAttribute("stdDeviation", `${material.current.blur / rootBounds.width} ${material.current.blur / next.height}`);
    for (const primitive of [...filter.current!.children]) if (primitive.tagName.toLowerCase() !== "feimage") {
      primitive.setAttribute("x", "0"); primitive.setAttribute("y", "0");
      primitive.setAttribute("width", "1"); primitive.setAttribute("height", "1");
    }
    content.style.width = `${rootBounds.width}px`; content.style.height = `${next.height}px`;
    Object.assign(opticalPlane.style, { top: `${next.top}px`, width: `${rootBounds.width}px`, height: `${next.height}px` });
    const children = next.items.flatMap((original, index) => {
      const target = original.querySelector<HTMLElement>("[data-liquid-content]");
      // Opt in explicitly; never silently change a caller's button hit testing.
      if (!target) return [];
      const bounds = original.getBoundingClientRect(), visualBounds = target.getBoundingClientRect(), clone = visualCopy(original);
      const disabled = original.matches(":disabled, [aria-disabled=true]");
      // Do not freeze an intermediate :active/colour-transition presentation in
      // the replay. These shared controls use semantic theme variables instead.
      const color = disabled ? "var(--ink-3)" : next.root.matches(".glass-nav") ? "var(--ink-3)" : next.root.matches(".glass-switch") ? "var(--ink-2)" : window.getComputedStyle(original).color;
      clone.style.opacity = disabled ? ".42" : "1";
      const left = visualBounds.left - rootBounds.left - next.root.clientLeft;
      const top = visualBounds.top - rootBounds.top - next.root.clientTop;
      Object.assign(clone.style, { left: `${bounds.left - rootBounds.left - next.root.clientLeft}px`, top: `${bounds.top - rootBounds.top - next.root.clientTop - next.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      const clipPath = document.createElementNS(svgNS, "clipPath");
      clipPath.id = `${identifier}-clip-${index}`; clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
      const clip = document.createElementNS(svgNS, "path"); clip.setAttribute("clip-rule", "evenodd"); clipPath.append(clip);
      defs.append(clipPath);
      return [{ original, target, clone, color, left, top, width: visualBounds.width, height: visualBounds.height, clip, previousClip: target.style.clipPath }];
    });
    // Replace existing definitions instead of leaving duplicate IDs after remeasure.
    defs.replaceChildren(...children.map(item => item.clip.parentNode!));
    sources.current = children; content.replaceChildren(...children.map(item => item.clone));
    if (frame.current) paint(frame.current);
    if (!map.decoded) void map.ready.then(decoded => {
      if (revision !== configuration.current || !shell.current) return;
      ready.current = decoded; shell.current.dataset.optics = decoded ? "svg-replay" : "static";
      if (frame.current) paint(frame.current);
    });
  }

  useImperativeHandle(forwardedRef, () => ({ configure, paint }), []);
  useLayoutEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)");
    const update = () => { opaque.current = preference.matches; if (frame.current) paint(frame.current); };
    update(); preference.addEventListener?.("change", update);
    const theme = new window.MutationObserver(() => { if (geometry.current) configure(geometry.current); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => { configuration.current++; restoreClips(); preference.removeEventListener?.("change", update); theme.disconnect(); };
  }, []);

  return <>
    <svg className="liquid-lens-defs" aria-hidden="true" focusable="false" width="0" height="0">
      <defs ref={clipDefs} />
      <defs>
        <clipPath id={`${identifier}-aperture`} clipPathUnits="userSpaceOnUse"><path ref={aperture} /></clipPath>
        <filter ref={filter} id={`${identifier}-filter`} x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
          <feImage ref={mainMap} result="normal-texture" x="0" y="0" preserveAspectRatio="none" />
          <feImage ref={edgeMap} result="edge-texture" x="0" y="0" preserveAspectRatio="none" />
          <feColorMatrix ref={normalUnits} in="normal-texture" type="matrix" result="normal" />
          <feColorMatrix ref={edgeUnits} in="edge-texture" type="matrix" result="edge" />
          <feDisplacementMap ref={refraction} in="SourceGraphic" in2="normal" scale="0" xChannelSelector="R" yChannelSelector="G" result="refracted" />
          <feGaussianBlur ref={blur} in="refracted" stdDeviation="0" result="soft" />
          <feDisplacementMap ref={red} in="soft" in2="edge" scale="0" xChannelSelector="R" yChannelSelector="G" result="red-shift" />
          <feDisplacementMap ref={blue} in="soft" in2="edge" scale="0" xChannelSelector="R" yChannelSelector="G" result="blue-shift" />
          <feColorMatrix in="red-shift" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feColorMatrix in="soft" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
          <feColorMatrix in="blue-shift" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
          {/* Average coverage before restoring RGB. Adding three full alpha
              channels would darken antialiased glyph edges even at zero dispersion. */}
          <feComposite in="red" in2="green" operator="arithmetic" k2="0.333333" k3="0.333333" result="red-green" />
          <feComposite in="red-green" in2="blue" operator="arithmetic" k2="1" k3="0.333333" result="rgb" />
          <feColorMatrix in="rgb" type="matrix" values="3 0 0 0 0  0 3 0 0 0  0 0 3 0 0  0 0 0 1 0" />
        </filter>
      </defs>
    </svg>
    <span ref={plane} className="liquid-lens-plane" aria-hidden="true" inert hidden style={{ clipPath: `url(#${identifier}-aperture)` }}>
      <span ref={source} className="liquid-lens-source" style={{ filter: `url(#${identifier}-filter)` }} />
    </span>
    <span ref={shell} className="liquid-lens" aria-hidden="true" inert hidden>
      <span className="liquid-lens-rim" />
    </span>
  </>;
});
