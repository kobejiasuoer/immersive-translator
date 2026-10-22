/**
 * v3 冒烟自检（dev-only）：jsdom 挂载 dist 产物，验证首屏与关键交互不抛错。
 * 运行：npm run smoke（需先 npm run build）。
 * 覆盖：首屏 / Onboarding / 清一张 / 阅读+词典卡移除撤销 / 翻译流 / 横幅深链 /
 *       复习流全清（含识别卡翻面评分）→ 完成摘要 → 整理成笔记 → 生词清空态。
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const jsPath = html.match(/src="([^"]+\.js)"/)[1];
const cssPath = html.match(/href="([^"]+\.css)"/)[1];
const js = readFileSync(new URL("../dist" + jsPath, import.meta.url), "utf8");

const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ""), {
  url: "http://localhost:4199/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;

/* ---- 浏览器能力桩（WebKit 环境差异的最低限度） ---- */
window.matchMedia =
  window.matchMedia ||
  ((q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.SpeechSynthesisUtterance = function (t) {
  this.text = t;
};
window.speechSynthesis = {
  cancel() {},
  speak() {},
  getVoices: () => [],
  onvoiceschanged: null,
};
globalThis.speechSynthesis = window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance;
window.localStorage.clear();
/* 播种剪贴板快照（v3 状态）：store 已不再塞演示 CLIP（治 P-06），翻译流入口需要一条真实 clip */
window.localStorage.setItem(
  "ita.v3.state",
  JSON.stringify({
    version: 3,
    clip: { en: "The idea of car-free streets took root after the summer of heatwaves.", zh: "", ts: Date.now() },
  }),
);

const errors = [];
window.addEventListener("error", (e) => errors.push("window.onerror: " + e.message));

/* ---- 注入全局后执行产物 ---- */
for (const k of ["window", "document", "localStorage", "location", "history", "CustomEvent", "Node", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "MutationObserver", "IntersectionObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "UIEvent", "Element", "HTMLElement", "SVGElement", "CSS", "DOMParser"]) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.window = window;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 16));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function q(sel) {
  return window.document.querySelector(sel);
}
function qa(sel) {
  return [...window.document.querySelectorAll(sel)];
}
function text(el) {
  return el ? el.textContent.trim() : "";
}
function click(el) {
  if (!el) throw new Error("click target 为空");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}
function typeInto(el, val) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, val);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function expect(cond, label) {
  if (cond) console.log("  ok  " + label);
  else {
    console.log("  FAIL " + label);
    process.exitCode = 1;
  }
}
const topPush = () => qa(".push:not(.out)").at(-1);

/* 复习卡推进：识别→翻面，完形/听写→直接看答案，出评分→选「想了很久」 */
async function gradeCurrentCard() {
  for (let i = 0; i < 24; i++) {
    const p = topPush();
    if (!p || text(p).includes("复习完成")) return true;
    if (p.querySelector(".grades")) {
      const btns = p.querySelectorAll(".grade");
      expect(btns.length === 4, "四档评分出现（识别卡翻面后可达）");
      btns[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await wait(850);
      continue;
    }
    if (p.querySelector("input.input")) {
      /* U-01 后「直接看答案」由 span 改为 button：选择器两者都收 */
      const giveUp = [...p.querySelectorAll("span, button")].find((el) => text(el) === "直接看答案");
      click(giveUp);
      await wait(250);
      continue;
    }
    const flip = [...p.querySelectorAll("span, button")].find((el) => text(el) === "点按翻面");
    if (flip) {
      click(flip);
      await wait(250);
      continue;
    }
    await wait(150);
  }
  return false;
}

async function main() {
  const t0 = Date.now();
  try {
    // eslint-disable-next-line no-new-func
    new Function(js.replace(/^import[^;]+;/gm, ""))();
  } catch (e) {
    console.log("  FAIL bundle exec: " + e.message);
    process.exitCode = 1;
    return;
  }
  await wait(120);

  console.log(`== 首屏（${Date.now() - t0}ms）==`);
  expect(qa(".tab").length === 5, "Tab 栏 5 项（今天/练/书架/生词/我的）");
  expect(q(".tab .tbadge") && text(q(".tab .tbadge")) === "8", "生词角标 = 8（墨蓝，同源 reviewStats）");
  expect(text(q(".folio")).includes("0/8"), "folio 显示 0/8（统计基线归零：8 到期 · 0 已清）");
  expect(text(q(".hero-num")) === "8", "hero 大数字 = 8 到期");
  const startBtn = qa(".btn").find((b) => text(b) === "开始复习");
  expect(!!startBtn, "主按钮「开始复习」");
  expect(startBtn && startBtn.querySelector("svg") === null, "开始复习为纯墨底文字按钮（无 ▶ 图标，验收 #5）");
  expect(qa("button").some((b) => text(b).includes("先清一张")), "次级按钮「先清一张」");
  expect(qa(".week .w-num").every((n) => text(n) === "0"), "本周三数归零（demo 统计基线不再播种）");

  console.log("== 首启 Onboarding（可跳过进演示） ==");
  expect(!!q(".ob-stage"), "Onboarding 覆盖层出现");
  click(qa("button").find((b) => text(b) === "下一步"));
  await wait(150);
  click(qa("button").find((b) => text(b).includes("先跳过")));
  await wait(350);
  expect(q(".push") === null, "跳过后直接进入今天");

  console.log("== 清一张（快速复习单卡） ==");
  click(qa("button").find((b) => text(b).includes("先清一张")));
  await wait(400);
  const qkInput = q('.push:not(.out) input.input');
  expect(!!qkInput, "完形输入存在（≥17px）");
  typeInto(qkInput, "took root");
  click(qa('.push:not(.out) .iconbtn[aria-label="提交"]')[0]);
  await wait(200);
  expect(text(topPush()).includes("写对了"), "判分 verdict（judge 内核）");
  click(qa('.push:not(.out) .grade')[2]);
  await wait(300);
  expect(text(topPush()).includes("已清 1 张"), "「已清 1 张，还剩 N 张」即走");
  click(qa('.push:not(.out) .btn').find((b) => text(b) === "回到今天"));
  await wait(450);
  expect(text(q(".folio")).includes("1/8"), "folio 今日已清 0→1（同源落盘）");

  console.log("== 阅读页 + 词典卡（已收藏态 → 移除/撤销） ==");
  const cont = qa(".pane.on .sec").find((el) => text(el.querySelector(".overline")) === "继续阅读");
  click(cont);
  await wait(400);
  const readerPush = topPush();
  expect(!!readerPush.querySelector(".rd-playbar"), "播放条出现");
  expect(readerPush.querySelectorAll("[data-si]").length >= 12, "12 句全渲染");
  click(readerPush.querySelector(".tok.ck"));
  await wait(250);
  expect(q(".sheet.on") !== null, "词典卡 sheet 打开");
  expect(text(q(".sheet")).includes("已在生词本"), "已收藏态含「已在生词本 ✓」（验收 #6）");
  const removeBtn = qa(".sheet .da").find((b) => text(b).includes("移除"));
  expect(!!removeBtn, "已收藏态有独立「移除」动作（验收 #6）");
  click(removeBtn);
  await wait(250);
  expect(text(q(".toast")).includes("已移出生词本"), "移除 toast 带撤销");
  click(q(".toast .undo"));
  await wait(250);
  expect(qa(".toast").length === 0 || text(q(".toast")) === "", "撤销后 toast 消失");
  click(readerPush.querySelector('.iconbtn[aria-label="返回"]'));
  await wait(400);

  console.log("== 翻译流 ==");
  click(q(".quote-actions .a"));
  await wait(600);
  const trPush = topPush();
  /* 演示引擎已移除（治「演示引擎假装在工作」）：未配置模型 → 如实引导空态，不再产出伪译文 */
  expect(text(trPush).includes("未配置模型"), "未配置态如实引导（无伪译文）");
  expect(text(trPush).includes("剪贴板"), "来源徽章 = 剪贴板");
  click(trPush.querySelector('.iconbtn[aria-label="返回"]'));
  await wait(400);

  console.log("== 我的（验收 #3：prod 无 spike 自检行） ==");
  click(qa(".tab")[4]);
  await wait(150);
  expect(!text(q(".pane.on")).includes("spike 自检"), "我的页不含 spike 自检入口");
  expect(text(q(".pane.on .h1")) === "我的", "我的标题");
  click(qa(".tab")[0]);
  await wait(150);

  console.log("== 通知横幅（8s 后自动出现一次；60s 自动收起为定时器规格，代码核验） ==");
  await wait(8800);
  expect(q(".banner.on") !== null, "横幅弹入（今晚的复习提醒）");
  expect(text(q(".banner")).includes("个生词到期"), "横幅文案带到期数（同源 reviewStats）");
  click(qa(".banner .bbtn").find((b) => text(b) === "先清一张"));
  await wait(400);
  expect(text(topPush()).includes("来自今晚的复习提醒"), "点横幅深链清一张 + 来源行");
  click(qa('.push:not(.out) .tlink').find((b) => text(b) === "完成"));
  await wait(450);

  console.log("== 复习流全清（识别翻面评分 + 完形/听写看答案） ==");
  click(startBtn);
  await wait(450);
  /* 退出确认 sheet（评分后 toast 不再同时出现，验收 #4 由 toast 上移逻辑核验） */
  click(topPush().querySelector('.iconbtn[aria-label="退出"]'));
  await wait(250);
  expect(q(".sheet.on") !== null, "退出确认 sheet 出现");
  click(qa(".sheet button").find((b) => text(b) === "继续复习"));
  await wait(250);
  expect(q(".sheet.on") === null, "继续复习：sheet 关闭");
  const finished = await gradeCurrentCard();
  expect(finished, "队列全部走完进入完成态");
  const done = topPush();
  expect(text(done).includes("复习完成"), "完成摘要标题");
  expect(text(done).includes("整理成笔记"), "整理成笔记入口（§3.15）");
  expect(done.querySelectorAll(".sum-cell").length === 4, "四格摘要（一次写对/接近/陷阱/未想起）");

  console.log("== 整理成笔记 → 笔记库 ==");
  click([...done.querySelectorAll("button")].find((b) => text(b).includes("整理成笔记")));
  await wait(300);
  let saved = false;
  for (let i = 0; i < 30; i++) {
    const b = qa("button").find((x) => text(x).includes("存入笔记库"));
    if (b) {
      click(b);
      saved = true;
      break;
    }
    await wait(250);
  }
  await wait(350);
  expect(saved, "流式预览完成并可入库");
  expect(text(topPush()).includes("今日复习笔记"), "笔记库出现今日笔记");

  console.log("== 回到今天（清空态） ==");
  click(topPush().querySelector('.iconbtn[aria-label="返回"]'));
  await wait(400);
  click([...topPush().querySelectorAll("button")].find((b) => text(b) === "回到今天"));
  await wait(500);
  expect(text(q(".folio")).includes("8/8"), "folio 今日已清 8/8");
  expect(text(q(".pane.on")).includes("今天的复习清完了"), "hero 清完态（ok 一处）");
  click(qa(".tab")[3]);
  await wait(200);
  expect(text(q(".pane.on")).includes("今天的到期已清空"), "生词页组头 ✓ 态（#52 同源）");

  if (errors.length) {
    console.log("  FAIL 运行时错误: " + errors.join(" | "));
    process.exitCode = 1;
  } else {
    console.log("== 控制台零报错 ==");
  }
  window.close();
}

main();
