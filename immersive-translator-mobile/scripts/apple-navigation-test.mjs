import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Use a running Vite instance and an isolated browser profile. No network fixture,
// private account or microphone permission is needed for these navigation paths.
const out = process.env.UI_SHOTS_DIR;
if (out) await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1, viewport: { width: 390, height: 640 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const nav = page.locator('.glass-nav'), tabs = nav.locator('.tab');
const activePush = name => page.locator(`.push.in:not(.tab-inactive)[data-view="${name}"]`);
const capture = async name => { if (out) await page.screenshot({ path: `${out}/${name}.png` }); };
async function selected(index) {
  await page.waitForFunction(index => [...document.querySelectorAll('.glass-nav .tab')][index]?.getAttribute('aria-current') === 'page', index);
  assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
}
async function choose(index) { await tabs.nth(index).click(); await selected(index); }
async function drag(from, to) {
  const start = await tabs.nth(from).boundingBox(), end = await tabs.nth(to).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 }); await page.mouse.up();
  await selected(to);
}
async function focused(index) { assert.equal(await tabs.nth(index).evaluate(element => element === document.activeElement), true); }
async function visibleNavigation() { await nav.waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('.glass-nav')?.hasAttribute('inert')); }
async function hiddenNavigation() { await nav.waitFor({ state: 'hidden' }); assert.notEqual(await nav.getAttribute('inert'), null); }
try {
  await page.goto(process.env.UI_BASE_URL || 'http://127.0.0.1:5182');
  await page.getByRole('button', { name: '先体验一篇短文', exact: true }).click();
  await page.getByRole('button', { name: '开始读第一篇', exact: true }).click();
  await selected(0);

  await tabs.nth(0).focus(); await page.keyboard.press('ArrowRight'); await focused(1); await selected(0);
  await page.keyboard.press('Enter'); await selected(1);
  await page.keyboard.press('End'); await focused(2); await selected(1);
  await page.keyboard.press('Space'); await selected(2);
  await page.keyboard.press('Home'); await focused(0); await page.keyboard.press('Space'); await selected(0);
  console.log('PASS native browser Enter/Space activation and non-activating arrow/Home/End focus');

  await drag(0, 2); await choose(0);
  console.log('PASS dragging the glass indicator switches sections and the next tap remains available');

  await page.setViewportSize({ width: 390, height: 400 });
  await page.getByRole('button', { name: /经典书库/ }).click();
  const library = activePush('learningLibrary'); await library.waitFor({ state: 'visible' }); await visibleNavigation();
  await library.getByRole('button', { name: '入门 / 中级', exact: true }).click();
  const libraryId = await library.getAttribute('data-push-id');
  const scroll = await library.locator('main').evaluate(element => { element.scrollTop = 160; return element.scrollTop; });
  assert.ok(scroll > 0, 'library has scrollable content at the test viewport');
  await drag(0, 1); assert.equal(await library.isVisible(), false);
  await drag(1, 0); await library.waitFor({ state: 'visible' });
  assert.equal(await library.getAttribute('data-push-id'), libraryId);
  assert.equal(await library.getByRole('button', { name: '入门 / 中级', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await library.locator('main').evaluate(element => element.scrollTop), scroll);
  await capture('navigation-library-restored');
  console.log('PASS reading library retains its mounted page, filter and scroll position across glass drags');
  await library.getByRole('button', { name: '返回', exact: true }).click(); await library.waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 640 });
  await page.getByRole('button', { name: '搜索学习内容', exact: true }).click();
  const search = activePush('learningSearch'); await search.waitFor({ state: 'visible' });
  await search.getByRole('searchbox', { name: '搜索学习内容', exact: true }).fill('break');
  const searchId = await search.getAttribute('data-push-id');
  await choose(1); await choose(0); await search.waitFor({ state: 'visible' });
  assert.equal(await search.getAttribute('data-push-id'), searchId);
  assert.equal(await search.getByRole('searchbox', { name: '搜索学习内容', exact: true }).inputValue(), 'break');
  await visibleNavigation(); await capture('navigation-search-restored');
  console.log('PASS reading search retains its query while switching sections');
  await search.getByRole('button', { name: '返回', exact: true }).click(); await search.waitFor({ state: 'detached' });

  await page.locator('.pane.on').getByRole('button', { name: '开始阅读', exact: true }).click();
  const reader = activePush('reader'); await reader.waitFor({ state: 'visible' }); await hiddenNavigation();
  await tabs.nth(2).evaluate(element => element.click()); await selected(0);
  await capture('navigation-reader-focus');
  await reader.getByRole('button', { name: '返回书架', exact: true }).click(); await reader.waitFor({ state: 'detached' }); await visibleNavigation();
  console.log('PASS reader hides and disables section navigation until returning');

  await choose(1); await page.getByRole('button', { name: /寒暄/ }).click();
  const practice = activePush('learningPractice'); await practice.waitFor({ state: 'visible' }); await hiddenNavigation();
  await tabs.nth(0).evaluate(element => element.click()); await selected(1);
  await practice.getByRole('button', { name: '返回', exact: true }).click();
  await practice.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog', { name: '退出练习', exact: true }).count(), 0);
  await visibleNavigation(); console.log('PASS voice practice hides section navigation and returns directly without a confirmation');

  await page.getByRole('button', { name: /自由练习/ }).click();
  const sheet = page.getByRole('dialog', { name: '创建我的场景', exact: true }); await sheet.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.glass-nav')?.hasAttribute('inert'));
  const save = sheet.getByRole('button', { name: '保存场景，开始练', exact: true }); await save.scrollIntoViewIfNeeded();
  assert.equal(await save.evaluate(element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === element || element.contains(hit); }), true, 'sheet action is not covered by navigation');
  assert.equal(await page.evaluate(() => !document.elementFromPoint(innerWidth / 2, innerHeight - 8)?.closest('.glass-nav')), true, 'modal layer covers the navigation at the bottom edge');
  await save.focus(); await page.keyboard.press('Tab'); assert.equal(await sheet.evaluate(element => element.contains(document.activeElement)), true);
  await capture('navigation-sheet-over-tabs');
  await sheet.getByRole('button', { name: '关闭当前面板', exact: true }).click(); await sheet.waitFor({ state: 'hidden' }); await visibleNavigation();
  console.log('PASS modal sheet covers and inerts navigation, exposes its action, and contains keyboard focus');

  // Simulate a programmatic section change while local presentation state is open.
  // The owning pane must hide its portal, then restore its own form when revisited.
  await page.getByRole('button', { name: /自由练习/ }).click();
  await sheet.locator('#custom-scene-title').fill('Isolated navigation draft');
  await page.evaluate(async () => { const { actions } = await import('/src/store.ts'); actions.setTab('today'); });
  await selected(0); await sheet.waitFor({ state: 'hidden' }); await visibleNavigation();
  assert.equal(await page.locator('.sheet.on').count(), 0, 'hidden speaking pane cannot present its portal over reading');
  await choose(1); await sheet.waitFor({ state: 'visible' });
  assert.equal(await sheet.locator('#custom-scene-title').inputValue(), 'Isolated navigation draft');
  await sheet.getByRole('button', { name: '关闭当前面板', exact: true }).click(); await sheet.waitFor({ state: 'hidden' }); await visibleNavigation();
  console.log('PASS a hidden owner suppresses its portal while preserving that root pane’s local draft');

  await choose(0); await page.getByRole('button', { name: /经典书库/ }).click(); await activePush('learningLibrary').waitFor({ state: 'visible' });
  await choose(1); await page.getByRole('button', { name: '去生词本挑一个', exact: true }).click(); await activePush('learningWordbook').waitFor({ state: 'visible' });
  assert.ok(await page.locator('.push[data-push-id]').count() >= 2, 'two section stacks exist before switching test profiles');
  const fixtureIdentity = await page.evaluate(async () => {
    const { switchProfile, profileIdentity, actions } = await import('/src/store.ts');
    await switchProfile('apple-navigation-test-' + crypto.randomUUID(), false);
    actions.setOnboarded();
    return profileIdentity();
  });
  assert.match(fixtureIdentity, /^apple-navigation-test-/);
  await page.waitForFunction(() => document.querySelectorAll('.push[data-push-id]').length === 0);
  assert.equal(await page.locator('.sheet.on').count(), 0);
  await choose(1); await page.getByRole('button', { name: /自由练习/ }).click(); await sheet.waitFor({ state: 'visible' });
  assert.equal(await sheet.locator('#custom-scene-title').inputValue(), '', 'the new isolated profile does not inherit a cached pane draft');
  console.log('PASS switching to an isolated test profile clears every cached navigation entry and local form state');
  assert.deepEqual(errors, []); console.log('PASS: Apple navigation browser acceptance');
} finally { await browser.close(); }
