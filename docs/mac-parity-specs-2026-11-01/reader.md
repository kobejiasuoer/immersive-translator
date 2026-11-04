# 阅读室改版（reader）Mac 1:1 移植规格

- **对齐基线**：Windows commit `1c5205d`（feat(reader): 2026-10-26 阅读室全面改版——三段外壳 + 阅读页白卡重构 + 笔记四态 + 书架三列直达，2026-10-27）。
- **领域目标**：三段外壳、阅读页白卡重构 + 进度轨、笔记四态（home/notes/focus/export）、书架三列直达。
- **本文所有 Windows 行号均对 `immersive-translator-windows/` 于本勘察时的工作区（main 分支，含 1c5205d 及其后提交）**；Mac 行号对 `immersive-translator-mac/` 工作区现状。
- 勘察中已运行的验证：`npx vitest run src/reader/VaultPage.test.tsx src/reader/ReadingView.cloze.test.tsx src/reader/ReviewView.render.test.tsx src/reader/DictColumn.test.tsx`（在 `immersive-translator-windows/` 下执行）→ **4 个文件 48 例全部通过**（VaultPage 27、cloze 9、render 6、DictColumn 6）。
- 服务端说明：任务书提到的 `immersive-translator-server/` **在当前仓库不存在**（根目录仅 contracts/packages/各端工程，已用 `ls` 核实）。阅读室改版本体零网络改动；涉及的唯一跨端协议是 `contracts/learning-relay-v2.md`（学习同步），详见 §1.4。

---

## 1. Windows 行为规格

### 1.1 功能入口与交互流

#### 1.1.0 视图路由与外壳挂载（ReaderApp 组合根）

- 视图路由四值：`type ViewRoute = "shelf" | "reading" | "speak" | "vault"`（`src/reader/ReaderApp.tsx:155`）。原 `review`/`notes` 两值已删除——它们没有任何 `setView` 入口，7 处 `view === "review" || view === "notes"` 恒为假（`ReaderApp.tsx:146-154` 注释）。**ReviewView/NotesView 组件保留**：VaultPage 从前者导入卡片组件（`VaultPage.tsx:60-67`），NotesView 作为 notes 档内嵌面板（`ReaderApp.tsx:2301-2324`）。
- 应用启动**默认落整页书架**（书架是首页）：`useState<ViewRoute>("shelf")`（`ReaderApp.tsx:258-259`）；仅外部推入（热键导入 `takePendingReaderImport`、继续阅读 `takePendingOpenBook`）才直接进 reading（`ReaderApp.tsx:1322-1347`）。
- 导航岛三档归并映射：`shelf/reading→阅读、speak→口语、vault→笔记与复习`（`ReaderApp.tsx:1877-1878`）。档内路由 `navigateSurface`：reading→`goReading`、speak→`goSpeak`、vault→`setView("vault")` **不重置 vaultMode**（已在 vault 内跨视图进入保留上次档位，`ReaderApp.tsx:1867-1875`）。
- folio 书架浮层（`ReaderShelf.tsx:31-56` FolioSheet）：由外壳左段「书架 · 书名」触发，挂在根顶层；外点关闭白名单 `.floating-folio-sheet, .brand-folio-pill, .shell-brand`（`ReaderApp.tsx:383-392`）；Esc 关闭（`useEscapeClose`）。
- 根 div 皮肤：`data-skin="folio"` 仅 shelf/reading 两视图挂；speak/vault 不挂（`ReaderApp.tsx:2330-2335`）。`data-theme` 四主题与 `data-font` 不受影响。
- 阅读页进度墨线：`view === "reading" && effectiveSettings.showProgress && article` 时渲染 `.reader-inkline`（`ReaderApp.tsx:2385-2389`）。
- 顶栏 articleName 映射：shelf→`null`、vault→`"笔记与复习"`、speak→`"口语陪练"`、reading→`article.title`（`ReaderApp.tsx:2338-2346`）。

#### 1.1.1 三段外壳（ReaderTopBar）

文件 `src/reader/ReaderTopBar.tsx`；样式 `reader.css:9221-9410`（「外壳重构 2026-10-26」横幅）。

结构（`ReaderTopBar.tsx:92-202`）：`<header class="floating-top-stage">` 内三段容器 grid `1fr auto 1fr`（`reader.css:9285-9289`）：

| 段 | 容器类 | 内容（行号） | 交互 |
|---|---|---|---|
| 左 | `.shell-brand` | monogram 印章按钮「I」（:95-103）+ 书卷胶囊 `.folio-drawer-trigger`（:104-118，书本 svg + 「书架{· 文章名}」+ ▾） | 「I」→ `onHome`（回整页书架，title/aria「回到书架」）；书卷胶囊 → `onToggleFolio`（弹出/收起书架浮层，title「打开书架浮层（切换书 / 短文，继续读）」，`aria-haspopup="dialog"`） |
| 中 | `.shell-tabs`（`aria-label="主导航"`） | 三档 `.island-tab`：阅读（IconBookOpen）/口语（IconMic）/笔记与复习（IconNotebook + 角标）（:121-151） | 点按 `onNavigate(surface)`；vault 档 title「生词复习与笔记都在这一档」；角标 `.island-counter` = `dueNow + unnotedCount`，>0 才渲染（:90,:149）；`aria-current="page"` 随高亮档 |
| 右 | `.shell-tools` | 检索输入（:154-173）+ 检索按钮（:174-182）+ 主题循环按钮（:183-191）+ 设置按钮（:192-200） | 检索：点按钮展开输入并聚焦（:69-71），Enter→`onSearch(q.trim())`，Esc 关闭并清空；空输入 blur 即收起（:168-170）。主题：`THEME_CYCLE = ["light","dark","sepia","oled"]` 循环（:49,:80-83）。设置按钮 → `onOpenDrawer`（阅读设置抽屉） |

- 专注复习态：`focusMode = view === "vault" && vaultMode === "focus"`（`ReaderApp.tsx:2368`）→ 根类追加 `vault-focus-top`，隐藏中心导航岛（`ReaderTopBar.tsx:45-47,:93`；对齐原型 focus 态）。
- 全文检索落点（`ReaderApp.tsx:2351-2362`）：`article.sentences.find(s => s.en.toLowerCase().includes(q.toLowerCase()))` 取首个命中 → `setSearchMatchIdx(hit.idx)` + `playback.setActiveIdx(hit.idx)` + toast `在第 ${hit.idx + 1} 句找到「${q}」`；无命中 toast `本文没有包含「${q}」的句子`。
- 主题循环文案：`{ light: "纸书", dark: "深色", sepia: "护眼", oled: "纯黑" }`（`ReaderTopBar.tsx:73-78`；ReadingView.tsx:485-490 同表复用）。
- **视图菜单 ViewMenu 仍由本文件导出**（`ReaderTopBar.tsx:207-284`），由 PlayBar「视图」按钮在 `viewMenuAnchor` 处挂载（`ReaderApp.tsx:2793-2800`）：对照模式循环（仅英文/对照/仅中文）、译文遮罩 · 自测（勾选）、显示阅读进度（勾选）、禅模式 · 隐藏侧栏与播放条（勾选）+ 右上角关闭按钮。外点 mousedown 关闭。
- CSS 几何（`reader.css:9285-9352`）：三段均为 999px 圆角胶囊 `--glass-pill` 底 + `backdrop-filter: blur(20px)` + `--glass-border` 描边；**folio 皮肤（shelf/reading）下改为平面白胶囊**：`background: var(--surface)`、去 blur、去投影（`reader.css:9344-9352`）；激活 tab 变 `--text-1` 深底白字（:9359-9363）。左段 max-width 380px（:9307）。
- 旧三胶囊选择器（`.brand-folio-pill/.center-nav-island/.right-controls-island`）标注 deprecated 保留兜底（commit 信息；`reader.css:6257-6259`）。

#### 1.1.2 阅读页白卡重构 + 进度轨（ReadingView）

文件 `src/reader/ReadingView.tsx`；样式 `reader.css:11105-11315` 区段（folio 作用域）与 `6666-6689`（几何契约）。文档头注释即结构总纲（`ReadingView.tsx:1-17`）。

布局自上而下：

1. **`.reading-toolbar` 控件收口**（`ReadingView.tsx:836-899`）：
   - 左 meta：书章模式 `《不出现》——是「{book.title} · 第 {chapterIdx+1}/{chapterCount} 章 · 」`拼接 + `{wordCount.toLocaleString()} 词 · 约 {readMinutes} 分钟`（readMinutes = max(1, round(wordCount/200))，:482）+ level tag + 翻译 chip `翻译中 {done}/{total} 段`（:843-846）+ 词块 chip `词块标注中 {done}/{total} 批`（:847-851，与 translating 互斥显示）。
   - 遮罩控件组 `.reading-mask-ctl`（:853-876，title「遮住译文先读原文，需要时再点开；按住 H 临时全显」）：开关 `role="switch"`（aria「译文遮罩」）+ label「译文遮罩」+ 计数 `已揭开 {revealedCount} / {maskableCount} 句`（开）或「译文常显」（关）+ 条件按钮「全部揭开」（有未揭开时）/「全部遮住」（有已揭开时）。
   - 随读抽查战绩（:877-881，quizOn 且有槽位时）：`抽查 {hit} 命中 · {close} 接近 · {trap} 陷阱 · 剩 {todo}`（title「随读抽查战绩：命中 · 接近 · 陷阱 · 待答」）。
   - 目录 chip「目录」（有 onOpenToc 时，:882-887）+ 阅读设置 chip「阅读设置」（:888-898，title「排版 / 字号 / 专注 / 短语虚线 / 随读抽查都收在这里」，`aria-expanded`/`aria-haspopup`）。
2. **阅读设置浮层 `.reading-settings-pop`**（:902-1004，`role="dialog"` aria「阅读设置」，点浮层外关闭 :406-415）：排版 seg（段落/对照，title 分别「段落 = 行内英文流 + 当前句译文浮层」「双语对照 = 逐句双栏」）；句卡开关（仅段落排版可用，本地态不落盘，title「段落排版下把每句拆成独立句卡（只影响本窗口，不落盘）」）；字号步进 −/值/+（14–24，`READER_FONT_SIZE_MIN/MAX`，readerTypes.ts:353-354）；短语虚线开关（title「词块/生词在正文里用虚线标记，点击看释义并可收藏」）；专注模式开关（title「非当前句变淡 + 收起右侧解析面板，注意力聚焦当前句」）；随读抽查开关（title「已读句的词块/生词变行内填空：Enter 判分 · ? 首字母提示 · 按住 H 显影。只考读过的句子，本地判分不耗流量」）；主题只读行（显示当前主题名）。
3. **正文滚动区 `.reading-scrollpane`**（:1007-1020）：class 组合 `reader-contrast-en`/`reader-contrast-zh`（对照模式经 CSS 隐藏另一语种）+ `reader-mask-on`。
   - **左缘进度轨 `.reading-rail`**（:1021-1029，aria-hidden）：`rail-pct`（`{railPct}%`，railPct = total>0 ? max(1, round((activeIdx+1)/total*100)) : 0，:484——与 dock 同口径「光标句/总句」）+ `.rail-track` 竖轨（`<i>` height=railPct%）+ `.rail-label`（书章 `CHAPTER {chapterIdx+1}` / 短文 article.title，title 悬停全书名）。
   - **居中 640px 正文列 `.reading-col`**（reader.css:11244）：
     - 续读胶囊 `.resume-capsule`（:1032-1059）：`showResume = resumeIdx > 0 && resumeIdx < total && !translating && !resumeHidden`（:481）；内容「上次读到 **第 {resumeIdx+1} 句**」+ 按钮「回到那里」（→`onJumpTo(resumeIdx)` 并隐藏，title「回到上次读到的句子」）+ 关闭 ×（title「只是隐藏提示，断点仍在」）；换文复位（:168）。
     - 刊头 `.reading-head`（:1061-1101）：书章 eyebrow `CHAPTER {n} · {书名大写}`；32px 标题 `.reading-title`；副题行 = titleCn / `标题翻译失败（{titleCnError}）` + 「重试」按钮（失败态，:1071-1081）/ 骨架线（翻译中）/ 空；书章时按钮「围绕本章练口语」（IconMic，title「带着本章内容去口语陪练」，:1089-1099）。
     - 正文 prose 分支（:1103-1125）：`.prose-body`（spotlight 加 `spotlight-active`、句卡加 `sent-cards`）按 `paragraphIdx` 分组渲染 `.prose-paragraph`，句间补空格；每句 `.prose-sentence.pair-en`（当前句 `is-current`、失败 `failed`），点击定位（`handleProseClick`：点句 `onJumpTo(idx)` + 点词 `onWordClick`）；首段首字母下沉 `drop-cap`（纯文本首段才拆，:1183-1194）。
     - parallel 分支（:1127-1151）：`.parallel-spread-row` 双栏（en + zh），段落首行 `paragraph-start`；英文列单击查词、划选 mouseup 查短语（:439-447,:417-429）。
     - 读完动作（:1153-1160）：`showFinishAction`（光标到末句、未确认读完、非播放中，`ReaderApp.tsx:2133-2137`）→ 主按钮 `{finishLabel}`（书章「读完本章」/短文「读完本篇」，`ReaderApp.tsx:2467`）+ hint「已到文章末尾：确认读完，整理本篇收获或稍后复习。」。
     - **译文浮层 `.translation-pop`**（:1162-1163 挂当前句，:746-824 渲染）：绝对定位在**当前句末行下方**——`placePop`（:298-318）取当前句 `getClientRects()` 最后一个 rect：`top = last.bottom − col.top + 10`；箭头 `--ax = last.right − col.left − 24 − 20`，clamp `[16, col宽−48−44]`。重放时机：换句/字号/排版/句卡/专注/续读关闭/译文状态变化 + resize + `document.fonts.ready`（:320-354）。内容（:746-824）：
       - 编辑中 → 手改译文编辑器（textarea + 「取消」「保存」+ tip「Ctrl+Enter 保存 · Esc 取消」，:623-647）；
       - 段失败 → `本段翻译失败 {zhError?}` + 「重试本段」；
       - 遮罩中 → veil 按钮「点击显示译文」（IconEyeOff，title「点按显示这一句的译文」）→ `onReveal`；
       - 常规 → 译文 `.pop-zh`（pending 时骨架/「译文待生成」；遮罩开时点按回遮，title「点按重新遮住」）+ `.pop-actions`：「朗读本句」（播放中当前句则变停止，title「停止朗读（Space / 播放条的 ⏸ 也可以）」/「朗读这一句（读完自动停，不会连读下去）」）、「用这句练口语」（IconMic，title「带着这句去口语陪练」）、「编辑译文」（title「手改译文」）、遮罩开时提示 `按住 H 看译文`。
       - **句子解析入口唯一化在右侧面板**：浮层不再重复（:744 注释）；快捷键 E 仅解析面板 idle 速览态触发（:382-403）。
     - 随读抽查挖空（:520-593 renderSpanSeg）：已读句的词块/生词 span 命中本句槽位时渲染行内 `<input class="cloze-input">`（宽 `calc(max(len,5)ch * 0.62 + 18px)`，aria`补全挖空的{生词|词块}：{firstLetters}`，Enter 判分 / Esc blur / 点击 stopPropagation）+ `?` 首字母提示按钮（title「首字母提示（命中会降档为「接近」）」，点击填入 firstLetters 并 focus、记 usedHint）；已答渲染印章 `.cloze-stamp`（命中/接近/陷阱/未中，`VERDICT_LABEL` :117-122）+ 错答删除线 `.cloze-wrong` + 注释 `.cloze-note`（`陷阱 · {trap}` 或 `释义 · {gloss}`）；判分 `commitCloze`（:493-501）：`judgeCloze` 本地判，用过提示的 perfect 降档 close；胶带 toast（:503-513，左下角最多 3 条 3.2s 退场）：known 槽 `已记入复习 · 良好`（perfect/close）/`已记入复习 · 需复习`（其余）、非 known 槽 `抽查完成`。
   - 正文下方渐隐 `.reading-fade`（:1168）+ `.cloze-toast-layer`（aria-live=polite，:1170-1177）。
4. **空态**（article 为 null，:1239-1265）：「从一篇短文开始」+ 引导文（含「发送到阅读室」「Ctrl+Shift+R」kbd 提示）+ 主按钮「添加阅读内容」（`onOpenImport()` 缺省文库 tab）。
5. **dock 居中几何契约**（reader.css:7155-7180 + 9249-9254）：右栏占位令牌 `--reading-side-w: 388px`（folio 皮肤默认；≤1199px 窗口 328px、≤1019px 与专注模式经 `.reader-root[data-side-hidden]` 置 0px）；播放条 `.floating-sonic-dock`（PlayBar.tsx:190）`position:absolute; bottom:16px; left:calc((100% − var(--reading-side-w,0px))/2); transform:translateX(-50%); width:min(540px, calc(100vw−32px))` —— 精确居中于 640px 白卡中轴。ReadingView 经 ref 在最近 `.reader-root` 写 `data-side-hidden` 与 `--reading-side-w`（:359-375，卸载清除）。
6. **键盘分工**（:377-403 注释「键位切分线」）：ReadingView 只监听 **Esc**（关自己的设置浮层）与 **E**（触发 onOpenXray，仅 xrayIdle）；**Space（播放/暂停）/ J（下一句）/ K（播放暂停）/ L（上一句）/ H 按住 peekAll** 全在 ReaderApp（`ReaderApp.tsx:2096-2129`，仅 reading 视图、非输入态；H 需 maskTranslation 或 spotQuizMode 开）。输入框（挖空/译文编辑/检索）自接管按键，全局让路。

#### 1.1.3 笔记四态（VaultPage）

文件 `src/reader/VaultPage.tsx`；原型 `prototypes/notes-review-redesign-2026-10-26.html`。

**四态定义**：`export type VaultPlayMode = "home" | "notes" | "focus" | "export"`（`VaultPage.tsx:75`）。

**入口映射**（ReaderApp 侧）：
- `goReview()`（复习入口）→ `vaultMode="home"` + `setView("vault")`（`ReaderApp.tsx:1828-1832`）；
- `goNotes()`（笔记库入口）→ `vaultMode="notes"`（:1834-1838）；
- `startFocusReview(ids)`（笔记复盘/章末/结课条/易错项加练）→ 空数组 toast「这篇笔记的词这一轮都通过了，没有要补的」；否则 `focusIds=ids; reviewPos=0; vaultMode="focus"; setView("vault")`（:1807-1819）；
- 导出按钮（stage-head「导出笔记」）→ `onModeChange("export")`（`VaultPage.tsx:456-459`）；
- 导航岛 vault 档 → 不重置 vaultMode（`ReaderApp.tsx:1867-1875`）；离开 vault 视图不重置（跨视图保留）。
- ReaderApp 状态：`vaultMode` 初值 `"home"`（:300-302）；`focusIds: string[] | null`（:273）——非空时复习队列 = 该批词（无视到期），评分即出队（`gradeAndDrainFocus` :1798-1804）；`exitFocus` 置 null（:1822）。

**根布局**（`VaultPage.tsx:202-252`）：`.vault-page data-vault-view={focus?"focus":"wide"}` 三栏 `rail | stage | board`（宽窗 `210px 1fr 320px`，reader.css:8300）；**focus 态 rail/board 与顶栏中岛隐藏、单列居中**。stage 分派：focus→`FocusStage`、export→`ExportStage`、否则 `HomeStage`（内含 home/notes 两档）。

**底部快捷切换器 `.vault-switch`**（:229-249，aria「复习状态快捷切换」）：三档 `复习首页 / 专注复习 / 导出`；active 随档位（`on` 类 + aria-pressed）；focus 态常驻（等效「退出」，**只切档不清 focusIds**，专注队列续跑）。

**home 态**（`HomeStage` :372-532）：
- stage-head（:437-460）：seg 双档「今日复习」/「全部笔记」（`role="tablist"` aria「笔记与复习档位」）+ 动作按钮「导出笔记」（IconDownload）。
- Hero（:466-491）：标题 `今天有 {total} 条要复习`（total>0）或 `今天没有要复习的了`；副行 `预计 {minutes} 分钟 · 都是你最近读到、收藏过的表达` 或 `到期的表达会按记忆曲线回来——明天再来，或去阅读室继续攒新词。`（minutes = max(1, ceil(n*0.6))，:368-370）；形态 chips `填空 / 听音 / 开口`——由 due 队列逐词派生（有原句→听音点亮；原句含目标词→填空点亮；开口恒有词即点亮；:395-409）；CTA 主按钮「开始复习」（IconPlay，total=0 禁用）+ 提示 `按 Enter 也可以开始`（total>0 时）。
- home 态 Enter 快捷键 = 开始复习（typing 守卫 + due 非空，:186-200）。
- 待复习列表（:493-527）：标题行「先自己想一想，点胶带看答案」+ 按钮「全部揭开」/「全部盖住」（互斥，anyPeeled 判定）；空态 `这个筛选下还没有条目。在阅读里查词收藏、或去口语里练几轮，条目会出现在这里。`。
- 列表条目构建 `buildListEntries`（:284-347）：到期词（due 已按 dueAt 排序）+ 口语会话中带 coachDiff 的 user 轮；词原句切 pre/blank/post（findChunkRange 命中）或退回整词；来源标签 `《{title}》` 或「划词收藏」；口语条目日期 `{m}月{d}日`、better = 非 del 片段拼接。
- rail 筛选联合过滤 `filterEntries`（:350-365）：来源（all/article:*/popup/speak）× 类型（all/word/chunk）；**口语条目只挂在 全部×全部**（非词非块，类型筛选时一并隐藏——rail 计数与列表严格一致）；popup = 无 articleId 的词。
- 词条 `VaultWordItem`（:535-624）：`.src`（tag `单词`/`词块` + 来源）；原句行 pre + **胶带 `.memory-tape`**（blank，data-hint=`{释义}（{firstLetters}）`，点击揭开/再贴上，role=button tabIndex=0，title「点击揭开或重新贴上胶带」，Enter/Space 支持）+ post；**防剧透：未揭开时 reveal/译文/释义/评分带一律不渲染**（:585 注释）；揭开后 `.reveal`：原句译文 + `{word} · {pos} {cn}；…` 释义行 + 三档评分带；`.item-actions`：「给点提示」（未揭开时；提示行 `首字母：{firstLetters}（{N} 词）`，不露答案）、「听原句」（有原句读原句，无则读词）、「去口语里用一次」（IconMic → onPracticeVocabSpeak）。
- 口语纠偏条目 `VaultSpeakItem`（:627-688）：tag `口语纠偏` + 日期；`你原本说：{original}` ` → 地道说法：` + coachDiff 渲染（del → 删除线 `.diff-del-span`；ins → **胶带**（data-hint=`新说法（{firstLetters}）`））；揭开后 note 展示；action「听地道说法」；**无评分带**。

**notes 态**（:462-464）：`<div class="vault-notes-embed">{notesPanel}</div>`——NotesView 原样内嵌（ReaderApp 组装 props 喂数据，`ReaderApp.tsx:2301-2324`）；**notes 档无 Hero/胶带列表**。

**focus 态**（`FocusStage` :695-979）：
- focus-top（:867-878）：「退出 Esc」按钮（IconClose + `<kbd>Esc</kbd>`）+ 进度条（width = `(min(pos+1,due.length)/due.length)*100`）+ 计数 `{min(pos+1,max(due.length,1))} / {due.length}`。
- outcome strip（:880-884，role=status）：`上一关：{word} {text}`——评分后 `已按「{档名}」完成`（听写四档带的 easy 回退 GRADE_COPY「很轻松」）、开口命中 `开口命中 · 已按「很轻松」完成并记一次口语表达`、放弃 `跳过（未评分）`。
- 轮转三卡 `CHALLENGE_ROTATION = ["cloze","dictation","speak"]`（:693，按 step 轮转）；原句缺失时完形/听写**降级为开口卡**（:724-750）；听写卡进入即自动朗读一次（word 音轨，:753-759）；换卡重置 input/hints/verdict/replays=3（:716-721）。
- 专注完形卡 `FocusCloze`（:982-1127）：`.q-meta`（tag「填空」+ 来源 `来自《{title}》`/`来自划词收藏`）；26px 衬线大句 `.q-sent` = pre + BlankInput（未答）/ 填空结果（perfect→good/close→warn/trap·wrong→bad 配色）+ post；**两级提示阶梯**（:1032-1059，不显示答案本身）：`提示 1` 整句译文（无译文显示「这篇没有配译文」）/ `提示 2` `首字母与长度：{firstLetters}（{N} 词）`，各带「展开」按钮；判分后 VerdictPanel（close 显示 `你写的：{input}`；trap 显示 `你写了 {input} —— {trap 或 "这是常见的直译错误"}`；答案 `{blank}`（≠词条原形时加 `（词条原形：{word}）`）+ 回原文句链接）+ `.answer-row`：三档评分带（建议档 suggest 高亮）+ 键位提示 `Enter {建议档名}` / `1–3 直选`；未答时「提交」（空输入禁用）/「我不会」+ `Enter 提交` / `Tab 下一级提示`；`.focus-foot`：「提示不会显示答案本身」「提交后选择「记住了 / 模糊 / 没记住」」。
- 听写卡 DictationCard / 开口卡 SpeakChallengeCard **复用 ReviewView 现组件**（:905-949，判分链路零改动）；VerdictPanel 自本 commit 起具名导出（`ReviewView.tsx:740-742`）。
- 完成态（队列空，:951-975）：`{stats.total === 0 ? "生词本还是空的" : "本轮复习完成 🎉"}` + 副行（`在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。` / `这一批都过了。整理成笔记，或回阅读室继续攒新词。`）+ 三按钮「回复习首页」「回阅读室」「整理成笔记」。
- 快捷键（:807-854）：**Esc 退出**（不受 typing 守卫，输入框内也生效）→ `onModeChange("home")`（focusIds 保留在 ReaderApp）；**Tab 下一级提示**（完形未判分且 hints<2，输入框内生效）；**H** 同 Tab（非输入态）；**Enter** 未判分→提交、已判分→采纳建议档；**数字 1/2/3** 直选三档（已判分后）。防重入 `gradedRef`（:706，评分后到队列刷新间隙同一张卡只评一次）；队列耗尽收拢 `onSetPos(0)`（:711-713）。

**export 态**（`ExportStage` :1146-1294）：
- stage-head：「← 返回复习」+ 「复制 Markdown」（成功变「已复制」2.4s）+ 主按钮「保存为 .md」。
- 范围 chips `EXP_SCOPES`（:1133-1137）：`本周（最近 7 天）`（默认）/ `今天` / `全部`——**只在调用侧预过滤** words（addedAt）与 speakSessions（createdAt）（:1160-1176），`buildVaultMarkdown` 纯函数不改。
- 包含 chips `EXP_INCLUDES`（:1139-1144）：`原句 / 释义 / 音标 / 用法提示`，默认 `{ex:true, def:true, ipa:false, note:true}`——**只作用于预览渲染层**，不影响 Markdown 源。
- 预览/源码 seg（:1252-1259）+ `共 {filteredWords.length} 条`；保存失败行 `保存失败：{error}`（:1249）。
- 预览（:1266-1289）：`<h3>{dateKey} 英语精读笔记</h3>` + 每词条 word / `/音标/`（ipa 开）/ 释义 / 原句 `.ex` / `用法：{pattern · trap}`；空态 `这个范围内还没有可导出的词条。`
- 源码：`<pre class="vault-markdown-pre">{markdown}</pre>`。
- 保存：`saveTextFile(\`${dateKey}-学习笔记.md\`, markdown)`（:1195，Tauri 保存对话框）；复制走 `navigator.clipboard`。
- 三档评分带契约（:133-176）：
  - `VAULT_GRADE_BANDS = [{forgot,没记住,f,"1"},{hard,有点模糊,m,"2"},{good,记住了,g,"3"}]`（**easy 建议档收敛为 good**）；
  - 副行 `vaultNextLabel(grade)` 从 `GRADE_INTERVALS` 派生（分钟<60→`{N} 分钟后再来`；天≤1→`明天再看`；否则`{N} 天后再看`；:139-145）→ forgot=`10 分钟后再来`、hard=`明天再看`、good=`3 天后再看`；
  - `vaultSuggested(verdict)`：`verdictToSuggestedGrade` 的 easy → good（:148-151）；
  - GRADE_COPY 四档契约（ReviewView.tsx:111-116）不动：forgot 没想起/10分钟后再来、hard 很勉强/明天再来、good 想起来了/3天后再来、easy 很轻松/7天后再来。

**右侧看板 Board**（:1304-1416，focus 态隐藏）：
- 今日进度卡：conic 进度环 `--p = reviewedToday/(reviewedToday+due.length)*100`（≤100）显示 `{reviewedToday}/{todayTotal}` + `还差 {due.length} 条` + `约 {vaultMinutes(due.length)} 分钟`。
- 掌握阶段卡：三色分段条（s1/s2/s3 占比）+ 图例 `STAGE_LEGEND`（:1298-1302）：`刚收集 / 眼熟（读到能懂） / 能说出口`（masteryStage 口径）+ 各计数。
- 近 28 天卡：热力 28 格（heatBuckets；today 格带 today+l{n}；title `{dayKey} · 复习 {count} 次`）+ 提示行 `出勤 {attended} 天` 或空态 `完成第一轮复习，就会点亮今天。`。
- 易错项靶向加练卡：错题（wrong+trap 合计）最多的前 3 词（`• {word}（错题 {N} 次）`）；空态 `暂无错题记录——保持复习，错题会出现在这里。`；按钮 `1 分钟只练这 {N} 个易错项`（→ onStartFocusReview(弱项 ids) + onModeChange("focus")）+ `去口语里加练 →`。

**左栏 rail（VaultRail，`VocabListPanel.tsx` 导出）**：内容来源组（`内容来源 · 待复习`：全部/各文章《title》/划词收藏/口语纠偏，带计数）× 类型组（`单词`、`词块 / 短语`，toggle 取消）；**rail DOM 不出现任何词面**（防泄答案）；未整理提示 `.rail-note`：`有 {N} 条内容未整理，可能不是词汇（如命令行）。` + 「去处理」→ 复习笔记生成弹窗；加练横幅 `.focus-banner`：`剩 {N}` + 「退出」→ onExitFocus。

#### 1.1.4 书架三列直达（ShelfPage）

文件 `src/reader/ShelfPage.tsx`；原型 `prototypes/mobile-redesign-2026-10-26.html`。

- **onOpenImport(tab?) 升级契约**：`export type ShelfImportTab = "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed"`（`ShelfPage.tsx:35`；ReadingView.tsx:1237 独立同集合声明避免循环依赖）。ReaderApp 侧 `openImport`（`ReaderApp.tsx:376-379`）带**运行时白名单** `IMPORT_OPEN_TABS`（:214-222）：非白名单值（含 onClick 直传的事件对象）回落 `"lib"`；ImportDialog 条件挂载，每次重开以 `importInitialTab` 作 useState 初值（:280-282，`ImportDialog.tsx:113` `useState<TabId>(initialTab ?? "lib")`）。挂点：ShelfPage 三列/导入按钮、FolioSheet（不带 tab）、ReadingView 空态（不带 tab）。
- 页头（:387-415）：`书架` h2 + 分段 seg（`role="tablist"` aria「书架内容切换」）`书 · {books.length}` / `短文 · {articles.length}` + 主按钮「导入」（IconPlus，title「导入阅读内容（内置文库 / 文件 / 链接 / 粘贴）」，缺省调 `onOpenImport()` = 文库 tab）。
- 书 tab（:417-667）：
  - 主卡（最近阅读的书，`sortedBooks[0]`；排序 `lastReadAt desc, createdAt desc` :224-227）：封面（cover dataURL 优先，缺省 EPUB 占位：`EPUB` 小字 + 衬线书名 + 作者；读完盖 `已读完 ✓`）；标题/作者（缺省「未知作者」）；元信息 `{N} 章 · {words} 词 · 约 {fmtDuration(minutes)}`（分钟按 135 wpm 估，:112-114）+ 选书雷达 tag `{goalLabel} · 大纲词 {N}`（radarCount>0，title「选书雷达：该考试目标的大纲词覆盖数」）；进度 `{percent}%` + bar + 状态（`已读完` / `第 {idx+1} / {N} 章` / `尚未开始`）；操作行：主按钮 `继续读 · 第 {idx+1} 章第 {sentence+1} 句`（未开始=`开始阅读`；title `回到第 {x} 章第 {y} 句`/`从第 1 章开始读这本书`）、「目录」、删除 icon（title「移出书架（生词本不受影响）」，confirm 文案见 §1.5）。
  - 其余书紧凑行 `.shelf-minirow`（:509-576）：缩略封面/书名首字母占位 + 书名 + `{N} 章 · {pct}%[ · 第 {x} 章| · 已读完]` + 三 icon（继续读/目录/删除）；整行点击开目录（title「查看目录」）。
  - 无书空卡（:499-507）：「还没有书」+ `导入整本 EPUB：自动分章 · 断点续读 · 生词进复习闭环；也可以先读内置文库的短篇`，点击 `onOpenImport("epub")` 直达。
  - 统计卡 `.shelf-statcard`（:579-639）：今日阅读（conic 环 `{readMin}/{readGoalMin}` 或 `{readMin}′`；文案 `目标已达成`/`还差 {N} 分钟`/`已读 {N} 分钟` + 副行 `明天继续保持`/`达成今日目标`/`可在阅读设置里定每日阅读目标`）；今日复习（`{N} 张到期`/`今日到期已清空`/`今天没有到期生词` + 进度条 + 按钮「开始复习」——**dueNow=0 时禁用**，title 给原因：`今天的到期已清空，明天再来` / `暂无到期生词。先在阅读里查词收藏，明天会出现在这里`）；连续天数（streak>0：flame + `连续阅读 {N} 天`；否则 `读满 {streakGoalMin} 分钟，开启你的连续阅读`，streakGoalMin = goalOn ? readGoalMin : 10）。
  - **发现三列 `.shelf-disc`**（:642-666，节标题「发现更多可读内容」）：
    | 列 | 图标 | 标题 | 副文案 | 直达 tab |
    |---|---|---|---|---|
    | 1 | IconBookOpen | `精选经典` | `按难度和考纲词表挑选公版名著与短篇` | `discover` |
    | 2 | IconRss | `英文资讯订阅` | `订阅常用新闻源，每天自动收到可读短文` | `feed` |
    | 3 | IconPlus | `导入自己的内容` | `网址、文件或粘贴文本，自动拆句并翻译` | `lib` |
- 短文 tab（:668-754）：空卡（「添加一篇短文」+ `内置文库 · 网页链接 · Word / PDF · 粘贴文本`，点击 `onOpenImport()`）；工具行：搜索（placeholder「搜索标题」，aria「搜索短文标题」，清空按钮；匹配 title 或 titleCn，不区分大小写）+ 筛选 chips `全部/未读完/已读完`（percent<100 / ≥100）+ 排序标签 `排序：最近阅读`（唯一排序口径，lastReadAt desc）；分组 `继续阅读 · {N}` 在前 `已读完 · {N}` 在后；**同 sourceUrl 重复内容合并**：保留最近读的一条，其余隐藏，组尾提示 `已合并 {N} 条重复内容` + 「撤销」（unmergedUrls 集合，按分组一次展开）；行 `.shelf-item`：进度环（done 加 ✓）+ 标题 + `译名 · 来源` 合并行 + 元信息（level / `约 {fmtDuration}` / `{goalLabel}词 {N}`，title `{goalLabel}大纲词命中 {N} 个`）+ more 菜单（竖三点，role=menu，唯一项「删除这篇短文」带 confirm）；无结果 `没有匹配「{q}」的短文` / `这个筛选下暂无短文`。
- 来源落款 `sourceLabel`（:122-153）：书章 epub → `来自《{书名}》第 {N} 章`（书已删回落日期落款）；sourceUrl → `网页 · {host}`（去 www.）；否则按类型 + ` {m} 月 {d} 日`：url→`网页`、paste→`粘贴文本`、pdf→`本地 PDF`、docx→`本地 Word`、default→`导入于`。
- 书架页短文覆盖懒算：进 shelf 视图才拉全文 sourceCache，`coverageForText` 按考试目标（localStorage `intake-exam-goal`，合法值 kaoyan/cet4/cet6，缺省 kaoyan；`ReaderApp.tsx:2216-2219`）。

### 1.2 UI 状态与用户可见文案（原样抄录索引）

以上各节已按交互流内嵌抄录全部用户可见文案（含 title/aria-label/placeholder/confirm/toast）。抄录来源：`ReaderTopBar.tsx`、`ReadingView.tsx`、`VaultPage.tsx`、`ShelfPage.tsx`、`ReaderApp.tsx`（toast 与结课/章末卡）、`ReviewView.tsx` GRADE_COPY。另补 ReaderApp 侧与本改版直接相关的常驻文案：

- 短文结课条（`ReaderApp.tsx:2573-2615`）：`本篇读完 🎉 收录 {N} 个词块和生词[，其中 {M} 个待复习]` + 按钮 `整理本篇复习笔记`（title「把这批词预选进复习笔记生成弹窗」）/ `复习本篇 {N} 词`（title「只复习本篇已到期的词，不打乱其他词的复习计划」）/ `继续阅读`。
- 章末小结卡（:2699-2781）：`🎉` badge + `第 {N} 章读完` + `《{书名}》 · {n}/{m} 章` + `查词 {N} 次 · 本章收录 {N} 词 · 本章用时 {N} 分钟` + `下一章：{title}` / `全书读完，恭喜！这些生词都已在复习闭环里了。` + `整理本章笔记` / `复习本章 {N} 词` / `留在本章` / `开始下一章`。
- 带入句 toast：`已带入第 {N} 句进入口语对话` / `已带入本章进入口语对话`（:1850,:1861）。

### 1.3 数据结构与本地存储

- **共享 schema**：`contracts/reading-room.schema.json` v1（README 确认为 Windows 运行时格式，Mac 实现时**直接采用此 schema**）。TS 侧 `src/core/readerTypes.ts` 与 Rust 侧 `src-tauri/src/reader_store.rs` 双侧同构（readerTypes.ts:1-8）。
- 关键结构（readerTypes.ts）：`SentencePair`(:54-68：idx/paragraphIdx/en/zh/zhState/revealed?/chunks?/zhError?)；`Article`(:80-104：titleCn/titleCnState/level/wordCount/progress{sentenceIdx,percent,secondsListened}/sentences/chunkState/settings 覆盖/bookId/chapterIdx)；`VocabWord`(:132-158：id 归一化键/kind word|chunk/senses/source/srs{ease,intervalDays,reps,dueAt,lapses}/addedAt/example?/recall?/spokenAt?)；`ReaderSettings`(:246-297)——改版相关新字段：`spotlightMode?`（默认 false）、`spreadLayout?: "prose"|"parallel"`（默认 prose）、`spotQuizMode?`（默认 false）(:291-296)；`DEFAULT_READER_SETTINGS`(:299-328)；字号界限 14–24(:353-354)；`BookMeta/BookChapterMeta/BookProgress`(:451-485)；`NoteMeta/NoteReplay`(:177-197)。
- **本地存储布局**（reader_store.rs:3-5,:213-214）：`app_data_dir/reader_articles.json`（短文）、`reader_vocab.json`（生词 + 复习日志 + 每日阅读时长）、`reader_books.json`（书索引）、`books/<bookId>.json`（章正文）、`notes/`（Markdown + JSON frontmatter，reader_store.rs:1777-1815）。顶层均带 `schemaVersion: 1`。
- 访问命令（`src/lib/readerStore.ts:36-176`，Tauri invoke）：`reader_list_articles / reader_get_article / reader_save_article / reader_delete_article / reader_get_vocab / reader_save_vocab_word / reader_grade_vocab / reader_merge_vocab_words / reader_record_review / reader_stats / reader_record_recall / note_save / note_list / note_read / note_write_replay / note_delete / reader_list_books / reader_save_book / reader_save_book_meta / reader_delete_book / reader_last_book_progress / reader_record_reading / reader_read_seconds_today`。其中 `readerGradeVocab`（:60-71）走 v2 事件模型：`learning_commit_review` 原子提交词快照 + 不可变 ReviewEvent（learning-core reducer）。
- 评分落盘链（本改版语义零改动，`VaultPage.tsx:21-25` 注释）：`onGrade → gradeVocab → readerSaveVocabWord + readerRecordReview`；`onRecall → recallBucket → readerRecordRecall` 错题分桶。

### 1.4 网络端点与请求/响应契约

- **本改版（1c5205d）零网络改动**（commit diff 仅 `src/reader/**` 16 个文件）。阅读室为本地优先：文章/生词/笔记/会话全部本地存储。
- 涉及的三条既有网络链路（移植时保持不动）：
  1. **LLM 翻译**：用户自配 endpoint（`translateStream`，`ReaderApp.tsx:631-682`；段级流式 + 429 退避 + 手改译文）。
  2. **学习同步（learning-relay v2）**：经 Rust `learning_*` 命令与 `packages/learning-core`；协议见 `contracts/learning-relay-v2.md`——登录后读 `/v1/me/config` 的 `sync` 协商；集合 `reading-articles`（v2：book/article/content-chunk/progress 载荷）、`reading-vocab`（baseline/baselineRecall/generation）、`review-events`（不可变事件，`{v:2,id,wordId,deviceId,reviewedAt,kind:"grade"|"undo",mode,generation,grade,recall?,supersedesEventId?,reversesEventId?,day?}`）、`notes`、`speak-sessions`（v2 practice-task）。四档间隔 forgot 10 分钟 / hard 1 天 / good 3 天 / easy 7 天。vault 手账/导出消费的 `speakListSessions` 本地读取（SpeakStore），同步失败静默。
  3. **资讯订阅抓取**（feed tab 数据源，B3 领域）：`reader_fetch_feed` Rust 命令——**不在本改版范围**。
- `immersive-translator-server/` 目录在仓库不存在（已核实），服务端路由无法从本仓库取证；同步协议以 `contracts/learning-relay-v2.md` 为准。

### 1.5 边界与错误处理

- **onOpenImport 白名单**：onClick 直传函数时第一个参数是事件对象，必须被拦下（否则 ImportDialog 七个 tab 全不命中、弹窗只剩头和 tab 条——2026-10-26 回归，`ReadingView.tsx:1240-1245` 注释；`ReaderApp.tsx:373-379`）。
- 翻译/标注 chip 中途切文必须清掉再退出（`ReaderApp.tsx:898-903,:940-944` B1 修复）。
- 浮层定位兜底：jsdom / 元素不可见（如仅中文模式句已隐藏）时 `getClientRects()` 无 rect 直接 return，不写脏值（`ReadingView.tsx:308`）。
- 滚动跟随：播放或跟读等待时视口回写不采纳（`ReaderApp.tsx:2458-2462`）；rAF 节流；视口句 = 视口上 1/3 高度处的那句（`ReadingView.tsx:262-272`）。
- 换文复位：续读胶囊（:168）、xray/hoveredClause/lensMode/检索定位/chapterEnd/finishCard（`ReaderApp.tsx:1202-1210`）。
- E 键仅解析面板 idle 态（无 loading/ready/error 记录且无请求在途，`ReaderApp.tsx:2481-2486`）；已解析句按 E 不重复发请求。
- focus 队列耗尽收拢 pos=0（`VaultPage.tsx:711-713`）；gradedRef 防重入（:706）；Esc 退出只切档不清 focusIds（:816-820）。
- home Enter 在 due=0 / 输入态不触发（:186-200）；开始复习按钮同条件禁用。
- rail 防剧透：rail DOM 无词面；未揭开条目不渲染译文/释义/评分带；提示不显示答案本身（首字母截断 `firstLetters`）。
- 导出保存失败：`保存失败：{error}` 就地展示（:1249）；复制失败回落未复制态（:1183-1191）。
- 删除确认文案（window.confirm）：书 `删除《{title}》？将删除全部 {N} 章内容与这本书的阅读进度，不可恢复；生词本不受影响。`（`ShelfPage.tsx:169-174`）；短文 `删除《{title}》？这篇短文将从书架移除；生词本不受影响。`（:369）；笔记 `删除这篇笔记？删除后不可恢复。`（`ReaderApp.tsx:1925`）。
- 专注模式副作用：在最近 `.reader-root` 写 `data-side-hidden` + `--reading-side-w:0px`，**卸载/关闭时必须清除**（避免脏值带到其他视图，`ReadingView.tsx:359-375`）。
- 遮罩 revealed 持久化随文章；手改译文 `zhState="edited"` 且 `revealed=true`（`ReaderApp.tsx:1031-1042`）。
- 账号切换清空阅读室状态（article/list/books/vocab/notes/sessions 全清，路由回 shelf；speak 视图时保留，`ReaderApp.tsx:1899`）。

### 1.6 相关 Windows 单测及其行为向量

**已运行**：`cd immersive-translator-windows && npx vitest run src/reader/VaultPage.test.tsx src/reader/ReadingView.cloze.test.tsx src/reader/ReviewView.render.test.tsx src/reader/DictColumn.test.tsx` → **4 文件 48 例全部通过**（2026-11-01 执行）。

1. **`VaultPage.test.tsx`（27 例，改版主战场）** 行为向量（describe → 关键断言）：
   - 三态入口与 Hero：stage-head seg = `["今日复习","全部笔记"]`；「导出笔记」→ `onModeChange("export")`、「全部笔记」→ `"notes"`；Hero 文案 `今天有 1 条要复习` / `预计 1 分钟` / `按 Enter 也可以开始`；「开始复习」click 与 Enter 键均 → `"focus"`；due=0 时按钮 disabled、文案 `今天没有要复习的了`、Enter 不触发；notes 档内嵌 notesPanel 且无 `.vault-hero`；export 档「← 返回复习」→ home；底部切换器 = `["复习首页","专注复习","导出"]`，active 随档位。
   - 胶带列表：点击揭开/再点盖上（`.peeled` 类）；全部揭开→全部盖住；**反剧透**：未揭开时 `.reveal`/`.grade-chip`/译文文本不在 DOM；揭开后 `unwind · v. 放松` + 3 个评分 chip。
   - 三档评分映射：chips 文案 `["没记住10分钟后再来","有点模糊明天再看","记住了3天后再看"]`；点击顺序 good→forgot→hard 逐字透传 `onGrade`；`VAULT_GRADE_BANDS` 名称/档位契约；`vaultNextLabel("good")` 含 `3 天`。
   - 提示：`首字母：u…（1 词）` 且不含答案；无原句「听原句」回退 `onSpeakWord("unwind")`；「去口语里用一次」走 vocab 通道。
   - 口语纠偏条目：原话 + diff（del 删除线、ins×2 胶带）、无 `.grades` 评分带、「听地道说法」。
   - rail：`内容来源 · 待复习`；计数 `全部3/《TestChapter》2/划词收藏0/口语纠偏1/单词1/词块/短语1`（全部 = 到期词 + 口语轮）；**rail innerHTML 不含词面**（`>unwind<`、`take root`）；类型筛选「词块 / 短语」只剩词块条目、口语条目隐藏；再点取消回全集；「口语纠偏」来源筛选列表只剩口语条目且计数含历史轮；rail-note `有 1 条内容未整理，可能不是词汇（如命令行）。` + 「去处理」开弹窗；加练横幅 `剩 2` + 退出。
   - focus：原句缺失词第一关落开口卡（录音→转写→命中 → `onSpokenGrade(word,"easy")` 且 `onGrade` 不被调、文案「开口命中」）；放弃这题不评分、`onSetPos(0)` 绕回队首、outcome `跳过（未评分）`、Esc → `onModeChange("home")`；完形卡输入 Enter 提交 → verdict `一次写对`、建议档「记住了」+`3 天`、全局 Enter 采纳 → `onGrade(word,"good")`（**不是 easy**）+ `onRecall("unwind","cloze","perfect","good")` + outcome `已按「记住了」完成`；「我不会」→ verdict `没想起来`、建议「没记住」、数字 2 → hard；提示阶梯 Tab 两级（提示1 = 整句译文、提示2 = `首字母与长度` `u…` `1 词` 且不含答案）。
   - 看板：环 `2/3`（reviewedToday/(reviewedToday+due.length)）+ `还差 1 条` + `约 1 分钟`；三阶图例 `["刚收集1","眼熟（读到能懂）1","能说出口1"]`；热力 28 格、today 格 today+l1、`出勤` 文案 / 空态 `完成第一轮复习，就会点亮今天。`；易错项 `take root`+`错题 2 次`、`1 分钟只练这 1 个易错项` → `onStartFocusReview(["take root"])` + `onModeChange("focus")`、`去口语里加练`。
   - 导出：默认本周（含今天词、排久远词）`共 1 条`；「全部」→ 2、「今天」→ 1；源码态随范围过滤（含 volunteers 不含 unwind）；预览 h3 含 `英语精读笔记`、音标缺省不含/开启含 `vɒlənˈtɪəz`、原句缺省含；保存文件名匹配 `/-学习笔记\.md$/`、内容含 `## 一、核心词块`（三段结构）且随范围过滤。
2. **`ReadingView.cloze.test.tsx`（9 例）**：随读抽查——开关只挖已读句（watermark）、Enter 本地判分（命中/陷阱）、印章与错答删除线、onClozeVerdict 接线（known 槽联动）、开关关闭零残留、按住 H 显影（peeked）。
3. **`ReviewView.render.test.tsx`（6 例，SSR 冒烟）**：三练习形态 + 空态可渲染；GRADE_COPY/gradeAsk 契约。
4. **`DictColumn.test.tsx`（6 例）**：透镜卡双 Tab/句码/关闭等（改版仅 12 行适配）。
5. commit 声明全量 `vitest 931 例全过 + tsc/vite 构建过`（commit message；本次勘察未重跑全量）。

---

## 2. Mac 落点设计

### 2.1 现状复核结论（与任务书锚点核对）

| 任务书锚点 | 复核结果 |
|---|---|
| `Sources/ImmersiveTranslator/ReaderViews.swift:167 ReaderTopStageView 毛玻璃导航岛` | ✅ 结构体声明在 **:172**（:167 是 MARK 注释行）；现实现为**旧式三胶囊**（brandPill :209 / navIsland :239 / rightIsland :265），非 Windows 新三段外壳 |
| `:889 ShelfHomeView` | ✅ 准确（`struct ShelfHomeView: View`） |
| `:992 自适应网格` | ✅ `LazyVGrid(columns: [GridItem(.adaptive(minimum: 330, maximum: 540), spacing: 16)])` 在 :991-992 |
| `Sources/ImmersiveTranslator/ReaderNotesView.swift 无四态` | ✅ 该文件是笔记库阅览视图（左栏目录 :28 + 一页纸 :220 + AI 复盘 :549），**无 home/notes/focus/export 概念** |

其余关键差距（均有行号证据）：
- Mac `VaultPlayMode` 仍是旧三态 `tape/challenge/md`（`ReaderViewModel.swift:86-98`），`openReview→challenge`（:1873-1879）、`openNotes→md`（:1978-1984）、`startFocusReview→challenge`（:1964-1976）——对应 Windows 已改 home/notes/focus/export。
- Mac Route 仍含 `review/notes` 两值（`ReaderViewModel.swift:63-68`），Windows 已并为单一 `vault`。
- Mac 阅读页是改版前形态：书脊列 `EditorialSpineColumn`（ReaderViews.swift:1497，Windows 已 deprecated 改 `.reading-rail`）、行间折叠卡 `InterlinearFoldCard`（:2411，Windows 已改 `.translation-pop` 浮层）、遮罩条 `MaskBarView`（:1720）与刊头内联开关 `ArticleHeader`（:1764-1872，Windows 已收口 `.reading-toolbar` + `.reading-head`）。
- Mac 书架无发现三列（ShelfHomeView 只有 书/短文 tab + ShelfTodayCard）；导入无直达 tab 参数（`ReaderIntakeSheet.swift:23` `@State private var tab: IntakeTab = .lib` 固定初值，无外部注入）；IntakeTab 只有 `lib/epub/file/url/paste`（:26-31），**无 discover/feed**。
- Mac `ReaderSettings`（`Sources/ReaderCore/ReaderSettings.swift:488-545`）已有 `spotlightMode`(:534)/`spreadLayout`(:537) 及生效值派生（:540-543），**缺 `spotQuizMode`**（全源码 grep 无 spotQuiz/ClozeSlot 命中——随读抽查整条链路缺失）。
- 复用基础齐备：`masteryStage/heatBuckets`（ReaderCore/ReaderSrs.swift:284,:354）、`buildVaultMarkdown`（ReaderCore/VaultExport.swift:113，三段结构「一、核心词块」:123）、grade 间隔定值（ReaderSrs.swift:38）、`SpeakStore.listSessions`（SpeakStore.swift:53）、`ReaderPlaybackEngine`（:19，toggle/jumpTo/stop/playing/shadowingWait :46-137）。

### 2.2 应新建/修改的 Mac 文件清单

**修改（6 个）**

1. `Sources/ImmersiveTranslator/ReaderViewModel.swift`
   - `VaultPlayMode` 改四值 `home/notes/focus/export`（现 :86-98），label 对齐 Windows（home=「复习首页」等底部切换器文案）；`vaultPlayMode` 默认 `.home`（现 :205 默认 `.tape`）。
   - Route：将 `.review/.notes` 合并为 `.vault`（对齐 `ReaderApp.tsx:155`；旧入口 `openReview/openNotes/startFocusReview` 保留函数名，落位改 `vaultMode = .home/.notes/.focus`，:1873-1879/:1964-1976/:1978-1984）；对外 bootstrap（托盘/菜单）调用点同步。
   - 新增 `openImport(tab:)`：带白名单的 tab 注入（对齐 `ReaderApp.tsx:376-379` + `IMPORT_OPEN_TABS` :214-222），驱动 ReaderImportSheet 初值；`importSheetShown`（:222）不变。
   - `unnotedWordCount`（:2006）已有，vault 档角标继续 `vaultBadgeCount`（:1921）。
2. `Sources/ImmersiveTranslator/ReaderViews.swift`
   - **ReaderTopStageView（:172-317）重构为三段外壳**：单条顶栏 grid `1fr auto 1fr` 语义（SwiftUI：HStack{ brand; Spacer; tabs; Spacer; tools } 或 Grid），保留交通灯让位 `.padding(.leading, 78)`（:193 现有 M-01 规则）；三段容器视觉 = 平面白胶囊（folio 皮肤，对齐 reader.css:9344-9352：`var(--surface)` 底、无边框投影、无 blur——非 folio 视图保留毛玻璃三胶囊语义则按 Windows 9290-9302 全局规则）；中岛在 vault+focus 隐藏（focusMode，`ReaderApp.tsx:2368`）。
   - **ReadingStageView（:1457-1557）白卡重构**：删书脊列分支 → 新 `ReadingRailView`（railPct/track/label 三件套，口径 :484）；`ReaderScroll`（:1569）内加 `.reading-col` 640pt 居中约束与续读胶囊；`InterlinearFoldCard`（:2411）→ 新 `TranslationPopView` 浮层（锚定当前句末行下方——SwiftUI 用 anchor preference/GeometryReader 拿句末行 frame，top = 末行 bottom − col top + 10，clamp 同 Windows :298-318）；`MaskBarView`（:1720）+ `ArticleHeader`（:1764）控件收口进 `ReadingToolbarView`（meta/遮罩开关+计数/全部揭开遮住/目录 chip/设置 chip + 设置浮层）与 32pt 刊头。
   - **ShelfHomeView（:889-1044）**：书 tab 底部新增发现三列 `.shelf-disc`（三卡文案照抄 §1.1.4 表格；点击 `vm.openImport(tab: "discover"/"feed"/"lib")`）；页头分段带数量（`书 · N`/`短文 · M`）；无书空卡直达 `epub` tab。
   - dock 居中契约：`ReaderRootView` 的 PlayBarView overlay（:61-69）改为以正文列中轴居中（rightLens 占位 340pt（:855）对应 Windows `--reading-side-w`；专注/窄窗置 0）。
3. `Sources/ImmersiveTranslator/ReaderVaultView.swift` — 按 §1.1.3 重构为四态：三栏 rail|stage|board（focus 单列）；HomeStage（Hero/胶带列表/口语纠偏条目）、FocusStage（轮转三卡 + FocusCloze 提示阶梯）、ExportStage（范围/包含 chips + 预览/源码 + 复制/保存）、底部快捷切换器；三档评分带常量 `vaultGradeBands` + `vaultNextLabel`（从 ReaderSrs 间隔派生）+ `vaultSuggested`（easy→good）。现有 tape 手账（:280-536）可作胶带视觉基础，challenge 队列机制（:19-34）作 focus 基础。
4. `Sources/ImmersiveTranslator/ReaderIntakeSheet.swift` — `tab` 改由外部注入（`var initialTab: IntakeTab`，对齐 `ImportDialog.tsx:64,:113`）；discover/feed 两 tab **依赖 B3 订阅领域**（Mac 现无 feedStore/发现书库，已核实），本规格先落参数与白名单，tab 内容未实现前列渲染照抄、点击进缺省文库（见 §4 风险）。
5. `Sources/ReaderCore/ReaderSettings.swift` — 增 `spotQuizMode: Bool?`（可选免迁移，对齐 spotlightMode :534 写法与 schema 缺省 false）+ `spotQuizEnabled` 生效值派生（对齐 :540-543 模式）。
6. `Sources/ImmersiveTranslator/ReaderSettingsDrawer`（ReaderViews.swift:3117 起）— 若随读抽查开关需在抽屉露出（Windows 在阅读设置浮层，Mac 对应位置随浮层实现）。

**新建（视图/组件，随上述文件落位；独立文件建议）**

- `ReaderViews.swift` 内新增（或拆分新文件）：`ReadingRailView`、`ReadingToolbarView`、`ReadingSettingsPopover`、`TranslationPopView`、`ResumeCapsuleView`、`ShelfDiscCard`、`VaultGradeBandRow`、`VaultHeroView`、`VaultWordItemRow`、`VaultSpeakItemRow`、`VaultFocusClozeCard`、`VaultExportStage`、`VaultBoardView`、`VaultSwitchBar`。

### 2.3 与 Mac 既有架构的衔接

- **ReaderSettings**（ReaderCore）：设置读写走 `ReaderStore.loadGlobalReaderSettings/saveGlobalReaderSettings`（ReaderStore.swift:391-400）；文章覆盖合并沿用 `effectiveSettings`（ReaderViewModel 现有）；新字段 spotQuizMode 走可选解码免迁移（同 spotlightMode 先例，schema 缺省）。
- **ReaderPlaybackEngine**（ReaderPlaybackEngine.swift:19）：`playing/activeIdx/shadowingWait/toggle/jumpTo/stop` 语义与 Windows usePlayback 对齐；进度轨 railPct 用 `activeIdx`（vm.activeSentenceIdx，ReaderRootView:116 已观察）；句旁「朗读本句」= `jumpTo(idx, autoplay: true, once: true)`。
- **SpeakStore**（SpeakStore.swift:7,:53）：vault 口语纠偏条目与导出数据源 `listSessions()`（Windows `speakListSessions` 对应；进 vault 视图拉取，`ReaderViewModel.swift:1984` openNotes 已有 refreshSpeakSessions 先例）。
- **ServerAuth**（ServerAuth.swift:96-123）：学习同步登录态与 baseURL 两层机制——vault/书架本改版不新增网络调用；同步沿用现有静默链（失败静默）。
- **Settings.swift / ReaderStore.swift**：本地 JSON 存储布局已与 Windows 同构（ReaderStore.swift:7-16：`~/Library/Application Support/ImmersiveTranslator/` 下同名文件 + schemaVersion 校验 :95/:285），**零存储改动**。
- **ReaderPalette/ReaderThemeTokens**（ReaderTheme.swift）：folio 皮肤按 Windows 令牌矩阵扩值——圆角四级 8/12/18/999、`--font-en` 衬线（Mac 回落 New York/Georgia）、品牌绿 `#1f6b57`（accent）/#185646（hover）/#e3f0ea（soft）/#b9d8cc（line）**仅 light+folio 作用域**；sepia/dark/oled 原主题令牌不覆盖（reader.css:9262-9276 作用域铁律）；测试对账模式参考 ReaderShellChromeTests 的 assertColor（:22-28）。
- **ReaderMotion**：档位切换 200ms 弹性/减弱动态退化（ReaderBodyView :830-879 现有 REVIEW-04 模式）继续适用四态切换。
- **键盘链**：`vm.handleKeyDown`（ReaderShellChromeTests.swift:12 注释的 Esc 分层链）扩四态键位——home Enter、focus Esc/Tab/H/Enter/1-3、reading E（仅 xray idle）；输入焦点守卫沿用 useEscapeClose 语义。

### 2.4 需补的 Swift 测试清单（与 Windows 单测行为向量对齐）

落 `Tests/ImmersiveTranslatorTests/`（应用层，参考 ReaderShellChromeTests 模式）与 `Tests/ReaderCoreTests/`（纯逻辑）：

1. `ReaderVaultFourStateTests.swift`：四态枚举与入口映射（openReview→home、openNotes→notes、startFocusReview→focus、导出→export；导航岛进入不重置档位；Esc 只切档不清 focusReviewIds）；底部切换器三档文案与 active。
2. `VaultGradeBandsTests.swift`（ReaderCoreTests）：三档映射（没记住/forgot/1、有点模糊/hard/2、记住了/good/3）；`vaultNextLabel` 从间隔定值派生（10 分钟后再来/明天再看/3 天后再看）；`vaultSuggested` easy→good；GRADE_COPY 四档契约不动。
3. `VaultListEntriesTests.swift`（ReaderCoreTests）：buildListEntries/filterEntries 向量——口语条目只在 全部×全部、popup/article 过滤、类型过滤；rail 计数口径；条目文本不含未揭开词面（反剧透数据层）。
4. `VaultFocusFlowTests.swift`：轮转顺序 cloze→dictation→speak；原句缺失降级开口卡；判分→建议档→Enter 采纳（easy 收敛 good）；我不会→wrong；放弃不评分且 pos 绕回；队列耗尽 pos=0；开口命中 onSpokenGrade(easy)。
5. `VaultExportScopeTests.swift`（扩展 ReaderCoreTests/VaultExportTests.swift）：范围预过滤（week/today/all 对 addedAt/createdAt）；文件名 `{dayKey}-学习笔记.md`；Markdown 含 `## 一、核心词块` 三段结构；包含 chips 只作用预览层。
6. `ShelfDiscDirectAccessTests.swift`：`openImport(tab:)` 白名单（非法值/事件对象等效输入回落 lib）；三列 tab 参数 discover/feed/lib 逐值断言。
7. `ReadingRailTests.swift`：railPct 口径 `max(1, round((activeIdx+1)/total*100))`；total=0 → 0；label 书章 CHAPTER N/短文 title。
8. `ReaderSettingsSpotQuizTests.swift`（扩展 ReaderSettingsEdgeTests.swift）：spotQuizMode 可选解码缺省 false；override 合并逐字段。
9. Shell 对账（扩展 ReaderShellChromeTests）：三段外壳在 folio/非 folio 视图的容器视觉令牌对账（如平面白胶囊 vs 毛玻璃）；focus 态中岛隐藏。

---

## 3. 逐条验收清单

1. 顶栏为三段外壳（左 monogram+书架触发、中三档 tab、右检索/主题/设置），grid 1fr auto 1fr 语义；Mac 保留交通灯 ~78pt 让位。
2. 外壳文案逐字一致：「回到书架」「打开书架浮层（切换书 / 短文，继续读）」「书架 · {书名}」「阅读」「口语」「笔记与复习」「生词复习与笔记都在这一档」「在本文中检索…」「全文检索（Enter 跳转，Esc 关闭）」「主题：{纸书|深色|护眼|纯黑}（点击切换）」「阅读设置」「在本文中检索」。
3. vault 档角标 = dueNow + unnotedCount，>0 才显示；数字实时随收藏/复习变化。
4. 主题循环顺序 light→dark→sepia→oled 循环，四主题切换不闪白（Mac 换肤动画沿 ReaderMotion.skin）。
5. 检索：Enter 跳首个命中句并 toast「在第 {N} 句找到「{q}」」；无命中 toast「本文没有包含「{q}」的句子」；Esc 关闭清空。
6. 视图路由四值 shelf/reading/speak/vault；review/notes 旧路由移除（或映射后无新增入口）；启动默认整页书架；folio 皮肤（平面白胶囊）仅 shelf/reading 挂。
7. 书架是首页：monogram「I」与各「回到书架」入口都回 shelf。
8. 阅读页结构 = 工具栏收口 + 左缘进度轨 + 640px 居中正文列 + 译文浮层 + 底部居中 dock；工具栏含 meta（书·章·词数·分钟·level·翻译/标注 chip）、遮罩开关+计数、抽查战绩、目录 chip、阅读设置 chip。
9. 阅读设置浮层七项：排版（段落/对照）、句卡、字号 14–24 步进、短语虚线、专注模式、随读抽查、主题只读；文案与 title 逐字一致。
10. 进度轨：`{pct}%` 数字 + 竖轨填充 + label（CHAPTER N / 文章标题）；口径 = 光标句/总句（与 dock 同源）；顶部墨线仍受「显示阅读进度」开关控制。
11. 续读胶囊：`上次读到 第 {N} 句` + 「回到那里」+ 关闭（title「只是隐藏提示，断点仍在」）；换文复位；翻译中不显示。
12. 刊头：eyebrow `CHAPTER {N} · {书名大写}`、32px 标题、中文副题三态（titleCn/失败+重试/骨架）、「围绕本章练口语」按钮（仅书章）。
13. 译文浮层锚定当前句末行下方（不拆段落、脱离文档流）；veil「点击显示译文」→ 译文（点按回遮）→ 操作行「朗读本句」「用这句练口语」「编辑译文」+ 遮罩开时「按住 H 看译文」；失败行「本段翻译失败 {原因} 重试本段」；编辑器 tip「Ctrl+Enter 保存 · Esc 取消」（Mac 显示 Cmd+Enter，见 §4）。
14. 正文 prose/parallel 双排版可切；prose 段落英文流 + 首段首字母下沉；parallel 双栏对照；句点击定位、点词查词、划选查短语、词块虚线点击开即时卡。
15. 随读抽查整链：开关落 ReaderSettings（spotQuizMode，可选免迁移）；只挖已读句（watermark）；行内输入 Enter 本地判分；? 首字母提示（命中降档接近）；印章四档文案 命中/接近/陷阱/未中；toast 三文案；开关关闭正文零残留；按住 H 显影。
16. 读完动作：到末句出「读完本篇/读完本章」按钮 + hint 文案；确认后弹结课条/章末卡（文案 §1.2）；播放中不显示。
17. vault 四态 home/notes/focus/export；入口映射 goReview→home、goNotes→notes、startFocusReview→focus、导出按钮→export；导航岛/底部切换器切档不清 focusIds。
18. home：seg「今日复习/全部笔记」+「导出笔记」；Hero 标题/副行/形态 chips/开始复习（due=0 禁用）/「按 Enter 也可以开始」；Enter 快捷键同条件；列表「先自己想一想，点胶带看答案」+ 全部揭开/全部盖住；空态文案逐字。
19. 胶带防剧透：未揭开时译文/释义/评分带不在渲染树；揭开后备齐（译文 + `word · 释义` + 三档带）；提示 `首字母：{x}…（{N} 词）` 不露答案。
20. 三档评分带：名称/档位/快捷键/副行四组文案逐字（没记住 10 分钟后再来 / 有点模糊 明天再看 / 记住了 3 天后再看）；easy 建议收敛 good；听写卡四档带 easy 用 GRADE_COPY「很轻松」。
21. 口语纠偏条目：tag「口语纠偏」+ 日期 + 「你原本说：… → 地道说法：」diff（del 删除线/ins 胶带）+「听地道说法」；无评分带。
22. focus：退出 Esc + 进度条 + n/m；outcome strip 三文案；轮转 cloze→dictation→speak、原句缺失降级开口；FocusCloze 26px 大句 + 两级提示阶梯（提示1 整句译文/提示2 首字母与长度，均不露答案）+ 我不会 + VerdictPanel（close/trap 补充行 + 词条原形注）+ 键位 Enter/Tab/H/1-3；完成态三文案 + 三按钮。
23. rail：来源×类型联合过滤（口语条目仅 全部×全部）、计数与列表严格一致、DOM 无词面、未整理提示 + 「去处理」、加练横幅「剩 N」+ 退出。
24. export：← 返回复习；范围 chips 本周（默认）/今天/全部只做调用侧预过滤；包含 chips 原句/释义/音标（默认关）/用法提示只作用预览；预览/源码 seg + 共 N 条；复制（已复制 2.4s）；保存 `{dayKey}-学习笔记.md`（NSSavePanel）；失败行「保存失败：{error}」；Markdown 三段结构不变。
25. board：今日进度环 reviewedToday/(reviewedToday+due) + 还差 N 条 + 约 X 分钟（max(1, ceil(n*0.6))）；三阶图例 刚收集/眼熟（读到能懂）/能说出口；近 28 天热力 + 出勤文案/空态点亮提示；易错项 top3 + 「1 分钟只练这 N 个易错项」+「去口语里加练 →」；focus 态隐藏。
26. 书架页头：`书架` + 分段 `书 · N`/`短文 · M` + 「导入」按钮（title 逐字）；书 tab 主卡/迷你行/统计卡文案逐字（§1.1.4）；「开始复习」dueNow=0 禁用且 title 给原因。
27. 发现三列三卡标题+副文案逐字（精选经典/英文资讯订阅/导入自己的内容），点击分别以 discover/feed/lib 直达导入弹窗对应 tab；无书空卡直达 epub；短文空卡缺省 lib。
28. onOpenImport(tab:) 白名单：非法值（含事件对象等效输入）回落 lib；每次重开弹窗以注入 tab 为初值。
29. 短文 tab：搜索（标题+译名）/筛选 全部·未读完·已读完/排序 最近阅读；分组 继续阅读·N / 已读完·N；sourceUrl 合并 + 已合并 N 条重复内容 + 撤销；行内进度环+✓、译名 · 来源、more 菜单删除 confirm 文案逐字；来源落款规则五分支逐字。
30. 删除确认三文案（书/短文/笔记）逐字；删除书=章文章+进度全删生词保留。
31. 存储零改动：文件名/schemaVersion 1/字段与 contracts/reading-room.schema.json 一致；spotQuizMode 为可选新增字段，旧 JSON 免迁移读取。
32. 键位：Space 播放暂停、J 下一句、K 播放暂停、L 上一句、H 按住显影（遮罩/抽查开时）、E 解析（仅 idle）、Esc 分层（挖空输入→浮层/抽屉→书架浮层）、home Enter、focus Esc/Tab/Enter/1-3；输入框内全局键让路。
33. §2.4 列出的 9 组 Swift 测试全部落地并通过；Windows 侧 4 个 vitest 文件 48 例在移植期间保持绿（行为向量以此为准绳）。
34. 评分/判分链路零语义改动：gradeVocab→存储+recordReview、recall 分桶、SRS 四档间隔（10 分钟/1 天/3 天/7 天）不变。

---

## 4. 平台差异清单（仅收录必然差异）

| # | 差异 | Windows 实现 | Mac 必然差异与理由 |
|---|---|---|---|
| 1 | 顶栏交通灯 | 无系统交通灯，三段 grid 顶格 | Mac fullSizeContentView 下交通灯叠画布左上（ReaderViews.swift:191-193 既有 M-01 规则），左段仍需 ~78pt 让位；三段布局语义不变 |
| 2 | 毛玻璃材质 | CSS `backdrop-filter: blur(20px)` | SwiftUI `.ultraThinMaterial`/NSVisualEffectView；folio（shelf/reading）按 Windows 同款**去 blur 改平面白胶囊**，此差异仅是实现材质 API |
| 3 | 译文浮层定位 | DOM `getClientRects()` 末行 rect 直测 | SwiftUI 无 rect 枚举 API，用 anchor preference/GeometryReader 取句视图 frame；锚定规则（末行下方 +10、箭头 clamp）数值不变 |
| 4 | conic 进度环/热力格 | CSS conic-gradient | SwiftUI `Circle().trim(from:to:)` + 旋转或 Canvas 绘制；百分比口径不变 |
| 5 | 删除确认 | `window.confirm` 同步对话框 | NSAlert 异步回调，文案逐字不变 |
| 6 | 保存 .md | Tauri `saveTextFile` 对话框 | NSSavePanel（允许其他文件类型 .md）；默认文件名 `{dayKey}-学习笔记.md` 不变 |
| 7 | 复制到剪板 | `navigator.clipboard` | NSPasteboard；「已复制」2.4s 回落不变 |
| 8 | 修饰键文案 | 「Ctrl+Enter 保存 · Esc 取消」「Ctrl+Shift+R」 | Mac 用 ⌘（Cmd+Enter / ⌘⇧R 全局热键已有 HotKeyManager）；**快捷键字母集（Space/J/K/L/H/E/Tab/Enter/Esc/1-3）不得差异** |
| 9 | 衬线字体加载 | Google Fonts（Source Serif 4 / Noto Serif SC）网络字体 | Mac 不引网络字体，回落系统衬线（New York/Georgia + 苹方）；字阶（26px 大句/32px 标题/正文字号 14–24）不变 |
| 10 | 窗口关闭语义 | 点 ✕ 隐藏窗口不销毁（WebView2 重建风险） | Mac windowWillClose 停播+保上下文（SHELL-6 既有），窗口体系不同、语义等价 |
| 11 | 事件外点关闭 | document mousedown 监听 | SwiftUI onTapGesture 挡板/scrim（FolioDismissScrim 先例 ReaderViews.swift:152）；「点击外关闭」行为不变 |
| 12 | 滚动跟随节流 | rAF | SwiftUI onChange/GeometryReader 天然节流或 TimelineView；「视口上 1/3 取句」口径不变 |

**范围依赖（非平台差异，如实标注）**：发现三列中 `discover`（发现书库）与 `feed`（资讯订阅）两个直达 tab 依赖 B3 订阅领域——Mac 现无 feedStore/DiscoverTab 实现（全源码 grep 已核实）、`ReaderIntakeSheet.IntakeTab` 亦无此二值（:26-31）。本规格交付 `openImport(tab:)` 契约 + 白名单 + `lib` 直达 + 三列卡片文案；discover/feed tab 内容属「资讯订阅/发现书库」领域规格，落地前该两列点击进缺省文库 tab 并不得报错。除此之外，任何行为、文案、契约、测试向量差异一律不允许。

---

## 附：勘察证据清单（Windows 锚点）

- `immersive-translator-windows/src/reader/ReaderTopBar.tsx:26,:49,:73-78,:90-93,:95-103,:104-118,:121-151,:153-201,:207-284`
- `immersive-translator-windows/src/reader/ReaderApp.tsx:146-155,:211-222,:258-259,:273,:300-302,:367-379,:383-392,:898-903,:940-944,:1044-1072,:1807-1819,:1822-1842,:1862-1878,:2096-2129,:2216-2219,:2301-2324,:2330-2369,:2385-2389,:2392-2411,:2413-2517,:2539-2569,:2573-2615,:2699-2781,:2793-2800`
- `immersive-translator-windows/src/reader/ReadingView.tsx:1-17,:111-122,:143-168,:186-214,:253-291,:298-354,:359-375,:382-415,:471-513,:520-593,:596-620,:623-647,:650-739,:746-824,:826-899,:902-1004,:1007-1029,:1031-1101,:1103-1151,:1153-1163,:1170-1177,:1183-1194,:1214-1234,:1237-1265`
- `immersive-translator-windows/src/reader/VaultPage.tsx:1-26,:75,:107-120,:125-176,:180-252,:257-347,:350-370,:372-460,:462-532,:535-624,:627-688,:693-721,:724-750,:753-798,:800-854,:862-978,:982-1127,:1131-1144,:1146-1294,:1298-1302,:1304-1416`
- `immersive-translator-windows/src/reader/ShelfPage.tsx:35,:104-114,:122-167,:169-174,:176-227,:232-238,:240-309,:314-381,:387-415,:417-507,:509-576,:579-639,:642-666,:668-754`
- `immersive-translator-windows/src/reader/reader.css:139-158,:5742,:6226-6323,:6645-6689,:7155-7180,:8057-8104,:8300,:9221-9276,:9285-9352,:9359-9363,:9370-9410,:11105-11315`
- `immersive-translator-windows/src/reader/PlayBar.tsx:190`（dock 类名）
- `immersive-translator-windows/src/reader/ReaderShelf.tsx:1-60`（FolioSheet 契约）
- `immersive-translator-windows/src/reader/ImportDialog.tsx:61-64,:70,:113,:181-183`
- `immersive-translator-windows/src/reader/ReviewView.tsx:111-116,:740-742`
- `immersive-translator-windows/src/reader/VaultPage.test.tsx`（全文 631 行，27 例）、`ReadingView.cloze.test.tsx`（头注 1-5）、`ReviewView.render.test.tsx`（头注 1-4）、`DictColumn.test.tsx`
- `immersive-translator-windows/src/core/readerTypes.ts:10,:39-48,:54-68,:71-77,:80-104,:132-212,:214-297,:299-328,:353-354,:451-485`
- `immersive-translator-windows/src/lib/readerStore.ts:36-176`
- `immersive-translator-windows/src-tauri/src/reader_store.rs:3-5,:213-214,:476-497,:697,:1777-1815`
- `contracts/README.md`（reading-room.schema.json v1 为运行时格式、Mac 直接采用）、`contracts/learning-relay-v2.md`（同步协议）
- commit `1c5205d`（git show --stat：16 文件 +6514/−2024）
