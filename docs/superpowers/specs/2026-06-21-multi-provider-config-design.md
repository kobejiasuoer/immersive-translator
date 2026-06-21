# 多 Provider 配置与按槽位存储 API Key 设计

- 日期：2026-06-21
- 范围：`immersive-translator-mac`（macOS App）
- 状态：已与用户确认四节设计，待写实现计划

## 1. 背景与问题

当前 `SettingsStore` 只有一组全局字段：

- `endpoint` / `model`（存 UserDefaults）
- `apiKey`（存 Keychain，account 写死为 `"apiKey"`，service = `local.immersive-translator.mvp`）

所有服务商共用这一组字段。`applyProviderPreset` 切换预设时只改 endpoint + model，不动 apiKey，导致：

- 用户在 DeepSeek 和 OpenAI 之间来回切换时，两家的 key 会互相覆盖
- 实际体验是"每次切换都要重新输入 key"

本次目标：页面上固定三个常驻切换（DeepSeek / 智谱 / OpenAI），每个常驻可自选模型名（内置候选 + 可自由填，并记住自定义历史），支持添加任意多个自定义提供商，每个提供商录入的 key 独立保存、切换时自动恢复。

## 2. 已确认的需求决策

1. 三家常驻（DeepSeek / 智谱 / OpenAI），模型名 **内置候选 + 可自由填**，每家各自记住上次模型；用户自由填过的模型作为可选历史层追加到候选里
2. 自定义提供商 **可加多个**（无上限）
3. 布局：**顶部三常驻卡片 + 下方自定义列表 + 详情区**，点中高亮，详情区同步刷新
4. 旧数据 **自动迁移** 到匹配的常驻，匹配不上的自动建一个"导入的提供商"自定义项
5. API Key 存储采用 **方案 A：按 providerId 分槽存 Keychain**
6. 全新安装默认选中 **DeepSeek**

## 3. 数据模型

### 3.1 ProviderProfile

替换全局 endpoint/model 字段，改为"多个 Provider 配置 + 当前选中"。

```swift
struct ProviderProfile: Identifiable, Codable, Equatable {
    let id: String              // 常驻恒定: "deepseek" / "zhipu" / "openai"; 自定义: UUID().uuidString
    var displayName: String     // "DeepSeek" / "我的本地 Ollama"
    var endpoint: String        // chat completions URL
    var model: String           // 当前选用的模型名
    var isBuiltin: Bool         // true = 三常驻(不可删); false = 自定义(可改名/删/改 endpoint)
    var customModels: [String]  // 该 provider 下用户自由填过的模型名(去重,最多记 8 条)
}
```

候选模型来源 = 内置候选（硬编码）+ 自定义历史（`customModels`），用计算属性合并去重：

```swift
extension ProviderProfile {
    // 硬编码厂商官方模型,不进 UserDefaults
    static let builtinModelCandidates: [String: [String]] = [
        "deepseek": ["deepseek-v4-flash", "deepseek-v4", "deepseek-reasoner"],
        "zhipu":    ["glm-5.2", "glm-5.2-air", "glm-4-flash"],
        "openai":   ["gpt-5.4-mini", "gpt-5.4", "gpt-4o-mini"],
        // 自定义 provider 无内置候选,customModels 是唯一来源
    ]

    // UI 下拉展示用 = 内置候选 + 自定义历史(去重,内置在前,保持插入顺序)
    var modelCandidates: [String] {
        let builtin = Self.builtinModelCandidates[id] ?? []
        var seen = Set<String>()
        var result: [String] = []
        for m in builtin + customModels {
            let trimmed = m.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }
}
```

### 3.2 三常驻初始默认值

endpoint/model 取自现有 `TranslationProviderPreset.all`（`Settings.swift:270`）的真实值：

```swift
static let builtinPresets: [ProviderProfile] = [
    .init(id: "deepseek", displayName: "DeepSeek",
          endpoint: "https://api.deepseek.com/chat/completions",
          model: "deepseek-v4-flash",
          isBuiltin: true, customModels: []),
    .init(id: "zhipu", displayName: "智谱",
          endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
          model: "glm-5.2",
          isBuiltin: true, customModels: []),
    .init(id: "openai", displayName: "OpenAI",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-5.4-mini",
          isBuiltin: true, customModels: []),
]
```

### 3.3 SettingsStore 变化

```swift
// 新增
@Published var providers: [ProviderProfile]     // 三常驻固定在前,之后是自定义(按创建时间)
@Published var activeProviderID: String         // 始终等于 providers 里某个 id

@Published var editingAPIKey: String = ""       // 编辑态,只活在内存和输入框里,失焦/切换时落盘

// 只读便捷访问
var activeProvider: ProviderProfile {
    providers.first { $0.id == activeProviderID } ?? providers[0]
}

// 废弃(删除):
// @Published var endpoint / model / apiKey
// @Published var apiKeyStorageError  → 改为按需记日志,不再作为持久 UI 状态
```

**调用方改为显式访问**，不保留计算属性兼容层：

- `TranslationClient`：`settingsStore.endpoint` → `settingsStore.activeProvider.endpoint`
- `TranslationClient`：`settingsStore.apiKey` → `KeychainStore.apiKey(for: settingsStore.activeProviderID)`
- `Onboarding`：同上
- `App.ensureConfigured`：同上

### 3.4 切换 / 落盘方法

```swift
extension SettingsStore {
    // 切换 provider: 先把当前编辑态 key 落盘到旧 id,再从新 id 加载
    func switchActiveProvider(to id: String) {
        guard id != activeProviderID, providers.contains(where: { $0.id == id }) else { return }
        persistEditingAPIKey(for: activeProviderID)
        activeProviderID = id
        editingAPIKey = KeychainStore.apiKey(for: id) ?? ""
        // 重置诊断状态,避免显示别家的测试结果
        providerDiagnostic = .idle
        providerPresetMessage = ""
    }

    // 失焦/切换/退出时落盘
    func persistEditingAPIKey(for id: String) {
        let trimmed = editingAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        KeychainStore.setAPIKey(trimmed, for: id)
    }

    // 用户在当前 provider 自由填了模型名 → 追加到 customModels
    func recordCustomModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let idx = providers.firstIndex(where: { $0.id == activeProviderID }) else { return }
        let builtin = ProviderProfile.builtinModelCandidates[providers[idx].id] ?? []
        guard !builtin.contains(trimmed),
              !providers[idx].customModels.contains(trimmed) else { return }
        providers[idx].customModels.append(trimmed)
        if providers[idx].customModels.count > 8 {
            providers[idx].customModels.removeFirst()
        }
    }
}
```

## 4. Keychain 按 id 分槽存储

### 4.1 KeychainStore 改造

现有 API 是 `setString(_:service:account:)` / `string(service:account:)`（会 throw）。在其之上增加按 providerId 分槽的便捷方法，底层复用现有实现：

```swift
enum KeychainStore {
    private static let service = "local.immersive-translator.mvp"
    static let legacyAccount = "apiKey"   // 旧的全局槽位,迁移用

    static func apiKey(for providerId: String) -> String? {
        guard let raw = try? string(service: service, account: accountKey(for: providerId)),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    static func setAPIKey(_ value: String, for providerId: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty {
                // 空 = 删除该 provider 的 key 槽,不留垃圾
                try delete(service: service, account: accountKey(for: providerId))
            } else {
                try setString(trimmed, service: service, account: accountKey(for: providerId))
            }
        } catch {
            DiagnosticLogger.log("keychain.write.failed providerId=\(providerId) error=\(error.localizedDescription)")
        }
    }

    static func deleteAPIKey(for providerId: String) {
        try? delete(service: service, account: accountKey(for: providerId))
    }

    private static func accountKey(for providerId: String) -> String {
        "apiKey.\(providerId)"
    }
}
```

> 注：`delete(service:account:)` 为新增的薄封装（现有 KeychainStore 未必有 delete，按 `SecItemDelete` 实现）。写失败时记日志、不抛给 UI。

### 4.2 Key 的 UI 数据流

- 输入框绑定 `editingAPIKey`
- 失焦时 `persistEditingAPIKey(for: activeProviderID)` 落盘
- 切换 provider 时由 `switchActiveProvider` 自动存旧读新
- 测试连接 / 验证翻译时用 `KeychainStore.apiKey(for: activeProviderID)` 取真实 key

## 5. 旧数据迁移

### 5.1 迁移逻辑

`SettingsStore.init` 末尾调用 `ProviderMigration.runIfNeeded`，靠 UserDefaults flag 守护只跑一次：

```swift
struct ProviderMigration {
    private static let flagKey = "didMigrateProvidersV1"

    static func runIfNeeded(providers: inout [ProviderProfile],
                            activeProviderID: inout String) {
        guard !UserDefaults.standard.bool(forKey: flagKey) else { return }

        let legacyEndpoint = UserDefaults.standard.string(forKey: "endpoint") ?? ""
        let legacyModel    = UserDefaults.standard.string(forKey: "model") ?? ""
        let legacyKey      = (try? KeychainStore.string(service: KeychainStore.service,
                                                        account: KeychainStore.legacyAccount)) ?? ""

        // 1. 优先按 endpoint 匹配三常驻
        if let idx = providers.firstIndex(where: { $0.isBuiltin && matches($0.endpoint, legacyEndpoint) }) {
            if !legacyEndpoint.isEmpty { providers[idx].endpoint = legacyEndpoint }
            if !legacyModel.isEmpty    { providers[idx].model = legacyModel }
            activeProviderID = providers[idx].id
        } else if !legacyEndpoint.isEmpty {
            // 2. 匹配不上但旧 endpoint 有效 → 建一个"导入的提供商"自定义项
            let imported = ProviderProfile(
                id: UUID().uuidString,
                displayName: "导入的提供商",
                endpoint: legacyEndpoint,
                model: legacyModel.isEmpty ? "gpt-3.5-turbo" : legacyModel,
                isBuiltin: false,
                customModels: legacyModel.isEmpty ? [] : [legacyModel]
            )
            providers.append(imported)
            activeProviderID = imported.id
        }
        // else: 旧 endpoint 空(全新安装或没配过) → 不动,保持 activeProviderID = "deepseek"

        // 3. 迁移旧 key 到新槽
        if !legacyKey.isEmpty {
            KeychainStore.setAPIKey(legacyKey, for: activeProviderID)
        }

        // 4. 置 flag(无论有没有旧数据,只跑一次)
        UserDefaults.standard.set(true, forKey: flagKey)
        // 旧全局 Keychain 槽(account=apiKey)保留不删,避免删除时引发其它假设
    }

    // 归一化比较 host: 小写、去 scheme、去末尾斜杠、去 /v1/chat/completions 等路径后缀
    private static func matches(_ a: String, _ b: String) -> Bool {
        normalizedHost(a) == normalizedHost(b) && !normalizedHost(a).isEmpty
    }

    private static func normalizedHost(_ url: String) -> String {
        var s = url.lowercased()
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) { s.removeFirst(prefix.count) }
        for suffix in ["/chat/completions", "/v1/chat/completions", "/api/paas/v4/chat/completions"] where s.hasSuffix(suffix) { s.removeLast(suffix.count) }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
```

### 5.2 迁移场景对照

| 场景 | 行为 |
|------|------|
| 全新安装（无任何旧数据） | flag 置上，providers = 三常驻默认，active = "deepseek" |
| 旧用户配过 OpenAI | 匹配到 openai 常驻，endpoint/model/key 全迁过去，active = "openai" |
| 旧用户配过本地 Ollama | 匹配不上常驻，建"导入的提供商"自定义项，key 为空（本地不需要） |
| 旧用户配过第三方（如月之暗面） | 建自定义项，key 迁过去 |
| 迁移后再次升级 | flag 已置，不会二次迁移 |

幂等性：单步均为内存操作 + 一次 Keychain 写，不会半途崩溃；即使第一次崩溃，下次启动 flag 未置会重跑，旧数据仍在。

## 6. UI 布局与交互

### 6.1 整体结构

```
┌─────────────────────────────────────────────────┐
│ 服务商                                            │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐             │
│ │ DeepSeek│ │  智谱   │ │ OpenAI  │             │
│ │ ✓ 当前  │ │         │ │         │             │
│ └─────────┘ └─────────┘ └─────────┘             │
│                                                 │
│ 自定义                                           │
│ ┌───────────────────────────────────────────┐   │
│ │ ● Ollama 本地 · llama3.2            [×]   │   │
│ │ ○ 月之暗面 · moonshot-v1-8k          [×]   │   │
│ └───────────────────────────────────────────┘   │
│ [+ 添加自定义提供商]                              │
├─────────────────────────────────────────────────┤
│ 当前: DeepSeek                                   │
│                                                 │
│ 接口地址  [https://api.deepseek.com/chat/comp...]│
│ 模型      [deepseek-v4-flash            ▼]      │
│ API Key   [••••••••••••••••]          [测试连接] │
│                                                 │
│ [测试当前接口]  [验证翻译请求]                    │
└─────────────────────────────────────────────────┘
```

### 6.2 交互

**1. 选中提供商**：点常驻卡片或自定义行 → `switchActiveProvider(to:)`，UI 高亮跟随 `activeProviderID`。

**2. 模型下拉**：
- 常驻：内置候选 + customModels（去重）+ 分隔线 + "自定义..."
- 自定义 provider：customModels + 分隔线 + "自定义..."
- 选"自定义..."弹小输入框 → 确认后 `activeProvider.model = 输入值` 并 `recordCustomModel(输入值)`

**3. 自定义提供商增删改**：
- 添加：点"+ 添加自定义提供商" → 内联最小表单（名称/接口/模型）→ 确认后 append 并自动选中，进详情区填 key
- 删除：自定义行右侧 `[×]` → 二次确认 → `deleteCustomProvider(id)`
- 改名/改 endpoint：详情区字段可编辑（仅自定义；常驻名称锁定，endpoint 可改但不可删）

```swift
func deleteCustomProvider(_ id: String) {
    guard let target = providers.first(where: { $0.id == id }), !target.isBuiltin else { return }
    providers.removeAll { $0.id == id }
    KeychainStore.deleteAPIKey(for: id)
    if activeProviderID == id {
        switchActiveProvider(to: ProviderProfile.builtinPresets[0].id)  // 回退 deepseek
    }
}
```

**4. API Key 输入框**：绑定 `editingAPIKey`，失焦落盘；测试连接用 `KeychainStore.apiKey(for: activeProviderID)`。

### 6.3 对现有代码的改动边界

| 现有代码 | 改动 |
|---------|------|
| `TranslationProviderPreset` + `all` | 改为 `ProviderProfile.builtinPresets` 初始化数据源（保留 detail/latencyHint 用于卡片说明） |
| `providerPresetCard` + `applyProviderPreset` | 替换为"选 provider"逻辑（选中而非套用预设） |
| `endpoint` / `model` / `apiKey` 三个 `@Published` | 删除，改为 `providers` + `activeProviderID` + `editingAPIKey` |
| `providerPresetMessage` / `providerDiagnostic` | 保留，切换时由 `switchActiveProvider` 重置 |
| `TranslationClient` / `Onboarding` / `App.ensureConfigured` 对 endpoint/model/apiKey 的读取 | 改为 `activeProvider.*` / `KeychainStore.apiKey(for:)` |
| `TranslationClient.requiresAPIKey(for:)` | 不变，仍按 endpoint 推导，详情区据此决定 key 是否必填 |

## 7. 错误处理与边界

**1. Keychain 读失败**：`apiKey(for:)` 返回 nil → 视为未配置 key，详情区输入框显示空，翻译时走现有 `TranslationClientError.missingAPIKey` 错误链路，不额外弹窗。

**2. Keychain 写失败**：`setAPIKey` 内部捕获、记 `DiagnosticLogger.log`，不抛给 UI；`editingAPIKey` 内存值仍在，下次失焦/切换再试。

**3. 迁移失败**：单步为内存操作 + 一次 Keychain 写，不会半途崩溃；flag 未置时下次启动重跑；旧数据（UserDefaults + 旧 Keychain 槽）都未删除，可安全重跑。

**4. activeProviderID 指向不存在的 provider**：`activeProvider` 计算属性 fallback 到 `providers[0]`；`init` 兜底保证 providers 永远至少有三常驻。

**5. providers 数组兜底**（init 中）：
```swift
init() {
    providers = decodeFromUserDefaults() ?? ProviderProfile.builtinPresets
    if !providers.contains(where: { $0.isBuiltin }) {
        providers = ProviderProfile.builtinPresets + providers
    }
    if !providers.contains(where: { $0.id == activeProviderID }) {
        activeProviderID = ProviderProfile.builtinPresets[0].id
    }
    ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeProviderID)
    editingAPIKey = KeychainStore.apiKey(for: activeProviderID) ?? ""
}
```

**6. 删除 active 自定义项**：`deleteCustomProvider` 内同步删 Keychain 槽，并回退 active 到 deepseek。

**7. 并发**：`switchActiveProvider` 为 `@MainActor` 同步执行，Keychain 的 `SecItem*` 本身线程安全，无竞态。

**8. customModels 去重与上限**：`recordCustomModel` 去重（对比内置候选 + 已有 customModels），超 8 条淘汰最旧。

## 8. 不做的事（YAGNI）

- 不做 provider 的导入/导出
- 不做 provider 排序拖拽
- 不做 key 有效性的离线校验（仍依赖现有"测试连接"流程）
- 不删除旧全局 Keychain 槽（account=apiKey），保留以免引发其它假设
- 不引入新的持久化框架，仍用 UserDefaults + Keychain

## 9. 验收标准

1. 在 DeepSeek 录入 key → 切到 OpenAI 录入另一个 key → 切回 DeepSeek，key 输入框自动恢复 DeepSeek 的 key，无需重输
2. 三常驻各自能从下拉选内置模型，也能自由填模型名，自由填过的模型出现在下次下拉里
3. 能添加多个自定义提供商，每个独立保存接口/模型/key，切换互不干扰
4. 删除自定义提供商时，其 key 同步从 Keychain 清除
5. 旧版本用户升级后：已配置的 endpoint/model/key 自动迁移到匹配的常驻（或建"导入的提供商"），不丢数据
6. 全新安装默认选中 DeepSeek
7. 现有翻译功能、Onboarding、ensureConfigured 在改造后行为不变
