import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "ita-speech-endpoint-"));
let checks = 0;
const pass = label => { checks++; console.log("PASS " + label); };
try {
  const outfile = join(directory, "endpoint.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/services/speechEndpoint.ts", import.meta.url))], outfile, bundle: true, platform: "browser", format: "esm" });
  const { createSpeechEndpoint } = await import(pathToFileURL(outfile).href);
  function fixture(options) {
    const detector = createSpeechEndpoint(options);
    let at = -128, result = { speechStarted: false, shouldStop: false };
    return {
      feed(level, count = 1) { for (let i = 0; i < count; i++) result = detector.sample(level, at += 128); return result; },
      sample(level, time) { at = time; return result = detector.sample(level, at); },
      get at() { return at; },
      get result() { return result; },
    };
  }

  for (const level of [0, 0.001, 0.004, 0.007]) {
    const f = fixture();
    assert.deepEqual(f.feed(level, 120), { speechStarted: false, shouldStop: false });
  }
  pass("initial silence and steady low background noise never arm automatic completion");

  const pop = fixture(); pop.feed(0.001, 10);
  // A single loud input followed by audio.ts's actual smoothing decay.
  for (let i = 0; i < 24; i++) assert.equal(pop.feed(0.35 * 0.6 ** i).speechStarted, false);
  assert.deepEqual(pop.feed(0.001, 24), { speechStarted: false, shouldStop: false });
  pass("a short pop and its smoothed falling tail cannot masquerade as sustained speech");

  const phrase = fixture(); phrase.feed(0.001, 8); phrase.feed(0.04, 5);
  assert.equal(phrase.result.speechStarted, false);
  phrase.feed(0.04, 3); assert.equal(phrase.result.speechStarted, true);
  phrase.feed(0.001, 16); assert.equal(phrase.result.shouldStop, false);
  assert.equal(phrase.feed(0.001).shouldStop, true);
  assert.equal(phrase.feed(0.1).shouldStop, true, "The completed decision stays latched for this recording");
  pass("sustained speech is required before approximately two seconds of observed quiet ends a turn");

  const resumed = fixture(); resumed.feed(0.04, 8); resumed.feed(0.001, 13);
  resumed.feed(0.03, 3); resumed.feed(0.001, 16);
  assert.equal(resumed.result.shouldStop, false);
  assert.equal(resumed.feed(0.001).shouldStop, true);
  pass("speaking again during a pause restarts the quiet window instead of cutting off the resumed phrase");

  const soft = fixture({ minimumLevel: 0.003 }); soft.feed(0.0005, 8); soft.feed(0.0045, 8);
  assert.equal(soft.result.speechStarted, true); assert.equal(soft.feed(0.0005, 17).shouldStop, true);
  const noisy = fixture({ minimumLevel: 0.025 }); noisy.feed(0.02, 24);
  assert.equal(noisy.result.speechStarted, false); noisy.feed(0.085, 8);
  assert.equal(noisy.result.speechStarted, true); assert.equal(noisy.feed(0.02, 17).shouldStop, true);
  pass("calibration can accommodate a quieter voice or an established louder background");

  for (const invalid of [NaN, Infinity, -0.1, 1.1]) {
    const f = fixture(); f.feed(0.04, 8); f.feed(0.001, 13);
    f.sample(invalid, f.at + 2_500); assert.equal(f.result.shouldStop, false);
    f.feed(0.001, 16); assert.equal(f.result.shouldStop, false);
    assert.equal(f.feed(0.001).shouldStop, true);
  }
  pass("invalid levels break continuity and never supply phantom quiet time");

  const stalled = fixture(); stalled.feed(0.04, 8); stalled.feed(0.001, 3);
  stalled.sample(0.001, stalled.at + 5_000); assert.equal(stalled.result.shouldStop, false);
  stalled.feed(0.001, 15); assert.equal(stalled.result.shouldStop, false);
  assert.equal(stalled.feed(0.001).shouldStop, true);
  const missingOnset = fixture(); missingOnset.feed(0.04, 2); missingOnset.sample(0.04, 5_000);
  assert.equal(missingOnset.result.speechStarted, false);
  pass("long callback gaps count as missing audio rather than speech or silence");

  const clock = fixture(); clock.feed(0.04, 8); clock.feed(0.001, 14);
  assert.equal(clock.sample(0.001, clock.at).shouldStop, false);
  clock.sample(0.001, 0); clock.feed(0.001, 16); assert.equal(clock.result.shouldStop, false);
  assert.equal(clock.feed(0.001).shouldStop, true);
  const noTime = fixture(); noTime.feed(0.04, 8); noTime.sample(0.001, NaN);
  assert.equal(noTime.result.shouldStop, false);
  pass("duplicate, backwards and invalid clocks cannot advance an endpoint decision");

  const brief = fixture();
  for (let i = 0; i < 5; i++) { brief.feed(0.05, 2); brief.feed(0.001, 6); }
  assert.deepEqual(brief.result, { speechStarted: false, shouldStop: false });
  pass("separate isolated bumps are not added together into an utterance");

  for (const options of [{ silenceMs: 0 }, { minSpeechMs: -1 }, { minimumLevel: NaN }, { minimumLevel: 2 }, { noiseMultiplier: 1 }, { maxSampleGapMs: Infinity }]) {
    assert.throws(() => createSpeechEndpoint(options), RangeError);
  }
  pass("invalid calibration fails explicitly instead of silently disabling the safeguards");
  console.log(`PASS: ${checks} speech endpoint regressions`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
