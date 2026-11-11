# 沉浸口语（macOS）QA 测试计划

- 生成日期：2026-11-08
- 作者：QA 测试计划作者（基于 qa-artifacts 审计产物撰写）
- 测试对象：`immersive-translator-mac/.build/debug/ImmersiveTranslator`（当前工作区构建，QA 主目标）
- 状态口径（全文统一）：**PASS / FAIL / BLOCKED / NOT TESTED**。未经执行的状态一律记 NOT TESTED；因前置条件无法满足未执行的记 BLOCKED（须写明缺失条件）；「预期」栏标注〔记录行为〕的用例按实测结果记录，是否判定为 FAIL 由产品/开发确认后回填（见 §7 待确认清单）。

---

## 0. 构建基线与功能盘点来源

| 项 | 结论 | 来源 |
|---|---|---|
| 构建基线 | **buildOk=true**（构建成功）、**testOk=true**（1337 tests, 0 failures，含 XfyunProbeTests 7 项等全量套件） | 本次 ask 提供的构建基线 JSON（未在本次会话重跑；仅核实产物存在：`ls .build/debug/ImmersiveTranslator` = 56,351,984B，Nov 6 构建） |
| 工作区可编译 | 是 → GUI 测试**无需回退打包版**，直接测当前工作区 debug 构建 | 同上 |
| 功能基线 | 以四份审计报告为准；`immersive-translator-mac/README.md` 严重滞后（只描述「菜单栏翻译工具」，未覆盖阅读室/口语/复习/同步等三大业务面） | qa-artifacts/audit/features.md §0、§16 |
| 探测基线 | 环境、数据目录、权限、GUI 自动化边界以环境探测报告为准 | qa-artifacts/env-report.md |

---

## 1. 技术架构

### 1.1 工程结构

- 纯 SwiftPM 单 package，**零第三方 SwiftPM 依赖**（`Package.swift:5-68`，审计 architecture.md §1）；platforms `.macOS(.v13)`。
- 4 个 target：可执行 `ImmersiveTranslator`（依赖 ProviderCore / ReaderCore / XfyunCore）；ReaderCore 只依赖 Foundation。测试 target 4 个。
- 链接框架：AppKit / Carbon / Security / Vision / SwiftUI / AVFoundation / ApplicationServices。
- 纯 AppKit 无 Dock 图标（`.accessory`，App.swift:27），一切入口在托盘「译」图标 + 三个全局热键 + 阅读室主窗（features.md §0）。
- 主目标体量：`Sources/ImmersiveTranslator` 共 62,632 行；最大文件 ReaderViews.swift 5498 / Settings.swift 5352（architecture.md §1）。

### 1.2 启动流程（architecture.md §2，均已确认）

```
main() → SingleInstanceGuard 创建（先于一切窗口）
       → NSApplication delegate 挂入 → observeActivation（claim 失败即 exit(0)）
       → setActivationPolicy(.accessory) → app.run()
applicationDidFinishLaunching：
  SpeakSyncCenter.configure → serverAuth.bootstrap()（Keychain 预填→广播→后台刷新）
  → 语音网关运行时 → 登录观察者（语音切换/学习接力）→ ScenarioCatalog/Discover 配置
  → configureMenuBar → HotKeyManager 注册 3 热键 → observeSettings
  → showWelcomeIfNeeded（首启弹引导）→ scheduleAutomaticUpdateCheck（8s 首查/24h 节流）
  → startReviewTouchpoints（30s 调度+托盘角标）→ 非首启 → 阅读室 show()
```

审计已确认无竞态的点（测试不必重复攻）：bootstrap 与订阅 dropFirst、引导窗关闭→阅读室链路、翻译/OCR 会话令牌竞态、LeadSpeaker 三腿代数门禁、资源缺失崩溃路径（architecture.md §2.3、§8）。

### 1.3 窗口清单与关闭语义（architecture.md §3）

| 窗口 | 创建点 | 关键属性 / 关闭语义 |
|---|---|---|
| 托盘 NSStatusItem | App.swift:577-593 | 只建一次只重建 NSMenu；角标合成图防冲掉 |
| 翻译浮窗 NSPanel | TranslationPanel.swift:442-468 | .floating、utilityWindow、canJoinAllSpaces；frame 跨启动记忆 |
| 阅读室主窗 | ReaderWindowController.swift:31-52 | 1200×800 / min 960×620；✕/⌘W 先停朗读/收麦/取消评测再隐藏（关窗契约） |
| 快速复习迷你窗 | QuickReviewWindow.swift:31-49 | .floating 440×640；orderOut 收起；键盘监听不拆除（风险 功R6） |
| 录音直译窗 | LiveCaptionWindow.swift:222-236 | .floating 520×680；✕/toggle 仅 orderOut，**无关闭停录音逻辑（架R1，高危）** |
| 截图框选遮罩 | ScreenSelection.swift:309-345 | .screenSaver、每屏一个；完成/取消均释放 |
| 设置窗 | Settings.swift:1175-1196 | 760×708；isReleasedWhenClosed=false |
| 登录窗 | LoginWindowController.swift:86,132 | 自定义 Panel |
| 引导窗 | Onboarding.swift:58-66 | 720×640；✕ 不写完成标记（刻意，下次再弹） |
| 复习提醒卡 | ReviewTouchpointManager.swift:138-157 | .floating 右下角；60s 自动关 |

### 1.4 快捷键体系（architecture.md §4 / features.md §2）

- Carbon 全局热键 3 槽位：翻译选中文本（默认 ⌥Space）/ 截图 OCR（⌃⌥Space）/ 阅读室（⌃⌥R）。热键**不需要**辅助功能权限；划词取词需要（ClipboardReader.swift:25,66）。
- 三键查重在注册前完成：重复组合**整组跳过**并如实提示（settings-ui-2）；注册失败分类提示（被占用/不可用/系统错误）浮窗展示。
- 热键录制期间挂起全部全局热键，结束/取消整组重注册。
- 窗口级键盘：阅读室（Space/K/J/L/H/E/Esc）、快速复习窗（←/→/Space/1-4/Esc）、截图遮罩（Esc/Enter/方向键/R 等）。
- 组合合法性：禁 Esc、要求 cmd/control/option 至少一个；系统保留组合风险分级提示 14 类。

### 1.5 数据架构（data.md §1，已确认）

```
权威层  learning.sqlite3（WAL + synchronous=FULL）
        五表：files（域文件快照）/ entities（同步 outbox）/ cursors（游标）
              audio_clips / audio_chunks（本机录音 PCM，永不进同步载荷）
        命名空间：guest 与 account-<hex(user.id)>；每次操作 verifyNamespace
门面层  ReaderStore / SpeakStore / NoteStore（生产恒接线 LearningStore）
        读 = files 表优先 → 回退磁盘 JSON；写 = commit（快照+outbox 单事务）
        兼容 JSON 导出在事务外，失败只发通知（读路径不受影响）
同步层  SyncStore（门面）→ SyncEngine（全局串行，先拉后推，LWW）
        LearningRelaySync：登录触发的 7 集合静默同步（单飞去重）
        SpeakRecordsSyncer：speak-sessions / speak-assessments（与 relay 共用引擎）
```

- 同步集合：relay 7 集合 = reading-articles / reading-vocab / notes / review-events / speak-scenarios / speak-sessions / speak-assessments；SyncStore 白名单另有 history / glossary / settings 3 个本地集合（差集是否有 Mac 写入方待确认，data.md §5.3）。
- LWW：`updatedAt` 为客户端逻辑时钟、服务端透传——相等或服务端较新时本地未推编辑被**静默覆盖**（数R1，SyncEngine.swift:16,506-514，本次抽查核实）。
- 写入时机：阅读进度 15s 批量、生词评分即时（commitReview 单事务）、口语每轮 persistSession（50 条滚动）、笔记即时。

### 1.6 网络面（network.md §1、§3）

| 通道 | 端点 / 说明 | 超时 | 重试 |
|---|---|---|---|
| 浮窗翻译 | OpenAI 兼容 `/chat/completions`（第三方直连或沉浸云网关） | 18s（buffered 首字节语义） | 平台 401 `token_expired` 单飞换票重放 1 次；其余不重试 |
| 阅读室翻译 | 同上（网关） | 180s | **无平台 401 重放**（网R4）；429 段级退避 Retry-After clamp 5~60s、连续 10 次熔断 |
| 账号/同步 | `/v1/auth/otp/*`、`/v1/auth/login|refresh|logout`、`/v1/me[/config]`、`/v1/sync/{collection}/pull|push`、`/v1/redeem` | 30s/60s | 无自动重试；同步 429 退避 3 次、409 ≤3 轮 |
| Edge TTS | `wss://speech.platform.bing.com/...` | 20s | 失败→时钟校准→偏差变化才重试 1 次 |
| 讯飞 TTS/听写/评测 | `wss://tts-api.xfyun.cn` / `iat-api` / `ise-api`（HMAC 签名） | 20s/30s/45s | 无重试，业务码→友好文案 |
| 发现书库 | `GET /v1/books` + EPUB 下载（匿名可读） | — | — |
| 更新清单 | GitHub Release `update-manifest.json` | — | sha256/size/签名结构校验 |
| RSS 源 | nist.gov / energy.gov / nasa.gov / tools.cdc.gov 等 | — | — |

- 鉴权：全部凭据入 Keychain（service `local.immersive-translator.mvp`）：`apiKey.<providerId>`、`server_auth` 双令牌单槽 JSON、`xfyun.<ise|tts|asr>`。令牌红线（只进 Keychain/刷新单飞/401 分支/惰性刷新/登出语义/命名空间守卫/失效广播）审计逐条确认落地（network.md §2.2）。
- 日志脱敏：`TranslationClient.redactedDiagnosticText`（TranslationClient.swift:705-781）多层脱敏；诊断日志 `diagnostic.log` 0o600、单文件 1MiB 上限+轮转（DiagnosticLogger.swift:10，本次抽查核实）。

---

## 2. 功能模块列表（15 个）与页面关联关系

| # | 模块 | 覆盖功能（来源 features.md 条目号） | 主要页面/窗口 | 入口 |
|---|---|---|---|---|
| M01 | 全局外壳与系统交互 | 托盘菜单 12 项+角标（#1-5）、单实例（#7）、检查权限（#8）、开机自启（#9）、server_endpoint.json 隐性入口（#10） | 托盘、权限浮窗、系统设置 | 状态栏 |
| M02 | 快捷键与键盘体系 | 3 全局热键（#11-13）、查重/失败提示（#14-17）、三个窗口键盘组（#18-20） | 设置·快捷键分区 | 托盘/设置 |
| M03 | 翻译主链路与浮窗 | 取词三级兜底（#21-22）、方向判定（#23）、流式状态机（#24）、取消（#25）、失败分类（#27）、历史落库（#28）、配置预检（#29）、浮窗全部交互（#30-39） | 翻译浮窗 | ⌥Space/托盘 |
| M04 | 截图 OCR | 跨屏框选（#44）、Vision OCR（#45）、段落整理（#46）、权限守卫（#47）、确认模式 11 动作位（#40-43） | 框选遮罩、浮窗 OCR 预览 | ⌃⌥Space |
| M05 | 翻译历史 | 搜索（#48）、批量（#49）、导出 4×4（#51）、右键（#52）、删除/⌘Z（#53）、清空非收藏（#57） | 历史窗口 | 托盘/浮窗 |
| M06 | 设置中心（7 分区） | IA（#58）、模型服务/Provider（#59-63）、翻译/OCR/风格/术语表（#64-67）、快捷键（#68）、语音（#69-71）、账号（#72）、关于（#73-74） | 设置窗 760×708 | 托盘/⌘,/错误浮窗 |
| M07 | 登录与账号 | 验证码/密码登录（#75-76）、静默续登（#78）、登出、兑换码（#125） | 登录窗、设置账号分区 | 托盘「账号登录」 |
| M08 | 阅读室·书架与导入 | 书架（#83）、导入 7 渠道（#94-101） | 阅读室书架、导入弹层 7 tab | 阅读室/浮窗「送入阅读室」 |
| M09 | 阅读室·阅读体验 | 渲染与播放（#84-88）、X-ray/查词（#89-90）、失败处理（#91）、关窗契约（#93）、阅读设置抽屉（#86） | 阅读室阅读页 | 书架打开文章 |
| M10 | 生词本与复习 | 生词本（#102）、复习三模式（#103）、笔记生成（#104）、笔记库（#105）、快速复习窗（#106）、提醒卡（#107-108） | 笔记与复习岛、快速复习窗、提醒卡 | 顶栏三岛/托盘/提醒卡 |
| M11 | 口语 | 场景中心（#109-110）、对话（#111-112）、跟读打分（#113-114）、复盘（#115）、场景编辑器（#116）、练习接力（#117）、云同步（#118） | 口语岛（阅读室内） | 顶栏「口语」 |
| M12 | 录音直译 | 双语字幕流式（#119）、方向锁定（#120）、引擎路由（#121）、导出/清空（#122-123） | 录音直译浮窗 520×680 | 托盘 |
| M13 | 云同步与数据一致性 | 学习接力 7 集合（#124）、命名空间切换、LWW 冲突、迁移/恢复（data.md 全篇） | 无独立页面（跨窗后台） | 登录/登出/口语页 |
| M14 | 引导/更新/诊断 | 首启引导（#128）、应用内更新（#129-131）、埋点（#132）、诊断日志（#133） | 引导窗、更新浮窗/设置更新卡 | 首启/托盘「检查更新」 |
| M15 | UI-UX 与 macOS 专项 | 深浅色、窗口尺寸、多屏、超长/Emoji/特殊字符渲染、快速连点、Esc 语义 | 全部窗口 | — |

### 页面关联关系

```
托盘菜单（常驻）──动作组→ 翻译浮窗 / 截图遮罩→浮窗(OCR预览) / 快速复习窗 / 生词本(复习岛) /
                  录音直译窗 / 阅读室
              ──入口组→ 登录窗 / 历史窗口 / 更新浮窗 / 设置窗 / 引导窗 / 权限浮窗→系统设置
翻译浮窗 ──→ 历史、生词本、送入阅读室、设置（错误动作位「打开设置并自动诊断」）
阅读室 ──顶栏三岛→ 阅读 | 口语 | 笔记与复习（角标=到期数）
      ──左上→ 书架 ←──导入弹层 7 tab（内置文库/EPUB/本地文件/网页/粘贴/发现/订阅）
      ──右上→ 全文检索 / 主题循环 / 阅读设置抽屉（朗读→麦克风→跟读评测）
提醒卡（30s 调度）──→ 快速复习窗 / 阅读室（继续阅读）
登录窗 ──成功→ 设置账号分区；设置账号分区 ──→ 兑换码 / 云端配置重拉 / 口语场景同步
引导窗（仅首启）──关闭→ 阅读室（唯一主工作台，App.swift:528-530）
双开第二实例 ──→ 静默退出 + 前置首实例阅读室（App.swift:831-836）
```

---

## 3. 主要业务流程

1. **划词翻译流**：热键/托盘 → 取词三级兜底（模拟⌘C→AX 直读→手动⌘C 8s 监听）→ 中英方向判定 → 流式翻译（五态文案）→ 浮窗（词典卡/朗读/复制/收藏）→ 分流：历史落库（去重置顶、500 上限）/ 加生词本 / 送入阅读室。
2. **截图 OCR 流**：⌃⌥Space → 屏幕录制权限守卫 → 跨屏框选遮罩（HUD/放大镜/尺寸提示）→ Vision OCR（2 模式×5 语言）→ 预览（段落整理/11 动作位/统计与质量警示）→ 确认翻译 → 浮窗。
3. **阅读学习流**：导入 7 渠道 → 书架续读 → 阅读（段译流式/朗读走带/译文遮罩自测/X-ray 解析/点词查词）→ 加生词本（保留 SRS）→ 复习三模式/学词笔记 → 提醒触点（托盘角标/提醒卡/快速复习窗）。
4. **口语流**：场景中心（聊章节/生词闯关/官方库/我的场景）→ 对话（流式 ASR/目标短语命中/教练 diff/TTS 播报）→ 跟读打分（评测三指标/差词抽屉）→ 口语复盘（弱词入生词本）→ 练习接力（跨设备续练）。
5. **账号同步流**：登录（验证码/密码）→ 命名空间切换（先 setAccount 再广播）→ guest 数据 adoptGuest → 7 集合静默同步（单飞）→ LWW 冲突消解 → learning-sync-complete 广播 → UI 刷新；令牌 401 单飞刷新/失效广播。
6. **更新流**：启动 8s 后首查、24h 跨启动节流、会话 2h 循环 → manifest（sha256/size/签名结构）校验 → 下载校验 → 一次性 install-update.command 替换安装 → 复核自动重开。
7. **录音直译流**：托盘 → 引擎路由（沉浸云/讯飞/off 引导）→ 麦克风 VAD 分句 → 句级 ASR → 句级翻译 → 双语字幕 → 导出 .md/.txt。

---

## 4. 数据存储与外部依赖

### 4.1 本机存储（env-report.md §3，全部实测存在）

| 存储 | 路径 | 说明 |
|---|---|---|
| SQLite 权威库 | `~/Library/Application Support/ImmersiveTranslator/learning.sqlite3`（-wal/-shm） | WAL+FULL；guest 在根、账号在 `learning/account-<hex>/` |
| 兼容 JSON 导出 | 同目录 `reader_articles.json` / `reader_vocab.json` / `reader_speak_sessions.json` / `notes/` 等 | **只是缓存，读以 files 表优先；测试不要拿磁盘 JSON 当断言源**（data.md O2） |
| 翻译历史 | `translation-history.json`（独立 JSON，maxRecords=500，TranslationHistoryStore.swift:109 本次核实） | 去重置顶 |
| 场景缓存 / TTS 缓存 | `official_speak_scenarios.json` / `tts-cache/`（3000 条上限） | |
| 单实例锁 | `single-instance.lock`（flock，随进程释放） | |
| 诊断日志 / 埋点 | `diagnostic.log`（0600，1MiB+轮转）/ `logs/reader-events.jsonl` | 日志脱敏；埋点纯本地 |
| 服务端配置 | `server_config.json`（下发缓存）；`server_endpoint.json`（base 覆盖，隐性联调开关，当前不存在） | |
| UserDefaults 双域 | 打包版 `local.immersive-translator.mvp`；**debug 裸二进制按进程名落 `ImmersiveTranslator` 历史域，两者互不可见**（env-report §3） | debug 形态首次启动全部按默认值 |
| Keychain | service `local.immersive-translator.mvp`：`server_auth`、`apiKey.<providerId>`、`xfyun.*` | 无法文件级备份 |

### 4.2 外部依赖与连通性基线（env-report.md §5，2026-11-08 实测全部可达）

- 翻译 LLM：DeepSeek / Moonshot / 智谱 / 百炼 / xAI / OpenAI / Gemini / Ollama(本地) / 沉浸云网关；当前 defaults `activeProviderID=immersive-cloud`。
- 沉浸云平台：`https://www.prismspace.online`（404 属预期可达）。
- Edge TTS / 讯飞三服务 / GitHub 更新清单：均可达；本机有 clash-verge 代理，行为可能受影响。
- **debug 形态默认联调 base `http://127.0.0.1:8090`——实测无监听**：登录/同步/网关类用例需先启动 `immersive-translator-server`，或写 `server_endpoint.json` 覆盖；否则相关用例 BLOCKED。
- 权限：划词=辅助功能；OCR=屏幕录制；录音=麦克风（Info.plist 已含用途描述）。宿主自动化侧辅助功能/屏幕录制已授权；**应用自身的三项授权状态无法核实**（TCC.db 无权读取），首次触发会弹系统授权。

---

## 5. 潜在风险（汇总自四份审计，编号与审计一致）

| 来源 | # | 级别 | 风险 | 对应用例 |
|---|---|---|---|---|
| 架构 | 架R1 | 高 | 录音直译窗关闭（✕/toggle）后麦克风持续录音、转写/翻译继续耗额度；阅读室同类问题已修，此窗未修 | M12-06 |
| 架构 | 架R4 | 高 | 发版产物 arm64-only 但宣称支持 macOS 13.0+（Intel Mac 装完启动即挂）；构建/发布链无 arch 检查 | 会话外（打包/发版专项），§7 待确认 #10 |
| 架构 | 架R3 | 中 | 单实例防护 fail-open：锁文件打不开即放行双开 → token_reused 强制下线事故可复发；无用户提示 | M01-06 |
| 架构 | 架R2/架R5~R9 | 低 | 快速复习监听常驻；复习触点主线程同步 IO；注释漂移；退出未显式停录音/朗读；版本号兜底硬编码；本地回落选声 zh-TW 可能先中 | 观察项，§7 |
| 功能 | 功R1 | 中 | 录音直译配置快照过期：SettingsStore 只在 init 读一次 UserDefaults，切 provider 后旧实例仍用旧配置 | M12-08 |
| 功能 | 功R2 | 中 | 录音直译 200 段显示上限：导出静默截断、无提示 | M12-05 |
| 功能 | 功R3 | 低 | 历史 500 条上限淘汰最旧不区分收藏，收藏可能被静默淘汰 | M05-07 |
| 功能 | 功R4/R5/R7 | 低 | 热键录制中断恢复依赖回调；剪贴板快照恢复 changeCount+1（第三方剪贴板管理器可见）；托盘菜单重建时机 | M02-10 / M03-19 / M10-11 |
| 数据 | 数R1 | 高 | LWW 依赖客户端时钟：相等或服务端较新 → 本地未推编辑被静默覆盖，无告警 | M13-06 |
| 数据 | 数R2 | 高 | review-events 不可变冲突成「毒丸游标」：游标停在该页，每轮同步同实体失败，无跳过/隔离 | M13-07 |
| 数据 | 数R3 | 高 | 云端拉取笔记删不掉：hydrateNotes 只写库不落磁盘，NoteStore.delete 磁盘存在性检查返回 false（NoteStore.swift:188-195 本次核实）→ 删除静默失败、重启复活 | M13-08 |
| 数据 | 数R4/R5 | 中 | query() 不检查 step 错误返回部分行；SpeakStore 编码失败回退空 Data → 全部会话 tombstone | 故障注入类，§7 待确认 |
| 数据 | 数R6/R7 | 中 | commit 链路无 namespace 二道防线（当前主线程串行事实安全）；大面积 `try?` 吞错无日志（评测记录/删文章/删笔记/进度落盘） | M13-09 / 观察 |
| 数据 | 数R8 | 低 | deviceId() 无锁，首次并发可产生双 device id | 观察 |
| 网络 | 网R1 | 中 | 阅读室流中错误帧被吞 → 误报「接口返回空内容」，服务端错误信息丢失（浮窗同场景抛 badResponse，口径不一致） | M09-13 观察项 |
| 网络 | 网R2/R3 | 中/低中 | withAuth 重放网络错误未包装 AuthError；浮窗 streaming 非 2xx 读 error body 无 do/catch | 观察（错误归因失真类） |
| 网络 | 网R4 | 中 | 阅读室无平台 401 token_expired 重放：取票瞬间旧票过期 → 段落直接失败需手动重试（有意取舍还是遗漏待确认） | M03-10 / M09-13 |
| 网络 | 网R5 | 中 | 浮窗 18s 超时对推理模型偏紧，平台分支不关思考（依赖平台下发模型档位） | M03-06 观察 |
| 网络 | 网R6~R8 | 低 | URL 强解包潜伏崩溃点（当前常量入参）；server_endpoint.json 可重定向账号令牌目标；错误信封 message 透传边界 | §7 待确认 |
| 环境 | — | 高(约束) | dist 与 debug 两形态共用锁文件与数据目录互斥；`.build` 绝不可 clean（资源 bundle 编译期绝对路径回落，clean 后启动即 crash）；QA 中途 dist 可能弹自动更新提示 | 会话全局前置 |

---

## 6. 测试会话划分概览（详见 QA_TEST_CASES.md）

| 会话 | 覆盖模块 | 用例数 | 关键前置 | 执行结果（2026-11-08～11-10 终态） |
|---|---|---|---|---|
| s1 | M01 全局外壳 + M02 快捷键 | 21 | 退出 dist 实例；宿主辅助功能已授权 | 已执行：17 PASS / 1 FAIL / 3 BLOCKED |
| s2 | M03 翻译主链路与浮窗 | 20 | 本地 8090 服务或可用 LLM Key | 已执行：18 PASS / 2 FAIL |
| s3 | M04 截图 OCR + M05 翻译历史 | 17 | 屏幕录制授权；翻译后端可用 | 已执行：7 PASS / 1 FAIL / 8 BLOCKED / 1 NOT TESTED（后段锁屏） |
| s4 | M06 设置中心 | 16 | 本地服务+测试账号；Keychain 可写 | 零执行：16 全 BLOCKED（全程锁屏；另讯飞凭据缺失、恢复默认红线） |
| s5 | M07 登录 + M13 云同步 | 21 | ≥2 测试账号；改系统时间/mock 服务（部分用例） | 已执行：19 PASS / 1 FAIL / 1 BLOCKED |
| s6 | M08 书架导入 + M09 阅读体验(上) | 20 | 翻译后端；Edge TTS 外网；本地素材文件 | 已执行：16 PASS / 4 BLOCKED（两次锁屏；M09-04 于 s7 补测转 PASS） |
| s7 | M09 阅读体验(下) + M10 生词复习 | 21 | 承接 s6 数据；麦克风（跟读，可选） | 已执行：10 PASS / 4 FAIL / 7 BLOCKED（三次锁屏；两次 P0 崩溃阻断） |
| s8 | M11 口语 + M12 录音直译 | 21 | 麦克风授权；语音凭据（缺失则相关用例 BLOCKED） | 零执行：21 全 BLOCKED（全程锁屏；另缺语音凭据/麦克风授权） |
| s9 | M14 引导更新诊断 + M15 UI-UX 专项 | 17 | 外观切换权限；GitHub 可达 | **未执行（NOT TESTED 17 条，未排期）** |

会话级执行注记（2026-11-10 终版）：s1～s8 实际执行并出结论 96 条（87 PASS + 9 FAIL），BLOCKED 60 + NOT TESTED 18；11-09 21:12 起另组织 5 个补测段与 perf 续跑约 10 小时，因屏幕锁定 0 条用例改变状态（详见 QA_TEST_REPORT.md §B/§C 与 `qa-artifacts/results/`）。逐会话明细见本表「执行结果」列与 QA_TEST_CASES.md 各用例状态。

---

## 7. 尚不明确、需人工确认的行为清单

以下行为审计已给出代码路径，但**是否缺陷/是否有意取舍/产品意图不明**——测试一律先按〔记录行为〕口径记录实测结果，不得擅自判定 FAIL：

1. **录音直译关窗后是否停止录音/转写**（架R1，LiveCaptionWindow.swift:215-218 无 willClose 契约）→ M12-06。
2. **录音直译 200 段截断导出**是否有「已截断」提示义务（功R2）→ M12-05。
3. **历史 500 条淘汰是否应保护收藏**（功R3，TranslationHistoryStore.swift:109）→ M05-07。
4. **云端拉取笔记删不掉/复活**（数R3）是否已知设计缺口 → M13-08。
5. **录音直译配置快照过期**（功R1）：切 provider 后旧实例仍按旧配置翻译，是否有意 → M12-08。
6. **单实例 fail-open 无用户可见提示**（架R3）是否可接受 → M01-06。
7. **阅读室无平台 401 重放**（网R4）：有意避免重放风暴还是遗漏 → M03-10/M09-13。
8. **LWW 时钟偏差静默覆盖无告警**（数R1）是否可接受 → M13-06。
9. **毒丸游标（review-events 冲突卡死集合同步）无恢复手段**（数R2）→ M13-07。
10. **arm64-only vs LSMinimumSystemVersion 13.0**（架R4）：官方发行是否刻意仅 Apple Silicon（README 未声明）→ 打包/发版专项，GUI 会话外。
11. **托盘菜单 30s 重建是否会关闭已展开菜单**（功R7，App.swift:596-621）→ M10-11 顺带观察。
12. **LeadSpeaker 本地回落选声**取第一个语言前缀匹配，zh-TW 可能先于 zh-CN（架R9，影响小）→ 观察。
13. **平台下发模型是否为推理型**（浮窗 18s 超时，网R5）→ M03-06 观察。
14. **UpdateChecker 在 debug 裸二进制下的行为**：裸二进制无 Info.plist，`ITUpdateManifestURL` 来源待确认 → M14-03/M14-04 前置确认。
15. **recordAssessmentSilently 失败无用户可见提示**（data.md §4，评测记录无 SpeakStore 兜底）→ 观察。
16. **adoptGuest 失败后无重试无提示**：guest 数据留在本机、账号库显示为空，用户可能误以为丢失（data.md R13）→ M13-02。
17. **讯飞凭据无法通过 UI 清空单字段/整槽**（网R-SEC-2）→ M06-13 观察。
18. **server_endpoint.json 覆盖是否需在隐私政策/用户文档披露**（网R-SEC-1）→ 文档项，非 GUI 用例。
19. **讯飞 IAT/ISE 录音是否强制 15s 上限**（network.md §5.3 待确认）→ M11-04/M12-01 观察。
20. **relay 7 集合之外 history/glossary/settings 三集合在 Mac 是否有写入方**（data.md §5.3）→ M13-01 顺带核对。
21. **「快速复习」菜单项动态文案与提醒卡「今天弹过不再弹」的准确阈值**（features §17）→ M10-08/M10-11 实测记录。

---

## 8. 环境红线与执行注意事项（摘自 env-report.md，违反会导致事故）

1. **两种启动形态互斥**：dist 打包版（当前 PID 12707 在运行）与 debug 裸二进制共用同一 flock + 同一数据目录；切换前先退出另一形态。意外双开时第二实例静默退出并前置首实例阅读室，**不要误判为启动失败**。
2. **永远不要 clean `.build`**：两种形态的资源 bundle 都依赖编译期绝对路径回落，clean 后启动即 `fatalError: could not load resource bundle`。
3. **debug 形态偏好域是 `ImmersiveTranslator`**（进程名派生），与打包版域互不可见；debug 首启=全新配置，不要与打包版行为对比时混淆。
4. **debug 联调需本地 8090 服务**或 `server_endpoint.json` 覆盖，否则登录/同步/网关全挂。
5. **dist/release 会自动查更新**，QA 中途可能弹更新提示——测试时优先用 debug 形态规避。
6. **GUI 自动化边界**：System Events 仅能点击托盘菜单（15 项全部可枚举）与激活进程；窗口/控件 AX 寻址不可用（实测 AXManualAccessibility 也不可设）；窗口内交互需人工执行或键盘事件注入，视觉断言用 `screencapture -x`。统一日志 subsystem `local.immersive-translator.mvp` 可辅助排查。
7. **备份脱敏**：备份 `~/Library/Application Support/ImmersiveTranslator/` + `local.immersive-translator.mvp.plist` 时注意 providers 内含明文 API Key，必须脱敏；Keychain 令牌无法文件备份。
8. 测试结束后若在系统设置授权过应用权限，按需恢复；修改过的 UserDefaults/数据目录用例需自带清理步骤（文档内用例步骤已含）。
