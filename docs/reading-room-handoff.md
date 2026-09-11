# 沉浸阅读室 —— 开发交接说明（给开发 AI 的 brief）

> 本文是唯一事实来源。设计稿在 Ardot 画布：`https://ardot.tencent.com/file/724406355129952`
> 代码仓库：`immersive-translator`（macOS Swift / Windows Tauri + React + TS）
> 本轮交付物：**交互原型**（`prototypes/reading-room.html`）+ **5 屏改造设计稿**（画布）。

---

## 0. 你的任务

把「沉浸阅读室」从原型落成两端可用的正式功能。

**先做 Windows 端**（Tauri + React + TS），macOS 端按同一份规格跟进，两端共享 `contracts/` 里的数据契约。

不要重新设计视觉。设计稿已经定稿，按本文的令牌与规格 1:1 实现。

---

## 1. 产品定位（先读这段，它决定所有取舍）

ImmersiveTranslator 现有的两个能力都是**瞬时工具**：划词翻译、截图 OCR。用一次 5–30 秒，用完即走，浮窗不打断用户当前的阅读流。

沉浸阅读室是一个**长时间驻留的第二空间**：用户把自己的文章搬进来，逐句跟读、查词、自测、复习生词，一次 10–30 分钟。

**结论：阅读室是现有工具的「延伸」，不是「主入口」。**
不要把它做成 App 的主界面，不要为它改现有浮窗的交互模型。它是用户「从浮窗里升级过去」的地方。

这条决定了：
- 现有划词浮窗的核心体验（快、轻、不打断）保持不变
- 阅读室是**独立窗口**，不是第二个 Dock 图标 / 第二份安装
- 两者之间用「发送到阅读室」这条通道连接（见 §8）

---

## 2. 设计稿导航

画布 5 屏 1440×900，横排：

| 屏 | 名称 | 节点 ID | 说明 |
|---|---|---|---|
| A | 阅读主界面 | `3:1` | 句对主从版式、书架、播放条 |
| B | 阅读设置面板 | `3:143` | 右侧 380px 抽屉，统一归口所有开关 |
| C | 词典查词 | `3:285` | 正文列 + 右侧 380px 固定词典栏 |
| D | 生词本复习流 | `3:546` | SRS 卡片 + 四档评分 |
| E | 译文遮罩 | `3:654` | 自测模式 + 视图菜单展开态 |

> ⚠️ 屏 E 的顶栏在预览渲染里显示成了屏 D 的文案，**这是预览服务的渲染残留，不是设计意图**。屏 E 顶栏的正确内容与屏 A 一致（「沉浸阅读室」+ 文章名）。实现时以屏 A 的顶栏为准。

**修改画布前必读**：不要对已完成的屏再做 `Copy` 操作，尤其是带 `descendants` 参数的复制（见仓库外的工具坑记录）。

---

## 3. 设计令牌（直接搬进 `src/styles.css`）

沿用现有产品的令牌体系，新增了阅读专属的排版变量。

```css
:root {
  /* 品牌色 */
  --accent:        #4c5ff0;
  --accent-hover:  #3f52e0;
  --accent-soft:   #eef0fe;   /* 标签底 / 当前句底 */
  --accent-softer: #f6f7ff;   /* 卡片底 */
  --accent-hl:     #dde2fd;   /* 高亮描边 / 遮罩块（朗读中） */

  /* 表面 */
  --bg:            #f4f5f9;
  --surface:       #ffffff;
  --surface-2:     #f9fafc;
  --border:        #e4e7ee;
  --border-strong: #d6dae4;

  /* 文字 */
  --text-1: #1c2029;   /* 原文 / 标题 */
  --text-2: #4b5261;   /* 次级正文 / 已揭开的译文 */
  --text-3: #7c8494;   /* 常态译文 / 说明文字 */
  --text-4: #a6adbb;   /* 占位 / 遮罩块提示 */

  /* 圆角 */
  --radius-sm: 6px;  --radius-md: 8px;  --radius-lg: 12px;  --radius-xl: 16px;

  /* 阴影 */
  --shadow-card:  0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
  --shadow-float: 0 6px 16px rgba(16,24,40,.08), 0 2px 6px rgba(16,24,40,.06);
  --shadow-pop:   0 12px 32px rgba(16,24,40,.16), 0 3px 10px rgba(16,24,40,.1);

  /* 阅读专属 */
  --read-en-size: 19px;
  --read-en-lh:   32px;
  --read-cn-size: 15px;
  --read-cn-lh:   26px;
  --read-col:     640px;   /* 正文列固定宽，居中 */
}

[data-theme="dark"] {
  --accent: #7d8cff;  --accent-hover: #93a0ff;
  --accent-soft: rgba(125,140,255,.16);  --accent-softer: rgba(125,140,255,.09);
  --accent-hl:   rgba(125,140,255,.30);
  --bg: #1d1f26;  --surface: #262933;  --surface-2: #2e313c;
  --border: #373b47;  --border-strong: #474c5a;
  --text-1: #edeef4;  --text-2: #c4c9d6;  --text-3: #9399ab;
  --text-4: #6f7688;
  --mask-block: #333744;   /* 深色下遮罩块的底色 */
}
```

新增主题（屏 B 的主题色板）：**护眼** `#f5efdf` 底、**纯黑（OLED）** `#0a0a0b` 底。

---

## 4. 字体与排版（本轮最关键的一处修正）

原型里中英同为 17px，导致**中文视觉重量压过英文约 1.2 倍**，译文比原文还抢眼。设计稿的解法是字体配对 + 字号拉开层级：

| 用途 | 字体 | 字号 / 行高 | 颜色 |
|---|---|---|---|
| 英文原文 | Source Serif 4 Regular | 19 / 32 | `--text-1` |
| 中文译文（常态） | 思源宋体 Regular | 15 / 26 | `--text-3` |
| 中文译文（已揭开） | 思源宋体 Regular | 15 / 26 | `--text-2` |
| 文章标题（EN） | Source Serif 4 SemiBold | 30 / 38 | `--text-1` |
| 文章副标题（CN） | 思源宋体 Regular | 17 / AUTO | `--text-2` |
| UI 中文 | Noto Sans SC | — | — |
| UI 拉丁 / 数字 | Inter | — | — |

Web 字体加载（都是 Google Fonts，可自托管）：
- `Source Serif 4` → `Source+Serif+4:wght@400;600`
- `思源宋体` → `Noto+Serif+SC:wght@400`
- `Noto Sans SC` → `Noto+Sans+SC:wght@400;500`
- `Inter` → `Inter:wght@400;500;600`

**硬规则**
- 正文列固定 `640px` 居中，不要撑满。英文行长控制在 ~70 字符。
- 中文句子之间**不要用空格连接**（原型 `join(" ")` 是错的，中文排版忌讳）、
- 正文不设最大宽度以外的容器；左右留白是设计的一部分（"一条竖线"）。

---

## 5. 核心版式：句对主从（取代双栏段落对照）

原型用「左右等宽双栏、段落对段落」。问题是：**段落起点是对齐的，但段落内部的句子横向错位不可控**——第 4 段英文 5 行、中文 3 行时，第 4 句在英文落在第 4–5 行、在中文落在第 3 行。加上 490px 的水平跨度，用户每跟读一句都要做一次二维搜索。

改成**句对**：一句原文，紧随其下一句译文，作为一个不可分割的单元。

```html
<div class="pair" data-idx="11">
  <p class="pair-en">Speed was the goal, and comprehension was the test.</p>
  <p class="pair-cn">速度是目标，理解力是考卷。</p>
</div>
```

```css
.pair       { padding: 10px 12px 10px 18px; display: flex; flex-direction: column; gap: 6px; }
.pair-en    { font: 400 var(--read-en-size)/var(--read-en-lh) "Source Serif 4", serif; color: var(--text-1); }
.pair-cn    { font: 400 var(--read-cn-size)/var(--read-cn-lh) "Noto Serif SC", serif; color: var(--text-3); }

/* 当前朗读句 */
.pair.is-active            { background: var(--accent-soft); border-radius: 10px; padding-left: 0; }
.pair.is-active::before    { content: ""; width: 3px; height: 64px; background: var(--accent);
                             border-radius: 2px; margin-right: 15px; }  /* 用 flex 实现，见设计稿 */
.pair.is-active .pair-cn   { color: var(--text-2); }
```

**取消原型的「已读句灰化」**（`.sent.done` → `--text-4`）。朗读暂停后整页上半部掉对比度，破坏"可反复阅读"的感觉。只用当前句高亮指引方向。

**保留双栏对照**作为可选模式（设置面板的「对照模式」= 仅英文 / 对照 / 仅中文），但它不再是默认。

---

## 6. 逐屏规格

### 屏 A · 阅读主界面

```
[顶栏 56px]  Logo · 沉浸阅读室 | 文章名 .........  搜索 · 主题 · 帮助
[左栏 240px]  书架(4 篇带进度) ── 生词本入口 ── 今日复习卡
[阅读区]      阅读进度线(2px)
              文章头：英文标题 30px / 中文副标题 / [B1 入门] 元信息行
              句对列表（640px 居中）
[播放条 72px] 上一句 · 播放 · 下一句 | 进度条 + 第 N/M 句 | 1.0× · 视图 · 设置
```

- 顶部进度线按**真实阅读进度**渲染（原型写死 620px，语义错误）
- 元信息行包含「上次读到第 N 句」——断点续读的入口
- 播放条**只放播放相关**；「对照模式 / 译文遮罩 / 进度显示 / 禅模式」全部移到顶栏入口的**视图菜单**（见 §7）

### 屏 B · 阅读设置抽屉

右侧 380px、全高、`--shadow-pop`，背后 32% 黑遮罩。**分三组，所有开关统一归口：**

- **版式**：对照模式（分段控件）/ 正文字号（步进器 14–24）/ 行距（滑杆）/ 正文字体（下拉）
- **朗读**：音色 / 语速（0.5–2.0，刻度 0.05）/ **每句停顿**（0–2s）/ 跟读模式（开关）
- **主题**：浅色 / 深色 / 护眼 / 纯黑
- 底部：恢复默认 · 完成

> **职责划分（重要）**：视图菜单管「显示什么」（瞬时开关），设置面板管「怎么显示」（持久参数）。所以遮罩开关在视图菜单、不在设置面板。所有设置**按文章记忆**，并全局记忆一份默认值。

### 屏 C · 词典查词

正文列 640 + 间距 36 + **右侧 380px 固定词典栏**。查词时正文列左移、重新居中，**词典栏永不遮挡正文**。

栏目内容（自上而下）：词条 26px serif + 音标 + 发音按钮 / 词性标签 + 释义 / **原句卡**（含「第 N 句」定位）/ **常用搭配 3 条** / 词形变化 / 加入生词本 + 复制。

**这一屏要解决的三个原型缺陷**
1. 原型的弹卡是浮动的，**正压在它所属的那句话上**，且卡里又重复一遍"所在句"——纯冗余。改成固定栏。
2. 原型只支持点单个词，介词/缩写会弹"未收录"。**必须支持划选短语查询**（`settle in`、`take on momentum`），这是真实卡壳的 80%。
3. 原型的弹卡只在打开时算一次坐标，**滚动后不跟随也不关闭**。固定栏天然没有这个问题。

### 屏 D · 生词本复习流

左栏 260px（今日进度 5/12 · 连续打卡 · 掌握度分布）+ 中间 SRS 卡片 640px。

卡片：来源文章 + 进度 / 词条 34px + 音标 + 发音 / 释义 / 原句卡 / **四档评分带下次间隔**（忘记 10 分钟 · 困难 1 天 · 一般 3 天 · 简单 7 天）/ 底部快捷键提示。

**原型的口径错误必须修掉**：原型里每条词条标注 `next: "明天 · 第 1 次"`，但底部计数写「今日 N 词」用的是 `vocab.length`（全站总数）。**到期判定与计数必须来自同一份 SRS 状态。**

### 屏 E · 译文遮罩（自测模式）

**这是原型里 bug 最集中的一个功能。**

- 遮罩单元 = 句对里的**中文那一行**，做成 `--mask-block` 纯色块（26px 高、圆角 5），块内「闭眼图标 + 点按查看译文」
- **不要用 `blur()`**。原型用 `blur(5.5px)` 在深色下糊成一整条灰噪点带，看着像渲染坏了。纯色块明确得多。
- 顶部状态条：眼睛图标 +「译文遮罩 · 自测模式」+「N / M 已揭开」+「全部揭开」+ 说明行
- 交互：点单块揭开该句（图标切成实心眼，译文用 `--text-2`）；按住 `H` 临时显示全部，松开恢复；`全部揭开` 按钮重置
- **修复 §9 的第 4 条冲突**：遮罩开启时朗读**只高亮英文**，中文遮罩保持不动。原型的 `.mask-on .sent.active { filter: none }` 会让中文随朗读逐句自己闪出来，自测模式直接失效。

---

## 7. 视图菜单

顶栏入口，展开态见屏 E 右下角（220×158 浮层）:

| 菜单项 | 类型 | 说明 |
|---|---|---|
| 对照模式 | 值选择 | 仅英文 / 对照 / 仅中文 |
| 译文遮罩 | 勾选 | 见屏 E |
| 显示阅读进度 | 勾选 | 顶部那条 2px 进度线 |
| 禅模式 · 隐藏侧栏与播放条 | 勾选 | 只留文字 + 当前句底部浮起的极简控制 |

---

## 8. 入口集成方案（本轮定稿）

阅读室需要**三个层次的入口**，缺一不可。

### 8.1 托盘 / 菜单栏（主入口）

`src-tauri/src/lib.rs` 的托盘菜单现在是 `[截图翻译(OCR), 翻译历史, 设置, 退出]`。改成**用分隔线分两组**：

```rust
let ocr      = MenuItem::with_id(app, "ocr", "截图翻译 (OCR)", true, None::<&str>)?;
let reader   = MenuItem::with_id(app, "reader", "沉浸阅读室", true, None::<&str>)?;
let sep      = PredefinedMenuItem::separator(app)?;
let history  = MenuItem::with_id(app, "history", "翻译历史", true, None::<&str>)?;
let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
let quit     = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&ocr, &reader, &sep, &history, &settings, &quit])?;
```

分组逻辑：**上面两个是「动作」（对你当前的内容做点什么），下面三个是「窗口/应用」（打开某个界面）**。

菜单文案用「沉浸阅读室」——「沉浸」是差异化卖点，不要简写成「阅读」或「阅读器」。

macOS 对应改 `Sources/ImmersiveTranslator/App.swift` 的菜单，插在「截图 OCR 翻译」下方。

### 8.2 翻译浮窗的「发送到阅读室」（高频入口，务必做）

这是最贴近真实使用路径的一条。用户的真实行为是：**在网页上划一段 → 浮窗弹出 → 读得不过瘾 / 想读整篇 → 送进阅读室精读**。

在 `TranslationPanel` 的图标工具栏里，加在「收藏」和「固定」之间：

```tsx
<button className="icon-btn" onClick={() => void sendToReader()} title="在阅读室精读 (Ctrl+Shift+R)">
  {/* 书 + 向右箭头 */}
</button>
```

`sendToReader()` 的判定：
- 选中的是**长文本**（> 200 字符）→ 用这段文本直接建文章
- 选中的是**短句** → 抓取当前前台窗口的正文（Readability 提取）后送过去
- 抓不到正文 → 只送选中文本，并提示「已发送所选内容」

### 8.3 全局热键

新默认热键 **`Ctrl+Shift+R`**（macOS `⌥⇧R`）= 把当前窗口正文送进阅读室并聚焦窗口。

沿用现有热键的存储方式（`app_data_dir/hotkey.txt` 的兄弟文件 `reader_hotkey.txt`），并在 `re-register` 逻辑里一起注册（注意现有的「两键相同则跳过恢复」校验要扩展到三键）。

### 8.4 明确不做

- ❌ 不新增第二个 Dock 图标 / 任务栏图标
- ❌ 不改动现有浮窗的触发与消失逻辑
- ❌ 不做浏览器扩展（本轮范围外，但接口要预留）

---

## 9. 原型里已确证的缺陷（不要照抄）

原型 `prototypes/reading-room.html` 只用于验证交互骨架。以下是**已经查证的问题**，实现时按修正后的行为来：

| # | 原型位置 | 问题 | 正确行为 |
|---|---|---|---|
| 1 | `sentDur()` | 用 `词数×350ms ÷ speed + 320ms` **估算**时长，与真实 `speechSynthesis` 完全脱钩；且变速被应用两次（`u.rate = speed×0.95` + 时长又除 `speed`） | 高亮必须由 **TTS 引擎的 word/sentence boundary 事件驱动**。`src-tauri/src/tts.rs` 已有基础，Windows 用 SAPI 的 `WordBoundary`/`SentenceBoundary` 事件（`SpeechSynthesizer` + `SpeakProgress`），macOS 用 `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString` |
| 2 | `speak()` | 无条件 `speechSynthesis.cancel()`——跟读中点单词查词会掐断整句朗读且不恢复 | 单词发音走独立音轨/独立引擎实例，不打断句子朗读 |
| 3 | `renderVocabChips()` | 到期计数 `dueN = vocab.length`（全部算今日），但每条词条写 `next: "明天 · 第 1 次"` | 计数与到期判定取自同一份 SRS 状态 |
| 4 | `.mask-on .sent.active` | 取消 blur，播放时中文逐句"闪现"，自测失效 | 遮罩模式下朗读只高亮英文（见屏 E） |
| 5 | `openPop()` | 坐标只算一次、无 scroll 监听，滚动后弹卡脱离语境且不关闭 | 改为固定词典栏（屏 C） |
| 6 | `stopPlayback()` / `finishPlayback()` | 不清滚动位置，进度条归零但视图停在文末 | 状态与视图位置保持一致 |
| 7 | 未播放时点「下一句」 | `state.idx` 直接置 0 并开始播放 | 未播放时应按"当前句 ± 1"移动光标，不自动播放 |
| 8 | `finishPlayback()` toast | 文案「本篇共查过 N 个生词」用的是全站 `vocab.length` | 改用本篇计数 |
| 9 | 中英交互不对称 | 英文词/句可点，**右侧中文既无 word span 也无事件绑定**，点了完全没反应，但两边看起来一样 | 中文句必须可点：**点中文 → 高亮并定位到对应英文句** |
| 10 | 进度条 | 只有 `click`，没有 `mousedown`+`mousemove`；21 句挤在 100px 上每句 5px，无法精确选句；无 hover 预览 | 支持拖拽 + hover 显示「第 N 句 / 该句原文预览」 |
| 11 | 键盘 | 空格直接 `preventDefault` 抢了翻页；左右箭头抢了横向滚动；无备选键 | 空格=播放/暂停仅在焦点位于阅读器内时生效；提供 `J/K/L` 备选；方向键优先翻页 |
| 12 | 空状态 | 粘贴文章后用 `zh: "…"` 占位，整页中文列全是省略号，像坏了 | 翻译未完成时中文列显示骨架屏，正文顶部给「翻译中 3/12 段」进度 |

---

## 10. 数据模型建议

```ts
/** 一篇文章 */
interface Article {
  id: string;
  title: string;            // 英文标题
  titleCn?: string;         // 中文副标题
  sourceUrl?: string;       // 来源 URL（Readability 抓取的）
  sourceType: "paste" | "url" | "epub" | "pdf";
  level?: string;           // "B1 入门"
  wordCount: number;
  createdAt: number;
  lastReadAt: number;
  progress: { sentenceIdx: number; percent: number; secondsListened: number };
  settings?: Partial<ReaderSettings>;   // 按文章覆盖
}

/** 一个句对（最小朗读/高亮/遮罩单元） */
interface SentencePair {
  idx: number;              // 全文序号，从 0
  paragraphIdx: number;
  en: string;
  zh: string | null;        // null = 尚未翻译
  zhState: "pending" | "done" | "failed" | "edited";
  revealed?: boolean;       // 遮罩模式下是否已揭开
}

/** 生词（SRS 状态，与到期计数同源） */
interface VocabWord {
  word: string;
  phonetic?: string;
  senses: { pos: string; cn: string }[];
  forms?: string[];
  collocations?: { en: string; cn: string }[];
  source: { articleId: string; sentenceIdx: number };
  srs: { ease: number; intervalDays: number; reps: number; dueAt: number; lapses: number };
  addedAt: number;
}

interface ReaderSettings {
  contrastMode: "en" | "dual" | "zh";
  maskTranslation: boolean;
  showProgress: boolean;
  zenMode: boolean;
  theme: "light" | "dark" | "sepia" | "oled";
  fontSize: number;      // 14–24
  lineHeight: number;
  fontPair: string;
  voice: string;
  rate: number;          // 0.5–2.0
  sentencePauseMs: number;   // 0–2000
  shadowingMode: boolean;
}
```

**跨平台契约**：`Article` / `VocabWord` / `ReaderSettings` 要进 `contracts/`，带 `schemaVersion`。按 `contracts/README.md` 的既有约定，主版本号不同要友好提示而不是静默失败。

---

## 11. 实现优先级

**P0 —— 不做产品不成立**
1. 翻译管线 + 段级流式渲染 + **单段重试 / 手改译文**（原型里中文列全是"…"且正文无任何翻译中提示）
2. **阅读进度持久化 + 断点续读**
3. **TTS boundary 事件驱动高亮**（§9-1）
4. 句对主从版式（§5）+ 中英对称可点（§9-9）
5. 托盘 + 浮窗「发送到阅读室」两个入口（§8.1、§8.2）

**P1 —— 决定用户留不留**
6. 划选短语/搭配查询（§6 屏 C）
7. 生词本真 SRS：到期计算、复习卡片、四档评分、复习提醒、打卡
8. 本篇生词隔离与结课报告
9. 译文遮罩自测模式（屏 E）
10. 跟读打分：读完一句停顿等你读，读对才继续

**P2 —— 打磨**
11. URL（Readability）/ ePub / PDF 导入；浏览器扩展「发送到阅读室」
12. 禅模式、荧光笔多色标注、导出 Markdown / Anki / Notion、TOC + 全文检索
13. 护眼 / 纯黑主题；行距 / 字距 / 字重全可调
14. 无障碍：单词 span 可聚焦、词典栏 `role="dialog"` + 焦点管理、朗读时 `aria-live` 播报

---

## 12. 验收标准

- [ ] 屏 A–E 五屏的视觉与设计稿一致（令牌、字体、间距、状态）
- [ ] 朗读高亮与真实语音边界同步，变速时仍同步
- [ ] 中文侧能点，且跳到对应英文句
- [ ] 遮罩模式播放时中文不闪现（§9-4）
- [ ] 生词到期计数与词条状态一致（§9-3）
- [ ] 关掉窗口再打开，回到上次读到的句子
- [ ] 中英文之间无半角空格；正文列 640px 居中
- [ ] 两端数据可通过 `contracts/` 的 schema 互通
- [ ] `npm run test`（Windows）/ swift test（Mac）全绿

---

## 13. 如何启动这轮开发（一次性交付版）

**不要**只说「按照 docs/reading-room-handoff.md 去开发」。那样说它不知道边界在哪：既不会去核实仓库现状，也不会有里程碑切分，最后给你一个无法定位问题的巨型 diff，还可能顺手把设计"优化"一遍。

把下面这段整块发给它：

---

> 你是这个仓库（`D:\workspace\immersive-translator`）的开发。我们要新增「沉浸阅读室」功能。**这一次要一口气开发完，不要中途停下来等我确认。**
>
> **第 0 步（必做，但不用等我）：** 完整读 `docs/reading-room-handoff.md`，它是本次开发的唯一事实来源。再读现有实现核实文档里的假设，**对不上的一律以仓库现状为准**，并在最终报告里列出来：
> - `immersive-translator-windows/src/App.tsx` —— 多窗口 label 分发
> - `immersive-translator-windows/src-tauri/src/lib.rs` 约 800–876 行 —— 托盘菜单与全局热键注册
> - `immersive-translator-windows/src-tauri/src/tts.rs` —— 能不能复用到 boundary 事件
> - `immersive-translator-windows/src/styles.css` —— 令牌与文档 §3 的差异
>
> **执行方式：** 按文档 §11 的 P0 → P1 顺序推进，P2 有余力再做。**每完成一个可独立验收的里程碑就 `git commit` 一次**，message 写清做了什么、怎么验证的。这样即使最后没做完，我也能按 commit 逐段检查。
>
> **遇到分歧不要停：** 文档 §14 那四个开放问题，你按最合理的默认方案自行决定，写进 `docs/reading-room-decisions.md`（每条一句话决定 + 一句理由），然后继续往下做。**只有遇到无法自行决定、且会推翻架构的问题才停下来问我。**
>
> **硬约束：**
> - 不要改动现有划词浮窗、截图 OCR 的任何行为。托盘 / 热键 / 浮窗工具栏的改动**只允许新增**，不得改变既有项的行为。
> - 视觉严格按文档 §3–§7，不要自行发挥、不要"顺手优化"设计。
> - `prototypes/reading-room.html` 只用于参考交互骨架，**里面有 12 处已确证缺陷（文档 §9），不要照抄它的逻辑**。
> - 每个里程碑跑 `npm run test`，全绿才 commit。测试失败不要跳过、不要 `--no-verify`。
>
> **最终交付一份自检报告**，逐条对照文档 §12 的验收清单，明确回答：
> - 哪些完成并通过验证（附验证方式）
> - 哪些没做 / 没做完（**如实说，不要假装完成**）
> - 哪些你自己做了判断、与文档不一致（附理由）
> - 还剩什么阻塞

---

**这样写的三个关键点**

1. **把"人工确认"换成"git commit 切段"。** 不需要来回确认，但不能不留痕。每里程碑一次 commit，"一口气做完"和"事后能逐段查"就不冲突了——出问题也能定位到是哪一段引入的。
2. **"遇到分歧不要停，写进 decisions 文件"。** 这是"一口气做完"能真正跑通的关键。§14 那四个问题不解决它就走不下去；不写这条，它要么停下来问你，要么默默瞎猜。现在是"明确地猜 + 记账"。
3. **要求自检报告，并明确"没做完要如实说"。** 一次性长任务最常见的失败不是做错，是**假装做完了**。这条把完成度变成可核查的输出。

**这个模式下最该防的不是代码质量，是方向性错误被一次性贯彻到所有模块。** 比如它把"跟读模式"理解成了"录音影子跟读"，那词典栏、播放条、数据模型会一起偏。所以自检报告里**第一优先看的是"哪些你自己做了判断"那一节**。

---

**如果后来想改回分阶段**：把第 0 步结尾改成"做完停下来汇报，不要写代码"，并把"执行方式"那段删掉，就是分阶段版。

**如果对方 AI 没有仓库权限**（例如在普通聊天窗口里）：把本文正文贴给它，并额外附上上面四个现有文件的内容，其余照用。

---

## 14. 需要产品方确认的开放问题


1. **翻译引擎**：跟划词翻译共用同一套 Provider（`providerPresets.ts`）吗？长文章的 token 成本要不要单独限流？
2. **抓取范围**：「发送到阅读室」抓的是浏览器正文还是当前前台窗口的可见文本？前者要 Readability 类库 + 网络权限，后者实现简单但拿不全。
3. **跟读打分**（P1-10）用本地模型还是云服务？本地的话要不要引入 whisper.cpp？
4. **阅读室窗口尺寸**：建议默认 1200×800、可缩放至最小 900×600。屏 B 的 380 抽屉 + 640 正文列在 900 宽下会挤，需要窄屏降级方案。
