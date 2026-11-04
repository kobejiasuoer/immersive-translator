# Mac 对齐施工报告（2026-11-01 八域补齐）

撰写：收尾文档员，2026-11-02。依据：`docs/mac-parity-specs-2026-11-01/` 八份规格、八个施工/复核域回传的申报与复核结果（下称「申报」「复核」），以及收尾会话本机实读/实跑核对（下称「收尾实据」，逐条标注命令与输出）。本报告只做记录，不改产品代码，未提交 git——全部改动以未提交工作树形态存在。

一句话结论：**8 个领域全部施工完成，无跳过域；最终全量回归通过；复核 7/8 通过（speak 附 2 项 low 知会项），reader 复核未通过（新发现 1 项 medium 键位链差距，待修复复验）；全部为代码级验证，未实机验收。**

---

## 一、执行摘要

| 领域 | 名称 | 规格与 Windows 基线 | 施工 | 复核 | 状态 |
|---|---|---|---|---|---|
| misc | 基线杂项修复 | `misc.md`（对齐 e42018f 隐私政策卡） | 完成 | 通过（14 项逐条核对） | 有遗留 |
| zher | 翻译退避与失败原因 | `zher.md`（对齐 bc0f625） | 完成 | 通过（3 项复查差距已修复） | 有遗留 |
| sync | 云同步与兑换码 | `sync.md`（对齐 6630aa7＋c1e2ca7，规格载明「speak-assessments」命名勘误） | 完成 | 通过（8 项逐点实读） | 有遗留 |
| voice | 官方语音网关 | `voice.md`（对齐 4d48d85＋08595f3） | 完成 | 通过（6 项复查全解决） | 有遗留 |
| speak | 口语场景体系 | `speak.md`（对齐 032928a/90ae03a/2ca531d/480e094/22743ac/81aa071） | 完成 | 通过（30 项逐条核对；附 2 项 low 知会项） | 有遗留 |
| reader | 阅读室改版 | `reader.md`（对齐 1c5205d，2026-10-26 改版） | 完成 | **未通过**（上轮 11 项全解决，新发现 1 项 medium） | 有遗留 |
| feed | 资讯订阅与发现书库 | `feed.md`（对齐 557e9cc/7aa33cc/f0c0472/6784bcd/1a6ebe6） | 完成 | 通过（8 项复查全解决，过滤运行 41 例 0 失败） | 有遗留 |
| relay | 学习接力 | `relay.md`（对齐 7fc6abd） | 完成 | 通过（24 项逐条核对） | 有遗留 |

「有遗留」为任务回传的统一状态：各域均有如实申报的 skipped 项（GUI 目测、真实服务端联调、Rust 侧测试等），详见第三节各域「遗留」。

要点：

1. **最终回归通过**：收尾于 2026-11-02 实跑复验 `swift build`（Build complete，exit 0）＋ `swift test`（Executed 1268 tests, with 0 failures (0 unexpected)，darwin arm64 本机）；与任务书给定「最终全量 swift build+test：通过」一致。
2. **reader 域 1 项 medium 待修**（本轮唯一复核未通过项）：正文快捷键让路判定过宽，详见「四、遗留汇总」。
3. **未实机验收**：全局热键、辅助功能/麦克风授权、Keychain、剪贴板保护、浮窗定位、GUI 视觉与音频出声、真实服务端联调（`/v1/sync`、`/v1/redeem`、`/v1/scenarios`、`/v1/books`、语音网关 REST/WSS）全部保持待验收，与矩阵「待实机验收」文化一致（`docs/windows-mac-feature-parity.md` 已同步更新）。

---

## 二、验证方式

**分域门禁**：每域施工完成后在 `immersive-translator-mac/` 下执行 `swift build --package-path immersive-translator-mac` 与 `swift test --package-path immersive-translator-mac`（申报口径， darwin arm64 本机）。申报数字为该域完成时点的全套累计值，逐域递增：

| 时点 | misc | zher | sync | voice | speak | reader | feed | relay |
|---|---|---|---|---|---|---|---|---|
| swift test | 549 例 0 败 | 575 例 0 败 | 635 例 0 败 | 832 例 0 败 | 966 例 0 败 | 1024 例 0 败 | 1096 例 0 败 | 1177 例 0 败 |

1177 之后各域复核修复轮又新增用例（reader 挖空链路、zher chip/按钮回调、feed 复查、relay 复查等），故最终工作树为 1268 例。

**独立复核**：每域另配一轮只读复查（未运行 build/test），逐条对照 Windows 参照实现（file:line 实读）与规格 §3 验收清单；发现的差距回传修复后再复验。个别复核会话对窄范围测试实跑过（feed 复核：`swift test --filter "FeedCatalogTests|FeedGatesTests|DiscoverInvokeErrorTextTests|ReaderIntakeSheetLogicTests"` → 41 例 0 失败；misc 复核：污染域过滤运行 12/12）。

**收尾实据**（本会话实跑，2026-11-02）：

- `cd immersive-translator-mac && swift test` → `Test Suite 'All tests' passed … Executed 1268 tests, with 0 failures (0 unexpected)`，`SWIFT_TEST_EXIT=0`（后台任务 exec_74f42bb6，输出无任何 failed 行）。
- `swift build` → `Build complete! (0.14s)`，`BUILD_EXIT=0`。
- `git status --short` 统计：89 modified＋98 untracked＋10 deleted（deleted 全部在 `immersive-translator-mobile/src/screens/`，与本轮无关；Mac 侧改动与新增文件均未提交）。
- misc 抽查：`sed -n '1,10p' immersive-translator-mac/scripts/build_app.sh` → 第 6 行 `APP_VERSION="${APP_VERSION:-0.11.1}"`；`grep -n 'VERSION=' immersive-translator-mac/scripts/package_release.sh` → 第 6 行 `VERSION="${1:-${APP_VERSION:-0.11.1}}"`；`grep -n 'as!' …/ClipboardReader.swift` → 无命中；`git diff --stat -- docs/privacy-policy.md immersive-translator-windows/src/views/privacyPolicy.ts` → 空。
- 新文件抽查：misc/sync/voice/speak/reader/feed/relay 各域代表文件（`PrivacyPolicyContent.swift`、`SyncStore/SyncEngine/SpeakRecords/RedeemService/RedeemCardView.swift`、`VoiceGateway/`（16 个 .swift）、`ScenarioCatalogService/ScenarioForge/ClozeSlots.swift`、`FeedCatalog/DiscoverService/LearningStore/LearningSyncEngine/PracticeRelayView.swift` 等 18 个）全部存在；新增测试目录项 56 个。
- reader medium 差距代码实读：`ReaderViewModel.swift:2636-2639`（`textInputHasFocus` 判定 `responder is NSTextView || responder is NSTextField`）、`:2701`（`let typing = …`）、`:2719`（`guard !typing else { return false }`）；`ReaderSentenceText.swift:62-63/:556-557`（`isEditable=false`＋`isSelectable=true`）。

**边界说明**：上述门禁与复核结果中，除「收尾实据」一节所列外，均为申报/复核回传内容，收尾文档员未重跑每一域的全量套件（仅重跑最终全量一次）；各域行号以申报/复核时点实读为准，收尾抽查发现个别行号已有漂移（如 reader 复核引 `:2618` 实为 `:2636`），报告以实读值为准并注明。

---

## 三、逐域详情

### 3.1 misc · 基线杂项修复

**目标**（`docs/mac-parity-specs-2026-11-01/misc.md`）：对齐 Windows e42018f——① 关于页隐私政策卡（Store 政策 10.5.1 应用内可访问）；② 打包脚本默认版本 0.1.1→0.11.1；③ 修复危险区测试基线污染；④ 消除 `ClipboardReader.swift:70` AX 强转。

**施工摘要**：

- 新建 `PrivacyPolicyContent.swift`：更新日期、导语、六节、联系方式逐字抄自 Windows `privacyPolicy.ts`，另加卡标题/副标题常量与 `PrivacyPolicyDisclosure` 状态机（默认收起，「查看完整政策」⇄「收起」，内存态不落盘）；`Settings.swift` 关于页在「权限」卡后、dangerZone 前插入 `aboutPrivacyCard`（复用 groupCard）；卡体默认收起、条件渲染展开（导语＋六节「标题：」semibold 内联＋联系方式可选中文本），正文 12pt/lineSpacing 6/段距 8/内边距 10,12/圆角 8/1px rgba(148,163,184,0.22) 描边/最大高 260 可滚动；披露态放子视图 @State（切分区复位）＋宿主设置窗 willClose 复位。
- `build_app.sh:6`、`package_release.sh:6` 默认值 0.1.1→0.11.1；在 /tmp 独立副本以 `env -u APP_VERSION CODESIGN_IDENTITY=- ./scripts/build_app.sh` 实证 exit 0、codesign 校验通过、CFBundleShortVersionString=0.11.1。
- `SettingsDangerZoneTests` 新增 `zeroSettingsDefaults()` 清 settingsStoreKeys 与迁移 legacy 键（不清迁移旗标）；改前 4 测 1 败，改后 4/4 通过，域键集不变（13 键）。
- `ClipboardReader.swift:70` 改 `axUIElement(from:)`（CFTypeID 比对＋unsafeDowncast，:88 起），nil/非 AX 返回 nil 走 `.copyFailed`，全文件无 `as!`；新增 `ClipboardReaderAXFallbackTests` 3 例、`PrivacyPolicyContentTests` 5 例（含直接解析 Windows `privacyPolicy.ts` 逐字段对账，本次实跑未跳过）。

**改动文件**：产品 5（`PrivacyPolicyContent.swift`、`Settings.swift`、`ClipboardReader.swift`、`scripts/build_app.sh`、`scripts/package_release.sh`）；测试 3（`PrivacyPolicyContentTests.swift`、`ClipboardReaderAXFallbackTests.swift`、`SettingsDangerZoneTests.swift`）。

**偏差**（8 条，全部经复核核实成立）：

1. AX 修复未按规格字面写 `as? AXUIElement`：Swift 6.3.3 下该条件转型直接编译报错「conditional downcast to CoreFoundation type … will always succeed」，且运行时探针证实 CF 转型不做检查（强转不 trap）；改编译器推荐的 CFTypeID＋unsafeDowncast，行为对齐 Windows uia.rs 降级基线。
2. 「关闭重开回默认收起」：Mac 设置窗仅一条关闭路径且控制器常驻，@State 不自然清空，故在宿主窗 willClose 显式复位；Windows 标题栏 X 销毁窗口与之等效（保存条「关闭」按钮 Windows 侧 hide 不复位，Mac 无法区分两路径，按验收统一复位）。
3. 披露态放子视图而非 SettingsView（规格建议）：SettingsView 常驻，放上面切换分区不复位；放子视图＋`.id(activeSection)` 销毁，≡ Windows 条件卸载。
4. 渲染体系：line-height 1.7 用 lineSpacing(6) 近似；max-height 260 以实测内容高度取 min 定高（外层 ScrollView 纵向提议 nil，沿用 ReaderViews 既有 FolioContentHeightKey 模式）；描边取 Windows 原值且无底色（比规格建议的 opacity 底色更忠实）。
5. 文本选择粒度：.textSelection(.enabled) 以 Text 段为单位，跨段连选需 NSTextView，超出本轮。
6. 关于页卡位：Windows 第三卡「离线能力（PaddleOCR）」在 Mac 同位置为既有「权限」卡（Mac OCR 走系统 Vision）；两端的隐私政策卡都是危险区前最后一张内容卡。
7. 版本来源：Windows package.json＋tauri.conf.json 经 getVersion() 注入；Mac 由 build_app.sh 写 Info.plist，`swift run` 未打包显示「开发版（未打包）」为既有行为。
8. XCTest 无法宿主渲染 SwiftUI：Windows 三个 DOM 用例改在状态机与文案常量层对齐，另加解析 Windows 源文件的防漂移对账用例。

**遗留**：

- GUI 目测未做（验收 1-5、8 的实际渲染：卡位、默认收起、展开/收起、关窗复位、260 滚动容器）——本会话无 macOS GUI 自动化，启动菜单栏 app 会注册全局热键、触发权限弹窗。
- 「打包后关于页显示 v0.11.1」未实际观察（仅验证 Info.plist 注入链；本机 gitignored 的 `dist/` 有意未原地重打包以免覆盖已签名 app 及其 TCC 授权，内含 Info.plist 仍为 0.1.1，下次打包自动刷新）。
- Windows uia.rs:367 真实 RichEdit 选区读取集成测试未补 Mac 等价（需辅助功能授权的 xctest 进程＋真实焦点控件，规格 §2.3 未列）。
- xctest 进程域 `readerGlobalSettings` 污染（ReaderStore.swift，规格 §2.4 明示不在本轮）未处理，仅记录。
- `immersive-translator-mac/README.md` 的 0.1.1 示例命令未改（规格认定为示例文档非版本来源）。

**复核结论**：**通过**。14 项验收逐条核对（隐私卡结构/文案/样式与 Windows 对照文件逐字、政策文案与源文件逐字段对账实跑未跳过、政策文本零改动、版本双脚本与无其他 0.1.1 版本源、/tmp 独立打包验证、污染域 12/12、`as!` 零命中且偏差实证、testSettingsSectionsMatchWindowsIA 无改动且通过）；8 条偏差全部核实成立；`swift build` exit 0，三改动文件零告警零错误（15 条既有告警均在未改动文件）。备注：申报中的部分行号已漂移（工作树另有其他域改动），复核以实读为准。

### 3.2 zher · 翻译退避与失败原因

**目标**（`zher.md`）：对齐 Windows bc0f625——翻译 429 自动退避与失败原因透出：zhError 契约/存储/UI 全链路＋标题失败原因＋中途切文清 chip。

**施工摘要**：

- `ReaderCore/ParagraphTranslate.swift`：`translateBackoffWaitMs=20_000`、`translateMaxGroupRetries=1`、`translateMaxRunBackoffs=6`＋纯函数 `planTranslateRetry`（仅结构化 429 且双配额未满返回 20000，否则 nil，不读 Retry-After）。
- `ReaderModels.swift`：`SentencePair.zhError` 可选字段（契约已含该字段、schemaVersion 维持 1、ReaderStore 零改动）。
- `ErrorMessageFormatter.readerParagraphErrorText(status:)`：429/401/兜底三条中文文案与 Windows 逐字，绝不透传上游 message。
- `ReaderViewModel`：瞬态 `@Published titleCnError`（标题只发一次不退避）；段级翻译重构为 `translateGroupWithBackoff`（整篇共享计数盒、每段组内重试≤1、Task.sleep 醒来先验 run 失效即静默退出且不重发、失败分桶循环外一次收尾、退避等待期句子保持 pending）＋`attemptParagraph`＋`markParagraphFailed`；`retryParagraph` 清 zhError 开新 run（配额从 0 起算）。
- `ReaderViews`：失败行抽共用 `ReaderFailedRow`/`ReaderTitleFailedRow`（主文案＋原因小字 11pt/错误色 0.8 透明度＋「重试本段」；刊头标题行全角括号 0.85 透明度）。
- 新增 5 测试文件 26 例（planTranslateRetry 五向量、三条文案逐字、zhError Codable 往返＋老数据、Mirror 渲染断言、vm 级 8 例）。域门禁 575 例 0 败。

**改动文件**：产品 5（`ReaderCore/ParagraphTranslate.swift`、`ReaderCore/ReaderModels.swift`、`ErrorMessageFormatter.swift`、`ReaderViewModel.swift`、`ReaderViews.swift`）；测试 5（`ParagraphTranslateBackoffTests.swift`、`SentencePairZhErrorTests.swift`、`ErrorMessageFormatterTests.swift`、`ReaderTranslateBackoffTests.swift`、`ReaderFailedRowRenderingTests.swift`）。

**偏差**（7 条，规格授权或平台必然）：重试无 IPC tag 机制（await 请求-响应模型）；run 失效用既有 cancel＋代数（新文章管线重置 chip，等价性有专测）；Task.sleep 取消即抛、静默退出不标 failed；无沉浸云平台 401 合成信封与 token 刷新分支（Mac 仅 API Key 直连，上游真 401 落同一文案桶）；titleCnError 经 vm @Published 直读；失败行抽共用视图＋`InterlinearFoldCard` 放开为 internal（测试可见性）；vm 增 `translateBackoffWaitMsOverride` 测试注入点＋视图断言走 Mirror 取 Text 描述（可断文案与透明度，读不出字号数值）。

**遗留**：

- Rust 侧 reader_store.rs zh_error 往返 cargo test 未运行（Windows 依赖 darwin 编译不过、规格 §1.6 已注明；行为向量已由 Swift Codable 往返/老数据用例等价覆盖并实跑通过）。
- 两项既有差异规格明示不扩 scope：Mac「翻译中」chip total 计入标题而 Windows 不计；Windows 取消可救回部分译文而 Mac 取消走 stale-return。

**复核结论**：**通过**。三项复查差距全部解决：① 新增 `invalidateTranslationRun()` 收口全部失效点，chip 初置/清空均加 isCurrentRun 守卫，封死失效后回写竞态（新增切未配置文章清 chip 用例）；② 「重试本段」按钮回调改为真实调用 action 并断言重试请求恰为该段（等价 Windows btn.click()＋calledWith(0)）；③ 「InterlinearFoldCard」为申报命名过期，代码实为 internal `TranslationPopView`，无代码改动需要（申报措辞修订未附文本，未能核实，不影响行为保真）。

### 3.3 sync · 云同步与兑换码

**目标**（`sync.md`）：对齐 Windows 6630aa7（口语记录云同步：speak-sessions/speak-assessments 双集合＋账户页多集合汇总）与 c1e2ca7（redeem_code＋账户页 RedeemCard＋额度用尽提示动作位）。规格载明命名勘误：6630aa7 提交信息的「speak-attempts」是旧称，实际集合名为 `speak-assessments`。

**施工摘要**：

- 新建 `SyncStore.swift`（十集合白名单＋路径守卫、camelCase StoredSyncEntity、每集合 JSON＋游标、按账号命名空间 `sync/<ns>/` 目录隔离与切换校验、replace 保留待推实体）、`SyncEngine.swift`（版本号游标分页拉取/首拉全量 replace/stale_cursor 归零/429 退避≤3/409 整批原子＋幽灵实体 baseVersion=0＋LWW 严格大于才重推/413 剔除单实体/双集合 64KB 预检/2MB 分批/push 200 不抹并发编辑/全局串行队列＋汇总文案函数）、`SpeakRecords.swift`（投影/还原/两形状守卫/withoutAudio＋mergeRelayPayload/入队/500 条滚动裁剪/tombstone/list 过滤/展示合并/静默同步/SpeakSyncCenter）、`RedeemService.swift`（code→文案仅三业务码、RedeemModel 状态机、speakFriendlyNotice redeem 档）、`RedeemCardView.swift`（兑换卡，锚点 account-redeem）。
- 改造：`ServerAuth` 增 authorizedRequest/syncPull/syncPush/redeem（复用 withAuth，401 单飞刷新重放、非 2xx 原样带回）；账户页插「口语场景云同步」三集合一次同步汇总卡＋RedeemCard；口语页 recentSessions 本地＋云端合并、入口静默同步；口语保存写穿入队、删除与 50 条裁剪走 tombstone、超 64KB toast；评测入队四落点（阅读室＋口语发音/跟读/只练差词，仅干净结果）；额度用尽通知位「兑换更多额度」→设置账号分区滚动聚焦兑换卡（80ms 时序）。
- 补齐 4 测试文件 60 例（对齐 Windows speakRecords.test.ts/RedeemCard.test.tsx/syncEngine 关键向量/sync.rs 白名单与汇总文案逐字）。域门禁 635 例 0 败。

**改动文件**：产品 15（SyncStore/SyncEngine/SpeakRecords/RedeemService/RedeemCardView/ServerAuth/LoginWindowController/Settings/App/SpeakStore/SpeakViewController/SpeakView/ShadowAssessController/ShadowDrillView/ReaderViewModel，均在 `Sources/ImmersiveTranslator/`）；测试 4（SyncStoreTests/SyncEngineTests/SpeakRecordsTests/RedeemTests）。

**偏差**（13 条，节选全录）：originDevice 报 `"mac"`（协议语义，服务端透传不校验）；无 IPC 边界（令牌「不跨 IPC」以「不离开进程」等效）；本地存储 JSON 文件 `sync/<ns>/*.json`（规格允许；后被 relay 域升级为 LearningStore/SQLite 门面委托）；UI 控件 SwiftUI 化（文案/状态机/时序逐字）；设置窗导航复用＋redeemFocusRequestID 信号；SpeakSessionRecord 以字典承载开放索引；SpeakAssessmentRecord 构造器放 ImmersiveTranslator（PronunciationResult 在 XfyunCore，模块依赖方向不可逆）；富会话音频红线经 merge 路径＋withoutAudio＋push 正则三重测试覆盖（封闭 Codable 无法直接注入 audioB64）；还原兼容：非内置场景 id 记录返回 nil 展示合并丢弃不崩溃；RedeemCard 提交状态机拆 RedeemModel 供无 UI 单测；429 sleep 依赖注入（单测零等待）；拉取实体行字段不齐整行丢弃（防御性收紧）；Windows 现行 learning_store::put 的 dirty-LWW 深防未移植（基线 JSON store 无此层）。

**遗留**：

- practice-task 终态合并不移植（规格 §2.3 明示 Mac 本期无练习接力；按「忽略不崩溃」处理并有测试）。
- 「练习保存失败：{message}」toast 未新增（超落点；后由 relay 域以 SpeakViewController persistSession catch 补齐并复核确认）。
- redeemCard 视图层交互（submitting 禁用、Return 提交）无 macOS 无头 UI 测试基建（以 RedeemModel 状态机单测＋视图同源绑定替代）。
- 服务端行为不可验证（immersive-translator-server 不在本仓）：/v1/sync 与 /v1/redeem 按客户端两侧实现与契约文档 1:1 镜像，未真机联调。

**复核结论**：**通过**。8 项逐点实读核对：authorizedRequest 在 AuthError 时 emitFatalIfNeeded 后重抛、syncPull/syncPush/redeem 全经它走（与 sync.rs/redeem.rs 同收尾）＋4 个致命鉴权用例；80ms 回调内 scrollIntoView+focus 对应物；batchLimit 同式；SyncPullPage 可选字段口径；命名空间复用 LearningStore.accountNamespace（与 auth.rs 一致）；「同步失败：{error}」形态符合规格，Windows "[object Object]" 属缺陷不复制；SpeakViewController persistSession catch→toast 逐字且会话保留（六处保存调用点全走）。

### 3.4 voice · 官方语音网关

**目标**（`voice.md`）：对齐 Windows 4d48d85（官方语音网关主批次：语音设置双栏＋登录自动切云＋实时字幕路由接入）与 08595f3（朗读引擎「云音色」升格：gateway 走官方网关流式 TTS）。

**施工摘要**：

- 工作区存在上一轮半成品（初始基线连测试都跑不完：ReaderViewModel.init 的 NSApp.delegate 在 xctest 崩溃＋4 处语音断言失败），本轮逐文件对照 Windows 源码审查后补齐。
- 新建 `VoiceGateway/` 16 文件：VoiceHttp/VoiceRest（method/path 白名单校验、请求体与 synthesis 帧逐字对齐 JSON.stringify：键序固定、`/` 不转义、数值/布尔严格区分）、VoiceTicket、VoiceCapabilities（配额与 qPI 展示、迟到结果丢弃）、VoiceAsrStream（AsyncStream 单泵保序、128KB 切帧、stop/换 lang/终局）、VoiceTts（TtsTextSplit 码点迭代＋JS trim 口径、确切帧、第二片断连重试）、VoiceRoute/CloudTtsRouter（resolve 级路由、Mac 外围消费点整段收齐）、GatewayViewState、GatewayVoiceSection、VoiceErrors、Pcm16k、ReaderSpeechRoute。
- `GatewayStreamPlayer`：AudioFileStream＋AVAudioConverter＋AVAudioEngine/TimePitch 流式 mp3 首片即播、按序追加、打断、空音频失败（首片后失败分开处理）。
- 阅读：朗读 cloud 档流式播放；失败 toast 两分支（`readerSpeechFailureToast` 与 ReaderApp.tsx 逐字：网关 code→voiceErrorDisplayText＋quota 兑换动作；其余→归因＋重试后缀）。
- 实时字幕：gateway 失败写段内「〔识别失败：…〕」，讯飞分支零改动；顺带修复既有录音器条件写反 bug＋防重复开麦。
- 登录自动切云：改订阅 `ServerAuthClient.loginSuccessSerial`（仅交互式登录成功递增），AppDelegate 落盘＋设置窗 4 秒绿色提示（原 loggedIn 边沿会把每次启动的静默续登录误判为登录瞬间，违反规格 1.1(b)）。
- 测试按 Windows 各单测补齐（TTS 确切帧/ASR 保序与切帧/resolve 路由/凭据惰性探测/自动切云/loginSuccessSerial/迁移判定/mp3 分片解码一致性等）。域门禁 832 例 0 败；流式与异步相关子集连跑 5 次 51/51。

**改动文件**：产品 32（`VoiceGateway/` 16 个 .swift＋`Resources/voice/ise-test-sample.pcm`＋`ReaderCore/ReaderSpeechRoute.swift`、`ReaderCore/ReaderSettings.swift`＋App/ServerAuth/Settings/LiveCaptionController/LiveCaptionWindow/ReaderPlaybackEngine/ReaderViewModel/ReaderViews/XfyunCredentialsStore/LeadSpeaker/PanelTtsSpeaker/QuickReviewWindow）；测试 18（GatewayStreamPlayer/GatewayViewState/LiveCaptionRoute/Pcm16k/ReaderSpeechRoute/ServerAuth/TtsTextSplit/VoiceAsrStream/VoiceCapabilities/VoiceErrors/VoiceGatewayWebSocketTestSupport/VoiceHttp/VoicePrefs/VoiceRest/VoiceRoute/VoiceTicket/VoiceTts Tests＋`ReaderCoreTests/ReaderTtsMigrationTests.swift`）。注：App/Settings/ReaderViewModel/ReaderViews/ServerAuth 同时含其他域改动，此处只计语音相关。

**偏差**（12 条，节选全录）：传输层无 IPC（VoiceHttp 进程内直调 authorizedRequest，voice.rs 白名单本地复刻，x-quota-* 头白名单补在传输层）；官方云恒视为开放（resolveBaseURL 恒有值，cloudOpen 恒真，「仅讯飞」态文案不可达——遗留决策）；macOS 无 MSE，改 AudioFileStream 流式（恒流式，Windows 才有 buffered 兜底）；Mac 独有外围消费点（领读/浮窗/快速复习）因 TtsProvider 增 .cloud 必须处理，经 CloudTtsRouter 网关化（Windows 08595f3 无对应物）；URLSessionWebSocketTask 无 onopen（首个 ping/pong 为 open 信号）与关闭码（一律按 1006，Windows 本就不看 code）；录音采集生产恒走 16k 直通（重采样分支按 Windows 逐行移植保留）；登录切云信号改 loginSuccessSerial（用户可见结果一致：登录瞬间切 gateway＋4 秒提示，讯飞凭据保留）；DPAPI→Keychain 提示文案；系统语音 AVSpeechSynthesizer；SwiftUI 控件形态；实时字幕讯飞分支保留 Mac 既有文案与呈现（规格要求讯飞分支零改动，与 Windows 讯飞文案不同时取零回归）；ASR 取票 AuthError 按 code 归类（鉴权类终局不重试，取规格 §1.5 字面语义）；阅读室网关非协议错误沿用 Mac 既有归因 toast 格式；语音页能力拉取跟随视图生命周期（每次进入语音分区重拉）。

**遗留**：

- 真实服务端联调未做（仓库无 immersive-translator-server；REST/WSS 只用假传输/假 WS 单测，URLSessionVoiceWebSocket 未对真实网关握手，ticket/asr/ise/tts 无真实往返）。
- 流式播放器未实际出声试听（mp3 分片解码一致性单测实跑通过；AVAudioEngine 输出链路、首片即播听感、变速效果未实测）。
- 口语/跟读外围消费点网关化（ShadowAssessController、SpeakViewController 等）规格 §2.2 不在本批次，维持讯飞；流式 ASR 模块只有单测无接入点（录音直译与 Windows 一致走 REST）。

**复核结论**：**通过**。6 项复查全解决：① gateway 空串→移除占位段（不 trim，同 Windows `!text`）、讯飞保留空白句标 done（3 个新用例）；② 译向与路由入口定格、stop 不清 route（2 个新用例）；③ 取票 AuthError 归类对齐 voiceAsr.ts（新用例）；④ Windows false→true 边沿缺陷 Mac 不复制（loginSuccessSerial，代码注释已记录依据，属「不要求改动」项）；⑤ `readerSpeechFailureToast` 两分支与 ReaderApp.tsx 逐字＋3 个新用例；⑥ looseRecord 数组按下标键视作记录与 Windows 等价（新用例）。

### 3.5 speak · 口语场景体系

**目标**（`speak.md`）：对齐 Windows 六笔（032928a 场景 id 放开 string＋内置卡契约新形态；90ae03a 三桶合并＋官方目录缓存；2ca531d 一句话生成纯函数；480e094 自定义场景编辑器；22743ac SpeakView 拆分＋speakUi＋听力模式；81aa071 官方目录去 15 分钟节流）。

**施工摘要**：

- ReaderCore：`SpeakScenarioId` 改 String typealias、`SpeakScenario` 契约形态（source/category/keyPhrases/updatedAt，Codable 宽容读取＋JSON 互转）、四内置逐字迁移（updatedAt=1767225600000）、三桶合并注册表（内置→官方→用户→兜底，缺必填/内置撞车/桶内重复过滤）、`isSpeakScenarioLike` 只校必填、`SpeakSession.scenario` 字符串化（旧四值 JSON 兼容）、`speakScenarioCardTitle` 兜底「自定义场景」。
- `ScenarioForge.swift`（零参数系统提示逐字、`<scenario-idea>` 用户输入、四步宽容解析＋降级 clamp）、`SpeakUi.swift`（targetProgress/nextTargetKey/findTargetSpans/annotateSegments/scenarioSummary/scenarioCategoryCounts/filterScenarioPreview 上限 8）、`ScenarioCatalog.swift`（裸数组/{scenarios} 双形状、三态徽标文案）、`ScenarioCacheStore.swift`（official_speak_scenarios.json、NotFound/空→[]、损坏/版本不兼容中文报错、tmp＋原子替换、串行锁）、TelemetryEvent 三工厂。
- 应用层：`ScenarioCatalogService`（preload 单飞 once＋各来源独立降级永不 throw、refresh 无节流＋in-flight 共享＋非 2xx 静默＋有变化才写缓存、GET /v1/scenarios 走 authorizedRequest）、`SpeakScenarioEditorModel/View`（input→generating→form 三态、文案逐字、失败不清 idea 与表单、保存落 speak-scenarios dirty 实体 originDevice=mac、编辑先读回 baseVersion、仅新建发 scenario_create）；SpeakViewController 听力模式（UserDefaults key `immersive-translator-speak-listen-mode`、revealedTurnIndices 状态机、listenMode 不喂流式原文）、系统提示注入用户场景 keyPhrases、speak_session_start 报真实 source；SpeakView 官方场景库分组（三态徽标/分类 chips/紧凑卡/展开收起）＋「我的场景」（多端同步/新建/编辑）、听力模式遮罩＋「看原文」、目标词高亮＋「✓ 用上 N 个目标词」、thinking 占位。
- 8 组测试 141 例（过滤运行 0 失败）；四内置系统提示与 Windows speakLogic.test.ts:260-273 JSON 基线逐字节一致（脚本比对，4 条 BYTE-EQUAL）。域门禁 966 例 0 败。

**改动文件**：产品 14（ReaderCore：SpeakLogic/ScenarioForge/SpeakUi/ScenarioCatalog/ScenarioCacheStore/TelemetryEvent；应用：ScenarioCatalogService/SpeakScenarioEditorModel/SpeakScenarioEditorView/SpeakViewController/SpeakView/SpeakRecords/App/ReaderViews）；测试 13（SpeakLogicScenario/ScenarioForge/SpeakUiScenario/ScenarioCacheStore/TelemetryEvent/Speak/SpeakReview/VaultExport Tests＋ScenarioCatalogService/SpeakScenarioEditorLogic/SpeakViewControllerListenMode/SpeakRecords/SpeakViewControllerRace Tests）。

**偏差**（12 条，节选全录）：Tauri IPC 三命令（scenario_fetch_official/cache_read/cache_write）合并为进程内服务；缓存与用户场景落 Application Support（Windows app_data_dir；文件名与形状一致）；编辑器 modal→sheet（Esc 经 onExitCommand，无遮罩点击关闭手势，生成中/保存中 interactiveDismissDisabled）；一句话生成取消承载于 Task（半截文本也判「已取消」）；originDevice `"mac"`；听力模式偏好 localStorage→UserDefaults（key/取值/缺省一致；revealedTurns 挂跨路由存活的控制器，切 tab 回来不重置遮罩）；埋点走本地 JSONL（Mac 无云端 /v1/events，事件名与字段对齐 analytics.ts 白名单）；「有更新才替换」用 sortedKeys 规范化比较与写盘（仅服务端只调换键序时行为不同）；句内高亮只按目标词切段（发音逐词着色在 Mac 右栏透镜卡既有实现；两层切段纯函数已按 Windows 口径移植）；规格 §4.3 retryAfterSeconds 差异不存在（Mac 已有该字段）；`UserScenarioStore.swift` 未另建（既有 SyncStore 已在白名单且与 Windows syncStoreList/Put 同构，比规格清单更贴近 1:1）。

**遗留**：

- SwiftUI 视图层渲染断言未写（规格 §2.4-6 注明状态机级测试即可；视图文案逐字复刻经人工核对与编译验证）。

**复核结论**：**通过**。30 项验收逐条核对（数据与注册表、系统提示零漂移——四内置与生成提示均 BYTE-EQUAL、缓存 7 例一一对应、目录服务 20 例覆盖 Windows 18 向量＋并发闸门、编辑器 17 例覆盖 12 向量＋文案脚本逐字命中、入口页/对话页/听力模式/埋点逐条、8 组测试计数与申报一致、全仓无残留枚举式场景引用）。附 2 项 **low** 知会项（不阻塞）：① 缓存读取在两个脏文件边界与 Windows serde 报错文案不同（上层 catch 降级空桶，UI 结果一致，`ScenarioCacheStore.swift:87-93`）；② Windows scenario_fetch_official Err 分支会 emit_fatal 广播，Mac 走 authorizedRequest 不广播——规格 §1.3/§1.9 与验收项 9 明文「不广播」，按验收口径通过（Mac SyncEngine 同模式，仅知会）。

### 3.6 reader · 阅读室改版

**目标**（`reader.md`）：对齐 Windows 1c5205d（2026-10-26 阅读室全面改版）：三段外壳、阅读页白卡重构＋进度轨、笔记四态（home/notes/focus/export）、书架三列直达。规格勘察时 Windows 侧 4 文件 48 例 vitest 全过。

**施工摘要**：

- 路由四值化（shelf/reading/speak/vault，删 review/notes）、VaultPlayMode 四态、三段外壳（folio 平面白胶囊/focus 隐中岛/vault 角标）、阅读页白卡重构（工具栏收口＋左缘进度轨＋640pt 居中列＋续读胶囊＋32pt 刊头＋译文浮层末行锚定＋阅读设置浮层七项＋dock 居中）、笔记四态（rail/stage/board 三栏＋Hero 胶带防剧透列表＋focus 轮转三卡两级提示＋export 范围预过滤＋底部快捷切换器）、书架三列直达＋页头带数分段＋短文搜索/筛选/合并撤销、导入弹窗 initialTab＋七档 tab 白名单。
- ReaderCore 纯逻辑层（VaultGradeBands/VaultListEntries/VaultFocusCore/ShelfCore/VaultExport 范围过滤）与 §2.4 全部 9 组 Swift 测试。域门禁 1024 例 0 败。
- **复核修复轮补齐**（申报与复核之间）：随读抽查挖空全链路——`ReaderCore/ClozeSlots.swift`（选槽/限幅/印章/toast/朱批/战绩，与 clozeSlots.ts、ReadingView.tsx 逐项一致）、`ReaderClozeText.swift`（附件槽＋行内 TextField＋? 首字母提示＋印章覆盖层），prose/parallel 双版式接入，工具栏战绩 meter、toast 层、vm.commitCloze/useClozeHint/clozeVerdict（known 槽联动 SRS）、换篇清作答态；完形卡内嵌 VaultBlankInput（placeholder/aria/onSubmit/自动聚焦）；notes 档走 HomeStageView（stage-head 常驻）；rail/列表/Hero/board/home-Enter 全部改用 reviewQueue；`ReaderThemeTokens.tokens(for:skin:)`＋folioLight（色值与 reader.css 一致）；窗口监视器把按键全数交给 vm（focus 态输入框内 Esc/Tab 可达）；听写卡多行 TextField；导出区标题；浮层收口；删除图标常显。

**改动文件**：施工轮产品 12（ReaderCore：ReaderSettings/VaultExport/VaultGradeBands/VaultListEntries/VaultFocusCore/ShelfCore；应用：ReaderViewModel/ReaderViews/ReaderVaultView/ReaderIntakeSheet/ReaderSentenceText/ReaderTheme）；施工轮测试 11（ReaderCore 6＋应用 5）。复核修复轮据复核证据另触：`ReaderCore/ClozeSlots.swift`、`ReaderClozeText.swift`（新建）、ReaderVaultView/ReaderViewModel/ReaderViews/ReaderSettings/ReaderWindowController（改动）、`ReadingClozeChainTests.swift`/`ClozeSlotsTests.swift`（新建）。

**偏差**（11 条，节选全录）：译文浮层锚定用 NSLayoutManager 末字形 boundingRect（SwiftUI/AppKit 无逐行 rect 枚举，规格 §4-3 认可；锚定公式不变）；外壳 blur 用 ultraThinMaterial、folio 去投影改平面白胶囊（token 对账进测试）；conic 环/热力格/三色分段条用 trim/LazyVGrid 绘制（rail-label 横排折行，无竖排 writing-mode 等价）；删除确认 NSAlert（三处文案逐字）；导出 NSSavePanel＋NSPasteboard（「已复制」2.4s 回落不变）；修饰键文案按 §4-8 用 ⌘；dock 宽度内容自适应（固定宽破坏布局；居中公式一致）；短文行 more 菜单系统 Menu（自带外点/Esc 关闭）；书架行点击直达无键盘 Enter（VoiceOver isButton 语义）；发现三列图标 SF Symbols 近似 Feather SVG；书架默认 tab 恒为「书」（移除 Mac 旧有自动切短文逻辑）＋系统控件替代自绘 role 语义对齐。

**遗留**：

- discover/feed 两个直达 tab 内容未在本域实现（tab 条渲染照抄、点击进缺省文库不报错；内容由 feed 域补齐——已补齐，见 3.7）。
- 账号切换清空阅读室状态（§1.5 末条）未核实/未改（不在 §2 落点）。
- 真机 UI 走查未做（三段外壳/白卡/四态/书架三列/挖空的实际视觉与浮层锚定仅由代码与单测背书）。
- Windows 侧 vitest 48 例未在本轮重跑（未改 Windows 文件）。

**复核结论**：**未通过**。上轮 11 项差距（G1-G11）全部已解决（挖空链、完形卡输入、notes stage、reviewQueue 贯通、folio 皮肤、键位监视器收口、听写卡、快捷键域、导出标题、浮层收口、删除图标，逐条 file:line 证据见复核回传）；但复查 G6 键位链时**新发现 1 项 medium**：`textInputHasFocus`（`ReaderViewModel.swift:2636-2639`，收尾实读）把只读、可选中的正文文本视图也算「在输入」——正文 NSTextView `isEditable=false, isSelectable=true`（`ReaderSentenceText.swift:62-63/:556-557`），点击词句即成第一响应者，此后 `guard !typing`（`:2701/:2719`）让 Space/J/K/L/H/E 全部让路直到焦点移走；Windows `isTyping` 只认 input/textarea/contentEditable（`ReaderApp.tsx:2097-2105`）。规格 §3-32 未满足。HEAD 就已存在，修复轮未触及。该条依据 AppKit 语义＋代码阅读推断，未 GUI 实测。**待修复后复验**（建议判定收窄为「可编辑的 NSTextView（含字段编辑器）或 NSTextField」，并补回归用例）。

### 3.7 feed · 资讯订阅与发现书库

**目标**（`feed.md`）：对齐 Windows 五笔：557e9cc（书目目录传输与下载）、7aa33cc（B3 feed 抓取命令）、f0c0472（发现页与导入管线衔接）、6784bcd（订阅列表/推荐清单/FeedTab 第 7 tab）、1a6ebe6（导入正文 5 万字符截断）＋入口关联 1c5205d。

**施工摘要**：

- ReaderCore：`FeedCatalog`（parseFeedXml 严格→宽松降级＋二阶结构性修复/isFeedShaped/mergeFeedEntries 截 100/推荐四源逐字/feedTitleOf 共用降级链/日期解析 ISO8601＋RFC2822）、`FeedGates`（URL 门禁/状态文案「数字＋标准原因短语」/2MB 两级门禁/decodeFeedBody：BOM 嗅探＋响应头 charset）、`DiscoverCatalog`（15 键信封逐行守卫/CryptoKit SHA-256/formatFileSize/四个中文文案函数）、`DiscoverGates`（validateBookId/buildBooksQueryItems/262,144 进度节流/parseRetryAfter）；`WebExtract` 增 truncated＋capTextChars 5 万截断（分隔符计入预算、首段恒保留）；`BookImport` 增 sourceBookId＋discoverImportProps；TelemetryEvent 四工厂（feed_view/feed_import/discover_view/discover_import）。
- 应用层：`IntakeService.fetchFeed`（匿名直连、浏览器 UA＋20s）、`DiscoverService`（/v1/books 目录与下载、可选 Bearer 绝不因取票失败拒绝、30s/300s 超时、流式进度回调）、`FeedStore`（UserDefaults 两键逐字沿用 Windows localStorage 键名）；`ReaderIntakeSheet` 增订阅/发现两完整 tab（状态机与文案逐字）、发现下载→pendingEpub 同帧注入 EPUB tab 一次性消费（抽纯函数 consumeEpubInjection）、UrlTab 截断提示；`importBook` 入库 toast 后按 discoverImportProps 分流埋 discover_import；App.swift 一行接线。
- 5 个新测试套件 63 例＋IntakeTests/BookImportTests/TelemetryEventTests 追加 9 例。域门禁 1096 例 0 败。

**改动文件**：产品 13（ReaderCore：WebExtract/FeedCatalog/FeedGates/DiscoverCatalog/DiscoverGates/BookImport/TelemetryEvent；应用：IntakeService/FeedStore/DiscoverService/ReaderIntakeSheet/ReaderViewModel/App）；测试 8（FeedCatalog/FeedGates/DiscoverCatalog/DiscoverService/FeedStore/Intake/BookImport/TelemetryEvent Tests）。复核修复轮另触：`ReaderCore/FeedGates.swift`（decodeFeedBody）、`DiscoverInvokeErrorTextTests.swift`、`ReaderIntakeSheetLogicTests.swift`（新建）等。

**偏差**（12 条，节选全录）：下载 IPC base64→进程内 Data 直传（节流公式一致）；base URL 走 resolveBaseURL（无灭灯开关）；UA 平台段 Macintosh；XML 载体 DOMParser→XMLDocument＋「实体消毒后宽松重解析」手写兜底（libxml2 tidy 会剥未知标签，/tmp 实验排除）；Date.parse→Formatter 组合；订阅存储 localStorage→UserDefaults（键名逐字）；订阅 id UUID().uuidString；epubFileOf File→EpubTabInjected 直传（文件名校验行为保持）；discover 埋点落本地 JSONL（无云端通道，已申报）；feed 状态码渲染「数字＋标准原因短语」对齐 http crate Display（1:1 非平台必然）；FeedStore/discoverInvokeErrorText 落位微调（鉴权依赖决定归宿，纯函数仍全留 ReaderCore）；七 tab 枚举与书架发现三列由并行「书架」施工落地，本轮只填充两 tab 内容（避免重复施工）。

**遗留**：

- Windows 组件级 jsdom 测试逐例等价（FeedTab 15/DiscoverTab 14/ImportDialog 7 例）无 SwiftUI 组件测试基建（规格 §4 已声明；交互向量以纯函数/Service/存储单测覆盖）。
- discover.rs download_result_serializes_camelCase 单测无对应物（同进程直传无该序列化边界）。
- 真实网络联调未做：/v1/books 15 键行形状按客户端实证契约重建（服务端源码不在本仓，联调时需对一次）；feed 抓取与镜像下载未对真源站/真服务端在线验证。

**复核结论**：**通过**。8 项复查全部解决：① discoverInvokeErrorText 四向量专测；② EPUB 注入抽纯函数 consumeEpubInjection＋闭包计数断言恰一次；③ IntakeService 双档超时均 20s（对齐 reqwest 总超时，fetchArticle 同步对齐无回归）；④ decodeFeedBody charset 解码七向量（iso-8859-1/GBK/GB2312/windows-1252/BOM/lossy/只看响应头）；⑤ 宽松链加二阶 .documentTidyXML 结构性修复＋四态坏 XML 仍抽条目且门禁不放宽；⑥ feedTitleOf 共用降级链（残差「错误落在 title 内部」已声明需 Windows 侧联调——Mac 无法运行 WebView2，平台理由成立）；⑦ .gov 判定改 host 后缀（对齐 hostname.endsWith）；⑧ feedHostLabel 端口/IPv6 口径＋专测。复核会话实跑过滤 41 例 0 失败。

### 3.8 relay · 学习接力

**目标**（`relay.md`）：对齐 Windows 7fc6abd——学习接力 v2：共享 learning-core 包、练习接力视图、跨端同步与账号防串。

**施工摘要**：

- ReaderCore 四件：`LearningJSON`（手写 JS JSON.stringify 语义：UTF-16 键序/数字格式含 -0/1e21/1e-7/2^53+ 补零/转义）、`ReviewEvents`（isReviewEvent/canonicalJSON/reduceReviewEvents，同 ID 冲突文案逐字）、`RelayEntities`（contentRevision UTF-16 FNV-1a 固定 fixture `1mzjf0s` 命中、三件套编解码、withoutAudio 14 键、mergeRelayPayload）、`PracticeMerge`（寄存器代数 stamp/merge/mergePayload，undefined 哨兵 U+10FFFF、scalar 序决胜、removedAttemptIds 删除优先）。
- 应用层 `LearningStore.swift`（系统 SQLite3：files/entities/cursors/audio_clips/audio_chunks＋WAL＋synchronous=FULL＋busy_timeout 5s；namespace guest/account-<hex>、verifyNamespace/verifyPath 文案逐字；设备 ID mac-<pid hex>-<now hex>；commit/commitMany 单事务＋事务外导出失败发 learning-export-warning 不回滚；derive/projectArticle/enqueue/tombstone/hydrate(+hydrateReviews)/put(replace＋practice 合并＋immutable 冲突)/adoptGuest/commitReview/migrate/audio begin-append-finalize-read-delete 含 20MiB 上限与 16kHz/16bit/mono WAV 头）；SyncEngine 升级 v2（SyncOptions 协商/schemaVersions 门控/expectedNamespace 透传/排队期切号取消）；`LearningSyncEngine`（单飞、登录前置、protocolVersion≠2 拒绝、两次命名空间复核、7 集合按序、learning-sync-complete 通知）；`PracticeRelayView`（面板：epoch/namespace 双复核、save 以产生编辑的 UI 版本盖章、远端删除拒绝写回、游客云动作挂起登录后恢复、录音分块先落库 45s 上限、全部文案逐字，「这台 Windows」→「这台 Mac」）。
- 改造：ServerAuth 增 withAuth(expectedNamespace:)（三层守卫：LearningStore 校验＋内存双校验→本地伪码 account_changed 不出网，401 刷新重放前复核）；登录后 adoptGuest→setAccount→广播；SyncStore 变 LearningStore 门面；ReaderStore/SpeakStore 域文件读写经 LearningStore；评分改走不可变事件 commitReview（改评带 supersedesEventId）；ReaderViewModel/QuickReview 接学习接力刷新、原文回跳与导出警告 toast；App 启动先接线 LearningStore 再 bootstrap。
- 测试 74 例（ReviewEvents 9/RelayEntities 9/PracticeMerge 22 含 9×9×9 矩阵/LearningStore 19 含 Rust 14 向量＋WAV 头逐字节/LearningSyncEngine 15/PracticeRelayView 7）。域门禁 1177 例 0 败。

**改动文件**：产品 18（ReaderCore 4＋应用层 14：LearningStore/LearningSyncEngine/PracticeRelayView/SyncEngine/SyncStore/ServerAuth/ReaderStore/SpeakStore/SpeakRecords/ReaderViewModel/QuickReviewWindow/SpeakViewController/SpeakView/App）；测试 8（ReviewEvents/RelayEntities/PracticeMerge/LearningStore/LearningSyncEngine/PracticeRelayView/SyncEngine/SpeakRecords Tests）。复核修复轮据复核证据另触：`NoteStore.swift`（笔记经 readPath/commit）、`ReaderViewModel.swift`（注入 store.learning）等。

**偏差**（15 条，节选全录）：设备标识与 originDevice `mac-…`/`"mac"`（规格授权）；含设备名文案「这台 Mac」（规格授权）；事件总线 NotificationCenter（事件名与 payload 同构）；SwiftUI＋ReaderPalette 替代 React（文本/可达性/禁用条件逐字）；麦克风/播放走既有 MicRecorder/AVAudioPlayer（WAV 字节与 Rust 逐字节一致）；JSON 细义手写 LearningJSON 对齐（固定 fixture 锁死跨端一致）；UUID Foundation 降级小写；IPC 二道守卫变进程内校验（withAuth＋队列＋epoch 三层保留，令牌仍 Keychain）；口语会话域文件目录取与 hydrate 一致的命名空间目录（Windows speak_store.rs 用根目录与其自身 verify_path 自相矛盾——规格外必须上报项，Mac 取自洽一侧）；SyncStore 保留门面（对应 Windows sync.rs 委托 learning_store；旧 JSON 同步数据导入 migrate 带 legacySyncDirectory 参数，因 Mac 历史布局多一层目录）；SyncEngine.syncNow(options:) 原地升级既有文件（与 Windows 7fc6abd 原地改 syncEngine.ts 一致）；复习打卡不再双写 recordReview，改 commitReview 后回读文件 reviewLog（未接线时保留回退链路）；practiceTime 用 Int64 截断（三者对整数毫秒完全一致，Mac 取更接近 TS 的截断）。

**遗留**：

- NoteStore 笔记 .md 未接 LearningStore.writePath/commit（本地笔记不派生 `notes` 集合实体；云收方向已通：pull→put→hydrateNotes 写 files 表＋导出；不在规格 §2.2 落点，如实申报）。
- Windows Rust learning_store.rs cargo test 本机未运行（windows-future/windows_core 在 darwin 编译失败；14 向量逐条移植为 Swift 测试并通过，Rust 回归须 Windows CI）。
- LearningStore.migrate 旧 sync JSON 导入分支（legacySyncDirectory）实现但无专项单测（adoptGuest 测试覆盖主体）。
- LearningRelaySync「7 集合按序各发一次」未写逐断言向量（Windows learningRelay.test.ts 亦无；入口分支与 schemaVersions 协商 skip 已测）。
- PracticeRelayView SwiftUI 快照/UI 测试未做（状态机 7 向量覆盖，规格允许；文案人工核对）。

**复核结论**：**通过**。24 项逐条核对（#1 SpeakStore 接线后不再前端入队 practice-task＋51 条裁剪断言；#2 batchLimit；#3 省键；#4 Task 挂起；#5 播放器强持有/onended 释放/切号停止；#6 NoteStore 经 readPath/commit＋注入；#7 限额/退避/分批/WAV/900/fixture 向量；#8 学习接力持久性向量 16-24；#9-#11 draftIsBlank/无 .disabled/单 toast；#12-#14 读失败 setNotice/results userInfo/按字面量键序；#15 仅 verifyLearningNamespace；#16 review 事件过滤；#17 读失败 throw；#18 空 device id；#19 `..` 路径守卫；#20 整页可选字段口径（Rust serde 无 default 同样整批失败，理由成立）；#21 登录去重；#22 fixture；#23 recall 保留未知字段；#24 原文已删 toast）。

---

## 四、遗留汇总与后续建议

### 4.1 待修复（1 项，阻塞 reader 复核通过）

| 项 | 位置 | 问题 | 建议 |
|---|---|---|---|
| 正文快捷键让路判定过宽（medium） | `immersive-translator-mac/Sources/ImmersiveTranslator/ReaderViewModel.swift:2636-2639`（判定）、`:2701/:2719`（guard）；`ReaderSentenceText.swift:62-63/:556-557`（正文视图只读可选） | `textInputHasFocus` 把一切 NSTextView/NSTextField 第一响应者判为「在输入」，只读正文被点击即触发，Space/J/K/L/H/E 全让路（Windows `isTyping` 只认 input/textarea/contentEditable；规格 §3-32 未满足；HEAD 即存在） | 判定收窄为「可编辑的 NSTextView（含字段编辑器）或 NSTextField」；修复后补一条「只读正文视图持有焦点时快捷键不让路」回归验证并实机点选正文复核键位 |

### 4.2 low 知会项（2 项，不阻塞）

1. **speak 缓存错误口径**：`ScenarioCacheStore.swift:87-93` 两处脏文件边界的报错文案与 Windows serde 不同（顶层缺 schemaVersion 报「版本不兼容」而非「missing field」；scenarios 非数组静默 [] 而非报「损坏」）；上层都降级空官方桶，UI 结果一致。
2. **speak 官方目录致命广播**：Windows scenario_fetch_official Err 分支会广播 auth-state-changed，Mac 不广播——规格验收明文「不广播」，按验收口径通过，仅知会两端行为差异。

### 4.3 实机验收清单（代码级验证 ≠ 实机验收，发布前须逐项过）

**A. Mac GUI 目测**（本机未做，各域共同遗留）

- 隐私政策卡：卡位与样式、默认收起、展开/收起、切分区复位、关窗重开复位、260pt 滚动。
- 阅读室改版：三段外壳皮肤、白卡与进度轨、译文浮层末行锚定、笔记四态、书架三列直达、随读抽查挖空（行内输入/提示/印章/战绩）；**点选正文后验证快捷键仍可用**（对应 4.1）。
- 口语场景：入口页官方库分组与「我的场景」、编辑器 sheet 三态、听力模式遮罩与「看原文」、目标词高亮。
- 语音页双栏、兑换卡聚焦、接力面板；打包产物关于页显示 v0.11.1（本机 dist 仍为旧值，下次打包刷新）。

**B. 权限与系统集成**（既有待验收项照旧）

- 全局热键、辅助功能/屏幕录制、麦克风、Keychain（provider 密钥与账号令牌）、剪贴板保护、浮窗定位、通知角标、单实例激活。

**C. 真实服务端联调**（服务端不在本仓，客户端两侧 1:1 镜像已就绪）

- `/v1/sync`、`/v1/redeem`（sync 域）；`/v1/scenarios`（speak 域）；语音网关 ticket/asr/ise/tts REST＋WSS（voice 域）；`/v1/books` 目录与下载——**15 键行形状需与服务端对一次**（feed 域）；学习同步 `/v1/learning/*` 协议 v2（relay 域）；401 刷新/token_invalid 等致命码路径。

**D. 音频实听**

- GatewayStreamPlayer 出声、首片即播、变速保调、打断；实时字幕 gateway 分支与讯飞分支对照；接力录音 WAV 回听。

**E. 跨端往返**（同一账号 Windows↔Mac）

- 云同步十集合往返（含 tombstone/LWW/429 分批）；学习接力练习接力往返（FNV-1a fixture `1mzjf0s`、canonical JSON、寄存器代数在真实数据上互认）；游客→账号迁移；expectedNamespace 防串（切换账号瞬间在途请求）。

**F. Windows CI 回归**

- `learning_store.rs`（14 向量）与 `reader_store.rs`（zh_error 往返）cargo test 在 Windows 环境执行（darwin 编译不过，本轮以 Swift 等价测试背书）。

### 4.4 既有挂账（本轮不新增、不消化）

- SPEAK-9 phoneTips 补 8 条（P2 文案专项）。
- SRS「同一组调度测试向量跨端统一」；历史数据格式 `history.schema.json` 与双端迁移（矩阵既有记录）。
- zher 两项既有差异（chip 计入标题、取消救回语义）——规格明示如需对齐另立规格。

### 4.5 流程备注

- 全部改动未提交 git（89 modified＋98 untracked，含 Mac 侧本轮全部施工）；建议按域整理提交序列（中文 conventional commits），提交前先修 4.1。
- `immersive-translator-mac/dist/` 内 Info.plist 仍为 0.1.1（gitignored，有意未原地重打包以免覆盖已签名 app 及其 TCC 授权），下次打包自动刷新；发布口径遵循 `docs/github-release-runbook-2026-10-30.md`。
- 本报告与矩阵更新均只述代码级事实；实机验收完成后应在矩阵把对应「待验收」项逐条销项。
