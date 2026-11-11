/**
 * Conservative end-of-turn detection from audio.ts's smoothed RMS callbacks.
 * This detects sound followed by quiet, not words or semantic completion. Steady
 * noise can require a manual stop; recording controls must remain available.
 */
export interface SpeechEndpointOptions {
  /** Quiet required after confirmed activity. */
  silenceMs?: number;
  /** Accumulated supported activity required before quiet can end a recording. */
  minSpeechMs?: number;
  /** Minimum RMS needed to start activity, adjustable for quiet voices. */
  minimumLevel?: number;
  /** Activity must also exceed the measured quiet-room level by this ratio. */
  noiseMultiplier?: number;
  /** Gaps longer than this are missing callbacks, never evidence of quiet. */
  maxSampleGapMs?: number;
}

export interface SpeechEndpointState {
  speechStarted: boolean;
  shouldStop: boolean;
}

export function createSpeechEndpoint(options: SpeechEndpointOptions = {}) {
  const silenceMs = options.silenceMs ?? 2_000;
  const minSpeechMs = options.minSpeechMs ?? 600;
  const minimumLevel = options.minimumLevel ?? 0.008;
  const noiseMultiplier = options.noiseMultiplier ?? 3;
  const maxSampleGapMs = options.maxSampleGapMs ?? 384;
  if (![silenceMs, minSpeechMs, minimumLevel, noiseMultiplier, maxSampleGapMs].every(value => Number.isFinite(value) && value > 0) || minimumLevel > 1 || noiseMultiplier <= 1) {
    throw new RangeError("Invalid speech endpoint settings");
  }

  let lastAt: number | undefined;
  let lastLevel: number | undefined;
  let noiseFloor = minimumLevel / 4;
  let supportedMs = 0;
  let lastSupportedAt: number | undefined;
  let quietSince: number | undefined;
  let speechStarted = false;
  let stopped = false;
  const state = (): SpeechEndpointState => ({ speechStarted, shouldStop: stopped });
  const breakContinuity = () => {
    lastAt = undefined;
    lastLevel = undefined;
    lastSupportedAt = undefined;
    supportedMs = 0;
    quietSince = undefined;
  };

  return {
    sample(level: number, atMs = Date.now()): SpeechEndpointState {
      if (stopped) return state();
      if (!Number.isFinite(level) || level < 0 || level > 1 || !Number.isFinite(atMs)) {
        breakContinuity();
        return state();
      }
      if (lastAt !== undefined && atMs <= lastAt) {
        // Duplicate/out-of-order callbacks cannot advance either duration.
        if (atMs < lastAt) breakContinuity();
        return state();
      }
      let elapsed = lastAt === undefined ? 0 : atMs - lastAt;
      if (elapsed > maxSampleGapMs) {
        breakContinuity();
        elapsed = 0;
      }
      const startLevel = Math.max(minimumLevel, noiseFloor * noiseMultiplier);
      const quietLevel = Math.max(minimumLevel * 0.65, noiseFloor * 1.6);

      if (!speechStarted) {
        // audio.ts smooths RMS with 0.6 * previous + 0.4 * current. A single
        // bump therefore has a long falling tail; that tail is not sustained
        // speaking. Require renewed/steady energy rather than counting decay.
        const supported = level >= startLevel && (lastLevel === undefined || level >= lastLevel * 0.8);
        if (supported) {
          if (lastSupportedAt !== undefined && atMs - lastSupportedAt <= maxSampleGapMs) supportedMs += elapsed;
          else supportedMs = 0;
          lastSupportedAt = atMs;
          if (supportedMs >= minSpeechMs) speechStarted = true;
        } else if (lastSupportedAt !== undefined && atMs - lastSupportedAt > maxSampleGapMs) {
          supportedMs = 0;
          lastSupportedAt = undefined;
        }
        // Only learn from quiet samples outside an activity candidate. Updating
        // from a spoken phrase would raise the floor and cut off a soft ending.
        if (lastSupportedAt === undefined && level < startLevel) {
          const alpha = 1 - Math.exp(-elapsed / 600);
          noiseFloor += (level - noiseFloor) * alpha;
        }
      }

      if (speechStarted) {
        if (level >= quietLevel) quietSince = undefined;
        else {
          quietSince ??= atMs;
          if (atMs - quietSince >= silenceMs) stopped = true;
        }
      }
      lastAt = atMs;
      lastLevel = level;
      return state();
    },
  };
}
