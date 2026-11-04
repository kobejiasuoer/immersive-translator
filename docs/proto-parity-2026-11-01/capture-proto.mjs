/**
 * 原型截图采集脚本 —— prototypes/mobile-accepted-2026-10-29.html 逐状态基准。
 * 只产出截图到 docs/proto-parity-2026-11-01/prototype/，不改动任何产品代码。
 * 运行：node docs/proto-parity-2026-11-01/capture-proto.mjs [--only 前缀1,前缀2]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/yangbishang/Projects/immersive-translator/.zcode/uitools/node_modules/playwright");

const ROOT = "/Users/yangbishang/Projects/immersive-translator";
const OUT = join(ROOT, "docs/proto-parity-2026-11-01/prototype");
mkdirSync(OUT, { recursive: true });

const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 160)));

await page.goto("file://" + join(ROOT, "prototypes/mobile-accepted-2026-10-29.html"));
await page.waitForSelector("#phone .view", { timeout: 10000 });

const shots = [];
const fails = [];

async function shot(name, extraWait = 0) {
  if (ONLY && !ONLY.some((p) => name.startsWith(p))) return;
  if (extraWait) await page.waitForTimeout(extraWait);
  const phone = await page.$("#phone");
  const box = await phone.boundingBox();
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    clip: { x: box.x + 8, y: box.y + 8, width: box.width - 16, height: box.height - 16 },
  });
  shots.push(name);
  console.log("  ✓", name);
}

/* 看板左侧：切换演示场景 / 快速路由 */
async function scenario(name) {
  await page.click(`.intro [data-act="demo-scenario"][data-demo="${name}"]`);
  await page.waitForTimeout(600);
}
async function route(tab) {
  await page.click(`.intro [data-act="demo-route"][data-v="${tab}"]`);
  await page.waitForTimeout(500);
}
async function fastForward() {
  await page.click('.intro [data-act="demo-fast-forward"]');
  await page.waitForTimeout(400);
}

/* 手机内：点 view 层或 sheet 层的 data-act 按钮。sheet=1 在 .sheet 里找（同一时刻只渲染最上层抽屉） */
async function act(sel, opts = {}) {
  const scope = opts.sheet ? "#phone .sheet" : "#phone .view";
  for (let i = 0; i < 2; i++) {
    try {
      const el = page.locator(`${scope} ${sel}`).first();
      await el.waitFor({ state: "visible", timeout: 6000 });
      await el.click();
      await page.waitForTimeout(opts.wait ?? 480);
      return;
    } catch (e) {
      if (i === 1) { await dump(`act 失败: ${sel}`); throw e; }
      await page.waitForTimeout(400);
    }
  }
}
async function fill(sel, value, opts = {}) {
  const scope = opts.sheet ? "#phone .sheet" : "#phone .view";
  const el = page.locator(`${scope} ${sel}`).first();
  await el.waitFor({ state: "visible", timeout: 6000 });
  await el.fill(value);
  await page.waitForTimeout(opts.wait ?? 250);
  /* 主动失焦：避免下一次 render 移除聚焦输入框时触发 blur 的 DOM 移除异常 */
  await page.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch {} }).catch(() => {});
}

/* 失败现场：当前页头标题、是否开抽屉、可见动作列表 */
async function dump(reason) {
  try {
    const info = await page.evaluate(() => {
      const phone = document.querySelector("#phone");
      const view = phone.querySelector(".view");
      const title = view?.querySelector(".rtitle,.nt b")?.textContent?.trim() || view?.className || "?";
      const sheet = phone.querySelector(".sheet");
      const sheetName = sheet ? sheet.getAttribute("aria-label") || sheet.querySelector(".sh-head b,.sh-head h3")?.textContent?.trim() || "?" : "无";
      const acts = [...phone.querySelectorAll(".sheet [data-act], .view [data-act]")]
        .filter((e) => e.offsetParent)
        .map((e) => e.dataset.act).slice(0, 40);
      return { title, sheetName, acts: [...new Set(acts)] };
    });
    console.log(`    [dump] ${reason} | view=${info.title} | sheet=${info.sheetName} | acts=${info.acts.join(",")}`);
  } catch { console.log("    [dump] 页面不可用:", reason); }
}

async function group(title, fn) {
  console.log("◆", title);
  try {
    await fn();
  } catch (e) {
    fails.push(title);
    console.log("  ✗ 组失败:", title, "-", String(e).split("\n")[0].slice(0, 200));
  }
}

/* ============ G1 欢迎 & 登录表单 ============ */
await group("G1 欢迎/协议/登录", async () => {
  await scenario("fresh");
  await shot("welcome");
  await act('[data-act="open-agreement"][data-v="privacy"]');
  await shot("sheet-agreement-privacy");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="open-sync-rule"]');
  await shot("sheet-sync-rule");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="welcome-login"]');
  await shot("login-new");
  await act('[data-act="auth-code-help"]');
  await shot("sheet-auth-code-help");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="login-mode"][data-v="password"]');
  await shot("login-password");
  await act('[data-act="toggle-password"]');
  await shot("login-password-visible");
  await act('[data-act="forgot-pwd"]');
  await shot("sheet-reset-pwd");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="login-mode"][data-v="code"]');
  await fill('[data-inp="login-account"]', "lin@example.com");
  await fill('[data-inp="login-code"]', "111111");
  await act('[data-act="do-login"]');
  await shot("login-code-error");
  await act('[data-act="send-code"]', { wait: 900 });
  await shot("login-code-sent", 200);
});

await group("G2 验证码过期/密码错误/电脑快登", async () => {
  await scenario("login-error");
  await shot("login-error");
  await act('[data-act="login-mode"][data-v="password"]');
  await fill('[data-inp="login-account"]', "lin@example.com");
  await fill('[data-inp="login-password"]', "wrong-pass");
  await act('[data-act="do-login"]');
  await shot("login-password-error");
  await act('[data-act="login-mode"][data-v="qr"]');
  await shot("login-qr-0");
  await act('[data-act="pair-scan"]');
  await shot("login-qr-1");
  await act('[data-act="pair-request"]');
  await shot("login-qr-2");
  await act('[data-act="pair-check"]');
  await shot("login-qr-3");
});

/* ============ G3 目标页 & 阅读器 ============ */
await group("G3 目标页与阅读器", async () => {
  await scenario("fresh");
  await act('[data-act="start-experience"]');
  await shot("goal");
  await act('[data-act="choose-goal"][data-v="work"]');
  await shot("goal-selected");
  await act('[data-act="skip-goal"]');
  await shot("reader-starter-coach");
  await act('[data-act="read-dismiss-coach"]');
  await shot("reader-starter");
  await act('[data-act="read-toggle-mask"]');
  await shot("reader-starter-translation");
  await act('[data-act="read-toggle-mask"]');
});

await group("G4 句子解析/查词/改译文", async () => {
  await act(".v2-sentence");
  await shot("sheet-sentence-parse");
  await act('[data-act="read-sheet-tab"][data-v="words"]', { sheet: 1 });
  await shot("sheet-sentence-words");
  await act('[data-act="read-sheet-tab"][data-v="vocab"]', { sheet: 1 });
  await shot("sheet-sentence-vocab");
  await act('[data-act="read-edit-cn"]', { sheet: 1 });
  await shot("sheet-edit-translation");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act(".v2-inline-term");
  await shot("sheet-lookup");
  await act('[data-act="read-collect"]', { sheet: 1, wait: 200 });
  await shot("sheet-lookup-collected");
  await page.waitForTimeout(3300);
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="read-manual-lookup"]');
  await shot("sheet-read-word-search");
  await fill('[data-inp="read-word-query"]', "quiet", { sheet: 1 });
  await act('[data-act="read-word-query-submit"]', { sheet: 1 });
  await shot("sheet-lookup-manual");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
});

await group("G5 阅读设置与三主题", async () => {
  await act('[data-act="open-reading-settings"]');
  await shot("sheet-reading-settings");
  await act('[data-act="v2-set-theme"][data-v="sepia"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await shot("reader-starter-sepia");
  await act('[data-act="open-reading-settings"]');
  await act('[data-act="v2-set-theme"][data-v="dark"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await shot("reader-starter-dark");
  await act('[data-act="open-reading-settings"]');
  await act('[data-act="v2-set-theme"][data-v="green"]', { sheet: 1 });
  await act('[data-act="v2-set-font"][data-v="22"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await shot("reader-starter-font22");
  await act('[data-act="open-reading-settings"]');
  await act('[data-act="v2-set-font"][data-v="18"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
});

await group("G6 读完卡/目录", async () => {
  for (let i = 0; i < 4; i++) await act('[data-act="read-next"]');
  await shot("reader-finish");
  await act('[data-act="read-finish-only"]', { wait: 250 });
  await shot("reader-finish-only", 120);
  await page.waitForTimeout(3300);
  await act('[data-act="read-toc"]');
  await shot("sheet-contents-shelf");
  await act('[data-act="close-sheet"]', { sheet: 1 });
});

/* ============ G7 书架/书库/资讯 ============ */
await group("G7 书架与书库", async () => {
  await scenario("fresh");
  await route("read");
  await shot("read-fresh");
  await act('[data-act="open-library"]');
  await shot("library");
  await act('[data-act="library-filter"][data-v="easy"]');
  await shot("library-easy");
  await act('[data-act="library-filter"][data-v="all"]');
  await act('[data-act="book-sample"][data-id="b2"]');
  await shot("sheet-book-sample");
  await act('[data-act="add-and-read-book"][data-id="b2"]', { sheet: 1 });
  await shot("reader-book-magi");
  await act('[data-act="back"]'); /* 回到书库 */
  await act('[data-act="add-book"][data-id="b1"]', { wait: 250 });
  await shot("library-added", 150);
  await page.waitForTimeout(3300);
  await act('[data-act="ask-remove-book"][data-id="b1"]');
  await shot("sheet-remove-book");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="back"]');
});

await group("G8 资讯订阅", async () => {
  await act('[data-act="open-feeds"]');
  await shot("feeds");
  await act('[data-act="feed-preview"][data-id="f1"]');
  await shot("sheet-feed-preview");
  await act('[data-act="subscribe-feed"][data-id="f1"]', { sheet: 1, wait: 250 });
  await shot("reader-feed-doc");
  await page.waitForTimeout(3300);
  await act('[data-act="back"]');
  await act('[data-act="back"]');
});

/* ============ G9 导入与预览 ============ */
await group("G9 导入与预览", async () => {
  await act('[data-act="open-import"]');
  await shot("import-text");
  await act('[data-act="import-mode"][data-v="url"]');
  await shot("import-url");
  await fill('[data-inp="import-url"]', "https://openai.com/blog");
  await act('[data-act="preview-import"]', { wait: 900 });
  await shot("import-url-error");
  await act('[data-act="import-fallback"]');
  await page.waitForTimeout(3400); /* 等 toast 消失 */
  await fill('[data-inp="import-title"]', "Morning Walk Notes");
  await fill('[data-inp="import-text"]', "Every morning I walk along the river near my home. The quiet water helps me clear my head before work. I take a break from screens and just watch the birds.");
  await shot("import-text-filled");
  await act('[data-act="preview-import"]');
  await shot("import-preview");
  await act('[data-act="save-import"]');
  await shot("reader-imported");
  await page.waitForTimeout(3300);
  await act('[data-act="back"]');
  await act('[data-act="back"]');
});

await group("G10 搜索", async () => {
  await act('[data-act="open-search"]');
  await shot("search-empty");
  await act('[data-act="quick-search"][data-v="take a break"]');
  await shot("search-results");
  await act('[data-act="search-scope"][data-v="words"]');
  await shot("search-scope-words");
  await fill('[data-inp="search-q"]', "zzzqq");
  await shot("search-no-result");
  await act('[data-act="clear-search"]');
  await act('[data-act="back"]');
});

/* ============ G11 口语首页与场景练习 ============ */
await group("G11 口语首页/自定义场景/替换练习", async () => {
  await scenario("fresh");
  await route("speak");
  await shot("speak-fresh");
  await act('[data-act="v2-sp-custom"]');
  await shot("sheet-custom-scene");
  await fill('[data-inp="v2-sp-scene-title"]', "向同事介绍一个方案", { sheet: 1 });
  await fill('[data-inp="v2-sp-scene-goal"]', "讲清楚方案解决什么问题，下一步怎么做", { sheet: 1 });
  await shot("sheet-custom-scene-filled");
  await act('[data-act="v2-sp-create-scene"]', { sheet: 1 });
  await shot("practice-scene-custom");
  await act('[data-act="v2-sp-exit"]');
  await act('[data-act="v2-sp-pause"]', { sheet: 1 });
  await route("speak");
  await shot("speak-resume");
  /* 再开新练习 → 出「上次的练习还在」 */
  await act('[data-act="v2-sp-start-scene"][data-v="点餐"]');
  await shot("sheet-replace-practice");
  await act('[data-act="v2-sp-replace"]', { sheet: 1 });
  await shot("practice-scene-answer");
});

await group("G12 练习草稿与评测反馈", async () => {
  await act('[data-act="v2-sp-type"]');
  await shot("practice-draft-empty");
  await fill('[data-inp="v2-sp-answer"]', "I'd like the salmon salad, and could you put the dressing on the side?");
  await shot("practice-draft-filled");
  await act('[data-act="v2-sp-submit"]', { wait: 220 });
  await shot("practice-checking");
  await page.waitForTimeout(800);
  await shot("practice-feedback-good");
  await act('[data-act="v2-sp-pronunciation"]');
  await shot("sheet-pronunciation");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="v2-sp-next"]'); /* 进入第 2 步（answer 态）再演示跳过弹层 */
  await act('[data-act="v2-sp-type"]'); /* answer 态没有输入框，先切文字回答 */
  await fill('[data-inp="v2-sp-answer"]', "Just sparkling water with lemon.");
  await act('[data-act="v2-sp-skip"]');
  await shot("sheet-skip-step");
  await act('[data-act="v2-sp-confirm-skip"]', { sheet: 1 });
  await act('[data-act="v2-sp-exit"]');
  await shot("sheet-practice-exit");
  await act('[data-act="v2-sp-pause"]', { sheet: 1 });
});

await group("G13 词专项纠偏反馈与复盘", async () => {
  await route("speak");
  await act('[data-act="v2-sp-start-word"][data-w="take a break"]'); /* 已有进行中的练习 → 替换弹层 */
  await act('[data-act="v2-sp-replace"]', { sheet: 1 });
  await shot("practice-word-answer");
  await act('[data-act="v2-sp-type"]');
  await fill('[data-inp="v2-sp-answer"]', "I rest a little after lunch.");
  await act('[data-act="v2-sp-submit"]', { wait: 900 });
  await shot("practice-feedback-correction");
  await act('[data-act="v2-sp-retry"]');
  await shot("practice-retry");
  await act('[data-act="v2-sp-skip"]'); /* 重说态草稿为空，跳过直接收尾出复盘 */
  await shot("practice-recap-correction");
  await act('[data-act="v2-sp-save-correction"]', { wait: 250 });
  await shot("practice-recap-correction-saved", 150);
  await page.waitForTimeout(3300);
  await act('[data-act="v2-sp-session"]');
  await shot("session-detail");
  await act('[data-act="back"]');
  await act('[data-act="v2-sp-return"]');
});

await group("G14 麦克风授权与录音态", async () => {
  await scenario("fresh");
  await route("speak");
  await act('[data-act="v2-sp-start-word"][data-w="take a break"]');
  await act('[data-act="v2-sp-record"]');
  await shot("sheet-mic-permission");
  await act('[data-act="v2-sp-deny-mic"]', { sheet: 1 });
  await page.waitForTimeout(3400);
  await act('[data-act="v2-sp-record"]');
  await shot("sheet-mic-permission-denied");
  await act('[data-act="v2-sp-allow-mic"]', { sheet: 1 });
  await shot("practice-recording", 800);
  await act('[data-act="v2-sp-stop-record"]');
  await shot("practice-draft-recorded");
});

await group("G15 麦克风未授权场景", async () => {
  await scenario("mic-denied");
  await shot("practice-mic-denied");
});

/* ============ G16 复习三模式（tomorrow 场景自带 3 条到期 + 1 条纠偏） ============ */
await group("G16 明日返场与填空复习", async () => {
  await scenario("tomorrow");
  await shot("read-tomorrow");
  await route("speak");
  await shot("speak-tomorrow");
  await route("vault");
  await shot("vault-today-due");
  await act('[data-act="v2-review-start"]');
  await shot("review-cloze-question");
  await act('[data-act="v2-review-hint"]');
  await act('[data-act="v2-review-hint"]');
  await act('[data-act="v2-review-hint"]');
  await shot("review-cloze-hint");
  await fill('[data-inp="v2-review-draft"]', "take a break");
  await act('[data-act="v2-review-reveal"]');
  await shot("review-cloze-revealed");
  await act('[data-act="v2-review-grade"][data-v="0"]');
  await shot("review-cloze-next");
  await act('[data-act="v2-review-reveal"]');
  await act('[data-act="v2-review-grade"][data-v="2"]');
  await act('[data-act="v2-review-reveal"]');
  await act('[data-act="v2-review-grade"][data-v="1"]');
  await shot("review-done");
  await act('[data-act="v2-review-today"]');
  await act('[data-act="v2-review-schedule"]');
  await shot("sheet-review-schedule");
  await act('[data-act="close-sheet"]', { sheet: 1 });
});

await group("G17 听音辨认", async () => {
  await scenario("returning");
  await route("vault");
  await act('[data-act="v2-review-mode"][data-v="listen"]');
  await act('[data-act="v2-review-start"]');
  await shot("review-listen");
  await act('[data-act="v2-review-listen"]');
  await shot("review-listen-listened");
  await act('[data-act="v2-review-reveal"]');
  await shot("review-listen-revealed");
  await act('[data-act="v2-review-grade"][data-v="2"]');
  await act('[data-act="v2-review-listen"]');
  await act('[data-act="v2-review-reveal"]');
  await act('[data-act="v2-review-grade"][data-v="2"]');
  await act('[data-act="v2-review-listen"]');
  await act('[data-act="v2-review-reveal"]');
  await act('[data-act="v2-review-grade"][data-v="2"]');
  await act('[data-act="v2-review-return"]');
  await route("vault");
  await shot("vault-today-resume");
});

await group("G18 开口使用", async () => {
  await scenario("returning");
  await route("vault");
  await act('[data-act="v2-review-mode"][data-v="speak"]');
  await act('[data-act="v2-review-start"]');
  await shot("review-speak-question");
  await act('[data-act="v2-review-record"]');
  await shot("sheet-review-mic-permission");
  await act('[data-act="v2-review-mic-allow"]', { sheet: 1 });
  await shot("review-speak-recording", 1200);
  await act('[data-act="v2-review-record-stop"]');
  await shot("review-speak-recorded");
  await fill('[data-inp="v2-review-draft"]', "Researchers measured how fast volunteers could move through a text.");
  await act('[data-act="v2-review-speaking-confirm"]');
  await shot("review-speak-confirmed");
  await act('[data-act="v2-review-grade"][data-v="1"]');
});

await group("G19 待强化与快进返场", async () => {
  await scenario("waiting");
  await route("vault");
  await shot("vault-today-waiting");
  await fastForward();
  await shot("vault-today-fast-forward", 150);
  await page.waitForTimeout(3300);
});

/* ============ G20 生词本（returning 场景 7 条词） ============ */
await group("G20 生词本与词条", async () => {
  await scenario("returning");
  await route("vault");
  await act('[data-act="v2-vault-section"][data-v="words"]');
  await shot("vault-words");
  await fill('[data-inp="v2-word-search"]', "incon");
  await shot("vault-words-search");
  await act('[data-act="v2-word-clear-query"]');
  await act('[data-act="v2-word-stage-filter"][data-v="能说出口"]');
  await shot("vault-words-stage");
  await act('[data-act="v2-word-clear-filters"]');
  await act('[data-act="v2-add-word-open"]');
  await shot("sheet-add-word");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act(".v2-word-item");
  await shot("sheet-word-detail");
  await act('[data-act="v2-word-edit-open"]', { sheet: 1 });
  await shot("sheet-word-edit");
  await act('[data-act="back"]', { sheet: 1 });
  await act('[data-act="v2-word-remove-confirm"]', { sheet: 1 });
  await shot("sheet-word-remove");
  await act('[data-act="back"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  /* 移除后出现撤销行 */
  await act(".v2-word-item");
  await act('[data-act="v2-word-remove-confirm"]', { sheet: 1 });
  await act('[data-act="v2-word-remove"]', { sheet: 1 });
  await shot("vault-word-undo");
  await act('[data-act="v2-word-undo"]');
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="v2-export-open"]');
  await shot("sheet-export-notes");
  await act('[data-act="close-sheet"]', { sheet: 1 });
});

await group("G21 生词本独立页/提醒", async () => {
  await route("speak");
  await act('[data-act="v2-sp-wordbook"]');
  await shot("wordbook-page");
  await act('[data-act="back"]');
  await route("vault");
  await act('[data-act="v2-vault-section"][data-v="today"]');
  await shot("vault-today-returning");
  await act('[data-act="open-reminder"]');
  await shot("sheet-reminder");
  await act('[data-act="v2-reminder-save"]', { sheet: 1 });
  await shot("sheet-reminder-permission");
  await act('[data-act="v2-reminder-deny"]', { sheet: 1 });
});

/* ============ G22 纠偏详情与学习笔记（tomorrow 自带 1 条纠偏） ============ */
await group("G22 纠偏详情与学习笔记", async () => {
  await scenario("tomorrow");
  await route("vault");
  await act('[data-act="v2-vault-section"][data-v="notes"]');
  await shot("vault-notes");
  await act(".v2-note-item");
  await shot("correction");
  await act('[data-act="v2-correction-practice"]');
  await shot("practice-retry-guide");
  await act('[data-act="v2-sp-exit"]');
  await act('[data-act="v2-sp-pause"]', { sheet: 1 });
  await route("vault");
  await act('[data-act="v2-vault-section"][data-v="notes"]');
  await act('[data-act="v2-note-add-open"]');
  await shot("sheet-add-learning-note");
  await fill('[data-inp="v2-note-draft"][data-field="title"]', "点餐常用句式", { sheet: 1 });
  await fill('[data-inp="v2-note-draft"][data-field="text"]', "I'd like... / Could I have... 比直述 I want 更自然；先记句式，再换内容。", { sheet: 1 });
  await act('[data-act="v2-note-save"]', { sheet: 1 });
  await act(".v2-note-item");
  await shot("learning-note");
  await act('[data-act="back"]');
});

/* ============ G23 账号面板 ============ */
await group("G23 账号面板（成员/游客/离线）", async () => {
  await scenario("returning");
  await route("read");
  await shot("read-returning");
  await act(".v2-account-entry");
  await shot("sheet-account-member");
  await act('[data-act="logout"]', { sheet: 1 });
  await shot("sheet-logout");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="open-goal"]', { sheet: 1 });
  await shot("goal-account");
  await act('[data-act="finish-goal"]'); /* 恢复原位（书架根页，无抽屉） */
  await scenario("fresh");
  await route("read");
  await act(".v2-account-entry");
  await shot("sheet-account-guest");
  await act('[data-act="open-sync-rule"]', { sheet: 1 });
  await shot("sheet-account-sync-rule");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await scenario("offline");
  await route("read");
  await shot("read-offline");
  await act(".v2-account-entry");
  await shot("sheet-account-offline");
  await act('[data-act="save-login"]', { sheet: 1 });
  await shot("login-upgrade");
  await act('[data-act="send-code"]', { wait: 300 });
  await shot("login-offline-send-error");
  await act('[data-act="continue-without-login"]');
});

/* ============ G24 电脑进度阅读器与跟读 ============ */
await group("G24 电脑进度阅读器/书目录/跟读", async () => {
  await scenario("returning");
  await route("read");
  await act('[data-act="read-open-doc"][data-id="classic-5"]');
  await shot("reader-classic5");
  await act('[data-act="read-toc"]');
  await shot("sheet-contents-book");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act(".v2-inline-term");
  await shot("sheet-lookup-classic");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act(".v2-sentence");
  await shot("sheet-sentence-classic");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="read-follow-current"]');
  await shot("practice-follow");
  await act('[data-act="v2-sp-type"]');
  await fill('[data-inp="v2-sp-answer"]', "High above the city stood the statue of the Happy Prince.");
  await act('[data-act="v2-sp-submit"]', { wait: 900 });
  await act('[data-act="v2-sp-next"]');
  await shot("practice-recap-follow");
  await act('[data-act="v2-sp-return"]');
  await route("speak");
  await act('[data-act="open-voice-settings"]');
  await shot("sheet-voice-settings");
  await act('[data-act="close-sheet"]', { sheet: 1 });
  await act('[data-act="v2-sp-history"]');
  await shot("session-history");
  await act('[data-act="v2-sp-session"]');
  await shot("session-detail-history");
  await act('[data-act="back"]');
});

await browser.close();

console.log(`\n完成：${shots.length} 张截图 → ${OUT}`);
if (fails.length) {
  console.log("失败分组：", fails.join(" | "));
  process.exitCode = 2;
}
