# 沉浸阅读室 · 可用性 / 响应式 / 视觉审查报告

> 审查对象：Windows 端沉浸阅读室（reader 窗口）  
> 审查方式：UI 设计全栈专家团三阶段（视觉设计 → 体验设计 → 前端工程）  
> 审查日期：2026-10-16  
> 代码基线：`immersive-translator-windows/src/reader/`（TSX 约 16.2k 行 + reader.css 8124 行 / 184KB）

## 0. 审查范围与客观基线

| 项| 实测值                                     | 来源                                                                                                              |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 窗口尺寸| 1200×800                                | `src-tauri/tauri.conf.json:63-64`                                                                               |
| 最小尺寸            | **960×620**                             | `tauri.conf.json:65-66`                                                                                         |
| 重建路径尺寸          | 1200×800，min 960×620（与 conf 一致）         | `src-tauri/src/lib.rs:507-508`                                                                                  |
| 视图路由| 6 个（其中 2 个恒假）| `ReaderApp.tsx:137`                                                                                             |
| 按钮总数            | **253 个**                               | 见下方全量分布，含 SpeakView 26 / SettingsDrawer 28 / ImportDialog 22（初稿漏计）                                |
| `aria-label`    | 仅 **67 处**（vs 253 按钮）                 | 全 `reader/*.tsx` grep                                                                                          |
| `role="button"`   | 17 处（非 button 元素，原生拿不到焦点）            | 全 `reader/*.tsx` grep                                                                                          |
| `@media` 查询     | **reader.css 内仅 2 处**，均 `max-width:980px`   | `reader.css:7575`、`reader.css:8119`                                                                           |
| 焦点环             | **全局已有**（`styles.css:136-139`），非缺失     | 见下方「重要更正二」                                                                                            |
| 固定四栏网格          | 6 处 `repeat(4, 1fr)`，其中**2 处是孤儿CSS**    | 963/1630/2218/3483/7281/7514；963 与 3483 全仓零引用                                                         |
| 固定侧栏            | `.reader-shelf` 232px                   | `reader.css:163`                                                                                                |
| 双栏布局            | `1fr 410px` / `1fr 370px` / `232px 1fr` | 7379 / 7618 / 8018                                                                                              |

**关键前提**：这不是移动端应用，响应式的真实考察区间是 **960–2560px 宽**。低于 960px 由窗口系统挡住，不需要考虑。

#### 按钮全量分布（253 个）

SettingsDrawer 28 / SpeakView 26 / ReviewView 23 / ImportDialog 22 / ReadingView 21 / PlayBar 16 / VaultPage 14 / DictColumn 14 / ReaderTopBar 13 / ShelfPage 11 / ReaderApp 10 / NotesView 9 / SpeakReviewDialog 9 / VocabNoteDialog 9 / ShadowReport 7 / ShadowDrill 5 / ReaderShelf 3 / VocabListPanel 2 / BookTocModal 1 / TodayCard 1 / reviewPreview 1 / shadowPreview 8

---

## 1. 一句话结论

阅读室的**内容设计与交互细节做得相当扎实**（句对主从排版、译文遮罩双模式、字号按比例联动中英文、空状态覆盖完整），真正的问题集中在**工程债**而非设计：**① 路由枚举有 2 个恒假成员 + 7 处恒假守卫（但组件本身是活的，不能删）；② reader.css 响应式仅 2 处断点且设在 980px ——比窗口最小宽度还大，等于完全失效；③ 253 个按钮里 `aria-label` 只有 67 处、17 处 `role="button"` 拿不到原生焦点；④ 全局焦点环虽存在，但强度只有 0.18 alpha 的软影，实际不可见。**

---

## ⚠️ 本报告的两处重要更正（复核后修正）

**更正一 · ReviewView / NotesView 不是死代码**（详见 2.1）
初稿称这两个文件合计 2379 行「不可达」并建议删除——**错误**。它们是 VaultPage 的共享卡片库与 md 档笔记回看入口，删除会直接编译失败。真正死掉的只是路由枚举值。

**更正二 · 焦点环不是「零命中」**
初稿只grep 了 `reader.css`，得出「全库 focus-visible 仅 2 处」。实际上 `styles.css:136-139` 有全局规则，且 reader 窗口经 `main.tsx:3` 会加载：

```css
:focus-visible { outline: none; box-shadow: var(--shadow-ring); border-radius: var(--radius-sm); }
button:focus-visible, input:focus-visible, textarea:focus-visible { box-shadow: var(--shadow-ring); }
```

已核：reader.css 里 10 处 `outline:none` **全在 input/select 上**，无一个 button 选择器。所以**按钮是有焦点环的**，真实缺口是「环太弱」（3px / 0.18 alpha 软影，且常被祖先 `overflow` 裁剪），而非「完全没有」。这把该项从「补 253 个焦点样式」降级为「换一条更强的环」，工作量差一个量级。

---

## 2. P0 级问题（建议优先修）

### 2.1 路由枚举有 2 个恒假成员 + 7 处恒假守卫

**已代码验证**。`ViewRoute` 声明 6 个值：

```ts
// ReaderApp.tsx:137
type ViewRoute = "shelf" | "reading" | "review" | "speak" | "notes" | "vault";
```

但全项目 `setView(...)` 调用经 grep 统计只有 **shelf(1) / reading(3) / vault(5) / speak(1)** 四种，`setView("review")` 与 `setView("notes")` **零命中**。因此 `view === "review"` / `view === "notes"` 这些判断**恒为假**：

| 行号 | 恒假守卫 |
|---|---|
| 1654 | `view === "review" \|\| view === "notes" \|\| view === "vault"` |
| 1800 | `if ((view === "review" \|\| view === "vault") && ...)` |
| 1846 | `if (view === "review" \|\| view === "vault") ...` |
| 2103 | `view === "vault" \|\| view === "review"` |
| 2107 | `: view === "notes"` |
| 2155 | `{(view === "vault" \|\| view === "review") && ...}` |
| 2335 | `view === "notes" \|\| view === "shelf" ? null : (...)` |

**真正死掉的只是路由枚举值本身（2 个成员 + 7 处恒假守卫），不是组件。** 这是本报告最重要的一处更正，详见下方「重要更正」。

#### ⚠️ 重要更正：ReviewView / NotesView 是活代码，不能删

初稿曾判断这两个文件（合计 2379 行）是「不可达死代码」，建议删除。**该判断错误**，前端工程阶段复核并经我独立验证后更正：

- **`NotesView` 已在 vault 中挂载**：`ReaderApp.tsx:2071-2073` 构造 `notesPanel`（`<NotesView .../>`），于 `:2333` 以 `notesPanel={notesPanel}` 传给 VaultPage，作为 vault 的 md 档「笔记库回看」入口。`goNotes`（`:1608`）走的就是这条路。
- **`ReviewView` 是 VaultPage 的共享卡片库**：`VaultPage.tsx:28-34` 从 `./ReviewView` **具名导入** `ClozeCard / DictationCard / GRADE_COPY / SpeakChallengeCard / type SentenceSpec`，并在 `:639/:661` 实际渲染 ClozeCard / DictationCard、`:588` 使用 GRADE_COPY。
- 另有活引用：`review-preview.html` → `reviewPreview.main.tsx`（vite 多页入口）、`ReviewView.render.test.tsx` 9 个 SSR 冒烟用例。

**若按初稿建议删除这两个文件，将直接导致编译失败**（具名导入 + 测试 + 预览页全部引用断裂）。

#### 正确处置：只删路由值，保留组件（A3 方案，约 2h）

| 方案 | 工作量 | 判定 |
|---|---|---|
| 接入口（`goReview` 改成 `setView("review")`） | ~3h | ❌ 反对。vault challenge 档与 review 视图功能重叠，会做出两套复习 UI 抢同一职责；vault 是 v0.8 已确认的「三合一」设计，接入口等于回退设计决策 |
| 删组件（删 ReviewView/NotesView 文件） | ~3h | ❌ 不可行，直接编译失败 |
| **删 2 个路由枚举值 + 收敛恒假守卫** | **2h** | ✅ **推荐** |

**具体改动**：删 `ViewRoute` 的 2 个成员 + 7 处恒假守卫收敛为 vault 单判 + 删 `:2335-2356` 的 ReviewView 渲染分支 + 删 `ReaderApp.tsx:110` 的 `ReviewView` import（VaultPage 直接从 `./ReviewView` 导入，不受影响）。净删约 30 行，**零功能回归风险**。

**托盘 `reader:open-review` 不要动**：`lib.rs:1501` emit 后，`ReaderApp.tsx:1162-1169` 会 `setVaultMode("challenge") + setView("vault")` —— 这是**活的正确入口**，不是死路径。

### 2.2 响应式形同虚设：断点比窗口最小宽度还大

窗口 `minWidth = 960`，而全库唯一的媒体查询是 `max-width: 980px`：

```css
/* reader.css:7575 */@media (max-width: 980px) { ... }
/* reader.css:8119 */ @media (max-width: 980px) { ... }
```

**逻辑推论**：这两条规则只在 960–980px 这20px 的缝隙里可能触发，覆盖的还仅是 `vault-studio-grid` / `sonic-studio-grid` 三处网格。整个阅读室在 960px 到 2560px 之间**没有任何布局降级**。

**960px 下的实测余量**（这是响应式的真实痛点）：

| 布局 | 定义 | 960px 实测 |
|---|---|---|
| vault 工作台 `1fr 370px` | 7618 | 左栏 232 + gap 24 + 右栏 370 → **主列仅剩 334px** |
| `.reader-dict` 词典卡 380 固定 | 1234 | **正文仅剩 580px** |
| `.reader-shelf` 侧栏 232px | 163 | 固定占位，窄窗无法收起 |
| `1fr 410px`（声波工作室） | 7379 | 主列仅剩 ~526px |

**关键判断（比"窗口会变窄"更要紧）**：960→1200 只差 20%，真正的痛点是**两端固定、中间被挤**。左栏 232 + 右栏 370/410 都是硬编码，中间 `1fr` 弹性最小。**优先把两端做成弹性或窄窗折叠，比单纯加断点收益大得多。**

另有 6 处 `repeat(4,1fr)`（963/1630/2218/3483/7281/7514），但经复核**其中 2 处是真孤儿 CSS，全仓零引用，可直接删**：

|孤儿 CSS | 行号 | 验证 |
|---|---|---|
| `.reader-rate-menu`（含 963 网格） | 961-980 块 | 全仓 grep `.tsx` 零引用 |
| `.speak-scenario-grid`（含 3483 网格） | 3481 | 全仓 grep `.tsx` 零引用 |

剩下 4 处（1630 `.grade-row` / 2218 `.sum-grid` / 7279 `.scenario-featured-grid` / 7512 `.phoneme-pill-grid`）是卡片式小格，不是主布局，降级影响面比预想小。

### 2.3 sepia 主题下正文回标几乎不可读

`.reader-root[data-theme="sepia"]`（`styles.css:2929`）定义的是**墨绿 accent `#1B6B58`**，但**没有定义 `--clause-indigo`**。该变量只在 dark（`styles.css:2902`，`#8093FF`）与全局 sepia（`styles.css:2843`，`#3649C4`）定义。

而正文里的结构拆解回标直接使用且**没有 fallback**：

```css
/* reader.css:6892-6898 */
.reader-root .spatial-clause-mark {
  background: var(--clause-indigo-soft);   /* 深色下rgba(128,147,255,.16) */
  color: var(--clause-indigo);              /* 深色下 #8093FF 亮靛蓝 */
  border-bottom: 2px solid var(--clause-indigo);
}
```

在浅色墨绿主题下会解析成深色模式的半透明靛蓝底 + 亮靛蓝字，**色相冲突且对比度不可读**。注意 `reader.css:7836` 的掌握度胶囊写法是对的（有 fallback），此处漏了。

---

## 3. 可用性与交互（体验设计阶段）

### 3.1 主链路完整，四处断点

主链路 **导入 → 阅读 → 查词 → 加生词 → 复习 → 口语** 全程可达，但有断点：

| # | 断点                                 | 说明                                  |
| - | ---------------------------------- | ----------------------------------- |
| 1 | 查词结果无「加入生词本」按钮                     | 词典侧栏需靠悬停正文词块加词，无稳定入口                |
| 2 | 阅读中进度条不显示                          | 依赖 `showProgress` 设置（默认关闭），用户不知道读到哪 |
| 3 | ~~托盘「生词本」→ emit `reader:open-review`~~ | **复核后撤回**：这是**活的正确入口**，`ReaderApp.tsx:1162-1169` 会 `setVaultMode("challenge") + setView("vault")`，见 2.1 |
| 4 | 加词无任何反馈| 疑为加入后仅在侧栏标记，无toast                  |

### 3.2 已做得好、建议保留

- **术语一致性达标**：「生词本」69 处、「笔记」129 处、「书架」48 处；「生词库/词库」混用 **0 处**，「快速复习/影子跟读」**0 处**（统一说法，不误报）
- **空状态覆盖完整**：书架/笔记/词典/复习/口语/导入全都有，且是「图标 + 标题 + 说明 + 引导按钮」四件套，不是干巴巴一句「暂无」
- **快捷键设计克制**：`Space/J/K/L/H` 仅在 reading 视图生效，且正确排除输入框（`ReaderApp.tsx:1866-1889`）
- **译文遮罩交互精妙**：blank（留白显影）/ frost（毛玻璃）双模式，遮罩态用 `visibility:hidden` 占位零视觉噪音，是整页最见功力的部分
- **字号有边界钳制**：`READER_FONT_SIZE_MIN=14 / MAX=24`（`core/readerTypes.ts:324-325`），且运行时按比例联动中英文（`ReaderApp.tsx:2064-2069`）

---

## 4. 视觉设计（视觉设计阶段）

### 4.1 排版体系是全页最成功的部分

- 句对主从取代双栏段落对照，避免了段落内部句子横向错位
- 正文列固定 640px 居中，英文行长 ~65 字符，符合舒适区
- 中英文字体配对（Source Serif 4 + 思源宋体）解决 CJK 视觉重量问题
- 防御性写法到位：`min-width: 0` / `flex-wrap` / `text-overflow: ellipsis` 全库多处

### 4.2 视觉问题清单

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| 1 | 中 | `styles.css:45` `--shadow-ring: 0 0 0 3px rgba(76,95,240,0.18)` | **焦点环太弱**：0.18 alpha 的3px 软影，常被祖先 `overflow` 裁剪，实际不可见（不是"没有"，见更正二） | 换`outline: 2px solid var(--accent)`，对比度提到 1.0 |
| 2 | 中 | 253 个按钮中 `aria-label` 仅 67 处；`role="button"` 17 处 | 非button 元素拿不到原生焦点，键盘不可达——**比热区更实质的缺口** | 补 `aria-label` + `role="button"` 处补 `tabIndex={0}` 与 Enter/Space |
| 3 | 中 | `.reader-tb-btn` 30×30（103-104）、`.reader-skip-btn` 34×34（773） | 高频共享类热区偏小 | 顶栏键→34（顶栏高 52 装得下）、跳句→38（走带高 62 装得下）；`.island-tab`(6425，高32) **建议不改**，导航岛胶囊牵动整体布局 |
| 4 | 中 | sepia 主题缺 `--clause-indigo`（见 2.3） | 正文回标不可读 | 补 sepia 定义 + 加 fallback |
| 5 | 中 | 6 处固定四栏（见 2.2），两端固定栏宽 | 窄窗挤压，vault 主列仅剩 334px | 三档断点 + 两端弹性化 |
| 6 | 低 | `reader.css` 184KB / 8124 行，`.reader-root` 前缀只覆盖 v0.8 段（7000+），前 7000 行裸类名 | v0.8 段无法覆盖老样式，是大量重复定义的根因 | 按视图分文件 + 统一加前缀 |
| 7 | 低 | `.reader-root` `overflow: hidden`（10-19） | 横向溢出被静默裁掉，用户既看不到也滚不动 | 改 `overflow-x: auto` |

### 4.3 需澄清的一处

Phase 1 报告中「正文行长」一条经复核**属于误报**：字号放大时 `ch` 单位同步缩放，字符数不变，视觉行长（字符数）保持稳定，真正变的是像素宽度。建议不列入待办。

---

## 5. 保留点（不要动）

以下设计决策经审查确认有效，避免后续返工时误伤：

1. **句对主从排版**（一句原文 + 紧随其下译文）——不要改回双栏对照
2. **正文列固定 640px 居中**——不要改成撑满
3. **译文遮罩 blank/frost 双模式** ——交互模型完整
4. **视图菜单管「显示什么」/ 设置抽屉管「怎么显示」** 的职责划分——不要合并
5. **中英文字体配对 + 字号拉开层级** ——不要统一字号
6. **术语体系**（生词本 / 书架 / 笔记）——已一致
7. **设置按文章记忆 + 全局默认一份** ——`readerSettingsStore.ts` + Rust `reader_store` 双层设计合理

---

## 6. 前端工程落地（Phase 3）

### 6.1 死路由处置

完整的三方案对比见 2.1。工程落地要点（约 2h）：

- 删 `ViewRoute` 的 `"review"` / `"notes"` 两个成员（`ReaderApp.tsx:137`）
- 7 处恒假守卫收敛为 vault 单判：1654 / 1800 / 1846 / 2103 / 2107 / 2155 / 2335
- 删 `:2335-2356` 的 ReviewView 整页渲染分支
- 删 `ReaderApp.tsx:110` 的 `ReviewView` import（VaultPage 直接从 `./ReviewView` 导入，不受影响）
- 保留 `ReviewView.tsx`（重新定位为共享卡片库）、`NotesView.tsx`、测试与预览页

净删约 30 行，**零功能回归风险**。

### 6.2 删孤儿CSS（P0，0.5h，零风险）

两处全仓 `.tsx` 零引用的死CSS，直接删：

- `.reader-rate-menu` 整块（`reader.css:961-980`，含 963 行 `repeat(4,1fr)` 网格）
- `.speak-scenario-grid`（`reader.css:3481`，含 3483 行 `repeat(4,1fr)`）

删完 6 处四栏降为 4 处。

### 6.3 响应式降级 CSS（可直接粘贴）

约定：**≥1440 增益 / 1200–1439 保持现状（默认宽度，零风险）/ 960–1199 降级**。追加在 `reader.css` 末尾（8124 行后）。

```css
/* ==========================================================================
   断点体系（Phase 3）
   窗口规格：1200×800 基准，minWidth 960 / minHeight 620。
   基准层 = 现有样式不动；≥1440 为增益层；≤1199 为降级层。
   ========================================================================== */

/* ---------- ≥1440：宽窗增益（纯加分，可选） ---------- */
@media (min-width: 1440px) {
  .reader-root .bookgrid { grid-template-columns: repeat(3, 1fr); }
  .reader-root .scenario-daily-grid { grid-template-columns: repeat(5, 1fr); }
  .reader-root .sonic-studio-grid { grid-template-columns: 1fr 460px; }
  .reader-root .vault-studio-grid { grid-template-columns: 1fr 420px; }
  .reader-dict { width: 420px; }
}

/* ---------- ≤1199：窄窗降级（960–1199 生效） ---------- */
@media (max-width: 1199px) {
  /* 左栏 232 → 200：.reader-shelf 同时服务书架页与 vault 左栏
     （VocabListPanel.tsx:81 复用同一 class），必须一起收 */
  .reader-shelf { width: 200px; padding-left: 16px; }

  /* 词典/透镜卡 380/386 → 330：.spatial-lens-card（.reader-root 前缀, 7002）
     与 .reader-dict（1234）两个来源都会作用到 DictColumn，只改一个会漏 */
  .reader-dict { width: 330px; }
  .reader-root .spatial-lens-card.vault-lens-card { width: 330px; }

  /* vault 工作台右栏 370 → 320（省下的 50px 回给主列） */
  .reader-root .vault-studio-grid { grid-template-columns: 1fr 320px; gap: 16px; }

  /* vault 笔记库左栏跟随 .reader-shelf 的 200（原本写死 232） */
  .reader-root .vault-notes-grid { grid-template-columns: 200px 1fr; }

  /* 口语工作室右栏 410 → 340 */
  .reader-root .sonic-studio-grid { grid-template-columns: 1fr 340px; gap: 16px; }

  /* 场景中心：每日四卡 4→2 列，主打卡双栏 1.15/0.85 → 单栏 */
  .reader-root .scenario-daily-grid { grid-template-columns: repeat(2, 1fr); }
  .reader-root .scenario-featured-grid { grid-template-columns: 1fr; }

  /* 双语对照双栏 → 单栏（否则每栏仅 ~240px，中英对照失去意义） */
  .reader-root .parallel-spread-row { grid-template-columns: 1fr; gap: 12px; }

  /* 评分四键 4→2 列（窄窗下 4 键每键仅 ~78px，触控目标不足） */
  .grade-row { grid-template-columns: repeat(2, 1fr); }

  /* 音素丸 4→3 列 */
  .reader-root .phoneme-pill-grid { grid-template-columns: repeat(3, 1fr); }

  /* 28 天热力图仍是 14 列（语义不能变），只收间距保可读 */
  .reader-root .heatmap-grid { gap: 3px; }
}

/* ---------- 书卡网格：改自适应，无需断点（更稳） ---------- */
/* 替换 5908 行的 repeat(2,1fr) —— 任意宽度都成立，且省掉一个断点 */
.bookgrid {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

/* ---------- ≤1019：极窄兜底（防止左栏挤掉主列） ---------- */
@media (max-width: 1019px) {
  .reader-shelf { width: 176px; }
  .reader-root .vault-studio-grid,
  .reader-root .sonic-studio-grid { grid-template-columns: 1fr; }  /* 右栏落到下方 */
}
```

**顺带**：现有 `max-width:980px` 两处（7575 / 8119）已被 1199 / 1019 覆盖，可合并删除，避免三套断点并存。

**另外必须改**：`.reader-root`（10-19 行）的 `overflow: hidden` → `overflow-x: auto`。当前横向溢出会被静默裁掉，用户既看不到也滚不动。

### 6.4 焦点与热区：低成本批量方案

**关键约束**：`:where()` 特异性为 0，**无法覆盖** `.reader-tb-btn{height:30px}` 这类已有规则。所以纯 `:where()` 提不高热区，要靠伪元素外扩。两者分工如下。

#### C1 · 焦点环升级（P0，约 1.5h，纯增量、零视觉回归）

```css
/* 把 styles.css:136-139 的 3px/0.18alpha 弱影升级为实体环。
   用 outline 而非 box-shadow —— 因为 reader.css:2865/5885 两条 button.on 规则
   特异性(0,2,1) 高于此处(0,2,0)，box-shadow 会被吃掉，outline 不会。
   .reader-root 包裹 → 不影响主应用其它窗口。 */
.reader-root :where(button, [role="tab"], [role="button"], a,
                input, select, textarea, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: none;              /* 消除 styles.css 的弱影，防双环 */
  border-radius: var(--radius-sm);
}

/* Windows 高对比度：强制色模式下系统会抹掉 box-shadow，outline 才留得住 */
@media (forced-colors: active) {
  .reader-root :where(button, [role="tab"], a, input, select, textarea):focus-visible {
    outline: 3px solid Highlight;
  }
}
```

特异性核过：`(0,2,0)` > `styles.css` 的 `button:focus-visible` `(0,1,1)`，稳赢。
**视觉影响**：仅键盘 Tab 时出现，鼠标点击不出现（`:focus-visible` 语义保证）。对比度从 0.18 alpha 提到 1.0 主色，是净增益。

#### C2 · 高频共享类真提热区（P1，约 0.5h）

只改**约 10 个共享基类**，不是 253 个按钮实例：

```css
/* 顶栏图标键 30×30 → 34×34（顶栏高 52，上下仍各留 9px，不溢出） */
.reader-tb-btn { height: 34px; min-width: 34px; }
/* 走带跳句 34×34 → 38×38（走带高 62，装得下） */
.reader-skip-btn { width: 38px; height: 38px; }
```

`.island-tab`（6425，高 32）**建议不改**——导航岛是显眼的胶囊，改 4px 高会牵动整个岛布局。

#### C3 · 长尾按钮命中区外扩（P1，约 1h）

```css
/* 零特异性、零布局抖动的命中区兜底：视觉尺寸完全不变，仅扩大可点范围 4px。
   :where() 为 0 特异性，无基类设过 ::after，必定生效。 */
.reader-root :where(button, [role="tab"], [role="button"], summary):not(:disabled) {
  position: relative;
}
.reader-root :where(button, [role="tab"], [role="button"], summary):not(:disabled)::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: inherit;
}
```

**三个必须写进验收的风险**：
1. 相邻小按钮命中区会重叠约 2px，需实测无误触；
2. 祖先 `overflow:hidden` 会**连命中测试一起裁掉**外扩部分（视觉无碍、点击无效）→ 滚动容器内的按钮要靠 C2 提真实尺寸兜底；
3. `position:relative` 会让原本 static 的按钮成为定位锚点，需回归浮层/tooltip 定位。

### 6.5 按钮标注补全（P1，约 4h）

253 个按钮仅 67 个 `aria-label`；17 处 `role="button"` 是非button 元素，原生无焦点，需补 `tabIndex={0}` + Enter/Space 键。**这项对键盘可用性的收益高于热区调整。**

缺口最大的文件（grep `<button` / `title=` / `aria-label`）：

| 文件 | 按钮数 | title | aria-label | 缺口 |
|---|---|---|---|---|
| ReadingView | 21 | 21 | 2 | ✅ title 全覆盖 |
| PlayBar | 16 | 12 | 1 | ⚠ 拖拽条无键盘操作 |
| **VaultPage** | 14 | **3** | 2 | ❌ 缺口最大：复制(763)、关闭(783)、胶带操作(238/241/340/344) |
| **NotesView** | 9 | 5 | **0** | ❌ 全文件零 aria |
| **ShelfPage** | 11 | 8 | **0** | ❌ 零 aria |
| DictColumn | 14 | 8 | 2 | ⚠ 关闭按钮(120) 仅 title |
| ReaderTopBar | 13 | 7 | 5 | ⚠ 主题按钮仅 title |

**优先补 `VaultPage`**：14 个按钮只有 3 个 title，纯图标按钮（复制/关闭）在读屏下完全无法辨识。

### 6.6 改动量表

| # | 改动项 | 触及文件 | 人时 | 风险 | 优先级 |
|---|---|---|---|---|---|
| A1 | ViewRoute 删 2 值 + 7 处恒假守卫 + 删 2335-2356 分支 + 删 import:110 | 1 | 2 | 低 | **P0** |
| A2 | 删孤儿CSS `.reader-rate-menu`(961块)、`.speak-scenario-grid`(3481) | 1 | 0.5 | 低 | **P0** |
| A3 | sepia 补 `--clause-indigo` + fallback | 2 | 0.5 | 低 | **P0** |
| C1 | 焦点环升级（`:where()` + outline + forced-colors） | 1 | 1.5 | 低 | **P0** |
| C2 | 高频共享类热区（`.reader-tb-btn` / `.reader-skip-btn`） | 1 | 0.5 | 低 | P1 |
| C3 | `::after` 命中区外扩兜底 | 1 | 1 | 中（重叠/裁剪/定位锚点） | P1 |
| C4 | 253 按钮补 aria-label / `role=button` 补 tabIndex | 6–8 | 4 | 中 | P1 |
| B1 | 断点骨架（1440/1199/1019 + 注释），合并旧 980 两处 | 1 | 1 | 低 | P1 |
| B2 | 九处网格降级（含 bookgrid auto-fill、平行对照单栏） | 1 | 2.5 | 中（右栏落下方后观感需走查） | P1 |
| B3 | 左栏/词典卡收窄（232→200、380/386→330） | 1 | 1 | 中（双来源须同改） | P1 |
| — | `.reader-root` overflow-x 改 auto | 1 | 0.2 | 低 | P0 |
| — | 查词侧栏加「加入生词本」按钮 + toast | 2 | 3 | 中 | P1 |
| — | 阅读进度条默认开启 + 首次提示 | 1 | 1 | 中（改默认行为需验证） | P1 |
| D1 | ReaderApp 拆分：`notesPanel`→`useNotes()`；渲染分发→`ReaderRouter` | 3–4 | 8 | 中高（180 个 hook 重排） | P2 |
| D2 | ReviewView 更名/迁为共享卡库 `RecallCards.tsx` | 4–5 | 3 | 低 | P2 |
| D3 | 竖向密度 `@media (max-height:700px)`（620 下 chrome 占 114px） | 1 | 1 | 低 | P2 |

**合计：P0 约 4.5h ／ P0+P1 约 18h。**

### 6.7 三个可独立验证的批次

**批次一 · 死代码与主题缺陷（约 3h）** = A1 + A2 + A3
- 验证：`npm run build` 通过 · `npm test` 现有 32 用例全绿（ReviewView 9 / VaultPage 9 / DictColumn 6 / FolioSheet 6 / ShadowReport 2）· 手工走 6 入口（书架→阅读→口语→生词本三档→笔记回看→托盘「生词本」）均正常 · sepia 主题下 `.spatial-clause-mark` 有颜色 · grep `view === "review"` 零命中 · 渲染树无 ReviewView 外壳

**批次二 · 无障碍（约 7h）** = C1 + C2 + C3 + C4
- 验证：仅键盘 Tab 走查顶栏/走带/导航岛/词典卡/复习卡，截图对比环可见 · 鼠标点击不出现环 · 切 `forced-colors: active` 环仍在 · 实测相邻小按钮无误触 · 顶栏键命中区 ≥34px
- **此批与批次一无耦合，可并行**

**批次三 · 响应式（约 7h）** = B1 + B3 + B2
- 验证：窗口拖到 **960 / 1200 / 1440** 三档各截图，逐项核对九处网格 · 960 档无横向滚动条、无文字截断 · vault/口语右栏落下方后主列可读 · 20%/28% 缩放（125%/150% DPI）下复查
- 建议**再切一刀**：B1+B3（纯宽度收窄，低风险）先行验收，B2（含单栏降级，观感变化大）单独一批，避免响应式问题集中爆发难归因

---

## 7. 组件结构风险定位（供 P2 取舍）

`ReaderApp.tsx` 2597 行 / **180 个 hook**（39 useState、71 useCallback、23 useMemo、25 useRef、22 useEffect）+ 6 处 Tauri 事件监听，是典型 "God Component"。

`reader.css` 8124 行，无 reset 层、无 `auto-fill`/`auto-fit`（0 处），且 `.reader-root` 前缀只覆盖 v0.8 段（7000+），前 7000 行是裸类名——**这是v0.8 段大量出现重复定义的根因**。

**最该先拆的不是视图，而是 `notesPanel`（`:2071-2095`，25 行 JSX + 15 个 prop）→ `useNotes()` hook**：边界最清晰、纯数据搬运、无渲染分支耦合，且顺带消灭「以组件名命名的变量」这个反模式。视图渲染分发（`:2154-2357`）拆 `ReaderRouter` 放第二顺位。

---

## 8. 落地顺序

以 6.7 节的三批次为准（批次一 3h ／ 批次二 7h ／ 批次三 7h）。批次二与批次一无耦合，可并行；批次三建议再切一刀：纯宽度收窄（B1+B3）先行验收，含单栏降级的 B2 单独一批，避免响应式问题集中爆发难归因。

P1 的体验补齐项（查词侧栏加「加入生词本」按钮 + toast、进度条默认开启）可挂在批次二尾部一起做。
