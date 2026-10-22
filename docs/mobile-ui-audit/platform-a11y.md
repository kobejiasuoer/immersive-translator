# 平台适配与触控无障碍审计（mobile-v3 · platform + a11y）

- 日期：2026-10-20
- 对象：`immersive-translator-mobile/`（React 19 + TS + Vite + Tauri v2，iOS 先行，WKWebView 壳）
- 基线：`docs/mobile-v3-candidate-a.md`、`docs/mobile-v3-design-2026-09-24.md`（下称「定稿」），行号引证见各条
- 方法：按 apple-web-app skill（conformance checklist：safe-area / status bar / overlay & keyboard / zoom & selection）+ better-accessibility skill（语义、标签、热区、动态播报、reduced-motion、缩放）执行。本轮为**纯静态审计 + 本地脚本检查**，未连接真机/模拟器——凡按 skill 要求必须设备观察的项，一律标注 **Unverified**（见 §3），不以推断冒充。
- 只读审计：未修改任何产品代码；本文件是本轮唯一产出。
- 与既有优先级清单（P-01…P-21）的关系：**不重复收录**。P-01（文字 span 按钮）、P-02（设置输入 <17px）、P-05（横幅/Aa/先清一张/笔记库热区）、P-11（user-scalable=no）、P-12（sheet 无 dialog 语义）、P-13（冷启动闪白）等已立项项仅在交叉引用处提及；本文 §2 全部为清单之外的新增发现。

---

## 0. 结论速览

| 必查项 | 结论 |
| --- | --- |
| 1 安全区（viewport-fit / env(\*) / 键盘避让 / 底距） | **竖屏通过**（viewport-fit=cover + env(top/bottom) 全覆盖、tab/sheet 底距正确）；**横屏不通过**（PA-01）；键盘避让 sheet 过、push 层输入行不过（PA-05 相关、PA-02 相关） |
| 2 触控目标 ≥44×44 | P-01/P-05 已立项主项；**本文新增 10 处清单外不达标点**（PA-16），另有 2.5.7 拖拽替代缺口（PA-17）。WCAG 2.5.8 AA（24px）全部通过 |
| 3 standalone / 状态栏 / 主题色 meta / 深色 / 字号缩放 / reduced-motion | apple-\* meta 对 Tauri 壳 **不适用**（原生壳，见 §1.2）；状态栏无任何原生处理（PA-03，Unverified）；深色模式机制在但系统控件未适配（PA-02）；**正文缩放无任何通道**（PA-04）；reduced-motion **通过**（base.css:2542-2549） |
| 4 WCAG 2.2 触屏相关 | 对比度主体通过、**两处新增失败**（PA-14/PA-15）；目标间距 2.5.8 通过（inline/spacing 例外适用）；焦点可见性原生控件通过；读屏标签：iconbtn 全部有名，但输入标签、选择态、动态播报、push 层边界四处系统性缺口（PA-08…PA-13） |
| 5 index.html / src/ui/ 全部 / tauri.conf + capabilities | 已逐一检查；tauri.conf `productName: "reader-spike"` 遗留与安装名不一致（PA-07）；capabilities 权限本身无 a11y 问题 |

---

## 1. 通过项（本轮实跑证据）

### 1.1 竖屏安全区与底距 —— Pass

- `viewport-fit=cover` 在位：`index.html:5`。
- `env(safe-area-inset-top/bottom)` 消费点全覆盖（grep 全库）：`.pane` 顶 `calc(env(top)+2px)`、底 `calc(64px+env(bottom))`（`src/ui/base.css:66,71`）；tabbar `padding: 9px 6px calc(10px + env(bottom))`（base.css:418）；`.pnav` 顶（base.css:476）；`.sheet-body` 底 `calc(24px+env(bottom))`（base.css:571）；横幅顶 `calc(env(top)+10px)`（base.css:603）；toast 底 `calc(96px+env(bottom))`（base.css:657）；rd-playbar（base.css:1190）、rv-top/rv-stage（base.css:1228,1240）、tr-bottom（base.css:1507）、cam-bottom（base.css:1656）、chat-foot（base.css:1838）、sh-stage（base.css:1936）、cap-fab（base.css:2094）、ob-stage（base.css:2182）、qk-top/qk-stage（base.css:2508,2523）。
- **Tab 底距**：tabbar 底 padding = 10px + inset，`.pane` 底部让位 64px + inset（tabbar 实高 ≈65+inset，仅 1–2px 视觉重叠，不构成可用性问题）。
- **Sheet 底距**：sheet-body 底 padding 24px + inset，下拉关闭后 `visibility:hidden` 不占位。
- **零 inset 健壮性**（apple-web-app：「永远不要假设顶部 inset>0」）：所有高度均为「基础值 + env」形态，无任何 `inset > 0` 分支逻辑；SE/横屏回归到基础值仍可用。Pass。

### 1.2 standalone / 状态栏 / 主题色 meta —— 按上下文不适用（N/A）

本产品经 Tauri v2 以**原生 WKWebView 壳**分发（`src-tauri/tauri.conf.json`，identifier `com.kobejiasuoer.reader`），不是主屏 Web App：

- `apple-mobile-web-app-capable`（index.html:6）对 WKWebView 无作用，属遗留无害 meta；
- `apple-mobile-web-app-status-bar-style` / `theme-color` meta 均**不适用**（前者仅 Safari 主屏模式，后者 Safari 26 起也被页面取色取代，见 apple-web-app theme-color-and-status-bar.md）——iOS 状态栏样式由原生层控制，而原生层**没有任何处理**（见 PA-03）；
- manifest / apple-touch-icon / 启动图集：原生壳走 Assets.xcassets + LaunchScreen.storyboard（`src-tauri/gen/apple/imreader-mobile_iOS/Info.plist:45-46`），不适用 Web 清单。

### 1.3 prefers-reduced-motion —— Pass

`src/ui/base.css:2542-2549`：`@media (prefers-reduced-motion: reduce)` 对 `*`/`::before`/`::after` 关停全部 transition/animation。兑现候选 A V10 承诺（`docs/mobile-v3-candidate-a.md:27`「`prefers-reduced-motion` 全局尊重」）。副作用评估：push 320ms 滑入/横幅 400ms 弹入退化为瞬时显隐、`.sheet` 的 visibility 延迟取消（关闭瞬隐）——均为可接受的静态替代，无前庭触发项残留。

### 1.4 对比度主体 —— Pass（例外见 PA-14/PA-15）

本轮 node 脚本实测（WCAG 相对亮度法；令牌取自 `src/ui/tokens.css`）：

```
ink-3  浅 4.90 / 深 5.25   accent 浅 7.22 / 深 8.07（.tlink）
ok     浅 5.43 / 深 7.00   warn 浅 4.83 / 深 7.37   err 浅 5.15 / 深 6.29
ink-2  浅 7.43 / 深 8.99   ink-4 浅 2.12 / 深 3.07（仅当装饰/禁用才合法）
accent(#2b567f) on #000 = 2.74（即 P-04 的 2.7:1，复核一致）
```

正文/辅助文字/状态色全部 ≥4.5:1，与定稿 §1.2 实测声明一致（`docs/mobile-v3-design-2026-09-24.md:84`）。失败项见 PA-14、PA-15。

### 1.5 焦点可见性 —— 原生控件 Pass

`base.css:50-55`：`button/input/textarea:focus-visible` 2px `--accent` outline（浅 7.22:1 / 深 8.07:1，≥1.4.11 的 3:1，达到 2.4.13 的 2px 实线目标形态）；无 `outline: none` 裸用（grep 无命中）。缺口在语义层而非样式层：可点 span/div 根本不进焦点序（P-01 已立项 + 本文 PA-12）。

### 1.6 读屏标签：icon-only 按钮全量有名 —— Pass

grep `aria-` 全库：26 处 `iconbtn` 全部带 `aria-label`（8 处多行 JSX 的 label 在下一行，逐一核对均在）；`Icon` 统一 `aria-hidden="true"`（`src/ui/icons.tsx:61`）；`Switch` 有 `role="switch"` + `aria-checked`（`src/ui/kit.tsx:66-67`）。缺口见 PA-08…PA-11。

### 1.7 其他 Pass

- `overscroll-behavior: none` 写在样式表（base.css:24），先于首个 touchstart 解析——满足 React Spectrum 前置条件；
- 文本选择保留：`user-select` 抑制只出现在按钮 chrome（base.css:33-41、holdbtn base.css:1854-1856），正文可选可复制；
- `touch-action` 收敛在自有手势面（swipe 行 `pan-y` base.css:1006,1023；sheet-grab `none` base.css:561；holdbtn `none` base.css:1853），未全局禁手势；
- 键盘避让（sheet 范围）：`--kb-inset` 监听 `visualViewport` resize/scroll（`src/ui/sheets.tsx:27-35`）写入 `.sheet { bottom: var(--kb-inset, 0px) }`（base.css:535），阈值 120px 过滤地址栏噪声——sheet 内输入（文内搜索/粘贴/链接）在键盘下可达；
- capabilities（`src-tauri/capabilities/default.json`）：通知/触感/剪贴板/分享/深链权限与 a11y 无冲突。

---

## 2. 新增发现（优先级清单 21 条之外）

排序：high → medium → low。每条给出 file:line 证据与修法。

### PA-01 ｜high｜platform｜横屏已启用但全库零 `env(safe-area-inset-left/right)`，刘海横屏下正文与控件切入传感器区

- **where**：`immersive-translator-mobile/src-tauri/gen/apple/project.yml:46-53`；`immersive-translator-mobile/src-tauri/gen/apple/imreader-mobile_iOS/Info.plist:52-64`；`immersive-translator-mobile/src/ui/base.css:71`
- **problem**：Info.plist 与 XcodeGen 同时声明 iPhone 三向、iPad 四向横屏（`UISupportedInterfaceOrientations` 含 LandscapeLeft/Right），但 grep 全库（src/ + src-tauri/）`safe-area-inset-left|right` **零命中**。横向内边距全是固定值：`.pane` 左右 20px（base.css:71，定稿 §1.5「屏幕左右边距 20」的竖屏口径）、`.pbody` 20/24px（base.css:504,512-514）、`.cam-bottom` 左右 44px（base.css:1656）、`.rd-body` 24px（base.css:1118）。带刘海 iPhone 横屏时左右 inset 达 47–59px：阅读正文、翻译页、拍译页的「相册/翻转」按钮（44px 处起排）一半进入刘海遮挡区。
- **fix**（二选一，推荐 ①）：
  1. 若横屏非产品场景：project.yml 与 Info.plist 收敛为仅 Portrait（iPad 保留 Portrait+UpsideDown），一行配置消除整类问题；
  2. 若保留横屏：tokens.css `:root` 增加 `--safe-x: max(20px, env(safe-area-inset-left)) env... ` 两侧变量（`max()` 保底，符合「0px 是合法值」纪律），`.pane/.pbody/.rd-body/.cam-bottom` 的左右 padding 改 `max(20px, env(safe-area-inset-left/right))`。
- **证据命令**：`grep -rn "safe-area-inset-left\|safe-area-inset-right" src/ src-tauri/` → 0 命中。

### PA-02 ｜medium｜platform｜全库无 `color-scheme` 声明，深色主题下系统键盘/表单控件仍是浅色

- **where**：`immersive-translator-mobile/src/ui/tokens.css:8`（浅色 `:root`）、`tokens.css:33`（`[data-theme="dark"]`）；对照 grep `color-scheme` 全库仅命中 `matchMedia("(prefers-color-scheme: dark)")`（`src/store.ts:195,371,453`），CSS/meta 层零声明
- **problem**：主题由 `document.documentElement.dataset.theme` 驱动（`src/store.ts:466`），但从未声明 `color-scheme`。WKWebView 的系统键盘外观、日期/时间滚轮（设置页提醒时间 `input[type=time]`，SettingsScreens.tsx:504 起）、表单控件与滚动条均按「无声明=light」渲染——深色主题用户在 BYOK/讯飞/搜索输入时弹浅色键盘，与候选 A 深色纸面强烈割裂。
- **fix**：tokens.css `:root, [data-theme="light"] { color-scheme: light; }`、`[data-theme="dark"] { color-scheme: dark; }`（`.rd-black` 作用域同步 `color-scheme: dark`）；可选 index.html 加 `<meta name="color-scheme" content="light dark">` 配合 P-13 的首帧脚本。

### PA-03 ｜medium｜platform｜状态栏样式无任何原生处理，深色主题下状态栏文字颜色未随动（真机表现 Unverified）

- **where**：`immersive-translator-mobile/src-tauri/gen/apple/imreader-mobile_iOS/Info.plist`（全文件无 `UIStatusBarStyle`/`UIUserInterfaceStyle`）；grep `StatusBar|status_bar|prefersStatusBar` 于 `src-tauri/src/`（main.rs/lib.rs/keychain.rs/ocr.rs/voice）与 `gen/apple/Sources/` 均 0 命中；依赖 wry 0.57.0（`src-tauri/Cargo.lock`）
- **problem**：应用内深浅主题是自管状态（store.ts:453 只监听系统变化更新自己的 state），但原生层既没有按主题设置状态栏样式，也没有把 `UIUserInterfaceStyle` 跟随应用主题。浅色纸面+黑字没问题；**深色主题（--bg #1a1815）下若 wry 默认输出深色状态栏文字，时钟将不可读**。按 apple-web-app skill 的验收口径（「installed appearance 必须真机观察」），此项静态只能证明「无处理」，实际表现 **Unverified**。
- **fix**：真机先验证 wry 0.57 默认行为；若不随动，在 Tauri iOS 侧按 `data-theme` 经事件桥调 `setStatusBarStyle`（Rust `#[tauri::command]` + UIViewController overridesUserInterfaceStyle / preferredStatusBarStyle），或至少在外观设置切换时同步原生 `UIViewControllerBasedStatusBarAppearance` 语义。

### PA-04 ｜medium｜platform｜正文缩放零通道：Dynamic Type 不生效 + P-11 禁捏合，低视力无任何放大手段（WCAG 1.4.4）

- **where**：`immersive-translator-mobile/src/ui/base.css:20`（`body { font-family: var(--font-sans) }`，字阶全为固定 px）；tokens.css:58-61 字体栈无 `-apple-system-body`；grep `text-size-adjust` 全库 0 命中
- **problem**：WKWebView 不把用户「动态字体/辅助功能字号」自动应用到固定 px 的普通 Web 文本（只有 `font: -apple-system-body` 的文本参与）；叠加 P-11 的 `user-scalable=no` 禁掉捏合缩放后，应用内**没有任何**放大正文的方式。≥17px 只是下限，不是缩放机制（定稿 §1.4 的输入铁律防的是聚焦弹跳，非放大通道）。
- **fix**：短期——外观页（SetLookScreen）加「字号」档位，写一个 `--fs-scale` 到 `:root`，正文类尺寸走 `calc(<size>px * var(--fs-scale, 1))`（阅读页已有 Aa 15–24 先例，推广到全局正文）；或对正文容器采用 `font: -apple-system-body` 让系统字号接管并配 rem 化。必须与移除 `user-scalable=no`（P-11）同批落地，1.4.4 才算闭合。

### PA-05 ｜low｜platform｜键盘弹起时 sheet 的 `max-height:76%` 不扣除 `--kb-inset`，标题/把手被顶出屏外

- **where**：`immersive-translator-mobile/src/ui/base.css:537`（`max-height: 76%`）、base.css:535（`bottom: var(--kb-inset, 0px)`）
- **problem**：`--kb-inset` 抬升 sheet 底缘后，`max-height` 仍按整屏 76% 计。键盘 ≈336px 时：336 + 0.76×852 ≈ 983 > 852，内容较高的 sheet（文内搜索结果多、导入文库列表）顶部被裁 ≈131px——把手、「排版/文内搜索」标题与首行菜单不可见，且无滚动补偿（裁掉的是 sheet 盒外部分）。
- **fix**：base.css:537 改 `max-height: calc(76% - var(--kb-inset, 0px))`；一处修改，jsdom 回退 0px 不受影响。

### PA-06 ｜low｜platform（Unverified）｜iPad 四向 + iOS 26 窗口化模式下左上主控件无避让

- **where**：`immersive-translator-mobile/src-tauri/gen/apple/project.yml:50-53`（iPad 四向）；`src/ui/kit.tsx:22-27`（PNav 返回钮固定在 `.pnav` 最左，顶距 `calc(env(top)+8px)`，base.css:476）
- **problem**：iPadOS 26 主屏 App 以可缩放窗口打开时，系统控制覆盖左上角且 `env()` 不报告该区域（apple-web-app layout-and-touch.md「iPadOS 26 windowed mode」条目）。「返回」是每个 push 页的唯一导航出口，恰在左上角落，可能被系统控制压住。
- **fix**：有 iPad 真机后观察；若复现，按社区口径给 `.pnav .side.l` 预留 ~64px 左上安全角（仅 `@media (display-mode: windowed)` 或按窗口尺寸判断），或把返回钮右移至标题右侧。
- **Unverified**：无 iPad 设备，本轮未观察。

### PA-07 ｜low｜platform｜安装名三处口径不一致，tauri.conf 残留 spike 代号

- **where**：`immersive-translator-mobile/src-tauri/tauri.conf.json:3`（`"productName": "reader-spike"`）、:17（window title `reader-spike`）；`src-tauri/gen/apple/imreader-mobile_iOS/Info.plist:24-27`（CFBundleName/DisplayName「沉浸口语」）；`index.html:7`（`<title>沉浸阅读室</title>`）
- **problem**：iOS 主屏名取 Info.plist「沉浸口语」，浏览器/dev 窗口标题「沉浸阅读室」，桌面构建产品名「reader-spike」。三处互不一致；若「沉浸口语」是更名后的正式名，index.html 标题与文档口径（沉浸阅读室）都滞后，分享深链落地的 ShareScreen 文案「存入 沉浸口语」（MiscScreens.tsx:351,419）与产品自称相互矛盾。
- **fix**：定名后统一三处（tauri.conf productName、Info.plist DisplayName、index.html title），并把更名决策回写设计档案。

### PA-08 ｜medium｜a11y｜18 处输入控件无编程关联标签（placeholder 充当唯一可见说明，WCAG 1.3.1/3.3.2/4.1.2）

- **where**（逐一核实，全库 `<input|<textarea>` 共 18 处业务输入，均无 `<label>`/`aria-label`/`aria-labelledby`）：
  - `src/ui/sheets.tsx:513`（文内搜索）、:983（粘贴 textarea）、:1002（链接 URL）
  - `src/screens/MiscScreens.tsx:29`（搜索历史）、:118-124（术语表粘贴 textarea）
  - `src/screens/VocabScreen.tsx:90`（搜索生词）
  - `src/screens/OnboardingScreen.tsx:91-98`（首启 API Key，placeholder「sk-…」）
  - `src/screens/TranslateScreen.tsx:167-173`（原文编辑 textarea）
  - `src/screens/ReviewScreen.tsx:419`（完形答案）、:496（听写答案）
  - `src/screens/QuickReview.tsx:136`（答案）
  - `src/screens/SpeakScreens.tsx:487`（打字回复）
  - `src/screens/SettingsScreens.tsx:104,118,137,431,504`（BYOK/讯飞/时间——同屏可见文案均在行内但未关联）
- **problem**：VoiceOver 回退到 placeholder 播报（如「sk-…, 文本字段」），名称要么是示例值要么无意义（「打字回复」尚可，「https://…」不可理解）；C 参与判分的完形/听写输入框播报不出「输入答案」的用途。placeholder 从不是 label。
- **fix**：逐处加 `aria-label`（可见文案在场时优先 `aria-labelledby` 指向行内文字，如设置页 `<span className="meta2">Edge 音色</span>`）；判分输入框（ReviewScreen:419/:496、QuickReview:136）至少 `aria-label="输入答案"`。

### PA-09 ｜medium｜a11y｜全部「选择态」仅靠视觉（对勾/底色），无编程语义，VoiceOver 听不到选中（WCAG 4.1.2）

- **where**：
  - `Seg` 组件 `src/ui/kit.tsx:51-58`——按钮仅切 `.on` class，无 role/aria-checked；消费点：Aa 显示模式与阅读主题（`src/ui/sheets.tsx:380-401`）、语速档（`src/screens/ShadowScreen.tsx`）、字幕模式（`SpeakScreens.tsx`）、`SettingsScreens.tsx`
  - 语速菜单选中态只有一个对勾图标 `src/ui/sheets.tsx:445`
  - 行式 radio：模型服务 `src/screens/SettingsScreens.tsx:86-88`、外观 `:557-561`（`.frow` 内条件渲染 check 图标，无 aria-checked；P-19 只处理了对勾**颜色**，语义是另一件事）
  - 导入抽屉考试 chips `src/ui/sheets.tsx:936-943`、import-tabs 页签 `:893`
  - 首启目标选择 `src/screens/OnboardingScreen.tsx:59`（`ob-opt` button 无 aria-pressed）
  - Tab 选中仅 `.on` 变色 `src/App.tsx:338`
- **problem**：4.1.2 名/值/状态：VoiceOver 对这些控件统一播报「按钮」，选中与否完全不可知；读屏用户在 Aa 面板切「中文」模式、设置页选模型服务商时无法确认结果。
- **fix**：互斥组用 `role="radiogroup"` + 按钮 `role="radio" aria-checked`（最简替代：单按钮加 `aria-pressed`）；Tab 加 `aria-current="true"`；chips/页签同 `aria-pressed`。与 P-19 的对勾着色可同批改。

### PA-10 ｜low｜a11y｜Tab 栏到期角标的数字被 `aria-label` 覆盖，读屏用户永远听不到到期数

- **where**：`immersive-translator-mobile/src/App.tsx:339`（`aria-label={t.label}`）+ `App.tsx:346`（`{st.due > 0 && <span className="tbadge num">{st.due}</span>}`）
- **problem**：可访问名计算中 aria-label 完全取代内容，角标数字不在任何可访问节点里；「生词」Tab 对 VoiceOver 永远只报「生词按钮」，到期数只能靠翻到今天页才知道。
- **fix**：`aria-label={st.due > 0 && t.key === "vocab" ? `生词，${st.due} 个到期` : t.label}`（或角标 span 加 `role="text"` 并放开 aria-label 改用可见文本组名）。

### PA-11 ｜medium｜a11y｜动态消息全程无声：toast 与通知横幅都没有 live 语义（WCAG 4.1.3）

- **where**：toast 为命令式 DOM，`src/store.ts:861-896`（`document.createElement("div"); className="toast"`，无 role/aria-live）；通知横幅 `src/App.tsx:370-407`（`.banner on` 无 role/alert）
- **problem**：「已收藏『word』·去看看」「已移出生词本 · 撤销」「已存入书架精读」以及到期提醒横幅，VoiceOver 全部静默——收藏/撤销链路的操作结果对读屏用户不可知；横幅（含「先清一张」主动作）弹出时焦点不动也不播报，60s 后（App.tsx:217-229）无声消失。撤销 toast 5s 窗口是定稿评审要点 7② 的既定决策（且 .tl 进度线 base.css:690-698 提供视觉倒计时），**不另立 2.2.2 项**；但「无声」不是决策范围内的。
- **fix**：store.ts 建 toast 时 `role="status"`（成功/中性）或 `role="alert"`（失败），用先挂空区后改文本的稳定区域模式；横幅容器加 `role="alert"`（或不打断场景时 `role="status"`），并让「先清一张」成为横幅出现后的顺序焦点第一站。

### PA-12 ｜medium｜a11y｜整卡 div onClick 充当主入口（P-01 清单之外）：无按钮语义、不进焦点序、无 :active 反馈缺口

- **where**（逐一核实为 `<div onClick>`，均无键盘/读屏可达性）：
  - `src/screens/TodayScreen.tsx:47`（未配置引导条→setModel）
  - `src/screens/TodayScreen.tsx:99-117`（「继续阅读」整卡——今天页除复习外的最高频入口）
  - `src/screens/TodayScreen.tsx:129`（剪贴板引文卡）、:181（「拍译」行 cliptwo）
  - `src/screens/TodayScreen.tsx:194,202,209`（练一练三入口：跟读/陪练/直译）
  - `src/screens/ShelfScreen.tsx:67`（书架文章卡，书架页主入口）
  - `src/screens/TranslateScreen.tsx:182`（原文区「点按即编辑」，候选 A §4.9 规定的编辑入口）
  - 另：`src/screens/ReaderScreen.tsx` 的 `.sent`/`.tok`（base.css:1125-1131,1161-1173）为点击正文 span——阅读流特例，建议保留文本流语义、以「跟读此句」等实体按钮（已有，ReaderScreen.tsx:448）作为可发现替代路径，不强改 button。
- **problem**：与 P-01 同根但在其清单之外：VoiceOver 按纯文本播报、无「可激活」特征；这些卡片的命中面积本身达标（≥44），问题纯在语义层。`.guide`（base.css:910-922）还缺 `:active` 按压反馈（tap-highlight 已全局透明，等于无任何按压可视反馈）。
- **fix**：逐处改 `<button>` + `text-align:left; width:100%; background:none`（.row/.prow 同款做法已有先例）；`.guide` 补 `.press` 或 `:active{opacity:.78}`。与 P-01 的 `.tlink` 改造可同批。

### PA-13 ｜medium｜a11y｜push 全屏页不是 dialog：底层 Tab 栏/Pane 仍可被 VoiceOver 漫游并激活

- **where**：`immersive-translator-mobile/src/App.tsx:353-360`（`.push` 容器无 role/aria-modal/inert）；被覆盖物 `App.tsx:334-350`（tabbar，常驻可聚焦）与 `App.tsx:325-331`（当前 `.pane` 为 display:block）
- **problem**：push 页视觉上是全屏模态层（z-index 40 盖过 tabbar z-30），但辅助技术树里底层的 5 个 Tab 按钮与整页内容仍在——VoiceOver 用户可以三向滑到被盖住的「我的」并激活，触发 P-46 场景外的栈错乱；与 P-12（sheet 无边界感）同机制，但 push 层未在 P-12 范围内。
- **fix**：`.push` 根加 `role="dialog" aria-modal="true"` + 以页标题作 `aria-label`；进栈时把焦点移入新页标题（`tabIndex={-1}` + focus()），出栈归还触发点；更彻底的做法是对 `.app` 底层设 `inert`（与 P-12 的 sheet 修复共用一套机制）。

### PA-14 ｜medium｜a11y｜跟读差词标灰用 `--ink-4`（浅 2.12:1 / 深 3.07:1），漏词信息读不清（WCAG 1.4.3 + 定稿 ink-4 纪律）

- **where**：`immersive-translator-mobile/src/ui/base.css:1969-1972`（`.sh-words .w-miss { color: var(--ink-4); text-decoration: line-through }`），由 ShadowScreen 报告卡词级着色消费；`src/ui/tokens.css:16,40`
- **problem**：漏读词是评测的核心反馈信息（22px 常规体，需 ≥4.5:1），实测浅色 2.12:1、深色 3.07:1 双双失败；定稿 §1.2 明文「`--ink-4`（2.1/3.1:1）仅限禁用与装饰用途」（docs/mobile-v3-design-2026-09-24.md:84）。P-06 只覆盖了 Reader/Translate 两处，此处是第三处也是唯一处于判定结果里的。line-through 是非颜色线索（1.4.1 满足），但对比度不足仍不合规。
- **fix**：`.w-miss` 改 `--ink-3`（浅 4.90 / 深 5.25，token 已存在），保留 line-through；若要与 `.w-err`拉开层级，用字重而非颜色。

### PA-15 ｜medium｜a11y｜深色主题口语气泡译文 2.74:1：`[data-theme=dark] .bubble.me .zh` 用 ink-3 落在浅色墨底上

- **where**：`immersive-translator-mobile/src/ui/base.css:1791-1793`（深色下 `.bubble.me .zh { color: var(--ink-3) }`）；气泡底 `background: var(--ink)`（base.css:1784-1790）深色取值 `#ece7dd`（tokens.css:37）
- **problem**：深色主题里「我」的气泡是浅底（--ink 反转），译文弱提示行 ink-3（#938b7c）落在 #ece7dd 上实测 **2.74:1**（12px 文本需 4.5:1）——深色模式下自己发言的中文翻译几乎不可读；浅色主题同结构用 ink-3 on #201d18 无此问题（颜色双双反转、规律不对称），属深色适配漏项。
- **fix**：深色分支改用墨色降透明而非 ink-3：`color: rgba(26, 24, 21, 0.66)`（混出 #615e59，实测 5.24:1）或实色 `#666258`（4.94:1）；改后把该对加入定稿 §6.4 对比度复测清单。

### PA-16 ｜medium｜a11y｜清单之外的实体控件热区不足 44×44（10 处；WCAG 2.5.8 AA 全部通过，按定稿 §1.5 基线记）

- **where / 实测尺寸**：
  - `src/screens/MiscScreens.tsx:353`、`:421-427`——分享页「取消」iconbtn 内联 `width:32,height:32`，覆写 44 默认
  - `src/ui/base.css:1794-1797` `.bubble .spk` 30×30（消费点 `src/screens/SpeakScreens.tsx:441` 朗读钮，AI 气泡每条一个）
  - `src/ui/base.css:227-252` `.switch` 50×30（kit.tsx:62-73 及 Aa/设置多处）
  - `src/ui/base.css:203-226` `.seg` 高 36（Aa/语速/字幕/设置四处 Seg）
  - `src/ui/base.css:1479-1493` `.chip` 高 ≈32（翻译动作 chips）；`:2486-2489` `.exam-chips .chip` 高 ≈29
  - `src/ui/base.css:2444-2451` `.import-tabs button` 高 ≈38
  - `src/main.tsx:67` 崩溃兜底页「回今天」`height:40`
  - `src/screens/SettingsScreens.tsx:139,360,433` 输入/下拉内联 `minHeight:36/38`（36–38px 高的输入框，键盘聚焦命中面小；字号问题 P-02 已立项）
- **problem**：与 P-05 同类但清单外：次要操作、气泡内小钮、分段/开关的命中面低于定稿 §1.5「触控热区 ≥44×44」（docs 行 120）。全部 ≥24px，2.5.8 AA 及其间距例外通过——记基线符合性问题，非 WCAG AA 失败。
- **fix**：统一手法——`.spk/.chip/.import-tabs/.aa-steps`（后者 P-05 已列）用伪元素扩 44×44 透明热区（不碰撞邻元素为限）；`.switch/.seg` 整体 padding 上下各 +4 并以负 margin 抵消布局；MiscScreens 两处去掉 32 覆写恢复 44 默认；main.tsx:67 去 `height:40`；SettingsScreens 三处 `minHeight` 改回 44 并删（P-02 修复时一并处理）。

### PA-17 ｜low｜a11y｜左滑删除（SwipeRow）拖拽是唯一显性路径，无可见单指替代（WCAG 2.5.7）

- **where**：`immersive-translator-mobile/src/ui/kit.tsx:85-181`（指针拖拽逻辑；`.swipe-act` 删除钮 kit.tsx:167-175 被 `z-index:1` 的行内容覆盖，base.css:1032-1045）；使用点：`src/screens/VocabScreen.tsx:17`（删生词）、`src/screens/ShelfScreen.tsx:66`（移出书架）、`src/screens/MiscScreens.tsx:33,162`（删历史/术语对）、`src/screens/NotesScreens.tsx:308`（删笔记）
- **problem**：删除动作依赖向左拖拽 48px 以上（kit.tsx:129）；行内没有「···」菜单或编辑模式作为替代。缓解事实：`.swipe-act` 按钮始终在可访问树里，VoiceOver/语音控制可直达激活，故实际影响限于不支持拖拽的输入法路径；配合 5s 撤销 toast（定稿评审要点 7②）风险可控，记 low。
- **fix**：给 `.swipe-row` 行尾加常驻「···」iconbtn（或长按菜单）内含「删除」，复用同一 `onDelete`；或把行切换为 iOS 风格「编辑」模式批量删。

---

## 3. Unverified（按 skill 口径明确未验证项）

以下判断需要目标设备观察，本轮仅有静态证据，**不作结论**：

1. **PA-01**：刘海横屏下各屏实际遮挡范围（无 iOS 设备/模拟器运行）。
2. **PA-03**：wry 0.57 默认状态栏文字色在深色主题下的实际可读性；启动图（LaunchScreen）到手启画的交接观感。
3. **PA-04/P-11 关联**：`user-scalable=no` 在 WKWebView（非 Safari）内是否实际禁掉捏合——iOS 10+ WebKit 对无障碍缩放有豁免先例（apple-web-app layout-and-touch.md「Zoom restrictions were ignored…do not use them to suppress zoom」），两端皆有可能，需真机判定；但无论判定结果如何，移除该声明（P-11）与补缩放通道（PA-04）都成立。
4. **PA-05**：键盘弹起时 sheet 顶部裁切的实测值（公式推导 ≈131px@852 屏，未运行）。
5. **PA-06**：iPad 窗口化模式下左上控制遮挡（无 iPad 设备）。
6. **键盘/读屏全流程**：better-accessibility 要求的两遍走查（纯键盘流、读屏流）需真机 VoiceOver 会话；本文读屏结论均出自可访问树静态分析（aria/语义/焦点序），非实测播报。

## 4. 与既有优先级清单的衔接注记

- P-02（设置输入 14/15px）修复时，**同三行**存在本文 PA-16 的 `minHeight:36/38` 覆写（SettingsScreens.tsx:139,360,433），建议同一提交处理。
- P-05（横幅/Aa/先清一张/笔记库热区）与本文 PA-16 是同一铁律的两个清单，建议合并为一次「热区清扫」提交。
- P-11（user-scalable=no）+ PA-04（缩放通道）+ P-13（首帧主题）三者共同构成 1.4.4 与首帧体验的闭合，建议同批。
- P-12（sheet dialog 语义）的机制（dialog/inert/焦点移入）应与 PA-13（push 层）共用一套实现。
