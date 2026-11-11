# QA 最终报告 — 沉浸口语（macOS 桌面版）

- 报告日期：2026-11-10（**终版**。替代 11-09/11-10 的第一轮报告：并入 2026-11-10 全天三条工作线——第一轮执行收尾、修复轮（6 批次 22 条）、回归轮（GUI 回归 8 条）与发布检查结果）
- 轮次构成：
  - **第一轮 GUI 执行**：2026-11-08 08:30 ～ 11-10 07:31（s1～s8 共 8 个会话 + 5 个补测段 + 性能会话两段；11-09 21:30:29 起屏幕长期锁定，各补测段与 perf 续跑在锁屏下零新增执行）
  - **修复轮**：2026-11-10 约 08:00～11:40（含 11-09 20:57 起的 RecallJudge 守卫核对），6 个批次（P01-1 / P01-2 / P2-1 / P2-2 / P2-3 / P2-4），22 条 bug 修复落地 + 1 条 skip（详见 §E，全记录 `QA_FIX_LOG.md`）
  - **回归轮**：2026-11-10 13:06（解锁）～16:58（检测到用户占用后按守则中止），对 22 条已修复 bug 做真实 GUI 回归（全记录 `qa-artifacts/results/regression-2026-11-10.md`）
  - **发布检查**：2026-11-10 11:47～12:07（本地；打包 / 冒烟脚本 / 签名公证配置 / 既有产物保护，全记录 `qa-artifacts/release-check.md`）
- 配套文档：`QA_TEST_PLAN.md`（计划，§6 已补会话执行结果）、`QA_TEST_CASES.md`（174 条用例，状态列已终版回填）、`QA_BUG_LIST.md`（41 条 bug 清单，修复状态已与回归结果对齐）、`QA_FIX_LOG.md`（修复日志）
- 证据根目录：`qa-artifacts/`（results/*.md|json、findings/*.json、screenshots/（含 regression/、release/）、mock/、perf.md、audit/*.md、release-check.md、evidence/、check_results/、dist-check/）

---

## A. 项目测试概况

### A.1 被测对象

| 项 | 内容 |
|---|---|
| 应用 | 沉浸口语 / Immersive Speaking（macOS 桌面版），托盘 accessory 应用，无 Dock 图标 |
| 技术栈 | 纯 SwiftPM 单 package，零第三方 SwiftPM 依赖（Package.swift），platforms macOS 13+；AppKit + SwiftUI + Carbon（全局热键）+ Vision（OCR）+ AVFoundation；4 target（ImmersiveTranslator / ProviderCore / ReaderCore / XfyunCore）+ 4 测试 target；主目标约 62.6k 行 |
| 第一轮被测构建 | `immersive-translator-mac/.build/debug/ImmersiveTranslator`（SPM debug，56,351,984 B，构建于 2026-11-06 00:22，sha256 前 16 位 `09cd61ee848a4ef6`）。第一轮所有 `文件:行` 引用对照该构建对应的工作区源码核实 |
| 修复后被测构建（回归轮用） | 同一二进制重建：mtime 2026-11-10 11:38:13、56,522,448 B、cdhash `58b6057b…`；`find Sources Package.swift -newer` 为空（二进制包含全部 22 条修复，回归轮实测；regression-2026-11-10.md §0） |
| 打包版参照 | `immersive-translator-mac/dist/沉浸口语.app` v0.15.2（bundleId `local.immersive-translator.mvp`，2026-11-06 构建）；发布检查确认整个 QA 期间四组既有产物（dist/.build/release/release 三件套//Applications 版）哈希零改动（release-check.md §4） |
| 构建与测试基线 | 修复期间四次全量 `swift test` 全绿：1338（08:14）→ 1344（08:45）→ 1351（09:39）→ 1357（10:58），0 failures；回归轮 12:16 再跑 1357/0（`qa-artifacts/results/regression-swift-test-1216.log`） |
| 数据面 | learning.sqlite3（WAL+FULL，files/entities/cursors/audio 五表，guest 与 account-<hex> 命名空间）+ 兼容 JSON 导出 + translation-history.json（500 上限）+ Keychain（apiKey.*、server_auth、xfyun.*）+ UserDefaults（debug 域 `ImmersiveTranslator` 与打包域 `local.immersive-translator.mvp` 互不可见；Application Support 数据目录两形态共用） |
| 网络面 | OpenAI 兼容 /chat/completions（第三方直连或沉浸云网关）、自建账号/同步协议（/v1/auth、/v1/sync、/v1/redeem）、Edge TTS wss、讯飞 TTS/ASR/ISE wss、RSS、GitHub 更新清单 |

### A.2 测试环境

- 机器：Mac16,10，Apple M4（10 核），32 GB，macOS 26.5.2 (25F84)，arm64，显示器 2560×1440。
- 工具链：Swift 6.3.3；宿主自动化 = System Events（托盘菜单 AX）+ CGEvent HID 级鼠标键盘注入（`qa-artifacts/tools/itqa`）+ `screencapture` 视觉断言；s6 起以「AX dump 定位 + AXPress + AX set value」为主。
- 翻译/账号后端：本地 mock（`qa-artifacts/mock/server.mjs` → s5 升级版 `s5-server.mjs`，node，127.0.0.1:8090）——OTP 发码校验、账号表、完整 sync v2 协议（pull 分页 / push LWW 409 / immutable_entity / 429 退避 / 413）、redeem 码表、`/v1/qa/*` 测试注入端点、书库两路由。阅读室部分用例走 DeepSeek 直连（s3 两次，真实 Key 费用可忽略；日志脱敏实测 0 命中）。
- 测试账号：全部自建 mock 账号（qa-s2、qa-s5-a/b/pw、回归轮 qa-s5-regr）；用户真实命名空间（account-6538…405）与 Keychain apiKey.* 槽全程只读。回归轮为规避钥匙串 ACL 弹窗，debug 实例以 `XCTestConfigurationFilePath=/dev/null` 启动（KeychainStore.swift:29-31 进程内替身）；依赖真实钥匙串语义的「重启后保持登录」改经 mock OTP 重新登录覆盖。
- 锁屏：2026-11-09 21:30:29 屏保空闲锁屏，13:06:17 解锁；16:58 起机器归返用户。恢复现场时（19:21）屏幕再次处于锁定态（`tools/s8lock`：screenIsLocked=1）。

### A.3 测试范围

- 规划：`QA_TEST_CASES.md` 15 模块 174 条用例，9 个 GUI 会话（s1～s9）。实际执行 s1～s8（M01～M13，157 条出结论或受阻）；**s9 会话（M14×7 + M15×10 = 17 条）未排期执行**。
- 补测：11-09 21:12 起 5 个补测段 + perf 续跑共约 10 小时，因屏幕锁定 **0 条用例改变状态**；仅 s6 补测在锁屏下以只读探针新增 BUG-040/BUG-041 两条。
- 修复与回归：22 条已修复 bug 中 8 条于 11-10 下午做真实 GUI 回归（复现步骤级），其余 14 条仅有代码核对 + 单测证据，状态「已修复待回归」。
- 红线遵守（各会话自述 + 抽查核对）：未修改系统设置、未删除任何用户既有数据、锁屏期间零 GUI 输入（例外如实记录：s3 补测 21:35 锁屏后误发 1 次合成左键落在锁屏上，无键盘输入、未碰密码框）；回归轮 16:58 检测到真人占用后立即中止全部 HID 自动化。真实 LLM Key 仅 s3 两次翻译动用（api.deepseek.com，19+36=55 字符，费用可忽略），其余会话未动用。

---

## B. 功能覆盖率（逐模块 × 用例数 × 状态）

状态口径：PASS / FAIL / BLOCKED / NOT TESTED，取每条用例的**第一轮执行终态**（M09-04 在 s6 记 BLOCKED、s7 补测后终态 PASS，按 PASS 计）。**下表数字已在本会话用 `qa-artifacts/results/s1~s8.json` 的逐用例状态重新聚合核对，与各会话原始记录完全一致**。

| 模块 | 用例数 | PASS | FAIL | BLOCKED | NOT TESTED | 执行会话 | 备注 |
|---|---:|---:|---:|---:|---:|---|---|
| M01 全局外壳与系统交互 | 10 | 8 | 1 | 1 | 0 | s1 | FAIL=M01-10（BUG-012）；M01-09 深色外观需改系统设置（红线） |
| M02 快捷键与键盘体系 | 11 | 9 | 0 | 2 | 0 | s1 | M02-05/07 卡热键录制器不收合成键盘输入（需物理键盘人工复测） |
| M03 翻译主链路与浮窗 | 20 | 18 | 2 | 0 | 0 | s2 | FAIL=M03-03 固定目标子项（BUG-007）、M03-12b 自动隐藏（BUG-008） |
| M04 截图 OCR | 8 | 5 | 1 | 1 | 1 | s3 | FAIL=M04-01（BUG-005）；M04-05 撤销授权属红线；M04-07 用例前提不可达 |
| M05 翻译历史 | 9 | 2 | 0 | 7 | 0 | s3 | 锁屏 BLOCKED×6；M05-07 造 501 条必删用户数据（红线，环境内永久不可测） |
| M06 设置中心 | 16 | 0 | 0 | 16 | 0 | s4 | 会话全程锁屏，零 GUI 执行；含两条源码预研否决项（见 §F.3） |
| M07 登录与账号 | 9 | 8 | 1 | 0 | 0 | s5 | FAIL=M07-09e 429 透传（BUG-013）；登录/登出/续登主链路全过 |
| M08 阅读室·书架与导入 | 12 | 9 | 0 | 3 | 0 | s6 | 7 导入渠道中 6 渠道全通；M08-08 正常分支/M08-11/M08-12 锁屏+红线 |
| M09 阅读室·阅读体验 | 16 | 10 | 2 | 4 | 0 | s6+s7 | FAIL=M09-09（BUG-002）、M09-16（BUG-009）；播放走带/遮罩/进度/关窗契约全过 |
| M10 生词本与复习 | 13 | 7 | 2 | 4 | 0 | s7 | FAIL=M10-05（BUG-010）、M10-06（BUG-015）；M10-02/12 被 P0 崩溃阻断 |
| M11 口语 | 13 | 0 | 0 | 13 | 0 | s8 | 锁屏全程未解锁；即使解锁，10 条仍缺语音凭据+麦克风未授权 |
| M12 录音直译 | 8 | 0 | 0 | 8 | 0 | s8 | 同上；M12-06（录音中关窗停麦，架R1 高危）完全未验证 |
| M13 云同步与数据一致性 | 12 | 11 | 0 | 1 | 0 | s5 | 7 集合同步/adoptGuest/LWW 双向/kill -9/篡改防御全过；M13-10 引擎 skip 无 GUI 路径 |
| M14 引导/更新/诊断 | 7 | 0 | 0 | 0 | 7 | —（s9 未执行） | |
| M15 UI-UX 与 macOS 专项 | 10 | 0 | 0 | 0 | 10 | —（s9 未执行） | |
| **合计** | **174** | **87** | **9** | **60** | **18** | | |

覆盖率说明（如实，不美化）：
- 已执行并出结论 96 条（87 PASS + 9 FAIL），**执行通过率 90.6%**；BLOCKED 60 条 + NOT TESTED 18 条，合计 78 条（**44.8%**）未获得 GUI 结论。
- 高优先级用例共 77 条，其中 **31 条未出结论**（本次回填后从用例文件直接统计）：设置中心 M06×9、口语 M11×6、录音直译 M12×4 三个模块的高优先级用例**全部未执行**；M04×1、M05×2、M08×2、M09×2、M10×1、M14×2、M15×2 受锁屏/红线/未排期影响。
- 性能专项（perf 两段）：6 个必测项 0 个完成 GUI 实测——冷启动/页面切换/高频操作/killall 恢复/网络超时 5 项 BLOCKED（锁屏），内存/CPU 仅获锁屏态只读空闲基线（**锁屏态非解锁桌面基线，仅供参考**；perf.md 已备齐工具与 40 分钟续跑指引）。
- 回归轮结果**不回写用例状态**（回归按 bug 复现步骤执行，未整条重跑用例）；回归涉及条目的结果以括注附于 `QA_TEST_CASES.md` 状态列。

---

## C. 测试结果统计（GUI 与代码/静态分开）

### C.1 GUI 用例实测（第一轮，s1～s8 + 补测 + perf）

| 指标 | 数值 |
|---|---:|
| 总数 | **174** |
| — PASS | **87** |
| — FAIL | **9** |
| — BLOCKED | **60**（按用例最终状态；M09-04 经 s7 补测终态 PASS） |
| — NOT TESTED | **18**（s1～s8 内 1 条：M04-07 用例前提不可达；s9 未执行 17 条） |
| GUI bug 候选（findings/*.json 汇总，去重后） | 26 条成立（P0×1 / P1×6 / P2×7 / P3×12）；另有 4 条会话观察未立 bug（QA_BUG_LIST.md §3） |

### C.2 GUI 回归轮（2026-11-10 修复后构建，针对 22 条已修复 bug）

| 指标 | 数值 |
|---|---:|
| 计划回归 | 22 条（P0×1 / P1×6 / P2×15） |
| 实际执行（复现步骤级 GUI 回归） | **8** |
| — 已回归通过 | **6**（BUG-001 / 002 / 003 / 004 / 011 / 041，证据链见 regression-2026-11-10.md §1） |
| — 未修复（复现） | **1**（BUG-009 排版切换丢位置：83→45→25，regression §2） |
| — 部分通过 | **1**（BUG-010：症状①通过；症状②「流式中取消按 partial 存档」GUI 未命中，regression §3） |
| GUI 回归未完成 | **14**（BUG-005/006/008/012/040/025～033；16:58 起机器被用户占用按守则中止，每条有代码核对 + 相关单测通过证据，regression §4） |

### C.3 代码审查（静态）与门禁

| 指标 | 数值 |
|---|---:|
| 静态审查范围 | `immersive-translator-mac/Sources/`（约 62.6k 行）+ XfyunCore + Windows 参照实现 |
| 静态发现（去重） | 15 条：P2×9、P3×6（QA_BUG_LIST.md BUG-025～039）；2026-11-10 已逐条完成 `文件:行` 源码级复核；并发交错类（BUG-027/030/035）静态复核通过、运行时交错未复现——修复时仅 BUG-027 按建议先做了压测复现（修复前 4/4 复现丢更新，见 §E.3），BUG-030/035 未做运行时复现 |
| 全量单测（修复期间+回归轮，实际执行） | 1357 tests / 0 failures（2026-11-10 12:16，`results/regression-swift-test-1216.log`） |
| check_*.sh 冒烟（16 个全部执行） | 14 PASS / 2 FAIL——2 个 FAIL 经 HEAD 基线对照确认为**既有失败**（检查脚本提取假设过时），非修复引入；发布前应修脚本（release-check.md §2） |
| 打包 | PASS：隔离副本内完整 `package_release.sh` 两次 exit 0（ad-hoc 与 Local Dev 签名），三件套校验通过；原位执行 NOT TESTED（会覆盖既有产物，拒绝执行） |
| QA 包启动出窗口 | **NOT TESTED**：启动被既有 Keychain 条目 ACL 授权弹窗阻塞（需用户密码人工放行；sample 栈证据 evidence/qa_launch_sample_*.txt）；本终端无屏幕录制权限无法截图 |
| 代码签名/公证 | **NOT CONFIGURED**：无 Developer ID 证书、无 notarytool 凭据（预检实测报错）；现网 0.15.2 zip 为 ad-hoc 签名，spctl rejected |
| 既有产物保护 | PASS：前后两次全量 sha256 快照 diff 仅时间戳行不同，四组产物零改动 |

**GUI 与静态严格分开**：静态 15 条不计入任何 GUI 统计；GUI 26 条 bug 的根因引用代码仅为佐证，结论成立依据是 GUI 证据链。

---

## D. Bug 清单摘要

完整清单（每条含复现步骤、预期/实际、证据路径、根因 文件:行、修复状态与回归注记）见 **`QA_BUG_LIST.md`**。

### D.1 按等级分布（41 条）

| 等级 | GUI 实测 | 静态·已复核 | 小计 |
|---|---:|---:|---:|
| P0 致命 | 1 | 0 | **1** |
| P1 严重 | 6 | 0 | **6** |
| P2 一般 | 7 | 9 | **16** |
| P3 建议 | 12 | 6 | **18** |
| 合计 | 26 | 15 | **41** |

### D.2 当前修复状态分布（与 QA_BUG_LIST.md §0 汇总表逐条核对一致）

| 修复状态 | 条数 | 明细 |
|---|---:|---|
| 已修复且回归通过 | **6** | BUG-001（P0）、BUG-002、BUG-003、BUG-004、BUG-041（均 P1）、BUG-011（P2） |
| 已修复，GUI 回归待补 | **15** | GUI：BUG-005、BUG-006、BUG-008、BUG-010（症状①已过/症状②待人工）、BUG-012、BUG-040；静态：BUG-025～033。均有代码核对 + 相关单测通过证据 |
| 未修复（回归复现） | **1** | BUG-009（P2 排版切换丢阅读位置；2026-11-10 回归 83→45→25 复现） |
| 待修复（skip） | **1** | BUG-007（P2 固定目标语言；排查未定位应用侧根因，按「根因不明不硬凑」skip，ABC 输入源复测可一锤定音） |
| 确认不修复（P3 留档） | **18** | BUG-013～024（GUI 12）+ BUG-034～039（静态 6）；其中 BUG-015 低置信待复核、BUG-020 口径待产品确认 |

### D.3 P0/P1 七条现状

| ID | 名称 | 等级 | 现状 |
|---|---|---|---|
| BUG-001 | 专注复习空输入 wordDiff Range 越界全应用闪退（2/2） | P0 | **已修复，2026-11-10 GUI 回归通过**（give-up 空输入判分正常、会话完整收尾、当日 0 崩溃报告） |
| BUG-002 | 禅模式无 GUI 退出入口、持久跨启动 | P1 | **已修复，回归通过**（浮动三键新增「退出禅模式」，defaults 与文章覆盖实测归 false，重启不复发） |
| BUG-003 | 登出后登录窗残留成功态、无法再登录 | P1 | **已修复，回归通过**（关窗重挂载；两次 OTP 登录/登出闭环） |
| BUG-004 | 纯云端拉取笔记删除静默失败并复活 | P1 | **已修复，回归通过**（注入→纯拉取→删除→tombstone 推送→重启不复活全链路） |
| BUG-005 | 默认「混合」OCR 预设对中文输出乱码/0 字符 | P1 | 已修复（Vision 自动语言检测 + 宿主实验反证）；GUI 框选回归待补 |
| BUG-006 | 正文段翻译请求 hang：无超时无反馈无恢复 | P1 | 已修复（180s 收流看门狗 + socket 级单测）；GUI stall 场景回归待补 |
| BUG-041 | 正文点词/划选查词/词块卡不可达（mouseUp 覆写永不被调用） | P1 | **已修复，回归通过**（点词/划选/词块卡/收藏四路径实测；「点句定位」子项未单独复测，真实人手点按收口待做） |

---

## E. 修复记录（引用 `QA_FIX_LOG.md`）

### E.1 批次总览（2026-11-10，全部未 commit，工作树携带；每批以 `qa-artifacts/fixes-backup-P01.patch` / `fixes-backup-P2.patch` 留存修复前现场）

| 批次 | 覆盖 bug | 要点 |
|---|---|---|
| P01-1 | BUG-001/002/003/004 | P0 崩溃守卫（ReaderCoreTests 防回归用例）、禅模式退出按钮、登录窗重挂载、笔记删除存在性含 files 表 |
| P01-2 | BUG-005/006/041 | autoMixed 开 Vision 自动语言检测（宿主实验对比后否决 zh-Hans 前置方案）、180s 收流看门狗（本地 socket SSE 服务单测）、mouseDown 跟踪循环后统一 `handleInteractionEnd` |
| P2-1 | BUG-008/009/010/011 + **BUG-007 skipped** | 自动隐藏取消检查、排版首帧不回写（**回归复现未生效→BUG-009 未修复**）、取消语义（CancellationError 先于 strip/empty）、评分广播 `.readerReviewGraded`；BUG-007 经行级排查+平台机制实验（IME marked-text 零提交）未定位应用侧根因，不改代码 |
| P2-2 | BUG-012/040/025/026/027 | 热键镜像 `.receive(on: main)`（willset 时序根因+运行时证据）、EPUB 章列表 ScrollView（离屏帧+红像素渲染验证）、云 TTS 网络熔断 30s、朗读路由后代数复检、ReaderStore 读-改-写加 LearningStore 锁（**修复前压测 4/4 复现丢更新、修复后 4/4 通过**） |
| P2-3 | BUG-028/029/030/031/032 | 损坏 JSON 改抛错、readPath 只豁免 NotFound 且三消费方连带、SpeakRecords 全程 expectedNamespace、浮窗超时 18s→120s（对齐 Windows）、SSE error 帧改抛错 |
| P2-4 | BUG-033 | 讯飞 TTS base64 解码失败置标记、会话正常关闭后抛 `decodeFailure`、截断音频不再入双层缓存（端到端实测未做：写死真实 wss 端点，按规则不注入 Mock） |

### E.2 修改文件清单（按 QA_FIX_LOG.md 各条「修改文件」汇总；行号为修复后工作区行号，路径相对 `immersive-translator-mac/`）

源码（25 个）：
`Sources/ReaderCore/RecallJudge.swift`（BUG-001；会话开始时工作区已有该守卫，逐行核对后原样保留）、`Sources/ReaderCore/ParagraphTranslate.swift`（BUG-006）、`Sources/ImmersiveTranslator/`：`ReaderViewModel.swift`（002/004/011）、`ReaderViews.swift`（002/009）、`LoginWindowController.swift`（003）、`NoteStore.swift`（004/029）、`Settings.swift`（005）、`OCRReader.swift`（005）、`ReaderChatClient.swift`（006/010/032）、`ReaderSentenceText.swift`（041）、`TranslationPanel.swift`（008；026 的唯一调用点 ：93 未动）、`CollectActions.swift`（011）、`QuickReviewWindow.swift`（011）、`App.swift`（012）、`ReaderIntakeSheet.swift`（040）、`EdgeTtsEngine.swift`（025）、`XfyunTtsEngine.swift`（025；033 明确未改）、`ReaderPlaybackEngine.swift`（025）、`PanelTtsSpeaker.swift`（026）、`LearningStore.swift`（027/029）、`ReaderStore.swift`（027/028/029）、`SpeakStore.swift`（029）、`SpeakRecords.swift`（030）、`TranslationClient.swift`（031）、`Sources/XfyunCore/XfyunTts.swift`（033）。

测试（修复日志载明：修改 2 + 新增 8）：
修改 `Tests/ReaderCoreTests/ReaderCoreTests.swift`（001，新增 `testWordDiffEmptySidesDoNotCrash`）、`Tests/ImmersiveTranslatorTests/LearningStoreTests.swift`（004，如实披露：原断言锁定的正是错误行为，改为断言正确行为）；新增 `OCRLanguagePresetTests`（005）、`ReaderChatStreamWatchdogTests`（006）、`TranslationPanelAutoHideTests`（008）、`ReaderChatCancellationSemanticsTests`（010）、`ReaderReviewGradedBroadcastTests`（011）、`ReaderPlaybackCloudBreakerTests`（025）、`PanelTtsSpeakerRouteGenerationTests`（026）、`ReaderStoreHydrateRaceTests`（027）——均含反证/压测设计，全量 1357 条内通过。

工作树总变更口径（如实区分）：`git status --porcelain`（2026-11-10）mac 侧共 78 项 = 修改 68 + 未跟踪 10。**其中属修复轮的即上表约 25 源码 + 2 既有测试 + 8 新增测试；其余（如 VoiceGateway/*、ErrorMessageFormatter、ServerAuth、HotKeyManager、README、scripts/ 等）是修复轮开始前就存在的未提交开发改动**——`qa-artifacts/fixes-backup-P01.patch`（466,872 B，11-09 20:57）即修复前现场、已含 56 个文件的 diff，可作为分界证据。工作树全部改动均未 commit。

### E.3 修复验证方式（每条详情见 QA_FIX_LOG.md「验证方式」）

- 全部批次 `swift build` 通过；每批全量 `swift test` 0 failures（1338→1344→1351→1357 条，测试数增量=新增防回归用例）。
- 定点单测 + **反证实验**：BUG-005/008/010/011/025/026/027 均临时还原旧实现重跑使新用例失败（症状原样复现）后恢复修复版，`grep TEMP-*` 确认无残留。
- BUG-027 按建议先做最小运行时复现：修复前压测 4/4 复现丢更新（丢 3/6/9/7 次），修复后同配置 4/4 通过、紧循环 5 次通过。
- BUG-012 有用户 diagnostic.log.1 的成对 `hotkey.register`（旧值→新值）运行时证据 + 同构管线实验。
- **GUI 实机复测在修复批次内全部未做**（锁屏），统一移至回归轮——这就是 §C.2「14 条已修复待回归」的来源；「已回归通过」6 条是修复后构建上的真实 GUI 证据。

---

## F. 遗留风险

### F.1 已知未修复缺陷（进下一轮必办）

1. **BUG-009（P2）排版「段落⇄对照」切换丢阅读位置**：修复（首帧不回写+滚回当前句）未生效或被后续帧回报覆盖，回归 83→45→25 复现。建议以断点确认 `RowFramesKey` 各帧回报与 `lastViewportLayout` 分流时序；重点排查 Lazy 布局下 scrollTo 目标行未布局完成时的第二次帧回报。另记录：排版 pill 对合成点击命中不稳定（4 次无效尝试留证），不排除真实鼠标下命中差异。
2. **BUG-007（P2）固定目标语言输入不落盘不生效**：skip。证据链指向输入侧（拼音 IME 组合串未提交 + AX setValue 不进绑定），平台机制实验（marked-text 期间绑定零提交）完全吻合；**ABC 输入源下键入复测可一锤定音**——若仍不落盘再按复现开新单。
3. BUG-010 症状②（流式出字后取消应按 partial=true 存档）：单测通过但 GUI 未命中（mock 流过快），待人工补做。

### F.2 已修复但 GUI 回归未完成（14 条，非 GUI 证据 ≠ 回归通过）

BUG-005/006/008/012/040（GUI 5 条：框选/慢速端点/逐秒采样/托盘菜单/文件选择器均需真实交互）+ BUG-025/026/027/028/029/030/031/032/033（静态 9 条：挂起型网络/听觉判定/并发压测/损坏文件/切号并发/>18s 慢端点/流中 error 帧/非法 base64 帧均需构造性注入）。每条的修复代码已在当前工作区核对存在、相关单测在全量 1357 中通过，但**这只是非 GUI 证据**。另有 BUG-041 的「真实人手一次点按」收口与「点句定位」子项未单独复测。

### F.3 未覆盖域（零结论，下一轮必须补）

1. **口语 M11×13、录音直译 M12×8 全部未执行**（锁屏 + 语音凭据缺失 + 麦克风授权 notDetermined 红线 + M11-10 断网红线）。最高危未验证项：**架R1——录音直译窗关闭后麦克风持续录音、转写/翻译继续耗额度**（审计标高危，LiveCaptionWindow 无关闭停录契约）；以及功R1 配置快照过期、功R2 200 段截断提示、M11-13 未登录引导口径。
2. **设置中心 M06×16 全部未执行**。两条预研否决项：①「恢复默认」首步清空用户 Keychain Key 且 Keychain 无备份——M06-15b 执行部分在本环境**永久不可测**（红线），是否放行需产品决策；②M06-03 必须走自建 provider+mock 路径避免覆盖用户 DeepSeek Key。M06-13c 讯飞凭据缺失为独立硬性 BLOCKED。
3. **翻译历史 M05-03~09（7 条）BLOCKED**；M05-07（500 上限）环境内不可测，建议单测覆盖；功R3（淘汰不保护收藏）未验证。
4. **s9 会话（M14×7 + M15×10 = 17 条）未排期**：首启引导、更新校验链（M14-03/04 需先确认 debug 裸二进制的 manifest 来源）、深浅色/多屏/超长文本/快速连点/Esc 语义全部空缺。
5. **性能 6 必测项 5 BLOCKED**：解锁桌面态的冷启动/内存 CPU/页面切换/高频连点/killall 恢复/网络超时均无数字。
6. 被 BUG-001 阻断的 M10-02（识别卡、听写自动朗读）与 M10-12（只测仍错词入口）：阻断源已回归通过，**用例本身未复测**；M09-06/M08-11 生词子项同理（BUG-041 已修，用例未复测）。

### F.4 数据面与产品风险（已证实行为，待产品决策）

- BUG-011+BUG-001 组合、BUG-011+BUG-041 组合构成的生词-复习闭环阻塞已随三条 bug 修复解除，但**闭环整链（查词→加生词→SRS→复习→跨窗刷新）尚未作为整体跑通一次**。
- 数R1（LWW 静默覆盖无告警）、数R2（毒丸游标永久卡集合同步无恢复入口）：M13-06/07 实证行为与预判一致，是否需产品化改造待确认；测试毒丸 rev-s5-poison-1 仍在 mock B 账号（删除 `qa-artifacts/mock/s5-data/users/qa-s5-qas5bmockloc-001/` 可复位）。
- BUG-033 修复不清理修复前已写入的截断 mp3 缓存（无法可靠识别；全量清空耗每日免费额度，属产品决策，只能等 LRU 淘汰）。
- Windows 侧同构缺陷未改（修复日志按规则仅记录）：BUG-004 对应 `reader_store.rs:2201`、BUG-027 对应 `reader_store.rs` 读-改-写、BUG-002 对应禅模式无退出入口（ReaderApp.tsx:2813）——建议另开单跟进。
- 静态 P3 六条（退出不落盘、deviceId 竞态、tombstone 不覆盖 chunk/progress、讯飞 WebSocket 泄漏、流式 HTTP 错误体、主线程 SSE 解析）留档不修。

### F.5 发布链路风险（qa-artifacts/release-check.md）

1. **无 Developer ID 证书、无 notarytool 凭据**：公证不可执行；现网 0.15.2 zip 为 ad-hoc 签名，Gatekeeper `spctl --assess` rejected。对外分发前需补签+公证，或确认渠道可接受 ad-hoc。
2. **Keychain ACL 弹窗**：登录钥匙串既有条目（svce=local.immersive-translator.mvp）的 ACL 不信任新签名身份，新签名构建首次启动卡死在 `AppDelegate.init → SettingsStore.init → KeychainStore.string → SecItemCopyMatching`（release-check §1.4，SecurityAgent 弹窗实测）。**恢复现场时（19:17）用 `open` 重启 dist 打包版也停在同一调用点等待授权**（sample 证据 `qa-artifacts/evidence/restore-keychain-block-sample-76304.txt`；已实测登录钥匙串为 no-timeout 未锁定，排除锁定因素，判定为 ACL 授权等待）——用户解锁屏幕后会出现「想要使用密钥串」授权框，输入一次密码放行（选「始终允许」可永久）即恢复；QA 不可代做。
3. 两个 check 脚本（check_error_classification.sh、check_provider_presets.sh）提取假设过时，HEAD 上同样失败——冒烟门禁长期飘红会掩盖真问题，发布前应修。
4. arm64-only 与 LSMinimumSystemVersion 13.0 的关系未声明（待确认 #10，打包/发版专项）。
5. 修复未 commit：22 条修复以工作树形式存在（有 P01/P2 双 patch 现场备份），发版前需走正常提交流程。

### F.6 流程与环境遗留

1. **锁屏是本轮最大执行杀手**（60 条用例无结论的主因）：`caffeinate -u -t <N>` 到期无人续期 + 合成输入不重置空闲计时。下一轮必须布防循环 caffeinate + 人工值守解锁。
2. 测试自建数据遗留（均有特征、未动用户真实命名空间）：书架 7 条 QA-S6/QA-S6-EPUB 条目、guest 生词与 review-events、翻译历史 QA 前缀条目（TERMITTER/QA-S3/QA-MOCK）、debug 域 `ocrLanguagePreset=chineseEnglish`、mock qa-s5-* 账号与注入数据。清理属可选动作，不在本次恢复范围（见 §G 后「现场恢复记录」）。
3. **review_reminder.json 口径冲突需人工确认**：旧报告记 QA 改为 minuteOfDay=900/readGoalMin=60，本次恢复时实测文件为 minuteOfDay=1260/readGoalMin=60（mtime 11-09 21:10，早于报告定稿）——与两处记载均不一致，无法确立改前原值，未擅自改回。
4. 自动化能力边界已文档化（热键录制器不收合成键盘、AX set value 需已聚焦、NSOpenPanel XPC 不可达等），复跑前先读各会话「复跑者必读」。
5. `.build` 绝不可 clean（资源 bundle 绝对路径回落，clean 后启动即 crash）；debug 与 dist 两形态共用 flock 与数据目录互斥——恢复现场时已按此顺序操作。

---

## G. 最终发布建议

**结论：存在 P2 未修复项与大面积验证缺口；P0/P1 无已知未修复缺陷。不建议以当前证据直接对外发版；建议先做一轮针对性补测（人工项为主）再发布。**

1. **P0/P1 阻断**：无「确认未修复」的 P0/P1。七条 P0/P1 中 5 条已修复且回归通过（BUG-001/002/003/004/041），BUG-005/006 已修复但 GUI 回归待补——属**条件项**而非未修复缺陷。
2. **P2 未解决**：BUG-009（回归复现）与 BUG-007（skip 待修复）两条 P2 未闭环；BUG-010 症状②待补。均不构成数据损毁级风险，但影响核心体验（阅读位置、固定目标语言、笔记取消语义）。
3. **是否具备发布条件**：**不具备正式发布条件**。理由：①22 条修复仅 6 条完成真实 GUI 回归，14 条只有代码+单测证据；②78 条用例（44.8%）无 GUI 结论，M06/M11/M12 三模块零结论，s9 17 条未执行，性能 5 项无解锁桌面数字；③高危项 架R1（录音直译关窗不停麦）完全未验证；④发布链路签名/公证未配置，2 个冒烟脚本既有飘红。
4. **是否建议下一轮测试**：建议，针对性一轮（预计 1～2 个解锁工作日 + 人工配合项）：
   - 解锁桌面环境重跑：M06×16、M05-03~09、s9（M14/M15）、perf 5 项；
   - 语音凭据 + 麦克风授权后跑 M11/M12（优先验证 架R1）；
   - 14 条「已修复待回归」的 GUI 复归 + BUG-010 症状② + BUG-041 真实鼠标收口 + BUG-009 第二轮修复后的复归 + BUG-007 ABC 输入源判定；
   - M10-02/M10-12/M09-06/M08-11 等被阻断用例在修复后构建上复测；
   - 生词-复习闭环整链跑通一次。
5. **还需人工验证/决策**（汇总，详见上文各节）：
   - 用户密码放行 Keychain 授权（本次重启的 dist 实例正在等待；一次性操作）；
   - BUG-005/006/008/012/040/025~033 的 GUI 回归（14 条）；
   - BUG-010 症状②、BUG-041 真实鼠标、BUG-007 ABC 输入源、BUG-009 复现确认；
   - M06-15b「恢复默认」是否允许在真实环境执行（产品决策）；数R1/R2 是否需产品化改造；BUG-015/BUG-020 复核定级；
   - 语音凭据与麦克风授权（M11/M12 前置）；M02-05/07 物理键盘复测；
   - review_reminder.json 原值确认（minuteOfDay 现值 1260 与两处记载均不一致）；
   - Developer ID 证书 + notarytool 凭据配置与公证；2 个过时 check_*.sh 修复；22 条修复的 commit 与 Windows 侧同构缺陷开单。

### 现场恢复记录（2026-11-10 19:15～19:25，本会话执行）

- 退出测试实例：debug 实例 PID 63723（15:57 启动，持有 single-instance.lock）`kill -TERM` 退出；mock 服务 PID 20110（node s5-server.mjs，端口 8090）退出（8090 已释放）；两个 QA 遗留 `caffeinate -u -t 14400`（PID 63705/73465）退出。实测：`ps -p 63723,20110,63705,73465` 全部消失、锁无持有者、无 ImmersiveTranslator 进程残留。
- 重启原始应用：`open ".../immersive-translator-mac/dist/沉浸口语.app"`（v0.15.2，codesign --verify 通过）→ 新实例 PID 76304（19:17:54，PPID=1，单实例，与原 PID 12707 同形态同路径启动）。**该实例停在启动早期 Keychain 读取等待用户授权**（sample 栈=`KeychainStore.swift:56 → SecItemCopyMatching`，锁文件尚未被 claim，磁盘上残留内容 63723 仅为诊断值、无占位效应）——用户解锁后输入一次密码放行即恢复正常；属 F.5-2 既有环境条件，非 QA 引入（QA 全程未写登录钥匙串，回归轮用进程内替身）。
- 临时文件清理：/tmp 下本轮 mac QA 全部遗留已删除（itqa-*、qa-*、qa-s3-/s4-/s6r、s2-qa-row*、regr-tools、p01b2-*、p2b1-*/p2b2-*、QA 期 sample 两份及本会话 sample 共 55 项，删除前已核对清单）；其中修复日志与 s4.md 引用的实验材料已先固化到 `qa-artifacts/evidence/tmp-experiments/`（2.5 MB，含 BUG-025/027/040 反证日志与探针、direct-capture-315-180.png、glossary 样例等）；本轮恢复新增证据 `qa-artifacts/evidence/restore-keychain-block-sample-76304.txt`。/tmp 中 11-05～11-08 移动端工作流的遗留文件（immersive-apple-*/liquid-*/vault-* 等）不属于本轮，未动。仓库内除 qa-artifacts/ 与 QA_*.md 交付文档外无本轮临时文件；mac 侧工作树变更（68 修改 + 10 未跟踪）含修复本体与更早的未提交开发改动，均保留（见 §E.2 口径）。

---

## 附：产物索引

| 轮次/会话 | 时间 | 范围 | 结果文件 |
|---|---|---|---|
| s1 | 11-08 08:30–13:20 | M01+M02（21 条） | results/s1.md|json、findings/s1.json |
| s2 | 11-08 20:15–23:10 | M03（20 条） | results/s2.md|json、findings/s2.json |
| s3 | 11-08 23:13–11-09 02:08 | M04+M05（17 条，后段锁屏） | results/s3.md|json（§8 记录更正 s3 用真实 Key） |
| s4 | 11-09 02:13–03:16 | M06（16 条，全程锁屏零执行） | results/s4.md|json |
| s5 | 11-08 20:15–11-09 05:20 | M07+M13（21 条） | results/s5.md|json、findings/s5.json |
| s6 | 11-09 05:30–16:37 | M08+M09 上（20 条，两次锁屏） | results/s6.md|json、findings/s6.json |
| s7 | 11-09 09:57–17:46 | M09 下+M10（22 条，三次锁屏、两次 P0 崩溃） | results/s7.md|json、findings/s7.json |
| s8 | 11-09 17:56–19:02 | M11+M12（21 条，全程锁屏零执行） | results/s8.md|json |
| 补测×5 + perf | 11-09 21:12–11-10 07:31 | 补测 0 条改状态；s6 补测新增 BUG-040/041；perf 只读基线 | results/s3/s4/s6/s7/s8 补测节、qa-artifacts/perf.md |
| 静态审查 | 11-08（11-10 复核） | 并发/持久化/网络 + 四份综合审计 | qa-artifacts/audit/*.md |
| 发布检查 | 11-10 11:47–12:07 | 打包/冒烟/签名/产物保护 | qa-artifacts/release-check.md、package_release*.log、check_results/、dist-check/、protected-snapshot-*.txt |
| 修复轮 | 11-10 08:00–11:40 | 22 条修复 + BUG-007 skip | QA_FIX_LOG.md、fixes-backup-P01.patch、fixes-backup-P2.patch |
| 回归轮 | 11-10 13:06–16:58 | 22 条已修复 bug 的 GUI 回归（8 执行/14 未完成） | results/regression-2026-11-10.md、regression-swift-test-1216.log、screenshots/regression/ |
| 现场恢复 | 11-10 19:15–19:25 | 实例/进程/临时文件 | evidence/restore-keychain-block-sample-76304.txt、evidence/tmp-experiments/ |
