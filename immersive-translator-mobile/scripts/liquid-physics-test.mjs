import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'liquid-physics-'));
try {
  const outfile = join(directory, 'physics.mjs');
  await build({ stdin: { contents: 'export * from "./src/ui/navMotion";export * from "./src/ui/liquidOptics";', resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm' });
  const { springStep, resolveGlassOptions, capsuleDistance } = await import(pathToFileURL(outfile).href);
  // A closed-form solution should be independent of refresh rate, including
  // overdamped configurations exposed by the material tuning API.
  for (const damping of [.4, .82, 1, 1.6, 3]) {
    let sixty = [0, 450], oneTwenty = [0, 450];
    for (let i = 0; i < 60; i++) sixty = springStep(...sixty, 100, 1 / 60, damping);
    for (let i = 0; i < 120; i++) oneTwenty = springStep(...oneTwenty, 100, 1 / 120, damping);
    const exact = springStep(0, 450, 100, 1, damping);
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(sixty[i] - exact[i]) < 1e-8, `60Hz damping ${damping}`);
      assert.ok(Math.abs(oneTwenty[i] - exact[i]) < 1e-8, `120Hz damping ${damping}`);
    }
    let state = [0, 0];
    for (let i = 0; i < 1200; i++) state = springStep(...state, 100, 1 / 120, damping);
    assert.ok(Math.abs(state[0] - 100) < .001 && Math.abs(state[1]) < .01, `settled damping ${damping}`);
  }
  const safe = resolveGlassOptions({ ior: NaN, stiffness: Infinity, damping: -1, edgeWidth: 1000, blur: -3, dispersion: 100 });
  assert.equal(safe.ior, 1.34); assert.equal(safe.stiffness, 430);
  assert.equal(safe.damping, 10); assert.equal(safe.edgeWidth, 24);
  assert.equal(safe.blur, 0); assert.equal(safe.dispersion, 1.5);
  assert.equal(capsuleDistance(60, 26, 120, 52), -26);
  assert.equal(capsuleDistance(0, 26, 120, 52), 0);
  assert.ok(capsuleDistance(0, 0, 120, 52) > 0);
  for (let x = 0; x <= 120; x += 3) {
    assert.ok(Math.abs(capsuleDistance(x, 7, 120, 52) - capsuleDistance(120 - x, 45, 120, 52)) < 1e-8);
  }
  console.log('PASS: 60/120Hz equivalence, under/critical/overdamping, convergence, parameter bounds and capsule SDF symmetry');
} finally { await rm(directory, { recursive: true, force: true }); }
