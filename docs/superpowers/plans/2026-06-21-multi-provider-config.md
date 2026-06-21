# 多 Provider 配置与按槽位存储 API Key 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单一全局 endpoint/model/apiKey 升级为多个 Provider 配置（三常驻 DeepSeek/智谱/OpenAI + 任意自定义），每个 Provider 的 API Key 按 providerId 分槽存 Keychain，切换时自动恢复。

**Architecture:** 把可测试的纯逻辑（ProviderProfile 数据模型、模型候选合并、迁移 host 匹配）拆到新 library target `ProviderCore`；SettingsStore（含 @Published/SwiftUI 依赖）和 UI 留在 executable。KeychainStore 加按 providerId 分槽的便捷方法，底层复用现有 `string/setString/delete`。旧数据一次性迁移，靠 UserDefaults flag 守护。

**Tech Stack:** Swift 6.2.3 / SwiftPM / SwiftUI / AppKit / Keychain Services（Security.framework）/ XCTest

**Spec:** `docs/superpowers/specs/2026-06-21-multi-provider-config-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `Sources/ProviderCore/ProviderProfile.swift` | 数据模型 + 内置候选 + modelCandidates 合并 | 新建（library） |
| `Sources/ProviderCore/ProviderMigration.swift` | 旧数据迁移 + host 归一化匹配 | 新建（library） |
| `Sources/ProviderCore/DiagnosticLogger.swift` | 纯 Foundation 日志（供迁移记录） | 新建（library，从原 executable 复制） |
| `Tests/ProviderCoreTests/ProviderProfileTests.swift` | modelCandidates / recordCustomModel 测试 | 新建 |
| `Tests/ProviderCoreTests/ProviderMigrationTests.swift` | normalizedHost / 迁移分支测试 | 新建 |
| `Package.swift` | 增加 ProviderCore library target + testTarget | 修改 |
| `Sources/ImmersiveTranslator/KeychainStore.swift` | 加 apiKey(for:)/setAPIKey/deleteAPIKey 便捷方法 | 修改 |
| `Sources/ImmersiveTranslator/Settings.swift` | 删除全局 endpoint/model/apiKey；加 providers/activeProviderID/editingAPIKey + 切换/落盘方法；改 init 加迁移 | 修改 |
| `Sources/ImmersiveTranslator/Settings.swift` UI 部分 | providerPresetCard/applyProviderPreset → 新的选 provider UI | 修改 |
| `Sources/ImmersiveTranslator/TranslationClient.swift` | 读 endpoint/model/apiKey 改为 activeProvider.* / KeychainStore.apiKey(for:) | 修改 |
| `Sources/ImmersiveTranslator/Onboarding.swift` | 同上，改读法 | 修改 |
| `Sources/ImmersiveTranslator/App.swift` | ensureConfigured 改读法 | 修改 |

**关于 DiagnosticLogger 复制：** 现有 `Sources/ImmersiveTranslator/DiagnosticLogger.swift` 保留不动（executable 还在用）。library 里放一份同名文件，因为 ProviderCore 依赖日志但不应反向依赖 executable。两份内容相同。

---

## Task 1: 搭建 ProviderCore library target 和 testTarget

**Files:**
- Modify: `immersive-translator-mac/Package.swift`
- Create: `immersive-translator-mac/Sources/ProviderCore/ProviderProfile.swift`（占位）
- Create: `immersive-translator-mac/Sources/ProviderCore/ProviderMigration.swift`（占位）
- Create: `immersive-translator-mac/Sources/ProviderCore/DiagnosticLogger.swift`
- Create: `immersive-translator-mac/Tests/ProviderCoreTests/_SmokeTest.swift`

- [ ] **Step 1: 改写 Package.swift**

把现有 `Package.swift`（`// swift-tools-version: 5.9` 那份）整体替换为：

```swift
// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ImmersiveTranslator",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ImmersiveTranslator", targets: ["ImmersiveTranslator"])
    ],
    targets: [
        .executableTarget(
            name: "ImmersiveTranslator",
            dependencies: ["ProviderCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("Security"),
                .linkedFramework("Vision"),
                .linkedFramework("SwiftUI")
            ]
        ),
        .target(
            name: "ProviderCore",
            dependencies: [
                .linkedFramework("Security")
            ]
        ),
        .testTarget(
            name: "ProviderCoreTests",
            dependencies: ["ProviderCore"]
        )
    ]
)
```

- [ ] **Step 2: 创建 ProviderCore/DiagnosticLogger.swift**

内容与现有 `Sources/ImmersiveTranslator/DiagnosticLogger.swift` 完全一致（读原文件复制）：

```swift
import Foundation

enum DiagnosticLogger {
    private static let queue = DispatchQueue(label: "local.immersive-translator.diagnostic-logger")

    static func log(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(message)\n"

        queue.async {
            do {
                let url = logFileURL()
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                // 注意: 这里只保留最小可编译结构; 实际实现照搬 Sources/ImmersiveTranslator/DiagnosticLogger.swift 的完整内容
                try? line.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }
}
```

> **实现者注意：** 不要用上面这个简化版。打开 `Sources/ImmersiveTranslator/DiagnosticLogger.swift`，把它的完整内容（含 `logFileURL()` 等所有成员）原样复制到 `Sources/ProviderCore/DiagnosticLogger.swift`。上面只是结构示意。

- [ ] **Step 3: 创建 ProviderCore/ProviderProfile.swift 占位**

```swift
import Foundation

struct ProviderProfile: Identifiable, Codable, Equatable {
    let id: String
    var displayName: String
    var endpoint: String
    var model: String
    var isBuiltin: Bool
    var customModels: [String]
}
```

- [ ] **Step 4: 创建 ProviderCore/ProviderMigration.swift 占位**

```swift
import Foundation

enum ProviderMigration {
    private static let flagKey = "didMigrateProvidersV1"
}
```

- [ ] **Step 5: 创建 Tests/ProviderCoreTests/_SmokeTest.swift**

```swift
import XCTest
@testable import ProviderCore

final class _SmokeTest: XCTestCase {
    func testProviderProfileCodable() throws {
        let profile = ProviderProfile(
            id: "test", displayName: "Test",
            endpoint: "https://example.com", model: "m",
            isBuiltin: false, customModels: []
        )
        let data = try JSONEncoder().encode(profile)
        let decoded = try JSONDecoder().decode(ProviderProfile.self, from: data)
        XCTAssertEqual(profile, decoded)
    }
}
```

- [ ] **Step 6: 验证 build + test 通过**

Run: `cd immersive-translator-mac && swift build && swift test`
Expected: build success, _SmokeTest PASS

- [ ] **Step 7: Commit**

```bash
git add immersive-translator-mac/Package.swift immersive-translator-mac/Sources/ProviderCore immersive-translator-mac/Tests
git commit -m "Scaffold ProviderCore library target with test infrastructure"
```

---

## Task 2: ProviderProfile 完整模型 + modelCandidates

**Files:**
- Modify: `immersive-translator-mac/Sources/ProviderCore/ProviderProfile.swift`
- Test: `immersive-translator-mac/Tests/ProviderCoreTests/ProviderProfileTests.swift`

- [ ] **Step 1: 写失败测试 Tests/ProviderCoreTests/ProviderProfileTests.swift**

```swift
import XCTest
@testable import ProviderCore

final class ProviderProfileTests: XCTestCase {

    func testBuiltinPresetsContainsThreeProviders() {
        let ids = ProviderProfile.builtinPresets.map(\.id)
        XCTAssertEqual(ids, ["deepseek", "zhipu", "openai"])
        XCTAssertTrue(ProviderProfile.builtinPresets.allSatisfy(\.isBuiltin))
    }

    func testBuiltinPresetsEndpoints() {
        let deepseek = ProviderProfile.builtinPresets.first { $0.id == "deepseek" }!
        XCTAssertEqual(deepseek.endpoint, "https://api.deepseek.com/chat/completions")
        XCTAssertEqual(deepseek.model, "deepseek-v4-flash")

        let zhipu = ProviderProfile.builtinPresets.first { $0.id == "zhipu" }!
        XCTAssertEqual(zhipu.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions")
        XCTAssertEqual(zhipu.model, "glm-5.2")

        let openai = ProviderProfile.builtinPresets.first { $0.id == "openai" }!
        XCTAssertEqual(openai.endpoint, "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(openai.model, "gpt-5.4-mini")
    }

    func testModelCandidatesBuiltinOnly() {
        let profile = ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "https://api.deepseek.com/chat/completions",
            model: "deepseek-v4-flash", isBuiltin: true, customModels: []
        )
        XCTAssertEqual(profile.modelCandidates, ["deepseek-v4-flash", "deepseek-v4", "deepseek-reasoner"])
    }

    func testModelCandidatesBuiltinPlusCustomDedup() {
        // customModels 里含一个与内置重名的,应被去重
        let profile = ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "x", model: "deepseek-v4-flash",
            isBuiltin: true,
            customModels: ["deepseek-v4", "my-custom-model", "  ", "my-custom-model"]
        )
        // 内置在前,自定义在后,去重,空串剔除
        XCTAssertEqual(profile.modelCandidates, ["deepseek-v4-flash", "deepseek-v4", "deepseek-reasoner", "my-custom-model"])
    }

    func testModelCandidatesCustomProviderNoBuiltin() {
        let profile = ProviderProfile(
            id: "uuid-123", displayName: "My Ollama",
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "llama3.2", isBuiltin: false,
            customModels: ["llama3.2", "qwen2.5"]
        )
        // 自定义 provider 无内置候选,只有 customModels(去重)
        XCTAssertEqual(profile.modelCandidates, ["llama3.2", "qwen2.5"])
    }

    func testRecordCustomModelAppendsAndDedups() {
        var profile = ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "x", model: "deepseek-v4-flash",
            isBuiltin: true, customModels: []
        )
        profile.appendCustomModel("deepseek-v4")        // 与内置重名,忽略
        profile.appendCustomModel("my-model")            // 追加
        profile.appendCustomModel("my-model")            // 重复,忽略
        XCTAssertEqual(profile.customModels, ["my-model"])
    }

    func testRecordCustomModelCapsAt8() {
        var profile = ProviderProfile(
            id: "uuid", displayName: "Custom",
            endpoint: "x", model: "m", isBuiltin: false, customModels: []
        )
        for i in 0..<10 {
            profile.appendCustomModel("model-\(i)")
        }
        // 最多 8 条,淘汰最旧
        XCTAssertEqual(profile.customModels.count, 8)
        XCTAssertEqual(profile.customModels.first, "model-2")   // model-0/1 被淘汰
        XCTAssertEqual(profile.customModels.last, "model-9")
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd immersive-translator-mac && swift test --filter ProviderProfileTests`
Expected: FAIL（builtinPresets/modelCandidates/appendCustomModel 未定义）

- [ ] **Step 3: 实现 ProviderProfile.swift 完整版**

替换 `Sources/ProviderCore/ProviderProfile.swift` 全部内容：

```swift
import Foundation

struct ProviderProfile: Identifiable, Codable, Equatable {
    let id: String
    var displayName: String
    var endpoint: String
    var model: String
    var isBuiltin: Bool
    var customModels: [String]

    // 硬编码厂商官方模型,不进 UserDefaults
    static let builtinModelCandidates: [String: [String]] = [
        "deepseek": ["deepseek-v4-flash", "deepseek-v4", "deepseek-reasoner"],
        "zhipu":    ["glm-5.2", "glm-5.2-air", "glm-4-flash"],
        "openai":   ["gpt-5.4-mini", "gpt-5.4", "gpt-4o-mini"],
        // 自定义 provider 无内置候选,customModels 是唯一来源
    ]

    static let builtinPresets: [ProviderProfile] = [
        ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "https://api.deepseek.com/chat/completions",
            model: "deepseek-v4-flash",
            isBuiltin: true, customModels: []
        ),
        ProviderProfile(
            id: "zhipu", displayName: "智谱",
            endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            model: "glm-5.2",
            isBuiltin: true, customModels: []
        ),
        ProviderProfile(
            id: "openai", displayName: "OpenAI",
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-5.4-mini",
            isBuiltin: true, customModels: []
        ),
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

    // 用户自由填了模型名 → 追加到 customModels(去重:对比内置 + 已有;超 8 条淘汰最旧)
    mutating func appendCustomModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let builtin = Self.builtinModelCandidates[id] ?? []
        guard !builtin.contains(trimmed), !customModels.contains(trimmed) else { return }
        customModels.append(trimmed)
        if customModels.count > 8 {
            customModels.removeFirst()
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd immersive-translator-mac && swift test --filter ProviderProfileTests`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add immersive-translator-mac/Sources/ProviderCore/ProviderProfile.swift immersive-translator-mac/Tests/ProviderCoreTests/ProviderProfileTests.swift
git commit -m "Add ProviderProfile model with builtin candidates and dedup"
```

---

## Task 3: ProviderMigration 迁移逻辑 + host 匹配

**Files:**
- Modify: `immersive-translator-mac/Sources/ProviderCore/ProviderMigration.swift`
- Test: `immersive-translator-mac/Tests/ProviderCoreTests/ProviderMigrationTests.swift`

- [ ] **Step 1: 写失败测试 ProviderMigrationTests.swift**

```swift
import XCTest
@testable import ProviderCore

final class ProviderMigrationTests: XCTestCase {

    // 用一个隔离的 UserDefaults,避免污染全局状态
    private func isolatedDefaults(prefix: String) -> UserDefaults {
        let suiteName = "test.\(prefix).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    func testNormalizedHostStripsSchemeAndPath() {
        XCTAssertEqual(ProviderMigration.normalizedHost("https://api.deepseek.com/chat/completions"), "api.deepseek.com")
        XCTAssertEqual(ProviderMigration.normalizedHost("http://api.deepseek.com/v1/chat/completions"), "api.deepseek.com")
        XCTAssertEqual(ProviderMigration.normalizedHost("API.DeepSeek.COM/"), "api.deepseek.com")
        XCTAssertEqual(ProviderMigration.normalizedHost("api.openai.com"), "api.openai.com")
        XCTAssertEqual(ProviderMigration.normalizedHost(""), "")
    }

    func testMatchesSameHostDifferentForm() {
        XCTAssertTrue(ProviderMigration.matches(
            "https://api.deepseek.com/chat/completions",
            "api.deepseek.com"
        ))
        XCTAssertFalse(ProviderMigration.matches(
            "https://api.deepseek.com/chat/completions",
            "https://api.openai.com/v1/chat/completions"
        ))
        // 空 host 不匹配(防止空==空误判)
        XCTAssertFalse(ProviderMigration.matches("", ""))
    }

    func testMigrateFreshInstallNoLegacyData() {
        let defaults = isolatedDefaults(prefix: "fresh")
        var providers = ProviderProfile.builtinPresets
        var activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)
        // 无旧数据:providers 不变,active 仍是 deepseek,flag 置上
        XCTAssertEqual(providers.count, 3)
        XCTAssertEqual(activeID, "deepseek")
        XCTAssertTrue(defaults.bool(forKey: "didMigrateProvidersV1"))
    }

    func testMigrateMatchesOpenAILegacy() {
        let defaults = isolatedDefaults(prefix: "openai")
        defaults.set("https://api.openai.com/v1/chat/completions", forKey: "endpoint")
        defaults.set("gpt-5.4", forKey: "model")

        var providers = ProviderProfile.builtinPresets
        var activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)

        // 匹配到 openai 常驻:不新增,active=openai,model 被旧值覆盖
        XCTAssertEqual(providers.count, 3)
        XCTAssertEqual(activeID, "openai")
        XCTAssertEqual(providers.first { $0.id == "openai" }?.model, "gpt-5.4")
    }

    func testMigrateUnknownEndpointCreatesImportedCustomProvider() {
        let defaults = isolatedDefaults(prefix: "custom")
        defaults.set("https://api.moonshot.cn/v1/chat/completions", forKey: "endpoint")
        defaults.set("moonshot-v1-8k", forKey: "model")

        var providers = ProviderProfile.builtinPresets
        var activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)

        // 匹配不上:新建自定义项,active 指向它
        XCTAssertEqual(providers.count, 4)
        XCTAssertEqual(activeID, providers.last!.id)
        XCTAssertEqual(providers.last!.displayName, "导入的提供商")
        XCTAssertEqual(providers.last!.endpoint, "https://api.moonshot.cn/v1/chat/completions")
        XCTAssertEqual(providers.last!.isBuiltin, false)
        XCTAssertEqual(providers.last!.customModels, ["moonshot-v1-8k"])
    }

    func testMigrateIdempotentRunsOnce() {
        let defaults = isolatedDefaults(prefix: "idem")
        defaults.set("https://api.openai.com/v1/chat/completions", forKey: "endpoint")
        defaults.set("gpt-5.4", forKey: "model")

        var providers = ProviderProfile.builtinPresets
        var activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)

        // 第二次跑:flag 已置,什么都不做
        providers = ProviderProfile.builtinPresets
        activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)
        // 第二次因为 flag 已置,providers 保持原样(没匹配 openai),active=deepseek
        XCTAssertEqual(activeID, "deepseek")
    }

    func testMigrateLocalEndpointWithEmptyModel() {
        let defaults = isolatedDefaults(prefix: "local")
        defaults.set("http://localhost:11434/v1/chat/completions", forKey: "endpoint")
        // model 为空

        var providers = ProviderProfile.builtinPresets
        var activeID = "deepseek"
        ProviderMigration.runIfNeeded(providers: &providers, activeProviderID: &activeID, defaults: defaults)

        // 本地 endpoint 匹配不上常驻 → 建自定义,model 用默认 gpt-3.5-turbo,customModels 为空
        XCTAssertEqual(providers.count, 4)
        XCTAssertEqual(providers.last!.model, "gpt-3.5-turbo")
        XCTAssertEqual(providers.last!.customModels, [])
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd immersive-translator-mac && swift test --filter ProviderMigrationTests`
Expected: FAIL（runIfNeeded/normalizedHost/matches 未实现）

- [ ] **Step 3: 实现 ProviderMigration.swift 完整版**

替换 `Sources/ProviderCore/ProviderMigration.swift` 全部内容：

```swift
import Foundation

enum ProviderMigration {
    private static let flagKey = "didMigrateProvidersV1"

    static let legacyEndpointKey = "endpoint"
    static let legacyModelKey = "model"

    static func runIfNeeded(
        providers: inout [ProviderProfile],
        activeProviderID: inout String,
        defaults: UserDefaults = .standard
    ) {
        guard !defaults.bool(forKey: flagKey) else { return }

        let legacyEndpoint = defaults.string(forKey: legacyEndpointKey) ?? ""
        let legacyModel = defaults.string(forKey: legacyModelKey) ?? ""

        // 1. 优先按 endpoint 匹配三常驻
        if let idx = providers.firstIndex(where: { $0.isBuiltin && matches($0.endpoint, legacyEndpoint) }) {
            if !legacyEndpoint.isEmpty { providers[idx].endpoint = legacyEndpoint }
            if !legacyModel.isEmpty { providers[idx].model = legacyModel }
            activeProviderID = providers[idx].id
        } else if !legacyEndpoint.isEmpty {
            // 2. 匹配不上但旧 endpoint 有效 → 建"导入的提供商"自定义项
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
        // else: 旧 endpoint 空(全新安装) → 不动,保持 activeProviderID

        // 3. 置 flag(无论有没有旧数据,只跑一次)
        defaults.set(true, forKey: flagKey)
    }

    static func matches(_ a: String, _ b: String) -> Bool {
        let ha = normalizedHost(a)
        return !ha.isEmpty && ha == normalizedHost(b)
    }

    static func normalizedHost(_ url: String) -> String {
        var s = url.lowercased()
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) {
            s.removeFirst(prefix.count)
        }
        for suffix in ["/chat/completions", "/v1/chat/completions", "/api/paas/v4/chat/completions"] where s.hasSuffix(suffix) {
            s.removeLast(suffix.count)
        }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
```

> **注意：** 迁移里的 Key 迁移（旧 Keychain `account=apiKey` → 新槽）不在此函数内，因为 Keychain 操作在 ProviderCore（无 GUI 依赖）里测不了。Key 迁移放在 SettingsStore.init（Task 5）里，靠 KeychainStore 便捷方法完成。runIfNeeded 只处理 endpoint/model/activeProviderID 的迁移 + flag。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd immersive-translator-mac && swift test --filter ProviderMigrationTests`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add immersive-translator-mac/Sources/ProviderCore/ProviderMigration.swift immersive-translator-mac/Tests/ProviderCoreTests/ProviderMigrationTests.swift
git commit -m "Add provider migration with host normalization and idempotent flag"
```

---

## Task 4: KeychainStore 按 providerId 分槽便捷方法

**Files:**
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/KeychainStore.swift`

这是对现有 `KeychainStore` 的纯增量扩展，底层复用已存在的 `string/setString/delete`，不写测试（Keychain 读写靠手动验证）。

- [ ] **Step 1: 在 KeychainStore.swift 末尾（enum KeychainStore 的 `}` 之前）加便捷方法**

现有 KeychainStore.swift 结构（86 行）：
```swift
import Foundation
import Security

enum KeychainStoreError: LocalizedError { ... }   // 行 4-15

enum KeychainStore {                                // 行 16
    static func string(...) throws -> String?       // 行 17
    static func setString(...) throws               // 行 41
    static func delete(...) throws                  // 行 74
}                                                   // 行 ~86
```

在 `enum KeychainStore {` 内部、现有 `delete` 方法之后、enum 结束 `}` 之前，插入：

```swift
    // MARK: - Provider-scoped API Key slots

    private static let providerService = "local.immersive-translator.mvp"
    static let legacyAccount = "apiKey"

    static func apiKey(for providerId: String) -> String? {
        guard let raw = try? string(service: providerService, account: accountKey(for: providerId)),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    static func setAPIKey(_ value: String, for providerId: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty {
                try delete(service: providerService, account: accountKey(for: providerId))
            } else {
                try setString(trimmed, service: providerService, account: accountKey(for: providerId))
            }
        } catch {
            DiagnosticLogger.log("keychain.write.failed providerId=\(providerId) error=\(error.localizedDescription)")
        }
    }

    static func deleteAPIKey(for providerId: String) {
        try? delete(service: providerService, account: accountKey(for: providerId))
    }

    private static func accountKey(for providerId: String) -> String {
        "apiKey.\(providerId)"
    }
```

> **核对：** 现有 SettingsStore 用的是 `Keys.keychainService = "local.immersive-translator.mvp"`（Settings.swift:153）。这里的 `providerService` 必须与之一致。两者都是同一 service 字符串，旧全局 key 存在 `account="apiKey"`，新 key 存在 `account="apiKey.<providerId>"`，互不冲突。

- [ ] **Step 2: 验证编译**

Run: `cd immersive-translator-mac && swift build`
Expected: build success（新方法暂未被调用，只是编译通过）

- [ ] **Step 3: Commit**

```bash
git add immersive-translator-mac/Sources/ImmersiveTranslator/KeychainStore.swift
git commit -m "Add provider-scoped API Key slot methods to KeychainStore"
```

---

## Task 5: SettingsStore 改造 — providers/activeProviderID/editingAPIKey + 迁移

**Files:**
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift`（行 6-168 的 SettingsStore 类）

这是最大的改动。分步进行，每步编译验证。

- [ ] **Step 1: 在 Package.swift 确认 ImmersiveTranslator 依赖 ProviderCore（Task 1 已做）**

确认 `Sources/ImmersiveTranslator/Settings.swift` 顶部能 `import ProviderCore`。在 Settings.swift 顶部 `import` 区加：

```swift
import ProviderCore
```

（加在现有 `import AppKit` / `import Carbon` 等之后）

- [ ] **Step 2: 删除旧的全局 endpoint/model/apiKey 字段，替换为新字段**

在 `SettingsStore` 类（Settings.swift:6-168）里：

**删除**以下成员（行 7-29）：
- `@Published var apiKey: String { didSet { ... } }`
- `@Published var apiKeyStorageError: String?`（保留这行，后面仍可能用；实际上改为不再公开，先删）
- `@Published var endpoint: String { didSet { ... } }`
- `@Published var model: String { didSet { ... } }`

**新增**（放在类顶部 `@Published var providerDiagnosticRequestID` 附近）：

```swift
    @Published var providers: [ProviderProfile] {
        didSet { persistProviders() }
    }
    @Published var activeProviderID: String {
        didSet { UserDefaults.standard.set(activeProviderID, forKey: Keys.activeProviderID) }
    }
    @Published var editingAPIKey: String = ""

    var activeProvider: ProviderProfile {
        providers.first { $0.id == activeProviderID } ?? providers[0]
    }
```

**删除** init 里的（行 68-72）：
- `let apiKeyResult = Self.loadAPIKey()`
- `apiKey = apiKeyResult.value`
- `apiKeyStorageError = apiKeyResult.errorMessage`
- `endpoint = UserDefaults.standard.string(forKey: Keys.endpoint) ?? "https://api.openai.com/v1/chat/completions"`
- `model = UserDefaults.standard.string(forKey: Keys.model) ?? "gpt-5.4-mini"`

**删除** 整个 `private static func loadAPIKey()`（行 94-121）。

**改写 init**（行 67-82）：

```swift
    init() {
        // 1. 加载 providers
        if let data = UserDefaults.standard.data(forKey: Keys.providers),
           let decoded = try? JSONDecoder().decode([ProviderProfile].self, from: data),
           !decoded.isEmpty {
            providers = decoded
        } else {
            providers = ProviderProfile.builtinPresets
        }
        // 兜底:保证至少有三常驻
        if !providers.contains(where: { $0.isBuiltin }) {
            providers = ProviderProfile.builtinPresets + providers
        }

        // 2. 迁移(只跑一次)
        activeProviderID = UserDefaults.standard.string(forKey: Keys.activeProviderID) ?? ProviderProfile.builtinPresets[0].id
        var mutableProviders = providers
        var mutableActiveID = activeProviderID
        ProviderMigration.runIfNeeded(providers: &mutableProviders, activeProviderID: &mutableActiveID)
        providers = mutableProviders
        activeProviderID = mutableActiveID

        // 3. 迁移旧 Key(旧全局 account=apiKey → 当前 active 槽)
        if let legacyKey = try? KeychainStore.string(service: Keys.keychainService, account: KeychainStore.legacyAccount),
           !legacyKey.isEmpty,
           KeychainStore.apiKey(for: activeProviderID) == nil {
            KeychainStore.setAPIKey(legacyKey, for: activeProviderID)
        }

        // 4. 兜底 active 合法
        if !providers.contains(where: { $0.id == activeProviderID }) {
            activeProviderID = ProviderProfile.builtinPresets[0].id
        }

        // 5. 加载当前 key 到编辑态
        editingAPIKey = KeychainStore.apiKey(for: activeProviderID) ?? ""

        targetLanguage = UserDefaults.standard.string(forKey: Keys.targetLanguage) ?? "简体中文"
        translationDirection = TranslationDirection(rawValue: UserDefaults.standard.string(forKey: Keys.translationDirection) ?? "") ?? .autoChineseEnglish
        ocrMode = OCRRecognitionMode(rawValue: UserDefaults.standard.string(forKey: Keys.ocrMode) ?? "") ?? .accurate
        ocrLanguagePreset = OCRLanguagePreset(rawValue: UserDefaults.standard.string(forKey: Keys.ocrLanguagePreset) ?? "") ?? .autoMixed
        enableStreamingTranslation = UserDefaults.standard.object(forKey: Keys.enableStreamingTranslation) as? Bool ?? true
        customPrompt = UserDefaults.standard.string(forKey: Keys.customPrompt) ?? ""
        glossaryText = UserDefaults.standard.string(forKey: Keys.glossaryText) ?? ""
        selectionHotKeyShortcut = Self.loadSelectionHotKeyShortcut()
        ocrHotKeyShortcut = Self.loadOCRHotKeyShortcut()
    }
```

**新增方法**（放在 init 之后）：

```swift
    // MARK: - Provider switching & persistence

    func switchActiveProvider(to id: String) {
        guard id != activeProviderID, providers.contains(where: { $0.id == id }) else { return }
        persistEditingAPIKey(for: activeProviderID)
        activeProviderID = id
        editingAPIKey = KeychainStore.apiKey(for: id) ?? ""
        providerDiagnostic = .idle
        providerPresetMessage = ""
    }

    func persistEditingAPIKey(for id: String) {
        KeychainStore.setAPIKey(editingAPIKey, for: id)
    }

    func recordCustomModel(_ model: String) {
        guard let idx = providers.firstIndex(where: { $0.id == activeProviderID }) else { return }
        providers[idx].appendCustomModel(model)
    }

    func deleteCustomProvider(_ id: String) {
        guard let target = providers.first(where: { $0.id == id }), !target.isBuiltin else { return }
        providers.removeAll { $0.id == id }
        KeychainStore.deleteAPIKey(for: id)
        if activeProviderID == id {
            switchActiveProvider(to: ProviderProfile.builtinPresets[0].id)
        }
    }

    func updateActiveProvider(_ transform: (inout ProviderProfile) -> Void) {
        guard let idx = providers.firstIndex(where: { $0.id == activeProviderID }) else { return }
        transform(&providers[idx])
    }

    private func persistProviders() {
        if let data = try? JSONEncoder().encode(providers) {
            UserDefaults.standard.set(data, forKey: Keys.providers)
        }
    }
```

**改 Keys enum**（行 151-167）：

删除 `static let apiKey = "apiKey"`、`static let endpoint = "endpoint"`、`static let model = "model"` 三行；新增：

```swift
        static let providers = "providers"
        static let activeProviderID = "activeProviderID"
```

保留 `static let keychainService = "local.immersive-translator.mvp"`。

> **注意 `providerDiagnostic` 和 `providerPresetMessage`：** 这两个在 `switchActiveProvider` 里被引用。它们当前在 SettingsStore 里是否已存在？需确认。若已存在（从 UI 部分看应该有），直接用；若不存在，本步先加占位 `@Published var providerDiagnostic: String = ""` 和 `@Published var providerPresetMessage: String = ""`，Task 6 接管真实类型。实现者请先 grep 确认。

- [ ] **Step 3: 修复编译错误（删除/更新所有引用旧 endpoint/model/apiKey 的地方）**

在 Settings.swift 内部搜索 `settingsStore.endpoint`、`settingsStore.model`、`settingsStore.apiKey`、`self.endpoint`、`self.model`、`self.apiKey` 的引用，逐个改为：
- `endpoint` → `activeProvider.endpoint`
- `model` → `activeProvider.model`
- `apiKey` → `KeychainStore.apiKey(for: activeProviderID) ?? ""`（在 SettingsStore 内部直接用）

Settings.swift 内部的引用主要在 UI 部分（Task 6 处理）。本步只确保 Settings.swift 能编译。

Run: `cd immersive-translator-mac && swift build 2>&1 | head -40`
Expected: 可能仍有 UI 部分的编译错误（正常，Task 6 处理），但 SettingsStore 类本身定义无错

- [ ] **Step 4: 运行全部测试确认未破坏逻辑**

Run: `cd immersive-translator-mac && swift test`
Expected: ProviderProfileTests + ProviderMigrationTests 全 PASS（SettingsStore 改动不影响 ProviderCore 测试）

- [ ] **Step 5: Commit**

```bash
git add immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift
git commit -m "Replace global endpoint/model/apiKey with providers/activeProviderID/editingAPIKey"
```

---

## Task 6: 改造 Settings UI — 选 provider + 详情区

**Files:**
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift`（UI 部分，约 2700-2811 行的 providerPresetCard/applyProviderPreset 区域）

此任务无单元测试（纯 SwiftUI 视图），靠手动验证。

- [ ] **Step 1: 定位现有 provider UI**

Run: `cd immersive-translator-mac && grep -n "providerPresetCard\|applyProviderPreset\|TranslationProviderPreset" Sources/ImmersiveTranslator/Settings.swift`

记录所有引用点。现有 `TranslationProviderPreset.all`（行 270）+ `providerPresetCard`（行 2742）+ `applyProviderPreset`（行 2786）。

- [ ] **Step 2: 替换 TranslationProviderPreset 为对 ProviderProfile.builtinPresets 的引用**

删除 `struct TranslationProviderPreset`（行 262-296）。原 UI 里用 `TranslationProviderPreset.all` 的地方改为 `settingsStore.providers.filter { $0.isBuiltin }`。

- [ ] **Step 3: 替换 providerPresetCard → builtinProviderCard**

删除 `providerPresetCard`（行 2742-2784），替换为：

```swift
    private func builtinProviderCard(_ profile: ProviderProfile) -> some View {
        let isSelected = settingsStore.activeProviderID == profile.id

        return Button {
            settingsStore.switchActiveProvider(to: profile.id)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    Text(profile.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                Text(profile.model)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isSelected ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.10), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help("切换到 \(profile.displayName)")
    }
```

- [ ] **Step 4: 替换 applyProviderPreset → 已由 switchActiveProvider 取代**

删除 `applyProviderPreset`（行 2786-2811）、`providerPresetChangeSuppressionCount` 相关、`providerPresetNextStep`（行 2821-2829）。这些逻辑由 `switchActiveProvider` 接管。

- [ ] **Step 5: 改写 provider 选择区的容器视图**

找到原来渲染 `TranslationProviderPreset.all` 卡片列表的地方（grep `providerPresetCard(` 找调用点），替换为：

```swift
        VStack(alignment: .leading, spacing: 10) {
            Text("服务商").font(.headline)
            HStack(spacing: 10) {
                ForEach(settingsStore.providers.filter { $0.isBuiltin }) { profile in
                    builtinProviderCard(profile)
                }
            }

            if !settingsStore.providers.contains(where: { !$0.isBuiltin }) == false {
                Divider().padding(.vertical, 4)
                Text("自定义").font(.headline)
                ForEach(settingsStore.providers.filter { !$0.isBuiltin }) { profile in
                    customProviderRow(profile)
                }
            }

            Button {
                showAddCustomProvider = true
            } label: {
                Label("添加自定义提供商", systemImage: "plus")
            }
        }
```

- [ ] **Step 6: 加 customProviderRow 视图**

```swift
    private func customProviderRow(_ profile: ProviderProfile) -> some View {
        let isSelected = settingsStore.activeProviderID == profile.id
        return HStack {
            Button {
                settingsStore.switchActiveProvider(to: profile.id)
            } label: {
                HStack {
                    Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(isSelected ? .accentColor : .secondary)
                    VStack(alignment: .leading) {
                        Text(profile.displayName).font(.subheadline)
                        Text("\(profile.endpoint) · \(profile.model)")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            Button(role: .destructive) {
                confirmDeleteCustomProvider(profile)
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.red.opacity(0.6))
            }
            .buttonStyle(.plain)
            .help("删除 \(profile.displayName)")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(isSelected ? Color.accentColor.opacity(0.08) : Color.clear))
    }
```

- [ ] **Step 7: 加 @State 和删除确认/添加表单**

在 SettingsView 里加：

```swift
    @State private var showAddCustomProvider = false
    @State private var pendingDeleteProvider: ProviderProfile?
    @State private var newProviderName = ""
    @State private var newProviderEndpoint = ""
    @State private var newProviderModel = ""
```

加方法：

```swift
    private func confirmDeleteCustomProvider(_ profile: ProviderProfile) {
        pendingDeleteProvider = profile
    }

    private func addCustomProvider() {
        let name = newProviderName.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = newProviderEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !endpoint.isEmpty else { return }
        let model = newProviderModel.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = ProviderProfile(
            id: UUID().uuidString, displayName: name,
            endpoint: endpoint, model: model.isEmpty ? "gpt-3.5-turbo" : model,
            isBuiltin: false, customModels: []
        )
        settingsStore.providers.append(profile)
        settingsStore.switchActiveProvider(to: profile.id)
        newProviderName = ""; newProviderEndpoint = ""; newProviderModel = ""
        showAddCustomProvider = false
    }
```

- [ ] **Step 8: 改写详情区（endpoint/model/apiKey 输入）**

找到原来渲染 endpoint/model/apiKey 输入框的地方（grep `settingsStore.endpoint` / `$settingsStore.model` / `$settingsStore.apiKey`），替换为绑定到 activeProvider / editingAPIKey：

```swift
        VStack(alignment: .leading, spacing: 12) {
            Text("当前: \(settingsStore.activeProvider.displayName)").font(.headline)

            // 接口地址(常驻可改不可删,自定义可任意改)
            LabeledContent("接口地址") {
                TextField("https://...", text: Binding(
                    get: { settingsStore.activeProvider.endpoint },
                    set: { settingsStore.updateActiveProvider { $0.endpoint = $0 } }
                ))
                .textFieldStyle(.roundedBorder)
            }

            // 模型下拉(内置候选 + customModels + 自定义...)
            LabeledContent("模型") {
                modelPicker
            }

            // API Key(绑定 editingAPIKey,失焦落盘)
            LabeledContent("API Key") {
                SecureField("", text: $settingsStore.editingAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { settingsStore.persistEditingAPIKey(for: settingsStore.activeProviderID) }
            }
        }
```

- [ ] **Step 9: 加 modelPicker（下拉 + 自定义输入）**

```swift
    @State private var showCustomModelInput = false
    @State private var customModelInput = ""

    private var modelPicker: some View {
        Group {
            Picker("模型", selection: Binding(
                get: { settingsStore.activeProvider.model },
                set: { settingsStore.updateActiveProvider { $0.model = $0 } }
            )) {
                ForEach(settingsStore.activeProvider.modelCandidates, id: \.self) { candidate in
                    Text(candidate).tag(candidate)
                }
            }
            Button("自定义...") { showCustomModelInput = true }
        }
        .sheet(isPresented: $showCustomModelInput) {
            VStack(alignment: .leading, spacing: 12) {
                Text("输入模型名").font(.headline)
                TextField("如 deepseek-v4-turbo", text: $customModelInput)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("取消") { showCustomModelInput = false }
                    Button("确定") {
                        let trimmed = customModelInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            settingsStore.updateActiveProvider { $0.model = trimmed }
                            settingsStore.recordCustomModel(trimmed)
                        }
                        customModelInput = ""
                        showCustomModelInput = false
                    }
                }
            }
            .padding()
            .frame(width: 320)
        }
    }
```

- [ ] **Step 10: 编译**

Run: `cd immersive-translator-mac && swift build 2>&1 | head -40`
Expected: 编译通过（可能需处理若干遗漏的旧引用，逐个改）

- [ ] **Step 11: 手动验证 UI**

Run: `cd immersive-translator-mac && swift run`
手动验证：
1. 设置窗口显示三常驻卡片，DeepSeek 默认选中
2. 点 OpenAI 卡片 → 详情区切换到 OpenAI 的 endpoint/model，Key 输入框清空
3. 填一个 key → 切到智谱 → 填另一个 key → 切回 OpenAI → key 恢复 OpenAI 的
4. 添加自定义提供商 → 出现在列表 → 选中 → 填 key → 切走再切回 → key 恢复
5. 删除自定义提供商 → 从列表消失
6. 模型下拉显示内置候选；自定义输入后出现在下次下拉

- [ ] **Step 12: Commit**

```bash
git add immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift
git commit -m "Replace provider preset UI with switchable provider cards and detail pane"
```

---

## Task 7: 改造调用方 — TranslationClient / Onboarding / App

**Files:**
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/TranslationClient.swift`（行 96-98, 113, 123-124）
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/Onboarding.swift`（行 192-215）
- Modify: `immersive-translator-mac/Sources/ImmersiveTranslator/App.swift`（ensureConfigured，约行 1390-1442）

- [ ] **Step 1: TranslationClient 改读法**

TranslationClient.swift 行 96-98 现有：

```swift
let apiKey = settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
let endpoint = settingsStore.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
let model = settingsStore.model.trimmingCharacters(in: .whitespacesAndNewlines)
```

改为：

```swift
let apiKey = (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
```

TranslationClient.swift 顶部确认有 `import ProviderCore`（若用到 ProviderProfile 类型则需加；这里只用 settingsStore 属性，可能不需要 import）。

- [ ] **Step 2: Onboarding 改读法**

Onboarding.swift 行 192-197 现有：

```swift
private var apiKeyStepIsDone: Bool {
    !apiKeyIsRequired || !settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private var apiKeyIsRequired: Bool {
    TranslationClient.requiresAPIKey(for: settingsStore.endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
}
```

改为：

```swift
private var apiKeyStepIsDone: Bool {
    !apiKeyIsRequired || !(KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private var apiKeyIsRequired: Bool {
    TranslationClient.requiresAPIKey(for: settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
}
```

- [ ] **Step 3: App.ensureConfigured 改读法**

App.swift 约 1390-1442 现有引用 `settingsStore.endpoint`、`settingsStore.apiKey`。逐个改：

- `let endpoint = settingsStore.endpoint...` → `let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)`
- `settingsStore.apiKey.trimmingCharacters(...).isEmpty` → `(KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty`

Run: `cd immersive-translator-mac && grep -n "settingsStore.endpoint\|settingsStore.model\|settingsStore.apiKey" Sources/ImmersiveTranslator/App.swift`
逐个改掉。

- [ ] **Step 4: 全局搜索遗漏引用**

Run: `cd immersive-translator-mac && grep -rn "settingsStore.endpoint\|settingsStore.model\|settingsStore.apiKey\b" Sources/`
Expected: 无剩余引用（或仅剩 Settings.swift 内部已处理的）

如有遗漏，逐个改为 `activeProvider.*` / `KeychainStore.apiKey(for:)`。

- [ ] **Step 5: 编译 + 测试**

Run: `cd immersive-translator-mac && swift build && swift test`
Expected: build success, 全部测试 PASS

- [ ] **Step 6: 手动验证端到端**

Run: `cd immersive-translator-mac && swift run`
1. 配 DeepSeek key → 翻译选中文本 → 成功
2. 切到 OpenAI 配 key → 翻译 → 成功
3. 切回 DeepSeek → 直接翻译（key 已恢复）→ 成功
4. Onboarding 里 key 必填判断正确

- [ ] **Step 7: Commit**

```bash
git add immersive-translator-mac/Sources/ImmersiveTranslator/TranslationClient.swift immersive-translator-mac/Sources/ImmersiveTranslator/Onboarding.swift immersive-translator-mac/Sources/ImmersiveTranslator/App.swift
git commit -m "Update call sites to read from activeProvider and provider-scoped keychain slots"
```

---

## Self-Review

**1. Spec coverage:**
- §3 数据模型 ProviderProfile → Task 1（占位）+ Task 2（完整）✓
- §3.4 switchActiveProvider/persistEditingAPIKey/recordCustomModel → Task 5 ✓
- §4 Keychain 分槽 → Task 4 ✓
- §5 迁移 → Task 3（endpoint/model/active）+ Task 5 Step 2（Key 迁移）✓
- §6 UI → Task 6 ✓
- §7 错误处理：Keychain 读写失败 → Task 4（setAPIKey 捕获记日志）✓；activeProviderID 兜底 → Task 5 init ✓；删除 active → Task 5 deleteCustomProvider ✓；customModels 上限 → Task 2 appendCustomModel ✓
- §9 验收标准 1-7 → Task 6 Step 11 + Task 7 Step 6 手动验证覆盖 ✓

**2. Placeholder scan:** Task 1 Step 2 的 DiagnosticLogger 有"实现者注意：照搬原文件"的说明 —— 这是因为无法在此内联 86 行原文件全文，但给了明确指引。其余任务代码完整。

**3. Type consistency:**
- `appendCustomModel` (Task 2) vs `recordCustomModel` (Task 5): 前者是 ProviderProfile 的 mutating 方法，后者是 SettingsStore 的方法调用前者。命名区分清晰，Task 5 recordCustomModel 内部调 `providers[idx].appendCustomModel(model)`，一致 ✓
- `updateActiveProvider` (Task 5) 在 Task 6 Step 8/9 使用 ✓
- `switchActiveProvider` (Task 5) 在 Task 6 Step 3/5 使用 ✓
- `builtinPresets` (Task 2) 在 Task 3/5 使用 ✓
- `modelCandidates` (Task 2) 在 Task 6 Step 9 使用 ✓

**4. 潜在风险点（实现者需留意）：**
- Task 5 Step 2 里 `providerDiagnostic` 和 `providerPresetMessage` 的类型需 grep 确认。若是自定义 struct 类型，`switchActiveProvider` 里赋 `.idle` / `""` 可能类型不匹配 —— 实现时按实际类型调整。
- Task 6 涉及大量 SwiftUI 视图改动，Settings.swift 有 3099 行。若编译错误过多，建议先 `swift build` 看错误清单，按错误驱动修改。
