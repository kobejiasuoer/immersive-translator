export interface NavAnchor { center: number; width: number }
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Short decay projection reaches a neighbour without throwing a slight flick across the bar. */
export function projectedCenter(center: number, velocity: number, anchors: NavAnchor[]): number {
  const spacing = anchors.length > 1 ? (anchors.at(-1)!.center - anchors[0].center) / (anchors.length - 1) : 0;
  return center + clamp(velocity / 1000 * .99 / (1 - .99), -spacing * .75, spacing * .75);
}
export function nearestAnchor(center: number, anchors: NavAnchor[]): number {
  return anchors.reduce((best, anchor, index) => Math.abs(anchor.center - center) < Math.abs(anchors[best].center - center) ? index : best, 0);
}
export function hitAnchor(center: number, anchors: NavAnchor[]): number {
  const found = anchors.findIndex(anchor => center >= anchor.center - anchor.width / 2 && center <= anchor.center + anchor.width / 2);
  return found >= 0 ? found : nearestAnchor(center, anchors);
}
export function rubberCenter(center: number, anchors: NavAnchor[]): number {
  const edge = clamp(center, anchors[0].center, anchors.at(-1)!.center), beyond = center - edge;
  return edge + beyond * 32 * .55 / (32 + .55 * Math.abs(beyond));
}
export function widthAt(center: number, anchors: NavAnchor[]): number {
  for (let i = 1; i < anchors.length; i++) {
    if (center <= anchors[i].center) {
      const previous = anchors[i - 1], next = anchors[i];
      const progress = clamp((center - previous.center) / (next.center - previous.center), 0, 1);
      return previous.width + (next.width - previous.width) * progress;
    }
  }
  return anchors.at(-1)!.width;
}
/** Exact damped-spring solution: stable at 60/120Hz, retaining velocity on retarget. */
export function springStep(value: number, velocity: number, target: number, elapsed: number, damping = 1, response = .32): [number, number] {
  const omega = 2 * Math.PI / response, offset = value - target, decay = Math.exp(-damping * omega * elapsed);
  if (damping > 1.0001) {
    const root = Math.sqrt(damping * damping - 1);
    const slow = -omega / (damping + root), fast = -omega * (damping + root);
    const a = (velocity - fast * offset) / (slow - fast), b = offset - a;
    const slowPart = a * Math.exp(slow * elapsed), fastPart = b * Math.exp(fast * elapsed);
    return [target + slowPart + fastPart, slow * slowPart + fast * fastPart];
  }
  if (damping >= .9999) {
    const coefficient = velocity + omega * offset;
    return [target + (offset + coefficient * elapsed) * decay, (velocity - omega * coefficient * elapsed) * decay];
  }
  const frequency = omega * Math.sqrt(1 - damping * damping), coefficient = (velocity + damping * omega * offset) / frequency;
  const cos = Math.cos(frequency * elapsed), sin = Math.sin(frequency * elapsed);
  return [target + decay * (offset * cos + coefficient * sin), decay * ((coefficient * frequency - damping * omega * offset) * cos - (offset * frequency + damping * omega * coefficient) * sin)];
}
