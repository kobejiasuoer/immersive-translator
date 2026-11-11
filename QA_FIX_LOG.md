# QA 修复日志（QA_FIX_LOG）

> 追加式记录。每条：Bug ID / 修改文件与行号 / 修改内容 / 原因 / 验证方式。
> 行号均为修复后当前工作区文件的行号（路径相对 `immersive-translator-mac/`）。

---

## 批次 P01-1（P01 第 1 批 · 第 1 次提交）· 2026-11-10

**现场备份**：`qa-artifacts/fixes-backup-P01.patch` 已存在（466872 字节，2026-11-09 20:57），按规则 1 跳过、未覆盖。
本次核对：当前 `git diff -- immersive-translator-mac` 去掉 `Sources/ReaderCore/RecallJudge.swift` 后与该备份逐字节一致（`cmp` 无差异），
即备份就是修复前现场；RecallJudge.swift 的差异只有 BUG-001 守卫这一处 hunk（见下）。未 commit / stash / reset / checkout。

**本批构建与测试（本次会话实际执行）**
- `swift build --package-path immersive-translator-mac` → exit 0，`Build complete!`（全部修改完成后又跑了一次，日志里确认重新编译了 LoginWindowController.swift）。改过的文件只有一条 warning：`ReaderViewModel.swift:2808` 'updated' never used——这是早就存在的 writeReplay 代码，不是本批改出来的。
- `swift build --package-path immersive-translator-mac --build-tests` → exit 0（测试 target 可编译，0 error）。
- 定点单测（只是更窄的自查，不代替调度器跑的全量单测）：
  - `swift test --package-path immersive-translator-mac --filter 'ReaderCoreTests.ReaderCoreTests/testWordDiff|LearningStoreTests.LearningStoreTests/testNoteStore'` → 跑了 2 个用例（testWordDiffAndDictation、testWordDiffEmptySidesDoNotCrash），0 失败。filter 的后半段没匹配到用例（模块名写错了），所以下一条单独补跑。
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.LearningStoreTests/testNoteStore'` → 跑了 1 个用例（testNoteStoreCommitsNotesEntityAndListsSyncedNotes），0 失败。
- 全量单测（额外自查，调度器的统一门禁仍以它自己跑的结果为准）：`swift test --package-path immersive-translator-mac` → exit 0，`Executed 1338 tests, with 0 failures (0 unexpected)`（2026-11-10 08:14，所有源码改动完成之后跑的）。
- GUI 实机复测：**本次未做**（没有重新打 .app 走 GUI 复现）。

---

### BUG-001 专注复习「完形→听写」轮转空输入触发 wordDiff Range 越界闪退（P0）

- **修改文件与行号**
  - `Sources/ReaderCore/RecallJudge.swift:155-166`：会话开始时工作区已有这处守卫（mtime 11-09 20:58，晚于 11-09 20:57 的备份，看起来是上一轮修复写入的，但当时没有记日志）。本次逐行核对后认为正确，**原样保留，没有改动**。
  - `Tests/ReaderCoreTests/ReaderCoreTests.swift:444-460`：新增防回归用例 `testWordDiffEmptySidesDoNotCrash`。
- **修改内容**：`wordDiff` 的 LCS 填表双循环外加了 `if m >= 1 && n >= 1` 守卫，写法和 `SpeakLogic.swift:1018` 的 `computeCoachDiff` 一致。m=0 或 n=0 时填表本来就是空操作，后面的回溯尾循环会照常输出全 miss / 全 extra。新增用例覆盖四种情况：空输入、只有标点的输入、空答案、两侧都空，另外检查 `wordHitRate("", 句子) == 0`。
- **原因**：听写卡空输入提交后，判分面板 `ReaderVaultView.swift:2170`（另一处调用点是 `ReaderReviewView.swift:1341`）调用 `wordDiff(input, source.en)`。旧代码 `for i in 1...m` 在 m=0 时构造 `1...0`，触发 Range 前置条件失败（EXC_BREAKPOINT），整个应用闪退。
- **验证方式**：`swift build` 通过；定点单测 testWordDiffEmptySidesDoNotCrash 和既有的 testWordDiffAndDictation 都通过（命令见上）。旧实现跑这个用例会在 `1...0` 处 trap——这是读代码推断的，没有回滚源码实测。GUI 复测未做。

### BUG-002 禅模式开启后无任何 GUI 退出入口，设置持久跨启动（P1）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/ReaderViewModel.swift:1355-1368`：新增 `exitZenMode()`。
  - `Sources/ImmersiveTranslator/ReaderViews.swift:5113-5121`：`ZenControlsView`（只在禅模式显示的浮动控制）里，在 上一句/播放/下一句 后面加一条竖分隔线和一个「退出禅模式」文字按钮，`.help` 写「退出禅模式，恢复侧栏与播放条」。
- **修改内容**：按钮调用 `vm.exitZenMode()`，做两件事：
  1. `patchSettings { $0.zenMode = false }`：把全局设置写成 false 并落 UserDefaults。如果全局原来是 true，会顺带把本篇文章的覆盖也补丁成 false。
  2. 如果本篇文章覆盖的 `settings.zenMode` 仍是 true，再通过 `scheduleSave` 显式写成 false。

  禅模式本身的行为（隐藏侧栏与播放条）和视图菜单开关都没动。
- **原因**：`ReaderViews.swift:5072-5073` 的视图菜单项是 zenMode 唯一的写入点。但这个菜单在 PlayBar 里，而 `:35` 的 `dockVisible = … && !settings.zenMode` 会在禅模式下把整条 PlayBar 隐藏，所以一进禅模式就没有任何 GUI 路径能退出；设置又同时存在全局 UserDefaults 和文章覆盖里，重启后依然生效。
  第 2 步不能省：`patchSettings` 是拿「全局旧值→新值」求差来生成文章补丁的（`ReaderViewModel.swift:1340`、`ReaderSettings.swift:935`），而文章覆盖的优先级高于全局（`ReaderSettings.swift:888`）。如果全局已经是 false、某篇文章的覆盖还是 true，只改全局得到的差分为空，覆盖不会被改，界面仍停在禅模式。
- **验证方式**：`swift build` 通过。没有加 VM 级单测，因为 `patchSettings` 会写 UserDefaults.standard，而仓库测试约定明确不走 patchSettings（`ReaderShellChromeTests.swift:629`、`ReadingClozeChainTests.swift:87`）。数据流按上面引用的代码静态核对过。GUI 复测未做。
- **备注**：Windows 端（`ReaderApp.tsx:2813` 禅控件，`ReaderTopBar.tsx:382-390` 菜单项）结构相同，看起来也没有退出入口。按规则 6 没有改。

### BUG-003 登出后登录窗重开残留「登录成功」态且无法再次登录（P1）

- **修改文件与行号**（都在 `Sources/ImmersiveTranslator/LoginWindowController.swift`）
  - `:86` 控制器加上 `NSWindowDelegate` 遵从。
  - `:91-99` 新增 `mountToken`（重挂载令牌）和 `remountOnNextShow` 标记。
  - `:105-110` 宿主根视图从 `LoginView` 换成 `LoginRootView`。
  - `:125` `window.delegate = self`。
  - `:135-143` `show()`：标记为真时令牌 +1。
  - `:145-152` `windowWillClose`：设置标记。
  - `:155-170` 新增 `LoginMountToken`（ObservableObject）和 `LoginRootView`（`LoginView(...).id(mountToken.generation)`）。
- **修改内容**：窗口每次关闭（✕、Esc、成功后 900ms 自动关窗都会走 performClose → windowWillClose）都记一个标记。下次 `show()` 时把令牌 +1，`.id` 一变，SwiftUI 就丢弃旧的 LoginView、重建新的：所有 @State 回到初值（邮箱页 / otp 页签 / 空 banner / existing=nil），`onAppear(bootstrapState)` 在重开时重新查一次登录态。
  - 重建推迟到 show() 而不是关窗时做，是为了让登录态快照在重开那一刻才取，避开关窗期间登出导致的僵尸快照。
  - 最小化不触发 windowWillClose，进行中的验证码流程会保留。
  - D10 重发冷却按邮箱持久化在 UserDefaults（OtpCooldownTracker），不受重建影响。
  - 登录 / 验证 / 错误处理逻辑都没改。
- **原因**：`isReleasedWhenClosed=false`（`:118`）让关窗只是 orderOut，`App.swift:363` 的 lazy 单例控制器又让同一个 LoginView 的状态跨开闭一直存活。`bootstrapState`（`:665` 起）不复位 `view`；900ms 自动关窗挂在 `onChange(of: view)`（`:299`）上，重开时 view 已经是 `.success` 不再变化，也就不会触发。结果是重开后停在成功页，没有表单可以再登。
  对照 Windows：`LoginView.tsx:36-40` 的 `closeSelf()` 调 `getCurrentWindow().close()`，`src-tauri/src/lib.rs` 里没有拦截关窗的处理（grep `CloseRequested|prevent_close|on_window_event` 无结果），窗口会被销毁；重开走 `lib.rs:345-384` `show_window` 的重建路径，相当于重新挂载。本修复与这个语义对齐。
- **验证方式**：`swift build` 通过，LoginWindowController.swift 没有新增诊断。没有单测（需要真实 NSWindow 和 ServerAuthClient）。GUI 复测未做（登录 → 登出 → 重开应回到邮箱页）。

### BUG-004 纯云端拉取的笔记删除静默失败并在重启后复活（P1）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/NoteStore.swift:185-199`：只改了 `:196` 这一行判定，另外更新了注释。
  - `Sources/ImmersiveTranslator/ReaderViewModel.swift:2690-2707`：`performDeleteNote` 如实处理删除结果。
  - `Tests/ImmersiveTranslatorTests/LearningStoreTests.swift:869-880`：更新 `testNoteStoreCommitsNotesEntityAndListsSyncedNotes` 的尾段。
- **修改内容**
  - NoteStore 判定从 `guard FileManager.default.fileExists(atPath:) else { return false }` 改成 `guard fileExists || readText(path) != nil else { return false }`。存在性因此和 `read` / `list` 用同一套规则（files 表优先、磁盘兜底）；磁盘上有副本的情况仍按原判定照删（只增不减）。
  - 接线后仍然走原来的 `learning.commit(path, nil)`：files 置 NULL、基于拉下来的实体落 notes tombstone（dirty，保留 baseVersion）、删除导出文件（NotFound 豁免，`LearningStore.swift:1094-1098`）。
  - ViewModel 去掉 `_ = try?`：抛错时提示「删除笔记失败：<原因>」，不清当前笔记，不报已删除；返回 true 报「笔记已删除」；返回 false（files 表和磁盘都没有，比如已被同步删除）就刷新列表并提示「这篇笔记已不存在」。对齐 Windows `ReaderApp.tsx:2079-2086`，那边也是 `removed` 为真才报已删除。
- **原因**：同步拉下来的笔记在 hydrate 时只写进 files 表、不落盘（`LearningStore.swift:1260-1279`），列表和读取都能看到它，但旧的删除判定只看磁盘，于是直接返回 false：不 commit、没有 tombstone、不推送，files 表里的内容也还在，重启后笔记「复活」。调用点 `try?` 又把 false 吞掉，照样提示「笔记已删除」。
- **测试调整说明（如实披露）**：原用例最后两行
  `// 磁盘上不存在的（仅 files 表）删除返回 false（note_delete 的 path.exists 口径）` + `XCTAssertFalse(try notes.delete(file: "remote.md"))`
  锁定的正是本 Bug 的错误行为（对齐 Windows `reader_store.rs:2201` 的 `path.exists()`）。修复后不可能继续成立，所以改成断言正确行为，断言反而更多：删除返回 true、tombstone deleted 且 dirty、baseVersion 保持 7、列表剔除、read 返回 nil。原来「不存在 → false」的语义保留在最后一行：删完再删返回 false。其余断言一律没动。
- **验证方式**：`swift build` 通过；定点单测 `ImmersiveTranslatorTests.LearningStoreTests/testNoteStore` 通过（命令见上）。旧实现跑新断言会在 `XCTAssertTrue(try notes.delete(file: "remote.md"))` 处失败——读代码推断，未回滚实测。另外核对过 `LearningSyncEngine.swift:18` 的同步集合包含 "notes"，dirty 的 tombstone 会被推送；实际推送没有在 mock 服务端验证。GUI 复测未做。
- **备注**：Windows `reader_store.rs:2201`（`if !path.exists() { return Ok(false); }`）加上 `learning_store.rs:904-922`（notes hydrate 只写 files 表）看起来有同样的隐患。按规则 6 没有改，建议另开单跟进。

---

## 批次 P01-2（P01 第 2 批 · 第 1 次提交）· 2026-11-10

**现场备份**：`qa-artifacts/fixes-backup-P01.patch` 已存在（466872 字节，2026-11-09 20:57），按规则 1 跳过、未覆盖。未 commit / stash / reset / checkout。

**本批构建与测试（本次会话实际执行）**
- `swift build --package-path immersive-translator-mac` → exit 0，`Build complete!`（三个 bug 全部改完后构建通过）。
- 定点单测（本批新增/受影响的套件，均为实际执行）：
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.OCRLanguagePresetTests'` → 3 用例 0 失败。
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderChatStreamWatchdogTests'` → 3 用例 0 失败。
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderTranslateBackoffTests'` → 既有 14 用例 0 失败。
- 全量单测（额外自查，调度器的统一门禁仍以它自己跑的结果为准）：`swift test --package-path immersive-translator-mac` → exit 0，`Executed 1344 tests, with 0 failures (0 unexpected)`（2026-11-10 08:45，所有源码改动完成之后）。
- GUI 实机复测：**本批全部未做**（未重新打 .app；各 bug 条目下分别注明）。

### BUG-005 默认「混合」OCR 预设（en-US 优先）对中文素材输出乱码或 0 字符（P1）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/Settings.swift:568-574`：`OCRLanguagePreset` 新增 `automaticallyDetectsLanguage`，只有 `.autoMixed` 为 true。
  - `Sources/ImmersiveTranslator/OCRReader.swift:125-127`：`performRecognition` 设置 `request.automaticallyDetectsLanguage = attempt.mode == .accurate && attempt.languagePreset.automaticallyDetectsLanguage`。
  - `Tests/ImmersiveTranslatorTests/OCRLanguagePresetTests.swift`（新增，77 行）：防回归用例。
- **修改内容**：「混合」预设的识别请求开启 Vision 自动语言检测（`VNRecognizeTextRequest.automaticallyDetectsLanguage`，macOS 13+，与 Package.swift 的 `.macOS(.v13)` 一致，不需要 `#available`）。其余部分都没动：语言列表与顺序（`:545` 仍是 en-US 在首位）、`fallbackPresets`、默认预设、设置 UI、快速模式行为（只在准确模式开启；混合预设含 zh-Hans，快速模式本来就会被 `effectiveRecognitionMode` 升到准确模式）。
- **原因**：`:545` 的列表 en-US 在首位，Vision 按列表优先级识别，于是用英文模型把中日韩字形硬解成拉丁乱码或空结果。`fallbackPresets` 为 `[]`，而且 `OCRReader.swift:56` 的兜底只在结果为空时触发，乱码不为空，即使有兜底也接不住。
- **为什么不采用 Bug 单建议的「zh-Hans 前置」**：用复刻 App 识别参数的宿主实验对比过（准确模式、语言纠错、同样的放大与 minimumTextHeight；脚本在 `/tmp/p01b2-ocr-exp/`，不在仓库内）：
  - zh-Hans 前置后，中文正常，但日文假名被丢掉（「今日 良 天気 。」），韩文输出为空。
  - 30 段英文渲染样本的总编辑距离从 154 升到 238，英文置信度也普遍从 1.00 降到 0.50。
  - 开自动检测后，30 段英文与现状**逐段编辑距离完全相同**（总计 154 = 154）；中文、日文、韩文、中英混排全部识别正确。
  - 60 个中日韩英短词样本（亮/暗底 × 1x/2x）中，自动检测没有一例返回空。因此没有给 autoMixed 加兜底预设（兜底只在空结果时触发，加了也拿不到实证收益），保持最小改动。
  - 设置页文案「日文截图建议选“日文”或“混合”」（`Settings.swift:2406`）说明「混合」本来就要覆盖日文，而现状下日文同样输出为空；自动检测与这一既有产品意图一致。
- **验证方式（本次实际执行）**
  - 宿主实验（同参数，只改语言配置），用 QA 实拍图：`/tmp/qa-s3-tools/direct-capture-315-180.png` 现状输出为空，修复后 4 行中文；从 `qa-artifacts/screenshots/s3/M04-01-whitecard-test-232623.png` 裁 8 块（白底中文卡、中文 TextEdit、日文 TextEdit、侧栏中英混排、纯英文路径），现状对中/日块输出「ZX##」「ERAMAR. MERSSNRAEKRN.」或空，修复后全部正确，英文块结果不变。
  - `swift build --package-path immersive-translator-mac` 通过。
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.OCRLanguagePresetTests'` → 3 个用例，0 失败。用例走真实 Vision 和 `OCRReader.recognizeText` 全管线，没有替身。
  - 反证：临时把 `OCRReader.swift:127` 改成 `&& false && …`（等同旧行为）后重跑，`testAutoMixedPresetRecognizesChineseText` 失败，CJK 字符数为 0、输出为空，与 QA 的 0 字符症状一致。随后用备份恢复，`cmp` 确认与修复版逐字节一致。
  - GUI 实机复测（⌃⌥Space 框选中文素材）：**本次未做**。

### BUG-006 正文段翻译请求 hang：无超时、无反馈、无恢复入口（P1）

- **修改文件与行号**
  - `Sources/ReaderCore/ParagraphTranslate.swift:141-147`：新增常量 `translateWatchdogTimeoutSeconds: TimeInterval = 180`（与既有请求级 180s 对齐）。
  - `Sources/ImmersiveTranslator/ReaderChatClient.swift:303-365`：`streamDeltas` 增加 `watchdogTimeout` 参数与活动看门狗（双任务终态竞速 + `WatchdogFeed` 静默计时，`:367-386` 抽出共用的 `pumpSSEBytes`，`:388-417` 看门狗结构）；`:277-282` `completeStreaming` 以 `ReaderCore.translateWatchdogTimeoutSeconds` 接线。
  - `Tests/ImmersiveTranslatorTests/ReaderChatStreamWatchdogTests.swift`（新增，223 行）：本地 BSD socket SSE 服务 + 3 个用例走真实 `URLSession.bytes` 管线。
- **修改内容**：阅读室流式通道（段落翻译 + 复用 `completeStreaming` 的口译/浮窗路径）收流时启动看门狗：每个流增量喂狗，静默满 180s 即抛 `URLError(.timedOut)` 结束本次尝试；流正常结束/出错时取消看门狗。超时无结构化 HTTP 状态码 → 落既有 `translateGroupWithBackoff` 的「兜底桶」（`ErrorMessageFormatter.readerParagraphErrorText(status: nil)`，`ReaderViewModel.swift:1696-1702`）——段落写 failed + zhError、chip 清掉、「重试 N 个失败段」（`retryAllFailed`）/「重试本段」（`retryParagraph`）恢复入口可用；再次失败会重写错误。已有反馈链路（标题失败条、限流 toast）不动。
- **原因**（静态读码 + 本会话复现实验）：请求级 `timeoutInterval = 180`（`ReaderChatClient.swift:207/260`）只覆盖到首字节；收流是裸 `for try await byte in bytes`（`:300/309` 旧代码），网关假死/半开连接「首字节之后、流不结束」时**没有任何系统超时可触发**——我在独立探针里验证过：本地 stall 服务写完响应头和 2 行 SSE 后既不写也不断开，`URLSession.bytes` 收流循环 8 秒后仍挂起、无 EOF 无错误（`/tmp/p01b2-hang/run3.swift`）。此时管线永久停在 `attemptParagraph` 的 await（`ReaderViewModel.swift:1729`）→ chip「翻译中 1/3 段」永不更新，与 QA 的 8 分钟观察、`lsof` 无 TCP 一致（读缓冲挂起时连接可处于无数据在途状态）。切文触发 `invalidateTranslationRun`（`ReaderViewModel.swift:1399`）静默取消，段落永远 pending——QA 观察的「重开无重试按钮」由此而来（pending ≠ failed，`failedParagraphCount` 数不到）。根因未单点证实（QA 也是单次复现），因此按「无整体超时与终态兜底」处理：任何环节挂起（收流、解析、服务端不关流）都能在 180s 静默后拿到终态与恢复入口。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderChatStreamWatchdogTests'` → 3 个用例 0 失败：①stall 流在 1s 静默窗后抛 `URLError(.timedOut)` 且停摆前增量保留；②喂狗流（间隔 150ms < 1s 窗）正常走完不误伤；③`watchdogTimeout: nil` 维持旧行为（1.5s 处不超时）。
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderTranslateBackoffTests'` → 既有 14 个管线级用例 0 失败（429 退避/熔断/限速/切文清 chip/重试入口均未回归）。
  - `swift build --package-path immersive-translator-mac` 通过（改完后统一构建）。
  - 「未配置看门狗时旧行为不变」的接线语义：`streamDeltas` 默认参数 `watchdogTimeout = nil`，只有 `completeStreaming` 传 180s；直接调用 `streamDeltas(request:apiKey:)` 的旧代码路径零变化。
  - GUI 实机复测（复现 hang→等待 180s→见失败标记与重试入口）：**本次未做**（hang 本身无法按需复现，QA 也是单次）。

### BUG-041 正文点词/划选查词/词块卡/点句定位经正文交互不可达（mouseUp 覆写永不被调用）（P1）

- **修改文件与行号**（都在 `Sources/ImmersiveTranslator/ReaderSentenceText.swift`）
  - `ReaderTextView`：`:201-209` 类文档注释改写；`:258-261` 新增 `mouseDown` 覆写；`:263-292` `mouseUp` 改为兜底 + 新增共用的 `handleInteractionEnd(with:)`（原 `mouseUp` 的命中判定逻辑原样搬入，只在选区分支把「先回调再 super」改为「回调后 return」）。
  - `ProseFlowTextView`：`:782-785` 新增 `mouseDown` 覆写；`:787-820` 同样改造。
  - 两处回调接线（`ReaderSentenceText.makeNSView/updateNSView`、`ReaderProseText.wire`）与回调消费方（`ReaderViews.swift:3087-3089`、`:3373-3376` 的 `vm.lookup/openChunkCard/jumpTo`）都没有动。
- **修改内容**：两类 NSTextView 子类各加 `override func mouseDown` —— 先调 `super.mouseDown(with:)`（其内部跟踪循环返回即鼠标已抬起），再用**同一个** `handleInteractionEnd` 做原 `mouseUp` 里的命中判定（划选→`onSelection`、无选区单击→词块卡/点词/点句）。`mouseUp` 覆写保留并同样调 `handleInteractionEnd`：若未来 macOS 修掉吞事件，mouseUp 路径照常工作；当前 macOS 上它本来就不会被调用，不会产生重复回调。原判定逻辑、坐标换算、U+FFFC 剔除、优先级顺序逐行未变。
- **原因**：`super.mouseDown` 进入 AppKit 鼠标跟踪循环，把本进程队列里对应的抬起事件自行消费，`mouseUp(with:)` 覆写一次都不会被调用。QA 进程内探针（`qa-artifacts/tools/s6r_tvprobe.swift`，结果在 `qa-artifacts/results/s6-retest-log.txt`）实测：单击与划选两种序列下 NSTextView 子类 mouseUp 调用次数均为 0（划选 `selectedRange={1,28}` 照常生效，与 M09-06 截图「高亮出现但查词面板无词条」一致），普通 NSView 对照组正常。而生词的全部 GUI 入口（查词条→加入生词本、词块卡→收藏）都挂在这条链上，故查词/生词在 mac 端经正文交互整体不可达。
- **验证方式（本次实际执行）**
  - 修复语义验证：进程内探针（`/tmp/p01b2-ocr-exp/appfix_probe.swift`，复刻 App 配置 isEditable=false/isSelectable=true/TextKit 1 + 修复后的 mouseDown 判定 + 词块/点词回落逻辑）：划选 → `onSelection 'he little prince traveled ac'`；单击单词 → `onWordClick 'little'`；两条路径都经 mouseDown 触发，mouseUp 调用 0 次。基线对照（不覆写 mouseDown，`mdown_probe` 前身）mouseUp 同样为 0，与 QA 探针结论一致。
  - `swift build --package-path immersive-translator-mac` 通过。
  - 单测：NSView 鼠标交互属 AppKit 事件派发，仓库既有测试也无同类先例（`grep mouseDown Tests` 无结果），没有找到能表达「事件派发到子类」的合理单测切面，未加。
  - 真实鼠标复测（真人点按正文单词出词条 / 划选出短语 / 点词块出即时卡 / 段落排版点句定位）：**本次未做**——QA 单也注明「真实鼠标最终确认待一次人工点按」，本环境无真人输入，合成事件探针已覆盖同一派发路径（NSApp.postEvent + NSWindow.sendEvent，AppKit 对硬件点击的同一条处理链）。

---

## 批次 P2-1（P2 第 1 批 · 第 1 次提交）· 2026-11-10

**现场备份**：`qa-artifacts/fixes-backup-P2.patch` 本批开工时新建（493977 字节，`git diff -- immersive-translator-mac`，
9237 行）= 本批修复前的工作区现场。未 commit / stash / reset / checkout。

**本批构建与测试（本次会话实际执行）**
- `swift build --package-path immersive-translator-mac` → exit 0，`Build complete!`（全部修改完成后）。
- `swift build --package-path immersive-translator-mac --build-tests` → exit 0。
- 全量单测（额外自查，调度器的统一门禁仍以它自己跑的结果为准）：`swift test --package-path immersive-translator-mac` → exit 0，`Executed 1351 tests, with 0 failures (0 unexpected)`（2026-11-10 09:39，所有源码改动完成后；较 P01-2 批的 1344 多出的 7 个即本批新增用例）。
- GUI 实机复测：**本批全部未做**（屏幕自 00:45 前后锁屏至今，`tools/s8lock` 实测 `screenIsLocked=1`、HIDIdleTime≈8h，无法做任何 GUI 输入；各 bug 条目下分别注明）。

---

### BUG-008 浮窗「自动隐藏」开启后翻译完成即隐藏（<1s），而非 16 秒（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/TranslationPanel.swift:755-791`：`scheduleAutoHideIfNeeded` 重写倒计时任务；`:755-757` 新增可注入延时 `var autoHideDelayNanoseconds: UInt64 = 16_000_000_000`（生产值不变，单测注入短延时）。
  - `Tests/ImmersiveTranslatorTests/TranslationPanelAutoHideTests.swift`（新增，~140 行）：3 个用例走真实 `TranslationPanelController` + `NSPanel` + 注入 0.3–0.6s 延时。
- **修改内容**：倒计时任务在 `try? await Task.sleep` 之后、隐藏块 guard 里各加一处 `Task.isCancelled` 检查；被取消的任务整段作废（不再 orderOut），新倒计时由 reschedule 创建、从最后一次 show 起算满 16s。其余 guard（autoHideEnabled / !isPinned / !isLoading / canAutoHideTranslation）与朗读停止逻辑逐行未动。
- **原因**：旧任务体 `try? await Task.sleep(16s)` 把取消时抛出的 `CancellationError` 吞掉，执行**落入**下面的隐藏块，而隐藏块从不检查取消态——任何 `autoHideTask?.cancel()`/reschedule 在成功态下都会让旧任务**立即** orderOut。生产路径必然踩中：App.swift 流式回调的终帧（`progress.isFinal`，App.swift:1846-1857，`isLoading:false` 成功态）先 show 一次武装倒计时，随后 `translateWithMetadata` 返回、成功段（App.swift:1915-1927）**再 show 一次** → 第二次 show 的 `scheduleAutoHideIfNeeded` cancel 第一次的任务 → 浮窗在完成后约 0–1s 被隐藏。对照面全部吻合：错误卡 `canAutoHideTranslation=false`（TranslationPanel.swift:2193-2195）→ guard 不过、从不武装也从不误隐（QA 观测 17s 留存）；pinned / 关闭开关同样被 guard 挡住（18s+/20s+ 留存）。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.TranslationPanelAutoHideTests'` → 3 用例 0 失败（连续两次终态 show 后浮窗仍可见、满延时后隐藏；单次 show 满延时隐藏；开关关闭不隐藏）。
  - 反证：把任务体临时改回「无取消检查」的旧实现重跑，`testSecondFinalShowDoesNotHidePanelImmediately` **失败**（0.2s 时浮窗已被隐藏 = QA 的「完成即隐」原样复现），随后恢复修复版并确认无 TEMP 残留。
  - GUI 实机复测（开关开启、划词翻译、逐秒采样 16s+）：**未做**（锁屏）。

### BUG-009 排版「段落⇄对照」切换导致当前阅读位置重置（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/ReaderViews.swift:2063-2070`：新增 `@State lastViewportLayout: SpreadLayout?`（带根因注释）。
  - `:2145-2163`：`readingPane` 的 `onPreferenceChange(RowFramesKey.self)` 分流——排版切换后的第一份新排版帧不回写光标，改为把当前句带回视口 1/3 线；排版一致的帧走原有 `adoptViewportFrames`。
- **修改内容**：只在「帧所属排版 ≠ 上一份帧排版」这一次机会上跳过 `viewportMoved` 回写并 `proxy.scrollTo(scrollAnchor(for: vm.activeSentenceIdx, …), anchor: (0.5, 1/3))`（与 `followActiveSentence` 同锚点同落点）。排版不变的所有帧回报、以及 `adoptViewportFrames` 本身逐行未动。
- **原因**：排版切换走不同视图分支（`ReaderViews.swift:2189-2193` prose↔parallel），Scroll正文整列重建、滚动位置复位到顶；随后的帧回报是「重排」而非用户滚动，旧逻辑一律经 `adoptViewportFrames`（`ReaderViews.swift:2262-2270`）→ `vm.viewportMoved`（`ReaderViewModel.swift:2039-2046`，未播放时直接改 `activeSentenceIdx`）→ 光标被重排帧逐步重置（QA 双会话 74→31→1 / 21→12→1，且与续读胶囊脱节）。Windows 侧不存在此路径：浏览器排版切换保留 scrollTop，`onViewportIdx` 只挂在真实 scroll 事件上（ReadingView.tsx:249-283）。
- **验证方式**
  - `swift build` 通过（本批统一构建）。
  - 机制层证据：`RowFramesKey` 帧取自 `.named("readerScroll")` 视口坐标（`ReaderViews.swift:2384`），滚动复位后 1/3 线拾取必然落到顶部句——静态核对一致。
  - 未加视图级单测：该决策嵌在 SwiftUI body 更新流里，仓库无视图挂载测试先例；按「最小修改」没有为可测性重构视图。排版切换后的 GUI 复测（段落↔对照各切一次、当前句与续读胶囊应一致）：**未做**（锁屏）。
- **备注**：首次帧回报（`lastViewportLayout == nil`）同样走「回到当前句」分支——对开篇即把断点句带回 1/3 线，与 `followActiveSentence` 的既有行为同向；换文章（排版不变）不受影响。

### BUG-010 学词笔记「取消生成」：首字前取消报「接口返回空内容」、流式后取消把截断稿当完整笔记存档（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/ReaderChatClient.swift:286-292`：`completeStreaming` 流循环退出后新增 `guard !Task.isCancelled else { throw CancellationError() }`。
  - `Tests/ImmersiveTranslatorTests/ReaderChatCancellationSemanticsTests.swift`（新增，~200 行）：本地 BSD socket SSE 服务 + 真实 `URLSession.bytes` 管线，2 个用例。
- **修改内容**：流消费循环正常退出后，先判 `Task.isCancelled` 再做 strip/empty 校验：已取消一律抛 `CancellationError`；未取消的既有路径（空串 → `.empty`、非空 → 返回）逐行未动。
- **原因**：消费任务被取消时 `AsyncThrowingStream` 按「流结束」收尾——`for try await` 循环正常退出、不走 throw。于是首字前取消 accumulated 为空 → 落 `ReaderChatError.empty`（「接口返回空内容。」，`ReaderChatClient.swift:31`）被渲染成接口故障；流式后取消非空 → 截断稿被当完整结果 return → `ReaderNoteDialog.swift:334-346` 走完成分支按 `partial: false` 存档，`:347` 的 `catch is CancellationError`（取消态 + `persist(partial: true)`）永不可达——与 QA 证据（M10-05 系列、218B frontmatter `partial:false`、3 词全计已整理）逐项吻合。
- **波及面核对（全部消费方，均为既有取消处理，无回归）**：`ReaderNoteDialog`（本 bug 主场，取消分支接管）；`TranslationPanel.runQuickAction:649-657`（`catch is CancellationError` → 保留已生成片段，本修复让它真正可达）；`SpeakViewController:647`（`catch is CancellationError`）；`attemptParagraph`（ReaderViewModel.swift:1763-1770，取消时 `isCurrentRun=false` → `.stale`，与旧行为同点汇合）；`generateReplay` 走非流式 `complete()`，不受影响。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderChatCancellationSemanticsTests'` → 2 用例 0 失败：①首个增量到达后取消 → 抛 `CancellationError`，截断稿不得作为返回值；②首字前取消（服务器 0 产出）→ 抛 `CancellationError`，不得报 `.empty`。
  - 反证：临时移除该 guard 重跑，两个用例分别失败在「实际返回：部分」（截断稿被当完整结果）与「实际：empty」（首字前取消报接口错误）——与 QA 症状逐字对应；随后恢复修复版、确认无 TEMP 残留。
  - GUI 实机复测（笔记生成中途取消 → 应显示「已取消」并存 partial 稿）：**未做**（锁屏）。

### BUG-011 快速复习评分后阅读室「笔记与复习」不刷新、已评词可被重复复习（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/CollectActions.swift:14-17`：新增 `Notification.Name.readerReviewGraded`（带语义注释）。
  - `Sources/ImmersiveTranslator/QuickReviewWindow.swift:258-263`（学习接线路径）与 `:297-302`（本地 SRS 回退路径）：评分落库成功后各广播一次。
  - `Sources/ImmersiveTranslator/ReaderViewModel.swift:413-418`：订阅 `.readerReviewGraded` → `refreshVocab()`。
  - `Tests/ImmersiveTranslatorTests/ReaderReviewGradedBroadcastTests.swift`（新增，~100 行）：复用 `ReaderViewModel(chat:store:)` + 临时目录 ReaderStore 的既有测试工装。
- **修改内容**：grade() 两条落库路径在 `ReviewTouchpointManager.refreshBadge()` 后各加一条 `NotificationCenter.post(.readerReviewGraded, userInfo: ["wordId": card.word.id])`（首评与改评都发：改评同样改变到期态）；阅读室 VM 在 `.readerVocabAdded` 订阅旁并排加一个订阅，动作同为既有 `refreshVocab()`（词表/到期队列/复习角标一条龙）。评分落库逻辑本身未动。
- **原因**：`QuickReviewWindow.grade` 落库后只刷托盘角标，无任何跨窗信号；阅读室 VM 只订阅 `.readerVocabAdded`（新增/合并语义，CollectActions.swift:8-11 的注释明确范围）与 `.learningSyncComplete`（ReaderViewModel.swift:409-430），评分不属于二者 → 阅读室窗口停留在旧词表，已评词仍显示到期、复习队列照旧出卡（QA：托盘 0 到期 vs 阅读室 2 到期、sqlite 已落库）。Windows 侧 `applyGrade`（QuickReviewApp.tsx:149-170）同样只 `trayRefreshBadge()` 不广播——本修复补上的是 Windows 也缺的跨窗一致性链路，阅读室侧消费动作（refreshVocab）与既有 `.readerVocabAdded` 完全一致，无新行为面。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderReviewGradedBroadcastTests'` → 2 用例 0 失败：①后台改库（dueAt 推到未来）+ 广播 → VM 词表刷新、该词退出 `dueWords`；②对照组：后台改库但**不发**广播 → 词表保持旧状态（锁定广播是唯一触发源，防假绿）。
  - 反证：临时移除 VM 订阅重跑，用例①失败在「等待评分广播后的词表刷新超时」「已评词不得继续显示到期」，与 QA 症状对应；随后恢复。
  - 发帖侧（QuickReviewWindow.grade）走 `ReaderStore.shared` 真实用户库，不适合单测直评；由构建 + 全量套件覆盖，GUI 复测（快速复习评 1 词 → 阅读室到期数即时 -1）：**未做**（锁屏）。

### BUG-007 固定目标语言模式「目标语言」输入不落盘、不生效 —— **skipped（未修复）**

- **结论**：静态排查到行级 + defaults 域取证 + 本会话平台机制实验后，未找到应用侧缺陷；全部观测可由**输入侧（IME 组合串/AX setValue 从未成为「已提交文本」）**解释。按「根因不明不硬凑」原则放入 skipped，未改任何代码。
- **证据链（本次会话实际执行/核对）**
  1. **写入路径逐行核对无缺陷**：`Settings.swift:29-31`（@Published+didSet 直写 UserDefaults）→ `:2372`（`labeledField("目标语言", text: $settingsStore.targetLanguage)`，标准 TextField 绑定）→ 消费侧 `App.swift:2263-2268`（fixedTarget 空值回落「简体中文」）与 Windows 完全同构（`languageDetect.ts:43-49` 同样「fixed+空 → 简体中文」；Windows 用受控 input onChange 实时 update，同设计）。
  2. **绑定路径在本 bug 复现现场内被证明是活的**：`defaults read ImmersiveTranslator targetLanguage` 现值为**空串且键存在**（exit=0，本次实测）——该键只可能由这条 didSet 写出（grep 全仓只有 init 读取、resetToDefaults 写「简体中文」两处，`Settings.swift:178/313`）；QA 自己的环境注释明确「AX setValue 不进 SwiftUI 绑定」（results/s2.json environmentNotes），排除 AX 写入；即复现过程中该 TextField 的绑定**成功提交过一次空串**（清空动作），同一路径写入 "English" 不存在值相关的分叉。
  3. **同 store 同 didSet 的对照键正常持久化**：QA 记录「translationDirection=fixedTarget 本身持久化正常」（results/s2.md:61），本次实测该键=`autoChineseEnglish`（QA 收工还原后仍在）——didSet→defaults 域与落盘机制没问题，域也没读错。
  4. **平台机制实验（本会话，`/tmp/p2b1-tl/markedtext_test.swift`、`markedtext_teardown.swift`，宿主进程真实 NSWindow+SwiftUI TextField）**：字段编辑器 `setMarkedText("English")`（= IME 组合中的标记文本）期间**绑定零提交**（BINDING_COMMIT 从未带着 "English" 触发），AX/编辑器读到的却是 "English"；`unmarkText()`（组合提交）与 `insertText`（已提交输入）绑定立即提交；带标记文本时视图整体重建（模拟 `.id(activeSection)` 切页）则标记文本丢失、绑定保持旧值。→ QA 的三个观测（AX 回读=English、defaults 恒空串、切页清空）逐一对上。
  5. **输入法时序吻合**：s2 会话（2026-11-08）期间系统输入源是简体拼音；「切到 ABC」发生在其后的 s6（results/s6.md:88、:138），s2 环境注释已自认 IME 污染风险。字母键入在拼音 IME 下进组合缓冲，数字键不进——这同时解释了 s5 SecureField 数字逐键「绑定时实更新」（results/s5.md:24）与本字段字母键入不提交的差别。
  6. **无法在本会话做 GUI 反证**：屏幕锁屏中（`tools/s8lock` → `screenIsLocked=1`），无法对运行中的 debug 实例（PID 78659）做真实键入复测；该实验留待解锁后补做（ABC 输入源下键入应立即落盘，可一锤定音）。
- **为何不「修」**：能落笔的只有两类——①把空值回落改掉：那是 Windows 同款产品设计（空 + fixedTarget → 简体中文），不许动；②给 SwiftUI TextField 换 NSViewRepresentable 并在 teardown 时强制 unmark/提交组合串：改动面横跨设置页全部文本框，为弥补平台标准行为（组合中切视图丢弃标记文本）而引入回归风险，违背「最小修改」。若解锁后复测证明 ABC 输入源下也不落盘（即排除输入侧），再按当时的复现开新单修复。

---

## 批次 P2-2（P2 第 2 批 · 第 1 次提交）· 2026-11-10

**现场备份**：`qa-artifacts/fixes-backup-P2.patch` 已经存在（493977 字节，2026-11-10 08:46，是 P2-1 批开工时建的，即 P2 两批修复前的现场）。按规则 1 跳过、没有覆盖；本批收尾时又核对了一次，大小和时间都没变。本批改动叠在 P2-1 之后的工作区上。没有 commit / stash / reset / checkout，只改了 `immersive-translator-mac/`。

**本批构建与测试（本次会话实际执行）**
- `swift build --package-path immersive-translator-mac` → exit 0，`Build complete!`。全部改动完成后先 touch 了 8 个改动过的源文件，强制重新编译。这 8 个文件里只有 LearningStore.swift 有 warning，共 7 条，位置在 :680/:924/:1082/:1363/:1517/:1552/:1590，都是既有代码，不在本批插入的代码块里，不是本批引入的。
- 全量单测（额外自查，调度器的统一门禁仍以它自己的结果为准）：`swift test --package-path immersive-translator-mac` → exit 0，`Executed 1357 tests, with 0 failures (0 unexpected) in 33.371 seconds`（10:58，所有改动完成后）。比 P2-1 的 1351 多出的 6 个就是本批新增的用例。
- 单测没有污染取证日志：用户真实 `diagnostic.log` 里 `reader.tts.cloud-fallback` 的计数（QA 的取证口径）本批前后都是 49，`breaker=` 0 行。本会话测试期间写进去的只有既有套件本来就会写的 4 条 translation.panel.show 和 1 条 auth，与 P2-1 批相同。
- GUI 实机复测：**本批全部未做**。`qa-artifacts/tools/s8lock` 在 11:01:39 实测 `screenIsLocked=1 loginwindowWins=2`。

---

### BUG-012 托盘菜单 OCR 热键镜像不随设置即时刷新（P2）

- **修改文件与行号**：`Sources/ImmersiveTranslator/App.swift:740-772`（`observeSettings`）。三条热键订阅链各加一行 `.receive(on: DispatchQueue.main)`（:748/:757/:766），:741-746 的注释写明根因。
- **修改内容**：`$selectionHotKeyShortcut / $ocrHotKeyShortcut / $readerHotKeyShortcut` 三个 sink 推迟到本次赋值（含 didSet 落盘）完成之后才执行。以下部分都逐行未动：sink 体（registerHotKeys + refreshMenu）、菜单构建（statusMenuEntries / hotKeyEntry）、设置侧 acknowledgeAutoSave → onReregisterHotKeys 链路。
- **原因（根因已精确定位）**
  - `@Published` 是在 **willSet** 里发布的，三个热键属性都是 `@Published` + didSet（`Settings.swift:63-73`）。
  - `observeSettings` 的 sink 不用推送过来的值，而是从 `settingsStore` 现读三个键（`registerHotKeys` App.swift:705-713，`rebuildStatusMenu` :598-607），这一刻读到的还是改动前的值。
  - 之后唯一一次按新值重注册，来自设置侧的 `acknowledgeAutoSave → onReregisterHotKeys`（Settings.swift:2969-2976 → App.swift:340-342），这条链不刷新菜单。所以菜单总是按「上一拍」的值重建。
  - 对照 QA 的操作：先把翻译键改为 ⌃⌥T，sink 读到的翻译键还是旧的 ⌥Space；再把 OCR 键改为 ⌥Space，sink 读到翻译键 = 已落盘的 ⌃⌥T、OCR 键 = 旧的 ⌃⌥Space。结果就是「翻译行已更新、OCR 行仍是旧值」，与 QA 的观测逐项吻合。
  - 只有到期数变化时才会顺带重建菜单（ReviewTouchpointManager.swift:58-82 只在到期数变化时回调），所以「两次重开菜单仍是旧值」。
- **运行时证据（本会话核对用户的 diagnostic.log.1）**：每次改键都会在同一秒出现成对的 `hotkey.register`，前一行是旧值、后一行是新值，例如：
  - `[2026-11-08T03:55:03Z] … selection=Option + Space …` → `[03:55:03Z] … selection=Control + Option + T …`
  - `[03:58:42Z] … ocr=Control + Option + Space …` → `[03:58:42Z] … ocr=Option + Space …`

  前一行就是 willSet 时刻的 sink 写的，菜单正是在那一刻按旧值重建的。
- **验证方式**
  - `swift build` 通过。
  - 机制实验（本会话，在仓库外 `/tmp/p2b2-bug012/willset_probe.swift`）：用同构的 `@Published + didSet` 存储加两条订阅链，复刻 QA「先改翻译 ⌃⌥T、再改 OCR ⌥Space」两步。
    - 旧管线：`menu: sel=⌃⌥T ocr=⌃⌥Space | actual: sel=⌃⌥T ocr=⌥Space | match=false`，原样复现 QA 的症状。
    - `receive(on: main)` 管线：`menu: sel=⌃⌥T ocr=⌥Space | match=true`。
  - 没有加单测：`observeSettings` 是 AppDelegate 的私有方法，依赖整个应用启动；按「最小修改」没有为可测性做重构。
  - GUI 复测（改热键后立即打开托盘菜单核对镜像）：**未做**（锁屏）。
- **附带效果**
  - sink 里的 `registerHotKeys` 以前也会在 willSet 时刻按旧值注册一遍（随后被 acknowledgeAutoSave 纠正，日志里的成对行就是这么来的）；修复后两次注册用的都是新值。
  - `resetToDefaults` 连写三个键时，不会再出现「半新半旧」的瞬时重复组合，也就不会因此误弹「快捷键需要调整」浮窗。

### BUG-040 EPUB 目录勾选页章列表溢出重叠（P2）

- **修改文件与行号**：`Sources/ImmersiveTranslator/ReaderIntakeSheet.swift:773-810`（`chapterList`）。在 `VStack(spacing: 2){…}` 外面包一层 `ScrollView(.vertical)`，`.frame(maxHeight: 220)` 保留、改为作用在 ScrollView 上；:775-778 的注释写明根因和 Windows 对照。每一行的内容（勾选图标、章名、词数、选中底色、点击切换）逐行未动。
- **原因**
  - `frame(maxHeight:)` 只限制布局高度，不裁剪。没有滚动容器时，SwiftUI 会把超高的 VStack 在 220pt 的框里**居中**溢出：上面压住表头的「全选 / 清空」，下面压住「导入所选 N 章」，后段章节既看不到也点不到。
  - Windows 同一处是 `.epub-chapter-list { max-height: 220px; overflow-y: auto; }`（`reader.css:5404-5410`）。Mac 移植保留了高度封顶，漏了滚动。
  - 文件导入和「发现 → 下载」两条路径都走 `runParse → .preview(state) → previewView → chapterList`（`ReaderIntakeSheet.swift:871-887`），所以一处修复覆盖两张证据截图（M08-06 / M08-08b）。
- **验证方式（本会话，仓库外离屏探针，结构复刻自 QA 的 `tools/s6r_tocprobe.swift`）**
  - 布局帧（`/tmp/p2b2-bug040/tocprobe_fixed.swift`）：
    - 旧结构原样复现 QA 的数字：12 章时 row1 y=11…37，比表头 maxY=58 靠上；row12 y=319…345，比按钮行 minY=298 靠下。40 章时 row1 y=-381。
    - 新结构的列表框是 y=68…288（h=220），row1 从 68 开始。内层 NSScrollView 的文档高度是 334（12 章）/ 1118（40 章），都大于可视的 220，可以滚动；滚到底以后末章（row12 / row40）落在 y=262…288，在列表框内，可以点到。
    - 6 章时新旧结构的帧完全一致（h=166）：ScrollView 按内容高度收拢，不会留空白。
  - 渲染级（`/tmp/p2b2-bug040/render_check.swift`，把章行涂成纯红后离屏渲染位图、数红像素）：
    - 旧结构：12 / 40 章时表头区红像素 8937 / 8906，底部行及以下 12413 / 48481。
    - 新结构：两处都是 0，章行被裁剪在 220pt 的框内。
  - 局限：只在本机 macOS 26.5 上验证过。部署目标是 macOS 13，旧系统上「内层 ScrollView 按内容收拢」没有实测。
  - GUI 复测（导入 ≥12 章的 EPUB，滚动列表勾选末章并导入）：**未做**（锁屏）。

### BUG-025 Edge TTS 网络失败无熔断（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/ReaderPlaybackEngine.swift`
    - :91-103 熔断状态：`cloudNetworkBreakerUntil: [CloudEngine: Date]`、`cloudNetworkBreakerTTL = 30`、`breakerClock`（单测注入时钟）、`cloudAudioSource`（云取音缝，生产环境恒为共享引擎）。
    - :168-169 `toggle()` 的开播分支复位熔断。
    - :426-471 `CloudEngine` 由 private 改为 internal；新增 `CloudAudioSource`（fetch = 引擎完整路径，cached = 只查缓存）、`shouldTripCloudNetworkBreaker`、`tripCloudNetworkBreaker`、`isCloudNetworkBreakerOpen`。
    - :473-522 `speakCloud` 的改动：
      - 熔断窗口打开时只查缓存，未命中就直接本地合成；窗口关闭时走原路径。
      - catch 里遇到网络类失败就打开熔断，日志行尾加 ` breaker=30s`。
      - 熔断窗口内不做预取。
    - :524-534 新增 `speakLocally`：把 catch 里原来内联的 4 行本地合成原样抽出来，由 catch 和新路径共用。
  - `Sources/ImmersiveTranslator/EdgeTtsEngine.swift:130-150`、`Sources/ImmersiveTranslator/XfyunTtsEngine.swift:102-122`：各新增一个 `cachedAudioData(for:)`，只查 L1→L2、绝不发网络请求，key 与 `audioData(nativeRate: nil)` 用同一算法。两个引擎原有的 `audioData` / `prefetch` 逐行未动。
  - `Tests/ImmersiveTranslatorTests/ReaderPlaybackCloudBreakerTests.swift`（新增，124 行，4 个用例）。
- **修改内容**
  - 讯飞 / Edge 逐句合成遇到**网络类**失败（`classifyTtsError → .network`：超时、拒连、断开、URLError）后，开一个 30s 窗口。窗口内同一引擎的后续句不再发网络请求：缓存命中照常播云音色；未命中就直接本地合成，且不再重复弹归因 toast（首句失败时已经弹过）。
  - 窗口过期后，下一句重新走网络（半开探测）；再失败就再开窗。
  - 用户按播放键开播时熔断复位，「检查网络后重试」不会被窗口吞掉。
  - 熔断按引擎分开记：Edge 不通不牵连讯飞。凭据、空文本、空音频这类非网络失败不开窗。
  - 以下都没改：网关（cloud 档）路径、配额 30s 回落、回落归因文案、「云失败回落本地」的产品语义。
- **原因**
  - `speakCloud` 每一句都先调 `audioData`（缓存 → 网络），失败了才回落本地（原 ReaderPlaybackEngine.swift:416-455），没有任何网络失败记忆。唯一的记忆是网关 `quota_exceeded` 的 30s 绕过（现 :389）。
  - Edge 单句的整体超时是 20s（`EdgeTts.swift:38`、:364-367）；首次失败后还会做一次时钟校准请求（`synthesizeEdgeTts` :403-406，`calibrateEdgeClockSkew` 的超时同样是 20s）。
  - 所以在挂起型网络（代理黑洞、丢包）下，每一句都要先等满超时才回落。
  - Windows 侧同样只有配额的 30s 记忆（`ReaderApp.tsx:505-572`），没有网络熔断。Mac 的「逐句回落本地」本身就是 Mac 侧的设计，本修复只是在它上面加了一个窗口。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderPlaybackCloudBreakerTests'` → 4 个用例，0 失败：
    1. 开窗后，窗口内两句都只查缓存、网络请求 0 次；越过 30s 后下一句重新走网络。
    2. 讯飞开窗不拦 Edge。
    3. 按播放键开播会复位熔断。
    4. 只有网络类错误（EdgeTtsError.timeout / connectionRejected / partialAudio、URLError）会开窗；emptyAudio、emptyText、讯飞缺凭据都不开窗。
  - 用例设计说明：fetch 替身会一直挂起直到被取消，模拟挂起型网络。用例刻意不走 catch 分支，因为那里会往用户真实的 diagnostic.log 写 `reader.tts.cloud-fallback`（QA 按这一行计数取证）；熔断改由 `tripCloudNetworkBreaker` 预先打开。全量跑完后实测该计数仍是 49。
  - 反证：临时让 `isCloudNetworkBreakerOpen` 恒返回 false 再跑，用例 1 失败于「熔断窗口内不得再发网络请求」：实际的网络调用记录先是 `["One."]`、后是 `["One.","Two."]`，也就是每一句都去等网络。用例 2、3 按设计照常通过（它们防的是过度拦截）。之后已恢复，`grep TEMP-BUG025` 无残留。
  - 未覆盖的部分：
    - catch 分支里「网络类失败 → 开窗」这一行胶水代码，只经过代码核对和纯函数用例 4 覆盖，没有在运行时走过（为了不污染取证日志）。
    - `cachedAudioData` 没有单测，因为两个引擎的 `TtsDiskCache()` 写死了用户真实的缓存目录。
    - 挂起型网络实测（perf.md「发现 2」所述）和 GUI 复测：**未做**（锁屏）。

### BUG-026 PanelTtsSpeaker 云路由 `.local` 腿缺 route 后代数复检（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/PanelTtsSpeaker.swift`
    - :38-39 新增 `routeCloud` 注入点。
    - :47-60 init 加默认参数 `routeCloud`，默认值就是原来的 `CloudTtsRouter.route(xfyunReady: XfyunTtsEngine.shared.isReady)`；唯一调用点 `TranslationPanel.swift:93` 不受影响。
    - :100-111 `speakCloudRouted`：先 `let engine = await self.routeCloud()`，再 `guard gen == self.generation, !Task.isCancelled else { return }`，然后才分发。
  - `Tests/ImmersiveTranslatorTests/PanelTtsSpeakerRouteGenerationTests.swift`（新增，53 行，1 个用例）。
- **修改内容**：路由裁决返回后、进入任何出声腿之前，统一核对一次代数，写法与 `LeadSpeaker.swift:59-64`、`ReaderPlaybackEngine.speakCloudRouted` 相同。四条腿的内部逻辑逐行未动：网关拉取后的二次核验、讯飞缺凭据归因、Edge / 讯飞的 speakCloud、本地的 speakLocal。
- **原因**：路由裁决在首次调用或 TTL 过期时是一次网络探测；unstructured Task 在这个挂起点不会因为 `stop()` 的 cancel 而抛错。旧代码因此有三个问题：
  - `.local` 腿无条件执行 `speakLocal → synth.speak`（原 :164-173，现 :177-186）。stop 或换朗读位之后，旧文本仍会出声（幽灵语音 / 乱序）。
  - 同一条腿还会把 `playingGeneration` 覆盖成旧代数，导致新朗读播完后过不了 `handleLocalPlaybackFinished` 的代数门禁，`speaking` 永远不复位。
  - `.xfyun` / `.edge` 腿会用旧任务覆盖 `cloudTask` 引用，之后 stop 就取消不到新任务了。
- **验证方式（本次实际执行）**
  - `swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.PanelTtsSpeakerRouteGenerationTests'` → 1 个用例，0 失败（1.04s）。
    - 用的是真实的 PanelTtsSpeaker 和真实的 AVSpeechSynthesizer；只把路由换成可控的挂起闸门（不碰网络、不读 Keychain）。
    - 步骤：原文朗读进入裁决 → 换到译文（内部 stop 推进代数）→ 先放行译文的裁决 `.local`，再放行迟到的原文裁决 `.local` → 断言译文播完后 `speaking` 复位为 nil。
  - 反证：临时注释掉新加的 guard 再跑，用例 15s 超时失败（等不到「译文播完后朗读态复位」），说明迟到的裁决进了本地腿、`speaking` 卡死，原样复现缺陷。之后已恢复，`grep TEMP-BUG026` 无残留。
  - GUI 复测（cloud 档下点朗读后立即点停止或换位置）：**未做**（锁屏）。

### BUG-027 ReaderStore 域文件「读-改-写」与同步 hydrate 并发丢更新（P2）

- **修改文件与行号**
  - `Sources/ImmersiveTranslator/LearningStore.swift:403-413`：新增 `withExclusiveAccess(_:)`，在 LearningStore 自己的 `NSRecursiveLock`（:206）内执行调用方的闭包。
  - `Sources/ImmersiveTranslator/ReaderStore.swift:81-92`：新增私有方法 `readModifyWrite(_:)`，即 `queue.sync { learning.withExclusiveAccess(body) }`。未接线（learning=nil，纯文件 IO 的测试）时等同原来的 `queue.sync`。
  - 同一文件里 10 个读-改-写入口由 `queue.sync` 改为 `readModifyWrite`：`saveArticle` :212、`deleteArticle` :230、`saveBook` :280、`saveBookMeta` :306、`deleteBook` :319、`saveVocabWord` :446、`mergeVocabWord` :464、`deleteVocabWord` :485、`recordReview` :497、`recordReading` :517。闭包体逐行未动；只读入口（listArticles / getArticle / listBooks / getVocabFile / readSeconds）不变。
  - `Tests/ImmersiveTranslatorTests/ReaderStoreHydrateRaceTests.swift`（新增，130 行，1 个压测用例）。
- **修改内容**：整段「读 → 改 → 写」都持有 LearningStore 的锁。同步 pull 的 `storePut`（:468 起；事务内 `putTransaction` :486 → `hydrate` :533）用的是同一把锁，只能落在整段之前或之后，插不进读和写之间。不会形成死锁环，理由如下：
  - 加锁顺序恒为 `ReaderStore.queue → learning 锁`，LearningStore 从不回调 ReaderStore。
  - 临界区内唯一会发出的通知是 `.learningExportWarning`，它的观察者用 `.receive(on: DispatchQueue.main)` 异步消费（ReaderViewModel.swift:461-462）。
  - ReaderStore / LearningStore 里没有 SyncEngine 调用，也没有 `main.sync` 或信号量。
  - storePut 的调用方（SyncEngine.swift:304-313、SyncStore.swift:444-517、PracticeRelayView.swift:232）只等这把锁，不会反过来持有 ReaderStore 的队列。
  - 锁是可重入的：闭包内的 readPath / commit / dataDirectory 属于同一线程重入。
- **原因**（M-1 证据链在本会话逐点核对过）
  - `readPath`（:375-396）和 `commitMany`（:1065 起）各自取锁、放锁；`ReaderStore.queue` 只串行化 ReaderStore 自己。读和写之间如果落进一轮 pull，commit 用的就是拉取前的旧稿。
  - `commitMany` 用 `mergeUnknown`（:711 起）合并：新稿里已有的标量保留新稿的值，对象逐层递归，所以 `srs` 内部的标量是旧值胜出。
  - ReaderStore 经 Codable `VocabWord` 编码时没有 `baseline/generation` 这些键，它们由 mergeUnknown 从新行补回来，所以新 baseline 看起来是对的，只有 srs 回退了。
  - derive 再以 `now()` 对全部词调用 `enqueueDB`（:999；内容有变化才入队），结果实体被标成 dirty、推回云端。
- **验证方式（本次实际执行；按 Bug 单的建议，修复前先压测复现）**
  - 压测用例走全真链路：在临时目录里用真实的 LearningStore + SQLite + ReaderStore，不碰用户数据。
    - 线程 A 循环调用 `recordReading`，每轮间隔 1ms。
    - 主线程每次随机等 0–16ms，然后 `storePut("reading-vocab")` 落一次「他端进度」（baseline/srs.reps=i），等 A 再完整跑两轮后，核对实体和域文件。
  - **修复前能复现**：同一套用例配置跑 4 次，全部失败在丢更新断言本身，分别丢了 3/6/9/7 次（每次 150 次 pull）。典型的一条：`第 1 次 pull 后：实体 baseline.reps=1 srs.reps=0 dirty=true，域文件 srs.reps=0`——新 baseline 被补回来了，srs 却回退到旧值，实体还被标成 dirty 等待推送，与 M-1 的描述完全一致。早期探索配置（A 紧循环、没有随机错开）跑 4 次，有 3 次复现：1/120（末值 91≠120）、2/120、2/200、0/200。
  - **修复后**（同一套配置）：`swift test --package-path immersive-translator-mac --filter 'ImmersiveTranslatorTests.ReaderStoreHydrateRaceTests'` 连跑 4 次全部通过，0 丢失，每次约 7.2s。另外紧循环配置跑了 5 次，也全部通过、0 丢失。
  - 测试设计如实披露：最初的版本有三处缺陷，都已修正。
    1. 原来只查 baseline。由于上面说的 Codable 补键现象，这样会漏检；现在同时查实体的 baseline、实体的 srs 和域文件的 srs。
    2. A 原来是紧循环。修复后，它在非公平锁上会饿死 pull 线程，单次耗时 72–120s。生产里 recordReading 约 15s 才调一次，其余写入有 ≥0.7s 的防抖或由用户触发，不存在这种饥饿，所以给 A 加了 1ms 间隙。
    3. 加了 1ms 间隙后，pull 总是落在 A 的空档里，交错被系统性避开了；同时健全性断言写成了 `>`，被「恰好 300 轮」误触发。后来加了随机错开，并把断言改成 `>=`。上面「修复前 4/4 失败」的数据，是这三处都修正之后测得的。
  - 反证代码已恢复，`grep TEMP-BUG027` 无残留。
  - 范围说明：
    - 同一读-改-写模式的文章 / 书索引入口也一并纳入：文章进度、书元信息与 hydrateArticles 之间同样会互相覆盖。
    - `gradeVocabWord/undoReviewWord`（list → commitReview，事件溯源另有归并）不在本单范围内，没有动。
    - Windows `reader_store.rs` 有同构缺陷，按规则 6 没有改。
    - GUI 实测和双设备实测：**未做**。
  - 代价：这个压测单测约 7.2s，约占全量 33s 的 22%。如果需要提速，可以把 iterations 从 150 往下调；修复后照样必过，正确性不受影响，但修复前的复现率会随之下降。

---

## P2-3 批次（2026-11-10）

### BUG-028 ReaderStore.loadJSONFile 对损坏 JSON 静默返回空库
- **修改文件**：`immersive-translator-mac/Sources/ImmersiveTranslator/ReaderStore.swift`（loadJSONFile，现 :252-258；连带 readText 调用点 :150、:382、:255 改 `try`，见 BUG-029）
- **修改内容**：`loadJSONFile` 顶层 JSON 解析失败的分支由 `return empty` 改为 `throw ReaderStoreError.schemaIncompatible("数据损坏：\(file) 不是合法 JSON")`；文件不存在 / 空文件仍返回 empty（新建库语义不变）。
- **原因**：书索引 reader_books.json / 书文件 books/<id>.json 损坏时旧实现静默当空库，下一次 saveBook/saveBookMeta/saveArticleIntoBookFile 用空库整体覆盖——书目录整本丢失、单章重写抹掉整本书其余章节。同文件 loadArticlesFile / loadVocabFile 已是同款报错保护（各自注释自述旧实现清库后果），本处是漏改的最后一处。
- **验证**：`swift build --package-path immersive-translator-mac` Build complete（下同）；抛错经 loadBooksIndexFile/loadBookFile 既有 throws 链路上浮到 UI 命令层，与 loadArticlesFile 同路径。

### BUG-029 LearningStore.readPath 把一切磁盘读错误吞成 NotFound
- **修改文件**：
  - `immersive-translator-mac/Sources/ImmersiveTranslator/LearningStore.swift`（readPath，现 :391-402）
  - 下游消费方同步改为「只豁免 NotFound，其余读错误上抛」：`ReaderStore.swift` readText（现 :62-81，改 `throws -> String?`）、`SpeakStore.swift` readText（现 :64-84，改 `throws`）、`NoteStore.swift` readText（现 :46-65，改 `throws`）及其全部调用点（ReaderStore loadArticlesFile/loadVocabFile/loadJSONFile；SpeakStore.load；NoteStore 的 dedupedFileName（连带 save）、read、writeReplay、delete 传播读错误；list 保持单篇 `try?` 跳过不炸清单）。
- **修改内容**：readPath 磁盘兜底读的 `catch { throw LearningFileNotFoundError() }` catch-all 改为只豁免 `NSCocoaErrorDomain` + `NSFileReadNoSuchFileError`(260)，其余错误（非 UTF-8 code=259、无权限 code=257 等）原样上抛；三处消费方由 `try?` 吞错改为 `catch is LearningFileNotFoundError` → nil（纯文件分支同理只豁免 260）。
- **原因**：任何读错误被吞成 NotFound → 消费方当空库 → 下一次保存整体清库；违背同文件 readFileDB :361-367「只豁免文件不存在；其余读错误必须报出来（防下一次保存整体清库）」的既定策略。只改 readPath 不改消费方的话，`try?` 会把新抛出的真错误继续吞成空库，保护落空，故消费方一并最小修正。
- **验证**：swift build 通过；grep 全仓确认 readPath 消费方仅此三处，均已覆盖；Tests/ 无依赖「读错误吞成 NotFound」的用例（已核对 LearningStoreTests readPath 相关断言）。

### BUG-030 SpeakRecords 同步入队全程不带 expectedNamespace
- **修改文件**：`immersive-translator-mac/Sources/ImmersiveTranslator/SpeakRecords.swift`（SpeakRecordsSyncer init :329-352、enqueueRecord :357-377、tombstoneRecord :438-459、SpeakSyncCenter.configure :556-563）
- **修改内容**：SpeakRecordsSyncer 新增 `currentNamespace: () -> String`（init 可选参数，默认 `{ store.currentNamespace() }`，既有测试三参构造不受影响）；enqueueRecord 与 tombstoneRecord 每次操作前采集一次命名空间，`store.list` / `store.put` 全程携带 `expectedNamespace:`；生产接线（SpeakSyncCenter.configure）注入 `learning.currentNamespace()`。
- **原因**：入队（含 Task.detached 评测写）与 tombstone 的 list→put 之间若发生账号切换（setAccount 与 detached 任务无同步点），实体落错命名空间；登出窗口误写 guest 的行会在下次登录被 adoptGuest 并入错误账号。SyncStore.list/put 与 LearningStore.verifyNamespace 已支持 expectedNamespace（nil 透传放行），ReaderStore.gradeVocabWord / SyncEngine.syncNow 均是「采集一次全程携带」的既定同款，本处补齐漏网之门。切换窗口内写入被 verifyNamespace 取消（记录丢失但不串号），与「宁可不同步也不落错」的既有口径一致。
- **验证**：swift build 通过；SpeakRecordsTests 两处三参构造与 JSON 回退布局（默认命名空间 guest 自洽）不受影响——单测由调度器统一执行，本批未单独跑。

### BUG-031 浮窗翻译请求超时仅 18s
- **修改文件**：`immersive-translator-mac/Sources/ImmersiveTranslator/TranslationClient.swift`（performTranslation 内 request 构造，现 :157-163）
- **修改内容**：`request.timeoutInterval` 由 18 改为 120，附注释说明对齐口径与流式语义。
- **原因**：同一 request 复用于流式与非流式（:188/:200），关流式与验证翻译路径对非流式长文本/慢模型必然 18s 超时；Windows 同接口 translation.rs = 120s、mac 阅读室 ReaderChatClient = 180s。取 120s 与 Windows 同接口对齐。
- **验证**：swift build 通过。流式路径的 timeoutInterval 只约束等待数据间隔，抬高不改变流式行为（无看门狗冲突：面板流式看门狗逻辑独立）。

### BUG-032 流式 SSE 中的 error 帧被吞
- **修改文件**：`immersive-translator-mac/Sources/ImmersiveTranslator/ReaderChatClient.swift`（consumeSSELine :452-470、pumpSSEBytes 两处调用点 :391/:399、parseBufferedResponse :502-533、complete() 调用点 :245）
- **修改内容**：consumeSSELine 改 `throws`——错误帧（经 TranslationResponseErrorParser.message 提取到非空 message）抛 `ReaderChatError.http(status: 200, message:, retryAfterSeconds: nil)`（对齐浮窗 TranslationClient.swift:485-491 对同帧型抛 badResponse(200, message)）；pumpSSEBytes / parseBufferedResponse 随之传播；parseBufferedResponse 顶部补整体错误信封检查（对齐浮窗 performBufferedRequest TranslationClient.swift:351-355 口径）。
- **原因**：旧实现错误帧 `return nil`（注释自认「错误帧不产文本」）——流中已有部分文本时截断稿被当成功结果返回落库；无文本时服务端 message 丢失、只落「接口返回空内容」。抛错后 AsyncThrowingStream 以错误终结，completeStreaming/complete 的消费循环（原 :277-293）整体 throw，段落走既有 failed/重试链路，截断稿不再落库。
- **验证**：swift build 通过；已核对 TranslationResponseErrorParser.looksLikeExplicitFailureEnvelope 不会把正常 choices 响应（object="chat.completion(.chunk)"）误判为错误信封；ReaderChatError.http(200) 不触发 ReaderViewModel.channelHTTPStatus 的 401 特判，走既有失败文案链路。

---

## P2-4 批次（2026-11-10）

> 现场备份：`qa-artifacts/fixes-backup-P2.patch` 已存在（2026-11-10 08:46），按规则 1 跳过、未覆盖。

### BUG-033 讯飞 TTS base64 解码失败静默丢帧，截断 mp3 被写入 L1+L2 双层缓存
- **修改文件**：`immersive-translator-mac/Sources/XfyunCore/XfyunTts.swift`（synthesizeXfyunTts，现 :195-222；原 :195-212）。`XfyunTtsEngine.swift` 未改。
- **修改内容**：
  - 新增局部标记 `var decodeFailed = false`（:199）。onFrame 里 `Data(base64Encoded:)` 失败时置 `decodeFailed = true`（:208），不再静默 `return`。逐帧严格解码不变，没有放宽成 `.ignoreUnknownCharacters`。
  - finish 的空音频守卫由 `total > 0` 改为 `total > 0 || decodeFailed`（:217）。无解码失败的空音频照旧抛 `emptyAudio`；有解码失败时 finish 正常返回。
  - `run` 返回后加一句 `guard !decodeFailed else { throw XfyunTtsError.decodeFailure }`（:220），整段作废。这是声明已久的 `decodeFailure` 第一次真正被抛出。
  - 原本放错位置的注释「每帧独立带 padding 的 base64，逐帧解码」移到 guard 上方。
- **原因**：
  - 旧实现遇到单帧 base64 非法就直接丢弃，只要其余帧非空就返回截断的 mp3。`XfyunTtsEngine.audioData` 成功即执行 `l1.set` + `disk.put`（XfyunTtsEngine.swift:87-89），截断结果被持久化，之后 L1/L2 一直命中、永不自愈，朗读中途戛然而止且没有任何报错。
  - onFrame 签名不可抛错（XfyunAuth.swift:136），只能先记标记。
  - 刻意不在 finish 里抛错：`run` 只在 finish 成功返回后才 `session.close()`（XfyunAuth.swift:159-160），在 finish 里抛会新增一条不关 WebSocket 的错误路径（与审计 F4 同类）。改为 finish 正常返回、会话先关闭，再在 run 之外抛错。
- **行为变化（逐分支核对）**：
  - ① 全帧正常：不变。
  - ② 无解码失败、空音频：仍抛 `emptyAudio`，不变。
  - ③ 部分帧解码失败：由「返回截断 mp3 并写入双层缓存」改为「会话正常关闭 → 抛 decodeFailure → audioData 跳过 l1.set/disk.put → 下次请求重新合成」。这是本次修复。
  - ④ 全帧解码失败：由误报 `emptyAudio` 改为准确的 `decodeFailure`，且会话改为正常关闭。
- **下游影响核对**：
  - `classifyTtsError(decodeFailure)` 的归一文本是「音频分片解码失败（base64 非法） | decodeFailure」，不命中凭据和网络正则（TtsError.swift:61、:72），归为 unknown。因此 `ReaderPlaybackEngine.shouldTripCloudNetworkBreaker`（:455-457）返回 false，不会误开网络熔断。
  - 各调用方原本就处理抛错：ReaderPlaybackEngine 回落本地并提示、LeadSpeaker 静默回落本地、PanelTtsSpeaker 走 failSpeaking、prefetch 用 `try?` 丢弃且不落缓存。
  - 全仓 `synthesizeXfyunTts` 只有 XfyunTtsEngine.swift:87 这一个调用点。
- **验证**：
  - `swift build --package-path immersive-translator-mac`：Build complete，退出码 0，XfyunTts.swift 无新警告。
  - 补充的窄范围检查（不能替代调度器的全量单测）：`swift test --package-path immersive-translator-mac --filter XfyunCoreTests`，52 个用例 0 失败，退出码 0。
  - 端到端实测**未做**：`synthesizeXfyunTts` 写死了 `wss://tts-api.xfyun.cn`，要构造非法 base64 帧只能改产品代码或引入 Mock 会话，按规则不做，也没有新增依赖 Mock 的单测。
- **遗留**：
  - 修复前已写入用户磁盘的截断 mp3（L2 tts-cache）不会被清除：无法可靠地从完整 mp3 中识别截断条目。全量清空会消耗每日 500 次免费额度，属产品决策，本次未做，这些条目只能等 LRU 自然淘汰。
  - 审计 F4（`run` 在业务错误或超时任务被取消时不关 WebSocket）不在本批范围，未改动。
