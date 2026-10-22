# 沉浸阅读室移动端 · 风格细节规范（style-spec）

> 生成：2026-10-20 · 范围：`immersive-translator-mobile/`
> 依据（实读）：`src/ui/tokens.css`、`src/ui/base.css`（全文 2550 行）、`src/ui/kit.tsx`、`src/ui/sheets.tsx`、`src/ui/icons.tsx`、`src/App.tsx`、`index.html`、`src/store.ts`（主题段）、`src/screens/`（Today/Practice/Shelf/Vocab/Me/Reader/Review/QuickReview/Translate/Camera/Shadow/Caption/Speak/Notes/Misc/Settings/Onboarding/Spike 相应段）
> 设计基线（对照）：`docs/mobile-v3-candidate-a.md`（§2 令牌、§2.9 动效）、`docs/mobile-v3-design-2026-09-24.md`（§1 定稿令牌、§1.8 动效表、§6.4 验收）
> 方法：apple-design（材质层次、触感物理性、响应在按下而非抬起）+ better-ui（精确值、状态矩阵、「同一细节两种做法即 finding」）；全部落为 Web/CSS 可执行值（iOS 16 兼容：禁 `color-mix()`/`oklch()`/嵌套，毛玻璃带 `-webkit-` 前缀）。

---

## 0. 读法

§1–§9 是「应然」规范：每一项给精确值，实现与规范不一致的地方在 §10 有逐条实施计划。凡与定稿文档冲突的取值，以定稿为准；凡定稿未规定而实现已形成的统一惯例，以本文测量值固化为准。§11 是验收清单。

---

## 1. 颜色 token（含深色与纯黑阅读主题映射）

### 1.1 全局两主题（= `tokens.css:8-55` 现值，与定稿 §1.1/§1.2 一致，此处为权威快照）

| token | 浅色（暖纸） | 深色（暖炭） | 用途 | 对比度（浅/深） |
|---|---|---|---|---|
| `--bg` | `#FAF8F3` | `#1A1815` | 全局纸底 | — |
| `--surface` | `#FFFFFF` | `#24211D` | sheet、菜单、模态、gcard | — |
| `--surface-2` | `#F3F0E9` | `#2E2A25` | 按压态、分段轨道、输入框底 | — |
| `--ink` | `#201D18` | `#ECE7DD` | 主文字、主按钮底、激活图标 | 15.8 / — |
| `--ink-2` | `#565147` | `#BFB8AA` | 次级文字、副标题 | 7.4 / — |
| `--ink-3` | `#736C5F` | `#938B7C` | 辅助文字、meta、overline | 4.9 / 5.3 |
| `--ink-4` | `#B4AC9E` | `#6B655A` | **仅禁用与装饰**（真占位、光标点、chev） | 2.1 / ~3.1（不入正文） |
| `--hairline` | `#E7E2D6` | `#35312A` | 一切 1px 分隔线 | — |
| `--hairline-strong` | `#D8D2C2` | `#453F36` | 输入框描边、外部边、按钮描边 | — |
| `--accent` | `#2B567F` | `#8FB3D4` | 墨蓝点缀（四处清单，见 1.2） | 7.2 / 8.1 |
| `--accent-soft` | `rgba(43,86,127,.10)` | `rgba(143,179,212,.14)` | 已收藏词底、选中行底、insight 底 | — |
| `--on-ink` | `#FAF8F3` | `#1A1815` | 墨底上的文字（深色反转） | 15.8 / 14.4 |
| `--ok` / `--ok-soft` | `#3F7050` / `rgba(63,112,80,.10)` | `#85AC90` / `rgba(133,172,144,.14)` | 成功、评测达标 | ≥5.4 / ≥6.3 |
| `--warn` / `--warn-soft` | `#96631C` / `rgba(150,99,28,.10)` | `#C9A15C` / `rgba(201,161,92,.14)` | 提醒、接近阈值、未配置 | ≥4.8 |
| `--err` / `--err-soft` | `#AE4A3C` / `rgba(174,74,60,.10)` | `#D98376` / `rgba(217,131,118,.14)` | **仅真实错误**与评测未达标文字 | ≥5.2 |
| `--tb-bg` | `rgba(250,248,243,.86)` | `rgba(26,24,21,.86)` | tab bar/顶栏/播放条毛玻璃底 | — |
| `--shadow-sheet` | `0 -8px 40px rgba(32,29,24,.14)` | `0 -8px 40px rgba(0,0,0,.5)` | 仅底部 sheet | — |
| `--shadow-pop` | `0 10px 30px rgba(32,29,24,.16)` | `0 10px 30px rgba(0,0,0,.55)` | 仅菜单/toast/pop 卡 | — |

半透明面一律每主题**显式 rgba**（禁 `color-mix()`，iOS 16）；新增 soft 色必须同时给两主题值。

### 1.2 使用纪律（防回潮，定稿 §1.3）

- **墨蓝四处清单**：① tab/图标角标（`.tbadge` base.css:449）② 分段选中、开关 on（base.css:248）③ 进度墨线与进行态（`.meter>i`:799、`.rd-prog>i`:1114、`.caret`:1439、`.eq i`:1893、`.cap-levels i`:2038）④ 文字链接（`.tlink`:181、`.quote-actions .a`:827、`.toast .undo`:681）。其余一律墨色。
- **到期 ≠ 红**：到期 = `--ink` 实心 6px 圆点（`.dot-due`:273-279）+ ink-2 文字；`--err` 只给请求失败（如测试连接失败，见 §10.7 P-18）与判分未达标文字（`.v-err`:1317、`.w-err`:1966、`.sh-words .w-err` 唯一大面积豁免）。
- `--ink-4` 只允许：禁用态、装饰分隔点（`.quote-actions .dot`:833）、chevron（`.chev`:316）、真占位（「等待输入」TranslateScreen.tsx:285）、typing 圆点（`.typing i`:1815）。**不得**用于状态说明/引导句（违反点见 P-06，归 a11y 线处理）。
- 每屏非墨色面积 ≤ 一块按钮或一行标签；同屏彩色 ≤2 种（墨蓝 + 至多一种语义色）。
- 主按钮 = `--ink` 底 + `--on-ink` 字；次按钮 = 无底 + 1px `--hairline-strong` 描边；文字按钮 = `--accent` 链接。

### 1.3 纯黑阅读主题 `.rd-black`（tokens.css:81-92）——**需补全的映射**

现状缺 `--accent/--on-ink/--ok系`，且作用域越界问题见 §10.2（P-04）。规范值（作用域只限阅读正文容器）：

| token | 值 | 说明 |
|---|---|---|
| `--bg` | `#000000` | 正文区底 |
| `--surface` | `#0A0A0B` | — |
| `--surface-2` | `#141416` | 正文内按压/chip 底 |
| `--ink` | `#E8E7E4` | 正文墨（≈17.0:1 on #000，本次重算） |
| `--ink-2` | `#B0AEAB` | ≈9.5:1 |
| `--ink-3` | `#77756F` | ≈4.6:1（正文辅助行下限） |
| `--hairline` / `--hairline-strong` | `#212126` / `#2F2F36` | — |
| `--accent` | `#8FB3D4` | **缺失项**：链接/点状下划线/页边墨线在纯黑上 ≈9.6:1 |
| `--accent-soft` | `rgba(143,179,212,.16)` | 已收藏词底（现状已有） |
| `--on-ink` | `#0A0A0B` | 防御项：正文内若出现墨底钮，near-white 底配深字 ≈16:1 |
| `--ok` / `--warn` / `--err` | `#85AC90` / `#C9A15C` / `#D98376` | 防御项，同深色主题取值 |
| `--tb-bg` | `rgba(10,10,11,.86)` | 现状已有（纯黑作用域收进正文容器后此值仅防御） |

### 1.4 特例

- 相机页是「深腔」表面，不随主题：`#171512` 腔底 + `#FAF8F3` 系前景（base.css:1541/1567/1575/1663-1682），浅深主题一致，属拍景器的物理惯例，非违规。
- 遮罩 scrim 恒 `rgba(32,29,24,.38)`（`.sheet-dim.on`:526），两主题同值——「压暗以聚焦」，apple-design §12 的 dim-to-focus。
- `::selection`：浅 `rgba(43,86,127,.22)` / 深 `rgba(143,179,212,.28)`（base.css:27-32），显式双主题，不得改回单值。
- 深色 toast 反转：`--surface` 底 + `--hairline-strong` 描边（base.css:685-689），非墨底——保留。

---

## 2. 圆角

token（tokens.css:74-77）：`--r-xs:5px`（词性徽章、难度 chip、type-badge）· `--r-s:8px`（输入框、小按钮、hintbox/degrade/sku 提示条、share-act 图标底）· `--r-m:12px`（主/次按钮、gcard、对话气泡、分段控件、recent 卡、播放页 sb、报告卡、prow/scene-ic 图标底）· `--r-l:16px`（sheet 顶部两角）。

补充精确值（实测实现，固化）：

| 元素 | 值 | 位置 |
|---|---|---|
| 句块 `.sent` | 4px | base.css:1127 |
| 词块 `.tok` | 3px | base.css:1162 |
| 对话气泡 | `4px var(--r-m) var(--r-m) var(--r-m)`（AI）/ `var(--r-m) 4px var(--r-m) var(--r-m)`（我）——小角指向说话人 | base.css:1782/1789 |
| grab 条 | 36×5px，圆角 3px | base.css:563-567 |
| 圆形件 | 50%（iconbtn、switch 15px、aa-steps、cap-fab、cam 按钮组、ob-check、toast 进度） | — |
| 胶囊 | 999px（warn-chip、chip、bbtn、score-pill、src-badge、tbadge 9px 除外） | — |
| 相机取景角 | 6px 单角 | base.css:1577-1604 |

嵌套规则（better-ui）：外半径 = 内半径 + 内边距。现状唯一嵌套面是 `.recent .rc`（外 12 + 内 padding 12/14，内部无卡片）与 gcard（行内无嵌套圆角），均合规；新增嵌套面按此式计算。列表**不套卡片**：行间发丝线、组间留白（定稿 §1.6）。

---

## 3. 间距体系与栅格

token（tokens.css:64-72）：`--sp-1…9 = 4/8/12/16/20/28/36/48/64px`。

| 项 | 精确值 | 实现 |
|---|---|---|
| 屏幕左右边距 | 20px（阅读正文 24px） | `.pane`:71、`.pbody`:504、ReaderScreen.tsx:328 内联 24 |
| push 底部留白 | 40px（阅读 140px 给播放条让位） | base.css:504、ReaderScreen.tsx:328 |
| 区块间距 | 16–18px（`.sec` 16、`.group` 18）——定稿 §1.5 认可的压缩值 | base.css:755-756、319-321 |
| overline ↔ 内容 | 6–8px（`.group-t` padding-bottom 6） | base.css:322-324 |
| 列表行高 | ≥52px（`.row`/`.frow` min-height 52）；练页行随内容 ≈76（`.prow` padding 16×2+44 图标）；swipe 行含副文字 ≈72 | `.row`:301、`.frow`:335、`.prow`:929 |
| 行内 gap | 行 12px（`.row`/`.frow`）、练行 14px（`.prow`/`.scene-row`）、按钮组 8–10px | — |
| 按钮高度 | 主/次按钮 48px；行按钮 44px（`.tb`:1517、`.da`:2377）；分段 36px；横幅钮 34px（热区不足，见 P-05） | — |
| 触控热区 | ≥44×44（图标视觉 28、热区 44，候选 A §2.6）；分段控件 36px 高为**已批准例外**（iOS 惯例，且纵向有行距缓冲），不再下调 | — |
| 安全区 | `env(safe-area-inset-bottom)`；tab bar 内容高 49 + 安全区；顶栏 `calc(env(safe-area-inset-top)+8px)` | base.css:418/476 |
| sheet | `max-height:76%`，底部 `calc(24px + safe)` | base.css:537/571 |

---

## 4. 字号 / 行高层级

### 4.1 字阶 token 表（定稿 §1.4 的 `--fs-*` 尚未落地——P-14；本表即落地目标值）

| token | 值 | 字体/字重 | 消费类（现状 → 目标） |
|---|---|---|---|
| `--fs-display` | 32/38 | serif 600 | `.h1` ✓（base.css:95-102） |
| `--fs-numeral` | 62/1.0 | serif 500 · tabular | `.hero-num` ✓（725-731） |
| `--fs-title` | 20/28 | serif 600 | `.art-title` 20/**26→28**（774-781）、`.sheet-title` 20/缺→**28**（577-582）、`.lib-hero .t` 18（保留：卡片内层级） |
| `--fs-headline` | 17/24 | sans 600 | `.frow` **16→17**（339）、`.menu-item` **16→17 + min-height 50→52**（586-588）、`.ob-opt .t` **16→17**（2202-2205）、`.btn/.btn-ghost` 17 ✓、`.pnav .ttl` 17 ✓ |
| `--fs-body` | 17/26 | sans 400 | `.input` 17 ✓（371，行高 24 为单行输入保留）、`.note-stream` **15 sans→17/26 serif**（见 §10.6 N-5） |
| `--fs-reading` | 19/34 | serif 400 | `.sent-en` ✓（1133-1138，Aa 15–24 可调）、`.rv-sent` ✓、`.diffline` ✓、`.tr-zh` 19/**32→34**（1429-1434，见 §10.4） |
| `--fs-meta` | 13/18 | sans 400 | `.meta/.meta2` ✓、`.frow .sub` ✓ |
| `--fs-overline` | 11/16 | sans 500 · ls 0.12em | `.overline` ✓（103-109） |
| `--fs-tab` | 10/12 | sans 500 | `.tab` ✓（427-428） |

衬线数字展示档（现状固化，不再新增档位）：词条/复习词头 28/36（`.dict-word`:2305、`.rv-word`:1256）· 完成摘要 34/40（`.sum-cell .n`:2137）· 清一张 30/40（`.qk-done .big`:2529）· 分数胶囊 26（`.score-pill .n`:1981）· 周况 22/25（`.w-num`:898）· 完成态 22（`.hero-done`:745）。

### 4.2 字体角色（定稿 §1.4，零 webfont）

`--font-serif`（New York/宋体）：页面大标题、文章题、数字、英文阅读正文、例句、词条、笔记正文。`--font-sans`：导航、按钮、标签、中文界面文案、设置。`--font-mono`：时间戳/耗时（`.cap-time`、`.md-preview`、`.rv-pho`、score 场景）。两者不混用——衬线是「读物」，黑体是「工具」。

### 4.3 排印细节（apple-design §15 落值）

- 追随字距分级：`.hero-num` 62px → `-0.01em` ✓；`.h1` 32px → `0.01em`（宋体大字紧凑度弱于拉丁，保留现状实测值）；正文/meta 一律 0；`.overline` `0.12em`、`.pin` `0.1em`、`.src-badge` `0.08em` 小字放大字距 ✓。
- 行高随字号反向：大字 1.0–1.19（38/32、26/20 修正后），正文 1.35–1.79（34/19 阅读、26/17）。
- 输入 ≥17px 铁律：全部 input/textarea/select（防 iOS 聚焦自动放大）；当前 6 处违规见 P-02（platform 线处理）。
- 数字一律 `tabular-nums`（`.num` 工具类，base.css:123-125）。

---

## 5. 发丝线用法

- 一切分隔 = `1px solid var(--hairline)`（浅 `#E7E2D6`/深 `#35312A`）；**禁 0.5px 缩放 hack**（定稿 §1.6，暖纸上 1px 不扎眼）。
- 行分隔：`.row/.frow/.prow/.scene-row/.swipe-row/.cap-card` 的 `border-bottom`，且 `:last-child` 去线（base.css:308-310 等）；块分隔：`.hr`（1px 线，base.css:129-133）。
- 外部边/需要从纸面抬起的边界 = `--hairline-strong`：gcard、输入框描边、次按钮、chip、grade、aa-steps、share 卡头。
- 交互结构线（非深度线）保留 border；**深度感交给阴影与材质，不用 border 造立体**（better-ui）。
- 特例宽度：`.blank` 虚线 2px（完形槽位，语义强调）、`.ob-check` 1.5px、`.holdbtn.rec` 1.5px（录音态描边，状态信号）。层级线一律 1px。

---

## 6. 阴影与层次（材质）

三层模型（候选 A §1：纸即是界面——层级靠留白与发丝线，浮层才用阴影）：

| 层 | 表面 | 规格 |
|---|---|---|
| L0 纸面 | `--bg` | 无阴影、无卡片；列表不套卡 |
| L1 抬升件 | 输入框 `--surface-2` 底、gcard `--surface`+hairline 边 | 无阴影 |
| L2 浮层 | sheet `--shadow-sheet`；菜单/toast/分享卡/横幅/cap-fab `--shadow-pop` | 全 app 仅两档 shadow token |

微阴影（仅两处，机械件的高光，不算档位）：分段选中钮 `0 1px 3px rgba(32,29,24,.1)`（base.css:224）、开关旋钮 `0 1px 3px rgba(32,29,24,.25)`（base.css:244）。深色主题 shadow 换 `rgba(0,0,0,.5/.55)`（tokens.css:53-54）。

毛玻璃（apple-design §12 材质三处 + 兜底）：tab bar / 阅读播放条 / 翻译底栏 = `--tb-bg` + `-webkit-backdrop-filter: saturate(1.4) blur(18px)`（base.css:413-415/1187-1189/1509-1511）；`backdrop-filter` 不可用时 `--tb-bg` 0.86 实底兜底 ✓。**不叠轻透明面于轻透明面上**：sheet 本体是不透明 `--surface`，只有 scrim 在其下。相机深腔、黑 toast 同理不透明。

---

## 7. 图标规格与状态

- 本体：单色描边 SVG，`viewBox 0 0 24 24`、`stroke-width 1.6`、圆头圆角、`fill:none`（play/prev/next/stop/dots/today 圆点等实心件显式 `fill:currentColor` + `stroke:none`）、颜色一律 `currentColor`、`aria-hidden="true"`（icons.tsx:50-64 ✓ 全合规，无硬编码色）。
- 尺寸档（实测固化）：tab 25；push 顶栏/iconbtn 内 18–20；菜单行 17；行内/chip 内 12–16；横幅底座 16。新增图标先入 `icons.tsx` 的 24 枚表，禁 emoji 与裸字符（V6）。
- 描边 vs 字重：1.6px 描边匹配正文 400–600 均可读；≥17px bold 按钮旁维持 1.6，不随字重加粗（与 better-ui 默认不同，此为项目 24 枚小集的统一惯例，优先）。
- 颜色状态：默认 `--ink`（iconbtn/p-item/prow ic）；次级 `--ink-2`（menu-item）、`--ink-3`（search 放大镜）；激活 `--ink`（tab.on）；彩色仅 `--accent`（bico 底 `--accent-soft`+`--accent`、tbadge）。

---

## 8. 控件状态矩阵（默认 / 按下 / 禁用）

定稿 §1.8 按压两式：**实底件 = 背景→`--surface-2`**；**文字件 = opacity 0.78**；均 100ms、**不做 scale**（防布局抖动——对 better-ui「press 0.96」规则的项目级豁免，apple-design §1 的 pointer-down 即时反馈语义不变：CSS `:active` 在按下即触发）。

| 控件 | 默认 | 按下 `:active` | 禁用 `:disabled` |
|---|---|---|---|
| `.btn` 主钮 | `--ink` 底 + `--on-ink` 字，48px，r-m | opacity .78 | opacity .35 + `cursor:default`（base.css:1495-1500） |
| `.btn-ghost` 次钮 | 无底 + 1px `--hairline-strong` | opacity **0.78**（现状 0.6，见 N-2） | 同上 |
| `.tlink` 文字链 | `--accent` 500 | opacity 0.78；**热区需补 ≥44（P-01，a11y 线）** | — |
| `.iconbtn` | 透明底 44×44 + `--ink` 图标 | 背景→`--surface-2` | — |
| `.row/.frow` 行 | 透明底 | 背景→`--surface-2`（`.row` 现缺失，见 N-1） | — |
| `.chip` | 1px strong 边胶囊 | 背景→`--surface-2` | opacity .35 |
| `.grade` 评分钮 | `--surface`+strong 边，≥58px | 背景→`--surface-2`；建议态 `--accent` 边+`--accent-soft` 底（QuickReview.tsx:249） | — |
| `.tab` | `--ink-3` 图标+字 | **缺失 → opacity .78 或色→`--ink`**（N-1） | — |
| `.seg button` | 轨道 `--surface-2` 上 13px `--ink-2` | **缺失 → 背景→`--surface`**（N-1）；选中 = `--surface` 底+微阴影+hairline 边+`--ink` | — |
| `.switch` | 轨 `--hairline-strong`，on = `--accent` | **缺失 → opacity .78**（N-1）；热区补 44（N-6） | — |
| `.bbtn` 横幅钮 | `--ink` 底胶囊 34px | **缺失 → opacity .78**（N-1） | — |
| 禁用通用 | — | 禁用件**永不**有按压反馈（`:disabled` 不触发 `:active`，勿用 opacity 表达「按不动的灰」以外语义） | opacity 0.35 |

焦点可见性：`:focus-visible` = 2px `--accent` outline + 1px offset（base.css:50-55），仅覆盖原生控件；可点 span 修复后自动纳入（P-01）。

---

## 9. 动效与缓动

| 场景 | 时长/曲线 | 实现位置 |
|---|---|---|
| push/pop | 320ms `cubic-bezier(0.32,0.72,0,1)`（`--ease`） | `.push`:464 |
| sheet 上滑/下滑 | 280ms `--ease` + dim 280ms；visibility 延迟只在关闭向 | `.sheet`:546/553、`.sheet-dim`:522 |
| tab 切换 | 160ms ease-out 淡入 + 4px 上移（`tabin`） | base.css:81-92 |
| 按压 | 100ms（opacity 或背景，见 §8；不做 scale） | 各 `:active` |
| 判分翻面/卡片入场 | 240ms `--ease`（`cardin`） | base.css:1244-1255 |
| 横幅弹入/收起 | 400ms `--ease` | `.banner`:613 |
| 进度墨线 | `.meter` 320ms `--ease`、`.rd-prog` 200ms（建议统一 `--ease`） | base.css:800/1115 |
| 开关 | 背景 160ms、旋钮 transform 160ms `--ease` | base.css:233/245 |
| 骨架呼吸 | 1.2s ease-in-out infinite（opacity 0.55↔1） | base.css:1211-1221 |
| toast | opacity 200ms + transform 200ms `--ease` | base.css:671 |
| sheet 下拉关闭 | 跟手 1:1（无 transition），>120px 释放关闭；**>0.4px/ms 速度分支缺失（P-15，motion 线）** | sheets.tsx:71-100 |

曲线纪律：位移/尺寸/跟手一律 `--ease`；透明度 150–200ms `ease-out` 或 `--ease`；高频交互（打字、行按压、tab 切换）不加表达性动画（better-ui）。`prefers-reduced-motion: reduce` 全局 `transition/animation: none !important`（base.css:2542-2549）——横幅/sheet 关闭为瞬时切换，保留静态结果，合格。主题切换的 transition 抑制见 §10.6 N-3。

apple-design 对齐注记：push 进入/退出同路径（translateX 右侧进出 ✓ 空间一致 §7）；sheet 跟手 1:1 + 打开时清残留 inline 样式（sheets.tsx:66-70 ✓ 可中断性 §3）；边界用 `overscroll-behavior` 拒绝而非硬弹（§9 rubber-band 的 Web 等价物，缺口见 N-4）。

---

## 10. 实施计划（style 域 P0/P1 + 本次读码新发现）

> 每项自包含：改哪个文件哪几行、改成什么、如何验收。P-01/02/05/06/07/11/12/13/15/20/21 分属 a11y/platform/motion 线，不在本计划展开，仅在交叉处注明引用。

### 10.1 P-03（high）阅读器中文模式正文 14px、Aa 字号档失效

- **改**：
  1. `immersive-translator-mobile/src/screens/ReaderScreen.tsx:346`——删除 `sent-zh` span 的 `style={{ fontSize: 14 }}`。
  2. `immersive-translator-mobile/src/screens/ReaderScreen.tsx:327-328`——正文容器 div 的 inline style 增加一个 CSS 变量：`style={{ "--rd-fs": `${prefs.fs}px`, paddingLeft: 24, paddingRight: 24, paddingBottom: 140 }}`（TS 类型用 `as React.CSSProperties`）。
  3. `immersive-translator-mobile/src/ui/base.css:1142-1148`——`.sent-zh` 改为：
     ```css
     .sent-zh {
       font-size: max(17px, calc(var(--rd-fs, 19px) * 0.85));
       line-height: 1.5;
       color: var(--ink-3);
       margin-top: 2px;
       transition: filter 200ms, opacity 200ms;
     }
     ```
     （删原 14px/22px 两行；`max()`/`calc()` iOS 16 支持，非 color-mix 类禁用项。）
- **验收**：Aa 面板三种显示模式（对照/英文/中文）下点「增大/减小」——中文行字号同步变化且恒 ≥17px；默认 19px 档时中文行 = 17px、24 档 = 20px；与 sheets.tsx:416「字号与主题只影响阅读正文」自述一致；遮罩 blur 不受影响；`jsdom smoke.mjs` 全绿。

### 10.2 P-04（medium）rd-black 作用域越出正文区 + 漏 `--accent`

- **改**：
  1. `immersive-translator-mobile/src/App.tsx:356`——push 根 className 表达式删去 ` ${e.name === "reader" && rdBlack ? "rd-black" : ""}`（`rdBlack` 变量与注释一并清理，App.tsx:58）。
  2. `immersive-translator-mobile/src/screens/ReaderScreen.tsx:327`——正文容器 className 改为 `` `pbody rd-body ${prefs.topic === "black" ? "rd-black" : ""} ${prefs.mask ? "reader-mask" : ""}` ``；并在 `.rd-body` 规则（base.css:1117-1119）补 `background: var(--bg);`，使纯黑底铺满正文滚动区（原由 push 根提供的底色）。
  3. `immersive-translator-mobile/src/ui/tokens.css:81-92`——`.rd-black` 块按 §1.3 表补 `--accent: #8fb3d4;` 与防御项 `--on-ink: #0a0a0b;` 及 `--ok/--warn/--err` 三值（`= 深色主题取值`）。
- **验收**：阅读主题切「纯黑」——顶栏 `.pnav`、2px 进度线 `.rd-prog`、播放条 `.rd-playbar` 保持全局纸/炭主题（定稿 §1.2「只影响正文区」）；正文区全黑；浅色全局 + 纯黑正文组合下「翻译这句 / 重试」链接与词块点状下划线取 `#8FB3D4`（对 `#000` ≈9.6:1 ≥4.5）；词典卡（sheet 挂全局层）配色不受影响。

### 10.3 P-08（medium）连播当前句 accent-soft 整句底色 → 页边 2px 墨线

- **改**：`immersive-translator-mobile/src/ui/base.css:1125-1132`——
  ```css
  .sent {
    cursor: pointer;
    position: relative;
  }
  .sent.playing::before {
    content: "";
    position: absolute;
    left: -24px;
    top: 2px;
    bottom: 2px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  ```
  （删 `.sent` 的 `border-radius: 4px` 与 `transition: background 200ms`、删 `.sent.playing { background: var(--accent-soft) }`。`left:-24px` 对应 ReaderScreen.tsx:328 的正文 24px 边距，墨线落在页边距内。）
- **验收**：连播时当前句无底色，仅页边距一根 2px 墨蓝竖线（候选 A §4.6/定稿 V5 对策）；与已收藏词 `tok.known` 同句出现时整行只有一种标注；纯黑主题下墨线随 §1.3 的 `--accent` 变亮色可见；`sent-zh` 多行句墨线纵贯整句块。

### 10.4 P-09（medium）翻译结果页字规偏离契约

- **改**：
  1. `immersive-translator-mobile/src/ui/base.css:1422-1428`——`.tr-src` 加 `font-family: var(--font-serif);`，`font-size: 15px→17px`、`line-height: 23px→25px`（docs/mobile-v3-candidate-a.md:300「原文区（衬线 17px）」；色留 `--ink-2` 与译文形成主次）。
  2. `immersive-translator-mobile/src/ui/base.css:1429-1434`——`.tr-zh` `line-height: 32px→34px`（对齐 `--fs-reading` 19/34；同值参考 `.rv-sent`:1274、`.diffline`:1361）。
  3. `immersive-translator-mobile/src/screens/TranslateScreen.tsx:235`——fail 态删除 `style={{ fontSize: 16 }}`（保留 `--err` 状态行 :239 作失败信号，部分已流出译文维持 19px 不缩）。
  4. `immersive-translator-mobile/src/screens/TranslateScreen.tsx:254` 与 `:267`——unconfigured 态删 `fontSize: 16`、`color: var(--ink-4)` 改 `var(--ink-3)`（与 P-06 同点双修：ink-4 不入正文）。
- **验收**：done 态原文 17px 衬线，与点按编辑后的 textarea（`.input` 17px）视觉同级；streaming 中点「停止并保留已译」前后译文字号不变（19px）；未配置态引导句两主题对比度 ≥4.5:1。

### 10.5 P-10（medium）快速复习完成态文案自相矛盾

- **改**：`immersive-translator-mobile/src/screens/QuickReview.tsx:92-94`——sub 行按剩余数分叉：
  ```tsx
  <div className="sub">
    {st.due === 0 ? "今天的到期都清完了 · 明天见" : `还剩 ${st.due} 张 · 都在今晚的提醒里`}
  </div>
  ```
  （`st` 来自 `useApp(reviewStats)`，评分经 `gradeVocab` 推移 dueAt 后 `reviewStats` 重算，第 93 行读到的已是新值；与 :54-57 入口空态「已清完，明天见」口径一致，符合定稿 §3.14。）
- **验收**：仅 1 张到期时清完 → 「已清 1 张 / 今天的到期都清完了 · 明天见」；≥2 张时清完第一张 → 「还剩 N-1 张 · 都在今晚的提醒里」；`grep -n "还剩" src/screens/QuickReview.tsx` 仅一处且在分支内。

### 10.6 本次读码新发现（N-1…N-6）

**N-1（medium·motion）可点元素按压态成片缺失**。定稿 §1.8/候选 A §2.9「全局 ：active 覆盖所有可点元素」+ §8 验收「每个可点元素有按压态」，但以下控件无任何 `:active` 规则：`.tab`（base.css:420-439）、`.seg button`（:210-220）、`.switch`（:227-252）、`.banner .bbtn`（:628-641）、`.row`（:297-310）、`.ob-opt`（:2185-2197）、`.import-tabs button`（:2444-2451）、`.swipe-act`（:1032-1045）。tab bar 是全 app 最高频控件，按下零反馈违反 apple-design §1「Respond on pointer-down」。
- **改**：在 base.css 对应规则后补——`.tab:active { opacity: .78; }`；`.seg button:active { background: var(--surface); }`；`.switch:active { opacity: .78; }`；`.banner .bbtn:active { opacity: .78; }`；`.row:active { background: var(--surface-2); }`；`.ob-opt:active { background: var(--surface-2); }`；`.import-tabs button:active { opacity: .78; }`；`.swipe-act:active { background: var(--err-soft); filter: brightness(.96); }`。另在 `src/main.tsx` 挂一次空触摸监听以保证 WKWebView `:active` 生效：`document.addEventListener("touchstart", () => {}, { passive: true });`（WebKit 只在有 touch 监听时激活 `:active`，现 document 上仅 pointerdown 监听，App.tsx:224）。
- **验收**：真机/模拟器逐个按下上述控件均有 <100ms 即时反馈；§8 状态矩阵表逐行核对通过。

**N-2（low·motion）按压反馈数值漂移：五种 opacity 并存**。定稿 §1.8 明文按压 = opacity .78（或背景→surface-2），实测散布 0.6（`.btn-ghost:active`:177-179）、0.7（`.tlink`:185-187、`.menu-item`:593-595、`.art-title`:782-784、`.quote`:817-819、`.cliptwo`:849-851、`.p-item`:873-875）、0.75（`.prow`:935-937、`.scene-row`:1723-1725）、0.78（`.press`:134-136、`.btn`:160-162）、0.85（`.cap-fab`:2106-2108、`.lib-hero`:2466-2468），另有 `.src-card:active` 用 `--hairline` 底而非 `--surface-2`（:2349-2351）。better-ui：同一细节两种做法即 finding。
- **改**：全部收敛到两式——文字/ghost 类统一 `opacity: .78`（0.6/0.7/0.75/0.85 九处各改一行）；`.src-card:active` 改 `background: var(--surface-2)`。
- **验收**：`grep -n ":active" src/ui/base.css` 输出中 opacity 值仅 0.78、背景值仅 `--surface-2`（swipe-act 的 err-soft 见 N-1 例外）、禁用 0.35。

**N-3（low·motion）主题切换无 transition 抑制，换肤瞬间全屏颜色拖影**。外观页切浅↔深（store.ts:507-517 → `applyThemeDom` store.ts:466 直改 `data-theme`），而 base.css 有成片颜色 transition（`.switch` .16s、`.tab` color .16s、`.sent` 200ms、`.input` border .12s、`.sheet-dim` 280ms 等），切主题时逐元素各自渐变，整屏「糊变」约 300ms（better-ui checklist：color transitions + theme toggle 需抑制）。
- **改**：base.css 末尾（reduced-motion 块前）加：
  ```css
  html.theme-switch *,
  html.theme-switch *::before,
  html.theme-switch *::after { transition: none !important; }
  ```
  store.ts `applyThemeDom`（:466 附近）写完 `dataset.theme` 后加 `document.documentElement.classList.add("theme-switch")`，`requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("theme-switch")))`。
- **验收**：外观页来回切换，颜色一帧内整体翻转、无任何元素滞后渐变；普通交互（按压、开关、push）动画不受影响；深→浅无白闪帧（配合 P-13 首帧脚本后冷启动同样无闪）。

**N-4（medium·motion）六个嵌套滚动容器缺 `overscroll-behavior: contain`**。候选 A §7/定稿 §6.1 明文「滚动容器 `overscroll-behavior: contain`」；`.pane`（base.css:70）与 `.pbody`（:503）已合规，但 `.sheet-body`（:569-576）、`.chat-body`（:1747-1756）、`.rv-stage`（:1235-1242）、`.qk-stage`（:2518-2525）、`.sh-stage`（:1931-1939）、`.ob-stage`（:2178-2184）滚到边界会把剩余手势链给底层——sheet 内滚动触底继续拖会带动整页橡皮筋/底层滚动，破 sheet 的模态感。
- **改**：六条规则各加一行 `overscroll-behavior: contain;`。
- **验收**：词典卡/Aa/导入 sheet 内滚到顶/底继续拖，背景页面纹丝不动；聊天流、复习卡、清一张、跟读舞台同理；iOS 16 WKWebView 实机验证。

**N-5（medium·style）`.note-stream` 15px 无衬线，违反「衬线一页纸」与正文 ≥17px**。候选 A §4.15/定稿 §3.15 规定笔记流式预览为「衬线一页纸」；实现 base.css:2154-2163 为 15px sans（未设 font-family），消费者为笔记生成/详情的正文本体（NotesScreens.tsx:257/263/344），属阅读性长文而非 meta。
- **改**：base.css:2154-2163 加 `font-family: var(--font-serif);`、`font-size: 15px→17px`、`line-height: 25px→26px`（`--fs-body` 17/26）。
- **验收**：笔记生成流式预览与笔记详情正文为衬线 17/26；smoke 通过；笔记库列表行（非正文）字号不受影响。

**N-6（low·a11y）`.switch` 热区 50×30 < 44**。P-05 清单（横幅/Aa/先清一张/笔记库）未含开关：`.switch`（base.css:227-235）按钮本体 50×30，低于定稿 §1.5 触控热区。
- **改**：base.css `.switch` 规则加 `::before` 透明扩区（不占布局）：
  ```css
  .switch::before { content: ""; position: absolute; inset: -7px; }
  ```
  → 命中区 64×44，视觉不变。
- **验收**：开关上下左右 7px 内点按均切换；设置五屏行布局无位移（absolute 伪元素不参与布局）；与 N-1 的 `:active` 叠加验证。

### 10.7 P2 收尾批次（style 域 low，一行式，供顺手批次执行）

| 项 | 改法 |
|---|---|
| P-14 | 按本文 §4.1 表在 tokens.css:58-77 落 `--fs-*` 九枚并改消费类（`.frow` 17、`.menu-item` 17/52、`.art-title` 20/28、`.sheet-title` 行高 28） |
| P-16 | PracticeScreen.tsx:106 脚注改白话（对齐 prototypes/mobile-v3-2026-09-24.html:1298），去「ISE」「（不假打分）」 |
| P-17 | App.tsx:32/314-315 的 SpikeScreen import 与 case 同 `import.meta.env.DEV` 门控（或删除） |
| P-18 | SettingsScreens.tsx:185、:465-466 失败态 `statusdot warn`→`statusdot err`（ok/未配置/失败三态可分） |
| P-19 | SettingsScreens.tsx:87、:559 选中对勾加 `style={{ color: "var(--accent)" }}`（`.frow .ico` 默认 `--ink`，base.css:354-356） |

---

## 11. 验收清单（本规范口径）

- [ ] 色：两主题 + 纯黑阅读主题下正文/辅助文字 ≥4.5:1；`--ink-4` 仅禁用装饰与真占位；同屏彩色 ≤2、墨蓝只在四处清单
- [ ] 形：圆角只出现 §2 表列值；发丝线全 1px、无 0.5px hack；阴影仅 sheet/pop 两档 + 两处微阴影
- [ ] 字：字阶按 §4.1 校准后，正文/输入 ≥17px 横切全屏（含 P-02 六处、P-03 中文行、N-5 笔记）；衬线/黑体不混用
- [ ] 态：§8 状态矩阵逐行有默认/按下（可选禁用）三态，按压两式取值收敛（N-2），tab/分段/开关/横幅钮可感按压（N-1）
- [ ] 动：§9 表时长/曲线逐项吻合；换肤无拖影（N-3）；嵌套滚动不穿透（N-4）；`prefers-reduced-motion` 全局降级
- [ ] 回归：每次改样式后跑 `jsdom smoke.mjs` 全绿、控制台零报错；本文件 §10 各项验收句逐条通过
