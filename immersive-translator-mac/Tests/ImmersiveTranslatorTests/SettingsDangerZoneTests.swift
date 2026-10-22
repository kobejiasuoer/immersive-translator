import XCTest
@testable import ImmersiveTranslator
import ProviderCore

/// SET-9 危险区「恢复默认」+ SET-5 保存条语义的应用层单测：
/// 1）Keychain 清理语义：全部 `apiKey.*` Provider 槽与旧全局密钥清空、账号令牌槽保留；
/// 2）SettingsStore.resetToDefaults：全字段回出厂默认（含自定义 provider 移除、密钥清空）；
/// 3）SettingsSaveSnapshot：脏检测 + 「热键改动才重注册」的闸门；
/// 4）SettingsSection 七分区 IA 与 Windows TABS 分组逐项一致。
///
/// KeychainStore 在测试进程内走字典替身（不触碰 SecItem），可安全直读直写。
final class SettingsDangerZoneTests: XCTestCase {

    // MARK: - SET-9 Keychain 清理语义

    func testDeleteAllProviderKeySlotsClearsProviderKeysAndKeepsServerAuth() throws {
        // 起点清场，保证断言不被其它用例遗留槽位干扰。
        _ = KeychainStore.deleteAllProviderAPIKeySlots()

        XCTAssertTrue(KeychainStore.setAPIKey("sk-deepseek", for: "deepseek"))
        XCTAssertTrue(KeychainStore.setAPIKey("sk-zhipu", for: "zhipu"))
        XCTAssertTrue(KeychainStore.setAPIKey("sk-custom", for: "custom-uuid-1"))
        // 旧全局密钥槽（account = legacyAccount，与 SettingsStore.Keys.keychainService 同 service）。
        try KeychainStore.setString(
            "sk-legacy",
            service: "local.immersive-translator.mvp",
            account: KeychainStore.legacyAccount
        )
        let tokenJSON = #"{"accessToken":"a","refreshToken":"r","accessExpiresAt":1,"user":null}"#
        try KeychainStore.saveServerAuthTokenJSON(tokenJSON)

        let cleared = KeychainStore.deleteAllProviderAPIKeySlots()

        XCTAssertNil(KeychainStore.apiKey(for: "deepseek"), "deepseek 槽应被清空")
        XCTAssertNil(KeychainStore.apiKey(for: "zhipu"), "zhipu 槽应被清空")
        XCTAssertNil(KeychainStore.apiKey(for: "custom-uuid-1"), "已删除的自定义 provider 残槽也应被清空")
        XCTAssertTrue(cleared.contains("apiKey.deepseek"))
        XCTAssertTrue(cleared.contains("apiKey.zhipu"))
        XCTAssertTrue(cleared.contains("apiKey.custom-uuid-1"))
        XCTAssertTrue(cleared.contains(KeychainStore.legacyAccount), "旧全局密钥槽一并清除")
        XCTAssertEqual(
            KeychainStore.loadServerAuthTokenJSON(),
            tokenJSON,
            "账号令牌槽（server_auth）必须保留"
        )

        // 幂等：全部清空后再跑一遍，不报错也不再列出条目。
        XCTAssertTrue(KeychainStore.deleteAllProviderAPIKeySlots().isEmpty)
    }

    // MARK: - SET-9 全字段回默认

    func testResetToDefaultsRestoresFactoryValuesAndClearsProviderKeys() {
        let scope = DefaultsRestoreScope(keys: Self.settingsStoreKeys)
        defer { scope.restore() }

        _ = KeychainStore.deleteAllProviderAPIKeySlots()
        let store = SettingsStore()

        // 脏化全部可复位字段（设置窗口能改的每一项都偏离默认值）。
        store.targetLanguage = "日本語"
        store.translationDirection = .fixedTarget
        store.ocrMode = .fast
        store.ocrLanguagePreset = .japanese
        store.enableStreamingTranslation = false
        store.dictCardAuto = false
        store.customPrompt = "自然口语风格"
        store.glossaryText = "hello = 你好"
        store.selectionHotKeyShortcut = .controlOptionR
        store.ocrHotKeyShortcut = .optionSpace
        store.readerHotKeyShortcut = .optionSpace
        store.editingAPIKey = "sk-dirty"
        store.providers.append(
            ProviderProfile(
                id: "custom-x",
                displayName: "自建 X",
                endpoint: "https://example.com/v1/chat/completions",
                model: "m",
                isBuiltin: false,
                customModels: []
            )
        )
        store.activeProviderID = "custom-x"
        XCTAssertTrue(KeychainStore.setAPIKey("sk-custom-x", for: "custom-x"))

        let cleared = store.resetToDefaults()

        XCTAssertEqual(store.targetLanguage, "简体中文")
        XCTAssertEqual(store.translationDirection, .autoChineseEnglish)
        XCTAssertEqual(store.ocrMode, .accurate)
        XCTAssertEqual(store.ocrLanguagePreset, .autoMixed)
        XCTAssertTrue(store.enableStreamingTranslation, "流式显示应回默认开")
        XCTAssertTrue(store.dictCardAuto, "词典卡片应回默认 auto")
        XCTAssertEqual(store.customPrompt, "")
        XCTAssertEqual(store.glossaryText, "")
        XCTAssertEqual(store.selectionHotKeyShortcut, .optionSpace)
        XCTAssertEqual(store.ocrHotKeyShortcut, .controlOptionSpace)
        XCTAssertEqual(store.readerHotKeyShortcut, .controlOptionR)
        XCTAssertEqual(store.activeProviderID, ProviderProfile.builtinPresets[0].id)
        XCTAssertEqual(store.providers, ProviderProfile.builtinPresets, "自定义 provider 应一并移除，回内置预设列表")
        XCTAssertEqual(store.editingAPIKey, "", "编辑态 Key 清空")
        XCTAssertNil(KeychainStore.apiKey(for: "custom-x"), "自定义 provider 密钥槽应被清空")
        XCTAssertNil(
            KeychainStore.apiKey(for: ProviderProfile.builtinPresets[0].id),
            "内置 provider 密钥槽同样清空"
        )
        XCTAssertTrue(cleared.contains("apiKey.custom-x"))
    }

    // MARK: - SET-5 保存条语义（脏检测 + 热键重注册闸门）

    func testSaveSnapshotDirtyDetectionAndHotKeyReregistrationGate() {
        let scope = DefaultsRestoreScope(keys: Self.settingsStoreKeys)
        defer { scope.restore() }

        _ = KeychainStore.deleteAllProviderAPIKeySlots()
        let store = SettingsStore()
        let snapshot = SettingsSaveSnapshot.capture(from: store)
        XCTAssertEqual(SettingsSaveSnapshot.capture(from: store), snapshot, "未改动时应与快照相等（非脏）")

        // 改一个非热键字段：脏，但不触发热键整组重注册。
        store.glossaryText = "hello = 你好"
        XCTAssertNotEqual(SettingsSaveSnapshot.capture(from: store), snapshot, "术语表改动应判定为脏")
        XCTAssertFalse(
            SettingsSaveSnapshot.capture(from: store).hotKeysDiffer(from: snapshot),
            "非热键改动不应触发热键重注册闸门"
        )

        // 再改热键：脏且闸门放行。
        store.readerHotKeyShortcut = .optionSpace
        let dirty = SettingsSaveSnapshot.capture(from: store)
        XCTAssertNotEqual(dirty, snapshot)
        XCTAssertTrue(dirty.hotKeysDiffer(from: snapshot), "热键改动应触发整组重注册")

        // 保存后重新捕获：回到非脏。
        let afterSave = SettingsSaveSnapshot.capture(from: store)
        XCTAssertFalse(afterSave.hotKeysDiffer(from: dirty))
    }

    // MARK: - SET-5 七分区 IA（对 Windows TABS 逐项对账）

    func testSettingsSectionsMatchWindowsIA() {
        XCTAssertEqual(
            SettingsSection.allCases.map(\.title),
            ["模型服务", "翻译", "语音", "术语表", "快捷键", "账号", "关于"],
            "七分区与 Windows Settings.tsx TABS 同名同序"
        )
        XCTAssertEqual(
            SettingsNavGroup.allCases.map(\.caption),
            ["翻译与工具", "账号与应用"],
            "侧栏分组标题对齐 Windows set-nav-caption"
        )
        XCTAssertEqual(
            SettingsNavGroup.tools.sections.map(\.title),
            ["模型服务", "翻译", "语音", "术语表", "快捷键"],
            "「翻译与工具」组含前五个分区"
        )
        XCTAssertEqual(
            SettingsNavGroup.app.sections.map(\.title),
            ["账号", "关于"],
            "「账号与应用」组含后两个分区"
        )
    }

    // MARK: - 夹具

    /// SettingsStore 会写入的 UserDefaults 键（含迁移用的旧 preset 键）。
    private static let settingsStoreKeys: [String] = [
        "providers",
        "activeProviderID",
        "targetLanguage",
        "translationDirection",
        "ocrMode",
        "ocrLanguagePreset",
        "enableStreamingTranslation",
        "dictCardAuto",
        "customPrompt",
        "glossaryText",
        "selectionHotKeyShortcut",
        "ocrHotKeyShortcut",
        "readerHotKeyShortcut",
        "selectionHotKeyPreset",
        "ocrHotKeyPreset"
    ]

    /// 记录进入用例前的取值，离开时原样恢复（nil = 删除），避免污染同进程其它用例。
    private struct DefaultsRestoreScope {
        private let entries: [(key: String, value: Any?)]

        init(keys: [String]) {
            entries = keys.map { ($0, UserDefaults.standard.object(forKey: $0)) }
        }

        func restore() {
            for entry in entries {
                if let value = entry.value {
                    UserDefaults.standard.set(value, forKey: entry.key)
                } else {
                    UserDefaults.standard.removeObject(forKey: entry.key)
                }
            }
        }
    }
}
