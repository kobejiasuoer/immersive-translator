# 托盘与菜单栏改造规格（Mac 对齐 Windows §8.1）— 2026-11-02

> 诊断域：状态栏（status item）菜单 + 复习角标。Windows 基准实证自 `immersive-translator-windows/src-tauri/src/`（本轮只读），Mac 落点在 `immersive-translator-mac/`（本轮只读，下一轮施工）。
> 本轮所有行号均在 2026-11-03 工作树核实；App.swift 托盘/角标相关代码全部来自已提交的 `df401c7`（未提交的 +141 行经 diff 核对不含托盘代码）。

---

## 一、Windows 行为基准

### 1.1 托盘菜单结构（lib.rs:1500-1516）

设计意图出自 `docs/reading-room-handoff.md` §8.1（245-267 行）：**用分隔线分两组**——「上面是『动作』（对你当前的内容做点什么），下面是『窗口/应用』（打开某个界面）」；文案必须用「沉浸阅读室」，**「沉浸」是差异化卖点，不要简写成「阅读」或「阅读器」**。

菜单逐字文案、顺序与 id（`Menu::with_items` 实序，lib.rs:1511-1516）：

| # | id | 逐字文案 | 快捷键提示 | 行为（lib.rs:1526-1553） |
|---|---|---|---|---|
| 1 | `ocr` | `截图翻译 (OCR)` | 无（accelerator=None，lib.rs:1503） | `open_ocr_overlay(app)` 截全屏→overlay |
| 2 | `quick` | `快速复习`（due>0 时动态变 `快速复习（{due} 到期）`） | 无 | `review_reminder::open_quick_review_window(app)` |
| 3 | `live` | `录音直译` | 无（lib.rs:1504） | `show_live_caption_window(app)` |
| 4 | `reader` | `沉浸阅读室` | 无（lib.rs:1505） | `show_reader_window(app)` |
| — | sep | 分隔线 | | |
| 5 | `account` | `账号登录` | 无（lib.rs:1507） | 已登录 → `settings_open_tab("account")` 定位设置「账号」tab；未登录 → `show_window("login")`（lib.rs:1537-1552，经 `TokenManager.get_status().logged_in` 判断） |
| 6 | `history` | `翻译历史` | 无（lib.rs:1508） | `show_window("history")` |
| 7 | `settings` | `设置` | 无（lib.rs:1509） | `show_window("settings")` |
| 8 | `quit` | `退出` | 无（lib.rs:1510） | `app.exit(0)` |

- 全部菜单项 accelerator 均为 `None`：**Windows 托盘菜单不展示任何快捷键提示**（快捷键只在引导窗/设置里展示，热键常量 Ctrl+Shift+Q / Ctrl+Shift+E / Ctrl+Shift+R，lib.rs:41-45）。
- Windows 生词本复习**不在托盘**（入口在阅读室）；检查更新 / 使用引导 / 检查权限也不在托盘（更新走设置+商店，引导首启自动弹 lib.rs:1567-1572，Windows 无 TCC 权限概念）。
- 设置页 tab 定位的双路径机制（托盘「账号登录」已登录态用）：settings 窗已存在 → `emit_to("settings", "settings:navigate-tab")`；不存在 → 写 `PendingSettingsTab` 再开窗（lib.rs:90-94、637-648）。

### 1.2 托盘图标与打开行为（lib.rs:1518-1525）

- `tooltip("沉浸口语")`（lib.rs:1520）。
- `.show_menu_on_left_click(true)`：**左键、右键都弹菜单**（lib.rs:1522-1525，注释明确这是刻意行为——此前左键无反应新用户找不到入口）。
- 图标 = 默认应用窗口图标 + 到期角标像素合成。

### 1.3 复习角标语义（tray_badge.rs + review_reminder.rs）

- 角标 = 图标右上角**红色圆 + 白色数字**：
  - 红 `BADGE_RGB = [224, 67, 64]`（#E04340，tray_badge.rs:22，注释：与 `--err #e5484d` 接近的托盘红）；
  - 圆心 (0.72w, 0.24h)、半径 0.26×min(w,h)（tray_badge.rs:36-38）；
  - 数字 3×5 点阵白字，**due > 999 显示 `999`**（tray_badge.rs:66-71）；
  - **due = 0 → 原图返回，无角标**（tray_badge.rs:27-29 + 测试 `due_zero_keeps_base`）。
- 刷新链路：
  - `update_tray`（review_reminder.rs:134-154）：`due = reader_store::due_count(app)` → `tray.set_icon(badge_icon(base, due))` + 菜单文案 `快速复习（{due} 到期）` / `快速复习`（review_reminder.rs:147-152）；
  - 启动即刷 + 30s 调度线程：`review_reminder::update_tray(...)` + `spawn_scheduler(...)`（lib.rs:1563-1565）；
  - 前端生词变化（收藏/评分/导入）即刷：`tray_refresh_badge` 命令（review_reminder.rs:349-353）→ 前端封装 `trayRefreshBadge()`（`src/lib/reminder.ts:60-61`），调用点 `ReaderApp.tsx:1290`、`QuickReviewApp.tsx:156`；
  - 句柄模式：`TrayHandles { tray, quick_item }` 存句柄只 `set_icon`/`set_text`，不重建菜单（review_reminder.rs:126-131，lib.rs:1557-1562）。

### 1.4 生产服务端常量与登录端点（托盘「账号登录」域硬性要求）

- 生产 URL 常量：`PROD_BASE_URL = "https://www.prismspace.online"`（auth.rs:153）；调试缺省 `http://127.0.0.1:8090`（auth.rs:150）；`PLATFORM_PUBLIC = true`（auth.rs:159）；覆盖文件 `app_data_dir/server_endpoint.json`（auth.rs:157,171-172）。
- 路由（auth.rs）：`POST /v1/auth/refresh`(:531)、`POST /v1/auth/otp/request`(:695)、`POST /v1/auth/otp/verify`(:718)、`POST /v1/auth/login`(:732)、`POST /v1/auth/logout`(:792)、`GET /v1/me`(:844)、`GET /v1/me/config`(:855)、`POST /v1/events`(:881)。

**路由级实测（2026-11-03 实跑，未发送真实邮箱、未创建账号）**：

```bash
# ① 域名连通性
curl -sS -o /dev/null -m 15 -w 'DNS+TLS+HTTP root: %{http_code} (%{time_total}s)\n' https://www.prismspace.online/
# → DNS+TLS+HTTP root: 404 (0.692670s)   # 根路径无 handler，TLS/域名可达 ✓

# ② GET /v1/me 无凭据（期待 401）
curl -sS -m 15 -o /tmp/me_body.txt -w 'status=%{http_code}\n' https://www.prismspace.online/v1/me
# → status=401  {"error":{"code":"unauthorized","message":"缺少访问令牌"}}   ✓

# ③ POST /v1/auth/otp/request 非法 body（期待 400/422；email 传数字，不发真实邮箱）
curl -sS -m 15 -X POST -H 'Content-Type: application/json' -d '{"email":12345}' \
  -o /tmp/otp_body.txt -w 'status=%{http_code}\n' https://www.prismspace.online/v1/auth/otp/request
# → status=400  {"error":{"code":"validation_error","message":"请求参数不合法",
#     "details":[{"path":"email","message":"Expected string, received number"}]}}   ✓

# ④ 错误路径：POST /v1/auth/otp（不存在的路由，期待 404/405）
curl -sS -m 15 -X POST -o /dev/null -w 'status=%{http_code}\n' https://www.prismspace.online/v1/auth/otp
# → status=404   ✓

# ⑤ 错误方法：GET /v1/auth/otp/request（期待 404/405）
curl -sS -m 15 -o /dev/null -w 'status=%{http_code}\n' https://www.prismspace.online/v1/auth/otp/request
# → status=404   # 服务端对错误方法同样返回 404（不吐 405），属服务端行为，不影响可达性结论 ✓
```

结论：生产域名可达，鉴权/OTP/错误路径路由全部符合预期（⑤ 实际为 404 而非 405，如实记录）。规格不含对以上端点的新增改动，仅作登录入口可达性背书。

---

## 二、Mac 落点设计

### 2.0 现状诊断（复核结论，含对旧侦察的修正）

现状菜单（App.swift:546-566，已提交状态）：`[翻译选中文本  <hint>] [截图 OCR 翻译  <hint>] sep [沉浸阅读室  <hint>] [生词本...] [快速复习（N 到期）] [录音直译...] sep [账号登录...] [翻译历史...] [检查更新...] [设置... ⌘,] [使用引导] [检查权限] sep [退出 ⌘Q]`。

| 问题 | 证据 |
|---|---|
| ① 动作与入口分组错位：翻译选中文本+截图OCR 在第一组，**沉浸阅读室（Windows 的动作项）却混在第二组**，动作被分隔线劈成两半；Windows 是「四个动作一组」 | App.swift:547-556 vs lib.rs:1511-1516 |
| ② 快捷键提示内嵌标题：`"翻译选中文本  " + hint`，hint 是全单词 + ` + ` 拼接（如 `Control + Option + Space`，HotKeyManager.swift:103-105、204-219），左对齐拖长菜单、不右对齐，与同菜单里原生 keyEquivalent 的「设置 ⌘,」「退出 ⌘Q」形成两套排版 | App.swift:547-548,550 vs 560,564 |
| ③ 文案与 Windows 不一致：`截图 OCR 翻译`（应为 `截图翻译 (OCR)`）；6 项带 `...` 后缀（生词本/录音直译/账号登录/翻译历史/检查更新/设置），Windows 逐字无后缀，同菜单内新旧两种风格混排 | App.swift:548,551,555,557-560 vs lib.rs:1502-1510 |
| ④ 角标语义弱：到期数是**裸红字数字**（`systemRed`，无任何红色形状），菜单栏里像两个无关字符，没有 Windows「红色圆底白字」的角标语义；且无上限（四位数会把 status item 撑宽，Windows cap 999） | App.swift:502-513 vs tray_badge.rs:22,66-71。**修正旧侦察：「无角标语义」不准确——到期标记已存在**（App.swift:499-515），缺的是形状语义与上限 |
| ⑤ status item 打开行为/tooltip 已对齐，无需改：`item.menu` 赋值后左右键都弹菜单（App.swift:566，NSStatusItem 标准行为 ↔ lib.rs:1525）；tooltip 已是「沉浸口语」（App.swift:535 ↔ lib.rs:1520） | App.swift:535,566 |
| ⑥ 「账号登录」分流已对齐，无需改：已登录 → 设置账号分区（`settingsController.showAccountSection()`，Settings.swift:1192），未登录 → 登录窗（App.swift:665-673 ↔ lib.rs:1537-1552；本节 §1.4 实测证明生产路由可达） | App.swift:665-681 |
| ⑦ 调度/即刷链路已对齐，无需改：30s Timer + 启动即刷（ReviewTouchpointManager.swift:41-51）↔ lib.rs:1563-1565；生词变化即刷 `refreshBadge()`（ReviewTouchpointManager.swift:74-82，调用点 QuickReviewWindow.swift:253,286、ReaderViewModel.swift:927,2127,2141）↔ review_reminder.rs:349-353 | 同左 |

### 2.1 菜单结构与文案改造（改 `App.swift:543-567 rebuildStatusMenu`）

目标结构（Windows 相对顺序逐项保持；Mac 独有项按功能就近插入，加 ★ 标注）：

```
翻译选中文本            ⌥Space（原生 keyEquivalent）   ★ Mac 独有
截图翻译 (OCR)          ⌃⌥Space（原生 keyEquivalent）   ← 文案改，Windows #1
快速复习（N 到期）/ 快速复习  无快捷键                      ← 动态文案保留，Windows #2
生词本                  无快捷键                        ★ Mac 独有，就近快速复习（同为复习动作）
录音直译                无快捷键                        ← 去掉 "..."，Windows #3
沉浸阅读室              ⌃⌥R（原生 keyEquivalent）       ← 移入动作组，Windows #4
──────────────────（分隔线，对齐 Windows 组界）
账号登录                无快捷键                        ← 去掉 "..."，Windows #5
翻译历史                无快捷键                        ← 去掉 "..."，Windows #6
检查更新                无快捷键                        ★ Mac 独有，去 "..."
设置                    ⌘,                             ← 去 "..."，Windows #7
使用引导                无快捷键                        ★ Mac 独有
检查权限                无快捷键                        ★ Mac 独有
──────────────────（分隔线，macOS 安全惯例，见 §4-5）
退出                    ⌘Q                             Windows #8
```

施工要点：
1. **动作组六项 + 一条分隔线 + 入口组六项 + 一条分隔线 + 退出**；删除现第一条多余分隔线（App.swift:549）并按上表重排 `addItem` 顺序；动作选择器（`menuTranslateSelection`/`menuTranslateScreenshot`/`openQuickReview`/`openVocabReview`/`toggleLiveCaption`/`openReader` 等，App.swift:653-769）全部复用不改。
2. 文案逐字对齐 §2.1 表：改 `截图 OCR 翻译` → `截图翻译 (OCR)`；去掉 6 处 `...`（App.swift:551,555,557,558,559,560）。保留 `快速复习（N 到期）` 动态格式（App.swift:552-554，与 Windows review_reminder.rs:147-152 逐字一致）。
3. 快捷键提示改**原生 keyEquivalent**（右对齐、菜单字体等宽渲染）：
   - `HotKeyShortcut` 增加纯函数（改 `HotKeyManager.swift`，放在 `var title` 附近 103 行后）：
     ```swift
     /// 菜单原生快捷键显示：keyEquivalent 字符 + 修饰键掩码；不可映射的 keyLabel 返回 nil（回落标题内嵌）。
     func menuKeyEquivalent() -> (character: String, modifiers: NSEvent.ModifierFlags)?
     ```
     映射表：`modifierLabels` 的四个 Carbon 位（HotKeyManager.swift:204-219 已有读取逻辑）→ `cmdKey(0x100)→.command / shiftKey(0x200)→.shift / optionKey(0x800)→.option / controlKey(0x1000)→.control`；keyLabel 单字母/数字（大小写不敏感，录制时已 uppercased，HotKeyManager.swift:377-381）→ 小写字符；`"Space"→" "`、`"F1"~"F12"→NSF1FunctionKey(0xF704)+n-1` 对应 Unicode 功能键标量、`"Return"→"\r"`、`"Tab"→"\t"`、`"Delete"→"\u{7F}"`、`"Left/Right/Up/Down Arrow"→NSLeft/Right/Up/DownArrowFunctionKey(0xF702/0xF703/0xF700/0xF701)`、`"Forward Delete"→0xF728`；其余（多词非功能键 label 等）→ nil。
   - 三个默认热键必须落原生渲染（Settings.swift:200-202,336：⌥Space / ⌃⌥Space / ⌃⌥R）；`menuKeyEquivalent()` 非 nil 的项：`item.title = 纯文案`（去掉 `"  \(title)"` 拼接）、`item.keyEquivalent = character`、`item.keyEquivalentModifierMask = modifiers`；为 nil 的项维持现内嵌 hint 兜底。注意 keyEquivalent 仅作菜单内显示/触发，全局热键仍由 Carbon `RegisterEventHotKey` 负责（HotKeyManager.swift:415 起），二者互不替代。
4. `configureMenuBar`（App.swift:527-539）与 `refreshMenu`（App.swift:569-576）机制不动（SHELL-9 原地复用注释仍有效）；`rebuildStatusMenu` 依旧不触碰 button（App.swift:541-542 不变量），角标见 §2.2。

### 2.2 复习角标语义改造（新建 `Sources/ImmersiveTranslator/StatusBarBadge.swift` + 改 `App.swift:496-520`）

对齐 Windows「红色圆底 + 白字数字、due=0 无角标、上限 999」（tray_badge.rs:22,27-29,66-71）：

1. 新建 `StatusBarBadge`（纯 AppKit 绘制，**不新增图片资产**，对齐 tray_badge.rs「不引图形依赖」思路）：
   ```swift
   enum StatusBarBadge {
       /// Windows tray_badge.rs:22 BADGE_RGB [224,67,64]（注释：≈ --err #e5484d）
       static let badgeRed = NSColor(srgbRed: 224/255, green: 67/255, blue: 64/255, alpha: 1)
       /// 显示上限（tray_badge.rs:66-71：>999 显示 999）
       static func displayText(due: Int) -> String   // min(due, 999) 字符串
       /// due <= 0 → nil；否则红色圆角胶囊（高 14pt、圆角半径 7）+ 白色粗体等宽数字居中，
       /// 2x Retina 位图，isTemplate = false（红底白字在深浅色菜单栏均成立，无需模板适配）
       static func badgeImage(due: Int) -> NSImage?
   }
   ```
   字体 `monospacedDigitSystemFont(ofSize: 11, weight: .bold)`（沿用现红字字体语义，App.swift:507），白字前景 `white`。
2. 改 `App.swift` `startReviewTouchpoints` 的 `onDueCountChange`（替换 499-515 行 attributedTitle 逻辑）：
   ```swift
   if let item = self?.statusItem, let button = item.button {
       button.title = "译"
       if due > 0, let badge = StatusBarBadge.badgeImage(due: due) {
           button.image = badge
           button.imagePosition = .imageTrailing   // 「译」左、角标右（Windows 角标在右上）
       } else {
           button.image = nil                       // due=0 回归纯「译」，对齐 tray_badge.rs:27-29
       }
   }
   ```
   幂等性：`configureMenuBar` 首建时 title="译"（App.swift:533），此后每次回调都重设 title + 增删 image，重复触发无副作用；`onDueCountChange` 仅在数值变化时触发（ReviewTouchpointManager.swift:60-63），宽度抖动被 999 上限封顶。

### 2.3 需补的 Swift 测试（`Tests/ImmersiveTranslatorTests/`，XCTest，对齐 tray_badge.rs 既有测试语义）

新建 `StatusBarBadgeTests.swift`：
1. `test_zeroDueReturnsNil`：`badgeImage(due: 0) == nil`（对应 tray_badge.rs `due_zero_keeps_base`）。
2. `test_positiveDueReturnsImage`：`badgeImage(due: 6)` 非 nil 且 `size.width/height > 0`（对应 `due_draws_red_pixels`）。
3. `test_displayTextCapsAt999`：`displayText(due: 1500) == "999"`、`displayText(due: 42) == "42"`。
4. `test_badgeRedMatchesWindowsConstant`：badgeRed RGB 分量 == (224/255, 67/255, 64/255)（锚定跨端同色）。

新建 `HotKeyShortcutMenuEquivalentsTests.swift`：
5. 三个默认热键：`.optionSpace → (" ", [.option])`、`.controlOptionSpace → (" ", [.control, .option])`、`.controlOptionR → ("r", [.control, .option])`（HotKeyManager.swift:107-124 的值）。
6. `HotKeyShortcut(keyCode: 0, modifiers: optionKey, keyLabel: "Unknown")` → nil（兜底路径存在）。
7. 修饰键双向映射：`.command/.shift/.option/.control` ↔ `cmdKey/shiftKey/optionKey/controlKey`（HotKeyManager.swift:204-237 两方向的往返一致性）。

测试运行：`cd immersive-translator-mac && swift test --filter StatusBarBadgeTests`（及 `--filter HotKeyShortcutMenuEquivalentsTests`）；类型检查 `swift build`。

---

## 三、逐条验收清单

1. 打开状态栏菜单：动作组连续六项「翻译选中文本 / 截图翻译 (OCR) / 快速复习 / 生词本 / 录音直译 / 沉浸阅读室」之间**无分隔线**，其后有且仅有一条分隔线隔开入口组（App.swift rebuildStatusMenu 重排后目检）。
2. 「截图 OCR 翻译」已更名为「截图翻译 (OCR)」；「生词本 / 录音直译 / 账号登录 / 翻译历史 / 检查更新 / 设置」六项不再带「...」；「沉浸阅读室」在动作组且逐字无简写（对照 §2.1 表逐字目检）。
3. 三个热键项（默认 ⌥Space / ⌃⌥Space / ⌃⌥R）的快捷键提示**右对齐**、以菜单等宽字形渲染，不再出现「Control + Option + Space」式内嵌后缀；「设置 ⌘,」「退出 ⌘Q」显示不变。
4. 造一条到期生词（或临时把 srs.dueAt 改为过去）：菜单栏「译」右侧出现**红色胶囊白字数字**角标；数字 >999 时显示 999；生词清零后角标消失、按钮回到纯「译」；角标增减时 status item 不位移不闪烁（原地复用机制未被破坏）。
5. 「快速复习」菜单文案随到期数变「快速复习（N 到期）」（unchanged 行为回归验证，App.swift:552-554）。
6. 左键、右键点击 status item 均弹出菜单；tooltip 仍为「沉浸口语」。
7. 菜单「账号登录」：未登录开登录窗、已登录打开设置并定位账号分区（行为回归，App.swift:665-673 + Settings.swift:1192）。
8. 每个菜单项点击行为逐一回归：翻译选中文本 / 截图OCR / 快速复习 / 生词本 / 录音直译 / 沉浸阅读室 / 翻译历史 / 检查更新 / 设置 / 使用引导 / 检查权限 / 退出 全部仍走原选择器（App.swift:653-817 不改 action）。
9. `swift build` 通过；`swift test --filter StatusBarBadgeTests` 与 `--filter HotKeyShortcutMenuEquivalentsTests` 全绿。
10. 生产路由背书保持有效（本轮已实测：`GET /v1/me`→401、`POST /v1/auth/otp/request` 非法 body→400、错误路径→404；§1.4 记录在案，施工轮无需重测除非换域名）。
11. 视觉目检深浅两套菜单栏外观：红胶囊白字在深色/浅色/壁纸透出背景下均可辨认；keyEquivalent 字形无明显的错误字符替换（若 ⌃⌥R 渲染成怪异替代字符，按 §2.1-3 兜底回落内嵌 hint）。

---

## 四、平台必然差异清单（逐条理由）

1. **status item 图标形态：Mac 用文字「译」+ 胶囊角标，Windows 用彩色应用图标 + 像素合成角标**。理由：macOS 菜单栏惯例是单色/文字为主（彩色位图图标与系统菜单栏视觉冲突，且深浅色切换需要模板图）；Windows 托盘本就要求彩色图标（lib.rs:1519 default_window_icon）。Mac 把「红色圆底白字」语义移植为胶囊 image，而不是移植像素合成实现（tray_badge.rs 的 RGBA 点阵算法依赖固定图标底图）。
2. **Mac 菜单多出「翻译选中文本」「生词本」「检查更新」「使用引导」「检查权限」五项**。理由：Mac 的 status item 菜单是唯一常驻入口（无任务栏/托盘二选一问题），划词翻译这一头牌动作必须有可点击入口（Windows 走 Ctrl+Shift+Q 热键+浮窗，托盘刻意不列）；生词本与快速复习同为复习触点（Windows 其入口在阅读室内）；检查更新（Mac 无商店封禁、需手动入口）与检查权限（macOS TCC 辅助功能/屏幕录制是热键失效的第一现场，Windows 无此概念）是 Mac 生存必需项；使用引导 Windows 首启自动弹（lib.rs:1567）后无需托盘项，Mac 保留手动重看入口。
3. **快捷键提示形态必然不同**：Windows 托盘菜单无任何快捷键提示（accelerator=None，提示只在引导/设置）；Mac 按 HIG 菜单惯例右对齐展示 key equivalent。且**热键组合本身不同**：Windows Ctrl+Shift+Q/E/R（lib.rs:41-45），Mac 默认 ⌥Space / ⌃⌥Space / ⌃⌥R（HotKeyManager.swift:107-124，⌃⌥R 对齐 Windows Ctrl+Shift+R 语义、按 Mac 惯用修饰键落地，HotKeyManager.swift:119-124 注释明示）——文案与提示只能「形式对齐」（原生右对齐），不能逐字符对齐。
4. **退出项前多一条分隔线**：Windows 菜单尾部无分隔线（lib.rs:1514 quit 直接接在 settings 后），Mac 保留分隔线。理由：macOS 惯例用分隔线隔离破坏性/系统级动作防误触；托盘菜单项间距小、误触代价高（直接退出应用）。
5. **角标刷新机制**：Windows 为后台线程 30s 调度 + `set_icon`/`set_text` 句柄刷新（review_reminder.rs:126-154、spawn_scheduler）；Mac 为主 runloop Timer 30s + `onDueCountChange` 回调 + button image/title（ReviewTouchpointManager.swift:41-51、App.swift:499-515）。理由：AppKit UI 只能主线程触碰，Windows TrayIcon API 可跨线程；两端语义（30s 周期、变化才刷、生词变化即刷）已一致，机制差异是框架必然。
6. **「账号登录」已登录态的落点形式**：Windows 打开设置窗口并定位「账号」tab（settings_open_tab 双路径，lib.rs:637-648），Mac 打开设置窗并滚动到账号分区（`showAccountSection`，Settings.swift:1192）。分支语义两端一致（App.swift:665-673 ↔ lib.rs:1537-1552），差异仅在各自设置页的导航实现。
7. **角标数值上限同为 999 但呈现不同**：Windows 点阵白字直接叠在图标红圆上（tray_badge.rs:66-71），Mac 胶囊内白字。上限取 Windows 同值 999（不采用菜单栏常见的 99+），保持跨端数字语义一致。
