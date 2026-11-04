# 基线杂项修复 · Mac 1:1 移植规格（misc）

勘察日期：2026-11-01。勘察范围：关于页隐私政策入口（对齐 Windows commit `e42018f`）、版本号 0.1.1→0.11.1、修复 `testSaveSnapshotDirtyDetectionAndHotKeyReregistrationGate` 基线污染、修复 `ClipboardReader.swift:70` AX 强转。所有锚点均在本机实证（读源码 + 实际运行测试复现失败）。

---

## 1. Windows 行为规格

### 1.1 关于页隐私政策入口（commit e42018f）

**功能定位**：Store 政策 10.5.1 要求应用内可访问隐私政策。实现为「关于」页第四张卡：默认收起只显示标题摘要，点击按钮展开全文，完全离线（无网络请求、无本地持久化）。

**入口与交互流**：
1. 设置窗 → 页签「关于」（`immersive-translator-windows/src/views/Settings.tsx:75` 定义 tab，`:84` TABS 项 `{ id: "about", label: "关于", icon: IconInfo }`）。
2. about-grid 卡序（`Settings.tsx:1202-1326`）：①应用更新（1203-1236）→ ②启动与引导（1238-1277）→ ③离线能力（1279-1323）→ ④**PrivacyPolicyCard（1325）**。危险区紧随其后（1328-1338）。
3. 组件实现 `immersive-translator-windows/src/views/PrivacyPolicyCard.tsx:10-39`：唯一状态 `const [open, setOpen] = useState(false)`（**内存态，不落盘**，组件卸载/重开设置即回默认收起）。
   - 收起态：仅标题 + 副标题 + 按钮「查看完整政策」。
   - 点击按钮：`setOpen(!open)`；展开态渲染 `.about-privacy-body`（导语段 + 六节 `<p><strong>{title}：</strong>{body}</p>` + 联系方式段），按钮文案翻转为「收起」。
   - 再点收起：正文整体从 DOM 移除（条件渲染，非 CSS 隐藏）。

**UI 状态与文案（原样抄录，供逐字复刻）**：

| 位置 | 文案 |
|---|---|
| 卡标题（h3） | `隐私政策` |
| 卡副标题（p） | `数据怎么收集、怎么使用（更新于 2026年10月26日）`（日期为常量 `PRIVACY_POLICY_UPDATED_AT` 插值） |
| 按钮（收起态） | `查看完整政策` |
| 按钮（展开态） | `收起` |
| 正文第一段（导语） | `「沉浸口语」（以下简称“本应用”）是面向语言学习者的桌面应用。我们高度重视你的隐私，说明如下：` |
| 六节标题 | `一、麦克风音频` / `二、文本内容` / `三、屏幕截图（OCR）` / `四、本地存储` / `五、账号与订阅` / `六、你的权利`（渲染时标题后接全角冒号 `：` 再接正文） |
| 末段（联系方式） | `联系我们：https://github.com/kobejiasuoer/immersive-translator/issues` |

六节正文逐字（源：`immersive-translator-windows/src/views/privacyPolicy.ts:13-38`，本轮与 Mac 均不得改动）：

- 一、麦克风音频：`使用口语跟读、发音评测等功能时，本应用会请求麦克风权限以采集音频，仅用于语音识别与发音评测，不用于广告或与本应用功能无关的用途。`
- 二、文本内容：`使用翻译、AI 口语对话等功能时，你所提交的文本会通过加密网络连接发送至我们及第三方 AI 服务提供商（如大语言模型、机器翻译与语音合成服务商）进行处理，以生成学习内容与反馈。`
- 三、屏幕截图（OCR）：`使用截图取词或屏幕翻译功能时，截图仅在本地或本次请求中用于识别文字，处理后即行丢弃。`
- 四、本地存储：`生词本、阅读记录、练习记录与偏好设置默认保存在你的设备本地。仅在你明确开启同步或备份功能时，相关数据才会按你的指示上传。`
- 五、账号与订阅：`如你选择登录账号或购买订阅，我们会按服务需要处理你的邮箱、订单等必要信息，用于提供与保障服务。`
- 六、你的权利：`我们不会出售你的个人信息。你可随时通过卸载应用删除本地数据，或通过下方渠道联系我们删除与账号相关的数据。`

**视觉规格**（`immersive-translator-windows/src/styles.css:4923-4943`）：正文容器 `.about-privacy-body` —— 上边距间距 8px 网格、外下边距 10px、内边距 10px 12px、1px 边框（rgba(148,163,184,0.22)）、圆角 8px、**最大高度 260px + overflow-y:auto**、字号 12px、行高 1.7；段间距 0；节标题字重 600。按钮为 `btn btn-secondary btn-sm`（次级小按钮）。

**数据结构与本地存储**：无。单布尔内存状态；文案为编译期常量（`privacyPolicy.ts` 导出 `PRIVACY_POLICY_UPDATED_AT` / `PRIVACY_POLICY_INTRO` / `PRIVACY_SECTIONS: PrivacySection[]{title, body}×6` / `PRIVACY_CONTACT_TEXT`）。

**网络端点与请求/响应契约**：无。纯离线组件，不涉及 `immersive-translator-server/`、`contracts/`、`packages/`。联系方式 URL 仅作为文本展示，Windows 端**未做可点击链接**（普通 `<p>` 文本，webview 内可选中复制）。

**边界与错误处理**：无错误路径（纯静态内容 + 本地状态翻转）；展开态不影响其余卡片；不写入任何持久化。

**相关 Windows 单测及行为向量**（`immersive-translator-windows/src/views/PrivacyPolicyCard.test.tsx:8-42`，三个用例）：
1. 「默认收起：只有摘要，不含正文」：`.about-privacy h3` 文本 === `隐私政策`；`.about-privacy-body` 为 null；存在按钮「查看完整政策」。
2. 「展开：六节正文 + 联系方式都在，按钮变收起」：点击「查看完整政策」后 `.about-privacy-body` 存在；对每个 section 断言 `textContent` 同时包含 `s.title` 与 `s.body.slice(0, 20)`；包含 `github.com/kobejiasuoer/immersive-translator/issues`；存在按钮「收起」。
3. 「再点收起：正文移除」：展开后点「收起」，`.about-privacy-body` 回到 null。

**文案同步约束**（AGENTS.md + `docs/privacy-policy.md:54`）：政策文本三处同口径——应用内 `src/views/privacyPolicy.ts`、仓库页 `docs/privacy-policy.md`、Microsoft Store 提交文本。本轮只加入口、不改文本；Mac 落地后副本变为四处（见 §4 风险）。

### 1.2 版本号 0.11.1（Windows 基准）

- 单一来源两处互为校验：`immersive-translator-windows/package.json:3` `"version": "0.11.1"`；`immersive-translator-windows/src-tauri/tauri.conf.json:4` `"version": "0.11.1"`。
- 关于页展示：`Settings.tsx:110` `useState("")` → `:128` `getVersion().then(setAppVersion)`（Tauri 注入 tauri.conf.json 版本）；`:1209` 渲染 `v{appVersion || "…"}`。
- 版本比较（更新检查）为数字分段比较，`0.11.1 > 0.1.1` 判定正确（Mac 侧 `UpdateChecker.swift:207-223` 同为数字分段比较，无字符串误序风险）。

### 1.3 取词 AX/UIA 兜底的防御式失败（Windows 基线，对应 Mac `as!` 缺陷）

Windows UIA 兜底 `immersive-translator-windows/src-tauri/src/uia.rs:162-200`：所有元素获取/属性读取均 `if let Ok(...)` / `map_err` 降级——焦点元素拿不到就换 `ElementFromHandle`，再逐 TextPattern 子元素，全失败才返回 `Err`。**任何一步失败都不 panic**。这是 Mac AX 兜底应满足的行为基线：元素获取失败 → 返回 nil → 走 `.copyFailed` 错误文案，绝不崩溃。

---

## 2. Mac 落点设计

### 2.1 应新建/修改文件清单

| 文件 | 动作 | 内容与证据 |
|---|---|---|
| `immersive-translator-mac/Sources/ImmersiveTranslator/PrivacyPolicyContent.swift` | 新建 | 纯值类型，无 UI 依赖：`enum PrivacyPolicyContent { static let updatedAt = "2026年10月26日"; static let intro = …; struct Section { let title, body: String }; static let sections: [Section]（六节，逐字抄 §1.1）; static let contact = "联系我们：https://github.com/kobejiasuoer/immersive-translator/issues" }`；另加可测小值类型 `struct PrivacyPolicyDisclosure: Equatable { var isOpen = false; mutating func toggle(); var actionTitle: String { isOpen ? "收起" : "查看完整政策" } }` |
| `immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift` | 修改 | ①`aboutSection`（`Settings.swift:1754-1787`）在「权限」卡（1765-1783）之后、`dangerZone`（1785）之前插入隐私卡视图；②新增 `@State private var privacyDisclosure = PrivacyPolicyDisclosure()` 与 `aboutPrivacyCard` 私有视图 |
| `immersive-translator-mac/Tests/ImmersiveTranslatorTests/PrivacyPolicyContentTests.swift` | 新建 | 见 §2.3 测试清单 1-2 |
| `immersive-translator-mac/Tests/ImmersiveTranslatorTests/SettingsDangerZoneTests.swift` | 修改 | 基线归零修复，见 §2.4 |
| `immersive-translator-mac/Sources/ImmersiveTranslator/ClipboardReader.swift` | 修改 | `:70` 强转改防御式，见 §2.5 |
| `immersive-translator-mac/scripts/build_app.sh` | 修改 | `:6` `APP_VERSION="${APP_VERSION:-0.1.1}"` → `0.11.1`（该值经 `:102/:133` 转义后写入 `dist/ImmersiveTranslator.app/Contents/Info.plist` 的 `CFBundleShortVersionString`，`:157-158`） |
| `immersive-translator-mac/scripts/package_release.sh` | 修改 | `:6` `VERSION="${1:-${APP_VERSION:-0.1.1}}"` → `0.11.1` |

不改：`docs/privacy-policy.md`、Windows `privacyPolicy.ts`（政策文本不动）。`dist/` 下两个 Info.plist 的 0.1.1 是构建产物，重新打包自动刷新。`README.md` 中 `0.1.1`（如 `:319,325,364,373-374` 等）为示例文档，非版本来源，本轮不动（可选后续统一示例）。

### 2.2 与 Mac 既有架构的衔接

- **Settings 分区体系**：沿用 `SettingsSection`/`SettingsNavGroup`（`Settings.swift:896-917`）——隐私入口不新增分区，落位「关于」分区内，`testSettingsSectionsMatchWindowsIA`（SettingsDangerZoneTests.swift:142-163）七分区断言不受影响。
- **卡片样式**：复用 `groupCard(_:hint:content:)`（`Settings.swift:1482-1507`，15pt semibold 标题 + footnote 灰副标题 + 0.04 背景圆角 10 卡体），Windows `.group-card` 的 Mac 等价物：`groupCard("隐私政策", hint: "数据怎么收集、怎么使用（更新于 \(PrivacyPolicyContent.updatedAt)）")`。
- **正文容器**：对齐 `.about-privacy-body` 视觉——`ScrollView { VStack(alignment: .leading, spacing: 8) { … } }` `.frame(maxHeight: 260)` `.padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))` `.background(Color.primary.opacity(0.02), in: RoundedRectangle(cornerRadius: 8))` `.overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.22), lineWidth: 1))` `.font(.system(size: 12))` `.lineSpacing(6)`；六节用 `Text(.init("**\(s.title)：**\(s.body)"))`（本地化 Markdown 加粗）或 `HStack(alignment: .firstTextBaseline)` 上「标题：」semibold(600)+正文拼接，保证文本内容逐字等于 Windows 拼接结果；末段联系方式 `Text(PrivacyPolicyContent.contact).textSelection(.enabled)`（与 Windows 可选中复制的 `<p>` 等价，**不做可点击链接**，保持 1:1）。
- **按钮**：对齐「权限」卡按钮写法（`Settings.swift:1823-1829` 的 `HStack + Spacer + Button … .controlSize(.small)`）：`Button(privacyDisclosure.actionTitle) { privacyDisclosure.toggle() }.controlSize(.small)`，置于卡体底部右对齐（对应 Windows `about-release-actions` 容器）。
- **状态语义**：`@State` 内存态等价 Windows `useState(false)`——不落 UserDefaults、重开设置窗回默认收起（与 ReaderSettings 等持久化体系无交集，刻意不接入）。
- **版本展示链**：不改 `aboutVersionText`（`Settings.swift:2167-2170` 读 `CFBundleShortVersionString`，swift run 显示「开发版（未打包）」为既有行为）；打包后经 build_app.sh 注入 0.11.1，关于页显示 `v0.11.1`。更新链 `UpdateChecker.swift:194-238` 数字分段比较，0.11.1>0.1.1 判定正确，无需改动。CI 发版版本来自 tag/输入（`.github/workflows/release.yml:80-100`），不依赖脚本默认值，无冲突。

### 2.3 需补的 swift 测试清单（与 Windows 单测行为向量对齐）

1. `PrivacyPolicyContentTests`·文案保真：断言 `updatedAt == "2026年10月26日"`、`intro`、六节 `sections.map(\.title)` 与 `sections.map(\.body)`、`contact` 与 §1.1 逐字一致且节数 == 6（对齐 Windows 向量「六节正文 + 联系方式都在」PrivacyPolicyCard.test.tsx:18-31）。
2. `PrivacyPolicyContentTests`·披露状态向量：`PrivacyPolicyDisclosure()` 默认 `isOpen == false` 且 `actionTitle == "查看完整政策"`；`toggle()` 后 `isOpen == true` 且 `actionTitle == "收起"`；再 `toggle()` 回 false（对齐 Windows 用例 1/3：默认收起、再点收起移除正文；SwiftUI 条件渲染 `if privacyDisclosure.isOpen` 由视图代码保证，值类型测试覆盖状态机）。
3. `SettingsDangerZoneTests.testSaveSnapshotDirtyDetectionAndHotKeyReregistrationGate` 修复后必须保持原四组向量（SettingsDangerZoneTests.swift:119/123/124-127/130-133）：未改动非脏、改术语表脏且不触发热键闸门、改热键脏且闸门放行、保存后回非脏。
4. 回归：`swift test`（全套）通过，特别是 `testResetToDefaultsRestoresFactoryValuesAndClearsProviderKeys`、`testSettingsSectionsMatchWindowsIA` 不回归。

### 2.4 测试基线污染修复（已实证复现）

**复现证据**：在 `immersive-translator-mac/` 执行 `swift test --filter SettingsDangerZoneTests` →
`SettingsDangerZoneTests.swift:123: error: … XCTAssertNotEqual failed: ("…targetLanguage: \"日本語\" … glossaryText: \"hello = 你好\" …") is equal to ("…") - 术语表改动应判定为脏`（4 tests, 1 failure）。

**机理**（全部实证）：
- `SettingsStore.init()` 从 UserDefaults 读全部字段（`Settings.swift:141-152`），且 `:132-134` **无条件回写** `providers`/`activeProviderID`，`:135-137` 迁移后写 `didMigrateProvidersV1/V2` 标志（`Sources/ProviderCore/ProviderMigration.swift:135-138`）。
- swift-test 进程域持久化于 `~/Library/Preferences/com.apple.dt.xctest.tool.plist`，`defaults read com.apple.dt.xctest.tool` 实测内容即污染基线：`targetLanguage=日本語`、`translationDirection=fixedTarget`、`ocrMode=fast`、`ocrLanguagePreset=japanese`、`enableStreamingTranslation=0`、`dictCardAuto=0`、`customPrompt=自然口语风格`、`glossaryText=hello = 你好`、`activeProviderID=immersive-cloud`、`providers`(含非内置 immersive-cloud 的 blob)、`didMigrateProvidersV1/V2=1`——正是 `testResetToDefaults…`（SettingsDangerZoneTests.swift:61-83）脏化的字段集（历史上某次运行未还原即退出，写入被 cfprefsd 持久化）。
- 现有 `DefaultsRestoreScope`（SettingsDangerZoneTests.swift:186-203）只在**退出时还原进入时快照**——污染基线被原样记录又原样还原，于是每次进程启动 `SettingsStore()` 都以脏值构造，`snapshot` 生来即脏，第 122 行 `store.glossaryText = "hello = 你好"` 成为空操作，第 123 行 `XCTAssertNotEqual` 永久失败。
- 附带实证：该 plist 还含 `readerGlobalSettings`（来源 `Sources/ImmersiveTranslator/ReaderStore.swift:389`，对应测试无还原 scope）——同类隐患，本轮不在范围，仅记录。

**修法（按既定方向「用例前归零再建快照」）**：在 `testSaveSnapshotDirtyDetectionAndHotKeyReregistrationGate` 内，`DefaultsRestoreScope` 建立（保留其还原契约，不影响同进程其它用例）之后、`SettingsStore()` 之前，把 `Self.settingsStoreKeys` 全部 `UserDefaults.standard.removeObject(forKey:)`，并追加清除 `ProviderMigration.legacyEndpointKey`/`legacyModelKey`（`"endpoint"`/`"model"`，防遗留旧值触发随机 UUID「导入的提供商」注入，`ProviderMigration.swift:161-170`）；`didMigrateProvidersV1/V2` 不清（缺失时迁移对无 legacy endpoint 的基线是确定性空操作并幂等补旗）。建议抽 `private static func zeroSettingsDefaults()` 供 `testResetToDefaults…` 同样调用（非必需——该用例本次运行在污染基线下仍通过，但其确定性同样受益）。

### 2.5 取词 AX 强转修复

`Sources/ImmersiveTranslator/ClipboardReader.swift:70`：`let element = focusedElement as! AXUIElement?` → `let element = focusedElement as? AXUIElement`（`guard …, let element = focusedElement as? AXUIElement else { return nil }`）。行为对齐 Windows uia.rs 防御基线（§1.3）：属性值非 AXUIElement 时返回 nil 而非崩溃；调用方 `readSelectedText()`（ClipboardReader.swift:55-58）继续走 `.copyFailed` 错误文案路径（`ClipboardReader.swift:12-13`），无需改动。说明：该分支依赖真实 AX 运行时返回异常 CFTypeRef，单测无法伪造，**无可行的独立单测**，验收以编译 + 全套测试不回归 + 代码评审为准（如实声明，不虚构测试）。

---

## 3. 逐条验收清单

1. Mac「设置 → 关于」出现「隐私政策」卡，位于权限卡之后、危险区（恢复默认设置）之前。
2. 卡标题逐字为「隐私政策」，副标题逐字为「数据怎么收集、怎么使用（更新于 2026年10月26日）」。
3. 默认收起：不显示正文，按钮文案为「查看完整政策」。
4. 点击「查看完整政策」：展开导语 + 六节全文 + 联系方式段，按钮变「收起」。
5. 再点「收起」：正文移除，按钮回「查看完整政策」；关闭重开设置窗后回到默认收起（内存态，无持久化）。
6. 新增单测逐字段断言六节标题/正文、导语、更新日期、联系 URL 与 Windows `privacyPolicy.ts` 逐字一致且节数为 6。
7. 政策文本零改动：`docs/privacy-policy.md` 与 `immersive-translator-windows/src/views/privacyPolicy.ts` 本轮无 diff。
8. 正文容器对齐 `.about-privacy-body` 规格：字号 12、内边距 10/12、圆角 8、最大高度 260 可滚动。
9. `scripts/build_app.sh:6` 与 `scripts/package_release.sh:6` 默认版本改为 0.11.1。
10. 打包后 `dist/ImmersiveTranslator.app/Contents/Info.plist` 的 `CFBundleShortVersionString == "0.11.1"`，关于页显示 `v0.11.1`（`swift run` 开发态仍显示「开发版（未打包）」，属既有行为）。
11. `swift test --filter SettingsDangerZoneTests` 在不手工清理 `~/Library/Preferences/com.apple.dt.xctest.tool.plist` 的前提下 4/4 通过（含原四组脏检测/热键闸门向量）。
12. `ClipboardReader.swift:70` 不再含 `as!` 强转（改为 `as?` 防御式），`swift build` 通过且全套 `swift test` 无回归。
13. `swift test` 全套通过（含新增 PrivacyPolicyContentTests）。
14. `testSettingsSectionsMatchWindowsIA` 断言不变且通过（七分区序列不受本改动影响）。

---

## 4. 平台差异清单（仅收录必然差异）

1. **控件与卡片渲染体系**：Windows 用 CSS（`.group-card`/`.btn btn-secondary btn-sm`/`.about-privacy-body`），Mac 用 SwiftUI `groupCard`（Settings.swift:1482-1507）+ `Button.controlSize(.small)`。理由：窗口与控件体系不同；要求视觉参数（字号 12、圆角 8、最大高 260、次级小按钮）与文案、交互语义 1:1，像素级渲染交给各自控件体系。
2. **关于页既有卡面差异**：Windows 关于页含「离线能力（PaddleOCR 模型下载）」卡（Settings.tsx:1279-1323），Mac 无该功能卡而以「权限」卡（Settings.swift:1765-1783）存在于同一位置区间。理由：两端功能面既有现状（Mac OCR 走系统 Vision，无模型下载）；本规格仅约束隐私卡作为「危险区之前的最后一张内容卡」，与 Windows 相对位置一致。
3. **版本号单一来源机制**：Windows 在 `package.json` + `tauri.conf.json`（Tauri 构建注入 `getVersion()`）；Mac 无包管理器版本文件，版本由打包脚本 `APP_VERSION` 注入 `Info.plist`（build_app.sh:6→157-158）。理由：打包体系不同；验收以「运行时关于页显示 v0.11.1」为等价判据。
4. **测试框架能力**：Windows vitest+jsdom 可直接渲染组件断言 DOM；Mac XCTest 无法宿主渲染 SwiftUI 视图。理由：测试基建差异；补偿方式为把文案抽成纯常量、披露状态抽成纯值类型，行为向量（默认收起/展开/收起）逐条对齐 Windows 三用例。
5. **开发态版本显示**：Mac `swift run` 无 Info.plist，显示「开发版（未打包）」（Settings.swift:2167-2170）；Windows dev 由 Tauri 始终有版本号。理由：SPM 可执行无 bundle 元数据；打包后行为一致。

除上述外不许差异：文案逐字、六节顺序与内容、按钮二态文案、默认收起语义、无持久化、无网络请求、版本数值 0.11.1、测试行为向量。

---

## 附：勘察证据索引

- Windows：`git show e42018f`（6 文件 diff 全文）；`Settings.tsx:75,84,110,128,1194-1340`；`PrivacyPolicyCard.tsx:1-39`；`privacyPolicy.ts:1-41`；`PrivacyPolicyCard.test.tsx:1-42`；`styles.css:4923-4943`；`package.json:3`、`tauri.conf.json:4`（grep `"version"`）；`uia.rs:162-200,218`；`docs/privacy-policy.md:1-54`。
- Mac：`Settings.swift:75-166,294-347,896-917,921-962,1482-1507,1754-1800,2167-2170`；`ClipboardReader.swift:64-81`（:70 强转）；`scripts/build_app.sh:6`；`scripts/package_release.sh:6`；`SettingsDangerZoneTests.swift:53-138,168-203`；`ProviderMigration.swift:90-138`；`UpdateChecker.swift:194-238`；`ReaderStore.swift:389`；`.github/workflows/release.yml:9-14,80-100`。
- 运行检查：`cd immersive-translator-mac && swift test --filter SettingsDangerZoneTests` → 4 tests / 1 failure（:123 XCTAssertNotEqual，快照生来即脏）；`defaults read com.apple.dt.xctest.tool` → 污染基线字段集（见 §2.4）。未运行：Mac 全套 `swift test`（本轮只勘察，未改代码）、Windows `npx vitest run`（只读约束）。
