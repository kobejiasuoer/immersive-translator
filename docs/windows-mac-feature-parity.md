# Windows → Mac 功能差距矩阵

盘点日期：2026-10-02；最近复核：2026-11-02（见下方「2026-11-01 补齐施工（八域）」）

范围：仓库当前 Windows Tauri + React 工程与 macOS Swift 工程。本文描述用户可见能力和行为，不要求两端采用相同实现。

## 2026-10-20 对齐施工更新

本轮按「六域审计（壳/阅读/口语/复习/浮窗/设置，另加账号独立单元）→ 分批施工 → 设计评审 → 终验」推进：审计产出差距清单后分 7 批施工，每批以 `swift test` 为门禁并做独立验收，P0/P1 打磨项已应用并通过设计复验。全部施工仅完成代码级验证，未实机验收——全局热键、辅助功能/录屏/麦克风授权、剪贴板保护、浮窗定位、OCR 截图、更新器等系统集成行为在本矩阵中一律保持「待验收」。2026-10-21 复核实跑 `swift test` 全量 445 项 0 失败（darwin arm64 本机）。

| 批次 | 内容 | 结果 |
|---|---|---|
| AUTH-CORE | 账号核心与单实例守卫（独立单元） | 已完成：swift test 门禁与独立验收均通过 |
| SPEAK-LOOP | 口语对话环核心重构（点击开麦/教练批改/发音评测） | 已完成：同上 |
| PANEL-DOCK | 翻译浮窗操作区、四位置朗读与词典链（独立单元） | 已完成：同上 |
| SHELL-CHROME | 壳导航、三主题皮肤与启动接线 | 已完成：同上 |
| READ-PROSE | 阅读正文版式双模式、xray 透镜与播放语义 | 已完成：同上 |
| REV-VAULT | 笔记与复习三合一容器＋快速复习迷你窗修复 | 已完成：同上 |
| WIRE-CLOSE | Markdown 导出、内化看板、pendingSpeak 与账号/品牌接线 | 已完成：同上 |

本轮明确不做或延后的子项见文末「搁置与延后项（2026-10-20）」（该清单已于 2026-10-21 第二轮清偿，见下节与文末处置记录）。

## 2026-10-21 第二轮施工更新（延后项清偿）

本轮按「核实延后项 → 分批施工 → 设计评审 → 终验」推进：先逐条核实上轮搁置与延后项的真实状态，其中 6 项经代码核实已随第一轮落地或两端本已一致，予以注销（证据见下方注销表）；其余分 5 批施工，每批仍以 `swift test` 为门禁并做独立验收，P0/P1 打磨项已应用并通过设计复验。终验 `swift test` 全绿（2026-10-22 文档复核时实跑复验：Executed 541 tests, 0 failures，darwin arm64 本机）。与第一轮相同，全部施工仅完成代码级验证，未实机验收——全局热键、辅助功能/录屏/麦克风授权、剪贴板保护、浮窗定位、OCR 截图、更新器等系统集成行为在本矩阵中一律保持「待验收」。

| 批次 | 内容 | 结果 |
|---|---|---|
| R2-READ | 阅读室浮层 Esc 统一＋播放条键盘滑杆＋查词防串扰 | 已完成：swift test 门禁与独立验收均通过 |
| R2-SPEAK | 口语页报告卡复用＋SSML 慢速＋异常可行动卡＋VAD 统一 | 已完成：同上 |
| R2-REV | 复习完成页出口＋时间口径共享向量＋派发小签＋词表挂载 | 已完成：同上 |
| R2-PANEL | 浮窗品牌区/常驻设置入口/原文展开与复制格式＋历史窗批量操作 | 已完成：同上 |
| R2-SET | 设置中心 IA 全量重构＋更新卡/危险区＋引导时序＋status item 复用 | 已完成：同上 |

两项产品拍板随本轮定案并落地：词典卡默认值对齐 Windows（PANEL-8，经核实两端默认一致，无需改动）；复习时间口径对齐 Windows 并以共享测试向量固化（REV-10，R2-REV）。

**注销项**（核实为已落地或已对齐，退出待办清单；行号为 2026-10-22 复核时实读位置，与审计时记录可能有行号漂移）：

| 项 | 注销理由与证据 |
|---|---|
| SHELL-7 防双开 | 第一轮已做完：`SingleInstanceGuard.swift:28-141` 全量实现（`:103` `flock(LOCK_EX\|LOCK_NB)`、`:72-88` 分布式激活通知观察），`App.swift:14-26` 完成接线（claim 失败 `exit(0)`、observeActivation），`App.swift:558` 激活回调前置设置窗；本矩阵账号行亦记「单实例守卫已落地」。 |
| READ-8 播放 once 语义 | 全链路已落：`ReaderPlaybackEngine.swift:63-64/113-131`（jumpTo once 参数、oncePending 读完即停不连读不进跟读），VM 接线 `ReaderViewModel.swift:742-748`（once: true），折叠卡「朗读本句」按钮 `ReaderViews.swift:2501-2504`。 |
| SPEAK-5 声波舞台 | 已落：`SpeakView.swift:1517` HarmonicCanvas（`:1541` TimelineView 60fps、reduceMotion 暂停），`:574` 接入舞台卡。 |
| SPEAK-12 场景中心视觉/文案 | 已落且文案逐字一致：`SpeakView.swift:249` featured 双列网格，卡文案 `ReaderCore/SpeakLogic.swift:560-584` 与 Windows SCENARIO_CARDS（`src/reader/SpeakView.tsx:92-113`）逐字相同。 |
| PANEL-7 译文/词典互斥切换 | 已随第一轮 PANEL-DOCK 落地：showDictCard 状态（`TranslationPanel.swift:821`）、卡片/译文一键切换（`:1296/:1319`）、预取/重试自动切卡（`:551/:560`）、notAWord/未配置回落译文（`:581-592`）；本矩阵 AI 词典卡行亦记「卡片/译文一键切换」。 |
| PANEL-8 词典卡默认值 | 拍板口径为对齐 Windows，经查已一致：Windows `DEFAULT_SETTINGS.dictCard: "auto"`（`src/lib/settingsStore.ts:66`）＝ mac `dictCardAuto` 默认 true（`Settings.swift:147`，`?? true`），auto 语义（词条类文本自动切词典卡）两端相同，无需改动。 |

## 2026-11-01 补齐施工（八域）

本轮依据 `docs/mac-parity-specs-2026-11-01/` 八份规格（misc / zher / sync / voice / speak / reader / feed / relay），把 2026-10-21 基线之后 Windows 侧新增或变更的用户可见功能按 1:1 口径移植到 Mac。每域独立施工＋独立复核（复核为逐条对照 Windows 参照实现与规格 §3 验收清单的只读复查，发现问题即修复复验），分域以 `swift build`＋`swift test` 为门禁；收尾于 2026-11-02 实跑复验全量 `swift build`（Build complete，exit 0）＋`swift test`（Executed 1268 tests, with 0 failures，darwin arm64 本机）。逐域摘要、偏差、遗留与复核证据全文见 `docs/mac-parity-施工报告-2026-11-01.md`。

与既有两轮相同，本轮全部施工仅完成**代码级验证，未实机验收**——全局热键、辅助功能/麦克风授权、Keychain、剪贴板保护、浮窗定位、GUI 视觉与音频出声、真实服务端联调（`/v1/sync`、`/v1/redeem`、`/v1/scenarios`、`/v1/books`、语音网关 REST/WSS）等系统集成/外部服务行为在本矩阵中一律保持「待验收」。

| 领域 | 内容 | 结果 |
|---|---|---|
| misc | 基线杂项修复：关于页隐私政策卡（对齐 Windows e42018f）、打包脚本默认版本 0.1.1→0.11.1、危险区测试基线清污、取词 AX 强转消除 | 已完成：门禁全绿（申报时点 549 例）＋复核通过 |
| zher | 翻译退避与失败原因：段级退避重试、句子级 zhError 失败原因持久化、标题失败行、失败文案分桶（对齐 bc0f625） | 已完成：同上（575 例）＋复核通过（chip 残留与重试按钮回调两项复查差距已修复） |
| sync | 云同步与兑换码：多集合同步引擎、口语记录本地/云端合并、兑换码全链路（对齐 6630aa7＋c1e2ca7） | 已完成：同上（635 例）＋复核通过 |
| voice | 官方语音网关：云 TTS/听写/评测、语音页、阅读室朗读 cloud 档、实时字幕 gateway 分支、登录自动切云（对齐 4d48d85＋08595f3） | 已完成：同上（832 例）＋复核通过 |
| speak | 口语场景体系：场景契约化、官方场景目录、自定义场景编辑器、听力模式、目标词进度（对齐 032928a 等 6 笔） | 已完成：同上（966 例）＋复核通过（附 2 项 low 知会项，不影响用户可见行为） |
| reader | 阅读室 2026-10-26 改版：路由四值化、库四态、三段外壳、白卡重构、笔记四态、书架三列、随读抽查挖空（对齐 1c5205d） | 已完成：同上（1024 例）＋复核发现 1 项 medium 键位链差距待修（见下方「本轮新增待办」），复核未通过 |
| feed | 资讯订阅与发现书库：feed 抓取门禁与解析、/v1/books 目录与校验下载、导入弹窗双 tab（对齐 557e9cc 等 5 笔） | 已完成：同上（1096 例）＋复核通过（8 项复查全部解决） |
| relay | 学习接力：learning-core 四件、SQLite 学习库、练习接力面板、评分事件化、SyncEngine v2（对齐 7fc6abd） | 已完成：同上（1177 例）＋复核通过（24 项逐条核对） |

**本轮新增待办**（reader 域复核发现，代码级缺陷、未实机验证）：

- **正文快捷键让路判定过宽（medium，待修复）**：`ReaderViewModel.textInputHasFocus`（`ReaderViewModel.swift:2636-2639`，2026-11-02 实读）把一切 NSTextView/NSTextField 第一响应者都判为「在输入」，而阅读正文 `ReaderTextView`/`ProseFlowTextView` 均为 `isEditable=false, isSelectable=true`（`ReaderSentenceText.swift:62-63/:556-557`）——用户点过词句后它即成为第一响应者，`handleKeyDown` 的 `guard !typing`（`:2701`、`:2719`）会让 Space/J/K/L/H/E 全部让路，直到焦点移走。Windows `isTyping` 只认 input/textarea/contentEditable（`ReaderApp.tsx:2097-2105`），点正文不影响快捷键。规格 §3-32「只有输入框里才让出全局键」未满足。建议判定收窄为「可编辑的 NSTextView（含字段编辑器）或 NSTextField」。此条依据 AppKit 语义加代码阅读推断，未做 GUI 实测；修复后应补一条「只读正文视图持有焦点时快捷键不让路」的回归验证。

### misc · 基线杂项修复

- **摘要**：① 关于页新增隐私政策卡（新建 `PrivacyPolicyContent.swift`，文案逐字对齐 Windows `privacyPolicy.ts`/`PrivacyPolicyCard.tsx`：更新日期＋导语＋六节＋联系方式；默认收起、按钮「查看完整政策」⇄「收起」、切分区与关窗复位、260pt 上限滚动容器、1px rgba(148,163,184,0.22) 描边）；② `scripts/build_app.sh:6` 与 `scripts/package_release.sh:6` 默认版本 0.1.1→0.11.1（本矩阵 2026-11-02 实读确认）；③ 危险区测试新增 `zeroSettingsDefaults()` 清理基线，污染域 4/4 通过且不新增 endpoint/model 键；④ 取词 AX 强转改 CFTypeID 判定＋`unsafeDowncast`（`ClipboardReader.swift:88` 起），非 AX 值返回 nil 走 `.copyFailed`，文件内已无 `as!`，新增 3 例单测。政策文本零改动（`git diff` 为空，2026-11-02 复验）。
- **偏差**（8 条，节选）：规格字面 `as? AXUIElement` 在 Swift 6.3.3 下直接编译报错且运行时不做检查（CF 转型无防御作用），改编译器推荐的 CFTypeID 方案；「关闭重开回默认收起」经宿主设置窗 willClose 显式复位（Mac 控制器常驻，@State 不自然清空；Windows 标题栏 X 销毁窗口与之等效）；政策文本以 Text 段为选择单位（跨段连选需 NSTextView，超出本轮）；披露态放子视图 @State 使切分区复位（比规格建议更贴近 Windows 卸载语义）。全文见报告。
- **遗留**：GUI 目测未做（卡面渲染/复位待人工 QA）；「打包后关于页显示 v0.11.1」未实际观察（仅验证 Info.plist 注入链，本机 dist 内仍是旧值，下次打包刷新）；Windows uia.rs 取词集成测试的 Mac 等价未补（需辅助功能授权的真实焦点控件，规格 §2.3 未列）。
- **复核**：**通过**——14 项验收逐条核对（隐私卡与 Windows 三个 DOM 用例向量对齐、政策文案与源文件逐字段对账实跑未跳过、版本注入链 /tmp 独立验证 codesign 通过、污染域实测 12/12、AX 偏差实证成立、8 条偏差全部核实）；申报中部分行号已漂移（实读为准）。

### zher · 翻译退避与失败原因

- **摘要**：`ReaderCore/ParagraphTranslate` 增 `translateBackoffWaitMs=20s`/`translateMaxGroupRetries=1`/`translateMaxRunBackoffs=6` 与纯函数 `planTranslateRetry`；`SentencePair.zhError` 可选字段（契约含该字段、schemaVersion 不变、ReaderStore 零改动）；`ErrorMessageFormatter.readerParagraphErrorText` 三条中文文案与 Windows 逐字、绝不透传上游 message；vm 段级翻译重构（整篇共享退避计数、每段组内重试≤1、Task.sleep 醒来先验 run 失效即静默退出、失败分桶循环外一次收尾、retryParagraph 清 zhError 开新 run）；对照行/折叠卡/刊头失败行共用 `ReaderFailedRow`/`ReaderTitleFailedRow`（含「重试本段」按钮）。新增 5 测试文件 26 例。
- **偏差**（7 条，节选）：重试无 IPC tag 机制（await 请求-响应模型，重试即重新调用）；run 失效用既有 cancel＋代数失效（等价性由专用用例覆盖）；上游真 401 落同一文案桶（Mac 仅 API Key 直连、无云平台 token 刷新分支）；失败行抽共用视图＋折叠卡放开为 internal（测试可见性）；vm 增 `translateBackoffWaitMsOverride` 测试注入点；视图断言经 Mirror 取 SwiftUI Text 描述（可断文案与透明度，读不出字号数值）。
- **遗留**：Windows reader_store.rs zh_error 往返 cargo test 未运行（Windows 依赖 darwin 编译不过；行为向量已由 Swift Codable 往返/老数据用例等价覆盖）；两项既有差异（chip 计入标题、取消救回语义）规格明示不扩 scope。
- **复核**：**通过**——复查 3 项差距全部解决：新增 `invalidateTranslationRun()` 收口全部失效点并封死 chip 残留竞态（新增切文清 chip 用例）；「重试本段」改为真实调用按钮 action 并断言重试请求恰为该段；「InterlinearFoldCard」为申报命名过期（代码实为 internal `TranslationPopView`），非代码缺陷。

### sync · 云同步与兑换码

- **摘要**：新建 `SyncStore`（十集合白名单＋路径守卫＋按账号命名空间 `sync/<ns>/` 目录隔离与切换校验＋replace 保留待推实体）、`SyncEngine`（版本号游标分页/首拉全量 replace/stale_cursor 归零/429 退避≤3/409 整批原子＋幽灵实体/LWW 严格大于才重推/413 剔除单实体/双集合 64KB 预检/2MB 分批/push 200 不抹并发编辑/全局串行队列）、`SpeakRecords`（投影/还原/两形状守卫/withoutAudio/tombstone/展示合并/静默同步/SpeakSyncCenter）、`RedeemService`＋`RedeemCardView`（仅三业务码映射、状态机、账号页锚点）；口语页本地＋云端合并展示与入口静默同步、评测四落点入队（仅干净结果）、保存写穿入队、删除走 tombstone、超 64KB toast、额度用尽通知→兑换卡聚焦（80ms 时序）。补齐 60 例测试。
- **偏差**（13 条，节选）：originDevice 报 `"mac"`（协议语义，服务端透传不校验）；无 IPC 边界（令牌「不跨进程」以「不离开进程」等效满足）；本地存储 JSON 文件（后被 relay 域升级为 LearningStore/SQLite 门面委托）；SwiftUI 控件形态替换 React（文案、状态机、时序逐字一致）；SpeakSessionRecord 以字典承载开放索引；429 退避 sleep 依赖注入（单测零等待）；拉取线路实体行字段不齐整行丢弃（防御性收紧）；Windows 现行 learning_store::put 的 dirty-LWW 深防未移植（基线 JSON store 无此层）。
- **遗留**：practice-task 终态合并不移植（规格明示 Mac 本期无练习接力，按「忽略不崩溃」处理并有测试）；保存失败 toast 未新增（超落点）；视图层交互无 macOS 无头 UI 测试基建（以 RedeemModel 状态机单测替代）；`/v1/sync`、`/v1/redeem` 真实服务端联调未做（服务端不在本仓）。
- **复核**：**通过**——8 项逐点实读核对（authorizedRequest 致命鉴权收尾与 sync.rs 同形、80ms 滚动聚焦时序、batchLimit 同式、拉取页可选字段口径、命名空间复用 LearningStore 同源函数、AuthError 非本地化错误使「同步失败：[code] message」符合规格形态而 Windows "[object Object]" 属缺陷不复制、保存失败 toast 逐字且会话保留）。

### voice · 官方语音网关

- **摘要**：新建 `VoiceGateway/` 16 文件模块（REST/WS 客户端＋method/path 白名单校验、票据、能力缓存与配额展示、TTS 文本拆分与确切帧/第二片断连重试、ASR AsyncStream 单泵保序/128KB 切帧、路由 resolve、凭据惰性探测、请求体与 synthesis 帧逐字对齐 JSON.stringify）、`GatewayStreamPlayer`（AudioFileStream＋AVAudioConverter＋AVAudioEngine/TimePitch 流式 mp3 首片即播）、语音页 `VoiceSettingsTab`、阅读室朗读 cloud 档与失败 toast 两分支（quota 带兑换动作）、实时字幕 gateway 分支（失败写段内「〔识别失败：…〕」，讯飞分支零改动）、登录自动切云（`loginSuccessSerial` 触发＋4 秒提示）、讯飞凭据提示改 Keychain 口径。测试按 Windows 各单测补齐（TTS 帧/ASR 保序与切帧/路由 resolve/自动切云/迁移判定/mp3 分片解码一致性等）。
- **偏差**（12 条，节选）：无 IPC（进程内直调 authorizedRequest，白名单本地复刻）；官方云恒视为开放（Mac base 解析无灭灯开关，「仅讯飞」态不可达——遗留决策）；macOS 无 MSE，改 AudioFileStream 流式（恒流式、无 buffered 兜底）；URLSessionWebSocketTask 无关闭码，一律按 1006；登录切云信号改 loginSuccessSerial（Windows 的 false→true 边沿会把静默续登录误判成登录瞬间，属 Windows 潜在缺陷不复制）；Mac 独有外围消费点（领读/浮窗/快速复习）经 CloudTtsRouter 网关化（Windows 无对应物）。
- **遗留**：真实服务端联调未做（REST/WSS 端点无真机往返）；流式播放未实际出声试听（mp3 分片解码一致性单测已过）；口语/跟读外围消费点网关化不在本批次（规格 §2.2，维持讯飞）；流式 ASR 模块仅有单测、无接入点（录音直译与 Windows 一致走 REST）。
- **复核**：**通过**——6 项复查全解决（字幕空串/失败段语义、译向与路由入口定格且 stop 不清路由、取票 AuthError 归类、阅读失败 toast 两分支逐字、能力 looseRecord 与 Windows `typeof v === "object"` 等价）；Windows false→true 边沿缺陷 Mac 不复制（代码注释已记录依据）。

### speak · 口语场景体系

- **摘要**：`SpeakScenarioId` 改 String、场景契约化（source/category/keyPhrases/updatedAt，Codable 宽容读取）、四内置逐字迁移（updatedAt=1767225600000）、三桶合并注册表（内置→官方→用户→兜底）；`ScenarioForge` 一句话生成（零参数系统提示逐字、四步宽容解析＋降级 clamp）；`SpeakUi` 纯函数层（目标词进度/句内切段高亮/分类计数/预览上限）；`ScenarioCatalog`＋`ScenarioCacheStore`（双形状解析、原子写、中文报错）；`ScenarioCatalogService`（preload 单飞、refresh 无节流＋in-flight 共享、非 2xx 静默、有变化才写缓存）；`SpeakScenarioEditorModel/View`（三态 sheet、保存落 speak-scenarios dirty 实体、编辑先读回 baseVersion）；对话页听力模式（UserDefaults、未揭 AI 轮 blur 遮罩＋「看原文」、目标词高亮＋「✓ 用上 N 个目标词」）、官方场景库分组与「我的场景」、埋点三工厂。8 组 141 例测试；四内置系统提示与 Windows JSON 基线逐字节一致（脚本比对）。
- **偏差**（12 条，节选）：Tauri IPC 三命令合并为进程内服务；缓存与用户场景落 Application Support（文件名与 JSON 形状一致）；编辑器 modal→sheet（Esc 经 onExitCommand、无遮罩点击关闭）；生成取消承载于 Task（拿到半截也判「已取消」）；originDevice `"mac"`；听力模式偏好 UserDefaults；埋点落本地 JSONL（Mac 无云端 `/v1/events` 通道）；「有更新才替换」以 sortedKeys 规范化串比较（仅服务端调换键序时行为不同）；UserScenarioStore 以既有 SyncStore 替代（speak-scenarios 已在同步白名单，比规格清单更贴近 Windows 同构）。
- **遗留**：SwiftUI 视图层渲染断言未做（规格 §2.4-6 允许状态机级覆盖；视图文案经人工核对＋编译验证）。
- **复核**：**通过**——30 项验收逐条核对（四内置提示 BYTE-EQUAL、生成系统提示 627 字符 BYTE-EQUAL、目录服务 20 例覆盖 Windows 18 向量、编辑器文案脚本逐字命中、对话页/听力模式/埋点逐条、测试计数与申报一致）。附 2 项 **low** 知会项：缓存两处脏文件边界的报错文案与 Windows serde 不同（上层 catch 降级空桶，UI 结果一致）；官方目录拉取期致命广播口径按规格验收「不广播」通过（知会 Windows 实际会广播、Mac SyncEngine 同模式）。

### reader · 阅读室改版

- **摘要**：路由四值化（shelf/reading/speak/vault，删 review/notes）、库四态（home/notes/focus/export）、三段外壳（folio 平面白胶囊/focus 隐中岛/vault 角标）、阅读页白卡重构（工具栏收口＋左缘进度轨＋640pt 居中列＋续读胶囊＋32pt 刊头＋译文浮层末行锚定＋阅读设置浮层七项＋dock 居中）、笔记四态（rail/stage/board 三栏＋Hero 胶带防剧透列表＋focus 轮转三卡＋export 范围预过滤＋底部切换器）、书架三列直达＋页头带数分段＋短文搜索/筛选/合并撤销、导入弹窗 initialTab＋七档白名单；随读抽查挖空全链路在复核修复轮补齐（`ReaderCore/ClozeSlots.swift` 选槽/限幅/印章/toast/朱批/战绩＋行内输入与 ？ 首字母提示，prose/parallel 双版式接入，H 键门控，设置浮层开关）——经复核确认。§2.4 全部 9 组测试＋复核轮挖空链路测试。
- **偏差**（11 条，节选）：译文浮层锚定用 NSLayoutManager 末字形 boundingRect（SwiftUI 无逐行 rect API，规格认可）；外壳 blur 用 ultraThinMaterial；conic 进度环/热力格用 trim/LazyVGrid 绘制；删除确认 NSAlert、导出 NSSavePanel、复制 NSPasteboard；修饰键文案按规格用 ⌘；dock 宽度内容自适应（固定宽会破坏布局）；more 菜单用系统 Menu（自带外点/Esc 关闭）；发现图标 SF Symbols 近似；书架默认 tab 恒为「书」。
- **遗留**：discover/feed 两个直达 tab 内容由 feed 域补齐（本域仅照抄 tab 条渲染）；账号切换清空阅读室状态未核实（不在 §2 落点）；真机 UI 走查未做；Windows vitest 48 例未重跑（未改 Windows 文件，勘察时已全过）。
- **复核**：**未通过**——上轮 11 项差距（G1 挖空链、G2 完形卡输入框、G3 notes 档 stage、G4 reviewQueue 贯通、G5 folio 皮肤、G6 键位监视器收口、G7 听写卡、G8 快捷键域、G9 导出标题、G10 浮层收口、G11 删除图标）全部已解决；但复查键位链时**新发现 1 项 medium**（正文只读视图被计入「在输入」判定，正文快捷键失效），详见上方「本轮新增待办」，待修复后复验。

### feed · 资讯订阅与发现书库

- **摘要**：`ReaderCore` 新增 FeedCatalog（严格→宽松 XML 降级链含结构性修复/条目合并截 100/推荐四源逐字/日期解析）、FeedGates（URL 门禁/状态文案/2MB 两级门禁/多编码解码：BOM 嗅探＋响应头 charset）、DiscoverCatalog（15 键信封逐行守卫/SHA-256 校验/文件大小文案/四中文文案函数）、DiscoverGates（bookId 校验/262,144 进度节流/Retry-After）；`WebExtract` 5 万字符整段保留截断；应用层 `DiscoverService`（/v1/books 目录与校验下载、流式进度、可选 Bearer 绝不因取票失败拒绝）、`FeedStore`（UserDefaults 键名与 Windows 逐字）、`IntakeService.fetchFeed`（匿名直连、浏览器 UA、20s）；导入弹窗订阅/发现两 tab 状态机与文案逐字、发现下载→EPUB tab 一次性注入、`importBook` 按 discoverImportProps 分流埋点。5 套 63 例＋既有套件追加 9 例。
- **偏差**（12 条，节选）：下载 IPC base64→进程内 Data 直传（节流公式一致）；base URL 走 resolveBaseURL（无灭灯开关）；UA 平台段 Macintosh；DOMParser→XMLDocument＋手写宽松兜底（libxml2 tidy 会剥未知标签，已实验排除）；localStorage→UserDefaults（键名逐字）；feed 状态码渲染「数字＋标准原因短语」对齐 http crate Display（1:1 非平台必然）；discover 埋点落本地 JSONL（无云端通道，已申报）；七 tab 枚举与书架发现三列由并行「书架」施工落地，本轮只填充两 tab 内容（避免重复施工）。
- **遗留**：Windows 组件级 jsdom 测试（FeedTab 15/DiscoverTab 14/ImportDialog 7 例）无逐例等价（规格已声明，交互向量以纯函数/Service/存储单测覆盖）；discover IPC 序列化形状单测无对应物（无序列化边界）；真实网络联调未做（feed 源站、镜像下载、/v1/books 行形状需与服务端对一次）。
- **复核**：**通过**——8 项复查全解决（错误文案四向量、EPUB 注入恰一次纯函数、20s 双档超时对齐 reqwest 总超时、charset 解码七向量、二阶宽松解析四态、feedTitleOf 共用降级链、.gov host 后缀口径、host 标签端口/IPv6）；复核会话实跑过滤测试 41 例 0 失败。

### relay · 学习接力

- **摘要**：`ReaderCore` 四件：LearningJSON（手写 JS JSON.stringify 语义：UTF-16 键序/数字格式/转义，跨端一致性以固定 fixture `1mzjf0s` 锁死）、ReviewEvents（事件归约与同 ID 冲突文案逐字）、RelayEntities（FNV-1a 命中 fixture、三件套编解码、withoutAudio 14 键、mergeRelayPayload）、PracticeMerge（寄存器代数 9×9×9 矩阵）；应用层 `LearningStore`（系统 SQLite＋WAL＋synchronous=FULL、账号命名空间与切换校验文案逐字、commit 单事务、音频 begin-append-finalize 含 20MiB 上限与 WAV 头逐字节一致）、SyncEngine v2（SyncOptions 协商/schemaVersions 门控/expectedNamespace 透传）、`LearningSyncEngine`（单飞、protocolVersion≠2 拒绝、两次命名空间复核、7 集合按序同步）、`PracticeRelayView`（面板：epoch/namespace 双复核、远端删除拒绝写回、游客挂起登录后恢复、录音分块先落库）；ReaderStore/SpeakStore 域文件接入、评分改走 commitReview 不可变事件（改评带 supersedesEventId）、游客→账号迁移、启动/登录静默同步、导出警告 toast。测试 74 例（含 Rust 14 向量逐条移植）。
- **偏差**（15 条，节选）：deviceId/originDevice `mac-…`/`"mac"`；含设备名文案「这台 Mac」；事件总线 NotificationCenter（事件名与 payload 同构）；SwiftUI 替代 React（文本/可达性/禁用条件逐字）；麦克风/播放走既有 MicRecorder/AVAudioPlayer（WAV 字节与 Rust 逐字节一致）；JSON 细义手写对齐；IPC 二道守卫变进程内校验（withAuth＋队列＋epoch 三层保留）；口语会话域文件目录取与 hydrate 一致的命名空间目录（Windows speak_store 与自身 verify_path 自相矛盾，规格外如实上报）；SyncStore 保留为 LearningStore 门面（对应 Windows sync.rs 委托 learning_store）。
- **遗留**：NoteStore 笔记 .md 未接 writePath/commit（不派生 notes 实体；云收方向已通；不在规格 §2.2 落点，如实申报）；learning_store.rs cargo test 未在本机运行（Windows 依赖 darwin 编译不过，Rust 回归须 Windows CI）；旧 sync JSON 导入分支无专项单测；接力面板 SwiftUI 快照测试未做（状态机 7 向量覆盖）。
- **复核**：**通过**——24 项逐条核对（practice-task 出队排除、batchLimit、省键、Task 挂起、播放器生命周期、NoteStore 经 LearningStore、限额/退避/分批向量、draftIsBlank、单 toast、按字面量键序、仅 verifyLearningNamespace、review 事件过滤、读失败 throw、空 device id、`..` 路径守卫、整页可选字段口径、登录去重、fixture、recall 保留未知字段、原文已删 toast 等）。



## 状态说明

- **有**：Mac 代码/文档已覆盖对应主要能力；边界行为仍应按验收项回归。
- **部分**：存在相关能力，但 Windows 功能集、状态、错误处理或工作流尚未对齐。
- **缺失**：在当前 Mac 工程和文档中未找到对应实现。
- **平台差异**：功能存在，操作方式或系统集成应按操作系统不同而不同。
- **待验收**：静态盘点不能证明真实 macOS 环境下行为可靠，需实机验证。

“Windows 基准”按当前工作区代码和功能说明整理。2026-10-20 复核：Windows 目录已无未提交改动；账号体系已提交（`e3a03e5`）并随 v0.9.0 发布，视为正式基线。

版本注意：Windows README 的近期更新标题仍写 v0.2.0，而当前 Tauri Cargo 包版本为 0.9.0（v0.8 桌面工作台改版、v0.9.0「沉浸口语」品牌升级与设置中心重构均已发布）；本表优先参考实际源码，README 用于补充用户可见功能，不以其版本标题作为基准。

## 总览

| 产品域 | Windows | Mac | 差距判断 |
|---|---|---|---|
| 划词翻译、流式输出、Provider、术语表、历史 | 已实现 | 已实现 | 主要链路共有；需要统一行为规格和回归标准 |
| OCR | PaddleOCR、截图浮层后处理 | Vision OCR、丰富的确认与框选辅助 | 能力集合不同；Mac 部分交互领先，识别引擎不要求相同 |
| 翻译动作与词典 | 浮窗 AI 动作条、AI 词典卡 | 浮窗操作区、快捷动作条与词典卡链已落地（第一轮 PANEL-DOCK） | 主体对齐；动作与词典行为按验收项回归，浮窗定位待实机验收；词典卡默认值拍板对齐 Windows 且经核实两端默认一致（PANEL-8，2026-10-21 注销） |
| 学习产品 | 阅读室、词汇 SRS、跟读/口语、快速复习 | 阅读室、SRS、口语对话环与复习体系均已落地（前序迭代＋第一轮 READ-PROSE/SPEAK-LOOP/REV-VAULT＋第二轮 R2-READ/R2-SPEAK/R2-REV）＋2026-11-01 八域补齐：阅读室 2026-10-26 改版、口语场景体系、官方语音网关、云同步与兑换码、学习接力、资讯订阅与发现书库 | 主体对齐；延后项已随 2026-10-21 二轮基本清偿（仅剩 SPEAK-9 文案增补），SRS 调度测试向量跨端统一仍未做（复习时间口径向量已先行统一）；2026-11-01 补齐为代码级验证，reader 域键位链 1 项 medium 待修，实机走查与服务端联调保持待验收 |
| 直播字幕/语音 | 有 | 录音直译已落地（VAD 分句＋流式听写＋句级悬浮字幕窗＋双语导出，前序 P6 迭代）；2026-11-01 官方语音网关落地（云 TTS/听写/评测、实时字幕 gateway 分支、阅读室朗读 cloud 档、登录自动切云） | 能力对齐；麦克风权限与长时运行行为待实机验收；语音网关真实 REST/WSS 与流式播放出声待实机验收 |
| 账号 | v0.9.0 已发布账号体系（登录/注册、账号页、单实例） | 登录窗（OTP/密码）、令牌刷新、Keychain 凭据与单实例守卫已落地（本轮 AUTH-CORE）；2026-11-01 起云同步/兑换码/语音网关/学习接力统一复用同一鉴权通道（401 单飞刷新重放＋expectedNamespace 账号防串守卫） | 主体对齐；Keychain 与真实服务联调待实机验收；/v1/sync、/v1/redeem 与跨端接力待真实服务端联调 |
| 系统集成与分发 | Windows 托盘、DPAPI、Tauri updater | macOS 菜单栏、Keychain、自定义更新器 | 能力相似但不是同一套行为；权限和发布需单独验收 |

## 详细矩阵

| 功能 | Windows 基准 | Mac 当前状态 | 差距 / 后续验收重点 | 优先级 |
|---|---|---|---|---|
| 应用常驻与入口 | v0.8 起主窗口为阅读工作台（阅读/口语/笔记与复习三视图），系统托盘与二级菜单保留 | 菜单栏 App、设置/历史/阅读室/快速复习入口与复习角标提醒；status item 复用改造已落地（第二轮 R2-SET） | **平台差异**。检查主要功能入口是否可发现，不要求托盘与菜单栏视觉一致；status item 复用已过代码级验收（SHELL-9 随 R2-SET 清偿） | P1 |
| 全局划词热键 | 默认 `Ctrl+Shift+Q`，可录制/保存/重新注册 | 默认 `Option+Space`，可录制并提示系统冲突 | **平台差异 + 待验收**。统一“触发选区翻译”语义，按平台保留合适组合 | P0 |
| 获取选中文本 | UI Automation 直读，失败时回退模拟复制；支持针对前台窗口的等待/回退逻辑 | 模拟 `Command+C` 并恢复剪贴板；依赖辅助功能授权；2026-11-01 misc 域消除 AX 强转崩溃面（CFTypeID 判定＋unsafeDowncast，非 AX 值返回 nil 走复制回退，`ClipboardReader.swift` 已无 `as!`，3 例单测） | **部分**。统一成功、无选区、权限不足、目标应用不兼容时的结果与提示；捕获 API 可不同 | P0 |
| 剪贴板保护 | 保存/恢复剪贴板并监测目标窗口和用户复制操作 | 保存/恢复 pasteboard，轮询 `changeCount` | **待验收**。并发复制、超时、富文本/多类型剪贴板和恢复失败要有同一验收结果 | P0 |
| 翻译浮窗 | 浮窗显示原文/译文、复制、重试、取消、固定/自动隐藏、收藏等；v0.9 品牌区与原文标签打磨 | 已有对应浮窗能力，含系统提示与错误态区分；第一轮补齐操作区、快捷动作、词典卡与四位置朗读（PANEL-DOCK），第二轮 R2-PANEL 补齐品牌区（brandMark/来源 chip）、常驻设置入口、原文默认展开与复制格式 | **有（待验收）**。状态与动作已随批次过代码级验收；浮窗定位与焦点属系统集成行为，保持待实机验收 | P0 |
| 翻译请求与流式输出 | OpenAI Chat Completions 兼容请求；连接/首字/完成状态、耗时、取消 | 支持流式翻译、等待状态、耗时、取消和保留已生成片段；2026-11-01 zher 域对齐阅读段级翻译退避与失败原因（仅结构化 429 退避 20s、每段至多 1 次组内重试、整篇至多 6 次退避、退避等待期切文/run 失效即静默退出；429/401/兜底中文文案分桶不透传上游；句子级 zhError 持久化＋「重试本段」，标题失败只报不退避） | **有**。共享请求语义、空 delta、非流式回退、取消后部分文本规则；退避与失败原因链路按验收项回归（26 例单测） | P0 |
| 语言检测与目标语言 | 中文→英文、其他语言→简体中文；可固定目标语言 | 同类中英互译和固定目标语言 | **有**。用相同输入向量验证自动方向、固定目标及边界文本 | P0 |
| Provider 与模型配置 | 13 个内置 Provider；兼容接口、模型和 Key 配置 | 有主流云端与本地 Provider 预设 | **部分/需核对**。统一预设 ID、模型名、请求参数和缺省值；目前不是共享契约 | P1 |
| Provider 诊断 | 连通性/请求验证、服务商错误分类、脱敏诊断报告和 curl | 有连接/翻译请求诊断、错误分类、报告和脱敏 curl | **部分**。诊断字段及错误类别是否一致尚无共享 fixture 验证 | P1 |
| API Key 存储 | DPAPI 加密保存 | macOS Keychain（provider 密钥与账号令牌分槽） | **平台差异 + 待验收**。安全属性相同即可；核验读取失败、覆盖、删除、provider 槽位与账号令牌槽语义；实机 Keychain 行为未验收 | P0 |
| 术语表 | 多格式解析、导入/导出、去重、预检；请求最多 80 条 | 支持多格式、预检、追加导入/导出、去重；请求最多 80 条 | **接近有**。建立共同样例集，比较解析结果、顺序、去重和 80 条上限 | P1 |
| 自定义翻译风格 | 自定义提示词追加到请求 | 支持风格编辑与预设模板 | **部分**。需确认默认模板是否属于 Windows 基准；发送内容规则应相同 | P1 |
| 推理模型兼容 | 对 DeepSeek/智谱/Qwen 等做思考模式兼容及 `<think>` 清理 | 文档明确 DeepSeek、智谱兼容 | **部分**。统一 Provider 能力表和响应净化测试 | P1 |
| 浮窗 AI 快速动作 | 润色、解释语法、总结、换种说法，共用流式管线 | 快捷动作条已落地：润色/解释语法/总结/换种说法四动作共用流式管线，结果增量渲染并接入四位置朗读（`TranslationPanel.swift:597/1339`） | **有**。本轮 PANEL-DOCK 落地，swift test＋独立验收通过（代码级）；动作提示词与结果区行为按验收项回归 | P1 |
| AI 词典卡 | 单词/短语释义、音标、多义项/例句，后台预取后打开 | 词典卡链已落地：词条类文本后台预取（与主翻译并行）、四态与 notAWord 判定、卡片/译文一键切换、失败重试入口（`TranslationPanel.swift`，对齐 Windows `dictCard` 语义） | **有**。第一轮 PANEL-DOCK 落地，swift test＋独立验收通过（代码级）；缓存与切回翻译边界按验收项回归；默认值拍板对齐 Windows 且经核实两端默认一致（PANEL-8，2026-10-21 注销） | P1 |
| OCR 触发与截图 | 默认 `Ctrl+Shift+E`；截图 overlay；本机 PaddleOCR | 默认 `Control+Option+Space`；多屏框选；Apple Vision | **不同实现，功能可比**。截图区域、方向/语言、空结果和识别失败分别验收 | P0 |
| OCR 原文确认 | 识别后处理/浮层流程与 Windows OCR overlay | 翻译前确认/修订 OCR 文本；支持空结果手动输入/粘贴 | **Mac 部分更完整**。不要按“Mac 缺失”处理；以目标共同行为规格梳理 Windows 缺口 | P1 |
| OCR 排版整理 | Windows OCR 后处理与 React overlay | Vision 识别后有多行/段落合并和大量结构保护启发式 | **实现不同，Mac 有领先项**。选同一批图片 fixture 比较可读文本和误合并 | P1 |
| OCR 框选辅助 | Windows overlay 截图/选择流程 | Retina、多屏、放大镜、边缘吸附、像素与点尺寸提示、二次调整等 | **Mac 领先项**。确定是否纳入跨端产品目标；不应无意中回退 | P2 |
| OCR 设置 | 快速/准确、语言预设、模型管理 | 快速/准确、语言预设及恢复入口 | **部分**。模型/语言差异向用户明确呈现；统一设置语义和默认值 | P1 |
| 快捷键冲突建议 | Windows 系统组合检查、运行时注册/失败回滚 | macOS 保留组合建议、注册状态提示 | **平台差异**。不能共享系统保留键表；需要一致的冲突/注册失败反馈 | P1 |
| 翻译历史 | 本地历史、搜索、收藏、导出多格式；v0.9 页头统计卡与批量操作条 | 本地历史、搜索、收藏、撤销删除、批量/范围导出等；历史窗批量操作随第二轮 R2-PANEL 落地 | **有但行为不同**。先定义共同记录字段、来源枚举、删除与导出语义（记录格式仍不兼容，见下行） | P1 |
| 历史数据格式 | `records` 包装、Unix 毫秒及 Windows 扩展字段 | 记录数组、ISO-8601、不同来源枚举 | **不兼容**。当前不能直接互换；需要 `history.schema.json`、双端迁移和往返测试 | P1 |
| 文件导出 | 文本/诊断/历史导出使用 Windows 文件选择器 | 原生保存面板、Finder 定位和复制路径 | **平台差异**。格式和数据内容一致，文件选择/定位可使用系统原生交互 | P2 |
| 首次引导 | Windows 设置和使用引导 | 有辅助功能、屏幕录制授权及 OCR 试用引导；引导标记时序已随第二轮 R2-SET 调整 | **平台差异且 Mac 更完整**。统一首次成功使用目标，保留权限步骤差异 | P0 |
| 权限处理 | 无 macOS 辅助功能/录屏授权模型 | 辅助功能和屏幕录制检查、系统设置跳转 | **Mac 专属**。划词/OCR 前检查授权，拒绝授权时给可恢复的下一步 | P0 |
| 阅读室 | v0.8 工作台化：阅读书架、文章/整本书导入、句对阅读、专注模式与行间译文、句子解析/查词双模面板、悬浮播放条；2026-10-26 改版（三段外壳、白卡重构、笔记四态、书架三列直达、随读抽查挖空） | 已实现：书架、EPUB/整本书分章导入、句对阅读、目录/章末小结、每日目标（前序迭代）；第一轮 READ-PROSE 落地正文版式双模式、xray 句子解析透镜与播放语义；第二轮 R2-READ 补齐播放条键盘滑杆、浮层 Esc 统一与查词防串扰；2026-11-01 reader 域完成「阅读室 2026-10-26 改版」移植：路由四值化（shelf/reading/speak/vault）、库四态（home/notes/focus/export）、三段外壳皮肤、白卡重构（工具栏收口＋左缘进度轨＋640pt 居中列＋续读胶囊＋译文浮层末行锚定＋阅读设置浮层七项）、笔记四态（rail/stage/board＋Hero 列表＋focus 三卡＋导出过滤）、书架三列直达＋短文搜索/筛选/合并撤销、随读抽查挖空全链路（复核修复轮补齐：选槽/限幅/印章/战绩＋行内输入与提示，复核确认） | **有**。Mac `ReaderStore` 与 `reading-room.schema.json` v1 同构；长书导入性能与播放语义按验收项回归；改版为纯代码级验证，三段外壳/白卡/挖空实际渲染待实机走查；正文快捷键让路判定过宽 1 项 medium 待修（见「2026-11-01 补齐施工」） | P1 |
| 资讯订阅与发现书库 | B3 资讯订阅：订阅源增删/TTL 刷新/两级 2MB 门禁/多编码解码/严格→宽松 XML 解析；B2 发现书库：/v1/books 目录（15 键信封）、SHA-256 校验下载、262,144 字节进度节流、Retry-After；导入弹窗新增 tab 与 discover 埋点（Windows 557e9cc/7aa33cc/f0c0472/6784bcd/1a6ebe6） | 已落地（2026-11-01 feed 域）：FeedCatalog/FeedGates/DiscoverCatalog/DiscoverGates（ReaderCore 纯函数）、`IntakeService.fetchFeed`（匿名直连、浏览器 UA、20s）、`DiscoverService`（目录与校验下载、流式进度、可选 Bearer 不因取票失败拒绝）、`FeedStore`（UserDefaults 键名与 Windows 逐字）、导入弹窗订阅/发现两 tab、发现下载→EPUB tab 一次性注入、discover_import 埋点分流 | **有（待验收）**。swift build/test 门禁全绿＋复核通过（代码级，8 项复查全部解决）；feed 真源站抓取与镜像下载未在线联调；/v1/books 15 键行形状按客户端契约重建，需与服务端对一次；discover 埋点 Mac 落本地 JSONL（无云端 /v1/events 通道，已申报） | P1 |
| 生词本与 SRS | 阅读室生词、复习调度、词条/词块管理 | 已实现：词条/词块管理、SRS 调度、口语复盘批量入生词本（前序迭代）；第一轮 REV-VAULT 落地三合一复习容器（记忆胶带手账/3 分钟快刷闯关/Markdown 导出＋内化看板）；第二轮 R2-REV 补齐完成页出口、时间口径（拍板对齐 Windows＋共享向量）、派发小签与词表挂载；2026-11-01 复习容器列表改由 reviewQueue 统一驱动（reader 域），评分改走不可变事件 commitReview（改评带 supersedesEventId）、词条/笔记/练习经 LearningStore（SQLite）跨端接力（relay 域） | **有**。数据走同一 `reading-room.schema.json` 契约；复习时间口径已拍板对齐 Windows 并纳入共享测试向量（REV-10），「同一组 SRS 调度测试向量跨端统一」仍未做，按验收项回归；跨端接力（Windows↔Mac 同一账号）待真机联调（2026-11-01 relay 域） | P1 |
| 跟读/口语学习 | v0.8 场景中心（聊刚读章节/生词造句闯关）、免长按开麦＋VAD、表达改进 diff、发音详情、SSML 慢速、跟读报告；场景体系契约化＋官方场景目录＋自定义场景编辑器＋听力模式 | 口语对话环已重构：点击开麦＋VAD 静音自动收、教练批改（coachDiff）、ISE 发音评测降级链、口语复盘入生词本（第一轮 SPEAK-LOOP）；跟读报告卡与差词训练在阅读侧已有（前序迭代）；第二轮 R2-SPEAK 落地口语页报告卡复用、SSML 慢速、跟读异常可行动卡与 VAD 阈值统一；2026-11-01 speak 域补齐口语场景体系：场景契约化＋三桶注册表（内置/官方/用户）、官方场景目录（缓存＋/v1/scenarios）、自定义场景编辑器（一句话生成）、听力模式（未揭 AI 轮遮罩＋「看原文」）、目标词进度与句内高亮、speak-scenarios 云同步 | **有（待验收）**。Windows 基准各能力均已落地并过代码级验收；phoneTips 文案增补（SPEAK-9，差 8 条）仍延后；官方场景目录与云同步依赖真实服务端待联调；麦克风授权与云端评测属系统集成/外部服务，保持待实机验收 | P1 |
| 直播字幕/录音直译 | Live Caption 窗口、麦克风录制与实时翻译；实时字幕可路由官方语音网关 | 录音直译已落地（前序 P6 迭代：VAD 分句、流式听写、句级翻译悬浮字幕窗、双语导出；麦克风设备选择随后续迭代补齐）；2026-11-01 voice 域接入实时字幕 gateway 分支（失败写段内「〔识别失败：…〕」），讯飞分支零改动 | **有（待验收）**。能力经静态核对对齐；麦克风权限、设备选择与长时生命周期属系统集成行为，保持待实机验收 | P2 |
| 官方语音网关 | 官方云语音网关：语音页（网关/讯飞路由、能力与配额、兑换引导）、云 TTS（流式 mp3 首片即播、变速保调）、云听写（WebSocket 流式）、云评测、阅读室朗读 cloud 档、登录自动切云（Windows 4d48d85/08595f3） | 已落地（2026-11-01 voice 域）：VoiceGateway 模块（REST/WS 客户端＋method/path 白名单、票据、能力缓存、TTS 拆分与确切帧/断连重试、ASR 单泵保序/128KB 切帧）、GatewayStreamPlayer（AudioFileStream＋AVAudioEngine＋TimePitch）、语音页 VoiceSettingsTab、阅读室失败 toast 两分支（quota 带兑换动作）、登录自动切云（loginSuccessSerial 触发，避开静默续登录误判）、讯飞分支零改动 | **有（待验收）**。swift build/test 门禁全绿＋复核通过（代码级）；真实网关 REST/WSS 握手、流式播放出声与听感、麦克风/权限未实机验证；官方云开放态恒真（Mac base 解析无灭灯开关，见报告偏差）；口语/跟读外围消费点仍走讯飞（规格 §2.2 不在本批次） | P1 |
| 复习提醒/快速复习 | 定时提醒、托盘徽标、快速复习窗口；v0.8 复习三合一（记忆胶带手账/3 分钟快刷闯关/内化看板/Markdown 导出） | 已实现：菜单栏角标＋30s 提醒调度＋提醒卡、快速复习迷你窗（第一轮修复重开即刷新语义）；三合一复习容器随 REV-VAULT 落地；第二轮 R2-REV 补齐完成页出口、时间口径（拍板对齐 Windows＋共享向量）、智能·X 派发小签与词表挂载 | **有（待验收）**。通知与角标在启动/睡眠/勿扰模式下的实际行为属系统集成，保持待实机验收 | P2 |
| 账号登录 | OTP/密码登录、令牌刷新、账号页分区（已提交并随 v0.9.0 发布） | 登录窗（OTP 主流程＋密码页签，对齐 LoginView.tsx）、令牌刷新单飞与 401 分支、Keychain 双令牌单槽、设置账号分区、单实例守卫（本轮 AUTH-CORE）；2026-11-01 起云同步/兑换码/语音网关/学习接力统一复用本鉴权通道（authorizedRequest：401 单飞刷新重放、expectedNamespace 账号防串守卫；登录自动切语音云档；额度用尽→账号页兑换卡聚焦） | **有（待验收）**。swift test 与独立验收通过（代码级）；Keychain 凭据与真实服务器登录/刷新未实机联调，保持待验收 | P1 |
| 云同步与兑换码 | 账户页多集合云同步（十集合白名单、版本号游标分页、首拉 replace、429 退避≤3、409 原子、LWW 严格大于才重推、413 剔除、双集合 64KB 预检、2MB 分批、串行队列）＋口语记录本地/云端合并展示＋兑换码（三业务码文案、账号页兑换卡、额度用尽聚焦引导）（Windows 6630aa7/c1e2ca7） | 已落地（2026-11-01 sync 域）：SyncStore（白名单＋按账号命名空间隔离＋切换校验）、SyncEngine（协议全量移植）、SpeakRecords（投影/还原/tombstone/合并/静默同步）、RedeemService＋RedeemCardView、口语页四落点评测入队、额度通知→兑换卡聚焦（80ms 时序）；本地存储随后随 relay 域升级为 LearningStore（SQLite）门面委托 | **有（待验收）**。swift test 门禁全绿＋复核通过（代码级）；/v1/sync、/v1/redeem 真实服务端联调未做；originDevice 报 "mac"（协议语义，服务端透传不校验） | P1 |
| 学习接力（跨端练习接力） | learning-core（复习事件归约/内容修订 FNV-1a/练习合并寄存器代数/JSON.stringify 语义）、设备端 SQLite 学习库（files/entities/cursors/audio）、账号命名空间与切换校验、expectedNamespace 二道守卫、练习接力面板（远端练习/作答/录音/同步）、游客→账号迁移、学习导出警告（Windows 7fc6abd） | 已落地（2026-11-01 relay 域）：ReaderCore 四件（LearningJSON/ReviewEvents/RelayEntities/PracticeMerge，跨端一致性以固定 fixture 锁死）、LearningStore（SQLite＋WAL＋命名空间校验＋音频事务含 WAV 头）、SyncEngine v2（SyncOptions/schemaVersions 协商）、LearningSyncEngine（单飞＋protocolVersion 门控＋两次命名空间复核）、PracticeRelayView、ReaderStore/SpeakStore 域文件接入、评分改走 commitReview 不可变事件 | **有（待验收）**。swift test 门禁全绿＋复核通过（代码级，24 项逐条核对）；Windows↔Mac 同一账号跨端往返未真机联调；learning_store.rs cargo test 未在 darwin 运行（Windows 依赖编译不过，14 向量以 Swift 等价测试背书，Rust 回归须 Windows CI）；NoteStore 笔记 .md 未派生 notes 实体（云收方向已通，已申报） | P1 |
| 自动更新 | Tauri updater、平台更新签名与 `latest.json`（v0.9.0 已带签名发布） | 自定义 manifest、下载校验、手动/自动替换流程；设置中心更新卡（检查更新＋进度）随第二轮 R2-SET 落地 | **功能有、实现差异大 + 待验收**。统一版本判断、校验和失败恢复；发布格式各自处理；更新链路（含 R2-SET 更新卡）未实机验收 | P1 |
| 日志/遥测 | 本地诊断日志与事件记录 | 本地诊断日志＋阅读埋点 JSONL（前序迭代） | **部分**。核对脱敏、保留策略、隐私字段和失败降级行为 | P2 |
| 安装、签名与发布 | NSIS 安装包、Windows 签名和 updater 附件流程 | `.app` ZIP、自定义更新 manifest；签名/公证需发布配置 | **平台差异**。以可安装、可升级、可回滚为共同目标，不要求产物相同 | P2 |

## 首个端到端试点：选中文本 → 翻译浮窗 → 历史

选择它的原因：这是两端都已有、用户频繁使用的核心链路；它能覆盖平台入口、系统权限/剪贴板、共同翻译规则、浮窗状态和持久化。OCR 适合作为第二个试点，因为两端的 OCR 引擎与确认交互差异更大。

### 试点范围

用户在任意支持文本选择的应用选中文字，触发该平台的全局热键，看到带有正确原文的浮窗；应用按当前 Provider、目标语言、风格和术语表发起翻译，逐步显示结果；用户可复制结果，成功翻译进入历史。Windows UI Automation 与 macOS 辅助功能/模拟复制是允许不同的实现。热键字符、系统授权窗口和浮窗定位也允许平台差异。

### 共同验收条件

1. 已配置 Provider 时，选中的非空文本可触发翻译；中文与非中文样例按相同的自动方向规则选择目标语言。
2. 传给翻译服务的原文保持完整，不重复、不丢首尾空白以外的正文；术语表和自定义风格按设置生效。
3. 流式 Provider 返回内容时，浮窗显示连接、等待首字和输出状态；空白片段不能被当成译文。
4. 用户取消请求后停止继续消费结果；已显示的有效片段按两端共同约定保留，且不得把未完成请求误记为成功历史。
5. 翻译成功后，原文、译文、目标语言、来源和时间写入历史；重启应用后记录仍存在。失败、空选区和取消不产生成功记录。
6. 复制译文后系统剪贴板内容正确；macOS 划词期间原剪贴板应恢复。Windows 原生选区读取应保留原有 UIA/回退行为。
7. 未授予 macOS 辅助功能权限时，Mac 显示明确提示并能跳转系统设置；未选中文本或目标应用不支持读取时，浮窗给出可理解结果，不静默失败。
8. Provider 请求失败时显示可操作错误并允许按产品约定重试；真实 API Key 不进入历史、日志或测试 fixture。
9. 热键注册失败要在设置中显示“已保存但未生效”或等价状态，不能让用户误以为功能可用。
10. Windows 与 Mac 使用相同的一组翻译逻辑 fixture 验证语言方向、请求字段、错误分类和历史语义；系统集成部分分别在对应操作系统实机验收。

### 验收样例

| 样例 | 输入/条件 | 预期共同结果 |
|---|---|---|
| 自动方向 | `Good morning.` | 目标语言为简体中文，原文进入请求且译文可复制 |
| 自动方向 | `早上好。` | 目标语言为英文，中文字符完整保留 |
| 固定目标 | 固定目标设为日语，输入 `Good morning.` | 请求目标语言为日语，不走自动中英规则 |
| 术语与风格 | 添加 `OpenAI = OpenAI` 和自定义风格后翻译含该词句子 | 请求携带有效映射和风格；不把无效术语行带入请求 |
| 无选区 | 未选中文本触发热键 | 有明确反馈，不发送空请求、不写成功历史 |
| 取消 | 慢速流式响应期间取消 | 停止后续片段；不写成功历史 |
| 请求失败 | 使用可控的错误响应 fixture | 显示对应错误，允许重试；不泄漏凭据 |
| 剪贴板保护 | 翻译前剪贴板有文本/富文本 | Mac 读取选区后恢复原剪贴板；Windows 不破坏用户复制状态 |

### 当前代码对照结果

以下是代码静态检查得出的试点初始结果，不等同于实机验收：

- **已对齐：** 两端语言方向算法都忽略空白和标点，统计指定 CJK 范围汉字与 ASCII 字母；无汉字判非中文，汉字数达到 4 或不少于字母数判中文。固定目标为空时都回退简体中文。
- **部分对齐：** 两端 system prompt 的主要规则一致（仅翻译包裹文本、术语/风格注入、保留代码和格式），但 Mac prompt 额外含产品名和短 UI 标签示例。不要用真实模型输出逐字相等作为验收，应比较目标语言、请求输入、提示词约束和结果可用性。
- **明确差异：** Windows 读取选区先模拟 `Ctrl+C`，再以 UI Automation 直读回退；两者都失败后还可等待用户真实复制最多 8 秒。Mac 只模拟 `Command+C`，轮询 pasteboard 约 0.8 秒，失败后提示当前 App 不响应；Mac 另要求辅助功能授权。若希望两端接近，优先评估为 Mac 增加 AX 读取/更清晰的恢复路径，而不是移除 Windows 回退。
- **明确差异：** Mac 在触发选区读取前检查翻译配置；Windows 先读选区并显示浮窗，再在前端检查配置。需要决定共同产品语义：无配置时是否先展示设置引导，还是先完成选区读取并保留原文。
- **数据风险：** Mac 成功记录使用翻译结果返回的目标语言；Windows 在完成事件后重新读取设置并推断目标语言。用户在请求进行期间修改设置时，两端历史目标语言可能不同。试点应改为以本次请求冻结的目标语言作为历史字段，并通过验收确认。
- **验证结果：** Windows 的 `languageDetect`、`promptBuilder`、`glossaryParser` 相关 Vitest 共 47 项通过。当前环境没有 macOS，未能运行 Swift 测试或实机验证辅助功能、热键、剪贴板和浮窗。因此本轮完成了源码级试点对照和 Windows 逻辑回归，尚未完成双机端到端运行验收。

### 试点完成定义

- 共同逻辑测试使用相同 fixture 在 Windows 和 Mac 通过。
- Windows 回归当前行为，Mac 在真实设备上完成辅助功能授权、选区读取、流式输出、复制和历史持久化验收。
- 所有平台差异被记录为明确的实现约定，而不是未解释的行为差距。
- 试点通过后，再将同一模板用于 OCR、Provider/设置、历史导入和阅读室等模块。

## 搁置与延后项（2026-10-20）

本轮六域审计中明确不做或延后的子项，编号沿用审计清单。2026-10-21 第二轮已处置完毕：6 项注销（经代码核实已随第一轮落地或两端已一致，证据见上方「2026-10-21 第二轮施工更新」注销表）；其余全部随第二轮批次清偿并通过代码级验收——SHELL-10、READ-6/9/10 随 R2-READ；SPEAK-7/8/11/13 随 R2-SPEAK；REV-9/10/11/12 随 R2-REV（REV-10 时间口径拍板对齐 Windows 并纳入共享向量）；PANEL-9/10/11/12 随 R2-PANEL；SET-5/6/8/9 与 SHELL-9 随 R2-SET。原清单现仅剩 1 项未消化：

**口语（SPEAK）**

- SPEAK-9 phoneTips 补 8 条：P2 纯文案数据，不涉行为与工程结构，两轮容量均未排入；现状为 phoneTips 条目较 Windows 基准尚差 8 条，待后续文案专项补齐。

另记两项不属编号清单、仍待办的跨端统一工作：SRS「同一组调度测试向量跨端统一」尚未建立（复习时间口径向量已先行统一，REV-10）；历史数据格式互换仍待 `history.schema.json` 与双端迁移（见矩阵「历史数据格式」行）。

打磨：两轮 P0/P1 打磨项均已应用并通过设计复验。

2026-11-01 八域补齐的新增遗留不并入本清单，见「2026-11-01 补齐施工」各域「遗留」与 `docs/mac-parity-施工报告-2026-11-01.md`；其中待修复项为 reader 域键位链 1 项 medium（正文快捷键让路判定过宽），SPEAK-9 与两项跨端统一工作（SRS 调度向量、历史数据格式）照旧挂账。

## 后续维护规则

1. 新增或改变 Windows 用户可见功能时，同一变更必须更新本矩阵对应行及行为规格；标记 Mac 状态和验收项。
2. AI 实施任务要给出矩阵行、行为规格、Windows 参考实现和 Mac 验收条件；提交结果需逐项报告验收证据。
3. 共享业务规则优先抽成共同 schema、fixture 或确定性测试。平台系统 API 可以不同，但输入、输出、状态和错误语义要有共同约定。
4. Mac 可以有平台专属增强；不得因为“追平 Windows”删除 Mac 已有能力。新增能力标注为平台增强，并确认不会破坏共享数据。
5. 发布前更新本表的状态与基线版本。未实机验证的系统集成能力保持“待验收”，不标成已对齐。

## 盘点依据

- `immersive-translator-windows/README.md` 与 `immersive-translator-windows/src/`、`immersive-translator-windows/src-tauri/src/`
- `immersive-translator-mac/README.md` 与 `immersive-translator-mac/Sources/ImmersiveTranslator/`
- `contracts/README.md` 与 `contracts/reading-room.schema.json`
- Windows 核心入口：`src-tauri/src/lib.rs`、`src/lib/tauriBridge.ts`
- Mac 核心入口：`App.swift`、`ClipboardReader.swift`、`TranslationClient.swift`、`TranslationPanel.swift`、`TranslationHistoryStore.swift`
- 2026-10-20 复核补充：`LoginWindowController.swift`、`ServerAuth.swift`、`SingleInstanceGuard.swift`、`PanelTtsSpeaker.swift`、`ReaderVaultView.swift`、`ReaderCore/SentenceXray.swift`、`ReaderTheme.swift`；Windows v0.8/v0.9 依据 `docs/windows-workbench-v08-handoff-2026-10-15.md`、`release-notes/v0.9.0.md` 与 `src-tauri/Cargo.toml`（0.9.0）；Mac 侧复核时实跑 `swift test` 全量 445 项 0 失败
- 2026-10-21 第二轮更新依据：注销项与拍板证据引自 `SingleInstanceGuard.swift`、`App.swift`、`ReaderPlaybackEngine.swift`、`ReaderViewModel.swift`、`ReaderViews.swift`、`SpeakView.swift`、`ReaderCore/SpeakLogic.swift`、`TranslationPanel.swift`、`Settings.swift` 及 Windows `src/lib/settingsStore.ts`、`src/reader/SpeakView.tsx`（逐条 file:line 见上方注销表，为 2026-10-22 实读位置）；终验 `swift test` 于 2026-10-22 文档复核时实跑复验：Executed 541 tests, 0 failures（darwin arm64 本机）
- 2026-11-01 八域补齐依据：`docs/mac-parity-specs-2026-11-01/` 八份规格（misc/zher/sync/voice/speak/reader/feed/relay，各规格头部载明对齐的 Windows commit）与 `docs/mac-parity-施工报告-2026-11-01.md`（逐域摘要/偏差/遗留/复核证据全文）；本轮矩阵行号与文件存在性为 2026-11-02 收尾实读/实查（`git status`：Mac 侧 89 改＋98 新增，全部未提交）；收尾实跑复验：`swift build` exit 0、`swift test` Executed 1268 tests, 0 failures（darwin arm64 本机；分域门禁申报数字 549→575→635→832→966→1024→1096→1177 为各域施工完成时点累计值，复核修复轮新增用例后最终为 1268）
