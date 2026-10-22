# 交互动效方案 —— immersive-translator-mobile v3 巡检与实施计划

- **基线 commit**：`93f5f55`（2026-10-20 巡检）
- **方法**：`improve-animations`（只读巡检、不改源码）× `interaction-design`；对照设计基线 `docs/mobile-v3-candidate-a.md` §2.9 与 `docs/mobile-v3-design-2026-09-24.md` §1.8（两表一致，下称「动效规格」）
- **范围**：320ms push 栈、底部 sheet、通知横幅、按压态与触感、加载/骨架、列表增删、主题切换
- **唯一缓动约定**：`--ease: cubic-bezier(0.32, 0.72, 0, 1)`（`immersive-translator-mobile/src/ui/tokens.css:62`）。本方案所有新增动效一律复用它，不引入第二条曲线；新增时长只从现有刻度取值（100/120/160/200/240/280/320/400ms）
- **降级约定**：全库已有全局兜底 `@media (prefers-reduced-motion: reduce)`（`immersive-translator-mobile/src/ui/base.css:2542-2549`，`transition/animation: none !important`），与规格「全部降级为即时切换」一致——纯 CSS 动效无需逐条处理；**只有 JS 驱动的位移（scrollIntoView、测量高度折叠）需要显式 matchMedia 分支**，逐条标注

---

## 0. 结论摘要

- **过度动效：未发现**。tabin 160ms、cardin 240ms、eq/tp/breathe 常驻循环均为规格内或状态指示，频率与 personality（静气·纸感）匹配；`transition: all` 全库零命中（grep 已验证）。
- **最大的问题集中在「规格已写、实现未播」**：横幅 400ms 弹入从未播放（挂载即带终态类）、识别卡翻面 240ms 是硬切、触感规格 7 处只落地 3 处、按压态 100ms 大面积缺过渡。
- **一个真·时序问题**：连播朗读每句强制瞬时居中（`scrollIntoView` 无视当前可视区），旗舰阅读流被逐句「拽」一下。
- **一个死代码**：`.cam-scan` + `@keyframes scan` 零引用。

## 0.1 已定案、不翻案（巡检确认实现与规格一致）

| 规格（§1.8 / candidate-a §2.9） | 实现 | 状态 |
| --- | --- | --- |
| push/pop 320ms `--ease` | `base.css:464`；进栈双 rAF 触发（`App.tsx:77-82`）、出栈 330ms 后卸载 | ✅ |
| sheet 280ms 上滑 + dim 淡入；关闭 visibility 延迟防硬切 | `base.css:517-554` | ✅ |
| sheet 下拉跟手，>120px 或 >0.4px/ms 关闭 | 距离分支已实现；**速度分支缺失 = 优先级清单 P-15，本方案不重复** | ⚠ 见 P-15 |
| tab 160ms 淡入 + 4px 上移 | `base.css:79-92` `tabin` | ✅ |
| 判分/揭底：遮罩揭句 200ms | `base.css:1147`（`.sent-zh` filter/opacity 200ms）+ peek 380ms（`ReaderScreen.tsx:255-261`） | ✅ |
| 骨架屏 1.2s 呼吸 2 行灰条 | `base.css:1206-1221`；翻译等待态 2 行（`TranslateScreen.tsx:193-196`）、流式译文 caret（`base.css:1435-1448`） | ✅ |
| reduced-motion 全部降级即时 | `base.css:2542-2549` | ✅ |

---

## 1. 动效审计（按优先级）

> 每条含：位置（仓库根相对路径：行号）/ 现状 / 问题 / 建议（精确值）/ 实施（自包含步骤）/ 验收 / reduced-motion 回退。

### M-01【HIGH】通知横幅的 400ms 弹入/收起从未播放——挂载即终态，进出场全是硬切

- **位置**：`immersive-translator-mobile/src/App.tsx:370-371`（`{bannerState && (<div className="banner on">`）；`immersive-translator-mobile/src/ui/base.css:601-617`；`immersive-translator-mobile/src/store.ts:804-819`（showBanner/closeBanner/snoozeBanner 置 null）
- **现状**：CSS 已按规格写好——`.banner { transform: translateY(-140%); transition: transform 400ms var(--ease) }`、`.banner.on { transform: none }`。但 JSX 在元素**首次插入时就带 `.on`**：新插入元素的样式没有「变化过程」，CSS transition 不运行。关横幅时 `closeBanner()` 直接置 null → 整棵卸载，同样没有离场。
- **问题**：规格明文「通知横幅（应用内）| 顶部弹入 400ms」（`docs/mobile-v3-design-2026-09-24.md:140`）——这是全 app 唯一的通知面，现在进出场都是 0ms 硬切，屏幕顶部凭空出现/消失一块卡片；60s 自动收起时同样是硬切。CSS 里的 400ms 与 `-140%` 全部是死值。
- **建议**：横幅生命周期改为「挂载（无 .on）→ 双 rAF 加 .on → 400ms 滑入；关闭时先摘 .on → 420ms 后卸载」，曲线/时长维持规格 400ms `--ease`、位移维持 `translateY(-140%)` 不变。
- **实施**（只改 `immersive-translator-mobile/src/App.tsx`，CSS 零改动）：
  1. 新增本地组件（放在 `Missing` 旁）：
     ```tsx
     function BannerHost({ b, onClose }: { b: { title: string; body: string }; onClose: () => void }) {
       const [phase, setPhase] = useState<"enter" | "in" | "out">("enter");
       useEffect(() => {
         const id = requestAnimationFrame(() => requestAnimationFrame(() => setPhase("in")));
         return () => cancelAnimationFrame(id);
       }, []);
       const close = () => {
         setPhase("out");
         setTimeout(onClose, 420); /* 400ms 过渡 + 20ms 余量 */
       };
       return (
         <div className={`banner ${phase === "in" ? "on" : ""}`}>
           {/* ……原 App.tsx:372-406 的横幅内容原样搬入，
               其中 actions.closeBanner() 的两处 onClick 改为 close()；
               「稍后」按钮：先 close() 再 actions.snoozeBanner()；
               「先清一张」按钮：先 close() 再 nav.push("quick", { fromNotify: true })，
               push 的 320ms 转场与横幅 400ms 收起并行，无需串行等待 */}
         </div>
       );
     }
     ```
  2. `App.tsx:370` 的条件渲染改为 `{bannerState && <BannerHost b={bannerState} onClose={() => actions.closeBanner()} />}`。
  3. 60s 自动收起（`App.tsx:217-229`）不动——它调 `actions.closeBanner()`；把该 effect 的超时回调改为经由与 `close()` 相同的离场路径：给 `BannerHost` 暴露一个 ref 方法，或最简单地在 `App` 里用 `bannerClosing` state 包装（推荐前者，改动最小：`onClose` 仍走 `closeBanner()`，自动收起改为触发 `BannerHost` 的 `close()`）。
- **验收**：触发到期提醒横幅（或把 `App.tsx:246` 的 8000ms 临时改短验证后还原）：① 弹入可见「从屏顶滑下 400ms」而非瞬间出现；② 点「稍后」/关闭钮/60s 超时，横幅滑回屏顶后消失，期间无白底残块；③ DevTools Animations 面板 10% 倍速逐帧看：起始位 `translateY(-140%)`，曲线前快后缓（`--ease`）；④ 连续「稍后→再触发」横幅每次都重新播放入场。
- **reduced-motion 回退**：全局兜底把 400ms 过渡降为 0ms——横幅即挂即显、即摘即隐（规格允许的「即时切换」）；420ms 卸载定时器照跑，只是无过渡，无残块、无功能影响，无需 JS 分支。

### M-02【HIGH】连播朗读每句强制瞬时居中——阅读流被逐句「拽」

- **位置**：`immersive-translator-mobile/src/screens/ReaderScreen.tsx:68-75`（`scrollToSent` → `el?.scrollIntoView({ block: "center" })`，无 `behavior`，默认瞬时）；调用点 `ReaderScreen.tsx:104`（`stepTo` 连播推进）、`:131`（`playFrom` 起播）
- **现状**：连播每播完一句，`stepTo` 无条件 `scrollToSent(下一句)`，把该句瞬移到视口正中。
- **问题**：① `scrollIntoView({ block: "center" })` **即使目标句已在可视区内也会滚动**——用户正在读第 8 句而播放到第 5 句时，页面每 3-5 秒被瞬时拽回一次，旗舰阅读流的滚动位置不受自己控制；② 即便需要滚动，瞬时跳变（`behavior` 缺省 = `"auto"`）也没有位置连续性，与「静气」的阅读体验相悖。
- **建议**：滚动改为「按需 + 平滑」——目标句已在舒适区（视口 25%–65% 带内）则完全不滚；在带外才滚，且用 `behavior: "smooth"`（浏览器平滑滚动约 300-500ms、自动 ease-out）。长文朗读是持续动作，平滑滚动不会打断朗读。
- **实施**（只改 `immersive-translator-mobile/src/screens/ReaderScreen.tsx`）：
  ```tsx
  const scrollToSent = useCallback((i: number) => {
    progLockUntil.current = Date.now() + 600;
    const body = bodyRef.current;
    const el = body?.querySelector(`[data-si="${i}"]`);
    if (!el || !body) return;
    const r = el.getBoundingClientRect();
    const bodyTop = body.getBoundingClientRect().top;
    const rel = (r.top - bodyTop) / body.clientHeight;          /* 0=顶 1=底 */
    if (rel >= 0.25 && rel <= 0.65) return;                      /* 舒适区内不滚 */
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, []);
  ```
  断点恢复/词典定位（`:54`、`:82`）希望确定性落位，保留瞬时：给函数加第二参 `(i, instant = false)`，两处调用传 `instant=true` 走原 `scrollIntoView({ block: "center" })`。
- **验收**：① 连播状态下页面对准一句后**不再逐句跳动**，仅当高亮句滚出视口下沿 35% 时才平滑滚回居中；② 手动滚动到别处再点播放，首句平滑居中；③ 朗读推进与滚动不打架（progLock 600ms 逻辑不变，`ReaderScreen.tsx:40`）；④ 断点恢复、点词定位仍瞬时落位。
- **reduced-motion 回退**：上面 matchMedia 分支——reduce 用户走 `behavior:"auto"` 瞬时（维持今天的确定性，仅去掉不必要的滚动）。

### M-03【MEDIUM】识别卡「点按翻面」无 240ms 过渡——正面/背面内容硬切

- **位置**：`immersive-translator-mobile/src/screens/ReviewScreen.tsx:320-325`（front 支路渲染「点按翻面」span，flip 后 `:326-331` 整块换成 hint/pattern）；同型 `immersive-translator-mobile/src/screens/QuickReview.tsx:106-117`
- **现状**：`flip()` 只改 `phase`，同一帧内正/背内容直接互换，无任何过渡。
- **问题**：规格明文「判分/揭底 | 翻面 240ms」（`docs/mobile-v3-design-2026-09-24.md:138`）——这是复习核心循环里规格点名的动画，现在是硬切；翻面瞬间内容「闪变」，与同屏 240ms 入场的下一张卡（`.rv-card` cardin，`base.css:1244`）不连贯。
- **建议**：翻面时对背面内容重放 240ms `cardin`（复用现有 keyframes `base.css:1246-1255`：opacity 0→1 + translateY(10px)→0，`var(--ease)`）。不做 3D rotateY——规格的「不做 scale、防布局抖动」精神下，淡入+上移是本库已批准的翻面语汇（`.rv-card` 已在用）。
- **实施**：
  1. `base.css` 复习流段（`:1255` 之后）加一条：`.rv-flip { animation: cardin 240ms var(--ease); }`
  2. `ReviewScreen.tsx:326` 的 `<>` 背面支路改为 `<div className="rv-flip" key="back">`（包住 hint/pattern 两行，闭合标签对应改）；`QuickReview.tsx:118-123` 同型处理（包 hint + GradeRow）。
  3. 评分按钮组（`ReviewScreen.tsx:264-278` 条件渲染的 `.grades`）同病：瞬时弹入。给它也套 `rv-flip`（`<div className="grades rv-flip">`），评分档位 240ms 淡入上移，与翻面同一节拍。
- **验收**：① 识别卡点「点按翻面」：背面 hint 以 240ms 淡入+上移呈现，正面链接消失；② 提交答案后评分四档同样 240ms 入场；③ 连续翻面/撤销（undo 回 front）每次都重放，无「动画只播一次」；④ 下一张卡整体 cardin 不受影响。
- **reduced-motion 回退**：CSS 动画被全局兜底清零 → 内容即时切换（与今天行为一致），无需 JS 分支。

### M-04【MEDIUM】触感规格 7 处只落地 3 处——评分/收词/开麦/清空到期全缺

- **位置**：全库 haptic 调用仅 6 处（grep 验证）：`kit.tsx:170`（左滑删除）、`App.tsx:83/111/341`（push/replace/tab）、`SettingsScreens.tsx:54/322`（连接测试 success）。规格（`docs/mobile-v3-design-2026-09-24.md` §1.8 末行）：**tab/评分/收词/开麦 = light；清空今日到期 = success**。缺失：评分（`ReviewScreen.tsx:192` `gradeVocab`、`QuickReview.tsx:73`）、收词（`store.ts:617` `saveWord` 成功路径）、开麦（`SpeakScreens.tsx:508` holdbtn onStart、`CaptionScreen` `start()`、`ShadowScreen` 录音开始）、清空今日到期 success（`QuickReview.tsx:72-75` 清掉最后一张到期时）。
- **问题**：触感是「按压态与触感反馈」的一半；评分/收词/开麦是高频核心动作，规格点名却零触感，操作确认全靠视觉。设置页两处 success 触感（`SettingsScreens.tsx:54/322`）反而落在规格未点名的场景，优先级倒挂。
- **建议**：按规格补齐 4 处，全部复用 `services/device.ts:70-86` 现有 `haptic("light" | "success")`（真机 Tauri 插件、浏览器 vibrate、失败静默）：
  1. **评分**：`ReviewScreen.tsx:177` `grade(g)` 函数体首行、`QuickReview.tsx:72` `grade(g)` 首行 → `haptic("light")`；
  2. **收词**：`store.ts` `saveWord` 在 `toast(...)`（`:617`）前 → `haptic("light")`（store 已可 import device 的 haptic；若担心循环依赖，改在 `sheets.tsx:170` `collect()` 内 `actions.saveWord(...)` 之前调用）；
  3. **开麦**：`SpeakScreens.tsx` `beginHold`（useHold 的 onStart，`:363`）、`CaptionScreen` `start()` 成功开录处、`ShadowScreen` `setPhase("rec")`（`:164`）→ `haptic("light")`；
  4. **清空到期 success**：`QuickReview.tsx:72` `grade()` 里判定 `st.due === 1`（本次评分后归零，`st` 来自 `reviewStats`）→ `haptic("success")`（与 light 二选一：到期归零只发 success，避免双击感）。
- **验收**：真机（Tauri iOS）：① 评分四档、收藏单词、按住开麦各有一次轻微单脉冲；② 清掉当天最后一张到期卡是一次 success 双脉冲（`device.ts:85` `[12,40,12]`）；③ 浏览器 dev 环境无异常（vibrate 静默失败）；④ jsdom 冒烟 `node scripts/smoke.mjs` 仍全绿（haptic 已有 try/catch 包裹）。
- **reduced-motion 回退**：不适用——触感不是运动，prefers-reduced-motion 用户同样需要操作确认（这正是把确认从视觉位移分摊到触感的意义）；保持原样。

### M-05【MEDIUM】列表删除零离场、新增零入场——行被「报删」，其余行瞬间上跳

- **位置**：`immersive-translator-mobile/src/ui/kit.tsx:85-181`（SwipeRow：`onDelete` 直接进 store，列表即时重渲染）；调用面 5 处：`VocabScreen.tsx:17`、`ShelfScreen.tsx:66`、`MiscScreens.tsx:33/162`、`NotesScreens.tsx:308`
- **现状**：左滑露出「删除」→ 点击 → `deleteWord/deleteArticle/deleteHistory/deleteNote` 同步生效 → 该行从 DOM 消失，下方所有行瞬移上补；撤销恢复时行又瞬移插回。
- **问题**：「列表增删」是本次巡检点名面；删除是破坏性动作，行瞬移让用户失去「删的是这一行」的空间确认（有 5s 撤销 toast 兜底功能，但视觉断裂仍在）。同库 `cap-card` 已有先例（`base.css:2068` cardin 入场），列表行反而没有。
- **建议**：**删 = 200ms 折叠离场（height→0 + opacity→0，`--ease`），删完再进 store；增 = 行插入时 240ms cardin 入场**（CSS 动画在插入时自动播放，key 稳定的旧行不会重放）。
- **实施**：
  1. 入场：`base.css:995-1031` 左滑段给 `.swipe-row` 加 `animation: cardin 240ms var(--ease);`（一行，五个调用面同时生效；undo 恢复也吃到入场）。
  2. 离场（`kit.tsx` SwipeRow 改造，`:169-172` 的删除按钮 onClick）：
     ```tsx
     function collapseDelete() {
       const row = ref.current;               /* .swipe-main/.vmain 行体 */
       const wrap = row?.parentElement;       /* .swipe-row */
       haptic("light");                        /* 原 :170 保留 */
       if (!row || !wrap || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
         onDelete(); return;                   /* reduce：直接删，无动画 */
       }
       const h = wrap.offsetHeight;            /* 先量后写，避免 reflow 抖动 */
       wrap.style.height = `${h}px`;
       wrap.style.transition = "height 200ms cubic-bezier(0.32,0.72,0,1), opacity 200ms cubic-bezier(0.32,0.72,0,1)";
       requestAnimationFrame(() => {
         wrap.style.height = "0px";
         wrap.style.opacity = "0";
       });
       setTimeout(onDelete, 210);              /* 200ms + 余量；不依赖 transitionend（jsdom/中断安全） */
     }
     ```
     注意：`.swipe-row` 需要允许高度动画——加 `overflow: hidden` 已有（`base.css:997`），无需改；行底部发丝线随 wrap 折叠一起消失，正确。
- **验收**：① 生词页左滑删除：行 200ms 压扁淡出、下方行平滑上补（非瞬跳）；② 5s 内点撤销：行以 240ms cardin 插回原位；③ 连续快删多行互不串扰（每行独立 wrap）；④ 书架/历史/笔记库三面同样生效；⑤ 滑动中（拖拽未释放）不触发折叠。
- **reduced-motion 回退**：实施代码里显式 matchMedia 分支——reduce 时跳过折叠直接 `onDelete()`（即时切换）；入场动画被全局兜底清零，无需处理。

### M-06【MEDIUM】sheet 下拉关闭手势只认抓手条——15px 命中高，拉正文无响应

- **位置**：`immersive-translator-mobile/src/ui/sheets.tsx:62-100`（pointer 事件只挂 `grabRef`，`:90`）；`immersive-translator-mobile/src/ui/base.css:555-568`（`.sheet-grab` padding 8+2px + 5px 把手 ≈ 15px 命中高）
- **现状**：只有抓手条能拖 sheet；在 sheet 正文/标题上向下拖，页面无响应（或触发正文滚动）。
- **问题**：iOS 半模态的肌肉记忆是「抓住 sheet 任意位置下拉」；现在唯一手势区命中高度约 15px（远低于 44px 热区惯例），词典卡、导入抽屉这类高频 sheet 的关闭路径只有遮罩点击和抓手条两条。速度分支缺失另见优先级清单 **P-15**（`sheets.tsx:88` 只有 dy>120，缺 >0.4px/ms），本条与其共用同一 handler，**实施时一并修**。
- **建议**：手势区扩到整个 `.sheet`（正文滚动保持可用：仅当 `scrollTop === 0` 且向下拖才接管）；顺手在 down 时记 `t0`，up 时算速度 `v = dy / (Date.now() - t0)`，`dy > 120 || v > 0.4` 关闭（P-15 的修复）。
- **实施**（`immersive-translator-mobile/src/ui/sheets.tsx:62-100`）：
  1. `drag.current` 初始结构改为 `{ sy: 0, dy: 0, on: false, t0: 0, taken: false }`；
  2. down 从 `grab` 改挂到 `el`（`sheetElRef.current`）：`down` 里记 `t0 = performance.now()`；若事件目标是 `.sheet-body` 内且 `sheetBody.scrollTop > 0` 则不接管（`on = false`）——body 元素可经 `el.querySelector(".sheet-body")` 取；
  3. `move` 中：`dy < 0` 时忽略（向上交给滚动）；首次 `dy > 6` 才置 `taken = true` 并 `preventDefault`，避免与点击/滚动竞争；
  4. `up` 中：`const v = drag.current.dy / Math.max(1, performance.now() - drag.current.t0); if (drag.current.dy > 120 || v > 0.4) actions.setSheet(null);`（P-15 同步闭环）；
  5. 抓手条保留（`.sheet-grab` 在 sheet 内部，事件冒泡到同一 handler，无需单独挂载）。
- **验收**：① 在词典卡标题/正文区向下拖：sheet 跟手位移，松手 >120px 或快速轻扫（<300ms 内拉 120px+）都关闭，否则 280ms 弹回；② sheet 内容超长时：先向下滚内容（scrollTop>0）不触发拖拽，滚到顶再下拉才跟手；③ 抓手条行为不变；④ 打开 Aa 面板点字号 ±，点击不被误判为拖拽（6px 死区）。
- **reduced-motion 回退**：拖拽跟手是用户手驱动的位移，不属于自动动画，保留（iOS 同此惯例）；松手后的 280ms 回弹/关闭过渡被全局兜底清零 → 释放即贴目标位，可接受。

### M-07【MEDIUM】toast 给 sheet 让位是瞬移——`bottom` 内联直写，无过渡

- **位置**：`immersive-translator-mobile/src/store.ts:855-860`（`repositionToasts` 直写 `t.style.bottom`）；`immersive-translator-mobile/src/store.ts:526-532`（`setSheet` 在 rAF + 340ms 两次调用它）；`immersive-translator-mobile/src/ui/base.css:653-679`（`.toast` 只过渡 opacity/transform）
- **现状**：sheet 开/关时 toast 的 `bottom` 被内联改写，但 `.toast` 的 transition 不含 `bottom` → toast 在 96px 与 sheet 顶+12px 两个位置间瞬移。
- **问题**：收词 toast 存活 5s（带动作，`store.ts:884`），期间开词典卡/任何 sheet，底部一块墨色胶囊瞬间跳 100-300px，来回各一次——「验收 #4」要解决遮挡，代价是把瞬移引入了。
- **建议**：让位量改走 `transform`（GPU 合成，复用现有 200ms `--ease` transform 过渡），`bottom` 保持常量。
- **实施**：
  1. `base.css:669-671` 与 `.toast.on` 改为：
     ```css
     .toast { /* 原: transform: translateY(8px); */ transform: translateY(8px);
       transition: opacity 200ms, transform 200ms var(--ease); }
     .toast.on { opacity: 1; transform: translateY(var(--toast-lift, 0px)); }
     ```
  2. `store.ts:855-860` 改为写变量：
     ```ts
     function repositionToasts() {
       const sheet = document.querySelector<HTMLElement>(".sheet.on");
       const lift = sheet ? Math.max(0, sheet.offsetHeight + 12 - 96) : 0; /* 96 = 常驻 bottom 基线 */
       document.querySelectorAll<HTMLElement>(".toast").forEach((t) => {
         t.style.setProperty("--toast-lift", `-${lift}px`);
       });
     }
     ```
     （`env(safe-area-inset-bottom)` 两个位置都含同一常量，相减抵消，无需读 env。）
- **验收**：① 收词 toast 在屏时打开词典卡：toast 以 200ms 平滑上移到 sheet 上方 12px；关 sheet 平滑回落；② 无 toast 时开关 sheet 无副作用；③ toast 进场仍是 8px 上浮淡入、离场下沉淡出；④ 深色主题 toast（`base.css:685-689`）同样生效。
- **reduced-motion 回退**：全局兜底清零过渡 → 让位变回瞬时切换（与今天行为相同，只是机制换成变量），无需 JS 分支。

### M-08【LOW】拍译/手动输入 → 翻译结果 `replace` 硬切

- **位置**：`immersive-translator-mobile/src/App.tsx:107-112`（`replace`：`entered: true` 直接挂载）；触发点 `CameraScreen.tsx:159/336`
- **现状**：replace 顶替栈顶时，旧屏同帧卸载、新屏同帧挂载（已带 `entered`），无任何转场。
- **问题**：相机（深色取景）→ 翻译结果（纸底）0ms 硬切，是全 app 唯一没有转场的屏间跳转；push/pop 都有 320ms，唯独这条主链路「闪变」。
- **建议**：replace 复用 push 的入场路径（`entered: false` + 双 rAF 置真），新屏以 320ms `--ease` 从右滑入——与 §1.8 push 规格同源，旧屏即刻卸载、露出 tab 层作为滑入背景，无需叠加层。
- **实施**（`App.tsx:107-112`）：
  ```tsx
  replace: (name, props = {}) => {
    const entry: Entry = { id: ++idRef.current, name, props, entered: false, closing: false };
    stackRef.current = [...stackRef.current.slice(0, -1), entry];
    sync();
    requestAnimationFrame(() => requestAnimationFrame(() => { entry.entered = true; sync(); }));
    haptic("light");
  },
  ```
- **验收**：① 拍译识别成功 → 翻译结果从右滑入 320ms；② 手动输入入口（`CameraScreen.tsx:336`）同样滑入；③ 快门连拍防抖不受影响（`busy` 门控在先）；④ 深链 `#translate`（`App.tsx:120`）首次进入同样滑入，无违和。
- **reduced-motion 回退**：全局兜底 → 即时切换（与今天一致），无需 JS 分支。

### M-09【LOW】两处进度条动画走 `width` 布局属性——改 `transform: scaleX`

- **位置**：`immersive-translator-mobile/src/ui/base.css:795-801`（`.meter > i`，`transition: width 320ms var(--ease)`，今天页/复习进度）、`immersive-translator-mobile/src/ui/base.css:1111-1116`（`.rd-prog > i`，`transition: width 200ms`，阅读进度）
- **现状/问题**：`width` 每帧触发 layout+paint；2px 高条视觉开销小，但两处都是播放/复习中的高频更新点（连播逐句、评分逐张），合成器友好的 `scaleX` 是零成本替换。
- **建议**：进度墨线改为 `transform: scaleX(p)` + `transform-origin: left`，分别保留 320ms/200ms `--ease`。JSX 写入处同步换算：`Meter`（`kit.tsx:76-82`）改 `style={{ transform: \`scaleX(${pct / 100})\` }}`；`ReaderScreen.tsx` 与 `ReviewScreen.tsx:293` 的 `.rd-prog/.meter` 内联 width 同改。
- **验收**：① 今天页阅读进度、复习顶栏进度、阅读页顶部进度线视觉与增长节奏与改前一致（圆角 1-2px 在 scaleX 下形变不可辨）；② DevTools Layers 确认滚动/播放中无 layout 抖动（Performance 面板紫色 Layout 块消失）；③ 进度从 0 起播不闪满条（`i` 默认 `width:0` 改 `transform: scaleX(0)`）。
- **reduced-motion 回退**：进度条是状态指示非装饰运动，过渡被清零后直接落位——正确行为，无需处理。

### M-10【LOW】`.cam-scan` + `@keyframes scan` 死代码（且动画 `top` 布局属性）

- **位置**：`immersive-translator-mobile/src/ui/base.css:1605-1631`
- **现状**：`grep -rn "cam-scan" src --include="*.tsx"` 零命中——扫描线动画无任何触发点（拍摄流程已改为 flash + 「识别中…」文案，`CameraScreen.tsx:177/294`）。
- **问题**：死样式 27 行，且若未来被接线会引入 `top` 布局属性动画。
- **建议**：直接删除 `.cam-scan/.cam-scan.go/@keyframes scan`（`base.css:1605-1631`）。若产品想恢复「识别中」扫描线，另行按 `transform: translateY()` 方案实现，不复用这段。
- **验收**：删除后 `npm run build` 通过；拍译全流程（拍/相册/权限拒绝/无文字）视觉无回归。
- **reduced-motion 回退**：不适用（删除项）。

### M-11【LOW】直译 FAB 显隐硬切

- **位置**：`immersive-translator-mobile/src/screens/CaptionScreen.tsx:403-412`（`{!rec && <button className="cap-fab">`）；`immersive-translator-mobile/src/ui/base.css:2091-2108`
- **现状/问题**：开录时 72px FAB 同帧消失、停录同帧出现，底部视觉重心突跳；这是「录音中」状态切换的主要空间信号。
- **建议**：常挂载 + 类切换：`.cap-fab { transition: transform 200ms var(--ease), opacity 200ms var(--ease); } .cap-fab.hide { opacity: 0; transform: translateX(-50%) scale(0.9); pointer-events: none; }`（基础态保持 `translateX(-50%) scale(1)`，注意 FAB 定位依赖 translateX(-50%)，hide 态必须带上）。`CaptionScreen.tsx:403` 改为 `<button className={\`cap-fab ${rec ? "hide" : ""}\`}>`，rec 期间 `disabled={rec}`。
- **验收**：① 点 FAB 开录：FAB 200ms 缩退淡出；② 停录：200ms 回弹归位；③ rec 中 FAB 不可点（避免与录音冲突）；④ 空态→首卡出现不闪烁。
- **reduced-motion 回退**：全局兜底 → 瞬时显隐（与今天一致），无需 JS 分支。

### M-12【LOW】按压态 100ms 过渡大面积缺失——多数 `:active` 是瞬时硬切

- **位置**：规格「按压 | `:active` 背景 → `--surface-2`（或 opacity .78）100ms」（`docs/mobile-v3-design-2026-09-24.md:137`）。`.btn/.btn-ghost` 已有 `transition: opacity 0.1s`（`base.css:158/175`），以下按住/抬起均为 0ms 硬切：`.tlink`（180-187）、`.iconbtn`（188-200）、`.press`（134-136）、`.frow:active`（346-348）、`.menu-item:active`（593-595）、`.grade:active`（1347-1349）、`.chip:active`（1491-1493）、`.tr-bottom .tb:active`（1528-1530）、`.sh-actions .sb:active`（2006-2008）、`.dict-actions .da:active`（2388-2390）、`.holdbtn` 状态切换（1858-1862，无 transition）、`.aa-steps button`（2427-2429）、`.recent .rc:active`（981-983）、`.src-card:active`（2349-2351）等。
- **问题**：规格给了 100ms 刻度，但只有主按钮吃到；高频的行、图标钮、chip 按下/抬起都是硬切，与 `.btn` 不一致（同一屏内两种按压手感）。判定为打磨项：瞬时高亮在移动端可接受，此处是「统一到自家规格」而非纠错。
- **建议**：一条组规则统一补齐（不动 `.btn/.btn-ghost/.tab/.switch/.cam-shutter i` 这些已有过渡的）：
  ```css
  /* base.css「通用排版」段（:133 前）新增 */
  .press, .tlink, .iconbtn, .frow, .menu-item, .grade, .chip,
  .tr-bottom .tb, .sh-actions .sb, .dict-actions .da, .aa-steps button,
  .recent .rc, .src-card, .holdbtn {
    transition: opacity 100ms linear, background-color 100ms linear;
  }
  ```
  `.holdbtn.rec` 的 border/color 变化追加 `border-color 100ms linear, color 100ms linear` 到该元素（`base.css:1841` 处单列）。
- **验收**：① 设置页行、词典卡按钮、翻译页 chip 按下有 100ms 渐入、抬起 100ms 渐出（不再闪烁感）；② `.btn` 主按钮手感不变；③ 快速连点无过渡堆积（transition 自动重定目标，符合可中断性）。
- **reduced-motion 回退**：全局兜底 → 按压态回到瞬时（规格允许），无需处理。

---

## 2. 错过的机会（增量项，非纠错）

按 AUDIT 惯例单列——这些是「没有动效但值得有」的位置，均有真实体验接缝，非愿望单：

### O-01【MEDIUM】push 打开时底层零反馈——「cover」不像「push」

- **接缝**：push 是全屏不透明盖层（`base.css:458-467`），滑入时底下 tab 层纹丝不动，观感是「盖了一张纸」而非 iOS push 的「推入」（规格曲线注释自称「iOS 惯例位移曲线」，candidate-a.md:168）。
- **建议**：push 存在期间给底层两件小事：① 压暗 scrim：`App.tsx` 在 `<nav className="tabbar">` 前渲染 `<div className={\`push-dim ${stack.length ? "on" : ""}\`} />`，CSS：`position: fixed; inset: 0; z-index: 35; background: rgba(32,29,24,0.12); opacity: 0; transition: opacity 320ms var(--ease); pointer-events: none;` `.push-dim.on { opacity: 1; }`（35 低于 push 40、高于 tabbar 30，正好垫在新屏下面）；② tab 栏 25% 视差：`.tabbar { transition: transform 320ms var(--ease); }` + App 根挂 `pushed` 类时 `.app.pushed .tabbar { transform: translateX(-25%); }`（`App.tsx:323` 的 `.app` div 类名拼入 `stack.length ? "pushed" : ""`）。时长曲线与 push 完全同源，多层叠栈时只看 `stack.length` 布尔，不逐层视差。
- **验收**：任意 push 进出：底层轻微左移+压暗、随 320ms 同步回位；阅读页 rd-black 打开时同样生效；pop 中途点底层（转场未完）不误触（scrim `pointer-events: none`，tabbar 位移不影响命中热区外的空白）。
- **reduced-motion 回退**：过渡清零 → scrim/视差瞬切出现，仍提供层级暗示；若嫌瞬切突兀，可在该两条规则内套 `@media (prefers-reduced-motion: reduce) { .push-dim, .tabbar { transition: none; } }`（与全局兜底等效，无需额外处理）。

### O-02【LOW】Onboarding 三步硬切

- **接缝**：`OnboardingScreen.tsx:43/79/131` 三个 `{step === n && ...}` 支路同帧互换，首启引导的步进感全靠页码数字「2/3→3/3」。
- **建议**：步骤内容包一层 `key={step}` + 复用 `tabin`（160ms 淡入+4px 上移，`base.css:83-92`）：`<div key={step} className="pane-anim">`，CSS `.pane-anim { animation: tabin 160ms ease-out; }`。首启属「罕见/首次」场景，规格允许少量愉悦预算；不用左右滑移（tab 规格「不做左右滑移」的精神一致）。
- **验收**：三步间 160ms 淡入上移；「上一步」回退同样播放入场（方向感对称可接受）；reduced-motion 全局兜底即时切换。

### O-03【LOW】跟读报告卡与快速复习完成态零入场

- **接缝**：`ShadowScreen.tsx:290`（`.sh-report` 评测报告）、`:329/:353`（`.score-pill` 分数胶囊）随 `setPhase` 瞬时出现；`QuickReview.tsx:84-98`（`.qk-done` 完成页）同样硬切——这两处是练习闭环的「结果时刻」，情绪价值最高却最安静。
- **建议**：两处容器加 `animation: cardin 240ms var(--ease)`（报告卡）/ 复用 O-02 的 `.pane-anim`（完成态）；快速复习完成态同时补 `haptic("success")`（并入 M-04 第 4 点同一改动）。
- **验收**：评分完成 → 报告卡 240ms 淡入上移，分数胶囊随后可感知；清完最后一张 → 完成页入场 + success 触感；reduced-motion 即时切换。

### O-04（判定：不做）主题切换过渡

- `applyThemeDom`（`store.ts:465-467`）瞬时切 `data-theme`，全 app 颜色同帧翻转。**建议维持现状**：规格动效表无此行（默认即时）；全局加 color transition 会让所有状态变化（含禁用、评分档位）都拖 200ms 尾巴，性能与「静气」的利落感都受损；设置页内一次性 160ms 微淡入收益不足以引入第三种过渡语义。若未来要做，只在 `setTheme/setThemePref` 时给 `<html>` 挂一次性类 + `body { transition: background-color 160ms linear }`，并在过渡结束后摘类——勿做全局常驻。

---

## 3. 实施顺序与依赖

| 顺序 | 项 | 依赖 | 预估规模 |
| --- | --- | --- | --- |
| 1 | M-01 横幅进出场 | 无 | 1 文件（App.tsx） |
| 2 | M-02 连播滚动 | 无 | 1 文件（ReaderScreen.tsx） |
| 3 | M-04 触感补齐 | 无（可与 O-03 的 success 合并做） | 5 文件 |
| 4 | M-06 sheet 手势区+速度（含 P-15） | 无 | 1 文件（sheets.tsx） |
| 5 | M-03 翻面 240ms | 无 | 2 文件 + 1 行 CSS |
| 6 | M-05 列表增删 | 无 | 2 文件（kit.tsx + base.css） |
| 7 | M-07 toast 让位 | 无 | 2 文件 |
| 8 | M-08 replace 转场 | 无 | 1 文件 |
| 9 | M-11/M-12/M-09/M-10 打磨批 | 无 | base.css 为主 |
| 10 | O-01~O-03 增量批 | M-01/M-04 先行更顺 | 3-4 文件 |

无硬依赖，可并行；建议每项独立提交并在真机（iOS）过一遍验收清单——触感（M-04）与滚动（M-02）必须在真机判断，模拟器/浏览器不作数。

## 4. 全局验收清单

- `npm run build` 零错误；`node scripts/smoke.mjs`（jsdom 冒烟）全绿。
- 每项动效在 DevTools Animations 面板 10% 倍速逐帧过一遍：起始态、曲线形状（`--ease` 前快后缓）、终态无跳变。
- 每项在 Rendering 面板切 `prefers-reduced-motion: reduce` 复验：位移类全部变为即时切换、无残块、无功能损失（M-02/M-05 有显式 JS 分支，其余依赖全局兜底）。
- 连续快速触发（连点返回、连续评分、开关 sheet、连删多行）：所有过渡可中断、无重启归零、无叠加错位。
