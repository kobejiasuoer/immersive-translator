# ImmersiveTranslator v0.8 桌面工作台改版 · AI 开发交接 Prompt

你现在是 `ImmersiveTranslator` 项目的资深桌面端全栈工程师（精通 Tauri 2 + Rust + React 18 + TypeScript）。
我已经完成了 `v0.8` 桌面端主工作台的视觉与交互改版设计，并附带了定稿的高保真可交互原型文件 `immersive_workbench_v08_prototype.html`。

你的任务是：**以 `immersive-translator-windows/` 为唯一修改目标，严格对照 `immersive_workbench_v08_prototype.html` 的视觉设计令牌（CSS Tokens）、空间画布布局、组件样式与交互状态机，将现有的 Windows 端代码升级为 v0.8 沉浸式英语精读与内化工作台。**

在写任何一行代码前，请严格遵守以下 **4 条工程红线** 与 **4 阶段落地方案**。

### 一、四大工程红线（Hard Constraints）

1. **绝不把原型的演示 Mock 数据硬编码进生产逻辑**：
   - 原型中的 `SENTENCES`、`LEX_DICT`、`SCENARIO_PRESETS`、`NOTEBOOK_ITEMS` 仅用于演示 UI 状态与视觉排版。
   - 生产代码必须完整保留并复用现有的真实数据流与 IPC 通道：文章与书籍读写（`src/lib/readerStore.ts`）、流式翻译通道（`translateStream`）、词块标注（`src/core/chunkAnnotate.ts`）、讯飞/Edge/本地 TTS 朗读（`src/reader/speechEngine.ts`）、麦克风录音与 VAD（`src/core/micRecorder.ts` + `src/reader/useShadowAssess.ts`）、讯飞流式听写（`src/core/xfyunAsr.ts`）以及讯飞发音评测（`src/core/pronunciation.ts`）。
2. **向后兼容数据存储契约（`contracts/reading-room.schema.json`）**：
   - 任何新增字段（例如口语轮次 `SpeakTurn` 新增的表达润色建议 `coachDiff`、或生词掌握阶段计算）在 TypeScript 与 Rust（`src-tauri/src/reader_store.rs`、`speak_store.rs`）两侧必须设为可选字段（`Option<T>` / `?:`），确保老用户的本地 JSON 数据文件无需迁移即可无缝读取。
3. **遵守 Windows WebView2 线程安全铁律**：
   - 在 `src-tauri/src/lib.rs` 中调整窗口显示逻辑时，若涉及 `WebviewWindowBuilder::new(...).build()`，必须在独立线程（`std::thread::spawn`）中调用，绝不能在同步命令或托盘事件处理器主线程中直接 build，防止 Windows WebView2 死锁。
4. **严格还原原型的视觉规范（Frontend-Design & Impeccable 准则）**：
   - **消除通顶硬切侧边栏**：取消四栏通顶框线切割，采用原型中的同色系全画布背景（`--canvas-bg` + 双极柔和径向光晕）+ 顶部居中悬浮毛玻璃胶囊导航岛（`.center-nav-island`）+ 左上角按需弹出的悬浮书架面板（`.floating-folio-sheet`）+ 底部悬浮播放走带胶囊（`.floating-sonic-dock`）。
   - **三套无缝主题**：将原型中的三套主题令牌（`warm-archival` 纸书、`obsidian-sonic` 深色、`nordic-mist` 护眼）同步至 `src/styles.css` 与 `src/reader/reader.css`。
   - **自然直白的中文文案**：严格沿用定稿原型中的直白命名（顶部导航：`阅读` / `口语` / `笔记与复习`；右侧面板：`句子解析` / `查词`、`发音详情`；复习模式：`记忆胶带手账` / `3 分钟快刷闯关` / `Markdown 笔记导出`），禁止引入生造的四字包装词或用 Emoji 充当系统图标。

### 二、原型与现有代码库的 1:1 映射表

| 原型区域与核心交互 | 对应原型 CSS / 函数参考 | 需修改的现有代码文件 | 底层复用接口（禁止破坏） |
| :--- | :--- | :--- | :--- |
| **Phase 1：主窗口收敛与顶部悬浮导航岛** | `.floating-top-stage`、`.center-nav-island`、`.floating-folio-sheet` | `src-tauri/src/lib.rs`<br>`src/reader/ReaderApp.tsx`<br>`src/reader/ReaderTopBar.tsx`<br>`src/reader/ReaderShelf.tsx` | 启动默认调用 `show_reader_window`（若已完成首启引导）；`live-caption` 与 `history` 保留在托盘二级菜单不扩建；书架改为点击左上角书名弹出的毛玻璃浮层。 |
| **Phase 2：阅读室画报排版、专注模式与句子解析/查词面板** | `.editorial-spine-col`、`.prose-body.spotlight-active`、`.interlinear-fold`、`.spatial-lens-card` | `src/reader/ReadingView.tsx`<br>`src/reader/DictColumn.tsx`<br>`src/reader/PlayBar.tsx`<br>`src/reader/reader.css` | 1. 新增「专注模式（Spotlight Focus）」开关：开启后非当前句降为 `opacity: 0.36`，点击句子在行间展开译文与操作条；<br>2. 右侧 `DictColumn` 改为圆角悬浮毛玻璃卡，增加「句子解析 / 查词」双 Tab；「句子解析」复用 `translateStream` 提取句子主干、意群拆解（悬停分句高亮左侧原文对应片段）与常用句型；<br>3. 底部 `PlayBar` 改为居中悬浮胶囊。 |
| **Phase 3：口语场景中心、60fps 声波舞台、免长按开麦、表达改进与发音详情** | `.scenario-hub-scroll`、`#harmonicCanvas`、`.editorial-diff-block`、`.phoneme-pill-grid` | `src/reader/SpeakView.tsx`<br>`src/core/speakLogic.ts`<br>`src/reader/ShadowReport.tsx`<br>`src/core/shadowDiagnose.ts`<br>`src/core/edgeTts.ts`<br>`src/core/xfyunTts.ts` | 1. **场景选择页（Scenario Hub）**：在原有 4 个日常场景（面试/点餐/旅行/寒暄）之上，置顶「聊刚读的章节（传入当前 `Article` 标题与前几句摘要）」和「今日生词造句闯关（传入 `vocabWords` 待复习词）」；支持顶栏 `← 切换场景` 随时返回；<br>2. **免长按开麦**：将 `SpeakView` 的死按鼠标录音改为点击开麦 + 复用 `useShadowAssess.ts` 的静音检测（VAD）自动停止并送 `transcribeSpeech`；同时对用户本轮录音调用 `evaluateSentence` 生成发音得分；<br>3. **表达改进建议**：扩展 `buildSpeakSystemPrompt` 与 `parseAssistantReply`（返回 `EN:`、`ZH:`、`BETTER:`、`TIP:`），在用户气泡下方渲染词级增删对比（`.diff-del-span` / `.diff-ins-span`）；若用户发言命中目标生词，自动调用 `readerRecordReview` 更新 SRS；<br>4. **慢速示范与音标建议**：修改 `edgeTts.ts` 的 `buildSsmlMessage` 支持传入 `rate`（慢速示范传 `-25%` 原生合成）；在 `shadowDiagnose.ts` 补齐常见失分音素的中文发音舌位建议与 SVG 语调曲线对比。 |
| **Phase 4：笔记与复习三合一（记忆胶带手账 + 3 分钟快刷闯关 + 内化看板）** | `.memory-tape`、`.challenge-stage-box`、`.heatmap-grid`、`renderVaultSurface()` | `src/reader/ReviewView.tsx`<br>`src/reader/NotesView.tsx`<br>`src/core/readerSrs.ts` | 1. 将原本割裂的 `ReviewView` 与 `NotesView` 整合进顶栏「笔记与复习」视图下的三个子模式切换；<br>2. **模式 1（记忆胶带手账）**：将生词原句与口语改进句渲染为手账行，核心词块包裹 `.memory-tape`（默认遮盖并显示提示，点击切换 `.peeled` 揭开显影，右侧一键 `✓ 秒懂过关` 调用 `gradeVocab`）；<br>3. **模式 2（3 分钟快刷闯关）**：复用 `ReviewView` 现有的完形（`ClozeCard`）与听写能力，新增「开口造句过关」题型（录音识别命中目标词即按 `easy` 档完成 SRS 更新）；<br>4. **右侧内化看板**：根据 `vocabWords` 的 `intervalDays` 与复习记录展示「刚收集 / 眼熟能认 / 已变成口语表达」三阶段计数、28 天复习热力格（读取 `stats.days`）以及易错词一键加练入口。 |

### 三、分阶段执行协议（请严格按此顺序推进）

请**不要**试图在一次回复里改完所有文件。请按以下 4 个阶段分步执行：

1. **第一步（先读码与输出修改计划）**：
   - 先完整读取 `immersive_workbench_v08_prototype.html` 以及上述映射表涉及的现有源码文件。
   - 向我输出一份简明的 **Phase 1～Phase 4 文件级改动清单**，确认不会破坏任何现有 IPC 接口。
2. **第二步（逐个 Phase 编码与自测）**：
   - **Phase 1**：完成主窗口启动聚焦、三套主题令牌注入、顶部悬浮导航岛与弹出式书架面板改造 → 运行 `pnpm test` 与 `pnpm build` 确认零报错。
   - **Phase 2**：完成阅读室画报版式、专注模式、行间译文展开与右侧「句子解析 / 查词」双模悬浮面板 → 运行单测确认通过。
   - **Phase 3**：完成口语场景选择中心、60fps `<canvas>` 声波舞台、免长按 VAD 开麦、用户表达改进 Diff、逐音标发音建议与 SSML 原生 0.75× 慢速朗读 → 补充并运行 `speakLogic` 与 `speechEngine` 相关单测。
   - **Phase 4**：完成「笔记与复习」三合一视图（记忆胶带手账、3 分钟多模态闯关、Markdown 预览复制与右侧内化看板） → 运行全量 `vitest` 单测确保 100% 绿灯。
