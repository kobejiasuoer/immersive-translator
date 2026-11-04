# Mac UI 对齐修复总报告（auth / brand / settings / tray）——2026-11-02 批次

> 收尾文档。汇总四域施工申报与独立复核结果，规格见 `docs/mac-ui-fix-specs-2026-11-02/`（auth.md、brand.md、settings.md、tray.md）。
>
> **证据口径**：文中标注「施工申报」＝该域施工会话自测；「复核亲跑」＝独立复核会话重新执行；「撰写时核验」＝本报告撰写时（2026-11-03）对当前工作区重新核对的行号与文件，行号以当前工作区为准。全量 `swift test` 按任务分工由脚本统一跑，最终回归通过（任务口径）；四域最终状态均为「有遗留」，遗留均为 GUI 人工目验类与申明性事项，详见 §6。

---

## 一、执行摘要

**登录根因一句话**：Mac 登录「网络连接失败」的根因是 `ServerAuthConfiguration.resolveBaseURL` 在无覆盖文件时**恒回退开发缺省 `127.0.0.1:8090`**，缺少 Windows `auth.rs` `resolve_base_url`（auth.rs:220-228）按构建类型分支的等价物——正式包因此去连用户本机不存在的服务，必挂「网络连接失败」。

| 域 | 状态 | 核心成果 | 复核 |
|---|---|---|---|
| **auth 登录与远程服务** | 有遗留（GUI 验收项） | release 缺省 base 直连 `https://www.prismspace.online`，debug 仍连本地联调；覆盖文件优先与容错逻辑零改动；新增 4 条测试锁死分支 | 通过；7/7 生产端点 curl 复核吻合规格 |
| **brand 品牌统一** | 有遗留（人工冒烟项） | B1–B8 全落地：脚本缺省 0.12.1、应用图标复用 Windows、墨绿单一真源 `Brand.swift`、登录窗墨绿、`CFBundleDisplayName=沉浸口语` | 通过；hex/图标 md5/Info.plist/文案逐字亲验 |
| **settings 设置中心对齐** | 有遗留（GUI 目测项） | 15 条验收 14 条达成；双栏模型服务页、沉浸云「登录即用」链路补全（基址/令牌/空模型三件）；24 处散点色改 `Brand.accent` | 通过；复核提出的 5 条差距施工侧已全部修正，「无未解决项」 |
| **tray 托盘与菜单栏** | 有遗留（GUI 目检项） | 菜单结构逐字对齐 Windows §8.1、快捷键提示原生化（keyEquivalent）、红胶囊角标合成图；13 例新测试全绿并抓出 F10–F12 映射 bug | 通过；菜单结构/色值/几何/selector 逐条实读亲验 |

**跨域联动**：settings 域验收 15（登录窗暖橙零回归）的前提被同批 brand.md §B5 取代——登录窗按规格从暖橙迁移到墨绿（亮 `#1F6B57` / 暗 `#73C6AA`，新增 `accentForeground`），复核确认恢复暖橙反而违反品牌域规格，按「前提已变」如实记录而非回归。

**撰写时点核验**（本报告作者亲跑）：`curl GET https://www.prismspace.online/v1/me` → HTTP 401（3.3s）；`GET /` → HTTP 404——生产端点在报告撰写时仍可达，与四域施工/复核实测一致。

---

## 二、登录与远程服务（auth）

### 2.1 根因

Windows 端 `resolve_base_url`（`immersive-translator-windows/src-tauri/src/auth.rs:220-228`）按构建类型分支：公开正式版（`platform_public=true`）回生产域名，开发构建回本地。Mac 端 `ServerAuthConfiguration.resolveBaseURL` 没有这个分支，无覆盖文件时一律回 `127.0.0.1:8090`，所以用户手里**没有本地服务的正式包**点「获取验证码」必然报「网络连接失败」。

### 2.2 修复明细（共 2 个文件，均在 `immersive-translator-mac/` 下）

**`Sources/ImmersiveTranslator/ServerAuth.swift`**（行号为撰写时核验值）：

| 新增项 | 行号 | 对齐 Windows |
|---|---|---|
| `prodBaseURL = "https://www.prismspace.online"` | `ServerAuth.swift:114` | 镜像 auth.rs:153 |
| `platformPublic = true` | `ServerAuth.swift:119` | 镜像 auth.rs:159 |
| `isDebugBuild` 编译期常量（`#if DEBUG`，等价 `cfg!(debug_assertions)`） | `ServerAuth.swift:126` | 等价 |
| `defaultBaseURL(isDebugBuild:)` 纯函数：`(platformPublic && !isDebugBuild) ? prod : dev` | `ServerAuth.swift:135-136` | 与 auth.rs:221-227 表达式同构 |
| `resolveBaseURL` 末行兜底 `devBaseURL` → `defaultBaseURL(isDebugBuild:)` | `ServerAuth.swift:161` | — |

**一行未动的「不动清单」**：覆盖文件优先逻辑、trim/空串/坏 JSON 容错（`ServerAuth.swift:154-160` 一带）、错误表与 `authErrorText` 归一化、OTP 冷却、单飞刷新 401 红线、`LoginWindowController.swift` 全部文案（复核亲验 diff 无本域改动；文案与 Windows `LoginView.tsx`、`authErrorText.ts` 逐字核过）。

**测试 `Tests/ImmersiveTranslatorTests/ServerAuthTests.swift`**（`ServerAuthConfigurationTests` 类内新增 4 条，按 auth.md §2.2）：

- `testDefaultBaseURLFollowsBuildKind`——debug→dev、release→生产值锁死；
- `testPlatformPublicMatchesWindows`；
- `testResolveBaseURLFallsBackToBuildDefault`——空目录一致性断言；
- `testProdBaseURLShape`——https 前缀 + 不以 `/` 结尾。

自检结果（施工申报 + 复核亲跑）：`swift test --filter ServerAuthConfigurationTests`（debug）5/5 过（既有 `testEndpointOverrideWins` 4 条断言不改仍过）；`swift test -c release --filter` 四条新测试全绿——**release 编译产物运行时实测走生产分支**，即无覆盖文件时 `resolveBaseURL` 等于 `https://www.prismspace.online`，无覆盖文件即可登录。`swift build`（debug）与 `swift build -c release` 均 Build complete，`ServerAuth.swift` 零新增警告。

### 2.3 连通实测证据表（规格 auth.md §三.1 全部 7 条）

对 `https://www.prismspace.online` 实测（2026-11-03，仅用 `not-an-email` 假地址，**未发送 OTP 邮件、未创建账号**）。施工申报与复核员各自亲跑，结果逐项吻合：

| # | 请求 | 期待 | 实测 | 判读 |
|---|---|---|---|---|
| 1 | `GET /` | 域名可达 | HTTP 404 `{"error":{"code":"not_found","message":"Cannot GET /"}}`（1.39s） | 根路径无页面属预期，错误信封形状正确 |
| 2 | `GET /v1/me`（无令牌） | 401 | HTTP 401 `unauthorized / 缺少访问令牌` | 路由存在、鉴权按契约 |
| 3 | `POST /v1/auth/otp/request`，body `{"email":"not-an-email"}` | 400/422 | HTTP 400 `validation_error`，details 仅 email 一条（Invalid email） | 校验层拒绝，未发任何邮件 |
| 4 | `POST /v1/auth/login`，body `{"email":"not-an-email","password":""}` | 400 | HTTP 400 `validation_error`，details 含 email/password/device 三条 | zod 校验齐全 |
| 5 | `GET /v1/auth/otp/request`（错误方法） | 404/405 | HTTP 404 `Cannot GET /v1/auth/otp/request` | Express 式按方法注册路由，404 非 405，与规格实测一致，如实记录 |
| 6 | `POST /v1/auth/__nope__` | 404 | HTTP 404 `Cannot POST /v1/auth/__nope__` | 未知路径正确 |
| 7 | `POST /v1/chat/completions`（无令牌） | 401 | HTTP 401 `unauthorized / 缺少访问令牌` | gateway 别名路由存在且要求鉴权（与 auth.rs:894 派生式吻合） |

### 2.4 验收映射

- **验收 6/8（覆盖文件优先、swift run 联调直连本地）**：由既有 `testEndpointOverrideWins` 与新增 `testDefaultBaseURLFollowsBuildKind` 双向覆盖，均通过。
- **验收 5（release 包真机 GUI 登录）**：**未执行**——需人工在登录窗输入邮箱点「获取验证码」观察红条，本环境无 macOS GUI 交互通道。替代证据：release 配置下 `testResolveBaseURLFallsBackToBuildDefault` 通过即运行时证明解析到生产 URL，叠加 §2.3 的 7 条端点实测证明该路径可行。该项转入 §7 用户目验清单。

---

## 三、品牌统一明细（brand）

B1–B8 全落地（Mac 对齐 Windows v0.12.1 基线）：

| 项 | 内容 | 落点（撰写时核验） | 自检证据 |
|---|---|---|---|
| B1 | 两脚本缺省版本 0.11.1→0.12.1 | `scripts/build_app.sh:6`、`scripts/package_release.sh:6`（均亲验为 `0.12.1`） | 施工申报 |
| B2 | 应用图标复用 Windows `icon.icns` | `Resources/AppIcon.icns` md5=`38debaee0f0174e4e66ef2e1b282d029` 与 Windows 一致 | dist 内同 md5（施工申报）；tray-icon 32×32 未误用作 AppIcon（复核亲验） |
| B3 | `tray-icon.png` 入 SPM 资源 | `Sources/ImmersiveTranslator/Resources/tray-icon.png`，构建后打进 dist 的 `ImmersiveTranslator_ImmersiveTranslator.bundle` | 资产真实存在（复核亲验） |
| B4 | 菜单栏 status item 由「译」文字改 18pt 彩色「书页对话」实物（`isTemplate=false`，tooltip「沉浸口语」保留） | `App.swift` `configureMenuBar`（当前 :544-563） | NSStatusItem 仅创建一次、原地复用约束未破坏（复核亲验） |
| B5 | 登录窗 `LoginTheme` accent 三元组换墨绿并引用 Brand 常量；新增 `accentForeground`（浅=`.white`/深=`#112A20`）；「译」徽标字色改 `theme.accentForeground` | `LoginWindowController.swift:42/60/76`（accentForeground）、`:282`（徽标字色）——均为撰写时核验 | 品牌带文案「沉浸翻译 / 登录后同步生词本、阅读进度与偏好设置 / 文A」逐字未动（复核亲验） |
| B6 | 新建 `Sources/ImmersiveTranslator/Brand.swift` 单一真源：hex 5 常量 + 动态 accent + `accentHex(for:)` + trayIconImage + statusBadgeText；设置窗根视图 `.tint(Brand.accent)` | `Brand.swift:18`（`#1F6B57`）/`:20`（`#73C6AA`）/`:46-49`；`Settings.swift:1166`（`.tint`，撰写时核验） | 设置窗全文件 `accentColor` 零残留（grep 空，复核亲验） |
| B7 | `Info.plist` 新增 `CFBundleDisplayName=沉浸口语`；`CFBundleName`/Executable 保持 `ImmersiveTranslator` | `scripts/build_app.sh:148`（撰写时核验） | dist Info.plist 实测三值正确（施工申报，`plutil -p`） |
| B8 | 新建 `Tests/ImmersiveTranslatorTests/BrandTokenTests.swift` | 3 个测试 | `swift test --filter BrandTokenTests` → 3/3 绿（复核亲跑），含深色端到端解析 115,198,170 |

**B4 角标的跨域演进（如实记录）**：品牌轮申报时角标为「图标保留 + 红数字 attributedTitle」（App.swift:503-515）；其后 tray 施工轮在同一工作区叠加，改为 **`StatusBarBadge` 红胶囊白字合成图**（当前 `App.swift:507-531`，注释自证品牌轮在先、托盘轮改合成）。`Brand.statusBadgeText` 在生产代码已无调用方（仅 BrandTokenTests 契约引用）。brand.md 验收 #4 的行为意图（图标保留+红色数字、归零恢复纯图标、资源缺失退回「译」）经核仍全部满足，属并行施工导致的陈旧申报，非功能回归。

**全量构建**：`./scripts/build_app.sh` 全量构建+签名通过，dist 实测 `CFBundleShortVersionString=0.12.1`、`CFBundleDisplayName=沉浸口语`、AppIcon md5 同 Windows（施工申报）。

**范围外偏差（均已在施工申报披露、复核认可）**：登录主按钮文字与 busy 转圈从硬编码 `.white` 改 `theme.accentForeground`（`LoginWindowController.swift:815/:823`，撰写时核验）——与 Windows 登录页 accent 实色底文字统一走 `--accent-foreground` 同源；浅色下与原值完全一致无视觉变化。B8 测试用三层等效验证（hex 派发纯函数 + hex→sRGB 分量换算 + 外观切换端到端解析）替代规格建议的 `NSColor.resolvedColor(with:)`——该 API 是 UIColor（iOS）专属，AppKit 没有此方法（已 grep 本机 SDK 头文件证实）。

**窗口标题六处复核逐字一致**：账号登录 / 沉浸口语 · 设置中心 / 沉浸阅读室 / 录音直译 / 快速复习 / 欢迎使用沉浸口语。

**平台差异（按 brand.md §4 既定理由未改）**：Windows 托盘菜单与 Mac status menu 的超集差异、`CFBundleName` 保持 ImmersiveTranslator、登录带标题保持「沉浸翻译」、其余窗散点 accentColor 不动。

---

## 四、设置中心逐页差异与处理（settings）

15 条验收：14 条达成，1 条（验收 15）前提已变（见 §6.3）。逐页如下：

### 4.1 墨绿品牌色（§2.1）

规格原计划新建 `SettingsBrandColor.swift`，但 brand 域已先行落地单一真源 `Brand.swift`（同值 `#1F6B57`/`#73C6AA` 动态 NSColor），再建第二份枚举违反单一真源——不再新建，散点改引 `Brand.accent`。根视图 `.tint(Brand.accent)`（`Settings.swift:1166`）管不到静态 `Color.accentColor`，故补齐散点 **24 处**：`Settings.swift` 12 处、`VoiceGateway/VoiceSettingsTab.swift` 8 处、`VoiceGateway/GatewayVoiceSection.swift` 1 处、`LoginWindowController.swift` AccountSectionView 3 处。侧栏选中行/conn-chip 的绿橙语义保留。

### 4.2 模型服务页双栏 IA（§2.2）

- `ProviderProfile.swift`：补沉浸云平台预设（endpoint `https://www.prismspace.online/v1/chat/completions`，`:147` 撰写时核验；model 空=服务端下发、mark 云、hint 逐字）；默认模型与候选表同步 Windows（deepseek-chat/deepseek-reasoner、glm-4-flash/glm-4-plus/glm-4-air、gpt-4o-mini/gpt-4o/gpt-4.1-mini）；`displayName` 智谱→智谱 GLM、Ollama（本地）→Ollama；新增 `mark`/`hint`/`keyURL` 三字段（`decodeIfPresent` 向后兼容）+ `allowsEmptyAPIKey`。
- `Settings.swift` `providerSection` 重构为：左列 250pt（分组头「官方云服务／沉浸云账号登录即用，无需申请任何密钥」+ 沉浸云平台大卡〔云徽标+官方 chip+统一管理描述+登录态行+未登录时「登录沉浸云」按钮〕 + 分组头「自带 API Key 的服务商…+n 个」+ 七行 ProviderItem 同构行〔品牌色 12% 徽标、keydot、模型胶囊、选中对勾、Ollama 本地 chip〕+ 自定义 provider 保留项）；右列连接配置（状态 chip 已登录/未登录、本机服务、密钥已保存/等待密钥；平台分支=账号块；非平台=preset hint + API Key 块〔placeholder 逐字、`keyUrl` 链接「前往 {displayName} 控制台获取 API Key ↗」〕+ 模型块〔候选下拉 +「下拉里是…常用模型」hint〕+ 测试连接/测试中… + DisclosureGroup「高级：接口地址与诊断」〔接口地址、实际请求（含「（未填写）」兜底，与 Windows `Settings.tsx:834` 逐字一致）、地址自动补全 hint、复制脱敏 curl/生成诊断报告/Mac 增补诊断〕）。
- 页头副标题逐字替换；首次引导卡改 Windows 三步版 +「知道了」写 `UserDefaults` `onboardingDismissed`（`@AppStorage`，显示条件 `!dismissed && !providerConfigured`）。
- **「登录沉浸云」按钮放左列平台卡内而非右列**（验收 3 字面为右列）：规格 §四.5 明示右列账号块简化、登录入口收进平台卡，右列未登录只留 hint，避免重复。

### 4.3 翻译页（§2.3）

seg「自动识别/固定目标语言」+ hint 逐字、流式输出、词典卡片 hint 逐字（Mac 补充「关闭词典卡片后一律整句翻译。」保留为次要 caption 行，规格允许）、风格 placeholder 逐字。

### 4.4 快捷键页（§2.4）

三行改「翻译热键／截图 OCR 热键／阅读室热键」+ Windows 逐字 hint（收敛为 `SettingsView.hotkeyRowSpecs` 单一来源）+ 推荐组合 chips + 冲突提示同步新标题。**两处 Mac 化差异**：推荐 chips 取 Mac 键族（`HotKeyShortcut.recommendedAlternatives` 过滤当前冲突，每行 3 枚）而非 Windows 五个 Ctrl+Shift 值；副标题保留 Mac 自动保存语义版（`didSet` 即时落盘+热键闸门重注册，无「立即生效」按钮），均规格明示允许。

### 4.5 术语表页（§2.5）

新增「从剪贴板导入」按钮（已从剪贴板导入并合并）、统计卡加大数字 N／80 条已启用 + ProgressView + 警告行 + 格式示例块、页头 trailing meta、编辑器说明并入 Windows placeholder 三行示例。保留 Mac 原有 `glossarySummaryView` 全量明细（识别/去重/边界/重复行）——比 Windows aside 更细，按 §四 先例保留。

### 4.6 账号页（§2.6）

`sectionContent` 补 `pagehead(.account)`；`AccountSectionView` 内联副标题删除防双标题；`.account` 副标题改逐字；`providerConfigured` 补沉浸云分支 = `serverAuth.status.loggedIn`（侧栏「接口已配置」点已登录才亮）。

### 4.7 沉浸云「登录即用」链路补全（规格隐含要求）

`requiresAPIKey` 对 `prismspace.online` 域免 Key（规格 §2.2 明列）之外，补齐三件规格未显式列出但「登录即用」必需的：

1. 平台 provider 请求基址按 `ServerAuthConfiguration.resolveBaseURL()` 派生（dev 覆盖文件同样生效）；
2. Authorization 自动携带账号令牌（`App.swift` 注入 `AuthTokenManager.getAccessToken`，临期单飞刷新=「到期自动续期」）；
3. 空模型不走 gpt-5.4-mini 兜底。

另新增 `TranslationClientError.platformNotLoggedIn`（尚未登录沉浸云文案）并适配三处 switch（ErrorMessageFormatter/App/Settings）。理由：只加预设免 Key 而不带令牌，选中沉浸云翻译必 401（网关无令牌 curl 实测即 401）；规格 hint 文案「翻译请求自动携带账号令牌（到期自动续期）」本身即此行为。

### 4.8 其余页与测试

- §2.7/2.8/2.9：ServerAuth 生产 URL 已由登录域落地（见 §2）；底部状态区/关闭按钮确认已对齐未动。
- 测试：重写 `ProviderProfileTests`（10 用例：沉浸云预设/默认模型/候选/displayName/mark/hint/keyURL/旧档兼容；复核阶段升级为 8 家 hint 逐字断言）；新建 `SettingsSectionIATests`（副标题/方向/快捷键行逐字）、`SettingsBrandColorTests`（hex 常量+按外观解析+分量容差 0）。
- 施工自检：`swift build` 0 error；**全量 `swift test` 1290 tests / 0 failures**（收尾改动后复跑，施工申报）；生产域名 curl 4 条全符合；44 条逐字文案 grep 全命中。
- 未新建 `ServerAuthConfigURLTests.swift`：登录域已在 `ServerAuthTests.swift` 覆盖同等断言，按规格 §2.9 第 4 条「与现有 ServerAuthTests 合并亦可」不重复建文件。

---

## 五、托盘改造明细（tray）

### 5.1 菜单结构（对齐 Windows §8.1，`lib.rs:1500-1516`）

数据源收敛为 `App.swift` 内 `StatusMenuEntry` + `static statusMenuEntries`（当前 `App.swift:615` 一带，撰写时核验；`rebuildStatusMenu` :573 消费同一数据源，**builder 是唯一数据源，无平行真源漂移风险**）：

```
翻译选中文本 / 截图翻译 (OCR) / 快速复习（N 到期）/ 生词本 / 录音直译 / 沉浸阅读室   ← 动作组六项，无内部分隔
──────────────────                                                              ← 分隔线（Windows 组界）
账号登录 / 翻译历史 / 检查更新 / 设置 / 使用引导 / 检查权限                            ← 入口组六项
──────────────────                                                              ← 分隔线（macOS 防误触，平台特有）
退出 ⌘Q
```

文案逐字对齐：「截图翻译 (OCR)」（对齐 lib.rs:1502）、6 处「...」移除（git diff 确认全删）、「沉浸阅读室」不简写、「快速复习（N 到期）」动态文案与 `review_reminder.rs:147-152` 逐字一致。12 项动作选择器**全部复用未改**（13 个 `@objc` selector diff 证明原样，`App.swift:751-913`）。结构/文案/快捷键形态写成 `StatusMenuStructureTests` 自动化锚定（超出规格的防漂移保障）。

### 5.2 快捷键提示原生化

`HotKeyShortcut.menuKeyEquivalent()`（`HotKeyManager.swift:111`，撰写时核验）：按规格映射表把 Carbon 键位→NSEvent 掩码、`keyLabel`→keyEquivalent 字符（缺省 ⌥Space / ⌃⌥Space / ⌃⌥R 右对齐渲染）；Space/Return/Tab/Delete/ForwardDelete/方向键/F1-F12/单字符逐项映射，其余 nil 回落「标题 + hint」内嵌。**全局热键 Carbon 注册路径零改动**。测试抓出并修复了 F10-F12 映射漏网 bug。

### 5.3 到期角标

新建 `Sources/ImmersiveTranslator/StatusBarBadge.swift`：

- `badgeRed = NSColor(srgbRed:224/255, green:67/255, blue:64/255, α:1)`（`:12`，与 `tray_badge.rs:22` BADGE_RGB [224,67,64] 直读一致）；
- `displayText` 上限 999、负数按 0（`:16`）；`due ≤ 0` 返回 nil（无角标）；
- 红胶囊（高 14pt 圆角 7）白字粗体等宽数字，2x Retina 位图，`isTemplate=false`；
- `trayIconWithBadge(base:due:)`（`:55`）：图标左 + 胶囊右（间距 3pt）合成。

`App.swift` `onDueCountChange`（`:507-531`）改为「托盘图标+胶囊」合成；**归零回归纯图标**；图标资源缺失时走规格原样「译」+胶囊尾随兜底（`:520-531`）。**SHELL-9 不变量保持**：`rebuildStatusMenu` 不触碰 button（`:569-593`），NSStatusItem 原地复用，角标增减不重建 status item。

**角标承载偏差（规格原设计为 `button.title="译"` + `button.image`=胶囊）**：落地时工作树已含品牌轮的 18pt 彩色托盘图标，照抄规格会抹掉该轮成果——改为在图标底座上合成，两条施工轮语义都保留；规格语义（红胶囊白字/due=0 无角标/999 上限/isTemplate=false）逐条未变。

### 5.4 刷新机制（平台差异）

沿用 Mac 现有主 runloop 回调（`ReviewTouchpointManager` 30s Timer + `onDueCountChange` + `refreshBadge`），未移植 Windows 后台线程调度——规格 §4-5 声明为框架必然差异；机制语义（30s 周期、变化才刷、生词变化即刷）与现链路一致，`refreshBadge` 五个调用点未动。

### 5.5 测试

`StatusBarBadgeTests`（5 例）、`HotKeyShortcutMenuEquivalentsTests`（4 例）、`StatusMenuStructureTests`（4 例）全绿（复核亲跑 `swift test --filter 'StatusBarBadgeTests|HotKeyShortcutMenuEquivalentsTests|StatusMenuStructureTests'` → 13 tests, 0 failures）；`swift build` Build complete。连通性：复核亲跑规格 §1.4 五项探测全部与申报一致（root 404、`/v1/me` 401、otp/request 非法 body 400、错误路径/方法 404），未发送真实凭据。

---

## 六、每域遗留与平台差异

### 6.1 auth 登录与远程服务

**遗留（复核认定，均 low）**：

1. 验收 5（release 包真机 GUI 登录）未执行——无 GUI 通道；替代证据在位（release 配置运行时测试 + 7/7 curl），转入 §7 人工清单。
2. **已知注意事项**：既有 `testEndpointOverrideWins` 在 **release 配置**下 3 条「无覆盖→dev」断言必挂（`ServerAuthTests.swift:781/:795/:802` 实测 fail：prod ≠ devBaseURL）——规格明确既有断言不改、验收 2 为 debug 口径（`run_swift_tests.sh` 裸 `swift test`），不违反验收；但日后任何对整个测试类跑 `swift test -c release` 会红。全量套件口径是 debug。

**平台差异**：无——本次修复正是消除 Mac 与 Windows 的 base_url 行为差异；覆盖文件优先、dev 直连本地联调两端一致。

### 6.2 brand 品牌统一

**遗留（均 low）**：

1. 验收 #10 人工冒烟三项未做（也无法做）：登录成功→自动关窗、到期角标高频刷新不闪烁、菜单栏 18pt「书页对话」彩图实际渲染——需真实 GUI 会话；代码级约束已代核（NSStatusItem 仅创建一次 `App.swift:548-562` 守卫、onDueCountChange 仅改 button 属性不重建、rebuildStatusMenu 不触碰 button）。
2. B4 申报与当前工作区代码不符（tray 轮叠加后的合成图方案），行为意图仍满足——详见 §三 B4 跨域演进。
3. 申报行号多处漂移（并行施工所致），所引内容值逐项核验正确；本报告行号已按撰写时工作区更新。

**平台差异**：CFBundleName/Executable 保持 `ImmersiveTranslator`（显示名走 `CFBundleDisplayName`）；登录带标题保持「沉浸翻译」；Windows 托盘菜单为 Mac status menu 超集的差异项不强行拉齐。

### 6.3 settings 设置中心

**遗留（均 low，复核后无未解决项）**：

1. 视觉层 GUI 目测（深浅色下侧栏选中行/官方卡/进度条/头像为墨绿）未做——代码替换 + `SettingsBrandColorTests` 分量断言（容差 0）层验证，GUI 目测入 §7。
2. 端到端沉浸云翻译实测（真实登录+真实翻译请求）未做：无测试账号且不得发送真实邮箱/创建账号；仅做到路由级 curl。
3. 设置窗 UI 交互实测（点平台卡/录制热键/导入术语表）未做：无 GUI 自动化环境，以代码+编译+单测覆盖。
4. **验收 15 前提已变**：登录窗已按同批 brand.md §B5 从暖橙迁到墨绿（规格明示授权），「暖橙零回归」按原口径无法声明，如实记录；恢复暖橙反而违反品牌域规格。

**平台差异（规格认可保留）**：引导卡③热键用 Mac 实际翻译热键插值（`⌥Space` 族）而非 Windows `Ctrl+Shift+Q`——照抄会指引用户按一个 Mac 上不存在且冲突率高的组合；快捷键推荐 chips 取 Mac 键族；快捷键页副标题保留 Mac 自动保存语义；词典卡片 Mac 补充行保留为次要 caption；术语表保留 Mac 全量明细。

### 6.4 tray 托盘与菜单栏

**遗留（均 low）**：

1. 验收 4/6/11 GUI 目检项（菜单真实弹出左右键行为、红胶囊深/浅色菜单栏与壁纸透出观感、keyEquivalent 渲染字形含 ⌥Space 空格字形、角标增减 status item 不位移不闪烁）——无 GUI 会话无法执行；可离线语义已由 13 例测试锚定。
2. 验收 7/8 运行时点击回归（账号登录分流、12 项点击逐一触发）未实跑 App——13 个 selector 存在且 diff 证明零改动、分流逻辑实读一致，真实点击链路需 GUI。
3. 全量 swift test 按分工由脚本统一跑（最终回归通过，任务口径）；域内只跑了三个新套件筛选运行。

**平台差异**：角标刷新走主 runloop 30s Timer（Windows 为后台线程调度）；「退出」前防误触分隔线为 macOS 菜单特有。

### 6.5 跨域事项

- 四个 ask 在同一工作区并行施工，导致申报行号漂移与 brand B4 描述陈旧；复核已逐项核验内容值正确，本报告行号以撰写时工作区为准。
- 工作区尚有大量未提交改动（含四个域产物与既有并行任务改动）；按任务约束本批次不提交 git，提交由用户统一执行。
- Windows 侧 `immersive-translator-windows/` 零改动（brand 复核 `git status --porcelain` 实跑为 0）。

---

## 七、用户目验清单（重启 app 后按此顺序看）

**前置**：用 release 包验（`./scripts/build_app.sh` 产物，dist 下）——debug/swift run 构建缺省仍连本地 `127.0.0.1:8090` 联调，看到「网络连接失败」属预期不算 bug。

1. **Dock 与关于页**：应用名显示「沉浸口语」，版本 0.12.1；图标与 Windows 端一致（同一 icns）。
2. **菜单栏图标**：18pt 彩色「书页对话」（非单色模板，深/浅色菜单栏下都应清晰可辨）；悬停 tooltip 显示「沉浸口语」。
3. **登录（本轮根因修复的主验收）**：打开账号登录窗 → 输入邮箱 → 点「获取验证码」→ **不应再出现「网络连接失败」红条**（release 缺省直连 `https://www.prismspace.online`）；整体墨绿品牌：主按钮墨绿白字、徽标「译」白字、品牌带文案「沉浸翻译 / 登录后同步生词本…」；切换系统深浅色，accent 应在 `#1F6B57` / `#73C6AA` 间切换且文字对比正常。登录成功后窗口应自动关闭。
4. **菜单栏菜单**：点 status item 弹出——动作组六项连续无内部分隔 → 分隔线 → 入口组六项（账号登录/翻译历史/检查更新/设置/使用引导/检查权限）→ 分隔线 → 退出 ⌘Q；有热键的项快捷键右对齐原生渲染（缺省翻译 ⌥Space、OCR ⌃⌥Space、阅读室 ⌃⌥R）；「快速复习（N 到期）」数字随复习队列变化。
5. **到期角标**：有到期生词时图标右侧出现红胶囊白字数字；快速复习清零后恢复纯图标；数字增减时 status item 不位移、不闪烁、图标不重建抖动。
6. **设置中心整体**：深浅色下侧栏选中行、官方卡、进度条、头像均为墨绿（不再是系统蓝）；窗标题「沉浸口语 · 设置中心」；底部状态区与关闭按钮正常。
7. **模型服务页**：双栏布局——左列「官方云服务」分组头 + 沉浸云平台大卡（未登录时有「登录沉浸云」按钮）+「自带 API Key 的服务商」七行（智谱 GLM 显示名、Ollama 带「本地」chip、模型胶囊、选中对勾）；右列连接配置随所选平台切换（沉浸云=账号块；其他=API Key + 模型候选下拉 + 测试连接 + 「高级：接口地址与诊断」折叠区）；首次打开显示三步引导卡，点「知道了」后不再出现。
8. **沉浸云翻译链路**：选中沉浸云并登录后，直接热键翻译选中文本——应免 API Key 正常返回（不再 401）；未登录时选择沉浸云翻译应得到「尚未登录沉浸云」提示而非网络错误；侧栏「接口已配置」点在已登录时点亮。
9. **其余页扫一遍**：翻译页 seg 与 hint、快捷键页三行新标题与 Mac 键族推荐 chips、术语表页「从剪贴板导入」与统计卡、账号页标题不重复。
10. **窗口标题六处**：账号登录 / 沉浸口语 · 设置中心 / 沉浸阅读室 / 录音直译 / 快速复习 / 欢迎使用沉浸口语。

**dev 联调注意**：`swift run`（debug）无覆盖文件时连本地 `127.0.0.1:8090`——本地联调需起本地服务，或用覆盖文件指向任意地址（覆盖文件优先逻辑未动）。

---

*本报告为四域施工与复核结果的忠实汇总；文中未标注「撰写时核验」的行号引自施工申报或复核记录，可能因后续并行改动漂移。*
