import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// Production component/store with actual unequal button bounds and controlled display frames.
const dir = await mkdtemp(join(tmpdir(), 'ita-nav-tests-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:4199/', pretendToBeVisual: true });
const w = dom.window, errors = [], frames = new Map(), captures = new WeakMap(), observers = new Set(), preferenceListeners = new Set();
const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval }, timeouts = new Set(), intervals = new Set();
const originalError = console.error;
globalThis.setTimeout = (fn, ms, ...args) => { const id = originalTimers.setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; };
globalThis.clearTimeout = id => { timeouts.delete(id); originalTimers.clearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => { const id = originalTimers.setInterval(fn, ms, ...args); intervals.add(id); return id; };
globalThis.clearInterval = id => { intervals.delete(id); originalTimers.clearInterval(id); };
let frameId = 0, width = 308, reduced = false, clock = 1000, rectReads = 0;
w.matchMedia = query => ({ get matches() { return reduced && query.includes('prefers-reduced-motion'); }, media: query, addEventListener(_name, callback) { if(query.includes('prefers-reduced-motion'))preferenceListeners.add(callback); }, removeEventListener(_name, callback) { preferenceListeners.delete(callback); } });
w.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [], speaking: false }; w.SpeechSynthesisUtterance = class {};
class ResizeObserver { constructor(callback) { this.callback = callback; observers.add(this); } observe() {} disconnect() { observers.delete(this); } }
const originalRect = w.HTMLElement.prototype.getBoundingClientRect;
const shares = [.29, .29, .42];
const bounds = index => { const inner = width - 10, buttonWidth = inner * shares[index], left = 15 + inner * shares.slice(0, index).reduce((sum, value) => sum + value, 0); return { left, right: left + buttonWidth, top: 605, bottom: 651, width: buttonWidth, height: 46 }; };
const anchor = index => { const rect = bounds(index); return { center: rect.left + rect.width / 2 - 11, width: rect.width }; };
w.HTMLElement.prototype.getBoundingClientRect = function() {
  if (this.classList.contains('glass-nav')) { rectReads++; return { x: 10, y: 600, left: 10, right: 10 + width, top: 600, bottom: 656, width, height: 56, toJSON() {} }; }
  if (this.classList.contains('tab')) { rectReads++; return bounds([...this.parentElement.querySelectorAll('.tab')].indexOf(this)); }
  return originalRect.call(this);
};
Object.defineProperty(w.HTMLElement.prototype, 'clientLeft', { configurable: true, get() { return this.classList.contains('glass-nav') ? 1 : 0; } });
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
function pointer(type, target = q('.glass-nav'), { id = 1, x = 30, y = 620, button = 0, pointerType = 'mouse', isPrimary = true, time = clock } = {}) { const event = new w.MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }); Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, isPrimary: { value: isPrimary }, timeStamp: { value: time } }); target.dispatchEvent(event); return event; }
function touch(type, target = q('.glass-nav'), { id = 1, x = 30, y = 620, time = clock, touches } = {}) { const event = new w.Event(type, { bubbles: true, cancelable: true }); const changed = { identifier: id, clientX: x, clientY: y }; Object.defineProperties(event, { touches: { value: touches ?? (type === 'touchend' || type === 'touchcancel' ? [] : [changed]) }, changedTouches: { value: [changed] }, timeStamp: { value: time } }); target.dispatchEvent(event); return event; }
function click(target, detail = 1) { const event = new w.MouseEvent('click', { bubbles: true, cancelable: true, detail }); target.dispatchEvent(event); return event; }
function flushFrames(ms = 1000 / 60) { clock += ms; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(clock); }
async function settle() { await wait(0); for (let i = 0; i < 200 && frames.size; i++) { flushFrames(); await wait(0); } assert.equal(frames.size, 0, 'spring must settle and release its RAF'); }
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (fn()) return; if (errors.length) throw Error(errors.join(' | ')); await wait(10); } throw Error(label + ' timed out'); }
function center() { return Number(q('.glass-bubble').style.transform.match(/translate3d\(([-.\d]+)px/)[1]) + Number.parseFloat(q('.glass-bubble').style.width) / 2; }
function near(actual, expected, label = '') { assert.ok(Math.abs(actual - expected) < .1, `${label}: ${actual} != ${expected}`); }
function selected(index) { assert.equal(buttons().filter(button => button.getAttribute('aria-current') === 'page').length, 1); assert.equal(buttons()[index].getAttribute('aria-current'), 'page'); near(center(), anchor(index).center, 'bubble center'); }
let api, root, checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };
async function reset(tab = 'today') { api.actions.setTab(tab); await until(() => buttons()[['today', 'practice', 'vocab'].indexOf(tab)]?.getAttribute('aria-current') === 'page', 'selected tab'); await settle(); }
try {
  const outfile = join(dir, 'app.mjs');
  await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import GlassNav from './ui/GlassNav';export {actions,initializeStore,activeRepository,getState,flushPersist,hideToast,stopSpeak} from './store';export * from './ui/navMotion';let root;export function mount(){root=createRoot(document.getElementById('root'));update(false,false);return root;}export function update(hidden,inert){root.render(<React.StrictMode><GlassNav hidden={hidden} inert={inert}/></React.StrictMode>);}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'nav-tests.tsx', loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://nav-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') } });
  api = await import(pathToFileURL(outfile).href); await api.initializeStore('nav-tests-' + crypto.randomUUID()); root = api.mount(); await until(() => q('.glass-bubble')?.style.width, 'nav mounted'); await settle();

  for (const [index, key] of ['today', 'practice', 'vocab'].entries()) { const x = bounds(index).left + 10; pointer('pointerdown', buttons()[index], { x }); assert.ok(buttons()[index].hasAttribute('data-pressed')); pointer('pointerup', buttons()[index], { x }); click(buttons()[index]); await until(() => api.getState().tab === key && buttons()[index].getAttribute('aria-current') === 'page', 'tab click'); await settle(); selected(index); }
  assert.ok(anchor(2).width > anchor(0).width); pass('normal clicks select all tabs using their real unequal bounds with immediate press feedback');
  await reset(); const tabChanges = [], originalSetTab = api.actions.setTab;
  api.actions.setTab = key => { tabChanges.push(key); originalSetTab(key); };
  const boundaryX = bounds(2).left + 1; touch('touchstart', buttons()[2], {x:boundaryX}); assert.ok(buttons()[2].hasAttribute('data-pressed')); touch('touchend', w, {x:boundaryX}); click(buttons()[2]); await settle(); selected(2); assert.deepEqual(tabChanges,['vocab']); api.actions.setTab = originalSetTab;
  pass('touching an unequal-width button boundary selects that button once without an intermediate wrong tab');

  await reset(); pointer('pointerdown', buttons()[0], { x: 30 }); pointer('pointermove', q('.glass-nav'), { x: 36 }); flushFrames(); assert.equal(q('.glass-nav').hasPointerCapture(1), false); near(center(), anchor(0).center); pointer('pointerup'); click(buttons()[1], 0); await until(() => api.getState().tab === 'practice', 'below threshold click'); await settle(); selected(1);
  pass('movement at the six-pixel threshold remains a click without pointer capture');

  await reset(); const origin = center(); pointer('pointerdown', buttons()[0], { x: 30 }); pointer('pointermove', q('.glass-nav'), { x: 130, time: clock + 200 }); assert.equal(q('.glass-nav').hasPointerCapture(1), true); flushFrames(); near(center(), origin + 100); assert.equal(q('.glass-bubble').style.transition, ''); pointer('pointerup', q('.glass-nav'), { x: 130, time: clock + 200 });
  assert.equal(click(buttons()[2]).defaultPrevented, true); await until(() => api.getState().tab === 'practice', 'drag snap'); await settle(); selected(1); assert.equal(q('.glass-nav').hasPointerCapture(1), false);
  pointer('pointerdown', buttons()[2], { x: bounds(2).left + 10 }); pointer('pointerup', buttons()[2], { x: bounds(2).left + 10 }); click(buttons()[2]); await settle(); selected(2);
  pass('drag follows continuously, springs to the nearest tab, suppresses its ghost click and permits the next tap');

  await reset('practice'); pointer('pointerdown', buttons()[1], { x: 150 }); pointer('pointermove', q('.glass-nav'), { x: 900 }); flushFrames(); assert.ok(center() > anchor(2).center && center() < anchor(2).center + 32); pointer('pointermove', q('.glass-nav'), { x: -900 }); flushFrames(); assert.ok(center() < anchor(0).center && center() > anchor(0).center - 32); pointer('pointercancel'); await settle(); selected(1);
  pass('both boundaries resist progressively and cancellation restores the original selection');

  pointer('pointerdown', buttons()[1], { x: 150 }); pointer('pointermove', q('.glass-nav'), { x: 250 }); assert.equal(frames.size, 1); pointer('pointercancel'); await settle(); selected(1); assert.equal(api.getState().tab, 'practice');
  pass('pointercancel replaces queued drag work with a settling spring without stranding the bubble');

  pointer('pointerdown', buttons()[1], { x: 150, y: 620 }); pointer('pointermove', q('.glass-nav'), { x: 154, y: 650 }); pointer('pointerup', q('.glass-nav'), { x: 154, y: 650 }); await settle(); selected(1); assert.equal(q('.glass-nav').hasPointerCapture(1), false); assert.equal(buttons().some(button => button.hasAttribute('data-pressed')), false);
  pass('vertical intent cancels navigation without capture or stuck press feedback');

  pointer('pointerdown', buttons()[1], { id: 7, x: 150 }); pointer('pointermove', q('.glass-nav'), { id: 7, x: 220 }); flushFrames(); q('.glass-nav').releasePointerCapture(7); pointer('pointerup', q('.glass-nav'), { id: 7, x: 220 }); await settle(); selected(1);
  click(buttons()[0], 0); await settle(); selected(0); pass('lost capture cancels selection and never swallows the next keyboard activation');

  await reset('practice'); pointer('pointerdown', buttons()[1], { id: 8, x: 150 }); pointer('pointermove', q('.glass-nav'), { id: 9, x: 250 }); pointer('pointerup', q('.glass-nav'), { id: 9, x: 250 }); flushFrames(); near(center(), anchor(1).center); pointer('pointercancel', q('.glass-nav'), { id: 8 }); await settle(); selected(1);
  pass('unrelated pointer IDs cannot move or finish the active gesture');

  width = 608; for (const observer of observers) observer.callback(); await settle(); selected(1); near(Number.parseFloat(q('.glass-bubble').style.width), anchor(0).width);
  pass('resizing uses the new measured widths, including both borders, and preserves selection');
  width = 308; for (const observer of observers) observer.callback(); await settle();

  await reset(); const readCount = rectReads, start = center(); touch('touchstart', buttons()[0], { x: 30 });
  for (let step = 1; step <= 5; step++) { const event = touch('touchmove', w, { x: 30 + step * 12, time: clock + 20 }); assert.equal(event.defaultPrevented, true); flushFrames(); near(center(), start + step * 12); }
  pointer('pointercancel', q('.glass-nav'), { pointerType: 'touch' }); touch('touchmove', w, { x: 110, time: clock + 20 }); flushFrames(); near(center(), start + 80);
  assert.equal(rectReads, readCount); touch('touchend', w, { x: 110, time: clock + 200 }); await settle(); selected(1);
  pass('native iOS touch stream stays glued to the finger after pointercancel and performs no per-move layout reads');

  await reset(); const base = center(); touch('touchstart', buttons()[0], { x: 30, time: clock }); touch('touchmove', w, { x: 68, time: clock + 50 }); flushFrames(); near(center(), base + 38); assert.ok(center() < (anchor(0).center + anchor(1).center) / 2);
  touch('touchend', w, { x: 68, time: clock + 55 }); await until(() => api.getState().tab === 'practice', 'momentum projection'); flushFrames(); const moving = center(); assert.ok(moving > base + 38);
  touch('touchstart', buttons()[1], { x: 145, time: clock }); near(center(), moving, 'grab presentation'); touch('touchmove', w, { x: 125, time: clock + 20 }); flushFrames(); near(center(), moving - 20, 'reverse without target jump'); touch('touchcancel', w); await settle(); selected(1);
  pass('a short flick projects to its neighbour, inherits release velocity and can be grabbed and reversed mid-spring');

  await reset(); touch('touchstart', buttons()[0], { x: 30, time: clock }); touch('touchmove', w, { x: 68, time: clock + 40 }); flushFrames(); touch('touchend', w, { x: 68, time: clock + 200 }); await settle(); selected(0);
  pass('a pause before release removes stale momentum rather than unexpectedly switching tabs');
  await reset(); touch('touchstart', buttons()[0], {x:30,time:clock}); touch('touchmove',w,{x:38,time:clock+20}); flushFrames(); touch('touchend',w,{x:125,time:clock+200}); await settle(); selected(1);
  pass('release uses the final touch coordinates when WebKit coalesces the last move');

  await reset(); touch('touchstart', buttons()[0], { x: 30 }); touch('touchmove', w, { x: 100, time: clock + 20 }); flushFrames(); touch('touchstart', document.body, { id: 2, x: 200, touches: [{ identifier: 1, clientX: 100, clientY: 620 }, { identifier: 2, clientX: 200, clientY: 500 }] }); touch('touchend', w, { x: 100 }); await settle(); selected(0);
  pass('a second finger outside the navigation cancels the active gesture');

  pointer('pointerdown', buttons()[0], { x: 30 }); pointer('pointermove', q('.glass-nav'), { x: 120 }); flushFrames(); api.update(true, true); await until(() => q('.glass-nav').hasAttribute('inert'), 'hidden inert navigation'); assert.equal(frames.size, 0); assert.equal(q('.glass-nav').hasPointerCapture(1), false); pointer('pointerup', q('.glass-nav'), { x: 120 }); click(buttons()[2], 0); assert.equal(api.getState().tab, 'today'); api.update(false, false); await until(() => !q('.glass-nav').hasAttribute('inert'), 'visible navigation'); await settle(); selected(0);
  pass('hidden and inert transitions cancel capture and spring work and ignore blocked activation');

  const css = await readFile(fileURLToPath(new URL('../src/ui/learning.css', import.meta.url)), 'utf8');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style); reduced = true; for (const listener of preferenceListeners) listener();
  click(buttons()[2], 0); await until(() => api.getState().tab === 'vocab', 'reduced keyboard selection'); assert.equal(frames.size, 0); selected(2);
  touch('touchstart', buttons()[2], { x: 270 }); touch('touchmove', w, { x: 190 }); flushFrames(); assert.match(q('.glass-bubble').style.transform, /,1\)$/); touch('touchcancel', w); assert.equal(frames.size, 0); selected(2);
  const media = [...style.sheet.cssRules].find(rule => rule.conditionText?.replace(/\s/g, '') === '(prefers-reduced-motion:reduce)');
  assert.ok(media); const bubbleRule = [...media.cssRules].find(rule => rule.selectorText === '.glass-bubble'); assert.equal(bubbleRule?.style.getPropertyValue('transition'), 'none'); assert.equal(bubbleRule?.style.getPropertyPriority('transition'), 'important'); assert.equal([...media.cssRules].find(rule => rule.selectorText === '.learning-body')?.style.getPropertyValue('scroll-behavior'), 'auto');
  pass('live reduced-motion preference removes spring, overshoot and stretch while preserving direct touch feedback');

  reduced = false; for (const listener of preferenceListeners) listener(); pointer('pointerdown', buttons()[2], { x: 270 }); pointer('pointermove', q('.glass-nav'), { x: 120 }); flushFrames(); w.dispatchEvent(new w.Event('blur')); assert.equal(frames.size, 0); selected(2);
  pass('losing focus cancels gestures and stops background animation');
  await api.flushPersist(); assert.equal(errors.length, 0, errors.join(' | ')); const unmountNav = q('.glass-nav'); pointer('pointerdown',buttons()[2],{id:20,x:270}); pointer('pointermove',w,{id:20,x:220}); assert.equal(unmountNav.hasPointerCapture(20),true); root.unmount(); root = null; assert.equal(unmountNav.hasPointerCapture(20),false); assert.equal(frames.size, 0); assert.equal(observers.size, 0); assert.equal(preferenceListeners.size, 0);
  pass('StrictMode navigation unmounts without React errors, observers, media listeners or animation work');
  console.log('PASS: ' + checks + ' real GlassNav interaction and CSS regression scenarios');
} finally {
  root?.unmount(); api?.hideToast(); api?.stopSpeak(); try { if (api) { await api.flushPersist(); api.activeRepository().close(); } } catch {}
  frames.clear(); dom.window.close(); for (const id of timeouts) originalTimers.clearTimeout(id); for (const id of intervals) originalTimers.clearInterval(id); Object.assign(globalThis, originalTimers); console.error = originalError; process.removeListener('unhandledRejection', rejected); await rm(dir, { recursive: true, force: true });
}
