# 七项体验欠缺点 · 优化整改方案（2026-09-18）

> 输入：2026-09-18 体检报告的七个体验欠缺点（首启灾难 / 回访链重启死亡 / TTS 静默失败 /
> 快速复习旧数据 / 无 ErrorBoundary / 零埋点 / 性能隐患）。
> 本方案与 `docs/p0-release-prompt-2026-09-16.md` 的关系：**问题 1–4 对应该 prompt 的 P0-A~E
> 四张卡（内容深化后收录于此，以本文为准）；问题 5/6 是新增卡；问题 7 是发布后的观察卡。**
> 前置条件不变：先按 p0-release-prompt「阶段 0」把工作区两波存量代码（R1–R4 + 笔记库，
> 80+ 文件）分模块提交，再开始本方案——**不在未提交的地基上叠新改动**。
>
> 工作方式沿用既有约定：逐卡一个 commit（信息带卡号，如 `UX-3: quick-review refetch on show`）；
> 每卡收尾 `pnpm test` / `cargo test` / `pnpm build` 全绿；关键逻辑配单测；硬件/系统级验证列入
> 人工清单交还用户；悬而未决的分歧按最合理默认决定并记入 `docs/ux-decisions-2026-09-18.md`。

---

## 0. 总览：顺序、工期与体验主线

| 卡 | 解决 | 体验目标（用户感受的变化） | 工期 | 时机 |
|----|------|--------------------------|------|------|
| UX-1 | 首启无窗 + 托盘左键死键 + 热键无告知 | 「装完 30 秒内我知道这软件是什么、怎么用、第一步干嘛」；托盘左键必有反应 | 1 天 | 发布前 |
| UX-2 | 无开机自启，回访链重启死亡 | 「重启电脑，提醒和角标还活着」；且不开自启的用户知道后果 | 0.5 天 | 发布前 |
| UX-3 | 快速复习窗重开旧数据 | 「迷你窗里看到的永远是最新状态」 | 0.5 天 | 发布前 |
| UX-4 | TTS 静默失败 | 「没声音时我知道为什么、下一步点什么」 | 1 天 | 发布前 |
| UX-5 | 无 ErrorBoundary（白屏） | 「就算崩了也只是一块区域报错，能重试、能把诊断交给我」 | 0.5 天 | 发布前 |
| UX-6 | 零埋点 | 「功能好不好有数据说话」；设置页能看到自己的学习统计 | 1 天 | 发布前 |
| UX-7 | 性能隐患（8 窗预建 / 巨型文件） | 启动更快、占用更低；先量化再动手 | 0.5 + 1.5 天 | **发布后** |

发布前合计 ≈ 5.5 个工作日（不含阶段 0 的存量提交）。建议顺序：
**UX-1 → UX-2 → UX-3 → UX-4 → UX-5 → UX-6 → 构建 0.6.0**。
理由：UX-1/2 直接决定新用户与回访两条命脉最先修；UX-5 在 UX-6 之前做，让边界组件先就位、
埋点落地时顺手接上 `ui_error` 事件；UX-6 收尾是因其事件触点多依附其他卡的最终 UI 形态。

**发布熔断规则（防修复绑架发布）**：UX 卡合计耗时超过 **+2 天**（即第 7.5 个工作日还没齐），
就把已完成的卡先发 0.6.0，剩余滚入 0.6.1。理由：UX-1~6 主要服务**未来新用户**，而种子用户
复测（Word/PDF 导入、口语、笔记库——她已经等了 3 天）对 UX 卡几乎零依赖，updater 自动升级
让二次发版的边际成本只剩半天构建上传。学习闭环的验证进度不为一档发布窗口让路。

---

## UX-1 首启体验：引导窗 + 托盘左键 + 热键告知（问题 1）

**现状锚点**：`src-tauri/tauri.conf.json`（8 窗全 `visible:false`，行 28/42/56/70/82/96/109/125）；
`src-tauri/src/lib.rs:1154-1183`（托盘 builder，`:1158` `show_menu_on_left_click(false)`，
无 `on_tray_icon_event`）；`src/views/Settings.tsx:371-391`（唯一引导：三步 welcome 卡）；
`src/core/library.ts`（内置文库「今日一篇」）；marker 先例 `hotkey.txt`（`lib.rs:502-518`）；
启动期窗口创建不稳的既有注释 `lib.rs:100-106`。

**方案**：

1. **托盘左键**（最小改动先行）：把 `lib.rs:1158` 的 `show_menu_on_left_click(false)` 改为
   `true`——左键弹菜单、右键不变，一行解决「死键」（Tauri 2.11.3，API 已在用，改值即可编译）。
   需 30 秒真机验证 Windows 下行为；若该 flag 在 Windows 上表现异常，回退为
   `on_tray_icon_event` 左键分支 → `show()` + `set_focus()` 阅读室——**show 现有窗在托盘回调里
   是安全的**（`lib.rs:100-105` 的死锁警告只针对 build() 建新窗，不针对 show）。
2. **首启引导：show 预建窗，不建新窗**。首次启动直接 `show()` 预建的 settings 窗并路由到
   引导视图（把 `Settings.tsx:371-391` 现有 welcome 卡升级为三卡片布局）。理由：仓库自己的
   伤疤（`lib.rs:100-105`）证明启动期**创建**窗口不稳（settings/history 出过失败案例），而
   **show 隐藏窗**是被验证过的模式（提醒窗定时 show、`lib.rs:96` 的 `panel.emit("panel:shown")`
   皆是先例）；且零新增 WebView，与 UX-7 方向一致。三张卡片：
   - ① **热键表**：划词 Ctrl+Shift+Q / 截图 Ctrl+Shift+E / 阅读室 Ctrl+Shift+R + 一句
     「现在就在任意软件里选中一段英文试试」（热键以 `hotkey.txt` 实际配置为准，读取展示）。
   - ② **「配置翻译接口」**：滚动到配 Key 区（同窗口内锚点滚动，无跨窗跳转）。
   - ③ **「用内置文章试试阅读室」**：导入 `library.ts` 今日一篇 → show 阅读室窗。
   备选（若团队坚持视觉分离）：独立引导窗走动态创建 + ready 后延时，但须接受启动建窗不稳
   前科带来的首次体验风险——默认不取。
3. **老用户判定**：`secrets.json` 已有 LLM Key 或 `reader_articles.json` 非空 → 不弹；
   关闭时写 `app_data_dir/onboarding-done.json`，此后永不弹（重启/升级均不重弹）。唯一例外：
   引导从未被关闭过（首启即强杀/崩溃/重启电脑）时，下次启动再弹一次——防止用户永远错过；
   一旦关闭过，任何情况下不再出现。
4. **热键常驻可见性**（补丁级）：托盘菜单项 title 已含热键则保持；翻译浮窗首次弹出时
   toast 提示一次「划词翻译已就绪（Ctrl+Shift+Q）」，marker 同 onboarding 体系。
5. 引导窗跟随阅读室主题令牌（复用 styles.css 四主题，避免重蹈 B3/B4）。

**验收**：全新数据目录首启 3 秒内见引导视图、三按钮可用；左键单击必有菜单（或回退方案下
聚焦阅读室）；关闭后重启不弹；预置 Key 的老用户目录不弹；三道门禁绿。
**不做**：多步向导、动效、视频、二次打扰。

---

## UX-2 开机自启 + 回访链续命（问题 2）

**现状锚点**：全仓 grep `autostart` 零命中（Cargo.toml / src / src-tauri）；提醒配置
`src-tauri/src/review_reminder.rs:23-50`；提醒设置组 `src/reader/SettingsDrawer.tsx:298-373`。

**方案**：

1. 引入 `tauri-plugin-autostart`（Tauri v2），**默认关**。
2. 开关落两处、共享同一 JS 绑定封装（`isEnabled/enable/disable`）：
   - 设置窗「通用/关于」区（主开关，`Settings.tsx`）；
   - 阅读室设置抽屉「提醒」组内**行内小开关 + 一句因果文案**：「复习提醒需要应用在后台
     运行——建议开启开机自启」。这是本卡的体验关键点：把「开提醒」和「提醒依赖常驻」
     的因果关系在用户做决定的当场说清，而不是让回访链无声死掉。
3. 自启后行为：进托盘、不弹任何窗口（现状启动即无窗口，此处从缺陷变成正确行为；
   引导窗因 marker 不会重复弹）。`--autostart` 启动参数标记可用时写入，供后续区分场景。
4. 关闭开关时彻底清理注册表 Run 项（插件职责，验收时人工核对残留）。

**验收**：开启→重启系统→托盘常驻且角标可见；关闭→无 Run 残留；提醒组文案与开关联动正确；
`cargo test` + `pnpm test` 绿（重启本身列入人工清单）。
**不做**：静默后台模式选项、延迟启动配置。

---

## UX-3 快速复习窗旧数据（问题 3）

**现状锚点**：`src/quickreview/QuickReviewApp.tsx:68-96`（数据加载在空依赖 effect，只跑一次）；
`:146-149` Esc=hide、`:364-371` ✕=hide；Rust 复用分支
`src-tauri/src/review_reminder.rs:220-224`；既有监听模式参照 `src/reader/ReaderApp.tsx:781-787`
（`reader:vocab-added`）。

**方案**（2026-09-18 经代码核实后由「双保险」收敛为单点修复）：

1. **Rust 侧**：`review_reminder.rs` 的 `open_quick_review_window`（托盘菜单与提醒卡
   共用入口）复用分支改为先查 `is_visible()`——**隐藏→可见的过渡**才在 `show()` 后
   `win.emit("quick-review:shown", ())`（同 `lib.rs:96` `panel:shown` 既有模式）；
   已可见时只 `set_focus()` 不发事件——保护进行中的会话（前后切卡/改评进度，decisions #14）。
   冷构建分支首次挂载本就加载，无需事件。
2. **前端侧**：`QuickReviewApp.tsx:68-96` 空依赖 effect 的加载体抽成 `reload()`（useCallback），
   挂载与 `listen("quick-review:shown")` 都调它。重拉即重算到期队列并重建会话态
   （cards/uis/grades）——「旧完成态」随整会话刷新自然消失，无需单独的重置逻辑；
   原有 `active` 竞态保护保留（快速连开丢弃旧响应）。重拉期间保持旧内容 + 细进度条，
   不闪空白。
3. **为什么砍掉原第 2 条（隐藏期事件监听）**：隐藏窗没人看见，唯一可见面是托盘角标——
   它已有 30s `due_count` 定时器 + 评分后的 `trayRefreshBadge()`（`QuickReviewApp.tsx:128`），
   无缺口；且评分没有独立 Rust 命令（走 `readerSaveVocabWord` 整词保存，
   `QuickReviewApp.tsx:124`），不存在干净的 `reader:review-graded` 发射点；若在迷你窗
   可见时收到外部事件就重建，反而破坏「改评留在原地」。不做。
4. **验证原型**：`prototypes/quickreview-refresh-ux3-2026-09-18.html`（修复前/后行为
   对比模拟，含事件流可视化与「已可见仅聚焦」语义演示）。

**验收**：阅读室复习完 → 托盘重开迷你窗，列表/完成态为最新；隐藏期他处加词，角标与列表同步；
既有 vitest 用例不回归；新增「shown 事件触发重拉」单测（mock emit/listen）。
**不做**：把 hide 改销毁（会丢「收起不丢进度」的既有设计决策 decisions #14）。

---

## UX-4 TTS 静默失败 → 可见、可懂、可行动（问题 4）

**现状锚点**：`src/reader/usePlayback.ts:100-103`（朗读失败仅 console + stop）；
`src/reader/speechEngine.ts:98-103`（云凭据缺失静默回落/fireEnded）、`:109-113`（合成失败）、
`:127-133`（播放被拒）；`src/reader/ReaderApp.tsx:220-224`（凭据缺失静默选 SAPI）；
错误条样式位参照 AssessStrip；SpeakView 兼容约束：`SpeakView.tsx` 的 `subscribeSpeakEnded`
与 gen 配对逻辑不得破坏（p0-release-prompt P0-E 同款约束）。

**方案**：

1. **错误分类学**：`speechEngine` / `usePlayback` 统一错误枚举
   `TtsErrorKind = "no-creds" | "synth-failed" | "play-blocked" | "speak-failed"`，
   每类对应一句人话 + 一个动作：
   | Kind | 文案 | 动作 |
   |---|---|---|
   | no-creds | 云朗读未配置，已用本地语音 | 「去设置」（打开 settings 并定位语音区）+「本会话不再提示」 |
   | synth-failed | 本句合成失败（网络/服务），已跳过 | 「重试本句」「停止」 |
   | play-blocked | 播放被系统拒绝 | 「重试」「停止」 |
   | speak-failed | 朗读启动失败 | 「重试」「停止」 |
2. **呈现位**：PlayBar 内嵌一条非模态错误条（复用 AssessStrip 视觉位），下一次成功播放自动
   消失；**例外**：带「去设置」动作的凭据缺失条常驻到用户处理（去设置/不再提示）或问题解除
   （凭据保存即消失）——1.25 秒就被顶掉的动作条等于没给用户点的时间（原型实测结论）。
   **不弹 toast 轰炸、不打断后续句子推进**（跳过语义保留，只是从「无声跳过」变「有声告知」）。
3. **回落告知**：`ReaderApp.tsx:220-224` 的「选了云 TTS 但凭据缺失→回落 SAPI」改为**每会话一次**
   的提示（session 级去重），其余情况维持静默回落——用户主动选云引擎却没配凭据属于配置错位，
   必须让他知道，但不反复打扰。
4. `fireEnded` 静默推进路径全部改为「先置错误态、再推进」，保证流不中断（与 3 同理）。

**验收**：断网、删凭据、正常三场景走查——UI 均有对应提示且播放可停止/继续；SpeakView 重听
与跟读评分链路无回归（vitest TTS 用例全绿 + 新增错误态机单测）；正常播放零新增打扰。

---

## UX-5 ErrorBoundary：白屏 → 区域级降级（问题 5）

**现状锚点**：`src/main.tsx:1-10`（无边界直接 render）；全仓 grep `ErrorBoundary` 零命中；
诊断文本生成器已存在：`src/lib/errorMessageFormatter.ts:410-434`。

**方案**：

1. 新增 `src/ui/ErrorBoundary.tsx`（class 组件，`getDerivedStateFromError` +
   `componentDidCatch`）。
2. **挂载取舍（如实陈述）**：`App.tsx:24-48` 按窗口 label 返回**整个视图**，TitleBar 在各
   视图内部——所以「App.tsx 一处包裹覆盖 8 窗」必然连标题栏一起降级，鱼与熊掌不可兼得：
   - **默认取 A（一处挂载）**：改动最小、8 窗即刻受保护；错误卡上必须带 **[关闭窗口]** 按钮
     （`getCurrentWindow().hide()`，hide 语义与各窗现状一致）补偿标题栏失效——用户无死角可逃。
   - B（各视图 TitleBar 内层逐个包裹，标题栏存活）留作后续打磨项，8 处改动、收益仅剩拖拽。
3. 降级 UI（跟随主题令牌）：图标 + 「这部分出了点问题」+ 最后一条错误的一句话摘要 +
   **[重试]**（reset boundary state，不清用户数据）+ **[关闭窗口]** + **[复制诊断]**
   （复用 `errorMessageFormatter.ts:410-434` 诊断报告）。
4. `componentDidCatch` 里 `console.error`；UX-6 落地后补 `track("ui_error", { window })`
   （见 UX-6 的扩展事件）。

**验收**：任一视图内人为 throw（临时验证代码）→ 错误卡显示、重试可恢复、关闭窗口按钮生效、
复制诊断内容完整；`pnpm test`/`build` 绿；边界组件自身单测（children throw → fallback 渲染）。

---

## UX-6 本地埋点 + 使用统计（问题 6）

**现状锚点**：全仓零 telemetry；事件定义表 = 审计报告
`docs/product-audit-report-2026-09-15.md` §6 的 15 事件（**不自行增删，除下述 2 个扩展**）；
存储模式参照 `reader_store.rs:336-343` 原子写；导出参照 `file_export.rs` / `tauriBridge.ts:225-227`。

**方案**：

1. Rust `metrics_log` command：append 写 `app_data_dir/metrics.jsonl`，每行
   `{ts, name, props}`；写失败静默（埋点绝不影响功能）。
2. 前端 `src/lib/metrics.ts` 封装 `track(name, props)`；按 §6 表落 15 事件触点。
3. **两个扩展事件**（超出审计 15 表，服务本方案另两卡，记录进 decisions）：
   - `ui_error`（UX-5 的 componentDidCatch 触发，props: window 枚举）
   - `app_launch`（Rust setup 触发，props: ms 冷启动耗时、firstRun 布尔）——UX-7 的量化数据源。
4. 设置页新增「使用统计」区：周有效学习会话数 / 周新增生词 / 复习完成率（口径照审计
   §4.5、§5.3）+ 「导出」按钮（save_text_file 链路）。聚合逻辑独立纯函数 + vitest 单测。
5. **零出网、零用户内容**：props 只允许枚举与数字，code review 时逐一核对。

**验收**：各触发点正常追加 jsonl；摘要三项计算正确（单测覆盖）；断网状态埋点无感；
设置页可导出。**不做**：任何网络上报、趋势图、看板美化。

---

## UX-7 性能：先量化、再一刀（问题 7，发布后）

**现状锚点**：`tauri.conf.json` 8 窗静态预建（每窗独立 WebView）；`ReaderApp.tsx` 1656 行、
`reader.css` 4140 行；串行长文翻译链路（每批 10 句，`chunkAnnotate.ts:21`）；
懒加载先例：pdfjs/mammoth 均已动态 import（`pdfjsLoader.ts:17`、`fileImport.ts:194`）；
现场建窗先例：`lib.rs:248-262`（settings）。

**方案（三步，第一步是硬门槛）**：

1. **量化（0.5 天，UX-6 发布后一周即有数据）**：
   - `app_launch` 的 ms 分布（P50/P95）；
   - 人工基线一次：冷启动秒表 + 任务管理器记录 8 个 WebView 进程的常驻内存合计，写入
     `docs/perf-baseline-2026-XX.md`。
   - **判据**：冷启动 P95 < 3s 且内存合计 < 500MB → 不动窗口结构，只做第 3 步；否则做第 2 步。
2. **懒创建低频窗（1–1.5 天，数据触发才做）**：把 **history** 与 **live-caption** 改为首次打开时
   动态创建、关闭销毁（照 `lib.rs:248-262` 的 settings 现场重建模式）。保留预建：panel/ocr/
   quick-review（热键热路径，要求 <500ms 出窗）、reminder（定时弹出）、reader/settings。
   预期收益：−2 个 WebView 进程（约 −80~160MB 常驻）与更快冷启动；风险低（有先例模式）。
3. **代码体量纪律（不排期，立规矩）**：
   - 新功能一律独立文件（NotesView/SpeakView/TodayCard 先例已立）；
   - `ReaderApp.tsx` 只做路由/编排/状态枢纽，单文件不破 2000 行，超过即拆下一个视图出去；
   - `reader.css` 维持分节注释制，笔记库式的「一段一功能」继续执行；
   - 明确**不做**：manualChunks 微调、ReaderApp 大重构、翻译批大小调优（三者当前均无数据支撑）。

**验收**：第 1 步产出基线文档；第 2 步（若做）前后对比数据附于发布说明；懒创建窗功能行为
与预建时无差异（打开延迟 < 1s 可接受，因两窗均非热键路径）。

---

## 收尾与交还（发布 0.6.0）

1. 门禁：`pnpm test` / `cargo test` / `pnpm build` 全绿；版本三处同步升 **0.6.0**。
2. 自检报告 `docs/ux-selfcheck-2026-09-XX.md`：逐卡验收结果 + 证据 + 遗留问题。
3. **人工验收清单**（自动化不了的，交还用户）：托盘左键弹菜单、重启验证自启、断网/删凭据的
   TTS 提示、麦克风/扬声器链路（存量 R3/R4 验收项）、引导窗真机观感。
4. **种子用户复测清单（≤10 条，白话）**：装完第一眼看到什么、三张卡片各点一遍、重启电脑后
   提醒还在不在、阅读室点朗读拔网线看提示、复习完再开迷你窗对不对、设置页看自己的统计。

## 风险与回退

- UX-1 托盘：`show_menu_on_left_click(true)` 需真机验证 Windows 行为；异常则回退
  `on_tray_icon_event` 左键 → show 阅读室（show 现有窗在托盘回调中安全，仅 build() 有死锁风险）。
- UX-2 autostart 插件在 Win11 22H2+ 的「启动应用」通知行为未验证——默认关 + 文案不承诺，
  观察种子用户反馈。
- UX-4 涉及播放状态机，改动必须带状态机单测；如与 SpeakView 配对逻辑冲突，以 SpeakView
  现行为准回退该路径并记录。
- 全部卡片独立成 commit，任一卡可单独 revert，不影响存量 R1–R4/笔记库代码。
