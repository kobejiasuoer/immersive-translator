import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const dir = await mkdtemp(join(tmpdir(), 'ita-sheet-tests-'));
const dom = new JSDOM('<div id="root" class="app"></div>', { url: 'http://localhost:4199/', pretendToBeVisual: true });
const w = dom.window, captures = new WeakMap(), errors = [], hotDisposers = [];
const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval }, timeouts = new Set(), intervals = new Set();
const originalError = console.error, originalFetch = globalThis.fetch;
globalThis.setTimeout = (fn, ms, ...args) => { const id = originalTimers.setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; };
globalThis.clearTimeout = id => { timeouts.delete(id); originalTimers.clearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => { const id = originalTimers.setInterval(fn, ms, ...args); intervals.add(id); return id; };
globalThis.clearInterval = id => { intervals.delete(id); originalTimers.clearInterval(id); };
for (const key of ['document', 'localStorage', 'location', 'history', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = w[key];
globalThis.window = w; globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
w.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
w.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [], speaking: false }; w.SpeechSynthesisUtterance = class {};
globalThis.speechSynthesis = w.speechSynthesis; globalThis.SpeechSynthesisUtterance = w.SpeechSynthesisUtterance;
globalThis.fetch = async () => { throw Error('Sheet tests must not request the network'); };
globalThis.__sheetTestHot = { dispose: fn => hotDisposers.push(fn) };
const viewport = new w.EventTarget(); Object.assign(viewport, { height: 544, offsetTop: 0, scale: 1 });
Object.defineProperty(w, 'visualViewport', { configurable: true, value: viewport });
Object.defineProperty(w, 'innerHeight', { configurable: true, value: 844 });
w.HTMLElement.prototype.setPointerCapture = function(id) { captures.set(this, id); };
w.HTMLElement.prototype.hasPointerCapture = function(id) { return captures.get(this) === id; };
w.HTMLElement.prototype.releasePointerCapture = function(id) { if (captures.get(this) !== id) return; captures.delete(this); pointer('lostpointercapture', this, { id }); };
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const rejected = error => errors.push(error?.stack || String(error)); process.on('unhandledRejection', rejected);
const wait = ms => new Promise(resolve => originalTimers.setTimeout(resolve, ms));
const q = selector => document.querySelector(selector), panel = () => q('.sheet.on');
function pointer(type, target = w, { id = 1, x = 30, y = 100, primary = true, button = 0 } = {}) {
  const event = new w.MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary }, pointerType: { value: 'touch' } }); target.dispatchEvent(event); return event;
}
function click(target, detail = 1, id) {
  const event = new w.MouseEvent('click', { bubbles: true, cancelable: true, detail });
  if (id !== undefined) Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event); return event;
}
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (fn()) return; if (errors.length) throw Error(errors.join(' | ')); await wait(10); } throw Error(label + ' timed out'); }
let api, checks = 0;
function pass(label) { checks++; console.log('PASS ' + label); }
async function open(kind, inert = false) {
  api.unmount(); w.getSelection().removeAllRanges();
  api.resetCounters(); if (kind === 'global') api.actions.setSheet({ kind: 'aa' });
  api.mount(kind, inert); await until(() => panel(), 'sheet mount'); await wait(0);
  return panel();
}
const closed = kind => kind === 'global' ? api.getState().sheet === null : api.counters().closes === 1;
try {
  const outfile = join(dir, 'app.mjs');
  await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SheetHost} from './ui/sheets';import {ReadingDrawer} from './components/reading/Drawer';
    export {startKeyboardViewportSync} from './ui/keyboardViewport';
    export {actions,initializeStore,activeRepository,getState,flushPersist,hideToast,stopSpeak} from './store';
    let root,clicks=0,closes=0;
    export function counters(){return {clicks,closes};}export function resetCounters(){clicks=0;closes=0;}
    function Probe(){const [open,setOpen]=useState(true);return <ReadingDrawer open={open} label="测试抽屉" onClose={()=>{closes++;setOpen(false);}}><p data-text>Selectable content</p><button data-action onClick={()=>clicks++}>执行</button><input data-edit type="text"/><textarea data-edit/><select data-edit><option>选项</option></select><input data-edit type="range"/><label data-edit>标签<input/></label><div data-edit contentEditable suppressContentEditableWarning><span>可编辑</span></div></ReadingDrawer>;}
    export function mount(kind,inert){root=createRoot(document.getElementById('root'));root.render(<React.StrictMode>{kind==='global'?<SheetHost inert={inert}/>:<Probe/>}</React.StrictMode>);}
    export function unmount(){root?.unmount();root=null;}
  `, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx', sourcefile: 'sheet-tests.tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://sheet-tests.invalid'), 'import.meta.hot': 'globalThis.__sheetTestHot', 'process.env.NODE_ENV': JSON.stringify('development') } });
  api = await import(pathToFileURL(outfile).href); await api.initializeStore('sheet-tests-' + crypto.randomUUID());
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '300px'); pass('keyboard inset initializes before the first viewport event');
  Object.assign(viewport, { scale: 2, height: 240 }); viewport.dispatchEvent(new w.Event('resize'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '300px');
  Object.assign(viewport, { offsetTop: 50 }); viewport.dispatchEvent(new w.Event('scroll'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '300px'); pass('pinch zoom preserves the last unscaled keyboard inset');
  Object.assign(viewport, { scale: 1, height: 844, offsetTop: 0 }); viewport.dispatchEvent(new w.Event('resize'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '0px');
  Object.assign(viewport, { height: 700, offsetTop: 50 }); viewport.dispatchEvent(new w.Event('scroll'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '0px');
  Object.assign(viewport, { height: 604, offsetTop: 0 }); w.dispatchEvent(new w.Event('resize'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '240px'); pass('dismissal, offset scrolling and window resize remeasure the keyboard');

  for (const kind of ['reading', 'global']) {
    let el = await open(kind), grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { x: 120, y: 115 });
    assert.equal(el.style.transform, ''); pointer('pointerup');
    const action = kind === 'reading' ? q('[data-action]') : el.querySelector('.aa-steps button');
    assert.equal(click(action).defaultPrevented, false); await wait(0); assert.ok(panel());
    pass(kind + ': horizontal intent preserves the sheet and subsequent button clicks');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 250 }); assert.equal(el.style.transform, 'translateY(150px)');
    pointer('pointermove', w, { id: 2, y: 400 }); pointer('pointerup', w, { id: 2 }); assert.equal(el.style.transform, 'translateY(150px)');
    pointer('pointercancel'); assert.equal(el.style.transform, ''); assert.ok(panel()); assert.equal(closed(kind), false);
    assert.equal(click(kind === 'reading' ? q('[data-action]') : el.querySelector('.aa-steps button')).defaultPrevented, false);
    pass(kind + ': unrelated pointer events are ignored; cancellation restores without closing or swallowing a click');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 250 }); el.releasePointerCapture(1);
    pointer('pointerup'); assert.equal(el.style.transform, ''); assert.ok(panel()); assert.equal(closed(kind), false);
    assert.equal(click(kind === 'reading' ? q('[data-action]') : el.querySelector('.aa-steps button')).defaultPrevented, false);
    pass(kind + ': lost pointer capture cannot dismiss the sheet or consume a later click');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 160 }); pointer('pointerdown', grab, { id: 2, primary: false });
    assert.equal(el.style.transform, ''); pointer('pointerup'); assert.equal(closed(kind), false);
    pass(kind + ': a second touch cancels dismissal so pinch zoom can continue');

    el = await open(kind); const body = el.querySelector('.sheet-body'); body.scrollTop = 12;
    pointer('pointerdown', body); pointer('pointermove', w, { y: 250 }); pointer('pointerup');
    assert.equal(el.style.transform, ''); assert.ok(panel()); body.scrollTop = 0;
    const text = kind === 'reading' ? q('[data-text]') : el.querySelector('.sheet-title');
    const range = document.createRange(); range.selectNodeContents(text); w.getSelection().addRange(range);
    pointer('pointerdown', text); pointer('pointermove', w, { y: 250 }); pointer('pointerup'); assert.equal(el.style.transform, ''); assert.ok(panel());
    w.getSelection().removeAllRanges(); pointer('pointerdown', text); w.getSelection().addRange(range);
    pointer('pointermove', w, { y: 250 }); pointer('pointerup'); assert.equal(el.style.transform, ''); assert.ok(panel()); w.getSelection().removeAllRanges();
    pass(kind + ': scrolled content and text selections retain their native interactions');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 221 }); pointer('pointerup');
    assert.equal(click(el, 1, 1).defaultPrevented, true); await until(() => closed(kind), 'downward dismissal');
    pass(kind + ': a completed downward drag dismisses and suppresses only its synthetic click');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 120 }); await wait(100); pointer('pointerup'); assert.ok(panel());
    pointer('pointerdown', kind === 'reading' ? q('[data-action]') : el.querySelector('.aa-steps button'));
    pointer('pointerup'); assert.equal(click(kind === 'reading' ? q('[data-action]') : el.querySelector('.aa-steps button')).defaultPrevented, false);
    pass(kind + ': an incomplete drag snaps back and cannot suppress the next tap');

    el = await open(kind); grab = el.querySelector('.sheet-grab');
    pointer('pointerdown', grab); pointer('pointermove', w, { y: 250 }); api.unmount();
    assert.equal(el.style.transform, ''); pointer('pointerup'); assert.equal(closed(kind), false);
    pass(kind + ': unmounting cancels active gestures and restores transient styles');
  }

  let el = await open('reading');
  for (const edit of el.querySelectorAll('[data-edit]')) {
    const target = edit.querySelector('span') || edit;
    pointer('pointerdown', target); pointer('pointermove', w, { y: 280 }); pointer('pointerup');
    assert.equal(el.style.transform, ''); assert.ok(panel());
  }
  pass('text inputs, textareas, selects, range controls, labels and editable descendants cannot start dismissal');
  el = await open('global', true); pointer('pointerdown', el.querySelector('.sheet-grab')); pointer('pointermove', w, { y: 250 }); pointer('pointerup');
  assert.equal(el.style.transform, ''); assert.ok(panel()); pass('inert global sheets cannot capture gestures under another modal');

  assert.equal(hotDisposers.length, 1); hotDisposers[0]();
  Object.assign(viewport, { height: 400 }); viewport.dispatchEvent(new w.Event('resize')); w.dispatchEvent(new w.Event('resize'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '240px'); pass('HMR disposal removes viewport and window event listeners');
  const cleanup = api.startKeyboardViewportSync(); assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '444px'); cleanup();
  Object.assign(viewport, { height: 844 }); viewport.dispatchEvent(new w.Event('scroll'));
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '444px');
  Object.defineProperty(w, 'visualViewport', { configurable: true, value: undefined }); const stopFallback = api.startKeyboardViewportSync();
  assert.equal(document.documentElement.style.getPropertyValue('--kb-inset'), '0px'); stopFallback(); pass('fresh synchronization reinitializes safely and supports browsers without visualViewport');
  assert.equal(errors.length, 0, errors.join(' | ')); console.log('PASS: ' + checks + ' real sheet and keyboard regression scenarios');
} finally {
  api?.unmount(); api?.hideToast(); api?.stopSpeak(); hotDisposers.forEach(dispose => dispose());
  try { if (api) { await api.flushPersist(); api.activeRepository().close(); } } catch {}
  dom.window.close(); for (const id of timeouts) originalTimers.clearTimeout(id); for (const id of intervals) originalTimers.clearInterval(id);
  Object.assign(globalThis, originalTimers); console.error = originalError; globalThis.fetch = originalFetch;
  process.removeListener('unhandledRejection', rejected); delete globalThis.__sheetTestHot; await rm(dir, { recursive: true, force: true });
}
