import Foundation

public struct ProviderProfile: Identifiable, Codable, Equatable {
    public let id: String
    public var displayName: String
    public var endpoint: String
    public var model: String
    public var isBuiltin: Bool
    public var customModels: [String]
    /// 预设牌匾字（Windows providerPresets.ts mark：D/智/通/K/O/G/Ol/云）；
    /// nil 时 UI 回退取 displayName 首字符。
    public var mark: String?
    /// 预设副文案（Windows preset hint；选中服务商后右列 caption 逐字显示）。
    public var hint: String?
    /// 控制台取 Key 页（Windows preset keyUrl；nil = 免 Key 服务商，不渲染取 Key 链接）。
    public var keyURL: String?

    public init(
        id: String,
        displayName: String,
        endpoint: String,
        model: String,
        isBuiltin: Bool,
        customModels: [String],
        mark: String? = nil,
        hint: String? = nil,
        keyURL: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.endpoint = endpoint
        self.model = model
        self.isBuiltin = isBuiltin
        self.customModels = Self.normalizedCustomModels(customModels)
        self.mark = mark
        self.hint = hint
        self.keyURL = keyURL
    }

    private enum CodingKeys: String, CodingKey {
        case id, displayName, endpoint, model, isBuiltin, customModels, mark, hint, keyURL
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            displayName: try container.decode(String.self, forKey: .displayName),
            endpoint: try container.decode(String.self, forKey: .endpoint),
            model: try container.decode(String.self, forKey: .model),
            isBuiltin: try container.decode(Bool.self, forKey: .isBuiltin),
            customModels: try container.decodeIfPresent([String].self, forKey: .customModels) ?? [],
            // 新增三字段向后兼容：旧存档无值 → nil（decodeIfPresent 兼容显式 null）。
            mark: try container.decodeIfPresent(String.self, forKey: .mark),
            hint: try container.decodeIfPresent(String.self, forKey: .hint),
            keyURL: try container.decodeIfPresent(String.self, forKey: .keyURL)
        )
    }

    /// 沉浸云平台 provider id（Windows providerPresets.ts:40 PLATFORM_PROVIDER_ID）。
    public static let platformProviderID = "immersive-cloud"

    // 硬编码厂商官方模型,不进 UserDefaults。候选与默认模型对齐 Windows
    // v0.12 providerPresets.ts:52-143（规格 settings.md §1.2 表）。
    public static let builtinModelCandidates: [String: [String]] = [
        "deepseek":  ["deepseek-chat", "deepseek-reasoner"],
        "zhipu":     ["glm-4-flash", "glm-4-plus", "glm-4-air"],
        "openai":    ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
        "dashscope": ["qwen-plus", "qwen-turbo", "qwen-max"],
        "moonshot":  ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
        "gemini":    ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
        "ollama":    ["llama3.2", "qwen3:8b", "deepseek-r1:8b"],
        // 自定义 provider 无内置候选,customModels 是唯一来源
        // 沉浸云模型由服务端 /v1/me/config 下发,本地不设候选
    ]

    public static let builtinPresets: [ProviderProfile] = [
        ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "https://api.deepseek.com/chat/completions",
            model: "deepseek-chat",
            isBuiltin: true, customModels: [],
            mark: "D",
            hint: "国内直连，性价比高。如遇推理模型噪声，会自动关闭思考模式。",
            keyURL: "https://platform.deepseek.com/api_keys"
        ),
        ProviderProfile(
            id: "zhipu", displayName: "智谱 GLM",
            endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            model: "glm-4-flash",
            isBuiltin: true, customModels: [],
            mark: "智",
            hint: "GLM-4-Flash 免费，国内直连速度快。会自动关闭思考模式。",
            keyURL: "https://open.bigmodel.cn/usercenter/apikeys"
        ),
        ProviderProfile(
            id: "openai", displayName: "OpenAI",
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-4o-mini",
            isBuiltin: true, customModels: [],
            mark: "O",
            hint: "官方接口，国内直连不稳定，建议配置代理。",
            keyURL: "https://platform.openai.com/api-keys"
        ),
        ProviderProfile(
            id: "dashscope", displayName: "通义千问",
            endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            model: "qwen-plus",
            isBuiltin: true, customModels: [],
            mark: "通",
            hint: "阿里云百炼，使用兼容模式路径。",
            keyURL: "https://bailian.console.aliyun.com/?apiKey=1#/api-key"
        ),
        ProviderProfile(
            id: "moonshot", displayName: "Kimi",
            endpoint: "https://api.moonshot.cn/v1/chat/completions",
            model: "moonshot-v1-8k",
            isBuiltin: true, customModels: [],
            mark: "K",
            hint: "月之暗面 Kimi，长上下文，适合长文翻译。",
            keyURL: "https://platform.moonshot.cn/console/api-keys"
        ),
        ProviderProfile(
            id: "gemini", displayName: "Google Gemini",
            endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            model: "gemini-2.5-flash",
            isBuiltin: true, customModels: [],
            mark: "G",
            hint: "使用 OpenAI 兼容路径，国内需代理。",
            keyURL: "https://aistudio.google.com/app/apikey"
        ),
        ProviderProfile(
            id: "ollama", displayName: "Ollama",
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "llama3.2",
            isBuiltin: true, customModels: [],
            mark: "Ol",
            // 反引号是 Windows providerPresets.ts:131 逐字的一部分（代码样例标记），不能丢。
            hint: "本机运行，数据不出机器。先 `ollama serve`，再 `ollama pull llama3.2`。"
        ),
        // 沉浸云平台预设（Windows platformPreset 同构）：model 留空 = 服务端
        // /v1/me/config 下发；endpoint 为生产缺省值，运行时实际请求基址由
        // ServerAuthConfiguration.resolveBaseURL() 派生（见 TranslationClient），
        // 免 Key 语义由 TranslationClient.requiresAPIKey 的平台域名豁免承担。
        ProviderProfile(
            id: ProviderProfile.platformProviderID, displayName: "沉浸云",
            endpoint: "https://www.prismspace.online/v1/chat/completions",
            model: "",
            isBuiltin: true, customModels: [],
            mark: "云",
            hint: "登录即用，无需 API Key，按账号额度计费；模型与上游由服务端统一管理。"
        ),
    ]

    /// 免 API Key 的预设语义（Windows allowEmptyApiKey 对应物）：沉浸云走账号
    /// 令牌，Ollama 等本地接口本机可匿名。UI 的「本地」chip 与 keydot 展示用；
    /// 真正的发送前闸门仍以 TranslationClient.requiresAPIKey 为准。
    public var allowsEmptyAPIKey: Bool {
        id == Self.platformProviderID
            || endpoint.lowercased().contains("localhost")
            || endpoint.contains("127.0.0.1")
    }

    // UI 下拉展示用 = 内置候选 + 自定义历史(去重,内置在前,保持插入顺序)
    public var modelCandidates: [String] {
        let builtin = Self.builtinModelCandidates[id] ?? []
        var seen = Set<String>()
        var result: [String] = []
        // Include the currently selected model even when it came from a
        // migrated/custom configuration and is not in either history list.
        for m in [model] + builtin + customModels {
            let trimmed = m.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    // 用户自由填了模型名 → 追加到 customModels(去重:对比内置 + 已有;超 8 条淘汰最旧)
    public mutating func appendCustomModel(_ model: String) {
        customModels = Self.normalizedCustomModels(customModels)
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let builtin = Self.builtinModelCandidates[id] ?? []
        guard !builtin.contains(trimmed), !customModels.contains(trimmed) else { return }
        customModels.append(trimmed)
        customModels = Self.normalizedCustomModels(customModels)
    }

    private static func normalizedCustomModels(_ models: [String]) -> [String] {
        var normalized: [String] = []
        for model in models {
            let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if let existingIndex = normalized.firstIndex(of: trimmed) {
                normalized.remove(at: existingIndex)
            }
            normalized.append(trimmed)
        }
        if normalized.count > 8 {
            normalized = Array(normalized.suffix(8))
        }
        return normalized
    }
}
