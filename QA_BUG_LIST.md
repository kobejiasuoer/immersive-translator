# QA Bug 清单（第一轮 QA · macOS 桌面版）

- 生成日期：2026-11-09（2026-11-10 修订：并入 s6 补测新增 BUG-040/BUG-041，补测四段与 perf 续跑后用例状态不变；静态 15 条经汇总会话逐行复核源码并更新复核标注与修复状态）
- 2026-11-10 回归轮（回归测试员）：对 22 条已修复 Bug（P0×1 / P1×6 / P2×15）做真实 GUI 回归。14:00 前屏幕锁屏（2026-11-09 21:30 起），13:06 解锁后执行：**BUG-001/002/003/004/011/041 已回归通过，BUG-009 未修复（复现），BUG-010 症状①通过、症状②未完成，其余 12 条 GUI 回归未完成（16:58 起机器被用户占用，HID 自动化按守则中止，记「已修复待回归」）**。回归记录与全部证据路径见 `qa-artifacts/results/regression-2026-11-10.md`；全量 `swift test` 1357/0（`qa-artifacts/results/regression-swift-test-1216.log`）。
- 测试对象：`immersive-translator-mac/.build/debug/ImmersiveTranslator`（SPM debug，56,351,984 B，构建于 2026-11-06 00:22，sha256 前 16 位 `09cd61ee848a4ef6`；本清单所有 `文件:行` 均对照该构建对应的工作区源码核实存在）
- 证据根目录：`qa-artifacts/`（results／findings／screenshots／mock／perf.md）
- 去重口径：
  - 同一缺陷被多个会话复现的合并为一条（如 s6 F2 与 s7 M09-16 合并为 BUG-009；s7 F-S7-00/00b 两次崩溃同根因合并为 BUG-001；s2/s5/s6/s3 的「合成事件不响应」家族合并为 BUG-019）。
  - 静态审查中「SpeakRecords recordAssessmentSilently 窄窗口」与「SpeakRecords 全程无命名空间守卫」同根因，合并为 BUG-030。
- 来源标注：
  - **【GUI 实测】** = 会话内在真实 GUI 上操作并留有截图/日志/AX dump 证据，判定成立。
  - **【静态推断】** = 只读代码审查/只读日志推断，不计入任何 GUI 统计。2026-11-10 汇总会话已对全部 15 条静态发现引用的 `文件:行` 逐一核对（当前工作区源码与描述一致，见 §2 头注）；并发交错类（BUG-027/030/035）代码结构与无防护现状已核实、运行时交错未复现，修复时建议先做最小运行时复现或压测。
- 等级口径：P0 致命（崩溃/数据损毁）/ P1 严重（主流程不可用、数据错误且用户无感知）/ P2 一般（功能受损、明显错误结果）/ P3 建议（文案、展示、低置信观察项）。
- 修复状态口径：P0/P1/P2 且可最小化修复 → **待修复**；P3 → **确认不修复**（本轮不安排，留档备查）；未经独立复核的静态发现 → **待确认**（本轮静态 15 条已全部复核，无待确认项；并发类复核注记见 §2 头注）。

---

## 0. 清单汇总

| ID | 名称 | 模块 | 等级 | 来源 | 可修复 | 修复状态 |
|---|---|---|---|---|---|---|
| BUG-001 | 专注复习「完形→听写」轮转空输入触发 wordDiff Range 越界，整个应用闪退（2/2 复现） | 生词本与复习·专注复习 | P0 | GUI 实测 | 是 | 已回归通过 |
| BUG-002 | 禅模式开启后无任何 GUI 退出入口，设置持久跨启动 | 阅读室·禅模式 | P1 | GUI 实测 | 是 | 已回归通过 |
| BUG-003 | 登出后登录窗重开残留「登录成功」态且无法再次登录（需重启应用） | 账号·登录窗 | P1 | GUI 实测 | 是 | 已回归通过 |
| BUG-004 | 纯云端拉取的笔记删除静默失败并在重启后复活（无 tombstone、无推送） | 阅读室·笔记库 / 云同步 | P1 | GUI 实测 | 是 | 已回归通过 |
| BUG-005 | 默认「混合」OCR 预设（en-US 优先）对中文素材输出乱码或 0 字符 | 截图 OCR | P1 | GUI 实测 | 是 | 已修复待回归 |
| BUG-006 | 正文段翻译请求 hang：无超时、无反馈、无恢复入口，切文后静默丢弃 | 阅读室·翻译管线 | P1 | GUI 实测 | 是 | 已修复待回归 |
| BUG-007 | 固定目标语言模式下「目标语言」输入不落盘、不生效 | 设置中心·翻译 | P2 | GUI 实测 | 是 | 待修复 |
| BUG-008 | 浮窗「自动隐藏」开启后翻译完成即隐藏（<1s），而非 16 秒 | 翻译浮窗 | P2 | GUI 实测 | 是 | 已修复待回归 |
| BUG-009 | 排版「段落⇄对照」切换导致当前阅读位置重置（74→31→1；21→12→1 双会话复现） | 阅读室·排版 | P2 | GUI 实测 | 是 | 未修复 |
| BUG-010 | 学词笔记「取消生成」语义错误：首字前取消报「接口返回空内容」，流式后取消把截断稿当完整笔记存档 | 生词本与复习·学词笔记 | P2 | GUI 实测 | 是 | 已修复待回归 |
| BUG-011 | 快速复习窗评分后阅读室「笔记与复习」不刷新：已评词仍显示到期，可被重复复习 | 生词本与复习·跨窗口一致性 | P2 | GUI 实测 | 是 | 已回归通过 |
| BUG-012 | 托盘菜单 OCR 热键镜像不随设置即时刷新（实际键已切换） | 全局外壳·托盘菜单 | P2 | GUI 实测 | 是 | 已修复待回归 |
| BUG-013 | 兑换码 429 未透传 retryAfter 提示（只显示兜底文案） | 账号·兑换码 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-014 | 生词 rail「未整理」提示文案误导（对普通划词生词断言「可能不是词汇（如命令行）」） | 生词本与复习·文案 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-015 | 笔记库 AI 复盘「只测仍错的词」点击后未进入专注复习（低置信度，待复核） | 生词本与复习·笔记库 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-016 | 同一实例两处登录态显示矛盾（模型服务页「已登录」vs 账号页「未登录」）且期间无 auth 日志 | 设置中心/账号 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-017 | 系统提示类浮窗状态行显示「deepseek-v4-flash · 1262.8s」类无意义 meta | 翻译浮窗·状态行 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-018 | Edge TTS 连接被拒时 UI 无可感知反馈（本机代理环境快速拒绝场景） | 阅读室·TTS | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-019 | 合成事件（CGEvent/AXPress）对部分控件不响应家族：词典卡切换/发音、OCR ⌘⌥Enter、网页「抓取正文」按钮（阅读室正文交互已拆出升 BUG-041） | 多模块 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-020 | 401 token_invalid 后本地凭据 server_auth 未清除（提示文案正常；口径待产品确认） | 平台认证·错误处理 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-021 | 错误卡来源 badge 疑不反映真实方向判定（纯英文错误卡显示「选中中文」） | 翻译浮窗·状态行 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-022 | RSS 文章列表显示未转义 HTML 标题 + description 片段混入列表 | 阅读室·资讯订阅 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-023 | 跟读主开关关闭后 shadowingAssess 子开关残留 true（再开时带旧状态生效） | 阅读室·跟读 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-024 | 多列橙色质量警示分支对 OCR 后文本不可达（双列素材命中灰色结构提示） | 截图 OCR·质量警示 | P3 | GUI 实测 | 是 | 确认不修复 |
| BUG-025 | Edge TTS 网络失败无熔断：挂起型网络下每句先等云端失败（≤20s 超时）再回落系统朗读 | 阅读室·TTS 播放引擎 | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-026 | PanelTtsSpeaker 云路由 `.local` 腿缺 route 后代数复检：stop/换朗读位后旧句仍出声（幽灵语音/乱序） | 翻译浮窗·TTS | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-027 | ReaderStore 域文件「读-改-写」与同步 hydrate 并发丢更新：陈旧 srs/recall 反推云端，复习进度跨设备回退 | 数据一致性·ReaderStore | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-028 | loadJSONFile 对损坏 JSON 静默返回空库：下一次保存整体覆盖书目索引/整本书其余章节 | 数据一致性·ReaderStore | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-029 | LearningStore.readPath 把一切磁盘读错误吞成 NotFound：消费方视为空库，下一次保存整体清库 | 数据一致性·LearningStore | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-030 | SpeakRecords 同步入队全程不带 expectedNamespace（含 detached 评测写）：账号切换窗口内实体落错命名空间，登出场景经 adoptGuest 跨账号串扰 | 数据一致性·SpeakRecords | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-031 | 浮窗翻译请求超时仅 18s（Windows 同接口 120s、mac 阅读室 180s）：非流式长文本/慢模型必然超时 | 翻译浮窗·网络 | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-032 | 流式 SSE 中的 error 帧被吞：有部分文本时截断译文当成功落库；无文本时服务端 message 丢失 | 阅读室·网络 | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-033 | 讯飞 TTS 音频帧 base64 解码失败静默丢帧：截断 mp3 被写入 L1+L2 双层缓存，命中缓存永不自愈 | 语音·讯飞 TTS | P2 | 静态推断·已复核 | 是 | 已修复待回归 |
| BUG-034 | 应用退出或被 kill 不落盘缓冲：最多丢 14s 阅读秒数与 0.7s/1.2s 防抖中的进度写入 | 阅读室·数据落盘 | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-035 | LearningStore.deviceId() 读-改-写无锁：首次并发调用可生成两个设备 ID，进度实体键分叉 | 数据一致性·LearningStore | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-036 | derive 的 tombstone 循环不覆盖 chunk:/progress: 实体：随编辑与同步无界累积（性能/配额泄漏） | 数据一致性·LearningStore | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-037 | XfyunWebSocketSession 业务错误抛出路径不关 WebSocket：每次失败泄漏一条连接 | 语音·讯飞会话 | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-038 | 流式路径读 HTTP 错误体无 do/catch：断连抛裸 URLError，越过 401 换票重放与错误归因 | 翻译浮窗·网络 | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-039 | ReaderChatClient.streamDeltas 收流 Task 继承 @MainActor：整条 SSE 逐字节解析在主线程执行（长输出卡顿） | 阅读室·网络 | P3 | 静态推断·已复核 | 是 | 确认不修复 |
| BUG-040 | EPUB 目录勾选页章列表溢出重叠：章数多时盖住表头与导入按钮，后段章节不可达 | 阅读室·EPUB/长书导入 | P2 | GUI 实测 | 是 | 已修复待回归 |
| BUG-041 | 正文点词/划选查词/词块卡/点句定位在 mac 端经正文交互不可达（mouseUp 覆写永不被调用） | 阅读室·查词与生词 | P1 | GUI 实测 | 是 | 已回归通过 |

统计：GUI 实测 26 条（P0×1 / P1×6 / P2×7 / P3×12）；静态推断·已复核 15 条（P2×9 / P3×6）。合计 41 条。修复状态（2026-11-10 回归轮后，与上表逐行一致）：已回归通过 6（BUG-001/002/003/004/011/041）、已修复待回归 15（GUI 005/006/008/010/012/040 + 静态 025～033）、未修复 1（BUG-009，回归复现）、待修复 1（BUG-007，skip 未改码）、确认不修复 18（P3 留档）、待确认 0 条。

2026-11-10 回归轮结果：GUI 回归执行 8 条（BUG-001/002/003/004/009/010/011/041）——已回归通过 6 条（001/002/003/004/011/041）、未修复 1 条（009，排版切换仍丢阅读位置）、部分通过 1 条（010 症状①通过/症状②未完成）；GUI 回归未完成 14 条（005/006/008/012/040/025/026/027/028/029/030/031/032/033，含无单机 GUI 路径者），状态「已修复待回归」。BUG-007 维持 skipped（未修复）不变。

---

## 1. GUI 实测 Bug 详情

### BUG-001（P0）专注复习「完形→听写」轮转空输入触发 wordDiff Range 越界，整个应用闪退

- **模块**：生词本与复习·专注复习（崩溃点 VaultChallengeDictationCard）
- **来源**：【GUI 实测】（s7，M10-02 / M10-12 关联；findings/s7.json F-S7-00 与 F-S7-00b 合并，同根因）
- **详细描述**：听写卡判分面板在输入为空串时渲染「词级命中 hit%」，调用 `wordDiff(input, source.en)` 触发 Swift 运行时 `Range requires lowerBound <= upperBound` 断言，整个应用闪退。会话内两次崩溃（11:20:27 give-up 路径、11:51:12 完形评分后换卡路径），殊途同归到空 input，复现 2/2。该函数同时被 `ReaderReviewView.swift:1341` 使用，属共享核心缺陷。
- **复现步骤**：
  1. 生词本有 ≥2 词，进入专注复习；
  2. 第 1 关完形卡作答并评分（评分正常落库）；
  3. 轮转出第 2 关听写卡（`resetCard()` 清空输入框）——判分面板渲染即崩；或在听写卡直接点「听不出，看句子」（give-up，input 为空串）同样崩。
- **预期结果**：无论输入是否为空，判分面板正常显示词级命中与四档评分带。
- **实际结果**：2026-11-09 11:20:27 与 11:51:12 两次全应用闪退，应用窗口全部消失。
- **证据**：
  - 崩溃报告：`~/Library/Logs/DiagnosticReports/ImmersiveTranslator-2026-11-09-112027.ips`、`ImmersiveTranslator-2026-11-09-115113.ips`（EXC_BREAKPOINT，crashed thread 0：`_assertionFailure ← wordDiff ← VaultChallengeDictationCard.body (ReaderVaultView.swift:2170)`；atos dSYM UUID 与崩溃二进制一致）
  - stdout：`/tmp/qa-s7-app-stdout.log`、`/tmp/qa-s7-app-stdout2.log` 末行 `Fatal error: Range requires lowerBound <= upperBound`
  - 截图：`qa-artifacts/screenshots/s7/CRASH-full.png`、`CRASH2-full.png`、`M10-02-verdict.png`、`M10-12-card1-verdict.png`
  - 崩溃前 sqlite 只读：第 1 关评分已持久化（serendipity reps=1 dueAt=明天；ephemeral pass=1 int=3）
- **根因分析**：`Sources/ReaderCore/RecallJudge.swift:155` `for i in 1...m` 在 input 为空串（m=0）时构造 `1...0` Range 崩溃；`Sources/ImmersiveTranslator/ReaderVaultView.swift:2170`（与 `ReaderReviewView.swift:1341`）在听写卡 body 无条件调用 `wordDiff(input, source.en)`。同仓库 `SpeakLogic.computeCoachDiff:1018` 已是正确写法（`if m >= 1 && n >= 1` 守卫）。本会话已核对该代码现状与引用一致。
- **修复建议**：wordDiff DP 循环加 `if m >= 1 && n >= 1` 守卫（与 computeCoachDiff 同款），补空输入单测；同时覆盖 ReaderReviewView.swift:1341 调用点。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：13:10–13:15 实机重走原崩溃路径：书架「开始复习」→专注复习第 1 关完形卡输入 apple 评分「记住了」→轮转出第 2 关听写卡（空输入）直接点「听不出，看句子」→判分面板正常渲染「× 没想起来 / 词级命中 0%」与四档评分带，评分落库后会话正常收尾「本轮复习完成 🎉」。全程应用未闪退：进程持续存活、stdout 无 Fatal error、~/Library/Logs/DiagnosticReports/ 当日 0 条新报告（会话末 18:55 复查仍 0）。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b001-02~b001-07-*.png；当日 DiagnosticReports grep 输出（0 条）；`Tests/ReaderCoreTests/ReaderCoreTests.swift:446` testWordDiffEmptySidesDoNotCrash 在全量 1357 中通过（`qa-artifacts/results/regression-swift-test-1216.log`）。

### BUG-002（P1）禅模式开启后无任何 GUI 退出入口，设置持久跨启动

- **模块**：阅读室·禅模式（M09-09）
- **来源**：【GUI 实测】（s7；findings/s7.json F-S7-03）
- **详细描述**：从播放条「视图」菜单进入禅模式后，播放条与视图菜单整体隐藏，只剩浮动三键控制（上句/播放/下句）；完整设置抽屉、快速浮层、顶栏、Esc、关窗重开均无退出路径。zenMode 属持久设置（global readerGlobalSettings + 文章 patch 双落盘），跨启动保持——用户只能改 plist/删文章才能恢复。测试环境遗留 zenMode=true（global + CDC 文章 patch）。
- **复现步骤**：
  1. 阅读室播放条「视图」菜单 →「禅模式 · 隐藏侧栏与播放条」；
  2. 依次尝试：视图菜单（已隐藏）、完整设置抽屉、快速浮层、浮动控制、Esc、关窗重开。
- **预期结果**：禅模式可退出恢复（QA_TEST_CASES M09-09 预期「可退出恢复」）。
- **实际结果**：全 UI 无任何禅模式开关或退出入口；AX 全文检索「禅/视图/AXMenuButton」0 命中；重启应用后仍处禅模式。
- **证据**：`qa-artifacts/screenshots/s7/M09-09-zen-on.png`、`M09-09-zen-drawer-no-exit.png`；defaults 只读核对 `readerGlobalSettings.zenMode=true` + CDC 文章 patch zenMode=true（s7.md）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderViews.swift:5072-5073` 是 zenMode 唯一写入点（视图菜单项本身）；`:35` dockVisible 与 `:85` zen 分支使该菜单随 zenMode=true 整体隐藏——形成「进了就出不来」。本会话核对：ZenControlsView（ReaderViews.swift:5087-5122）只有上句/播放/下句三键，无退出项；全局仅此一处写 zenMode。
- **修复建议**：禅模式浮动控制加退出按钮，或完整抽屉加「禅模式」开关行，或保留 Esc 退出快捷键。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：13:50–13:54 播放条「视图」→禅模式：播放条与视图菜单隐藏、浮动三键右侧出现「退出禅模式」按钮→点击后侧栏、播放条与右栏全部恢复；defaults `readerGlobalSettings.zenMode` 实测 true→false，文章覆盖 settings.zenMode=false（json 读取）。跨启动复核：15:58 重启应用后阅读室未处于禅模式。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b002-01~b002-03-*.png；plistlib 读 readerGlobalSettings 输出（zenMode True→False）。

### BUG-003（P1）登出后登录窗重开残留「登录成功」态且无法再次登录（需重启应用）

- **模块**：账号·登录窗（M07-01/07-08 关联）
- **来源**：【GUI 实测】（s5；findings/s5.json F1）
- **详细描述**：登录成功后登出（或令牌过期），再次点托盘「账号登录」，窗口直接显示上一场登录的「✓ 登录成功 / 进入账号管理 / 窗口即将自动关闭」，且不再自动关闭；无任何入口回到邮箱/验证码/密码页；同屏设置窗显示「未登录」，两窗状态互相矛盾。本会话内用户完全无法再登录，唯一出路是重启应用（s5 因此重启应用 11 次）。
- **复现步骤**：
  1. 托盘「账号登录」→ 验证码或密码登录成功（登录窗 900ms 自动关闭）；
  2. 设置→账号→登出（或令牌自然过期）；
  3. 再次点托盘「账号登录」。
- **预期结果**：重开回到邮箱页（或已登录兜底卡），可正常再次登录。
- **实际结果**：窗口显示残留成功态、不自动关闭、无法回到登录表单；需重启应用。
- **证据**：`qa-artifacts/screenshots/s5/BUG3-reopen-stale-success.png`（残留成功态）、`M07-08-after-logout2.png`（同屏设置=未登录）。
- **根因分析**：`Sources/ImmersiveTranslator/App.swift:363` loginController 为 lazy 单例；`Sources/ImmersiveTranslator/LoginWindowController.swift:113` `isReleasedWhenClosed=false` 使 SwiftUI view 状态（含 .success、email、cooldown）跨开闭存活；`:245` `onAppear(bootstrapState)` 只在首次装载运行；`:259-260` 900ms 自动关窗挂在 `onChange(of: view)` 上，重开时 view 已是 .success 不再变化、不触发。本会话核对代码现状一致。
- **修复建议**：窗口 show 时重置 view/表单状态（或改为每次 show 重新 bootstrap），并让成功态兜底超时关窗。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：13:21–13:33（debug 走 127.0.0.1:8090 mock）验证码登录成功后 900ms 自动关窗→设置→账号→登出（mock `auth.logout ok`）→托盘「账号登录」重开：窗口直接回到邮箱页（无残留「登录成功」态，邮箱可重新输入）→第二次 OTP 登录成功并正常自动关窗；已登录态再点「账号登录」不再弹出残留成功窗（无新窗口）。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b003-01~b003-13-*.png；qa-artifacts/mock/s5-requests.log 13:22:59 与 13:32:02 两条 `auth.otp.verify ok`、13:28:05 `auth.logout ok`。

### BUG-004（P1）纯云端拉取的笔记删除静默失败并在重启后复活

- **模块**：沉浸阅读室·笔记库 / 云同步（M13-08，数R3 预判证实）
- **来源**：【GUI 实测】（s5；findings/s5.json F2）
- **详细描述**：仅存在于云端（纯拉取、本地 notes/ 目录为空）的笔记，右键删除经确认弹窗后 UI 提示「笔记已删除」，但学习库实体保持 deleted=0/dirty=0——无 tombstone、无推送；重启应用后笔记原样复活。删除静默失败且 UI 谎报成功。
- **复现步骤**：
  1. 端 2 在云端建笔记（测试用 mock 注入 QA-S5-SERVER-NOTE.md）；
  2. 本机登录该账号纯拉取（笔记出现在「笔记与复习→全部笔记」，磁盘 notes/ 为空）；
  3. 右键该笔记 →「删除这篇笔记」→ 确认「删除后不可恢复」；
  4. 重启应用。
- **预期结果**：删除生效（本地 tombstone + 同步传播），重启后不出现。
- **实际结果**：toast「笔记已删除」，DB 实体 deleted=0/dirty=0，mock 日志删除后无任何 notes push；重启后笔记复活。
- **证据**：`qa-artifacts/screenshots/s5/M13-08-all-notes-list.png`、`M13-08-note-after-delete.png`、`M13-08-note-deleted-ui.png`、`M13-08-note-revived-after-restart.png`；entities 表快照（QA-S5-SERVER-NOTE.md deleted=0 dirty=0 baseVersion=3）；`qa-artifacts/mock/s5-requests.log` 删除后无 notes push。
- **根因分析**：`Sources/ImmersiveTranslator/NoteStore.swift:188-195` delete() 先查磁盘文件存在性（`guard FileManager.default.fileExists ... else { return false }`）——纯拉取笔记 hydrate 只进 files 表不落盘，fileExists=false → return false；调用点 `Sources/ImmersiveTranslator/ReaderViewModel.swift:2676` `_ = try? noteStore.delete(file: file)` 吞掉返回值后无条件 `showToast("笔记已删除")`（:2682）。本会话核对代码现状一致。
- **修复建议**：纯拉取路径按 files 表内容判定存在性（或 hydrate 落盘）；delete 返回 false 时向 UI 上浮失败。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：14:08–15:59 全链路实测：经 mock `/v1/qa/inject` 注入 QA-REGR-SERVER-NOTE.md→登出/登入纯云端拉取（sqlite entities 有行、磁盘 notes/ 目录为空、files 表有内容）→右键「删除这篇笔记」→确认→toast「笔记已删除」→sqlite 实体 deleted=true dirty=true、files.content=NULL→再登出/登入触发同步：mock `sync.push collection=notes accepted=1`，服务端实体 deleted=true、payload=null（version 208）→15:58 重启应用+重新登录→「笔记与复习」笔记库=1，被删笔记未复活；本地实体 deleted=true dirty=false（推送后清除）。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b004-02~b004-07-*.png；qa-artifacts/mock/s5-requests.log（16:06:54 notes pull returned=1、17:58:20 notes push accepted=1）；`sqlite3 -readonly` 各阶段查询输出（见 qa-artifacts/results/regression-2026-11-10.md）。

### BUG-005（P1）默认「混合」OCR 预设（en-US 优先）对中文素材输出乱码或 0 字符

- **模块**：截图 OCR（M04-01）
- **来源**：【GUI 实测】（s3；findings/s3.json BUG#1，宿主 Vision 对照实验链完整）
- **详细描述**：默认「混合」（autoMixed）预设下框选清晰中文素材，两次识别均输出 19 字符拉丁乱码「TERMITTER OCR E97R」（稳定复现）；框选白底黑字中文卡片输出 0 字符。乱码进入译文与翻译历史（source=screenshotOCR）。默认预设下中文截图 OCR 主路径不可用。
- **复现步骤**：
  1. 保持 OCR 识别语言=「混合」（defaults ocrLanguagePreset=autoMixed）；
  2. 屏幕准备清晰中文文本；⌃⌥Space 框选覆盖四行中文，Enter 确认；
  3. 观察 OCR 预览识别文本；确认翻译后查看历史。
- **预期结果**：识别出框选区域的中文文本（同硬件 Vision 对照可完整识别 4 行中文，conf 0.3~1.0）。
- **实际结果**：输出「TERMITTER OCR E97R」（两次完全一致）或 0 字符；「中英」（zh-Hans 优先）与「日文」预设同图识别完全正常。
- **证据**：`qa-artifacts/screenshots/s3/M04-01-preview-panel-232029.png`、`M04-01-retry2-232525.png`、`M04-01-confirm-translate-232149.png`、`M04-04-japanese-234942.png`（日文正常旁证）；diagnostic.log `ocr.recognition.complete textLength=19/19/0`（autoMixed）vs `123/46`（其他预设）；宿主对照实验 `/tmp/qa-s3-tools/`（direct_capture/pipeline_matrix/transition_test，排除抓帧区域、遮罩帧、过渡帧三假设，变量锁定为语言列表顺序）。
- **根因分析**：`Sources/ImmersiveTranslator/Settings.swift:545` autoMixed 预设语言列表 `["en-US", "zh-Hans", "zh-Hant", "ja-JP", "ko-KR"]` en-US 首位；宿主实验证明同图仅把语言列表换成 zh-Hans 优先即识别正常；且 `Settings.swift:560` autoMixed 的 fallbackPresets 为空数组，无二次识别兜底。
- **修复建议**：autoMixed 语言顺序调整（zh-Hans 前置）或二段式识别取文本似然更高者；注意保持英文素材可用。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（⌃⌥Space 框选需真实屏幕交互；进行至 16:58 时机器被用户占用，HID 输入自动化中止）。代码核对 `Sources/ImmersiveTranslator/Settings.swift:568-572`（autoMixed automaticallyDetectsLanguage）+ `Sources/ImmersiveTranslator/OCRReader.swift:126-127`；OCRLanguagePresetTests 3 用例（走真实 Vision）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-006（P1）正文段翻译请求 hang：无超时、无反馈、无恢复入口，切文后静默丢弃

- **模块**：阅读室·翻译管线（M09-01 关联）
- **来源**：【GUI 实测】（s6；findings/s6.json F1）
- **详细描述**：导入的短文标题段译文正常出现后，2 个正文段翻译永久 hang：UI 停留「翻译中 1/3 段」超 8 分钟，无失败标记、无 toast、无重试入口；期间 `lsof -a -p <pid> -iTCP` 无任何 TCP 连接（请求未在途，卡在应用内部 await）；切出文章再回来 chip 静默消失（run 失效），正文段永远 pending，重开文章不自动恢复。非系统性（对照 Selfish Giant 32 段 30s 内正常完成）。
- **复现步骤**：
  1. 导入一篇短文（粘贴，2 正文段+标题）；
  2. 观察顶栏翻译徽标：标题译文出现（1/3 段 done），正文停留「翻译中 1/3 段」；
  3. 等待 8 分钟以上；`lsof -a -p <pid> -iTCP` 核对无连接；
  4. 切出文章再回来；重开应用再打开该文章。
- **预期结果**：段翻译失败/超时有终态（失败标记 + 「重试 N 个失败段」按钮或限流 toast「继续翻译」），用户始终有恢复入口。
- **实际结果**：单次翻译组永久 hang，无任何用户可见反馈或恢复手段；重开文章不恢复。
- **证据**：`qa-artifacts/screenshots/s6/M08-02-translation-streaming.png`（0/3→1/3）、`M09-01-translation-60s.png`（+60s 仍 1/3）、`M09-01-scrolled.png`、`article-reopened.png`（重开后 chip 消失、无重试按钮）；会话内命令证据 lsof 空 + 对照组正常。
- **根因分析**：未精确定位（单次复现）。管线上无整体超时与终态兜底：`Sources/ImmersiveTranslator/ReaderViewModel.swift:1483-1490` 逐段 `await translateGroupWithBackoff`，`Sources/ImmersiveTranslator/ReaderChatClient.swift:294-326` streamDeltas 收流无看门狗（180s 仅 URLSession 空闲语义），失败分桶（ReaderViewModel.swift:1676-1690）依赖 outcome 返回——若收流/解析环节挂起则永不返回，段落停在 pending。静态旁证：收流 Task 在主 actor 逐字节搬运（BUG-039 同点位）。
- **修复建议**：给单段请求加整体超时与超时终态（标 failed + 重试入口）；复测时先验证该点位。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（复现 stall 流需 SIGSTOP mock + 等待 180s 看门狗，会话中止于 16:58）。代码核对 `Sources/ReaderCore/ParagraphTranslate.swift:147`（180s 看门狗常量）+ `Sources/ImmersiveTranslator/ReaderChatClient.swift:281/311/328-336`（completeStreaming 接线 + WatchdogFeed）；ReaderChatStreamWatchdogTests 3 用例（本地 stall SSE，真实 URLSession.bytes 管线：stall 抛 timedOut/喂狗不误伤/nil 保持旧行为）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-007（P2）固定目标语言模式下「目标语言」输入不落盘、不生效

- **模块**：设置中心·翻译/译文目标（M03-03 子项）
- **来源**：【GUI 实测】（s2；findings/s2.json BUG#1）
- **详细描述**：翻译方向切「固定目标语言」后，在「目标语言」字段键入 English（界面显示 ✓已自动保存、AX 回读字段值=English），但 defaults `targetLanguage` 恒为空串；切到其他设置页再回来字段被清空；此模式下翻译任何文本（含纯英文）一律回落简体中文。`translationDirection=fixedTarget` 本身持久化正常。
- **复现步骤**：
  1. 设置→翻译→译文目标，切「固定目标语言」；
  2. 「目标语言」键入 English，观察 ✓已自动保存；
  3. `defaults read ImmersiveTranslator targetLanguage`；切换设置页再回来；
  4. 翻译纯英文文本，看目标语言。
- **预期结果**：键入值持久化并在 fixedTarget 下生效（英→英文本译为 English）。
- **实际结果**：targetLanguage 恒空串；切页后字段清空；英→英译文为【QA-MOCK|→简体中文】（回落行为与 resolvedTargetLanguage 代码一致，回落逻辑本身正确）。
- **证据**：`qa-artifacts/screenshots/s2/BUG1-targetlang-typed-english.png`、`BUG1-targetlang-cleared-after-page-switch.png`、`BUG1-fixedtarget-en-text-got-zh.png`；终端 defaults 输出（空串）；所有键入经真实键盘事件（System Events keystroke），AX setValue 干扰已用回车+失焦对照排除。
- **根因分析**：键入未进入 SwiftUI 绑定（显示与存储不同步），机制未定位。相关代码：`Sources/ImmersiveTranslator/Settings.swift:2364`（条件渲染 `labeledField("目标语言", text: $settingsStore.targetLanguage)`，:2363 `if translationDirection == .fixedTarget`）、`:29-31`（@Published + didSet 落 defaults）。自动保存路径（Settings.swift:2965-2972）只做快照比对不回写绑定。待修复时先定位绑定断点。
- **修复建议**：定位字段绑定未更新的机制（疑与条件渲染重建/焦点时序相关）后修复绑定；补切页往返回归用例。
- **修复状态**：待修复

### BUG-008（P2）浮窗「自动隐藏」开启后翻译完成即隐藏（<1s），而非 16 秒

- **模块**：翻译浮窗·自动隐藏（M03-12b 子项）
- **来源**：【GUI 实测】（s2；findings/s2.json BUG#2）
- **详细描述**：开启浮窗头部 ⏱ 自动隐藏开关（defaults translationPanelAutoHide=1）后，翻译完成时浮窗 0.5–1s 内即 orderOut，远早于既定 16 秒；开启该选项的用户基本读不到译文。判别实验：关闭开关后同流程浮窗 20s+ 稳定留存；错误卡在开关开启时 >17s 留存（guard 逻辑部分有效，仅 success 态受影响）。
- **复现步骤**：
  1. 浮窗头部 ⏱ 开启自动隐藏；
  2. 触发划词翻译并等待完成；
  3. itqa list 逐秒采样窗口可见性。
- **预期结果**：完成后保持 16 秒再隐藏（`scheduleAutoHideIfNeeded` 的 Task.sleep 16_000_000_000 与提示文案「16 秒后自动隐藏」）。
- **实际结果**：完成时可见、+1s 起 GONE（3 次逐秒采样一致）。
- **证据**：`qa-artifacts/screenshots/s2/M03-12a-pinned-18s-visible.png`、`M03-12c-error-no-hide-17s.png`；itqa list 逐秒输出（t=2s win#37419 可见 → t=3s..8s GONE）。
- **根因分析**：未精确定位（机制与代码矛盾）。`Sources/ImmersiveTranslator/TranslationPanel.swift:755-778` scheduleAutoHideIfNeeded 为 16s 定时 + 四重 guard，与实测「完成即隐」不符——疑完成路径另有 orderOut 或定时基准错误。待修复时先在全量 orderOut 调用点定位提前隐藏源。
- **修复建议**：定位提前 orderOut 路径；补「开启自动隐藏后 success 态存活 16s±1s」回归用例。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（需划词翻译 + 逐秒采样浮窗，HID 自动化中止）。代码核对 `Sources/ImmersiveTranslator/TranslationPanel.swift:757/770-778`（Task.sleep 之后与隐藏块 guard 各加 Task.isCancelled 检查）；TranslationPanelAutoHideTests 3 用例（真实 NSPanel + 注入短延时）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-009（P2）排版「段落⇄对照」切换导致当前阅读位置重置

- **模块**：阅读室·排版（M09-16；s6 F2 与 s7 独立复现合并）
- **来源**：【GUI 实测】（s6 Selfish Giant 74→31→1；s7 CDC 文章 21→12→1，两会话两篇文章独立复现）
- **详细描述**：每次排版切换 activeSentenceIdx 重置/漂移：播放条与右栏句号同步跳变，用户丢失阅读位置；续读胶囊显示的持久化进度（第 83 句）与当前句（第 1 句）脱节，佐证是视图切换时的 activeSentence 重置而非进度数据丢失。
- **复现步骤**：
  1. 打开文章，播放/跳句到第 N 句（N 较大，如 74）；
  2. 阅读设置→排版切「对照」→ 读位置；
  3. 再切回「段落」→ 读位置。
- **预期结果**：切换生效且当前阅读位置不丢失（QA_TEST_CASES M09-16）。
- **实际结果**：74→31→1（s6）；21→12→1（s7）。
- **证据**：`qa-artifacts/screenshots/s6/M09-05-parse-done.png`、`M09-16-dual3.png`、`M09-16-paragraph-back.png`；`qa-artifacts/screenshots/s7/M09-16-before-21.png`、`M09-16-dual.png`、`M09-16-paragraph-back.png`。
- **根因分析**：排版切换重建正文视图后，「滚到哪读到哪」的视口回写把当前句重置为视口顶部附近句：`Sources/ImmersiveTranslator/ReaderViews.swift:2140-2142`（帧重算后 adoptViewportFrames）→ `:2250-2258` adoptViewportFrames → `viewportMoved` → `Sources/ImmersiveTranslator/ReaderViewModel.swift:2019-2026` 未播放时直接改 activeSentenceIdx。机制为静态推断（与两会话观测吻合），待修复时以断点确认。
- **修复建议**：切换排版时保留 activeSentenceIdx 并主动滚动定位到原句（切换后禁用一次视口回写）。
- **修复状态**：未修复（2026-11-10 回归轮复现）
- **回归结果（2026-11-10 回归轮，回归测试员）**：16:05–16:29 复现（The Selfish Giant，88 句）：段落排版当前句 83 → 切「对照」后当前句=45（大幅回退）；对照 45 → 切「段落」保持 45；段落 45 → 切「对照」=25（再次大幅回退）；对照 25 → 切「段落」=23（小幅漂移）。四次切换三次丢失/漂移阅读位置，「段落→对照」方向两次复现大幅回退（83→45、45→25），与原缺陷机理一致（排版切换重建视图后视口回写重置当前句）——修复的「首帧不回写+滚回当前句」未生效或被后续帧回报覆盖。每次排版切换均为当次唯一事件（排版 pill 单次点击），无内容点击干扰。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b009-02（段落 83）→b009-06（对照 45）→b009-09（段落 45）→b009-15（对照 25）→b009-17（段落 23）-*.png。附注：b009-05/12/13/14 为排版 pill 合成点击未命中的无效尝试（画面无任何变化），不构成上述序列的状态变化。

### BUG-010（P2）学词笔记「取消生成」语义错误：取消被报成接口故障或把截断稿当完整笔记存档

- **模块**：生词本与复习·学词笔记（M10-05）
- **来源**：【GUI 实测】（s7；findings/s7.json F-S7-01）
- **详细描述**：① 首字前取消（复现 2/2）：弹层进入错误页「笔记生成失败 / 接口返回空内容。」——用户主动取消被报成接口故障；② 流式出字后取消：弹层显示「✓ 校验通过…已自动存入笔记库」，218B 截断稿以 partial=false 存为完整笔记（notes/学词笔记-2026-11-09-2.md，frontmatter partial:false words=3），笔记库无「未完成」标记，且把 3 个词全部计为已整理（「1 词未整理」徽标消失）。既定语义（ReaderNoteDialog.swift:230-241/337-345）：无内容→「已取消——还没生成任何内容，未存入笔记库」；有内容→「已取消——上面是已生成的部分」并按 partial 存档。取消语义整体失效。附带：关弹层后笔记库列表未即时刷新（切 tab 后才出现新笔记）。
- **复现步骤**：
  1. 生成新笔记→选词→开始生成，3.5s 内（未出首字）点「取消生成」→观察错误页；
  2. 再次生成，待正文流出首段后立即点「取消生成」→观察存档结果与笔记库。
- **预期结果**：取消终止流式：无内容提示已取消未存档；有内容提示已取消并按 partial=true 存档，词条不计为已整理。
- **实际结果**：①错误页「接口返回空内容」；②截断稿按 partial=false 存档、词条计为已整理。
- **证据**：`qa-artifacts/screenshots/s7/M10-05-cancelled.png`、`M10-05-cancel-repro2.png`、`M10-05-cancel-partial.png`、`M10-05-library-truncated-note-listed.png`；`~/Library/Application Support/ImmersiveTranslator/notes/学词笔记-2026-11-09-2.md`（218B，partial:false）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderChatClient.swift:277-284` completeStreaming 的流消费在任务取消时正常结束循环（不抛 CancellationError）：空串→throw .empty（被渲染成接口故障）、非空→当作完整结果返回（partial=false 落库）；`Sources/ImmersiveTranslator/ReaderNoteDialog.swift:337-345` 的 `catch is CancellationError` 分支因此不可达。
- **修复建议**：流消费在 Task.isCancelled 时抛 CancellationError（或显式传递取消态），让取消分支接管；partial 存档路径补单测。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：部分回归：症状①（首字前取消报「接口返回空内容」）已回归通过——16:49 以 SIGSTOP 暂停 8090 mock 使生成请求 0 字节到达后点「取消生成」，弹层状态行显示「已取消 —— 还没生成任何内容，未存入笔记库」（原缺陷报「笔记生成失败/接口返回空内容」）；sqlite 无新 notes 实体、notes/ 目录无新文件。症状②（流式出字后取消应按 partial=true 存档）GUI 未完成：mock 流约 0.5s 即完成，两次尝试（16:41、16:55）未能在流中命中「取消生成」（弹层随即进入完成态被关闭），会话因机器被用户占用而中止。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b010-10-cancel-nochar-164904.png；AXStaticText 取证「已取消 —— 还没生成任何内容，未存入笔记库」（s7ax find 输出）；sqlite3 notes 实体仅 4 条既有行、notes/ 目录 0 文件；`Tests/ImmersiveTranslatorTests/ReaderChatCancellationSemanticsTests.swift` 2 用例（含首个增量后取消抛 CancellationError、截断稿不作为返回值）在全量 1357 中通过（`qa-artifacts/results/regression-swift-test-1216.log`）。

### BUG-011（P2）快速复习窗评分后阅读室「笔记与复习」不刷新：已评词仍显示到期，可被重复复习

- **模块**：生词本与复习·跨窗口一致性（M10-07/M10-11 关联）
- **来源**：【GUI 实测】（s7；findings/s7.json F-S7-04）
- **详细描述**：快速复习迷你窗评分后（sanguine→明天、bundle→10 分钟后），托盘按 30s 调度正确刷新（角标/「N 到期」消失），但阅读室「笔记与复习」长期停留在旧快照：导航岛徽标 2、Hero「今天有 2 条要复习」、胶带列表仍列已评词；点「开始复习」进入专注复习第 1 关仍是明天才到期的 sanguine——重复评分会打乱 SRS。离开再进入页面（13:51 复查）仍不刷新；重启应用后视图与存储恢复一致（陈旧仅存在于运行期内存）。风险叠加：用户据伪到期词进入专注复习，第 2 关听写卡即触发 BUG-001 崩溃。
- **复现步骤**：
  1. 阅读室已打开（笔记与复习页曾访问过），生词到期；
  2. 托盘「快速复习」评分全部到期词→结束页「今天收工」，托盘角标消失；
  3. 切回阅读室→笔记与复习，核对徽标/Hero/队列。
- **预期结果**：评分后所有视图到期数与队列一致；已评且未到期的词不再出现在今日复习队列。
- **实际结果**：阅读室仍显示 2 到期并可对已评词再次进入专注复习；仅重启后才一致。
- **证据**：`qa-artifacts/screenshots/s7/M10-03-bundle-grade1.png`、`M10-11-tray-after-grade.png`（托盘 0 到期）、`M10-03-before-regrade.png`（阅读室仍 2 到期）、`M10-03-regrade-card.png`（专注复习仍出 sanguine）、`M10-11-vault-stale-after-qr.png`；sqlite 只读：sanguine dueAt=11-10 13:34、bundle dueAt=11-09 13:47（评分已落库）。
- **根因分析**：快速复习窗评分直写存储不广播：`Sources/ImmersiveTranslator/QuickReviewWindow.swift:234-267` grade → gradeVocabWord 后仅调 `ReviewTouchpointManager.refreshBadge()`（:256），无 NotificationCenter 通知；阅读室 VM 只订阅 `.readerVocabAdded`/`.learningSyncComplete`（`Sources/ImmersiveTranslator/ReaderViewModel.swift:409-424`）刷新词表，评分不属二者。
- **修复建议**：评分落库后广播词表变更（复用 .readerVocabAdded 或新增 .vocabGraded），阅读室 VM 订阅刷新。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：16:01–16:04 经托盘「快速复习（3 到期）」打开迷你窗，评分 serendipity（Space 翻面→按 4=眼熟）：评分落库后无需重启、无需离开页面，身后的阅读室「笔记与复习」即时刷新——生词本复习徽标 3→2、今日进度「2/5 还差 3 条」→「3/5 还差 2 条」、掌握阶段 刚收集 2→1 / 眼熟 4→5、左侧全部计数 3→2、单词 2→1；迷你窗推进到下一张卡（sanguine）。修复前阅读室停留在旧快照（仅重启后才一致）。
- **回归证据**：截图 `qa-artifacts/screenshots/regression/b011-02`（评分前：徽标 3 / 还差 3 条）→`b011-04`（评分后：徽标 2 / 还差 2 条）`-*.png`（同一画面同框迷你窗与阅读室两侧数值）；代码核对 `Sources/ImmersiveTranslator/CollectActions.swift:14`、`Sources/ImmersiveTranslator/QuickReviewWindow.swift:260/299`、`Sources/ImmersiveTranslator/ReaderViewModel.swift:415`；ReaderReviewGradedBroadcastTests 2 用例在全量 1357 中通过（`qa-artifacts/results/regression-swift-test-1216.log`）。

### BUG-012（P2）托盘菜单 OCR 热键镜像不随设置即时刷新（实际键已切换）

- **模块**：全局外壳·托盘菜单（M01-10）
- **来源**：【GUI 实测】（s1；findings/s1.json #1）
- **详细描述**：设置→快捷键经「推荐」chip 把截图 OCR 热键由 ⌃⌥Space 改为 ⌥Space（改完即自动保存并重新注册，状态行显示新值），立即点开托盘菜单：翻译行镜像即时刷新为 ⌃⌥T（char=T mod=14 ✓），但「截图翻译 (OCR)」行两次重开菜单仍显示旧值 ⌃⌥Space（char=' ' mod=14）——镜像与实际注册不一致；实测旧键 ⌃⌥Space 已失效（按下无反应）、新键 ⌥Space 已生效（出现全屏框选遮罩）。恢复默认后镜像重新一致。
- **复现步骤**：
  1. 设置→快捷键→推荐 chip 改 OCR 热键为 Option+Space；
  2. 立即打开托盘菜单（重开两次复核）；
  3. 对照实测两枚组合的实际行为。
- **预期结果**：菜单热键镜像即时刷新为 keyEquivalent（应显示 ⌥Space）。
- **实际结果**：OCR 行两次重开菜单仍显示 ⌃⌥Space；旧键已失效、新键已生效。
- **证据**：`qa-artifacts/screenshots/s1/M01-10-ocr-mask-onspace.png`（⌥Space 生效为 OCR 遮罩实拍）；AX 读取：翻译行 char=T mod=14（已更新）、OCR 行 char=' ' mod=14（旧值）；diagnostic.log `hotkey.register selection=… ocr=Control + Option + Space` 与菜单旧值矛盾（此时 OCR 已应为 Option + Space）。
- **根因分析**：未精确定位（时序类）。菜单重建读的是当前设置值（`Sources/ImmersiveTranslator/App.swift:598-607` rebuildStatusMenu），`$ocrHotKeyShortcut` 订阅会 registerHotKeys + refreshMenu（App.swift:749-755）；但设置侧自动保存路径对热键变更只调 `onReregisterHotKeys()`→`registerHotKeys()`，不调 refreshMenu（`Sources/ImmersiveTranslator/Settings.swift:2965-2968` → App.swift:340-342）——chip 改两行时若 ocr publisher 的 refreshMenu 先于其值写入执行，菜单即带旧值且无人再刷。待修复时以日志确认两路时序。
- **修复建议**：统一入口：热键变更后 registerHotKeys 与 refreshMenu 同步执行（onReregisterHotKeys 内追加 refreshMenu）。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（需设置页改热键 + 即时开托盘菜单核对镜像，HID 自动化中止）。代码核对 `Sources/ImmersiveTranslator/App.swift:748/757/766`（三条热键订阅链 `.receive(on: DispatchQueue.main)`）。
- **回归证据**：代码证据同上。

### BUG-013（P3）兑换码 429 未透传 retryAfter 提示（只显示兜底文案）

- **模块**：账号·兑换码（M07-09e 子项）
- **来源**：【GUI 实测】（s5；findings/s5.json F3）
- **详细描述**：兑换被限流（mock 返回 429 + Retry-After: 2 + details.retryAfterMs:2000）时，红条只显示兜底文案「兑换失败，请稍后再试」，无等待秒数；用例 M07-09e 预期「429 时透传 retryAfter 提示」。
- **复现步骤**：登录态→设置→账号→兑换码→输入 QA-S5-429-RATE→点兑换。
- **预期结果**：提示等待秒数。
- **实际结果**：只显示兜底文案。
- **证据**：`qa-artifacts/screenshots/s5/M07-09e-429-result2.png`；`qa-artifacts/mock/s5-requests.log` redeem code=QA-S5-429-RATE。
- **根因分析**：`Sources/ImmersiveTranslator/RedeemService.swift:30-41` redeemErrorText 仅映射 redeem_code_not_found/expired/used 三码，rate_limited 落 default（注释口径「绝不透传服务端 message」——retryAfter 属结构化字段而非 message，可安全透传）。
- **修复建议**：rate_limited 分支读取 retryAfterSeconds 拼入文案。
- **修复状态**：确认不修复（P3，本轮不安排；修复成本低，若产品要求透传可随 P2 批次带上）

### BUG-014（P3）生词 rail「未整理」提示文案误导

- **模块**：生词本与复习·rail 未整理徽标（M10-01 附带）
- **来源**：【GUI 实测】（s7；findings/s7.json F-S7-02）
- **详细描述**：对 3 个正常划词收藏英文单词，rail 显示「有 3 条内容未整理，可能不是词汇（如命令行）。」——「可能不是词汇」只适用于命令行/代码粘贴收藏的特殊条目，对普通生词与实际数据无关（历史窗口/浮窗「加入生词本」正文同文案）。
- **复现步骤**：划词收藏若干普通单词→打开笔记与复习→看左栏 rail 底部。
- **预期结果**：提示描述「还没整理进笔记」的事实（如「N 词未整理，可生成复习笔记」）。
- **实际结果**：固定断言「可能不是词汇（如命令行）」。
- **证据**：`qa-artifacts/screenshots/s7/M10-01-vault-home-3words.png`、`M10-05-select-phase.png`。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderVaultView.swift:326-340` railNote 只要 unnotedWordCount>0 就显示该固定文案（本会话核对 ：330 文案原样存在），未按收藏来源区分。
- **修复建议**：按来源区分文案或改为中性描述。
- **修复状态**：确认不修复

### BUG-015（P3）笔记库 AI 复盘「只测仍错的词」点击后未进入专注复习（低置信度，待复核）

- **模块**：生词本与复习·笔记库 AI 复盘（M10-06；M10-12 路径 A 关联）
- **来源**：【GUI 实测】（s7；findings/s7.json F-S7-05）
- **详细描述**：AI 复盘落卡「0 词已过 · 2 仍错」后点「只测仍错的词（2）」，等待 5s 界面仍停在笔记库：AX dump 无专注复习页元素、无路由跳转、无报错/toast。置信度低：复现 1/1，点击投递方式未留痕、无点击后截图、未重试；发生在 BUG-001 崩溃重启之后，疑与运行期状态有关。若复核确认建议升 P2（复盘卡主动作失效）。M10-12 因该按钮落点即崩溃点位而整体 BLOCKED，未获第二样本。
- **复现步骤**：有生词与一篇学词笔记→打开笔记→AI 复盘区「生成复盘」→落卡后点「只测仍错的词（N）」→等 5s 观察路由。
- **预期结果**：进入专注复习，队列只排该笔记仍错的词。
- **实际结果**：无跳转无提示，停留在笔记库。
- **证据**：`qa-artifacts/screenshots/s7/M10-06-replay-done2.png`；AX dump 结论见 qa-artifacts/results/s7.json M10-06/M10-12 条目（会话内命令输出，未单独存档）。
- **根因分析**：待复核。对照代码 `Sources/ImmersiveTranslator/ReaderNotesView.swift:654-656` 按钮调 `vm.startFocusReview(ids: stillWeakIds)`，s7 怀疑 focus 跳转未生效（可能与崩溃重启后 focusReviewIds 状态有关），未定位。
- **修复建议**：崩溃修复后人工/自动化复测一次；若复现，排查 startFocusReview 的路由与 ids 传递。
- **修复状态**：确认不修复（P3；待复核后再定级）

### BUG-016（P3）同一实例两处登录态显示矛盾且期间无 auth 日志

- **模块**：设置中心/账号（观察项，建议 M06/M07 续跑复核）
- **来源**：【GUI 实测·观察】（s1）
- **详细描述**：同一 app 实例（PID 15782，未重启）内，12:20「模型服务」页沉浸云卡显示「已登录 deploy-smoke-…@example.com」，12:47 切到「账号」分区页头显示「未登录」+登录按钮；期间 diagnostic.log 无任何 auth/token/refresh/login 事件；且账号页「未登录」的同时 learning.sqlite 实体都在 smoke 账号命名空间下，语义混乱。
- **复现步骤**：同一实例内先看「模型服务」沉浸云卡，再切「账号」分区对比。
- **预期结果**：两处登录态同源一致；登录态变化有 auth 日志。
- **实际结果**：两处显示矛盾且日志无对应事件。
- **证据**：`qa-artifacts/screenshots/s1/OBS-cloudcard-logged-in-1220.png`、`OBS-accountpage-logged-out-1247.png`；diagnostic.log 03-04Z 时段 grep auth 类 0 条。
- **根因分析**：未定位。两处同读 serverAuth.status（Settings.swift:1894 / :1555 附近），疑缓存的 status.user 未随 loggedIn 失效清空；需在 M06/M07 续跑时用登出/登录流程复核。
- **修复建议**：续跑会话复核后定位 status 刷新与两处视图观察方式。
- **修复状态**：确认不修复（P3 观察项）

### BUG-017（P3）系统提示类浮窗状态行显示「deepseek-v4-flash · 1262.8s」类无意义 meta

- **模块**：翻译浮窗·状态行（M01-03 过程观察）
- **来源**：【GUI 实测·观察】（s1）
- **详细描述**：检查权限、快捷键注册提示等本地系统消息浮窗的状态行显示「系统提示 · deepseek-v4-flash · 1262.8s」——模型名与耗时对本地生成消息是噪声，数值随时间增长（≈距上次翻译活动时长），可能被误解为本次操作耗时。
- **复现步骤**：托盘→检查权限→观察浮窗状态行。
- **预期结果**：本地系统提示不显示模型名与耗时 meta。
- **实际结果**：显示「系统提示 · deepseek-v4-flash · 1262.8s」与「…488.9s」。
- **证据**：`qa-artifacts/screenshots/s1/M01-03-permission-panel-zoom.png`（meta 行放大）。
- **根因分析**：`Sources/ImmersiveTranslator/TranslationPanel.swift:194-197` show() 对所有消息统一设置 sourceLabel/modelLabel/targetLanguage（source 为 nil 时 label=「系统提示」但模型与耗时 meta 照常展示，:237 updateElapsedState）。本会话核对代码现状一致。
- **修复建议**：对 source=nil/isTranslationOutput=false 的系统消息隐藏模型与耗时 meta。
- **修复状态**：确认不修复

### BUG-018（P3）Edge TTS 连接被拒时 UI 无可感知反馈（代理环境快速拒绝场景）

- **模块**：阅读室·TTS（M02-08 过程观察）
- **来源**：【GUI 实测·观察】（s1；s6/s7 复测补充）
- **详细描述**：s1 首轮观察播放期间 `reader.tts.cloud-fallback kind=network error=connectionRejected`×5，UI 无可见错误、播放状态机无声推进。s6/s7 复测显示回落链路工作正常且有明确 toast（「云端朗读失败，已换系统朗读：网络失败；检查网络或代理后重试（离线可换用系统朗读）」）——s1 场景疑为 toast 前的窗口期或场景差异。本机 clash 代理对 wss 的处理是环境因素；相关深层问题见 BUG-025（无熔断）。
- **复现步骤**：阅读室播放，观察 diagnostic.log cloud-fallback 事件与 UI 反馈。
- **预期结果**：TTS 失败有可感知的错误/回落反馈。
- **实际结果**：s1 场景 UI 无可见反馈；s6/s7 场景 toast+回落正常。
- **证据**：diagnostic.log 01:30:59Z~01:46:08Z 五条 connectionRejected；`qa-artifacts/screenshots/s1/M02-08-article-3sents.png`；s6 findings「Edge TTS 回落 toast 文案明确」观察。
- **根因分析**：环境相关（代理 wss 快速拒绝）+ 反馈时序待查；关联 BUG-025。
- **修复建议**：随 BUG-025 一并评估；确认每句回落均有 toast 不漏发。
- **修复状态**：确认不修复（P3，环境相关）

### BUG-019（P3）合成事件对部分控件不响应家族（待真实鼠标人工复核）

- **模块**：多模块（翻译浮窗·词典卡 / OCR 预览 / 阅读室·网页导入）
- **来源**：【GUI 实测·观察】（s2 OBS-1、s3 OBS-2、s6 O4 合并；原家族中的「阅读室正文词块/查词交互」经 s6 补测探针定位为 mouseUp 缺陷，拆出升 BUG-041）
- **详细描述**：同一测试环境下，以下控件对合成点击/按键不响应，而同窗口其他控件均正常：① 词典卡「显示译文/显示词典卡片」切换链接与 🔊 发音按钮（像素级中心定位 4 次，s2）；② OCR 预览「粘贴并翻译」的 ⌘⌥Enter 键盘事件（slowclick 按钮路径正常，s3）；③ 导入弹层「抓取正文」按钮（AXPress/CGEvent 多点均不响应，字段焦点+Return 可触发，s6）。CGEvent 合成点击与真实鼠标在 HID 层等价，但不能排除 hover/命中区特例——需真实鼠标人工复核后才能定性为应用缺陷。
- **复现步骤**：逐控件按上述方式用合成事件触发，对照同窗其他控件。
- **预期结果**：全部正常触发。
- **实际结果**：上述三类控件合成事件全数被吞。
- **证据**：`qa-artifacts/screenshots/s2/`（M03-16 系列）、`s3/M04-06-paste-translate-235419.png`（按钮路径正常的对照）、`s6/M08-07-fetched5.png`、`M08-07-return.png`（Return 触发 + lsof 连接佐证）。
- **根因分析**：未定性（疑合成事件与 SwiftUI 控件交互的差异，待人工复核）。
- **修复建议**：人工真实鼠标逐项复核；确认后再立缺陷并定位。
- **修复状态**：确认不修复（P3，待人工复核定性）

### BUG-020（P3）401 token_invalid 后本地凭据 server_auth 未清除（口径待产品确认）

- **模块**：平台认证·错误处理（M03-10 过程观察）
- **来源**：【GUI 实测·观察】（s2 OBS-2）
- **详细描述**：mock 对翻译请求返回 401 token_invalid 后，浮窗正确显示「API Key 未通过认证」分类文案（含接口原始提示），但 `security find-generic-password -s local.immersive-translator.mvp -a server_auth` 仍命中——本地凭据未清。任务书口径「token_invalid 清凭据提示」：提示已满足，「清凭据」未发生，符合性视口径而定。
- **复现步骤**：mock 返回 401 token_invalid → 触发划词翻译 → 查错误卡与 Keychain。
- **预期结果**：〔口径相关〕若要求清凭据则不符；若仅要求提示则符合。
- **实际结果**：提示存在，清除未发生。
- **证据**：`qa-artifacts/mock/requests.log` 14:34:21 401 后 keychain 查询仍命中；M03-10 系列截图。
- **根因分析**：账号/同步链路的 token_invalid 会清凭据（`Sources/ImmersiveTranslator/ServerAuth.swift:623-626`），但浮窗翻译链路仅对 token_expired 做换票重放（`Sources/ImmersiveTranslator/TranslationClient.swift:242-257` platformReplayTokenAfter401 只认 token_expired），token_invalid 分支不清本地凭据。两条链路口径不一致。
- **修复建议**：产品确认浮窗翻译 401 invalid 是否应清凭据；若应，补清理与广播。
- **修复状态**：确认不修复（P3，口径待确认）

### BUG-021（P3）错误卡来源 badge 疑不反映真实方向判定

- **模块**：翻译浮窗·状态行（M03-09 过程观察）
- **来源**：【GUI 实测·观察】（s2 OBS-3）
- **详细描述**：剪贴板放纯英文文本触发划词翻译（断网），错误卡 badge 显示「没有完成 · 选中中文」，而目标语言为「简体中文」（判定本身正确）；成功卡对同样英文文本显示「选中英文」（M03-01）。疑错误路径 badge 复用上一态或固定文案，仅影响展示不影响判定。低置信度。
- **复现步骤**：剪贴板放英文→断网触发划词翻译→看错误卡 badge，与成功卡对照。
- **预期结果**：badge 与实际识别方向一致（选中英文）。
- **实际结果**：错误卡显示「选中中文」。
- **证据**：`qa-artifacts/screenshots/s2/M03-09-network-error-card.png` vs `M03-01-en2zh-clean.png`。
- **根因分析**：未定位（疑错误路径 sourceLabel 未按当次判定刷新，TranslationPanel.swift:194 附近 sourceLabel 赋值时序）。
- **修复建议**：复核后修错误路径 badge 刷新。
- **修复状态**：确认不修复（P3）

### BUG-022（P3）RSS 文章列表显示未转义 HTML 标题 + description 片段混入列表

- **模块**：阅读室·资讯订阅（M08-09）
- **来源**：【GUI 实测】（s6；findings/s6.json F3）
- **详细描述**：订阅 CDC Online Newsroom 刷新后：① 大量标题原样显示 HTML 标签（「…outbreak of <em>Salmonella </em>…」「<em>Program</em><em> invites all…</em>」等）；② 多条 RSS description 文本被当作独立条目混入列表（「Audio file also available.」「Three people have been hospitalized…」等无标题语义碎片，与所属文章重复出现）。
- **复现步骤**：导入弹层→资讯订阅→添加 CDC 推荐源→刷新→浏览列表。
- **预期结果**：标题为纯文本；列表条目与 RSS item 一一对应。
- **实际结果**：HTML 标签原样显示；description 片段混入。
- **证据**：AX 树 dump（s6 会话执行记录）：`@986,1544 val=[A CDC food safety alert … <em>Salmonella </em>…]`、`@986,2518 val=[Audio file also available.]` 等。
- **根因分析**：`Sources/ReaderCore/FeedCatalog.swift:285-296` title/summary 从 XML 原样取出，无 HTML 剥离；列表渲染层（FeedStore/FeedEntry）未做条目去重与清洗。
- **修复建议**：标题入库前剥 HTML 标签/解码实体；渲染层按 link 去重、过滤无标题语义碎片。
- **修复状态**：确认不修复（P3）

### BUG-023（P3）跟读主开关关闭后 shadowingAssess 子开关残留 true

- **模块**：阅读室·跟读（M09-11 附带缺陷记录）
- **来源**：【GUI 实测】（s7 观察 O-S7-02）
- **详细描述**：抽屉内开启「跟读模式」+「跟读评测」后关闭跟读主开关：shadowingMode 正确=false，但 defaults 里 shadowingAssess 残留=true；再次开启跟读时评测会带旧状态生效。
- **复现步骤**：开跟读模式+跟读评测→关跟读模式→`defaults read ImmersiveTranslator shadowingAssess`→再开跟读模式。
- **预期结果**：关主开关时子开关一并复位（或再开时不带旧态）。
- **实际结果**：shadowingAssess 残留 true 并随再开生效。
- **证据**：defaults 只读核对（s7.md M09-11 实际记录）；`qa-artifacts/screenshots/s7/M09-11-shadowing-expanded.png`、`M09-11-assess-on.png`。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderViews.swift:4372-4401` 条件渲染：关主开关只是隐藏子行，不清 shadowingAssess 值。
- **修复建议**：主开关 off 时同步清子开关。
- **修复状态**：确认不修复（P3）

### BUG-024（P3）多列橙色质量警示分支对 OCR 后文本不可达

- **模块**：截图 OCR·质量警示（M04-08b）
- **来源**：【GUI 实测·观察】（s3 OBS-1）
- **详细描述**：双列短行素材（6 行、1-2 段）OCR 后行内已无宽间隔，shortLineRatio/交替行长未达标，命中路径落在灰色「检测到字段、状态、数值或模型名结构」结构提示；橙色多列警示在本轮素材下不可达。判定逻辑本身按实现工作，是否需要针对双列 OCR 输出形态调参待产品确认。
- **复现步骤**：框选双列短行素材→看预览警示条类型。
- **预期结果**：〔产品确认项〕多列警示是否应命中。
- **实际结果**：命中灰色结构提示，橙色分支不可达。
- **证据**：`qa-artifacts/screenshots/s3/M04-08b-twocol-000148.png`。
- **根因分析**：`Sources/ImmersiveTranslator/TranslationPanel.swift` looksLikeMultiColumnOrRegion 的阈值（shortLineRatio/交替行长）针对原始版面设计，OCR 输出已丢失列间间隔。
- **修复建议**：产品确认是否需要针对 OCR 输出形态调整阈值。
- **修复状态**：确认不修复（P3，待产品确认）

### BUG-040（P2）EPUB 目录勾选页章列表溢出重叠：章数多时盖住表头与导入按钮，后段章节不可达

- **模块**：阅读室·EPUB/长书导入（M08-06 / M08-08 / M08-10 关联）
- **来源**：【GUI 实测】（s6；findings/s6.json F5，2026-11-10 补测阶段复核证据时确认；两次独立导入截图一致 + 离屏 SwiftUI 布局探针）
- **详细描述**：目录勾选页的章列表 chapterList 用 `VStack(spacing: 2)` + `.frame(maxHeight: 220)`，既无 ScrollView 也无 `.clipped()`：章数 ≳9 时列表按自然高度居中溢出——12 章时 Chapter 1/2 行叠在「覆盖考研大纲词…」与「选择要导入的章/全选/清空」行上，Chapter 11 行压住「重新选择文件/导入所选 12 章」按钮行，Chapter 12 被裁掉；40 章时 row1 在 y=-381、row40 在 y=711…737，均远出视口且 ScrollView 内容高度不含溢出，后段章节完全不可达。另有一条锁屏期未实测的推断：章行声明在表头之后、命中优先，真人点「全选/清空」可能误切 Chapter 1/2。
- **复现步骤**：
  1. 阅读室→导入弹层→EPUB tab→选择多章 EPUB（自制 12 章）；
  2. 观察目录勾选页章列表与表头/底部按钮行的重叠。
- **预期结果**：章列表在固定高度内滚动或裁剪，表头与「全选/清空/导入所选」按钮行始终可见可点。
- **实际结果**：12 章即出现上下溢出重叠（两次独立导入画面一致）；40 章后段章节不可达。
- **证据**：`qa-artifacts/screenshots/s6/M08-06-epub-toc.png`（s6 原执行）、`M08-08b-download-to-toc.png`（2026-11-09 21:04 并行尝试，画面一致）；离屏布局探针 `qa-artifacts/tools/s6r_tocprobe.swift`（输出存 `qa-artifacts/results/s6-retest-log.txt`）：12 章 chapterListFrame y=68…288 而 row1 y=11…37（< headerRow.maxY=58）、row12 y=319…345（> footerRow.minY=298）；40 章 row1 y=-381…-355、row40 y=711…737。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderIntakeSheet.swift:773-804` chapterList = VStack + frame(maxHeight:220) 无滚动/裁剪（外层 ScrollView 在 :688，表头 :742-751、底部按钮行 :753-763）。
- **修复建议**：chapterList 包 ScrollView（或加 `.clipped()` 并限制高度），表头与按钮行独立于列表滚动。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（EPUB 导入目录页需文件选择器交互，HID 自动化中止）。代码核对 `Sources/ImmersiveTranslator/ReaderIntakeSheet.swift:779/809`（chapterList 包 ScrollView(.vertical)，maxHeight 220 保留）。
- **回归证据**：代码证据同上。
- **备注**：M08-06 用例的 PASS 状态不改（导入功能本身可用，本条为布局缺陷）。

### BUG-041（P1）正文点词/划选查词/词块卡/点句定位在 mac 端经正文交互不可达（mouseUp 覆写永不被调用）

- **模块**：阅读室·查词与生词（M09-06、M08-11 生词子项；s5 O1 同现象）
- **来源**：【GUI 实测 + 进程内探针】（s5 O1、s6 M09-06 症状两次独立复现；s6 补测代码走查 + `tools/s6r_tvprobe.swift` AppKit 派发路径探针；findings/s6.json F6）
- **详细描述**：正文单击词块、双击取词、划选查词、词块即时卡、段落排版点句定位的回调全部只挂在 NSTextView 子类的 `mouseUp(with:)` 覆写里；而 NSTextView.mouseDown 的跟踪循环会吞掉抬起事件，mouseUp 覆写在 macOS 26.5.2 实测 0 次调用——划选本身生效（selectedRange={1,28}）但查词面板永不出词条；普通 NSView 对照组 mouseUp 正常。阅读室内加生词的全部入口（收藏词块/搭配收藏/加入生词本，ReaderViews.swift:4059/4112/4135）都只消费该链路产出 → 生词经正文交互在 mac 端不可构造（M13-02 生词子项、M08-11 生词子项因此受限）。s5 O1「合成事件限制」的既往结论据此改判：探针走 NSApp.postEvent→NSWindow.sendEvent 的 AppKit 派发路径（不经 WindowServer/HID、不向系统发任何输入），应用缺陷可能性远大于合成事件限制；真实鼠标预计同样受影响，待一次人工点按最终确认。
- **复现步骤**：
  1. 打开任一有词块的文章（或段落排版文章）；
  2. 单击正文单词 / 双击取词 / 划选短语；对照：点同窗口其它按钮。
- **预期结果**：单击出词典卡、词块出即时卡、点句定位跳句、划选出查词。
- **实际结果**：全部无响应（划选仅高亮，查词页签保持「单击正文里的单词…这里出词条」提示）；同窗口其它控件正常。
- **证据**：`qa-artifacts/screenshots/s5/M13-02-guest-lookup-tab.png`、`M13-02-guest-lookup-word2.png`；`qa-artifacts/screenshots/s6/M09-06-drag-select.png`、`M09-06-dict-tab.png`；探针输出 `qa-artifacts/results/s6-retest-log.txt`（RESULT：TextKit1/TextKit2 两配置 NSTextView.mouseUp=0 次、NSView.mouseUp=1 次、macOS 26.5.2）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderSentenceText.swift:252-272`（ReaderTextView.mouseUp 内才调 onSelection/onChunkClick/onWordClick）与 `:759-788`（ProseFlowTextView.mouseUp 内才调 onSelection/onChunkClick/onClickSentence/onWordClick）；两类均无 mouseDown 覆写（2026-11-10 grep 核对仅 mouseUp 两处）。AppKit NSTextView.mouseDown 默认跟踪循环消费抬起事件。
- **修复建议**：在 mouseDown 覆写里先调 super（返回时鼠标已抬起）再做命中判断（s6 建议）；修复后用真实鼠标做一次人工确认收口。
- **修复状态**：已回归通过（2026-11-10 回归轮）
- **回归结果（2026-11-10 回归轮，回归测试员）**：13:18–13:49 合成鼠标事件（NSApp.postEvent→NSWindow.sendEvent，与硬件点击同一 AppKit 派发链）经正文交互全部可达：单击正文单词出词典卡（mock `chat kind=dict text="garden"`/`"the"`）；划选短语出查词词条（text="d silver fruit"）；单击当前句词块下划线出词块即时卡（in great joy，含释义/记法/直译辟拼）；词块卡「收藏词块」成功（toast「已收藏词块：in great joy」，笔记与复习徽标 2→3）。修复前四类交互全部无响应（mouseUp 0 次调用）。
- **回归证据**：截图 qa-artifacts/screenshots/regression/b041-04/08/09/10/11/12-*.png；qa-artifacts/mock/s5-requests.log 13:37:56/13:39:00/13:40:33 三条 dict 请求。范围说明：「点句定位」未单独复测，但其与点词/词块/划选共用同一 mouseDown→handleInteractionEnd 入口（`Sources/ImmersiveTranslator/ReaderSentenceText.swift:271`），已验证的三条路径证明该派发机制生效。

---

## 2. 静态推断 Bug 详情（已复核源码；不计入 GUI 统计）

> 以下 15 条来自 2026-11-08 三份静态审查（qa-artifacts/audit/static-*.md）与性能会话的代码证据分析（qa-artifacts/perf.md §发现的问题）。**2026-11-10 汇总会话已对每条引用的 `文件:行` 逐一复核**（读取当前工作区源码，与发现描述一致；被测 debug 构建 sha256 前 16 位 `09cd61ee848a4ef6` 对应该源码）。其中确定性代码缺陷 12 条复核通过、按等级转入待修复/确认不修复；并发交错类 3 条（BUG-027/030/035）代码结构与无防护现状已核实，但运行时交错未复现——同样按口径转入对应状态，修复时建议先做最小运行时复现或压测。本节结论均为静态证据，不计入 GUI 统计。

### BUG-025（P2）Edge TTS 网络失败无熔断：挂起型网络下每句先等云端失败（≤20s）再回落

- **模块**：阅读室·TTS 播放引擎
- **来源**：【静态推断·已复核】（perf.md 问题 2，代码证据·未实测）
- **详细描述**：播放引擎每句都先 `await EdgeTtsEngine.shared.audioData`，catch 后才回落系统朗读；只有网关 quota_exceeded 有 30s 绕过记忆，网络错误没有。Edge 单句合成整体超时 20s——网络挂起（连上不回包）时每句可能停顿接近 20s。本机历史日志 49 次失败均为快速 connectionRejected（间隔 7-11s），故未表现；代理黑洞/丢包型网络待实测。
- **触发/验证路径**：播放中制造挂起型网络（如对代理端口 SIGSTOP）→观察句间间隔。
- **预期**：网络类失败有熔断记忆（窗口期内直接走系统朗读）。
- **证据**：qa-artifacts/perf.md §6/§发现 2；`grep -c reader.tts.cloud-fallback diagnostic.log` = 49（全部 connectionRejected，来自 s6/s7 会话）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderPlaybackEngine.swift:416-455` speakCloud 每句先云端后回落、无网络错误记忆；`Sources/XfyunCore/EdgeTts.swift:37-38,364-367` 单句 20s 超时。本会话核对 ：416-455 代码现状一致。
- **修复建议**：仿 quota_exceeded 的 30s 绕过机制为网络错误加熔断窗口。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无单机 GUI 路径（挂起型网络需注入 SIGSTOP 代理端口等条件）。代码核对 `Sources/ImmersiveTranslator/ReaderPlaybackEngine.swift:97-99/169/461/465`（30s 网络熔断 + 开播复位）；ReaderPlaybackCloudBreakerTests 4 用例（fetch 替身挂起模拟挂起网络）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-026（P2）PanelTtsSpeaker 云路由 `.local` 腿缺 route 后代数复检：stop/换位后旧句仍出声

- **模块**：翻译浮窗·TTS
- **来源**：【静态推断·已复核】（audit/static-并发与状态.md Finding 1）
- **详细描述**：speakCloudRouted 的 `.local` 腿在 `await CloudTtsRouter.route`（首调/30s TTL 时为网络探测挂起点）之后没有 generation 复检；stop()/切换朗读位后，被取消的旧句醒来仍经 speakLocal 无条件 `synth.speak` 入队出声——幽灵语音/乱序播放。同族实现均有 route 后复检（LeadSpeaker.swift:59-69、ReaderPlaybackEngine.swift:289、QuickReviewSpeaker 经 Task.isCancelled 守卫）。
- **触发/验证路径**：ttsProvider=.cloud 且语音页守卫裁决 xfyun、本机讯飞无凭据（route 返回 .sapi→.local，CloudTtsRouter.swift:35-43）→朗读中点停止/换位→听旧句是否仍出声。
- **预期**：被停/被换的句子不进入任何出声腿。
- **证据**：audit/static-并发与状态.md §Finding 1（含代码摘录）。
- **根因分析**：`Sources/ImmersiveTranslator/PanelTtsSpeaker.swift:120-122` `.local` 腿无复检（对照 ：100-103 gateway 腿有）；`speakLocal` :164-173 无条件 `playingGeneration = gen; synth.speak`；stop() :127-135 递增 generation 并 cancel Task，但 Task 在 route 挂起点不抛错。本会话核对 ：95-124 代码现状一致（:120-121 确无复检）。
- **修复建议**：route 之后补 `guard gen == self.generation, !Task.isCancelled else { return }`（与 LeadSpeaker 同款）。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：幽灵语音属听觉现象，无音频监听手段，GUI 无法判定。代码核对 `Sources/ImmersiveTranslator/PanelTtsSpeaker.swift:104/110`（routeCloud 之后统一代数复检）；PanelTtsSpeakerRouteGenerationTests 1 用例（真实 PanelTtsSpeaker + 可控路由闸门）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-027（P2）ReaderStore 读-改-写与同步 hydrate 并发丢更新：复习进度跨设备回退

- **模块**：数据一致性·ReaderStore
- **来源**：【静态推断·已复核】（audit/static-持久化与数据一致性.md M-1）
- **详细描述**：recordReading（15s 计时）/saveVocabWord（收藏词）的「loadVocabFile 读 → writeAtomically+commit 写」两段各自持 LearningStore.lock，ReaderStore.queue 管不住 SyncEngine 侧 putTransaction 事务内 hydrate 对 reader_vocab.json 的重写；两步之间落一轮 pull 时，commit 用拉取前的陈旧 body，mergeUnknown 让陈旧 srs/recall 胜出并重新入队（updatedAt=now）推给他端——复习进度跨设备回退并扩散。Windows reader_store.rs 同架构，属共同设计缺陷的移植。
- **触发/验证路径**：多端环境在大词库 + 15s 落盘窗口内制造 pull 落地（压测）；或注入 hydrate 钩子验证。
- **预期**：pull 后本地写不覆盖刚拉取的 srs/recall。
- **证据**：audit/static-持久化与数据一致性.md §M-1（完整证据链）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderStore.swift:503-512` recordReading（saveVocabWord :432-443 同构）读与写分离持锁；`Sources/ImmersiveTranslator/LearningStore.swift:520-522→1113-1147/1295-1323` hydrate 重写快照；`:1063-1074` mergeUnknown 陈旧标量胜出；`:987` derive 全量 enqueueDB(updatedAt: now())。本会话核对 :503-512 现状一致。
- **修复建议**：把读-改-写收敛进 LearningStore 单事务（commit 前现读），或 hydrate 后失效 ReaderStore 缓存重读。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无单机 GUI 路径（需多端同步在 15s 落盘窗口内交错）。代码核对 `Sources/ImmersiveTranslator/LearningStore.swift:415`（withExclusiveAccess）+ `Sources/ImmersiveTranslator/ReaderStore.swift:98` 及 10 个读-改-写入口；ReaderStoreHydrateRaceTests 压测用例（真实 LearningStore+SQLite，修复前 4/4 复现丢更新、修复后 0 丢失）在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-028（P2）loadJSONFile 对损坏 JSON 静默返回空库：下一次保存整体覆盖书目/整本书章节

- **模块**：数据一致性·ReaderStore
- **来源**：【静态推断·已复核】（audit/static-持久化与数据一致性.md M-2）
- **详细描述**：loadJSONFile 对损坏 JSON `try?` 后 `return empty`；`reader_books.json` 损坏时下一次 saveBookMeta/saveBook 以「空索引+新条目」整体覆盖（丢全部书目元信息）；`books/<bookId>.json` 损坏时 saveArticleIntoBookFile 用单章重写整本书文件（其余章节丢失，且删除经 derive tombstone 传播到他端）。同文件 loadArticlesFile(:130-135) 与 loadVocabFile(:348-352) 在 2026-10-30 事故后均已改为报错保护（注释明言旧实现的清库后果），唯独 loadJSONFile 保留旧形态。
- **触发/验证路径**：临时目录构造损坏 books/<id>.json → loadBookFile → saveArticleIntoBookFile → 核对整书内容。
- **预期**：损坏文件报错保护，不整体覆盖。
- **证据**：audit/static-持久化与数据一致性.md §M-2（含代码摘录）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderStore.swift:233-235` `guard let topLevel = try? JSONSerialization... else { return empty }`；saveArticleIntoBookFile :329-340 单章重写整书。本会话核对 :229-235 现状一致（仍 return empty）。
- **修复建议**：照 loadArticlesFile 同款报错保护改造 loadJSONFile。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无 GUI 路径（需人为构造损坏的 reader_books.json / books/<id>.json 后触发保存）。代码核对 `Sources/ImmersiveTranslator/ReaderStore.swift:262`（解析失败抛 schemaIncompatible，不再 return empty）。
- **回归证据**：代码证据同上。

### BUG-029（P2）LearningStore.readPath 把一切磁盘读错误吞成 NotFound：下一次保存整体清库

- **模块**：数据一致性·LearningStore
- **来源**：【静态推断·已复核】（audit/static-持久化与数据一致性.md M-3；该审查含运行时验证：非 UTF-8 抛 code=259、无权限抛 code=257，均非 260）
- **详细描述**：readPath 磁盘兜底分支把权限/非 UTF-8/IO 等一切读错误吞成 LearningFileNotFoundError，消费方 try? 后视为空库，下一次保存即整体清库覆盖；违背同文件 readFileDB（:361-367，只豁免 NotFound，注释自述「其余读错误必须报出来（防下一次保存整体清库）」）与 Rust 参照（learning_store.rs:947-956、:143-161 同口径）的既定策略。触发前提：files 表缺行（fresh DB 未迁移/删库重建）+ 磁盘文件读不了。
- **触发/验证路径**：临时目录模拟 files 缺行 + chmod 000 文件 → readPath → save → 核对清库。
- **预期**：非 NotFound 读错误原样上抛。
- **证据**：audit/static-持久化与数据一致性.md §M-3（含错误码运行时验证）。
- **根因分析**：`Sources/ImmersiveTranslator/LearningStore.swift:391-395` `catch { throw LearningFileNotFoundError() }` catch-all；下游 ReaderStore.swift:63-69、SpeakStore.swift:64-68、NoteStore.swift:49 均 try? 吞成 nil=空库。本会话核对 :386-395 现状一致。
- **修复建议**：只豁免 NSFileReadNoSuchFileError，其余错误上抛（与 readFileDB 对齐）。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无 GUI 路径（需 files 表缺行 + chmod 000 / 非 UTF-8 文件后触发保存）。代码核对 `Sources/ImmersiveTranslator/LearningStore.swift:397`（只豁免 NSFileReadNoSuchFileError）+ 下游 `ReaderStore.swift:77`、`SpeakStore.swift:78`、`NoteStore.swift:61` 同口径。
- **回归证据**：代码证据同上。

### BUG-030（P2）SpeakRecords 同步入队全程不带 expectedNamespace：账号切换窗口内实体落错命名空间（登出场景经 adoptGuest 跨账号串扰）

- **模块**：数据一致性·SpeakRecords（静态审查两条同根因发现合并：并发审查 Finding 2 + 持久化审查 M-4）
- **来源**：【静态推断·已复核】（并发交错为静态推断，未做运行时压测）
- **详细描述**：enqueueRecord 的 store.list/store.put 与 tombstoneRecord 全程不传 expectedNamespace，SyncStore/LearningStore 对 nil 不校验、按执行时刻 currentNamespace() 落库；该写路径跑在 Task.detached（recordAssessmentSilently :389-394）上，与 MainActor 的 setAccount（ServerAuth.swift:1281-1285）无同步点——切号瞬间评测记录可能写进新账号命名空间并随后同步到错误账号；登出场景落入 guest 后会被 adoptGuest（LearningStore.swift:1329-1389）并入下一个登录的任意账号。同库其它写路径均有命名空间复核（SyncEngine.swift:405-411、LearningSyncEngine.swift:94-96/115-117、ReaderViewModel.scheduleSave:1316-1323；PracticeRelayView.swift:229-232 与 ReaderStore.swift:552-614 全程携带 expectedNamespace）。
- **触发/验证路径**：多线程压测：评测返回瞬间切号/登出，核对实体命名空间归属。
- **预期**：发起时刻命名空间不符即丢弃（与 fire-and-forget 静默语义一致）。
- **证据**：audit/static-并发与状态.md §Finding 2、audit/static-持久化与数据一致性.md §M-4。
- **根因分析**：`Sources/ImmersiveTranslator/SpeakRecords.swift:337-356`（enqueueRecord list/put 无 namespace）、`:410-429`（tombstoneRecord 同）、`:389-393`（Task.detached）；`Sources/ImmersiveTranslator/SyncStore.swift:421-427/436-445` nil 透传；`Sources/ImmersiveTranslator/LearningStore.swift:244-247` verifyNamespace(nil) 放行。本会话核对 :337-356/:389-394 现状一致。
- **修复建议**：入队点捕获发起时刻 currentNamespace() 并全程传 expectedNamespace；或把 detached 写改为捕获命名空间的 @MainActor Task。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无单机 GUI 路径（需评测返回瞬间切号/登出的并发压测）。代码核对 `Sources/ImmersiveTranslator/SpeakRecords.swift:354/374/433/448/548`（enqueueRecord/tombstoneRecord 全程携带 expectedNamespace + 生产接线）；SpeakRecordsTests 全量通过（无新增专门用例）。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-031（P2）浮窗翻译请求超时仅 18s：非流式长文本/慢模型必然超时（Windows 120s、阅读室 180s）

- **模块**：翻译浮窗·网络
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F1）
- **详细描述**：同一 request 用于流式与非流式路径，timeoutInterval=18 远低于对齐基准（Windows translation.rs:415 共 120s；mac 阅读室 ReaderChatClient.swift:207/260 为 180s）。URLSession 超时是空闲计时：非流式路径整次生成必须落在 18s 内；长文本/推理型模型必然 URLError.timedOut，而同一文本 Windows 端可成功。面板默认开流式（Settings.swift:182 `?? true`）；关流式与「验证翻译请求」路径受影响最直接。
- **触发/验证路径**：关流式 + 慢模型/长文本触发浮窗翻译，观察 ~18s 超时。
- **预期**：与对齐基准一致（≥120s）。
- **证据**：audit/static-网络与错误处理.md §F1（含三方对照）。
- **根因分析**：`Sources/ImmersiveTranslator/TranslationClient.swift:159` `request.timeoutInterval = 18`，:188 传 performStreamingRequest、:200 传 performBufferedRequest。本会话核对 :157-159 现状一致。
- **修复建议**：对齐 Windows 调至 120s（流式/非流式共用）。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（需 >18s 慢速端点，当前 mock 无 slow 响应场景）。代码核对 `Sources/ImmersiveTranslator/TranslationClient.swift:162`（timeoutInterval 18→120，流式/非流式共用）。
- **回归证据**：代码证据同上。

### BUG-032（P2）流式 SSE 中的 error 帧被吞：截断译文当成功落库 / 服务端错误文案丢失

- **模块**：阅读室·网络
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F2）
- **详细描述**：completeStreaming 消费循环只做 `accumulated += delta`，对 200 SSE 流中的 `data: {"error":{...}}` 帧：出错前已有部分文本→截断译文当成功返回（阅读室把不完整翻译落库）；无文本→服务端 message 丢失只剩笼统 empty 错误。同仓浮窗客户端对同一帧型显式抛 badResponse(200, message)（TranslationClient.swift:485-491），证明该帧型是真实场景。与 GUI 观察呼应：s7 M09-13 续跑线索指出 402/500/空回包统一归因为「翻译服务暂时不可用」（ErrorMessageFormatter.swift:427-431，BLOCKED 未实测）。
- **触发/验证路径**：mock 在 SSE 中途注入 error 帧（有/无前置文本两组）→观察落库内容与错误文案。
- **预期**：错误帧显式抛错并携带服务端 message。
- **证据**：audit/static-网络与错误处理.md §F2（含代码摘录与对照）。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderChatClient.swift:348-351` 错误帧 `return nil`（注释自认「错误帧不产文本」）；:277-284 消费循环无错误帧终结逻辑。本会话核对 :344-351 现状一致。
- **修复建议**：仿 TranslationClient 抛 badResponse(200, message)，中断流并让管线走失败分桶。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：GUI 未执行（当前 8090 mock 不支持在 SSE 流中注入 error 帧）。代码核对 `Sources/ImmersiveTranslator/ReaderChatClient.swift:445/454/502`（consumeSSELine 改 throws、错误帧抛 http(200, message)、buffered 整体信封检查）。
- **回归证据**：代码证据同上。

### BUG-033（P2）讯飞 TTS base64 解码失败静默丢帧：截断 mp3 进双层缓存永不自愈

- **模块**：语音·讯飞 TTS
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F3）
- **详细描述**：音频帧 base64 解码失败被静默丢弃（`guard ... else { return }`），声明的 XfyunTtsError.decodeFailure 全仓库无任何 throw 点；只要其余帧非空就正常返回截断 mp3，并被写入 L1 内存 + L2 磁盘缓存——之后命中缓存永不自愈，朗读无报错地戛然而止。
- **触发/验证路径**：注入非法 base64 帧的会话回包（单测/钩子）→核对返回音频长度与缓存内容。
- **预期**：解码失败抛 decodeFailure、不缓存截断结果。
- **证据**：audit/static-网络与错误处理.md §F3；grep 确认 decodeFailure 仅 :89 声明与 :96 errorDescription。
- **根因分析**：`Sources/XfyunCore/XfyunTts.swift:201-206` guard else return；`Sources/ImmersiveTranslator/XfyunTtsEngine.swift:87-89` 成功即 `l1.set(key, data); disk.put(key, data)`。本会话核对 :201-208 现状一致（else return 无日志无抛错）。
- **修复建议**：解码失败 throw decodeFailure；失败会话不写缓存。
- **修复状态**：已修复待回归（GUI 回归未完成）
- **回归结果（2026-11-10 回归轮，回归测试员）**：无 GUI 路径（需注入非法 base64 音频帧的会话回包）。代码核对 `Sources/XfyunCore/XfyunTts.swift:199/208/217/220`（decodeFailed 标记 + run 后抛 decodeFailure，不再缓存截断 mp3）；XfyunCoreTests 52 用例在全量 1357 中通过。
- **回归证据**：代码与单测证据同上；单测日志 `qa-artifacts/results/regression-swift-test-1216.log`。

### BUG-034（P3）应用退出或被 kill 不落盘缓冲：最多丢 14s 阅读秒数与防抖中的进度写入

- **模块**：阅读室·数据落盘
- **来源**：【静态推断·已复核】（perf.md 问题 1，代码证据·未实测）
- **详细描述**：阅读秒数满 15s 才落盘（ReaderViewModel.swift:733-744）、文章进度 700ms/书级 meta 1.2s 防抖；只有关窗路径主动 flush（ReaderWindowController.swift:99-105 → ReaderViewModel.swift:2585-2593）。applicationWillTerminate 只取消两个任务（App.swift:568-571）；托盘「退出」直接 terminate；`grep -rn willTerminate Sources/` 无其他命中——阅读室开着时 ⌘Q/托盘退出/kill 会少记今日阅读时长、secondsListened 与最后 0.7s 进度。
- **触发/验证路径**：播放 10s 内 killall 或托盘退出 → 只读比对 secondsListened 与 readingLog（perf.md §5 有步骤）。
- **预期**：退出前 flush 缓冲。
- **证据**：qa-artifacts/perf.md §发现 1（6 条代码证据）。
- **根因分析**：`Sources/ImmersiveTranslator/App.swift:568-571` applicationWillTerminate 未通知 ReaderViewModel flush（本会话核对 :567-571 现状一致）。
- **修复建议**：applicationWillTerminate 广播 flush（阅读窗 willClose 已有现成 flush 路径可复用）。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

### BUG-035（P3）deviceId() 读-改-写无锁：首次并发调用可生成两个设备 ID

- **模块**：数据一致性·LearningStore
- **来源**：【静态推断·已复核】（audit/static-持久化与数据一致性.md L-1）
- **详细描述**：deviceId() 无 lock.lock()（对比同文件其它入口均在 NSRecursiveLock 内）；锁外调用点（ReaderStore.swift:572/631、PracticeRelayView.swift:235/487）与锁内首次 commit 并发时，两边各自生成 `mac-<pid>-<nowms>`（必不相同），后写覆盖先写——已写入事件的 deviceId 与 progress 实体键 `progress:<id>:<device>` 分叉成两行。仅首次生成竞态，不丢数据。
- **触发/验证路径**：首启并发触发首评+首次同步 commit（压测/钩子）。
- **预期**：设备 ID 全局唯一。
- **证据**：audit/static-持久化与数据一致性.md §L-1。
- **根因分析**：`Sources/ImmersiveTranslator/LearningStore.swift:300-315` 无锁读-改-写（本会话核对现状一致，:308 只豁免 NotFound）。
- **修复建议**：函数体加 lock.lock()（NSRecursiveLock 可重入，锁内调用点不受影响）。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

### BUG-036（P3）derive 的 tombstone 不覆盖 chunk:/progress: 实体：随编辑与同步无界累积

- **模块**：数据一致性·LearningStore
- **来源**：【静态推断·已复核】（audit/static-持久化与数据一致性.md L-2；Windows learning_store.rs:1513-1531 逐字同构，共同设计非 Mac 回归）
- **详细描述**：tombstone 循环只遍历 articles/books/words/sessions 顶层行 id；projectArticle 生成的 `chunk:<id>:<rev>:<n>`（每次改版换新 id）与 `progress:<id>:<device>` 实体在文章删除或改版后永不清理——entities 表/push 载荷/hydrateArticles 全表扫描成本随编辑次数线性膨胀。正确性不受影响（未被 manifest 引用的 chunk 不进快照），属配额/性能泄漏。
- **触发/验证路径**：同一篇文章多次改版/删除后只读统计 entities 表 chunk: 前缀行数。
- **预期**：孤儿 chunk/progress 实体被清理或至少不随同步传播。
- **证据**：audit/static-持久化与数据一致性.md §L-2。
- **根因分析**：生成点 LearningStore.swift:918-924/:957-965；清理点 `:1020-1029` 仅四域顶层行（本会话核对现状一致）。
- **修复建议**：改版时 tombstone 同文章旧 revision chunk；文章删除时按前缀清理（需评估同步兼容）。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

### BUG-037（P3）XfyunWebSocketSession 业务错误抛出路径不关 WebSocket：每次失败泄漏一条连接

- **模块**：语音·讯飞会话
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F4）
- **详细描述**：业务错误（code != 0，凭据错误/限频等常见失败）从 receive 任务抛出时未调 session.close()；而超时任务里的 close 已被 group.cancelAll() 取消，session 为 run 局部对象无人能补关——每次失败泄漏一条到 *.xfyun.cn 的 WS 连接，靠 shared session 空闲超时或服务端关闭兜底。对照 EdgeTts.swift:375-382 catch 中显式 transport.close()。
- **触发/验证路径**：错误凭据触发讯飞会话失败 → 抓包/连接计数核对半开连接。
- **预期**：错误路径显式关闭。
- **证据**：audit/static-网络与错误处理.md §F4。
- **根因分析**：`Sources/XfyunCore/XfyunAuth.swift:151-154` throw 无 close；close 仅成功路径 :160 与超时任务 :167；:170-173 cancelAll 取消超时任务的 close。本会话核对 :148-173 现状一致。
- **修复建议**：run 外层包 do/catch 在错误路径补 session.close()。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

### BUG-038（P3）流式路径读 HTTP 错误体无 do/catch：断连抛裸 URLError，丢失 401 换票重放与错误归因

- **模块**：翻译浮窗·网络
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F5）
- **详细描述**：performStreamingRequest 读错误体为裸循环（无 do/catch、无日志、无上限）；buffered 版对同一读取包了 do/catch + redactedDiagnosticText。错误体读取中途断连抛出的裸 URLError 会越过其后的 401 判定与 platformReplayTokenAfter401——token_expired 换票重放不发生，用户看到传输错误而非解析后的服务端错误。同款且无字节上限：ReaderChatClient.swift:299-300。
- **触发/验证路径**：错误响应中途断连（代理/钩子）→观察异常类型与重放日志缺失。
- **预期**：与 buffered 路径同防护（do/catch + 日志）。
- **证据**：audit/static-网络与错误处理.md §F5。
- **根因分析**：`Sources/ImmersiveTranslator/TranslationClient.swift:413-416` 裸循环（本会话核对现状一致）；对照 :285-296 buffered 版。
- **修复建议**：包 do/catch + redacted 日志；ReaderChatClient 同点位加字节上限。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

### BUG-039（P3）streamDeltas 收流 Task 继承 @MainActor：整条 SSE 逐字节解析在主线程执行

- **模块**：阅读室·网络（性能）
- **来源**：【静态推断·已复核】（audit/static-网络与错误处理.md F6）
- **详细描述**：ReaderChatClient 类级 @MainActor，static streamDeltas 同被隔离；其内部非结构化 Task 继承创建处 actor 上下文——SSE 逐字节搬运与每行 JSON 解析都在主线程执行。阅读室长文流式补全（标题/词块/段落翻译，ReaderViewModel 8 个调用点）期间主线程被占满，长输出可感知卡顿；正确性不受影响。与 BUG-006（管线 hang）同点位，修复时一并评估。
- **触发/验证路径**：长输出流式期间 perfprobe ping 主线程往返（perf.md 工具已备）。
- **预期**：收流与解析脱离主线程。
- **证据**：audit/static-网络与错误处理.md §F6。
- **根因分析**：`Sources/ImmersiveTranslator/ReaderChatClient.swift:11-12` 类级 @MainActor + `:294-326` Task 继承（本会话核对 :11-12/:294-296 现状一致）。
- **修复建议**：收流 Task 用 nonisolated 上下文（或 detached）并在回调处显式回主 actor。
- **修复状态**：确认不修复（P3，本轮不安排，留档备查）

---

## 3. 观察项与本轮未立 bug 的记录（留档）

以下为会话记录但未达立 bug 门槛的观察，修复相关缺陷时可顺带评估：

- 专注复习空态计数显示「1 / 0」（ReaderCore/VaultFocusCore.swift:145-147 counterText 口径即如此）；零生词时 Hero 文案「今天没有要复习的了…明天再来」对零生词新用户略有误导（rail 文案正确）——s7 M10-09。
- M10-05 关闭生成弹层后笔记库列表未即时刷新（切 tab 后才出现新笔记）——s7（BUG-010 附带）。
- LeadSpeaker 本地回落选声取第一个语言前缀匹配，zh-TW 可能先于 zh-CN（QA_TEST_PLAN §7 #12，未测）。
- 录音直译关窗不停麦（架R1 高危）、200 段截断无提示（功R2）、配置快照过期（功R1）、历史 500 上限淘汰不区分收藏（功R3）、LWW 静默覆盖无告警（数R1）、毒丸游标无恢复手段（数R2）、单实例 fail-open 无提示（架R3）、阅读室无平台 401 重放（网R4）等〔记录行为〕/待确认项：M06/M11/M12/M05 大面积 BLOCKED 未能 GUI 验证，见 QA_TEST_REPORT.md §E。
