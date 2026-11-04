# 品牌统一规格：Mac 端对齐 Windows v0.12（brand）

> 诊断日期 2026-11-03。仓库根 `/Users/yangbishang/Projects/immersive-translator`。
> Windows 端（只读基准）= `immersive-translator-windows/`，工作区干净（`git status --porcelain immersive-translator-windows/` 为空），基线即 HEAD（含 commit 838fc86「墨绿品牌色系+新 APP 图标『书页对话』+阅读主题选择面板」）。
> Mac 端（实施对象）= `immersive-translator-mac/`，**工作区有 51 个文件的未提交改动**（含 `build_app.sh` 版本号 0.1.1→0.11.1 的修正），本文行号以**工作区当前状态**为准，实施须在工作区上继续。

## 根因（实测核实）

| # | 根因 | 证据 |
|---|---|---|
| 1 | Mac 应用图标仍是旧资产 | `immersive-translator-mac/Resources/AppIcon.icns` md5 `ebdca4f5a455d44232470cec659d5ea5` ≠ Windows 新 `icon.icns` md5 `38debaee0f0174e4e66ef2e1b282d029`；dist 旧构建产物内 `AppIcon.icns` 与 Mac 旧文件同 md5 |
| 2 | 登录窗品牌 token 仍是旧橙红 | `LoginWindowController.swift:52`（深色 accent `#E26D52`）、`:67`（浅色 accent `#C84B31`）；Windows v0.12 已是墨绿 `#1f6b57`/`#73c6aa` |
| 3 | 设置窗品牌块走 `Color.accentColor`，无 xcassets → 系统蓝 | `Settings.swift:1492/1574/1596/1881` 等；`find immersive-translator-mac -name "*.xcassets"` 为空 |
| 4 | 版本号缺省 0.11.1，落后 Windows 0.12.1 | `scripts/build_app.sh:6`（工作区，`APP_VERSION:-0.11.1`）、`scripts/package_release.sh:6`；Windows `tauri.conf.json:4` = 0.12.1 |
| 5 | 菜单栏 status item 是「译」文字，Windows 托盘已是新图标实物 | `App.swift:512/533`；Windows `lib.rs:1519` 托盘用 app 图标 |

**已对齐、无需改的**（逐一核实过）：应用内各窗口标题（见 §4 第 1 条）、status item tooltip 已是「沉浸口语」（`App.swift:535`）、设置窗品牌块文案已是「沉浸口语/设置中心」（`Settings.swift:1500/1503`）、阅读主题 token 已与 Windows styles.css 逐值对账（`ReaderTheme.swift:19`、`ReaderCore/ReaderSettings.swift:228-229`）。

---

## 1. Windows 行为基准（v0.12.1，逐字文案与关键值）

### 1.1 身份与版本

- 显示名/产品名：`沉浸口语`（`src-tauri/tauri.conf.json:3` `"productName": "沉浸口语"`）
- 版本：`0.12.1`（`tauri.conf.json:4`）
- 窗口标题全列表（`tauri.conf.json` + `src-tauri/src/lib.rs`）：
  - 设置窗 `沉浸口语设置`（tauri.conf.json:33；lib.rs:281 同值）
  - 历史窗 `翻译历史`（:47）；阅读室 `沉浸阅读室`（:61）；录音直译 `录音直译`（:100）；快速复习 `快速复习`（:114）
  - 引导窗 `欢迎使用沉浸口语`（:130；lib.rs:572 同值）；登录窗 `账号登录`（:143）

### 1.2 托盘（= Mac status item 的对齐物）

- 图标：app 默认图标实物（`lib.rs:1519` `.icon(app.default_window_icon()...)`），即「书页对话」
- tooltip：`沉浸口语`（`lib.rs:1520`）
- 菜单项全列表（`lib.rs:1502-1510`，自上而下）：
  `快速复习`｜`截图翻译 (OCR)`｜`录音直译`｜`沉浸阅读室`｜—分隔—｜`账号登录`｜`翻译历史`｜`设置`｜`退出`
- 到期角标：`快速复习` 菜单项文案动态加「（N 到期）」由 `review_reminder` 刷新（lib.rs:1502、1557-1564）

### 1.3 墨绿品牌色系 token（styles.css 权威值）

浅色（`src/styles.css:28-35`）：

```css
--brand-accent: #1f6b57;
--brand-hover: #185646;
--brand-active: #134836;
--brand-rgb: 31, 107, 87;
--brand-foreground: #ffffff;
--brand-soft: #e3f0ea;
--brand-softer: #f1f6f2;
--brand-line: #b9d8cc;
```

深色（`styles.css:76-83`）：

```css
--brand-accent: #73c6aa;
--brand-hover: #86d3ba;
--brand-active: #9cdfc6;
--brand-rgb: 115, 198, 170;
--brand-foreground: #112a20;
--brand-soft: #263d34;
--brand-softer: #21332c;
--brand-line: #436c5b;
```

- `--accent-grad` = 两端实色的伪渐变 `linear-gradient(135deg, var(--brand-accent), var(--brand-accent))`（styles.css:22）
- 每个 reader 主题根节点重派生 `--brand-accent`（styles.css:2034/2064/2095/2126/2927/2995/3063，commit 838fc86）

### 1.4 登录页品牌区（逐字文案，`src/views/LoginView.tsx:298-306`）

```tsx
<span className="login-band-logo">译</span>
<h1 className="login-band-title">沉浸翻译</h1>
<p className="login-band-sub">登录后同步生词本、阅读进度与偏好设置</p>
<span className="login-band-glyph">文<em>A</em></span>
```

- 带底：浅色 `linear-gradient(180deg, #e9ecfd 0%, rgba(255,255,255,0) 100%)`（styles.css:2361，淡靛蓝点睛）；深色改为 `rgba(var(--accent-rgb), 0.14)` 渐隐（styles.css:2735-2741，838fc86 把深色条带/水印从硬编码靛蓝改为 accent 派生——838fc86 diff 实证）
- logo 徽标/主按钮/水印颜色全部走 `--accent-*`（styles.css:2376/2383/2407/2414）
- **注意**：登录带标题在 Windows v0.12.1 仍是「沉浸翻译」（产品线名），应用显示名才是「沉浸口语」。Mac 对齐目标 = 与 Windows 逐字一致，不是把标题改成「沉浸口语」。

### 1.5 设置窗品牌块（`src/views/Settings.tsx:531-538` 逐字）

```tsx
<span className="set-brand-mark"><IconTranslate size={13} /></span>
<strong>沉浸口语</strong>
<small>设置中心</small>
```

### 1.6 图标资产（`src-tauri/icons/`，可直接取用）

- `icon.icns` 43486 B —— icns chunk 解析（python3 struct 解析实测）：含 `ic07(32)/ic08(256)/ic09(512)/ic10(512@2x)/ic11(16)/ic12(32@2x)/ic13(128)/ic14(256@2x)/il32/is32` **全尺寸**，md5 `38debaee0f0174e4e66ef2e1b282d029`，可直接作为 macOS AppIcon 复用
- `icon.png` 512×512（sips 实测）、`tray-icon.png` 32×32（sips 实测，墨绿底白「书页对话」，彩色非模板图）
- 图标母版：`src-tauri/app-icon.svg` + `scripts/make-icon.py`（commit 838fc86，18 个桌面图标与官网同源）

### 1.7 生产服务端 URL 与路由（Windows `src-tauri/src/auth.rs`）

- 常量：`auth.rs:153` `const PROD_BASE_URL: &str = "https://www.prismspace.online";`
- 路由：`POST /v1/auth/otp/request`（:695）、`POST /v1/auth/otp/verify`（:718）、`POST /v1/auth/login`（:732）、`POST /v1/auth/refresh`（:531）、`POST /v1/auth/logout`（:792）、`GET /v1/me`（:844）
- Mac 端同域名消费方式：dev 缺省 `http://127.0.0.1:8090`，生产由 `~/Library/Application Support/ImmersiveTranslator/server_endpoint.json` 的 `baseUrl` 覆盖（`ServerAuth.swift:111/123-134`）——**路由与生产域名与 Windows 完全同源**，本域不改网络层，实测仅证明可达与路由正确。

### 1.8 生产端点路由级 curl 实测（2026-11-03 执行，域名连通 → 路由 → 错误路径）

```
# ① 域名连通性（根路径无页面属正常，404 由路由器返回即证明可达）
$ curl -sS -o /dev/null -w "%{http_code}" --max-time 15 https://www.prismspace.online/
→ 404   (0.70s)

# ② 无凭据取当前用户，期待 401
$ curl -sS --max-time 15 https://www.prismspace.online/v1/me
→ 401   {"error":{"code":"unauthorized","message":"缺少访问令牌"}}

# ③ 非法 body 请求验证码（不发送真实邮箱、不建号），期待 400/422；实际 400
$ curl -sS --max-time 15 -X POST -H "Content-Type: application/json" \
    -d '{"email":"not-an-email"}' https://www.prismspace.online/v1/auth/otp/request
→ 400   {"error":{"code":"validation_error","message":"请求参数不合法",
          "details":[{"path":"email","message":"Invalid email"}]}}

# ④ 错误路径，期待 404
$ curl -sS --max-time 15 https://www.prismspace.online/v1/__no_such_route__
→ 404   {"error":{"code":"not_found","message":"Cannot GET /v1/__no_such_route__"}}

# ⑤ 已知路由用错方法，期待 404/405；实际 404（服务端以 404 表达）
$ curl -sS --max-time 15 https://www.prismspace.online/v1/auth/otp/request
→ 404   {"error":{"code":"not_found","message":"Cannot GET /v1/auth/otp/request"}}
```

五条全部符合预期：域名可达、`/v1/me` 有鉴权闸、`/v1/auth/otp/request` 路由与校验在位、未知路径/错方法返回 404。**未发送真实邮箱、未创建任何账号。**

---

## 2. Mac 落点设计（immersive-translator-mac/）

### B1 版本号 0.11.1 → 0.12.1（两脚本）

- `scripts/build_app.sh:6`：`APP_VERSION="${APP_VERSION:-0.11.1}"` → `:-0.12.1`
- `scripts/package_release.sh:6`：`VERSION="${1:-${APP_VERSION:-0.11.1}}"` → `:-0.12.1`（其 :758 以 `APP_VERSION="$VERSION"` 传回 build_app.sh）
- 证据：工作区 diff 显示这两行刚由 0.1.1 修正为 0.11.1（未提交），在其上继续改为 0.12.1；Windows 基线 `tauri.conf.json:4`=0.12.1
- **不改** `build_app.sh:5` `APP_NAME="ImmersiveTranslator"`（理由见 §4 第 6 条）

### B2 应用图标：直接复用 Windows icon.icns

```bash
cp immersive-translator-windows/src-tauri/icons/icon.icns \
   immersive-translator-mac/Resources/AppIcon.icns
```

- 复用可行性已实测：chunk 含 ic07–ic14 全尺寸（§1.6），Dock/Finder/菜单各尺寸不糊
- `build_app.sh:131`（`cp "$ROOT_DIR/Resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"`）**路径不变、无需改**；`Info.plist` 的 `CFBundleIconFile=AppIcon`（build_app.sh:149-150）不变
- 验收 md5：改后 `Resources/AppIcon.icns` == `38debaee0f0174e4e66ef2e1b282d029`
- **不要**把 Windows `tray-icon.png` 当 AppIcon 用（仅 32×32 单尺寸）

### B3 新资产：tray-icon.png 入 SPM 资源

```bash
cp immersive-translator-windows/src-tauri/icons/tray-icon.png \
   immersive-translator-mac/Sources/ImmersiveTranslator/Resources/tray-icon.png
```

- `Package.swift:20` `.process("Resources")` 会自动打进 `Bundle.module`（同目录现有 exam-wordlists.json 等同机制），build_app.sh:98-109 已把该 bundle 放 `Contents/Resources/` 并先签名再签整体（:177-180），无需改脚本
- 读取方式：`Bundle.module.url(forResource: "tray-icon", withExtension: "png")` → `NSImage(contentsOf:)`

### B4 菜单栏 status item：「译」文字 → 新图标实物（对齐 Windows lib.rs:1518-1520）

- `App.swift:531-537`（`configureMenuBar`）：
  - `item.button?.title = "译"`（:533）改为设置 `item.button?.image`：加载 B3 资产，`image.size = NSSize(width: 18, height: 18)`，`image.isTemplate = false`（保留彩色「书页对话」，与 Windows 托盘同实物）
  - `item.button?.toolTip = "沉浸口语"`（:535）**已对齐，保留**
- `App.swift:497-515`（`startReviewTouchpoints` 角标分支）：due>0 时现为 `"译 " + 红色数字` attributedTitle（:503-510）；改为 **图标保留 + 红色数字 attributedTitle**（前缀不再写「译 」）；due==0 分支（:512）清 attributedTitle、恢复纯 image。建议抽纯函数 `Brand.statusBadgeText(due:) -> String?` 供测试
- 菜单内容 `App.swift:547-564` **不改**（文案已品牌对齐，超集差异见 §4 第 4 条）

### B5 登录窗品牌区 token：橙红 → 墨绿

登录窗 `LoginTheme`（`LoginWindowController.swift:26`，`private struct`，字段 :28-39，`resolve(_:)` :41-73）换值（**机制不动，只换色值**，主按钮/徽标/选中态等全部引用 `theme.accent` 自动随换）：

| token | 现值（浅） | 新值（浅） | 现值（深） | 新值（深） | Windows 依据 |
|---|---|---|---|---|---|
| `accent` | `#C84B31`（:67） | `#1F6B57` | `#E26D52`（:52） | `#73C6AA` | styles.css:28 / :76 |
| `accentHover` | `#B3432C`（:69） | `#185646` | `#EA8266`（:54） | `#86D3BA` | styles.css:29 / :77 |
| `accentSoft` | accent 11% 透明（:68） | 不变（机制保留） | accent 16% 透明（:53） | 不变 | 观感对齐 --brand-soft |
| `accentForeground`（**新增字段**） | — | `#FFFFFF` | — | `#112A20` | styles.css:32 / :80 |

- 新增 `accentForeground` 的用途：品牌带「译」徽标文字（`LoginWindowController.swift:273` 现硬编码 `.foregroundColor(.white)`）改用 `theme.accentForeground`——深色模式 accent 变浅绿 `#73C6AA` 后白字对比不足，Windows 深色用 `#112a20` 深墨字
- 品牌带其余（`brandBand` :266-295）：标题「沉浸翻译」（:277）、副题「登录后同步生词本、阅读进度与偏好设置」（:280）、文A 水印（:285-290，走 `theme.accent`）**文字全部不动**，随 token 自动变墨绿；徽标底 `theme.accent`（:270）同上
- 窗背景 paper（:102-103 及 LoginTheme `paper` :44/:59）不动（见 §4 第 2 条）

### B6 设置窗品牌块与全局 accent：系统蓝 → 墨绿

- **新建** `Sources/ImmersiveTranslator/Brand.swift`：`enum Brand`，含
  - 十六进制真源常量：`accentLightHex = "#1F6B57"`、`accentLightHoverHex = "#185646"`、`accentDarkHex = "#73C6AA"`、`accentDarkHoverHex = "#86D3BA"`、`accentForegroundDarkHex = "#112A20"`
  - 由 hex 构建 `NSColor`；动态 `static let accent = Color(nsColor: NSColor(name: nil) { appearance in ... })` 按 appearance 浅/深返回——写法照抄窗背景的既有模式（`LoginWindowController.swift:102` `NSColor(name: nil) { appearance in ... }`）
  - `static func statusBadgeText(due: Int) -> String?`（B4 的纯函数）
- 应用点：`Settings.swift:1156` 处 `NSHostingController(rootView: view)` 的 `view` 加 `.tint(Brand.accent)`（SettingsView 定义于 :1206）。`Color.accentColor` 在该视图层级内解析为 tint → 品牌徽记渐变（:1492）、导航选中条（:1574、:1596、:1599）、强调按钮（:1881-1884）等全部墨绿，无需逐处改
- 登录窗**不**迁 `Color.accentColor`，继续用 LoginTheme（B5），Brand 为其提供常量源（单一真源在 Brand）

### B7 显示名：Info.plist 增加 `CFBundleDisplayName`

- `build_app.sh:138-173` 的 Info.plist 模板，在 `CFBundleName`（:153-154，现 `ImmersiveTranslator`）附近新增：

```
<key>CFBundleDisplayName</key>
<string>沉浸口语</string>
```

- `CFBundleName` 与 `CFBundleExecutable`（:145-146）**保持 ImmersiveTranslator**（理由见 §4 第 6 条）；访达/启动台/强制退出等显示名由 `CFBundleDisplayName` 承担，对齐 Windows productName（tauri.conf.json:3）
- 已核实现产物缺失该键：`plutil -p dist/ImmersiveTranslator.app/Contents/Info.plist` 输出仅有 `CFBundleName=ImmersiveTranslator`、`CFBundleShortVersionString=0.11.1`

### B8 需补的 Swift 测试

**新建** `Tests/ImmersiveTranslatorTests/BrandTokenTests.swift`（照 `Tests/ImmersiveTranslatorTests/ServerAuthTests.swift:2` 的 `import XCTest` + `@testable import ImmersiveTranslator` 口径）：

1. `testBrandHexConstants`：`Brand.accentLightHex == "#1F6B57"`、`accentLightHoverHex == "#185646"`、`accentDarkHex == "#73C6AA"`、`accentDarkHoverHex == "#86D3BA"`、`accentForegroundDarkHex == "#112A20"`（对账 Windows styles.css:28-35/76-83）
2. `testDynamicAccentResolvesByAppearance`：`Brand.accent` 底层 NSColor 在 `NSAppearance(named: .aqua)` 下解析 RGB = (31,107,87)，`.darkAqua` 下 = (115,198,170)（用 `resolvedColor(with:)` 取分量）
3. `testStatusBadgeText`：`Brand.statusBadgeText(due: 0) == nil`、`statusBadgeText(due: 3) == "3"`

运行：`cd immersive-translator-mac && swift test --filter BrandTokenTests`；构建回归：`swift build -c release`（与 build_app.sh:93 同口径）。

- 说明：`LoginTheme` 是 `private struct`（LoginWindowController.swift:26），测试不直测它；因 B5 要求其 accent 三元组**改为引用 Brand 常量**，Brand 测试即覆盖登录窗取值。如实施者希望直测，可顺手把 LoginTheme 提为 internal（可选，不强制）。

---

## 3. 逐条验收清单

1. **版本**：`build_app.sh:6` 与 `package_release.sh:6` 缺省均为 `0.12.1`；跑 `./scripts/build_app.sh` 后 `plutil -p dist/ImmersiveTranslator.app/Contents/Info.plist` 的 `CFBundleShortVersionString` == `0.12.1`
2. **显示名**：同一 Info.plist 含 `CFBundleDisplayName` == `沉浸口语`；访达中 app 显示名不再是 ImmersiveTranslator
3. **应用图标**：`md5 immersive-translator-mac/Resources/AppIcon.icns` == `38debaee0f0174e4e66ef2e1b282d029`（与 Windows `src-tauri/icons/icon.icns` 一致）；构建后 `dist/ImmersiveTranslator.app/Contents/Resources/AppIcon.icns` 同 md5；访达显示「书页对话」图标（ic07–ic14 全尺寸在包）
4. **status item**：菜单栏按钮显示 18pt「书页对话」彩图（非「译」字）；tooltip == `沉浸口语`；复习到期时图标旁出现红色数字、归零后恢复纯图标（App.swift:501-514 分支改后行为等价）；左键菜单完整保留 :547-564 全部项
5. **登录窗**：浅色下主按钮/「译」徽标底/文A 水印均为 `#1F6B57` 系；深色下为 `#73C6AA` 系且徽标「译」字为深墨 `#112A20`（不再白字）；品牌带文案逐字保持「沉浸翻译 / 登录后同步生词本、阅读进度与偏好设置 / 文A」（LoginWindowController.swift:277/280/285-287 不动）
6. **设置窗**：品牌徽记（Settings.swift:1492 渐变）、导航选中态（:1574/:1596/:1599）、强调按钮（:1881-1884）呈墨绿，不再系统蓝；品牌文案保持「沉浸口语 / 设置中心」（:1500/:1503）
7. **测试**：`swift test --filter BrandTokenTests` 全绿；`swift build -c release` 成功
8. **窗口标题**（不改项复核）：账号登录（LoginWindowController.swift:96）/ 沉浸口语 · 设置中心（Settings.swift:1157）/ 沉浸阅读室（ReaderWindowController.swift:35）/ 录音直译（LiveCaptionWindow.swift:228）/ 快速复习（QuickReviewWindow.swift:37）/ 欢迎使用沉浸口语（Onboarding.swift:59），与 Windows §1.1 逐字一致
9. **端点回归**（复测命令见 §1.8）：`/v1/me`→401、非法 body `/v1/auth/otp/request`→400/422、未知路径→404
10. **人工冒烟**：登录成功→自动关窗、到期角标高频刷新不闪烁（App.swift:528-530 的原地复用约束不被 B4 破坏：仍只换 button.image/attributedTitle，不重建 NSStatusItem）

---

## 4. 平台必然差异清单（不改 + 理由）

1. **应用内窗口标题已各自对齐、Mac 设置窗标题带「· 设置中心」后缀**（Settings.swift:1157 `沉浸口语 · 设置中心` vs Windows `沉浸口语设置`）：mac 双头标题栏（REVIEW-02 注释 :1159）窗内另有标题，保留本地格式；语义一致。
2. **登录窗 paper 暖纸底（浅 `#F6F3EC`）与品牌带无渐变**，不对齐 Windows 浅色条带 `#e9ecfd` 淡靛蓝渐隐（styles.css:2361）：Windows 自己浅色条带也保留靛蓝点睛（838fc86 只改了深色条带为 accent 派生），两端浅色都不是纯墨绿底；Mac 本地纸质风是既定视觉，本域只对齐 accent token（B5）。
3. **文A 水印尺寸/透明度不逐值对齐**：Windows 88px @ 0.10/0.05（styles.css:2404/2407/2414），Mac 30pt @ 0.32（LoginWindowController.swift:285-289）——字号量纲与版式不同，按各自布局调到观感相当即属对齐；文字内容（文A）一致。
4. **Mac status menu 是 Windows 托盘菜单的超集**（App.swift:547-562 另有 `翻译选中文本 <快捷键>`、`截图 OCR 翻译 <快捷键>`、`生词本...`、`检查更新...`、`使用引导`、`检查权限`）：快捷键展示是 NSMenu 平台惯例；「检查更新/检查权限」是 LSUIElement 菜单栏应用必备入口；Windows 托盘无此机制。交集项文案（沉浸阅读室/快速复习/录音直译/账号登录/翻译历史/设置/退出）已逐字一致，不删不减。
5. **status item 用彩色非模板图**（isTemplate=false）：Windows 托盘即 app 彩色图标实物（lib.rs:1519），macOS 惯例虽是单色 template，但本域目标是两端同实物；已在 B4 固定 18pt。若日后嫌菜单栏过重，另立任务做 template 版，本轮不做。
6. **`CFBundleName`/`CFBundleExecutable` 保持 `ImmersiveTranslator`，`APP_NAME` 不改**（build_app.sh:5）：该名字联动 dist 产物路径、SPM 资源 bundle 命名（build_app.sh:104/110/119）、codesign 目标与 `Tests` 引用，改动波及 7+ 处且风险大；显示名诉求由 `CFBundleDisplayName`（B7）承担。Windows 侧 exe/identifier 同样不随中文显示名改（identifier 仍是 com.immersivetranslator.windows，tauri.conf.json:5）。
7. **登录带标题保持「沉浸翻译」**：Windows v0.12.1 基线本身如此（LoginView.tsx:301）——产品线名与应用显示名分层，两端一致；若产品决定改名，属双端同步决策，不在本域单侧实施。
8. **Mac 有「检查更新」菜单项、Windows 商店版禁自更新**（AGENTS.md 硬性约束 + App.swift:559）：分发机制平台差异，品牌域不触碰更新逻辑。
9. **其余窗的散点 `.accentColor`（系统蓝）本轮不动**：QuickReviewWindow.swift:605/826、LiveCaptionWindow.swift:59/160/163、ReaderIntakeSheet.swift:208、ReaderNoteDialog.swift:170——这些窗口归各自功能域规格管辖，避免本域跨域改 UI 扩大回归面；B6 的 Brand.accent 已为后续统一点位提供现成常量（后续只需在这些窗根上加 `.tint`）。
