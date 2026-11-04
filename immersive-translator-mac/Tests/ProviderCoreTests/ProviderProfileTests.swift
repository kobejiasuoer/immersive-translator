import XCTest
@testable import ProviderCore

/// 内置预设对账（规格 docs/mac-ui-fix-specs-2026-11-02/settings.md §1.2 表逐字：
/// Windows v0.12 providerPresets.ts:52-143）。沉浸云平台预设 + 默认模型/候选/
/// displayName 对齐 + mark/hint/keyURL 供设置页双栏 IA 使用。
final class ProviderProfileTests: XCTestCase {
    func testBuiltinPresetsStayUniqueAndOfferTheirCurrentModel() {
        let presets = ProviderProfile.builtinPresets

        XCTAssertEqual(
            presets.map(\.id),
            ["deepseek", "zhipu", "openai", "dashscope", "moonshot", "gemini", "ollama", ProviderProfile.platformProviderID],
            "七家自带 Key 服务商 + 沉浸云平台预设，顺序稳定"
        )
        XCTAssertEqual(Set(presets.map(\.id)).count, presets.count)
        XCTAssertEqual(Set(presets.map(\.displayName)).count, presets.count)

        for preset in presets {
            XCTAssertTrue(preset.isBuiltin)
            XCTAssertTrue(preset.customModels.isEmpty)
            if preset.id == ProviderProfile.platformProviderID {
                // 沉浸云模型由服务端 /v1/me/config 下发，本地不设默认模型。
                XCTAssertTrue(preset.model.isEmpty, "沉浸云预设 model 应为空")
            } else {
                XCTAssertTrue(preset.modelCandidates.contains(preset.model))
            }
        }
    }

    func testImmersiveCloudPresetMatchesWindowsBaseline() {
        let preset = ProviderProfile.builtinPresets.first { $0.id == ProviderProfile.platformProviderID }

        XCTAssertEqual(ProviderProfile.platformProviderID, "immersive-cloud")
        let immutable = try? XCTUnwrap(preset)
        guard let preset = immutable else { return }
        XCTAssertEqual(preset.displayName, "沉浸云")
        XCTAssertEqual(preset.endpoint, "https://www.prismspace.online/v1/chat/completions")
        XCTAssertEqual(preset.model, "")
        XCTAssertTrue(preset.isBuiltin)
        XCTAssertEqual(preset.mark, "云")
        XCTAssertEqual(preset.hint, "登录即用，无需 API Key，按账号额度计费；模型与上游由服务端统一管理。")
        XCTAssertNil(preset.keyURL, "沉浸云免 Key，无取 Key 链接")
        XCTAssertTrue(preset.allowsEmptyAPIKey)
    }

    func testDefaultModelsAndCandidatesMatchWindowsBaseline() {
        // 默认模型（Windows providerPresets defaults）。
        XCTAssertEqual(Self.preset("deepseek")?.model, "deepseek-chat")
        XCTAssertEqual(Self.preset("zhipu")?.model, "glm-4-flash")
        XCTAssertEqual(Self.preset("openai")?.model, "gpt-4o-mini")
        XCTAssertEqual(Self.preset("dashscope")?.model, "qwen-plus")
        XCTAssertEqual(Self.preset("moonshot")?.model, "moonshot-v1-8k")
        XCTAssertEqual(Self.preset("gemini")?.model, "gemini-2.5-flash")
        XCTAssertEqual(Self.preset("ollama")?.model, "llama3.2")

        // 候选表（Windows models 数组），首候选 = 默认模型。
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["deepseek"], ["deepseek-chat", "deepseek-reasoner"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["zhipu"], ["glm-4-flash", "glm-4-plus", "glm-4-air"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["openai"], ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["dashscope"], ["qwen-plus", "qwen-turbo", "qwen-max"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["moonshot"], ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["gemini"], ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"])
        XCTAssertEqual(ProviderProfile.builtinModelCandidates["ollama"], ["llama3.2", "qwen3:8b", "deepseek-r1:8b"])
        XCTAssertNil(ProviderProfile.builtinModelCandidates[ProviderProfile.platformProviderID], "沉浸云无本地候选")

        for (id, candidates) in ProviderProfile.builtinModelCandidates {
            XCTAssertEqual(candidates.first, Self.preset(id)?.model, "\(id) 首候选应等于默认模型")
        }
    }

    func testDisplayNamesMarksHintsAndKeyURLsMatchWindowsBaseline() {
        // hint 逐字对照 Windows providerPresets.ts:52-143（含 Ollama 的代码反引号）。
        let expectations: [(id: String, displayName: String, mark: String?, keyURL: String?, hint: String)] = [
            ("deepseek", "DeepSeek", "D", "https://platform.deepseek.com/api_keys",
             "国内直连，性价比高。如遇推理模型噪声，会自动关闭思考模式。"),
            ("zhipu", "智谱 GLM", "智", "https://open.bigmodel.cn/usercenter/apikeys",
             "GLM-4-Flash 免费，国内直连速度快。会自动关闭思考模式。"),
            ("openai", "OpenAI", "O", "https://platform.openai.com/api-keys",
             "官方接口，国内直连不稳定，建议配置代理。"),
            ("dashscope", "通义千问", "通", "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
             "阿里云百炼，使用兼容模式路径。"),
            ("moonshot", "Kimi", "K", "https://platform.moonshot.cn/console/api-keys",
             "月之暗面 Kimi，长上下文，适合长文翻译。"),
            ("gemini", "Google Gemini", "G", "https://aistudio.google.com/app/apikey",
             "使用 OpenAI 兼容路径，国内需代理。"),
            ("ollama", "Ollama", "Ol", nil,
             "本机运行，数据不出机器。先 `ollama serve`，再 `ollama pull llama3.2`。"),
            ("immersive-cloud", "沉浸云", "云", nil,
             "登录即用，无需 API Key，按账号额度计费；模型与上游由服务端统一管理。"),
        ]
        for expectation in expectations {
            let preset = Self.preset(expectation.id)
            XCTAssertEqual(preset?.displayName, expectation.displayName, "\(expectation.id) displayName")
            XCTAssertEqual(preset?.mark, expectation.mark, "\(expectation.id) mark")
            XCTAssertEqual(preset?.keyURL, expectation.keyURL, "\(expectation.id) keyURL")
            XCTAssertEqual(preset?.hint, expectation.hint, "\(expectation.id) hint 逐字")
        }
        XCTAssertEqual(Self.preset("ollama")?.allowsEmptyAPIKey, true, "Ollama 本地接口免 Key")
    }

    func testNewMarkHintKeyURLFieldsRoundTripAndTolerateOldArchives() throws {
        // 旧存档（无 mark/hint/keyURL）解码不炸，三字段为 nil。
        let legacy = try JSONDecoder().decode(
            ProviderProfile.self,
            from: Data("""
            {"id":"deepseek","displayName":"DeepSeek","endpoint":"https://api.deepseek.com/chat/completions","model":"deepseek-chat","isBuiltin":true,"customModels":[]}
            """.utf8)
        )
        XCTAssertNil(legacy.mark)
        XCTAssertNil(legacy.hint)
        XCTAssertNil(legacy.keyURL)

        // 新字段编解码往返保持（出厂 deepseek 预设带全三字段）。
        let factory = ProviderProfile.builtinPresets[0]
        let roundTripped = try JSONDecoder().decode(
            ProviderProfile.self,
            from: JSONEncoder().encode(factory)
        )
        XCTAssertEqual(roundTripped, factory)
    }

    private static func preset(_ id: String) -> ProviderProfile? {
        ProviderProfile.builtinPresets.first { $0.id == id }
    }

    func testModelCandidatesTrimAndDeduplicateCustomHistory() {
        let profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-a",
            isBuiltin: false,
            customModels: [" model-a ", "model-b", "model-a", "", " model-c "]
        )

        XCTAssertEqual(profile.modelCandidates, ["model-a", "model-b", "model-c"])
    }

    func testModelCandidatesIncludeCurrentCustomModel() {
        let profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "current-model",
            isBuiltin: false,
            customModels: ["older-model"]
        )

        XCTAssertEqual(profile.modelCandidates, ["current-model", "older-model"])
    }

    func testAppendingCustomModelsKeepsTheEightMostRecentUniqueValues() {
        var profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-0",
            isBuiltin: false,
            customModels: []
        )

        for index in 0..<10 {
            profile.appendCustomModel(" model-\(index) ")
        }
        profile.appendCustomModel("model-9")

        XCTAssertEqual(profile.customModels, (2..<10).map { "model-\($0)" })
    }

    func testAppendingModelDoesNotDuplicateWhitespaceVariant() {
        var profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-a",
            isBuiltin: false,
            customModels: [" model-a "]
        )

        profile.appendCustomModel("model-a")

        XCTAssertEqual(profile.customModels, ["model-a"])
    }

    func testPersistedModelHistoryIsNormalizedAndCapped() throws {
        let profile = try JSONDecoder().decode(
            ProviderProfile.self,
            from: Data("""
            {
              "id": "custom",
              "displayName": "Custom",
              "endpoint": "https://example.com/v1",
              "model": "current",
              "isBuiltin": false,
              "customModels": [" old-0 ", "old-1", "old-1", "", " old-2 ", "old-3", "old-4", "old-5", "old-6", "old-7", "old-8"]
            }
            """.utf8)
        )

        XCTAssertEqual(profile.customModels, ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7", "old-8"])
    }
}
