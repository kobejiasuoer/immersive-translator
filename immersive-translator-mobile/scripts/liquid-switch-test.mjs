import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Exercises the production controlled component; deterministic frames let us
// distinguish continuous press physics from an immediate CSS scale jump.
const directory = await mkdtemp(join(tmpdir(), 'liquid-switch-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window, frames = new Map(), captures = new WeakMap();
const errors = [], feedback = [], preferences = new Set();
const previousError = console.error;
let clock = 1000, frameId = 0, reduced = false, rectReads = 0;
const originalRect = w.HTMLElement.prototype.getBoundingClientRect;
w.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.matches('.glass-switch')) { rectReads++; return { left: 10, top: 100, width: 314, height: 56, right: 324, bottom: 156 }; }
  if (this.matches('button.glass-switch-item')) {
    rectReads++; const index = [...this.parentElement.querySelectorAll(':scope > button')].indexOf(this);
    return { left: 15 + index * 100, top: 105, width: 100, height: 46, right: 115 + index * 100, bottom: 151 };
  }
  return originalRect.call(this);
};
w.matchMedia = query => ({ get matches() { return reduced && query.includes('reduced-motion'); }, addEventListener(_, callback) { preferences.add(callback); }, removeEventListener(_, callback) { preferences.delete(callback); } });
w.HTMLElement.prototype.setPointerCapture = function (id) { captures.set(this, id); };
w.HTMLElement.prototype.hasPointerCapture = function (id) { return captures.get(this) === id; };
w.HTMLElement.prototype.releasePointerCapture = function (id) { if (captures.get(this) === id) captures.delete(this); };
w.navigator.vibrate = value => { feedback.push(value); return true; };
for (const name of ['document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'CustomEvent', 'localStorage']) globalThis[name] = w[name];
globalThis.window = w;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
console.error = (...args) => { errors.push(args.map(String).join(' ')); previousError(...args); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const control = () => document.querySelector('.glass-switch');
const indicator = () => document.querySelector('.glass-switch-bubble');
const buttons = () => [...control().querySelectorAll(':scope > button')];
const center = () => Number(indicator().style.transform.match(/translate3d\(([-.\d]+)px/)[1]) + parseFloat(indicator().style.width) / 2;
const scaleY = () => Number(indicator().style.transform.match(/scale\([^,]+,([^)]+)\)/)[1]);
function pointer(type, x, target = control(), id = 1) {
  const event = new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 120 });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'mouse' }, isPrimary: { value: true }, timeStamp: { value: clock } });
  target.dispatchEvent(event);
}
function frame(milliseconds = 1000 / 120) {
  clock += milliseconds; const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(clock);
}
async function settle() { await wait(0); for (let i = 0; frames.size && i < 1600; i++) frame(); assert.equal(frames.size, 0, 'physics releases RAF at rest'); }
let api, root;
try {
  const outfile = join(directory, 'entry.mjs');
  await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {GlassSwitch} from './ui/GlassSwitch';
    let root; let selected='a'; let disabled=[]; let accept=true; let glass={longPressMs:100};
    export const commits=[];
    function render(){root.render(<React.StrictMode><GlassSwitch value={selected} glass={glass} ariaLabel="Liquid test" items={['a','b','c'].map(value=>({value,label:value,disabled:disabled.includes(value)}))} onChange={value=>{commits.push(value);if(accept){selected=value;render();}}}/></React.StrictMode>);}
    export function mount(){root=createRoot(document.getElementById('root'));render();return root;}
    export function configure(options){if('selected'in options)selected=options.selected;if('disabled'in options)disabled=options.disabled;if('accept'in options)accept=options.accept;if('glass'in options)glass=options.glass;render();}
  `, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx', sourcefile: 'liquid-switch-test.tsx' }, outfile, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"development"' } });
  api = await import(pathToFileURL(outfile).href); root = api.mount();
  for (let i = 0; i < 100 && !indicator()?.style.width; i++) await wait(10);
  await settle();

  const initial = scaleY(); pointer('pointerdown', 50, buttons()[0]);
  assert.equal(scaleY(), initial, 'press does not jump to the final scale');
  assert.equal(control().dataset.liquidState, 'pressed');
  frame(); const first = scaleY(); assert.ok(first > initial && first < 1.08);
  await wait(120); assert.equal(control().dataset.liquidState, 'holding');
  await settle(); assert.ok(scaleY() > 1.075); assert.deepEqual(api.commits, []);
  assert.equal(frames.size, 0, 'stationary long press sleeps without a perpetual RAF');
  assert.ok(feedback.length > 0, 'long press emits haptic intent');
  pointer('pointercancel', 50); await settle(); assert.equal(control().dataset.liquidState, 'idle');
  assert.equal(scaleY(), 1); assert.deepEqual(api.commits, []);
  console.log('PASS gradual press, long-press wake, haptic, cancellation and idle sleep');

  pointer('pointerdown', 150, buttons()[1]); await wait(120); await settle();
  assert.ok(Math.abs(center() - 155) < .1, 'long press floats the lens to the touched slot');
  assert.deepEqual(api.commits, [], 'holding a different slot never applies settings');
  const heldCenter = center(); pointer('pointermove', 162); frame();
  assert.ok(Math.abs(center() - heldCenter - 12) < .1, 'held lens can be grabbed without a target jump');
  pointer('pointercancel', 162); await settle();
  console.log('PASS unselected long press remains a preview and hands off to continuous drag');

  pointer('pointerdown', 50, buttons()[0]); const layoutReads = rectReads;
  pointer('pointermove', 255); frame(); assert.equal(control().dataset.liquidState, 'dragging');
  assert.ok(buttons()[2].hasAttribute('data-pressed')); assert.deepEqual(api.commits, []);
  for (let i = 0; i < 25; i++) frame();
  assert.equal(rectReads, layoutReads, 'drag and relaxation do not read layout');
  await settle(); assert.ok(Math.abs(scaleY() - 1.08) < .001, 'velocity squeeze relaxes when the finger pauses');
  pointer('pointerup', 255); await settle(); assert.deepEqual(api.commits, ['c']);
  console.log('PASS continuous cross-slot preview, no per-frame geometry reads, paused velocity relaxation and release commit');

  api.configure({ selected: null }); await settle(); assert.equal(indicator().hidden, true);
  pointer('pointerdown', 150, buttons()[1]); pointer('pointercancel', 150); await settle();
  assert.equal(indicator().hidden, true); assert.equal(control().dataset.liquidState, 'idle');
  api.configure({ selected: 'a', accept: false, glass: { stiffness: 100, damping: 70, longPressMs: 100 } }); await settle();
  pointer('pointerdown', 50, buttons()[0]); pointer('pointermove', 250); frame(); pointer('pointerup', 250); await settle();
  assert.ok(Math.abs(center() - 55) < .1, 'overdamped custom physics returns to rejected controlled value');
  console.log('PASS nullable cancellation and configurable overdamped controlled release');

  api.configure({ selected: 'a', accept: true }); await settle();
  pointer('pointerdown', 50, buttons()[0]); reduced = true; for (const callback of preferences) callback();
  await wait(120); await settle(); assert.equal(control().dataset.liquidState, 'idle');
  assert.equal(scaleY(), 1); assert.equal(frames.size, 0);
  pointer('pointerdown', 50, buttons()[0]); root.unmount(); root = null;
  await wait(120); assert.equal(frames.size, 0, 'unmount cancels long-press timer');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS preference changes and StrictMode unmount cancel timers and frames');
} finally {
  root?.unmount(); console.error = previousError; frames.clear(); dom.window.close();
  await rm(directory, { recursive: true, force: true });
}
