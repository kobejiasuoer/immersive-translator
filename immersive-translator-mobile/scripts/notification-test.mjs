import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const dir = await mkdtemp(join(tmpdir(), 'ita-notification-tests-'));
let permission = 'granted', permissionReply = 'granted', requests = 0, plans = [], replacements = [], held = null, heldRequest = null, action = null, failReplacement = false;
const nativeStatus = () => ({ supported: true, permission, scheduled: plans.length });
const invoke = async (command, args) => {
  switch (command) {
    case 'plugin:study-notifications|status': return nativeStatus();
    case 'plugin:study-notifications|request':
      requests++;
      if (heldRequest) { const wait = heldRequest; heldRequest = null; await wait; }
      permission = permissionReply; return nativeStatus();
    case 'plugin:study-notifications|replace':
      if (failReplacement) { failReplacement = false; throw Error('Expected native scheduling failure'); }
      if (held) { const wait = held; held = null; await wait; }
      replacements.push(args.notifications);
      plans = permission === 'granted' ? args.notifications : [];
      return nativeStatus();
    case 'plugin:study-notifications|take_action': return action;
    case 'plugin:study-notifications|ack_action': if (action?.id === args.id && action?.at === args.at) action = null; return;
    default:
      if (command === 'share_queue_read') return [];
      if (command === 'selftest_mode' || command.startsWith('plugin:deep-link|') || command.startsWith('plugin:haptics|')) return null;
      if (command.startsWith('plugin:event|')) return 1;
      throw Error(`Unexpected native command: ${command}`);
  }
};
globalThis.window = { __TAURI_INTERNALS__: { invoke } };
let checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };
const originalZone = process.env.TZ;
try {
  const outfile = join(dir, 'notification.mjs');
  await build({ stdin: { contents: `export * from './services/reminderPlan';export * from './services/studyNotifications';`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node' });
  const api = await import(pathToFileURL(outfile).href);
  const settings = { daily: true, remindTime: '21:30', dnd: true };
  const due = [{ dueAt: Date.now() - 1000 }, { dueAt: Date.now() + 365 * 86400000 }, { dueAt: Date.now(), paused: true }];
  let plan = api.buildReminderPlan(settings, due);
  assert.equal(plan.length, 1); assert.equal(plan[0].id, 'ita-study-daily');
  assert.deepEqual([plan[0].hour, plan[0].minute, plan[0].repeats], [21, 30, true]);
  assert.ok(!['year', 'month', 'day', 'date', 'until', 'count'].some(key => key in plan[0]));
  assert.equal(api.buildReminderPlan(settings, [{ dueAt: Date.now() + 20 * 365 * 86400000 }])[0].repeats, true);
  assert.ok(!/\d+.*个|到期/.test(plan[0].body));
  pass('one infinite daily schedule has no expiry or stale due-count copy');
  assert.equal(api.buildReminderPlan({ ...settings, daily: false }, due).length, 0);
  assert.equal(api.buildReminderPlan(settings, [{ dueAt: Date.now(), paused: true }]).length, 0);
  assert.equal(api.buildReminderPlan(settings, []).length, 0);
  pass('disabled, empty and fully paused collections cancel learning reminders');
  assert.deepEqual(api.reminderTime({ ...settings, remindTime: '01:15' }), [7, 0]);
  assert.deepEqual(api.reminderTime({ ...settings, remindTime: '01:15', dnd: false }), [1, 15]);
  assert.throws(() => api.buildReminderPlan({ ...settings, remindTime: '25:90' }, due));
  pass('quiet hours shift overnight reminders and invalid times are rejected');
  if (process.platform === 'darwin') {
    const main = join(dir, 'main.swift'), binary = join(dir, 'calendar-test');
    await writeFile(main, `import Foundation
import UserNotifications
let trigger = studyCalendarTrigger(hour: 21, minute: 30)
precondition(trigger.repeats)
let c = trigger.dateComponents
precondition(c.year == nil && c.month == nil && c.day == nil)
precondition(c.hour == 21 && c.minute == 30 && c.second == 0)
precondition(c.calendar?.identifier == .gregorian)
let next = trigger.nextTriggerDate()!
precondition(next > Date())
let calendar = c.calendar!
let values = calendar.dateComponents(in: c.timeZone!, from: next)
precondition(values.hour == 21 && values.minute == 30)
print("Native daily trigger repeats without an end date")
`);
    execFileSync('xcrun', ['swiftc', fileURLToPath(new URL('../src-tauri/plugins/study-notifications/ios/Sources/StudyCalendar.swift', import.meta.url)), main, '-o', binary]);
    execFileSync(binary, [], { stdio: 'inherit' });
    pass('real UserNotifications calendar trigger repeats indefinitely at local wall time');
  }
  permission = 'denied'; plans = [{ id: 'old' }];
  await api.reconcileStudyNotifications(settings, due);
  assert.equal(requests, 0); assert.equal(plans.length, 0); assert.equal((await api.refreshNotificationStatus()).permission, 'denied');
  assert.equal(await api.requestStudyNotifications(), true); assert.equal(requests, 1);
  pass('startup never prompts; user enabling explicitly requests permission');
  let release; held = new Promise(resolve => { release = resolve; });
  const first = api.reconcileStudyNotifications(settings, due);
  await new Promise(resolve => setTimeout(resolve, 0));
  const changed = api.reconcileStudyNotifications({ ...settings, remindTime: '08:00' }, due);
  const disabled = api.reconcileStudyNotifications({ ...settings, daily: false }, due);
  release(); await Promise.all([first, changed, disabled]);
  assert.equal(plans.length, 0); assert.deepEqual(replacements.at(-1), []);
  assert.ok(!replacements.some(rows => rows[0]?.hour === 8));
  pass('rapid time changes then disable serialize to a final cancelled schedule');
  await api.reconcileStudyNotifications(settings, due);
  const savedCount = replacements.length;
  await api.reconcileStudyNotifications(settings, [{ dueAt: Date.now() + 99999999 }]);
  assert.equal(replacements.length, savedCount);
  pass('identical daily plans are not replaced after review or settings rerenders');
  action = { id: 'ita-study-test', at: 123 };
  assert.deepEqual(await api.takeNotificationAction(), action);
  assert.deepEqual(await api.takeNotificationAction(), action);
  await api.acknowledgeNotificationAction({ id: 'older-tap', at: 1 }); assert.ok(action);
  await api.acknowledgeNotificationAction(action); assert.equal(await api.takeNotificationAction(), null);
  pass('cold-start taps survive StrictMode remounts and acknowledge only the routed action');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:4199/', pretendToBeVisual: true });
  const w = dom.window;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  w.ResizeObserver = Observer; w.IntersectionObserver = Observer;
  w.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  w.SpeechSynthesisUtterance = class {};
  w.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [], speaking: false };
  for (const name of ['document', 'localStorage', 'location', 'history', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'Event', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'SpeechSynthesisUtterance', 'speechSynthesis']) globalThis[name] = w[name];
  globalThis.window = w; globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.getComputedStyle = w.getComputedStyle.bind(w); globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: w.navigator });
  for (const name of ['scrollIntoView', 'scrollTo']) w.HTMLElement.prototype[name] = function() {};
  globalThis.fetch = async () => { throw Error('Notification routing regression must not access the network'); };
  const appOut = join(dir, 'app.mjs');
  await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './App';import {SetRemindScreen} from './screens/SettingsScreens';import {ReminderSheet} from './components/vault/ReminderSheet';import {NavCtx} from './ui/nav';export {actions,initializeStore,getState,flushPersist,activeRepository,hideToast,stopSpeak} from './store';export {openAccountSheet,closeAccount} from './components/account/accountGate';export function mount(){const root=createRoot(document.getElementById('root'));root.render(React.createElement(React.StrictMode,null,React.createElement(App)));return root;}const nav={push(){},pop(){},popAll(){},replace(){}};export function mountSettings(){const root=createRoot(document.getElementById('root'));root.render(<NavCtx.Provider value={nav}><SetRemindScreen/></NavCtx.Provider>);return root;}export function mountReminder(onClose){const root=createRoot(document.getElementById('root'));root.render(<NavCtx.Provider value={nav}><div className="app"><ReminderSheet open onClose={onClose}/></div></NavCtx.Provider>);return root;}`, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), sourcefile: 'notification-routing.tsx', loader: 'tsx' }, outfile: appOut, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://notification-tests.invalid'), 'process.env.NODE_ENV': JSON.stringify('development') } });
  const app = await import(pathToFileURL(appOut).href);
  // Keep real identity-isolated IndexedDB repositories while mocking only the OS bridge.
  const switchProfile = async identity => {
    const bridge = w.__TAURI_INTERNALS__;
    delete w.__TAURI_INTERNALS__;
    try { await app.initializeStore(identity); }
    finally { w.__TAURI_INTERNALS__ = bridge; }
    document.dispatchEvent(new w.Event('visibilitychange'));
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (test, label) => { for (let i = 0; i < 150; i++) { if (test()) return; await wait(10); } throw Error(label + ' timed out: ' + document.body.textContent.replace(/\s+/g, ' ').slice(0, 1200)); };
  let root;
  try {
    await app.initializeStore('notification-test-' + crypto.randomUUID());
    app.actions.setOnboarded();
    app.actions.saveWord({ type: 'word', word: 'quiet', senses: [{ pos: 'adj.', cn: '安静的' }] }, 'word', { articleId: app.getState().articles[0].id, sentIdx: 0 });
    w.__TAURI_INTERNALS__ = { invoke, transformCallback: () => 1, unregisterCallback() {}, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    root = app.mount();
    await until(() => document.querySelector('.pane.on'), 'Mounted app');
    app.actions.setSheet({ kind: 'dict', entry: { type: 'word', word: 'quiet', senses: [{ pos: 'adj.', cn: '安静的' }], saved: true } });
    app.openAccountSheet();
    await wait(40);
    action = { id: 'ita-study-daily', at: 500 };
    document.dispatchEvent(new w.Event('visibilitychange'));
    await wait(100);
    assert.ok(action, 'blocked account overlay must not acknowledge the tap');
    assert.ok(app.getState().sheet, 'blocked notification must not dismiss the dictionary yet');
    assert.ok(!document.querySelector('.push[data-view="quick"]'));
    app.closeAccount();
    await until(() => document.querySelector('.push.in[data-view="quick"]'), 'Notification review route');
    assert.equal(app.getState().sheet, null, 'notification route clears stale global dictionary');
    assert.ok(!document.querySelector('.push[data-view="quick"]').hasAttribute('inert'), 'review remains interactive');
    await until(() => action === null, 'Notification action acknowledgement');
    await wait(800);
    assert.equal(document.querySelectorAll('.push[data-view="quick"]').length, 1, 'StrictMode and retry must not duplicate the route');
    assert.ok(!document.querySelector('.banner'), 'no in-app reminder banner');
    pass('actual App defers blocked taps, clears dictionary sheets, and opens one interactive review');
    app.actions.gradeVocab(app.getState().vocab[0].id, 'easy');
    await wait(40);
    const futureDue = app.getState().vocab[0].dueAt;
    action = { id: 'ita-study-daily', at: 600 };
    document.dispatchEvent(new w.Event('visibilitychange'));
    await until(() => document.querySelector('.push.in[data-view="learningWordbook"]'), 'Daily reminder without due cards');
    assert.equal(app.getState().vocab[0].dueAt, futureDue);
    await until(() => action === null, 'Daily reminder acknowledgement');
    pass('daily reminder opens the wordbook when nothing is due without advancing SRS');
    const originalProfile = app.activeRepository().identity;
    app.actions.setSettings({ daily: true });
    await until(() => plans.length === 1, 'Current profile daily schedule');
    await switchProfile('notification-onboarding-' + crypto.randomUUID());
    assert.equal(app.getState().onboarded, false);
    await until(() => plans.length === 0, 'Switching to a profile before onboarding cancels previous reminders');
    await switchProfile(originalProfile);
    await until(() => plans.length === 1, 'Returning to current profile restores its schedule');
    pass('switching to a new profile cancels the previous profile schedule even before onboarding');
    root.unmount(); root = null;
    const click = element => { assert.ok(element); element.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
    const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
    permission = 'prompt'; permissionReply = 'granted'; app.actions.setSettings({ daily: true });
    root = app.mountSettings();
    await until(() => button('允许系统通知'), 'Prompt-state settings');
    const dailySwitch = () => document.querySelector('.frow [role="switch"]');
    assert.equal(dailySwitch().getAttribute('aria-checked'), 'false', 'legacy daily=true must not imply granted permission');
    let requestCount = requests;
    click(dailySwitch());
    await until(() => dailySwitch().getAttribute('aria-checked') === 'true' && plans.length === 1, 'Enable from settings');
    assert.equal(requests, requestCount + 1);
    failReplacement = true; click(dailySwitch());
    await until(() => document.body.textContent.includes('系统提醒未能保存'), 'Cancellation failure');
    assert.equal(app.getState().settings.daily, true, 'failed cancellation must not claim the reminder is disabled');
    assert.equal(plans.length, 1);
    click(dailySwitch());
    await until(() => !app.getState().settings.daily && plans.length === 0, 'Disable from settings');
    assert.equal(requests, requestCount + 1, 'turning off must not request permission');
    pass('settings switch verifies enabling and cancellation without a false success on scheduling failure');
    root.unmount(); root = null;
    permission = 'prompt'; permissionReply = 'denied'; let closed = 0;
    root = app.mountReminder(() => { closed++; });
    await until(() => button('允许系统通知并保存时间'), 'Reminder sheet permission entry');
    requestCount = requests; click(button('允许系统通知并保存时间'));
    await until(() => button('打开系统通知设置'), 'Denied reminder permission');
    assert.equal(requests, requestCount + 1); assert.equal(closed, 0); assert.equal(app.getState().settings.daily, false); assert.equal(plans.length, 0);
    permission = 'prompt'; permissionReply = 'granted'; failReplacement = true;
    click(button('保存时间并开启提醒'));
    await until(() => document.body.textContent.includes('系统提醒未能保存'), 'Reminder scheduling failure');
    assert.equal(closed, 0); assert.equal(app.getState().settings.daily, false);
    click(button('保存时间并开启提醒'));
    await until(() => closed === 1, 'Reminder sheet successful retry');
    assert.equal(app.getState().settings.daily, true); assert.equal(plans.length, 1);
    pass('review reminder sheet handles denial and scheduling errors without false success');
    root.unmount(); root = null;
    app.actions.setSettings({ daily: false }); plans = [];
    permission = 'prompt'; permissionReply = 'granted';
    root = app.mountSettings();
    await until(() => button('允许系统通知'), 'Account-switch authorization entry');
    let releaseRequest;
    heldRequest = new Promise(resolve => { releaseRequest = resolve; });
    requestCount = requests; click(dailySwitch());
    await until(() => requests === requestCount + 1, 'Held notification authorization');
    await switchProfile('notification-switched-' + crypto.randomUUID());
    releaseRequest(); await wait(150);
    assert.equal(app.getState().settings.daily, false, 'old authorization must not enable reminders in the new profile');
    assert.equal(plans.length, 0, 'old profile must not schedule after switching during authorization');
    pass('pending notification authorization cannot write settings or schedule for a different profile');
    root.unmount(); root = null;
    app.actions.setOnboarded();
    app.actions.saveWord({ type: 'word', word: 'steady', senses: [{ pos: 'adj.', cn: '稳定的' }] }, 'word', { articleId: app.getState().articles[0]?.id, sentIdx: 0 });
    app.actions.setSettings({ daily: true });
    closed = 0; root = app.mountReminder(() => { closed++; });
    await until(() => document.querySelector('#v2-reminder-time'), 'Time-only reminder editor');
    const timeInput = document.querySelector('#v2-reminder-time');
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(timeInput, '08:20');
    timeInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    timeInput.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(20);
    let releaseSave; held = new Promise(resolve => { releaseSave = resolve; });
    click(button('只保存时间'));
    await until(() => held === null, 'Held native reminder replacement');
    await switchProfile('notification-time-switched-' + crypto.randomUUID());
    releaseSave(); await wait(100);
    assert.equal(app.getState().settings.remindTime, '21:30', 'old time-only save must not alter the new profile');
    assert.equal(closed, 0, 'old time-only save must not dismiss the new profile panel');
    pass('an in-flight time-only save cannot commit or dismiss a different profile');
  } finally {
    root?.unmount(); app.hideToast(); app.stopSpeak(); await app.flushPersist(); app.activeRepository().close(); dom.window.close();
  }
  console.log(`Notification regression: ${checks} checks passed`);
} finally {
  if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
  await rm(dir, { recursive: true, force: true });
}
