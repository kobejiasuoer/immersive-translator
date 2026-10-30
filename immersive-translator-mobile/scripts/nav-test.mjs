import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// The real component/store run with controlled geometry and browser scheduling.
const dir = await mkdtemp(join(tmpdir(), 'ita-nav-tests-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:4199/', pretendToBeVisual: true });
const w = dom.window, errors = [], frames = new Map(), captures = new WeakMap(), observers = new Set();
const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval }, timeouts = new Set(), intervals = new Set();
const originalError = console.error;
globalThis.setTimeout = (fn, ms, ...args) => { const id = originalTimers.setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; };
globalThis.clearTimeout = id => { timeouts.delete(id); originalTimers.clearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => { const id = originalTimers.setInterval(fn, ms, ...args); intervals.add(id); return id; };
globalThis.clearInterval = id => { intervals.delete(id); originalTimers.clearInterval(id); };
let frameId = 0, width = 308, reduced = false;
w.matchMedia = query => ({ matches: reduced && query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} });
w.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [], speaking: false }; w.SpeechSynthesisUtterance = class {};
class ResizeObserver { constructor(callback) { this.callback = callback; observers.add(this); } observe() {} disconnect() { observers.delete(this); } }
const originalRect = w.HTMLElement.prototype.getBoundingClientRect;
w.HTMLElement.prototype.getBoundingClientRect = function() { return this.classList.contains('glass-nav') ? { x: 10, y: 600, left: 10, right: 10 + width, top: 600, bottom: 656, width, height: 56, toJSON() {} } : originalRect.call(this); };
w.HTMLElement.prototype.setPointerCapture = function(id) { captures.set(this, id); };
w.HTMLElement.prototype.hasPointerCapture = function(id) { return captures.get(this) === id; };
w.HTMLElement.prototype.releasePointerCapture = function(id) { if (captures.get(this) !== id) return; captures.delete(this); pointer('lostpointercapture', this, { id }); };
for (const name of ['document', 'localStorage', 'location', 'history', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent', 'speechSynthesis', 'SpeechSynthesisUtterance']) globalThis[name] = w[name];
globalThis.window = w; globalThis.ResizeObserver = ResizeObserver; globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; }; globalThis.cancelAnimationFrame = id => frames.delete(id);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator }); globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.fetch = async () => { throw Error('Navigation tests must not request the network'); };
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const rejected = error => errors.push(error?.stack || String(error)); process.on('unhandledRejection', rejected);
const wait = ms => new Promise(resolve => originalTimers.setTimeout(resolve, ms));
const q = selector => document.querySelector(selector), buttons = () => [...document.querySelectorAll('.glass-nav .tab')];
function pointer(type, target = q('.glass-nav'), { id = 1, x = 20, y = 620, button = 0 } = {}) { const event = new w.MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }); Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' }, isPrimary: { value: true } }); target.dispatchEvent(event); return event; }
function click(target) { const event = new w.MouseEvent('click', { bubbles: true, cancelable: true }); target.dispatchEvent(event); return event; }
function flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()); }
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (fn()) return; if (errors.length) throw Error(errors.join(' | ')); await wait(10); } throw Error(label + ' timed out'); }
function position() { return Number(q('.glass-bubble').style.transform.match(/translate3d\(([-.\d]+)px/)[1]); }
function selected(index) { assert.equal(buttons().filter(b => b.getAttribute('aria-current') === 'page').length, 1); assert.equal(buttons()[index].getAttribute('aria-current'), 'page'); assert.equal(position(), index * ((width - 8) / 3)); }
let api, root, checks = 0;
function pass(label) { checks++; console.log('PASS ' + label); }
async function reset(tab = 'today') { api.actions.setTab(tab); await until(() => buttons()[['today', 'practice', 'vocab'].indexOf(tab)]?.getAttribute('aria-current') === 'page', 'selected tab'); await wait(0); flushFrames(); }
try {
  const outfile = join(dir, 'app.mjs');
  await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import GlassNav from './ui/GlassNav';export {actions,initializeStore,activeRepository,getState,flushPersist,hideToast,stopSpeak} from './store';export function mount(){const root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><GlassNav hidden={false} inert={false}/></React.StrictMode>);return root;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'nav-tests.tsx', loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://nav-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') } });
  api = await import(pathToFileURL(outfile).href); await api.initializeStore('nav-tests-' + crypto.randomUUID()); root = api.mount(); await until(() => q('.glass-bubble')?.style.width === '100px', 'nav mounted');

  for (const [index, key] of ['today', 'practice', 'vocab'].entries()) { pointer('pointerdown', buttons()[index]); pointer('pointerup', buttons()[index]); click(buttons()[index]); await until(() => api.getState().tab === key && buttons()[index].getAttribute('aria-current') === 'page', 'tab click'); await wait(0); selected(index); }
  pass('normal clicks select all three tabs with one active page and the matching bubble');

  await reset(); pointer('pointerdown', buttons()[0], { x: 30 }); pointer('pointermove', q('.glass-nav'), { x: 36 }); flushFrames(); assert.equal(q('.glass-nav').hasPointerCapture(1), false); assert.equal(position(), 0); pointer('pointerup'); click(buttons()[1]); await until(() => api.getState().tab === 'practice', 'below threshold click'); selected(1);
  pass('movement at the six-pixel threshold remains a click without pointer capture');

  await reset(); pointer('pointerdown', buttons()[0], { x: 30 }); pointer('pointermove', q('.glass-nav'), { x: 178 }); assert.equal(q('.glass-nav').hasPointerCapture(1), true); flushFrames(); assert.equal(position(), 148); assert.equal(q('.glass-bubble').style.transition, 'none'); pointer('pointerup', q('.glass-nav'), { x: 178 });
  const dragClick = click(buttons()[2]); assert.equal(dragClick.defaultPrevented, true); await until(() => api.getState().tab === 'practice', 'drag snap'); selected(1); assert.equal(q('.glass-nav').hasPointerCapture(1), false); assert.match(q('.glass-bubble').style.transition, /360ms/);
  pointer('pointerdown', buttons()[2], { x: 260 }); pointer('pointerup', buttons()[2], { x: 260 }); click(buttons()[2]); await until(() => api.getState().tab === 'vocab', 'click following drag'); selected(2);
  pass('drag tracks the bubble, snaps to the nearest tab, suppresses synthetic click and permits the next tap');

  await reset('practice'); pointer('pointerdown', buttons()[1], { x: 150 }); pointer('pointermove', q('.glass-nav'), { x: 900 }); flushFrames(); assert.equal(position(), 200); pointer('pointermove', q('.glass-nav'), { x: -900 }); flushFrames(); assert.equal(position(), 0); pointer('pointercancel'); await wait(0); selected(1);
  pass('dragging beyond either edge clamps the bubble and cancellation restores selection');

  await reset('practice'); pointer('pointerdown', buttons()[1], { x: 150 }); pointer('pointermove', q('.glass-nav'), { x: 250 }); assert.equal(frames.size, 1); pointer('pointercancel'); assert.equal(frames.size, 0); flushFrames(); selected(1); assert.equal(api.getState().tab, 'practice');
  pass('pointercancel cancels queued animation frames and cannot strand the bubble');

  pointer('pointerdown', buttons()[1], { x: 150, y: 620 }); pointer('pointermove', q('.glass-nav'), { x: 154, y: 650 }); flushFrames(); pointer('pointerup', q('.glass-nav'), { x: 154, y: 650 }); assert.equal(api.getState().tab, 'practice'); assert.equal(q('.glass-nav').hasPointerCapture(1), false); selected(1);
  pass('vertical intent preserves scrolling and the selected tab without capture');

  pointer('pointerdown', buttons()[1], { id: 7, x: 150 }); pointer('pointermove', q('.glass-nav'), { id: 7, x: 220 }); flushFrames(); assert.equal(position(), 170); q('.glass-nav').releasePointerCapture(7); pointer('pointerup', q('.glass-nav'), { id: 7, x: 220 }); flushFrames(); assert.equal(api.getState().tab, 'practice'); selected(1);
  pass('lost pointer capture cancels the drag and restores the selected tab');

  pointer('pointerdown', buttons()[1], { id: 8, x: 150 }); pointer('pointermove', q('.glass-nav'), { id: 9, x: 250 }); pointer('pointerup', q('.glass-nav'), { id: 9, x: 250 }); flushFrames(); selected(1); pointer('pointercancel', q('.glass-nav'), { id: 8 });
  pass('unrelated pointer IDs cannot move or finish the active gesture');

  width = 608; for (const observer of observers) observer.callback(); selected(1); assert.equal(q('.glass-bubble').style.width, '200px');
  pass('resizing recalculates bubble width while preserving the selected tab');

  const css = await readFile(fileURLToPath(new URL('../src/ui/learning.css', import.meta.url)), 'utf8');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style); reduced = true;
  const media = [...style.sheet.cssRules].find(rule => rule.conditionText?.replace(/\s/g, '') === '(prefers-reduced-motion:reduce)');
  assert.ok(media, 'production reduced-motion media rule exists'); assert.equal(w.matchMedia(media.conditionText).matches, true);
  const bubbleRule = [...media.cssRules].find(rule => rule.selectorText === '.glass-bubble'); assert.equal(bubbleRule?.style.getPropertyValue('transition'), 'none'); assert.equal(bubbleRule?.style.getPropertyPriority('transition'), 'important');
  assert.equal([...media.cssRules].find(rule => rule.selectorText === '.learning-body')?.style.getPropertyValue('scroll-behavior'), 'auto');
  pass('reduced-motion CSS disables bubble transition with !important and smooth scrolling');
  await api.flushPersist(); assert.equal(errors.length, 0, errors.join(' | ')); pass('StrictMode navigation has no React or unhandled runtime errors');
  console.log('PASS: ' + checks + ' real GlassNav interaction and CSS regression scenarios');
} finally {
  root?.unmount(); api?.hideToast(); api?.stopSpeak(); try { if (api) { await api.flushPersist(); api.activeRepository().close(); } } catch {}
  frames.clear(); dom.window.close(); for (const id of timeouts) originalTimers.clearTimeout(id); for (const id of intervals) originalTimers.clearInterval(id); Object.assign(globalThis, originalTimers); console.error = originalError; process.removeListener('unhandledRejection', rejected); await rm(dir, { recursive: true, force: true });
}
