// Real browser acceptance in disposable profiles. This does not test native iOS
// haptics or GPU frame deadlines; the timing below measures browser RAF delivery.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || '/Users/yangbishang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5186';
const out = process.env.UI_SHOTS_DIR || fileURLToPath(new URL('../../docs/mobile-liquid-glass-2026-11-08/', import.meta.url));
const engines = (process.env.GLASS_BROWSERS || 'chromium,webkit').split(',');
const opticsOnly = process.env.GLASS_OPTICS_ONLY === '1';
await mkdir(out, { recursive: true });
const report = {
  scope: 'Isolated desktop browser processes; Chromium trusted CDP touch, both engines trusted pointer input and touchscreen taps. No physical iPhone or native haptic measurement.',
  timingScope: 'RAF delivery in the test process, not GPU/compositor completion or a guarantee of physical-device 60/120fps.',
  base, opticsOnly, runs: [],
};

const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liquid lens optical verification</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f6;font-family:system-ui;color:#13231c}.fixture-title{margin:24px 16px 0;font-size:16px}.fixture-note{margin:8px 16px;font-size:12px;color:#52605b}
#fixture{position:relative;display:flex;width:368px;height:76px;padding:4px;margin:56px auto;background:#e6eee9;border-radius:38px;isolation:isolate}
#fixture>button{position:relative;width:120px;height:68px;flex:none;display:flex;align-items:center;justify-content:center;margin:0;padding:0;border:0;background:transparent;color:#14241c}
[data-liquid-content]{display:flex;width:100%;height:100%;align-items:center;justify-content:center;pointer-events:none}
</style><h1 class="fixture-title">Bounded SDF optical fixture</h1><p class="fixture-note">The same colored bars, grid, and glyphs; only the SVG filter changes.</p><div id="fixture"></div></html>`;

function statistics(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95Ms: sorted[Math.floor(sorted.length * .95)] ?? null, maxMs: sorted.at(-1) ?? null,
    above20ms: sorted.filter(value => value > 20).length, above34ms: sorted.filter(value => value > 34).length };
}

async function run(engine) {
  const result = { engine, checks: [], screenshots: [], timing: null, optical: null };
  report.runs.push(result);
  const pass = (name, details) => { result.checks.push({ name, status: 'passed', ...(details ? { details } : {}) }); console.log(`PASS [${engine}] ${name}`); };
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: process.env.CHROME_CHANNEL || 'chrome' } : {}) });
  result.browserVersion = browser.version();
  const context = await browser.newContext({ ...playwright.devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    // Count only requests originating in the navigation component. The sampler
    // itself and unrelated application work are deliberately excluded.
    const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set();
    window.__glassAudit = { requested: 0, completed: 0, pending, textureEncodes: 0, inputs: [] };
    window.requestAnimationFrame = callback => {
      const navigation = /GlassNav\.tsx/.test(new Error().stack || '');
      let id = request(time => { if (navigation) { pending.delete(id); window.__glassAudit.completed++; } callback(time); });
      if (navigation) { pending.add(id); window.__glassAudit.requested++; }
      return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    const encode = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) { window.__glassAudit.textureEncodes++; return encode.apply(this, args); };
    for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'touchend']) {
      document.addEventListener(type, event => {
        if (event.target instanceof Element && event.target.closest('.glass-nav')) window.__glassAudit.inputs.push({ type, trusted: event.isTrusted });
      }, { capture: true, passive: true });
    }
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const nav = page.locator('.glass-nav'), tabs = nav.locator(':scope > .tab');
  const capture = async (name, locator = page) => {
    const filename = `${engine}-${name}.png`;
    await locator.screenshot({ path: `${out}/${filename}`, animations: 'disabled' });
    result.screenshots.push(filename);
  };
  const current = () => page.evaluate(async () => (await import('/src/store.ts')).getState().tab);
  const changes = () => page.evaluate(() => window.__glassChanges.slice());
  const resetChanges = () => page.evaluate(() => { window.__glassChanges.length = 0; });
  const phase = expected => page.waitForFunction(expected => document.querySelector('.glass-nav')?.getAttribute('data-glass-phase') === expected, expected);
  const selected = async index => {
    await page.waitForFunction(index => document.querySelectorAll('.glass-nav > .tab')[index]?.getAttribute('aria-current') === 'page', index);
    assert.equal(await nav.locator(':scope > [aria-current="page"]').count(), 1);
  };
  const settle = () => phase('idle');
  const choose = async index => { await tabs.nth(index).click(); await selected(index); await settle(); };
  const center = async index => { const rect = await tabs.nth(index).boundingBox(); assert.ok(rect); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
  async function pointerStart(index) { const point = await center(index); await page.mouse.move(point.x, point.y); await page.mouse.down(); return point; }
  async function pointerMove(point, steps = 1) { await page.mouse.move(point.x, point.y, { steps }); }
  async function pointerDrag(from, to, pause = true) {
    const start = await pointerStart(from), end = await center(to);
    for (let i = 1; i <= 12; i++) { await pointerMove({ x: start.x + (end.x - start.x) * i / 12, y: end.y }); await page.waitForTimeout(18); }
    if (pause) await page.waitForTimeout(130);
    return { start, end };
  }
  try {
    if (opticsOnly) {
      await page.close();
      result.optical = await opticalFixture(context, engine);
      pass('SDF refraction, RGB dispersion and zero-strength identity preserve the expected image', result.optical);
      result.status = 'passed';
      return;
    }
    await page.goto(base);
    await page.getByRole('button', { name: '先体验一篇短文', exact: true }).click();
    await page.getByRole('button', { name: '开始读第一篇', exact: true }).click();
    await selected(0); await settle();
    await page.evaluate(async () => {
      const { actions } = await import('/src/store.ts');
      const original = actions.setTab;
      window.__glassChanges = [];
      actions.setTab = key => { window.__glassChanges.push(key); return original(key); };
    });
    await nav.locator('.liquid-lens[data-optics="svg-replay"]').waitFor({ state: 'attached' });
    assert.equal(await tabs.count(), 3);
    for (let index = 0; index < 3; index++) {
      assert.equal(await tabs.nth(index).evaluate(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === button || button.contains(hit);
      }), true, `the optical clipping must preserve the full hit target for tab ${index}`);
    }
    pass('optical plane mounts and preserves all original button hit targets');

    await resetChanges();
    await pointerStart(0); await phase('pressed'); await phase('held');
    assert.equal(await current(), 'today'); assert.deepEqual(await changes(), []);
    await capture('nav-held'); await page.mouse.up(); await settle();
    pass('trusted pointer long press wakes the lens without committing a tab');

    await resetChanges();
    await page.evaluate(() => {
      window.__glassFilterNodes = [...document.querySelectorAll('.glass-nav filter')];
      window.__glassMapUris = [...document.querySelectorAll('.glass-nav feImage')].map(node => node.getAttribute('href'));
      window.__glassTextureStart = window.__glassAudit.textureEncodes;
      window.__glassTrace = { times: [], active: true };
      const tick = time => { window.__glassTrace.times.push(time); if (window.__glassTrace.active) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    });
    await pointerDrag(0, 2);
    await phase('dragging'); assert.equal(await current(), 'today'); assert.deepEqual(await changes(), []);
    await capture('nav-drag-before-release');
    const cache = await page.evaluate(() => ({
      sameFilters: window.__glassFilterNodes.every((node, i) => node === document.querySelectorAll('.glass-nav filter')[i]),
      sameMaps: window.__glassMapUris.every((uri, i) => uri === document.querySelectorAll('.glass-nav feImage')[i].getAttribute('href')),
      encodes: window.__glassAudit.textureEncodes - window.__glassTextureStart,
    }));
    assert.equal(cache.sameFilters, true); assert.equal(cache.sameMaps, true); assert.equal(cache.encodes, 0);
    await page.mouse.up(); await selected(2); await settle(); assert.deepEqual(await changes(), ['vocab']);
    const times = await page.evaluate(() => { window.__glassTrace.active = false; return window.__glassTrace.times; });
    result.timing = statistics(times.slice(1).map((time, i) => time - times[i]));
    pass('continuous multi-slot pointer drag commits exactly once on release and reuses filter nodes/textures', cache);
    await page.waitForFunction(() => window.__glassAudit.pending.size === 0);
    const beforeIdle = await page.evaluate(() => ({ count: window.__glassAudit.completed, pending: window.__glassAudit.pending.size }));
    await page.waitForTimeout(260);
    const afterIdle = await page.evaluate(() => ({ count: window.__glassAudit.completed, pending: window.__glassAudit.pending.size }));
    assert.ok(beforeIdle.count > 0, 'RAF instrumentation observed the navigation animation');
    assert.deepEqual(afterIdle, beforeIdle); assert.equal(afterIdle.pending, 0);
    pass('settled navigation releases its RAF and stays asleep', afterIdle);

    await choose(0); await resetChanges();
    const origin = await pointerStart(0), end = await center(1);
    await pointerMove(end, 6); await phase('dragging');
    // Release pointer capture through the DOM to exercise the real engine's
    // lostpointercapture handling. This cancellation itself is a test injection.
    await nav.evaluate(element => { for (let id = 1; id <= 10; id++) if (element.hasPointerCapture(id)) element.releasePointerCapture(id); });
    await page.mouse.up(); await settle();
    assert.equal(await current(), 'today'); assert.deepEqual(await changes(), []);
    pass('capture loss cancels a drag without committing');

    await resetChanges(); await pointerStart(0); await pointerMove({ x: origin.x + 3, y: origin.y - 35 }, 5); await page.mouse.up(); await settle();
    assert.equal(await current(), 'today'); assert.deepEqual(await changes(), []);
    pass('vertical intent cancels navigation without accidental activation');

    await tabs.nth(0).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await tabs.nth(1).evaluate(element => element === document.activeElement), true); assert.equal(await current(), 'today');
    await page.keyboard.press('Enter'); await selected(1); await settle();
    await page.keyboard.press('End'); await page.keyboard.press('Space'); await selected(2); await settle();
    await page.keyboard.press('Home'); assert.equal(await tabs.nth(0).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Space'); await selected(0); await settle();
    pass('keyboard focus, Enter and Space activation remain intact');

    const tap = await center(1); await page.touchscreen.tap(tap.x, tap.y); await selected(1); await settle();
    pass('trusted browser touchscreen tap selects the underlying button');

    if (engine === 'chromium') {
      await choose(0); await resetChanges();
      const cdp = await context.newCDPSession(page);
      const dispatch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1, radiusX: 1, radiusY: 1 }] : [] });
      const start = await center(0), target = await center(2);
      await dispatch('touchStart', start); await phase('held');
      for (let i = 1; i <= 12; i++) { await dispatch('touchMove', { x: start.x + (target.x - start.x) * i / 12, y: start.y }); await page.waitForTimeout(22); }
      assert.equal(await current(), 'today'); assert.deepEqual(await changes(), []); await phase('dragging');
      await capture('trusted-touch-drag'); await page.waitForTimeout(120); await dispatch('touchEnd'); await selected(2); await settle();
      assert.deepEqual(await changes(), ['vocab']);
      const back = await center(1); await resetChanges(); await dispatch('touchStart', target); await dispatch('touchMove', back); await dispatch('touchCancel'); await settle();
      assert.equal(await current(), 'vocab'); assert.deepEqual(await changes(), []);
      await cdp.detach();
      pass('trusted CDP touch supports long press, continuous drag, release-only commit and touchcancel');
    } else {
      result.checks.push({ name: 'continuous trusted touch drag', status: 'not available', details: 'Playwright WebKit exposes trusted taps but no public touch-move API; trusted pointer drag is tested. No synthetic stream is counted as physical touch.' });
    }
    const trusted = await page.evaluate(() => window.__glassAudit.inputs);
    assert.ok(trusted.some(event => event.type === 'touchstart' && event.trusted));
    assert.ok(trusted.some(event => event.type === 'pointermove' && event.trusted));

    for (const theme of ['light', 'dark']) {
      await page.evaluate(async theme => (await import('/src/store.ts')).actions.setTheme(theme), theme);
      for (const width of [320, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 }); await settle();
        const layout = await nav.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: innerWidth, buttons: [...element.querySelectorAll(':scope > .tab')].map(button => { const r = button.getBoundingClientRect(); return { w: r.width, h: r.height }; }), pageOverflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(layout.left >= 0 && layout.right <= width + 1); assert.equal(layout.pageOverflow, false);
        assert.ok(layout.buttons.every(button => button.w >= 44 && button.h >= 44));
        await capture(`${theme}-${width}`);
      }
    }
    pass('light/dark layouts fit 320/390/430/768px with 44px minimum touch targets');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => (await import('/src/store.ts')).actions.setTheme('light'));
    await choose(0); await page.emulateMedia({ reducedMotion: 'reduce' }); await settle();
    await pointerDrag(0, 1); assert.equal(await nav.locator('.liquid-lens').isVisible(), false);
    await page.mouse.up(); await selected(1); await settle();
    const scale = await nav.locator(':scope > .glass-bubble').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m22);
    assert.equal(scale, 1); await capture('reduced-motion');
    pass('reduced motion preserves dragging while removing optical motion and spring deformation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.emulateMedia({ contrast: 'more' });
    assert.equal(await nav.locator('.liquid-lens').isVisible(), false);
    const backdrop = await nav.evaluate(element => getComputedStyle(element).backdropFilter || getComputedStyle(element).webkitBackdropFilter);
    assert.equal(backdrop, 'none'); await capture('increased-contrast');
    pass('increased contrast removes optical replay and backdrop blur');
    await page.emulateMedia({ contrast: 'no-preference' });
    if (engine === 'chromium') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      await page.waitForFunction(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
      assert.equal(await nav.locator('.liquid-lens').isVisible(), false);
      assert.equal(await nav.evaluate(element => getComputedStyle(element).backdropFilter), 'none');
      await capture('reduced-transparency');
      await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
      pass('reduced transparency switches to a solid readable surface');
    } else result.checks.push({ name: 'reduced transparency media emulation', status: 'not available', details: 'No public Playwright WebKit emulation for this preference; native contrast media fallback is tested.' });

    assert.deepEqual(errors, [], 'the application has no runtime errors');
    await page.close();
    result.optical = await opticalFixture(context, engine, capture);
    pass('SDF filter changes visible pixels with independent refraction and RGB dispersion evidence', result.optical);
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = error.stack || String(error);
    if (!page.isClosed()) await capture('failure').catch(() => {});
    throw error;
  } finally {
    await browser.close();
    await writeFile(`${out}/${opticsOnly ? 'browser-optics-verification' : 'browser-verification'}.json`, JSON.stringify(report, null, 2) + '\n');
  }
}

async function opticalFixture(context, engine) {
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `${base}/__liquid-glass-fixture.html`;
  await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml }));
  await page.goto(url);
  await page.evaluate(async () => {
    const RefreshRuntime = (await import('/@react-refresh')).default;
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { LiquidLens } = await import('/src/ui/LiquidLens.tsx');
    const root = document.getElementById('fixture'), h = React.createElement;
    const lens = React.createRef();
    const bars = ['#d24b46', '#edaf35', '#397a54', '#267cba', '#7455a1'];
    function glyph(index) {
      return h('svg', { width: 114, height: 60, viewBox: '0 0 114 60', 'aria-hidden': true },
        ...bars.map((color, i) => h('rect', { key: 'bar' + i, x: i * 23, y: 0, width: 12, height: 60, fill: color, opacity: .65 })),
        ...[8, 20, 32, 44, 56].map(y => h('path', { key: 'row' + y, d: `M0 ${y}H114`, stroke: '#14251b', strokeWidth: 1 })),
        h('text', { x: 6, y: 29, fill: '#101810', fontSize: 17, fontWeight: 700 }, 'GLASS ' + index),
        h('text', { x: 12, y: 47, fill: '#101810', fontSize: 13 }, 'ABCDE'));
    }
    function Fixture({ options }) {
      React.useLayoutEffect(() => {
        lens.current.configure({ root, items: [...root.querySelectorAll(':scope>button')], width: 120, height: 68, top: 4 });
        lens.current.paint({ center: 150, width: 120, press: 1, velocity: 0, reduced: false, active: false });
        window.__fixtureReady = true;
      }, [options]);
      return h(React.Fragment, null, ...[0, 1, 2].map(index => h('button', { key: index, type: 'button' }, h('span', { 'data-liquid-content': '' }, glyph(index)))), h(LiquidLens, { ref: lens, options }));
    }
    const reactRoot = createRoot(root);
    window.__setOpticalOptions = options => { window.__fixtureReady = false; reactRoot.render(h(Fixture, { options })); };
    window.__setOpticalOptions({ ior: 1.48, edgeWidth: 15, dispersion: 1.1, blur: 0 });
  });
  await page.waitForFunction(() => window.__fixtureReady);
  await page.locator('#fixture .liquid-lens[data-optics="svg-replay"]').waitFor({ state: 'attached' });
  const fixture = page.locator('#fixture'), projection = fixture.locator('.liquid-lens-source');
  assert.equal(await fixture.locator('.liquid-lens').getAttribute('data-optics'), 'svg-replay');
  const filterValue = await projection.evaluate(element => element.style.filter);
  const enabled = await fixture.screenshot({ path: `${out}/${engine}-optics-enabled.png` });
  await projection.evaluate(element => { element.style.filter = 'none'; });
  const disabled = await fixture.screenshot({ path: `${out}/${engine}-optics-disabled.png` });
  await projection.evaluate((element, value) => { element.style.filter = value; }, filterValue);
  // Disable only the edge channel offsets, leaving SDF refraction unchanged.
  await fixture.locator('feDisplacementMap[result="red-shift"],feDisplacementMap[result="blue-shift"]').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('scale', '0')));
  const noDispersion = await fixture.screenshot({ path: `${out}/${engine}-optics-no-dispersion.png` });
  const compare = async (a, b) => page.evaluate(async ([first, second]) => {
    async function pixels(source) {
      const image = new Image(); image.src = 'data:image/png;base64,' + source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    }
    const x = await pixels(first), y = await pixels(second);
    let changed = 0, sum = 0, max = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      const delta = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
      if (delta >= 12) changed++; sum += delta; max = Math.max(max, delta);
    }
    return { width: x.width, height: x.height, changedPixels: changed, totalPixels: x.width * x.height, meanChannelDifference: sum / (x.width * x.height * 3), maxChannelSumDifference: max };
  }, [a.toString('base64'), b.toString('base64')]);
  const refraction = await compare(noDispersion, disabled), dispersion = await compare(enabled, noDispersion);
  assert.ok(refraction.changedPixels > 150, `SDF displacement must alter real fixture pixels: ${JSON.stringify(refraction)}`);
  assert.ok(dispersion.changedPixels > 15, `edge RGB displacement must alter real fixture pixels: ${JSON.stringify(dispersion)}`);
  await page.evaluate(() => window.__setOpticalOptions({ ior: 1, edgeWidth: 15, dispersion: 0, blur: 0 }));
  await page.waitForFunction(() => window.__fixtureReady);
  await page.locator('#fixture .liquid-lens[data-optics="svg-replay"]').waitFor({ state: 'attached' });
  await projection.evaluate((element, value) => { element.style.filter = value; }, filterValue);
  const identityEnabled = await fixture.screenshot({ path: `${out}/${engine}-optics-identity.png` });
  await projection.evaluate(element => { element.style.filter = 'none'; });
  const identityDisabled = await fixture.screenshot({ path: `${out}/${engine}-optics-identity-unfiltered.png` });
  const identity = await compare(identityEnabled, identityDisabled);
  assert.ok(identity.meanChannelDifference < 1, `zero-strength filter must preserve glyph coverage: ${JSON.stringify(identity)}`);
  assert.deepEqual(errors, []);
  await page.close();
  return { refraction, dispersion, identity, screenshots: [`${engine}-optics-enabled.png`, `${engine}-optics-disabled.png`, `${engine}-optics-no-dispersion.png`, `${engine}-optics-identity.png`, `${engine}-optics-identity-unfiltered.png`], qualification: 'Difference isolates ordinary SVG filtering of the local icon/text replay, not arbitrary page-backdrop resampling. Identity allows subpixel compositing/rounding differences below one mean RGB level.' };
}

try {
  for (const engine of engines) await run(engine);
  console.log('PASS: liquid glass browser acceptance; evidence: ' + out);
} catch (error) { console.error(error); process.exitCode = 1; }

if (!opticsOnly) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const sections = report.runs.map(run => `<section><h2>${escape(run.engine)} ${escape(run.browserVersion || '')} — ${escape(run.status || 'incomplete')}</h2>
    <ul>${run.checks.map(check => `<li><strong>${escape(check.status)}</strong> · ${escape(check.name)}${check.details && typeof check.details === 'string' ? `<p>${escape(check.details)}</p>` : ''}</li>`).join('')}</ul>
    ${run.error ? `<pre>${escape(run.error)}</pre>` : ''}
    ${run.timing ? `<p>RAF delivery: median ${run.timing.medianMs?.toFixed(2)} ms, p95 ${run.timing.p95Ms?.toFixed(2)} ms, max ${run.timing.maxMs?.toFixed(2)} ms (${run.timing.samples} intervals). This includes automated input and screenshot work; it is not a GPU or physical-device frame-rate measurement.</p>` : ''}
    <div class="shots">${run.screenshots.filter(name => /nav-held|drag-before-release|dark-390|light-390|reduced-motion/.test(name)).map(name => `<figure><img src="${escape(name)}" alt="${escape(name)}" loading="lazy"><figcaption>${escape(name)}</figcaption></figure>`).join('')}</div>
    ${run.optical ? `<h3>Optical fixture</h3><p>The filtered and unfiltered images share the same source. Refraction and RGB dispersion are tested independently; the zero-strength case checks source-coordinate and glyph-coverage fidelity.</p><div class="optical">${run.optical.screenshots.map(name => `<figure><img src="${escape(name)}" alt="${escape(name)}"><figcaption>${escape(name)}</figcaption></figure>`).join('')}</div><pre>${escape(JSON.stringify({ refraction: run.optical.refraction, dispersion: run.optical.dispersion, identity: run.optical.identity }, null, 2))}</pre>` : ''}</section>`).join('');
  await writeFile(`${out}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liquid glass browser verification · 2026-11-08</title><style>
  body{font:15px/1.6 system-ui;background:#f5f6f7;color:#19221e;max-width:1280px;margin:auto;padding:28px}h1{font-size:28px;line-height:1.2}h2{margin-top:0}section{background:white;border:1px solid #dce3de;border-radius:12px;padding:24px;margin:28px 0}p{max-width:900px;color:#48544d}li{margin:6px 0}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.shots img{width:100%;max-width:390px}.optical{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.optical img{width:100%;max-width:736px}figure{margin:0}figcaption{font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f3;padding:12px;border-radius:8px;font-size:12px}a{color:#246b52}
  </style><h1>Liquid glass browser verification</h1><p>2026-11-08 · ${escape(report.scope)}</p><p>${escape(report.timingScope)}</p><p><a href="browser-verification.json">Machine-readable results</a></p>${sections}</html>\n`);
}
