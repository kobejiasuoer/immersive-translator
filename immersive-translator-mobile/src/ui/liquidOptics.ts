/** Shared physical/material controls. Lengths are CSS pixels, mass is one. */
export interface LiquidGlassOptions {
  ior: number;
  edgeWidth: number;
  dispersion: number;
  blur: number;
  stiffness: number;
  damping: number;
  longPressMs: number;
}

export const LIQUID_GLASS_DEFAULTS: Readonly<LiquidGlassOptions> = Object.freeze({
  ior: 1.34, edgeWidth: 10, dispersion: .35, blur: 0,
  stiffness: 430, damping: 34, longPressMs: 180,
});

const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;

export function resolveGlassOptions(options: Partial<LiquidGlassOptions> = {}): LiquidGlassOptions {
  const d = LIQUID_GLASS_DEFAULTS;
  return {
    ior: bounded(options.ior, d.ior, 1, 1.8),
    edgeWidth: bounded(options.edgeWidth, d.edgeWidth, 2, 24),
    dispersion: bounded(options.dispersion, d.dispersion, 0, 1.5),
    blur: bounded(options.blur, d.blur, 0, 2),
    stiffness: bounded(options.stiffness, d.stiffness, 100, 900),
    damping: bounded(options.damping, d.damping, 10, 70),
    longPressMs: bounded(options.longPressMs, d.longPressMs, 100, 500),
  };
}

export interface LensTexture { displacement: string; edge: string; decoded: boolean; ready: Promise<boolean> }
const textures = new Map<string, LensTexture>();

/** Signed distance to a capsule (a round box with radius half its height). */
export function capsuleDistance(x: number, y: number, width: number, height: number): number {
  const radius = Math.min(width, height) / 2;
  const qx = Math.abs(x - width / 2) - (width / 2 - radius);
  const qy = Math.abs(y - height / 2) - (height / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** A tiny, DPR-independent SDF normal texture. Generated only when geometry changes.
 * RGB stores signed x/y normals around .5; the second map has a neutral centre,
 * so chromatic separation cannot turn the middle of the label into coloured text. */
export function lensTextures(width: number, height: number, edgeWidth: number): LensTexture | null {
  if (typeof window === "undefined" || typeof window.CanvasRenderingContext2D === "undefined") return null;
  const key = `${Math.round(width)}:${Math.round(height)}:${Math.round(edgeWidth * 10)}`;
  const cached = textures.get(key);
  if (cached) { textures.delete(key); textures.set(key, cached); return cached; }
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(256, Math.max(32, Math.round(width)));
  canvas.height = Math.min(128, Math.max(24, Math.round(height)));
  const context = canvas.getContext("2d");
  if (!context) return null;
  const normal = context.createImageData(canvas.width, canvas.height);
  const edge = context.createImageData(canvas.width, canvas.height);
  const epsilon = .25;
  for (let py = 0; py < canvas.height; py++) for (let px = 0; px < canvas.width; px++) {
    const x = (px + .5) * width / canvas.width, y = (py + .5) * height / canvas.height;
    const distance = capsuleDistance(x, y, width, height);
    let nx = capsuleDistance(x + epsilon, y, width, height) - capsuleDistance(x - epsilon, y, width, height);
    let ny = capsuleDistance(x, y + epsilon, width, height) - capsuleDistance(x, y - epsilon, width, height);
    const length = Math.hypot(nx, ny);
    if (length > 0) { nx /= length; ny /= length; }
    const rim = Math.max(0, Math.min(1, 1 + distance / Math.min(edgeWidth, height / 2)));
    // The rounded shoulder compresses pixels at the rim; the shallow centre
    // samples toward its optical centre, producing a small convex magnification.
    const bend = Math.sin(rim * Math.PI * .9) * .78;
    const centre = (1 - rim) * .65;
    const dx = nx * bend - (x - width / 2) / (width / 2) * centre;
    const dy = ny * bend - (y - height / 2) / (width / 2) * centre;
    const i = (py * canvas.width + px) * 4;
    normal.data[i] = Math.round(127.5 + dx * 127.5);
    normal.data[i + 1] = Math.round(127.5 + dy * 127.5);
    normal.data[i + 2] = 128; normal.data[i + 3] = 255;
    edge.data[i] = Math.round(127.5 + nx * rim * rim * 127.5);
    edge.data[i + 1] = Math.round(127.5 + ny * rim * rim * 127.5);
    edge.data[i + 2] = 128; edge.data[i + 3] = 255;
  }
  context.putImageData(normal, 0, 0); const displacement = canvas.toDataURL();
  context.putImageData(edge, 0, 0); const edgeUrl = canvas.toDataURL();
  const result: LensTexture = { displacement, edge: edgeUrl, decoded: false, ready: Promise.resolve(false) };
  result.ready = Promise.all([displacement, edgeUrl].map(uri => {
    const image = new window.Image(); image.src = uri;
    return image.decode();
  })).then(() => { result.decoded = true; return true; }, () => false);
  textures.set(key, result);
  if (textures.size > 24) textures.delete(textures.keys().next().value!);
  return result;
}

export function lensOutlinePath(left: number, top: number, width: number, height: number): string {
  const radius = Math.min(width, height) / 2, right = left + width, bottom = top + height;
  return `M${left + radius} ${top}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${top + radius}V${bottom - radius}A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}H${left + radius}A${radius} ${radius} 0 0 1 ${left} ${bottom - radius}V${top + radius}A${radius} ${radius} 0 0 1 ${left + radius} ${top}Z`;
}

/** Clips a visual wrapper only; its enclosing button retains its full hit box. */
export function inverseLensPath(left: number, top: number, width: number, height: number, contentWidth = 1024, contentHeight = 128): string {
  return `M0 0H${contentWidth}V${contentHeight}H0Z ${lensOutlinePath(left, top, width, height)}`;
}
